import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { WalletActivityProcessor } from '../jobs/walletActivity.js';
import { enhancedTxSchema, normalizeEnhanced, type NormalizedTx } from '../services/transactions.js';
import { TtlCache } from '../utils/cache.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('http-server');

const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const HELIUS_WEBHOOK_PATH = '/webhooks/helius';

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Every address that a normalised transaction touches. */
export function involvedAddresses(tx: NormalizedTx): Set<string> {
  const s = new Set<string>();
  if (tx.feePayer) s.add(tx.feePayer);
  for (const t of tx.nativeTransfers) {
    if (t.from) s.add(t.from);
    if (t.to) s.add(t.to);
  }
  for (const t of tx.tokenTransfers) {
    if (t.from) s.add(t.from);
    if (t.to) s.add(t.to);
  }
  for (const c of tx.nativeChanges ?? []) s.add(c.account);
  for (const c of tx.tokenChanges ?? []) s.add(c.owner);
  return s;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export interface HttpServerDeps {
  port: number;
  webhookSecret: string | undefined;
  processor: WalletActivityProcessor;
  monitoredAddresses: () => Promise<string[]>;
}

/**
 * HTTP server exposing:
 *   GET  /health            → liveness probe for hosting platforms
 *   POST /webhooks/helius   → Helius enhanced webhook deliveries
 * Deliveries are acknowledged immediately (Helius retries non-2xx for 24h)
 * and processed asynchronously; duplicates are dropped by the
 * (wallet_address, signature) unique key.
 */
export class HttpServer {
  private server: Server | null = null;
  private readonly monitoredCache = new TtlCache<Set<string>>(30_000, 1);
  private pending = new Set<Promise<void>>();
  private readonly startedAt = Date.now();

  constructor(private readonly d: HttpServerDeps) {}

  start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    return new Promise((resolve) => this.server!.listen(this.d.port, () => {
      log.info('http server listening', { port: this.d.port });
      resolve();
    }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) }));
      return;
    }
    if (req.method === 'POST' && url.pathname === HELIUS_WEBHOOK_PATH) {
      if (!this.d.webhookSecret || !safeEqual(req.headers.authorization ?? '', this.d.webhookSecret)) {
        res.writeHead(401).end();
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(200).end();
      const job = this.processPayload(payload).catch((err) => log.error('webhook processing failed', { error: err as Error }));
      this.pending.add(job);
      void job.finally(() => this.pending.delete(job));
      return;
    }
    res.writeHead(404).end();
  }

  async processPayload(payload: unknown): Promise<void> {
    const items = Array.isArray(payload) ? payload : [payload];
    const monitored = await this.monitoredCache.getOrLoad('set', async () => new Set(await this.d.monitoredAddresses()));
    const byAddress = new Map<string, NormalizedTx[]>();
    for (const raw of items) {
      const parsed = enhancedTxSchema.safeParse(raw);
      if (!parsed.success) continue;
      const tx = normalizeEnhanced(parsed.data);
      for (const addr of involvedAddresses(tx)) {
        if (!monitored.has(addr)) continue;
        const list = byAddress.get(addr) ?? [];
        list.push(tx);
        byAddress.set(addr, list);
      }
    }
    for (const [addr, txs] of byAddress) await this.d.processor.process(addr, txs);
  }

  invalidateMonitored(): void {
    this.monitoredCache.delete('set');
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await Promise.allSettled([...this.pending]);
  }
}
