import type { HeliusClient } from '../clients/helius.js';
import type { SolanaRpcClient } from '../clients/solanaRpc.js';
import type { PriceService } from '../services/prices.js';
import type { TokenMetadataService, TokenMeta } from '../services/tokenMetadata.js';
import { normalizeParsedEvent, walletView, type WalletTxView } from '../services/transactions.js';
import { TtlCache } from '../utils/cache.js';
import { LAMPORTS_PER_SOL } from '../utils/format.js';
import { createLogger } from '../utils/logger.js';
import { WSOL_MINT } from '../validation/address.js';
import { analyzePatterns, type PatternSummary } from './patterns.js';
import { priceHoldings, summarize, type Holding, type PortfolioSummary, type RawBalance } from './portfolio.js';
import { computeActivityScore, type ActivityScore } from './walletScore.js';

const log = createLogger('wallet-intel');

export interface WalletAge {
  firstSeen: number | null;
  /** True when the full signature history was scanned, so `firstSeen` is the actual first activity. */
  exact: boolean;
  signatureCount: number;
  countExact: boolean;
}

export interface Acquisition {
  mint: string;
  firstSeen: number | null;
  amount: number;
  via: 'transfer' | 'swap' | 'other';
  signature: string;
}

export interface TimelineEvent {
  timestamp: number | null;
  signature: string;
  view: WalletTxView;
  reason: string;
  estUsd: number | null;
}

export interface ActivityStats {
  windowTxCount: number;
  windowStart: number | null;
  windowEnd: number | null;
  txPerDay: number;
  solIn: number;
  solOut: number;
  feesSol: number;
  swaps: number;
  transfersIn: number;
  transfersOut: number;
  failed: number;
  other: number;
  uniqueCounterparties: number;
  distinctMints: number;
}

export interface WalletProfile {
  address: string;
  fetchedAt: number;
  accountExists: boolean;
  isProgram: boolean;
  solBalance: number;
  holdings: Holding[];
  nftCount: number;
  holdingsTruncated: boolean;
  portfolio: PortfolioSummary;
  views: WalletTxView[];
  historyComplete: boolean;
  stats: ActivityStats;
  age: WalletAge | null;
  acquisitions: Acquisition[];
  timeline: TimelineEvent[];
  patterns: PatternSummary;
  score: ActivityScore;
  meta: Map<string, TokenMeta>;
  warnings: string[];
}

const FUNGIBLE_INTERFACES = new Set(['FungibleToken', 'FungibleAsset']);

/** Scans signature history backwards (1000 per page) to establish age and tx count. */
export async function scanSignatureHistory(rpc: SolanaRpcClient, address: string, maxPages: number): Promise<WalletAge> {
  let before: string | undefined;
  let count = 0;
  let oldest: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const sigs = await rpc.getSignaturesForAddress(address, { before, limit: 1000 });
    count += sigs.length;
    const last = sigs[sigs.length - 1];
    if (last?.blockTime) oldest = last.blockTime;
    if (sigs.length < 1000) return { firstSeen: oldest, exact: true, signatureCount: count, countExact: true };
    before = last?.signature;
  }
  return { firstSeen: oldest, exact: false, signatureCount: count, countExact: false };
}

export function computeStats(views: WalletTxView[]): ActivityStats {
  const times = views.map((v) => v.tx.timestamp).filter((t): t is number => t !== null);
  const start = times.length ? Math.min(...times) : null;
  const end = times.length ? Math.max(...times) : null;
  const spanDays = start !== null && end !== null ? Math.max((end - start) / 86400, 1 / 24) : null;
  const cps = new Set<string>();
  const mints = new Set<string>();
  const s: ActivityStats = {
    windowTxCount: views.length,
    windowStart: start,
    windowEnd: end,
    txPerDay: spanDays ? views.length / Math.max(spanDays, 1) : 0,
    solIn: 0,
    solOut: 0,
    feesSol: 0,
    swaps: 0,
    transfersIn: 0,
    transfersOut: 0,
    failed: 0,
    other: 0,
    uniqueCounterparties: 0,
    distinctMints: 0,
  };
  for (const v of views) {
    s.solIn += v.solIn;
    s.solOut += v.solOut;
    s.feesSol += v.feePaidSol;
    if (v.category === 'swap') s.swaps++;
    else if (v.category === 'failed') s.failed++;
    else if (v.category === 'transfer' && v.direction === 'incoming') s.transfersIn++;
    else if (v.category === 'transfer' && v.direction === 'outgoing') s.transfersOut++;
    else s.other++;
    v.counterparties.forEach((c) => cps.add(c));
    [...v.tokensIn, ...v.tokensOut].forEach((t) => mints.add(t.mint));
  }
  s.uniqueCounterparties = cps.size;
  s.distinctMints = mints.size;
  return s;
}

