import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const React = require('react');
const controllerSource = await readFile(path.join(root, 'lib/account-controller.ts'), 'utf8');
const controllerCompiled = ts.transpileModule(controllerSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const controllerLoaded = { exports: {} };
new Function('require', 'module', 'exports', controllerCompiled)((specifier) => {
  throw new Error(`Unexpected account-controller import: ${specifier}`);
}, controllerLoaded, controllerLoaded.exports);
const componentSource = await readFile(path.join(root, 'components/account-menu.tsx'), 'utf8');
const compiled = ts.transpileModule(componentSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

const marker = (name, tag = 'span', asChild = false) => function MenuPrimitive(props) {
  if (asChild && props.asChild) return props.children;
  const { asChild: _asChild, sideOffset: _sideOffset, collisionPadding: _collisionPadding, align: _align, ...safeProps } = props;
  return React.createElement(tag, safeProps, props.children);
};
const dropdown = {
  DropdownMenu: marker('DropdownMenu', 'div'),
  DropdownMenuTrigger: marker('DropdownMenuTrigger', 'div', true),
  DropdownMenuContent: marker('DropdownMenuContent', 'div'),
  DropdownMenuLabel: marker('DropdownMenuLabel', 'div'),
  DropdownMenuSeparator: marker('DropdownMenuSeparator', 'hr'),
  DropdownMenuItem: marker('DropdownMenuItem', 'button', true),
};
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)((specifier) => {
  if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime');
  if (specifier === 'lucide-react') return new Proxy({}, { get: (_target, name) => marker(String(name), 'span') });
  if (specifier === './ui/dropdown-menu') return dropdown;
  if (specifier === '../lib/account-controller') return controllerLoaded.exports;
  if (specifier === './account-menu.css') return {};
  throw new Error(`Unexpected account-menu import: ${specifier}`);
}, loaded, loaded.exports);
const AccountMenu = loaded.exports.default;

function descendants(node, output = []) {
  if (Array.isArray(node)) { for (const child of node) descendants(child, output); return output; }
  if (!node || typeof node !== 'object' || !node.props) return output;
  output.push(node);
  descendants(node.props.children, output);
  return output;
}

test('generic SSR presents guest booking without an Admin link or identity data', () => {
  const html = require('react-dom/server').renderToStaticMarkup(React.createElement(AccountMenu));
  assert.match(html, /Open account menu/);
  assert.match(html, /Book a service/);
  assert.doesNotMatch(html, /href="\/admin"|Open administration|Administration/);
  assert.doesNotMatch(html, /fixture@example\.test|customer@gmail\.com|owner@example\.test|google-subject/);
});

test('a generic customer menu can expose Admin recovery only from server-confirmed eligibility', () => {
  const base = {
    customer: { configured: true, authenticated: true, profile: { name: 'Fixture', email: 'eligible@example.test' }, expiresAt: 20_000, prefillPending: false, prefillReturnTo: null, adminEligible: true },
    admin: { configured: true, authenticated: false, email: null, expiresAt: null },
    customerRead: { availability: 'ready', httpStatus: 200, reason: null },
    adminRead: { availability: 'ready', httpStatus: 401, reason: 'native_session_required', nativeSignInPath: '/signin-with-chatgpt?return_to=%2Fadmin' },
    loading: false,
  };
  const eligible = require('react-dom/server').renderToStaticMarkup(React.createElement(AccountMenu, { snapshot: base }));
  assert.match(eligible, /href="\/signin-with-chatgpt\?return_to=%2Fadmin"[^>]*target="_top"|target="_top"[^>]*href="\/signin-with-chatgpt\?return_to=%2Fadmin"/);
  assert.match(eligible, /eligible@example\.test/, 'verified profile appears only in the hydrated customer menu');

  const ineligible = require('react-dom/server').renderToStaticMarkup(React.createElement(AccountMenu, {
    snapshot: { ...base, customer: { ...base.customer, adminEligible: false } },
  }));
  assert.doesNotMatch(ineligible, /href="\/admin"|href="\/signin-with-chatgpt\?return_to=%2Fadmin"/);
});

test('a configured guest sees business account sign-in and guest booking as separate choices', () => {
  const html = require('react-dom/server').renderToStaticMarkup(React.createElement(AccountMenu, {
    snapshot: {
      customer: { configured: true, authenticated: false, adminEligible: false, profile: null, expiresAt: null, prefillPending: false, prefillReturnTo: null },
      admin: { configured: false, authenticated: false, email: null, expiresAt: null },
      customerRead: { availability: 'ready', httpStatus: 200, reason: null },
      adminRead: { availability: 'ready', httpStatus: 200, reason: null, nativeSignInPath: null },
      loading: false,
    },
    actions: { signInAccount: () => {}, useGoogleDetails: () => {} },
  }));
  assert.match(html, /class="account-menu-google"[^>]*><span>Business<\/span>/);
  assert.match(html, /Book a service/);
  assert.doesNotMatch(html, /href="\/admin"|Open administration/);
});

test('explicit native Admin entry preserves a direct Google sign-in action without adding public Admin navigation', () => {
  let calls = 0;
  const directSignIn = () => calls++;
  const guestSnapshot = {
    customer: { configured: true, authenticated: false, adminEligible: false, profile: null, expiresAt: null, prefillPending: false, prefillReturnTo: null },
    admin: { configured: true, authenticated: false, email: null, expiresAt: null },
    customerRead: { availability: 'ready', httpStatus: 200, reason: null },
    adminRead: { availability: 'ready', httpStatus: 401, reason: 'authentication_required', nativeSignInPath: null },
    loading: false,
  };
  const direct = AccountMenu({
    snapshot: guestSnapshot,
    explicitAdminEntry: true,
    actions: { adminSignIn: directSignIn },
  });
  const directItem = descendants(direct).find(node => node.type === dropdown.DropdownMenuItem && node.props.onSelect === directSignIn);
  assert.ok(directItem, 'the direct Admin route must retain its Google sign-in callback');
  directItem.props.onSelect();
  assert.equal(calls, 1);

  const generic = require('react-dom/server').renderToStaticMarkup(React.createElement(AccountMenu, { snapshot: guestSnapshot }));
  assert.doesNotMatch(generic, /href="\/admin"|Sign in to administration|Open administration/,
    'direct Admin entry is opt-in to that native route and never appears in public guest menus');
});

test('opening the menu is observational; explicit customer and Admin selections invoke only their own callbacks', () => {
  const calls = { open: 0, use: 0, apply: 0, clear: 0, customerLogout: 0, adminSignIn: 0, adminLogout: 0 };
  const snapshot = {
    customer: { configured: true, authenticated: true, adminEligible: false, profile: { name: 'Fixture', email: 'fixture@example.test' }, expiresAt: 20_000, prefillPending: false, prefillReturnTo: null },
    admin: { configured: true, authenticated: true, email: 'owner@example.test', expiresAt: 20_000 },
    customerRead: { availability: 'ready', httpStatus: 200, reason: null },
    adminRead: { availability: 'ready', httpStatus: 200, reason: null, nativeSignInPath: null },
    loading: false,
  };
  const actions = {
    useGoogleDetails: () => calls.use++, applyBookingDetails: () => calls.apply++, clearBookingDetails: () => calls.clear++,
    logoutCustomer: () => calls.customerLogout++, adminSignIn: () => calls.adminSignIn++, logoutAdmin: () => calls.adminLogout++,
  };
  const tree = AccountMenu({ snapshot, actions, onOpenChange: () => calls.open++ });
  const nodes = descendants(tree);
  const menu = nodes.find(node => node.type === dropdown.DropdownMenu);
  assert.ok(menu);
  menu.props.onOpenChange(true);
  assert.deepEqual(calls, { open: 1, use: 0, apply: 0, clear: 0, customerLogout: 0, adminSignIn: 0, adminLogout: 0 });

  const items = nodes.filter(node => node.type === dropdown.DropdownMenuItem && typeof node.props.onSelect === 'function');
  const apply = items.find(node => node.props.onSelect === actions.applyBookingDetails);
  const clear = items.find(node => node.props.onSelect === actions.clearBookingDetails);
  const customerLogout = items.find(node => node.props.onSelect === actions.logoutCustomer);
  const adminLogout = items.find(node => node.props.onSelect === actions.logoutAdmin);
  assert.ok(apply && clear && customerLogout && adminLogout);
  apply.props.onSelect();
  assert.equal(calls.apply, 1);
  assert.equal(calls.adminLogout, 0);
  clear.props.onSelect();
  assert.equal(calls.clear, 1);
  assert.equal(calls.customerLogout, 0);
  customerLogout.props.onSelect();
  assert.equal(calls.customerLogout, 1);
  assert.equal(calls.adminLogout, 0);
  adminLogout.props.onSelect();
  assert.equal(calls.adminLogout, 1);
  assert.equal(calls.customerLogout, 1);
});
