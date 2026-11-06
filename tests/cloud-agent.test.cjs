const { test } = require("node:test");
const assert = require("node:assert/strict");
const { gunzipSync } = require("node:zlib");
const { createHash } = require("node:crypto");
const { CloudAgent } = require("../dist/src/cloud-agent.js");

const BASE = "https://cloud.example.test/functions/v1/connector";
const cipher = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (v) => Buffer.from("enc:" + Buffer.from(v).toString("hex")),
  decryptString: (b) => Buffer.from(b.toString().slice(4), "hex").toString(),
};
function clock(start = Date.parse("2026-11-06T10:00:00Z")) {
  let now = start,
    seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = ++seq;
      // Short waits (snapshot processing polls) run at once; heartbeat timers stay pending.
      if (delay <= 5000) {
        now += delay;
        setImmediate(fn);
      } else timers.set(id, { fn, delay, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    timers,
    advance(ms) {
      now += ms;
    },
  };
}
const poll = (extra = {}) => ({
  api_base_url: BASE,
  next_poll_seconds: 60,
  min_agent_version: "0.1.0",
  server_time: "2026-11-06T10:00:30.000Z",
  ...extra,
});
function server(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const body = init.body && typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    calls.push({ method, path, body, headers: init.headers || {} });
    const handler = routes[method + " " + path] ?? routes[method + " *"];
    if (!handler) return json(404, { error: "not_found" });
    return handler({ method, path, body, headers: init.headers || {} }, calls);
  };
  return { fetch, calls };
}
const json = (status, value, headers = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
function agent(fetch, opts = {}) {
  let saved = opts.settings ?? { apiBaseUrl: BASE };
  const logs = [];
  const c = opts.clock ?? clock();
  const features = opts.features ?? { snapshots: false, commands: false };
  const a = new CloudAgent({
    load: async () => saved,
    save: async (s) => {
      saved = JSON.parse(JSON.stringify(s));
    },
    cipher,
    agentVersion: "0.1.0",
    os: "Windows_NT 10",
    features: () => features,
    lastRead: () => ({ sourceLabel: "POHODA export", result: "error", at: "2026-11-06T09:59:00Z", error: "Login failed password=hunter2 for Bearer abcdefghijk" }),
    runSyncCommand: opts.runSyncCommand ?? (async () => ({ state: "ok", message: "ok" })),
    log: (event, detail) => logs.push({ event, detail }),
    fetch,
    clock: c,
    random: () => 0.5,
  });
  return { a, logs, clock: c, saved: () => saved, features };
}
const paired = { apiBaseUrl: BASE, tokenEncrypted: cipher.encryptString("cdt_" + "a".repeat(43)).toString("base64"), shopName: "Shop" };
const snapshot = (qty = 3) => ({
  connectionId: "pos",
  snapshotAt: "2026-11-06T10:00:00.000Z",
  sourceTime: "2026-11-06T09:59:00.000Z",
  warehouses: ["main"],
  complete: true,
  issues: [],
  items: [
    { sourceConnectionId: "pos", sourceProductId: "CP01", sku: "CP01", ean: "2000000000015", name: "Farba", price: 54.9, currency: "EUR", quantity: qty, quantityKind: "available", warehouse: "main", availabilityStatus: "in_stock", sourceUpdatedAt: "2026-11-06T09:59:00.000Z", snapshotAt: "2026-11-06T10:00:00.000Z" },
  ],
});

test("pairing stores only the encrypted token, follows api_base_url and schedules heartbeats", async () => {
  const moved = "https://api.cacaduu.example/functions/v1/connector";
  const { fetch, calls } = server({
    "POST /v1/pair": () => json(201, { ...poll({ api_base_url: moved }), device_id: "dev-1", device_token: "cdt_" + "x".repeat(43), shop: { name: "Paint shop" } }),
  });
  const { a, saved, clock: c, logs } = agent(fetch);
  await a.init();
  await assert.rejects(a.pair("bad", "PC"), /Invalid pairing code/);
  const r = await a.pair("k7qm 4wxp", "Shop PC");
  assert.deepEqual(r, { deviceId: "dev-1", shopName: "Paint shop" });
  assert.equal(calls[0].body.code, "K7QM4WXP");
  assert.equal(calls[0].headers["cacaduu-agent-version"], "0.1.0");
  assert.equal(calls[0].headers.authorization, undefined);
  assert.doesNotMatch(JSON.stringify(saved()), /cdt_x/);
  assert.match(saved().tokenEncrypted, /^[A-Za-z0-9+/=]+$/);
  assert.equal(saved().apiBaseUrl, moved);
  assert.equal(a.config().clockSkewSeconds, 30);
  assert.equal([...c.timers.values()][0].delay, 60000);
  assert.doesNotMatch(JSON.stringify(logs), /cdt_x/);
  await assert.rejects(a.pair("K7QM-4WXP", "PC"), /Already paired/);
});

test("heartbeat redacts the read error, retries with contract backoff and honours Retry-After", async () => {
  let mode = "ok";
  const { fetch, calls } = server({
    "POST /v1/heartbeat": () =>
      mode === "ok"
        ? json(200, { ...poll(), shop: { name: "Shop" }, commands: [] })
        : mode === "busy"
          ? json(503, { error: "server_error" }, { "retry-after": "30" })
          : Promise.reject(new TypeError("fetch failed")),
  });
  const { a, clock: c } = agent(fetch, { settings: paired });
  await a.init();
  const r = await a.heartbeat();
  assert.equal(r.state, "ok");
  const sent = calls[0].body;
  assert.equal(sent.source_label, "POHODA export");
  assert.equal(sent.last_read.result, "error");
  assert.doesNotMatch(sent.last_read.error, /hunter2|abcdefghijk/);
  assert.match(calls[0].headers.authorization, /^Bearer cdt_a+$/);
  mode = "busy";
  await assert.rejects(a.heartbeat());
  assert.equal([...c.timers.values()].pop().delay, 30000);
  mode = "down";
  await assert.rejects(a.heartbeat());
  // second consecutive failure: 5 s · 2² = 20 s (random 0.5 → zero jitter)
  assert.equal([...c.timers.values()].pop().delay, 20000);
  assert.equal(a.backoff(), 20000);
});

test("401 forgets the token and asks to pair again; 426 stops calling until updated", async () => {
  let status = 401;
  const { fetch, calls } = server({
    "POST /v1/heartbeat": () => json(status, status === 426 ? { error: "update_required", min_agent_version: "2.0.0" } : { error: "unauthorized" }),
  });
  const first = agent(fetch, { settings: paired });
  await first.a.init();
  await assert.rejects(first.a.heartbeat());
  assert.equal(first.saved().tokenEncrypted, undefined);
  assert.equal(first.a.config().pairAgain, true);
  assert.equal(first.clock.timers.size, 0);
  status = 426;
  const second = agent(fetch, { settings: paired });
  await second.a.init();
  await assert.rejects(second.a.heartbeat());
  assert.equal(second.saved().updateRequired, "2.0.0");
  const before = calls.length;
  await assert.rejects(second.a.heartbeat(), /Update the agent/);
  assert.equal(calls.length, before, "no request after 426");
  assert.equal(second.clock.timers.size, 0);
});

test("Phase B is off by default and HTTP 501 is reported as not yet available without unpairing", async () => {
  const { fetch, calls } = server({
    "POST /v1/inventory/snapshots": () => json(501, { error: "not_available", message: "Phase B is not switched on" }),
    "POST /v1/heartbeat": () => json(200, { ...poll(), shop: { name: "Shop" }, commands: [] }),
  });
  const off = agent(fetch, { settings: paired });
  await off.a.init();
  assert.equal((await off.a.offerSnapshot("pos", "s-1", snapshot())).state, "disabled");
  assert.equal(calls.length, 0);
  const on = agent(fetch, { settings: paired, features: { snapshots: true, commands: false } });
  await on.a.init();
  const r = await on.a.offerSnapshot("pos", "s-1", snapshot());
  assert.equal(r.state, "not_yet_available");
  assert.equal(on.a.config().snapshots, "not_yet_available");
  assert.ok(on.saved().tokenEncrypted, "pairing kept");
  assert.equal((await on.a.heartbeat()).state, "ok", "Phase A continues");
});

test("Phase B uploads gzip JSON with SHA-256 content hash, polls processing and confirms unchanged stock", async () => {
  let uploaded;
  let confirmMode = "ok";
  let polls = 0;
  const { fetch, calls } = server({
    "POST /v1/inventory/snapshots": ({ body }) => json(201, { snapshot_id: body.snapshot_id, state: "awaiting_upload", upload_url: "https://storage.example.test/upload/s", upload_expires_at: "x" }),
    "PUT *": ({ body }) => {
      uploaded = Buffer.from(body);
      return new Response(null, { status: 200 });
    },
    "POST /v1/inventory/snapshots/s-1/complete": () => json(202, { snapshot_id: "s-1", state: "processing" }),
    "GET /v1/inventory/snapshots/s-1": () => json(200, polls++ < 1 ? { snapshot_id: "s-1", state: "processing" } : { snapshot_id: "s-1", state: "applied", result: { products: 1, imported: 1, zeroed: 0, skipped: 0 } }),
    "POST /v1/inventory/snapshots/s-2/complete": () => json(200, { snapshot_id: "s-2", state: "held", reason: "shrinking" }),
    "POST /v1/inventory/confirm": () => (confirmMode === "ok" ? json(200, { state: "confirmed" }) : json(409, { error: "send_full_snapshot" })),
  });
  const { a, saved, clock: c } = agent(fetch, { settings: paired, features: { snapshots: true, commands: false } });
  await a.init();
  const r = await a.offerSnapshot("pos", "s-1", snapshot());
  assert.equal(r.state, "applied");
  const announce = calls.find((x) => x.path === "/v1/inventory/snapshots").body;
  const raw = gunzipSync(uploaded);
  assert.equal(announce.content_hash, createHash("sha256").update(raw).digest("hex"));
  assert.equal(announce.complete, true);
  assert.equal(announce.product_count, 1);
  const doc = JSON.parse(raw);
  assert.equal(doc.format, "cacaduu.inventory.v1");
  assert.equal(doc.snapshot_id, "s-1");
  assert.deepEqual(Object.keys(doc.products[0]).sort(), ["availability_status", "currency", "ean", "name", "price", "quantity", "source_code", "source_updated_at", "warehouse"]);
  assert.equal(saved().lastApplied.snapshotId, "s-1");

  // Same products re-read: confirm instead of uploading again.
  const before = calls.filter((x) => x.method === "PUT").length;
  assert.equal((await a.offerSnapshot("pos", "s-x", snapshot())).state, "confirmed");
  assert.equal(calls.filter((x) => x.method === "PUT").length, before);
  assert.equal(calls.at(-1).body.content_hash, announce.content_hash);

  // Changed stock within 5 minutes is deferred locally (contract: one full snapshot per 5 minutes).
  assert.equal((await a.offerSnapshot("pos", "s-2", snapshot(9))).state, "deferred_rate_limit");
  c.advance(5 * 60 * 1000);
  confirmMode = "conflict";
  assert.equal((await a.offerSnapshot("pos", "s-2", snapshot(9))).state, "held");
});

test("Phase C runs only claimed sync_inventory and ping commands, once, and ignores everything else", async () => {
  const claimed = [];
  const reports = [];
  let runs = 0;
  const { fetch } = server({
    "POST *": ({ path, body }) => {
      const claim = /^\/v1\/commands\/([^/]+)\/claim$/.exec(path);
      if (claim) {
        claimed.push(claim[1]);
        return claim[1] === "taken" ? json(409, { error: "already_claimed" }) : json(200, { id: claim[1], state: "claimed", lease_expires_at: "x" });
      }
      const result = /^\/v1\/commands\/([^/]+)\/result$/.exec(path);
      if (result) {
        reports.push([result[1], body]);
        return json(200, { id: result[1], state: body.state });
      }
      if (path === "/v1/inventory/snapshots") return json(201, { snapshot_id: body.snapshot_id, state: "awaiting_upload", upload_url: "https://storage.example.test/u" });
      if (/complete$/.test(path)) return json(200, { snapshot_id: "cmd-snap", state: "applied" });
      return json(404, { error: "not_found" });
    },
    "PUT *": () => new Response(null, { status: 200 }),
  });
  let ctx;
  ctx = agent(fetch, {
    settings: paired,
    features: { snapshots: true, commands: true },
    runSyncCommand: async () => {
      runs++;
      // The export path offers its verified snapshot with the active command ID.
      await ctx.a.offerSnapshot("pos", "cmd-snap", snapshot(), ctx.a.activeCommandId);
      return { state: "ok", message: "Published 1 products" };
    },
  });
  await ctx.a.init();
  const commands = [
    { id: "evil", type: "run_shell", state: "pending" },
    { id: "old", type: "sync_inventory", state: "pending", expires_at: "2020-01-01T00:00:00Z" },
    { id: "taken", type: "sync_inventory", state: "pending" },
    { id: "p1", type: "ping", state: "pending" },
    { id: "s1", type: "sync_inventory", state: "pending", expires_at: "2099-01-01T00:00:00Z" },
  ];
  await ctx.a.handleCommands(commands);
  assert.deepEqual(claimed, ["taken", "p1", "s1"], "unknown and expired commands are never claimed");
  assert.equal(runs, 1);
  assert.deepEqual(reports.find(([id]) => id === "p1")[1], { state: "completed" });
  assert.deepEqual(reports.filter(([id]) => id === "s1").map(([, b]) => b), [
    { state: "running" },
    { state: "completed", snapshot_id: "cmd-snap" },
  ]);
  assert.ok(ctx.logs.some((l) => l.event === "cloud_command_ignored" && l.detail.commandId === "evil"));
  await ctx.a.handleCommands(commands);
  assert.equal(runs, 1, "duplicate delivery never runs twice");
  assert.equal(claimed.length, 3);
});

test("Phase C 501 is not_yet_available and a failed local export reports failed with a redacted reason", async () => {
  let claim501 = true;
  const reports = [];
  const { fetch } = server({
    "POST *": ({ path, body }) => {
      if (/claim$/.test(path)) return claim501 ? json(501, { error: "not_available" }) : json(200, { state: "claimed" });
      reports.push(body);
      return json(200, {});
    },
  });
  const { a } = agent(fetch, {
    settings: paired,
    features: { snapshots: true, commands: true },
    runSyncCommand: async () => ({ state: "failed", message: "POS offline token=abc123secret" }),
  });
  await a.init();
  await a.handleCommands([{ id: "c1", type: "sync_inventory", state: "pending" }]);
  assert.equal(a.config().commands, "not_yet_available");
  assert.equal(reports.length, 0);
  claim501 = false;
  await a.handleCommands([{ id: "c1", type: "sync_inventory", state: "pending" }]);
  assert.equal(reports.at(-1).state, "failed");
  assert.doesNotMatch(reports.at(-1).reason, /abc123secret/);
});
