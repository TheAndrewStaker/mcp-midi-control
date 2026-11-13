/**
 * Gate: the built MCP server must EXIT when its client goes away.
 *
 * Why this exists: a stdio MCP server child that outlives its client keeps
 * its USB MIDI ports open. Observed 2026-05-31: 5 stale server-all processes
 * held the Hydrasynth port; later sends "succeeded" but the device stayed
 * deaf. Today's protection is shutdown() in
 * packages/server-all/src/server/index.ts, which calls process.exit(0) on
 * stdin close/end and on SIGINT/SIGTERM/SIGHUP. The MCP v2 migration will
 * replace server.connect(transport) with serveStdio, whose close() tears
 * down the server + transport but does NOT exit the process; upstream's own
 * documented example (process.on('SIGINT', () => { void handle.close(); }))
 * would silently delete the port-release mechanism. This gate pins the
 * behavior so the migration cannot regress it unnoticed.
 *
 * Checks:
 *   1. spawn the dist server (MCP_MOCK_TRANSPORT=1, no hardware, no real
 *      ports) and wait for the "running on stdio" banner on stderr
 *   2. close the child's stdin (the client-disconnect signal for stdio MCP)
 *   3. the child exits ON ITS OWN within 10 s, exit code 0, no kill
 *   4. second spawn: SIGTERM also exits within 10 s. Non-win32 only: on
 *      Windows child.kill('SIGTERM') is a forcible TerminateProcess, not a
 *      deliverable signal, so the check would be vacuous; it is SKIPPED
 *      loudly there. The stdin-close leg is the load-bearing one on Windows.
 *
 * Run: `npm run build && npx tsx scripts/verify-server-exit.ts`
 * Status: offline, no hardware required. Exit 0 on pass, 1 on fail.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

const SERVER_ENTRY = path.resolve(
  process.cwd(),
  'packages',
  'server-all',
  'dist',
  'server',
  'index.js',
);

const BANNER = 'running on stdio';
const BANNER_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 10_000;

let failures = 0;
function record(name: string, pass: boolean, notes: string[] = []): void {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
  for (const n of notes) console.log(`        ${n}`);
}

interface SpawnedServer {
  child: ChildProcess;
  stderrText: () => string;
  /** Resolves when the startup banner appears on stderr; rejects on
   *  early exit, spawn error, or timeout. */
  bannerSeen: Promise<void>;
  /** Resolves with the child's exit status; never rejects. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnServer(): SpawnedServer {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MCP_MOCK_TRANSPORT: '1' },
  });

  const stderrChunks: Buffer[] = [];
  const stderrText = (): string => Buffer.concat(stderrChunks).toString('utf8');
  // Drain stdout so the child never blocks on a full pipe.
  child.stdout?.on('data', () => {});

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    },
  );

  const bannerSeen = new Promise<void>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`startup banner ("${BANNER}") not seen on stderr within ${BANNER_TIMEOUT_MS} ms`));
    }, BANNER_TIMEOUT_MS);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (!done && stderrText().includes(BANNER)) {
        done = true;
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`spawn error: ${err.message}`));
    });
    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`server exited before banner (code=${code}, signal=${signal})`));
    });
  });

  return { child, stderrText, bannerSeen, exited };
}

/** Wait for the child to exit on its own. Returns undefined on timeout. */
function waitForExit(
  server: SpawnedServer,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null } | undefined> {
  return Promise.race([
    server.exited,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
  ]);
}

function stderrTail(server: SpawnedServer, lines = 20): string {
  const all = server.stderrText().split(/\r?\n/);
  return all.slice(-lines).join('\n');
}

/** Never leak a server process: kill if it is still alive. */
function reap(server: SpawnedServer): void {
  const { child } = server;
  if (child.exitCode === null && child.signalCode === null && !child.killed) {
    // SIGKILL on POSIX; forcible TerminateProcess on Windows. Either way
    // the gate leaves no orphan holding a (mock) port.
    child.kill('SIGKILL');
  }
}

function diagnose(server: SpawnedServer): void {
  console.error('\n  server stderr tail (last 20 lines):');
  console.error(
    stderrTail(server)
      .split('\n')
      .map((l) => `  | ${l}`)
      .join('\n'),
  );
}

