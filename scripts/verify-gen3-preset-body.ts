/**
 * Cross-validation golden for the gen-3 decompressed-body decoder (presetBody.ts).
 *
 * Unlike the Huffman/CRC codec, body offset-parsing is NOT self-validating — a
 * wrong offset yields a plausible-but-wrong value. So this script proves the TS
 * decoder byte-for-byte against the BoodieTraps reference Python decoder across
 * every Axe-Fx III factory preset (N=384) plus an FM9 export, when both the
 * gitignored sample banks AND a Python interpreter with the reference repo are
 * present locally. That is the real gate.
 *
 * On a machine without the samples/Python (CI, a fresh clone), it falls back to
 * self-contained structural sanity checks so preflight stays green; the strong
 * cross-check runs on the maintainer's machine where the private inputs live.
 *
 * Compares: preset name, scene names, routing grid (every cell), the placed
 * block chain (block id, cols/rows, body offsets, per-channel effect types,
 * scene channel/bypass state, amp model + amp knobs, cab banks/dynacab),
 * modifier routing, and scene-controller values. Floats compare with a small
 * epsilon (banker's vs half-up rounding at the last decimal).
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  parsePresetBank,
  parsePresetDump,
  serializePresetDump,
} from '../packages/fractal-gen3/dist/presetDump.js';
import { decodeRawPatch, huffmanUncompress } from '../packages/fractal-gen3/dist/presetHuffman.js';
import {
  decodeGen3Body,
  decodeGen3PresetDump,
  Gen3EmptyPresetError,
  fm3CabProximityFrequencyFieldByteOffset,
  FM3_CAB_PROXIMITY_FREQUENCY_BODY_INDEX,
  FM3_CAB_PROXIMITY_FREQUENCY_PARAM_ID,
  typeName,
} from '../packages/fractal-gen3/dist/presetBody.js';
import { gen3WholePresetToSpec } from '../packages/core/dist/protocol-generic/gen3-source.js';
import { translatePresetSpec } from '../packages/core/dist/protocol-generic/port-preset.js';
import type { Gen3WholePresetView } from '../packages/core/dist/protocol-generic/types.js';
import { AXEFX3_DESCRIPTOR } from '../packages/fractal-gen3/dist/descriptor.js';
import { AM4_DESCRIPTOR } from '../packages/am4/dist/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '../packages/fractal-gen2/dist/descriptor.js';

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { ok += 1; }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
}

const EPS = 0.02;
/** First mismatch path between a reference value (from the oracle JSON) and the
 *  TS value, or '' when equal. Numbers compare within EPS; the oracle is the
 *  authority on which keys exist. */
function diff(ref: unknown, got: unknown, path: string): string {
  if (typeof ref === 'number' && typeof got === 'number') {
    return Math.abs(ref - got) <= EPS ? '' : `${path}: ref=${ref} got=${got}`;
  }
  if (Array.isArray(ref)) {
    if (!Array.isArray(got)) return `${path}: ref is array, got ${typeof got}`;
    if (ref.length !== got.length) return `${path}: len ref=${ref.length} got=${got.length}`;
    for (let i = 0; i < ref.length; i++) {
      const d = diff(ref[i], got[i], `${path}[${i}]`);
      if (d) return d;
    }
    return '';
  }
  if (ref !== null && typeof ref === 'object') {
    if (got === null || typeof got !== 'object') return `${path}: ref is object, got ${typeof got}`;
    const g = got as Record<string, unknown>;
    for (const [k, v] of Object.entries(ref as Record<string, unknown>)) {
      // 'level': the reference reads an amp dB at body word 18, but that word
      // yields implausible factory distributions (median -30 dB) and is unverified
      // against device ground truth, so our decoder deliberately omits it. Skip
      // the comparison rather than fail on a field we chose not to surface.
      if (k === 'level') continue;
      const d = diff(v, g[k], path ? `${path}.${k}` : k);
      if (d) return d;
    }
    return '';
  }
  return ref === got ? '' : `${path}: ref=${JSON.stringify(ref)} got=${JSON.stringify(got)}`;
}

