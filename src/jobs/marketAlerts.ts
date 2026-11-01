import { MARKET_ALERT_KINDS } from '../alerts/definitions.js';
import { evaluateMarketAlert, type MarketSnapshot } from '../alerts/evaluator.js';
import type { Notifier } from '../alerts/notifier.js';
import type { DexPair, DexScreenerClient } from '../clients/dexscreener.js';
import type { AlertsRepo } from '../db/alertsRepo.js';
import type { MarketRepo } from '../db/marketRepo.js';
import type { WalletsRepo } from '../db/walletsRepo.js';
import type { PriceHistoryRow } from '../db/types.js';
import { liquidityOf } from '../services/prices.js';
import { link, solscanToken } from '../utils/format.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('market-alerts');

/** Aggregates all base-side pools of each mint into one market snapshot. Pure. */
export function buildMarketSnapshots(mints: string[], pairs: DexPair[]): Map<string, MarketSnapshot> {
  const out = new Map<string, MarketSnapshot>();
  for (const mint of mints) {
    const list = pairs.filter((p) => p.baseToken.address === mint).sort((a, b) => liquidityOf(b) - liquidityOf(a));
    if (list.length === 0) continue;
    const best = list[0]!;
    const sum = (f: (p: DexPair) => number | null | undefined) => list.reduce((s, p) => s + (f(p) ?? 0), 0);
    out.set(mint, {
      mint,
      priceUsd: best.priceUsd ? Number(best.priceUsd) : null,
      liquidityUsd: sum(liquidityOf),
      volume1h: sum((p) => p.volume?.h1),
      volume24h: sum((p) => p.volume?.h24),
      txns1h: sum((p) => (p.txns?.h1?.buys ?? 0) + (p.txns?.h1?.sells ?? 0)),
      txns24h: sum((p) => (p.txns?.h24?.buys ?? 0) + (p.txns?.h24?.sells ?? 0)),
    });
  }
  return out;
}

/**
 * Polls DexScreener for every mint referenced by an active market alert or a
 * watchlist, records price history (at most every 10 minutes per mint) and
 * evaluates alerts. One DexScreener request covers 30 mints.
 */
export class MarketAlertJob {
  private lastRecorded = new Map<string, number>();

  constructor(
    private readonly dex: DexScreenerClient,
    private readonly alerts: AlertsRepo,
    private readonly wallets: WalletsRepo,
    private readonly market: MarketRepo,
    private readonly notifier: Notifier,
    private readonly recordEveryMs = 10 * 60_000,
  ) {}

  async runOnce(now = Date.now()): Promise<void> {
    const [active, watchMints] = await Promise.all([this.alerts.listActive(MARKET_ALERT_KINDS), this.wallets.watchlistMints()]);
    const alertMints = active.map((a) => String((a.params as { mint?: string }).mint ?? '')).filter(Boolean);
    const mints = [...new Set([...alertMints, ...watchMints])];
    if (mints.length === 0) return;

    const pairs = await this.dex.getPairsForTokens(mints);
    const snaps = buildMarketSnapshots(mints, pairs);

    const history: PriceHistoryRow[] = [];
    for (const s of snaps.values()) {
      if (s.priceUsd === null) continue;
      if (now - (this.lastRecorded.get(s.mint) ?? 0) < this.recordEveryMs) continue;
      this.lastRecorded.set(s.mint, now);
      history.push({
        mint: s.mint,
        price_usd: s.priceUsd,
        liquidity_usd: s.liquidityUsd,
        volume_24h: s.volume24h,
        volume_1h: s.volume1h,
        market_cap: pairs.find((p) => p.baseToken.address === s.mint)?.marketCap ?? null,
        fdv: pairs.find((p) => p.baseToken.address === s.mint)?.fdv ?? null,
        txns_1h: s.txns1h,
        source: 'dexscreener',
      });
    }
    await this.market.insertPrices(history).catch((err) => log.warn('price history insert failed', { error: (err as Error).message }));

    let triggered = 0;
    for (const alert of active) {
      const mint = String((alert.params as { mint?: string }).mint ?? '');
      const snap = snaps.get(mint);
      if (!snap) continue;
      const ev = evaluateMarketAlert(alert, snap, now);
      if (ev.triggered && ev.message && ev.dedupeKey) {
        const result = await this.notifier.notify({
          userId: alert.user_id,
          telegramId: alert.telegramId,
          alertId: alert.id,
          kind: alert.kind,
          dedupeKey: ev.dedupeKey,
          text: `${ev.message}\n${link(solscanToken(mint), 'Token on Solscan')}\n<i>Market data: DexScreener. Not financial advice.</i>`,
        });
        await this.alerts.saveState(alert.id, ev.state, result === 'sent' || result === 'quiet', alert.trigger_count + 1);
        triggered++;
      } else if (JSON.stringify(ev.state) !== JSON.stringify(alert.state)) {
        await this.alerts.saveState(alert.id, ev.state, false);
      }
    }
    log.debug('market alerts evaluated', { mints: mints.length, alerts: active.length, triggered });
  }
}
