import { z } from 'zod';
import type { ParsedItem } from '../clients/helius.js';
import type { RpcTransaction } from '../clients/solanaRpc.js';
import { LAMPORTS_PER_SOL } from '../utils/format.js';

/**
 * Transaction normalisation.
 *
 * Three input formats are converted into one `NormalizedTx`:
 *  - Helius Parsed Events (history + signature parsing)
 *  - Helius enhanced webhook payloads (real-time monitoring)
 *  - Raw `getTransaction` (jsonParsed) from Solana RPC (fallback)
 *
 * Classification rules (see docs/METHODOLOGY.md):
 *  - A transaction is only labelled "swap" when the data provider itself
 *    classified it as a swap. We never label anything a "buy" or "sell".
 *  - Plain transfers are always "transfer", even when large.
 *  - Wallet-relative amounts come from balance changes when the source
 *    provides them (webhook accountData, RPC pre/post balances), otherwise
 *    from the transfer list.
 */

export interface NativeTransfer {
  from: string | null;
  to: string | null;
  lamports: number;
}

export interface TokenTransfer {
  from: string | null;
  to: string | null;
  mint: string;
  /** Decimal-adjusted amount. */
  amount: number;
}

export interface NativeBalanceChange {
  account: string;
  lamports: number;
}

export interface TokenBalanceChange {
  owner: string;
  mint: string;
  amount: number;
}

export type TxProvider = 'helius-parsed-events' | 'helius-webhook' | 'rpc';

export interface NormalizedTx {
  signature: string;
  slot: number;
  timestamp: number | null;
  fee: number;
  feePayer: string | null;
  success: boolean;
  errorText: string | null;
  /** Provider classification, upper-case (e.g. SWAP, TRANSFER, UNKNOWN). */
  type: string;
  source: string | null;
  description: string | null;
  nativeTransfers: NativeTransfer[];
  tokenTransfers: TokenTransfer[];
  nativeChanges?: NativeBalanceChange[];
  tokenChanges?: TokenBalanceChange[];
  provider: TxProvider;
}

const IGNORED_PROGRAM_NAMES = new Set(['compute budget', 'computebudget', 'system program', 'system', 'memo']);

function toUi(raw: number | string, decimals: number): number {
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isFinite(n)) return 0;
  return n / 10 ** decimals;
}

// ---------- Helius Parsed Events ----------

export function normalizeParsedEvent(item: ParsedItem): NormalizedTx {
  const { tx } = item;
  const summaryType = tx.summary?.type?.toUpperCase() ?? null;
  const protocol = typeof tx.summary?.parsedData?.protocol === 'string' ? (tx.summary.parsedData.protocol as string) : null;
  const program = tx.instructions.find((i) => i.programName && !IGNORED_PROGRAM_NAMES.has(i.programName.toLowerCase()))?.programName ?? null;
  const failed = tx.transactionStatus === 'ERROR' || (tx.error !== undefined && tx.error !== null);
  return {
    signature: item.signature,
    slot: tx.slot,
    timestamp: tx.blockTime ?? null,
    fee: tx.fee,
    feePayer: tx.feePayer ?? null,
    success: !failed,
    errorText: failed ? (tx.decodedError?.name ?? tx.decodedError?.msg ?? 'Transaction failed') : null,
    type: summaryType ?? (tx.tokenTransfers.length || tx.nativeTransfers.length ? 'UNCLASSIFIED' : 'UNKNOWN'),
    source: protocol ?? program,
    description: tx.summary?.description ?? null,
    nativeTransfers: tx.nativeTransfers.map((t) => ({ from: t.fromUserAccount ?? null, to: t.toUserAccount ?? null, lamports: t.amount })),
    tokenTransfers: tx.tokenTransfers.map((t) => ({
      from: t.fromUserAccount ?? null,
      to: t.toUserAccount ?? null,
      mint: t.mint,
      amount: toUi(t.rawTokenAmount, t.decimals),
    })),
    provider: 'helius-parsed-events',
  };
}

// ---------- Helius enhanced webhook ----------

