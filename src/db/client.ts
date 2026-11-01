import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DatabaseError } from '../utils/errors.js';
import type { FetchLike } from '../utils/http.js';

/** The bot uses the service-role key server side only; it is never sent to Telegram. */
export type Db = SupabaseClient;

export function createDb(url: string, serviceRoleKey: string, fetchImpl?: FetchLike): Db {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { 'x-application-name': 'soltel' },
      ...(fetchImpl ? { fetch: fetchImpl as typeof fetch } : {}),
    },
  });
}

interface PgResult<T> {
  data: T | null;
  error: { message: string; code?: string; details?: string } | null;
}

/** Unwraps a Supabase result, converting errors into `DatabaseError`. */
export function unwrap<T>(op: string, res: PgResult<T>): T {
  if (res.error) throw new DatabaseError(`${op} failed: ${res.error.message}`, op, res.error.code);
  return res.data as T;
}

/** Like unwrap but returns null when no row matched. */
export function unwrapMaybe<T>(op: string, res: PgResult<T>): T | null {
  if (res.error) {
    if (res.error.code === 'PGRST116') return null;
    throw new DatabaseError(`${op} failed: ${res.error.message}`, op, res.error.code);
  }
  return res.data;
}

/** Postgres unique violation. */
export const isUniqueViolation = (err: unknown) => err instanceof DatabaseError && err.code === '23505';

export const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
