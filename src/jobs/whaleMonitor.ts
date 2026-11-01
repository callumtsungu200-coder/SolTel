import { parseAlertParams } from '../alerts/definitions.js';
import type { Notifier } from '../alerts/notifier.js';
import type { HeliusClient } from '../clients/helius.js';
import type { AlertsRepo, ActiveAlert } from '../db/alertsRepo.js';
import type { MarketRepo } from '../db/marketRepo.js';
import type { WhaleEventRow } from '../db/types.js';
import type { PriceService } from '../services/prices.js';
import { normalizeParsedEvent, type NormalizedTx } from '../services/transactions.js';
import { escapeHtml, formatNumber, formatUsd, link, shortAddr, solscanTx } from '../utils/format.js';
import { createLogger } from '../utils/logger.js';
import { WSOL_MINT } from '../validation/address.js';
import { mapLimit } from './scheduler.js';

const log = createLogger('whale-monitor');

export interface WatchTarget {
  kind: 'token' | 'wallet';
  address: string;
  symbol: string;
  minUsd: number;
}

/**
 * Extracts large movements from normalised transactions. Pure.
 *
 * - token target: transfers of that mint valued ≥ minUsd at the current price
 * - wallet target: SOL or token transfers to/from that wallet valued ≥ minUsd
 *
 * event_kind is "swap" only when the provider classified the transaction as
 * a swap; otherwise it is a transfer. We never infer buy/sell direction.
 */
export function extractWhaleEvents(
  target: WatchTarget,
  txs: NormalizedTx[],
  solPrice: number | null,
  prices: Map<string, number>,
): WhaleEventRow[] {
  const out: WhaleEventRow[] = [];
  for (const tx of txs) {
    if (!tx.success) continue;
    const blockTime = tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : null;
    const swap = tx.type === 'SWAP';
    for (const t of tx.tokenTransfers) {
      if (target.kind === 'token' && t.mint !== target.address) continue;
      if (target.kind === 'wallet' && t.from !== target.address && t.to !== target.address) continue;
      const price = prices.get(t.mint);
      if (price === undefined) continue;
      const usd = t.amount * price;
      if (usd < target.minUsd) continue;
      out.push({
        signature: tx.signature,
        watched: target.address,
        watch_kind: target.kind,
        event_kind: swap ? 'swap' : 'token_transfer',
        mint: t.mint,
        amount: t.amount,
        usd_value: usd,
        from_addr: t.from,
        to_addr: t.to,
        block_time: blockTime,
      });
    }
    if (target.kind === 'wallet' && solPrice !== null) {
      for (const n of tx.nativeTransfers) {
        if (n.from !== target.address && n.to !== target.address) continue;
        const sol = n.lamports / 1e9;
        const usd = sol * solPrice;
        if (usd < target.minUsd) continue;
        out.push({
          signature: tx.signature,
          watched: target.address,
          watch_kind: 'wallet',
          event_kind: swap ? 'swap' : 'sol_transfer',
          mint: WSOL_MINT,
          amount: sol,
          usd_value: usd,
          from_addr: n.from,
          to_addr: n.to,
          block_time: blockTime,
        });
      }
    }
  }
  return out;
}

export function formatWhaleEvent(e: WhaleEventRow, symbol: string, label: string): string {
  const kind = e.event_kind === 'swap' ? '🔄 Large swap leg' : e.event_kind === 'sol_transfer' ? '💸 Large SOL transfer' : '💸 Large token transfer';
  return [
    `🐋 <b>${kind}</b> · ${escapeHtml(label)}`,
    `${formatNumber(e.amount)} ${escapeHtml(symbol)} (~${formatUsd(e.usd_value)})`,
    `From <code>${e.from_addr ? shortAddr(e.from_addr, 6) : 'unknown'}</code> → To <code>${e.to_addr ? shortAddr(e.to_addr, 6) : 'unknown'}</code>`,
    '<i>Value estimated at current price. A large transfer is not necessarily a purchase or sale.</i>',
    link(solscanTx(e.signature), 'View on Solscan'),
  ].join('\n');
}

