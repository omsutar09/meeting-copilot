const test = require('node:test');
const assert = require('node:assert/strict');
const { fitSize, pickSource, captureScreen, MAX_EDGE } = require('../src/screen-capture');

// ---------- fitSize ----------

test('fitSize keeps an image that already fits', () => {
  assert.deepEqual(fitSize({ width: 1200, height: 800 }), { width: 1200, height: 800 });
});

test('fitSize scales the long edge down to MAX_EDGE and keeps the aspect ratio', () => {
  const out = fitSize({ width: 3024, height: 1964 });
  assert.equal(out.width, MAX_EDGE);
  assert.equal(out.height, Math.round((1964 * MAX_EDGE) / 3024));
});

test('fitSize handles portrait images', () => {
  const out = fitSize({ width: 1000, height: 4000 }, 2000);
  assert.deepEqual(out, { width: 500, height: 2000 });
});

test('fitSize returns a new object rather than the input', () => {
  const input = { width: 100, height: 100 };
  const out = fitSize(input);
  assert.notEqual(out, input);
  assert.deepEqual(input, { width: 100, height: 100 });
});

test('fitSize throws on an empty size', () => {
  assert.throws(() => fitSize({ width: 0, height: 100 }), /size/);
});

// ---------- pickSource ----------

const sources = [
  { id: 'screen:1', display_id: '1' },
  { id: 'screen:2', display_id: '2' },
];

test('pickSource returns the source for the given display', () => {
  assert.equal(pickSource(sources, 2).id, 'screen:2');
});

test('pickSource falls back to the first source when the display is not listed', () => {
  assert.equal(pickSource(sources, 99).id, 'screen:1');
});

test('pickSource returns null when there are no sources', () => {
  assert.equal(pickSource([], 1), null);
});

// ---------- captureScreen ----------

function fakeImage({ width, height, empty = false }) {
  const calls = { resize: null };
  const img = {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    resize: (opts) => {
      calls.resize = opts;
      return fakeImage({ width: opts.width, height: opts.height }).img;
    },
    toJPEG: (q) => Buffer.from(`jpeg:${width}x${height}:q${q}`),
  };
  return { img, calls };
}

function fakeDeps({ status = 'granted', image } = {}) {
  const seen = {};
  return {
    seen,
    deps: {
      platform: 'darwin',
      systemPreferences: { getMediaAccessStatus: (kind) => ((seen.permissionKind = kind), status) },
      screen: {
        getCursorScreenPoint: () => ({ x: 10, y: 10 }),
        getDisplayNearestPoint: () => ({ id: 7, size: { width: 1512, height: 982 }, scaleFactor: 2 }),
      },
      desktopCapturer: {
        getSources: async (opts) => {
          seen.getSources = opts;
          return [
            { id: 'screen:other', display_id: '1', thumbnail: fakeImage({ width: 10, height: 10 }).img },
            { id: 'screen:7', display_id: '7', thumbnail: image },
          ];
        },
      },
    },
  };
}

test('captureScreen captures the display under the cursor at full resolution', async () => {
  const { img } = fakeImage({ width: 3024, height: 1964 });
  const { deps, seen } = fakeDeps({ image: img });
  await captureScreen(deps);
  assert.deepEqual(seen.getSources, { types: ['screen'], thumbnailSize: { width: 3024, height: 1964 } });
  assert.equal(seen.permissionKind, 'screen');
});

test('captureScreen resizes to fit and returns a base64 JPEG', async () => {
  const { img, calls } = fakeImage({ width: 3024, height: 1964 });
  const { deps } = fakeDeps({ image: img });
  const shot = await captureScreen(deps);
  const expected = fitSize({ width: 3024, height: 1964 });
  assert.deepEqual({ width: calls.resize.width, height: calls.resize.height }, expected);
  assert.equal(shot.mediaType, 'image/jpeg');
  assert.equal(shot.width, expected.width);
  assert.equal(shot.height, expected.height);
  assert.equal(Buffer.from(shot.data, 'base64').toString(), `jpeg:${expected.width}x${expected.height}:q80`);
});

test('captureScreen does not resize an image that already fits', async () => {
  const { img, calls } = fakeImage({ width: 1200, height: 800 });
  const { deps } = fakeDeps({ image: img });
  const shot = await captureScreen(deps);
  assert.equal(calls.resize, null);
  assert.equal(shot.width, 1200);
});

test('captureScreen fails with code "permission" when Screen Recording is denied', async () => {
  const { deps } = fakeDeps({ status: 'denied', image: fakeImage({ width: 10, height: 10 }).img });
  await assert.rejects(captureScreen(deps), (err) => err.code === 'permission');
});

test('captureScreen fails with code "permission" when macOS returns an empty image', async () => {
  const { deps } = fakeDeps({ image: fakeImage({ width: 0, height: 0, empty: true }).img });
  await assert.rejects(captureScreen(deps), (err) => err.code === 'permission');
});

test('captureScreen skips the permission check off macOS', async () => {
  const { deps, seen } = fakeDeps({ status: 'denied', image: fakeImage({ width: 100, height: 100 }).img });
  const shot = await captureScreen({ ...deps, platform: 'linux' });
  assert.equal(seen.permissionKind, undefined);
  assert.equal(shot.width, 100);
});

test('captureScreen fails with code "no-screen" when no screens are found', async () => {
  const { deps } = fakeDeps({ image: null });
  const noScreens = { ...deps, desktopCapturer: { getSources: async () => [] } };
  await assert.rejects(captureScreen(noScreens), (err) => err.code === 'no-screen');
});
