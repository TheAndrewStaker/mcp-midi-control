/**
 * Guard: a process that opens a MIDI connection must be able to EXIT.
 *
 * ## The bug this locks down
 *
 * `@julusian/midi` creates a `Napi::TypedThreadSafeFunction` when an Input port
 * is opened (`src/input.cpp`, `setupCallback`). A live thread-safe function
 * holds a ref on the libuv event loop, and only `closePort()` / `destroy()`
 * releases it. So a script that opens a connection and never closes it never
 * exits, and keeps holding the device's exclusive OS MIDI port while it idles.
 *
 * On 2026-07-26 twelve such zombie node processes accumulated in one evening
 * and wedged a Circuit Tracks: every later read returned `ok=false crcOk=false`
 * until they were killed by hand. It also made the runs look silent, because a
 * `tail` on the pipe never saw EOF and so never flushed its buffer.
 *
 * The ref is invisible to `process.getActiveResourcesInfo()` and
 * `process._getActiveHandles()` (both report an empty list while the loop is
 * pinned), so no in-process assertion can see it. The only honest test is to
 * spawn a child and watch whether it dies.
 *
 * ## What is checked
 *
 * 1. RUNTIME (needs a safe port; skipped otherwise). A child opens a real
 *    connection via `connect()` and calls `closeAllMidiConnections()`. It must
 *    exit on its own, with a zero code, and with its full stdout intact through
 *    a PIPE, the exact shape the maintainer runs these scripts in.
 *    A second child opens the same connection and does NOT close it; it must
 *    still be alive at the timeout. That negative case is what proves the
 *    positive case is testing something real rather than passing vacuously.
 *
 * 2. STATIC (always runs). No script may reassign over a live connection in a
 *    `reconnect` callback. `conn = connect(...)` without releasing the previous
 *    handle leaks one loop-pinning input port per reconnect, and the Circuit
 *    reboots after every upload, so this fires constantly in a batch. Use
 *    `reconnectMidi()` from `scripts/_lib/midi-lifecycle.ts`.
 *
 * SAFETY: this never opens a hardware port. The runtime leg only uses a virtual
 * loopback port (LoopBe / loopMIDI / ALSA "Midi Through"), because opening a
 * real device's exclusive port would interrupt whoever is using it. If no
 * virtual port is present the runtime leg SKIPS and only the static leg runs.
 * Override the port substring with `MCP_HANDLE_RELEASE_PORT`.
 *
 * Run: `npx tsx scripts/verify-midi-handle-release.ts`
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { listMidiPorts } from '../packages/core/src/midi/transport.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..');
const TSX_CLI = join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * Port names that are safe to open: software loopback drivers with no
 * instrument behind them. A real device is NEVER opened by this guard.
 */
const VIRTUAL_PORT_PATTERNS = [/loopbe/i, /loopmidi/i, /midi\s*through/i, /iac\s*driver/i];

let failures = 0;
let skipped = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
}

// ── leg 1: runtime ───────────────────────────────────────────────────────────

/** A loopback port name present on BOTH the input and output side, if any. */
function findSafePort(): string | undefined {
  const override = process.env.MCP_HANDLE_RELEASE_PORT;
  let ports: ReturnType<typeof listMidiPorts>;
  try {
    ports = listMidiPorts();
  } catch {
    return undefined; // no MIDI backend at all (headless CI)
  }
  const names = (dir: 'inputs' | 'outputs'): string[] => ports[dir].map((p) => p.name);
  const bothSides = (needle: string): boolean =>
    names('inputs').some((n) => n.toLowerCase().includes(needle.toLowerCase()))
    && names('outputs').some((n) => n.toLowerCase().includes(needle.toLowerCase()));

  if (override !== undefined) return bothSides(override) ? override : undefined;
  for (const name of names('inputs')) {
    if (!VIRTUAL_PORT_PATTERNS.some((re) => re.test(name))) continue;
    if (bothSides(name)) return name;
  }
  return undefined;
}

/** How many lines the child prints, so a truncated pipe is detectable. */
const CHATTER_LINES = 400;

