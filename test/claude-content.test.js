const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUserContent } = require('../src/claude');

const shot = { mediaType: 'image/jpeg', data: 'QUJD', width: 1568, height: 1018 };

test('without a screenshot, the content is the same text message as before', () => {
  const content = buildUserContent({ transcript: 'THEM: How are you?' });
  assert.equal(
    content,
    '<transcript>\nTHEM: How are you?\n</transcript>\n\nSuggest what I should say next in response to the latest question or point from THEM.',
  );
});

test('an empty transcript is marked as such', () => {
  assert.match(buildUserContent({ transcript: '' }), /\(no speech captured yet\)/);
});

test('a typed focus question is passed through', () => {
  assert.match(buildUserContent({ transcript: 'x', focus: '  explain CAP  ' }), /The user asks for help with: explain CAP$/);
});

test('a question I asked aloud is answered for me', () => {
  assert.match(buildUserContent({ transcript: 'x', speaker: 'ME' }), /My latest line \(ME\) is a question/);
});

test('with a screenshot, the content is an image block followed by a text block', () => {
  const content = buildUserContent({ transcript: 'THEM: Try this one.', screenshot: shot });
  assert.ok(Array.isArray(content));
  assert.equal(content.length, 2);
  assert.deepEqual(content[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } });
  assert.equal(content[1].type, 'text');
});

test('the screenshot text keeps the transcript and asks for the on-screen problem to be solved', () => {
  const [, text] = buildUserContent({ transcript: 'THEM: Try this one.', screenshot: shot });
  assert.match(text.text, /<transcript>\nTHEM: Try this one\.\n<\/transcript>/);
  assert.match(text.text, /screenshot of my screen/i);
  assert.match(text.text, /coding problem/i);
  assert.match(text.text, /complexity/i);
});

test('a typed focus is added to the screenshot instruction', () => {
  const [, text] = buildUserContent({ transcript: '', screenshot: shot, focus: 'only part 2' });
  assert.match(text.text, /The user also says: only part 2/);
});
