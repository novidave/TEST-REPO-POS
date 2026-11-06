import type Database from "better-sqlite3";
import { isAbsolute } from "node:path";
import { UserError } from "./security";

export const LANGUAGES = ["en", "sk", "cs"] as const;
export const PRESET_INTERVALS = [5, 15, 30, 60] as const;
export const MIN_EXPORT_INTERVAL = 5;
export const MAX_EXPORT_INTERVAL = 1440;

export interface AppSettings {
  /** Root for exports without an explicit per-connection folder; null = <userData>/exports. */
  exportRoot: string | null;
  defaultIntervalMinutes: number;
  /** Global Start/Stop for scheduled exports. Persisted, so a stop survives restart. */
  schedulerPaused: boolean;
  /** Windows/macOS login item. */
  openAtLogin: boolean;
  /** When started at login, stay in the tray instead of opening the window. */
  startInBackground: boolean;
  /** Closing the window keeps the agent running in the tray. */
  closeToTray: boolean;
  language: (typeof LANGUAGES)[number];
  /** Optional CACADUU Phase B/C. Off by default until the backend supports them. */
  cloudSnapshotsEnabled: boolean;
  cloudCommandsEnabled: boolean;
  /** Connection whose verified exports are offered to CACADUU (Phase B). */
  cloudSourceConnectionId: string | null;
}
export const defaultSettings: AppSettings = {
  exportRoot: null,
  defaultIntervalMinutes: 15,
  schedulerPaused: false,
  openAtLogin: false,
  startInBackground: true,
  closeToTray: true,
  language: "en",
  cloudSnapshotsEnabled: false,
  cloudCommandsEnabled: false,
  cloudSourceConnectionId: null,
};
export function validInterval(value: unknown): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < MIN_EXPORT_INTERVAL ||
    (value as number) > MAX_EXPORT_INTERVAL
  )
    throw new UserError(
      `Interval must be a whole number of minutes from ${MIN_EXPORT_INTERVAL} to ${MAX_EXPORT_INTERVAL}`,
    );
  return value as number;
}
export function validDirectory(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    value.includes("\0") ||
    !isAbsolute(value.trim())
  )
    throw new UserError("Export folder must be an absolute path");
  return value.trim();
}
const bool = (value: unknown, label: string) => {
  if (typeof value !== "boolean")
    throw new UserError(label + " must be on or off");
  return value;
};
export class SettingsStore {
  constructor(private readonly db: Database.Database) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY, value_json TEXT NOT NULL)",
    );
  }
  get(): AppSettings {
    const stored = Object.fromEntries(
      (
        this.db.prepare("SELECT key,value_json FROM app_settings").all() as {
          key: string;
          value_json: string;
        }[]
      ).map((r) => [r.key, JSON.parse(r.value_json)]),
    );
    const result = { ...defaultSettings };
    for (const key of Object.keys(defaultSettings) as (keyof AppSettings)[])
      if (key in stored) (result as Record<string, unknown>)[key] = stored[key];
    return result;
  }
  /** Validates every supplied field; unknown fields are refused rather than stored. */
  update(input: unknown): AppSettings {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new UserError("Settings required");
    const v = input as Record<string, unknown>;
    const next: Partial<AppSettings> = {};
    for (const [key, value] of Object.entries(v)) {
      switch (key) {
        case "exportRoot":
          next.exportRoot =
            value === null || value === "" ? null : validDirectory(value);
          break;
        case "defaultIntervalMinutes":
          next.defaultIntervalMinutes = validInterval(value);
          break;
        case "schedulerPaused":
        case "openAtLogin":
        case "startInBackground":
        case "closeToTray":
        case "cloudSnapshotsEnabled":
        case "cloudCommandsEnabled":
          next[key] = bool(value, key);
          break;
        case "language":
          if (!LANGUAGES.includes(value as AppSettings["language"]))
            throw new UserError("Unsupported language");
          next.language = value as AppSettings["language"];
          break;
        case "cloudSourceConnectionId":
          if (
            value !== null &&
            (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value))
          )
            throw new UserError("Invalid cloud source connection");
          next.cloudSourceConnectionId = value as string | null;
          break;
        default:
          throw new UserError("Unknown setting: " + key.slice(0, 40));
      }
    }
    const statement = this.db.prepare(
      "INSERT INTO app_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
    );
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(next))
        statement.run(key, JSON.stringify(value));
    })();
    return this.get();
  }
}