function childSource(needle: string, close: boolean): string {
  const transport = pathToFileURL(join(REPO, 'packages', 'core', 'src', 'midi', 'transport.ts')).href;
  return [
    `import { connect, closeAllMidiConnections } from '${transport}';`,
    `connect({ needles: ['${needle.replace(/'/g, "\\'")}'] });`,
    `for (let i = 1; i <= ${CHATTER_LINES}; i++) console.log('line ' + i);`,
    close ? 'closeAllMidiConnections();' : '// deliberately leaked',
    "console.log('DONE');",
  ].join('\n');
}

interface RunResult { exited: boolean; code: number | undefined; stdout: string }

/** Spawn a child with stdout on a PIPE and report whether it ended by itself. */
function runChild(file: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, file], {
      cwd: REPO,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', () => { /* tsx noise is not the subject */ });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ exited: false, code: undefined, stdout });
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Give the pipe a tick to deliver whatever was already written.
      setTimeout(() => resolve({ exited: true, code: code ?? undefined, stdout }), 50);
    });
  });
}

async function runtimeLeg(): Promise<void> {
  const needle = findSafePort();
  if (needle === undefined) {
    skipped++;
    console.log('  skip  runtime leg: no virtual loopback MIDI port available');
    console.log('        (install LoopBe/loopMIDI, or set MCP_HANDLE_RELEASE_PORT to a safe port name)');
    return;
  }
  console.log(`  ..    runtime leg using virtual port "${needle}"`);
  const dir = mkdtempSync(join(tmpdir(), 'midi-handle-release-'));
  try {
    const closing = join(dir, 'closing.ts');
    const leaking = join(dir, 'leaking.ts');
    writeFileSync(closing, childSource(needle, true));
    writeFileSync(leaking, childSource(needle, false));

    const good = await runChild(closing, 20_000);
    check('a connection that is closed lets the process exit', good.exited,
      'child was still alive after 20s despite closeAllMidiConnections()');
    check('closed-connection child exits with code 0', good.code === 0, `code=${String(good.code)}`);
    const lines = good.stdout.split('\n').filter((l) => l.startsWith('line ')).length;
    check(`all ${CHATTER_LINES} stdout lines survive the pipe`, lines === CHATTER_LINES, `got ${lines}`);
    check('final line reaches the pipe reader', good.stdout.includes('DONE'));

    // The negative control. If this ever "passes" by exiting, the ref semantics
    // changed and the positive case above has stopped proving anything.
    const bad = await runChild(leaking, 6_000);
    check('an UNCLOSED connection still pins the loop (negative control)', !bad.exited,
      'the leaked-handle child exited by itself, so this guard no longer tests anything');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── leg 2: static ────────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { out.push(...walk(p)); continue; }
    if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * `conn = connect(...)` inside a reconnect callback, i.e. reassigning over a
 * still-open handle. Matches the whole family (`conn`, `c`, `midi`, ...) rather
 * than one variable name.
 */
const LEAKING_RECONNECT = /\breconnect\b[^\n]*=>[^\n]*\b(\w+)\s*=\s*connect\s*\(/;

function staticLeg(): void {
  const offenders: string[] = [];
  for (const file of walk(join(REPO, 'scripts'))) {
    const src = readFileSync(file, 'utf8');
    for (const [i, line] of src.split('\n').entries()) {
      if (!LEAKING_RECONNECT.test(line)) continue;
      offenders.push(`${file.replace(REPO, '').replace(/\\/g, '/')}:${i + 1}`);
    }
  }
  check('no script reassigns over a live connection in a reconnect callback',
    offenders.length === 0,
    offenders.length === 0 ? '' :
      `use reconnectMidi() from scripts/_lib/midi-lifecycle.ts at:\n        ${offenders.join('\n        ')}`);
}

// ── run ──────────────────────────────────────────────────────────────────────

console.log('verify-midi-handle-release');
await runtimeLeg();
staticLeg();

if (failures > 0) {
  console.log(`\nFAILED: ${failures} check(s).`);
  process.exit(1);
}
console.log(`\nPASS${skipped > 0 ? ` (${skipped} leg skipped)` : ''}`);
