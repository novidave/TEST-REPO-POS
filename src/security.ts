import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
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
  const http = /^(WooCommerce|Shopify|ERPNext|Odoo) HTTP (\d{3})$/.exec(
    message,
  );
  if (http)
    return `${http[1]} HTTP ${http[2]}: check credentials, permissions or service availability`;
  return "Operation failed. Check configuration, required mappings, credentials and source data. No inventory was assumed.";
}
/**
 * AES-256-GCM cipher keyed by a 32-byte master key held in the OS credential
 * store (Windows Credential Manager, macOS Keychain, Secret Service). Used by the
 * Tauri shell, which has no Electron safeStorage. Without a key, encryption is
 * reported unavailable and credentials are refused, as with Electron.
 */
export class KeyCipher implements Cipher {
  private static readonly VERSION = 1;
  private readonly key: Buffer | null;
  constructor(key: Buffer | null) {
    if (key && key.length !== 32)
      throw new Error("Master key must be 32 bytes");
    this.key = key;
  }
  isEncryptionAvailable(): boolean {
    return this.key !== null;
  }
  private required(): Buffer {
    if (!this.key) throw new UserError("OS secure storage unavailable");
    return this.key;
  }
  encryptString(value: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.required(), iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return Buffer.concat([
      Buffer.from([KeyCipher.VERSION]),
      iv,
      cipher.getAuthTag(),
      body,
    ]);
  }
  decryptString(value: Buffer): string {
    if (value.length < 29 || value[0] !== KeyCipher.VERSION)
      throw new Error("Unsupported ciphertext");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.required(),
      value.subarray(1, 13),
    );
    decipher.setAuthTag(value.subarray(13, 29));
    return Buffer.concat([
      decipher.update(value.subarray(29)),
      decipher.final(),
    ]).toString("utf8");
  }
}
