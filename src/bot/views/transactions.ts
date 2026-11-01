import { InlineKeyboard } from 'grammy';
import type { WhaleEventRow } from '../../db/types.js';
import type { NormalizedTx, WalletTxView } from '../../services/transactions.js';
import {
  code,
  escapeHtml,
  formatDate,
  formatNumber,
  formatSol,
  formatUsd,
  link,
  relativeTime,
  shortAddr,
  solscanTx,
} from '../../utils/format.js';
import { WSOL_MINT } from '../../validation/address.js';
import { addPager, paginate, withNav } from '../keyboards.js';
import type { View } from '../render.js';
import { txBlock, type SymbolLookup } from './common.js';

export function txMonitorMenuView(useWebhooks: boolean): View {
  const kb = new InlineKeyboard()
    .text('🔎 Look up a transaction', 'txm:look')
    .row()
    .text('📜 Tracked wallets feed', 'txm:feed:0')
    .row()
    .text('🐋 Whale activity', 'txm:wh:0')
    .text('➕ Watch for whales', 'txm:wadd')
    .row()
    .text('🎚 Whale threshold', 'set:whale');
  return {
    text:
      '🧾 <b>Transaction Monitor</b>\n\n' +
      '• Look up any transaction signature\n' +
      '• Readable feed of your tracked wallets\n' +
      '• Whale monitor: large transfers/swaps for tokens and wallets you watch\n\n' +
      `Monitoring mode: <b>${useWebhooks ? 'Helius webhooks (real-time)' : 'polling'}</b>`,
    keyboard: withNav(kb),
  };
}

export function txDetailView(tx: NormalizedTx, sym: SymbolLookup): View {
  const lines = [
    '🧾 <b>Transaction</b>',
    code(tx.signature),
    '',
    `Status: ${tx.success ? '✅ success' : `❌ failed${tx.errorText ? ` (${escapeHtml(tx.errorText)})` : ''}`}`,
    `Time: ${formatDate(tx.timestamp)} (${relativeTime(tx.timestamp)})`,
    `Slot: ${tx.slot.toLocaleString('en-US')} · Fee: ${formatSol(tx.fee / 1e9, 9)}`,
    `Fee payer: ${tx.feePayer ? code(tx.feePayer) : 'unknown'}`,
    `Type: ${escapeHtml(tx.type)}${tx.source ? ` · via ${escapeHtml(tx.source)}` : ''}`,
  ];
  if (tx.description) lines.push(`<i>${escapeHtml(tx.description)}</i>`);
  if (tx.nativeTransfers.length) {
    lines.push('', '<b>SOL transfers</b>');
    for (const t of tx.nativeTransfers.slice(0, 12)) {
      lines.push(`• ${formatSol(t.lamports / 1e9)}: ${t.from ? code(shortAddr(t.from, 6)) : '?'} → ${t.to ? code(shortAddr(t.to, 6)) : '?'}`);
    }
    if (tx.nativeTransfers.length > 12) lines.push(`…${tx.nativeTransfers.length - 12} more`);
  }
  if (tx.tokenTransfers.length) {
    lines.push('', '<b>Token transfers</b>');
    for (const t of tx.tokenTransfers.slice(0, 12)) {
      lines.push(`• ${formatNumber(t.amount)} ${escapeHtml(sym(t.mint))}: ${t.from ? code(shortAddr(t.from, 6)) : '?'} → ${t.to ? code(shortAddr(t.to, 6)) : '?'}`);
    }
    if (tx.tokenTransfers.length > 12) lines.push(`…${tx.tokenTransfers.length - 12} more`);
  }
  if (tx.provider === 'rpc') {
    lines.push('', '<b>Balance changes</b> (raw RPC)');
    for (const c of (tx.nativeChanges ?? []).slice(0, 8)) lines.push(`• ${code(shortAddr(c.account, 6))}: ${c.lamports > 0 ? '+' : ''}${formatSol(c.lamports / 1e9, 9)}`);
    for (const c of (tx.tokenChanges ?? []).slice(0, 8)) lines.push(`• ${code(shortAddr(c.owner, 6))}: ${c.amount > 0 ? '+' : ''}${formatNumber(c.amount)} ${escapeHtml(sym(c.mint))}`);
    lines.push('<i>Helius parsing unavailable — showing raw balance deltas without classification.</i>');
  }
  const kb = new InlineKeyboard().url('🔗 Solscan', solscanTx(tx.signature));
  if (tx.feePayer) kb.row().text('👛 Fee payer profile', `wal:p:${tx.feePayer}`);
  return { text: lines.join('\n'), keyboard: withNav(kb, 'txm') };
}

