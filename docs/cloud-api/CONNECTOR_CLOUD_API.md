# Cacaduu Cloud API for the POS Sync Agent (v1)

This is the contract between the **Cacaduu POS Sync Agent** (the Electron desktop app, built in its own repository) and
**Cacaduu PPI** (this repository). It covers all three phases:

| Phase | What | Status in this repository |
|---|---|---|
| A | pairing, device token, heartbeat, status, token rotation | **live** (database update 50, function `connector`) |
| B | inventory snapshots (staging upload, apply, confirm unchanged) | contract only; the paths answer `501 not_available` |
| C | Sync Now commands (claim, lease, result) | contract only; the paths answer `501 not_available` |

Machine-readable version: [`connector-openapi.json`](connector-openapi.json). A small TypeScript client with no imports
from this repository: [`connector-client/`](connector-client/). Copy both into the agent's repository by hand.

## What this API is (and is not)

The desktop app's "Own API (JSON/CSV URL + API key)" feature is an external POS data source. It is not the Cacaduu Cloud Connection. POS Own API → Desktop Connector → Cacaduu Cloud API → Marketplace. The Cacaduu Cloud API is the destination and remote-control channel, not another POS input.

The agent only ever makes **outbound HTTPS** requests. The cloud never connects to the shop PC; it answers requests, and
"remote control" (Sync Now) is a command the agent picks up on its next poll.

## Base URL

- The agent ships with one built-in **pairing URL**: `https://<project-ref>.supabase.co/functions/v1/connector`
  (later possibly `https://api.cacaduu.com`).
- `POST /v1/pair` returns `api_base_url`. The agent stores it and sends every later request there.
- Every answer to an authenticated request (heartbeat, status, rotate, …) also carries `api_base_url`. When it differs
  from the stored one, the agent stores the new one and uses it from the next request on. The address can move without
  pairing again.
- Paths are versioned: `{api_base_url}/v1/...`. Breaking changes come only under `/v2/...`.

## Headers

| Header | When | Value |
|---|---|---|
| `Cacaduu-Agent-Version` | **every** request | the agent's version, `major.minor.patch` (e.g. `1.4.2`) |
| `Authorization` | every request except `/v1/pair` | `Bearer <device token>` |
| `Content-Type` | requests with a body | `application/json` |

- A missing or malformed `Cacaduu-Agent-Version` → `400 agent_version_required`.
- A version below the server's minimum → `426 update_required` with `min_agent_version`. The agent shows "Update the
  Cacaduu POS Sync Agent" and stops calling until it is updated. Every answer also carries `min_agent_version`, so the
  agent can warn before it is enforced.
- Request bodies are at most 64 KB (snapshots never travel in a body: see phase B).

## Authentication and the device token

- A device token looks like `cdt_` + 43 characters (32 random bytes, base64url). It is returned **once** (pairing or
  rotation). The server keeps only its SHA-256 hash and can never show it again.
- **Store it in the operating system's secure storage** (Electron `safeStorage`: Windows DPAPI, macOS Keychain,
  libsecret), never in a plain file, a log or a crash report.
- A token belongs to exactly **one shop**. The shop always comes from the token; a shop id in a request body is ignored.
- `401 unauthorized` = missing, wrong, expired (after rotation) or revoked token. The agent stops, shows "Pair this
  computer again" and does not retry with the same token.
- The cloud never sends the service role key, POS passwords or POS settings, and the agent never sends POS passwords.

## Phase A — pairing, heartbeat, status, rotation

### Pairing

1. In Môj obchod → Priečinok s exportom → "Prepojenie s pokladňou (POS agent)" the owner clicks **Pridať POS agenta**.
2. Cacaduu shows a code like `K7QM-4WXP`: 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `0/O`, `1/I/L`),
   single use, valid **10 minutes**.
3. The owner types it into the agent. The agent may accept it with or without the dash, any case, spaces ignored.
4. The agent calls `POST /v1/pair`.

```http
POST /v1/pair
Cacaduu-Agent-Version: 1.4.2
Content-Type: application/json

{ "code": "K7QM-4WXP", "device_name": "Pokladňa pri vchode", "agent_version": "1.4.2", "os": "Windows 11 23H2" }
```

```http
201 Created
{
  "device_id": "5b0c3f2e-9d1e-4a6b-8f3c-2a7d9e0b1c44",
  "device_token": "cdt_q3Zr…(43 chars)",
  "shop": { "name": "Cacaduu Paint shop" },
  "api_base_url": "https://<project-ref>.supabase.co/functions/v1/connector",
  "next_poll_seconds": 60,
  "min_agent_version": "1.0.0",
  "server_time": "2026-10-27T12:00:00.000Z"
}
```

