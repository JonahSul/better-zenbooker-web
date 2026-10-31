import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const base = process.env.QA_WORKER_BASE_URL ?? 'http://localhost:5178';
const origin = new URL(base).origin;
const enabled = process.env.QA_ENABLE_MCP_INTEGRATION === '1';
const fixtureText = enabled ? await readFile(new URL('../.dev.vars', import.meta.url), 'utf8') : '';
const fixture = Object.fromEntries(fixtureText
  .split(/\r?\n/).filter(Boolean).map(line => {
    const split = line.indexOf('=');
    let value = line.slice(split + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return [line.slice(0, split), value];
  }));
const ownerCookies = `__Host-browser_session=${'a'.repeat(64)}; __Host-admin_session=${'b'.repeat(64)}`;

test('machine MCP exposes only scoped tools and creates a human-only exact approval receipt', {skip: !enabled}, async () => {
  const fixtureUrl = new URL(base);
  assert.equal(fixtureUrl.protocol, 'http:', 'MCP acceptance uses local HTTP only');
  assert.ok(['localhost', '127.0.0.1'].includes(fixtureUrl.hostname), 'MCP acceptance is restricted to a loopback fixture');
  assert.equal(fixtureUrl.port, '5178', 'MCP acceptance uses only the approved fixture port');
  assert.equal(path.resolve(process.env.QA_DISPOSABLE_D1_PATH ?? ''), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.wrangler', 'qa-disposable-d1'), 'D1 fixture persistence must be isolated and explicit');
  assert.equal(fixture.INSTALLATION_ID, 'test-installation');
  assert.equal(fixture.MCP_OWNER_EMAIL, 'owner@example.com');
  assert.equal(fixture.MCP_OWNER_SUBJECT, 'fixture-owner');
  assert.ok(/^[A-Za-z0-9_-]{32,256}$/.test(fixture.MCP_BEARER_TOKEN ?? ''), 'synthetic machine bearer is configured');
  const headers = {cookie: ownerCookies, origin, 'content-type': 'application/json'};
  const modulesResponse = await fetch(new URL('/api/admin/modules', base), {headers: {cookie: ownerCookies}});
  assert.equal(modulesResponse.status, 200);
  const modules = (await modulesResponse.json()).modules;
  const mcp = modules.find(row => row.module === 'mcp');
  assert.ok(mcp);
  const moduleResponse = await fetch(new URL('/api/admin/modules', base), {
    method: 'POST', headers,
    body: JSON.stringify({module: 'mcp', revision: mcp.revision, enabled: true, config: {}}),
  });
  assert.equal(moduleResponse.status, 200);
  assert.equal((await moduleResponse.json()).status, 'ready');

  const machineHeaders = {authorization: 'Bearer ' + fixture.MCP_BEARER_TOKEN, 'content-type': 'application/json'};
  const rpc = async (name, args) => fetch(new URL('/mcp', base), {
    method: 'POST', headers: machineHeaders,
    body: JSON.stringify({jsonrpc: '2.0', id: 'qa-machine', method: 'tools/call', params: {name, arguments: args}}),
  });
  const listResponse = await fetch(new URL('/mcp', base), {
    method: 'POST', headers: machineHeaders,
    body: JSON.stringify({jsonrpc: '2.0', id: 'qa-tools', method: 'tools/list'}),
  });
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()).result.tools.map(tool => tool.name);
  assert.deepEqual(listed, ['offerings_save_draft'], 'the machine sees only the explicitly granted operation');

  const unscoped = await rpc('offerings_publish', {
    requestKey: '10000000-0000-4000-8000-000000000001', expectedRevision: 0,
    snapshotId: '20000000-0000-4000-8000-000000000002', expectedSnapshotRevision: 1,
  });
  assert.equal(unscoped.status, 200);
  assert.equal((await unscoped.json()).result.isError, true, 'valid but unscoped mutation must be rejected by the machine capability');

  const proposal = await rpc('offerings_save_draft', {
    requestKey: '30000000-0000-4000-8000-000000000003', expectedRevision: 0, source: 'owner_review', offerings: [],
  });
  assert.equal(proposal.status, 200);
  const proposalBody = (await proposal.json()).result;
  assert.equal(proposalBody.isError, undefined);
  const approval = JSON.parse(proposalBody.content[0].text);
  assert.equal(approval.status, 'requires_approval');
  assert.equal(approval.machineCannotConfirm, true);
  assert.equal(approval.resultLink, '/admin/mcp-approvals');
  assert.ok(approval.approval?.id && approval.approval?.threadId && approval.approval?.argsHash);

  const machineConfirm = await fetch(new URL('/api/admin/actions/confirm', base), {
    method: 'POST', headers: {authorization: machineHeaders.authorization, origin, 'content-type': 'application/json'},
    body: JSON.stringify({receiptId: approval.approval.id, threadId: approval.approval.threadId, argsHash: approval.approval.argsHash}),
  });
  assert.equal(machineConfirm.status, 403, 'the browser owner-confirmation route rejects a machine bearer without an owner session');

  const latest = await fetch(new URL('/api/admin/modules', base), {headers: {cookie: ownerCookies}});
  const current = (await latest.json()).modules.find(row => row.module === 'mcp');
  const disable = await fetch(new URL('/api/admin/modules', base), {
    method: 'POST', headers,
    body: JSON.stringify({module: 'mcp', revision: current.revision, enabled: false, config: {}}),
  });
  assert.equal(disable.status, 200);
});
