//! Tauri shell for CACADUU Inventory Sync.
//!
//! The inventory engine (SQLite store, adapters, scheduler, cloud client) stays in
//! TypeScript and runs as a Node sidecar (`dist/src/sidecar.js`). This shell owns
//! the window, native dialogs, the single-instance lock and the OS credential
//! store, and forwards a fixed set of channels to the sidecar over stdio.

mod sidecar;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, RunEvent, State, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

use sidecar::Sidecar;

/// Channels the dashboard may forward; mirrors `BACKEND_CHANNELS` in src/backend.ts.
const CHANNELS: &[&str] = &[
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
];

const KEYRING_SERVICE: &str = "com.cacaduu.inventory";
const KEYRING_ACCOUNT: &str = "credential-master-key";
/// How long shutdown waits for active syncs, exports and cloud calls to settle.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(60);

const SMOKE_SCRIPT: &str = r#"(async () => {
  const report = (ok, detail) =>
    window.__TAURI__.core.invoke("smoke_result", { ok, detail });
  try {
    const snapshot = await window.desktop.snapshot();
    const nav = document.querySelectorAll("[data-page]").length;
    const node = typeof window.require;
    const ok = nav === 7 && node === "undefined" && Array.isArray(snapshot.connections);
    await report(ok, JSON.stringify({ title: document.title, nav, node, connections: snapshot.connections.length }));
  } catch (e) {
    await report(false, String(e && e.message || e));
  }
})();"#;

struct SmokeMode(bool);

#[tauri::command]
async fn backend_call(
    channel: String,
    args: Vec<Value>,
    backend: State<'_, Arc<Sidecar>>,
) -> Result<Value, String> {
    if !CHANNELS.contains(&channel.as_str()) || args.len() > 4 {
        return Err("Untrusted IPC request".into());
    }
    let backend = Arc::clone(&backend);
    backend.call(&channel, args).await
}

#[tauri::command]
async fn choose_file(app: AppHandle) -> Result<Option<String>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .add_filter("Inventory", &["csv", "xml", "json"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_file())
        .await
        .map_err(|_| "Operation failed".to_string())?;
    Ok(picked
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
fn smoke_result(app: AppHandle, smoke: State<'_, SmokeMode>, ok: bool, detail: String) {
    if !smoke.0 {
        return;
    }
    if ok {
        println!("Tauri smoke passed: seven views, isolated webview, IPC, Node sidecar and SQLite {detail}");
        app.exit(0);
    } else {
        eprintln!("Tauri smoke failed: {detail}");
        app.exit(1);
    }
}

/// Returns the base64 32-byte master key from the OS credential store, creating it
/// on first run. Any store error other than "no entry" yields `None` so an existing
/// key is never overwritten; the backend then refuses to store credentials.
fn master_key() -> Option<String> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).ok()?;
    let valid = |v: &str| b64.decode(v).map(|k| k.len() == 32).unwrap_or(false);
    match entry.get_password() {
        Ok(existing) if valid(&existing) => Some(existing),
        Ok(_) => {
            eprintln!("Credential master key in OS store is malformed; secure storage disabled");
            None
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0u8; 32];
            getrandom::fill(&mut key).ok()?;
            let encoded = b64.encode(key);
            entry.set_password(&encoded).ok()?;
            // Read back so a store that silently drops writes is not trusted.
            match entry.get_password() {
                Ok(stored) if stored == encoded => Some(encoded),
                _ => None,
            }
        }
        Err(_) => None,
    }
}

fn node_binary() -> PathBuf {
    if let Some(path) = std::env::var_os("CACADUU_NODE") {
        return PathBuf::from(path);
    }
    // `externalBin` places the bundled runtime beside the executable. A distinct
    // name keeps Linux packages from installing over a system /usr/bin/node.
    let bundled = if cfg!(windows) {
        "cacaduu-node.exe"
    } else {
        "cacaduu-node"
    };
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
    {
        let path = dir.join(bundled);
        if path.is_file() {
            return path;
        }
    }
    // Development fallback: Node from PATH.
    PathBuf::from(if cfg!(windows) { "node.exe" } else { "node" })
}

fn user_data(app: &AppHandle, smoke: bool) -> Result<PathBuf, String> {
    if smoke {
        return Ok(std::env::temp_dir().join(format!("cacaduu-tauri-smoke-{}", std::process::id())));
    }
    if std::env::var("NODE_ENV").as_deref() == Ok("test") {
        if let Some(profile) = std::env::var_os("CACADUU_TEST_PROFILE") {
            return Ok(PathBuf::from(profile));
        }
    }
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn trusted_url(url: &Url) -> bool {
    // Bundled assets are served from tauri://localhost (macOS/Linux) or
    // http(s)://tauri.localhost (Windows). Everything else is refused.
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

pub fn run() {
    let smoke = std::env::args().any(|a| a == "--smoke-test");
    let exiting = Arc::new(AtomicBool::new(false));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(SmokeMode(smoke))
        .invoke_handler(tauri::generate_handler![
            backend_call,
            choose_file,
            smoke_result
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let data_dir = user_data(&handle, smoke)?;
            std::fs::create_dir_all(&data_dir)?;
            let script = app
                .path()
                .resource_dir()?
                .join("backend")
                .join("dist")
                .join("src")
                .join("sidecar.js");
            let key = if smoke { None } else { master_key() };
            let backend = Sidecar::spawn(
                &node_binary(),
                &script,
                &data_dir,
                &app.package_info().version.to_string(),
                key,
            )
            .map_err(|e| format!("Application startup failed: {e}"))?;
            app.manage(backend);

            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("CACADUU Inventory Sync")
                .inner_size(1280.0, 860.0)
                .min_inner_size(900.0, 640.0)
                .on_navigation(trusted_url)
                .on_page_load(move |webview, payload| {
                    if smoke && matches!(payload.event(), PageLoadEvent::Finished) {
                        let _ = webview.eval(SMOKE_SCRIPT);
                    }
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building CACADUU Inventory");

    app.run(move |handle, event| match event {
        // Let active syncs, exports and SQLite writes settle before exiting.
        RunEvent::ExitRequested { .. } | RunEvent::Exit
            if !exiting.swap(true, Ordering::SeqCst) =>
        {
            if let Some(backend) = handle.try_state::<Arc<Sidecar>>() {
                backend.shutdown(SHUTDOWN_GRACE);
            }
        }
        _ => {}
    });
}
