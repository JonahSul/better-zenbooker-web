import {getGoogleAdmin,rejected,readSmallBody,safeJson} from './admin-auth-server';
import {secretRuntime} from './runtime-secrets';
import {hostedBridgeStore} from './hosted-bridge-runtime';
import {bridgeRequestKey} from './hosted-bridge-store';
import {z} from 'zod/v3';
const inputSchema=z.object({requestKey:bridgeRequestKey}).strict();
export async function initializeHostedBridge(request:Request){
 const admin=await getGoogleAdmin(request);
 if(!admin)return rejected(request,'Administrator sign-in required.',403);
 const url=new URL(request.url);
 if(url.protocol!=='https:'||request.headers.get('origin')!==url.origin)return rejected(request,'Use the protected HTTPS administrator page.',403);
 let input:z.infer<typeof inputSchema>;
 try{input=inputSchema.parse(JSON.parse(await readSmallBody(request)));}catch{return safeJson({error:'Enter a valid initialization request.'},400);}
 try{
  const store=hostedBridgeStore(),now=Date.now(),window=Math.floor(now/900000);
  const rate=await store.statement('INSERT INTO app_credential_attempts(project_id,window,attempts) VALUES(?,?,1) ON CONFLICT(project_id,window) DO UPDATE SET attempts=attempts+1 RETURNING attempts',store.workspaceId+':hosted-initialize',window).first<{attempts:number}>();
  if(!rate||rate.attempts>5)return safeJson({error:'Too many setup attempts. Please wait before retrying.'},429,{'Retry-After':String(Math.max(1,Math.ceil(((window+1)*900000-now)/1000)))});
  const result=await store.initialize(input.requestKey,admin.subject);
  return safeJson({initialized:result.initialized,revision:result.revision,bridgeVerifier:result.bridgeVerifier,callbackVerifier:result.callbackVerifier},200,{'Referrer-Policy':'no-referrer'});
 }catch{return safeJson({error:'Receiver initialization is unavailable. Existing credentials were retained.'},503);}
}
