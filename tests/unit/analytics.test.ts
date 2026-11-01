import { describe, expect, it } from 'vitest';
import { analyzePatterns, interactionHistory } from '../../src/analytics/patterns.js';
import { allocation, attributeChange, constantHoldingsValue, priceHoldings, summarize } from '../../src/analytics/portfolio.js';
import { annualizedVolatility, dailyVolumeAnomaly, hourlyVolumeAnomaly, maxDrawdown, pctChange, zScore } from '../../src/analytics/stats.js';
import { assembleTokenReport, computeConcentration, summarizeHistory } from '../../src/analytics/token.js';
import { aggregateTokens, filterAndSort } from '../../src/analytics/trending.js';
import { buildTimeline, computeAcquisitions, computeStats, estimateUsd } from '../../src/analytics/wallet.js';
import { computeActivityScore } from '../../src/analytics/walletScore.js';
import { parseEnvelopes } from '../../src/clients/helius.js';
import { MIN_PRICING_LIQUIDITY_USD, selectQuotes, type PriceQuote } from '../../src/services/prices.js';
import { normalizeParsedEvent, walletView } from '../../src/services/transactions.js';
import {
  dexPair,
  JUP,
  OTHER,
  parsedSwapEnvelope,
  parsedTokenTransferEnvelope,
  parsedTransferEnvelope,
  USDC_MINT,
  WALLET,
  WSOL_MINT,
} from '../fixtures/index.js';

const views = (envs: unknown[]) => parseEnvelopes(envs).items.map((i) => walletView(normalizeParsedEvent(i), WALLET));

describe('price selection', () => {
  it('prefers the deepest base-side pool and flags thin pools as unreliable', () => {
    const quotes = selectQuotes(
      [JUP, 'THIN1111111111111111111111111111111111111111'],
      [
        dexPair({ base: JUP, liq: 10_000, price: '0.9', pairAddress: 'small' }),
        dexPair({ base: JUP, liq: 500_000, price: '1.0', pairAddress: 'deep' }),
        dexPair({ base: 'THIN1111111111111111111111111111111111111111', liq: MIN_PRICING_LIQUIDITY_USD - 1, price: '5' }),
      ],
    );
    expect(quotes.get(JUP)).toMatchObject({ priceUsd: 1, pairAddress: 'deep', reliable: true, side: 'base' });
    expect(quotes.get('THIN1111111111111111111111111111111111111111')?.reliable).toBe(false);
  });

  it('derives a quote-side price when the token only appears as quote', () => {
    // base = JUP at $2, priceNative = 4 USDC per JUP → USDC ≈ $0.5 (contrived to test math)
    const q = selectQuotes([USDC_MINT], [dexPair({ base: JUP, quote: USDC_MINT, price: '2', priceNative: '4' })]);
    expect(q.get(USDC_MINT)).toMatchObject({ priceUsd: 0.5, side: 'quote' });
  });

  it('ignores pools without a USD price', () => {
    expect(selectQuotes([JUP], [dexPair({ base: JUP, price: undefined as unknown as string, priceUsd: null })]).size).toBe(0);
  });
});

