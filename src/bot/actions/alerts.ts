import { InlineKeyboard } from 'grammy';
import { alertParamSchemas, DEFAULT_COOLDOWN, describeAlert, EDITABLE_FIELD } from '../../alerts/definitions.js';
import type { AlertKind, AlertRow } from '../../db/types.js';
import { UserInputError } from '../../utils/errors.js';
import { escapeHtml, shortAddr } from '../../utils/format.js';
import { isValidSolanaAddress } from '../../validation/address.js';
import { parseAmount, parseBounded, parsePriceMove, parsePriceTarget, parseWalletActivityParams, splitFirstToken } from '../../validation/inputs.js';
import { setAwaiting, type BotContext } from '../context.js';
import { withNav } from '../keyboards.js';
import { render, toast } from '../render.js';
import {
  alertDetailView,
  alertHistoryView,
  alertListView,
  alertsMenuView,
  CODE_KIND,
  cooldownView,
  COOLDOWN_OPTIONS,
  newAlertMenuView,
  PARAM_PROMPTS,
} from '../views/alerts.js';
import { promptView } from '../views/menu.js';
import { z } from 'zod';

async function requireAlert(ctx: BotContext, id: string): Promise<AlertRow> {
  const a = await ctx.app.alerts.get(ctx.dbUser.id, id);
  if (!a) throw new UserInputError('That alert no longer exists.');
  return a;
}

export async function showAlertsMenu(ctx: BotContext): Promise<void> {
  await render(ctx, alertsMenuView(await ctx.app.alerts.list(ctx.dbUser.id), ctx.app.config.MAX_ALERTS_PER_USER));
}

export async function showAlertList(ctx: BotContext, page: number): Promise<void> {
  const [alerts, prefs] = await Promise.all([ctx.app.alerts.list(ctx.dbUser.id), ctx.getPrefs()]);
  await render(ctx, alertListView(alerts, page, prefs.page_size));
}

export async function showAlert(ctx: BotContext, id: string): Promise<void> {
  await render(ctx, alertDetailView(await requireAlert(ctx, id)));
}

export async function toggleAlert(ctx: BotContext, id: string): Promise<void> {
  const a = await requireAlert(ctx, id);
  // Reset baselines on re-activation so stale state cannot fire instantly.
  const updated = await ctx.app.alerts.update(ctx.dbUser.id, id, { is_active: !a.is_active, state: a.is_active ? a.state : {} });
  await toast(ctx, updated?.is_active ? 'Alert activated' : 'Alert paused');
  await render(ctx, alertDetailView(updated ?? a));
}

export async function confirmDeleteAlert(ctx: BotContext, id: string): Promise<void> {
  const a = await requireAlert(ctx, id);
  await render(ctx, {
    text: `Delete this alert?\n${escapeHtml(describeAlert(a))}`,
    keyboard: new InlineKeyboard().text('🗑 Yes, delete', `al:dely:${id}`).text('Cancel', `al:v:${id}`),
  });
}

export async function deleteAlert(ctx: BotContext, id: string): Promise<void> {
  const ok = await ctx.app.alerts.delete(ctx.dbUser.id, id);
  await toast(ctx, ok ? 'Alert deleted' : 'Already deleted');
  await showAlertList(ctx, 0);
}

export async function promptEditAlert(ctx: BotContext, id: string): Promise<void> {
  const a = await requireAlert(ctx, id);
  const field = EDITABLE_FIELD[a.kind];
  setAwaiting(ctx, 'alert_edit', { id });
  await render(ctx, promptView(`✏️ ${escapeHtml(describeAlert(a))}\n\n${field.prompt}`, `al:v:${id}`));
}

export async function applyAlertEdit(ctx: BotContext, id: string, raw: string): Promise<void> {
  const a = await requireAlert(ctx, id);
  const field = EDITABLE_FIELD[a.kind];
  let params: Record<string, unknown>;
  if (a.kind === 'price_target') {
    // Accept either a bare price or "above/below <price>".
    const t = /^(above|below|>|<)/i.test(raw.trim()) ? parsePriceTarget(raw) : { condition: a.params.condition, price: parseBounded(raw, field.schema, 'Price') };
    params = { ...a.params, ...t };
  } else if (a.kind === 'price_move' && /[a-z]/i.test(raw)) {
    params = { ...a.params, ...parsePriceMove(raw) };
  } else if (a.kind === 'wallet_activity' && /[a-z]/i.test(raw)) {
    params = { ...a.params, ...parseWalletActivityParams(raw) };
  } else {
    params = { ...a.params, [field.key]: parseBounded(raw, field.schema, 'Value') };
  }
  const validated = alertParamSchemas[a.kind].safeParse(params);
  if (!validated.success) throw new UserInputError(validated.error.issues[0]?.message ?? 'Invalid value.');
  const updated = await ctx.app.alerts.update(ctx.dbUser.id, id, { params: validated.data as Record<string, unknown>, state: {} });
  await render(ctx, alertDetailView(updated ?? a));
}

