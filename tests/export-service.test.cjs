const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile, readFile, readdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");
const { DesktopService } = require("../dist/src/desktop.js");
const { CredentialVault } = require("../dist/src/security.js");
const { readPublishedExport, exportStock } = require("../dist/src/export.js");
const { normalizeInventory, gtinChecksumValid } = require("../dist/src/inventory/normalize.js");
const { redact } = require("../dist/src/redact.js");

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from("enc:" + v),
  decryptString: (b) => b.toString().slice(4),
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
let settleHooks = [];
async function settle() {
  for (let i = 0; i < 20; i++) await turn();
  for (let i = 0; i < 500 && settleHooks.some((busy) => busy()); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  for (let i = 0; i < 5; i++) await turn();
}
function fakeClock(start = Date.parse("2026-11-06T08:00:00Z")) {
  let now = start,
    seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, delay) => {
      const id = ++seq;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    timers,
    pending: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const next = [...timers]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}
const header = "source_code,name,ean,price,currency,quantity,warehouse,observed_at\n";
const row = (sku, qty, wh = "main", extra = {}) =>
  [sku, extra.name ?? "Product " + sku, extra.ean ?? "", extra.price ?? "9.90", extra.currency ?? "EUR", qty, wh, "2026-11-06T07:55:00Z"].join(",");
async function fixture(t, clock = fakeClock(), dir) {
  dir ??= await mkdtemp(join(tmpdir(), "export-svc-"));
  const service = new DesktopService(dir, new CredentialVault(join(dir, "credentials"), cipher), {
    exportClock: clock,
  });
  const busy = () => {
    try {
      return service.exports.status().running.length > 0;
    } catch {
      return false;
    }
  };
  settleHooks.push(busy);
  t.after(async () => {
    settleHooks = settleHooks.filter((h) => h !== busy);
    await service.close();
  });
  return { dir, service, clock };
}
const sha = (s) => createHash("sha256").update(s).digest("hex");

test("normalization keeps every source value, validates ISO currency and never sums warehouses", () => {
  const stock = (sku, location, qty, product = {}) => ({
    productKey: sku,
    sku,
    location,
    onHand: null,
    available: qty,
    observedAt: "2026-11-06T07:00:00+01:00",
    product: { source_code: sku, name: "N " + sku, price: 2.5, currency: "EUR", quantity: qty, ...product },
  });
  const ok = normalizeInventory("c1", [stock("A", "w1", 3), stock("B", "w1", 0)]);
  assert.equal(ok.complete, true);
  assert.deepEqual(
    ok.items.map((i) => [i.sku, i.quantity, i.availabilityStatus, i.currency, i.sourceUpdatedAt]),
    [
      ["A", 3, "in_stock", "EUR", "2026-11-06T06:00:00.000Z"],
      ["B", 0, "out_of_stock", "EUR", "2026-11-06T06:00:00.000Z"],
    ],
  );
  assert.equal(ok.sourceTime, "2026-11-06T06:00:00.000Z");

  const multi = normalizeInventory("c1", [stock("A", "w1", 3), stock("A", "w2", 4)]);
  assert.equal(multi.complete, false);
  assert.equal(multi.issues[0].code, "multiple_warehouses");
  const one = normalizeInventory("c1", [stock("A", "w1", 3), stock("A", "w2", 4)], { warehouse: "w2" });
  assert.equal(one.complete, true);
  assert.deepEqual(one.items.map((i) => [i.warehouse, i.quantity]), [["w2", 4]]);
  assert.equal(normalizeInventory("c1", [stock("A", "w1", 3)], { warehouse: "w9" }).issues[0].code, "warehouse_not_found");

  const bad = normalizeInventory("c1", [stock("A", "w1", 3, { currency: "EUX" })]);
  assert.equal(bad.complete, false);
  assert.equal(bad.issues[0].code, "invalid_currency");
  const noCatalogue = normalizeInventory("c1", [{ ...stock("A", "w1", 1), product: undefined }]);
  assert.equal(noCatalogue.issues[0].code, "missing_catalogue");
  assert.equal(normalizeInventory("c1", []).issues[0].code, "empty");

  const eans = normalizeInventory("c1", [
    stock("A", "w1", 1, { ean: "4006381333931" }),
    stock("B", "w1", 1, { ean: "4006381333931" }),
    stock("C", "w1", 1, { ean: "4006381333932" }),
  ]);
  assert.equal(eans.complete, true);
  assert.deepEqual(eans.issues.map((i) => i.code).sort(), ["duplicate_ean", "ean_checksum"]);
  assert.equal(gtinChecksumValid("4006381333931"), true);
  assert.equal(gtinChecksumValid("ABC"), null);
});

test("published export carries manifest protocol fields and a reader detects tampering", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "publish-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "stock.csv.00000000-0000-0000-0000-000000000000.tmp"), "stale");
  const result = await exportStock(
    dir,
    [{ source_code: "A", name: "Alpha", price: 1, currency: "EUR", quantity: 2, warehouse: "main", availability_status: "in_stock", source_updated_at: "2026-11-06T07:00:00.000Z" }],
    "src",
    { sourceTime: "2026-11-06T07:00:00.000Z" },
  );
  const files = await readdir(dir);
  assert.deepEqual(files.sort(), ["manifest.json", "stock.csv"], "stale temporary removed");
  const csv = await readFile(join(dir, "stock.csv"), "utf8");
  assert.match(csv, /^source_code,name,ean,price,currency,quantity,warehouse,availability_status,source_updated_at\r\n/);
  const published = await readPublishedExport(dir);
  assert.equal(published.state, "ok");
  assert.equal(published.manifest.snapshot_id, result.snapshotId);
  assert.equal(published.manifest.complete, true);
  assert.equal(published.manifest.product_count, 1);
  assert.equal(published.manifest.sha256, sha(csv));
  assert.equal(published.manifest.publication, "manifest-last");
  await writeFile(join(dir, "stock.csv"), csv.replace('"2"', '"3"'));
  assert.equal((await readPublishedExport(dir)).state, "incomplete");
});

