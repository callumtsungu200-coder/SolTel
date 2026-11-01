import { describe, expect, it } from 'vitest';
import { AlertsRepo } from '../../src/db/alertsRepo.js';
import { createDb, isUniqueViolation } from '../../src/db/client.js';
import { MarketRepo } from '../../src/db/marketRepo.js';
import { UsersRepo } from '../../src/db/usersRepo.js';
import { WalletsRepo } from '../../src/db/walletsRepo.js';
import { DatabaseError } from '../../src/utils/errors.js';
import { JUP, WALLET } from '../fixtures/index.js';

/**
 * Repository tests at the HTTP boundary: supabase-js is real; only fetch is
 * replaced, so we assert the exact PostgREST requests (user scoping,
 * conflict handling, dedupe semantics) the bot sends to Supabase.
 */

interface Captured {
  method: string;
  url: URL;
  prefer: string;
  body: unknown;
}

function fakeSupabase(respond: (req: Captured) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Captured[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const req: Captured = { method: init?.method ?? 'GET', url, prefer: headers.get('prefer') ?? '', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(req);
    const r = respond(req);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...r.headers } });
  };
  const db = createDb('https://proj.supabase.co', 'service-role-test-key-000000', fetchImpl as never);
  return { db, calls };
}

const UUID = '22222222-2222-4222-8222-222222222222';

describe('WalletsRepo', () => {
  it('scopes reads, renames and deletes to the requesting user', async () => {
    const { db, calls } = fakeSupabase((req) => ({ body: req.method === 'DELETE' ? [{ id: UUID, address: WALLET, user_id: 5 }] : [] }));
    const repo = new WalletsRepo(db);
    await repo.list(5);
    await repo.rename(5, UUID, 'New');
    await repo.remove(5, UUID);
    const list = calls[0]!;
    expect(list.url.pathname).toBe('/rest/v1/tracked_wallets');
    expect(list.url.searchParams.get('user_id')).toBe('eq.5');
    const rename = calls[1]!;
    expect(rename.method).toBe('PATCH');
    expect(rename.url.searchParams.get('user_id')).toBe('eq.5');
    expect(rename.url.searchParams.get('id')).toBe(`eq.${UUID}`);
    expect(rename.body).toEqual({ label: 'New' });
    const del = calls[2]!;
    expect(del.method).toBe('DELETE');
    expect(del.url.searchParams.get('user_id')).toBe('eq.5');
  });

  it('adds a wallet and registers the address for monitoring idempotently', async () => {
    const { db, calls } = fakeSupabase((req) => ({ body: req.url.pathname.endsWith('tracked_wallets') ? { id: UUID, address: WALLET, label: 'x', user_id: 5 } : [] }));
    await new WalletsRepo(db).add(5, WALLET, 'x');
    expect(calls[0]!.body).toEqual({ user_id: 5, address: WALLET, label: 'x' });
    const monitor = calls[1]!;
    expect(monitor.url.pathname).toBe('/rest/v1/monitored_addresses');
    expect(monitor.url.searchParams.get('on_conflict')).toBe('address');
    expect(monitor.prefer).toContain('resolution=ignore-duplicates');
  });

  it('returns only newly inserted transactions for dedupe', async () => {
    const { db, calls } = fakeSupabase(() => ({ status: 201, body: [] }));
    const res = await new WalletsRepo(db).insertTransactions([
      { wallet_address: WALLET, signature: 's'.repeat(88), slot: 1, block_time: null, tx_type: 'TRANSFER', source: null, category: 'transfer', direction: 'incoming', sol_change: 1, token_changes: [], description: null, success: true, provider: 'test' },
    ]);
    expect(res).toEqual([]);
    expect(calls[0]!.url.searchParams.get('on_conflict')).toBe('wallet_address,signature');
    expect(calls[0]!.prefer).toContain('resolution=ignore-duplicates');
    expect(calls[0]!.prefer).toContain('return=representation');
  });

  it('maps trackers and drops users who blocked the bot', async () => {
    const { db } = fakeSupabase(() => ({
      body: [
        { id: 'a', label: 'A', user_id: 1, notify_incoming: true, notify_outgoing: false, users: { telegram_id: '100', is_blocked: false } },
        { id: 'b', label: 'B', user_id: 2, notify_incoming: true, notify_outgoing: true, users: { telegram_id: 200, is_blocked: true } },
      ],
    }));
    const t = await new WalletsRepo(db).trackersOf(WALLET);
    expect(t).toEqual([{ walletId: 'a', label: 'A', userId: 1, telegramId: 100, notifyIncoming: true, notifyOutgoing: false }]);
  });
});

