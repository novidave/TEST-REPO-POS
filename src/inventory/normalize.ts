import { UserError } from "../security";
import { validateStock } from "../sync/engine";
import type { Stock } from "../sync/types";
import type { StockRow } from "../export";
import { isIsoCurrency } from "./currencies";

/** The common internal inventory model. Every value comes from the source; nothing is defaulted. */
export interface NormalizedItem {
  sourceConnectionId: string;
  sourceProductId: string;
  sku: string;
  ean: string | null;
  name: string;
  price: number;
  currency: string;
  /** Actual remaining stock as reported by the source, after explicit source rules only. */
  quantity: number;
  quantityKind: "available" | "on_hand";
  warehouse: string;
  /** Derived only from the actual quantity (> 0 in stock), never from a guess. */
  availabilityStatus: "in_stock" | "out_of_stock";
  sourceUpdatedAt: string;
  snapshotAt: string;
}
export interface NormalizationRules {
  /** Export exactly one warehouse/location. Quantities are never summed across warehouses. */
  warehouse?: string | null;
}
export interface NormalizationIssue {
  severity: "error" | "warning";
  code:
    | "empty"
    | "invalid_stock"
    | "missing_catalogue"
    | "catalogue_mismatch"
    | "invalid_name"
    | "invalid_code"
    | "invalid_price"
    | "invalid_currency"
    | "invalid_ean"
    | "ean_checksum"
    | "duplicate_sku"
    | "duplicate_ean"
    | "mixed_currency"
    | "warehouse_not_found"
    | "multiple_warehouses";
  message: string;
  sourceProductId?: string;
  warehouse?: string;
}
export interface NormalizedSnapshot {
  connectionId: string;
  snapshotAt: string;
  /** Earliest source observation time: freshness is never overstated. */
  sourceTime: string | null;
  warehouses: string[];
  items: NormalizedItem[];
  issues: NormalizationIssue[];
  /** True only when no error issue exists. Incomplete snapshots are held, never published. */
  complete: boolean;
}
const MAX_ISSUES = 200;

