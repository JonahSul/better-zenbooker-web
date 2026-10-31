import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

const envNames=['TEST_BRIDGE_CAPTURE_BASE_URL','TEST_BRIDGE_CAPTURE_BEARER_TOKEN','TEST_BRIDGE_CAPTURE_D1_CONFIG','TEST_BRIDGE_CAPTURE_D1_PERSIST','TEST_BRIDGE_CAPTURE_D1_NAME'];
const present=envNames.filter(name=>process.env[name]);
const enabled=present.length===envNames.length;
if(present.length&&!enabled)throw new Error('Capture schedule test requires all isolated fixture variables.');
let base,bearerToken,config,persist,name;
if(enabled){
  base=new URL(process.env.TEST_BRIDGE_CAPTURE_BASE_URL);
  if(!['http:','https:'].includes(base.protocol)||!['127.0.0.1','localhost','[::1]'].includes(base.hostname))throw new Error('Capture schedule tests are restricted to loopback.');
  bearerToken=process.env.TEST_BRIDGE_CAPTURE_BEARER_TOKEN;
  config=process.env.TEST_BRIDGE_CAPTURE_D1_CONFIG.replaceAll('\\','/');
  persist=process.env.TEST_BRIDGE_CAPTURE_D1_PERSIST.replaceAll('\\','/');
  name=process.env.TEST_BRIDGE_CAPTURE_D1_NAME;
  if(!/^[0-9a-f]{64}$/.test(bearerToken))throw new Error('Capture schedule token must be synthetic 256-bit hex.');
  if(!/\.sites-runtime\/bridge-capture-[^/]+\/wrangler\.json$/i.test(config))throw new Error('Capture schedule tests require a dedicated local receiver config.');
  if(!/\.wrangler\/bridge-capture-local-[^/]+$/i.test(persist))throw new Error('Capture schedule tests require a dedicated disposable local database.');
  if(name!=='bridge-capture-fixture')throw new Error('Unexpected capture schedule fixture database.');
}

const suite=enabled?test:test.skip;
const digest=value=>createHash('sha256').update(value).digest('hex');
const url=path=>new URL(path,base).href;
async function responseJson(response){const text=await response.text();try{return JSON.parse(text);}catch{throw new Error(`Expected JSON status ${response.status}.`);}}
async function authenticated(path){
  const timestamp=String(Date.now()),nonce=randomUUID(),body='';
  return fetch(url(path),{method:'GET',headers:{connection:'close',authorization:`Bearer ${bearerToken}`,'x-bridge-timestamp':timestamp,'x-bridge-nonce':nonce,'x-bridge-body-sha256':digest(body)},redirect:'manual',cache:'no-store'});
}
async function runScheduled(){
  const query=new URLSearchParams({cron:'*/15 * * * *'}).toString();
  const response=await fetch(url(`/__scheduled?${query}`),{method:'GET',headers:{connection:'close'},redirect:'manual',cache:'no-store'});
  await response.arrayBuffer();
}
function localD1(sql){
  assert.ok(enabled);
  const stdout=execFileSync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute',name,'--local','--config',resolve(config),'--persist-to',resolve(persist),'--command',sql,'--json'],{cwd:process.cwd(),encoding:'utf8',timeout:30000,windowsHide:true});
  const start=stdout.indexOf('[\n');
  assert.notEqual(start,-1,'local D1 must return JSON results');
  return JSON.parse(stdout.slice(start));
}
function seedSql(now){
  const expiry=now-1,captured=now-30*86400000-1000;
  const captures=Array.from({length:101},(_,i)=>{
    const id=`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;
    const event=i.toString(16).padStart(64,'0');
    const hash=(i+1).toString(16).padStart(64,'0');
    return `('${id}','${event}','${hash}','v1','sample-business-booking-inbox-v1','webhook-inspection-v1','setup',0,1,${captured},${expiry},'AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAAAA')`;
  });
  const liveId='10000000-0000-4000-8000-000000000001',liveEvent='f'.repeat(64),liveHash='e'.repeat(64);
  captures.push(`('${liveId}','${liveEvent}','${liveHash}','v1','sample-business-booking-inbox-v1','webhook-inspection-v1','setup',0,1,${now},${now+86400000},'AAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAAAAAAAAAA')`);
  const replays=Array.from({length:101},(_,i)=>`('00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}','webhook-inspection-v1','{}',${now})`);
  replays.push(`('${liveId}','webhook-inspection-v1','{}',${now})`);
  const chunks=(rows,size)=>Array.from({length:Math.ceil(rows.length/size)},(_,i)=>rows.slice(i*size,(i+1)*size));
  return {captureSqls:chunks(captures,50).map(rows=>`INSERT INTO bridge_captures(id,event_key,body_sha256,key_version,namespace,parser_policy_version,mode,config_revision,byte_length,captured_at,expires_at,nonce,ciphertext) VALUES ${rows.join(',')}`),
    replaySqls:chunks(replays,50).map(rows=>`INSERT INTO bridge_capture_replays(capture_id,parser_policy_version,inspection_json,created_at) VALUES ${rows.join(',')}`),
    liveId,expiredIds:Array.from({length:101},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`)};
}

