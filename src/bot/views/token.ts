import { InlineKeyboard } from 'grammy';
import type { ConcentrationReport, Figure, TokenReport } from '../../analytics/token.js';
import { sparkline } from '../../utils/charts.js';
import {
  code,
  escapeHtml,
  formatAge,
  formatDate,
  formatNumber,
  formatPct,
  formatPrice,
  formatUsd,
  link,
  shortAddr,
  solscanAccount,
  solscanToken,
  trendEmoji,
} from '../../utils/format.js';
import { withNav } from '../keyboards.js';
import type { View } from '../render.js';
import { LEGEND, PROV_ICON } from './common.js';

function hostLabel(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return 'link';
  }
}

function f<T>(x: Figure<T>, fmt: (v: T) => string): string {
  return x.value === null ? `n/a ${PROV_ICON.unavailable}` : `${fmt(x.value)} ${PROV_ICON[x.provenance]}`;
}

function tokenKeyboard(mint: string, watched: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('💱 Pairs', `tok:pairs:${mint}`)
    .text('📉 History', `tok:hist:${mint}`)
    .row()
    .text('👥 Holder concentration', `tok:conc:${mint}`)
    .row();
  if (!watched) kb.text('⭐ Watch', `tok:watch:${mint}`);
  kb.text('🔔 Create alert', `tok:alert:${mint}`).text('🔄 Refresh', `tok:r:${mint}`).row().url('🔗 Solscan', solscanToken(mint));
  return withNav(kb, 'tok');
}

export function tokenReportView(r: TokenReport, watched: boolean): View {
  const name = r.name.value ?? 'Unknown token';
  const sym = r.symbol.value ? ` (${r.symbol.value})` : '';
  const pc = r.priceChange;
  const lines = [
    `🪙 <b>${escapeHtml(name)}${escapeHtml(sym)}</b>`,
    code(r.mint),
    '',
    `💲 <b>Price:</b> ${f(r.priceUsd, formatPrice)}`,
    `${trendEmoji(pc.h24)} 5m ${formatPct(pc.m5)} · 1h ${formatPct(pc.h1)} · 6h ${formatPct(pc.h6)} · 24h ${formatPct(pc.h24)}`,
    `🏦 <b>Market cap:</b> ${f(r.marketCap, (v) => formatUsd(v))}`,
    `🧮 <b>FDV:</b> ${f(r.fdv, (v) => formatUsd(v))} · calc. ${f(r.fdvCalculated, (v) => formatUsd(v))}`,
    `💧 <b>Liquidity:</b> ${f(r.liquidityUsd, (v) => formatUsd(v))}`,
    `📊 <b>24h volume:</b> ${f(r.volume24h, (v) => formatUsd(v))}`,
  ];
  if (r.txns24h.buys !== null) lines.push(`🔁 24h DEX trades: ${(r.txns24h.buys + (r.txns24h.sells ?? 0)).toLocaleString('en-US')} (${r.txns24h.buys} buy-side / ${r.txns24h.sells} sell-side swaps, per DexScreener) 📈`);
  if (r.hourlyVolume.ratio !== null) lines.push(`${r.hourlyVolume.unusual ? '🚨 Unusual volume' : '📏 Volume pace'}: last hour ${r.hourlyVolume.ratio.toFixed(1)}× the 24h hourly average 📐`);
  lines.push(
    '',
    '<b>On-chain</b>',
    `Supply: ${f(r.supply, (v) => formatNumber(v))} · Decimals: ${f(r.decimals, String)}`,
    `Mint authority: ${f(r.mintAuthority, (v) => (v === 'none' ? 'revoked' : shortAddr(v)))}`,
    `Freeze authority: ${f(r.freezeAuthority, (v) => (v === 'none' ? 'revoked' : shortAddr(v)))}`,
    `Metadata mutable: ${f(r.metadataMutable, (v) => (v ? 'yes' : 'no'))}`,
  );
  if (r.primaryPair) {
    const pp = r.primaryPair;
    lines.push('', `<b>Primary pair</b>: ${escapeHtml(pp.baseSymbol)}/${escapeHtml(pp.quoteSymbol)} on ${escapeHtml(pp.dexId)}${pp.createdAt ? ` · created ${formatAge(pp.createdAt)} ago` : ''} · ${r.pairCount} pool(s)`);
  }
  if (r.history) {
    lines.push('', `<b>30d</b>: ${formatPct(r.history.change30d)} · 7d ${formatPct(r.history.change7d)} · vol. ${r.history.volatilityAnnualized !== null ? `${r.history.volatilityAnnualized.toFixed(0)}%/yr` : 'n/a'} 📐`);
    lines.push(`<code>${sparkline(r.history.candles.map((c) => c.c))}</code>`);
  }
  if (r.links.websites.length || r.links.socials.length) {
    lines.push('', [...r.links.websites.slice(0, 2), ...r.links.socials.slice(0, 3)].map((u) => link(u, hostLabel(u))).join(' · '));
  }
  if (r.warnings.length) lines.push('', ...r.warnings.map((w) => `⚠️ ${escapeHtml(w)}`));
  lines.push('', LEGEND, '<i>Not financial advice. Verify independently before acting.</i>');
  return { text: lines.join('\n'), keyboard: tokenKeyboard(r.mint, watched) };
}

