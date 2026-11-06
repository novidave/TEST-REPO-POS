const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DesktopService } = require("../dist/src/desktop.js");
const { CredentialVault } = require("../dist/src/security.js");
const { readPublishedExport } = require("../dist/src/export.js");
const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(v),
  decryptString: (b) => b.toString(),
};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "local-inv-"));
  const service = new DesktopService(
    dir,
    new CredentialVault(join(dir, "c"), cipher),
  );
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, service };
}
test("products, adjustments, history and barcode lookup keep stock whole and nonnegative", async (t) => {
  const { service } = await fixture(t);
  assert.throws(
    () =>
      service.localSaveProduct({
        sku: "A",
        name: "A",
        price: 1,
        currency: "EUX",
      }),
    /ISO 4217/,
  );
  assert.throws(
    () =>
      service.localSaveProduct({
        sku: "A",
        name: "A",
        price: -1,
        currency: "EUR",
      }),
    /nonnegative/,
  );
  service.localSaveProduct({
    sku: "A",
    name: "Alpha",
    ean: "4006381333931",
    price: "2,50",
    currency: "EUR",
  });
  assert.throws(
    () =>
      service.localSaveProduct({
        sku: "B",
        name: "Beta",
        ean: "4006381333931",
        price: 1,
        currency: "EUR",
      }),
    /already belongs/,
  );
  assert.equal(service.localLookup("4006381333931").sku, "A");
  assert.equal(service.localLookup("A").price, 2.5);
  assert.equal(service.localLookup("nope"), null);
  assert.deepEqual(
    service.localAdjust({
      sku: "4006381333931",
      location: "Shop",
      set: 10,
      reason: "count",
    }),
    { sku: "A", location: "Shop", before: 0, after: 10 },
  );
  assert.equal(
    service.localAdjust({
      sku: "A",
      location: "Shop",
      delta: -3,
      reason: "sale",
    }).after,
    7,
  );
  assert.throws(
    () => service.localAdjust({ sku: "A", location: "Shop", delta: -8 }),
    /below zero/,
  );
  assert.throws(
    () => service.localAdjust({ sku: "A", location: "Shop", delta: 1.5 }),
    /whole/,
  );
  assert.throws(
    () => service.localAdjust({ sku: "A", location: "Shop", delta: 1, set: 2 }),
    /either/,
  );
  const inv = service.localInventory();
  assert.deepEqual(inv.locations, ["Shop"]);
  assert.equal(inv.stock[0].quantity, 7);
  assert.deepEqual(
    inv.movements.map((m) => [m.delta, m.quantity_after, m.reason]),
    [
      [-3, 7, "sale"],
      [10, 10, "count"],
    ],
  );
});
test("CSV import is validated completely before any change and feeds the folder export", async (t) => {
  const { service, dir } = await fixture(t);
  const bad = join(dir, "bad.csv");
  await writeFile(
    bad,
    "sku,name,ean,price,currency,location,quantity\nA,Alpha,,1,EUR,Shop,2\nB,Beta,,1,EUR,Shop,-1\n",
  );
  await assert.rejects(service.localImport(bad), /Row 3/);
  assert.equal(service.localInventory().products, 0, "nothing applied");
  const good = join(dir, "good.csv");
  await writeFile(
    good,
    "sku,name,ean,price,currency,location,quantity\nA,Alpha,,1.20,EUR,Shop,2\nB,Beta,4006381333931,3,EUR,Shop,0\n",
  );
  assert.deepEqual(await service.localImport(good), { rows: 2, products: 2 });
  const c = await service.saveConnection({
    name: "Local",
    platform: "local",
    permission: "read",
  });
  await assert.rejects(
    service.saveConnection({
      name: "Local W",
      platform: "local",
      permission: "read_write",
    }),
    /read-only/,
  );
  const r = await service.exportNow(c.id);
  assert.equal(r.state, "ok");
  const published = await readPublishedExport(join(dir, "exports", c.id));
  assert.equal(published.state, "ok");
  assert.match(
    published.csv,
    /"B","Beta","4006381333931","3","EUR","0","Shop","out_of_stock"/,
  );
});
