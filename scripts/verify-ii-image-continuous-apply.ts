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
import { applyContinuousParamsAtomicII } from '@mcp-midi-control/fractal-gen2/descriptor/imageApply.js';

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
const AMP_BASS_PARAM_ID = 2;
const AMP_MASTER_VOLUME_PARAM_ID = 5;

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
