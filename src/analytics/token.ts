import type { DexPair } from '../clients/dexscreener.js';
import type { Candle, GeckoTerminalClient } from '../clients/geckoterminal.js';
import type { MintInfo, SolanaRpcClient } from '../clients/solanaRpc.js';
import { liquidityOf, type PriceService } from '../services/prices.js';
import type { TokenMeta, TokenMetadataService } from '../services/tokenMetadata.js';
import { TtlCache } from '../utils/cache.js';
import { createLogger } from '../utils/logger.js';
import { annualizedVolatility, dailyVolumeAnomaly, hhi, hourlyVolumeAnomaly, maxDrawdown, pctChange, type VolumeAnomaly } from './stats.js';

const log = createLogger('token-intel');

/**
 * Data provenance labels shown next to every figure:
 *  - verified:   read directly from the Solana blockchain (RPC / DAS on-chain fields)
 *  - market:     reported by a market-data provider (DexScreener / GeckoTerminal)
 *  - estimated:  calculated by this bot from other figures
 *  - unavailable
 */
export type Provenance = 'verified' | 'market' | 'estimated' | 'unavailable';

export interface Figure<T> {
  value: T | null;
  provenance: Provenance;
  source?: string;
}

const fig = <T>(value: T | null | undefined, provenance: Provenance, source?: string): Figure<T> =>
  value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))
    ? { value: null, provenance: 'unavailable' }
    : { value, provenance, source };

export interface PairSummary {
  pairAddress: string;
  dexId: string;
  baseSymbol: string;
  quoteSymbol: string;
  priceUsd: number | null;
  liquidityUsd: number;
  volume24h: number;
  txns24h: number;
  createdAt: number | null;
  url: string | null;
}

export interface HistorySummary {
  candles: Candle[];
  change7d: number | null;
  change30d: number | null;
  high30d: number | null;
  low30d: number | null;
  volatilityAnnualized: number | null;
  maxDrawdown30d: number | null;
  dailyVolume: VolumeAnomaly;
  poolAddress: string;
}

export interface TokenReport {
  mint: string;
  fetchedAt: number;
  name: Figure<string>;
  symbol: Figure<string>;
  decimals: Figure<number>;
  supply: Figure<number>;
  mintAuthority: Figure<string | 'none'>;
  freezeAuthority: Figure<string | 'none'>;
  tokenProgram: Figure<string>;
  metadataMutable: Figure<boolean>;
  priceUsd: Figure<number>;
  marketCap: Figure<number>;
  fdv: Figure<number>;
  fdvCalculated: Figure<number>;
  liquidityUsd: Figure<number>;
  volume24h: Figure<number>;
  priceChange: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  txns24h: { buys: number | null; sells: number | null };
  pairCount: number;
  pairs: PairSummary[];
  primaryPair: PairSummary | null;
  hourlyVolume: VolumeAnomaly;
  history: HistorySummary | null;
  meta: TokenMeta | null;
  links: { websites: string[]; socials: string[] };
  warnings: string[];
}

export function summarizePair(p: DexPair): PairSummary {
  const t = p.txns?.h24;
  return {
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    baseSymbol: p.baseToken.symbol,
    quoteSymbol: p.quoteToken.symbol,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
    liquidityUsd: liquidityOf(p),
    volume24h: p.volume?.h24 ?? 0,
    txns24h: (t?.buys ?? 0) + (t?.sells ?? 0),
    createdAt: p.pairCreatedAt ? Math.floor(p.pairCreatedAt / 1000) : null,
    url: p.url ?? null,
  };
}

export function summarizeHistory(candles: Candle[], poolAddress: string): HistorySummary {
  const closes = candles.map((c) => c.c);
  const last = closes[closes.length - 1] ?? null;
  const at = (daysAgo: number) => (closes.length > daysAgo ? closes[closes.length - 1 - daysAgo]! : null);
  return {
    candles,
    change7d: pctChange(at(7), last),
    change30d: pctChange(closes.length >= 30 ? closes[0]! : null, last),
    high30d: candles.length ? Math.max(...candles.map((c) => c.h)) : null,
    low30d: candles.length ? Math.min(...candles.map((c) => c.l)) : null,
    volatilityAnnualized: annualizedVolatility(closes, 24),
    maxDrawdown30d: maxDrawdown(closes),
    // Exclude the current (incomplete) day from the volume comparison.
    dailyVolume: dailyVolumeAnomaly(candles.slice(0, -1).map((c) => c.v)),
    poolAddress,
  };
}

