const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
test("CLI executes a real file-only export and fails incomplete input", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "stock.json");
  writeFileSync(
    path,
    JSON.stringify([
      {
        source_code: "SKU",
        name: "Catalogue",
        price: 1,
        currency: "EUR",
        quantity: 2,
        warehouse: "w",
        observed_at: "2026-10-28T12:00:00Z",
      },
    ]),
  );
  const config = join(dir, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      connections: [{ id: "file", platform: "file", stockPath: path }],
      groups: [],
      databasePath: join(dir, "state", "db"),
      exportDirectory: join(dir, "output"),
    }),
  );
  let result = spawnSync(
    process.execPath,
    [resolve("dist/src/sync/cli.js"), config],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"export":"ok"/);
  const before = readFileSync(join(dir, "output/file/stock.csv"), "utf8");
  writeFileSync(path, "[]");
  result = spawnSync(
    process.execPath,
    [resolve("dist/src/sync/cli.js"), config],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(
    readFileSync(join(dir, "output/file/stock.csv"), "utf8"),
    before,
  );
});
