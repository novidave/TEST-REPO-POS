import Database from "better-sqlite3";
import type { Conflict, Stock, StockWrite } from "./types";
import type { SyncStore } from "./engine";
export class SqliteSyncStore implements SyncStore {
  readonly db: Database.Database;
  constructor(path: string) {
    this.db = new Database(path); this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS observations(group_id TEXT NOT NULL, adapter_id TEXT NOT NULL, item_key TEXT NOT NULL, quantity REAL NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(group_id,adapter_id,item_key));
CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, group_id TEXT NOT NULL, destination TEXT NOT NULL, product_key TEXT NOT NULL, location TEXT NOT NULL, quantity REAL NOT NULL, expected_revision TEXT, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conflicts(id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, product_key TEXT NOT NULL, location TEXT NOT NULL, reason TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sync_groups(id TEXT PRIMARY KEY, mode TEXT NOT NULL, master_id TEXT, interval_minutes INTEGER NOT NULL, enabled INTEGER NOT NULL, config_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, platform TEXT NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL);`);
  }
  previous(groupId: string, adapterId: string, itemKey: string): number | undefined { const row = this.db.prepare("SELECT quantity FROM observations WHERE group_id=? AND adapter_id=? AND item_key=?").get(groupId,adapterId,itemKey) as {quantity:number}|undefined; return row?.quantity; }
  saveObservation(groupId: string, adapterId: string, s: Stock): void { const quantity = s.available ?? s.onHand; if(quantity===null) return; this.db.prepare("INSERT INTO observations VALUES(?,?,?,?,?) ON CONFLICT(group_id,adapter_id,item_key) DO UPDATE SET quantity=excluded.quantity,observed_at=excluded.observed_at").run(groupId,adapterId,s.productKey+"\u0000"+s.location,quantity,s.observedAt); }
  enqueue(groupId: string, destination: string, u: StockWrite): void { this.db.prepare("INSERT OR IGNORE INTO outbox(id,group_id,destination,product_key,location,quantity,expected_revision,created_at) VALUES(?,?,?,?,?,?,?,?)").run(u.operationId,groupId,destination,u.productKey,u.location,u.quantity,u.expectedRevision??null,new Date().toISOString()); }
  conflict(c: Conflict): void { this.db.prepare("INSERT INTO conflicts(group_id,product_key,location,reason,detail_json,created_at) VALUES(?,?,?,?,?,?)").run(c.groupId,c.productKey,c.location,c.reason,JSON.stringify(c.observations),new Date().toISOString()); }
  pending(destination: string): {id:string;product_key:string;location:string;quantity:number;expected_revision:string|null}[] { return this.db.prepare("SELECT id,product_key,location,quantity,expected_revision FROM outbox WHERE destination=? AND state='pending' ORDER BY created_at LIMIT 100").all(destination) as ReturnType<SqliteSyncStore["pending"]>; }
  done(id: string) { this.db.prepare("UPDATE outbox SET state='done' WHERE id=?").run(id); }
  failed(id: string, error: string) { this.db.prepare("UPDATE outbox SET attempts=attempts+1,last_error=? WHERE id=?").run(error.slice(0,300),id); }
  close() { this.db.close(); }
}
