import { InlineKeyboard } from 'grammy';
import type { TrackedWalletRow, WalletTransactionRow, WatchlistRow } from '../../db/types.js';
import type { PriceQuote } from '../../services/prices.js';
import { code, escapeHtml, formatDate, formatNumber, formatPct, formatPrice, formatSol, formatUsd, link, shortAddr, solscanTx } from '../../utils/format.js';
import { addPager, paginate, withNav } from '../keyboards.js';
import type { View } from '../render.js';

export function watchlistsMenuView(walletCount: number, tokenCount: number): View {
  return {
    text: `⭐ <b>Watchlists</b>\n\n👛 Tracked wallets: ${walletCount}\n🪙 Watched tokens: ${tokenCount}\n\nTracked wallets are monitored for new activity and holding changes; you get notified based on your settings.`,
    keyboard: withNav(new InlineKeyboard().text('👛 Tracked wallets', 'wls:w:0').text('🪙 Token watchlist', 'wls:t:0')),
  };
}

export function trackedWalletsView(rows: TrackedWalletRow[], page: number, pageSize: number, max: number): View {
  const pg = paginate(rows, page, pageSize * 2);
  const lines = [`👛 <b>Tracked wallets</b> (${rows.length}/${max})`, ''];
  if (rows.length === 0) lines.push('No tracked wallets yet. Tap ➕ Add wallet or send /track &lt;address&gt; [label].');
  pg.items.forEach((w, i) => {
    const flags = `${w.notify_incoming ? '📥' : ''}${w.notify_outgoing ? '📤' : ''}` || '🔕';
    lines.push(`${pg.page * pageSize * 2 + i + 1}. <b>${escapeHtml(w.label)}</b> ${flags}\n   ${code(w.address)}`);
  });
  const kb = new InlineKeyboard();
  pg.items.forEach((w, i) => {
    kb.text(w.label.slice(0, 18), `wls:wv:${w.id}`);
    if (i % 2 === 1) kb.row();
  });
  addPager(kb, 'wls:w:', pg.page, pg.totalPages);
  kb.row().text('➕ Add wallet', 'wls:wadd');
  return { text: lines.join('\n'), keyboard: withNav(kb, 'wls') };
}

export function trackedWalletView(w: TrackedWalletRow): View {
  const kb = new InlineKeyboard()
    .text('👛 Profile', `wal:p:${w.address}`)
    .text('🧾 Recent activity', `wls:wa:${w.id}:0`)
    .row()
    .text('📊 Portfolio', `pf:v:${w.id}`)
    .text('✏️ Rename', `wls:wrn:${w.id}`)
    .row()
    .text(`${w.notify_incoming ? '✅' : '⬜'} Incoming`, `wls:win:${w.id}`)
    .text(`${w.notify_outgoing ? '✅' : '⬜'} Outgoing`, `wls:wout:${w.id}`)
    .row()
    .text('🔔 Activity alert', `al:nw:${w.id}`)
    .text('🗑 Remove', `wls:wrm:${w.id}`);
  return {
    text:
      `👛 <b>${escapeHtml(w.label)}</b>\n${code(w.address)}\n\n` +
      `Notifications: incoming ${w.notify_incoming ? 'on' : 'off'} · outgoing ${w.notify_outgoing ? 'on' : 'off'}\n` +
      `Tracking since ${formatDate(Date.parse(w.created_at) / 1000)}`,
    keyboard: withNav(kb, 'wls:w:0'),
  };
}

export function confirmRemoveWalletView(w: TrackedWalletRow): View {
  return {
    text: `Remove <b>${escapeHtml(w.label)}</b> (${shortAddr(w.address)}) from tracking? Alerts tied to this wallet will stop matching.`,
    keyboard: new InlineKeyboard().text('🗑 Yes, remove', `wls:wrmy:${w.id}`).text('Cancel', `wls:wv:${w.id}`),
  };
}

export function storedActivityView(w: TrackedWalletRow, rows: WalletTransactionRow[], page: number, hasMore: boolean, symbols: Map<string, string>): View {
  const lines = [`🧾 <b>Observed activity</b> · ${escapeHtml(w.label)}`, '<i>Transactions recorded by the monitor since tracking began.</i>', ''];
  if (rows.length === 0) lines.push('No activity recorded yet. New transactions appear here once detected. For full history open the wallet profile.');
  for (const r of rows) {
    const tokenText = r.token_changes
      .slice(0, 3)
      .map((t) => `${t.amount > 0 ? '+' : ''}${formatNumber(t.amount)} ${escapeHtml(symbols.get(t.mint) ?? shortAddr(t.mint))}`)
      .join(' · ');
    const sol = Number(r.sol_change);
    lines.push(
      `• ${r.category === 'swap' ? '🔄 Swap' : r.category === 'transfer' ? (r.direction === 'incoming' ? '📥 Transfer in' : '📤 Transfer out') : r.category === 'failed' ? '❌ Failed' : '⚙️ Other'} · ${formatDate(r.block_time ? Date.parse(r.block_time) / 1000 : null)}`,
      `   net ${sol > 0 ? '+' : ''}${formatSol(sol)}${tokenText ? ` · ${tokenText}` : ''} ${link(solscanTx(r.signature), '↗')}`,
    );
  }
  const kb = new InlineKeyboard();
  if (page > 0) kb.text('◀️', `wls:wa:${w.id}:${page - 1}`);
  if (hasMore) kb.text('▶️', `wls:wa:${w.id}:${page + 1}`);
  kb.row().text('🧾 Full history (live)', `wal:t:${w.address}:0`);
  return { text: lines.join('\n'), keyboard: withNav(kb, `wls:wv:${w.id}`) };
}

export function tokenWatchlistView(rows: WatchlistRow[], quotes: Map<string, PriceQuote & { change24h?: number | null }>, page: number, pageSize: number): View {
  const pg = paginate(rows, page, pageSize * 2);
  const lines = [`🪙 <b>Token watchlist</b> (${rows.length})`, ''];
  if (rows.length === 0) lines.push('No tokens yet. Tap ➕ Add token or send /watch &lt;mint&gt;.');
  pg.items.forEach((r, i) => {
    const q = quotes.get(r.mint);
    const name = r.label || q?.symbol || shortAddr(r.mint);
    lines.push(
      `${pg.page * pageSize * 2 + i + 1}. <b>${escapeHtml(name)}</b> ${q ? `${formatPrice(q.priceUsd)} · 24h ${formatPct(q.change24h ?? null)} · liq ${formatUsd(q.liquidityUsd)}` : 'no market data ❔'}`,
    );
  });
  lines.push('', '<i>Prices: DexScreener 📈</i>');
  const kb = new InlineKeyboard();
  pg.items.forEach((r, i) => {
    const q = quotes.get(r.mint);
    kb.text(`🔎 ${(r.label || q?.symbol || shortAddr(r.mint)).slice(0, 10)}`, `tok:p:${r.mint}`).text('🗑', `wls:trm:${r.id}`);
    if (i % 2 === 1) kb.row();
  });
  addPager(kb, 'wls:t:', pg.page, pg.totalPages);
  kb.row().text('➕ Add token', 'wls:tadd');
  return { text: lines.join('\n'), keyboard: withNav(kb, 'wls') };
}
