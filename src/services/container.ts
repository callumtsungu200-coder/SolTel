import type { Notifier } from '../alerts/notifier.js';
import type { TokenIntelService } from '../analytics/token.js';
import type { TrendingService } from '../analytics/trending.js';
import type { WalletIntelService } from '../analytics/wallet.js';
import type { DexScreenerClient } from '../clients/dexscreener.js';
import type { GeckoTerminalClient } from '../clients/geckoterminal.js';
import type { HeliusClient } from '../clients/helius.js';
import type { SolanaRpcClient } from '../clients/solanaRpc.js';
import type { AppConfig } from '../config/env.js';
import type { AlertsRepo } from '../db/alertsRepo.js';
import type { MarketRepo } from '../db/marketRepo.js';
import type { UsersRepo } from '../db/usersRepo.js';
import type { WalletsRepo } from '../db/walletsRepo.js';
import type { SnapshotService } from '../jobs/snapshots.js';
import type { PriceService } from './prices.js';
import type { TokenMetadataService } from './tokenMetadata.js';

/** Dependency container handed to the bot layer. Built once in src/index.ts. */
export interface AppServices {
  config: Pick<AppConfig, 'MAX_TRACKED_WALLETS_PER_USER' | 'MAX_ALERTS_PER_USER' | 'useWebhooks'>;
  rpc: SolanaRpcClient;
  helius: HeliusClient;
  dex: DexScreenerClient;
  gecko: GeckoTerminalClient;
  prices: PriceService;
  metadata: TokenMetadataService;
  walletIntel: WalletIntelService;
  tokenIntel: TokenIntelService;
  trending: TrendingService;
  users: UsersRepo;
  wallets: WalletsRepo;
  alerts: AlertsRepo;
  market: MarketRepo;
  snapshots: SnapshotService;
  notifier: Notifier;
  /** Called after tracked wallets change (webhook address sync). */
  onWalletsChanged: () => void;
}
