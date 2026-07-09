/**
 * AM4 preset-container sweep — capture-gated oracle validation.
 *
 * Mirrors how the gen-3 container was validated (verify-gen3-authoring /
 * verify-gen3-preset-huffman): run the shipped decoder
 * (`fractal-midi/am4` presetContainer.ts) over the real corpus and assert
 * the device's own self-validating fields:
 *
 *   1. FACTORY BANK (fw 1.01, 104 presets,
 *      samples/factory/AM4-Factory-Presets-1p01.syx): every preset's
 *      raw_patch CRC-16/CCITT validates, the 0x79 footer XOR matches, the
 *      Huffman stream terminates at exactly decompSize, word[1] == 0xAA55,
 *      fw word == 0x0107, and known plaintext (preset 0 name "AM4 Gig Rig"
 *      + its four scene names) decodes.
 *   2. EXTRA EXPORTS (fw 2.00 hardware captures where present):
 *      samples/factory/A01-original.syx, samples/captured/hw132/*.
 *   3. WARM PAIRS (samples/captured/am4-warm-pair-*-{before,after}.syx):
 *      all decode valid; the NO-OP redump pair's decoded-body diff is
 *      confined to the one documented volatile u16 @0x140E; the
 *      amp.gain-chA pair shows the oracle value 0x828E land at 0x0958.
 *
 * CLEAN SKIP when samples/ is absent (community clones): exits 0 with a
 * SKIP message. samples/ is gitignored; the corpus lives on the founder's
 * machine.
 *
 * Run: npx tsx scripts/verify-am4-preset-container.ts
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeAm4RawPatch,
  AM4_RAW_PATCH_SIZE,
  AM4_FW_WORD_1P01,
  AM4_FW_WORD_2P00,
  AM4_BODY_VOLATILE_WORD_OFFSET,
  AM4_BODY_AMP_GAIN_CHA_OFFSET,
  type Am4DecodedPreset,
} from '../packages/fractal-midi/src/am4/presetContainer.js';
import {
  locateAm4AmpBlock,
  decodeAm4AmpBlock,
} from '../packages/fractal-midi/src/am4/bodyChain.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import type { DispatchCtx, PresetSnapshot } from '@mcp-midi-control/core/protocol-generic/types.js';

const HEADER_LEN = 13;
const CHUNK_LEN = 3082;
const FOOTER_LEN = 11;
const AM4_MODEL = 0x15;
const F0 = 0xf0;

/**
 * Split one 12,352-byte AM4 preset dump into its 6 wire frames
 * (0x77 header + 4× 0x78 chunk + 0x79 footer), the shape the device emits.
 */
function framesFor(dump: Uint8Array): number[][] {
  const frames: number[][] = [];
  let cursor = 0;
  frames.push(Array.from(dump.subarray(cursor, cursor + HEADER_LEN)));
  cursor += HEADER_LEN;
  for (let i = 0; i < 4; i++) {
    frames.push(Array.from(dump.subarray(cursor, cursor + CHUNK_LEN)));
    cursor += CHUNK_LEN;
  }
  frames.push(Array.from(dump.subarray(cursor, cursor + FOOTER_LEN)));
  return frames;
}

/**
 * A fake AM4 connection that answers the fn 0x03 stored-dump request with the
 * supplied 6-frame stream (and nothing else). Exercises the reader's
 * reassembly + container decode end-to-end without hardware.
 */
