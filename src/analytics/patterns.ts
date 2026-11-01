import type { WalletTxView } from '../services/transactions.js';

/** Historical transaction pattern analysis over a set of wallet-relative transactions. */

export interface CounterpartyStat {
  address: string;
  txCount: number;
  solSent: number;
  solReceived: number;
  lastSeen: number | null;
}

export interface PatternSummary {
  hourHistogram: number[];
  weekdayCounts: number[];
  busiestHourUtc: number | null;
  topCounterparties: CounterpartyStat[];
  topSources: Array<{ source: string; count: number }>;
  categoryCounts: Record<string, number>;
  medianGapMinutes: number | null;
}

export function analyzePatterns(views: WalletTxView[]): PatternSummary {
  const hourHistogram = new Array<number>(24).fill(0);
  const weekdayCounts = new Array<number>(7).fill(0);
  const cp = new Map<string, CounterpartyStat>();
  const sources = new Map<string, number>();
  const categoryCounts: Record<string, number> = {};
  const times: number[] = [];

  for (const v of views) {
    categoryCounts[v.category] = (categoryCounts[v.category] ?? 0) + 1;
    if (v.tx.timestamp) {
      const d = new Date(v.tx.timestamp * 1000);
      hourHistogram[d.getUTCHours()]!++;
      weekdayCounts[d.getUTCDay()]!++;
      times.push(v.tx.timestamp);
    }
    if (v.tx.source) sources.set(v.tx.source, (sources.get(v.tx.source) ?? 0) + 1);
    for (const addr of v.counterparties) {
      const s = cp.get(addr) ?? { address: addr, txCount: 0, solSent: 0, solReceived: 0, lastSeen: null };
      s.txCount++;
      // Attribute native transfers precisely per counterparty.
      for (const t of v.tx.nativeTransfers) {
        if (t.from === v.wallet && t.to === addr) s.solSent += t.lamports / 1e9;
        if (t.to === v.wallet && t.from === addr) s.solReceived += t.lamports / 1e9;
      }
      if (v.tx.timestamp && (s.lastSeen === null || v.tx.timestamp > s.lastSeen)) s.lastSeen = v.tx.timestamp;
      cp.set(addr, s);
    }
  }

  times.sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push((times[i]! - times[i - 1]!) / 60);
  gaps.sort((a, b) => a - b);
  const medianGapMinutes = gaps.length ? gaps[Math.floor(gaps.length / 2)]! : null;

  const maxHour = Math.max(...hourHistogram);
  return {
    hourHistogram,
    weekdayCounts,
    busiestHourUtc: maxHour > 0 ? hourHistogram.indexOf(maxHour) : null,
    topCounterparties: [...cp.values()].sort((a, b) => b.txCount - a.txCount).slice(0, 10),
    topSources: [...sources.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    categoryCounts,
    medianGapMinutes,
  };
}

/** All observed interactions between `wallet` and `other` (direct SOL/token movements). */
export function interactionHistory(views: WalletTxView[], other: string): WalletTxView[] {
  return views.filter((v) => v.counterparties.includes(other));
}
