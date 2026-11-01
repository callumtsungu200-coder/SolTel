import { num, numOrNull, unwrap, unwrapMaybe, type Db } from './client.js';
import type { MonitoredAddressRow, SnapshotRow, TrackedWalletRow, Tracker, WalletTransactionRow, WatchlistRow } from './types.js';

/** Tracked wallets & token watchlists — every query is scoped by user_id. */
export class WalletsRepo {
  constructor(private readonly db: Db) {}

  async list(userId: number): Promise<TrackedWalletRow[]> {
    return unwrap('wallets.list', await this.db.from('tracked_wallets').select().eq('user_id', userId).order('created_at', { ascending: true }));
  }

  async count(userId: number): Promise<number> {
    const res = await this.db.from('tracked_wallets').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    unwrap('wallets.count', res);
    return res.count ?? 0;
  }

  async get(userId: number, id: string): Promise<TrackedWalletRow | null> {
    return unwrapMaybe('wallets.get', await this.db.from('tracked_wallets').select().eq('user_id', userId).eq('id', id).maybeSingle());
  }

  async findByAddress(userId: number, address: string): Promise<TrackedWalletRow | null> {
    return unwrapMaybe('wallets.find', await this.db.from('tracked_wallets').select().eq('user_id', userId).eq('address', address).maybeSingle());
  }

  async add(userId: number, address: string, label: string): Promise<TrackedWalletRow> {
    const row = unwrap<TrackedWalletRow>(
      'wallets.add',
      await this.db.from('tracked_wallets').insert({ user_id: userId, address, label }).select().single(),
    );
    unwrap('monitor.ensure', await this.db.from('monitored_addresses').upsert({ address }, { onConflict: 'address', ignoreDuplicates: true }));
    return row;
  }

  async remove(userId: number, id: string): Promise<TrackedWalletRow | null> {
    const rows = unwrap<TrackedWalletRow[]>('wallets.remove', await this.db.from('tracked_wallets').delete().eq('user_id', userId).eq('id', id).select());
    const removed = rows[0] ?? null;
    if (removed) await this.cleanupMonitor(removed.address);
    return removed;
  }

  async rename(userId: number, id: string, label: string): Promise<TrackedWalletRow | null> {
    const rows = unwrap<TrackedWalletRow[]>('wallets.rename', await this.db.from('tracked_wallets').update({ label }).eq('user_id', userId).eq('id', id).select());
    return rows[0] ?? null;
  }

  async setNotify(userId: number, id: string, patch: { notify_incoming?: boolean; notify_outgoing?: boolean }): Promise<TrackedWalletRow | null> {
    const rows = unwrap<TrackedWalletRow[]>('wallets.notify', await this.db.from('tracked_wallets').update(patch).eq('user_id', userId).eq('id', id).select());
    return rows[0] ?? null;
  }

  /** Stops monitoring an address once nobody tracks it any more. */
  private async cleanupMonitor(address: string): Promise<void> {
    const res = await this.db.from('tracked_wallets').select('id', { count: 'exact', head: true }).eq('address', address);
    unwrap('wallets.trackerCount', res);
    if ((res.count ?? 0) === 0) unwrap('monitor.delete', await this.db.from('monitored_addresses').delete().eq('address', address));
  }

  async distinctAddresses(): Promise<string[]> {
    const rows = unwrap<Array<{ address: string }>>('monitor.list', await this.db.from('monitored_addresses').select('address'));
    return rows.map((r) => r.address);
  }

  /** Everyone tracking `address`, excluding users who blocked the bot. */
  async trackersOf(address: string): Promise<Tracker[]> {
    const rows = unwrap<Array<TrackedWalletRow & { users: { telegram_id: number; is_blocked: boolean } | null }>>(
      'wallets.trackers',
      await this.db.from('tracked_wallets').select('*, users!inner(telegram_id, is_blocked)').eq('address', address),
    );
    return rows
      .filter((r) => r.users && !r.users.is_blocked)
      .map((r) => ({
        walletId: r.id,
        label: r.label,
        userId: r.user_id,
        telegramId: num(r.users!.telegram_id),
        notifyIncoming: r.notify_incoming,
        notifyOutgoing: r.notify_outgoing,
      }));
  }

