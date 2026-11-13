/**
 * BK-081 / BK-084 goldens: Axe-Fx II atomic whole-preset-image read
 * (`presetImageRead.ts`) and the atomic-apply v1 continuous-param
 * read-modify-write pipeline (`presetImageContinuousPatch.ts` +
 * `descriptor/imageApply.ts`), per
 * `docs/design/ii-atomic-apply-safety-review.md`.
 *
 * Section 1 (always runs, pure CPU, no fixtures needed):
 *   - `verifyRoundTripIdentity` passes on a synthetic well-formed image
 *     and REFUSES a corrupted one (a non-zero byte-2 reserved bit that
 *     our decode model can't reproduce).
 *   - `applyContinuousParamsToImage` on the synthetic image: a successful
 *     patch touches EXACTLY the target word (full 4096-word diff scan),
 *     recomputes the footer hash correctly, and the patched bytes re-parse
 *     cleanly. Refusal paths: enum/type param, block absent from the
 *     chain, Y channel on an odd-payload block, no patches given.
 *
 * Section 2 (capture-gated, skipped when fixtures are absent):
 *   - `verifyRoundTripIdentity` sweeps the Q8.02 factory corpus + the
 *     hw132 hardware dumps (388 total, same corpus as
 *     verify-ii-preset-image-tlv.ts), expect every dump to deframe/parse
 *     cleanly with a footer hash matching our XOR-fold formula.
 *   - A real hardware capture (bk070-loop-amp-bass-2-baseline.syx, the
 *     BK-070 anchor preset) patched via `applyContinuousParamsToImage`:
 *     amp.bass (paramId 2) on X and amp.master_volume (paramId 5) on Y,
 *     at the EXACT anchor words (149+2=151 X... computed from the
 *     dump's own TLV chain, not hardcoded); full-image diff confirms
 *     ONLY those two words changed, and the patched bytes' own
 *     round-trip-identity check passes (self-consistency: our write is
 *     itself a lossless image under our model).
 *
 * Section 3 (always runs, offline fake-conn, no hardware): the WIRE
 * orchestration, `readPresetImageSnapshot` (fast-fail when the transport
 * doesn't answer fn=0x03; a real decode from a synthesized 66-frame
 * reply) and `applyContinuousParamsAtomicII` (full dump→patch→push→
 * verify→save pipeline: clean success, NACK-abort before verify/STORE,
 * and read-back-mismatch refuses STORE).
 */

import { existsSync, readFileSync } from 'node:fs';

// Import-time side effect: registers the Axe-Fx II param-kind resolver
// (same as the live server boot), so calibrated knobs' encode/decode
// closures are available.
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
void AXEFX2_DESCRIPTOR;

import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

import {
  parsePresetDump,
  parsePresetBank,
  serializePresetDump,
  CHUNKS_PER_PRESET,
  type ParsedPresetDump,
} from '@mcp-midi-control/fractal-gen2/presetDump.js';
import {
  PRESET_IMAGE_WORDS,
  PRESET_IMAGE_FORMAT_TAG,
  TLV_CHAIN_START,
  MODIFIER_PAYLOAD_LEN,
  deframePresetImage,
  parsePresetImage,
  paramWordIndex,
} from '@mcp-midi-control/fractal-gen2/presetImageTlv.js';
import { verifyRoundTripIdentity } from '@mcp-midi-control/fractal-gen2/presetImageRoundTrip.js';
import {
  applyContinuousParamsToImage,
  type ContinuousParamPatchInput,
} from '@mcp-midi-control/fractal-gen2/presetImageContinuousPatch.js';
import { readPresetImageSnapshot } from '@mcp-midi-control/fractal-gen2/descriptor/presetImageRead.js';
import { createAtomicImageApply } from '@mcp-midi-control/fractal-gen2/descriptor/imageApply.js';
import { writer as xlPlusWriter } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';

// BK-084 wiring: the pipeline is now a config-parameterized factory
// (createAtomicImageApply); bind the XL+ shape the old singleton had so
// the Section 3 orchestration goldens keep exercising the same path
// writer.setParams' internal atomic batch heuristic uses (see
// setParamsAtomic.ts; the mode-collapse only changed the ENTRY POINT,
// this dump/patch/push/verify mechanism itself is unchanged).
const applyContinuousParamsAtomicII = createAtomicImageApply(
  { modelByte: 0x07, deviceLabel: 'Fractal Axe-Fx II XL+' },
  (ctx, location) => xlPlusWriter.savePreset!(ctx, location),
);

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

const AMP_WIRE_ID = 106;
const CAB_WIRE_ID = 108;
const GATE_EXPANDER_WIRE_ID = 150;
const AMP_BASS_PARAM_ID = 2;
const AMP_MASTER_VOLUME_PARAM_ID = 5;
const GATE_EXPANDER_MIX_PARAM_ID = 8;

// ═════════════════════════════════════════════════════════════════════
// Synthetic image builder (mirrors verify-ii-preset-image-tlv.ts, plus
// the byte-level wire encode needed to run it through parsePresetDump).
// ═════════════════════════════════════════════════════════════════════

function buildSyntheticWords(): Uint16Array {
  const w = new Uint16Array(PRESET_IMAGE_WORDS);
  w[0] = PRESET_IMAGE_FORMAT_TAG;
  const name = 'PATCH GOLD';
  for (let i = 0; i < name.length; i++) w[2 + i] = name.charCodeAt(i);
  let i = TLV_CHAIN_START;
  w[i] = 3; w[i + 1] = MODIFIER_PAYLOAD_LEN;
  i += 2 + MODIFIER_PAYLOAD_LEN;
  w[i] = AMP_WIRE_ID; w[i + 1] = 236;
  w[i + 2 + 0] = 42; // amp X type ordinal (arbitrary, within roster)
  w[i + 2 + AMP_BASS_PARAM_ID] = 30000; // amp.bass X, arbitrary pre-patch wire value
  w[i + 2 + AMP_MASTER_VOLUME_PARAM_ID] = 20000; // amp.master_volume X
  i += 2 + 236;
  w[i] = CAB_WIRE_ID; w[i + 1] = 78; // even payload; Cab has a Y half too, but odd-payload block needed below
  i += 2 + 78;
  // VolPan (odd payload, no Y half) so the "Y on odd-payload block throws" case has a real chain entry.
  w[i] = 127; w[i + 1] = 9;
  i += 2 + 9;
  w[i] = 139; w[i + 1] = 8; i += 2 + 8;
  w[i] = 140; w[i + 1] = 20; i += 2 + 20;
  w[i] = 141; w[i + 1] = 96; i += 2 + 96;
  // Gate Expander 1 (channel-bearing, even payload): reproduces the
  // 2026-07-17 hardware finding — `controlType: "unknown"` in the raw
  // catalog, but `mix` is suffix-rule-calibrated (bare "mix" -> 0..100%),
  // so it must be image-patch ELIGIBLE post-fix (was wrongly refused pre-fix).
  w[i] = GATE_EXPANDER_WIRE_ID; w[i + 1] = 24;
  w[i + 2 + GATE_EXPANDER_MIX_PARAM_ID] = 10000; // gateexpander.mix X, arbitrary pre-patch wire value
  i += 2 + 24;
  return w;
}

