/** Pure statistical helpers used across analytics. All functions are side-effect free. */

export function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Sample standard deviation. */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from === null || from === undefined || to === null || to === undefined) return null;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!;
    const b = closes[i]!;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

/**
 * Annualised volatility (%) from close prices sampled every `periodHours`.
 * Crypto trades 24/7, so a year is 365 days.
 */
export function annualizedVolatility(closes: number[], periodHours = 24): number | null {
  const r = logReturns(closes);
  if (r.length < 5) return null;
  const sd = stdev(r);
  if (!Number.isFinite(sd)) return null;
  const periodsPerYear = (365 * 24) / periodHours;
  return sd * Math.sqrt(periodsPerYear) * 100;
}

/** Largest peak-to-trough decline (%) — returned as a positive number. */
export function maxDrawdown(closes: number[]): number | null {
  if (closes.length < 2) return null;
  let peak = closes[0]!;
  let mdd = 0;
  for (const c of closes) {
    if (c > peak) peak = c;
    if (peak > 0) mdd = Math.max(mdd, (peak - c) / peak);
  }
  return mdd * 100;
}

export function zScore(value: number, series: number[]): number | null {
  if (series.length < 5) return null;
  const sd = stdev(series);
  if (!Number.isFinite(sd) || sd === 0) return null;
  return (value - mean(series)) / sd;
}

export interface VolumeAnomaly {
  /** Ratio of the recent window's rate to the baseline rate. */
  ratio: number | null;
  zScore: number | null;
  unusual: boolean;
  basis: string;
}

/** Short-window check using DexScreener rolling windows: last hour vs the 24h hourly average. */
export function hourlyVolumeAnomaly(h1: number | null | undefined, h24: number | null | undefined, threshold = 3): VolumeAnomaly {
  if (!h1 || !h24 || h24 <= 0) return { ratio: null, zScore: null, unusual: false, basis: 'insufficient volume data' };
  const ratio = h1 / (h24 / 24);
  return { ratio, zScore: null, unusual: ratio >= threshold, basis: 'last-hour volume vs 24h hourly average' };
}

/** Daily check using candle history: latest complete day vs the prior days. */
export function dailyVolumeAnomaly(volumes: number[], threshold = 2.5): VolumeAnomaly {
  if (volumes.length < 8) return { ratio: null, zScore: null, unusual: false, basis: 'fewer than 8 days of volume history' };
  const latest = volumes[volumes.length - 1]!;
  const prior = volumes.slice(0, -1);
  const avg = mean(prior);
  const z = zScore(latest, prior);
  return {
    ratio: avg > 0 ? latest / avg : null,
    zScore: z,
    unusual: z !== null && z >= threshold,
    basis: `latest day vs previous ${prior.length} days`,
  };
}

/** Herfindahl–Hirschman index over shares (0..1). 1 = one holder owns everything. */
export function hhi(shares: number[]): number {
  return shares.reduce((s, x) => s + x * x, 0);
}
