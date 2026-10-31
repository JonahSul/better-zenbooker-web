import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

const envNames=['TEST_BRIDGE_CAPTURE_BASE_URL','TEST_BRIDGE_CAPTURE_CALLBACK_TOKEN','TEST_BRIDGE_CAPTURE_D1_CONFIG','TEST_BRIDGE_CAPTURE_D1_PERSIST','TEST_BRIDGE_CAPTURE_D1_NAME'];
const present=envNames.filter(name=>process.env[name]);
const enabled=present.length===envNames.length;
if(present.length&&!enabled)throw new Error('Capture capacity test requires all isolated fixture variables.');
let base,callbackToken,config,persist,name;
if(enabled){
  base=new URL(process.env.TEST_BRIDGE_CAPTURE_BASE_URL);
  if(!['http:','https:'].includes(base.protocol)||!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw new Error('Capture capacity tests are restricted to loopback.');
  callbackToken=process.env.TEST_BRIDGE_CAPTURE_CALLBACK_TOKEN;
  config=process.env.TEST_BRIDGE_CAPTURE_D1_CONFIG.replaceAll('\\','/');
  persist=process.env.TEST_BRIDGE_CAPTURE_D1_PERSIST.replaceAll('\\','/');
  name=process.env.TEST_BRIDGE_CAPTURE_D1_NAME;
  if(!/^[0-9a-f]{64}$/.test(callbackToken))throw new Error('Capture callback token must be synthetic 256-bit hex.');
  if(!/\.sites-runtime\/bridge-capture-[^/]+\/wrangler\.json$/i.test(config))throw new Error('Capture capacity tests require a dedicated local receiver config.');
  if(!/\.wrangler\/bridge-capture-local-[^/]+$/i.test(persist))throw new Error('Capture capacity tests require a dedicated disposable local database.');
  if(name!=='bridge-capture-fixture')throw new Error('Unexpected capture capacity fixture database.');
}
const suite=enabled?test:test.skip;
const url=path=>new URL(path,base).href;
const digest=value=>createHash('sha256').update(value).digest('hex');
function localD1(sql){
  assert.ok(enabled);
  const stdout=execFileSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute',name,'--local','--config',resolve(config),'--persist-to',resolve(persist),'--command',sql,'--json'],{cwd:process.cwd(),encoding:'utf8',timeout:30000,windowsHide:true});
  const start=stdout.indexOf('[\n');
  assert.notEqual(start,-1,'local D1 must return JSON results');
  return JSON.parse(stdout.slice(start));
}
function counts(){return localD1('SELECT (SELECT COUNT(*) FROM bridge_captures) AS captures,(SELECT COUNT(*) FROM bridge_inbox) AS inbox,(SELECT COUNT(*) FROM bridge_jobs) AS jobs')[0].results[0];}
function syntheticEvent(jobId){return JSON.stringify({event:'job.created',account:{id:'capacity-fixture-account'},webhook_id:'capacity-fixture-hook',retry_count:0,data:{id:jobId,status:'scheduled',customer:{name:'CAPACITY_SENTINEL',email:'capacity-sentinel@example.invalid'}}});}
async function submit(body){
  return fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`),{method:'POST',headers:{connection:'close','content-type':'application/json'},body,redirect:'manual',cache:'no-store'});
}

suite('capture capacity limits reject before inbox or job acknowledgement',async()=>{
  assert.deepEqual(counts(),{captures:0,inbox:0,jobs:0});

  const now=Date.now();
  localD1(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<10000) INSERT INTO bridge_captures(id,event_key,body_sha256,key_version,namespace,parser_policy_version,mode,config_revision,byte_length,captured_at,expires_at,nonce,ciphertext) SELECT printf('00000000-0000-4000-8000-%012d',n),printf('%064x',n),printf('%064x',n+10000),'v1','sample-business-booking-inbox-v1','webhook-inspection-v1','setup',0,1,${now},${now+86400000},'fixture-nonce','fixture-ciphertext' FROM seq`);
  assert.deepEqual(counts(),{captures:10000,inbox:0,jobs:0});
  const countLimited=await submit(syntheticEvent('capacity-count-limit'));
  const countText=await countLimited.text();
  assert.equal(countLimited.status,503);
  assert.equal(countText.includes('CAPACITY_SENTINEL'),false);
  assert.deepEqual(counts(),{captures:10000,inbox:0,jobs:0},'count-capacity rejection adds neither evidence nor business receipt');

  localD1('DELETE FROM bridge_captures');
  localD1(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<256) INSERT INTO bridge_captures(id,event_key,body_sha256,key_version,namespace,parser_policy_version,mode,config_revision,byte_length,captured_at,expires_at,nonce,ciphertext) SELECT printf('10000000-0000-4000-8000-%012d',n),printf('%064x',n+20000),printf('%064x',n+30000),'v1','sample-business-booking-inbox-v1','webhook-inspection-v1','setup',0,262144,${now},${now+86400000},'fixture-nonce','fixture-ciphertext' FROM seq`);
  assert.deepEqual(localD1('SELECT COUNT(*) AS captures,SUM(byte_length) AS raw_bytes FROM bridge_captures')[0].results[0],{captures:256,raw_bytes:67108864});
  const byteLimited=await submit(syntheticEvent('capacity-byte-limit'));
  const byteText=await byteLimited.text();
  assert.equal(byteLimited.status,503);
  assert.equal(byteText.includes('CAPACITY_SENTINEL'),false);
  assert.deepEqual(counts(),{captures:256,inbox:0,jobs:0},'raw-byte capacity rejection adds neither evidence nor business receipt');
  assert.equal(JSON.stringify(counts()).includes('capacity-sentinel@example.invalid'),false);
});
