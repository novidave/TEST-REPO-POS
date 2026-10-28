import type { SyncGroup } from "./types";
import { planGroup, validateStock } from "./engine";
import { SqliteSyncStore } from "./store";
const active = new Set<string>();
export async function runGroup(group: SyncGroup, store: SqliteSyncStore) {
  if (active.has(group.id)) throw new Error("Group sync is already running");
  active.add(group.id);
  try {
    if (!group.enabled)
      return {
        plan: { groupId: group.id, writes: [], conflicts: [], sourceCount: 0 },
        errors: [],
      };
    // Pending/blocked operations are reconciled before making a new plan.
    const plan =
      group.mode === "two_way" && store.hasOutstanding(group.id)
        ? { groupId: group.id, writes: [], conflicts: [], sourceCount: 0 }
        : await planGroup(group, store);
    const errors: { destination: string; error: string }[] = [
      ...(plan.destinationErrors ?? []),
    ];
    for (const member of group.members) {
      const adapter = member.adapter;
      if (
        member.role === "source" ||
        !adapter.write ||
        !adapter.capabilities.write
      )
        continue;
      for (const row of store.pending(group.id, adapter.id)) {
        let attempted = false;
        try {
          if (group.mode === "master") {
            const canonical = group.mappings[adapter.id]?.[row.product_key],
              warehouse = group.locationMappings?.[adapter.id]?.[row.location];
            const source = group.members.find(
              (m) => m.adapter.id === group.masterId,
            )!.adapter;
            const sourceRows = await source.read();
            validateStock(sourceRows);
            const sourceItem = sourceRows.find(
              (s) =>
                group.mappings[source.id]?.[s.productKey] === canonical &&
                group.locationMappings?.[source.id]?.[s.location] === warehouse,
            );
            if (
              !sourceItem ||
              (sourceItem.available ?? sourceItem.onHand) !== row.quantity
            ) {
              store.block(
                row.id,
                "Master changed since job creation; reconcile before replanning",
              );
              continue;
            }
          }
          if (group.mode === "two_way") {
            const canonical = group.mappings[adapter.id]?.[row.product_key],
              warehouse = group.locationMappings?.[adapter.id]?.[row.location];
            let changed = false;
            for (const peer of group.members.filter(
              (m) => m.adapter.id !== adapter.id,
            )) {
              const observations = await peer.adapter.read();
              validateStock(observations);
              const observation = observations.find(
                (s) =>
                  group.mappings[peer.adapter.id]?.[s.productKey] ===
                    canonical &&
                  group.locationMappings?.[peer.adapter.id]?.[s.location] ===
                    warehouse,
              );
              const baseline = observation
                ? store.previous(
                    group.id,
                    peer.adapter.id,
                    observation.productKey + "\0" + observation.location,
                  )
                : undefined;
              if (
                !observation ||
                baseline === undefined ||
                ((observation.available ?? observation.onHand) !== baseline &&
                  (observation.available ?? observation.onHand) !==
                    row.quantity)
              )
                changed = true;
            }
            if (changed) {
              store.block(
                row.id,
                "Peer changed since plan creation; manual reconciliation required",
              );
              continue;
            }
          }
          const fresh = await adapter.read();
          validateStock(fresh);
          const current = fresh.find(
            (s) =>
              s.productKey === row.product_key && s.location === row.location,
          );
          if (!current) {
            store.block(row.id, "Mapped destination item missing");
            continue;
          }
          const quantity = current.available ?? current.onHand;
          // Handles duplicate delivery and a crash after remote success, before local commit.
          if (quantity === row.quantity) {
            store.done(row.id);
            continue;
          }
          if (
            (current.revision ?? String(quantity)) !== row.expected_revision
          ) {
            store.block(
              row.id,
              "Destination changed; manual reconciliation required",
            );
            continue;
          }
          if (!adapter.capabilities.compareAndSwap && row.attempts > 0) {
            store.block(
              row.id,
              "Uncertain non-atomic write; verify destination before retrying",
            );
            continue;
          }
          // Persist an attempt BEFORE network IO so a crash cannot look like an unattempted write.
          store.attempt(row.id);
          attempted = true;
          await adapter.write([
            {
              productKey: row.product_key,
              location: row.location,
              quantity: row.quantity,
              expectedRevision: row.expected_revision ?? undefined,
              operationId: row.id,
            },
          ]);
          store.done(row.id);
        } catch {
          const message =
            "Destination request failed; inspect connection and retry queue";
          if (!attempted) store.attempt(row.id);
          store.failed(row.id, message);
          errors.push({ destination: adapter.id, error: message });
        }
      }
    }
    return { plan, errors };
  } finally {
    active.delete(group.id);
  }
}
export class SyncScheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  constructor(private readonly store: SqliteSyncStore) {}
  start(
    group: SyncGroup,
    onResult?: (result: Awaited<ReturnType<typeof runGroup>>) => void,
    onError?: () => void,
  ) {
    this.stop(group.id);
    if (!group.enabled) return;
    const tick = async () => {
      try {
        onResult?.(await runGroup(group, this.store));
      } catch {
        onError?.();
      }
    };
    this.timers.set(
      group.id,
      setInterval(tick, group.intervalMinutes * 60_000),
    );
  }
  stop(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearInterval(timer);
    this.timers.delete(id);
  }
  stopAll() {
    for (const id of this.timers.keys()) this.stop(id);
  }
}
