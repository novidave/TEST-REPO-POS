import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CredentialVault, httpsUrl, publicError, UserError } from "./security";
import { SqliteSyncStore } from "./sync/store";
import { FileInventoryAdapter } from "./sync/adapters/file";
import { WooCommerceAdapter } from "./sync/adapters/woocommerce";
import { ShopifyAdapter } from "./sync/adapters/shopify";
import { ShoptetAdapter } from "./sync/adapters/shoptet";
import { validateStock } from "./sync/engine";
import { runGroup, SyncScheduler } from "./sync/runner";
import { exportStock, exportRows } from "./export";
import type { GroupConfig } from "./sync/config";
import type { InventoryAdapter, Platform, SyncGroup } from "./sync/types";
export interface DesktopConnection {
  id: string;
  name: string;
  platform: Platform;
  baseUrl?: string;
  shopDomain?: string;
  stockPath?: string;
  permission: "read" | "read_write";
  status: string;
}
const text = (value: unknown, label: string, max = 200): string => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw new UserError(label + " required");
  return value.trim();
};
export class DesktopService {
  readonly store: SqliteSyncStore;
  readonly scheduler: SyncScheduler;
  private busy = new Set<string>();
  private active = 0;
  private closing = false;
  private idle: (() => void)[] = [];
  constructor(
    readonly directory: string,
    private readonly vault: CredentialVault,
  ) {
    this.store = new SqliteSyncStore(join(directory, "inventory.db"));
    this.scheduler = new SyncScheduler(this.store);
  }
  connections(): DesktopConnection[] {
    return (
      this.store.db
        .prepare("SELECT config_json FROM connections ORDER BY created_at")
        .all() as { config_json: string }[]
    ).map((r) => JSON.parse(r.config_json));
  }
  groups(): GroupConfig[] {
    return (
      this.store.db
        .prepare("SELECT config_json FROM sync_groups ORDER BY id")
        .all() as { config_json: string }[]
    ).map((r) => JSON.parse(r.config_json));
  }
  log(event: string, detail: Record<string, unknown>) {
    this.store.db
      .prepare(
        "INSERT INTO audit_logs(event,detail_json,created_at) VALUES(?,?,?)",
      )
      .run(event, JSON.stringify(detail), new Date().toISOString());
  }
  snapshot() {
    return {
      connections: this.connections(),
      groups: this.groups(),
      history: this.store.db
        .prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100")
        .all(),
      jobs: this.store.db
        .prepare(
          "SELECT id,group_id,destination,product_key,location,quantity,state,attempts,last_error FROM outbox ORDER BY created_at DESC LIMIT 100",
        )
        .all(),
      conflicts: this.store.db
        .prepare(
          "SELECT group_id,product_key,location,reason,created_at FROM conflicts ORDER BY id DESC LIMIT 100",
        )
        .all(),
      exportDirectory: join(this.directory, "exports"),
    };
  }
  async saveConnection(input: unknown) {
    if (!input || typeof input !== "object")
      throw new UserError("Connection required");
    const value = input as Record<string, unknown>;
    const id = value.id ? text(value.id, "ID") : randomUUID();
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new UserError("Invalid connection ID");
    if (this.busy.size)
      throw new UserError("Wait for active sync before editing connections");
    const platform = text(value.platform, "Platform") as Platform;
    if (
      !["woocommerce", "shopify", "shoptet", "pos", "file", "cacaduu"].includes(
        platform,
      )
    )
      throw new UserError("Unsupported platform");
    if (value.permission !== "read" && value.permission !== "read_write")
      throw new UserError("Permission required");
    if (
      ["file", "shoptet", "pos", "cacaduu"].includes(platform) &&
      value.permission !== "read"
    )
      throw new UserError("This connection is read-only or setup-required");
    const c: DesktopConnection = {
      id,
      name: text(value.name, "Name"),
      platform,
      permission: value.permission,
      status: ["shoptet", "pos"].includes(platform)
        ? "setup_required"
        : platform === "cacaduu"
          ? "configure_in_settings"
          : "not_tested",
    };
    if (platform === "woocommerce")
      c.baseUrl = httpsUrl(text(value.baseUrl, "URL", 2000));
    if (platform === "shopify") {
      c.shopDomain = text(value.shopDomain, "Shop domain");
      if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(c.shopDomain))
        throw new UserError("myshopify.com domain required");
    }
    if (platform === "file")
      c.stockPath = text(value.stockPath, "Inventory path", 4096);
    const previous = this.connections().find((x) => x.id === id);
    if (previous && previous.platform !== platform)
      throw new UserError("Create a new connection to change platform");
    // Never persist arbitrary renderer properties, tokens, or passwords with public config.
    const token = typeof value.token === "string" ? value.token : "";
    const secret = typeof value.secret === "string" ? value.secret : "";
    if (token || secret) {
      const existing = await this.vault.get(id);
      await this.vault.set(id, {
        token: token || existing.token || "",
        secret: secret || existing.secret || "",
      });
    }
    this.store.db
      .prepare(
        "INSERT INTO connections(id,platform,config_json,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json",
      )
      .run(id, platform, JSON.stringify(c), new Date().toISOString());
    this.log("connection_saved", { id, platform });
    await this.restartSchedules();
    return c;
  }
  async adapter(id: string): Promise<InventoryAdapter> {
    const c = this.connections().find((c) => c.id === id);
    if (!c) throw new UserError("Unknown connection");
    const credentials = await this.vault.get(id);
    let adapter: InventoryAdapter;
    switch (c.platform) {
      case "file":
        adapter = new FileInventoryAdapter(c.id, c.stockPath!);
        break;
      case "woocommerce":
        if (!credentials.token || !credentials.secret)
          throw new UserError("Credentials required");
        adapter = new WooCommerceAdapter(
          c.id,
          c.baseUrl!,
          credentials.token,
          credentials.secret,
        );
        break;
      case "shopify":
        if (!credentials.token) throw new UserError("Token required");
        adapter = new ShopifyAdapter(c.id, c.shopDomain!, credentials.token);
        break;
      default:
        adapter = new ShoptetAdapter(c.id);
    }
    if (c.permission === "read") {
      const original = adapter;
      adapter = {
        id: original.id,
        platform: original.platform,
        capabilities: { ...original.capabilities, write: false },
        read: () => original.read(),
      };
    }
    return adapter;
  }
  async testConnection(id: string) {
    const c = this.connections().find((c) => c.id === id);
    if (!c) throw new UserError("Unknown connection");
    if (["pos", "shoptet", "cacaduu"].includes(c.platform))
      return {
        state: "setup_required",
        message:
          c.platform === "cacaduu"
            ? "Use optional Cloud pairing in Settings"
            : "No verified vendor driver/API authorization configured",
      };
    try {
      const rows = await (await this.adapter(id)).read();
      validateStock(rows);
      c.status = "authenticated_read_ok";
      this.updateStatus(c);
      return {
        state: c.status,
        count: rows.length,
        message: "Read validated. Write permission has not been tested.",
      };
    } catch (e) {
      c.status = "error";
      this.updateStatus(c);
      return { state: "error", message: publicError(e) };
    }
  }
  private updateStatus(c: DesktopConnection) {
    this.store.db
      .prepare("UPDATE connections SET config_json=? WHERE id=?")
      .run(JSON.stringify(c), c.id);
    this.log("connection_test", { id: c.id, status: c.status });
  }
  async saveGroup(input: unknown) {
    if (!input || typeof input !== "object")
      throw new UserError("Group required");
    const v = input as GroupConfig;
    const id = v.id ? text(v.id, "Group ID") : randomUUID();
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new UserError("Invalid group ID");
    if (this.busy.has(id) || this.store.hasOutstanding(id))
      throw new UserError(
        "Reconcile outstanding jobs before editing this group",
      );
    if (v.mode !== "master" && v.mode !== "two_way")
      throw new UserError("Invalid sync mode");
    if (
      !Number.isInteger(v.intervalMinutes) ||
      v.intervalMinutes < 1 ||
      v.intervalMinutes > 10080
    )
      throw new UserError("Interval must be 1–10080 minutes");
    if (
      typeof v.enabled !== "boolean" ||
      !Array.isArray(v.members) ||
      v.members.length < 2 ||
      new Set(v.members.map((m) => m.connectionId)).size !== v.members.length
    )
      throw new UserError("At least two distinct members required");
    const members = v.members.map((m) => ({
      connectionId: text(m.connectionId, "Connection"),
      role: m.role,
    }));
    const mappings: Record<string, Record<string, string>> = {},
      locationMappings: Record<string, Record<string, string>> = {};
    for (const m of members) {
      if (!["source", "destination", "both"].includes(m.role))
        throw new UserError("Invalid role");
      const adapter = await this.adapter(m.connectionId);
      if (!adapter.capabilities.read)
        throw new UserError(
          "Setup-required connection cannot join active sync",
        );
      if (m.role !== "source" && !adapter.capabilities.write)
        throw new UserError("Read-only connection cannot be a destination");
      if (
        v.mode === "two_way" &&
        (m.role !== "both" || !adapter.capabilities.compareAndSwap)
      )
        throw new UserError(
          "Two-way mode requires atomic compare-and-swap on every member",
        );
      for (const [target, source] of [
        [mappings, v.mappings],
        [locationMappings, v.locationMappings],
      ] as const) {
        const map = source?.[m.connectionId];
        if (
          !map ||
          typeof map !== "object" ||
          Array.isArray(map) ||
          !Object.keys(map).length
        )
          throw new UserError(
            "Explicit product and warehouse mappings required",
          );
        const entries = Object.entries(map).map(([k, value]) => [
          text(k, "Mapping key"),
          text(value, "Canonical mapping"),
        ]);
        if (new Set(entries.map((e) => e[1])).size !== entries.length)
          throw new UserError("Mappings must be one-to-one per connection");
        target[m.connectionId] = Object.fromEntries(entries);
      }
    }
    if (
      v.mode === "master" &&
      !members.some((m) => m.connectionId === v.masterId && m.role === "source")
    )
      throw new UserError(
        "Master must have source role (read-only within the group)",
      );
    const g: GroupConfig = {
      id,
      mode: v.mode,
      masterId: v.mode === "master" ? v.masterId : undefined,
      members,
      mappings,
      locationMappings,
      enabled: v.enabled,
      intervalMinutes: v.intervalMinutes,
    };
    this.store.db
      .prepare(
        "INSERT INTO sync_groups VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,master_id=excluded.master_id,interval_minutes=excluded.interval_minutes,enabled=excluded.enabled,config_json=excluded.config_json",
      )
      .run(
        id,
        g.mode,
        g.masterId ?? null,
        g.intervalMinutes,
        g.enabled ? 1 : 0,
        JSON.stringify(g),
      );
    this.log("group_saved", { id, enabled: g.enabled });
    await this.restartSchedules();
    return g;
  }
  private async group(g: GroupConfig): Promise<SyncGroup> {
    return {
      ...g,
      members: await Promise.all(
        g.members.map(async (m) => ({
          role: m.role,
          adapter: await this.adapter(m.connectionId),
        })),
      ),
    };
  }
  async sync(id: string) {
    if (this.closing) throw new UserError("Application is closing");
    if (this.busy.has(id)) throw new UserError("Group already running");
    this.busy.add(id);
    this.active++;
    try {
      const config = this.groups().find((g) => g.id === id);
      if (!config || !config.enabled)
        throw new UserError("Enable a configured group first");
      const g = await this.group(config);
      let exportState = "not_applicable";
      // Local delivery remains default and independent of optional remote destinations.
      if (g.mode === "master") {
        try {
          const rows = await g.members
            .find((m) => m.adapter.id === g.masterId)!
            .adapter.read();
          validateStock(rows);
          if (rows.some((r) => !r.product))
            throw new UserError("Verified catalogue metadata missing");
          await exportStock(
            join(this.directory, "exports", g.id),
            exportRows(rows),
            g.masterId!,
          );
          exportState = "ok";
        } catch {
          exportState = "validation_failed_previous_export_preserved";
        }
      }
      const result = await runGroup(g, this.store);
      this.log("sync_completed", {
        id,
        exportState,
        sourceCount: result.plan.sourceCount,
        conflicts: result.plan.conflicts.length,
        failedDestinations: result.errors.length,
      });
      return { ...result, exportState };
    } catch (e) {
      this.log("sync_failed", { id, message: publicError(e) });
      throw e;
    } finally {
      this.busy.delete(id);
      this.active--;
      if (!this.active) this.idle.splice(0).forEach((resolve) => resolve());
    }
  }
  dismissJob(id: string) {
    const row = this.store.db
      .prepare("SELECT group_id,state FROM outbox WHERE id=?")
      .get(id) as { group_id: string; state: string } | undefined;
    if (!row || row.state !== "blocked" || this.busy.has(row.group_id))
      throw new UserError("Only held jobs in idle groups can be dismissed");
    this.store.transaction(() => {
      this.store.done(id);
      this.store.db
        .prepare("DELETE FROM observations WHERE group_id=?")
        .run(row.group_id);
      this.log("held_job_dismissed", { id, groupId: row.group_id });
    });
    return {
      state: "dismissed",
      message:
        "No remote write performed. Review stock and run a fresh plan; two-way requires a new agreed baseline.",
    };
  }
  async exportLocal(id: string) {
    const rows = await (await this.adapter(id)).read();
    validateStock(rows);
    if (rows.some((r) => !r.product))
      throw new UserError("Verified catalogue metadata required for export");
    await exportStock(
      join(this.directory, "exports", id),
      exportRows(rows),
      id,
    );
    this.log("local_export_completed", { id, count: rows.length });
    return { state: "ok", count: rows.length };
  }
  async inspect(id: string) {
    const rows = await (await this.adapter(id)).read();
    validateStock(rows);
    return rows
      .slice(0, 1000)
      .map(({ productKey, sku, location, available, onHand }) => ({
        productKey,
        sku,
        location,
        quantity: available ?? onHand,
      }));
  }
  private timers: ReturnType<typeof setInterval>[] = [];
  async restartSchedules() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    for (const g of this.groups().filter((g) => g.enabled))
      this.timers.push(
        setInterval(() => {
          this.sync(g.id).catch(() => {});
        }, g.intervalMinutes * 60000),
      );
  }
  async close() {
    this.closing = true;
    this.timers.forEach(clearInterval);
    this.scheduler.stopAll();
    if (this.active)
      await new Promise<void>((resolve) => this.idle.push(resolve));
    this.store.close();
  }
}
