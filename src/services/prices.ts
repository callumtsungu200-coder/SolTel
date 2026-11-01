import type { DexPair, DexScreenerClient } from '../clients/dexscreener.js';
import { TtlCache } from '../utils/cache.js';
import { WSOL_MINT } from '../validation/address.js';

/**
 * Price discovery from DexScreener pools.
 *
 * For each mint we select the pool with the highest USD liquidity. Prices
 * from pools below `MIN_PRICING_LIQUIDITY_USD` are reported but excluded from
 * portfolio valuations, because thin pools are trivially manipulated.
 */

export const MIN_PRICING_LIQUIDITY_USD = 1_000;

export interface PriceQuote {
  mint: string;
  priceUsd: number;
  liquidityUsd: number;
  pairAddress: string;
  dexId: string;
  /** True when the pool is deep enough to be used for valuation. */
  reliable: boolean;
  symbol: string;
  name: string;
  /** "base" if the token is the pool's base token; "quote" if derived from the quote side. */
  side: 'base' | 'quote';
}

export function liquidityOf(p: DexPair): number {
  return p.liquidity?.usd ?? 0;
}

/** Chooses the deepest pool per mint and converts it into a quote. Pure function. */
export function selectQuotes(mints: string[], pairs: DexPair[]): Map<string, PriceQuote> {
  const wanted = new Set(mints);
  const best = new Map<string, PriceQuote>();
  const consider = (q: PriceQuote) => {
    const cur = best.get(q.mint);
    // Prefer base-side quotes; among the same side prefer deeper liquidity.
    if (!cur || (cur.side === 'quote' && q.side === 'base') || (cur.side === q.side && q.liquidityUsd > cur.liquidityUsd)) best.set(q.mint, q);
  };
  for (const p of pairs) {
    const liq = liquidityOf(p);
    const baseUsd = p.priceUsd ? Number(p.priceUsd) : NaN;
    if (!Number.isFinite(baseUsd) || baseUsd <= 0) continue;
    if (wanted.has(p.baseToken.address)) {
      consider({
        mint: p.baseToken.address,
        priceUsd: baseUsd,
        liquidityUsd: liq,
        pairAddress: p.pairAddress,
        dexId: p.dexId,
        reliable: liq >= MIN_PRICING_LIQUIDITY_USD,
        symbol: p.baseToken.symbol,
        name: p.baseToken.name,
        side: 'base',
      });
    }
    if (wanted.has(p.quoteToken.address)) {
      const native = p.priceNative ? Number(p.priceNative) : NaN;
      if (Number.isFinite(native) && native > 0) {
        consider({
          mint: p.quoteToken.address,
          priceUsd: baseUsd / native,
          liquidityUsd: liq,
          pairAddress: p.pairAddress,
          dexId: p.dexId,
          reliable: liq >= MIN_PRICING_LIQUIDITY_USD,
          symbol: p.quoteToken.symbol,
          name: p.quoteToken.name,
          side: 'quote',
        });
      }
    }
  }
  return best;
}

export class PriceService {
  private readonly quoteCache = new TtlCache<PriceQuote | null>(60_000, 5000);
  private readonly pairsCache = new TtlCache<DexPair[]>(30_000, 1000);

  constructor(private readonly dex: DexScreenerClient) {}

  /**
   * All pools for one token (DexScreener /token-pairs, up to 30), cached
   * briefly. The batch /tokens endpoint only returns each token's main pair,
   * so it is used as a fallback only.
   */
  async getPairs(mint: string): Promise<DexPair[]> {
    return this.pairsCache.getOrLoad(mint, async () => {
      const pools = await this.dex.getTokenPools(mint);
      return pools.length > 0 ? pools : this.dex.getPairsForTokens([mint]);
    });
  }

  async getQuotes(mints: string[]): Promise<Map<string, PriceQuote>> {
    const out = new Map<string, PriceQuote>();
    const missing: string[] = [];
    for (const m of new Set(mints)) {
      const cached = this.quoteCache.get(m);
      if (cached === undefined) missing.push(m);
      else if (cached) out.set(m, cached);
    }
    if (missing.length > 0) {
      const pairs = await this.dex.getPairsForTokens(missing);
      const quotes = selectQuotes(missing, pairs);
      for (const m of missing) {
        const q = quotes.get(m) ?? null;
        this.quoteCache.set(m, q);
        if (q) out.set(m, q);
      }
    }
    return out;
  }

  async getSolPrice(): Promise<number | null> {
    const q = (await this.getQuotes([WSOL_MINT])).get(WSOL_MINT);
    return q?.priceUsd ?? null;
  }
}