- `400 invalid_code`: wrong, used or expired code (the same answer for all three).
- `429 pairing_locked` (`Retry-After: 900`): 5 wrong codes in 15 minutes from the same caller (a daily-salted hash of
  the IP, never the IP itself). While locked, even a right code is refused.

### Heartbeat (the one poll a minute)

```http
POST /v1/heartbeat
Authorization: Bearer cdt_…
Cacaduu-Agent-Version: 1.4.2

{
  "agent_version": "1.4.2",
  "os": "Windows 11 23H2",
  "source_label": "POHODA XML",
  "last_read": { "result": "ok", "at": "2026-10-27T11:59:30Z", "error": null }
}
```

- `source_label`: a label only (≤ 80 characters), e.g. `POHODA XML`, `iKelp Excel`, `Own API`.
- `last_read.result`: `ok` | `unchanged` | `error` | `none` (nothing read yet).
- `last_read.error`: ≤ 500 characters of plain text. **Remove passwords, keys, tokens and connection strings before
  sending.** The server cuts it to 500 characters, drops control characters and shows it only as plain text to the
  shop's owners.

```http
200 OK
{
  "shop": { "name": "Cacaduu Paint shop" },
  "commands": [],
  "api_base_url": "https://<project-ref>.supabase.co/functions/v1/connector",
  "next_poll_seconds": 60,
  "min_agent_version": "1.0.0",
  "server_time": "2026-10-27T12:00:00.000Z"
}
```

- Wait `next_poll_seconds` before the next heartbeat (60 by default, 15 while a Sync Now waits in phase C).
- `commands` (phase C) holds the pending commands, so the agent makes one request a minute, not two.
- At most **4 heartbeats a minute** per device → `429 rate_limited` (`Retry-After: 60`).
- The dashboard shows the device **Online** while heartbeats arrive (the last within 3 minutes), otherwise **Offline**.
  With `last_read.result = error` it shows **Chyba**. Until the first snapshot is applied it shows
  **Ešte nesynchronizované**, and while a Sync Now runs **Synchronizuje** (phase C).

### Status

`GET /v1/status` → the device's shop, its state and the latest sync summary:

```json
{
  "shop": { "name": "Cacaduu Paint shop", "slug": "cacadoo-paint-shop-budince" },
  "device": { "id": "5b0c…", "name": "Pokladňa pri vchode", "paired_at": "…", "last_seen_at": "…" },
  "state": "online",
  "last_sync": { "at": "2026-10-27T11:45:02Z" },
  "api_base_url": "…", "next_poll_seconds": 60, "min_agent_version": "1.0.0", "server_time": "…"
}
```

`state`: `online` | `offline` | `error` | `never_synced` (`syncing` in phase C). `last_sync` is `null` until phase B
applies a snapshot.

### Credential rotation

`POST /v1/credentials/rotate` (no body) → a new token:

```json
{ "device_token": "cdt_…", "old_token_valid_until": "2026-10-28T12:00:00.000Z", "api_base_url": "…", "…": "…" }
```

- Store the new token (secure storage) **before** using it.
- The old token keeps working until the new one is first used, at most 24 hours. Then it gets `401`.
- At most 5 rotations an hour per device → `429`.
- Recommended: rotate every 90 days, and right away if the token may have leaked.

### Revocation

The owner clicks **Odpojiť** in the dashboard. It takes effect at once: the next request with that token gets `401`
(also the old token after a rotation). The agent deletes the stored token and shows "Pair this computer again".

## Phase B — inventory snapshots (contract; `501` until deployed)

### The snapshot JSON (uncompressed)

```json
{
  "format": "cacaduu.inventory.v1",
  "snapshot_id": "0f6d2b8e-3c41-4e8a-9b0a-6a8f2d7c1e55",
  "source_id": "pohoda-xml-main",
  "source_time": "2026-10-27T11:59:30Z",
  "products": [
    {
      "source_code": "CP01",
      "name": "Interiérová farba biela, matná, 15 l",
      "ean": "2000000000015",
      "brand": "Primalex",
      "price": 54.9,
      "currency": "EUR",
      "quantity": 7,
      "availability_status": "in_stock",
      "warehouse": "Hlavný sklad",
      "source_updated_at": "2026-10-27T10:12:00Z"
    }
  ]
}
```

