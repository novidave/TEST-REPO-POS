import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  dialog,
  Tray,
  Menu,
  nativeImage,
  shell,
} from "electron";
import { tmpdir, release, type } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { CloudApiError } from "../docs/cloud-api/client/client";
import { CloudAgent, type CloudSettings } from "./cloud-agent";
import { DesktopService } from "./desktop";
import { CredentialVault, atomicJson, publicError, UserError } from "./security";

let service: DesktopService;
let cloud: CloudAgent;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
const testMode =
  process.env.NODE_ENV === "test" || process.argv.includes("--smoke-test");
const launchedInBackground = process.argv.includes("--background");

const cloudSettingsPath = () =>
  join(app.getPath("userData"), "cloud-settings.json");
async function loadCloudSettings(): Promise<CloudSettings> {
  try {
    return JSON.parse(await readFile(cloudSettingsPath(), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Settings unreadable");
    return { apiBaseUrl: "" };
  }
}
function string(value: unknown, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new UserError("Invalid input");
  return value.trim();
}
const page = join(__dirname, "../../ui/index.html");
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
/** Windows/macOS login item. Never changed by automated tests. */
function applyLoginItem() {
  if (testMode || !["win32", "darwin"].includes(process.platform)) return;
  const s = service.settings.get();
  app.setLoginItemSettings({
    openAtLogin: s.openAtLogin,
    args: s.startInBackground ? ["--background"] : [],
  });
}
function loginItemState() {
  if (!["win32", "darwin"].includes(process.platform))
    return { supported: false, openAtLogin: false };
  return {
    supported: true,
    openAtLogin: testMode ? false : app.getLoginItemSettings().openAtLogin,
  };
}
function updateTray() {
  if (!tray) return;
  const paused = service.settings.get().schedulerPaused;
  const jobs = service.exports.jobs().filter((j) => j.enabled);
  const last = service.exports.lastSuccessful() as { finished_at?: string } | undefined;
  tray.setToolTip(
    `TEST-REPO-POS inventory agent\n${paused ? "Scheduled exports stopped" : `${jobs.length} scheduled export(s)`}` +
      (last?.finished_at ? `\nLast export ${new Date(last.finished_at).toLocaleString()}` : ""),
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open inventory agent", click: showWindow },
      {
        label: "Export all now",
        enabled: jobs.length > 0,
        click: () => {
          for (const job of jobs)
            void service.exportNow(job.connectionId).catch(() => {});
        },
      },
      {
        label: paused ? "Start scheduled exports" : "Stop scheduled exports",
        click: () => {
          service.setSchedulerPaused(!paused);
          updateTray();
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}
function createTray() {
  const headless =
    app.commandLine.getSwitchValue("ozone-platform") === "headless" ||
    (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
  // GTK cannot create a tray icon without a display; the window then closes the app as before.
  if (tray || headless || process.argv.includes("--smoke-test")) return;
  try {
    const icon = nativeImage.createFromPath(join(__dirname, "../../assets/tray.png"));
    tray = new Tray(icon);
    tray.on("click", showWindow);
    updateTray();
  } catch {
    // Some Linux desktops have no tray; the window then closes the app as before.
    tray = null;
  }
}
async function setup() {
  service = new DesktopService(
    app.getPath("userData"),
    new CredentialVault(
      join(app.getPath("userData"), "credentials.enc.json"),
      safeStorage,
    ),
  );
  cloud = new CloudAgent({
    load: loadCloudSettings,
    save: (s) => atomicJson(cloudSettingsPath(), s),
    cipher: safeStorage,
    agentVersion: app.getVersion(),
    os: `${type()} ${release()}`.slice(0, 80),
    features: () => {
      const s = service.settings.get();
      return {
        snapshots: s.cloudSnapshotsEnabled || process.env.CACADUU_ENABLE_SNAPSHOTS === "true",
        commands: s.cloudCommandsEnabled || process.env.CACADUU_ENABLE_COMMANDS === "true",
      };
    },
    lastRead: () => {
      const id = service.settings.get().cloudSourceConnectionId;
      const connection = service.connections().find((c) => c.id === id);
      const run = id
        ? (service.exports.history(1, id)[0] as
            | { state: string; finished_at: string | null; message: string | null }
            | undefined)
        : undefined;
      if (!connection || !run || run.state === "running") return { sourceLabel: connection?.name, result: "none" };
      return {
        sourceLabel: connection.name,
        result: run.state === "ok" ? "ok" : "error",
        at: run.finished_at ?? undefined,
        error: run.state === "ok" ? null : run.message,
      };
    },
    runSyncCommand: async () => {
      const id = service.settings.get().cloudSourceConnectionId;
      if (!id) return { state: "failed", message: "No cloud source connection is configured in the agent" };
      return service.exports.runNow(id, "cloud_command");
    },
    log: (event, detail) => service.log(event, detail),
  });
  await cloud.init(process.env.CACADUU_PAIRING_URL || "");
  service.onExportPublished = async (connectionId, snapshot, result, trigger) => {
    if (service.settings.get().cloudSourceConnectionId !== connectionId) return;
    const upload = cloud.offerSnapshot(
      connectionId,
      result.snapshotId,
      snapshot,
      trigger === "cloud_command" ? cloud.activeCommandId : null,
    );
    // A Sync Now command needs the outcome; ordinary exports never wait for the optional cloud.
    if (trigger === "cloud_command") await upload;
    else void upload.catch(() => {});
  };
  const trustedUrl = pathToFileURL(page).href;
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
        const result = await handler(...args);
        if (!channel.startsWith("desktop:snapshot")) updateTray();
        return result;
      } catch (e) {
        if (e instanceof CloudApiError) {
          const codes = [
            "invalid_code",
            "pairing_locked",
            "unauthorized",
            "rate_limited",
            "not_available",
            "device_revoked",
            "update_required",
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
  handle("desktop:choose-folder", async () => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle("desktop:snapshot", () => ({
    ...service.snapshot(),
    app: { version: app.getVersion(), platform: process.platform, loginItem: loginItemState(), tray: Boolean(tray) },
  }));
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
  handle("desktop:save-export-job", (value) => service.saveExportJob(value));
  handle("desktop:export-now", (id, allowShrink) =>
    service.exportNow(string(id, 200), allowShrink),
  );
  handle("desktop:set-scheduler-paused", (paused) =>
    service.setSchedulerPaused(paused),
  );
  handle("desktop:update-settings", (value) => {
    const settings = service.updateSettings(value);
    applyLoginItem();
    return settings;
  });
  handle("desktop:preview-normalized", (id) =>
    service.previewNormalized(string(id, 200)),
  );
  handle("desktop:products", (id) =>
    service.products(id === undefined || id === null ? undefined : string(id, 200)),
  );
  handle("desktop:open-export-folder", async (id) => {
    const job = service.exports.jobs().find((j) => j.connectionId === string(id, 200));
    const directory = job?.effectiveDirectory ?? join(service.exportRoot(), string(id, 200));
    const error = await shell.openPath(directory);
    if (error) throw new UserError("Export folder not available yet");
  });
  handle("desktop:mapping-export", async () => {
    const result = await dialog.showSaveDialog(win!, {
      defaultPath: "test-repo-pos-mapping.json",
      filters: [{ name: "Mapping configuration", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return null;
    await writeFile(result.filePath, JSON.stringify(service.mappingConfig(), null, 2) + "\n");
    return { path: result.filePath };
  });
  handle("desktop:mapping-import", async () => {
    const result = await dialog.showOpenDialog(win!, {
      properties: ["openFile"],
      filters: [{ name: "Mapping configuration", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    let parsed: unknown;
    try {
      const text = await readFile(result.filePaths[0], "utf8");
      if (text.length > 4 * 1024 * 1024) throw new Error();
      parsed = JSON.parse(text);
    } catch {
      throw new UserError("Mapping file is not valid JSON");
    }
    return service.importMappingConfig(parsed);
  });
  handle("cloud:config", () => cloud.config());
  handle("cloud:url", (url) => cloud.setUrl(url));
  handle("cloud:pair", (code, name) => cloud.pair(code, name));
  handle("cloud:status", () => cloud.remoteStatus());
  handle("cloud:heartbeat", () => cloud.heartbeat());
  handle("cloud:rotate", () => cloud.rotate());
  handle("cloud:unpair-local", () => cloud.forget());
  await service.restartSchedules();
  cloud.start();
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: "TEST-REPO-POS — Universal POS & Inventory Sync Agent",
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
  createTray();
  // Close-to-tray: schedules keep running in the background until Quit.
  win.on("close", (event) => {
    if (!quitting && tray && service.settings.get().closeToTray) {
      event.preventDefault();
      win?.hide();
    }
  });
  win.on("closed", () => {
    win = null;
  });
  await win.loadFile(page);
  applyLoginItem();
  const s = service.settings.get();
  if (!(launchedInBackground && s.startInBackground && tray)) win.show();
  if (process.argv.includes("--smoke-test")) {
    // Runs the real renderer, preload bridge and native SQLite under Electron's ABI.
    const result = await win.webContents.executeJavaScript(
      `(async()=>({title:document.title,nav:document.querySelectorAll('[data-page]').length,node:typeof window.require,snapshot:await window.desktop.snapshot()}))()`,
    );
    if (
      result.nav !== 7 ||
      result.node !== "undefined" ||
      !Array.isArray(result.snapshot.connections) ||
      !Array.isArray(result.snapshot.exportJobs)
    )
      throw new Error("Desktop smoke check failed");
    console.log(
      "Electron smoke passed: seven views, isolated renderer, IPC, export scheduler and SQLite",
    );
    app.quit();
  }
}
if (process.env.NODE_ENV === "test" && process.env.CACADUU_TEST_PROFILE)
  app.setPath("userData", process.env.CACADUU_TEST_PROFILE);
if (process.argv.includes("--smoke-test"))
  app.setPath("userData", join(tmpdir(), "cacaduu-smoke-" + process.pid));
// One agent per Windows profile: a second launch (e.g. login item + manual start) focuses the first.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
app.on("second-instance", (_event, argv) => {
  if (!argv.includes("--background")) showWindow();
});
if (singleInstance)
  app
    .whenReady()
    .then(setup)
    .catch((error) => {
      console.error(
        "Application startup failed; check native rebuild and user-data permissions",
      );
      if (testMode) console.error(error);
      app.exit(1);
    });
app.on("activate", showWindow);
app.on("window-all-closed", () => {
  if (!tray || !service?.settings.get().closeToTray) app.quit();
});
let quitReady = false;
let quitStarted = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (service && !quitReady) {
    event.preventDefault();
    if (quitStarted) return;
    quitStarted = true;
    void Promise.all([cloud?.stop(), service.close()])
      .then(() => {
        quitReady = true;
        tray?.destroy();
        app.quit();
      })
      .catch(() => app.exit(1));
  }
});
