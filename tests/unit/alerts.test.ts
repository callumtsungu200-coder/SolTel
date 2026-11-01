import { describe, expect, it, vi } from 'vitest';
import { alertParamSchemas, describeAlert, parseAlertParams } from '../../src/alerts/definitions.js';
import { evaluateMarketAlert, inCooldown, isQuietHour, type MarketSnapshot } from '../../src/alerts/evaluator.js';
import { Notifier } from '../../src/alerts/notifier.js';
import type { AlertsRepo } from '../../src/db/alertsRepo.js';
import type { AlertKind, AlertRow, PreferencesRow } from '../../src/db/types.js';
import type { UsersRepo } from '../../src/db/usersRepo.js';
import { JUP, WALLET } from '../fixtures/index.js';

const NOW = Date.parse('2026-11-01T12:00:00Z');

function alert(kind: AlertKind, params: Record<string, unknown>, over: Partial<AlertRow> = {}): AlertRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    user_id: 1,
    kind,
    params,
    is_active: true,
    cooldown_minutes: 30,
    state: {},
    last_triggered_at: null,
    trigger_count: 0,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...over,
  };
}

const snap = (over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  mint: JUP,
  priceUsd: 1,
  liquidityUsd: 100_000,
  volume1h: 1000,
  volume24h: 24_000,
  txns1h: 10,
  txns24h: 240,
  ...over,
});

describe('alert parameter validation', () => {
  it('validates each kind and rejects invalid params', () => {
    expect(parseAlertParams('price_move', { mint: JUP, percent: 10 })).toMatchObject({ direction: 'either', symbol: '' });
    expect(parseAlertParams('price_move', { mint: 'bad', percent: 10 })).toBeNull();
    expect(parseAlertParams('price_target', { mint: JUP, condition: 'above', price: -1 })).toBeNull();
    expect(parseAlertParams('large_transaction', { target: 'token', address: JUP, minUsd: 50 })).toBeNull();
    expect(alertParamSchemas.wallet_activity.safeParse({ walletId: 'not-uuid', address: WALLET, label: 'x' }).success).toBe(false);
  });

  it('describes alerts in plain language', () => {
    expect(describeAlert(alert('price_target', { mint: JUP, symbol: 'JUP', condition: 'below', price: 0.5 }))).toBe('JUP: price below $0.5000');
    expect(describeAlert(alert('volume_spike', { mint: JUP, symbol: '', multiplier: 3 }))).toMatch(/3× hourly average/);
  });
});

describe('market alert evaluation', () => {
  it('price_move: first run records a baseline, then fires on threshold and resets baseline', () => {
    const a = alert('price_move', { mint: JUP, symbol: 'JUP', percent: 10, direction: 'either' });
    const first = evaluateMarketAlert(a, snap({ priceUsd: 1 }), NOW);
    expect(first.triggered).toBe(false);
    expect(first.state.baseline).toBe(1);

    const small = evaluateMarketAlert({ ...a, state: first.state }, snap({ priceUsd: 1.05 }), NOW);
    expect(small.triggered).toBe(false);

    const big = evaluateMarketAlert({ ...a, state: first.state }, snap({ priceUsd: 0.88 }), NOW);
    expect(big.triggered).toBe(true);
    expect(big.message).toContain('-12.00%');
    expect(big.state.baseline).toBe(0.88);
    expect(big.dedupeKey).toMatch(/^alert:.*:move:\d+$/);
  });

  it('price_move respects direction', () => {
    const up = alert('price_move', { mint: JUP, percent: 10, direction: 'up' }, { state: { baseline: 1 } });
    expect(evaluateMarketAlert(up, snap({ priceUsd: 0.8 }), NOW).triggered).toBe(false);
    expect(evaluateMarketAlert(up, snap({ priceUsd: 1.2 }), NOW).triggered).toBe(true);
  });

  it('price_target fires only when crossing into the target zone', () => {
    const a = alert('price_target', { mint: JUP, condition: 'above', price: 2 });
    const below = evaluateMarketAlert(a, snap({ priceUsd: 1.5 }), NOW);
    expect(below.triggered).toBe(false);
    const cross = evaluateMarketAlert({ ...a, state: below.state }, snap({ priceUsd: 2.1 }), NOW);
    expect(cross.triggered).toBe(true);
    const stay = evaluateMarketAlert({ ...a, state: cross.state }, snap({ priceUsd: 2.2 }), NOW);
    expect(stay.triggered).toBe(false);
  });

  it('volume_spike and token_activity compare last hour to the 24h hourly average', () => {
    const v = alert('volume_spike', { mint: JUP, multiplier: 3 });
    expect(evaluateMarketAlert(v, snap({ volume1h: 2000 }), NOW).triggered).toBe(false);
    expect(evaluateMarketAlert(v, snap({ volume1h: 3500 }), NOW).triggered).toBe(true);
    const t = alert('token_activity', { mint: JUP, multiplier: 2 });
    expect(evaluateMarketAlert(t, snap({ txns1h: 25 }), NOW).triggered).toBe(true);
    expect(evaluateMarketAlert(t, snap({ txns24h: 0 }), NOW).triggered).toBe(false);
  });

  it('liquidity_change fires on ± threshold from baseline', () => {
    const a = alert('liquidity_change', { mint: JUP, percent: 20 }, { state: { baseline: 100_000 } });
    expect(evaluateMarketAlert(a, snap({ liquidityUsd: 85_000 }), NOW).triggered).toBe(false);
    expect(evaluateMarketAlert(a, snap({ liquidityUsd: 70_000 }), NOW).triggered).toBe(true);
    expect(evaluateMarketAlert(a, snap({ liquidityUsd: 125_000 }), NOW).triggered).toBe(true);
  });

  it('does not trigger during cooldown and handles missing data', () => {
    const recent = new Date(NOW - 5 * 60_000).toISOString();
    const a = alert('price_move', { mint: JUP, percent: 10 }, { state: { baseline: 1 }, last_triggered_at: recent });
    expect(inCooldown(a, NOW)).toBe(true);
    expect(evaluateMarketAlert(a, snap({ priceUsd: 2 }), NOW).triggered).toBe(false);
    expect(evaluateMarketAlert(alert('price_move', { mint: JUP, percent: 10 }), snap({ priceUsd: null }), NOW).triggered).toBe(false);
    expect(evaluateMarketAlert(alert('price_move', { bogus: true }), snap(), NOW).triggered).toBe(false);
  });

  it('computes quiet hours across midnight', () => {
    expect(isQuietHour(23, 22, 7)).toBe(true);
    expect(isQuietHour(3, 22, 7)).toBe(true);
    expect(isQuietHour(12, 22, 7)).toBe(false);
    expect(isQuietHour(10, 9, 17)).toBe(true);
    expect(isQuietHour(10, null, null)).toBe(false);
  });
});

