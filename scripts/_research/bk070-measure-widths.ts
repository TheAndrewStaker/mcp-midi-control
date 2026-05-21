/**
 * BK-070 Session 116 cont — measure per-block-name BINARY WIDTH.
 *
 * Algorithm (Ghidra-confirmed alphabetical-by-block-name packing):
 *   - The preset binary lays out each placed block-type's data
 *     consecutively in ALPHABETICAL ORDER by canonical block-name
 *     (the strings AxeEdit's FUN_00595260 compares against).
 *   - Each block-name reserves a FIXED WIDTH (in ushorts). This
 *     script measures that width per block-name.
 *
 * Method:
 *   1. Apply a layout with multiple blocks placed in row 2.
 *   2. Force every placed block to channel X via raw fn 0x11.
 *   3. Save (commit channel state into binary) + dump baseline.
 *   4. For each placed block: send raw fn 0x02 SET_PARAM with a
 *      UNIQUE per-block target wire value on a known knob paramId.
 *   5. Save + dump after.
 *   6. For each block, search the diff for its unique target wire
 *      value → derive (chunk, ushort) where it landed → X paramBase
 *      = (chunk, ushort - paramId).
 *   7. Sort placed blocks alphabetically by canonical name. Consecutive
 *      X paramBase differences = per-block-name widths.
 *
 * Batched run via BATCH env var: 'A' (Amp..Filter), 'B' (Flanger..
 * Pitch), 'C' (Resonator..Wah). Hardware-light: ~30s per batch.
 *
 * Restores Test Crunch at end so the device is left clean.
 */

import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import {
  executeSwitchPreset,
  executeSavePreset,
  executeSwitchScene,
} from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { executeApplyPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/preset.js';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { parsePresetDump } from '@mcp-midi-control/axe-fx-ii/presetDump.js';

registerDevice(AXEFX2_DESCRIPTOR);

const csum = (b: number[]): number => { let a = 0; for (const x of b) a ^= x; return a & 0x7f; };
const build = (fn: number, payload: number[]): number[] => { const h = [0xf0, 0x00, 0x01, 0x74, 0x07, fn, ...payload]; return [...h, csum(h), 0xf7]; };
const septet14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];

function decodeChunk(p: Uint8Array): Uint16Array {
  const c = (p[0]&0x7f)|((p[1]&0x7f)<<7);
  const o = new Uint16Array(c);
  for (let i=0;i<c;i++) { const off=2+i*3; o[i]=((p[off]&0x7f)|((p[off+1]&0x7f)<<7)|((p[off+2]&0x7f)<<14))&0xffff; }
  return o;
}

type Conn = ReturnType<typeof connectAxeFxII>;

async function dump(conn: Conn): Promise<Uint8Array> {
  const frames: number[][] = [];
  const unsub = conn.onMessage(b => { if (b[0]===0xf0 && b[4]===0x07 && [0x77,0x78,0x79].includes(b[5])) frames.push([...b]); });
  conn.send(build(0x03, [(665 >> 7) & 0x7f, 665 & 0x7f]));
  await new Promise(r => setTimeout(r, 3000));
  unsub();
  if (frames.length !== 66) throw new Error(`dump got ${frames.length} frames`);
  return new Uint8Array(frames.flat());
}

async function setChannelX(conn: Conn, effectId: number): Promise<void> {
  const [lo, hi] = septet14(effectId);
  conn.send(build(0x11, [lo, hi, 0, 0x01]));
  await new Promise(r => setTimeout(r, 200));
}

async function setParamRaw(conn: Conn, effectId: number, paramId: number, wireValue: number): Promise<void> {
  const [effLo, effHi] = septet14(effectId);
  const [pLo, pHi] = septet14(paramId);
  conn.send(build(0x02, [effLo, effHi, pLo, pHi, wireValue & 0x7f, (wireValue >> 7) & 0x7f, (wireValue >> 14) & 0x03, 0x01]));
  await new Promise(r => setTimeout(r, 200));
}

