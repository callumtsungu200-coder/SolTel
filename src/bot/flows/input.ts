import { UserInputError } from '../../utils/errors.js';
import { extractAddress, extractSignature, isValidSolanaAddress } from '../../validation/address.js';
import { splitFirstToken } from '../../validation/inputs.js';
import { containsSecret } from '../../validation/secrets.js';
import * as alerts from '../actions/alerts.js';
import * as market from '../actions/market.js';
import * as settings from '../actions/settings.js';
import * as token from '../actions/token.js';
import * as wallet from '../actions/wallet.js';
import * as lists from '../actions/watchlists.js';
import { clearAwaiting, type BotContext } from '../context.js';
import { render } from '../render.js';
import { mainMenuView } from '../views/menu.js';

/**
 * Runs before commands and text handlers: if a message contains a private
 * key or seed phrase, it is deleted and never processed or forwarded to any
 * API. Nothing is logged or stored.
 */
export async function secretGuard(ctx: BotContext, next: () => Promise<void>): Promise<void> {
  const text = ctx.message?.text ?? ctx.message?.caption ?? '';
  if (text && containsSecret(text)) {
    clearAwaiting(ctx);
    await ctx.deleteMessage().catch(() => undefined);
    await ctx.reply(
      '🛑 That looked like a private key or seed phrase, so I deleted it and did not process or store it.\n\n<b>Never share it with anyone, including bots.</b> If it belongs to a real wallet, move your funds to a new wallet now.',
      { parse_mode: 'HTML' },
    );
    return;
  }
  await next();
}

/**
 * Handles free-text messages: first any pending prompt (session.awaiting),
 * otherwise auto-detects a pasted signature or address.
 */
export async function handleText(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text?.trim() ?? '';
  if (!text) return;

  const awaiting = ctx.session.awaiting;
  if (awaiting && awaiting.expiresAt < Date.now()) clearAwaiting(ctx);

  if (ctx.session.awaiting) {
    const { kind, data } = ctx.session.awaiting;
    // Clear first: a failed input leaves the user free to retry from the menu.
    clearAwaiting(ctx);
    try {
      await handleAwaited(ctx, kind, data, text);
    } catch (err) {
      if (err instanceof UserInputError) {
        // Keep waiting for a corrected answer.
        ctx.session.awaiting = { kind, data, expiresAt: Date.now() + 10 * 60_000 };
        await ctx.reply(`⚠️ ${err.message}\nPlease try again, or send /cancel.`);
        return;
      }
      throw err;
    }
    return;
  }

  const sig = extractSignature(text);
  if (sig) return market.showTransaction(ctx, sig);
  const addr = extractAddress(text);
  if (addr) return token.openAddress(ctx, addr);
  await render(ctx, mainMenuView(ctx.from?.first_name));
}

async function handleAwaited(ctx: BotContext, kind: string, data: Record<string, string>, text: string): Promise<void> {
  const addrOrThrow = () => {
    const a = extractAddress(text);
    if (!a) throw new UserInputError('That is not a valid Solana address.');
    return a;
  };
  switch (kind) {
    case 'wallet_lookup':
      return wallet.showWalletProfile(ctx, addrOrThrow());
    case 'token_lookup':
      return token.showTokenReport(ctx, addrOrThrow());
    case 'tx_lookup': {
      const sig = extractSignature(text);
      if (!sig) throw new UserInputError('That is not a valid transaction signature.');
      return market.showTransaction(ctx, sig);
    }
    case 'track_wallet': {
      const [address, label] = splitFirstToken(text);
      if (!isValidSolanaAddress(address)) throw new UserInputError('That is not a valid Solana address.');
      if (label) return wallet.trackWallet(ctx, address, label);
      return wallet.startTrackWallet(ctx, address);
    }
    case 'track_label':
      return wallet.trackWallet(ctx, data.address ?? '', text);
    case 'rename_wallet':
      return lists.renameWallet(ctx, data.id ?? '', text);
    case 'watch_token': {
      const mint = addrOrThrow();
      if (!(await ctx.app.rpc.getMintInfo(mint))) throw new UserInputError('That address is not a token mint.');
      return token.watchToken(ctx, mint);
    }
    case 'alert_param': {
      await alerts.handleAlertParamInput(ctx, data, text);
      return;
    }
    case 'alert_edit':
      return alerts.applyAlertEdit(ctx, data.id ?? '', text);
    case 'whale_token':
      return alerts.handleWhaleTargetInput(ctx, 'token', text);
    case 'whale_wallet':
      return alerts.handleWhaleTargetInput(ctx, 'wallet', text);
    case 'pref_number':
      return settings.applyNumberSetting(ctx, data.field ?? '', text);
    case 'quiet_hours':
      return settings.applyQuietHours(ctx, text);
    case 'interaction_lookup': {
      const other = addrOrThrow();
      if (data.mode === 'whale') return market.showWhales(ctx, 0, null, other);
      return wallet.showInteraction(ctx, data.address ?? '', other);
    }
    default:
      throw new UserInputError('This prompt has expired.');
  }
}
