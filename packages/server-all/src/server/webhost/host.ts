/**
 * The Rig Console HTTP host: a lazy, loopback-only, token-gated `node:http`
 * listener serving the read-only console. Plan of record:
 * `docs/design/RIG-CONSOLE-DESIGN.md` (security posture, auth flow, CSP);
 * `docs/design/RIG-CONSOLE-WORKPLAN.md` chunk 3 (read-only first).
 *
 * SECURITY POSTURE, implemented exactly as designed:
 *   - Binds `127.0.0.1` explicitly; port from `MCP_WEB_UI_PORT` or ephemeral.
 *   - Per-launch bearer token, `randomBytes(32)`, memory only, compared via
 *     sha256 + `timingSafeEqual` (hashing first equalises length so the
 *     comparison is constant-time for any candidate).
 *   - The token travels in the URL FRAGMENT (`#t=...`), which never reaches
 *     this server, never lands in `Referer`, and is `replaceState`d away.
 *   - `Host` must match `127.0.0.1:PORT` / `localhost:PORT` exactly on EVERY
 *     request (anti-DNS-rebinding); `Origin`, when present, is allowlisted
 *     the same way and REQUIRED on state-changing methods.
 *   - Exactly two unauthenticated routes: `GET /` and `GET /boot.js`, both
 *     constant and information-free (assets.ts). `/assets/*` authenticates by
 *     the `rc_assets` cookie (Path=/assets, SameSite=Strict, HttpOnly);
 *     `/api/*` by bearer only, and the cookie is NEVER accepted there.
 *   - Failed checks: 403, fixed terse body, no detail echoed. No
 *     `Access-Control-Allow-Origin` header exists anywhere in this file.
 *   - Idle expiry: the listener closes after `idleMs` (default 30 min) with
 *     no authenticated request; the next `open_rig_editor` mints a fresh
 *     token. This bounds the one real leak (the URL rides a tool result into
 *     the host transcript).
 *
 * ONE deliberate deviation from the design's CSP string:
 * `style-src 'self'; style-src-attr 'unsafe-inline'` instead of plain
 * `style-src 'self'`. The console body carries per-element style ATTRIBUTES
 * (the card pads wear their device-stored colour via `style="--pad:#..."`),
 * which `style-src 'self'` blocks. `style-src-attr 'unsafe-inline'` re-admits
 * attributes only: inline `<style>` ELEMENTS stay blocked, and script-src
 * remains strict (no inline script anywhere). Recorded here and asserted
 * byte-exactly by `scripts/verify-webhost-security.ts`.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { Socket } from 'node:net';

import { onRigStoreWrite } from '@mcp-midi-control/core/protocol-generic/openrig/index.js';
import { renderConsoleBody } from '@mcp-midi-control/rig-console-render';

import { APP_CSS, APP_JS, BOOT_JS, FONT_ASSETS, SHELL_HTML } from './assets.js';
import { defaultConsoleSources, type ConsoleSourcesProvider } from './sources.js';

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const DEFAULT_IDLE_MS = 30 * 60_000;

export interface RigConsoleHostOptions {
  /** Listen port. Default: `MCP_WEB_UI_PORT`, else 0 (ephemeral). */
  port?: number;
  /** Idle window after which the listener closes. Default 30 minutes. */
  idleMs?: number;
  /** Panel-data provider. Default: live rig, card/setlist labelled absent. */
  sources?: ConsoleSourcesProvider;
}

