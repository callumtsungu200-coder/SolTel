import { z } from 'zod';
import { HttpClient, type FetchLike } from '../utils/http.js';
import { TokenBucket } from '../utils/rateLimiter.js';

/*
 * GeckoTerminal public API (no key, ~30 calls/minute).
 * Used for historical OHLCV candles, which DexScreener's public API does not
 * provide. https://www.geckoterminal.com/dex-api
 */

export interface Candle {
  /** Candle open time, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Volume in USD. */
  v: number;
}

const ohlcvSchema = z.object({
  data: z.object({
    attributes: z.object({ ohlcv_list: z.array(z.array(z.union([z.number(), z.string()]))) }),
  }),
});

export type Timeframe = 'day' | 'hour' | 'minute';

export class GeckoTerminalClient {
  private readonly http: HttpClient;

  constructor(
    private readonly baseUrl: string,
    timeoutMs: number,
    fetchImpl?: FetchLike,
  ) {
    this.http = new HttpClient({ service: 'GeckoTerminal', timeoutMs, bucket: new TokenBucket(3, 0.4), fetchImpl, maxRetries: 2 });
  }

  /** Candles for a pool, oldest first. Returns [] when the pool is unknown to GeckoTerminal. */
  async getOhlcv(poolAddress: string, timeframe: Timeframe = 'day', limit = 30, aggregate = 1): Promise<Candle[]> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/networks/solana/pools/${poolAddress}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd`;
    const raw = await this.http.request<unknown>(url, { allow404: true, headers: { accept: 'application/json;version=20230203' } });
    if (!raw) return [];
    const parsed = ohlcvSchema.safeParse(raw);
    if (!parsed.success) return [];
    return parseCandles(parsed.data.data.attributes.ohlcv_list);
  }
}

export function parseCandles(list: Array<Array<number | string>>): Candle[] {
  const out: Candle[] = [];
  for (const row of list) {
    if (row.length < 6) continue;
    const [t, o, h, l, c, v] = row.map(Number) as [number, number, number, number, number, number];
    if (![t, o, h, l, c].every(Number.isFinite)) continue;
    out.push({ t, o, h, l, c, v: Number.isFinite(v) ? v : 0 });
  }
  return out.sort((a, b) => a.t - b.t);
}
