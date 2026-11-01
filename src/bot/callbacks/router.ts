import type { Bot } from 'grammy';
import * as alerts from '../actions/alerts.js';
import * as market from '../actions/market.js';
import * as settings from '../actions/settings.js';
import * as token from '../actions/token.js';
import * as wallet from '../actions/wallet.js';
import * as lists from '../actions/watchlists.js';
import { clearAwaiting, setAwaiting, type BotContext } from '../context.js';
import { render } from '../render.js';
import { helpView, mainMenuView, methodologyView, promptView } from '../views/menu.js';

type Handler = (ctx: BotContext, args: string[]) => Promise<void>;

const int = (s: string | undefined) => {
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

/**
 * Callback data format: `<section>[:<action>[:<arg>...]]`.
 * Each route receives the remaining colon-separated parts. Every handler
 * re-validates its arguments (callback data can be forged by clients).
 */
export const routes: Record<string, Handler> = {
  menu: (ctx) => render(ctx, mainMenuView(ctx.from?.first_name)),
  help: (ctx) => render(ctx, helpView()),
  methodology: (ctx) => render(ctx, methodologyView()),
  noop: async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => undefined);
  },

  // Wallet intelligence
  wal: async (ctx, [action, addr, extra]) => {
    switch (action) {
      case undefined:
        return wallet.showWalletMenu(ctx);
      case 'p':
        return wallet.showWalletProfile(ctx, addr ?? '');
      case 'r':
        return wallet.showWalletProfile(ctx, addr ?? '', true);
      case 'h':
      case 't':
      case 'aq':
        return wallet.showWalletSub(ctx, addr ?? '', action, int(extra));
      case 'tl':
      case 'an':
      case 'cp':
        return wallet.showWalletSub(ctx, addr ?? '', action);
      case 'track':
        return wallet.startTrackWallet(ctx, addr ?? '');
      case 'ix':
        wallet.assertAddress(addr ?? '');
        setAwaiting(ctx, 'interaction_lookup', { address: addr! });
        return render(ctx, promptView('🔍 Send the other address to check direct interactions with this wallet.', `wal:cp:${addr}`));
    }
  },

  // Token intelligence
  tok: async (ctx, [action, mint]) => {
    switch (action) {
      case undefined:
        return token.showTokenMenu(ctx);
      case 'p':
      case 'r':
        return token.showTokenReport(ctx, mint ?? '');
      case 'pairs':
      case 'hist':
      case 'conc':
        return token.showTokenSub(ctx, mint ?? '', action);
      case 'watch':
        return token.watchToken(ctx, mint ?? '');
      case 'alert':
        return token.showTokenAlertMenu(ctx, mint ?? '');
    }
  },

  // Trending
  trd: async (ctx, [a, b]) => {
    if (a === 'f') return market.showTrendingFilters(ctx);
    if (a === 'liq' || a === 'vol') return market.setTrendingFilter(ctx, a, Number(b));
    return market.showTrending(ctx, market.parseSort(a), int(b));
  },

  // Transaction monitor + whales
  txm: async (ctx, [action, a, b]) => {
    switch (action) {
      case undefined:
        return market.showTxMenu(ctx);
      case 'look':
        return market.promptTxLookup(ctx);
      case 'feed':
        return market.showFeed(ctx, int(a));
      case 'wh':
        return market.showWhales(ctx, int(a), null);
      case 'wf':
        return market.showWhales(ctx, int(b), a ?? null);
      case 'wfa':
        return market.promptWhaleParticipant(ctx);
      case 'wadd':
        if (a === 't') return market.promptWhaleTarget(ctx, 'token');
        if (a === 'w') return market.promptWhaleTarget(ctx, 'wallet');
        return market.showWhaleAdd(ctx);
    }
  },

  // Watchlists
  wls: async (ctx, [action, a, b]) => {
    switch (action) {
      case undefined:
        return lists.showWatchlists(ctx);
      case 'w':
        return lists.showTrackedWallets(ctx, int(a));
      case 'wv':
        return lists.showTrackedWallet(ctx, a ?? '');
      case 'wadd':
        return lists.promptAddWallet(ctx);
      case 'wdef':
        clearAwaiting(ctx);
        return wallet.trackWallet(ctx, a ?? '', `${(a ?? '').slice(0, 4)}…${(a ?? '').slice(-4)}`);
      case 'wrn':
        return lists.promptRenameWallet(ctx, a ?? '');
      case 'wrm':
        return lists.confirmRemoveWallet(ctx, a ?? '');
      case 'wrmy':
        return lists.removeWallet(ctx, a ?? '');
      case 'win':
        return lists.toggleWalletNotify(ctx, a ?? '', 'in');
      case 'wout':
        return lists.toggleWalletNotify(ctx, a ?? '', 'out');
      case 'wa':
        return lists.showStoredActivity(ctx, a ?? '', int(b));
      case 't':
        return lists.showTokenWatchlist(ctx, int(a));
      case 'tadd':
        return lists.promptAddToken(ctx);
      case 'trm':
        return lists.removeToken(ctx, a ?? '');
    }
  },

  // Portfolio
  pf: async (ctx, [action, id]) => {
    switch (action) {
      case undefined:
        return lists.showPortfolioMenu(ctx);
      case 'v':
        return lists.showPortfolio(ctx, id ?? '');
      case 'all':
        return lists.showCombinedPortfolio(ctx);
      case 'h':
        return lists.showPortfolioHistory(ctx, id ?? '');
      case 'perf':
        return lists.showPriceExposure(ctx, id ?? '');
      case 'snap':
        return lists.snapshotNow(ctx, id ?? '');
    }
  },

  // Alerts
  al: async (ctx, [action, a, b]) => {
    switch (action) {
      case undefined:
        return alerts.showAlertsMenu(ctx);
      case 'list':
        return alerts.showAlertList(ctx, int(a));
      case 'v':
        return alerts.showAlert(ctx, a ?? '');
      case 'tog':
        return alerts.toggleAlert(ctx, a ?? '');
      case 'del':
        return alerts.confirmDeleteAlert(ctx, a ?? '');
      case 'dely':
        return alerts.deleteAlert(ctx, a ?? '');
      case 'edit':
        return alerts.promptEditAlert(ctx, a ?? '');
      case 'cd':
        return alerts.showCooldown(ctx, a ?? '');
      case 'cds':
        return alerts.setCooldown(ctx, a ?? '', Number(b));
      case 'new':
        return alerts.showNewAlertMenu(ctx);
      case 'nk':
        return alerts.startNewAlert(ctx, a ?? '', b);
      case 'nw':
        return alerts.startWalletAlert(ctx, a ?? '');
      case 'hist':
        return alerts.showAlertHistory(ctx, int(a));
    }
  },

  // Settings
  set: async (ctx, [action, a]) => {
    switch (action) {
      case undefined:
        return settings.showSettings(ctx);
      case 't':
        return settings.toggleSetting(ctx, a ?? '');
      case 'n':
        return settings.promptNumberSetting(ctx, a ?? '');
      case 'whale':
        return settings.promptNumberSetting(ctx, 'whale_threshold_usd');
      case 'quiet':
        return settings.promptQuietHours(ctx);
      case 'pg':
        return settings.showPageSize(ctx);
      case 'pgs':
        return settings.setPageSize(ctx, Number(a));
    }
  },
};

export function parseCallbackData(data: string): { section: string; args: string[] } {
  const [section = '', ...args] = data.split(':');
  return { section, args };
}

export function registerCallbacks(bot: Bot<BotContext>): void {
  bot.on('callback_query:data', async (ctx) => {
    const { section, args } = parseCallbackData(ctx.callbackQuery.data);
    const handler = routes[section];
    if (!handler) {
      await ctx.answerCallbackQuery({ text: 'This button has expired.' }).catch(() => undefined);
      return;
    }
    // Navigating away cancels any pending text input, except for prompts the handler sets itself.
    clearAwaiting(ctx);
    await handler(ctx, args);
    // Ensure the client's spinner stops even if the handler didn't answer.
    await ctx.answerCallbackQuery().catch(() => undefined);
  });
}
