# Explicit CSV import profiles

The file connector can read merchant-authorized CSV exports whose headers differ from the standard handover schema. This is configurable file compatibility, not a native vendor API or a certified POHODA/Money/KROS/Subiekt parser. No proprietary SDK or vendor schema is bundled, and vendor export/access licence requirements still apply. XML/JSON keep the existing standard formats; XLSX, DBF, direct database access and watched folders remain unimplemented.

## Desktop setup

1. Choose File / Folder in the POS wizard, or Add connection → CSV / XML / JSON file. Select the actual `.csv` path.
2. Under CSV import format, choose **Explicit column mapping**. Select the exact separator (comma, semicolon, tab or pipe), text encoding (UTF-8, Windows-1250 or Windows-1252) and decimal separator. Nothing is auto-detected.
3. Choose whether the source quantity means **on hand** or **available to sell**. Match its meaning and units to the destination before enabling a group; the app does not convert reservations or measurement units.
4. Click **Read CSV headers** to inspect the chosen file and assign fields with dropdowns, or enter one `field = exact export header` per line. Header inspection shows column names and data-row counts only; it does not validate stock, save a connection or write an export. No columns are auto-assigned. Required fields are `source_code` (SKU), `quantity`, `warehouse`, `observed_at`. Each header maps to one field. Dropdowns preserve exact whitespace; in manual mappings, quote headers with significant leading/trailing spaces as JSON strings (for example `source_code = " SKU "`). There are no constant values, expressions, scripts or fallback defaults.
5. For local `stock.csv` export, also map `name`, `price` and `currency` together. `ean` is optional when catalogue mappings are present. Omit the entire catalogue mapping to use a stock-only source without guessing commercial data.
6. Preview before saving. Then run Test read and inspect the actual product/warehouse identities. Product/warehouse mappings into a sync group are separate from CSV header mappings.

A regional preparation profile may be associated with a file connection. That profile remains native `setup_required`; successfully reading the CSV does not test a vendor API. Use a real export whose completeness, timestamp, stock scope, quantity meaning and licence entitlement the merchant has verified. Totals, receipts, menu items and accounting balances are not complete product inventory.

## Synthetic format example

This example demonstrates the parser and does not claim any vendor uses these exact headers:

```csv
Kód;Počet;Sklad;Čas;Názov;Cena;Mena
001;2,00;Bratislava;2026-10-28T12:00:00+01:00;Synthetic catalogue item;12,50;EUR
```

The corresponding CLI `ConnectionConfig` entry is:

```json
{
  "id": "regional-export",
  "platform": "file",
  "stockPath": "C:\\Inventory\\export.csv",
  "permission": "read",
  "csvImport": {
    "version": 1,
    "delimiter": ";",
    "encoding": "utf-8",
    "decimalSeparator": ",",
    "quantityKind": "on_hand",
    "columns": {
      "source_code": "Kód",
      "quantity": "Počet",
      "warehouse": "Sklad",
      "observed_at": "Čas",
      "name": "Názov",
      "price": "Cena",
      "currency": "Mena"
    }
  }
}
```

The profile is public format metadata, not a credential container. No new dependency was added. Its validation contract is independently authored in `src/sync/csv-import.ts`; CSV parsing uses the existing csv-parse dependency and legacy decoding uses the built-in TextDecoder. Existing dependency licence and Electron/Chromium notices remain applicable.

## Validation and operational limits

- SKUs retain leading zeroes; field values are not guessed or trimmed into new identities. Headers must be unique and nonempty, and every configured header must exist. A changed export layout fails closed.
- Quantities must be nonnegative safe whole numbers. `2,00` is accepted with decimal comma, `1,5` is refused. Grouped thousands, exponent notation and the wrong decimal separator are refused. Prices are taken from actual source values and validated; currency must be an actual three-letter uppercase code.
- Mapped timestamps must be ISO 8601 with an explicit timezone (`Z` or `+01:00`), not the import time or an assumed local timezone.
- Empty stock, duplicate product/warehouse rows, missing SKU/warehouse/time and partial catalogue mappings are refused. No price, name, currency, quantity, warehouse or timestamp is supplied by the application.
- A stock-only read has no catalogue metadata. Local export fails validation and preserves the previous valid CSV/manifest; other valid group destinations continue independently. Read-only file sources cannot be write destinations or two-way participants.
- All file reads stop above 16 MiB; imports refuse more than 100,000 rows. Files are fully validated before sync planning/export. The source must publish a complete file atomically; the application does not claim a transactional snapshot of a file modified during reading.
- Profiles persist in SQLite and survive restart. Changing the file path or import settings is blocked while the affected group has outstanding jobs. After reconciliation, a change clears prior stock observations/conflict baselines. Clearing a profile returns to the standard schema; it does not transform the file.

Tests use synthetic files, real temporary SQLite stores and mock remote adapters. They cover legacy decoding, quoted fields/BOM/separators, exact quantity meaning, missing/duplicate fields, export preservation, CLI behavior, queued-job guards and independent master destinations. Real Electron tests exercise the mapped wizard, unsaved preview, saved profile, default export and profile restart. No merchant stock is touched, and no native vendor interoperability is implied.

Header inspection uses the selected separator/encoding and the same 16 MiB / 100,000-row bounds. At most 128 nonempty unique headers of 200 characters are returned; row contents stay in the main process. A header-only file can be inspected but still fails stock validation. Changing the path, separator or encoding clears old choices; results received after a format/path edit are discarded. Untrusted headers render as text. The secure IPC bridge exposes only this fixed read-only operation, with no executable transforms.
