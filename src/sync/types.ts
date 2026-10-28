import type { StockRow } from "../export";
export type Platform =
  "woocommerce" | "shopify" | "shoptet" | "pos" | "file" | "cacaduu";
export type SyncMode = "master" | "two_way";
export interface Stock {
  productKey: string;
  sku: string;
  location: string;
  onHand: number | null;
  available: number | null;
  product?: StockRow;
  revision?: string;
  observedAt: string;
}
export interface StockWrite {
  productKey: string;
  location: string;
  quantity: number;
  expectedRevision?: string;
  operationId: string;
}
export interface Capabilities {
  read: boolean;
  write: boolean;
  locations: boolean;
  webhooks: boolean;
  compareAndSwap: boolean;
}
export interface InventoryAdapter {
  readonly id: string;
  readonly platform: Platform;
  readonly capabilities: Capabilities;
  read(): Promise<Stock[]>;
  readOne?(productKey: string, location: string): Promise<Stock | undefined>;
  write?(updates: StockWrite[]): Promise<void>;
}
export interface Member {
  adapter: InventoryAdapter;
  role: "source" | "destination" | "both";
}
export interface SyncGroup {
  id: string;
  mode: SyncMode;
  masterId?: string;
  members: Member[];
  mappings: Record<string, Record<string, string>>;
  locationMappings?: Record<string, Record<string, string>>;
  enabled: boolean;
  intervalMinutes: number;
}
export interface Conflict {
  groupId: string;
  productKey: string;
  location: string;
  reason: string;
  observations: { source: string; quantity: number; revision?: string }[];
}
export interface Plan {
  groupId: string;
  writes: { destination: string; updates: StockWrite[] }[];
  conflicts: Conflict[];
  sourceCount: number;
  destinationErrors?: { destination: string; error: string }[];
}
