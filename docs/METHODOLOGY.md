# Methodology

This document explains how every derived figure is calculated, what the
data sources are, and what each metric does **not** mean. Nothing in this
bot predicts future prices or returns.

## Data provenance labels

| Label | Meaning | Sources |
|---|---|---|
| ✅ verified | Read directly from the Solana blockchain | Solana RPC (balances, mint accounts, signatures, token accounts), Helius DAS on-chain fields |
| 📈 market | Reported by a market-data provider | DexScreener (prices, liquidity, volume, market cap, FDV, trade counts), GeckoTerminal (historical candles) |
| 📐 estimate | Calculated by the bot from other figures | Portfolio value, calculated FDV, volatility, scores |
| ❔ unavailable | No source returned a value | — |

The bot never fills a missing value with a guess.

## Transaction classification

* A transaction is labelled **swap** only when Helius classified it as a swap
  (`summary.type = swap` in Parsed Events, or `type = SWAP` in webhooks).
* SOL/token movements that are not provider-classified swaps are **transfers**
  (incoming/outgoing relative to the wallet). Large transfers are still transfers.
* The bot never uses the words *buy*, *sell*, *purchase* or *sold* for wallet
  activity. DexScreener's pool-level "buys/sells" counts are shown only as
  "buy-side / sell-side swaps, per DexScreener".
* Raw RPC fallback data carries no classification; it is shown as balance
  changes, labelled "unclassified".
* Wallet-relative amounts use balance changes when the source provides them
  (webhook `accountData`, RPC pre/post balances), otherwise the transfer list.

## Wallet profile

* **SOL balance** — `getBalance` ✅.
* **Wallet age / transaction count** — `getSignaturesForAddress` is paged
  backwards (1,000 per page, up to `WALLET_HISTORY_MAX_PAGES`). If the end of
  history is reached, the first activity date and the count are exact;
  otherwise they are shown as lower bounds ("older than", "5,000+").
  This counts transactions that reference the wallet address itself.
* **Recent activity / flows / frequency** — computed over the latest 100
  transactions from Helius Parsed Events. Frequency = transactions ÷ days
  spanned (minimum 1 day).
* **Token acquisition history** — first *observed* inbound movement of each
  token inside the sampled window, with how it arrived (transfer / swap).
  Earlier acquisitions can exist outside the window.
* **Timeline** — events in the window that are swaps, move ≥ 1 SOL, are worth
  ≥ $100 at current prices, or are the first observed receipt of a token.

## Wallet Activity Score (0–100)

Describes observed activity. It is **not** a measure of skill, trust or
profitability.

| Component | Max | Formula |
|---|---|---|
| Frequency | 35 | 35 × min(1, log10(1 + tx/day) ÷ log10(51)) |
| Recency | 20 | ≤1 day: 20 · ≤7 days: 14 · ≤30 days: 8 · ≤90 days: 3 · older: 0 |
| Counterparties | 20 | 20 × min(1, log2(1 + unique counterparties) ÷ log2(51)) |
| Token breadth | 15 | 15 × min(1, distinct mints moved ÷ 20) |
| Longevity | 10 | min(10, age in days ÷ 36.5) — lower bound if age is not exact |

Labels: 0–20 Dormant, 21–40 Low, 41–60 Moderate, 61–80 Active, 81–100 Very active.
Logarithmic scaling keeps high-frequency bots from dominating.

## Prices and portfolio value

* Each token is priced from its **deepest DexScreener pool** (highest USD
  liquidity), preferring pools where the token is the base asset.
* Pools under **$1,000 liquidity** are shown but **excluded from valuation**
  (thin pools are easily manipulated). Helius DAS `price_info` is used only
  when DexScreener has no pool.
* **Estimated value** = on-chain balance × price. Unpriced tokens are counted
  separately and not included.

### Value change attribution

Between two snapshots:

* **Price effect** = Σ previous amount × (new price − old price)
* **Quantity effect** = Σ (new amount − previous amount) × new price

The quantity effect includes deposits, withdrawals, transfers and airdrops,
so neither figure is realised trading profit.

### Price exposure ("constant holdings")

Values the *current* balances of the largest holdings at past daily closes
(GeckoTerminal). This shows exposure to price moves only. It is not what the
wallet actually held or earned.

## Token analytics

* **Calculated FDV** = on-chain supply × price 📐, shown next to DexScreener's FDV 📈.
* **Liquidity / 24h volume** = sums across all pools where the token is the base asset (up to 30 pools from DexScreener `/token-pairs`).
* **Annualised volatility** = sample standard deviation of daily log returns × √365.
* **Max drawdown** = largest peak-to-trough decline across the daily closes.
* **Unusual volume** —
  * hourly: last-hour volume ÷ (24h volume ÷ 24) ≥ 3;
  * daily: z-score of the latest complete day's volume vs the previous days ≥ 2.5 (needs ≥ 8 days).
* **Holder concentration** — share of supply held by the 20 largest token
  **accounts** (`getTokenLargestAccounts`), plus HHI over those shares.
  Liquidity pools, exchanges, vesting contracts and burn addresses are
  included, and one owner can hold several accounts, so this is not a list
  of distinct holders.
* **Risk flags** — active mint authority, active freeze authority, mutable
  metadata, liquidity < $10K, primary pair < 24 h old, 24h volume > 50×
  liquidity.

## Trending explorer

DexScreener has no public "all tokens ranked" endpoint. Candidates come from
top boosts, latest boosts, latest token profiles and a pair search, and are
then enriched with live pair data and filtered/sorted locally. **Boosts are
paid promotions.** Trending status is never a recommendation.

Warnings: no market cap data, liquidity < $25K, pair < 24 h old, volume > 50×
liquidity, |24h change| > 80%, paid boost.

## Alerts

| Kind | Trigger |
|---|---|
| Wallet activity | New transaction of a tracked wallet matching direction and minimum SOL |
| Large transaction | Transfer / swap leg valued ≥ threshold at the current price (token: deepest pool; wallet: its own history) |
| Price movement | \|price − baseline\| ÷ baseline ≥ X%. The baseline is set at creation and reset after each trigger |
| Price target | Price crosses into the above/below zone (fires on crossing, not continuously) |
| Volume spike | Last-hour volume ≥ N × the 24h hourly average |
| Liquidity change | \|liquidity − baseline\| ÷ baseline ≥ X% |
| Token activity | Last-hour DEX trade count ≥ N × the 24h hourly average |

Each alert has a cooldown. Notifications are deduplicated with a unique
`(user, dedupe_key)` row reserved **before** sending.

## Holdings change notifications

Tracked wallets' balances are compared every `HOLDINGS_CHECK_INTERVAL_MIN`:

* changed: |Δ| ≥ the user's threshold percentage (default 25%);
* new token: only if it has a reliable price and ≥ $10 value (filters spam airdrops);
* removed: only if the previous balance was worth ≥ $10, or it was SOL.
