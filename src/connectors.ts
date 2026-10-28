/** Capabilities describe real drivers, independently of how many connections are configured. */
export const connectorCapabilities = [
  {
    platform: "odoo",
    name: "Odoo 18 JSON-RPC",
    state: "implemented",
    read: true,
    write: false,
    twoWay: false,
    detail:
      "Read-only internal-location quants; database/API key and stock permissions required; live staging pending",
  },
  {
    platform: "erpnext",
    name: "ERPNext / Frappe v15",
    state: "implemented",
    read: true,
    write: false,
    twoWay: false,
    detail:
      "Read-only Bin actual stock; API token and Bin permissions required; whole units only; mocked contract tests, live staging pending",
  },
  {
    platform: "woocommerce",
    name: "WooCommerce",
    state: "implemented",
    read: true,
    write: true,
    twoWay: false,
    detail: "Master only; no atomic compare-and-swap",
  },
  {
    platform: "shopify",
    name: "Shopify",
    state: "implemented",
    read: true,
    write: true,
    twoWay: true,
    detail: "Atomic compareQuantity; sandbox validation required",
  },
  {
    platform: "file",
    name: "CSV / XML / JSON",
    state: "implemented",
    read: true,
    write: false,
    twoWay: false,
    detail: "Verified schema; local stock.csv + manifest export",
  },
  {
    platform: "shoptet",
    name: "Shoptet",
    state: "setup_required",
    read: false,
    write: false,
    twoWay: false,
    detail: "Merchant authorization and verified driver required",
  },
  {
    platform: "pos",
    name: "Other POS / local API / CLI / hardware",
    state: "setup_required",
    read: false,
    write: false,
    twoWay: false,
    detail:
      "Vendor-specific driver required; compatible file exports can use the file connector",
  },
  {
    platform: "cacaduu",
    name: "CACADUU Cloud",
    state: "phase_a",
    read: false,
    write: false,
    twoWay: false,
    detail:
      "Optional pairing, heartbeat, status and rotation; no active inventory destination",
  },
] as const;
