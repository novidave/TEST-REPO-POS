const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { DesktopService } = require("../dist/src/desktop.js");
const { CredentialVault } = require("../dist/src/security.js");
const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: () => Buffer.from("opaque-ciphertext"),
  decryptString: () =>
    JSON.stringify({ token: "private-token", secret: "private-secret" }),
};
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "desktop-"));
  const service = new DesktopService(
    dir,
    new CredentialVault(join(dir, "credentials"), cipher),
  );
  t.after(async () => {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, service };
}
test("connection persistence exposes public metadata only and test reads never writes", async (t) => {
  const { service, dir } = await fixture(t);
  const c = await service.saveConnection({
    name: "Woo",
    platform: "woocommerce",
    baseUrl: "https://shop.test",
    permission: "read",
    token: "private-token",
    secret: "private-secret",
    password: "DROP-ME",
  });
  assert.doesNotMatch(
    JSON.stringify(service.snapshot()),
    /private-token|private-secret|DROP-ME/,
  );
  assert.doesNotMatch(
    await readFile(join(dir, "credentials"), "utf8"),
    /private-token/,
  );
  const a = await service.adapter(c.id);
  assert.equal(a.capabilities.write, false);
  assert.equal(a.write, undefined);
});
test("setup-required connectors report accurate state without any vendor request", async (t) => {
  const { service } = await fixture(t);
  for (const platform of ["pos", "shoptet", "cacaduu"]) {
    const c = await service.saveConnection({
      name: platform,
      platform,
      permission: "read",
    });
    assert.equal((await service.testConnection(c.id)).state, "setup_required");
  }
});
test("local CSV connection can test, inspect and export without cloud or credentials", async (t) => {
  const { service, dir } = await fixture(t);
  const path = join(dir, "input.csv");
  await writeFile(
    path,
    "source_code,name,price,currency,quantity,warehouse,observed_at\nS1,Real catalogue item,10,EUR,2,main,2026-10-28T12:00:00Z\n",
  );
  const c = await service.saveConnection({
    name: "File",
    platform: "file",
    stockPath: path,
    permission: "read",
  });
  assert.equal(
    (await service.testConnection(c.id)).state,
    "authenticated_read_ok",
  );
  assert.equal((await service.inspect(c.id))[0].quantity, 2);
  await service.exportLocal(c.id);
  assert.match(
    await readFile(join(dir, "exports", c.id, "stock.csv"), "utf8"),
    /Real catalogue item/,
  );
  await writeFile(
    path,
    "source_code,name,price,currency,quantity,warehouse,observed_at\nS1,Real catalogue item,,EUR,2,main,2026-10-28T12:00:00Z\n",
  );
  await assert.rejects(service.exportLocal(c.id));
  assert.match(
    await readFile(join(dir, "exports", c.id, "stock.csv"), "utf8"),
    /Real catalogue item/,
  );
});
test("connection IDs cannot escape output directory; credentials are refused without encryption", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(
    service.saveConnection({
      id: "../../outside",
      name: "X",
      platform: "file",
      stockPath: "x",
      permission: "read",
    }),
  );
  const dir = await mkdtemp(join(tmpdir(), "no-cipher-"));
  const disabled = new DesktopService(
    dir,
    new CredentialVault(join(dir, "vault"), {
      ...cipher,
      isEncryptionAvailable: () => false,
    }),
  );
  try {
    await assert.rejects(
      disabled.saveConnection({
        name: "Shop",
        platform: "shopify",
        shopDomain: "example.myshopify.com",
        permission: "read",
        token: "secret",
      }),
    );
    assert.equal(disabled.connections().length, 0);
  } finally {
    await disabled.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("group validation persists maps and refuses read-only destinations / unsafe two-way", async (t) => {
  const { service } = await fixture(t);
  const a = await service.saveConnection({
      name: "Source",
      platform: "file",
      stockPath: "x.csv",
      permission: "read",
    }),
    b = await service.saveConnection({
      name: "Shop",
      platform: "shopify",
      shopDomain: "example.myshopify.com",
      permission: "read_write",
      token: "private-token",
    });
  const group = {
    id: "test",
    mode: "master",
    masterId: a.id,
    members: [
      { connectionId: a.id, role: "source" },
      { connectionId: b.id, role: "destination" },
    ],
    enabled: false,
    intervalMinutes: 1,
    mappings: { [a.id]: { p: "shared" }, [b.id]: { p: "shared" } },
    locationMappings: { [a.id]: { w: "shared" }, [b.id]: { w: "shared" } },
  };
  await service.saveGroup(group);
  assert.equal(service.groups()[0].locationMappings[a.id].w, "shared");
  await assert.rejects(
    service.saveGroup({
      ...group,
      mode: "two_way",
      members: group.members.map((m) => ({ ...m, role: "both" })),
    }),
    /read-only|compare-and-swap/i,
  );
  await assert.rejects(
    service.saveGroup({ ...group, locationMappings: {} }),
    /mapping/,
  );
});
test("held job dismissal is explicit, clears baseline, and never performs remote write", async (t) => {
  const { service } = await fixture(t);
  service.store.enqueue("g", "b", {
    productKey: "p",
    location: "w",
    quantity: 2,
    expectedRevision: "1",
    operationId: "held",
  });
  service.store.block("held", "changed");
  service.store.saveObservation("g", "a", {
    productKey: "p",
    location: "w",
    available: 1,
    onHand: 1,
    observedAt: new Date().toISOString(),
  });
  service.dismissJob("held");
  assert.equal(service.store.hasOutstanding("g"), false);
  assert.equal(service.store.previous("g", "a", "p\0w"), undefined);
});
test("store endpoint edits cannot redirect encrypted credentials or queued inventory jobs", async (t) => {
  const { service } = await fixture(t);
  for (const platform of ["woocommerce", "shopify"]) {
    const initial = {
      id: platform,
      name: "Original store",
      platform,
      permission: "read_write",
      ...(platform === "woocommerce"
        ? {
            baseUrl: "https://original.test",
            token: "private-token",
            secret: "private-secret",
          }
        : { shopDomain: "original.myshopify.com", token: "private-token" }),
    };
    await service.saveConnection(initial);
    await assert.rejects(
      service.saveConnection({
        ...initial,
        ...(platform === "woocommerce"
          ? { baseUrl: "https://other.test" }
          : { shopDomain: "other.myshopify.com" }),
      }),
      /new connection/,
    );
    const saved = service.connections().find((c) => c.id === platform);
    assert.equal(
      saved.baseUrl ?? saved.shopDomain,
      initial.baseUrl ?? initial.shopDomain,
    );
  }
});
test("pause works with pending jobs, preserves queue, and persists across restart", async (t) => {
  const { service, dir } = await fixture(t);
  const g = {
    id: "pause",
    mode: "master",
    masterId: "a",
    members: [
      { connectionId: "a", role: "source" },
      { connectionId: "b", role: "destination" },
    ],
    enabled: true,
    intervalMinutes: 1,
    mappings: {},
    locationMappings: {},
  };
  service.store.db
    .prepare("INSERT INTO sync_groups VALUES(?,?,?,?,?,?)")
    .run(g.id, g.mode, g.masterId, 1, 1, JSON.stringify(g));
  service.store.enqueue("pause", "b", {
    productKey: "p",
    location: "w",
    quantity: 2,
    expectedRevision: "1",
    operationId: "pending",
  });
  assert.equal(service.setGroupEnabled("pause", false).state, "paused");
  assert.equal(service.groups()[0].enabled, false);
  assert.equal(service.store.hasOutstanding("pause"), true);
  await assert.rejects(service.sync("pause"), /Enable/);
  assert.equal(
    service.store.db.prepare("SELECT state FROM outbox").get().state,
    "pending",
  );
  assert.throws(() => service.setGroupEnabled("pause", "false"), /boolean/);
  await service.close();
  const { SqliteSyncStore } = require("../dist/src/sync/store.js");
  const reopened = new SqliteSyncStore(join(dir, "inventory.db"));
  try {
    assert.equal(
      JSON.parse(
        reopened.db.prepare("SELECT config_json FROM sync_groups").get()
          .config_json,
      ).enabled,
      false,
    );
    assert.equal(reopened.hasOutstanding("pause"), true);
  } finally {
    reopened.close();
  }
});
test("shutdown waits for in-flight reads and rejects new operations", async (t) => {
  const { service } = await fixture(t);
  let release;
  service.adapter = async () => ({
    read: async () => {
      await new Promise((resolve) => (release = resolve));
      return [
        {
          productKey: "p",
          sku: "p",
          location: "w",
          available: 1,
          onHand: 1,
          observedAt: new Date().toISOString(),
        },
      ];
    },
  });
  const reading = service.inspect("test");
  await new Promise((resolve) => setImmediate(resolve));
  let closed = false;
  const closing = service.close().then(() => (closed = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  await assert.rejects(service.inspect("test"), /closing/);
  release();
  assert.equal((await reading)[0].quantity, 1);
  await closing;
  assert.equal(closed, true);
  await service.close();
});
test("configuration edits block new sync until credential persistence completes", async (t) => {
  const { service } = await fixture(t);
  let release;
  let signal;
  const started = new Promise((resolve) => (signal = resolve));
  service.vault.set = async () =>
    new Promise((resolve) => {
      release = resolve;
      signal();
    });
  const saving = service.saveConnection({
    id: "store",
    name: "Shop",
    platform: "shopify",
    shopDomain: "shop.myshopify.com",
    permission: "read_write",
    token: "private-token",
  });
  await started;
  assert.equal(typeof release, "function");
  await assert.rejects(service.sync("g"), /Configuration update/);
  release();
  await saving;
});
test("connection read tests cannot overwrite concurrent configuration edits", async (t) => {
  const { service } = await fixture(t);
  const c = await service.saveConnection({
    id: "file",
    name: "Old",
    platform: "file",
    stockPath: "old.csv",
    permission: "read",
  });
  let release;
  service.adapter = async () => ({
    read: async () => {
      await new Promise((resolve) => (release = resolve));
      return [
        {
          productKey: "p",
          sku: "p",
          location: "w",
          available: 1,
          onHand: 1,
          observedAt: new Date().toISOString(),
        },
      ];
    },
  });
  const testing = service.testConnection(c.id);
  await new Promise((resolve) => setImmediate(resolve));
  await service.saveConnection({ ...c, name: "New", stockPath: "new.csv" });
  release();
  const result = await testing;
  assert.equal(result.state, "not_tested");
  assert.equal(service.connections()[0].name, "New");
  assert.equal(service.connections()[0].stockPath, "new.csv");
});
test("dashboard counts outstanding jobs beyond its 100-row history view", async (t) => {
  const { service } = await fixture(t);
  for (let i = 0; i < 105; i++)
    service.store.enqueue("g", "b", {
      productKey: "p" + i,
      location: "w",
      quantity: 1,
      operationId: "job-" + i,
    });
  const snapshot = service.snapshot();
  assert.equal(snapshot.jobs.length, 100);
  assert.equal(snapshot.outstandingJobs, 105);
});
test("mapping/source identity changes clear stale baselines while interval changes preserve them", async (t) => {
  const { service } = await fixture(t);
  const a = await service.saveConnection({
    id: "a",
    name: "Source",
    platform: "file",
    stockPath: "source.csv",
    permission: "read",
  });
  const b = await service.saveConnection({
    id: "b",
    name: "Shop",
    platform: "shopify",
    shopDomain: "shop.myshopify.com",
    permission: "read_write",
    token: "private-token",
  });
  const g = {
    id: "mapped",
    mode: "master",
    masterId: a.id,
    members: [
      { connectionId: a.id, role: "source" },
      { connectionId: b.id, role: "destination" },
    ],
    enabled: false,
    intervalMinutes: 1,
    mappings: { a: { p: "shared" }, b: { p: "shared" } },
    locationMappings: { a: { w: "shared" }, b: { w: "shared" } },
  };
  await service.saveGroup(g);
  const row = {
    productKey: "p",
    sku: "p",
    location: "w",
    available: 2,
    onHand: 2,
    observedAt: new Date().toISOString(),
  };
  service.store.saveObservation(g.id, "a", row);
  await service.saveGroup({ ...g, intervalMinutes: 5 });
  assert.equal(service.store.previous(g.id, "a", "p\0w"), 2);
  await service.saveGroup({
    ...g,
    mappings: { a: { p: "new" }, b: { p: "new" } },
  });
  assert.equal(service.store.previous(g.id, "a", "p\0w"), undefined);
  service.store.saveObservation(g.id, "a", row);
  await service.saveConnection({ ...a, stockPath: "other-source.csv" });
  assert.equal(service.store.previous(g.id, "a", "p\0w"), undefined);
});
