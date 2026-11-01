import { num, numOrNull, unwrap, type Db } from './client.js';
import type { PriceHistoryRow, WhaleEventRow } from './types.js';

/** Public market/chain data: token cache, price history and whale events. */
export class MarketRepo {
  constructor(private readonly db: Db) {}

  async upsertToken(row: {
    mint: string;
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    supply: number | null;
    mint_authority: string | null;
    freeze_authority: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    unwrap('tokens.upsert', await this.db.from('tokens').upsert({ ...row, metadata: row.metadata ?? {} }, { onConflict: 'mint' }));
  }

  async insertPrices(rows: PriceHistoryRow[]): Promise<void> {
    if (rows.length === 0) return;
    unwrap('price_history.insert', await this.db.from('price_history').insert(rows));
  }

  async priceHistory(mint: string, sinceIso: string, limit = 500): Promise<PriceHistoryRow[]> {
    const rows = unwrap<PriceHistoryRow[]>(
      'price_history.list',
      await this.db.from('price_history').select().eq('mint', mint).gte('recorded_at', sinceIso).order('recorded_at', { ascending: true }).limit(limit),
    );
    return rows.map((r) => ({
      ...r,
      price_usd: num(r.price_usd),
      liquidity_usd: numOrNull(r.liquidity_usd),
      volume_24h: numOrNull(r.volume_24h),
      volume_1h: numOrNull(r.volume_1h),
      market_cap: numOrNull(r.market_cap),
      fdv: numOrNull(r.fdv),
    }));
  }

  /** Inserts whale events and returns only newly stored ones (dedupe by natural key). */
  async insertWhaleEvents(rows: WhaleEventRow[]): Promise<WhaleEventRow[]> {
    if (rows.length === 0) return [];
    return unwrap(
      'whale.insert',
      await this.db
        .from('whale_events')
        .upsert(rows, { onConflict: 'signature,watched,event_kind,mint,from_addr,to_addr', ignoreDuplicates: true })
        .select(),
    );
  }

  /**
   * Whale event history. Address arguments must be validated base58 strings
   * (they are interpolated into a PostgREST `or` filter).
   */
  async whaleEvents(filter: {
    watched?: string;
    watchedIn?: string[];
    address?: string;
    mint?: string;
    minUsd?: number;
    limit: number;
    offset: number;
  }): Promise<WhaleEventRow[]> {
    let q = this.db.from('whale_events').select();
    if (filter.watched) q = q.eq('watched', filter.watched);
    if (filter.watchedIn) q = q.in('watched', filter.watchedIn);
    if (filter.mint) q = q.eq('mint', filter.mint);
    if (filter.address) q = q.or(`from_addr.eq.${filter.address},to_addr.eq.${filter.address}`);
    if (filter.minUsd !== undefined) q = q.gte('usd_value', filter.minUsd);
    const rows = unwrap<WhaleEventRow[]>(
      'whale.list',
      await q.order('block_time', { ascending: false }).range(filter.offset, filter.offset + filter.limit - 1),
    );
    return rows.map((r) => ({ ...r, amount: num(r.amount), usd_value: numOrNull(r.usd_value) }));
  }

  async prune(keepDays: number): Promise<void> {
    unwrap('prune', await this.db.rpc('prune_old_data', { keep_days: keepDays }));
  }
}