| Field | Required | Rule |
|---|---|---|
| `source_code` | yes | ≤ 100 characters; keeps the same item across snapshots |
| `name` | yes | ≤ 300 characters |
| `ean` | no | ≤ 32 characters |
| `brand` | no | ≤ 120 characters |
| `price` | yes | number ≥ 0 (selling price; never a purchase price) |
| `currency` | yes | ISO 4217 (`EUR`, `HUF`, `CZK`, …). Cacaduu never fills it in |
| `quantity` | yes | number; 0 or less = sold out |
| `availability_status` | no | ≤ 40 characters, stored as sent; shoppers still see availability from `quantity` |
| `warehouse` | no | ≤ 80 characters, stored, never summed. One snapshot = one shop: with several warehouses, send only this shop's |
| `source_updated_at` | no | ISO 8601 time the POS changed the item |

- **Any other field is dropped and never stored**: purchase price, supplier, margin, notes, … Better: don't send them.
- One snapshot = the **whole** stock of this shop at `source_time`. A product missing from a complete snapshot is set
  to quantity 0, as with files.
- `content_hash` = SHA-256 (hex, lowercase) of the exact uncompressed JSON bytes that are gzipped and uploaded.

### Upload steps

1. **Announce**: `POST /v1/inventory/snapshots`

   ```json
   { "snapshot_id": "0f6d…", "source_id": "pohoda-xml-main", "source_time": "2026-10-27T11:59:30Z",
     "complete": true, "product_count": 152, "content_hash": "9c1e…", "command_id": null }
   ```

   → `201` `{ "snapshot_id": "0f6d…", "state": "awaiting_upload", "upload_url": "https://…", "upload_expires_at": "…" }`
   (the URL is valid 15 minutes and points to `connector-staging/<shop>/<snapshot_id>.json.gz`).
   The same `snapshot_id` again → `200` with its current state (and a fresh `upload_url` while still awaiting upload).
2. **Upload**: `PUT <upload_url>` with the gzipped JSON as the body, `Content-Type: application/gzip`. The size limit is
   the server's `CONNECTOR_MAX_MB` (compressed). The body never goes through the function.
3. **Complete**: `POST /v1/inventory/snapshots/{id}/complete` (no body). The server reads the file, checks it and applies
   it (or holds it, see below). Answers:
   - `200` `{ "state": "applied", "result": { "products": 152, "imported": 150, "zeroed": 2, "skipped": 0 } }`
   - `200` `{ "state": "held", "reason": "shrinking" }` — waits for the owner's "Áno, použiť tento stav".
   - `200` `{ "state": "test_ok", "result": { "products": 152 } }` — checked but not applied, because the shop's
     active stock source is not "POS agent".
   - `200` `{ "state": "rejected", "error": "invalid_rows", "message": "…" }` — the previous stock stays.
   - `202` `{ "state": "processing" }` — ask again with `GET /v1/inventory/snapshots/{id}` (every 5 s, at most 5
     minutes).
4. **Unchanged stock**: when the POS was re-read and the content is identical, don't upload again:
   `POST /v1/inventory/confirm` `{ "content_hash": "9c1e…", "source_time": "…", "command_id": null }`.
   If the hash equals the last applied snapshot of this shop, only the freshness time moves forward (`200
   { "state": "confirmed" }`); otherwise `409 send_full_snapshot`.

### What makes a snapshot count

- `complete: true`, `product_count` equal to the real number of products and a matching `content_hash`; otherwise
  `rejected` (`count_mismatch`, `hash_mismatch`). A partial or failed upload never counts and never sets anything to 0.
- `source_time` must be newer than the last applied snapshot (`409 stale`), except the same snapshot again.
- `source_time` more than 5 minutes in the future → `422 clock_ahead` ("skontrolujte čas na počítači"). Freshness =
  the earlier of `source_time` and the time Cacaduu received it.
- Invalid rows (bad price, quantity or currency): more than 5 % → the whole snapshot is `rejected` (`invalid_rows`);
  5 % or less → those rows are skipped and reported, and their items keep their previous stock (not set to 0).
- 0 products, or fewer than half of the last applied count → `held` until the owner approves it. Never automatic.
- Applied in one transaction; on any failure the previous stock stays.
- At most one full snapshot per 5 minutes per shop (`429`), except when answering a Sync Now command.
- Several paired devices of one shop are applied one after another (a per-shop lock); the newest `source_time` wins.

## Phase C — commands (contract; `501` until deployed)

- Types: **`sync_inventory`** and **`ping`** only. The agent **ignores any other type** (logs it, never runs it). The
  cloud never sends code, file paths or POS settings.
- A command: `{ "id": "…", "type": "sync_inventory", "state": "pending", "created_at": "…", "expires_at": "…",
  "attempt": 1 }`.
- States: `pending` → `claimed` → `running` → `completed` | `failed` | `expired`.
- Pending commands come in every heartbeat answer (`commands`) and from `GET /v1/commands`.
- `POST /v1/commands/{id}/claim` → `200 { "state": "claimed", "lease_expires_at": "…" }`, or `409 already_claimed`
  (another agent got it). One atomic update: two agents never run the same command.
