import test from 'node:test';
import assert from 'node:assert/strict';

const base=process.env.TEST_CONTACT_REPAIR_D1_BASE_URL??'';
const token=process.env.TEST_CONTACT_REPAIR_D1_TOKEN??'';
const config=process.env.TEST_CONTACT_REPAIR_D1_CONFIG??'';
const persist=process.env.TEST_CONTACT_REPAIR_D1_PERSIST??'';
const dbName=process.env.TEST_CONTACT_REPAIR_D1_NAME??'';
const workspace=process.env.TEST_CONTACT_REPAIR_D1_WORKSPACE??'';
const expected={base:'http://127.0.0.1:8804',token:'local-contact-repair-fixture-20261030-03',config:'.sites-runtime/contact-repair-fixture-03/wrangler.json',persist:'.wrangler/contact-repair-local-03',dbName:'site-creator-d1',workspace:'contact-repair-local-workspace'};
const provided=[base,token,config,persist,dbName,workspace].some(Boolean);
const configured=[base,token,config,persist,dbName,workspace].every(Boolean);
if(provided&&(!configured||base!==expected.base||token!==expected.token||config!==expected.config||persist!==expected.persist||dbName!==expected.dbName||workspace!==expected.workspace))throw new Error('Contact repair D1 acceptance requires the exact dedicated loopback fixture contract.');
const enabled=configured;

