import {ServiceOfferingStore} from '../../lib/service-offerings';

type Env={DB:D1Database;QA_OFFERINGS_TOKEN:string;QA_WORKSPACE_A:string;QA_WORKSPACE_B:string};
let fixtureNow=Date.now();
let publishClockBoundary:{kind:'after_eligible_read'|'after_pointer_bind';milliseconds:number;used:boolean;advanceCount:number;before:number}|null=null;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
function boundaryDatabase(db:D1Database){return new Proxy(db,{get(target,property){if(property==='prepare')return (sql:string)=>{const statement=target.prepare(sql);if(!publishClockBoundary||publishClockBoundary.used)return statement;const boundary=publishClockBoundary,afterEligible=boundary.kind==='after_eligible_read'&&sql.includes("status='draft'")&&sql.includes('service_offering_snapshots'),afterPointerBind=boundary.kind==='after_pointer_bind'&&sql.startsWith('INSERT INTO admin_settings(workspace_id,google_subject,key,value_json,revision,updated_at)'),advance=()=>{if(!boundary.used){boundary.used=true;boundary.advanceCount++;fixtureNow+=boundary.milliseconds;}};const wrap=(inner:D1PreparedStatement):D1PreparedStatement=>new Proxy(inner,{get(statementTarget,key){if(key==='bind')return (...values:unknown[])=>{const bound=Reflect.apply(statementTarget.bind,statementTarget,values);if(afterPointerBind)advance();return afterEligible?wrap(bound):bound;};if(key==='first'&&afterEligible)return async(...args:unknown[])=>{const result=await Reflect.apply(statementTarget.first,statementTarget,args);advance();return result;};const value=Reflect.get(statementTarget,key,statementTarget);return typeof value==='function'?value.bind(statementTarget):value;}});return afterEligible||afterPointerBind?wrap(statement):statement;};const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;}});}
function store(env:Env,workspace:unknown,withBoundary=false){const id=workspace==='a'?env.QA_WORKSPACE_A:workspace==='b'?env.QA_WORKSPACE_B:null;if(!id)throw new Error('invalid_workspace');return new ServiceOfferingStore(withBoundary?boundaryDatabase(env.DB):env.DB,id,()=>fixtureNow);}
async function counts(env:Env){const [snapshots,audit,pointers]=await Promise.all([
 env.DB.prepare('SELECT COUNT(*) AS count FROM service_offering_snapshots').first<{count:number}>(),
 env.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit WHERE action IN ('offerings.save_draft','offerings.publish','offerings.withdraw')").first<{count:number}>(),
 env.DB.prepare("SELECT COUNT(*) AS count FROM admin_settings WHERE google_subject='system:service-offerings' AND key='published-offerings-v1'").first<{count:number}>(),
]);return {snapshots:snapshots?.count??0,audit:audit?.count??0,pointers:pointers?.count??0};}
async function migrationCount(env:Env){const row=await env.DB.prepare('SELECT COUNT(*) AS count FROM d1_migrations').first<{count:number}>();return Number(row?.count??-1);}

export default {async fetch(request:Request,env:Env):Promise<Response>{
 if(request.headers.get('X-QA-Service-Offerings')!==env.QA_OFFERINGS_TOKEN)return json({error:'fixture_unavailable'},404);
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 let body:Record<string,unknown>;
 try{body=await request.json() as Record<string,unknown>;}catch{return json({error:'invalid_json'},400);}
 try{
  switch(body.action){
   case 'init':{const current=await counts(env);const migrations=await migrationCount(env);return json({ready:migrations===30&&current.snapshots===0&&current.audit===0&&current.pointers===0,migrations,counts:current});}
   case 'counts':return json(await counts(env));
   case 'clock/set':{const value=body.now;if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)throw new Error('invalid_clock');fixtureNow=value;return json({now:fixtureNow});}
   case 'advance':{const delta=body.milliseconds;if(typeof delta!=='number'||!Number.isSafeInteger(delta)||delta<0||delta>30*86400000)throw new Error('invalid_advance');fixtureNow+=delta;return json({now:fixtureNow});}
   case 'publish-clock-boundary':{const suppliedKind=body.kind;if(suppliedKind!=='after_eligible_read'&&suppliedKind!=='after_pointer_bind')throw new Error('invalid_clock');const kind:'after_eligible_read'|'after_pointer_bind'=suppliedKind;const delta=body.milliseconds;if(typeof delta!=='number'||!Number.isSafeInteger(delta)||delta<1||delta>30*86400000)throw new Error('invalid_advance');const boundary={kind,milliseconds:delta,used:false,advanceCount:0,before:fixtureNow};publishClockBoundary=boundary;try{return json({...await store(env,body.workspace,true).publish(body.input,typeof body.actor==='string'?body.actor:''),clockBoundary:{before:boundary.before,after:fixtureNow,advanceCount:boundary.advanceCount}});}catch(error){const message=error instanceof Error?error.message:'fixture_failure';return json({error:/^(offerings_changed|draft_changed|request_conflict)$/.test(message)?message:'fixture_failure',clockBoundary:{before:boundary.before,after:fixtureNow,advanceCount:boundary.advanceCount}},409);}finally{publishClockBoundary=null;}}
   case 'status':return json(await store(env,body.workspace).status());
   case 'public':return json(await store(env,body.workspace).publicOfferings());
   case 'draft':return json(await store(env,body.workspace).saveDraft(body.input,typeof body.actor==='string'?body.actor:''));
   case 'publish':return json(await store(env,body.workspace).publish(body.input,typeof body.actor==='string'?body.actor:''));
   case 'withdraw':return json(await store(env,body.workspace).withdraw(body.input,typeof body.actor==='string'?body.actor:''));
   case 'resolve':return json(await store(env,body.workspace).resolveSelection({offeringId:String(body.offeringId),offeringsRevision:Number(body.offeringsRevision)}));
   case 'audit-failure':{
    if(body.enabled===true){await env.DB.exec("CREATE TRIGGER qa_offerings_audit_failure BEFORE INSERT ON admin_audit WHEN NEW.action IN ('offerings.save_draft','offerings.publish','offerings.withdraw') BEGIN SELECT RAISE(ABORT,'synthetic offering audit failure'); END");return json({enabled:true});}
    await env.DB.prepare('DROP TRIGGER IF EXISTS qa_offerings_audit_failure').run();return json({enabled:false});
   }
   default:return json({error:'unknown_action'},400);
  }
 }catch(error){const message=error instanceof Error?error.message:'fixture_failure';return json({error:/^(actor_required|invalid_workspace|invalid_advance|invalid_clock|validated_catalog_unavailable|invalid_expiry|offerings_changed|draft_changed|offering_unavailable|offering_changed|request_conflict)$/.test(message)?message:'fixture_failure'},409);}
}};
