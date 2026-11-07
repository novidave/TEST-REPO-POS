const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createInterface } = require("node:readline");
const { KeyCipher, secureAvailable } = require("../dist/src/security.js");

test("KeyCipher round-trips and rejects tampering or a wrong key", () => {
  const key = randomBytes(32);
  const cipher = new KeyCipher(key);
  assert.equal(secureAvailable(cipher), true);
  const sealed = cipher.encryptString("secret-token");
  assert.notEqual(sealed.toString("utf8").includes("secret-token"), true);
  assert.equal(cipher.decryptString(sealed), "secret-token");
  assert.notDeepEqual(cipher.encryptString("secret-token"), sealed);
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => cipher.decryptString(tampered));
  assert.throws(() => new KeyCipher(randomBytes(32)).decryptString(sealed));
  assert.throws(() => new KeyCipher(randomBytes(16)), /32 bytes/);
});

test("KeyCipher without a key reports secure storage unavailable", () => {
  const cipher = new KeyCipher(null);
  assert.equal(secureAvailable(cipher), false);
  assert.throws(() => cipher.encryptString("x"), /unavailable/);
});

function startSidecar(userData, key) {
  const child = spawn(process.execPath, [resolve("dist/src/sidecar.js")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const frames = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line);
    const i = waiters.findIndex((w) => w.match(frame));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(frame);
    else frames.push(frame);
  });
  const next = (match) => {
    const i = frames.findIndex(match);
    if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0]);
    return new Promise((resolve) => waiters.push({ match, resolve }));
  };
  const send = (frame) => child.stdin.write(JSON.stringify(frame) + "\n");
  let id = 0;
  const call = async (channel, ...args) => {
    const n = ++id;
    send({ type: "call", id: n, channel, args });
    return next((f) => f.type === "result" && f.id === n);
  };
  const exited = new Promise((r) => child.on("exit", (code) => r(code)));
  send({
    type: "init",
    userData,
    version: "9.9.9",
    key: key ? key.toString("base64") : null,
  });
  return { child, next, send, call, exited };
}

test("sidecar serves the fixed bridge, encrypts credentials and shuts down cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cacaduu-sidecar-"));
  try {
    const key = randomBytes(32);
    const s = startSidecar(dir, key);
    assert.equal((await s.next((f) => f.type !== "result")).type, "ready");

    const snapshot = await s.call("desktop:snapshot");
    assert.equal(snapshot.ok, true);
    assert.ok(Array.isArray(snapshot.value.connections));

    const config = await s.call("cloud:config");
    assert.equal(config.ok, true);
    assert.equal(config.value.secureStorage, true);
    assert.equal(config.value.paired, false);

    const unknown = await s.call("desktop:choose-file");
    assert.deepEqual(
      { ok: unknown.ok, error: unknown.error },
      { ok: false, error: "Unknown channel" },
    );
    const invalid = await s.call("desktop:sync", "");
    assert.equal(invalid.ok, false);
    assert.doesNotMatch(invalid.error, /at .*\.js/);

    const saved = await s.call("desktop:save-connection", {
      name: "Woo dev",
      platform: "woocommerce",
      baseUrl: "https://shop.example.test",
      permission: "read",
      token: "ck_sidecar_secret",
      secret: "cs_sidecar_secret",
    });
    assert.equal(saved.ok, true, saved.error);
    const vault = readFileSync(join(dir, "credentials.enc.json"), "utf8");
    assert.doesNotMatch(vault, /sidecar_secret/);
    const stored = JSON.parse(vault);
    const sealed = Buffer.from(Object.values(stored)[0], "base64");
    assert.match(new KeyCipher(key).decryptString(sealed), /ck_sidecar_secret/);
    const after = await s.call("desktop:snapshot");
    assert.doesNotMatch(JSON.stringify(after.value), /sidecar_secret/);

    s.send({ type: "shutdown" });
    assert.equal((await s.next((f) => f.type === "closed")).type, "closed");
    assert.equal(await s.exited, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sidecar without a master key refuses credentials and exits when stdin closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cacaduu-sidecar-"));
  try {
    const s = startSidecar(dir, null);
    assert.equal((await s.next((f) => f.type !== "result")).type, "ready");
    const config = await s.call("cloud:config");
    assert.equal(config.value.secureStorage, false);
    const saved = await s.call("desktop:save-connection", {
      name: "Woo dev",
      platform: "woocommerce",
      baseUrl: "https://shop.example.test",
      permission: "read",
      token: "ck_x",
      secret: "cs_x",
    });
    assert.equal(saved.ok, false);
    assert.match(saved.error, /secure credential storage unavailable/);
    s.child.stdin.end();
    assert.equal(await s.exited, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
