const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, session, systemPreferences, shell, dialog } = require('electron');
const path = require('path');
const settingsStore = require('./settings');
const { Transcriber } = require('./transcriber');
const { checkModels } = require('./asr/engines');
const { AutoAnswer } = require('./auto-answer');
const { readResume, fetchJobDescription } = require('./context');
const { ClaudeResponder } = require('./claude');

// Lets Chromium capture macOS system audio through ScreenCaptureKit
// (macOS 13+) when the page calls getDisplayMedia with audio.
app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

let win;
let settings;
const modelsDir = path.join(app.getAppPath(), 'models');
const transcriber = new Transcriber(modelsDir);
let responder; // created once the app is ready (needs the userData path)
let transcript = []; // [{ speaker: 'THEM'|'ME', text, ts }]
let running = false;

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

function createWindow() {
  win = new BrowserWindow({
    width: 460,
    height: 680,
    minWidth: 340,
    minHeight: 300,
    alwaysOnTop: true,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(Boolean(settings.contentProtection));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// macOS grants Screen Recording to the app that *launched* this one: VS Code
// or Terminal when run with `npm start`, or Electron when opened directly.
function screenPermissionHolder() {
  const known = {
    'com.microsoft.VSCode': 'Visual Studio Code',
    'com.apple.Terminal': 'Terminal',
    'com.googlecode.iterm2': 'iTerm',
    'dev.warp.Warp-Stable': 'Warp',
  };
  return known[process.env.__CFBundleIdentifier] || 'Electron (or the app you started Meeting Copilot from)';
}

function screenPermissionError() {
  return (
    `macOS hasn't given screen and system audio access to ${screenPermissionHolder()}, which this app needs to hear the other side of the call. ` +
    `Turn it on in System Settings > Privacy & Security > Screen & System Audio Recording, then quit ${screenPermissionHolder().split(' (')[0]} completely and start again. ` +
    `Or pick a loopback device such as BlackHole under "Other side's audio" in Settings.`
  );
}

// Answer getDisplayMedia() with the main screen plus system audio loopback.
// The renderer drops the video track immediately; only audio is used.
function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources.length) throw new Error('no screens');
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch((err) => {
          console.error('display media error:', err.message);
          send('status', { source: 'them', status: 'error', error: screenPermissionError() });
          // Electron throws if a video request is answered without video;
          // the renderer's getDisplayMedia call times out instead.
          try {
            callback({});
          } catch {}
        });
    },
    { useSystemPicker: false },
  );
}

function formatTranscript(maxChars = 6000) {
  const lines = transcript.map((t) => `${t.speaker}: ${t.text}`);
  let out = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.length + lines[i].length > maxChars) break;
    out = lines[i] + '\n' + out;
  }
  return out.trim();
}

function addFinal(speaker, text) {
  const last = transcript[transcript.length - 1];
  // Merge consecutive fragments from the same speaker into one line.
  if (last && last.speaker === speaker && Date.now() - last.ts < 8000) {
    last.text += ' ' + text;
    last.ts = Date.now();
  } else {
    transcript.push({ speaker, text, ts: Date.now() });
  }
  if (transcript.length > 400) transcript = transcript.slice(-400);
  send('transcript:update', transcript);
}

// speaker: who asked, when the answer was triggered automatically.
function triggerAnswer(focus, speaker) {
  responder.answer({
    settings,
    transcript: formatTranscript(),
    focus,
    speaker,
    onEvent: (e) => send('answer:event', e.type === 'start' ? { ...e, auto: speaker || null } : e),
  });
}

const autoAnswer = new AutoAnswer({
  trigger: (speaker) => {
    triggerAnswer(undefined, speaker);
  },
  log: (msg) => console.log('[auto-answer]', msg),
});

const speakerOf = (source) => (source === 'them' ? 'THEM' : 'ME');

