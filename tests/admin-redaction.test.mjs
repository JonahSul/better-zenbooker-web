import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadRedaction() {
  const source = await readFile(path.join(root, 'lib/admin-redaction.ts'), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const requireMock = (specifier) => {
    if (specifier === './analysis-core') return {
      sanitizeModelText: (value) => value
        .replace(/GOCSPX-[\w-]+|AIza[\w-]+|\bBearer\s+\S+|\bsk-[\w-]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}|\+?\d[\d\s().-]{7,}\d/g, '[redacted]')
        .replace(/\b[a-zA-Z0-9_-]{32,}\b/g, '[redacted]'),
    };
    throw new Error(`Unexpected import in redaction helper: ${specifier}`);
  };
  new Function('require', 'module', 'exports', js)(requireMock, module, module.exports);
  return module.exports;
}

const redaction = await loadRedaction();

test('chat-facing text removes known contact details and secret-like values', () => {
  const contact = 'Jane Doe';
  const value = `Call ${contact} at (555) 010-0182 or write jane@example.com. API token: GOCSPX-very-secret-token`;
  const result = redaction.redactAdminText(value, [contact]);
  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /Jane Doe|406|jane@example\.com|GOCSPX/i);
  assert.match(result.text, /\[redacted\]|\[contact name omitted\]/);
});

test('contact labels and external URLs are omitted from model-facing text', () => {
  const result = redaction.redactAdminText('Name: Jamie Example; contact: jamie@example.com; see https://example.invalid/private?q=secret');
  assert.doesNotMatch(result.text, /Jamie Example|jamie@example\.com|https:\/\/|secret/i);
  assert.match(result.text, /contact details omitted|external link omitted|redacted/i);
});

test('meaningful memory text rejects sensitive-only content and preserves a useful redacted note', () => {
  assert.throws(() => redaction.meaningfulSafeText('jane@example.com', 500), /nonsensitive text/i);
  const value = redaction.meaningfulSafeText('Preferred service window is October 12.', 500);
  assert.equal(value.text, 'Preferred service window is October 12.');
  assert.equal(value.redacted, false);
});
