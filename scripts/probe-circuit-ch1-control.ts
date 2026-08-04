/**
 * CONTROL for the Circuit ch1 PC-collision probe.
 *
 * The first run of that probe reported "8 bytes differ => collision confirmed",
 * but the patch NAME region was byte-identical across the two dumps, which is
 * not what loading a different patch looks like. Two innocent explanations had
 * to be eliminated before that verdict could stand:
 *
 *   A. Some bytes in the dump are VOLATILE (live modulation / LFO phase / a
 *      counter) and drift between any two reads, PC or no PC. Then the diff
 *      proves nothing.
 *   B. Synth 1 was ALREADY on the patch the PC selected, so it reloaded the same
 *      patch: same name, and only volatile bits differ.
 *
 * This runs the missing control: two dumps back to back with NO Program Change
 * in between. If they differ, the original result was a false positive. Then it
 * sweeps several DIFFERENT patch numbers and watches the name region, which is
 * the part that cannot change without a genuine patch load.
 *
 * Run: npx tsx scripts/probe-circuit-ch1-control.ts
 */
import { connect } from '../packages/core/src/midi/transport.js';
import { endMidiScript } from './_lib/midi-lifecycle.js';

const DUMP_REQUEST = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x40, 0x00, 0xf7];
const isNovation = (b: readonly number[]): boolean =>
  b[1] === 0x00 && b[2] === 0x20 && b[3] === 0x29 && b[4] === 0x01 && b[5] === 0x64;
const ascii = (b: readonly number[]): string =>
  b.map((x) => (x >= 0x20 && x <= 0x7e ? String.fromCharCode(x) : '.')).join('');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' });

async function dump(): Promise<number[] | undefined> {
  const waiter = conn.receiveSysExMatching(isNovation, 3000).catch(() => undefined);
  conn.send(DUMP_REQUEST);
  return waiter;
}
function diffOffsets(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

console.log('=== CONTROL: two dumps, NO Program Change in between ===');
const c1 = await dump();
await sleep(500);
const c2 = await dump();
if (c1 === undefined || c2 === undefined) {
  console.log('  a dump failed; cannot run the control.');
  process.exit(1);
}
const controlDiff = diffOffsets(c1, c2);
console.log(`  name: "${ascii(c1.slice(9, 25))}"`);
console.log(`  bytes differing with NO stimulus: ${controlDiff.length}`
  + (controlDiff.length > 0 ? ` at offsets [${controlDiff.slice(0, 12).join(', ')}${controlDiff.length > 12 ? ', ...' : ''}]` : ''));
console.log(controlDiff.length === 0
  ? '  => dumps are STABLE. A diff after a PC would be meaningful.\n'
  : '  => dumps are VOLATILE on their own. A raw byte-diff proves NOTHING; use the name region.\n');

console.log('=== PC sweep, watching the NAME region (cannot change without a real patch load) ===');
let prevName = ascii(c2.slice(9, 25));
console.log(`  start                     name = "${prevName}"`);
for (const program of [0, 12, 31, 47]) {
  conn.send([0xc0, program]);
  await sleep(600);
  const d = await dump();
  if (d === undefined) { console.log(`  PC ${String(program).padStart(2)} -> no dump reply`); continue; }
  const name = ascii(d.slice(9, 25));
  const volatileOnly = diffOffsets(d, c2).every((o) => controlDiff.includes(o));
  console.log(`  PC ${String(program).padStart(2)} on ch1        name = "${name}"`
    + (name !== prevName ? '   <-- NAME CHANGED' : '')
    + (controlDiff.length > 0 && volatileOnly ? '   (all diffs are volatile bytes)' : ''));
  prevName = name;
}

console.log('\n--- verdict ---');
console.log('If the NAME changed as the program number changed, the Circuit consumes ch1 Program');
console.log('Changes to select its own Synth 1 patch, and the collision with a ch1 Hydra is REAL.');
console.log('If the name never moved, the Circuit ignores PC on ch1 and there is NO collision.');
endMidiScript();