function prefs(over: Partial<PreferencesRow> = {}): PreferencesRow {
  return {
    user_id: 1,
    notifications_enabled: true,
    notify_wallet_activity: true,
    notify_holdings_changes: true,
    min_notify_sol: 0,
    whale_threshold_usd: 50_000,
    holding_change_pct: 25,
    trending_min_liquidity: 50_000,
    trending_min_volume: 100_000,
    trending_sort: 'volume',
    page_size: 5,
    quiet_hours_start: null,
    quiet_hours_end: null,
    updated_at: '',
    ...over,
  };
}

function notifierWith(opts: { reserved?: Set<string>; send?: () => Promise<unknown>; hour?: number } = {}) {
  const reserved = opts.reserved ?? new Set<string>();
  const marks: Array<[number, boolean, string | undefined]> = [];
  const alerts = {
    reserveNotification: vi.fn(async ({ userId, dedupeKey }: { userId: number; dedupeKey: string }) => {
      const k = `${userId}:${dedupeKey}`;
      if (reserved.has(k)) return null;
      reserved.add(k);
      return reserved.size;
    }),
    markDelivered: vi.fn(async (id: number, d: boolean, e?: string) => void marks.push([id, d, e])),
  } as unknown as AlertsRepo;
  const users = { getPreferences: vi.fn(async () => prefs()), setBlocked: vi.fn(async () => undefined) } as unknown as UsersRepo;
  const sender = { sendMessage: vi.fn(opts.send ?? (async () => ({}))) };
  const now = new Date(Date.UTC(2026, 10, 1, opts.hour ?? 12));
  return { notifier: new Notifier(sender, alerts, users, () => now), sender, users, marks };
}

describe('notifier', () => {
  const base = { userId: 1, telegramId: 99, kind: 'test', dedupeKey: 'tx:abc', text: 'hello' };

  it('sends once and drops duplicates', async () => {
    const { notifier, sender } = notifierWith();
    expect(await notifier.notify(base)).toBe('sent');
    expect(await notifier.notify(base)).toBe('duplicate');
    expect(sender.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('respects disabled notifications and quiet hours', async () => {
    const { notifier, sender, marks } = notifierWith({ hour: 23 });
    expect(await notifier.notify({ ...base, prefs: prefs({ notifications_enabled: false }) })).toBe('disabled');
    expect(await notifier.notify({ ...base, prefs: prefs({ quiet_hours_start: 22, quiet_hours_end: 6 }) })).toBe('quiet');
    expect(sender.sendMessage).not.toHaveBeenCalled();
    expect(marks[0]![2]).toMatch(/quiet hours/);
  });

  it('flags users who blocked the bot', async () => {
    const { notifier, users } = notifierWith({ send: async () => Promise.reject({ error_code: 403, description: 'Forbidden: bot was blocked by the user' }) });
    expect(await notifier.notify(base)).toBe('blocked');
    expect(users.setBlocked).toHaveBeenCalledWith(1, true);
  });

  it('records other send failures without throwing', async () => {
    const { notifier, marks } = notifierWith({ send: async () => Promise.reject(new Error('network down')) });
    expect(await notifier.notify(base)).toBe('failed');
    expect(marks[0]).toEqual([1, false, 'network down']);
  });
});
