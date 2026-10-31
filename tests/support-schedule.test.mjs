import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const source = await readFile(path.join(root, 'lib/support-schedule.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)((specifier) => {
  if (specifier === 'zod/v3') return require(specifier);
  throw new Error(`Unexpected support-schedule import: ${specifier}`);
}, loaded, loaded.exports);
const schedule = loaded.exports;

const validObservation = {
  revision: 0,
  taskId: 'fixture_automation_01',
  taskUrl: null,
  cadence: 'Daily at 03:30',
  timeZone: 'America/Denver',
  nativeStatus: 'enabled',
  observedAt: '2026-10-29T13:30:00.000Z',
};

test('schedule configuration schema accepts an operator-entered record without requiring a URL', () => {
  assert.equal(schedule.SCHEDULE_SUBJECT, 'system:visitor-support');
  assert.equal(schedule.SCHEDULE_KEY, 'standalone_schedule_configuration');
  assert.deepEqual(schedule.scheduleObservationInput.parse(validObservation), validObservation);
});

test('schedule observation rejects unsafe URLs, invalid zones/statuses, malformed IDs, and invented fields', () => {
  for (const taskUrl of [
    'http://tasks.example.invalid/task/1',
    'https://user:pass@tasks.example.invalid/task/1',
    'https://tasks.example.invalid/task/1?token=secret',
    'https://tasks.example.invalid/task/1#fragment',
    'not-a-url',
  ]) assert.equal(schedule.scheduleObservationInput.safeParse({ ...validObservation, taskUrl }).success, false);

  for (const taskId of ['', 'task/id', ' task ', 'x'.repeat(201)]) {
    assert.equal(schedule.scheduleObservationInput.safeParse({ ...validObservation, taskId }).success, false);
  }
  assert.equal(schedule.scheduleObservationInput.safeParse({ ...validObservation, nativeStatus: 'scheduled' }).success, false);
  assert.equal(schedule.scheduleObservationInput.safeParse({ ...validObservation, timeZone: 'Mars/Olympus' }).success, false);
  assert.equal(schedule.scheduleObservationInput.safeParse({ ...validObservation, observedAt: 'not-a-date' }).success, false);
  assert.equal(schedule.scheduleObservationInput.safeParse({ ...validObservation, scheduleCreated: true }).success, false);
  assert.equal(schedule.scheduleObservationInput.safeParse({ ...validObservation, source: 'native' }).success, false);
});
