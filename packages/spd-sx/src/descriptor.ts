/**
 * Roland SPD-SX (original), HYBRID descriptor: two USB surfaces on one device.
 *
 * The SPD-SX exposes two mutually-exclusive surfaces, selected by its USB MODE:
 *
 *   - AUDIO/MIDI mode → the MIDI surface. Kit recall via Program Change
 *     (switch_preset; kit 1..100 → PC kit−1, ch10, needs PC TX/RX SW = ON) and
 *     pad triggering via Note On (default pad notes follow the General MIDI drum
 *     map — kick 36, snare 38, hat 42, …). No live
 *     parameter editing over MIDI (no NRPN, no address-mapped SysEx).
 *
 *   - WAVE MGR mode → the STORAGE surface. The unit mounts as a USB mass-storage
 *     drive whose kits and wave pool are `.spd` files (decoded byte-exact and
 *     hardware-confirmed, see the maintainer's STATE-SPDSX notes). This is where
 *     kits are built: import waves into the pool (upload_sample, append-only),
 *     then map them to pads (author_kit). A kit IS a stored preset addressed by
 *     location, so scan_locations lists kits, get_preset(location) reads one kit's
 *     pad map, list_samples reads the wave pool, and export_preset(location) backs
 *     up one kit's `.spd`.
 *
 * `transport: { kind: 'hybrid' }` lets `openCtx` resolve the live surface per
 * call: drive mounted → storage (ctx.storage.root); else a MIDI port → midi
 * (ctx.conn). Each method guards its surface (`requireStorage` / `requireMidi`)
 * so a verb invoked in the wrong USB mode returns a clear capability_not_supported
 * naming the mode to switch to, rather than silently failing.
 *
 * The storage logic lives in `storage/*` (ported byte-exact from the proven
 * `scripts/spdsx/*.py` pipeline); this descriptor is the thin adapter that wraps
 * it into the unified DeviceReader/DeviceWriter contract. See
 * docs/design/device-archetypes-and-transport.md.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type {
  DeviceDescriptor,
  DispatchCtx,
  GetPresetOptions,
  KitAuthorOptions,
  KitAuthorResult,
  KitPadAssignment,
  KitPadSpec,
  LocationRef,
  PresetBinaryDump,
  PresetSnapshot,
  SampleDirectoryDump,
  SampleUploadOutcome,
  ScannedLocation,
  SlotWriteOptions,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import { resolveSpdsxRoot, SPDSX_ROOT_ENV } from './storage/discovery.js';
import { readKits, readKit, readWaves, readWaveNames } from './storage/inventory.js';
import { addWaves } from './storage/waveStore.js';
import { authorKit as authorKitFile, editPadNotes as editPadNotesFile, type PadInput } from './storage/authorKit.js';

const DEVICE_LABEL = 'Roland SPD-SX';
const GLOBAL_CHANNEL = 10;

// Role → MIDI note: the GENERAL MIDI percussion map (the universal drum-note
// standard; adopted 2026-06-30, replacing the old contiguous C4 = 60..68). This is
// the ONE source of truth for the SPD-SX role↔note convention: the pattern
// `voice_map` AND `author_kit`'s full-kit default <NoteNum> both derive from it, so
// a kit authored in SPDSX_PAD_ROLES (= pad) order lines up turnkey with grooves the
// Circuit's MIDI 1/2 track sequences onto this device. Set the device pads to match
// (MENU → KIT → MIDI → NOTE#). GM drums conventionally sit on channel 10
// (= GLOBAL_CHANNEL); a rig may receive them on any channel it sets.
const SPDSX_PAD_ROLES = ['kick', 'snare', 'hat', 'openhat', 'clap', 'tom', 'ride', 'crash', 'perc'] as const;
const SPDSX_GM_NOTE: Record<(typeof SPDSX_PAD_ROLES)[number], number> = {
  kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56,
};
const SPDSX_VOICE_MAP = Object.fromEntries(
  SPDSX_PAD_ROLES.map((role) => [role, { channel: GLOBAL_CHANNEL, note: SPDSX_GM_NOTE[role] }]),
);
// Default <NoteNum> for a full-kit pad at position i: the GM note for the role at
// that pad position; pads past the 9 named roles fall back to the codec's 60 + i.
const spdsxDefaultPadNote = (padIndex: number): number =>
  padIndex < SPDSX_PAD_ROLES.length ? SPDSX_GM_NOTE[SPDSX_PAD_ROLES[padIndex]] : 60 + padIndex;

const MOUNT_STEPS =
  'Set USB MODE = WAVE MGR (MENU → SETUP → OPTION → USB MODE), then connect USB and power-cycle. ' +
  'Windows also needs the Roland "SPD-SX Driver v1.0.1" installed (separate from Wave Manager); use a ' +
  `direct USB-2.0 port, not a hub. Override discovery with the ${SPDSX_ROOT_ENV} env var if needed. ` +
  'macOS mounts it at /Volumes/SPD-SX with no driver.';

/** Kit number (1..100) → 0-based kit index used by the device + filenames. */
function parseKitNumber(location: LocationRef): number {
  const kit = typeof location === 'number' ? location : Number.parseInt(String(location), 10);
  if (!Number.isInteger(kit) || kit < 1 || kit > 100) {
    throw new DispatchError(
      'bad_location',
      DEVICE_LABEL,
      `SPD-SX kit must be 1..100, got '${location}'.`,
    );
  }
  return kit;
}

