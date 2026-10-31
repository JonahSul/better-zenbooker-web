import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const base = process.env.QA_WORKER_BASE_URL;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integration = (name, run) => test(name, { skip: !base && 'set QA_WORKER_BASE_URL to the local fixture URL' }, run);
if (base) {
  const host = new URL(base).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Integration suite only accepts a local loopback fixture');
  const seeded = spawnSync(process.execPath, [path.join(root, 'tests/seed-local-owner.mjs')], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (seeded.status !== 0) throw new Error('Local synthetic owner setup failed');
}
const ownerCookies = `__Host-browser_session=${'a'.repeat(64)}; __Host-admin_session=${'b'.repeat(64)}`;

integration('local homepage responds with the rendered application instead of an error boundary', async () => {
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /<meta[^>]+name="robots"[^>]+content="noindex,?\s*nofollow"/i, 'owner-published public content remains noindex by default');
  const sitemap = await fetch(new URL('/sitemap.xml', base));
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('x-robots-tag') ?? '', /noindex,\s*nofollow/i);
  const robots = await fetch(new URL('/robots.txt', base));
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get('x-robots-tag') ?? '', /noindex,\s*nofollow/i);
});

integration('camera access is allowed only on approved public HTML GET and HEAD surfaces', async () => {
  const publicGet = await fetch(base);
  assert.match(publicGet.headers.get('permissions-policy') ?? '', /camera=\(self\)/);
  assert.match(publicGet.headers.get('permissions-policy') ?? '', /microphone=\(\)/);
  assert.match(publicGet.headers.get('permissions-policy') ?? '', /geolocation=\(\)/);

  const publicHead = await fetch(base, {method: 'HEAD'});
  assert.match(publicHead.headers.get('permissions-policy') ?? '', /camera=\(self\)/);

  const admin = await fetch(new URL('/api/admin/site', base));
  assert.equal(admin.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
  const mutation = await fetch(base, {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'});
  assert.equal(mutation.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=()');
});

integration('unconfigured booking route fails closed at the runtime boundary', async () => {
  const response = await fetch(new URL('/api/booking/status', base));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/i);
  assert.deepEqual(await response.json(), { error: 'module_disabled_or_unconfigured' });
});

integration('hosted callback reports receiver unavailable when booking is disabled and does not acknowledge input', async () => {
  const response = await fetch(new URL('/webhooks/zenbooker', base), {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'job.created', webhook_id: 'qa-disabled-fixture', data: { id: 'qa-job' } }),
  });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '300');
  assert.deepEqual(await response.json(), { error: 'receiver_unavailable' });
});

integration('JSON collection limits apply case-insensitively before application dispatch', async () => {
  let nested = 'leaf';
  for (let index = 0; index < 27; index++) nested = { next: nested };
  const response = await fetch(new URL('/api/contact', base), {
    method: 'POST', headers: { 'content-type': 'Application/JSON; charset=utf-8' }, body: JSON.stringify(nested),
  });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/i);
  assert.deepEqual(await response.json(), { error: 'invalid_or_excessive_input' });
});

integration('auth redirect route never returns an attacker origin', async () => {
  for (const returnTo of ['//evil.example.test', '/%5c%5cevil.example.test', '/%2f%2fevil.example.test', 'https://evil.example.test']) {
    const response = await fetch(new URL(`/session/start?return_to=${encodeURIComponent(returnTo)}`, base), { redirect: 'manual' });
    assert.equal(response.status, 303);
    const location = new URL(response.headers.get('location'), base);
    assert.equal(location.origin, new URL(base).origin);
  }
});

