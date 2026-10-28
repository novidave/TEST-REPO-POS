# CACADUU Inventory Sync

Standalone Electron + TypeScript inventory workspace. Reuses the desktop, export, cloud client and synchronization scaffold from `feature/universal-inventory-sync` (PR #2). CACADUU Cloud is optional; no website or server is required for local workflows.

## Windows quick start

Use Windows 10/11 x64 and Node.js **22.15+ (22 LTS)** or Node 24. In PowerShell:

```powershell
git clone --branch feature/universal-inventory-sync https://github.com/novidave/TEST-REPO-POS.git
cd TEST-REPO-POS
npm ci
npm run build
npm test
npm run native:electron
npm start
```

From an existing checkout, use the existing branch; do not recreate the repository. `npm ci` uses the committed lockfile. Dependencies include Electron 45 and better-sqlite3 13. The latter ships Node-API prebuilds, including Windows x64/arm64, shared by Node and Electron. `native:node` and `native:electron` open SQLite and test a transaction in the **actual target runtime**. They do not blindly rebuild an ABI-stable addon. The explicit diagnostic fallback `npm run native:rebuild:electron` needs Python, Visual Studio C++ build tools and access to official Electron headers; it is not needed for supported prebuilds.

Build a portable Windows x64 app:

```powershell
npm run package:win
.\release\CACADUU-Inventory-win32-x64\CACADUU-Inventory.exe
```

Keep the entire output folder together. Native `.node` files are unpacked from ASAR. This produces an unsigned portable application, not an installer; code signing and distribution are separate release work. Windows CI is included but must pass before Windows startup can be claimed verified. Linux validation does not establish Windows execution.

## Use the dashboard

- **Overview:** connection/group counts and recent activity.
- **POS Connections:** six integration-method cards (Cloud API, Local API/XML, File/Folder, Command-line, GUI Automation, Hardware/Database), searchable/filterable connection rows, and a four-step setup drawer: select type, configure, map products, test/save. CSV/XML/JSON, ERPNext, WooCommerce and Shopify adapters use real read tests; other vendor methods show setup-required status. Product and warehouse mapping templates are carried into the group editor. An unsaved file can be previewed without creating a connection. Username/password fields use encrypted credential storage and clear on save/cancel. The advanced connection form also supports read-only Odoo 18 setup. Tests never write inventory.
- **Connection Groups:** master source or guarded two-way, explicit product and warehouse maps, per-member roles, intervals, enable/pause and manual Sync Now. The master must have source role. Map every observed item/warehouse: `local ID = shared ID` per line.
- **Inventory Sync:** per-group Sync Now and persistent queue. Sync Now asks for confirmation because configured destinations may change. Schedules spread startup across the polling interval, wait for completion before scheduling another run, and resume after restart; there is no background Windows service. Pause/Resume works without editing the group, including when retry jobs are outstanding. Pausing retains jobs and prevents subsequent writes; a request already sent may finish.
- **Products & Mapping:** inspect exact product/SKU/warehouse IDs (first 1,000 observations displayed), then edit group mappings.
- **Sync History & Logs:** bounded recent views of durable logs, conflicts and jobs. Dismiss a held job only after reviewing actual quantities; dismissal does not write remote stock and resets the group baseline. The next two-way poll must establish agreement again.
- **Settings:** local export directory and optional Phase A cloud pairing, automatic heartbeat, status, rotation and local forget.

Credentials are encrypted by Electron safeStorage (DPAPI under the Windows account), separate from public SQLite configuration. The app refuses credentials when OS encryption is unavailable or Linux selects `basic_text`. Secrets are not returned over IPC or included in logs. A saved commerce endpoint cannot be changed: create a new connection for another store so existing credentials and retry jobs stay bound to their original store. Pause affected groups before changing connection permissions. `contextIsolation`, renderer sandbox, disabled Node integration, CSP, a fixed IPC bridge, sender/frame checks, blocked navigation/new windows and denied permission requests protect the renderer. Do not copy the encrypted profile between Windows accounts and expect credentials to decrypt.

## Safe file workflow (no cloud needed)

Add a file connection, choose **Test read**, inspect products, then **Export locally**. Output is `<userData>/exports/<connection-id>/stock.csv` and `manifest.json`. Master groups also attempt local export under `<group-id>`, independently of remote writes. Required CSV columns:

```csv
source_code,name,price,currency,quantity,warehouse,observed_at
```

Supply real values from the source system; no default name, price, currency, quantity or warehouse is inferred. Optional `ean` is preserved. Quantities must be nonnegative safe integers, prices finite and nonnegative, currency a three-letter uppercase code, and `observed_at` a parseable timestamp. CSV quoting/BOM and XML escaping are supported.

XML uses `<inventory><product><source_code>…</source_code><name>…</name><price>…</price><currency>…</currency><quantity>…</quantity><warehouse>…</warehouse><observed_at>…</observed_at></product></inventory>`. DTDs/entities are refused. JSON accepts an array of the same fields, or the existing `Stock` observations schema for quantity synchronization; observations without verified catalogue metadata cannot be exported. Duplicate product codes across warehouses require an explicit aggregation policy and are refused for export.

Empty/incomplete/invalid input is validated **before replacing either existing export**. `manifest.json` includes the exact CSV SHA-256. Readers must verify it: replacing two filesystem paths is not a cross-file atomic transaction; a power loss between renames can cause a detectable checksum mismatch. Do not consume a mismatched pair.

## 100+ configured connections

The runtime is load-tested with **120 configured test connections**, 60 groups and 1,500 writes, including restart/failure recovery and 60 verified local exports. It bounds group concurrency, serializes shared connections, staggers polling and rate-limits provider requests. Settings lists actual driver capabilities and live capacity; the POS list can search/filter 120 entries. This does not add 120 native vendor integrations or certify 120 live merchant accounts. See [capacity limits and test scope](docs/SCALABILITY.md). Reproduce the service load checks with `npm run test:scale`, and the real desktop 120-connection IPC/list/restart check with `npm run test:electron:scale`.

## Synchronization safety and limits

Master mode uses only the designated authority and respects explicit destination permissions. Destinations fail independently. Source-read/validation failures stop planning; failed destination reads do not stop other destinations. Conflicts do not advance comparison baselines. Configuration changes are serialized with sync startup, source/mapping identity changes invalidate old baselines, and shutdown waits for active reads/exports/settings writes. SQLite observations and new outbox jobs commit together, and a single-instance lock plus per-group guards prevent overlapping runs.

Two-way requires **atomic compare-and-swap on every member**, complete mappings, observed revisions and an agreed initial baseline. Initial disagreement, missing products or simultaneous divergent changes are held; no last-writer-wins rule is used. Polling cannot reconstruct every intervening sale: test with development stores and do not treat this as a transactional sales ledger.

Jobs retain stable operation IDs. Before writes/retries, the app re-reads stock, validates the planned authority/peer state and compares the destination revision. Already-applied values reconcile without a duplicate write after a crash. Changed stock is held. Failed requests retry with persisted provider Retry-After deadlines and exponential delay (2–300 seconds, examined on the next manual/scheduled run), up to five attempts. Uncertain non-atomic writes are held for review. Master-mode WooCommerce writes still have a read/write race because its API lacks atomic CAS; do not use them for concurrent live sales without a vendor-side coordination mechanism.

| Integration | Implemented | Remaining limits |
|---|---|---|
| CSV/XML/JSON | Strict reads, inspection, validated local export | Standard handover or explicit mapped CSV profiles; no file watching, XLSX/DBF or vendor schema guessing |
| ERPNext / Frappe v15 | Read-only paginated Bin stock with item/warehouse mapping | API key/secret and complete Bin read rights; whole units only; available unknown; no catalogue metadata for export; live staging pending |
| Odoo 18 | Read-only internal-location quant aggregation and product SKU lookup | Legacy JSON-RPC, database/API entitlement/read rights required; whole units only; no catalogue metadata for export; live staging pending |
| WooCommerce | Stock-managed product/variant reads, pagination, absolute quantity writes | Master only; no atomic revision check; no verified catalogue currency for export; sandbox/live validation remains |
| Shopify | Paginated items and warehouses, `available` quantities, atomic `compareQuantity` writes | Admin API scopes required; API version 2026-07; sandbox/live validation remains; catalogue export metadata unavailable |
| Shoptet | Native read-only API, bound e-shop ID, private/add-on token modes, warehouses and paginated supplies | Merchant API access required; whole zero-claim stock only; no writes/two-way/OAuth broker; live staging pending |
| Local POS | Categorized setup wizard, encrypted setup credentials, explicit mapping templates; existing injectable driver interface retained | No POHODA/MRP/Elcom/Square/Lightspeed vendor drivers bundled; local API, CLI, GUI automation and hardware/database references are inert setup metadata. XLSX/DBF parsing and folder watching are not implemented; use verified CSV/XML/JSON files |
| CACADUU | Phase A client + desktop controls, timed heartbeat | Optional; B/C contract wrappers feature-gated, no inventory upload/command execution workflow |

## Shoptet priority

The native Shoptet stock source is implemented and mock-tested, but live activation requires private API access (documented for Premium) or an approved add-on API token. It is currently **read-only**, accepts whole zero-claim stock and verifies the expected e-shop ID before stock reads. Missing access stays setup-required. POS-to-Shoptet writes, reservation reconciliation and live validation remain incomplete. See [setup, access requirements and limitations](docs/SHOPTET.md). The [public-apis catalog review](docs/API_CATALOG_RESEARCH.md) supplies future leads, not additional implemented connectors.

## Slovakia, Czech Republic and Poland

POS Connections includes 14 requested regional preparation profiles with country filtering. **Dotykačka and POHODA are prioritized first.** Portos, KROS OMEGA/ALFA, Money S3/S4, Storyous, Subiekt GT/nexo, PC-Market, Comarch Optima/POS and Profi Účtenka retain explicit access/schema requirements. These are not implemented native drivers. A normalized file can use the existing file driver after explicit conversion; vendor XML/DBF/XLSX is not assumed compatible. See [regional implementation priorities and documentation-access blocker](docs/REGIONAL_CONNECTORS.md).

## Regional CSV exports

The file connector now supports saved explicit CSV profiles: exact column mapping, comma/semicolon/tab/pipe separators, UTF-8 or Windows-1250/1252, decimal point/comma, and declared on-hand versus available stock. Configure this in the POS wizard or advanced form. Read the actual CSV headers, select columns from dropdowns, then preview stock before saving. Header inspection is read-only format discovery and does not imply valid inventory. Stock-only imports can synchronize but preserve the previous local export until verified catalogue metadata is supplied. See [setup, CLI example and validation limits](docs/CSV_IMPORT_PROFILES.md). This does not add native vendor API drivers or assume arbitrary vendor exports are compatible.

## Protocol and licence records

See the [connector protocol and licence ledger](docs/CONNECTOR_PROTOCOLS_AND_LICENSES.md) for pinned ERPNext/Odoo source contracts, version boundaries, setup instructions and access requirements. `npm run licenses:report` regenerates the inventory of 91 locked dependency licence declarations. The application itself has no declared project licence; choose one before publishing a distributable. No proprietary vendor SDK is bundled or licence entitlement implied. Preserve packaged Electron/Chromium and module notices.

## Cloud compatibility

The contract under [docs/cloud-api](docs/cloud-api/) remains pinned and unchanged; CACADOO-PPI is not modified. Set an HTTPS pairing URL in Settings (or `CACADUU_PAIRING_URL`), then enter the pairing code. Tokens are encrypted before use. Heartbeats obey server polling intervals and retry-after guidance. Local forget does not remotely revoke the device.

`CACADUU_ENABLE_SNAPSHOTS=true` and `CACADUU_ENABLE_COMMANDS=true` enable contract wrappers only; defaults are off. HTTP 501 `not_available` returns an unavailable state without breaking pairing, status or other destinations. No Supabase service-role key is needed.

## Validation and development

```sh
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:ui
npm run test:electron
```

`npm test` builds and exercises mocked commerce/cloud APIs, real temporary SQLite stores, conflict/loop detection, permissions, mappings, retries, crash recovery, token handling, file preservation and CLI behavior. Browser tests use a **mock bridge**. `test:electron` uses the real main process, preload and sandboxed renderer with an isolated temporary profile, imports a synthetic CSV and checks read-test, export and invalid-input preservation. On Windows, run `npm run package:win` then `npm run test:packaged`. The same end-to-end test runs against the packaged executable, including ASAR/native-module resolution and profile reopening. Windows tests require a real DPAPI encrypt/decrypt round trip; Linux explicitly reports when no secure keyring is available. No test modifies real merchant inventory. On headless Linux use `ELECTRON_TEST_HEADLESS=1 npm run test:electron`, or `xvfb-run -a npm run test:electron`; Windows needs neither. For packaged tests on headless Linux, build with `npm run package:linux` and run `ELECTRON_TEST_HEADLESS=1 npm run test:packaged`. The Linux browser test can use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`.

[Desktop CI](.github/workflows/desktop.yml) runs Node tests and real Electron checks on Windows/Linux, Windows/Linux packaging, source and packaged-app startup/profile checks, Windows DPAPI checks, and browser dashboard checks. Successful Windows CI retains the portable app as the `CACADUU-Inventory-win32-x64` workflow artifact for seven days. See [architecture and release limitations](docs/UNIVERSAL_SYNC_ARCHITECTURE.md) and [validation evidence](docs/VALIDATION.md).

The repaired CLI is a single-run alternative: `npm run sync:once -- ./config.json`. It uses `AgentConfig` in `src/sync/config.ts`, explicit credential **environment variable names**, and `permission: "read_write"` to authorize writes (default is read-only). File connections export locally even without any groups. Desktop profiles use encrypted storage instead of environment credentials. Never put tokens in config files. CLI schedules were removed; use the desktop scheduler.
