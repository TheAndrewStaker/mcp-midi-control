/**
 * BK-084 mode-collapse goldens: `writer.setParams`' internal atomic
 * dump/patch/push/verify path (formerly `writer.applyPresetRetune`, apply_
 * preset mode:'retune' — see the design doc, MODE-COLLAPSE-DESIGN-2026-07-
 * 18.md). Adapted from the retired `verify-ii-retune-apply.ts`: same
 * proven stateful fake device (answers grid read fn 0x20, scene fn 0x29,
 * channel fn 0x11, edit-buffer dump fn 0x03 -> 66 frames, push adoption
 * 0x77/0x78/0x79, STORE ack fn 0x1D), now driving `writer.setParams(ctx,
 * ops)` — set_params' actual flat-ops shape — instead of a whole
 * PresetSpec through a caller-visible mode.
 *
 * Dropped relative to the retired file (do not apply to set_params):
 *   - the save-leg case: set_params never saves.
 *   - the scene re-assert case: set_params has no landingScene/navigation
 *     concept to drift from.
 *   - the streamed-fallback channel-WINDOW dance: that was retuneApply's
 *     own bespoke fallback; set_params' fallback is the plain, pre-
 *     existing writer.setParam(...) call, which already REFUSES on a
 *     channel mismatch rather than negotiating a window (set_params'
 *     pre-existing, unchanged contract for every op, atomic or not).
 *
 * New relative to the retired file (set_params' `refusePartial: false`
 * contract, vs retune's all-or-nothing):
 *   - a per-entry patch refusal (e.g. an odd-payload Y-channel write)
 *     no longer refuses the WHOLE batch; the other ops in the same batch
 *     still land atomically, and only the refused op's WriteResult comes
 *     back acked:false.
 *   - a block absent from the dump's TLV chain is likewise a per-entry
 *     refusal, not a pre-flight gate (set_params has no grid-read gate;
 *     the image-patch pipeline's own refusal covers it).
 *
 * Offline, fake-conn, no hardware.
 */

// Import-time side effect: registers the Axe-Fx II param-kind resolver.
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
void AXEFX2_DESCRIPTOR;

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { resolveParamKind } from '@mcp-midi-control/core/protocol-generic/paramKind.js';

