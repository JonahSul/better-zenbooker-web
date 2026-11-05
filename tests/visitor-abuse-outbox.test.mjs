import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {createAbuseDb,root} from './fixtures/visitor-abuse-d1.mjs';

const envPlugin={name:'qa-cloudflare-env',setup(build){build.onResolve({filter:/^cloudflare:workers$/},()=>({path:'env',namespace:'qa'}));build.onLoad({filter:/.*/,namespace:'qa'},()=>({contents:'export const env = {};',loader:'js'}));}};
const built=await build({entryPoints:[path.join(root,'lib/visitor-abuse-outbox.ts'),path.join(root,'lib/encrypted-value.ts'),path.join(root,'lib/visitor-abuse-store.ts')],bundle:true,write:false,format:'esm',platform:'node',target:'node22',plugins:[envPlugin],outdir:'out'});
const modules={};for(const output of built.outputFiles)modules[path.basename(output.path)]=await import(`data:text/javascript;base64,${Buffer.from(output.text).toString('base64')}`);
const {runVisitorAbuse}=modules['visitor-abuse-outbox.js'];const {encryptValue}=modules['encrypted-value.js'];
const {VisitorAbuseStore}=modules['visitor-abuse-store.js'];
const key=Buffer.alloc(32,7).toString('base64'),account='a'.repeat(32),list='b'.repeat(32),workspace='synthetic-installation',subject='c'.repeat(64),ip='203.0.113.7';
const baseRuntime=db=>({DB:db,INSTALLATION_ID:workspace,APP_CREDENTIAL_ENCRYPTION_KEY:key,CLOUDFLARE_WAF_API_TOKEN:'synthetic-waf-token',VISITOR_ABUSE_WAF_ACCOUNT_ID:account,VISITOR_ABUSE_WAF_LIST_ID:list});
async function seed(db,desired=1){const ciphertext=await encryptValue(ip,`visitor-abuse-ip:v1:${workspace}:${subject}`,key);await db.prepare("INSERT INTO visitor_abuse_waf(workspace_id,subject_hash,ip_ciphertext,desired,generation,expires_at,state,operation_key,updated_at) VALUES(?,?,?, ?,1,?,'pending',?,?)").bind(workspace,subject,ciphertext,desired,Date.now()+86400000,`visitor-abuse:${workspace}:${subject}`,Date.now()).run();}
function json(data,status=200){return new Response(JSON.stringify({success:status<400,result:data}),{status,headers:{'content-type':'application/json'}});}
function listing(items,cursor){return json(items,cursor?200:200).clone();}

