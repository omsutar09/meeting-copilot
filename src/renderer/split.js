// Draggable divider between the Suggested answer and Transcript panels.
// Drag it, or focus it and use the up/down arrow keys; double-click resets it.
// The split (the answer panel's share of the height) is remembered per profile.
//
// Loaded as a plain script in the window; the pure helpers are also exported
// for the unit tests when this file is required from Node.
(function () {
  const DEFAULT_SPLIT = 0.6; // the original 3:2 layout
  const MIN_SPLIT = 0.2;
  const MAX_SPLIT = 0.8;
  const STEP = 0.05; // one arrow-key press
  const MIN_PANEL_PX = 80; // neither panel gets smaller than this
  const STORAGE_KEY = 'answerSplit';
  const PRIMARY_BUTTON = 0;

  const round2 = (n) => Math.round(n * 100) / 100;

  function clampSplit(ratio) {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return DEFAULT_SPLIT;
    return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, ratio));
  }

  /** Keeps the split in range and each panel at least minPx tall within height. */
  function clampForHeight(ratio, height, minPx = MIN_PANEL_PX) {
    if (!(height > 0)) return DEFAULT_SPLIT;
    const lo = Math.max(MIN_SPLIT, minPx / height);
    const hi = Math.min(MAX_SPLIT, 1 - minPx / height);
    if (lo > hi) return DEFAULT_SPLIT;
    return Math.min(hi, Math.max(lo, clampSplit(ratio)));
  }

  /** The answer share for a pointer at y, given the panels' combined top and height. */
  function splitFromPointer({ y, top, height, minPx = MIN_PANEL_PX }) {
    if (!(height > 0)) return DEFAULT_SPLIT;
    return clampForHeight((y - top) / height, height, minPx);
  }

  /** One keyboard step up (-1) or down (+1). */
  const stepSplit = (ratio, direction) => clampSplit(round2(ratio + direction * STEP));

  function parseStoredSplit(text) {
    if (text === null || text === undefined || text === '') return DEFAULT_SPLIT;
    return clampSplit(Number(text));
  }

  function readStored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null; // storage unavailable: use the default
    }
  }

  function writeStored(ratio) {
    try {
      localStorage.setItem(STORAGE_KEY, String(ratio));
    } catch {}
  }

  function initSplitter() {
    const answer = document.querySelector('section.answer');
    const transcript = document.querySelector('section.transcript');
    const bar = document.getElementById('splitter');
    if (!answer || !transcript || !bar) return;

    // The space the two panels share (not counting the gap the divider sits in),
    // so a ratio maps exactly onto panel heights.
    const panels = () => {
      const a = answer.getBoundingClientRect();
      return { top: a.top, height: a.height + transcript.getBoundingClientRect().height };
    };

    let split = parseStoredSplit(readStored());
    const apply = (ratio) => {
      split = ratio;
      answer.style.flex = `${ratio} 1 0`;
      transcript.style.flex = `${1 - ratio} 1 0`;
      const pct = Math.round(ratio * 100);
      bar.setAttribute('aria-valuenow', String(pct));
      bar.setAttribute('aria-valuetext', `Answer ${pct}%, transcript ${100 - pct}%`);
    };
    const commit = (ratio) => {
      apply(ratio);
      writeStored(ratio);
    };
    apply(split);

    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== PRIMARY_BUTTON || e.ctrlKey) return; // right/ctrl-click opens the context menu
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
    });
    bar.addEventListener('pointermove', (e) => {
      if (!bar.hasPointerCapture(e.pointerId)) return;
      apply(splitFromPointer({ y: e.clientY, ...panels() }));
    });
    // Fires on pointerup and on pointercancel alike.
    bar.addEventListener('lostpointercapture', () => {
      bar.classList.remove('dragging');
      writeStored(split);
    });
    bar.addEventListener('dblclick', () => commit(DEFAULT_SPLIT));
    bar.addEventListener('keydown', (e) => {
      const direction = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      if (!direction) return;
      e.preventDefault();
      commit(clampForHeight(stepSplit(split, direction), panels().height));
    });
  }

  const api = { clampSplit, clampForHeight, splitFromPointer, stepSplit, parseStoredSplit, DEFAULT_SPLIT, MIN_SPLIT, MAX_SPLIT, STEP };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else initSplitter();
})();
