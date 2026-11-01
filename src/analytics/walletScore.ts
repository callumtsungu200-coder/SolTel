/**
 * Wallet Activity Score (0–100).
 *
 * Describes how active a wallet has been in the observed window. It is NOT a
 * measure of trustworthiness, skill or profitability and it does NOT predict
 * future returns. Methodology (also in docs/METHODOLOGY.md):
 *
 *  Component        Max  Formula
 *  Frequency         35  35 × min(1, log10(1 + tx/day) / log10(51))
 *  Recency           20  ≤1d: 20, ≤7d: 14, ≤30d: 8, ≤90d: 3, else 0
 *  Counterparties    20  20 × min(1, log2(1 + unique) / log2(51))
 *  Token breadth     15  15 × min(1, distinct mints moved / 20)
 *  Longevity         10  min(10, age days / 36.5)  (lower bound if age unknown)
 *
 * Logarithmic scaling stops very high-frequency bots from dominating.
 */

export interface ScoreInputs {
  txPerDay: number;
  hoursSinceLastTx: number | null;
  uniqueCounterparties: number;
  distinctMints: number;
  ageDays: number | null;
}

export interface ActivityScore {
  total: number;
  label: 'Dormant' | 'Low' | 'Moderate' | 'Active' | 'Very active';
  components: { frequency: number; recency: number; counterparties: number; tokenBreadth: number; longevity: number };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function computeActivityScore(i: ScoreInputs): ActivityScore {
  const frequency = 35 * Math.min(1, Math.log10(1 + Math.max(0, i.txPerDay)) / Math.log10(51));
  let recency = 0;
  if (i.hoursSinceLastTx !== null) {
    const h = i.hoursSinceLastTx;
    recency = h <= 24 ? 20 : h <= 24 * 7 ? 14 : h <= 24 * 30 ? 8 : h <= 24 * 90 ? 3 : 0;
  }
  const counterparties = 20 * Math.min(1, Math.log2(1 + Math.max(0, i.uniqueCounterparties)) / Math.log2(51));
  const tokenBreadth = 15 * Math.min(1, Math.max(0, i.distinctMints) / 20);
  const longevity = i.ageDays === null ? 0 : Math.min(10, Math.max(0, i.ageDays) / 36.5);
  const total = Math.round(frequency + recency + counterparties + tokenBreadth + longevity);
  const label: ActivityScore['label'] =
    total <= 20 ? 'Dormant' : total <= 40 ? 'Low' : total <= 60 ? 'Moderate' : total <= 80 ? 'Active' : 'Very active';
  return {
    total,
    label,
    components: {
      frequency: round1(frequency),
      recency: round1(recency),
      counterparties: round1(counterparties),
      tokenBreadth: round1(tokenBreadth),
      longevity: round1(longevity),
    },
  };
}