export async function showCooldown(ctx: BotContext, id: string): Promise<void> {
  await render(ctx, cooldownView(await requireAlert(ctx, id)));
}

export async function setCooldown(ctx: BotContext, id: string, minutes: number): Promise<void> {
  if (!COOLDOWN_OPTIONS.includes(minutes)) throw new UserInputError('Invalid cooldown.');
  const updated = await ctx.app.alerts.update(ctx.dbUser.id, id, { cooldown_minutes: minutes });
  if (!updated) throw new UserInputError('That alert no longer exists.');
  await render(ctx, alertDetailView(updated));
}

export async function showNewAlertMenu(ctx: BotContext): Promise<void> {
  await render(ctx, newAlertMenuView());
}

/** Entry point for "new alert of kind X" (optionally pre-filled with a token mint). */
export async function startNewAlert(ctx: BotContext, code: string, mint?: string): Promise<void> {
  const kind = CODE_KIND[code];
  if (!kind) throw new UserInputError('Unknown alert type.');
  await ensureAlertCapacity(ctx);
  if (kind === 'wallet_activity') {
    const wallets = await ctx.app.wallets.list(ctx.dbUser.id);
    if (wallets.length === 0) throw new UserInputError('Track a wallet first (⭐ Watchlists → Tracked wallets).');
    const kb = new InlineKeyboard();
    wallets.slice(0, 20).forEach((w, i) => {
      kb.text(w.label.slice(0, 18), `al:nw:${w.id}`);
      if (i % 2 === 1) kb.row();
    });
    await render(ctx, { text: '👛 Choose the tracked wallet for this alert:', keyboard: withNav(kb, 'al:new') });
    return;
  }
  if (kind === 'large_transaction' && !mint) {
    await render(ctx, {
      text: '🐋 Watch large transactions for a token or a wallet?',
      keyboard: withNav(new InlineKeyboard().text('🪙 Token', 'txm:wadd:t').text('👛 Wallet', 'txm:wadd:w'), 'al:new'),
    });
    return;
  }
  if (mint) {
    if (!isValidSolanaAddress(mint)) throw new UserInputError('Invalid token address.');
    if (kind === 'large_transaction') {
      const prefs = await ctx.getPrefs();
      setAwaiting(ctx, 'alert_param', { kind, mint });
      await render(ctx, promptView(`${PARAM_PROMPTS[kind]}\nDefault: ${prefs.whale_threshold_usd} — send <code>default</code> to use it.`, `tok:p:${mint}`));
      return;
    }
    setAwaiting(ctx, 'alert_param', { kind, mint });
    await render(ctx, promptView(`🔔 ${shortAddr(mint)}\n\n${PARAM_PROMPTS[kind]}`, `tok:p:${mint}`));
    return;
  }
  setAwaiting(ctx, 'alert_param', { kind, stage: 'mint' });
  await render(ctx, promptView('🪙 Send the token mint address for this alert.', 'al:new'));
}

export async function startWalletAlert(ctx: BotContext, walletId: string): Promise<void> {
  await ensureAlertCapacity(ctx);
  const w = await ctx.app.wallets.get(ctx.dbUser.id, walletId);
  if (!w) throw new UserInputError('That tracked wallet no longer exists.');
  setAwaiting(ctx, 'alert_param', { kind: 'wallet_activity', walletId });
  await render(ctx, promptView(`👛 <b>${escapeHtml(w.label)}</b>\n\n${PARAM_PROMPTS.wallet_activity}`, `wls:wv:${walletId}`));
}

async function ensureAlertCapacity(ctx: BotContext): Promise<void> {
  const max = ctx.app.config.MAX_ALERTS_PER_USER;
  if ((await ctx.app.alerts.count(ctx.dbUser.id)) >= max) throw new UserInputError(`You can have up to ${max} alerts. Delete one first.`);
}

