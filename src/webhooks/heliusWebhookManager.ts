import type { HeliusClient } from '../clients/helius.js';
import type { WalletsRepo } from '../db/walletsRepo.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('webhook-manager');

/**
 * Keeps one Helius "enhanced" webhook whose accountAddresses equal the set of
 * monitored addresses. Edits cost 100 credits each, so syncs are debounced
 * and skipped when the address set is unchanged.
 */
export class HeliusWebhookManager {
  private webhookId: string | null;
  private lastSynced = '';
  private timer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;

  constructor(
    private readonly helius: HeliusClient,
    private readonly wallets: WalletsRepo,
    private readonly webhookUrl: string,
    private readonly authHeader: string,
    configuredId: string | undefined,
    private readonly debounceMs = 20_000,
  ) {
    this.webhookId = configuredId ?? null;
  }

  /** Schedules a debounced sync (called after wallets are added/removed). */
  requestSync(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sync();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync()
      .catch((err) => log.error('webhook sync failed', { error: err as Error }))
      .finally(() => {
        this.syncing = null;
      });
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const addresses = (await this.wallets.distinctAddresses()).sort();
    const fingerprint = addresses.join(',');
    if (fingerprint === this.lastSynced && this.webhookId) return;

    if (!this.webhookId) {
      const existing = (await this.helius.listWebhooks()).find((w) => w.webhookURL === this.webhookUrl);
      if (existing) this.webhookId = existing.webhookID;
    }
    if (addresses.length === 0 && !this.webhookId) {
      this.lastSynced = fingerprint;
      return; // Helius requires at least one address to create a webhook.
    }
    // Helius rejects an empty address list; a burn address placeholder keeps the webhook valid but silent.
    const accountAddresses = addresses.length > 0 ? addresses : ['1nc1nerator11111111111111111111111111111111'];
    const input = { webhookURL: this.webhookUrl, accountAddresses, authHeader: this.authHeader };
    if (this.webhookId) {
      await this.helius.updateWebhook(this.webhookId, input);
      log.info('webhook updated', { addresses: addresses.length });
    } else {
      const created = await this.helius.createWebhook(input);
      this.webhookId = created.webhookID;
      log.info('webhook created — set HELIUS_WEBHOOK_ID to reuse it', { webhookId: created.webhookID, addresses: addresses.length });
    }
    this.lastSynced = fingerprint;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
