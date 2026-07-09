/**
 * SPD-SX surgical kit authoring — write ONE kit `.spd` directly to the mounted
 * device, no Wave Manager "Save All" (which rewrites the whole ~500MB image).
 *
 * Port of `scripts/spdsx/spdsx_author.py::author_kit`. Safety model:
 * - Append-only by default: refuses to overwrite an existing kit unless `force`.
 * - Validates the generated XML (verifyKit) BEFORE writing.
 * - Referential-integrity gate ON by default: derives the wave-index ceiling
 *   from the device so a pad can never reference a non-existent wave.
 * - Never touches the wave pool or SYSTEM files (a kit only references waves by
 *   index; the device rebuilds its wave list from PRM on load).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildKit, buildFullKit, editKitNotes, isMinimalKit, parseFullKit, PAD_COUNT, type FullPad } from '../codec/kitXml.js';
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
  path?: string;
  backedUp?: string;
  written: boolean;
}

/** A pad: a bare wave index (minimal kit) or a FullPad with per-pad properties. */
export type PadInput = number | FullPad;

/** True when any pad carries a per-pad property (→ the FULL kit format). */
function needsFullKit(pads: readonly PadInput[]): boolean {
  return pads.some((p) =>
    typeof p !== 'number' &&
    (p.note !== undefined || p.voice !== undefined || p.muteGroup !== undefined ||
      p.level !== undefined || p.dynamics !== undefined || p.subWv !== undefined ||
      p.loop !== undefined),
  );
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
 * <NoteNum> fields change — waves, levels, FX, pan, mute groups stay byte-for-
 * byte identical, so this can never quiet a kit the way a full re-author does.
 * `notes` maps a 0-based pad index (0..14) to a MIDI note (0..127). Backs the
 * prior kit up to .spd.bak first.
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
  const fullKit = needsFullKit(pads);
  const text = fullKit ? buildFullKit(name, fullPads) : buildKit(name, padWaves);

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
