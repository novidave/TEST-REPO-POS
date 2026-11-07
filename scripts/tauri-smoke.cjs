"use strict";
// Launches the built Tauri shell with --smoke-test. The app loads the real
// dashboard in the system webview, calls the Node sidecar over the Tauri IPC
// bridge, opens SQLite in a throwaway profile and exits 0 on success.
// Usage: node scripts/tauri-smoke.cjs [path-to-binary]
// On headless Linux it wraps the run in xvfb-run when DISPLAY is unset.
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const ext = process.platform === "win32" ? ".exe" : "";
const binary = path.resolve(
  process.argv[2] ||
    path.join(
      __dirname,
      "..",
      "src-tauri",
      "target",
      "debug",
      "cacaduu-inventory" + ext,
    ),
);
if (!fs.existsSync(binary)) {
  console.error(
    `Tauri binary not found at ${binary}; run \`npm run tauri:build\` or \`npx tauri build --debug --no-bundle\``,
  );
  process.exit(1);
}
const headless =
  process.platform === "linux" &&
  !process.env.DISPLAY &&
  !process.env.WAYLAND_DISPLAY;
const [command, args] = headless
  ? ["xvfb-run", ["-a", binary, "--smoke-test"]]
  : [binary, ["--smoke-test"]];
const result = spawnSync(command, args, {
  stdio: ["ignore", "pipe", "inherit"],
  encoding: "utf8",
  timeout: 120_000,
  env: { ...process.env, WEBKIT_DISABLE_DMABUF_RENDERER: "1" },
});
process.stdout.write(result.stdout || "");
if (result.error) {
  console.error(`Tauri smoke could not run: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0 || !/Tauri smoke passed/.test(result.stdout || "")) {
  console.error(
    `Tauri smoke failed (exit ${result.status}, signal ${result.signal})`,
  );
  process.exit(1);
}
