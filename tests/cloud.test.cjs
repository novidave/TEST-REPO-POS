const { test } = require("node:test");
const assert = require("node:assert/strict");
const { optionalFeature } = require("../dist/src/cloud.js");
const { CloudApiError } = require("../dist/docs/cloud-api/client/client.js");
test("disabled cloud never calls backend", async () => {
  let called = false;
  const r = await optionalFeature(false, async () => {
    called = true;
  });
  assert.equal(r.state, "not_yet_available");
  assert.equal(called, false);
});
test("501 not_available is nonfatal", async () => {
  const r = await optionalFeature(true, async () => {
    throw new CloudApiError(501, "not_available", "not ready", null, {});
  });
  assert.equal(r.state, "not_yet_available");
});
test("other errors propagate", async () => {
  await assert.rejects(
    optionalFeature(true, async () => {
      throw new Error("offline");
    }),
  );
});
const {
  CacaduuCloudClient,
} = require("../dist/docs/cloud-api/client/client.js");
const { CloudConnection } = require("../dist/src/cloud.js");
test("pinned Phase A pairing, heartbeat, status and rotation use expected endpoints", async () => {
  const requests = [];
  let token = null;
  const client = new CacaduuCloudClient({
    baseUrl: "https://cloud.test/connector",
    agentVersion: "0.1.0",
    getToken: () => token,
    fetch: async (url, init) => {
      requests.push({ url, init });
      const response = url.endsWith("/pair")
        ? {
            device_token: "first",
            device_id: "device",
            shop: { name: "Shop" },
            api_base_url: "https://cloud.test/connector",
            next_poll_seconds: 60,
          }
        : url.endsWith("/rotate")
          ? { device_token: "second" }
          : { state: "online", shop: { name: "Shop" }, next_poll_seconds: 60 };
      return new Response(JSON.stringify(response), { status: 200 });
    },
  });
  const cloud = new CloudConnection(client);
  const pair = await cloud.pair("K7QM-4WXP", "Test PC", "win32");
  token = pair.device_token;
  await cloud.heartbeat("win32");
  await cloud.status();
  token = (await cloud.rotate()).device_token;
  await cloud.status();
  assert.equal(requests[0].init.headers.authorization, undefined);
  assert.equal(requests[1].init.headers.authorization, "Bearer first");
  assert.equal(requests[4].init.headers.authorization, "Bearer second");
  assert.match(requests[3].url, /\/v1\/credentials\/rotate$/);
});
test("enabled B/C HTTP 501 does not disrupt Phase A status", async () => {
  const client = new CacaduuCloudClient({
    baseUrl: "https://cloud.test",
    agentVersion: "0.1.0",
    getToken: () => "test-token",
    fetch: async (url) =>
      url.endsWith("/status")
        ? new Response(JSON.stringify({ state: "online" }), { status: 200 })
        : new Response(JSON.stringify({ error: "not_available" }), {
            status: 501,
          }),
  });
  const cloud = new CloudConnection(client, true, true);
  assert.equal((await cloud.commands()).state, "not_yet_available");
  assert.equal((await cloud.announceSnapshot({})).state, "not_yet_available");
  assert.equal((await cloud.status()).state, "online");
});
