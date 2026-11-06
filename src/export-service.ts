import type Database from "better-sqlite3";
import { join } from "node:path";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { exportStock, type ExportResult } from "./export";
import {
  normalizeInventory,
  handoverRows,
  type NormalizedSnapshot,
} from "./inventory/normalize";
import { publicError, UserError } from "./security";
import { validDirectory, validInterval } from "./settings";
import { systemClock, type TimerClock } from "./sync/runtime";
import type { InventoryAdapter } from "./sync/types";

export interface ExportJobConfig {
  connectionId: string;
  enabled: boolean;
  intervalMinutes: number;
  /** Absolute folder; null uses <export root>/<connection ID>. */
  directory: string | null;
  /** One warehouse/location to export; null requires single-warehouse data. */
  warehouse: string | null;
  /** Hold a snapshot with fewer than half the products of the last published one. */
  shrinkGuard: boolean;
}
export type ExportTrigger = "manual" | "schedule" | "retry" | "cloud_command";
export interface ExportRunResult {
  state: "ok" | "held" | "failed" | "skipped";
  runId?: number;
  message: string;
  count?: number;
  sha256?: string;
  snapshotId?: string;
  directory?: string;
  issues?: NormalizedSnapshot["issues"];
}
export interface ExportDeps {
  adapter(connectionId: string): Promise<InventoryAdapter>;
  /** Serializes with group synchronization on the same connection. */
  lock<T>(connectionIds: string[], action: () => Promise<T>): Promise<T>;
  log(event: string, detail: Record<string, unknown>): void;
  exportRoot(): string;
  paused(): boolean;
  connectionExists(connectionId: string): boolean;
  onPublished?(
    connectionId: string,
    snapshot: NormalizedSnapshot,
    result: ExportResult,
    trigger: ExportTrigger,
  ): Promise<void> | void;
}
const READ_TIMEOUT_MS = 10 * 60 * 1000;
const RETRY_BASE_MS = 60 * 1000;
const MAX_TIMER = 2 ** 31 - 1;
interface JobRow {
  connection_id: string;
  enabled: number;
  interval_minutes: number;
  directory: string | null;
  warehouse: string | null;
  shrink_guard: number;
  consecutive_failures: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
}
/**
 * Scheduled, verified folder exports. Completion-based scheduling: the next run is planned after the previous
 * finishes, so runs of one connection never overlap. Due times derive from persisted attempts, so schedules
 * resume after a restart and an overdue export runs shortly after startup.
 */