/** Handles the text reply in the alert creation flow. */
export async function handleAlertParamInput(ctx: BotContext, data: Record<string, string>, raw: string): Promise<'done' | 'continue'> {
  const kind = data.kind as AlertKind;
  if (data.stage === 'mint') {
    const mint = raw.trim();
    if (!isValidSolanaAddress(mint)) throw new UserInputError('That is not a valid token mint address.');
    const info = await ctx.app.rpc.getMintInfo(mint);
    if (!info) throw new UserInputError('That address is not a token mint. Please send a token mint address.');
    setAwaiting(ctx, 'alert_param', { kind, mint });
    await render(ctx, promptView(`🔔 ${shortAddr(mint)}\n\n${PARAM_PROMPTS[kind]}`, 'al:new'));
    return 'continue';
  }

  let params: Record<string, unknown>;
  let symbol = '';
  if (data.mint) symbol = (await ctx.app.metadata.get(data.mint).catch(() => null))?.symbol?.slice(0, 32) ?? '';
  switch (kind) {
    case 'wallet_activity': {
      const w = await ctx.app.wallets.get(ctx.dbUser.id, data.walletId ?? '');
      if (!w) throw new UserInputError('That tracked wallet no longer exists.');
      params = { walletId: w.id, address: w.address, label: w.label, ...parseWalletActivityParams(raw) };
      break;
    }
    case 'large_transaction': {
      const prefs = await ctx.getPrefs();
      const minUsd = raw.trim().toLowerCase() === 'default' ? prefs.whale_threshold_usd : parseBounded(raw, z.number().min(100).max(1e9), 'Minimum USD');
      params = { target: data.target === 'wallet' ? 'wallet' : 'token', address: data.mint ?? data.address, symbol, minUsd };
      break;
    }
    case 'price_move':
      params = { mint: data.mint, symbol, ...parsePriceMove(raw) };
      break;
    case 'price_target':
      params = { mint: data.mint, symbol, ...parsePriceTarget(raw) };
      break;
    case 'volume_spike':
    case 'token_activity':
      params = { mint: data.mint, symbol, multiplier: parseBounded(raw, z.number().min(1.5).max(100), 'Multiplier') };
      break;
    case 'liquidity_change':
      params = { mint: data.mint, symbol, percent: parseBounded(raw.replace('%', ''), z.number().min(1).max(1000), 'Percentage') };
      break;
    default:
      throw new UserInputError('Unknown alert type.');
  }
  await createAlert(ctx, kind, params);
  return 'done';
}

export async function createAlert(ctx: BotContext, kind: AlertKind, params: Record<string, unknown>): Promise<void> {
  const validated = alertParamSchemas[kind].safeParse(params);
  if (!validated.success) throw new UserInputError(validated.error.issues[0]?.message ?? 'Invalid alert parameters.');
  await ensureAlertCapacity(ctx);
  const alert = await ctx.app.alerts.create(ctx.dbUser.id, kind, validated.data as Record<string, unknown>, DEFAULT_COOLDOWN[kind]);
  await render(ctx, {
    text: `✅ Alert created\n${escapeHtml(describeAlert(alert))}\n\nCooldown: ${alert.cooldown_minutes} min. You can pause, edit or delete it any time.`,
    keyboard: withNav(new InlineKeyboard().text('⚙️ Manage', `al:v:${alert.id}`).text('📋 My alerts', 'al:list:0'), 'al'),
  });
}

/** "<address> [minUsd]" for whale watches. */
export async function handleWhaleTargetInput(ctx: BotContext, target: 'token' | 'wallet', raw: string): Promise<void> {
  const [address, rest] = splitFirstToken(raw);
  if (!isValidSolanaAddress(address)) throw new UserInputError('That is not a valid Solana address.');
  const prefs = await ctx.getPrefs();
  const minUsd = rest ? parseAmount(rest) : prefs.whale_threshold_usd;
  let symbol = '';
  if (target === 'token') {
    const info = await ctx.app.rpc.getMintInfo(address);
    if (!info) throw new UserInputError('That address is not a token mint.');
    symbol = (await ctx.app.metadata.get(address).catch(() => null))?.symbol?.slice(0, 32) ?? '';
  } else {
    const tracked = await ctx.app.wallets.findByAddress(ctx.dbUser.id, address);
    symbol = tracked?.label.slice(0, 32) ?? '';
  }
  await createAlert(ctx, 'large_transaction', { target, address, symbol, minUsd });
}

export async function showAlertHistory(ctx: BotContext, page: number): Promise<void> {
  const prefs = await ctx.getPrefs();
  const size = prefs.page_size * 2;
  const { rows, total } = await ctx.app.alerts.history(ctx.dbUser.id, size, page * size);
  await render(ctx, alertHistoryView(rows, total, page, size));
}
