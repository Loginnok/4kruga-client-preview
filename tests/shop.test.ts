import {test} from "node:test";
import {request as httpRequest} from "node:http";
import assert from "node:assert/strict";
import {readFileSync,writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {parse} from "dotenv";
import {createDb} from "../src/db.js";
import {createShop} from "../src/server.js";
import {seed} from "../prisma/seed.js";
import {hashPassword,verifyPassword,token} from "../src/security.js";
const environment=parse(readFileSync('.env.test.local','utf8'));
const url=environment.DATABASE_URL!;
assert.ok(new URL(url).pathname.startsWith('/kruga_shop_test'),'Only an isolated PostgreSQL test database is permitted');
execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{env:{...process.env,DATABASE_URL:url},stdio:'pipe',windowsHide:true});

test('PostgreSQL shop integration acceptance',async t=>{
 let db=createDb(url);await db.$executeRawUnsafe('TRUNCATE TABLE "AdminSession", "Admin", "OrderItem", "ShopOrder", "RepairRequest", "CartItem", "ShopSession", "Compatibility", "Product", "ScooterModel", "Brand", "Category" CASCADE');await seed(db);
 let shop=await createShop({db});await new Promise<void>(r=>shop.server.listen(0,'127.0.0.1',r));
 let address=shop.server.address();assert.ok(address&&typeof address==='object');let base='http://127.0.0.1:'+address.port;
 function client(){const cookies=new Map<string,string>();return {cookies,async request(path:string,{method='GET',body,origin=base,headers={}}:{method?:string;body?:unknown;origin?:string|null;headers?:Record<string,string>}={}){
  const response=await fetch(base+path,{method,headers:{...(cookies.size?{Cookie:[...cookies].map(([k,v])=>k+'='+v).join('; ')}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{}),...(origin?{Origin:origin}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  for(const line of response.headers.getSetCookie()){const [pair]=line.split(';');const at=pair!.indexOf('=');cookies.set(pair!.slice(0,at),pair!.slice(at+1));}
  const data=response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text();return {status:response.status,data,headers:response.headers};
 }};}
 const a=client(),b=client(),manager=client();let orderId='';let initialStock=0;
 const orderData={name:'Покупатель QA',phone:'+7 900 000-00-11',email:'',delivery:'pickup',address:'',comment:'Синтетическая проверка',consent:true,idempotency_key:'qa-order-idempotency-0001'};
 const adminEmail='manager@example.invalid',adminPassword=token();
 try {
 await t.test('PostgreSQL health and 50 seeded products are real database records',async()=>{const health=await a.request('/api/health');assert.equal(health.status,200);assert.equal(health.data.storage,'postgresql');assert.equal(await db.product.count(),50);const result=await a.request('/api/products');assert.equal(result.data.total,50);assert.equal(result.data.items.length,12);assert.equal(result.data.pages,5);});
 await t.test('search by SKU, Russian product name, absent term and injection-shaped input',async()=>{
  assert.equal((await a.request('/api/products?q=TEST-0001')).data.items[0].id,'tire-m365');assert.ok((await a.request('/api/products?q='+encodeURIComponent('Покрышка'))).data.total>0);assert.equal((await a.request('/api/products?q=missing-qa-product')).data.total,0);assert.equal((await a.request('/api/products?q='+encodeURIComponent("' OR 1=1 --"))).data.total,0);
 });
 await t.test('brand, model, category and availability filters combine without false compatibility',async()=>{
  const result=(await a.request('/api/products?brand=Kugoo&model=M4&category=tires&inStock=1')).data;assert.equal(result.total,1);assert.equal(result.items[0].id,'fixture-kugoo-tires');assert.ok(result.items.every((p:{brand:string;models:string[];category:string;stock:number})=>p.brand==='Kugoo'&&p.models.includes('M4')&&p.category==='tires'&&p.stock>0));
  assert.equal((await a.request('/api/products?brand=Kugoo&model=M365')).data.total,0);assert.equal((await a.request('/api/products?brand=Unknown')).data.total,0);
 });
 await t.test('price range, sorting and stable pagination preserve filters',async()=>{
  const page=(await a.request('/api/products?minPrice=500&maxPrice=2000&inStock=1&sort=price-asc')).data;assert.ok(page.items.every((p:{price_cents:number;stock:number},i:number)=>p.price_cents>=50000&&p.price_cents<=200000&&p.stock>0&&(!i||page.items[i-1].price_cents<=p.price_cents)));
  const one=(await a.request('/api/products?page=1')).data,two=(await a.request('/api/products?page=2')).data;assert.ok(!one.items.some((p:{id:string})=>two.items.some((q:{id:string})=>p.id===q.id)));assert.equal((await a.request('/api/products?minPrice=3000&maxPrice=1')).status,400);assert.equal((await a.request('/api/products?page=-1')).status,400);
 });
 await t.test('product pages use their own URL and missing products return real HTTP 404',async()=>{assert.equal((await a.request('/api/products/tire-m365')).status,200);assert.equal((await a.request('/product/tire-m365')).status,200);assert.equal((await a.request('/product/missing-qa')).status,404);assert.equal((await a.request('/api/products/missing-qa')).status,404);});
 await t.test('quantity validation, forged prices, out-of-stock and session isolation',async()=>{
  assert.equal((await a.request('/api/cart',{method:'POST',body:{product_id:'charger-m365'}})).status,409);assert.equal((await a.request('/api/cart',{method:'POST',body:{product_id:'tire-m365',quantity:-1}})).status,422);assert.equal((await a.request('/api/cart',{method:'POST',body:{product_id:'invented',quantity:1}})).status,404);
  const cart=await a.request('/api/cart',{method:'POST',body:{product_id:'tire-m365',quantity:2,price_cents:1}});assert.equal(cart.data.total_cents,298000);assert.equal((await b.request('/api/cart')).data.count,0);assert.equal((await a.request('/api/cart/tire-m365',{method:'PUT',body:{quantity:99}})).status,409);
  const fresh=await client().request('/api/cart');assert.match(fresh.headers.get('set-cookie')||'',/HttpOnly/);assert.match(fresh.headers.get('set-cookie')||'',/SameSite=Strict/);initialStock=(await db.product.findUniqueOrThrow({where:{id:'tire-m365'}})).stock;
 });
 await t.test('cart update, deletion and clearing really persist',async()=>{
  await b.request('/api/cart',{method:'POST',body:{product_id:'tube-ninebot',quantity:2}});assert.equal((await b.request('/api/cart/tube-ninebot',{method:'PUT',body:{quantity:3}})).data.count,3);assert.equal((await b.request('/api/cart/tube-ninebot',{method:'DELETE'})).data.count,0);
  await b.request('/api/cart',{method:'POST',body:{product_id:'tube-ninebot'}});assert.equal((await b.request('/api/cart',{method:'DELETE'})).data.count,0);
 });
 await t.test('invalid contacts, consent and delivery reject checkout without changing inventory',async()=>{
  assert.equal((await a.request('/api/orders',{method:'POST',body:{...orderData,consent:false}})).status,422);assert.equal((await a.request('/api/orders',{method:'POST',body:{...orderData,email:'bad'}})).status,422);assert.equal((await a.request('/api/orders',{method:'POST',body:{...orderData,delivery:'delivery',address:'дом'}})).status,422);assert.equal((await db.product.findUniqueOrThrow({where:{id:'tire-m365'}})).stock,initialStock);
 });
 await t.test('concurrent identical checkout creates exactly one PostgreSQL order with authoritative cents',async()=>{
  const results=await Promise.all([a.request('/api/orders',{method:'POST',body:{...orderData,total_cents:1}}),a.request('/api/orders',{method:'POST',body:{...orderData,total_cents:1}})]);assert.deepEqual(results.map(r=>r.status).sort(),[200,201]);assert.equal(results[0]!.data.id,results[1]!.data.id);orderId=results[0]!.data.id;assert.equal(results[0]!.data.total_cents,298000);assert.equal(results[0]!.data.email,'');assert.equal(await db.shopOrder.count(),1);assert.equal(await db.orderItem.count(),1);assert.equal((await db.product.findUniqueOrThrow({where:{id:'tire-m365'}})).stock,initialStock-2);assert.equal((await a.request('/api/cart')).data.count,0);
 });
 await t.test('idempotency rejects changed payload and foreign sessions cannot read the order',async()=>{assert.equal((await b.request('/api/orders/'+orderId)).status,404);assert.equal((await a.request('/api/orders',{method:'POST',body:{...orderData,name:'Другое имя'}})).status,409);assert.equal((await a.request('/api/orders',{method:'POST',body:orderData})).status,200);assert.equal(await db.shopOrder.count(),1);});
 await t.test('two customers cannot oversell the final available item',async()=>{
  await db.product.update({where:{id:'fixture-kugoo-bearings'},data:{stock:1}});const x=client(),y=client();await Promise.all([x.request('/api/cart'),y.request('/api/cart')]);
  for(const c of [x,y])assert.equal((await c.request('/api/cart',{method:'POST',body:{product_id:'fixture-kugoo-bearings',quantity:1}})).status,200);
  const results=await Promise.all([x.request('/api/orders',{method:'POST',body:{...orderData,idempotency_key:'concurrent-stock-one-0001'}}),y.request('/api/orders',{method:'POST',body:{...orderData,idempotency_key:'concurrent-stock-two-0002'}})]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);assert.equal((await db.product.findUniqueOrThrow({where:{id:'fixture-kugoo-bearings'}})).stock,0);
 });
 await t.test('repair optional email, required fields, persistence and duplicate protection',async()=>{
  const data={name:'Клиент QA',phone:'+7 900 000-00-22',brand:'Kugoo',model:'M4',description:'Не включается после зарядки',consent:true,idempotency_key:'repair-idempotency-0001'};
  assert.equal((await a.request('/api/repairs',{method:'POST',body:{...data,description:'нет'}})).status,422);const one=await a.request('/api/repairs',{method:'POST',body:data}),two=await a.request('/api/repairs',{method:'POST',body:data});assert.equal(one.status,201);assert.equal(two.status,200);assert.equal(one.data.id,two.data.id);assert.equal(await db.repairRequest.count(),1);
 });
 await t.test('admin APIs reject anonymous visitors and passwords are hashed',async()=>{
  for(const path of ['/api/admin/session','/api/admin/products','/api/admin/orders','/api/admin/repairs'])assert.equal((await a.request(path)).status,401);
  const passwordHash=await hashPassword(adminPassword);assert.notEqual(passwordHash,adminPassword);assert.ok(await verifyPassword(adminPassword,passwordHash));assert.equal(await verifyPassword('incorrect',passwordHash),false);await db.admin.create({data:{email:adminEmail,passwordHash}});
 });
 await t.test('admin login uses a revocable HttpOnly session and never returns its token',async()=>{
  assert.equal((await manager.request('/api/admin/login',{method:'POST',body:{email:adminEmail,password:'wrong'}})).status,401);
  const result=await manager.request('/api/admin/login',{method:'POST',body:{email:adminEmail,password:adminPassword}});assert.equal(result.status,200);assert.match(result.headers.get('set-cookie')||'',/HttpOnly/);assert.match(result.headers.get('set-cookie')||'',/SameSite=Strict/);assert.ok((await db.adminSession.findFirst())?.id!==manager.cookies.get('kruga_admin'));assert.equal(result.data.password,undefined);
 });
 await t.test('admin edits current prices/stock, creates products and rejects mismatched models',async()=>{
  const input={slug:'tire-m365',sku:'TEST-0001',name:'Покрышка для Xiaomi M365',categoryId:'tires',brandId:'xiaomi',modelIds:['xiaomi-m365'],price:'1500.99',stock:8,description:'Тестовая покрышка. Совместимость проверяется по фикстуре.',specs:{Размер:'8.5'},images:['/placeholder.svg']};
  const result=await manager.request('/api/admin/products/tire-m365',{method:'PUT',body:input});assert.equal(result.status,200);assert.equal(result.data.price_cents,150099);assert.equal(result.data.stock,8);assert.equal((await manager.request('/api/admin/products/tire-m365',{method:'PUT',body:{...input,modelIds:['kugoo-m4']}})).status,422);
  const created=await manager.request('/api/admin/products',{method:'POST',body:{...input,slug:'admin-created-qa',sku:'QA-ADMIN-1',name:'Созданный товар QA'}});assert.equal(created.status,201);assert.equal((await a.request('/product/admin-created-qa')).status,200);assert.equal((await manager.request('/api/admin/products',{method:'POST',body:{...input,slug:'admin-created-qa',sku:'QA-ADMIN-1'}})).status,409);
 });
 await t.test('admin sees orders/repairs, changes order status and logout revokes access',async()=>{
  assert.ok((await manager.request('/api/admin/orders')).data.items.length>=1);assert.equal((await manager.request('/api/admin/repairs')).data.items.length,1);assert.equal((await manager.request('/api/admin/orders/'+orderId,{method:'PATCH',body:{status:'PROCESSING'}})).status,200);assert.equal((await a.request('/api/orders/'+orderId)).data.status,'PROCESSING');await manager.request('/api/admin/logout',{method:'POST'});assert.equal((await manager.request('/api/admin/products')).status,401);
 });
 await t.test('origin, DNS-rebinding host and private source files are rejected',async()=>{
  assert.equal((await a.request('/api/cart',{method:'POST',body:{product_id:'tire-m365'},origin:'https://evil.example'})).status,403);assert.equal((await a.request('/api/cart',{method:'POST',body:{product_id:'tire-m365'},origin:null})).status,403);assert.equal((await a.request('/api/cart',{method:'POST',body:{product_id:'tire-m365'},origin:'invalid-origin'})).status,403);const hostileStatus=await new Promise<number>((resolve,reject)=>{const request=httpRequest(base+'/api/config',{headers:{Host:'evil.example'}},response=>{response.resume();resolve(response.statusCode||0)});request.on('error',reject);request.end();});assert.equal(hostileStatus,403);
  for(const path of ['/data/store.sqlite','/.env','/src/server.ts','/server.mjs','/prisma/schema.prisma'])assert.equal((await a.request(path)).status,404);
 });
 await t.test('malformed JSON and oversized requests produce safe errors',async()=>{
  const malformed=await fetch(base+'/api/cart',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{broken'});assert.equal(malformed.status,400);
  const huge=await fetch(base+'/api/cart',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({text:'x'.repeat(70000)})});assert.equal(huge.status,413);assert.ok(!(await huge.text()).includes('stack'));
 });
 await t.test('saved orders, repairs and basket survive server and connection restart',async()=>{
  await b.request('/api/cart',{method:'POST',body:{product_id:'tube-ninebot',quantity:2}});await shop.close();db=createDb(url);shop=await createShop({db});await new Promise<void>(r=>shop.server.listen(0,'127.0.0.1',r));address=shop.server.address();assert.ok(address&&typeof address==='object');base='http://127.0.0.1:'+address.port;
  assert.equal((await a.request('/api/orders/'+orderId)).status,200);assert.equal((await b.request('/api/cart')).data.count,2);assert.equal(await db.repairRequest.count(),1);assert.equal((await db.product.findUniqueOrThrow({where:{id:'tire-m365'}})).priceCents,150099);
 });
 await t.test('database failures return a safe service error without credentials or stack traces',async()=>{
  const original=db.product.findMany;Object.defineProperty(db.product,'findMany',{configurable:true,writable:true,value:()=>{throw Error('password=private-database-secret')}});try{const response=await a.request('/api/products');assert.equal(response.status,503);assert.ok(!JSON.stringify(response.data).includes('private-database-secret'));}finally{Object.defineProperty(db.product,'findMany',{configurable:true,writable:true,value:original});}
 });
 await t.test('login brute-force limiting rejects repeated attempts',async()=>{let limited=false;for(let i=0;i<12;i++){const r=await manager.request('/api/admin/login',{method:'POST',body:{email:adminEmail,password:'incorrect'}});if(r.status===429){limited=true;assert.ok(r.headers.get('retry-after'));break;}}assert.ok(limited);});
 const counts={products:await db.product.count(),orders:await db.shopOrder.count(),orderItems:await db.orderItem.count(),repairs:await db.repairRequest.count()};writeFileSync('.state/postgres-integration-evidence.json',JSON.stringify({database:new URL(url).pathname,storage:'PostgreSQL',isolated:true,counts},null,2));
 }finally{await shop.close();}
});
