// Persists settings in the app's userData folder. Any secret fields are
// encrypted with the macOS Keychain-backed safeStorage. (There are none right
// now: answers go through Claude Code, which keeps its own login.)
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const SECRET_KEYS = [];
// Left over from older versions (API keys, Deepgram); dropped when settings load.
const LEGACY_KEYS = ['anthropicKey', 'deepgramKey', 'language', 'autoAnswer'];

const { DEFAULTS } = require('./settings-schema');

const file = () => path.join(app.getPath('userData'), 'settings.json');

function encrypt(v) {
  if (!v) return '';
  if (!safeStorage.isEncryptionAvailable()) return 'plain:' + v;
  return 'enc:' + safeStorage.encryptString(v).toString('base64');
}

function decrypt(v) {
  if (!v) return '';
  if (v.startsWith('plain:')) return v.slice(6);
  if (v.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    } catch {
      return '';
    }
  }
  return '';
}

function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {}
  if ('autoAnswer' in raw && !('autoAnswerThem' in raw)) raw.autoAnswerThem = raw.autoAnswer;
  for (const k of LEGACY_KEYS) delete raw[k];
  const s = { ...DEFAULTS, ...raw };
  for (const k of SECRET_KEYS) s[k] = decrypt(raw[k]);
  return s;
}

function save(next) {
  const merged = { ...load(), ...next };
  const out = { ...merged };
  for (const k of LEGACY_KEYS) delete out[k];
  for (const k of SECRET_KEYS) out[k] = encrypt(merged[k]);
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(out, null, 2));
  return merged;
}

// What the renderer sees: never the keys themselves, only whether they are set.
function publicView(s) {
  const v = { ...s };
  for (const k of SECRET_KEYS) {
    v[k + 'Set'] = Boolean(s[k]);
    delete v[k];
  }
  return v;
}

module.exports = { load, save, publicView };
