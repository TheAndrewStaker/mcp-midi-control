/**
 * Author the RC-505mk2 SYSTEM MIDI block over the mounted storage tree.
 *
 * LEAF MAP (mk2-corrected 2026-07-19). The committed schema's RC-600-derived
 * table lists A..I as RxChCtl/RxChRhythm/RxChVoice/TxCh/SyncClock/ClockOut/
 * StartSync/PcOut/Thru, but a real mk2 SYSTEM.RC0 carries NO `B` leaf, so every
 * field from RxChRhythm on sits one letter earlier. Confirmed by four
 * independent front-panel anchors on the owner's unit:
 *   A=4  -> RX CTL     = ch5   (also device-confirmed in the schema doc)
 *   C=9  -> RX RHYTHM  = ch10
 *   D=0  -> RX VOICE   = ch1
 *   E=16 -> TX CH      = "RX CTL" (the 17th option past channels 1-16)
 * All channel leaves are 0-indexed (stored = channel - 1).
 *
 * SYSTEM1/SYSTEM2 are an A/B double buffer like the memory pairs: the device
 * reads the higher trailing <count> and a save writes the OTHER slot at
 * count+1. Same arbitration, different filenames.
 *
 * Dry-run by default. Set APPLY=1 to write (backs the overwritten slot up to
 * <file>.bak first).
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { resolveRc505Root } from '@mcp-midi-control/boss-rc/storage/discovery.js';
import { parseRc0, serializeRc0, getLeaf, setLeaf } from '@mcp-midi-control/boss-rc/codec/rc0.js';
import { readCount, setCount } from '@mcp-midi-control/boss-rc/codec/mk2.js';

const APPLY = process.env.APPLY === '1';
const root = process.env.MCP_RC505_ROOT ?? resolveRc505Root();
if (!root) { console.error('RC-505 root not found (STORAGE: CONNECT mode?)'); process.exit(1); }

const P = (l: string) => `database/sys/MIDI/${l}`;
const ch = (v: number) => `ch${v + 1}`;
const enumOf = (t: string[]) => (v: number) => t[v] ?? `#${v}`;
const MAP: Record<string, [string, (v: number) => string]> = {
  A: ['RX CTL CH', ch],
  C: ['RX RHYTHM CH', ch],
  D: ['RX VOICE CH', ch],
  E: ['TX CH', (v) => (v === 16 ? 'RX CTL' : ch(v))],
  F: ['SYNC CLOCK', enumOf(['AUTO', 'INTERNAL', 'MIDI', 'USB'])],
  G: ['CLOCK OUT (SYNC OUT)', enumOf(['OFF', 'ON'])],
  H: ['SYNC START', enumOf(['OFF', 'ALL', 'RHYTHM'])],
  I: ['PC OUT', enumOf(['OFF', 'ON'])],
  J: ['THRU', enumOf(['OFF', 'MIDI OUT', 'USB OUT', 'USB & MIDI'])],
};

/** Target state for "Circuit Tracks is clock master, RC-505 is a slave". */
const TARGET: Record<string, number> = {
  F: 0,  // SYNC CLOCK  INTERNAL -> AUTO      (essential: without this it ignores external clock)
  C: 10, // RX RHYTHM   ch10 -> ch11          (clear of the Circuit's drum channel 10)
  D: 11, // RX VOICE    ch1  -> ch12          (clear of the Circuit's Synth 1 channel 1)
  G: 0,  // CLOCK OUT   ON -> OFF             (a slave should not broadcast clock)
  H: 2,  // SYNC START  OFF -> RHYTHM         (click follows the Circuit's transport)
};

const dataDir = join(root, 'DATA');
const files = ['SYSTEM1.RC0', 'SYSTEM2.RC0'].map((n) => join(dataDir, n));
const slots = files.map((path) => {
  if (!existsSync(path)) return undefined;
  const doc = parseRc0(readFileSync(path, 'latin1'));
  return { path, doc, count: readCount(doc) ?? 0 };
});
if (!slots[0] || !slots[1]) { console.error('Expected both SYSTEM1.RC0 and SYSTEM2.RC0.'); process.exit(1); }

const [s1, s2] = slots as [NonNullable<(typeof slots)[0]>, NonNullable<(typeof slots)[1]>];
const active = s1.count >= s2.count ? s1 : s2;
const target = active === s1 ? s2 : s1;
console.log(`SYSTEM1 count=${s1.count}  SYSTEM2 count=${s2.count}`);
console.log(`active (device reads): ${active.path}`);
console.log(`write target (inactive slot): ${target.path}\n`);

console.log('current SYSTEM MIDI block (mk2-corrected map):');
for (const [leaf, [label, fmt]] of Object.entries(MAP)) {
  const raw = getLeaf(active.doc, P(leaf));
  if (raw === undefined) { console.log(`  ${leaf} = (absent)   ${label}`); continue; }
  const v = Number(raw);
  const want = TARGET[leaf];
  const mark = want === undefined ? '' : want === v ? '   (already ideal)' : `   ==> ${want} (${fmt(want)})`;
  console.log(`  ${leaf} = ${String(v).padEnd(3)} ${label.padEnd(22)} ${fmt(v).padEnd(12)}${mark}`);
}

const changes = Object.entries(TARGET).filter(([l, want]) => Number(getLeaf(active.doc, P(l))) !== want);
if (changes.length === 0) { console.log('\nAlready at target. Nothing to write.'); process.exit(0); }

console.log(`\n${changes.length} leaf change(s) to apply.`);
for (const [leaf, want] of changes) setLeaf(active.doc, P(leaf), want);
const newCount = active.count + 1;
setCount(active.doc, newCount);
const out = serializeRc0(active.doc);
console.log(`stamp count: ${active.count} -> ${newCount} (must exceed sibling ${target.count} to become active)`);
console.log(`bytes: ${out.length}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with APPLY=1 to commit.');
  process.exit(0);
}

copyFileSync(target.path, `${target.path}.bak`);
writeFileSync(target.path, out, 'latin1');
console.log(`\nWROTE ${target.path}  (backup: ${target.path}.bak)`);

// Verify by re-reading from disk.
const verify = parseRc0(readFileSync(target.path, 'latin1'));
console.log(`verify count = ${readCount(verify)}`);
let ok = true;
for (const [leaf, want] of Object.entries(TARGET)) {
  const got = Number(getLeaf(verify, P(leaf)));
  const [label, fmt] = MAP[leaf];
  const good = got === want;
  ok &&= good;
  console.log(`  ${good ? 'OK ' : 'BAD'} ${label.padEnd(22)} = ${fmt(got)}`);
}
console.log(ok ? '\nAll target values verified on disk.' : '\nVERIFY FAILED.');
