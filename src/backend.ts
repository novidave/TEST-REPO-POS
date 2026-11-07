/**
 * Shell-independent application backend.
 *
 * The Electron main process and the Tauri sidecar both host this module. It owns
 * the desktop service, cloud pairing settings and heartbeat schedule, and exposes a
 * fixed table of channel handlers. Shells are responsible only for transport,
 * sender verification, native dialogs and the OS-backed cipher.
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  CacaduuCloudClient,
  CloudApiError,
} from "../docs/cloud-api/client/client";
import { CloudConnection } from "./cloud";
import { DesktopService } from "./desktop";
import {
  Cipher,
  CredentialVault,
  atomicJson,
  httpsUrl,
  publicError,
  secureAvailable,
  UserError,
} from "./security";

interface Settings {
  apiBaseUrl: string;
  tokenEncrypted?: string;
  deviceId?: string;
  shopName?: string;
}

export interface BackendOptions {
  userData: string;
  cipher: Cipher;
  version: string;
  platform?: string;
  pairingUrl?: string;
  enableSnapshots?: boolean;
  enableCommands?: boolean;
}

export type Handler = (...args: unknown[]) => unknown;

/** Channels a shell may forward. Anything else is refused before dispatch. */
export const BACKEND_CHANNELS = [
  "desktop:dismiss-job",
  "desktop:export",
  "desktop:snapshot",
  "desktop:save-connection",
  "desktop:test-connection",
  "desktop:set-group-enabled",
  "desktop:save-group",
  "desktop:sync",
  "desktop:preview-file",
  "desktop:inspect",
  "cloud:config",
  "cloud:url",
  "cloud:pair",
  "cloud:status",
  "cloud:heartbeat",
  "cloud:rotate",
  "cloud:unpair-local",
] as const;

const PUBLIC_CLOUD_CODES = [
  "invalid_code",
  "pairing_locked",
  "unauthorized",
  "rate_limited",
  "not_available",
  "device_revoked",
];

function string(value: unknown, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid input");
  return value.trim();
}

/** Only controlled messages leave the backend. */
export function backendError(e: unknown): Error {
  if (e instanceof CloudApiError)
    return new Error(
      `Cloud HTTP ${e.status}: ${PUBLIC_CLOUD_CODES.includes(e.code) ? e.code : "request_failed"}`,
    );
  return new Error(publicError(e));
}

export class Backend {
  readonly service: DesktopService;
  private settings: Settings;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatInProgress = false;
  private cloudOperations: Promise<unknown> = Promise.resolve();
  private shuttingDown = false;
  private closed: Promise<void> | undefined;
  private readonly handlers: Map<string, Handler>;

  private constructor(
    private readonly options: BackendOptions,
    settings: Settings,
  ) {
    this.settings = settings;
    this.service = new DesktopService(
      options.userData,
      new CredentialVault(
        join(options.userData, "credentials.enc.json"),
        options.cipher,
      ),
    );
    this.handlers = this.buildHandlers();
  }

