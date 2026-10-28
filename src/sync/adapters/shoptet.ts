import type { InventoryAdapter, Stock, StockWrite } from "../types";
/** Authorization and inventory endpoints depend on the merchant's Shoptet API/add-on access. */
export class ShoptetAdapter implements InventoryAdapter {
  readonly platform = "shoptet" as const;
  readonly capabilities = {
    read: false,
    write: false,
    locations: false,
    webhooks: false,
    compareAndSwap: false,
  };
  constructor(readonly id: string) {}
  async read(): Promise<Stock[]> {
    throw new Error(
      "Shoptet API authorization and inventory endpoints not configured; no speculative API calls",
    );
  }
  async write(_updates: StockWrite[]): Promise<void> {
    throw new Error("Shoptet write access unavailable");
  }
}
