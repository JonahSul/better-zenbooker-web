import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
// Explicit empty env-file makes Wrangler ignore .dev.vars; optional secrets are not core bindings.
await mkdir('.wrangler/typegen',{recursive:true});
await writeFile('.wrangler/typegen/empty.env','');
const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','types','cloudflare-env.d.ts','--config','wrangler.jsonc','--include-runtime=false','--strict-vars=false','--env-file','.wrangler/typegen/empty.env',...process.argv.slice(2)],{stdio:'inherit',windowsHide:true,env:{...process.env,CLOUDFLARE_INCLUDE_PROCESS_ENV:'false'}});
if(result.error)throw result.error;process.exit(result.status??1);
