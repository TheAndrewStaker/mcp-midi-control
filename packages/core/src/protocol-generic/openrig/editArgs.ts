/**
 * `edit_rig` argument surface, shared between clients. The Zod raw shape
 * (`RIG_EDIT_SCHEMA`) and the flat-args -> `RigEditOp` cross-validation
 * (`buildRigEditOp`) used to live inline in the MCP tool handler; they are
 * hoisted here so a SECOND client (web UI / MCP App bridge) submits edits
 * through the exact same validation instead of hand-building ops. The MCP tool
 * registration consumes both, so there is one schema and one validator.
 *
 * NOTE the `.describe()` strings ship in `tools/list` and that budget is
 * frozen (`npm run verify-tools-list-budget`); do not reword them here without
 * re-freezing the ceiling.
 */
import { ROLES, type RigEditOp, type Role } from 'openrig';
import * as z from 'zod/v4';

export const RIG_EDIT_SCHEMA = {
  operation: z.enum(['add_cable', 'remove_cable', 'set_cable_enabled', 'add_device', 'remove_device']).describe('The edit to make.'),
  device: z.string().optional().describe('remove_device: the device to remove (id or display name).'),
  id: z.string().optional().describe('add_device: stable, opaque node id, unique in the rig.'),
  name: z.string().optional().describe('add_device: display name.'),
  roles: z.array(z.string()).optional().describe('add_device: OpenRig roles, e.g. ["sound_source"].'),
  manufacturer: z.string().optional().describe('add_device: manufacturer.'),
  family: z.string().optional().describe('add_device: model family.'),
  server_device_id: z.string().optional().describe('add_device: server descriptor id; omit for unsupported gear.'),
  ports: z.array(z.object({
    id: z.string(),
    kind: z.enum(['audio_out', 'audio_in', 'midi_din_in', 'midi_din_out', 'midi_thru', 'usb_midi', 'usb_serial', 'expression', 'footswitch', 'cv', 'analog_clock']),
    label: z.string().optional(),
    audio: z.enum(['mono', 'stereo']).optional(),
    output_role: z.enum(['main', 'monitor', 'sub', 'stem', 'cue']).optional(),
    direction: z.enum(['in', 'out']).optional(),
  })).optional().describe('add_device: the jacks. An expression/footswitch/cv jack that accepts a pedal is direction:in.'),
  from: z.string().optional().describe('add_cable / remove_cable: source device (id or name).'),
  to: z.string().optional().describe('add_cable / remove_cable: destination device (id or name).'),
  from_port: z.string().optional().describe('add_cable: source jack id.'),
  to_port: z.string().optional().describe('add_cable: destination jack id.'),
  kind: z.enum(['audio', 'midi', 'midi_thru', 'usb_midi', 'expression', 'footswitch', 'cv', 'analog_clock']).optional().describe('Cable type.'),
  midi_type: z.enum(['clock', 'transport', 'spp', 'song_select', 'pc', 'cc', 'nrpn', 'note', 'sysex', 'active_sensing']).optional().describe('add_cable MIDI message type (default cc).'),
  channel: z.number().int().min(1).max(16).optional().describe('MIDI channel 1-16.'),
  cc: z.array(z.number().int().min(0).max(127)).optional().describe('add_cable cc numbers.'),
  notes: z.array(z.number().int().min(0).max(127)).optional().describe('add_cable note numbers.'),
  note_map: z.union([z.literal('GM'), z.record(z.string(), z.string())]).optional().describe('add_cable note cable: "GM" or {note: voice}.'),
  audio_channels: z.array(z.enum(['L', 'R', 'M'])).optional().describe('add_cable audio channels (default ["L","R"], mono = ["M"]).'),
  enabled: z.boolean().optional().describe('add_cable / set_cable_enabled: false = [planned].'),
  note: z.string().optional().describe('add_cable: a human note on the cable.'),
  cable_id: z.string().optional().describe('remove_cable / set_cable_enabled: the cable id.'),
  dry_run: z.boolean().optional().describe('Preview: validate + report, write nothing.'),
};

const rigEditArgsObject = z.object(RIG_EDIT_SCHEMA);

/** The flat argument shape `edit_rig` accepts (inferred from `RIG_EDIT_SCHEMA`). */
export type RigEditArgs = z.infer<typeof rigEditArgsObject>;

/** Validate `roles` against the fixed core enum; a typo fails HERE, loudly. */
function requireRoles(roles: readonly string[]): Role[] {
  for (const r of roles) {
    if (!(ROLES as readonly string[]).includes(r)) {
      throw new Error(`edit_rig add_device: "${r}" is not an OpenRig role. Legal roles: ${ROLES.join(', ')}.`);
    }
  }
  return [...roles] as Role[];
}

/**
 * Cross-validate the flat `edit_rig` args and build the typed `RigEditOp`.
 * Throws (with the tool's established messages) on a missing per-operation
 * requirement or an unknown role.
 */
export function buildRigEditOp(a: RigEditArgs): RigEditOp {
  if (a.operation === 'add_cable') {
    if (a.from === undefined || a.to === undefined || a.kind === undefined) {
      throw new Error('edit_rig add_cable needs from, to, and kind.');
    }
    return {
      op: 'add_cable', from: a.from, to: a.to, from_port: a.from_port, to_port: a.to_port, kind: a.kind, midi_type: a.midi_type,
      channel: a.channel, cc: a.cc, notes: a.notes, note_map: a.note_map,
      audio_channels: a.audio_channels, enabled: a.enabled, note: a.note,
    };
  }
  if (a.operation === 'add_device') {
    if (a.id === undefined || a.name === undefined || a.roles === undefined) {
      throw new Error('edit_rig add_device needs id, name, and roles.');
    }
    return {
      op: 'add_device', id: a.id, name: a.name, roles: requireRoles(a.roles),
      manufacturer: a.manufacturer, family: a.family,
      server_device_id: a.server_device_id, ports: a.ports, note: a.note,
    };
  }
  if (a.operation === 'remove_device') {
    if (a.device === undefined) throw new Error('edit_rig remove_device needs device.');
    return { op: 'remove_device', device: a.device };
  }
  if (a.operation === 'remove_cable') {
    if (a.cable_id === undefined && a.from === undefined && a.to === undefined) {
      throw new Error('edit_rig remove_cable needs cable_id, or from/to (with optional kind).');
    }
    return { op: 'remove_cable', cable_id: a.cable_id, from: a.from, to: a.to, kind: a.kind };
  }
  // set_cable_enabled
  if (a.cable_id === undefined || a.enabled === undefined) {
    throw new Error('edit_rig set_cable_enabled needs cable_id and enabled.');
  }
  return { op: 'set_cable_enabled', cable_id: a.cable_id, enabled: a.enabled };
}
