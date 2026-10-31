import test from 'node:test';
import assert from 'node:assert/strict';

const base=process.env.TEST_CUSTOMER_SENDER_D1_BASE_URL??'';
const token=process.env.TEST_CUSTOMER_SENDER_D1_TOKEN??'';
const config=process.env.TEST_CUSTOMER_SENDER_D1_CONFIG??'';
const persist=process.env.TEST_CUSTOMER_SENDER_D1_PERSIST??'';
const dbName=process.env.TEST_CUSTOMER_SENDER_D1_NAME??'';
const workspace=process.env.TEST_CUSTOMER_SENDER_D1_WORKSPACE??'';
const expected={base:'http://127.0.0.1:8805',token:'local-customer-sender-fixture-20261030',config:'.sites-runtime/customer-sender-fixture/wrangler.json',persist:'.wrangler/customer-sender-local-01',dbName:'site-creator-d1',workspace:'customer-sender-local-workspace'};
const values=[base,token,config,persist,dbName,workspace];
const provided=values.some(Boolean),configured=values.every(Boolean);
if(provided&&(!configured||base!==expected.base||token!==expected.token||config!==expected.config||persist!==expected.persist||dbName!==expected.dbName||workspace!==expected.workspace))throw new Error('Customer sender D1 proof requires its exact dedicated loopback fixture contract.');
const enabled=configured;

async function call(action,extra={}){
 const response=await fetch(base,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Connection:'close'},body:JSON.stringify({action,...extra})});
 let data;try{data=await response.json();}catch{throw new Error(`Customer sender fixture returned non-JSON (${response.status}).`);}
 return {status:response.status,data};
}

const firstConfig={trafficStage:'business',readEnabled:true,writeEnabled:false,sendingEnabled:false,emailFrom:'sender-one@example.invalid',emailZoneId:'a'.repeat(32),emailSubdomainId:'b'.repeat(32),identityRevision:0};
const changedConfig={...firstConfig,emailFrom:'sender-two@example.invalid',emailZoneId:'c'.repeat(32),emailSubdomainId:'d'.repeat(32)};
const actor=`native-owner:${'c'.repeat(64)}`;
const winningAudit='a1000000-0000-4000-8000-000000000001';
const staleAudit='a1000000-0000-4000-8000-000000000002';
const rollbackAudit='a1000000-0000-4000-8000-000000000003';

test('fresh local D1 proves native sender CAS audit commit, stale no-op, and atomic audit rollback',{
 skip:!enabled&&'Set TEST_CUSTOMER_SENDER_D1_* only for the fresh dedicated local D1 fixture.',
},async()=>{
 const initialized=await call('init');
 assert.equal(initialized.status,200);
 assert.deepEqual(initialized.data,{ready:true,migrations:31,counts:{settings:0,audits:0}});

 const winning=await call('save',{expectedRevision:0,config:firstConfig,auditId:winningAudit});
 assert.equal(winning.status,200);
 assert.equal(winning.data.revision,1);
 assert.deepEqual(winning.data.config,{...firstConfig,identityRevision:1});
 assert.equal(winning.data.senderCheck.status,'not_checked');
 assert.equal(winning.data.ownerConfirmation,null);
 const afterWin=await call('state');
 assert.equal(afterWin.status,200);
 assert.deepEqual(afterWin.data.config,winning.data.config);
 assert.equal(afterWin.data.internalWriteTokenPresent,true,'the successful atomic write stores its private token');
 assert.equal(afterWin.data.readbackLeaksWriteToken,false,'BookingSettingsStore.read never projects the private write token');

 const audits=await call('audits');
 assert.equal(audits.status,200);
 assert.equal(audits.data.rows.length,1);
 assert.deepEqual(audits.data.rows[0],{
  id:winningAudit,google_subject:actor,action:'customer.sender_configure',
  target:JSON.stringify({workspaceId:workspace,revision:1,senderConfigured:true,readEnabled:true,writeEnabled:false,sendingEnabled:false}),
  created_at:audits.data.rows[0].created_at,
 });
 assert.equal(typeof audits.data.rows[0].created_at,'number');
 assert.doesNotMatch(audits.data.rows[0].target,/sender-one|example\.invalid|zoneId|subdomainId|token/i);

 const stale=await call('save',{expectedRevision:0,config:changedConfig,auditId:staleAudit});
 assert.equal(stale.status,409);
 assert.equal(stale.data.error,'Settings changed');
 assert.deepEqual((await call('state')).data,afterWin.data,'stale revision leaves the committed settings unchanged');
 assert.equal((await call('counts')).data.audits,1,'stale revision writes no audit row');

 assert.equal((await call('arm-audit-failure')).status,200);
 const failed=await call('save',{expectedRevision:1,config:changedConfig,auditId:rollbackAudit});
 assert.equal(failed.status,409);
 assert.equal(failed.data.error,'fixture_failure');
 assert.deepEqual((await call('state')).data,afterWin.data,'failed audit insertion rolls back the settings revision and payload');
 assert.deepEqual((await call('counts')).data,{settings:1,audits:1},'failed audit transaction leaves no second settings or audit row');
});
