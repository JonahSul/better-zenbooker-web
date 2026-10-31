import {env} from 'cloudflare:workers';
import {assertModule,type ModuleEnv,type ModuleId} from './module-config';
/** Server-owned final network boundary. Re-evaluated for each request, including pagination. */
export function gatedFetch(module:ModuleId,fetcher:typeof fetch=fetch):typeof fetch{return async(input,init)=>{await assertModule(env as unknown as ModuleEnv,module);return fetcher(input,init);};}
