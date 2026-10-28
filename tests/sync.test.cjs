const { test } = require("node:test");
const assert = require("node:assert/strict");
const { planGroup } = require("../dist/src/sync/engine.js");
const row = (q, location = "default") => ({
  productKey: "p",
  sku: "SKU",
  location,
  available: q,
  onHand: q,
  revision: String(q),
  observedAt: new Date().toISOString(),
});
const adapter = (id, q) => ({
  id,
  platform: "pos",
  capabilities: {
    read: true,
    write: true,
    locations: true,
    webhooks: false,
    compareAndSwap: true,
  },
  read: async () => [row(q)],
  write: async () => {},
});
const store = () => {
  const prev = new Map(),
    out = [];
  return {
    previous: (g, a, k) => prev.get(g + a + k),
    saveObservation: (g, a, s) =>
      prev.set(g + a + s.productKey + "\0" + s.location, s.available),
    enqueue: (g, d, u) => out.push([d, u]),
    conflict: () => {},
    out,
  };
};
const group = (mode, a, b) => ({
  id: "g",
  mode,
  masterId: "a",
  members: [
    { adapter: a, role: mode === "master" ? "source" : "both" },
    { adapter: b, role: mode === "master" ? "destination" : "both" },
  ],
  enabled: true,
  intervalMinutes: 15,
  mappings: { a: { p: "canonical" }, b: { p: "canonical" } },
  locationMappings: { a: { default: "shared" }, b: { default: "shared" } },
});
test("master-source writes observed destination with revision", async () => {
  const s = store();
  const p = await planGroup(
    group("master", adapter("a", 5), adapter("b", 3)),
    s,
  );
  assert.equal(p.writes[0].updates[0].quantity, 5);
  assert.equal(p.writes[0].updates[0].expectedRevision, "3");
});
test("two-way initial mismatch held across repeated polls and single edits", async () => {
  const s = store();
  for (const q of [5, 5, 6]) {
    const p = await planGroup(
      group("two_way", adapter("a", q), adapter("b", 3)),
      s,
    );
    assert.equal(p.conflicts.length, 1);
    assert.equal(p.writes.length, 0);
  }
});
test("two-way matching initial stock establishes baseline without writes", async () => {
  const s = store();
  const p = await planGroup(
    group("two_way", adapter("a", 5), adapter("b", 5)),
    s,
  );
  assert.equal(p.conflicts.length, 0);
  assert.equal(p.writes.length, 0);
});
test("two-way single changed source propagates; simultaneous changes conflict", async () => {
  const s = store();
  await planGroup(group("two_way", adapter("a", 5), adapter("b", 5)), s);
  let p = await planGroup(
    group("two_way", adapter("a", 4), adapter("b", 5)),
    s,
  );
  assert.equal(p.writes[0].destination, "b");
  assert.equal(p.writes[0].updates[0].quantity, 4);
  p = await planGroup(group("two_way", adapter("a", 3), adapter("b", 2)), s);
  assert.equal(p.conflicts.length, 1);
});
test("sync echo does not cause a reverse write or loop", async () => {
  const s = store();
  await planGroup(group("two_way", adapter("a", 5), adapter("b", 5)), s);
  await planGroup(group("two_way", adapter("a", 4), adapter("b", 5)), s);
  const p = await planGroup(
    group("two_way", adapter("a", 4), adapter("b", 4)),
    s,
  );
  assert.equal(p.writes.length, 0);
});
test("two-way refuses non-atomic APIs", async () => {
  const a = adapter("a", 5);
  a.capabilities.compareAndSwap = false;
  await assert.rejects(
    planGroup(group("two_way", a, adapter("b", 3)), store()),
    /compare-and-swap/,
  );
});
test("failed master prevents writes", async () => {
  const s = store();
  const a = adapter("a", 5);
  a.read = async () => {
    throw new Error("offline");
  };
  await assert.rejects(planGroup(group("master", a, adapter("b", 3)), s));
  assert.equal(s.out.length, 0);
});
for (const invalid of [
  { sku: "" },
  { available: null, onHand: null },
  { available: -1, onHand: -1 },
  { available: 1.5, onHand: 1.5 },
  { observedAt: "bad" },
])
  test(
    "invalid source prevents writes: " + JSON.stringify(invalid),
    async () => {
      const a = adapter("a", 5),
        s = store();
      a.read = async () => [{ ...row(5), ...invalid }];
      await assert.rejects(planGroup(group("master", a, adapter("b", 3)), s));
      assert.equal(s.out.length, 0);
    },
  );
test("missing product and warehouse mappings fail closed", async () => {
  for (const field of ["mappings", "locationMappings"]) {
    const g = group("master", adapter("a", 5), adapter("b", 3));
    g[field].a = {};
    await assert.rejects(planGroup(g, store()), /mapping/);
  }
});
test("explicit warehouse mapping writes destination warehouse ID", async () => {
  const a = adapter("a", 5),
    b = adapter("b", 3);
  a.read = async () => [row(5, "warehouse-A")];
  b.read = async () => [row(3, "warehouse-B")];
  const g = group("master", a, b);
  g.locationMappings = {
    a: { "warehouse-A": "shared" },
    b: { "warehouse-B": "shared" },
  };
  const p = await planGroup(g, store());
  assert.equal(p.writes[0].updates[0].location, "warehouse-B");
});
test("duplicate observations rejected", async () => {
  const a = adapter("a", 5);
  a.read = async () => [row(5), row(5)];
  await assert.rejects(
    planGroup(group("master", a, adapter("b", 3)), store()),
    /Duplicate/,
  );
});
test("empty source and missing member product held", async () => {
  const a = adapter("a", 5);
  a.read = async () => [];
  await assert.rejects(
    planGroup(group("master", a, adapter("b", 3)), store()),
    /Empty/,
  );
  const b = adapter("b", 3);
  b.read = async () => [{ ...row(3), productKey: "other" }];
  const g = group("two_way", adapter("a", 5), b);
  g.mappings.b = { other: "different" };
  const p = await planGroup(g, store());
  assert.equal(p.writes.length, 0);
  assert.equal(p.conflicts.length, 2);
});
module.exports = { row, adapter, group };
