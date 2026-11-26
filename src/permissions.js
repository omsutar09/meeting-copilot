// Electron grants every permission a page asks for unless told otherwise.
// The app's own page needs only the microphone and screen capture (for system
// audio); web pages loaded by the app (job postings) get nothing at all.

const APP_PERMISSIONS = new Set(['media', 'display-capture']);

const isAppPage = (url) => typeof url === 'string' && url.startsWith('file://');

/**
 * Whether the app's window may use a permission.
 * @param {string} permission
 * @param {{ requestingUrl?: string, requestingOrigin?: string, mediaTypes?: string[], mediaType?: string }} details
 */
function allowAppPermission(permission, details = {}) {
  if (!APP_PERMISSIONS.has(permission)) return false;
  if (!isAppPage(details.requestingUrl || details.requestingOrigin)) return false;
  // Audio only: the app never uses the camera.
  const types = details.mediaTypes || (details.mediaType ? [details.mediaType] : []);
  return !types.includes('video');
}

/** The main window's session: allow only what the app needs. */
function guardAppSession(session) {
  session.setPermissionRequestHandler((_wc, permission, callback, details) => callback(allowAppPermission(permission, details)));
  session.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    allowAppPermission(permission, { ...details, requestingOrigin }),
  );
}

/** A session that shows untrusted web pages: no permissions, no downloads. */
function lockDownSession(session) {
  session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on('will-download', (_event, item) => item.cancel());
}

module.exports = { allowAppPermission, guardAppSession, lockDownSession };
