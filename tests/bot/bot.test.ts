import { generateKeyPairSync } from 'node:crypto';
import type { Update } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletIntelService } from '../../src/analytics/wallet.js';
import { createBot } from '../../src/bot/bot.js';
import { routes } from '../../src/bot/callbacks/router.js';
import { MAIN_MENU_ITEMS } from '../../src/bot/keyboards.js';
import type { HeliusClient } from '../../src/clients/helius.js';
import type { SolanaRpcClient } from '../../src/clients/solanaRpc.js';
import type { AlertRow, PreferencesRow, TrackedWalletRow, UserRow } from '../../src/db/types.js';
import type { AppServices } from '../../src/services/container.js';
import type { PriceQuote, PriceService } from '../../src/services/prices.js';
import type { TokenMetadataService } from '../../src/services/tokenMetadata.js';
import { RateLimitError } from '../../src/utils/errors.js';
import { base58Encode } from '../../src/validation/address.js';
import { JUP, OTHER, parsedSwapEnvelope, parsedTransferEnvelope, USDC_MINT, WALLET, WSOL_MINT } from '../fixtures/index.js';
import { parseEnvelopes } from '../../src/clients/helius.js';

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

const USER_ID = 1001;
const PREFS: PreferencesRow = {
  user_id: 1,
  notifications_enabled: true,
  notify_wallet_activity: true,
  notify_holdings_changes: true,
  min_notify_sol: 0,
  whale_threshold_usd: 50000,
  holding_change_pct: 25,
  trending_min_liquidity: 0,
  trending_min_volume: 0,
  trending_sort: 'volume',
  page_size: 5,
  quiet_hours_start: null,
  quiet_hours_end: null,
  updated_at: '',
};

function makeApp() {
  const user: UserRow = { id: 1, telegram_id: USER_ID, username: 'tester', first_name: 'Test', language_code: 'en', is_blocked: false, created_at: '', last_seen_at: '' };
  const tracked: TrackedWalletRow[] = [];
  const createdAlerts: AlertRow[] = [];

  const rpc = {
    getBalance: vi.fn(async () => 2_500_000_000),
    getAccountBasics: vi.fn(async () => ({ owner: '11111111111111111111111111111111', executable: false, lamports: 2_500_000_000 })),
    getSignaturesForAddress: vi.fn(async () => [{ signature: 'a', slot: 1, blockTime: 1_600_000_000 }]),
    getMintInfo: vi.fn(async (a: string) => (a === JUP ? { decimals: 6, supplyRaw: '1', mintAuthority: null, freezeAuthority: null, program: 'x' } : null)),
    getTokenAccountsByOwner: vi.fn(async () => []),
  } as unknown as SolanaRpcClient;
  const helius = {
    getAssetsByOwner: vi.fn(async () => ({
      items: [{ id: USDC_MINT, interface: 'FungibleToken', content: { metadata: { symbol: 'USDC', name: 'USD Coin' } }, token_info: { balance: 150_000_000, decimals: 6 } }],
      nativeLamports: 2_500_000_000,
      total: 1,
      truncated: false,
    })),
    getTransactionHistory: vi.fn(async () => ({
      items: parseEnvelopes([parsedSwapEnvelope(), parsedTransferEnvelope({ from: OTHER, to: WALLET, lamports: 3_000_000_000 })]).items,
      paginationToken: null,
      skipped: 0,
    })),
  } as unknown as HeliusClient;
  const quote = (mint: string, price: number, symbol: string): PriceQuote => ({ mint, priceUsd: price, liquidityUsd: 1e6, pairAddress: 'p', dexId: 'd', reliable: true, symbol, name: symbol, side: 'base' });
  const prices = {
    getQuotes: vi.fn(async () => new Map([[WSOL_MINT, quote(WSOL_MINT, 100, 'SOL')], [USDC_MINT, quote(USDC_MINT, 1, 'USDC')]])),
  } as unknown as PriceService;
  const metadata = { getMany: vi.fn(async () => new Map()), get: vi.fn(async () => ({ symbol: 'JUP' })) } as unknown as TokenMetadataService;
  const walletIntel = new WalletIntelService({ rpc, helius, prices, metadata, historyMaxPages: 1 });

  const app = {
    config: { MAX_TRACKED_WALLETS_PER_USER: 5, MAX_ALERTS_PER_USER: 10, useWebhooks: false },
    rpc,
    helius,
    prices,
    metadata,
    walletIntel,
    users: {
      upsertFromTelegram: vi.fn(async () => user),
      getPreferences: vi.fn(async () => PREFS),
      updatePreferences: vi.fn(async (_: number, patch: Partial<PreferencesRow>) => ({ ...PREFS, ...patch })),
    },
    wallets: {
      list: vi.fn(async () => tracked),
      count: vi.fn(async () => tracked.length),
      findByAddress: vi.fn(async (_: number, a: string) => tracked.find((t) => t.address === a) ?? null),
      add: vi.fn(async (userId: number, address: string, label: string) => {
        const row = { id: '33333333-3333-4333-8333-333333333333', user_id: userId, address, label, notify_incoming: true, notify_outgoing: true, created_at: '', updated_at: '' };
        tracked.push(row);
        return row;
      }),
      listWatchlist: vi.fn(async () => []),
    },
    alerts: {
      count: vi.fn(async () => createdAlerts.length),
      list: vi.fn(async () => createdAlerts),
      create: vi.fn(async (userId: number, kind: AlertRow['kind'], params: Record<string, unknown>, cooldown: number) => {
        const a: AlertRow = { id: '44444444-4444-4444-8444-444444444444', user_id: userId, kind, params, is_active: true, cooldown_minutes: cooldown, state: {}, last_triggered_at: null, trigger_count: 0, created_at: '', updated_at: '' };
        createdAlerts.push(a);
        return a;
      }),
    },
    snapshots: { ensureRecent: vi.fn(async () => undefined) },
    onWalletsChanged: vi.fn(),
  };
  return { app: app as unknown as AppServices, raw: app };
}

