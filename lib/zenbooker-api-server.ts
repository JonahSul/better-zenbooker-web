import {gatedFetch} from './provider-policy';
import {env} from 'cloudflare:workers';
import {z} from 'zod/v3';
import {credentialStore,secretRuntime,SITE_PROJECT_ID} from './runtime-secrets';
import {BookingSettingsStore,bookingProviderFingerprint} from './booking-settings';
import {ZenbookerApiClient,apiCheckInputSchema,apiRefreshInputSchema} from './zenbooker-api-core';
import {ZenbookerReconciliationStore} from './zenbooker-reconciliation-store';
import {ZenbookerApiService,type ApiRuntime} from './zenbooker-api-service';
import {getGoogleAdmin,readSmallBody,rejected,safeJson} from './admin-auth-server';
export {apiCheckInputSchema,apiRefreshInputSchema};
export const apiStatusInputSchema=z.object({}).strict();
export async function readZenbookerCredentialRevision(store=credentialStore()):Promise<number|null>{const row=await store.statement('SELECT revision FROM app_credential_state WHERE project_id=?',SITE_PROJECT_ID).first<{revision:number}>();return row&&Number.isSafeInteger(row.revision)&&row.revision>=0?row.revision:null;}
export async function resolveZenbookerApiRuntime():Promise<ApiRuntime>{
 const runtime=secretRuntime(),store=credentialStore(),revision=await readZenbookerCredentialRevision(store);if(revision===null)throw new Error('credential_boundary_unavailable');const presence=await store.presence('ZENBOOKER_API_KEY',runtime.ZENBOOKER_API_KEY);let key:string|null=null,locallyReadable=false;try{key=(await store.resolve('ZENBOOKER_API_KEY',runtime.ZENBOOKER_API_KEY)).value;locallyReadable=!!key;}catch{}
 const settings=await new BookingSettingsStore(env.DB!,SITE_PROJECT_ID).read();
 return {client:new ZenbookerApiClient(key??undefined,gatedFetch('booking'),{rejectedResponseDiagnostics:true}),generation:await bookingProviderFingerprint(SITE_PROJECT_ID,key??'missing',revision),credentialRevision:revision,presence,locallyReadable,legacyGates:{readEnabled:settings.config.readEnabled,writeEnabled:settings.config.writeEnabled,sendingEnabled:settings.config.sendingEnabled}};
}
export function zenbookerApiService(){if(!env.DB)throw new Error('unavailable');return new ZenbookerApiService(new ZenbookerReconciliationStore(env.DB,SITE_PROJECT_ID),resolveZenbookerApiRuntime);}
export type ApiOwnerDependencies={getAdmin?:(request:Request)=>Promise<{siteUserId:string}|null>;ownerId?:string;service?:Pick<ZenbookerApiService,'status'|'check'|'refresh'>};
export async function zenbookerApiOwnerRoute(request:Request,operation:'status'|'check'|'refresh',deps:ApiOwnerDependencies={}){try{const admin=await(deps.getAdmin??getGoogleAdmin)(request),owner=deps.ownerId??secretRuntime().SITE_OWNER_USER_ID;if(!admin)return rejected(request,'Fixed Site owner and Google sign-in required.',403);const url=new URL(request.url);if(request.method!=='POST'||url.protocol!=='https:'||url.search||request.headers.get('origin')!==url.origin)return rejected(request,'Use the protected HTTPS owner page.',403);let input:unknown;try{input=(operation==='status'?apiStatusInputSchema:operation==='check'?apiCheckInputSchema:apiRefreshInputSchema).parse(JSON.parse(await readSmallBody(request)));}catch{return safeJson({error:'Invalid API read request.'},400);}const service=deps.service??zenbookerApiService();return safeJson(await(operation==='status'?service.status():operation==='check'?service.check(input):service.refresh(input)));}catch{return safeJson({error:'API read unavailable or rejected.'},503);}}
