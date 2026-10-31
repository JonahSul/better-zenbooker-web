import {validateServiceInterests} from './service-interests';
import {resolveEffectiveSupportPreferences} from './effective-support-preferences';
import {supportPhotoStore,photoStorageAvailable} from './support-photo-runtime';
import {z} from 'zod/v3';
import {safeJson,rejected,readSmallBody,getGoogleAdmin} from './admin-auth-server';
import {supportStore,supportProxy} from './support-runtime';
import {supportChatInput,supportPreferenceInput,supportFeedbackInput,supportDeleteInput,requestKeySchema} from './support-core';
import {runSupportTurn} from './support-service';
import {sha256,cookieValue} from './admin-auth-core';
import {secretRuntime} from './runtime-secrets';
const COOKIE='__Host-support_visitor';
function cookie(raw:string,maxAge=86400){return COOKIE+'='+raw+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age='+maxAge;}
function opaque(){return Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');}
export async function supportVisitor(request:Request,create=false){const store=supportStore(),raw=cookieValue(request,COOKIE);if(raw&&/^[0-9a-f]{64}$/.test(raw)){const hash=await sha256('visitor-support:'+store.workspaceId+':'+raw);if(await store.session(hash))return {store,hash,cookie:null as string|null};}if(!create)return null;const token=opaque(),hash=await sha256('visitor-support:'+store.workspaceId+':'+token);await store.createSession(hash);return {store,hash,cookie:cookie(token)};}
export async function supportApi(action:'chat'|'thread'|'memory'|'session'|'feedback',request:Request,id?:string){
 if(!['GET','HEAD'].includes(request.method)&&request.headers.get('origin')!==new URL(request.url).origin)return rejected(request,'Use this site to make changes.',403);
 try{
  const input=request.method==='GET'?null:JSON.parse((await readSmallBody(request))||'{}');
  if(action==='chat')supportChatInput.parse(input);
  const own=await supportVisitor(request,action==='chat');if(!own&&action==='memory'&&request.method==='GET'){const effective=await resolveEffectiveSupportPreferences(request,'');return safeJson({authenticated:false,...effective.preferences,preferenceSource:effective.context.source,accountPreferencesActive:effective.accountActive,currentThreadId:null});}if(!own)return safeJson(action==='memory'?{authenticated:false,revision:0,remember:false,answerLength:'standard',serviceInterests:[]}:{error:'Support session unavailable.'},action==='memory'?200:401);
  let result:unknown;const extra:Record<string,string>={};if(own.cookie)extra['Set-Cookie']=own.cookie;
  if(action==='chat'){const proxy=supportProxy(),status=await proxy.status();result=await runSupportTurn(own.store,own.hash,input,{resolvePreferences:()=>resolveEffectiveSupportPreferences(request,own.hash,{store:own.store}),provider:proxy.provider(),enabled:status.configured&&status.enabled&&status.health==='verified',dailyModelCalls:status.dailyModelCalls,photoEnabled:photoStorageAvailable()&&'photoEnabled'in status&&status.photoEnabled&&status.photoHealth==='verified',photos:photoStorageAvailable()?supportPhotoStore():undefined,vision:(bytes,onAttempt)=>proxy.vision(bytes,onAttempt)});}
  else if(action==='thread'){z.string().uuid().parse(id);result=request.method==='GET'?await own.store.thread(own.hash,id!):await own.store.deleteThread(own.hash,id!,supportDeleteInput.parse(input).revision);}
  else if(action==='memory'){const effective=await resolveEffectiveSupportPreferences(request,own.hash,{store:own.store});if(request.method!=='GET'&&effective.accountActive)return safeJson({error:'Use your account preferences to change these choices.',openAccountPreferences:true},409);if(request.method==='GET'){const latest=await own.store.statement('SELECT id FROM support_threads WHERE workspace_id=? AND visitor_hash=? AND deleted_at IS NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1',own.store.workspaceId,own.hash,own.store.now()).first<{id:string}>();result={authenticated:true,...effective.preferences,preferenceSource:effective.context.source,accountPreferencesActive:effective.accountActive,currentThreadId:latest?.id??null};}else if(request.method==='PUT'){const args=supportPreferenceInput.parse(input);await validateServiceInterests(args.serviceInterests);result=await own.store.updatePreferences(own.hash,args,effective.context);extra['Set-Cookie']=cookie(cookieValue(request,COOKIE)!,args.remember?30*86400:86400);}else result=await own.store.forgetPreferences(own.hash,supportDeleteInput.parse(input).revision,effective.context);}
  else if(action==='feedback')result=await own.store.feedback(own.hash,supportFeedbackInput.parse(input));
  else {z.object({}).strict().parse(input);result=await own.store.eraseSession(own.hash);extra['Set-Cookie']=cookie('',0);}
  return safeJson(result,200,extra);
 }catch{return safeJson({error:'Support request unavailable, changed or limited. Please refresh and try again.'},400);}
}
export async function initializeSupportProxy(request:Request){const admin=await getGoogleAdmin(request),owner=secretRuntime().SITE_OWNER_USER_ID;if(!admin)return rejected(request,'Fixed Site owner and Google sign-in required.',403);if(new URL(request.url).protocol!=='https:'||request.headers.get('origin')!==new URL(request.url).origin)return rejected(request,'Use the protected HTTPS owner page.',403);let input:{requestKey:string};try{input=z.object({requestKey:requestKeySchema}).strict().parse(JSON.parse(await readSmallBody(request)));}catch{return safeJson({error:'Invalid setup request.'},400);}try{const store=supportStore(),window=Math.floor(Date.now()/900000),rate=await store.statement('INSERT INTO app_credential_attempts(project_id,window,attempts) VALUES(?,?,1) ON CONFLICT(project_id,window) DO UPDATE SET attempts=attempts+1 RETURNING attempts',store.workspaceId+':visitor-proxy',window).first<{attempts:number}>();if(!rate||rate.attempts>5)return safeJson({error:'Setup request limit reached.'},429);return safeJson(await supportProxy().initialize(input.requestKey,admin.subject));}catch{return safeJson({error:'Support proxy initialization unavailable.'},503);}}

