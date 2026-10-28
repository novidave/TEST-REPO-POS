import { contextBridge, ipcRenderer } from "electron";
const channels = ["cloud:config","cloud:url","cloud:pair","cloud:status","cloud:heartbeat","cloud:rotate","cloud:unpair-local"] as const;
contextBridge.exposeInMainWorld("cacaduu", Object.fromEntries(channels.map(name => [name.replace("cloud:", ""), (...args: unknown[]) => ipcRenderer.invoke(name, ...args)])));