function encodeChunkPayload(words: Uint16Array, chunkIdx: number): Uint8Array {
  const p = new Uint8Array(194);
  p[0] = 0x40; p[1] = 0x00; // count = 64
  for (let k = 0; k < 64; k++) {
    const v = words[chunkIdx * 64 + k];
    const o = 2 + k * 3;
    p[o] = v & 0x7f;
    p[o + 1] = (v >> 7) & 0x7f;
    p[o + 2] = (v >> 14) & 0x03; // no reserved bits set, round-trip-identity-clean
  }
  return p;
}

function buildSyntheticDumpBytes(words: Uint16Array): Uint8Array {
  const chunkPayloads: Uint8Array[] = [];
  for (let c = 0; c < CHUNKS_PER_PRESET; c++) chunkPayloads.push(encodeChunkPayload(words, c));
  let hash = 0;
  for (const w of words) hash ^= (w & 0xffff);
  hash &= 0xffff;
  const footerPayload = new Uint8Array([hash & 0x7f, (hash >> 7) & 0x7f, (hash >> 14) & 0x03]);
  const headerPayload = new Uint8Array([0, 0, 0, 0x20]);
  return serializePresetDump({ raw: new Uint8Array(0), headerPayload, chunkPayloads, footerPayload });
}

// ═════════════════════════════════════════════════════════════════════
// Section 1: synthetic goldens (always run)
// ═════════════════════════════════════════════════════════════════════

console.log('Section 1: synthetic round-trip + continuous-patch goldens');

