import type { SyncGroup, InventoryAdapter } from "./types";
import { WooCommerceAdapter } from "./adapters/woocommerce";
import { ShopifyAdapter } from "./adapters/shopify";
import { ShoptetAdapter } from "./adapters/shoptet";
import { FileInventoryAdapter } from "./adapters/file";
export interface ConnectionConfig { id:string; platform:"woocommerce"|"shopify"|"shoptet"|"file"; baseUrl?:string; shopDomain?:string; stockPath?:string; credentialEnv?:string; secretEnv?:string; }
export interface GroupConfig { id:string; mode:"master"|"two_way"; masterId?:string; members:{connectionId:string;role:"source"|"destination"|"both"}[]; mappings:Record<string,Record<string,string>>; intervalMinutes:number; enabled:boolean; }
export interface AgentConfig { connections:ConnectionConfig[]; groups:GroupConfig[]; databasePath:string; exportDirectory:string; }
export function createAdapters(config:AgentConfig, env:NodeJS.ProcessEnv=process.env):Map<string,InventoryAdapter> {
 const result=new Map<string,InventoryAdapter>();
 for(const c of config.connections){if(result.has(c.id))throw new Error("Duplicate connection ID");let a:InventoryAdapter;
 if(c.platform==="woocommerce"){const key=env[c.credentialEnv??""];const secret=env[c.secretEnv??""];if(!c.baseUrl||!key||!secret)throw new Error("WooCommerce credentials missing");a=new WooCommerceAdapter(c.id,c.baseUrl,key,secret);}
 else if(c.platform==="shopify"){const token=env[c.credentialEnv??""];if(!c.shopDomain||!token)throw new Error("Shopify token missing");a=new ShopifyAdapter(c.id,c.shopDomain,token);}
 else if(c.platform==="file"){if(!c.stockPath)throw new Error("File path missing");a=new FileInventoryAdapter(c.id,c.stockPath);}
 else a=new ShoptetAdapter(c.id);
 result.set(c.id,a);
 }return result;
}
export function createGroups(config:AgentConfig,adapters:Map<string,InventoryAdapter>):SyncGroup[] {
 return config.groups.map(g=>({id:g.id,mode:g.mode,masterId:g.masterId,enabled:g.enabled,intervalMinutes:g.intervalMinutes,mappings:g.mappings,members:g.members.map(m=>{const adapter=adapters.get(m.connectionId);if(!adapter)throw new Error("Unknown connection "+m.connectionId);return {adapter,role:m.role};})}));
}
