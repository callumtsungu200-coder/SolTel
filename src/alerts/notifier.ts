import type { AlertsRepo } from '../db/alertsRepo.js';
import type { UsersRepo } from '../db/usersRepo.js';
import type { PreferencesRow } from '../db/types.js';
import { createLogger } from '../utils/logger.js';
import { TokenBucket } from '../utils/rateLimiter.js';
import { isQuietHour } from './evaluator.js';

const log = createLogger('notifier');

export interface MessageSender {
  sendMessage(chatId: number, text: string, opts?: { reply_markup?: unknown }): Promise<unknown>;
}

export interface NotifyInput {
  userId: number;
  telegramId: number;
  alertId?: string | null;
  kind: string;
  dedupeKey: string;
  text: string;
  replyMarkup?: unknown;
  /** Preferences, if the caller already loaded them (avoids a DB round trip). */
  prefs?: PreferencesRow;
}

export type NotifyResult = 'sent' | 'duplicate' | 'disabled' | 'quiet' | 'failed' | 'blocked';

/**
 * Delivers notifications with:
 *  - duplicate prevention: a unique (user_id, dedupe_key) row is reserved
 *    BEFORE sending, so concurrent workers/webhook retries cannot double-send
 *  - user preferences (global on/off, quiet hours)
 *  - outbound rate limiting under Telegram's ~30 msg/s bot limit
 *  - automatic flagging of users who blocked the bot (HTTP 403)
 */
export class Notifier {
  private readonly bucket = new TokenBucket(20, 20);

  constructor(
    private readonly sender: MessageSender,
    private readonly alerts: AlertsRepo,
    private readonly users: UsersRepo,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async notify(input: NotifyInput): Promise<NotifyResult> {
    const prefs = input.prefs ?? (await this.users.getPreferences(input.userId));
    if (!prefs.notifications_enabled) return 'disabled';
    const quiet = isQuietHour(this.now().getUTCHours(), prefs.quiet_hours_start, prefs.quiet_hours_end);

    const id = await this.alerts.reserveNotification({
      userId: input.userId,
      alertId: input.alertId ?? null,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      message: input.text,
    });
    if (id === null) return 'duplicate';
    if (quiet) {
      // Recorded in history (visible in Alert History) but not pushed.
      await this.alerts.markDelivered(id, false, 'suppressed: quiet hours');
      return 'quiet';
    }

    await this.bucket.take();
    try {
      await this.sender.sendMessage(input.telegramId, input.text, input.replyMarkup ? { reply_markup: input.replyMarkup } : undefined);
      await this.alerts.markDelivered(id, true);
      return 'sent';
    } catch (err) {
      const e = err as { error_code?: number; description?: string; message?: string };
      const description = e.description ?? e.message ?? 'unknown error';
      await this.alerts.markDelivered(id, false, description).catch(() => undefined);
      if (e.error_code === 403) {
        log.info('user blocked the bot; disabling notifications', { userId: input.userId });
        await this.users.setBlocked(input.userId, true).catch(() => undefined);
        return 'blocked';
      }
      log.warn('notification failed', { userId: input.userId, error: description });
      return 'failed';
    }
  }
}
