/**
 * Rate limiting primitives.
 *
 * - `TokenBucket`: classic token bucket, used both for outbound API budgets
 *   (await `take()`) and inbound per-user command limits (`tryTake()`).
 * - `KeyedRateLimiter`: one bucket per key (e.g. Telegram user id) with
 *   periodic eviction of idle buckets.
 */

export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
      this.last = t;
    }
  }

  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }

  /** Milliseconds until `n` tokens are available. */
  waitTimeMs(n = 1): number {
    this.refill();
    if (this.tokens >= n) return 0;
    return Math.ceil(((n - this.tokens) / this.refillPerSec) * 1000);
  }

  /** Resolves once a token has been consumed (FIFO). */
  take(): Promise<void> {
    if (this.queue.length === 0 && this.tryTake()) return Promise.resolve();
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(5, this.waitTimeMs());
    this.timer = setTimeout(() => {
      this.timer = null;
      while (this.queue.length > 0 && this.tryTake()) this.queue.shift()?.();
      if (this.queue.length > 0) this.schedule();
    }, wait);
    this.timer.unref?.();
  }
}

export class KeyedRateLimiter {
  private buckets = new Map<string, { bucket: TokenBucket; seen: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  tryTake(key: string): boolean {
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.capacity, this.refillPerSec, this.now), seen: this.now() };
      this.buckets.set(key, entry);
    }
    entry.seen = this.now();
    if (this.buckets.size > 10_000) this.evict();
    return entry.bucket.tryTake();
  }

  retryAfterMs(key: string): number {
    return this.buckets.get(key)?.bucket.waitTimeMs() ?? 0;
  }

  private evict(): void {
    const cutoff = this.now() - 10 * 60_000;
    for (const [k, v] of this.buckets) if (v.seen < cutoff) this.buckets.delete(k);
  }
}