  static async open(options: BackendOptions): Promise<Backend> {
    let settings: Settings = { apiBaseUrl: options.pairingUrl || "" };
    try {
      settings = {
        ...settings,
        ...JSON.parse(
          await readFile(join(options.userData, "cloud-settings.json"), "utf8"),
        ),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Settings unreadable");
    }
    const backend = new Backend(options, settings);
    await backend.service.restartSchedules();
    backend.scheduleHeartbeat(60);
    return backend;
  }

  /** Dispatches a channel call. Errors are reduced to public messages. */
  async call(channel: string, args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error("Unknown channel");
    try {
      if (channel.startsWith("cloud:"))
        return await this.enqueueCloud(() => handler(...args));
      return await handler(...args);
    } catch (e) {
      throw backendError(e);
    }
  }

  /** Stops the heartbeat and waits for active syncs, exports and cloud calls. */
  close(): Promise<void> {
    if (!this.closed) {
      clearTimeout(this.heartbeatTimer);
      this.shuttingDown = true;
      this.closed = Promise.all([
        this.service.close(),
        this.cloudOperations,
      ]).then(() => {});
    }
    return this.closed;
  }

  private get platform() {
    return this.options.platform ?? process.platform;
  }

  private enqueueCloud<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.shuttingDown)
      return Promise.reject(new UserError("Application is closing"));
    const result = this.cloudOperations.then(operation);
    this.cloudOperations = result.catch(() => {});
    return result;
  }

  private settingsPath() {
    return join(this.options.userData, "cloud-settings.json");
  }

  private save() {
    return atomicJson(this.settingsPath(), this.settings);
  }

  private secure() {
    return secureAvailable(this.options.cipher);
  }

  private token(): string | null {
    if (!this.settings.tokenEncrypted) return null;
    if (!this.secure()) throw new UserError("OS secure storage unavailable");
    return this.options.cipher.decryptString(
      Buffer.from(this.settings.tokenEncrypted, "base64"),
    );
  }

  private async storeToken(value: string) {
    if (!this.secure()) throw new UserError("OS secure storage unavailable");
    const updated = {
      ...this.settings,
      tokenEncrypted: this.options.cipher
        .encryptString(value)
        .toString("base64"),
    };
    await atomicJson(this.settingsPath(), updated);
    this.settings = updated;
  }

  private connection() {
    const client = new CacaduuCloudClient({
      baseUrl: httpsUrl(this.settings.apiBaseUrl),
      agentVersion: this.options.version,
      getToken: () => this.token(),
      fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
      onBaseUrl: async (url) => {
        this.settings.apiBaseUrl = httpsUrl(url);
        await this.save();
      },
    });
    return new CloudConnection(
      client,
      Boolean(this.options.enableSnapshots),
      Boolean(this.options.enableCommands),
    );
  }

  private scheduleHeartbeat(seconds: number) {
    clearTimeout(this.heartbeatTimer);
    if (this.settings.tokenEncrypted && !this.shuttingDown)
      this.heartbeatTimer = setTimeout(
        () => {
          this.enqueueCloud(() => this.heartbeat()).catch(() => {});
        },
        Math.max(15, Number.isFinite(seconds) ? seconds : 60) * 1000,
      );
  }

  private async heartbeat() {
    if (this.heartbeatInProgress) throw new Error("Heartbeat in progress");
    this.heartbeatInProgress = true;
    try {
      const response = await this.connection().heartbeat(this.platform);
      this.scheduleHeartbeat(response.next_poll_seconds);
      return {
        state: "ok",
        shopName: response.shop.name,
        nextPollSeconds: response.next_poll_seconds,
      };
    } catch (e) {
      this.scheduleHeartbeat(
        e instanceof CloudApiError ? (e.retryAfterSeconds ?? 60) : 60,
      );
      throw e;
    } finally {
      this.heartbeatInProgress = false;
    }
  }

  private buildHandlers(): Map<string, Handler> {
    const service = this.service;
    const table: Record<(typeof BACKEND_CHANNELS)[number], Handler> = {
      "desktop:dismiss-job": (id) => service.dismissJob(string(id, 200)),
      "desktop:export": (id) => service.exportLocal(string(id, 200)),
      "desktop:snapshot": () => service.snapshot(),
      "desktop:save-connection": (value) => service.saveConnection(value),
      "desktop:test-connection": (id) =>
        service.testConnection(string(id, 200)),
      "desktop:set-group-enabled": (id, enabled) =>
        service.setGroupEnabled(string(id, 200), enabled),
      "desktop:save-group": (value) => service.saveGroup(value),
      "desktop:sync": (id) => service.sync(string(id, 200)),
      "desktop:preview-file": (path) => service.previewFile(path),
      "desktop:inspect": (id) => service.inspect(string(id, 200)),
      "cloud:config": () => ({
        apiBaseUrl: this.settings.apiBaseUrl,
        paired: Boolean(this.settings.tokenEncrypted),
        shopName: this.settings.shopName,
        secureStorage: this.secure(),
      }),
      "cloud:url": async (url) => {
        const next = httpsUrl(string(url));
        if (this.settings.tokenEncrypted && next !== this.settings.apiBaseUrl)
          throw new UserError("Forget local pairing before changing URL");
        this.settings.apiBaseUrl = next;
        await this.save();
      },
      "cloud:pair": async (code, name) => {
        if (!this.secure())
          throw new UserError("OS secure storage unavailable");
        if (this.settings.tokenEncrypted) throw new UserError("Already paired");
        const pairingCode = string(code, 20).toUpperCase();
        if (
          !/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-?[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(
            pairingCode,
          )
        )
          throw new UserError("Invalid pairing code");
        const response = await this.connection().pair(
          pairingCode,
          string(name, 100),
          this.platform,
        );
        await this.storeToken(response.device_token);
        this.settings.deviceId = response.device_id;
        this.settings.shopName = response.shop.name;
        await this.save();
        this.scheduleHeartbeat(response.next_poll_seconds);
        return { deviceId: response.device_id, shopName: response.shop.name };
      },
      "cloud:status": async () => {
        const r = await this.connection().status();
        return {
          state: r.state,
          shopName: r.shop.name,
          lastSync: r.last_sync?.at ?? null,
        };
      },
      "cloud:heartbeat": () => this.heartbeat(),
      "cloud:rotate": async () => {
        const r = await this.connection().rotate();
        await this.storeToken(r.device_token);
        return { rotated: true };
      },
      "cloud:unpair-local": async () => {
        clearTimeout(this.heartbeatTimer);
        delete this.settings.tokenEncrypted;
        delete this.settings.deviceId;
        delete this.settings.shopName;
        await this.save();
      },
    };
    return new Map(Object.entries(table));
  }
}
