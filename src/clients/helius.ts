import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { HttpClient, type FetchLike } from '../utils/http.js';
import { createLogger } from '../utils/logger.js';
import { TokenBucket } from '../utils/rateLimiter.js';

const log = createLogger('helius');

/*
 * Helius integrations used by the bot:
 *  - DAS API (getAssetsByOwner / getAsset) over JSON-RPC for holdings + metadata
 *  - Parsed Events REST API for transaction history and signature parsing
 *    (successor of the legacy Enhanced Transactions API; 10 credits/request)
 *  - Webhooks API for real-time wallet monitoring (deliveries use the
 *    "enhanced" payload format, handled in services/transactions.ts)
 */

// ---------- DAS ----------

const priceInfoSchema = z
  .object({ price_per_token: z.number().optional(), total_price: z.number().optional(), currency: z.string().optional() })
  .loose();

export const dasAssetSchema = z
  .object({
    id: z.string(),
    interface: z.string().optional(),
    content: z
      .object({
        metadata: z.object({ name: z.string().optional(), symbol: z.string().optional(), description: z.string().optional() }).loose().optional(),
        links: z.object({ image: z.string().optional(), external_url: z.string().optional() }).loose().optional(),
        json_uri: z.string().optional(),
      })
      .loose()
      .optional(),
    authorities: z.array(z.object({ address: z.string(), scopes: z.array(z.string()).optional() }).loose()).optional(),
    mutable: z.boolean().optional(),
    burnt: z.boolean().optional(),
    token_info: z
      .object({
        symbol: z.string().optional(),
        balance: z.number().optional(),
        supply: z.number().optional(),
        decimals: z.number().optional(),
        token_program: z.string().optional(),
        associated_token_address: z.string().optional(),
        mint_authority: z.string().optional(),
        freeze_authority: z.string().optional(),
        price_info: priceInfoSchema.optional(),
      })
      .loose()
      .optional(),
  })
  .loose();
export type DasAsset = z.infer<typeof dasAssetSchema>;

const assetsByOwnerSchema = z.object({
  total: z.number().optional(),
  limit: z.number().optional(),
  page: z.number().optional(),
  items: z.array(z.unknown()),
  nativeBalance: z.object({ lamports: z.number(), price_per_sol: z.number().optional(), total_price: z.number().optional() }).loose().optional(),
});

export interface AssetsByOwnerResult {
  items: DasAsset[];
  nativeLamports: number | null;
  total: number;
  truncated: boolean;
}

// ---------- Parsed Events ----------

export const pe_nativeTransferSchema = z.object({
  fromUserAccount: z.string().nullable().optional(),
  toUserAccount: z.string().nullable().optional(),
  amount: z.number(),
});

export const pe_tokenTransferSchema = z.object({
  fromUserAccount: z.string().nullable().optional(),
  toUserAccount: z.string().nullable().optional(),
  fromTokenAccount: z.string().nullable().optional(),
  toTokenAccount: z.string().nullable().optional(),
  rawTokenAmount: z.union([z.number(), z.string()]),
  decimals: z.number(),
  tokenStandard: z.string().optional(),
  mint: z.string(),
});

