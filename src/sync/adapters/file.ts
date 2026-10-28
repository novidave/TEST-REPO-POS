import { readFile } from "node:fs/promises";
import type { InventoryAdapter, Stock } from "../types";
/** JSON handover input. Never assumes an unknown CSV schema. */
export class FileInventoryAdapter implements InventoryAdapter {
 readonly platform="file" as const; readonly capabilities={read:true,write:false,locations:true,webhooks:false,compareAndSwap:false};
 constructor(readonly id:string,private readonly path:string) {}
 async read():Promise<Stock[]> { const raw=JSON.parse(await readFile(this.path,"utf8")) as unknown; if(!Array.isArray(raw))throw new Error("Expected JSON stock array");return raw.map((v:unknown)=>{const s=v as Stock;if(!s || typeof s.productKey!=="string" || typeof s.location!=="string" || typeof s.observedAt!=="string")throw new Error("Invalid stock row");return s;}); }
}
