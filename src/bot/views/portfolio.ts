import { InlineKeyboard } from 'grammy';
import { allocation, attributeChange, type Holding, type PortfolioSummary, type SnapshotLike } from '../../analytics/portfolio.js';
import type { SnapshotRow, TrackedWalletRow } from '../../db/types.js';
import { shareChart, sparkline } from '../../utils/charts.js';
import { escapeHtml, formatDate, formatPct, formatSol, formatUsd } from '../../utils/format.js';
import { withNav } from '../keyboards.js';
import type { View } from '../render.js';

export function portfolioMenuView(wallets: TrackedWalletRow[]): View {
  const kb = new InlineKeyboard();
  wallets.slice(0, 20).forEach((w, i) => {
    kb.text(w.label.slice(0, 18), `pf:v:${w.id}`);
    if (i % 2 === 1) kb.row();
  });
  if (wallets.length > 1) kb.row().text('🧺 All tracked wallets combined', 'pf:all');
  return {
    text:
      '📊 <b>Portfolio Analytics</b>\n\n' +
      (wallets.length === 0
        ? 'Track a wallet first (⭐ Watchlists → Tracked wallets). Portfolio analytics uses tracked public wallets so that historical snapshots can be recorded.'
        : 'Choose a tracked wallet. Snapshots are recorded periodically to show value history.'),
    keyboard: withNav(kb),
  };
}

export function snapshotLike(r: SnapshotRow): SnapshotLike {
  return { solBalance: r.sol_balance, solPriceUsd: r.sol_price_usd, totalValueUsd: r.total_value_usd, holdings: r.holdings, takenAt: r.taken_at ?? '' };
}

export function portfolioView(
  title: string,
  backData: string,
  summary: PortfolioSummary,
  holdings: Holding[],
  idForButtons: string | null,
): View {
  const rows = allocation(summary, holdings);
  const lines = [
    `📊 <b>Portfolio · ${escapeHtml(title)}</b>`,
    '',
    `SOL: ${formatSol(summary.solBalance)} ✅ ≈ ${formatUsd(summary.solValueUsd)} 📐`,
    `Tokens: ${formatUsd(summary.tokensValueUsd)} 📐 (${summary.pricedCount} priced, ${summary.unpricedCount} without price${summary.lowLiquidityCount ? `, ${summary.lowLiquidityCount} low-liquidity excluded` : ''})`,
    `<b>Estimated total: ${formatUsd(summary.totalValueUsd)}</b> 📐`,
    '',
    '<b>Allocation</b>',
    `<pre>${escapeHtml(shareChart(rows))}</pre>`,
    '<i>Estimates: on-chain balances × current DEX prices. Unpriced tokens are not included.</i>',
  ];
  const kb = new InlineKeyboard();
  if (idForButtons) {
    kb.text('📈 Value history', `pf:h:${idForButtons}`).text('⏮ Price exposure', `pf:perf:${idForButtons}`).row().text('📸 Snapshot now', `pf:snap:${idForButtons}`);
  }
  return { text: lines.join('\n'), keyboard: withNav(kb, backData) };
}