/** Builds the report from already-fetched inputs. Pure, so it is directly testable. */
export function assembleTokenReport(input: {
  mint: string;
  pairs: DexPair[];
  meta: TokenMeta | null;
  mintInfo: MintInfo | null;
  candles: Candle[] | null;
  now?: number;
}): TokenReport {
  const { mint, meta, mintInfo } = input;
  const now = input.now ?? Date.now();
  const warnings: string[] = [];
  const basePairs = input.pairs.filter((p) => p.baseToken.address === mint).sort((a, b) => liquidityOf(b) - liquidityOf(a));
  const primary = basePairs[0] ?? null;
  const pairs = basePairs.map(summarizePair);

  const decimals = mintInfo?.decimals ?? meta?.decimals ?? null;
  const onchainSupply = mintInfo && decimals !== null ? Number(mintInfo.supplyRaw) / 10 ** decimals : null;
  const supply = onchainSupply ?? meta?.supply ?? null;
  const price = primary?.priceUsd ? Number(primary.priceUsd) : null;
  const totalLiquidity = basePairs.reduce((s, p) => s + liquidityOf(p), 0);
  const totalVolume = basePairs.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0);

  if (!primary) warnings.push('No DEX trading pairs found on DexScreener — price, liquidity and volume are unavailable.');
  if (primary && totalLiquidity < 10_000) warnings.push(`Very low liquidity (${Math.round(totalLiquidity).toLocaleString('en-US')} USD): prices can move sharply on small trades.`);
  if (mintInfo?.mintAuthority) warnings.push('Mint authority is active: additional supply can be minted.');
  if (mintInfo?.freezeAuthority) warnings.push('Freeze authority is active: token accounts can be frozen by the authority.');
  if (meta?.mutable) warnings.push('Token metadata is mutable (name/symbol/image can be changed).');
  const created = primary?.pairCreatedAt ?? null;
  if (created && now - created < 24 * 3600_000) warnings.push('Primary trading pair is less than 24 hours old.');
  if (primary && totalLiquidity > 0 && totalVolume / totalLiquidity > 50) warnings.push('24h volume is more than 50× liquidity — possible wash trading or extreme speculation.');
  if (!mintInfo) warnings.push('On-chain mint account could not be read; supply and authorities are unverified.');

  const fdvCalc = price !== null && supply !== null ? price * supply : null;
  const history = input.candles && input.candles.length > 0 && primary ? summarizeHistory(input.candles, primary.pairAddress) : null;
  if (primary && !history) warnings.push('Historical price data unavailable for this pool (GeckoTerminal).');

  return {
    mint,
    fetchedAt: now,
    name: fig(meta?.name ?? primary?.baseToken.name, meta?.name ? 'verified' : 'market', meta?.name ? 'on-chain metadata (Helius DAS)' : 'DexScreener'),
    symbol: fig(meta?.symbol ?? primary?.baseToken.symbol, meta?.symbol ? 'verified' : 'market', meta?.symbol ? 'on-chain metadata (Helius DAS)' : 'DexScreener'),
    decimals: fig(decimals, 'verified', mintInfo ? 'mint account' : 'Helius DAS'),
    supply: fig(supply, 'verified', onchainSupply !== null ? 'mint account' : 'Helius DAS'),
    mintAuthority: fig(mintInfo ? (mintInfo.mintAuthority ?? 'none') : null, 'verified', 'mint account'),
    freezeAuthority: fig(mintInfo ? (mintInfo.freezeAuthority ?? 'none') : null, 'verified', 'mint account'),
    tokenProgram: fig(mintInfo?.program ?? meta?.tokenProgram, 'verified'),
    metadataMutable: fig(meta?.mutable, 'verified', 'Helius DAS'),
    priceUsd: fig(price, 'market', primary ? `DexScreener (${primary.dexId})` : undefined),
    marketCap: fig(primary?.marketCap, 'market', 'DexScreener'),
    fdv: fig(primary?.fdv, 'market', 'DexScreener'),
    fdvCalculated: fig(fdvCalc, 'estimated', 'on-chain supply × price'),
    liquidityUsd: fig(primary ? totalLiquidity : null, 'market', `sum of ${basePairs.length} pools`),
    volume24h: fig(primary ? totalVolume : null, 'market', `sum of ${basePairs.length} pools`),
    priceChange: {
      m5: primary?.priceChange?.m5 ?? null,
      h1: primary?.priceChange?.h1 ?? null,
      h6: primary?.priceChange?.h6 ?? null,
      h24: primary?.priceChange?.h24 ?? null,
    },
    txns24h: { buys: primary?.txns?.h24?.buys ?? null, sells: primary?.txns?.h24?.sells ?? null },
    pairCount: basePairs.length,
    pairs: pairs.slice(0, 5),
    primaryPair: pairs[0] ?? null,
    hourlyVolume: hourlyVolumeAnomaly(primary?.volume?.h1, primary?.volume?.h24),
    history,
    meta,
    links: {
      websites: primary?.info?.websites?.map((w) => w.url) ?? [],
      socials: primary?.info?.socials?.map((s) => s.url) ?? [],
    },
    warnings,
  };
}

