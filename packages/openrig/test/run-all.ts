/**
 * OpenRig L1 test suite. Self-contained golden runner (no framework): the §10
 * worked example must validate clean, and each validator check has a targeted
 * negative case. Run: `npm test` (tsx test/run-all.ts). Exits 1 on any failure.
 */
import {
  LOOPER_HUB_RIG, validateRig, bootstrapRig, toCytoscapeElements, summarizeSignal,
  checkRigCompatibility, checkAudioOutput, applyRigEdit, validateInventory, crossReferenceInventory,
  type Rig, type Binding, type CapabilityLookup, type CompatibilityReport,
  type DeviceSeed, type Inventory,
} from '../src/index.js';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

/** Deep clone the example so a mutation cannot leak between cases. */
function clone(): Rig {
  return JSON.parse(JSON.stringify(LOOPER_HUB_RIG)) as Rig;
}
function hasError(rig: Rig, code: string): boolean {
  return validateRig(rig).errors.some((e) => e.code === code);
}
function hasWarning(rig: Rig, code: string): boolean {
  return validateRig(rig).warnings.some((w) => w.code === code);
}

console.log('openrig L1 validator:');

// --- happy path: the §10 worked example validates clean ---
{
  const r = validateRig(LOOPER_HUB_RIG);
  check('§10 looper-hub example: no errors', r.errors.length === 0, JSON.stringify(r.errors));
  check('§10 looper-hub example: no warnings', r.warnings.length === 0, JSON.stringify(r.warnings));
  check('§10 looper-hub example: ok=true', r.ok === true);
}

// --- referential integrity ---
{
  const r = clone();
  r.edges[0].to.port = 'no-such-port';
  check('dangling endpoint -> error', hasError(r, 'dangling-endpoint'));
}
{
  const r = clone();
  r.nodes.push({ ...r.nodes[0] }); // duplicate rc505 id
  check('duplicate node id -> error', hasError(r, 'duplicate-node-id'));
}
{
  const r = clone();
  r.nodes[0].ports.push({ ...r.nodes[0].ports[0] }); // duplicate port id
  check('duplicate port id -> error', hasError(r, 'duplicate-port-id'));
}
{
  const r = clone();
  r.edges.push({ ...r.edges[0], id: r.edges[0].id }); // duplicate edge id
  check('duplicate edge id -> error', hasError(r, 'duplicate-edge-id'));
}

// --- port / signal compatibility (§3 invariant) ---
{
  const r = clone();
  // put a MIDI signal on the audio edge am4.out_lr -> rc505.main_in
  r.edges[0].signal = { kind: 'midi', signals: [{ type: 'pc', channel: 1 }] };
  check('midi signal on audio ports -> error', hasError(r, 'port-signal-mismatch'));
}

// --- channel rules (§3) ---
{
  const r = clone();
  // add a channel to the clock signal on rc505-clockhub
  const clockhub = r.edges.find((e) => e.id === 'rc505-clockhub')!;
  if (clockhub.signal.kind === 'midi') clockhub.signal.signals[0].channel = 10;
  check('channel on a clock signal -> error', hasError(r, 'channel-on-channelless'));
}
{
  const r = clone();
  const cc = r.edges.find((e) => e.id === 'am4-scene-cc')!;
  if (cc.signal.kind === 'midi') cc.signal.signals[0].channel = 17;
  check('channel out of range (17) -> error', hasError(r, 'bad-channel'));
}

// --- version contract ---
{
  const r = clone();
  r.openrig_version = '2.0';
  check('higher major version -> error', hasError(r, 'unsupported-major'));
}

// --- bindings (§4) ---
{
  const r = clone();
  r.edges[2].binding = 'no-such-binding';
  check('edge referencing an undeclared binding -> error', hasError(r, 'dangling-binding-ref'));
}
{
  const r = clone();
  r.bindings = [{
    id: 'b1',
    from: { node: 'ghost', emits: { node: 'ghost', type: 'cc', channel: 5, cc: 80 } },
    to: { node: 'rc505', expects: { node: 'rc505', type: 'cc', channel: 5, cc: 80 } },
  }];
  check('binding referencing a non-node -> error', hasError(r, 'binding-dangling-node'));
}
{
  const r = clone();
  // the inner BindingEnd node ref (emits.node) is checked, not only from.node
  r.bindings = [{
    id: 'b1',
    from: { node: 'rc505', emits: { node: 'ghost', type: 'cc', channel: 5, cc: 80 } },
    to: { node: 'rc505', expects: { node: 'rc505', type: 'cc', channel: 5, cc: 80 } },
  }];
  check('binding inner emits.node non-node -> error', hasError(r, 'binding-dangling-node'));
}
{
  const r = clone();
  // a governed signal references its binding PER-SIGNAL (MidiSignal.binding); an
  // undeclared per-signal ref must error, not only the top-level edge.binding.
  const midiEdge = r.edges.find((e) => e.signal.kind === 'midi')!;
  if (midiEdge.signal.kind === 'midi') midiEdge.signal.signals[0].binding = 'no-such-binding';
  check('per-signal binding ref undeclared -> error', hasError(r, 'dangling-binding-ref'));
}

