/**
 * Word-for-word compare of a gen-3 preset SENT to the edit buffer against the
 * dump READ BACK from it, allowing only the Amp words the unit recalculates
 * when it loads an amp model.
 *
 * Mirrors fractone (GreyManSoftware, MIT) Fm9PresetWriteVerifier
 * .VerifyImportedBody, reimplemented: same format version + preset name; the
 * decompressed bodies are equal, or else equal in length, grid and record
 * layout, and every differing 16-bit word lies on an allowed Amp parameter of
 * an Amp record (any channel row). Anything else means the unit did not take
 * the preset as sent (a dropped load, a stale buffer, a rewrite on import).
 *
 * The allowlist is by parameter SYMBOL, mapped to each device's own paramId
 * (gen-3 paramIds are device-specific). The ids here equal each device's
 * catalog paramId for the symbol (asserted by the verify script), and a
 * record's param id n on channel row r is at record word 17 + r*cols + n (the
 * record word convention in presetModifiers.ts).
 *
 * EVIDENCE per device:
 *  - FM9: all eleven words hardware-proven by fractone on FM9 fw 12 (a
 *    from-scratch Amp came back with CFGRID / GRIDHARDNESS / CFHARDNESS
 *    recalculated; the eight model-dependent words seen on the Ride template).
 *  - FM3 / Axe-Fx III: UNVERIFIED. fractone's own device profiles list the
 *    three hardness words as recalculated and "assume" the other eight until
 *    a probe run confirms them. A mismatch on these devices may be a word the
 *    unit recalculates that is not listed here.
 */
import { decodeRawPatch } from './presetHuffman.js';
import type { ParsedPresetDump } from './presetDump.js';
import { decodeGen3Body } from './presetBody.js';
import { findRecordWalkStart, RECORD_SIGNATURE_GAP } from './presetModifiers.js';

const MODEL_AXE_FX_III = 0x10;
const MODEL_FM3 = 0x11;
const MODEL_FM9 = 0x12;

/** Amp words a gen-3 unit may recalculate on load: symbol -> paramId per model. */
export const AMP_RECALCULATED_WORDS: ReadonlyArray<{
  symbol: string;
  ids: Readonly<Record<number, number>>;
}> = [
  { symbol: 'DISTORT_OFFSET1', ids: { [MODEL_FM9]: 27, [MODEL_FM3]: 23, [MODEL_AXE_FX_III]: 17 } },
  { symbol: 'DISTORT_WSHPF', ids: { [MODEL_FM9]: 38, [MODEL_FM3]: 34, [MODEL_AXE_FX_III]: 32 } },
  { symbol: 'DISTORT_FBTYPE', ids: { [MODEL_FM9]: 43, [MODEL_FM3]: 39, [MODEL_AXE_FX_III]: 37 } },
  { symbol: 'DISTORT_PI_RATIO', ids: { [MODEL_FM9]: 44, [MODEL_FM3]: 40, [MODEL_AXE_FX_III]: 38 } },
  { symbol: 'DISTORT_EXCURSIONTIME', ids: { [MODEL_FM9]: 70, [MODEL_FM3]: 66, [MODEL_AXE_FX_III]: 64 } },
  { symbol: 'DISTORT_RECOVERYTIME', ids: { [MODEL_FM9]: 71, [MODEL_FM3]: 67, [MODEL_AXE_FX_III]: 65 } },
  { symbol: 'DISTORT_TRIODE2EXTIME', ids: { [MODEL_FM9]: 113, [MODEL_FM3]: 109, [MODEL_AXE_FX_III]: 107 } },
  { symbol: 'DISTORT_TRIODE2RECTIME', ids: { [MODEL_FM9]: 114, [MODEL_FM3]: 110, [MODEL_AXE_FX_III]: 108 } },
  { symbol: 'DISTORT_CFGRID', ids: { [MODEL_FM9]: 87, [MODEL_FM3]: 83, [MODEL_AXE_FX_III]: 81 } },
  { symbol: 'DISTORT_GRIDHARDNESS', ids: { [MODEL_FM9]: 109, [MODEL_FM3]: 105, [MODEL_AXE_FX_III]: 103 } },
  { symbol: 'DISTORT_CFHARDNESS', ids: { [MODEL_FM9]: 119, [MODEL_FM3]: 115, [MODEL_AXE_FX_III]: 113 } },
];

/** Amp 1..4 effect ids (shared across the family). */
const AMP_EIDS = new Set([58, 59, 60, 61]);
const FIRST_PARAM_WORD = 17;
const CHANNELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export type AllowlistEvidence = 'hardware-fm9' | 'unverified';

export interface RecalculatedWord {
  block: string;
  channel: string;
  symbol: string;
  param_id: number;
  body_offset: number;
  sent: number;
  read_back: number;
}

export interface PresetDumpCompareResult {
  /** True when the read-back holds the preset sent (identical, or differing only in allowed words). */
  holds: boolean;
  /** True when the decompressed bodies are byte-identical. */
  identical: boolean;
  /** Why it does not hold: 'identity' (version / name), 'layout' (length / grid / records), 'words'. */
  mismatch?: 'identity' | 'layout' | 'words';
  detail?: string;
  /** Allowed Amp words that the unit changed. */
  recalculated: RecalculatedWord[];
  /** Body byte offsets of differing words outside the allowlist (first 16). */
  unexpected_offsets: number[];
  unexpected_count: number;
  allowlist_evidence: AllowlistEvidence;
  /** Body word 0 (scene on load) differed; exempt from the compare, reported here. */
  scene_on_load?: { sent: number; read_back: number };
}

function u16(d: Uint8Array, o: number): number {
  return ((d[o] ?? 0) | ((d[o + 1] ?? 0) << 8)) & 0xffff;
}

