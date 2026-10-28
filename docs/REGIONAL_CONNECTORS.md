# Regional POS connector priorities — SK / CZ / PL

These priorities come from the user's requested market list. They are not independently verified market-share claims. The 120-connection capacity work is separate from native vendor coverage. Regional profiles in POS Connections are **setup-required preparation records**, not working API/SDK drivers.

## First wave

1. **Dotykačka / Dotypos (SK, CZ, PL):** verify the official stock API and authorization contract, then implement a read-only source first. Confirm product identifiers/SKUs, warehouse quantities, pagination, deleted records, units and permissions. Do not infer stock from sales. Two-way eligibility requires proof that the actual inventory-write endpoint supports an atomic revision check; general ETag documentation is insufficient.
2. **POHODA / Stormware (SK, CZ):** pin the official mServer and XML stock schemas, then implement the supported read request for the configured company and stock rights. A working port or generic HTTP 200 response is not a stock/authentication test. Native mServer calls are not implemented yet. A POHODA XML export is not automatically compatible with the generic `<inventory><product>…` handover format.

## Remaining requested systems

| Product profile | Requested markets | Planned route / prerequisite | Inventory boundary |
|---|---|---|---|
| Portos | SK | Confirm edition and complete export or vendor integration contract | eKasa sales records are not full stock |
| KROS OMEGA | SK | Exact edition, stock module and documented export | Accounting totals do not supply quantities/currency |
| KROS ALFA | SK | Exact ALFA edition, stock module and export rights | Separate schema from OMEGA |
| Money S3 | SK, CZ | Verified exchange/export module and official stock schema | Explicit conversion; no guessed XML fields |
| Money S4 | CZ | Product-specific integration access/schema | Do not reuse the S3 contract blindly |
| Storyous | SK, CZ | Partner/API agreement and stock permissions | Menus/sales/recipes are not complete ingredient inventory |
| InsERT Subiekt GT | PL | Licensed Windows Sfera bridge; SDK, architecture and rights verified | No speculative direct database writes |
| InsERT Subiekt nexo | PL | nexo Sfera license/SDK and Windows bridge | Separate GT/nexo contracts and units |
| PC-Market / Insoft | PL | Supported API/SDK or documented stock exchange/export | Normalize a complete stock export explicitly |
| Comarch ERP Optima | PL | Optima-specific API/SDK, edition, deployment and rights | Verify the authoritative ERP stock source |
| Comarch POS | PL | POS-specific integration contract and rights | Not interchangeable with Optima |
| Profi Účtenka | CZ | Discovery only; establish whether complete stock exists | Do not manufacture inventory from receipts |

## Current behavior

- Country filtering and vendor-specific preparation are available in POS Connections.
- A regional profile can be saved as inert POS setup metadata. It cannot join a sync group as a readable/writable native connection.
- A user may explicitly choose a file source for a regional vendor. Only already-normalized, complete CSV/XML/JSON handover data is accepted; this uses the existing file driver, not a new vendor parser.
- Setup-required tests report required access/schema work. They do not issue vendor requests or claim a successful connection.
- Credentials entered for a prepared local API remain in encrypted OS storage; no token/password is stored in public metadata or logs. No Sfera license values or merchant credentials are requested in chat.
- Product/warehouse mapping templates remain explicit. No names, prices, currencies, quantities, units or missing stock are invented.

## Contract research and blocker (2026-10-28)

The running environment's enforced network policy denied access to the vendor documentation/schema sites. Its saved draft is unrestricted, but the running policy remains restricted; saving a draft does not apply it to the current machine. Required documentation access:

- <https://docs.api.dotypos.com/> — current documentation domain referenced by the secondary client below; request denied by this environment.
- <https://docs.api.dotykacka.cz/> — earlier documentation hostname checked; request denied by this environment.
- <https://www.stormware.cz/schema/version_2/stock.xsd> — requested stock schema URL; not retrieved or verified because the environment denied the host.

Public GitHub material remained readable. The vendor organization's visible repositories did not provide a verified cloud-stock contract. The community [Dotykačka Java API v2 client](https://github.com/grizzlysoftware/dotykacka-java-api-v2-client) README references the API v2 base, refresh-token authorization, product/warehouse services and general ETag documentation at `docs.api.dotypos.com`. This is secondary evidence, not a pinned/verified official inventory contract, and no driver is claimed from it.

To continue native implementation, apply the unrestricted network setting already in the environment draft, or permit the specific official documentation domains. Then pin retrieved contracts and add read-only driver/mapping tests before any staging connection test. Merchant-specific permissions, licensed SDKs and a non-production test installation will be separate requirements when the relevant driver is ready. No live merchant inventory has been modified.
