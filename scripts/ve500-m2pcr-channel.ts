/**
 * VE-500 `midi_to_pcr` — point the pitch-correct MIDI target at a channel.
 *
 * ## Why this exists
 *
 * M>PCR ("MIDI to Pitch Correct") is the retune's note source: whatever channel
 * this names, the VE-500 tunes the singer to the notes arriving on it. It was set
 * to Ch.3 on 2026-07-26 because that is the Circuit's MIDI 1 track and the
 * MicroFreak's own channel.
 *
 * 2026-07-28 measured at the VE-500's own MIDI In that **ch3 never arrives**:
 * channels 1, 2, 4 and 10 all come through the Circuit -> MicroFreak -> VE-500
 * chain and ch3 alone is missing, because the MicroFreak ABSORBS its own receive
 * channel and relays the rest. So a target on ch3 can reach the MicroFreak or the
 * VE-500, never both, and the retune has no notes.
 *
 * The fix is to move the target to a channel the MicroFreak passes through.
 *
 * ## The two copies, and which one is live
 *
 * The unit stores M>PCR settings TWICE, per-patch and system-scope, and
 * `system_pref.preference_m2pcr` picks which one routes (0 = PATCH, 1 = SYSTEM).
 * This reads the preference first and says which copy is live, then writes BOTH,
 * because the 2026-07-26 decision was to keep them coherent so flipping the
 * preference back still routes instead of falling through to OFF.
 *
 * ⚠ The PATCH copy lives in the volatile edit buffer. It is not persisted until
 * the patch is STORED, so a power cycle or a front-panel patch change reverts it.
 * This script therefore also reads U97's STORED value non-destructively (at the
 * user-patch address, without recalling it) and says whether the change will
 * survive. It does NOT store: that overwrites a user patch location and is the
 * maintainer's call.
 *
 * ## Encoding
 *
 * wire 0..15 = Ch.1..Ch.16, 16 = RX, 17 = OFF. So Ch.2 is wire 1 and Ch.3 is
 * wire 2. Display units throughout; the wire value is printed alongside only so a
 * capture can be matched to it.
 *
 * Run:
 *   npx tsx scripts/ve500-m2pcr-channel.ts read        # read only, change nothing
 *   npx tsx scripts/ve500-m2pcr-channel.ts 2           # point M>PCR at Ch.2
 */
import { connect } from '../packages/core/src/midi/transport.js';
import {
  findParam, buildGetParam, buildSetParam, paramReplyMatcher, decodeParamReply,
  userPatchAddr, type Ve500ParamDef,
} from '../packages/roland-midi/src/ve-500/index.js';

const arg = (process.argv[2] ?? 'read').toLowerCase();
const TARGET_CH = arg === 'read' ? undefined : Number(arg);
if (TARGET_CH !== undefined && (!Number.isInteger(TARGET_CH) || TARGET_CH < 1 || TARGET_CH > 16)) {
  console.error(`Give a MIDI channel 1..16, or "read". Got "${arg}".`);
  process.exit(1);
}
/** Display channel (1..16) -> wire. 0..15 = Ch.1..Ch.16; 16 = RX, 17 = OFF. */
const wireOf = (ch: number): number => ch - 1;
const chanLabel = (w: number | undefined): string =>
  w === undefined ? 'NO REPLY' : w <= 15 ? `Ch.${w + 1}` : w === 16 ? 'RX' : w === 17 ? 'OFF' : `? (${w})`;

const U97_BASE = userPatchAddr(97);
const conn = connect({ needles: ['ve-500', 've500'], notFoundLeadIn: 'VE-500 not found.' });

function def(block: string, name: string): Ve500ParamDef {
  const d = findParam(block, name);
  if (!d) { console.error(`UNRESOLVED param '${block}.${name}'`); process.exit(1); }
  return d;
}
async function read(d: Ve500ParamDef, patchBase?: number): Promise<number | string | undefined> {
  const opts = patchBase === undefined ? undefined : { patchBase };
  const waiter = conn.receiveSysExMatching(paramReplyMatcher(d, opts), 800).catch(() => undefined);
  conn.send(buildGetParam(d, opts));
  const reply = await waiter;
  return reply === undefined ? undefined : decodeParamReply(d, reply, opts);
}
const num = async (d: Ve500ParamDef, patchBase?: number): Promise<number | undefined> => {
  const v = await read(d, patchBase);
  return typeof v === 'number' ? v : undefined;
};

console.log('\n=== VE-500 M>PCR channel ===\n');

const prefDef = def('system_pref', 'preference_m2pcr');
const patchDef = def('pitch_correct_midi', 'midi_to_pcr');
const sysDef = def('system_pitch_correct_midi', 'midi_to_pcr');
const zoneLoDef = def('pitch_correct_midi', 'midi_to_pcr_zone_lower');
const zoneHiDef = def('pitch_correct_midi', 'midi_to_pcr_zone_uppder');

const pref = await num(prefDef);
console.log(`  preference_m2pcr                        ${pref}  -> the ${pref === 0 ? 'PATCH' : pref === 1 ? 'SYSTEM' : '??'} copy is LIVE`);

const patchBefore = await num(patchDef);
const sysBefore = await num(sysDef);
console.log(`  pitch_correct_midi.midi_to_pcr          wire ${String(patchBefore).padStart(2)}  =  ${chanLabel(patchBefore)}   [PATCH copy]`);
console.log(`  system_pitch_correct_midi.midi_to_pcr   wire ${String(sysBefore).padStart(2)}  =  ${chanLabel(sysBefore)}   [SYSTEM copy]`);

const zoneLo = await num(zoneLoDef), zoneHi = await num(zoneHiDef);
const zoneNote = (z: number | undefined): string => (z === undefined ? '?' : String(z + 24));
console.log(`  PATCH note zone                         ${zoneLo}..${zoneHi}  = MIDI ${zoneNote(zoneLo)}..${zoneNote(zoneHi)}  (notes outside are silently dropped)`);

const storedU97 = await num(patchDef, U97_BASE);
const nameU97 = await read(def('common', 'patch_name'), U97_BASE);
console.log(`  U97 STORED (read, not recalled)         wire ${String(storedU97).padStart(2)}  =  ${chanLabel(storedU97)}   patch name ${typeof nameU97 === 'string' ? `"${nameU97}"` : String(nameU97)}`);

if (TARGET_CH === undefined) {
  console.log('\nRead-only mode. Nothing was written.\n');
  conn.close();
  process.exit(0);
}

const target = wireOf(TARGET_CH);
console.log(`\n  writing BOTH copies -> wire ${target} = Ch.${TARGET_CH}\n`);
for (const [label, d, before] of [['PATCH ', patchDef, patchBefore], ['SYSTEM', sysDef, sysBefore]] as const) {
  if (before === target) { console.log(`  ${label}  already ${chanLabel(target)}; no write needed.`); continue; }
  conn.send(buildSetParam(d, target));
  await new Promise((r) => setTimeout(r, 200));
  const after = await num(d);
  const ok = after === target;
  console.log(`  ${label}  ${chanLabel(before)} -> ${chanLabel(after)}  (wire ${before} -> ${after})  ${ok ? 'VERIFIED' : 'VERIFY FAILED'}`);
  if (!ok) { conn.close(); process.exit(1); }
}

console.log('');
console.log('  ⚠ The PATCH copy is the LIVE one and lives in the VOLATILE edit buffer.');
console.log(`    U97 still stores ${chanLabel(storedU97)}, so a power cycle or a front-panel patch`);
console.log('    change reverts this. To make it permanent, store the buffer to U97.');
console.log('');
conn.close();
process.exit(0);
