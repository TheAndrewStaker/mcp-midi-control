/**
 * Golden: the Rig Console host's security posture, end to end against a real
 * in-process listener (no browser needed).
 *
 * Asserts the design's checklist (RIG-CONSOLE-DESIGN.md "Security"):
 *   - `GET /` and `GET /boot.js` are the ONLY unauthenticated routes, and both
 *     serve constant, information-free bytes.
 *   - A wrong `Host` header is refused on every route (anti-DNS-rebinding).
 *   - A state-changing method without an allowlisted `Origin` is refused.
 *   - `/api/*` requires the bearer; the asset cookie is NEVER accepted there.
 *   - `/assets/*` requires the cookie issued by `/api/session`.
 *   - The cookie is scoped: Path=/assets, SameSite=Strict, HttpOnly.
 *   - The exact CSP string (asserted byte-for-byte: a subtly wrong CSP fails
 *     open in one direction and breaks the app in the other).
 *   - `Access-Control-Allow-Origin` is never emitted.
 *   - `/api/*` responses are `Cache-Control: no-store`.
 *   - Failed checks return the fixed terse body with no detail echoed.
 *   - `/api/events` is a live SSE stream: a store write reaches the browser.
 *   - The idle window closes the listener.
 *
 * Run: npx tsx scripts/verify-webhost-security.ts   (registered in preflight)
 */
import * as http from 'node:http';

import {
  startRigConsoleHost,
} from '../packages/server-all/src/server/webhost/host.js';
// IMPORTANT: the same specifier the host itself imports, so the emit lands on
// the SAME module instance the host subscribed through (a src-relative import
// here would be a second copy of the subscriber set, and the SSE case would
// pass vacuously never exercising the real channel).
import { emitRigStoreWrite } from '@mcp-midi-control/core/protocol-generic/openrig/index.js';
import type { RenderInput } from '@mcp-midi-control/rig-console-render';
import { joinSongs } from '@mcp-midi-control/rig-console-render';

let failures = 0;
const ok = (msg: string): void => console.log(`  ok    ${msg}`);
const fail = (msg: string): void => { console.error(`  FAIL  ${msg}`); failures++; };
const assert = (cond: boolean, msg: string): void => { cond ? ok(msg) : fail(msg); };

/** The design's CSP, byte-for-byte (style-src-attr deviation recorded in host.ts). */
const EXPECTED_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; "
  + "img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; "
  + "frame-ancestors 'none'";

