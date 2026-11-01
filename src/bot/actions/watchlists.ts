import { InlineKeyboard } from 'grammy';
import { priceHoldings, summarize, type Holding, type RawBalance } from '../../analytics/portfolio.js';
import type { TrackedWalletRow } from '../../db/types.js';
import { liquidityOf, selectQuotes, type PriceQuote } from '../../services/prices.js';
import { symbolOf } from '../../services/tokenMetadata.js';
import { mapLimit } from '../../jobs/scheduler.js';
import { UserInputError } from '../../utils/errors.js';
import { escapeHtml } from '../../utils/format.js';
import { WSOL_MINT } from '../../validation/address.js';
import { parseLabel } from '../../validation/inputs.js';
import { setAwaiting, type BotContext } from '../context.js';
import { withNav } from '../keyboards.js';
import { render, withLoading, toast } from '../render.js';
import { promptView } from '../views/menu.js';
import {
  combinedTitle,
  portfolioHistoryView,
  portfolioMenuView,
  portfolioView,
  priceExposureView,
  type ExposureRow,
} from '../views/portfolio.js';
import {
  confirmRemoveWalletView,
  storedActivityView,
  tokenWatchlistView,
  trackedWalletsView,
  trackedWalletView,
  watchlistsMenuView,
} from '../views/watchlists.js';

async function requireWallet(ctx: BotContext, id: string): Promise<TrackedWalletRow> {
  const w = await ctx.app.wallets.get(ctx.dbUser.id, id);
  if (!w) throw new UserInputError('That tracked wallet no longer exists.');
  return w;
}

// ---------- Watchlists ----------

export async function showWatchlists(ctx: BotContext): Promise<void> {
  const [w, t] = await Promise.all([ctx.app.wallets.list(ctx.dbUser.id), ctx.app.wallets.listWatchlist(ctx.dbUser.id)]);
  await render(ctx, watchlistsMenuView(w.length, t.length));
}

export async function showTrackedWallets(ctx: BotContext, page: number): Promise<void> {
  const [rows, prefs] = await Promise.all([ctx.app.wallets.list(ctx.dbUser.id), ctx.getPrefs()]);
  await render(ctx, trackedWalletsView(rows, page, prefs.page_size, ctx.app.config.MAX_TRACKED_WALLETS_PER_USER));
}

export async function showTrackedWallet(ctx: BotContext, id: string): Promise<void> {
  await render(ctx, trackedWalletView(await requireWallet(ctx, id)));
}

export async function promptAddWallet(ctx: BotContext): Promise<void> {
  setAwaiting(ctx, 'track_wallet');
  await render(ctx, promptView('➕ Send the public wallet address to track, optionally followed by a label.\nExample: <code>&lt;address&gt; Treasury</code>', 'wls:w:0'));
}

export async function promptRenameWallet(ctx: BotContext, id: string): Promise<void> {
  const w = await requireWallet(ctx, id);
  setAwaiting(ctx, 'rename_wallet', { id });
  await render(ctx, promptView(`✏️ Send a new label for <b>${escapeHtml(w.label)}</b>:`, `wls:wv:${id}`));
}

export async function renameWallet(ctx: BotContext, id: string, raw: string): Promise<void> {
  const label = parseLabel(raw);
  const w = await ctx.app.wallets.rename(ctx.dbUser.id, id, label);
  if (!w) throw new UserInputError('That tracked wallet no longer exists.');
  await render(ctx, trackedWalletView(w));
}

export async function confirmRemoveWallet(ctx: BotContext, id: string): Promise<void> {
  await render(ctx, confirmRemoveWalletView(await requireWallet(ctx, id)));
}

export async function removeWallet(ctx: BotContext, id: string): Promise<void> {
  const removed = await ctx.app.wallets.remove(ctx.dbUser.id, id);
  if (!removed) throw new UserInputError('That tracked wallet no longer exists.');
  // Deactivate wallet alerts that pointed at the removed wallet.
  const alerts = await ctx.app.alerts.list(ctx.dbUser.id);
  for (const a of alerts) {
    if (a.kind === 'wallet_activity' && (a.params as { walletId?: string }).walletId === id) await ctx.app.alerts.delete(ctx.dbUser.id, a.id);
  }
  ctx.app.onWalletsChanged();
  await render(ctx, { text: `🗑 Stopped tracking <b>${escapeHtml(removed.label)}</b>.`, keyboard: withNav(new InlineKeyboard().text('👛 Tracked wallets', 'wls:w:0')) });
}

