import { validateCsvImport, type CsvImportProfile } from "./sync/csv-import";
import { OdooAdapter } from "./sync/adapters/odoo";
import { ErpNextAdapter } from "./sync/adapters/erpnext";
import { regionalConnectors, regionalConnector } from "./regional-connectors";
import { connectorCapabilities } from "./connectors";
import {
  SyncCoordinator,
  StaggeredScheduler,
  type TimerClock,
} from "./sync/runtime";
import { providerRequests } from "./sync/http";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CredentialVault, httpsUrl, publicError, UserError } from "./security";
import { SqliteSyncStore } from "./sync/store";
import { FileInventoryAdapter, inspectCsvHeaders } from "./sync/adapters/file";
import { WooCommerceAdapter } from "./sync/adapters/woocommerce";
import { ShopifyAdapter } from "./sync/adapters/shopify";
import { ShoptetAdapter } from "./sync/adapters/shoptet";
import { validateStock } from "./sync/engine";
import { runGroup } from "./sync/runner";
import { exportStock, exportRows } from "./export";
import type { GroupConfig } from "./sync/config";
import type { InventoryAdapter, Platform, SyncGroup } from "./sync/types";
export interface DesktopConnection {
  id: string;
  name: string;
  platform: Platform;
  baseUrl?: string;
  database?: string;
  shopDomain?: string;
  stockPath?: string;
  csvImport?: CsvImportProfile;
  permission: "read" | "read_write";
  status: string;
  integrationKind?:
    | "cloud_api"
    | "local_api"
    | "file"
    | "command_line"
    | "gui_automation"
    | "hardware_database";
  vendor?: string;
  regionalVendorId?: string;
  setupEndpoint?: string;
  setupPath?: string;
  productMappings?: Record<string, string>;
  warehouseMappings?: Record<string, string>;
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
  readonly scheduler: StaggeredScheduler;
  readonly runtime: SyncCoordinator;
  private busy = new Set<string>();
  private active = 0;
  private closing = false;
  private idle: (() => void)[] = [];
  constructor(
    readonly directory: string,
    private readonly vault: CredentialVault,
    options: {
      schedulerClock?: TimerClock;
      syncConcurrency?: number;
      maxPending?: number;
    } = {},
  ) {
    this.runtime = new SyncCoordinator(
      options.syncConcurrency ?? 4,
      options.maxPending ?? 256,
    );
    this.store = new SqliteSyncStore(join(directory, "inventory.db"));
    this.scheduler = new StaggeredScheduler(
      (id) => this.sync(id),
      options.schedulerClock,
      (id, error) => {
        if (!this.closing)
          this.log("schedule_deferred", { id, message: publicError(error) });
      },
    );
  }
  private mutations: Promise<unknown> = Promise.resolve();
  private editing = false;
  private shutdown?: Promise<void>;
  private async track<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) throw new UserError("Application is closing");
    this.active++;
    try {
      return await action();
    } finally {
      this.active--;
      if (!this.active) this.idle.splice(0).forEach((resolve) => resolve());
    }
  }
  private mutate<T>(action: () => Promise<T>): Promise<T> {
    return this.track(async () => {
      const operation = this.mutations.then(async () => {
        this.editing = true;
        try {
          return await action();
        } finally {
          this.editing = false;
        }
      });
      this.mutations = operation.catch(() => {});
      return operation;
    });
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
      connectorCapabilities,
      regionalConnectors,
      runtime: {
        groups: this.runtime.stats(),
        requests: providerRequests.stats(),
        schedules: this.scheduler.status(),
      },
      outstandingJobs: (
        this.store.db
          .prepare("SELECT COUNT(*) count FROM outbox WHERE state!='done'")
          .get() as { count: number }
      ).count,
      connections: this.connections(),
      groups: this.groups(),
      history: this.store.db
        .prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100")
        .all(),
      jobs: this.store.db
        .prepare(
          "SELECT id,group_id,destination,product_key,location,quantity,state,attempts,last_error,next_attempt_at FROM outbox ORDER BY (state!='done') DESC,created_at DESC LIMIT 100",
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
  saveConnection(input: unknown) {
    return this.mutate(() => this.saveConnectionNow(input));
  }
  private async saveConnectionNow(input: unknown) {
    if (!input || typeof input !== "object")
      throw new UserError("Connection required");
    const value = input as Record<string, unknown>;
    const id = value.id ? text(value.id, "ID") : randomUUID();
    if (!/^[A-Za-z0-9_-]+$/.test(id))
      throw new UserError("Invalid connection ID");
    if (
      this.groups().some(
        (group) =>
          this.busy.has(group.id) &&
          group.members.some((member) => member.connectionId === id),
      )
    )
      throw new UserError(
        "Wait for the active sync using this connection before editing it",
      );
    const platform = text(value.platform, "Platform") as Platform;
    if (
      ![
        "odoo",
        "erpnext",
        "woocommerce",
        "shopify",
        "shoptet",
        "pos",
        "file",
        "cacaduu",
      ].includes(platform)
    )
      throw new UserError("Unsupported platform");
    if (value.permission !== "read" && value.permission !== "read_write")
      throw new UserError("Permission required");
    if (
      ["odoo", "erpnext", "file", "shoptet", "pos", "cacaduu"].includes(
        platform,
      ) &&
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
    if (["odoo", "woocommerce", "erpnext"].includes(platform))
      c.baseUrl = httpsUrl(text(value.baseUrl, "URL", 2000));
    if (platform === "odoo") c.database = text(value.database, "Odoo database");
    if (platform === "shopify") {
      c.shopDomain = text(value.shopDomain, "Shop domain");
      if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(c.shopDomain))
        throw new UserError("myshopify.com domain required");
    }
    if (platform === "file")
      c.stockPath = text(value.stockPath, "Inventory path", 4096);
    const previous = this.connections().find((x) => x.id === id);
    const csvImport =
      value.csvImport === undefined ? previous?.csvImport : value.csvImport;
    if (csvImport != null) {
      if (platform !== "file")
        throw new UserError("CSV import settings require a file connection");
      c.csvImport = validateCsvImport(csvImport);
      if (!c.stockPath?.toLowerCase().endsWith(".csv"))
        throw new UserError("Mapped import settings require a CSV file");
    }
    const fileChanged =
      previous &&
      (previous.stockPath !== c.stockPath ||
        JSON.stringify(previous.csvImport) !== JSON.stringify(c.csvImport));
    if (
      previous &&
      ((["odoo", "woocommerce", "erpnext"].includes(platform) &&
        previous.baseUrl !== c.baseUrl) ||
        (platform === "shopify" && previous.shopDomain !== c.shopDomain) ||
        (platform === "odoo" && previous.database !== c.database))
    )
      throw new UserError(
        "Create a new connection to change the store endpoint; existing credentials and jobs stay with the original store",
      );
    const regionalId = value.regionalVendorId ?? previous?.regionalVendorId;
    if (regionalId !== undefined) {
      const profile =
        typeof regionalId === "string"
          ? regionalConnector(regionalId)
          : undefined;
      if (!profile) throw new UserError("Unknown regional connector profile");
      if (platform !== "pos" && platform !== "file")
        throw new UserError(
          "This regional vendor has no native driver; use POS setup or a verified normalized file source",
        );
      c.regionalVendorId = profile.id;
    }
    const kind = value.integrationKind ?? previous?.integrationKind;
    if (kind !== undefined) {
      if (
        typeof kind !== "string" ||
        ![
          "cloud_api",
          "local_api",
          "file",
          "command_line",
          "gui_automation",
          "hardware_database",
        ].includes(kind)
      )
        throw new UserError("Invalid integration type");
      if (
        (platform === "file" && kind !== "file") ||
        (["odoo", "erpnext", "woocommerce", "shopify", "cacaduu"].includes(
          platform,
        ) &&
          kind !== "cloud_api") ||
        (platform === "shoptet" && kind !== "cloud_api")
      )
        throw new UserError("Integration type does not match platform");
      c.integrationKind = kind as DesktopConnection["integrationKind"];
    }
    const vendor = value.vendor ?? previous?.vendor;
    if (vendor) c.vendor = text(vendor, "Vendor", 100);
    const endpoint = value.setupEndpoint ?? previous?.setupEndpoint;
    if (endpoint) {
      const url = new URL(text(endpoint, "Endpoint", 2000));
      if (
        platform !== "pos" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          ))
      )
        throw new UserError(
          "Setup endpoint requires HTTPS or loopback HTTP, without embedded credentials",
        );
      c.setupEndpoint = url.toString();
      if (previous?.setupEndpoint && previous.setupEndpoint !== c.setupEndpoint)
        throw new UserError(
          "Create a new connection to change the setup endpoint",
        );
    }
    const setupPath = value.setupPath ?? previous?.setupPath;
    if (setupPath) c.setupPath = text(setupPath, "Setup path", 4096);
    for (const field of ["productMappings", "warehouseMappings"] as const) {
      const mapping = value[field] ?? previous?.[field];
      if (mapping !== undefined) {
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
          throw new UserError("Mapping must contain explicit ID pairs");
        const entries = Object.entries(mapping).map(([key, value]) => [
          text(key, "Local ID"),
          text(value, "Mapped ID"),
        ]);
        if (new Set(entries.map((entry) => entry[1])).size !== entries.length)
          throw new UserError("Mappings must be one-to-one");
        c[field] = Object.fromEntries(entries);
      }
    }
    const affected = this.groups().filter((g) =>
      g.members.some((m) => m.connectionId === id),
    );
    if (fileChanged && affected.some((g) => this.store.hasOutstanding(g.id)))
      throw new UserError(
        "Reconcile outstanding jobs before changing the source file or import settings",
      );
    if (
      previous &&
      previous.permission !== c.permission &&
      affected.some((g) => g.enabled)
    )
      throw new UserError(
        "Pause affected groups before changing connection permission",
      );
    if (previous && previous.platform !== platform)
      throw new UserError("Create a new connection to change platform");
    // Never persist arbitrary renderer properties, tokens, or passwords with public config.
    const token = typeof value.token === "string" ? value.token : "";
    const secret = typeof value.secret === "string" ? value.secret : "";
    const username = typeof value.username === "string" ? value.username : "";
    const password = typeof value.password === "string" ? value.password : "";
    if (token || secret || username || password) {
      const existing = await this.vault.get(id);
      await this.vault.set(id, {
        ...existing,
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        token: token || existing.token || "",
        secret: secret || existing.secret || "",
      });
    }
    this.store.transaction(() => {
      if (fileChanged) {
        for (const group of affected) {
          this.store.db
            .prepare("DELETE FROM observations WHERE group_id=?")
            .run(group.id);
          this.store.db
            .prepare("DELETE FROM conflict_holds WHERE group_id=?")
            .run(group.id);
        }
      }
      this.store.db
        .prepare(
          "INSERT INTO connections(id,platform,config_json,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config_json=excluded.config_json",
        )
        .run(id, platform, JSON.stringify(c), new Date().toISOString());
      this.log("connection_saved", { id, platform });
    });
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
        adapter = new FileInventoryAdapter(c.id, c.stockPath!, c.csvImport);
        break;
      case "odoo":
        adapter = new OdooAdapter(
          c.id,
          c.baseUrl!,
          c.database!,
          credentials.username || "",
          credentials.password || "",
        );
        break;
      case "erpnext":
        if (!credentials.token || !credentials.secret)
          throw new UserError("ERPNext credentials required");
        adapter = new ErpNextAdapter(
          c.id,
          c.baseUrl!,
          credentials.token,
          credentials.secret,
        );
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
        ...(original.readOne
          ? {
              readOne: (productKey: string, location: string) =>
                original.readOne!(productKey, location),
            }
          : {}),
      };
    }
    return adapter;
  }
  testConnection(id: string) {
    return this.track(() => this.testConnectionNow(id));
  }
  private async testConnectionNow(id: string) {
    const c = this.connections().find((c) => c.id === id);
    if (!c) throw new UserError("Unknown connection");
    if (["pos", "shoptet", "cacaduu"].includes(c.platform))
      return {
        state: "setup_required",
        message: c.regionalVendorId
          ? `${regionalConnector(c.regionalVendorId)?.name}: ${regionalConnector(c.regionalVendorId)?.access}`
          : c.platform === "cacaduu"
            ? "Use optional Cloud pairing in Settings"
            : "No verified vendor driver/API authorization configured",
      };
    try {
      const rows = await (await this.adapter(id)).read();
      validateStock(rows);
      if (!this.updateStatus(c, "authenticated_read_ok"))
        return {
          state: "not_tested",
          message: "Connection changed during test; run the test again",
        };
      return {
        state: "authenticated_read_ok",
        count: rows.length,
        message: "Read validated. Write permission has not been tested.",
      };
    } catch (e) {
      this.updateStatus(c, "error");
      return { state: "error", message: publicError(e) };
    }
  }
  private updateStatus(expected: DesktopConnection, status: string): boolean {
    const result = this.store.db
      .prepare(
        "UPDATE connections SET config_json=json_set(config_json,'$.status',?) WHERE id=? AND config_json=?",
      )
      .run(status, expected.id, JSON.stringify(expected));
    if (result.changes)
      this.log("connection_test", { id: expected.id, status });
    return result.changes > 0;
  }
  setGroupEnabled(id: string, enabled: unknown) {
    if (this.closing) throw new UserError("Application is closing");
    if (this.editing)
      throw new UserError("Configuration update in progress; retry afterwards");
    if (typeof enabled !== "boolean")
      throw new UserError("Enabled must be a boolean");
    if (enabled && this.busy.has(id))
      throw new UserError(
        "Wait for the previous sync to finish before resuming",
      );
    const group = this.groups().find((g) => g.id === id);
    if (!group) throw new UserError("Unknown group");
    if (enabled) {
      const connections = this.connections();
      for (const member of group.members) {
        const connection = connections.find(
          (c) => c.id === member.connectionId,
        );
        if (
          !connection ||
          (member.role !== "source" && connection.permission !== "read_write")
        )
          throw new UserError(
            "Review member permissions before resuming this group",
          );
      }
    }
    group.enabled = enabled;
    this.store.transaction(() => {
      this.store.db
        .prepare("UPDATE sync_groups SET enabled=?,config_json=? WHERE id=?")
        .run(enabled ? 1 : 0, JSON.stringify(group), id);
      this.log(enabled ? "group_resumed" : "group_paused", { id });
    });
    void this.restartSchedules();
    return {
      state: enabled ? "enabled" : "paused",
      message: enabled
        ? "Scheduled and manual synchronization enabled"
        : "Paused; queued jobs retained. A remote request already sent may still complete.",
    };
  }
  saveGroup(input: unknown) {
    return this.mutate(() => this.saveGroupNow(input));
  }
  private async saveGroupNow(input: unknown) {
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
    const previous = this.groups().find((existing) => existing.id === id);
    const structure = (value: GroupConfig) =>
      JSON.stringify({
        mode: value.mode,
        masterId: value.masterId,
        members: value.members,
        mappings: value.mappings,
        locationMappings: value.locationMappings,
      });
    this.store.transaction(() => {
      if (previous && structure(previous) !== structure(g)) {
        this.store.db
          .prepare("DELETE FROM observations WHERE group_id=?")
          .run(id);
        this.store.db
          .prepare("DELETE FROM conflict_holds WHERE group_id=?")
          .run(id);
      }
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
    });
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
    if (this.editing)
      throw new UserError(
        "Configuration update in progress; retry sync afterwards",
      );
    if (this.busy.has(id)) throw new UserError("Group already running");
    this.busy.add(id);
    this.active++;
    try {
      const config = this.groups().find((group) => group.id === id);
      if (!config || !config.enabled)
        throw new UserError("Enable a configured group first");
      return await this.runtime.run(
        config.members.map((member) => member.connectionId),
        () => this.executeSync(id),
      );
    } finally {
      this.busy.delete(id);
      this.active--;
      if (!this.active) this.idle.splice(0).forEach((resolve) => resolve());
    }
  }
  private async executeSync(id: string) {
    try {
      const config = this.groups().find((g) => g.id === id);
      if (!config || !config.enabled || this.closing)
        return {
          plan: { groupId: id, writes: [], conflicts: [], sourceCount: 0 },
          errors: [],
          paused: true,
          exportState: "not_applicable",
        };
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
      const result = await runGroup(g, this.store, {
        canContinue: () => !this.closing && this.store.isGroupEnabled(id),
      });
      this.log(result.paused ? "sync_paused" : "sync_completed", {
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
  exportLocal(id: string) {
    return this.track(() => this.exportLocalNow(id));
  }
  private async exportLocalNow(id: string) {
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
  csvHeaders(path: unknown, format: unknown) {
    return this.track(() =>
      inspectCsvHeaders(text(path, "File path", 4096), format),
    );
  }
  previewFile(path: unknown, csvImport?: unknown) {
    return this.track(async () => {
      const rows = await new FileInventoryAdapter(
        "preview",
        text(path, "File path", 4096),
        csvImport == null ? undefined : validateCsvImport(csvImport),
      ).read();
      validateStock(rows);
      return {
        count: rows.length,
        rows: rows
          .slice(0, 1000)
          .map(({ productKey, sku, location, available, onHand }) => ({
            productKey,
            sku,
            location,
            quantity: available ?? onHand,
          })),
      };
    });
  }
  inspect(id: string) {
    return this.track(() => this.inspectNow(id));
  }
  private async inspectNow(id: string) {
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
  async restartSchedules() {
    if (this.closing) return;
    this.scheduler.configure(this.groups());
  }
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closing = true;
    this.scheduler.stopAll();
    this.runtime.close();
    this.shutdown = (async () => {
      if (this.active)
        await new Promise<void>((resolve) => this.idle.push(resolve));
      this.store.close();
    })();
    return this.shutdown;
  }
}
