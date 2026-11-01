import type { Bot } from 'grammy';
import { extractAddress, extractSignature } from '../../validation/address.js';
import { splitFirstToken } from '../../validation/inputs.js';
import * as alerts from '../actions/alerts.js';
import * as market from '../actions/market.js';
import * as settings from '../actions/settings.js';
import * as token from '../actions/token.js';
import * as wallet from '../actions/wallet.js';
import * as lists from '../actions/watchlists.js';
import { clearAwaiting, type BotContext } from '../context.js';
import { render } from '../render.js';
import { helpView, mainMenuView, methodologyView } from '../views/menu.js';

/** Commands shown in Telegram's command menu (setMyCommands). */
export const COMMAND_LIST: Array<{ command: string; description: string }> = [
  { command: 'start', description: 'Open the dashboard' },
  { command: 'wallet', description: 'Wallet profile: /wallet <address>' },
  { command: 'token', description: 'Token report: /token <mint>' },
  { command: 'tx', description: 'Transaction details: /tx <signature>' },
  { command: 'trending', description: 'Trending token explorer' },
  { command: 'track', description: 'Track a wallet: /track <address> [label]' },
  { command: 'watch', description: 'Watch a token: /watch <mint>' },
  { command: 'portfolio', description: 'Portfolio analytics' },
  { command: 'whales', description: 'Whale activity monitor' },
  { command: 'alerts', description: 'Manage alerts' },
  { command: 'settings', description: 'Preferences' },
  { command: 'methodology', description: 'How scores and estimates work' },
  { command: 'help', description: 'Help' },
  { command: 'cancel', description: 'Cancel the current input' },
];

export function registerCommands(bot: Bot<BotContext>): void {
  bot.command(['start', 'menu'], async (ctx) => {
    clearAwaiting(ctx);
    // Deep links: t.me/<bot>?start=<address> open the address directly.
    const payload = ctx.match?.trim();
    const addr = payload ? extractAddress(payload) : null;
    if (addr) return token.openAddress(ctx, addr);
    await render(ctx, mainMenuView(ctx.from?.first_name));
  });

  bot.command('help', (ctx) => render(ctx, helpView()));
  bot.command('methodology', (ctx) => render(ctx, methodologyView()));

  bot.command('cancel', async (ctx) => {
    const had = Boolean(ctx.session.awaiting);
    clearAwaiting(ctx);
    await ctx.reply(had ? 'Cancelled.' : 'Nothing to cancel.');
    await render(ctx, mainMenuView(ctx.from?.first_name));
  });

  bot.command('wallet', async (ctx) => {
    const addr = extractAddress(ctx.match ?? '');
    if (!addr) return wallet.showWalletMenu(ctx);
    return wallet.showWalletProfile(ctx, addr);
  });

  bot.command('token', async (ctx) => {
    const mint = extractAddress(ctx.match ?? '');
    if (!mint) return token.showTokenMenu(ctx);
    return token.showTokenReport(ctx, mint);
  });

  bot.command('tx', async (ctx) => {
    const sig = extractSignature(ctx.match ?? '');
    if (!sig) return market.promptTxLookup(ctx);
    return market.showTransaction(ctx, sig);
  });

  bot.command('trending', async (ctx) => market.showTrending(ctx, (await ctx.getPrefs()).trending_sort, 0));

  bot.command('track', async (ctx) => {
    const [first, label] = splitFirstToken(ctx.match ?? '');
    const addr = extractAddress(first);
    if (!addr) return lists.promptAddWallet(ctx);
    if (label) return wallet.trackWallet(ctx, addr, label);
    return wallet.startTrackWallet(ctx, addr);
  });

  bot.command('watch', async (ctx) => {
    const mint = extractAddress(ctx.match ?? '');
    if (!mint) return lists.promptAddToken(ctx);
    return token.watchToken(ctx, mint);
  });

  bot.command('portfolio', (ctx) => lists.showPortfolioMenu(ctx));
  bot.command('whales', (ctx) => market.showWhales(ctx, 0, null));
  bot.command('alerts', (ctx) => alerts.showAlertsMenu(ctx));
  bot.command('settings', (ctx) => settings.showSettings(ctx));
}
