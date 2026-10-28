const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} = require("node:crypto");
const {
  CredentialVault,
  publicError,
  httpsUrl,
} = require("../dist/src/security.js");
function cipher() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test_cipher",
    encryptString: (value) => {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([c.update(value, "utf8"), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), bytes]);
    },
    decryptString: (bytes) => {
      const c = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      c.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString(
        "utf8",
      );
    },
  };
}
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "vault-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("tokens encrypted on disk and round-trip without exposing plaintext", async (t) => {
  const path = join(await temp(t), "vault"),
    vault = new CredentialVault(path, cipher());
  await vault.set("shop", {
    token: "never-plaintext",
    secret: "private-secret",
  });
  const disk = await readFile(path, "utf8");
  assert.doesNotMatch(disk, /never-plaintext|private-secret/);
  assert.equal((await vault.get("shop")).token, "never-plaintext");
});
test("parallel vault writes preserve credentials for both connections", async (t) => {
  const vault = new CredentialVault(join(await temp(t), "vault"), cipher());
  await Promise.all([
    vault.set("a", { token: "a" }),
    vault.set("b", { token: "b" }),
  ]);
  assert.equal((await vault.get("a")).token, "a");
  assert.equal((await vault.get("b")).token, "b");
});
test("unavailable and insecure Linux fallback storage refuses credentials", async (t) => {
  for (const c of [
    { ...cipher(), isEncryptionAvailable: () => false },
    { ...cipher(), getSelectedStorageBackend: () => "basic_text" },
  ]) {
    const vault = new CredentialVault(join(await temp(t), "vault"), c);
    await assert.rejects(vault.set("shop", { token: "secret" }), /unavailable/);
  }
});
test("upstream errors cannot expose tokens or response bodies in renderer/logs", () => {
  assert.doesNotMatch(
    publicError(new Error("token=PRIVATE merchant password=SECRET")),
    /PRIVATE|SECRET/,
  );
  assert.match(publicError(new Error("Shopify HTTP 401")), /401/);
});
test("URLs reject embedded credentials, HTTP, query tokens and fragments", () => {
  for (const url of [
    "http://shop.test",
    "https://key:secret@shop.test",
    "https://shop.test?token=secret",
    "https://shop.test/#secret",
  ])
    assert.throws(() => httpsUrl(url));
  assert.equal(httpsUrl("https://shop.test/"), "https://shop.test");
});
module.exports = { cipher };
