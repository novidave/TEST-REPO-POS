import { httpsUrl, UserError } from "../../security";
import { governedFetch, providerFailure } from "../http";
import { validateStock } from "../engine";
import type { InventoryAdapter, Stock } from "../types";
/** Odoo 18 legacy JSON-RPC. Only authenticate and search_read are emitted. */
export class OdooAdapter implements InventoryAdapter {
  readonly platform = "odoo" as const;
  readonly capabilities = {
    read: true,
    write: false,
    locations: true,
    webhooks: false,
    compareAndSwap: false,
  };
  private readonly url: string;
  private uid?: number;
  private sequence = 0;
  constructor(
    readonly id: string,
    baseUrl: string,
    private readonly database: string,
    private readonly username: string,
    private readonly apiKey: string,
    private readonly http: typeof fetch = governedFetch,
  ) {
    this.url = httpsUrl(baseUrl) + "/jsonrpc";
    if (!database || !username || !apiKey)
      throw new UserError("Odoo database, username and API key required");
  }
  private async rpc(
    service: string,
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    const id = ++this.sequence;
    const res = await this.http(this.url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: { service, method, args },
        id,
      }),
    });
    if (!res.ok) throw providerFailure("Odoo", res);
    const data = (await res.json()) as {
      id?: number;
      error?: unknown;
      result?: unknown;
    };
    if (data.error || data.id !== id || !("result" in data))
      throw new UserError(
        "Odoo RPC failed; check API access and stock permissions",
      );
    return data.result;
  }
  private async list(
    model: "stock.quant" | "product.product",
    domain: unknown[],
    fields: string[],
  ): Promise<Record<string, unknown>[]> {
    if (this.uid === undefined) {
      const uid = await this.rpc("common", "authenticate", [
        this.database,
        this.username,
        this.apiKey,
        {},
      ]);
      if (!Number.isSafeInteger(uid) || Number(uid) <= 0)
        throw new UserError("Odoo authentication failed");
      this.uid = Number(uid);
    }
    const all: Record<string, unknown>[] = [];
    const seen = new Set<number>();
    for (let page = 0; page < 1000; page++) {
      const value = await this.rpc("object", "execute_kw", [
        this.database,
        this.uid,
        this.apiKey,
        model,
        "search_read",
        [domain],
        { fields, offset: page * 100, limit: 100, order: "id asc" },
      ]);
      if (!Array.isArray(value))
        throw new UserError("Invalid Odoo stock response");
      for (const row of value) {
        if (
          !row ||
          typeof row !== "object" ||
          !Number.isSafeInteger(row.id) ||
          seen.has(row.id)
        )
          throw new UserError("Invalid or repeated Odoo page");
        seen.add(row.id);
        all.push(row);
      }
      if (value.length < 100) return all;
    }
    throw new UserError(
      "Odoo pagination limit reached; refusing incomplete inventory",
    );
  }
  private async stock(extra: unknown[] = []): Promise<Stock[]> {
    const quants = await this.list(
      "stock.quant",
      [["location_id.usage", "=", "internal"], ...extra],
      ["id", "product_id", "location_id", "quantity", "available_quantity"],
    );
    const ids = new Set<number>();
    for (const q of quants) {
      if (
        !Array.isArray(q.product_id) ||
        !Number.isSafeInteger(q.product_id[0]) ||
        !Array.isArray(q.location_id) ||
        !Number.isSafeInteger(q.location_id[0])
      )
        throw new UserError("Odoo product/location identity missing");
      ids.add(q.product_id[0]);
    }
    const skus = new Map<number, string>(),
      products = [...ids];
    for (let start = 0; start < products.length; start += 100) {
      for (const product of await this.list(
        "product.product",
        [["id", "in", products.slice(start, start + 100)]],
        ["id", "default_code"],
      )) {
        if (
          typeof product.default_code !== "string" ||
          !product.default_code.trim()
        )
          throw new UserError("Odoo internal reference/SKU required");
        skus.set(product.id as number, product.default_code);
      }
    }
    const rows = new Map<string, Stock>();
    for (const q of quants) {
      const pid = (q.product_id as number[])[0],
        location = String((q.location_id as number[])[0]),
        sku = skus.get(pid);
      if (!sku) throw new UserError("Odoo mapped product is not readable");
      for (const field of ["quantity", "available_quantity"])
        if (!Number.isSafeInteger(q[field]) || Number(q[field]) < 0)
          throw new UserError(
            "Odoo fractional/negative inventory requires explicit unit handling",
          );
      const key = pid + "\0" + location,
        previous = rows.get(key);
      const row = {
        productKey: String(pid),
        sku,
        location,
        onHand: (previous?.onHand ?? 0) + Number(q.quantity),
        available: (previous?.available ?? 0) + Number(q.available_quantity),
        observedAt: new Date().toISOString(),
      };
      rows.set(key, row);
    }
    const result = [...rows.values()];
    if (result.length) validateStock(result);
    return result;
  }
  async read() {
    const rows = await this.stock();
    validateStock(rows);
    return rows;
  }
  async readOne(productKey: string, location: string) {
    if (!/^[1-9]\d*$/.test(productKey) || !/^[1-9]\d*$/.test(location))
      throw new UserError("Odoo numeric product/location IDs required");
    const rows = await this.stock([
      ["product_id", "=", Number(productKey)],
      ["location_id", "=", Number(location)],
    ]);
    if (
      rows.some((r) => r.productKey !== productKey || r.location !== location)
    )
      throw new UserError("Odoo returned a different mapped item");
    return rows[0];
  }
}
