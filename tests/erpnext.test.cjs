const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ErpNextAdapter } = require("../dist/src/sync/adapters/erpnext.js");
const bin = (n = 2) => ({
  name: "BIN-1",
  item_code: "SKU",
  warehouse: "Main",
  actual_qty: n,
  stock_uom: "Nos",
});
test("ERPNext uses GET-only authenticated REST and explicit actual stock semantics", async () => {
  const a = new ErpNextAdapter(
    "erp",
    "https://erp.test",
    "key",
    "private-secret",
    async (url, init) => {
      assert.equal(init.method, "GET");
      assert.equal(init.headers.Authorization, "token key:private-secret");
      assert.equal(init.redirect, "error");
      assert.doesNotMatch(url, /private-secret/);
      const q = new URL(url);
      assert.equal(q.pathname, "/api/resource/Bin");
      assert.deepEqual(JSON.parse(q.searchParams.get("fields")), [
        "name",
        "item_code",
        "warehouse",
        "actual_qty",
        "stock_uom",
      ]);
      return new Response(JSON.stringify({ data: [bin()] }));
    },
  );
  const rows = await a.read();
  assert.equal(rows[0].onHand, 2);
  assert.equal(rows[0].available, null);
  assert.equal(rows[0].product, undefined);
  assert.equal(a.capabilities.write, false);
  assert.equal(a.write, undefined);
});
test("ERPNext pagination preserves distinct warehouse stock and uses stable ordering", async () => {
  let calls = 0;
  const a = new ErpNextAdapter(
    "e",
    "https://erp.test",
    "k",
    "s",
    async (url) => {
      const q = new URL(url);
      assert.equal(q.searchParams.get("order_by"), "name asc");
      const start = Number(q.searchParams.get("limit_start"));
      calls++;
      return new Response(
        JSON.stringify({
          data:
            start === 0
              ? Array.from({ length: 100 }, (_, i) => ({
                  ...bin(),
                  item_code: "SKU-" + i,
                }))
              : [],
        }),
      );
    },
  );
  assert.equal((await a.read()).length, 100);
  assert.equal(calls, 2);
});
test("ERPNext rejects empty, fractional, negative, duplicate and incomplete stock", async () => {
  for (const data of [
    [],
    [bin(1.5)],
    [bin(-1)],
    [bin(), bin()],
    [{ ...bin(), warehouse: "" }],
    [{ ...bin(), stock_uom: "" }],
  ]) {
    const a = new ErpNextAdapter(
      "e",
      "https://erp.test",
      "k",
      "s",
      async () => new Response(JSON.stringify({ data })),
    );
    await assert.rejects(a.read());
  }
});
test("ERPNext targeted queries use explicit item and warehouse filters", async () => {
  const a = new ErpNextAdapter(
    "e",
    "https://erp.test",
    "k",
    "s",
    async (url) => {
      assert.deepEqual(JSON.parse(new URL(url).searchParams.get("filters")), [
        ["item_code", "=", "SKU"],
        ["warehouse", "=", "Main"],
      ]);
      return new Response(JSON.stringify({ data: [bin(0)] }));
    },
  );
  assert.equal((await a.readOne("SKU", "Main")).onHand, 0);
});
test("ERPNext HTTP errors never return server body secrets and credentials cannot be embedded in URLs", async () => {
  const a = new ErpNextAdapter(
    "e",
    "https://erp.test",
    "k",
    "s",
    async () => new Response("private server details", { status: 403 }),
  );
  await assert.rejects(a.read(), (e) => e.message === "ERPNext HTTP 403");
  assert.throws(
    () => new ErpNextAdapter("e", "https://user:password@erp.test", "k", "s"),
  );
  assert.throws(() => new ErpNextAdapter("e", "https://erp.test", "k\n", "s"));
});
