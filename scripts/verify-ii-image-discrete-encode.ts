/**
 * Axe-Fx II discrete (rostered-select) image-encode goldens.
 *
 * Validates the fractal-midi preset-image encode substrate + the
 * discrete word-patch lane (`fractal-midi/gen2/axe-fx-ii` presetImage/)
 * against the shipped fractal-gen2 decoder and the on-disk corpus.
 *
 * Section 1 (always runs, pure CPU): synthetic apply + refusal wiring.
 *
 * Section 2 (capture-gated, skipped when fixtures absent):
 *   a. SUBSTRATE IDENTITY: every corpus dump (384 Q8.02 factory + live
 *      hw dumps) parses through the fractal-midi frame codec with
 *      words byte-identical to the shipped fractal-gen2
 *      deframePresetImage, re-serializes byte-identical to the source
 *      file, and passes the round-trip-identity gate. The two
 *      implementations cannot silently diverge while this holds.
 *   b. DISCRETE X CENSUS (the ordinal-in-word invariant): every
 *      rostered-select X-channel word across the whole corpus decodes
 *      in-roster, with zero sentinels and zero out-of-roster values
 *      (tempo dual-mode selects and bypass-pid words excluded by name,
 *      exactly as the patch lane's gates exclude them).
 *   c. DONOR-SPLICE GOLDEN: patch factory-A000 amp.effect_type X
 *      (ordinal 0 "59 BASSGUY" -> 36 "SOLO 100 LEAD") and
 *      reverb.effect_type Y (clean group): strict decode passes,
 *      exactly one word changed per patch, read-back through the
 *      SHIPPED fractal-gen2 walker returns the patched ordinal.
 *   d. HARDWARE GROUND-TRUTH ANCHOR (2026-07-10 fixture, if present):
 *      drive X effect_type word 844 = 6 (T808 OD), drive Y word 865 =
 *      36 (BLACKGLASS 7K), front-panel-confirmed.
 */

import { existsSync, readFileSync } from 'node:fs';

import {
  parseIIPresetDumpFrames,
  serializeIIPresetDumpFrames,
  verifyImageRoundTrip,
  imageFromFrames,
  framesFromImage,
  applyDiscreteSelectsToDump,
  parseIIImageTlv,
  findIIImageBlock,
  imageParamWordIndex,
  II_BYPASS_PID_BY_GROUP,
  II_IMAGE_WORDS,
  II_IMAGE_FORMAT_TAG,
  II_TLV_CHAIN_START,
  II_PRESET_DUMP_LEN,
  KNOWN_PARAMS,
  BLOCK_BY_ID,
  type AxeFxIIParam,
} from 'fractal-midi/gen2/axe-fx-ii';

import {
  parsePresetDump as gen2ParsePresetDump,
  parsePresetBank as gen2ParsePresetBank,
} from '@mcp-midi-control/fractal-gen2/presetDump.js';
import {
  deframePresetImage as gen2Deframe,
  parsePresetImage as gen2ParseImage,
  getParamWord as gen2GetParamWord,
} from '@mcp-midi-control/fractal-gen2/presetImageTlv.js';

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
// Section 1: synthetic wiring (always runs)
// ═════════════════════════════════════════════════════════════════════

console.log('Section 1: synthetic discrete-patch wiring');
{
  const words = new Uint16Array(II_IMAGE_WORDS);
  words[0] = II_IMAGE_FORMAT_TAG;
  let i = II_TLV_CHAIN_START;
  words[i] = 106; words[i + 1] = 236; i += 2 + 236;
  words[i] = 139; words[i + 1] = 8; i += 2 + 8;
  words[i] = 140; words[i + 1] = 20; i += 2 + 20;
  words[i] = 141; words[i + 1] = 96; i += 2 + 96;
  // minimal valid grid: amp at (1,2), input-node connect
  words[34 + ((1 - 1) * 4 + (2 - 1)) * 2] = 106;
  words[34 + ((1 - 1) * 4 + (2 - 1)) * 2 + 1] = 0x02;
  const bytes = serializeIIPresetDumpFrames(
    framesFromImage({ words, reserved: new Uint8Array(II_IMAGE_WORDS) }, new Uint8Array([0, 0, 0, 0x20])),
  );
  const ok = applyDiscreteSelectsToDump(bytes, [
    { blockWireId: 106, paramName: 'effect_type', channel: 'X', value: 'BRIT JM45' },
  ]);
  check('synthetic: X patch by label applies', ok.ok, !ok.ok ? ok.reason : '');
  if (ok.ok) {
    check('synthetic: type-selector note present', ok.applied[0]?.note !== undefined);
    check('synthetic: patched dump passes round trip', verifyImageRoundTrip(parseIIPresetDumpFrames(ok.patchedBytes)).ok);
  }
  const refuse = applyDiscreteSelectsToDump(bytes, [
    { blockWireId: 106, paramName: 'bass', channel: 'X', value: 5 },
  ]);
  check('synthetic: knob param refuses (continuous lane owns it)', !refuse.ok);
}

