/**
 * Backend process for the Tauri shell.
 *
 * The Rust host starts this with Node and speaks newline-delimited JSON over
 * stdio. stdout carries protocol frames only; diagnostics go to stderr. The
 * first frame must be `init`, carrying the profile directory, app version and
 * the base64 master key read from the OS credential store (or null). The key is
 * never passed through argv or the environment.
 *
 *   host → { type: "init", userData, version, key }
 *   host → { type: "call", id, channel, args }
 *   host → { type: "shutdown" }
 *   side → { type: "ready" } | { type: "fatal", error }
 *   side → { type: "result", id, ok: true, value } | { ..., ok: false, error }
 *   side → { type: "closed" }
 */
import { createInterface } from "node:readline";
import { Backend, BACKEND_CHANNELS } from "./backend";
import { KeyCipher } from "./security";

// Keep stdout reserved for protocol frames.
for (const level of ["log", "info", "debug", "warn"] as const)
  console[level] = (...args: unknown[]) => console.error(...args);

const channels = new Set<string>(BACKEND_CHANNELS);
let backend: Promise<Backend> | undefined;
let closing: Promise<void> | undefined;

function send(frame: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(frame) + "\n");
}

function shutdown(): Promise<void> {
  if (!closing)
    closing = (backend ?? Promise.reject(new Error("not started")))
      .then((b) => b.close())
      .catch(() => {})
      .then(() => {
        send({ type: "closed" });
        process.exitCode = 0;
        // Drain stdout before exiting so the host sees `closed`.
        process.stdout.write("", () => process.exit(0));
      });
  return closing;
}

async function handle(frame: Record<string, unknown>) {
  switch (frame.type) {
    case "init": {
      if (backend) throw new Error("Already initialised");
      if (typeof frame.userData !== "string" || !frame.userData)
        throw new Error("userData required");
      const key =
        typeof frame.key === "string" && frame.key
          ? Buffer.from(frame.key, "base64")
          : null;
      backend = Backend.open({
        userData: frame.userData,
        cipher: new KeyCipher(key),
        version: typeof frame.version === "string" ? frame.version : "0.0.0",
        pairingUrl: process.env.CACADUU_PAIRING_URL,
        enableSnapshots: process.env.CACADUU_ENABLE_SNAPSHOTS === "true",
        enableCommands: process.env.CACADUU_ENABLE_COMMANDS === "true",
      });
      backend.then(
        () => send({ type: "ready" }),
        () => {
          send({
            type: "fatal",
            error:
              "Application startup failed; check user-data permissions and native modules",
          });
          process.exit(1);
        },
      );
      return;
    }
    case "call": {
      const id = frame.id;
      if (typeof id !== "number") return;
      try {
        if (!backend) throw new Error("Backend not initialised");
        if (closing) throw new Error("Application is closing");
        const channel = String(frame.channel);
        if (!channels.has(channel)) throw new Error("Unknown channel");
        const args = Array.isArray(frame.args) ? frame.args : [];
        const value = await (await backend).call(channel, args);
        send({ type: "result", id, ok: true, value: value ?? null });
      } catch (e) {
        send({
          type: "result",
          id,
          ok: false,
          error: e instanceof Error ? e.message : "Operation failed",
        });
      }
      return;
    }
    case "shutdown":
      await shutdown();
      return;
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  if (!line.trim()) return;
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  handle(frame).catch((e) => console.error("sidecar:", e?.message ?? e));
});
// Host exited or closed the pipe: shut down cleanly so SQLite and jobs settle.
input.on("close", () => void shutdown());
