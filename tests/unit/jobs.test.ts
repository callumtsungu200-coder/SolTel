import { describe, expect, it, vi } from 'vitest';
import type { Notifier } from '../../src/alerts/notifier.js';
import type { ActiveAlert, AlertsRepo } from '../../src/db/alertsRepo.js';
import type { PreferencesRow, Tracker, WalletTransactionRow } from '../../src/db/types.js';
import type { UsersRepo } from '../../src/db/usersRepo.js';
import type { WalletsRepo } from '../../src/db/walletsRepo.js';
import { parseEnvelopes } from '../../src/clients/helius.js';
import { diffHoldings, formatHoldingChanges, simpleHash, SOL_KEY } from '../../src/jobs/holdingsMonitor.js';
import { buildMarketSnapshots } from '../../src/jobs/marketAlerts.js';
import { IntervalJob, mapLimit } from '../../src/jobs/scheduler.js';
import { formatActivityMessage, shouldNotify, toTxRow, WalletActivityProcessor } from '../../src/jobs/walletActivity.js';
import { extractWhaleEvents } from '../../src/jobs/whaleMonitor.js';
import type { PriceQuote } from '../../src/services/prices.js';
import type { TokenMetadataService } from '../../src/services/tokenMetadata.js';
import { normalizeParsedEvent, walletView } from '../../src/services/transactions.js';
import { HttpServer, involvedAddresses, safeEqual } from '../../src/webhooks/server.js';
import { dexPair, enhancedTransfer, JUP, OTHER, parsedSwapEnvelope, parsedTokenTransferEnvelope, parsedTransferEnvelope, POOL, USDC_MINT, WALLET, WSOL_MINT } from '../fixtures/index.js';
import { normalizeEnhanced, enhancedTxSchema } from '../../src/services/transactions.js';

const tx = (env: unknown) => normalizeParsedEvent(parseEnvelopes([env]).items[0]!);
const WALLET_ID = '11111111-1111-4111-8111-111111111111';

const tracker: Tracker = { walletId: WALLET_ID, label: 'Main', userId: 7, telegramId: 700, notifyIncoming: true, notifyOutgoing: false };
const prefs = (over: Partial<PreferencesRow> = {}): PreferencesRow => ({
  user_id: 7,
  notifications_enabled: true,
  notify_wallet_activity: true,
  notify_holdings_changes: true,
  min_notify_sol: 0,
  whale_threshold_usd: 50_000,
  holding_change_pct: 25,
  trending_min_liquidity: 0,
  trending_min_volume: 0,
  trending_sort: 'volume',
  page_size: 5,
  quiet_hours_start: null,
  quiet_hours_end: null,
  updated_at: '',
  ...over,
});

describe('wallet notification rules', () => {
  const incoming = walletView(tx(parsedTransferEnvelope({ from: OTHER, to: WALLET, lamports: 2_000_000_000 })), WALLET);
  const outgoing = walletView(tx(parsedTransferEnvelope({ from: WALLET, to: OTHER, lamports: 2_000_000_000 })), WALLET);
  const tokenIn = walletView(tx(parsedTokenTransferEnvelope({ from: OTHER, to: WALLET, mint: JUP, raw: 5, decimals: 0 })), WALLET);

  it('follows per-wallet direction toggles', () => {
    expect(shouldNotify(incoming, tracker, prefs(), []).notify).toBe(true);
    expect(shouldNotify(outgoing, tracker, prefs(), []).notify).toBe(false);
  });

  it('applies the minimum SOL threshold only to SOL movements', () => {
    expect(shouldNotify(incoming, tracker, prefs({ min_notify_sol: 5 }), []).notify).toBe(false);
    expect(shouldNotify(tokenIn, tracker, prefs({ min_notify_sol: 5 }), []).notify).toBe(true);
  });

  it('lets a matching wallet_activity alert override toggles and reports the alert id', () => {
    const a = {
      id: 'alert-1',
      user_id: 7,
      kind: 'wallet_activity',
      params: { walletId: WALLET_ID, address: WALLET, label: 'Main', direction: 'outgoing', minSol: 1 },
    } as unknown as ActiveAlert;
    expect(shouldNotify(outgoing, tracker, prefs({ notify_wallet_activity: false }), [a])).toEqual({ notify: true, alertId: 'alert-1' });
    const otherUser = { ...a, user_id: 8 } as ActiveAlert;
    expect(shouldNotify(outgoing, tracker, prefs(), [otherUser]).notify).toBe(false);
  });

  it('formats messages without buy/sell wording and with a Solscan link', () => {
    const msg = formatActivityMessage(incoming, 'Main <script>', new Map(), false);
    expect(msg).toContain('Main &lt;script&gt;');
    expect(msg).toContain('https://solscan.io/tx/');
    expect(msg.toLowerCase()).not.toMatch(/\bbuy|\bsell|bought|sold/);
  });

  it('maps views to DB rows', () => {
    const row = toTxRow(walletView(tx(parsedSwapEnvelope()), WALLET));
    expect(row).toMatchObject({ category: 'swap', direction: 'mixed', provider: 'helius-parsed-events' });
    expect(row.token_changes).toEqual(expect.arrayContaining([{ mint: USDC_MINT, amount: 225.5 }, { mint: WSOL_MINT, amount: -1.5 }]));
  });
});

