/**
 * A small client for the Cacaduu Cloud API (v1) — copy this file into the POS Sync Agent's repository.
 * No imports: it uses the global fetch (Node 18+, Electron). The contract is docs/CONNECTOR_CLOUD_API.md.
 *
 * Keep the device token in the operating system's secure storage (Electron safeStorage), never in a plain file or a
 * log. This client never stores anything itself: it gets the token through getToken() and hands new tokens and the
 * newest api_base_url back through the callbacks.
 */

export type ReadResult = "ok" | "unchanged" | "error" | "none";
export type DeviceState = "online" | "offline" | "error" | "never_synced" | "syncing";
export type CommandType = "sync_inventory" | "ping";
export type CommandState = "pending" | "claimed" | "running" | "completed" | "failed" | "expired";
export type SnapshotStateName = "awaiting_upload" | "processing" | "applied" | "held" | "test_ok" | "rejected" | "expired";

export interface PollInfo {
  api_base_url: string;
  next_poll_seconds: number;
  min_agent_version: string;
  server_time: string;
}

export interface PairResponse extends PollInfo {
  device_id: string;
  device_token: string;
  shop: { name: string };
}

export interface Command {
  id: string;
  type: CommandType | string;
  state: CommandState;
  created_at?: string;
  expires_at?: string;
  lease_expires_at?: string | null;
  attempt?: number;
}

export interface HeartbeatResponse extends PollInfo {
  shop: { name: string };
  /** Only sync_inventory and ping are known; ignore every other type. */
  commands: Command[];
}

export interface StatusResponse extends PollInfo {
  shop: { name: string; slug: string };
  device: { id: string; name: string; paired_at: string; last_seen_at: string | null };
  state: DeviceState;
  last_sync: { at: string } | null;
}

export interface RotateResponse extends PollInfo {
  device_token: string;
  old_token_valid_until: string;
}

/** One product of a snapshot; any other field is dropped by the server (better: don't send it). */
export interface Product {
  source_code: string;
  name: string;
  ean?: string;
  brand?: string;
  price: number;
  /** ISO 4217, e.g. "EUR"; the server never fills it in. */
  currency: string;
  quantity: number;
  availability_status?: string;
  warehouse?: string;
  source_updated_at?: string;
}

/** The uncompressed JSON that is gzipped and uploaded; content_hash = SHA-256 of exactly these bytes. */
export interface InventorySnapshot {
  format: "cacaduu.inventory.v1";
  snapshot_id: string;
  source_id: string;
  source_time: string;
  products: Product[];
}

export interface SnapshotAnnounce {
  snapshot_id: string;
  source_id: string;
  source_time: string;
  complete: true;
  product_count: number;
  content_hash: string;
  command_id?: string | null;
}

export interface SnapshotState {
  snapshot_id: string;
  state: SnapshotStateName;
  upload_url?: string;
  upload_expires_at?: string;
  reason?: string;
  error?: string;
  message?: string;
  result?: { products?: number; imported?: number; zeroed?: number; skipped?: number };
}

export interface CommandResult {
  state: "running" | "failed" | "completed";
  reason?: string;
  snapshot_id?: string;
}

/** An error answer of the API (see the error table in the contract). */
export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number | null,
    readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CloudApiError";
  }

  /** 429, 5xx (except 501) and network errors may be retried; everything else not as it is. */
  get retryable(): boolean {
    return this.status === 429 || (this.status >= 500 && this.status !== 501);
  }
}

export interface ClientOptions {
  /** The built-in pairing URL, used until a pair/heartbeat answer gives an api_base_url. */
  baseUrl: string;
  /** This agent's version, "major.minor.patch". */
  agentVersion: string;
  /** Reads the device token from secure storage (null before pairing). */
  getToken: () => string | null | Promise<string | null>;
  /** Called when the server names a new api_base_url: store it and use it from now on. */
  onBaseUrl?: (url: string) => void | Promise<void>;
  fetch?: typeof fetch;
  /** Per request (ms), default 30 000. */
  timeoutMs?: number;
}

export class CacaduuCloudClient {
  private baseUrl: string;