/** Resolve the mounted storage root, or refuse with the mode-switch hint. */
function requireStorage(ctx: DispatchCtx): string {
  if (!ctx.storage) {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      'This needs the SPD-SX mounted as a drive (WAVE MGR mode). The unit is on its MIDI surface right ' +
        `now (AUDIO/MIDI mode), which only does kit recall + pad triggers. ${MOUNT_STEPS}`,
    );
  }
  return ctx.storage.root;
}

/** Refuse a MIDI op when the unit is on the storage surface instead. */
function requireMidi(ctx: DispatchCtx): void {
  if (ctx.storage) {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      'Kit recall over MIDI needs the SPD-SX on its MIDI surface (USB MODE = AUDIO/MIDI). It is mounted ' +
        'as a drive (WAVE MGR mode) right now. Switch USB MODE, power-cycle, then retry.',
    );
  }
}

/** Build the lower-cased wave-name → indices map for name resolution. */
function waveNameIndex(root: string): Map<string, number[]> {
  const byName = new Map<string, number[]>();
  for (const w of readWaves(root)) {
    const key = w.name.toLowerCase();
    const list = byName.get(key) ?? [];
    list.push(w.index);
    byName.set(key, list);
  }
  return byName;
}

const SPDSX_AGENT_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  capability_summary:
    'The SPD-SX has TWO surfaces, one at a time, selected by USB MODE. AUDIO/MIDI mode = the MIDI surface: ' +
    'recall a kit (switch_preset, kit 1..100 → PC kit−1 on ch10) and trigger pads (General MIDI drum notes: kick 36, snare 38, hat 42, …); there ' +
    'is NO live parameter control over MIDI. WAVE MGR mode = the STORAGE surface (the unit mounts as a drive): ' +
    'build and inspect kits + the wave pool as files. The two modes are mutually exclusive; a verb invoked in ' +
    'the wrong mode returns capability_not_supported naming the mode to switch to.',
  building_kits:
    'A kit IS a stored preset addressed by location (kit 1..100). Build one in WAVE MGR mode: (1) import WAVs ' +
    'into the shared wave pool with upload_sample (APPEND-ONLY, omit slot; each call returns the wave index it ' +
    'landed at); (2) map waves to pads with author_kit(location=kit, name, pads=[…]) where each pad entry is a ' +
    'wave index or wave name (resolve names with list_samples), or -1/"empty". Pads 1-9 are the main pads, 10-15 ' +
    'the external trigger inputs. author_kit refuses to overwrite an occupied kit unless confirm_overwrite=true ' +
    '(which backs the prior kit up first). POWER-CYCLE the unit after writing for it to load the new files.',
  inspecting:
    'In WAVE MGR mode: scan_locations(from,to as kit numbers) lists kit names + which are empty; ' +
    'get_preset(location=kit) returns one kit\'s full pad→wave map; list_samples reads the wave pool (can be ' +
    'hundreds of waves); export_preset(location=kit) backs up that kit\'s .spd to a file. There is no active ' +
    'working buffer, so get_preset without a location is not meaningful here; always pass a kit number.',
  wav_format:
    'The SPD-SX stores waves as 44.1 kHz / 16-bit PCM, but upload_sample now NORMALIZES on import: pass any ' +
    'uncompressed PCM/float WAV (any sample rate, 8/16/24/32-bit, mono or stereo) and it is resampled + ' +
    'requantized to 44.1 kHz / 16-bit (channel count preserved), and a stray metadata chunk is stripped (the ' +
    '"acked but silent" trap). The result reports converted:true with what changed. Resampling is linear, which ' +
    'is fine for drum one-shots and most material; for tonal/sustained samples a higher-quality pre-convert ' +
    '(e.g. `bouncer spdsx`) is better. Wave names are <=12 chars (longer truncate with a warning); kit names ' +
    'are <=8 printable-ASCII chars. The WAV path must be on the machine running this server (a local disk path), ' +
    'not a file only present in the chat sandbox.',
  safety:
    'The device has no CRC recovery and no undo. Wave import is append-only (never renumbers/overwrites an ' +
    'existing wave); author_kit backs up the prior kit before an authorized overwrite; export_preset(location) ' +
    'makes a per-kit backup. Always export_preset the target kit before overwriting it if you want a restore point. ' +
    'upload_sample warns (non-blocking) when the incoming audio is BYTE-IDENTICAL to a wave already in the pool ' +
    '(it still appends, since the pool is append-only; reference the existing index instead to avoid a wasted copy) ' +
    'or when another wave already has the same name (a softer heads-up; names are not unique). It does NOT catch ' +
    'acoustically-similar-but-re-encoded material, only exact re-uploads.',
  windows_driver:
    'WINDOWS DRIVER REQUIRED for the USB connection (either mode). Install "SPD-SX Driver Ver.1.0.1 for ' +
    'Windows 10/11" from roland.com (SPD-SX → Updates & Drivers, SEPARATE from the Wave Manager app), then ' +
    'power-cycle (required after any USB-MODE change) and use a DIRECT USB-2.0 port, not a hub/dock. Symptoms ' +
    'of a MISSING driver (confirmed 2026-06-27): the pad shows "Computer is connected", Windows enumerates a ' +
    'Roland USB device (VID 0582) but it FAILS TO START, no SPD-SX MIDI port appears, and Wave Manager\'s ' +
    '"Select Storage" lists only C:. macOS: NO driver needed: in WAVE MGR mode it is class-compliant mass ' +
    'storage at /Volumes/SPD-SX. When a user reports the SPD-SX "won\'t connect" or "isn\'t showing up", ' +
    'surface this driver step FIRST.',
  as_pattern_target:
    'apply_pattern realizes drum patterns here by streaming notes (live_stream), which needs AUDIO/MIDI mode ' +
    'with EXT CTRL = OFF on the pads and each target pad holding a wave. The device has no on-board sequencer ' +
    'to record into, so record_capture / project authoring do not apply; it is a pure sound module driven live. ' +
    'It can ALSO be sequenced from a host: with the SPD-SX wired to a Novation Circuit Tracks MIDI 1/2 jack, ' +
    'apply_pattern(port:"circuit-tracks", mode:"ncs_upload", external_targets:[{device:"spd-sx", track:"midi2"}]) ' +
    'bakes the groove into the Circuit project so it plays the SPD-SX on recall (set the SPD-SX GLOBAL CH to the ' +
    'track\'s channel). Default pad notes follow the General MIDI drum map (kick 36, snare 38, hat 42, …); actual sound-per-pad is kit-dependent, remap the voice_map ' +
    'note if a pattern hits the wrong pad.',
});

