/**
 * SPD-SX surgical kit authoring — write ONE kit `.spd` directly to the mounted
 * device, no Wave Manager "Save All" (which rewrites the whole ~500MB image).
 *
 * Port of `scripts/spdsx/spdsx_author.py::author_kit`. Safety model:
 * - Append-only by default: refuses to overwrite an existing kit unless `force`.
 * - Re-authoring MERGES over the kit already there: a field the caller does not
 *   name keeps its current device value. Rebuilding from defaults instead is what
 *   silently flattened a balanced kit's levels to 100 on a one-wave swap.
 * - Validates the generated XML (verifyKit) BEFORE writing.
 * - Referential-integrity gate ON by default: derives the wave-index ceiling
 *   from the device so a pad can never reference a non-existent wave.
 * - Never touches the wave pool or SYSTEM files (a kit only references waves by
 *   index; the device rebuilds its wave list from PRM on load).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildKit, buildFullKit, editKitNotes, isMinimalKit, parseFullKit, parseFullKitBase, PAD_COUNT,
  type FullKitBase, type FullPad,
} from '../codec/kitXml.js';
import { validateKit } from '../codec/verifyKit.js';
import { nextFreeIndex, writeKitFile } from './waveStore.js';

function decodeKitName(codes: readonly number[]): string {
  let s = '';
  for (const c of codes) {
    if (c === 0) break;
    if (c >= 32 && c <= 126) s += String.fromCharCode(c);
  }
  return s.replace(/\s+$/, '');
}

export interface AuthorKitOptions {
  /** Highest valid wave index; default = derived from the device. */
  maxWave?: number;
  /** Skip the wave-index range check (unsafe; offline corpus use only). */
  allowUnbounded?: boolean;
  /** Allow overwriting an existing kit (backs it up to .spd.bak first). */
  force?: boolean;
  /** Build + validate but do not write. */
  dryRun?: boolean;
  /**
   * Device-convention <NoteNum> for pad i on a FRESH kit (the SPD-SX descriptor
   * supplies the General MIDI percussion note for the role at that pad). Never
   * overrides a note the caller named or one an existing kit already holds.
   */
  defaultNote?: (padIndex: number) => number;
  /**
   * Build from device defaults instead of merging over the kit already at this
   * location — for a WHOLESALE replace, where inheriting an unrelated kit's pad
   * properties (a stale mute group can choke a cymbal) is wrong rather than kind.
   * NOT exposed on the MCP tool: an agent editing a kit always wants the merge,
   * and every field is nameable anyway. For bulk authoring scripts that own the
   * whole slot. Default false.
   */
  ignoreExisting?: boolean;
}

/** What a re-author inherited from the kit already on the device. */
export interface KitMergeReport {
  /** Per-pad level kept from the existing kit (pads with a wave, caller named no level). */
  levels: { pad: number; level: number }[];
  /** Pads whose WAVE changed while the level was inherited — the new sample may want a different level. */
  waveChanged: number[];
  /** True when the existing kit's Level/Tempo/FX header was carried over. */
  header: boolean;
}

export interface AuthorKitResult {
  kit: number;
  name: string;
  assigned: number;
  bytes: number;
  maxWave: number | undefined;
  text: string;
  /** True when the FULL (per-pad note/voice/mute/dynamics) format was written. */
  fullKit: boolean;
  /** Set when this re-authored over an existing full kit: what it inherited. */
  merged?: KitMergeReport;
  path?: string;
  backedUp?: string;
  written: boolean;
}

/** A pad: a bare wave index (minimal kit) or a FullPad with per-pad properties. */
export type PadInput = number | FullPad;

/** True when any pad is a spec object rather than a bare wave (→ the FULL kit format). */
function needsFullKit(pads: readonly PadInput[]): boolean {
  return pads.some((p) => typeof p !== 'number');
}

/** The kit file currently at this location, or undefined if the slot is free. */
function readExistingKit(root: string, kitNumber: number): string | undefined {
  try {
    return readFileSync(join(root, 'KIT', `kit${String(kitNumber - 1).padStart(3, '0')}.spd`), 'utf-8');
  } catch {
    return undefined;
  }
}

/** Summarize what a merge carried over, for the caller to see (and act on). */
function reportMerge(base: FullKitBase, pads: readonly FullPad[]): KitMergeReport {
  const levels: { pad: number; level: number }[] = [];
  const waveChanged: number[] = [];
  pads.forEach((p, i) => {
    const prior = base.pads[i];
    if (prior === undefined || p.level !== undefined || Math.trunc(p.wv) === -1) return;
    levels.push({ pad: i + 1, level: prior.wvLevel });
    if (prior.wv !== Math.trunc(p.wv)) waveChanged.push(i + 1);
  });
  return { levels, waveChanged, header: true };
}

export interface PadNoteEditResult {
  kit: number;
  name: string;
  /** Pads patched: { pad (1-based), note }. */
  patched: { pad: number; note: number }[];
  bytes: number;
  backedUp?: string;
  written: boolean;
}

/**
 * Non-destructively set per-pad MIDI notes on an EXISTING full kit. ONLY the
 * <NoteNum> fields change — every other byte is untouched. `authorKit` now
 * preserves unnamed fields too, so this is no longer the only safe way to touch
 * a balanced kit; it stays the surgical one (byte-identical except the notes,
 * and it needs no pad list). `notes` maps a 0-based pad index (0..14) to a MIDI
 * note (0..127). Backs the prior kit up to .spd.bak first.
 *
 * MINIMAL kits store no per-pad notes/levels, so adding a note would require the
 * full format (making levels explicit and changing loudness) — this REFUSES
 * them and tells the caller to use the device PAD MIDI menu or re-author full.
 */
