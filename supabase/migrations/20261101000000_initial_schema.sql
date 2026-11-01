-- =====================================================================
-- Solana Intelligence Bot — initial schema
--
-- Security model
--   * The bot connects with the service-role key (server side only). The
--     service role bypasses RLS; the repository layer scopes every query
--     to the requesting Telegram user's internal id.
--   * RLS is ENABLED on every table. anon has no policies → no access.
--   * `authenticated` users (e.g. a future web dashboard that mints a JWT
--     with a `telegram_id` claim) can only read/modify their OWN rows.
--   * Public blockchain data (tokens, price history, snapshots of public
--     wallets, observed transactions) has no user data and is readable
--     by authenticated users but writable only by the service role.
--   * Private keys / seed phrases are never stored. Only public addresses.
-- =====================================================================

-- gen_random_uuid() is built into PostgreSQL 13+, so no extension is required.

-- ---------- helpers ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Solana base58 public key (32 bytes → 32..44 chars).
create domain public.solana_address as text
  check (value ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');

-- ---------- users ----------
create table public.users (
  id            bigint generated always as identity primary key,
  telegram_id   bigint not null unique,
  username      text check (char_length(username) <= 64),
  first_name    text check (char_length(first_name) <= 128),
  language_code text check (char_length(language_code) <= 16),
  is_blocked    boolean not null default false,  -- user blocked the bot
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

-- Internal user id for the JWT's telegram_id claim (null if absent/unknown).
create or replace function public.current_app_user_id() returns bigint
language sql stable security definer set search_path = public as $$
  select u.id from public.users u
  where u.telegram_id = nullif(auth.jwt() ->> 'telegram_id', '')::bigint
$$;
revoke all on function public.current_app_user_id() from public, anon;
grant execute on function public.current_app_user_id() to authenticated, service_role;

create table public.user_preferences (
  user_id                 bigint primary key references public.users(id) on delete cascade,
  notifications_enabled   boolean not null default true,
  notify_wallet_activity  boolean not null default true,
  notify_holdings_changes boolean not null default true,
  min_notify_sol          numeric(20,9) not null default 0 check (min_notify_sol >= 0),
  whale_threshold_usd     numeric(20,2) not null default 50000 check (whale_threshold_usd >= 0),
  holding_change_pct      numeric(6,2)  not null default 25 check (holding_change_pct between 1 and 1000),
  trending_min_liquidity  numeric(20,2) not null default 50000 check (trending_min_liquidity >= 0),
  trending_min_volume     numeric(20,2) not null default 100000 check (trending_min_volume >= 0),
  trending_sort           text not null default 'volume'
    check (trending_sort in ('volume','liquidity','gainers','losers','marketCap','txns','change1h')),
  page_size               smallint not null default 5 check (page_size between 3 and 15),
  quiet_hours_start       smallint check (quiet_hours_start between 0 and 23),
  quiet_hours_end         smallint check (quiet_hours_end between 0 and 23),
  updated_at              timestamptz not null default now()
);
create trigger trg_prefs_updated before update on public.user_preferences
  for each row execute function public.set_updated_at();

-- ---------- wallet tracking ----------
create table public.tracked_wallets (
  id               uuid primary key default gen_random_uuid(),
  user_id          bigint not null references public.users(id) on delete cascade,
  address          public.solana_address not null,
  label            text not null check (char_length(label) between 1 and 48),
  notify_incoming  boolean not null default true,
  notify_outgoing  boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, address)
);
create index idx_tracked_wallets_address on public.tracked_wallets(address);
create trigger trg_tracked_updated before update on public.tracked_wallets
  for each row execute function public.set_updated_at();

-- Global monitoring cursor per distinct address (shared by all users tracking it).
create table public.monitored_addresses (
  address          public.solana_address primary key,
  last_signature   text,
  last_slot        bigint,
  last_checked_at  timestamptz,
  holdings_state   jsonb,           -- last observed {mint: amount} map
  holdings_checked_at timestamptz,
  created_at       timestamptz not null default now()
);

-- Observed transactions of monitored addresses (public chain data).
create table public.wallet_transactions (
  id             bigint generated always as identity primary key,
  wallet_address public.solana_address not null,
  signature      text not null check (char_length(signature) between 64 and 90),
  slot           bigint,
  block_time     timestamptz,
  tx_type        text not null,
  source         text,
  category       text not null check (category in ('swap','transfer','failed','other')),
  direction      text not null check (direction in ('incoming','outgoing','mixed','none')),
  sol_change     numeric(30,9) not null default 0,
  token_changes  jsonb not null default '[]'::jsonb,
  description    text,
  success        boolean not null default true,
  provider       text not null,
  created_at     timestamptz not null default now(),
  unique (wallet_address, signature)
);
create index idx_wallet_tx_wallet_time on public.wallet_transactions(wallet_address, block_time desc);

-- ---------- tokens ----------
create table public.tokens (
  mint             public.solana_address primary key,
  name             text,
  symbol           text,
  decimals         smallint check (decimals between 0 and 255),
  supply           numeric,
  mint_authority   text,
  freeze_authority text,
  metadata         jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now()
);
create trigger trg_tokens_updated before update on public.tokens
  for each row execute function public.set_updated_at();

create table public.token_watchlist (
  id         uuid primary key default gen_random_uuid(),
  user_id    bigint not null references public.users(id) on delete cascade,
  mint       public.solana_address not null,
  label      text check (char_length(label) <= 48),
  created_at timestamptz not null default now(),
  unique (user_id, mint)
);
create index idx_token_watchlist_mint on public.token_watchlist(mint);

create table public.price_history (
  id            bigint generated always as identity primary key,
  mint          public.solana_address not null,
  price_usd     numeric not null check (price_usd >= 0),
  liquidity_usd numeric,
  volume_24h    numeric,
  volume_1h     numeric,
  market_cap    numeric,
  fdv           numeric,
  txns_1h       integer,
  source        text not null default 'dexscreener',
  recorded_at   timestamptz not null default now()
);
create index idx_price_history_mint_time on public.price_history(mint, recorded_at desc);

-- ---------- portfolio ----------
create table public.portfolio_snapshots (
  id                 bigint generated always as identity primary key,
  wallet_address     public.solana_address not null,
  sol_balance        numeric(30,9) not null,
  sol_price_usd      numeric,
  tokens_value_usd   numeric not null default 0,
  total_value_usd    numeric,
  priced_count       integer not null default 0,
  unpriced_count     integer not null default 0,
  holdings           jsonb not null default '[]'::jsonb,
  taken_at           timestamptz not null default now()
);
create index idx_snapshots_wallet_time on public.portfolio_snapshots(wallet_address, taken_at desc);

-- ---------- alerts ----------
create table public.alerts (
  id                uuid primary key default gen_random_uuid(),
  user_id           bigint not null references public.users(id) on delete cascade,
  kind              text not null check (kind in
                      ('wallet_activity','large_transaction','price_move','price_target',
                       'volume_spike','liquidity_change','token_activity')),
  params            jsonb not null,
  is_active         boolean not null default true,
  cooldown_minutes  integer not null default 60 check (cooldown_minutes between 1 and 10080),
  state             jsonb not null default '{}'::jsonb,
  last_triggered_at timestamptz,
  trigger_count     integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index idx_alerts_user on public.alerts(user_id);
create index idx_alerts_active_kind on public.alerts(kind) where is_active;
create trigger trg_alerts_updated before update on public.alerts
  for each row execute function public.set_updated_at();

-- Large transaction observations (whale monitor history, public chain data).
create table public.whale_events (
  id          bigint generated always as identity primary key,
  signature   text not null,
  watched     public.solana_address not null,  -- mint or wallet being watched
  watch_kind  text not null check (watch_kind in ('token','wallet')),
  event_kind  text not null check (event_kind in ('sol_transfer','token_transfer','swap')),
  mint        text,
  amount      numeric not null,
  usd_value   numeric,
  from_addr   text,
  to_addr     text,
  block_time  timestamptz,
  created_at  timestamptz not null default now(),
  unique nulls not distinct (signature, watched, event_kind, mint, from_addr, to_addr)
);
create index idx_whale_watched_time on public.whale_events(watched, block_time desc);
create index idx_whale_from on public.whale_events(from_addr);
create index idx_whale_to on public.whale_events(to_addr);

-- ---------- notifications ----------
create table public.notification_history (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references public.users(id) on delete cascade,
  alert_id    uuid references public.alerts(id) on delete set null,
  kind        text not null,
  dedupe_key  text not null check (char_length(dedupe_key) <= 200),
  message     text not null,
  delivered   boolean not null default false,
  error       text,
  created_at  timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index idx_notifications_user_time on public.notification_history(user_id, created_at desc);

-- =====================================================================
-- Row Level Security
-- =====================================================================
alter table public.users                enable row level security;
alter table public.user_preferences     enable row level security;
alter table public.tracked_wallets      enable row level security;
alter table public.monitored_addresses  enable row level security;
alter table public.wallet_transactions  enable row level security;
alter table public.tokens               enable row level security;
alter table public.token_watchlist      enable row level security;
alter table public.price_history        enable row level security;
alter table public.portfolio_snapshots  enable row level security;
alter table public.alerts               enable row level security;
alter table public.whale_events         enable row level security;
alter table public.notification_history enable row level security;

-- Private per-user data: owner only.
create policy users_self_select on public.users
  for select to authenticated using (id = public.current_app_user_id());

create policy prefs_owner_all on public.user_preferences
  for all to authenticated
  using (user_id = public.current_app_user_id())
  with check (user_id = public.current_app_user_id());

create policy tracked_owner_all on public.tracked_wallets
  for all to authenticated
  using (user_id = public.current_app_user_id())
  with check (user_id = public.current_app_user_id());

create policy watchlist_owner_all on public.token_watchlist
  for all to authenticated
  using (user_id = public.current_app_user_id())
  with check (user_id = public.current_app_user_id());

create policy alerts_owner_all on public.alerts
  for all to authenticated
  using (user_id = public.current_app_user_id())
  with check (user_id = public.current_app_user_id());

create policy notifications_owner_select on public.notification_history
  for select to authenticated using (user_id = public.current_app_user_id());

-- Public chain/market data: read-only for authenticated users.
create policy tokens_read on public.tokens for select to authenticated using (true);
create policy price_history_read on public.price_history for select to authenticated using (true);
create policy whale_read on public.whale_events for select to authenticated using (true);

-- Snapshots / observed transactions: only for addresses the caller tracks
-- (prevents enumerating which wallets other users track).
create policy snapshots_tracked_read on public.portfolio_snapshots
  for select to authenticated using (
    exists (select 1 from public.tracked_wallets t
            where t.address = portfolio_snapshots.wallet_address
              and t.user_id = public.current_app_user_id()));

create policy wallet_tx_tracked_read on public.wallet_transactions
  for select to authenticated using (
    exists (select 1 from public.tracked_wallets t
            where t.address = wallet_transactions.wallet_address
              and t.user_id = public.current_app_user_id()));

-- monitored_addresses: no policies → service role only.

-- Explicitly revoke anonymous access to everything.
revoke all on all tables in schema public from anon;

-- =====================================================================
-- Retention helper (call from a cron or the bot's maintenance job)
-- =====================================================================
create or replace function public.prune_old_data(keep_days integer default 90) returns void
language sql security definer set search_path = public as $$
  delete from public.price_history        where recorded_at < now() - make_interval(days => keep_days);
  delete from public.wallet_transactions  where created_at  < now() - make_interval(days => keep_days);
  delete from public.whale_events         where created_at  < now() - make_interval(days => keep_days);
  delete from public.notification_history where created_at  < now() - make_interval(days => keep_days);
  delete from public.portfolio_snapshots  where taken_at    < now() - make_interval(days => greatest(keep_days, 365));
$$;
revoke all on function public.prune_old_data(integer) from public, anon, authenticated;
grant execute on function public.prune_old_data(integer) to service_role;
