import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
process.env.NEXT_PUBLIC_BUSINESS_TIME_ZONE = 'America/Denver';
const source = await readFile(path.join(root, 'lib/seasonal-scene.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', js)(specifier => {
  throw new Error(`Unexpected seasonal-scene dependency: ${specifier}`);
}, loaded, loaded.exports);
const { denverCalendar, seasonalScene, groundSnowGeometry, SeasonalController, seasonalIntroEligible, claimSeasonalIntro } = loaded.exports;

function flattenScene(scene) {
  return [scene.canopy, scene.autumn, scene.fallenLeaves, scene.springGrowth,
    scene.snow.mountains, scene.snow.roof, scene.snow.evergreens, scene.snow.ground, scene.spray];
}

function createAnimationHarness(now = new Date('2026-10-30T18:00:00.000Z')) {
  let id = 0;
  let timerId = 0;
  let currentTime = new Date(now);
  const frames = new Map();
  const timers = new Map();
  const states = [];
  const controller = new SeasonalController({
    now: () => new Date(currentTime),
    raf: callback => { const next = ++id; frames.set(next, callback); return next; },
    cancelRaf: frameId => frames.delete(frameId),
    setTimer: (callback, delayMs) => { const next = ++timerId; timers.set(next, { callback, delayMs }); return next; },
    clearTimer: id => timers.delete(id),
    onChange: state => states.push(state),
  });
  return {
    controller,
    frames,
    states,
    latest: () => states.at(-1),
    timers,
    setNow(value) { currentTime = new Date(value); },
    fireTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const timer of callbacks) timer.callback();
    },
    step(timestamp) {
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(timestamp);
    },
  };
}

test('Denver calendar follows civil day across spring DST and accounts for leap years', () => {
  const beforeJump = denverCalendar(new Date('2024-03-10T08:30:00.000Z')); // 01:30 MST
  const afterJump = denverCalendar(new Date('2024-03-10T09:30:00.000Z')); // 03:30 MDT
  assert.equal(beforeJump.year, 2024);
  assert.equal(beforeJump.month, 3);
  assert.equal(beforeJump.day, 10);
  assert.equal(beforeJump.daysInYear, 366);
  assert.equal(afterJump.dayOfYear, beforeJump.dayOfYear);
  assert.ok(Math.abs(afterJump.phase - beforeJump.phase - 2 / (24 * 366)) < 1e-10);

  const feb28 = denverCalendar(new Date('2024-02-28T19:00:00.000Z'));
  const mar1 = denverCalendar(new Date('2024-03-01T19:00:00.000Z'));
  assert.equal(mar1.dayOfYear - feb28.dayOfYear, 2);
  assert.equal(mar1.daysInYear, 366);
});

test('Denver phase wraps at local New Year and uses the correct year length', () => {
  const late = denverCalendar(new Date('2026-01-01T06:59:00.000Z')); // Dec 31 23:59 MST
  const early = denverCalendar(new Date('2026-01-01T07:01:00.000Z')); // Jan 1 00:01 MST
  assert.equal(late.year, 2025);
  assert.equal(late.daysInYear, 365);
  assert.equal(early.year, 2026);
  assert.equal(early.dayOfYear, 1);
  assert.ok(late.phase > 0.99);
  assert.ok(early.phase > 0 && early.phase < 0.001);
});

test('season scene scalars stay bounded and the annual cycle is continuous at wraparound', () => {
  const left = flattenScene(seasonalScene(0.0001));
  const right = flattenScene(seasonalScene(0.9999));
  assert.equal(left.length, 9);
  for (const value of [...left, ...right]) {
    assert.equal(typeof value, 'number');
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0 && value <= 1);
  }
  for (let index = 0; index < left.length; index += 1) {
    assert.ok(Math.abs(left[index] - right[index]) < 0.05, `seasonal scalar ${index} should wrap smoothly`);
  }
});

test('leafless late autumn comes before roof and yard snow accumulation', () => {
  const bare = seasonalScene(0.92);
  assert.equal(bare.canopy, 0);
  assert.equal(bare.snow.roof, 0);
  assert.equal(bare.snow.ground, 0);
  assert.equal(bare.snow.evergreens, 0);

  const earlyWinter = seasonalScene(0.95);
  assert.equal(earlyWinter.canopy, 0);
  assert.ok(earlyWinter.snow.roof > 0);
  assert.ok(earlyWinter.snow.ground > 0);
});

