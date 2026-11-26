const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, session, systemPreferences, shell, dialog, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const settingsStore = require('./settings');
const { parseState, restoreBounds, createStateSaver, MIN_SIZE } = require('./window-state');
const { Transcriber } = require('./transcriber');
const { checkModels } = require('./asr/engines');
const { AutoAnswer } = require('./auto-answer');
const { readResume, fetchJobDescription } = require('./context');
const { spawn } = require('child_process');
const { ClaudeResponder, findClaude, childEnv } = require('./claude');
const { ClaudeAuth } = require('./claude-auth');
const { sanitizeSettings } = require('./settings-schema');
const { guardAppSession } = require('./permissions');
const { captureScreen } = require('./screen-capture');
const { missingDownloads, downloadSize, modelsDirFor, downloadModels } = require('./models');

// How long macOS needs to remove the hidden overlay before the screenshot.
const HIDE_SETTLE_MS = 150;

// Lets Chromium capture macOS system audio through ScreenCaptureKit
// (macOS 13+) when the page calls getDisplayMedia with audio.
app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

let win;
let settings;
// Installed app: ~/Library/Application Support/meeting-copilot/models. Development: ./models.
const modelsDir = modelsDirFor({ isPackaged: app.isPackaged, appPath: app.getAppPath(), userData: app.getPath('userData') });
const transcriber = new Transcriber(modelsDir);
const claudeAuth = new ClaudeAuth({ spawn, findClaude, env: childEnv });
const PROGRESS_INTERVAL_MS = 200; // how often download progress reaches the window
let downloading = null; // { engine, promise } while a model downloads, so a second click joins it
let responder; // created once the app is ready (needs the userData path)
let transcript = []; // [{ speaker: 'THEM'|'ME', text, ts }]
let running = false;

const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