// --- graph checks (§6) ---

/**
 * The example, re-cabled to close a MIDI ring: spdsx MIDI back into am4, so the
 * ch16 PC can travel am4 -> rc505 -> thru -> circuit -> spdsx -> am4 and round
 * again (the rc505's `pass` rule relays PC from midi_in to midi_out). Every node
 * on the ring except the rc505 leaves its routing UNDECLARED, so each is assumed
 * to soft-thru: this is a real loop.
 */
function loopRig(): Rig {
  const r = clone();
  r.nodes.find((n) => n.id === 'am4')!.ports.push({ id: 'midi_in', kind: 'midi_din_in' });
  r.nodes.find((n) => n.id === 'spdsx')!.ports.push({ id: 'midi_out', kind: 'midi_din_out' });
  r.edges.push({
    id: 'loop-back', from: { node: 'spdsx', port: 'midi_out' }, to: { node: 'am4', port: 'midi_in' },
    directed: true, signal: { kind: 'midi', signals: [{ type: 'cc', channel: 1 }] },
  });
  return r;
}

{
  check('MIDI feedback loop -> warning', hasWarning(loopRig(), 'midi-cycle'));
}
{
  // the warning names the signal that actually rings: only PC survives the
  // rc505's pass rule, so the CC / clock on the same cables are not the culprit.
  // The ring is entered at the first cable declaring it (rc505-clockhub).
  const w = validateRig(loopRig()).warnings.find((x) => x.code === 'midi-cycle');
  check('MIDI feedback loop -> names the ringing signal + path', w?.message.includes('a pc ch16 signal travels rc505 -> thru -> circuit -> spdsx -> am4 -> rc505') === true, w?.message);
}
{
  // routing-aware: the AM4 shape. A node that CONSUMES what arrives (and emits
  // its own traffic rather than echoing) terminates the path, so the ring drawn
  // through it is not a loop and must not warn.
  const r = loopRig();
  r.nodes.find((n) => n.id === 'am4')!.routing = { consume: [{ port: 'midi_in', kind: 'midi' }] };
  check('routing.consume breaks the ring -> no midi-cycle warning', !hasWarning(r, 'midi-cycle'),
    JSON.stringify(validateRig(r).warnings));
}
{
  // ...but a node that declares a matching `pass` really does relay it: still a loop.
  const r = loopRig();
  r.nodes.find((n) => n.id === 'am4')!.routing = {
    consume: [{ port: 'midi_in', kind: 'midi', type: 'cc' }],
    pass: [{ port: 'midi_in', to: 'midi_out', kind: 'midi', type: 'pc' }],
  };
  check('routing.pass relays -> midi-cycle warning stands', hasWarning(r, 'midi-cycle'));
}
{
  // the default is LOUD per-PORT: routing declared for some other port leaves
  // midi_in undeclared, so the node is still assumed to soft-thru.
  const r = loopRig();
  r.nodes.find((n) => n.id === 'am4')!.routing = { originate: [{ port: 'midi_out', kind: 'midi', type: 'cc' }] };
  check('routing on another port leaves this one unknown -> warning stands', hasWarning(r, 'midi-cycle'));
}
{
  const r = clone();
  r.nodes.find((n) => n.id === 'spdsx')!.roles.push('clock_follower'); // tagged follower, no clock edge reaches it
  check('orphaned clock follower -> warning', hasWarning(r, 'orphaned-clock-follower'));
}
{
  const r = clone();
  r.nodes.find((n) => n.id === 'circuit')!.roles.push('clock_master'); // second master
  check('two clock masters -> warning', hasWarning(r, 'multiple-clock-masters'));
}

// --- Phase B: bootstrap from device seeds (§6) ---
{
  const seeds: DeviceSeed[] = [
    { server_device_id: 'am4', name: 'Fractal AM4', roles: ['sound_source', 'effect'], transport: 'midi', has_audio: true, identity: { manufacturer: 'Fractal', family: 'AM4' } },
    { server_device_id: 'fm3', name: 'Fractal FM3', roles: ['sound_source'], transport: 'serial', has_audio: true },
    { server_device_id: 'rc-505mk2', name: 'RC-505mk2', roles: ['looper'], transport: 'hybrid' },
  ];
  const rig = bootstrapRig(seeds, { id: 'test-rig', name: 'Test rig' });
  check('bootstrap: one node per seed', rig.nodes.length === 3);
  check('bootstrap: no edges (human authors cables)', rig.edges.length === 0);
  check('bootstrap: node id == server_device_id', rig.nodes[0].id === 'am4' && rig.nodes[0].server_device_id === 'am4');
  check('bootstrap: midi transport -> din in/out + audio', rig.nodes[0].ports.map((p) => p.kind).join(',') === 'midi_din_in,midi_din_out,audio_out');
  check('bootstrap: serial transport -> usb_serial port', rig.nodes[1].ports.some((p) => p.kind === 'usb_serial'));
  check('bootstrap: hybrid transport -> usb_midi port', rig.nodes[2].ports.some((p) => p.kind === 'usb_midi'));
  check('bootstrap: result validates clean', validateRig(rig).errors.length === 0);
}

