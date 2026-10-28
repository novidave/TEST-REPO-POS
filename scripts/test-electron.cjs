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
    const args = [resolve(".")];
    if (process.env.ELECTRON_TEST_HEADLESS === "1")
      args.push("--ozone-platform=headless", "--disable-gpu");
    application = await electron.launch({
      args,
      env: { ...process.env, NODE_ENV: "test", CACADUU_TEST_PROFILE: profile },
    });
    const page = await application.firstWindow();
    await page.waitForSelector("#stat-connections");
    await page.locator('[data-page="connections"]').click();
    await page.locator("#new-connection").click();
    await page.locator('[name="name"]').fill("Fixture file");
    await page.locator('[name="stockPath"]').fill(input);
    await page
      .getByRole("button", { name: "Save connection", exact: true })
      .click();
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
    console.log(
      "Electron end-to-end passed: real IPC, file setup, read test, SQLite persistence, local export, invalid-data preservation, sandbox and context isolation",
    );
  } finally {
    if (application) await application.close();
    await rm(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
