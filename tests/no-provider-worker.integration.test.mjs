import test from 'node:test';
import assert from 'node:assert/strict';

const base = process.env.QA_BASE_WORKER_BASE_URL;
if (base && !['localhost', '127.0.0.1', '::1'].includes(new URL(base).hostname)) {
  throw new Error('No-provider Worker acceptance accepts only a local loopback fixture');
}

test('fresh no-provider Worker serves core pages and keeps optional modules off', { skip: !base }, async () => {
  const home = await fetch(new URL('/', base), { redirect: 'manual' });
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type') ?? '', /text\/html/i);
  assert.doesNotMatch(await home.text(), /Internal Server Error|Unhandled Runtime Error|request_unavailable/i);

  const site = await fetch(new URL('/api/site', base), { redirect: 'manual' });
  assert.equal(site.status, 200);
  const snapshot = await site.json();
  assert.equal(snapshot.published, false, 'fresh D1 has no public business data');
  assert.deepEqual(snapshot.offerings, []);
  assert.ok(snapshot.modules && typeof snapshot.modules === 'object');
  for (const [module, ready] of Object.entries(snapshot.modules)) {
    assert.equal(ready, false, `${module} remains unready without owner configuration or provider credentials`);
  }

  const visited = new Set();
  let current = new URL('/setup/business', base);
  let completed = false;
  for (let redirects = 0; redirects <= 5; redirects++) {
    assert.equal(visited.has(current.href), false, 'setup authentication must not redirect in a loop');
    visited.add(current.href);
    const setup = await fetch(current, { redirect: 'manual' });
    assert.ok(setup.status < 500, 'setup returns a page or intentional login response without credentials');
    const location = setup.headers.get('location');
    if (setup.status < 300 || setup.status >= 400 || !location) { completed = true; break; }
    const next = new URL(location, current);
    assert.equal(next.origin, new URL(base).origin, 'an unauthenticated setup redirect stays same-origin');
    current = next;
  }
  assert.equal(completed, true, 'setup authentication settles within five same-origin redirects');
});
