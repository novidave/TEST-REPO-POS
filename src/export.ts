import { UserError } from "./security";
import { open, mkdir, rename, readFile, readdir, unlink } from "node:fs/promises";
import type { Stock } from "./sync/types";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";

export interface StockRow {
  source_code: string;
  name: string;
  ean?: string;
  price: number;
  currency: string;
  quantity: number;
  /** Optional handover fields from the pinned cacaduu.inventory.v1 product contract. */
  warehouse?: string;
  availability_status?: string;
  source_updated_at?: string;
}
export const STOCK_COLUMNS = [
  "source_code",
  "name",
  "ean",
  "price",
  "currency",
  "quantity",
  "warehouse",
  "availability_status",
  "source_updated_at",
] as const;
const quote = (v: unknown) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
const optionalText = (v: unknown, max: number) =>
  v === undefined ||
  (typeof v === "string" && v.length <= max && !/[\0\r\n]/.test(v));
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
      !/^[A-Z]{3}$/.test(r.currency) ||
      !optionalText(r.ean, 32) ||
      !optionalText(r.warehouse, 80) ||
      !optionalText(r.availability_status, 40) ||
      (r.source_updated_at !== undefined &&
        !Number.isFinite(Date.parse(r.source_updated_at)))
    )
      throw new UserError("Invalid stock row");
    seen.add(r.source_code);
  }
  return (
    [
      STOCK_COLUMNS.join(","),
      ...rows.map((r) => STOCK_COLUMNS.map((c) => quote(r[c])).join(",")),
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
export interface ExportMeta {
  /** Unique per read of the source; reused only to retry the same publication. */
  snapshotId?: string;
  /** Time of the source read / earliest source observation, ISO 8601. */
  sourceTime?: string | null;
}
export interface ExportResult {
  directory: string;
  snapshotId: string;
  productCount: number;
  sha256: string;
  bytes: number;
  generatedAt: string;
  sourceTime: string | null;
}
/**
 * Manifest publication protocol (see docs/FOLDER_EXPORT.md):
 * stock.csv is verified in a temporary file and renamed first; manifest.json is renamed last and is the
 * commit marker. A reader trusts stock.csv only when its SHA-256 and row count match the current manifest.
 */
export const MANIFEST_FORMAT = "cacaduu.stock.v1";
const queues = new Map<string, Promise<unknown>>();
export async function exportStock(
  directory: string,
  rows: StockRow[],
  sourceId: string,
  meta: ExportMeta = {},
): Promise<ExportResult> {
  const key = resolve(directory);
  const operation = (queues.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(() => writeExport(directory, rows, sourceId, meta));
  queues.set(key, operation);
  try {
    return await operation;
  } finally {
    if (queues.get(key) === operation) queues.delete(key);
  }
}
async function durableWrite(path: string, data: string) {
  const handle = await open(path, "wx", 0o644);
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}
const sha256 = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
async function removeStaleTemporaries(directory: string) {
  for (const name of await readdir(directory).catch(() => [] as string[]))
    if (/^(stock\.csv|manifest\.json)\.[0-9a-f-]{36}\.tmp$/.test(name))
      await unlink(join(directory, name)).catch(() => {});
}
async function writeExport(
  directory: string,
  rows: StockRow[],
  sourceId: string,
  meta: ExportMeta,
): Promise<ExportResult> {
  if (!rows.length) throw new UserError("Refusing to export empty inventory");
  if (!sourceId.trim()) throw new UserError("Source ID required");
  const csv = stockCsv(rows);
  await mkdir(directory, { recursive: true });
  await removeStaleTemporaries(directory);
  const digest = sha256(csv);
  const generatedAt = new Date().toISOString();
  const snapshotId = meta.snapshotId ?? randomUUID();
  const manifest = {
    format: MANIFEST_FORMAT,
    snapshot_id: snapshotId,
    source_id: sourceId,
    complete: true,
    product_count: rows.length,
    generated_at: generatedAt,
    source_time: meta.sourceTime ?? null,
    file: "stock.csv",
    columns: STOCK_COLUMNS,
    encoding: "utf-8",
    bytes: Buffer.byteLength(csv),
    sha256: digest,
    publication: "manifest-last",
  };
  const stamp = randomUUID();
  const csvTmp = join(directory, "stock.csv." + stamp + ".tmp");
  const manifestTmp = join(directory, "manifest.json." + stamp + ".tmp");
  try {
    await durableWrite(csvTmp, csv);
    // Verify what is actually on disk before anything is published.
    const written = await readFile(csvTmp);
    const records = parse(written, { bom: true, columns: true }) as unknown[];
    if (sha256(written) !== digest || records.length !== rows.length)
      throw new UserError(
        "Export verification failed; previous export preserved",
      );
    await durableWrite(manifestTmp, JSON.stringify(manifest, null, 2) + "\n");
    await rename(csvTmp, join(directory, "stock.csv"));
    await rename(manifestTmp, join(directory, "manifest.json"));
  } catch (e) {
    await unlink(csvTmp).catch(() => {});
    await unlink(manifestTmp).catch(() => {});
    throw e;
  }
  return {
    directory,
    snapshotId,
    productCount: rows.length,
    sha256: digest,
    bytes: manifest.bytes,
    generatedAt,
    sourceTime: manifest.source_time,
  };
}
/** Reader side of the protocol, for downstream watchers and tests. */
export async function readPublishedExport(directory: string): Promise<
  | { state: "ok"; manifest: Record<string, unknown>; csv: string }
  | { state: "missing" | "incomplete" }
> {
  let manifest: Record<string, unknown>;
  let csv: Buffer;
  try {
    manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    csv = await readFile(join(directory, String(manifest.file ?? "stock.csv")));
  } catch {
    return { state: "missing" };
  }
  let count = -1;
  try {
    count = (parse(csv, { bom: true, columns: true }) as unknown[]).length;
  } catch {
    return { state: "incomplete" };
  }
  if (
    manifest.complete === false ||
    manifest.sha256 !== sha256(csv) ||
    count !== manifest.product_count
  )
    return { state: "incomplete" };
  return { state: "ok", manifest, csv: csv.toString("utf8") };
}
