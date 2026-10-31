import {ElementMeasurementStore,type ElementGrant} from '../../lib/element-measurement-store';
import {elementDescriptorInput} from '../../lib/element-measurement-core';
import {Ga4PropertyConfigurationStore} from '../../lib/ga4-property-configuration';

type Env={DB:D1Database;QA_TOKEN:string};
const WORKSPACE='element-measurement-local-workspace';
const FOREIGN_WORKSPACE='element-measurement-foreign-workspace';
const FIXTURE_ACTOR='element-measurement-fixture-owner';
const PROPERTY_SUBJECT='system:analytics-configuration';
const PROPERTY_KEY='ga4-property-v1';
const INITIAL_NOW=1_800_000_000_000;
const GRANTS={analytics:'a'.repeat(64),experiment:'b'.repeat(64),foreign:'c'.repeat(64)} as const;
let fixtureNow=INITIAL_NOW;
let initialized=false;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
function workspace(value:unknown){if(value===undefined||value==='primary')return WORKSPACE;if(value==='foreign')return FOREIGN_WORKSPACE;throw new Error('invalid_workspace');}
function grant(value:unknown):ElementGrant{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_grant');
 const item=value as Record<string,unknown>;
 if(Object.keys(item).sort().join(',')!=='expiresAt,hash,revision'||typeof item.hash!=='string'||!Object.values(GRANTS).includes(item.hash as never)||typeof item.revision!=='number'||!Number.isSafeInteger(item.revision)||item.revision<1||typeof item.expiresAt!=='number'||!Number.isSafeInteger(item.expiresAt))throw new Error('invalid_grant');
 return {hash:item.hash,revision:item.revision,expiresAt:item.expiresAt};
}
function store(env:Env,scope:unknown){return new ElementMeasurementStore(env.DB,workspace(scope),()=>fixtureNow);}
async function counts(env:Env){
 const [documents,events,settings,audits]=await Promise.all([
  env.DB.prepare('SELECT COUNT(*) AS count FROM element_measurement_documents WHERE workspace_id=?').bind(WORKSPACE).first<{count:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM element_measurement_events WHERE workspace_id=?').bind(WORKSPACE).first<{count:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM admin_settings WHERE workspace_id=? AND google_subject=? AND key=?').bind(WORKSPACE,PROPERTY_SUBJECT,PROPERTY_KEY).first<{count:number}>(),
  env.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action='analytics.property_configuration_save'").first<{count:number}>(),
 ]);
 return {documents:Number(documents?.count??0),events:Number(events?.count??0),propertyRows:Number(settings?.count??0),propertyAudits:Number(audits?.count??0)};
}
async function state(env:Env){
 const [documents,events,rates,audits,foreignDocuments,foreignEvents]=await Promise.all([
  env.DB.prepare('SELECT id,document_key,descriptor_hash,analytics_grant_hash,analytics_revision,route,issued_at,expires_at,retained_until,experiment_grant_hash,experiment_revision,version_id,composition_id FROM element_measurement_documents WHERE workspace_id=? ORDER BY created_at,id').bind(WORKSPACE).all(),
  env.DB.prepare('SELECT document_id,element_id,kind,received_at,source_hash FROM element_measurement_events WHERE workspace_id=? ORDER BY received_at,document_id,element_id,kind').bind(WORKSPACE).all(),
  env.DB.prepare("SELECT key,window,attempts FROM customer_rate_windows WHERE instr(key,?)=1 OR instr(key,?)=1 ORDER BY key").bind(WORKSPACE+':element-register:',WORKSPACE+':element-events:').all(),
  env.DB.prepare("SELECT id,google_subject,action,target,created_at FROM admin_audit WHERE action='analytics.property_configuration_save' ORDER BY created_at,id").all(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM element_measurement_documents WHERE workspace_id=?').bind(FOREIGN_WORKSPACE).first<{count:number}>(),
  env.DB.prepare('SELECT COUNT(*) AS count FROM element_measurement_events WHERE workspace_id=?').bind(FOREIGN_WORKSPACE).first<{count:number}>(),
 ]);
 return {counts:await counts(env),documents:documents.results??[],events:events.results??[],rates:rates.results??[],audits:audits.results??[],foreignCounts:{documents:Number(foreignDocuments?.count??0),events:Number(foreignEvents?.count??0)}};
}
async function seedGrant(env:Env,value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_grant');
 const input=value as Record<string,unknown>;
 if(typeof input.hash!=='string'||!Object.values(GRANTS).includes(input.hash as never)||typeof input.revision!=='number'||!Number.isSafeInteger(input.revision)||input.revision<1||![0,1].includes(input.analytics as number)||![0,1].includes(input.experiments as number)||typeof input.expiresAt!=='number'||!Number.isSafeInteger(input.expiresAt))throw new Error('invalid_grant');
 await env.DB.prepare('INSERT INTO measurement_grants(subject_hash,revision,analytics,experiments,expires_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(subject_hash) DO UPDATE SET revision=excluded.revision,analytics=excluded.analytics,experiments=excluded.experiments,expires_at=excluded.expires_at,updated_at=excluded.updated_at').bind(input.hash,input.revision,input.analytics,input.experiments,input.expiresAt,fixtureNow).run();
 return {saved:true};
}
async function seedSource(env:Env,input:Record<string,unknown>){
 if(!['contact','demo'].includes(String(input.kind))||typeof input.id!=='string'||!/^[0-9a-f-]{36}$/i.test(input.id)||!['primary','foreign'].includes(String(input.workspace)))throw new Error('invalid_source');
 const ws=workspace(input.workspace),deleted=input.deleted===true,expired=input.expired===true;
 if(input.deleted!==undefined&&typeof input.deleted!=='boolean'||input.expired!==undefined&&typeof input.expired!=='boolean')throw new Error('invalid_source');
 if(input.kind==='contact'){
  await env.DB.prepare('INSERT INTO contact_messages(id,workspace_id,request_key,payload_hash,name,email,message,status,revision,created_at,updated_at,expires_at,deleted_at,last_write_token) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(input.id,ws,input.id,'d'.repeat(64),'Synthetic fixture','fixture@example.invalid','Synthetic source row','new',1,fixtureNow,fixtureNow,expired?fixtureNow-1:fixtureNow+30*86400000,deleted?fixtureNow:null,null).run();
 }else{
  const createdAt=expired?fixtureNow-30*86400000-1:fixtureNow;
  await env.DB.prepare('INSERT INTO inquiries(id,user_id,submission_key,name,contact,service,area,preferred_date,source,note,status,revenue_cents,created_at,updated_at,deleted_at,workspace_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(input.id,ws,input.id,'Synthetic fixture','fixture@example.invalid','repair','fixture-area','2030-01-01','direct','Synthetic source row','new',null,createdAt,createdAt,deleted?fixtureNow:null,ws).run();
 }
 return {id:input.id,kind:input.kind,workspace:String(input.workspace)};
}
async function seedRate(env:Env,input:Record<string,unknown>){
 const ws=workspace(input.workspace),g=grant(input.grant),kind=input.kind,limit=kind==='register'?30:kind==='events'?600:0,attempts=input.attempts;
 if(!limit||typeof attempts!=='number'||!Number.isSafeInteger(attempts)||attempts<0||attempts>limit)throw new Error('invalid_rate');
 const key=ws+':element-'+(kind==='register'?'register':'events')+':'+g.hash+':'+g.revision,window=Math.floor(fixtureNow/3600000);
 await env.DB.prepare('INSERT INTO customer_rate_windows(key,window,attempts) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET window=excluded.window,attempts=excluded.attempts').bind(key,window,attempts).run();
 return {saved:true};
}

export default {async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url);
 if(url.hostname!=='127.0.0.1'||url.port!=='8806'||request.headers.get('authorization')!==`Bearer ${env.QA_TOKEN}`)return json({error:'fixture_unavailable'},404);
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 let body:Record<string,unknown>;
 try{const text=await request.text();if(text.length>32768)return json({error:'fixture_body_too_large'},413);body=JSON.parse(text) as Record<string,unknown>;}catch{return json({error:'invalid_json'},400);}
 try{
  switch(body.action){
   case 'init':{
    if(initialized)throw new Error('already_initialized');
    const migrations=await env.DB.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{count:number}>(),tableNames=['element_measurement_documents','element_measurement_events'];
    const tables=await Promise.all(tableNames.map(async name=>!!await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first()));
    const before=await counts(env),ready=Number(migrations?.count??-1)===32&&tables.every(Boolean)&&before.documents===0&&before.events===0&&before.propertyRows===0&&before.propertyAudits===0;
    if(!ready)return json({ready:false,migrations:Number(migrations?.count??-1),tablesPresent:tables.every(Boolean),counts:before},409);
    fixtureNow=INITIAL_NOW;
    for(const [hash,analytics,experiments,ttl] of [[GRANTS.analytics,1,0,30*86400000],[GRANTS.experiment,0,1,15*60000],[GRANTS.foreign,1,0,30*86400000]] as const)await seedGrant(env,{hash,revision:1,analytics,experiments,expiresAt:fixtureNow+ttl});
    initialized=true;
    return json({ready:true,initialized:true,migrations:Number(migrations?.count??-1),tablesPresent:true,counts:await counts(env),clock:fixtureNow});
   }
   case 'clock':{const input=body.input as Record<string,unknown>;const now=input?.now;if(typeof now!=='number'||!Number.isSafeInteger(now)||now<1)throw new Error('invalid_clock');fixtureNow=now;return json({now:fixtureNow});}
   case 'seed-grant':return json(await seedGrant(env,body.input));
   case 'seed-source':return json(await seedSource(env,body.input as Record<string,unknown>));
   case 'seed-rate':return json(await seedRate(env,body.input as Record<string,unknown>));
   case 'register':{
    const input=body.input as Record<string,unknown>,parsed=elementDescriptorInput.parse(input.descriptor),g=grant(input.grant);
    return json(await store(env,input.workspace).register({documentKey:String(input.documentKey),descriptor:parsed,descriptorHash:String(input.descriptorHash),grant:g,association:input.association as Parameters<ElementMeasurementStore['register']>[0]['association'],adminSuppressed:input.adminSuppressed===true}));
   }
   case 'record':{const input=body.input as Record<string,unknown>;return json(await store(env,input.workspace).record({documentId:String(input.documentId),events:input.events as Parameters<ElementMeasurementStore['record']>[0]['events'],grant:grant(input.grant),adminSuppressed:input.adminSuppressed===true}));}
   case 'outcome':{const input=body.input as Record<string,unknown>;return json(await store(env,input.workspace).recordOutcome({documentId:String(input.documentId),kind:input.kind as 'contact_received'|'demo_request_received',sourceHash:String(input.sourceHash),sourceId:String(input.sourceId),grant:grant(input.grant),adminSuppressed:input.adminSuppressed===true}));}
   case 'report':{const input=body.input as Record<string,unknown>;return json(await store(env,input.workspace).report(input.window??{}));}
   case 'withdraw-analytics':{const input=body.input as Record<string,unknown>;return json(await store(env,input.workspace).withdrawAnalytics(String(input.hash),Number(input.revision),input.limit===undefined?100:Number(input.limit)));}
   case 'withdraw-experiments':{const input=body.input as Record<string,unknown>;return json(await store(env,input.workspace).withdrawExperiments(String(input.hash),Number(input.revision),input.limit===undefined?100:Number(input.limit)));}
   case 'prune':{const input=body.input as Record<string,unknown>;return json(await store(env,input.workspace).prune(input.limit===undefined?100:Number(input.limit)));}
   case 'property-read':{const input=(body.input??{}) as Record<string,unknown>;return json(await new Ga4PropertyConfigurationStore(env.DB,workspace(input.workspace),()=>fixtureNow).read(typeof input.nativeId==='string'?input.nativeId:undefined));}
   case 'property-save':{const input=body.input as Record<string,unknown>;return json(await new Ga4PropertyConfigurationStore(env.DB,workspace(input.workspace),()=>fixtureNow).save(input.value,FIXTURE_ACTOR));}
   case 'arm-property-audit-failure':{
    await env.DB.exec("CREATE TRIGGER qa_element_property_audit_failure BEFORE INSERT ON admin_audit WHEN NEW.action='analytics.property_configuration_save' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END");
    return json({armed:true});
   }
   case 'state':return json(await state(env));
   default:return json({error:'unknown_action'},400);
  }
 }catch(error){
  const message=error instanceof Error?error.message:'fixture_failure';
  const allowed=new Set(['invalid_document','document_conflict','rate_limited','invalid_window','configuration_changed','audit_actor_required','invalid_clock','invalid_grant','invalid_source','invalid_rate','already_initialized']);
  const code=allowed.has(message)?message:'fixture_failure';
  return json({error:code},code==='rate_limited'?429:code==='fixture_failure'?500:409);
 }
}};
