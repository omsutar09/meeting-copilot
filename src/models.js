// Downloads the speech models an engine needs, the in-app version of
// scripts/download-models.sh. The installed app keeps models in Application
// Support; development keeps using the project's ./models folder.
//
// Each download is checked against a pinned SHA-256 and is atomic: it goes to
// a hidden temporary name and is moved into place only once it is complete,
// verified and (for archives) unpacked without links.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');

const BASE_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const TAR = process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';
const STALL_MS = 60000; // give up if no data arrives for this long

// bytes: download size, for the progress bar if the server sends none.
// sha256: of the file as downloaded (the .tar.bz2 for archives).
const PARAKEET = {
  name: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
  kind: 'tar',
  bytes: 482440461,
  sha256: '6fc4426b54aa549a0019b8a75b8dea59164e71790a37ac56a045ad57f915f714',
};
const ZIPFORMER = {
  name: 'sherpa-onnx-streaming-zipformer-en-2023-06-26',
  kind: 'tar',
  bytes: 310414022,
  sha256: '639e25b578e9e997131402199419c13a941f8e4e198e2da1ce57dbf5cf401282',
};
const SILERO_VAD = {
  name: 'silero_vad.onnx',
  kind: 'file',
  bytes: 643854,
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
};

const DOWNLOADS = {
  parakeet: [PARAKEET, SILERO_VAD],
  zipformer: [ZIPFORMER],
};

function downloadsFor(engine, catalog) {
  const list = catalog[engine];
  if (!list) throw new Error(`Unknown speech engine "${engine}".`);
  return list;
}

/** The downloads this engine still needs in modelsDir. */
function missingDownloads(engine, modelsDir, catalog = DOWNLOADS) {
  return downloadsFor(engine, catalog).filter((d) => !fs.existsSync(path.join(modelsDir, d.name)));
}

const downloadSize = (list) => list.reduce((sum, d) => sum + d.bytes, 0);

function modelsDirFor({ isPackaged, appPath, userData }) {
  return path.join(isPackaged ? userData : appPath, 'models');
}

function extractTar(file, dir) {
  return new Promise((resolve, reject) => {
    execFile(TAR, ['xjf', file, '--no-same-owner', '-C', dir], (err, _out, stderr) =>
      err ? reject(new Error(`Couldn't unpack the model: ${stderr.trim() || err.message}`)) : resolve(),
    );
  });
}

/** True if the tree holds only real folders and files (no symlinks or other links). */
function onlyPlainFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!onlyPlainFiles(path.join(dir, entry.name))) return false;
    } else if (!entry.isFile() || fs.lstatSync(path.join(dir, entry.name)).nlink > 1) {
      return false;
    }
  }
  return true;
}

async function fetchToFile(item, url, file, { fetchImpl, stallMs, onBytes }) {
  const controller = new AbortController();
  let stallTimer;
  const stalled = () => controller.abort(new Error(`The ${item.name} download stalled. Check your connection and try again.`));
  const resetStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(stalled, stallMs);
  };
  resetStall();
  try {
    const res = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`Couldn't download ${path.basename(url)} (HTTP ${res.status}).`);
    const total = Number(res.headers.get('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    let received = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        resetStall();
        received += chunk.length;
        hash.update(chunk);
        onBytes(received, total);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(file), { signal: controller.signal });
    if (hash.digest('hex') !== item.sha256) throw new Error(`The ${item.name} download failed its checksum check. Try again.`);
  } catch (err) {
    throw controller.signal.aborted ? controller.signal.reason : err;
  } finally {
    clearTimeout(stallTimer);
  }
}

async function downloadOne(item, modelsDir, opts) {
  const remote = item.kind === 'tar' ? `${item.name}.tar.bz2` : item.name;
  const partial = path.join(modelsDir, `.download-${remote}`);
  const scratch = path.join(modelsDir, `.extract-${item.name}`);
  try {
    await fetchToFile(item, `${BASE_URL}/${remote}`, partial, opts);
    if (item.kind === 'file') {
      fs.renameSync(partial, path.join(modelsDir, item.name));
      return;
    }
    fs.mkdirSync(scratch, { recursive: true });
    await extractTar(partial, scratch);
    const extracted = path.join(scratch, item.name);
    const isFolder = fs.existsSync(extracted) && fs.lstatSync(extracted).isDirectory();
    if (!isFolder || !onlyPlainFiles(scratch)) throw new Error(`The ${item.name} download had unexpected contents.`);
    fs.renameSync(extracted, path.join(modelsDir, item.name));
  } finally {
    fs.rmSync(partial, { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Downloads whatever the engine is missing.
 * @param {{ engine: string, modelsDir: string, fetchImpl?: typeof fetch, catalog?: object, stallMs?: number,
 *   onProgress?: (p: { name: string, index: number, count: number, received: number, total: number }) => void }} o
 */
async function downloadModels({ engine, modelsDir, fetchImpl = fetch, catalog = DOWNLOADS, stallMs = STALL_MS, onProgress = () => {} }) {
  const todo = missingDownloads(engine, modelsDir, catalog);
  fs.mkdirSync(modelsDir, { recursive: true });
  for (const [index, item] of todo.entries()) {
    await downloadOne(item, modelsDir, {
      fetchImpl,
      stallMs,
      onBytes: (received, total) => onProgress({ name: item.name, index, count: todo.length, received, total: total || item.bytes }),
    });
  }
}

module.exports = { DOWNLOADS, missingDownloads, downloadSize, modelsDirFor, downloadModels };
