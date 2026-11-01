import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {parse} from 'dotenv';
import catalog from '../prisma/official-catalog.json' with {type:'json'};
import {createDb} from '../src/db.js';
import {createShop} from '../src/server.js';
import {hashToken} from '../src/security.js';
import {previewAccess} from '../src/preview.js';
import {importOfficial} from '../prisma/import-official.js';

test('CLIENT_PREVIEW acceptance on an isolated PostgreSQL database',async t=>{
 const environment=parse(readFileSync('.env.preview-test.local','utf8'));
 assert.equal(new URL(environment.DATABASE_URL!).pathname,'/kruga_shop_preview_test');
 const owner=createDb(environment.DATABASE_URL);await importOfficial(owner);
 const db=createDb(environment.PREVIEW_READER_URL);
 const shop=await createShop({db,preview:true,access:{localOpen:true}});
 await new Promise<void>(resolve=>shop.server.listen(0,'127.0.0.1',resolve));
 const address=shop.server.address();assert.ok(address&&typeof address==='object');
 const base='http://127.0.0.1:'+address.port;
 try{
  await t.test('official data uses verified names, exact prices and local photos',async()=>{
   const response=await fetch(base+'/api/products?pageSize=48');assert.equal(response.status,200);const data=await response.json();assert.equal(data.total,catalog.products.length);assert.ok(data.total>=30);
   for(const p of data.items){const source=catalog.products.find(s=>s.id===p.id);assert.ok(source);assert.equal(p.name,source.name);assert.equal(p.price_cents,source.priceCents);assert.equal(p.test_data,false);assert.ok(p.images.every((image:string)=>image.startsWith('/media/4kruga/')&&!image.includes('placeholder')));}
  });
  await t.test('original logo and all optimized photos exist and are served locally',async()=>{
   for(const image of catalog.images){assert.ok(existsSync('public'+image.local));const response=await fetch(base+image.local);assert.equal(response.status,200);assert.match(response.headers.get('content-type')||'',/image\/webp/);assert.ok((await response.arrayBuffer()).byteLength>100);}
   const logo=await fetch(base+catalog.logo.local);assert.equal(logo.status,200);assert.equal(hashToken(Buffer.from(await logo.arrayBuffer()).toString('base64')),hashToken(readFileSync('public'+catalog.logo.local).toString('base64')));
  });
  await t.test('combined real catalog filters do not introduce unconfirmed compatibility',async()=>{
   const candidate=catalog.products.find(p=>p.brand==='Xiaomi'&&(p.models as string[]).includes('M365'))!;
   const response=await fetch(base+'/api/products?brand=Xiaomi&model=M365&category='+candidate.category);const data=await response.json();assert.ok(data.total>0);assert.ok(data.items.every((p:{brand:string;models:string[];category:string})=>p.brand==='Xiaomi'&&(p.models as string[]).includes('M365')&&p.category===candidate.category));
   assert.equal((await (await fetch(base+'/api/products?brand=Dualtron&model=Imaginary')).json()).total,0);
  });
  await t.test('admin, service APIs, order lookup and private files are blocked',async()=>{
   for(const route of ['/admin','/admin/','/api/admin/products','/api/admin/session','/api/health','/api/orders','/.env','/.env.preview.local','/src/server.ts','/prisma/official-catalog.json','/orders/00000000-0000-0000-0000-000000000000'])assert.equal((await fetch(base+route)).status,404,route);
  });
  await t.test('all mutation methods are rejected without creating sessions, orders or repairs',async()=>{
   const before=[await owner.shopOrder.count(),await owner.repairRequest.count(),await owner.shopSession.count(),await owner.admin.count()];
   for(const route of ['/api/orders','/api/repairs','/api/cart','/api/admin/login','/checkout','/repair'])for(const method of ['POST','PUT','DELETE','PATCH'])assert.ok([403,404].includes((await fetch(base+route,{method,headers:{Origin:base,'Content-Type':'application/json'},body:'{}'})).status));
   assert.deepEqual([await owner.shopOrder.count(),await owner.repairRequest.count(),await owner.shopSession.count(),await owner.admin.count()],before);assert.deepEqual(before,[0,0,0,0]);
   const cart=await fetch(base+'/api/cart');assert.equal(cart.headers.get('set-cookie'),null);assert.equal((await cart.json()).count,0);
  });
  await t.test('database role is read-only and cannot inspect administrator tables',async()=>{
   await assert.rejects(db.$executeRaw`INSERT INTO "ShopSession" ("id","expiresAt") VALUES ('preview-write-test',NOW())`);
   await assert.rejects(db.$queryRaw`SELECT * FROM "Admin"`);
  });
  await t.test('local preview rejects an unconfigured reverse proxy',async()=>{
   assert.equal((await fetch(base+'/api/config',{headers:{'X-Forwarded-For':'192.0.2.10'}})).status,403);
  });
  await t.test('external preview fails closed without HTTPS and access credentials',()=>{
   assert.throws(()=>previewAccess({publicOrigin:'http://preview.example.test',localOpen:true}));
   assert.throws(()=>previewAccess({publicOrigin:'https://preview.example.test',localOpen:true}));
   assert.throws(()=>previewAccess({}));
   const gate=previewAccess({publicOrigin:'https://preview.example.test',user:'client',passwordHash:hashToken('synthetic-test-password'),localOpen:true});
   assert.equal(gate.allowed(undefined),false);assert.equal(gate.allowed('Basic '+Buffer.from('client:wrong').toString('base64')),false);assert.equal(gate.allowed('Basic '+Buffer.from('client:synthetic-test-password').toString('base64')),true);
  });
  await t.test('HTTP authentication covers pages, APIs and image assets',async()=>{
   const secured=await createShop({db:createDb(environment.PREVIEW_READER_URL),preview:true,access:{user:'client',passwordHash:hashToken('synthetic-test-password')}});
   try{await new Promise<void>(resolve=>secured.server.listen(0,'127.0.0.1',resolve));const address=secured.server.address();assert.ok(address&&typeof address==='object');const endpoint='http://127.0.0.1:'+address.port;
    for(const route of ['/','/api/config',catalog.images[0]!.local]){const response=await fetch(endpoint+route);assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate')||'',/Basic/);const allowed=await fetch(endpoint+route,{headers:{Authorization:'Basic '+Buffer.from('client:synthetic-test-password').toString('base64')}});assert.equal(allowed.status,200);assert.match(allowed.headers.get('x-robots-tag')||'',/noindex/);}
   }finally{await secured.close();}
  });
 }finally{await shop.close();await owner.$disconnect();}
});
