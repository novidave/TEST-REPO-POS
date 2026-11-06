import type Database from "better-sqlite3";
import { readFile, stat } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { UserError } from "../security";
import { isIsoCurrency } from "./currencies";
import type { InventoryAdapter, Stock } from "../sync/types";

/**
 * Optional minimal inventory for merchants without an external stock system: products, locations,
 * current quantities, adjustments with history, CSV import and barcode lookup. Not an ERP: no
 * accounting, purchasing, fiscal receipts or tax logic.
 */
export interface LocalProduct {
  sku: string;
  name: string;
  ean: string | null;
  price: number;
  currency: string;
}
const text = (value: unknown, label: string, max: number) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\0\r\n]/.test(value)
  )
    throw new UserError(label + " is required (max " + max + " characters)");
  return value.trim();
};
export class LocalInventory {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS local_products(sku TEXT PRIMARY KEY, name TEXT NOT NULL, ean TEXT, price REAL NOT NULL, currency TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS local_products_ean ON local_products(ean);
CREATE TABLE IF NOT EXISTS local_locations(name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS local_stock(sku TEXT NOT NULL REFERENCES local_products(sku), location TEXT NOT NULL REFERENCES local_locations(name), quantity INTEGER NOT NULL CHECK(quantity >= 0), updated_at TEXT NOT NULL, PRIMARY KEY(sku,location));
CREATE TABLE IF NOT EXISTS local_movements(id INTEGER PRIMARY KEY AUTOINCREMENT, sku TEXT NOT NULL, location TEXT NOT NULL, delta INTEGER NOT NULL, quantity_after INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  private product(input: unknown): LocalProduct {
    if (!input || typeof input !== "object")
      throw new UserError("Product required");
    const v = input as Record<string, unknown>;
    const price =
      typeof v.price === "string" ? Number(v.price.replace(",", ".")) : v.price;
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0)
      throw new UserError("Selling price must be a nonnegative number");
    if (!isIsoCurrency(v.currency))
      throw new UserError(
        "Currency must be an ISO 4217 code such as EUR or CZK",
      );
    const ean =
      v.ean === undefined || v.ean === null || v.ean === ""
        ? null
        : text(v.ean, "EAN", 32);
    return {
      sku: text(v.sku, "SKU", 100),
      name: text(v.name, "Product name", 300),
      ean,
      price,
      currency: v.currency,
    };
  }
  saveProduct(input: unknown): LocalProduct {
    const p = this.product(input);
    const clash = this.db
      .prepare("SELECT sku FROM local_products WHERE ean=? AND sku!=?")
      .get(p.ean, p.sku) as { sku: string } | undefined;
    if (p.ean && clash)
      throw new UserError(`EAN ${p.ean} already belongs to SKU ${clash.sku}`);
    this.db
      .prepare(
        "INSERT INTO local_products VALUES(?,?,?,?,?,?) ON CONFLICT(sku) DO UPDATE SET name=excluded.name,ean=excluded.ean,price=excluded.price,currency=excluded.currency,updated_at=excluded.updated_at",
      )
      .run(p.sku, p.name, p.ean, p.price, p.currency, new Date().toISOString());
    return p;
  }
  private location(name: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO local_locations VALUES(?,?)")
      .run(name, new Date().toISOString());
  }
  /** Relative (delta) or absolute (set) adjustment, recorded in the movement history in one transaction. */
  adjust(input: unknown) {
    if (!input || typeof input !== "object")
      throw new UserError("Adjustment required");
    const v = input as Record<string, unknown>;
    const product = this.lookup(text(v.sku, "SKU or barcode", 100));
    if (!product) throw new UserError("Unknown SKU or barcode");
    const location = text(v.location, "Stock location", 80);
    const reason = text(v.reason ?? "adjustment", "Reason", 200);
    const hasDelta = v.delta !== undefined && v.delta !== "";
    const hasSet = v.set !== undefined && v.set !== "";
    if (hasDelta === hasSet)
      throw new UserError("Enter either a change (+/-) or a counted quantity");
    const amount = Number(hasDelta ? v.delta : v.set);
    if (!Number.isSafeInteger(amount))
      throw new UserError("Quantities are whole units");
    return this.db.transaction(() => {
      this.location(location);
      const current =
        (
          this.db
            .prepare(
              "SELECT quantity FROM local_stock WHERE sku=? AND location=?",
            )
            .get(product.sku, location) as { quantity: number } | undefined
        )?.quantity ?? 0;
      const after = hasSet ? amount : current + amount;
      if (after < 0)
        throw new UserError(
          `Stock cannot go below zero (currently ${current})`,
        );
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO local_stock VALUES(?,?,?,?) ON CONFLICT(sku,location) DO UPDATE SET quantity=excluded.quantity,updated_at=excluded.updated_at",
        )
        .run(product.sku, location, after, now);
      this.db
        .prepare(
          "INSERT INTO local_movements(sku,location,delta,quantity_after,reason,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(product.sku, location, after - current, after, reason, now);
      return { sku: product.sku, location, before: current, after };
    })();
  }
  /** Barcode/EAN first, then SKU. */
  lookup(code: string): LocalProduct | undefined {
    const value = code.trim();
    return (this.db
      .prepare(
        "SELECT sku,name,ean,price,currency FROM local_products WHERE ean=?",
      )
      .get(value) ??
      this.db
        .prepare(
          "SELECT sku,name,ean,price,currency FROM local_products WHERE sku=?",
        )
        .get(value)) as LocalProduct | undefined;
  }
  /**
   * CSV columns: sku,name,ean,price,currency,location,quantity (quantity = counted stock).
   * The whole file is validated first and applied in one transaction, or not at all.
   */
  async importCsv(path: string) {
    const info = await stat(path);
    if (info.size > 16 * 1024 * 1024)
      throw new UserError("Import file exceeds 16 MiB");
    let rows: Record<string, string>[];
    try {
      rows = parse(await readFile(path, "utf8"), {
        columns: true,
        bom: true,
        skip_empty_lines: true,
        trim: true,
      });
    } catch {
      throw new UserError(
        "CSV could not be parsed; use comma-separated UTF-8 with a header row",
      );
    }
    if (!rows.length) throw new UserError("Import file has no rows");
    const required = [
      "sku",
      "name",
      "price",
      "currency",
      "location",
      "quantity",
    ];
    if (required.some((c) => !(c in rows[0])))
      throw new UserError(
        "Required columns: " + required.join(", ") + " (optional: ean)",
      );
    const seen = new Set<string>();
    const prepared = rows.map((r, i) => {
      try {
        const product = this.product({ ...r, ean: r.ean });
        const location = text(r.location, "Location", 80);
        const quantity = r.quantity === "" ? NaN : Number(r.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 0)
          throw new UserError("Quantity must be a whole number ≥ 0");
        const key = product.sku + "\0" + location;
        if (seen.has(key)) throw new UserError("Duplicate SKU and location");
        seen.add(key);
        return { product, location, quantity };
      } catch (e) {
        throw new UserError(`Row ${i + 2}: ${(e as Error).message}`);
      }
    });
    this.db.transaction(() => {
      for (const r of prepared) {
        this.saveProduct(r.product);
        this.adjust({
          sku: r.product.sku,
          location: r.location,
          set: r.quantity,
          reason: "CSV import",
        });
      }
    })();
    return {
      rows: prepared.length,
      products: new Set(prepared.map((r) => r.product.sku)).size,
    };
  }
  snapshot(limit = 1000) {
    return {
      stock: this.db
        .prepare(
          "SELECT p.sku,p.name,p.ean,p.price,p.currency,s.location,s.quantity,s.updated_at FROM local_stock s JOIN local_products p ON p.sku=s.sku ORDER BY p.sku,s.location LIMIT ?",
        )
        .all(limit),
      products: (
        this.db.prepare("SELECT COUNT(*) n FROM local_products").get() as {
          n: number;
        }
      ).n,
      locations: (
        this.db
          .prepare("SELECT name FROM local_locations ORDER BY name")
          .all() as { name: string }[]
      ).map((l) => l.name),
      movements: this.db
        .prepare("SELECT * FROM local_movements ORDER BY id DESC LIMIT 100")
        .all(),
    };
  }
  rows(): Stock[] {
    return (
      this.db
        .prepare(
          "SELECT p.sku,p.name,p.ean,p.price,p.currency,s.location,s.quantity,s.updated_at FROM local_stock s JOIN local_products p ON p.sku=s.sku ORDER BY p.sku,s.location",
        )
        .all() as {
        sku: string;
        name: string;
        ean: string | null;
        price: number;
        currency: string;
        location: string;
        quantity: number;
        updated_at: string;
      }[]
    ).map((r) => ({
      productKey: r.sku,
      sku: r.sku,
      location: r.location,
      onHand: r.quantity,
      available: null,
      observedAt: r.updated_at,
      product: {
        source_code: r.sku,
        name: r.name,
        ...(r.ean ? { ean: r.ean } : {}),
        price: r.price,
        currency: r.currency,
        quantity: r.quantity,
      },
    }));
  }
}
/** Read-only source over the local inventory, so it can feed exports and master groups like any POS. */
export class LocalInventoryAdapter implements InventoryAdapter {
  readonly platform = "local" as const;
  readonly capabilities = {
    read: true,
    write: false,
    locations: true,
    webhooks: false,
    compareAndSwap: false,
  };
  constructor(
    readonly id: string,
    private readonly inventory: LocalInventory,
  ) {}
  async read() {
    return this.inventory.rows();
  }
}