function makeStoredDumpConn(dump: Uint8Array): MidiConnection {
  const handlers = new Set<(bytes: number[]) => void>();
  const frames = framesFor(dump);
  return {
    send: (bytes) => {
      // fn 0x03 = REQUEST_DUMP; emit the dump stream on the next tick.
      if (bytes[0] !== F0 || bytes[4] !== AM4_MODEL || bytes[5] !== 0x03) return;
      setImmediate(() => {
        for (const f of frames) for (const h of [...handlers]) { try { h(f); } catch { /* swallow */ } }
      });
    },
    receiveSysEx: () => Promise.reject(new Error('receiveSysEx not used')),
    receiveSysExMatching: () => Promise.reject(new Error('receiveSysExMatching not used')),
    onMessage: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    hasInput: true,
    close: () => { handlers.clear(); },
  } as MidiConnection;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SAMPLES = path.join(ROOT, 'samples');

const FACTORY_BANK = path.join(SAMPLES, 'factory', 'AM4-Factory-Presets-1p01.syx');
const EXTRA_DUMPS: Array<{ file: string; fwWord: number }> = [
  { file: path.join(SAMPLES, 'factory', 'A01-original.syx'), fwWord: AM4_FW_WORD_2P00 },
  { file: path.join(SAMPLES, 'captured', 'hw132', 'am4-stored-a01.syx'), fwWord: AM4_FW_WORD_1P01 },
  { file: path.join(SAMPLES, 'captured', 'hw132', 'am4-active-1.syx'), fwWord: AM4_FW_WORD_2P00 },
];
const WARM_PAIR_TAGS = [
  '1-baseline-redump',
  '2-amp-gain-channel-A',
  '3-amp-gain-channel-B',
  '4-amp-master',
  '5-amp-type-swap',
];
const warmPairPath = (tag: string, side: 'before' | 'after'): string =>
  path.join(SAMPLES, 'captured', `am4-warm-pair-${tag}-${side}.syx`);

let checks = 0;
let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  checks += 1;
  if (cond) return;
  failures += 1;
  console.error(`FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

function assertContainerValid(label: string, d: Am4DecodedPreset): void {
  check(`${label}: raw_patch is ${AM4_RAW_PATCH_SIZE} B`, d.rawPatch.length === AM4_RAW_PATCH_SIZE);
  check(`${label}: magic word[1] == 0xAA55`, d.magicValid);
  check(
    `${label}: CRC valid`,
    d.crcValid,
    `stored 0x${d.storedCrc.toString(16)} computed 0x${d.computedCrc.toString(16)}`,
  );
  check(
    `${label}: footer XOR matches`,
    d.footerXorValid,
    `stored 0x${d.storedFooterXor.toString(16)} computed 0x${d.computedFooterXor.toString(16)}`,
  );
  check(
    `${label}: Huffman terminates at decompSize`,
    d.huffmanComplete,
    `got ${d.decompressedBody.length}/${d.decompSize} bytes`,
  );
}

function diffOffsets(a: Uint8Array, b: Uint8Array): number[] {
  const n = Math.max(a.length, b.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if ((a[i] ?? -1) !== (b[i] ?? -2)) out.push(i);
  return out;
}

if (!existsSync(FACTORY_BANK)) {
  console.log(
    `SKIP verify-am4-preset-container: corpus not present (${FACTORY_BANK} missing). ` +
      `samples/ is local-only; nothing to verify on this machine.`,
  );
  process.exit(0);
}

// ── 1. Factory bank sweep ────────────────────────────────────────────

const bank = new Uint8Array(readFileSync(FACTORY_BANK));
let cursor = 0;
let bankCount = 0;
const names: string[] = [];
let firstScenes: readonly string[] = [];
// Body block-chain walker: bucket the located amp-marker base per preset so we
// can assert the config-dependent base distribution (0x0934 / 0x0A92 / absent).
const ampBaseBuckets: Record<string, number> = {};
while (cursor < bank.length) {
  const d = decodeAm4RawPatch(bank, cursor);
  assertContainerValid(`factory[${bankCount}]`, d);
  check(`factory[${bankCount}]: fw word == 0x0107 (fw 1.01)`, d.fwWord === AM4_FW_WORD_1P01,
    `got 0x${d.fwWord.toString(16)}`);
  names.push(d.name);
  if (bankCount === 0) firstScenes = d.sceneNames;
  const ampBase = locateAm4AmpBlock(d.decompressedBody, d.decompSize);
  const key = ampBase === undefined ? 'absent' : `0x${ampBase.toString(16)}`;
  ampBaseBuckets[key] = (ampBaseBuckets[key] ?? 0) + 1;
  // Presets with an amp: the block MUST decode + carry all four channels.
  if (ampBase !== undefined) {
    const amp = decodeAm4AmpBlock(d.decompressedBody, d.decompSize);
    check(`factory[${bankCount}]: amp block decodes when marker present`,
      amp !== undefined && amp.base === ampBase);
    check(`factory[${bankCount}]: amp block has 4 channels A/B/C/D`,
      amp !== undefined && ['A', 'B', 'C', 'D'].every((c) => c in amp.channels));
  }
  cursor += d.byteLength;
  bankCount += 1;
}
check('factory bank: 104 presets decoded', bankCount === 104, `got ${bankCount}`);
// Walker resolves each preset to exactly one config-dependent base, no false
// positives: 70 @0x0934 + 17 @0x0A92 + 17 absent (16 empty + 'Bass NoAmp DI').
check(
  'body-chain walker: amp-base distribution 70/17/17',
  ampBaseBuckets['0x934'] === 70 && ampBaseBuckets['0xa92'] === 17 && ampBaseBuckets['absent'] === 17,
  `got ${JSON.stringify(ampBaseBuckets)}`,
);
check('factory[0] name == "AM4 Gig Rig"', names[0] === 'AM4 Gig Rig', `got "${names[0]}"`);
check('factory[1] name == "59 Bassguy"', names[1] === '59 Bassguy', `got "${names[1]}"`);
check(
  'factory[0] scene names decode',
  firstScenes.join('|') === 'Clean Double|Pushed AC|Jumped Plexi|IIC+ Hot Lead',
  `got ${JSON.stringify(firstScenes)}`,
);

// ── 2. Extra hardware exports (present-file-gated per file) ──────────

let extraCount = 0;
for (const { file, fwWord } of EXTRA_DUMPS) {
  if (!existsSync(file)) {
    console.log(`  (skip: ${path.relative(ROOT, file)} not present)`);
    continue;
  }
  const label = path.basename(file);
  const d = decodeAm4RawPatch(new Uint8Array(readFileSync(file)));
  assertContainerValid(label, d);
  check(`${label}: fw word == 0x${fwWord.toString(16)}`, d.fwWord === fwWord,
    `got 0x${d.fwWord.toString(16)}`);
  extraCount += 1;
}

// ── 3. Warm pairs: decoded-layer diff discipline ─────────────────────

let pairCount = 0;
for (const tag of WARM_PAIR_TAGS) {
  const beforePath = warmPairPath(tag, 'before');
  const afterPath = warmPairPath(tag, 'after');
  if (!existsSync(beforePath) || !existsSync(afterPath)) {
    console.log(`  (skip: warm pair ${tag} not present)`);
    continue;
  }
  const before = decodeAm4RawPatch(new Uint8Array(readFileSync(beforePath)));
  const after = decodeAm4RawPatch(new Uint8Array(readFileSync(afterPath)));
  assertContainerValid(`warm-pair ${tag} before`, before);
  assertContainerValid(`warm-pair ${tag} after`, after);
  pairCount += 1;

  if (tag === '1-baseline-redump') {
    // The no-op pair: at the DECODED layer the only difference is the one
    // volatile u16 @0x140E (the compressed layer differs by thousands of
    // bytes — that was the old "non-determinism").
    const diffs = diffOffsets(before.decompressedBody, after.decompressedBody);
    const allowed = new Set([AM4_BODY_VOLATILE_WORD_OFFSET, AM4_BODY_VOLATILE_WORD_OFFSET + 1]);
    check(
      'no-op redump: decoded-body diff confined to the volatile u16 @0x140E',
      diffs.every((o) => allowed.has(o)),
      `diff offsets: ${diffs.slice(0, 8).map((o) => '0x' + o.toString(16)).join(' ')}${diffs.length > 8 ? ' …' : ''}`,
    );
  }
  if (tag === '2-amp-gain-channel-A') {
    // Oracle: amp.gain chA 5.0 → 5.1 lands 0x828E = round(5.1/10×65534) @0x0958.
    const v = (after.decompressedBody[AM4_BODY_AMP_GAIN_CHA_OFFSET] |
      (after.decompressedBody[AM4_BODY_AMP_GAIN_CHA_OFFSET + 1] << 8)) & 0xffff;
    check('amp.gain chA pair: 0x828E at body 0x0958 after the 5.1 edit', v === 0x828e,
      `got 0x${v.toString(16)}`);
    // Walker + decode: the amp block resolves to base 0x0934 and gain chA = 5.1.
    const amp = decodeAm4AmpBlock(after.decompressedBody, after.decompSize);
    check('amp.gain chA pair: walker locates amp @0x0934', amp?.base === 0x0934,
      `got base ${amp?.base === undefined ? 'undefined' : '0x' + amp.base.toString(16)}`);
    check('amp.gain chA pair: decoded amp.channels.A.gain == 5.1', amp?.channels.A?.gain === 5.1,
      `got ${amp?.channels.A?.gain}`);
  }
  if (tag === '3-amp-gain-channel-B') {
    // Anchor: amp.gain chB @0x0A88 (base 0x0934 + ch1*0x130 + 0x24) → 5.1.
    const amp = decodeAm4AmpBlock(after.decompressedBody, after.decompSize);
    check('amp.gain chB pair: decoded amp.channels.B.gain == 5.1', amp?.channels.B?.gain === 5.1,
      `got ${amp?.channels.B?.gain}`);
  }
  if (tag === '4-amp-master') {
    // Anchor: amp.master chA @0x0960 (base 0x0934 + 0x2C) → 5.1.
    const amp = decodeAm4AmpBlock(after.decompressedBody, after.decompSize);
    check('amp.master pair: decoded amp.channels.A.master == 5.1', amp?.channels.A?.master === 5.1,
      `got ${amp?.channels.A?.master}`);
  }
}

// ── 3b. Absent-amp preset yields no amp block ────────────────────────
// 'Bass NoAmp DI' (factory index 11) is an intentional no-amp DI patch; its
// body carries no valid amp record, so the walker must return undefined
// (not a false-positive marker). The 16 empty tail presets are covered by the
// distribution check above.
{
  const NO_AMP_INDEX = 11;
  let c = 0;
  for (let i = 0; i < NO_AMP_INDEX; i++) c += decodeAm4RawPatch(bank, c).byteLength;
  const noAmp = decodeAm4RawPatch(bank, c);
  check(`factory[${NO_AMP_INDEX}] is the 'Bass NoAmp DI' patch`, /NoAmp/i.test(noAmp.name), `got "${noAmp.name}"`);
  check(
    `factory[${NO_AMP_INDEX}] 'Bass NoAmp DI': walker returns no amp block`,
    locateAm4AmpBlock(noAmp.decompressedBody, noAmp.decompSize) === undefined &&
      decodeAm4AmpBlock(noAmp.decompressedBody, noAmp.decompSize) === undefined,
  );
}

// ── 4. Reader drive: get_preset(location) over a mock connection ─────
//
// End-to-end exercise of the SHIPPED AM4 reader stored path: the mock conn
// answers the fn 0x03 request with the first factory preset's 6-frame dump,
// and we assert the reader reassembles + container-decodes it into the
// stored snapshot shape (name + whole_preset.source/crc_valid/scene_names).

const PRESET_DUMP_LEN = HEADER_LEN + CHUNK_LEN * 4 + FOOTER_LEN; // 12,352
const reader = AM4_DESCRIPTOR.reader;
check('reader implements getPreset', typeof reader.getPreset === 'function');
if (reader.getPreset !== undefined && bank.length >= PRESET_DUMP_LEN) {
  const firstDump = bank.subarray(0, PRESET_DUMP_LEN);
  const ctx: DispatchCtx = { conn: makeStoredDumpConn(firstDump), descriptor: AM4_DESCRIPTOR };
  let snap: PresetSnapshot | undefined;
  try {
    snap = await reader.getPreset(ctx, { location: 'A01' });
  } catch (err) {
    check('get_preset(A01) resolves via mock stored dump', false, err instanceof Error ? err.message : String(err));
  }
  if (snap !== undefined) {
    check('get_preset(A01) resolves via mock stored dump', true);
    check('get_preset(A01): name == "AM4 Gig Rig"', snap.name === 'AM4 Gig Rig', `got "${snap.name}"`);
    check('get_preset(A01): whole_preset.source == "stored-dump"', snap.whole_preset?.source === 'stored-dump', `got ${snap.whole_preset?.source}`);
    check('get_preset(A01): whole_preset.crc_valid', snap.whole_preset?.crc_valid === true, `got ${snap.whole_preset?.crc_valid}`);
    check(
      'get_preset(A01): scene names decode',
      (snap.whole_preset?.scene_names ?? []).join('|') === 'Clean Double|Pushed AC|Jumped Plexi|IIC+ Hot Lead',
      `got ${JSON.stringify(snap.whole_preset?.scene_names)}`,
    );
    check('get_preset(A01): slots empty (slot-assignment field map pending)', snap.slots.length === 0, `got ${snap.slots.length} slots`);
    check(
      'get_preset(A01): read_warnings label amp VALUES surfaced + community-beta status',
      (snap.read_warnings ?? []).some((w) => /AMP param VALUES are surfaced/i.test(w)) &&
        (snap.read_warnings ?? []).some((w) => /community-beta/i.test(w)),
      `warnings=${JSON.stringify(snap.read_warnings)}`,
    );
    // The first factory preset ("AM4 Gig Rig") has an amp — its per-channel
    // VALUES must ride on whole_preset.amp (all 4 channels, with amp.type).
    const amp = snap.whole_preset?.amp as Record<string, Record<string, number | string>> | undefined;
    check('get_preset(A01): whole_preset.amp present', amp !== undefined);
    check('get_preset(A01): whole_preset.amp has channels A/B/C/D',
      amp !== undefined && ['A', 'B', 'C', 'D'].every((ch) => ch in amp),
      `got ${JSON.stringify(amp === undefined ? undefined : Object.keys(amp))}`);
    check('get_preset(A01): whole_preset.amp.A carries a type + gain',
      amp?.A?.type !== undefined && typeof amp?.A?.gain === 'number',
      `A=${JSON.stringify(amp?.A && { type: amp.A.type, gain: amp.A.gain })}`);
  }
}

const total = bankCount + extraCount + pairCount * 2;
if (failures > 0) {
  console.error(`\nverify-am4-preset-container: ${failures}/${checks} checks FAILED (${total} dumps).`);
  process.exit(1);
}
console.log(
  `\nverify-am4-preset-container: all ${checks} checks passed over ${total} dumps ` +
    `(${bankCount} factory + ${extraCount} exports + ${pairCount * 2} warm-pair captures).`,
);
