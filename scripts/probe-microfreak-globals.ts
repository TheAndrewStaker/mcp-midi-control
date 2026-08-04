/**
 * MicroFreak GLOBAL / UTILITY settings scan. READ-ONLY BY CONSTRUCTION.
 *
 * Sends ONLY the read opcode 0x43. It never sends 0x42, which is the WRITE, so
 * this cannot alter a single setting on the device. That distinction is the
 * whole safety story here, so do not "simplify" the opcode into a variable.
 *
 *   read  :  F0 00 20 6B 07 01 <seq> 01 43 <param> F7
 *   answer:  F0 00 20 6B 07 7F <seq> 02 42 <param> <value> F7
 *
 * Provenance: recovered from a MIDI Control Center capture in the community
 * `microfreak-reverse` notes, which record the exchange but never identify 0x43
 * as the read counterpart to 0x42. Known param ids from those notes are only
 * 0x2D (knob catch) and 0x2B (arp on/off); everything else is unlabelled, which
 * is exactly why this scans the space and prints values for correlation against
 * settings whose values we already know from the front panel.
 *
 * Run: npx tsx scripts/probe-microfreak-globals.ts [firstParam] [lastParam]
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { connect } from '../packages/core/src/midi/transport.js';

const first = Number(process.argv[2] ?? '0');
const last = Number(process.argv[3] ?? '127');

/**
 * Param ids IDENTIFIED, each by a controlled single-variable diff on hardware
 * (change exactly one front-panel setting, re-snapshot, see which id moved).
 *
 * Note 0x2B. The community notes label it "arp on/off", from a capture annotated
 * "set arp off / set arp on". That is WRONG: the arpeggiator was never touched
 * in our test, only Arp/Seq MIDI out was, and only 0x2B moved. A controlled
 * diff on hardware outranks an informal capture label, so the corrected name is
 * what belongs here. The old label is called out rather than silently replaced
 * because it is still circulating in the community notes.
 */
const KNOWN: Record<number, string> = {
  0x20: 'MIDI Input Chan (0-BASED: stored = displayed - 1)',
  0x21: 'MIDI Output Chan (0-BASED: stored = displayed - 1)',
  0x24: 'Knob send CCs (0=off, 1=on)',
  0x25: 'Output dest (BITMASK: USB=1, BOTH=5 observed; MIDI=4/None=0 inferred)',
  0x2b: 'Arp/Seq MIDI out (0=off, 1=on)  [community notes call this "arp on/off": WRONG]',
  0x2d: 'Knob catch (0=jump, 1=hook, 2=scaled)  [community notes, not re-verified here]',
  0x2e: 'Sync Source (0=Int, 1=USB, 2=MIDI, 3=Clock, 4=Auto)',
  0x3b: 'MIDI Thru (0=off, 1=on)',
};

/**
 * The param ids MIDI Control Center itself reads, extracted from the capture log
 * by matching the WHOLE request frame
 * `F0 00 20 6B 07 01 <seq> 01 43 <param> F7`.
 *
 * Matching the whole frame is not fussiness. A first pass grepped the loose
 * substring `01 43 <param>`, which also matches a frame whose SEQ byte happens
 * to be `0x43`: in `F0 00 20 6B 07 01 43 01 43 20 F7` the loose pattern finds
 * both `01 43 01` and `01 43 20`, inventing a read of param `0x01` that never
 * happened. That produced four phantom ids (`0x00`, `0x01`, `0x03`, `0x23`) and
 * a count of 27. The real figure is 23. Anchor on the envelope, not on a byte
 * pair that also occurs as data.
 *
 * This BOUNDS the search. All 128 slots answer a read, but MCC only reads the
 * globals it actually manages, so these 27 are the real Utility surface and the
 * other 101 are not settings worth chasing. With 8 identified above, that leaves
 * 19 candidates rather than 120, which turns an open-ended hunt into a finite
 * list. Cross-referenced against the manual's Utility > Global menu, the
 * settings still unmapped are: Local, Merge, Global Tempo, Clock PPQ, and the
 * five CV/Gate params (Pitch format, Gate format, Pressure range, 0V reference,
 * 1V reference).
 */
const MCC_MANAGED = new Set([
  0x20, 0x21, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2b, 0x2d, 0x2e, 0x31, 0x36,
  0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x41, 0x42,
]);

/**
 * What the maintainer has set on the front panel, for correlation. A param whose
 * value matches one of these is a CANDIDATE, never a conclusion: many params
 * share small integer values, so a match is a lead to confirm by toggling the
 * setting and re-reading, not proof.
 */
const EXPECTED: Array<{ label: string; value: number }> = [
  { label: 'MIDI Input Chan = 3', value: 3 },
  { label: 'MIDI Output Chan = 3', value: 3 },
  { label: 'Sync Source = MIDI (3rd of Int/USB/MIDI/Clock/Auto -> likely 2)', value: 2 },
  { label: 'MIDI Thru = On', value: 1 },
];

