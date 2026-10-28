import type { InventoryAdapter, Stock, StockWrite } from "../types";
export interface PosDriver {
  readStock(): Promise<Stock[]>;
  writeStock?(updates: StockWrite[]): Promise<void>;
}
export class PosAdapter implements InventoryAdapter {
  readonly platform = "pos" as const;
  readonly capabilities;
  constructor(
    readonly id: string,
    private readonly driver: PosDriver,
  ) {
    this.capabilities = {
      read: true,
      write: Boolean(driver.writeStock),
      locations: true,
      webhooks: false,
      compareAndSwap: false,
    };
  }
  read() {
    return this.driver.readStock();
  }
  async write(updates: StockWrite[]) {
    if (!this.driver.writeStock) throw new Error("POS is read-only");
    await this.driver.writeStock(updates);
  }
}
