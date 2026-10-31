import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';

const envNames=['TEST_BRIDGE_CAPTURE_BASE_URL','TEST_BRIDGE_CAPTURE_CALLBACK_TOKEN','TEST_BRIDGE_CAPTURE_BEARER_TOKEN','TEST_BRIDGE_CAPTURE_D1_CONFIG','TEST_BRIDGE_CAPTURE_D1_PERSIST','TEST_BRIDGE_CAPTURE_D1_NAME'];
const present=envNames.filter(name=>process.env[name]);
const enabled=present.length===envNames.length;
if(present.length&&!enabled)throw new Error('Capture ingress test requires all isolated fixture variables.');
let base,callbackToken,bearerToken,config,persist,name;
if(enabled){
  base=new URL(process.env.TEST_BRIDGE_CAPTURE_BASE_URL);
  if(!['http:','https:'].includes(base.protocol)||!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw new Error('Capture ingress tests are restricted to loopback.');
  callbackToken=process.env.TEST_BRIDGE_CAPTURE_CALLBACK_TOKEN;
  bearerToken=process.env.TEST_BRIDGE_CAPTURE_BEARER_TOKEN;
  config=process.env.TEST_BRIDGE_CAPTURE_D1_CONFIG.replaceAll('\\','/');
  persist=process.env.TEST_BRIDGE_CAPTURE_D1_PERSIST.replaceAll('\\','/');
  name=process.env.TEST_BRIDGE_CAPTURE_D1_NAME;
  if(!/^[0-9a-f]{64}$/.test(callbackToken)||!/^[0-9a-f]{64}$/.test(bearerToken))throw new Error('Capture ingress tokens must be synthetic 256-bit hex values.');
  if(!/\.sites-runtime\/bridge-capture-[^/]+\/wrangler\.json$/i.test(config))throw new Error('Capture ingress tests require a dedicated local receiver config.');
  if(!/\.wrangler\/bridge-capture-local-[^/]+$/i.test(persist))throw new Error('Capture ingress tests require a dedicated disposable local database.');
  if(name!=='bridge-capture-fixture')throw new Error('Unexpected capture ingress fixture database.');
}
const suite=enabled?test:test.skip;
const digest=value=>createHash('sha256').update(value).digest('hex');
const url=path=>new URL(path,base).href;
async function json(response){const text=await response.text();try{return JSON.parse(text);}catch{throw new Error(`Expected JSON HTTP response; got status ${response.status}.`);}}
async function authenticated(path,{method='GET',body=''}={}){
  const bytes=typeof body==='string'?body:JSON.stringify(body);
  const headers={authorization:`Bearer ${bearerToken}`,'x-bridge-timestamp':String(Date.now()),'x-bridge-nonce':randomUUID(),'x-bridge-body-sha256':digest(bytes)};
  if(bytes)headers['content-type']='application/json';
  return fetch(url(path),{method,headers:{connection:'close',...headers},body:method==='GET'?undefined:bytes,redirect:'manual',cache:'no-store'});
}
function event(retryCount=0,id='fixture-job-capture'){
  return {event:'job.created',account:{id:'fixture-account'},webhook_id:'fixture-webhook',retry_count:retryCount,data:{id,status:'scheduled',customer:{name:'CAPTURE_CONTACT_SENTINEL',email:'capture-contact-sentinel@example.invalid',phone:'+15555550123'},location:{address:'Capture Fixture Address'}}};
}
function localD1(sql){
  assert.ok(enabled);
  const stdout=execFileSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute',name,'--local','--config',resolve(config),'--persist-to',resolve(persist),'--command',sql,'--json'],{cwd:process.cwd(),encoding:'utf8',timeout:30000,windowsHide:true});
  const start=stdout.indexOf('[\n');
  assert.notEqual(start,-1,'local D1 must return JSON results');
  return JSON.parse(stdout.slice(start));
}
function counts(){return localD1("SELECT (SELECT COUNT(*) FROM bridge_captures) AS captures,(SELECT COUNT(*) FROM bridge_inbox) AS inbox,(SELECT COUNT(*) FROM bridge_jobs) AS jobs")[0].results[0];}

suite('webhook capture is durable before acknowledgement, encrypted, deduplicated, and fail-closed',async()=>{
  const initial=counts();
  assert.deepEqual(initial,{captures:0,inbox:0,jobs:0});
  const legacyStatus=await json(await authenticated('/bridge/status'));
  assert.deepEqual(Object.keys(legacyStatus).sort(),['bridgeVerifier','browserBindingAvailable','callbackVerifier','config','configured','lastProbe','previousVerifiersPresent','retentionDays','retentionFloor','revision'].sort(),'legacy status stays shape-compatible');
  const deniedStatus=await fetch(url('/bridge/capture-status'),{method:'GET',headers:{connection:'close'},redirect:'manual'});
  assert.equal(deniedStatus.status,401,'capture metadata status stays behind the existing bearer guard');
  const raw=JSON.stringify(event());
  const first=await fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`),{method:'POST',headers:{connection:'close','content-type':'application/json'},body:raw,redirect:'manual',cache:'no-store'});
  assert.equal(first.status,200);
  const firstBody=await json(first);
  assert.equal(firstBody.received,true);
  assert.equal(firstBody.disposition,'quarantine','the fresh fixture remains in setup mode');
  assert.equal(firstBody.duplicate,false);
  assert.equal(firstBody.capture.available,true);
  assert.equal(typeof firstBody.capture.id,'string');
  assert.equal(JSON.stringify(firstBody).includes('CAPTURE_CONTACT_SENTINEL'),false);
  assert.equal(JSON.stringify(firstBody).includes('capture-contact-sentinel@example.invalid'),false);
  assert.ok(firstBody.capture.expiresAt>Date.now());
  assert.ok(firstBody.capture.expiresAt<=Date.now()+30*86400000+5000);
  const captureStatus=await json(await authenticated('/bridge/capture-status'));
  assert.equal(captureStatus.configured,true);
  assert.equal(captureStatus.namespace,'sample-business-booking-inbox-v1');
  assert.equal(captureStatus.keyVersion,'v1');
  assert.equal(captureStatus.activeCount,1);
  assert.equal(JSON.stringify(captureStatus).includes('ciphertext'),false);
  assert.equal(JSON.stringify(captureStatus).includes('CAPTURE_CONTACT_SENTINEL'),false);
  assert.equal(Object.hasOwn(captureStatus,'keyBase64'),false);

  const stored=localD1(`SELECT COUNT(*) AS captures,MIN(body_sha256) AS body_hash,MIN(namespace) AS namespace,MIN(byte_length) AS byte_length,MIN(mode) AS mode,MIN(key_version) AS key_version,MIN(expires_at) AS expires_at,MAX(instr(ciphertext,'CAPTURE_CONTACT_SENTINEL')) AS sentinel_match FROM bridge_captures`)[0].results[0];
  assert.equal(stored.captures,1);
  assert.equal(stored.body_hash,digest(raw));
  assert.equal(stored.namespace,'sample-business-booking-inbox-v1');
  assert.equal(stored.byte_length,Buffer.byteLength(raw));
  assert.equal(stored.mode,'setup');
  assert.equal(stored.key_version,'v1');
  assert.equal(stored.sentinel_match,0);
  assert.equal(JSON.stringify(counts()),JSON.stringify({captures:1,inbox:1,jobs:0}));

  const exactRetry=await fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`),{method:'POST',headers:{connection:'close','content-type':'application/json'},body:raw,redirect:'manual',cache:'no-store'});
  assert.equal(exactRetry.status,200);
  assert.equal((await json(exactRetry)).duplicate,true);
  assert.deepEqual(counts(),{captures:1,inbox:1,jobs:0});

  const changedRetry=JSON.stringify(event(4));
  assert.notEqual(changedRetry,raw);
  const retry=await fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`),{method:'POST',headers:{connection:'close','content-type':'application/json'},body:changedRetry,redirect:'manual',cache:'no-store'});
  assert.equal(retry.status,200);
  assert.equal((await json(retry)).duplicate,true);
  assert.deepEqual(counts(),{captures:2,inbox:1,jobs:0},'raw retry bytes are separately captured while the webhook outcome remains deduped');

  const legacyKey=localD1('SELECT event_key FROM bridge_inbox LIMIT 1')[0].results[0].event_key;
  localD1(`DELETE FROM bridge_captures WHERE event_key='${legacyKey}'`);
  assert.deepEqual(counts(),{captures:0,inbox:1,jobs:0});
  const upgraded=await fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`),{method:'POST',headers:{connection:'close','content-type':'application/json'},body:raw,redirect:'manual',cache:'no-store'});
  assert.equal(upgraded.status,200);
  assert.equal((await json(upgraded)).duplicate,true);
  assert.deepEqual(counts(),{captures:1,inbox:1,jobs:0},'a legacy metadata-only receipt is captured before the duplicate acknowledgement');

  const pulled=await json(await authenticated('/bridge/pull?cursor=0&limit=100'));
  assert.equal(pulled.items.length,1);
  assert.equal(pulled.items[0].reason,'schema_unverified');
  assert.equal(JSON.stringify(pulled).includes('CAPTURE_CONTACT_SENTINEL'),false);
  assert.equal(JSON.stringify(pulled).includes('capture-contact-sentinel@example.invalid'),false);
  const ack=await authenticated('/bridge/ack',{method:'POST',body:{cursor:pulled.nextCursor}});
  assert.equal(ack.status,200);
  assert.deepEqual(counts(),{captures:1,inbox:1,jobs:0},'acknowledgement never deletes encrypted evidence');

  localD1("CREATE TRIGGER fixture_capture_failure BEFORE INSERT ON bridge_captures BEGIN SELECT RAISE(ABORT,'fixture'); END");
  try{
    const failed=await fetch(url(`/webhooks/zenbooker?cap=${callbackToken}`),{method:'POST',headers:{connection:'close','content-type':'application/json'},body:JSON.stringify(event(0,'fixture-job-failed-capture')),redirect:'manual',cache:'no-store'});
    assert.ok(failed.status<200||failed.status>=300,'capture failure must not be acknowledged as success');
    assert.equal(JSON.stringify(await json(failed)).includes('CAPTURE_CONTACT_SENTINEL'),false);
    assert.deepEqual(counts(),{captures:1,inbox:1,jobs:0},'capture, inbox receipt, and job outcome commit or roll back together');
  }finally{
    localD1('DROP TRIGGER fixture_capture_failure');
  }
});
