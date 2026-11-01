import { z } from 'zod';
import type { PreferencesPatch } from '../../db/usersRepo.js';
import { UserInputError } from '../../utils/errors.js';
import { parseBounded, parseQuietHours } from '../../validation/inputs.js';
import { setAwaiting, type BotContext } from '../context.js';
import { render, toast } from '../render.js';
import { promptView } from '../views/menu.js';
import { pageSizeView, settingsView } from '../views/settings.js';

export const TOGGLE_FIELDS = ['notifications_enabled', 'notify_wallet_activity', 'notify_holdings_changes'] as const;
export type ToggleField = (typeof TOGGLE_FIELDS)[number];

export const NUMBER_FIELDS = {
  min_notify_sol: { prompt: 'Send the minimum SOL amount for tracked-wallet notifications (0 = all activity):', schema: z.number().min(0).max(1_000_000), what: 'Minimum SOL' },
  holding_change_pct: { prompt: 'Send the holding change percentage that triggers a notification (1–1000):', schema: z.number().min(1).max(1000), what: 'Percentage' },
  whale_threshold_usd: { prompt: 'Send the default whale threshold in USD (e.g. 50k):', schema: z.number().min(100).max(1_000_000_000), what: 'Threshold' },
} as const;
export type NumberField = keyof typeof NUMBER_FIELDS;

export async function showSettings(ctx: BotContext): Promise<void> {
  await render(ctx, settingsView(await ctx.getPrefs()));
}

export async function toggleSetting(ctx: BotContext, field: string): Promise<void> {
  if (!(TOGGLE_FIELDS as readonly string[]).includes(field)) throw new UserInputError('Unknown setting.');
  const prefs = await ctx.getPrefs();
  const f = field as ToggleField;
  const updated = await ctx.app.users.updatePreferences(ctx.dbUser.id, { [f]: !prefs[f] } as PreferencesPatch);
  await toast(ctx, 'Saved');
  await render(ctx, settingsView(updated));
}

export async function promptNumberSetting(ctx: BotContext, field: string): Promise<void> {
  if (!(field in NUMBER_FIELDS)) throw new UserInputError('Unknown setting.');
  setAwaiting(ctx, 'pref_number', { field });
  await render(ctx, promptView(NUMBER_FIELDS[field as NumberField].prompt, 'set'));
}

export async function applyNumberSetting(ctx: BotContext, field: string, raw: string): Promise<void> {
  const def = NUMBER_FIELDS[field as NumberField];
  if (!def) throw new UserInputError('Unknown setting.');
  const value = parseBounded(raw, def.schema, def.what);
  const updated = await ctx.app.users.updatePreferences(ctx.dbUser.id, { [field]: value } as PreferencesPatch);
  await render(ctx, settingsView(updated));
}

export async function promptQuietHours(ctx: BotContext): Promise<void> {
  setAwaiting(ctx, 'quiet_hours');
  await render(ctx, promptView('🌙 Send quiet hours in UTC as <code>start-end</code> (e.g. <code>22-7</code>), or <code>off</code>. Notifications during quiet hours are recorded in Alert History but not pushed.', 'set'));
}

export async function applyQuietHours(ctx: BotContext, raw: string): Promise<void> {
  const q = parseQuietHours(raw);
  const updated = await ctx.app.users.updatePreferences(ctx.dbUser.id, { quiet_hours_start: q?.start ?? null, quiet_hours_end: q?.end ?? null });
  await render(ctx, settingsView(updated));
}

export async function showPageSize(ctx: BotContext): Promise<void> {
  await render(ctx, pageSizeView((await ctx.getPrefs()).page_size));
}

export async function setPageSize(ctx: BotContext, n: number): Promise<void> {
  if (![3, 5, 8, 10, 15].includes(n)) throw new UserInputError('Invalid page size.');
  const updated = await ctx.app.users.updatePreferences(ctx.dbUser.id, { page_size: n });
  await render(ctx, settingsView(updated));
}
