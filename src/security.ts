import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
export function secureAvailable(cipher: Cipher): boolean {
  return (
    cipher.isEncryptionAvailable() &&
    cipher.getSelectedStorageBackend?.() !== "basic_text"
  );
}
export async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, path);
}
export class CredentialVault {
  constructor(
    private readonly path: string,
    private readonly cipher: Cipher,
  ) {}
  private async data(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Credential store unreadable");
    }
  }
  private chain: Promise<unknown> = Promise.resolve();
  async set(id: string, values: Record<string, string>): Promise<void> {
    const operation = this.chain.then(async () => {
      if (!secureAvailable(this.cipher))
        throw new UserError(
          "OS secure credential storage unavailable; credentials were not saved",
        );
      const data = await this.data();
      data[id] = this.cipher
        .encryptString(JSON.stringify(values))
        .toString("base64");
      await atomicJson(this.path, data);
    });
    this.chain = operation.catch(() => {});
    await operation;
  }
  async get(id: string): Promise<Record<string, string>> {
    await this.chain;
    const data = await this.data();
    if (!data[id]) return {};
    if (!secureAvailable(this.cipher))
      throw new UserError("OS secure credential storage unavailable");
    return JSON.parse(
      this.cipher.decryptString(Buffer.from(data[id], "base64")),
    );
  }
}
export function httpsUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new UserError(
      "HTTPS URL without embedded credentials, query or fragment required",
    );
  return url.toString().replace(/\/+$/, "");
}
/** Only controlled messages leave the main process. Upstream response bodies may echo secrets. */
export class UserError extends Error {}
export function publicError(error: unknown): string {
  if (error instanceof UserError) return error.message;
  const message = error instanceof Error ? error.message : "";
  const http = /^(WooCommerce|Shopify) HTTP (\d{3})$/.exec(message);
  if (http)
    return `${http[1]} HTTP ${http[2]}: check credentials, permissions or service availability`;
  return "Operation failed. Check configuration, required mappings, credentials and source data. No inventory was assumed.";
}