export interface RigConsoleHost {
  /** The tokenised URL to hand the user: `http://127.0.0.1:PORT/#t=TOKEN`. */
  url: string;
  port: number;
  close(): Promise<void>;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

/** Constant-time equality of two secrets (hash first: equal length always). */
function secretEquals(candidate: string, actual: string): boolean {
  return timingSafeEqual(sha256(candidate), sha256(actual));
}

function bearerOf(req: http.IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (h === undefined || !h.startsWith('Bearer ')) return undefined;
  return h.slice('Bearer '.length);
}

function cookieValue(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (raw === undefined) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return undefined;
}

/** Start the host. Prefer `openRigConsole()` (the lazy singleton) in tools. */
export function startRigConsoleHost(opts: RigConsoleHostOptions = {}): Promise<RigConsoleHost> {
  const token = randomBytes(32).toString('base64url');
  const assetCookie = randomBytes(32).toString('base64url');
  const sources = opts.sources ?? defaultConsoleSources;
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const envPort = Number.parseInt(process.env.MCP_WEB_UI_PORT ?? '', 10);
  const wantPort = opts.port ?? (Number.isFinite(envPort) ? envPort : 0);

  let port = 0;
  let lastAuthedAt = Date.now();
  const openSockets = new Set<Socket>();
  const sseUnsubscribers = new Set<() => void>();

  const touch = (): void => { lastAuthedAt = Date.now(); };

  const hostOk = (req: http.IncomingMessage): boolean => {
    const host = req.headers.host;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  };
  const originAllowed = (origin: string): boolean =>
    origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;

  const baseHeaders = (): Record<string, string> => ({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });

  const deny = (res: http.ServerResponse, code = 403): void => {
    res.writeHead(code, { ...baseHeaders(), 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(code === 404 ? 'not found' : code === 405 ? 'method not allowed' : 'forbidden');
  };

  const sendConstant = (res: http.ServerResponse, body: string | Buffer, contentType: string, cacheable: boolean): void => {
    res.writeHead(200, {
      ...baseHeaders(),
      'Content-Type': contentType,
      'Cache-Control': cacheable ? 'private, max-age=3600' : 'no-store',
    });
    res.end(body);
  };

  const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    // Anti-rebinding: every request, including the unauthenticated shell.
    if (!hostOk(req)) { deny(res); return; }
    // Origin, when a browser sends one, must be this origin; and any
    // state-changing method must carry it.
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin)) { deny(res); return; }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST' && method !== 'HEAD') { deny(res, 405); return; }
    if (method === 'POST' && origin === undefined) { deny(res); return; }

    // ── the two constant, unauthenticated routes ──────────────────────────
    if (path === '/' ) {
      if (method === 'POST') { deny(res, 405); return; }
      sendConstant(res, SHELL_HTML, 'text/html; charset=utf-8', false);
      return;
    }
    if (path === '/boot.js') {
      if (method === 'POST') { deny(res, 405); return; }
      sendConstant(res, BOOT_JS, 'text/javascript; charset=utf-8', false);
      return;
    }

    // ── the session trade: bearer in, asset cookie out ────────────────────
    if (path === '/api/session') {
      if (method !== 'POST') { deny(res, 405); return; }
      const bearer = bearerOf(req);
      if (bearer === undefined || !secretEquals(bearer, token)) { deny(res); return; }
      touch();
      res.writeHead(204, {
        ...baseHeaders(),
        'Cache-Control': 'no-store',
        'Set-Cookie': `rc_assets=${assetCookie}; Path=/assets; SameSite=Strict; HttpOnly`,
      });
      res.end();
      return;
    }

    // ── cookie-scoped constant assets ─────────────────────────────────────
    if (path === '/assets/app.css' || path === '/assets/app.js' || path.startsWith('/assets/fonts/')) {
      const cookie = cookieValue(req, 'rc_assets');
      if (cookie === undefined || !secretEquals(cookie, assetCookie)) { deny(res); return; }
      touch();
      if (path === '/assets/app.css') sendConstant(res, APP_CSS, 'text/css; charset=utf-8', true);
      else if (path === '/assets/app.js') sendConstant(res, APP_JS, 'text/javascript; charset=utf-8', true);
      else {
        // Vendored faces (fonts.generated.ts): constant binary bodies under
        // the same cookie gate; CSP font-src 'self' admits exactly this path.
        const body = FONT_ASSETS.get(path.slice('/assets/fonts/'.length));
        if (body === undefined) { deny(res, 404); return; }
        sendConstant(res, body, 'font/woff2', true);
      }
      return;
    }

    // ── bearer-only API (the cookie is never accepted here) ───────────────
    if (path.startsWith('/api/')) {
      const bearer = bearerOf(req);
      if (bearer === undefined || !secretEquals(bearer, token)) { deny(res); return; }
      touch();
      if (path === '/api/panels' && (method === 'GET' || method === 'HEAD')) {
        const { title, body } = renderConsoleBody(sources());
        res.writeHead(200, { ...baseHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ title, body }));
        return;
      }
      if (path === '/api/events' && (method === 'GET' || method === 'HEAD')) {
        res.writeHead(200, {
          ...baseHeaders(),
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'Connection': 'keep-alive',
        });
        res.write('retry: 5000\n\n');
        const unsubscribe = onRigStoreWrite((event) => {
          res.write(`data: ${JSON.stringify({ kind: event.kind, created: event.created })}\n\n`);
        });
        sseUnsubscribers.add(unsubscribe);
        req.on('close', () => { unsubscribe(); sseUnsubscribers.delete(unsubscribe); });
        return;
      }
      deny(res, 404);
      return;
    }

    deny(res, 404);
  };

  const server = http.createServer(handler);
  server.on('connection', (socket) => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
  });

  let idleTimer: NodeJS.Timeout | undefined;

  const close = (): Promise<void> => new Promise((resolve) => {
    if (idleTimer !== undefined) clearInterval(idleTimer);
    for (const unsub of sseUnsubscribers) unsub();
    sseUnsubscribers.clear();
    server.close(() => resolve());
    // SSE responses hold their sockets open; destroy so close() settles.
    for (const socket of openSockets) socket.destroy();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(wantPort, '127.0.0.1', () => {
      const addr = server.address();
      port = typeof addr === 'object' && addr !== null ? addr.port : wantPort;
      idleTimer = setInterval(() => {
        if (Date.now() - lastAuthedAt >= idleMs) {
          console.error('Rig Console host idle-expired; closing the listener (open_rig_editor relaunches it).');
          void close().then(() => { running = undefined; });
        }
      }, Math.min(idleMs, 60_000));
      idleTimer.unref();
      resolve({
        url: `http://127.0.0.1:${port}/#t=${token}`,
        port,
        close: async () => { await close(); running = undefined; },
      });
    });
  });
}

// ── lazy per-process singleton (what open_rig_editor calls) ─────────────────

let running: RigConsoleHost | undefined;
let starting: Promise<RigConsoleHost> | undefined;

/**
 * Start the host if it is not running and return its tokenised URL. A second
 * call while it runs returns the SAME launch (same token: it is per-launch,
 * not per-call); after idle expiry or close, a new launch mints a fresh one.
 */
export async function openRigConsole(opts: RigConsoleHostOptions = {}): Promise<RigConsoleHost> {
  if (running !== undefined) return running;
  if (starting === undefined) {
    starting = startRigConsoleHost(opts).then((host) => {
      running = host;
      starting = undefined;
      return host;
    }, (err: unknown) => {
      starting = undefined;
      throw err;
    });
  }
  return starting;
}

/** Test-only: drop the singleton so the next openRigConsole starts fresh. */
export async function closeRigConsole(): Promise<void> {
  const host = running;
  running = undefined;
  if (host !== undefined) await host.close();
}
