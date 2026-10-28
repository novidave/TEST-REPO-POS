# CACADUU POS Sync Agent

Standalone Electron desktop app in **novidave/TEST-REPO-POS**. No runtime dependency on the website repository. Cloud API contract pinned under [docs/cloud-api](docs/cloud-api/).

## Status

The destination repository originally contained only a README. This branch adds a Phase A desktop connection scaffold (pair, manual heartbeat, status, token rotation), optional feature-gated cloud API calls, and CSV + manifest export logic. **This is not yet a complete POS connector, automatic scheduler, or tested end-to-end inventory sync.** The previous handover implementation was not present to integrate.

## Run

Node.js 22+: `npm install`, `npm test`, `npm start`. Enter the HTTPS connector pairing URL in Settings or set `CACADUU_PAIRING_URL`. No Supabase service-role key is used.

## Cloud flags

`CACADUU_ENABLE_SNAPSHOTS=true` and `CACADUU_ENABLE_COMMANDS=true` opt into contract-only API methods. They default to off; HTTP 501 with `not_available` is treated as unavailable without affecting pairing. Cloud inventory and Sync Now workflows remain unfinished.

## File export

`src/export.ts` provides `exportStock(directory, rows, sourceId)` to write `stock.csv` and `manifest.json` with SHA-256. It is not yet connected to a POS extractor. Empty exports are refused. The manifest schema is provisional: reconcile it with the original handover before production.

## Security

Device tokens are encrypted with Electron safeStorage. The app refuses to save a token when secure storage is unavailable. Do not put POS passwords, service-role keys, or device tokens in logs. Local unpair does not revoke a device; revoke it in Môj obchod.

## Next

Build POS connectors, mapping, scheduled export, full snapshot upload and command processing, tests against a staging backend, and installers. Preserve the file workflow as default.
