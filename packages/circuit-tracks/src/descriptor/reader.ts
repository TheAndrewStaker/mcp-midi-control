/**
 * Circuit Tracks DeviceReader.
 *
 * Three read surfaces, very different in what they can see:
 *
 *  - `get_param` / `get_params`: SYNTH PATCH params only. Reads the live (RAM)
 *    buffer via a Current Patch Dump Request and decodes the 340-byte body at
 *    each param's §13 offset (codec/patchLayout) → display via the registry
 *    schema. Covers osc / filter / env / lfo / mixer / fx / eq (instance 1/2 =
 *    Synth 1/2). Drum / project / macro / mod-matrix state has NO MIDI readback,
 *    so those refuse honestly (handoff §0: never invent a value) — to see them,
 *    save the project and read it back via get_preset(location).
 *
 *  - `get_preset(location)`: AVAILABLE, two kinds. A NUMBER (0..63) reads a
 *    STORED project off a Flash slot over the `.ncs` SysEx transfer protocol
 *    (`downloadProject`, hardware-confirmed byte-exact 2026-06-18) and decodes
 *    its sequencer content: four note tracks (Synth1/2, MIDI1/2) + four drum
 *    tracks, pattern 1. `"patch:N"` (N = 0..63) loads the slot into Synth 1's
 *    working buffer (PC-load), dumps it, DECODES all patch-dump params
 *    (osc/filter/env/lfo/mixer/fx/eq), and restores the prior buffer
 *    (non-destructive); it reflects patches saved with save_preset
 *    (hardware-confirmed 2026-07-03). The file-transfer read (`readStoredPatch`)
 *    now backs only `checkOverwriteTarget`. Both read SAVED slots only; the live
 *    working buffer is not a slot, so unsaved edits must be saved on the device first.
 *
 *  - `checkOverwriteTarget`: the save_preset overwrite gate. Reads the target
 *    Flash PATCH slot (fileType 0x04): empty → writes through; occupied → the
 *    dispatcher names the occupying patch and refuses until confirm_overwrite.
 */

import type {
  BatchReadResult,
  DeviceReader,
  DispatchCtx,
  GetPresetOptions,
  LocationRef,
  OverwriteTargetInfo,
  ParamQuery,
  PresetBinaryDump,
  PresetSnapshot,
  PresetSnapshotSlot,
  ReadResult,
  SampleDirectoryDump,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import { decodeParamWire, findParam } from '../params.js';
import { readCurrentPatch, readStoredPatch, readStoredPatchViaLoad, instanceToSynthLoc } from '../codec/patchTransfer.js';
import { isPatchDumpParam, OFFSET_BY_PARAM } from '../codec/patchLayout.js';
import { downloadProject } from '../ncs/uploadProject.js';
import { readSampleDirectory } from '../ncs/sampleDirectory.js';
import { TRANSFER_CONSTANTS } from '../ncs/transfer.js';
import { decodeNotePattern, DEFAULT_GATE, type NoteStep } from '../ncs/notePattern.js';
import { decodeDrumPattern, drumPatternToString, DEFAULT_DRUM_CHOICE } from '../ncs/drumPattern.js';
import { NOTE_TRACKS, NUM_DRUM_TRACKS } from '../ncs/format.js';

const DEVICE_LABEL = 'Novation Circuit Tracks';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** MIDI note number → scientific pitch name (middle C = C4 = 60, the project convention). */
function noteName(n: number): string {
  return `${NOTE_NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}

/** Project name lives at offset 0x10, 16 ASCII bytes, space-padded. */
function decodeProjectName(buf: Uint8Array): string {
  let s = '';
  for (let i = 0x10; i < 0x20; i++) s += String.fromCharCode(buf[i] & 0x7f);
  return s.replace(/[^\x20-\x7e]/g, '').trimEnd();
}

/** Render a note track's active steps as a readable "step N: <notes>" list (gate annotated when non-default). */
function renderNoteTrack(steps: readonly NoteStep[]): { active_steps: number; content: string } {
  const parts: string[] = [];
  steps.forEach((s, i) => {
    if (!s.active) return;
    const notes = s.notes
      .map((n) => noteName(n.note) + (n.gate !== DEFAULT_GATE ? `(gate ${n.gate})` : ''))
      .join('+');
    parts.push(`step ${i + 1}: ${notes}`);
  });
  return { active_steps: parts.length, content: parts.join(', ') || '(empty)' };
}

/**
 * Dump a synth part's live (RAM) patch body (340 bytes) for get_param/get_params,
 * or throw a clean DispatchError. `instance` selects the part (1 = Synth 1).
 */
async function dumpSynthBody(ctx: DispatchCtx, instance?: number): Promise<Uint8Array> {
  const loc = instanceToSynthLoc(instance);
  if (!ctx.conn.hasInput) {
    throw new DispatchError(
      'no_ack', DEVICE_LABEL,
      `get_param needs a bidirectional MIDI connection (input + output) to read Synth ${loc + 1}'s patch back; ` +
      `the Circuit input port was not available.`,
    );
  }
  const read = await readCurrentPatch(ctx.conn, loc, { reconnect: ctx.reconnect });
  if (!read.ok || !read.body) {
    throw new DispatchError(
      'no_ack', DEVICE_LABEL,
      `Could not read Synth ${loc + 1}'s current patch: ${read.error ?? 'no reply'}. Make sure the Circuit is powered, ` +
      `USB-connected, and not mid-transfer; reconnect_midi and retry.`,
    );
  }
  return read.body;
}

