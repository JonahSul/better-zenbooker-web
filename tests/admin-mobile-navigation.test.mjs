import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { build } from 'esbuild';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const read = file => readFile(path.join(root, file), 'utf8');
const expectedHrefs = ['/admin', '/admin/inquiries', '/admin/bookings', '/admin/reviews', '/admin/experiments', '/admin/analytics', '/admin/performance', '/admin/analysis', '/admin/support', '/admin/memory', '/admin/chat', '/admin/credentials', '/admin/modules', '/admin/settings', '/admin/audit'];

async function loadComponent(relativePath) {
  const result = await build({
    entryPoints: [path.join(root, relativePath)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['react', 'react/jsx-runtime', 'lucide-react', 'radix-ui'],
    loader: { '.css': 'empty' },
  });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, loaded, loaded.exports);
  return loaded.exports;
}

test('generic owner AdminShell and mobile drawer share the same 15 grouped administration links', async () => {
  const shell = await read('components/admin-shell.tsx');
  assert.doesNotMatch(shell, /^\s*['"]use client['"]/);
  assert.match(shell, /<AdminAccountMenu email=\{email\}\s*\/>/);
  assert.match(shell, /<AdminNavigation\s+section=\{section\}[^>]*className="console-desktop-navigation"/);
  assert.match(shell, /<MobileAdminNavigation\s+section=\{section\}\s*\/>/);
  assert.match(shell, /<a className="console-mobile-brand" href="\/admin"><span>Business<\/span><\/a>/,
    'the small-screen workspace mark uses generic owner branding rather than copied business artwork');
  assert.match(shell, /adminSections\.find\(\(\[p\]\)\s*=>\s*p===section\)/,
    'the existing breadcrumb and section lookup remain available below the logo');
  assert.match(shell, /id="console-main" className="console-main" tabIndex=\{-1\}/);

  const loaded = await loadComponent('components/admin-navigation.tsx');
  assert.equal(typeof loaded.AdminNavigation, 'function');
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const desktop = renderToStaticMarkup(React.createElement(loaded.AdminNavigation, { section: 'analytics', className: 'console-desktop-navigation' }));
  const drawer = renderToStaticMarkup(React.createElement(loaded.AdminNavigation, { section: 'analytics', onNavigate() {} }));
  const hrefs = html => [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(hrefs(desktop), expectedHrefs);
  assert.deepEqual(hrefs(drawer), expectedHrefs);
  assert.equal((desktop.match(/aria-current="page"/g) ?? []).length, 1);
  assert.equal((drawer.match(/aria-current="page"/g) ?? []).length, 1);
  assert.match(desktop, /Operations[\s\S]*Improvement[\s\S]*Knowledge[\s\S]*Workspace/);
  assert.match(drawer, /aria-hidden="true"/);

  let navigated = 0;
  let defaultPrevented = 0;
  const tree = loaded.AdminNavigation({ section: 'analytics', onNavigate: () => navigated++ });
  const anchors = [];
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!React.isValidElement(node)) return;
    if (node.type === 'a') anchors.push(node);
    visit(node.props.children);
  };
  visit(tree);
  const inquiries = anchors.find(anchor => anchor.props.href === '/admin/inquiries');
  assert.ok(inquiries?.props.onClick, 'shared links close the drawer through the real click callback');
  inquiries.props.onClick({ preventDefault() { defaultPrevented++; } });
  assert.equal(navigated, 1);
  assert.equal(defaultPrevented, 0, 'native href navigation remains intact');
});
test('mobile drawer is an accessible controlled Radix dialog with close and desktop-focus restoration wiring', async () => {
  const source = await read('components/mobile-admin-navigation.tsx');
  assert.match(source, /DialogTrigger/);
  assert.match(source, /aria-label="Menu"|>Menu</);
  assert.match(source, /DialogContent/);
  assert.match(source, /<DialogTitle>Administration<\/DialogTitle>/);
  assert.match(source, /onNavigate/);
  assert.match(source, /onCloseAutoFocus/);
  assert.match(source, /preventDefault\(\)/);
  assert.match(source, /matchMedia\(['"]\(min-width: 681px\)['"]\)/);
  assert.match(source, /addEventListener\(['"]change['"]/);
  assert.match(source, /removeEventListener\(['"]change['"]/);
  assert.match(source, /matchMedia/);
  assert.match(source, /console-main/);
  assert.match(source, /console-desktop-navigation/);
  assert.match(source, /focus\(\)/);
  assert.doesNotMatch(source, /fetch\(|\/api\//);
  assert.doesNotMatch(source, /onEscapeKeyDown|onPointerDownOutside|onInteractOutside/,
    'Escape, outside dismissal, and focus trapping remain Radix dialog behavior');
});

test('real mobile component opens through its trigger, closes at desktop, cleans its media listener, and restores focus', async () => {
  const React = require('react');
  const navigation = await loadComponent('components/admin-navigation.tsx');
  const source = await read('components/mobile-admin-navigation.tsx');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const slots = [];
  const effects = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(effect) {
      const index = cursor++;
      if (!effects[index]) effects[index] = effect;
    },
  };
  let rootProps;
  let contentProps;
  const Dialog = props => { rootProps = props; return React.createElement(React.Fragment, null, props.children); };
  const DialogTrigger = ({ children }) => React.cloneElement(children, { onClick: event => {
    children.props.onClick?.(event);
    rootProps.onOpenChange(true);
  } });
  const DialogContent = ({ children, ...props }) => {
    contentProps = props;
    return rootProps.open ? React.createElement('section', { ...props, role: 'dialog' }, children) : null;
  };
  const slot = tag => {
    const TestDialogSlot = ({ children, ...props }) => React.createElement(tag, props, children);
    TestDialogSlot.displayName = `TestDialogSlot(${tag})`;
    return TestDialogSlot;
  };
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((specifier) => {
    if (specifier === 'react') return hooks;
    if (specifier === 'react/jsx-runtime') return require('react/jsx-runtime');
    if (specifier === 'lucide-react') return { Menu: slot('svg') };
    if (specifier === './ui/dialog') return { Dialog, DialogTrigger, DialogContent, DialogHeader: slot('header'), DialogTitle: slot('h2'), DialogDescription: slot('p') };
    if (specifier === './admin-navigation') return navigation;
    if (specifier === './mobile-admin-navigation.css') return {};
    throw new Error(`Unexpected mobile navigation dependency: ${specifier}`);
  }, loaded, loaded.exports);

  const mediaListeners = new Set();
  const media = { matches: false, addEventListener(type, listener) { assert.equal(type, 'change'); mediaListeners.add(listener); }, removeEventListener(type, listener) { assert.equal(type, 'change'); mediaListeners.delete(listener); } };
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = { matchMedia(query) { assert.equal(query, '(min-width: 681px)'); return media; } };
  let activeFocus = 0;
  let mainFocus = 0;
  const active = { isConnected: true, getClientRects: () => [{}], focus: () => activeFocus++ };
  const main = { focus: () => mainFocus++ };
  globalThis.document = { querySelector(selector) { assert.equal(selector, '.console-desktop-navigation [aria-current="page"]'); return active; }, getElementById(id) { assert.equal(id, 'console-main'); return main; } };
  try {
    const render = () => { cursor = 0; return loaded.exports.default({ section: 'analytics' }); };
    const resolve = node => {
      if (Array.isArray(node)) return node.map(resolve);
      if (!React.isValidElement(node)) return node;
      if (typeof node.type === 'function') return resolve(node.type(node.props));
      return React.createElement(node.type, node.props, resolve(node.props.children));
    };
    const find = (node, predicate, result = []) => {
      if (Array.isArray(node)) node.forEach(child => find(child, predicate, result));
      else if (React.isValidElement(node)) {
        if (predicate(node)) result.push(node);
        find(node.props.children, predicate, result);
      }
      return result;
    };
    resolve(render());
    const cleanups = effects.map(effect => effect());
    assert.equal(mediaListeners.size, 1);
    const trigger = find(resolve(render()), node => node.type === 'button' && node.props.className === 'console-mobile-menu')[0];
    assert.ok(trigger, 'the Menu trigger is present in the compact shell');
    trigger.props.onClick({});
    assert.equal(slots[0], true, 'the Radix trigger callback opens controlled state');
    const opened = resolve(render());
    const dialog = find(opened, node => node.props.role === 'dialog')[0];
    assert.ok(dialog);
    assert.equal(slots[0], true);
    const drawerLink = find(opened, node => node.type === 'a' && node.props.href === '/admin/inquiries')[0];
    let navigationPrevented = false;
    drawerLink.props.onClick({ preventDefault() { navigationPrevented = true; } });
    assert.equal(slots[0], false, 'choosing a drawer link closes it');
    assert.equal(navigationPrevented, false, 'choosing a link preserves browser navigation');

    trigger.props.onClick({});
    assert.equal(slots[0], true, 'the Menu trigger can reopen the drawer');

    media.matches = true;
    [...mediaListeners][0]({ matches: true });
    assert.equal(slots[0], false, 'crossing 681px closes the mobile dialog');
    const closed = resolve(render());
    assert.equal(rootProps.open, false);
    assert.equal(find(closed, node => node.props.role === 'dialog').length, 0, 'Radix content unmounts when closed at desktop width');
    const closeEvent = { prevented: false, preventDefault() { this.prevented = true; } };
    contentProps.onCloseAutoFocus(closeEvent);
    assert.equal(closeEvent.prevented, true, 'Radix default focus does not return to a now-hidden trigger');
    assert.equal(activeFocus, 1, 'focus returns to the visible active desktop link');

    active.isConnected = false;
    contentProps.onCloseAutoFocus({ preventDefault() {} });
    assert.equal(mainFocus, 1, 'missing/hidden active link falls back to the focusable main landmark');
    cleanups.forEach(cleanup => cleanup?.());
    assert.equal(mediaListeners.size, 0, 'media listener is removed on unmount');
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
});

test('responsive drawer CSS has bounded viewport geometry and leaves desktop navigation at 681px+', async () => {
  const css = await read('components/mobile-admin-navigation.css');
  const ast = postcss.parse(css);
  const rules = [];
  ast.walkRules(rule => rules.push(rule));
  const drawer = rules.find(rule => rule.selector.includes('.console-mobile-drawer'));
  assert.ok(drawer, 'drawer has an isolated class selector');
  const declarations = Object.fromEntries(drawer.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]));
  assert.equal(declarations.left, '0');
  assert.equal(declarations.transform, 'none');
  assert.equal(declarations.width, 'min(20rem, calc(100vw - 2rem))');
  assert.equal(declarations.height, '100dvh');
  assert.equal(declarations.overflow, 'hidden');
  const nav = rules.find(rule => rule.selector === '.console-mobile-drawer nav');
  assert.ok(nav);
  assert.equal(Object.fromEntries(nav.nodes.filter(node => node.type === 'decl').map(node => [node.prop, node.value]))['overflow-y'], 'auto');
  assert.match(css, /@media\s*\(max-width:\s*680px\)/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /\.admin-account|\.admin-account-trigger/);
  assert.deepEqual([320, 479, 680].map(viewport => Math.min(320, viewport - 32)), [288, 320, 320],
    'the approved min(20rem, calc(100vw - 2rem)) width remains inside narrow viewports');
  assert.equal(681 > 680, true, 'the desktop rule begins immediately after the mobile breakpoint');

  const consoleCss = await read('app/admin/console.css');
  assert.match(consoleCss, /\.console-sidebar\{[^}]*display:flex/);
  const consoleAst = postcss.parse(consoleCss);
  let mobileSidebarHidden = false;
  consoleAst.walkRules(rule => {
    if (rule.selector !== '.console-sidebar' || rule.parent.type !== 'atrule' || !/max-width:\s*680px/.test(rule.parent.params)) return;
    mobileSidebarHidden ||= rule.nodes.some(node => node.type === 'decl' && node.prop === 'display' && node.value === 'none');
  });
  assert.ok(mobileSidebarHidden);
  assert.doesNotMatch(consoleCss, /\.console-sidebar nav\{display:flex;overflow:auto/);
  assert.doesNotMatch(consoleCss, /\.console-sidebar nav a span\{display:none\}/);

  const triggerSelector = '.console .console-top .console-mobile-menu';
  const triggerRules = [];
  ast.walkRules(rule => {
    if (rule.selector.split(',').map(selector => selector.trim()).includes(triggerSelector)) triggerRules.push(rule);
  });
  const hiddenRule = triggerRules.find(rule => rule.nodes.some(node => node.type === 'decl' && node.prop === 'display' && node.value === 'none'));
  const mobileRule = triggerRules.find(rule => rule.parent.type === 'atrule' && /max-width:\s*680px/.test(rule.parent.params)
    && rule.nodes.some(node => node.type === 'decl' && node.prop === 'display' && node.value === 'inline-flex'));
  assert.ok(hiddenRule, 'the Menu trigger is hidden by default, including desktop widths');
  assert.ok(mobileRule, 'the same specificity shows Menu only at mobile widths');
  assert.equal(hiddenRule.parent.type, 'root', 'the Menu stays hidden by default at desktop widths');
  const specificity = selector => [0, (selector.match(/\.[\w-]+|:[\w-]+(?:\([^)]*\))?/g) ?? []).length,
    (selector.match(/(?:^|\s|>)(?:button|a|nav|div)(?=[:.#\s>]|$)/g) ?? []).length];
  const specificityScore = tuple => tuple[0] * 1_000_000 + tuple[1] * 1_000 + tuple[2];
  assert.ok(specificityScore(specificity(triggerSelector)) > specificityScore(specificity('.console button:has(>.lucide)')),
    'default hiding outranks the existing console icon-button display rule even if stylesheet order changes');
  for (const width of [320, 479, 680]) assert.ok(width <= 680, 'Menu is available throughout the mobile range');
  assert.ok(681 > 680, 'Menu remains hidden at the first desktop width');
});