// --- Phase B: Cytoscape projection (§6) ---
{
  const cy = toCytoscapeElements(LOOPER_HUB_RIG);
  const deviceNodes = cy.nodes.filter((n) => n.classes.startsWith('device'));
  const portNodes = cy.nodes.filter((n) => n.classes.startsWith('port'));
  const portTotal = LOOPER_HUB_RIG.nodes.reduce((s, n) => s + n.ports.length, 0);
  check('cytoscape: one parent node per device', deviceNodes.length === LOOPER_HUB_RIG.nodes.length);
  check('cytoscape: a child node per port', portNodes.length === portTotal);
  check('cytoscape: one edge per rig edge', cy.edges.length === LOOPER_HUB_RIG.edges.length);
  check('cytoscape: ports parented to their device', portNodes.every((p) => typeof p.data.parent === 'string'));
  const sceneEdge = cy.edges.find((e) => e.data.id === 'am4-scene-cc');
  check('cytoscape: edge connects port child-nodes', sceneEdge?.data.source === 'am4::midi_out' && sceneEdge?.data.target === 'rc505::midi_in');
  check('cytoscape: opaque node flagged', cy.nodes.find((n) => n.data.id === 'cab')?.data.opaque === true);
}

// --- Phase B: signal summaries ---
check('summarize: CC range', summarizeSignal({ kind: 'midi', signals: [{ type: 'cc', channel: 5, cc_numbers: [80, 81, 82, 83] }] }) === 'CC 80-83 ch5');
check('summarize: clock + PC', summarizeSignal({ kind: 'midi', signals: [{ type: 'clock' }, { type: 'pc', channel: 16 }] }) === 'clock, PC ch16');
check('summarize: audio L/R', summarizeSignal({ kind: 'audio', channels: ['L', 'R'] }) === 'audio L/R');
check('summarize: note GM', summarizeSignal({ kind: 'midi', signals: [{ type: 'note', channel: 4, note_map: 'GM' }] }) === 'note ch4 (GM)');

// --- §4 cross-device compatibility check -----------------------------------
console.log('\nopenrig compatibility check:');

// A mock capability lookup mirroring the shipped descriptors: the RC-505mk2's
// legal assignable-CC source set (CTL + CC#64-95) + decoded targets, the SPD-SX
// GM pad voice_map (all 9 roles, so a "GM" note map reads clean), and the
// Circuit's outward track channels.
const ccRange = (lo: number, hi: number): number[] =>
  Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const MOCK_CAPS: CapabilityLookup = {
  get(sid) {
    if (sid === 'rc-505mk2') {
      return { label: 'RC-505mk2', assignable_cc: ccRange(64, 95), control_targets: ['TRK3 REC/PLY', 'TRK2 PLY/STP', 'TRK3 STOP'] };
    }
    if (sid === 'spd-sx') {
      return {
        label: 'SPD-SX',
        voice_map: {
          kick: { channel: 10, note: 36 }, snare: { channel: 10, note: 38 }, hat: { channel: 10, note: 42 },
          openhat: { channel: 10, note: 46 }, clap: { channel: 10, note: 39 }, tom: { channel: 10, note: 45 },
          ride: { channel: 10, note: 51 }, crash: { channel: 10, note: 49 }, perc: { channel: 10, note: 56 },
        },
      };
    }
    if (sid === 'circuit-tracks') return { label: 'Circuit Tracks', external_tracks: { midi1: 3, midi2: 4 } };
    return undefined;
  },
};

/** The three healthy bindings the real rig uses (looper trigger, part select, drum map). */
function healthyBindings(): Binding[] {
  return [
    {
      id: 'looper_track3_trigger',
      from: { node: 'am4', emits: { node: 'am4', type: 'cc', channel: 5, cc: 80 } },
      to: { node: 'rc505', expects: { node: 'rc505', type: 'cc', channel: 5, cc: 80, target: 'TRK3 REC/PLY' } },
    },
    {
      id: 'song_part_select',
      from: { node: 'am4', emits: { node: 'am4', type: 'pc', channel: 16 } },
      to: { node: 'circuit', expects: { node: 'circuit', type: 'pc', channel: 16 } },
    },
    {
      id: 'drum_note_map',
      from: { node: 'circuit', emits: { node: 'circuit', type: 'note', channel: 4, note_map: 'GM' } },
      to: { node: 'spdsx', expects: { node: 'spdsx', type: 'note', channel: 4, note_map: 'GM' } },
    },
  ];
}
function rigWith(bindings: Binding[]): Rig {
  const r = clone();
  r.bindings = bindings;
  return r;
}
function byId(rep: CompatibilityReport, id: string) {
  return rep.bindings.find((b) => b.id === id)!;
}

