// Main-process side of local transcription: owns the speech utility process
// and turns its messages into events.
//
// Events: 'transcript' { source, text, isFinal }
//         'error'      { source, error }
const path = require('path');
const { EventEmitter } = require('events');
const { utilityProcess } = require('electron');

class Transcriber extends EventEmitter {
  constructor(modelsDir) {
    super();
    this.modelsDir = modelsDir;
    this.child = null;
    this.pending = null; // { resolve, reject } while a start is in flight
    this.running = false;
  }

  ensureWorker() {
    if (this.child) return;
    const child = utilityProcess.fork(path.join(__dirname, 'asr', 'worker.js'), [], {
      serviceName: 'Meeting Copilot speech',
      stdio: 'inherit',
    });
    child.on('message', (m) => this.onMessage(m));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      const msg = `The speech engine stopped unexpectedly (exit code ${code}).`;
      if (this.pending) {
        this.pending.reject(new Error(msg));
        this.pending = null;
      } else if (this.running) {
        this.running = false;
        this.emit('error', { source: 'them', error: msg + ' Press Start listening to try again.' });
      }
    });
    this.child = child;
  }

  onMessage(m) {
    if (m.type === 'ready' || m.type === 'start-error') {
      const p = this.pending;
      this.pending = null;
      if (!p) return;
      if (m.type === 'ready') p.resolve();
      else p.reject(new Error(m.error));
    } else if (m.type === 'transcript') {
      if (this.running) this.emit('transcript', m);
    } else if (m.type === 'error') {
      this.emit('error', m);
    }
  }

  /** Loads the engine's model (first time only) and opens one stream per source. */
  start({ engine, sources }) {
    clearTimeout(this.stopTimer);
    this.ensureWorker();
    if (this.pending) this.pending.reject(new Error('Superseded by a newer start.'));
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve: () => {
          this.running = true;
          resolve();
        },
        reject,
      };
      this.child.postMessage({ type: 'start', engine, modelsDir: this.modelsDir, sources });
    });
  }

  send(source, chunk) {
    if (this.running && this.child) this.child.postMessage({ type: 'audio', source, pcm: chunk });
  }

  /** Flushes the last words of each stream; the model stays loaded for next time. */
  stop() {
    if (this.child) this.child.postMessage({ type: 'stop' });
    // Keep accepting the flushed finals for a moment, then go quiet.
    clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => (this.running = false), 1500);
  }

  kill() {
    clearTimeout(this.stopTimer);
    this.running = false;
    if (this.child) {
      const c = this.child;
      this.child = null;
      c.kill();
    }
  }
}

module.exports = { Transcriber };
