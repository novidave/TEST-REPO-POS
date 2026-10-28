import { UserError } from "../security";
import { WorkQueue } from "./runtime";
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: "WooCommerce" | "Shopify" | "ERPNext" | "Odoo",
    readonly status: number,
    readonly retryAt?: number,
  ) {
    super(`${provider} HTTP ${status}`);
  }
  get retryable() {
    return this.status === 429 || (this.status >= 500 && this.status !== 501);
  }
}
export function retryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value.trim())) {
    const until = now + Math.ceil(Number(value) * 1000);
    return Number.isSafeInteger(until) ? until : undefined;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now, date) : undefined;
}
export interface RequestClock {
  now(): number;
  wait(ms: number, signal?: AbortSignal | null): Promise<void>;
}
const defaultClock: RequestClock = {
  now: Date.now,
  wait: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new UserError("Request cancelled while waiting"));
        return;
      }
      const abort = () => {
        clearTimeout(timer);
        reject(new UserError("Request cancelled while waiting"));
      };
      const timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
        Math.max(0, Math.min(ms, 60000)),
      );
      signal?.addEventListener("abort", abort, { once: true });
    }),
};
interface OriginState {
  tail: Promise<unknown>;
  nextAt: number;
  pending: number;
}
/** One in-flight request per origin, bounded total IO, and no automatic replay of writes. */
export class RequestGovernor {
  private origins = new Map<string, OriginState>();
  private waiting = 0;
  private readonly io: WorkQueue;
  constructor(
    readonly options: {
      concurrency?: number;
      maxPending?: number;
      intervalMs?: number;
      clock?: RequestClock;
      maxResponseBytes?: number;
    } = {},
  ) {
    this.io = new WorkQueue(
      options.concurrency ?? 8,
      options.maxPending ?? 512,
    );
  }
  private get clock() {
    return this.options.clock ?? defaultClock;
  }
  private state(origin: string) {
    let state = this.origins.get(origin);
    if (!state) {
      state = { tail: Promise.resolve(), nextAt: 0, pending: 0 };
      this.origins.set(origin, state);
    }
    return state;
  }
  defer(url: string, until: number) {
    if (Number.isFinite(until)) {
      const state = this.state(new URL(url).origin);
      state.nextAt = Math.max(state.nextAt, until);
    }
  }
  async request(
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
    http: typeof fetch = fetch,
  ): Promise<Response> {
    if (this.waiting >= (this.options.maxPending ?? 512))
      throw new UserError("Provider request queue is full; retry later");
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const origin = new URL(url).origin;
    for (const [key, state] of this.origins)
      if (
        key !== origin &&
        state.pending === 0 &&
        state.nextAt <= this.clock.now()
      )
        this.origins.delete(key);
    const state = this.state(origin);
    state.pending++;
    this.waiting++;
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const operation = state.tail
      .catch(() => {})
      .then(async () => {
        while (state.nextAt > this.clock.now())
          await this.clock.wait(state.nextAt - this.clock.now(), signal);
        if (signal?.aborted)
          throw new UserError("Request cancelled while waiting");
        return this.io.run(async () => {
          if (signal?.aborted)
            throw new UserError("Request cancelled while waiting");
          try {
            const response = await http(input, init);
            const retry = retryAfter(
              response.headers.get("retry-after"),
              this.clock.now(),
            );
            if (retry !== undefined)
              state.nextAt = Math.max(state.nextAt, retry);
            else if (response.status === 429)
              state.nextAt = Math.max(state.nextAt, this.clock.now() + 2000);
            if (!response.ok) {
              await response.body?.cancel().catch(() => {});
              return new Response(null, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            }
            // Keep the IO slot until the JSON body has arrived, not just its headers.
            const limit = this.options.maxResponseBytes ?? 8 * 1024 * 1024;
            const reader = response.body?.getReader();
            const chunks: Uint8Array[] = [];
            let size = 0;
            if (reader) {
              try {
                for (;;) {
                  const chunk = await reader.read();
                  if (chunk.done) break;
                  size += chunk.value.byteLength;
                  if (size > limit) {
                    await reader.cancel();
                    throw new UserError(
                      "Provider response exceeds the inventory page size limit",
                    );
                  }
                  chunks.push(chunk.value);
                }
              } catch (error) {
                await reader.cancel().catch(() => {});
                throw error;
              }
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return new Response(
              [204, 205, 304].includes(response.status) ? null : bytes.buffer,
              {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              },
            );
          } finally {
            state.nextAt = Math.max(
              state.nextAt,
              this.clock.now() + (this.options.intervalMs ?? 500),
            );
          }
        });
      });
    state.tail = operation.catch(() => {});
    try {
      return await operation;
    } finally {
      state.pending--;
      this.waiting--;
    }
  }
  stats() {
    return {
      ...this.io.stats(),
      pending: this.waiting,
      origins: this.origins.size,
      intervalMs: this.options.intervalMs ?? 500,
    };
  }
}
export const providerRequests = new RequestGovernor();
export const governedFetch: typeof fetch = (input, init) =>
  providerRequests.request(input, init);
export function providerFailure(
  provider: "WooCommerce" | "Shopify" | "ERPNext" | "Odoo",
  response: Response,
): ProviderHttpError {
  return new ProviderHttpError(
    provider,
    response.status,
    retryAfter(response.headers.get("retry-after")) ??
      (response.status === 429 ? Date.now() + 2000 : undefined),
  );
}