interface BlockSpec {
  /** Canonical alphabetical sort key (from FUN_00595260 cascade strings). */
  name: string;
  /** Slug accepted by apply_preset (KNOWN_PARAMS.block field). */
  slug: string;
  effectId: number;
  /** A writable knob paramId for this block-name. */
  knobParamId: number;
}

/**
 * Placeable effect blocks. Order doesn't matter — they're sorted
 * alphabetically by `name` after measurement. Knob paramIds were
 * extracted from `fractal-midi` params.ts via controlType='knob' filter.
 */
const ALL_BLOCKS: BlockSpec[] = [
  { name: 'Amp',          slug: 'amp',          effectId: 106, knobParamId: 1 },   // input_drive
  { name: 'Cab',          slug: 'cab',          effectId: 108, knobParamId: 9 },   // level
  { name: 'Chorus',       slug: 'chorus',       effectId: 116, knobParamId: 2 },   // rate
  { name: 'Compressor',   slug: 'compressor',   effectId: 100, knobParamId: 1 },   // ratio
  { name: 'Crossover',    slug: 'crossover',    effectId: 148, knobParamId: 0 },   // freq
  { name: 'Delay',        slug: 'delay',        effectId: 112, knobParamId: 2 },   // time
  { name: 'Drive',        slug: 'drive',        effectId: 133, knobParamId: 1 },   // drive
  { name: 'EffectsLoop',  slug: 'effectsloop',  effectId: 136, knobParamId: 0 },   // level_1
  { name: 'Enhancer',     slug: 'enhancer',     effectId: 135, knobParamId: 0 },   // width
  { name: 'Filter',       slug: 'filter',       effectId: 131, knobParamId: 1 },   // frequency
  { name: 'Flanger',      slug: 'flanger',      effectId: 118, knobParamId: 1 },   // rate
  { name: 'Formant',      slug: 'formant',      effectId: 126, knobParamId: 3 },   // resonance
  { name: 'GateExpander', slug: 'gateexpander', effectId: 150, knobParamId: 0 },   // threshold
  { name: 'GraphicEQ',    slug: 'graphiceq',    effectId: 102, knobParamId: 11 },  // level
  { name: 'MegaTap',      slug: 'megatap',      effectId: 147, knobParamId: 0 },   // in_gain
  { name: 'Mixer',        slug: 'mixer',        effectId: 137, knobParamId: 8 },   // master
  { name: 'MultibandComp',slug: 'multibandcomp',effectId: 154, knobParamId: 4 },   // attack_1
  { name: 'MultiDelay',   slug: 'multidelay',   effectId: 114, knobParamId: 0 },   // time_1
  { name: 'ParametricEQ', slug: 'parametriceq', effectId: 104, knobParamId: 0 },   // freq_1
  { name: 'PanTrem',      slug: 'pantrem',      effectId: 128, knobParamId: 2 },   // rate
  { name: 'Phaser',       slug: 'phaser',       effectId: 122, knobParamId: 2 },   // rate
  { name: 'Pitch',        slug: 'pitch',        effectId: 130, knobParamId: 9 },   // voice_1_detune
  { name: 'Resonator',    slug: 'resonator',    effectId: 158, knobParamId: 2 },   // ingain
  { name: 'Reverb',       slug: 'reverb',       effectId: 110, knobParamId: 1 },   // time
  { name: 'RingMod',      slug: 'ringmod',      effectId: 152, knobParamId: 0 },   // frequency
  { name: 'Rotary',       slug: 'rotary',       effectId: 120, knobParamId: 0 },   // rate
  { name: 'Synth',        slug: 'synth',        effectId: 144, knobParamId: 1 },   // frequency_1
  { name: 'Vocoder',      slug: 'vocoder',      effectId: 146, knobParamId: 2 },   // freqstart
  { name: 'VolPan',       slug: 'volpan',       effectId: 127, knobParamId: 0 },   // volume
  { name: 'Wah',          slug: 'wah',          effectId: 124, knobParamId: 1 },   // freq_min
];

