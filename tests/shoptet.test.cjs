const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ShoptetAdapter } = require("../dist/src/sync/adapters/shoptet.js");
const supply = (code = "001", amount = "12.000", claim = "0.000") => ({
  productGuid: "guid-" + code,
  code,
  amount,
  claim,
});
const paged = (rows, page = 1, total = rows.length, size = 100) => ({
  supplies: rows,
  paginator: {
    page,
    pageCount: Math.ceil(total / size),
    itemsOnPage: rows.length,
    itemsPerPage: size,
    totalCount: total,
  },
});
function fixture({
  access = "private",
  rows = [supply()],
  handler,
  eshopId = 123,
  writeEnabled = false,
} = {}) {
  const calls = [];
  const adapter = new ShoptetAdapter(
    "s",
    123,
    access,
    "private-token",
    async (url, init) => {
      calls.push({ url, init });
      const q = new URL(url);
      assert.equal(q.origin, "https://api.myshoptet.com");
      assert.ok(
        init.method === "GET" || (writeEnabled && init.method === "PATCH"),
      );
      assert.equal(init.redirect, "error");
      assert.doesNotMatch(url, /private-token/);
      let data =
        q.pathname === "/api/eshop"
          ? { contactInformation: { eshopId } }
          : q.pathname === "/api/stocks"
            ? { stocks: [{ id: 1 }] }
            : paged(rows);
      const override = await handler?.(q, calls.length, init);
      if (override instanceof Response) return override;
      if (override !== undefined) data = override;
      return new Response(JSON.stringify({ data, errors: null, metadata: {} }));
    },
    writeEnabled,
  );
  return { adapter, calls };
}
test("Shoptet verifies e-shop binding and reads exact SKU/warehouse stock using private API authentication", async () => {
  const { adapter, calls } = fixture();
  const [stock] = await adapter.read();
  assert.equal(stock.sku, "001");
  assert.equal(stock.location, "1");
  assert.equal(stock.onHand, 12);
  assert.equal(stock.available, null);
  assert.equal(stock.product, undefined);
  assert.equal(calls[0].url, "https://api.myshoptet.com/api/eshop");
  assert.equal(
    calls[2].init.headers["Shoptet-Private-API-Token"],
    "private-token",
  );
  assert.equal(calls[2].init.headers["Shoptet-Access-Token"], undefined);
  assert.equal(adapter.write, undefined);
  assert.equal(adapter.capabilities.write, false);
});
test("Shoptet add-on API tokens use the separate header, never OAuth installation secrets", async () => {
  const { adapter, calls } = fixture({ access: "addon" });
  await adapter.read();
  assert.equal(calls[0].init.headers["Shoptet-Access-Token"], "private-token");
  assert.equal(calls[0].init.headers.Authorization, undefined);
});
test("Shoptet refuses a token for another shop before any stock request", async () => {
  const { adapter, calls } = fixture({ eshopId: 456 });
  await assert.rejects(adapter.read(), /different e-shop/);
  assert.equal(calls.length, 1);
});
test("Shoptet pages all warehouses with stable total counts and refuses duplicates or moving pagination", async () => {
  const { adapter } = fixture({
    handler: (q) => {
      if (q.pathname === "/api/stocks")
        return { stocks: [{ id: 1 }, { id: 2 }] };
      if (q.pathname.endsWith("/supplies"))
        return paged(
          [supply("S" + q.searchParams.get("page"))],
          Number(q.searchParams.get("page")),
          2,
          1,
        );
    },
  });
  assert.equal((await adapter.read()).length, 4);
  for (const mode of ["duplicate", "count-change", "short-page"]) {
    const { adapter: a } = fixture({
      handler: (q) => {
        if (!q.pathname.endsWith("/supplies")) return;
        const page = Number(q.searchParams.get("page"));
        if (mode === "duplicate") return paged([supply()], page, 2, 1);
        if (mode === "count-change")
          return paged([supply("S" + page)], page, page === 1 ? 2 : 3, 1);
        return paged([], page, 1, 100);
      },
    });
    await assert.rejects(a.read());
  }
});
test("Shoptet rejects missing SKUs, null/fractional/negative amounts, reserved stock and empty inventory", async () => {
  for (const rows of [
    [],
    [supply("", "2.000")],
    [supply("S", null)],
    [supply("S", "1.500")],
    [supply("S", "-1.000")],
    [supply("S", "12.000", "1.000")],
    [{ ...supply(), productGuid: null }],
  ])
    await assert.rejects(fixture({ rows }).adapter.read());
});
test("Shoptet targeted reads use encoded exact variant codes and stock IDs", async () => {
  const { adapter, calls } = fixture({
    rows: [supply("001/Č")],
    handler: (q) => {
      if (q.pathname.endsWith("/supplies"))
        assert.equal(q.searchParams.get("code"), "001/Č");
    },
  });
  assert.equal((await adapter.readOne("001/Č", "1")).sku, "001/Č");
  assert.equal(calls.length, 2);
  await assert.rejects(adapter.readOne("001", "../1"), /numeric stock ID/);
});
test("Shoptet 200 error arrays and HTTP failures never expose echoed tokens or accept partial stock", async () => {
  const a = fixture({
    handler: () =>
      new Response(
        JSON.stringify({ data: {}, errors: [{ message: "private-token" }] }),
      ),
  }).adapter;
  await assert.rejects(
    a.read(),
    (e) => /API error/.test(e.message) && !e.message.includes("private-token"),
  );
  for (const status of [401, 403, 429, 503]) {
    const b = fixture({
      handler: () =>
        new Response("private-token", {
          status,
          headers: { "Retry-After": "2" },
        }),
    }).adapter;
    await assert.rejects(
      b.read(),
      (e) => e.status === status && e.message === "Shoptet HTTP " + status,
    );
  }
});
test("Shoptet missing credentials and header injection are refused before network use", () => {
  for (const token of ["", "secret\nheader"])
    assert.throws(() => new ShoptetAdapter("s", 123, "private", token));
  assert.throws(() => new ShoptetAdapter("s", 0, "private", "token"));
});
test("native Shoptet reads feed the master coordinator and repeated polls do not duplicate mock-destination writes", async (t) => {
  const { SqliteSyncStore } = require("../dist/src/sync/store.js");
  const { runGroup } = require("../dist/src/sync/runner.js");
  const store = new SqliteSyncStore(":memory:");
  t.after(() => store.close());
  const { adapter } = fixture();
  let quantity = 0,
    writes = 0;
  const destination = {
    id: "d",
    platform: "shopify",
    capabilities: {
      read: true,
      write: true,
      locations: true,
      webhooks: false,
      compareAndSwap: true,
    },
    read: async () => [
      {
        productKey: "remote",
        sku: "001",
        location: "2",
        available: quantity,
        onHand: null,
        revision: String(quantity),
        observedAt: new Date().toISOString(),
      },
    ],
    write: async (updates) => {
      quantity = updates[0].quantity;
      writes++;
    },
  };
  const group = {
    id: "native-shoptet",
    mode: "master",
    masterId: "s",
    enabled: true,
    intervalMinutes: 5,
    members: [
      { adapter, role: "source" },
      { adapter: destination, role: "destination" },
    ],
    mappings: { s: { "001": "shared" }, d: { remote: "shared" } },
    locationMappings: { s: { 1: "main" }, d: { 2: "main" } },
  };
  assert.deepEqual((await runGroup(group, store)).errors, []);
  assert.equal(quantity, 12);
  assert.equal(writes, 1);
  assert.deepEqual((await runGroup(group, store)).errors, []);
  assert.equal(writes, 1);
});
const job = (revision, quantity = 7) => ({
  productKey: "001",
  location: "1",
  quantity,
  expectedRevision: revision,
  operationId: "stable-job",
});
test("Shoptet opt-in writes use the official absolute available-stock PATCH and verify the resulting stock", async () => {
  const rows = [supply()];
  const { adapter, calls } = fixture({
    writeEnabled: true,
    rows,
    handler: (url, n, init) => {
      if (init.method === "PATCH") {
        assert.equal(url.pathname, "/api/stocks/1/movements");
        assert.deepEqual(JSON.parse(init.body), {
          data: [{ productCode: "001", quantity: 7 }],
        });
        assert.equal(init.headers["Content-Type"], "application/json");
        rows[0].amount = "7.000";
        return null;
      }
    },
  });
  const before = await adapter.readOne("001", "1");
  await adapter.write([job(before.revision)]);
  assert.equal(adapter.capabilities.write, true);
  assert.equal(adapter.capabilities.compareAndSwap, false);
  assert.equal(calls.filter((c) => c.init.method === "PATCH").length, 1);
  assert.equal((await adapter.readOne("001", "1")).onHand, 7);
  await adapter.write([job(before.revision)]); // Already reached desired stock: no duplicate request.
  assert.equal(calls.filter((c) => c.init.method === "PATCH").length, 1);
});
test("Shoptet rejects unsafe write arguments and multi-item batches before issuing any request", async () => {
  const { adapter, calls } = fixture({ writeEnabled: true });
  for (const updates of [
    [],
    [job("rev"), job("rev")],
    [job("rev", -1)],
    [job("rev", 1.5)],
    [{ ...job("rev"), location: "../1" }],
    [{ ...job("rev"), operationId: "" }],
    [job(undefined)],
  ])
    await assert.rejects(adapter.write(updates));
  assert.equal(calls.length, 0);
});
test("Shoptet detects changed revision, new claims and wrong shop before any stock PATCH", async () => {
  for (const mode of ["revision", "claim", "shop", "missing"]) {
    const rows = [supply()];
    let shop = 123;
    const { adapter, calls } = fixture({
      writeEnabled: true,
      rows,
      handler: (url) =>
        url.pathname === "/api/eshop"
          ? { contactInformation: { eshopId: shop } }
          : undefined,
    });
    const before = await adapter.readOne("001", "1");
    if (mode === "revision") rows[0].changeTime = "2026-10-28T20:00:00+0100";
    if (mode === "claim") rows[0].claim = "1.000";
    if (mode === "shop") shop = 456;
    if (mode === "missing") rows.length = 0;
    await assert.rejects(adapter.write([job(before.revision)]));
    assert.equal(calls.filter((c) => c.init.method === "PATCH").length, 0);
  }
});
test("Shoptet treats HTTP 200 item errors, failed verification and write throttling as failures without blind retries", async () => {
  for (const mode of ["item-error", "unchanged", "throttle", "network"]) {
    const { adapter, calls } = fixture({
      writeEnabled: true,
      handler: (url, n, init) => {
        if (init.method !== "PATCH") return;
        if (mode === "item-error")
          return new Response(
            JSON.stringify({
              data: null,
              errors: [{ message: "private-token" }],
            }),
          );
        if (mode === "throttle")
          return new Response("private-token", {
            status: 429,
            headers: { "Retry-After": "2" },
          });
        if (mode === "network") throw Error("private-token");
        return null;
      },
    });
    const before = await adapter.readOne("001", "1");
    await assert.rejects(adapter.write([job(before.revision)]));
    assert.equal(calls.filter((c) => c.init.method === "PATCH").length, 1);
  }
});
test("Shoptet uncertain write recovers from durable outbox without sending a second PATCH", async (t) => {
  const { SqliteSyncStore } = require("../dist/src/sync/store.js");
  const { runGroup } = require("../dist/src/sync/runner.js");
  const { mkdtemp, rm } = require("node:fs/promises");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dir = await mkdtemp(join(tmpdir(), "shoptet-crash-"));
  let store = new SqliteSyncStore(join(dir, "db"));
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const rows = [supply("001", "1.000")];
  const { adapter, calls } = fixture({
    writeEnabled: true,
    rows,
    handler: (url, n, init) => {
      if (init.method === "PATCH") {
        rows[0].amount =
          String(JSON.parse(init.body).data[0].quantity) + ".000";
        throw Error("Connection lost after vendor applied update");
      }
    },
  });
  const source = {
    id: "source",
    platform: "file",
    capabilities: {
      read: true,
      write: false,
      locations: true,
      webhooks: false,
      compareAndSwap: false,
    },
    read: async () => [
      {
        productKey: "local",
        sku: "001",
        location: "warehouse",
        available: 7,
        onHand: null,
        observedAt: new Date().toISOString(),
      },
    ],
  };
  const group = {
    id: "shoptet-write",
    mode: "master",
    masterId: "source",
    enabled: true,
    intervalMinutes: 5,
    members: [
      { adapter: source, role: "source" },
      { adapter, role: "destination" },
    ],
    mappings: { source: { local: "shared" }, s: { "001": "shared" } },
    locationMappings: { source: { warehouse: "main" }, s: { 1: "main" } },
  };
  assert.equal((await runGroup(group, store)).errors.length, 1);
  assert.equal(calls.filter((c) => c.init.method === "PATCH").length, 1);
  store.close();
  store = new SqliteSyncStore(join(dir, "db"));
  store.db
    .prepare(
      "UPDATE outbox SET next_attempt_at=NULL,created_at='2000-01-01T00:00:00Z' WHERE group_id=?",
    )
    .run(group.id);
  assert.deepEqual((await runGroup(group, store)).errors, []);
  assert.equal(calls.filter((c) => c.init.method === "PATCH").length, 1);
  assert.equal(
    store.db
      .prepare("SELECT count(*) AS n FROM outbox WHERE state='done'")
      .get().n,
    1,
  );
});
test("CLI Shoptet adapters require explicit write acknowledgement and keep read-only access as default", () => {
  const { createAdapters } = require("../dist/src/sync/config.js");
  const connection = {
    id: "shoptet",
    platform: "shoptet",
    shoptetEshopId: 123,
    shoptetAccess: "private",
    credentialEnv: "TEST_SHOPTET_KEY",
  };
  const config = {
    connections: [connection],
    groups: [],
    databasePath: "unused",
    exportDirectory: "unused",
  };
  const env = { TEST_SHOPTET_KEY: "synthetic-key" };
  assert.equal(createAdapters(config, env).get("shoptet").write, undefined);
  assert.throws(
    () =>
      createAdapters(
        {
          ...config,
          connections: [{ ...connection, permission: "read_write" }],
        },
        env,
      ),
    /acknowledgement/,
  );
  const adapter = createAdapters(
    {
      ...config,
      connections: [
        {
          ...connection,
          permission: "read_write",
          shoptetWriteAcknowledged: true,
        },
      ],
    },
    env,
  ).get("shoptet");
  assert.equal(adapter.capabilities.write, true);
  assert.equal(typeof adapter.write, "function");
  assert.equal(adapter.capabilities.compareAndSwap, false);
});
async function writeGroupFixture(t, response) {
  const { SqliteSyncStore } = require("../dist/src/sync/store.js");
  const store = new SqliteSyncStore(":memory:");
  t.after(() => store.close());
  const { adapter, calls } = fixture({
    writeEnabled: true,
    rows: [supply("001", "1.000")],
    handler: (url, n, init) =>
      init.method === "PATCH" ? response() : undefined,
  });
  const source = {
    id: "source",
    platform: "file",
    capabilities: {
      read: true,
      write: false,
      locations: true,
      webhooks: false,
      compareAndSwap: false,
    },
    read: async () => [
      {
        productKey: "local",
        sku: "001",
        location: "warehouse",
        available: 7,
        onHand: null,
        observedAt: new Date().toISOString(),
      },
    ],
  };
  const group = {
    id: "master-shoptet",
    mode: "master",
    masterId: "source",
    enabled: true,
    intervalMinutes: 5,
    members: [
      { adapter: source, role: "source" },
      { adapter, role: "destination" },
    ],
    mappings: { source: { local: "shared" }, s: { "001": "shared" } },
    locationMappings: { source: { warehouse: "main" }, s: { 1: "main" } },
  };
  return { store, adapter, calls, group };
}
test("unconfirmed Shoptet writes remain held on recovery instead of being resent", async (t) => {
  const { runGroup } = require("../dist/src/sync/runner.js");
  const { store, calls, group } = await writeGroupFixture(t, () => {
    throw Error("Connection lost; outcome unknown");
  });
  assert.equal((await runGroup(group, store)).errors.length, 1);
  store.db
    .prepare(
      "UPDATE outbox SET next_attempt_at=NULL,created_at='2000-01-01T00:00:00Z'",
    )
    .run();
  await runGroup(group, store);
  assert.equal(calls.filter((c) => c.init.method === "PATCH").length, 1);
  assert.equal(
    store.db.prepare("SELECT state FROM outbox").get().state,
    "blocked",
  );
});
test("Shoptet write throttling preserves its job while another destination succeeds independently", async (t) => {
  const { runGroup } = require("../dist/src/sync/runner.js");
  const { store, calls, group } = await writeGroupFixture(
    t,
    () =>
      new Response("do-not-log-private-token", {
        status: 429,
        headers: { "Retry-After": "2" },
      }),
  );
  let otherQuantity = 0;
  const other = {
    id: "other",
    platform: "shopify",
    capabilities: {
      read: true,
      write: true,
      locations: true,
      webhooks: false,
      compareAndSwap: true,
    },
    read: async () => [
      {
        productKey: "remote",
        sku: "001",
        location: "other-stock",
        available: otherQuantity,
        onHand: null,
        revision: String(otherQuantity),
        observedAt: new Date().toISOString(),
      },
    ],
    write: async (updates) => {
      otherQuantity = updates[0].quantity;
    },
  };
  group.members.push({ adapter: other, role: "destination" });
  group.mappings.other = { remote: "shared" };
  group.locationMappings.other = { "other-stock": "main" };
  const result = await runGroup(group, store);
  assert.equal(result.errors.length, 1);
  assert.equal(otherQuantity, 7);
  const pending = store.db
    .prepare("SELECT * FROM outbox WHERE destination='s'")
    .get();
  assert.equal(pending.state, "pending");
  assert.ok(pending.next_attempt_at > Date.now());
  assert.doesNotMatch(
    JSON.stringify(result) + JSON.stringify(pending),
    /do-not-log-private-token/,
  );
  assert.equal(calls.filter((c) => c.init.method === "PATCH").length, 1);
});
