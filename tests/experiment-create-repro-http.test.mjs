import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';

const baseUrl=process.env.TEST_EXPERIMENTS_BASE_URL;
const adminCookie=process.env.TEST_EXPERIMENTS_ADMIN_COOKIE;
const siteUserId=process.env.TEST_EXPERIMENTS_SITE_USER_ID;
const siteUserEmail=process.env.TEST_EXPERIMENTS_SITE_USER_EMAIL;
const d1Config=process.env.TEST_EXPERIMENTS_D1_CONFIG;
const d1Persist=process.env.TEST_EXPERIMENTS_D1_PERSIST;
const d1Name=process.env.TEST_EXPERIMENTS_D1_NAME;
const enabled=!!(baseUrl&&adminCookie&&siteUserId&&siteUserEmail&&d1Config&&d1Persist&&d1Name);
const suite=enabled?test:test.skip;
const execFileAsync=promisify(execFile);

if(baseUrl&&!/^https:\/\/127\.0\.0\.1:8789$/i.test(baseUrl))throw new Error('Experiment create reproduction requires its dedicated loopback HTTPS fixture.');
if(d1Config&&d1Config.replaceAll('\\','/')!=='.sites-runtime/photo-app-fixture/wrangler.json')throw new Error('Unexpected isolated Worker config.');
if(d1Persist&&d1Persist.replaceAll('\\','/')!=='.wrangler/experiment-create-local-01')throw new Error('Unexpected disposable D1 directory.');
if(d1Name&&d1Name!=='site-creator-d1')throw new Error('Unexpected disposable D1 name.');

async function counts(){
  const {stdout}=await execFileAsync(process.execPath,[
    resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute',d1Name,'--local',
    '--config',d1Config,'--persist-to',d1Persist,'--json','--command',
    'SELECT (SELECT COUNT(*) FROM exp_versions) AS versions,(SELECT COUNT(*) FROM exp_compositions) AS compositions,(SELECT COUNT(*) FROM exp_audit) AS experiment_audit,(SELECT COUNT(*) FROM admin_audit) AS admin_audit,(SELECT COUNT(*) FROM admin_operation_runs) AS operations',
  ],{cwd:process.cwd(),timeout:30000,windowsHide:true});
  const start=stdout.search(/\[\s*\{/);
  assert.notEqual(start,-1,'Wrangler must return JSON results for the isolated D1 query.');
  const parsed=JSON.parse(stdout.slice(start));
  return parsed[0].results[0];
}

async function postTool(tool,args,requestKey){
  const url=new URL('/api/admin/tools',baseUrl);
  return fetch(url,{method:'POST',redirect:'manual',headers:{
    'oai-authenticated-user-id':siteUserId,
    'oai-authenticated-user-email':siteUserEmail,
    cookie:adminCookie,
    origin:url.origin,
    'content-type':'application/json',
  },body:JSON.stringify({tool,arguments:args,...(requestKey?{requestKey}:{})})});
}

suite('exact current Experiments UI create request against disposable D1',async()=>{
  const baselineBefore=await postTool('baseline.status',{});
  assert.equal(baselineBefore.status,200,'the seeded owner session should reach the baseline read tool');
  const beforeState=(await baselineBefore.json()).result;
  let baselineAfter=beforeState;
  if(!beforeState.persisted){
    const baselineSetup=await postTool('baseline.setup',{});
    assert.equal(baselineSetup.status,200,'persist the local approved compiled artifact before reproducing the current owner workflow');
    baselineAfter=(await baselineSetup.json()).result;
  }
  assert.equal(baselineAfter.persisted,true);
  assert.equal(baselineAfter.compatible,true);

  const described=await postTool('tool.describe',{name:'experiments.create'});
  assert.equal(described.status,200,'the experiments.create tool must be registered and describable');
  const description=(await described.json()).result;
  assert.equal(description.name,'experiments.create');
  assert.deepEqual(description.arguments,{title:'bounded string'});

  const listed=await postTool('experiments.list',{});
  assert.equal(listed.status,200,'the owner list tool should work before creation');
  assert.deepEqual((await listed.json()).result.versions,[]);
  const before=await counts();
  assert.equal(before.versions,0);
  assert.equal(before.compositions,0);
  assert.equal(before.experiment_audit,0);
  const response=await postTool('experiments.create',{title:'Seasonal date-request experiment'});
  const after=await counts();
  const diagnostic=await response.clone().json().catch(()=>null);
  const trace=diagnostic?.trace;
  const safeTrace=trace&&typeof trace==='object'?Object.fromEntries(['entered','completed','module','exceptionClass','sourceLine'].filter(key=>typeof trace[key]==='string'||typeof trace[key]==='number').map(key=>[key,trace[key]])):undefined;
  assert.equal(response.status,200,`The exact UI payload (without requestKey) returned HTTP ${response.status}; local row counts before=${JSON.stringify(before)}, after=${JSON.stringify(after)}${safeTrace?`, safe trace=${JSON.stringify(safeTrace)}`:''}.`);
  const body=await response.json();
  assert.match(body.result?.versionId??'',/^[0-9a-f-]{36}$/i);
  assert.equal(after.versions,before.versions+1,'one draft should persist');
  assert.equal(after.compositions,before.compositions+1,'the draft should include its default control composition');
  assert.equal(after.experiment_audit,before.experiment_audit+1,'the experiment audit should be persisted');
  assert.equal(after.admin_audit,before.admin_audit+1,'the create request should add one admin audit record');

  const inspected=await postTool('experiments.inspect',{versionId:body.result.versionId});
  assert.equal(inspected.status,200,'readback of the returned version ID should succeed');
  const record=(await inspected.json()).result;
  assert.equal(record.version.id,body.result.versionId);
  assert.equal(record.version.title,'Seasonal date-request experiment');
  assert.equal(record.version.stage,'draft');
  assert.equal(record.compositions.length,1);
  assert.equal(record.compositions[0].label,'control');
  assert.equal(record.compositions[0].allocation,10000);
  assert.deepEqual(JSON.parse(record.compositions[0].definition_json),{});

  const keyedBefore=await counts();
  const requestKey=crypto.randomUUID();
  const keyedArgs={title:'Idempotent local experiment draft'};
  const first=await postTool('experiments.create',keyedArgs,requestKey);
  assert.equal(first.status,200,'a stable optional key should be accepted for retries');
  const firstResult=(await first.json()).result;
  assert.match(firstResult?.versionId??'',/^[0-9a-f-]{36}$/i);
  const replay=await postTool('experiments.create',keyedArgs,requestKey);
  assert.equal(replay.status,200,'replaying the same create key and payload should return the saved result');
  assert.equal((await replay.json()).result.versionId,firstResult.versionId);
  const keyedAfter=await counts();
  assert.equal(keyedAfter.versions,keyedBefore.versions+1);
  assert.equal(keyedAfter.compositions,keyedBefore.compositions+1);
  assert.equal(keyedAfter.experiment_audit,keyedBefore.experiment_audit+1);
  assert.equal(keyedAfter.admin_audit,keyedBefore.admin_audit+1);
  assert.equal(keyedAfter.operations,keyedBefore.operations+1);
});