  constructor(private readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  get currentBaseUrl(): string {
    return this.baseUrl;
  }

  /** POST /v1/pair — the token in the answer is shown once: store it in secure storage right away. */
  pair(code: string, deviceName: string, os: string): Promise<PairResponse> {
    return this.request<PairResponse>("POST", "/v1/pair", { code, device_name: deviceName, agent_version: this.options.agentVersion, os }, false);
  }

  /** POST /v1/heartbeat — once every next_poll_seconds; brings the pending commands too. */
  heartbeat(input: { os?: string; sourceLabel?: string; lastRead?: { result: ReadResult; at?: string; error?: string | null } }): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>("POST", "/v1/heartbeat", {
      agent_version: this.options.agentVersion,
      os: input.os,
      source_label: input.sourceLabel,
      last_read: input.lastRead,
    });
  }

  status(): Promise<StatusResponse> {
    return this.request<StatusResponse>("GET", "/v1/status");
  }

  /** POST /v1/credentials/rotate — store the new token before using it; the old one works until then (max 24 h). */
  rotateCredentials(): Promise<RotateResponse> {
    return this.request<RotateResponse>("POST", "/v1/credentials/rotate", {});
  }

  // ---------------------------------------------------------------- phase B (501 until switched on)

  createSnapshot(announce: SnapshotAnnounce): Promise<SnapshotState> {
    return this.request<SnapshotState>("POST", "/v1/inventory/snapshots", announce);
  }

  /** PUT the gzipped snapshot to the signed upload URL (not through the API). */
  async uploadSnapshot(uploadUrl: string, gzipped: Uint8Array): Promise<void> {
    const res = await this.fetchWithTimeout(uploadUrl, {
      method: "PUT",
      headers: { "content-type": "application/gzip" },
      // a copy as a plain ArrayBuffer (works with every TypeScript version's fetch types)
      body: gzipped.slice().buffer as ArrayBuffer,
    });
    if (!res.ok) throw new CloudApiError(res.status, "upload_failed", `Upload failed with HTTP ${res.status}`, null, {});
  }

  completeSnapshot(snapshotId: string): Promise<SnapshotState> {
    return this.request<SnapshotState>("POST", `/v1/inventory/snapshots/${encodeURIComponent(snapshotId)}/complete`, {});
  }

  getSnapshot(snapshotId: string): Promise<SnapshotState> {
    return this.request<SnapshotState>("GET", `/v1/inventory/snapshots/${encodeURIComponent(snapshotId)}`);
  }

  confirmUnchanged(input: { content_hash: string; source_time: string; command_id?: string | null }): Promise<{ state: "confirmed" }> {
    return this.request<{ state: "confirmed" }>("POST", "/v1/inventory/confirm", input);
  }

  // ---------------------------------------------------------------- phase C (501 until switched on)

  listCommands(): Promise<{ commands: Command[] }> {
    return this.request<{ commands: Command[] }>("GET", "/v1/commands");
  }

  claimCommand(commandId: string): Promise<Command> {
    return this.request<Command>("POST", `/v1/commands/${encodeURIComponent(commandId)}/claim`, {});
  }

  reportCommand(commandId: string, result: CommandResult): Promise<Command> {
    return this.request<Command>("POST", `/v1/commands/${encodeURIComponent(commandId)}/result`, result);
  }

  // ---------------------------------------------------------------- helpers

  /** SHA-256 (hex) of the exact uncompressed snapshot bytes, for content_hash. */
  static async contentHash(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Is a version below another ("1.2.3" < "1.10.0")? */
  static versionBelow(a: string, b: string): boolean {
    const parse = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1, 4).map(Number);
    const x = parse(a);
    const y = parse(b);
    if (x.length !== 3 || y.length !== 3) return false;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
    return false;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      return await (this.options.fetch ?? fetch)(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown, authenticated = true): Promise<T> {
    const headers: Record<string, string> = { "cacaduu-agent-version": this.options.agentVersion };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authenticated) {
      const token = await this.options.getToken();
      if (!token) throw new CloudApiError(401, "unauthorized", "Not paired: no device token", null, {});
      headers.authorization = `Bearer ${token}`;
    }
    const res = await this.fetchWithTimeout(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
    if (!res.ok) {
      const retry = Number(res.headers.get("retry-after") ?? json.retry_after);
      throw new CloudApiError(
        res.status,
        typeof json.error === "string" ? json.error : `http_${res.status}`,
        typeof json.message === "string" ? json.message : `HTTP ${res.status}`,
        Number.isFinite(retry) && retry > 0 ? retry : null,
        json,
      );
    }
    const next = typeof json.api_base_url === "string" ? json.api_base_url.replace(/\/+$/, "") : null;
    if (next && /^https:\/\//.test(next) && next !== this.baseUrl) {
      this.baseUrl = next;
      await this.options.onBaseUrl?.(next);
    }
    return json as T;
  }
}
