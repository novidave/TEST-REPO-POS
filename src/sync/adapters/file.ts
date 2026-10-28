import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parse } from "csv-parse/sync";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { stockCsv, type StockRow } from "../../export";
import { validateStock } from "../engine";
import type { InventoryAdapter, Stock } from "../types";
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
  constructor(
    readonly id: string,
    private readonly path: string,
  ) {}
  async read(): Promise<Stock[]> {
    const text = await readFile(this.path, "utf8");
    let raw: unknown;
    const extension = extname(this.path).toLowerCase();
    if (extension === ".csv")
      raw = parse(text, { columns: true, bom: true, skip_empty_lines: true });
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
    const rows: Stock[] = raw.map((v: unknown) => {
      if (!v || typeof v !== "object") throw new Error("Invalid stock row");
      const r = v as Record<string, unknown>;
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
        onHand: product.quantity,
        available: product.quantity,
        observedAt: typeof r.observed_at === "string" ? r.observed_at : "",
        product,
      };
    });
    validateStock(rows);
    return rows;
  }
}
