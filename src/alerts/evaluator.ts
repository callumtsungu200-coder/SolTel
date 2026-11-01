import type { AlertRow } from '../db/types.js';
import { escapeHtml, formatPct, formatPrice, formatUsd, shortAddr } from '../utils/format.js';
import { parseAlertParams } from './definitions.js';

/**
 * Pure market-alert evaluation. Given an alert, its persisted state and a
 * fresh market snapshot, decide whether to trigger and what the next state is.
 * No I/O here, so every rule is unit-tested.
 */

export interface MarketSnapshot {
  mint: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume1h: number | null;
  volume24h: number | null;
  txns1h: number | null;
  txns24h: number | null;
}

export interface Evaluation {
  triggered: boolean;
  state: Record<string, unknown>;
  message?: string;
  /** Unique per trigger occurrence, used for duplicate prevention. */
  dedupeKey?: string;
}

export function inCooldown(alert: Pick<AlertRow, 'last_triggered_at' | 'cooldown_minutes'>, now: number): boolean {
  if (!alert.last_triggered_at) return false;
  return now - Date.parse(alert.last_triggered_at) < alert.cooldown_minutes * 60_000;
}

const name = (symbol: string, mint: string) => escapeHtml(symbol || shortAddr(mint));

/** Time bucket used in dedupe keys so the same condition can re-fire after cooldown. */
const bucket = (now: number, minutes: number) => Math.floor(now / (Math.max(1, minutes) * 60_000));

export function evaluateMarketAlert(alert: AlertRow, snap: MarketSnapshot, now = Date.now()): Evaluation {
  const state = { ...alert.state };
  const cooling = inCooldown(alert, now);
  const key = (suffix: string) => `alert:${alert.id}:${suffix}:${bucket(now, alert.cooldown_minutes)}`;

  switch (alert.kind) {
    case 'price_move': {
      const p = parseAlertParams('price_move', alert.params);
      if (!p || snap.priceUsd === null) return { triggered: false, state };
      const baseline = typeof state.baseline === 'number' ? state.baseline : null;
      if (baseline === null || baseline <= 0) return { triggered: false, state: { ...state, baseline: snap.priceUsd, baselineAt: now } };
      const change = ((snap.priceUsd - baseline) / baseline) * 100;
      const hit = p.direction === 'up' ? change >= p.percent : p.direction === 'down' ? change <= -p.percent : Math.abs(change) >= p.percent;
      if (!hit || cooling) return { triggered: false, state };
      const since = typeof state.baselineAt === 'number' ? Math.round((now - state.baselineAt) / 60_000) : null;
      return {
        triggered: true,
        state: { baseline: snap.priceUsd, baselineAt: now },
        dedupeKey: key('move'),
        message:
          `📈 <b>Price movement: ${name(p.symbol, p.mint)}</b>\n` +
          `Price ${formatPct(change)} (${formatPrice(baseline)} → ${formatPrice(snap.priceUsd)})` +
          (since !== null ? ` over ~${since} min` : '') +
          `\nThreshold: ${p.direction === 'either' ? '±' : p.direction === 'up' ? '+' : '-'}${p.percent}%`,
      };
    }
    case 'price_target': {
      const p = parseAlertParams('price_target', alert.params);
      if (!p || snap.priceUsd === null) return { triggered: false, state };
      const side = snap.priceUsd >= p.price ? 'above' : 'below';
      const prevSide = state.lastSide as string | undefined;
      const next = { ...state, lastSide: side };
      // Fire on crossing into the target zone (or on first check if already there).
      const crossed = side === p.condition && prevSide !== p.condition;
      if (!crossed || cooling) return { triggered: false, state: next };
      return {
        triggered: true,
        state: next,
        dedupeKey: key('target'),
        message: `🎯 <b>Price target: ${name(p.symbol, p.mint)}</b>\nPrice is now ${formatPrice(snap.priceUsd)}, ${p.condition} your target of ${formatPrice(p.price)}.`,
      };
    }
    case 'volume_spike': {
      const p = parseAlertParams('volume_spike', alert.params);
      if (!p || !snap.volume1h || !snap.volume24h || snap.volume24h <= 0) return { triggered: false, state };
      const ratio = snap.volume1h / (snap.volume24h / 24);
      if (ratio < p.multiplier || cooling) return { triggered: false, state: { ...state, lastRatio: ratio } };
      return {
        triggered: true,
        state: { ...state, lastRatio: ratio },
        dedupeKey: key('vol'),
        message:
          `📊 <b>Volume spike: ${name(p.symbol, p.mint)}</b>\n` +
          `Last-hour volume ${formatUsd(snap.volume1h)} is ${ratio.toFixed(1)}× the 24h hourly average (${formatUsd(snap.volume24h / 24)}).`,
      };
    }
    case 'token_activity': {
      const p = parseAlertParams('token_activity', alert.params);
      if (!p || !snap.txns1h || !snap.txns24h || snap.txns24h <= 0) return { triggered: false, state };
      const ratio = snap.txns1h / (snap.txns24h / 24);
      if (ratio < p.multiplier || cooling) return { triggered: false, state: { ...state, lastRatio: ratio } };
      return {
        triggered: true,
        state: { ...state, lastRatio: ratio },
        dedupeKey: key('act'),
        message:
          `⚡ <b>Trading activity: ${name(p.symbol, p.mint)}</b>\n` +
          `${snap.txns1h} DEX trades in the last hour — ${ratio.toFixed(1)}× the 24h hourly average (${(snap.txns24h / 24).toFixed(0)}).`,
      };
    }
    case 'liquidity_change': {
      const p = parseAlertParams('liquidity_change', alert.params);
      if (!p || snap.liquidityUsd === null) return { triggered: false, state };
      const baseline = typeof state.baseline === 'number' ? state.baseline : null;
      if (baseline === null || baseline <= 0) return { triggered: false, state: { ...state, baseline: snap.liquidityUsd, baselineAt: now } };
      const change = ((snap.liquidityUsd - baseline) / baseline) * 100;
      if (Math.abs(change) < p.percent || cooling) return { triggered: false, state };
      return {
        triggered: true,
        state: { baseline: snap.liquidityUsd, baselineAt: now },
        dedupeKey: key('liq'),
        message:
          `💧 <b>Liquidity change: ${name(p.symbol, p.mint)}</b>\n` +
          `Pool liquidity ${formatPct(change)} (${formatUsd(baseline)} → ${formatUsd(snap.liquidityUsd)}).`,
      };
    }
    default:
      return { triggered: false, state };
  }
}

/** True if `hour` (0–23 UTC) falls inside a quiet-hours window that may wrap midnight. */
export function isQuietHour(hour: number, start: number | null, end: number | null): boolean {
  if (start === null || end === null || start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