{
  const words = buildSyntheticWords();
  const dumpBytes = buildSyntheticDumpBytes(words);
  const parsed = parsePresetDump(dumpBytes);

  const rt = verifyRoundTripIdentity(parsed);
  check('round-trip-identity: passes on a clean synthetic image', rt.ok, !rt.ok ? rt.reason : '');

  // Non-zero byte-2 "reserved" bits are NOT a failure signal; primitive
  // `septet-21bit-byte2-mask-preservation` documents them as routine
  // firmware-defined state (386/388 real presets carry them somewhere),
  // and the read-modify-write patch path (`writeUshortAt`) already
  // preserves them untouched. Confirm that explicitly here so a future
  // change doesn't reintroduce the over-strict check this session removed.
  const reservedBitChunks = parsed.chunkPayloads.map((c) => Uint8Array.from(c));
  reservedBitChunks[0][2 + 5 * 3 + 2] |= 0x04; // set a bit outside the low-2-bits value mask
  const reservedBitDump: ParsedPresetDump = { ...parsed, chunkPayloads: reservedBitChunks };
  check(
    'round-trip-identity: non-zero byte-2 reserved bits are NOT refused (documented firmware behavior)',
    verifyRoundTripIdentity(reservedBitDump).ok,
  );

  // A footer-hash mismatch IS a real refusal signal (a corrupted/tampered
  // dump, or a firmware whose hash formula differs from our model).
  const badFooterChunks = parsed.chunkPayloads.map((c) => Uint8Array.from(c));
  const badFooter = Uint8Array.from(parsed.footerPayload);
  badFooter[0] ^= 0x01; // flip a low bit of the hash
  const badFooterDump: ParsedPresetDump = { ...parsed, chunkPayloads: badFooterChunks, footerPayload: badFooter };
  const rtBad = verifyRoundTripIdentity(badFooterDump);
  check(
    'round-trip-identity: refuses on a footer-hash mismatch',
    !rtBad.ok && rtBad.reason.includes('footer hash mismatch'),
    !rtBad.ok ? rtBad.reason : 'unexpectedly passed',
  );

  // ── applyContinuousParamsToImage: successful patch, full-image diff ──
  const patchDisplay = 7.25;
  const patches: ContinuousParamPatchInput[] = [
    { block: AMP_WIRE_ID, paramName: 'bass', channel: 'X', displayValue: patchDisplay },
  ];
  const result = applyContinuousParamsToImage(dumpBytes, patches);
  check('patch: applyContinuousParamsToImage succeeds on a valid continuous knob', result.ok, !result.ok ? result.reason : '');
  if (result.ok) {
    check('patch: exactly 1 applied, 0 refused', result.applied.length === 1 && result.refused.length === 0);
    const kind = resolveParamKind('axe-fx-ii', 'amp', 'bass');
    const expectedWire = Math.round(kind.encodeDisplay!(patchDisplay));
    check(
      'patch: applied wire value matches encodeDisplay(displayValue)',
      result.applied[0]?.afterWire === expectedWire,
      `got ${result.applied[0]?.afterWire}, expected ${expectedWire}`,
    );
    // Full 4096-word diff: ONLY the target word may differ from source.
    const rt2 = verifyRoundTripIdentity(parsed); // re-derive source words fresh
    const sourceWords = rt2.ok ? rt2.words : new Uint16Array(0);
    const patchedParsed = parsePresetDump(result.patchedBytes);
    const patchedWords = deframePresetImage(patchedParsed);
    let diffCount = 0;
    let onlyDiffIndex = -1;
    for (let idx = 0; idx < PRESET_IMAGE_WORDS; idx++) {
      if (sourceWords[idx] !== patchedWords[idx]) { diffCount++; onlyDiffIndex = idx; }
    }
    check(
      'patch: full-image diff touches EXACTLY 1 word',
      diffCount === 1 && onlyDiffIndex === result.applied[0]?.wordIndex,
      `diffCount=${diffCount}, onlyDiffIndex=${onlyDiffIndex}, applied.wordIndex=${result.applied[0]?.wordIndex}`,
    );
    check('patch: patched bytes re-parse cleanly (envelope + checksum)', patchedWords.length === PRESET_IMAGE_WORDS);
    check(
      'patch: patched bytes pass their OWN round-trip-identity check',
      verifyRoundTripIdentity(patchedParsed).ok,
    );
    // Footer hash formula: XOR-fold over the patched words.
    let expectedHash = 0;
    for (const wv of patchedWords) expectedHash ^= (wv & 0xffff);
    expectedHash &= 0xffff;
    check('patch: newFooterHash matches the XOR-fold of the patched words', result.newFooterHash === expectedHash);
  }

  // ── Refusal paths ──
  const enumResult = applyContinuousParamsToImage(dumpBytes, [
    { block: AMP_WIRE_ID, paramName: 'effect_type', channel: 'X', displayValue: 'BRIT JM45' },
  ]);
  check(
    'patch: refuses an enum/type param (controlType !== knob)',
    !enumResult.ok && enumResult.reason.includes('all refused') && (enumResult.refused?.[0]?.reason.includes('controlType') ?? false),
    !enumResult.ok ? enumResult.reason + ' / ' + JSON.stringify(enumResult.refused) : 'unexpectedly succeeded',
  );

  // BUG FIX regression (2026-07-17, hardware stress-test session):
  // controlType:"unknown"-but-calibrated params (suffix-rule overlay,
  // e.g. bare "mix" -> percent) must be ELIGIBLE, matching set_param's
  // actual coverage (its enum gate is controlType==='select', not a
  // controlType==='knob' allowlist). Caught live: a 37-param retune
  // batch on real hardware refused all-or-nothing over gateexpander.mix
  // alone.
  const unknownCalibratedResult = applyContinuousParamsToImage(dumpBytes, [
    { block: GATE_EXPANDER_WIRE_ID, paramName: 'mix', channel: 'X', displayValue: 42 },
  ]);
  check(
    'patch: ACCEPTS a controlType="unknown"-but-calibrated param (gateexpander.mix, suffix-rule percent)',
    unknownCalibratedResult.ok && unknownCalibratedResult.applied.length === 1,
    !unknownCalibratedResult.ok ? unknownCalibratedResult.reason : JSON.stringify(unknownCalibratedResult.refused),
  );
  if (unknownCalibratedResult.ok) {
    const kind = resolveParamKind('axe-fx-ii', 'gateexpander', 'mix');
    const expectedWire = Math.round(kind.encodeDisplay!(42));
    check(
      'patch: gateexpander.mix applied wire matches encodeDisplay(42)',
      unknownCalibratedResult.applied[0]?.afterWire === expectedWire,
      `got ${unknownCalibratedResult.applied[0]?.afterWire}, expected ${expectedWire}`,
    );
  }

  // Switches stay explicitly refused (unverified word-packing), even
  // though they too get a working encodeDisplay/decodeWire pair from
  // resolveParamKind — this is a deliberate, evidence-driven exclusion,
  // not an oversight the "unknown-but-calibrated" fix should have swept in.
  const switchResult = applyContinuousParamsToImage(dumpBytes, [
    { block: AMP_WIRE_ID, paramName: 'bright_switch', channel: 'X', displayValue: 'on' },
  ]);
  check(
    'patch: refuses a controlType="switch" param (unverified image word packing)',
    !switchResult.ok && (switchResult.refused?.[0]?.reason.includes('controlType="switch"') ?? false),
    !switchResult.ok ? JSON.stringify(switchResult.refused) : 'unexpectedly succeeded',
  );

  const unplacedResult = applyContinuousParamsToImage(dumpBytes, [
    { block: 'Reverb 1', paramName: 'mix', channel: 'X', displayValue: 5 },
  ]);
  check(
    'patch: refuses a block absent from the TLV chain',
    !unplacedResult.ok && (unplacedResult.refused?.[0]?.reason.includes('not present in this preset') ?? false),
    !unplacedResult.ok ? JSON.stringify(unplacedResult.refused) : 'unexpectedly succeeded',
  );

  const oddYResult = applyContinuousParamsToImage(dumpBytes, [
    { block: 127, paramName: 'volume', channel: 'Y', displayValue: 5 },
  ]);
  check(
    'patch: refuses channel Y on an odd-payload (single-channel) block',
    !oddYResult.ok && (oddYResult.refused?.[0]?.reason.includes('odd payload') ?? false),
    !oddYResult.ok ? JSON.stringify(oddYResult.refused) : 'unexpectedly succeeded',
  );

  const emptyResult = applyContinuousParamsToImage(dumpBytes, []);
  check('patch: refuses when no patches are given', !emptyResult.ok && emptyResult.reason.includes('no patches given'));

  // ── BK-084 wiring graft 8: duplicate-patch semantics ──
  // The same block+param+channel appearing twice resolves last-write-wins
  // in the image patch, pinned equal to streamed semantics (sequential
  // live writes: the last one is what the device holds).
  const dupResult = applyContinuousParamsToImage(dumpBytes, [
    { block: AMP_WIRE_ID, paramName: 'bass', channel: 'X', displayValue: 7.25 },
    { block: AMP_WIRE_ID, paramName: 'bass', channel: 'X', displayValue: 3.5 },
  ]);
  check('duplicate-patch: both entries apply (last-write-wins, streamed parity)', dupResult.ok && dupResult.applied.length === 2, !dupResult.ok ? dupResult.reason : '');
  if (dupResult.ok) {
    const kind = resolveParamKind('axe-fx-ii', 'amp', 'bass');
    const lastWire = Math.round(kind.encodeDisplay!(3.5));
    const wordIdx = dupResult.applied[1].wordIndex;
    const dupWords = deframePresetImage(parsePresetDump(dupResult.patchedBytes));
    check('duplicate-patch: the final word holds the LAST value', dupWords[wordIdx] === lastWire, `got ${dupWords[wordIdx]}, expected ${lastWire}`);
    check('duplicate-patch: both entries target the same word', dupResult.applied[0].wordIndex === wordIdx);
  }
}

// ═════════════════════════════════════════════════════════════════════
// Section 2: capture-gated real-hardware sweep
// ═════════════════════════════════════════════════════════════════════

console.log('\nSection 2: real-capture round-trip-identity + patch sweep (capture-gated)');

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

