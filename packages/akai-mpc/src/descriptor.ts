/**
 * Akai MPC descriptor factory + the registered One G2 descriptor.
 *
 * Owns the MIDI surface every standalone MPC shares: sequence recall by Program
 * Change and a General MIDI drum voice map for live pattern streaming. There is
 * no parameter surface: the MPC exposes none over MIDI, so reads and param
 * writes refuse with the reason rather than pretending.
 *
 * And the CARD surface, read-only: with the MPC's card in a reader on this
 * computer, `scan_locations` lists the projects on it and `get_preset` reads
 * one project's sequences (number, name, tempo, length) from its `.xpj`. That
 * is how an agent learns which sequence number plays which part of a song
 * without the user reading the screen out. The two surfaces are present at the
 * same time (`transport.concurrent`): the card is in the reader while the MPC
 * stays on USB with a project already in memory.
 */
import type {
  DeviceDescriptor,
  DispatchCtx,
  GetPresetOptions,
  LocationRef,
  PresetSnapshot,
  ScannedLocation,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import { connect, listMidiPorts, type MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { registerConnector } from '@mcp-midi-control/core/server-shared/connections.js';

import { MPC_ONE_G2 } from './devices/mpcOneG2.js';
import type { MpcConfig } from './devices/types.js';
import { findCardProject, listCardProjects, listMpcProjects, readCardProject, resolveMpcCardRoot, resolveMpcRoots, type CardProject } from './storage/card.js';

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
      // A sequence number (MIDI), or a project's folder under Projects/ (card).
      preset_location_format: /^(\d{1,3}|[^\0]+)$/,
      pattern_realizers: ['live_stream'],
      voice_map: Object.fromEntries(
        Object.entries(GM_DRUM_NOTE).map(([role, note]) => [role, { channel: drumChannel, note }]),
      ),
    },
    canonical_terms: {
      block: 'n/a (no parameters over MIDI)',
      slot: 'pad',
      preset: 'sequence',
      scene: 'n/a',
      channel: 'MIDI channel',
      location: `sequence 1-${config.sequence_count} in the loaded project`,
    },
    // No blocks: nothing on this device is a parameter. get_preset reports a
    // project's sequences as slots of type "sequence", read from the card.
    blocks: {},
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
        try {
          sum = readCardProject(root, found);
        } catch (e) {
          throw new DispatchError('bad_location', label, `${found.file} could not be read: ${(e as Error).message}`);
        }
        const playlists = sum.songs
          .filter((sg) => sg.items.length > 0)
          .map((sg) => `"${sg.name}": ${sg.items.map((it) => `${it.sequenceIndex + 1}${it.repeats > 1 ? `x${it.repeats}` : ''}`).join(' ')}`);
        return {
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
          _meta: { device: label, read_at_ms: Date.now(), active_scene_only: false, routing_omitted: true },
        };
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
    },
    agent_guidance: config.agent_guidance,
  };
}

export const MPC_ONE_G2_DESCRIPTOR: DeviceDescriptor = createMpcDescriptor(MPC_ONE_G2);
