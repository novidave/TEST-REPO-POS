import { contextBridge, ipcRenderer } from "electron";
const desktop = {
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