suite('actual local receiver scheduled cleanup is bounded, atomic, retryable, and does not alter bridge settings',async()=>{
  const before=(await authenticated('/bridge/status'));
  assert.equal(before.status,200);
  const settingsBefore=await responseJson(before);
  assert.equal(settingsBefore.config.mode,'setup');
  const beforeCapture=(await authenticated('/bridge/capture-status'));
  assert.equal(beforeCapture.status,200);
  const empty=await responseJson(beforeCapture);
  assert.equal(empty.activeCount,0);

  const seededAt=Date.now(),seeded=seedSql(seededAt);
  for(const sql of seeded.captureSqls)localD1(sql);
  for(const sql of seeded.replaySqls)localD1(sql);
  const beforeRows=localD1("SELECT (SELECT COUNT(*) FROM bridge_captures) AS captures,(SELECT COUNT(*) FROM bridge_capture_replays) AS replays,(SELECT COUNT(*) FROM bridge_settings) AS settings")[0].results[0];
  assert.deepEqual(beforeRows,{captures:102,replays:102,settings:1});
  const expiredStatus=await responseJson(await authenticated('/bridge/capture-status'));
  assert.equal(expiredStatus.activeCount,1,'expired capture metadata is not counted as accessible');
  assert.equal(expiredStatus.recent.some(row=>row.available===false),true,'expired rows are immediately inaccessible before scheduled physical cleanup');
  assert.deepEqual(localD1("SELECT (SELECT COUNT(*) FROM bridge_captures) AS captures,(SELECT COUNT(*) FROM bridge_capture_replays) AS replays")[0].results[0],{captures:102,replays:102},'status reads never perform cleanup');

  localD1("CREATE TRIGGER fixture_capture_delete_failure BEFORE DELETE ON bridge_captures BEGIN SELECT RAISE(ABORT,'fixture'); END");
  await runScheduled();
  const afterFailure=localD1("SELECT (SELECT COUNT(*) FROM bridge_captures) AS captures,(SELECT COUNT(*) FROM bridge_capture_replays) AS replays")[0].results[0];
  assert.deepEqual(afterFailure,{captures:102,replays:102},'failed cleanup batch preserves captures and replay rows');
  const failureStatus=await responseJson(await authenticated('/bridge/capture-status'));
  assert.equal(failureStatus.maintenance.failureCode,'storage_unavailable');
  assert.equal(failureStatus.maintenance.lastCompleted,null);

  localD1('DROP TRIGGER fixture_capture_delete_failure');
  await runScheduled();
  const afterRetry=localD1(`SELECT (SELECT COUNT(*) FROM bridge_captures) AS captures,(SELECT COUNT(*) FROM bridge_capture_replays) AS replays,(SELECT COUNT(*) FROM bridge_captures WHERE expires_at<=${seededAt}) AS expired`)[0].results[0];
  assert.deepEqual(afterRetry,{captures:2,replays:2,expired:1},'one run removes exactly 100 expired pairs and preserves the unexpired control');
  const statusAfterRetry=await responseJson(await authenticated('/bridge/capture-status'));
  assert.equal(statusAfterRetry.maintenance.deleted,100);
  assert.equal(statusAfterRetry.maintenance.backlog,1);
  assert.equal(statusAfterRetry.activeCount,1);
  assert.equal(statusAfterRetry.recent.find(row=>row.id===seeded.liveId)?.available,true);

  await runScheduled();
  const finalCounts=localD1(`SELECT (SELECT COUNT(*) FROM bridge_captures) AS captures,(SELECT COUNT(*) FROM bridge_capture_replays) AS replays,(SELECT COUNT(*) FROM bridge_captures WHERE expires_at<=${seededAt}) AS expired`)[0].results[0];
  assert.deepEqual(finalCounts,{captures:1,replays:1,expired:0});
  const settingsAfter=await responseJson(await authenticated('/bridge/status'));
  assert.equal(settingsAfter.revision,settingsBefore.revision);
  assert.deepEqual(settingsAfter.config,settingsBefore.config);
  assert.equal(settingsAfter.retentionFloor,settingsBefore.retentionFloor);
});