export function feedView(items: Array<{ view: WalletTxView; label: string }>, page: number, pageSize: number, sym: SymbolLookup, walletCount: number): View {
  const pg = paginate(items, page, pageSize);
  const lines = [`📜 <b>Tracked wallets feed</b>`, `<i>Latest transactions across ${walletCount} tracked wallet(s), newest first.</i>`, ''];
  if (walletCount === 0) lines.push('You are not tracking any wallets yet. Add one from ⭐ Watchlists.');
  else if (pg.items.length === 0) lines.push('No recent transactions.');
  pg.items.forEach((it, i) => lines.push(`<b>${escapeHtml(it.label)}</b> (${shortAddr(it.view.wallet)})`, txBlock(it.view, sym, pg.page * pageSize + i + 1), ''));
  const kb = addPager(new InlineKeyboard(), 'txm:feed:', pg.page, pg.totalPages);
  kb.row().text('🔄 Refresh', `txm:feed:${pg.page}`);
  return { text: lines.join('\n'), keyboard: withNav(kb, 'txm') };
}

export interface WhaleTargetInfo {
  address: string;
  kind: 'token' | 'wallet';
  label: string;
}

export function whaleEventsView(
  events: WhaleEventRow[],
  page: number,
  hasMore: boolean,
  targets: WhaleTargetInfo[],
  filter: string | null,
  symbols: Map<string, string>,
): View {
  const filterLabel = filter ? (targets.find((t) => t.address === filter)?.label ?? shortAddr(filter)) : null;
  const lines = [`🐋 <b>Whale activity</b>${filterLabel ? ` · ${escapeHtml(filterLabel)}` : ''}`];
  if (targets.length === 0) {
    lines.push('', 'You are not watching any tokens or wallets for large transactions yet. Tap ➕ Watch for whales.');
  } else {
    lines.push(`<i>Large transfers/swap legs for your ${targets.length} watched target(s). Values at the price when detected 📐.</i>`, '');
    if (events.length === 0) lines.push('No large transactions recorded yet. The monitor checks periodically.');
    for (const e of events) {
      const sym = e.mint === WSOL_MINT ? 'SOL' : (symbols.get(e.mint ?? '') ?? shortAddr(e.mint ?? ''));
      const kind = e.event_kind === 'swap' ? '🔄 swap leg' : '💸 transfer';
      lines.push(
        `${kind} · ${formatNumber(e.amount)} ${escapeHtml(sym)} (~${formatUsd(e.usd_value)}) · ${relativeTime(e.block_time ? Date.parse(e.block_time) / 1000 : null)}`,
        `   ${e.from_addr ? code(shortAddr(e.from_addr, 5)) : '?'} → ${e.to_addr ? code(shortAddr(e.to_addr, 5)) : '?'} ${link(solscanTx(e.signature), '↗')}`,
      );
    }
    lines.push('', '<i>A large transfer is not necessarily a purchase or sale.</i>');
  }
  const kb = new InlineKeyboard();
  const prefix = filter ? `txm:wf:${filter}:` : 'txm:wh:';
  if (page > 0) kb.text('◀️', `${prefix}${page - 1}`);
  if (page > 0 || hasMore) kb.text(`${page + 1}`, 'noop');
  if (hasMore) kb.text('▶️', `${prefix}${page + 1}`);
  kb.row();
  targets.slice(0, 6).forEach((t, i) => {
    kb.text(`${t.kind === 'token' ? '🪙' : '👛'} ${t.label.slice(0, 12)}`, `txm:wf:${t.address}:0`);
    if (i % 2 === 1) kb.row();
  });
  kb.row();
  if (filter) kb.text('🌐 All targets', 'txm:wh:0');
  kb.text('🔎 Filter by address', 'txm:wfa').row().text('➕ Watch for whales', 'txm:wadd');
  return { text: lines.join('\n'), keyboard: withNav(kb, 'txm') };
}

export function whaleAddView(thresholdUsd: number): View {
  return {
    text:
      '➕ <b>Watch for whale activity</b>\n\n' +
      `Choose what to watch. Default threshold: ${formatUsd(thresholdUsd)} (change it in Settings → Whale threshold).\n\n` +
      '• <b>Token</b>: large transfers and swap legs in the token’s deepest DEX pool\n' +
      '• <b>Wallet</b>: large SOL/token transfers to or from a wallet',
    keyboard: withNav(new InlineKeyboard().text('🪙 Token', 'txm:wadd:t').text('👛 Wallet', 'txm:wadd:w'), 'txm'),
  };
}
