import {
  CacaduuCloudClient,
  CloudApiError,
  type SnapshotAnnounce,
  type SnapshotState,
} from "../docs/cloud-api/client/client";
export type CloudResult<T> =
  { state: "ok"; value: T } | { state: "not_yet_available" };
export function isNotAvailable(e: unknown): boolean {
  return (
    e instanceof CloudApiError && e.status === 501 && e.code === "not_available"
  );
}
export async function optionalFeature<T>(
  enabled: boolean,
  operation: () => Promise<T>,
): Promise<CloudResult<T>> {
  if (!enabled) return { state: "not_yet_available" };
  try {
    return { state: "ok", value: await operation() };
  } catch (e) {
    if (isNotAvailable(e)) return { state: "not_yet_available" };
    throw e;
  }
}
export class CloudConnection {
  constructor(
    readonly client: CacaduuCloudClient,
    readonly enableSnapshots = false,
    readonly enableCommands = false,
  ) {}
  pair(code: string, name: string, os: string) {
    return this.client.pair(code, name, os);
  }
  heartbeat(os: string, sourceLabel?: string) {
    return this.client.heartbeat({ os, sourceLabel });
  }
  status() {
    return this.client.status();
  }
  rotate() {
    return this.client.rotateCredentials();
  }
  announceSnapshot(
    data: SnapshotAnnounce,
  ): Promise<CloudResult<SnapshotState>> {
    return optionalFeature(this.enableSnapshots, () =>
      this.client.createSnapshot(data),
    );
  }
  commands() {
    return optionalFeature(this.enableCommands, () =>
      this.client.listCommands(),
    );
  }
}
