/**
 * Test fixtures shaped exactly like the documented API responses
 * (Helius Parsed Events, Helius enhanced webhooks, Solana RPC jsonParsed,
 * DexScreener pairs). Addresses are real mainnet addresses so validation
 * logic is exercised for real.
 */
import { randomBytes } from 'node:crypto';
import type { DexPair } from '../../src/clients/dexscreener.js';
import { base58Encode, USDC_MINT, WSOL_MINT } from '../../src/validation/address.js';

export const WALLET = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
export const OTHER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
export const POOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
export const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export { USDC_MINT, WSOL_MINT };

export const sig = () => base58Encode(randomBytes(64));

export function parsedSwapEnvelope(signature = sig()) {
  return {
    signature,
    parserStatus: 'OK',
    parsed: {
      slot: 300000001,
      blockTime: 1_761_000_000,
      fee: 5000,
      feePayer: WALLET,
      transactionStatus: 'OK',
      nativeTransfers: [],
      tokenTransfers: [
        { fromUserAccount: WALLET, toUserAccount: POOL, fromTokenAccount: 'a', toTokenAccount: 'b', rawTokenAmount: 1_500_000_000, decimals: 9, tokenStandard: 'Fungible', mint: WSOL_MINT },
        { fromUserAccount: POOL, toUserAccount: WALLET, fromTokenAccount: 'c', toTokenAccount: 'd', rawTokenAmount: '225500000', decimals: 6, tokenStandard: 'Fungible', mint: USDC_MINT },
      ],
      summary: { type: 'swap', description: 'swapped 1.5 SOL for 225.5 USDC via Jupiter', parsedData: { protocol: 'jupiter', kind: 'swap' } },
      instructions: [
        { programId: 'ComputeBudget111111111111111111111111111111', programName: 'Compute Budget' },
        { programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', programName: 'Jupiter' },
      ],
    },
  };
}

export function parsedTransferEnvelope(opts: { from: string; to: string; lamports: number; signature?: string; blockTime?: number }) {
  return {
    signature: opts.signature ?? sig(),
    parserStatus: 'OK',
    parsed: {
      slot: 300000002,
      blockTime: opts.blockTime ?? 1_761_000_100,
      fee: 5000,
      feePayer: opts.from,
      transactionStatus: 'OK',
      nativeTransfers: [{ fromUserAccount: opts.from, toUserAccount: opts.to, amount: opts.lamports }],
      tokenTransfers: [],
      summary: { type: 'transfer', description: 'transfer', parsedData: null },
      instructions: [{ programId: '11111111111111111111111111111111', programName: 'System Program' }],
    },
  };
}

export function parsedTokenTransferEnvelope(opts: { from: string; to: string; mint: string; raw: number; decimals: number; blockTime?: number }) {
  return {
    signature: sig(),
    parserStatus: 'OK',
    parsed: {
      slot: 300000003,
      blockTime: opts.blockTime ?? 1_761_000_200,
      fee: 5000,
      feePayer: opts.from,
      transactionStatus: 'OK',
      nativeTransfers: [],
      tokenTransfers: [{ fromUserAccount: opts.from, toUserAccount: opts.to, rawTokenAmount: opts.raw, decimals: opts.decimals, mint: opts.mint }],
      summary: { type: 'transfer', description: null, parsedData: null },
      instructions: [],
    },
  };
}

export function parsedFailedEnvelope() {
  return {
    signature: sig(),
    parserStatus: 'OK',
    parsed: {
      slot: 300000004,
      blockTime: 1_761_000_300,
      fee: 5000,
      feePayer: WALLET,
      transactionStatus: 'ERROR',
      error: { InstructionError: [1, { Custom: 6001 }] },
      decodedError: { name: 'SlippageToleranceExceeded', msg: null },
      nativeTransfers: [],
      tokenTransfers: [],
      summary: null,
      instructions: [],
    },
  };
}

/** Enhanced webhook payload item (format documented in Helius Webhooks API). */
export function enhancedTransfer(signature = sig()) {
  return {
    description: `${WALLET} transferred 2 SOL to ${OTHER}`,
    type: 'TRANSFER',
    source: 'SYSTEM_PROGRAM',
    fee: 5000,
    feePayer: WALLET,
    signature,
    slot: 300000010,
    timestamp: 1_761_000_500,
    nativeTransfers: [{ fromUserAccount: WALLET, toUserAccount: OTHER, amount: 2_000_000_000 }],
    tokenTransfers: [],
    accountData: [
      { account: WALLET, nativeBalanceChange: -2_000_005_000, tokenBalanceChanges: [] },
      { account: OTHER, nativeBalanceChange: 2_000_000_000, tokenBalanceChanges: [] },
    ],
    transactionError: null,
  };
}

/** getTransaction(jsonParsed) result: OTHER sends 0.5 SOL and 10 USDC to WALLET. */
export function rpcTransaction() {
  return {
    slot: 300000020,
    blockTime: 1_761_000_900,
    meta: {
      err: null,
      fee: 5000,
      preBalances: [10_000_000_000, 1_000_000_000, 1],
      postBalances: [9_499_995_000, 1_500_000_000, 1],
      preTokenBalances: [
        { accountIndex: 3, mint: USDC_MINT, owner: OTHER, uiTokenAmount: { amount: '50000000', decimals: 6, uiAmount: 50, uiAmountString: '50' } },
        { accountIndex: 4, mint: USDC_MINT, owner: WALLET, uiTokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' } },
      ],
      postTokenBalances: [
        { accountIndex: 3, mint: USDC_MINT, owner: OTHER, uiTokenAmount: { amount: '40000000', decimals: 6, uiAmount: 40, uiAmountString: '40' } },
        { accountIndex: 4, mint: USDC_MINT, owner: WALLET, uiTokenAmount: { amount: '10000000', decimals: 6, uiAmount: 10, uiAmountString: '10' } },
      ],
      logMessages: [],
    },
    transaction: {
      signatures: ['x'],
      message: {
        accountKeys: [
          { pubkey: OTHER, signer: true, writable: true },
          { pubkey: WALLET, signer: false, writable: true },
          { pubkey: '11111111111111111111111111111111', signer: false, writable: false },
        ],
        instructions: [{ programId: '11111111111111111111111111111111' }],
      },
    },
  };
}

export function dexPair(over: Partial<DexPair> & { base: string; quote?: string; liq?: number; price?: string; priceNative?: string }): DexPair {
  const { base, quote, liq, price, priceNative, ...rest } = over;
  return {
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress: rest.pairAddress ?? base.slice(0, 20) + 'PAIRxxxxxxxxxxxxxxxxxxxx',
    baseToken: { address: base, name: 'Token', symbol: 'TKN' },
    quoteToken: { address: quote ?? WSOL_MINT, name: 'Wrapped SOL', symbol: 'SOL' },
    priceNative: priceNative ?? '0.01',
    priceUsd: price ?? '1.0',
    txns: { h1: { buys: 10, sells: 5 }, h24: { buys: 200, sells: 160 } },
    volume: { h1: 1000, h6: 6000, h24: 24000 },
    priceChange: { m5: 0.1, h1: 1, h6: 2, h24: 5 },
    liquidity: { usd: liq ?? 50_000, base: 1, quote: 1 },
    fdv: 1_000_000,
    marketCap: 900_000,
    pairCreatedAt: Date.now() - 30 * 86400_000,
    ...rest,
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
