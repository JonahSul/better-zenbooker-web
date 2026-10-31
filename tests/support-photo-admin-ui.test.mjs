import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../components/support-admin.tsx', import.meta.url), 'utf8');

test('photo diagnostics distinguish confirmed from unconfirmed and require an explicit fresh key for a new attempt', () => {
  assert.match(source, /photoDiagnosticKey\.current\?\?=crypto\.randomUUID\(\)/, 'inspection reuses the same request key');
  assert.match(source, /if\(value\.status==='verified'\)setMessage\('Photo processing verified\./);
  assert.match(source, /else if\(value\.status==='unconfirmed'\)setMessage\(\(value\.stage==='images'\?'Photo check failed during image processing\./);
  assert.match(source, /Existing photo settings are unchanged\./);
  assert.match(source, /Photo help remains disabled\./);
  assert.match(source, /disabled=\{busy\|\|!\['verified','unconfirmed'\]\.includes\(photoDiagnosticStatus\?\?''\)\}/);
  assert.match(source, /photoDiagnosticKey\.current=crypto\.randomUUID\(\);setPhotoDiagnosticStatus\(null\);setMessage\('A new photo diagnostic is prepared\. Run it explicitly when ready; no model call has been made\.'/);
  assert.doesNotMatch(source, /setPhotoDiagnosticStatus\('verified'\)/, 'a new request does not inherit the prior successful result');
});
