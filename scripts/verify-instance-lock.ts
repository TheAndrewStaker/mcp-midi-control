/**
 * Golden: the single-instance port lease (core/server-shared/instanceLock.ts).
 *
 * Covers the workplan's cases, no hardware and no real MIDI port:
 *   - acquire / re-entrant reacquire / release, against a temp lock dir
 *   - TWO PROCESSES contending: a spawned child holds the lease, this process
 *     reads `port_held_elsewhere` + the holder pid; killing the child makes
 *     the steal-after-death path hand the lease over
 *   - PID-reuse guard: a lock naming OUR pid with a FOREIGN startedAt is
 *     stale, not "held by ourselves"
 *   - unreadable payload is stolen, not fatal
 *   - the `ensureConnection` seam: a held lease degrades the open to a thrown
 *     `port_held_elsewhere` error (read-only device), does NOT cache the
 *     refusal, and hands back the connection once the holder exits
 *
 * Run: npx tsx scripts/verify-instance-lock.ts   (registered in preflight)
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  INSTANCE_LOCK_DIR_ENV,
  PORT_HELD_ELSEWHERE,
  acquireInstanceLock,
  awaitInstanceLeaseRelease,
  describeHolder,
  describeInstanceLocks,
  heldInstanceLocks,
  releaseInstanceLock,
  setInstanceClientNameProvider,
  touchInstanceLock,
} from '../packages/core/src/server-shared/instanceLock.js';
import {
  awaitDeviceLease,
  ensureConnection,
  pinConnection,
  registerConnector,
  releaseConnection,
} from '../packages/core/src/server-shared/connections.js';
import type { MidiConnection } from '../packages/core/src/midi/transport.js';

let failures = 0;
const ok = (msg: string): void => console.log(`  ok    ${msg}`);
const fail = (msg: string): void => { console.error(`  FAIL  ${msg}`); failures++; };
const assert = (cond: boolean, msg: string): void => { cond ? ok(msg) : fail(msg); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-instance-lock-'));
process.env[INSTANCE_LOCK_DIR_ENV] = dir;

const lockPath = (label: string): string => path.join(dir, `${label}.lock`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A child process that writes ITS OWN pid into the lock file (the same JSON
 * payload acquireInstanceLock writes) and then sleeps holding it: a stand-in
 * for a second server instance that opened the device first.
 */
function spawnHolder(label: string): Promise<{ pid: number; kill: () => void; exited: Promise<void> }> {
  const file = lockPath(label);
  const code = 'const fs=require("fs");'
    + `fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({pid:process.pid,startedAt:Math.round(Date.now()-process.uptime()*1000)}));`
    + 'console.log("held");'
    + 'setInterval(()=>{},1000);';
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<void>((r) => child.on('exit', () => r()));
    child.stdout.on('data', (c: Buffer) => {
      if (c.toString().includes('held')) {
        resolve({ pid: child.pid ?? -1, kill: () => child.kill('SIGKILL'), exited });
      }
    });
    child.on('error', reject);
  });
}

