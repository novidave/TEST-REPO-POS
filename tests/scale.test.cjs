const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { DesktopService } = require("../dist/src/desktop.js");
const { CredentialVault } = require("../dist/src/security.js");
const { ProviderHttpError } = require("../dist/src/sync/http.js");
const clock = { now: Date.now, setTimeout: () => ({}), clearTimeout: () => {} };
const cipher = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("No credentials used in load tests");
  },
  decryptString: () => {
    throw new Error("No credentials used in load tests");
  },
};
async function scenario(t, failDestination) {
  const dir = await mkdtemp(join(tmpdir(), "inventory-scale-"));
  let service;
  const adapters = new Map(),
    data = new Map();
  let activeReads = 0,
    peakReads = 0,
    fullReads = 0,
    itemReads = 0,
    writes = 0;
  const delivered = new Set();
  let failing = failDestination;
  const io = async (action) => {
    activeReads++;
    peakReads = Math.max(peakReads, activeReads);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return action();
    } finally {
      activeReads--;
    }
  };
  for (let i = 0; i < 120; i++) {
    const id = "connection-" + i,
      source = i % 2 === 0;
    const rows = new Map(
      Array.from({ length: 25 }, (_, p) => {
        const sku = "FIXTURE-" + p;
        return [
          sku,
          {
            productKey: sku,
            sku,
            location: "warehouse",
            onHand: source ? 5 : 2,
            available: source ? 5 : 2,
            revision: "r0",
            observedAt: "2026-10-28T12:00:00Z",
            ...(source
              ? {
                  product: {
                    source_code: sku,
                    name: "Synthetic fixture product " + p,
                    price: p + 1,
                    currency: "EUR",
                    quantity: 5,
                  },
                }
              : {}),
          },
        ];
      }),
    );
    data.set(id, rows);
    const adapter = {
      id,
      platform: source ? "file" : "shopify",
      capabilities: {
        read: true,
        write: !source,
        compareAndSwap: !source,
        locations: true,
        webhooks: false,
      },
      read: () =>
        io(() => {
          fullReads++;
          return structuredClone([...rows.values()]);
        }),
      readOne: (key, location) =>
        io(() => {
          itemReads++;
          return location === "warehouse"
            ? structuredClone(rows.get(key))
            : undefined;
        }),
      ...(!source
        ? {
            write: async (updates) => {
              for (const u of updates) {
                if (id === failing)
                  throw new ProviderHttpError(
                    "Shopify",
                    429,
                    Date.now() + 60000,
                  );
                const row = rows.get(u.productKey);
                assert.equal(u.expectedRevision, row.revision);
                assert.equal(
                  delivered.has(u.operationId),
                  false,
                  "same operation was sent twice",
                );
                delivered.add(u.operationId);
                rows.set(u.productKey, {
                  ...row,
                  available: u.quantity,
                  onHand: u.quantity,
                  revision: "r" + (Number(row.revision.slice(1)) + 1),
                });
                writes++;
              }
            },
          }
        : {}),
    };
    adapters.set(id, adapter);
  }
  const open = () => {
    service = new DesktopService(
      dir,
      new CredentialVault(join(dir, "no-credentials"), cipher),
      { schedulerClock: clock },
    );
    service.adapter = async (id) => {
      const adapter = adapters.get(id);
      if (!adapter) throw new Error("Unknown fixture");
      return adapter;
    };
  };
  open();
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 120; i++)
    await service.saveConnection({
      id: "connection-" + i,
      name: "Fixture connection " + i,
      platform: i % 2 === 0 ? "file" : "shopify",
      permission: i % 2 === 0 ? "read" : "read_write",
      ...(i % 2 === 0
        ? { stockPath: "synthetic-fixture.json" }
        : { shopDomain: "fixture-" + i + ".myshopify.com" }),
    });
  const groups = [];
  for (let i = 0; i < 60; i++) {
    const source = "connection-" + 2 * i,
      destination = "connection-" + (2 * i + 1),
      mapping = Object.fromEntries(
        [...data.get(source).keys()].map((k) => [k, k]),
      );
    const group = {
      id: "fixture-group-" + i,
      mode: "master",
      masterId: source,
      members: [
        { connectionId: source, role: "source" },
        { connectionId: destination, role: "destination" },
      ],
      enabled: true,
      intervalMinutes: 1,
      mappings: { [source]: mapping, [destination]: mapping },
      locationMappings: {
        [source]: { warehouse: "warehouse" },
        [destination]: { warehouse: "warehouse" },
      },
    };
    await service.saveGroup(group);
    groups.push(group);
  }
  return {
    dir,
    get service() {
      return service;
    },
    groups,
    async reopen() {
      await service.close();
      open();
      await service.restartSchedules();
    },
    recover() {
      failing = undefined;
    },
    metrics: () => ({ peakReads, fullReads, itemReads, writes }),
    delivered,
  };
}
test(
  "120 configured connections: 60 groups / 1500 writes, bounded concurrency, exports and restart without duplicates",
  { timeout: 120000 },
  async (t) => {
    const fixture = await scenario(t);
    const started = performance.now();
    const outcomes = await Promise.all(
      fixture.groups.map((g) => fixture.service.sync(g.id)),
    );
    const elapsedMs = performance.now() - started;
    assert.equal(outcomes.length, 60);
    assert.ok(
      outcomes.every(
        (r) => r.errors.length === 0 && r.plan.conflicts.length === 0,
      ),
    );
    assert.equal(fixture.service.connections().length, 120);
    assert.equal(fixture.metrics().writes, 1500);
    assert.equal(
      fixture.metrics().fullReads,
      180,
      "inventories must not be downloaded per product write",
    );
    assert.equal(fixture.metrics().itemReads, 3000);
    assert.ok(fixture.metrics().peakReads <= 16);
    assert.equal(fixture.service.runtime.stats().peak, 4);
    assert.equal(
      fixture.service.store.db
        .prepare("SELECT COUNT(*) count FROM outbox WHERE state='done'")
        .get().count,
      1500,
    );
    for (const group of fixture.groups) {
      const path = join(fixture.dir, "exports", group.id),
        csv = await readFile(join(path, "stock.csv"));
      const manifest = JSON.parse(
        await readFile(join(path, "manifest.json"), "utf8"),
      );
      assert.equal(manifest.product_count, 25);
      assert.equal(
        manifest.sha256,
        createHash("sha256").update(csv).digest("hex"),
      );
    }
    await fixture.reopen();
    assert.equal(fixture.service.snapshot().connections.length, 120);
    await Promise.all(fixture.groups.map((g) => fixture.service.sync(g.id)));
    assert.equal(fixture.metrics().writes, 1500);
    assert.equal(
      fixture.service.store.hasOutstanding(fixture.groups[0].id),
      false,
    );
    t.diagnostic(
      JSON.stringify({
        connections: 120,
        groups: 60,
        productsPerGroup: 25,
        completedWrites: 1500,
        firstCycleMs: Math.round(elapsedMs),
        firstCycleFullInventoryReads: 180,
        groupConcurrencyPeak: fixture.service.runtime.stats().peak,
        ...fixture.metrics(),
        restartDuplicateWrites: 0,
      }),
    );
  },
);
test(
  "120-connection failure isolation: throttled destination survives restart and recovers stable queued jobs",
  { timeout: 120000 },
  async (t) => {
    const fixture = await scenario(t, "connection-1");
    const results = await Promise.all(
      fixture.groups.map((g) => fixture.service.sync(g.id)),
    );
    assert.equal(results.filter((result) => result.errors.length).length, 1);
    assert.equal(fixture.metrics().writes, 1475);
    const before = fixture.service.store.db
      .prepare(
        "SELECT id,next_attempt_at FROM outbox WHERE state='pending' ORDER BY id",
      )
      .all();
    assert.equal(before.length, 25);
    assert.ok(before.every((row) => row.next_attempt_at > Date.now()));
    await fixture.reopen();
    const after = fixture.service.store.db
      .prepare("SELECT id FROM outbox WHERE state='pending' ORDER BY id")
      .all();
    assert.deepEqual(
      after.map((r) => r.id),
      before.map((r) => r.id),
    );
    fixture.recover();
    fixture.service.store.db
      .prepare(
        "UPDATE outbox SET next_attempt_at=0,created_at='2000-01-01' WHERE state='pending'",
      )
      .run();
    await Promise.all(fixture.groups.map((g) => fixture.service.sync(g.id)));
    assert.equal(fixture.metrics().writes, 1500);
    assert.equal(
      fixture.service.store.db
        .prepare("SELECT COUNT(*) count FROM outbox WHERE state!='done'")
        .get().count,
      0,
    );
    assert.ok(before.every((row) => fixture.delivered.has(row.id)));
  },
);
