import { describe, expect, it, vi } from 'vitest';
import { DexScreenerClient } from '../../src/clients/dexscreener.js';
import { GeckoTerminalClient, parseCandles } from '../../src/clients/geckoterminal.js';
import { HeliusClient, parseEnvelopes } from '../../src/clients/helius.js';
import { SolanaRpcClient } from '../../src/clients/solanaRpc.js';
import { ApiError } from '../../src/utils/errors.js';
import { dexPair, JUP, jsonResponse, parsedFailedEnvelope, parsedSwapEnvelope, USDC_MINT, WALLET } from '../fixtures/index.js';

describe('DexScreener client', () => {
  it('batches up to 30 mints per request and drops malformed / non-Solana pairs', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return jsonResponse([dexPair({ base: JUP }), { chainId: 'ethereum', dexId: 'uni', pairAddress: '0x', baseToken: { address: '0x' }, quoteToken: { address: '0y' } }, { garbage: true }]);
    });
    const c = new DexScreenerClient('https://api.dexscreener.com', 5000, fetchImpl);
    const mints = Array.from({ length: 31 }, (_, i) => `${JUP.slice(0, -2)}${String(i).padStart(2, 'A')}`);
    const pairs = await c.getPairsForTokens(mints);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatch(/\/tokens\/v1\/solana\//);
    expect(urls[0]!.split('/').pop()!.split(',')).toHaveLength(30);
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.chainId === 'solana')).toBe(true);
  });

  it('handles search responses with missing pairs', async () => {
    const c = new DexScreenerClient('https://api.dexscreener.com', 5000, async () => jsonResponse({ schemaVersion: '1', pairs: null }));
    await expect(c.search('nothing')).resolves.toEqual([]);
  });

  it('surfaces rate limits as retryable errors', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 429, { 'retry-after': '0' }));
    const c = new DexScreenerClient('https://api.dexscreener.com', 5000, fetchImpl);
    await expect(c.getTokenPools(JUP)).rejects.toMatchObject({ name: 'RateLimitError' });
  });
});

describe('Helius client', () => {
  it('parses Parsed Events envelopes and skips parser errors', () => {
    const { items, skipped } = parseEnvelopes([
      parsedSwapEnvelope(),
      parsedFailedEnvelope(),
      { signature: 'x', parserStatus: 'ERROR', parserError: { code: 'UNSUPPORTED', message: 'nope' } },
      { signature: 'y', parserStatus: 'OK', parsed: { not: 'a tx' } },
      'garbage',
    ]);
    expect(items).toHaveLength(2);
    expect(skipped).toBe(3);
  });

  it('sends transaction-history as POST with a JSON body and api-key query param', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [parsedSwapEnvelope()], paginationToken: '1:0' }));
    const c = new HeliusClient('KEY123', 'https://mainnet.helius-rpc.com', 'https://rpc.test', 5000, fetchImpl);
    const page = await c.getTransactionHistory(WALLET, { limit: 500 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mainnet.helius-rpc.com/v1/parsed-events/transaction-history?api-key=KEY123');
    expect(JSON.parse(init.body as string)).toEqual({ address: WALLET, limit: 100, sortOrder: 'desc', tokenAccounts: 'balanceChanged' });
    expect(page.items).toHaveLength(1);
    expect(page.paginationToken).toBe('1:0');
  });

  it('accepts both array and {data} shapes from parse-transactions', async () => {
    const env = parsedSwapEnvelope();
    for (const body of [[env], { data: [env] }]) {
      const c = new HeliusClient('K', 'https://h.test', 'https://rpc.test', 5000, async () => jsonResponse(body));
      await expect(c.parseTransactions([env.signature])).resolves.toHaveLength(1);
    }
  });

  it('reads DAS holdings including native balance and pages until short page', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: {
          total: 2,
          items: [
            { id: USDC_MINT, interface: 'FungibleToken', content: { metadata: { symbol: 'USDC' } }, token_info: { balance: 12_500_000, decimals: 6, price_info: { price_per_token: 1 } } },
            { id: 'bad-item-without-fields' },
          ],
          nativeBalance: { lamports: 3_000_000_000 },
        },
      }),
    );
    const c = new HeliusClient('K', 'https://h.test', 'https://rpc.test', 5000, fetchImpl);
    const r = await c.getAssetsByOwner(WALLET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.nativeLamports).toBe(3_000_000_000);
    expect(r.items[0]?.token_info?.balance).toBe(12_500_000);
  });

  it('converts DAS JSON-RPC errors into ApiError', async () => {
    const c = new HeliusClient('K', 'https://h.test', 'https://rpc.test', 5000, async () => jsonResponse({ jsonrpc: '2.0', error: { code: -32602, message: 'invalid params' } }));
    await expect(c.getAssetsByOwner(WALLET)).rejects.toBeInstanceOf(ApiError);
    await expect(c.getAsset('x')).resolves.toBeNull();
  });
});

describe('Solana RPC client', () => {
  it('falls back to the secondary endpoint when the primary fails', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('primary')) return jsonResponse('down', 502);
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: 42 } });
    });
    const rpc = new SolanaRpcClient('https://primary.test', 'https://fallback.test', 2000, fetchImpl);
    await expect(rpc.getBalance(WALLET)).resolves.toBe(42);
    expect(calls.some((u) => u.includes('fallback'))).toBe(true);
  });

  it('does not fall back on invalid params (client error)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid param' } }));
    const rpc = new SolanaRpcClient('https://primary.test', 'https://fallback.test', 2000, fetchImpl);
    await expect(rpc.getBalance('bad')).rejects.toMatchObject({ status: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null mint info for non-mint accounts', async () => {
    const rpc = new SolanaRpcClient('https://p.test', null, 2000, async () =>
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { value: { owner: '11111111111111111111111111111111', data: ['', 'base64'] } } }),
    );
    await expect(rpc.getMintInfo(WALLET)).resolves.toBeNull();
  });

  it('parses mint authorities from jsonParsed account data', async () => {
    const rpc = new SolanaRpcClient('https://p.test', null, 2000, async () =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000', mintAuthority: null, freezeAuthority: WALLET } } } } },
      }),
    );
    await expect(rpc.getMintInfo(USDC_MINT)).resolves.toMatchObject({ decimals: 6, supplyRaw: '1000000000', mintAuthority: null, freezeAuthority: WALLET });
  });
});

describe('GeckoTerminal client', () => {
  it('parses and sorts OHLCV candles, skipping bad rows', () => {
    const c = parseCandles([
      [1700086400, '2', '3', '1', '2.5', '100'],
      [1700000000, 1, 2, 0.5, 1.5, 50],
      [1700172800, 'x', 1, 1, 1, 1],
      [1],
    ]);
    expect(c.map((x) => x.t)).toEqual([1700000000, 1700086400]);
    expect(c[1]).toEqual({ t: 1700086400, o: 2, h: 3, l: 1, c: 2.5, v: 100 });
  });

  it('returns [] for unknown pools (404)', async () => {
    const g = new GeckoTerminalClient('https://g.test', 2000, async () => jsonResponse({ errors: [] }, 404));
    await expect(g.getOhlcv('pool')).resolves.toEqual([]);
  });
});
