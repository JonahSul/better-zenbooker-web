import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const React = require('react');
const source = relativePath => readFile(path.join(root, relativePath), 'utf8');

async function loadDialog(reactHooks) {
  const component = await source('components/account-preferences-dialog.tsx');
  const compiled = ts.transpileModule(component, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((specifier) => {
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime');
    if (specifier === 'react') return reactHooks;
    if (specifier === './account-preferences.css') return {};
    if (specifier === '../hooks/use-published-service-choices') return { usePublishedServiceChoices: () => [['maintenance', 'Maintenance'], ['fall_blowout', 'Fall Blowout']] };
    if (specifier === './ui/dialog') {
      const slot = tag => ({ children, ...props }) => React.createElement(tag, props, children);
      return {
        Dialog: ({ children }) => React.createElement(React.Fragment, null, children),
        DialogContent: slot('div'),
        DialogHeader: slot('header'),
        DialogTitle: slot('h2'),
        DialogDescription: slot('p'),
      };
    }
    if (specifier === '../lib/account-controller') return { accountController: { snapshot: () => ({ customer: { authenticated: true } }), subscribe: () => () => {} } };
    if (specifier === '../lib/customer-visit-client') return { clearCurrentVisit: () => {} };
    if (specifier === '../lib/booking-continuity') return { clearBookingContinuity: () => {} };
    throw new Error(`Unexpected dialog import: ${specifier}`);
  }, loaded, loaded.exports);
  return loaded.exports.default;
}

const data = {
  exists: true,
  revision: 3,
  preferences: { remember: true, answerLength: 'short', serviceInterests: ['maintenance', 'fall_blowout'] },
  expiresAt: 1793500000000,
};

async function renderDialog({ value = data, message = '', busy = false, history = null } = {}) {
  let stateIndex = 0;
  const stateValues = [value, message, busy, history];
  const react = {
    useState: () => [stateValues[stateIndex++], () => {}],
    useRef: initial => ({ current: initial }),
    useEffect: () => {},
  };
  const DialogComponent = await loadDialog(react);
  const tree = DialogComponent({ onClose() {}, portalContainer: null });
  return require('react-dom/server').renderToStaticMarkup(tree);
}

test('preferences dialog preserves controls, disclosure, busy/loading and export/forget affordances', async () => {
  const html = await renderDialog({ busy: true });
  assert.match(html, /class="account-preferences"/);
  assert.match(html, /Your saved preferences/);
  assert.match(html, /separate from analytics consent and your bookings/);
  assert.match(html, /Answer length/);
  assert.match(html, /Topics I’m interested in/);
  assert.match(html, /Remember my preferences and future app activity for up to 30 days/);
  assert.match(html, /Save preferences/);
  assert.match(html, /<details[\s\S]*?<summary>Forget saved account information<\/summary>/);
  assert.match(html, /View saved app activity/);
  assert.match(html, /Download my information/);
  assert.match(html, /disabled=""[^>]*>Save preferences|<button[^>]*disabled=""[^>]*>Save preferences/);
  assert.match(html, /role="status" aria-live="polite"/);

  const loading = await renderDialog({ value: null, message: 'Your saved preferences are unavailable.' });
  assert.match(loading, /Loading your preferences/);
  assert.match(loading, /Your saved preferences are unavailable\./);
  assert.match(loading, /Forget saved account information[\s\S]*?<button[^>]*disabled=""/);
});

test('activity uses a semantic Event/Date table, keeps row values as text, and shows empty history', async () => {
  const html = await renderDialog({ history: [
    { event: 'service_selected', createdAt: 1793406215000 },
    { event: 'help_thread_started', createdAt: 1793406216000 },
  ] });
  assert.match(html, /class="account-preferences-activity"[^>]*role="region"/);
  assert.match(html, /aria-label="Saved app activity"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /<table>/);
  assert.match(html, /<caption>Saved app activity<\/caption>/);
  assert.match(html, /<th scope="col">Event<\/th>/);
  assert.match(html, /<th scope="col">Date<\/th>/);
  assert.match(html, /Service selected/);
  assert.match(html, /Help conversation started/);
  assert.match(html, /<time dateTime="[^"]+"/i);

  const empty = await renderDialog({ history: [] });
  assert.match(empty, /No saved app activity\./);
});

test('preferences styling stays local to the dialog and keeps checkbox, topic, reminder, and action targets usable', async () => {
  const [dialog, css, oldCss, menu] = await Promise.all([
    source('components/account-preferences-dialog.tsx'),
    source('components/account-preferences.css'),
    source('components/account-menu.css'),
    source('components/account-menu.tsx'),
  ]);
  assert.match(dialog, /import ['"]\.\/account-preferences\.css['"]/);
  assert.match(dialog, /className="account-preferences-option"/);
  assert.match(dialog, /className="account-preferences-topics"/);
  assert.match(dialog, /className="account-preferences-remember"/);
  assert.match(dialog, /className="account-preferences-primary"/);
  assert.match(dialog, /className="account-preferences-actions"/);
  assert.match(dialog, /className="account-preferences-activity"/);
  assert.match(css, /\.account-preferences-option input\[type=["']checkbox["']\]/);
  const checkboxRule = css.match(/\.account-preferences-option input\[type=["']checkbox["']\]\s*\{([^}]*)\}/)?.[1] ?? '';
  for (const declaration of [/(?:inline-size|width):\s*1\.1rem/, /(?:block-size|height):\s*1\.1rem/, /flex:\s*none/, /margin:\s*0/, /padding:\s*0/]) assert.match(checkboxRule, declaration);
  assert.match(css, /\.account-preferences-topics\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.account-preferences-remember\s*\{[^}]*align-items:\s*flex-start/);
  assert.match(css, /\.account-preferences-option[^}]*min-block-size:\s*44px|\.account-preferences-option[^}]*min-height:\s*44px/);
  assert.match(css, /\.account-preferences-primary\s*\{[^}]*(?:min-height|min-block-size):\s*44px/);
  assert.match(css, /\.account-preferences-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.doesNotMatch(css, /\.account-menu|(^|\})\s*(?:button|label|input|fieldset)\s*\{/);
  assert.doesNotMatch(css, /dialog-close|sb-dialog-close/);
  assert.doesNotMatch(oldCss, /\.account-preferences/);
  for (const selector of ['.account-menu {', '.account-menu-trigger {', '.account-menu-content {', '.account-menu-status {']) assert.ok(oldCss.includes(selector), `${selector} remains in account-menu.css`);
  assert.match(menu, /Your account/);
  assert.match(menu, /Book a service/);
  assert.match(menu, /Preferences and saved activity/);
});

test('existing save, view, download, Forget, revision, and modal lifecycle handlers remain wired', async () => {
  const dialog = await source('components/account-preferences-dialog.tsx');
  assert.match(dialog, /onOpenChange=\{open=>\{if\(!open\)onClose\(\);\}\}/);
  assert.match(dialog, /container=\{portalContainer\}/);
  assert.match(dialog, /async function change\(/);
  assert.match(dialog, /expectedRevision:data\.revision/);
  assert.match(dialog, /requestKey:crypto\.randomUUID\(\)/);
  assert.match(dialog, /async function exportData\(download:boolean\)/);
  assert.match(dialog, /fetch\('\/api\/customer\/account\/export'/);
  assert.match(dialog, /URL\.createObjectURL/);
  assert.match(dialog, /URL\.revokeObjectURL/);
  assert.match(dialog, /async function forget\(/);
  assert.match(dialog, /fetch\('\/api\/customer\/account',{method:'DELETE'/);
  assert.match(dialog, /clearBookingContinuity\(sessionStorage\)/);
  assert.match(dialog, /locked\.current\)return/);
});
