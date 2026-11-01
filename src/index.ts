import { run, type RunnerHandle } from '@grammyjs/runner';
import { Notifier } from './alerts/notifier.js';
import { TokenIntelService } from './analytics/token.js';
import { TrendingService } from './analytics/trending.js';
import { WalletIntelService } from './analytics/wallet.js';
import { createBot } from './bot/bot.js';
import { COMMAND_LIST } from './bot/commands/index.js';
import { DexScreenerClient } from './clients/dexscreener.js';
import { GeckoTerminalClient } from './clients/geckoterminal.js';
import { HeliusClient } from './clients/helius.js';
import { SolanaRpcClient } from './clients/solanaRpc.js';
import { parseEnv, secretValues } from './config/env.js';
import { AlertsRepo } from './db/alertsRepo.js';
import { createDb } from './db/client.js';
import { MarketRepo } from './db/marketRepo.js';
import { UsersRepo } from './db/usersRepo.js';
import { WalletsRepo } from './db/walletsRepo.js';
import { HoldingsMonitor } from './jobs/holdingsMonitor.js';
import { MarketAlertJob } from './jobs/marketAlerts.js';
import { IntervalJob } from './jobs/scheduler.js';
import { SnapshotService } from './jobs/snapshots.js';
import { WalletActivityProcessor } from './jobs/walletActivity.js';
import { WalletPoller } from './jobs/walletPoller.js';
import { WhaleMonitor } from './jobs/whaleMonitor.js';
import type { AppServices } from './services/container.js';
import { PriceService } from './services/prices.js';
import { TokenMetadataService } from './services/tokenMetadata.js';
import { logger, registerSecrets, setLogLevel } from './utils/logger.js';
import { HeliusWebhookManager } from './webhooks/heliusWebhookManager.js';
import { HELIUS_WEBHOOK_PATH, HttpServer } from './webhooks/server.js';

