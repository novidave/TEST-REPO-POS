import { writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface StockRow { source_code: string; name: string; ean?: string; price: number; currency: string; quantity: number; }
const quote = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
export function stockCsv(rows: StockRow[]): string {
  for (const r of rows) {
    if (!r.source_code || !r.name || !Number.isFinite(r.price) || r.price < 0 || !Number.isFinite(r.quantity) || !/^[A-Z]{3}$/.test(r.currency)) throw new Error("Invalid stock row");
  }
  return ["source_code,name,ean,price,currency,quantity", ...rows.map(r => [r.source_code,r.name,r.ean,r.price,r.currency,r.quantity].map(quote).join(","))].join("\r\n") + "\r\n";
}
export async function exportStock(directory: string, rows: StockRow[], sourceId: string): Promise<void> {
  if (!rows.length) throw new Error("Refusing to export empty inventory");
  await mkdir(directory, { recursive: true });
  const csv = stockCsv(rows);
  const manifest = { format: "cacaduu.stock.v1", source_id: sourceId, product_count: rows.length, generated_at: new Date().toISOString(), file: "stock.csv", sha256: createHash("sha256").update(csv).digest("hex") };
  const stamp = process.pid + "-" + Date.now();
  const csvTmp = join(directory, "stock.csv." + stamp + ".tmp");
  const manifestTmp = join(directory, "manifest.json." + stamp + ".tmp");
  await writeFile(csvTmp, csv, { flag: "wx" });
  await writeFile(manifestTmp, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await rename(csvTmp, join(directory, "stock.csv"));
  await rename(manifestTmp, join(directory, "manifest.json"));
}
