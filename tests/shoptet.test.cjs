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
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      assert.doesNotMatch(url, /private-token/);
      let data =
        q.pathname === "/api/eshop"
          ? { contactInformation: { eshopId } }
          : q.pathname === "/api/stocks"
            ? { stocks: [{ id: 1 }] }
            : paged(rows);
      const override = await handler?.(q, calls.length);
      if (override instanceof Response) return override;
      if (override !== undefined) data = override;
      return new Response(JSON.stringify({ data, errors: null, metadata: {} }));
    },
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