// happy path: the three real-rig bindings + the mock caps -> all consistent
{
  const rep = checkRigCompatibility(rigWith(healthyBindings()), { capabilities: MOCK_CAPS });
  check('compat: healthy rig ok=true', rep.ok === true, JSON.stringify(rep.issues));
  check('compat: all three bindings consistent', rep.bindings.every((b) => b.status === 'consistent'));
  check('compat: looper trigger capability passed (CC#80 legal + target known)', byId(rep, 'looper_track3_trigger').capability === 'passed');
  check('compat: drum note map capability passed (GM pads all present)', byId(rep, 'drum_note_map').capability === 'passed');
  check('compat: PC part-select has no capability check', byId(rep, 'song_part_select').capability === 'not_applicable');
  check('compat: checked_capabilities flag set', rep.checked_capabilities === true);
}

// the §10 example (no bindings) -> ok, empty
{
  const rep = checkRigCompatibility(LOOPER_HUB_RIG);
  check('compat: no-binding rig ok=true, empty', rep.ok === true && rep.bindings.length === 0);
}

// TIER 1: the two ends must AGREE
{
  const b = healthyBindings();
  b[0].to.expects.channel = 6; // sender ch5, receiver ch6
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: channel mismatch -> error + mismatch', rep.ok === false
    && rep.issues.some((i) => i.code === 'binding-channel-mismatch')
    && byId(rep, 'looper_track3_trigger').status === 'mismatch');
}
{
  const b = healthyBindings();
  b[0].to.expects.cc = 81; // emits 80, expects 81
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: CC mismatch -> error', rep.issues.some((i) => i.code === 'binding-cc-mismatch'));
}
{
  const b = healthyBindings();
  b[1].to.expects.type = 'cc'; // emits pc, expects cc
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: type mismatch -> error', rep.issues.some((i) => i.code === 'binding-type-mismatch'));
}
{
  const b = healthyBindings();
  b[2].to.expects.note_map = { '36': 'kick' }; // emits GM, expects a different map
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: note-map mismatch -> error', rep.issues.some((i) => i.code === 'binding-notemap-mismatch'));
}

// TIER 3: capability legality (the §4 headline)
{
  const b = healthyBindings();
  b[0].from.emits.cc = 40; b[0].to.expects.cc = 40; // agreed, but CC#40 is not an RC-505 assignable source
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: illegal assign source CC -> error + capability failed', rep.ok === false
    && rep.issues.some((i) => i.code === 'assign-source-illegal')
    && byId(rep, 'looper_track3_trigger').capability === 'failed'
    && byId(rep, 'looper_track3_trigger').status === 'mismatch');
}
{
  const b = healthyBindings();
  b[2].from.emits.note_map = { '36': 'kick', '99': 'nope' };
  b[2].to.expects.note_map = { '36': 'kick', '99': 'nope' }; // 36 maps, 99 has no SPD-SX pad
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: note PARTIALLY unmapped -> warned (not passed), still consistent', rep.issues.some((i) => i.code === 'note-no-pad')
    && byId(rep, 'drum_note_map').capability === 'warned'
    && byId(rep, 'drum_note_map').status === 'consistent');
}
{
  const b = healthyBindings();
  b[2].from.emits.note_map = { '98': 'x', '99': 'y' };
  b[2].to.expects.note_map = { '98': 'x', '99': 'y' }; // NEITHER note maps to a pad
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: note FULLY unmapped -> failed + mismatch', byId(rep, 'drum_note_map').capability === 'failed'
    && byId(rep, 'drum_note_map').status === 'mismatch' && rep.ok === false);
}
{
  const b = healthyBindings();
  b[2].from.emits.channel = 7; // Circuit tracks transmit on ch3/ch4, not ch7
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: sender channel not a sequencer track -> warned', rep.issues.some((i) => i.code === 'sender-channel-not-a-track')
    && byId(rep, 'drum_note_map').capability === 'warned');
}
{
  // a CC to a receiver that HAS a descriptor but no assignable-CC gate (a synth
  // receiving the CC directly) is not_applicable, NOT unavailable (rev finding #3)
  const b: Binding[] = [{
    id: 'cc-to-circuit',
    from: { node: 'am4', emits: { node: 'am4', type: 'cc', channel: 5, cc: 80 } },
    to: { node: 'circuit', expects: { node: 'circuit', type: 'cc', channel: 5, cc: 80 } },
  }];
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: CC to a non-assignable-CC device -> not_applicable', byId(rep, 'cc-to-circuit').capability === 'not_applicable');
}
{
  // under-specified: a CC contract that names no CC number is not addressable (rev #2)
  const b: Binding[] = [{
    id: 'no-cc',
    from: { node: 'am4', emits: { node: 'am4', type: 'cc', channel: 5 } },
    to: { node: 'rc505', expects: { node: 'rc505', type: 'cc', channel: 5 } },
  }];
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: CC contract with no CC number -> binding-cc-missing warning', rep.issues.some((i) => i.code === 'binding-cc-missing'));
}
{
  // pc program-value mismatch is a real break (rev #4)
  const b: Binding[] = [{
    id: 'pc-vals',
    from: { node: 'am4', emits: { node: 'am4', type: 'pc', channel: 16, values: [5] } },
    to: { node: 'circuit', expects: { node: 'circuit', type: 'pc', channel: 16, values: [10] } },
  }];
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: pc value mismatch -> error', rep.issues.some((i) => i.code === 'binding-values-mismatch') && rep.ok === false);
}
{
  // a channelless end with an out-of-range channel yields ONE error, not two (rev #8)
  const b: Binding[] = [{
    id: 'bad-clock2',
    from: { node: 'rc505', emits: { node: 'rc505', type: 'clock', channel: 99 } },
    to: { node: 'am4', expects: { node: 'am4', type: 'clock' } },
  }];
  const rep = checkRigCompatibility(rigWith(b));
  check('compat: channelless + bad channel -> only channel-on-channelless (not also bad-channel)',
    rep.issues.some((i) => i.code === 'binding-channel-on-channelless')
    && !rep.issues.some((i) => i.code === 'binding-bad-channel'));
}

