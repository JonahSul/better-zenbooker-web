import {ContactStore} from '../../lib/contact-store';
import type {ContactNotificationEligibility} from '../../lib/contact-core';
import {ContactNotificationConfigurationStore} from '../../lib/contact-notification-configuration';
import {contactMessagesRoute} from '../../lib/contact-server';

type Env={DB:D1Database;QA_TOKEN:string;QA_WORKSPACE_ID:string};
const FIXTURE_ACTOR='verified-contact-owner-fixture';
const OTHER_WORKSPACE_ID='contact-other-workspace';
const CONFIG_SUBJECT='system:contact-notifications';
const CONFIG_KEY='contact-notifications-v1';
const SENDER_KEY='contact-notification-sender-v1';
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
let fixtureNow=Date.now();
let eligible=false;
let policyEligible=false;

function eligibility():ContactNotificationEligibility{return {eligible,policyEligible,refreshSender:policyEligible,attentionReason:policyEligible?'sender_check_required':'not_ready',configRevision:eligible||policyEligible?1:0,configFingerprint:eligible||policyEligible?'a'.repeat(64):null,credentialGeneration:eligible||policyEligible?'b'.repeat(64):null};}
function stores(env:Env){return {contact:new ContactStore(env.DB,env.QA_WORKSPACE_ID,()=>fixtureNow),configuration:new ContactNotificationConfigurationStore(env.DB,env.QA_WORKSPACE_ID,()=>fixtureNow)};}
function otherContactStore(env:Env){return new ContactStore(env.DB,OTHER_WORKSPACE_ID,()=>fixtureNow);}
async function counts(env:Env){
 const [messages,outbox,audit,setting,senderSetting,otherMessages,otherOutbox]=await Promise.all([
  env.DB.prepare('SELECT COUNT(*) AS count FROM contact_messages WHERE workspace_id=?').bind(env.QA_WORKSPACE_ID).first<{count:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM contact_outbox WHERE workspace_id=?').bind(env.QA_WORKSPACE_ID).first<{count:number}>(),
  env.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action IN ('contact.message_status','contact.message_delete','contact.notifications_save','contact.sender_check')").first<{count:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=?').bind(env.QA_WORKSPACE_ID,CONFIG_SUBJECT,CONFIG_KEY).first<{count:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=?').bind(env.QA_WORKSPACE_ID,CONFIG_SUBJECT,SENDER_KEY).first<{count:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM contact_messages WHERE workspace_id=?').bind(OTHER_WORKSPACE_ID).first<{count:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM contact_outbox WHERE workspace_id=?').bind(OTHER_WORKSPACE_ID).first<{count:number}>(),
 ]);
 return {messages:messages?.count??0,outbox:outbox?.count??0,audit:audit?.count??0,configurationRows:setting?.count??0,senderEvidenceRows:senderSetting?.count??0,otherMessages:otherMessages?.count??0,otherOutbox:otherOutbox?.count??0};
}
async function migrationCount(env:Env){const row=await env.DB.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{count:number}>();return Number(row?.count??-1);}
function fixtureSenderBinding(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_sender_binding');
 const input=value as Record<string,unknown>,keys=Object.keys(input).sort();
 if(keys.join(',')!=='configRevision,credentialGeneration,credentialSource,fingerprint,senderRevision'||input.credentialSource!=='encrypted'||input.credentialGeneration!=='d'.repeat(64)||input.fingerprint!=='c'.repeat(64)||typeof input.configRevision!=='number'||!Number.isSafeInteger(input.configRevision)||input.configRevision<1||typeof input.senderRevision!=='number'||!Number.isSafeInteger(input.senderRevision)||input.senderRevision<0)throw new Error('invalid_sender_binding');
 return input as {configRevision:number;senderRevision:number;fingerprint:string;credentialSource:'encrypted';credentialGeneration:string};
}

export default {async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url);
 if(url.hostname!=='127.0.0.1'||url.port!=='8803'||request.headers.get('authorization')!==`Bearer ${env.QA_TOKEN}`)return json({error:'fixture_unavailable'},404);
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 let body:Record<string,unknown>;
 try{body=await request.json() as Record<string,unknown>;}catch{return json({error:'invalid_json'},400);}
 const {contact,configuration}=stores(env);
 try{
  switch(body.action){
   case 'init':{
    const current=await counts(env),migrations=await migrationCount(env);
    const tables=await Promise.all(['contact_messages','contact_outbox'].map(async name=>!!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first()));
    const ready=migrations===31&&tables.every(Boolean)&&Object.values(current).every(value=>value===0);
    return json({ready,migrations,tablesPresent:tables.every(Boolean),counts:current});
   }
   case 'counts':return json(await counts(env));
   case 'clock':{
    const value=body.now;
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new Error('invalid_clock');
    fixtureNow=value;return json({now:fixtureNow});
   }
   case 'advance':{
    const delta=body.milliseconds;
    if(typeof delta!=='number'||!Number.isSafeInteger(delta)||delta<0||delta>30*86400000)throw new Error('invalid_clock');
    fixtureNow+=delta;return json({now:fixtureNow});
   }
   case 'eligible':{
    if(typeof body.value!=='boolean')throw new Error('invalid_eligibility');
    eligible=body.value;return json({eligible});
   }
   case 'policy-eligible':{
    if(typeof body.value!=='boolean')throw new Error('invalid_eligibility');
    policyEligible=body.value;return json({policyEligible});
   }
   case 'submit':return json(await contact.submit(body.input,eligibility()));
   case 'route-submit':{
    const input=body.input,origin='https://contact-fixture.invalid';let dispatchCount=0;const scheduled:Promise<unknown>[]=[];
    const response=await contactMessagesRoute(new Request(origin+'/api/contact/messages',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(input)}),{store:contact,eligibility:async()=>eligibility(),dispatchNew:async()=>{dispatchCount++;},waitUntil:promise=>scheduled.push(promise)});
    const receipt=await response.json();await Promise.all(scheduled);
    return json({status:response.status,body:receipt,dispatchCount,scheduledCount:scheduled.length});
   }
   case 'seed-foreign':return json(await otherContactStore(env).submit({requestKey:'d8000000-0000-4000-8000-000000000001',name:'Foreign Fixture Customer',email:'foreign@example.invalid',message:'Foreign workspace isolation sentinel.'},{eligible:false,configRevision:0,configFingerprint:null,credentialGeneration:null}));
   case 'foreign-read-attempt':return json({message:await contact.read(String(body.id))});
   case 'foreign-delete-attempt':return json(await contact.erase(body.input,FIXTURE_ACTOR));
   case 'foreign-list':return json({messages:await otherContactStore(env).list()});
   case 'list':return json({messages:await contact.list()});
   case 'read':return json({message:await contact.read(String(body.id))});
   case 'model-list':return json(await contact.modelList());
   case 'status':return json(await contact.setStatus(body.input,FIXTURE_ACTOR));
   case 'erase':return json(await contact.erase(body.input,FIXTURE_ACTOR));
   case 'prune':return json(await contact.prune(typeof body.limit==='number'?body.limit:100));
   case 'outbox':return json({outbox:await contact.outboxSummaries()});
   case 'claim':return json(await contact.claimOutbox(body.input as Parameters<ContactStore['claimOutbox']>[0]));
   case 'finish':return json(await contact.finishOutbox(body.input as Parameters<ContactStore['finishOutbox']>[0]));
   case 'notification-config':
    if(body.input===undefined)return json(await configuration.read());
    return json(await configuration.save(body.input,FIXTURE_ACTOR));
   case 'sender-evidence':{
    const value=await configuration.senderEvidence();
    return json({senderRevision:value.senderRevision,evidence:value.evidence?{domainEnabled:value.evidence.domainEnabled,checkedAt:value.evidence.checkedAt,expiresAt:value.evidence.expiresAt,checkedConfigRevision:value.evidence.checkedConfigRevision}:null});
   }
   case 'sender-claim':return json(await configuration.claimSenderRefresh(fixtureSenderBinding(body.binding)));
   case 'seed-synthetic-sender-evidence':{
    const binding=fixtureSenderBinding(body.binding),savedConfig=await configuration.read(),sender=await configuration.senderEvidence();
    if(savedConfig.revision!==binding.configRevision||sender.senderRevision!==binding.senderRevision||!savedConfig.from||!savedConfig.zoneId||!savedConfig.subdomainId)throw new Error('configuration_changed');
    const evidence={workspaceId:env.QA_WORKSPACE_ID,accountId:'e'.repeat(32),from:savedConfig.from,zoneId:savedConfig.zoneId,subdomainId:savedConfig.subdomainId,senderRevision:binding.senderRevision,credentialSource:binding.credentialSource,credentialGeneration:binding.credentialGeneration,fingerprint:binding.fingerprint,checkedAt:fixtureNow,expiresAt:fixtureNow+86400000,checkedConfigRevision:binding.configRevision,domainEnabled:true as const};
    return json(await configuration.recordSenderCheck(binding.configRevision,evidence,FIXTURE_ACTOR));
   }
   case 'sender-finish':{
    const token=body.token;
    if(typeof token!=='string'||!/^[0-9a-f-]{36}$/i.test(token))throw new Error('invalid_sender_binding');
    return json(await configuration.finishSenderRefresh(token,fixtureSenderBinding(body.binding),null,FIXTURE_ACTOR));
   }
   case 'arm-outbox-failure':{
    if(body.enabled!==true)throw new Error('invalid_trigger_action');
    await env.DB.exec("CREATE TRIGGER qa_contact_outbox_failure BEFORE INSERT ON contact_outbox BEGIN SELECT RAISE(ABORT,'synthetic contact outbox failure'); END");
    return json({armed:true});
   }
   default:return json({error:'unknown_action'},400);
  }
 }catch(error){
  const message=error instanceof Error?error.message:'fixture_failure';
  const allowed=new Set(['request_conflict','message_unavailable','save_unconfirmed','audit_actor_required','invalid_limit','invalid_result','outbox_unavailable','configuration_changed','invalid_clock','invalid_eligibility','invalid_trigger_action','invalid_sender_binding','sender_check_busy']);
  return json({error:allowed.has(message)?message:'fixture_failure'},409);
 }
}};