export const enhancedTxSchema = z
  .object({
    signature: z.string(),
    slot: z.number().default(0),
    timestamp: z.number().nullable().optional(),
    type: z.string().nullable().optional(),
    source: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    fee: z.number().default(0),
    feePayer: z.string().nullable().optional(),
    transactionError: z.unknown().optional(),
    nativeTransfers: z
      .array(z.object({ fromUserAccount: z.string().nullable().optional(), toUserAccount: z.string().nullable().optional(), amount: z.number() }).loose())
      .nullable()
      .optional(),
    tokenTransfers: z
      .array(
        z
          .object({
            fromUserAccount: z.string().nullable().optional(),
            toUserAccount: z.string().nullable().optional(),
            tokenAmount: z.union([z.number(), z.string()]),
            mint: z.string(),
          })
          .loose(),
      )
      .nullable()
      .optional(),
    accountData: z
      .array(
        z
          .object({
            account: z.string(),
            nativeBalanceChange: z.number().optional(),
            tokenBalanceChanges: z
              .array(
                z
                  .object({
                    userAccount: z.string(),
                    mint: z.string(),
                    rawTokenAmount: z.object({ tokenAmount: z.string(), decimals: z.number() }).loose(),
                  })
                  .loose(),
              )
              .nullable()
              .optional(),
          })
          .loose(),
      )
      .nullable()
      .optional(),
  })
  .loose();
export type EnhancedTx = z.infer<typeof enhancedTxSchema>;

export function normalizeEnhanced(tx: EnhancedTx): NormalizedTx {
  const failed = tx.transactionError !== undefined && tx.transactionError !== null;
  const nativeChanges: NativeBalanceChange[] = [];
  const tokenChanges: TokenBalanceChange[] = [];
  for (const acc of tx.accountData ?? []) {
    if (acc.nativeBalanceChange) nativeChanges.push({ account: acc.account, lamports: acc.nativeBalanceChange });
    for (const tc of acc.tokenBalanceChanges ?? []) {
      tokenChanges.push({ owner: tc.userAccount, mint: tc.mint, amount: toUi(tc.rawTokenAmount.tokenAmount, tc.rawTokenAmount.decimals) });
    }
  }
  return {
    signature: tx.signature,
    slot: tx.slot,
    timestamp: tx.timestamp ?? null,
    fee: tx.fee,
    feePayer: tx.feePayer ?? null,
    success: !failed,
    errorText: failed ? 'Transaction failed' : null,
    type: (tx.type ?? 'UNKNOWN').toUpperCase(),
    source: tx.source && tx.source !== 'UNKNOWN' ? tx.source : null,
    description: tx.description || null,
    nativeTransfers: (tx.nativeTransfers ?? []).map((t) => ({ from: t.fromUserAccount ?? null, to: t.toUserAccount ?? null, lamports: t.amount })),
    tokenTransfers: (tx.tokenTransfers ?? []).map((t) => ({
      from: t.fromUserAccount ?? null,
      to: t.toUserAccount ?? null,
      mint: t.mint,
      amount: Number(t.tokenAmount) || 0,
    })),
    nativeChanges,
    tokenChanges,
    provider: 'helius-webhook',
  };
}

// ---------- Raw RPC ----------

export function normalizeRpcTx(signature: string, tx: RpcTransaction): NormalizedTx {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const meta = tx.meta;
  const nativeChanges: NativeBalanceChange[] = [];
  const tokenChanges: TokenBalanceChange[] = [];
  if (meta) {
    keys.forEach((key, i) => {
      const delta = (meta.postBalances[i] ?? 0) - (meta.preBalances[i] ?? 0);
      if (delta !== 0) nativeChanges.push({ account: key, lamports: delta });
    });
    const byKey = new Map<string, TokenBalanceChange>();
    const apply = (list: typeof meta.preTokenBalances, sign: 1 | -1) => {
      for (const b of list ?? []) {
        if (!b.owner) continue;
        const k = `${b.owner}:${b.mint}`;
        const amount = Number(b.uiTokenAmount.uiAmountString ?? b.uiTokenAmount.uiAmount ?? 0) * sign;
        const cur = byKey.get(k) ?? { owner: b.owner, mint: b.mint, amount: 0 };
        cur.amount += amount;
        byKey.set(k, cur);
      }
    };
    apply(meta.postTokenBalances, 1);
    apply(meta.preTokenBalances, -1);
    for (const c of byKey.values()) if (Math.abs(c.amount) > 0) tokenChanges.push(c);
  }
  const failed = meta ? meta.err !== null && meta.err !== undefined : false;
  return {
    signature,
    slot: tx.slot,
    timestamp: tx.blockTime ?? null,
    fee: meta?.fee ?? 0,
    feePayer: keys[0] ?? null,
    success: !failed,
    errorText: failed ? 'Transaction failed' : null,
    // Raw RPC data carries no semantic classification; we do not guess one.
    type: 'UNCLASSIFIED',
    source: null,
    description: null,
    nativeTransfers: [],
    tokenTransfers: [],
    nativeChanges,
    tokenChanges,
    provider: 'rpc',
  };
}

// ---------- Wallet-relative view ----------

export type Direction = 'incoming' | 'outgoing' | 'mixed' | 'none';
export type Category = 'swap' | 'transfer' | 'failed' | 'other';

export interface TokenAmount {
  mint: string;
  amount: number;
}

