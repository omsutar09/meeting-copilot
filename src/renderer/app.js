/* global copilot */
const $ = (id) => document.getElementById(id);

let settings = {};
let listening = false;
let audioCtx = null;
let mediaStreams = [];
let answerText = '';
let answerStartedAt = 0;
let autoFrom = null; // 'THEM' / 'ME' when the current answer was triggered automatically
const interim = { THEM: '', ME: '' };
let lines = [];

// ---------- helpers ----------
function banner(msg, kind = 'error') {
  const b = $('banner');
  if (!msg) return b.classList.add('hidden');
  b.textContent = msg;
  b.className = 'banner' + (kind === 'info' ? ' info' : '');
}

function setStatus(text, state = '') {
  $('statusText').textContent = text;
  $('statusDot').className = 'dot ' + state;
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Small, safe Markdown subset: code fences, bullets, bold, italics, inline code.
function renderMarkdown(md) {
  const parts = md.split(/```/);
  let html = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      const body = part.replace(/^[\w+-]*\n/, '');
      html += `<pre><code>${esc(body)}</code></pre>`;
      return;
    }
    const inline = (t) =>
      esc(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    let inList = false;
    for (const raw of part.split('\n')) {
      const line = raw.trimEnd();
      const bullet = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)/);
      if (bullet) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${inline(bullet[1])}</li>`;
        continue;
      }
      if (inList) { html += '</ul>'; inList = false; }
      const h = line.match(/^#{1,6}\s+(.*)/);
      if (h) html += `<p><strong>${inline(h[1])}</strong></p>`;
      else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    if (inList) html += '</ul>';
  });
  return html;
}

function renderAnswer(streaming) {
  const el = $('answer');
  el.innerHTML = renderMarkdown(answerText) || '<p class="placeholder">Thinking…</p>';
  if (streaming) {
    const last = el.lastElementChild;
    if (last) last.classList.add('cursor');
  }
  el.scrollTop = el.scrollHeight;
}

function renderTranscript() {
  const el = $('transcript');
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  let html = lines.map((l) => `<div class="line ${l.speaker}"><b>${l.speaker}</b>${esc(l.text)}</div>`).join('');
  for (const sp of ['THEM', 'ME']) {
    if (interim[sp]) html += `<div class="line ${sp} interim"><b>${sp}</b>${esc(interim[sp])}</div>`;
  }
  el.innerHTML = html || '<div class="line interim">Nothing captured yet.</div>';
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

// ---------- audio capture ----------
async function pipe(stream, label) {
  const src = audioCtx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioCtx, 'pcm-worklet');
  const sink = audioCtx.createGain();
  sink.gain.value = 0; // keep the graph pulled without playing anything back
  src.connect(node).connect(sink).connect(audioCtx.destination);
  const meter = $(label === 'them' ? 'meterThem' : 'meterMe');
  node.port.onmessage = ({ data }) => {
    copilot.sendAudio(label, data.pcm);
    meter.style.setProperty('--lvl', Math.min(100, Math.round(data.level * 250)) + '%');
  };
}

async function captureSystemAudio() {
  if (settings.systemSource && settings.systemSource !== 'loopback') {
    return navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: settings.systemSource }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  }
  // If macOS refuses capture, the request is never answered; don't hang on it.
  // The main process has already shown the reason in the banner.
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('System audio capture timed out.'), { shown: true })), 8000);
  });
  const stream = await Promise.race([navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }), timeout]).finally(() =>
    clearTimeout(timer),
  );
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!stream.getAudioTracks().length) {
    throw new Error('No system audio track. Grant Screen Recording permission to this app, or pick a loopback device (e.g. BlackHole) in Settings.');
  }
  return stream;
}

async function startListening() {
  banner();
  const sources = ['them'];
  if (settings.captureMic) sources.push('me');

  setStatus('Loading speech model…', 'warn');
  $('startBtn').disabled = true;
  const res = await copilot.start(sources);
  $('startBtn').disabled = false;
  if (!res.ok) {
    setStatus('Idle');
    banner(res.error);
    if (res.screenPermission) copilot.openScreenSettings();
    return;
  }

  try {
    audioCtx = new AudioContext({ sampleRate: 16000 });
    await audioCtx.audioWorklet.addModule('pcm-worklet.js');

    const sys = await captureSystemAudio();
    mediaStreams.push(sys);
    await pipe(sys, 'them');

    if (settings.captureMic) {
      const id = settings.micDeviceId;
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: id && id !== 'default' ? { exact: id } : undefined, echoCancellation: true, noiseSuppression: true },
      });
      mediaStreams.push(mic);
      await pipe(mic, 'me');
    }
  } catch (err) {
    stopListening();
    if (err?.shown) {
      copilot.openScreenSettings();
      return;
    }
    const msg = err?.message || String(err);
    banner(
      /permission|denied|NotAllowed/i.test(msg)
        ? 'macOS blocked audio capture. Allow this app under System Settings > Privacy & Security > Screen & System Audio Recording (and Microphone), then restart it.'
        : msg,
    );
    return;
  }

  listening = true;
  $('startBtn').textContent = 'Stop';
  setStatus('Listening', 'live');
}

function stopListening() {
  copilot.stop();
  mediaStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
  mediaStreams = [];
  if (audioCtx) audioCtx.close().catch(() => {});
  audioCtx = null;
  listening = false;
  $('startBtn').textContent = 'Start listening';
  setStatus('Idle');
  for (const id of ['meterThem', 'meterMe']) $(id).style.setProperty('--lvl', '0%');
}

