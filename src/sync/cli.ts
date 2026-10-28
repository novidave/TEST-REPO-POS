import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { createAdapters, createGroups, type AgentConfig } from "./config";
import { SqliteSyncStore } from "./store";
import { runGroup } from "./runner";
import { exportStock, exportRows } from "../export";
import { validateStock } from "./engine";
import { publicError } from "../security";
async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("Configuration file required");
  const config = JSON.parse(
    await readFile(resolve(configPath), "utf8"),
  ) as AgentConfig;
  const adapters = createAdapters(config),
    groups = createGroups(config, adapters);
  await mkdir(dirname(resolve(config.databasePath)), { recursive: true });
  const store = new SqliteSyncStore(resolve(config.databasePath));
  try {
    // File-only usage is useful without a cloud account or a writable destination.
    for (const c of config.connections.filter((c) => c.platform === "file")) {
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(c.id)) throw new Error("Invalid ID");
        const rows = await adapters.get(c.id)!.read();
        validateStock(rows);
        if (rows.some((r) => !r.product))
          throw new Error("Verified catalogue metadata missing");
        await exportStock(
          join(resolve(config.exportDirectory), c.id),
          exportRows(rows),
          c.id,
        );
        console.log(
          JSON.stringify({
            connection: c.id,
            export: "ok",
            count: rows.length,
          }),
        );
      } catch {
        console.error(
          "Local export validation failed; previous files preserved",
        );
        process.exitCode = 1;
      }
    }
    for (const group of groups.filter((g) => g.enabled)) {
      try {
        const result = await runGroup(group, store);
        console.log(
          JSON.stringify({
            group: group.id,
            writes: result.plan.writes.map((x) => ({
              destination: x.destination,
              count: x.updates.length,
            })),
            conflicts: result.plan.conflicts.length,
            errors: result.errors,
          }),
        );
        if (result.errors.length || result.plan.conflicts.length)
          process.exitCode = 1;
      } catch {
        console.error(
          "Group synchronization failed; verify configuration and inventory",
        );
        process.exitCode = 1;
      }
    }
  } finally {
    store.close();
  }
}
main().catch((e) => {
  console.error(publicError(e));
  process.exitCode = 1;
});
