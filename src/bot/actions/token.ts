import { InlineKeyboard } from 'grammy';
import { isUniqueViolation } from '../../db/client.js';
import { UserInputError } from '../../utils/errors.js';
import { code, escapeHtml, shortAddr } from '../../utils/format.js';
import { createLogger } from '../../utils/logger.js';
import { setAwaiting, type BotContext } from '../context.js';
import { withNav } from '../keyboards.js';
import { render, withLoading } from '../render.js';
import { tokenAlertMenuView } from '../views/alerts.js';
import { concentrationView, tokenHistoryView, tokenPairsView, tokenReportView } from '../views/token.js';
import { assertAddress, showWalletProfile } from './wallet.js';

const log = createLogger('token-actions');

export async function showTokenMenu(ctx: BotContext): Promise<void> {
  setAwaiting(ctx, 'token_lookup');
  await render(ctx, {
    text:
      '🪙 <b>Token Intelligence</b>\n\nSend a Solana token mint (contract) address to get price, market cap, FDV, liquidity, volume, pairs, on-chain authorities, price history, volatility and holder concentration.',
    keyboard: withNav(new InlineKeyboard().text('⭐ My token watchlist', 'wls:t:0').text('🔥 Trending', 'trd:volume:0')),
  });
}

async function isWatched(ctx: BotContext, mint: string): Promise<boolean> {
  return (await ctx.app.wallets.listWatchlist(ctx.dbUser.id)).some((w) => w.mint === mint);
}

export async function showTokenReport(ctx: BotContext, mint: string): Promise<void> {
  assertAddress(mint);
  await withLoading(ctx, 'Researching token…', async () => {
    const [report, watched] = await Promise.all([ctx.app.tokenIntel.getReport(mint), isWatched(ctx, mint)]);
    if (report.pairCount === 0 && report.decimals.value === null) {
      throw new UserInputError('No token data found for this address. Make sure it is a token mint address, not a wallet.');
    }
    // Cache verified metadata in the tokens table (best effort).
    void ctx.app.market
      .upsertToken({
        mint,
        name: report.name.value,
        symbol: report.symbol.value,
        decimals: report.decimals.value,
        supply: report.supply.value,
        mint_authority: report.mintAuthority.value === 'none' ? null : report.mintAuthority.value,
        freeze_authority: report.freezeAuthority.value === 'none' ? null : report.freezeAuthority.value,
        metadata: { image: report.meta?.image ?? null, tokenProgram: report.tokenProgram.value },
      })
      .catch((err) => log.debug('token cache failed', { error: (err as Error).message }));
    return tokenReportView(report, watched);
  });
}

export async function showTokenSub(ctx: BotContext, mint: string, sub: 'pairs' | 'hist' | 'conc'): Promise<void> {
  assertAddress(mint);
  if (sub === 'conc') {
    await withLoading(ctx, 'Reading largest token accounts…', async () => concentrationView(mint, await ctx.app.tokenIntel.getConcentration(mint)));
    return;
  }
  await withLoading(ctx, 'Loading…', async () => {
    const report = await ctx.app.tokenIntel.getReport(mint);
    return sub === 'pairs' ? tokenPairsView(report) : tokenHistoryView(report);
  });
}

export async function watchToken(ctx: BotContext, mint: string): Promise<void> {
  assertAddress(mint);
  const meta = await ctx.app.metadata.get(mint).catch(() => null);
  try {
    await ctx.app.wallets.addToWatchlist(ctx.dbUser.id, mint, meta?.symbol?.slice(0, 48) ?? null);
  } catch (err) {
    if (isUniqueViolation(err)) throw new UserInputError('This token is already on your watchlist.');
    throw err;
  }
  await render(ctx, {
    text: `⭐ Added <b>${escapeHtml(meta?.symbol ?? shortAddr(mint))}</b> to your watchlist.\n${code(mint)}`,
    keyboard: withNav(new InlineKeyboard().text('🔔 Create alert', `tok:alert:${mint}`).text('⭐ Watchlist', 'wls:t:0'), `tok:p:${mint}`),
  });
}

export async function showTokenAlertMenu(ctx: BotContext, mint: string): Promise<void> {
  assertAddress(mint);
  const meta = await ctx.app.metadata.get(mint).catch(() => null);
  await render(ctx, tokenAlertMenuView(mint, meta?.symbol ?? shortAddr(mint)));
}

/** Decides whether a pasted address is a token mint or a wallet, and opens the right view. */
export async function openAddress(ctx: BotContext, address: string): Promise<void> {
  assertAddress(address);
  const mint = await ctx.app.rpc.getMintInfo(address).catch(() => null);
  if (mint) await showTokenReport(ctx, address);
  else await showWalletProfile(ctx, address);
}
