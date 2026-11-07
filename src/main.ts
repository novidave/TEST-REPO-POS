import { app, BrowserWindow, ipcMain, safeStorage, dialog } from "electron";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Backend, BACKEND_CHANNELS, backendError } from "./backend";
let backend: Backend | undefined;
let win: BrowserWindow | null = null;
async function setup() {
  backend = await Backend.open({
    userData: app.getPath("userData"),
    cipher: safeStorage,
    version: app.getVersion(),
    pairingUrl: process.env.CACADUU_PAIRING_URL,
    enableSnapshots: process.env.CACADUU_ENABLE_SNAPSHOTS === "true",
    enableCommands: process.env.CACADUU_ENABLE_COMMANDS === "true",
  });
  const page = join(__dirname, "../../ui/index.html"),
    trustedUrl = pathToFileURL(page).href;
  function trusted(event: Electron.IpcMainInvokeEvent) {
    if (
      !win ||
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      event.senderFrame.url !== trustedUrl
    )
      throw new Error("Untrusted IPC sender");
  }
  for (const channel of BACKEND_CHANNELS)
    ipcMain.handle(channel, async (event, ...args) => {
      trusted(event);
      return backend!.call(channel, args);
    });
  ipcMain.handle("desktop:choose-file", async (event) => {
    trusted(event);
    try {
      const result = await dialog.showOpenDialog(win!, {
        properties: ["openFile"],
        filters: [{ name: "Inventory", extensions: ["csv", "xml", "json"] }],
      });
      return result.canceled ? null : result.filePaths[0];
    } catch (e) {
      throw backendError(e);
    }
  });
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
  if (backend && !quitReady) {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void backend
      .close()
      .then(() => {
        quitReady = true;
        app.quit();
      })
      .catch(() => app.exit(1));
  }
});