export async function toggleWalletNotify(ctx: BotContext, id: string, which: 'in' | 'out'): Promise<void> {
  const w = await requireWallet(ctx, id);
  const updated = await ctx.app.wallets.setNotify(ctx.dbUser.id, id, which === 'in' ? { notify_incoming: !w.notify_incoming } : { notify_outgoing: !w.notify_outgoing });
  await toast(ctx, 'Saved');
  await render(ctx, trackedWalletView(updated ?? w));
}

export async function showStoredActivity(ctx: BotContext, id: string, page: number): Promise<void> {
  const w = await requireWallet(ctx, id);
  const prefs = await ctx.getPrefs();
  const size = prefs.page_size * 2;
  const rows = await ctx.app.wallets.recentTransactions(w.address, size + 1, page * size);
  const mints = [...new Set(rows.flatMap((r) => r.token_changes.map((t) => t.mint)))];
  const meta = await ctx.app.metadata.getMany(mints);
  await render(ctx, storedActivityView(w, rows.slice(0, size), page, rows.length > size, new Map(mints.map((m) => [m, symbolOf(meta, m)]))));
}

export async function showTokenWatchlist(ctx: BotContext, page: number): Promise<void> {
  const prefs = await ctx.getPrefs();
  await withLoading(ctx, 'Loading watchlist…', async () => {
    const rows = await ctx.app.wallets.listWatchlist(ctx.dbUser.id);
    const quotes = new Map<string, PriceQuote & { change24h?: number | null }>();
    if (rows.length) {
      const pairs = await ctx.app.dex.getPairsForTokens(rows.map((r) => r.mint)).catch(() => []);
      for (const [mint, q] of selectQuotes(rows.map((r) => r.mint), pairs)) {
        const best = pairs.filter((p) => p.baseToken.address === mint).sort((a, b) => liquidityOf(b) - liquidityOf(a))[0];
        quotes.set(mint, { ...q, change24h: best?.priceChange?.h24 ?? null });
      }
    }
    return tokenWatchlistView(rows, quotes, page, prefs.page_size);
  });
}

export async function promptAddToken(ctx: BotContext): Promise<void> {
  setAwaiting(ctx, 'watch_token');
  await render(ctx, promptView('➕ Send the token mint address to add to your watchlist.', 'wls:t:0'));
}

export async function removeToken(ctx: BotContext, id: string): Promise<void> {
  const ok = await ctx.app.wallets.removeFromWatchlist(ctx.dbUser.id, id);
  await toast(ctx, ok ? 'Removed' : 'Already removed');
  await showTokenWatchlist(ctx, 0);
}

// ---------- Portfolio ----------

export async function showPortfolioMenu(ctx: BotContext): Promise<void> {
  await render(ctx, portfolioMenuView(await ctx.app.wallets.list(ctx.dbUser.id)));
}

async function valueBalances(ctx: BotContext, sol: number, tokens: RawBalance[]) {
  const mints = [...tokens].sort((a, b) => b.amount - a.amount).slice(0, 150).map((t) => t.mint);
  const quotes = await ctx.app.prices.getQuotes([WSOL_MINT, ...mints]);
  const holdings = priceHoldings(tokens, quotes);
  return { quotes, holdings, summary: summarize(sol, quotes.get(WSOL_MINT)?.priceUsd ?? null, holdings) };
}

export async function showPortfolio(ctx: BotContext, id: string): Promise<void> {
  const w = await requireWallet(ctx, id);
  await withLoading(ctx, 'Valuing portfolio…', async () => {
    const b = await ctx.app.walletIntel.getBalances(w.address);
    const { holdings, summary } = await valueBalances(ctx, b.sol, b.tokens);
    void ctx.app.snapshots.ensureRecent(w.address).catch(() => undefined);
    return portfolioView(w.label, 'pf', summary, holdings, w.id);
  });
}