// ═════════════════════════════════════════════════════════════════════
// Section 2: capture-gated corpus goldens
// ═════════════════════════════════════════════════════════════════════

console.log('\nSection 2: corpus substrate identity + discrete X census (capture-gated)');

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
const GROUND_TRUTH_FIXTURE =
  'C:/Users/Steph/mcp-midi-backups/Fractal_Axe-Fx_II_XL-8-String_Bass-2026-07-10_16-46-28.syx';

interface CorpusDump {
  readonly label: string;
  readonly bytes: Uint8Array;
}

const corpus: CorpusDump[] = [];
for (const p of BANK_PATHS) {
  if (!existsSync(p)) { console.log(`  skip  ${p} (not present)`); skipped++; continue; }
  const raw = new Uint8Array(readFileSync(p));
  for (let off = 0, n = 0; off + II_PRESET_DUMP_LEN <= raw.length; off += II_PRESET_DUMP_LEN, n++) {
    corpus.push({ label: `${p}#${n}`, bytes: raw.slice(off, off + II_PRESET_DUMP_LEN) });
  }
}
for (const p of LOCAL_DUMPS) {
  if (!existsSync(p)) { console.log(`  skip  ${p} (not present)`); skipped++; continue; }
  corpus.push({ label: p, bytes: new Uint8Array(readFileSync(p)) });
}

