/**
 * VE-500 PRE-SAVE CHECK — READ-ONLY. Sends RQ1 queries only, never a DT1.
 *
 * Answers "is it safe to hit WRITE on this patch?" by reading the live edit
 * buffer and the STORED user patch at its own address (no recall, no clobber)
 * and reporting what a front-panel WRITE would bake in.
 *
 * Phase 1  the PITCH CORRECT block, in display units, live vs stored.
 * Phase 2  every per-patch param, live vs stored, printing only the DIFFS —
 *          which is the real answer: it names exactly what the save changes.
 * Phase 3  the SYSTEM params, which a patch WRITE does NOT store.
 *
 * Run:  npx tsx scripts/ve500-presave-check.ts [patchNumber=97] [--quick]
 */
import { connect } from '../packages/core/src/midi/transport.js';
import {
  findParam, buildGetParam, paramReplyMatcher, decodeParamReply,
  userPatchAddr, VE500_PARAMS, type Ve500ParamDef,
} from '../packages/roland-midi/src/ve-500/index.js';

const PATCH = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 97);
const QUICK = process.argv.includes('--quick');
const BASE = userPatchAddr(PATCH);
const conn = connect({ needles: ['ve-500', 've500'], notFoundLeadIn: 'VE-500 not found.' });

function def(block: string, name: string): Ve500ParamDef {
  const d = findParam(block, name);
  if (!d) { console.error(`UNRESOLVED ${block}.${name}`); process.exit(1); }
  return d;
}
async function read(d: Ve500ParamDef, patchBase?: number): Promise<number | string | undefined> {
  const opts = patchBase === undefined ? undefined : { patchBase };
  const w = conn.receiveSysExMatching(paramReplyMatcher(d, opts), 900).catch(() => undefined);
  conn.send(buildGetParam(d, opts));
  const reply = await w;
  return reply === undefined ? undefined : decodeParamReply(d, reply, opts);
}

const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const chan = (w: unknown) =>
  typeof w !== 'number' ? 'NO REPLY' : w <= 15 ? `Ch.${w + 1}` : w === 16 ? 'RX' : w === 17 ? 'OFF' : `?(${w})`;
const sign = (n: number) => `${n >= 0 ? '+' : ''}${n}`;

/**
 * Display-unit rendering. The catalog carries ofs=0 for the centred params
 * (STABILITY 0..20 centre 10, FORMANT 0..100 centre 50), so the panel's signed
 * shape is applied here rather than guessed at the call site. Wire is printed
 * alongside so a capture can be matched to it either way.
 */
function show(d: Ve500ParamDef, wire: number): string {
  const lbl = d.enum_values?.[wire];
  if (lbl !== undefined) return String(lbl);
  if (d.block === 'pitch_correct') {
    if (d.param === 'switch') return wire === 1 ? 'ON' : 'OFF';
    if (d.param === 'stability') return sign(wire - 10);
    if (d.param === 'formant') return `${sign(wire - 50)} (centre=50)`;
    if (d.param === 'note') return NOTE[wire] ?? `?(${wire})`;
  }
  if (d.max === 1 && d.display_name.trim().toLowerCase().endsWith('switch')) {
    return wire === 1 ? 'ON' : 'OFF';
  }
  return String(wire);
}

console.log(`\n=== VE-500 PRE-SAVE CHECK vs U${PATCH} (READ-ONLY) ===\n`);

const nameDef = def('common', 'patch_name');
console.log(`  live buffer name : ${JSON.stringify(await read(nameDef))}`);
console.log(`  U${PATCH} stored name  : ${JSON.stringify(await read(nameDef, BASE))}\n`);

