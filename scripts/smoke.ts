/**
 * Live integration smoke test against the real APIs.
 *
 *   npm run smoke
 *
 * Keyless services (DexScreener, GeckoTerminal, public Solana RPC) are always
 * exercised. Helius checks run only when HELIUS_API_KEY is set. Nothing is
 * written anywhere; no Telegram or Supabase access is needed.
 */
import 'dotenv/config';
import { buildTimeline, computeAcquisitions, computeStats, scanSignatureHistory } from '../src/analytics/wallet.js';
import { assembleTokenReport, computeConcentration } from '../src/analytics/token.js';
import { TrendingService } from '../src/analytics/trending.js';
import { DexScreenerClient } from '../src/clients/dexscreener.js';
import { GeckoTerminalClient } from '../src/clients/geckoterminal.js';
import { HeliusClient } from '../src/clients/helius.js';
import { SolanaRpcClient } from '../src/clients/solanaRpc.js';
import { PriceService } from '../src/services/prices.js';
import { normalizeParsedEvent, normalizeRpcTx, walletView } from '../src/services/transactions.js';
import { formatUsd } from '../src/utils/format.js';
import { registerSecrets } from '../src/utils/logger.js';
import { USDC_MINT, WSOL_MINT } from '../src/validation/address.js';

// A long-lived public wallet (Solana Labs "vines" demo address) and USDC.
const WALLET = process.env.SMOKE_WALLET ?? 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
const TOKEN = process.env.SMOKE_TOKEN ?? 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

let failures = 0;
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const t = Date.now();
  try {
    const detail = await fn();
    console.log(`✅ ${name} (${Date.now() - t} ms) — ${detail}`);
  } catch (err) {
    failures++;
    console.log(`❌ ${name} (${Date.now() - t} ms) — ${(err as Error).message}`);
  }
}

