/**
 * Structured 340-byte synth-patch body layout (v3 Programmer's Reference Guide
 * §"Synth Patch Format"), Leg 2 of patch support: the offset → registry-param
 * map that powers `get_param` (read a live patch back) and, later, offline
 * authoring.
 *
 * SCOPE (first cut): the SCALAR region, offsets 32–123 — voice, osc1/2, mixer,
 * filter, env1/2/3, lfo1/2, FX levels/types, chorus, EQ. Each byte maps 1:1 to a
 * single registry param, so the decode reuses the registry's own display↔wire
 * schema (signed windows, enum tables) — the blob byte IS the same raw 7-bit
 * value the live CC/NRPN carries (handoff §14.2: "two codecs, one source").
 *
 * EVIDENCE: the offset→param assignment is transcribed from §13 AND confirmed
 * against the 128 factory patch dumps in samples/ (scripts/decode-circuit-patches.ts):
 * the per-offset modal value matches each param's registry default at every
 * distinctive anchor (off54=127 osc1_level, off64=127 filter freq, off70=2 env1
 * attack, off89=68 lfo1 rate, off100/102=0 fx levels, off109=125 eq treble freq,
 * off117=100 distortion comp, off121=74 chorus feedback). The .txt extraction's
 * min/max columns are OCR-scrambled and are deliberately NOT used — the registry
 * owns ranges.
 *
 * DEFERRED (NOT in this map, get_param refuses honestly): the LFO packed-flag
 * bytes (91, 99 — the un-registered LFO toggle bus), the mod-matrix record array
 * (124–203, 20 slots × 4 bytes — note the blob holds 20 slots vs 12 live NRPN
 * slots) and the macro record array (204–339, 8 knobs × 17 bytes). Those need a
 * single-param-edit capture pass to bind the record fields before shipping.
 */

import { findParam } from '../params.js';
import { PATCH_BODY_LEN } from './sysex.js';

/** A contiguous run of one block's params, in body-offset order. */
interface Run { start: number; block: string; names: readonly string[] }

const OSC_FIELDS = [
  'wave', 'wave_interpolate', 'pw_index', 'vsync_depth', 'density',
  'density_detune', 'semitones', 'cents', 'pitchbend',
] as const;
const ENV_AMP_FIELDS = ['velocity', 'attack', 'decay', 'sustain', 'release'] as const;
const LFO_FIELDS = ['waveform', 'phase', 'slew', 'delay', 'delay_sync', 'rate', 'rate_sync'] as const;

/** Contiguous param runs (start offset + ordered names). §13, oracle-confirmed. */
const RUNS: readonly Run[] = [
  { start: 32, block: 'voice', names: ['poly_mode', 'portamento', 'pre_glide', 'octave'] },
  { start: 36, block: 'osc1', names: OSC_FIELDS },
  { start: 45, block: 'osc2', names: OSC_FIELDS },
  { start: 54, block: 'mixer', names: ['osc1_level', 'osc2_level', 'ringmod_level', 'noise_level', 'pre_fx_level', 'post_fx_level'] },
  { start: 60, block: 'filter', names: ['routing', 'drive', 'drive_type', 'type', 'frequency', 'tracking', 'resonance', 'q_normalize', 'env2_to_frequency'] },
  { start: 69, block: 'env1', names: ENV_AMP_FIELDS },
  { start: 74, block: 'env2', names: ENV_AMP_FIELDS },
  { start: 79, block: 'env3', names: ['delay', 'attack', 'decay', 'sustain', 'release'] },
  { start: 84, block: 'lfo1', names: LFO_FIELDS },   // 91 = packed flags (skipped)
  { start: 92, block: 'lfo2', names: LFO_FIELDS },   // 99 = packed flags (skipped)
  { start: 105, block: 'eq', names: ['bass_frequency', 'bass_level', 'mid_frequency', 'mid_level', 'treble_frequency', 'treble_level'] },
  // 111–115 reserved; distortion type/compensation then the chorus block:
  { start: 116, block: 'fx', names: ['distortion_type', 'distortion_compensation', 'chorus_type', 'chorus_rate', 'chorus_rate_sync', 'chorus_feedback', 'chorus_mod_depth', 'chorus_delay'] },
];

/** FX LEVELS sit at non-contiguous offsets (reserved bytes interleave). */
const SINGLES: readonly { offset: number; block: string; name: string }[] = [
  { offset: 100, block: 'fx', name: 'distortion_level' },
  { offset: 102, block: 'fx', name: 'chorus_level' },
];

export interface PatchOffset { offset: number; block: string; name: string }

/** Build the flat offset list from the runs + singles. */
function buildOffsets(): PatchOffset[] {
  const out: PatchOffset[] = [];
  for (const run of RUNS) {
    run.names.forEach((name, i) => out.push({ offset: run.start + i, block: run.block, name }));
  }
  for (const s of SINGLES) out.push({ offset: s.offset, block: s.block, name: s.name });
  return out.sort((a, b) => a.offset - b.offset);
}

/** Every mapped (offset, block, name) in the scalar region, ascending by offset. */
export const PATCH_OFFSETS: readonly PatchOffset[] = buildOffsets();

/** `${block}.${name}` → body offset, for the params carried in the patch dump. */
export const OFFSET_BY_PARAM: ReadonlyMap<string, number> = new Map(
  PATCH_OFFSETS.map((p) => [`${p.block}.${p.name}`, p.offset]),
);

/** True if (block, name) is decodable from the synth patch dump. */
export function isPatchDumpParam(block: string, name: string): boolean {
  return OFFSET_BY_PARAM.has(`${block}.${name}`);
}

/** Patch name is bytes 0–15 (handled by blob.ts); these are the parameter bytes. */
export const NAME_BYTES = 16;

/**
 * Decode every mapped param's RAW 7-bit value out of a 340-byte body, keyed by
 * `${block}.${name}`. Display conversion is the caller's job (via the registry
 * ParamSchema) so this stays a pure wire-level read.
 */
export function decodePatchRawValues(body: Uint8Array | readonly number[]): Map<string, number> {
  if (body.length !== PATCH_BODY_LEN) {
    throw new RangeError(`Patch body must be ${PATCH_BODY_LEN} bytes, got ${body.length}.`);
  }
  const out = new Map<string, number>();
  for (const p of PATCH_OFFSETS) out.set(`${p.block}.${p.name}`, body[p.offset] & 0x7f);
  return out;
}

/**
 * Self-check (run by the golden): every mapped param resolves to a real registry
 * param, no two params share an offset, and every offset is inside the body.
 * Returns the list of problems (empty = consistent).
 */
export function validateLayout(): string[] {
  const problems: string[] = [];
  const seen = new Map<number, string>();
  for (const p of PATCH_OFFSETS) {
    const key = `${p.block}.${p.name}`;
    if (p.offset < NAME_BYTES || p.offset >= PATCH_BODY_LEN) {
      problems.push(`${key}: offset ${p.offset} outside the parameter region [${NAME_BYTES}..${PATCH_BODY_LEN - 1}]`);
    }
    const prior = seen.get(p.offset);
    if (prior) problems.push(`offset ${p.offset} mapped twice: ${prior} and ${key}`);
    seen.set(p.offset, key);
    if (!findParam(p.block, p.name)) problems.push(`${key}: no matching registry param`);
  }
  return problems;
}