{
  const corpus: ParsedPresetDump[] = [];
  for (const p of BANK_PATHS) {
    if (!existsSync(p)) { console.log(`  skip  ${p} (not present)`); skipped++; continue; }
    corpus.push(...parsePresetBank(new Uint8Array(readFileSync(p))));
  }
  for (const p of LOCAL_DUMPS) {
    if (!existsSync(p)) { console.log(`  skip  ${p} (not present)`); skipped++; continue; }
    corpus.push(parsePresetDump(new Uint8Array(readFileSync(p))));
  }
  if (corpus.length > 0) {
    let ok = 0;
    const fails: string[] = [];
    for (const d of corpus) {
      const r = verifyRoundTripIdentity(d);
      if (r.ok) ok++;
      else if (fails.length < 5) fails.push(r.reason);
    }
    check(`corpus: ${ok}/${corpus.length} dumps pass round-trip-identity (deframe/parse + footer-hash match)`, ok === corpus.length, fails.join('; '));
  } else {
    console.log('  skip  no corpus fixtures present');
  }

  const anchorPath = 'samples/captured/bk070-loop-amp-bass-2-baseline.syx';
  if (existsSync(anchorPath)) {
    const bytes = new Uint8Array(readFileSync(anchorPath));
    const parsed = parsePresetDump(bytes);
    const rt = verifyRoundTripIdentity(parsed);
    if (rt.ok) {
      const image = parsePresetImage(rt.words);
      const ampBlock = image.blocks.find((b) => b.wireId === AMP_WIRE_ID);
      check('anchor: bk070 baseline has an Amp TLV in its chain', ampBlock !== undefined);
      if (ampBlock !== undefined) {
        const expectedXWord = paramWordIndex(ampBlock, AMP_BASS_PARAM_ID, 'X');
        const expectedYWord = paramWordIndex(ampBlock, AMP_MASTER_VOLUME_PARAM_ID, 'Y');
        const patches: ContinuousParamPatchInput[] = [
          { block: AMP_WIRE_ID, paramName: 'bass', channel: 'X', displayValue: 6.0 },
          { block: AMP_WIRE_ID, paramName: 'master_volume', channel: 'Y', displayValue: 4.0 },
        ];
        const result = applyContinuousParamsToImage(bytes, patches);
        check('anchor: real-dump patch (bass X + master_volume Y) succeeds', result.ok, !result.ok ? result.reason : '');
        if (result.ok) {
          check('anchor: 2 applied, 0 refused', result.applied.length === 2 && result.refused.length === 0);
          const patchedWords = deframePresetImage(parsePresetDump(result.patchedBytes));
          let diffCount = 0;
          const diffIdx: number[] = [];
          for (let idx = 0; idx < PRESET_IMAGE_WORDS; idx++) {
            if (rt.words[idx] !== patchedWords[idx]) { diffCount++; diffIdx.push(idx); }
          }
          check(
            'anchor: full-image diff touches EXACTLY the 2 intended words',
            diffCount === 2 && diffIdx.includes(expectedXWord) && diffIdx.includes(expectedYWord),
            `diffIdx=[${diffIdx.join(',')}], expected=[${expectedXWord},${expectedYWord}]`,
          );
          check(
            'anchor: the patched real dump passes its own round-trip-identity check',
            verifyRoundTripIdentity(parsePresetDump(result.patchedBytes)).ok,
          );
        }
      }
    } else {
      console.log(`  skip  ${anchorPath} failed its own round-trip-identity check: ${rt.reason}`);
      skipped++;
    }
  } else {
    console.log(`  skip  ${anchorPath} (not present)`);
    skipped++;
  }

  // ── BK-084 wiring golden 1: retune-shaped corpus patch ──
  // A retune-shaped patch of a REAL factory preset touching amp + cab +
  // delay knobs + one CPR knob + output.scene_1_main: exact word-diff
  // count, footer XOR-fold recompute, per-word round-trip. This is the
  // recon-gap closer: scene_N_main had never been image-patched in a
  // golden, and CPR words ride the image even though their live path is
  // fn=0x02-only (the stored word is a plain param word).
  {
    const OUTPUT_WIRE_ID = 140;
    const DELAY_WIRE_ID = 112;
    const CPR_WIRE_ID = 100;
    const bankPath = BANK_PATHS.find((p) => existsSync(p));
    if (bankPath === undefined) {
      console.log('  skip  retune-shaped corpus patch (no factory bank present)');
      skipped++;
    } else {
      const presets = parsePresetBank(new Uint8Array(readFileSync(bankPath)));
      let host: { parsed: ParsedPresetDump; words: Uint16Array } | undefined;
      for (const d of presets) {
        const r = verifyRoundTripIdentity(d);
        if (!r.ok) continue;
        const img = parsePresetImage(r.words);
        const ids = new Set([...img.blocks, ...img.systemTail].map((b) => b.wireId));
        if (ids.has(AMP_WIRE_ID) && ids.has(CAB_WIRE_ID) && ids.has(DELAY_WIRE_ID) && ids.has(CPR_WIRE_ID) && ids.has(OUTPUT_WIRE_ID)) {
          host = { parsed: d, words: r.words };
          break;
        }
      }
      check('retune-corpus: a factory preset hosts amp+cab+delay+compressor+output', host !== undefined);
      if (host !== undefined) {
        const hostBytes = serializePresetDump(host.parsed);
        const patches: ContinuousParamPatchInput[] = [
          { block: AMP_WIRE_ID, paramName: 'bass', channel: 'X', displayValue: 6.5 },
          { block: CAB_WIRE_ID, paramName: 'level', channel: 'X', displayValue: -3.0 },
          { block: DELAY_WIRE_ID, paramName: 'mix', channel: 'X', displayValue: 22 },
          { block: CPR_WIRE_ID, paramName: 'threshold', channel: 'X', displayValue: -30 },
          { block: OUTPUT_WIRE_ID, paramName: 'scene_1_main', channel: 'X', displayValue: 3.0 },
        ];
        const result = applyContinuousParamsToImage(hostBytes, patches);
        check('retune-corpus: 5-knob retune-shaped patch succeeds (incl. CPR + output.scene_1_main)', result.ok, !result.ok ? result.reason + ' ' + JSON.stringify((result as { refused?: unknown }).refused) : '');
        if (result.ok) {
          check('retune-corpus: 5 applied, 0 refused', result.applied.length === 5 && result.refused.length === 0, JSON.stringify(result.refused));
          const patchedParsed = parsePresetDump(result.patchedBytes);
          const patchedWords = deframePresetImage(patchedParsed);
          const expectedIdx = new Set(result.applied.map((a) => a.wordIndex));
          let diffCount = 0;
          let allExpected = true;
          for (let idx = 0; idx < PRESET_IMAGE_WORDS; idx++) {
            if (host.words[idx] !== patchedWords[idx]) {
              diffCount++;
              if (!expectedIdx.has(idx)) allExpected = false;
            }
          }
          // Duplicate word indexes can't occur here (5 distinct params),
          // so the diff count must be exactly the applied count minus any
          // patch whose target word already held the encoded value.
          const noOpPatches = result.applied.filter((a) => a.beforeWire === a.afterWire).length;
          check(
            `retune-corpus: full-image diff touches EXACTLY the intended words (${diffCount} diffs, ${noOpPatches} already-at-value)`,
            allExpected && diffCount === result.applied.length - noOpPatches,
            `diffCount=${diffCount}, applied=${result.applied.length}, noOp=${noOpPatches}`,
          );
          check('retune-corpus: patched dump passes its own round-trip-identity (footer XOR-fold recomputed)', verifyRoundTripIdentity(patchedParsed).ok);
          let expectedHash = 0;
          for (const wv of patchedWords) expectedHash ^= (wv & 0xffff);
          expectedHash &= 0xffff;
          check('retune-corpus: newFooterHash matches the XOR-fold of the patched words', result.newFooterHash === expectedHash);
        }
      }
    }
  }

  // ── BK-084 wiring golden 1b: Output scene_N_main bounds, corpus-wide ──
  // Every factory preset's Output TLV must expose paramIds 8..15
  // (scene_1_main..scene_8_main) inside its own payload bounds — the
  // words the retune path patches for scene trims. 384/384 expected.
  {
    const OUTPUT_WIRE_ID = 140;
    const corpus: ParsedPresetDump[] = [];
    for (const p of BANK_PATHS) {
      if (existsSync(p)) corpus.push(...parsePresetBank(new Uint8Array(readFileSync(p))));
    }
    if (corpus.length === 0) {
      console.log('  skip  output scene_N_main bounds sweep (no factory banks present)');
      skipped++;
    } else {
      let okCount = 0;
      let firstFail = '';
      for (let pi = 0; pi < corpus.length; pi++) {
        const r = verifyRoundTripIdentity(corpus[pi]);
        if (!r.ok) { if (!firstFail) firstFail = `preset ${pi}: ${r.reason}`; continue; }
        const img = parsePresetImage(r.words);
        const out = [...img.blocks, ...img.systemTail].find((b) => b.wireId === OUTPUT_WIRE_ID);
        if (out === undefined) { if (!firstFail) firstFail = `preset ${pi}: no Output TLV`; continue; }
        let allInBounds = true;
        for (let pid = 8; pid <= 15; pid++) {
          try {
            const w = paramWordIndex(out, pid, 'X');
            if (w < 0 || w >= PRESET_IMAGE_WORDS) { allInBounds = false; break; }
          } catch (err) {
            allInBounds = false;
            if (!firstFail) firstFail = `preset ${pi} pid ${pid}: ${err instanceof Error ? err.message : String(err)}`;
            break;
          }
        }
        if (allInBounds) okCount++;
      }
      check(`output-bounds: scene_1..8_main (paramIds 8..15) addressable in ${okCount}/${corpus.length} factory presets`, okCount === corpus.length, firstFail);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
// Section 2c (capture-gated): fn 0x1F reply == image TLV payload,
// byte-for-byte. Pins the 2026-07-16 re-mine decode that REFUTED the
// 2026-06-07 "vector match 0/6" negative (BK-070-DECODE-NOTES.md): the
// Session-103 fn1f-sweep triples were taken with unmodified factory
// A003 "Deluxe Verb" loaded, and every triple's value vector equals
// A003's image TLV payload; the Amp triple equals the factory 234-word
// record + one 32767 appended per 117-word half (the pinned 234→236
// live-layout conversion). This byte-identity is what makes fn 0x1F a
// read oracle for stored block records (the fresh-default capture path).
// ═════════════════════════════════════════════════════════════════════

console.log('\nSection 2c: fn 0x1F byte-identity vs factory A003 (capture-gated)');

{
  const SWEEP_DIR = 'samples/captured/fn1f-sweep';
  const BANK_A = 'samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx';
  if (!existsSync(SWEEP_DIR) || !existsSync(BANK_A)) {
    console.log('  skip  fn1f-sweep captures or Bank A not present');
    skipped++;
  } else {
    const { readdirSync } = await import('node:fs');
    const d14 = (lo: number, hi: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);
    const d16 = (b0: number, b1: number, b2: number) => (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
    const isFn = (f: number[], fn: number) =>
      f.length >= 7 && f[0] === 0xf0 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74 && f[4] === 0x07 && f[5] === fn;
    interface Triple { targetId: number; itemCount: number; values: number[] }
    // Local splitter: Section 3's splitFrames closes over consts that are
    // still TDZ when this capture-gated section runs at module top level.
    function splitFrames2c(bytes: Uint8Array): number[][] {
      const out: number[][] = [];
      let i = 0;
      while (i < bytes.length) {
        if (bytes[i] !== 0xf0) { i++; continue; }
        let j = i + 1;
        while (j < bytes.length && bytes[j] !== 0xf7) j++;
        out.push(Array.from(bytes.slice(i, j + 1)));
        i = j + 1;
      }
      return out;
    }
    function parseTriples(bytes: Uint8Array): Triple[] {
      const out: Triple[] = [];
      let cur: Triple | undefined;
      for (const f of splitFrames2c(bytes)) {
        if (isFn(f, 0x74)) { cur = { targetId: d14(f[6], f[7]), itemCount: d14(f[8], f[9]), values: [] }; out.push(cur); }
        else if (isFn(f, 0x75) && cur) {
          const n = d14(f[6], f[7]);
          for (let i = 0; i < n; i++) {
            const off = 8 + i * 3;
            if (off + 2 >= f.length - 2) break;
            cur.values.push(d16(f[off], f[off + 1], f[off + 2]));
          }
        } else if (isFn(f, 0x76)) cur = undefined;
      }
      return out;
    }
    const sweep = new Map<number, Triple>();
    for (const name of readdirSync(SWEEP_DIR)) {
      if (!name.endsWith('.syx')) continue;
      for (const t of parseTriples(new Uint8Array(readFileSync(`${SWEEP_DIR}/${name}`)))) sweep.set(t.targetId, t);
    }
    const a003 = parsePresetBank(new Uint8Array(readFileSync(BANK_A)))[3];
    const rtA = verifyRoundTripIdentity(a003);
    if (!rtA.ok) {
      console.log(`  skip  factory A003 failed round-trip identity: ${rtA.reason}`);
      skipped++;
    } else {
      const img = parsePresetImage(rtA.words);
      const AMP = 106;
      let compared = 0;
      let identical = 0;
      let ampChecked = false;
      let ampOk = false;
      for (const b of [...img.blocks, ...img.systemTail]) {
        const t = sweep.get(b.wireId);
        if (t === undefined || t.values.length === 0) continue;
        const payload = Array.from(rtA.words.slice(b.baseWord, b.baseWord + b.payloadLen));
        if (b.wireId === AMP) {
          // 234→236: one 32767 appended at the end of each 117-word half.
          ampChecked = true;
          const half = payload.length / 2;
          const expected = [...payload.slice(0, half), 32767, ...payload.slice(half), 32767];
          ampOk = t.values.length === expected.length && expected.every((v, i) => v === t.values[i]);
          continue;
        }
        compared++;
        if (t.values.length === payload.length && payload.every((v, i) => v === t.values[i])) identical++;
      }
      check(`fn1f-identity: ${identical}/${compared} non-amp triples byte-identical to factory A003 TLV payloads`, compared > 0 && identical === compared);
      check('fn1f-identity: amp triple == factory record + 32767 appended per half (234→236 pinned)', ampChecked && ampOk);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
// Section 2d (capture-gated): FRESH_DEFAULT_RECORDS matches the raw
// 2026-07-16 hardware captures byte-exactly, independent of the
// hand-transcribed literals in defaultRecords.ts (catches transcription
// drift), plus the Amp 1/Amp 2 instance-independence finding (differ at
// exactly paramId 9 xformer_grind, mirrored X/Y) and an end-to-end
// insertBlockIntoImage using each record, re-parsed from the resulting
// image bytes back to the source capture.
// ═════════════════════════════════════════════════════════════════════

console.log('\nSection 2d: FRESH_DEFAULT_RECORDS vs raw hardware captures (capture-gated)');

{
  const { insertBlockIntoImage, parseIIImageTlv, findIIImageBlock, parseIIGrid, FRESH_DEFAULT_RECORDS } =
    await import('fractal-midi/gen2/axe-fx-ii');
  const CAPTURES: Array<{ wireId: number; dir: string; file: string }> = [
    { wireId: 106, dir: 'fresh-defaults-r2-2026-07-17-02-12-34', file: 'fresh-106-amp-1.syx' },
    { wireId: 107, dir: 'bk084-hw-mech-2026-07-17-02-07-16', file: 'fresh-107-amp-2.syx' },
    { wireId: 108, dir: 'fresh-defaults-r2-2026-07-17-02-12-34', file: 'fresh-108-cab-1.syx' },
    { wireId: 110, dir: 'fresh-defaults-r2-2026-07-17-02-12-34', file: 'fresh-110-reverb-1.syx' },
    { wireId: 112, dir: 'fresh-defaults-r2-2026-07-17-02-12-34', file: 'fresh-112-delay-1.syx' },
    { wireId: 114, dir: 'fresh-defaults-r2-2026-07-17-02-12-34', file: 'fresh-114-multi-delay-1.syx' },
    { wireId: 130, dir: 'bk084-hw-mech-2026-07-17-02-07-16', file: 'fresh-130-pitch-1.syx' },
    { wireId: 133, dir: 'fresh-defaults-r2-2026-07-17-02-12-34', file: 'fresh-133-drive-1.syx' },
  ];
  const paths = CAPTURES.map((c) => `samples/captured/${c.dir}/${c.file}`);
  if (!paths.every((p) => existsSync(p))) {
    console.log('  skip  one or more bk084-hw-mech / fresh-defaults-r2 captures not present');
    skipped++;
  } else {
    const d14 = (lo: number, hi: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);
    const d16 = (b0: number, b1: number, b2: number) => (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
    function decodeFn1fCapture(bytes: Uint8Array): number[] {
      const frames: number[][] = [];
      let cur: number[] | undefined;
      for (const b of bytes) {
        if (b === 0xf0) cur = [b];
        else if (cur !== undefined) { cur.push(b); if (b === 0xf7) { frames.push(cur); cur = undefined; } }
      }
      const values: number[] = [];
      let seenHeader = false;
      for (const f of frames) {
        if (f[5] === 0x74) seenHeader = true;
        else if (f[5] === 0x75 && seenHeader) {
          const n = d14(f[6], f[7]);
          for (let i = 0; i < n; i++) {
            const off = 8 + i * 3;
            if (off + 2 >= f.length - 2) break;
            values.push(d16(f[off], f[off + 1], f[off + 2]));
          }
        }
      }
      return values;
    }

    let identical = 0;
    const decoded = new Map<number, number[]>();
    for (const c of CAPTURES) {
      const raw = decodeFn1fCapture(new Uint8Array(readFileSync(`samples/captured/${c.dir}/${c.file}`)));
      decoded.set(c.wireId, raw);
      const table = FRESH_DEFAULT_RECORDS[c.wireId];
      const matches = table !== undefined && table.payload.length === raw.length && table.payload.every((v: number, i: number) => v === raw[i]);
      if (matches) identical++;
      else console.log(`  FAIL  wireId ${c.wireId}: table/capture mismatch (table len ${table?.payload.length}, capture len ${raw.length})`);
    }
    check(`FRESH_DEFAULT_RECORDS: ${identical}/${CAPTURES.length} entries byte-identical to their raw capture`, identical === CAPTURES.length);

    const amp1 = decoded.get(106)!;
    const amp2 = decoded.get(107)!;
    const diffIdx = amp1.map((v, i) => (v !== amp2[i] ? i : -1)).filter((i) => i >= 0);
    check(
      'Amp instance-independence: fresh Amp 1 vs Amp 2 differ at exactly paramId 9 (indices 9 and 127, mirrored X/Y)',
      diffIdx.length === 2 && diffIdx[0] === 9 && diffIdx[1] === 127,
      `diff indices: ${JSON.stringify(diffIdx)}`,
    );

    // End-to-end: insertBlockIntoImage using the registered default for
    // each family re-parses back to the exact captured payload.
    const { II_IMAGE_FORMAT_TAG, gridCellWordIndex, validateIIGridInvariants } =
      await import('fractal-midi/gen2/axe-fx-ii');
    let insertOk = 0;
    let gridOk = 0;
    const TLV_CHAIN_START = 130; // II_TLV_CHAIN_START
    for (const c of CAPTURES) {
      // Build a minimal image: format tag set, one shunt cell at (1,1)
      // for the insert target, and a single system-tail anchor block
      // (140 Output, off-grid) so insertBlockIntoImage's alphabetical-
      // position search has a tail word to fall back to (an image with
      // zero blocks anywhere has no anchor and is not a real preset shape).
      const words = new Uint16Array(4096);
      const reserved = new Uint8Array(4096);
      words[0] = II_IMAGE_FORMAT_TAG;
      words[gridCellWordIndex(1, 1)] = 200; // shunt id
      words[TLV_CHAIN_START] = 140; // Output (system tail, not on the grid)
      words[TLV_CHAIN_START + 1] = 20; // payloadLen (factory/live census)
      // terminator at TLV_CHAIN_START + 2 + 20 = 152, already zero
      const image = { words, reserved };
      const result = insertBlockIntoImage(image, { wireId: c.wireId, gridCell: { col: 1, row: 1 } });
      if (!result.ok) { console.log(`  FAIL  wireId ${c.wireId}: insertBlockIntoImage refused: ${result.reason}`); continue; }
      const tlv = parseIIImageTlv(result.image.words);
      const block = findIIImageBlock(tlv, c.wireId);
      if (block === undefined) { console.log(`  FAIL  wireId ${c.wireId}: not found post-insert`); continue; }
      const payload = Array.from(result.image.words.slice(block.baseWord, block.baseWord + block.payloadLen));
      const raw = decoded.get(c.wireId)!;
      if (payload.length === raw.length && payload.every((v, i) => v === raw[i])) insertOk++;
      else console.log(`  FAIL  wireId ${c.wireId}: post-insert payload diverges from capture`);
      const cells = parseIIGrid(result.image.words);
      const violations = validateIIGridInvariants(cells, tlv.blocks.map((b: { wireId: number }) => b.wireId));
      if (violations.length === 0) gridOk++;
      else console.log(`  FAIL  wireId ${c.wireId}: grid violations post-insert: ${violations.join('; ')}`);
    }
    check(`insertBlockIntoImage: ${insertOk}/${CAPTURES.length} FRESH_DEFAULT_RECORDS inserts round-trip to the exact capture`, insertOk === CAPTURES.length);
    check(`insertBlockIntoImage: ${gridOk}/${CAPTURES.length} inserts leave the grid invariant-clean`, gridOk === CAPTURES.length);
  }
}

// ═════════════════════════════════════════════════════════════════════
// Section 3: offline fake-conn wire orchestration (always runs)
// ═════════════════════════════════════════════════════════════════════

console.log('\nSection 3: fake-conn wire orchestration (readPresetImageSnapshot + applyContinuousParamsAtomicII)');

const F0 = 0xf0;
const F7 = 0xf7;
const MFR = [0x00, 0x01, 0x74];
const MODEL = 0x07;

function cksum(headFromF0: number[]): number {
  return headFromF0.slice(1).reduce((a, b) => a ^ b, 0) & 0x7f;
}
function frame(payloadAfterModel: number[]): number[] {
  const head = [F0, ...MFR, MODEL, ...payloadAfterModel];
  return [...head, cksum(head), F7];
}

/** Split a flat .syx byte stream into its component F0..F7 frames. */
function splitFrames(bytes: Uint8Array): number[][] {
  const out: number[][] = [];
  let i = 0;
  while (i < bytes.length) {
    if (bytes[i] !== F0) { i++; continue; }
    let j = i + 1;
    while (j < bytes.length && bytes[j] !== F7) j++;
    out.push(Array.from(bytes.slice(i, j + 1)));
    i = j + 1;
  }
  return out;
}

interface FakeConnScript {
  /** Called for every outbound send(); returns reply frames (possibly empty) or 'no-reply'. */
  onSend: (bytes: number[]) => number[][];
}

function makeFakeConn(script: FakeConnScript): MidiConnection {
  const handlers = new Set<(bytes: number[]) => void>();
  const sent: number[][] = [];
  function dispatch(frames: number[][]): void {
    if (frames.length === 0) return;
    setImmediate(() => {
      for (const f of frames) for (const h of [...handlers]) { try { h(f); } catch { /* swallow */ } }
    });
  }
  return {
    send: (bytes) => { sent.push(bytes); dispatch(script.onSend(bytes)); },
    receiveSysEx: () => Promise.reject(new Error('receiveSysEx not used')),
    receiveSysExMatching: (predicate, timeoutMs = 800) =>
      new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => { handlers.delete(handler); reject(new Error(`fake conn: no response within ${timeoutMs}ms`)); }, timeoutMs);
        const handler = (b: number[]) => {
          if (b[0] !== F0 || !predicate(b)) return;
          clearTimeout(timer);
          handlers.delete(handler);
          resolve(b);
        };
        handlers.add(handler);
      }),
    onMessage: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    hasInput: true,
    close: () => { handlers.clear(); },
  } as MidiConnection;
}

function makeCtx(conn: MidiConnection): DispatchCtx {
  return {
    conn,
    descriptor: AXEFX2_DESCRIPTOR,
    reconnect: async () => conn,
  } as unknown as DispatchCtx;
}

async function section3(): Promise<void> {
  // ── 3a: fast-fail when the transport never answers fn=0x03 ──
  {
    const conn = makeFakeConn({ onSend: () => [] });
    const started = Date.now();
    const result = await readPresetImageSnapshot(makeCtx(conn));
    const elapsedMs = Date.now() - started;
    check('fast-fail: readPresetImageSnapshot refuses when the transport never answers', !result.ok);
    check(
      `fast-fail: refusal lands well under the 5s general PATCH_DUMP ceiling (took ${elapsedMs}ms)`,
      elapsedMs < 3000,
    );
  }

  // ── 3b: successful decode from a synthesized 66-frame reply ──
  {
    const words = buildSyntheticWords();
    const dumpBytes = buildSyntheticDumpBytes(words);
    const conn = makeFakeConn({
      onSend: (bytes) => {
        // Any fn=0x03 request → reply with the synthetic dump's 66 frames.
        if (bytes[5] === 0x03) return splitFrames(dumpBytes);
        return [];
      },
    });
    const result = await readPresetImageSnapshot(makeCtx(conn));
    check('decode: readPresetImageSnapshot succeeds against a synthesized dump reply', result.ok, !result.ok ? result.reason : '');
    if (result.ok) {
      check('decode: preset name decodes correctly', result.name === 'PATCH GOLD', result.name);
      const amp = result.blockParams.get(AMP_WIRE_ID);
      check('decode: Amp block is present in blockParams', amp !== undefined);
      if (amp !== undefined) {
        const kind = resolveParamKind('axe-fx-ii', 'amp', 'bass');
        const expectedDisplay = kind.decodeWire!(30000);
        check(
          'decode: amp.bass X decodes to the same display value the codec would compute for wire 30000',
          amp.x.bass === expectedDisplay,
          `got ${amp.x.bass}, expected ${expectedDisplay}`,
        );
      }
    }
  }

  // ── 3c: applyContinuousParamsAtomicII, clean end-to-end success ──
  {
    const words = buildSyntheticWords();
    const dumpBytes = buildSyntheticDumpBytes(words);
    let currentDump = dumpBytes;
    const conn = makeFakeConn({
      onSend: (bytes) => {
        const fn = bytes[5];
        if (fn === 0x03) return splitFrames(currentDump); // dump / read-back-verify dump
        if (fn === 0x77 || fn === 0x78 || fn === 0x79) {
          // Push: accumulate frames, and once we see the footer, treat the
          // LAST full push as "what the device now holds" so the read-back
          // verify sees the patched bytes. We don't have the caller's frame
          // stream directly, so instead just adopt whatever the patch step
          // produced (available via closure below); simplification: the
          // orchestration always dumps BEFORE pushing, so `currentDump` is
          // updated by the patch call inside applyContinuousParamsAtomicII
          // itself is not observable here; instead we reconstruct the pushed
          // bytes are the SAME frames being sent now.
          return []; // no ack frames for the raw push; ok=true relies on absence of NACK
        }
        if (fn === 0x1d) {
          // STORE_PRESET ack: fn=0x64 multi-purpose response, result 0x00.
          return [frame([0x64, 0x1d, 0x00])];
        }
        if (fn === 0x14) {
          // GET_PRESET_NUMBER (used for the default target_location resolve).
          return [frame([0x14, 0x00, 0x00])];
        }
        return [];
      },
    });
    // Adopt the pushed bytes as the device's new state so the read-back
    // verify observes the patch. We intercept by wrapping send() to also
    // capture 0x77/0x78/0x79 frames and reassemble them.
    const pushed: number[][] = [];
    const rawSend = conn.send.bind(conn);
    conn.send = (bytes: number[]) => {
      if (bytes[5] === 0x77 || bytes[5] === 0x78 || bytes[5] === 0x79) {
        pushed.push(bytes);
        if (bytes[5] === 0x79) {
          const flat: number[] = [];
          for (const f of pushed) for (const b of f) flat.push(b);
          currentDump = Uint8Array.from(flat);
          pushed.length = 0;
        }
      }
      rawSend(bytes);
    };

    const patches: ContinuousParamPatchInput[] = [
      { block: AMP_WIRE_ID, paramName: 'bass', channel: 'X', displayValue: 8.0 },
    ];
    const outcome = await applyContinuousParamsAtomicII(makeCtx(conn), patches, { save_authorized: true, target_location: 3 });
    check('atomic-apply: clean pipeline reaches stage "done"', outcome.stage === 'done', JSON.stringify(outcome));
    check('atomic-apply: ok === true', outcome.ok === true);
    check('atomic-apply: saved_to_location === 3', outcome.saved_to_location === 3, String(outcome.saved_to_location));
    check('atomic-apply: 1 applied patch reported', outcome.applied.length === 1);
  }

  // ── 3d: NACK-abort, push rejected, refuses before verify/STORE ──
  {
    const words = buildSyntheticWords();
    const dumpBytes = buildSyntheticDumpBytes(words);
    let storeAttempted = false;
    const conn = makeFakeConn({
      onSend: (bytes) => {
        const fn = bytes[5];
        if (fn === 0x03) return splitFrames(dumpBytes);
        if (fn === 0x79) return [frame([0x64, 0x79, 0x05])]; // NACK on the footer frame
        if (fn === 0x1d) { storeAttempted = true; return [frame([0x64, 0x1d, 0x00])]; }
        return [];
      },
    });
    const patches: ContinuousParamPatchInput[] = [
      { block: AMP_WIRE_ID, paramName: 'bass', channel: 'X', displayValue: 8.0 },
    ];
    const outcome = await applyContinuousParamsAtomicII(makeCtx(conn), patches, { save_authorized: true, target_location: 3 });
    check('atomic-apply: NACKed push aborts at stage "push"', outcome.stage === 'push' && outcome.ok === false, JSON.stringify(outcome));
    check('atomic-apply: NACKed push never attempts STORE', !storeAttempted);
  }

  // ── 3e: read-back mismatch, refuses STORE even though the push acked ──
  {
    const words = buildSyntheticWords();
    const dumpBytes = buildSyntheticDumpBytes(words);
    let dumpCallCount = 0;
    let storeAttempted = false;
    const conn = makeFakeConn({
      onSend: (bytes) => {
        const fn = bytes[5];
        if (fn === 0x03) {
          dumpCallCount++;
          // First dump (pre-patch read) → real bytes. Second dump (post-push
          // read-back verify) → return the UNMODIFIED source, simulating a
          // push that silently didn't land (device-side no-op / mis-push).
          return splitFrames(dumpCallCount === 1 ? dumpBytes : dumpBytes);
        }
        if (fn === 0x1d) { storeAttempted = true; return [frame([0x64, 0x1d, 0x00])]; }
        return []; // push acks nothing but no NACK either (ok:true; pushResult.ok checks nacks only)
      },
    });
    const patches: ContinuousParamPatchInput[] = [
      { block: AMP_WIRE_ID, paramName: 'bass', channel: 'X', displayValue: 8.0 },
    ];
    const outcome = await applyContinuousParamsAtomicII(makeCtx(conn), patches, { save_authorized: true, target_location: 3 });
    check('atomic-apply: read-back mismatch (device didn\'t apply the push) refuses at stage "verify"', outcome.stage === 'verify' && outcome.ok === false, JSON.stringify(outcome));
    check('atomic-apply: read-back mismatch never attempts STORE', !storeAttempted);
  }
}

await section3();

console.log(`\n${pass} ok, ${fail} fail, ${skipped} skipped.`);
if (fail > 0) process.exit(1);
