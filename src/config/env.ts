import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration. Validated once at startup with Zod so that the
 * process fails fast with a readable message instead of failing later inside
 * an API call. Secrets are never printed: validation errors only list the
 * variable names that are missing or malformed.
 */

const intFromEnv = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const optionalString = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional();

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    TELEGRAM_BOT_TOKEN: z
      .string()
      .regex(/^\d{5,}:[A-Za-z0-9_-]{30,}$/, 'must look like 123456:ABC... (from BotFather)'),

    HELIUS_API_KEY: z.string().min(10, 'is required (free key at dashboard.helius.dev)'),
    HELIUS_API_BASE: z.url().default('https://mainnet.helius-rpc.com'),
    /** Optional override; defaults to the Helius mainnet RPC with your key. */
    HELIUS_RPC_URL: optionalString.pipe(z.url().optional()),
    /** Secondary RPC used when Helius RPC fails (public endpoint, heavily rate limited). */
    SOLANA_FALLBACK_RPC_URL: z.url().default('https://api.mainnet-beta.solana.com'),

    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, 'is required (Project Settings → API)'),

    DEXSCREENER_BASE_URL: z.url().default('https://api.dexscreener.com'),
    GECKOTERMINAL_BASE_URL: z.url().default('https://api.geckoterminal.com/api/v2'),

    /** auto = use Helius webhooks when PUBLIC_WEBHOOK_URL is set, otherwise poll. */
    WALLET_MONITOR_MODE: z.enum(['auto', 'webhook', 'polling']).default('auto'),
    PUBLIC_WEBHOOK_URL: optionalString.pipe(z.url().optional()),
    HELIUS_WEBHOOK_SECRET: optionalString.pipe(z.string().min(16).optional()),
    HELIUS_WEBHOOK_ID: optionalString,
    HTTP_PORT: intFromEnv(8080, 1, 65535),

    WALLET_POLL_INTERVAL_SEC: intFromEnv(120, 20, 3600),
    MARKET_ALERT_INTERVAL_SEC: intFromEnv(120, 30, 3600),
    WHALE_POLL_INTERVAL_SEC: intFromEnv(600, 60, 3600),
    HOLDINGS_CHECK_INTERVAL_MIN: intFromEnv(30, 5, 1440),
    SNAPSHOT_INTERVAL_MIN: intFromEnv(360, 15, 10080),

    USER_RATE_LIMIT_PER_MIN: intFromEnv(20, 1, 600),
    HTTP_TIMEOUT_MS: intFromEnv(15000, 1000, 120000),
    /** Max pages (1000 signatures each) scanned to determine wallet age / tx count. */
    WALLET_HISTORY_MAX_PAGES: intFromEnv(5, 1, 50),
    MAX_TRACKED_WALLETS_PER_USER: intFromEnv(25, 1, 1000),
    MAX_ALERTS_PER_USER: intFromEnv(50, 1, 1000),
  })
  .superRefine((env, ctx) => {
    for (const key of ['TELEGRAM_BOT_TOKEN', 'HELIUS_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'] as const) {
      if (/replace-with|your-project-ref/.test(env[key])) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'still contains the placeholder from .env.example' });
      }
    }
    if (env.WALLET_MONITOR_MODE === 'webhook' && !env.PUBLIC_WEBHOOK_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['PUBLIC_WEBHOOK_URL'],
        message: 'is required when WALLET_MONITOR_MODE=webhook',
      });
    }
    if (env.PUBLIC_WEBHOOK_URL && !env.HELIUS_WEBHOOK_SECRET && env.WALLET_MONITOR_MODE !== 'polling') {
      ctx.addIssue({
        code: 'custom',
        path: ['HELIUS_WEBHOOK_SECRET'],
        message: 'is required (min 16 chars) when webhooks are enabled',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export interface AppConfig extends Env {
  heliusRpcUrl: string;
  useWebhooks: boolean;
}

export function parseEnv(source: Record<string, string | undefined>): AppConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}\nSee .env.example.`);
  }
  const env = result.data;
  return {
    ...env,
    heliusRpcUrl: env.HELIUS_RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}`,
    useWebhooks:
      env.WALLET_MONITOR_MODE === 'webhook' ||
      (env.WALLET_MONITOR_MODE === 'auto' && Boolean(env.PUBLIC_WEBHOOK_URL && env.HELIUS_WEBHOOK_SECRET)),
  };
}

/** Values that must never appear in logs or Telegram messages. */
export function secretValues(cfg: AppConfig): string[] {
  return [cfg.TELEGRAM_BOT_TOKEN, cfg.HELIUS_API_KEY, cfg.SUPABASE_SERVICE_ROLE_KEY, cfg.HELIUS_WEBHOOK_SECRET].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
}
