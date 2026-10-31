import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

const baseUrl=process.env.TEST_EXPERIMENT_MANAGEMENT_BASE_URL;
const adminCookie=process.env.TEST_EXPERIMENT_MANAGEMENT_ADMIN_COOKIE;
const siteUserId=process.env.TEST_EXPERIMENT_MANAGEMENT_SITE_USER_ID;
const siteUserEmail=process.env.TEST_EXPERIMENT_MANAGEMENT_SITE_USER_EMAIL;
const d1Config=process.env.TEST_EXPERIMENT_MANAGEMENT_D1_CONFIG;
const d1Persist=process.env.TEST_EXPERIMENT_MANAGEMENT_D1_PERSIST;
const d1Name=process.env.TEST_EXPERIMENT_MANAGEMENT_D1_NAME;
const projectId=process.env.TEST_EXPERIMENT_MANAGEMENT_INSTALLATION_ID;
const enabled=!!(baseUrl&&adminCookie&&siteUserId&&siteUserEmail&&d1Config&&d1Persist&&d1Name&&projectId);
const suite=enabled?test:test.skip;
const execFileAsync=promisify(execFile);

if(baseUrl&&!/^https:\/\/127\.0\.0\.1:8789$/i.test(baseUrl))throw new Error('Experiment management tests require the dedicated loopback HTTPS fixture.');
if(d1Config&&d1Config.replaceAll('\\','/')!=='.sites-runtime/experiment-management-fixture/wrangler.json')throw new Error('Unexpected isolated Experiment management Worker config.');
if(d1Persist&&!new Set(['.wrangler/experiment-management-local-01','.wrangler/experiment-management-local-02']).has(d1Persist.replaceAll('\\','/')))throw new Error('Unexpected disposable Experiment management D1 directory.');
if(d1Name&&d1Name!=='site-creator-d1')throw new Error('Unexpected Experiment management D1 name.');

