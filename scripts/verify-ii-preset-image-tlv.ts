/**
 * Axe-Fx II preset-image TLV goldens + corpus sweep.
 *
 * Section 1 (always runs, pure CPU): synthetic-image round-trip through
 * `deframePresetImage` + `parsePresetImage` (name + modifier + 2 blocks
 * alphabetical + system tail + terminator), the BK-070 anchor
 * arithmetic vectors, and the strict-walker throw cases.
 *
 * Section 2 (capture-gated, skipped when fixtures are absent): sweeps
 * the Q8.02 XL+ factory banks (`samples/factory/`, 384 presets) plus
 * the local bk070 / hw132 hardware dumps (`samples/captured/`) and
 * asserts the corpus invariants the 2026-07-02 decode was confirmed
 * against:
 *
 *   - every chain walks clean (strict parse, no throw)
 *   - effect blocks are alphabetical by canonical AxeEdit DISPLAY name
 *     (spaces/punctuation ignored: "Tremolo/Panner" sorts under T, and
 *     "Multiband Compressor" precedes "Multi Delay"), followed by a
 *     system tail that is an ordered subsequence of [170 Tone Match,
 *     139 Noisegate, 140 Output, 142 Feedback Send, 143 Feedback
 *     Return, 141 Controllers] with 139/140/141 always present
 *   - modifier records (wire_id 1..20) are len-15 and precede the
 *     first block TLV
 *   - the TLV-decoded name matches the triplet-decoded name from
 *     `extractPresetName`
 *   - amp-type ordinal (word[baseWord] of every Amp TLV) is within the
 *     shipped 266-name roster
 *   - nonzero words after the chain terminator occur only at the
 *     tone-match bulk region (word 2048+) and only when block 170 is
 *     in the chain
 *   - the two BK-070 one-variable diff pairs
 *     (`bk070-loop-amp-bass-2-*`, `bk070-loop-amp-master-vol-3-*`)
 *     differ at EXACTLY the predicted channel-Y param words
 *
 * Section 3 (2026-07-10, "drive Y effect_type leaked 32767" investigation):
 * a `get_preset include_channel_state:true` live read surfaced a raw wire
 * int (`32767`) for a drive block's Y-channel `effect_type` instead of a
 * label, moments after the front panel + a fresh capture confirmed the
 * device actually held BLACKGLASS 7K (ordinal 36) on that channel. Two
 * checks:
 *
 *   - Golden (skip-if-absent, founder's private fixture path): decode
 *     `Fractal_Axe-Fx_II_XL-8-String_Bass-...syx` and assert the drive
 *     block's Y-channel `effect_type` word decodes to "BLACKGLASS 7K",
 *     pinning the byte-exact word offset (baseWord + xToYOffset + paramId 0)
 *     against the hardware-confirmed ground truth so a future regression
 *     in the offset arithmetic or the DRIVE_EFFECT_TYPE_VALUES roster
 *     re-trips this test.
 *   - Synthetic: `decodeGroupValues` on a fabricated select-type wire
 *     value with NO roster entry must emit `"UNKNOWN TYPE (ordinal N)"`,
 *     never the bare wire integer (the display-first hardening this
 *     investigation shipped in `calibration.ts`'s `decodeEnumWire`).
 *
 * Root-cause note: decoding the ground-truth fixture with this repo's own
 * TLV walker shows the offset math and the roster entry are BOTH already
 * correct for that preset (word 865 = 36 = BLACKGLASS 7K); see
 * STATE-AXEFX2.md 2026-07-10 for the full writeup of what was and wasn't
 * reproducible. The synthetic case guards the general bug class (any
 * select-type param whose wire ordinal has no roster row) regardless of
 * that specific preset's root cause.
 *
 * Fixtures are git-ignored Fractal IP; missing ones are skipped with a
 * notice so `npm test` stays green on a fresh clone.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  parsePresetDump,
  parsePresetBank,
  extractPresetName,
  type ParsedPresetDump,
} from '@mcp-midi-control/fractal-gen2/presetDump.js';
import {
  PRESET_IMAGE_WORDS,
  PRESET_IMAGE_FORMAT_TAG,
  TLV_CHAIN_START,
  TONE_MATCH_BULK_START,
  SYSTEM_TAIL_WIRE_IDS,
  MODIFIER_PAYLOAD_LEN,
  deframePresetImage,
  parsePresetImage,
  paramWordIndex,
  getParamWord,
  type AxeFxIIPresetImage,
  type PresetImageBlock,
} from '@mcp-midi-control/fractal-gen2/presetImageTlv.js';
import { AMP_EFFECT_TYPE_VALUES, BLOCK_BY_ID } from 'fractal-midi/gen2/axe-fx-ii';
import { decodeGroupValues } from '@mcp-midi-control/fractal-gen2/descriptor/paramGroupIndex.js';

// ── BK-070 hardware anchors (Test Crunch, live Q8.02 hardware) ──────
// samples/captured/bk070-loop-amp-bass-2-baseline.syx: Amp TLV
// [106, 236] at word 130 → baseWord 132, xToYOffset 118.
// One-variable hardware diffs landed at exactly these words.
const ANCHOR_AMP_TLV_WORD = 130;
const ANCHOR_AMP_PAYLOAD_LEN = 236; // live hw; factory banks carry 234 (firmware drift)
const ANCHOR_AMP_BASE_WORD = 132;
const ANCHOR_AMP_X_TO_Y = 118;
const ANCHOR_AMP_BASS_PARAM_ID = 2; // amp.bass
const ANCHOR_AMP_BASS_Y_WORD = 252; // 132 + 118 + 2
const ANCHOR_AMP_MASTER_PARAM_ID = 5; // amp.master_volume
const ANCHOR_AMP_MASTER_Y_WORD = 255; // 132 + 118 + 5
const AMP_WIRE_ID = 106;

/** Highest valid amp-type ordinal in the shipped Q8.02 roster. */
const AMP_TYPE_ORDINAL_MAX = Math.max(
  ...Object.keys(AMP_EFFECT_TYPE_VALUES).map(Number),
);

