import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadProjection() {
  const source = await readFile(path.join(root, 'lib/model-projection.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const requireMock = (specifier) => {
    if (specifier === './admin-redaction') return {
      redactAdminText: (input, contacts = []) => {
        let text = input;
        for (const contact of contacts) {
          if (contact) text = text.replaceAll(contact, '[redacted contact]');
        }
        text = text
          .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted]')
          .replace(/\+?\d[\d\s().-]{7,}\d/g, '[redacted]')
          .replace(/https?:\/\/[^\s]+/g, '[external link omitted]');
        return { text, redacted: text !== input };
      },
    };
    throw new Error(`Unexpected import in model projection: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(requireMock, module, module.exports);
  return module.exports;
}

const projection = await loadProjection();

function contactDb(rows) {
  const statements = [];
  return {
    prepare(sql) {
      assert.match(sql, /SELECT DISTINCT name,contact FROM \(SELECT (?:name,contact FROM inquiries|.+ AS name,.+ AS contact FROM (?:customers|appointments|booking_contexts))/);
      assert.match(sql, /LIMIT 101$/);
      const statement = { bind(...args) {
        assert.equal(args.length, 2);
        assert.equal(args.includes('fixture-site-user'), false);
        return { async all() { return { results: rows }; } };
      } };
      statements.push(statement);
      return statement;
    },
    async batch(bound) { return Promise.all(bound.map(statement => statement.all())); },
  };
}

test('chat context removes known inquiry contact fields and direct identifiers', async () => {
  const db = contactDb([{ name: 'Jamie Example', contact: 'jamie@example.invalid' }]);
  const result = await projection.redactModelContext(db, 'fixture-site-user', {
    title: 'Follow up with Jamie Example',
    content: 'Call Jamie Example at (406) 555-0199 or jamie@example.invalid.',
  });
  assert.equal(result.uncertain, false);
  assert.equal(result.redacted, true);
  assert.doesNotMatch(JSON.stringify(result.value), /Jamie Example|jamie@example\.invalid|406|0199/i);
});

test('contact matching fails closed when more than the bounded result set matches', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ name: `Contact ${index}`, contact: `c${index}@example.invalid` }));
  const result = await projection.redactModelContext(contactDb(rows), 'fixture-site-user', 'A contact list');
  assert.equal(result.uncertain, true);
  assert.deepEqual(result.value, { protectedDetailsOnly: true, reason: 'Known-contact matching exceeded the safe bound. Use scoped record IDs and protected views.' });
});

test('model context truncates long values and bounds arrays, objects, and nesting', () => {
  const value = projection.boundedContext({ text: 'x'.repeat(5000), rows: Array.from({ length: 25 }, (_, index) => index), extra: Object.fromEntries(Array.from({ length: 55 }, (_, index) => [`k${index}`, index])) });
  assert.equal(value.text.length, 4020);
  assert.equal(value.rows.length, 20);
  assert.equal(Object.keys(value.extra).length, 50);
});

test('model-only memory projection omits tombstoned content and historical versions', () => {
  const deleted = {
    node: { id: 'node-deleted', namespace: 'interaction', current_revision: 2, tombstoned_at: 0, created_at: 1, updated_at: 2, title: 'Secret old title', content: 'Secret deleted body', provenance_json: '{"private":"secret"}' },
    versions: [{ revision: 1, title: 'Old title', content: 'Older deleted body', provenance_json: '{"secret":"old"}' }],
  };
  const projected = projection.modelMemoryEvidence(deleted);
  assert.deepEqual(projected, {
    node: { id: 'node-deleted', namespace: 'interaction', current_revision: 2, tombstoned_at: 0, created_at: 1, updated_at: 2, contentOmitted: true },
    protectedHistory: true,
  });
  assert.doesNotMatch(JSON.stringify(projected), /Secret|Older deleted|provenance|private/);
});

test('mixed memory search preserves active content and returns metadata only for deleted nodes', () => {
  const projected = projection.modelMemoryEvidence({ nodes: [
    { id: 'active', namespace: 'curation', current_revision: 1, tombstoned_at: null, title: 'Current title', content: 'Current approved text' },
    { id: 'deleted', namespace: 'curation', current_revision: 2, tombstoned_at: 0, title: 'Old title', content: 'Deleted content', provenance_json: 'secret source' },
  ] });
  assert.equal(projected.nodes[0].content, 'Current approved text');
  assert.deepEqual(projected.nodes[1], { id: 'deleted', namespace: 'curation', current_revision: 2, tombstoned_at: 0, contentOmitted: true });
  assert.doesNotMatch(JSON.stringify(projected), /Old title|Deleted content|secret source/);
});

test('cached active memory is revalidated against current scoped state before model projection', async () => {
  const cached = { id: 'memory-a', namespace: 'interaction', current_revision: 1, tombstoned_at: null, title: 'Cached title', content: 'Cached private body', versions: [{ revision: 1, title: 'Old version', content: 'Older body' }] };
  let current = { id: 'memory-a', namespace: 'interaction', current_revision: 2, tombstoned_at: 99, created_at: 1, updated_at: 99, title: 'Deleted current title', content: 'Deleted current body' };
  const deleted = await projection.revalidateMemoryEvidence({ node: cached, versions: cached.versions }, async id => {
    assert.equal(id, 'memory-a');
    return current;
  });
  assert.deepEqual(deleted, {
    node: { id: 'memory-a', namespace: 'interaction', current_revision: 2, tombstoned_at: 99, created_at: 1, updated_at: 99, contentOmitted: true },
    protectedHistory: true,
  });
  assert.doesNotMatch(JSON.stringify(deleted), /Cached|Deleted|Older|private body/);

  current = { id: 'memory-a', namespace: 'interaction', current_revision: 1, tombstoned_at: null, created_at: 1, updated_at: 2, title: 'Current title', content: 'Current body' };
  const active = await projection.revalidateMemoryEvidence(cached, async () => current);
  assert.equal(active.content, 'Current body');
  assert.doesNotMatch(JSON.stringify(active), /Cached private body|Old version|Older body/);
});

test('model chat-history projection drops stored message bodies and tool-result payloads', () => {
  const projected = projection.modelChatHistory({
    thread: { id: 'thread-a' },
    messages: [
      { id: 'message-user', role: 'user', content: 'What did I save?', created_at: 1 },
      { id: 'message-tool', role: 'tool', content: '{"node":{"content":"deleted customer note"}}', created_at: 2 },
    ],
  });
  assert.deepEqual(projected, {
    historyContentOmitted: true,
    thread: { id: 'thread-a' },
    messages: [{ id: 'message-user', role: 'user', created_at: 1 }, { id: 'message-tool', role: 'tool', created_at: 2 }],
  });
  assert.doesNotMatch(JSON.stringify(projected), /What did I save|deleted customer note/);
});

test('a prior active memory tool result is revalidated again before the next model call', async () => {
  const entries = [{ role: 'tool_result', content: {
    tool: 'memory.read',
    result: { node: { id: 'memory-a', namespace: 'interaction', current_revision: 1, tombstoned_at: null, title: 'Previously active', content: 'Previously visible private body' } },
  } }];
  const nextRound = await projection.revalidateChatContext(entries, async id => {
    assert.equal(id, 'memory-a');
    return { id, namespace: 'interaction', current_revision: 2, tombstoned_at: 42, created_at: 1, updated_at: 42, title: 'Deleted now', content: 'Deleted now body' };
  });
  assert.deepEqual(nextRound, [{ role: 'tool_result', content: {
    tool: 'memory.read',
    result: { node: { id: 'memory-a', namespace: 'interaction', current_revision: 2, tombstoned_at: 42, created_at: 1, updated_at: 42, contentOmitted: true }, protectedHistory: true },
  } }]);
  assert.doesNotMatch(JSON.stringify(nextRound), /Previously active|Previously visible|Deleted now body/);
  assert.match(JSON.stringify(entries), /Previously visible private body/, 'projection must not mutate the protected UI history object');
});

test('retained draft targets are freshly resolved and stale or missing targets omit their memory body', async () => {
  const node = { id: 'thread-memory', namespace: 'interaction', current_revision: 3, tombstoned_at: null, title: 'Editing a draft', content: 'Previous draft headline to shorten', provenance_json: JSON.stringify({ references: [{ tool: 'experiments.configure', versionId: 'version-a', versionRevision: 4 }] }) };
  const active = await projection.freshThreadContext('thread-a', async threadId => {
    assert.equal(threadId, 'thread-a');
    return [node];
  }, async id => ({ ...node, id }), async reference => reference.versionId === 'version-a' ? { versionId: 'version-a', revision: 4, stage: 'draft', title: 'Current draft' } : null);
  assert.equal(active.nodes[0].content, 'Previous draft headline to shorten');
  assert.deepEqual(active.targets, [{ versionId: 'version-a', revision: 4, stage: 'draft', title: 'Current draft' }]);
  assert.equal(active.rawHistoryReplayed, false);

  const stale = await projection.freshThreadContext('thread-a', async () => [node], async id => ({ ...node, id }), async () => null);
  assert.equal(stale.nodes[0].contentOmitted, true);
  assert.equal(stale.nodes[0].reason, 'referenced_memory_changed');
  assert.deepEqual(stale.targets, []);
  assert.doesNotMatch(JSON.stringify(stale), /Previous draft headline/);
});
