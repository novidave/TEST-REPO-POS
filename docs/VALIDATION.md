# Validation evidence

Validated on 2026-10-28 in the managed Linux environment, from a clean `npm ci` using the committed lockfile. Node 24.19.0, Electron 45.1.0, better-sqlite3 13.0.3. No live merchant credentials or inventory writes were used.

| Check | Actual result |
|---|---|
| `ELECTRON_GET_USE_PROXY=1 npm ci` | Passed; clean lockfile installation |
| `npm run build` / `npm run check` | Passed; TypeScript compilation and strict type check |
| `npm test` | 58 passed, 0 failed, 0 skipped; includes real temporary SQLite stores and CLI subprocess |
| `npm run format:check` | Passed |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:ui` | 5 browser tests passed; mocked bridge; includes seven views, file setup, secret-field clearing, unsupported states, group maps/roles and manual sync |
| `npm run native:electron` | Passed; SQLite transaction under actual Electron Node-API runtime |
| `ELECTRON_TEST_HEADLESS=1 npm run test:electron` | Passed; real app, sandboxed renderer and IPC; file setup/read test, SQLite persistence, export and preservation after invalid input |
| `npm run smoke:electron -- --ozone-platform=headless` | Passed; startup, seven views, isolated renderer, IPC and native SQLite; container emitted display/DBus warnings |
| `ELECTRON_GET_USE_PROXY=1 npm run package:win` | Passed; portable Windows x64 folder generated; executable is PE32+ x86-64; Windows SQLite binary included outside ASAR |
| `npm audit --omit=dev --audit-level=high` | Passed; 0 reported runtime dependency vulnerabilities |
| `git diff --check` | Passed |

The first installation needed Electron's supported proxy flag. An initial forced native source rebuild was denied access to the Electron header host. Updating to the Node-API-based SQLite release removed the unnecessary per-runtime rebuild; its bundled native binary was tested under both Node and Electron without disabling TLS or checksum checks. The explicit source-rebuild fallback remains unverified in this restricted environment.

Windows executable startup, DPAPI round trip, signed distribution and real store integrations were **not executed here**. The Windows/Linux CI workflow is provided, not represented as an already completed CI run. The portable Windows package was cross-built on Linux; cross-building is not Windows execution.

Runtime limits and platform-specific setup requirements are documented in the README and architecture document. In particular, Shoptet/POS vendor integrations remain setup-required, WooCommerce lacks atomic writes, and optional cloud inventory/commands remain incomplete. All pinned `docs/cloud-api` files remain unchanged. No changes were made to CACADOO-PPI, no PR was merged, and nothing was deployed.