export interface ConcentrationReport {
  mint: string;
  supply: number;
  topAccounts: Array<{ tokenAccount: string; owner: string | null; amount: number; share: number }>;
  top1Pct: number;
  top10Pct: number;
  top20Pct: number;
  hhiTop20: number;
  caveat: string;
}

export function computeConcentration(
  mint: string,
  supply: number,
  largest: Array<{ address: string; uiAmount: number }>,
  owners: Map<string, string>,
): ConcentrationReport | null {
  if (!(supply > 0) || largest.length === 0) return null;
  const top = largest
    .slice(0, 20)
    .map((a) => ({ tokenAccount: a.address, owner: owners.get(a.address) ?? null, amount: a.uiAmount, share: a.uiAmount / supply }));
  const sumShare = (n: number) => top.slice(0, n).reduce((s, a) => s + a.share, 0) * 100;
  return {
    mint,
    supply,
    topAccounts: top,
    top1Pct: sumShare(1),
    top10Pct: sumShare(10),
    top20Pct: sumShare(20),
    hhiTop20: hhi(top.map((a) => a.share)),
    caveat:
      'Based on the 20 largest token accounts (Solana RPC). Accounts can belong to liquidity pools, exchanges, ' +
      'vesting contracts or burn addresses, and one owner can hold several accounts — this is not a list of distinct holders.',
  };
}

export interface TokenIntelDeps {
  prices: PriceService;
  metadata: TokenMetadataService;
  rpc: SolanaRpcClient;
  gecko: GeckoTerminalClient;
}

export class TokenIntelService {
  private readonly reportCache = new TtlCache<TokenReport>(45_000, 500);
  private readonly candleCache = new TtlCache<Candle[]>(15 * 60_000, 500);
  private readonly concCache = new TtlCache<ConcentrationReport | null>(10 * 60_000, 200);

  constructor(private readonly d: TokenIntelDeps) {}

  async getCandles(pool: string): Promise<Candle[]> {
    return this.candleCache.getOrLoad(pool, () => this.d.gecko.getOhlcv(pool, 'day', 31));
  }

  async getReport(mint: string): Promise<TokenReport> {
    return this.reportCache.getOrLoad(mint, async () => {
      const [pairsR, metaR, mintR] = await Promise.allSettled([this.d.prices.getPairs(mint), this.d.metadata.get(mint), this.d.rpc.getMintInfo(mint)]);
      if (pairsR.status === 'rejected' && mintR.status === 'rejected') throw pairsR.reason;
      const pairs = pairsR.status === 'fulfilled' ? pairsR.value : [];
      const primary = pairs.filter((p) => p.baseToken.address === mint).sort((a, b) => liquidityOf(b) - liquidityOf(a))[0];
      let candles: Candle[] | null = null;
      if (primary) {
        try {
          candles = await this.getCandles(primary.pairAddress);
        } catch (err) {
          log.warn('candles unavailable', { mint, error: (err as Error).message });
        }
      }
      const report = assembleTokenReport({
        mint,
        pairs,
        meta: metaR.status === 'fulfilled' ? metaR.value : null,
        mintInfo: mintR.status === 'fulfilled' ? mintR.value : null,
        candles,
      });
      if (pairsR.status === 'rejected') report.warnings.unshift('Market data provider (DexScreener) is currently unavailable.');
      return report;
    });
  }

  async getConcentration(mint: string): Promise<ConcentrationReport | null> {
    return this.concCache.getOrLoad(mint, async () => {
      const [supply, largest] = await Promise.all([this.d.rpc.getTokenSupply(mint), this.d.rpc.getTokenLargestAccounts(mint)]);
      const owners = await this.d.rpc.getTokenAccountOwners(largest.slice(0, 20).map((a) => a.address)).catch(() => new Map<string, string>());
      return computeConcentration(mint, supply.uiAmount, largest, owners);
    });
  }
}
