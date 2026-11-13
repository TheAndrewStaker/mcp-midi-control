/**
 * The Rig Console host's STATIC content: the shell, the boot script, and the
 * two authenticated assets. Everything in this file is a CONSTANT byte string,
 * identical for every user and every launch, and carries ZERO information
 * about the user, the rig, or the gear. That property is load-bearing: the
 * shell and boot.js are the only two unauthenticated routes the host serves
 * (RIG-CONSOLE-DESIGN.md "Static assets cannot carry a bearer"), so nothing
 * here may ever interpolate runtime data. The data-bearing panels arrive via
 * `GET /api/panels`, bearer-authenticated, fetched by app.js.
 *
 * Auth flow (the design's four steps):
 *   1. `GET /` serves SHELL_HTML: no inline script, one `<script src=/boot.js>`.
 *   2. `GET /boot.js` (also unauthenticated, constant) reads the token from
 *      `location.hash`, POSTs it to `/api/session`, and `replaceState`s the
 *      fragment away so it never lands in history.
 *   3. `/api/session` answers with the `rc_assets` cookie scoped to
 *      `Path=/assets`; boot.js then injects the real asset tags, which
 *      authenticate by that cookie.
 *   4. app.js keeps the bearer in memory and drives `/api/*` with it. The
 *      cookie is NEVER accepted on `/api/*`.
 */
import { CONSOLE_CSS, CONSOLE_INTERACTION_JS, CONSOLE_MAP_JS } from '@mcp-midi-control/rig-console-render';

import { FONTS } from './fonts.generated.js';

/** Step 1: the constant, information-free shell. */
export const SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<title>Rig Console</title>
</head>
<body>
<noscript>The Rig Console needs JavaScript: the page authenticates with a per-launch token and fetches its panels with it. For a script-free view, generate the self-contained file instead (npm run rig-console).</noscript>
<script src="/boot.js"></script>
</body>
</html>
`;

/**
 * Step 2 + 3: the constant boot script. Reads `#t=TOKEN`, trades it for the
 * asset cookie, scrubs the fragment, then injects the stylesheet and app.js
 * with the bearer parked on `window.__rc` for app.js to pick up (same-origin
 * script, same JS realm; the design keeps the bearer in memory, and a window
 * property is memory: it is never persisted, never in a URL, never in a
 * cookie).
 */
export const BOOT_JS = `(function () {
  'use strict';
  function fail(msg) {
    var p = document.createElement('p');
    p.textContent = msg;
    document.body.appendChild(p);
  }
  var m = /(?:^|[#&])t=([A-Za-z0-9_-]+)/.exec(location.hash || '');
  if (!m) {
    fail('No access token in the URL. Open the exact link the open_rig_editor tool returned (it ends in #t=...).');
    return;
  }
  var token = m[1];
  history.replaceState(null, '', location.pathname + location.search);
  fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: '{}'
  }).then(function (r) {
    if (!r.ok) { throw new Error('session refused (' + r.status + ')'); }
    window.__rc = { token: token };
    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/assets/app.css';
    document.head.appendChild(css);
    var js = document.createElement('script');
    js.src = '/assets/app.js';
    document.body.appendChild(js);
  }).catch(function (e) {
    fail('Could not start the console: ' + e.message + '. The link is single-launch; ask the agent to run open_rig_editor again for a fresh one.');
  });
})();
`;

/**
 * The vendored faces (fonts.generated.ts) as servable binary bodies, keyed
 * by their /assets/fonts/<name> path segment. Decoded once at module load.
 */
export const FONT_ASSETS: ReadonlyMap<string, Buffer> = new Map(
  Object.entries(FONTS).map(([name, b64]) => [name, Buffer.from(b64, 'base64')]),
);

/**
 * @font-face prelude for the served stylesheet. The token stacks in
 * theme.ts name 'RigUI' / 'RigMono' FIRST, so these faces engage when the
 * host serves them and fall through to system stacks on the file:// page
 * (which never sees this prelude — a designed degradation).
 */
const FONT_FACE_CSS = `@font-face{font-family:'RigUI';font-weight:400;font-style:normal;font-display:swap;src:url(/assets/fonts/tw400.woff2) format('woff2')}
@font-face{font-family:'RigUI';font-weight:600;font-style:normal;font-display:swap;src:url(/assets/fonts/tw600.woff2) format('woff2')}
@font-face{font-family:'RigUI';font-weight:700;font-style:normal;font-display:swap;src:url(/assets/fonts/tw700.woff2) format('woff2')}
@font-face{font-family:'RigMono';font-weight:400;font-style:normal;font-display:swap;src:url(/assets/fonts/stm400.woff2) format('woff2')}
`;

/** The stylesheet asset: font faces + the console's own CSS, byte-for-byte. */
export const APP_CSS = FONT_FACE_CSS + CONSOLE_CSS;

/**
 * The application asset: fetch the panels with the bearer, inject them, run
 * the console's own interaction wiring, and hold a change stream open so an
 * agent-side edit refreshes the page.
 *
 * The interaction wiring is the render package's `CONSOLE_INTERACTION_JS`
 * verbatim, wrapped in a named function CSP-compatibly (no eval): element
 * listeners bind to freshly-injected nodes on every refresh. Its one
 * document-level Escape listener is re-added per refresh; the stale copies
 * only re-run idempotent clears over detached nodes, and refreshes are rare
 * (one per agent-side edit), so that is accepted rather than forking the
 * shared wiring.
 *
 * The change stream is a bearer-carrying fetch of `/api/events` read as a
 * stream, NOT an EventSource: EventSource cannot send an Authorization
 * header, and the cookie is deliberately never accepted on /api/*.
 */
export const APP_JS = `(function () {
  'use strict';
  var token = (window.__rc || {}).token;
  if (!token) { return; }
  var auth = { 'Authorization': 'Bearer ' + token };

  function wireConsole() {
${CONSOLE_INTERACTION_JS.split('\n').map((l) => (l === '' ? l : `  ${l}`)).join('\n')}
  }

  // The living map (Phase C1): builds from the embedded #rc-map model on
  // every refresh, same statement-body pattern as the interaction wiring.
  function wireMap() {
${CONSOLE_MAP_JS.split('\n').map((l) => (l === '' ? l : `  ${l}`)).join('\n')}
  }

  function refresh() {
    return fetch('/api/panels', { headers: auth }).then(function (r) {
      if (!r.ok) { throw new Error('panels fetch failed (' + r.status + ')'); }
      return r.json();
    }).then(function (p) {
      document.title = p.title;
      var root = document.getElementById('rc-root');
      if (!root) {
        root = document.createElement('div');
        root.id = 'rc-root';
        document.body.appendChild(root);
      }
      root.innerHTML = p.body;
      wireConsole();
      wireMap();
    });
  }

  function watch() {
    fetch('/api/events', { headers: auth }).then(function (r) {
      if (!r.ok || !r.body) { throw new Error('event stream unavailable'); }
      var reader = r.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function (step) {
          if (step.done) { throw new Error('event stream ended'); }
          buf += decoder.decode(step.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\\n\\n')) !== -1) {
            var frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            if (frame.indexOf('data:') !== -1) { refresh(); }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      // The stream drops when the host restarts or idles out; retry gently.
      // The page still works without it (manual reload), so never give up loudly.
      setTimeout(watch, 5000);
    });
  }

  refresh().then(watch).catch(function (e) {
    var p = document.createElement('p');
    p.textContent = 'Could not load the console panels: ' + e.message;
    document.body.appendChild(p);
  });
})();
`;
