import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { HttpClient, type FetchLike } from '../utils/http.js';
import { createLogger } from '../utils/logger.js';
import { TokenBucket } from '../utils/rateLimiter.js';

const log = createLogger('rpc');

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export const signatureInfoSchema = z.object({
  signature: z.string(),
  slot: z.number(),
  blockTime: z.number().nullable().optional(),
  err: z.unknown().nullable().optional(),
  memo: z.string().nullable().optional(),
  confirmationStatus: z.string().nullable().optional(),
});
export type SignatureInfo = z.infer<typeof signatureInfoSchema>;

const parsedTokenAmount = z.object({
  amount: z.string(),
  decimals: z.number(),
  uiAmount: z.number().nullable().optional(),
  uiAmountString: z.string().optional(),
});

export const tokenBalanceSchema = z.object({
  accountIndex: z.number(),
  mint: z.string(),
  owner: z.string().optional(),
  uiTokenAmount: parsedTokenAmount,
});

/** Subset of getTransaction(jsonParsed) we rely on. */
export const rpcTransactionSchema = z.object({
  slot: z.number(),
  blockTime: z.number().nullable().optional(),
  meta: z
    .object({
      err: z.unknown().nullable().optional(),
      fee: z.number(),
      preBalances: z.array(z.number()),
      postBalances: z.array(z.number()),
      preTokenBalances: z.array(tokenBalanceSchema).nullable().optional(),
      postTokenBalances: z.array(tokenBalanceSchema).nullable().optional(),
      logMessages: z.array(z.string()).nullable().optional(),
    })
    .nullable(),
  transaction: z.object({
    signatures: z.array(z.string()),
    message: z.object({
      accountKeys: z.array(
        z.union([z.string(), z.object({ pubkey: z.string(), signer: z.boolean().optional(), writable: z.boolean().optional() })]),
      ),
      instructions: z.array(z.object({ programId: z.string().optional() }).loose()).optional(),
    }),
  }),
});
export type RpcTransaction = z.infer<typeof rpcTransactionSchema>;

export interface ParsedTokenAccount {
  pubkey: string;
  mint: string;
  owner: string;
  amountRaw: string;
  decimals: number;
  uiAmount: number;
  program: 'spl-token' | 'spl-token-2022';
}

export interface MintInfo {
  decimals: number;
  supplyRaw: string;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  program: string;
}

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

/**
 * Plain JSON-RPC client with a primary endpoint (Helius) and a public
 * fallback. Read-only methods only — this bot never signs or sends
 * transactions.
 */
export class SolanaRpcClient {
  private readonly primary: HttpClient;
  private readonly fallback: HttpClient | null;
  private id = 0;

  constructor(
    private readonly primaryUrl: string,
    private readonly fallbackUrl: string | null,
    timeoutMs: number,
    fetchImpl?: FetchLike,
  ) {
    // Helius free tier allows ~10 RPC req/s; stay below it.
    this.primary = new HttpClient({ service: 'Solana RPC', timeoutMs, bucket: new TokenBucket(8, 8), fetchImpl });
    this.fallback = fallbackUrl
      ? new HttpClient({ service: 'Solana RPC (fallback)', timeoutMs, bucket: new TokenBucket(3, 2), maxRetries: 1, fetchImpl })
      : null;
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    try {
      return await this.callOn<T>(this.primary, this.primaryUrl, method, params);
    } catch (err) {
      if (!this.fallback || !this.fallbackUrl || !(err instanceof ApiError) || err.status === 400) throw err;
      log.warn('primary RPC failed, using fallback', { method, error: err.message });
      return this.callOn<T>(this.fallback, this.fallbackUrl, method, params);
    }
  }

  private async callOn<T>(client: HttpClient, url: string, method: string, params: unknown[]): Promise<T> {
    const body = { jsonrpc: '2.0', id: ++this.id, method, params };
    const res = await client.request<RpcResponse<T>>(url, { body });
    if (!res) throw new ApiError(`${client.service} returned an empty response`, client.service, undefined, true);
    if (res.error) {
      // -32005 / -32429 style codes are rate limits; -32004 etc are transient node errors.
      const retryable = [-32005, -32429, -32004, -32007, -32014].includes(res.error.code);
      throw new ApiError(`${client.service} error ${res.error.code}: ${res.error.message}`, client.service, retryable ? 503 : 400, retryable);
    }
    return res.result as T;
  }

  async getBalance(address: string): Promise<number> {
    const r = await this.call<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
    return r.value;
  }

