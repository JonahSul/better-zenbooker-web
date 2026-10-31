import {BookingSettingsStore,type BookingConfiguration} from '../../lib/booking-settings';

type Env={DB:D1Database;QA_TOKEN:string;QA_WORKSPACE_ID:string};
const ACTOR=`native-owner:${'c'.repeat(64)}`;
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
const settings=(env:Env)=>new BookingSettingsStore(env.DB,env.QA_WORKSPACE_ID);

async function state(env:Env){
 const value=await settings(env).read();
 const persisted=await env.DB.prepare('SELECT config_json FROM booking_settings WHERE workspace_id=?').bind(env.QA_WORKSPACE_ID).first<{config_json:string}>();
 let internalWriteTokenPresent=false;
 if(persisted){try{internalWriteTokenPresent=typeof JSON.parse(persisted.config_json)?.writeToken==='string';}catch{internalWriteTokenPresent=false;}}
 return {revision:value.revision,config:value.config,senderCheck:value.senderCheck,catalogCheck:value.catalogCheck,ownerConfirmation:value.ownerConfirmation,internalWriteTokenPresent,readbackLeaksWriteToken:Object.hasOwn(value as object,'writeToken')};
}
async function counts(env:Env){
 const [settingsCount,audits]=await Promise.all([
  env.DB.prepare('SELECT COUNT(*) AS count FROM booking_settings WHERE workspace_id=?').bind(env.QA_WORKSPACE_ID).first<{count:number}>(),
  env.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action='customer.sender_configure'").first<{count:number}>(),
 ]);
 return {settings:settingsCount?.count??0,audits:audits?.count??0};
}
async function migrationCount(env:Env){const row=await env.DB.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{count:number}>();return Number(row?.count??-1);}

const worker={async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url);
 if(url.hostname!=='127.0.0.1'||url.port!=='8805'||request.headers.get('authorization')!==`Bearer ${env.QA_TOKEN}`)return json({error:'fixture_unavailable'},404);
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 let body:Record<string,unknown>;try{body=await request.json() as Record<string,unknown>;}catch{return json({error:'invalid_json'},400);}
 try{
  switch(body.action){
   case 'init':{
    const countsNow=await counts(env),migrations=await migrationCount(env);
    const ready=migrations===31&&countsNow.settings===0&&countsNow.audits===0;
    return json({ready,migrations,counts:countsNow});
   }
   case 'state':return json(await state(env));
   case 'counts':return json(await counts(env));
   case 'audits':{
    const rows=await env.DB.prepare("SELECT id,google_subject,action,target,created_at FROM admin_audit WHERE action='customer.sender_configure' ORDER BY created_at,id").all<{id:string;google_subject:string;action:string;target:string;created_at:number}>();
    return json({rows:rows.results});
   }
   case 'save':{
    const result=await settings(env).save(body.expectedRevision as number,body.config as BookingConfiguration,{actor:ACTOR,auditId:String(body.auditId)});
    return json({revision:result.revision,config:result.config,senderCheck:result.senderCheck,ownerConfirmation:result.ownerConfirmation,returnedAuditId:String(body.auditId)});
   }
   case 'arm-audit-failure':{
    await env.DB.exec("CREATE TRIGGER qa_customer_sender_audit_failure BEFORE INSERT ON admin_audit WHEN NEW.action='customer.sender_configure' BEGIN SELECT RAISE(ABORT,'synthetic customer sender audit failure'); END");
    return json({armed:true});
   }
   default:return json({error:'unknown_action'},400);
  }
 }catch(error){
  const message=error instanceof Error?error.message:'fixture_failure';
  const safe=new Set(['Settings changed','Sender setup must keep sending disabled','Settings unavailable']);
  return json({error:safe.has(message)?message:'fixture_failure'},409);
 }
}};

export default worker;
