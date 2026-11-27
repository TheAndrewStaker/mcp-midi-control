/**
 * Akai MPC descriptor factory + the registered One G2 descriptor.
 *
 * Owns the MIDI surface every standalone MPC shares: sequence recall by Program
 * Change and a General MIDI drum voice map for live pattern streaming. There is
 * no parameter surface: the MPC exposes none over MIDI, so reads and param
 * writes refuse with the reason rather than pretending.
 *
 * And the CARD surface: with the MPC's card in a reader on this computer,
 * `scan_locations` lists the projects on it and `get_preset` reads one
 * project's sequences (number, name, tempo, length) and track mix from its
 * `.xpj`; `apply_preset(target_location)` edits a project's track and
 * sequence values in place through core's `safeReplaceFile`. That
 * is how an agent learns which sequence number plays which part of a song
 * without the user reading the screen out. The two surfaces are present at the
 * same time (`transport.concurrent`): the card is in the reader while the MPC
 * stays on USB with a project already in memory.
 */
import { readFileSync } from 'node:fs';

import type {
  ApplyPresetOptions,
  ApplyResult,
  BlockSchema,
  DeviceDescriptor,
  DispatchCtx,
  GetPresetOptions,
  LocationRef,
  ParamSchema,
  PresetSnapshot,
  PresetSpec,
  ScannedLocation,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { safeReplaceFile, sha256, StorageConflictError } from '@mcp-midi-control/core/storage/safeReplace.js';

import { connect, listMidiPorts, type MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { registerConnector } from '@mcp-midi-control/core/server-shared/connections.js';

import { MPC_ONE_G2 } from './devices/mpcOneG2.js';
import type { MpcConfig } from './devices/types.js';
import { cardProjectPath, findCardProject, listCardProjects, listMpcProjects, readCardProjectFile, resolveMpcCardRoot, resolveMpcRoots, type CardProject } from './storage/card.js';
import { describeTracks, parseXpj, PROGRAM_VOLUME_MAX_DB, summarizeXpj } from './codec/project.js';
import { editXpj, planProjectEdits, type SequenceEditRequest, type TrackEditRequest } from './codec/projectEdit.js';

const CARD_STEPS =
  'Put the MPC in Controller Mode with USB connected (its card and internal drive then mount on this '
  + 'computer), or put its SD card in a reader; the card is recognised by its Projects and Expansions folders. '
  + 'MCP_MPC_CARD_ROOT can name the drive outright. Return the MPC to standalone for sequence select.';

/**
 * Projects listed per scan_locations call. A row is about 90 characters, so 200
 * is about 18,000: well inside the 50,000-character response limit whatever the
 * card holds. A wider range is refused up front rather than cut short.
 */
const SCAN_MAX_ROWS = 200;

/**
 * get_preset's size budget, under the host's 50,000-character delivery limit.
 * The owner's widest project is about 5,400 characters; a project at the
 * unit's limits (128 sequences, 128 busy tracks) is about 87,000.
 */
const SNAPSHOT_BUDGET = 40_000;

/**
 * Fit a snapshot to the budget by dropping the bulky detail (instrument,
 * preset, inserts, sends, MIDI out) from tracks at the end of the list, so
 * every track still appears with what an edit needs. Says so when it cuts.
 */
function fitSnapshot(snap: PresetSnapshot): PresetSnapshot {
  const mix = snap.mpc_project;
  if (mix === undefined || JSON.stringify(snap).length <= SNAPSHOT_BUDGET) return snap;
  const tracks = mix.tracks.map((t) => ({ ...t }));
  type Row = (typeof tracks)[number];
  const slim = (t: Row): Row => ({
    track: t.track, name: t.name, kind: t.kind, level_db: t.level_db,
    ...(t.pan !== undefined ? { pan: t.pan } : {}),
    ...(t.muted === true ? { muted: true as const } : {}),
  });
  let from = tracks.length;
  const build = (): PresetSnapshot => ({
    ...snap,
    mpc_project: { ...mix, tracks, ...(from < tracks.length ? { detail_omitted_from_track: tracks[from].track } : {}) },
    read_warnings: [
      ...(snap.read_warnings ?? []),
      ...(from < tracks.length
        ? [`Response size: from track ${tracks[from].track} on, rows list only name, kind, level, pan and mute (instrument, preset, inserts, sends and MIDI out are left out). Every track is listed and can be edited by number.`]
        : []),
    ],
  });
  let out = build();
  while (from > 0 && JSON.stringify(out).length > SNAPSHOT_BUDGET) {
    from--;
    tracks[from] = slim(tracks[from]);
    out = build();
  }
  return out;
}

function requireCard(label: string, ctx: DispatchCtx): string {
  if (!ctx.storage) {
    throw new DispatchError(
      'capability_not_supported',
      label,
      `This reads project files, which needs the ${label}'s card mounted on this computer. ${CARD_STEPS}`,
    );
  }
  return ctx.storage.root;
}

/** Channel (1..16) from an env var, else the fallback. */
export function resolveChannel(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 16) return n;
  }
  return fallback;
}