transcriber.on('transcript', ({ source, text, isFinal }) => {
  const speaker = speakerOf(source);
  if (!isFinal) return send('transcript:interim', { speaker, text });
  addFinal(speaker, text);
  send('transcript:interim', { speaker, text: '' });
  autoAnswer.onFinal(speaker, text, settings); // a final line means the speaker paused
});
transcriber.on('error', ({ source, error }) => send('status', { source, status: 'error', error }));

function stopAll() {
  if (running) transcriber.stop();
  running = false;
}

// ---------- IPC ----------
ipcMain.handle('settings:get', () => settingsStore.publicView(settings));
ipcMain.handle('claude:check', () => ClaudeResponder.check());

ipcMain.handle('resume:pick', async () => {
  const pick = await dialog.showOpenDialog(win, {
    title: 'Choose your resume',
    properties: ['openFile'],
    filters: [{ name: 'Resume', extensions: ['pdf', 'txt', 'md'] }],
  });
  if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
  try {
    const r = await readResume(pick.filePaths[0]);
    settings = settingsStore.save({ resume: r.text, resumeFile: r.name });
    responder.prewarm(settings);
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('job:fetch', async (_e, url) => {
  try {
    const r = await fetchJobDescription(String(url || '').trim());
    settings = settingsStore.save({ jobUrl: r.url, jobDescription: r.text });
    responder.prewarm(settings);
    return { ok: true, ...r };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle('settings:save', (_e, next) => {
  settings = settingsStore.save(next);
  responder.prewarm(settings);
  win.setContentProtection(Boolean(settings.contentProtection));
  return settingsStore.publicView(settings);
});

ipcMain.handle('session:start', async (_e, { sources }) => {
  const cc = ClaudeResponder.check();
  if (!cc.ok) return { ok: false, error: cc.error };
  if (process.platform === 'darwin') {
    const mic = await systemPreferences.askForMediaAccess('microphone').catch(() => false);
    if (!mic && sources.includes('me')) return { ok: false, error: 'Microphone access was denied. Allow it in System Settings > Privacy & Security > Microphone.' };
    const usesLoopback = !settings.systemSource || settings.systemSource === 'loopback';
    const screen = systemPreferences.getMediaAccessStatus('screen');
    // 'not-determined' is let through: the capture request makes macOS ask.
    if (usesLoopback && (screen === 'denied' || screen === 'restricted')) {
      return { ok: false, error: screenPermissionError(), screenPermission: true };
    }
  }
  try {
    checkModels(settings.engine, modelsDir);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  stopAll();
  try {
    await transcriber.start({ engine: settings.engine, sources });
  } catch (err) {
    return { ok: false, error: `Couldn't start the speech engine: ${err.message}` };
  }
  running = true;
  responder.prewarm(settings);
  for (const source of sources) send('status', { source, status: 'connected' });
  return { ok: true };
});

ipcMain.on('session:stop', () => stopAll());

ipcMain.on('audio', (_e, { source, chunk }) => {
  if (running) transcriber.send(source, Buffer.from(chunk));
});

ipcMain.on('answer:request', (_e, focus) => triggerAnswer(focus));
ipcMain.on('answer:cancel', () => responder.cancel());
ipcMain.on('transcript:clear', () => {
  transcript = [];
  autoAnswer.clear();
  send('transcript:update', transcript);
});
ipcMain.on('open:screen-settings', () =>
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'),
);

// ---------- App lifecycle ----------
app.whenReady().then(() => {
  settings = settingsStore.load();
  responder = new ClaudeResponder({ cwd: path.join(app.getPath('userData'), 'claude-workdir') });
  responder.prewarm(settings);
  setupDisplayMediaHandler();
  createWindow();

  // Cmd+Shift+Enter: answer now. Cmd+Shift+H: hide/show. Cmd+Shift+X: stop the current answer.
  globalShortcut.register('CommandOrControl+Shift+Return', () => triggerAnswer());
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (win.isVisible()) win.hide();
    else win.showInactive();
  });
  globalShortcut.register('CommandOrControl+Shift+X', () => responder.cancel());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopAll();
  transcriber.kill();
  responder?.shutdown();
});
app.on('window-all-closed', () => app.quit());