const isAnswer = (b: readonly number[], param: number): boolean =>
  b[1] === 0x00 && b[2] === 0x20 && b[3] === 0x6b && b[4] === 0x07
  && b[8] === 0x42 && b[9] === param;

const conn = connect({ needles: ['microfreak', 'arturia'], notFoundLeadIn: 'MicroFreak not found.' });
let seq = 0;
const found: Array<{ param: number; value: number }> = [];

for (let param = first; param <= last; param++) {
  const s = seq; seq = (seq + 1) & 0x7f;
  const waiter = conn.receiveSysExMatching((b) => isAnswer(b, param), 400).catch(() => undefined);
  // 0x43 = READ. Never 0x42 here.
  conn.send([0xf0, 0x00, 0x20, 0x6b, 0x07, 0x01, s, 0x01, 0x43, param, 0xf7]);
  const reply = await waiter;
  if (reply === undefined) continue;
  const value = reply[10];
  found.push({ param, value });
}

console.log(`Answered params: ${found.length} of ${last - first + 1} scanned\n`);
// `*` marks a param MCC itself reads, i.e. one of the 27 that are really
// Utility settings. An unidentified `*` row is a live candidate; an
// unidentified row WITHOUT one is almost certainly not a setting at all.
console.log('  param  value  MCC  note');
console.log('  -----  -----  ---  ----');
for (const { param, value } of found) {
  const hits = EXPECTED.filter((e) => e.value === value).map((e) => e.label);
  const note = KNOWN[param] ?? (hits.length > 0 ? `candidate: ${hits.join(' | ')}` : '');
  const mcc = MCC_MANAGED.has(param) ? ' * ' : '   ';
  console.log(`   0x${param.toString(16).padStart(2, '0')}   ${String(value).padStart(4)}  ${mcc}  ${note}`);
}

const remaining = [...MCC_MANAGED].filter((p) => KNOWN[p] === undefined).sort((a, b) => a - b);
console.log(`\n  * = one of the ${MCC_MANAGED.size} params MIDI Control Center read in the`);
console.log('      capture we hold. START with these, but they are a LOWER BOUND, not');
console.log('      the whole surface: that capture\'s own identity reply reads firmware');
console.log('      1.x, so it predates the vocoder entirely and CANNOT contain Mic Gain,');
console.log('      Noise Gate or Mic Detection. A fresh MCC capture on this firmware');
console.log('      would re-bound it. An unstarred id that MOVES in a diff is still a');
console.log('      real setting; trust the diff over this list.');
console.log(`\n  ${remaining.length} starred ids are still unidentified:`);
console.log(`    ${remaining.map((p) => `0x${p.toString(16).padStart(2, '0')}`).join(' ')}`);
console.log('  Still unmapped in the manual\'s Utility > Global menu: Local, Merge,');
console.log('  Global Tempo, Clock PPQ, and the five CV/Gate params. Firmware 5 adds the');
console.log('  vocoder mic settings on top, and those are NOT in the starred set.');

// Save a baseline so a param can be identified by DIFF: change exactly one
// setting on the device, re-run, and whichever param moved is that setting.
// This is the zero-risk way to build the param map, as opposed to writing
// speculative values with 0x42 and hoping to restore them.
mkdirSync('samples/arturia-microfreak/globals', { recursive: true });
const stamp = process.argv[4] ?? 'baseline';
const path = `samples/arturia-microfreak/globals/${stamp}.json`;
writeFileSync(path, JSON.stringify(found, null, 2));
console.log(`\nSnapshot saved: ${path}`);

// If a previous snapshot was named, diff against it.
const against = process.argv[5];
if (against !== undefined) {
  const prev = JSON.parse(readFileSync(`samples/arturia-microfreak/globals/${against}.json`, 'utf8')) as typeof found;
  const prevMap = new Map(prev.map((p) => [p.param, p.value]));
  const moved = found.filter((f) => prevMap.get(f.param) !== f.value);
  console.log(`\n--- diff vs "${against}" ---`);
  for (const m of moved) {
    console.log(`  param 0x${m.param.toString(16).padStart(2, '0')}: ${String(prevMap.get(m.param))} -> ${m.value}`);
  }
  if (moved.length === 0) {
    console.log('  NOTHING changed. Every global is identical to the baseline.');
  } else if (moved.length === 1) {
    console.log('  EXACTLY ONE param moved: that is the setting you changed. Identified.');
  } else {
    console.log('  More than one moved, so more than one setting changed. Change ONE at a time.');
  }
}

console.log('\nNOTE: a value match is a LEAD, not an identification. Nothing here wrote to the device.');
process.exit(0);
