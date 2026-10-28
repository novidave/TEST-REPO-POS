# Cacaduu Cloud API client (for the POS Sync Agent)

Copy `client.ts` and `../connector-openapi.json` into the agent's repository. The client has no imports and uses the
global `fetch` (Node 18+, Electron). The contract is [`../CONNECTOR_CLOUD_API.md`](../CONNECTOR_CLOUD_API.md).

```ts
import { safeStorage } from "electron";
import { CacaduuCloudClient, CloudApiError } from "./client";

const client = new CacaduuCloudClient({
  baseUrl: settings.apiBaseUrl ?? "https://<project-ref>.supabase.co/functions/v1/connector",
  agentVersion: app.getVersion(),
  getToken: () => (settings.tokenCipher ? safeStorage.decryptString(settings.tokenCipher) : null),
  onBaseUrl: (url) => settings.save({ apiBaseUrl: url }),
});

// pairing: the owner types the code shown in Môj obchod
const paired = await client.pair("K7QM-4WXP", "Pokladňa pri vchode", `${os.type()} ${os.release()}`);
settings.save({ tokenCipher: safeStorage.encryptString(paired.device_token), apiBaseUrl: paired.api_base_url });

// every next_poll_seconds
try {
  const beat = await client.heartbeat({ sourceLabel: "POHODA XML", lastRead: { result: "ok", at: new Date().toISOString() } });
  for (const command of beat.commands) {
    if (command.type !== "sync_inventory" && command.type !== "ping") continue; // unknown types are never run
    // phase C: claim → run → report
  }
} catch (e) {
  if (e instanceof CloudApiError && e.status === 401) settings.save({ tokenCipher: null }); // pair again
  else if (e instanceof CloudApiError && e.status === 426) showUpdateRequired(e.body.min_agent_version);
  else if (!(e instanceof CloudApiError) || e.retryable) scheduleRetry(e);
}
```

Never log the device token, the pairing code or POS passwords.
