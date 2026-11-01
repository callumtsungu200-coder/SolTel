import { InlineKeyboard } from 'grammy';
import type { TrendingSort, TrendingToken } from '../../analytics/trending.js';
import { escapeHtml, formatPct, formatPrice, formatUsd } from '../../utils/format.js';
import { addPager, paginate, withNav } from '../keyboards.js';
import type { View } from '../render.js';

export const SORT_LABELS: Record<TrendingSort, string> = {
  volume: '📊 Volume',
  liquidity: '💧 Liquidity',
  gainers: '🟢 24h gainers',
  losers: '🔴 24h losers',
  change1h: '⚡ 1h movers',
  marketCap: '🏦 Market cap',
  txns: '🔁 Trades',
};

export function trendingView(tokens: TrendingToken[], sort: TrendingSort, page: number, pageSize: number, minLiq: number, minVol: number): View {
  const pg = paginate(tokens, page, pageSize);
  const lines = [
    `🔥 <b>Trending Solana tokens</b> · sorted by ${SORT_LABELS[sort]}`,
    `Filters: liquidity ≥ ${formatUsd(minLiq)} · 24h volume ≥ ${formatUsd(minVol)} · ${tokens.length} match`,
    '',
  ];
  if (pg.items.length === 0) lines.push('No tokens match these filters. Try lowering the minimum liquidity/volume.');
  pg.items.forEach((t, i) => {
    const n = pg.page * pageSize + i + 1;
    lines.push(
      `${n}. <b>${escapeHtml(t.symbol)}</b> ${escapeHtml(t.name.slice(0, 24))}`,
      `   ${formatPrice(t.priceUsd)} · 1h ${formatPct(t.change1h)} · 24h ${formatPct(t.change24h)}`,
      `   Vol ${formatUsd(t.volume24h)} · Liq ${formatUsd(t.liquidityUsd)} · MC ${formatUsd(t.marketCap ?? t.fdv)} · ${t.txns24h.toLocaleString('en-US')} trades`,
    );
    if (t.warnings.length) lines.push(`   ⚠️ ${escapeHtml(t.warnings.join(', '))}`);
  });
  lines.push(
    '',
    '<i>Candidates come from DexScreener boosted/profile listings and pair search; boosts are paid promotions. Trending status is not a recommendation to buy. Market data 📈 DexScreener.</i>',
  );
  const kb = new InlineKeyboard();
  pg.items.forEach((t, i) => {
    kb.text(`${pg.page * pageSize + i + 1}. ${t.symbol.slice(0, 10)}`, `tok:p:${t.mint}`);
    if (i % 3 === 2) kb.row();
  });
  addPager(kb, `trd:${sort}:`, pg.page, pg.totalPages);
  kb.row();
  (Object.keys(SORT_LABELS) as TrendingSort[]).forEach((s, i) => {
    kb.text(s === sort ? `• ${SORT_LABELS[s]}` : SORT_LABELS[s], `trd:${s}:0`);
    if (i % 2 === 1) kb.row();
  });
  kb.row().text('🎚 Filters', 'trd:f');
  return { text: lines.join('\n'), keyboard: withNav(kb) };
}

export const LIQ_PRESETS = [0, 10_000, 50_000, 100_000, 500_000, 1_000_000];
export const VOL_PRESETS = [0, 50_000, 100_000, 500_000, 1_000_000, 5_000_000];

export function trendingFiltersView(minLiq: number, minVol: number, sort: TrendingSort): View {
  const kb = new InlineKeyboard();
  kb.text('Min liquidity:', 'noop').row();
  LIQ_PRESETS.forEach((v, i) => {
    kb.text(`${v === minLiq ? '• ' : ''}${v === 0 ? 'Any' : formatUsd(v)}`, `trd:liq:${v}`);
    if (i % 3 === 2) kb.row();
  });
  kb.row().text('Min 24h volume:', 'noop').row();
  VOL_PRESETS.forEach((v, i) => {
    kb.text(`${v === minVol ? '• ' : ''}${v === 0 ? 'Any' : formatUsd(v)}`, `trd:vol:${v}`);
    if (i % 3 === 2) kb.row();
  });
  return {
    text: `🎚 <b>Trending filters</b>\nCurrent: liquidity ≥ ${formatUsd(minLiq)}, volume ≥ ${formatUsd(minVol)}.\nFilters are saved to your preferences.`,
    keyboard: withNav(kb, `trd:${sort}:0`),
  };
}
