"use strict";
// Builds the Windows installer with Inno Setup 6 (Windows only). Not available on Linux CI runners.
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");
if (process.platform !== "win32") {
  console.error(
    "The Inno Setup installer is built on Windows. Run `npm run package:win` for the portable folder.",
  );
  process.exit(1);
}
const candidates = [
  process.env.ISCC,
  join(process.env["ProgramFiles(x86)"] || "", "Inno Setup 6", "ISCC.exe"),
  join(process.env.ProgramFiles || "", "Inno Setup 6", "ISCC.exe"),
].filter(Boolean);
const iscc = candidates.find((path) => existsSync(path));
if (!iscc) {
  console.error(
    "Inno Setup 6 not found. Install it from jrsoftware.org or set ISCC to ISCC.exe.",
  );
  process.exit(1);
}
const result = spawnSync(
  iscc,
  [join("installer", "windows", "test-repo-pos.iss")],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
