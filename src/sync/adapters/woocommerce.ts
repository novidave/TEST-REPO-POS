import type { InventoryAdapter, Stock, StockWrite } from "../types";
export class WooCommerceAdapter implements InventoryAdapter {
  readonly platform = "woocommerce" as const;
  readonly capabilities = {read:true,write:true,locations:false,webhooks:false,compareAndSwap:false};
  constructor(readonly id:string,private readonly baseUrl:string,private readonly consumerKey:string,private readonly consumerSecret:string,private readonly http:typeof fetch=fetch) { if(!/^https:\/\//.test(baseUrl)) throw new Error("HTTPS required"); }
  private async request(path:string, init:RequestInit={}) {
    const authorization = "Basic "+Buffer.from(this.consumerKey+":"+this.consumerSecret).toString("base64");
    const res=await this.http(this.baseUrl.replace(/\/$/,"")+"/wp-json/wc/v3/"+path,{...init,headers:{authorization,"content-type":"application/json",...init.headers}});
    if(!res.ok) throw new Error("WooCommerce HTTP "+res.status); return res;
  }
  async read():Promise<Stock[]> {
    const rows:Stock[]=[];
    for(let page=1;page<=1000;page++) {
      const res=await this.request("products?per_page=100&page="+page); const products=await res.json() as any[];
      for(const p of products) {
        const variants=p.type==="variable"?await this.variants(p.id):[p];
        for(const v of variants) { if(!v.manage_stock || v.stock_quantity===null || !Number.isFinite(Number(v.stock_quantity))) continue;
          rows.push({productKey:String(p.id)+":"+(v===p?"0":String(v.id)),sku:String(v.sku||p.sku||""),location:"default",onHand:Number(v.stock_quantity),available:Number(v.stock_quantity),observedAt:new Date().toISOString()}); }
      }
      if(products.length<100) break;
    }
    return rows;
  }
  private async variants(id:number):Promise<any[]> { const out:any[]=[];for(let page=1;page<=100;page++){const r=await this.request("products/"+id+"/variations?per_page=100&page="+page);const v=await r.json() as any[];out.push(...v);if(v.length<100)break;}return out; }
  async write(updates:StockWrite[]):Promise<void> { for(const u of updates){if(!Number.isSafeInteger(u.quantity)||u.quantity<0)throw new Error("Invalid stock quantity");const [product,variant]=u.productKey.split(":");if(!/^\d+$/.test(product)||!/^\d+$/.test(variant))throw new Error("Invalid product key");const path="products/"+product+(variant!=="0"?"/variations/"+variant:"");await this.request(path,{method:"PUT",body:JSON.stringify({manage_stock:true,stock_quantity:u.quantity})});} }
}