test('ground-snow coverage is clipped by construction from none to the full lawn', () => {
  const none = groundSnowGeometry(0);
  assert.equal(none.boundaryY, 640);
  assert.deepEqual(none.patches.map(({ rx, ry }) => [rx, ry]), [[0, 0], [0, 0], [0, 0]]);

  const half = groundSnowGeometry(0.5);
  assert.equal(half.boundaryY, 465);
  assert.equal(half.patches.length, 3);
  assert.deepEqual(half.patches.map(({ cx, cy, rx, ry }) => [cx, cy, rx, ry]), [
    [100, 470, 45, 19], [310, 410, 37.5, 15], [535, 495, 42.5, 17.5],
  ]);

  const full = groundSnowGeometry(1);
  assert.equal(full.boundaryY, 290, 'full coverage reaches above the lawn before clip-path intersection');
  assert.ok(full.patches.every(({ rx, ry }) => rx > 0 && ry > 0));
  assert.equal(groundSnowGeometry(-1).boundaryY, 640);
  assert.equal(groundSnowGeometry(2).boundaryY, full.boundaryY);
  assert.deepEqual(groundSnowGeometry(Number.NaN), none);
});

test('seasonal intro is reserved for the autumn phase window', () => {
  assert.equal(seasonalIntroEligible(0.66), true);
  assert.equal(seasonalIntroEligible(0.874999), true);
  for (const phase of [0, 0.2, 0.65, 0.875, 0.99, Number.NaN]) {
    assert.equal(seasonalIntroEligible(phase), false, `phase ${phase} is outside autumn`);
  }

  const spring = createAnimationHarness(new Date('2026-03-01T19:00:00.000Z'));
  spring.controller.start({ reducedMotion: false, intro: true });
  assert.equal(spring.latest().mode, 'today');
  assert.equal(spring.frames.size, 0);
  spring.controller.dispose();
});

test('today mode refreshes by one quiet timer and catches up immediately on visibility return', () => {
  const harness = createAnimationHarness(new Date('2026-06-01T18:00:00.000Z'));
  harness.controller.start({ reducedMotion: false, intro: false });
  assert.equal(harness.frames.size, 0, 'today mode does not keep an animation frame alive');
  assert.equal(harness.timers.size, 1);
  assert.deepEqual([...harness.timers.values()].map(timer => timer.delayMs), [60_000]);

  const nextDay = new Date('2026-06-02T18:00:00.000Z');
  harness.setNow(nextDay);
  harness.fireTimers();
  assert.ok(Math.abs(harness.latest().phase - denverCalendar(nextDay).phase) < 1e-10);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.timers.size, 1);

  harness.controller.setHidden(true);
  assert.equal(harness.timers.size, 0, 'hidden documents cancel the idle clock wake');
  const whileHidden = new Date('2026-06-04T18:00:00.000Z');
  harness.setNow(whileHidden);
  harness.controller.setHidden(false);
  assert.ok(Math.abs(harness.latest().phase - denverCalendar(whileHidden).phase) < 1e-10);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.timers.size, 1);
  harness.controller.dispose();
  assert.equal(harness.timers.size, 0);
});

test('canceled and disposed clock wakes cannot publish stale state or reschedule', () => {
  const harness = createAnimationHarness(new Date('2026-06-01T18:00:00.000Z'));
  harness.controller.start({ reducedMotion: false, intro: false });
  const staleTimer = [...harness.timers.values()][0].callback;
  harness.setNow(new Date('2026-06-02T18:00:00.000Z'));
  harness.controller.today();
  const afterToday = harness.latest();
  staleTimer();
  assert.deepEqual(harness.latest(), afterToday, 'a replaced wake is fenced');
  assert.equal(harness.timers.size, 1);

  const disposedTimer = [...harness.timers.values()][0].callback;
  harness.controller.dispose();
  const stateCount = harness.states.length;
  disposedTimer();
  assert.equal(harness.states.length, stateCount, 'a disposed wake cannot publish');
  assert.equal(harness.timers.size, 0, 'a disposed wake cannot reschedule');
});

