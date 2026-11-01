import { autoRetry } from '@grammyjs/auto-retry';
import { sequentialize } from '@grammyjs/runner';
import { Bot, BotError, GrammyError, HttpError, session } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import type { AppServices } from '../services/container.js';
import { UserInputError, userFacingError } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
import { registerCallbacks } from './callbacks/router.js';
import { registerCommands } from './commands/index.js';
import type { BotContext, SessionData } from './context.js';
import { handleText, secretGuard } from './flows/input.js';
import { privateOnly, rateLimitMiddleware, servicesMiddleware, timingMiddleware, userMiddleware } from './middleware/index.js';
import { render } from './render.js';
import { errorView } from './views/menu.js';

const log = createLogger('bot');

export interface CreateBotOptions {
  token: string;
  app: AppServices;
  userRateLimitPerMin: number;
  /** For tests: skip the network call that fetches bot info. */
  botInfo?: UserFromGetMe;
}

export const sessionKey = (ctx: { from?: { id: number } }) => (ctx.from ? String(ctx.from.id) : undefined);

export function createBot(opts: CreateBotOptions): Bot<BotContext> {
  const bot = new Bot<BotContext>(opts.token, opts.botInfo ? { botInfo: opts.botInfo } : undefined);
  // Retries Telegram 429 (flood wait) and 5xx responses transparently.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  // Per-user ordering when processing updates concurrently with grammY runner.
  bot.use(sequentialize(sessionKey));
  bot.use(servicesMiddleware(opts.app));
  bot.use(privateOnly);
  bot.use(session<SessionData, BotContext>({ initial: () => ({}), getSessionKey: sessionKey }));
  bot.use(secretGuard);
  bot.use(rateLimitMiddleware(opts.userRateLimitPerMin));
  bot.use(userMiddleware());
  bot.use(timingMiddleware);

  registerCommands(bot);
  registerCallbacks(bot);
  bot.on('message:text', handleText);
  bot.on('message', (ctx) => ctx.reply('Send a wallet address, token mint or transaction signature, or use /menu.'));

  bot.catch(async (err: BotError<BotContext>) => {
    const ctx = err.ctx;
    const e = err.error;
    if (e instanceof UserInputError) {
      log.debug('user input error', { message: e.message });
    } else if (e instanceof GrammyError) {
      log.warn('telegram api error', { description: e.description, method: e.method });
    } else if (e instanceof HttpError) {
      log.warn('telegram network error', { error: e.error as Error });
    } else {
      log.error('unhandled bot error', { error: e as Error, updateType: ctx.callbackQuery ? 'callback' : 'message' });
    }
    try {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
      await render(ctx, errorView(userFacingError(e)));
    } catch (renderErr) {
      log.warn('failed to show error to user', { error: renderErr as Error });
    }
  });

  return bot;
}
