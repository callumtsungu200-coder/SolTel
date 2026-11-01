import type { DexPair, DexScreenerClient } from '../clients/dexscreener.js';
import { liquidityOf } from '../services/prices.js';
import { TtlCache } from '../utils/cache.js';
import { createLogger } from '../utils/logger.js';
import { USDC_MINT, USDT_MINT, WSOL_MINT } from '../validation/address.js';

const log = createLogger('trending');

/**
 * Trending token explorer.
 *
 * DexScreener's public API has no "all Solana tokens ranked by volume"
 * endpoint, so the candidate universe is assembled from documented
 * endpoints: top boosts, latest boosts, latest token profiles and a
 * pair search. Boosts are PAID promotions on DexScreener, which is
 * disclosed to users. Candidates are then enriched with live pair data and
 * filtered/sorted locally. Being listed here is never a recommendation.
 */

export type TrendingSort = 'volume' | 'liquidity' | 'gainers' | 'losers' | 'marketCap' | 'txns' | 'change1h';

export interface TrendingToken {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number | null;
  liquidityUsd: number;
  volume24h: number;
  volume1h: number;
  change1h: number | null;
  change24h: number | null;
  marketCap: number | null;
  fdv: number | null;
  txns24h: number;
  pairCount: number;
  pairAgeHours: number | null;
  sources: string[];
  boosted: boolean;
  warnings: string[];
}

export interface TrendingFilters {
  minLiquidityUsd: number;
  minVolumeUsd: number;
  sort: TrendingSort;
}

const EXCLUDED = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

export function aggregateTokens(pairs: DexPair[], sourcesByMint: Map<string, Set<string>>, now = Date.now()): TrendingToken[] {
  const byMint = new Map<string, DexPair[]>();
  for (const p of pairs) {
    const mint = p.baseToken.address;
    if (EXCLUDED.has(mint) || !sourcesByMint.has(mint)) continue;
    const list = byMint.get(mint) ?? [];
    list.push(p);
    byMint.set(mint, list);
  }
  const out: TrendingToken[] = [];
  for (const [mint, list] of byMint) {
    list.sort((a, b) => liquidityOf(b) - liquidityOf(a));
    const best = list[0]!;
    const sources = [...(sourcesByMint.get(mint) ?? [])];
    const liquidityUsd = list.reduce((s, p) => s + liquidityOf(p), 0);
    const volume24h = list.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0);
    const createdTimes = list.map((p) => p.pairCreatedAt).filter((t): t is number => typeof t === 'number');
    const oldest = createdTimes.length ? Math.min(...createdTimes) : null;
    const t: TrendingToken = {
      mint,
      symbol: best.baseToken.symbol || '?',
      name: best.baseToken.name || '',
      priceUsd: best.priceUsd ? Number(best.priceUsd) : null,
      liquidityUsd,
      volume24h,
      volume1h: list.reduce((s, p) => s + (p.volume?.h1 ?? 0), 0),
      change1h: best.priceChange?.h1 ?? null,
      change24h: best.priceChange?.h24 ?? null,
      marketCap: best.marketCap ?? null,
      fdv: best.fdv ?? null,
      txns24h: list.reduce((s, p) => s + (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0), 0),
      pairCount: list.length,
      pairAgeHours: oldest ? (now - oldest) / 3600_000 : null,
      sources,
      boosted: sources.some((s) => s.startsWith('boost')),
      warnings: [],
    };
    t.warnings = tokenWarnings(t);
    out.push(t);
  }
  return out;
}

export function tokenWarnings(t: TrendingToken): string[] {
  const w: string[] = [];
  if (t.marketCap === null && t.fdv === null) w.push('no market cap data');
  if (t.liquidityUsd < 25_000) w.push('low liquidity');
  if (t.pairAgeHours !== null && t.pairAgeHours < 24) w.push('pair < 24h old');
  if (t.liquidityUsd > 0 && t.volume24h / t.liquidityUsd > 50) w.push('volume ≫ liquidity');
  if (t.change24h !== null && Math.abs(t.change24h) > 80) w.push('extreme price move');
  if (t.boosted) w.push('paid boost on DexScreener');
  return w;
}

export function filterAndSort(tokens: TrendingToken[], f: TrendingFilters): TrendingToken[] {
  const filtered = tokens.filter((t) => t.liquidityUsd >= f.minLiquidityUsd && t.volume24h >= f.minVolumeUsd);
  const key: Record<TrendingSort, (t: TrendingToken) => number> = {
    volume: (t) => t.volume24h,
    liquidity: (t) => t.liquidityUsd,
    gainers: (t) => t.change24h ?? -Infinity,
    losers: (t) => -(t.change24h ?? Infinity),
    marketCap: (t) => t.marketCap ?? t.fdv ?? -Infinity,
    txns: (t) => t.txns24h,
    change1h: (t) => t.change1h ?? -Infinity,
  };
  const k = key[f.sort];
  return filtered.sort((a, b) => k(b) - k(a));
}

export class TrendingService {
  private readonly cache = new TtlCache<TrendingToken[]>(120_000, 4);

  constructor(private readonly dex: DexScreenerClient) {}

  async getUniverse(): Promise<TrendingToken[]> {
    return this.cache.getOrLoad('universe', async () => {
      const sourcesByMint = new Map<string, Set<string>>();
      const add = (mint: string, source: string) => {
        const s = sourcesByMint.get(mint) ?? new Set<string>();
        s.add(source);
        sourcesByMint.set(mint, s);
      };
      const results = await Promise.allSettled([
        this.dex.getTopBoostedTokens(),
        this.dex.getLatestBoostedTokens(),
        this.dex.getLatestProfiles(),
        this.dex.search('SOL'),
      ]);
      const labels = ['boost-top', 'boost-latest', 'profile', 'search'];
      const directPairs: DexPair[] = [];
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          log.warn('trending source failed', { source: labels[i], error: (r.reason as Error).message });
          return;
        }
        if (i === 3) {
          for (const p of r.value as DexPair[]) {
            add(p.baseToken.address, 'search');
            directPairs.push(p);
          }
        } else {
          for (const t of r.value as Array<{ tokenAddress: string }>) add(t.tokenAddress, labels[i]!);
        }
      });
      if (sourcesByMint.size === 0) throw new Error('No trending sources available');
      const mints = [...sourcesByMint.keys()].filter((m) => !EXCLUDED.has(m)).slice(0, 150);
      const pairs = await this.dex.getPairsForTokens(mints);
      return aggregateTokens([...pairs, ...directPairs.filter((p) => !pairs.some((q) => q.pairAddress === p.pairAddress))], sourcesByMint);
    });
  }

  async explore(filters: TrendingFilters): Promise<TrendingToken[]> {
    return filterAndSort(await this.getUniverse(), filters);
  }
}
