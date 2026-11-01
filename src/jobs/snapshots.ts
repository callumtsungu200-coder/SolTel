import { priceHoldings, summarize } from '../analytics/portfolio.js';
import type { WalletIntelService } from '../analytics/wallet.js';
import type { SnapshotRow } from '../db/types.js';
import type { WalletsRepo } from '../db/walletsRepo.js';
import type { PriceService } from '../services/prices.js';
import { createLogger } from '../utils/logger.js';
import { WSOL_MINT } from '../validation/address.js';
import { mapLimit } from './scheduler.js';

const log = createLogger('snapshots');

/** Takes portfolio snapshots (balances × prices at that moment) of tracked wallets. */
export class SnapshotService {
  constructor(
    private readonly wallets: WalletsRepo,
    private readonly walletIntel: WalletIntelService,
    private readonly prices: PriceService,
  ) {}

  async capture(address: string): Promise<SnapshotRow> {
    const balances = await this.walletIntel.getBalances(address);
    const mints = [...balances.tokens].sort((a, b) => b.amount - a.amount).slice(0, 150).map((t) => t.mint);
    const quotes = await this.prices.getQuotes([WSOL_MINT, ...mints]);
    const solPrice = quotes.get(WSOL_MINT)?.priceUsd ?? null;
    const holdings = priceHoldings(balances.tokens, quotes);
    const s = summarize(balances.sol, solPrice, holdings);
    const row: SnapshotRow = {
      wallet_address: address,
      sol_balance: balances.sol,
      sol_price_usd: solPrice,
      tokens_value_usd: s.tokensValueUsd,
      total_value_usd: s.totalValueUsd,
      priced_count: s.pricedCount,
      unpriced_count: s.unpricedCount,
      // Keep snapshots compact: priced holdings plus the 20 largest unpriced balances.
      holdings: [...holdings.filter((h) => h.valueUsd !== null), ...holdings.filter((h) => h.valueUsd === null).slice(0, 20)].map((h) => ({
        mint: h.mint,
        symbol: h.symbol,
        amount: h.amount,
        priceUsd: h.reliable ? h.priceUsd : null,
      })),
    };
    await this.wallets.insertSnapshot(row);
    return row;
  }

  /** Captures a snapshot unless a recent one (younger than `maxAgeMs`) exists. */
  async ensureRecent(address: string, maxAgeMs = 60 * 60_000): Promise<void> {
    const latest = (await this.wallets.snapshots(address, 1))[0];
    if (latest?.taken_at && Date.now() - Date.parse(latest.taken_at) < maxAgeMs) return;
    await this.capture(address);
  }

  async runOnce(): Promise<void> {
    const addresses = await this.wallets.distinctAddresses();
    const results = await mapLimit(addresses, 2, (a) => this.capture(a));
    const failed = results.filter((r) => !r.ok).length;
    log.info('snapshots captured', { total: addresses.length, failed });
  }
}