export class ExportService {
  private timers = new Map<string, unknown>();
  private nextAt = new Map<string, number>();
  private running = new Map<string, Promise<ExportRunResult>>();
  private closed = false;
  constructor(
    private readonly db: Database.Database,
    private readonly deps: ExportDeps,
    private readonly clock: TimerClock = systemClock,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS export_jobs(connection_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, interval_minutes INTEGER NOT NULL, directory TEXT, warehouse TEXT, shrink_guard INTEGER NOT NULL DEFAULT 1, consecutive_failures INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT, last_success_at TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS export_runs(id INTEGER PRIMARY KEY AUTOINCREMENT, connection_id TEXT NOT NULL, trigger TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, state TEXT NOT NULL, product_count INTEGER, sha256 TEXT, snapshot_id TEXT, directory TEXT, source_time TEXT, message TEXT);
CREATE INDEX IF NOT EXISTS export_runs_recent ON export_runs(connection_id,id);
CREATE TABLE IF NOT EXISTS product_identities(connection_id TEXT NOT NULL, source_product_id TEXT NOT NULL, sku TEXT NOT NULL, ean TEXT, name TEXT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY(connection_id,source_product_id));
CREATE TABLE IF NOT EXISTS snapshot_items(connection_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, source_product_id TEXT NOT NULL, warehouse TEXT NOT NULL, quantity INTEGER NOT NULL, quantity_kind TEXT NOT NULL, price REAL NOT NULL, currency TEXT NOT NULL, availability_status TEXT NOT NULL, source_updated_at TEXT NOT NULL, snapshot_at TEXT NOT NULL, PRIMARY KEY(connection_id,source_product_id,warehouse));`);
    // Runs interrupted by a crash or power loss never published anything; record them as failed.
    db.prepare(
      "UPDATE export_runs SET state='failed',finished_at=?,message='Interrupted before completion; previous export preserved' WHERE state='running'",
    ).run(new Date(this.clock.now()).toISOString());
  }
  jobs(): (ExportJobConfig & {
    consecutiveFailures: number;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    nextRunAt: string | null;
    running: boolean;
    effectiveDirectory: string;
  })[] {
    return (
      this.db
        .prepare("SELECT * FROM export_jobs ORDER BY connection_id")
        .all() as JobRow[]
    ).map((r) => ({
      ...this.config(r),
      consecutiveFailures: r.consecutive_failures,
      lastAttemptAt: r.last_attempt_at,
      lastSuccessAt: r.last_success_at,
      nextRunAt: this.nextAt.has(r.connection_id)
        ? new Date(this.nextAt.get(r.connection_id)!).toISOString()
        : null,
      running: this.running.has(r.connection_id),
      effectiveDirectory: this.directoryFor(this.config(r)),
    }));
  }
  private config(r: JobRow): ExportJobConfig {
    return {
      connectionId: r.connection_id,
      enabled: r.enabled === 1,
      intervalMinutes: r.interval_minutes,
      directory: r.directory,
      warehouse: r.warehouse,
      shrinkGuard: r.shrink_guard === 1,
    };
  }
  job(connectionId: string): ExportJobConfig | undefined {
    const row = this.db
      .prepare("SELECT * FROM export_jobs WHERE connection_id=?")
      .get(connectionId) as JobRow | undefined;
    return row && this.config(row);
  }
  directoryFor(job: Pick<ExportJobConfig, "connectionId" | "directory">) {
    return job.directory ?? join(this.deps.exportRoot(), job.connectionId);
  }
  async saveJob(input: unknown, defaultInterval = 15): Promise<ExportJobConfig> {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new UserError("Export settings required");
    const v = input as Record<string, unknown>;
    const id = v.connectionId;
    if (typeof id !== "string" || !this.deps.connectionExists(id))
      throw new UserError("Unknown connection");
    const previous = this.job(id);
    const job: ExportJobConfig = {
      connectionId: id,
      enabled: typeof v.enabled === "boolean" ? v.enabled : (previous?.enabled ?? false),
      intervalMinutes: validInterval(
        v.intervalMinutes ?? previous?.intervalMinutes ?? defaultInterval,
      ),
      directory:
        v.directory === undefined
          ? (previous?.directory ?? null)
          : v.directory === null || v.directory === ""
            ? null
            : validDirectory(v.directory),
      warehouse:
        v.warehouse === undefined
          ? (previous?.warehouse ?? null)
          : v.warehouse === null || v.warehouse === ""
            ? null
            : this.text(v.warehouse, "Warehouse", 80),
      shrinkGuard:
        typeof v.shrinkGuard === "boolean" ? v.shrinkGuard : (previous?.shrinkGuard ?? true),
    };
    if (this.running.has(id))
      throw new UserError("Wait for the running export to finish before editing it");
    await this.probe(this.directoryFor(job));
    this.db
      .prepare(
        "INSERT INTO export_jobs(connection_id,enabled,interval_minutes,directory,warehouse,shrink_guard,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection_id) DO UPDATE SET enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,directory=excluded.directory,warehouse=excluded.warehouse,shrink_guard=excluded.shrink_guard,updated_at=excluded.updated_at",
      )
      .run(
        id,
        job.enabled ? 1 : 0,
        job.intervalMinutes,
        job.directory,
        job.warehouse,
        job.shrinkGuard ? 1 : 0,
        new Date(this.clock.now()).toISOString(),
      );
    this.deps.log("export_configured", {
      id,
      enabled: job.enabled,
      intervalMinutes: job.intervalMinutes,
      directory: this.directoryFor(job),
      warehouse: job.warehouse,
    });
    this.reschedule(id);
    return job;
  }
  private text(value: unknown, label: string, max: number) {
    if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value))
      throw new UserError(label + " is invalid");
    return value;
  }
  /** The destination must exist and accept a file before a schedule is saved. */
  private async probe(directory: string) {
    try {
      await mkdir(directory, { recursive: true });
      const probe = join(directory, ".write-test-" + randomUUID() + ".tmp");
      await writeFile(probe, "", { flag: "wx" });
      await unlink(probe);
    } catch {
      throw new UserError("Export folder is not writable");
    }
  }
  removeJob(connectionId: string) {
    this.cancel(connectionId);
    this.db.prepare("DELETE FROM export_jobs WHERE connection_id=?").run(connectionId);
  }
  history(limit = 100, connectionId?: string) {
    return connectionId
      ? this.db
          .prepare("SELECT * FROM export_runs WHERE connection_id=? ORDER BY id DESC LIMIT ?")
          .all(connectionId, limit)
      : this.db.prepare("SELECT * FROM export_runs ORDER BY id DESC LIMIT ?").all(limit);
  }
  lastSuccessful(connectionId?: string) {
    return (
      connectionId
        ? this.db
            .prepare("SELECT * FROM export_runs WHERE state='ok' AND connection_id=? ORDER BY id DESC LIMIT 1")
            .get(connectionId)
        : this.db.prepare("SELECT * FROM export_runs WHERE state='ok' ORDER BY id DESC LIMIT 1").get()
    ) as Record<string, unknown> | undefined;
  }
  /** Last published (valid) snapshot rows joined with their separately stored product identities. */
  snapshotItems(connectionId: string, limit = 1000) {
    return this.db
      .prepare(
        "SELECT s.source_product_id,p.sku,p.ean,p.name,s.warehouse,s.quantity,s.quantity_kind,s.price,s.currency,s.availability_status,s.source_updated_at,s.snapshot_at FROM snapshot_items s JOIN product_identities p ON p.connection_id=s.connection_id AND p.source_product_id=s.source_product_id WHERE s.connection_id=? ORDER BY p.sku LIMIT ?",
      )
      .all(connectionId, limit);
  }
  products(connectionId?: string, limit = 1000) {
    return connectionId
      ? this.db
          .prepare("SELECT * FROM product_identities WHERE connection_id=? ORDER BY sku LIMIT ?")
          .all(connectionId, limit)
      : this.db.prepare("SELECT * FROM product_identities ORDER BY connection_id,sku LIMIT ?").all(limit);
  }
  isRunning(connectionId: string) {
    return this.running.has(connectionId);
  }
  /** Manual Sync Now, schedule, retry and cloud commands all share one guarded path. */
  runNow(
    connectionId: string,
    trigger: ExportTrigger = "manual",
    options: { allowShrink?: boolean; snapshotId?: string } = {},
  ): Promise<ExportRunResult> {
    if (this.closed) return Promise.reject(new UserError("Application is closing"));
    if (this.running.has(connectionId)) {
      if (trigger === "manual" || trigger === "cloud_command")
        return Promise.reject(new UserError("An export for this connection is already running"));
      this.deps.log("export_skipped_overlap", { id: connectionId, trigger });
      return Promise.resolve({ state: "skipped", message: "Previous export still running" });
    }
    const operation = this.execute(connectionId, trigger, options).finally(() => {
      this.running.delete(connectionId);
      this.reschedule(connectionId);
    });
    this.running.set(connectionId, operation);
    return operation;
  }
  private async execute(
    connectionId: string,
    trigger: ExportTrigger,
    options: { allowShrink?: boolean; snapshotId?: string },
  ): Promise<ExportRunResult> {
    const job =
      this.job(connectionId) ??
      ({
        connectionId,
        enabled: false,
        intervalMinutes: 15,
        directory: null,
        warehouse: null,
        shrinkGuard: true,
      } satisfies ExportJobConfig);
    const directory = this.directoryFor(job);
    const started = new Date(this.clock.now()).toISOString();
    const runId = Number(
      this.db
        .prepare(
          "INSERT INTO export_runs(connection_id,trigger,started_at,state,directory) VALUES(?,?,?,'running',?)",
        )
        .run(connectionId, trigger, started, directory).lastInsertRowid,
    );
    this.db
      .prepare("UPDATE export_jobs SET last_attempt_at=? WHERE connection_id=?")
      .run(started, connectionId);
    const finish = (
      state: "ok" | "held" | "failed",
      message: string,
      extra: { count?: number; sha256?: string; snapshotId?: string; sourceTime?: string | null } = {},
    ) => {
      this.db
        .prepare(
          "UPDATE export_runs SET state=?,finished_at=?,message=?,product_count=?,sha256=?,snapshot_id=?,source_time=? WHERE id=?",
        )
        .run(
          state,
          new Date(this.clock.now()).toISOString(),
          message,
          extra.count ?? null,
          extra.sha256 ?? null,
          extra.snapshotId ?? null,
          extra.sourceTime ?? null,
          runId,
        );
      if (state === "ok")
        this.db
          .prepare(
            "UPDATE export_jobs SET consecutive_failures=0,last_success_at=? WHERE connection_id=?",
          )
          .run(started, connectionId);
      else
        this.db
          .prepare(
            "UPDATE export_jobs SET consecutive_failures=consecutive_failures+1 WHERE connection_id=?",
          )
          .run(connectionId);
    };
    try {
      return await this.deps.lock([connectionId], async () => {
        this.deps.log("read_started", { id: connectionId, trigger });
        const adapter = await this.deps.adapter(connectionId);
        let timer: unknown;
        const rows = await Promise.race([
          adapter.read(),
          new Promise<never>((_, reject) => {
            timer = this.clock.setTimeout(
              () => reject(new UserError("Source read timed out")),
              READ_TIMEOUT_MS,
            );
          }),
        ]).finally(() => this.clock.clearTimeout(timer));
        const snapshot = normalizeInventory(
          connectionId,
          rows,
          { warehouse: job.warehouse },
          new Date(this.clock.now()),
        );
        const zeroed = (adapter as { negativeRowsZeroed?: number }).negativeRowsZeroed;
        this.deps.log("read_completed", {
          id: connectionId,
          rows: rows.length,
          warehouses: snapshot.warehouses.length,
          ...(zeroed ? { negativeRowsZeroed: zeroed } : {}),
        });
        if (!snapshot.complete) {
          const errors = snapshot.issues.filter((i) => i.severity === "error");
          const message =
            `Held: ${errors.length} validation error(s). ${errors[0]?.message ?? ""} Previous export preserved.`.trim();
          finish("held", message);
          this.deps.log("export_held", {
            id: connectionId,
            trigger,
            errors: errors.length,
            first: errors.slice(0, 5).map((e) => ({ code: e.code, sku: e.sourceProductId, message: e.message })),
          });
          return { state: "held", runId, message, issues: snapshot.issues };
        }
        const previous = this.lastSuccessful(connectionId) as { product_count?: number } | undefined;
        if (
          job.shrinkGuard &&
          !options.allowShrink &&
          previous?.product_count &&
          snapshot.items.length < previous.product_count / 2
        ) {
          const message = `Held: ${snapshot.items.length} products vs ${previous.product_count} in the last export. Review and publish manually if correct. Previous export preserved.`;
          finish("held", message, { count: snapshot.items.length });
          this.deps.log("export_held", { id: connectionId, trigger, reason: "shrinking", count: snapshot.items.length, previous: previous.product_count });
          return { state: "held", runId, message, count: snapshot.items.length, issues: snapshot.issues };
        }
        const result = await exportStock(directory, handoverRows(snapshot), connectionId, {
          snapshotId: options.snapshotId,
          sourceTime: snapshot.sourceTime,
        });
        this.db.transaction(() => {
          finish("ok", "Published", {
            count: result.productCount,
            sha256: result.sha256,
            snapshotId: result.snapshotId,
            sourceTime: result.sourceTime,
          });
          this.storeSnapshot(connectionId, result.snapshotId, snapshot);
        })();
        const warnings = snapshot.issues.filter((i) => i.severity === "warning");
        this.deps.log("export_published", {
          id: connectionId,
          trigger,
          count: result.productCount,
          sha256: result.sha256,
          snapshotId: result.snapshotId,
          directory,
          warnings: warnings.length,
        });
        try {
          await this.deps.onPublished?.(connectionId, snapshot, result, trigger);
        } catch (e) {
          // Optional destinations never affect the local export result.
          this.deps.log("cloud_snapshot_failed", { id: connectionId, message: publicError(e) });
        }
        return {
          state: "ok",
          runId,
          message: `Published ${result.productCount} products`,
          count: result.productCount,
          sha256: result.sha256,
          snapshotId: result.snapshotId,
          directory,
          issues: snapshot.issues,
        };
      });
    } catch (e) {
      const message = publicError(e) + " Previous export preserved.";
      finish("failed", message);
      this.deps.log("export_failed", { id: connectionId, trigger, message });
      return { state: "failed", runId, message };
    }
  }
  private storeSnapshot(connectionId: string, snapshotId: string, snapshot: NormalizedSnapshot) {
    const identity = this.db.prepare(
      "INSERT INTO product_identities VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection_id,source_product_id) DO UPDATE SET sku=excluded.sku,ean=excluded.ean,name=excluded.name,last_seen_at=excluded.last_seen_at",
    );
    const item = this.db.prepare("INSERT INTO snapshot_items VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    this.db.prepare("DELETE FROM snapshot_items WHERE connection_id=?").run(connectionId);
    for (const i of snapshot.items) {
      identity.run(connectionId, i.sourceProductId, i.sku, i.ean, i.name, i.snapshotAt, i.snapshotAt);
      item.run(
        connectionId,
        snapshotId,
        i.sourceProductId,
        i.warehouse,
        i.quantity,
        i.quantityKind,
        i.price,
        i.currency,
        i.availabilityStatus,
        i.sourceUpdatedAt,
        i.snapshotAt,
      );
    }
  }
  // ---------------------------------------------------------------- scheduling
  /** (Re)plans every enabled job. Called on startup, after configuration changes and Start/Stop. */
  configure() {
    if (this.closed) return;
    const ids = new Set(
      (this.db.prepare("SELECT connection_id FROM export_jobs").all() as { connection_id: string }[]).map(
        (r) => r.connection_id,
      ),
    );
    for (const id of [...this.timers.keys()]) if (!ids.has(id)) this.cancel(id);
    for (const id of ids) this.reschedule(id);
  }
  private cancel(id: string) {
    if (this.timers.has(id)) this.clock.clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.nextAt.delete(id);
  }
  private reschedule(id: string) {
    this.cancel(id);
    if (this.closed || this.deps.paused() || this.running.has(id)) return;
    const row = this.db.prepare("SELECT * FROM export_jobs WHERE connection_id=?").get(id) as
      | JobRow
      | undefined;
    if (!row || row.enabled !== 1 || !this.deps.connectionExists(id)) return;
    const interval = row.interval_minutes * 60000;
    const now = this.clock.now();
    let due: number;
    let trigger: ExportTrigger = "schedule";
    const last = row.last_attempt_at ? Date.parse(row.last_attempt_at) : NaN;
    if (row.consecutive_failures > 0 && Number.isFinite(last)) {
      // Exponential retry: 1, 2, 4, 8 … minutes, never later than the normal interval.
      due = last + Math.min(interval, RETRY_BASE_MS * 2 ** Math.min(row.consecutive_failures - 1, 20));
      trigger = "retry";
    } else due = Number.isFinite(last) ? last + interval : now;
    let hash = 2166136261;
    for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    // Overdue jobs (e.g. after restart) run soon, spread over 5–35 s to avoid a startup burst.
    const delay = Math.min(MAX_TIMER, Math.max(due - now, 5000 + ((hash >>> 0) % 30000)));
    this.nextAt.set(id, now + delay);
    this.timers.set(
      id,
      this.clock.setTimeout(() => {
        this.timers.delete(id);
        this.nextAt.delete(id);
        void this.runNow(id, trigger).catch(() => {});
      }, delay),
    );
  }
  status() {
    return {
      paused: this.deps.paused(),
      scheduled: [...this.nextAt].map(([id, at]) => ({ id, nextRunAt: new Date(at).toISOString() })),
      running: [...this.running.keys()],
    };
  }
  /** Stops timers and waits for running exports; files are only renamed after full verification. */
  async close() {
    this.closed = true;
    for (const id of [...this.timers.keys()]) this.cancel(id);
    await Promise.allSettled([...this.running.values()]);
  }
}