/** Batches sized to fit row 2 (II XL+ grid has ~12 cols). */
const BATCH_A: string[] = [
  'Amp', 'Cab', 'Chorus', 'Compressor', 'Crossover', 'Delay',
  'Drive', 'EffectsLoop', 'Enhancer', 'Filter',
];
const BATCH_B: string[] = [
  'Amp', 'Cab', 'Flanger', 'Formant', 'GateExpander', 'GraphicEQ',
  'MegaTap', 'Mixer', 'MultibandComp', 'MultiDelay', 'Reverb',
];
const BATCH_C: string[] = [
  'Amp', 'Cab', 'ParametricEQ', 'PanTrem', 'Phaser', 'Pitch',
  'Resonator', 'Reverb', 'RingMod', 'Rotary',
];
// Batch D — cascade-position 27..33 cluster + EffectsLoop for its width.
const BATCH_D: string[] = [
  'Amp', 'Cab', 'EffectsLoop', 'RingMod', 'Rotary', 'Synth',
  'Vocoder', 'VolPan', 'PanTrem', 'Wah',
];

// Batch E — cross-reference batch to verify ordering across cascade tiers.
// Mixes blocks from positions 3, 12, 21, 27 to surface the sort algorithm.
const BATCH_E: string[] = [
  'Amp', 'Cab', 'Chorus', 'Flanger', 'ParametricEQ', 'RingMod',
  'Compressor', 'GraphicEQ', 'Pitch', 'Reverb',
];

function pickBatch(): BlockSpec[] {
  const tag = (process.env.BATCH ?? 'A').toUpperCase();
  const names: string[] = tag === 'A' ? BATCH_A : tag === 'B' ? BATCH_B : tag === 'C' ? BATCH_C : tag === 'D' ? BATCH_D : tag === 'E' ? BATCH_E : [];
  if (names.length === 0) throw new Error(`Unknown BATCH "${tag}" — pick A/B/C/D/E`);
  return names.map(n => {
    const b = ALL_BLOCKS.find(b => b.name === n);
    if (!b) throw new Error(`Unknown block-name "${n}"`);
    return b;
  });
}

