import {spawnSync} from 'node:child_process';
import './build-public.mjs';
const result=spawnSync(process.execPath,['scripts/run-framework.mjs','build',...process.argv.slice(2)],{stdio:'inherit'});if(result.error)throw result.error;process.exit(result.status??1);