async function main(): Promise<void> {
  const cfg = parseEnv(process.env);
  registerSecrets(secretValues(cfg));
  setLogLevel(cfg.LOG_LEVEL);
  logger.info('starting solana intelligence bot', { env: cfg.NODE_ENV, monitorMode: cfg.useWebhooks ? 'webhooks' : 'polling' });

  // ---- clients ----
  const rpc = new SolanaRpcClient(cfg.heliusRpcUrl, cfg.SOLANA_FALLBACK_RPC_URL, cfg.HTTP_TIMEOUT_MS);
  const helius = new HeliusClient(cfg.HELIUS_API_KEY, cfg.HELIUS_API_BASE, cfg.heliusRpcUrl, cfg.HTTP_TIMEOUT_MS);
  const dex = new DexScreenerClient(cfg.DEXSCREENER_BASE_URL, cfg.HTTP_TIMEOUT_MS);
  const gecko = new GeckoTerminalClient(cfg.GECKOTERMINAL_BASE_URL, cfg.HTTP_TIMEOUT_MS);

  // ---- database ----
  const db = createDb(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY);
  const users = new UsersRepo(db);
  const wallets = new WalletsRepo(db);
  const alerts = new AlertsRepo(db);
  const market = new MarketRepo(db);
  await wallets.distinctAddresses().catch((err) => {
    throw new Error(`Cannot reach Supabase or schema missing — did you run the migration? (${(err as Error).message})`);
  });

  // ---- services ----
  const prices = new PriceService(dex);
  const metadata = new TokenMetadataService(helius);
  const walletIntel = new WalletIntelService({ rpc, helius, prices, metadata, historyMaxPages: cfg.WALLET_HISTORY_MAX_PAGES });
  const tokenIntel = new TokenIntelService({ prices, metadata, rpc, gecko });
  const trending = new TrendingService(dex);
  const snapshots = new SnapshotService(wallets, walletIntel, prices);

  // The notifier sends through the bot, which is created once the service container exists.
  let bot: ReturnType<typeof createBot> | null = null;
  const notifier = new Notifier(
    {
      sendMessage: (chatId, text, opts) => {
        if (!bot) throw new Error('bot not initialised');
        return bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(opts as object) });
      },
    },
    alerts,
    users,
  );
  const processor = new WalletActivityProcessor(wallets, alerts, users, notifier, metadata);

  // ---- monitoring ----
  const webhookUrl = cfg.PUBLIC_WEBHOOK_URL ? `${cfg.PUBLIC_WEBHOOK_URL.replace(/\/$/, '')}${HELIUS_WEBHOOK_PATH}` : null;
  const webhookManager =
    cfg.useWebhooks && webhookUrl && cfg.HELIUS_WEBHOOK_SECRET
      ? new HeliusWebhookManager(helius, wallets, webhookUrl, cfg.HELIUS_WEBHOOK_SECRET, cfg.HELIUS_WEBHOOK_ID)
      : null;
  const server = new HttpServer({
    port: cfg.HTTP_PORT,
    webhookSecret: cfg.useWebhooks ? cfg.HELIUS_WEBHOOK_SECRET : undefined,
    processor,
    monitoredAddresses: () => wallets.distinctAddresses(),
  });

  const app: AppServices = {
    config: cfg,
    rpc,
    helius,
    dex,
    gecko,
    prices,
    metadata,
    walletIntel,
    tokenIntel,
    trending,
    users,
    wallets,
    alerts,
    market,
    snapshots,
    notifier,
    onWalletsChanged: () => {
      server.invalidateMonitored();
      webhookManager?.requestSync();
    },
  };

  bot = createBot({ token: cfg.TELEGRAM_BOT_TOKEN, userRateLimitPerMin: cfg.USER_RATE_LIMIT_PER_MIN, app });
  const telegram = bot;

  const poller = new WalletPoller(rpc, helius, wallets, processor);
  const holdings = new HoldingsMonitor(wallets, users, walletIntel, prices, notifier);
  const marketJob = new MarketAlertJob(dex, alerts, wallets, market, notifier);
  const whales = new WhaleMonitor(helius, prices, alerts, market, notifier);

  const jobs = [
    // With webhooks, polling becomes a slow reconciliation pass (dedupe prevents double notifications).
    new IntervalJob('wallet-poller', (cfg.useWebhooks ? cfg.WALLET_POLL_INTERVAL_SEC * 5 : cfg.WALLET_POLL_INTERVAL_SEC) * 1000, () => poller.runOnce()),
    new IntervalJob('holdings-monitor', cfg.HOLDINGS_CHECK_INTERVAL_MIN * 60_000, () => holdings.runOnce()),
    new IntervalJob('market-alerts', cfg.MARKET_ALERT_INTERVAL_SEC * 1000, () => marketJob.runOnce()),
    new IntervalJob('whale-monitor', cfg.WHALE_POLL_INTERVAL_SEC * 1000, () => whales.runOnce()),
    new IntervalJob('portfolio-snapshots', cfg.SNAPSHOT_INTERVAL_MIN * 60_000, () => snapshots.runOnce(), 60_000),
    new IntervalJob('maintenance', 24 * 3600_000, () => market.prune(90), 5 * 60_000),
  ];

  await server.start();
  if (webhookManager) await webhookManager.sync();
  await telegram.init();
  await telegram.api.setMyCommands(COMMAND_LIST).catch((err) => logger.warn('setMyCommands failed', { error: err as Error }));
  jobs.forEach((j) => j.start());
  const runner: RunnerHandle = run(telegram, { runner: { fetch: { allowed_updates: ['message', 'callback_query'] } } });
  logger.info('bot is running', { username: telegram.botInfo.username });

  // ---- graceful shutdown ----
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    const force = setTimeout(() => {
      logger.error('forced exit after timeout');
      process.exit(1);
    }, 25_000);
    force.unref();
    try {
      if (runner.isRunning()) await runner.stop();
      webhookManager?.stop();
      await Promise.all(jobs.map((j) => j.stop()));
      await server.stop();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('error during shutdown', { error: err as Error });
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { error: reason as Error }));
}

main().catch((err) => {
  logger.error('fatal startup error', { error: err as Error });
  process.exit(1);
});