const FACTORY_DIR = 'samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06';
const III_BANKS = [
  `${FACTORY_DIR}/Axe-Fx_III_BANK_A-250603-182903.syx`,
  `${FACTORY_DIR}/Axe-Fx_III_BANK_B-250603-182903.syx`,
  `${FACTORY_DIR}/Axe-Fx_III_BANK_C-250603-182903.syx`,
];
const FM9_EXPORT = 'samples/captured/fm9-152-super-duos2-exported-2026-06-03.syx';
const ORACLE_REPO = 'docs/_private/fractal-syx-codec-main/fractal-syx-codec-main';
const ORACLE_CODEC = `${ORACLE_REPO}/packages/codec`;

console.log('gen-3 preset body decoder cross-validation:\n');

// ── 1. Self-contained structural sanity (always on) ───────────────────
// A hand-built body fragment: grid cell at col0/row0 with effect id 58 (Amp 1)
// and a route flag, decoded through parseGrid via decodeGen3Body's grid path is
// hard to forge in isolation, so we assert the pure helpers instead through a
// real decode below. Here we only assert the module loads and rejects junk.
check('decodeGen3Body on an all-zero body yields no blocks/grid noise', (() => {
  const r = decodeGen3Body(new Uint8Array(0x2000), 0x10);
  return (r.blocks === undefined || r.blocks.length === 0) && (r.grid === undefined || r.grid.length === 0);
})());

// Issue #16 regression: TYPE_BINARY_IDS (the whole-preset decode table) is
// missing amp ordinal 132 "FAS Modern II" — confirmed against a live FM9
// front panel. typeName() must fall back to GEN3_READ_ROSTERS.DISTORT_TYPE
// for exactly this gap, without disturbing an ordinal TYPE_BINARY_IDS
// already covers (a fallback that shadowed real entries would silently
// rename other amps).
check(
  'typeName("Amp", 132) falls back to the live-read roster ("FAS Modern II")',
  typeName('Amp', 132) === 'FAS Modern II',
  `got=${JSON.stringify(typeName('Amp', 132))}`,
);
check(
  'typeName("Amp", 0) still resolves via TYPE_BINARY_IDS (fallback does not shadow covered ordinals)',
  typeof typeName('Amp', 0) === 'string' && typeName('Amp', 0)!.length > 0,
  `got=${JSON.stringify(typeName('Amp', 0))}`,
);

// FM3 fw 13 hardware captures: the front-panel Proximity Frequency knob was
// the only intentional edit (100 Hz -> 120 Hz). Both captures traverse the
// production SysEx/container/Huffman/body decoder; no raw-file cmp oracle.
// Stored-body decode only — NOT calibration evidence for the live-wire
// CABINET_PROXFREQ paramId (see the comment on FM3_CAB_PROXIMITY_FREQUENCY_PARAM_ID).
// samples/ is gitignored (private captures), so this gates on existsSync like
// the III/FM9 cross-checks below — green on the maintainer's machine, a no-op
// on a fresh clone/CI where the captures aren't present.
const PROXIMITY_CAPTURES = [
  { hz: 100, raw: 45806, path: 'samples/captured/proximity-frequency-100hz.syx' },
  { hz: 120, raw: 50995, path: 'samples/captured/proximity-frequency-120hz.syx' },
] as const;
if (PROXIMITY_CAPTURES.every((capture) => existsSync(capture.path))) {
  for (const capture of PROXIMITY_CAPTURES) {
    const source = new Uint8Array(readFileSync(capture.path));
    const parsed = parsePresetDump(source);
    const decoded = decodeRawPatch(parsed.chunkPayloads);
    const body = decodeGen3Body(decoded.body, parsed.modelId);
    const cab = body.blocks?.find((b) => b.block === 'Cab');
    const offset = cab ? fm3CabProximityFrequencyFieldByteOffset(cab, 'B') : -1;
    const raw = offset >= 0 ? decoded.body[offset] | (decoded.body[offset + 1] << 8) : -1;
    check(`FM3 Proximity Frequency ${capture.hz} Hz: model`, parsed.modelId === 0x11);
    check(`FM3 Proximity Frequency ${capture.hz} Hz: CRC`, decoded.crcValid);
    // Issue #34.4 on a second device and a newer firmware: this capture's
    // Delay, Drive and Chorus tables are 89, 44 and 32 columns wide, sizes the
    // table-size map does not list, so the old decode dropped all three.
    const fams = (body.blocks ?? []).map((b) => b.block).join(',');
    check(`FM3 Proximity Frequency ${capture.hz} Hz: every placed block is named from the grid`,
      body.blocks_identified_by === 'grid' && fams === 'Amp,Cab,Chorus,Comp,Delay,Flanger,Drive,Input,Output,Phaser,Reverb,Wah', `by=${body.blocks_identified_by} got=${fams}`);
    check(`FM3 Proximity Frequency ${capture.hz} Hz: live paramId`, FM3_CAB_PROXIMITY_FREQUENCY_PARAM_ID === 41);
    check(`FM3 Proximity Frequency ${capture.hz} Hz: stored-body index`, FM3_CAB_PROXIMITY_FREQUENCY_BODY_INDEX === 35);
    check(`FM3 Proximity Frequency ${capture.hz} Hz: raw u16 LE`, raw === capture.raw, `got=${raw}`);
    check(
      `FM3 Proximity Frequency ${capture.hz} Hz: decoded display`,
      cab?.channels?.B?.proximity_frequency_hz === capture.hz,
      `got=${String(cab?.channels?.B?.proximity_frequency_hz)}`,
    );
  }
}

