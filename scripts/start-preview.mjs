import {existsSync,readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
const runtime=existsSync('.state/node-path.txt')?readFileSync('.state/node-path.txt','utf8').trim():process.execPath;
if(!existsSync('.env.preview.local')||!existsSync('dist/src/server.js'))throw Error('Run npm run preview:setup and npm run build first');
const child=spawn(runtime,['--env-file=.env.preview.local','dist/src/server.js'],{stdio:'inherit',windowsHide:true});
child.once('exit',code=>process.exitCode=code??1);