export interface WalletTxView {
  tx: NormalizedTx;
  wallet: string;
  /** SOL received (excluding fees). */
  solIn: number;
  /** SOL sent (excluding fees). */
  solOut: number;
  /** Net SOL change for the wallet including fees paid. */
  solNet: number;
  feePaidSol: number;
  tokensIn: TokenAmount[];
  tokensOut: TokenAmount[];
  counterparties: string[];
  direction: Direction;
  category: Category;
}

/** Ignore dust-level SOL movements (e.g. rent refunds < 0.000001 SOL) when deciding direction. */
const SOL_EPSILON = 0.000001;

export function walletView(tx: NormalizedTx, wallet: string): WalletTxView {
  const feePaidSol = tx.feePayer === wallet ? tx.fee / LAMPORTS_PER_SOL : 0;
  let solIn = 0;
  let solOut = 0;
  const counterparties = new Set<string>();

  for (const t of tx.nativeTransfers) {
    if (t.to === wallet && t.from !== wallet) {
      solIn += t.lamports / LAMPORTS_PER_SOL;
      if (t.from) counterparties.add(t.from);
    } else if (t.from === wallet && t.to !== wallet) {
      solOut += t.lamports / LAMPORTS_PER_SOL;
      if (t.to) counterparties.add(t.to);
    }
  }

  let solNet: number;
  const nativeChange = tx.nativeChanges?.find((c) => c.account === wallet);
  if (tx.nativeChanges && tx.nativeChanges.length > 0) {
    solNet = (nativeChange?.lamports ?? 0) / LAMPORTS_PER_SOL;
    // When only balance deltas exist (RPC), derive in/out from the fee-adjusted delta.
    if (tx.nativeTransfers.length === 0) {
      const exFee = solNet + feePaidSol;
      if (exFee > 0) solIn = exFee;
      else if (exFee < 0) solOut = -exFee;
    }
  } else {
    solNet = solIn - solOut - feePaidSol;
  }

  const tokenNet = new Map<string, number>();
  if (tx.tokenChanges && tx.tokenChanges.length > 0) {
    for (const c of tx.tokenChanges) if (c.owner === wallet) tokenNet.set(c.mint, (tokenNet.get(c.mint) ?? 0) + c.amount);
  }
  const fromTransfers = tokenNet.size === 0;
  for (const t of tx.tokenTransfers) {
    if (t.to === wallet && t.from !== wallet) {
      if (fromTransfers) tokenNet.set(t.mint, (tokenNet.get(t.mint) ?? 0) + t.amount);
      if (t.from) counterparties.add(t.from);
    } else if (t.from === wallet && t.to !== wallet) {
      if (fromTransfers) tokenNet.set(t.mint, (tokenNet.get(t.mint) ?? 0) - t.amount);
      if (t.to) counterparties.add(t.to);
    }
  }
  const tokensIn: TokenAmount[] = [];
  const tokensOut: TokenAmount[] = [];
  for (const [mint, amount] of tokenNet) {
    if (amount > 0) tokensIn.push({ mint, amount });
    else if (amount < 0) tokensOut.push({ mint, amount: -amount });
  }

  const hasIn = solIn > SOL_EPSILON || tokensIn.length > 0;
  const hasOut = solOut > SOL_EPSILON || tokensOut.length > 0;
  const direction: Direction = hasIn && hasOut ? 'mixed' : hasIn ? 'incoming' : hasOut ? 'outgoing' : 'none';

  let category: Category;
  if (!tx.success) category = 'failed';
  else if (tx.type === 'SWAP') category = 'swap';
  else if (tx.type === 'TRANSFER' || ((tx.type === 'UNCLASSIFIED' || tx.type === 'UNKNOWN') && direction !== 'none' && direction !== 'mixed')) category = 'transfer';
  else category = 'other';

  counterparties.delete(wallet);
  return { tx, wallet, solIn, solOut, solNet, feePaidSol, tokensIn, tokensOut, counterparties: [...counterparties], direction, category };
}

/** Human label used in feeds; deliberately avoids buy/sell wording. */
export function categoryLabel(v: WalletTxView): string {
  switch (v.category) {
    case 'failed':
      return '❌ Failed transaction';
    case 'swap':
      return '🔄 Swap';
    case 'transfer':
      return v.direction === 'incoming' ? '📥 Transfer in' : v.direction === 'outgoing' ? '📤 Transfer out' : '↔️ Transfer';
    default: {
      const t = v.tx.type.replace(/_/g, ' ').toLowerCase();
      const label = t === 'unclassified' || t === 'unknown' ? 'Program interaction' : t.charAt(0).toUpperCase() + t.slice(1);
      return `⚙️ ${label}`;
    }
  }
}
