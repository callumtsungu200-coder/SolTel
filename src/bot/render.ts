import { GrammyError, type InlineKeyboard } from 'grammy';
import { splitMessage } from '../utils/format.js';
import type { BotContext } from './context.js';

export interface View {
  text: string;
  keyboard?: InlineKeyboard;
}

const LINK_OPTS = { is_disabled: true } as const;

/**
 * Shows a view: edits the current message when triggered from an inline
 * button, otherwise sends a new message. Long texts are split; the keyboard
 * is attached to the last part.
 */
export async function render(ctx: BotContext, view: View): Promise<void> {
  const parts = splitMessage(view.text);
  if (ctx.callbackQuery?.message && parts.length === 1) {
    try {
      await ctx.editMessageText(parts[0]!, { parse_mode: 'HTML', reply_markup: view.keyboard, link_preview_options: LINK_OPTS });
      return;
    } catch (err) {
      // "message is not modified" is harmless (user pressed refresh on identical data).
      if (err instanceof GrammyError && err.description.includes('message is not modified')) return;
      if (!(err instanceof GrammyError)) throw err;
      // Fall through: message too old / deleted → send a new one.
    }
  }
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    await ctx.reply(parts[i]!, { parse_mode: 'HTML', reply_markup: last ? view.keyboard : undefined, link_preview_options: LINK_OPTS });
  }
}

/**
 * Loading indicator: shows "⏳ …" immediately (editing the message for
 * callbacks, sending one for commands) then renders the produced view in
 * place of the indicator.
 */
export async function withLoading(ctx: BotContext, label: string, produce: () => Promise<View>): Promise<void> {
  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery({ text: label }).catch(() => undefined);
    await ctx.editMessageText(`⏳ ${label}`).catch(() => undefined);
    await render(ctx, await produce());
    return;
  }
  await ctx.replyWithChatAction('typing').catch(() => undefined);
  const placeholder = await ctx.reply(`⏳ ${label}`);
  let view: View;
  try {
    view = await produce();
  } catch (err) {
    await ctx.api.deleteMessage(placeholder.chat.id, placeholder.message_id).catch(() => undefined);
    throw err;
  }
  const parts = splitMessage(view.text);
  if (parts.length === 1) {
    try {
      await ctx.api.editMessageText(placeholder.chat.id, placeholder.message_id, parts[0]!, {
        parse_mode: 'HTML',
        reply_markup: view.keyboard,
        link_preview_options: LINK_OPTS,
      });
      return;
    } catch {
      /* fall back to sending */
    }
  }
  await ctx.api.deleteMessage(placeholder.chat.id, placeholder.message_id).catch(() => undefined);
  for (let i = 0; i < parts.length; i++) {
    await ctx.reply(parts[i]!, { parse_mode: 'HTML', reply_markup: i === parts.length - 1 ? view.keyboard : undefined, link_preview_options: LINK_OPTS });
  }
}

/** Shows a short toast for button presses; a no-op for text messages. */
export async function toast(ctx: BotContext, text: string): Promise<void> {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text }).catch(() => undefined);
}
