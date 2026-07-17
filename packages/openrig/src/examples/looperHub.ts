/**
 * The §10 worked example from the design doc, as a typed fixture: a minimal
 * looper-hub rig. A looper acting as clock master + MIDI relay + audio hub, an
 * amp modeler feeding it audio and sending scene CCs, a groovebox sequencing a
 * sample pad, a MIDI thru box fanning clock/PC out, and one opaque passive cab.
 *
 * Doubles as the validator's happy-path golden: `validateRig(LOOPER_HUB_RIG)`
 * must return no errors.
 */
import type { Rig } from '../types.js';

export const LOOPER_HUB_RIG: Rig = {
  openrig_version: '0.1',
  id: 'example-looper-hub',
  name: 'Example looper-hub rig',
  nodes: [
    {
      id: 'rc505',
      name: 'RC-505mk2',
      server_device_id: 'rc-505mk2',
      roles: ['looper', 'clock_master', 'midi_router', 'mixer'],
      identity: { manufacturer: 'Boss', family: 'RC-505mk2' },
      ports: [
        { id: 'main_in', kind: 'audio_in', audio: 'stereo' },
        { id: 'main_out', kind: 'audio_out', audio: 'stereo' },
        { id: 'midi_out', kind: 'midi_din_out' },
        { id: 'midi_in', kind: 'midi_din_in' },
      ],
      // The one-stomp orchestration is a transform INSIDE the RC-505 (§5.6):
      // it consumes the scene CC (track flip, not relayed), passes the ch16 PC
      // through soft-thru, and originates its own clock onto the out.
      routing: {
        consume: [{ port: 'midi_in', kind: 'midi', type: 'cc', channel: 5 }],
        pass: [{ port: 'midi_in', to: 'midi_out', kind: 'midi', type: 'pc' }],
        originate: [{ port: 'midi_out', kind: 'midi', type: 'clock' }],
        priority: 'midi>usb>internal',
      },
    },
    {
      id: 'am4',
      name: 'Fractal AM4',
      server_device_id: 'am4',
      roles: ['sound_source', 'effect'],
      identity: { manufacturer: 'Fractal', family: 'AM4' },
      ports: [
        { id: 'out_lr', kind: 'audio_out', audio: 'stereo' },
        { id: 'midi_out', kind: 'midi_din_out' },
      ],
    },
    {
      id: 'circuit',
      name: 'Circuit Tracks',
      server_device_id: 'circuit-tracks',
      roles: ['sequencer', 'sound_source'],
      identity: { manufacturer: 'Novation', family: 'Circuit Tracks' },
      ports: [
        { id: 'out_lr', kind: 'audio_out', audio: 'stereo' },
        { id: 'midi1', kind: 'midi_din_out' },
        { id: 'midi2', kind: 'midi_din_out' },
      ],
    },
    {
      id: 'spdsx',
      name: 'SPD-SX',
      server_device_id: 'spd-sx',
      roles: ['sampler', 'sound_source'],
      identity: { manufacturer: 'Roland', family: 'SPD-SX' },
      ports: [
        { id: 'out_lr', kind: 'audio_out', audio: 'stereo' },
        { id: 'midi_in', kind: 'midi_din_in' },
      ],
    },
    {
      id: 'thru',
      name: 'MIDI Thru box',
      server_device_id: null,
      roles: ['midi_router'],
      identity: { manufacturer: null, family: 'generic-thru' },
      ports: [
        { id: 'in', kind: 'midi_din_in' },
        { id: 'out1', kind: 'midi_din_out' },
        { id: 'out2', kind: 'midi_din_out' },
      ],
      capabilities: null,
    },
    {
      id: 'cab',
      name: 'Passive FRFR cab',
      server_device_id: null,
      roles: ['monitor'],
      identity: { manufacturer: null, family: 'passive-cab' },
      ports: [{ id: 'in', kind: 'audio_in', audio: 'stereo' }],
      capabilities: null,
    },
  ],
  edges: [
    {
      id: 'am4-audio',
      from: { node: 'am4', port: 'out_lr' },
      to: { node: 'rc505', port: 'main_in' },
      directed: true,
      physical_link_id: 'trs-1',
      signal: { kind: 'audio', channels: ['L', 'R'] },
    },
    {
      id: 'rc505-audio',
      from: { node: 'rc505', port: 'main_out' },
      to: { node: 'cab', port: 'in' },
      directed: true,
      physical_link_id: 'trs-2',
      signal: { kind: 'audio', channels: ['L', 'R'] },
    },
    {
      id: 'am4-scene-cc',
      from: { node: 'am4', port: 'midi_out' },
      to: { node: 'rc505', port: 'midi_in' },
      directed: true,
      physical_link_id: 'din-1',
      signal: { kind: 'midi', signals: [{ type: 'cc', channel: 5, cc_numbers: [80, 81, 82, 83] }] },
    },
    {
      id: 'rc505-clockhub',
      from: { node: 'rc505', port: 'midi_out' },
      to: { node: 'thru', port: 'in' },
      directed: true,
      physical_link_id: 'din-2',
      signal: { kind: 'midi', signals: [{ type: 'clock' }, { type: 'pc', channel: 16 }] },
    },
    {
      id: 'thru-to-circuit',
      from: { node: 'thru', port: 'out1' },
      to: { node: 'circuit', port: 'midi1' },
      directed: true,
      physical_link_id: 'din-3',
      signal: { kind: 'midi', signals: [{ type: 'clock' }, { type: 'pc', channel: 16 }] },
    },
    {
      id: 'circuit-to-spdsx',
      from: { node: 'circuit', port: 'midi2' },
      to: { node: 'spdsx', port: 'midi_in' },
      directed: true,
      physical_link_id: 'din-4',
      // ch4 = Circuit MIDI-2; note_map = SPD-SX GM pads; PC ch4 = kit recall.
      signal: {
        kind: 'midi',
        signals: [
          { type: 'note', channel: 4, note_map: { '36': 'kick', '38': 'snare', '42': 'hat', '46': 'openhat' } },
          { type: 'pc', channel: 4 },
        ],
      },
    },
  ],
};