/** First observed inbound movement of each token within the fetched window (oldest first). */
export function computeAcquisitions(views: WalletTxView[]): Acquisition[] {
  const seen = new Map<string, Acquisition>();
  const chronological = [...views].sort((a, b) => (a.tx.timestamp ?? 0) - (b.tx.timestamp ?? 0));
  for (const v of chronological) {
    if (v.category === 'failed') continue;
    for (const t of v.tokensIn) {
      if (t.mint === WSOL_MINT || seen.has(t.mint)) continue;
      seen.set(t.mint, {
        mint: t.mint,
        firstSeen: v.tx.timestamp,
        amount: t.amount,
        via: v.category === 'swap' ? 'swap' : v.category === 'transfer' ? 'transfer' : 'other',
        signature: v.tx.signature,
      });
    }
  }
  return [...seen.values()];
}

export function estimateUsd(v: WalletTxView, solPrice: number | null, prices: Map<string, number>): number | null {
  let total = 0;
  let any = false;
  const sol = Math.max(v.solIn, v.solOut);
  if (sol > 0 && solPrice !== null) {
    total += sol * solPrice;
    any = true;
  }
  // For swaps count one side only (the larger) to avoid double counting.
  const tokenValues = [...v.tokensIn, ...v.tokensOut].map((t) => (prices.has(t.mint) ? t.amount * prices.get(t.mint)! : null));
  const known = tokenValues.filter((x): x is number => x !== null);
  if (known.length) {
    total = Math.max(total, ...known);
    any = true;
  }
  return any ? total : null;
}

export function buildTimeline(views: WalletTxView[], acquisitions: Acquisition[], solPrice: number | null, prices: Map<string, number>, max = 15): TimelineEvent[] {
  const firstSeenSigs = new Set(acquisitions.map((a) => a.signature));
  const events: TimelineEvent[] = [];
  for (const v of views) {
    const estUsd = estimateUsd(v, solPrice, prices);
    const reasons: string[] = [];
    if (v.category === 'swap') reasons.push('swap');
    if (Math.max(v.solIn, v.solOut) >= 1) reasons.push('≥1 SOL moved');
    if (estUsd !== null && estUsd >= 100) reasons.push('≥$100 est. value');
    if (firstSeenSigs.has(v.tx.signature)) reasons.push('first observed receipt of a token');
    if (reasons.length) events.push({ timestamp: v.tx.timestamp, signature: v.tx.signature, view: v, reason: reasons.join(', '), estUsd });
  }
  return events
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, max)
    .reverse();
}

export interface WalletIntelDeps {
  rpc: SolanaRpcClient;
  helius: HeliusClient;
  prices: PriceService;
  metadata: TokenMetadataService;
  historyMaxPages: number;
}

export class WalletIntelService {
  private readonly cache = new TtlCache<WalletProfile>(90_000, 500);
  private readonly historyCache = new TtlCache<WalletTxView[]>(60_000, 500);

  constructor(private readonly d: WalletIntelDeps) {}

  /** Recent wallet-relative transactions (Helius Parsed Events). */
  async getRecentActivity(address: string, limit = 100): Promise<WalletTxView[]> {
    return this.historyCache.getOrLoad(`${address}:${limit}`, async () => {
      const page = await this.d.helius.getTransactionHistory(address, { limit });
      return page.items.map((i) => walletView(normalizeParsedEvent(i), address));
    });
  }

  /** Current balances: DAS first, falling back to plain RPC token accounts. */
  async getBalances(address: string): Promise<{ sol: number; tokens: RawBalance[]; nftCount: number; truncated: boolean; warnings: string[] }> {
    const warnings: string[] = [];
    const solLamports = await this.d.rpc.getBalance(address);
    try {
      const assets = await this.d.helius.getAssetsByOwner(address);
      const tokens: RawBalance[] = [];
      let nftCount = 0;
      for (const a of assets.items) {
        const ti = a.token_info;
        const isFungible = FUNGIBLE_INTERFACES.has(a.interface ?? '') || (ti?.decimals !== undefined && ti.decimals > 0);
        if (!isFungible) {
          nftCount++;
          continue;
        }
        if (!ti?.balance || ti.decimals === undefined) continue;
        tokens.push({
          mint: a.id,
          amount: ti.balance / 10 ** ti.decimals,
          decimals: ti.decimals,
          symbol: a.content?.metadata?.symbol || ti.symbol || null,
          name: a.content?.metadata?.name || null,
          heliusPriceUsd: ti.price_info?.price_per_token ?? null,
        });
      }
      if (assets.truncated) warnings.push('Wallet holds more than 3,000 assets; only the first 3,000 were analysed.');
      return { sol: solLamports / LAMPORTS_PER_SOL, tokens, nftCount, truncated: assets.truncated, warnings };
    } catch (err) {
      log.warn('DAS failed; falling back to RPC token accounts', { error: (err as Error).message });
      warnings.push('Helius DAS unavailable — holdings loaded from raw token accounts (no NFT breakdown).');
      const accounts = await this.d.rpc.getTokenAccountsByOwner(address);
      const byMint = new Map<string, RawBalance>();
      for (const a of accounts) {
        if (a.uiAmount <= 0) continue;
        const cur = byMint.get(a.mint) ?? { mint: a.mint, amount: 0, decimals: a.decimals };
        cur.amount += a.uiAmount;
        byMint.set(a.mint, cur);
      }
      const decimalsZero = [...byMint.values()].filter((b) => b.decimals === 0).length;
      const tokens = [...byMint.values()].filter((b) => b.decimals > 0);
      const meta = await this.d.metadata.getMany(tokens.map((t) => t.mint));
      for (const t of tokens) {
        t.symbol = meta.get(t.mint)?.symbol ?? null;
        t.name = meta.get(t.mint)?.name ?? null;
      }
      return { sol: solLamports / LAMPORTS_PER_SOL, tokens, nftCount: decimalsZero, truncated: false, warnings };
    }
  }