let pass = 0;
let fail = 0;
let skipped = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok    ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
    fail++;
  }
}

function expectThrow(label: string, fn: () => void, msgFragment: string): void {
  try {
    fn();
    check(label, false, 'did not throw');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(label, msg.includes(msgFragment), `threw but message lacks "${msgFragment}": ${msg}`);
  }
}

// ═════════════════════════════════════════════════════════════════════
// Section 1 — synthetic goldens
// ═════════════════════════════════════════════════════════════════════

console.log('Section 1: synthetic-image goldens');

function buildSyntheticImage(): Uint16Array {
  const w = new Uint16Array(PRESET_IMAGE_WORDS);
  w[0] = PRESET_IMAGE_FORMAT_TAG;
  const name = 'TLV GOLD';
  for (let i = 0; i < name.length; i++) w[2 + i] = name.charCodeAt(i);
  // Record table (grid order, deliberately NOT the chain order; one
  // >=200 placeholder that must not appear in the chain).
  w[36] = 108; w[37] = 0x2; // Cab first in grid
  w[44] = 106; w[45] = 0x2; // Amp second in grid
  w[52] = 201; w[53] = 0x0; // shunt/unplaced placeholder
  // Chain: modifier slot 3, Amp [106,236], Cab [108,78], tail, terminator.
  let i = TLV_CHAIN_START;
  w[i] = 3; w[i + 1] = MODIFIER_PAYLOAD_LEN;
  w[i + 2] = 4242; // recognizable first payload word
  i += 2 + MODIFIER_PAYLOAD_LEN; // 147
  w[i] = 106; w[i + 1] = 236;
  w[i + 2 + 0] = 42; // amp X type ordinal
  w[i + 2 + 118 + ANCHOR_AMP_BASS_PARAM_ID] = 16384; // Y bass
  w[i + 2 + 118 + ANCHOR_AMP_MASTER_PARAM_ID] = 19660; // Y master
  i += 2 + 236;
  w[i] = 108; w[i + 1] = 78;
  w[i + 2 + 0] = 31; // cab X type
  w[i + 2 + 39] = 7; // cab Y type
  i += 2 + 78;
  w[i] = 139; w[i + 1] = 8; i += 2 + 8;
  w[i] = 140; w[i + 1] = 20; i += 2 + 20;
  w[i] = 141; w[i + 1] = 96; i += 2 + 96;
  // w[i] = 0 terminator (already zero)
  return w;
}