  async getSignaturesForAddress(
    address: string,
    opts: { before?: string; until?: string; limit?: number } = {},
  ): Promise<SignatureInfo[]> {
    const raw = await this.call<unknown[]>('getSignaturesForAddress', [
      address,
      { limit: opts.limit ?? 1000, before: opts.before, until: opts.until, commitment: 'confirmed' },
    ]);
    return z.array(signatureInfoSchema).parse(raw ?? []);
  }

  async getTransaction(signature: string): Promise<RpcTransaction | null> {
    const raw = await this.call<unknown>('getTransaction', [
      signature,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
    if (raw === null) return null;
    return rpcTransactionSchema.parse(raw);
  }

  async getTokenAccountsByOwner(owner: string): Promise<ParsedTokenAccount[]> {
    const out: ParsedTokenAccount[] = [];
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const r = await this.call<{ value: Array<{ pubkey: string; account: { data: { parsed?: { info?: unknown }; program?: string } } }> }>(
        'getTokenAccountsByOwner',
        [owner, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      );
      for (const acc of r.value ?? []) {
        const info = z
          .object({ mint: z.string(), owner: z.string(), tokenAmount: parsedTokenAmount })
          .safeParse(acc.account.data.parsed?.info);
        if (!info.success) continue;
        out.push({
          pubkey: acc.pubkey,
          mint: info.data.mint,
          owner: info.data.owner,
          amountRaw: info.data.tokenAmount.amount,
          decimals: info.data.tokenAmount.decimals,
          uiAmount: Number(info.data.tokenAmount.uiAmountString ?? info.data.tokenAmount.uiAmount ?? 0),
          program: programId === TOKEN_PROGRAM_ID ? 'spl-token' : 'spl-token-2022',
        });
      }
    }
    return out;
  }

  async getTokenLargestAccounts(mint: string): Promise<Array<{ address: string; amountRaw: string; uiAmount: number; decimals: number }>> {
    const r = await this.call<{ value: Array<{ address: string; amount: string; decimals: number; uiAmount: number | null; uiAmountString?: string }> }>(
      'getTokenLargestAccounts',
      [mint, { commitment: 'confirmed' }],
    );
    return (r.value ?? []).map((a) => ({
      address: a.address,
      amountRaw: a.amount,
      decimals: a.decimals,
      uiAmount: Number(a.uiAmountString ?? a.uiAmount ?? 0),
    }));
  }

  async getTokenSupply(mint: string): Promise<{ amountRaw: string; decimals: number; uiAmount: number }> {
    const r = await this.call<{ value: { amount: string; decimals: number; uiAmount: number | null; uiAmountString?: string } }>(
      'getTokenSupply',
      [mint, { commitment: 'confirmed' }],
    );
    return { amountRaw: r.value.amount, decimals: r.value.decimals, uiAmount: Number(r.value.uiAmountString ?? r.value.uiAmount ?? 0) };
  }

  async getMintInfo(mint: string): Promise<MintInfo | null> {
    const r = await this.call<{ value: { owner: string; data: { parsed?: { type?: string; info?: Record<string, unknown> } } } | null }>(
      'getAccountInfo',
      [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }],
    );
    const parsed = r.value?.data?.parsed;
    if (!r.value || parsed?.type !== 'mint' || !parsed.info) return null;
    const info = parsed.info;
    return {
      decimals: Number(info.decimals ?? 0),
      supplyRaw: String(info.supply ?? '0'),
      mintAuthority: typeof info.mintAuthority === 'string' ? info.mintAuthority : null,
      freezeAuthority: typeof info.freezeAuthority === 'string' ? info.freezeAuthority : null,
      program: r.value.owner,
    };
  }

  /** Resolves token-account owners (wallets) for a set of token accounts. */
  async getTokenAccountOwners(accounts: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let i = 0; i < accounts.length; i += 100) {
      const chunk = accounts.slice(i, i + 100);
      const r = await this.call<{ value: Array<{ data: { parsed?: { info?: { owner?: string } } } } | null> }>(
        'getMultipleAccounts',
        [chunk, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      );
      r.value.forEach((acc, idx) => {
        const owner = acc?.data?.parsed?.info?.owner;
        if (owner) out.set(chunk[idx]!, owner);
      });
    }
    return out;
  }

  /** Returns account owner program, executable flag and lamports, or null if the account does not exist. */
  async getAccountBasics(address: string): Promise<{ owner: string; executable: boolean; lamports: number } | null> {
    const r = await this.call<{ value: { owner: string; executable: boolean; lamports: number } | null }>('getAccountInfo', [
      address,
      { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'confirmed' },
    ]);
    return r.value ? { owner: r.value.owner, executable: r.value.executable, lamports: r.value.lamports } : null;
  }
}