test("scheduled export runs at the default interval, records history and resumes after restart", async (t) => {
  const { service, dir, clock } = await fixture(t);
  const source = join(dir, "pos.csv");
  await writeFile(source, header + row("A", 5) + "\n" + row("B", 0) + "\n");
  const c = await service.saveConnection({ name: "POS", platform: "file", stockPath: source, permission: "read" });
  const job = await service.saveExportJob({ connectionId: c.id, enabled: true });
  assert.equal(job.intervalMinutes, 15, "default interval");
  // First run is overdue (never attempted) and starts within the 5–35 s startup spread.
  assert.ok(clock.pending()[0] <= 35000);
  await clock.advance(35000);
  const out = join(dir, "exports", c.id);
  const published = await readPublishedExport(out);
  assert.equal(published.state, "ok");
  assert.equal(published.manifest.product_count, 2);
  let snap = service.snapshot();
  assert.equal(snap.exportRuns[0].state, "ok");
  assert.equal(snap.exportRuns[0].trigger, "schedule");
  assert.equal(snap.exportRuns[0].sha256, published.manifest.sha256);
  assert.equal(snap.overview.exportedProducts, 2);
  assert.equal(snap.overview.connections[0].health, "healthy");
  assert.ok(snap.overview.connections[0].lastReadAt);
  // The next run is planned one interval after the attempt, not during it.
  const next = Date.parse(snap.exportJobs[0].nextRunAt) - Date.parse(snap.exportJobs[0].lastAttemptAt);
  assert.equal(next, 15 * 60000);
  assert.equal(service.products(c.id).lastSnapshot.length, 2);

  await service.close();
  const clock2 = fakeClock(clock.now() + 20 * 60000);
  const reopened = await fixture(t, clock2, dir);
  await reopened.service.restartSchedules();
  assert.equal(reopened.service.snapshot().exportJobs[0].enabled, true);
  assert.ok(clock2.pending()[0] <= 35000, "overdue schedule resumes promptly");
  await clock2.advance(35000);
  assert.equal(reopened.service.snapshot().exportRuns.filter((r) => r.state === "ok").length, 2);
});

