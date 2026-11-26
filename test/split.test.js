const test = require('node:test');
const assert = require('node:assert/strict');
const { clampSplit, splitFromPointer, stepSplit, parseStoredSplit, DEFAULT_SPLIT, MIN_SPLIT, MAX_SPLIT, STEP } = require('../src/renderer/split');

test('the default split matches the old 3:2 layout', () => {
  assert.equal(DEFAULT_SPLIT, 0.6);
});

test('clampSplit keeps the split between MIN_SPLIT and MAX_SPLIT', () => {
  assert.equal(clampSplit(0.5), 0.5);
  assert.equal(clampSplit(0.05), MIN_SPLIT);
  assert.equal(clampSplit(0.99), MAX_SPLIT);
});

test('clampSplit falls back to the default for junk', () => {
  for (const bad of [NaN, Infinity, undefined, null, '0.5']) assert.equal(clampSplit(bad), DEFAULT_SPLIT, String(bad));
});

test('splitFromPointer turns a pointer position into the answer share', () => {
  assert.equal(splitFromPointer({ y: 300, top: 100, height: 500 }), 0.4);
});

test('splitFromPointer keeps each panel at least minPx tall', () => {
  // 80 px of 300 px is 0.267, which is stricter than MIN_SPLIT
  const r = splitFromPointer({ y: 101, top: 100, height: 300, minPx: 80 });
  assert.equal(r, 80 / 300);
  const s = splitFromPointer({ y: 399, top: 100, height: 300, minPx: 80 });
  assert.equal(s, 1 - 80 / 300);
});

test('splitFromPointer still respects MIN_SPLIT and MAX_SPLIT on tall windows', () => {
  assert.equal(splitFromPointer({ y: 0, top: 0, height: 2000 }), MIN_SPLIT);
  assert.equal(splitFromPointer({ y: 2000, top: 0, height: 2000 }), MAX_SPLIT);
});

test('splitFromPointer returns the default when there is no room to measure', () => {
  assert.equal(splitFromPointer({ y: 10, top: 0, height: 0 }), DEFAULT_SPLIT);
});

test('stepSplit moves by STEP and stays in range', () => {
  assert.equal(STEP, 0.05);
  assert.equal(stepSplit(0.6, 1), 0.65);
  assert.equal(stepSplit(0.6, -1), 0.55);
  assert.equal(stepSplit(MAX_SPLIT, 1), MAX_SPLIT);
  assert.equal(stepSplit(MIN_SPLIT, -1), MIN_SPLIT);
});

test('stepSplit avoids floating point drift', () => {
  let r = 0.6;
  for (let i = 0; i < 3; i++) r = stepSplit(r, -1);
  assert.equal(r, 0.45);
});

test('parseStoredSplit reads a saved value and ignores junk', () => {
  assert.equal(parseStoredSplit('0.7'), 0.7);
  assert.equal(parseStoredSplit('0.95'), MAX_SPLIT);
  assert.equal(parseStoredSplit(null), DEFAULT_SPLIT);
  assert.equal(parseStoredSplit('abc'), DEFAULT_SPLIT);
});

const { clampForHeight } = require('../src/renderer/split');

test('clampForHeight keeps each panel at least minPx tall in a short window', () => {
  // 300 px tall: 80 px is 0.267 of it, stricter than MIN_SPLIT and MAX_SPLIT
  assert.equal(clampForHeight(MIN_SPLIT, 300, 80), 80 / 300);
  assert.equal(clampForHeight(MAX_SPLIT, 300, 80), 1 - 80 / 300);
});

test('clampForHeight leaves a valid split alone in a tall window', () => {
  assert.equal(clampForHeight(0.45, 1000, 80), 0.45);
});

test('clampForHeight falls back to the default when there is no room', () => {
  assert.equal(clampForHeight(0.3, 100, 80), DEFAULT_SPLIT);
  assert.equal(clampForHeight(0.3, 0, 80), DEFAULT_SPLIT);
});
