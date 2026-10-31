import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
if (!globalThis.crypto) globalThis.crypto = webcrypto;

async function loadWorker() {
  const budgetSource = await readFile(path.join(root, 'lib/input-budget.ts'), 'utf8');
  const budgetJs = ts.transpileModule(budgetSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const budget = { exports: {} };
  new Function('require', 'module', 'exports', budgetJs)(() => { throw new Error('Unexpected input-budget import'); }, budget, budget.exports);
  const source = await readFile(path.join(root, 'worker/index.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const loaded = { exports: {} };
  const forwarded = [];
  const modules = {
    '../lib/attribution-core': { clearExposureCookie: () => '__Host-experiment_exposure=; Path=/; Secure; HttpOnly; SameSite=Lax' },
    '../lib/input-budget': budget.exports,
    '../lib/security': { bounded: async (request, limit) => {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > limit) throw new Error('oversized');
      return text;
    } },
    '../lib/standalone-scheduler': { dispatchScheduled: async () => ({ cleanup: 'complete' }) },
    '../lib/hosted-bridge-runtime': { localHostedWebhook: async () => Response.json({}), localHostedBridgeMaintenance: async () => ({ status: 'unavailable' }) },
    '../lib/experiment-runtime': { serveExperimentDocument: async () => new Response('compiled document') },
    '../lib/module-config': {
      moduleStatus: async () => ({ status: 'disabled', config: {} }),
      assertModule: async () => { throw new Error('disabled'); },
      routeModule: (pathname) => pathname.startsWith('/api/booking') ? 'booking' : null,
      routeMaintenance: () => false,
    },
    'cloudflare:workers': { env: {} },
    'vinext/server/fetch-handler': { fetch: async (request) => { forwarded.push(request); return Response.json({ forwarded: true }); } },
    '../lib/admin-auth-core': { cookieValue: (request, name) => request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1) ?? null, randomOpaque: () => 'f'.repeat(64) },
  };
  new Function('require', 'module', 'exports', js)((specifier) => {
    if (Object.hasOwn(modules, specifier)) return modules[specifier];
    throw new Error(`Unexpected Worker dependency: ${specifier}`);
  }, loaded, loaded.exports);
  return { worker: loaded.exports.default, forwarded };
}

const { worker, forwarded } = await loadWorker();

test('session return_to validation contains encoded slash and backslash variants', async () => {
  const hostile = [
    '//evil.example.test', '/\\\\evil.example.test', '/%5c%5cevil.example.test',
    '/%2f%2fevil.example.test', '/%255c%255cevil.example.test', 'https://evil.example.test/path',
  ];
  for (const value of hostile) {
    const response = await worker.fetch(new Request(`https://app.example.test/session/start?return_to=${encodeURIComponent(value)}`), {}, {});
    const location = response.headers.get('location');
    assert.equal(response.status, 303);
    assert.ok(location?.startsWith('/'), `expected local return path for ${value}`);
    assert.equal(new URL(location, 'https://app.example.test').origin, 'https://app.example.test');
    assert.equal(location.includes('\\'), false);
  }
});

test('malformed visitor cookies are replaced once and never forwarded as duplicates', async () => {
  const response = await worker.fetch(new Request('https://app.example.test/', {
    headers: { cookie: '__Host-browser_session=malformed; other=value' },
  }), {}, {});
  const setCookies = response.headers.getSetCookie();
  assert.equal(setCookies.filter(value => value.startsWith('__Host-browser_session=')).length, 1);
  assert.match(setCookies[0], /^__Host-browser_session=[0-9a-f]{64};/);
  assert.equal(forwarded.at(-1).headers.get('cookie').match(/__Host-browser_session=/g)?.length, 1);
  assert.match(forwarded.at(-1).headers.get('cookie'), /other=value/);
});

test('collection depth and fanout are rejected at Worker boundary before route dispatch', async () => {
  forwarded.length = 0;
  let deep = 'leaf';
  for (let i = 0; i < 27; i++) deep = { next: deep };
  const cases = [deep, { values: Array.from({ length: 1025 }, () => 'x') }];
  for (const value of cases) {
    const response = await worker.fetch(new Request('https://app.example.test/api/contact', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
    }), {}, {});
    assert.equal(response.status, 400);
    assert.equal(await response.text(), JSON.stringify({ error: 'invalid_or_excessive_input' }));
  }
  assert.equal(forwarded.length, 0);
});

test('disabled optional booking route is denied before application route dispatch', async () => {
  forwarded.length = 0;
  const response = await worker.fetch(new Request('https://app.example.test/api/booking/status'), {}, {});
  assert.equal(response.status, 503);
  assert.equal(await response.text(), JSON.stringify({ error: 'module_disabled_or_unconfigured' }));
  assert.equal(forwarded.length, 0);
});
