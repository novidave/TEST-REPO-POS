import { app, BrowserWindow, ipcMain, safeStorage, dialog } from "electron";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import {
  CacaduuCloudClient,
  CloudApiError,
} from "../docs/cloud-api/client/client";
import { CloudConnection } from "./cloud";
import { DesktopService } from "./desktop";
import {
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
let settings: Settings = { apiBaseUrl: process.env.CACADUU_PAIRING_URL || "" };
let service: DesktopService;
let win: BrowserWindow | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatInProgress = false;
let cloudOperations: Promise<unknown> = Promise.resolve();
let shuttingDown = false;
function enqueueCloud<T>(operation: () => T | Promise<T>): Promise<T> {
  if (shuttingDown)
    return Promise.reject(new UserError("Application is closing"));
  const result = cloudOperations.then(operation);
  cloudOperations = result.catch(() => {});
  return result;
}
const settingsPath = () => join(app.getPath("userData"), "cloud-settings.json");
const save = () => atomicJson(settingsPath(), settings);
function token(): string | null {
  if (!settings.tokenEncrypted) return null;
  if (!secureAvailable(safeStorage))
    throw new UserError("OS secure storage unavailable");
  return safeStorage.decryptString(
    Buffer.from(settings.tokenEncrypted, "base64"),
  );
}
async function storeToken(value: string) {
  if (!secureAvailable(safeStorage))
    throw new UserError("OS secure storage unavailable");
  const updated = {
    ...settings,
    tokenEncrypted: safeStorage.encryptString(value).toString("base64"),
  };
  await atomicJson(settingsPath(), updated);
  settings = updated;
}
function connection() {
  const client = new CacaduuCloudClient({
    baseUrl: httpsUrl(settings.apiBaseUrl),
    agentVersion: app.getVersion(),
    getToken: token,
    fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
    onBaseUrl: async (url) => {
      settings.apiBaseUrl = httpsUrl(url);
      await save();
    },
  });
  return new CloudConnection(
    client,
    process.env.CACADUU_ENABLE_SNAPSHOTS === "true",
    process.env.CACADUU_ENABLE_COMMANDS === "true",
  );
}
function scheduleHeartbeat(seconds: number) {
  clearTimeout(heartbeatTimer);
  if (settings.tokenEncrypted && !shuttingDown)
    heartbeatTimer = setTimeout(
      () => {
        enqueueCloud(heartbeat).catch(() => {});
      },
      Math.max(15, Number.isFinite(seconds) ? seconds : 60) * 1000,
    );
}
async function heartbeat() {
  if (heartbeatInProgress) throw new Error("Heartbeat in progress");
  heartbeatInProgress = true;
  try {
    const response = await connection().heartbeat(process.platform);
    scheduleHeartbeat(response.next_poll_seconds);
    return {
      state: "ok",
      shopName: response.shop.name,
      nextPollSeconds: response.next_poll_seconds,
    };
  } catch (e) {
    scheduleHeartbeat(
      e instanceof CloudApiError ? (e.retryAfterSeconds ?? 60) : 60,
    );
    throw e;
  } finally {
    heartbeatInProgress = false;
  }
}
function string(value: unknown, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid input");
  return value.trim();
}
async function setup() {
  try {
    settings = {
      ...settings,
      ...JSON.parse(await readFile(settingsPath(), "utf8")),
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Settings unreadable");
  }
  service = new DesktopService(
    app.getPath("userData"),
    new CredentialVault(
      join(app.getPath("userData"), "credentials.enc.json"),
      safeStorage,
    ),
  );
  const page = join(__dirname, "../../ui/index.html"),
    trustedUrl = pathToFileURL(page).href;
  function handle(channel: string, handler: (...args: unknown[]) => unknown) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (
        !win ||
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url !== trustedUrl
      )
        throw new Error("Untrusted IPC sender");
      try {
        if (channel.startsWith("cloud:")) {
          return await enqueueCloud(() => handler(...args));
        }
        return await handler(...args);
      } catch (e) {
        if (e instanceof CloudApiError) {
          const codes = [
            "invalid_code",
            "pairing_locked",
            "unauthorized",
            "rate_limited",
            "not_available",
            "device_revoked",
          ];
          throw new Error(
            `Cloud HTTP ${e.status}: ${codes.includes(e.code) ? e.code : "request_failed"}`,
          );
        }
        throw new Error(publicError(e));
      }
    });
  }
  handle("desktop:dismiss-job", (id) => service.dismissJob(string(id, 200)));
  handle("desktop:export", (id) => service.exportLocal(string(id, 200)));
  handle("desktop:choose-file", async () => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openFile"],
      filters: [{ name: "Inventory", extensions: ["csv", "xml", "json"] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle("desktop:snapshot", () => service.snapshot());
  handle("desktop:save-connection", (value) => service.saveConnection(value));
  handle("desktop:test-connection", (id) =>
    service.testConnection(string(id, 200)),
  );
  handle("desktop:set-group-enabled", (id, enabled) =>
    service.setGroupEnabled(string(id, 200), enabled),
  );
  handle("desktop:save-group", (value) => service.saveGroup(value));
  handle("desktop:sync", (id) => service.sync(string(id, 200)));
  handle("desktop:csv-headers", (path, format) =>
    service.csvHeaders(path, format),
  );
  handle("desktop:preview-file", (path, csvImport) =>
    service.previewFile(path, csvImport),
  );
  handle("desktop:inspect", (id) => service.inspect(string(id, 200)));
  handle("cloud:config", () => ({
    apiBaseUrl: settings.apiBaseUrl,
    paired: Boolean(settings.tokenEncrypted),
    shopName: settings.shopName,
    secureStorage: secureAvailable(safeStorage),
  }));
  handle("cloud:url", async (url) => {
    const next = httpsUrl(string(url));
    if (settings.tokenEncrypted && next !== settings.apiBaseUrl)
      throw new UserError("Forget local pairing before changing URL");
    settings.apiBaseUrl = next;
    await save();
  });
  handle("cloud:pair", async (code, name) => {
    if (!secureAvailable(safeStorage))
      throw new UserError("OS secure storage unavailable");
    if (settings.tokenEncrypted) throw new UserError("Already paired");
    const pairingCode = string(code, 20).toUpperCase();
    if (
      !/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-?[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/.test(
        pairingCode,
      )
    )
      throw new UserError("Invalid pairing code");
    const response = await connection().pair(
      pairingCode,
      string(name, 100),
      process.platform,
    );
    await storeToken(response.device_token);
    settings.deviceId = response.device_id;
    settings.shopName = response.shop.name;
    await save();
    scheduleHeartbeat(response.next_poll_seconds);
    return { deviceId: response.device_id, shopName: response.shop.name };
  });
  handle("cloud:status", async () => {
    const r = await connection().status();
    return {
      state: r.state,
      shopName: r.shop.name,
      lastSync: r.last_sync?.at ?? null,
    };
  });
  handle("cloud:heartbeat", heartbeat);
  handle("cloud:rotate", async () => {
    const r = await connection().rotate();
    await storeToken(r.device_token);
    return { rotated: true };
  });
  handle("cloud:unpair-local", async () => {
    clearTimeout(heartbeatTimer);
    delete settings.tokenEncrypted;
    delete settings.deviceId;
    delete settings.shopName;
    await save();
  });
  await service.restartSchedules();
  scheduleHeartbeat(60);
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  win.on("closed", () => {
    win = null;
  });
  await win.loadFile(page);
  win.show();
  if (process.argv.includes("--smoke-test")) {
    // Runs the real renderer, preload bridge and native SQLite under Electron's ABI.
    const result = await win.webContents.executeJavaScript(
      `(async()=>({title:document.title,nav:document.querySelectorAll('[data-page]').length,node:typeof window.require,snapshot:await window.desktop.snapshot()}))()`,
    );
    if (
      result.nav !== 7 ||
      result.node !== "undefined" ||
      !Array.isArray(result.snapshot.connections)
    )
      throw new Error("Desktop smoke check failed");
    console.log(
      "Electron smoke passed: seven views, isolated renderer, IPC and SQLite",
    );
    app.quit();
  }
}
if (process.env.NODE_ENV === "test" && process.env.CACADUU_TEST_PROFILE)
  app.setPath("userData", process.env.CACADUU_TEST_PROFILE);
if (process.argv.includes("--smoke-test"))
  app.setPath("userData", join(tmpdir(), "cacaduu-smoke-" + process.pid));
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on("second-instance", () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});
if (singleInstance)
  app
    .whenReady()
    .then(setup)
    .catch(() => {
      console.error(
        "Application startup failed; check native rebuild and user-data permissions",
      );
      app.exit(1);
    });
app.on("activate", () => {
  if (win) win.show();
});
app.on("window-all-closed", () => app.quit());
let quitting = false;
let quitReady = false;
app.on("before-quit", (event) => {
  clearTimeout(heartbeatTimer);
  shuttingDown = true;
  if (service && !quitReady) {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void Promise.all([service.close(), cloudOperations])
      .then(() => {
        quitReady = true;
        app.quit();
      })
      .catch(() => app.exit(1));
  }
});