// TIER 2/3 on UNGOVERNED cables: an illegal mapping is illegal however authored
{
  // `edit_rig add_cable am4 -> rc505 cc 40`: no binding, but CC#40 is still not
  // an RC-505 assignable source. Same code as the binding pass, keyed by edge.
  const r = clone();
  const e = r.edges.find((x) => x.id === 'am4-scene-cc')!;
  if (e.signal.kind === 'midi') e.signal.signals[0].cc_numbers = [40];
  const rep = checkRigCompatibility(r, { capabilities: MOCK_CAPS });
  const issue = rep.issues.find((i) => i.code === 'assign-source-illegal');
  check('cable: ungoverned illegal CC -> error', rep.ok === false && issue !== undefined);
  check('cable: issue is keyed by edge, not binding', issue?.ref === 'am4-scene-cc' && issue?.binding === undefined);
  check('cable: message names the device + legal set', issue?.message.includes('RC-505mk2') === true
    && issue?.message.includes('64-95') === true, issue?.message);
}
{
  // the legal CCs the example already carries stay silent (no new false positive)
  const rep = checkRigCompatibility(clone(), { capabilities: MOCK_CAPS });
  check('cable: legal CCs (80-83) -> clean', rep.ok === true && rep.issues.length === 0, JSON.stringify(rep.issues));
}
{
  // only the illegal members of a mixed set are named
  const r = clone();
  const e = r.edges.find((x) => x.id === 'am4-scene-cc')!;
  if (e.signal.kind === 'midi') e.signal.signals[0].cc_numbers = [80, 40, 82];
  const rep = checkRigCompatibility(r, { capabilities: MOCK_CAPS });
  const msg = rep.issues.find((i) => i.code === 'assign-source-illegal')?.message ?? '';
  check('cable: names only the illegal CC of a mixed set', msg.includes('CC#40') && !msg.includes('CC#80'), msg);
}
{
  // a GOVERNED signal is the binding's to check: exactly one report, not two
  const b = healthyBindings();
  b[0].from.emits.cc = 40; b[0].to.expects.cc = 40;
  const r = rigWith(b);
  const e = r.edges.find((x) => x.id === 'am4-scene-cc')!;
  if (e.signal.kind === 'midi') { e.signal.signals[0].cc_numbers = [40]; e.signal.signals[0].binding = 'looper_track3_trigger'; }
  const rep = checkRigCompatibility(r, { capabilities: MOCK_CAPS });
  check('cable: governed signal not double-reported', rep.issues.filter((i) => i.code === 'assign-source-illegal').length === 1);
}
{
  // a RELAYED signal is not the relay's to reject: the rc505 soft-thrus this CC
  // to something downstream, so its own assignable-CC set does not bound it
  const r = clone();
  r.nodes.find((n) => n.id === 'rc505')!.routing!.pass!.push({ port: 'midi_in', to: 'midi_out', kind: 'midi', type: 'cc', channel: 9 });
  const e = r.edges.find((x) => x.id === 'am4-scene-cc')!;
  if (e.signal.kind === 'midi') e.signal.signals[0] = { type: 'cc', channel: 9, cc_numbers: [40] };
  const rep = checkRigCompatibility(r, { capabilities: MOCK_CAPS });
  check('cable: a passed-through CC is not gated by the relay', !rep.issues.some((i) => i.code === 'assign-source-illegal'),
    JSON.stringify(rep.issues));
}
{
  // the note gate applies to cables too: an unmapped note has no SPD-SX pad
  const r = clone();
  const e = r.edges.find((x) => x.id === 'circuit-to-spdsx')!;
  if (e.signal.kind === 'midi') e.signal.signals[0].note_map = { '36': 'kick', '99': 'nope' };
  const rep = checkRigCompatibility(r, { capabilities: MOCK_CAPS });
  check('cable: note with no pad -> warning', rep.issues.some((i) => i.code === 'note-no-pad' && i.ref === 'circuit-to-spdsx'));
}
{
  // a disabled cable is not live, so it is not checked
  const r = clone();
  const e = r.edges.find((x) => x.id === 'am4-scene-cc')!;
  e.enabled = false;
  if (e.signal.kind === 'midi') e.signal.signals[0].cc_numbers = [40];
  const rep = checkRigCompatibility(r, { capabilities: MOCK_CAPS });
  check('cable: disabled cable is not legality-checked', rep.ok === true);
}
{
  // without a capability lookup there is nothing to check against
  const r = clone();
  const e = r.edges.find((x) => x.id === 'am4-scene-cc')!;
  if (e.signal.kind === 'midi') e.signal.signals[0].cc_numbers = [40];
  check('cable: no lookup -> no cable legality check', checkRigCompatibility(r).ok === true);
}