describe('AlertsRepo', () => {
  it('reserves notifications atomically and reports duplicates as null', async () => {
    let first = true;
    const { db, calls } = fakeSupabase(() => {
      const body = first ? [{ id: 9 }] : [];
      first = false;
      return { status: 201, body };
    });
    const repo = new AlertsRepo(db);
    const input = { userId: 3, alertId: null, kind: 'k', dedupeKey: 'tx:abc', message: 'm' };
    expect(await repo.reserveNotification(input)).toBe(9);
    expect(await repo.reserveNotification(input)).toBeNull();
    expect(calls[0]!.url.searchParams.get('on_conflict')).toBe('user_id,dedupe_key');
    expect(calls[0]!.prefer).toContain('resolution=ignore-duplicates');
  });

  it('scopes updates and deletes to the user', async () => {
    const { db, calls } = fakeSupabase(() => ({ body: [] }));
    const repo = new AlertsRepo(db);
    expect(await repo.update(3, UUID, { is_active: false })).toBeNull();
    expect(await repo.delete(3, UUID)).toBe(false);
    for (const c of calls) expect(c.url.searchParams.get('user_id')).toBe('eq.3');
  });

  it('filters active alerts by kind and excludes blocked users', async () => {
    const { db, calls } = fakeSupabase(() => ({
      body: [
        { id: 'x', user_id: 1, kind: 'price_move', params: {}, users: { telegram_id: 10, is_blocked: false } },
        { id: 'y', user_id: 2, kind: 'price_move', params: {}, users: { telegram_id: 20, is_blocked: true } },
      ],
    }));
    const rows = await new AlertsRepo(db).listActive(['price_move', 'price_target']);
    expect(rows.map((r) => r.id)).toEqual(['x']);
    expect(rows[0]!.telegramId).toBe(10);
    expect(calls[0]!.url.searchParams.get('kind')).toBe('in.(price_move,price_target)');
    expect(calls[0]!.url.searchParams.get('is_active')).toBe('eq.true');
  });
});

describe('UsersRepo and error handling', () => {
  it('upserts users by telegram_id and ensures a preferences row', async () => {
    const { db, calls } = fakeSupabase((req) => ({ status: 201, body: req.url.pathname.endsWith('/users') ? { id: 1, telegram_id: 42, is_blocked: false } : [] }));
    const u = await new UsersRepo(db).upsertFromTelegram({ telegramId: 42, username: 'x'.repeat(100), firstName: 'A' });
    expect(u.id).toBe(1);
    expect(calls[0]!.url.searchParams.get('on_conflict')).toBe('telegram_id');
    expect((calls[0]!.body as { username: string }).username).toHaveLength(64);
    expect(calls[1]!.url.pathname).toBe('/rest/v1/user_preferences');
    expect(calls[1]!.prefer).toContain('resolution=ignore-duplicates');
  });

  it('normalises numeric columns returned as strings', async () => {
    const { db } = fakeSupabase(() => ({ body: { user_id: 1, min_notify_sol: '0.5', whale_threshold_usd: '50000.00', holding_change_pct: '25', trending_min_liquidity: '0', trending_min_volume: '0', page_size: 5, quiet_hours_start: null, quiet_hours_end: '7' } }));
    const p = await new UsersRepo(db).getPreferences(1);
    expect(p.min_notify_sol).toBe(0.5);
    expect(p.whale_threshold_usd).toBe(50000);
    expect(p.quiet_hours_end).toBe(7);
  });

  it('wraps PostgREST errors in DatabaseError and detects unique violations', async () => {
    const { db } = fakeSupabase(() => ({ status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint', details: null, hint: null } }));
    const err = await new WalletsRepo(db).add(1, WALLET, 'x').catch((e) => e);
    expect(err).toBeInstanceOf(DatabaseError);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('builds whale queries with validated address filters', async () => {
    const { db, calls } = fakeSupabase(() => ({ body: [{ amount: '5', usd_value: '100' }] }));
    const rows = await new MarketRepo(db).whaleEvents({ watchedIn: [JUP], address: WALLET, limit: 10, offset: 0 });
    expect(rows[0]).toMatchObject({ amount: 5, usd_value: 100 });
    expect(calls[0]!.url.searchParams.get('watched')).toBe(`in.(${JUP})`);
    expect(calls[0]!.url.searchParams.get('or')).toBe(`(from_addr.eq.${WALLET},to_addr.eq.${WALLET})`);
  });
});