export function editPadNotes(
  root: string,
  kitNumber: number,
  notes: ReadonlyMap<number, number>,
  opts: { dryRun?: boolean } = {},
): PadNoteEditResult {
  if (notes.size === 0) throw new Error('no notes to set (pass at least one pad -> note)');
  for (const [pad, note] of notes) {
    if (!Number.isInteger(pad) || pad < 0 || pad >= PAD_COUNT) throw new Error(`pad index ${pad} out of range 0..${PAD_COUNT - 1}`);
    if (!Number.isInteger(note) || note < 0 || note > 127) throw new Error(`note ${note} (pad ${pad + 1}) out of MIDI range 0..127`);
  }
  const file = `kit${String(kitNumber - 1).padStart(3, '0')}.spd`;
  let text: string;
  try {
    text = readFileSync(join(root, 'KIT', file), 'utf-8');
  } catch {
    throw new Error(`kit ${kitNumber} not found on the device (${file}); nothing to edit.`);
  }
  if (isMinimalKit(text)) {
    throw new Error(
      `kit ${kitNumber} is a MINIMAL kit: it stores no per-pad notes or levels. Setting a note requires the ` +
      `full kit format, which makes levels explicit and would change the kit's loudness from the (louder) device ` +
      `default. Set the note on the device's PAD MIDI menu, or re-author the kit as a full kit with author_kit ` +
      `(which lets you choose levels).`);
  }
  const patchedText = editKitNotes(text, notes);
  const v = validateKit(patchedText);
  if (!v.ok) throw new Error(`patched kit failed validation:\n  ${v.errors.join('\n  ')}`);
  const name = decodeKitName(parseFullKit(text).nm);
  const patched = [...notes].map(([pad, note]) => ({ pad: pad + 1, note })).sort((a, b) => a.pad - b.pad);
  const bytes = Buffer.byteLength(patchedText, 'utf-8');
  if (opts.dryRun) return { kit: kitNumber, name, patched, bytes, written: false };
  const { backedUp } = writeKitFile(root, kitNumber, patchedText, { force: true });
  return { kit: kitNumber, name, patched, bytes, backedUp, written: true };
}

export function authorKit(
  root: string,
  kitNumber: number,
  name: string,
  pads: readonly PadInput[],
  opts: AuthorKitOptions = {},
): AuthorKitResult {
  if (!Number.isInteger(kitNumber) || kitNumber < 1 || kitNumber > 100) {
    throw new Error(`kit must be 1..100, got ${kitNumber}`);
  }
  // Normalize: a bare number is a wave-only pad. The FULL format (per-pad note /
  // voice / mute group / dynamics) is used only when a pad asks for it; otherwise
  // the byte-confirmed minimal kit is emitted unchanged.
  const fullPads: FullPad[] = pads.map((p) => (typeof p === 'number' ? { wv: p } : p));
  const padWaves = fullPads.map((p) => Math.trunc(p.wv));

  // Re-author = MERGE over the kit already there, never a rebuild from defaults.
  // Rebuilding is what silently reset every level to 100 and every mute group to
  // 0 when a session only meant to swap one wave. Two rules fall out:
  //   - an existing FULL kit keeps the full format even for bare-wave pads, so a
  //     wave swap can never downgrade the file and drop its per-pad state;
  //   - within a listed pad, an unnamed field inherits (see resolveFullPad).
  // A MINIMAL kit stores no per-pad state, so there is nothing to inherit.
  let base: FullKitBase | undefined;
  const existing = opts.ignoreExisting ? undefined : readExistingKit(root, kitNumber);
  if (existing !== undefined) {
    try {
      base = parseFullKitBase(existing);
    } catch (e) {
      throw new Error(
        `kit ${kitNumber} already exists but its per-pad settings could not be read ` +
          `(${e instanceof Error ? e.message : String(e)}), so a re-author would silently reset its levels ` +
          `and mute groups. Refusing. Author to a free kit number, or move the existing file aside.`,
      );
    }
  }
  const fullKit = needsFullKit(pads) || base !== undefined;
  const text = fullKit
    ? buildFullKit(name, fullPads, { base, defaultNote: opts.defaultNote })
    : buildKit(name, padWaves);
  const merged = base !== undefined ? reportMerge(base, fullPads) : undefined;

  // Referential-integrity gate: bound wave indices by the device pool.
  let maxWave = opts.maxWave;
  if (maxWave === undefined && !opts.allowUnbounded) {
    try {
      maxWave = nextFreeIndex(root) - 1;
    } catch (e) {
      throw new Error(
        `cannot read the device wave tree to bound wave indices ` +
          `(${e instanceof Error ? e.message : String(e)}). Pass maxWave, or allowUnbounded to skip the check.`,
      );
    }
  }

  // Validate before writing (same gate as the verifier).
  const v = validateKit(text, maxWave);
  if (!v.ok) {
    throw new Error(`generated kit failed validation:\n  ${v.errors.join('\n  ')}`);
  }

  const result: AuthorKitResult = {
    kit: kitNumber,
    name: v.name ?? name,
    assigned: v.assigned,
    bytes: text.length,
    maxWave,
    text,
    fullKit,
    merged,
    written: false,
  };
  if (opts.dryRun) return result;

  const { path, backedUp } = writeKitFile(root, kitNumber, text, { force: opts.force });
  result.path = path;
  result.backedUp = backedUp;
  result.written = true;
  return result;
}

export { PAD_COUNT };
