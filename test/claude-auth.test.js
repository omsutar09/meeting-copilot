const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { parseAuthStatus, extractLoginUrl, ClaudeAuth, INSTALL_COMMAND } = require('../src/claude-auth');

// ---------- parseAuthStatus ----------

test('parseAuthStatus reads a signed-in subscription', () => {
  const s = parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', subscriptionType: 'pro', orgId: 'x' }));
  assert.deepEqual(s, { loggedIn: true, method: 'claude.ai', email: 'a@b.c', plan: 'pro' });
});

test('parseAuthStatus reads a signed-out status', () => {
  assert.deepEqual(parseAuthStatus('{"loggedIn": false}'), { loggedIn: false, method: '', email: '', plan: '' });
});

test('parseAuthStatus treats unreadable output as signed out', () => {
  assert.equal(parseAuthStatus('Error: something').loggedIn, false);
  assert.equal(parseAuthStatus('').loggedIn, false);
});

// ---------- extractLoginUrl ----------

test('extractLoginUrl finds the sign-in link in the CLI output', () => {
  const out = "Opening browser to sign in…\nIf the browser didn't open, visit:\nhttps://claude.ai/oauth/authorize?code=true&x=1\nPaste code here if prompted > ";
  assert.equal(extractLoginUrl(out), 'https://claude.ai/oauth/authorize?code=true&x=1');
});

test('extractLoginUrl ignores links that are not Anthropic sign-in pages', () => {
  assert.equal(extractLoginUrl('visit https://evil.example/login'), null);
  assert.equal(extractLoginUrl('nothing here'), null);
});

test('extractLoginUrl accepts the Console sign-in host', () => {
  assert.equal(extractLoginUrl('visit:\nhttps://console.anthropic.com/oauth/authorize?a=b\n'), 'https://console.anthropic.com/oauth/authorize?a=b');
});

// ---------- ClaudeAuth with a fake process runner ----------

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.written = '';
  child.stdin.on('data', (d) => (child.written += d));
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('close', null);
  };
  return child;
}

function fakeSpawn() {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = fakeChild();
    calls.push({ bin, args, opts, child });
    return child;
  };
  return { spawn, calls };
}

const auth = (spawn, bin = '/bin/claude') => new ClaudeAuth({ spawn, findClaude: () => bin, env: () => ({ PATH: '/x' }) });

test('status reports not installed when Claude Code is missing', async () => {
  const { spawn } = fakeSpawn();
  assert.deepEqual(await auth(spawn, null).status(), { installed: false, loggedIn: false, method: '', email: '', plan: '' });
});

test('status runs `claude auth status --json` and parses it', async () => {
  const { spawn, calls } = fakeSpawn();
  const p = auth(spawn).status();
  const { child, args } = calls[0];
  assert.deepEqual(args, ['auth', 'status', '--json']);
  child.stdout.end('{"loggedIn":true,"email":"a@b.c","subscriptionType":"max","authMethod":"claude.ai"}');
  child.emit('close', 0);
  assert.deepEqual(await p, { installed: true, loggedIn: true, method: 'claude.ai', email: 'a@b.c', plan: 'max' });
});

test('login reports the sign-in link and resolves when the CLI finishes', async () => {
  const { spawn, calls } = fakeSpawn();
  const urls = [];
  const a = auth(spawn);
  const done = a.login({ onUrl: (u) => urls.push(u) });
  const { child, args } = calls[0];
  assert.deepEqual(args, ['auth', 'login', '--claudeai']);
  child.stdout.write("If the browser didn't open, visit:\nhttps://claude.ai/oauth/authorize?a=1\n");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(urls, ['https://claude.ai/oauth/authorize?a=1']);
  assert.equal(a.loginUrl, 'https://claude.ai/oauth/authorize?a=1');
  child.emit('close', 0);
  assert.deepEqual(await done, { ok: true });
});

test('submitCode writes the pasted code to the waiting login', async () => {
  const { spawn, calls } = fakeSpawn();
  const a = auth(spawn);
  const done = a.login({});
  assert.equal(a.submitCode('  abc#123  '), true);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls[0].child.written, 'abc#123\n');
  calls[0].child.emit('close', 0);
  await done;
  assert.equal(a.submitCode('late'), false, 'no login in progress');
});

test('login fails with the CLI error text', async () => {
  const { spawn, calls } = fakeSpawn();
  const done = auth(spawn).login({});
  calls[0].child.stderr.write('Invalid code\n');
  await new Promise((r) => setImmediate(r));
  calls[0].child.emit('close', 1);
  const r = await done;
  assert.equal(r.ok, false);
  assert.match(r.error, /Invalid code/);
});

test('a second login replaces the first', async () => {
  const { spawn, calls } = fakeSpawn();
  const a = auth(spawn);
  const first = a.login({});
  const second = a.login({});
  assert.equal(calls[0].child.killed, true);
  assert.deepEqual(await first, { ok: false, error: 'Sign-in was cancelled.' });
  calls[1].child.emit('close', 0);
  assert.deepEqual(await second, { ok: true });
});

