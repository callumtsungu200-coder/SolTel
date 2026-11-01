/**
 * Text charts that render in Telegram's monospace <pre> blocks.
 * Telegram has no native charting; these are dependency-free and work on
 * every client.
 */

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function sparkline(values: number[]): string {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return '';
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = max - min;
  return values
    .map((v) => {
      if (!Number.isFinite(v)) return ' ';
      if (range === 0) return BLOCKS[3];
      return BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(((v - min) / range) * BLOCKS.length))];
    })
    .join('');
}

export function bar(fraction: number, width = 12): string {
  const f = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const full = Math.round(f * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

export interface BarRow {
  label: string;
  value: number;
}

/** Horizontal bar chart of shares (values are normalised to the total). */
export function shareChart(rows: BarRow[], width = 12, labelWidth = 8): string {
  const total = rows.reduce((s, r) => s + Math.max(0, r.value), 0);
  if (total <= 0) return '(no priced assets)';
  return rows
    .map((r) => {
      const share = Math.max(0, r.value) / total;
      const label = r.label.length > labelWidth ? r.label.slice(0, labelWidth - 1) + '…' : r.label.padEnd(labelWidth);
      return `${label} ${bar(share, width)} ${(share * 100).toFixed(1).padStart(5)}%`;
    })
    .join('\n');
}

/** 24-column histogram (e.g. activity by UTC hour). */
export function hourHistogram(counts: number[]): string {
  const line = sparkline(counts.map((c) => c));
  return `${line}\n0     6     12    18   23 (UTC)`;
}