describe('WalletActivityProcessor (duplicate prevention)', () => {
  function setup() {
    const stored = new Set<string>();
    const wallets = {
      insertTransactions: vi.fn(async (rows: WalletTransactionRow[]) => rows.filter((r) => !stored.has(r.signature) && stored.add(r.signature))),
      trackersOf: vi.fn(async () => [tracker]),
    } as unknown as WalletsRepo;
    const alerts = { listActive: vi.fn(async () => []), saveState: vi.fn() } as unknown as AlertsRepo;
    const users = { getPreferencesMany: vi.fn(async () => new Map([[7, prefs()]])) } as unknown as UsersRepo;
    const notify = vi.fn(async () => 'sent' as const);
    const notifier = { notify } as unknown as Notifier;
    const metadata = { getMany: vi.fn(async () => new Map()) } as unknown as TokenMetadataService;
    return { processor: new WalletActivityProcessor(wallets, alerts, users, notifier, metadata), notify };
  }

  it('notifies once per new transaction even if delivered twice (webhook retry + poll)', async () => {
    const { processor, notify } = setup();
    const t = tx(parsedTransferEnvelope({ from: OTHER, to: WALLET, lamports: 1_000_000_000 }));
    expect(await processor.process(WALLET, [t])).toBe(1);
    expect(await processor.process(WALLET, [t])).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((notify.mock.calls[0] as unknown as [{ dedupeKey: string }])[0].dedupeKey).toBe(`tx:${WALLET}:${t.signature}`);
  });
});

describe('holdings change detection', () => {
  const quotes = new Map<string, PriceQuote>([
    [JUP, { mint: JUP, priceUsd: 1, liquidityUsd: 1e6, pairAddress: 'p', dexId: 'd', reliable: true, symbol: 'JUP', name: '', side: 'base' }],
  ]);

  it('reports significant changes, valuable new tokens and removals; ignores spam airdrops', () => {
    const prev = { [SOL_KEY]: 10, [JUP]: 100, [USDC_MINT]: 50 };
    const cur = { [SOL_KEY]: 10.1, [JUP]: 200, SPAM1111111111111111111111111111111111111111: 1_000_000 };
    const changes = diffHoldings(prev, cur, 25, quotes, new Map([[USDC_MINT, 'USDC']]), 100);
    const kinds = Object.fromEntries(changes.map((c) => [c.key, c.kind]));
    expect(kinds[JUP]).toBe('changed');
    expect(kinds[SOL_KEY]).toBeUndefined(); // +1% is below threshold
    expect(kinds.SPAM1111111111111111111111111111111111111111).toBeUndefined(); // unpriced new token = spam filter
    expect(kinds[USDC_MINT]).toBeUndefined(); // removed but no reliable price → value unknown
    const msg = formatHoldingChanges('Main', WALLET, changes);
    expect(msg).toContain('not necessarily trades');
  });

  it('reports SOL going to zero', () => {
    expect(diffHoldings({ [SOL_KEY]: 1 }, { [SOL_KEY]: 0 }, 25, new Map(), new Map(), null)[0]!.kind).toBe('removed');
  });

  it('produces stable short hashes', () => {
    expect(simpleHash('abc')).toBe(simpleHash('abc'));
    expect(simpleHash('abc')).not.toBe(simpleHash('abd'));
  });
});

