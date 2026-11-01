import { InlineKeyboard } from 'grammy';
import { interactionHistory } from '../../analytics/patterns.js';
import type { WalletProfile } from '../../analytics/wallet.js';
import { hourHistogram } from '../../utils/charts.js';
import {
  code,
  escapeHtml,
  formatAge,
  formatDate,
  formatNumber,
  formatPrice,
  formatSol,
  formatUsd,
  link,
  relativeTime,
  shortAddr,
  solscanAccount,
  solscanTx,
} from '../../utils/format.js';
import { addPager, paginate, withNav } from '../keyboards.js';
import type { View } from '../render.js';
import { LEGEND, txBlock, type SymbolLookup } from './common.js';

export function symbolLookup(p: WalletProfile): SymbolLookup {
  const holdingSyms = new Map(p.holdings.map((h) => [h.mint, h.symbol]));
  return (mint) => p.meta.get(mint)?.symbol || holdingSyms.get(mint) || shortAddr(mint);
}

function profileKeyboard(addr: string, tracked: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('🪙 Holdings', `wal:h:${addr}:0`)
    .text('🧾 Transactions', `wal:t:${addr}:0`)
    .row()
    .text('🕒 Timeline', `wal:tl:${addr}`)
    .text('📊 Analytics', `wal:an:${addr}`)
    .row()
    .text('📥 Acquisitions', `wal:aq:${addr}:0`)
    .text('🤝 Counterparties', `wal:cp:${addr}`)
    .row();
  if (!tracked) kb.text('⭐ Track wallet', `wal:track:${addr}`);
  kb.text('🔄 Refresh', `wal:r:${addr}`).row().url('🔗 Solscan', solscanAccount(addr));
  return withNav(kb, 'wal');
}

export function walletOverviewView(p: WalletProfile, tracked: boolean): View {
  const s = p.stats;
  const pf = p.portfolio;
  const lines: string[] = [`👛 <b>Wallet Profile</b>`, code(p.address), ''];
  if (p.isProgram) lines.push('⚠️ This address is an executable program, not a user wallet.', '');
  if (!p.accountExists) lines.push('ℹ️ This account has no balance and no on-chain data — it may never have been used.', '');

  lines.push(`💰 <b>SOL balance:</b> ${formatSol(p.solBalance)} ✅`);
  if (pf.totalValueUsd !== null) {
    lines.push(`💵 <b>Est. portfolio value:</b> ${formatUsd(pf.totalValueUsd)} 📐`);
    lines.push(`   SOL ${formatUsd(pf.solValueUsd)} + tokens ${formatUsd(pf.tokensValueUsd)}`);
  } else lines.push('💵 <b>Est. portfolio value:</b> unavailable ❔ (no SOL price)');
  lines.push(
    `🪙 <b>Tokens:</b> ${p.holdings.length} (${pf.pricedCount} priced, ${pf.unpricedCount} unpriced${pf.lowLiquidityCount ? `, ${pf.lowLiquidityCount} low-liquidity` : ''}) · NFTs: ${p.nftCount}`,
  );

  if (p.age) {
    if (p.age.firstSeen && p.age.exact) lines.push(`📅 <b>First activity:</b> ${formatDate(p.age.firstSeen)} (age ${formatAge(p.age.firstSeen)}) ✅`);
    else if (p.age.firstSeen) lines.push(`📅 <b>Age:</b> older than ${formatAge(p.age.firstSeen)} (scan limit reached) ✅`);
    else lines.push('📅 <b>Age:</b> no transactions found');
    lines.push(`🔢 <b>Transactions:</b> ${p.age.signatureCount.toLocaleString('en-US')}${p.age.countExact ? '' : '+'} ${p.age.countExact ? '✅' : '(lower bound) ✅'}`);
  } else lines.push('📅 Age / tx count: unavailable ❔');

  lines.push('');
  if (s.windowTxCount > 0) {
    const span = s.windowStart && s.windowEnd ? formatAge(s.windowStart, s.windowEnd * 1000) : '0s';
    lines.push(`<b>Recent activity</b> (last ${s.windowTxCount} tx, span ${span})`);
    lines.push(`⚡ Frequency: ${s.txPerDay.toFixed(2)} tx/day · last tx ${relativeTime(s.windowEnd)}`);
    lines.push(`↘️ SOL in: ${formatSol(s.solIn)} · ↗️ SOL out: ${formatSol(s.solOut)} · fees: ${formatSol(s.feesSol, 6)}`);
    lines.push(`🔄 Swaps ${s.swaps} · 📥 In ${s.transfersIn} · 📤 Out ${s.transfersOut} · ⚙️ Other ${s.other} · ❌ Failed ${s.failed}`);
    lines.push(`🏅 Activity score: <b>${p.score.total}/100</b> (${p.score.label}) 📐`);
  } else lines.push('No recent parsed transactions available.');

  if (p.warnings.length) lines.push('', ...p.warnings.map((w) => `⚠️ ${escapeHtml(w)}`));
  lines.push('', LEGEND, '<i>Activity score describes past activity only; it does not predict returns.</i>');
  return { text: lines.join('\n'), keyboard: profileKeyboard(p.address, tracked) };
}