export function tokenPairsView(r: TokenReport): View {
  const lines = [`💱 <b>Trading pairs</b> · ${escapeHtml(r.symbol.value ?? shortAddr(r.mint))}`, `<i>Top ${r.pairs.length} of ${r.pairCount} pools by liquidity (DexScreener) 📈</i>`, ''];
  if (r.pairs.length === 0) lines.push('No pools found.');
  r.pairs.forEach((p, i) => {
    lines.push(
      `${i + 1}. <b>${escapeHtml(p.baseSymbol)}/${escapeHtml(p.quoteSymbol)}</b> · ${escapeHtml(p.dexId)}`,
      `   Price ${formatPrice(p.priceUsd)} · Liq ${formatUsd(p.liquidityUsd)} · Vol 24h ${formatUsd(p.volume24h)}`,
      `   Trades 24h ${p.txns24h.toLocaleString('en-US')}${p.createdAt ? ` · created ${formatDate(p.createdAt)}` : ''}`,
      `   ${link(solscanAccount(p.pairAddress), shortAddr(p.pairAddress, 6))}${p.url ? ` · ${link(p.url, 'DexScreener')}` : ''}`,
    );
  });
  return { text: lines.join('\n'), keyboard: withNav(new InlineKeyboard(), `tok:p:${r.mint}`) };
}

export function tokenHistoryView(r: TokenReport): View {
  const h = r.history;
  const lines = [`📉 <b>Price history</b> · ${escapeHtml(r.symbol.value ?? shortAddr(r.mint))}`];
  if (!h || h.candles.length === 0) {
    lines.push('', 'Historical candles are not available for this token’s primary pool (GeckoTerminal has no data).');
    return { text: lines.join('\n'), keyboard: withNav(new InlineKeyboard(), `tok:p:${r.mint}`) };
  }
  const first = h.candles[0]!;
  const last = h.candles[h.candles.length - 1]!;
  lines.push(
    `<i>Daily candles ${formatDate(first.t).slice(0, 10)} → ${formatDate(last.t).slice(0, 10)} (GeckoTerminal, pool ${shortAddr(h.poolAddress)}) 📈</i>`,
    '',
    `<code>${sparkline(h.candles.map((c) => c.c))}</code>`,
    '',
    `Change 7d: ${formatPct(h.change7d)} · 30d: ${formatPct(h.change30d)}`,
    `30d high: ${formatPrice(h.high30d)} · low: ${formatPrice(h.low30d)}`,
    `Annualised volatility: ${h.volatilityAnnualized !== null ? `${h.volatilityAnnualized.toFixed(1)}%` : 'n/a'} 📐`,
    `Max drawdown: ${h.maxDrawdown30d !== null ? `${h.maxDrawdown30d.toFixed(1)}%` : 'n/a'} 📐`,
    '',
    '<b>Volume</b>',
    `<code>${sparkline(h.candles.map((c) => c.v))}</code>`,
    h.dailyVolume.ratio !== null
      ? `Latest full day: ${h.dailyVolume.ratio.toFixed(2)}× the prior average${h.dailyVolume.zScore !== null ? ` (z = ${h.dailyVolume.zScore.toFixed(2)})` : ''}${h.dailyVolume.unusual ? ' 🚨 unusual' : ''} 📐`
      : `Volume comparison: ${escapeHtml(h.dailyVolume.basis)}`,
    '',
    '<b>Recent days</b>',
    ...h.candles
      .slice(-7)
      .reverse()
      .map((c) => `${formatDate(c.t).slice(0, 10)}  close ${formatPrice(c.c)}  vol ${formatUsd(c.v)}`),
    '',
    '<i>Past price behaviour does not predict future prices.</i>',
  );
  return { text: lines.join('\n'), keyboard: withNav(new InlineKeyboard(), `tok:p:${r.mint}`) };
}

export function concentrationView(mint: string, c: ConcentrationReport | null): View {
  const lines = [`👥 <b>Holder concentration</b>`, code(mint), ''];
  if (!c) {
    lines.push('Concentration data is unavailable for this token (no supply or largest accounts returned by RPC).');
  } else {
    lines.push(
      `Top 1 account: ${c.top1Pct.toFixed(2)}% · Top 10: ${c.top10Pct.toFixed(2)}% · Top 20: ${c.top20Pct.toFixed(2)}% ✅`,
      `HHI (top 20): ${c.hhiTop20.toFixed(4)} 📐`,
      '',
    );
    c.topAccounts.slice(0, 10).forEach((a, i) => {
      lines.push(`${i + 1}. ${(a.share * 100).toFixed(2)}% · ${formatNumber(a.amount)}\n   owner ${a.owner ? code(a.owner) : 'unknown'}`);
    });
    lines.push('', `<i>${escapeHtml(c.caveat)}</i>`);
  }
  return { text: lines.join('\n'), keyboard: withNav(new InlineKeyboard(), `tok:p:${mint}`) };
}
