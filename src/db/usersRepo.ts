import { num, numOrNull, unwrap, unwrapMaybe, type Db } from './client.js';
import type { PreferencesRow, UserRow } from './types.js';

export interface TelegramIdentity {
  telegramId: number;
  username?: string | null;
  firstName?: string | null;
  languageCode?: string | null;
}

export type PreferencesPatch = Partial<Omit<PreferencesRow, 'user_id' | 'updated_at'>>;

function normalizePrefs(r: PreferencesRow): PreferencesRow {
  return {
    ...r,
    min_notify_sol: num(r.min_notify_sol),
    whale_threshold_usd: num(r.whale_threshold_usd),
    holding_change_pct: num(r.holding_change_pct),
    trending_min_liquidity: num(r.trending_min_liquidity),
    trending_min_volume: num(r.trending_min_volume),
    page_size: num(r.page_size),
    quiet_hours_start: numOrNull(r.quiet_hours_start),
    quiet_hours_end: numOrNull(r.quiet_hours_end),
  };
}

export class UsersRepo {
  constructor(private readonly db: Db) {}

  /** Creates or refreshes the user from Telegram data and guarantees a preferences row. */
  async upsertFromTelegram(id: TelegramIdentity): Promise<UserRow> {
    const user = unwrap<UserRow>(
      'users.upsert',
      await this.db
        .from('users')
        .upsert(
          {
            telegram_id: id.telegramId,
            username: id.username?.slice(0, 64) ?? null,
            first_name: id.firstName?.slice(0, 128) ?? null,
            language_code: id.languageCode?.slice(0, 16) ?? null,
            last_seen_at: new Date().toISOString(),
            is_blocked: false,
          },
          { onConflict: 'telegram_id' },
        )
        .select()
        .single(),
    );
    unwrap('prefs.ensure', await this.db.from('user_preferences').upsert({ user_id: user.id }, { onConflict: 'user_id', ignoreDuplicates: true }));
    return user;
  }

  async getById(userId: number): Promise<UserRow | null> {
    return unwrapMaybe<UserRow>('users.get', await this.db.from('users').select().eq('id', userId).maybeSingle());
  }

  async setBlocked(userId: number, blocked: boolean): Promise<void> {
    unwrap('users.setBlocked', await this.db.from('users').update({ is_blocked: blocked }).eq('id', userId));
  }

  async getPreferences(userId: number): Promise<PreferencesRow> {
    const row = unwrapMaybe<PreferencesRow>('prefs.get', await this.db.from('user_preferences').select().eq('user_id', userId).maybeSingle());
    if (row) return normalizePrefs(row);
    const created = unwrap<PreferencesRow>('prefs.create', await this.db.from('user_preferences').insert({ user_id: userId }).select().single());
    return normalizePrefs(created);
  }

  async getPreferencesMany(userIds: number[]): Promise<Map<number, PreferencesRow>> {
    if (userIds.length === 0) return new Map();
    const rows = unwrap<PreferencesRow[]>('prefs.getMany', await this.db.from('user_preferences').select().in('user_id', userIds));
    return new Map(rows.map((r) => [r.user_id, normalizePrefs(r)]));
  }

  async updatePreferences(userId: number, patch: PreferencesPatch): Promise<PreferencesRow> {
    const row = unwrap<PreferencesRow>('prefs.update', await this.db.from('user_preferences').update(patch).eq('user_id', userId).select().single());
    return normalizePrefs(row);
  }
}
