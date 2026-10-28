const { test } = require("node:test");
const assert = require("node:assert/strict");
const { OdooAdapter } = require("../dist/src/sync/adapters/odoo.js");
const quant = (id = 1, quantity = 3) => ({
  id,
  product_id: [7, "Display"],
  location_id: [9, "Stock"],
  quantity,
  available_quantity: quantity - 1,
});
function fixture({
  quants = [quant()],
  products = [{ id: 7, default_code: "SKU" }],
  auth = 4,
  error,
  inspect,
} = {}) {
  const calls = [];
  const adapter = new OdooAdapter(
    "o",
    "https://odoo.test",
    "merchant-db",
    "user",
    "private-key",
    async (url, init) => {
      assert.equal(url, "https://odoo.test/jsonrpc");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      const body = JSON.parse(init.body);
      calls.push(body);
      inspect?.(body);
      const result =
        body.params.service === "common"
          ? auth
          : body.params.args[3] === "stock.quant"
            ? quants
            : products;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          ...(error ? { error } : { result }),
        }),
      );
    },
  );
  return { adapter, calls };
}
test("Odoo authenticates and emits read-only search_read RPCs with explicit SKU/location identity", async () => {
  const { adapter, calls } = fixture();
  const [row] = await adapter.read();
  assert.equal(row.productKey, "7");
  assert.equal(row.sku, "SKU");
  assert.equal(row.location, "9");
  assert.equal(row.onHand, 3);
  assert.equal(row.available, 2);
  assert.equal(row.product, undefined);
  assert.deepEqual(calls[0].params, {
    service: "common",
    method: "authenticate",
    args: ["merchant-db", "user", "private-key", {}],
  });
  for (const c of calls.slice(1)) {
    assert.equal(c.params.method, "execute_kw");
    assert.equal(c.params.args[4], "search_read");
    assert.equal(c.params.args[6].order, "id asc");
  }
  assert.deepEqual(calls[1].params.args[5], [
    [["location_id.usage", "=", "internal"]],
  ]);
  assert.equal(adapter.write, undefined);
  assert.equal(adapter.capabilities.write, false);
});
test("Odoo aggregates lots in one location without inventing available stock", async () => {
  const { adapter } = fixture({ quants: [quant(1, 3), quant(2, 5)] });
  const rows = await adapter.read();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].onHand, 8);
  assert.equal(rows[0].available, 6);
});
test("Odoo rejects empty, fractional, negative, missing SKU, duplicate and incomplete responses", async () => {
  for (const opts of [
    { quants: [] },
    { quants: [quant(1, 1.5)] },
    { quants: [quant(1, -1)] },
    { products: [] },
    { products: [{ id: 7, default_code: false }] },
    { quants: [quant(), quant()] },
    { quants: [{ ...quant(), available_quantity: undefined }] },
    { quants: [{ ...quant(), location_id: false }] },
  ])
    await assert.rejects(fixture(opts).adapter.read());
});
test("Odoo targeted reads constrain both product and location and reject mismatched results", async () => {
  const { adapter, calls } = fixture();
  assert.equal((await adapter.readOne("7", "9")).onHand, 3);
  assert.deepEqual(calls[1].params.args[5][0].slice(1), [
    ["product_id", "=", 7],
    ["location_id", "=", 9],
  ]);
  await assert.rejects(adapter.readOne("8", "9"), /different mapped item/);
  await assert.rejects(adapter.readOne("bad", "9"), /numeric/);
  assert.equal(
    await fixture({ quants: [] }).adapter.readOne("7", "9"),
    undefined,
  );
});
test("Odoo authentication and RPC errors never echo vendor details or credentials", async () => {
  await assert.rejects(
    fixture({ auth: false }).adapter.read(),
    /authentication failed/,
  );
  await assert.rejects(
    fixture({ error: { data: { debug: "private-key" } } }).adapter.read(),
    (e) => !/private-key/.test(e.message),
  );
  assert.throws(() => new OdooAdapter("o", "http://odoo.test", "db", "u", "k"));
});
test("Odoo pagination advances offsets and refuses repeated pages", async () => {
  const pages = Array.from({ length: 100 }, (_, i) => quant(i + 1));
  let stockCalls = 0;
  const { adapter } = fixture({
    quants: pages,
    inspect: (body) => {
      if (body.params.args[3] === "stock.quant")
        assert.equal(body.params.args[6].offset, stockCalls++ * 100);
    },
  });
  await assert.rejects(adapter.read(), /repeated Odoo page/);
  assert.equal(stockCalls, 2);
});