/**
 * get_preset for a STORED synth PATCH slot (`location: "patch:N"`). Reads the
 * actual synth PATCH BANK by loading the slot into the working buffer (Program
 * Change on the synth channel) and dumping it — this is the store save_preset
 * writes to, so it reflects freshly-saved patches (HW-confirmed 2026-07-03),
 * unlike the pack's file store. Returns the NAME + all decoded patch-dump params.
 * The load is non-destructive: the prior working buffer is restored afterward.
 */
async function readStoredPatchSnapshot(ctx: DispatchCtx, loc: string): Promise<PresetSnapshot> {
  const m = /^patch[:\s]?(\d+)$/i.exec(loc.trim());
  if (!m) {
    throw new DispatchError('bad_location', DEVICE_LABEL, `Patch location must be "patch:N" (N = 0..63), got ${JSON.stringify(loc)}.`);
  }
  const slot = Number(m[1]);
  if (!Number.isInteger(slot) || slot < 0 || slot > 63) {
    throw new DispatchError('bad_location', DEVICE_LABEL, `Patch slot must be 0..63, got ${slot}.`);
  }
  if (!ctx.conn.hasInput) {
    throw new DispatchError('no_ack', DEVICE_LABEL, 'get_preset needs a bidirectional MIDI connection (input + output) to read the patch back.');
  }
  const started = Date.now();
  const meta = () => ({
    device: DEVICE_LABEL, read_at_ms: Date.now(), active_scene_only: true,
    routing_omitted: true, read_duration_ms: Date.now() - started,
  });
  const r = await readStoredPatchViaLoad(ctx.conn, slot, {});
  if (!r.ok || !r.body) {
    throw new DispatchError('no_ack', DEVICE_LABEL, `Could not read patch slot ${slot}: ${r.error ?? 'no data returned'}.`);
  }
  // Decode every patch-dump param from the 340-byte working-buffer body (same
  // layout + schema get_param uses), so the snapshot carries real display values.
  const params: Record<string, string | number> = { patch_name: r.name ?? '' };
  for (const [key, offset] of OFFSET_BY_PARAM) {
    const dot = key.indexOf('.');
    const cp = findParam(key.slice(0, dot), key.slice(dot + 1));
    if (cp) params[key] = decodeParamWire(cp, r.body[offset] & 0x7f);
  }
  return {
    name: r.name || `Patch ${slot + 1}`,
    slots: [{ slot: 0, block_type: 'patch', params }],
    read_warnings: [
      `Read patch slot ${slot} (device shows Patch ${slot + 1}) by loading it into Synth 1's working buffer and ` +
      `dumping it; this reflects patches saved with save_preset. The prior working buffer was restored afterward.`,
    ],
    _meta: meta(),
  };
}

