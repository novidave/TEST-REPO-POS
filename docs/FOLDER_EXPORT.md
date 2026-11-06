# Automatic folder export

The primary job of the agent: read the actual remaining stock from a source, normalize and validate every record, and publish a complete `stock.csv` + `manifest.json` into a folder that a downstream watcher reads. No cloud account is needed.

## Pipeline

1. **Read** the configured source connection (file, local inventory, ERPNext, Odoo, WooCommerce, Shopify or Shoptet adapter). A read that does not finish within 10 minutes fails.
2. **Normalize** into the common model (`src/inventory/normalize.ts`): source connection, source product ID, SKU, EAN, name, selling price, ISO 4217 currency, actual quantity and its meaning (available / on hand), warehouse, availability (derived only from the quantity), source update time and snapshot time.
3. **Validate.** The snapshot is **held** (nothing is written) when any of these is true:
   - the read is empty
   - a quantity is unknown, fractional or negative (unless the source rule below applies)
   - a name, price or currency is missing
   - a currency is not ISO 4217
   - a SKU repeats across warehouses and no warehouse is selected
   - the selected warehouse is absent

   Duplicate EANs, invalid GS1 check digits and mixed currencies produce warnings only.

4. **Shrink guard** (on by default per connection): a snapshot with fewer than half the products of the last published one is held until someone presses **Publish held snapshot**.
5. **Write** `stock.csv.<uuid>.tmp`, fsync, re-read it from disk and verify its SHA-256 and row count. Then write `manifest.json.<uuid>.tmp`.
6. **Publish**: rename `stock.csv` first, then `manifest.json` last. Leftover temporaries from a crash are removed before the next write.
7. **Record** the run in SQLite (`export_runs`): trigger, start/end, result, product count, SHA-256, snapshot ID, source time and message. Product identities (`product_identities`) are stored separately from the last valid quantities (`snapshot_items`).

If any step fails, the previously published pair stays untouched, and the run is recorded as `held` or `failed`.

## Output format

`stock.csv`: UTF-8, CRLF, every field quoted, header:

```
source_code,name,ean,price,currency,quantity,warehouse,availability_status,source_updated_at
```

The first six columns are unchanged from earlier versions. The last three are the optional product fields of the pinned `cacaduu.inventory.v1` contract (`docs/cloud-api/CONNECTOR_CLOUD_API.md`). Prices and currencies are only ever copied from the source.

`manifest.json`:

```json
{
  "format": "cacaduu.stock.v1",
  "snapshot_id": "uuid, new for every read",
  "source_id": "connection ID",
  "complete": true,
  "product_count": 152,
  "generated_at": "ISO time of publication",
  "source_time": "earliest source observation time, or null",
  "file": "stock.csv",
  "columns": ["source_code", "…"],
  "encoding": "utf-8",
  "bytes": 12345,
  "sha256": "hex SHA-256 of stock.csv",
  "publication": "manifest-last"
}
```

## Reader protocol (downstream folder watcher)

`manifest.json` is the commit marker. A watcher should:

1. React to a change of `manifest.json` (not of `stock.csv`).
2. Read the manifest, then read `stock.csv`.
3. Accept the pair only when `complete` is true and the SHA-256 and data-row count match `sha256` and `product_count`.
4. If they do not match (a publication is between its two renames, or power was lost there), wait and retry. Never consume a mismatched pair.

`readPublishedExport()` in `src/export.ts` implements this check and is used by the tests. Two file renames are not one atomic transaction across both files; the checksum makes the gap detectable.

## Scheduling

- Configure per connection on **Inventory Sync → Automatic folder exports**: preset intervals of 5, 15 (default), 30 or 60 minutes, or a custom interval of 5–1440 minutes. You can also set an optional folder (default `<export root>/<connection ID>`; the export root is set in Settings), an optional warehouse and the shrink guard.
- Saving checks that the folder exists and is writable.
- Scheduling is completion-based: the next run is planned one interval after the previous attempt **finished**. A connection never runs two exports at once; a manual Sync Now during a run is refused, and a timer that fires during one is skipped and logged.
- Exports and group syncs on the same connection are serialized through the shared connection lock.
- **Retries:** after a held or failed run, the next attempt comes after 1, 2, 4, 8 … minutes, never later than the normal interval. The failure count is persisted.
- **Restart:** due times derive from the persisted last attempt. An overdue export runs 5–35 seconds after startup (spread so many connections don't start together). Runs interrupted by a crash are marked failed.
- **Start/Stop:** stops or starts all schedules. The setting is persisted, so a stopped scheduler stays stopped after restart. Manual Sync Now still works.

## Source rules

- **Negative quantities** (file sources): the default is _reject the read_. _Treat as sold out (0)_ is an explicit per-connection choice, and the number of rows it affects is logged.
- **Unknown quantities** are never replaced with 0.
- **Multiple warehouses**: quantities are never summed. Choose one warehouse per export, or create one export per warehouse via separate connections.

## Tests

`tests/export-service.test.cjs` covers:

- normalization and ISO currency checks
- the publication protocol and tampering detection
- the default interval
- history, restart resume and interrupted runs
- held/invalid reads with export preservation
- backoff and overlap prevention
- the shrink guard
- persisted Start/Stop
- negative-stock rules
- log redaction
- settings and mapping import/export

`scripts/test-electron.cjs` performs the same workflow through the real Electron UI. It runs against both the source build and the packaged build.