const SYNTH_TERMINATOR =
  TLV_CHAIN_START + (2 + 15) + (2 + 236) + (2 + 78) + (2 + 8) + (2 + 20) + (2 + 96);

{
  const words = buildSyntheticImage();
  const img = parsePresetImage(words);
  check('synthetic: format tag', img.formatTag === PRESET_IMAGE_FORMAT_TAG);
  check('synthetic: name', img.name === 'TLV GOLD', `got "${img.name}"`);
  check(
    'synthetic: record table raw (grid order + placeholder)',
    img.recordTable[0].wireId === 108 &&
      img.recordTable[1].wireId === 106 &&
      img.recordTable[2].wireId === 201 &&
      img.recordTable[0].flag === 0x2,
  );
  check(
    'synthetic: 1 modifier, slot 3, len 15, payload[0]=4242',
    img.modifiers.length === 1 &&
      img.modifiers[0].slotId === 3 &&
      img.modifiers[0].payloadLen === 15 &&
      img.modifiers[0].payload[0] === 4242,
  );
  check(
    'synthetic: 2 effect blocks, alphabetical Amp then Cab',
    img.blocks.length === 2 &&
      img.blocks[0].blockName === 'Amp' &&
      img.blocks[1].blockName === 'Cab',
  );
  check(
    'synthetic: Amp TLV geometry (tlvWord 147, baseWord 149, len 236, xToY 118)',
    img.blocks[0].tlvWord === 147 &&
      img.blocks[0].baseWord === 149 &&
      img.blocks[0].payloadLen === 236 &&
      img.blocks[0].xToYOffset === 118,
    JSON.stringify(img.blocks[0]),
  );
  check(
    'synthetic: system tail 139,140,141',
    img.systemTail.map((b) => b.wireId).join(',') === SYSTEM_TAIL_WIRE_IDS.join(','),
  );
  check(
    'synthetic: terminator word',
    img.terminatorWord === SYNTH_TERMINATOR,
    `got ${img.terminatorWord}, expected ${SYNTH_TERMINATOR}`,
  );
  check('synthetic: toneMatchPresent false', img.toneMatchPresent === false);
  check(
    'synthetic: getParamWord amp X type',
    getParamWord(img, 106, 0, 'X').value === 42,
  );
  check(
    'synthetic: getParamWord amp Y bass',
    getParamWord(img, 106, ANCHOR_AMP_BASS_PARAM_ID, 'Y').value === 16384,
  );
  check(
    'synthetic: getParamWord cab Y type',
    getParamWord(img, 108, 0, 'Y').value === 7,
  );

  // Round-trip through the de-framer: encode the words as 64 synthetic
  // chunk payloads, de-frame, compare.
  const chunkPayloads: Uint8Array[] = [];
  for (let c = 0; c < 64; c++) {
    const p = new Uint8Array(194);
    p[0] = 0x40; p[1] = 0x00; // count 64
    for (let k = 0; k < 64; k++) {
      const v = words[c * 64 + k];
      const o = 2 + k * 3;
      p[o] = v & 0x7f;
      p[o + 1] = (v >> 7) & 0x7f;
      p[o + 2] = (v >> 14) & 0x03;
    }
    chunkPayloads.push(p);
  }
  const fakeParsed = { chunkPayloads } as unknown as ParsedPresetDump;
  const round = deframePresetImage(fakeParsed);
  let identical = round.length === words.length;
  for (let k = 0; identical && k < words.length; k++) identical = round[k] === words[k];
  check('synthetic: deframe round-trip word-identical', identical);
}