const PC_CHANNEL_DEFAULT = 1;
/** General MIDI puts drums on channel 10. */
const DRUM_CHANNEL_DEFAULT = 10;

/** Role -> General MIDI percussion note. Matches kits built with GM pad notes. */
const GM_DRUM_NOTE = {
  kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56,
} as const;

function parseSequence(config: MpcConfig, location: LocationRef): number {
  const n = typeof location === 'number' ? location : Number.parseInt(String(location), 10);
  if (!Number.isInteger(n) || n < 1 || n > config.sequence_count) {
    throw new DispatchError(
      'bad_location',
      config.display_name,
      `Sequence must be 1..${config.sequence_count}, got '${location}'.`,
    );
  }
  return n;
}

/**
 * Open the port pair that reaches the MPC's own sequencer. The default open
 * matches a port by the descriptor id, and "mpc-one-g2" is in none of the
 * MPC's port names, so without this the ports were listed and never opened
 * (found on hardware 2026-11-12). The exact enumerated names are used so the
 * second USB pair, the DAW port and the DIN forwards can never be picked.
 */
function connectMpc(config: MpcConfig): MidiConnection {
  let outName: string | undefined;
  let inName: string | undefined;
  let controllerMode = false;
  try {
    const { inputs, outputs } = listMidiPorts();
    outName = outputs.find((p) => config.engine_ports.output.test(p.name))?.name;
    inName = inputs.find((p) => config.engine_ports.input.test(p.name))?.name;
    controllerMode = [...inputs, ...outputs].some((p) => config.controller_mode_port.test(p.name));
  } catch {
    // Fall through to connect(), whose not-found error lists what is visible.
  }
  if (outName !== undefined && inName !== undefined) return connect({ needles: [outName, inName] });
  if (controllerMode) {
    // Not cached and no lease kept: the user is about to change the mode.
    throw new Error(
      `No MIDI port matching the ${config.display_name} sequencer: the unit is in Controller Mode (it shows `
      + '"Looking for Computer"), where it plays nothing and ignores a sequence select. Ask the user to leave '
      + 'Controller Mode on the MPC so it runs standalone, keep USB connected, then retry. Controller Mode is '
      + 'the mode for reading its card and projects (scan_locations, get_preset).',
    );
  }
  return connect({
    needles: [`${config.display_name} USB-C Out 1`],
    notFoundLeadIn: `${config.display_name} not found: its standalone USB MIDI ports are not connected.`,
    notFoundHints: [
      'Connect the MPC to this computer by USB while it runs standalone; list_midi_ports should then show "MPC One USB-C Out 1".',
      'If the MPC is reached through a MIDI interface on its DIN input instead, address that interface with the send_* tools.',
    ],
  });
}

// ── Project edits (apply_preset on a card project) ──────────────────────────
// A "block" here is one row of a project: a track's mixer strip, or a
// sequence. apply_preset edits only the rows and values it lists; the rest of
// the project is left exactly as the unit saved it (codec/projectEdit.ts).

