import { open } from "node:fs/promises";
import { UserError } from "../../security";
import {
  validateCsvImport,
  csvNumber,
  type CsvImportProfile,
} from "../csv-import";
import { extname } from "node:path";
import { parse } from "csv-parse/sync";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { stockCsv, type StockRow } from "../../export";
import { validateStock } from "../engine";
import type { InventoryAdapter, Stock } from "../types";
const maxBytes = 16 * 1024 * 1024;
async function boundedBytes(path: string): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) return Buffer.concat(chunks, total);
      total += bytesRead;
      if (total > maxBytes)
        throw new UserError(
          "Inventory file exceeds 16 MiB; split the export explicitly",
        );
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
}
function number(value: unknown): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    String(value).trim() === ""
  )
    return NaN;
  return Number(value);
}
/** Explicit handover schema only. Unknown headers or incomplete catalogues never produce inferred inventory. */
export class FileInventoryAdapter implements InventoryAdapter {
  readonly platform = "file" as const;
  readonly capabilities = {
    read: true,
    write: false,
    locations: true,
    webhooks: false,
    compareAndSwap: false,
  };
  private readonly csvImport?: CsvImportProfile;
  constructor(
    readonly id: string,
    private readonly path: string,
    csvImport?: CsvImportProfile,
  ) {
    if (csvImport !== undefined) this.csvImport = validateCsvImport(csvImport);
  }
  async read(): Promise<Stock[]> {
    const bytes = await boundedBytes(this.path);
    const text = new TextDecoder(this.csvImport?.encoding ?? "utf-8", {
      fatal: true,
    }).decode(bytes);
    let raw: unknown;
    const extension = extname(this.path).toLowerCase();
    if (this.csvImport && extension !== ".csv")
      throw new UserError("Mapped import settings require a CSV file");
    if (extension === ".csv")
      raw = parse(text, {
        delimiter: this.csvImport?.delimiter ?? ",",
        columns: (headers: string[]) => {
          if (
            headers.some((h) => !h.trim()) ||
            new Set(headers).size !== headers.length
          )
            throw new UserError("CSV headers must be nonempty and unique");
          if (
            this.csvImport &&
            Object.values(this.csvImport.columns).some(
              (h) => !headers.includes(h),
            )
          )
            throw new UserError(
              "A mapped CSV column is missing; check the saved profile against the export",
            );
          return headers;
        },
        bom: true,
        skip_empty_lines: true,
      });
    else if (extension === ".xml") {
      if (
        /<!DOCTYPE|<!ENTITY/i.test(text) ||
        XMLValidator.validate(text) !== true
      )
        throw new Error("Invalid or unsafe XML");
      const xml = new XMLParser({
        ignoreAttributes: false,
        parseTagValue: false,
        trimValues: false,
        isArray: (_name, path) => path === "inventory.product",
      }).parse(text);
      raw = xml.inventory?.product;
    } else if (extension === ".json") raw = JSON.parse(text);
    else throw new Error("Supported inventory files: CSV, XML or JSON");
    if (!Array.isArray(raw)) throw new Error("Expected inventory rows");
    if (raw.length > 100000)
      throw new UserError(
        "Inventory exceeds 100000 rows; split the export explicitly",
      );
    const rows: Stock[] = raw.map((v: unknown) => {
      if (!v || typeof v !== "object") throw new Error("Invalid stock row");
      let r = v as Record<string, unknown>;
      if (this.csvImport) {
        const profile = this.csvImport,
          source = r;
        r = Object.fromEntries(
          Object.entries(profile.columns).map(([target, header]) => [
            target,
            source[header],
          ]),
        );
        if (
          typeof r.observed_at !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            r.observed_at,
          )
        )
          throw new UserError(
            "Mapped CSV timestamps require ISO 8601 with an explicit timezone",
          );
        r.quantity = csvNumber(r.quantity, profile.decimalSeparator);
        if (profile.columns.price)
          r.price = csvNumber(r.price, profile.decimalSeparator);
        if (!profile.columns.name)
          return {
            productKey: String(r.source_code ?? ""),
            sku: String(r.source_code ?? ""),
            location: String(r.warehouse ?? ""),
            onHand:
              profile.quantityKind === "on_hand"
                ? (r.quantity as number)
                : null,
            available:
              profile.quantityKind === "available"
                ? (r.quantity as number)
                : null,
            observedAt: typeof r.observed_at === "string" ? r.observed_at : "",
          };
      }
      if ("productKey" in r) return r as unknown as Stock;
      const product: StockRow = {
        source_code: String(r.source_code ?? ""),
        name: String(r.name ?? ""),
        ean: r.ean === undefined ? undefined : String(r.ean),
        price: number(r.price),
        currency: String(r.currency ?? ""),
        quantity: number(r.quantity),
      };
      stockCsv([product]);
      return {
        productKey: product.source_code,
        sku: product.source_code,
        location: String(r.warehouse ?? ""),
        onHand:
          this.csvImport?.quantityKind === "available"
            ? null
            : product.quantity,
        available:
          this.csvImport?.quantityKind === "on_hand" ? null : product.quantity,
        observedAt: typeof r.observed_at === "string" ? r.observed_at : "",
        product,
      };
    });
    validateStock(rows);
    return rows;
  }
}
/** Read-only format inspection. Returns header metadata, never row contents or a successful stock validation. */
export async function inspectCsvHeaders(path: string, format: unknown) {
  if (extname(path).toLowerCase() !== ".csv")
    throw new UserError("CSV header inspection requires a CSV file");
  if (!format || typeof format !== "object" || Array.isArray(format))
    throw new UserError("Select CSV separator and encoding");
  const f = format as Record<string, unknown>;
  if (
    Object.keys(f).some((k) => !["delimiter", "encoding"].includes(k)) ||
    ![",", ";", "\t", "|"].includes(f.delimiter as string) ||
    !["utf-8", "windows-1250", "windows-1252"].includes(f.encoding as string)
  )
    throw new UserError("Invalid CSV inspection format");
  try {
    const bytes = await boundedBytes(path);
    const text = new TextDecoder(f.encoding as string, { fatal: true }).decode(
      bytes,
    );
    let headers: string[] = [];
    const rows = parse(text, {
      delimiter: f.delimiter as string,
      bom: true,
      skip_empty_lines: true,
      columns: (values: string[]) => {
        if (
          !values.length ||
          values.length > 128 ||
          values.some(
            (h) => !h.trim() || h.length > 200 || /[\r\n\0]/.test(h),
          ) ||
          new Set(values).size !== values.length
        )
          throw new UserError(
            "CSV headers must be unique, nonempty and at most 128 columns of 200 characters",
          );
        headers = values;
        return values;
      },
    }) as unknown[];
    if (!headers.length) throw new UserError("CSV header row is missing");
    if (rows.length > 100000)
      throw new UserError(
        "Inventory exceeds 100000 rows; split the export explicitly",
      );
    return {
      headers,
      rowCount: rows.length,
      message:
        "Format inspected only. Map columns and preview to validate stock.",
    };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(
      "CSV inspection failed. Check file access, separator, encoding, quoting and row widths.",
    );
  }
}