test('a finite year play ends at the current Denver clock phase, not its original phase', () => {
  const start = new Date('2026-06-01T18:00:00.000Z');
  const end = new Date('2026-06-02T18:00:00.000Z');
  const harness = createAnimationHarness(start);
  harness.controller.start({ reducedMotion: false, intro: false });
  harness.controller.play();
  harness.step(0);
  harness.step(12_000);
  harness.setNow(end);
  harness.step(24_000);
  assert.equal(harness.latest().mode, 'today');
  assert.ok(Math.abs(harness.latest().phase - denverCalendar(end).phase) < 1e-10);
  harness.controller.dispose();
});

test('intro is finite and claimSeasonalIntro runs once per document identity', () => {
  const firstDocument = {};
  const secondDocument = {};
  assert.equal(claimSeasonalIntro(firstDocument), true);
  assert.equal(claimSeasonalIntro(firstDocument), false);
  assert.equal(claimSeasonalIntro(secondDocument), true);

  const harness = createAnimationHarness();
  harness.controller.start({ reducedMotion: false, intro: true });
  assert.equal(harness.latest().mode, 'intro');
  harness.step(10_000);
  harness.step(13_499);
  assert.equal(harness.latest().mode, 'intro');
  harness.step(13_500);
  assert.equal(harness.latest().mode, 'today');
  assert.equal(harness.frames.size, 0);
  harness.controller.dispose();
});

test('play advances one finite year cycle, then stops at the starting phase', () => {
  const harness = createAnimationHarness();
  harness.controller.start({ reducedMotion: false, intro: false });
  harness.controller.play();
  const initial = harness.latest().phase;
  harness.step(1_000);
  harness.step(13_000);
  assert.equal(harness.latest().mode, 'playing');
  assert.ok(Math.abs(((harness.latest().phase - initial + 1) % 1) - 0.5) < 1e-8);
  harness.step(25_000);
  assert.equal(harness.latest().mode, 'today');
  assert.ok(Math.abs(harness.latest().phase - initial) < 1e-8);
  assert.equal(harness.frames.size, 0);
  harness.controller.dispose();
});

test('pause, resume and hidden-page suspension do not include paused time', () => {
  const harness = createAnimationHarness();
  harness.controller.start({ reducedMotion: false, intro: false });
  harness.controller.play();
  harness.step(0);
  harness.step(4_000);
  const atPause = harness.latest().phase;
  harness.controller.pause();
  assert.equal(harness.latest().mode, 'paused');
  assert.equal(harness.frames.size, 0);
  harness.controller.play();
  harness.step(40_000); // first visible frame resets elapsed baseline
  assert.ok(Math.abs(harness.latest().phase - atPause) < 1e-10);
  harness.step(43_000);
  const beforeHidden = harness.latest().phase;
  harness.controller.setHidden(true);
  assert.equal(harness.frames.size, 0);
  harness.controller.setHidden(false);
  harness.step(90_000); // hidden time is discarded
  assert.ok(Math.abs(harness.latest().phase - beforeHidden) < 1e-10);
  harness.step(91_000);
  assert.ok(harness.latest().phase !== beforeHidden);
  harness.controller.dispose();
  assert.equal(harness.frames.size, 0);
});

test('reduced motion starts and plays as a static scene without scheduling frames', () => {
  const harness = createAnimationHarness();
  harness.controller.start({ reducedMotion: true, intro: true });
  assert.equal(harness.latest().mode, 'today');
  assert.equal(harness.latest().reducedMotion, true);
  assert.equal(harness.frames.size, 0);
  harness.controller.play();
  assert.equal(harness.latest().mode, 'today');
  assert.equal(harness.frames.size, 0);
  harness.controller.dispose();
});

test('return today resets the phase from the injected Denver clock and cancels motion', () => {
  const now = new Date('2026-11-01T18:00:00.000Z');
  const expected = denverCalendar(now).phase;
  const harness = createAnimationHarness(now);
  harness.controller.start({ reducedMotion: false, intro: false });
  harness.controller.play();
  harness.step(0);
  harness.step(2_000);
  harness.controller.today();
  assert.equal(harness.latest().mode, 'today');
  assert.ok(Math.abs(harness.latest().phase - expected) < 1e-10);
  assert.equal(harness.frames.size, 0);
  harness.controller.dispose();
});
