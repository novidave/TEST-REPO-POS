import type { CsvImportProfile } from "./csv-import";
import { OdooAdapter } from "./adapters/odoo";
import { ErpNextAdapter } from "./adapters/erpnext";
import type { SyncGroup, InventoryAdapter } from "./types";
import { WooCommerceAdapter } from "./adapters/woocommerce";
import { ShopifyAdapter } from "./adapters/shopify";
import { ShoptetAdapter } from "./adapters/shoptet";
import { FileInventoryAdapter } from "./adapters/file";
export interface ConnectionConfig {
  id: string;
  platform: "odoo" | "erpnext" | "woocommerce" | "shopify" | "shoptet" | "file";
  baseUrl?: string;
  database?: string;
  shopDomain?: string;
  shoptetEshopId?: number;
  shoptetAccess?: "private" | "addon";
  shoptetWriteAcknowledged?: boolean;
  stockPath?: string;
  csvImport?: CsvImportProfile;
  permission?: "read" | "read_write";
  credentialEnv?: string;
  secretEnv?: string;
}
export interface GroupConfig {
  id: string;
  mode: "master" | "two_way";
  masterId?: string;
  members: { connectionId: string; role: "source" | "destination" | "both" }[];
  mappings: Record<string, Record<string, string>>;
  locationMappings?: Record<string, Record<string, string>>;
  intervalMinutes: number;
  enabled: boolean;
}
export interface AgentConfig {
  connections: ConnectionConfig[];
  groups: GroupConfig[];
  databasePath: string;
  exportDirectory: string;
}
export function createAdapters(
  config: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, InventoryAdapter> {
  const result = new Map<string, InventoryAdapter>();
  for (const c of config.connections) {
    if (result.has(c.id)) throw new Error("Duplicate connection ID");
    let a: InventoryAdapter;
    if (c.platform === "odoo") {
      if (
        !c.baseUrl ||
        !c.database ||
        !env[c.credentialEnv ?? ""] ||
        !env[c.secretEnv ?? ""]
      )
        throw new Error("Odoo configuration missing");
      if (c.permission === "read_write") throw new Error("Odoo is read-only");
      a = new OdooAdapter(
        c.id,
        c.baseUrl,
        c.database,
        env[c.credentialEnv!]!,
        env[c.secretEnv!]!,
      );
    } else if (c.platform === "erpnext") {
      const key = env[c.credentialEnv ?? ""],
        secret = env[c.secretEnv ?? ""];
      if (!c.baseUrl || !key || !secret)
        throw new Error("ERPNext credentials missing");
      a = new ErpNextAdapter(c.id, c.baseUrl, key, secret);
      if (c.permission === "read_write")
        throw new Error("ERPNext is read-only");
    } else if (c.platform === "woocommerce") {
      const key = env[c.credentialEnv ?? ""];
      const secret = env[c.secretEnv ?? ""];
      if (!c.baseUrl || !key || !secret)
        throw new Error("WooCommerce credentials missing");
      a = new WooCommerceAdapter(c.id, c.baseUrl, key, secret);
    } else if (c.platform === "shopify") {
      const token = env[c.credentialEnv ?? ""];
      if (!c.shopDomain || !token) throw new Error("Shopify token missing");
      a = new ShopifyAdapter(c.id, c.shopDomain, token);
    } else if (c.platform === "file") {
      if (!c.stockPath) throw new Error("File path missing");
      a = new FileInventoryAdapter(c.id, c.stockPath, c.csvImport);
    } else if (c.platform === "shoptet") {
      if (c.permission === "read_write" && c.shoptetWriteAcknowledged !== true)
        throw new Error("Shoptet master-only write acknowledgement required");
      a = new ShoptetAdapter(
        c.id,
        c.shoptetEshopId!,
        c.shoptetAccess || "private",
        env[c.credentialEnv ?? ""] || "",
        undefined,
        c.permission === "read_write" && c.shoptetWriteAcknowledged === true,
      );
    } else throw new Error("Unsupported platform");
    if (c.permission !== "read_write") {
      const original = a;
      a = {
        id: a.id,
        platform: a.platform,
        capabilities: { ...a.capabilities, write: false },
        read: () => original.read(),
        ...(original.readOne
          ? {
              readOne: (productKey: string, location: string) =>
                original.readOne!(productKey, location),
            }
          : {}),
      };
    }
    result.set(c.id, a);
  }
  return result;
}
export function createGroups(
  config: AgentConfig,
  adapters: Map<string, InventoryAdapter>,
): SyncGroup[] {
  return config.groups.map((g) => ({
    id: g.id,
    mode: g.mode,
    masterId: g.masterId,
    enabled: g.enabled,
    intervalMinutes: g.intervalMinutes,
    mappings: g.mappings,
    locationMappings: g.locationMappings,
    members: g.members.map((m) => {
      const adapter = adapters.get(m.connectionId);
      if (!adapter) throw new Error("Unknown connection " + m.connectionId);
      return { adapter, role: m.role };
    }),
  }));
}
