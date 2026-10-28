const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { FileInventoryAdapter } = require("../dist/src/sync/adapters/file.js");
const { validateCsvImport } = require("../dist/src/sync/csv-import.js");
const { exportRows, exportStock } = require("../dist/src/export.js");
const profile = {
  version: 1,
  delimiter: ";",
  encoding: "utf-8",
  decimalSeparator: ",",
  quantityKind: "on_hand",
  columns: {
    source_code: "Kód",
    quantity: "Počet",
    warehouse: "Sklad",
    observed_at: "Čas",
  },
};
const headers = "Kód;Počet;Sklad;Čas";
const row = "001;2,00;Bratislava;2026-10-28T12:00:00+01:00";
async function fixture(t, input, options = profile) {
  const dir = await mkdtemp(join(tmpdir(), "mapped-csv-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "input.csv");
  await writeFile(path, input);
  return {
    dir,
    path,
    adapter: new FileInventoryAdapter("file", path, options),
  };
}
test("mapped CSV preserves leading-zero SKUs and explicitly distinguishes on-hand from available stock", async (t) => {
  const { path, adapter } = await fixture(t, headers + "\n" + row);
  const [stock] = await adapter.read();
  assert.equal(stock.sku, "001");
  assert.equal(stock.location, "Bratislava");
  assert.equal(stock.onHand, 2);
  assert.equal(stock.available, null);
  assert.equal(stock.product, undefined);
  assert.throws(() => exportRows([stock]), /catalogue/);
  const [available] = await new FileInventoryAdapter("f", path, {
    ...profile,
    quantityKind: "available",
  }).read();
  assert.equal(available.available, 2);
  assert.equal(available.onHand, null);
});
test("mapped complete catalogue exports real decimal prices and preserves CSV/manifest on header drift", async (t) => {
  const options = {
    ...profile,
    columns: {
      ...profile.columns,
      name: "Názov",
      price: "Cena",
      currency: "Mena",
    },
  };
  const { dir, path, adapter } = await fixture(
    t,
    headers + ";Názov;Cena;Mena\n" + row + ";Čaj;12,50;EUR",
    options,
  );
  await exportStock(dir, exportRows(await adapter.read()), "file");
  const csv = await readFile(join(dir, "stock.csv"), "utf8"),
    manifest = await readFile(join(dir, "manifest.json"), "utf8");
  assert.match(csv, /"Čaj"/);
  assert.match(csv, /"12.5"/);
  await writeFile(
    path,
    "Changed;Počet;Sklad;Čas;Názov;Cena;Mena\n" + row + ";Čaj;12,50;EUR",
  );
  await assert.rejects(
    async () => exportStock(dir, exportRows(await adapter.read()), "file"),
    /column is missing/,
  );
  assert.equal(await readFile(join(dir, "stock.csv"), "utf8"), csv);
  assert.equal(await readFile(join(dir, "manifest.json"), "utf8"), manifest);
});
test("Central European Windows-1250 decoding is explicit and UTF-8 rejects invalid bytes", async (t) => {
  // CP1250: Kód;Počet;Sklad;Čas and Žilina. Independently encoded synthetic fixture.
  const bytes = Buffer.from(
    "4bf3643b506fe865743b536b6c61643bc861730a3030313b323b8e696c696e613b323032362d31302d32385431323a30303a30305a",
    "hex",
  );
  const { path, adapter } = await fixture(t, bytes, {
    ...profile,
    encoding: "windows-1250",
  });
  assert.equal((await adapter.read())[0].location, "Žilina");
  await assert.rejects(new FileInventoryAdapter("f", path, profile).read());
});
test("CSV formats support quoted delimiters, tabs and BOM without locale auto-detection", async (t) => {
  for (const delimiter of [";", "\t", "|", ","]) {
    const head = ["Kód", "Počet", "Sklad", "Čas"].join(delimiter);
    const data = [
      '"00' + delimiter + '1"',
      '"2,00"',
      "Main",
      "2026-10-28T12:00:00Z",
    ].join(delimiter);
    const { adapter } = await fixture(t, "\uFEFF" + head + "\r\n" + data, {
      ...profile,
      delimiter,
    });
    assert.equal((await adapter.read())[0].sku, "00" + delimiter + "1");
  }
});
test("mapped CSV refuses ambiguous quantities, duplicate headers/rows and timezone-less timestamps", async (t) => {
  for (const input of [
    headers + "\n" + row.replace("2,00", "1,5"),
    headers + "\n" + row.replace("2,00", "1.000"),
    headers + "\n" + row.replace("2,00", "1 000"),
    headers + "\n" + row.replace("2,00", ""),
    headers + "\n" + row.replace("2,00", "-1"),
    headers + "\n" + row.replace("2,00", "1e3"),
    headers + "\n" + row.replace("+01:00", ""),
    headers + "\n" + row + "\n" + row,
    headers + ";Kód\n" + row + ";001",
    headers + "\n",
  ])
    await assert.rejects((await fixture(t, input)).adapter.read());
});
test("profile validation refuses constants, executable transforms, unknown fields, aliases and partial catalogue mappings", () => {
  for (const input of [
    { ...profile, version: 2 },
    { ...profile, encoding: "utf-16" },
    { ...profile, delimiter: ";;" },
    { ...profile, quantityKind: "guessed" },
    { ...profile, columns: { ...profile.columns, name: "Name" } },
    { ...profile, columns: { ...profile.columns, quantity: "Kód" } },
    {
      ...profile,
      columns: { ...profile.columns, warehouse: { constant: "Main" } },
    },
    { ...profile, columns: { ...profile.columns, transform: "script" } },
    { ...profile, token: "never-persist" },
  ])
    assert.throws(() => validateCsvImport(input));
});
test("oversized file reads stop at the 16 MiB boundary", async (t) => {
  const { adapter } = await fixture(t, Buffer.alloc(16 * 1024 * 1024 + 1));
  await assert.rejects(adapter.read(), /16 MiB/);
});
