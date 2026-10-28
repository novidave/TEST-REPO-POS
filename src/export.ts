import { UserError } from "./security";
import { writeFile, mkdir, rename } from "node:fs/promises";
import type { Stock } from "./sync/types";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface StockRow {
  source_code: string;
  name: string;
  ean?: string;
  price: number;
  currency: string;
  quantity: number;
}
const quote = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
export function stockCsv(rows: StockRow[]): string {
  if (!Array.isArray(rows) || !rows.length)
    throw new UserError("Refusing to export empty inventory");
  const seen = new Set<string>();
  for (const r of rows) {
    if (
      !r ||
      typeof r.source_code !== "string" ||
      !r.source_code.trim() ||
      typeof r.name !== "string" ||
      !r.name.trim() ||
      seen.has(r.source_code) ||
      !Number.isFinite(r.price) ||
      r.price < 0 ||
      !Number.isSafeInteger(r.quantity) ||
      r.quantity < 0 ||
      !/^[A-Z]{3}$/.test(r.currency)
    )
      throw new UserError("Invalid stock row");
    seen.add(r.source_code);
  }
  return (
    [
      "source_code,name,ean,price,currency,quantity",
      ...rows.map((r) =>
        [r.source_code, r.name, r.ean, r.price, r.currency, r.quantity]
          .map(quote)
          .join(","),
      ),
    ].join("\r\n") + "\r\n"
  );
}
export function exportRows(rows: Stock[]): StockRow[] {
  if (
    rows.some(
      (s) =>
        !s.product ||
        s.product.source_code !== s.sku ||
        s.product.quantity !== (s.available ?? s.onHand),
    )
  )
    throw new UserError(
      "Verified catalogue metadata and stock quantity must agree before export",
    );
  const products = rows.map((s) => s.product!);
  stockCsv(products);
  return products;
}
const queues = new Map<string, Promise<void>>();
export async function exportStock(
  directory: string,
  rows: StockRow[],
  sourceId: string,
): Promise<void> {
  const key = resolve(directory);
  const operation = (queues.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => writeExport(directory, rows, sourceId));
  queues.set(key, operation);
  try {
    await operation;
  } finally {
    if (queues.get(key) === operation) queues.delete(key);
  }
}
async function writeExport(
  directory: string,
  rows: StockRow[],
  sourceId: string,
): Promise<void> {
  if (!rows.length) throw new UserError("Refusing to export empty inventory");
  if (!sourceId.trim()) throw new UserError("Source ID required");
  const csv = stockCsv(rows);
  await mkdir(directory, { recursive: true });
  const manifest = {
    format: "cacaduu.stock.v1",
    source_id: sourceId,
    product_count: rows.length,
    generated_at: new Date().toISOString(),
    file: "stock.csv",
    sha256: createHash("sha256").update(csv).digest("hex"),
  };
  const stamp = randomUUID();
  const csvTmp = join(directory, "stock.csv." + stamp + ".tmp");
  const manifestTmp = join(directory, "manifest.json." + stamp + ".tmp");
  await writeFile(csvTmp, csv, { flag: "wx" });
  await writeFile(manifestTmp, JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
  });
  await rename(csvTmp, join(directory, "stock.csv"));
  await rename(manifestTmp, join(directory, "manifest.json"));
}
