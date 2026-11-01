/**
 * Formatting helpers for Telegram HTML messages.
 * All user/third-party strings must pass through `escapeHtml` before being
 * embedded in a message sent with parse_mode=HTML.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function lamportsToSol(lamports: number): number {
  return lamports / LAMPORTS_PER_SOL;
}

export function shortAddr(addr: string, chars = 4): string {
  return addr.length <= chars * 2 + 1 ? addr : `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}

/** Formats a USD value. Very small prices keep significant digits; large values are compacted. */
export function formatUsd(value: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (opts.compact !== false && abs >= 1_000_000_000) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (opts.compact !== false && abs >= 1_000_000) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (opts.compact !== false && abs >= 10_000) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (abs === 0) return '$0.00';
  if (abs >= 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toPrecision(4)}`;
}

export function formatPrice(value: number | null | undefined): string {
  return formatUsd(value, { compact: false });
}

export function formatNumber(value: number | null | undefined, maxFractionDigits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}K`;
  if (abs > 0 && abs < 0.0001) return value.toPrecision(3);
  return value.toLocaleString('en-US', { maximumFractionDigits: abs < 1 ? 6 : maxFractionDigits });
}

export function formatSol(sol: number | null | undefined, digits = 4): string {
  if (sol === null || sol === undefined || !Number.isFinite(sol)) return 'n/a';
  const abs = Math.abs(sol);
  if (abs >= 1e4) return `${formatNumber(sol)} SOL`;
  return `${sol.toLocaleString('en-US', { maximumFractionDigits: abs < 0.001 && abs > 0 ? 9 : digits })} SOL`;
}

export function formatPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function trendEmoji(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return '▫️';
  return value > 0 ? '🟢' : '🔴';
}

export function formatDate(unixSec: number | null | undefined): string {
  if (!unixSec) return 'unknown';
  return new Date(unixSec * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

export function formatAge(fromUnixSec: number, nowMs = Date.now()): string {
  const secs = Math.max(0, Math.floor(nowMs / 1000 - fromUnixSec));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  const days = Math.floor(secs / 86400);
  if (days < 365) return `${days}d`;
  const years = Math.floor(days / 365);
  return `${years}y ${days % 365}d`;
}

export function relativeTime(unixSec: number | null | undefined, nowMs = Date.now()): string {
  if (!unixSec) return 'unknown time';
  return `${formatAge(unixSec, nowMs)} ago`;
}

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
export const solscanAccount = (addr: string) => `https://solscan.io/account/${addr}`;
export const solscanToken = (mint: string) => `https://solscan.io/token/${mint}`;

export function link(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

export function code(s: string): string {
  return `<code>${escapeHtml(s)}</code>`;
}

/** Splits long messages to respect Telegram's 4096 character limit, breaking on newlines. */
export function splitMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > limit) {
      if (current) parts.push(current);
      current = line.length > limit ? line.slice(0, limit) : line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}
