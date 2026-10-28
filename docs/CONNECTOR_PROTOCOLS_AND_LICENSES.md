# Connector protocols, access and licensing

Implemented means a driver exists and automated mock tests pass. It does not mean vendor certification, a purchased API entitlement, or a successful live merchant test. All new stock reads require an authorized test installation before production use. Credentials stay in the OS-encrypted vault; server error bodies never enter logs. No SDK, vendor implementation or vendor schema was copied into the drivers.

| Connector | Protocol / implemented boundary | Access and licence boundary | Evidence |
|---|---|---|---|
| ERPNext / Frappe v15 | HTTPS REST `/api/resource/Bin`, GET only, ordered 100-record pages; item code and warehouse identities | Merchant API key/secret, complete Bin read rights. Remote ERPNext GPL-3.0 and Frappe MIT; notices retained with contract | [Pinned source contract](connector-contracts/erpnext/CONTRACT.json); mock tests; live staging pending |
| Odoo 18 | HTTPS legacy `/jsonrpc`; only `authenticate` and `search_read`; internal-location quants and product SKU; read only | Database, username, API key, complete product/stock read rights and hosting-plan API entitlement. Community server LGPL-3.0; Enterprise/hosted terms separate | [Pinned source contract](connector-contracts/odoo/CONTRACT.json); mock tests; other versions and live staging unverified |
| WooCommerce | HTTPS REST `wc/v3`; stock-managed products/variants, absolute writes | Merchant REST credentials/scopes and terms. No SDK bundled. No atomic compare-and-swap; master only | Existing adapter tests; no live merchant validation |
| Shopify | HTTPS Admin GraphQL 2026-07; inventory reads and compareQuantity writes | Authorized app token and inventory/location scopes; Shopify API/app terms apply. No SDK bundled | Existing mocked pagination/CAS tests; no live merchant validation |
| CSV / XML / JSON | Local standard handover or explicit CSV import profiles; read only | Merchant must have export/data access rights. Naming a vendor does not parse its native format; exact CSV field/format mapping and complete stock required | Real temporary-file/parser/export tests |
| CACADUU Cloud (optional) | Pinned Phase A pairing, heartbeat, status, rotation; B/C flagged and HTTP 501 handled | Authorized pairing; pinned contract does not imply a third-party SDK licence | Unmodified `docs/cloud-api/`; mocked API tests |
| Shoptet | Native read-only stock API; expected shop binding, warehouses and supplies | Private API (Premium) or approved add-on API token/read rights required; no SDK/schema copied | [Pinned contract](connector-contracts/shoptet/CONTRACT.json), mocked tests; zero-claim whole stock only, no writes or live staging |
| 14 SK/CZ/PL POS profiles | Preparation records or explicitly normalized file exports; no native driver | See [regional matrix](REGIONAL_CONNECTORS.md). Sfera/SDK/API rights must be established separately for each edition | UI/state tests only; official Dotypos/Stormware documentation blocked by running network policy |

## Setup for the new read-only sources

Use **POS Connections → Advanced connection form** (Odoo) or the cloud setup wizard (ERPNext). Choose the exact platform, HTTPS server base URL without credentials/query, then ERPNext API key/secret or Odoo database/username/API key. Permission is fixed to read only. Test read, inspect IDs, then configure a master-source group with explicit product and warehouse/location maps to a supported writable destination. Saved server URLs and Odoo database cannot be edited; create a new connection for a different server/database.

ERPNext `actual_qty` maps to on-hand; available remains unknown. Odoo uses the returned `quantity` and `available_quantity`, aggregating lots/owners at the same internal location; numeric product and location IDs are the mapping keys, `default_code` is required as SKU. Source and destination units must be verified equivalent explicitly. Fractional, negative, empty, duplicate or incomplete stock is refused. Server-side permissions/record rules must cover the complete selected stock; the client cannot discover rows hidden by the server. Pagination is ordered and bounded but is not a transactional server snapshot.

Neither driver fabricates product names, prices or currencies. Therefore an attempted default local CSV export from these sources is held until verified catalogue metadata is available; the previous valid export stays intact. Other configured destinations continue independently. Neither driver can be a write destination or participate in two-way sync. Odoo legacy JSON-RPC support is scoped to 18 and must be reassessed before upgrading the server.

CLI configuration uses `platform: "erpnext"` or `"odoo"`, `baseUrl`, `permission: "read"`, `credentialEnv` and `secretEnv`. For ERPNext the env variables contain API key and secret; for Odoo username and API key, plus public `database` configuration. Never put credential values in the JSON configuration or source control.

## Distribution and dependency notices

The application currently has **no declared project licence** (`private: true`). This change does not choose a licence for the owner's code or grant redistribution rights. Resolve that before publishing a distributable. Remote server licences and merchant API agreements do not license this application or grant API access.

Run `npm run licenses:report` after changing the lockfile. [DEPENDENCY_LICENSES.json](DEPENDENCY_LICENSES.json) lists every locked package, version, declared licence and runtime/build scope. It is metadata inventory, not legal clearance. Review the exact installed `LICENSE`/`NOTICE` files and the licence obligations of the final artifact before distribution. Node modules retain their upstream notices; the Electron packager retains Electron/Chromium distribution licence files. Electron's bundled Chromium/Node components are not fully described by npm lockfile metadata alone.

Keep the complete packaged folder together, including its licence files and runtime module notices. `THIRD_PARTY_NOTICES.md` accompanies the app. No proprietary vendor SDKs, Sfera binaries, vendor keys or paid licences are bundled. Names identify compatibility targets, not endorsement. Do not remove upstream notices or infer that using a remote API waives its terms.

CSV import profile v1 is an independently authored local format contract, described in [CSV_IMPORT_PROFILES.md](CSV_IMPORT_PROFILES.md). It adds no vendor SDK, upstream schema or dependency. Its configuration supports only explicit column names and known parser options, not executable transforms or invented constants. Existing csv-parse and Electron/runtime notices remain unchanged.
