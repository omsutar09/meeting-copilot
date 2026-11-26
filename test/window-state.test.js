const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseState, restoreBounds, createStateSaver, DEFAULT_SIZE, MIN_SIZE } = require('../src/window-state');

const main = { workArea: { x: 0, y: 25, width: 1512, height: 920 } };
const right = { workArea: { x: 1512, y: 0, width: 2560, height: 1415 } };

// ---------- parseState ----------

test('parseState reads a saved window', () => {
  assert.deepEqual(parseState('{"x":10,"y":40,"width":500,"height":700}'), { x: 10, y: 40, width: 500, height: 700 });
});

test('parseState rounds fractional values', () => {
  assert.deepEqual(parseState({ x: 10.4, y: 40.6, width: 500.5, height: 700 }), { x: 10, y: 41, width: 501, height: 700 });
});

test('parseState rejects damaged or partial data', () => {
  for (const bad of ['', 'not json', 'null', '[]', '{"x":1}', '{"x":"1","y":2,"width":500,"height":600}', '{"x":1,"y":2,"width":1e9,"height":600}', '{"x":1,"y":2,"width":-5,"height":600}']) {
    assert.equal(parseState(bad), null, bad);
  }
});

test('parseState rejects non-finite numbers', () => {
  assert.equal(parseState({ x: Infinity, y: 0, width: 500, height: 600 }), null);
  assert.equal(parseState({ x: NaN, y: 0, width: 500, height: 600 }), null);
});

// ---------- restoreBounds ----------

test('with nothing saved, the default size is centred on the main display', () => {
  const b = restoreBounds(null, [main], main);
  assert.deepEqual(b, {
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    x: Math.round((1512 - DEFAULT_SIZE.width) / 2),
    y: 25 + Math.round((920 - DEFAULT_SIZE.height) / 2),
  });
});

test('a window that is on screen is restored exactly', () => {
  const saved = { x: 900, y: 100, width: 500, height: 700 };
  assert.deepEqual(restoreBounds(saved, [main, right], main), saved);
});

test('a window on the second display stays there', () => {
  const saved = { x: 3000, y: 200, width: 600, height: 900 };
  assert.deepEqual(restoreBounds(saved, [main, right], main), saved);
});

test('a window on a display that is gone opens centred on the main display', () => {
  const saved = { x: 3000, y: 200, width: 600, height: 900 };
  assert.deepEqual(restoreBounds(saved, [main], main), restoreBounds(null, [main], main));
});

test('a window mostly off screen opens centred on the main display', () => {
  const saved = { x: -5000, y: -5000, width: 500, height: 700 };
  assert.deepEqual(restoreBounds(saved, [main], main), restoreBounds(null, [main], main));
});

test('a window partly off the edge is moved back on screen', () => {
  const saved = { x: 1200, y: 100, width: 500, height: 700 };
  assert.deepEqual(restoreBounds(saved, [main], main), { x: 1512 - 500, y: 100, width: 500, height: 700 });
});

test('a window larger than the display is shrunk to fit it', () => {
  const saved = { x: 0, y: 25, width: 3000, height: 2000 };
  assert.deepEqual(restoreBounds(saved, [main], main), { x: 0, y: 25, width: 1512, height: 920 });
});

test('a window smaller than the minimum is grown to the minimum', () => {
  const saved = { x: 100, y: 100, width: 100, height: 50 };
  const b = restoreBounds(saved, [main], main);
  assert.equal(b.width, MIN_SIZE.width);
  assert.equal(b.height, MIN_SIZE.height);
});

// ---------- createStateSaver ----------

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-win-')), 'window-state.json');

test('the saver writes only the last bounds after the delay', async () => {
  const file = tmpFile();
  const saver = createStateSaver({ file, delayMs: 20 });
  saver.schedule({ x: 1, y: 2, width: 400, height: 500 });
  saver.schedule({ x: 3, y: 4, width: 410, height: 510 });
  assert.equal(fs.existsSync(file), false, 'not written straight away');
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { x: 3, y: 4, width: 410, height: 510 });
});

test('flush writes the pending bounds immediately and leaves no temp file', () => {
  const file = tmpFile();
  const saver = createStateSaver({ file, delayMs: 10000 });
  saver.schedule({ x: 5, y: 6, width: 420, height: 520 });
  saver.flush();
  assert.deepEqual(parseState(fs.readFileSync(file, 'utf8')), { x: 5, y: 6, width: 420, height: 520 });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['window-state.json']);
});

test('flush with nothing pending does not write', () => {
  const file = tmpFile();
  createStateSaver({ file, delayMs: 10 }).flush();
  assert.equal(fs.existsSync(file), false);
});

test('a failed write is reported, not thrown', () => {
  const errors = [];
  const saver = createStateSaver({ file: '/nonexistent-dir/x/window-state.json', delayMs: 10, onError: (e) => errors.push(e) });
  saver.schedule({ x: 1, y: 1, width: 400, height: 400 });
  assert.doesNotThrow(() => saver.flush());
  assert.equal(errors.length, 1);
});