// capability outcome without data / without a lookup
{
  // bind a CC to the opaque thru box (server_device_id: null) -> unavailable
  const b: Binding[] = [{
    id: 'to-opaque',
    from: { node: 'am4', emits: { node: 'am4', type: 'cc', channel: 5, cc: 80 } },
    to: { node: 'thru', expects: { node: 'thru', type: 'cc', channel: 5, cc: 80 } },
  }];
  const rep = checkRigCompatibility(rigWith(b), { capabilities: MOCK_CAPS });
  check('compat: CC to opaque receiver -> capability unavailable, still consistent', byId(rep, 'to-opaque').capability === 'unavailable'
    && byId(rep, 'to-opaque').status === 'consistent');
}
{
  const rep = checkRigCompatibility(rigWith(healthyBindings())); // no capabilities passed
  check('compat: no lookup -> checked_capabilities false', rep.checked_capabilities === false);
  check('compat: no lookup -> CC binding capability unavailable', byId(rep, 'looper_track3_trigger').capability === 'unavailable');
  check('compat: no lookup -> PC binding capability not_applicable', byId(rep, 'song_part_select').capability === 'not_applicable');
  check('compat: no lookup still validates agreement (ok=true)', rep.ok === true);
}

// TIER 1c: governed-edge projection drift
{
  const r = clone();
  r.bindings = [{
    id: 'scene-cc',
    from: { node: 'am4', emits: { node: 'am4', type: 'cc', channel: 5, cc: 80 } },
    to: { node: 'rc505', expects: { node: 'rc505', type: 'cc', channel: 5, cc: 80 } },
  }];
  const edge = r.edges.find((e) => e.id === 'am4-scene-cc')!;
  if (edge.signal.kind === 'midi') {
    edge.signal.signals[0].binding = 'scene-cc';
    edge.signal.signals[0].channel = 6; // drift: edge says ch6, binding says ch5
  }
  const rep = checkRigCompatibility(r, { capabilities: MOCK_CAPS });
  check('compat: governed-edge drift -> warning with edge ref', rep.issues.some((i) => i.code === 'governed-edge-drift' && i.ref === 'am4-scene-cc'));
}
{
  // a minimal governed signal that OMITS channel/cc (projects from the binding)
  // is not "drift" — it is projecting-minimal, so it must not be flagged (rev #7)
  const r = clone();
  r.bindings = [{
    id: 'scene-cc2',
    from: { node: 'am4', emits: { node: 'am4', type: 'cc', channel: 5, cc: 80 } },
    to: { node: 'rc505', expects: { node: 'rc505', type: 'cc', channel: 5, cc: 80 } },
  }];
  const edge = r.edges.find((e) => e.id === 'am4-scene-cc')!;
  if (edge.signal.kind === 'midi') edge.signal.signals[0] = { type: 'cc', binding: 'scene-cc2' };
  const rep = checkRigCompatibility(r, { capabilities: MOCK_CAPS });
  check('compat: minimal projecting edge (omits channel/cc) -> NO drift', !rep.issues.some((i) => i.code === 'governed-edge-drift'));
}

// TIER 1b: a channel on a channelless binding end
{
  const b: Binding[] = [{
    id: 'bad-clock',
    from: { node: 'rc505', emits: { node: 'rc505', type: 'clock', channel: 5 } },
    to: { node: 'am4', expects: { node: 'am4', type: 'clock' } },
  }];
  const rep = checkRigCompatibility(rigWith(b));
  check('compat: channel on a channelless (clock) end -> error', rep.issues.some((i) => i.code === 'binding-channel-on-channelless'));
}

// --- audio-output check: will each instrument be heard ---------------------
console.log('\nopenrig audio-output check:');
function statusOf(rep: ReturnType<typeof checkAudioOutput>, id: string) {
  return rep.instruments.find((i) => i.id === id)?.status;
}

