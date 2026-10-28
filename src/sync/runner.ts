import type { InventoryAdapter, SyncGroup } from "./types";
import { planGroup } from "./engine";
import { SqliteSyncStore } from "./store";
export async function runGroup(group: SyncGroup, store: SqliteSyncStore) {
  const plan = await planGroup(group,store);
  // Each destination is isolated; failures stay in the durable outbox.
  const errors: { destination:string; error:string }[] = [];
  for (const member of group.members) {
    const adapter: InventoryAdapter = member.adapter;
    if (!adapter.write || !adapter.capabilities.write) continue;
    const pending = store.pending(adapter.id);
    for (const row of pending) {
      try { await adapter.write([{ productKey:row.product_key,location:row.location,quantity:row.quantity,expectedRevision:row.expected_revision??undefined,operationId:row.id }]); store.done(row.id); }
      catch (e) { const message = e instanceof Error ? e.message : "Write failed"; store.failed(row.id,message); errors.push({destination:adapter.id,error:message}); }
    }
  }
  return { plan, errors };
}
export class SyncScheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private running = new Set<string>();
  constructor(private readonly store: SqliteSyncStore) {}
  start(group: SyncGroup, onResult?: (result: Awaited<ReturnType<typeof runGroup>>) => void) {
    this.stop(group.id);
    const tick = async () => { if(this.running.has(group.id)) return; this.running.add(group.id); try { const result = await runGroup(group,this.store); onResult?.(result); } catch(e) { console.error("Sync group failed:",group.id,e instanceof Error?e.message:"unknown"); } finally { this.running.delete(group.id); } };
    this.timers.set(group.id,setInterval(tick,Math.max(1,group.intervalMinutes)*60_000));
  }
  stop(id: string) { const t=this.timers.get(id); if(t) clearInterval(t); this.timers.delete(id); }
  stopAll() { for(const id of this.timers.keys()) this.stop(id); }
}