async function call(action,extra={}){
 const response=await fetch(base,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Connection:'close'},body:JSON.stringify({action,...extra})});
 let data;try{data=await response.json();}catch{throw new Error(`Contact repair fixture returned non-JSON (${response.status}).`);}return {status:response.status,data};
}
const uuid=n=>`f7000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const input=(n,message=`Repair fixture ${n}.`)=>({requestKey:uuid(n),name:'Synthetic Repair Customer',email:'repair@example.invalid',message});

test('fresh local D1 proves new-only contact quota and status/outbox continuity under CAS and rollback',{
 skip:!enabled&&'Set TEST_CONTACT_REPAIR_D1_* only for the fresh dedicated local D1 fixture.',
},async()=>{
 const initialized=await call('init');
 assert.equal(initialized.status,200);
 assert.deepEqual(initialized.data,{ready:true,migrations:31,tablesPresent:true,counts:{messages:0,outbox:0,audit:0,rateRows:0,otherMessages:0,otherOutbox:0}});
 const fixedNow=1_800_000_000_012;
 assert.equal((await call('clock',{now:fixedNow})).status,200);

 const seeded=await call('seed-status-rows');
 assert.equal(seeded.status,200);
 assert.equal(seeded.data.rows.length,3);
 const byState=Object.fromEntries(seeded.data.rows.map(row=>[row.state,row]));
 assert.deepEqual(Object.keys(byState).sort(),['blocked','dispatching','pending']);

 for(const state of ['blocked','pending','dispatching']){
  const row=byState[state];
  const before=(await call('inspect',{id:row.id})).data;
  assert.deepEqual(before.message,{id:row.id,revision:1,status:'new',deletedAt:null});
  assert.deepEqual(before.outbox,{id:before.outbox.id,state,revision:row.revision,sourceRevision:1,claimToken:row.token});
  const nextStatus=state==='pending'?'archived':'read';
  const changed=await call('status',{input:{id:row.id,expectedRevision:1,status:nextStatus}});
  assert.equal(changed.status,200);
  assert.deepEqual({revision:changed.data.revision,status:changed.data.status},{revision:2,status:nextStatus});
  const after=(await call('inspect',{id:row.id})).data;
  assert.deepEqual(after.message,{id:row.id,revision:2,status:nextStatus,deletedAt:null});
  assert.deepEqual(after.outbox,{...before.outbox,sourceRevision:2},`${state} intent remains live with its claim/state/revision intact while its active source revision advances`);
  if(state==='dispatching')assert.deepEqual((await call('source-dispatch',{id:before.outbox.id,token:row.token})).data,{found:true,id:row.id,revision:2},'an existing dispatch claim can still read the updated active source');
 }

 const stale=await call('status',{input:{id:byState.blocked.id,expectedRevision:1,status:'archived'}});
 assert.equal(stale.status,409);
 assert.equal(stale.data.error,'message_unavailable');
 assert.deepEqual((await call('inspect',{id:byState.blocked.id})).data.message,{id:byState.blocked.id,revision:2,status:'read',deletedAt:null},'stale CAS leaves the current message revision unchanged');
 const beforeRollback=(await call('inspect',{id:byState.pending.id})).data;
 assert.equal((await call('arm-status-audit-failure',{enabled:true})).status,200);
 const failedAudit=await call('status',{input:{id:byState.pending.id,expectedRevision:2,status:'archived'}});
 assert.equal(failedAudit.status,409);
 assert.equal(failedAudit.data.error,'fixture_failure');
 assert.deepEqual((await call('inspect',{id:byState.pending.id})).data,beforeRollback,'audit failure rolls back message and outbox source-revision writes together');
 assert.equal((await call('drop-status-audit-failure')).status,200);

 const erased=await call('erase',{input:{id:byState.dispatching.id,expectedRevision:2}});
 assert.equal(erased.status,200);
 assert.equal(erased.data.status,'deleted');
 const deleted=(await call('inspect',{id:byState.dispatching.id})).data;
 assert.deepEqual(deleted.message,{id:byState.dispatching.id,revision:3,status:'deleted',deletedAt:deleted.message.deletedAt});
 assert.equal(typeof deleted.message.deletedAt,'number');
 assert.deepEqual({state:deleted.outbox.state,revision:deleted.outbox.revision,sourceRevision:deleted.outbox.sourceRevision,claimToken:deleted.outbox.claimToken},{state:'canceled',revision:6,sourceRevision:2,claimToken:null});
 assert.deepEqual((await call('source-dispatch',{id:deleted.outbox.id,token:byState.dispatching.token})).data,{found:false,id:null,revision:null},'erasure alone cancels the in-flight intent and fences its claim');

 assert.equal((await call('seed-rate-99')).status,200);
 const beforeConcurrent=(await call('counts')).data;
 const concurrent=await Promise.all([
  call('route-submit',{input:input(201)}),
  call('route-submit',{input:input(202)}),
 ]);
 const accepted=concurrent.find(result=>result.data.status===201);
 const rejected=concurrent.find(result=>result.data.status===429);
 assert.ok(accepted,'one new submission is admitted at attempt 100');
 assert.ok(rejected,'the competing new submission is rejected at the cap');
 assert.deepEqual(accepted.data.body,{received:true,id:accepted.data.body.id,created:true,message:'Thanks—we’ve received your message.'});
 assert.equal(rejected.data.body.error,'Please wait before sending another message.');
 assert.equal(rejected.data.retryAfter,'3600');
 assert.match(rejected.data.retryAfter,/^[1-9]\d{0,3}$/);
 assert.ok(Number(rejected.data.retryAfter)<=3600);
 assert.equal(rejected.data.dispatchCount,0);
 assert.equal(rejected.data.scheduledCount,0);
 assert.equal(accepted.data.dispatchCount,0);
 assert.equal(accepted.data.scheduledCount,0);
 const afterConcurrent=(await call('counts')).data;
 assert.equal(afterConcurrent.messages,beforeConcurrent.messages+1,'only the admitted new submission creates a message');
 assert.equal(afterConcurrent.outbox,beforeConcurrent.outbox+1,'the rejected request creates no intent');
 let rate=(await call('rate-state')).data;
 assert.deepEqual({attempts:rate.attempts,exactKey:rate.exactKey,workspaceRateRows:rate.workspaceRateRows,containsIdentity:rate.containsIdentity},{attempts:100,exactKey:true,workspaceRateRows:1,containsIdentity:false});

 const acceptedValue=concurrent.indexOf(accepted)===0?input(201):input(202);
 const replay=await call('route-submit',{input:acceptedValue});
 assert.equal(replay.data.status,200);
 assert.equal(replay.data.body.created,false);
 assert.equal(replay.data.body.id,accepted.data.body.id);
 assert.equal(replay.data.dispatchCount,0);
 assert.equal(replay.data.scheduledCount,0);
 const conflict=await call('route-submit',{input:{...acceptedValue,message:'Different payload under same replay key.'}});
 assert.equal(conflict.data.status,409);
 assert.equal(conflict.data.body.error,'This request changed or is no longer available.');
 const tombstone=await call('route-submit',{input:input(103)});
 assert.equal(tombstone.data.status,409);
 assert.equal(tombstone.data.body.error,'This request changed or is no longer available.');
 rate=(await call('rate-state')).data;
 assert.equal(rate.attempts,100,'same-key receipt, conflict, and tombstone replay do not spend quota');

 const beforeLimit=(await call('counts')).data;
 const extra=await call('route-submit',{input:input(203)});
 assert.equal(extra.data.status,429);
 assert.equal(extra.data.dispatchCount,0);
 assert.equal(extra.data.scheduledCount,0);
 assert.deepEqual((await call('counts')).data,beforeLimit,'429 creates neither a message nor an outbox row');

 const other=await call('route-submit-other',{input:input(204)});
 assert.equal(other.data.status,201,'the fixed namespace is scoped to the workspace, not a person, IP address, or email');
 assert.equal(other.data.scheduledCount,0);
 const otherRate=await call('other-rate-state');
 assert.deepEqual(otherRate.data,{attempts:1,exactKey:true,workspaceRateRows:1,containsIdentity:false});
});
