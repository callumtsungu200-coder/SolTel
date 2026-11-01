# Solana Wallet & Token Intelligence Bot

A Telegram bot for researching Solana wallets and tokens with live on-chain and
market data. It tracks public wallets, monitors large transactions and sends
alerts.

Built with **TypeScript · grammY · Helius · Solana RPC · DexScreener ·
GeckoTerminal · Supabase · Zod · Vitest**, using free API tiers only.

> **Read-only by design.** The bot never asks for, accepts or stores private
> keys or seed phrases. If a user pastes one, it is detected (including base58
> keypairs that look like signatures), deleted and never sent to any API. The
> bot does not trade or execute transactions, and nothing it shows is
> financial advice.

---

## Contents

1. [Features](#features)
2. [Architecture](#architecture)
3. [Data sources and honest limitations](#data-sources-and-honest-limitations)
4. [Requirements](#requirements)
5. [Setup](#setup): [Telegram](#1-create-the-telegram-bot-botfather) · [Helius](#2-get-a-helius-api-key) · [Supabase](#3-configure-supabase) · [.env](#4-configure-credentials)
6. [Running locally](#running-locally)
7. [Tests](#tests)
8. [Deployment](#deployment)
9. [Real-time wallet monitoring (webhooks)](#real-time-wallet-monitoring-helius-webhooks)
10. [Free-tier budget](#free-tier-budget)
11. [Troubleshooting](#troubleshooting)
12. [Project structure](#project-structure)

---

## Features

The dashboard (`/start`) uses inline buttons. Every screen has **⬅️ Back** and
**🏠 Main menu**. You can paste a wallet address, token mint, transaction
signature or Solscan link at any time, and the bot figures out what it is.

| Section | What you get |
|---|---|
| 👛 **Wallet Intelligence** | SOL balance ✅, estimated portfolio value 📐, token holdings with prices, NFT count, wallet age and transaction count (exact or lower bound), activity frequency, SOL inflows/outflows/fees, swap/transfer breakdown, paginated recent transactions, an **activity timeline**, **token acquisition history** (first observed inbound movement), counterparties and interaction history, activity patterns (hour/weekday), and a documented activity score |
| 🪙 **Token Intelligence** | Name, symbol and mint; price; 5m/1h/6h/24h change; market cap, FDV and calculated FDV; liquidity and 24h volume across all pools; trading pairs; on-chain supply, decimals, mint/freeze authority and metadata mutability; 30-day price history; volatility; max drawdown; unusual-volume detection; holder concentration; risk warnings |
| 🔥 **Trending Tokens** | Sort by volume, liquidity, 24h gainers/losers, 1h movers, market cap or trade count, with configurable minimum liquidity/volume filters and per-token data-quality warnings. Paid boosts are disclosed; nothing here is a recommendation |
| 🧾 **Transaction Monitor** | Look up any signature: status, time, fee, SOL and token transfers, Solscan link. Also a combined feed of your tracked wallets and the **whale monitor** (filter by token, wallet or participant address) |
| ⭐ **Watchlists** | Track wallets (add, remove, rename, view activity, toggle incoming/outgoing notifications) and keep a token watchlist with live prices |
| 📊 **Portfolio Analytics** | SOL and token value, an allocation chart, historical snapshots, 24h/7d change split into **price effect** and **quantity effect** (not profit), price exposure from historical prices, and all tracked wallets combined |
| 🔔 **Alerts** | Wallet activity, large transactions, price movement, price target, volume spike, liquidity change and trading activity. Create, edit thresholds, pause/activate, delete, set cooldowns, view history |
| ⚙️ **Settings** | Notifications on/off, wallet-activity and holding-change notifications, minimum SOL, holding-change %, default whale threshold, quiet hours (UTC), page size, trending filters |

Every figure carries a provenance label: ✅ on-chain · 📈 market data · 📐 estimate · ❔ unavailable.
The formulas are in [docs/METHODOLOGY.md](docs/METHODOLOGY.md) and in the bot via `/methodology`.

### Commands

`/start` `/menu` `/wallet <address>` `/token <mint>` `/tx <signature>` `/trending`
`/track <address> [label]` `/watch <mint>` `/portfolio` `/whales` `/alerts`
`/settings` `/methodology` `/help` `/cancel`

---

## Architecture

```
                         ┌──────────────────────────── Telegram ───────────────────────────┐
                         │   long polling (grammY runner, per-user sequential processing)  │
                         └───────────────┬─────────────────────────────────▲────────────────┘
                                         │ updates                         │ messages / alerts
┌────────────────────────────────────────▼─────────────────────────────────┴────────────────┐
│ bot/  middleware: private-only → session → secret guard → rate limit → user identification │
│       commands/ · callbacks/router · flows/input (text prompts) · actions/ · views/         │
└───────┬──────────────────────────────┬────────────────────────────────┬──────────────────┘
        │                              │                                │
┌───────▼────────┐   ┌─────────────────▼──────────────┐   ┌─────────────▼──────────────────┐
│ analytics/     │   │ services/                      │   │ db/ (Supabase, service role)   │
│ wallet, token, │──▶│ prices (DexScreener pools)     │   │ users · wallets · alerts ·     │
│ trending,      │   │ tokenMetadata (Helius DAS)     │   │ market repositories            │
│ portfolio,     │   │ transactions (normaliser:      │   │ every user query scoped by     │
│ stats, score   │   │  Parsed Events / webhook / RPC)│   │ user_id; RLS on all tables     │
└───────┬────────┘   └─────────────────┬──────────────┘   └─────────────▲──────────────────┘
        │                              │                                │
┌───────▼──────────────────────────────▼──────────┐   ┌─────────────────┴──────────────────┐
│ clients/  (timeouts, retries, Retry-After,      │   │ jobs/ (IntervalJob: no overlap,     │
│ token-bucket rate limits, Zod-validated output) │   │ graceful stop)                      │
│ solanaRpc · helius · dexscreener · geckoterminal│◀──│ walletPoller · holdingsMonitor ·    │
└─────────────────────────────────────────────────┘   │ marketAlerts · whaleMonitor ·       │
                                                      │ snapshots · maintenance             │
┌─────────────────────────────────────────────────┐   │ alerts/ evaluator + notifier        │
│ webhooks/ HTTP server: GET /health,             │──▶│ (dedupe reserved before sending)    │
│ POST /webhooks/helius (auth header, async)      │   └────────────────────────────────────┘
└─────────────────────────────────────────────────┘
```

Key design points:

* **One transaction pipeline.** Helius webhooks, the polling fallback and the
  RPC fallback all produce one `NormalizedTx` type. Wallet-relative views come
  from that, so notifications, feeds and analytics classify transactions the
  same way.
* **Duplicate prevention at two levels.** `wallet_transactions` has
  `unique (wallet_address, signature)`, and only newly inserted rows trigger
  notifications. `notification_history` has `unique (user_id, dedupe_key)`,
  reserved *before* the Telegram message is sent. Webhook retries,
  polling/webhook overlap and restarts therefore never double-notify.
* **Graceful degradation.** If Helius DAS fails, holdings come from RPC token
  accounts. If Parsed Events fails, transactions are parsed from raw RPC. If
  metadata fails, labels fall back to DexScreener data or the shortened mint.
  The user sees which data is unavailable.
* **Graceful shutdown.** SIGINT/SIGTERM stop the Telegram runner, wait for
  in-flight jobs and webhook processing, then exit (forced after 25 s).

---

## Data sources and honest limitations

| Need | Source | Notes / limitations |
|---|---|---|
| Balances, signatures, mint accounts, largest token accounts | Solana JSON-RPC via Helius (public RPC as fallback) | Public RPC rejects `getTokenLargestAccounts` for large tokens; Helius RPC supports it |
| Holdings and token metadata | Helius **DAS** (`getAssetsByOwner`, `getAssetBatch`) | Up to 3,000 assets per wallet are analysed |
| Parsed transaction history | Helius **Parsed Events** (`/v1/parsed-events/*`) | The current API (the legacy Enhanced Transactions API is in maintenance mode). Profiles sample the latest 100 transactions |
| Real-time wallet activity | Helius **webhooks** (enhanced payload) | Needs a public HTTPS URL. Otherwise the bot polls |
| Prices, liquidity, volume, market cap, FDV, trading pairs | **DexScreener** (keyless) | The batch endpoint returns only each token's main pair, so token reports use `/token-pairs` (up to 30 pools) |
| Historical OHLCV | **GeckoTerminal** (keyless, ~30 req/min) | DexScreener has no history endpoint. Pools unknown to GeckoTerminal show "unavailable" |
| Trending | DexScreener boosts, profiles and search | There is no public "rank every Solana token" endpoint. Boosts are paid and disclosed |

Further limitations:

* **Wallet age and transaction count** are exact only when the full signature
  history fits inside `WALLET_HISTORY_MAX_PAGES` × 1,000. Otherwise they are
  shown as lower bounds.
* **Polling mode:** `getSignaturesForAddress(wallet)` lists transactions that
  reference the wallet account. Incoming SPL transfers into an existing token
  account may not reference the owner. The **holdings-change monitor**
  catches those balance changes on its next run (default 30 min).
* **Whale monitor:** full-network whale detection needs a paid firehose
  (Geyser/LaserStream). The free-tier design watches the tokens and wallets
  that users choose: a token's deepest pool, or a wallet's own history. Each
  poll samples the latest 100 transactions, so very busy pools can have
  activity between polls that is missed.
* **Holder concentration** counts token *accounts*, which include pools,
  exchanges and burn addresses. It is not a list of distinct holders.
* USD values of past transactions use **current** prices and are labelled as
  estimates.

---

## Requirements

* **Node.js ≥ 20.11** (developed and tested on Node 26; Docker image uses Node 24 LTS)
* npm 10+
* A Telegram account
* Free accounts at [Helius](https://dashboard.helius.dev) and [Supabase](https://supabase.com)
* Optional: [Supabase CLI](https://supabase.com/docs/guides/cli) for migrations, Docker for container deploys

---

## Setup

### 1. Create the Telegram bot (BotFather)

1. In Telegram, open **[@BotFather](https://t.me/BotFather)** and send `/newbot`.
2. Choose a display name, then a username ending in `bot` (e.g. `my_solana_intel_bot`).
3. BotFather replies with a token like `123456789:AAH…`. That is your `TELEGRAM_BOT_TOKEN`. Keep it secret.
4. Optional: `/setdescription`, `/setuserpic`. The command menu is registered automatically at startup.

### 2. Get a Helius API key

1. Sign up at **https://dashboard.helius.dev** (the free plan is enough).
2. Open **API Keys** and copy the key. That is `HELIUS_API_KEY`.
3. The free plan includes RPC, DAS, Parsed Events and up to 5 webhooks. See the [budget](#free-tier-budget).

### 3. Configure Supabase

1. Create a project at **https://supabase.com/dashboard** (the free tier works).
2. Apply the schema, choosing **one** of these:
   * **SQL editor:** open *SQL Editor → New query*, paste the contents of
     [`supabase/migrations/20261101000000_initial_schema.sql`](supabase/migrations/20261101000000_initial_schema.sql) and click **Run**.
   * **Supabase CLI:**
     ```bash
     supabase link --project-ref <your-project-ref>
     ```
     ```bash
     supabase db push
     ```
3. In *Project Settings → API*, copy the **Project URL** (`SUPABASE_URL`) and
   the **service_role** key (`SUPABASE_SERVICE_ROLE_KEY`).

**Security model.** The bot runs server-side with the service-role key, which
must never be shipped to clients. RLS is enabled on **every** table:

* `anon` has no access at all.
* `authenticated` users (for example a future web dashboard that issues JWTs
  with a `telegram_id` claim) can only read and modify their **own** rows.
* Public chain data (tokens, price history, whale events) is read-only.
* Portfolio snapshots and observed transactions are visible only for
  wallets that user tracks, so nobody can list the wallets other users track.
* The repository layer also scopes every user query by `user_id`.

These policies are covered by tests that run the real migration on PostgreSQL.

### 4. Configure credentials

```bash
cp .env.example .env
```

Fill in the four required values: `TELEGRAM_BOT_TOKEN`, `HELIUS_API_KEY`,
`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Everything else has sensible
defaults, documented inline in [`.env.example`](.env.example). The app
validates the whole environment with Zod at startup and lists exactly which
variables are missing, malformed or still placeholders, without printing
their values.

Secrets never reach logs: the logger redacts registered secret values,
`api-key=` query parameters, bearer tokens, bot tokens and JWTs.

---

## Running locally

```bash
npm install
```

Development (auto-reload):

```bash
npm run dev
```

Production build:

```bash
npm run build
```

```bash
npm start
```

Open your bot in Telegram and send `/start`. Logs are structured JSON.
`GET http://localhost:8080/health` returns `{"ok":true,…}`.

---

## Tests

```bash
npm test
```

```bash
npm run typecheck
```

The suite has **150 tests**:

| Area | File |
|---|---|
| Address/signature validation, private-key and seed-phrase detection, input parsing | `tests/unit/validation.test.ts` |
| HTTP retries, Retry-After, timeouts, log redaction, rate limiting, env validation | `tests/unit/infrastructure.test.ts` |
| API clients and response validation (DexScreener, Helius, RPC, GeckoTerminal) | `tests/unit/clients.test.ts` |
| Transaction parsing (Parsed Events, webhook, RPC); swap vs transfer classification | `tests/unit/transactions.test.ts` |
| Pricing, portfolio calculations, attribution, statistics, scoring, token reports, trending | `tests/unit/analytics.test.ts` |
| Alert triggering (every kind, cooldowns, crossings), quiet hours, notifier dedupe | `tests/unit/alerts.test.ts` |
| Notification rules, duplicate prevention, holdings diff, whale extraction, webhook receiver, scheduler | `tests/unit/jobs.test.ts` |
| **Real migration on PostgreSQL (PGlite)**: constraints, cascades, dedupe, **RLS isolation** | `tests/db/schema.test.ts` |
| Repositories at the PostgREST HTTP boundary (user scoping, conflict handling) | `tests/db/repositories.test.ts` |
| Telegram command handling end to end (real grammY bot, intercepted API) | `tests/bot/bot.test.ts` |

**Live API smoke test** (real network calls, writes nothing):

```bash
npm run smoke
```

Without a Helius key it checks the public RPC, DexScreener and GeckoTerminal.
With `HELIUS_API_KEY` in `.env` it also checks DAS, Parsed Events, signature
parsing and holder concentration.

---

## Deployment

The bot is one long-running Node process: Telegram long polling plus
background jobs plus a small HTTP server. Run exactly **one** instance per
bot token, because Telegram allows only one long-polling consumer.

### Docker

```bash
docker build -t solana-intel-bot .
```

```bash
docker run -d --name solana-intel-bot --restart unless-stopped --env-file .env -p 8080:8080 solana-intel-bot
```

The image runs as a non-root user and includes a `/health` healthcheck.

### Railway / Render / Fly.io

1. Create a service from this repository. It uses the Dockerfile; or set the build command to `npm ci && npm run build` and the start command to `npm start`.
2. Add the environment variables from `.env.example`.
3. Expose port `8080` if you want webhooks; the platform's HTTPS URL becomes `PUBLIC_WEBHOOK_URL`.
4. Use a single instance/replica with no scale-to-zero, since jobs and polling need a running process.

### VPS (systemd)

```ini
# /etc/systemd/system/solana-intel-bot.service
[Unit]
Description=Solana Intelligence Telegram Bot
After=network-online.target

[Service]
WorkingDirectory=/opt/solana-intel-bot
EnvironmentFile=/opt/solana-intel-bot/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
User=bot
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now solana-intel-bot
```

---

## Real-time wallet monitoring (Helius webhooks)

By default (`WALLET_MONITOR_MODE=auto`) the bot **polls** tracked wallets.
For near-real-time notifications:

1. Deploy somewhere with a public HTTPS URL, e.g. `https://bot.example.com`.
2. Set `PUBLIC_WEBHOOK_URL=https://bot.example.com` and a random
   `HELIUS_WEBHOOK_SECRET` (16+ characters).
3. Restart. The bot creates one Helius enhanced webhook pointing to
   `https://bot.example.com/webhooks/helius` and keeps its address list in
   sync as users track and untrack wallets. Syncs are debounced because each
   edit costs 100 credits.
4. The log prints the webhook ID. Set `HELIUS_WEBHOOK_ID` to reuse it across deploys.

Deliveries are authenticated with a constant-time comparison of the
`Authorization` header, acknowledged immediately, and deduplicated by
signature. With webhooks on, polling continues at 5× the interval as a
reconciliation pass.

For local testing, a tunnel such as `cloudflared tunnel --url http://localhost:8080` gives you a temporary HTTPS URL.

---

## Free-tier budget

Helius credit costs, from [Helius billing docs](https://www.helius.dev/docs/billing/credits.md):
standard RPC calls such as `getBalance` and `getSignaturesForAddress` cost 1
credit; DAS and Parsed Events requests cost 10; webhook events cost 1; webhook
edits cost 100. The free plan includes 1M credits a month.

| Activity (defaults) | Cost | Per wallet/target per month |
|---|---|---|
| Wallet polling, every 120 s | 1 credit per poll, plus 10 only when new transactions exist | ≈ 21.6k + parsing |
| Holdings check, every 30 min | 10 credits (DAS) | ≈ 14.4k |
| Whale monitor, every 600 s | 10 credits (Parsed Events) | ≈ 43.2k |
| Portfolio snapshots, every 6 h | 10 credits (DAS) | ≈ 1.2k |
| Wallet profile (on demand, cached 90 s) | ~25 credits (DAS + Parsed Events + RPC) | — |
| DexScreener / GeckoTerminal | keyless; clients stay under the documented rate limits | — |

Example: 10 tracked wallets and 5 whale targets cost about 590k credits a
month before transaction parsing and on-demand lookups. That fits the free
plan with some headroom. With webhooks enabled, polling runs 5× less often,
which saves about 170k. If you get close to your limit, raise
`WHALE_POLL_INTERVAL_SEC`, `HOLDINGS_CHECK_INTERVAL_MIN` or
`WALLET_POLL_INTERVAL_SEC`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Invalid environment configuration: …` | The message lists each bad variable. Compare with `.env.example`; placeholders must be replaced |
| `Cannot reach Supabase or schema missing — did you run the migration?` | Check `SUPABASE_URL` / the service-role key, and apply the SQL migration |
| `401: Unauthorized` from Telegram at startup | Wrong `TELEGRAM_BOT_TOKEN`; copy it again from BotFather (`/token`) |
| `409: Conflict: terminated by other getUpdates request` | Another instance with the same token is running; stop it |
| "Solana RPC / Helius is rate limiting requests" | Free-tier limit reached; the client retries with backoff. Increase job intervals or upgrade the plan |
| Wallet profile shows "Transaction history is temporarily unavailable" | Parsed Events failed (key, plan or outage); balances and holdings still work |
| Token shows "No DEX trading pairs found" | The token has no pools on DexScreener (unlaunched, dead, or not a token mint) |
| No webhook notifications | Check `PUBLIC_WEBHOOK_URL` is reachable over HTTPS, the secret matches, and Helius dashboard webhook logs; polling still runs as a backup |
| Notifications stopped for a user | The user blocked the bot (marked `is_blocked`; re-enabled when they message it again), notifications are off, or quiet hours are active |
| Holder concentration fails | Public RPC doesn't allow `getTokenLargestAccounts` for large tokens; make sure Helius RPC is used (default) |

Set `LOG_LEVEL=debug` for detailed job and API logs; secrets stay redacted.

---

## Project structure

```
src/
  index.ts                 bootstrap, wiring, job scheduling, graceful shutdown
  config/env.ts            Zod environment validation
  clients/                 solanaRpc · helius (DAS, Parsed Events, webhooks) · dexscreener · geckoterminal
  services/                transactions (normaliser) · prices · tokenMetadata · container
  analytics/               wallet · token · trending · portfolio · patterns · stats · walletScore
  alerts/                  definitions (Zod params) · evaluator (pure) · notifier (dedupe, prefs)
  jobs/                    scheduler · walletActivity · walletPoller · holdingsMonitor ·
                           marketAlerts · whaleMonitor · snapshots
  webhooks/                HTTP server (/health, Helius receiver) · webhook manager
  db/                      Supabase client · users/wallets/alerts/market repositories · row types
  bot/                     bot.ts · context · keyboards · render (loading, pagination)
    middleware/            private-only, rate limit, user identification, timing
    commands/              slash commands
    callbacks/router.ts    inline-button routing
    flows/input.ts         text prompts + secret guard
    actions/               feature handlers (wallet, token, market, watchlists, alerts, settings)
    views/                 message renderers (HTML)
  validation/              addresses/base58 · user inputs · secret detection
  utils/                   http (retry/timeout) · logger (redaction) · rate limiter · cache · format · charts · errors
supabase/migrations/       SQL schema, indexes, RLS policies, retention function
tests/                     unit · db (PGlite + PostgREST boundary) · bot (grammY end to end) · fixtures
scripts/smoke.ts           live API smoke test
docs/METHODOLOGY.md        formulas, classifications and caveats
```

## License

MIT
