"use strict";
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
// better-sqlite3 13 ships Node-API prebuilds. Exercise the real Electron runtime
// rather than rebuilding a stable-ABI addon unnecessarily for each host runtime.
const result = spawnSync(
  require("electron"),
  [join(__dirname, "check-native.cjs")],
  { stdio: "inherit", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
);
if (result.error) {
  console.error("Cannot launch Electron native check");
  process.exit(1);
}
process.exit(result.status ?? 1);