test("incomplete or invalid reads are held, preserve the last export and retry with backoff", async (t) => {
  const { service, dir, clock } = await fixture(t);
  const source = join(dir, "pos.csv");
  await writeFile(source, header + row("A", 5) + "\n");
  const c = await service.saveConnection({ name: "POS", platform: "file", stockPath: source, permission: "read" });
  await service.saveExportJob({ connectionId: c.id, enabled: true, intervalMinutes: 30 });
  await clock.advance(35000);
  const out = join(dir, "exports", c.id);
  const before = [await readFile(join(out, "stock.csv"), "utf8"), await readFile(join(out, "manifest.json"), "utf8")];

  for (const broken of [
    header, // empty
    header + row("A", "") + "\n", // unknown quantity is never zero
    header + row("A", 5, "main", { currency: "" }) + "\n", // missing currency
    header + row("A", 5, "main", { price: "" }) + "\n", // missing price
  ]) {
    await writeFile(source, broken);
    const r = await service.exportNow(c.id);
    assert.notEqual(r.state, "ok");
    assert.equal(await readFile(join(out, "stock.csv"), "utf8"), before[0]);
    assert.equal(await readFile(join(out, "manifest.json"), "utf8"), before[1]);
  }
  const job = service.snapshot().exportJobs[0];
  assert.equal(job.consecutiveFailures, 4);
  // Backoff 1,2,4,8 min capped by the 30 min interval.
  assert.equal(Date.parse(job.nextRunAt) - Date.parse(job.lastAttemptAt), 8 * 60000);
  assert.ok(service.snapshot().overview.errors.length === 1);
  await writeFile(source, header + row("A", 4) + "\n");
  await clock.advance(8 * 60000);
  const runs = service.snapshot().exportRuns;
  assert.equal(runs[0].state, "ok");
  assert.equal(runs[0].trigger, "retry");
  assert.equal(service.snapshot().exportJobs[0].consecutiveFailures, 0);
  assert.equal(service.snapshot().overview.errors.length, 0);
});

test("overlapping exports are prevented and the shrink guard holds a suspicious snapshot", async (t) => {
  const { service, dir } = await fixture(t);
  const source = join(dir, "pos.csv");
  await writeFile(source, header + ["A", "B", "C", "D"].map((s) => row(s, 1)).join("\n") + "\n");
  const c = await service.saveConnection({ name: "POS", platform: "file", stockPath: source, permission: "read" });
  const [first, second] = await Promise.allSettled([service.exportNow(c.id), service.exportNow(c.id)]);
  assert.equal(first.value.state, "ok");
  assert.match(second.reason.message, /already running/);
  await writeFile(source, header + row("A", 1) + "\n");
  const held = await service.exportNow(c.id);
  assert.equal(held.state, "held");
  assert.match(held.message, /1 products vs 4/);
  const forced = await service.exportNow(c.id, true);
  assert.equal(forced.state, "ok");
  assert.equal(forced.count, 1);
});

test("interval and folder validation, persisted Start/Stop and interrupted-run recovery", async (t) => {
  const { service, dir, clock } = await fixture(t);
  const source = join(dir, "pos.csv");
  await writeFile(source, header + row("A", 1) + "\n");
  const c = await service.saveConnection({ name: "POS", platform: "file", stockPath: source, permission: "read" });
  for (const intervalMinutes of [4, 1441, 7.5])
    await assert.rejects(service.saveExportJob({ connectionId: c.id, intervalMinutes }), /Interval/);
  await assert.rejects(service.saveExportJob({ connectionId: c.id, directory: "relative/out" }), /absolute/);
  const custom = join(dir, "handover");
  const job = await service.saveExportJob({ connectionId: c.id, enabled: true, intervalMinutes: 45, directory: custom });
  assert.equal(job.intervalMinutes, 45);
  assert.equal(service.setSchedulerPaused(true).paused, true);
  assert.equal(clock.timers.size, 0, "stopped scheduler keeps no timers");
  service.store.db
    .prepare("INSERT INTO export_runs(connection_id,trigger,started_at,state) VALUES(?,?,?,'running')")
    .run(c.id, "schedule", new Date().toISOString());
  await service.close();
  const reopened = await fixture(t, fakeClock(), dir);
  await reopened.service.restartSchedules();
  assert.equal(reopened.service.snapshot().settings.schedulerPaused, true);
  assert.equal(reopened.clock.timers.size, 0);
  assert.equal(reopened.service.snapshot().exportRuns[0].state, "failed");
  reopened.service.setSchedulerPaused(false);
  await reopened.clock.advance(35000);
  assert.equal((await readPublishedExport(custom)).state, "ok");
});

