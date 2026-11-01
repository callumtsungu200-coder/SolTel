/** Row types mirroring supabase/migrations. Numeric columns arrive as numbers or strings from PostgREST. */

export interface UserRow {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  language_code: string | null;
  is_blocked: boolean;
  created_at: string;
  last_seen_at: string;
}

export interface PreferencesRow {
  user_id: number;
  notifications_enabled: boolean;
  notify_wallet_activity: boolean;
  notify_holdings_changes: boolean;
  min_notify_sol: number;
  whale_threshold_usd: number;
  holding_change_pct: number;
  trending_min_liquidity: number;
  trending_min_volume: number;
  trending_sort: 'volume' | 'liquidity' | 'gainers' | 'losers' | 'marketCap' | 'txns' | 'change1h';
  page_size: number;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  updated_at: string;
}

export interface TrackedWalletRow {
  id: string;
  user_id: number;
  address: string;
  label: string;
  notify_incoming: boolean;
  notify_outgoing: boolean;
  created_at: string;
  updated_at: string;
}

export interface MonitoredAddressRow {
  address: string;
  last_signature: string | null;
  last_slot: number | null;
  last_checked_at: string | null;
  holdings_state: Record<string, number> | null;
  holdings_checked_at: string | null;
}

export interface WalletTransactionRow {
  wallet_address: string;
  signature: string;
  slot: number | null;
  block_time: string | null;
  tx_type: string;
  source: string | null;
  category: 'swap' | 'transfer' | 'failed' | 'other';
  direction: 'incoming' | 'outgoing' | 'mixed' | 'none';
  sol_change: number;
  token_changes: Array<{ mint: string; amount: number }>;
  description: string | null;
  success: boolean;
  provider: string;
}

export interface WatchlistRow {
  id: string;
  user_id: number;
  mint: string;
  label: string | null;
  created_at: string;
}

export interface PriceHistoryRow {
  mint: string;
  price_usd: number;
  liquidity_usd: number | null;
  volume_24h: number | null;
  volume_1h: number | null;
  market_cap: number | null;
  fdv: number | null;
  txns_1h: number | null;
  source: string;
  recorded_at?: string;
}

export interface SnapshotRow {
  id?: number;
  wallet_address: string;
  sol_balance: number;
  sol_price_usd: number | null;
  tokens_value_usd: number;
  total_value_usd: number | null;
  priced_count: number;
  unpriced_count: number;
  holdings: Array<{ mint: string; symbol: string; amount: number; priceUsd: number | null }>;
  taken_at?: string;
}

export type AlertKind =
  | 'wallet_activity'
  | 'large_transaction'
  | 'price_move'
  | 'price_target'
  | 'volume_spike'
  | 'liquidity_change'
  | 'token_activity';

export interface AlertRow {
  id: string;
  user_id: number;
  kind: AlertKind;
  params: Record<string, unknown>;
  is_active: boolean;
  cooldown_minutes: number;
  state: Record<string, unknown>;
  last_triggered_at: string | null;
  trigger_count: number;
  created_at: string;
  updated_at: string;
}

export interface NotificationRow {
  id: number;
  user_id: number;
  alert_id: string | null;
  kind: string;
  dedupe_key: string;
  message: string;
  delivered: boolean;
  error: string | null;
  created_at: string;
}

export interface WhaleEventRow {
  signature: string;
  watched: string;
  watch_kind: 'token' | 'wallet';
  event_kind: 'sol_transfer' | 'token_transfer' | 'swap';
  mint: string | null;
  amount: number;
  usd_value: number | null;
  from_addr: string | null;
  to_addr: string | null;
  block_time: string | null;
}

/** Subscriber of a monitored address with everything needed to notify them. */
export interface Tracker {
  walletId: string;
  label: string;
  userId: number;
  telegramId: number;
  notifyIncoming: boolean;
  notifyOutgoing: boolean;
}
