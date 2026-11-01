function fail(status,message){const error=new Error(message);error.status=status;throw error;}
const idFor=(brand,model)=>'snapshot-'+encodeURIComponent(brand+'-'+model);
const count=(value,min,max,fallback)=>{if(value===null)return fallback;if(!/^\d+$/.test(value)||Number(value)<min||Number(value)>max)fail(400,'Неверные параметры каталога');return Number(value);};
function price(value){if(value===null||value==='')return undefined;if(!/^\d{1,6}(?:[.,]\d{1,2})?$/.test(value))fail(400,'Неверный диапазон цены');const [whole,fraction='']=value.replace(',','.').split('.');return Number(whole)*100+Number(fraction.padEnd(2,'0'));}
export function readCatalog(snapshot,path,options={},base=''){
 if(!['GET','HEAD'].includes(options.method||'GET'))fail(403,'В режиме просмотра изменения и отправка заявок отключены');
 const url=new URL(path,'https://snapshot.invalid');
 const categories=snapshot.categories.map(([id,name])=>({id,name,image:snapshot.products.find(p=>p.category===id)?.images[0]}));
 const modelNames=brand=>[...new Set(snapshot.products.filter(p=>p.brand===brand).flatMap(p=>p.models))].sort((a,b)=>a.localeCompare(b,'ru'));
 const brands=Object.fromEntries([...new Set(snapshot.products.map(p=>p.brand))].sort().map(b=>[b,modelNames(b)]));
 const product=p=>({id:p.id,slug:p.slug,sku:p.sku,name:p.name,category:p.category,category_name:categories.find(c=>c.id===p.category)?.name,brand:p.brand,brandId:p.brand.toLowerCase(),models:p.models,modelIds:p.models.map(m=>idFor(p.brand,m)),price_cents:p.priceCents,stock:0,description:p.description,specs:p.specs,images:p.images.map(src=>base+src),test_data:false,source_url:p.sourceUrl,source_sku:p.sourceSku,source_availability:p.sourceAvailability,source_retrieved_at:p.retrievedAt});
 if(url.pathname==='/config')return {...snapshot.config,clientPreview:true,officialCatalog:true,staticHosting:true};
 if(url.pathname==='/cart')return {items:[],count:0,total_cents:0,currency:'RUB',read_only:true};
 if(url.pathname==='/catalog/meta')return {categories:categories.map(c=>({...c,image:c.image?base+c.image:undefined})),brands,brandRecords:Object.entries(brands).map(([name,models])=>({id:name.toLowerCase(),name,models:models.map(m=>({id:idFor(name,m),name:m}))})),test_data:false};
 if(url.pathname==='/products'){
  const q=url.searchParams;const page=count(q.get('page'),1,100000,1),pageSize=count(q.get('pageSize'),1,48,12);
  const search=(q.get('q')||'').trim(),brand=q.get('brand')||'',model=q.get('model')||'',category=q.get('category')||'';
  if([search,brand,model,category].some(v=>v.length>100))fail(400,'Неверные фильтры');
  const min=price(q.get('minPrice')),max=price(q.get('maxPrice'));if(min!==undefined&&max!==undefined&&min>max)fail(400,'Минимальная цена больше максимальной');
  const sort=q.get('sort')||'default';if(!['default','price-asc','price-desc','name','name-desc'].includes(sort))fail(400,'Неизвестная сортировка');
  const terms=search.toLocaleLowerCase('ru').split(/\s+/).filter(Boolean);
  const items=snapshot.products.filter(p=>(!brand||p.brand===brand)&&(!model||p.models.includes(model))&&(!category||p.category===category)&&(q.get('inStock')!=='1'||['InStock','LimitedAvailability'].includes(p.sourceAvailability))&&(min===undefined||p.priceCents>=min)&&(max===undefined||p.priceCents<=max)&&terms.every(t=>p.name.toLocaleLowerCase('ru').includes(t)||p.sku.toLowerCase().includes(t)));
  if(sort!=='default')items.sort((a,b)=>(sort.startsWith('price')?(a.priceCents-b.priceCents)*(sort==='price-desc'?-1:1):a.name.localeCompare(b.name,'ru')*(sort==='name-desc'?-1:1))||a.id.localeCompare(b.id));
  return {items:items.slice((page-1)*pageSize,page*pageSize).map(product),total:items.length,page,pageSize,pages:Math.ceil(items.length/pageSize),test_data:false};
 }
 if(/^\/products\/[a-z0-9-]+$/.test(url.pathname)){
  const key=url.pathname.split('/')[2],p=snapshot.products.find(p=>p.id===key||p.slug===key);if(!p)fail(404,'Товар не найден');
  return {...product(p),related:snapshot.products.filter(other=>other.category===p.category&&other.id!==p.id).sort((a,b)=>a.name.localeCompare(b.name,'ru')).slice(0,4).map(product)};
 }
 fail(404,'Раздел недоступен в режиме просмотра');
}
