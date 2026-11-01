import type { PriceQuote } from '../services/prices.js';

/**
 * Portfolio valuation and change attribution. Pure functions.
 *
 * Values are ESTIMATES: on-chain balances (verified) × current DEX prices
 * (market data). Value changes between snapshots are split into
 *   - price effect:    previous amount × (new price − old price)
 *   - quantity effect: (new amount − previous amount) × new price
 * A value change is not realised trading profit: deposits, withdrawals and
 * transfers change the quantity effect without any trade occurring.
 */

export interface Holding {
  mint: string;
  symbol: string;
  name: string;
  amount: number;
  decimals: number;
  priceUsd: number | null;
  valueUsd: number | null;
  liquidityUsd: number | null;
  priceSource: 'dexscreener' | 'helius' | null;
  /** False if price came from a pool too thin to be used for valuation. */
  reliable: boolean;
}

export interface PortfolioSummary {
  solBalance: number;
  solPriceUsd: number | null;
  solValueUsd: number | null;
  tokensValueUsd: number;
  totalValueUsd: number | null;
  pricedCount: number;
  unpricedCount: number;
  lowLiquidityCount: number;
}

export interface RawBalance {
  mint: string;
  amount: number;
  decimals: number;
  symbol?: string | null;
  name?: string | null;
  heliusPriceUsd?: number | null;
}

export function priceHoldings(balances: RawBalance[], quotes: Map<string, PriceQuote>): Holding[] {
  return balances
    .filter((b) => b.amount > 0)
    .map((b) => {
      const q = quotes.get(b.mint);
      let priceUsd: number | null = null;
      let priceSource: Holding['priceSource'] = null;
      let reliable = false;
      if (q) {
        priceUsd = q.priceUsd;
        priceSource = 'dexscreener';
        reliable = q.reliable;
      } else if (b.heliusPriceUsd && b.heliusPriceUsd > 0) {
        priceUsd = b.heliusPriceUsd;
        priceSource = 'helius';
        reliable = true;
      }
      return {
        mint: b.mint,
        symbol: b.symbol || q?.symbol || `${b.mint.slice(0, 4)}…`,
        name: b.name || q?.name || '',
        amount: b.amount,
        decimals: b.decimals,
        priceUsd,
        valueUsd: priceUsd !== null && reliable ? b.amount * priceUsd : null,
        liquidityUsd: q?.liquidityUsd ?? null,
        priceSource,
        reliable,
      };
    })
    .sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));
}

export function summarize(solBalance: number, solPriceUsd: number | null, holdings: Holding[]): PortfolioSummary {
  const solValueUsd = solPriceUsd !== null ? solBalance * solPriceUsd : null;
  const tokensValueUsd = holdings.reduce((s, h) => s + (h.valueUsd ?? 0), 0);
  return {
    solBalance,
    solPriceUsd,
    solValueUsd,
    tokensValueUsd,
    totalValueUsd: solValueUsd !== null ? solValueUsd + tokensValueUsd : null,
    pricedCount: holdings.filter((h) => h.valueUsd !== null).length,
    unpricedCount: holdings.filter((h) => h.priceUsd === null).length,
    lowLiquidityCount: holdings.filter((h) => h.priceUsd !== null && !h.reliable).length,
  };
}

export interface AllocationRow {
  label: string;
  value: number;
}

export function allocation(summary: PortfolioSummary, holdings: Holding[], topN = 7): AllocationRow[] {
  const rows: AllocationRow[] = [];
  if (summary.solValueUsd && summary.solValueUsd > 0) rows.push({ label: 'SOL', value: summary.solValueUsd });
  for (const h of holdings) if (h.valueUsd && h.valueUsd > 0) rows.push({ label: h.symbol, value: h.valueUsd });
  rows.sort((a, b) => b.value - a.value);
  if (rows.length <= topN) return rows;
  const head = rows.slice(0, topN);
  const rest = rows.slice(topN).reduce((s, r) => s + r.value, 0);
  return [...head, { label: 'Others', value: rest }];
}

/** Compact holdings representation stored in portfolio snapshots. */
export interface SnapshotHolding {
  mint: string;
  symbol: string;
  amount: number;
  priceUsd: number | null;
}

export interface SnapshotLike {
  solBalance: number;
  solPriceUsd: number | null;
  totalValueUsd: number | null;
  holdings: SnapshotHolding[];
  takenAt: string;
}

export interface ChangeAttribution {
  valueChangeUsd: number | null;
  valueChangePct: number | null;
  priceEffectUsd: number;
  quantityEffectUsd: number;
  /** Assets whose value could not be attributed because a price was missing at either point. */
  unattributedAssets: number;
}

export function attributeChange(prev: SnapshotLike, cur: SnapshotLike): ChangeAttribution {
  let priceEffect = 0;
  let quantityEffect = 0;
  let unattributed = 0;
  const legs: Array<{ a0: number; a1: number; p0: number | null; p1: number | null }> = [
    { a0: prev.solBalance, a1: cur.solBalance, p0: prev.solPriceUsd, p1: cur.solPriceUsd },
  ];
  const prevMap = new Map(prev.holdings.map((h) => [h.mint, h]));
  const curMap = new Map(cur.holdings.map((h) => [h.mint, h]));
  for (const mint of new Set([...prevMap.keys(), ...curMap.keys()])) {
    const p = prevMap.get(mint);
    const c = curMap.get(mint);
    legs.push({ a0: p?.amount ?? 0, a1: c?.amount ?? 0, p0: p?.priceUsd ?? null, p1: c?.priceUsd ?? null });
  }
  for (const l of legs) {
    if (l.a0 === 0 && l.a1 === 0) continue;
    if (l.a0 > 0 && l.p0 !== null && l.p1 !== null) priceEffect += l.a0 * (l.p1 - l.p0);
    else if (l.a0 > 0) {
      unattributed++;
      continue;
    }
    const pNew = l.p1 ?? l.p0;
    if (pNew !== null) quantityEffect += (l.a1 - l.a0) * pNew;
    else unattributed++;
  }
  const change = prev.totalValueUsd !== null && cur.totalValueUsd !== null ? cur.totalValueUsd - prev.totalValueUsd : null;
  return {
    valueChangeUsd: change,
    valueChangePct: change !== null && prev.totalValueUsd ? (change / prev.totalValueUsd) * 100 : null,
    priceEffectUsd: priceEffect,
    quantityEffectUsd: quantityEffect,
    unattributedAssets: unattributed,
  };
}

/**
 * "Constant holdings" historical valuation: what the CURRENT balances would
 * have been worth at past prices. Useful for showing price exposure; it is not
 * a record of what the wallet actually held or earned.
 */
export function constantHoldingsValue(amounts: Array<{ amount: number; pastPrice: number | null }>): { value: number; coverage: number } {
  let value = 0;
  let covered = 0;
  for (const a of amounts) {
    if (a.pastPrice !== null) {
      value += a.amount * a.pastPrice;
      covered++;
    }
  }
  return { value, coverage: amounts.length ? covered / amounts.length : 0 };
}
