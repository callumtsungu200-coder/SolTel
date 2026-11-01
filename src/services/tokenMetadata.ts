import type { DasAsset, HeliusClient } from '../clients/helius.js';
import { TtlCache } from '../utils/cache.js';
import { createLogger } from '../utils/logger.js';
import { USDC_MINT, USDT_MINT, WSOL_MINT } from '../validation/address.js';

const log = createLogger('token-meta');

export interface TokenMeta {
  mint: string;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  supply: number | null;
  tokenProgram: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  mutable: boolean | null;
  description: string | null;
  image: string | null;
  interface: string | null;
}

const WELL_KNOWN: Record<string, Pick<TokenMeta, 'name' | 'symbol' | 'decimals'>> = {
  [WSOL_MINT]: { name: 'Wrapped SOL', symbol: 'SOL', decimals: 9 },
  [USDC_MINT]: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
  [USDT_MINT]: { name: 'USDT', symbol: 'USDT', decimals: 6 },
};

export function metaFromAsset(a: DasAsset): TokenMeta {
  const decimals = a.token_info?.decimals ?? null;
  const supplyRaw = a.token_info?.supply;
  return {
    mint: a.id,
    name: a.content?.metadata?.name?.trim() || null,
    symbol: a.content?.metadata?.symbol?.trim() || a.token_info?.symbol?.trim() || null,
    decimals,
    supply: supplyRaw !== undefined && decimals !== null ? supplyRaw / 10 ** decimals : null,
    tokenProgram: a.token_info?.token_program ?? null,
    mintAuthority: a.token_info?.mint_authority ?? null,
    freezeAuthority: a.token_info?.freeze_authority ?? null,
    mutable: a.mutable ?? null,
    description: a.content?.metadata?.description?.trim() || null,
    image: a.content?.links?.image ?? null,
    interface: a.interface ?? null,
  };
}

/** Token metadata via Helius DAS with an in-memory cache (metadata rarely changes). */
export class TokenMetadataService {
  private readonly cache = new TtlCache<TokenMeta | null>(6 * 60 * 60_000, 20_000);

  constructor(private readonly helius: HeliusClient) {}

  async get(mint: string): Promise<TokenMeta | null> {
    return (await this.getMany([mint])).get(mint) ?? null;
  }

  async getMany(mints: string[]): Promise<Map<string, TokenMeta>> {
    const out = new Map<string, TokenMeta>();
    const missing: string[] = [];
    for (const m of new Set(mints)) {
      const c = this.cache.get(m);
      if (c === undefined) missing.push(m);
      else if (c) out.set(m, c);
    }
    if (missing.length > 0) {
      try {
        const assets = await this.helius.getAssetBatch(missing);
        const found = new Map(assets.map((a) => [a.id, metaFromAsset(a)]));
        for (const m of missing) {
          const meta = found.get(m) ?? null;
          this.cache.set(m, meta, meta ? undefined : 10 * 60_000);
          if (meta) out.set(m, meta);
        }
      } catch (err) {
        // Metadata is decorative in feeds; degrade to well-known labels / raw mints.
        log.warn('metadata lookup failed', { error: (err as Error).message, count: missing.length });
      }
    }
    for (const m of mints) {
      const known = WELL_KNOWN[m];
      if (known && !out.get(m)?.symbol) {
        out.set(m, { ...emptyMeta(m), ...out.get(m), ...known });
      }
    }
    return out;
  }
}

export function emptyMeta(mint: string): TokenMeta {
  return {
    mint,
    name: null,
    symbol: null,
    decimals: null,
    supply: null,
    tokenProgram: null,
    mintAuthority: null,
    freezeAuthority: null,
    mutable: null,
    description: null,
    image: null,
    interface: null,
  };
}

export function symbolOf(meta: Map<string, TokenMeta>, mint: string): string {
  const m = meta.get(mint);
  return m?.symbol || m?.name || `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}
