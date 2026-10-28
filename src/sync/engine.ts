import { randomUUID } from "node:crypto";
import type { Conflict, InventoryAdapter, Plan, Stock, SyncGroup, StockWrite } from "./types";
export interface SyncStore { previous(groupId: string, adapterId: string, key: string): number | undefined; saveObservation(groupId: string, adapterId: string, stock: Stock): void; enqueue(groupId: string, destination: string, update: StockWrite): void; conflict(c: Conflict): void; }
const key = (s: Stock) => s.productKey + "\u0000" + s.location;
function mapped(group: SyncGroup, adapter: InventoryAdapter, stock: Stock): string | null {
  // Explicit mappings only; never silently match by display name.
  return group.mappings[adapter.id]?.[stock.productKey] ?? null;
}
export async function planGroup(group: SyncGroup, store: SyncStore): Promise<Plan> {
  if (!group.enabled) return { groupId: group.id, writes: [], conflicts: [], sourceCount: 0 };
  if (group.intervalMinutes < 1) throw new Error("Invalid interval");
  if (group.mode === "master" && !group.members.some(m => m.adapter.id === group.masterId && m.role !== "destination")) throw new Error("Master must be a readable group member");
  const observations = new Map<string, { adapter: InventoryAdapter; stock: Stock }[]>();
  const readable = group.members.filter(m => m.role !== "destination" && m.adapter.capabilities.read);
  // Fail closed: do not issue any writes if a source read fails.
  const readings = await Promise.all(readable.map(async m => ({ adapter: m.adapter, rows: await m.adapter.read() })));
  for (const { adapter, rows } of readings) {
    if (rows.length === 0) throw new Error("Empty source inventory from " + adapter.id);
    const seen = new Set<string>();
    for (const s of rows) {
      if (!s.productKey || !s.location || !Number.isFinite(s.onHand ?? s.available) || (s.onHand ?? s.available)! < 0) throw new Error("Invalid stock observation");
      if (seen.has(key(s))) throw new Error("Duplicate source product/location"); seen.add(key(s));
      const canonical = mapped(group, adapter, s); if (!canonical) continue;
      const list = observations.get(canonical + "\u0000" + s.location) ?? [];
      list.push({ adapter, stock: s }); observations.set(canonical + "\u0000" + s.location, list);
    }
  }
  const writes = new Map<string, StockWrite[]>(); const conflicts: Conflict[] = [];
  for (const [identity, rows] of observations) {
    const [canonical, location] = identity.split("\u0000");
    const usable = rows.map(r => ({ ...r, quantity: r.stock.available ?? r.stock.onHand! }));
    let chosen: number | undefined;
    if (group.mode === "master") chosen = usable.find(r => r.adapter.id === group.masterId)?.quantity;
    else {
      const changed = usable.filter(r => store.previous(group.id, r.adapter.id, key(r.stock)) !== undefined && store.previous(group.id, r.adapter.id, key(r.stock)) !== r.quantity);
      const initial = usable.every(r => store.previous(group.id, r.adapter.id, key(r.stock)) === undefined);
      if (initial) { if (new Set(usable.map(r => r.quantity)).size === 1) chosen = usable[0]?.quantity; }
      else if (changed.length === 1) chosen = changed[0].quantity;
      else if (changed.length === 0 && new Set(usable.map(r => r.quantity)).size === 1) chosen = usable[0]?.quantity;
    }
    if (chosen === undefined) { const c: Conflict = { groupId: group.id, productKey: canonical, location, reason: "Ambiguous inventory; manual review required", observations: usable.map(r => ({ source: r.adapter.id, quantity: r.quantity, revision: r.stock.revision })) }; conflicts.push(c); store.conflict(c); continue; }
    for (const member of group.members) {
      if (member.role === "source" || !member.adapter.capabilities.write || !member.adapter.write) continue;
      if (group.mode === "master" && member.adapter.id === group.masterId) continue;
      const destinationKey = Object.entries(group.mappings[member.adapter.id] ?? {}).find(([,c]) => c === canonical)?.[0];
      if (!destinationKey) continue;
      const current = usable.find(r => r.adapter.id === member.adapter.id && r.stock.productKey === destinationKey);
      if (current && current.quantity === chosen) continue;
      // No implicit location mapping: only identical explicit location IDs are supported in v1.
      const update: StockWrite = { productKey: destinationKey, location, quantity: chosen, expectedRevision: current?.stock.revision, operationId: randomUUID() };
      writes.set(member.adapter.id, [...(writes.get(member.adapter.id) ?? []), update]);
    }
  }
  // Observations are committed only after the entire read/plan stage completes.
  for (const { adapter, rows } of readings) for (const row of rows) store.saveObservation(group.id, adapter.id, row);
  for (const [destination, updates] of writes) for (const update of updates) store.enqueue(group.id, destination, update);
  return { groupId: group.id, writes: [...writes].map(([destination,updates])=>({destination,updates})), conflicts, sourceCount: readings.reduce((n,r)=>n+r.rows.length,0) };
}