// ── 2. Reference cross-check (when samples + Python present) ──────────
function findPython(): string | undefined {
  for (const cmd of ['python', 'py', 'python3']) {
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (r.status === 0 || `${r.stdout ?? ''}${r.stderr ?? ''}`.toLowerCase().includes('python')) return cmd;
  }
  return undefined;
}

interface OraclePreset { preset_name: string; params?: Record<string, unknown>; error?: string }

function runOracleBank(py: string, bankPath: string, modelId: number): OraclePreset[] | undefined {
  const script =
    `import json,sys;sys.path.insert(0,r'${ORACLE_CODEC}');` +
    `import fm3_syx_decoder as d;` +
    `syx=open(r'${bankPath}','rb').read();` +
    `print(json.dumps(d.decode_bank(syx, ${modelId})))`;
  const r = spawnSync(py, ['-c', script], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) {
    console.log(`  (oracle failed for ${bankPath}): ${(r.stderr || '').split('\n')[0]}`);
    return undefined;
  }
  try { return JSON.parse(r.stdout) as OraclePreset[]; } catch { return undefined; }
}

function compareOne(ref: OraclePreset, tsBody: ReturnType<typeof decodeGen3Body>, tsName: string, label: string): void {
  check(`${label}: preset name`, ref.preset_name === tsName, `ref="${ref.preset_name}" got="${tsName}"`);
  const rp = ref.params ?? {};
  // Only the fields the oracle emits are compared; the oracle is the authority.
  for (const field of ['scene_names', 'grid', 'amp1', 'modifiers', 'scene_controllers'] as const) {
    if (!(field in rp)) continue;
    const d = diff(rp[field], oracleVocabulary((tsBody as Record<string, unknown>)[field]), field);
    check(`${label}: ${field}`, d === '', d);
  }
  if ('blocks' in rp) {
    const d = diffBlocks(rp.blocks as OracleBlock[], tsBody.blocks ?? []);
    check(`${label}: blocks`, d === '', d);
  }
  // What the oracle cannot check: every block placed on the grid has exactly
  // one chain entry, named from the grid (issue #34.4).
  const placed = [...new Set((tsBody.grid ?? []).filter((c) => !c.is_shunt).map((c) => c.effect_id))].sort((a, b) => a - b);
  const named = (tsBody.blocks ?? []).map((b) => b.effect_id ?? -1).sort((a, b) => a - b);
  check(`${label}: blocks are named from the grid, one per placed block`,
    tsBody.blocks_identified_by === 'grid' && JSON.stringify(placed) === JSON.stringify(named),
    `by=${tsBody.blocks_identified_by} grid=${placed.join(',')} blocks=${named.join(',')}`);
}

