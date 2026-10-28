"use strict";
(async () => {
  const { packager } = await import("@electron/packager");
  const platform = process.argv[2] || process.platform;
  if (!["win32", "linux"].includes(platform))
    throw new Error("Supported package targets: win32, linux");
  const output = await packager({
    dir: process.cwd(),
    name: "CACADUU-Inventory",
    platform,
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
    ...(platform === "win32"
      ? {
          win32metadata: {
            CompanyName: "CACADUU",
            FileDescription: "Standalone inventory synchronization",
            ProductName: "CACADUU Inventory",
          },
        }
      : {}),
  });
  console.log("Desktop application packaged at " + output.join(", "));
})().catch((error) => {
  console.error(
    String(error.message).replace(/https?:\/\/\S+/g, "[download URL]"),
  );
  console.error(
    "Packaging failed. Check dependency installation and official Electron download access.",
  );
  process.exitCode = 1;
});
