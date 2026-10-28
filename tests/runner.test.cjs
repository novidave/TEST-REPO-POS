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
  f.store.db
    .prepare("UPDATE outbox SET next_attempt_at=0,created_at='2000-01-01'")
    .run();
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
  f.store.db
    .prepare("UPDATE outbox SET next_attempt_at=0,created_at='2000-01-01'")
    .run();
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
  f.store.db
    .prepare("UPDATE outbox SET next_attempt_at=0,created_at='2000-01-01'")
    .run();
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
    f.store.db
      .prepare("UPDATE outbox SET next_attempt_at=0,created_at='2000-01-01'")
      .run();
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
test("pausing during preflight preserves pending jobs without issuing a remote write", async (t) => {
  const f = fixture(t);
  let enabled = true;
  let reads = 0;
  f.b.read = async () => {
    reads++;
    if (reads === 2) enabled = false;
    return [row(3)];
  };
  const result = await runGroup(f.g, f.store, { canContinue: () => enabled });
  assert.equal(result.paused, true);
  assert.equal(f.calls.length, 0);
  const pending = f.store.db.prepare("SELECT state,attempts FROM outbox").get();
  assert.deepEqual(pending, { state: "pending", attempts: 0 });
  enabled = true;
  f.b.read = async () => [row(3)];
  await runGroup(f.g, f.store, { canContinue: () => enabled });
  assert.equal(f.calls.length, 1);
});
test("pausing during a sent write stops subsequent jobs and retains their operation IDs", async (t) => {
  const f = fixture(t);
  let enabled = true;
  f.g.members[0].adapter.read = async () => [
    row(5),
    { ...row(5), productKey: "p2", sku: "SKU2" },
  ];
  f.b.read = async () => [row(3), { ...row(3), productKey: "p2", sku: "SKU2" }];
  f.g.mappings.a.p2 = "p2";
  f.g.mappings.b.p2 = "p2";
  f.b.write = async (updates) => {
    f.calls.push(updates);
    enabled = false;
  };
  const result = await runGroup(f.g, f.store, { canContinue: () => enabled });
  assert.equal(result.paused, true);
  assert.equal(f.calls.length, 1);
  assert.equal(
    f.store.db
      .prepare("SELECT COUNT(*) count FROM outbox WHERE state='pending'")
      .get().count,
    1,
  );
});
test("provider Retry-After is durable and stops a destination failure storm", async (t) => {
  const f = fixture(t);
  const { ProviderHttpError } = require("../dist/src/sync/http.js");
  const until = Date.now() + 60000;
  f.g.members[0].adapter.read = async () => [
    row(5),
    { ...row(5), productKey: "p2", sku: "SKU2" },
  ];
  f.b.read = async () => [row(3), { ...row(3), productKey: "p2", sku: "SKU2" }];
  f.g.mappings.a.p2 = "p2";
  f.g.mappings.b.p2 = "p2";
  let attempts = 0;
  f.b.write = async () => {
    attempts++;
    throw new ProviderHttpError("Shopify", 429, until);
  };
  await runGroup(f.g, f.store);
  assert.equal(attempts, 1);
  assert.equal(f.store.pending("g", "b").length, 0);
  const pending = f.store.db
    .prepare("SELECT id,next_attempt_at,attempts FROM outbox")
    .all();
  assert.ok(pending.every((row) => row.next_attempt_at >= until));
  assert.equal(
    pending.reduce((n, row) => n + row.attempts, 0),
    1,
  );
  f.reopen();
  assert.equal(f.store.pending("g", "b").length, 0);
  let destinationReads = 0;
  f.b.read = async () => {
    destinationReads++;
    return [row(3)];
  };
  await runGroup(f.g, f.store);
  assert.equal(
    destinationReads,
    0,
    "pending provider cooldown must suppress destination reads as well as writes",
  );
  assert.equal(attempts, 1);
});
test("authentication failure holds all destination jobs without retrying every product", async (t) => {
  const f = fixture(t);
  const { ProviderHttpError } = require("../dist/src/sync/http.js");
  let requests = 0;
  f.b.write = async () => {
    requests++;
    throw new ProviderHttpError("Shopify", 401);
  };
  await runGroup(f.g, f.store);
  assert.equal(requests, 1);
  assert.equal(
    f.store.db.prepare("SELECT state FROM outbox").get().state,
    "blocked",
  );
});
test("targeted preflight reads keep CAS validation without repeatedly downloading inventories", async (t) => {
  const f = fixture(t);
  let sourceReads = 0,
    destinationReads = 0,
    pointReads = 0;
  f.g.members[0].adapter.read = async () => {
    sourceReads++;
    return [row(5)];
  };
  f.b.read = async () => {
    destinationReads++;
    return [row(3)];
  };
  f.g.members[0].adapter.readOne = async () => {
    pointReads++;
    return row(5);
  };
  f.b.readOne = async () => {
    pointReads++;
    return row(3);
  };
  await runGroup(f.g, f.store);
  assert.equal(sourceReads, 1);
  assert.equal(destinationReads, 1);
  assert.equal(pointReads, 2);
  assert.equal(f.calls[0][0].expectedRevision, "3");
});
test("existing SQLite outbox schema migrates additively and preserves pending jobs", (t) => {
  const Database = require("better-sqlite3");
  const path = mkdtempSync(join(tmpdir(), "old-outbox-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const file = join(path, "db");
  const old = new Database(file);
  old.exec(
    "CREATE TABLE outbox(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, destination TEXT NOT NULL, product_key TEXT NOT NULL, location TEXT NOT NULL, quantity REAL NOT NULL, expected_revision TEXT, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL)",
  );
  old
    .prepare(
      "INSERT INTO outbox(id,group_id,destination,product_key,location,quantity,created_at) VALUES(?,?,?,?,?,?,?)",
    )
    .run("existing", "g", "b", "p", "w", 2, new Date().toISOString());
  old.close();
  const migrated = new SqliteSyncStore(file);
  try {
    assert.equal(migrated.pending("g", "b")[0].id, "existing");
    assert.equal(
      migrated.db
        .pragma("table_info(outbox)")
        .filter((c) => c.name === "next_attempt_at").length,
      1,
    );
  } finally {
    migrated.close();
  }
  const reopened = new SqliteSyncStore(file);
  reopened.close();
});
