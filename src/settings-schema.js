// The settings the app knows, their defaults, and the check every update from
// the window goes through. Anything unknown or invalid is dropped, so the
// renderer can't store arbitrary data or pass odd values to the Claude CLI.

const MAX_TEXT = 50000; // resume, job description, notes, instructions
const MAX_SHORT = 512; // device ids, file names, links

const DEFAULTS = Object.freeze({
  model: 'claude-sonnet-5-5', // fast first words; Opus is slower to start answering
  effort: 'low', // low keeps answers fast enough for a live conversation
  engine: 'parakeet', // local speech-to-text: 'parakeet' or 'zipformer'
  autoAnswerThem: true, // answer the other side's questions automatically
  autoAnswerMe: true, // answer questions you ask, too
  contentProtection: true, // keep the overlay out of your own screen shares
  systemSource: 'loopback', // 'loopback' or an input deviceId (e.g. BlackHole)
  micDeviceId: 'default',
  captureMic: true,
  resume: '', // resume text (typed, or extracted from an uploaded PDF)
  resumeFile: '', // name of the uploaded file, for display
  jobUrl: '',
  jobDescription: '',
  context: '', // other notes: company research, talking points...
  instructions: '', // extra style instructions
});

const oneOf = (...choices) => (v) => (choices.includes(v) ? v : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const text = (max) => (v) => (typeof v === 'string' ? v.slice(0, max) : undefined);

const RULES = {
  model: oneOf('claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'),
  effort: oneOf('low', 'medium', 'high'),
  engine: oneOf('parakeet', 'zipformer'),
  autoAnswerThem: bool,
  autoAnswerMe: bool,
  contentProtection: bool,
  captureMic: bool,
  systemSource: text(MAX_SHORT),
  micDeviceId: text(MAX_SHORT),
  resumeFile: text(MAX_SHORT),
  jobUrl: text(MAX_SHORT),
  resume: text(MAX_TEXT),
  jobDescription: text(MAX_TEXT),
  context: text(MAX_TEXT),
  instructions: text(MAX_TEXT),
};

/** Returns a new object with only the known keys whose values are valid. */
function sanitizeSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [key, check] of Object.entries(RULES)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const value = check(input[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

module.exports = { DEFAULTS, sanitizeSettings, MAX_TEXT };
