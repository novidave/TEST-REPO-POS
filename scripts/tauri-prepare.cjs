"use strict";
// Stages what the Tauri bundle needs beside the Rust shell:
//   build/tauri-backend/  compiled backend (dist/) + production node_modules
//   src-tauri/binaries/node-<target-triple>[.exe]  Node runtime (externalBin)
// Run after `npm run build`. Production dependencies are copied from the
// installed tree (no network), so better-sqlite3's Node-API binary matches the
// Node runtime that is bundled here. Run on each target OS; it does not cross-build.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const stage = path.join(root, "build", "tauri-backend");
const binaries = path.join(root, "src-tauri", "binaries");
const pkg = require(path.join(root, "package.json"));

if (!fs.existsSync(path.join(root, "dist", "src", "sidecar.js")))
  throw new Error("dist/src/sidecar.js missing; run `npm run build` first");

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(root, "dist"), path.join(stage, "dist"), {
  recursive: true,
});
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      main: "dist/src/sidecar.js",
      dependencies: pkg.dependencies,
    },
    null,
    2,
  ),
);

// Native sources and build intermediates are not needed at runtime.
const skip = new Set(["deps", "src", "obj", "obj.target", ".deps", "test"]);
const copied = new Set();
function resolvePackage(name, from) {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir)
      throw new Error(`Production dependency ${name} is not installed`);
    dir = parent;
  }
}
function copyPackage(name, from) {
  const source = resolvePackage(name, from);
  if (copied.has(source)) return;
  copied.add(source);
  const target = path.join(stage, path.relative(root, source));
  fs.cpSync(source, target, {
    recursive: true,
    filter: (src) =>
      src === source ||
      !skip.has(path.basename(src)) ||
      !path.basename(source).startsWith("better-sqlite3"),
  });
  const manifest = require(path.join(source, "package.json"));
  for (const dep of Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  })) {
    try {
      copyPackage(dep, source);
    } catch (e) {
      if (!manifest.optionalDependencies?.[dep]) throw e;
    }
  }
}
for (const name of Object.keys(pkg.dependencies)) copyPackage(name, root);

// better-sqlite3 ships Node-API prebuilds for every platform; keep this target's.
const prebuilds = path.join(
  stage,
  "node_modules",
  "better-sqlite3",
  "prebuilds",
);
if (fs.existsSync(prebuilds)) {
  // On Linux, keep the glibc or musl build matching the bundled runtime only;
  // a stray musl binary makes AppImage tooling look for musl libc.
  const musl =
    process.platform === "linux" &&
    !process.report?.getReport().header.glibcVersionRuntime;
  const keep = new Set([
    `${musl ? "linuxmusl" : process.platform}-${process.arch}.node`,
  ]);
  for (const file of fs.readdirSync(prebuilds))
    if (!keep.has(file)) fs.rmSync(path.join(prebuilds, file));
}

// Fail early if the staged native module cannot load in the bundled runtime.
execFileSync(
  process.execPath,
  [
    "-e",
    "const D=require('better-sqlite3');const d=new D(':memory:');d.exec('select 1');d.close()",
  ],
  { cwd: stage, stdio: "inherit" },
);

const triple = /host: (\S+)/.exec(
  execFileSync("rustc", ["-vV"], { encoding: "utf8" }),
)?.[1];
if (!triple) throw new Error("Cannot determine Rust host target triple");
fs.mkdirSync(binaries, { recursive: true });
const ext = process.platform === "win32" ? ".exe" : "";
const nodeTarget = path.join(binaries, `cacaduu-node-${triple}${ext}`);
fs.copyFileSync(process.execPath, nodeTarget);
fs.chmodSync(nodeTarget, 0o755);

console.log(
  `Tauri backend staged: ${copied.size} packages, Node ${process.version} -> ${path.relative(root, nodeTarget)}`,
);
