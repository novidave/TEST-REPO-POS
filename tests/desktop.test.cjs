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