export async function showCombinedPortfolio(ctx: BotContext): Promise<void> {
  await withLoading(ctx, 'Valuing all tracked wallets…', async () => {
    const wallets = (await ctx.app.wallets.list(ctx.dbUser.id)).slice(0, 10);
    const results = await mapLimit(wallets, 2, (w) => ctx.app.walletIntel.getBalances(w.address));
    let sol = 0;
    const merged = new Map<string, RawBalance>();
    let failed = 0;
    for (const r of results) {
      if (!r.ok) {
        failed++;
        continue;
      }
      sol += r.value.sol;
      for (const t of r.value.tokens) {
        const cur = merged.get(t.mint);
        if (cur) cur.amount += t.amount;
        else merged.set(t.mint, { ...t });
      }
    }
    const { holdings, summary } = await valueBalances(ctx, sol, [...merged.values()]);
    const view = portfolioView(combinedTitle(wallets), 'pf', summary, holdings, null);
    if (failed) view.text += `\n⚠️ ${failed} wallet(s) could not be loaded and are excluded.`;
    return view;
  });
}

export async function showPortfolioHistory(ctx: BotContext, id: string): Promise<void> {
  const w = await requireWallet(ctx, id);
  const now = Date.now();
  const [snaps, d1, d7] = await Promise.all([
    ctx.app.wallets.snapshots(w.address, 30),
    ctx.app.wallets.snapshotAtOrBefore(w.address, new Date(now - 24 * 3600_000).toISOString()),
    ctx.app.wallets.snapshotAtOrBefore(w.address, new Date(now - 7 * 24 * 3600_000).toISOString()),
  ]);
  await render(ctx, portfolioHistoryView(w, snaps, d1, d7));
}

export async function snapshotNow(ctx: BotContext, id: string): Promise<void> {
  const w = await requireWallet(ctx, id);
  await withLoading(ctx, 'Capturing snapshot…', async () => {
    await ctx.app.snapshots.capture(w.address);
    const now = Date.now();
    const [snaps, d1, d7] = await Promise.all([
      ctx.app.wallets.snapshots(w.address, 30),
      ctx.app.wallets.snapshotAtOrBefore(w.address, new Date(now - 24 * 3600_000).toISOString()),
      ctx.app.wallets.snapshotAtOrBefore(w.address, new Date(now - 7 * 24 * 3600_000).toISOString()),
    ]);
    return portfolioHistoryView(w, snaps, d1, d7);
  });
}

/** Close price of the last candle at or before `ts` (unix seconds). */
function closeAt(candles: Array<{ t: number; c: number }>, ts: number): number | null {
  let best: number | null = null;
  for (const c of candles) if (c.t <= ts) best = c.c;
  return best;
}

export async function showPriceExposure(ctx: BotContext, id: string): Promise<void> {
  const w = await requireWallet(ctx, id);
  await withLoading(ctx, 'Loading historical prices…', async () => {
    const b = await ctx.app.walletIntel.getBalances(w.address);
    const { quotes, holdings } = await valueBalances(ctx, b.sol, b.tokens);
    const solQuote = quotes.get(WSOL_MINT);
    const assets: Array<{ symbol: string; amount: number; quote: PriceQuote }> = [];
    if (solQuote && b.sol > 0) assets.push({ symbol: 'SOL', amount: b.sol, quote: solQuote });
    for (const h of holdings.filter((x: Holding) => x.valueUsd !== null).slice(0, 5)) {
      const q = quotes.get(h.mint);
      if (q) assets.push({ symbol: h.symbol, amount: h.amount, quote: q });
    }
    const nowSec = Date.now() / 1000;
    const rows: ExposureRow[] = [];
    for (const a of assets) {
      const candles = await ctx.app.tokenIntel.getCandles(a.quote.pairAddress).catch(() => []);
      // Quote-side pools report the base token's price; only use candles when the asset is the base token.
      const usable = a.quote.side === 'base' ? candles : [];
      rows.push({
        symbol: a.symbol,
        amount: a.amount,
        priceNow: a.quote.priceUsd,
        price7d: closeAt(usable, nowSec - 7 * 86400),
        price30d: closeAt(usable, nowSec - 30 * 86400),
      });
    }
    return priceExposureView(w, rows);
  });
}
