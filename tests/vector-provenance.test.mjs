import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromTest = createRequire(import.meta.url);

async function loadTs(relative, overrides = {}) {
  const source = await readFile(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const ownRequire = specifier => {
    if (Object.hasOwn(overrides, specifier)) return overrides[specifier];
    if (specifier === 'zod/v3' && Object.hasOwn(overrides, 'zod')) return overrides.zod;
    if (specifier === 'zod/v3') return requireFromTest(specifier);
    throw new Error(`Unexpected ${relative} import: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(ownRequire, loaded, loaded.exports);
  return loaded.exports;
}

const experiment = await loadTs('lib/experiment-core.ts');
const auth = await loadTs('lib/admin-auth-core.ts', {
  jose: requireFromTest('jose'),
  './admin-auth-diagnostic': { AdminTokenExchangeError: class AdminTokenExchangeError extends Error {}, oauthError: value => typeof value === 'string' ? value : 'other' },
  './site-config': { DEMO_ORIGIN: 'https://fixture.invalid' },
});
const provenance = await loadTs('lib/vector-provenance.ts', {
  './experiment-core': experiment,
  './admin-auth-core': auth,
  './public-compiler': { publicArtifacts: { assetManifestHash: 'fixture-asset-manifest', rendererVersion: 'fixture-renderer' } },
});

test('only current-project vectors with a current D1 source are retrievable or eligible for stale deletion', async () => {
  const workspace = 'site-project-owner';
  const otherWorkspace = 'site-project-other';
  const model = '@cf/baai/bge-base-en-v1.5';
  const definition = JSON.stringify({ headline: 'Prepare for the season' });
  const definitionHash = await auth.sha256(definition);
  const ownId = async (workspaceId, versionId, compositionId, hash = definitionHash, modelName = model) => auth.sha256(`${workspaceId}:approved-copy:v2:${versionId}:${compositionId}:${hash}:${modelName}`);
  const metadata = (workspaceId, versionId, compositionId, hash = definitionHash, modelName = model) => ({
    workspace: workspaceId, kind: 'approved_copy', version_id: versionId, composition_id: compositionId,
    definition_hash: hash, model: modelName,
  });
  const rows = new Map([
    ['current-version|current-copy', { definition_json: definition, rules_json: JSON.stringify(experiment.HARD_RULES), stage: 'running', snapshot_hash: 'fixture-snapshot', asset_manifest_hash: 'fixture-asset-manifest', renderer_version: 'fixture-renderer', snapshot_rules_version: experiment.HARD_RULES.version }],
    ['old-version|old-copy', { definition_json: definition, rules_json: JSON.stringify(experiment.HARD_RULES), stage: 'archived', snapshot_hash: 'fixture-snapshot', asset_manifest_hash: 'fixture-asset-manifest', renderer_version: 'fixture-renderer', snapshot_rules_version: experiment.HARD_RULES.version }],
  ]);
  const queried = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /SELECT c\.definition_json,v\.rules_json,v\.stage/);
      return {
        bind(compositionId, versionId) {
          return { first: async () => { queried.push(`${versionId}|${compositionId}`); return rows.get(`${versionId}|${compositionId}`) ?? null; } };
        },
      };
    },
  };
  const matches = [
    { id: await ownId(workspace, 'current-version', 'current-copy'), score: 0.9, metadata: metadata(workspace, 'current-version', 'current-copy') },
    { id: await ownId(workspace, 'old-version', 'old-copy'), score: 0.8, metadata: metadata(workspace, 'old-version', 'old-copy') },
    { id: await ownId(otherWorkspace, 'foreign-version', 'foreign-copy'), score: 0.99, metadata: metadata(otherWorkspace, 'foreign-version', 'foreign-copy') },
    { id: await ownId(workspace, 'missing-version', 'missing-copy'), score: 0.98, metadata: metadata(workspace, 'missing-version', 'missing-copy') },
    { id: 'f'.repeat(64), score: 1, metadata: metadata(workspace, 'current-version', 'current-copy') },
  ];

  const result = await provenance.revalidateVectorMatches(db, matches, model, workspace);
  assert.deepEqual(result.valid.map(row => row.id), [matches[0].id]);
  assert.deepEqual(result.stale, [matches[1].id], 'only a known locally owned vector whose D1 source is stale is deletable');
  assert.equal(result.rejected, 3, 'foreign workspace, missing D1 source, and mismatched IDs stay rejected, never stale/deletable');
  assert.deepEqual(queried, ['current-version|current-copy', 'old-version|old-copy', 'missing-version|missing-copy']);
});

test('a draft or uncompiled composition vector is rejected before it can become model context', async () => {
  const workspace = 'site-project-owner';
  const model = '@cf/baai/bge-base-en-v1.5';
  const definition = JSON.stringify({ headline: 'Prepare for the season' });
  const definitionHash = await auth.sha256(definition);
  const versionId = 'draft-version';
  const compositionId = 'draft-copy';
  const vectorId = await auth.sha256(`${workspace}:approved-copy:v2:${versionId}:${compositionId}:${definitionHash}:${model}`);
  const db = {
    prepare(sql) {
      assert.match(sql, /SELECT c\.definition_json,v\.rules_json,v\.stage/);
      return { bind: () => ({ first: async () => ({ definition_json: definition, rules_json: JSON.stringify(experiment.HARD_RULES), stage: 'draft', snapshot_hash: 'fixture-snapshot', asset_manifest_hash: 'fixture-asset-manifest', renderer_version: 'fixture-renderer', snapshot_rules_version: experiment.HARD_RULES.version }) }) };
    },
  };
  const candidate = {
    id: vectorId,
    score: 1,
    metadata: { workspace, kind: 'approved_copy', version_id: versionId, composition_id: compositionId, definition_hash: definitionHash, model },
  };

  const result = await provenance.revalidateVectorMatches(db, [candidate], model, workspace);
  assert.deepEqual(result.valid, [], 'a draft copy is never retrieved for generation context');
  assert.deepEqual(result.stale, [vectorId], 'a recognized local vector with no active compiled source can be cleaned up');
  assert.equal(result.rejected, 0);
});

