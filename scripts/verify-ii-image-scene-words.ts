/**
 * Axe-Fx II scene-state word codec goldens.
 *
 * Section 1 (always runs, pure CPU): bit semantics + RMW encode.
 *
 * Section 2 (capture-gated):
 *   a. CORPUS SURVEY: every placed block with a located scene word
 *      (baseWord + registered bypass pid) decodes; single-channel
 *      blocks must carry zero channel-Y mask bits (the one known
 *      corpus anomaly, factory-B052 "Cavernous" Output 0x0400, is
 *      allowlisted and asserted to stay the ONLY one).
 *   b. PAIRED-CAPTURE REPLAY (the killer golden): for every bk070
 *      one-variable hardware pair on disk (baseline/after), diff the
 *      de-framed images. Pairs whose single diff word is a placed
 *      block's scene word are REPLAYED: the scene ops derived from the
 *      XOR bits are applied to the BASELINE bytes through the encoder,
 *      and the output must equal the real AFTER dump BYTE-FOR-BYTE,
 *      byte-2 reserved bits and footer included. This exercises both
 *      of this session's byte-2 decodes end-to-end: the scene-word
 *      bypass MIRROR (b2 = (word & 0x1f) << 2, maintained by the
 *      encoder) and the 21-BIT footer XOR-fold (bp s1..s5 and the
 *      loop-delay pairs flip mirror + footer high-septet bits; a
 *      16-bit-only encoder fails those 16 pairs byte-exactly).
 *      Pairs that diff at a non-scene word (the continuous amp
 *      bass/master-vol pairs) are asserted single-word and skipped;
 *      byte-identical pairs are counted as hardware no-op toggles.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';

import {
  parseIIPresetDumpFrames,
  verifyImageRoundTrip,
  parseIIImageTlv,
  sceneStateWordIndex,
  decodeSceneStateWord,
  encodeSceneStateWord,
  applySceneStateToDump,
  II_IMAGE_WORDS,
  II_PRESET_DUMP_LEN,
  type IISceneStateOp,
} from 'fractal-midi/gen2/axe-fx-ii';

let pass = 0;
let fail = 0;
let skipped = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok    ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ': ' + detail : ''}`);
    fail++;
  }
}

// ═════════════════════════════════════════════════════════════════════
// Section 1: bit semantics (always runs)
// ═════════════════════════════════════════════════════════════════════

console.log('Section 1: scene-state bit semantics');
{
  const factoryDriveCluster = 0x0803; // bypassed scenes 1+2, channel Y scene 4
  const decoded = decodeSceneStateWord(factoryDriveCluster);
  check(
    'decode: 0x0803 = bypassed s1+s2, channel-Y s4',
    decoded[0].bypassed && decoded[1].bypassed && !decoded[2].bypassed && decoded[3].channelY && !decoded[3].bypassed,
  );
  let w = 0x0100; // channel Y scene 1 (the Test Crunch amp baseline state)
  w = encodeSceneStateWord(w, { blockWireId: 0, scene: 1, channelY: false });
  check('encode: clearing Y s1 from 0x0100 yields 0', w === 0);
  w = encodeSceneStateWord(w, { blockWireId: 0, scene: 8, bypassed: true });
  check('encode: bypass s8 sets bit 7', w === 0x0080);
}

// ═════════════════════════════════════════════════════════════════════
// Section 2: corpus survey + paired replay (capture-gated)
// ═════════════════════════════════════════════════════════════════════

console.log('\nSection 2: corpus survey + bk070 paired-capture replay (capture-gated)');

const BANK_PATHS = [
  'samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx',
  'samples/factory/Axe-Fx-II_XL+_Bank-B_Q8p02.syx',
  'samples/factory/Axe-Fx-II_XL+_Bank-C_Q8p02.syx',
];

interface CorpusDump {
  readonly label: string;
  readonly bytes: Uint8Array;
}

const corpus: CorpusDump[] = [];
for (const p of BANK_PATHS) {
  if (!existsSync(p)) { console.log(`  skip  ${p} (not present)`); skipped++; continue; }
  const raw = new Uint8Array(readFileSync(p));
  for (let off = 0, n = 0; off + II_PRESET_DUMP_LEN <= raw.length; off += II_PRESET_DUMP_LEN, n++) {
    corpus.push({ label: `${p.replace(/^.*Bank-/, 'Bank-')}#${n}`, bytes: raw.slice(off, off + II_PRESET_DUMP_LEN) });
  }
}

if (corpus.length > 0) {
  let sceneWords = 0;
  let singleChannelYAnomalies: string[] = [];
  for (const d of corpus) {
    const rt = verifyImageRoundTrip(parseIIPresetDumpFrames(d.bytes));
    if (!rt.ok) { check(`survey: ${d.label} round trip`, false, rt.reason); continue; }
    const tlv = parseIIImageTlv(rt.image.words);
    for (const block of [...tlv.blocks, ...tlv.systemTail]) {
      const idx = sceneStateWordIndex(block);
      if (idx === undefined) continue;
      sceneWords++;
      if (block.xToYOffset === undefined) {
        const word = rt.image.words[idx];
        if ((word & 0xff00) !== 0) {
          singleChannelYAnomalies.push(`${d.label} ${tlv.name} wire_id ${block.wireId} word 0x${word.toString(16)}`);
        }
      }
    }
  }
  check(`survey: ${sceneWords} located scene words decoded across ${corpus.length} factory presets`, sceneWords > 2500);
  check(
    'survey: exactly 1 single-channel Y-bit anomaly corpus-wide (B052 "Cavernous" Output, allowlisted)',
    singleChannelYAnomalies.length === 1 && singleChannelYAnomalies[0].includes('Cavernous'),
    singleChannelYAnomalies.join('; '),
  );
} else {
  console.log('  skip  no factory corpus present');
}

// ── 2b: paired-capture replay ──
const CAPTURE_DIR = 'samples/captured';
if (existsSync(CAPTURE_DIR)) {
  const baselines = readdirSync(CAPTURE_DIR)
    .filter((f) => f.startsWith('bk070-') && f.endsWith('-baseline.syx'))
    .sort();
  let replayed = 0;
  let noops = 0;
  let nonScene = 0;
  const failures: string[] = [];
  for (const baseFile of baselines) {
    const afterFile = baseFile.replace(/-baseline\.syx$/, '-after.syx');
    const basePath = `${CAPTURE_DIR}/${baseFile}`;
    const afterPath = `${CAPTURE_DIR}/${afterFile}`;
    if (!existsSync(afterPath)) continue;
    const baseBytes = new Uint8Array(readFileSync(basePath));
    const afterBytes = new Uint8Array(readFileSync(afterPath));
    if (baseBytes.length !== II_PRESET_DUMP_LEN || afterBytes.length !== II_PRESET_DUMP_LEN) continue;

    let identical = baseBytes.length === afterBytes.length;
    for (let i = 0; identical && i < baseBytes.length; i++) identical = baseBytes[i] === afterBytes[i];
    if (identical) { noops++; continue; }

    const baseRt = verifyImageRoundTrip(parseIIPresetDumpFrames(baseBytes));
    const afterRt = verifyImageRoundTrip(parseIIPresetDumpFrames(afterBytes));
    if (!baseRt.ok || !afterRt.ok) {
      failures.push(`${baseFile}: round trip failed`);
      continue;
    }
    const diffs: number[] = [];
    for (let i = 0; i < II_IMAGE_WORDS; i++) {
      if (baseRt.image.words[i] !== afterRt.image.words[i]) diffs.push(i);
    }
    if (diffs.length !== 1) {
      failures.push(`${baseFile}: ${diffs.length} diff words, expected 1`);
      continue;
    }
    const diffWord = diffs[0];
    const tlv = parseIIImageTlv(baseRt.image.words);
    const sceneBlock = [...tlv.blocks, ...tlv.systemTail].find((b) => sceneStateWordIndex(b) === diffWord);
    if (sceneBlock === undefined) {
      nonScene++; // continuous one-variable pair (amp bass / master vol)
      continue;
    }
    // Derive the scene ops from the XOR bits and replay through the encoder.
    const before = baseRt.image.words[diffWord];
    const after = afterRt.image.words[diffWord];
    const ops: IISceneStateOp[] = [];
    for (let bit = 0; bit < 16; bit++) {
      if (((before ^ after) & (1 << bit)) === 0) continue;
      const setInAfter = (after & (1 << bit)) !== 0;
      if (bit < 8) {
        ops.push({ blockWireId: sceneBlock.wireId, scene: bit + 1, bypassed: setInAfter });
      } else {
        ops.push({ blockWireId: sceneBlock.wireId, scene: bit - 7, channelY: setInAfter });
      }
    }
    const result = applySceneStateToDump(baseBytes, ops);
    if (!result.ok) {
      failures.push(`${baseFile}: encoder refused: ${result.reason}`);
      continue;
    }
    let byteIdentical = result.patchedBytes.length === afterBytes.length;
    for (let i = 0; byteIdentical && i < afterBytes.length; i++) {
      byteIdentical = result.patchedBytes[i] === afterBytes[i];
    }
    if (!byteIdentical) {
      failures.push(`${baseFile}: replay NOT byte-identical to the real after-dump`);
      continue;
    }
    replayed++;
  }
  check(
    `replay: ${replayed} scene pairs replayed byte-identically (noop=${noops}, continuous=${nonScene})`,
    failures.length === 0 && replayed >= 25,
    failures.join('; '),
  );
} else {
  console.log(`  skip  ${CAPTURE_DIR} (not present)`);
  skipped++;
}

console.log(`\n${pass} ok, ${fail} fail, ${skipped} skipped.`);
if (fail > 0) process.exit(1);
