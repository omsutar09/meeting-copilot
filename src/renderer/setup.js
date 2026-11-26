/* global copilot, $, banner, listening */
// First-run setup: Claude Code install + sign-in, and the speech model download.
// The setup cards show only while something is missing.

const ENGINE_NAMES = { parakeet: 'Parakeet', zipformer: 'Zipformer' };
const CANCELLED = 'Sign-in was cancelled.';
let claudeReady = false;
let modelsReady = false;

const show = (id, on) => $(id).classList.toggle('hidden', !on);
const megabytes = (bytes) => `${Math.round(bytes / 1e6)} MB`;
const planName = (plan) => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '');

function setButton(id, busy, label) {
  $(id).disabled = busy;
  $(id).textContent = label;
}

function refreshSetup() {
  show('setup', !(claudeReady && modelsReady));
}

// ---------- Claude ----------

function accountLine(s) {
  if (!s.installed) return '(Claude Code not installed)';
  if (!s.loggedIn) return '(not signed in)';
  const who = s.email ? ` as ${s.email}` : '';
  return `(signed in${who}${s.plan ? ` · ${planName(s.plan)}` : ''})`;
}

async function refreshClaude() {
  const s = await copilot.claudeStatus();
  claudeReady = s.installed && s.loggedIn;
  show('claudeCard', !claudeReady);
  show('claudeInstallBtn', !s.installed);
  show('claudeLoginBtn', s.installed && !s.loggedIn);
  $('claudeText').textContent = s.installed
    ? 'Sign in with your Claude account. Answers use your Claude subscription; no API key needed.'
    : 'Answers come from Claude Code, which runs on your Claude subscription. Install it first.';
  $('accountText').textContent = accountLine(s);
  show('accountLoginBtn', s.installed && !s.loggedIn);
  show('accountLogoutBtn', s.loggedIn);
  refreshSetup();
  return s;
}

let signingIn = false;
async function signIn() {
  if (signingIn) return; // a second click would cancel the login in progress
  signingIn = true;
  try {
    await runSignIn();
  } finally {
    signingIn = false;
  }
}

async function runSignIn() {
  $('drawer').classList.add('hidden');
  show('setup', true);
  show('claudeCard', true);
  setButton('claudeLoginBtn', true, 'Waiting for the browser…');
  show('loginPending', true);
  const r = await copilot.claudeLogin();
  show('loginPending', false);
  $('codeInput').value = '';
  setButton('claudeLoginBtn', false, 'Sign in to Claude');
  if (r.ok) banner('Signed in to Claude.', 'info');
  else if (r.error !== CANCELLED) banner(r.error);
  await refreshClaude();
}

async function signOut() {
  const r = await copilot.claudeLogout();
  if (!r.ok) banner(r.error);
  await refreshClaude();
}

async function installClaude() {
  setButton('claudeInstallBtn', true, 'Installing…');
  $('installLog').textContent = '';
  show('installLog', true);
  const r = await copilot.claudeInstall();
  setButton('claudeInstallBtn', false, 'Install Claude Code');
  show('installLog', false);
  if (r.cancelled) return;
  if (!r.ok) banner(r.error);
  const s = await refreshClaude();
  if (r.ok && s.installed && !s.loggedIn) signIn();
}

copilot.onInstallOutput((text) => {
  const line = text.trim().split('\n').pop();
  if (line) $('installLog').textContent = line;
});

$('claudeInstallBtn').onclick = installClaude;
$('claudeLoginBtn').onclick = signIn;
$('accountLoginBtn').onclick = signIn;
$('accountLogoutBtn').onclick = signOut;
$('openLoginBtn').onclick = () => copilot.openLoginPage();
$('loginCancelBtn').onclick = () => copilot.claudeLoginCancel();
$('codeForm').onsubmit = async (e) => {
  e.preventDefault();
  const code = $('codeInput').value.trim();
  if (code && (await copilot.claudeLoginCode(code))) $('codeInput').value = '';
};

// ---------- Speech model ----------

async function refreshModels() {
  const m = await copilot.modelsStatus();
  modelsReady = m.ready;
  show('modelsCard', !m.ready);
  $('modelsText').textContent = `The ${ENGINE_NAMES[m.engine] || m.engine} model isn't downloaded yet (${megabytes(m.bytes)}, once). It runs on your Mac.`;
  if (!listening) $('startBtn').disabled = !m.ready;
  refreshSetup();
}

async function downloadSpeechModel() {
  setButton('modelsBtn', true, 'Downloading…');
  show('modelsProgress', true);
  const r = await copilot.downloadModels();
  setButton('modelsBtn', false, 'Download');
  show('modelsProgress', false);
  $('modelsProgressText').textContent = '';
  if (!r.ok) banner(`Couldn't download the speech model: ${r.error} Check your connection and try again.`);
  await refreshModels();
}

copilot.onModelsProgress((p) => {
  const fraction = p.total ? p.received / p.total : 0;
  $('modelsProgress').value = fraction;
  const step = p.count > 1 ? `${p.index + 1}/${p.count} · ` : '';
  $('modelsProgressText').textContent =
    fraction >= 1 ? `${step}unpacking…` : `${step}${megabytes(p.received)} of ${megabytes(p.total)}`;
});

$('modelsBtn').onclick = downloadSpeechModel;

// ---------- start ----------
refreshClaude().catch((err) => banner(err.message || String(err)));
refreshModels().catch((err) => banner(err.message || String(err)));