function setup(rateLimit = 600) {
  const { app, raw } = makeApp();
  const bot = createBot({
    token: '123456:TEST-TOKEN-abcdefghijklmnopqrstuvwxyz',
    app,
    userRateLimitPerMin: rateLimit,
    botInfo: { id: 1, is_bot: true, first_name: 'IntelBot', username: 'intel_test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false },
  });
  const calls: ApiCall[] = [];
  let messageId = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const p = payload as Record<string, unknown>;
    const result =
      method === 'sendMessage' || method === 'editMessageText'
        ? { message_id: ++messageId, date: 0, chat: { id: p.chat_id ?? USER_ID, type: 'private' }, text: p.text }
        : true;
    return { ok: true, result } as never;
  });
  // Mirrors @grammyjs/runner, which hands middleware errors to bot.catch.
  const dispatch = (u: Update) => bot.handleUpdate(u).catch((e) => bot.errorHandler(e));
  let updateId = 1;
  const from = { id: USER_ID, is_bot: false, first_name: 'Test', username: 'tester' };
  const chat = { id: USER_ID, type: 'private' as const, first_name: 'Test' };
  const send = (text: string, chatOverride?: Record<string, unknown>) => {
    const entities = text.startsWith('/') ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length }] : undefined;
    return dispatch({ update_id: updateId++, message: { message_id: updateId, date: 0, chat: (chatOverride ?? chat) as never, from, text, entities } } as Update);
  };
  const press = (data: string) =>
    dispatch({
      update_id: updateId++,
      callback_query: { id: String(updateId), from, chat_instance: 'x', data, message: { message_id: 50, date: 0, chat, from: { id: 1, is_bot: true, first_name: 'IntelBot' }, text: 'old' } },
    } as Update);
  const texts = () => calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText').map((c) => String(c.payload.text));
  return { bot, calls, send, press, texts, raw };
}

function allCallbackData(calls: ApiCall[]): string[] {
  const out: string[] = [];
  for (const c of calls) {
    const kb = (c.payload.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)?.inline_keyboard;
    for (const row of kb ?? []) for (const b of row) if (b.callback_data) out.push(b.callback_data);
  }
  return out;
}