/**
 * The reference decoder names blocks by parameter-table size alone and does
 * not know four families. Ours names them from the grid. To keep the oracle
 * useful for everything else, the comparison allows exactly these corrections
 * and nothing more:
 *  - families the oracle prints as a bare id (`eid_170`) are mapped back;
 *  - a block the oracle found is compared at its byte offset, and its name may
 *    differ only by a pair in ORACLE_MISNAMES (same table size, different
 *    block: the oracle's known confusions);
 *  - blocks the oracle did not find at all (ours has more) are not an error;
 *  - Rotary's "type" is dropped on our side (the block has none).
 */
const ORACLE_UNKNOWN_FAMILIES: Record<string, number> = { 'Crossover': 142, 'Tone Match': 170, 'RTA': 174, 'IR Player': 195 };
const ORACLE_MISNAMES = new Set([
  'Vol/Pan>Input', 'PEQ>Output', 'Enhancer>Formant', 'Flanger>PEQ', 'Comp>Filter', 'Comp>MultiComp',
  'Filter>Comp', 'Filter>MultiComp', 'MultiComp>Comp', 'MultiComp>Filter', 'Return>RTA', 'Vol/Pan>eid_202',
  // Same column count, different row count: the oracle ignores rows.
  'Enhancer>RingMod', 'Tremolo>Tone Match', 'Phaser>Megatap',
]);
interface OracleBlock { block: string; offset: number; [k: string]: unknown }

function oracleVocabulary(v: unknown): unknown {
  if (typeof v === 'string') {
    const m = /^(.*) ([1-4])$/.exec(v);
    if (v === 'Input 5') return 'eid_41';
    if (m && m[1] in ORACLE_UNKNOWN_FAMILIES) return `eid_${ORACLE_UNKNOWN_FAMILIES[m[1]] + Number(m[2]) - 1}`;
    return v;
  }
  if (Array.isArray(v)) return v.map(oracleVocabulary);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, oracleVocabulary(x)]));
  return v;
}

function diffBlocks(ref: OracleBlock[], got: ReadonlyArray<{ block: string; offset: number }>): string {
  for (const r of ref) {
    const g = got.find((b) => b.offset === r.offset);
    if (!g) return `oracle block ${r.block} at offset ${r.offset} is missing from ours`;
    if (g.block !== r.block) {
      if (!ORACLE_MISNAMES.has(`${r.block}>${g.block}`)) return `offset ${r.offset}: ref="${r.block}" got="${g.block}" (not a known oracle confusion)`;
      const d = diff({ cols: r.cols, rows: r.rows, scene_channels: r.scene_channels, scene_bypass: r.scene_bypass }, g, `blocks@${r.offset}`);
      if (d) return d;
      continue;
    }
    const rr: Record<string, unknown> = { ...r };
    if (r.block === 'Rotary') { delete rr.type_id; delete rr.type; delete rr.channels; }
    const d = diff(rr, g, `blocks@${r.offset}`);
    if (d) return d;
  }
  return '';
}

const samplesPresent = III_BANKS.every(existsSync);
const py = findPython();
const oracleAvailable = samplesPresent && py !== undefined && existsSync(ORACLE_CODEC);

