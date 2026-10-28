import { UserError } from "../security";

/** Bounded FIFO admission. A failed task always releases its slot. */
export class WorkQueue {
  private active = 0;
  private peak = 0;
  private closed = false;
  private queue: { start: () => void; reject: (error: Error) => void }[] = [];
  constructor(
    readonly concurrency = 4,
    readonly maxQueued = 256,
  ) {
    if (
      !Number.isInteger(concurrency) ||
      concurrency < 1 ||
      !Number.isInteger(maxQueued) ||
      maxQueued < 0
    )
      throw new Error("Invalid queue limits");
  }
  run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new UserError("Work queue is closed"));
    if (this.active >= this.concurrency && this.queue.length >= this.maxQueued)
      return Promise.reject(
        new UserError("Work queue is full; retry after existing jobs finish"),
      );
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.active++;
        this.peak = Math.max(this.peak, this.active);
        void Promise.resolve()
          .then(action)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.drain();
          });
      };
      this.queue.push({ start, reject });
      this.drain();
    });
  }
  private drain() {
    while (!this.closed && this.active < this.concurrency && this.queue.length)
      this.queue.shift()!.start();
  }
  stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      peak: this.peak,
      concurrency: this.concurrency,
      maxQueued: this.maxQueued,
    };
  }
  close() {
    this.closed = true;
    for (const task of this.queue.splice(0))
      task.reject(new UserError("Work queue is closed"));
  }
}
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  action: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("Invalid concurrency limit");
  const result: R[] = new Array(items.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!failed && cursor < items.length) {
        const index = cursor++;
        try {
          result[index] = await action(items[index], index);
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    }),
  );
  if (failed) throw failure;
  return result;
}
/** Shared connections are locked in a stable order to avoid cross-group races/deadlocks. */
export class SyncCoordinator {
  private locks = new Map<string, Promise<void>>();
  private pending = 0;
  private closed = false;
  readonly queue: WorkQueue;
  constructor(
    concurrency = 4,
    readonly maxPending = 256,
  ) {
    this.queue = new WorkQueue(concurrency, maxPending);
  }
  async run<T>(
    connections: readonly string[],
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new UserError("Sync runtime is closing");
    if (this.pending >= this.maxPending)
      throw new UserError(
        "Sync queue is full; retry after existing groups finish",
      );
    this.pending++;
    const releases: (() => void)[] = [];
    try {
      for (const id of [...new Set(connections)].sort()) {
        const before = this.locks.get(id) ?? Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const tail = before.then(() => held);
        this.locks.set(id, tail);
        await before;
        releases.push(() => {
          release();
          if (this.locks.get(id) === tail) this.locks.delete(id);
        });
        if (this.closed) throw new UserError("Sync runtime is closing");
      }
      return await this.queue.run(action);
    } finally {
      releases.reverse().forEach((release) => release());
      this.pending--;
    }
  }
  stats() {
    return {
      ...this.queue.stats(),
      pending: this.pending,
      lockedConnections: this.locks.size,
      maxPending: this.maxPending,
    };
  }
  close() {
    this.closed = true;
    this.queue.close();
  }
}
export interface TimerClock {
  now(): number;
  setTimeout(action: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
}
export const systemClock: TimerClock = {
  now: Date.now,
  setTimeout: (fn, delay) => setTimeout(fn, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};
interface Schedule {
  id: string;
  intervalMinutes: number;
  enabled: boolean;
}
interface Entry {
  interval: number;
  timer?: unknown;
  nextAt: number | null;
  cancelled: boolean;
}
/** Stable startup staggering; the next interval begins after completion, never during it. */
export class StaggeredScheduler {
  private entries = new Map<string, Entry>();
  constructor(
    private readonly run: (id: string) => Promise<unknown>,
    private readonly clock: TimerClock = systemClock,
    private readonly onError?: (id: string, error: unknown) => void,
  ) {}
  configure(groups: readonly Schedule[]) {
    const wanted = new Set(groups.filter((g) => g.enabled).map((g) => g.id));
    for (const id of this.entries.keys()) if (!wanted.has(id)) this.stop(id);
    for (const group of groups.filter((g) => g.enabled)) {
      const interval = group.intervalMinutes * 60000;
      if (
        !Number.isSafeInteger(interval) ||
        interval < 60000 ||
        interval > 604800000
      )
        throw new UserError("Invalid scheduling interval");
      if (this.entries.get(group.id)?.interval === interval) continue;
      this.stop(group.id);
      const entry: Entry = { interval, nextAt: null, cancelled: false };
      this.entries.set(group.id, entry);
      let hash = 2166136261;
      for (const char of group.id)
        hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      const schedule = (delay: number) => {
        entry.nextAt = this.clock.now() + delay;
        entry.timer = this.clock.setTimeout(() => {
          entry.nextAt = null;
          void Promise.resolve()
            .then(() => this.run(group.id))
            .catch((error) => this.onError?.(group.id, error))
            .finally(() => {
              if (!entry.cancelled) schedule(interval);
            });
        }, delay);
      };
      schedule(1000 + ((hash >>> 0) % Math.max(1, interval - 1000)));
    }
  }
  status() {
    return [...this.entries].map(([id, entry]) => ({
      id,
      nextRunAt: entry.nextAt,
      intervalMs: entry.interval,
    }));
  }
  stop(id: string) {
    const entry = this.entries.get(id);
    if (entry) {
      entry.cancelled = true;
      if (entry.timer !== undefined) this.clock.clearTimeout(entry.timer);
      this.entries.delete(id);
    }
  }
  stopAll() {
    for (const id of this.entries.keys()) this.stop(id);
  }
}
