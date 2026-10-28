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
    JSON.stringify({
      token: "private-token",
      secret: "private-secret",
      username: "private-user",
      password: "private-key",
    }),
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
test("POS setup metadata persists but usernames and passwords remain encrypted and untested", async (t) => {
  const { service, dir } = await fixture(t);
  const saved = await service.saveConnection({
    id: "pohoda",
    name: "POHODA main shop",
    platform: "pos",
    permission: "read",
    integrationKind: "local_api",
    vendor: "POHODA (mServer)",
    setupEndpoint: "http://localhost:444/xml",
    username: "setup-user-private",
    password: "setup-password-private",
    productMappings: { P1: "shared-P1" },
    warehouseMappings: { main: "shared-main" },
  });
  assert.equal(saved.status, "setup_required");
  assert.equal(saved.integrationKind, "local_api");
  assert.equal(saved.setupEndpoint, "http://localhost:444/xml");
  assert.equal(
    (await service.testConnection(saved.id)).state,
    "setup_required",
  );
  assert.doesNotMatch(
    JSON.stringify(service.snapshot()),
    /setup-user-private|setup-password-private/,
  );
  assert.doesNotMatch(
    await readFile(join(dir, "credentials"), "utf8"),
    /setup-user-private|setup-password-private/,
  );
  await service.saveConnection({
    id: saved.id,
    name: "Renamed shop",
    platform: "pos",
    permission: "read",
  });
  assert.deepEqual(service.connections()[0].productMappings, {
    P1: "shared-P1",
  });
});
test("POS setup does not accept embedded passwords, remote plain HTTP, or incompatible integration types", async (t) => {
  const { service } = await fixture(t);
  const input = {
    name: "POS",
    platform: "pos",
    permission: "read",
    integrationKind: "local_api",
  };
  for (const setupEndpoint of [
    "http://remote.example/xml",
    "https://user:password@example.test",
    "http://localhost:444/xml?password=secret",
  ])
    await assert.rejects(service.saveConnection({ ...input, setupEndpoint }));
  await assert.rejects(
    service.saveConnection({ ...input, integrationKind: "unknown" }),
    /integration/,
  );
  await assert.rejects(
    service.saveConnection({
      name: "File",
      platform: "file",
      stockPath: "x.csv",
      permission: "read",
      integrationKind: "gui_automation",
    }),
    /match/,
  );
});
test("file preview reads real data without persisting a connection and refuses incomplete inventory", async (t) => {
  const { service, dir } = await fixture(t);
  const path = join(dir, "preview.csv");
  await writeFile(
    path,
    "source_code,name,price,currency,quantity,warehouse,observed_at\nS1,Fixture,10,EUR,2,main,2026-10-28T12:00:00Z\n",
  );
  const preview = await service.previewFile(path);
  assert.equal(preview.count, 1);
  assert.equal(preview.rows[0].productKey, "S1");
  assert.equal(service.connections().length, 0);
  await writeFile(
    path,
    "source_code,name,price,currency,quantity,warehouse,observed_at\nS1,Fixture,,EUR,2,main,2026-10-28T12:00:00Z\n",
  );
  await assert.rejects(service.previewFile(path));
});
test("connector catalog reports installed driver capabilities without advertising unsupported vendors", async (t) => {
  const { service } = await fixture(t);
  const state = service.snapshot();
  assert.equal(state.runtime.groups.concurrency, 4);
  assert.equal(state.runtime.requests.concurrency, 8);
  assert.equal(
    state.connectorCapabilities.find((c) => c.platform === "shopify").twoWay,
    true,
  );
  assert.equal(
    state.connectorCapabilities.find((c) => c.platform === "woocommerce")
      .twoWay,
    false,
  );
  assert.equal(
    state.connectorCapabilities.find((c) => c.platform === "pos").read,
    false,
  );
});
test("unrelated connections remain configurable while a different group is queued or active", async (t) => {
  const { service } = await fixture(t);
  await service.saveConnection({
    id: "used",
    name: "Used source",
    platform: "file",
    stockPath: "used.csv",
    permission: "read",
  });
  const group = {
    id: "active-group",
    mode: "master",
    masterId: "used",
    members: [
      { connectionId: "used", role: "source" },
      { connectionId: "destination", role: "destination" },
    ],
    enabled: true,
    intervalMinutes: 1,
    mappings: {},
    locationMappings: {},
  };
  service.store.db
    .prepare("INSERT INTO sync_groups VALUES(?,?,?,?,?,?)")
    .run(group.id, group.mode, group.masterId, 1, 1, JSON.stringify(group));
  service.busy.add(group.id);
  try {
    const other = await service.saveConnection({
      id: "other",
      name: "Other file",
      platform: "file",
      stockPath: "other.csv",
      permission: "read",
    });
    assert.equal(other.id, "other");
    await assert.rejects(
      service.saveConnection({
        id: "used",
        name: "Used source",
        platform: "file",
        stockPath: "changed.csv",
        permission: "read",
      }),
      /active sync/,
    );
  } finally {
    service.busy.delete(group.id);
  }
});
test("regional priorities distinguish 14 requested vendor profiles from implemented drivers", async (t) => {
  const { service } = await fixture(t);
  const profiles = service.snapshot().regionalConnectors;
  assert.equal(profiles.length, 14);
  assert.ok(
    profiles.every((profile) => profile.nativeState === "setup_required"),
  );
  assert.equal(profiles.find((p) => p.id === "dotykacka").priority, 1);
  assert.deepEqual(profiles.find((p) => p.id === "dotykacka").countries, [
    "SK",
    "CZ",
    "PL",
  ]);
  assert.equal(profiles.find((p) => p.id === "pohoda").method, "local_api");
  assert.notEqual(
    profiles.find((p) => p.id === "subiekt_gt").id,
    profiles.find((p) => p.id === "subiekt_nexo").id,
  );
  const setup = await service.saveConnection({
    id: "regional-pohoda",
    name: "POHODA company",
    platform: "pos",
    permission: "read",
    integrationKind: "local_api",
    regionalVendorId: "pohoda",
    vendor: "POHODA (mServer)",
    setupEndpoint: "http://localhost:444/xml",
  });
  assert.equal(setup.status, "setup_required");
  const status = await service.testConnection(setup.id);
  assert.equal(status.state, "setup_required");
  assert.match(status.message, /mServer/);
  await service.saveConnection({
    id: setup.id,
    name: "Renamed company",
    platform: "pos",
    permission: "read",
  });
  assert.equal(
    service.connections().find((c) => c.id === setup.id).regionalVendorId,
    "pohoda",
  );
});
test("regional metadata cannot falsely turn an unimplemented vendor into a native API driver", async (t) => {
  const { service } = await fixture(t);
  await assert.rejects(
    service.saveConnection({
      name: "Dotykačka",
      platform: "shopify",
      shopDomain: "fixture.myshopify.com",
      permission: "read",
      regionalVendorId: "dotykacka",
    }),
    /no native driver/,
  );
  await assert.rejects(
    service.saveConnection({
      name: "Unknown",
      platform: "pos",
      permission: "read",
      regionalVendorId: "unknown",
    }),
    /Unknown regional/,
  );
});
test("read-only ERP drivers reject write permissions and bind encrypted credentials to immutable endpoints", async (t) => {
  const { service, dir } = await fixture(t);
  for (const platform of ["erpnext", "odoo"]) {
    const input = {
      name: platform,
      platform,
      baseUrl: "https://erp.test",
      database: "merchant-db",
      permission: "read",
      token: "private-token",
      secret: "private-secret",
      username: "private-user",
      password: "private-key",
    };
    await assert.rejects(
      service.saveConnection({ ...input, permission: "read_write" }),
    );
    const c = await service.saveConnection(input);
    const adapter = await service.adapter(c.id);
    assert.equal(adapter.capabilities.write, false);
    assert.equal(adapter.write, undefined);
    await assert.rejects(
      service.saveConnection({
        ...input,
        id: c.id,
        baseUrl: "https://different.test",
      }),
    );
    if (platform === "odoo")
      await assert.rejects(
        service.saveConnection({
          ...input,
          id: c.id,
          database: "different-db",
        }),
      );
  }
  assert.doesNotMatch(
    JSON.stringify(service.snapshot()),
    /private-(token|secret|user|key)/,
  );
  assert.doesNotMatch(
    await readFile(join(dir, "credentials"), "utf8"),
    /private-/,
  );
});
const mappedCsv = {
  version: 1,
  delimiter: ";",
  encoding: "utf-8",
  decimalSeparator: ",",
  quantityKind: "on_hand",
  columns: {
    source_code: "Code",
    quantity: "Qty",
    warehouse: "Warehouse",
    observed_at: "Time",
  },
};
test("mapped imports preview without saving, persist exact metadata and refuse invalid platform settings", async (t) => {
  const { service, dir } = await fixture(t),
    path = join(dir, "regional.csv");
  await writeFile(
    path,
    "Code;Qty;Warehouse;Time\n001;4,00;main;2026-10-28T12:00:00Z",
  );
  assert.equal(
    (await service.previewFile(path, mappedCsv)).rows[0].quantity,
    4,
  );
  assert.equal(service.connections().length, 0);
  const input = {
    name: "Regional export",
    platform: "file",
    stockPath: path,
    permission: "read",
    csvImport: mappedCsv,
    regionalVendorId: "money_s3",
  };
  const c = await service.saveConnection(input);
  assert.deepEqual(service.connections()[0].csvImport, mappedCsv);
  assert.equal(
    (await service.testConnection(c.id)).state,
    "authenticated_read_ok",
  );
  await assert.rejects(service.exportLocal(c.id), /catalogue/);
  await assert.rejects(
    service.saveConnection({ ...input, stockPath: "source.xml" }),
    /CSV file/,
  );
  await assert.rejects(
    service.saveConnection({ ...input, platform: "pos" }),
    /file connection/,
  );
  const cleared = await service.saveConnection({
    ...input,
    id: c.id,
    csvImport: null,
  });
  assert.equal(cleared.csvImport, undefined);
});
test("import profile edits reject outstanding jobs and clear source baselines after reconciliation", async (t) => {
  const { service } = await fixture(t);
  const a = await service.saveConnection({
    id: "a",
    name: "File",
    platform: "file",
    stockPath: "stock.csv",
    permission: "read",
    csvImport: mappedCsv,
  });
  await service.saveConnection({
    id: "b",
    name: "Shop",
    platform: "shopify",
    shopDomain: "shop.myshopify.com",
    permission: "read_write",
    token: "private-token",
  });
  await service.saveGroup({
    id: "g",
    mode: "master",
    masterId: "a",
    enabled: false,
    intervalMinutes: 5,
    members: [
      { connectionId: "a", role: "source" },
      { connectionId: "b", role: "destination" },
    ],
    mappings: { a: { p: "P" }, b: { p: "P" } },
    locationMappings: { a: { w: "W" }, b: { w: "W" } },
  });
  service.store.saveObservation("g", "a", {
    productKey: "p",
    sku: "p",
    location: "w",
    available: 2,
    onHand: null,
    observedAt: new Date().toISOString(),
  });
  const changed = {
    ...a,
    csvImport: { ...mappedCsv, quantityKind: "available" },
  };
  service.store.enqueue("g", "b", {
    productKey: "p",
    location: "w",
    quantity: 2,
    operationId: "csv-pending",
  });
  await assert.rejects(
    service.saveConnection(changed),
    /Reconcile outstanding jobs/,
  );
  assert.equal(service.store.previous("g", "a", "p\0w"), 2);
  service.store.db.prepare("DELETE FROM outbox WHERE group_id=?").run("g");
  await service.saveConnection(changed);
  assert.equal(service.store.previous("g", "a", "p\0w"), undefined);
});
test("mapped stock-only master sync reaches mock destination despite independent local export validation failure", async (t) => {
  const { service, dir } = await fixture(t),
    path = join(dir, "stock.csv");
  await writeFile(
    path,
    "Code;Qty;Warehouse;Time\n001;4;main;2026-10-28T12:00:00Z",
  );
  const a = await service.saveConnection({
    id: "a",
    name: "File",
    platform: "file",
    stockPath: path,
    permission: "read",
    csvImport: mappedCsv,
  });
  await service.saveConnection({
    id: "b",
    name: "Mock shop",
    platform: "shopify",
    shopDomain: "shop.myshopify.com",
    permission: "read_write",
    token: "private-token",
  });
  const original = service.adapter.bind(service);
  let quantity = 0,
    writes = 0;
  service.adapter = async (id) =>
    id === "a"
      ? original(id)
      : {
          id: "b",
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
              location: "warehouse",
              available: quantity,
              onHand: null,
              revision: String(quantity),
              observedAt: new Date().toISOString(),
            },
          ],
          write: async (updates) => {
            assert.equal(updates[0].quantity, 4);
            quantity = 4;
            writes++;
          },
        };
  await service.saveGroup({
    id: "csv-master",
    mode: "master",
    masterId: a.id,
    enabled: true,
    intervalMinutes: 1440,
    members: [
      { connectionId: "a", role: "source" },
      { connectionId: "b", role: "destination" },
    ],
    mappings: { a: { "001": "shared" }, b: { remote: "shared" } },
    locationMappings: { a: { main: "shared" }, b: { warehouse: "shared" } },
  });
  const result = await service.sync("csv-master");
  assert.equal(writes, 1);
  assert.equal(quantity, 4);
  assert.equal(
    result.exportState,
    "validation_failed_previous_export_preserved",
  );
  assert.deepEqual(result.errors, []);
});
