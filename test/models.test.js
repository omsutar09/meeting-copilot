const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { DOWNLOADS, missingDownloads, modelsDirFor, downloadModels, downloadSize } = require('../src/models');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mc-models-'));

// ---------- missingDownloads ----------

test('missingDownloads lists everything for an empty folder', () => {
  const names = missingDownloads('parakeet', tmpDir()).map((d) => d.name);
  assert.deepEqual(names, DOWNLOADS.parakeet.map((d) => d.name));
});

test('missingDownloads skips what is already there', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, DOWNLOADS.parakeet[0].name));
  const names = missingDownloads('parakeet', dir).map((d) => d.name);
  assert.deepEqual(names, ['silero_vad.onnx']);
});

test('missingDownloads throws for an unknown engine', () => {
  assert.throws(() => missingDownloads('whisper', tmpDir()), /Unknown speech engine/);
});

test('downloadSize adds up the expected bytes', () => {
  assert.equal(downloadSize(DOWNLOADS.parakeet), DOWNLOADS.parakeet[0].bytes + DOWNLOADS.parakeet[1].bytes);
});

// ---------- modelsDirFor ----------

test('modelsDirFor uses Application Support in the installed app', () => {
  assert.equal(modelsDirFor({ isPackaged: true, appPath: '/A', userData: '/U' }), path.join('/U', 'models'));
});

test('modelsDirFor uses the project models folder in development', () => {
  assert.equal(modelsDirFor({ isPackaged: false, appPath: '/A', userData: '/U' }), path.join('/A', 'models'));
});

// ---------- downloadModels ----------

// A real .tar.bz2 holding <name>/tokens.txt, and a fetch that serves it.
function makeTarball(name) {
  const src = tmpDir();
  fs.mkdirSync(path.join(src, name));
  fs.writeFileSync(path.join(src, name, 'tokens.txt'), 'a 1\n');
  const file = path.join(src, `${name}.tar.bz2`);
  execFileSync('tar', ['cjf', file, '-C', src, name]);
  return fs.readFileSync(file);
}

function fakeFetch(bodies, seen = []) {
  return async (url) => {
    seen.push(url);
    const key = Object.keys(bodies).find((k) => url.endsWith(k));
    if (!key) return new Response('nope', { status: 404 });
    return new Response(bodies[key], { headers: { 'content-length': String(bodies[key].length) } });
  };
}

test('downloadModels downloads and extracts what is missing, with progress', async () => {
  const dir = tmpDir();
  const tarName = DOWNLOADS.parakeet[0].name;
  const tarBody = makeTarball(tarName);
  const vadBody = Buffer.from('vad');
  const catalog = {
    parakeet: [
      { name: tarName, kind: 'tar', bytes: tarBody.length, sha256: sha256(tarBody) },
      { name: 'silero_vad.onnx', kind: 'file', bytes: 3, sha256: sha256(vadBody) },
    ],
  };
  const seen = [];
  const progress = [];
  await downloadModels({
    engine: 'parakeet',
    modelsDir: dir,
    catalog,
    fetchImpl: fakeFetch({ [`${tarName}.tar.bz2`]: tarBody, 'silero_vad.onnx': vadBody }, seen),
    onProgress: (p) => progress.push(p),
  });
  assert.equal(fs.readFileSync(path.join(dir, tarName, 'tokens.txt'), 'utf8'), 'a 1\n');
  assert.equal(fs.readFileSync(path.join(dir, 'silero_vad.onnx'), 'utf8'), 'vad');
  assert.equal(seen.length, 2);
  assert.ok(seen.every((u) => u.startsWith('https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/')));
  const last = progress[progress.length - 1];
  assert.equal(last.index, 1);
  assert.equal(last.count, 2);
  assert.equal(last.received, last.total);
  assert.deepEqual(missingDownloads('parakeet', dir), []);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.')), [], 'no temporary files left behind');
});

test('downloadModels does nothing when everything is present', async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, DOWNLOADS.zipformer[0].name));
  const seen = [];
  await downloadModels({ engine: 'zipformer', modelsDir: dir, fetchImpl: fakeFetch({}, seen) });
  assert.equal(seen.length, 0);
});

test('downloadModels fails clearly on an HTTP error and leaves nothing half-written', async () => {
  const dir = tmpDir();
  await assert.rejects(
    downloadModels({ engine: 'zipformer', modelsDir: dir, fetchImpl: fakeFetch({}) }),
    /Couldn't download .*HTTP 404/,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('downloadModels fails when the archive does not contain the expected folder', async () => {
  const dir = tmpDir();
  const name = DOWNLOADS.zipformer[0].name;
  const body = makeTarball('something-else');
  await assert.rejects(
    downloadModels({ engine: 'test', modelsDir: dir, catalog: catalogFor(name, 'tar', body), fetchImpl: fakeFetch({ [`${name}.tar.bz2`]: body }) }),
    /unexpected contents/,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

// ---------- integrity and safety ----------

// A one-item catalog whose checksum matches the body we serve.
function catalogFor(name, kind, body, extra = {}) {
  return { test: [{ name, kind, bytes: body.length, sha256: sha256(body), ...extra }] };
}

test('every real download has a pinned SHA-256', () => {
  for (const list of Object.values(DOWNLOADS)) {
    for (const d of list) assert.match(d.sha256, /^[0-9a-f]{64}$/, d.name);
  }
});

test('downloadModels rejects a file whose checksum does not match', async () => {
  const dir = tmpDir();
  const catalog = { test: [{ name: 'vad.onnx', kind: 'file', bytes: 3, sha256: '0'.repeat(64) }] };
  await assert.rejects(
    downloadModels({ engine: 'test', modelsDir: dir, catalog, fetchImpl: fakeFetch({ 'vad.onnx': Buffer.from('bad') }) }),
    /checksum/,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('downloadModels accepts a file whose checksum matches', async () => {
  const dir = tmpDir();
  const body = Buffer.from('good');
  await downloadModels({ engine: 'test', modelsDir: dir, catalog: catalogFor('vad.onnx', 'file', body), fetchImpl: fakeFetch({ 'vad.onnx': body }) });
  assert.equal(fs.readFileSync(path.join(dir, 'vad.onnx'), 'utf8'), 'good');
});

test('downloadModels refuses an archive that contains a symlink', async () => {
  const dir = tmpDir();
  const name = 'model-x';
  const src = tmpDir();
  fs.mkdirSync(path.join(src, name));
  fs.symlinkSync('/etc/hosts', path.join(src, name, 'link'));
  const file = path.join(src, 'a.tar.bz2');
  execFileSync('tar', ['cjf', file, '-C', src, name]);
  const body = fs.readFileSync(file);
  await assert.rejects(
    downloadModels({ engine: 'test', modelsDir: dir, catalog: catalogFor(name, 'tar', body), fetchImpl: fakeFetch({ [`${name}.tar.bz2`]: body }) }),
    /unexpected contents/,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('downloadModels gives up on a stalled download', async () => {
  const dir = tmpDir();
  const stalled = async (_url, { signal }) =>
    new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); signal.addEventListener('abort', () => c.error(signal.reason)); } }));
  await assert.rejects(
    downloadModels({ engine: 'test', modelsDir: dir, catalog: catalogFor('vad.onnx', 'file', Buffer.from('x')), fetchImpl: stalled, stallMs: 30 }),
    /stalled/,
  );
  assert.deepEqual(fs.readdirSync(dir), []);
});
