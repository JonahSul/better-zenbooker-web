import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url);
const source=await readFile(path.join(root,'lib/admin-client.ts'),'utf8');
const bundle=await build({stdin:{contents:source,resolveDir:root,sourcefile:'lib/admin-client.ts',loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false});
const loaded={exports:{}};
new Function('require','module','exports',bundle.outputFiles[0].text)(require,loaded,loaded.exports);

test('experiment export downloads an application/json document with the approved filename',async()=>{
  const originalCreate=URL.createObjectURL;
  const originalRevoke=URL.revokeObjectURL;
  const originalDocument=globalThis.document;
  let blob;
  let clicked=false;
  const anchor={href:'',download:'',click(){clicked=true;}};
  URL.createObjectURL=value=>{blob=value;return 'blob:fixture';};
  URL.revokeObjectURL=()=>{};
  globalThis.document={createElement(tag){assert.equal(tag,'a');return anchor;}};
  try{
    const document={schemaVersion:1,versions:[{id:'fixture-version',aggregateEvidence:{exposures:0}}]};
    loaded.exports.downloadAdminData(document,'demo-406-experiments.json');
    assert.equal(clicked,true);
    assert.equal(anchor.href,'blob:fixture');
    assert.equal(anchor.download,'demo-406-experiments.json');
    assert.equal(blob.type,'application/json');
    assert.deepEqual(JSON.parse(await blob.text()),document);
  }finally{
    URL.createObjectURL=originalCreate;
    URL.revokeObjectURL=originalRevoke;
    if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;
  }
});
