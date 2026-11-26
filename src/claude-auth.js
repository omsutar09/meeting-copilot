// Signs in to Claude Code from inside the app, so answers use the user's own
// Claude subscription without opening Terminal. Wraps the CLI's own commands:
//   claude auth status --json    who is signed in
//   claude auth login --claudeai opens the browser; may ask for a pasted code
//   claude auth logout
// and can run Anthropic's official installer when Claude Code is missing.
//
// The process runner and CLI lookup are passed in so this can be tested.

// pipefail: if curl fails (offline), report that instead of running an empty script.
const INSTALL_COMMAND = 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash';
// The installer gets only what it needs, not the app's whole environment.
const INSTALL_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY'];
const LOGIN_HOSTS = new Set(['claude.ai', 'claude.com', 'console.anthropic.com']);
const OUTPUT_LIMIT = 4000; // characters of CLI output kept for error messages
const MAX_CODE_LENGTH = 512;
const STATUS_TIMEOUT_MS = 15000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const CANCELLED = 'Sign-in was cancelled.';
const TIMED_OUT = 'Sign-in timed out. Click Sign in to try again.';
const NOT_INSTALLED = "Claude Code isn't installed. Click Install Claude Code first.";

const SIGNED_OUT = Object.freeze({ loggedIn: false, method: '', email: '', plan: '' });

/** Reads `claude auth status --json` output; anything unreadable counts as signed out. */
function parseAuthStatus(text) {
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    return { ...SIGNED_OUT };
  }
  if (!s || !s.loggedIn) return { ...SIGNED_OUT };
  return { loggedIn: true, method: String(s.authMethod || ''), email: String(s.email || ''), plan: String(s.subscriptionType || '') };
}

/**
 * The sign-in link the CLI printed, only if it points at an Anthropic sign-in
 * page and is complete (followed by whitespace, so not cut off mid-chunk).
 */
function extractLoginUrl(text) {
  for (const m of String(text).matchAll(/(https:\/\/[^\s"'<>]+)\s/g)) {
    try {
      if (LOGIN_HOSTS.has(new URL(m[1]).hostname)) return m[1];
    } catch {}
  }
  return null;
}

const pick = (env, keys) => Object.fromEntries(keys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
const lastLines = (text, n = 3) => text.split('\n').filter(Boolean).slice(-n).join(' ');
const failure = (what, code, out) => ({ ok: false, error: `${what}: ${lastLines(out) || `exit code ${code}`}` });

class ClaudeAuth {
  /**
   * @param {{ spawn: Function, findClaude: () => string|null, env: () => object, loginTimeoutMs?: number }} deps
   */
  constructor({ spawn, findClaude, env, loginTimeoutMs = LOGIN_TIMEOUT_MS }) {
    this.spawn = spawn;
    this.findClaude = findClaude;
    this.env = env;
    this.loginTimeoutMs = loginTimeoutMs;
    this.loginProc = null; // { child, outcome } while a login runs
    this.loginUrl = null;
    this.installing = null; // { child, done } while the installer runs
  }

  // Starts a command. done settles once with its exit code and (trimmed) output,
  // also when the process fails to start.
  start(bin, args, { onOutput, timeoutMs, env = this.env() } = {}) {
    const child = this.spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const done = new Promise((resolve) => {
      let out = '';
      const keep = (d) => {
        out = (out + d).slice(-OUTPUT_LIMIT);
        onOutput?.(String(d));
      };
      child.stdout.on('data', keep);
      child.stderr.on('data', keep);
      child.stdin.on('error', () => {});
      const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : null;
      child.on('error', (err) => keep(err.message + '\n'));
      // 'close' fires after 'exit' and also after a failed start.
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out: out.trim() });
      });
    });
    return { child, done };
  }

  run(bin, args, opts) {
    return this.start(bin, args, opts).done;
  }

  async status() {
    const bin = this.findClaude();
    if (!bin) return { installed: false, ...SIGNED_OUT };
    const { out } = await this.run(bin, ['auth', 'status', '--json'], { timeoutMs: STATUS_TIMEOUT_MS });
    return { installed: true, ...parseAuthStatus(out) };
  }

  /**
   * Starts the browser sign-in. Resolves when the CLI finishes, is cancelled or times out.
   * @param {{ onUrl?: (url: string) => void }} o
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  login({ onUrl } = {}) {
    const bin = this.findClaude();
    if (!bin) return Promise.resolve({ ok: false, error: NOT_INSTALLED });
    this.cancelLogin();
    let seen = '';
    const { child, done } = this.start(bin, ['auth', 'login', '--claudeai'], {
      onOutput: (t) => {
        seen = (seen + t).slice(-OUTPUT_LIMIT);
        const url = !this.loginUrl && extractLoginUrl(seen);
        if (url) {
          this.loginUrl = url;
          onUrl?.(url);
        }
      },
    });
    const proc = { child, outcome: null };
    this.loginProc = proc;
    const timer = setTimeout(() => this.endLogin(proc, TIMED_OUT), this.loginTimeoutMs);
    timer.unref?.(); // never keeps the process alive by itself
    return done.then(({ code, out }) => {
      clearTimeout(timer);
      if (this.loginProc === proc) {
        this.loginProc = null;
        this.loginUrl = null;
      }
      if (proc.outcome) return { ok: false, error: proc.outcome };
      return code === 0 ? { ok: true } : failure('Sign-in failed', code, out);
    });
  }

  endLogin(proc, outcome) {
    if (!proc || proc.outcome) return;
    proc.outcome = outcome;
    if (this.loginProc === proc) {
      this.loginProc = null;
      this.loginUrl = null;
    }
    proc.child.kill();
  }

  /** Sends a code the login page showed, for when the browser can't hand it back. */
  submitCode(code) {
    const proc = this.loginProc;
    if (!proc || typeof code !== 'string') return false;
    const clean = code.trim();
    if (!clean || clean.length > MAX_CODE_LENGTH || /[\r\n]/.test(clean)) return false;
    proc.child.stdin.write(clean + '\n');
    return true;
  }

  cancelLogin() {
    this.endLogin(this.loginProc, CANCELLED);
  }

  async logout() {
    const bin = this.findClaude();
    if (!bin) return { ok: false, error: NOT_INSTALLED };
    const { code, out } = await this.run(bin, ['auth', 'logout'], { timeoutMs: STATUS_TIMEOUT_MS });
    return code === 0 ? { ok: true } : failure('Sign-out failed', code, out);
  }

  /** Runs Anthropic's official Claude Code installer. A second call joins the running one. */
  install({ onOutput } = {}) {
    if (this.installing) return this.installing.done;
    const { child, done } = this.start('/bin/bash', ['-c', INSTALL_COMMAND], { onOutput, env: pick(this.env(), INSTALL_ENV_KEYS) });
    const result = done.then(({ code, out }) => {
      this.installing = null;
      return code === 0 ? { ok: true } : failure('Installing Claude Code failed', code, out);
    });
    this.installing = { child, done: result };
    return result;
  }

  /** Ends any login or install still running (on quit). */
  stopAll() {
    this.cancelLogin();
    this.installing?.child.kill();
  }
}

module.exports = { ClaudeAuth, parseAuthStatus, extractLoginUrl, INSTALL_COMMAND, CANCELLED };
