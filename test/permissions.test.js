const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { allowAppPermission, guardAppSession, lockDownSession } = require('../src/permissions');

const APP = 'file:///Applications/Meeting%20Copilot.app/Contents/Resources/app.asar/src/renderer/index.html';

// ---------- allowAppPermission ----------

test('the app page may use the microphone', () => {
  assert.equal(allowAppPermission('media', { requestingUrl: APP, mediaTypes: ['audio'] }), true);
});

test('the app page may capture the screen for system audio', () => {
  assert.equal(allowAppPermission('display-capture', { requestingUrl: APP }), true);
});

test('the camera is never allowed', () => {
  assert.equal(allowAppPermission('media', { requestingUrl: APP, mediaTypes: ['audio', 'video'] }), false);
});

test('other permissions are refused for the app page', () => {
  for (const p of ['geolocation', 'notifications', 'clipboard-read', 'midi', 'openExternal']) {
    assert.equal(allowAppPermission(p, { requestingUrl: APP }), false, p);
  }
});

test('web pages get nothing, even the microphone', () => {
  assert.equal(allowAppPermission('media', { requestingUrl: 'https://jobs.example.com/x', mediaTypes: ['audio'] }), false);
  assert.equal(allowAppPermission('media', { requestingOrigin: 'https://evil.example', mediaTypes: ['audio'] }), false);
  assert.equal(allowAppPermission('media', {}), false);
});

test('a permission check from the app origin is allowed for the microphone', () => {
  assert.equal(allowAppPermission('media', { requestingOrigin: 'file:///', mediaType: 'audio' }), true);
});

// ---------- session wiring ----------

function fakeSession() {
  const s = new EventEmitter();
  s.setPermissionRequestHandler = (fn) => (s.request = fn);
  s.setPermissionCheckHandler = (fn) => (s.check = fn);
  return s;
}

const ask = (s, permission, details) => new Promise((resolve) => s.request(null, permission, resolve, details));

test('guardAppSession answers requests and checks with allowAppPermission', async () => {
  const s = fakeSession();
  guardAppSession(s);
  assert.equal(await ask(s, 'media', { requestingUrl: APP, mediaTypes: ['audio'] }), true);
  assert.equal(await ask(s, 'geolocation', { requestingUrl: APP }), false);
  assert.equal(s.check(null, 'media', 'file:///', { mediaType: 'audio' }), true);
  assert.equal(s.check(null, 'media', 'https://evil.example', { mediaType: 'audio' }), false);
});

test('lockDownSession refuses every permission and cancels downloads', async () => {
  const s = fakeSession();
  lockDownSession(s);
  assert.equal(await ask(s, 'media', { requestingUrl: 'https://jobs.example.com', mediaTypes: ['audio'] }), false);
  assert.equal(s.check(null, 'clipboard-read', 'https://jobs.example.com', {}), false);
  let cancelled = false;
  s.emit('will-download', {}, { cancel: () => (cancelled = true) });
  assert.equal(cancelled, true);
});
