import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { CacaduuCloudClient } from "../docs/cloud-api/client/client";
import { CloudConnection } from "./cloud";

interface Settings { apiBaseUrl: string; tokenEncrypted?: string; deviceId?: string; shopName?: string; }
const defaultUrl = process.env.CACADUU_PAIRING_URL || "";
let settings: Settings = { apiBaseUrl: defaultUrl };
const settingsPath = () => join(app.getPath("userData"), "cloud-settings.json");
async function save() { await writeFile(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 }); }
async function load() { try { settings = { ...settings, ...JSON.parse(await readFile(settingsPath(), "utf8")) }; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } }
function token(): string | null { if (!settings.tokenEncrypted) return null; if (!safeStorage.isEncryptionAvailable()) throw new Error("OS secure storage is unavailable"); return safeStorage.decryptString(Buffer.from(settings.tokenEncrypted, "base64")); }
async function storeToken(value: string) { if (!safeStorage.isEncryptionAvailable()) throw new Error("OS secure storage is unavailable"); settings.tokenEncrypted = safeStorage.encryptString(value).toString("base64"); await save(); }
function connection() { if (!settings.apiBaseUrl || !settings.apiBaseUrl.startsWith("https://")) throw new Error("Configure an HTTPS pairing URL"); const client = new CacaduuCloudClient({ baseUrl: settings.apiBaseUrl, agentVersion: app.getVersion(), getToken: token, onBaseUrl: async url => { settings.apiBaseUrl = url; await save(); } }); return new CloudConnection(client, process.env.CACADUU_ENABLE_SNAPSHOTS === "true", process.env.CACADUU_ENABLE_COMMANDS === "true"); }
async function setup() {
  await load();
  ipcMain.handle("cloud:config", () => ({ apiBaseUrl: settings.apiBaseUrl, paired: Boolean(settings.tokenEncrypted), shopName: settings.shopName }));
  ipcMain.handle("cloud:url", async (_e, url: string) => { if (!/^https:\/\/[^\s]+$/.test(url)) throw new Error("HTTPS URL required"); settings.apiBaseUrl = url.replace(/\/+$/, ""); await save(); });
  ipcMain.handle("cloud:pair", async (_e, code: string, name: string) => { const response = await connection().pair(code, name, process.platform); await storeToken(response.device_token); settings.deviceId = response.device_id; settings.shopName = response.shop.name; await save(); return { deviceId: response.device_id, shopName: response.shop.name }; });
  ipcMain.handle("cloud:status", async () => connection().status());
  ipcMain.handle("cloud:heartbeat", async () => connection().heartbeat(process.platform));
  ipcMain.handle("cloud:rotate", async () => { const result = await connection().rotate(); await storeToken(result.device_token); return { rotated: true }; });
  ipcMain.handle("cloud:unpair-local", async () => { delete settings.tokenEncrypted; delete settings.deviceId; delete settings.shopName; await save(); });
  const win = new BrowserWindow({ width: 1080, height: 760, webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await win.loadFile(join(__dirname, "../../ui/index.html"));
}
app.whenReady().then(setup).catch(console.error);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
