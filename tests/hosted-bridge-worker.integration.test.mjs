import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const base = process.env.QA_WORKER_BASE_URL ?? 'http://localhost:5178';
const origin = new URL(base).origin;
const enabled = process.env.QA_ENABLE_BRIDGE_INTEGRATION === '1';
const fixtureText = enabled ? await readFile(new URL('../.dev.vars', import.meta.url), 'utf8') : '';
const fixture = Object.fromEntries(fixtureText
  .split(/\r?\n/).filter(Boolean).map(line => {
    const split = line.indexOf('=');
    let value = line.slice(split + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return [line.slice(0, split), value];
  }));

function d1(baseUrl) {
  const endpoint = new URL('/cdn-cgi/local/explorer/api/d1/database/DB/raw', baseUrl);
  async function query(sql, params = []) {
    const response = await fetch(endpoint, {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({sql, params: params.map(value => String(value))}),
    });
    const raw = await response.text();
    assert.equal(response.status, 200, `local D1 explorer query failed for: ${sql}; response: ${raw.slice(0, 1000)}`);
    const payload = JSON.parse(raw);
    assert.equal(payload.success, true, JSON.stringify(payload.errors));
    return payload.result[0];
  }
  const statement = (sql, params = []) => ({
    sql, params,
    async first() {
      const result = await query(sql, params);
      const {columns, rows} = result.results;
      if (!rows.length) return null;
      return Object.fromEntries(columns.map((column, index) => [column, rows[0][index]]));
    },
    async all() {
      const result = await query(sql, params);
      const {columns, rows} = result.results;
      return {results: rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))), success: true, meta: result.meta};
    },
    async run() {
      const result = await query(sql, params);
      return {success: true, meta: {changes: result.meta.changes, last_row_id: result.meta.last_row_id}};
    },
  });
  return {
    prepare(sql) { return {bind(...params) { return statement(sql, params); }}; },
    async batch(statements) {
      const response = await fetch(endpoint, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({batch: statements.map(item => ({sql: item.sql, params: item.params.map(value => String(value))}))}),
      });
      assert.equal(response.status, 200, 'local D1 explorer batch should succeed');
      const payload = await response.json();
      assert.equal(payload.success, true, JSON.stringify(payload.errors));
      return payload.result.map(item => ({success: true, meta: {changes: item.meta.changes, last_row_id: item.meta.last_row_id}}));
    },
  };
}

async function bridgeStore() {
  assert.equal(fixture.INSTALLATION_ID, 'test-installation', 'refuse to seed anything outside the synthetic local fixture');
  const fixtureUrl = new URL(base);
  assert.equal(fixtureUrl.protocol, 'http:', 'bridge integration is local HTTP only');
  assert.ok(['localhost', '127.0.0.1'].includes(fixtureUrl.hostname), 'bridge integration is loopback-only');
  assert.equal(fixtureUrl.port, '5178', 'bridge integration uses only the approved fixture port');
  assert.equal(path.resolve(process.env.QA_DISPOSABLE_D1_PATH ?? ''), path.resolve(rootPath(), '.wrangler', 'qa-disposable-d1'), 'D1 fixture persistence must be isolated and explicit');
  assert.match(fixture.APP_CREDENTIAL_ENCRYPTION_KEY ?? '', /^[A-Za-z0-9+/]{43}=$/, 'synthetic local key required');
  const built = await build({entryPoints: ['lib/hosted-bridge-store.ts'], bundle: true, platform: 'node', format: 'esm', write: false});
  const source = built.outputFiles[0].text;
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return new module.HostedBridgeStore(d1(base), fixture.INSTALLATION_ID, fixture.APP_CREDENTIAL_ENCRYPTION_KEY);
}

test('local bridge callback capability and D1 lifecycle stay protected and idempotent', {skip: !enabled}, async () => {
  const store = await bridgeStore();
  const init = await store.initialize('qa-local-bridge-setup', 'fixture-owner');
  assert.equal(init.initialized, true);
  const initialRow = await store.read();
  const initialTokens = await store.tokens(initialRow);

  const cookies = process.env.QA_OWNER_COOKIE ?? `__Host-browser_session=${'a'.repeat(64)}; __Host-admin_session=${'b'.repeat(64)}`;
  const headers = {cookie: cookies, origin, 'content-type': 'application/json'};
  const list = await fetch(new URL('/api/admin/modules', base), {headers: {cookie: cookies}});
  assert.equal(list.status, 200);
  const booking = (await list.json()).modules.find(row => row.module === 'booking');
  assert.ok(booking);
  const activation = await fetch(new URL('/api/admin/modules', base), {
    method: 'POST', headers,
    body: JSON.stringify({module: 'booking', revision: booking.revision, enabled: true, config: {transport: 'local_bridge'}}),
  });
  assert.equal(activation.status, 200);
  assert.equal((await activation.json()).status, 'ready');

  const event = {event: 'job.created', account: {id: 'sample-account'}, webhook_id: 'sample-hook', retry_count: 0, data: {id: 'sample-job'}};
  const wrongCapability = await fetch(new URL('/webhooks/zenbooker?cap=' + '0'.repeat(64), base), {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(event),
  });
  assert.equal(wrongCapability.status, 401);

  const callbackUrl = new URL('/webhooks/zenbooker', base);
  callbackUrl.searchParams.set('cap', initialTokens.callback);
  const first = await fetch(callbackUrl, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(event)});
  assert.ok([200, 202].includes(first.status), `callback capture response ${first.status}`);
  const receipt = await first.json();
  assert.ok(receipt.captured === true || receipt.status === 'captured' || receipt.disposition === 'quarantine', JSON.stringify(receipt));

  const duplicate = await fetch(callbackUrl, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(event)});
  assert.ok([200, 202].includes(duplicate.status));
  const duplicateReceipt = await duplicate.json();
  assert.match(JSON.stringify(duplicateReceipt), /duplicate|existing|captured/i);

  const rotated = await store.beginRotation(initialRow.revision, 'qa-local-rotation-request');
  assert.equal(rotated.pending, true);
  await assert.rejects(() => store.commitRotation(rotated.revision, 'qa-local-wrong-request'));
  const rotation = await store.pendingTokens(await store.read());
  const commit = await store.commitRotation(rotated.revision, 'qa-local-rotation-request');
  assert.equal(commit.revision, rotated.revision + 1);

  const oldCallback = await fetch(callbackUrl, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({...event, webhook_id: 'old-capability-hook'})});
  assert.equal(oldCallback.status, 401, 'old callback capability must stop working after owner-confirmed rotation');
  const newUrl = new URL('/webhooks/zenbooker', base);
  newUrl.searchParams.set('cap', rotation.callback);
  const newCallback = await fetch(newUrl, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({...event, webhook_id: 'rotated-hook'})});
  assert.ok([200, 202].includes(newCallback.status));

  const latestModules = await fetch(new URL('/api/admin/modules', base), {headers: {cookie: cookies}});
  const latestBooking = (await latestModules.json()).modules.find(row => row.module === 'booking');
  const disable = await fetch(new URL('/api/admin/modules', base), {
    method: 'POST', headers,
    body: JSON.stringify({module: 'booking', revision: latestBooking.revision, enabled: false, config: {transport: 'local_bridge'}}),
  });
  assert.equal(disable.status, 200);
});

function rootPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}