if (corpus.length === 0) {
  console.log('  skip  no corpus fixtures present');
} else {
  // ── 2a: substrate identity ──
  let identityOk = 0;
  const identityFails: string[] = [];
  for (const d of corpus) {
    try {
      const frames = parseIIPresetDumpFrames(d.bytes);
      const rt = verifyImageRoundTrip(frames);
      if (!rt.ok) throw new Error(rt.reason);
      const reser = serializeIIPresetDumpFrames(frames);
      if (reser.length !== d.bytes.length) throw new Error('re-serialize length');
      for (let i = 0; i < reser.length; i++) {
        if (reser[i] !== d.bytes[i]) throw new Error(`re-serialize byte ${i}`);
      }
      const gen2Words = gen2Deframe(gen2ParsePresetDump(d.bytes));
      for (let i = 0; i < II_IMAGE_WORDS; i++) {
        if (rt.image.words[i] !== gen2Words[i]) throw new Error(`word ${i} differs from fractal-gen2`);
      }
      identityOk++;
    } catch (err) {
      if (identityFails.length < 5) identityFails.push(`${d.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  check(
    `substrate: ${identityOk}/${corpus.length} dumps byte-identical across both implementations + round-trip clean`,
    identityOk === corpus.length,
    identityFails.join('; '),
  );

  // ── 2b: discrete X census ──
  // Every registered rostered select, X channel, across every placed
  // block: word must be in-roster. Tempo dual-mode + bypass-pid words
  // are excluded exactly as the patch lane excludes them.
  const selectsByGroup = new Map<string, AxeFxIIParam[]>();
  for (const p of Object.values(KNOWN_PARAMS) as AxeFxIIParam[]) {
    if (p.controlType !== 'select') continue;
    if (p.enumValues === undefined || Object.keys(p.enumValues).length === 0) continue;
    if (/(^|_)tempo(_|$)|tempo$/i.test(p.name)) continue;
    const bypassPid = II_BYPASS_PID_BY_GROUP.get(p.groupCode);
    if (bypassPid !== undefined && p.paramId === bypassPid) continue;
    const list = selectsByGroup.get(p.groupCode) ?? [];
    list.push(p);
    selectsByGroup.set(p.groupCode, list);
  }
  let observations = 0;
  let violations = 0;
  let outOfBoundSkips = 0;
  const violationSamples: string[] = [];
  for (const d of corpus) {
    const frames = parseIIPresetDumpFrames(d.bytes);
    const image = imageFromFrames(frames);
    const tlv = parseIIImageTlv(image.words);
    for (const block of [...tlv.blocks, ...tlv.systemTail]) {
      const group = block.block?.groupCode;
      if (group === undefined) continue;
      const selects = selectsByGroup.get(group);
      if (selects === undefined) continue;
      for (const p of selects) {
        let wordIndex: number;
        try {
          wordIndex = imageParamWordIndex(block, p.paramId, 'X');
        } catch {
          outOfBoundSkips++;
          continue;
        }
        observations++;
        const w = image.words[wordIndex];
        if (p.enumValues![w] === undefined) {
          violations++;
          if (violationSamples.length < 5) {
            violationSamples.push(`${d.label} ${p.block}.${p.name} X word ${wordIndex} = ${w}`);
          }
        }
      }
    }
  }
  check(
    `census: ${observations} rostered-select X observations, 0 out-of-roster (violations=${violations}, oob-skips=${outOfBoundSkips})`,
    violations === 0 && observations > 20000,
    violationSamples.join('; '),
  );

  // ── 2c: donor-splice golden on factory A000 ──
  const a000 = corpus.find((d) => d.label.endsWith('Bank-A_Q8p02.syx#0'));
  if (a000 !== undefined) {
    const source = imageFromFrames(parseIIPresetDumpFrames(a000.bytes));
    const result = applyDiscreteSelectsToDump(a000.bytes, [
      { blockWireId: 106, paramName: 'effect_type', channel: 'X', value: 'SOLO 100 LEAD' },
      { blockWireId: 110, paramName: 'effect_type', channel: 'Y', value: 2 },
    ]);
    check('A000: amp X + reverb Y patches apply', result.ok, !result.ok ? result.reason : '');
    if (result.ok) {
      check('A000: 2 applied, 0 refused', result.applied.length === 2 && result.refused.length === 0);
      check('A000: pre-patch amp type word was in-roster ordinal 0', result.applied[0]?.beforeWire === 0 && result.applied[0]?.beforeInRoster === true);
      const patchedWords = gen2Deframe(gen2ParsePresetDump(result.patchedBytes));
      let diff = 0;
      for (let i = 0; i < II_IMAGE_WORDS; i++) if (patchedWords[i] !== source.words[i]) diff++;
      check('A000: full-image diff touches exactly the 2 patched words', diff === 2, `diff=${diff}`);
      const gen2Image = gen2ParseImage(patchedWords);
      const ampWord = gen2GetParamWord(gen2Image, 106, 0, 'X');
      check('A000: shipped fractal-gen2 walker reads back ordinal 36 (SOLO 100 LEAD)', ampWord.value === 36, String(ampWord.value));
      const revWord = gen2GetParamWord(gen2Image, 110, 0, 'Y');
      check('A000: shipped walker reads back reverb Y ordinal 2', revWord.value === 2, String(revWord.value));
    }
    // refusal parity on a real dump
    const refuse = applyDiscreteSelectsToDump(a000.bytes, [
      { blockWireId: 106, paramName: 'bypass', channel: 'X', value: 0 },
      { blockWireId: 114, paramName: 'effect_type', channel: 'Y', value: 3 },
    ]);
    check(
      'A000: bypass-pid + MTD-Y refuse on a real dump',
      !refuse.ok &&
        (refuse.refused?.[0]?.reason.includes('scene-state') ?? false) &&
        (refuse.refused?.[1]?.reason.includes('NOT an X/Y param mirror') ?? false),
      !refuse.ok ? JSON.stringify(refuse.refused?.map((r) => r.reason)) : 'unexpectedly applied',
    );
  } else if (corpus.length > 0) {
    console.log('  skip  factory A000 not present');
    skipped++;
  }

  // ── 2d: hardware ground-truth fixture anchors ──
  if (existsSync(GROUND_TRUTH_FIXTURE)) {
    const bytes = new Uint8Array(readFileSync(GROUND_TRUTH_FIXTURE));
    const rt = verifyImageRoundTrip(parseIIPresetDumpFrames(bytes));
    check('fixture: 2026-07-10 ground-truth dump passes round trip', rt.ok, !rt.ok ? rt.reason : '');
    if (rt.ok) {
      const tlv = parseIIImageTlv(rt.image.words);
      const drive = findIIImageBlock(tlv, 133);
      check('fixture: drive block present', drive !== undefined);
      if (drive !== undefined) {
        const x = imageParamWordIndex(drive, 0, 'X');
        const y = imageParamWordIndex(drive, 0, 'Y');
        const driveRoster = (KNOWN_PARAMS as Record<string, AxeFxIIParam>)['drive.effect_type'].enumValues!;
        check(
          `fixture: drive X word ${x} = 6 (T808 OD, front-panel-confirmed)`,
          x === 844 && rt.image.words[x] === 6 && driveRoster[6] === 'T808 OD',
          `word ${x} = ${rt.image.words[x]}`,
        );
        check(
          `fixture: drive Y word ${y} = 36 (BLACKGLASS 7K, front-panel-confirmed)`,
          y === 865 && rt.image.words[y] === 36 && driveRoster[36] === 'BLACKGLASS 7K',
          `word ${y} = ${rt.image.words[y]}`,
        );
      }
    }
  } else {
    console.log(`  skip  ${GROUND_TRUTH_FIXTURE} (not present)`);
    skipped++;
  }
}

console.log(`\n${pass} ok, ${fail} fail, ${skipped} skipped.`);
if (fail > 0) process.exit(1);

// Referenced only for parity with the block registry export surface.
void BLOCK_BY_ID;