interface RecordRef { offset: number; cols: number; rows: number; sig: number }

function recordWalk(body: Uint8Array): RecordRef[] {
  const out: RecordRef[] = [];
  let pos = findRecordWalkStart(body);
  if (pos < 0) return out;
  while (pos + 23 * 2 <= body.length) {
    const cols = u16(body, pos + 30);
    const rows = u16(body, pos + 32);
    if (cols === 0 || rows === 0 || cols > 500 || rows > 8) break;
    const size = (23 + cols * rows) * 2;
    if (pos + size > body.length) break;
    out.push({ offset: pos, cols, rows, sig: pos >= RECORD_SIGNATURE_GAP ? u16(body, pos - RECORD_SIGNATURE_GAP) : 0 });
    pos += size;
  }
  return out;
}

function rawName(rawPatch: Uint8Array): string {
  let s = '';
  for (let i = 0x08; i < 0x28; i++) { const b = rawPatch[i]; if (!b) break; s += String.fromCharCode(b); }
  return s.trimEnd();
}

/** Compare a dump sent to the edit buffer with the dump read back from it. */
export function comparePresetDumps(sent: ParsedPresetDump, readBack: ParsedPresetDump): PresetDumpCompareResult {
  const modelId = sent.modelId;
  const allowlist_evidence: AllowlistEvidence = modelId === MODEL_FM9 ? 'hardware-fm9' : 'unverified';
  const base = { recalculated: [] as RecalculatedWord[], unexpected_offsets: [] as number[], unexpected_count: 0, allowlist_evidence };
  if (readBack.modelId !== modelId) {
    return { ...base, holds: false, identical: false, mismatch: 'identity', detail: `model 0x${readBack.modelId.toString(16)} read back, 0x${modelId.toString(16)} sent` };
  }
  const a = decodeRawPatch(sent.chunkPayloads);
  const b = decodeRawPatch(readBack.chunkPayloads);
  const versionA = u16(a.rawPatch, 0);
  const versionB = u16(b.rawPatch, 0);
  if (versionA !== versionB || rawName(a.rawPatch) !== rawName(b.rawPatch)) {
    return {
      ...base, holds: false, identical: false, mismatch: 'identity',
      detail: `sent "${rawName(a.rawPatch)}" (format ${versionA}), the edit buffer holds "${rawName(b.rawPatch)}" (format ${versionB})`,
    };
  }
  const bodyA = a.body;
  const bodyB = b.body;
  if (bodyA.length === bodyB.length && bodyA.every((v, i) => v === bodyB[i])) {
    return { ...base, holds: true, identical: true };
  }
  const gridA = JSON.stringify(decodeGen3Body(bodyA, modelId).grid ?? []);
  const gridB = JSON.stringify(decodeGen3Body(bodyB, modelId).grid ?? []);
  const recA = recordWalk(bodyA);
  const recB = recordWalk(bodyB);
  const sameRecords = recA.length === recB.length
    && recA.every((r, i) => r.offset === recB[i].offset && r.cols === recB[i].cols && r.rows === recB[i].rows);
  if (bodyA.length !== bodyB.length || gridA !== gridB || !sameRecords) {
    return {
      ...base, holds: false, identical: false, mismatch: 'layout',
      detail: bodyA.length !== bodyB.length ? `body length ${bodyA.length} sent, ${bodyB.length} read back`
        : gridA !== gridB ? 'the grid differs' : 'the block record layout differs',
    };
  }
  // Allowed word offsets: every allowlisted Amp param, every channel row, every Amp record.
  const allowed = new Map<number, { block: string; channel: string; symbol: string; paramId: number }>();
  for (const r of recA) {
    if (!AMP_EIDS.has(r.sig)) continue;
    for (const w of AMP_RECALCULATED_WORDS) {
      const id = w.ids[modelId];
      if (id === undefined || id >= r.cols) continue;
      for (let row = 0; row < r.rows; row++) {
        const off = r.offset + (FIRST_PARAM_WORD + row * r.cols + id) * 2;
        allowed.set(off, { block: `Amp ${r.sig - 57}`, channel: CHANNELS[row] ?? String(row), symbol: w.symbol, paramId: id });
      }
    }
  }
  const recalculated: RecalculatedWord[] = [];
  const unexpected: number[] = [];
  let sceneOnLoad: { sent: number; read_back: number } | undefined;
  for (let off = 0; off + 1 < bodyA.length; off += 2) {
    const x = u16(bodyA, off);
    const y = u16(bodyB, off);
    if (x === y) continue;
    // Body word 0 is the scene the preset opens on (fractone
    // Fm9PresetBodySceneAuthor); the unit rewrites it as you change scenes,
    // so a difference there is reported, never a mismatch.
    if (off === 0) { sceneOnLoad = { sent: x, read_back: y }; continue; }
    const hit = allowed.get(off);
    if (hit) {
      recalculated.push({ block: hit.block, channel: hit.channel, symbol: hit.symbol, param_id: hit.paramId, body_offset: off, sent: x, read_back: y });
    } else {
      unexpected.push(off);
    }
  }
  if (bodyA.length % 2 === 1 && bodyA[bodyA.length - 1] !== bodyB[bodyB.length - 1]) unexpected.push(bodyA.length - 1);
  return {
    holds: unexpected.length === 0,
    identical: false,
    ...(unexpected.length ? { mismatch: 'words' as const, detail: `${unexpected.length} word(s) differ outside the Amp words the unit recalculates` } : {}),
    recalculated,
    unexpected_offsets: unexpected.slice(0, 16),
    unexpected_count: unexpected.length,
    allowlist_evidence,
    ...(sceneOnLoad !== undefined ? { scene_on_load: sceneOnLoad } : {}),
  };
}
