import { UserError } from "../security";
import { randomUUID } from "node:crypto";
import type { Conflict, Plan, Stock, SyncGroup, StockWrite } from "./types";
export interface SyncStore {
  previous(groupId: string, adapterId: string, key: string): number | undefined;
  saveObservation(groupId: string, adapterId: string, stock: Stock): void;
  enqueue(groupId: string, destination: string, update: StockWrite): void;
  conflict(c: Conflict): void;
  isHeld?(groupId: string, productKey: string, location: string): boolean;
  clearConflict?(groupId: string, productKey: string, location: string): void;
  outstanding?(groupId: string, destination: string): boolean;
  transaction?(action: () => void): void;
}
const key = (s: Stock) => s.productKey + "\u0000" + s.location;
export function validateStock(rows: Stock[]): void {
  if (!Array.isArray(rows) || !rows.length)
    throw new UserError("Empty inventory; previous data preserved");
  const seen = new Set<string>();
  for (const s of rows) {
    const quantity = s?.available ?? s?.onHand;
    if (
      !s ||
      typeof s.productKey !== "string" ||
      !s.productKey.trim() ||
      s.productKey.includes("\0") ||
      typeof s.sku !== "string" ||
      !s.sku.trim() ||
      typeof s.location !== "string" ||
      !s.location.trim() ||
      s.location.includes("\0") ||
      !Number.isSafeInteger(quantity) ||
      quantity! < 0 ||
      !Number.isFinite(Date.parse(s.observedAt))
    )
      throw new UserError(
        "Invalid inventory: SKU, product, warehouse, timestamp and nonnegative integer quantity required",
      );
    if (seen.has(key(s)))
      throw new UserError("Duplicate product/warehouse observation");
    seen.add(key(s));
  }
}
export async function planGroup(
  group: SyncGroup,
  store: SyncStore,
): Promise<Plan> {
  const empty: Plan = {
    groupId: group.id,
    writes: [],
    conflicts: [],
    sourceCount: 0,
  };
  if (!group.enabled) return empty;
  if (group.mode !== "master" && group.mode !== "two_way")
    throw new UserError("Invalid mode");
  if (
    group.members.some(
      (m) => !["source", "destination", "both"].includes(m.role),
    )
  )
    throw new UserError("Invalid member role");
  if (!Number.isInteger(group.intervalMinutes) || group.intervalMinutes < 1)
    throw new UserError("Invalid interval");
  if (
    group.members.length < 2 ||
    new Set(group.members.map((m) => m.adapter.id)).size !==
      group.members.length
  )
    throw new UserError("At least two distinct members required");
  if (
    group.mode === "master" &&
    !group.members.some(
      (m) =>
        m.adapter.id === group.masterId &&
        m.role !== "destination" &&
        m.adapter.capabilities.read,
    )
  )
    throw new UserError("Master must be a readable group member");
  if (
    group.mode === "two_way" &&
    group.members.some(
      (m) =>
        m.role !== "both" ||
        !m.adapter.capabilities.read ||
        !m.adapter.capabilities.write ||
        !m.adapter.capabilities.compareAndSwap,
    )
  )
    throw new UserError(
      "Two-way sync requires read/write members with atomic compare-and-swap; use master mode for other connections",
    );
  const destinationErrors: { destination: string; error: string }[] = [];
  const readings = (
    await Promise.all(
      group.members.map(async (member) => {
        try {
          if (!member.adapter.capabilities.read)
            throw new UserError("Member inventory cannot be verified");
          const rows = await member.adapter.read();
          validateStock(rows);
          return { ...member, rows };
        } catch (e) {
          if (
            group.mode !== "master" ||
            member.adapter.id === group.masterId ||
            member.role !== "destination"
          )
            throw e;
          destinationErrors.push({
            destination: member.adapter.id,
            error: "Destination inventory read failed",
          });
          return null;
        }
      }),
    )
  ).filter((r): r is NonNullable<typeof r> => r !== null);
  const observations = new Map<
    string,
    { adapterId: string; stock: Stock; quantity: number }[]
  >();
  for (const { adapter, rows } of readings) {
    const identities = new Set<string>();
    for (const stock of rows) {
      const canonical = group.mappings[adapter.id]?.[stock.productKey];
      const warehouse = group.locationMappings?.[adapter.id]?.[stock.location];
      if (
        typeof canonical !== "string" ||
        !canonical.trim() ||
        canonical.includes("\0") ||
        typeof warehouse !== "string" ||
        !warehouse.trim() ||
        warehouse.includes("\0")
      )
        throw new UserError(
          "Missing explicit product or warehouse mapping for " + adapter.id,
        );
      const identity = canonical + "\0" + warehouse;
      if (identities.has(identity))
        throw new UserError("Ambiguous product/warehouse mapping");
      identities.add(identity);
      const list = observations.get(identity) ?? [];
      list.push({
        adapterId: adapter.id,
        stock,
        quantity: (stock.available ?? stock.onHand)!,
      });
      observations.set(identity, list);
    }
  }
  const writes = new Map<string, StockWrite[]>(),
    conflicts: Conflict[] = [],
    accepted: { adapterId: string; stock: Stock }[] = [];
  for (const [identity, rows] of observations) {
    const [productKey, location] = identity.split("\0");
    let chosen: number | undefined;
    let reason = "Ambiguous inventory; manual review required";
    if (group.mode === "two_way" && rows.length !== group.members.length)
      reason = "Mapped product/warehouse is missing from a member inventory";
    else if (group.mode === "master")
      chosen = rows.find((r) => r.adapterId === group.masterId)?.quantity;
    else {
      const previous = rows.map((r) =>
        store.previous(group.id, r.adapterId, key(r.stock)),
      );
      const changed = rows.filter(
        (r, i) => previous[i] !== undefined && previous[i] !== r.quantity,
      );
      if (new Set(rows.map((r) => r.quantity)).size === 1)
        chosen = rows[0].quantity;
      else if (
        !store.isHeld?.(group.id, productKey, location) &&
        previous.every((v) => v !== undefined) &&
        changed.length === 1
      )
        chosen = changed[0].quantity;
      if (rows.some((r) => !r.stock.revision)) {
        chosen = undefined;
        reason = "Atomic write revision missing";
      }
    }
    if (chosen === undefined) {
      conflicts.push({
        groupId: group.id,
        productKey,
        location,
        reason,
        observations: rows.map((r) => ({
          source: r.adapterId,
          quantity: r.quantity,
          revision: r.stock.revision,
        })),
      });
      // Never advance a conflict's baseline: a later single edit cannot silently resolve it.
      continue;
    }
    accepted.push(...rows);
    for (const member of group.members) {
      if (
        member.role === "source" ||
        (group.mode === "master" && member.adapter.id === group.masterId)
      )
        continue;
      if (!member.adapter.capabilities.write || !member.adapter.write)
        throw new UserError("Destination is read-only");
      if (
        group.mode === "master" &&
        store.outstanding?.(group.id, member.adapter.id)
      )
        continue;
      const current = rows.find((r) => r.adapterId === member.adapter.id);
      if (!current) {
        if (!destinationErrors.some((e) => e.destination === member.adapter.id))
          conflicts.push({
            groupId: group.id,
            productKey,
            location,
            reason: "Mapped destination item missing; no write planned",
            observations: [],
          });
        continue;
      }
      if (current.quantity === chosen) continue;
      if (member.adapter.capabilities.compareAndSwap && !current.stock.revision)
        throw new UserError("Destination revision required");
      const update: StockWrite = {
        productKey: current.stock.productKey,
        location: current.stock.location,
        quantity: chosen,
        expectedRevision: current.stock.revision ?? String(current.quantity),
        operationId: randomUUID(),
      };
      writes.set(member.adapter.id, [
        ...(writes.get(member.adapter.id) ?? []),
        update,
      ]);
    }
  }
  const commit = () => {
    for (const c of conflicts) store.conflict(c);
    for (const [identity, rows] of observations) {
      const [productKey, location] = identity.split("\0");
      if (
        rows.length === group.members.length &&
        new Set(rows.map((r) => r.quantity)).size === 1
      )
        store.clearConflict?.(group.id, productKey, location);
    }
    for (const { adapterId, stock } of accepted)
      store.saveObservation(group.id, adapterId, stock);
    for (const [destination, updates] of writes)
      for (const u of updates) store.enqueue(group.id, destination, u);
  };
  if (store.transaction) store.transaction(commit);
  else commit();
  return {
    groupId: group.id,
    writes: [...writes].map(([destination, updates]) => ({
      destination,
      updates,
    })),
    conflicts,
    sourceCount: readings.reduce((n, r) => n + r.rows.length, 0),
    destinationErrors,
  };
}
