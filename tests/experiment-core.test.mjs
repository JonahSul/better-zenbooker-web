import test from 'node:test';
import assert from 'node:assert/strict';
import { compositionDefinition, selectedCompositions, allocate, unbiasedBasisPoint, HARD_RULES, sections } from '../lib/experiment-core.ts';

const split = [
  { label: 'control', allocation: 5000, definition: {} },
  { label: 'A', allocation: 5000, definition: { headline: 'Prepare your demo system for fall' } },
];

test('composition schema accepts only the bounded content and layout fields', () => {
  const valid = {
    headline: 'Prepare your demo system for fall',
    cta: 'Request your preferred date',
    process: [
      { title: 'Choose a date', text: 'Send the date that works best for your request.' },
      { title: 'Review the request', text: 'The business can follow up outside this private demo.' },
      { title: 'Plan the work', text: 'Confirm service details directly with the business.' },
    ],
    processLayout: 'steps',
    order: ['hero', 'services', 'coverage', 'process', 'reviews', 'request', 'questions'],
  };
  assert.deepEqual(compositionDefinition.parse(valid), valid);
  assert.throws(() => compositionDefinition.parse({ ...valid, newService: 'lawn mowing' }));
  assert.throws(() => compositionDefinition.parse({ ...valid, process: valid.process.slice(0, 2) }));
  assert.throws(() => compositionDefinition.parse({ ...valid, order: [...sections].reverse() }));
  assert.throws(() => compositionDefinition.parse({ ...valid, order: ['hero', ...sections.slice(1, 6), 'hero'] }));
});

test('copy restrictions reject markup, personal contact, offers and unsupported claims', () => {
  for (const headline of [
    '<img src=x>', 'https://example.com', 'owner@example.com', 'Call 406-861-7757',
    'Free demo service', 'Certified demo experts', 'Guaranteed winter protection',
    'Save $50 today',
  ]) {
    assert.throws(() => compositionDefinition.parse({ headline }), headline);
  }
  assert.throws(() => compositionDefinition.parse({ headline: 'x' }));
  assert.throws(() => compositionDefinition.parse({ headline: 'x'.repeat(141) }));
});

test('selected compositions preserve a positive empty control, unique labels and exact basis-point totals', () => {
  assert.deepEqual(selectedCompositions.parse(split), split);
  assert.throws(() => selectedCompositions.parse([{ label: 'A', allocation: 10000, definition: {} }]));
  assert.throws(() => selectedCompositions.parse([{ label: 'control', allocation: 10000, definition: { headline: 'Changed control text' } }]));
  assert.throws(() => selectedCompositions.parse([
    { label: 'control', allocation: 5000, definition: {} },
    { label: 'A', allocation: 5000, definition: {} },
    { label: 'A', allocation: 0, definition: {} },
  ]));
  assert.throws(() => selectedCompositions.parse([
    { label: 'control', allocation: 4999, definition: {} },
    { label: 'A', allocation: 5000, definition: {} },
  ]));
  assert.throws(() => selectedCompositions.parse([
    { label: 'control', allocation: 0, definition: {} },
    { label: 'A', allocation: 10000, definition: {} },
  ]));
});

test('allocation maps exact boundaries without trusting caller composition IDs', () => {
  const rows = [{ label: 'control', allocation: 2500 }, { label: 'A', allocation: 7500 }];
  assert.equal(allocate(rows, 0), rows[0]);
  assert.equal(allocate(rows, 2499), rows[0]);
  assert.equal(allocate(rows, 2500), rows[1]);
  assert.equal(allocate(rows, 9999), rows[1]);
  for (const point of [-1, 10000, 0.5]) assert.throws(() => allocate(rows, point));
  assert.throws(() => allocate([{ label: 'control', allocation: 9999 }], 0));
  assert.throws(() => allocate([{ label: 'control', allocation: -1 }, { label: 'A', allocation: 10001 }], 0));
});

test('basis-point selection rejects modulo-biased tail values before reducing', () => {
  const bound = Math.floor(0x100000000 / 10000) * 10000;
  const samples = [bound, 0xFFFFFFFF, bound - 1];
  const selected = unbiasedBasisPoint(() => samples.shift());
  assert.equal(selected, 9999);
  assert.deepEqual(HARD_RULES, {
    version: 'brand-v3-facts-v1', brandLocked: true, contactLocked: true,
    metadataLocked: true, privateDemo: true,
    primaryMetric: 'saved_preferred_date_request', trafficStage: 'demo',
  });
});
