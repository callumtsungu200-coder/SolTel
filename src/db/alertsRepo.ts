import { num, unwrap, unwrapMaybe, type Db } from './client.js';
import type { AlertKind, AlertRow, NotificationRow } from './types.js';

export interface ActiveAlert extends AlertRow {
  telegramId: number;
}

/** Alerts + notification history. User-facing methods always filter by user_id. */
export class AlertsRepo {
  constructor(private readonly db: Db) {}

  async list(userId: number): Promise<AlertRow[]> {
    return unwrap('alerts.list', await this.db.from('alerts').select().eq('user_id', userId).order('created_at', { ascending: true }));
  }

  async count(userId: number): Promise<number> {
    const res = await this.db.from('alerts').select('id', { count: 'exact', head: true }).eq('user_id', userId);
    unwrap('alerts.count', res);
    return res.count ?? 0;
  }

  async get(userId: number, id: string): Promise<AlertRow | null> {
    return unwrapMaybe('alerts.get', await this.db.from('alerts').select().eq('user_id', userId).eq('id', id).maybeSingle());
  }

  async create(userId: number, kind: AlertKind, params: Record<string, unknown>, cooldownMinutes: number): Promise<AlertRow> {
    return unwrap(
      'alerts.create',
      await this.db.from('alerts').insert({ user_id: userId, kind, params, cooldown_minutes: cooldownMinutes }).select().single(),
    );
  }

  async update(
    userId: number,
    id: string,
    patch: Partial<Pick<AlertRow, 'params' | 'is_active' | 'cooldown_minutes' | 'state'>>,
  ): Promise<AlertRow | null> {
    const rows = unwrap<AlertRow[]>('alerts.update', await this.db.from('alerts').update(patch).eq('user_id', userId).eq('id', id).select());
    return rows[0] ?? null;
  }

  async delete(userId: number, id: string): Promise<boolean> {
    const rows = unwrap<AlertRow[]>('alerts.delete', await this.db.from('alerts').delete().eq('user_id', userId).eq('id', id).select('id'));
    return rows.length > 0;
  }

  /** Active alerts of the given kinds across all (non-blocked) users — used by background jobs. */
  async listActive(kinds: AlertKind[]): Promise<ActiveAlert[]> {
    const rows = unwrap<Array<AlertRow & { users: { telegram_id: number; is_blocked: boolean } | null }>>(
      'alerts.active',
      await this.db.from('alerts').select('*, users!inner(telegram_id, is_blocked)').eq('is_active', true).in('kind', kinds),
    );
    return rows
      .filter((r) => r.users && !r.users.is_blocked)
      .map(({ users, ...rest }) => ({ ...rest, telegramId: num(users!.telegram_id) }));
  }

  /** Job-side state update (no user scope; called only by background jobs with ids from listActive). */
  async saveState(id: string, state: Record<string, unknown>, triggered: boolean, triggerCount?: number): Promise<void> {
    const patch: Record<string, unknown> = { state };
    if (triggered) {
      patch.last_triggered_at = new Date().toISOString();
      if (triggerCount !== undefined) patch.trigger_count = triggerCount;
    }
    unwrap('alerts.state', await this.db.from('alerts').update(patch).eq('id', id));
  }

  // ----- notification history -----

  /**
   * Atomically reserves a notification slot. Returns the new row id, or null
   * when a notification with the same dedupe key was already recorded for
   * this user (duplicate event — must not be sent again).
   */
  async reserveNotification(input: { userId: number; alertId: string | null; kind: string; dedupeKey: string; message: string }): Promise<number | null> {
    const rows = unwrap<Array<{ id: number }>>(
      'notifications.reserve',
      await this.db
        .from('notification_history')
        .upsert(
          {
            user_id: input.userId,
            alert_id: input.alertId,
            kind: input.kind,
            dedupe_key: input.dedupeKey.slice(0, 200),
            message: input.message.slice(0, 4000),
          },
          { onConflict: 'user_id,dedupe_key', ignoreDuplicates: true },
        )
        .select('id'),
    );
    return rows[0]?.id ?? null;
  }

  async markDelivered(id: number, delivered: boolean, error?: string): Promise<void> {
    unwrap('notifications.mark', await this.db.from('notification_history').update({ delivered, error: error?.slice(0, 500) ?? null }).eq('id', id));
  }

  async history(userId: number, limit: number, offset: number): Promise<{ rows: NotificationRow[]; total: number }> {
    const res = await this.db
      .from('notification_history')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    const rows = unwrap<NotificationRow[]>('notifications.history', res);
    return { rows, total: res.count ?? rows.length };
  }
}