  // ----- monitoring cursors -----
  async getMonitor(address: string): Promise<MonitoredAddressRow | null> {
    return unwrapMaybe('monitor.get', await this.db.from('monitored_addresses').select().eq('address', address).maybeSingle());
  }

  async listMonitors(): Promise<MonitoredAddressRow[]> {
    return unwrap('monitor.all', await this.db.from('monitored_addresses').select());
  }

  async updateCursor(address: string, signature: string | null, slot: number | null): Promise<void> {
    const patch: Record<string, unknown> = { last_checked_at: new Date().toISOString() };
    if (signature) {
      patch.last_signature = signature;
      patch.last_slot = slot;
    }
    unwrap('monitor.cursor', await this.db.from('monitored_addresses').update(patch).eq('address', address));
  }

  async setHoldingsState(address: string, state: Record<string, number>): Promise<void> {
    unwrap(
      'monitor.holdings',
      await this.db.from('monitored_addresses').update({ holdings_state: state, holdings_checked_at: new Date().toISOString() }).eq('address', address),
    );
  }

  // ----- observed transactions -----
  /** Inserts transactions, returning only the rows that were NOT already stored (dedupe). */
  async insertTransactions(rows: WalletTransactionRow[]): Promise<WalletTransactionRow[]> {
    if (rows.length === 0) return [];
    return unwrap(
      'wallet_tx.insert',
      await this.db.from('wallet_transactions').upsert(rows, { onConflict: 'wallet_address,signature', ignoreDuplicates: true }).select(),
    );
  }

  async recentTransactions(address: string, limit = 20, offset = 0): Promise<WalletTransactionRow[]> {
    const rows = unwrap<WalletTransactionRow[]>(
      'wallet_tx.recent',
      await this.db
        .from('wallet_transactions')
        .select()
        .eq('wallet_address', address)
        .order('block_time', { ascending: false })
        .range(offset, offset + limit - 1),
    );
    return rows.map((r) => ({ ...r, sol_change: num(r.sol_change), slot: numOrNull(r.slot) }));
  }

  // ----- token watchlist -----
  async listWatchlist(userId: number): Promise<WatchlistRow[]> {
    return unwrap('watchlist.list', await this.db.from('token_watchlist').select().eq('user_id', userId).order('created_at', { ascending: true }));
  }

  async addToWatchlist(userId: number, mint: string, label: string | null): Promise<WatchlistRow> {
    return unwrap('watchlist.add', await this.db.from('token_watchlist').insert({ user_id: userId, mint, label }).select().single());
  }

  async removeFromWatchlist(userId: number, id: string): Promise<boolean> {
    const rows = unwrap<WatchlistRow[]>('watchlist.remove', await this.db.from('token_watchlist').delete().eq('user_id', userId).eq('id', id).select());
    return rows.length > 0;
  }

  async watchlistMints(): Promise<string[]> {
    const rows = unwrap<Array<{ mint: string }>>('watchlist.mints', await this.db.from('token_watchlist').select('mint'));
    return [...new Set(rows.map((r) => r.mint))];
  }

  // ----- portfolio snapshots -----
  async insertSnapshot(row: SnapshotRow): Promise<void> {
    unwrap('snapshots.insert', await this.db.from('portfolio_snapshots').insert(row));
  }

  async snapshots(address: string, limit = 30): Promise<SnapshotRow[]> {
    const rows = unwrap<SnapshotRow[]>(
      'snapshots.list',
      await this.db.from('portfolio_snapshots').select().eq('wallet_address', address).order('taken_at', { ascending: false }).limit(limit),
    );
    return rows.map(normalizeSnapshot);
  }

  /** Latest snapshot taken at or before `iso`. */
  async snapshotAtOrBefore(address: string, iso: string): Promise<SnapshotRow | null> {
    const row = unwrapMaybe<SnapshotRow>(
      'snapshots.before',
      await this.db
        .from('portfolio_snapshots')
        .select()
        .eq('wallet_address', address)
        .lte('taken_at', iso)
        .order('taken_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    return row ? normalizeSnapshot(row) : null;
  }
}

function normalizeSnapshot(r: SnapshotRow): SnapshotRow {
  return {
    ...r,
    sol_balance: num(r.sol_balance),
    sol_price_usd: numOrNull(r.sol_price_usd),
    tokens_value_usd: num(r.tokens_value_usd),
    total_value_usd: numOrNull(r.total_value_usd),
  };
}
