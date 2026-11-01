import type { TrendingSort } from '../../analytics/trending.js';
import { normalizeParsedEvent, normalizeRpcTx, type NormalizedTx, type WalletTxView } from '../../services/transactions.js';
import { symbolOf } from '../../services/tokenMetadata.js';
import { mapLimit } from '../../jobs/scheduler.js';
import { UserInputError } from '../../utils/errors.js';
import { shortAddr } from '../../utils/format.js';
import { isValidSignature, isValidSolanaAddress } from '../../validation/address.js';
import { setAwaiting, type BotContext } from '../context.js';
import { render, withLoading } from '../render.js';
import { promptView } from '../views/menu.js';
import { SORT_LABELS, trendingFiltersView, trendingView } from '../views/trending.js';
import { feedView, txDetailView, txMonitorMenuView, whaleAddView, whaleEventsView, type WhaleTargetInfo } from '../views/transactions.js';
import { parseAlertParams } from '../../alerts/definitions.js';

const SORTS = Object.keys(SORT_LABELS) as TrendingSort[];

export function parseSort(s: string | undefined): TrendingSort {
  return SORTS.includes(s as TrendingSort) ? (s as TrendingSort) : 'volume';
}

// ---------- Trending ----------

export async function showTrending(ctx: BotContext, sort: TrendingSort, page: number): Promise<void> {
  const prefs = await ctx.getPrefs();
  if (prefs.trending_sort !== sort) void ctx.app.users.updatePreferences(ctx.dbUser.id, { trending_sort: sort }).catch(() => undefined);
  await withLoading(ctx, 'Scanning DexScreener…', async () => {
    const tokens = await ctx.app.trending.explore({ sort, minLiquidityUsd: prefs.trending_min_liquidity, minVolumeUsd: prefs.trending_min_volume });
    return trendingView(tokens, sort, page, prefs.page_size, prefs.trending_min_liquidity, prefs.trending_min_volume);
  });
}

export async function showTrendingFilters(ctx: BotContext): Promise<void> {
  const p = await ctx.getPrefs();
  await render(ctx, trendingFiltersView(p.trending_min_liquidity, p.trending_min_volume, p.trending_sort));
}

export async function setTrendingFilter(ctx: BotContext, field: 'liq' | 'vol', value: number): Promise<void> {
  if (!Number.isFinite(value) || value < 0 || value > 1e10) throw new UserInputError('Invalid filter value.');
  const p = await ctx.app.users.updatePreferences(ctx.dbUser.id, field === 'liq' ? { trending_min_liquidity: value } : { trending_min_volume: value });
  await render(ctx, trendingFiltersView(p.trending_min_liquidity, p.trending_min_volume, p.trending_sort));
}

// ---------- Transactions ----------

export async function showTxMenu(ctx: BotContext): Promise<void> {
  await render(ctx, txMonitorMenuView(ctx.app.config.useWebhooks));
}

export async function promptTxLookup(ctx: BotContext): Promise<void> {
  setAwaiting(ctx, 'tx_lookup');
  await render(ctx, promptView('🔎 Send a transaction signature (or a Solscan transaction link).', 'txm'));
}

export async function fetchTransaction(ctx: BotContext, signature: string): Promise<NormalizedTx | null> {
  try {
    const parsed = await ctx.app.helius.parseTransactions([signature]);
    if (parsed[0]) return normalizeParsedEvent(parsed[0]);
  } catch {
    /* fall back to raw RPC below */
  }
  const raw = await ctx.app.rpc.getTransaction(signature);
  return raw ? normalizeRpcTx(signature, raw) : null;
}

export async function showTransaction(ctx: BotContext, signature: string): Promise<void> {
  if (!isValidSignature(signature)) throw new UserInputError('That is not a valid transaction signature.');
  await withLoading(ctx, 'Fetching transaction…', async () => {
    const tx = await fetchTransaction(ctx, signature);
    if (!tx) throw new UserInputError('Transaction not found. It may be too recent, failed to land, or the signature is wrong.');
    const mints = [...new Set([...tx.tokenTransfers.map((t) => t.mint), ...(tx.tokenChanges ?? []).map((c) => c.mint)])];
    const meta = await ctx.app.metadata.getMany(mints);
    return txDetailView(tx, (m) => symbolOf(meta, m));
  });
}

