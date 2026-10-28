"use strict";
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
(async () => {
  const profile = await mkdtemp(join(tmpdir(), "inventory-electron-"));
  let application;
  try {
    const input = join(profile, "sample.csv");
    await writeFile(
      input,
      "source_code,name,price,currency,quantity,warehouse,observed_at\nTEST-1,Test fixture only,12,EUR,3,test-warehouse,2026-10-28T12:00:00Z\n",
    );
    const packaged = process.argv.includes("--packaged");
    const executablePath = packaged
      ? resolve(
          "release",
          `CACADUU-Inventory-${process.platform}-x64`,
          process.platform === "win32"
            ? "CACADUU-Inventory.exe"
            : "CACADUU-Inventory",
        )
      : undefined;
    const args = packaged ? [] : [resolve(".")];
    if (process.env.ELECTRON_TEST_HEADLESS === "1")
      args.push("--ozone-platform=headless", "--disable-gpu");
    application = await electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args,
      env: { ...process.env, NODE_ENV: "test", CACADUU_TEST_PROFILE: profile },
    });
    const page = await application.firstWindow();
    await page.waitForSelector("#stat-connections");
    await page.locator('[data-page="connections"]').click();
    await page.locator("#new-pos-connection").click();
    await page.locator('#wizard-types [data-integration="file"]').click();
    await page.locator("#wizard-next").click();
    await page.locator("#wizard-name").fill("Fixture file");
    await page.locator("#wizard-file").fill(input);
    await page.locator("#wizard-next").click();
    await page.locator("#wizard-preview").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#wizard-inventory")
        .textContent.includes("TEST-1"),
    );
    await page
      .locator("#wizard-product-mappings")
      .fill("TEST-1 = shared-test-product");
    await page
      .locator("#wizard-warehouse-mappings")
      .fill("test-warehouse = shared-test-warehouse");
    await page.locator("#wizard-next").click();
    await page.locator("#wizard-test").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#wizard-test-result")
        .textContent.includes("File read validated"),
    );
    await page.locator("#wizard-save").click();
    await page.locator("#connection-list h3").waitFor();
    await page.getByRole("button", { name: "Test read" }).click();
    await page.waitForFunction(() =>
      document
        .querySelector("#notice")
        .textContent.includes("authenticated_read_ok"),
    );
    await page.getByRole("button", { name: "Export locally" }).click();
    await page.waitForFunction(() =>
      document.querySelector("#notice").textContent.includes('"state": "ok"'),
    );
    const state = await page.evaluate(() => window.desktop.snapshot());
    assert.equal(state.connections.length, 1);
    const id = state.connections[0].id;
    assert.equal(state.connections[0].integrationKind, "file");
    assert.deepEqual(state.connections[0].productMappings, {
      "TEST-1": "shared-test-product",
    });
    assert.deepEqual(state.connections[0].warehouseMappings, {
      "test-warehouse": "shared-test-warehouse",
    });
    const output = join(profile, "exports", id, "stock.csv");
    const before = await readFile(output, "utf8");
    assert.match(before, /Test fixture only/);
    await writeFile(
      input,
      "source_code,name,price,currency,quantity,warehouse,observed_at\nTEST-1,Test fixture only,,EUR,3,test-warehouse,2026-10-28T12:00:00Z\n",
    );
    await page.getByRole("button", { name: "Export locally" }).click();
    await page.waitForFunction(() =>
      document.querySelector("#notice").classList.contains("error"),
    );
    assert.equal(await readFile(output, "utf8"), before);
    const prefs = await application.evaluate(({ BrowserWindow }) => {
      const p =
        BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return {
        sandbox: p.sandbox,
        contextIsolation: p.contextIsolation,
        nodeIntegration: p.nodeIntegration,
      };
    });
    assert.deepEqual(prefs, {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    const credentialProbe = await application.evaluate(
      async ({ app, safeStorage }) => {
        const require = process
          .getBuiltinModule("node:module")
          .createRequire(app.getAppPath() + "/package.json");
        const { join } = require("node:path");
        const { readFile } = require("node:fs/promises");
        const { CredentialVault, secureAvailable } = require(
          join(app.getAppPath(), "dist/src/security.js"),
        );
        if (!secureAvailable(safeStorage)) return { available: false };
        const path = join(
          app.getPath("userData"),
          "os-credential-probe.enc.json",
        );
        const vault = new CredentialVault(path, safeStorage);
        await vault.set("probe", { token: "synthetic-fixture-token-only" });
        const disk = await readFile(path, "utf8");
        return {
          available: true,
          encrypted: !disk.includes("synthetic-fixture-token-only"),
          roundTrip:
            (await vault.get("probe")).token === "synthetic-fixture-token-only",
        };
      },
    );
    if (process.platform === "win32")
      assert.equal(
        credentialProbe.available,
        true,
        "Windows DPAPI must be available",
      );
    if (credentialProbe.available) {
      assert.equal(credentialProbe.encrypted, true);
      assert.equal(credentialProbe.roundTrip, true);
      console.log("OS secure credential roundtrip passed");
    } else
      console.log(
        "OS credential roundtrip not run: no secure Linux keyring available",
      );
    // Reopen the same profile to verify persisted state in the distributed application.
    await application.close();
    application = undefined;
    application = await electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args,
      env: { ...process.env, NODE_ENV: "test", CACADUU_TEST_PROFILE: profile },
    });
    const reopened = await application.firstWindow();
    await reopened.waitForFunction(
      () => document.querySelector("#stat-connections")?.textContent === "1",
    );
    const restored = await reopened.evaluate(() => window.desktop.snapshot());
    assert.equal(restored.connections[0].id, id);
    assert.equal(restored.connections[0].status, "authenticated_read_ok");
    console.log((packaged ? "Packaged" : "Source") + " profile restart passed");
    console.log(
      "Electron end-to-end passed: real IPC, POS wizard, real file preview, mapping templates, read test, SQLite persistence, local export, invalid-data preservation, sandbox and context isolation",
    );
  } finally {
    if (application) await application.close();
    await rm(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