// --- Phase 1: pitch correct -------------------------------------------------
const WANT: ReadonlyArray<[string, string, string]> = [
  ['pitch_correct', 'switch', 'ON'],
  ['pitch_correct', 'type', 'ELECTRIC'],
  ['pitch_correct', 'speed', '10'],
  ['pitch_correct', 'stability', '+5'],
  ['pitch_correct', 'shift', '0'],
  ['pitch_correct', 'formant', '+0 (centre=50)'],
  ['pitch_correct', 'scale', 'CHROMATIC'],
  ['pitch_correct', 'note', '(patch default)'],
];
console.log(`  PITCH CORRECT   live                      want              U${PATCH} stored`);
let bad = 0;
for (const [b, p, want] of WANT) {
  const d = def(b, p);
  const live = await read(d);
  const st = await read(d, BASE);
  if (typeof live !== 'number') { console.log(`  ${p.padEnd(12)}  NO REPLY`); bad++; continue; }
  const liveS = show(d, live);
  const stS = typeof st === 'number' ? show(d, st) : 'NO REPLY';
  const ok = want === '(patch default)' ? true : liveS === want;
  if (!ok) bad++;
  console.log(
    `  ${p.padEnd(12)}  ${`${liveS} [w${live}]`.padEnd(24)} ${want.padEnd(17)} ${stS.padEnd(16)} ${ok ? 'OK' : '*** MISMATCH ***'}`,
  );
}
const m2 = def('pitch_correct_midi', 'midi_to_pcr');
const m2live = await read(m2);
console.log(
  `  ${'midi_to_pcr'.padEnd(12)}  ${`${chan(m2live)} [w${m2live}]`.padEnd(24)} ${'Ch.2'.padEnd(17)} ${chan(await read(m2, BASE)).padEnd(16)} ${chan(m2live) === 'Ch.2' ? 'OK' : '*** MISMATCH ***'}`,
);

// --- Phase 2: full diff -----------------------------------------------------
if (!QUICK) {
  console.log(`\n  FULL DIFF, live edit buffer vs stored U${PATCH} (what a WRITE would change):`);
  let diffs = 0, noreply = 0, checked = 0;
  for (const d of VE500_PARAMS) {
    const live = await read(d);
    if (live === undefined) { noreply++; continue; }
    const st = await read(d, BASE);
    if (st === undefined) { noreply++; continue; }
    checked++;
    if (live === st) continue;
    diffs++;
    const l = typeof live === 'number' ? `${show(d, live)} [w${live}]` : JSON.stringify(live);
    const s = typeof st === 'number' ? `${show(d, st)} [w${st}]` : JSON.stringify(st);
    console.log(`    ${`${d.block}.${d.param}`.padEnd(44)} stored ${s.padEnd(26)} ->  live ${l}`);
  }
  console.log(`\n    ${diffs} difference(s) across ${checked} params${noreply ? `, ${noreply} no-reply` : ''}.`);
}

// --- Phase 3: system params -------------------------------------------------
console.log('\n  SYSTEM params — a patch WRITE does NOT store these:');
const SYS: ReadonlyArray<[string, string]> = [
  ['system_pref', 'preference_m2pcr'],
  ['system_pitch_correct_midi', 'midi_to_pcr'],
  ['system_midi', 'midi_rx_channel'],
  ['system_midi', 'midi_rx_omni_mode'],
  ['system_midi', 'midi_tx_channel'],
  ['system_midi', 'midi_program_change_in'],
  ['system_midi', 'midi_program_change_out'],
  ['system_midi', 'midi_bank_out'],
  ['system_midi', 'midi_sync_source'],
  ['system_midi', 'midi_realtime_out_source'],
  ['system_midi', 'midi_usb_out_thru'],
];
for (const [b, p] of SYS) {
  const d = def(b, p);
  const v = await read(d);
  const note = p === 'preference_m2pcr'
    ? `  -> the ${v === 0 ? 'PATCH' : v === 1 ? 'SYSTEM' : '??'} copy is LIVE`
    : b === 'system_pitch_correct_midi' || p.endsWith('rx_channel') || p.endsWith('tx_channel')
      ? `  = ${chan(v)}`
      : '';
  console.log(`  ${`${b}.${p}`.padEnd(42)} ${String(v).padStart(4)}${note}`);
}

console.log(`\n  ${bad === 0 ? 'Pitch-correct block matches expectations.' : `${bad} pitch-correct problem(s).`}  Nothing was written.\n`);
conn.close();
process.exit(0);