test("negative quantities follow the explicit source rule and logs never store secrets", async (t) => {
  const { service, dir } = await fixture(t);
  const source = join(dir, "pos.csv");
  await writeFile(source, header + row("A", -2) + "\n" + row("B", 3) + "\n");
  const c = await service.saveConnection({ name: "POS", platform: "file", stockPath: source, permission: "read" });
  assert.notEqual((await service.exportNow(c.id)).state, "ok", "default rule rejects negatives");
  await service.saveConnection({ ...c, negativeStock: "zero" });
  const r = await service.exportNow(c.id);
  assert.equal(r.state, "ok");
  const csv = await readFile(join(dir, "exports", c.id, "stock.csv"), "utf8");
  assert.match(csv, /"A","Product A","","9.9","EUR","0","main","out_of_stock"/);
  await assert.rejects(service.saveConnection({ name: "W", platform: "woocommerce", baseUrl: "https://x.test", permission: "read", negativeStock: "zero" }), /Negative stock/);

  service.log("cloud_test", { id: "x", token: "cdt_abcdefghijklmnop", note: "Authorization: Bearer abc.def.ghi123", url: "https://user:pass@host/x?token=zzz" });
  const stored = JSON.stringify(service.snapshot().logs[0]);
  assert.doesNotMatch(stored, /abcdefghijklmnop|abc\.def\.ghi123|user:pass|zzz/);
  assert.deepEqual(redact({ nested: { password: "p", list: ["shpat_0123456789abcdef"] } }), {
    nested: { password: "[redacted]", list: ["shpat_[redacted]"] },
  });
});

test("settings validation and credential-free mapping configuration export/import", async (t) => {
  const { service, dir } = await fixture(t);
  assert.throws(() => service.updateSettings({ unknown: 1 }), /Unknown setting/);
  assert.throws(() => service.updateSettings({ exportRoot: "out" }), /absolute/);
  assert.throws(() => service.updateSettings({ language: "xx" }), /language/);
  assert.equal(service.updateSettings({ language: "sk", defaultIntervalMinutes: 30 }).language, "sk");
  const source = join(dir, "pos.csv");
  await writeFile(source, header + row("A", 1) + "\n");
  const file = await service.saveConnection({ name: "POS", platform: "file", stockPath: source, permission: "read", productMappings: { A: "shared-a" } });
  await service.saveConnection({ name: "Shop", platform: "shopify", shopDomain: "x.myshopify.com", permission: "read", token: "shpat_secretvalue123" });
  await service.saveExportJob({ connectionId: file.id, enabled: true, warehouse: "main" });
  const config = service.mappingConfig();
  assert.doesNotMatch(JSON.stringify(config), /shpat_|secretvalue|enc:/);
  assert.equal(config.exportJobs[0].intervalMinutes, 30, "new default interval applied");
  config.connections[0].productMappings = { A: "shared-b" };
  const result = await service.importMappingConfig(config);
  assert.equal(result.connections, 2);
  assert.deepEqual(service.connections()[0].productMappings, { A: "shared-b" });
  assert.equal(service.snapshot().exportJobs[0].enabled, false, "imported schedules stay disabled");
  await assert.rejects(service.importMappingConfig({ format: "other" }), /Unsupported/);
});
