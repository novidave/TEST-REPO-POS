//! Supervises the Node backend process and multiplexes calls over its stdio.
//! Protocol: newline-delimited JSON, documented in src/sidecar.ts.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;

pub struct Sidecar {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    exited: Mutex<Option<mpsc::Receiver<()>>>,
}

const UNAVAILABLE: &str = "Backend unavailable; restart the application";

impl Sidecar {
    pub fn spawn(
        node: &Path,
        script: &Path,
        user_data: &Path,
        version: &str,
        key: Option<String>,
    ) -> Result<Arc<Self>, String> {
        if !script.is_file() {
            return Err(format!("backend script missing at {}", script.display()));
        }
        let mut command = Command::new(node);
        command
            .arg(script)
            .current_dir(script.parent().unwrap_or(Path::new(".")))
            // Ignore user-level Node injection points; the backend is self-contained.
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("cannot start Node runtime {}: {e}", node.display()))?;
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;

        // The master key travels only over the private pipe, never argv or env.
        let init = json!({
            "type": "init",
            "userData": user_data.to_string_lossy(),
            "version": version,
            "key": key,
        });
        writeln!(stdin, "{init}").map_err(|e| e.to_string())?;
        stdin.flush().map_err(|e| e.to_string())?;

        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Reply>>>> = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let (exit_tx, exit_rx) = mpsc::channel();
        {
            let pending = Arc::clone(&pending);
            let alive = Arc::clone(&alive);
            std::thread::Builder::new()
                .name("backend-reader".into())
                .spawn(move || {
                    for line in BufReader::new(stdout).lines() {
                        let Ok(line) = line else { break };
                        let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                            continue;
                        };
                        match frame["type"].as_str() {
                            Some("result") => {
                                let Some(id) = frame["id"].as_u64() else {
                                    continue;
                                };
                                let reply = if frame["ok"].as_bool() == Some(true) {
                                    Ok(frame["value"].clone())
                                } else {
                                    Err(frame["error"]
                                        .as_str()
                                        .unwrap_or("Operation failed")
                                        .to_string())
                                };
                                if let Some(tx) = pending.lock().unwrap().remove(&id) {
                                    let _ = tx.send(reply);
                                }
                            }
                            Some("fatal") => {
                                eprintln!(
                                    "{}",
                                    frame["error"].as_str().unwrap_or("backend failed")
                                );
                            }
                            _ => {}
                        }
                    }
                    alive.store(false, Ordering::SeqCst);
                    for (_, tx) in pending.lock().unwrap().drain() {
                        let _ = tx.send(Err(UNAVAILABLE.into()));
                    }
                    let _ = exit_tx.send(());
                })
                .map_err(|e| e.to_string())?;
        }

        Ok(Arc::new(Self {
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(child),
            pending,
            next_id: AtomicU64::new(1),
            alive,
            exited: Mutex::new(Some(exit_rx)),
        }))
    }

    fn write(&self, frame: &Value) -> Result<(), String> {
        let mut guard = self.stdin.lock().unwrap();
        let stdin = guard.as_mut().ok_or(UNAVAILABLE)?;
        writeln!(stdin, "{frame}")
            .and_then(|_| stdin.flush())
            .map_err(|_| UNAVAILABLE.to_string())
    }

    pub async fn call(&self, channel: &str, args: Vec<Value>) -> Reply {
        if !self.alive.load(Ordering::SeqCst) {
            return Err(UNAVAILABLE.into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let frame = json!({ "type": "call", "id": id, "channel": channel, "args": args });
        if let Err(e) = self.write(&frame) {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        rx.await.unwrap_or_else(|_| Err(UNAVAILABLE.into()))
    }

    /// Asks the backend to finish active work and exit; kills it after `grace`.
    pub fn shutdown(&self, grace: Duration) {
        let _ = self.write(&json!({ "type": "shutdown" }));
        // Closing stdin is the backend's fallback shutdown signal as well.
        self.stdin.lock().unwrap().take();
        let finished = match self.exited.lock().unwrap().take() {
            Some(rx) => rx.recv_timeout(grace).is_ok(),
            None => true,
        };
        let mut child = self.child.lock().unwrap();
        if !finished {
            eprintln!(
                "Backend did not stop within {}s; terminating",
                grace.as_secs()
            );
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            if let Ok(None) = child.try_wait() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
