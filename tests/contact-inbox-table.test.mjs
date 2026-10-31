import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const longMessage = `${'Water pressure is low. '.repeat(30)}<img src=x onerror=run>PRIVATE_TAIL_SENTINEL`;
const row = (overrides = {}) => ({
  id: 'e7000000-0000-4000-8000-000000000001', revision: 7,
  name: 'Ari Example', email: 'ari@example.invalid', message: longMessage,
  status: 'new', createdAt: 1_793_406_000_000, expiresAt: 1_793_500_000_000,
  ...overrides,
});

async function loadInbox(rows = [row()], { message = '', busy = false } = {}) {
  const source = await readFile(path.join(root, 'components/contact-inbox.tsx'), 'utf8');
  const result = await build({
    stdin: { contents: source, resolveDir: root, sourcefile: 'components/contact-inbox.tsx', loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
    external: ['react', 'react/jsx-runtime'],
  });
  const states = [rows, message, busy];
  let stateIndex = 0;
  const react = {
    ...React,
    useState(initial) {
      const index = stateIndex++;
      return [states[index] ?? initial, next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useEffect() {},
  };
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)((specifier) => {
    if (specifier === 'react') return react;
    if (specifier === 'react/jsx-runtime') return require(specifier);
    throw new Error(`Unexpected ContactInbox import: ${specifier}`);
  }, loaded, loaded.exports);
  const component = loaded.exports.default;
  const tree = component();
  return { component, tree, html: renderToStaticMarkup(tree) };
}

function textContent(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  return textContent(node.props?.children);
}

function elements(node, output = []) {
  if (Array.isArray(node)) { for (const child of node) elements(child, output); return output; }
  if (!node || typeof node !== 'object' || !node.props) return output;
  output.push(node);
  elements(node.props.children, output);
  return output;
}

test('Contact inbox renders a semantic, keyboard-scrollable table and bounded escaped disclosure', async () => {
  const { html } = await loadInbox([row()]);
  assert.match(html, /<div class="table-scroll" role="region" aria-label="Contact message list" tabindex="0">/);
  assert.match(html, /<table><caption>Messages received through Contact<\/caption><thead><tr>/);
  for (const heading of ['Sender', 'Date', 'Message', 'Status', 'Actions']) {
    assert.match(html, new RegExp(`<th scope="col">${heading}<\\/th>`));
  }
  assert.match(html, /<time dateTime="/i);
  assert.match(html, /href="mailto:ari@example\.invalid"/);
  const summary = html.match(/<summary>([^<]*)<\/summary>/)?.[1] ?? '';
  assert.ok(summary.includes('Water pressure is low.'), 'preview begins with the received message text');
  assert.ok(!summary.includes('PRIVATE_TAIL_SENTINEL'), 'preview omits text beyond its bound');
  assert.ok(summary.length <= 121, 'preview is at most 120 collapsed characters plus one ellipsis');
  assert.ok(html.includes('&lt;img src=x onerror=run&gt;PRIVATE_TAIL_SENTINEL'), 'full message remains escaped React text');
  assert.ok(!html.includes('<img src=x onerror=run>'), 'untrusted message is never rendered as markup');
  assert.doesNotMatch(html, /<article\b/, 'messages are not transformed into cards');
});

test('Contact inbox preserves loading, empty, error, busy, and existing action states', async () => {
  const loading = await loadInbox([], { message: 'Loading contact messages…' });
  const empty = await loadInbox([], { message: 'No contact messages yet.' });
  const failed = await loadInbox([], { message: 'Contact messages are unavailable.' });
  const busy = await loadInbox([row()], { busy: true });
  assert.match(loading.html, /Loading contact messages/);
  assert.match(empty.html, /No contact messages yet\./);
  assert.match(failed.html, /Contact messages are unavailable\./);
  for (const label of ['Mark read', 'Archive', 'Delete message']) {
    const button = elements(busy.tree).find(node => node.type === 'button' && textContent(node).includes(label));
    assert.ok(button?.props.disabled, `${label} remains disabled while an action is busy`);
  }
});

test('Mark read and Archive keep their exact existing ID/revision status payloads', async t => {
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const fetchCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    fetchCalls.push({ url, init });
    return String(url).endsWith('/status')
      ? Response.json({ id: row().id, revision: 8, status: 'read', auditId: 'fixture-audit' })
      : Response.json({ messages: [row({ revision: 8, status: 'read' })] });
  };
  t.after(() => {
    if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
    else delete globalThis.fetch;
  });

  for (const [label, status] of [['Mark read', 'read'], ['Archive', 'archived']]) {
    fetchCalls.length = 0;
    const { tree } = await loadInbox([row()]);
    const button = elements(tree).find(node => node.type === 'button' && textContent(node).includes(label));
    assert.ok(button, `${label} control is present`);
    await button.props.onClick();
    assert.equal(fetchCalls[0].url, '/api/admin/contact/messages/status');
    assert.equal(fetchCalls[0].init.cache, 'no-store');
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { id: row().id, expectedRevision: 7, status });
    assert.equal(fetchCalls[1].url, '/api/admin/contact/messages');
    assert.equal(fetchCalls[1].init.cache, 'no-store');
  }
});

test('Delete retains its confirmation and sends only the existing ID/revision request after approval', async t => {
  const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let approved = false;
  const calls = [];
  globalThis.window = { confirm: () => approved };
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    return String(url).endsWith('/delete')
      ? Response.json({ id: row().id, revision: 8, auditId: 'fixture-audit' })
      : Response.json({ messages: [] });
  };
  t.after(() => {
    if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
    else delete globalThis.fetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete globalThis.window;
  });

  const { tree } = await loadInbox([row()]);
  const button = elements(tree).find(node => node.type === 'button' && textContent(node).includes('Delete message'));
  await button.props.onClick();
  assert.equal(calls.length, 0, 'declining the confirmation makes no request');
  approved = true;
  await button.props.onClick();
  assert.equal(calls[0].url, '/api/admin/contact/messages/delete');
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: row().id, expectedRevision: 7 });
  assert.equal(calls[1].url, '/api/admin/contact/messages');
});

test('expanding a message has no read/status side effect', async () => {
  const source = await readFile(path.join(root, 'components/contact-inbox.tsx'), 'utf8');
  assert.doesNotMatch(source, /onToggle|onExpand|markRead\(/i);
  assert.match(source, /<details[\s\S]*?<summary>/);
});