  async getProfile(address: string, opts: { fresh?: boolean } = {}): Promise<WalletProfile> {
    if (opts.fresh) this.cache.delete(address);
    return this.cache.getOrLoad(address, () => this.buildProfile(address));
  }

  private async buildProfile(address: string): Promise<WalletProfile> {
    const warnings: string[] = [];
    const [accountR, balancesR, historyR, ageR] = await Promise.allSettled([
      this.d.rpc.getAccountBasics(address),
      this.getBalances(address),
      this.getRecentActivity(address, 100),
      scanSignatureHistory(this.d.rpc, address, this.d.historyMaxPages),
    ]);
    // Balance is the one piece of data we cannot present a profile without.
    if (balancesR.status === 'rejected') throw balancesR.reason;
    const balances = balancesR.value;
    warnings.push(...balances.warnings);

    const account = accountR.status === 'fulfilled' ? accountR.value : null;
    let views: WalletTxView[] = [];
    if (historyR.status === 'fulfilled') views = historyR.value;
    else warnings.push('Transaction history is temporarily unavailable (Helius Parsed Events).');
    const age = ageR.status === 'fulfilled' ? ageR.value : null;
    if (!age) warnings.push('Wallet age/transaction count could not be determined (RPC unavailable).');

    // Price current holdings plus any token that moved in the window (for timeline estimates).
    const topHoldingMints = [...balances.tokens].sort((a, b) => b.amount - a.amount).slice(0, 120).map((t) => t.mint);
    const movedMints = [...new Set(views.flatMap((v) => [...v.tokensIn, ...v.tokensOut].map((t) => t.mint)))].slice(0, 60);
    let quotes = new Map<string, import('../services/prices.js').PriceQuote>();
    let solPrice: number | null = null;
    try {
      quotes = await this.d.prices.getQuotes([WSOL_MINT, ...topHoldingMints, ...movedMints]);
      solPrice = quotes.get(WSOL_MINT)?.priceUsd ?? null;
    } catch (err) {
      warnings.push('Market prices unavailable (DexScreener) — values could not be estimated.');
      log.warn('pricing failed', { error: (err as Error).message });
    }
    const holdings = priceHoldings(balances.tokens, quotes);
    const portfolio = summarize(balances.sol, solPrice, holdings);

    const priceMap = new Map<string, number>();
    for (const [m, q] of quotes) if (q.reliable) priceMap.set(m, q.priceUsd);
    const meta = await this.d.metadata.getMany([...new Set([...movedMints, ...holdings.slice(0, 30).map((h) => h.mint)])]);
    for (const h of holdings) {
      const m = meta.get(h.mint);
      if (m?.symbol && h.symbol.endsWith('…')) h.symbol = m.symbol;
    }

    const stats = computeStats(views);
    const acquisitions = computeAcquisitions(views);
    const timeline = buildTimeline(views, acquisitions, solPrice, priceMap);
    const patterns = analyzePatterns(views);
    const nowSec = Date.now() / 1000;
    const lastTx = stats.windowEnd;
    const ageDays = age?.firstSeen ? (nowSec - age.firstSeen) / 86400 : null;
    const score = computeActivityScore({
      txPerDay: stats.txPerDay,
      hoursSinceLastTx: lastTx ? (nowSec - lastTx) / 3600 : null,
      uniqueCounterparties: stats.uniqueCounterparties,
      distinctMints: stats.distinctMints,
      ageDays,
    });

    return {
      address,
      fetchedAt: Date.now(),
      accountExists: account !== null || balances.sol > 0 || balances.tokens.length > 0,
      isProgram: account?.executable ?? false,
      solBalance: balances.sol,
      holdings,
      nftCount: balances.nftCount,
      holdingsTruncated: balances.truncated,
      portfolio,
      views,
      historyComplete: views.length < 100,
      stats,
      age,
      acquisitions,
      timeline,
      patterns,
      score,
      meta,
      warnings,
    };
  }
}
