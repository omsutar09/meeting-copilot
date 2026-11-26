// Takes a screenshot of the display under the mouse pointer, sized for Claude.
//
// Electron's APIs are passed in rather than required here, so the logic can be
// tested without Electron. On macOS this needs Screen Recording permission,
// the same permission the app already uses to hear the other side's audio.

// Claude's recommended longest edge: larger images are downscaled anyway and
// cost more time to upload and read.
const MAX_EDGE = 1568;
const JPEG_QUALITY = 80;

function captureError(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Scales a size down so its longest edge is at most maxEdge. Returns a new object. */
function fitSize({ width, height }, maxEdge = MAX_EDGE) {
  if (!(width > 0 && height > 0)) throw new Error(`Invalid image size: ${width}x${height}`);
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** The capture source for a display, or the first source if that display isn't listed. */
function pickSource(sources, displayId) {
  if (!sources.length) return null;
  return sources.find((s) => s.display_id === String(displayId)) || sources[0];
}

function checkPermission(systemPreferences, platform) {
  if (platform !== 'darwin') return;
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'denied' || status === 'restricted') {
    throw captureError('permission', 'Screen Recording permission is off.');
  }
}

/**
 * @param {{ desktopCapturer: object, screen: object, systemPreferences: object, platform?: string }} deps
 * @returns {Promise<{ mediaType: 'image/jpeg', data: string, width: number, height: number }>} base64 JPEG
 */
async function captureScreen({ desktopCapturer, screen, systemPreferences, platform = process.platform }) {
  checkPermission(systemPreferences, platform);

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  // Capture at native pixels and downscale with 'best' quality below: small
  // code fonts stay sharper than asking macOS for a small thumbnail directly.
  const thumbnailSize = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  const source = pickSource(sources, display.id);
  if (!source) throw captureError('no-screen', 'No screen was found to capture.');

  // Without permission, macOS hands back an empty image instead of an error.
  const image = source.thumbnail;
  if (!image || image.isEmpty()) throw captureError('permission', 'macOS returned an empty screenshot.');

  const size = image.getSize();
  const target = fitSize(size);
  const fitted = target.width === size.width && target.height === size.height ? image : image.resize({ ...target, quality: 'best' });
  return {
    mediaType: 'image/jpeg',
    data: fitted.toJPEG(JPEG_QUALITY).toString('base64'),
    width: target.width,
    height: target.height,
  };
}

module.exports = { captureScreen, fitSize, pickSource, MAX_EDGE };