// BK-070 anchor arithmetic vectors (spec constants, hardware-cited).
{
  const anchorBlock: PresetImageBlock = {
    wireId: AMP_WIRE_ID,
    blockName: 'Amp',
    tlvWord: ANCHOR_AMP_TLV_WORD,
    baseWord: ANCHOR_AMP_BASE_WORD,
    payloadLen: ANCHOR_AMP_PAYLOAD_LEN,
    xToYOffset: ANCHOR_AMP_X_TO_Y,
  };
  check(
    'anchor: xToYOffset = payloadLen/2 = 118',
    ANCHOR_AMP_PAYLOAD_LEN / 2 === ANCHOR_AMP_X_TO_Y,
  );
  check(
    'anchor: amp.bass channel-Y → word 252',
    paramWordIndex(anchorBlock, ANCHOR_AMP_BASS_PARAM_ID, 'Y') === ANCHOR_AMP_BASS_Y_WORD,
  );
  check(
    'anchor: amp.master_volume channel-Y → word 255',
    paramWordIndex(anchorBlock, ANCHOR_AMP_MASTER_PARAM_ID, 'Y') === ANCHOR_AMP_MASTER_Y_WORD,
  );
  check(
    'anchor: amp.effect_type channel-X → baseWord 132',
    paramWordIndex(anchorBlock, 0, 'X') === ANCHOR_AMP_BASE_WORD,
  );
  expectThrow(
    'anchor: paramId beyond channel half throws',
    () => paramWordIndex(anchorBlock, ANCHOR_AMP_X_TO_Y, 'X'),
    'out of range',
  );
  expectThrow(
    'anchor: channel-Y on odd payload throws',
    () =>
      paramWordIndex(
        { wireId: 127, blockName: 'VolPan', tlvWord: 130, baseWord: 132, payloadLen: 9, xToYOffset: undefined },
        0,
        'Y',
      ),
    'odd payload',
  );
}

// Strict-walker throw cases.
{
  expectThrow(
    'strict: wrong image size throws',
    () => parsePresetImage(new Uint16Array(4095)),
    'expected 4096 words',
  );
  const badTag = buildSyntheticImage();
  badTag[0] = 2050;
  expectThrow('strict: unknown format tag throws', () => parsePresetImage(badTag), 'format tag');
  const overrun = buildSyntheticImage();
  overrun[TLV_CHAIN_START + 1] = 60000; // modifier len runs past the image
  expectThrow('strict: TLV overrun throws', () => parsePresetImage(overrun), 'runs past');
  const unterminated = new Uint16Array(PRESET_IMAGE_WORDS);
  unterminated[0] = PRESET_IMAGE_FORMAT_TAG;
  for (let i = TLV_CHAIN_START; i < PRESET_IMAGE_WORDS; i += 2) {
    unterminated[i] = 1; // wire_id 1, len 0, forever
  }
  expectThrow(
    'strict: non-terminated chain throws',
    () => parsePresetImage(unterminated),
    'terminator',
  );
}

// ═════════════════════════════════════════════════════════════════════
// Section 2 — capture-gated corpus sweep
// ═════════════════════════════════════════════════════════════════════

console.log('\nSection 2: corpus sweep (capture-gated)');

const BANK_PATHS = [
  'samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx',
  'samples/factory/Axe-Fx-II_XL+_Bank-B_Q8p02.syx',
  'samples/factory/Axe-Fx-II_XL+_Bank-C_Q8p02.syx',
];
const LOCAL_DUMPS = [
  'samples/captured/bk070-loop-amp-bass-2-baseline.syx',
  'samples/captured/hw132/sentinel-eb-alpha.syx',
  'samples/captured/hw132/sentinel-eb-bravo.syx',
  'samples/captured/hw132/stored-slot-7.syx',
];

interface CorpusEntry {
  label: string;
  parsed: ParsedPresetDump;
}

