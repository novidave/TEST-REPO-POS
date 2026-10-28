# Capacity and connector compatibility

The desktop runtime has been load-tested with **120 configured connections**. This means multiple instances of the implemented drivers, not 120 different vendor integrations. The capability catalog in Settings lists actual driver support; local API, command-line, GUI automation and hardware references still require verified vendor drivers. Any POS that produces the documented, complete CSV/XML/JSON schema can use a file connection.

## Runtime bounds

| Resource | Default |
|---|---|
| Concurrent sync groups | 4 |
| Admitted group runs, including active/connection-lock waiters | 256 |
| Concurrent member inventory reads per group | 4 |
| Concurrent WooCommerce/Shopify HTTP requests, including body transfer | 8 |
| Admitted provider requests, including active requests | 512 |
| Requests to the same API origin | 1 in flight; at least 500 ms after completion before the next request |
| Provider response page | 8 MiB maximum, decompressed; oversized data is refused |
| Queued jobs examined per destination per sync cycle | 100 |

Groups sharing a connection acquire ordered locks. Different connections can run concurrently; shared connections do not execute conflicting group work at the same time. Bounded admission rejects overload instead of accumulating unlimited promises. Scheduled overload is recorded as `schedule_deferred` and retried on a later scheduled run; manual callers receive an explicit queue-full error.

Startup polling is deterministically spread across the configured interval (at least one second after scheduling). An unchanged configuration retains its next due time. The next interval starts after a run completes, so slow groups do not accumulate overlapping scheduled polls. This is completion-based polling, not a wall-clock guarantee. Pause and graceful shutdown continue to retain pending outbox jobs.

WooCommerce and Shopify preflight individual product/warehouse observations when verifying queued writes. They still read fresh stock and require the existing expected revision/quantity checks; inventory data is not reused from an old cache. Shopify also includes an initial warehouse page in its product query and only fetches extra pages when required. File/other adapters without targeted reads retain the validated full-inventory fallback.

HTTP 429 and Shopify GraphQL `THROTTLED` apply per-origin cooldown. `Retry-After` (seconds or HTTP date) and Shopify's reported cost/restore budget are respected. Transport code never automatically replays a write. The outbox persists provider retry deadlines, including across app restart. A throttled destination's remaining pending jobs are deferred without issuing one failing request per product; other destinations continue. HTTP 401/403 holds destination jobs for credential review. The five-attempt policy remains per job. Error bodies are discarded rather than returned as logs or UI errors.

Pause checks use an indexed group lookup rather than reparsing every group configuration before each write. SQLite migration adds the retry-deadline column and queue indexes without replacing existing tables or jobs. Settings shows the supported connector capabilities and live queue capacity; Sync History displays retry deadlines. The POS list supports searching/filtering more than 100 entries.

## Executed load tests

Run from the repository:

```sh
npm run test:scale
```

`tests/scale.test.cjs` uses the actual DesktopService, real temporary SQLite database, persisted connection/group configuration, coordinator, planner, runner and file exporter. Adapter IO uses synthetic, asynchronous in-memory stores; no merchant credentials, real inventories or external API calls are used. A fake clock records real scheduler entries without waiting for minute-long timers. Scheduling and provider HTTP concurrency/cooldown are tested separately with controlled clocks and mock responses.

The successful scenario configures 120 connections in 60 master groups, with 25 mapped products per group. It applies 1,500 CAS-checked writes, verifies all 60 CSV/manifest checksums, reopens the same database/profile and reruns all groups with **zero additional writes**. The first cycle uses 180 full inventory reads (including local export) and 3,000 targeted preflight reads; it does not download a whole inventory for every product write. Observed group concurrency peaks at 4. Timing diagnostics are environment-dependent; measured local first-cycle timings are recorded in VALIDATION.md and are not estimates of live API throughput.

The failure scenario throttles one destination while the other 59 groups finish. Pending operation IDs and retry deadlines survive restart. Recovery applies the remaining writes with those original IDs, without duplicating successful destinations. Separate tests cover 120 scheduled groups, 240 requests across 120 provider origins, response-body concurrency, queue overflow/cancellation, shared-connection locks, atomic conflicts and old-schema migration. Browser tests render and search 120 configured connections. `ELECTRON_TEST_HEADLESS=1 npm run test:electron:scale` also creates 120 connections through the real Electron IPC bridge, renders/searches the list, and verifies SQLite/profile persistence after restart. Windows/Linux CI runs this source-app scale check.

## Practical limits

These results establish the tested local workload, not a universal capacity guarantee. Large inventories, slow disks, API latency and provider quotas can make polling take much longer. Increase intervals when a cycle cannot finish in time; the app reports active and waiting work. Full inventory planning and synchronous SQLite transactions still consume memory and main-process time, and require further profiling for much larger catalogs. There is no new guarantee for hundreds of thousands of products per connection.

No 100-vendor certification is claimed. WooCommerce remains master-only because its stock API lacks atomic compare-and-swap. Shopify two-way polling remains subject to the documented transaction/ABA limitations. Shoptet, POHODA, MRP/DBF, Square, Lightspeed, Elcom, XLSX and hardware/GUI/CLI integrations require their own verified drivers or schema conversion; adding names or UI cards does not implement them. Windows live-scale execution, real-store rate limits and DPAPI still need the Windows/staging validation described in the README.