export const reader: DeviceReader = {
  /**
   * Read a SYNTH PATCH param from the live (RAM) buffer via a Dump Request
   * (instance 1 = Synth 1, 2 = Synth 2), decoding the 340-byte body at the
   * param's §13 offset and converting to display units with the registry
   * schema. Only the synth patch params are in the dump (osc / filter / env /
   * lfo / mixer / fx / eq); drum / project / macro / mod-matrix state has no
   * readback and refuses honestly (no fabricated value — handoff §0).
   */
  async getParam(ctx: DispatchCtx, block: string, name: string, _channel?: string | number, instance?: number): Promise<ReadResult> {
    const cp = findParam(block, name);
    if (!cp) {
      throw new DispatchError('unknown_param', DEVICE_LABEL, `Unknown param '${block}.${name}'. Call list_params({port:"circuit"}).`);
    }
    if (!isPatchDumpParam(block, name)) {
      throw new DispatchError(
        'capability_not_supported', DEVICE_LABEL,
        `get_param reads SYNTH PATCH params from a live Dump Request; '${block}.${name}' is not in the patch dump. ` +
        `Readable: osc/filter/env/lfo/mixer/fx/eq. Drum, project, macro and mod-matrix state have no MIDI readback ` +
        `on Circuit Tracks; verify those by ear / front panel.`,
        { retry_action: 'Read a synth voice param, or verify this one on the device.' },
      );
    }
    const body = await dumpSynthBody(ctx, instance);
    const offset = OFFSET_BY_PARAM.get(`${block}.${name}`)!;
    const wire = body[offset] & 0x7f;
    return { block, name, wire_value: wire, display_value: decodeParamWire(cp, wire), unit: cp.unit };
  },

  /**
   * Batch read. Dumps each requested synth part's RAM ONCE (not per-param) and
   * resolves every query against the right body. Non-patch-dump params fail
   * individually (their index lands in failed_indices) rather than aborting the
   * batch — a partial read is more useful than none.
   */
  async getParams(ctx: DispatchCtx, queries: readonly ParamQuery[]): Promise<BatchReadResult> {
    const reads: ReadResult[] = [];
    const failed_indices: number[] = [];
    const errors: Record<number, string> = {};
    // Dump each distinct part once, lazily, caching the OUTCOME (body or error)
    // per loc. Memoizing the FAILURE matters: without it, an offline device would
    // cost one full readCurrentPatch timeout PER query (N x ~2 s) — instead the
    // first dump fails and every later same-part query fails fast off the cache.
    const dumpByLoc = new Map<number, { body?: Uint8Array; error?: Error }>();
    const bodyFor = async (instance?: number): Promise<Uint8Array> => {
      const loc = instanceToSynthLoc(instance); // throws for an invalid instance (per-query, not cached)
      let entry = dumpByLoc.get(loc);
      if (!entry) {
        try {
          entry = { body: await dumpSynthBody(ctx, instance) };
        } catch (e) {
          entry = { error: e instanceof Error ? e : new Error(String(e)) };
        }
        dumpByLoc.set(loc, entry);
      }
      if (entry.error) throw entry.error;
      return entry.body!;
    };
    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      try {
        const cp = findParam(q.block, q.name);
        if (!cp) throw new Error(`unknown param '${q.block}.${q.name}'`);
        if (!isPatchDumpParam(q.block, q.name)) {
          throw new Error(`'${q.block}.${q.name}' is not in the synth patch dump (no readback for drum/project/macro/mod-matrix)`);
        }
        const body = await bodyFor(q.instance);
        const wire = body[OFFSET_BY_PARAM.get(`${q.block}.${q.name}`)!] & 0x7f;
        reads.push({ block: q.block, name: q.name, wire_value: wire, display_value: decodeParamWire(cp, wire), unit: cp.unit });
      } catch (err) {
        failed_indices.push(i);
        errors[i] = err instanceof Error ? err.message : String(err);
      }
    }
    return { reads, failed_indices, ...(failed_indices.length > 0 ? { errors } : {}) };
  },

  /**
   * Overwrite pre-check for `save_preset` (a Flash PATCH slot 0..63). Uses the
   * NON-DESTRUCTIVE file-transfer read (fileType 0x04) on purpose — NOT the
   * PC-load read get_preset uses — because this runs in the save path and must
   * not disturb the working buffer that save_preset is about to persist. EMPTY →
   * no occupant (writes through); OCCUPIED → surface the patch NAME. Caveat: the
   * file store is sparse, so a patch saved earlier via save_preset (which writes
   * the bank, not a pack file) may read as EMPTY here; the gate then can't name
   * it, but save_preset is already an explicit save action. A read failure (or no
   * input) returns undefined so the dispatcher degrades to "proceed but warn". An
   * out-of-range slot returns undefined so the writer raises bad_location.
   */
  async checkOverwriteTarget(ctx: DispatchCtx, location: LocationRef): Promise<OverwriteTargetInfo | undefined> {
    const slot = typeof location === 'number' ? location : Number.parseInt(String(location), 10);
    if (!Number.isInteger(slot) || slot < 0 || slot > 63) return undefined;
    if (!ctx.conn.hasInput) return undefined;
    try {
      const r = await readStoredPatch(ctx.conn, slot, {});
      if (r.empty) return { target_display: `patch slot ${slot}`, is_active_location: false };
      if (r.ok) return { target_display: `patch slot ${slot}`, occupant_name: r.name || `patch ${slot + 1}`, is_active_location: false };
      return undefined; // read failed → degrade
    } catch {
      return undefined;
    }
  },

  /**
   * Byte-exact backup of a STORED project slot (0..63) as the device's native
   * `.ncs` file. Backs `export_preset(location)` and the backup-before-overwrite
   * helper. Reuses the hardware-confirmed, always-close `downloadProject`
   * (byte-exact 2026-06-18) — the read half of the upload we own.
   *
   * Unlike a Fractal stored dump, a Circuit project slot can be EMPTY: that is a
   * clean read-before-write answer, so we flag it (`empty: true`, no bytes)
   * rather than error. A CRC mismatch, though, is a HARD failure — never hand
   * back unverified bytes as a "backup" (a corrupt backup is worse than none).
   */
  async dumpStoredPresetBinary(location: number, ctx: DispatchCtx): Promise<PresetBinaryDump> {
    if (!Number.isInteger(location) || location < 0 || location > 63) {
      throw new DispatchError('bad_location', DEVICE_LABEL, `Project slot must be 0..63, got ${location}.`);
    }
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'export_preset needs a bidirectional MIDI connection (input + output) to read the project back; the Circuit input port was not available.',
      );
    }
    // Reconnect-before-transfer (restart-research H2): a project read runs the
    // same multi-frame session as a write; refresh a possibly idle-suspended
    // handle first so it self-heals instead of aborting mid-handshake.
    const conn = ctx.reconnect ? ctx.reconnect() : ctx.conn;
    const dl = await downloadProject(conn, location, { reconnect: ctx.reconnect });
    if (dl.empty) {
      return {
        bytes: new Uint8Array(0),
        byte_length: 0,
        frame_count: 0,
        format: 'circuit-ncs-project',
        file_extension: 'ncs',
        empty: true,
        source: `stored project slot ${location} (empty, nothing to export)`,
      };
    }
    if (!dl.ok || !dl.bytes) {
      throw new DispatchError('no_ack', DEVICE_LABEL, `Could not read project slot ${location}: ${dl.error ?? 'no data returned'}.`);
    }
    if (!dl.crcOk) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        `Read of slot ${location} failed its device CRC check; the transfer was partial or corrupt. ` +
        `Not returning a backup from unverified bytes; reconnect and retry.`,
      );
    }
    const bytes = dl.bytes;
    const name = decodeProjectName(bytes);
    return {
      bytes,
      byte_length: bytes.length,
      // The transfer carries the project in fixed-size WRITE_DATA blocks; report
      // that count as "frames" for parity with the Fractal dumps' frame_count.
      frame_count: Math.ceil(bytes.length / TRANSFER_CONSTANTS.BLOCK_SIZE),
      format: 'circuit-ncs-project',
      file_extension: 'ncs',
      name: name || `Project ${location + 1}`,
      source: `stored project slot ${location} (device shows "Project ${location + 1}"; CRC-verified)`,
    };
  },

  /**
   * Read the pack's shared 64-slot drum-sample pool and return each slot's
   * stored name. Read-only; needs a bidirectional connection. Naming a pool
   * semantically ("kick", "snare", "hat") lets the groove packer target slots
   * by meaning instead of a fixed layout.
   */
  async readSampleDirectory(ctx: DispatchCtx): Promise<SampleDirectoryDump> {
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'read_sample_directory needs a bidirectional MIDI connection (input + output) to read the pool names back; the Circuit input port was not available.',
      );
    }
    return readSampleDirectory(ctx.conn);
  },

  /**
   * Read a STORED project from a Flash slot and decode its sequencer content.
   * `options.location` is the slot (0..63). The live working buffer is not a
   * slot — unsaved edits must be saved on the device first.
   */
  async getPreset(ctx: DispatchCtx, options?: GetPresetOptions): Promise<PresetSnapshot> {
    const loc = options?.location;
    if (loc === undefined) {
      throw new DispatchError(
        'capability_not_supported',
        DEVICE_LABEL,
        'Circuit Tracks get_preset reads a STORED slot. Pass location as a number (0..63) for a PROJECT ' +
        '(sequencer content), or "patch:N" (N = 0..63) for a stored synth PATCH (name + decoded params). The live ' +
        'working buffer has no MIDI readback, so SAVE your edits to a slot on the device first, then read that slot.',
      );
    }
    // "patch:N" → read a stored synth PATCH via the file-transfer READ (fileType
    // 0x04), distinct from the default numeric location which reads a PROJECT.
    if (typeof loc === 'string' && /^patch\b/i.test(loc.trim())) {
      return readStoredPatchSnapshot(ctx, loc);
    }
    const slot = typeof loc === 'number' ? loc : Number.parseInt(String(loc), 10);
    if (!Number.isInteger(slot) || slot < 0 || slot > 63) {
      throw new DispatchError('bad_location', DEVICE_LABEL, `Project slot must be 0..63, got ${JSON.stringify(loc)}.`);
    }
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack',
        DEVICE_LABEL,
        'get_preset needs a bidirectional MIDI connection (input + output) to read the project back; the Circuit input port was not available.',
      );
    }

    const started = Date.now();
    // Reconnect-before-transfer (restart-research H2): refresh a possibly idle-
    // suspended handle before the multi-frame project read.
    const conn = ctx.reconnect ? ctx.reconnect() : ctx.conn;
    const dl = await downloadProject(conn, slot, { reconnect: ctx.reconnect });
    // An EMPTY slot is a clean, expected answer (read-before-write safety), not an
    // error — return an empty snapshot so the caller learns "nothing stored here"
    // without a scary failure. The transfer layer has already closed the session.
    if (dl.empty) {
      return {
        name: `(empty slot ${slot})`,
        slots: [],
        read_warnings: [`Slot ${slot} holds no stored project; it is empty. Safe to write (nothing to overwrite).`],
        _meta: {
          device: DEVICE_LABEL,
          read_at_ms: Date.now(),
          active_scene_only: true,
          routing_omitted: true,
          read_duration_ms: Date.now() - started,
        },
      };
    }
    if (!dl.ok || !dl.bytes) {
      throw new DispatchError('no_ack', DEVICE_LABEL, `Could not read project slot ${slot}: ${dl.error ?? 'no data returned'}.`);
    }
    // CRC mismatch = a partial / corrupt read (missing WRITE_FINISH, dropped
    // frames). Refuse to decode unverified bytes into a snapshot — a wrong tail
    // could be edited and uploaded back. Hard failure, not a soft warning.
    if (!dl.crcOk) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        `Read of slot ${slot} failed its device CRC check; the transfer was partial or corrupt. ` +
        `Not returning a snapshot from unverified bytes; reconnect and retry.`,
      );
    }
    const buf = dl.bytes;
    const name = decodeProjectName(buf);
    const slots: PresetSnapshotSlot[] = [];
    const read_warnings: string[] = [];

    // Note tracks (Synth1/Synth2/MIDI1/MIDI2), pattern 0.
    let slotIndex = 0;
    for (const track of NOTE_TRACKS) {
      const rendered = renderNoteTrack(decodeNotePattern(buf, track, 0));
      if (rendered.active_steps === 0) { slotIndex++; continue; }
      slots.push({
        slot: slotIndex++,
        block_type: track,
        params: { active_steps: rendered.active_steps, notes: rendered.content },
      });
    }

    // Drum tracks (Drum1..Drum4), pattern 0.
    for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
      const steps = decodeDrumPattern(buf, t, 0);
      const hits = steps.filter((s) => s.active).length;
      if (hits === 0) { slotIndex++; continue; }
      // Echo the RAW micro-hit masks (hex), not a collapsed count: the actual
      // rhythm-byte mask is what a future hardware capture must be compared
      // against. Collapsing to a count would hide a wrong encoding (B1).
      const masks = [...new Set(steps.filter((s) => s.active && s.microHits > 1).map((s) => s.microHits))]
        .sort((a, b) => a - b)
        .map((m) => `0x${m.toString(16)}`);
      // Per-step SAMPLE FLIPS: a step whose drum_choice != 0xFF plays a DIFFERENT
      // sample than the track's default (the device's Sample Flip feature). Echo
      // the RAW drum_choice value per flipped step — the value→sample-slot
      // encoding is not yet decoded, so this is the read that decodes it.
      const flips = steps
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => s.active && s.drumChoice !== DEFAULT_DRUM_CHOICE)
        .map(({ s, i }) => `step ${i + 1}: drum_choice=${s.drumChoice} (0x${s.drumChoice.toString(16).padStart(2, '0')})`);
      slots.push({
        slot: slotIndex++,
        block_type: `drum${t + 1}`,
        params: {
          hits,
          grid: drumPatternToString(steps),
          ...(masks.length > 0 ? { micro_hit_masks: masks.join(', ') } : {}),
          ...(flips.length > 0 ? { sample_flips: flips.join(', ') } : {}),
        },
      });
    }

    if (slots.length === 0) {
      read_warnings.push(`Slot ${slot} ("${name || 'unnamed'}") pattern 1 has no synth, MIDI, or drum content.`);
    }
    read_warnings.push('Decoded pattern 1 of 8 per track (the default played pattern); other patterns are not shown.');
    if (!dl.crcOk) read_warnings.push('Device CRC did not match the received bytes; the read may be partial.');

    return {
      name: name || `Project ${slot + 1}`,
      slots,
      read_warnings,
      _meta: {
        device: DEVICE_LABEL,
        read_at_ms: Date.now(),
        active_scene_only: true,
        routing_omitted: true,
        read_duration_ms: Date.now() - started,
      },
    };
  },
};