interface Res { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, path: string, opts: {
  method?: string;
  headers?: Record<string, string>;
  host?: string;
  body?: string;
} = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: opts.method ?? 'GET',
      headers: { Host: opts.host ?? `127.0.0.1:${port}`, ...opts.headers },
    }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => { body += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** A minimal, deterministic panel model: no rig, empty set, absent sources. */
function stubSources(): RenderInput {
  return {
    view: undefined,
    card: undefined,
    join: joinSongs([], undefined),
    sources: [
      { id: 'rig', label: 'Rig manifest', path: '(stub)', state: 'absent', detail: 'stub' },
      { id: 'card', label: 'Card capture', path: '(stub)', state: 'absent', detail: 'stub' },
      { id: 'setlist', label: 'Setlist', path: '(stub)', state: 'absent', detail: 'stub' },
    ],
    generatedAt: '2026-01-01 00:00',
    command: 'verify-webhost-security',
  };
}

async function main(): Promise<void> {
  const host = await startRigConsoleHost({ port: 0, idleMs: 10 * 60_000, sources: stubSources });
  const port = host.port;
  const token = /#t=([A-Za-z0-9_-]+)$/.exec(host.url)?.[1] ?? '';
  const origin = `http://127.0.0.1:${port}`;

  try {
    assert(token.length >= 40, 'launch URL carries a fragment token of randomBytes(32) length');

    // ── the two constant unauthenticated routes ─────────────────────────────
    const shell = await request(port, '/');
    assert(shell.status === 200, 'GET / serves the shell unauthenticated');
    assert(shell.body.includes('<script src="/boot.js"></script>'), 'shell contains exactly the boot script tag');
    assert(!shell.body.includes(token), 'shell never contains the token');
    assert(shell.headers['content-security-policy'] === EXPECTED_CSP, `CSP is byte-exact (got: ${String(shell.headers['content-security-policy'])})`);
    assert(shell.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff');
    assert(shell.headers['referrer-policy'] === 'no-referrer', 'Referrer-Policy: no-referrer');
    assert(shell.headers['access-control-allow-origin'] === undefined, 'no Access-Control-Allow-Origin, ever');

    const boot = await request(port, '/boot.js');
    assert(boot.status === 200 && boot.body.includes('location.hash'), 'GET /boot.js serves the constant boot script');

    // ── Host header is checked on every route ───────────────────────────────
    const rebind = await request(port, '/', { host: 'evil.example:80' });
    assert(rebind.status === 403 && rebind.body === 'forbidden', 'wrong Host -> 403 with the fixed terse body');
    const rebindApi = await request(port, '/api/panels', { host: `127.0.0.1:${port + 1}`, headers: { Authorization: `Bearer ${token}` } });
    assert(rebindApi.status === 403, 'wrong Host port is refused even with a valid bearer');

    // ── auth: /api/* is bearer-only ─────────────────────────────────────────
    assert((await request(port, '/api/panels')).status === 403, 'GET /api/panels without a bearer -> 403');
    assert((await request(port, '/api/panels', { headers: { Authorization: 'Bearer nope' } })).status === 403, 'wrong bearer -> 403');
    const panels = await request(port, '/api/panels', { headers: { Authorization: `Bearer ${token}` } });
    assert(panels.status === 200, 'correct bearer -> 200');
    assert(panels.headers['cache-control'] === 'no-store', '/api/* is Cache-Control: no-store');
    const parsed = JSON.parse(panels.body) as { title: string; body: string };
    assert(typeof parsed.title === 'string' && parsed.body.includes('class="wrap"'), 'panels payload carries the console body');

    // ── the session trade ───────────────────────────────────────────────────
    assert((await request(port, '/api/session', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).status === 403,
      'POST /api/session without an Origin -> 403 (state-changing methods require it)');
    assert((await request(port, '/api/session', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'http://evil.example' } })).status === 403,
      'POST /api/session with a foreign Origin -> 403');
    assert((await request(port, '/api/session', { method: 'POST', headers: { Authorization: 'Bearer nope', Origin: origin } })).status === 403,
      'POST /api/session with a wrong token -> 403');
    const session = await request(port, '/api/session', { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: origin } });
    assert(session.status === 204, 'POST /api/session with token + Origin -> 204');
    const setCookie = ([] as string[]).concat(session.headers['set-cookie'] ?? []).join('\n');
    assert(/^rc_assets=[A-Za-z0-9_-]+; Path=\/assets; SameSite=Strict; HttpOnly$/m.test(setCookie),
      `asset cookie is scoped Path=/assets, SameSite=Strict, HttpOnly (got: ${setCookie})`);
    const cookieVal = /rc_assets=([A-Za-z0-9_-]+)/.exec(setCookie)?.[1] ?? '';

    // ── assets: cookie-gated; cookie never accepted on /api ─────────────────
    assert((await request(port, '/assets/app.js')).status === 403, 'GET /assets/app.js without the cookie -> 403');
    assert((await request(port, '/assets/app.js', { headers: { Cookie: 'rc_assets=nope' } })).status === 403, 'wrong cookie -> 403');
    const appJs = await request(port, '/assets/app.js', { headers: { Cookie: `rc_assets=${cookieVal}` } });
    assert(appJs.status === 200 && (appJs.headers['content-type'] ?? '').includes('javascript'), 'cookie unlocks /assets/app.js');
    const appCss = await request(port, '/assets/app.css', { headers: { Cookie: `rc_assets=${cookieVal}` } });
    assert(appCss.status === 200 && appCss.body.includes(':root{'), 'cookie unlocks /assets/app.css (the console stylesheet)');
    assert((await request(port, '/api/panels', { headers: { Cookie: `rc_assets=${cookieVal}` } })).status === 403,
      'the asset cookie is NEVER accepted on /api/*');

    // ── unauthenticated-route allowlist is exactly { /, /boot.js } ──────────
    for (const p of ['/assets/app.js', '/assets/app.css', '/api/panels', '/api/events']) {
      assert((await request(port, p)).status === 403, `unauthenticated ${p} -> 403 (allowlist is / and /boot.js only)`);
    }
    assert((await request(port, '/nope')).status === 404, 'unknown path -> 404 terse');
    assert((await request(port, '/', { method: 'PUT' })).status === 405, 'unsupported method -> 405');

    // ── SSE: a store write reaches the stream ───────────────────────────────
    const sse = await new Promise<{ status: number; firstFrames: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/api/events', method: 'GET',
        headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` },
      }, (res) => {
        let buf = '';
        const timer = setTimeout(() => { req.destroy(); resolve({ status: res.statusCode ?? 0, firstFrames: buf }); }, 2000);
        res.on('data', (c: Buffer) => {
          buf += c.toString('utf8');
          if (buf.includes('"kind":"manifest"')) {
            clearTimeout(timer);
            req.destroy();
            resolve({ status: res.statusCode ?? 0, firstFrames: buf });
          }
        });
        setTimeout(() => emitRigStoreWrite({ kind: 'manifest', source: '(test)', created: false }), 150);
      });
      req.on('error', reject);
      req.end();
    });
    assert(sse.status === 200, 'GET /api/events with the bearer opens the stream');
    assert(sse.firstFrames.includes('retry: 5000'), 'stream opens with a retry hint');
    assert(sse.firstFrames.includes('data: {"kind":"manifest"'), 'a store write is pushed to the stream');
  } finally {
    await host.close();
  }

  // ── idle expiry closes the listener ───────────────────────────────────────
  const shortLived = await startRigConsoleHost({ port: 0, idleMs: 120, sources: stubSources });
  await new Promise((r) => setTimeout(r, 600));
  const dead = await request(shortLived.port, '/').then(() => false, () => true);
  assert(dead, 'the listener closes itself after the idle window');
  await shortLived.close().catch(() => undefined);

  console.log(failures === 0 ? '\nverify-webhost-security passed.' : `\n${failures} webhost security assertion(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-webhost-security crashed:', err);
  process.exit(1);
});
