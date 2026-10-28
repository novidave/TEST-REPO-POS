const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { SqliteSyncStore } = require("../dist/src/sync/store.js");
const { runGroup } = require("../dist/src/sync/runner.js");
const row = (q) => ({
  productKey: "p",
  sku: "SKU",
  location: "w",
  available: q,
  onHand: q,
  revision: String(q),
  observedAt: new Date().toISOString(),
});
function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), "sync-test-"));
  let store = new SqliteSyncStore(join(path, "db"));
  t.after(() => {
    store.close();
    rmSync(path, { recursive: true, force: true });
  });
  const calls = [];
  let q = 3;
  const a = {
    id: "a",
    platform: "pos",
    capabilities: { read: true, write: false, compareAndSwap: false },
    read: async () => [row(5)],
  };
  const b = {
    id: "b",
    platform: "shopify",
    capabilities: { read: true, write: true, compareAndSwap: true },
    read: async () => [row(q)],
    write: async (updates) => {
      calls.push(updates);
      q = updates[0].quantity;
    },
  };
  const g = {
    id: "g",
    mode: "master",
    masterId: "a",
    members: [
      { adapter: a, role: "source" },
      { adapter: b, role: "destination" },
    ],
    enabled: true,
    intervalMinutes: 1,
    mappings: { a: { p: "p" }, b: { p: "p" } },
    locationMappings: { a: { w: "w" }, b: { w: "w" } },
  };
  return {
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new SqliteSyncStore(join(path, "db"));
    },
    calls,
    g,
    b,
    setQ: (value) => (q = value),
  };
}
test("duplicate polls and echoes write only once", async (t) => {
  const f = fixture(t);
  await runGroup(f.g, f.store);
  await runGroup(f.g, f.store);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM outbox").get().n, 1);
});
test("API failure retries durable operation with stable ID after restart", async (t) => {
  const f = fixture(t);
  f.b.write = async () => {
    throw new Error("token=NEVER-LOG");
  };
  let r = await runGroup(f.g, f.store);
  assert.equal(r.errors.length, 1);
  const original = f.store.db.prepare("SELECT * FROM outbox").get();
  assert.doesNotMatch(JSON.stringify(original), /NEVER-LOG/);
  f.reopen();
  f.store.db.prepare("UPDATE outbox SET created_at='2000-01-01'").run();
  f.b.write = async (u) => {
    f.calls.push(u);
    f.setQ(5);
  };
  await runGroup(f.g, f.store);
  assert.equal(f.calls[0][0].operationId, original.id);
  assert.equal(
    f.store.db.prepare("SELECT state FROM outbox").get().state,
    "done",
  );
});
test("crash after remote success reconciles without duplicate write", async (t) => {
  const f = fixture(t);
  f.store.enqueue("g", "b", {
    productKey: "p",
    location: "w",
    quantity: 5,
    expectedRevision: "3",
    operationId: "crash",
  });
  f.store.attempt("crash");
  f.setQ(5);
  f.reopen();
  f.store.db.prepare("UPDATE outbox SET created_at='2000-01-01'").run();
  await runGroup(f.g, f.store);
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT state FROM outbox").get().state,
    "done",
  );
});
test("destination edits block stale queued writes", async (t) => {
  const f = fixture(t);
  f.store.enqueue("g", "b", {
    productKey: "p",
    location: "w",
    quantity: 5,
    expectedRevision: "3",
    operationId: "stale",
  });
  f.setQ(2);
  await runGroup(f.g, f.store);
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT state FROM outbox WHERE id='stale'").get().state,
    "blocked",
  );
});
test("uncertain non-atomic writes are held after crash", async (t) => {
  const f = fixture(t);
  f.b.capabilities.compareAndSwap = false;
  f.store.enqueue("g", "b", {
    productKey: "p",
    location: "w",
    quantity: 5,
    expectedRevision: "3",
    operationId: "uncertain",
  });
  f.store.attempt("uncertain");
  f.store.db.prepare("UPDATE outbox SET created_at='2000-01-01'").run();
  await runGroup(f.g, f.store);
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT state FROM outbox WHERE id='uncertain'").get()
      .state,
    "blocked",
  );
});
test("one destination failure does not stop another destination or future polls", async (t) => {
  const f = fixture(t);
  const bad = {
    ...f.b,
    id: "bad",
    read: async () => {
      throw new Error("offline");
    },
  };
  f.g.members.push({ adapter: bad, role: "destination" });
  f.g.mappings.bad = { p: "p" };
  f.g.locationMappings.bad = { w: "w" };
  const r = await runGroup(f.g, f.store);
  assert.equal(r.errors[0].destination, "bad");
  assert.equal(f.calls.length, 1);
});
test("destination write failures are isolated", async (t) => {
  const f = fixture(t);
  const bad = {
    ...f.b,
    id: "bad",
    write: async () => {
      throw new Error("offline");
    },
  };
  f.g.members.unshift({ adapter: bad, role: "destination" });
  f.g.mappings.bad = { p: "p" };
  f.g.locationMappings.bad = { w: "w" };
  const r = await runGroup(f.g, f.store);
  assert.equal(r.errors.length, 1);
  assert.equal(f.calls.length, 1);
});
test("queue is scoped to group and honors disabled and read-only members", async (t) => {
  const f = fixture(t);
  f.store.enqueue("other", "b", {
    productKey: "p",
    location: "w",
    quantity: 99,
    expectedRevision: "3",
    operationId: "other",
  });
  f.g.enabled = false;
  await runGroup(f.g, f.store);
  assert.equal(f.calls.length, 0);
  f.g.enabled = true;
  await runGroup(f.g, f.store);
  assert.equal(f.calls[0][0].quantity, 5);
  assert.equal(
    f.store.db.prepare("SELECT state FROM outbox WHERE id='other'").get().state,
    "pending",
  );
});
test("observations and queue commit atomically on SQLite failure", async (t) => {
  const f = fixture(t);
  f.store.enqueue = () => {
    throw new Error("disk");
  };
  await assert.rejects(runGroup(f.g, f.store));
  assert.equal(
    f.store.db.prepare("SELECT COUNT(*) n FROM observations").get().n,
    0,
  );
});
test("overlapping manual sync is rejected", async (t) => {
  const f = fixture(t);
  let release;
  f.b.read = async () => {
    await new Promise((r) => (release = r));
    return [row(3)];
  };
  const first = runGroup(f.g, f.store);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(runGroup(f.g, f.store), /already/);
  f.b.read = async () => [row(3)];
  release();
  await first;
});
test("master changes invalidate old queued quantities before retry", async (t) => {
  const f = fixture(t);
  f.store.enqueue("g", "b", {
    productKey: "p",
    location: "w",
    quantity: 5,
    expectedRevision: "3",
    operationId: "old",
  });
  f.g.members[0].adapter.read = async () => [row(4)];
  await runGroup(f.g, f.store);
  assert.equal(f.calls.length, 0);
  assert.equal(
    f.store.db.prepare("SELECT state FROM outbox WHERE id='old'").get().state,
    "blocked",
  );
});
test("retry backoff prevents immediate reattempt and attempt limit holds job", async (t) => {
  const f = fixture(t);
  f.b.write = async () => {
    f.calls.push("attempt");
    throw new Error("offline");
  };
  await runGroup(f.g, f.store);
  await runGroup(f.g, f.store);
  assert.equal(f.calls.length, 1);
  for (let i = 0; i < 4; i++) {
    f.store.db.prepare("UPDATE outbox SET created_at='2000-01-01'").run();
    await runGroup(f.g, f.store);
  }
  const row = f.store.db.prepare("SELECT state,attempts FROM outbox").get();
  assert.equal(row.state, "blocked");
  assert.equal(row.attempts, 5);
});
test("established two-way conflict remains latched after restart and a peer reverting", async (t) => {
  const f = fixture(t);
  const a = f.g.members[0].adapter;
  a.capabilities = { read: true, write: true, compareAndSwap: true };
  a.write = async () => {};
  f.g.mode = "two_way";
  f.g.members.forEach((m) => (m.role = "both"));
  let source = 5;
  a.read = async () => [row(source)];
  f.setQ(5);
  await runGroup(f.g, f.store);
  source = 4;
  f.setQ(3);
  let r = await runGroup(f.g, f.store);
  assert.equal(r.plan.conflicts.length, 1);
  f.reopen();
  source = 5;
  r = await runGroup(f.g, f.store);
  assert.equal(r.plan.writes.length, 0);
  assert.equal(r.plan.conflicts.length, 1);
  source = 3;
  r = await runGroup(f.g, f.store);
  assert.equal(r.plan.conflicts.length, 0);
  assert.equal(f.store.isHeld("g", "p", "w"), false);
});
