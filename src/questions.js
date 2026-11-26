// Decides whether what the other person just said is something to answer.
//
// Parakeet punctuates, so a trailing "?" is a strong signal and wh-words in a
// plain statement ("That's what we do here.") are not. Zipformer has no
// punctuation, so there we fall back to question and prompt words.

// Prompts that ask for an answer without being phrased as a question.
const PROMPT_RE =
  /\b(tell (me|us)|walk (me|us)|take (me|us) through|talk (me |us )?(about|through)|describe|explain|elaborate|give (me|us) (an?|some) (example|sense|overview|idea)|share (an?|some|your|more)|go over|run (me|us) through|what about|how about)\b/i;
// Question openers, for unpunctuated text.
const ASK_RE =
  /(^|[,.]\s*|\b(so|and|okay|ok|now|alright|right)\s+)(what|why|how|when|where|which|who|whose)\b|\b(can|could|would|will|do|did|does|have|has|are|is|were|was|should)\s+(you|your)\b/i;

const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

function looksLikeQuestion(text) {
  const t = text.trim();
  if (!t) return false;
  const punctuated = /[.?!]/.test(t);
  if (punctuated) {
    // The question is almost always in the last sentence or two.
    const sentences = t.split(/(?<=[.?!])\s+/).filter(Boolean);
    const tail = sentences.slice(-2).join(' ');
    const last = sentences[sentences.length - 1];
    if (/\?["')\]]*$/.test(last) && words(last) >= 2) return true;
    return words(tail) >= 3 && PROMPT_RE.test(tail);
  }
  // Unpunctuated: look at the last ~25 words.
  const tail = t.split(/\s+/).slice(-25).join(' ');
  return words(tail) >= 3 && (PROMPT_RE.test(tail) || ASK_RE.test(tail));
}

module.exports = { looksLikeQuestion };
