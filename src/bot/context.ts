import type { Context, SessionFlavor } from 'grammy';
import type { PreferencesRow, UserRow } from '../db/types.js';
import type { AppServices } from '../services/container.js';

/** Kinds of free-text input the bot can be waiting for. */
export type AwaitKind =
  | 'wallet_lookup'
  | 'token_lookup'
  | 'tx_lookup'
  | 'track_wallet'
  | 'track_label'
  | 'rename_wallet'
  | 'watch_token'
  | 'alert_param'
  | 'alert_edit'
  | 'whale_wallet'
  | 'whale_token'
  | 'pref_number'
  | 'quiet_hours'
  | 'interaction_lookup';

export interface Awaiting {
  kind: AwaitKind;
  data: Record<string, string>;
  expiresAt: number;
}

export interface SessionData {
  awaiting?: Awaiting;
}

export interface BotContextExtras {
  app: AppServices;
  dbUser: UserRow;
  /** Lazily loaded and cached for the duration of the update. */
  getPrefs: () => Promise<PreferencesRow>;
}

export type BotContext = Context & SessionFlavor<SessionData> & BotContextExtras;

export const AWAIT_TTL_MS = 10 * 60_000;

export function setAwaiting(ctx: BotContext, kind: AwaitKind, data: Record<string, string> = {}): void {
  ctx.session.awaiting = { kind, data, expiresAt: Date.now() + AWAIT_TTL_MS };
}

export function clearAwaiting(ctx: BotContext): void {
  delete ctx.session.awaiting;
}