describe('portfolio calculations', () => {
  const quotes = new Map<string, PriceQuote>([
    [USDC_MINT, { mint: USDC_MINT, priceUsd: 1, liquidityUsd: 1e6, pairAddress: 'p', dexId: 'd', reliable: true, symbol: 'USDC', name: 'USD Coin', side: 'base' }],
    [JUP, { mint: JUP, priceUsd: 0.5, liquidityUsd: 500, pairAddress: 'p2', dexId: 'd', reliable: false, symbol: 'JUP', name: 'Jupiter', side: 'base' }],
  ]);

  it('values only reliably priced holdings and counts the rest', () => {
    const h = priceHoldings(
      [
        { mint: USDC_MINT, amount: 100, decimals: 6 },
        { mint: JUP, amount: 1000, decimals: 6 },
        { mint: 'NOPRICE11111111111111111111111111111111111', amount: 5, decimals: 0, heliusPriceUsd: null },
        { mint: 'HELIUS111111111111111111111111111111111111', amount: 2, decimals: 6, heliusPriceUsd: 3 },
        { mint: 'ZERO1111111111111111111111111111111111111111', amount: 0, decimals: 6 },
      ],
      quotes,
    );
    expect(h).toHaveLength(4);
    expect(h.find((x) => x.mint === USDC_MINT)?.valueUsd).toBe(100);
    expect(h.find((x) => x.mint === JUP)).toMatchObject({ valueUsd: null, reliable: false, priceUsd: 0.5 });
    expect(h.find((x) => x.mint.startsWith('HELIUS'))).toMatchObject({ valueUsd: 6, priceSource: 'helius' });
    const s = summarize(2, 100, h);
    expect(s).toMatchObject({ solValueUsd: 200, tokensValueUsd: 106, totalValueUsd: 306, pricedCount: 2, unpricedCount: 1, lowLiquidityCount: 1 });
  });

  it('reports total as unavailable without a SOL price', () => {
    expect(summarize(2, null, []).totalValueUsd).toBeNull();
  });

  it('groups small allocations into Others', () => {
    const holdings = Array.from({ length: 10 }, (_, i) => ({
      mint: `m${i}`, symbol: `T${i}`, name: '', amount: 1, decimals: 0, priceUsd: 1, valueUsd: 10 - i, liquidityUsd: 1e6, priceSource: 'dexscreener' as const, reliable: true,
    }));
    const rows = allocation(summarize(1, 100, holdings), holdings, 5);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ label: 'SOL', value: 100 });
    expect(rows[5]!.label).toBe('Others');
  });

  it('splits value change into price and quantity effects (not profit)', () => {
    const prev = { solBalance: 10, solPriceUsd: 100, totalValueUsd: 1100, holdings: [{ mint: USDC_MINT, symbol: 'USDC', amount: 100, priceUsd: 1 }], takenAt: '' };
    const cur = { solBalance: 12, solPriceUsd: 110, totalValueUsd: 1420, holdings: [{ mint: USDC_MINT, symbol: 'USDC', amount: 100, priceUsd: 1 }], takenAt: '' };
    const a = attributeChange(prev, cur);
    expect(a.valueChangeUsd).toBe(320);
    expect(a.priceEffectUsd).toBe(100); // 10 SOL × +$10
    expect(a.quantityEffectUsd).toBe(220); // +2 SOL × $110
    expect(a.priceEffectUsd + a.quantityEffectUsd).toBe(a.valueChangeUsd);
  });

  it('counts unattributable assets when prices are missing', () => {
    const prev = { solBalance: 1, solPriceUsd: 100, totalValueUsd: 100, holdings: [{ mint: JUP, symbol: 'JUP', amount: 5, priceUsd: null }], takenAt: '' };
    const cur = { solBalance: 1, solPriceUsd: 100, totalValueUsd: 100, holdings: [{ mint: JUP, symbol: 'JUP', amount: 8, priceUsd: null }], takenAt: '' };
    expect(attributeChange(prev, cur).unattributedAssets).toBe(1);
  });

  it('computes constant-holdings value with coverage', () => {
    expect(constantHoldingsValue([{ amount: 2, pastPrice: 10 }, { amount: 1, pastPrice: null }])).toEqual({ value: 20, coverage: 0.5 });
  });
});

describe('statistics', () => {
  it('computes volatility, drawdown and changes', () => {
    expect(annualizedVolatility([1, 1, 1, 1, 1, 1, 1])).toBe(0);
    expect(annualizedVolatility([1, 2])).toBeNull();
    const v = annualizedVolatility([100, 110, 99, 108, 101, 112, 105, 109])!;
    expect(v).toBeGreaterThan(50);
    expect(maxDrawdown([100, 120, 60, 90])).toBe(50);
    expect(pctChange(50, 75)).toBe(50);
    expect(pctChange(0, 5)).toBeNull();
    expect(pctChange(null, 5)).toBeNull();
    expect(zScore(10, [1, 1, 1, 1])).toBeNull();
  });

  it('detects unusual volume', () => {
    expect(hourlyVolumeAnomaly(3000, 24000)).toMatchObject({ ratio: 3, unusual: true });
    expect(hourlyVolumeAnomaly(500, 24000).unusual).toBe(false);
    expect(hourlyVolumeAnomaly(null, 24000).ratio).toBeNull();
    expect(dailyVolumeAnomaly([10, 11, 9, 10, 12, 10, 11, 60]).unusual).toBe(true);
    expect(dailyVolumeAnomaly([1, 2, 3]).basis).toMatch(/fewer than 8/);
  });
});

