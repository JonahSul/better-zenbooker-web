import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'components/visitor-support.tsx'), 'utf8');
const cameraSection = source.match(/cameraVisible&&(<section className="support-camera"[\s\S]*?<\/section>)/)?.[1];
assert.ok(cameraSection, 'the production help component contains the explicit camera preview section');

test('camera preview is accessible, muted, and waits for usable video before enabling capture', () => {
  assert.match(cameraSection, /aria-label="Take a service photo"/);
  assert.match(cameraSection, /<video[^>]*muted autoPlay playsInline/);
  assert.match(cameraSection, /onLoadedData=\{\(\)=>cameraController\.current\?\.setReady\(\)\}/);
  assert.match(cameraSection, /onCanPlay=\{\(\)=>cameraController\.current\?\.setReady\(\)\}/);
  assert.match(cameraSection, /disabled=\{!cameraSnapshot\.ready\} onClick=\{\(\)=>void cameraController\.current\?\.capture\(\)\}>Capture photo/);
  assert.match(cameraSection, /Captured service photo, not yet uploaded/);
});

test('upload remains available during camera permission and Use photo is the sole camera-to-upload action', () => {
  assert.match(cameraSection, /Waiting for camera permission[\s\S]*?Upload photo/);
  assert.match(cameraSection, /<button type="button" onClick=\{chooseUpload\}>Upload photo<\/button>/);
  assert.match(cameraSection, /<button type="button" disabled=\{busy\|\|saving\|\|uncertain\} onClick=\{useCameraPhoto\}>Use photo/);
  const handler = source.match(/function useCameraPhoto\(\)\{([\s\S]*?)\n/);
  assert.ok(handler);
  assert.match(handler[1], /value\?\.state!=='captured'\|\|!value\.blob/);
  assert.match(handler[1], /new File\(\[value\.blob\],'service-photo\.jpg',\{type:'image\/jpeg'\}\)/);
  assert.match(handler[1], /cancelCamera\(true\);void uploadPhoto\(file\)/);
});

test('camera actions cannot submit the surrounding help question form', () => {
  for (const label of ['Use photo', 'Retake', 'Capture photo', 'Upload photo', 'Cancel camera']) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const opening = cameraSection.match(new RegExp(`<button\\b([^>]*)>[^<]*${escaped}`));
    assert.ok(opening, `${label} button exists`);
    assert.match(opening[1], /\btype="button"/, `${label} is not a submit control`);
  }
  const supportFormStart = source.indexOf('<form method="post" action="/api/support/chat"');
  const supportFormEnd = source.indexOf('</form>', supportFormStart);
  const supportForm = source.slice(supportFormStart, supportFormEnd);
  const submitButtons = supportForm.match(/<button\b[^>]*\btype="submit"[^>]*>/g) ?? [];
  assert.equal(submitButtons.length, 1, 'Send is the only submit button in the help form');
  assert.match(submitButtons[0], /className="support-send"/);
});

test('permission requests are explicit and preview resources stop on hide, close, pagehide and unmount', () => {
  assert.match(source, /DropdownMenuItem onSelect=\{\(\)=>setCameraVisible\(true\)\}>.*?Take photo/);
  assert.match(source, /if\(!cameraVisible\)return;[\s\S]*?void camera\?\.open\(video\)/);
  assert.match(source, /const hide=\(\)=>\{camera\.cancel\(\);setCameraVisible\(false\);\}/);
  assert.match(source, /document\.addEventListener\('visibilitychange',visibility\)/);
  assert.match(source, /window\.addEventListener\('pagehide',hide\)/);
  assert.match(source, /return\(\)=>\{unsubscribe\(\);camera\.dispose\(\)/);
  assert.match(source, /if\(cameraPreviewUrl\.current\)URL\.revokeObjectURL\(cameraPreviewUrl\.current\)/);
});

test('explicit camera exit restores focus to the connected composer after the preview closes', () => {
  assert.match(source, /function cancelCamera\(restoreFocus=false\)\{cameraController\.current\?\.cancel\(\);setCameraVisible\(false\);if\(restoreFocus\)restoreComposerFocus\(textarea\.current,callback=>window\.requestAnimationFrame\(callback\)\);\}/);
  assert.match(source, /function useCameraPhoto\(\)\{[\s\S]*?cancelCamera\(true\);void uploadPhoto\(file\)/);
  assert.match(cameraSection, /onClick=\{\(\)=>cancelCamera\(true\)\}>Cancel camera/);
});