/** GS1 mod-10 check for numeric EAN-8/UPC-A/EAN-13/GTIN-14. Other barcode types are kept as reported. */
export function gtinChecksumValid(code: string): boolean | null {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return null;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  const sum = digits
    .reverse()
    .reduce((total, d, i) => total + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

export function normalizeInventory(
  connectionId: string,
  rows: Stock[],
  rules: NormalizationRules = {},
  now = new Date(),
): NormalizedSnapshot {
  const snapshotAt = now.toISOString();
  const issues: NormalizationIssue[] = [];
  const issue = (i: NormalizationIssue) => {
    if (issues.length < MAX_ISSUES) issues.push(i);
  };
  const result = (items: NormalizedItem[], warehouses: string[]) => {
    const times = items
      .map((i) => Date.parse(i.sourceUpdatedAt))
      .filter(Number.isFinite);
    return {
      connectionId,
      snapshotAt,
      sourceTime: times.length
        ? new Date(Math.min(...times)).toISOString()
        : null,
      warehouses,
      items,
      issues,
      complete: !issues.some((i) => i.severity === "error"),
    };
  };
  try {
    validateStock(rows);
  } catch (e) {
    issue({
      severity: "error",
      code: Array.isArray(rows) && rows.length ? "invalid_stock" : "empty",
      message:
        e instanceof UserError ? e.message : "Invalid inventory observations",
    });
    return result([], []);
  }
  const warehouses = [...new Set(rows.map((r) => r.location))].sort();
  let selected = rows;
  if (rules.warehouse) {
    selected = rows.filter((r) => r.location === rules.warehouse);
    if (!selected.length) {
      issue({
        severity: "error",
        code: "warehouse_not_found",
        message: `Selected warehouse "${rules.warehouse}" is not present in the source data`,
        warehouse: rules.warehouse,
      });
      return result([], warehouses);
    }
  }
  const items: NormalizedItem[] = [];
  const bySku = new Map<string, string[]>();
  const byEan = new Map<string, Set<string>>();
  for (const s of selected) {
    const p = s.product;
    const quantity = (s.available ?? s.onHand)!;
    const ref = { sourceProductId: s.productKey, warehouse: s.location };
    if (!p) {
      issue({
        severity: "error",
        code: "missing_catalogue",
        message:
          "Verified catalogue metadata missing: product name, selling price and currency were not supplied by the source",
        ...ref,
      });
      continue;
    }
    if (p.source_code !== s.sku || p.quantity !== quantity) {
      issue({
        severity: "error",
        code: "catalogue_mismatch",
        message: "Catalogue metadata and stock observation disagree",
        ...ref,
      });
      continue;
    }
    let valid = true;
    if (!p.source_code.trim() || p.source_code.length > 100) {
      issue({
        severity: "error",
        code: "invalid_code",
        message: "Source code must be 1–100 characters",
        ...ref,
      });
      valid = false;
    }
    if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 300) {
      issue({
        severity: "error",
        code: "invalid_name",
        message: "Product name must be 1–300 characters",
        ...ref,
      });
      valid = false;
    }
    if (!Number.isFinite(p.price) || p.price < 0) {
      issue({
        severity: "error",
        code: "invalid_price",
        message: "Selling price must be a finite nonnegative number",
        ...ref,
      });
      valid = false;
    }
    if (!isIsoCurrency(p.currency)) {
      issue({
        severity: "error",
        code: "invalid_currency",
        message: `Currency "${String(p.currency).slice(0, 8)}" is not an ISO 4217 code`,
        ...ref,
      });
      valid = false;
    }
    const ean = p.ean?.trim() ? p.ean.trim() : null;
    if (ean && (ean.length > 32 || /[\0\r\n]/.test(ean))) {
      issue({
        severity: "error",
        code: "invalid_ean",
        message: "EAN/barcode must be at most 32 characters",
        ...ref,
      });
      valid = false;
    } else if (ean && gtinChecksumValid(ean) === false)
      issue({
        severity: "warning",
        code: "ean_checksum",
        message: `EAN ${ean} has an invalid GS1 check digit; exported as reported`,
        ...ref,
      });
    if (!valid) continue;
    bySku.set(p.source_code, [
      ...(bySku.get(p.source_code) ?? []),
      s.location,
    ]);
    if (ean) byEan.set(ean, (byEan.get(ean) ?? new Set()).add(p.source_code));
    items.push({
      sourceConnectionId: connectionId,
      sourceProductId: s.productKey,
      sku: p.source_code,
      ean,
      name: p.name,
      price: p.price,
      currency: p.currency,
      quantity,
      quantityKind: s.available !== null ? "available" : "on_hand",
      warehouse: s.location,
      availabilityStatus: quantity > 0 ? "in_stock" : "out_of_stock",
      sourceUpdatedAt: new Date(Date.parse(s.observedAt)).toISOString(),
      snapshotAt,
    });
  }
  for (const [sku, locations] of bySku)
    if (locations.length > 1)
      issue({
        severity: "error",
        code: rules.warehouse ? "duplicate_sku" : "multiple_warehouses",
        message: rules.warehouse
          ? `SKU ${sku} appears more than once`
          : `SKU ${sku} is stocked in ${locations.length} warehouses (${locations.join(", ")}). Select one warehouse to export; quantities are never summed.`,
        sourceProductId: sku,
      });
  for (const [ean, skus] of byEan)
    if (skus.size > 1)
      issue({
        severity: "warning",
        code: "duplicate_ean",
        message: `EAN ${ean} is shared by ${skus.size} SKUs (${[...skus].slice(0, 5).join(", ")})`,
      });
  const currencies = new Set(items.map((i) => i.currency));
  if (currencies.size > 1)
    issue({
      severity: "warning",
      code: "mixed_currency",
      message: `Prices use ${currencies.size} currencies: ${[...currencies].join(", ")}`,
    });
  return result(items, warehouses);
}

/** Converts a complete normalized snapshot into the stock.csv handover rows. */
export function handoverRows(snapshot: NormalizedSnapshot): StockRow[] {
  if (!snapshot.complete || !snapshot.items.length)
    throw new UserError(
      snapshot.issues.find((i) => i.severity === "error")?.message ??
        "Incomplete snapshot held; previous export preserved",
    );
  return snapshot.items.map((i) => ({
    source_code: i.sku,
    name: i.name,
    ...(i.ean ? { ean: i.ean } : {}),
    price: i.price,
    currency: i.currency,
    quantity: i.quantity,
    warehouse: i.warehouse,
    availability_status: i.availabilityStatus,
    source_updated_at: i.sourceUpdatedAt,
  }));
}