async function main() {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (heliusKey) registerSecrets([heliusKey]);
  const publicRpc = process.env.SOLANA_FALLBACK_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
  const rpcUrl = heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : publicRpc;
  const rpc = new SolanaRpcClient(rpcUrl, heliusKey ? publicRpc : null, 20_000);
  const dex = new DexScreenerClient('https://api.dexscreener.com', 20_000);
  const gecko = new GeckoTerminalClient('https://api.geckoterminal.com/api/v2', 20_000);
  const prices = new PriceService(dex);

  console.log(`Helius: ${heliusKey ? 'enabled' : 'skipped (no HELIUS_API_KEY)'}\n`);

  await check('RPC getBalance', async () => `${(await rpc.getBalance(WALLET)) / 1e9} SOL`);
  await check('RPC signature scan (age / count)', async () => {
    const age = await scanSignatureHistory(rpc, WALLET, 2);
    return `${age.signatureCount}${age.countExact ? '' : '+'} signatures, first seen ${age.firstSeen ? new Date(age.firstSeen * 1000).toISOString() : 'n/a'} (exact=${age.exact})`;
  });
  await check('RPC getTransaction + RPC normaliser', async () => {
    const [sig] = await rpc.getSignaturesForAddress(WALLET, { limit: 1 });
    if (!sig) return 'no signatures';
    const raw = await rpc.getTransaction(sig.signature);
    if (!raw) throw new Error('transaction not returned');
    const v = walletView(normalizeRpcTx(sig.signature, raw), WALLET);
    return `${v.category}/${v.direction}, net ${v.solNet.toFixed(6)} SOL, ${v.tokensIn.length + v.tokensOut.length} token changes`;
  });
  await check('RPC mint info (USDC)', async () => {
    const m = await rpc.getMintInfo(USDC_MINT);
    if (!m) throw new Error('mint not parsed');
    return `decimals ${m.decimals}, mint authority ${m.mintAuthority ? 'active' : 'revoked'}, freeze ${m.freezeAuthority ? 'active' : 'revoked'}`;
  });
  await check('RPC mint info for a wallet returns null', async () => {
    const m = await rpc.getMintInfo(WALLET);
    if (m !== null) throw new Error('wallet misdetected as mint');
    return 'null as expected';
  });
  // Public mainnet RPC rejects getTokenLargestAccounts for large mints; Helius RPC supports it.
  if (heliusKey) await check('RPC holder concentration', async () => {
    const [supply, largest] = await Promise.all([rpc.getTokenSupply(TOKEN), rpc.getTokenLargestAccounts(TOKEN)]);
    const owners = await rpc.getTokenAccountOwners(largest.slice(0, 20).map((a) => a.address));
    const c = computeConcentration(TOKEN, supply.uiAmount, largest, owners);
    return c ? `top10 ${c.top10Pct.toFixed(2)}%, owners resolved ${owners.size}/20` : 'unavailable';
  });

  await check('DexScreener SOL price', async () => formatUsd(await prices.getSolPrice()));
  await check('DexScreener batched quotes', async () => {
    const q = await prices.getQuotes([WSOL_MINT, USDC_MINT, TOKEN]);
    return [...q.values()].map((x) => `${x.symbol}=${x.priceUsd.toPrecision(5)} (${x.side}, liq ${formatUsd(x.liquidityUsd)})`).join(', ');
  });
  let candlesPool = '';
  await check('Token report assembly (DexScreener + RPC + GeckoTerminal)', async () => {
    const pairs = await prices.getPairs(TOKEN);
    const mintInfo = await rpc.getMintInfo(TOKEN);
    const primary = pairs.filter((p) => p.baseToken.address === TOKEN).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    candlesPool = primary?.pairAddress ?? '';
    const candles = primary ? await gecko.getOhlcv(primary.pairAddress, 'day', 31) : [];
    const r = assembleTokenReport({ mint: TOKEN, pairs, meta: null, mintInfo, candles });
    return `${r.symbol.value} price ${r.priceUsd.value} | liq ${formatUsd(r.liquidityUsd.value)} | ${r.pairCount} pools | ${candles.length} candles | vol ${r.history?.volatilityAnnualized?.toFixed(0)}%/yr | warnings: ${r.warnings.length}`;
  });
  await check('GeckoTerminal unknown pool → []', async () => {
    const c = await gecko.getOhlcv('11111111111111111111111111111111', 'day', 5);
    return `${c.length} candles`;
  });
  await check('Trending universe', async () => {
    const t = new TrendingService(dex);
    const list = await t.explore({ sort: 'volume', minLiquidityUsd: 10_000, minVolumeUsd: 10_000 });
    return `${list.length} tokens after filters; top: ${list.slice(0, 3).map((x) => `${x.symbol} ${formatUsd(x.volume24h)}`).join(', ')}`;
  });
  void candlesPool;

  if (heliusKey) {
    const helius = new HeliusClient(heliusKey, 'https://mainnet.helius-rpc.com', rpcUrl, 20_000);
    await check('Helius DAS getAssetsByOwner', async () => {
      const r = await helius.getAssetsByOwner(WALLET, 1);
      return `${r.items.length} assets, native ${r.nativeLamports}`;
    });
    await check('Helius DAS getAssetBatch', async () => {
      const r = await helius.getAssetBatch([USDC_MINT, TOKEN]);
      return r.map((a) => a.content?.metadata?.symbol).join(', ');
    });
    await check('Helius Parsed Events history + wallet analytics', async () => {
      const page = await helius.getTransactionHistory(WALLET, { limit: 50 });
      const views = page.items.map((i) => walletView(normalizeParsedEvent(i), WALLET));
      const stats = computeStats(views);
      const acq = computeAcquisitions(views);
      const tl = buildTimeline(views, acq, null, new Map());
      return `${page.items.length} tx (skipped ${page.skipped}), ${stats.txPerDay.toFixed(2)} tx/day, ${acq.length} acquisitions, ${tl.length} timeline events`;
    });
    await check('Helius parse signatures', async () => {
      const [sig] = await rpc.getSignaturesForAddress(WALLET, { limit: 1 });
      if (!sig) return 'no signatures';
      const parsed = await helius.parseTransactions([sig.signature]);
      return `${parsed.length} parsed, type ${parsed[0] ? normalizeParsedEvent(parsed[0]).type : 'n/a'}`;
    });
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
