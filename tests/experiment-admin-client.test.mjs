import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const clientSource=await readFile(path.join(root,'lib/experiment-admin-client.ts'),'utf8');
const clientBundle=await build({stdin:{contents:clientSource,resolveDir:root,sourcefile:'lib/experiment-admin-client.ts',loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,external:[]});
const clientModule={exports:{}};
new Function('require','module','exports',clientBundle.outputFiles[0].text)(require,clientModule,clientModule.exports);
const {createDraftAndReadback,mutateVersionsAndRefresh}=clientModule.exports;

const managementSource=await readFile(path.join(root,'lib/experiment-management-core.ts'),'utf8');
const managementBundle=await build({stdin:{contents:managementSource,resolveDir:root,sourcefile:'lib/experiment-management-core.ts',loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,external:['zod/v3']});
const managementModule={exports:{}};
new Function('require','module','exports',managementBundle.outputFiles[0].text)(require,managementModule,managementModule.exports);
const {managementTargets,managementMutation,managementExport}=managementModule.exports;

const tableSource=await readFile(path.join(root,'components/experiment-version-table.tsx'),'utf8');
const tableBundle=await build({stdin:{contents:tableSource,resolveDir:root,sourcefile:'components/experiment-version-table.tsx',loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,external:['react','react-dom','react/jsx-runtime']});
const tableModule={exports:{}};
new Function('require','module','exports',tableBundle.outputFiles[0].text)(require,tableModule,tableModule.exports);
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const {ExperimentVersionTable}=tableModule.exports;
const versionId='b139ac91-c197-4e4f-a694-d3d08ed510f1';
const record={version:{id:versionId,title:'Fixture draft',stage:'draft',revision:0,managementRevision:0,archivedAt:null,compositionCount:1},compositions:[{id:'f1c7b4ba-8f14-4739-8b52-0475c90b74c8',label:'control',allocation:10000,definition_json:'{}',snapshot_hash:null}]};

test('create helper trims titles, passes the supplied stable key, and reads the returned ID before refreshing the table',async()=>{
  const calls=[];
  const outcome=await createDraftAndReadback({title:'  Fixture draft  ',requestKey:'stable-create-key-0001',call:async(tool,args,key)=>{
    calls.push({tool,args,key});
    if(tool==='experiments.create')return {versionId};
    if(tool==='experiments.inspect')return record;
    if(tool==='experiments.list')return {versions:[record.version]};
    throw new Error('unexpected tool');
  }});
  assert.deepEqual(calls,[
    {tool:'experiments.create',args:{title:'Fixture draft'},key:'stable-create-key-0001'},
    {tool:'experiments.inspect',args:{versionId},key:undefined},
    {tool:'experiments.list',args:{},key:undefined},
  ]);
  assert.equal(outcome.versionId,versionId);
  assert.equal(outcome.record.version.id,versionId);
  assert.deepEqual(outcome.versions,[record.version]);
  assert.equal(outcome.refreshUnavailable,false);
});

test('a successful create with failed readback is reported as saved and is never automatically repeated',async()=>{
  const calls=[];
  const outcome=await createDraftAndReadback({title:'Fixture draft',requestKey:'stable-create-key-0002',call:async(tool,args,key)=>{
    calls.push({tool,args,key});
    if(tool==='experiments.create')return {versionId};
    if(tool==='experiments.inspect')throw new Error('fixture readback unavailable');
    throw new Error('list must not be called without inspect');
  }});
  assert.deepEqual(calls.map(row=>row.tool),['experiments.create','experiments.inspect']);
  assert.equal(calls.filter(row=>row.tool==='experiments.create').length,1);
  assert.equal(outcome.versionId,versionId);
  assert.equal(outcome.refreshUnavailable,true);
});

test('a failed list refresh preserves the saved ID and inspected editor record',async()=>{
  const outcome=await createDraftAndReadback({title:'Fixture draft',requestKey:'stable-create-key-0003',call:async tool=>{
    if(tool==='experiments.create')return {versionId};
    if(tool==='experiments.inspect')return record;
    throw new Error('fixture list unavailable');
  }});
  assert.equal(outcome.versionId,versionId);
  assert.equal(outcome.record.version.id,versionId);
  assert.equal(outcome.refreshUnavailable,true);
});

test('a confirmed bulk lifecycle mutation is not replayed when refresh fails',async()=>{
  let mutations=0,refreshes=0;
  const outcome=await mutateVersionsAndRefresh({tool:'experiments.archive',args:{targets:[{versionId,managementRevision:3}]},call:async()=>{mutations++;return {operation:'archive',versions:[{versionId,managementRevision:4}]};},refresh:async()=>{refreshes++;throw new Error('fixture refresh unavailable');}});
  assert.equal(mutations,1);
  assert.equal(refreshes,1);
  assert.equal(outcome.refreshUnavailable,true);
  assert.equal(outcome.result.operation,'archive');
  assert.equal(outcome.result.versions[0].managementRevision,4);
});

test('a rejected bulk lifecycle mutation does not attempt a refresh',async()=>{
  let refreshes=0;
  await assert.rejects(mutateVersionsAndRefresh({tool:'experiments.delete',args:{targets:[{versionId,managementRevision:0}]},call:async()=>{throw new Error('fixture mutation rejected');},refresh:async()=>{refreshes++;}}),/mutation rejected/);
  assert.equal(refreshes,0);
});

test('invalid titles and unconfirmed create responses do not trigger inspect or list',async()=>{
  let calls=0;
  await assert.rejects(createDraftAndReadback({title:'  ',requestKey:'stable-create-key-0004',call:async()=>{calls++;return {versionId};}}),/title/i);
  await assert.rejects(createDraftAndReadback({title:'Valid title',requestKey:'stable-create-key-0005',call:async()=>{calls++;return {};}}),/unconfirmed/i);
  assert.equal(calls,1,'invalid local input makes no call; malformed create result does not continue to inspect/list');
});

test('version table exposes selection separately from opening and hides archived rows by default',()=>{
  const rows=[record.version,{...record.version,id:'7b1aa670-412b-4823-b053-85a2e68355d8',title:'Archived fixture',archivedAt:1000}];
  const render=(includeArchived=false)=>renderToStaticMarkup(React.createElement(ExperimentVersionTable,{
    rows,selectedIds:[record.version.id],openedId:rows[1].id,includeArchived,
    onSelect(){},onSelectAll(){},onOpen(){},
  }));
  const active=render();
  assert.match(active,/<table>/);
  assert.match(active,/<caption>Saved experiment versions<\/caption>/);
  for(const header of ['Title','State','Compositions','Created','Open'])assert.match(active,new RegExp(`<th scope="col">${header}<\\/th>`));
  assert.match(active,/<th scope="row">Fixture draft<\/th>/);
  assert.doesNotMatch(active,/Archived fixture/);
  assert.doesNotMatch(active,/aria-current="true"/,'the selected row is not implicitly opened');
  assert.match(active,/aria-label="Select Fixture draft"[^>]*checked/);
  const archived=render(true);
  assert.match(archived,/<th scope="row">Archived fixture<\/th>/);
  assert.match(archived,/aria-current="true"/,'the opened row is explicit and distinct from checkbox selection');
  assert.match(archived,/Archived · draft/);
});

test('management target schema requires unique UUID and nonnegative revision pairs',()=>{
  const valid=[{versionId,managementRevision:0},{versionId:'7b1aa670-412b-4823-b053-85a2e68355d8',managementRevision:4}];
  assert.deepEqual(managementTargets.parse(valid),valid);
  assert.equal(managementTargets.safeParse([{versionId,managementRevision:-1}]).success,false);
  assert.equal(managementTargets.safeParse([{versionId:'not-a-uuid',managementRevision:0}]).success,false);
  assert.equal(managementTargets.safeParse([{versionId,managementRevision:0,stage:'draft'}]).success,false);
  assert.equal(managementTargets.safeParse([valid[0],valid[0]]).success,false);
  assert.equal(managementTargets.safeParse([]).success,false);
  assert.equal(managementTargets.safeParse(Array.from({length:51},(_,i)=>({versionId:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,managementRevision:0}))).success,false);
});

test('lifecycle mutation requires a bounded stable request key and strict target list',()=>{
  const args={requestKey:'request_key_012345',targets:[{versionId,managementRevision:0}]};
  assert.deepEqual(managementMutation.parse(args),args);
  for(const requestKey of ['short key','x'.repeat(81),''])assert.equal(managementMutation.safeParse({...args,requestKey}).success,false);
  assert.equal(managementMutation.safeParse({...args,extra:true}).success,false);
});

test('export selection accepts only version and management revisions',()=>{
  const valid={targets:[{versionId,managementRevision:3}]};
  assert.deepEqual(managementExport.parse(valid),valid);
  assert.equal(managementExport.safeParse({targets:[{...valid.targets[0],title:'Private title'}]}).success,false);
  assert.equal(managementExport.safeParse({...valid,includeRawEvents:true}).success,false);
});
