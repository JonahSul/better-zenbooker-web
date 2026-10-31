import {spawnSync} from 'node:child_process';
const run=(args)=>{const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{stdio:'inherit'});if(result.error)throw result.error;return result.status===0;};
// Wrangler resolves only the named root binding. An unresolved binding stops before application upload.
if(!run(['d1','migrations','apply','DB','--remote','--config','wrangler.jsonc'])){console.error('DB migration failed. Resolve the root DB binding through the deployment environment or an explicitly created database. No application deployment was attempted.');process.exit(1);}
if(!run(['deploy','--config','dist/server/wrangler.json']))process.exit(1);
