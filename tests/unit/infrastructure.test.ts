import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEnv, secretValues } from '../../src/config/env.js';
import { TtlCache } from '../../src/utils/cache.js';
import { ApiError, RateLimitError, TimeoutError, userFacingError, UserInputError } from '../../src/utils/errors.js';
import { HttpClient, parseRetryAfter } from '../../src/utils/http.js';
import { createLogger, redact, registerSecrets, setLogSink } from '../../src/utils/logger.js';
import { KeyedRateLimiter, TokenBucket } from '../../src/utils/rateLimiter.js';
import { jsonResponse } from '../fixtures/index.js';

const noSleep = () => Promise.resolve();

describe('HttpClient', () => {
  it('retries 429 honouring Retry-After, then succeeds', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ e: 1 }, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const http = new HttpClient({ service: 'X', timeoutMs: 1000, fetchImpl, sleep: async (ms) => void sleeps.push(ms) });
    await expect(http.request('https://x.test/a')).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([2000]);
  });

  it('retries 5xx with backoff and gives up after maxRetries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('oops', 503));
    const http = new HttpClient({ service: 'X', timeoutMs: 1000, maxRetries: 2, fetchImpl, sleep: noSleep });
    await expect(http.request('https://x.test')).rejects.toMatchObject({ status: 503, retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('bad', 400));
    const http = new HttpClient({ service: 'X', timeoutMs: 1000, fetchImpl, sleep: noSleep });
    await expect(http.request('https://x.test')).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps 404 to null when allowed', async () => {
    const http = new HttpClient({ service: 'X', timeoutMs: 1000, fetchImpl: async () => jsonResponse('nf', 404), sleep: noSleep });
    await expect(http.request('https://x.test', { allow404: true })).resolves.toBeNull();
  });

  it('times out slow responses with a TimeoutError', async () => {
    const fetchImpl = (_: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const http = new HttpClient({ service: 'Slow', timeoutMs: 20, maxRetries: 0, fetchImpl, sleep: noSleep });
    await expect(http.request('https://x.test')).rejects.toBeInstanceOf(TimeoutError);
  });

  it('rejects invalid JSON', async () => {
    const http = new HttpClient({ service: 'X', timeoutMs: 1000, fetchImpl: async () => new Response('<html>', { status: 200 }), sleep: noSleep });
    await expect(http.request('https://x.test')).rejects.toThrow(/invalid JSON/);
  });

  it('sends JSON bodies as POST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    const http = new HttpClient({ service: 'X', timeoutMs: 1000, fetchImpl, sleep: noSleep });
    await http.request('https://x.test', { body: { a: 1 } });
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
  });

  it('parses Retry-After formats', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('garbage')).toBeUndefined();
  });
});

describe('logger redaction', () => {
  afterEach(() => setLogSink((line) => process.stdout.write(line + '\n')));

  it('removes API keys, bot tokens, JWTs and registered secrets', () => {
    registerSecrets(['super-secret-value-123']);
    expect(redact('https://mainnet.helius-rpc.com/?api-key=abc123&x=1')).toBe('https://mainnet.helius-rpc.com/?api-key=[REDACTED]&x=1');
    expect(redact('token 1234567890:AAH-abcdefghijklmnopqrstuvwxyz012345 here')).toContain('[REDACTED_BOT_TOKEN]');
    expect(redact('Bearer eyJhbGciOi.payloadpayload.sigsigsig')).toBe('Bearer [REDACTED]');
    expect(redact('value=super-secret-value-123')).toBe('value=[REDACTED]');
  });

  it('redacts metadata fields by key name and nested strings', () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    createLogger('t').error('failed calling https://x/?api-key=zzz', { apiKey: 'plain', nested: { url: 'https://y/?api-key=yyy' }, error: new Error('api-key=qqq') });
    const out = lines.join('\n');
    expect(out).not.toContain('zzz');
    expect(out).not.toContain('plain');
    expect(out).not.toContain('yyy');
    expect(out).not.toContain('qqq');
  });
});

