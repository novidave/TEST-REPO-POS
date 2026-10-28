import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAdapters, createGroups, type AgentConfig } from "./config";
import { SqliteSyncStore } from "./store";
import { runGroup, SyncScheduler } from "./runner";
async function main(){const configPath=process.argv[2];if(!configPath)throw new Error("Usage: npm run sync:once -- ./config.json");const config=JSON.parse(await readFile(resolve(configPath),"utf8")) as AgentConfig;
 const adapters=createAdapters(config);const groups=createGroups(config,adapters);const store=new SqliteSyncStore(resolve(config.databasePath));
 const execute=async(group:typeof groups[number])=>{
   // Default local delivery always runs before optional remote writes. Export only a complete master reading.
   // Stock-only adapters lack verified name, price and currency. Preserve existing local export module; do not fabricate data.\n   const result=await runGroup(group,store);console.log(JSON.stringify({group:group.id,writes:result.plan.writes.map(x=>({destination:x.destination,count:x.updates.length})),conflicts:result.plan.conflicts.length,errors:result.errors}));
 };
 try{for(const group of groups.filter(g=>g.enabled))await execute(group);if(process.env.CACADUU_RUN_SCHEDULER==="true"){const scheduler=new SyncScheduler(store);for(const group of groups.filter(g=>g.enabled))scheduler.start(group,r=>console.log("Scheduled sync",group.id,r.errors.length));process.on("SIGINT",()=>{scheduler.stopAll();store.close();process.exit(0)});}else store.close();}catch(e){store.close();throw e;}
}
main().catch(e=>{console.error(e instanceof Error?e.message:"Sync failed");process.exitCode=1});
