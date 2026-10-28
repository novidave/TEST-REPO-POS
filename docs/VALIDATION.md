# Validation evidence

Validated on 2026-10-28 in the managed Linux environment, from a clean `npm ci` using the committed lockfile. Node 24.19.0 and minimum-supported Node 22.15.0, Electron 45.1.0, better-sqlite3 13.0.3. No live merchant credentials or inventory writes were used.

| Check | Actual result |
|---|---|
| `ELECTRON_GET_USE_PROXY=1 npm ci` | Passed; clean lockfile installation |
| `npm run build` / `npm run check` | Passed; TypeScript compilation and strict type check |
| `npm test` | 119 passed, 0 failed, 0 skipped; includes real temporary SQLite stores, CLI subprocess, pause during preflight/write, endpoint binding, concurrent configuration edits, shutdown, stale-baseline, bounded concurrency, durable provider deadlines, and 120-connection restart/failure load tests |
| `npm exec --yes --package=node@22.15.0 -- node --test tests/*.test.cjs` | Passed; all 119 core tests under Node 22.15.0 |
| `ELECTRON_TEST_HEADLESS=1 npm run test:electron:scale` | Passed; 120 connections created through real Electron IPC, persisted in SQLite, rendered/searched and retained on profile restart |
| `npm run test:scale` | Passed; 120 configured test connections, 60 groups, 1,500 writes, all 60 export checksums, zero duplicate writes on restart, throttled-destination recovery |
| `npm run format:check` | Passed |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:ui` | 14 browser tests passed; mocked bridge; includes seven views, file setup, secret-field clearing, unsupported states, group maps/roles, Pause/Resume, manual sync, POS wizard file preview/mapping templates, API credential clearing, six method guides, capability/capacity display, search/filter including 120 connections, regional market filtering/native setup requirements, and unsupported states |
| `npm run native:electron` | Passed; SQLite transaction under actual Electron Node-API runtime |
| `ELECTRON_TEST_HEADLESS=1 npm run test:electron` | Passed; real app, sandboxed renderer and IPC; POS wizard setup, real unsaved file preview, persisted mapping templates, file read test, SQLite persistence, export and preservation after invalid input; same-profile restart verified |
| `npm run smoke:electron -- --ozone-platform=headless` | Passed; startup, seven views, isolated renderer, IPC and native SQLite; container emitted display/DBus warnings |
| `ELECTRON_GET_USE_PROXY=1 npm run package:linux` + `ELECTRON_TEST_HEADLESS=1 npm run test:packaged` | Passed; actual Linux ASAR distribution, native SQLite, real IPC/export workflow and profile restart |
| `ELECTRON_GET_USE_PROXY=1 npm run package:win` | Passed; portable Windows x64 folder generated; executable is PE32+ x86-64; Windows SQLite binary included outside ASAR |
| `npm audit --omit=dev --audit-level=high` | Passed; 0 reported runtime dependency vulnerabilities |
| `git diff --check` | Passed |

The first installation needed Electron's supported proxy flag. An initial forced native source rebuild was denied access to the Electron header host. Updating to the Node-API-based SQLite release removed the unnecessary per-runtime rebuild; its bundled native binary was tested under both Node and Electron without disabling TLS or checksum checks. The explicit source-rebuild fallback remains unverified in this restricted environment.

Windows executable startup, DPAPI round trip, signed distribution and real store integrations were **not executed here**. The Windows/Linux CI workflow is provided, including source/packaged tests and mandatory Windows DPAPI round trip, not represented as an already completed CI run. GitHub API requests for PR #2 checks were refused by the current environment, so remote check status could not be verified. The local Linux OS-credential probe explicitly reports unavailable because the container has no secure keyring; mocked cipher tests passed but do not establish DPAPI readiness. The portable Windows package was cross-built on Linux; cross-building is not Windows execution.

Runtime limits and platform-specific setup requirements are documented in the README and architecture document. In particular, Shoptet/POS vendor integrations remain setup-required, WooCommerce lacks atomic writes, and optional cloud inventory/commands remain incomplete. All pinned `docs/cloud-api` files remain unchanged. No changes were made to CACADOO-PPI, no PR was merged, and nothing was deployed.

## 120-connection measurements

A completed Node 24 scaling run measured the first 60-group/1,500-write cycle at **1,344 ms**; Node 22.15 measured **867 ms** on the same managed Linux host. Peak group concurrency was **4**; the scenario used **180 full inventory reads** including 60 local exports and **3,000 fresh targeted reads**. After reopening and rerunning, the write count remained exactly **1,500** (zero duplicates). Each successful export manifest matched the actual CSV SHA-256. The throttled-destination scenario preserved pending IDs/deadlines across restart and recovered while the other 59 groups completed independently.

These are individual synthetic adapter timings using real DesktopService/SQLite/exports (including operating-system/cache effects), not measurements of real merchant API latency. Separate controlled-clock tests verify 120-origin request throttling, response-body concurrency, scheduler staggering and shutdown/backpressure. No new native vendor support is implied. See [SCALABILITY.md](SCALABILITY.md) for bounds and limitations.

Regional coverage: 14 user-requested SK/CZ/PL preparation profiles are exposed and tested, all with native state `setup_required`. The profile selection does not instantiate a vendor API/SDK driver. Official Dotypos and Stormware documentation requests were denied by the running network policy; no native contract or vendor authorization is claimed verified. See [REGIONAL_CONNECTORS.md](REGIONAL_CONNECTORS.md).

## Read-only ERP connectors and licence inventory

ERPNext/Frappe v15 and Odoo 18 drivers were added against pinned official source contracts. Twelve additional core tests cover GET-only ERPNext requests, authentication, ordered pagination, filtered item reads, Odoo read-only RPC calls and lot aggregation, missing/invalid data rejection, redacted failures, immutable endpoint/database binding, and read-only desktop permissions. A browser test verifies setup field visibility, fixed read permissions and secret clearing. These are mocked protocol tests, not live server or vendor certification results.

`npm run licenses:report` recorded 91 locked packages, zero missing licence metadata fields, and an UNDECLARED application licence. This is metadata inventory only. No upstream server implementation, schema or proprietary SDK was bundled. See the protocol/licence ledger for access rights, version limits and distribution notices.

Both portable packages were rebuilt after the connector additions. The Linux packaged app passed the real IPC/export/profile-restart test. Linux and Windows ASAR contents were inspected: both new driver modules, THIRD_PARTY_NOTICES.md and ten runtime module licence/notice entries are present; Electron LICENSE and LICENSES.chromium.html remain beside both executables. Windows remains cross-built, not executed.

## Mapped CSV import increment

On 2026-10-28, 119 core tests passed under Node 24.19.0, and 14 browser tests passed. The new tests cover explicit quantity semantics, Central European Windows-1250, decimal-comma prices, quoted separators/BOM, incomplete/duplicate/ambiguous stock, source header drift, oversized files, profile persistence and queued-job/baseline guards. A real mapped-file master group delivered to a mock remote destination while local export independently failed for missing catalogue metadata. The CLI test exported a fully mapped synthetic catalogue.

The real Electron scale test now uses a semicolon/decimal-comma mapped file through the wizard and secure IPC, verifies default stock.csv export, preserves it after incomplete data, persists the import profile, and reopens the same profile with 120 configured connections. Linux OS encryption remains unavailable in this container; Windows DPAPI and live merchant systems were not executed locally. No new native vendor integration or vendor licence entitlement is claimed.

The mapped-import increment also passed all 119 tests on Node 22.15.0. Linux and Windows x64 packages rebuilt successfully; the final Linux packaged app passed the mapped-file IPC/export/restart workflow. Windows was cross-built on Linux, not executed here. Type checking, formatting and git diff checks passed. Dependency licence metadata remains 91 packages with no dependency changes.