if (!samplesPresent) {
  console.log('  (skip) III factory banks not present — self-contained checks only.');
} else if (!oracleAvailable) {
  // Samples but no Python oracle: structural-only sanity across all presets.
  let presets = 0;
  let ampNamed = 0;
  for (const bank of III_BANKS) {
    const bytes = new Uint8Array(readFileSync(bank));
    for (const parsed of parsePresetBank(bytes, 0x10)) {
      const decoded = decodeRawPatch(parsed.chunkPayloads);
      const body = decodeGen3Body(decoded.body, 0x10);
      presets++;
      if (body.amp1?.A?.type) ampNamed++;
      check(`III preset ${presets}: CRC valid`, decoded.crcValid);
      check(`III preset ${presets}: has a grid`, (body.grid?.length ?? 0) > 0);
    }
  }
  console.log(`  (no Python oracle) structural-only: ${presets} III presets, ${ampNamed} with a named amp model.`);
} else {
  console.log(`  cross-checking against reference decoder (${py}) ...`);
  let presets = 0;
  for (const bank of III_BANKS) {
    const oracle = runOracleBank(py as string, bank, 0x10);
    if (!oracle) { check(`oracle bank ${bank}`, false, 'oracle produced no output'); continue; }
    const bytes = new Uint8Array(readFileSync(bank));
    const dumps = parsePresetBank(bytes, 0x10);
    check(`${bank}: preset count matches oracle`, dumps.length === oracle.length, `ts=${dumps.length} oracle=${oracle.length}`);
    for (let i = 0; i < Math.min(dumps.length, oracle.length); i++) {
      const decoded = decodeRawPatch(dumps[i].chunkPayloads);
      const body = decodeGen3Body(decoded.body, 0x10);
      // raw_patch header name (offset 0x08), matches the oracle's raw_patch[8:40].
      let name = '';
      for (let k = 0x08; k < 0x28; k++) { const b = decoded.rawPatch[k]; if (!b) break; name += String.fromCharCode(b); }
      name = name.trim();
      compareOne(oracle[i], body, name, `III ${bank.includes('BANK_A') ? 'A' : bank.includes('BANK_B') ? 'B' : 'C'}[${i}]`);
      presets++;
    }
  }
  console.log(`  cross-checked ${presets} III factory presets against the reference decoder.`);

  // FM9 export (single dump, model 0x12) through the one-shot path.
  if (existsSync(FM9_EXPORT)) {
    const bytes = new Uint8Array(readFileSync(FM9_EXPORT));
    const tsAll = decodeGen3PresetDump(bytes, 0x12);
    const oracleScript =
      `import json,sys;sys.path.insert(0,r'${ORACLE_CODEC}');import fm3_syx_decoder as d;` +
      `print(json.dumps(d.decode_syx(open(r'${FM9_EXPORT}','rb').read(), 0x12)))`;
    const r = spawnSync(py as string, ['-c', oracleScript], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) {
      const ref = JSON.parse(r.stdout) as OraclePreset;
      check('FM9 152 export: model id', tsAll.model_id === 0x12);
      check('FM9 152 export: CRC valid', tsAll.crc_valid);
      compareOne(ref, tsAll, tsAll.preset_name, 'FM9 152');
    } else {
      console.log(`  (oracle FM9 decode failed): ${(r.stderr || '').split('\n')[0]}`);
    }
  }
}

