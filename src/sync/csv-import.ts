import { UserError } from "../security";
export const csvFields = [
  "source_code",
  "quantity",
  "warehouse",
  "observed_at",
  "name",
  "price",
  "currency",
  "ean",
] as const;
type CsvField = (typeof csvFields)[number];
export interface CsvImportProfile {
  version: 1;
  delimiter: "," | ";" | "\t" | "|";
  encoding: "utf-8" | "windows-1250" | "windows-1252";
  decimalSeparator: "." | ",";
  quantityKind: "on_hand" | "available";
  columns: Partial<Record<CsvField, string>> &
    Record<"source_code" | "quantity" | "warehouse" | "observed_at", string>;
}
/** Saved metadata describes exact column names, never constants, executable transforms or guessed values. */
export function validateCsvImport(value: unknown): CsvImportProfile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UserError("CSV import settings required");
  const p = value as Record<string, unknown>;
  if (
    Object.keys(p).some(
      (k) =>
        ![
          "version",
          "delimiter",
          "encoding",
          "decimalSeparator",
          "quantityKind",
          "columns",
        ].includes(k),
    ) ||
    p.version !== 1 ||
    ![",", ";", "\t", "|"].includes(p.delimiter as string) ||
    !["utf-8", "windows-1250", "windows-1252"].includes(p.encoding as string) ||
    ![".", ","].includes(p.decimalSeparator as string) ||
    !["on_hand", "available"].includes(p.quantityKind as string)
  )
    throw new UserError("Invalid CSV import format settings");
  if (!p.columns || typeof p.columns !== "object" || Array.isArray(p.columns))
    throw new UserError("CSV column mappings required");
  const columns = Object.fromEntries(
    Object.entries(p.columns).map(([key, v]) => {
      if (
        !csvFields.includes(key as CsvField) ||
        typeof v !== "string" ||
        !v.trim() ||
        v.length > 200 ||
        /[\r\n\0]/.test(v)
      )
        throw new UserError("Invalid CSV column mapping");
      return [key, v];
    }),
  );
  if (
    ["source_code", "quantity", "warehouse", "observed_at"].some(
      (k) => !columns[k],
    )
  )
    throw new UserError(
      "Map SKU, quantity, warehouse and observed timestamp columns explicitly",
    );
  if (new Set(Object.values(columns)).size !== Object.keys(columns).length)
    throw new UserError("CSV columns must map one-to-one");
  const catalog = ["name", "price", "currency"].filter((k) => columns[k]);
  if (catalog.length && catalog.length !== 3)
    throw new UserError(
      "Map name, price and currency together, or omit all catalogue fields",
    );
  if (columns.ean && catalog.length !== 3)
    throw new UserError("EAN requires complete catalogue mappings");
  return {
    version: 1,
    delimiter: p.delimiter,
    encoding: p.encoding,
    decimalSeparator: p.decimalSeparator,
    quantityKind: p.quantityKind,
    columns,
  } as CsvImportProfile;
}
export function csvNumber(value: unknown, decimal: "." | ","): number {
  if (typeof value !== "string") return NaN;
  const text = value.trim();
  if (!(decimal === "," ? /^\d+(?:,\d+)?$/ : /^\d+(?:\.\d+)?$/).test(text))
    return NaN;
  return Number(decimal === "," ? text.replace(",", ".") : text);
}