describe('wallet activity score', () => {
  it('is bounded 0–100 and labels activity', () => {
    const idle = computeActivityScore({ txPerDay: 0, hoursSinceLastTx: null, uniqueCounterparties: 0, distinctMints: 0, ageDays: null });
    expect(idle).toMatchObject({ total: 0, label: 'Dormant' });
    const max = computeActivityScore({ txPerDay: 1e6, hoursSinceLastTx: 1, uniqueCounterparties: 1e6, distinctMints: 1e6, ageDays: 1e6 });
    expect(max.total).toBe(100);
    expect(max.label).toBe('Very active');
  });

  it('weights recency by documented brackets', () => {
    const at = (h: number) => computeActivityScore({ txPerDay: 0, hoursSinceLastTx: h, uniqueCounterparties: 0, distinctMints: 0, ageDays: 0 }).components.recency;
    expect([at(1), at(48), at(24 * 20), at(24 * 60), at(24 * 365)]).toEqual([20, 14, 8, 3, 0]);
  });
});

describe('wallet history analytics', () => {
  const v = views([
    parsedTransferEnvelope({ from: OTHER, to: WALLET, lamports: 5_000_000_000, blockTime: 1_761_000_000 }),
    parsedTokenTransferEnvelope({ from: OTHER, to: WALLET, mint: JUP, raw: 1_000_000, decimals: 6, blockTime: 1_761_003_600 }),
    parsedSwapEnvelope(),
    parsedTokenTransferEnvelope({ from: OTHER, to: WALLET, mint: JUP, raw: 2_000_000, decimals: 6, blockTime: 1_761_090_000 }),
  ]);

  it('computes window statistics', () => {
    const s = computeStats(v);
    expect(s.windowTxCount).toBe(4);
    expect(s.solIn).toBe(5);
    expect(s.swaps).toBe(1);
    expect(s.transfersIn).toBe(3);
    expect(s.distinctMints).toBe(3);
  });

  it('records first observed acquisitions per mint with how they arrived', () => {
    const acq = computeAcquisitions(v);
    const jup = acq.find((a) => a.mint === JUP)!;
    expect(jup).toMatchObject({ amount: 1, via: 'transfer', firstSeen: 1_761_003_600 });
    expect(acq.find((a) => a.mint === USDC_MINT)?.via).toBe('swap');
    expect(acq.some((a) => a.mint === WSOL_MINT)).toBe(false);
  });

  it('builds a chronological timeline of notable events', () => {
    const tl = buildTimeline(v, computeAcquisitions(v), 100, new Map([[USDC_MINT, 1]]));
    const times = tl.map((e) => e.timestamp ?? 0);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(tl.some((e) => e.reason.includes('≥1 SOL'))).toBe(true);
    expect(tl.some((e) => e.reason.includes('swap'))).toBe(true);
  });

  it('estimates USD without double counting swap legs', () => {
    const swap = v.find((x) => x.category === 'swap')!;
    expect(estimateUsd(swap, 100, new Map([[USDC_MINT, 1], [WSOL_MINT, 150]]))).toBe(225.5);
    expect(estimateUsd(swap, null, new Map())).toBeNull();
  });

  it('analyses patterns and interaction history', () => {
    const p = analyzePatterns(v);
    expect(p.hourHistogram.reduce((a, b) => a + b, 0)).toBe(4);
    expect(p.topCounterparties[0]!.address).toBe(OTHER);
    expect(p.topCounterparties[0]!.solReceived).toBe(5);
    expect(interactionHistory(v, OTHER)).toHaveLength(3);
  });
});

