import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  CacaduuCloudClient,
  CloudApiError,
  type Command,
  type InventorySnapshot,
  type PollInfo,
  type Product,
  type ReadResult,
  type SnapshotState,
} from "../docs/cloud-api/client/client";
import { isNotAvailable } from "./cloud";
import type { NormalizedSnapshot } from "./inventory/normalize";
import { httpsUrl, secureAvailable, UserError, type Cipher } from "./security";
import { redactText } from "./redact";
import { systemClock, type TimerClock } from "./sync/runtime";

/** Persisted public cloud state. The device token is stored only OS-encrypted. */
export interface CloudSettings {
  apiBaseUrl: string;
  tokenEncrypted?: string;
  deviceId?: string;
  shopName?: string;
  /** Last snapshot the server applied (Phase B), for unchanged-stock confirmation. */
  lastApplied?: { snapshotId: string; contentHash: string; productsHash: string; sourceTime: string };
  /** Command IDs already handled, to never run a command twice. Bounded. */
  handledCommands?: string[];
  updateRequired?: string | null;
}
export type FeatureState = "disabled" | "not_yet_available" | "ok" | "error";
export interface CloudAgentDeps {
  load(): Promise<CloudSettings>;
  save(settings: CloudSettings): Promise<void>;
  cipher: Cipher;
  agentVersion: string;
  os: string;
  features(): { snapshots: boolean; commands: boolean };
  /** Heartbeat summary of the last local read; never contains secrets. */
  lastRead(): { sourceLabel?: string; result: ReadResult; at?: string; error?: string | null };
  /** Runs a full local export for a sync_inventory command (which offers the snapshot via offerSnapshot). */
  runSyncCommand(commandId: string): Promise<{ state: string; message: string }>;
  log(event: string, detail: Record<string, unknown>): void;
  fetch?: typeof fetch;
  clock?: TimerClock;
  random?: () => number;
}
const MAX_HANDLED = 200;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const PROCESSING_POLL_MS = 5000;
const PROCESSING_LIMIT_MS = 5 * 60 * 1000;
const LEASE_RENEW_MS = 60 * 1000;
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-?[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/;

/** Owns CACADUU pairing, heartbeat, rotation and the feature-flagged Phase B/C flows. Optional by design. */
export class CloudAgent {
  private settings: CloudSettings = { apiBaseUrl: "" };
  private timer: unknown;
  private failures = 0;
  private stopped = false;
  private heartbeatRunning = false;
  private commandBusy = false;
  private queue: Promise<unknown> = Promise.resolve();
  private lastFullUploadAt = 0;
  /** The sync_inventory command whose export is running; its snapshot is uploaded with command_id. */
  activeCommandId: string | null = null;
  private commandUploads = new Map<string, SnapshotState | { state: "confirmed"; snapshot_id: string }>();
  readonly status = {
    lastHeartbeatAt: null as string | null,
    nextHeartbeatAt: null as string | null,
    clockSkewSeconds: null as number | null,
    minAgentVersion: null as string | null,
    lastError: null as string | null,
    pairAgain: false,
    snapshots: "disabled" as FeatureState,
    commands: "disabled" as FeatureState,
    lastSnapshot: null as null | { at: string; state: string; snapshotId?: string; detail?: string },
  };
  private readonly clock: TimerClock;
  constructor(private readonly deps: CloudAgentDeps) {
    this.clock = deps.clock ?? systemClock;
  }
  async init(defaultUrl = "") {
    const loaded = await this.deps.load();
    this.settings = { ...loaded, apiBaseUrl: loaded.apiBaseUrl || defaultUrl };
    if (this.settings.updateRequired) this.status.minAgentVersion = this.settings.updateRequired;
  }
  /** Serializes all cloud state changes (pairing, rotation, heartbeat). */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new UserError("Application is closing"));
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  get paired() {
    return Boolean(this.settings.tokenEncrypted);
  }
  config() {
    const f = this.deps.features();
    return {
      apiBaseUrl: this.settings.apiBaseUrl,
      paired: this.paired,
      shopName: this.settings.shopName,
      deviceId: this.settings.deviceId,
      secureStorage: secureAvailable(this.deps.cipher),
      updateRequired: this.settings.updateRequired ?? null,
      features: f,
      ...this.status,
      snapshots: f.snapshots ? this.status.snapshots : "disabled",
      commands: f.commands ? this.status.commands : "disabled",
    };
  }
  private token(): string | null {
    if (!this.settings.tokenEncrypted) return null;
    if (!secureAvailable(this.deps.cipher)) throw new UserError("OS secure storage unavailable");
    return this.deps.cipher.decryptString(Buffer.from(this.settings.tokenEncrypted, "base64"));
  }
  private async persist(next: CloudSettings) {
    await this.deps.save(next);
    this.settings = next;
  }
  private client() {
    if (!this.settings.apiBaseUrl) throw new UserError("Set the HTTPS pairing URL first");
    return new CacaduuCloudClient({
      baseUrl: httpsUrl(this.settings.apiBaseUrl),
      agentVersion: this.deps.agentVersion,
      getToken: () => this.token(),
      fetch: (url, init) => (this.deps.fetch ?? fetch)(url, { ...init, redirect: "error" }),
      onBaseUrl: async (url) => {
        await this.persist({ ...this.settings, apiBaseUrl: httpsUrl(url) });
        this.deps.log("cloud_base_url_updated", { apiBaseUrl: this.settings.apiBaseUrl });
      },
    });
  }
  /** Every answer carries poll info: clock skew and minimum version warnings. */
  private observe(info: Partial<PollInfo>) {
    if (info.server_time) {
      const skew = Math.round((Date.parse(info.server_time) - this.clock.now()) / 1000);
      if (Number.isFinite(skew)) this.status.clockSkewSeconds = skew;
    }
    if (info.min_agent_version) this.status.minAgentVersion = info.min_agent_version;
  }
  /** Contract error handling shared by all calls: 401 forgets the token, 426 stops calling. */
  private async handleError(e: unknown) {
    if (e instanceof CloudApiError) {
      this.status.lastError = `HTTP ${e.status} ${e.code}`;
      if (e.status === 401) {
        const { tokenEncrypted: _t, ...rest } = this.settings;
        await this.persist(rest);
        this.status.pairAgain = true;
        this.cancelTimer();
        this.deps.log("cloud_unauthorized", { message: "Pair this computer again" });
      } else if (e.status === 426) {
        const min = typeof e.body.min_agent_version === "string" ? e.body.min_agent_version : "newer";
        await this.persist({ ...this.settings, updateRequired: min });
        this.cancelTimer();
        this.deps.log("cloud_update_required", { minAgentVersion: min });
      }
    } else this.status.lastError = "Network error";
  }
  async setUrl(url: unknown) {
    return this.serial(async () => {
      const next = httpsUrl(String(url ?? "").trim());
      if (this.paired && next !== this.settings.apiBaseUrl)
        throw new UserError("Forget local pairing before changing URL");
      await this.persist({ ...this.settings, apiBaseUrl: next });
      return { apiBaseUrl: next };
    });
  }
  async pair(code: unknown, name: unknown) {
    return this.serial(async () => {
      if (!secureAvailable(this.deps.cipher)) throw new UserError("OS secure storage unavailable");
      if (this.paired) throw new UserError("Already paired");
      const pairingCode = String(code ?? "").replace(/\s+/g, "").toUpperCase();
      if (!CODE.test(pairingCode)) throw new UserError("Invalid pairing code");
      const deviceName = String(name ?? "").trim();
      if (!deviceName || deviceName.length > 100) throw new UserError("Device name required");
      const response = await this.client().pair(pairingCode, deviceName, this.deps.os);
      this.observe(response);
      // Store the token (encrypted) before anything else uses it.
      await this.persist({
        ...this.settings,
        tokenEncrypted: this.deps.cipher.encryptString(response.device_token).toString("base64"),
        deviceId: response.device_id,
        shopName: response.shop.name,
        apiBaseUrl: httpsUrl(response.api_base_url || this.settings.apiBaseUrl),
        updateRequired: null,
        lastApplied: undefined,
        handledCommands: [],
      });
      this.status.pairAgain = false;
      this.failures = 0;
      this.deps.log("cloud_paired", { deviceId: response.device_id, shop: response.shop.name });
      this.schedule(response.next_poll_seconds * 1000);
      return { deviceId: response.device_id, shopName: response.shop.name };
    });
  }
  async remoteStatus() {
    try {
      const r = await this.client().status();
      this.observe(r);
      return { state: r.state, shopName: r.shop.name, lastSync: r.last_sync?.at ?? null };
    } catch (e) {
      await this.handleError(e);
      throw e;
    }
  }
  async rotate() {
    return this.serial(async () => {
      try {
        const r = await this.client().rotateCredentials();
        this.observe(r);
        await this.persist({
          ...this.settings,
          tokenEncrypted: this.deps.cipher.encryptString(r.device_token).toString("base64"),
        });
        this.deps.log("cloud_rotated", { oldTokenValidUntil: r.old_token_valid_until });
        return { rotated: true };
      } catch (e) {
        await this.handleError(e);
        throw e;
      }
    });
  }
  async forget() {
    return this.serial(async () => {
      this.cancelTimer();
      const { tokenEncrypted: _t, deviceId: _d, shopName: _s, lastApplied: _l, ...rest } = this.settings;
      await this.persist({ ...rest, handledCommands: [] });
      this.deps.log("cloud_forgotten_locally", {});
    });
  }
  // ---------------------------------------------------------------- heartbeat
  start() {
    this.stopped = false;
    if (this.paired && !this.settings.updateRequired) this.schedule(1000);
  }
  private cancelTimer() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.status.nextHeartbeatAt = null;
  }
  private schedule(ms: number) {
    this.cancelTimer();
    if (this.stopped || !this.paired || this.settings.updateRequired) return;
    const delay = Math.max(15000, Number.isFinite(ms) ? ms : 60000);
    this.status.nextHeartbeatAt = new Date(this.clock.now() + delay).toISOString();
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.heartbeat().catch(() => {});
    }, delay);
  }
  /** Contract backoff: 5 s · 2ⁿ ± 20 %, at most 5 minutes, unless Retry-After says otherwise. */
  backoff(retryAfterSeconds?: number | null) {
    if (retryAfterSeconds && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
    const base = Math.min(300000, 5000 * 2 ** Math.min(this.failures, 10));
    const jitter = 1 + ((this.deps.random ?? Math.random)() * 0.4 - 0.2);
    return Math.min(300000, Math.round(base * jitter));
  }
  heartbeat() {
    return this.serial(async () => {
      if (this.heartbeatRunning) throw new UserError("Heartbeat in progress");
      if (this.settings.updateRequired) throw new UserError("Update the agent before contacting CACADUU");
      this.heartbeatRunning = true;
      try {
        const read = this.deps.lastRead();
        const response = await this.client().heartbeat({
          os: this.deps.os,
          sourceLabel: read.sourceLabel?.slice(0, 80),
          lastRead: {
            result: read.result,
            at: read.at,
            error: read.error ? redactText(read.error).slice(0, 500) : null,
          },
        });
        this.observe(response);
        this.failures = 0;
        this.status.lastError = null;
        this.status.lastHeartbeatAt = new Date(this.clock.now()).toISOString();
        if (response.shop?.name && response.shop.name !== this.settings.shopName)
          await this.persist({ ...this.settings, shopName: response.shop.name });
        this.schedule(response.next_poll_seconds * 1000);
        if (Array.isArray(response.commands) && response.commands.length)
          void this.handleCommands(response.commands);
        return {
          state: "ok",
          shopName: response.shop?.name,
          nextPollSeconds: response.next_poll_seconds,
          clockSkewSeconds: this.status.clockSkewSeconds,
        };
      } catch (e) {
        await this.handleError(e);
        this.failures++;
        if (!(e instanceof CloudApiError) || e.retryable) this.schedule(this.backoff(e instanceof CloudApiError ? e.retryAfterSeconds : null));
        else if (e.status !== 401 && e.status !== 426) this.schedule(300000);
        throw e;
      } finally {
        this.heartbeatRunning = false;
      }
    });
  }
  // ---------------------------------------------------------------- phase B
  /** Builds the exact uncompressed snapshot bytes; content_hash is their SHA-256. */
  static snapshotBytes(snapshotId: string, sourceId: string, snapshot: NormalizedSnapshot) {
    const products: Product[] = snapshot.items.map((i) => ({
      source_code: i.sku,
      name: i.name,
      ...(i.ean ? { ean: i.ean } : {}),
      price: i.price,
      currency: i.currency,
      quantity: i.quantity,
      availability_status: i.availabilityStatus,
      warehouse: i.warehouse,
      source_updated_at: i.sourceUpdatedAt,
    }));
    const body: InventorySnapshot = {
      format: "cacaduu.inventory.v1",
      snapshot_id: snapshotId,
      source_id: sourceId,
      source_time: snapshot.sourceTime ?? snapshot.snapshotAt,
      products,
    };
    const bytes = Buffer.from(JSON.stringify(body), "utf8");
    return {
      bytes,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      productsHash: createHash("sha256").update(JSON.stringify(products)).digest("hex"),
      sourceTime: body.source_time,
      count: products.length,
    };
  }
  /**
   * Offers a verified, complete local export to CACADUU. Feature-flagged; 501 means "not yet available".
   * Local exports are already published before this runs and never depend on its outcome.
   */
  async offerSnapshot(
    sourceId: string,
    snapshotId: string,
    snapshot: NormalizedSnapshot,
    commandId: string | null = null,
  ): Promise<{ state: string; snapshotId?: string }> {
    if (!this.deps.features().snapshots || !this.paired) return { state: "disabled" };
    if (this.settings.updateRequired) return { state: "update_required" };
    if (!snapshot.complete || !snapshot.items.length) return { state: "incomplete" };
    const built = CloudAgent.snapshotBytes(snapshotId, sourceId, snapshot);
    const record = (state: string, extra: { snapshotId?: string; detail?: string } = {}) => {
      this.status.lastSnapshot = { at: new Date(this.clock.now()).toISOString(), state, ...extra };
      this.deps.log("cloud_snapshot_" + state, {
        sourceId,
        snapshotId: extra.snapshotId,
        count: built.count,
        ...(commandId ? { commandId } : {}),
        ...(extra.detail ? { detail: extra.detail } : {}),
      });
      return { state, snapshotId: extra.snapshotId };
    };
    const client = this.client();
    try {
      const last = this.settings.lastApplied;
      if (last && last.productsHash === built.productsHash) {
        try {
          await client.confirmUnchanged({ content_hash: last.contentHash, source_time: built.sourceTime, command_id: commandId });
          this.status.snapshots = "ok";
          if (commandId) this.commandUploads.set(commandId, { state: "confirmed", snapshot_id: last.snapshotId });
          return record("confirmed", { snapshotId: last.snapshotId });
        } catch (e) {
          if (!(e instanceof CloudApiError && e.status === 409 && e.code === "send_full_snapshot")) throw e;
        }
      }
      if (!commandId && this.clock.now() - this.lastFullUploadAt < SNAPSHOT_INTERVAL_MS)
        return record("deferred_rate_limit", { detail: "At most one full snapshot per 5 minutes" });
      let state = await client.createSnapshot({
        snapshot_id: snapshotId,
        source_id: sourceId,
        source_time: built.sourceTime,
        complete: true,
        product_count: built.count,
        content_hash: built.contentHash,
        command_id: commandId,
      });
      if (state.state === "awaiting_upload") {
        if (!state.upload_url || !/^https:\/\//.test(state.upload_url))
          throw new UserError("Cloud returned no HTTPS upload URL");
        await client.uploadSnapshot(state.upload_url, gzipSync(built.bytes));
        this.lastFullUploadAt = this.clock.now();
        state = await client.completeSnapshot(snapshotId);
      }
      const deadline = this.clock.now() + PROCESSING_LIMIT_MS;
      while (state.state === "processing" && this.clock.now() < deadline) {
        await new Promise((resolve) => this.clock.setTimeout(() => resolve(undefined), PROCESSING_POLL_MS));
        state = await client.getSnapshot(snapshotId);
      }
      this.status.snapshots = "ok";
      if (state.state === "applied" || state.state === "test_ok")
        await this.persist({
          ...this.settings,
          lastApplied: { snapshotId, contentHash: built.contentHash, productsHash: built.productsHash, sourceTime: built.sourceTime },
        });
      if (commandId) this.commandUploads.set(commandId, state);
      return record(state.state, {
        snapshotId,
        detail: state.reason ?? state.error ?? (state.result ? JSON.stringify(state.result) : undefined),
      });
    } catch (e) {
      if (isNotAvailable(e)) {
        this.status.snapshots = "not_yet_available";
        return record("not_yet_available");
      }
      await this.handleError(e);
      this.status.snapshots = "error";
      return record("failed", {
        detail: e instanceof CloudApiError ? `HTTP ${e.status} ${e.code}` : e instanceof UserError ? e.message : "Network error",
      });
    }
  }
  // ---------------------------------------------------------------- phase C
  private async remember(id: string) {
    const handled = [...(this.settings.handledCommands ?? []).filter((x) => x !== id), id].slice(-MAX_HANDLED);
    await this.persist({ ...this.settings, handledCommands: handled });
  }
  /** Only sync_inventory and ping are ever executed; everything else is logged and ignored. */
  async handleCommands(commands: Command[]) {
    if (!this.deps.features().commands || this.commandBusy) return;
    this.commandBusy = true;
    try {
      for (const command of commands) {
        if (!command || typeof command.id !== "string" || this.stopped) continue;
        if ((this.settings.handledCommands ?? []).includes(command.id)) continue;
        if (command.type !== "sync_inventory" && command.type !== "ping") {
          this.deps.log("cloud_command_ignored", { commandId: command.id, type: String(command.type).slice(0, 40) });
          await this.remember(command.id);
          continue;
        }
        if (command.expires_at && Date.parse(command.expires_at) <= this.clock.now()) {
          this.deps.log("cloud_command_expired", { commandId: command.id, type: command.type });
          await this.remember(command.id);
          continue;
        }
        await this.runCommand(command);
      }
    } finally {
      this.commandBusy = false;
    }
  }
  private async runCommand(command: Command) {
    const client = this.client();
    try {
      await client.claimCommand(command.id);
    } catch (e) {
      if (isNotAvailable(e)) {
        this.status.commands = "not_yet_available";
        this.deps.log("cloud_commands_not_available", {});
        return;
      }
      if (e instanceof CloudApiError && e.status === 409) {
        this.deps.log("cloud_command_already_claimed", { commandId: command.id });
        await this.remember(command.id);
        return;
      }
      await this.handleError(e);
      this.status.commands = "error";
      return;
    }
    // Claimed: from here on the command is never run again by this agent.
    await this.remember(command.id);
    this.status.commands = "ok";
    this.deps.log("cloud_command_claimed", { commandId: command.id, type: command.type });
    const report = async (result: Parameters<CacaduuCloudClient["reportCommand"]>[1]) => {
      try {
        await client.reportCommand(command.id, result);
      } catch (e) {
        await this.handleError(e);
        this.deps.log("cloud_command_report_failed", {
          commandId: command.id,
          detail: e instanceof CloudApiError ? `HTTP ${e.status} ${e.code}` : "Network error",
        });
      }
    };
    if (command.type === "ping") {
      await report({ state: "completed" });
      this.deps.log("cloud_command_completed", { commandId: command.id, type: "ping" });
      return;
    }
    await report({ state: "running" });
    let lease: unknown;
    const renew = () => {
      lease = this.clock.setTimeout(() => {
        void report({ state: "running" }).finally(renew);
      }, LEASE_RENEW_MS);
    };
    renew();
    try {
      this.activeCommandId = command.id;
      const result = await this.deps.runSyncCommand(command.id);
      const upload = this.commandUploads.get(command.id);
      this.commandUploads.delete(command.id);
      if (
        result.state === "ok" &&
        upload &&
        ["applied", "held", "confirmed"].includes(upload.state) &&
        upload.snapshot_id
      ) {
        await report({ state: "completed", snapshot_id: upload.snapshot_id });
        this.deps.log("cloud_command_completed", { commandId: command.id, snapshotId: upload.snapshot_id });
      } else {
        const reason = redactText(
          result.state !== "ok" ? result.message : `Snapshot not applied (${upload?.state ?? "not uploaded"})`,
        ).slice(0, 500);
        await report({ state: "failed", reason });
        this.deps.log("cloud_command_failed", { commandId: command.id, reason });
      }
    } catch (e) {
      const reason = e instanceof UserError ? e.message.slice(0, 500) : "Local inventory read failed";
      await report({ state: "failed", reason });
      this.deps.log("cloud_command_failed", { commandId: command.id, reason });
    } finally {
      this.activeCommandId = null;
      this.clock.clearTimeout(lease);
    }
  }
  async stop() {
    this.stopped = true;
    this.cancelTimer();
    await this.queue;
  }
}
