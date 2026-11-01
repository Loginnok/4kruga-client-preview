import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readCatalog} from '../public/catalog-reader.js';
const source=JSON.parse(readFileSync('prisma/official-catalog.json','utf8'));
const snapshot={...source,config:source.contacts};
test('Pages snapshot preserves verified product prices and local assets',()=>{
 const result=readCatalog(snapshot,'/products?pageSize=48',{},'/4kruga-client-preview');assert.equal(result.total,source.products.length);
 for(const p of result.items){const original=source.products.find(item=>item.id===p.id);assert.equal(p.price_cents,original.priceCents);assert.equal(p.name,original.name);assert.ok(p.images.every(url=>url.startsWith('/4kruga-client-preview/media/4kruga/')));}
});
test('Pages combined filters, price ranges and stock match the snapshot',()=>{
 const p=source.products.find(p=>p.brand==='Xiaomi'&&p.models.includes('M365'));const result=readCatalog(snapshot,'/products?brand=Xiaomi&model=M365&category='+p.category+'&inStock=1&minPrice=1,00&maxPrice=999999');
 assert.deepEqual(result.items.map(p=>p.id).sort(),source.products.filter(v=>v.brand==='Xiaomi'&&v.models.includes('M365')&&v.category===p.category&&['InStock','LimitedAvailability'].includes(v.sourceAvailability)&&v.priceCents>=100).map(p=>p.id).sort());
 assert.equal(readCatalog(snapshot,'/products?q=nonexistent-product-123').total,0);
});
test('Pages sort and pagination are deterministic',()=>{
 const first=readCatalog(snapshot,'/products?sort=price-asc&pageSize=5');const second=readCatalog(snapshot,'/products?sort=price-asc&pageSize=5&page=2');assert.equal(first.items.length,5);assert.ok(first.items.every((p,i,a)=>!i||a[i-1].price_cents<=p.price_cents));assert.ok(first.items[4].price_cents<=second.items[0].price_cents);assert.equal(new Set([...first.items,...second.items].map(p=>p.id)).size,10);assert.deepEqual(first,readCatalog(snapshot,'/products?sort=price-asc&pageSize=5'));
});
test('Pages product routes and metadata preserve compatibility',()=>{
 const p=source.products[0];assert.equal(readCatalog(snapshot,'/products/'+p.slug).name,p.name);const meta=readCatalog(snapshot,'/catalog/meta');assert.equal(meta.categories.length,source.categories.length);assert.ok(meta.brands.Xiaomi);assert.throws(()=>readCatalog(snapshot,'/products/unknown'),{status:404});
});
test('Pages data reader blocks all writes and private resources',()=>{
 for(const method of ['POST','PUT','PATCH','DELETE'])for(const path of ['/orders','/repairs','/cart','/admin/login'])assert.throws(()=>readCatalog(snapshot,path,{method}),{status:403});
 for(const path of ['/admin/session','/orders','/health'])assert.throws(()=>readCatalog(snapshot,path),{status:404});assert.equal(readCatalog(snapshot,'/config').clientPreview,true);
});
test('Pages rejects invalid filter ranges, page sizes and sort values',()=>{
 for(const query of ['minPrice=-1','minPrice=2&maxPrice=1','page=0','pageSize=1000','sort=unknown'])assert.throws(()=>readCatalog(snapshot,'/products?'+query),{status:400});
});