async function main(): Promise<void> {
  const batch = pickBatch();
  const tag = (process.env.BATCH ?? 'A').toUpperCase();
  console.log(`Width sweep ${tag}: ${batch.map(b => b.name).join(', ')}\n`);

  // Step 1: apply the layout. Place each block at (2, idx+1).
  console.log('Step 1: apply_preset with batch layout...');
  const slots = batch.map((b, i) => ({ slot: { row: 2, col: i + 1 }, block_type: b.slug }));
  const applyR = await executeApplyPreset({
    port: 'axe-fx-ii',
    spec: { name: `WidthSweep${tag}`, slots },
    target_location: 666,
    save_authorized: true,
    on_active_preset_edited: 'discard',
  });
  if (applyR.ok === false) {
    throw new Error(`apply_preset failed: ${JSON.stringify(applyR).slice(0, 400)}`);
  }
  console.log(`  placed ${batch.length} blocks at row 2 cols 1..${batch.length}`);
  await new Promise(r => setTimeout(r, 500));

  const conn = connectAxeFxII();

  // Step 2: switch to scene 1.
  await executeSwitchScene({ port: 'axe-fx-ii', scene: 1 });
  await new Promise(r => setTimeout(r, 200));

  // Step 3: force every placed block to channel X.
  console.log('Step 3: force channel X on every placed block...');
  for (const b of batch) await setChannelX(conn, b.effectId);
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 300));

  // Step 4: dump baseline.
  console.log('Step 4: dump baseline...');
  const baseline = await dump(conn);

  // Step 5: send SET_PARAM with unique target wire per block.
  console.log('Step 5: SET_PARAM per block with unique target wires...');
  const targets: { block: BlockSpec; targetWire: number }[] = [];
  for (let i = 0; i < batch.length; i++) {
    const b = batch[i];
    // Spread targets across 0x4000..0x6fff to stay unique and avoid factory-default collision.
    const targetWire = (0x4000 + i * 0x100 + b.knobParamId) & 0x7fff;
    targets.push({ block: b, targetWire });
    await setParamRaw(conn, b.effectId, b.knobParamId, targetWire);
  }
  await executeSavePreset({ port: 'axe-fx-ii', location: 666 });
  await new Promise(r => setTimeout(r, 400));

  // Step 6: dump after.
  console.log('Step 6: dump after...');
  const after = await dump(conn);

  // Step 7: diff baseline vs after.
  console.log('\nStep 7: locate each target wire value in diff...\n');
  const pBaseline = parsePresetDump(baseline);
  const pAfter = parsePresetDump(after);

  interface Found {
    block: BlockSpec;
    chunk: number;
    ushort: number;
    xBaseChunk: number;
    xBaseUshort: number;
    xBaseGlobal: number;
    targetWire: number;
  }
  const found: Found[] = [];
  const missed: BlockSpec[] = [];

  for (const t of targets) {
    let hit: { chunk: number; ushort: number } | undefined;
    for (let c = 0; c < 64; c++) {
      const x = decodeChunk(pBaseline.chunkPayloads[c]);
      const y = decodeChunk(pAfter.chunkPayloads[c]);
      const lim = Math.min(x.length, y.length);
      for (let i = 0; i < lim; i++) {
        if (x[i] !== y[i] && y[i] === t.targetWire) {
          hit = { chunk: c, ushort: i };
          break;
        }
      }
      if (hit) break;
    }
    if (hit) {
      const xBaseGlobal = (hit.chunk * 64 + hit.ushort) - t.block.knobParamId;
      const xBaseChunk = Math.floor(xBaseGlobal / 64);
      const xBaseUshort = xBaseGlobal % 64;
      found.push({
        block: t.block,
        chunk: hit.chunk,
        ushort: hit.ushort,
        xBaseChunk,
        xBaseUshort,
        xBaseGlobal,
        targetWire: t.targetWire,
      });
      console.log(`  ${t.block.name.padEnd(15)} pid ${t.block.knobParamId} = 0x${t.targetWire.toString(16)} → c${hit.chunk}:u${hit.ushort}  X paramBase = c${xBaseChunk}:u${xBaseUshort} (global ${xBaseGlobal})`);
    } else {
      missed.push(t.block);
      console.log(`  ${t.block.name.padEnd(15)} pid ${t.block.knobParamId} = 0x${t.targetWire.toString(16)} → NO DIFF`);
    }
  }

  // Step 8: sort by alphabetical name, compute widths.
  console.log('\n=== WIDTHS (alphabetical-by-name, consecutive global-ushort diffs) ===');
  const sorted = [...found].sort((a, b) => a.block.name.localeCompare(b.block.name, 'en'));
  console.log('Block          | X paramBase | width (ushorts)');
  console.log('---------------|-------------|----------------');
  for (let i = 0; i < sorted.length; i++) {
    const me = sorted[i];
    const next = sorted[i + 1];
    const width = next ? next.xBaseGlobal - me.xBaseGlobal : undefined;
    const base = `c${me.xBaseChunk}:u${me.xBaseUshort}`.padEnd(7);
    const widthStr = width !== undefined ? width.toString() : '(last — no successor)';
    console.log(`  ${me.block.name.padEnd(13)}|  ${base} (${me.xBaseGlobal.toString().padStart(4)}) | ${widthStr}`);
  }
  if (missed.length) {
    console.log('\nMISSED (no diff found):');
    for (const m of missed) console.log(`  ${m.name}`);
  }

  console.log('\nReminder: run restore-test-crunch.ts after the sweep.');
  setTimeout(()=>process.exit(0), 200);
}

main().catch(e => { console.error('FAILED:', e); if (e instanceof Error && e.stack) console.error(e.stack); process.exit(1); });
