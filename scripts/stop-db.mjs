import {execFileSync} from "node:child_process";
import {resolve} from "node:path";
execFileSync(resolve('.state/postgres-runtime/bin/pg_ctl.exe'),['stop','-D',resolve('.state/postgres-data'),'-m','fast','-w'],{stdio:'inherit',windowsHide:true});
