# Standalone synchronization architecture

The existing Electron scaffold, pinned cloud client, adapters, exporter, planner and SQLite store are retained. `src/desktop.ts` owns desktop configuration, encrypted credential access, schedules, local export and history. `src/main.ts` owns window lifecycle and restricted IPC; the renderer receives explicit safe operations only. `src/security.ts` provides encrypted vault, atomic JSON writes, HTTPS checks and public error handling.

## Planning and execution

`planGroup` validates complete inventories and explicit product/warehouse identities. Master groups select the configured source; two-way groups require CAS-capable members and compare against the last agreed observation. Conflicting items retain their old baselines. Plan observations and new jobs commit in a single SQLite transaction.

`runGroup` serializes group execution, drains group-scoped durable operations and isolates destinations. Master groups can continue updating healthy destinations while another has held work. Two-way groups reconcile their existing queue before creating another plan. Source/peer changes, destination revision changes and ambiguous retries are held. A write attempt is persisted before network IO. Targeted product/warehouse reads avoid repeated full downloads while retaining fresh revision checks. Provider deadlines persist in the outbox; a throttled or offline destination defers its remaining jobs, and authentication failures hold them. Applied quantities reconcile after a crash; unchanged revisions permit atomic retries, and non-atomic uncertain writes require review. Failures use backoff and a five-attempt limit. Errors are controlled messages; upstream bodies and secrets are not logged.

The bounded runtime admits up to 256 group runs, executes four at once, and locks shared connections in a stable order. Member reads are bounded at four per group; the shared provider transport caps eight HTTP transfers including their bodies, serializes each origin and enforces cooldowns. Startup polling is staggered and never overlaps the previous poll. The [capacity report](SCALABILITY.md) describes the 120-connection tests.

The desktop saves group/connection configuration in SQLite, encrypts credentials separately with OS storage, and reinstalls schedules when opened. Pause/Resume persists independently of editable configuration and retains retry jobs; the runner rechecks pause/shutdown state immediately before each write. An in-flight request can still complete. Configuration mutations serialize against sync startup; active groups protect their own connections while unrelated connections remain editable, stale connection-test results cannot overwrite edits, and shutdown waits for reads, exports and credential/configuration writes. Endpoint identity is immutable for commerce connections. Changing mapping or file-source identity clears stale observation baselines. Processes do not survive app exit. There is no Windows service. Single-instance and per-group guards protect the desktop profile. Do not run a separate CLI process against the same database concurrently.

## Capability boundaries

- File input: explicit CSV/XML handover schema and existing JSON observations. File output: `stock.csv` plus checksum manifest, only with complete catalogue metadata. Duplicate SKU warehouses are not automatically aggregated.
- WooCommerce: master-only reads/writes; lacks CAS and can race concurrent edits even with preflight checks. No sales-ledger semantics or verified catalogue currency.
- Shopify: inventory item and warehouse pagination, compareQuantity writes. Quantity-based CAS protects a single update, but polling can miss intervening transactions or ABA changes. No live-store certification is claimed.
- Shoptet and POS: accurate setup-required states. The six-method setup wizard stores vendor references and encrypted credentials but performs no speculative local API request, command execution, GUI clicks or hardware/database access. XLSX/DBF and folder watching remain setup-required. Supported file previews use a narrow IPC operation before a connection is persisted; mapping templates are validated and reused by the explicit group editor.
- CACADUU: optional Phase A, independent of local synchronization. Pinned contract unchanged. B/C off by default, 501 gracefully unavailable, no implemented inventory-upload/command-execution workflow.

## Remaining release gates

Run Windows CI and manually validate Windows credentials, startup, packaging and a development-store workflow. OS encryption cannot be validated with a mocked cipher. Portable packaging is unsigned; signing and installers remain separate work. No real merchant writes were used in automated validation.

Outbox storage is durable but not a distributed transaction with merchant APIs. Two-way polling is not a substitute for a reliable transaction ledger. File-pair replacement is not cross-file atomic; consumers must verify manifest hashes. SQLite history is retained without automatic pruning; the UI displays up to 100 records, prioritizes outstanding jobs and counts the full outstanding queue; the inspector shows the first 1,000 rows.