- The lease lasts 2 minutes; renew it with `POST /v1/commands/{id}/result { "state": "running" }`. An expired lease
  returns the command to `pending`; after 3 attempts it is `failed`.
- `POST /v1/commands/{id}/result`:
  - `{ "state": "running" }` (renews the lease),
  - `{ "state": "failed", "reason": "POS nie je dostupný" }` (≤ 500 characters of plain text, no passwords),
  - `{ "state": "completed", "snapshot_id": "0f6d…" }` for `sync_inventory`: counts only when that snapshot was
    applied or held. Otherwise `409 snapshot_not_applied`. `ping` completes without a snapshot.
- A command not claimed within 10 minutes expires; the dashboard says "Agent je offline – zapnite počítač s POS
  agentom".
- A `sync_inventory` answer may use a full snapshot or `confirm` (unchanged), with `command_id` set, outside the
  5-minute snapshot limit.

## Errors

Every error is JSON: `{ "error": "<code>", "message": "<English text for logs>", … }`.

| HTTP | `error` | Meaning | Agent should |
|---|---|---|---|
| 400 | `bad_request` | body not one JSON object ≤ 64 KB, or a field is wrong | fix the request; don't retry as is |
| 400 | `agent_version_required` | missing/malformed `Cacaduu-Agent-Version` | send the header |
| 400 | `invalid_code` | pairing code wrong, used or expired | ask the owner for a new code |
| 401 | `unauthorized` | token missing, wrong, revoked or replaced | delete the token, ask to pair again |
| 404 | `not_found` | unknown path or id | check the path / `api_base_url` |
| 405 | `method_not_allowed` | wrong HTTP method | fix the request |
| 409 | `stale` | (B) `source_time` not newer than the last applied | read the POS again |
| 409 | `send_full_snapshot` | (B) confirm hash differs from the last applied | upload a full snapshot |
| 409 | `already_claimed` | (C) another agent claimed the command | ignore the command |
| 409 | `snapshot_not_applied` | (C) completed with a snapshot that was not applied/held | report `failed` or retry the sync |
| 413 | `too_large` | (B) snapshot over `CONNECTOR_MAX_MB` | report to the owner |
| 422 | `clock_ahead` | (B) `source_time` > 5 min in the future | ask the owner to fix the PC clock |
| 426 | `update_required` | agent below `min_agent_version` | update the agent; stop calling |
| 429 | `pairing_locked` / `rate_limited` | too many requests | wait `Retry-After` seconds |
| 500 | `server_error` | Cacaduu's fault | retry with backoff |
| 501 | `not_available` | this phase is not switched on yet | retry much later (e.g. hourly) |

## Rate limits

| What | Limit | Answer |
|---|---|---|
| wrong pairing codes | 5 per 15 minutes per caller | `429 pairing_locked`, `Retry-After: 900` |
| heartbeat | 4 per minute per device | `429 rate_limited`, `Retry-After: 60` |
| rotation | 5 per hour per device | `429 rate_limited`, `Retry-After: 3600` |
| full snapshots (B) | 1 per 5 minutes per shop (except answering Sync Now) | `429 rate_limited` |

`GET /v1/status` has no separate limit; call it when the user opens the agent's window, not in a loop.

## Retries and idempotency

- Retry only `429`, `500`, `502`, `503`, `504` and network errors. Honour `Retry-After`; otherwise back off
  5 s · 2ⁿ (with ±20 % jitter), at most 5 minutes between tries.
- Never retry `400`, `401`, `404`, `405`, `409`, `413`, `422`, `426` as they are.
- `snapshot_id` (B) is the idempotency key: the same id again returns the first result; nothing is applied twice.
  Generate a new UUID for each new read of the POS, and reuse it only to retry the same upload.
- Pairing is not idempotent (a code is single use): if the answer to `/v1/pair` is lost, ask the owner for a new code.

## Clock

- Every answer carries `server_time`. When the PC clock differs by more than 2 minutes, show a warning; more than 5
  minutes ahead makes snapshots fail (`clock_ahead`).
- Send times in ISO 8601 with a time zone (`Z` or `+01:00`).

## Versioning

- `/v1` stays compatible: new optional fields may appear in answers (ignore unknown fields) and new error codes may
  appear (treat unknown 4xx as "don't retry", unknown 5xx as "retry").
- Breaking changes only in `/v2`, announced in advance; `/v1` keeps working for at least 6 months after `/v2` starts.
- The server's minimum agent version (`min_agent_version`) is raised only for security or data-safety fixes.