export function walletHoldingsView(p: WalletProfile, page: number, pageSize: number): View {
  const pg = paginate(p.holdings, page, pageSize * 2);
  const total = p.portfolio.totalValueUsd;
  const lines = [`🪙 <b>Holdings</b> · ${shortAddr(p.address)}`, `SOL: ${formatSol(p.solBalance)} ✅ ≈ ${formatUsd(p.portfolio.solValueUsd)} 📐`, ''];
  if (pg.items.length === 0) lines.push('No fungible token balances.');
  pg.items.forEach((h, i) => {
    const n = pg.page * pageSize * 2 + i + 1;
    const share = total && h.valueUsd ? ` (${((h.valueUsd / total) * 100).toFixed(1)}%)` : '';
    let priceText: string;
    if (h.priceUsd === null) priceText = 'no market price ❔';
    else if (!h.reliable) priceText = `${formatPrice(h.priceUsd)} — low liquidity, excluded ⚠️`;
    else priceText = `${formatPrice(h.priceUsd)} → ${formatUsd(h.valueUsd)}${share} 📐`;
    lines.push(`${n}. <b>${escapeHtml(h.symbol)}</b> ${formatNumber(h.amount)} ✅\n   ${priceText}\n   ${code(h.mint)}`);
  });
  if (p.holdingsTruncated) lines.push('', '⚠️ Holdings list truncated.');
  lines.push('', '<i>Amounts are on-chain balances. Values use the deepest DexScreener pool (≥ $1K liquidity).</i>');
  const kb = new InlineKeyboard();
  pg.items.slice(0, 6).forEach((h, i) => {
    kb.text(`🔎 ${h.symbol.slice(0, 10)}`, `tok:p:${h.mint}`);
    if (i % 3 === 2) kb.row();
  });
  addPager(kb, `wal:h:${p.address}:`, pg.page, pg.totalPages);
  return { text: lines.join('\n'), keyboard: withNav(kb, `wal:p:${p.address}`) };
}

export function walletTransactionsView(p: WalletProfile, page: number, pageSize: number): View {
  const pg = paginate(p.views, page, pageSize);
  const sym = symbolLookup(p);
  const lines = [`🧾 <b>Recent transactions</b> · ${shortAddr(p.address)}`, `<i>Most recent ${p.views.length} transactions (Helius Parsed Events).</i>`, ''];
  if (pg.items.length === 0) lines.push('No transactions found.');
  pg.items.forEach((v, i) => lines.push(txBlock(v, sym, pg.page * pageSize + i + 1), ''));
  const kb = addPager(new InlineKeyboard(), `wal:t:${p.address}:`, pg.page, pg.totalPages);
  return { text: lines.join('\n'), keyboard: withNav(kb, `wal:p:${p.address}`) };
}

export function walletTimelineView(p: WalletProfile): View {
  const sym = symbolLookup(p);
  const lines = [`🕒 <b>Activity timeline</b> · ${shortAddr(p.address)}`, '<i>Notable events in the sampled history, oldest first.</i>', ''];
  if (p.age?.firstSeen && p.age.exact) lines.push(`🌱 ${formatDate(p.age.firstSeen)} — first on-chain activity ✅`, '');
  if (p.timeline.length === 0) lines.push('No notable events (swaps, ≥1 SOL or ≥$100 movements, first token receipts) in the sampled window.');
  for (const e of p.timeline) {
    lines.push(txBlock(e.view, sym));
    lines.push(`   <i>why: ${escapeHtml(e.reason)}${e.estUsd !== null ? ` · ~${formatUsd(e.estUsd)} at current prices 📐` : ''}</i>`, '');
  }
  return { text: lines.join('\n'), keyboard: withNav(new InlineKeyboard(), `wal:p:${p.address}`) };
}