// §10 example: am4 reaches the cab (monitor); circuit + spdsx have audio outs
// but no audio cable leaves them (the minimal example wires only MIDI for them).
{
  const rep = checkAudioOutput(LOOPER_HUB_RIG);
  check('audio: has an output node (the cab)', rep.has_output_node === true);
  check('audio: am4 reaches the output', statusOf(rep, 'am4') === 'reaches_output');
  check('audio: circuit is unpatched (no_output)', statusOf(rep, 'circuit') === 'no_output');
  check('audio: spdsx is unpatched (no_output)', statusOf(rep, 'spdsx') === 'no_output');
  check('audio: two no-output warnings, ok=false', rep.ok === false
    && rep.issues.filter((i) => i.code === 'instrument-no-audio-output').length === 2);
  check('audio: the mixer/looper (rc505) is not treated as an instrument', rep.instruments.every((i) => i.id !== 'rc505'));
}

// fully patch circuit + spdsx to the looper -> everyone reaches the cab
{
  const r = clone();
  r.edges.push({ id: 'circuit-audio', from: { node: 'circuit', port: 'out_lr' }, to: { node: 'rc505', port: 'main_in' }, directed: true, signal: { kind: 'audio', channels: ['L', 'R'] } });
  r.edges.push({ id: 'spdsx-audio', from: { node: 'spdsx', port: 'out_lr' }, to: { node: 'rc505', port: 'main_in' }, directed: true, signal: { kind: 'audio', channels: ['L', 'R'] } });
  const rep = checkAudioOutput(r);
  check('audio: fully patched -> ok=true, all reach output', rep.ok === true
    && rep.instruments.every((i) => i.status === 'reaches_output'));
}

// a disabled audio edge does not count (parked wiring)
{
  const r = clone();
  const amAudio = r.edges.find((e) => e.id === 'am4-audio')!;
  amAudio.enabled = false; // "unplug" the AM4's only audio out
  const rep = checkAudioOutput(r);
  check('audio: disabled edge does not count -> am4 no_output', statusOf(rep, 'am4') === 'no_output');
}

// dead-end: audio is patched but the chain never reaches a monitor
{
  const r: Rig = {
    openrig_version: '0.1', id: 'dead', name: 'Dead-end rig',
    nodes: [
      { id: 'synth', name: 'Synth', server_device_id: null, identity: { manufacturer: null, family: 'synth' }, roles: ['sound_source'], ports: [{ id: 'out', kind: 'audio_out' }] },
      { id: 'box', name: 'DI box', server_device_id: null, identity: { manufacturer: null, family: 'di' }, roles: ['audio_interface'], ports: [{ id: 'in', kind: 'audio_in' }, { id: 'out', kind: 'audio_out' }], capabilities: null },
      { id: 'pa', name: 'PA', server_device_id: null, identity: { manufacturer: null, family: 'pa' }, roles: ['monitor'], ports: [{ id: 'in', kind: 'audio_in' }], capabilities: null },
    ],
    edges: [
      { id: 'synth-to-box', from: { node: 'synth', port: 'out' }, to: { node: 'box', port: 'in' }, directed: true, signal: { kind: 'audio', channels: ['M'] } },
      // box -> pa is NOT patched, so the synth dead-ends at the box
    ],
  };
  const rep = checkAudioOutput(r);
  check('audio: patched-but-dead-ends -> dead_end + warning', statusOf(rep, 'synth') === 'dead_end'
    && rep.issues.some((i) => i.code === 'instrument-audio-dead-end'));
}

// no output node declared -> reachability can't be judged, flagged honestly
{
  const r = clone();
  r.nodes.find((n) => n.id === 'cab')!.roles = ['effect']; // strip the only monitor role
  const rep = checkAudioOutput(r);
  check('audio: no monitor node -> has_output_node false', rep.has_output_node === false);
  check('audio: no monitor node -> patched instrument not falsely dead-ended', statusOf(rep, 'am4') === 'reaches_output');
}

// an instrument that is its OWN output (built-in speakers) is not "unheard"
{
  const r = clone();
  r.nodes.find((n) => n.id === 'circuit')!.roles = ['sound_source', 'monitor']; // workstation w/ speakers
  const rep = checkAudioOutput(r);
  check('audio: instrument that is its own monitor -> reaches_output', statusOf(rep, 'circuit') === 'reaches_output');
}

