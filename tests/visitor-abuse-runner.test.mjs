import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {createAbuseDb,root} from './fixtures/visitor-abuse-d1.mjs';

const built=await build({entryPoints:[path.join(root,'lib/visitor-abuse-runner-core.ts')],bundle:true,write:false,format:'esm',platform:'node',target:'node22'});
const runner=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const key='synthetic-runner-key-with-more-than-32-bytes',installation='synthetic-installation';

const serviceBundle=await build({entryPoints:[path.join(root,'lib/visitor-abuse-service.ts')],bundle:true,write:false,format:'esm',platform:'node',target:'node22',plugins:[{name:'get-only-cloudflare-env',setup(builder){builder.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cloudflare-env',namespace:'qa'}));builder.onLoad({filter:/.*/,namespace:'qa'},args=>args.path==='runtime-secrets'?{contents:`export const SITE_PROJECT_ID=${JSON.stringify(installation)};`,loader:'js'}:{contents:'const env=new Proxy(Object.create(null),{get(_target,key){return globalThis.__fixtureEnv?.[key];}});export{env};',loader:'js'});builder.onResolve({filter:/^\.\/runtime-secrets$/},()=>({path:'runtime-secrets',namespace:'qa'}));}}]});
const service=await import(`data:text/javascript;base64,${Buffer.from(serviceBundle.outputFiles[0].text).toString('base64')}`);

function loadRunnerRoute(serviceRuntime,verification,run){
 const source=readFile(path.join(root,'lib/visitor-abuse-runner.ts'),'utf8');
 return source.then(text=>{
  const compiled=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
  const loaded={exports:{}};
  new Function('require','module','exports',compiled)((specifier)=>{
   if(specifier==='../../../../../lib/admin-auth-server'||specifier==='./admin-auth-server')return {readSmallBody:request=>request.text(),safeJson:(value,status=200)=>Response.json(value,{status})};
   if(specifier==='./visitor-abuse-service')return serviceRuntime;
   if(specifier==='./visitor-abuse-runner-core')return verification;
   if(specifier==='./visitor-abuse-outbox')return {runVisitorAbuse:run};
   throw new Error('Unexpected internal runner import '+specifier);
  },loaded,loaded.exports);
  return loaded.exports.visitorAbuseRunnerRoute;
 });
}

async function signedRunnerRequest(workspace=installation){
 let sent;
 await runner.triggerVisitorAbuseRunner({key,origin:'https://site.example',installation:workspace},async(url,init)=>{sent={url:String(url),init};return new Response(null,{status:202});});
 return new Request(sent.url,{method:sent.init.method,headers:sent.init.headers,body:sent.init.body});
}

test('scheduled helper targets only the fixed HTTPS origin and runner path with a signed bounded body',async()=>{
 const calls=[];
 const response=await runner.triggerVisitorAbuseRunner({key,origin:'https://site.example',installation},async(url,init)=>{calls.push({url:String(url),init});return new Response(null,{status:202});});
 assert.deepEqual(response,{status:'accepted'});
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,'https://site.example/api/internal/visitor-abuse/run');
 assert.equal(calls[0].init.method,'POST');
 assert.equal(calls[0].init.redirect,'manual');
 const body=calls[0].init.body,time=calls[0].init.headers['X-Visitor-Abuse-Time'],nonce=calls[0].init.headers['X-Visitor-Abuse-Nonce'];
 const request=new Request(calls[0].url,{method:'POST',headers:{'X-Visitor-Abuse-Time':time,'X-Visitor-Abuse-Nonce':nonce,'X-Visitor-Abuse-Signature':calls[0].init.headers['X-Visitor-Abuse-Signature']},body});
 assert.equal(await runner.verifyAbuseRunner(request,body,key,installation),nonce);
});

test('runner authentication rejects changed method/path/query/body/time/nonce/key and installation',async()=>{
 let call;
 await runner.triggerVisitorAbuseRunner({key,origin:'https://site.example',installation},async(url,init)=>{call={url:String(url),init};return new Response(null,{status:202});});
 const body=call.init.body,time=call.init.headers['X-Visitor-Abuse-Time'],nonce=call.init.headers['X-Visitor-Abuse-Nonce'],signature=call.init.headers['X-Visitor-Abuse-Signature'];
 const request=(url=call.url,method='POST',t=time,n=nonce,s=signature,raw=body)=>new Request(url,{method,headers:{'X-Visitor-Abuse-Time':t,'X-Visitor-Abuse-Nonce':n,'X-Visitor-Abuse-Signature':s},body:method==='POST'?raw:undefined});
 for(const candidate of [request(call.url,'GET'),request(call.url+'?mode=force'),request(call.url.replace('/run','/other')),request(call.url,'POST',String(Number(time)-120000)),request(call.url,'POST',time,'not-a-uuid'),request(call.url,'POST',time,nonce,'0'.repeat(64)),request(call.url,'POST',time,nonce,signature,body+' ' )]) assert.equal(await runner.verifyAbuseRunner(candidate,candidate.method==='POST'?candidate===undefined?'':(await candidate.clone().text()):'',key,installation),null);
 assert.equal(await runner.verifyAbuseRunner(request(),body,key,'other-installation'),null);
 assert.equal(await runner.verifyAbuseRunner(request(),body,'short',installation),null);
});

test('runner sender refuses weak keys, noncanonical origins, credentials, and redirects',async()=>{
 for(const config of [{key:'short',origin:'https://site.example',installation},{key,origin:'http://site.example',installation},{key,origin:'https://site.example/path',installation},{key,origin:'https://user:pass@site.example',installation}]) assert.deepEqual(await runner.triggerVisitorAbuseRunner(config,async()=>{throw new Error('must not send');}),{status:'unconfigured'});
 const result=await runner.triggerVisitorAbuseRunner({key,origin:'https://site.example',installation},async()=>new Response(null,{status:302,headers:{location:'https://external.example'}}));
 assert.deepEqual(result,{status:'unavailable'});
});

test('the internal runner persists one-use nonce and rejects a signed replay',async t=>{
 const db=await createAbuseDb(t),workspace='synthetic-installation',runtime={DB:db,INSTALLATION_ID:workspace,VISITOR_ABUSE_RUNNER_KEY:key};
 const source=await readFile(path.join(root,'lib/visitor-abuse-runner.ts'),'utf8'),compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const loaded={exports:{}},require=createRequire(import.meta.url);
 new Function('require','module','exports',compiled)((specifier)=>{
  if(specifier==='./admin-auth-server')return {readSmallBody:request=>request.text(),safeJson:(value,status=200)=>Response.json(value,{status})};
  if(specifier==='./visitor-abuse-service')return {abuseRuntime:()=>runtime,abuseStore:()=>({workspace,statement:(sql,...args)=>db.prepare(sql).bind(...args)})};
  if(specifier==='./visitor-abuse-runner-core')return runner;
  if(specifier==='./visitor-abuse-outbox')return {runVisitorAbuse:async()=>({status:'unconfigured',processed:0})};
  throw new Error('Unexpected internal runner import '+specifier);
 },loaded,loaded.exports);
 let sent;
 await runner.triggerVisitorAbuseRunner({key,origin:'https://site.example',installation:workspace},async(url,init)=>{sent={url:String(url),init};return new Response(null,{status:202});});
 const request=new Request(sent.url,{method:sent.init.method,headers:sent.init.headers,body:sent.init.body});
 const first=await loaded.exports.visitorAbuseRunnerRoute(request,runtime);
 assert.equal(first.status,200);
 assert.deepEqual(await first.json(),{status:'unconfigured',processed:0});
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_runner_nonces').first()).n,1);
 const replay=await loaded.exports.visitorAbuseRunnerRoute(new Request(sent.url,{method:sent.init.method,headers:sent.init.headers,body:sent.init.body}),runtime);
 assert.equal(replay.status,409);
 assert.deepEqual(await replay.json(),{error:'Replay rejected'});
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_runner_nonces').first()).n,1);
});

test('default abuse runtime and internal runner read D1 and signing key from get-only Cloudflare env',async t=>{
 const db=await createAbuseDb(t),previous=globalThis.__fixtureEnv;
 t.after(()=>{globalThis.__fixtureEnv=previous;});
 globalThis.__fixtureEnv={DB:db,VISITOR_ABUSE_RUNNER_KEY:key};
 const runtime=service.abuseRuntime();
 assert.equal(runtime.DB,db);
 assert.equal(runtime.VISITOR_ABUSE_RUNNER_KEY,key);
 assert.equal(runtime.INSTALLATION_ID,installation);
 assert.equal(await service.inspectCaller(new Request('https://site.example/api/support/abuse'),'synthetic-caller-session-12345'),null);
 let verifiedKey=null,dispatchedRuntime=null;
 const route=await loadRunnerRoute(service,{...runner,verifyAbuseRunner:async(request,body,receivedKey,workspace)=>{verifiedKey=receivedKey;return runner.verifyAbuseRunner(request,body,receivedKey,workspace);}},async receivedRuntime=>{dispatchedRuntime=receivedRuntime;return {status:'unconfigured',processed:0};});
 const response=await route(await signedRunnerRequest());
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{status:'unconfigured',processed:0});
 assert.equal(verifiedKey,key);
 assert.equal(dispatchedRuntime.DB,db);
 assert.equal(dispatchedRuntime.VISITOR_ABUSE_RUNNER_KEY,key);
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_runner_nonces').first()).n,1);
});

test('default internal runner fails safely when only the key or only D1 is missing',async t=>{
 const db=await createAbuseDb(t),previous=globalThis.__fixtureEnv;
 t.after(()=>{globalThis.__fixtureEnv=previous;});
 let verificationCalls=0;
 const verification={...runner,verifyAbuseRunner:async(request,body,receivedKey,workspace)=>{verificationCalls++;return runner.verifyAbuseRunner(request,body,receivedKey,workspace);}};
 const route=await loadRunnerRoute(service,verification,async()=>{throw new Error('No outbox/provider dispatch expected');});

 globalThis.__fixtureEnv={DB:db};
 let response=await route(await signedRunnerRequest());
 assert.equal(response.status,503);
 assert.equal(verificationCalls,0,'missing key is detected before callback verification');
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_runner_nonces').first()).n,0);

 globalThis.__fixtureEnv={VISITOR_ABUSE_RUNNER_KEY:key};
 response=await route(await signedRunnerRequest());
 assert.equal(response.status,503);
 assert.equal(verificationCalls,1,'present key verifies the signed callback before missing storage fails closed');
 assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM visitor_abuse_runner_nonces').first()).n,0);
});
