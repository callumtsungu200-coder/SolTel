import type { Notifier } from '../alerts/notifier.js';
import type { WalletIntelService } from '../analytics/wallet.js';
import type { UsersRepo } from '../db/usersRepo.js';
import type { WalletsRepo } from '../db/walletsRepo.js';
import type { PriceQuote, PriceService } from '../services/prices.js';
import { escapeHtml, formatNumber, formatPct, formatUsd, link, shortAddr, solscanAccount } from '../utils/format.js';
import { createLogger } from '../utils/logger.js';
import { mapLimit } from './scheduler.js';

const log = createLogger('holdings-monitor');

export const SOL_KEY = 'SOL';

export interface HoldingChange {
  key: string;
  symbol: string;
  before: number;
  after: number;
  pct: number | null;
  kind: 'new' | 'removed' | 'changed';
  estUsd: number | null;
}

/**
 * Compares two {mint: amount} maps. Reports:
 *  - changed: |Δ| ≥ thresholdPct of the previous amount
 *  - new:     token appeared AND has a reliable price with ≥ $10 value
 *             (filters out the constant stream of spam airdrops)
 *  - removed: token disappeared and previously had ≥ $10 estimated value
 */
export function diffHoldings(
  prev: Record<string, number>,
  cur: Record<string, number>,
  thresholdPct: number,
  quotes: Map<string, PriceQuote>,
  symbols: Map<string, string>,
  solPrice: number | null,
): HoldingChange[] {
  const out: HoldingChange[] = [];
  const priceOf = (k: string) => (k === SOL_KEY ? solPrice : quotes.get(k)?.reliable ? quotes.get(k)!.priceUsd : null);
  for (const key of new Set([...Object.keys(prev), ...Object.keys(cur)])) {
    const before = prev[key] ?? 0;
    const after = cur[key] ?? 0;
    if (before === after) continue;
    const price = priceOf(key);
    const symbol = key === SOL_KEY ? 'SOL' : (symbols.get(key) ?? shortAddr(key));
    if (before === 0) {
      const usd = price !== null ? after * price : null;
      if (usd !== null && usd >= 10) out.push({ key, symbol, before, after, pct: null, kind: 'new', estUsd: usd });
      continue;
    }
    if (after === 0) {
      const usd = price !== null ? before * price : null;
      if (key === SOL_KEY || (usd !== null && usd >= 10)) out.push({ key, symbol, before, after, pct: -100, kind: 'removed', estUsd: usd });
      continue;
    }
    const pct = ((after - before) / before) * 100;
    if (Math.abs(pct) >= thresholdPct) {
      out.push({ key, symbol, before, after, pct, kind: 'changed', estUsd: price !== null ? Math.abs(after - before) * price : null });
    }
  }
  return out.sort((a, b) => (b.estUsd ?? 0) - (a.estUsd ?? 0));
}

export function formatHoldingChanges(label: string, address: string, changes: HoldingChange[]): string {
  const lines = [`📦 <b>Holdings changed: ${escapeHtml(label)}</b> (${shortAddr(address)})`];
  for (const c of changes.slice(0, 8)) {
    const usd = c.estUsd !== null ? ` (~${formatUsd(c.estUsd)})` : '';
    if (c.kind === 'new') lines.push(`🆕 ${escapeHtml(c.symbol)}: now holds ${formatNumber(c.after)}${usd}`);
    else if (c.kind === 'removed') lines.push(`🚫 ${escapeHtml(c.symbol)}: balance went to 0 (was ${formatNumber(c.before)})${usd}`);
    else lines.push(`${(c.pct ?? 0) > 0 ? '⬆️' : '⬇️'} ${escapeHtml(c.symbol)}: ${formatNumber(c.before)} → ${formatNumber(c.after)} (${formatPct(c.pct)})${usd}`);
  }
  if (changes.length > 8) lines.push(`…and ${changes.length - 8} more`);
  lines.push('<i>Balance changes can come from transfers, swaps, staking or airdrops; they are not necessarily trades. USD values are estimates at current prices.</i>');
  lines.push(link(solscanAccount(address), 'View wallet on Solscan'));
  return lines.join('\n');
}

export class HoldingsMonitor {
  constructor(
    private readonly wallets: WalletsRepo,
    private readonly users: UsersRepo,
    private readonly walletIntel: WalletIntelService,
    private readonly prices: PriceService,
    private readonly notifier: Notifier,
  ) {}

  async runOnce(): Promise<void> {
    const monitors = await this.wallets.listMonitors();
    await mapLimit(monitors, 2, async (m) => {
      try {
        await this.check(m.address, m.holdings_state);
      } catch (err) {
        log.warn('holdings check failed', { address: shortAddr(m.address), error: (err as Error).message });
      }
    });
  }

  async check(address: string, prevState: Record<string, number> | null): Promise<void> {
    const balances = await this.walletIntel.getBalances(address);
    const cur: Record<string, number> = { [SOL_KEY]: Number(balances.sol.toFixed(9)) };
    for (const t of balances.tokens) cur[t.mint] = t.amount;
    await this.wallets.setHoldingsState(address, cur);
    if (!prevState) return;

    const trackers = await this.wallets.trackersOf(address);
    if (trackers.length === 0) return;
    const changedMints = Object.keys({ ...prevState, ...cur }).filter((k) => k !== SOL_KEY && prevState[k] !== cur[k]);
    const quotes = changedMints.length ? await this.prices.getQuotes(changedMints.slice(0, 90)).catch(() => new Map<string, PriceQuote>()) : new Map<string, PriceQuote>();
    const solPrice = await this.prices.getSolPrice().catch(() => null);
    const symbols = new Map<string, string>();
    for (const t of balances.tokens) if (t.symbol) symbols.set(t.mint, t.symbol);
    for (const [m, q] of quotes) if (!symbols.has(m) && q.symbol) symbols.set(m, q.symbol);

    const prefsMap = await this.users.getPreferencesMany([...new Set(trackers.map((t) => t.userId))]);
    for (const tracker of trackers) {
      const prefs = prefsMap.get(tracker.userId);
      if (!prefs?.notify_holdings_changes) continue;
      const changes = diffHoldings(prevState, cur, prefs.holding_change_pct, quotes, symbols, solPrice);
      if (changes.length === 0) continue;
      const fingerprint = changes.map((c) => `${c.key}:${c.after.toPrecision(8)}`).join('|');
      await this.notifier.notify({
        userId: tracker.userId,
        telegramId: tracker.telegramId,
        kind: 'holdings_change',
        dedupeKey: `hold:${address}:${simpleHash(fingerprint)}`,
        text: formatHoldingChanges(tracker.label, address, changes),
        prefs,
      });
    }
  }
}

/** FNV-1a 32-bit hash — compact, stable dedupe keys. */
export function simpleHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