async function localD1(sql){
  const {stdout}=await execFileAsync(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute',d1Name,'--local','--config',d1Config,'--persist-to',d1Persist,'--json','--command',sql],{cwd:process.cwd(),timeout:30000,windowsHide:true});
  const start=stdout.search(/\[\s*\{/);
  assert.notEqual(start,-1,'Wrangler should return JSON for the isolated D1 readback.');
  return JSON.parse(stdout.slice(start))[0].results;
}

async function tool(name,args={},requestKey){
  const url=new URL('/api/admin/tools',baseUrl);
  return fetch(url,{method:'POST',redirect:'manual',headers:{
    'oai-authenticated-user-id':siteUserId,
    'oai-authenticated-user-email':siteUserEmail,
    cookie:adminCookie,
    origin:url.origin,
    connection:'close',
    'content-type':'application/json',
  },body:JSON.stringify({tool:name,arguments:args,...(requestKey?{requestKey}:{})})});
}

async function result(response){
  const body=await response.json();
  assert.equal(response.status,200,`Expected ${body?.result?.operation??'tool'} success; received HTTP ${response.status}.`);
  return body.result;
}

async function create(title){
  const made=await result(await tool('experiments.create',{title}));
  assert.match(made.versionId,/^[0-9a-f-]{36}$/i);
  const inspected=await result(await tool('experiments.inspect',{versionId:made.versionId}));
  assert.equal(inspected.version.managementRevision,0);
  return inspected;
}

async function compileAndPause(title){
  const draft=await create(title);
  const compiled=await result(await tool('experiments.compile',{versionId:draft.version.id}));
  assert.ok(compiled.compositions.length>0);
  await result(await tool('experiments.start',{versionId:draft.version.id}));
  await result(await tool('experiments.pause',{versionId:draft.version.id}));
  return result(await tool('experiments.inspect',{versionId:draft.version.id}));
}

async function versionState(id){
  const rows=await localD1(`SELECT v.id,v.stage,v.revision,m.revision AS management_revision,m.archived_at,m.deleted_at,(SELECT c.snapshot_hash FROM exp_compositions c WHERE c.version_id=v.id ORDER BY c.label LIMIT 1) AS snapshot_hash,(SELECT r.active_version_id FROM exp_runtime r WHERE r.id=1) AS active_version_id,(SELECT r.baseline_hash FROM exp_runtime r WHERE r.id=1) AS baseline_hash,(SELECT r.revision FROM exp_runtime r WHERE r.id=1) AS runtime_revision FROM exp_versions v JOIN exp_version_management m ON m.version_id=v.id WHERE v.id='${id}'`);
  return rows[0]??null;
}

async function writeCounts(){
  const rows=await localD1('SELECT (SELECT COUNT(*) FROM exp_versions) AS versions,(SELECT COUNT(*) FROM exp_compositions) AS compositions,(SELECT COUNT(*) FROM exp_management_operations) AS operations,(SELECT COUNT(*) FROM exp_audit WHERE action IN (\'archive\',\'restore\',\'delete\')) AS lifecycle_audit,(SELECT COUNT(*) FROM admin_audit) AS admin_audit');
  return rows[0];
}

function target(version){return {versionId:version.id,managementRevision:version.managementRevision};}
function key(){return crypto.randomUUID().replaceAll('-','_');}
function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([name,item])=>JSON.stringify(name)+':'+canonical(item)).join(',')+'}';
  return JSON.stringify(value)??'null';
}
function hash(value){return createHash('sha256').update(value).digest('hex');}
function sqlQuote(value){return "'"+String(value).replaceAll("'","''")+"'";}

suite('Experiments lifecycle against the isolated app Worker and actual local D1',async t=>{
  assert.deepEqual(await (await tool('experiments.list',{})).json().then(body=>body.result.versions),[],'fixture starts without experiment versions');
  const baselineStatus=await result(await tool('baseline.status',{}));
  if(!baselineStatus.persisted)await result(await tool('baseline.setup',{}));
  const compatibleBaseline=await result(await tool('baseline.status',{}));
  assert.equal(compatibleBaseline.persisted,true);
  assert.equal(compatibleBaseline.compatible,true);

  await t.test('archive and restore retain a paused compiled snapshot shared by the approved baseline',async()=>{
    const first=await compileAndPause('QA baseline-sharing first');
    const firstComp=first.compositions.find(row=>row.label==='control');
    await result(await tool('experiments.promote',{versionId:first.version.id,compositionId:firstComp.id,rationale:'Local fixture baseline setup.'}));
    const baselineHash=(await versionState(first.version.id)).baseline_hash;
    assert.equal(baselineHash,firstComp.snapshot_hash);

    const secondDraft=await create('QA baseline-sharing second');
    const secondCompiled=await result(await tool('experiments.compile',{versionId:secondDraft.version.id}));
    const secondComp=secondCompiled.compositions.find(row=>row.label==='control');
    // The isolated fixture deliberately points this second compiled draft at the already-approved immutable bytes.
    // This gives the regression a deterministic shared-hash condition without changing production data or source.
    await localD1(`UPDATE exp_compositions SET snapshot_hash='${baselineHash}' WHERE version_id='${secondDraft.version.id}' AND id='${secondComp.id}'`);
    assert.equal((await versionState(secondDraft.version.id)).snapshot_hash,baselineHash);
    await result(await tool('experiments.start',{versionId:secondDraft.version.id}));
    await result(await tool('experiments.pause',{versionId:secondDraft.version.id}));
    const second=await result(await tool('experiments.inspect',{versionId:secondDraft.version.id}));
    const secondCompAfter=second.compositions.find(row=>row.label==='control');
    assert.equal(secondCompAfter.snapshot_hash,baselineHash,'the paused version shares the approved immutable baseline bytes');
    const before=await versionState(second.version.id);
    const snapshotBefore=(await localD1(`SELECT COUNT(*) AS count,MAX(length(html)) AS bytes FROM exp_snapshots WHERE hash='${baselineHash}'`))[0];
    assert.equal(snapshotBefore.count,1);
    const arch=await result(await tool('experiments.archive',{requestKey:key(),targets:[target(second.version)]}));
    assert.equal(arch.versions[0].managementRevision,1);
    const archived=await versionState(second.version.id);
    assert.ok(archived.archived_at);
    assert.equal(archived.deleted_at,null);
    assert.equal(archived.snapshot_hash,before.snapshot_hash);
    assert.equal(archived.baseline_hash,baselineHash);
    assert.equal(archived.runtime_revision,before.runtime_revision);
    assert.deepEqual((await localD1(`SELECT COUNT(*) AS count,MAX(length(html)) AS bytes FROM exp_snapshots WHERE hash='${baselineHash}'`))[0],snapshotBefore);
    const defaultList=await result(await tool('experiments.list',{}));
    assert.equal(defaultList.versions.some(row=>row.id===second.version.id),false);
    const archivedList=await result(await tool('experiments.list',{includeArchived:true}));
    assert.equal(archivedList.versions.some(row=>row.id===second.version.id),true);

    assert.notEqual((await tool('experiments.start',{versionId:second.version.id})).status,200);
    assert.notEqual((await tool('experiments.promote',{versionId:second.version.id,compositionId:secondCompAfter.id,rationale:'Archived must remain blocked.'})).status,200);
    const afterRejectedActions=await versionState(second.version.id);
    assert.equal(afterRejectedActions.archived_at,archived.archived_at);
    assert.equal(afterRejectedActions.baseline_hash,baselineHash);

    await result(await tool('experiments.rollback',{rationale:'Local shared-hash regression reset.'}));
    await result(await tool('experiments.promote',{versionId:first.version.id,compositionId:firstComp.id,rationale:'Eligible unarchived version reuses shared snapshot.'}));
    const archivedAfterOtherPromotion=await versionState(second.version.id);
    assert.equal(archivedAfterOtherPromotion.archived_at,archived.archived_at);
    assert.equal(archivedAfterOtherPromotion.management_revision,1);
    assert.equal(archivedAfterOtherPromotion.baseline_hash,baselineHash);
    assert.equal((await versionState(second.version.id)).baseline_hash,baselineHash);
    assert.deepEqual((await localD1(`SELECT COUNT(*) AS count,MAX(length(html)) AS bytes FROM exp_snapshots WHERE hash='${baselineHash}'`))[0],snapshotBefore);
  });

  await t.test('a successful logical delete hides an eligible draft but retains its version and audit history',async()=>{
    const draft=await create('QA eligible delete draft');
    const before=await writeCounts();
    const deleted=await result(await tool('experiments.delete',{requestKey:key(),targets:[target(draft.version)]}));
    assert.equal(deleted.versions[0].managementRevision,1);
    assert.equal(await tool('experiments.inspect',{versionId:draft.version.id}).then(r=>r.status),400);
    assert.equal((await result(await tool('experiments.list',{includeArchived:true}))).versions.some(row=>row.id===draft.version.id),false);
    const state=await versionState(draft.version.id);
    assert.ok(state.deleted_at);
    assert.equal(state.stage,'draft');
    const after=await writeCounts();
    assert.equal(after.versions,before.versions,'logical deletion does not erase immutable version history');
    assert.equal(after.lifecycle_audit,before.lifecycle_audit+1);
  });

  await t.test('mixed stale, foreign, duplicate, and ineligible selections reject atomically',async()=>{
    const a=await create('QA bulk target A');
    const b=await create('QA bulk target B');
    const before=await writeCounts();
    const stale=[target(a.version),{...target(b.version),managementRevision:target(b.version).managementRevision+1}];
    assert.notEqual((await tool('experiments.archive',{requestKey:key(),targets:stale})).status,200);
    const foreign=[target(a.version),{versionId:crypto.randomUUID(),managementRevision:0}];
    assert.notEqual((await tool('experiments.archive',{requestKey:key(),targets:foreign})).status,200);
    assert.notEqual((await tool('experiments.archive',{requestKey:key(),targets:[target(a.version),target(a.version)]})).status,200);
    const after=await writeCounts();
    assert.deepEqual(after,before,'no accepted target, operation receipt, or lifecycle audit may persist on a rejected selection');
    assert.equal((await versionState(a.version.id)).archived_at,null);
    assert.equal((await versionState(b.version.id)).archived_at,null);

    const compiled=await create('QA bulk compiled blocker');
    await result(await tool('experiments.compile',{versionId:compiled.version.id}));
    const currentCompiled=await result(await tool('experiments.inspect',{versionId:compiled.version.id}));
    const beforeIneligible=await writeCounts();
    assert.notEqual((await tool('experiments.delete',{requestKey:key(),targets:[target(a.version),target(currentCompiled.version)]})).status,200);
    assert.deepEqual(await writeCounts(),beforeIneligible,'one ineligible member rejects the entire delete selection without any success audit');
    assert.equal((await versionState(a.version.id)).deleted_at,null);
    assert.equal((await versionState(compiled.version.id)).deleted_at,null);
  });

  await t.test('replaying an identical lifecycle request returns the prior result without another write',async()=>{
    const draft=await create('QA lifecycle idempotency');
    const requestKey=key();
    const args={requestKey,targets:[target(draft.version)]};
    const first=await result(await tool('experiments.archive',args));
    const afterFirst=await writeCounts();
    const replay=await result(await tool('experiments.archive',args));
    assert.equal(replay.deduplicated,true);
    assert.deepEqual(replay.versions,first.versions);
    const afterReplay=await writeCounts();
    assert.equal(afterReplay.operations,afterFirst.operations,'the replay must not claim a second lifecycle operation');
    assert.equal(afterReplay.lifecycle_audit,afterFirst.lifecycle_audit,'the replay must not create a second lifecycle audit');
    assert.equal(afterReplay.versions,afterFirst.versions);
    assert.equal(afterReplay.compositions,afterFirst.compositions);
    assert.equal(afterReplay.admin_audit,afterFirst.admin_audit+1,'the separate admin request log may record the replay attempt');
  });

  await t.test('concurrent start and archive attempts at the same revision produce one winner',async()=>{
    const draft=await create('QA concurrent archive target');
    await result(await tool('experiments.compile',{versionId:draft.version.id}));
    const current=await result(await tool('experiments.inspect',{versionId:draft.version.id}));
    const before=await writeCounts();
    const payload=target(current.version);
    const [left,right]=await Promise.all([
      tool('experiments.archive',{requestKey:key(),targets:[payload]}),
      tool('experiments.start',{versionId:draft.version.id}),
    ]);
    try{
      const successes=[left,right].filter(response=>response.status===200);
      assert.equal(successes.length,1,'exactly one of start and archive can win for the same draft');
      const after=await writeCounts();
      assert.equal(after.lifecycle_audit,before.lifecycle_audit+1);
      const finalState=await versionState(draft.version.id);
      if(left.status===200){
        assert.equal(finalState.management_revision,1);
        assert.ok(finalState.archived_at);
        assert.equal(finalState.active_version_id,null);
        assert.equal(after.operations,before.operations+1);
      }else{
        assert.equal(finalState.management_revision,0);
        assert.equal(finalState.stage,'running');
        assert.equal(finalState.active_version_id,draft.version.id);
        assert.equal(after.operations,before.operations);
      }
    }finally{
      const finalState=await versionState(draft.version.id);
      if(finalState?.stage==='running')await result(await tool('experiments.pause',{versionId:draft.version.id}));
    }
  });

  await t.test('two archives at one selected revision produce one lifecycle receipt',async()=>{
    const draft=await create('QA concurrent management CAS');
    const before=await writeCounts();
    const payload=target(draft.version);
    const [left,right]=await Promise.all([
      tool('experiments.archive',{requestKey:key(),targets:[payload]}),
      tool('experiments.archive',{requestKey:key(),targets:[payload]}),
    ]);
    assert.equal([left,right].filter(response=>response.status===200).length,1);
    const after=await writeCounts();
    assert.equal(after.operations,before.operations+1);
    assert.equal(after.lifecycle_audit,before.lifecycle_audit+1);
    assert.equal((await versionState(draft.version.id)).management_revision,1);
  });

  await t.test('D1 batch failure during audit rolls back operation claim and sidecar update',async()=>{
    const draft=await create('QA atomic rollback target');
    const before=await writeCounts();
    await localD1("CREATE TRIGGER qa_fail_experiment_management_audit BEFORE INSERT ON exp_audit WHEN NEW.action='archive' BEGIN SELECT RAISE(ABORT,'isolated QA fault'); END");
    try{
      assert.notEqual((await tool('experiments.archive',{requestKey:key(),targets:[target(draft.version)]})).status,200);
    }finally{
      await localD1('DROP TRIGGER IF EXISTS qa_fail_experiment_management_audit');
    }
    const after=await writeCounts();
    assert.deepEqual(after,before,'the D1 batch must roll back the claim, sidecar mutation and audit together');
    assert.equal((await versionState(draft.version.id)).archived_at,null);
  });

  await t.test('delete refuses compiled history and versions with dependent drafts',async()=>{
    const compiled=await create('QA compiled delete blocker');
    await result(await tool('experiments.compile',{versionId:compiled.version.id}));
    const parent=await create('QA parent with dependent child');
    await result(await tool('experiments.recombine',{title:'QA dependent child',versionId:parent.version.id}));
    const freshCompiled=await result(await tool('experiments.inspect',{versionId:compiled.version.id}));
    const before=await writeCounts();
    assert.notEqual((await tool('experiments.delete',{requestKey:key(),targets:[target(compiled.version)]})).status,200);
    assert.notEqual((await tool('experiments.delete',{requestKey:key(),targets:[target(freshCompiled.version)]})).status,200);
    assert.notEqual((await tool('experiments.delete',{requestKey:key(),targets:[target(parent.version)]})).status,200,'a source version with an existing child is retained');
    assert.deepEqual(await writeCounts(),before,'ineligible deletion writes neither management operations nor success audit');
  });

  await t.test('deletion eligibility checks each retained evidence and association source',async()=>{
    const cases=['snapshot','audit','assignment','exposure','conversion','feedback','analysis-run','analysis-recommendation','booking-conversion','hosted-handoff','hosted-reference','child'];
    for(const dependency of cases){
      const draft=await create(`QA delete dependency ${dependency}`);
      const compositionId=draft.compositions[0].id;
      const sentinel=crypto.randomUUID();
      let sql='';
      switch(dependency){
        case 'snapshot': {
          const runtime=(await localD1('SELECT baseline_hash FROM exp_runtime WHERE id=1'))[0];
          assert.ok(runtime?.baseline_hash);
          sql=`UPDATE exp_compositions SET snapshot_hash='${runtime.baseline_hash}' WHERE id='${compositionId}' AND version_id='${draft.version.id}'`;
          break;
        }
        case 'audit':
          sql=`INSERT INTO exp_audit(id,subject,action,target,rationale,created_at) VALUES('${sentinel}','local-fixture','compile','${draft.version.id}','',${Date.now()})`;
          break;
        case 'assignment':
          sql=`INSERT INTO exp_assignments(version_id,subject_hash,composition_id,created_at) VALUES('${draft.version.id}','${sentinel}','${compositionId}',${Date.now()})`;
          break;
        case 'exposure':
          sql=`INSERT INTO exp_exposures(version_id,subject_hash,composition_id,stage,created_at) VALUES('${draft.version.id}','${sentinel}','${compositionId}','demo',${Date.now()})`;
          break;
        case 'conversion':
          sql=`INSERT INTO exp_conversions(inquiry_id,version_id,subject_hash,composition_id,stage,created_at) VALUES('${sentinel}','${draft.version.id}','${sentinel}','${compositionId}','demo',${Date.now()})`;
          break;
        case 'feedback':
          sql=`INSERT INTO exp_feedback(version_id,subject_hash,section,composition_id,vote,created_at) VALUES('${draft.version.id}','${sentinel}','hero','${compositionId}',1,${Date.now()})`;
          break;
        case 'analysis-run':
          sql=`INSERT INTO analysis_runs(id,idempotency_key,input_hash,version_id,mode,status,input_json,created_by,created_at) VALUES('${sentinel}','qa-${sentinel}','${'a'.repeat(64)}','${draft.version.id}','dry_run','complete','{}','local-fixture',${Date.now()})`;
          break;
        case 'analysis-recommendation':
          sql=`INSERT INTO analysis_recommendations(id,run_id,version_id,definition_json,rationale,status,accepted_version_id,created_at) VALUES('${sentinel}','${crypto.randomUUID()}','${draft.version.id}','{}','local fixture','draft',NULL,${Date.now()})`;
          break;
        case 'booking-conversion':
          sql=`INSERT INTO booking_experiment_conversions(operation_id,workspace_id,version_id,subject_hash,composition_id,traffic_stage,created_at) VALUES('${sentinel}','${projectId}','${draft.version.id}','${sentinel}','${compositionId}','demo',${Date.now()})`;
          break;
        case 'hosted-handoff':
          sql=`INSERT INTO hosted_handoffs(id,workspace_id,subject_hash,grant_revision,service_id,placement,version_id,composition_id,created_at) VALUES('${sentinel}','${projectId}','${sentinel}',1,'fixture-service','booking','${draft.version.id}','${compositionId}',${Date.now()})`;
          break;
        case 'hosted-reference':
          sql=`INSERT INTO hosted_booking_references(workspace_id,ref_hash,analytics_grant_hash,analytics_revision,service_id,placement,issued_at,expires_at,experiment_subject_hash,experiment_revision,version_id,composition_id) VALUES('${projectId}','${'b'.repeat(64)}','${'c'.repeat(64)}',1,'fixture-service','booking',${Date.now()},${Date.now()+86400000},'${sentinel}',1,'${draft.version.id}','${compositionId}')`;
          break;
        case 'child':
          await result(await tool('experiments.recombine',{title:'QA dependent child draft',versionId:draft.version.id}));
          break;
      }
      if(sql)await localD1(sql);
      const before=await writeCounts();
      assert.notEqual((await tool('experiments.delete',{requestKey:key(),targets:[target(draft.version)]})).status,200,`${dependency} history or association must block logical deletion`);
      assert.equal((await versionState(draft.version.id)).deleted_at,null,`${dependency} rejection leaves the selected version visible`);
      assert.deepEqual(await writeCounts(),before,`${dependency} rejection leaves lifecycle operations/audits unchanged`);
    }
  });

  await t.test('export returns only selected definition and aggregate fields',async()=>{
    const draft=await create('QA export allowlist');
    const subjectHash='f'.repeat(64);
    const inquiryId=crypto.randomUUID();
    await localD1(`INSERT INTO exp_exposures(version_id,subject_hash,composition_id,stage,created_at) VALUES('${draft.version.id}','${subjectHash}','${draft.compositions[0].id}','demo',${Date.now()})`);
    await localD1(`INSERT INTO exp_conversions(inquiry_id,version_id,subject_hash,composition_id,stage,created_at) VALUES('${inquiryId}','${draft.version.id}','${subjectHash}','${draft.compositions[0].id}','demo',${Date.now()})`);
    const response=await tool('experiments.export',{targets:[target(draft.version)]});
    assert.equal(response.status,200);
    const body=await response.json();
    const document=body.result;
    assert.equal(document.schemaVersion,1);
    assert.equal(document.versions.length,1);
    assert.equal(document.versions[0].id,draft.version.id);
    assert.deepEqual(Object.keys(document.versions[0]).sort(),['aggregateEvidence','compositions','createdAt','id','management','revision','sourceVersion','stage','title']);
    assert.deepEqual(Object.keys(document.versions[0].aggregateEvidence).sort(),['convertedSubjects','exposures','savedRequests','thumbsDown','thumbsUp']);
    assert.equal(document.versions[0].aggregateEvidence.exposures,1);
    assert.equal(document.versions[0].aggregateEvidence.convertedSubjects,1);
    assert.equal(document.versions[0].aggregateEvidence.savedRequests,1);
    const serialized=JSON.stringify(document);
    for(const forbidden of ['subject_hash','created_by','rawEvents','<script','secret'])assert.equal(serialized.includes(forbidden),false);
    assert.equal(serialized.includes(subjectHash),false,'the export includes the aggregate count, never the exposure identity');
    assert.equal(serialized.includes(inquiryId),false,'the export never includes a saved inquiry identifier');
  });

  await t.test('chat approval binds the exact archive operation, selected version, and current revisions',async()=>{
    const draft=await create('QA approval-bound archive');
    const admin=await result(await tool('admin.identity'));
    const state=await versionState(draft.version.id);
    const targets=[target(draft.version)];
    const managementState=[{versionId:state.id,managementRevision:state.management_revision,versionRevision:state.revision,stage:state.stage,archivedAt:state.archived_at,deletedAt:state.deleted_at}];
    const managementRevision=hash(canonical(managementState));
    const baseline=await result(await tool('baseline.status',{}));
    const revisions={operation:'experiments.archive',managementTargets:managementRevision,[`management_${state.id}`]:state.management_revision,[`definition_${state.id}`]:state.revision,runtimeRevision:state.runtime_revision,build:baseline.currentBuildHash};
    const args={requestKey:'approval_archive_fixture_001',targets};
    const threadId=crypto.randomUUID();
    const receiptId=crypto.randomUUID();
    const argsHash=hash(canonical({tool:'experiments.archive',arguments:args}));
    const now=Date.now();
    const revisionJson=canonical(revisions);
    await localD1(`INSERT INTO admin_chat_threads(id,workspace_id,google_subject,title,created_at,updated_at) VALUES(${sqlQuote(threadId)},${sqlQuote(projectId)},${sqlQuote(admin.subject)},'QA approval fixture',${now},${now})`);
    await localD1(`INSERT INTO action_approvals(id,workspace_id,google_subject,thread_id,tool,args_json,args_hash,resource_revision,status,expires_at,created_at) VALUES(${sqlQuote(receiptId)},${sqlQuote(projectId)},${sqlQuote(admin.subject)},${sqlQuote(threadId)},'experiments.archive',${sqlQuote(canonical(args))},${sqlQuote(argsHash)},${sqlQuote(revisionJson)},'pending',${now+600000},${now})`);
    const url=new URL('/api/admin/actions/confirm',baseUrl);
    const confirmed=await fetch(url,{method:'POST',redirect:'manual',headers:{'oai-authenticated-user-id':siteUserId,'oai-authenticated-user-email':siteUserEmail,cookie:adminCookie,origin:url.origin,connection:'close','content-type':'application/json'},body:JSON.stringify({receiptId,threadId,argsHash,confirm:true})});
    assert.equal(confirmed.status,200,`approval should execute its exact stored management action (HTTP ${confirmed.status})`);
    assert.equal((await versionState(draft.version.id)).archived_at!==null,true);
    const approvalRows=await localD1(`SELECT status,tool,args_hash FROM action_approvals WHERE id=${sqlQuote(receiptId)}`);
    assert.equal(approvalRows[0].status,'complete');
    assert.equal(approvalRows[0].tool,'experiments.archive');
    assert.equal(approvalRows[0].args_hash,argsHash);
  });

  await t.test('a management revision change invalidates a pending exact-selection approval',async()=>{
    const draft=await create('QA stale approval target');
    const admin=await result(await tool('admin.identity'));
    const state=await versionState(draft.version.id);
    const targets=[target(draft.version)];
    const managementState=[{versionId:state.id,managementRevision:state.management_revision,versionRevision:state.revision,stage:state.stage,archivedAt:state.archived_at,deletedAt:state.deleted_at}];
    const managementRevision=hash(canonical(managementState));
    const baseline=await result(await tool('baseline.status',{}));
    const revisions={operation:'experiments.delete',managementTargets:managementRevision,[`management_${state.id}`]:state.management_revision,[`definition_${state.id}`]:state.revision,runtimeRevision:state.runtime_revision,build:baseline.currentBuildHash};
    const args={requestKey:'approval_delete_fixture_002',targets};
    const threadId=crypto.randomUUID();
    const receiptId=crypto.randomUUID();
    const argsHash=hash(canonical({tool:'experiments.delete',arguments:args}));
    const now=Date.now();
    await localD1(`INSERT INTO admin_chat_threads(id,workspace_id,google_subject,title,created_at,updated_at) VALUES(${sqlQuote(threadId)},${sqlQuote(projectId)},${sqlQuote(admin.subject)},'QA stale approval fixture',${now},${now})`);
    await localD1(`INSERT INTO action_approvals(id,workspace_id,google_subject,thread_id,tool,args_json,args_hash,resource_revision,status,expires_at,created_at) VALUES(${sqlQuote(receiptId)},${sqlQuote(projectId)},${sqlQuote(admin.subject)},${sqlQuote(threadId)},'experiments.delete',${sqlQuote(canonical(args))},${sqlQuote(argsHash)},${sqlQuote(canonical(revisions))},'pending',${now+600000},${now})`);
    await result(await tool('experiments.archive',{requestKey:key(),targets:[target(draft.version)]}));
    const url=new URL('/api/admin/actions/confirm',baseUrl);
    const confirmed=await fetch(url,{method:'POST',redirect:'manual',headers:{'oai-authenticated-user-id':siteUserId,'oai-authenticated-user-email':siteUserEmail,cookie:adminCookie,origin:url.origin,connection:'close','content-type':'application/json'},body:JSON.stringify({receiptId,threadId,argsHash,confirm:true})});
    assert.equal(confirmed.status,409,'confirmation must reject after the selected management revision changes');
    const changed=await versionState(draft.version.id);
    assert.ok(changed.archived_at);
    assert.equal(changed.deleted_at,null,'stale confirmation must not apply the now-ineligible deletion');
    const receipt=await localD1(`SELECT status FROM action_approvals WHERE id=${sqlQuote(receiptId)}`);
    assert.equal(receipt[0].status,'pending','a failed stale claim does not execute the stored action');
  });
});