// --- structured edit (applyRigEdit) ---------------------------------------
console.log('\nopenrig edit:');
// add_cable: connect the circuit's audio out to the rc505 (both exist in §10).
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'circuit', to: 'rc505', kind: 'audio' });
  check('edit: add_cable ok + returns a new rig', r.ok === true && r.rig !== undefined);
  check('edit: add_cable is immutable (input untouched)', LOOPER_HUB_RIG.edges.every((e) => e.id !== r.edge_id));
  check('edit: add_cable result validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0);
  check('edit: add_cable created the edge with audio signal', r.rig !== undefined
    && r.rig.edges.some((e) => e.id === r.edge_id && e.signal.kind === 'audio'));
}
// add_cable resolves a device by display NAME + auto-creates a missing port.
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'SPD-SX', to: 'RC-505mk2', kind: 'audio' });
  check('edit: add_cable resolves by display name', r.ok === true
    && r.rig !== undefined && r.rig.edges.some((e) => e.from.node === 'spdsx' && e.to.node === 'rc505'));
}
// add_cable a governed-shaped MIDI cable
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'am4', to: 'rc505', kind: 'midi', midi_type: 'cc', channel: 5, cc: [80] });
  const e = r.rig?.edges.find((x) => x.id === r.edge_id);
  check('edit: add_cable midi carries the signal', e?.signal.kind === 'midi'
    && e.signal.kind === 'midi' && e.signal.signals[0].type === 'cc' && e.signal.signals[0].channel === 5);
}
// unknown device -> error, no rig
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'nope', to: 'rc505', kind: 'audio' });
  check('edit: add_cable unknown device -> error', r.ok === false && r.rig === undefined && /no device/.test(r.error ?? ''));
}
// remove_cable by id
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_cable', cable_id: 'am4-scene-cc' });
  check('edit: remove_cable by id', r.ok === true && r.rig !== undefined && !r.rig.edges.some((e) => e.id === 'am4-scene-cc'));
}
// remove_cable by from/to/kind
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_cable', from: 'am4', to: 'rc505', kind: 'audio' });
  check('edit: remove_cable by from/to/kind', r.ok === true && r.rig !== undefined && !r.rig.edges.some((e) => e.id === 'am4-audio'));
}
// remove_cable no match -> error
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_cable', cable_id: 'ghost' });
  check('edit: remove_cable no match -> error', r.ok === false && /no cable/.test(r.error ?? ''));
}
// set_cable_enabled toggles
{
  const off = applyRigEdit(LOOPER_HUB_RIG, { op: 'set_cable_enabled', cable_id: 'am4-audio', enabled: false });
  check('edit: set_cable_enabled false', off.ok === true && off.rig?.edges.find((e) => e.id === 'am4-audio')?.enabled === false);
  const on = applyRigEdit(off.rig!, { op: 'set_cable_enabled', cable_id: 'am4-audio', enabled: true });
  check('edit: set_cable_enabled true clears the flag', on.ok === true && on.rig?.edges.find((e) => e.id === 'am4-audio')?.enabled === undefined);
}

// --- inventory (owned gear) + rig cross-reference (§11) ---------------------
console.log('\nopenrig inventory:');
function inv(): Inventory {
  return {
    openrig_version: '0.1', id: 'test-inv', name: 'Test inventory',
    devices: [
      { id: 'am4', name: 'Fractal AM4', identity: { manufacturer: 'Fractal', family: 'AM4' }, server_device_id: 'am4' },
      { id: 'circuit', name: 'Circuit Tracks', identity: { manufacturer: 'Novation', family: 'Circuit Tracks' }, server_device_id: 'circuit-tracks' },
      { id: 'commander', name: 'MIDI Commander', identity: { manufacturer: 'MeloAudio', family: 'MIDI Commander' }, server_device_id: null },
      { id: 'fm3', name: 'Fractal FM3', identity: { manufacturer: 'Fractal', family: 'FM3' }, server_device_id: 'fm3', count: 1 },
    ],
  };
}
{
  const v = validateInventory(inv());
  check('inventory: happy validates clean', v.ok === true && v.errors.length === 0);
}
{
  const i = inv(); i.devices.push({ ...i.devices[0] }); // duplicate am4 id
  check('inventory: duplicate id -> error', validateInventory(i).errors.some((e) => e.code === 'duplicate-device-id'));
}
{
  const i = inv(); i.devices[0].count = 0;
  check('inventory: bad count -> error', validateInventory(i).errors.some((e) => e.code === 'bad-count'));
}
{
  const i = inv(); i.devices.push({ id: 'x', name: 'X', identity: { manufacturer: undefined as unknown as string, family: undefined as unknown as string } });
  check('inventory: missing identity -> warning', validateInventory(i).warnings.some((w) => w.code === 'missing-identity'));
}
// cross-reference against the §10 rig (has am4 + circuit; not commander/fm3)
{
  const rep = crossReferenceInventory(inv(), LOOPER_HUB_RIG);
  check('inventory: am4 + circuit are in_rig', rep.in_rig === 2
    && rep.devices.find((d) => d.id === 'am4')?.status === 'in_rig'
    && rep.devices.find((d) => d.id === 'am4')?.in_rig_nodes.includes('am4') === true);
  check('inventory: commander + fm3 are spare', rep.spare === 2
    && rep.devices.find((d) => d.id === 'commander')?.status === 'spare');
  check('inventory: rig devices not owned are listed', rep.rig_devices_not_in_inventory.includes('rc505')
    && rep.rig_devices_not_in_inventory.includes('cab'));
}

console.log(failures === 0 ? '\nopenrig: all checks passed' : `\nopenrig: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