const corpus: CorpusEntry[] = [];
for (const path of BANK_PATHS) {
  if (!existsSync(path)) {
    console.log(`  skip  ${path} (not present)`);
    skipped++;
    continue;
  }
  const dumps = parsePresetBank(new Uint8Array(readFileSync(path)));
  const bank = path.includes('Bank-A') ? 'A' : path.includes('Bank-B') ? 'B' : 'C';
  dumps.forEach((d, i) => corpus.push({ label: `${bank}${String(i).padStart(3, '0')}`, parsed: d }));
}
for (const path of LOCAL_DUMPS) {
  if (!existsSync(path)) {
    console.log(`  skip  ${path} (not present)`);
    skipped++;
    continue;
  }
  corpus.push({ label: path, parsed: parsePresetDump(new Uint8Array(readFileSync(path))) });
}

if (corpus.length > 0) {
  let walked = 0;
  const walkFails: string[] = [];
  let alphaOK = 0;
  const alphaViol: string[] = [];
  let tailOK = 0;
  const tailViol: string[] = [];
  let modOK = 0;
  const modViol: string[] = [];
  let nameOK = 0;
  const nameViol: string[] = [];
  let ampBearing = 0;
  let ampOrdinalOK = 0;
  const ampViol: string[] = [];
  let tailZeroOK = 0;
  const tailZeroViol: string[] = [];
  let toneMatchCount = 0;

  const images = new Map<string, AxeFxIIPresetImage>();

  for (const { label, parsed } of corpus) {
    let img: AxeFxIIPresetImage;
    try {
      img = parsePresetImage(deframePresetImage(parsed));
    } catch (err) {
      walkFails.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    walked++;
    images.set(label, img);

    // Ordering invariant: alphabetical effect region (AxeEdit DISPLAY
    // name, lowercased, spaces/punctuation stripped — the corpus-exact
    // comparator; equal keys = multi-instance adjacency, allowed),
    // then a tail that is an ordered subsequence of TAIL_SEQUENCE.
    const chainIds = [...img.blocks, ...img.systemTail]
      .sort((a, b) => a.tlvWord - b.tlvWord)
      .map((b) => b.wireId);
    const TAIL_SEQUENCE = [170, 139, 140, 142, 143, 141];
    const tailSet = new Set(TAIL_SEQUENCE);
    let cut = chainIds.length;
    while (cut > 0 && tailSet.has(chainIds[cut - 1])) cut--;
    const alphaIds = chainIds.slice(0, cut);
    const tailIds = chainIds.slice(cut);
    const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const keys = alphaIds.map((id) => (BLOCK_BY_ID[id] ? squash(BLOCK_BY_ID[id].name) : `??${id}`));
    let sorted = !alphaIds.some((id) => tailSet.has(id));
    for (let k = 1; k < keys.length; k++) {
      if (keys[k] < keys[k - 1]) sorted = false;
    }
    if (sorted) alphaOK++;
    else if (alphaViol.length < 5) alphaViol.push(`${label}: ${keys.join(',')}`);

    let ti = 0;
    let tailGood = true;
    for (const id of tailIds) {
      while (ti < TAIL_SEQUENCE.length && TAIL_SEQUENCE[ti] !== id) ti++;
      if (ti >= TAIL_SEQUENCE.length) { tailGood = false; break; }
      ti++;
    }
    for (const req of SYSTEM_TAIL_WIRE_IDS) if (!tailIds.includes(req)) tailGood = false;
    if (img.systemTail.map((b) => b.wireId).join(',') !== SYSTEM_TAIL_WIRE_IDS.join(',')) tailGood = false;
    if (tailGood) tailOK++;
    else if (tailViol.length < 5) tailViol.push(`${label}: [${tailIds.join(',')}]`);

    const firstBlockWord = Math.min(
      ...[...img.blocks, ...img.systemTail].map((b) => b.tlvWord),
    );
    const modsClean = img.modifiers.every(
      (m) => m.payloadLen === MODIFIER_PAYLOAD_LEN && m.slotId >= 1 && m.slotId <= 20 && m.tlvWord < firstBlockWord,
    );
    if (modsClean) modOK++;
    else if (modViol.length < 5) modViol.push(`${label}: ${JSON.stringify(img.modifiers.map((m) => [m.slotId, m.payloadLen, m.tlvWord]))}`);

    if (img.name === extractPresetName(parsed)) nameOK++;
    else if (nameViol.length < 5) nameViol.push(`${label}: tlv="${img.name}" triplet="${extractPresetName(parsed)}"`);

    const amps = img.blocks.filter((b) => b.blockName === 'Amp');
    if (amps.length > 0) {
      ampBearing++;
      const allSane = amps.every((a) => img.words[a.baseWord] <= AMP_TYPE_ORDINAL_MAX);
      if (allSane) ampOrdinalOK++;
      else if (ampViol.length < 5) ampViol.push(`${label}: type=${amps.map((a) => img.words[a.baseWord]).join(',')}`);
    }

    // Post-terminator words: zero, except the tone-match bulk region.
    if (img.toneMatchPresent) toneMatchCount++;
    let tailClean = true;
    for (let k = img.terminatorWord + 1; k < PRESET_IMAGE_WORDS; k++) {
      if (img.words[k] !== 0 && !(img.toneMatchPresent && k >= TONE_MATCH_BULK_START)) {
        tailClean = false;
        break;
      }
    }
    if (tailClean) tailZeroOK++;
    else if (tailZeroViol.length < 5) tailZeroViol.push(label);
  }

  const n = corpus.length;
  check(`corpus: ${walked}/${n} chains walk clean (strict parse)`, walked === n, walkFails.slice(0, 3).join('; '));
  check(
    `corpus: ${alphaOK}/${walked} effect regions alphabetical by squashed display name`,
    alphaOK === walked,
    alphaViol.join('; '),
  );
  check(
    `corpus: ${tailOK}/${walked} system tails match [170?,139,140,142?,143?,141] grammar`,
    tailOK === walked,
    tailViol.join('; '),
  );
  check(`corpus: ${modOK}/${walked} modifier records len-15, slot 1..20, before first block`, modOK === walked, modViol.join('; '));
  check(`corpus: ${nameOK}/${walked} TLV name == triplet-decoded name`, nameOK === walked, nameViol.join('; '));
  check(
    `corpus: ${ampOrdinalOK}/${ampBearing} amp-bearing presets have amp-type ordinal <= ${AMP_TYPE_ORDINAL_MAX}`,
    ampOrdinalOK === ampBearing,
    ampViol.join('; '),
  );
  check(
    `corpus: ${tailZeroOK}/${walked} post-terminator regions zero (tone-match bulk @2048 exempt; ${toneMatchCount} tone-match presets)`,
    tailZeroOK === walked,
    tailZeroViol.join('; '),
  );

  // BK-070 one-variable diff pairs → predicted words.
  const DIFF_PAIRS: Array<{ stem: string; paramId: number; predicted: number; what: string }> = [
    { stem: 'samples/captured/bk070-loop-amp-bass-2', paramId: ANCHOR_AMP_BASS_PARAM_ID, predicted: ANCHOR_AMP_BASS_Y_WORD, what: 'amp.bass ch-Y' },
    { stem: 'samples/captured/bk070-loop-amp-master-vol-3', paramId: ANCHOR_AMP_MASTER_PARAM_ID, predicted: ANCHOR_AMP_MASTER_Y_WORD, what: 'amp.master_volume ch-Y' },
  ];
  for (const { stem, paramId, predicted, what } of DIFF_PAIRS) {
    const basePath = `${stem}-baseline.syx`;
    const afterPath = `${stem}-after.syx`;
    if (!existsSync(basePath) || !existsSync(afterPath)) {
      console.log(`  skip  ${stem}-{baseline,after}.syx (not present)`);
      skipped++;
      continue;
    }
    const base = parsePresetImage(deframePresetImage(parsePresetDump(new Uint8Array(readFileSync(basePath)))));
    const after = deframePresetImage(parsePresetDump(new Uint8Array(readFileSync(afterPath))));
    const fromWalker = getParamWord(base, AMP_WIRE_ID, paramId, 'Y').wordIndex;
    const diffs: number[] = [];
    for (let k = 0; k < PRESET_IMAGE_WORDS; k++) {
      if (base.words[k] !== after[k]) diffs.push(k);
    }
    check(
      `bk070 ${what}: walker predicts word ${predicted}; hardware diff = [${diffs.join(',')}]`,
      fromWalker === predicted && diffs.length === 1 && diffs[0] === predicted,
      `walker=${fromWalker}`,
    );
  }
} else {
  console.log('  skip  no corpus fixtures present — Section 2 skipped entirely');
}

// ═════════════════════════════════════════════════════════════════════
// Section 3: 2026-07-10 drive Y effect_type leak: ground-truth golden
// + display-first hardening guard
// ═════════════════════════════════════════════════════════════════════

console.log('\nSection 3: drive Y effect_type leak (2026-07-10)');

// Synthetic: any select-type param whose wire ordinal has no roster row
// must decode to a labeled decode-gap placeholder, never the bare wire
// int. Reproduces the reported shape (a channel-Y `effect_type` word
// holding an unmapped ordinal) without depending on the founder's
// private fixture.
{
  const decoded = decodeGroupValues('DRV', [999999]); // paramId 0 = drive.effect_type
  check(
    'synthetic: unmapped select ordinal decodes to labeled placeholder, not a bare number',
    decoded.out['effect_type'] === 'UNKNOWN TYPE (ordinal 999999)',
    `got ${JSON.stringify(decoded.out['effect_type'])}`,
  );
}

// Ground-truth golden (skip-if-absent; the founder's private backup, not
// committed Fractal IP). Hardware-confirmed 2026-07-10: this preset's
// drive block holds X=T808 OD / Y=BLACKGLASS 7K on the front panel.
{
  const FIXTURE_PATH =
    'C:/Users/Steph/mcp-midi-backups/Fractal_Axe-Fx_II_XL-8-String_Bass-2026-07-10_16-46-28.syx';
  if (!existsSync(FIXTURE_PATH)) {
    console.log(`  skip  ${FIXTURE_PATH} (not present)`);
    skipped++;
  } else {
    const img = parsePresetImage(deframePresetImage(parsePresetDump(new Uint8Array(readFileSync(FIXTURE_PATH)))));
    const drive = img.blocks.find((b) => b.blockName === 'Drive');
    if (drive === undefined) {
      check('hw fixture: preset has a Drive block', false, 'no Drive TLV in chain');
    } else {
      const xWord = getParamWord(img, drive.wireId, 0, 'X');
      const yWord = getParamWord(img, drive.wireId, 0, 'Y');
      check(
        'hw fixture: drive channel-X effect_type word holds T808 OD ordinal (6)',
        xWord.value === 6,
        `word ${xWord.wordIndex} = ${xWord.value}`,
      );
      check(
        'hw fixture: drive channel-Y effect_type word holds BLACKGLASS 7K ordinal (36)',
        yWord.value === 36,
        `word ${yWord.wordIndex} = ${yWord.value}; expected baseWord(${drive.baseWord}) + xToYOffset(${drive.xToYOffset}) + paramId(0)`,
      );
      const perChannel = drive.xToYOffset ?? drive.payloadLen;
      const xValues = Array.from(img.words.slice(drive.baseWord, drive.baseWord + perChannel));
      const yStart = drive.baseWord + (drive.xToYOffset ?? 0);
      const yValues = Array.from(img.words.slice(yStart, yStart + perChannel));
      const xDecoded = decodeGroupValues('DRV', xValues);
      const yDecoded = decodeGroupValues('DRV', yValues);
      check(
        'hw fixture: decodeGroupValues X effect_type label = "T808 OD"',
        xDecoded.out['effect_type'] === 'T808 OD',
        `got ${JSON.stringify(xDecoded.out['effect_type'])}`,
      );
      check(
        'hw fixture: decodeGroupValues Y effect_type label = "BLACKGLASS 7K" (not a raw number)',
        yDecoded.out['effect_type'] === 'BLACKGLASS 7K',
        `got ${JSON.stringify(yDecoded.out['effect_type'])}`,
      );
    }
  }
}

console.log(`\n${pass} ok, ${fail} fail, ${skipped} skipped.`);
if (fail > 0) process.exit(1);
