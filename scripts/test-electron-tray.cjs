"use strict";
// Background agent check. Needs a real display (Windows desktop, or `xvfb-run -a` on Linux): a tray icon
// cannot exist on a headless platform, where the app intentionally falls back to closing on window close.
const { _electron: electron } = require("playwright");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const electronPath = require("electron");
const extra =
  process.platform === "linux" && process.getuid?.() === 0
    ? ["--no-sandbox"]
    : [];
let settled = false;
process.on("exit", () => {
  if (!settled) {
    console.error("Tray test ended before completion");
    process.exitCode = 1;
  }
});
(async () => {
  const profile = await mkdtemp(join(tmpdir(), "inventory-tray-"));
  const env = {
    ...process.env,
    NODE_ENV: "test",
    CACADUU_TEST_PROFILE: profile,
  };
  let application;
  try {
    application = await electron.launch({
      args: [resolve("."), "--background", ...extra],
      env,
    });
    const page = await application.firstWindow();
    await page.waitForSelector("#stat-connections");
    const state = await page.evaluate(() => window.desktop.snapshot());
    assert.equal(state.app.tray, true, "tray icon created on a real display");
    const visible = () =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().map((w) => w.isVisible()),
      );
    assert.deepEqual(
      await visible(),
      [false],
      "--background starts in the tray without a window",
    );
    // A second launch (e.g. the user opens the app while the login item runs) never starts a second agent.
    const second = spawn(electronPath, [resolve("."), ...extra], {
      env,
      stdio: "ignore",
    });
    const code = await new Promise((done) =>
      second.on("exit", (c, signal) => done(c ?? signal)),
    );
    assert.equal(code, 0, "second instance exits");
    await page.waitForTimeout(500);
    assert.deepEqual(
      await visible(),
      [true],
      "existing agent window is shown instead",
    );
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await page.waitForTimeout(300);
    assert.deepEqual(
      await visible(),
      [false],
      "closing the window keeps the agent running in the tray",
    );
    assert.equal(
      (await page.evaluate(() => window.desktop.snapshot())).settings
        .closeToTray,
      true,
    );
    console.log(
      "Tray/background check passed: --background start, single agent, close-to-tray",
    );
    settled = true;
  } finally {
    if (application) await application.close();
    await rm(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  settled = true;
  console.error(error);
  process.exitCode = 1;
});
