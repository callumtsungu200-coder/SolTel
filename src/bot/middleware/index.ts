import type { MiddlewareFn, NextFunction } from 'grammy';
import type { PreferencesRow, UserRow } from '../../db/types.js';
import type { AppServices } from '../../services/container.js';
import { TtlCache } from '../../utils/cache.js';
import { createLogger } from '../../utils/logger.js';
import { KeyedRateLimiter } from '../../utils/rateLimiter.js';
import type { BotContext } from '../context.js';

const log = createLogger('bot-mw');

/** Attaches the service container. */
export function servicesMiddleware(app: AppServices): MiddlewareFn<BotContext> {
  return (ctx, next) => {
    ctx.app = app;
    return next();
  };
}

/** The bot handles private data, so it only operates in private chats. */
export const privateOnly: MiddlewareFn<BotContext> = async (ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') {
    if (ctx.message?.text?.startsWith('/')) await ctx.reply('Please message me privately — I only work in private chats to keep your watchlists private.').catch(() => undefined);
    return;
  }
  return next();
};

/** Per-Telegram-user token bucket. Excess updates are answered with a short notice. */
export function rateLimitMiddleware(perMinute: number): MiddlewareFn<BotContext> {
  const limiter = new KeyedRateLimiter(Math.max(3, Math.ceil(perMinute / 3)), perMinute / 60);
  const warned = new TtlCache<boolean>(30_000);
  return async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id) return;
    if (limiter.tryTake(String(id))) return next();
    const secs = Math.ceil(limiter.retryAfterMs(String(id)) / 1000);
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: `Slow down — try again in ${secs}s.` }).catch(() => undefined);
    else if (!warned.get(String(id))) {
      warned.set(String(id), true);
      await ctx.reply(`⏱ You're sending requests too quickly. Please wait ${secs}s.`).catch(() => undefined);
    }
  };
}

/**
 * Identifies the Telegram user (ctx.from.id is authenticated by Telegram's
 * servers) and maps it to the internal user row. Rows are cached briefly to
 * avoid a database write on every button press.
 */
export function userMiddleware(): MiddlewareFn<BotContext> {
  const cache = new TtlCache<UserRow>(5 * 60_000, 10_000);
  return async (ctx: BotContext, next: NextFunction) => {
    const from = ctx.from;
    if (!from || from.is_bot) return;
    const key = String(from.id);
    let user = cache.get(key);
    if (!user || user.is_blocked) {
      user = await ctx.app.users.upsertFromTelegram({
        telegramId: from.id,
        username: from.username,
        firstName: from.first_name,
        languageCode: from.language_code,
      });
      cache.set(key, user);
    }
    ctx.dbUser = user;
    let prefs: Promise<PreferencesRow> | null = null;
    ctx.getPrefs = () => (prefs ??= ctx.app.users.getPreferences(user!.id));
    return next();
  };
}

/** Logs update handling time (without message contents). */
export const timingMiddleware: MiddlewareFn<BotContext> = async (ctx, next) => {
  const started = Date.now();
  await next();
  const ms = Date.now() - started;
  if (ms > 5000) log.info('slow update', { ms, type: ctx.callbackQuery ? 'callback' : ctx.message ? 'message' : 'other' });
};