test('login without Claude Code installed fails without spawning', async () => {
  const { spawn, calls } = fakeSpawn();
  const r = await auth(spawn, null).login({});
  assert.equal(r.ok, false);
  assert.equal(calls.length, 0);
});

test('logout runs `claude auth logout`', async () => {
  const { spawn, calls } = fakeSpawn();
  const p = auth(spawn).logout();
  assert.deepEqual(calls[0].args, ['auth', 'logout']);
  calls[0].child.emit('close', 0);
  assert.deepEqual(await p, { ok: true });
});

test('install runs the official installer through bash and streams its output', async () => {
  const { spawn, calls } = fakeSpawn();
  const lines = [];
  const p = auth(spawn).install({ onOutput: (t) => lines.push(t) });
  assert.equal(calls[0].bin, '/bin/bash');
  assert.deepEqual(calls[0].args, ['-c', INSTALL_COMMAND]);
  assert.equal(INSTALL_COMMAND, 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash');
  calls[0].child.stdout.write('Installing Claude Code...\n');
  await new Promise((r) => setImmediate(r));
  calls[0].child.emit('close', 0);
  assert.deepEqual(await p, { ok: true });
  assert.deepEqual(lines, ['Installing Claude Code...\n']);
});

test('install reports a failure with the installer output', async () => {
  const { spawn, calls } = fakeSpawn();
  const p = auth(spawn).install({});
  calls[0].child.stderr.write('curl: (6) Could not resolve host\n');
  await new Promise((r) => setImmediate(r));
  calls[0].child.emit('close', 6);
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not resolve host/);
});

// ---------- review fixes ----------

test('a process that fails to start settles instead of hanging', async () => {
  const { spawn, calls } = fakeSpawn();
  const p = auth(spawn).logout();
  calls[0].child.emit('error', new Error('spawn EACCES'));
  calls[0].child.emit('close', -2);
  const r = await p;
  assert.equal(r.ok, false);
  assert.match(r.error, /EACCES/);
});

test('submitCode rejects codes that are not a single short line', async () => {
  const { spawn, calls } = fakeSpawn();
  const a = auth(spawn);
  const done = a.login({});
  assert.equal(a.submitCode('abc\nlogout'), false);
  assert.equal(a.submitCode(42), false);
  assert.equal(a.submitCode('x'.repeat(513)), false);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls[0].child.written, '');
  calls[0].child.emit('close', 0);
  await done;
});

test('the sign-in link is used only once it is complete', async () => {
  const { spawn, calls } = fakeSpawn();
  const urls = [];
  const a = auth(spawn);
  const done = a.login({ onUrl: (u) => urls.push(u) });
  calls[0].child.stdout.write('visit:\nhttps://claude.ai/oauth/authorize?a=1&b=');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(urls, [], 'not yet: the link may continue in the next chunk');
  calls[0].child.stdout.write('2\nPaste code here if prompted > ');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(urls, ['https://claude.ai/oauth/authorize?a=1&b=2']);
  calls[0].child.emit('close', 0);
  await done;
});

test('login gives up after the timeout', async () => {
  const { spawn, calls } = fakeSpawn();
  const a = new ClaudeAuth({ spawn, findClaude: () => '/bin/claude', env: () => ({}), loginTimeoutMs: 10 });
  const r = await a.login({});
  assert.equal(calls[0].child.killed, true);
  assert.deepEqual(r, { ok: false, error: 'Sign-in timed out. Click Sign in to try again.' });
});

test('install gets only an allowlisted environment', async () => {
  const { spawn, calls } = fakeSpawn();
  const env = () => ({ PATH: '/p', HOME: '/h', GITHUB_TOKEN: 'secret', AWS_SECRET_ACCESS_KEY: 'k', https_proxy: 'http://proxy' });
  const p = new ClaudeAuth({ spawn, findClaude: () => null, env }).install({});
  assert.deepEqual(calls[0].opts.env, { PATH: '/p', HOME: '/h', https_proxy: 'http://proxy' });
  calls[0].child.emit('close', 0);
  await p;
});

test('a second install click joins the running install', async () => {
  const { spawn, calls } = fakeSpawn();
  const a = auth(spawn);
  const first = a.install({});
  const second = a.install({});
  assert.equal(calls.length, 1);
  calls[0].child.emit('close', 0);
  assert.deepEqual(await first, await second);
});

test('stopAll ends a running login and install', async () => {
  const { spawn, calls } = fakeSpawn();
  const a = auth(spawn);
  const login = a.login({});
  const install = a.install({});
  a.stopAll();
  assert.equal(calls[0].child.killed, true);
  assert.equal(calls[1].child.killed, true);
  await Promise.all([login, install]);
});