export function walletAnalyticsView(p: WalletProfile): View {
  const pt = p.patterns;
  const sc = p.score.components;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const lines = [
    `📊 <b>Wallet analytics</b> · ${shortAddr(p.address)}`,
    '',
    `🏅 <b>Activity score ${p.score.total}/100 (${p.score.label})</b> 📐`,
    `Frequency ${sc.frequency}/35 · Recency ${sc.recency}/20`,
    `Counterparties ${sc.counterparties}/20 · Token breadth ${sc.tokenBreadth}/15 · Longevity ${sc.longevity}/10`,
    '<i>Describes observed activity only. Not a trust or performance rating. See /methodology.</i>',
    '',
    '<b>Activity by hour (UTC)</b>',
    `<pre>${hourHistogram(pt.hourHistogram)}</pre>`,
    `Busiest hour: ${pt.busiestHourUtc !== null ? `${pt.busiestHourUtc}:00 UTC` : 'n/a'} · Median gap between tx: ${pt.medianGapMinutes !== null ? `${pt.medianGapMinutes.toFixed(1)} min` : 'n/a'}`,
    `By weekday: ${pt.weekdayCounts.map((c, i) => `${days[i]} ${c}`).join(' · ')}`,
    '',
    '<b>Transaction mix</b>',
    Object.entries(pt.categoryCounts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ') || 'n/a',
    '',
    '<b>Most used programs/protocols</b>',
    pt.topSources.length ? pt.topSources.map((s) => `• ${escapeHtml(s.source)} (${s.count})`).join('\n') : 'n/a',
    '',
    `<b>Flows in window</b>: in ${formatSol(p.stats.solIn)} / out ${formatSol(p.stats.solOut)} → net ${formatSol(p.stats.solIn - p.stats.solOut - p.stats.feesSol)} (incl. fees)`,
    `<i>Window: last ${p.stats.windowTxCount} transactions${p.historyComplete ? ' (complete history)' : ''}.</i>`,
  ];
  return { text: lines.join('\n'), keyboard: withNav(new InlineKeyboard(), `wal:p:${p.address}`) };
}

export function walletAcquisitionsView(p: WalletProfile, page: number, pageSize: number): View {
  const sym = symbolLookup(p);
  const pg = paginate([...p.acquisitions].reverse(), page, pageSize * 2);
  const lines = [
    `📥 <b>Token acquisition history</b> · ${shortAddr(p.address)}`,
    '<i>First observed inbound movement of each token within the sampled history. "transfer" means tokens were sent to the wallet; "swap" means the provider classified the transaction as a swap. Earlier acquisitions may exist outside the window.</i>',
    '',
  ];
  if (pg.items.length === 0) lines.push('No inbound token movements in the sampled window.');
  for (const a of pg.items) {
    lines.push(`• <b>${escapeHtml(sym(a.mint))}</b> +${formatNumber(a.amount)} via ${a.via} · ${formatDate(a.firstSeen)} ${link(solscanTx(a.signature), '↗')}`);
  }
  const kb = addPager(new InlineKeyboard(), `wal:aq:${p.address}:`, pg.page, pg.totalPages);
  return { text: lines.join('\n'), keyboard: withNav(kb, `wal:p:${p.address}`) };
}

export function walletCounterpartiesView(p: WalletProfile): View {
  const lines = [`🤝 <b>Wallet interaction history</b> · ${shortAddr(p.address)}`, '<i>Addresses that directly sent or received SOL/tokens in the sampled window. Includes programs, pools and exchanges.</i>', ''];
  const top = p.patterns.topCounterparties;
  if (top.length === 0) lines.push('No direct counterparties observed.');
  top.forEach((c, i) => {
    lines.push(
      `${i + 1}. ${code(c.address)}\n   ${c.txCount} tx · sent ${formatSol(c.solSent)} · received ${formatSol(c.solReceived)} · last ${relativeTime(c.lastSeen)}`,
    );
  });
  const kb = new InlineKeyboard();
  top.slice(0, 4).forEach((c, i) => {
    kb.text(`👛 ${shortAddr(c.address)}`, `wal:p:${c.address}`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('🔍 Check a specific address', `wal:ix:${p.address}`);
  return { text: lines.join('\n'), keyboard: withNav(kb, `wal:p:${p.address}`) };
}

export function interactionView(p: WalletProfile, other: string): View {
  const sym = symbolLookup(p);
  const hits = interactionHistory(p.views, other);
  const lines = [`🤝 <b>Interactions</b>`, `${code(p.address)}\n↔️\n${code(other)}`, ''];
  if (hits.length === 0) lines.push('No direct transfers between these addresses in the sampled window (last 100 transactions).');
  hits.slice(0, 10).forEach((v, i) => lines.push(txBlock(v, sym, i + 1), ''));
  return { text: lines.join('\n'), keyboard: withNav(new InlineKeyboard().text('👛 Open other wallet', `wal:p:${other}`), `wal:cp:${p.address}`) };
}
