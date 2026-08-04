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
  PackDirectoryDump,
  ProjectSlotProbeReport,
  SampleDirectoryDump,
  ScannedLocation,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import { decodeParamWire, findParam } from '../params.js';
import { readCurrentPatch, readStoredPatch, readStoredPatchViaLoad, instanceToSynthLoc } from '../codec/patchTransfer.js';
import { isPatchDumpParam, OFFSET_BY_PARAM } from '../codec/patchLayout.js';
import { downloadProject } from '../ncs/uploadProject.js';
import { readSampleDirectory, readProjectDirectory } from '../ncs/sampleDirectory.js';
import { probeSlots, FILE_TYPE, SLOTS_PER_PACK } from '../ncs/fileDelete.js';
import { readPackDirectory } from '../ncs/packDirectory.js';
import { TRANSFER_CONSTANTS } from '../ncs/transfer.js';
import { decodeNotePattern, describeGate, DEFAULT_GATE, type NoteStep } from '../ncs/notePattern.js';
import { decodeDrumPattern, drumPatternToString, DEFAULT_DRUM_CHOICE } from '../ncs/drumPattern.js';
import { NOTE_TRACKS, NUM_DRUM_TRACKS, PATTERNS_PER_TRACK, checkNcsStructure, ncsStructureNote, type NoteTrack } from '../ncs/format.js';

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

/**
 * Which of the 8 patterns hold ANY content, across all tracks. All in-memory
 * (the whole project is already downloaded), so scanning every pattern costs no
 * extra wire round-trips. Without this, a project whose PLAYED pattern (1) is
 * intentionally silent reads identically to a failed write — the summary is what
 * makes "the write landed, pattern 1 is just empty" distinguishable from "nothing
 * stored" (and the read-side check for project_plan's `starts_silent`).
 */
export function scanPatternOccupancy(buf: Uint8Array): {
  total: number;
  occupied: number[];
  by_track: Record<string, number[]>;
} {
  const by_track: Record<string, number[]> = {};
  const occupiedSet = new Set<number>();
  const note = (pat: number) => (track: NoteTrack) => decodeNotePattern(buf, track, pat).some((s) => s.active);
  const drum = (pat: number) => (t: number) => decodeDrumPattern(buf, t, pat).some((s) => s.active);
  for (let pat = 0; pat < PATTERNS_PER_TRACK; pat++) {
    for (const track of NOTE_TRACKS) {
      if (note(pat)(track)) { (by_track[track] ??= []).push(pat + 1); occupiedSet.add(pat + 1); }
    }
    for (let t = 0; t < NUM_DRUM_TRACKS; t++) {
      if (drum(pat)(t)) { (by_track[`drum${t + 1}`] ??= []).push(pat + 1); occupiedSet.add(pat + 1); }
    }
  }
  return { total: PATTERNS_PER_TRACK, occupied: [...occupiedSet].sort((a, b) => a - b), by_track };
}

/**
 * Render a note track's active steps as a readable "step N: <notes>" list.
 *
 * A note is annotated whenever it differs from the default one-step, untied
 * gate, which includes a note that is merely TIED at the default length. The
 * annotation is display-first (`describeGate` prints steps, not the raw
 * magnitude in sixths) and names the tie in words. A tied note and an untied
 * one of the same length used to print identically here, so every hand-made
 * drone in the maintainer's projects was invisible in `get_preset` and
 * `describe_device`.
 */
