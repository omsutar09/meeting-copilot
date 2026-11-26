const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

contextBridge.exposeInMainWorld('copilot', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  pickResume: () => ipcRenderer.invoke('resume:pick'),
  fetchJob: (url) => ipcRenderer.invoke('job:fetch', url),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  start: (sources) => ipcRenderer.invoke('session:start', { sources }),
  stop: () => ipcRenderer.send('session:stop'),
  sendAudio: (source, chunk) => ipcRenderer.send('audio', { source, chunk }),
  requestAnswer: (focus) => ipcRenderer.send('answer:request', focus),
  cancelAnswer: () => ipcRenderer.send('answer:cancel'),
  analyzeScreen: () => ipcRenderer.send('screen:analyze'),
  claudeStatus: () => ipcRenderer.invoke('claude:status'),
  claudeLogin: () => ipcRenderer.invoke('claude:login'),
  claudeLoginCode: (code) => ipcRenderer.invoke('claude:login-code', code),
  claudeLoginCancel: () => ipcRenderer.send('claude:login-cancel'),
  openLoginPage: () => ipcRenderer.send('claude:open-login'),
  claudeLogout: () => ipcRenderer.invoke('claude:logout'),
  claudeInstall: () => ipcRenderer.invoke('claude:install'),
  onLoginUrl: on('claude:login-url'),
  onInstallOutput: on('claude:install-output'),
  modelsStatus: () => ipcRenderer.invoke('models:status'),
  downloadModels: () => ipcRenderer.invoke('models:download'),
  onModelsProgress: on('models:progress'),
  clearTranscript: () => ipcRenderer.send('transcript:clear'),
  openScreenSettings: () => ipcRenderer.send('open:screen-settings'),
  onTranscript: on('transcript:update'),
  onInterim: on('transcript:interim'),
  onAnswer: on('answer:event'),
  onStatus: on('status'),
});