describe('whale event extraction', () => {
  const txs = [
    tx(parsedTokenTransferEnvelope({ from: OTHER, to: POOL, mint: JUP, raw: 200_000_000_000, decimals: 6 })), // 200k JUP
    tx(parsedTokenTransferEnvelope({ from: OTHER, to: POOL, mint: JUP, raw: 10_000_000, decimals: 6 })), // 10 JUP
    tx(parsedSwapEnvelope()),
    tx(parsedTransferEnvelope({ from: WALLET, to: OTHER, lamports: 1000 * 1e9 })),
  ];
  const prices = new Map([[JUP, 0.5], [USDC_MINT, 1], [WSOL_MINT, 100]]);

  it('keeps only token transfers above the USD threshold and never labels them buys/sells', () => {
    const ev = extractWhaleEvents({ kind: 'token', address: JUP, symbol: 'JUP', minUsd: 50_000 }, txs, 100, prices);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ event_kind: 'token_transfer', usd_value: 100_000, watched: JUP });
  });

  it('detects large SOL transfers and swap legs for wallets', () => {
    const ev = extractWhaleEvents({ kind: 'wallet', address: WALLET, symbol: '', minUsd: 100 }, txs, 100, prices);
    expect(ev.find((e) => e.event_kind === 'sol_transfer')).toMatchObject({ amount: 1000, usd_value: 100_000 });
    expect(ev.filter((e) => e.event_kind === 'swap').length).toBeGreaterThan(0);
  });

  it('skips tokens without a reliable price', () => {
    expect(extractWhaleEvents({ kind: 'token', address: JUP, symbol: '', minUsd: 1 }, txs, null, new Map())).toEqual([]);
  });
});

describe('market snapshots', () => {
  it('aggregates base-side pools per mint', () => {
    const s = buildMarketSnapshots([JUP, USDC_MINT], [dexPair({ base: JUP, liq: 100, price: '2' }), dexPair({ base: JUP, liq: 300, price: '2.2', pairAddress: 'b' })]);
    expect(s.get(JUP)).toMatchObject({ priceUsd: 2.2, liquidityUsd: 400, volume24h: 48_000, txns24h: 720 });
    expect(s.has(USDC_MINT)).toBe(false);
  });
});

describe('webhook receiver', () => {
  it('compares secrets in constant time and finds involved addresses', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    const t = normalizeEnhanced(enhancedTxSchema.parse(enhancedTransfer()));
    expect(involvedAddresses(t)).toEqual(new Set([WALLET, OTHER]));
  });

  it('routes payload transactions to monitored addresses only', async () => {
    const process = vi.fn(async () => 0);
    const server = new HttpServer({ port: 0, webhookSecret: 's', processor: { process } as unknown as WalletActivityProcessor, monitoredAddresses: async () => [OTHER] });
    await server.processPayload([enhancedTransfer(), { not: 'a tx' }]);
    expect(process).toHaveBeenCalledTimes(1);
    expect((process.mock.calls[0] as unknown as [string])[0]).toBe(OTHER);
  });

  it('rejects unauthenticated deliveries over HTTP and serves /health', async () => {
    const process = vi.fn(async () => 0);
    const server = new HttpServer({ port: 0, webhookSecret: 'correct-secret-value', processor: { process } as unknown as WalletActivityProcessor, monitoredAddresses: async () => [WALLET] });
    await server.start();
    const port = ((server as unknown as { server: { address(): { port: number } } }).server.address()).port;
    const bad = await fetch(`http://127.0.0.1:${port}/webhooks/helius`, { method: 'POST', headers: { authorization: 'wrong' }, body: '[]' });
    expect(bad.status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${port}/webhooks/helius`, { method: 'POST', headers: { authorization: 'correct-secret-value' }, body: JSON.stringify([enhancedTransfer()]) });
    expect(ok.status).toBe(200);
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
    await server.stop();
    expect(process).toHaveBeenCalledTimes(1);
  });
});

describe('scheduler', () => {
  it('never runs a job concurrently', async () => {
    let running = 0;
    let maxRunning = 0;
    const job = new IntervalJob('t', 1_000_000, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
    }, 1_000_000);
    await Promise.all([job.tick(), job.tick(), job.tick()]);
    await job.stop();
    expect(maxRunning).toBe(1);
  });

  it('mapLimit bounds concurrency and captures errors', async () => {
    let active = 0;
    let peak = 0;
    const r = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((res) => setTimeout(res, 5));
      active--;
      if (n === 3) throw new Error('x');
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(r.filter((x) => !x.ok)).toHaveLength(1);
    expect(r[0]).toEqual({ ok: true, value: 2 });
  });
});
