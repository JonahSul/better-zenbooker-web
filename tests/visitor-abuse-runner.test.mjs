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
