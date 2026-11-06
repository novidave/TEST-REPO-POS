/** User-requested regional priorities. A listing is not a verified native integration. */
export interface RegionalConnector {
  id: string;
  name: string;
  countries: ("SK" | "CZ" | "PL")[];
  priority: 1 | 2 | 3;
  method: "cloud_api" | "local_api" | "file" | "hardware_database";
  nativeState: "setup_required";
  access: string;
  stockCaveat: string;
}
export const regionalConnectors: readonly RegionalConnector[] = [
  {
    id: "dotykacka",
    name: "Dotykačka",
    countries: ["SK", "CZ", "PL"],
    priority: 1,
    method: "cloud_api",
    nativeState: "setup_required",
    access:
      "Verify the official cloud API, merchant authorization, stock endpoints and pagination before implementing the read-only driver.",
    stockCaveat:
      "A public API does not by itself establish access to complete warehouse inventory.",
  },
  {
    id: "pohoda",
    name: "POHODA (mServer)",
    countries: ["SK", "CZ"],
    priority: 1,
    method: "local_api",
    nativeState: "setup_required",
    access:
      "Requires a configured mServer, correct company/permissions, and a pinned official XML stock contract. Native requests are not implemented.",
    stockCaveat:
      "POHODA XML is not the generic XML handover schema; an explicit converter or verified native driver is required.",
  },
  {
    id: "portos",
    name: "Portos",
    countries: ["SK"],
    priority: 2,
    method: "file",
    nativeState: "setup_required",
    access:
      "Confirm the product edition and a complete stock export or vendor-supported integration contract.",
    stockCaveat: "eKasa sales records alone are not complete inventory.",
  },
  {
    id: "kros_omega",
    name: "KROS OMEGA",
    countries: ["SK"],
    priority: 2,
    method: "file",
    nativeState: "setup_required",
    access:
      "Confirm the installed edition, inventory module and documented export schema.",
    stockCaveat:
      "Use actual stock records; do not derive quantities or currency from accounting totals.",
  },
  {
    id: "kros_alfa",
    name: "KROS ALFA",
    countries: ["SK"],
    priority: 2,
    method: "file",
    nativeState: "setup_required",
    access:
      "Confirm the exact ALFA edition, inventory module and export rights.",
    stockCaveat: "ALFA and OMEGA need separate schema verification.",
  },
  {
    id: "money_s3",
    name: "Money S3",
    countries: ["SK", "CZ"],
    priority: 2,
    method: "file",
    nativeState: "setup_required",
    access:
      "Confirm the installed version, exchange/export modules and the official stock schema.",
    stockCaveat:
      "Convert vendor exports explicitly into the supported handover schema; do not assume XML compatibility.",
  },
  {
    id: "money_s4",
    name: "Money S4",
    countries: ["CZ"],
    priority: 2,
    method: "file",
    nativeState: "setup_required",
    access: "Verify Money S4 integration access and schema separately from S3.",
    stockCaveat:
      "A shared vendor name does not make S3 and S4 contracts interchangeable.",
  },
  {
    id: "storyous",
    name: "Storyous",
    countries: ["SK", "CZ"],
    priority: 2,
    method: "cloud_api",
    nativeState: "setup_required",
    access:
      "Obtain the supported partner/API contract and merchant permissions for stock access.",
    stockCaveat:
      "Sales, menus and recipes must not be presented as complete ingredient or product stock.",
  },
  {
    id: "subiekt_gt",
    name: "InsERT Subiekt GT",
    countries: ["PL"],
    priority: 2,
    method: "hardware_database",
    nativeState: "setup_required",
    access:
      "Plan a verified Windows Sfera bridge. Exact product, paid license, SDK, process architecture and permissions must be checked.",
    stockCaveat:
      "Do not implement speculative direct database writes or assume nexo uses the GT contract.",
  },
  {
    id: "subiekt_nexo",
    name: "InsERT Subiekt nexo",
    countries: ["PL"],
    priority: 2,
    method: "hardware_database",
    nativeState: "setup_required",
    access:
      "Verify the nexo Sfera SDK/license and Windows bridge independently of GT.",
    stockCaveat:
      "Stock, warehouse IDs and units must come from the verified SDK model.",
  },
  {
    id: "pc_market",
    name: "PC-Market (Insoft)",
    countries: ["PL"],
    priority: 2,
    method: "file",
    nativeState: "setup_required",
    access:
      "Request the vendor-supported stock exchange format or API/SDK for the installed edition.",
    stockCaveat:
      "A normalized stock export can use the file connector after explicit schema conversion.",
  },
  {
    id: "comarch_optima",
    name: "Comarch ERP Optima",
    countries: ["PL"],
    priority: 2,
    method: "cloud_api",
    nativeState: "setup_required",
    access:
      "Verify the Optima-specific API/SDK, deployment, licensing and authorization contract.",
    stockCaveat:
      "Do not reuse a Comarch POS API contract without verification.",
  },
  {
    id: "comarch_pos",
    name: "Comarch POS",
    countries: ["PL"],
    priority: 2,
    method: "cloud_api",
    nativeState: "setup_required",
    access:
      "Verify the POS-specific integration contract and permissions for the merchant installation.",
    stockCaveat:
      "Confirm where authoritative inventory is held, including the connected ERP.",
  },
  {
    id: "profi_uctenka",
    name: "Profi Účtenka",
    countries: ["CZ"],
    priority: 3,
    method: "file",
    nativeState: "setup_required",
    access:
      "Discovery only: establish whether complete stock can be exported before planning a driver.",
    stockCaveat:
      "Do not create stock quantities from receipts or sales-only records.",
  },
  // Added for the SK/CZ priority list. No vendor API, schema or COM interface is assumed for any of them.
  {
    id: "oberon",
    name: "OBERON",
    countries: ["SK"],
    priority: 1,
    method: "file",
    nativeState: "setup_required",
    access:
      "Use OBERON's own scheduled stock export to a CSV file, then map its exact columns with an explicit CSV import profile. Direct database access is not used.",
    stockCaveat:
      "Verify that the export contains the complete stock of the selected warehouse, selling prices with currency, and a timestamp with timezone.",
  },
  {
    id: "mrp",
    name: "MRP",
    countries: ["SK", "CZ"],
    priority: 2,
    method: "file",
    nativeState: "setup_required",
    access:
      "DBF data files are not parsed. Export stock to CSV from MRP and map the columns explicitly.",
    stockCaveat: "Confirm the warehouse scope and that quantities are actual remaining stock.",
  },
  {
    id: "ikelp",
    name: "iKelp",
    countries: ["SK"],
    priority: 2,
    method: "file",
    nativeState: "setup_required",
    access:
      "No verified iKelp API contract is pinned. A complete stock export saved as CSV can be mapped explicitly; Excel files must be saved as CSV first.",
    stockCaveat: "Confirm the export lists every product of the warehouse, not only changed items.",
  },
  {
    id: "elcom",
    name: "ELCOM registers",
    countries: ["SK", "CZ"],
    priority: 3,
    method: "hardware_database",
    nativeState: "setup_required",
    access:
      "No device protocol is implemented. Use the inventory software connected to the register and its stock export instead of the register itself.",
    stockCaveat: "Cash registers usually hold sales data, not complete warehouse stock.",
  },
];
export function regionalConnector(id: string) {
  return regionalConnectors.find((profile) => profile.id === id);
}