export async function showFeed(ctx: BotContext, page: number): Promise<void> {
  const prefs = await ctx.getPrefs();
  await withLoading(ctx, 'Loading activity feed…', async () => {
    const wallets = (await ctx.app.wallets.list(ctx.dbUser.id)).slice(0, 10);
    const results = await mapLimit(wallets, 3, async (w) => ({ w, views: await ctx.app.walletIntel.getRecentActivity(w.address, 25) }));
    const items: Array<{ view: WalletTxView; label: string }> = [];
    for (const r of results) if (r.ok) for (const v of r.value.views) items.push({ view: v, label: r.value.w.label });
    items.sort((a, b) => (b.view.tx.timestamp ?? 0) - (a.view.tx.timestamp ?? 0));
    const mints = [...new Set(items.flatMap((i) => [...i.view.tokensIn, ...i.view.tokensOut].map((t) => t.mint)))].slice(0, 200);
    const meta = await ctx.app.metadata.getMany(mints);
    return feedView(items, page, prefs.page_size, (m) => symbolOf(meta, m), wallets.length);
  });
}

async function whaleTargets(ctx: BotContext): Promise<WhaleTargetInfo[]> {
  const alerts = (await ctx.app.alerts.list(ctx.dbUser.id)).filter((a) => a.kind === 'large_transaction');
  const out = new Map<string, WhaleTargetInfo>();
  for (const a of alerts) {
    const p = parseAlertParams('large_transaction', a.params);
    if (p) out.set(p.address, { address: p.address, kind: p.target, label: p.symbol || shortAddr(p.address) });
  }
  return [...out.values()];
}

export async function showWhales(ctx: BotContext, page: number, filter: string | null, participant: string | null = null): Promise<void> {
  if (filter && !isValidSolanaAddress(filter)) throw new UserInputError('Invalid filter address.');
  if (participant && !isValidSolanaAddress(participant)) throw new UserInputError('Invalid address.');
  const prefs = await ctx.getPrefs();
  await withLoading(ctx, 'Loading whale activity…', async () => {
    const targets = await whaleTargets(ctx);
    const size = prefs.page_size * 2;
    if (filter && !targets.some((t) => t.address === filter)) throw new UserInputError('You are not watching that target.');
    const events =
      targets.length === 0
        ? []
        : await ctx.app.market.whaleEvents({
            watchedIn: filter ? [filter] : targets.map((t) => t.address),
            address: participant ?? undefined,
            limit: size + 1,
            offset: page * size,
          });
    const mints = [...new Set(events.map((e) => e.mint).filter((m): m is string => !!m))];
    const meta = await ctx.app.metadata.getMany(mints);
    const symbols = new Map(mints.map((m) => [m, symbolOf(meta, m)]));
    return whaleEventsView(events.slice(0, size), page, events.length > size, targets, filter, symbols);
  });
}

export async function showWhaleAdd(ctx: BotContext): Promise<void> {
  const prefs = await ctx.getPrefs();
  await render(ctx, whaleAddView(prefs.whale_threshold_usd));
}

export async function promptWhaleTarget(ctx: BotContext, kind: 'token' | 'wallet'): Promise<void> {
  const prefs = await ctx.getPrefs();
  setAwaiting(ctx, kind === 'token' ? 'whale_token' : 'whale_wallet');
  await render(
    ctx,
    promptView(
      `${kind === 'token' ? '🪙 Send the token mint address' : '👛 Send the wallet address'}, optionally followed by a USD threshold.\nExample: <code>&lt;address&gt; 100k</code> (default ${prefs.whale_threshold_usd.toLocaleString('en-US')} USD).`,
      'txm:wadd',
    ),
  );
}

export async function promptWhaleParticipant(ctx: BotContext): Promise<void> {
  setAwaiting(ctx, 'interaction_lookup', { mode: 'whale' });
  await render(ctx, promptView('🔎 Send a wallet address to show only whale events where it was the sender or receiver.', 'txm:wh:0'));
}