// ---------- settings ----------
async function fillDevices() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {}
  }
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const opt = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
  $('systemSource').innerHTML =
    opt('loopback', 'System audio (built-in capture)') + inputs.filter((d) => d.deviceId !== 'default').map((d) => opt(d.deviceId, d.label || 'Input device')).join('');
  $('micDeviceId').innerHTML = inputs.map((d) => opt(d.deviceId, d.label || 'Microphone')).join('');
  $('systemSource').value = settings.systemSource || 'loopback';
  $('micDeviceId').value = settings.micDeviceId || 'default';
}

const FIELDS = ['model', 'effort', 'engine', 'systemSource', 'micDeviceId', 'resume', 'jobUrl', 'jobDescription', 'context', 'instructions'];
const CHECKS = ['captureMic', 'contentProtection'];

async function openSettings() {
  $('drawer').classList.remove('hidden');
  await fillDevices();
  for (const f of FIELDS) if (settings[f] !== undefined) $(f).value = settings[f];
  for (const c of CHECKS) $(c).checked = Boolean(settings[c]);
  $('resumeState').textContent = settings.resumeFile ? `(${settings.resumeFile})` : '';
  $('jobState').textContent = '';
}

async function saveSettings() {
  const next = {};
  for (const f of FIELDS) next[f] = $(f).value;
  for (const c of CHECKS) next[c] = $(c).checked;
  settings = await copilot.saveSettings(next);
  $('drawer').classList.add('hidden');
  banner(listening ? 'Saved. Restart listening to apply audio or engine changes.' : '', 'info');
}

// ---------- events from main ----------
copilot.onTranscript((t) => { lines = t; renderTranscript(); });
copilot.onInterim(({ speaker, text }) => { interim[speaker] = text; renderTranscript(); });

copilot.onStatus(({ source, status, error }) => {
  if (status === 'error') {
    banner(error || `Transcription error (${source}).`);
    setStatus('Transcription error', 'err');
  } else if (status === 'reconnecting' && listening) {
    setStatus('Reconnecting…', 'warn');
  } else if (status === 'connected' && listening) {
    setStatus('Listening', 'live');
  }
});

copilot.onAnswer((e) => {
  if (e.type === 'start') {
    autoFrom = e.auto;
    answerText = '';
    answerStartedAt = performance.now();
    $('answerMeta').textContent = autoFrom ? `auto (${autoFrom === 'ME' ? 'your' : 'their'} question) · thinking…` : 'thinking…';
    renderAnswer(true);
  } else if (e.type === 'delta') {
    if (!answerText) $('answerMeta').textContent = `first words in ${((performance.now() - answerStartedAt) / 1000).toFixed(1)}s`;
    answerText += e.text;
    renderAnswer(true);
  } else if (e.type === 'done') {
    renderAnswer(false);
    const u = e.usage || {};
    const secs = ((performance.now() - answerStartedAt) / 1000).toFixed(1);
    $('answerMeta').textContent = `${autoFrom ? 'auto · ' : ''}${secs}s${u.cache_read_input_tokens ? ' · cached context' : ''}`;
  } else if (e.type === 'error') {
    renderAnswer(false);
    $('answerMeta').textContent = '';
    banner(e.error);
  }
});

// ---------- UI wiring ----------
$('startBtn').onclick = () => (listening ? stopListening() : startListening());
$('answerBtn').onclick = () => copilot.requestAnswer();
$('clearBtn').onclick = () => copilot.clearTranscript();
$('settingsBtn').onclick = openSettings;
$('closeSettings').onclick = () => $('drawer').classList.add('hidden');
$('saveSettings').onclick = saveSettings;

function fieldError(id, msg) {
  $(id).textContent = msg || '';
  $(id).classList.toggle('hidden', !msg);
}

$('resumePick').onclick = async () => {
  fieldError('resumeError');
  const btn = $('resumePick');
  btn.disabled = true;
  $('resumeState').textContent = '(reading…)';
  const r = await copilot.pickResume();
  btn.disabled = false;
  if (r.ok) {
    settings = await copilot.getSettings();
    $('resume').value = r.text;
    $('resumeState').textContent = `(${r.name}${r.pages ? `, ${r.pages} page${r.pages > 1 ? 's' : ''}` : ''}, saved)`;
  } else {
    $('resumeState').textContent = settings.resumeFile ? `(${settings.resumeFile})` : '';
    if (!r.canceled) fieldError('resumeError', r.error);
  }
};

$('jobForm').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('jobUrl').value.trim();
  if (!url) return;
  fieldError('jobError');
  const btn = $('jobFetch');
  btn.disabled = true;
  $('jobState').textContent = '(fetching and tidying… ~10 s)';
  const r = await copilot.fetchJob(url);
  btn.disabled = false;
  if (r.ok) {
    settings = await copilot.getSettings();
    $('jobUrl').value = r.url;
    $('jobDescription').value = r.text;
    $('jobState').textContent = r.cleaned ? '(saved)' : '(saved raw page text; trim it if needed)';
  } else {
    $('jobState').textContent = '';
    fieldError('jobError', r.error);
  }
};
$('screenPerm').onclick = () => copilot.openScreenSettings();
$('autoThem').onchange = async (e) => { settings = await copilot.saveSettings({ autoAnswerThem: e.target.checked }); };
$('autoMe').onchange = async (e) => { settings = await copilot.saveSettings({ autoAnswerMe: e.target.checked }); };
$('askForm').onsubmit = (e) => {
  e.preventDefault();
  const q = $('askInput').value.trim();
  if (!q) return;
  copilot.requestAnswer(q);
  $('askInput').value = '';
};

(async () => {
  settings = await copilot.getSettings();
  $('autoThem').checked = Boolean(settings.autoAnswerThem);
  $('autoMe').checked = Boolean(settings.autoAnswerMe);
  renderTranscript();
  const cc = await copilot.checkClaude();
  if (!cc.ok) banner(cc.error);
})();
