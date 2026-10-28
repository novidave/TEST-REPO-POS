import { httpsUrl, UserError } from "../../security";
import { governedFetch, providerFailure } from "../http";
import { validateStock } from "../engine";
import type { InventoryAdapter, Stock } from "../types";
/** Independently written read-only Frappe v15 REST client; no upstream code embedded. */
export class ErpNextAdapter implements InventoryAdapter {
  readonly platform = "erpnext" as const;
  readonly capabilities = {
    read: true,
    write: false,
    locations: true,
    webhooks: false,
    compareAndSwap: false,
  };
  private readonly baseUrl: string;
  constructor(
    readonly id: string,
    baseUrl: string,
    private readonly key: string,
    private readonly secret: string,
    private readonly http: typeof fetch = governedFetch,
  ) {
    this.baseUrl = httpsUrl(baseUrl);
    if (!key || !secret || /[\r\n:]/.test(key + secret))
      throw new UserError(
        "ERPNext API key and secret are required and must not contain header separators",
      );
  }
  private async bins(start: number, filters?: unknown[]): Promise<Stock[]> {
    const query = new URLSearchParams({
      fields: JSON.stringify([
        "name",
        "item_code",
        "warehouse",
        "actual_qty",
        "stock_uom",
      ]),
      order_by: "name asc",
      limit_start: String(start),
      limit_page_length: "100",
    });
    if (filters) query.set("filters", JSON.stringify(filters));
    const response = await this.http(
      this.baseUrl + "/api/resource/Bin?" + query,
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: "token " + this.key + ":" + this.secret,
          Accept: "application/json",
        },
      },
    );
    if (!response.ok) throw providerFailure("ERPNext", response);
    const body = (await response.json()) as { data?: unknown };
    if (!Array.isArray(body.data))
      throw new UserError("ERPNext returned an invalid stock page");
    return body.data.map((value) => {
      if (!value || typeof value !== "object")
        throw new UserError("ERPNext returned an invalid stock record");
      const row = value as Record<string, unknown>;
      if (
        typeof row.item_code !== "string" ||
        typeof row.warehouse !== "string" ||
        typeof row.stock_uom !== "string" ||
        !row.stock_uom.trim() ||
        !Number.isSafeInteger(row.actual_qty) ||
        (row.actual_qty as number) < 0
      )
        throw new UserError(
          "ERPNext requires an item, warehouse, unit and nonnegative integer actual stock; fractional stock requires an explicit unit-conversion design",
        );
      return {
        productKey: row.item_code,
        sku: row.item_code,
        location: row.warehouse,
        onHand: row.actual_qty as number,
        available: null,
        observedAt: new Date().toISOString(),
      };
    });
  }
  async read(): Promise<Stock[]> {
    const rows: Stock[] = [];
    for (let page = 0; page < 1000; page++) {
      const chunk = await this.bins(page * 100);
      rows.push(...chunk);
      if (chunk.length < 100) {
        validateStock(rows);
        return rows;
      }
    }
    throw new UserError(
      "ERPNext pagination limit reached; refusing incomplete inventory",
    );
  }
  async readOne(
    productKey: string,
    location: string,
  ): Promise<Stock | undefined> {
    const rows = await this.bins(0, [
      ["item_code", "=", productKey],
      ["warehouse", "=", location],
    ]);
    if (!rows.length) return undefined;
    validateStock(rows);
    if (
      rows.length !== 1 ||
      rows[0].productKey !== productKey ||
      rows[0].location !== location
    )
      throw new UserError("ERPNext returned ambiguous mapped inventory");
    return rows[0];
  }
}
