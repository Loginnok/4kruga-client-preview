import { existsSync,readFileSync,writeFileSync,mkdirSync } from "node:fs";
import {resolve,join} from "node:path";
import {execFileSync} from "node:child_process";
import {randomBytes} from "node:crypto";
import {config} from "dotenv";
mkdirSync('.state',{recursive:true});
writeFileSync('.state/node-path.txt',process.execPath,{mode:0o600});
const run=(program,args,options={})=>execFileSync(program,args,{stdio:'inherit',windowsHide:true,...options});
const fresh=!existsSync('.env');
if(fresh){const password=randomBytes(32).toString('hex');writeFileSync('.env',`DATABASE_URL=postgresql://kruga_app:${password}@127.0.0.1:55440/kruga_shop\nPORT=3000\nHOST=127.0.0.1\nADMIN_EMAIL=admin@localhost.test\n`,{mode:0o600});}
config({quiet:true});
const url=new URL(process.env.DATABASE_URL);
if(url.hostname==='127.0.0.1'&&url.port==='55440'&&url.pathname==='/kruga_shop'){
 if(process.platform!=='win32')throw Error('Start PostgreSQL with docker compose first, or configure DATABASE_URL.');
 const bin=process.env.PG_BIN||resolve('.state/postgres-runtime/bin');
 if(!existsSync(join(bin,'pg_ctl.exe')))run('powershell.exe',['-NoProfile','-File',resolve('scripts/download-postgres.ps1')]);
 const cluster=resolve('.state/postgres-data');const pwfile=resolve('.state/bootstrap-password.txt');
 if(!existsSync(pwfile))writeFileSync(pwfile,randomBytes(32).toString('hex'),{mode:0o600});
 if(!existsSync(join(cluster,'PG_VERSION')))run(join(bin,'initdb.exe'),['-D',cluster,'-U','kruga_bootstrap','--pwfile='+pwfile,'--auth=scram-sha-256','--encoding=UTF8','--locale-provider=icu','--icu-locale=und']);
 let running=false;try{execFileSync(join(bin,'pg_ctl.exe'),['status','-D',cluster],{stdio:'ignore',windowsHide:true});running=true;}catch{}
 if(!running)run(join(bin,'pg_ctl.exe'),['start','-D',cluster,'-l',resolve('.state/postgres.log'),'-o','-h 127.0.0.1 -p 55440','-w']);
 const env={...process.env,PGPASSWORD:readFileSync(pwfile,'utf8').trim()};
 const sql=(text)=>execFileSync(join(bin,'psql.exe'),['-h','127.0.0.1','-p','55440','-U','kruga_bootstrap','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],{input:text,env,windowsHide:true,encoding:'utf8'}).trim();
 const quote=v=>"'"+v.replaceAll("'","''")+"'";
 if(sql("SELECT 1 FROM pg_roles WHERE rolname='kruga_app';")!=='1')sql(`CREATE ROLE kruga_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${quote(decodeURIComponent(url.password))};`);
 if(sql("SELECT 1 FROM pg_database WHERE datname='kruga_shop';")!=='1')sql('CREATE DATABASE kruga_shop OWNER kruga_app;');
 const testEnv=resolve('.env.test.local');let testPassword;
 if(!existsSync(testEnv)){testPassword=randomBytes(32).toString('hex');writeFileSync(testEnv,`DATABASE_URL=postgresql://kruga_test:${testPassword}@127.0.0.1:55440/kruga_shop_test\n`,{mode:0o600});}else{testPassword=new URL(readFileSync(testEnv,'utf8').trim().split('=')[1]).password;}
 if(sql("SELECT 1 FROM pg_roles WHERE rolname='kruga_test';")!=='1')sql(`CREATE ROLE kruga_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${quote(testPassword)};`);
 if(sql("SELECT 1 FROM pg_database WHERE datname='kruga_shop_test';")!=='1')sql('CREATE DATABASE kruga_shop_test OWNER kruga_test;');
}
const node=process.execPath;
run(node,['node_modules/prisma/build/index.js','generate']);
run(node,['node_modules/prisma/build/index.js','migrate','deploy']);
run(node,['--import','tsx','prisma/seed.ts']);
run(node,['--import','tsx','scripts/admin-create.ts']);
console.log('Local PostgreSQL and catalog are ready. Run npm run build, then npm start.');