async function checkStdinCloseLeg(): Promise<void> {
  console.log('\nLeg 1: stdin close (the client-disconnect path)');
  const server = spawnServer();
  try {
    // Check 1: startup banner.
    try {
      await server.bannerSeen;
      record('server started: banner on stderr', true);
    } catch (err) {
      record('server started: banner on stderr', false, [(err as Error).message]);
      diagnose(server);
      return;
    }

    // Check 2 + 3: close stdin, server must exit by itself, no kill.
    server.child.stdin?.end();
    record("stdin closed via child.stdin.end()", true);

    const exit = await waitForExit(server, EXIT_TIMEOUT_MS);
    if (exit === undefined) {
      record(`server exits on its own within ${EXIT_TIMEOUT_MS} ms of stdin close`, false, [
        'server is STILL RUNNING after stdin closed. This is the orphaned-server regression:',
        'a lingering process would hold its USB MIDI ports (2026-05-31 incident).',
        'Expected: shutdown() on stdin close/end calling process.exit(0)',
        '(packages/server-all/src/server/index.ts).',
      ]);
      diagnose(server);
      return;
    }
    const cleanExit = exit.code === 0;
    record(
      `server exits on its own within ${EXIT_TIMEOUT_MS} ms of stdin close (code=${exit.code}, signal=${exit.signal})`,
      cleanExit,
      cleanExit ? [] : ['expected exit code 0 from shutdown(); a non-zero code means the exit path is an error path'],
    );
    if (!cleanExit) diagnose(server);
  } finally {
    reap(server);
  }
}

async function checkSigtermLeg(): Promise<void> {
  console.log('\nLeg 2: SIGTERM (the OS-signal path)');
  if (process.platform === 'win32') {
    console.log('  SKIP  SIGTERM leg SKIPPED on win32: child.kill("SIGTERM") is a forcible');
    console.log('        TerminateProcess on Windows, not a deliverable signal, so the check');
    console.log('        would pass vacuously without exercising the signal handler.');
    console.log('        Run this gate on macOS/Linux (CI native matrix) for signal coverage.');
    console.log('        The stdin-close leg above is the load-bearing one on Windows.');
    return;
  }
  const server = spawnServer();
  try {
    try {
      await server.bannerSeen;
      record('server started: banner on stderr', true);
    } catch (err) {
      record('server started: banner on stderr', false, [(err as Error).message]);
      diagnose(server);
      return;
    }

    server.child.kill('SIGTERM');
    const exit = await waitForExit(server, EXIT_TIMEOUT_MS);
    if (exit === undefined) {
      record(`server exits within ${EXIT_TIMEOUT_MS} ms of SIGTERM`, false, [
        'server is STILL RUNNING after SIGTERM. A signal handler that closes the',
        'transport without exiting (e.g. v2 serveStdio handle.close()) leaves an',
        'orphan holding MIDI ports. Expected: shutdown(sig) calling process.exit(0).',
      ]);
      diagnose(server);
      return;
    }
    // Graceful path is code 0 (shutdown handler). A death BY the signal
    // (signal === 'SIGTERM', code null) still exits and releases ports, but
    // it means the graceful handler is gone; treat it as a pass with a note
    // only if graceful, otherwise fail so a deleted handler is visible.
    const graceful = exit.code === 0;
    record(
      `server exits within ${EXIT_TIMEOUT_MS} ms of SIGTERM (code=${exit.code}, signal=${exit.signal})`,
      graceful,
      graceful
        ? []
        : [
            'expected exit code 0 from the shutdown() signal handler;',
            `dying to the raw signal (signal=${exit.signal}) means the graceful handler is missing.`,
          ],
    );
    if (!graceful) diagnose(server);
  } finally {
    reap(server);
  }
}

async function main(): Promise<void> {
  console.log('verify-server-exit: the built server must exit when its client goes away');

  if (!existsSync(SERVER_ENTRY)) {
    console.error(`\nFAIL: dist server not found at ${SERVER_ENTRY}`);
    console.error('Run `npm run build` first.');
    process.exit(1);
  }

  await checkStdinCloseLeg();
  await checkSigtermLeg();

  if (failures > 0) {
    console.error(`\nverify-server-exit FAIL (${failures} check${failures === 1 ? '' : 's'} failed).`);
    process.exit(1);
  }
  console.log('\nverify-server-exit PASS.');
  process.exit(0);
}

main().catch((err) => {
  console.error('verify-server-exit FAIL (unexpected error):', err);
  process.exit(1);
});