describe('Telegram command handling', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it('/start shows the dashboard with all eight sections, each wired to a route', async () => {
    await t.send('/start');
    const msg = t.calls.find((c) => c.method === 'sendMessage')!;
    expect(String(msg.payload.text)).toContain('SolTel Dashboard');
    expect(msg.payload.parse_mode).toBe('HTML');
    const data = allCallbackData([msg]);
    expect(data).toEqual(MAIN_MENU_ITEMS.map(([, d]) => d));
    for (const d of data) expect(routes[d.split(':')[0]!], d).toBeDefined();
    expect(t.raw.users.upsertFromTelegram).toHaveBeenCalledWith(expect.objectContaining({ telegramId: USER_ID }));
  });

  it('/help and the menu callback render with navigation', async () => {
    await t.send('/help');
    expect(t.texts()[0]).toContain('/wallet');
    await t.press('menu');
    const edit = t.calls.find((c) => c.method === 'editMessageText')!;
    expect(String(edit.payload.text)).toContain('Dashboard');
    expect(t.calls.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
  });

  it('/wallet <address> shows a loading indicator, then the wallet profile', async () => {
    await t.send(`/wallet ${WALLET}`);
    const texts = t.texts();
    expect(texts[0]).toContain('⏳');
    const profile = texts.find((x) => x.includes('Wallet Profile'))!;
    expect(profile).toContain('2.5 SOL');
    expect(profile).toContain('$400.00'); // 2.5 SOL × $100 + 150 USDC
    expect(profile).toContain('Swaps 1');
    expect(profile).toContain('Activity score');
    for (const d of allCallbackData(t.calls)) expect(Buffer.byteLength(d), d).toBeLessThanOrEqual(64);
  });

  it('rejects invalid addresses with a friendly message and keeps the prompt open', async () => {
    await t.press('wal');
    await t.send('not-an-address');
    expect(t.texts().at(-1)).toMatch(/not a valid Solana address/);
    await t.send(WALLET);
    expect(t.texts().some((x) => x.includes('Wallet Profile'))).toBe(true);
  });

  it('auto-detects pasted token mints vs wallets', async () => {
    t.raw.rpc.getMintInfo = vi.fn(async () => null) as never;
    await t.send(`https://solscan.io/account/${WALLET}`);
    expect(t.texts().some((x) => x.includes('Wallet Profile'))).toBe(true);
  });

  it('deletes pasted private keys and never processes them', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const secret = base58Encode(
      Uint8Array.from([...privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32), ...publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)]),
    );
    await t.send(`/tx ${secret}`);
    expect(t.calls.some((c) => c.method === 'deleteMessage')).toBe(true);
    expect(t.texts()[0]).toMatch(/private key or seed phrase/);
    expect(t.raw.rpc.getMintInfo).not.toHaveBeenCalled();
    expect(t.raw.users.upsertFromTelegram).not.toHaveBeenCalled();
  });

  it('ignores group chats (private data stays private)', async () => {
    await t.send('/start', { id: -100, type: 'supergroup', title: 'g' });
    expect(t.texts()[0]).toMatch(/only work in private chats/);
    expect(t.raw.users.upsertFromTelegram).not.toHaveBeenCalled();
  });

  it('shows a user-facing error when an upstream API is rate limited', async () => {
    t.raw.rpc.getBalance = vi.fn(async () => {
      throw new RateLimitError('Solana RPC');
    }) as never;
    await t.send(`/wallet ${OTHER}`);
    expect(t.texts().at(-1)).toMatch(/Solana RPC is rate limiting/);
  });

  it('answers expired / unknown buttons', async () => {
    await t.press('doesnotexist:1');
    const ans = t.calls.find((c) => c.method === 'answerCallbackQuery')!;
    expect(ans.payload.text).toMatch(/expired/);
  });

  it('tracks a wallet with a label and triggers monitor sync', async () => {
    await t.send(`/track ${WALLET} Treasury`);
    expect(t.raw.wallets.add).toHaveBeenCalledWith(1, WALLET, 'Treasury');
    expect(t.raw.onWalletsChanged).toHaveBeenCalled();
    expect(t.texts().at(-1)).toContain('Now tracking <b>Treasury</b>');
  });

  it('creates a price-move alert through the button + text flow', async () => {
    await t.press(`al:nk:pm:${JUP}`);
    expect(t.texts().at(-1)).toMatch(/percentage move/);
    await t.send('up 15');
    expect(t.raw.alerts.create).toHaveBeenCalledWith(1, 'price_move', { mint: JUP, symbol: 'JUP', percent: 15, direction: 'up' }, 30);
    expect(t.texts().at(-1)).toContain('Alert created');
  });

  it('validates alert input and lets the user retry', async () => {
    await t.press(`al:nk:pt:${JUP}`);
    await t.send('to the moon');
    expect(t.texts().at(-1)).toMatch(/above 1.25/);
    await t.send('above 2');
    expect(t.raw.alerts.create).toHaveBeenCalledWith(1, 'price_target', expect.objectContaining({ condition: 'above', price: 2 }), 60);
  });

  it('/cancel clears a pending prompt', async () => {
    await t.press('wal');
    await t.send('/cancel');
    expect(t.texts().some((x) => x === 'Cancelled.')).toBe(true);
  });
});

describe('rate limiting', () => {
  it('throttles users who send too many requests', async () => {
    const t = setup(3);
    for (let i = 0; i < 6; i++) await t.send('/help');
    expect(t.texts().some((x) => x.includes('too quickly'))).toBe(true);
    expect(t.texts().filter((x) => x.includes('/wallet')).length).toBeLessThan(6);
  });
});
