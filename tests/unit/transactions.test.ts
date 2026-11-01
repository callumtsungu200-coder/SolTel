import { describe, expect, it } from 'vitest';
import { parseEnvelopes } from '../../src/clients/helius.js';
import { rpcTransactionSchema } from '../../src/clients/solanaRpc.js';
import {
  categoryLabel,
  enhancedTxSchema,
  normalizeEnhanced,
  normalizeParsedEvent,
  normalizeRpcTx,
  walletView,
} from '../../src/services/transactions.js';
import {
  enhancedTransfer,
  OTHER,
  parsedFailedEnvelope,
  parsedSwapEnvelope,
  parsedTokenTransferEnvelope,
  parsedTransferEnvelope,
  POOL,
  rpcTransaction,
  USDC_MINT,
  WALLET,
  WSOL_MINT,
} from '../fixtures/index.js';

const parse = (env: unknown) => normalizeParsedEvent(parseEnvelopes([env]).items[0]!);

describe('Parsed Events normalisation', () => {
  it('normalises a provider-classified swap with decimal-adjusted amounts', () => {
    const tx = parse(parsedSwapEnvelope());
    expect(tx.type).toBe('SWAP');
    expect(tx.source).toBe('jupiter');
    expect(tx.tokenTransfers.map((t) => t.amount)).toEqual([1.5, 225.5]);
    const v = walletView(tx, WALLET);
    expect(v.category).toBe('swap');
    expect(v.direction).toBe('mixed');
    expect(v.tokensOut).toEqual([{ mint: WSOL_MINT, amount: 1.5 }]);
    expect(v.tokensIn).toEqual([{ mint: USDC_MINT, amount: 225.5 }]);
    expect(v.counterparties).toEqual([POOL]);
    expect(v.feePaidSol).toBeCloseTo(0.000005);
  });

  it('classifies plain SOL transfers by direction relative to the wallet', () => {
    const out = walletView(parse(parsedTransferEnvelope({ from: WALLET, to: OTHER, lamports: 3_000_000_000 })), WALLET);
    expect(out).toMatchObject({ category: 'transfer', direction: 'outgoing', solOut: 3, solIn: 0 });
    expect(out.solNet).toBeCloseTo(-3.000005);

    const inn = walletView(parse(parsedTransferEnvelope({ from: OTHER, to: WALLET, lamports: 250_000_000 })), WALLET);
    expect(inn).toMatchObject({ category: 'transfer', direction: 'incoming', solIn: 0.25, feePaidSol: 0 });
  });

  it('never turns a large transfer into a swap/buy/sell', () => {
    const v = walletView(parse(parsedTokenTransferEnvelope({ from: OTHER, to: WALLET, mint: USDC_MINT, raw: 5_000_000_000_000, decimals: 6 })), WALLET);
    expect(v.category).toBe('transfer');
    expect(v.tokensIn[0]!.amount).toBe(5_000_000);
    const label = categoryLabel(v).toLowerCase();
    expect(label).not.toMatch(/buy|sell|purchase|sold|bought/);
    expect(label).toContain('transfer in');
  });

  it('marks failed transactions and keeps the decoded program error', () => {
    const tx = parse(parsedFailedEnvelope());
    expect(tx.success).toBe(false);
    expect(tx.errorText).toBe('SlippageToleranceExceeded');
    expect(walletView(tx, WALLET).category).toBe('failed');
  });

  it('handles transactions with no transfers and a null summary', () => {
    const env = parsedFailedEnvelope();
    env.parsed.transactionStatus = 'OK';
    delete (env.parsed as { error?: unknown }).error;
    const v = walletView(parse(env), WALLET);
    expect(v.direction).toBe('none');
    expect(v.category).toBe('other');
    expect(categoryLabel(v)).toContain('Program interaction');
  });
});

describe('enhanced webhook normalisation', () => {
  it('uses accountData balance changes for net SOL', () => {
    const parsed = enhancedTxSchema.parse(enhancedTransfer());
    const v = walletView(normalizeEnhanced(parsed), WALLET);
    expect(v.direction).toBe('outgoing');
    expect(v.solOut).toBe(2);
    expect(v.solNet).toBeCloseTo(-2.000005);
    const recv = walletView(normalizeEnhanced(parsed), OTHER);
    expect(recv.direction).toBe('incoming');
    expect(recv.solNet).toBe(2);
  });

  it('tolerates null arrays and missing optional fields', () => {
    const raw = { ...enhancedTransfer(), nativeTransfers: null, tokenTransfers: null, accountData: null, type: undefined, source: 'UNKNOWN' };
    const tx = normalizeEnhanced(enhancedTxSchema.parse(raw));
    expect(tx.type).toBe('UNKNOWN');
    expect(tx.source).toBeNull();
    expect(walletView(tx, WALLET).direction).toBe('none');
  });

  it('rejects payload items without a signature', () => {
    expect(enhancedTxSchema.safeParse({ type: 'TRANSFER' }).success).toBe(false);
  });
});

describe('raw RPC normalisation (fallback path)', () => {
  it('derives SOL and token movements from pre/post balances without guessing a type', () => {
    const raw = rpcTransactionSchema.parse(rpcTransaction());
    const tx = normalizeRpcTx('sig', raw);
    expect(tx.type).toBe('UNCLASSIFIED');
    expect(tx.feePayer).toBe(OTHER);
    const v = walletView(tx, WALLET);
    expect(v.solIn).toBeCloseTo(0.5);
    expect(v.tokensIn).toEqual([{ mint: USDC_MINT, amount: 10 }]);
    expect(v.direction).toBe('incoming');
    expect(v.category).toBe('transfer');

    const sender = walletView(tx, OTHER);
    expect(sender.feePaidSol).toBeCloseTo(0.000005);
    expect(sender.solOut).toBeCloseTo(0.5);
    expect(sender.tokensOut).toEqual([{ mint: USDC_MINT, amount: 10 }]);
  });

  it('treats a null meta as unknown rather than crashing', () => {
    const raw = rpcTransactionSchema.parse({ ...rpcTransaction(), meta: null });
    const tx = normalizeRpcTx('sig', raw);
    expect(tx.nativeChanges).toEqual([]);
    expect(walletView(tx, WALLET).direction).toBe('none');
  });
});
