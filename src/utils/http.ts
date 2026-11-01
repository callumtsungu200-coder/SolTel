import { ApiError, RateLimitError, TimeoutError } from './errors.js';
import { createLogger, redact } from './logger.js';
import type { TokenBucket } from './rateLimiter.js';

const log = createLogger('http');

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  service: string;
  timeoutMs: number;
  /** Retries for retryable failures (429, 5xx, timeouts, network). */
  maxRetries?: number;
  baseDelayMs?: number;
  bucket?: TokenBucket;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
  /** Treat 404 as `null` instead of throwing. */
  allow404?: boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * JSON HTTP client with timeout, retry with exponential backoff + jitter,
 * Retry-After support and an optional outbound token bucket.
 * URLs are redacted before logging so API keys in query strings never leak.
 */
export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HttpClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get service(): string {
    return this.opts.service;
  }

  async request<T>(url: string, ro: RequestOptions = {}): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 3;
    const base = this.opts.baseDelayMs ?? 500;
    let attempt = 0;
    for (;;) {
      try {
        return await this.once<T>(url, ro);
      } catch (err) {
        const retryable = err instanceof ApiError && err.retryable;
        if (!retryable || attempt >= maxRetries) throw err;
        const hinted = err instanceof RateLimitError ? err.retryAfterMs : undefined;
        const delay = Math.min(30_000, hinted ?? base * 2 ** attempt + Math.floor(Math.random() * base));
        log.warn('retrying request', { service: this.opts.service, attempt: attempt + 1, delay, error: (err as Error).message });
        await this.sleep(delay);
        attempt++;
      }
    }
  }

  private async once<T>(url: string, ro: RequestOptions): Promise<T> {
    if (this.opts.bucket) await this.opts.bucket.take();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: ro.method ?? (ro.body !== undefined ? 'POST' : 'GET'),
        headers: {
          accept: 'application/json',
          ...(ro.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...ro.headers,
        },
        body: ro.body !== undefined ? JSON.stringify(ro.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new TimeoutError(this.opts.service, this.opts.timeoutMs);
      throw new ApiError(`${this.opts.service} network error: ${redact((err as Error).message)}`, this.opts.service, undefined, true);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429) {
      throw new RateLimitError(this.opts.service, parseRetryAfter(res.headers.get('retry-after')));
    }
    if (res.status === 404 && ro.allow404) return null as T;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.warn('http error', { service: this.opts.service, status: res.status, url: redact(url), body: text.slice(0, 300) });
      throw new ApiError(`${this.opts.service} returned HTTP ${res.status}`, this.opts.service, res.status, res.status >= 500);
    }
    const text = await res.text();
    if (text.length === 0) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(`${this.opts.service} returned invalid JSON`, this.opts.service, res.status, false);
    }
  }
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
