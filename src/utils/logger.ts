/**
 * Minimal structured JSON logger with secret redaction.
 *
 * Every string that is logged (message and nested metadata) is passed through
 * `redact`, which removes registered secret values and common credential
 * patterns (api-key query params, bearer tokens, Telegram bot tokens, JWTs).
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const registeredSecrets = new Set<string>();
let minLevel: Level = 'info';
let sink: (line: string, level: Level) => void = (line, level) => {
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
};

const PATTERNS: Array<[RegExp, string]> = [
  [/(api[-_]?key=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1[REDACTED]'],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_BOT_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
];

export function registerSecrets(values: string[]): void {
  for (const v of values) if (v && v.length >= 6) registeredSecrets.add(v);
}

export function setLogLevel(level: Level): void {
  minLevel = level;
}

/** For tests: capture output instead of writing to stdio. */
export function setLogSink(fn: (line: string, level: Level) => void): void {
  sink = fn;
}

export function redact(input: string): string {
  let out = input;
  for (const secret of registeredSecrets) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[depth]';
  if (typeof value === 'string') return redact(value);
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message), stack: value.stack ? redact(value.stack) : undefined };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = /key|token|secret|password|authorization/i.test(k) && typeof v === 'string' ? '[REDACTED]' : sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(level: Level, scope: string, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const entry = { t: new Date().toISOString(), level, scope, msg: redact(msg), ...(meta ? (sanitize(meta) as object) : {}) };
  sink(JSON.stringify(entry), level);
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => write('debug', scope, m, meta),
    info: (m, meta) => write('info', scope, m, meta),
    warn: (m, meta) => write('warn', scope, m, meta),
    error: (m, meta) => write('error', scope, m, meta),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}

export const logger = createLogger('app');
