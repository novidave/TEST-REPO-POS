# Standalone universal inventory synchronization — implementation status

## Independence
TEST-REPO-POS can operate without CACADUU. CACADUU remains an optional destination, using the pinned docs/cloud-api contract. Phase A is separate; B/C are disabled by default and treat 501 not_available as unsupported. Local stock.csv + manifest remains the intended default delivery; current generic adapters do **not** yet provide verified name/price/currency for a safe export, so automatic file delivery from these adapters is intentionally not wired.

## Core
- Explicit product identity mapping per connection; no name-only matching.
- Master mode: only designated master is authoritative.
- Two-way mode: first differing observations and simultaneous changes become conflicts; no last-writer-wins guesses.
- SQLite durable observations, conflicts and outbox.
- Sequential destination writes; one failing destination does not prevent another.
- No implicit location mapping; exact location IDs required in this first version.
- No cloud server required for commerce-to-commerce synchronization while the desktop process is running.

## Adapters
- WooCommerce: REST product/variation read and absolute quantity write for stock-managed products. No revision CAS; unsafe for concurrent high-volume edits.
- Shopify: GraphQL inventory items/locations and compareQuantity writes. Pagination of inventory levels beyond first 100 per item remains unimplemented; require validation for large shops.
- Shoptet: explicit disabled adapter pending verified merchant authorization and API schema. Never invent endpoints.
- POS: injectable driver interface, no vendor driver included.
- File: JSON stock observations reader, not yet the handover CSV schema.

## Safety limitations
Two-way polling can miss multiple intervening sales; this design deliberately holds ambiguous changes. Do not enable for live shops without testing and a single authoritative ledger or reliable transaction events. Outbox retries are persisted but no backoff, dead-letter, or destination verification is implemented. A destination update can succeed remotely then be retried if the app crashes before marking it complete; APIs without idempotency need reconciliation before production.

## Tests and release gates
Run npm install, npm test, then test with sandbox stores. No live credentials in repo. Verify variant mapping, pagination, write permissions, rate limits, concurrent sales, crash recovery, stale observations, and exported CSV schema. **Not production-ready.**
