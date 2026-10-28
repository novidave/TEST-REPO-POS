"use strict";
(async () => {
  const { packager } = await import("@electron/packager");
  const output = await packager({
    dir: process.cwd(),
    name: "CACADUU-Inventory",
    platform: "win32",
    arch: "x64",
    out: "release",
    overwrite: true,
    asar: { unpack: "**/*.node" },
    prune: true,
    ignore: [
      /^\/tests($|\/)/,
      /^\/src($|\/)/,
      /^\/docs($|\/)/,
      /^\/scripts($|\/)/,
      /^\/\.github($|\/)/,
      /^\/test-results($|\/)/,
      /^\/playwright/,
    ],
    win32metadata: {
      CompanyName: "CACADUU",
      FileDescription: "Standalone inventory synchronization",
      ProductName: "CACADUU Inventory",
    },
  });
  console.log("Windows application packaged at " + output.join(", "));
})().catch((error) => {
  console.error(
    String(error.message).replace(/https?:\/\/\S+/g, "[download URL]"),
  );
  console.error(
    "Windows packaging failed. Check dependency install and access to official Electron downloads.",
  );
  process.exitCode = 1;
});
