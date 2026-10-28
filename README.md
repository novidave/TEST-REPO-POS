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
- **Connections:** CSV/XML/JSON, WooCommerce, Shopify, Shoptet, Local POS, optional Cloud; add/edit forms, explicit read/read-write permission, read-only connection tests and authentication/error state. Tests never write inventory.
- **Connection Groups:** master source or guarded two-way, explicit product and warehouse maps, per-member roles, intervals, enable/pause and manual Sync Now. The master must have source role. Map every observed item/warehouse: `local ID = shared ID` per line.
- **Inventory Sync:** per-group Sync Now and persistent queue. Sync Now asks for confirmation because configured destinations may change. Schedules run while the app is open and resume after restart; there is no background Windows service.
- **Products & Mapping:** inspect exact product/SKU/warehouse IDs (first 1,000 observations displayed), then edit group mappings.
- **Sync History & Logs:** bounded recent views of durable logs, conflicts and jobs. Dismiss a held job only after reviewing actual quantities; dismissal does not write remote stock and resets the group baseline. The next two-way poll must establish agreement again.
- **Settings:** local export directory and optional Phase A cloud pairing, automatic heartbeat, status, rotation and local forget.

Credentials are encrypted by Electron safeStorage (DPAPI under the Windows account), separate from public SQLite configuration. The app refuses credentials when OS encryption is unavailable or Linux selects `basic_text`. Secrets are not returned over IPC or included in logs. `contextIsolation`, renderer sandbox, disabled Node integration, CSP, a fixed IPC bridge, sender/frame checks, blocked navigation/new windows and denied permission requests protect the renderer. Do not copy the encrypted profile between Windows accounts and expect credentials to decrypt.

## Safe file workflow (no cloud needed)

Add a file connection, choose **Test read**, inspect products, then **Export locally**. Output is `<userData>/exports/<connection-id>/stock.csv` and `manifest.json`. Master groups also attempt local export under `<group-id>`, independently of remote writes. Required CSV columns:

```csv
source_code,name,price,currency,quantity,warehouse,observed_at
```

Supply real values from the source system; no default name, price, currency, quantity or warehouse is inferred. Optional `ean` is preserved. Quantities must be nonnegative safe integers, prices finite and nonnegative, currency a three-letter uppercase code, and `observed_at` a parseable timestamp. CSV quoting/BOM and XML escaping are supported.

XML uses `<inventory><product><source_code>…</source_code><name>…</name><price>…</price><currency>…</currency><quantity>…</quantity><warehouse>…</warehouse><observed_at>…</observed_at></product></inventory>`. DTDs/entities are refused. JSON accepts an array of the same fields, or the existing `Stock` observations schema for quantity synchronization; observations without verified catalogue metadata cannot be exported. Duplicate product codes across warehouses require an explicit aggregation policy and are refused for export.

Empty/incomplete/invalid input is validated **before replacing either existing export**. `manifest.json` includes the exact CSV SHA-256. Readers must verify it: replacing two filesystem paths is not a cross-file atomic transaction; a power loss between renames can cause a detectable checksum mismatch. Do not consume a mismatched pair.

## Synchronization safety and limits

Master mode uses only the designated authority and respects explicit destination permissions. Destinations fail independently. Source-read/validation failures stop planning; failed destination reads do not stop other destinations. Conflicts do not advance comparison baselines. SQLite observations and new outbox jobs commit together, and a single-instance lock plus per-group guards prevent overlapping runs.

Two-way requires **atomic compare-and-swap on every member**, complete mappings, observed revisions and an agreed initial baseline. Initial disagreement, missing products or simultaneous divergent changes are held; no last-writer-wins rule is used. Polling cannot reconstruct every intervening sale: test with development stores and do not treat this as a transactional sales ledger.

Jobs retain stable operation IDs. Before writes/retries, the app re-reads stock, validates the planned authority/peer state and compares the destination revision. Already-applied values reconcile without a duplicate write after a crash. Changed stock is held. Failed requests retry with exponential delay (2–300 seconds, examined on the next manual/scheduled run), up to five attempts. Uncertain non-atomic writes are held for review. Master-mode WooCommerce writes still have a read/write race because its API lacks atomic CAS; do not use them for concurrent live sales without a vendor-side coordination mechanism.

| Integration | Implemented | Remaining limits |
|---|---|---|
| CSV/XML/JSON | Strict reads, inspection, validated local export | Known schema only; no file watching or arbitrary vendor schema guessing |
| WooCommerce | Stock-managed product/variant reads, pagination, absolute quantity writes | Master only; no atomic revision check; no verified catalogue currency for export; sandbox/live validation remains |
| Shopify | Paginated items and warehouses, `available` quantities, atomic `compareQuantity` writes | Admin API scopes required; API version 2026-07; sandbox/live validation remains; catalogue export metadata unavailable |
| Shoptet | Setup-required forms/status | Merchant API/add-on authorization and verified endpoints not implemented |
| Local POS | Setup-required form; existing injectable driver interface retained | No vendor drivers bundled; use a verified file export |
| CACADUU | Phase A client + desktop controls, timed heartbeat | Optional; B/C contract wrappers feature-gated, no inventory upload/command execution workflow |

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

`npm test` builds and exercises mocked commerce/cloud APIs, real temporary SQLite stores, conflict/loop detection, permissions, mappings, retries, crash recovery, token handling, file preservation and CLI behavior. Browser tests use a **mock bridge**. `test:electron` uses the real main process, preload and sandboxed renderer with an isolated temporary profile, imports a synthetic CSV and checks read-test, export and invalid-input preservation. No test modifies real merchant inventory. On headless Linux use `ELECTRON_TEST_HEADLESS=1 npm run test:electron`, or `xvfb-run -a npm run test:electron`; Windows needs neither. The Linux browser test can use `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`.

[Desktop CI](.github/workflows/desktop.yml) runs Node tests and real Electron checks on Windows/Linux, Windows packaging, and browser dashboard checks. See [architecture and release limitations](docs/UNIVERSAL_SYNC_ARCHITECTURE.md) and [validation evidence](docs/VALIDATION.md).

The repaired CLI is a single-run alternative: `npm run sync:once -- ./config.json`. It uses `AgentConfig` in `src/sync/config.ts`, explicit credential **environment variable names**, and `permission: "read_write"` to authorize writes (default is read-only). File connections export locally even without any groups. Desktop profiles use encrypted storage instead of environment credentials. Never put tokens in config files. CLI schedules were removed; use the desktop scheduler.
