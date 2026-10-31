import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const sourceText = await readFile(path.join(root, 'worker/index.ts'), 'utf8');
const sourceFile = ts.createSourceFile('worker/index.ts', sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const declaration = sourceFile.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'cameraPermissionsPolicy');
assert.ok(declaration, 'worker exposes the production camera policy resolver');
const compiled = ts.transpileModule(declaration.getFullText(sourceFile), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(specifier => {
  throw new Error(`Unexpected camera policy dependency: ${specifier}`);
}, loaded, loaded.exports);
const { cameraPermissionsPolicy } = loaded.exports;

test('only public document routes allow camera, while microphone and geolocation stay denied', () => {
  for (const pathname of ['/', '/book', '/appointments', '/privacy', '/terms', '/contact']) {
    assert.equal(cameraPermissionsPolicy(pathname), 'camera=(self), microphone=(), geolocation=()', pathname);
  }
});

test('admin, API, and non-allowlisted paths deny camera', () => {
  for (const pathname of [
    '/admin', '/admin/bookings', '/setup/credentials', '/api/customer/google/status',
    '/api/support/chat', '/api/support/photos', '/api/contact/config', '/api/contact/messages',
    '/api/admin/contact/messages', '/api/admin/contact/notifications', '/manage', '/book/anything', '/appointments/anything',
  ]) assert.equal(cameraPermissionsPolicy(pathname), 'camera=(), microphone=(), geolocation=()', pathname);
});

test('the response header stays conditional on a public document request and defaults all other paths closed', () => {
  assert.match(sourceText, /cameraPermissionsPolicy\(documentRequest\?new URL\(request\.url\)\.pathname:''\)/);
  assert.match(sourceText, /const documentRequest=\(request\.method==='GET'\|\|request\.method==='HEAD'\)&&response\.headers\.get\('Content-Type'\)\?\.toLowerCase\(\)\.startsWith\('text\/html'\)/);
  assert.match(sourceText, /response\.headers\.set\('Permissions-Policy',cameraPermissionsPolicy\(/);
});
