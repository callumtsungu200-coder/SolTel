import type { HeliusClient } from '../clients/helius.js';
import type { SolanaRpcClient } from '../clients/solanaRpc.js';
import type { WalletsRepo } from '../db/walletsRepo.js';
import { normalizeParsedEvent, normalizeRpcTx, type NormalizedTx } from '../services/transactions.js';
import { createLogger } from '../utils/logger.js';
import { mapLimit } from './scheduler.js';
import type { WalletActivityProcessor } from './walletActivity.js';

const log = createLogger('wallet-poller');

/**
 * Polling fallback for wallet monitoring (also a reconciliation pass when
 * webhooks are active).
 *
 * Per monitored address and interval:
 *   1. getSignaturesForAddress(until = last seen signature)   — 1 RPC credit
 *   2. only if there are new signatures: parse them with Helius Parsed
 *      Events (10 credits per ≤100 signatures); falls back to raw RPC
 *      getTransaction when Helius is unavailable
 *   3. hand off to WalletActivityProcessor (dedupe + notify)
 *
 * The first poll of a new address only records the cursor, so users are not
 * flooded with historical transactions.
 *
 * Limitation: getSignaturesForAddress(wallet) lists transactions that
 * reference the wallet account itself. Incoming SPL transfers into an
 * already-existing token account may not reference the owner; those are
 * caught by the holdings-change monitor instead.
 */
export class WalletPoller {
  constructor(
    private readonly rpc: SolanaRpcClient,
    private readonly helius: HeliusClient,
    private readonly wallets: WalletsRepo,
    private readonly processor: WalletActivityProcessor,
    private readonly maxPerPoll = 25,
  ) {}

  async runOnce(): Promise<void> {
    const monitors = await this.wallets.listMonitors();
    if (monitors.length === 0) return;
    const results = await mapLimit(monitors, 3, (m) => this.pollAddress(m.address, m.last_signature));
    const failed = results.filter((r) => !r.ok).length;
    if (failed) log.warn('some addresses failed to poll', { failed, total: monitors.length });
  }

  async pollAddress(address: string, lastSignature: string | null): Promise<void> {
    const sigs = await this.rpc.getSignaturesForAddress(address, { until: lastSignature ?? undefined, limit: lastSignature ? this.maxPerPoll : 1 });
    const newest = sigs[0];
    if (!lastSignature) {
      await this.wallets.updateCursor(address, newest?.signature ?? null, newest?.slot ?? null);
      return;
    }
    if (sigs.length === 0) {
      await this.wallets.updateCursor(address, null, null);
      return;
    }
    const txs = await this.fetchParsed(sigs.map((s) => s.signature));
    await this.processor.process(address, txs);
    await this.wallets.updateCursor(address, newest!.signature, newest!.slot);
  }

  private async fetchParsed(signatures: string[]): Promise<NormalizedTx[]> {
    try {
      const items = await this.helius.parseTransactions(signatures);
      if (items.length > 0 || signatures.length === 0) return items.map(normalizeParsedEvent);
    } catch (err) {
      log.warn('Helius parse failed, falling back to RPC', { error: (err as Error).message });
    }
    const out: NormalizedTx[] = [];
    for (const sig of signatures) {
      const tx = await this.rpc.getTransaction(sig).catch(() => null);
      if (tx) out.push(normalizeRpcTx(sig, tx));
    }
    return out;
  }
}
