const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  WooCommerceAdapter,
} = require("../dist/src/sync/adapters/woocommerce.js");
const { ShopifyAdapter } = require("../dist/src/sync/adapters/shopify.js");
test("WooCommerce paginates stock-managed variants with authorization header and strict stock", async () => {
  const requests = [];
  const http = async (url, init) => {
    requests.push({ url, init });
    return new Response(
      JSON.stringify(
        url.includes("/variations")
          ? [{ id: 2, sku: "V2", manage_stock: true, stock_quantity: 4 }]
          : [{ id: 1, type: "variable" }],
      ),
      { status: 200 },
    );
  };
  const a = new WooCommerceAdapter(
    "woo",
    "https://shop.test",
    "key",
    "secret",
    http,
  );
  const rows = await a.read();
  assert.equal(rows[0].productKey, "1:2");
  assert.equal(rows[0].available, 4);
  assert.equal(
    requests[0].init.headers.authorization,
    "Basic " + Buffer.from("key:secret").toString("base64"),
  );
  assert.equal(requests[0].init.redirect, "error");
  assert.doesNotMatch(requests[0].url, /secret|key/);
});
test("WooCommerce HTTP failures and incomplete managed stock are explicit", async () => {
  const a = new WooCommerceAdapter(
    "woo",
    "https://shop.test",
    "key",
    "secret",
    async () => new Response("private echoed credential", { status: 429 }),
  );
  await assert.rejects(a.read(), /^Error: WooCommerce HTTP 429$/);
  const b = new WooCommerceAdapter(
    "woo",
    "https://shop.test",
    "key",
    "secret",
    async () =>
      new Response(
        JSON.stringify([
          {
            id: 1,
            type: "simple",
            sku: "SKU",
            manage_stock: true,
            stock_quantity: null,
          },
        ]),
      ),
  );
  await assert.rejects(b.read(), /Incomplete/);
});
test("Shopify paginates inventory locations and uses atomic compareQuantity", async () => {
  const requests = [];
  const http = async (url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    let data;
    if (request.query.includes("inventoryItems("))
      data = {
        inventoryItems: {
          edges: [{ node: { id: "gid://InventoryItem/1", sku: "SKU" } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    else if (request.query.includes("inventorySetQuantities("))
      data = { inventorySetQuantities: { userErrors: [] } };
    else
      data = {
        inventoryItem: {
          inventoryLevels: {
            edges: [
              {
                node: {
                  location: { id: request.variables.after ? "loc2" : "loc1" },
                  quantities: [{ name: "available", quantity: 4 }],
                },
              },
            ],
            pageInfo: {
              hasNextPage: !request.variables.after,
              endCursor: request.variables.after ? null : "next",
            },
          },
        },
      };
    return new Response(JSON.stringify({ data }));
  };
  const a = new ShopifyAdapter(
    "shop",
    "test.myshopify.com",
    "token",
    "2026-07",
    http,
  );
  const rows = await a.read();
  assert.deepEqual(
    rows.map((r) => r.location),
    ["loc1", "loc2"],
  );
  await a.write([
    {
      productKey: rows[0].productKey,
      location: "loc1",
      quantity: 3,
      expectedRevision: "4",
      operationId: "stable",
    },
  ]);
  const input = requests.at(-1).variables.input;
  assert.equal(input.quantities[0].compareQuantity, 4);
  assert.equal(input.quantities[0].quantity, 3);
  assert.match(input.referenceDocumentUri, /stable/);
});
test("Shopify refuses missing revisions and reports user errors", async () => {
  let requests = 0;
  const a = new ShopifyAdapter(
    "shop",
    "test.myshopify.com",
    "token",
    "2026-07",
    async () => {
      requests++;
      return new Response(
        JSON.stringify({
          data: {
            inventorySetQuantities: {
              userErrors: [{ message: "compare mismatch" }],
            },
          },
        }),
      );
    },
  );
  await assert.rejects(
    a.write([
      { productKey: "p", location: "w", quantity: 3, operationId: "op" },
    ]),
    /revision/,
  );
  assert.equal(requests, 0);
  await assert.rejects(
    a.write([
      {
        productKey: "p",
        location: "w",
        quantity: 3,
        expectedRevision: "4",
        operationId: "op",
      },
    ]),
    /rejected/,
  );
});
