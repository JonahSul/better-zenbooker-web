import {env} from 'cloudflare:workers';
import {adminGuard,getGoogleAdmin,safeJson,readSmallBody} from '../../../../lib/admin-auth-server';
import {moduleStatuses,updateModule,type ModuleEnv} from '../../../../lib/module-config';
export async function GET(request:Request){const guard=await adminGuard(request);if(guard)return guard;return safeJson({modules:await moduleStatuses(env as unknown as ModuleEnv)});}
export async function POST(request:Request){const guard=await adminGuard(request);if(guard)return guard;try{const admin=(await getGoogleAdmin(request))!;const input=JSON.parse(await readSmallBody(request));return safeJson(await updateModule(env as unknown as ModuleEnv,input,admin.subject));}catch{return safeJson({error:'Module configuration changed or invalid'},409);}}
