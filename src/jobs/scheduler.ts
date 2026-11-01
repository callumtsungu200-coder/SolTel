import { createLogger } from '../utils/logger.js';

const log = createLogger('scheduler');

/**
 * Interval job runner:
 *  - never runs the same job concurrently (a slow run delays the next one)
 *  - first run is delayed by a random jitter so jobs don't stampede at boot
 *  - `stop()` waits for an in-flight run to finish (graceful shutdown)
 */
export class IntervalJob {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly fn: () => Promise<void>,
    private readonly initialDelayMs = Math.floor(Math.random() * 10_000) + 2_000,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(this.initialDelayMs);
    log.info('job scheduled', { job: this.name, everySec: Math.round(this.intervalMs / 1000) });
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  /** Runs the job now unless it is already running. */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    const started = Date.now();
    this.running = this.fn()
      .catch((err) => log.error('job failed', { job: this.name, error: err as Error }))
      .finally(() => {
        this.running = null;
        log.debug('job finished', { job: this.name, ms: Date.now() - started });
      });
    await this.running;
    this.schedule(this.intervalMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.running) await this.running;
  }
}

/** Runs async tasks with bounded concurrency. Errors are returned, not thrown. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: unknown }> = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i]!) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
