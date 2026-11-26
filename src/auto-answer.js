// Decides when to answer automatically. Each speaker has its own toggle:
//   settings.autoAnswerThem  answer questions from the other side (system audio)
//   settings.autoAnswerMe    answer questions you ask (your microphone)
const { looksLikeQuestion } = require('./questions');

// Without headphones the mic also hears the other side, so the same question
// can arrive from both sources a moment apart. Answer it only once.
const ECHO_WINDOW_MS = 2500;

class AutoAnswer {
  /**
   * @param {{ trigger: (speaker: 'THEM'|'ME') => void, log?: (msg: string) => void }} o
   */
  constructor({ trigger, log = () => {} }) {
    this.trigger = trigger;
    this.log = log;
    this.pending = { THEM: '', ME: '' }; // finished text since the last answer
    this.last = { at: 0, speaker: null };
  }

  enabled(speaker, settings) {
    return Boolean(speaker === 'THEM' ? settings.autoAnswerThem : settings.autoAnswerMe);
  }

  /** Call with each finished line of speech. */
  onFinal(speaker, text, settings, now = Date.now()) {
    if (!this.enabled(speaker, settings)) {
      this.pending[speaker] = '';
      return false;
    }
    const pending = `${this.pending[speaker]} ${text}`.trim();
    if (!looksLikeQuestion(pending)) {
      // Keep a little context in case the question spans several lines.
      this.pending[speaker] = pending.length > 1500 ? pending.slice(-600) : pending;
      this.log(`${speaker}: no question yet: "${text}"`);
      return false;
    }
    this.pending = { THEM: '', ME: '' };
    if (this.last.speaker && this.last.speaker !== speaker && now - this.last.at < ECHO_WINDOW_MS) {
      this.log(`${speaker}: question skipped (just answered ${this.last.speaker}; probably the mic hearing the speakers): "${text}"`);
      return false;
    }
    this.last = { at: now, speaker };
    this.log(`${speaker}: question detected, answering: "${text}"`);
    this.trigger(speaker);
    return true;
  }

  clear() {
    this.pending = { THEM: '', ME: '' };
  }
}

module.exports = { AutoAnswer };
