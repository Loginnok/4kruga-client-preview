import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {config} from 'dotenv';
import pg from 'pg';
config({quiet:true});
mkdirSync('.state',{recursive:true});
const runtime=existsSync('.state/node-path.txt')?readFileSync('.state/node-path.txt','utf8').trim():process.execPath;
const statePath='.state/preview-secrets.json';
const secrets=existsSync(statePath)?JSON.parse(readFileSync(statePath,'utf8')):{owner:randomBytes(32).toString('hex'),reader:randomBytes(32).toString('hex'),access:randomBytes(24).toString('base64url')};
writeFileSync(statePath,JSON.stringify(secrets),{mode:0o600});
const base=new URL(process.env.DATABASE_URL);
if(base.hostname!=='127.0.0.1'||base.port!=='55440')throw Error('This setup only manages the isolated local PostgreSQL cluster');
const client=new pg.Client({host:'127.0.0.1',port:55440,database:'postgres',user:'kruga_bootstrap',password:readFileSync('.state/bootstrap-password.txt','utf8').trim()});
await client.connect();
try{
 for(const [role,password] of [['kruga_preview_owner',secrets.owner],['kruga_preview_read',secrets.reader]])if(!(await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}'`);
 await client.query('ALTER ROLE kruga_preview_read SET default_transaction_read_only=on');
 for(const name of ['kruga_shop_preview','kruga_shop_preview_test'])if(!(await client.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount)await client.query(`CREATE DATABASE ${name} OWNER kruga_preview_owner`);
}finally{await client.end();}
const url=(name,user,password)=>`postgresql://${user}:${password}@127.0.0.1:55440/${name}`;
const run=(args,env)=>execFileSync(runtime,args,{stdio:'inherit',windowsHide:true,env:{...process.env,...env}});
run(['node_modules/prisma/build/index.js','generate'],{});
for(const name of ['kruga_shop_preview','kruga_shop_preview_test']){
 const ownerUrl=url(name,'kruga_preview_owner',secrets.owner);
 run(['node_modules/prisma/build/index.js','migrate','deploy'],{DATABASE_URL:ownerUrl});
 if(name==='kruga_shop_preview')run(['--import','tsx','prisma/import-official.ts'],{DATABASE_URL:ownerUrl});
 const owner=new pg.Client({connectionString:ownerUrl});await owner.connect();
 try{await owner.query('GRANT USAGE ON SCHEMA public TO kruga_preview_read');await owner.query('GRANT SELECT ON "Category","Brand","ScooterModel","Product","Compatibility" TO kruga_preview_read');}finally{await owner.end();}
 if(name.endsWith('_test'))writeFileSync('.env.preview-test.local',`DATABASE_URL=${ownerUrl}\nPREVIEW_READER_URL=${url(name,'kruga_preview_read',secrets.reader)}\n`,{mode:0o600});
}
if(!existsSync('.env.preview.local'))writeFileSync('.env.preview.local',`DATABASE_URL=${url('kruga_shop_preview','kruga_preview_read',secrets.reader)}\nCLIENT_PREVIEW=1\nCATALOG_SOURCE=official\nHOST=127.0.0.1\nPORT=3000\nPREVIEW_LOCAL_OPEN=1\nPREVIEW_USER=client\nPREVIEW_PASSWORD_SHA256=${createHash('sha256').update(secrets.access).digest('hex')}\n`,{mode:0o600});
writeFileSync('.state/preview-access.txt',`User: client\nPassword: ${secrets.access}\n`,{mode:0o600});
console.log('Preview database initialized separately. Access details are in .state/preview-access.txt. No orders or administrators copied.');
