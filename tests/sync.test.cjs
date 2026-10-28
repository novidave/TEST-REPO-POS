const {test}=require("node:test");const assert=require("node:assert/strict");const {planGroup}=require("../dist/src/sync/engine.js");
const row=(q)=>({productKey:"p",sku:"SKU",location:"default",available:q,onHand:q,observedAt:new Date().toISOString()});
const adapter=(id,q)=>({id,platform:"pos",capabilities:{read:true,write:true,locations:false,webhooks:false,compareAndSwap:false},read:async()=>[row(q)],write:async()=>{}});
const store=()=>{const prev=new Map(),out=[];return {previous:(g,a,k)=>prev.get(a+k),saveObservation:(g,a,s)=>prev.set(a+s.productKey+"\0"+s.location,s.available),enqueue:(g,d,u)=>out.push([d,u]),conflict:()=>{},out}};
const group=(mode,a,b)=>({id:"g",mode,masterId:"a",members:[{adapter:a,role:"both"},{adapter:b,role:"both"}],enabled:true,intervalMinutes:15,mappings:{a:{p:"canonical"},b:{p:"canonical"}}});
test("master source writes destination",async()=>{const s=store();const p=await planGroup(group("master",adapter("a",5),adapter("b",3)),s);assert.equal(p.writes[0].updates[0].quantity,5)});
test("two-way initial mismatch held",async()=>{const s=store();const p=await planGroup(group("two_way",adapter("a",5),adapter("b",3)),s);assert.equal(p.conflicts.length,1);assert.equal(p.writes.length,0)});
test("two-way matching initial stock safe",async()=>{const s=store();const p=await planGroup(group("two_way",adapter("a",5),adapter("b",5)),s);assert.equal(p.conflicts.length,0);assert.equal(p.writes.length,0)});
test("failed source prevents writes",async()=>{const s=store();const a=adapter("a",5);a.read=async()=>{throw new Error("offline")};await assert.rejects(planGroup(group("master",a,adapter("b",3)),s));assert.equal(s.out.length,0)});
