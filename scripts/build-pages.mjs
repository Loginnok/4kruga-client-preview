import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {resolve} from 'node:path';
const base=process.env.PAGES_BASE_PATH||'/4kruga-client-preview';
if(!/^\/[a-z0-9-]+$/.test(base))throw Error('Expected a single repository path');
const catalog=JSON.parse(await readFile('prisma/official-catalog.json','utf8'));
const output=resolve('docs');await mkdir(output,{recursive:true});
await cp('public',output,{recursive:true});
const snapshot={categories:catalog.categories,products:catalog.products,config:{...catalog.contacts,catalogSnapshotAt:catalog.retrievedAt,localNotice:'Клиентский просмотр. Заказы и заявки отключены.',consentVersion:'static-preview-2026-11-01'}};
await writeFile(resolve(output,'catalog-snapshot.json'),JSON.stringify(snapshot));
let html=await readFile('public/index.html','utf8');
html=html.replace('<html lang="ru">',`<html lang="ru" data-base-path="${base}" data-static-preview="1">`).replace('<meta name="description"','<meta name="robots" content="noindex,nofollow"><meta name="description"');
html=html.replace(/(href|src)="\/(?!\/)/g,`$1="${base}/`);
const routes=['','catalog','repair','cart','checkout','privacy','delivery',...catalog.products.map(p=>'product/'+p.slug)];
for(const route of routes){const dir=resolve(output,route);if(dir!==output&&!dir.startsWith(output+'/')&&!dir.startsWith(output+'\\'))throw Error('Invalid export path');await mkdir(dir,{recursive:true});await writeFile(resolve(dir,'index.html'),html);}
await writeFile(resolve(output,'404.html'),html);await writeFile(resolve(output,'.nojekyll'),'');await writeFile(resolve(output,'robots.txt'),'User-agent: *\nDisallow: /\n');
console.log(JSON.stringify({output:'docs',base,products:catalog.products.length,photos:catalog.images.length,routes:routes.length,mode:'public read-only catalog; no backend or checkout'}));