describe('token report assembly', () => {
  const mintInfo = { decimals: 6, supplyRaw: '1000000000000', mintAuthority: WALLET, freezeAuthority: null, program: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };

  it('labels provenance and computes calculated FDV from on-chain supply', () => {
    const r = assembleTokenReport({
      mint: JUP,
      pairs: [dexPair({ base: JUP, liq: 200_000, price: '2' }), dexPair({ base: JUP, liq: 100_000, price: '2.1', pairAddress: 'second' })],
      meta: null,
      mintInfo,
      candles: null,
    });
    expect(r.supply).toMatchObject({ value: 1_000_000, provenance: 'verified' });
    expect(r.priceUsd).toMatchObject({ value: 2, provenance: 'market' });
    expect(r.fdvCalculated).toMatchObject({ value: 2_000_000, provenance: 'estimated' });
    expect(r.liquidityUsd.value).toBe(300_000);
    expect(r.mintAuthority.value).toBe(WALLET);
    expect(r.freezeAuthority.value).toBe('none');
    expect(r.warnings.join(' ')).toMatch(/Mint authority is active/);
    expect(r.warnings.join(' ')).toMatch(/Historical price data unavailable/);
  });

  it('marks everything unavailable instead of inventing data when no pairs exist', () => {
    const r = assembleTokenReport({ mint: JUP, pairs: [], meta: null, mintInfo: null, candles: null });
    expect(r.priceUsd).toEqual({ value: null, provenance: 'unavailable' });
    expect(r.marketCap.provenance).toBe('unavailable');
    expect(r.supply.provenance).toBe('unavailable');
    expect(r.warnings.join(' ')).toMatch(/No DEX trading pairs/);
  });

  it('ignores pools where the token is only the quote side for price', () => {
    const r = assembleTokenReport({ mint: USDC_MINT, pairs: [dexPair({ base: JUP, quote: USDC_MINT })], meta: null, mintInfo, candles: null });
    expect(r.pairCount).toBe(0);
  });

  it('summarises history from candles', () => {
    const candles = Array.from({ length: 31 }, (_, i) => ({ t: 1_700_000_000 + i * 86400, o: 1, h: 1 + i / 10, l: 0.5, c: 1 + i / 30, v: 1000 }));
    const h = summarizeHistory(candles, 'pool');
    expect(h.change30d).toBeCloseTo(100);
    expect(h.high30d).toBeCloseTo(4);
    expect(h.volatilityAnnualized).not.toBeNull();
  });

  it('computes holder concentration from largest accounts', () => {
    const c = computeConcentration(JUP, 1000, [{ address: 'a', uiAmount: 500 }, { address: 'b', uiAmount: 100 }], new Map([['a', WALLET]]))!;
    expect(c.top1Pct).toBe(50);
    expect(c.top10Pct).toBe(60);
    expect(c.topAccounts[0]!.owner).toBe(WALLET);
    expect(c.hhiTop20).toBeCloseTo(0.26);
    expect(computeConcentration(JUP, 0, [], new Map())).toBeNull();
  });
});

describe('trending explorer', () => {
  const sources = new Map([
    [JUP, new Set(['boost-top'])],
    ['NEW11111111111111111111111111111111111111111', new Set(['profile'])],
  ]);
  const pairs = [
    dexPair({ base: JUP, liq: 1_000_000, volume: { h24: 5_000_000, h1: 100_000 }, priceChange: { h24: 10, h1: 1 } }),
    dexPair({ base: 'NEW11111111111111111111111111111111111111111', liq: 5_000, volume: { h24: 900_000, h1: 50_000 }, priceChange: { h24: 250, h1: 40 }, pairCreatedAt: Date.now() - 3600_000, marketCap: null, fdv: null }),
    dexPair({ base: WSOL_MINT, liq: 9e9 }),
  ];

  it('aggregates candidates, excludes base assets and attaches warnings', () => {
    const t = aggregateTokens(pairs, new Map([...sources, [WSOL_MINT, new Set(['search'])]]));
    expect(t.map((x) => x.mint)).not.toContain(WSOL_MINT);
    const fresh = t.find((x) => x.mint.startsWith('NEW'))!;
    expect(fresh.warnings).toEqual(expect.arrayContaining(['no market cap data', 'low liquidity', 'pair < 24h old', 'volume ≫ liquidity', 'extreme price move']));
    expect(t.find((x) => x.mint === JUP)!.warnings).toContain('paid boost on DexScreener');
  });

  it('filters by minimum liquidity/volume and sorts', () => {
    const t = aggregateTokens(pairs, sources);
    expect(filterAndSort(t, { sort: 'volume', minLiquidityUsd: 0, minVolumeUsd: 0 })[0]!.mint).toBe(JUP);
    expect(filterAndSort(t, { sort: 'gainers', minLiquidityUsd: 0, minVolumeUsd: 0 })[0]!.mint).toMatch(/^NEW/);
    expect(filterAndSort(t, { sort: 'losers', minLiquidityUsd: 0, minVolumeUsd: 0 })[0]!.mint).toBe(JUP);
    expect(filterAndSort(t, { sort: 'volume', minLiquidityUsd: 10_000, minVolumeUsd: 0 })).toHaveLength(1);
    expect(filterAndSort(t, { sort: 'volume', minLiquidityUsd: 0, minVolumeUsd: 1_000_000 })).toHaveLength(1);
  });
});
