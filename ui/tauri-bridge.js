"use strict";
// Tauri shell bridge. Mirrors the fixed API that the Electron preload exposes as
// window.desktop and window.cacaduu. Inert outside Tauri: Electron's preload and
// the browser test mock define those objects themselves.
(() => {
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || window.desktop) return;
  const call = (channel, ...args) =>
    tauri.core.invoke("backend_call", { channel, args });
  const freeze = (value) => Object.freeze(value);
  Object.defineProperty(window, "desktop", {
    value: freeze({
      previewFile: (path) => call("desktop:preview-file", path),
      setGroupEnabled: (id, enabled) =>
        call("desktop:set-group-enabled", id, enabled),
      dismissJob: (id) => call("desktop:dismiss-job", id),
      export: (id) => call("desktop:export", id),
      chooseFile: () => tauri.core.invoke("choose_file"),
      snapshot: () => call("desktop:snapshot"),
      saveConnection: (value) => call("desktop:save-connection", value),
      testConnection: (id) => call("desktop:test-connection", id),
      saveGroup: (value) => call("desktop:save-group", value),
      sync: (id) => call("desktop:sync", id),
      inspect: (id) => call("desktop:inspect", id),
    }),
  });
  const channels = [
    "config",
    "url",
    "pair",
    "status",
    "heartbeat",
    "rotate",
    "unpair-local",
  ];
  Object.defineProperty(window, "cacaduu", {
    value: freeze(
      Object.fromEntries(
        channels.map((name) => [
          name,
          (...args) => call("cloud:" + name, ...args),
        ]),
      ),
    ),
  });
})();
