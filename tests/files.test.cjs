const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { exportStock } = require("../dist/src/export.js");
const { FileInventoryAdapter } = require("../dist/src/sync/adapters/file.js");
const product = {
  source_code: "SKU",
  name: "Real product",
  price: 12,
  currency: "EUR",
  quantity: 2,
};
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("valid export writes stock.csv with matching manifest checksum", async (t) => {
  const dir = await temp(t);
  await exportStock(dir, [product], "source");
  const csv = await readFile(join(dir, "stock.csv"));
  const m = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  assert.equal(m.sha256, createHash("sha256").update(csv).digest("hex"));
  assert.equal(m.product_count, 1);
});
test("empty/incomplete/duplicate data preserves previous valid export and manifest", async (t) => {
  const dir = await temp(t);
  await exportStock(dir, [product], "source");
  const before = await readFile(join(dir, "stock.csv"), "utf8"),
    manifest = await readFile(join(dir, "manifest.json"), "utf8");
  for (const rows of [
    [],
    [{ ...product, name: "" }],
    [{ ...product, price: undefined }],
    [{ ...product, currency: "" }],
    [{ ...product, quantity: -1 }],
    [product, product],
  ]) {
    await assert.rejects(exportStock(dir, rows, "source"));
    assert.equal(await readFile(join(dir, "stock.csv"), "utf8"), before);
    assert.equal(await readFile(join(dir, "manifest.json"), "utf8"), manifest);
  }
});
test("CSV and XML handover schemas parse exact quantities and catalogue metadata", async (t) => {
  const dir = await temp(t);
  for (const [extension, input] of [
    [
      "csv",
      "source_code,name,price,currency,quantity,warehouse,observed_at\nSKU,Real product,12,EUR,2,main,2026-10-28T12:00:00Z\n",
    ],
    [
      "xml",
      "<inventory><product><source_code>SKU</source_code><name>Real product</name><price>12</price><currency>EUR</currency><quantity>2</quantity><warehouse>main</warehouse><observed_at>2026-10-28T12:00:00Z</observed_at></product></inventory>",
    ],
  ]) {
    const path = join(dir, "input." + extension);
    await writeFile(path, input);
    const rows = await new FileInventoryAdapter("f", path).read();
    assert.equal(rows[0].available, 2);
    assert.deepEqual(JSON.parse(JSON.stringify(rows[0].product)), product);
  }
});
test("CSV missing quantity, missing warehouse or XML entities are refused", async (t) => {
  const dir = await temp(t);
  for (const [ext, input] of [
    [
      "csv",
      "source_code,name,price,currency,quantity,warehouse,observed_at\nSKU,Name,12,EUR,,main,2026-10-28T12:00:00Z",
    ],
    [
      "csv",
      "source_code,name,price,currency,quantity,warehouse,observed_at\nSKU,Name,12,EUR,1,,2026-10-28T12:00:00Z",
    ],
    [
      "xml",
      '<!DOCTYPE inventory [<!ENTITY x SYSTEM "file:///secret">]><inventory>&x;</inventory>',
    ],
  ]) {
    const path = join(dir, "bad." + ext);
    await writeFile(path, input);
    await assert.rejects(new FileInventoryAdapter("f", path).read());
  }
});
test("observation/catalogue quantity mismatch is refused rather than invented", () => {
  const { exportRows } = require("../dist/src/export.js");
  assert.throws(
    () =>
      exportRows([
        {
          productKey: "SKU",
          sku: "SKU",
          available: 5,
          onHand: 5,
          product: { ...product, quantity: 2 },
        },
      ]),
    /agree/,
  );
});
test("concurrent exports serialize and leave a matching CSV/manifest pair", async (t) => {
  const dir = await temp(t);
  await Promise.all([
    exportStock(dir, [product], "one"),
    exportStock(dir, [{ ...product, quantity: 4 }], "two"),
  ]);
  const bytes = await readFile(join(dir, "stock.csv")),
    manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.source_id, "two");
  assert.equal(
    manifest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
});