integration('owner allowlist session creates a pasted-source draft and publishes only the current revision', async () => {
  const anonymous = await fetch(new URL('/api/admin/site', base), {
    headers: { 'oai-user-id': 'forged-owner', 'x-runtime-user': 'forged-owner' },
  });
  assert.equal(anonymous.status, 403, 'runtime identity headers cannot authorize owner operations');

  const headers = { cookie: ownerCookies, origin: new URL(base).origin, 'content-type': 'application/json' };
  const currentResponse = await fetch(new URL('/api/admin/site', base), { headers: { cookie: ownerCookies, origin: new URL(base).origin } });
  assert.equal(currentResponse.status, 200);
  const current = await currentResponse.json();
  const revision = Number.isSafeInteger(current.revision) ? current.revision : 0;
  const sourceUrl = 'https://www.iana.org/domains/reserved';
  const sourceText = 'The sample business offers weekday appointments by request.';
  const draftResponse = await fetch(new URL('/api/admin/site', base), {
    method: 'POST', headers,
    body: JSON.stringify({ revision, details: { name: 'Sample Business', description: 'Draft text', area: 'Example service area', theme: 'light' }, source: { url: sourceUrl, text: sourceText, approved: true } }),
  });
  assert.equal(draftResponse.status, 200);
  const draft = await draftResponse.json();
  assert.equal(draft.revision, revision + 1);
  assert.equal(draft.details.description, sourceText, 'source parsing uses explicitly pasted text');
  assert.deepEqual(draft.details.sourceUrls, [sourceUrl], 'the URL is stored only as provenance');

  const invalid = await fetch(new URL('/api/admin/site', base), { method: 'POST', headers, body: JSON.stringify({ revision: 'bad', action: 'publish' }) });
  assert.equal(invalid.status, 400, 'malformed lifecycle input must not become a server error');
  const staleDraft = await fetch(new URL('/api/admin/site', base), {
    method: 'POST', headers,
    body: JSON.stringify({ revision, details: { name: 'Stale overwrite', description: 'Should not win', theme: 'light' } }),
  });
  assert.equal(staleDraft.status, 409);

  const publish = await fetch(new URL('/api/admin/site', base), { method: 'POST', headers, body: JSON.stringify({ action: 'publish', revision: draft.revision }) });
  assert.equal(publish.status, 200);
  assert.deepEqual(await publish.json(), { published: true, revision: draft.revision });
  const stalePublish = await fetch(new URL('/api/admin/site', base), { method: 'POST', headers, body: JSON.stringify({ action: 'publish', revision }) });
  assert.equal(stalePublish.status, 409);
  const homepage = await fetch(base);
  assert.equal(homepage.status, 200);
  const html = await homepage.text();
  assert.match(html, /Sample Business/);
  assert.match(html, /The sample business offers weekday appointments by request\./);
});

integration('owner enables the real private-memory lifecycle with CAS, then disablement blocks later operations', async () => {
  const headers = { cookie: ownerCookies, origin: new URL(base).origin, 'content-type': 'application/json' };
  const list = await fetch(new URL('/api/admin/modules', base), { headers: { cookie: ownerCookies } });
  assert.equal(list.status, 200);
  const modules = (await list.json()).modules;
  const memory = modules.find(row => row.module === 'admin_memory');
  assert.ok(memory, 'admin memory must be represented by the real module configuration store');

  const enable = await fetch(new URL('/api/admin/modules', base), {
    method: 'POST', headers,
    body: JSON.stringify({ module: 'admin_memory', revision: memory.revision, enabled: true, config: {} }),
  });
  assert.equal(enable.status, 200);
  const ready = await enable.json();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.revision, memory.revision + 1);
  const stale = await fetch(new URL('/api/admin/modules', base), {
    method: 'POST', headers,
    body: JSON.stringify({ module: 'admin_memory', revision: memory.revision, enabled: false, config: {} }),
  });
  assert.equal(stale.status, 409, 'concurrent stale module revisions must conflict');

  const title = `QA local memory ${randomUUID()}`;
  const invoke = async (tool, args) => fetch(new URL('/api/admin/tools', base), {
    method: 'POST', headers, body: JSON.stringify({ tool, arguments: args }),
  });
  const addedResponse = await invoke('memory.add', { namespace: 'interaction', title, content: 'Synthetic local memory lifecycle test.' });
  assert.equal(addedResponse.status, 200);
  const added = await addedResponse.json();
  const node = added.result?.node;
  assert.equal(node?.title, title);
  assert.equal(node?.namespace, 'interaction');

  const readResponse = await invoke('memory.read', { nodeId: node.id });
  assert.equal(readResponse.status, 200);
  assert.equal((await readResponse.json()).result.node.id, node.id);
  const deletedResponse = await invoke('memory.delete', { nodeId: node.id, revision: node.current_revision });
  assert.equal(deletedResponse.status, 200);
  assert.ok((await deletedResponse.json()).result.node.tombstoned_at);

  const disable = await fetch(new URL('/api/admin/modules', base), {
    method: 'POST', headers,
    body: JSON.stringify({ module: 'admin_memory', revision: ready.revision, enabled: false, config: {} }),
  });
  assert.equal(disable.status, 200);
  assert.equal((await disable.json()).status, 'disabled');
  assert.equal((await invoke('memory.search', { namespace: 'interaction', query: title })).status, 400);
});