const num = (name: string, min: number, max: number, unit: string, extra: Partial<ParamSchema> = {}): ParamSchema => ({
  display_name: name,
  unit,
  display_min: min,
  display_max: max,
  encode: (d): number => {
    const n = Number(d);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}, got ${JSON.stringify(d)}`);
    return n;
  },
  decode: (w): number => w,
  ...extra,
});

const MPC_PROJECT_BLOCKS: Readonly<Record<string, BlockSchema>> = {
  track: {
    display_name: 'Track mixer strip (slot = track number from get_preset mpc_project.tracks)',
    params: {
      level_db: {
        display_name: 'Level',
        unit: 'db',
        display_max: PROGRAM_VOLUME_MAX_DB,
        encode: (d): number => {
          if (d === '-inf') return 0;
          const n = Number(d);
          if (!Number.isFinite(n) || n > PROGRAM_VOLUME_MAX_DB) throw new Error(`level_db must be a number up to +${PROGRAM_VOLUME_MAX_DB}, or "-inf", got ${JSON.stringify(d)}`);
          return n;
        },
        decode: (w): number => w,
      },
      pan: num('Pan', -100, 100, 'bipolar_percent'),
      mute: {
        display_name: 'Mute',
        unit: 'enum',
        enum_values: { 0: 'off', 1: 'on' },
        encode: (d): number => (d === 'on' || d === 1 ? 1 : d === 'off' || d === 0 ? 0 : (() => { throw new Error(`mute is "on" or "off", got ${JSON.stringify(d)}`); })()),
        decode: (w): string => (w === 1 ? 'on' : 'off'),
      },
    },
  },
  sequence: {
    display_name: 'Sequence (slot = sequence number)',
    params: {
      name: {
        display_name: 'Name',
        unit: 'opaque',
        encode: (d): number => {
          if (typeof d !== 'string' || d.trim() === '') throw new Error('a sequence name is a non-empty string');
          return 0;
        },
        decode: (w): number => w,
      },
      bpm: num('Tempo', 30, 300, 'bpm'),
      bars: num('Length (read-only, must match the project)', 1, 999, 'count'),
    },
  },
};

/** Split an apply_preset spec into track and sequence requests. */
function editRequests(label: string, spec: PresetSpec): { tracks: TrackEditRequest[]; sequences: SequenceEditRequest[] } {
  const tracks: TrackEditRequest[] = [];
  const sequences: SequenceEditRequest[] = [];
  const seen = new Set<string>();
  for (const s of spec.slots) {
    if (typeof s.slot !== 'number' || !Number.isInteger(s.slot) || s.slot < 1) {
      throw new Error(`${label}: slot is a track or sequence number (1 or more), got ${JSON.stringify(s.slot)}.`);
    }
    const key = `${s.block_type}:${s.slot}`;
    if (seen.has(key)) throw new Error(`${label}: ${s.block_type} ${s.slot} is listed more than once.`);
    seen.add(key);
    const p = (s.params ?? {}) as Record<string, number | string>;
    if (s.block_type === 'track') {
      tracks.push({
        track: s.slot,
        ...(p.level_db !== undefined ? { level_db: p.level_db === '-inf' ? '-inf' as const : Number(p.level_db) } : {}),
        ...(p.pan !== undefined ? { pan: Number(p.pan) } : {}),
        ...(p.mute !== undefined ? { mute: p.mute === 'on' || p.mute === 1 } : {}),
      });
    } else if (s.block_type === 'sequence') {
      sequences.push({
        sequence: s.slot,
        ...(p.name !== undefined ? { name: String(p.name) } : {}),
        ...(p.bpm !== undefined ? { bpm: Number(p.bpm) } : {}),
        ...(p.bars !== undefined ? { bars: Number(p.bars) } : {}),
      });
    } else {
      throw new Error(`${label}: a project row is "track" or "sequence", got "${s.block_type}".`);
    }
  }
  return { tracks, sequences };
}

/**
 * The projects readable right now. The storage root the dispatcher resolved is
 * the first volume; when it is one of the discovered volumes, every mounted
 * volume is listed (card first, then internal storage). A root that was named
 * some other way (a test fixture) is read by itself.
 */
function projectsOn(root: string): CardProject[] {
  const roots = resolveMpcRoots();
  return roots.some((r) => r.root === root) ? listMpcProjects(roots) : listCardProjects(root);
}

export function createMpcDescriptor(config: MpcConfig): DeviceDescriptor {
  registerConnector(config.id, () => connectMpc(config));
  const label = config.display_name;
  const noParams = (): never => {
    throw new DispatchError(
      'capability_not_supported',
      label,
      `${label} exposes no parameters over MIDI. It takes sequence recall (switch_preset), notes and clock.`,
    );
  };
  const buildSwitch = (location: LocationRef): number[] => {
    const seq = parseSequence(config, location);
    const ch = resolveChannel(config.channel_env, PC_CHANNEL_DEFAULT);
    return [0xc0 | (ch - 1), seq - 1];
  };
  const drumChannel = resolveChannel(config.drum_channel_env, DRUM_CHANNEL_DEFAULT);

  return {
    id: config.id,
    display_name: label,
    preset_class: 'voice',
    connection_label: config.id,
    transport: {
      kind: 'hybrid',
      concurrent: true,
      resolveRoot: resolveMpcCardRoot,
      notMountedHint: `${label}'s card is not mounted on this computer. ${CARD_STEPS}`,
    },
    port_match: config.port_match.map((pattern) => ({ pattern })),
    capabilities: {
      slot_model: 'linear',
      slot_count: config.sequence_count,
      support_tier: config.support_tier,
      verification: config.verification,
      has_scenes: false,
      has_channels: false,
      supports_save: false,
      save_note:
        'No save over MIDI. A project is saved on the unit (Menu > Save) or written as files to its card.',
      supports_lineage: false,
      // Card projects are list positions; the reader clamps `to` to the list, so
      // the default is the first page and anything past it is the next page.
      scan_default_range: { from: 1, to: SCAN_MAX_ROWS, rest: `${SCAN_MAX_ROWS + 1} onwards, if the card lists more` },
      // A sequence number (MIDI), or a project's folder under Projects/ (card).
      preset_location_format: /^(\d{1,3}|[^\0]+)$/,
      pattern_realizers: ['live_stream'],
      voice_map: Object.fromEntries(
        Object.entries(GM_DRUM_NOTE).map(([role, note]) => [role, { channel: drumChannel, note }]),
      ),
    },
    canonical_terms: {
      block: 'a project row on the card: a track (mixer strip) or a sequence',
      slot: 'pad',
      preset: 'sequence',
      scene: 'n/a',
      channel: 'MIDI channel',
      location: `sequence 1-${config.sequence_count} in the loaded project`,
    },
    // Nothing here is a MIDI parameter. The two blocks are rows of a project on
    // the card: get_preset reports its sequences as "sequence" slots (and its
    // tracks in mpc_project), and apply_preset(target_location) edits them.
    blocks: MPC_PROJECT_BLOCKS,
    reader: {
      async scanLocations(ctx, from, to): Promise<{ scanned: readonly ScannedLocation[] }> {
        const projects = projectsOn(requireCard(label, ctx));
        const lo = Number(from), hi = Number(to);
        if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi < 1) {
          throw new DispatchError('bad_location', label,
            `On the card, from/to are positions in the project list (1..${projects.length}); got '${from}'..'${to}'.`);
        }
        if (Math.abs(hi - lo) + 1 > SCAN_MAX_ROWS) {
          throw new DispatchError('bad_request', label,
            `Ask for at most ${SCAN_MAX_ROWS} projects per call (got ${Math.abs(hi - lo) + 1}). ${projects.length} are readable; `
            + `page with from/to, e.g. 1..${SCAN_MAX_ROWS}, then ${SCAN_MAX_ROWS + 1}..${SCAN_MAX_ROWS * 2}.`);
        }
        const a = Math.min(lo, hi), b = Math.min(Math.max(lo, hi), projects.length);
        const scanned: ScannedLocation[] = [];
        for (let i = a; i <= b; i++) {
          const p = projects[i - 1];
          scanned.push({ location: p.location, name: p.name, is_empty: false, summary: p.volume === 'internal' ? 'internal storage' : 'SD card' });
        }
        return { scanned };
      },
      async getPreset(ctx, options?: GetPresetOptions): Promise<PresetSnapshot> {
        const root = requireCard(label, ctx);
        if (options?.location === undefined) {
          throw new DispatchError('capability_not_supported', label,
            `${label} reports nothing about the project in its memory. Pass a project on the card as location `
            + '(a path from scan_locations, a project name, or its position in that list).');
        }
        const projects = projectsOn(root);
        const found = findCardProject(projects, options.location);
        if ('candidates' in found) {
          throw new DispatchError('bad_location', label,
            `No single project on the mounted MPC storage matches '${options.location}'. `
            + (found.candidates.length > 0 ? `Projects: ${found.candidates.join('; ')}.` : 'It holds no projects.'));
        }
        let sum;
        let mix;
        try {
          const file = readCardProjectFile(root, found);
          sum = summarizeXpj(file);
          mix = describeTracks(file);
        } catch (e) {
          throw new DispatchError('bad_location', label, `${found.file} could not be read: ${(e as Error).message}`);
        }
        const playlists = sum.songs
          .filter((sg) => sg.items.length > 0)
          .map((sg) => `"${sg.name}": ${sg.items.map((it) => `${it.sequenceIndex + 1}${it.repeats > 1 ? `x${it.repeats}` : ''}`).join(' ')}`);
        return fitSnapshot({
          name: found.name,
          slots: sum.sequences.map((q) => ({
            slot: q.number,
            block_type: 'sequence',
            params: {
              name: q.name,
              ...(q.bpm !== undefined ? { bpm: q.bpm } : {}),
              ...(q.lengthBars !== undefined ? { bars: q.lengthBars } : {}),
            },
          })),
          read_warnings: [
            `Read from ${found.file} on the ${found.volume === 'internal' ? 'MPC internal storage' : 'SD card'}, not from the MPC's memory: this is what the project holds on disk, which is `
            + 'what the MPC plays once the project is loaded and not edited since. The slot number is the sequence number, the '
            + 'value switch_preset takes.',
            ...(playlists.length > 0 ? [`Song-mode playlists (sequence numbers in play order): ${playlists.join(' | ')}.`] : []),
            ...(sum.masterTempo !== undefined ? [`Project tempo ${sum.masterTempo} BPM; saved on MPC software ${sum.appVersion}.`] : []),
          ],
          mpc_project: mix,
          _meta: { device: label, read_at_ms: Date.now(), active_scene_only: false, routing_omitted: true },
        });
      },
      async getParam() {
        return noParams();
      },
      async getParams() {
        return noParams();
      },
    },
    writer: {
      buildSetParam() {
        return noParams();
      },
      buildSwitchPreset(location): number[] {
        return buildSwitch(location);
      },
      async switchPreset(ctx, location: LocationRef): Promise<WriteResult> {
        const bytes = buildSwitch(location);
        ctx.conn.send(bytes);
        const seq = bytes[1] + 1;
        return {
          op: 'switch_preset',
          target: `sequence ${seq}`,
          acked: true,
          info:
            `Sent Program Change ${seq - 1} on ch${(bytes[0] & 0x0f) + 1} for sequence ${seq}. `
            + 'Stopped: the MPC moves now. Playing: it is queued and taken when the current sequence ends. '
            + 'Needs Preferences > MIDI / Sync > Program Change = Sequence. No readback, confirm on the screen.',
        };
      },
      // Pre-file validation: a project edit names its project and its rows.
      validatePreset(spec: PresetSpec, target?: LocationRef): void {
        if (target === undefined) {
          throw new Error(`${label}: apply_preset edits a project on the card; pass target_location (its path from scan_locations). There is no working buffer to build into.`);
        }
        if (typeof target === 'number' || /^\d+$/.test(String(target).trim())) {
          throw new Error(`${label}: name the project to edit by its path or name, not its list position (positions move when projects are added).`);
        }
        if (spec.name !== undefined) {
          throw new Error(`${label}: renaming a project is not done here. Leave out spec.name; rows are edited in place.`);
        }
        editRequests(label, spec);
      },
      // Edit the listed rows of a project file in place. Only the values asked
      // for change. Without save_authorized this is a preview that reads the
      // project and reports what would change, touching nothing.
      async applyPreset(ctx: DispatchCtx, spec: PresetSpec, target?: LocationRef, options?: ApplyPresetOptions): Promise<ApplyResult> {
        const started = Date.now();
        const root = requireCard(label, ctx);
        if (target === undefined) {
          throw new DispatchError('bad_request', label, `${label}: apply_preset edits a project on the card; pass target_location.`);
        }
        const found = findCardProject(projectsOn(root), String(target));
        if ('candidates' in found) {
          throw new DispatchError('bad_location', label, `No single project on the mounted MPC storage matches '${target}'. `
            + (found.candidates.length > 0 ? `Projects: ${found.candidates.join('; ')}.` : 'It holds no projects.'));
        }
        const path = cardProjectPath(root, found);
        const before = readFileSync(path);
        const planned = sha256(before);
        let plan;
        let next;
        try {
          const { tracks, sequences } = editRequests(label, spec);
          plan = planProjectEdits(parseXpj(before), tracks, sequences);
          next = plan.edits.length > 0 ? editXpj(before, plan.edits) : undefined;
        } catch (e) {
          throw new DispatchError('value_out_of_range', label, `${found.file}: ${(e as Error).message}. Nothing was written.`);
        }
        const save = options?.save === true;
        const base = {
          ok: true,
          steps: plan.edits.length,
          applied_spec: spec,
        };
        const edit = { file: found.file, changes: plan.changes, ...(plan.unchanged.length > 0 ? { unchanged: plan.unchanged } : {}) };
        if (next === undefined) {
          return { ...base, duration_ms: Date.now() - started, saved: false, file_edit: edit,
            info: `${found.file} already holds every value asked for. Nothing was written.` } as ApplyResult;
        }
        if (!save) {
          return {
            ...base,
            duration_ms: Date.now() - started,
            saved: false,
            file_edit: edit,
            warning: `PREVIEW only (save_authorized not set): ${plan.changes.length} change(s) to ${found.file}, NOTHING was written. `
              + 'Re-call with save_authorized to write it (the current file is backed up first).',
          } as ApplyResult;
        }
        let receipt;
        try {
          receipt = safeReplaceFile({
            path,
            bytes: next.bytes,
            expectSha256: planned,
            backup: { device: label, device_id: config.id, unit: 'project', location: found.location, name: found.name, tool: 'apply_preset' },
            verify: (written) => { parseXpj(written); },
          });
        } catch (e) {
          throw new DispatchError(e instanceof StorageConflictError ? 'bad_request' : 'no_ack', label, (e as Error).message);
        }
        return {
          ...base,
          duration_ms: Date.now() - started,
          saved: true,
          file_edit: { ...edit, receipt },
          info: `Wrote ${plan.changes.length} change(s) to ${found.file}; the previous copy is in ${receipt.backup_path}. `
            + 'The MPC plays this once the project is loaded again. If it is open on the MPC now, reload it there '
            + 'before saving on the unit: a save from the unit writes back the copy it has in memory.',
        } as ApplyResult;
      },
      // The apply_preset(target_location) gate needs a store; the MPC has none
      // over MIDI, and a card project is edited through apply_preset itself.
      async savePreset(): Promise<WriteResult> {
        throw new DispatchError('capability_not_supported', label,
          `${label} saves on the unit (Menu > Save). To change a project on its card, use apply_preset(target_location = the project, save_authorized).`);
      },
    },
    agent_guidance: config.agent_guidance,
  };
}

export const MPC_ONE_G2_DESCRIPTOR: DeviceDescriptor = createMpcDescriptor(MPC_ONE_G2);
