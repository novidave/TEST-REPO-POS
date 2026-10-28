import type { InventoryAdapter, Stock, StockWrite } from "../types";
export class ShopifyAdapter implements InventoryAdapter {
  readonly platform = "shopify" as const;
  readonly capabilities = {
    read: true,
    write: true,
    locations: true,
    webhooks: false,
    compareAndSwap: true,
  };
  constructor(
    readonly id: string,
    private readonly shopDomain: string,
    private readonly accessToken: string,
    private readonly apiVersion = "2026-07",
    private readonly http: typeof fetch = fetch,
  ) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain))
      throw new Error("Expected myshopify.com domain");
  }
  private async gql(query: string, variables: Record<string, unknown> = {}) {
    const r = await this.http(
      "https://" +
        this.shopDomain +
        "/admin/api/" +
        this.apiVersion +
        "/graphql.json",
      {
        method: "POST",
        signal: AbortSignal.timeout(30000),
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "X-Shopify-Access-Token": this.accessToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
    if (!r.ok) throw new Error("Shopify HTTP " + r.status);
    const data = (await r.json()) as any;
    if (data.errors?.length) throw new Error("Shopify GraphQL error");
    return data.data;
  }
  async read(): Promise<Stock[]> {
    const rows: Stock[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    do {
      const data = await this.gql(
        `query($after:String){inventoryItems(first:100,after:$after){pageInfo{hasNextPage endCursor}edges{node{id sku}}}}`,
        { after: cursor },
      );
      const items = data.inventoryItems;
      for (const edge of items.edges) {
        const item = edge.node;
        let locationCursor: string | null = null;
        const locationCursors = new Set<string>();
        do {
          const detail = await this.gql(
            `query($id:ID!,$after:String){inventoryItem(id:$id){inventoryLevels(first:100,after:$after){pageInfo{hasNextPage endCursor}edges{node{location{id} quantities(names:["available"]){name quantity}}}}}}`,
            { id: item.id, after: locationCursor },
          );
          const levels = detail.inventoryItem.inventoryLevels;
          for (const level of levels.edges) {
            const n = level.node;
            const q = n.quantities.find(
              (v: { name: string; quantity: number }) => v.name === "available",
            )?.quantity;
            if (!Number.isSafeInteger(q) || q < 0)
              throw new Error("Incomplete Shopify inventory");
            rows.push({
              productKey: item.id,
              sku: item.sku || "",
              location: n.location.id,
              onHand: null,
              available: q,
              revision: String(q),
              observedAt: new Date().toISOString(),
            });
          }
          locationCursor = levels.pageInfo.hasNextPage
            ? levels.pageInfo.endCursor
            : null;
          if (
            levels.pageInfo.hasNextPage &&
            (!locationCursor || locationCursors.has(locationCursor))
          )
            throw new Error("Incomplete location pagination");
          if (locationCursor) locationCursors.add(locationCursor);
        } while (locationCursor);
      }
      cursor = items.pageInfo.hasNextPage ? items.pageInfo.endCursor : null;
      if (items.pageInfo.hasNextPage && (!cursor || cursors.has(cursor)))
        throw new Error("Incomplete inventory pagination");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return rows;
  }
  async write(updates: StockWrite[]): Promise<void> {
    // Shopify set quantities requires compareQuantity or ignoreCompareQuantity; fail closed without an observed revision.
    for (const u of updates) {
      if (!Number.isSafeInteger(u.quantity) || u.quantity < 0)
        throw new Error("Invalid quantity");
      if (!u.expectedRevision)
        throw new Error("Shopify write requires compare quantity revision");
      const compare = Number(u.expectedRevision);
      if (!Number.isSafeInteger(compare))
        throw new Error("Invalid compare quantity");
      const data = await this.gql(
        `mutation($input:InventorySetQuantitiesInput!){inventorySetQuantities(input:$input){userErrors{field message}}}`,
        {
          input: {
            name: "available",
            reason: "correction",
            referenceDocumentUri: "test-repo-pos://sync/" + u.operationId,
            quantities: [
              {
                inventoryItemId: u.productKey,
                locationId: u.location,
                quantity: u.quantity,
                compareQuantity: compare,
              },
            ],
          },
        },
      );
      if (data.inventorySetQuantities.userErrors.length)
        throw new Error("Shopify rejected stock update");
    }
  }
}