export function portfolioHistoryView(w: TrackedWalletRow, snaps: SnapshotRow[], vs24h: SnapshotRow | null, vs7d: SnapshotRow | null): View {
  const lines = [`📈 <b>Value history · ${escapeHtml(w.label)}</b>`, ''];
  if (snaps.length === 0) {
    lines.push('No snapshots yet. Tap 📸 Snapshot now, or wait for the scheduled snapshot job.');
    return { text: lines.join('\n'), keyboard: withNav(new InlineKeyboard().text('📸 Snapshot now', `pf:snap:${w.id}`), `pf:v:${w.id}`) };
  }
  const chrono = [...snaps].reverse();
  const values = chrono.map((s) => s.total_value_usd ?? NaN);
  const latest = snaps[0]!;
  lines.push(
    `<code>${sparkline(values)}</code>`,
    `${chrono.length} snapshots · ${formatDate(Date.parse(chrono[0]!.taken_at!) / 1000)} → ${formatDate(Date.parse(latest.taken_at!) / 1000)}`,
    `Latest: ${formatUsd(latest.total_value_usd)} · SOL ${formatSol(latest.sol_balance)}`,
    '',
  );
  const describe = (label: string, prev: SnapshotRow | null) => {
    if (!prev) {
      lines.push(`<b>${label}</b>: not enough history`);
      return;
    }
    const a = attributeChange(snapshotLike(prev), snapshotLike(latest));
    lines.push(
      `<b>${label}</b> (vs ${formatDate(Date.parse(prev.taken_at!) / 1000)}): ${formatUsd(a.valueChangeUsd)} (${formatPct(a.valueChangePct)})`,
      `   price effect ${formatUsd(a.priceEffectUsd)} · quantity effect ${formatUsd(a.quantityEffectUsd)}${a.unattributedAssets ? ` · ${a.unattributedAssets} asset(s) unattributed` : ''}`,
    );
  };
  describe('24h change', vs24h);
  describe('7d change', vs7d);
  lines.push(
    '',
    '<i>Price effect = value change from price moves on previously held amounts. Quantity effect = value of balance changes (transfers in/out, swaps, airdrops). Neither is realised trading profit.</i>',
    '',
    '<b>Recent snapshots</b>',
    ...snaps.slice(0, 8).map((s) => `${formatDate(Date.parse(s.taken_at!) / 1000)}  ${formatUsd(s.total_value_usd).padStart(9)}  ${formatSol(s.sol_balance)}`),
  );
  return { text: lines.join('\n'), keyboard: withNav(new InlineKeyboard().text('📸 Snapshot now', `pf:snap:${w.id}`), `pf:v:${w.id}`) };
}

export interface ExposureRow {
  symbol: string;
  amount: number;
  priceNow: number;
  price7d: number | null;
  price30d: number | null;
}

export function priceExposureView(w: TrackedWalletRow, rows: ExposureRow[]): View {
  const valueAt = (pick: (r: ExposureRow) => number | null) => {
    let v = 0;
    let n = 0;
    for (const r of rows) {
      const p = pick(r);
      if (p !== null) {
        v += r.amount * p;
        n++;
      }
    }
    return { v, n };
  };
  const now = valueAt((r) => r.priceNow);
  const d7 = valueAt((r) => r.price7d);
  const d30 = valueAt((r) => r.price30d);
  const lines = [
    `⏮ <b>Price exposure · ${escapeHtml(w.label)}</b>`,
    '<i>What the CURRENT balances of the largest holdings would have been worth at past prices (GeckoTerminal daily closes). This shows exposure to price moves only — it is not the wallet’s historical value or profit.</i>',
    '',
  ];
  for (const r of rows) {
    lines.push(
      `<b>${escapeHtml(r.symbol)}</b>: now ${formatUsd(r.amount * r.priceNow)} · 7d ago ${r.price7d !== null ? formatUsd(r.amount * r.price7d) : 'n/a'} · 30d ago ${r.price30d !== null ? formatUsd(r.amount * r.price30d) : 'n/a'}`,
    );
  }
  lines.push('');
  if (d7.n === rows.length && d7.n > 0) lines.push(`Same holdings 7d ago: ${formatUsd(d7.v)} → now ${formatUsd(now.v)} (${formatPct(((now.v - d7.v) / d7.v) * 100)}) 📐`);
  else lines.push(`7d comparison covers ${d7.n}/${rows.length} assets.`);
  if (d30.n === rows.length && d30.n > 0) lines.push(`Same holdings 30d ago: ${formatUsd(d30.v)} → now ${formatUsd(now.v)} (${formatPct(((now.v - d30.v) / d30.v) * 100)}) 📐`);
  else lines.push(`30d comparison covers ${d30.n}/${rows.length} assets.`);
  return { text: lines.join('\n'), keyboard: withNav(new InlineKeyboard(), `pf:v:${w.id}`) };
}

export function combinedTitle(wallets: TrackedWalletRow[]): string {
  return wallets.length <= 3 ? wallets.map((w) => w.label).join(' + ') : `${wallets.length} wallets`;
}

