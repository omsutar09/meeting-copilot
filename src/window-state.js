// Remembers the window's size and position between launches.
//
// The saved file is treated as untrusted: anything malformed is ignored. On
// restore, a window that would be mostly off screen (for example its monitor
// was unplugged) opens centred on the main display instead.
const fs = require('fs');

const DEFAULT_SIZE = Object.freeze({ width: 460, height: 680 });
const MIN_SIZE = Object.freeze({ width: 340, height: 300 });
const MAX_DIMENSION = 20000; // larger than any real display arrangement
const MIN_VISIBLE = 0.5; // share of the window that must be on a display to restore it there
const SAVE_DELAY_MS = 500; // wait until the user stops dragging before writing

const KEYS = ['x', 'y', 'width', 'height'];
const isCoordinate = (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_DIMENSION;

/** Reads saved bounds from JSON text or an object. Returns null if anything is off. */
function parseState(input) {
  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (!KEYS.every((k) => isCoordinate(obj[k]))) return null;
  if (!(obj.width > 0 && obj.height > 0)) return null;
  return Object.fromEntries(KEYS.map((k) => [k, Math.round(obj[k])]));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function fitSize(size, area) {
  return {
    width: Math.min(area.width, Math.max(MIN_SIZE.width, size.width)),
    height: Math.min(area.height, Math.max(MIN_SIZE.height, size.height)),
  };
}

function centred(area) {
  const { width, height } = fitSize(DEFAULT_SIZE, area);
  return { width, height, x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2) };
}

/**
 * Where to open the window.
 * @param {{x:number,y:number,width:number,height:number}|null} saved
 * @param {{ workArea: {x:number,y:number,width:number,height:number} }[]} displays
 * @param {{ workArea: object }} primary
 */
function restoreBounds(saved, displays, primary) {
  if (!saved) return centred(primary.workArea);
  // Visible share is measured against the smaller of window and display, so a
  // window bigger than its screen still counts as being on it.
  const scored = displays.map((d) => ({
    area: d.workArea,
    visible: overlap(saved, d.workArea) / Math.min(saved.width * saved.height, d.workArea.width * d.workArea.height),
  }));
  const best = scored.reduce((a, b) => (b.visible > a.visible ? b : a), { visible: 0 });
  if (best.visible < MIN_VISIBLE) return centred(primary.workArea);
  const area = best.area;
  const { width, height } = fitSize(saved, area);
  return {
    x: clamp(saved.x, area.x, area.x + area.width - width),
    y: clamp(saved.y, area.y, area.y + area.height - height),
    width,
    height,
  };
}

/**
 * Debounced, atomic writer for the window bounds.
 * @param {{ file: string, delayMs?: number, onError?: (err: Error) => void }} o
 */
function createStateSaver({ file, delayMs = SAVE_DELAY_MS, onError = () => {} }) {
  let pending = null;
  let timer = null;

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!pending) return;
    const data = pending;
    pending = null;
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      onError(err);
    }
  }

  function schedule(bounds) {
    pending = { ...bounds };
    clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
    timer.unref?.();
  }

  return { schedule, flush };
}

module.exports = { parseState, restoreBounds, createStateSaver, DEFAULT_SIZE, MIN_SIZE };
