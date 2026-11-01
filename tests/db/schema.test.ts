import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JUP, OTHER, sig, WALLET } from '../fixtures/index.js';

/**
 * Runs the real Supabase migration against PostgreSQL (PGlite, in-process
 * WASM build of Postgres) with stubs for the parts Supabase provides
 * (roles, auth.jwt(), default grants), then verifies constraints, cascades,
 * duplicate prevention and Row Level Security isolation between users.
 */

const MIGRATION = readFileSync(join(process.cwd(), 'supabase/migrations/20261101000000_initial_schema.sql'), 'utf8');

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

let db: PGlite;
let u1: number;
let u2: number;

async function asUser(telegramId: number | null, fn: () => Promise<void>): Promise<void> {
  await db.exec(`set role authenticated; select set_config('request.jwt.claims', '${telegramId === null ? '' : JSON.stringify({ telegram_id: String(telegramId) })}', false);`);
  try {
    await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claims', '', false);`);
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await db.exec(MIGRATION);
  u1 = (await db.query<{ id: number }>(`insert into users (telegram_id, username) values (111, 'alice') returning id`)).rows[0]!.id;
  u2 = (await db.query<{ id: number }>(`insert into users (telegram_id, username) values (222, 'bob') returning id`)).rows[0]!.id;
  await db.query(`insert into user_preferences (user_id) values ($1), ($2)`, [u1, u2]);
  await db.query(`insert into tracked_wallets (user_id, address, label) values ($1, $2, 'alice main'), ($3, $4, 'bob main')`, [u1, WALLET, u2, OTHER]);
  await db.query(`insert into alerts (user_id, kind, params) values ($1, 'price_move', $2), ($3, 'price_move', $2)`, [u1, JSON.stringify({ mint: JUP, percent: 5 }), u2]);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('schema constraints', () => {
  it('applies sensible preference defaults', async () => {
    const p = (await db.query<{ page_size: number; whale_threshold_usd: string; notifications_enabled: boolean }>(`select * from user_preferences where user_id = $1`, [u1])).rows[0]!;
    expect(p.page_size).toBe(5);
    expect(Number(p.whale_threshold_usd)).toBe(50000);
    expect(p.notifications_enabled).toBe(true);
  });

  it('rejects invalid Solana addresses at the database level', async () => {
    await expect(db.query(`insert into tracked_wallets (user_id, address, label) values ($1, '0xdeadbeef', 'x')`, [u1])).rejects.toThrow(/solana_address/);
    await expect(db.query(`insert into token_watchlist (user_id, mint) values ($1, 'O0Il')`, [u1])).rejects.toThrow();
  });

  it('prevents tracking the same wallet twice per user but allows different users', async () => {
    await expect(db.query(`insert into tracked_wallets (user_id, address, label) values ($1, $2, 'dup')`, [u1, WALLET])).rejects.toThrow(/duplicate key/);
    await db.query(`insert into tracked_wallets (user_id, address, label) values ($1, $2, 'bob also tracks')`, [u2, WALLET]);
  });

  it('validates check constraints (labels, alert kinds, preference ranges)', async () => {
    await expect(db.query(`insert into tracked_wallets (user_id, address, label) values ($1, $2, '')`, [u1, JUP])).rejects.toThrow(/check/);
    await expect(db.query(`insert into alerts (user_id, kind, params) values ($1, 'buy_signal', '{}')`, [u1])).rejects.toThrow(/check/);
    await expect(db.query(`update user_preferences set page_size = 100 where user_id = $1`, [u1])).rejects.toThrow(/check/);
  });

  it('deduplicates observed transactions and notifications', async () => {
    const s = sig();
    const insertTx = `insert into wallet_transactions (wallet_address, signature, tx_type, category, direction, provider)
                      values ($1, $2, 'TRANSFER', 'transfer', 'incoming', 'test') on conflict (wallet_address, signature) do nothing returning id`;
    expect((await db.query(insertTx, [WALLET, s])).rows).toHaveLength(1);
    expect((await db.query(insertTx, [WALLET, s])).rows).toHaveLength(0);

    const insertNotif = `insert into notification_history (user_id, kind, dedupe_key, message) values ($1, 'k', $2, 'm')
                         on conflict (user_id, dedupe_key) do nothing returning id`;
    expect((await db.query(insertNotif, [u1, `tx:${s}`])).rows).toHaveLength(1);
    expect((await db.query(insertNotif, [u1, `tx:${s}`])).rows).toHaveLength(0);
    expect((await db.query(insertNotif, [u2, `tx:${s}`])).rows).toHaveLength(1); // other user still notified
  });

  it('treats NULL columns as equal in the whale event natural key', async () => {
    const s = sig();
    const q = `insert into whale_events (signature, watched, watch_kind, event_kind, mint, amount, from_addr, to_addr)
               values ($1, $2, 'token', 'token_transfer', $3, 1, null, null) on conflict do nothing returning id`;
    expect((await db.query(q, [s, JUP, JUP])).rows).toHaveLength(1);
    expect((await db.query(q, [s, JUP, JUP])).rows).toHaveLength(0);
  });

  it('cascades user deletion to private data and nulls notification alert links', async () => {
    const u = (await db.query<{ id: number }>(`insert into users (telegram_id) values (333) returning id`)).rows[0]!.id;
    const a = (await db.query<{ id: string }>(`insert into alerts (user_id, kind, params) values ($1, 'price_move', '{}') returning id`, [u])).rows[0]!.id;
    await db.query(`insert into tracked_wallets (user_id, address, label) values ($1, $2, 'x')`, [u, JUP]);
    await db.query(`insert into notification_history (user_id, alert_id, kind, dedupe_key, message) values ($1, $2, 'k', 'd', 'm')`, [u, a]);
    await db.query(`delete from alerts where id = $1`, [a]);
    expect((await db.query<{ alert_id: string | null }>(`select alert_id from notification_history where user_id = $1`, [u])).rows[0]!.alert_id).toBeNull();
    await db.query(`delete from users where id = $1`, [u]);
    expect((await db.query(`select 1 from tracked_wallets where user_id = $1`, [u])).rows).toHaveLength(0);
    expect((await db.query(`select 1 from notification_history where user_id = $1`, [u])).rows).toHaveLength(0);
  });

  it('runs the retention helper', async () => {
    await db.query(`insert into price_history (mint, price_usd, recorded_at) values ($1, 1, now() - interval '200 days'), ($1, 2, now())`, [JUP]);
    await db.query(`select prune_old_data(90)`);
    expect((await db.query(`select price_usd from price_history where mint = $1`, [JUP])).rows).toHaveLength(1);
  });
});

describe('row level security', () => {
  it('authenticated users only see their own private rows', async () => {
    await asUser(111, async () => {
      const wallets = await db.query<{ label: string }>(`select label from tracked_wallets`);
      expect(wallets.rows.map((r) => r.label)).toEqual(['alice main']);
      expect((await db.query(`select * from alerts`)).rows).toHaveLength(1);
      expect((await db.query(`select * from users`)).rows).toHaveLength(1);
      expect((await db.query(`select * from user_preferences`)).rows).toHaveLength(1);
    });
  });

  it('users cannot write rows for another user', async () => {
    await asUser(111, async () => {
      await expect(db.query(`insert into tracked_wallets (user_id, address, label) values ($1, $2, 'hijack')`, [u2, JUP])).rejects.toThrow(/row-level security/);
      const upd = await db.query(`update alerts set is_active = false where user_id = $1`, [u2]);
      expect(upd.affectedRows ?? 0).toBe(0);
    });
    expect((await db.query<{ is_active: boolean }>(`select is_active from alerts where user_id = $1`, [u2])).rows[0]!.is_active).toBe(true);
  });

  it('a JWT without a telegram_id claim sees nothing', async () => {
    await asUser(null, async () => {
      expect((await db.query(`select * from tracked_wallets`)).rows).toHaveLength(0);
      expect((await db.query(`select * from notification_history`)).rows).toHaveLength(0);
    });
  });

  it('anonymous role has no table access at all', async () => {
    await db.exec('set role anon');
    try {
      await expect(db.query(`select * from tracked_wallets`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`select * from tokens`)).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec('reset role');
    }
  });

  it('snapshots are visible only for wallets the user tracks; monitor table is service-only', async () => {
    await db.query(`insert into portfolio_snapshots (wallet_address, sol_balance) values ($1, 1), ($2, 2)`, [WALLET, OTHER]);
    await db.query(`insert into monitored_addresses (address) values ($1) on conflict do nothing`, [WALLET]);
    await asUser(111, async () => {
      const rows = await db.query<{ wallet_address: string }>(`select wallet_address from portfolio_snapshots`);
      expect(rows.rows.map((r) => r.wallet_address)).toEqual([WALLET]);
      expect((await db.query(`select * from monitored_addresses`)).rows).toHaveLength(0);
    });
  });

  it('the service role (used by the bot) bypasses RLS', async () => {
    await db.exec('set role service_role');
    try {
      expect((await db.query(`select * from tracked_wallets`)).rows.length).toBeGreaterThanOrEqual(3);
    } finally {
      await db.exec('reset role');
    }
  });
});