import { writer } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';
import {
  serializePresetDump,
  CHUNKS_PER_PRESET,
} from '@mcp-midi-control/fractal-gen2/presetDump.js';
import {
  PRESET_IMAGE_WORDS,
  PRESET_IMAGE_FORMAT_TAG,
  TLV_CHAIN_START,
  MODIFIER_PAYLOAD_LEN,
} from '@mcp-midi-control/fractal-gen2/presetImageTlv.js';
import { buildSetBlockParameterValue } from 'fractal-midi/gen2/axe-fx-ii';

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok    ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ': ' + detail : ''}`);
    fail++;
  }
}

const F0 = 0xf0;
const F7 = 0xf7;
const MFR = [0x00, 0x01, 0x74];
const MODEL = 0x07;
const AMP_ID = 106;
const CAB_ID = 108;
const VOLPAN_ID = 127;
const OUTPUT_ID = 140;

function cksum(headFromF0: number[]): number {
  return headFromF0.slice(1).reduce((a, b) => a ^ b, 0) & 0x7f;
}
function frame(payloadAfterModel: number[]): number[] {
  const head = [F0, ...MFR, MODEL, ...payloadAfterModel];
  return [...head, cksum(head), F7];
}
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

// ── Synthetic image (mirrors verify-ii-image-continuous-apply.ts) ──
function buildSyntheticWords(): Uint16Array {
  const w = new Uint16Array(PRESET_IMAGE_WORDS);
  w[0] = PRESET_IMAGE_FORMAT_TAG;
  const name = 'SETPARAMS GOLD';
  for (let i = 0; i < name.length; i++) w[2 + i] = name.charCodeAt(i);
  let i = TLV_CHAIN_START;
  w[i] = 3; w[i + 1] = MODIFIER_PAYLOAD_LEN;
  i += 2 + MODIFIER_PAYLOAD_LEN;
  w[i] = AMP_ID; w[i + 1] = 236;
  w[i + 2 + 0] = 42;      // amp X effect_type ordinal
  w[i + 2 + 2] = 30000;   // amp.bass X
  i += 2 + 236;
  w[i] = CAB_ID; w[i + 1] = 78;
  i += 2 + 78;
  w[i] = VOLPAN_ID; w[i + 1] = 9; // odd payload, single-channel
  i += 2 + 9;
  w[i] = 139; w[i + 1] = 8; i += 2 + 8;
  w[i] = OUTPUT_ID; w[i + 1] = 20; i += 2 + 20;
  w[i] = 141; w[i + 1] = 96; i += 2 + 96;
  return w;
}
function encodeChunkPayload(words: Uint16Array, chunkIdx: number): Uint8Array {
  const p = new Uint8Array(194);
  p[0] = 0x40; p[1] = 0x00;
  for (let k = 0; k < 64; k++) {
    const v = words[chunkIdx * 64 + k];
    const o = 2 + k * 3;
    p[o] = v & 0x7f;
    p[o + 1] = (v >> 7) & 0x7f;
    p[o + 2] = (v >> 14) & 0x03;
  }
  return p;
}
function buildDumpBytes(words: Uint16Array): Uint8Array {
  const chunkPayloads: Uint8Array[] = [];
  for (let c = 0; c < CHUNKS_PER_PRESET; c++) chunkPayloads.push(encodeChunkPayload(words, c));
  let hash = 0;
  for (const w of words) hash ^= (w & 0xffff);
  hash &= 0xffff;
  const footerPayload = new Uint8Array([hash & 0x7f, (hash >> 7) & 0x7f, (hash >> 14) & 0x03]);
  const headerPayload = new Uint8Array([0, 0, 0, 0x20]);
  return serializePresetDump({ raw: new Uint8Array(0), headerPayload, chunkPayloads, footerPayload });
}

function gridResponse(placedIds: number[]): number[] {
  const cells: number[] = [];
  for (let idx = 0; idx < 48; idx++) {
    const id = idx < placedIds.length ? placedIds[idx] : 0;
    cells.push(id & 0x7f, (id >> 7) & 0x7f, id !== 0 ? 1 : 0, 0);
  }
  return frame([0x20, ...cells]);
}

interface FakeDeviceOpts {
  dumpWords?: Uint16Array;
  dumpSequence?: (Uint8Array | 'silent')[];
  nackPushNumber?: number;
  placedGridIds?: number[];
}
function makeFakeDevice(opts: FakeDeviceOpts = {}) {
  const state = {
    channels: new Map<number, number>(),
    dumpCalls: 0,
    pushStreams: [] as number[][][],
    currentPush: [] as number[][],
    pushCount: 0,
    sent: [] as number[][],
    adoptedDump: undefined as Uint8Array | undefined,
  };
  const dumpWords = opts.dumpWords ?? buildSyntheticWords();
  const baseDump = buildDumpBytes(dumpWords);

  const handlers = new Set<(bytes: number[]) => void>();
  function dispatch(frames: number[][]): void {
    if (frames.length === 0) return;
    setImmediate(() => {
      for (const f of frames) for (const h of [...handlers]) { try { h(f); } catch { /* swallow */ } }
    });
  }

  function onSend(bytes: number[]): number[][] {
    const fn = bytes[5];
    if (fn === 0x03) {
      state.dumpCalls++;
      const seq = opts.dumpSequence;
      let d: Uint8Array | 'silent' | undefined;
      if (seq !== undefined) d = seq[Math.min(state.dumpCalls - 1, seq.length - 1)];
      else d = state.adoptedDump ?? baseDump;
      if (d === 'silent') return [];
      if (d === undefined) d = state.adoptedDump ?? baseDump;
      return splitFrames(d);
    }
    if (fn === 0x77 || fn === 0x78 || fn === 0x79) {
      state.currentPush.push(bytes);
      if (fn === 0x79) {
        state.pushCount++;
        state.pushStreams.push(state.currentPush);
        const flat: number[] = [];
        for (const f of state.currentPush) for (const b of f) flat.push(b);
        state.adoptedDump = Uint8Array.from(flat);
        state.currentPush = [];
        if (opts.nackPushNumber === state.pushCount) {
          return [frame([0x64, 0x79, 0x05])];
        }
      }
      return [];
    }
    if (fn === 0x20) return [gridResponse(opts.placedGridIds ?? [AMP_ID, CAB_ID, VOLPAN_ID])];
    if (fn === 0x11) {
      const effId = (bytes[6] & 0x7f) | ((bytes[7] & 0x7f) << 7);
      if (bytes[9] === 1) {
        state.channels.set(effId, bytes[8] & 0x7f);
        return [];
      }
      return [frame([0x11, bytes[6], bytes[7], state.channels.get(effId) ?? 0])];
    }
    if (fn === 0x1d) return [frame([0x64, 0x1d, 0x00])];
    return [];
  }

  const conn: MidiConnection = {
    send: (bytes: number[]) => { state.sent.push([...bytes]); dispatch(onSend(bytes)); },
    receiveSysEx: () => Promise.reject(new Error('receiveSysEx not used')),
    receiveSysExMatching: (predicate: (b: number[]) => boolean, timeoutMs = 800) =>
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
    onMessage: (handler: (bytes: number[]) => void) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    hasInput: true,
    close: () => { handlers.clear(); },
  } as MidiConnection;

  const ctx = { conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => conn } as unknown as DispatchCtx;
  return { ctx, state, baseDump, dumpWords };
}

const isFn = (fn: number) => (b: number[]) => b[0] === F0 && b[5] === fn;
const septet = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
function isParamWrite(b: number[], fn: number, effectId: number, paramId?: number): boolean {
  if (b[0] !== F0 || b[5] !== fn) return false;
  const [elo, ehi] = septet(effectId);
  if (b[6] !== elo || b[7] !== ehi) return false;
  if (paramId === undefined) return true;
  const [plo, phi] = septet(paramId);
  return b[8] === plo && b[9] === phi;
}
const MUTE_REF = buildSetBlockParameterValue({ effectId: OUTPUT_ID, paramId: 0 }, -80, { modelId: MODEL });
function isMuteFrame(b: number[]): boolean {
  return b[0] === F0 && b[5] === MUTE_REF[5] && b[6] === MUTE_REF[6] && b[7] === MUTE_REF[7]
    && b[8] === MUTE_REF[8] && b[9] === MUTE_REF[9];
}

/** Wire-encode a display value the same way the dispatcher's encodeValue would, for a direct writer.setParams(ctx, ops) call. */
function wireFor(block: string, name: string, display: number): number {
  const kind = resolveParamKind('axe-fx-ii', block, name);
  return kind.encodeDisplay !== undefined ? Math.round(kind.encodeDisplay(display)) : display;
}

interface Op { block: string; name: string; value: number; channel?: string | number; instance?: number }
function op(block: string, name: string, display: number, channel?: string): Op {
  return { block, name, value: wireFor(block, name, display), ...(channel !== undefined ? { channel } : {}) };
}

// A 4-op batch (== SET_PARAMS_ATOMIC_THRESHOLD) of distinct calibrated
// continuous amp knobs so the atomic path is definitely in play. Exact
// canonical names (bass/treble/middle/level) — resolveParamKind does NOT
// fuzzy-match, unlike findParamFuzzy inside the writer, so this test's
// direct wireFor() calls need the precise registered spelling.
function fourAmpKnobOps(): Op[] {
  return [
    op('amp', 'bass', 6.0),
    op('amp', 'treble', 5.5),
    op('amp', 'middle', 4.5),
    op('amp', 'level', 7.0),
  ];
}

async function main(): Promise<void> {
  console.log('verify-set-params-atomic: writer.setParams internal atomic image path');
  const setParams = writer.setParams;
  check('writer.setParams is registered on the XL+ writer', setParams !== undefined);
  if (setParams === undefined) return;

  // ── (a) clean pipeline: a 4-op continuous batch lands atomically ──
  {
    const dev = makeFakeDevice();
    const r = await setParams(dev.ctx, fourAmpKnobOps());
    check('(a) clean batch: acked_count === 4', r.acked_count === 4, JSON.stringify(r).slice(0, 300));
    check('(a) apply_path === preset-image', r.apply_path === 'preset-image', r.apply_path);
    check('(a) receipt === word-exact', r.receipt === 'word-exact', r.receipt);
    check('(a) push_attempts === 1', r.push_attempts === 1, String(r.push_attempts));
    check('(a) exactly one push stream of 66 frames', dev.state.pushStreams.length === 1 && dev.state.pushStreams[0].length === 66);
    check('(c) zero mute frames (fn 0x2e effectId=140 paramId=0)', !dev.state.sent.some(isMuteFrame));
    check('(a) every write acked:true', r.writes.every((w) => w.acked === true), JSON.stringify(r.writes));
  }

  // ── (b) below threshold: byte-identical to today's individual streaming ──
  {
    const dev = makeFakeDevice();
    const r = await setParams(dev.ctx, [op('amp', 'bass', 6.0), op('amp', 'treble', 5.0)]);
    check('(b) 2-op batch (below threshold): acked_count === 2', r.acked_count === 2);
    check('(b) apply_path is undefined (atomic path never attempted)', r.apply_path === undefined, r.apply_path);
    check('(b) no dump was ever sent', !dev.state.sent.some(isFn(0x03)));
    const streamWrites = dev.state.sent.filter((b) => isParamWrite(b, 0x2e, AMP_ID));
    check('(b) both knobs streamed individually via fn 0x2e', streamWrites.length === 2, String(streamWrites.length));
  }

  // ── (c) enum + 4 continuous knobs: enum leg lands BEFORE the dump ──
  {
    const dev = makeFakeDevice();
    const ops = [op('amp', 'effect_type', 3), ...fourAmpKnobOps()];
    const r = await setParams(dev.ctx, ops);
    check('(c) mixed enum+knob batch: acked_count === 5', r.acked_count === 5, JSON.stringify(r).slice(0, 300));
    const sent = dev.state.sent;
    const enumIdx = sent.findIndex((b) => isParamWrite(b, 0x02, AMP_ID, 0));
    const dumpIdx = sent.findIndex(isFn(0x03));
    check('(c) fn 0x02 enum frame exists', enumIdx >= 0);
    check('(c) enum frame lands BEFORE the dump request', enumIdx >= 0 && dumpIdx > enumIdx, `enum@${enumIdx} dump@${dumpIdx}`);
  }

  // ── (d) push-NACK -> probe (neither) -> recovery -> fallback: the WHOLE atomic leg streams instead ──
  {
    const altWords = buildSyntheticWords();
    altWords[TLV_CHAIN_START + 2 + MODIFIER_PAYLOAD_LEN + 2 + 5] = 12345;
    const base = buildDumpBytes(buildSyntheticWords());
    const alt = buildDumpBytes(altWords);
    const dev = makeFakeDevice({ nackPushNumber: 1, dumpSequence: [base, alt, base] });
    const r = await setParams(dev.ctx, fourAmpKnobOps());
    check('(d) NACK+recovery batch: acked_count === 4 (fallback served all 4)', r.acked_count === 4, JSON.stringify(r).slice(0, 400));
    check('(d) apply_path === per-param-stream (proven-safe fallback streamed everything)', r.apply_path === 'per-param-stream', r.apply_path);
    check('(d) image_apply_fallback_reason is populated', typeof r.image_apply_fallback_reason === 'string' && r.image_apply_fallback_reason.length > 0, r.image_apply_fallback_reason);
    check('(d) two push streams went out (patched push + recovery push)', dev.state.pushStreams.length === 2);
    const streamWrites = dev.state.sent.filter((b) => isParamWrite(b, 0x2e, AMP_ID));
    check('(d) all 4 knobs streamed individually via fn 0x2e after the fallback', streamWrites.length === 4, String(streamWrites.length));
  }

  // ── (e) dump fast-fail -> the whole atomic leg streams instead, bounded latency ──
  {
    const dev = makeFakeDevice({ dumpSequence: ['silent'] });
    const started = Date.now();
    const r = await setParams(dev.ctx, fourAmpKnobOps());
    const elapsed = Date.now() - started;
    check('(e) dump-silent batch: acked_count === 4 (fallback served all 4)', r.acked_count === 4, JSON.stringify(r).slice(0, 300));
    check('(e) apply_path === per-param-stream (dump never landed, fell back)', r.apply_path === 'per-param-stream', r.apply_path);
    check('(e) image_apply_fallback_reason names the dump failure', (r.image_apply_fallback_reason ?? '').includes('dump'), r.image_apply_fallback_reason);
    check(`(e) fast-fail latency bounded (~900 ms two-phase timeout; took ${elapsed} ms)`, elapsed < 3000);
    check('(e) zero push frames were sent', dev.state.pushStreams.length === 0);
  }

  // ── (f) per-entry refusal (odd-payload Y-channel write) tolerates the REST of the batch ──
  {
    const dev = makeFakeDevice();
    const ops = [
      ...fourAmpKnobOps(),
      { block: 'volpan', name: 'volume', value: wireFor('volpan', 'volume', 5.0), channel: 'Y' },
    ];
    const r = await setParams(dev.ctx, ops as Op[]);
    check('(f) 4 amp knobs still land atomically despite the 5th entry refusing', r.acked_count === 4, JSON.stringify(r).slice(0, 400));
    check('(f) exactly 1 unacked (the refused Y-on-odd-payload write)', r.unacked_count === 1, String(r.unacked_count));
    check('(f) apply_path === preset-image (the atomic leg still ran for the eligible entries)', r.apply_path === 'preset-image', r.apply_path);
    const refused = r.writes.find((w) => w.acked === false);
    check('(f) the refused write names the odd-payload reason', (refused?.warning ?? '').includes('odd payload'), refused?.warning);
  }

  // ── (+) a block absent from the dump's TLV chain is a per-entry refusal, not a whole-batch gate ──
  {
    const dev = makeFakeDevice({ placedGridIds: [AMP_ID, CAB_ID, VOLPAN_ID] }); // no Reverb in the synthetic image
    const ops = [...fourAmpKnobOps(), op('reverb', 'mix', 30)];
    const r = await setParams(dev.ctx, ops);
    check('(+) 4 amp knobs still land atomically', r.acked_count === 4, JSON.stringify(r).slice(0, 400));
    check('(+) the unplaced reverb write refuses individually (per-entry), not the whole batch', r.unacked_count === 1, String(r.unacked_count));
  }

  // ── (g) duplicate (block, param, channel) within one batch: neither index silently drops ──
  //
  // Regression guard for a bug the 2026-07-18 Sonnet review caught: the
  // original applied[]-matching keyed by name ONLY (no queue), so a later
  // duplicate's index overwrote an earlier one's in the lookup map, and
  // the earlier op's WriteResult was never populated (undefined in
  // writes[], uncounted in either acked_count or unacked_count).
  {
    const dev = makeFakeDevice();
    const ops = [
      ...fourAmpKnobOps(),
      op('amp', 'bass', 3.0), // duplicate of fourAmpKnobOps()'s amp.bass=6.0, different value
    ];
    const r = await setParams(dev.ctx, ops);
    check('(g) all 5 ops (incl. both amp.bass duplicates) get a result, none silently dropped', r.writes.length === 5 && r.writes.every((w) => w !== undefined), JSON.stringify(r.writes));
    check('(g) acked_count === 5 (both duplicates landed; last-write-wins on the SAME image word, same as the individual-write path)', r.acked_count === 5, `acked=${r.acked_count} unacked=${r.unacked_count}`);
    const bassWrites = r.writes.filter((w) => w.name === 'bass');
    check('(g) both amp.bass entries report acked:true (first, then the duplicate)', bassWrites.length === 2 && bassWrites.every((w) => w.acked === true), JSON.stringify(bassWrites));
  }
}

await main();

console.log(`\n${pass} ok, ${fail} fail.`);
if (fail > 0) process.exit(1);
