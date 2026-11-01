import "dotenv/config";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { z, ZodError } from "zod";
import { createDb, type Db } from "./db.js";
import { previewAccess, type PreviewAccess } from "./preview.js";
import { storeConfig } from "./config.js";
import { token, hashToken, hashPassword, verifyPassword, Limiter } from "./security.js";
import { checkoutSchema, repairSchema, cartAddSchema, quantitySchema, loginSchema, productSchema, cents, orderStatusSchema } from "./validation.js";

class AppError extends Error { constructor(readonly status:number,message:string,readonly fields?:Record<string,string>){super(message);} }
function fail(status:number,message:string):never {throw new AppError(status,message);}
const productInclude={brand:true,category:true,compatibility:{include:{model:true}}} as const;
type ProductRow=Prisma.ProductGetPayload<{include:typeof productInclude}>;
function productJSON(p:ProductRow) {
 return {id:p.id,slug:p.slug,sku:p.sku,name:p.name,category:p.categoryId,category_name:p.category.name,brand:p.brand.name,brandId:p.brandId,models:p.compatibility.map(c=>c.model.name),modelIds:p.compatibility.map(c=>c.modelId),price_cents:p.priceCents,stock:p.stock,description:p.description,specs:p.specs,images:p.images,test_data:p.testData,source_url:p.sourceUrl,source_sku:p.sourceSku,source_availability:p.sourceAvailability,source_retrieved_at:p.sourceRetrievedAt};
}
async function readBody(req:IncomingMessage):Promise<unknown>{
 if(!req.headers['content-type']?.toLowerCase().startsWith('application/json'))fail(415,'Ожидается JSON');
 let size=0;const parts:Buffer[]=[];
 for await(const chunk of req){const part=Buffer.from(chunk);size+=part.length;if(size>65536)fail(413,'Слишком большой запрос');parts.push(part);}
 try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{return fail(400,'Некорректный JSON');}
}
const cookieValue=(req:IncomingMessage,name:string)=>(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
const types:Record<string,string>={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.webp':'image/webp','.ico':'image/x-icon'};
function queryInt(value:string|null,min:number,max:number,fallback:number) {if(value===null)return fallback;if(!/^\d+$/.test(value))fail(400,'Неверные параметры каталога');const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)fail(400,'Неверные параметры каталога');return n;}
function priceFilter(value:string|null){if(value===null||value==='')return undefined;if(!/^\d{1,6}(?:[.,]\d{1,2})?$/.test(value))fail(400,'Неверный диапазон цены');return cents(value);}
export async function createShop({db=createDb(),publicDir=fileURLToPath(new URL('../public/',import.meta.url)),preview=process.env.CLIENT_PREVIEW==='1',sourceOnly=preview||process.env.CATALOG_SOURCE==='official',access={publicOrigin:process.env.PREVIEW_PUBLIC_ORIGIN,user:process.env.PREVIEW_USER,passwordHash:process.env.PREVIEW_PASSWORD_SHA256,localOpen:process.env.PREVIEW_LOCAL_OPEN==='1'}}:{db?:Db;publicDir?:string;preview?:boolean;sourceOnly?:boolean;access?:PreviewAccess}={}){
 const previewGate=preview?previewAccess(access):null;
 await db.$connect();
 if(preview){const identity=await db.$queryRaw<Array<{name:string}>>`SELECT current_database() AS name`;if(!/^kruga_shop_preview(?:_test)?$/.test(identity[0]?.name||'')){await db.$disconnect();throw Error('CLIENT_PREVIEW requires a separate preview database');}}

 const limiter=new Limiter();const dummyHash=await hashPassword(token());
 async function lockSession(tx:Prisma.TransactionClient,sid:string){await tx.$queryRaw`SELECT "id" FROM "ShopSession" WHERE "id"=${sid} FOR UPDATE`;}
 async function session(req:IncomingMessage,res:ServerResponse){
  const raw=cookieValue(req,'kruga_session');const current=raw&&/^[a-f0-9]{64}$/.test(raw)?await db.shopSession.findUnique({where:{id:hashToken(raw)}}):null;
  if(current&&current.expiresAt.getTime()>Date.now())return current.id;
  const value=token();const created=await db.shopSession.create({data:{id:hashToken(value),expiresAt:new Date(Date.now()+30*86400000)}});
  res.setHeader('Set-Cookie',`kruga_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);return created.id;
 }
 async function admin(req:IncomingMessage){
  const raw=cookieValue(req,'kruga_admin');if(!raw||!/^[a-f0-9]{64}$/.test(raw))fail(401,'Требуется вход администратора');
  const value=await db.adminSession.findUnique({where:{id:hashToken(raw)},include:{admin:true}});
  if(!value||value.expiresAt.getTime()<=Date.now())fail(401,'Требуется вход администратора');return value;
 }
 async function getProduct(id:string){const product=await db.product.findFirst({where:{OR:[{id},{slug:id}],...(sourceOnly?{testData:false}:{})},include:productInclude});if(!product)fail(404,'Товар не найден');return product;}
 async function cart(sid:string){const rows=await db.cartItem.findMany({where:{sessionId:sid},orderBy:[{addedAt:'asc'},{productId:'asc'}],include:{product:{include:productInclude}}});const items=rows.map(row=>({...productJSON(row.product),quantity:row.quantity,line_total_cents:row.product.priceCents*row.quantity,available:row.product.stock>=row.quantity}));return {items,count:items.reduce((n,i)=>n+i.quantity,0),total_cents:items.reduce((n,i)=>n+i.line_total_cents,0),currency:'RUB',test_data:true};}
 async function orderView(id:string,sid?:string){const o=await db.shopOrder.findFirst({where:{id,...(sid?{sessionId:sid}:{})},include:{items:true}});if(!o)fail(404,'Заказ не найден');return {id:o.id,number:o.number,status:o.status,total_cents:Number(o.totalCents),customer_name:o.customerName,email:o.email,phone:o.phone,delivery:o.delivery,address:o.address,comment:o.comment,payment_method:o.paymentMethod,created_at:o.createdAt.toISOString(),items:o.items.map(i=>({product_id:i.productId,name:i.name,sku:i.sku,price_cents:i.priceCents,quantity:i.quantity})),test_order:true};}
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const send=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
   const address=server.address();const port=address&&typeof address==='object'?address.port:0;
   if(!['localhost:'+port,'127.0.0.1:'+port,...(previewGate?.host?[previewGate.host]:[])].includes((req.headers.host||'').toLowerCase()))fail(403,'Недопустимый адрес сервера');
   const url=new URL(req.url||'/','http://localhost');const path=url.pathname;const method=req.method||'GET';
   if(previewGate){
    res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');
    if(!previewGate.host&&(req.headers.forwarded||req.headers['x-forwarded-host']||req.headers['x-forwarded-for']))fail(403,'Внешний просмотр требует настройки HTTPS и авторизации');
    if(!limiter.take('preview:'+req.socket.remoteAddress,600,60000))return send(429,{error:'Слишком много запросов'});
    if(!previewGate.allowed(req.headers.authorization)){res.setHeader('WWW-Authenticate','Basic realm="4kruga client preview", charset="UTF-8"');return send(401,{error:'Требуется доступ к клиентскому просмотру'});}
    if(path==='/admin'||path.startsWith('/admin/')||path.startsWith('/api/admin')||path.startsWith('/orders/'))fail(404,'Страница не найдена');
    if(!['GET','HEAD'].includes(method))fail(403,'В режиме просмотра изменения и отправка заявок отключены');
    if(path.startsWith('/api/')&&!['/api/config','/api/catalog/meta','/api/products','/api/cart'].includes(path)&&!/^\/api\/products\/[a-z0-9-]+$/.test(path))fail(404,'Раздел не найден');
    if(path==='/api/cart')return send(200,{items:[],count:0,total_cents:0,currency:'RUB',read_only:true});
   }

   if(path.startsWith('/api/')){
    if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))fail(405,'Метод не поддерживается');
    const ip=req.socket.remoteAddress||'local';
    if(!limiter.take('api:'+ip,500,60000)){res.setHeader('Retry-After','60');fail(429,'Слишком много запросов. Повторите через минуту.');}
    if(method!=='GET'){
     const origin=req.headers.origin;
     let originHost='';try{originHost=origin?new URL(origin).host:'';}catch{fail(403,'Недопустимый источник запроса');}
     if(originHost!==req.headers.host||req.headers['sec-fetch-site']==='cross-site')fail(403,'Недопустимый источник запроса');
    }
    if(path==='/api/health'&&method==='GET'){await db.$queryRaw`SELECT 1`;return send(200,{ok:true,storage:'postgresql',mode:'local',catalogSource:'database'});}
    if(path==='/api/config'&&method==='GET')return send(200,{...storeConfig,clientPreview:preview,officialCatalog:sourceOnly});
    if(path==='/api/catalog/meta'&&method==='GET'){
     const [categories,brands]=await Promise.all([db.category.findMany({where:sourceOnly?{products:{some:{testData:false}}}:{},include:{products:{where:sourceOnly?{testData:false}:{},take:1,select:{images:true}}},orderBy:{sortOrder:'asc'}}),db.brand.findMany({where:sourceOnly?{products:{some:{testData:false}}}:{},include:{models:{where:sourceOnly?{compatibility:{some:{product:{testData:false}}}}:{},orderBy:{name:'asc'}}},orderBy:{name:'asc'}})]);
     return send(200,{categories:categories.map(c=>({id:c.id,name:c.name,image:c.products[0]?.images[0]})),brands:Object.fromEntries(brands.map(b=>[b.name,b.models.map(m=>m.name)])),brandRecords:brands.map(b=>({id:b.id,name:b.name,models:b.models.map(m=>({id:m.id,name:m.name}))})),test_data:true});
    }
    if(path==='/api/products'&&method==='GET'){
     const page=queryInt(url.searchParams.get('page'),1,100000,1),pageSize=queryInt(url.searchParams.get('pageSize'),1,48,12);
     const q=(url.searchParams.get('q')||'').trim();if(q.length>100)fail(400,'Поисковый запрос слишком длинный');
     const brand=url.searchParams.get('brand')||'',model=url.searchParams.get('model')||'',category=url.searchParams.get('category')||'';
     if([brand,model,category].some(v=>v.length>100))fail(400,'Неверные фильтры');
     const min=priceFilter(url.searchParams.get('minPrice')),max=priceFilter(url.searchParams.get('maxPrice'));
     if(min!==undefined&&max!==undefined&&min>max)fail(400,'Минимальная цена больше максимальной');
     const sort=url.searchParams.get('sort')||'default';if(!['default','price-asc','price-desc','name','name-desc'].includes(sort))fail(400,'Неизвестная сортировка');
     const where:Prisma.ProductWhereInput={...(sourceOnly?{testData:false}:{}),...(category?{categoryId:category}:{}),...(brand?{brand:{name:brand}}:{}),...(model?{compatibility:{some:{model:{name:model,...(brand?{brand:{name:brand}}:{})}}}}:{}),...(url.searchParams.get('inStock')==='1'?(sourceOnly?{sourceAvailability:{in:['InStock','LimitedAvailability']}}:{stock:{gt:0}}):{}),...((min!==undefined||max!==undefined)?{priceCents:{...(min!==undefined?{gte:min}:{}),...(max!==undefined?{lte:max}:{})}}:{}),...(q?{AND:q.split(/\s+/).map(term=>({OR:[{name:{contains:term,mode:'insensitive'}},{sku:{contains:term,mode:'insensitive'}}]}))}:{})};
     const orderBy:Prisma.ProductOrderByWithRelationInput[]=sort==='price-asc'?[{priceCents:'asc'},{id:'asc'}]:sort==='price-desc'?[{priceCents:'desc'},{id:'asc'}]:sort==='name'?[{name:'asc'},{id:'asc'}]:sort==='name-desc'?[{name:'desc'},{id:'asc'}]:[{createdAt:'asc'},{id:'asc'}];
     const [total,items]=await db.$transaction([db.product.count({where}),db.product.findMany({where,include:productInclude,orderBy,skip:(page-1)*pageSize,take:pageSize})]);
     return send(200,{items:items.map(productJSON),total,page,pageSize,pages:Math.ceil(total/pageSize),test_data:true});
    }
    const match=path.match(/^\/api\/products\/([a-z0-9-]+)$/);
    if(match&&method==='GET'){const p=await getProduct(match[1]!);const related=await db.product.findMany({where:{categoryId:p.categoryId,id:{not:p.id},...(sourceOnly?{testData:false}:{})},include:productInclude,take:4,orderBy:{name:'asc'}});return send(200,{...productJSON(p),related:related.map(productJSON)});}
    if(path.startsWith('/api/admin')){
     if(path==='/api/admin/login'&&method==='POST'){
      if(!limiter.take('login:'+ip,10,15*60000)){res.setHeader('Retry-After','900');fail(429,'Слишком много попыток входа. Подождите 15 минут.');}
      const data=loginSchema.parse(await readBody(req));const account=await db.admin.findUnique({where:{email:data.email}});
      const valid=await verifyPassword(data.password,account?.passwordHash||dummyHash);if(!account||!valid)fail(401,'Неверные данные для входа');
      const raw=token();await db.adminSession.create({data:{id:hashToken(raw),adminId:account.id,expiresAt:new Date(Date.now()+12*3600000)}});
      res.setHeader('Set-Cookie',`kruga_admin=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);return send(200,{email:account.email});
     }
     const identity=await admin(req);
     if(path==='/api/admin/session'&&method==='GET')return send(200,{email:identity.admin.email});
     if(path==='/api/admin/logout'&&method==='POST'){await db.adminSession.deleteMany({where:{id:identity.id}});res.setHeader('Set-Cookie','kruga_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(200,{ok:true});}
     if(path==='/api/admin/products'&&method==='GET'){const items=await db.product.findMany({include:productInclude,orderBy:{name:'asc'}});return send(200,{items:items.map(productJSON)});}
     const edit=path.match(/^\/api\/admin\/products\/([a-zA-Z0-9-]+)$/);
     if((path==='/api/admin/products'&&method==='POST')||(edit&&method==='PUT')){
      const data=productSchema.parse(await readBody(req));const models=await db.scooterModel.findMany({where:{id:{in:data.modelIds},brandId:data.brandId}});
      if(models.length!==new Set(data.modelIds).size)fail(422,'Модели должны принадлежать выбранному бренду');
      const fields={slug:data.slug,sku:data.sku,name:data.name,categoryId:data.categoryId,brandId:data.brandId,priceCents:cents(data.price),stock:data.stock,description:data.description,specs:data.specs,images:data.images,testData:true};
      const saved=await db.$transaction(async tx=>{
       const product=edit?await tx.product.update({where:{id:edit[1]},data:fields}):await tx.product.create({data:{id:randomUUID(),...fields}});
       await tx.compatibility.deleteMany({where:{productId:product.id}});await tx.compatibility.createMany({data:models.map(m=>({productId:product.id,modelId:m.id}))});return tx.product.findUniqueOrThrow({where:{id:product.id},include:productInclude});
      });return send(edit?200:201,productJSON(saved));
     }
     if(path==='/api/admin/orders'&&method==='GET'){const items=await db.shopOrder.findMany({orderBy:{createdAt:'desc'},take:200,include:{items:true}});return send(200,{items:items.map(o=>({...o,totalCents:Number(o.totalCents)}))});}
     const status=path.match(/^\/api\/admin\/orders\/([a-f0-9-]+)$/);
     if(status&&method==='PATCH'){const value=orderStatusSchema.parse(await readBody(req));await db.shopOrder.update({where:{id:status[1]},data:{status:value.status}});return send(200,{ok:true,status:value.status});}
     if(path==='/api/admin/repairs'&&method==='GET')return send(200,{items:await db.repairRequest.findMany({orderBy:{createdAt:'desc'},take:200})});
     fail(404,'Раздел не найден');
    }
    if(path.startsWith('/api/cart')||path.startsWith('/api/orders')||path==='/api/repairs'){
     const sid=await session(req,res);
     if(path==='/api/cart'&&method==='GET')return send(200,await cart(sid));
     if(path==='/api/cart'&&method==='POST'){
      const data=cartAddSchema.parse(await readBody(req));
      await db.$transaction(async tx=>{
       await lockSession(tx,sid);const p=await tx.product.findUnique({where:{id:data.product_id}});if(!p)fail(404,'Товар не найден');
       const previous=await tx.cartItem.findUnique({where:{sessionId_productId:{sessionId:sid,productId:p.id}}});const quantity=(previous?.quantity||0)+data.quantity;
       if(quantity>99||quantity>p.stock)fail(409,'Недостаточно товара в наличии');
       if(!previous&&await tx.cartItem.count({where:{sessionId:sid}})>=50)fail(422,'В корзине не может быть больше 50 разных товаров');
       await tx.cartItem.upsert({where:{sessionId_productId:{sessionId:sid,productId:p.id}},create:{sessionId:sid,productId:p.id,quantity},update:{quantity}});
      });return send(200,await cart(sid));
     }
     if(path==='/api/cart'&&method==='DELETE'){await db.$transaction(async tx=>{await lockSession(tx,sid);await tx.cartItem.deleteMany({where:{sessionId:sid}})});return send(200,await cart(sid));}
     const line=path.match(/^\/api\/cart\/([a-zA-Z0-9-]+)$/);
     if(line&&(method==='PUT'||method==='DELETE')){
      const quantity=method==='PUT'?quantitySchema.parse(z.object({quantity:quantitySchema}).parse(await readBody(req)).quantity):0;
      await db.$transaction(async tx=>{
       await lockSession(tx,sid);if(method==='DELETE'){await tx.cartItem.deleteMany({where:{sessionId:sid,productId:line[1]}});return;}
       const p=await tx.product.findUnique({where:{id:line[1]}});if(!p)fail(404,'Товар не найден');if(quantity>p.stock)fail(409,'Недостаточно товара в наличии');
       const result=await tx.cartItem.updateMany({where:{sessionId:sid,productId:p.id},data:{quantity}});if(!result.count)fail(404,'Товар отсутствует в корзине');
      });return send(200,await cart(sid));
     }
     if(path==='/api/orders'&&method==='POST'){
      const data=checkoutSchema.parse(await readBody(req));const fingerprint=hashToken(JSON.stringify(data));
      const result=await db.$transaction(async tx=>{
       await lockSession(tx,sid);const existing=await tx.shopOrder.findUnique({where:{sessionId_idempotencyKey:{sessionId:sid,idempotencyKey:data.idempotency_key}}});
       if(existing){if(existing.requestHash!==fingerprint)fail(409,'Этот ключ уже использован с другими данными');return {id:existing.id,replayed:true};}
       const rows=await tx.cartItem.findMany({where:{sessionId:sid}});if(!rows.length)fail(422,'Корзина пуста');
       const ids=rows.map(r=>r.productId).sort();await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
       const products=await tx.product.findMany({where:{id:{in:ids}}});let total=0;
       for(const row of rows){const p=products.find(p=>p.id===row.productId);if(!p||p.stock<row.quantity)fail(409,'Наличие изменилось. Проверьте корзину.');total+=p.priceCents*row.quantity;}
       if(!Number.isSafeInteger(total)||total<0)fail(422,'Невозможно рассчитать сумму');
       const id=randomUUID();const number='4K-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'-'+token().slice(0,10).toUpperCase();
       await tx.shopOrder.create({data:{id,number,sessionId:sid,idempotencyKey:data.idempotency_key,requestHash:fingerprint,totalCents:BigInt(total),customerName:data.name,phone:data.phone,email:data.email,delivery:data.delivery,address:data.delivery==='delivery'?data.address:'',comment:data.comment,consentVersion:storeConfig.consentVersion,consentAt:new Date(),items:{create:rows.map(row=>{const p=products.find(p=>p.id===row.productId)!;return {productId:p.id,name:p.name,sku:p.sku,priceCents:p.priceCents,quantity:row.quantity};})}}});
       for(const row of rows)await tx.product.update({where:{id:row.productId},data:{stock:{decrement:row.quantity}}});
       await tx.cartItem.deleteMany({where:{sessionId:sid}});return {id,replayed:false};
      },{timeout:10000});return send(result.replayed?200:201,await orderView(result.id,sid));
     }
     const order=path.match(/^\/api\/orders\/([a-f0-9-]+)$/);if(order&&method==='GET')return send(200,await orderView(order[1]!,sid));
     if(path==='/api/repairs'&&method==='POST'){
      const data=repairSchema.parse(await readBody(req));const fingerprint=hashToken(JSON.stringify(data));
      const result=await db.$transaction(async tx=>{
       await lockSession(tx,sid);const old=await tx.repairRequest.findUnique({where:{sessionId_idempotencyKey:{sessionId:sid,idempotencyKey:data.idempotency_key}}});
       if(old){if(old.requestHash!==fingerprint)fail(409,'Этот ключ уже использован с другими данными');return {row:old,replayed:true};}
       const row=await tx.repairRequest.create({data:{id:randomUUID(),number:'R-'+token().slice(0,10).toUpperCase(),sessionId:sid,idempotencyKey:data.idempotency_key,requestHash:fingerprint,customerName:data.name,phone:data.phone,email:data.email,brand:data.brand,model:data.model,description:data.description,consentVersion:storeConfig.consentVersion,consentAt:new Date()}});return {row,replayed:false};
      });return send(result.replayed?200:201,{id:result.row.id,number:result.row.number,status:result.row.status,local:true});
     }
    }
    fail(404,'Раздел не найден');
   }
   if(method!=='GET'&&method!=='HEAD')fail(405,'Метод не поддерживается');
   const publicRoutes=['/','/catalog','/cart','/checkout','/repair','/admin','/privacy','/delivery'];
   if(publicRoutes.includes(path)||/^\/(product|orders)\/[a-zA-Z0-9-]+$/.test(path)){
    let status=200;
    if(path.startsWith('/product/')&&!await db.product.findFirst({where:{slug:path.split('/')[2],...(sourceOnly?{testData:false}:{})}}))status=404;
    res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(method==='HEAD'?undefined:await readFile(resolve(publicDir,'index.html')));
   }
   const name=decodeURIComponent(path);const file=resolve(publicDir,'.'+name);
   const relative=name.replace(/^\//,'');if(!/^[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+$/.test(relative)||relative.includes('..')||!types[extname(file)]||!file.startsWith(resolve(publicDir)))fail(404,'Страница не найдена');
   const info=await stat(file).catch(()=>null);if(!info?.isFile())fail(404,'Страница не найдена');
   res.writeHead(200,{'Content-Type':types[extname(file)],'Cache-Control':'no-cache'});return res.end(method==='HEAD'?undefined:await readFile(file));
  }catch(error){
   if(res.headersSent){res.end();return;}
   if(error instanceof ZodError){const fields:Record<string,string>={};for(const issue of error.issues)fields[String(issue.path[0]||'form')]=issue.message;return send(422,{error:'Проверьте заполнение формы',fields});}
   if(error instanceof AppError)return send(error.status,{error:error.message,...(error.fields?{fields:error.fields}:{})});
   if(error instanceof Prisma.PrismaClientKnownRequestError){if(error.code==='P2002')return send(409,{error:'Такая запись уже существует'});if(error.code==='P2025')return send(404,{error:'Запись не найдена'});if(error.code==='P2003')return send(422,{error:'Проверьте категорию, бренд и модель'});}
   return send(503,{error:'Сервер временно недоступен. Повторите запрос.'});
  }
 });
 server.requestTimeout=15000;server.headersTimeout=16000;server.keepAliveTimeout=5000;
 return {server,db,close:async()=>{if(server.listening)await new Promise<void>((r,e)=>server.close(error=>error?e(error):r()));await db.$disconnect();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
 if(host!=='127.0.0.1'||!Number.isInteger(port)||port<1024||port>65535)throw new Error('Local host and valid port required');
 createShop().then(shop=>{shop.server.listen(port,host,()=>console.log(`4 круга: http://localhost:${port}`));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void shop.close().then(()=>process.exit(0))});}).catch(()=>{console.error('Не удалось запустить магазин. Проверьте PostgreSQL и локальную конфигурацию.');process.exitCode=1;});
}