// ── 3. One-shot path smoke (uses the III bank A first dump if present) ─
if (existsSync(III_BANKS[0])) {
  const bytes = new Uint8Array(readFileSync(III_BANKS[0]));
  const first = parsePresetDump(bytes, 0, 0x10);
  const one = decodeGen3PresetDump(bytes.subarray(0, first.byteLength), 0x10);
  check('decodeGen3PresetDump one-shot: III preset 0 is "59 Bassguy"', one.preset_name === '59 Bassguy', one.preset_name);
  check('decodeGen3PresetDump one-shot: amp model is "59 Bassguy Bright"', one.amp1?.A?.type === '59 Bassguy Bright', String(one.amp1?.A?.type));
  check('decodeGen3PresetDump one-shot: CRC valid', one.crc_valid);

  // ── gen-3 -> AM4 / II translate path (decode -> map -> translate) ────
  // The decoded preset becomes a canonical PresetSpec (gen3WholePresetToSpec),
  // which the pure translator ports to AM4 (linear, 4 scenes) and II (grid, 8
  // scenes, X/Y). Fully offline; proves the source-side leg of the HW-118 path.
  const view: Gen3WholePresetView = {
    source: 'stored-dump',
    model: one.model_name,
    model_id: one.model_id,
    preset_name: one.preset_name,
    crc_valid: one.crc_valid,
    scene_names: one.scene_names,
    grid: one.grid,
    blocks: one.blocks,
    amp: one.amp1,
    modifiers: one.modifiers,
    scene_controllers: one.scene_controllers,
  };
  const { spec, notes } = gen3WholePresetToSpec(view);
  const ampSlot = spec.slots.find((s) => s.block_type === 'amp');
  check('gen3->spec: preset name carried', spec.name === '59 Bassguy', String(spec.name));
  check('gen3->spec: an amp slot exists', ampSlot !== undefined);
  check('gen3->spec: amp slot carries the model in params.type', (ampSlot?.params as Record<string, unknown> | undefined)?.type === '59 Bassguy Bright', JSON.stringify((ampSlot?.params as Record<string, unknown> | undefined)?.type));
  check('gen3->spec: routing/utility nodes (Return) excluded from slots', !spec.slots.some((s) => s.block_type === 'return'), spec.slots.map((s) => s.block_type).join(','));
  check('gen3->spec: 8 scenes carried', (spec.scenes?.length ?? 0) === 8, String(spec.scenes?.length));
  check('gen3->spec: emits type-only knob-limit note', notes.some((n) => n.includes('non-amp knob VALUES are not decoded')));

  const toAm4 = translatePresetSpec(AXEFX3_DESCRIPTOR, spec, AM4_DESCRIPTOR);
  check('gen3->AM4 translate: ok', toAm4.ok, JSON.stringify(toAm4.warnings?.slice(0, 2)));
  check('gen3->AM4 translate: amp survives', toAm4.applied_spec.slots.some((s) => s.block_type === 'amp'));
  check('gen3->AM4 translate: blocks_translated > 0', toAm4.port_summary.blocks_translated > 0, String(toAm4.port_summary.blocks_translated));
  check('gen3->AM4 translate: scenes collapse 8->4 reported', toAm4.port_summary.scene_collapses > 0, String(toAm4.port_summary.scene_collapses));
  check('gen3->AM4 translate: cab dropped (AM4 integrates cab)', toAm4.port_summary.blocks_dropped.some((d) => d.block.toLowerCase() === 'cab'), JSON.stringify(toAm4.port_summary.blocks_dropped));

  const toII = translatePresetSpec(AXEFX3_DESCRIPTOR, spec, AXEFX2_DESCRIPTOR);
  check('gen3->II translate: ok', toII.ok);
  check('gen3->II translate: amp survives', toII.applied_spec.slots.some((s) => s.block_type === 'amp'));
  check('gen3->II translate: II keeps 8 scenes (no collapse)', toII.port_summary.scene_collapses === 0, String(toII.port_summary.scene_collapses));
}

// An empty preset location. A III owner's stored read of an unused location
// died with "Maximum call stack size exceeded": the container held no
// compressed body, and the tree reader took the zeros past the end of the data
// as an endless run of internal nodes. Needs no sample file: the dump is built
// here, all zeros between valid frame envelopes.
{
  const thrown = (fn: () => unknown): Error | undefined => { try { fn(); return undefined; } catch (e) { return e as Error; } };
  const e1 = thrown(() => huffmanUncompress(new Uint8Array(0), 0));
  check('empty: a zero-length compressed body refuses with a reason, not a stack overflow',
    e1 !== undefined && !(e1 instanceof RangeError) && /past the end/.test(e1.message), String(e1));
  const e2 = thrown(() => huffmanUncompress(new Uint8Array(64), 100));
  check('empty: a body of zeros (no tree) refuses with a reason, not a stack overflow',
    e2 !== undefined && !(e2 instanceof RangeError) && /Huffman tree/.test(e2.message), String(e2));
  const zeroChunks = Array.from({ length: 16 }, () => new Uint8Array(3074));
  const d = decodeRawPatch(zeroChunks);
  check('empty: an all-zero container decodes as empty with a zero-length body', d.empty === true && d.body.length === 0 && d.compSize === 0);
  const dump = serializePresetDump({
    modelId: 0x10,
    raw: new Uint8Array(0),
    byteLength: 0,
    headerPayload: new Uint8Array(5),
    chunkPayloads: zeroChunks,
    footerPayload: new Uint8Array(3),
  });
  const e3 = thrown(() => decodeGen3PresetDump(dump, 0x10));
  check('empty: a whole dump of an empty location raises Gen3EmptyPresetError', e3 instanceof Gen3EmptyPresetError, String(e3));
}

console.log(`\n${ok} ok, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