test('WAF adapter pages exact canonical IP matches and never treats a prefix result as membership',async t=>{
 const db=await createAbuseDb(t);await seed(db);
 const requests=[];let page=0;
 const fetcher=async(url,init)=>{requests.push({url:String(url),init});const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')){page++;if(page===1)return new Response(JSON.stringify({success:true,result:[{id:'d'.repeat(32),ip:'203.0.113.70',comment:'prefix-only'}],result_info:{cursors:{after:'next'}}}),{headers:{'content-type':'application/json'}});return new Response(JSON.stringify({success:true,result:[{id:'e'.repeat(32),ip:'203.0.113.7',comment:'foreign-entry'}]}),{headers:{'content-type':'application/json'}});}return json({operation_id:'f'.repeat(32)});};
 const result=await runVisitorAbuse(baseRuntime(db),fetcher);
 assert.equal(result.status,'confirmed');
 assert.equal(page,2);
 assert.equal(requests.filter(row=>row.init.method==='POST').length,0,'an exact foreign item already exists, so no duplicate add is sent');
 assert.ok(requests[0].url.includes('search=203.0.113.7'));
 const stored=await db.prepare('SELECT state,attention FROM visitor_abuse_waf').first();
 assert.deepEqual(stored,{state:'confirmed_foreign',attention:'foreign_item_not_owned'});
});

test('owned block submission stores operation ID and completion is verified before confirmation',async t=>{
 const db=await createAbuseDb(t);await seed(db);let operationId='f'.repeat(32),applied=false;const calls=[];
 const fetcher=async(url,init)=>{const parsed=new URL(String(url));calls.push({path:parsed.pathname,method:init.method,body:init.body});if(parsed.pathname.endsWith('/items')&&init.method==='GET')return json(applied?[{id:'e'.repeat(32),ip,comment:`visitor-abuse:${workspace}:${subject}:1`}]:[]);if(parsed.pathname.endsWith('/items')&&init.method==='POST'){const body=JSON.parse(init.body);assert.equal(body[0].ip,ip);assert.equal(body[0].comment,`visitor-abuse:${workspace}:${subject}:1`);return json({operation_id:operationId});}if(parsed.pathname.endsWith('/bulk_operations/'+operationId))return json({status:'completed'});throw new Error('unexpected fake WAF call '+parsed.pathname);};
 assert.equal((await runVisitorAbuse(baseRuntime(db),fetcher)).status,'pending');
 assert.equal((await db.prepare('SELECT state,operation_id,submitted_generation,submitted_desired FROM visitor_abuse_waf').first()).operation_id,operationId);
 applied=true;
 await db.prepare('UPDATE visitor_abuse_waf SET next_at=0').run();
 assert.equal((await runVisitorAbuse(baseRuntime(db),fetcher)).status,'confirmed');
 assert.deepEqual(await db.prepare('SELECT state,operation_id,desired,generation FROM visitor_abuse_waf').first(),{state:'confirmed',operation_id:null,desired:1,generation:1});
 assert.equal(calls.filter(call=>call.method==='POST').length,1);
});

test('foreign exact-IP membership is never deleted when an owner unblocks a local record',async t=>{
 const db=await createAbuseDb(t);await seed(db,0);let deletes=0;
 const fetcher=async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')){if(init.method==='DELETE')deletes++;return json([{id:'e'.repeat(32),ip,comment:'unrelated-owner-item'}]);}throw new Error('unexpected operation polling');};
 assert.equal((await runVisitorAbuse(baseRuntime(db),fetcher)).status,'needs_review');
 assert.equal(deletes,0);
 assert.deepEqual(await db.prepare('SELECT state,attention,desired FROM visitor_abuse_waf').first(),{state:'needs_review',attention:'foreign_item_ownership',desired:0});
});

test('missing WAF configuration does not erase a durable desired-state row',async t=>{
 const db=await createAbuseDb(t);await seed(db);
 const result=await runVisitorAbuse({DB:db,INSTALLATION_ID:workspace});
 assert.deepEqual(result,{status:'unconfigured',processed:0});
 assert.deepEqual(await db.prepare('SELECT desired,generation,state FROM visitor_abuse_waf').first(),{desired:1,generation:1,state:'pending'});
});

test('terminal provider-auth failure can resume the same durable generation after owner repairs credentials',async t=>{
 const db=await createAbuseDb(t);await seed(db);
 const failed=await runVisitorAbuse(baseRuntime(db),async()=>new Response(null,{status:401}));
 assert.equal(failed.status,'auth');
 assert.equal((await db.prepare('SELECT state,desired,generation FROM visitor_abuse_waf').first()).state,'terminal');
 const store=new VisitorAbuseStore(db,workspace);
 await assert.rejects(store.resume(subject,2,'verified-owner-subject'),/changed|paused/,'stale generation cannot resume synchronization');
 const resumed=await store.resume(subject,1,'verified-owner-subject');
 assert.deepEqual(resumed,{resumed:true,generation:1,desiredStatePreserved:true,operationReceiptPreserved:true});
 assert.equal((await db.prepare('SELECT state,desired,generation FROM visitor_abuse_waf').first()).state,'pending');
 assert.equal((await db.prepare('SELECT actor,action FROM visitor_abuse_audit').first()).action,'owner_resume_sync');
 const calls=[];
 const recovered=await runVisitorAbuse({...baseRuntime(db),CLOUDFLARE_WAF_API_TOKEN:'repaired-synthetic-token'},async(url,init)=>{const parsed=new URL(String(url));calls.push({path:parsed.pathname,method:init.method});if(parsed.pathname.endsWith('/items')&&init.method==='GET')return json([]);if(parsed.pathname.endsWith('/items')&&init.method==='POST')return json({operation_id:'f'.repeat(32)});throw new Error('unexpected fake WAF call');});
 assert.equal(recovered.status,'pending');
 assert.equal(calls.filter(call=>call.method==='POST').length,1);
 assert.deepEqual(await db.prepare('SELECT generation,desired,state FROM visitor_abuse_waf').first(),{generation:1,desired:1,state:'remote_pending'});
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_receipts').first()).n,0,'credential repair resumes reconciliation without a new offence or receipt');
});

test('a missing bulk-operation receipt reconciles membership instead of treating a known effect as completed',async t=>{
 const db=await createAbuseDb(t);await seed(db);
 const operationId='f'.repeat(32);
 await db.prepare("UPDATE visitor_abuse_waf SET state='remote_pending',operation_id=?,submitted_generation=1,submitted_desired=1 WHERE subject_hash=?").bind(operationId,subject).run();
 const calls=[];
 const result=await runVisitorAbuse(baseRuntime(db),async(url,init)=>{const parsed=new URL(String(url));calls.push({path:parsed.pathname,method:init.method});if(parsed.pathname.endsWith('/bulk_operations/'+operationId))return new Response(null,{status:404});if(parsed.pathname.endsWith('/items'))return json([{id:'e'.repeat(32),ip,comment:`visitor-abuse:${workspace}:${subject}:1`}]);throw new Error('unexpected call');});
 assert.equal(result.status,'effect_verified_operation_unknown');
 assert.deepEqual(await db.prepare('SELECT state,attention,operation_id,desired,generation FROM visitor_abuse_waf').first(),{state:'effect_verified_operation_unknown',attention:'operation_completion_unverified',operation_id:null,desired:1,generation:1});
 assert.equal(calls.filter(call=>call.method==='POST'||call.method==='DELETE').length,0,'membership confirms current state without an unnecessary mutation');
});

test('a lost add response becomes unknown and later membership reconciliation never sends a duplicate add',async t=>{
 const db=await createAbuseDb(t);await seed(db);let applied=false,posts=0;
 const first=await runVisitorAbuse(baseRuntime(db),async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')&&init.method==='GET')return json([]);if(parsed.pathname.endsWith('/items')&&init.method==='POST'){posts++;throw new Error('response lost after platform applied the request');}throw new Error('unexpected call');});
 assert.equal(first.status,'unknown');
 assert.equal((await db.prepare('SELECT state,submitted_generation,submitted_desired FROM visitor_abuse_waf').first()).state,'unknown');
 applied=true;await db.prepare('UPDATE visitor_abuse_waf SET next_at=0').run();
 const recovered=await runVisitorAbuse(baseRuntime(db),async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')&&init.method==='GET')return json(applied?[{id:'e'.repeat(32),ip,comment:`visitor-abuse:${workspace}:${subject}:1`}]:[]);if(parsed.pathname.endsWith('/items')&&init.method==='POST'){posts++;return json({operation_id:'f'.repeat(32)});}throw new Error('unexpected call');});
 assert.equal(recovered.status,'effect_verified_operation_unknown');
 assert.equal(posts,1,'uncertain add is resolved by readback without a blind duplicate POST');
 assert.equal((await db.prepare('SELECT state,attention FROM visitor_abuse_waf').first()).state,'effect_verified_operation_unknown');
});

test('a late block is corrected to a newer unblock generation with a conditional delete',async t=>{
 const db=await createAbuseDb(t);await seed(db);const operationId='f'.repeat(32);let applied=false,posts=0,deletes=0;
 const initial=await runVisitorAbuse(baseRuntime(db),async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')&&init.method==='GET')return json([]);if(parsed.pathname.endsWith('/items')&&init.method==='POST'){posts++;applied=true;return json({operation_id:operationId});}throw new Error('unexpected call');});
 assert.equal(initial.status,'pending');
 await db.prepare('UPDATE visitor_abuse_waf SET desired=0,generation=2,next_at=0 WHERE subject_hash=?').bind(subject).run();
 const completed=await runVisitorAbuse(baseRuntime(db),async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/bulk_operations/'+operationId))return json({status:'completed'});if(parsed.pathname.endsWith('/items')&&init.method==='GET')return json(applied?[{id:'e'.repeat(32),ip,comment:`visitor-abuse:${workspace}:${subject}:1`}]:[]);if(parsed.pathname.endsWith('/items')&&init.method==='DELETE'){deletes++;assert.deepEqual(JSON.parse(init.body),{items:[{id:'e'.repeat(32)}]});return json({operation_id:'1'.repeat(32)});}throw new Error('unexpected call');});
 assert.equal(completed.status,'pending');
 assert.equal(posts,1);
 assert.equal(deletes,1,'the older in-flight block is corrected using its owned exact item ID');
 assert.deepEqual(await db.prepare('SELECT desired,generation,state,submitted_generation,submitted_desired FROM visitor_abuse_waf').first(),{desired:0,generation:2,state:'remote_pending',submitted_generation:2,submitted_desired:0});
});

test('provider outage backs off durably, then retries the same generation after recovery',async t=>{
 const db=await createAbuseDb(t);await seed(db);
 const unavailable=await runVisitorAbuse(baseRuntime(db),async()=>new Response(null,{status:503}));
 assert.equal(unavailable.status,'transient');
 const waiting=await db.prepare('SELECT state,next_at,attempts,generation FROM visitor_abuse_waf').first();
 assert.equal(waiting.state,'pending');assert.ok(waiting.next_at>Date.now());assert.equal(waiting.generation,1);
 await db.prepare('UPDATE visitor_abuse_waf SET next_at=0').run();let post=0;
 const recovered=await runVisitorAbuse(baseRuntime(db),async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')&&init.method==='GET')return json([]);if(parsed.pathname.endsWith('/items')&&init.method==='POST'){post++;return json({operation_id:'f'.repeat(32)});}throw new Error('unexpected call');});
 assert.equal(recovered.status,'pending');assert.equal(post,1);
 assert.equal((await db.prepare('SELECT generation,desired FROM visitor_abuse_waf').first()).generation,1);
});

test('account lock fences concurrent reconciliation workers while one remote read is in flight',async t=>{
 const db=await createAbuseDb(t);await seed(db);let releaseRead,readStarted;const started=new Promise(resolve=>{readStarted=resolve;}),waiting=new Promise(resolve=>{releaseRead=resolve;});let reads=0,posts=0;
 const fetcher=async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')&&init.method==='GET'){reads++;readStarted();await waiting;return json([]);}if(parsed.pathname.endsWith('/items')&&init.method==='POST'){posts++;return json({operation_id:'f'.repeat(32)});}throw new Error('unexpected call');};
 const first=runVisitorAbuse(baseRuntime(db),fetcher);await started;
 const concurrent=await runVisitorAbuse(baseRuntime(db),fetcher);
 assert.deepEqual(concurrent,{status:'busy',processed:0});
 assert.equal(reads,1,'the second worker does not perform a competing membership read');
 releaseRead();assert.equal((await first).status,'pending');
 assert.equal(posts,1);
});

test('expired blocks advance the desired generation and reconcile toward removal',async t=>{
 const db=await createAbuseDb(t);await seed(db);const operationId='f'.repeat(32);
 await db.prepare("UPDATE visitor_abuse_waf SET state='remote_pending',operation_id=?,submitted_generation=1,submitted_desired=1,expires_at=? WHERE subject_hash=?").bind(operationId,Date.now()-1,subject).run();
 let deletes=0;
 const result=await runVisitorAbuse(baseRuntime(db),async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/bulk_operations/'+operationId))return json({status:'completed'});if(parsed.pathname.endsWith('/items')&&init.method==='GET')return json([{id:'e'.repeat(32),ip,comment:`visitor-abuse:${workspace}:${subject}:1`}]);if(parsed.pathname.endsWith('/items')&&init.method==='DELETE'){deletes++;return json({operation_id:'1'.repeat(32)});}throw new Error('unexpected call');});
 assert.equal(result.status,'pending');assert.equal(deletes,1);
 assert.deepEqual(await db.prepare('SELECT desired,generation,state,submitted_desired FROM visitor_abuse_waf').first(),{desired:0,generation:2,state:'remote_pending',submitted_desired:0});
});

test('owner synchronization resume requires verified owner, same-origin POST and the current generation',async t=>{
 const db=await createAbuseDb(t);await seed(db);
 await db.prepare("UPDATE visitor_abuse_waf SET state='terminal' WHERE subject_hash=?").bind(subject).run();
 const source=await readFile(path.join(root,'lib/visitor-abuse-admin.ts'),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const runtime={DB:db,INSTALLATION_ID:workspace,SITE_OWNER_USER_ID:'verified-owner',APP_CREDENTIAL_ENCRYPTION_KEY:key,CLOUDFLARE_WAF_API_TOKEN:'synthetic-token',VISITOR_ABUSE_WAF_ACCOUNT_ID:account,VISITOR_ABUSE_WAF_LIST_ID:list};
 const require=createRequire(import.meta.url),loaded={exports:{}};
 new Function('require','module','exports',compiled)((specifier)=>{
  if(specifier==='zod'||specifier==='zod/v3')return require(specifier);
  if(specifier==='./credential-store')return {CredentialStore:class{async presence(){return {present:true,source:'native'};}}};
  if(specifier==='./admin-auth-server')return {getGoogleAdmin:async request=>request.headers.get('x-qa-admin')==='verified-owner'?{siteUserId:'verified-owner',subject:'verified-owner-subject'}:request.headers.has('x-qa-admin')?{siteUserId:'other-owner',subject:'other-subject'}:null,readSmallBody:request=>request.text(),safeJson:(value,status=200)=>Response.json(value,{status}),rejected:(_request,message,status)=>Response.json({error:message},{status})};
  if(specifier==='./runtime-secrets')return {secretRuntime:()=>runtime};
  if(specifier==='./visitor-abuse-service')return {abuseRuntime:()=>runtime,abuseStore:()=>new VisitorAbuseStore(db,workspace)};
  throw new Error('Unexpected admin route import '+specifier);
 },loaded,loaded.exports);
 const route=loaded.exports.visitorAbuseAdminRoute;
 async function post(headers={},payload={subjectHash:subject,revision:0,action:'resume',generation:1}){return route(new Request('https://site.example/api/admin/support/abuse',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(payload)}));}
 assert.equal((await post({},{})).status,403,'anonymous callers cannot resume');
 assert.equal((await post({'x-qa-admin':'other-owner'})).status,403,'non-owner admin cannot resume');
 assert.equal((await post({'x-qa-admin':'verified-owner',origin:'https://attacker.example'})).status,403,'cross-origin form cannot resume');
 assert.equal((await post({'x-qa-admin':'verified-owner',origin:'https://site.example'},{subjectHash:subject,revision:0,action:'resume'})).status,400,'resume requires an explicit generation');
 assert.equal((await post({'x-qa-admin':'verified-owner',origin:'https://site.example'},{subjectHash:subject,revision:0,action:'resume',generation:2})).status,409,'stale generation remains fenced');
 const accepted=await post({'x-qa-admin':'verified-owner',origin:'https://site.example'});
 assert.equal(accepted.status,200);
 assert.deepEqual(await accepted.json(),{resumed:true,generation:1,desiredStatePreserved:true,operationReceiptPreserved:true});
});

test('owner GET exposes credential presence but never returns the WAF token',async t=>{
 const db=await createAbuseDb(t);
 const source=await readFile(path.join(root,'lib/visitor-abuse-admin.ts'),'utf8'),compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const runtime={DB:db,INSTALLATION_ID:workspace,SITE_OWNER_USER_ID:'verified-owner',APP_CREDENTIAL_ENCRYPTION_KEY:key,CLOUDFLARE_WAF_API_TOKEN:'secret-sentinel-never-return',VISITOR_ABUSE_WAF_ACCOUNT_ID:account,VISITOR_ABUSE_WAF_LIST_ID:list};
 const loaded={exports:{}};
 new Function('require','module','exports',compiled)((specifier)=>{
  if(specifier==='zod'||specifier==='zod/v3')return createRequire(import.meta.url)(specifier);
  if(specifier==='./credential-store')return {CredentialStore:class{async presence(){return {present:true,source:'native'};}}};
  if(specifier==='./admin-auth-server')return {getGoogleAdmin:async()=>({siteUserId:'verified-owner',subject:'owner-subject'}),readSmallBody:request=>request.text(),safeJson:(value,status=200)=>Response.json(value,{status}),rejected:(_request,message,status)=>Response.json({error:message},{status})};
  if(specifier==='./runtime-secrets')return {secretRuntime:()=>runtime};
  if(specifier==='./visitor-abuse-service')return {abuseRuntime:()=>runtime,abuseStore:()=>new VisitorAbuseStore(db,workspace)};
  throw new Error('Unexpected admin route import '+specifier);
 },loaded,loaded.exports);
 const response=await loaded.exports.visitorAbuseAdminRoute(new Request('https://site.example/api/admin/support/abuse'));
 assert.equal(response.status,200);
 const body=await response.text();
 assert.match(body,/"wafConfigured":true/);
 assert.doesNotMatch(body,/secret-sentinel-never-return/);
 assert.match(body,/"ipMode":"session_only"/,'the UI reports IP mode unavailable until ingress is enrolled');
});

test('a WAF 429 retries the same desired generation and idempotency key',async t=>{
 const db=await createAbuseDb(t);await seed(db);let posts=0,items=[],operation='f'.repeat(32);const keys=[];
 const fetcher=async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')&&init.method==='GET')return json(items);if(parsed.pathname.endsWith('/items')&&init.method==='POST'){posts++;const body=JSON.parse(init.body);keys.push(body[0].comment);if(posts===1)return new Response(null,{status:429});return json({operation_id:operation});}if(parsed.pathname.endsWith('/bulk_operations/'+operation))return json({status:'completed'});throw new Error('unexpected fake WAF call '+parsed.pathname);};
 assert.equal((await runVisitorAbuse(baseRuntime(db),fetcher)).status,'contention');
 let row=await db.prepare('SELECT state,desired,generation,attempts FROM visitor_abuse_waf').first();assert.deepEqual(row,{state:'pending',desired:1,generation:1,attempts:1});
 await db.prepare('UPDATE visitor_abuse_waf SET next_at=0').run();
 assert.equal((await runVisitorAbuse(baseRuntime(db),fetcher)).status,'pending');
 row=await db.prepare('SELECT state,desired,generation,operation_id FROM visitor_abuse_waf').first();assert.deepEqual(row,{state:'remote_pending',desired:1,generation:1,operation_id:operation});
 items=[{id:'e'.repeat(32),ip,comment:`visitor-abuse:${workspace}:${subject}:1`}];await db.prepare('UPDATE visitor_abuse_waf SET next_at=0').run();
 assert.equal((await runVisitorAbuse(baseRuntime(db),fetcher)).status,'confirmed');
 assert.equal(posts,2);assert.deepEqual(keys,[`visitor-abuse:${workspace}:${subject}:1`,`visitor-abuse:${workspace}:${subject}:1`]);
 assert.deepEqual(await db.prepare('SELECT desired,generation,state FROM visitor_abuse_waf').first(),{desired:1,generation:1,state:'confirmed'});
});

test('known pending and running operations are polled without membership changes or mutations',async t=>{
 const db=await createAbuseDb(t);await seed(db);const operation='f'.repeat(32);
 await db.prepare("UPDATE visitor_abuse_waf SET state='remote_pending',operation_id=?,submitted_generation=1,submitted_desired=1 WHERE subject_hash=?").bind(operation,subject).run();
 let poll=0,membership=0,mutations=0;
 const fetcher=async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/bulk_operations/'+operation))return json({status:++poll===1?'pending':'running'});if(parsed.pathname.endsWith('/items')){membership++;if(init.method==='GET')return json([]);mutations++;}throw new Error('unexpected fake WAF call '+parsed.pathname);};
 assert.equal((await runVisitorAbuse(baseRuntime(db),fetcher)).status,'pending');
 await db.prepare('UPDATE visitor_abuse_waf SET next_at=0').run();
 assert.equal((await runVisitorAbuse(baseRuntime(db),fetcher)).status,'pending');
 assert.equal(poll,2);assert.equal(membership,0);assert.equal(mutations,0);
 assert.deepEqual(await db.prepare('SELECT state,operation_id,desired,generation FROM visitor_abuse_waf').first(),{state:'remote_pending',operation_id:operation,desired:1,generation:1});
});

test('repeated pagination cursors fail closed and never declare absence or mutate the list',async t=>{
 const db=await createAbuseDb(t);await seed(db);let pages=0,mutations=0;
 const fetcher=async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')&&init.method==='GET'){pages++;return new Response(JSON.stringify({success:true,result:[],result_info:{cursors:{after:'stuck-cursor'}}}),{headers:{'content-type':'application/json'}});}if(parsed.pathname.endsWith('/items'))mutations++;throw new Error('unexpected fake WAF call '+parsed.pathname);};
 const result=await runVisitorAbuse(baseRuntime(db),fetcher);
 assert.equal(result.status,'configuration');assert.equal(pages,2);assert.equal(mutations,0);
 assert.deepEqual(await db.prepare('SELECT state,desired,generation,attention FROM visitor_abuse_waf').first(),{state:'terminal',desired:1,generation:1,attention:'configuration'});
});

test('a transient read after a lost mutation preserves uncertainty through matching membership',async t=>{
 const db=await createAbuseDb(t);await seed(db);let posts=0,reads=0;
 const lost=await runVisitorAbuse(baseRuntime(db),async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')&&init.method==='GET')return json([]);if(parsed.pathname.endsWith('/items')&&init.method==='POST'){posts++;throw new Error('lost response after possible remote apply');}throw new Error('unexpected fake WAF call '+parsed.pathname);});
 assert.equal(lost.status,'unknown');
 await db.prepare('UPDATE visitor_abuse_waf SET next_at=0').run();
 const transient=await runVisitorAbuse(baseRuntime(db),async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')&&init.method==='GET'){reads++;return new Response(null,{status:503});}throw new Error('uncertain operation must not be mutated');});
 assert.equal(transient.status,'transient');assert.deepEqual(await db.prepare('SELECT state,submitted_generation FROM visitor_abuse_waf').first(),{state:'unknown',submitted_generation:1});
 await db.prepare('UPDATE visitor_abuse_waf SET next_at=0').run();
 const matched=await runVisitorAbuse(baseRuntime(db),async(url,init)=>{const parsed=new URL(String(url));if(parsed.pathname.endsWith('/items')&&init.method==='GET'){reads++;return json([{id:'e'.repeat(32),ip,comment:`visitor-abuse:${workspace}:${subject}:1`}]);}throw new Error('matching unknown effect requires no mutation');});
 assert.equal(matched.status,'effect_verified_operation_unknown');assert.equal(posts,1);assert.equal(reads,2);
 assert.deepEqual(await db.prepare('SELECT state,attention,desired,generation FROM visitor_abuse_waf').first(),{state:'effect_verified_operation_unknown',attention:'operation_completion_unverified',desired:1,generation:1});
});
