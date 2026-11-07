fn main() {
    // Declaring the app's own commands makes them deny-by-default: the webview may
    // call only those granted in capabilities/default.json.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["backend_call", "choose_file", "smoke_result"]),
    ))
    .expect("failed to run tauri-build");
}
