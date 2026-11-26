const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeSettings, DEFAULTS, MAX_TEXT } = require('../src/settings-schema');

test('known, valid settings pass through', () => {
  const input = { model: 'claude-opus-5-5', effort: 'high', engine: 'zipformer', autoAnswerMe: false, resume: 'I build things.' };
  assert.deepEqual(sanitizeSettings(input), input);
});

test('unknown keys are dropped', () => {
  assert.deepEqual(sanitizeSettings({ model: 'claude-haiku-5-5', __proto__x: 1, apiKey: 'sk-x', isAdmin: true }), { model: 'claude-haiku-5-5' });
});

test('values outside the allowed choices are dropped', () => {
  assert.deepEqual(sanitizeSettings({ model: '--dangerously-skip-permissions', effort: 'max', engine: 'whisper' }), {});
});

test('wrong types are dropped', () => {
  assert.deepEqual(sanitizeSettings({ contentProtection: 'yes', captureMic: 1, resume: { a: 1 }, micDeviceId: 42 }), {});
});

test('long text is cut to MAX_TEXT', () => {
  const out = sanitizeSettings({ resume: 'x'.repeat(MAX_TEXT + 10) });
  assert.equal(out.resume.length, MAX_TEXT);
});

test('non-objects give an empty result', () => {
  assert.deepEqual(sanitizeSettings(null), {});
  assert.deepEqual(sanitizeSettings('model=x'), {});
  assert.deepEqual(sanitizeSettings([1, 2]), {});
});

test('the input object is not modified', () => {
  const input = { model: 'bad', effort: 'low' };
  sanitizeSettings(input);
  assert.deepEqual(input, { model: 'bad', effort: 'low' });
});

test('every default value passes its own check', () => {
  assert.deepEqual(sanitizeSettings(DEFAULTS), DEFAULTS);
});
