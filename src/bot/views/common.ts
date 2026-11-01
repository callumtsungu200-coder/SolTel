import type { Provenance } from '../../analytics/token.js';
import { categoryLabel, type WalletTxView } from '../../services/transactions.js';
import { escapeHtml, formatDate, formatNumber, formatSol, link, shortAddr, solscanTx } from '../../utils/format.js';

export const PROV_ICON: Record<Provenance, string> = { verified: '✅', market: '📈', estimated: '📐', unavailable: '❔' };

export const LEGEND = '<i>✅ on-chain · 📈 market data · 📐 estimate · ❔ unavailable</i>';

export type SymbolLookup = (mint: string) => string;

/** Multi-line, human-readable description of a wallet-relative transaction. */
export function txBlock(v: WalletTxView, sym: SymbolLookup, index?: number): string {
  const head = `${index !== undefined ? `${index}. ` : ''}${categoryLabel(v)} · ${formatDate(v.tx.timestamp)}`;
  const parts: string[] = [];
  if (v.solIn > 0) parts.push(`+${formatSol(v.solIn)}`);
  if (v.solOut > 0) parts.push(`-${formatSol(v.solOut)}`);
  for (const t of v.tokensIn.slice(0, 3)) parts.push(`+${formatNumber(t.amount)} ${escapeHtml(sym(t.mint))}`);
  for (const t of v.tokensOut.slice(0, 3)) parts.push(`-${formatNumber(t.amount)} ${escapeHtml(sym(t.mint))}`);
  const extra = v.tokensIn.length + v.tokensOut.length > 6 ? ' …' : '';
  const lines = [head];
  if (parts.length) lines.push(`   ${parts.join(' · ')}${extra}`);
  if (v.tx.source) lines.push(`   via ${escapeHtml(v.tx.source)}`);
  if (!v.tx.success && v.tx.errorText) lines.push(`   error: ${escapeHtml(v.tx.errorText)}`);
  lines.push(`   ${link(solscanTx(v.tx.signature), shortAddr(v.tx.signature, 6))}`);
  return lines.join('\n');
}