/**
 * Polls large_transaction alert targets. Token targets are watched through
 * their deepest DEX pool (where trading activity happens); wallet targets
 * through their own history. Each poll samples the latest 100 transactions,
 * so on very busy pools some activity between polls can be missed — this is
 * a documented limitation of free-tier polling (full coverage needs a paid
 * streaming product).
 */
export class WhaleMonitor {
  constructor(
    private readonly helius: HeliusClient,
    private readonly prices: PriceService,
    private readonly alerts: AlertsRepo,
    private readonly market: MarketRepo,
    private readonly notifier: Notifier,
  ) {}

  async runOnce(): Promise<void> {
    const active = await this.alerts.listActive(['large_transaction']);
    if (active.length === 0) return;
    const groups = new Map<string, { target: WatchTarget; alerts: ActiveAlert[] }>();
    for (const a of active) {
      const p = parseAlertParams('large_transaction', a.params);
      if (!p) continue;
      const key = `${p.target}:${p.address}`;
      const g = groups.get(key) ?? { target: { kind: p.target, address: p.address, symbol: p.symbol, minUsd: p.minUsd }, alerts: [] };
      g.target.minUsd = Math.min(g.target.minUsd, p.minUsd);
      g.alerts.push(a);
      groups.set(key, g);
    }
    await mapLimit([...groups.values()], 2, async (g) => {
      try {
        await this.checkTarget(g.target, g.alerts);
      } catch (err) {
        log.warn('whale target failed', { target: shortAddr(g.target.address), error: (err as Error).message });
      }
    });
  }

  private async checkTarget(target: WatchTarget, alerts: ActiveAlert[]): Promise<void> {
    let historyAddress = target.address;
    if (target.kind === 'token') {
      const pairs = await this.prices.getPairs(target.address);
      const pool = pairs.filter((p) => p.baseToken.address === target.address).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (!pool) return;
      historyAddress = pool.pairAddress;
    }
    const page = await this.helius.getTransactionHistory(historyAddress, { limit: 100, tokenAccounts: target.kind === 'token' ? 'all' : 'balanceChanged' });
    const txs = page.items.map(normalizeParsedEvent);
    const mints = [...new Set(txs.flatMap((t) => t.tokenTransfers.map((x) => x.mint)))].slice(0, 90);
    const quotes = await this.prices.getQuotes([WSOL_MINT, ...mints]);
    const priceMap = new Map<string, number>();
    for (const [m, q] of quotes) if (q.reliable) priceMap.set(m, q.priceUsd);
    const solPrice = quotes.get(WSOL_MINT)?.priceUsd ?? null;

    const events = extractWhaleEvents(target, txs, solPrice, priceMap);
    const fresh = await this.market.insertWhaleEvents(events);
    if (fresh.length === 0) return;

    for (const a of alerts) {
      const p = parseAlertParams('large_transaction', a.params)!;
      let sent = 0;
      for (const e of fresh) {
        if ((e.usd_value ?? 0) < p.minUsd) continue;
        const symbol = e.mint === WSOL_MINT ? 'SOL' : (quotes.get(e.mint ?? '')?.symbol ?? shortAddr(e.mint ?? ''));
        const label = p.symbol || shortAddr(p.address);
        const r = await this.notifier.notify({
          userId: a.user_id,
          telegramId: a.telegramId,
          alertId: a.id,
          kind: 'large_transaction',
          dedupeKey: `whale:${e.signature}:${e.mint}:${e.from_addr}:${e.to_addr}`,
          text: formatWhaleEvent(e, symbol, label),
        });
        if (r === 'sent') sent++;
        if (sent >= 5) break; // cap per poll to avoid flooding on bursts
      }
      if (sent > 0) await this.alerts.saveState(a.id, a.state, true, a.trigger_count + sent);
    }
  }
}
