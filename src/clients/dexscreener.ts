import { z } from 'zod';
import { HttpClient, type FetchLike } from '../utils/http.js';
import { TokenBucket } from '../utils/rateLimiter.js';

/*
 * DexScreener public API (no key). Documented limits:
 *  - pair/token/search endpoints: 300 requests/minute
 *  - token-profiles / token-boosts endpoints: 60 requests/minute
 * https://docs.dexscreener.com/api/reference
 */

const num = z.number().nullable().optional();
const windows = z.object({ m5: num, h1: num, h6: num, h24: num }).loose();
const txnWindow = z.object({ buys: z.number().optional(), sells: z.number().optional() }).loose();

export const dexPairSchema = z
  .object({
    chainId: z.string(),
    dexId: z.string(),
    url: z.string().optional(),
    pairAddress: z.string(),
    labels: z.array(z.string()).optional(),
    baseToken: z.object({ address: z.string(), name: z.string().optional().default(''), symbol: z.string().optional().default('') }),
    quoteToken: z.object({ address: z.string(), name: z.string().optional().default(''), symbol: z.string().optional().default('') }),
    priceNative: z.string().optional(),
    priceUsd: z.string().nullable().optional(),
    txns: z.object({ m5: txnWindow.optional(), h1: txnWindow.optional(), h6: txnWindow.optional(), h24: txnWindow.optional() }).loose().optional(),
    volume: windows.optional(),
    priceChange: windows.optional(),
    liquidity: z.object({ usd: num, base: num, quote: num }).loose().nullable().optional(),
    fdv: num,
    marketCap: num,
    pairCreatedAt: num,
    info: z
      .object({
        imageUrl: z.string().optional(),
        websites: z.array(z.object({ url: z.string(), label: z.string().optional() }).loose()).optional(),
        socials: z.array(z.object({ url: z.string(), type: z.string().optional() }).loose()).optional(),
      })
      .loose()
      .optional(),
    boosts: z.object({ active: z.number().optional() }).loose().optional(),
  })
  .loose();
export type DexPair = z.infer<typeof dexPairSchema>;

const tokenListingSchema = z
  .object({
    chainId: z.string(),
    tokenAddress: z.string(),
    url: z.string().optional(),
    description: z.string().nullable().optional(),
    totalAmount: z.number().optional(),
    amount: z.number().optional(),
  })
  .loose();
export type DexTokenListing = z.infer<typeof tokenListingSchema>;

function parseArray<T>(schema: z.ZodType<T>, raw: unknown): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const item of raw) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

export class DexScreenerClient {
  private readonly pairsHttp: HttpClient;
  private readonly listingsHttp: HttpClient;

  constructor(
    private readonly baseUrl: string,
    timeoutMs: number,
    fetchImpl?: FetchLike,
  ) {
    this.pairsHttp = new HttpClient({ service: 'DexScreener', timeoutMs, bucket: new TokenBucket(10, 4.5), fetchImpl });
    this.listingsHttp = new HttpClient({ service: 'DexScreener', timeoutMs, bucket: new TokenBucket(5, 0.9), fetchImpl });
  }

  private u(path: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}${path}`;
  }

  /**
   * Main pair (DexScreener's primary pool) for up to 30 token mints per
   * request, batched automatically. Use `getTokenPools` for every pool.
   */
  async getPairsForTokens(mints: string[]): Promise<DexPair[]> {
    const unique = [...new Set(mints)];
    const out: DexPair[] = [];
    for (let i = 0; i < unique.length; i += 30) {
      const chunk = unique.slice(i, i + 30);
      const raw = await this.pairsHttp.request<unknown>(this.u(`/tokens/v1/solana/${chunk.join(',')}`));
      out.push(...parseArray(dexPairSchema, raw).filter((p) => p.chainId === 'solana'));
    }
    return out;
  }

  /** Pools for a single token (includes pools where the token is the quote side). */
  async getTokenPools(mint: string): Promise<DexPair[]> {
    const raw = await this.pairsHttp.request<unknown>(this.u(`/token-pairs/v1/solana/${mint}`));
    return parseArray(dexPairSchema, raw).filter((p) => p.chainId === 'solana');
  }

  async search(query: string): Promise<DexPair[]> {
    const raw = await this.pairsHttp.request<{ pairs?: unknown }>(this.u(`/latest/dex/search?q=${encodeURIComponent(query)}`));
    return parseArray(dexPairSchema, raw?.pairs).filter((p) => p.chainId === 'solana');
  }

  async getTopBoostedTokens(): Promise<DexTokenListing[]> {
    const raw = await this.listingsHttp.request<unknown>(this.u('/token-boosts/top/v1'));
    return parseArray(tokenListingSchema, raw).filter((t) => t.chainId === 'solana');
  }

  async getLatestBoostedTokens(): Promise<DexTokenListing[]> {
    const raw = await this.listingsHttp.request<unknown>(this.u('/token-boosts/latest/v1'));
    return parseArray(tokenListingSchema, raw).filter((t) => t.chainId === 'solana');
  }

  async getLatestProfiles(): Promise<DexTokenListing[]> {
    const raw = await this.listingsHttp.request<unknown>(this.u('/token-profiles/latest/v1'));
    return parseArray(tokenListingSchema, raw).filter((t) => t.chainId === 'solana');
  }
}