describe('rate limiting and caching', () => {
  it('token bucket enforces capacity and refills over time', () => {
    let now = 0;
    const b = new TokenBucket(2, 1, () => now);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    expect(b.waitTimeMs()).toBe(1000);
    now += 1000;
    expect(b.tryTake()).toBe(true);
  });

  it('keyed limiter isolates users', () => {
    const l = new KeyedRateLimiter(1, 0.01, () => 0);
    expect(l.tryTake('a')).toBe(true);
    expect(l.tryTake('a')).toBe(false);
    expect(l.tryTake('b')).toBe(true);
  });

  it('async take() queues until tokens are available', async () => {
    const b = new TokenBucket(1, 50);
    const t = Date.now();
    await b.take();
    await b.take();
    expect(Date.now() - t).toBeGreaterThanOrEqual(10);
  });

  it('cache coalesces concurrent loads and expires entries', async () => {
    let now = 0;
    const c = new TtlCache<number>(100, 10, () => now);
    const loader = vi.fn().mockResolvedValue(42);
    const [a, b] = await Promise.all([c.getOrLoad('k', loader), c.getOrLoad('k', loader)]);
    expect([a, b]).toEqual([42, 42]);
    expect(loader).toHaveBeenCalledTimes(1);
    now = 200;
    expect(c.get('k')).toBeUndefined();
  });
});

describe('environment validation', () => {
  const base = {
    TELEGRAM_BOT_TOKEN: '123456789:AAHabcdefghijklmnopqrstuvwxyz012345',
    HELIUS_API_KEY: 'helius-test-key-123',
    SUPABASE_URL: 'https://abc.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests-0000',
  };

  it('applies defaults and derives the Helius RPC URL', () => {
    const cfg = parseEnv(base);
    expect(cfg.WALLET_POLL_INTERVAL_SEC).toBe(120);
    expect(cfg.heliusRpcUrl).toBe('https://mainnet.helius-rpc.com/?api-key=helius-test-key-123');
    expect(cfg.useWebhooks).toBe(false);
    expect(secretValues(cfg)).toContain('helius-test-key-123');
  });

  it('lists missing variables without printing secret values', () => {
    try {
      parseEnv({ ...base, TELEGRAM_BOT_TOKEN: 'nope', SUPABASE_URL: '' });
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('TELEGRAM_BOT_TOKEN');
      expect(msg).toContain('SUPABASE_URL');
      expect(msg).not.toContain('service-role-key-for-tests');
    }
  });

  it('rejects unchanged .env.example placeholders', () => {
    const example = parse(readFileSync(join(process.cwd(), '.env.example')));
    expect(() => parseEnv(example)).toThrow(/placeholder/);
    // …but the rest of the example file is valid once real credentials are filled in.
    expect(parseEnv({ ...example, ...base }).WALLET_POLL_INTERVAL_SEC).toBe(120);
  });

  it('enables webhooks only with URL + secret', () => {
    expect(parseEnv({ ...base, PUBLIC_WEBHOOK_URL: 'https://bot.example.com', HELIUS_WEBHOOK_SECRET: 'a-long-secret-value-1' }).useWebhooks).toBe(true);
    expect(() => parseEnv({ ...base, PUBLIC_WEBHOOK_URL: 'https://bot.example.com' })).toThrow(/HELIUS_WEBHOOK_SECRET/);
    expect(() => parseEnv({ ...base, WALLET_MONITOR_MODE: 'webhook' })).toThrow(/PUBLIC_WEBHOOK_URL/);
    expect(parseEnv({ ...base, WALLET_MONITOR_MODE: 'polling', PUBLIC_WEBHOOK_URL: 'https://bot.example.com' }).useWebhooks).toBe(false);
  });
});

describe('user-facing errors', () => {
  it('never leak internals', () => {
    expect(userFacingError(new UserInputError('Bad address'))).toBe('Bad address');
    expect(userFacingError(new RateLimitError('Helius'))).toMatch(/Helius is rate limiting/);
    expect(userFacingError(new Error('https://x/?api-key=secret'))).not.toContain('secret');
  });
});
