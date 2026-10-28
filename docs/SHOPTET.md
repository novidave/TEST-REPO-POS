# Shoptet — native inventory API

## Implemented and tested

The native connector implements inventory reads and **opt-in, master-source stock updates** using Shoptet's official [pinned OpenAPI contract](connector-contracts/shoptet/CONTRACT.json). Protocol tests use mocked responses and temporary stores. The user has no API access yet: no live merchant request, stock update or staging validation has been performed.

Reads verify the expected e-shop ID, discover warehouses and page through product supplies. Private API and approved add-on API-token headers are separate; tokens stay in the encrypted OS vault. Writes call `PATCH /api/stocks/{stockId}/movements` with one `{ productCode, quantity }` entry, where **quantity means the absolute amount available for ordering**. The connector never sends relative `amountChange`, physical `realStock`, a guessed reservation adjustment or a fabricated idempotency header.

A Shoptet connection defaults to read only. To use it as a master group's destination, choose Read/write and acknowledge the quantity meaning and coordination of other stock writers. This opt-in is validated in both desktop and CLI configuration. Existing read-only connections stay read only. Pause affected groups before changing permissions. The app's existing manual Sync Now confirmation still applies.

## Concurrency, reservations and recovery

- **No two-way synchronization.** The documented movement API provides no atomic revision/CAS check. The capability is explicitly false, even when writes are enabled, and two-way groups are rejected.
- **Whole, nonnegative, zero-claim stock only.** Nonzero reservations (`claim`), missing/fractional/negative amounts, incomplete mappings or duplicate stock rows are refused. This boundary must be revisited with official reservation semantics and staging evidence before supporting reserved stock. A claim appearing during the pre-write read prevents the PATCH.
- A local stock fingerprint includes warehouse, variant identity, amount, claim and returned change time. The writer re-reads and checks the planned fingerprint before PATCH; it then reads back the resulting quantity. This fingerprint is a client preflight check, **not** a server-validated revision token or atomic lock.
- A sale or another stock writer can race between the last read and PATCH. Coordinate/stop competing stock writers during controlled staging/master updates. The acknowledgement does not remove this API limitation; concurrent live sales are not certified safe.
- One queued product is sent per request. Multi-item batches are rejected locally, so a partially accepted batch cannot mark multiple jobs successful.
- HTTP 200 with any API `errors` is a failure. HTTP status alone never declares a write successful. Successful PATCH responses can contain null data; success additionally requires a valid matching read-back.
- The durable queue records the attempt before network I/O. If a request applied but the connection or app failed, the next due attempt reads the destination and reconciles an already reached target without sending another PATCH. If the outcome remains uncertain, a non-atomic retry is **held for manual reconciliation**, not blindly resent. Missing/changed stock is also held.
- 401/403/429/5xx use controlled status errors and existing Retry-After/deadline handling. A failed/throttled Shoptet destination does not prevent an independently valid destination from completing. A throttled attempted non-atomic write may still need reconciliation before a second attempt; this is deliberately conservative.

## Getting API access

Only Shoptet-owned documentation and its vendor-owned developer repository are implementation resources. The official contract distinguishes:

- **Private API (Premium):** merchant-created API token in shop administration → Access to API, sent as `Shoptet-Private-API-Token`. Confirm current eligibility/terms with Shoptet. Grant the e-shop information and stock read rights; add stock write rights only when enabling updates.
- **Approved add-on:** approved developer/add-on access plus merchant installation/authorization. A trusted add-on backend performs installation/OAuth and obtains a short-lived API token; the desktop sends it as `Shoptet-Access-Token`. Do not enter the permanent OAuth installation token, client secret or callback code here. Installation/OAuth broker and automatic API-token renewal are not implemented. An expired token produces an authentication error and needs secure replacement.

Do not share tokens in chat. API directories do not grant access, approval or licence entitlement. This app cannot enable merchant API access.

## Desktop and CLI setup

Use POS Connections → Cloud API → Shoptet, or the advanced Shoptet form. Enter the expected numeric e-shop ID from the merchant/admin, the correct access type and its API token. The first inventory request sequence checks `data.contactInformation.eshopId` from `/api/eshop`; a token for another shop is rejected before stock access.

The e-shop ID is immutable after creation. If preparation was saved without an ID, create a new bound connection when access is available. Same-shop token replacement is encrypted. Missing ID/token stays `setup_required`, including for write-enabled preparation. Test read never writes or proves write permissions.

First validate a non-production/authorized staging shop. Inspect actual variant codes, warehouse IDs and units. For outgoing updates, verify that the source quantity means stock **available for ordering** in Shoptet, and configure one master authority with explicit product/warehouse maps. No unit or reservation conversion is assumed.

CLI connection example (the credential environment variable **name**, not a token value, goes into JSON):

```json
{
  "id": "shoptet-destination",
  "platform": "shoptet",
  "shoptetEshopId": 123,
  "shoptetAccess": "private",
  "credentialEnv": "YOUR_SHOPTET_API_TOKEN_VARIABLE",
  "permission": "read_write",
  "shoptetWriteAcknowledged": true
}
```

Omit write permission/acknowledgement for a read-only source. Desktop profiles use the OS-encrypted vault instead of environment credentials.

## Read and export boundaries

Variant `code` is the SKU/product mapping key (leading zeroes and variant suffixes preserved). Numeric stock ID is the warehouse mapping key; shelf `location` is not a warehouse. The API `amount` is copied as reported on-hand stock and `available` remains unknown; nonzero claims are refused, so no reservation subtraction is guessed. `observedAt` is the actual API observation time, not an invented stock-change timestamp.

Pagination starts at one, requires stable totals/page size, and rejects repeated/incomplete data. Limits are 1,000 pages/warehouse, 1,000 warehouses and 100,000 total rows. Reads are sequential through the shared request governor. They are not transactional snapshots; same-size concurrent catalogue changes can require another complete read.

No product prices, names or currencies are fabricated. Local stock.csv/manifest export fails validation and preserves previous valid files when verified catalogue metadata is absent. Other valid destinations retain independent failure handling. Webhooks, catalogue enrichment, fractional stock, reservation reconciliation, OAuth installation and live merchant certification remain incomplete.

## Official evidence and licences

Source: vendor-owned `shoptet/developers`, commit `d874246dcd779a365d6890c833e76b7deba166ed`, `openapi/openapi.yaml`. The pinned record includes its SHA-256, endpoint paths and write semantics. No community client or API-directory description is used as protocol evidence.

No root LICENSE file was found in that upstream snapshot. No vendor schema, examples, SDK or implementation is copied/bundled. The protocol client and summary are independently authored, with no new dependency. Merchant/API/add-on terms remain separate; no entitlement or certification is implied. The application licence is still undeclared.

Before production: obtain API access, verify read/write endpoint-group permissions, run controlled staging tests for variants/warehouses/units and response/read-back behavior, and review the explicit non-atomic/race limitations. Windows startup/DPAPI and real merchant behavior are not established by Linux tests or Windows cross-building.
