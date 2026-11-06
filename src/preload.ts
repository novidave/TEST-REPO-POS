import { contextBridge, ipcRenderer } from "electron";
const desktop = {
  csvHeaders: (path: string, format: unknown) =>
    ipcRenderer.invoke("desktop:csv-headers", path, format),
  previewFile: (path: string, csvImport?: unknown) =>
    ipcRenderer.invoke("desktop:preview-file", path, csvImport),
  setGroupEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke("desktop:set-group-enabled", id, enabled),
  dismissJob: (id: string) => ipcRenderer.invoke("desktop:dismiss-job", id),
  export: (id: string) => ipcRenderer.invoke("desktop:export", id),
  chooseFile: () => ipcRenderer.invoke("desktop:choose-file"),
  snapshot: () => ipcRenderer.invoke("desktop:snapshot"),
  saveConnection: (value: unknown) =>
    ipcRenderer.invoke("desktop:save-connection", value),
  testConnection: (id: string) =>
    ipcRenderer.invoke("desktop:test-connection", id),
  saveGroup: (value: unknown) =>
    ipcRenderer.invoke("desktop:save-group", value),
  sync: (id: string) => ipcRenderer.invoke("desktop:sync", id),
  inspect: (id: string) => ipcRenderer.invoke("desktop:inspect", id),
  chooseFolder: () => ipcRenderer.invoke("desktop:choose-folder"),
  saveExportJob: (value: unknown) =>
    ipcRenderer.invoke("desktop:save-export-job", value),
  exportNow: (id: string, allowShrink?: boolean) =>
    ipcRenderer.invoke("desktop:export-now", id, allowShrink === true),
  setSchedulerPaused: (paused: boolean) =>
    ipcRenderer.invoke("desktop:set-scheduler-paused", paused),
  updateSettings: (value: unknown) =>
    ipcRenderer.invoke("desktop:update-settings", value),
  previewNormalized: (id: string) =>
    ipcRenderer.invoke("desktop:preview-normalized", id),
  products: (id?: string) => ipcRenderer.invoke("desktop:products", id ?? null),
  openExportFolder: (id: string) =>
    ipcRenderer.invoke("desktop:open-export-folder", id),
  exportMapping: () => ipcRenderer.invoke("desktop:mapping-export"),
  localInventory: () => ipcRenderer.invoke("desktop:local-inventory"),
  localSaveProduct: (value: unknown) =>
    ipcRenderer.invoke("desktop:local-save-product", value),
  localAdjust: (value: unknown) =>
    ipcRenderer.invoke("desktop:local-adjust", value),
  localImport: (path: string) =>
    ipcRenderer.invoke("desktop:local-import", path),
  localLookup: (code: string) =>
    ipcRenderer.invoke("desktop:local-lookup", code),
  importMapping: () => ipcRenderer.invoke("desktop:mapping-import"),
};
contextBridge.exposeInMainWorld("desktop", desktop);
const channels = [
  "config",
  "url",
  "pair",
  "status",
  "heartbeat",
  "rotate",
  "unpair-local",
] as const;
contextBridge.exposeInMainWorld(
  "cacaduu",
  Object.fromEntries(
    channels.map((name) => [
      name,
      (...args: unknown[]) => ipcRenderer.invoke("cloud:" + name, ...args),
    ]),
  ),
);