export const pe_summarySchema = z
  .object({
    type: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    parsedData: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .loose();

export const parsedTransactionSchema = z.object({
  slot: z.number(),
  blockTime: z.number().nullable().optional(),
  fee: z.number().default(0),
  feePayer: z.string().nullable().optional(),
  transactionStatus: z.string().optional(),
  error: z.unknown().optional(),
  decodedError: z.object({ name: z.string().optional(), msg: z.string().nullable().optional() }).loose().optional().nullable(),
  nativeTransfers: z.array(pe_nativeTransferSchema).default([]),
  tokenTransfers: z.array(pe_tokenTransferSchema).default([]),
  summary: pe_summarySchema.nullable().optional(),
  instructions: z.array(z.object({ programId: z.string(), programName: z.string().nullable().optional(), instructionName: z.string().nullable().optional() }).loose()).default([]),
});
export type ParsedTransaction = z.infer<typeof parsedTransactionSchema>;

export const parsedEnvelopeSchema = z.object({
  signature: z.string(),
  parserStatus: z.string(),
  parsed: z.unknown().optional(),
  parserError: z.object({ code: z.union([z.string(), z.number()]).optional(), message: z.string().optional() }).loose().optional(),
});

export interface ParsedItem {
  signature: string;
  tx: ParsedTransaction;
}

export interface HistoryPage {
  items: ParsedItem[];
  paginationToken: string | null;
  skipped: number;
}

/** Parses an array of envelopes, dropping (and counting) items that failed to parse. */
export function parseEnvelopes(raw: unknown): { items: ParsedItem[]; skipped: number } {
  const arr = Array.isArray(raw) ? raw : [];
  const items: ParsedItem[] = [];
  let skipped = 0;
  for (const entry of arr) {
    const env = parsedEnvelopeSchema.safeParse(entry);
    if (!env.success || env.data.parserStatus !== 'OK') {
      skipped++;
      continue;
    }
    const tx = parsedTransactionSchema.safeParse(env.data.parsed);
    if (!tx.success) {
      skipped++;
      continue;
    }
    items.push({ signature: env.data.signature, tx: tx.data });
  }
  return { items, skipped };
}

// ---------- Webhooks ----------

export const webhookSchema = z
  .object({
    webhookID: z.string(),
    webhookURL: z.string(),
    webhookType: z.string().optional(),
    accountAddresses: z.array(z.string()).default([]),
    transactionTypes: z.array(z.string()).optional(),
    active: z.boolean().optional(),
  })
  .loose();
export type HeliusWebhook = z.infer<typeof webhookSchema>;

export class HeliusClient {
  private readonly http: HttpClient;
  private readonly rpcHttp: HttpClient;
  private id = 0;

  constructor(
    private readonly apiKey: string,
    private readonly apiBase: string,
    private readonly rpcUrl: string,
    timeoutMs: number,
    fetchImpl?: FetchLike,
  ) {
    this.http = new HttpClient({ service: 'Helius', timeoutMs, bucket: new TokenBucket(2, 2), fetchImpl });
    this.rpcHttp = new HttpClient({ service: 'Helius DAS', timeoutMs, bucket: new TokenBucket(2, 2), fetchImpl });
  }

  private url(path: string): string {
    return `${this.apiBase.replace(/\/$/, '')}${path}${path.includes('?') ? '&' : '?'}api-key=${encodeURIComponent(this.apiKey)}`;
  }

  private async das<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await this.rpcHttp.request<{ result?: T; error?: { code: number; message: string } }>(this.rpcUrl, {
      body: { jsonrpc: '2.0', id: `das-${++this.id}`, method, params },
    });
    if (!res || res.error) {
      const code = res?.error?.code;
      throw new ApiError(`Helius DAS ${method} failed: ${res?.error?.message ?? 'empty response'}`, 'Helius DAS', code === -32602 ? 400 : 503, code !== -32602);
    }
    return res.result as T;
  }

  /** All fungible + non-fungible assets for an owner, paging up to `maxPages` × 1000 items. */
  async getAssetsByOwner(owner: string, maxPages = 3): Promise<AssetsByOwnerResult> {
    const items: DasAsset[] = [];
    let nativeLamports: number | null = null;
    let total = 0;
    let truncated = false;
    for (let page = 1; page <= maxPages; page++) {
      const raw = await this.das<unknown>('getAssetsByOwner', {
        ownerAddress: owner,
        page,
        limit: 1000,
        displayOptions: { showFungible: true, showNativeBalance: true, showZeroBalance: false },
      });
      const parsed = assetsByOwnerSchema.parse(raw);
      if (page === 1) nativeLamports = parsed.nativeBalance?.lamports ?? null;
      for (const it of parsed.items) {
        const a = dasAssetSchema.safeParse(it);
        if (a.success) items.push(a.data);
      }
      total = parsed.total ?? items.length;
      if (parsed.items.length < 1000) break;
      if (page === maxPages) truncated = true;
    }
    return { items, nativeLamports, total, truncated };
  }

  async getAsset(id: string): Promise<DasAsset | null> {
    try {
      const raw = await this.das<unknown>('getAsset', { id, displayOptions: { showFungible: true } });
      const a = dasAssetSchema.safeParse(raw);
      return a.success ? a.data : null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) return null;
      throw err;
    }
  }

  /** Batch metadata lookup (up to 1000 ids per call). Unknown ids are omitted. */
  async getAssetBatch(ids: string[]): Promise<DasAsset[]> {
    const out: DasAsset[] = [];
    for (let i = 0; i < ids.length; i += 1000) {
      const raw = await this.das<unknown[]>('getAssetBatch', { ids: ids.slice(i, i + 1000), displayOptions: { showFungible: true } });
      for (const it of raw ?? []) {
        const a = dasAssetSchema.safeParse(it);
        if (a.success) out.push(a.data);
      }
    }
    return out;
  }

  async getTransactionHistory(
    address: string,
    opts: { limit?: number; paginationToken?: string; tokenAccounts?: 'none' | 'balanceChanged' | 'all' } = {},
  ): Promise<HistoryPage> {
    const body: Record<string, unknown> = {
      address,
      limit: Math.min(100, Math.max(1, opts.limit ?? 50)),
      sortOrder: 'desc',
      tokenAccounts: opts.tokenAccounts ?? 'balanceChanged',
    };
    if (opts.paginationToken) body.paginationToken = opts.paginationToken;
    const raw = await this.http.request<{ data?: unknown[]; paginationToken?: string }>(this.url('/v1/parsed-events/transaction-history'), { body });
    const { items, skipped } = parseEnvelopes(raw?.data ?? []);
    if (skipped > 0) log.debug('skipped unparseable transactions', { address, skipped });
    return { items, paginationToken: raw?.paginationToken ?? null, skipped };
  }

  async parseTransactions(signatures: string[]): Promise<ParsedItem[]> {
    const out: ParsedItem[] = [];
    for (let i = 0; i < signatures.length; i += 100) {
      const chunk = signatures.slice(i, i + 100);
      const raw = await this.http.request<unknown>(this.url('/v1/parsed-events/transactions'), { body: { transactions: chunk } });
      // The endpoint returns either a bare array or { data: [...] }; accept both.
      const arr = Array.isArray(raw) ? raw : (raw as { data?: unknown[] } | null)?.data ?? [];
      out.push(...parseEnvelopes(arr).items);
    }
    return out;
  }

  // ---- webhooks ----
  async listWebhooks(): Promise<HeliusWebhook[]> {
    const raw = await this.http.request<unknown[]>(this.url('/v0/webhooks'));
    return (raw ?? []).flatMap((w) => {
      const r = webhookSchema.safeParse(w);
      return r.success ? [r.data] : [];
    });
  }

  async createWebhook(input: { webhookURL: string; accountAddresses: string[]; authHeader: string }): Promise<HeliusWebhook> {
    const raw = await this.http.request<unknown>(this.url('/v0/webhooks'), {
      method: 'POST',
      body: { ...input, webhookType: 'enhanced', transactionTypes: [] },
    });
    return webhookSchema.parse(raw);
  }

  async updateWebhook(id: string, input: { webhookURL: string; accountAddresses: string[]; authHeader: string }): Promise<HeliusWebhook> {
    const raw = await this.http.request<unknown>(this.url(`/v0/webhooks/${encodeURIComponent(id)}`), {
      method: 'PUT',
      body: { ...input, webhookType: 'enhanced', transactionTypes: [] },
    });
    return webhookSchema.parse(raw);
  }
}
