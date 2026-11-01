import { InlineKeyboard } from 'grammy';
import { isUniqueViolation } from '../../db/client.js';
import { UserInputError } from '../../utils/errors.js';
import { code, escapeHtml, shortAddr } from '../../utils/format.js';
import { createLogger } from '../../utils/logger.js';
import { isValidSolanaAddress } from '../../validation/address.js';
import { parseLabel } from '../../validation/inputs.js';
import { setAwaiting, type BotContext } from '../context.js';
import { withNav } from '../keyboards.js';
import { render, withLoading } from '../render.js';
import { promptView } from '../views/menu.js';
import {
  interactionView,
  walletAcquisitionsView,
  walletAnalyticsView,
  walletCounterpartiesView,
  walletHoldingsView,
  walletOverviewView,
  walletTimelineView,
  walletTransactionsView,
} from '../views/wallet.js';

const log = createLogger('wallet-actions');

export function assertAddress(addr: string): string {
  if (!isValidSolanaAddress(addr)) throw new UserInputError('That is not a valid Solana address. Addresses are 32–44 base58 characters.');
  return addr;
}

export async function showWalletMenu(ctx: BotContext): Promise<void> {
  const tracked = await ctx.app.wallets.list(ctx.dbUser.id);
  setAwaiting(ctx, 'wallet_lookup');
  const kb = new InlineKeyboard();
  tracked.slice(0, 8).forEach((w, i) => {
    kb.text(`👛 ${w.label.slice(0, 16)}`, `wal:p:${w.address}`);
    if (i % 2 === 1) kb.row();
  });
  await render(ctx, {
    text:
      '👛 <b>Wallet Intelligence</b>\n\nSend any public Solana wallet address to get a full profile: balances, holdings, estimated value, activity, timeline, flows and analytics.' +
      (tracked.length ? '\n\nOr pick one of your tracked wallets:' : '') +
      '\n\n<i>Public addresses only — never send a private key or seed phrase.</i>',
    keyboard: withNav(kb),
  });
}

export async function showWalletProfile(ctx: BotContext, address: string, fresh = false): Promise<void> {
  assertAddress(address);
  await withLoading(ctx, 'Analysing wallet…', async () => {
    const [profile, tracked] = await Promise.all([
      ctx.app.walletIntel.getProfile(address, { fresh }),
      ctx.app.wallets.findByAddress(ctx.dbUser.id, address),
    ]);
    return walletOverviewView(profile, tracked !== null);
  });
}

export type WalletSub = 'h' | 't' | 'tl' | 'an' | 'aq' | 'cp';

export async function showWalletSub(ctx: BotContext, address: string, sub: WalletSub, page = 0): Promise<void> {
  assertAddress(address);
  const prefs = await ctx.getPrefs();
  await withLoading(ctx, 'Loading…', async () => {
    const p = await ctx.app.walletIntel.getProfile(address);
    switch (sub) {
      case 'h':
        return walletHoldingsView(p, page, prefs.page_size);
      case 't':
        return walletTransactionsView(p, page, prefs.page_size);
      case 'tl':
        return walletTimelineView(p);
      case 'an':
        return walletAnalyticsView(p);
      case 'aq':
        return walletAcquisitionsView(p, page, prefs.page_size);
      case 'cp':
        return walletCounterpartiesView(p);
    }
  });
}

export async function showInteraction(ctx: BotContext, address: string, other: string): Promise<void> {
  assertAddress(address);
  assertAddress(other);
  await withLoading(ctx, 'Checking interactions…', async () => interactionView(await ctx.app.walletIntel.getProfile(address), other));
}

export async function startTrackWallet(ctx: BotContext, address: string): Promise<void> {
  assertAddress(address);
  const userId = ctx.dbUser.id;
  if (await ctx.app.wallets.findByAddress(userId, address)) {
    await render(ctx, { text: `You already track ${code(address)}.`, keyboard: withNav(new InlineKeyboard().text('⭐ Tracked wallets', 'wls:w:0')) });
    return;
  }
  const max = ctx.app.config.MAX_TRACKED_WALLETS_PER_USER;
  if ((await ctx.app.wallets.count(userId)) >= max) throw new UserInputError(`You can track up to ${max} wallets. Remove one first.`);
  setAwaiting(ctx, 'track_label', { address });
  const view = promptView(`⭐ Tracking ${code(address)}\n\nSend a label for this wallet (e.g. "Main", "Whale #1"), or use the default.`, 'wls:w:0');
  view.keyboard = new InlineKeyboard().text(`Use "${shortAddr(address)}"`, `wls:wdef:${address}`).row().text('✖️ Cancel', 'wls:w:0');
  await render(ctx, view);
}

export async function trackWallet(ctx: BotContext, address: string, rawLabel: string): Promise<void> {
  assertAddress(address);
  const label = parseLabel(rawLabel);
  const userId = ctx.dbUser.id;
  const max = ctx.app.config.MAX_TRACKED_WALLETS_PER_USER;
  if ((await ctx.app.wallets.count(userId)) >= max) throw new UserInputError(`You can track up to ${max} wallets. Remove one first.`);
  let row;
  try {
    row = await ctx.app.wallets.add(userId, address, label);
  } catch (err) {
    if (isUniqueViolation(err)) throw new UserInputError('You already track this wallet.');
    throw err;
  }
  ctx.app.onWalletsChanged();
  // First snapshot in the background so portfolio history starts immediately.
  void ctx.app.snapshots.ensureRecent(address).catch((err) => log.warn('initial snapshot failed', { error: (err as Error).message }));
  await render(ctx, {
    text: `✅ Now tracking <b>${escapeHtml(row.label)}</b>\n${code(address)}\n\nYou'll be notified about new incoming/outgoing activity and significant holding changes. Adjust thresholds in ⚙️ Settings.`,
    keyboard: withNav(new InlineKeyboard().text('⚙️ Wallet options', `wls:wv:${row.id}`).text('👛 Profile', `wal:p:${address}`), 'wls:w:0'),
  });
}
