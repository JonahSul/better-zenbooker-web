import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const React = require('react');
const serviceOfferingsSource = await readFile(path.join(root, 'lib/service-offerings.ts'), 'utf8');
const serviceOfferingsCompiled = ts.transpileModule(serviceOfferingsSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const serviceOfferingsLoaded = { exports: {} };
new Function('require', 'module', 'exports', serviceOfferingsCompiled)((specifier) => {
  if (specifier === 'zod/v3') return require('zod/v3');
  if (specifier === './admin-auth-core') return { sha256: async () => 'fixture-hash' };
  throw new Error(`Unexpected service-offerings import: ${specifier}`);
}, serviceOfferingsLoaded, serviceOfferingsLoaded.exports);
const { offeringEntrySchema } = serviceOfferingsLoaded.exports;
const source = await readFile(path.join(root, 'components/offering-tiles.tsx'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)((specifier) => {
  if (specifier === 'react') return React;
  if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime');
  if (specifier === 'zod/v3') return require('zod/v3');
  if (specifier === '../lib/service-offerings') return { offeringEntrySchema };
  throw new Error(`Unexpected offering-tiles import: ${specifier}`);
}, loaded, loaded.exports);
const OfferingTiles = loaded.exports.default;
const { parsePublicOfferings } = loaded.exports;

function findButtons(node, output = []) {
  if (Array.isArray(node)) { for (const item of node) findButtons(item, output); return output; }
  if (!node || typeof node !== 'object' || !node.props) return output;
  if (node.type === 'button') output.push(node);
  findButtons(node.props.children, output);
  return output;
}

const offeringId = '4d2dc7c8-5a8f-4a8b-8cdf-b6c5d0b0df10';

test('missing, expired or malformed public offerings render no app selector', () => {
  assert.equal(OfferingTiles({ current: { revision: 0, expiresAt: null, offerings: [] }, onSelect() {} }), null);
  const expired = parsePublicOfferings({ revision: 2, expiresAt: Date.now() - 1, offerings: [{ offeringId, name: 'Stale', providerServiceId: null, providerIdVerified: false }] }, Date.now());
  assert.equal(OfferingTiles({ current: expired, onSelect() {} }), null, 'the active-data parser rejects expired snapshots before presentation');
  const malformed = parsePublicOfferings({ revision: 3, expiresAt: Date.now() + 60_000, offerings: [{ offeringId, name: 'Invalid', providerServiceId: null, providerIdVerified: 'false' }] }, Date.now());
  assert.deepEqual(malformed.offerings, [], 'strict source validation fails closed on malformed offering fields');
  assert.equal(OfferingTiles({ current: { revision: 2, expiresAt: Date.now() + 60_000, offerings: [] }, onSelect() {} }), null);
});

test('published offerings choose only the current app offering ID and revision', () => {
  const selections = [];
  const current = { revision: 12, expiresAt: Date.now() + 60_000, offerings: [
    { offeringId, name: 'Owner-reviewed service', providerServiceId: null, providerIdVerified: false },
  ] };
  const tree = OfferingTiles({ current, onSelect: value => selections.push(value) });
  const html = require('react-dom/server').renderToStaticMarkup(React.createElement(() => tree));
  assert.match(html, /Owner-reviewed service/);
  assert.doesNotMatch(html, /\$|availability|available times|providerServiceId|widget\.zenbooker/);
  const buttons = findButtons(tree);
  assert.equal(buttons.length, 1);
  buttons[0].props.onClick();
  assert.deepEqual(selections, [{ offeringId, offeringsRevision: 12 }]);
});
