import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localRequire = createRequire(import.meta.url);
const createdAt = Date.now();
const source = await readFile(path.join(root, 'lib/action-approval-core.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)(specifier => {
  if (specifier === 'zod/v3') return localRequire('zod/v3');
  if (specifier === './admin-auth-core') return {
    sha256: async value => createHash('sha256').update(value).digest('hex'),
  };
  throw new Error(`Unexpected action approval dependency: ${specifier}`);
}, loaded, loaded.exports);
const { actionArgsHash, actionConfirmation, canonicalAction, resourceRevision, ActionApprovalStore, requiresActionApproval } = loaded.exports;

test('action args are canonical and hashes bind both operation and exact arguments', async () => {
  const one = { versionId: 'version-a', compositionId: 'composition-a', rationale: 'Owner approved this.' };
  const reordered = { rationale: 'Owner approved this.', compositionId: 'composition-a', versionId: 'version-a' };
  const hash = await actionArgsHash('experiments.promote', one);
  assert.equal(await actionArgsHash('experiments.promote', reordered), hash, 'object insertion order does not change the stored action identity');
  assert.notEqual(await actionArgsHash('experiments.rollback', one), hash, 'a receipt cannot be replayed for a different tool');
  assert.notEqual(await actionArgsHash('experiments.promote', { ...one, compositionId: 'composition-b' }), hash, 'a receipt is bound to the exact composition');
  assert.equal(canonicalAction({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
});

test('human confirmation schema requires the exact receipt/hash and rejects caller-supplied action overrides', () => {
  const valid = {
    receiptId: '7f72786d-c75a-42a7-97c5-8fe9f8a17e55',
    threadId: 'a3ab1aca-467d-43cb-bd81-3f0c0c60d3bd',
    argsHash: 'a'.repeat(64),
    confirm: true,
  };
  assert.equal(actionConfirmation.safeParse(valid).success, true);
  assert.equal(actionConfirmation.safeParse({ ...valid, arguments: { compositionId: 'attacker-choice' } }).success, false);
  assert.equal(actionConfirmation.safeParse({ ...valid, confirm: false }).success, false);
  assert.equal(actionConfirmation.safeParse({ ...valid, argsHash: 'not-a-sha256' }).success, false);
  assert.equal(actionConfirmation.safeParse({ ...valid, receiptId: 'not-a-uuid' }).success, false);
});

test('resource revisions accept scalar snapshots but reject model-shaped objects', () => {
  assert.deepEqual(resourceRevision.parse({ version: 4, composition: 'rev-1', baseline: null }), {
    version: 4, composition: 'rev-1', baseline: null,
  });
  assert.equal(resourceRevision.safeParse({ version: { revision: 4 } }).success, false);
});

test('approval policy separates reversible drafts and tombstones from consequential or irreversible actions', () => {
  for (const [tool, args] of [
    ['memory.delete', { nodeId: crypto.randomUUID(), revision: 2 }],
    ['memory.undo', { nodeId: crypto.randomUUID(), revision: 3 }],
    ['experiments.configure', { versionId: crypto.randomUUID() }],
    ['experiments.compile', { versionId: crypto.randomUUID() }],
    ['experiments.recombine', { versionId: crypto.randomUUID() }],
    ['provider.diagnostic_acknowledge', { diagnosticId: crypto.randomUUID() }],
  ]) assert.equal(requiresActionApproval(tool, args), false, `${tool} is reversible or metadata-only and remains intent/target-gated`);

  for (const tool of ['inquiries.purge', 'data.erase_interaction', 'retention.apply', 'inquiries.update', 'provider.configure', 'experiments.promote', 'experiments.rollback']) {
    assert.equal(requiresActionApproval(tool, {}), true, `${tool} requires a persisted human approval receipt`);
  }
});

test('approval receipts are bound to workspace, principal, owned thread, arguments, resource revision, expiry, and one claim', async () => {
  const threadId = 'a3ab1aca-467d-43cb-bd81-3f0c0c60d3bd';
  const args = { versionId: 'version-a', compositionId: 'composition-a', rationale: 'Owner requested this change.' };
  const revisions = { version: 7, composition: 3 };
  const database = new ReceiptD1();
  database.threads.set(threadId, { workspaceId: 'workspace-a', googleSubject: 'google-a' });
  let now = createdAt;
  const owner = new ActionApprovalStore(database, 'workspace-a', 'google-a', () => now);
  const otherPrincipal = new ActionApprovalStore(database, 'workspace-a', 'google-b', () => now);
  const otherWorkspace = new ActionApprovalStore(database, 'workspace-b', 'google-a', () => now);

  await assert.rejects(owner.issue(crypto.randomUUID(), 'experiments.promote', args, revisions), /Current authorized thread required/);
  const receipt = await owner.issue(threadId, 'experiments.promote', args, revisions);
  assert.equal(receipt.status, 'pending');
  assert.equal(receipt.confirmationRequired, true);
  assert.deepEqual(receipt.arguments, args);
  assert.deepEqual(receipt.resourceRevision, revisions);
  assert.equal(receipt.argsHash, await actionArgsHash('experiments.promote', args));
  await assert.rejects(otherPrincipal.read(receipt.id, threadId), /Approval unavailable/);
  await assert.rejects(otherWorkspace.read(receipt.id, threadId), /Approval unavailable/);
  await assert.rejects(owner.read(receipt.id, crypto.randomUUID()), /Approval unavailable/);

  await assert.rejects(owner.claim(receipt.id, threadId, revisions, 'b'.repeat(64)), /Exact action mismatch/);
  await assert.rejects(owner.claim(receipt.id, threadId, { version: 8, composition: 3 }), /Approval expired, changed, or already used/);
  assert.equal((await owner.read(receipt.id, threadId)).status, 'pending', 'a failed target revision check must not consume the receipt');

  const competingClaims = await Promise.allSettled([
    owner.claim(receipt.id, threadId, revisions, receipt.argsHash),
    owner.claim(receipt.id, threadId, revisions, receipt.argsHash),
  ]);
  assert.equal(competingClaims.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(competingClaims.filter(result => result.status === 'rejected').length, 1);

  now = receipt.expiresAt + 1;
  await assert.rejects(owner.claim(receipt.id, threadId, revisions, receipt.argsHash), /Approval expired, changed, or already used/);
});

class ReceiptD1 {
  constructor() { this.rows = new Map(); this.threads = new Map(); }
  prepare(sql) {
    return { bind: (...values) => ({
      run: async () => this.run(sql, values),
      first: async () => this.first(sql, values),
    }) };
  }
  async run(sql, values) {
    if (sql.startsWith('INSERT INTO action_approvals')) {
      const [id, workspaceId, googleSubject, threadId, tool, argsJson, argsHash, revisionJson, expiresAt, createdAt, threadCheck, workspaceCheck, subjectCheck] = values;
      const thread = this.threads.get(threadCheck);
      if (!thread || thread.workspaceId !== workspaceCheck || thread.googleSubject !== subjectCheck) return { meta: { changes: 0 } };
      this.rows.set(id, { id, workspace_id: workspaceId, google_subject: googleSubject, thread_id: threadId, tool, args_json: argsJson, args_hash: argsHash, resource_revision: revisionJson, expires_at: expiresAt, created_at: createdAt, status: 'pending' });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE action_approvals SET status=\'claimed\'')) {
      const [claimedAt, id, workspaceId, googleSubject, threadId, argsHash, revisionJson, now, threadCheck, workspaceCheck, subjectCheck] = values;
      const row = this.rows.get(id);
      const thread = this.threads.get(threadCheck);
      if (!row || row.workspace_id !== workspaceId || row.google_subject !== googleSubject || row.thread_id !== threadId
        || row.args_hash !== argsHash || row.resource_revision !== revisionJson || row.status !== 'pending' || row.expires_at <= now
        || !thread || thread.workspaceId !== workspaceCheck || thread.googleSubject !== subjectCheck) return { meta: { changes: 0 } };
      row.status = 'claimed';
      row.claimed_at = claimedAt;
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('UPDATE action_approvals SET status=?')) {
      const [status, id, workspaceId, googleSubject] = values;
      const row = this.rows.get(id);
      if (!row || row.workspace_id !== workspaceId || row.google_subject !== googleSubject || row.status !== 'claimed') return { meta: { changes: 0 } };
      row.status = status;
      return { meta: { changes: 1 } };
    }
    throw new Error(`Unexpected approval statement: ${sql}`);
  }
  async first(sql, values) {
    if (!sql.startsWith('SELECT * FROM action_approvals')) throw new Error(`Unexpected approval query: ${sql}`);
    const [id, workspaceId, googleSubject, threadId] = values;
    const row = this.rows.get(id);
    return row && row.workspace_id === workspaceId && row.google_subject === googleSubject && row.thread_id === threadId ? structuredClone(row) : null;
  }
}
