# Shoptet — priority native connector

## Current scope

A native **read-only** Shoptet stock driver is implemented against the official [pinned OpenAPI contract](connector-contracts/shoptet/CONTRACT.json). It is tested with mocks and temporary stores, not a merchant shop. The user currently has **no API access**, so a live connection cannot be activated yet. Saving a preparation entry never claims successful authentication.

Implemented: exact expected e-shop identity check; all stock/warehouse discovery; paginated product supplies; stable count/page-size checks; exact variant-code/warehouse mapping; encrypted token storage; controlled API/authentication errors; Retry-After handling through the shared governor. Token values and upstream error bodies do not enter logs. Requests go only to the official fixed HTTPS API origin; credentials cannot be redirected to an arbitrary server.

Not implemented: inventory writes, two-way sync, webhooks, add-on installation/OAuth callback server, automatic add-on API-token renewal, or catalogue price/name/currency enrichment. Read permission is fixed. A Shoptet connection can be a master/source, never a write destination or two-way member. This does **not** yet satisfy POS-to-Shoptet stock delivery; that remains explicit follow-up work.

## Getting access

The official contract distinguishes two routes:

- **Private API (Premium):** merchant-created token in the shop administration's Access to API section, using `Shoptet-Private-API-Token`. The documented access route is Premium; confirm current eligibility/terms with Shoptet. Grant only required read endpoint groups for e-shop information and stocks/supplies.
- **Approved add-on:** approved developer/add-on access and merchant installation/authorization. A trusted add-on backend performs installation/OAuth and obtains a short-lived API token; the desktop sends that API token in `Shoptet-Access-Token`. Do not paste the permanent OAuth installation token, client secret or callback authorization code into this field. This app does not implement the add-on broker; expired API tokens produce a controlled authentication error and need secure replacement.

Do not share tokens in chat. A public API listing does not grant credentials, approval or licence entitlement. The app cannot enable Shoptet API access for a merchant.

## Desktop setup

Use POS Connections → Cloud API → Shoptet, or the advanced Shoptet form. Enter a name, API access type, **expected numeric e-shop ID**, and the corresponding API token. The e-shop ID must come from the merchant/admin; it is not guessed from a domain. The first request checks `data.contactInformation.eshopId` from `/api/eshop` before reading stock. Tokens for another shop are rejected.

The ID is immutable after creation. If you saved preparation without an ID, create a new bound connection when access is available. Token replacement for the same bound shop remains allowed and encrypted. Missing ID/token returns `setup_required`; the app does not make a speculative request.

After obtaining access, first use a non-production shop or permitted read-only staging setup. Test read, inspect SKUs and warehouse IDs, and review stock meaning/units before configuring a master group with explicit mappings. The source is not suitable for live deployment until staging checks pass.

CLI entries use `platform: "shoptet"`, `shoptetEshopId: 123`, `shoptetAccess: "private"` (or `"addon"`), `permission: "read"` and `credentialEnv: "YOUR_SHOPTET_API_TOKEN_VARIABLE"`. Only the environment-variable name goes into configuration, never its credential value. The desktop uses the encrypted OS vault.

## Inventory boundaries

- Variant `code` is the SKU/product mapping key, including leading zeroes and variant suffixes. Numeric stock `id` is the warehouse mapping key. Shelf `location` is not used as a warehouse identity.
- The API's `amount` is copied as reported on-hand stock. `available` remains unknown; no reservation arithmetic or sales-derived stock is invented. `observedAt` is the actual API observation time, not a manufactured stock-change timestamp.
- **Initial restriction: whole nonnegative amounts with zero claims only.** Nonzero `claim`, null/fractional/negative quantities, missing identities, repeated rows, empty total stock or inconsistent/moving pagination fail closed. This conservative boundary must be revisited with authoritative reservation semantics and staging fixtures before supporting reserved stock.
- Pagination starts at one. Count/page size must remain stable; at most 1,000 pages per warehouse, 1,000 warehouses and 100,000 total observations are accepted. Reads are sequential under the shared request governor. They are not a transactional snapshot and same-size concurrent catalogue edits may require another complete read.
- API `errors` are checked even after HTTP 200. Partial-error payloads are refused. 401/403/429/5xx are controlled failures; automatic authentication or inventory success is never inferred.
- No catalogue prices/names/currencies are invented. Default local export fails validation and preserves any previous valid stock.csv/manifest; independently valid group destinations retain their existing failure isolation.

## Protocol and licence evidence

Inspected official repository: `shoptet/developers`, commit `d874246dcd779a365d6890c833e76b7deba166ed`, `openapi/openapi.yaml`. This was available on the vendor's GitHub repository despite the environment denying the separate developers.shoptet.com host. The contract record contains the inspected SHA-256 and source URL.

No root LICENSE file was found in that upstream snapshot. No upstream schema, examples, SDK or implementation is copied or bundled. The driver and protocol summary are independently authored. Merchant/API/add-on terms remain separate, and the application's own licence is still undeclared. No new dependency was added.

Next acceptance work: obtain merchant API eligibility; validate shop binding, permissions, multi-warehouse variant stock, claims and units on a staging shop; determine safe master-destination write behavior and partial/uncertain-write recovery against the official movement API before enabling writes. Do not enable two-way sync without verified atomic revision checks.
