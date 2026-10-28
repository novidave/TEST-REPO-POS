import { UserError } from "../../security";
import { governedFetch, providerFailure } from "../http";
import { validateStock } from "../engine";
import type { InventoryAdapter, Stock } from "../types";
export type ShoptetAccess = "private" | "addon";
const origin = "https://api.myshoptet.com";
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UserError("Shoptet returned invalid inventory data");
  return value as Record<string, unknown>;
}
function whole(value: unknown): number {
  if (
    typeof value !== "string" ||
    !/^\d+(?:\.0+)?$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    throw new UserError(
      "Shoptet stock must be explicit nonnegative whole units; fractional or missing stock is not synchronized",
    );
  return Number(value);
}
/** Independently authored against pinned official OpenAPI. No schema, SDK or upstream implementation is bundled. */
export class ShoptetAdapter implements InventoryAdapter {
  readonly platform = "shoptet" as const;
  readonly capabilities = {
    read: true,
    write: false,
    locations: true,
    webhooks: false,
    compareAndSwap: false,
  };
  constructor(
    readonly id: string,
    private readonly eshopId: number,
    private readonly access: ShoptetAccess,
    private readonly token: string,
    private readonly http: typeof fetch = governedFetch,
  ) {
    if (
      !Number.isSafeInteger(eshopId) ||
      eshopId <= 0 ||
      !["private", "addon"].includes(access) ||
      !token ||
      /[\r\n]/.test(token)
    )
      throw new UserError(
        "Shoptet API access, expected e-shop ID and API token required",
      );
  }
  private async get(path: string): Promise<Record<string, unknown>> {
    const response = await this.http(origin + path, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Accept: "application/json",
        [this.access === "private"
          ? "Shoptet-Private-API-Token"
          : "Shoptet-Access-Token"]: this.token,
      },
    });
    if (!response.ok) throw providerFailure("Shoptet", response);
    const body = record(await response.json());
    if (
      body.errors !== null &&
      (!Array.isArray(body.errors) || body.errors.length)
    )
      throw new UserError(
        "Shoptet reported an API error; no partial stock accepted",
      );
    return record(body.data);
  }
  private async verifyShop() {
    const data = await this.get("/api/eshop");
    if (record(data.contactInformation).eshopId !== this.eshopId)
      throw new UserError(
        "Shoptet token belongs to a different e-shop; inventory was not read",
      );
  }
  private stockId(value: unknown): string {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
      throw new UserError("Invalid Shoptet stock identity");
    return String(value);
  }
  private async supplies(stockId: string, code?: string): Promise<Stock[]> {
    const all: Stock[] = [],
      seen = new Set<string>();
    let expectedTotal: number | undefined,
      expectedPages: number | undefined,
      expectedSize: number | undefined;
    for (let page = 1; page <= 1000; page++) {
      const query = new URLSearchParams({
        page: String(page),
        itemsPerPage: "100",
        include: "changeTime",
      });
      if (code !== undefined) query.set("code", code);
      const data = await this.get(`/api/stocks/${stockId}/supplies?${query}`),
        p = record(data.paginator);
      if (
        !Array.isArray(data.supplies) ||
        ["page", "pageCount", "totalCount", "itemsOnPage", "itemsPerPage"].some(
          (k) => !Number.isSafeInteger(p[k]) || Number(p[k]) < 0,
        ) ||
        p.page !== page ||
        p.itemsOnPage !== data.supplies.length ||
        Number(p.itemsPerPage) < 1 ||
        data.supplies.length > Number(p.itemsPerPage) ||
        Number(p.pageCount) > 1000 ||
        Number(p.totalCount) > 100000 ||
        (Number(p.totalCount) > 0 &&
          Number(p.pageCount) !==
            Math.ceil(Number(p.totalCount) / Number(p.itemsPerPage)))
      )
        throw new UserError(
          "Shoptet pagination is invalid; incomplete stock refused",
        );
      if (
        expectedTotal !== undefined &&
        (expectedTotal !== p.totalCount ||
          expectedPages !== p.pageCount ||
          expectedSize !== p.itemsPerPage)
      )
        throw new UserError(
          "Shoptet inventory changed during pagination; retry a complete read",
        );
      expectedTotal = Number(p.totalCount);
      expectedPages = Number(p.pageCount);
      expectedSize = Number(p.itemsPerPage);
      for (const value of data.supplies) {
        const r = record(value);
        if (
          typeof r.code !== "string" ||
          !r.code.trim() ||
          typeof r.productGuid !== "string" ||
          !r.productGuid.trim() ||
          seen.has(r.code) ||
          (code !== undefined && r.code !== code)
        )
          throw new UserError(
            "Shoptet SKU/product mapping is missing, repeated or inconsistent",
          );
        seen.add(r.code);
        const amount = whole(r.amount),
          claim = whole(r.claim);
        if (claim !== 0)
          throw new UserError(
            "Shoptet reserved stock requires reservation reconciliation; this initial connector accepts zero-claim stock only",
          );
        all.push({
          productKey: r.code,
          sku: r.code,
          location: stockId,
          onHand: amount,
          available: null,
          observedAt: new Date().toISOString(),
        });
      }
      if (page >= Number(p.pageCount)) {
        if (all.length !== p.totalCount)
          throw new UserError("Shoptet inventory count is incomplete");
        if (all.length) validateStock(all);
        return all;
      }
      if (!data.supplies.length)
        throw new UserError(
          "Shoptet returned an empty intermediate inventory page",
        );
    }
    throw new UserError("Shoptet pagination limit reached");
  }
  async read(): Promise<Stock[]> {
    await this.verifyShop();
    const data = await this.get("/api/stocks");
    if (!Array.isArray(data.stocks) || !data.stocks.length)
      throw new UserError(
        "Shoptet stock module/read permissions required; no warehouses returned",
      );
    const ids = data.stocks.map((v) => this.stockId(record(v).id));
    if (new Set(ids).size !== ids.length || ids.length > 1000)
      throw new UserError(
        "Shoptet stock identities are repeated or exceed the safety limit",
      );
    const rows: Stock[] = [];
    for (const id of ids) {
      rows.push(...(await this.supplies(id)));
      if (rows.length > 100000)
        throw new UserError(
          "Shoptet inventory exceeds 100000 rows; no partial inventory accepted",
        );
    }
    validateStock(rows);
    return rows;
  }
  async readOne(
    productKey: string,
    location: string,
  ): Promise<Stock | undefined> {
    if (
      !productKey.trim() ||
      !/^\d+$/.test(location) ||
      !Number.isSafeInteger(Number(location)) ||
      String(Number(location)) !== location
    )
      throw new UserError("Shoptet exact SKU and numeric stock ID required");
    await this.verifyShop();
    const rows = await this.supplies(location, productKey);
    if (rows.length > 1)
      throw new UserError("Shoptet mapped item is ambiguous");
    return rows[0];
  }
}
