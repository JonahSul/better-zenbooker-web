import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'lib/account-sign-in-risk.ts'), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)((specifier) => {
  throw new Error(`Unexpected account-sign-in-risk import: ${specifier}`);
}, loaded, loaded.exports);

const { collectSignInRisk, signInNeedsWarning, selectActiveAccountContexts } = loaded.exports;
const clearRisk = Object.freeze({
  bookingFrameMounted: false,
  unrestorableText: false,
  selectedPhoto: false,
  pendingReply: false,
});
const flagged = key => ({ ...clearRisk, [key]: true });

test('empty and successfully restorable live help contexts permit direct sign-in', () => {
  const emptyOpenHelp = { active: true, signInRisk: () => clearRisk };
  const closedHelpWithRestorableDraft = { active: false, signInRisk: () => clearRisk };
  const ownedLiveThreadWithSavedTenMinuteDraft = { active: true, signInRisk: () => clearRisk };

  for (const context of [emptyOpenHelp, closedHelpWithRestorableDraft, ownedLiveThreadWithSavedTenMinuteDraft]) {
    assert.equal(signInNeedsWarning(collectSignInRisk([context])), false);
  }
});

test('each retained loss condition independently requires a warning, including a hidden mounted booking frame', () => {
  for (const key of Object.keys(clearRisk)) {
    assert.equal(signInNeedsWarning(flagged(key)), true, `${key} must warn`);
  }
  const hiddenBackPanel = { active: false, signInRisk: () => flagged('bookingFrameMounted') };
  assert.equal(signInNeedsWarning(collectSignInRisk([hiddenBackPanel])), true);
});

test('risk collection combines retained contexts without allowing an inactive context to change active navigation', () => {
  const oldInactiveSupport = {
    active: false, returnContext: 'support-chat', draft: () => ({ text: 'older text', conversation: null }),
    signInRisk: () => flagged('unrestorableText'),
  };
  const activeBooking = {
    active: true, returnContext: 'book', signInRisk: () => clearRisk,
  };
  const snapshot = { bookings: [activeBooking], supports: [oldInactiveSupport] };

  assert.deepEqual(selectActiveAccountContexts(snapshot), { booking: activeBooking, support: null });
  assert.deepEqual(collectSignInRisk([...snapshot.bookings, ...snapshot.supports]), flagged('unrestorableText'),
    'the inactive context still contributes to loss warning while it is retained');
  assert.equal(signInNeedsWarning(collectSignInRisk([...snapshot.bookings, ...snapshot.supports])), true);
});

test('only the active support route can suppress or pair with an active booking context', () => {
  const booking = { active: true, returnContext: 'support-booking', signInRisk: () => clearRisk };
  const staleSupport = { active: false, returnContext: 'support-chat', signInRisk: () => clearRisk };
  assert.deepEqual(selectActiveAccountContexts({ bookings: [booking], supports: [staleSupport] }), {
    booking, support: null,
  });

  const activeChat = { active: true, returnContext: 'support-chat', signInRisk: () => clearRisk };
  assert.deepEqual(selectActiveAccountContexts({ bookings: [booking], supports: [activeChat] }), {
    booking: null, support: activeChat,
  });

  const activeSupportBooking = { active: true, returnContext: 'support-booking', signInRisk: () => clearRisk };
  assert.deepEqual(selectActiveAccountContexts({ bookings: [booking], supports: [activeSupportBooking] }), {
    booking, support: activeSupportBooking,
  });
});

test('component risk getters retain frame, unsent-text, photo, and pending-reply signals; inactive contexts supply no actions', async () => {
  const [panel, support, menu] = await Promise.all([
    readFile(path.join(root, 'components/hosted-booking-panel.tsx'), 'utf8'),
    readFile(path.join(root, 'components/visitor-support.tsx'), 'utf8'),
    readFile(path.join(root, 'components/connected-account-menu.tsx'), 'utf8'),
  ]);

  assert.match(panel, /signInRisk:\(\)=>\(\{bookingFrameMounted:!!frameUrl,unrestorableText:false,selectedPhoto:false,pendingReply:false\}\)/);
  assert.match(support, /unrestorableText:!!text\.trim\(\)&&\(!open\|\|!isReadySupportThread\(thread\)\),selectedPhoto:!!attachment\|\|uploading\|\|cameraVisible,pendingReply:busy\|\|uncertain/);
  assert.match(menu, /const activeContext=selectActiveAccountContexts\(surface\)/);
  assert.match(menu, /activeContext\.booking\?\{applyBookingDetails/);
  assert.match(menu, /,\{booking,support\}=selectActiveAccountContexts\(current\)/);
  assert.doesNotMatch(menu, /\.find\(context=>!!context\.draft\(\)\.text\|\|signInNeedsWarning/,
    'inactive support contexts may contribute to the warning but cannot replace the active route or continuity action');
  assert.match(menu, /risk=collectSignInRisk\(\[\.\.\.current\.bookings,\.\.\.current\.supports\]\);if\(signInNeedsWarning\(risk\)\)/);
  assert.match(menu, /continuityFailed:true/);
  assert.match(menu, /warning\?\.continuityFailed===true/,
    'acknowledging a save failure continues through the ordinary protected sign-in path');
  assert.doesNotMatch(panel, /\.supports\]\.reverse\(\)\.find/,
    'an active booking cannot borrow or overwrite draft state from an inactive support context');
  assert.match(panel, /accountSurface\.snapshot\(\)\.support\?\.draft\(\)/,
    'booking continuity may use only the active support alias');
});
