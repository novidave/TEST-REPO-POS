const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  WorkQueue,
  SyncCoordinator,
  StaggeredScheduler,
  mapConcurrent,
} = require("../dist/src/sync/runtime.js");
const { RequestGovernor, retryAfter } = require("../dist/src/sync/http.js");
const turn = () => new Promise((resolve) => setImmediate(resolve));
test("bounded FIFO queue caps concurrency, preserves order and recovers after failures", async () => {
  const queue = new WorkQueue(3, 150),
    started = [];
  let active = 0,
    peak = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 120 }, (_, i) =>
      queue.run(async () => {
        started.push(i);
        active++;
        peak = Math.max(peak, active);
        try {
          await turn();
          if (i === 3) throw new Error("fixture");
          return i;
        } finally {
          active--;
        }
      }),
    ),
  );
  await turn();
  assert.equal(peak, 3);
  assert.deepEqual(
    started,
    Array.from({ length: 120 }, (_, i) => i),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 119);
  assert.equal(await queue.run(async () => 42), 42);
});
test("queue admission rejects overflow and closing cancels waiting work", async () => {
  const q = new WorkQueue(1, 1);
  let release;
  const first = q.run(() => new Promise((resolve) => (release = resolve)));
  const pending = q.run(async () => 2);
  await assert.rejects(
    q.run(async () => 3),
    /full/,
  );
  const rejected = assert.rejects(pending, /closed/);
  q.close();
  await rejected;
  release(1);
  assert.equal(await first, 1);
  await assert.rejects(
    q.run(async () => 4),
    /closed/,
  );
});
test("shared-connection groups serialize while unrelated groups retain concurrency", async () => {
  const coordinator = new SyncCoordinator(4, 150);
  let collisions = 0;
  const active = new Set();
  let peak = 0;
  const done = [];
  await Promise.all(
    Array.from({ length: 120 }, (_, i) =>
      coordinator.run(["store-" + (i % 12), "source-" + i], async () => {
        const key = "store-" + (i % 12);
        if (active.has(key)) collisions++;
        active.add(key);
        peak = Math.max(peak, active.size);
        await turn();
        active.delete(key);
        done.push(i);
      }),
    ),
  );
  assert.equal(collisions, 0);
  assert.equal(done.length, 120);
  assert.ok(peak > 1 && peak <= 4);
  assert.equal(coordinator.stats().pending, 0);
});
test("coordinator rejects excess admitted work and shutdown releases lock waiters", async () => {
  const coordinator = new SyncCoordinator(1, 2);
  let release, started;
  const ready = new Promise((resolve) => (started = resolve));
  const first = coordinator.run(
    ["same"],
    () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      }),
  );
  await ready;
  const pending = coordinator.run(["same"], async () => 2);
  await assert.rejects(
    coordinator.run(["other"], async () => 3),
    /full/,
  );
  const rejecting = assert.rejects(pending, /closing|closed/);
  coordinator.close();
  release(1);
  await first;
  await rejecting;
  assert.equal(coordinator.stats().pending, 0);
});
test("member reads are bounded and fully settle before a source failure propagates", async () => {
  let active = 0,
    peak = 0,
    finished = 0;
  await assert.rejects(
    mapConcurrent(
      Array.from({ length: 120 }, (_, i) => i),
      4,
      async (i) => {
        active++;
        peak = Math.max(peak, active);
        try {
          await turn();
          if (i === 0) throw new Error("source");
          finished++;
        } finally {
          active--;
        }
      },
    ),
    /source/,
  );
  assert.equal(active, 0);
  assert.ok(peak <= 4);
  assert.ok(finished < 120);
});
function fakeClock() {
  let now = 0,
    seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, delay) => {
      const id = ++seq;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    timers,
    async advance(target) {
      while (true) {
        const next = [...timers]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await turn();
      }
      now = target;
      await turn();
    },
  };
}
test("120 schedules spread startup, preserve unchanged due times and never overlap a poll", async () => {
  const clock = fakeClock(),
    calls = [];
  const scheduler = new StaggeredScheduler(async (id) => calls.push(id), clock);
  const groups = Array.from({ length: 120 }, (_, i) => ({
    id: "group-" + i,
    enabled: true,
    intervalMinutes: 1,
  }));
  scheduler.configure(groups);
  const before = scheduler.status();
  assert.equal(before.length, 120);
  assert.ok(
    new Set(before.map((e) => Math.floor(e.nextRunAt / 1000))).size > 40,
  );
  scheduler.configure(groups);
  assert.deepEqual(scheduler.status(), before);
  await clock.advance(60000);
  assert.equal(new Set(calls).size, 120);
  scheduler.stopAll();
  assert.equal(clock.timers.size, 0);
  const clock2 = fakeClock();
  let release,
    started = 0;
  const blocked = new StaggeredScheduler(() => {
    started++;
    return new Promise((resolve) => (release = resolve));
  }, clock2);
  blocked.configure([{ id: "slow", enabled: true, intervalMinutes: 1 }]);
  await clock2.advance(600000);
  assert.equal(started, 1);
  blocked.stopAll();
  release();
  await turn();
  assert.equal(clock2.timers.size, 0);
});
test("request governor limits 120 origins globally and serializes one shop", async () => {
  const governor = new RequestGovernor({
    concurrency: 8,
    maxPending: 256,
    intervalMs: 0,
  });
  let active = 0,
    peak = 0;
  const shops = new Set();
  let collisions = 0;
  const http = async (input) => {
    const origin = new URL(input).origin;
    if (shops.has(origin)) collisions++;
    shops.add(origin);
    active++;
    peak = Math.max(peak, active);
    await turn();
    active--;
    shops.delete(origin);
    return new Response("{}");
  };
  await Promise.all(
    Array.from({ length: 240 }, (_, i) =>
      governor.request("https://shop-" + (i % 120) + ".test/items", {}, http),
    ),
  );
  assert.equal(collisions, 0);
  assert.ok(peak > 1 && peak <= 8);
  assert.equal(governor.stats().pending, 0);
});
test("provider cooldown and Retry-After are honored without replaying a write", async () => {
  let now = 0;
  const waits = [];
  const clock = {
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  };
  const governor = new RequestGovernor({ intervalMs: 500, clock });
  let calls = 0;
  const http = async () => {
    calls++;
    return calls === 1
      ? new Response("{}", { status: 429, headers: { "retry-after": "3" } })
      : new Response("{}");
  };
  const response = await governor.request(
    "https://shop.test/write",
    { method: "PUT" },
    http,
  );
  assert.equal(response.status, 429);
  assert.equal(calls, 1);
  await governor.request("https://shop.test/read", {}, http);
  assert.equal(calls, 2);
  assert.ok(waits[0] >= 3000);
  assert.equal(retryAfter("2", 1000), 3000);
  assert.equal(retryAfter("bad", 1000), undefined);
});
test("provider admission is bounded and aborted queued requests never reach fetch", async () => {
  const governor = new RequestGovernor({
    concurrency: 1,
    maxPending: 2,
    intervalMs: 0,
  });
  let release, started;
  const ready = new Promise((resolve) => (started = resolve));
  let calls = 0;
  const http = async () => {
    calls++;
    started();
    await new Promise((resolve) => (release = resolve));
    return new Response("{}");
  };
  const first = governor.request("https://same.test", {}, http);
  await ready;
  const controller = new AbortController();
  const queued = governor.request(
    "https://same.test",
    { signal: controller.signal },
    http,
  );
  await assert.rejects(
    governor.request("https://other.test", {}, http),
    /full/,
  );
  controller.abort();
  const rejecting = assert.rejects(queued, /cancelled/);
  release();
  await first;
  await rejecting;
  assert.equal(calls, 1);
});
test("request IO slots include response-body transfer and reject oversized inventory pages", async () => {
  const governor = new RequestGovernor({
    concurrency: 2,
    maxPending: 10,
    intervalMs: 0,
  });
  let release;
  const first = governor.request(
    "https://stream.test",
    {},
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            release = () => {
              controller.enqueue(new TextEncoder().encode("{}"));
              controller.close();
            };
          },
        }),
      ),
  );
  await turn();
  assert.equal(governor.stats().active, 1);
  release();
  assert.equal(await (await first).text(), "{}");
  await turn();
  assert.equal(governor.stats().active, 0);
  const limited = new RequestGovernor({ intervalMs: 0, maxResponseBytes: 3 });
  await assert.rejects(
    limited.request(
      "https://large.test",
      {},
      async () => new Response("12345"),
    ),
    /page size/,
  );
  assert.equal(
    (
      await limited.request(
        "https://other.test",
        {},
        async () => new Response(null, { status: 204 }),
      )
    ).status,
    204,
  );
});
test("non-OK provider bodies are discarded while retry metadata and status are preserved", async () => {
  const governor = new RequestGovernor({ intervalMs: 0, maxResponseBytes: 1 });
  const response = await governor.request(
    "https://error.test",
    {},
    async () =>
      new Response("secret error body must not be retained", {
        status: 503,
        headers: { "retry-after": "5" },
      }),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "5");
  assert.equal(await response.text(), "");
  assert.equal(retryAfter("9".repeat(400), 0), undefined);
});
test("long provider cooldowns remain cancellable without timer-overflow request storms", async () => {
  const governor = new RequestGovernor({ intervalMs: 0 });
  governor.defer("https://long.test", Date.now() + 1e12);
  const controller = new AbortController();
  let calls = 0;
  const warnings = [];
  const warning = (w) => warnings.push(w);
  process.on("warning", warning);
  try {
    const pending = governor.request(
      "https://long.test",
      { signal: controller.signal },
      async () => {
        calls++;
        return new Response("{}");
      },
    );
    await turn();
    const rejecting = assert.rejects(pending, /cancelled/);
    controller.abort();
    await rejecting;
    await turn();
    assert.equal(calls, 0);
    assert.equal(
      warnings.some((w) => w.name === "TimeoutOverflowWarning"),
      false,
    );
  } finally {
    process.removeListener("warning", warning);
  }
});
