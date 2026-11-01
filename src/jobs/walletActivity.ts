import { parseAlertParams } from '../alerts/definitions.js';
import type { Notifier } from '../alerts/notifier.js';
import type { AlertsRepo, ActiveAlert } from '../db/alertsRepo.js';
import type { UsersRepo } from '../db/usersRepo.js';
import type { WalletsRepo } from '../db/walletsRepo.js';
import type { PreferencesRow, Tracker, WalletTransactionRow } from '../db/types.js';
import type { TokenMetadataService } from '../services/tokenMetadata.js';
import { symbolOf } from '../services/tokenMetadata.js';
import { categoryLabel, walletView, type NormalizedTx, type WalletTxView } from '../services/transactions.js';
import { escapeHtml, formatNumber, formatSol, link, relativeTime, shortAddr, solscanTx } from '../utils/format.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('wallet-activity');

export function toTxRow(v: WalletTxView): WalletTransactionRow {
  return {
    wallet_address: v.wallet,
    signature: v.tx.signature,
    slot: v.tx.slot || null,
    block_time: v.tx.timestamp ? new Date(v.tx.timestamp * 1000).toISOString() : null,
    tx_type: v.tx.type,
    source: v.tx.source,
    category: v.category,
    direction: v.direction,
    sol_change: Number(v.solNet.toFixed(9)),
    token_changes: [...v.tokensIn.map((t) => ({ mint: t.mint, amount: t.amount })), ...v.tokensOut.map((t) => ({ mint: t.mint, amount: -t.amount }))],
    description: v.tx.description?.slice(0, 500) ?? null,
    success: v.tx.success,
    provider: v.tx.provider,
  };
}

/**
 * Decides whether a tracker should be notified about a transaction.
 * Basic rule: per-wallet direction toggles + the user's global minimum SOL.
 * A matching `wallet_activity` alert with its own threshold also qualifies.
 */
export function shouldNotify(
  v: WalletTxView,
  tracker: Tracker,
  prefs: PreferencesRow,
  walletAlerts: ActiveAlert[],
): { notify: boolean; alertId: string | null } {
  if (v.direction === 'none' && v.category !== 'swap') return { notify: false, alertId: null };
  const solMoved = Math.max(v.solIn, v.solOut);
  for (const a of walletAlerts) {
    const p = parseAlertParams('wallet_activity', a.params);
    if (!p || p.walletId !== tracker.walletId || a.user_id !== tracker.userId) continue;
    const dirOk =
      p.direction === 'any' ||
      (p.direction === 'incoming' && (v.direction === 'incoming' || v.direction === 'mixed')) ||
      (p.direction === 'outgoing' && (v.direction === 'outgoing' || v.direction === 'mixed'));
    const amountOk = p.minSol <= 0 || solMoved >= p.minSol;
    if (dirOk && amountOk) return { notify: true, alertId: a.id };
  }
  if (!prefs.notify_wallet_activity) return { notify: false, alertId: null };
  const dirAllowed =
    (v.direction === 'incoming' && tracker.notifyIncoming) ||
    (v.direction === 'outgoing' && tracker.notifyOutgoing) ||
    ((v.direction === 'mixed' || v.category === 'swap') && (tracker.notifyIncoming || tracker.notifyOutgoing));
  if (!dirAllowed) return { notify: false, alertId: null };
  // Token-only movements have no SOL amount; the SOL threshold applies only to SOL movements.
  const tokenOnly = solMoved === 0 && (v.tokensIn.length > 0 || v.tokensOut.length > 0);
  if (!tokenOnly && solMoved < prefs.min_notify_sol) return { notify: false, alertId: null };
  return { notify: true, alertId: null };
}