function readWindowState(file) {
  try {
    return parseState(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // first launch, or the file was removed
  }
}

function createWindow() {
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  const bounds = restoreBounds(readWindowState(stateFile), screen.getAllDisplays(), screen.getPrimaryDisplay());
  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
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
  // The window only ever shows the app's own page; links open in the browser via main.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Remember size and position (the normal bounds, not full screen).
  const saver = createStateSaver({ file: stateFile, onError: (err) => console.error('window position not saved:', err.message) });
  const remember = () => !win.isDestroyed() && saver.schedule(win.getNormalBounds());
  win.on('resize', remember);
  win.on('move', remember);
  win.on('close', () => {
    remember();
    saver.flush();
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// macOS grants Screen Recording to the app that *launched* this one: VS Code
// or Terminal when run with `npm start`, or Electron when opened directly.
function screenPermissionHolder() {
  if (app.isPackaged) return 'Meeting Copilot';
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

function screenCaptureMessage(err) {
  if (err.code === 'permission') {
    const holder = screenPermissionHolder();
    return (
      `Couldn't take a screenshot: macOS hasn't given screen recording access to ${holder}. ` +
      `Turn it on in System Settings > Privacy & Security > Screen & System Audio Recording, then quit ${holder.split(' (')[0]} completely and start again.`
    );
  }
  return `Couldn't take a screenshot: ${err.message}`;
}

// With content protection on, the overlay is already left out of screenshots.
// Otherwise hide it for the moment of capture so it doesn't cover the screen.
async function takeScreenshot() {
  const hide = !settings.contentProtection && win && !win.isDestroyed() && win.isVisible();
  if (hide) {
    win.hide();
    await new Promise((r) => setTimeout(r, HIDE_SETTLE_MS));
  }
  try {
    return await captureScreen({ desktopCapturer, screen, systemPreferences });
  } finally {
    if (hide && !win.isDestroyed()) win.showInactive();
  }
}

let capturing = false;
let captureRun = 0; // bumped by cancelAnswer() so a capture in progress is dropped

function cancelAnswer() {
  captureRun++;
  responder.cancel();
}

// Screenshot the display under the pointer and answer what's on it.
async function analyzeScreen() {
  if (capturing) return;
  capturing = true;
  responder.cancel(); // stop any answer still streaming, so the panel shows only this one
  const run = ++captureRun;
  send('answer:event', { type: 'start', screen: true });
  let screenshot;
  try {
    screenshot = await takeScreenshot();
  } catch (err) {
    console.error('screen capture failed:', err.code || '', err.message);
    send('answer:event', { type: 'error', error: screenCaptureMessage(err) });
    return;
  } finally {
    capturing = false;
  }
  if (run !== captureRun) {
    send('answer:event', { type: 'error', error: 'Screen analysis stopped.' }); // cancelled while capturing
    return;
  }
  responder.answer({
    settings,
    transcript: formatTranscript(),
    screenshot,
    onEvent: (e) => send('answer:event', e.type === 'start' ? { ...e, screen: true } : e),
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

// ---------- Claude sign-in ----------
// A new login means the waiting Claude process may hold the old one; start fresh.
function restartClaude() {
  responder.shutdown();
  responder.prewarm(settings);
}

ipcMain.handle('claude:status', () => claudeAuth.status());
ipcMain.handle('claude:login', async () => {
  const r = await claudeAuth.login({ onUrl: (url) => send('claude:login-url', url) });
  if (r.ok) restartClaude();
  return r;
});
ipcMain.handle('claude:login-code', (_e, code) => claudeAuth.submitCode(code));
ipcMain.on('claude:login-cancel', () => claudeAuth.cancelLogin());
// Only the link the CLI printed is opened, never a URL from the page.
ipcMain.on('claude:open-login', () => claudeAuth.loginUrl && shell.openExternal(claudeAuth.loginUrl));
ipcMain.handle('claude:logout', async () => {
  const r = await claudeAuth.logout();
  if (r.ok) responder.shutdown();
  return r;
});
// The renderer can only ask; the user confirms in a native dialog the page can't draw.
async function confirmInstall() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Install', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Install Claude Code?',
    detail: "This runs Anthropic's official installer (curl -fsSL https://claude.ai/install.sh | bash). Claude Code is installed in your home folder.",
  });
  return response === 0;
}

ipcMain.handle('claude:install', async () => {
  if (!(await confirmInstall())) return { ok: false, cancelled: true };
  const r = await claudeAuth.install({ onOutput: (text) => send('claude:install-output', text) });
  if (r.ok && !findClaude()) return { ok: false, error: 'The installer finished, but Claude Code still could not be found. Restart the app and try again.' };
  return r;
});

// ---------- Speech models ----------
ipcMain.handle('models:status', () => {
  const missing = missingDownloads(settings.engine, modelsDir);
  return { engine: settings.engine, ready: !missing.length, bytes: downloadSize(missing) };
});

ipcMain.handle('models:download', async () => {
  const engine = settings.engine;
  if (downloading && downloading.engine !== engine) {
    return { ok: false, error: `The ${downloading.engine} model is still downloading. Try again when it finishes.` };
  }
  if (!downloading) {
    let lastSent = 0;
    const promise = downloadModels({
      engine,
      modelsDir,
      onProgress: (p) => {
        const now = Date.now();
        if (now - lastSent < PROGRESS_INTERVAL_MS && p.received < p.total) return;
        lastSent = now;
        send('models:progress', p);
      },
    }).finally(() => {
      downloading = null;
    });
    downloading = { engine, promise };
  }
  try {
    await downloading.promise;
    return { ok: true };
  } catch (err) {
    console.error('model download failed:', err.message);
    return { ok: false, error: err.message || String(err) };
  }
});

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
  settings = settingsStore.save(sanitizeSettings(next));
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
  if (missingDownloads(settings.engine, modelsDir).length) {
    return { ok: false, needsModels: true, error: 'Download the speech model first.' };
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
ipcMain.on('screen:analyze', () => analyzeScreen());
ipcMain.on('answer:cancel', () => cancelAnswer());
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
  guardAppSession(session.defaultSession);
  setupDisplayMediaHandler();
  createWindow();

  // Cmd+Shift+Enter: answer now. Cmd+Shift+H: hide/show. Cmd+Shift+X: stop the current answer.
  globalShortcut.register('CommandOrControl+Shift+Return', () => triggerAnswer());
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (win.isVisible()) win.hide();
    else win.showInactive();
  });
  globalShortcut.register('CommandOrControl+Shift+X', () => cancelAnswer());
  // Cmd+Shift+1: screenshot the screen and answer the question or problem on it.
  if (!globalShortcut.register('CommandOrControl+Shift+1', () => analyzeScreen())) {
    console.error('Cmd+Shift+1 is taken by another app; use the Analyze screen button instead.');
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopAll();
  transcriber.kill();
  responder?.shutdown();
  claudeAuth.stopAll();
});
app.on('window-all-closed', () => app.quit());
