const fs = require("node:fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const report = {
  notice:
    "License metadata inventory only, not legal clearance. Retain upstream notices. No project license is implied by dependency/server licenses.",
  projectLicense: require("../package.json").license || "UNDECLARED",
  packages: Object.entries(lock.packages)
    .filter(([path]) => path)
    .map(([path, p]) => ({
      path,
      version: p.version,
      license: p.license || "UNKNOWN",
      scope: p.dev ? "build/development" : "runtime/optional",
    })),
};
fs.writeFileSync(
  "docs/DEPENDENCY_LICENSES.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  "Recorded " +
    report.packages.length +
    " locked packages; project license " +
    report.projectLicense +
    "; unknown metadata " +
    report.packages.filter((p) => p.license === "UNKNOWN").length,
);
