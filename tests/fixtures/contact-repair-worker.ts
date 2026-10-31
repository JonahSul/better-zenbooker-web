import {ContactStore} from '../../lib/contact-store';
import {contactMessagesRoute} from '../../lib/contact-server';

type Env={DB:D1Database;QA_TOKEN:string;QA_WORKSPACE_ID:string};
const ACTOR='verified-contact-repair-fixture';
const OTHER='contact-repair-other-workspace';
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
let now=Date.now();
const uuid=(n:number)=>`f7000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const input=(n:number,message=`Repair fixture ${n}.`)=>({requestKey:uuid(n),name:'Synthetic Repair Customer',email:'repair@example.invalid',message});
const stores=(env:Env)=>({primary:new ContactStore(env.DB,env.QA_WORKSPACE_ID,()=>now),other:new ContactStore(env.DB,OTHER,()=>now)});

async function counts(env:Env){
 const [messages,outbox,audit,rates,otherMessages,otherOutbox]=await Promise.all([
  env.DB.prepare('SELECT COUNT(*) AS count FROM contact_messages WHERE workspace_id=?').bind(env.QA_WORKSPACE_ID).first<{count:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM contact_outbox WHERE workspace_id=?').bind(env.QA_WORKSPACE_ID).first<{count:number}>(),
  env.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action IN ('contact.message_status','contact.message_delete')").first<{count:number}>(),
  env.DB.prepare("SELECT COUNT(*) AS count FROM customer_rate_windows WHERE key IN (?,?)").bind(env.QA_WORKSPACE_ID+':contact-submit',OTHER+':contact-submit').first<{count:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM contact_messages WHERE workspace_id=?').bind(OTHER).first<{count:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM contact_outbox WHERE workspace_id=?').bind(OTHER).first<{count:number}>(),
 ]);
 return {messages:messages?.count??0,outbox:outbox?.count??0,audit:audit?.count??0,rateRows:rates?.count??0,otherMessages:otherMessages?.count??0,otherOutbox:otherOutbox?.count??0};
}
async function migrations(env:Env){const row=await env.DB.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{count:number}>();return Number(row?.count??-1);}
async function readOutbox(env:Env,workspace:string,sourceId:string){return env.DB.prepare('SELECT id,state,revision,source_revision AS sourceRevision,claim_token AS claimToken FROM contact_outbox WHERE workspace_id=? AND source_type=\'contact\' AND source_id=?').bind(workspace,sourceId).first<{id:string;state:string;revision:number;sourceRevision:number;claimToken:string|null}>();}
async function inspect(env:Env,sourceId:string){const message=await env.DB.prepare('SELECT id,revision,status,deleted_at AS deletedAt FROM contact_messages WHERE workspace_id=? AND id=?').bind(env.QA_WORKSPACE_ID,sourceId).first<{id:string;revision:number;status:string;deletedAt:number|null}>();const outbox=await readOutbox(env,env.QA_WORKSPACE_ID,sourceId);return {message:message??null,outbox:outbox??null};}

async function submitRoute(store:ContactStore,value:unknown){
 let dispatchCount=0;const scheduled:Promise<unknown>[]=[];
 const origin='https://contact-repair.invalid';
 const response=await contactMessagesRoute(new Request(origin+'/api/contact/messages',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(value)}),{store,eligibility:async()=>({eligible:false,configRevision:0,configFingerprint:null,credentialGeneration:null}),dispatchNew:async()=>{dispatchCount++;},waitUntil:promise=>scheduled.push(Promise.resolve(promise))});
 const body=await response.json();await Promise.all(scheduled);
 return {status:response.status,retryAfter:response.headers.get('retry-after'),body,dispatchCount,scheduledCount:scheduled.length};
}

const worker={async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url);
 if(url.hostname!=='127.0.0.1'||url.port!=='8804'||request.headers.get('authorization')!==`Bearer ${env.QA_TOKEN}`)return json({error:'fixture_unavailable'},404);
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 let body:Record<string,unknown>;try{body=await request.json() as Record<string,unknown>;}catch{return json({error:'invalid_json'},400);}
 const {primary,other}=stores(env);
 try{
  switch(body.action){
   case 'init':{
    const current=await counts(env),migrationCount=await migrations(env);
    const tables=await Promise.all(['contact_messages','contact_outbox','customer_rate_windows'].map(async name=>!!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first()));
    const ready=migrationCount===31&&tables.every(Boolean)&&Object.values(current).every(value=>value===0);
    return json({ready,migrations:migrationCount,tablesPresent:tables.every(Boolean),counts:current});
   }
   case 'counts':return json(await counts(env));
   case 'clock':if(typeof body.now!=='number'||!Number.isSafeInteger(body.now)||body.now<1)throw new Error('invalid_clock');now=body.now;return json({now});
   case 'seed-status-rows':{
    const names=[101,102,103];const seeded=[];
    for(const [index,number] of names.entries()){
     const receipt=await primary.submit(input(number));
     const state=['blocked','pending','dispatching'][index],revision=[1,4,5][index],token=state==='dispatching'?'fixture-claim-token-000000000001':null;
     await env.DB.prepare('UPDATE contact_outbox SET state=?,revision=?,claim_token=?,attempted_at=? WHERE workspace_id=? AND source_type=\'contact\' AND source_id=?').bind(state,revision,token,state==='dispatching'?now:null,env.QA_WORKSPACE_ID,receipt.id).run();
     seeded.push({id:receipt.id,state,revision,token});
    }
    return json({rows:seeded});
   }
   case 'inspect':return json(await inspect(env,String(body.id)));
   case 'source-dispatch':{
    const result=await primary.sourceForDispatch(String(body.id),String(body.token));
    return json({found:!!result,id:result?.id??null,revision:result?.revision??null});
   }
   case 'status':return json(await primary.setStatus(body.input,ACTOR));
   case 'erase':return json(await primary.erase(body.input,ACTOR));
   case 'arm-status-audit-failure':{
    if(body.enabled!==true)throw new Error('invalid_trigger_action');
    await env.DB.exec("CREATE TRIGGER qa_contact_status_audit_failure BEFORE INSERT ON admin_audit WHEN NEW.action='contact.message_status' BEGIN SELECT RAISE(ABORT,'synthetic contact status audit failure'); END");
    return json({armed:true});
   }
   case 'drop-status-audit-failure':await env.DB.exec('DROP TRIGGER IF EXISTS qa_contact_status_audit_failure');return json({dropped:true});
   case 'seed-rate-99':{
    const key=env.QA_WORKSPACE_ID+':contact-submit',window=Math.floor(now/3600000);
    await env.DB.prepare('INSERT INTO customer_rate_windows(key,window,attempts) VALUES(?,?,99) ON CONFLICT(key) DO UPDATE SET window=excluded.window,attempts=excluded.attempts').bind(key,window).run();
    return json({seeded:true,window});
   }
   case 'rate-state':{
    const key=env.QA_WORKSPACE_ID+':contact-submit',window=Math.floor(now/3600000);
    const row=await env.DB.prepare('SELECT window,attempts FROM customer_rate_windows WHERE key=?').bind(key).first<{window:number;attempts:number}>();
    const [exact,workspaceRows]=await Promise.all([
     env.DB.prepare('SELECT key,window,attempts FROM customer_rate_windows WHERE key=?').bind(key).first<{key:string;window:number;attempts:number}>(),
     env.DB.prepare('SELECT COUNT(*) AS count FROM customer_rate_windows WHERE key LIKE ?').bind(env.QA_WORKSPACE_ID+':%').first<{count:number}>(),
    ]);
    return json({window,attempts:row?.attempts??0,exactKey:exact?.key===key,workspaceRateRows:workspaceRows?.count??0,containsIdentity:!!exact&&/[.@]/.test(exact.key)});
   }
   case 'route-submit':return json(await submitRoute(primary,body.input));
   case 'route-submit-other':return json(await submitRoute(other,body.input));
   case 'other-rate-state':{
    const key=OTHER+':contact-submit';
    const row=await env.DB.prepare('SELECT key,window,attempts FROM customer_rate_windows WHERE key=?').bind(key).first<{key:string;window:number;attempts:number}>();
    const count=await env.DB.prepare('SELECT COUNT(*) AS count FROM customer_rate_windows WHERE key LIKE ?').bind(OTHER+':%').first<{count:number}>();
    return json({attempts:row?.attempts??0,exactKey:row?.key===key,workspaceRateRows:count?.count??0,containsIdentity:!!row&&/[.@]/.test(row.key)});
   }
   case 'init-counts':return json({migrations:await migrations(env),counts:await counts(env)});
   default:return json({error:'unknown_action'},400);
  }
 }catch(error){const message=error instanceof Error?error.message:'fixture_failure';const allowed=new Set(['request_conflict','message_unavailable','save_unconfirmed','invalid_clock','audit_actor_required']);return json({error:allowed.has(message)?message:'fixture_failure'},409);}
}};

export default worker;
