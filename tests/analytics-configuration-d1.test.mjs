import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl=process.env.TEST_ANALYTICS_CONFIG_D1_BASE_URL;
const token=process.env.TEST_ANALYTICS_CONFIG_D1_TOKEN;
const enabled=!!baseUrl&&!!token;

async function call(path,{method='GET',body}={}){
  const response=await fetch(new URL(path,baseUrl),{
    method,
    headers:{Authorization:`Bearer ${token}`,'Connection':'close',...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  let data;
  try{data=await response.json();}catch{throw new Error('Local analytics configuration fixture returned invalid JSON.');}
  return {status:response.status,data};
}

test('real local D1 CAS allows one concurrent writer and keeps explicit disable above native fallback', {skip:!enabled}, async()=>{
  const initial=await call('/__qa/state');
  assert.equal(initial.status,200);
  assert.deepEqual(initial.data,{config:{revision:0,enabled:true,containerId:'GTM-NATIVE123',source:'native'},rowCount:0,audits:[],storedValueJson:null},'read-only status must not create a setting or audit row');

  const bodyA={expectedRevision:0,enabled:true,containerId:'GTM-PQ3SVPTK'};
  const bodyB={expectedRevision:0,enabled:true,containerId:'GTM-OTHER123'};
  const results=await Promise.all([
    call('/__qa/save',{method:'POST',body:bodyA}),
    call('/__qa/save',{method:'POST',body:bodyB}),
  ]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  const winner=results.find(result=>result.status===200);
  assert.deepEqual(Object.keys(winner.data).sort(),['auditId','containerId','enabled','revision','source']);
  assert.deepEqual({revision:winner.data.revision,enabled:winner.data.enabled,containerId:winner.data.containerId,source:winner.data.source},{revision:1,enabled:true,containerId:winner.data.containerId,source:'persisted'});
  assert.ok([bodyA.containerId,bodyB.containerId].includes(winner.data.containerId));
  let state=(await call('/__qa/state')).data;
  assert.deepEqual(state.config,{revision:1,enabled:true,containerId:winner.data.containerId,source:'persisted'});
  assert.equal(state.rowCount,1);
  assert.equal(state.audits.length,1,'the winning configuration CAS and one audit insert commit together');
  assert.equal(state.audits[0].id,winner.data.auditId);
  assert.equal(state.audits[0].google_subject,'verified-google-subject-fixture','actor is fixed by the trusted fixture, never supplied in the body');
  assert.equal(state.audits[0].action,'analytics.configuration_save');
  assert.deepEqual(JSON.parse(state.audits[0].target),{workspaceId:'analytics-config-local-workspace',revision:1,enabled:true,containerId:winner.data.containerId});
  const stored=JSON.parse(state.storedValueJson);
  assert.deepEqual(Object.keys(stored).sort(),['containerId','enabled','writeToken']);
  assert.ok(stored.writeToken);
  assert.equal(JSON.stringify(winner.data).includes(stored.writeToken),false,'the private CAS write token is not returned');

  const beforeStale=state;
  const stale=await call('/__qa/save',{method:'POST',body:{expectedRevision:0,enabled:true,containerId:'GTM-STALE123'}});
  assert.equal(stale.status,409);
  state=(await call('/__qa/state')).data;
  assert.deepEqual(state,beforeStale,'stale save changes neither configuration nor audit history');

  const disabled=await call('/__qa/save',{method:'POST',body:{expectedRevision:1,enabled:false,containerId:null}});
  assert.equal(disabled.status,200);
  assert.deepEqual(Object.keys(disabled.data).sort(),['auditId','containerId','enabled','revision','source']);
  assert.deepEqual({revision:disabled.data.revision,enabled:disabled.data.enabled,containerId:disabled.data.containerId,source:disabled.data.source},{revision:2,enabled:false,containerId:null,source:'persisted'});
  state=(await call('/__qa/state')).data;
  assert.deepEqual(state.config,{revision:2,enabled:false,containerId:null,source:'persisted'},'explicit persisted disable must beat the native fallback');
  assert.equal(state.rowCount,1);
  assert.equal(state.audits.length,2);
  assert.equal(state.audits[1].id,disabled.data.auditId);
  assert.deepEqual(JSON.parse(state.audits[1].target),{workspaceId:'analytics-config-local-workspace',revision:2,enabled:false,containerId:null});

  assert.equal((await call('/__qa/arm-audit-failure',{method:'POST'})).status,200);
  const beforeFailedAudit=(await call('/__qa/state')).data;
  const failedAudit=await call('/__qa/save',{method:'POST',body:{expectedRevision:2,enabled:true,containerId:'GTM-ROLLBACK1'}});
  assert.equal(failedAudit.status,400,'fixture maps a forced audit insertion failure to its generic safe failure');
  const afterFailedAudit=(await call('/__qa/state')).data;
  assert.deepEqual(afterFailedAudit,beforeFailedAudit,'D1 batch rolls back the settings CAS when audit insertion fails');
});

test('ConsoleStore keeps personal audit rows and shares only safe same-workspace analytics configuration audits', {skip:!enabled}, async()=>{
  const seeded=await call('/__qa/seed-audit-visibility',{method:'POST'});
  assert.deepEqual(seeded,{status:200,data:{seeded:7}});
  const response=await call('/__qa/audit-list');
  assert.equal(response.status,200);
  assert.equal(response.data.length,3,'only personal rows and valid same-workspace configuration changes are visible');
  const byId=Object.fromEntries(response.data.map(row=>[row.id,row]));
  const personal=byId['f0000000-0000-4000-8000-000000000001'];
  assert.deepEqual(personal,{id:'f0000000-0000-4000-8000-000000000001',action:'profile.updated',target:'personal-target-preserved',created_at:10,actor:'Admin'});
  const personalConfig=byId['f0000000-0000-4000-8000-000000000002'];
  const nativeConfig=byId['f0000000-0000-4000-8000-000000000003'];
  assert.deepEqual(personalConfig.target,{workspaceId:'analytics-config-local-workspace',revision:7,enabled:true,containerId:'GTM-PQ3SVPTK'});
  assert.equal(personalConfig.actor,'Admin');
  assert.deepEqual(nativeConfig.target,{workspaceId:'analytics-config-local-workspace',revision:7,enabled:true,containerId:'GTM-PQ3SVPTK'});
  assert.equal(nativeConfig.actor,'Deployment owner');
  assert.equal(JSON.stringify(response.data).includes('privateTargetSentinel'),false,'extra target fields are stripped');
  for(const hiddenId of ['f0000000-0000-4000-8000-000000000004','f0000000-0000-4000-8000-000000000005','f0000000-0000-4000-8000-000000000006','f0000000-0000-4000-8000-000000000007'])assert.equal(Object.hasOwn(byId,hiddenId),false);
  for(const sentinel of ['native-private-sentinel','foreign-personal-sentinel','foreign-workspace-fixture'])assert.equal(JSON.stringify(response.data).includes(sentinel),false);
});