export const SPD_SX_DESCRIPTOR: DeviceDescriptor = {
  id: 'spd-sx',
  display_name: DEVICE_LABEL,
  preset_class: 'voice',
  connection_label: 'spd-sx',
  transport: {
    kind: 'hybrid',
    resolveRoot: resolveSpdsxRoot,
    notMountedHint:
      `${DEVICE_LABEL} is not mounted as a drive. To build/inspect kits over storage: ${MOUNT_STEPS}`,
  },
  port_match: [
    { pattern: /spd-?sx/i },
    { pattern: /spd ?sx/i },
  ],
  capabilities: {
    slot_model: 'linear',
    slot_count: 100, // 100 kits
    support_tier: 'generic-only',
    verification:
      'MIDI surface: documented (Owner\'s Manual) kit recall via PC + pad triggering via notes; no live param ' +
      'control over MIDI. Storage surface: HARDWARE-CONFIRMED end-to-end through this server (2026-06-27): ' +
      'upload_sample appended waves and author_kit wrote a kit that PLAYS after a power-cycle (Kit 50 "TSTEST", ' +
      '4 imported waves audible). The `.spd` codec is also decoded byte-exact and golden-verified. One carve-out: ' +
      'the in-process resample (non-44.1k/16 input) is golden-verified and rides the same confirmed write path, ' +
      'but a resampled wave has not yet been auditioned by ear. Still: confirm new kits on the unit after a ' +
      'power-cycle (the device only rescans files on boot).',
    has_scenes: false,
    has_channels: false,
    supports_save: false,
    save_note:
      'No MIDI save. Kits are authored as files in WAVE MGR storage mode (author_kit / upload_sample), not ' +
      'persisted from a working buffer; the SPD-SX has no editable working buffer over MIDI.',
    supports_lineage: false,
    pattern_realizers: ['live_stream'],
    // Derived from SPDSX_PAD_ROLES (the single role → pad-order → note source).
    voice_map: SPDSX_VOICE_MAP,
  },
  canonical_terms: {
    block: 'pad',
    slot: 'pad',
    preset: 'kit',
    scene: '(n/a)',
    channel: 'global channel',
    location: 'kit (1-100)',
  },
  blocks: {}, // no MIDI-addressable params
  reader: {
    async getParam() {
      throw new DispatchError('capability_not_supported', DEVICE_LABEL,
        'SPD-SX exposes no readable parameters over MIDI.');
    },
    async getParams() {
      throw new DispatchError('capability_not_supported', DEVICE_LABEL,
        'SPD-SX exposes no readable parameters over MIDI.');
    },
    // Storage surface (WAVE MGR mode).
    async scanLocations(ctx, from, to): Promise<{ scanned: readonly ScannedLocation[]; failed_at?: string; failed_reason?: string }> {
      const root = requireStorage(ctx);
      const lo = parseKitNumber(from);
      const hi = parseKitNumber(to);
      // scan_locations reports only kit name + empty/occupied, never wave names,
      // so skip the whole-pool readWaves scan (the slow path) entirely.
      const kitsByNumber = new Map(readKits(root).map((k) => [k.kit, k]));
      const scanned: ScannedLocation[] = [];
      for (let kit = Math.min(lo, hi); kit <= Math.max(lo, hi); kit++) {
        const k = kitsByNumber.get(kit);
        scanned.push({
          location: String(kit),
          name: k?.name ?? '',
          is_empty: k === undefined || k.assignedPads === 0,
        });
      }
      return { scanned };
    },
    async getPreset(ctx, options?: GetPresetOptions): Promise<PresetSnapshot> {
      const root = requireStorage(ctx);
      if (options?.location === undefined) {
        throw new DispatchError('capability_not_supported', DEVICE_LABEL,
          'The SPD-SX has no active working buffer; pass a kit location (1..100) to read that kit\'s pad map.');
      }
      const kitNumber = parseKitNumber(options.location);
      // Read the ONE kit, then resolve names for just its pad waves (O(pads),
      // not the whole pool) — so the pad-note read is fast (~ms), not the ~6.5 s
      // full readWaves scan.
      const k = readKit(root, kitNumber);
      if (!k) {
        throw new DispatchError('bad_location', DEVICE_LABEL, `Kit ${kitNumber} is empty / not present on the device.`);
      }
      const names = readWaveNames(root, k.pads.map((p) => p.wave));
      return {
        name: k.name,
        slots: k.pads.map((p) => {
          if (p.wave === -1) return { slot: p.pad + 1, block_type: 'none', params: {} };
          const params: Record<string, string | number> = { wave: p.wave };
          const waveName = names.get(p.wave);
          if (waveName !== undefined) params.wave_name = waveName;
          // Per-pad MIDI note. Full kits store it (noteSource 'kit'); minimal kits
          // don't — the device fills its own default, not in the file.
          if (p.noteSource === 'kit' && p.noteNum !== undefined) {
            params.note = p.noteNum;
            params.pad_channel = p.padMidiCh === -1 ? 'GLOBAL' : (p.padMidiCh ?? 0);
            if (p.wvLevel !== undefined) params.level = p.wvLevel; // per-pad WvLevel (0..127); the loudness signal
            params.note_source = 'kit';
          } else {
            params.note_source = 'device-default';
          }
          return { slot: p.pad + 1, block_type: 'pad', params }; // 1-based pad number
        }),
        ...(k.minimal
          ? {
              read_warnings: [
                'MINIMAL kit: per-pad MIDI notes AND levels/FX are NOT stored in the file; the device supplies its ' +
                'own (louder) defaults, so each pad shows note_source "device-default" with no note or level. Read ' +
                'the device PAD MIDI menu, or re-author as a full kit (pass per-pad notes to author_kit), to know ' +
                'or set the pad notes. NOTE: converting a minimal kit to full makes levels explicit (default 100), ' +
                'which is QUIETER than the minimal default; that is the loudness drop to watch for.',
              ],
            }
          : {
              read_warnings: [
                `FULL kit: levels/FX are explicit in the file. Kit master Level=${k.level ?? '?'}, FX ` +
                `${k.fxOn ? 'ON' : 'OFF'}; each pad's "level" is its WvLevel (0..127). A pad level of 100 with FX ` +
                'OFF is the freshly-authored default, which is QUIETER than a minimal kit\'s device default.',
              ],
            }),
        _meta: {
          device: DEVICE_LABEL,
          read_at_ms: Date.now(),
          active_scene_only: false,
          routing_omitted: true,
        },
      };
    },
    async readSampleDirectory(ctx): Promise<SampleDirectoryDump> {
      const root = requireStorage(ctx);
      const waves = readWaves(root);
      // The SPD-SX wave pool is APPEND-ONLY and storage-bounded (thousands of
      // waves on the unit's internal memory), not a fixed slot count. Report it
      // as unbounded so occupied/total is not misread as "100% full" — there is
      // always room to append until the device's memory fills.
      const nextIndex = waves.length === 0 ? 0 : Math.max(...waves.map((w) => w.index)) + 1;
      return {
        occupied: waves.length,
        total: waves.length,
        unbounded: true,
        capacity_note: `${waves.length} wave(s) in the pool; append-only with room to add more (next free index ${nextIndex}). occupied == total here is NOT "full"; the SPD-SX pool has no fixed slot ceiling.`,
        slots: waves.map((w) => ({ slot: w.index, device_slot: w.index + 1, name: w.name })),
      };
    },
    async dumpStoredPresetBinary(location, ctx): Promise<PresetBinaryDump> {
      const root = requireStorage(ctx);
      const kitNumber = parseKitNumber(location);
      const file = join(root, 'KIT', `kit${String(kitNumber - 1).padStart(3, '0')}.spd`);
      if (!existsSync(file)) {
        return {
          bytes: new Uint8Array(0),
          byte_length: 0,
          frame_count: 0,
          format: 'spd-sx-kit',
          file_extension: 'spd',
          empty: true,
          source: `SPD-SX kit ${kitNumber} is empty (no kit file on the device).`,
        };
      }
      const names = new Map(readWaves(root).map((w) => [w.index, w.name]));
      const k = readKits(root, names).find((e) => e.kit === kitNumber);
      const bytes = new Uint8Array(readFileSync(file));
      return {
        bytes,
        byte_length: bytes.length,
        frame_count: 1,
        format: 'spd-sx-kit',
        file_extension: 'spd',
        name: k?.name,
        source: `SPD-SX kit ${kitNumber} (${basename(file)})`,
      };
    },
  },
  writer: {
    buildSetParam() {
      throw new DispatchError('capability_not_supported', DEVICE_LABEL,
        'SPD-SX has no MIDI-addressable parameters; only kit recall (switch_preset) and pad triggers.');
    },
    buildSwitchPreset(location): number[] {
      return [0xc0 | ((GLOBAL_CHANNEL - 1) & 0x0f), (parseKitNumber(location) - 1) & 0x7f];
    },
    // MIDI surface (AUDIO/MIDI mode).
    async switchPreset(ctx, location: LocationRef): Promise<WriteResult> {
      requireMidi(ctx);
      const kit = parseKitNumber(location);
      ctx.conn.send([0xc0 | ((GLOBAL_CHANNEL - 1) & 0x0f), (kit - 1) & 0x7f]);
      return {
        op: 'switch_preset',
        target: `kit ${kit}`,
        acked: true,
        info:
          `Recalled kit ${kit} via Program Change ${kit - 1} on ch${GLOBAL_CHANNEL}. ` +
          'Requires PC TX/RX SW = ON. No readback, confirm on the device.',
      };
    },
    // Storage surface (WAVE MGR mode).
    async uploadSample(ctx, wav, _slot, filename, _opts?: SlotWriteOptions): Promise<SampleUploadOutcome> {
      const root = requireStorage(ctx);
      // Append-only pool: the destination slot is ignored; the wave lands at the
      // next free index (which addWaves allocates + returns). No overwrite gate
      // because nothing is ever overwritten.
      const [w] = addWaves(root, [{ wav, name: filename }], false);
      const dupNote = w.duplicateOf
        ? ` DUPLICATE: byte-identical to existing wave ${w.duplicateOf.index} '${w.duplicateOf.name}'.`
        : w.nameCollisionWith
          ? ` NOTE: another wave named '${w.nameCollisionWith.name}' already exists at index ${w.nameCollisionWith.index} (different audio).`
          : '';
      return {
        ok: true,
        slot: w.index,
        blocks: 0,
        converted: w.converted, // resampled/requantized to 44.1k/16 on import if the source differed
        filename: w.name,
        info:
          `Imported wave '${w.name}' at index ${w.index}${w.truncated ? ' (name truncated to 12)' : ''}` +
          `${w.converted ? `; ${w.conversionNote}` : ''}.${dupNote} ` +
          'Reference it from author_kit by this index or by name. Power-cycle the SPD-SX to pick up the new file.',
        warning: w.warning,
      };
    },
    async authorKit(ctx, location: LocationRef, name, pads: readonly KitPadAssignment[], opts?: KitAuthorOptions): Promise<KitAuthorResult> {
      const root = requireStorage(ctx);
      const kitNumber = parseKitNumber(location);
      // Resolve name assignments against the wave pool; numbers pass through.
      const byName = waveNameIndex(root);
      const resolveWave = (ref: number | string): number => {
        if (typeof ref === 'number') return ref;
        const t = ref.trim();
        if (t === '' || t.toLowerCase() === 'empty') return -1;
        const matches = byName.get(t.toLowerCase());
        if (matches === undefined || matches.length === 0) {
          throw new DispatchError('bad_location', DEVICE_LABEL,
            `No wave named '${ref}' in the pool. Use list_samples to see names, or pass the wave index.`);
        }
        if (matches.length > 1) {
          throw new DispatchError('ambiguous_enum_value', DEVICE_LABEL,
            `Wave name '${ref}' is ambiguous (indices ${matches.join(', ')}). Pass the index instead.`,
            { valid_options: matches.map(String) });
        }
        return matches[0];
      };
      // Build pad inputs: a bare wave (number/name) stays minimal; an object pad
      // (per-pad note / voice / mute group / dynamics) switches to the full kit.
      const padInputs: PadInput[] = pads.map((p, i) => {
        if (typeof p === 'number') return p;
        if (typeof p === 'string') return resolveWave(p);
        const spec = p as KitPadSpec;
        return {
          wv: resolveWave(spec.wave),
          note: spec.note ?? spdsxDefaultPadNote(i),
          ...(spec.voice !== undefined ? { voice: spec.voice } : {}),
          ...(spec.loop !== undefined ? { loop: spec.loop } : {}),
          ...(spec.mute_group !== undefined ? { muteGroup: spec.mute_group } : {}),
          ...(spec.level !== undefined ? { level: spec.level } : {}),
          ...(spec.dynamics !== undefined ? { dynamics: spec.dynamics } : {}),
          ...(spec.sub_wave !== undefined ? { subWv: resolveWave(spec.sub_wave) } : {}),
        };
      });

      let res;
      try {
        res = authorKitFile(root, kitNumber, name, padInputs, { force: opts?.confirmOverwrite, dryRun: opts?.dryRun });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // The storage layer refuses to clobber an occupied kit without force.
        if (/refusing to overwrite/i.test(msg)) {
          throw new DispatchError('overwrite_confirmation_required', DEVICE_LABEL,
            `Kit ${kitNumber} already exists. Re-call author_kit with confirm_overwrite: true to replace it ` +
            '(the prior kit is backed up to .spd.bak first).');
        }
        throw new DispatchError('bad_location', DEVICE_LABEL, `author_kit failed: ${msg}`);
      }

      return {
        ok: true,
        location: res.kit,
        name: res.name,
        assigned: res.assigned,
        bytes: res.bytes,
        dry_run: !res.written,
        backed_up: res.backedUp,
        info: res.written
          ? `Wrote ${res.fullKit ? 'full' : 'minimal'} kit ${res.kit} '${res.name}' (${res.assigned}/15 pads) to ${res.path}.` +
            (res.backedUp ? ` Prior kit backed up to ${basename(res.backedUp)}.` : '') +
            ' Eject the drive cleanly and POWER-CYCLE the SPD-SX to load it.'
          : `Dry run: ${res.fullKit ? 'full' : 'minimal'} kit ${res.kit} '${res.name}' (${res.assigned}/15 pads, ${res.bytes} bytes) validated, not written.`,
        warning: res.fullKit
          ? 'Per-pad MIDI/voice properties use the SPD-SX full-kit format (byte-shaped like the device\'s own kits, FX off). ' +
            'HARDWARE-CONFIRMED 2026-07-07: 20 server-authored full kits loaded and their loop pads play correctly on the device. ' +
            'Pads default to one-shot SHOT unless loop:true is set (loop = the device\'s own loop-pad signature ' +
            'PlayMode=2/Loop=1/TrigType=1/MONO, hardware-confirmed looping). The POLY/MONO choke direction is still ' +
            'correlation-inferred, so confirm choke behavior by ear if it matters.'
          : undefined,
      };
    },
    async editPadNotes(ctx, location: LocationRef, notes, opts?: KitAuthorOptions): Promise<KitAuthorResult> {
      const root = requireStorage(ctx);
      const kitNumber = parseKitNumber(location);
      // notes are keyed by the device-facing pad number (1..15) → 0-based index.
      const byIndex = new Map<number, number>();
      for (const [k, v] of Object.entries(notes)) {
        const padNum = Number(k);
        if (!Number.isInteger(padNum) || padNum < 1 || padNum > 15) {
          throw new DispatchError('bad_request', DEVICE_LABEL, `set_notes: pad must be 1..15, got '${k}'.`);
        }
        byIndex.set(padNum - 1, v);
      }
      let res;
      try {
        res = editPadNotesFile(root, kitNumber, byIndex, { dryRun: opts?.dryRun });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // A minimal kit can't take a note without the level-changing full format.
        if (/minimal kit/i.test(msg)) throw new DispatchError('capability_not_supported', DEVICE_LABEL, msg);
        if (/out of (midi )?range/i.test(msg)) throw new DispatchError('value_out_of_range', DEVICE_LABEL, msg);
        throw new DispatchError('bad_location', DEVICE_LABEL, msg);
      }
      const padList = res.patched.map((p) => `pad ${p.pad}→${p.note}`).join(', ');
      return {
        ok: true,
        location: res.kit,
        name: res.name,
        assigned: res.patched.length,
        bytes: res.bytes,
        dry_run: !res.written,
        backed_up: res.backedUp,
        info: res.written
          ? `Set notes on kit ${res.kit} '${res.name}': ${padList}, preserving waves / levels / FX (only NoteNum changed).` +
            (res.backedUp ? ` Prior kit backed up to ${basename(res.backedUp)}.` : '') +
            ' Eject the drive cleanly and POWER-CYCLE the SPD-SX to load it.'
          : `Dry run: would set ${padList} on kit ${res.kit} '${res.name}' (${res.bytes} bytes), preserving everything else. Not written.`,
      };
    },
  },
  agent_guidance: SPDSX_AGENT_GUIDANCE,
};