export function formatActivityMessage(v: WalletTxView, label: string, symbols: Map<string, string>, viaAlert: boolean): string {
  const lines = [
    `${viaAlert ? '🔔 <b>Alert</b> · ' : ''}<b>${escapeHtml(label)}</b> (${shortAddr(v.wallet)})`,
    `${categoryLabel(v)} · ${relativeTime(v.tx.timestamp)}`,
  ];
  if (v.solIn > 0) lines.push(`➕ ${formatSol(v.solIn)} received`);
  if (v.solOut > 0) lines.push(`➖ ${formatSol(v.solOut)} sent`);
  for (const t of v.tokensIn.slice(0, 4)) lines.push(`➕ ${formatNumber(t.amount)} ${escapeHtml(symbols.get(t.mint) ?? shortAddr(t.mint))}`);
  for (const t of v.tokensOut.slice(0, 4)) lines.push(`➖ ${formatNumber(t.amount)} ${escapeHtml(symbols.get(t.mint) ?? shortAddr(t.mint))}`);
  if (v.counterparties.length && v.category === 'transfer') lines.push(`Counterparty: <code>${shortAddr(v.counterparties[0]!, 6)}</code>`);
  if (v.tx.source) lines.push(`Via: ${escapeHtml(v.tx.source)}`);
  if (v.tx.description) lines.push(`<i>${escapeHtml(v.tx.description.slice(0, 200))}</i>`);
  lines.push(link(solscanTx(v.tx.signature), 'View on Solscan'));
  return lines.join('\n');
}

/**
 * Shared pipeline for new transactions of monitored addresses, used by both
 * the Helius webhook receiver and the polling fallback:
 *   normalise → store (dedupe on (address, signature)) → notify trackers.
 */
export class WalletActivityProcessor {
  constructor(
    private readonly wallets: WalletsRepo,
    private readonly alerts: AlertsRepo,
    private readonly users: UsersRepo,
    private readonly notifier: Notifier,
    private readonly metadata: TokenMetadataService,
  ) {}

  async process(address: string, txs: NormalizedTx[]): Promise<number> {
    if (txs.length === 0) return 0;
    const views = txs.map((t) => walletView(t, address));
    const inserted = await this.wallets.insertTransactions(views.map(toTxRow));
    if (inserted.length === 0) return 0;
    const newSigs = new Set(inserted.map((r) => r.signature));
    const fresh = views.filter((v) => newSigs.has(v.tx.signature)).sort((a, b) => (a.tx.timestamp ?? 0) - (b.tx.timestamp ?? 0));

    const trackers = await this.wallets.trackersOf(address);
    if (trackers.length === 0) return 0;
    const [prefsMap, walletAlerts] = await Promise.all([
      this.users.getPreferencesMany([...new Set(trackers.map((t) => t.userId))]),
      this.alerts.listActive(['wallet_activity']),
    ]);
    const mints = [...new Set(fresh.flatMap((v) => [...v.tokensIn, ...v.tokensOut].map((t) => t.mint)))];
    const meta = mints.length ? await this.metadata.getMany(mints) : new Map();
    const symbols = new Map(mints.map((m) => [m, symbolOf(meta, m)]));

    let sent = 0;
    for (const v of fresh) {
      for (const tracker of trackers) {
        const prefs = prefsMap.get(tracker.userId);
        if (!prefs) continue;
        const decision = shouldNotify(v, tracker, prefs, walletAlerts);
        if (!decision.notify) continue;
        const result = await this.notifier.notify({
          userId: tracker.userId,
          telegramId: tracker.telegramId,
          alertId: decision.alertId,
          kind: decision.alertId ? 'wallet_activity' : 'tracked_wallet',
          // Same key for alert and basic notifications → one message per tx per user.
          dedupeKey: `tx:${address}:${v.tx.signature}`,
          text: formatActivityMessage(v, tracker.label, symbols, decision.alertId !== null),
          prefs,
        });
        if (result === 'sent') sent++;
        if (result === 'sent' && decision.alertId) {
          const a = walletAlerts.find((x) => x.id === decision.alertId);
          if (a) {
            a.trigger_count += 1;
            await this.alerts.saveState(a.id, a.state, true, a.trigger_count).catch(() => undefined);
          }
        }
      }
    }
    log.info('processed wallet activity', { address: shortAddr(address), newTx: fresh.length, sent });
    return sent;
  }
}