export function renderNoteTrack(steps: readonly NoteStep[]): { active_steps: number; content: string } {
  const parts: string[] = [];
  steps.forEach((s, i) => {
    if (!s.active) return;
    const notes = s.notes
      .map((n) => noteName(n.note) + (n.gate !== DEFAULT_GATE || n.tie ? `(${describeGate(n.gate, n.tie)})` : ''))
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
      // The recovery call MUST carry `block`. Without it list_params returns
      // a per-block census with no param rows at all, so an agent following
      // this instruction to find a param name would find nothing.
      throw new DispatchError('unknown_param', DEVICE_LABEL, `Unknown param '${block}.${name}'. Call list_params({port:"circuit", block:["${block}"]}) for that block's params.`);
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
   * Byte-exact backup of a STORED Project (1..64, numbered as the device shows
   * it) as the device's native
   * `.ncs` file. Backs `export_preset(location)` and the backup-before-overwrite
   * helper. Reuses the hardware-confirmed, always-close `downloadProject`
   * (byte-exact 2026-06-18) — the read half of the upload we own.
   *
   * Unlike a Fractal stored dump, a Circuit project slot can be EMPTY: that is a
   * clean read-before-write answer, so we flag it (`empty: true`, no bytes)
   * rather than error. A CRC mismatch, though, is a HARD failure — never hand
   * back unverified bytes as a "backup" (a corrupt backup is worse than none).
   *
   * Reads `ctx.pack` — the same field the overwrite gate and the write itself
   * read. That matters most on the backup-before-overwrite path: a backup that
   * saved Pack 1's slot while the write destroyed Pack 5's would hand back a
   * reassuring "backed up" receipt for a file that is not the thing that was
   * overwritten, which is worse than no backup at all.
   */
  async dumpStoredPresetBinary(location: number, ctx: DispatchCtx): Promise<PresetBinaryDump> {
    // Device numbering in (Project 1..64), wire numbering out (0..63).
    if (!Number.isInteger(location) || location < 1 || location > 64) {
      throw new DispatchError('bad_location', DEVICE_LABEL, `Project must be 1..64, numbered as the device shows it, got ${location}.`);
    }
    const wireSlot = location - 1;
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
    const dl = await downloadProject(conn, wireSlot, { pack: ctx.pack, reconnect: ctx.reconnect });
    const packDesc = `Pack ${(ctx.pack ?? 0) + 1}`;
    if (dl.empty) {
      return {
        bytes: new Uint8Array(0),
        byte_length: 0,
        frame_count: 0,
        format: 'circuit-ncs-project',
        file_extension: 'ncs',
        empty: true,
        source: `stored Project ${location} on ${packDesc} (empty, nothing to export)`,
      };
    }
    if (!dl.ok || !dl.bytes) {
      throw new DispatchError('no_ack', DEVICE_LABEL, `Could not read Project ${location} on ${packDesc}: ${dl.error ?? 'no data returned'}.`);
    }
    if (!dl.crcOk) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        `Read of slot ${location} on ${packDesc} failed its device CRC check; the transfer was partial or corrupt. ` +
        `Not returning a backup from unverified bytes; reconnect and retry.`,
      );
    }
    const bytes = dl.bytes;
    const name = decodeProjectName(bytes);
    // STRUCTURE, reported and NOT thrown. The CRC above says the transfer was
    // faithful; it does not say the thing transferred is a project, because the
    // device's CRC32 covers the ENCODED stream (2026-07-29). Deliberately not a
    // hard failure on THIS path: the bytes are what the slot actually holds, and
    // saving them is still the right move (a backup of a bad slot is evidence,
    // and refusing would also block backing up before replacing the bad slot).
    // What must never happen is handing them back looking clean, which is how a
    // corrupt project ended up in a manifest marked verified.
    const structure = checkNcsStructure(bytes);
    return {
      bytes,
      byte_length: bytes.length,
      // The transfer carries the project in fixed-size WRITE_DATA blocks; report
      // that count as "frames" for parity with the Fractal dumps' frame_count.
      frame_count: Math.ceil(bytes.length / TRANSFER_CONSTANTS.BLOCK_SIZE),
      format: 'circuit-ncs-project',
      file_extension: 'ncs',
      name: name || `Project ${location + 1}`,
      structurally_valid: structure.ok,
      source: structure.ok
        ? `stored Project ${location} on ${packDesc} (device shows "Project ${location + 1}"; CRC-verified and structurally valid)`
        : `stored Project ${location} on ${packDesc} (device shows "Project ${location + 1}"; CRC-verified transfer of a STRUCTURALLY INVALID file)`,
      warning: structure.ok
        ? undefined
        : `Project ${location} on ${packDesc}: ${ncsStructureNote(structure.faults, { crcVerified: true })} ` +
          `The bytes were saved anyway because they are what the slot holds, but do NOT restore this file to any slot.`,
    };
  },

  /**
   * Read a pack's shared 64-slot drum-sample pool and return each slot's stored
   * name. Read-only; needs a bidirectional connection. Naming a pool
   * semantically ("kick", "snare", "hat") lets the groove packer target slots
   * by meaning instead of a fixed layout.
   *
   * Pack-aware via `ctx.pack` — the SAME chosen byte projects + patches address,
   * so `list_samples pack:5` reads the SAME pool a project written to Pack 5
   * binds its drums against (closing the cross-pack name-mismatch trap: read one
   * pack's names, write the project to another, wrong samples play). Pack 1 is
   * hardware-confirmed; a nonzero pack is the identical listing call and is
   * owner-confirmed too (the read 2026-07-17, the matching WRITE 2026-07-27).
   * The returned `pack` says which pool these names came from.
   *
   * Do NOT use this as an immediate write verifier: the device flushes a pack's
   * sample manifest ~6-8 s after a transfer session closes, so a listing taken
   * sooner reports just-written slots empty (`ncs/sampleDirectory.ts`).
   */
  async readSampleDirectory(ctx: DispatchCtx): Promise<SampleDirectoryDump> {
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'read_sample_directory needs a bidirectional MIDI connection (input + output) to read the pool names back; the Circuit input port was not available.',
      );
    }
    const dir = await readSampleDirectory(ctx.conn, ctx.pack ?? 0);
    return { ...dir, pack: (ctx.pack ?? 0) + 1 };
  },

  /**
   * Occupancy for specific PROJECT slots, from BOTH oracles, in one round trip.
   * Backs the read-before-delete gate and the after-delete verification of
   * `delete_project`.
   *
   * The two oracles are genuinely independent. `exists` comes from the device's
   * per-file existence query, which answers with the stored file's own CRC32, so
   * it is computed from the file. `in_directory` comes from the pack's directory
   * listing, which is the table a delete edits. Verifying a delete with the
   * directory ALONE would be circular; verifying with the existence query alone
   * would miss a stale directory entry. So both are reported, unmerged, and a
   * DISAGREEMENT is surfaced as `unreadable` rather than resolved by picking a
   * favourite: two oracles contradicting each other is precisely the moment not
   * to erase anything.
   *
   * It also returns a `free_control`: a slot the pack directory does not list,
   * read the same way in the same session. That is the reference a caller
   * compares an erased slot's answer against, instead of against a hardcoded
   * idea of what "free" looks like. See `ProjectSlotProbeReport.free_control`
   * for the mis-scoring that made it necessary.
   *
   * `slots` are Projects 1..64 as the device shows them; the wire index is one
   * lower and never surfaces. NAMED slots only, never a range. Read-only: this
   * sends no delete and no write.
   */
  async probeProjectSlots(ctx: DispatchCtx, slots: readonly number[]): Promise<ProjectSlotProbeReport> {
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'Checking whether a project slot is occupied needs a bidirectional MIDI connection (input + output); the Circuit input port was not available. Close Novation Components so the port is free, then retry.',
      );
    }
    for (const s of slots) {
      if (!Number.isInteger(s) || s < 1 || s > SLOTS_PER_PACK) {
        throw new DispatchError('bad_location', DEVICE_LABEL,
          `project must be 1..${SLOTS_PER_PACK}, numbered exactly as the device shows it (Project 1..${SLOTS_PER_PACK}), got ${s}.`);
      }
    }
    const raw = await probeSlots(ctx.conn, FILE_TYPE.PROJECT, slots.map((s) => s - 1), { pack: ctx.pack ?? 0 });
    return {
      slots: raw.slots.map((r) => {
        const disagree = r.unreadable === undefined && r.exists !== r.in_directory;
        return {
          slot: r.slot + 1,
          exists: r.exists,
          in_directory: r.in_directory,
          name: r.name,
          crc32: r.crc32,
          reply: r.reply,
          unreadable: r.unreadable ?? (disagree
            ? `the two occupancy oracles disagree (the device's file query says ${r.exists ? 'occupied' : 'empty'}, the pack directory says ${r.in_directory ? 'occupied' : 'empty'}), so occupancy is not established`
            : undefined),
        };
      }),
      free_control: raw.free_control === undefined
        ? undefined
        : { slot: raw.free_control.slot + 1, reply: raw.free_control.reply },
    };
  },

  /**
   * scan_locations for the Circuit: list a pack's occupied PROJECT slots by name
   * in ONE round trip (DIR_CONTROL fileType=0x03), instead of a get_preset per
   * slot (~6 s × 64). Non-destructive listing (module docstring, byte-confirmed
   * against a 52-project pack). Reads `ctx.pack` (the same chosen byte every
   * project op addresses), so scanning Pack 5 lists Pack 5's projects.
   *
   * `from`/`to` are Projects 1..64, numbered as the device shows them (the
   * wire index is one lower, and is never surfaced); the listing is
   * whole-pack, so this filters it to the requested range. A slot the directory
   * did not name is empty.
   */
  async scanLocations(ctx: DispatchCtx, from: string | number, to: string | number): Promise<{ scanned: readonly ScannedLocation[] }> {
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'scan_locations needs a bidirectional MIDI connection (input + output) to read the project directory back; the Circuit input port was not available. Close Novation Components so the port is free, then retry.',
      );
    }
    // Device numbering in, wire numbering out. `scan_locations` exists to be
    // narrated to a musician, so its `location` field must read as the number on
    // the front panel, never the wire index.
    const parseSlot = (v: string | number, label: string): number => {
      const n = typeof v === 'number' ? v : Number.parseInt(String(v), 10);
      if (!Number.isInteger(n) || n < 1 || n > 64) {
        throw new DispatchError('bad_location', DEVICE_LABEL, `scan_locations ${label} must be a project 1..64, numbered as the device shows it, got '${v}'.`);
      }
      return n - 1;
    };
    const lo = parseSlot(from, 'from');
    const hi = parseSlot(to, 'to');
    const dir = await readProjectDirectory(ctx.conn, ctx.pack ?? 0);
    const nameBySlot = new Map(dir.slots.filter((s) => s.name !== undefined).map((s) => [s.slot, s.name!]));
    const scanned: ScannedLocation[] = [];
    for (let slot = Math.min(lo, hi); slot <= Math.max(lo, hi); slot++) {
      const name = nameBySlot.get(slot);
      scanned.push({ location: String(slot + 1), name: name ?? '', is_empty: name === undefined });
    }
    return { scanned };
  },

  /**
   * List the microSD card's packs by name (up to 32). One round trip; the
   * device answers a pack-scoped DIR_CONTROL with a count + one entry per pack.
   * Hardware-confirmed 2026-07-16 (5 packs read by name, first attempt) —
   * `docs/design/circuit-pack-addressing.md`.
   *
   * This is how an agent learns which packs exist BEFORE aiming a destructive
   * write at one: nothing on the wire reports which pack the front panel has
   * selected, so the pack must be chosen deliberately and passed explicitly.
   *
   * Maps the codec's wire-side entry (0-based `index`) to the display-first
   * shape (`pack`, 1-based, the same value the `pack` args take). The 0-based
   * index never reaches the tool surface as a bare `index`, so it cannot be
   * mistaken for the arg.
   */
  async readPackDirectory(ctx: DispatchCtx): Promise<PackDirectoryDump> {
    if (!ctx.conn.hasInput) {
      throw new DispatchError(
        'no_ack', DEVICE_LABEL,
        'list_packs needs a bidirectional MIDI connection (input + output) to read the pack names back; the Circuit input port was not available. Close Novation Components so the port is free, then retry.',
      );
    }
    const dir = await readPackDirectory(ctx.conn);
    return {
      count: dir.count,
      packs: dir.packs.map((p) => ({ pack: p.device_pack, name: p.name, wire_index: p.index })),
      note: dir.note,
    };
  },

  /**
   * Read a STORED project from a Flash slot and decode its sequencer content.
   * `options.location` is the Project, 1..64, numbered as the device shows it.
   * The live working buffer is not a Project — unsaved edits must be saved on
   * the device first.
   */
  async getPreset(ctx: DispatchCtx, options?: GetPresetOptions): Promise<PresetSnapshot> {
    const loc = options?.location;
    if (loc === undefined) {
      throw new DispatchError(
        'capability_not_supported',
        DEVICE_LABEL,
        'Circuit Tracks get_preset reads STORED content. Pass location as a number 1..64 for a PROJECT ' +
        '(sequencer content), numbered as the device shows it, or "patch:N" (N = 0..63) for a stored synth PATCH ' +
        '(name + decoded params). The live working buffer has no MIDI readback, so SAVE your edits on the device ' +
        'first, then read that Project.',
      );
    }
    // "patch:N" → read a stored synth PATCH via the file-transfer READ (fileType
    // 0x04), distinct from the default numeric location which reads a PROJECT.
    if (typeof loc === 'string' && /^patch\b/i.test(loc.trim())) {
      // A patch read goes through the device's WORKING BUFFER (Program Change +
      // dump), which always follows the pack selected on the front panel. There
      // is no pack field to set, so an explicit `pack` cannot be honored: refuse
      // rather than hand back the front panel's pack as if the arg had applied.
      if (ctx.pack !== undefined && ctx.pack !== 0) {
        throw new DispatchError(
          'capability_not_supported',
          DEVICE_LABEL,
          `A "patch:N" read is served from the device's working buffer, which always follows the pack selected on the ` +
          `front panel, so it cannot be pointed at Pack ${ctx.pack + 1} over the wire. Drop the pack arg to read the ` +
          `patch from whichever pack the device currently has loaded, or select Pack ${ctx.pack + 1} on the device first. ` +
          `(A numeric project location DOES honor pack.)`,
        );
      }
      return readStoredPatchSnapshot(ctx, loc);
    }
    const shownProject = typeof loc === 'number' ? loc : Number.parseInt(String(loc), 10);
    if (!Number.isInteger(shownProject) || shownProject < 1 || shownProject > 64) {
      throw new DispatchError('bad_location', DEVICE_LABEL, `Project must be 1..64, numbered as the device shows it, got ${JSON.stringify(loc)}.`);
    }
    const slot = shownProject - 1;   // wire
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
    // `pack` comes off the ctx, like every other pack-scoped leg. Omitting it
    // here made get_preset's `pack` arg a silent no-op that served Pack 1's slot
    // as though the arg had been honored (caught in review, 2026-07-16).
    const dl = await downloadProject(conn, slot, { pack: ctx.pack, reconnect: ctx.reconnect });
    const packDesc = `Pack ${(ctx.pack ?? 0) + 1}`;
    // An EMPTY slot is a clean, expected answer (read-before-write safety), not an
    // error — return an empty snapshot so the caller learns "nothing stored here"
    // without a scary failure. The transfer layer has already closed the session.
    if (dl.empty) {
      return {
        name: `(empty slot ${slot} on ${packDesc})`,
        slots: [],
        read_warnings: [`Slot ${slot} on ${packDesc} holds no stored project; it is empty. Safe to write (nothing to overwrite).`],
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

    // Scan ALL 8 patterns (in-memory, no extra round-trips) so a silent PLAYED
    // pattern is never mistaken for a failed write. `slots` above are pattern 1;
    // the summary reports where content actually lives.
    const occ = scanPatternOccupancy(buf);
    const otherPatterns = occ.occupied.filter((p) => p !== 1);
    if (slots.length === 0) {
      if (otherPatterns.length > 0) {
        // The DANGEROUS case: pattern 1 empty, but the project is NOT — the write
        // landed, its content just starts on a later pattern (an intro, or a
        // project_plan `starts_silent` layout). Say so loudly so this reads as
        // success, not "nothing landed".
        read_warnings.push(
          `Slot ${slot} ("${name || 'unnamed'}") pattern 1 is empty, but the project HOLDS content in pattern(s) ` +
          `${otherPatterns.join(', ')} (of 8) — the project is NOT empty; get_preset decodes pattern 1 only. ` +
          `This is the expected shape for a project that starts silent.`);
      } else {
        read_warnings.push(`Slot ${slot} ("${name || 'unnamed'}") has no content in ANY of its 8 patterns — the project is empty.`);
      }
    } else if (otherPatterns.length > 0) {
      read_warnings.push(`Additional content in pattern(s) ${otherPatterns.join(', ')} (of 8) is not shown; get_preset decodes pattern 1.`);
    } else {
      read_warnings.push('Decoded pattern 1 of 8 per track (the default played pattern); no other pattern holds content.');
    }
    if (!dl.crcOk) read_warnings.push('Device CRC did not match the received bytes; the read may be partial.');

    return {
      name: name || `Project ${slot + 1}`,
      slots,
      read_warnings,
      pattern_occupancy: { total: occ.total, decoded: 1, occupied: occ.occupied, by_track: occ.by_track },
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
