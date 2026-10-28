import { ProviderHttpError } from "./http";
import type { InventoryAdapter, Stock, SyncGroup } from "./types";
import { planGroup, validateStock } from "./engine";
import { SqliteSyncStore } from "./store";
const running = new WeakMap<SqliteSyncStore, Set<string>>();
async function observe(
  adapter: InventoryAdapter,
  productKey: string | undefined,
  location: string | undefined,
): Promise<Stock | undefined> {
  if (!productKey || !location) return undefined;
  if (adapter.readOne) {
    const row = await adapter.readOne(productKey, location);
    if (!row) return undefined;
    validateStock([row]);
    if (row.productKey !== productKey || row.location !== location)
      throw new Error("Adapter returned a different product or warehouse");
    return row;
  }
  const rows = await adapter.read();
  validateStock(rows);
  return rows.find(
    (row) => row.productKey === productKey && row.location === location,
  );
}
export async function runGroup(
  group: SyncGroup,
  store: SqliteSyncStore,
  options: { canContinue?: () => boolean } = {},
) {
  const canContinue = () => group.enabled && (options.canContinue?.() ?? true);
  const active = running.get(store) ?? new Set<string>();
  running.set(store, active);
  if (active.has(group.id)) throw new Error("Group sync is already running");
  active.add(group.id);
  try {
    if (!canContinue())
      return {
        plan: { groupId: group.id, writes: [], conflicts: [], sourceCount: 0 },
        errors: [],
        paused: true,
      };
    // Pending/blocked operations are reconciled before making a new plan.
    const plan =
      group.mode === "two_way" && store.hasOutstanding(group.id)
        ? { groupId: group.id, writes: [], conflicts: [], sourceCount: 0 }
        : await planGroup(group, store);
    const errors: { destination: string; error: string }[] = [
      ...(plan.destinationErrors ?? []),
    ];
    const reverseProducts = new Map(
      group.members.map((member) => [
        member.adapter.id,
        new Map(
          Object.entries(group.mappings[member.adapter.id] ?? {}).map(
            ([local, canonical]) => [canonical, local],
          ),
        ),
      ]),
    );
    const reverseLocations = new Map(
      group.members.map((member) => [
        member.adapter.id,
        new Map(
          Object.entries(group.locationMappings?.[member.adapter.id] ?? {}).map(
            ([local, canonical]) => [canonical, local],
          ),
        ),
      ]),
    );
    for (const member of group.members) {
      const adapter = member.adapter;
      if (
        member.role === "source" ||
        !adapter.write ||
        !adapter.capabilities.write
      )
        continue;
      for (const row of store.pending(group.id, adapter.id)) {
        if (!canContinue()) return { plan, errors, paused: true };
        let attempted = false;
        try {
          if (group.mode === "master") {
            const canonical = group.mappings[adapter.id]?.[row.product_key],
              warehouse = group.locationMappings?.[adapter.id]?.[row.location];
            const source = group.members.find(
              (m) => m.adapter.id === group.masterId,
            )!.adapter;
            const sourceItem = await observe(
              source,
              reverseProducts.get(source.id)?.get(canonical),
              reverseLocations.get(source.id)?.get(warehouse!),
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
              const observation = await observe(
                peer.adapter,
                reverseProducts.get(peer.adapter.id)?.get(canonical),
                reverseLocations.get(peer.adapter.id)?.get(warehouse!),
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
          const current = await observe(adapter, row.product_key, row.location);
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
          if (!canContinue()) return { plan, errors, paused: true };
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
        } catch (error) {
          const message =
            "Destination request failed; inspect connection and retry queue";
          if (!attempted) store.attempt(row.id);
          if (error instanceof ProviderHttpError && !error.retryable)
            store.block(
              row.id,
              `${error.provider} HTTP ${error.status}; review connection permissions`,
            );
          else
            store.failed(
              row.id,
              message,
              error instanceof ProviderHttpError ? error.retryAt : undefined,
            );
          errors.push({ destination: adapter.id, error: message });
          if (
            error instanceof ProviderHttpError &&
            [401, 403].includes(error.status)
          ) {
            store.blockDestination(
              group.id,
              adapter.id,
              `${error.provider} HTTP ${error.status}; review connection permissions`,
            );
            break;
          }
          if (!(error instanceof ProviderHttpError) || error.retryable) {
            store.deferDestination(
              group.id,
              adapter.id,
              error instanceof ProviderHttpError
                ? (error.retryAt ?? Date.now() + 2000)
                : Date.now() + 2000,
            );
            break;
          }
        }
      }
    }
    return { plan, errors, paused: !canContinue() };
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
