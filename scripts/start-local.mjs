import {existsSync,readFileSync} from "node:fs";
import {spawn,execFileSync} from "node:child_process";
import {config} from "dotenv";
const node=existsSync('.state/node-path.txt')?readFileSync('.state/node-path.txt','utf8').trim():process.execPath;
const major=Number(execFileSync(node,['-p','process.versions.node.split(".")[0]'],{encoding:'utf8',windowsHide:true}).trim());
if(major!==24){console.error('Для запуска требуется Node.js 24.x. После установки: npm ci и npm run setup:local.');process.exit(1);}
config({quiet:true});const port=process.env.PORT||3000;
let running=false;try{const response=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(1500)});const result=await response.json();running=result.ok&&result.storage==='postgresql'&&result.catalogSource==='database';}catch{}
if(running){console.log('Магазин уже работает: http://localhost:'+port);process.exit(0);}
execFileSync(node,['scripts/setup-local.mjs'],{stdio:'inherit',windowsHide:true});
if(!existsSync('dist/src/server.js'))execFileSync(node,['node_modules/typescript/bin/tsc','-p','tsconfig.json'],{stdio:'inherit',windowsHide:true});
if(!existsSync('dist/public/app.js'))execFileSync(node,['scripts/build.mjs'],{stdio:'inherit',windowsHide:true});
const child=spawn(node,['dist/src/server.js'],{stdio:'inherit',windowsHide:true});child.once('exit',code=>process.exitCode=code??1);
