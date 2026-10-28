import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAdapters, createGroups, type AgentConfig } from "./config";
import { SqliteSyncStore } from "./store";
import { runGroup, SyncScheduler } from "./runner";
import { exportStock, type StockRow } from "../export";
async function main(){const configPath=process.argv[2];if(!configPath)throw new Error("Usage: npm run sync:once -- ./config.json");const config=JSON.parse(await readFile(resolve(configPath),"utf8")) as AgentConfig;
 const adapters=createAdapters(config);const groups=createGroups(config,adapters);const store=new SqliteSyncStore(resolve(config.databasePath));
 const execute=async(group:typeof groups[number])=>{
   // Default local delivery always runs before optional remote writes. Export only a complete master reading.
   if(group.mode==="master"){const master=group.members.find(m=>m.adapter.id===group.masterId)?.adapter;if(master){const rows=await master.read();const exportRows:StockRow[]=rows.map(r=>({source_code:r.sku||r.productKey,name:r.sku||r.productKey,price:0,currency:"EUR",quantity:r.available??r.onHand??0}));
   // Price/currency cannot be inferred from stock-only API responses: do not emit fabricated commercial data.
   if(process.env.CACADUU_ALLOW_STOCK_ONLY_EXPORT==="true")throw new Error("Stock-only export requires a separate explicitly mapped price/currency provider");
   console.log("Local file export requires authoritative price, currency and product names; skipped safely for stock-only source");
   }}
   const result=await runGroup(group,store);console.log(JSON.stringify({group:group.id,writes:result.plan.writes.map(x=>({destination:x.destination,count:x.updates.length})),conflicts:result.plan.conflicts.length,errors:result.errors}));
 };
 try{for(const group of groups.filter(g=>g.enabled))await execute(group);if(process.env.CACADUU_RUN_SCHEDULER==="true"){const scheduler=new SyncScheduler(store);for(const group of groups.filter(g=>g.enabled))scheduler.start(group,r=>console.log("Scheduled sync",group.id,r.errors.length));process.on("SIGINT",()=>{scheduler.stopAll();store.close();process.exit(0)});}else store.close();}catch(e){store.close();throw e;}
}
main().catch(e=>{console.error(e instanceof Error?e.message:"Sync failed");process.exitCode=1});