async function main(): Promise<void> {
  // ── plain acquire / re-entrant / release ─────────────────────────────────
  console.log('lease lifecycle:');
  {
    const a = acquireInstanceLock('am4');
    assert(a.acquired && fs.existsSync(lockPath('am4')), 'first acquire creates the lock file');
    const b = acquireInstanceLock('am4');
    assert(b.acquired, 're-entrant reacquire by the same process succeeds (forced-reconnect path)');
    assert(heldInstanceLocks().includes('am4'), 'the lease is tracked as held');
    releaseInstanceLock('am4');
    assert(!fs.existsSync(lockPath('am4')), 'release removes the lock file');
    assert(!heldInstanceLocks().includes('am4'), 'release untracks the lease');
  }

  // ── per-label independence ───────────────────────────────────────────────
  {
    const a = acquireInstanceLock('fm3');
    const b = acquireInstanceLock('axe-fx-ii');
    assert(a.acquired && b.acquired && a.file !== b.file, 'leases are per-label (one file each)');
    releaseInstanceLock('fm3');
    releaseInstanceLock('axe-fx-ii');
  }

  // ── PID-reuse guard ──────────────────────────────────────────────────────
  console.log('\nstale-lock handling:');
  {
    fs.writeFileSync(lockPath('reuse'), JSON.stringify({ pid: process.pid, startedAt: 12345 }));
    const a = acquireInstanceLock('reuse');
    assert(a.acquired, 'a lock naming OUR pid with a foreign startedAt is stolen (PID-reuse guard)');
    releaseInstanceLock('reuse');
  }
  {
    fs.writeFileSync(lockPath('garbage'), 'not json at all');
    const a = acquireInstanceLock('garbage');
    assert(a.acquired, 'an unreadable payload is stolen, never fatal');
    releaseInstanceLock('garbage');
  }

  // ── two processes contending ─────────────────────────────────────────────
  console.log('\ntwo-process contention:');
  {
    const holder = await spawnHolder('contend');
    const refused = acquireInstanceLock('contend');
    assert(refused.acquired === false, 'a live holder in another process wins');
    assert(refused.reason === PORT_HELD_ELSEWHERE, `refusal reason is ${PORT_HELD_ELSEWHERE}`);
    assert(refused.holderPid === holder.pid, `refusal names the holder pid (got ${refused.holderPid}, want ${holder.pid})`);
    holder.kill();
    await holder.exited;
    const stolen = acquireInstanceLock('contend');
    assert(stolen.acquired, 'steal-after-death: the dead holder\'s lease is taken over');
    releaseInstanceLock('contend');
  }

  // ── the ensureConnection seam ────────────────────────────────────────────
  console.log('\nensureConnection seam (mock connector, no real port):');
  {
    let opens = 0;
    const fake: MidiConnection = {
      send: () => undefined,
      close: () => undefined,
      onSysEx: () => () => undefined,
      inputPortName: 'mock', outputPortName: 'mock',
    } as unknown as MidiConnection;
    registerConnector('lock-seam-test', () => { opens++; return fake; });

    const holder = await spawnHolder('lock-seam-test');
    let threw: (Error & { reason?: string }) | undefined;
    try {
      ensureConnection('lock-seam-test');
    } catch (e) {
      threw = e as Error & { reason?: string };
    }
    assert(threw !== undefined, 'a held lease makes the device open throw (reads and writes alike)');
    assert(threw?.reason === PORT_HELD_ELSEWHERE, `the thrown error carries reason=${PORT_HELD_ELSEWHERE}`);
    assert(/held by another mcp-midi-control instance/.test(threw?.message ?? ''), 'the message says who and why in words');
    // Every device operation opens through this seam, so a read is refused exactly like a write. The message
    // said "read-only" until 2026-09-16, when a dogfood read (list_samples) came back refused with that text.
    assert(!/read-only/.test(threw?.message ?? ''), 'the message does not promise read access the seam refuses');
    assert(opens === 0, 'the connector factory never ran while the lease was held');

    holder.kill();
    await holder.exited;
    // No forceReconnect: held-elsewhere must NOT have been cached as a
    // connection error, so plain re-acquire-on-demand works.
    const conn = ensureConnection('lock-seam-test');
    assert(conn === fake && opens === 1, 'once the holder exits, the same call opens the device (refusal was not cached)');
  }

  // ── holder identity + activity + visibility (2026-09-03) ─────────────────
  console.log('\nlease identity + visibility:');
  {
    setInstanceClientNameProvider(() => 'verify-client');
    const a = acquireInstanceLock('ident');
    const p1 = JSON.parse(fs.readFileSync(lockPath('ident'), 'utf8')) as Record<string, unknown>;
    assert(a.acquired && p1.client === 'verify-client' && typeof p1.heldSince === 'number' && typeof p1.lastActiveAt === 'number',
      'the lock file carries the MCP client name, heldSince and lastActiveAt');
    await sleep(2100); // past the touch throttle
    touchInstanceLock('ident');
    const p2 = JSON.parse(fs.readFileSync(lockPath('ident'), 'utf8')) as Record<string, unknown>;
    assert((p2.lastActiveAt as number) > (p1.lastActiveAt as number) && p2.heldSince === p1.heldSince,
      'touch advances lastActiveAt (temp-file + rename) and keeps heldSince');
    assert(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), 'touch leaves no temp file behind');

    const holder = await spawnHolder('ident-other');
    const leases = describeInstanceLocks();
    const mine = leases.find((l) => l.label === 'ident');
    const theirs = leases.find((l) => l.label === 'ident-other');
    assert(mine?.ours === true && mine.alive && mine.client === 'verify-client', 'describeInstanceLocks reports our lease as ours + alive, with the client name');
    assert(theirs?.ours === false && theirs.alive && theirs.pid === holder.pid, 'describeInstanceLocks reports the other process lease with its pid, alive');
    const refused = acquireInstanceLock('ident-other');
    assert(refused.acquired === false && refused.holder?.pid === holder.pid, 'a refusal carries the holder payload, not just the pid');
    assert(new RegExp(`pid ${holder.pid}`).test(describeHolder(refused.holder!)), 'describeHolder names the holder pid in words');
    holder.kill();
    await holder.exited;
    const stale = describeInstanceLocks().find((l) => l.label === 'ident-other');
    assert(stale !== undefined && stale.alive === false, 'a dead holder shows as a stale (not alive) lease until reclaimed');
    releaseInstanceLock('ident');
    fs.rmSync(lockPath('ident-other'), { force: true });
    setInstanceClientNameProvider(() => undefined);
  }

  // ── waiting out a foreign holder ─────────────────────────────────────────
  console.log('\nwaiting for a foreign holder:');
  {
    const holder = await spawnHolder('wait');
    const t0 = Date.now();
    const gaveUp = await awaitInstanceLeaseRelease('wait', 400);
    assert(gaveUp === false && Date.now() - t0 >= 380, 'awaitInstanceLeaseRelease returns false when the holder outlasts the wait');
    setTimeout(() => holder.kill(), 300);
    const freed = await awaitInstanceLeaseRelease('wait', 3000);
    assert(freed === true, 'awaitInstanceLeaseRelease returns true as soon as the holder goes away');
    await holder.exited;
    assert((await awaitInstanceLeaseRelease('nobody', 100)) === true, 'an unheld label resolves true immediately');
    fs.rmSync(lockPath('wait'), { force: true });
    process.env.MCP_PORT_WAIT_MS = '300';
    const t1 = Date.now();
    await awaitDeviceLease('nobody');
    assert(Date.now() - t1 < 250, 'awaitDeviceLease is free for an unheld label');
    delete process.env.MCP_PORT_WAIT_MS;
  }

  // ── a failed open gives the lease back ───────────────────────────────────
  console.log('\nfailed open (device not plugged in):');
  {
    let plugged = false;
    let attempts = 0;
    const fake = { close: (): void => {} } as unknown as MidiConnection;
    registerConnector('unplugged-test', () => {
      attempts++;
      if (!plugged) throw new Error('No MIDI port matching "unplugged-test" found.');
      return fake;
    });
    let threw = false;
    try { ensureConnection('unplugged-test'); } catch { threw = true; }
    assert(threw && attempts === 1, 'an open with no matching port throws');
    assert(!fs.existsSync(lockPath('unplugged-test')) && !heldInstanceLocks().includes('unplugged-test'),
      'the failed open leaves no lease behind (it used to lock other instances out until this process exited)');
    plugged = true;
    const conn = ensureConnection('unplugged-test');
    assert(conn === fake && attempts === 2, 'plugging the device in is seen by the very next call (the not-found error is not cached)');
    releaseConnection('unplugged-test');
  }

  // ── idle release at the ensureConnection seam ────────────────────────────
  console.log('\nidle release (ensureConnection seam, 200 ms grace):');
  {
    process.env.MCP_PORT_IDLE_RELEASE_MS = '200';
    let opens = 0;
    let closes = 0;
    const fake: MidiConnection = {
      send: () => undefined,
      close: () => { closes++; },
      onSysEx: () => () => undefined,
      inputPortName: 'mock', outputPortName: 'mock',
    } as unknown as MidiConnection;
    registerConnector('idle-test', () => { opens++; return fake; });
    ensureConnection('idle-test');
    assert(opens === 1 && fs.existsSync(lockPath('idle-test')), 'first use opens the handle and takes the lease');
    await sleep(600);
    assert(closes === 1 && !fs.existsSync(lockPath('idle-test')), 'after the idle grace the handle is closed and the lease released');
    ensureConnection('idle-test');
    assert(opens === 2 && fs.existsSync(lockPath('idle-test')), 'the next use re-opens the handle and re-leases the device');
    // A pinned handle (a timed primitive mid-play) is never released.
    const unpin = pinConnection('idle-test');
    await sleep(600);
    assert(closes === 1 && fs.existsSync(lockPath('idle-test')), 'a pinned handle survives the idle grace');
    unpin();
    await sleep(600);
    assert(closes === 2 && !fs.existsSync(lockPath('idle-test')), 'unpinning re-arms the grace and the handle is then released');
    releaseConnection('idle-test');

    let holdCloses = 0;
    const holdFake = { ...fake, close: () => { holdCloses++; } } as unknown as MidiConnection;
    registerConnector('hold-test', () => holdFake, { holdWhileIdle: true });
    ensureConnection('hold-test');
    await sleep(600);
    assert(holdCloses === 0 && fs.existsSync(lockPath('hold-test')), 'a holdWhileIdle device (Axe-Fx II) keeps its handle and lease past the grace');
    assert(releaseConnection('hold-test') === true && holdCloses === 1 && !fs.existsSync(lockPath('hold-test')),
      'releaseConnection closes the handle and drops the lease explicitly');
    delete process.env.MCP_PORT_IDLE_RELEASE_MS;
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nverify-instance-lock passed.' : `\n${failures} instance-lock assertion(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-instance-lock crashed:', err);
  process.exit(1);
});
