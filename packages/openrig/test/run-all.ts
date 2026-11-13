/**
 * OpenRig L1 test suite. Self-contained golden runner (no framework): the §10
 * worked example must validate clean, and each validator check has a targeted
 * negative case. Run: `npm test` (tsx test/run-all.ts). Exits 1 on any failure.
 */
import {
  LOOPER_HUB_RIG, validateRig, bootstrapRig, toCytoscapeElements, summarizeSignal,
  checkRigCompatibility, checkAudioOutput, checkRigCapacity, rankAttachments,
  applyRigEdit, validateInventory, crossReferenceInventory,
  buildRigView, renderRigText,
  validateRepertoire, validatePerformance, planSong, planPerformance,
  type Song, type Repertoire, type Performance,
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
// add_cable a governed-shaped MIDI cable. am4.midi_out -> rc505.midi_in is
// ALREADY cabled in §10, so an implicit second cable is refused (a jack takes
// one plug); the same cable as a [planned] re-cable on named jacks is allowed.
{
  const busy = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'am4', to: 'rc505', kind: 'midi', midi_type: 'cc', channel: 5, cc: [80] });
  check('edit: add_cable onto a busy jack (implicit) is refused, naming the occupant',
    busy.ok === false && /no free MIDI output: midi_out \(am4-scene-cc\)/.test(busy.error ?? '') && /from_port/.test(busy.error ?? ''), busy.error);
  const live = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'am4', to: 'rc505', kind: 'midi', from_port: 'midi_out', to_port: 'midi_in', midi_type: 'cc', channel: 5, cc: [80] });
  check('edit: add_cable LIVE onto a named busy jack is refused (one plug)',
    live.ok === false && /already holds live cable am4-scene-cc/.test(live.error ?? ''), live.error);
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'am4', to: 'rc505', kind: 'midi', from_port: 'midi_out', to_port: 'midi_in', midi_type: 'cc', channel: 5, cc: [80], enabled: false });
  const e = r.rig?.edges.find((x) => x.id === r.edge_id);
  check('edit: add_cable midi carries the signal', e?.signal.kind === 'midi'
    && e.signal.kind === 'midi' && e.signal.signals[0].type === 'cc' && e.signal.signals[0].channel === 5);
  check('edit: a [planned] cable on a busy named jack warns (re-cable in progress)',
    r.warnings?.length === 2 && r.warnings.every((w) => /still holds live cable am4-scene-cc/.test(w)), JSON.stringify(r.warnings));
  check('edit: the [planned] re-cable leaves the rig free of double-booking',
    r.rig !== undefined && !validateRig(r.rig).warnings.some((w) => w.code === 'port-double-booked'));
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
// set_cable_enabled full template (the arm the switch conversion made explicit:
// it was the unguarded fall-through default of the old if-chain)
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'set_cable_enabled', cable_id: 'am4-audio', enabled: false });
  check('edit: set_cable_enabled ok + returns a new rig', r.ok === true && r.rig !== undefined && r.edge_id === 'am4-audio');
  check('edit: set_cable_enabled is immutable (input untouched)',
    LOOPER_HUB_RIG.edges.find((e) => e.id === 'am4-audio')?.enabled === undefined);
  check('edit: set_cable_enabled result validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0);
  check('edit: set_cable_enabled mutation landed', r.rig?.edges.find((e) => e.id === 'am4-audio')?.enabled === false);
}
// set_cable_enabled unknown cable -> its own error (not another arm's)
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'set_cable_enabled', cable_id: 'ghost', enabled: false });
  check('edit: set_cable_enabled unknown cable -> error', r.ok === false && r.rig === undefined
    && /no cable with id "ghost"/.test(r.error ?? ''));
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

// --- edit: device (node) add/remove ---
console.log('\nopenrig edit (devices):');
{
  const r = applyRigEdit(LOOPER_HUB_RIG, {
    op: 'add_device', id: 'mf', name: 'Test Synth', roles: ['sound_source'],
    manufacturer: 'Arturia', family: 'MicroFreak',
    ports: [{ id: 'midi_in', kind: 'midi_din_in' }, { id: 'out', kind: 'audio_out', audio: 'mono' }],
    note: '[planned] not cabled yet',
  });
  check('edit: add_device adds the node', r.ok === true && r.node_id === 'mf'
    && r.rig?.nodes.some((n) => n.id === 'mf') === true);
  check('edit: add_device adds NO cables (cabling is a separate decision)',
    r.rig?.edges.length === LOOPER_HUB_RIG.edges.length);
  check('edit: added device still validates clean', validateRig(r.rig as Rig).errors.length === 0);
  check('edit: add_device does not mutate the input',
    LOOPER_HUB_RIG.nodes.some((n) => n.id === 'mf') === false);
}
{
  const dup = applyRigEdit(LOOPER_HUB_RIG, {
    op: 'add_device', id: LOOPER_HUB_RIG.nodes[0].id, name: 'Clash', roles: ['sound_source'],
  });
  check('edit: add_device rejects a colliding id', dup.ok === false && dup.error?.includes('already in this rig') === true);
}
{
  const noRole = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_device', id: 'x', name: 'X', roles: [] });
  check('edit: add_device requires at least one role', noRole.ok === false);
}
{
  // Removing a device must take its cables with it, or the rig no longer validates.
  const victim = LOOPER_HUB_RIG.edges[0].to.node;
  const before = LOOPER_HUB_RIG.edges.filter((e) => e.from.node === victim || e.to.node === victim).length;
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_device', device: victim });
  check('edit: remove_device drops the node', r.ok === true
    && r.rig?.nodes.some((n) => n.id === victim) === false);
  check('edit: remove_device drops every cable touching it', r.removed_edge_ids?.length === before);
  check('edit: rig still validates after remove_device (no dangling endpoints)',
    validateRig(r.rig as Rig).errors.length === 0, JSON.stringify(validateRig(r.rig as Rig).errors));
}
{
  const miss = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_device', device: 'nope' });
  check('edit: remove_device unknown device -> error', miss.ok === false);
}

// --- edit: update_cable (§8: modify in place, id preserved) -----------------
console.log('\nopenrig edit (update_cable):');
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_cable', cable_id: 'am4-scene-cc', channel: 3, cc: [20, 21] });
  check('edit: update_cable ok + returns a new rig', r.ok === true && r.rig !== undefined && r.edge_id === 'am4-scene-cc');
  check('edit: update_cable is immutable (input untouched)', (() => {
    const sig = LOOPER_HUB_RIG.edges.find((e) => e.id === 'am4-scene-cc')!.signal;
    return sig.kind === 'midi' && sig.signals[0].channel === 5;
  })());
  check('edit: update_cable result validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0);
  const sig = r.rig?.edges.find((e) => e.id === 'am4-scene-cc')?.signal;
  check('edit: update_cable patched channel + cc in place', sig?.kind === 'midi'
    && sig.signals[0].channel === 3 && JSON.stringify(sig.signals[0].cc_numbers) === '[20,21]');
  check('edit: update_cable preserved the edge id + link id (modify, not delete+add)',
    r.rig?.edges.find((e) => e.id === 'am4-scene-cc')?.physical_link_id === 'din-1');
}
{
  // Patching to a channelless type drops the channel (validateRig would reject it).
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_cable', cable_id: 'am4-scene-cc', midi_type: 'clock' });
  const sig = r.rig?.edges.find((e) => e.id === 'am4-scene-cc')?.signal;
  check('edit: update_cable to a channelless type drops the channel', r.ok === true
    && sig?.kind === 'midi' && sig.signals[0].type === 'clock' && sig.signals[0].channel === undefined);
  check('edit: channelless patch still validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0);
}
{
  // signal_index picks one signal on a multi-signal cable (rc505-clockhub: clock + pc).
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_cable', cable_id: 'rc505-clockhub', signal_index: 1, channel: 12 });
  const sig = r.rig?.edges.find((e) => e.id === 'rc505-clockhub')?.signal;
  check('edit: update_cable signal_index patches only that signal', r.ok === true
    && sig?.kind === 'midi' && sig.signals[1].channel === 12 && sig.signals[0].channel === undefined);
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_cable', cable_id: 'am4-audio', audio_channels: ['M'] });
  const sig = r.rig?.edges.find((e) => e.id === 'am4-audio')?.signal;
  check('edit: update_cable audio_channels patches an audio edge', r.ok === true
    && sig?.kind === 'audio' && JSON.stringify(sig.channels) === '["M"]');
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_cable', cable_id: 'ghost', channel: 3 });
  check('edit: update_cable unknown cable -> error', r.ok === false && /no cable with id "ghost"/.test(r.error ?? ''));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_cable', cable_id: 'am4-audio', channel: 3 });
  check('edit: update_cable midi field on an audio edge -> error', r.ok === false && /carries audio, not MIDI/.test(r.error ?? ''));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_cable', cable_id: 'am4-scene-cc', audio_channels: ['L', 'R'] });
  check('edit: update_cable audio_channels on a midi edge -> error', r.ok === false && /carries midi, not audio/.test(r.error ?? ''));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_cable', cable_id: 'am4-scene-cc', signal_index: 9, channel: 3 });
  check('edit: update_cable signal_index out of range -> error', r.ok === false && /signal_index 9 does not exist/.test(r.error ?? ''));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_cable', cable_id: 'am4-scene-cc' });
  check('edit: update_cable with no patch fields -> error', r.ok === false && /nothing to change/.test(r.error ?? ''));
}

// --- edit: add_signal / remove_signal (§5.1: a cable carries a SET) ---------
console.log('\nopenrig edit (signals):');
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_signal', cable_id: 'rc505-clockhub', midi_type: 'transport' });
  check('edit: add_signal ok + returns a new rig', r.ok === true && r.rig !== undefined && r.edge_id === 'rc505-clockhub');
  check('edit: add_signal is immutable (input untouched)', (() => {
    const sig = LOOPER_HUB_RIG.edges.find((e) => e.id === 'rc505-clockhub')!.signal;
    return sig.kind === 'midi' && sig.signals.length === 2;
  })());
  check('edit: add_signal result validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0);
  const sig = r.rig?.edges.find((e) => e.id === 'rc505-clockhub')?.signal;
  check('edit: add_signal appended the signal', sig?.kind === 'midi'
    && sig.signals.length === 3 && sig.signals[2].type === 'transport');
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_signal', cable_id: 'am4-audio', midi_type: 'cc', channel: 1 });
  check('edit: add_signal on an audio cable -> error', r.ok === false && /not MIDI/.test(r.error ?? ''));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_signal', cable_id: 'rc505-clockhub', midi_type: 'pc' });
  check('edit: remove_signal by type ok', r.ok === true && r.rig !== undefined);
  check('edit: remove_signal result validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0);
  const sig = r.rig?.edges.find((e) => e.id === 'rc505-clockhub')?.signal;
  check('edit: remove_signal dropped exactly that signal', sig?.kind === 'midi'
    && sig.signals.length === 1 && sig.signals[0].type === 'clock');
  check('edit: remove_signal is immutable (input untouched)', (() => {
    const orig = LOOPER_HUB_RIG.edges.find((e) => e.id === 'rc505-clockhub')!.signal;
    return orig.kind === 'midi' && orig.signals.length === 2;
  })());
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_signal', cable_id: 'rc505-clockhub', signal_index: 0 });
  const sig = r.rig?.edges.find((e) => e.id === 'rc505-clockhub')?.signal;
  check('edit: remove_signal by index ok', r.ok === true && sig?.kind === 'midi' && sig.signals[0].type === 'pc');
}
{
  // last-signal refusal: am4-scene-cc carries exactly one signal
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_signal', cable_id: 'am4-scene-cc', signal_index: 0 });
  check('edit: remove_signal refuses to empty the cable', r.ok === false && /remove_cable/.test(r.error ?? ''));
}
{
  // ambiguity: two cc signals, remove by bare type must refuse
  const one = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_signal', cable_id: 'rc505-clockhub', midi_type: 'cc', channel: 3 });
  const two = applyRigEdit(one.rig!, { op: 'add_signal', cable_id: 'rc505-clockhub', midi_type: 'cc', channel: 4 });
  const ambiguous = applyRigEdit(two.rig!, { op: 'remove_signal', cable_id: 'rc505-clockhub', midi_type: 'cc' });
  check('edit: remove_signal ambiguous match -> error', ambiguous.ok === false && /disambiguate/.test(ambiguous.error ?? ''));
  const byChannel = applyRigEdit(two.rig!, { op: 'remove_signal', cable_id: 'rc505-clockhub', midi_type: 'cc', channel: 3 });
  const sig = byChannel.rig?.edges.find((e) => e.id === 'rc505-clockhub')?.signal;
  check('edit: remove_signal disambiguated by channel', byChannel.ok === true
    && sig?.kind === 'midi' && sig.signals.every((s) => !(s.type === 'cc' && s.channel === 3)));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_signal', cable_id: 'rc505-clockhub' });
  check('edit: remove_signal with no selector -> error', r.ok === false && /needs signal_index/.test(r.error ?? ''));
}

// --- edit: update_device ----------------------------------------------------
console.log('\nopenrig edit (update_device):');
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_device', device: 'am4', name: 'AM4 (backup)', server_device_id: null });
  check('edit: update_device ok + returns a new rig', r.ok === true && r.rig !== undefined && r.node_id === 'am4');
  check('edit: update_device is immutable (input untouched)',
    LOOPER_HUB_RIG.nodes.find((n) => n.id === 'am4')?.name === 'Fractal AM4');
  check('edit: update_device result validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0);
  const node = r.rig?.nodes.find((n) => n.id === 'am4');
  check('edit: update_device renamed + detached descriptor', node?.name === 'AM4 (backup)' && node.server_device_id === null);
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_device', device: 'MIDI Thru box', roles: ['midi_router', 'clock_follower'] });
  check('edit: update_device resolves by name + replaces roles', r.ok === true
    && JSON.stringify(r.rig?.nodes.find((n) => n.id === 'thru')?.roles) === '["midi_router","clock_follower"]');
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_device', device: 'am4', roles: [] });
  check('edit: update_device empty roles -> error', r.ok === false && /at least one role/.test(r.error ?? ''));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_device', device: 'am4' });
  check('edit: update_device with no patch fields -> error', r.ok === false && /nothing to change/.test(r.error ?? ''));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_device', device: 'nope', name: 'X' });
  check('edit: update_device unknown device -> error', r.ok === false && /no device matches/.test(r.error ?? ''));
}

// --- edit: port ops ---------------------------------------------------------
console.log('\nopenrig edit (ports):');
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_port', device: 'circuit', id: 'thru', kind: 'midi_thru', label: 'MIDI Thru' });
  check('edit: add_port ok + returns a new rig', r.ok === true && r.rig !== undefined
    && r.node_id === 'circuit' && r.port_id === 'thru');
  check('edit: add_port is immutable (input untouched)',
    LOOPER_HUB_RIG.nodes.find((n) => n.id === 'circuit')?.ports.some((p) => p.id === 'thru') === false);
  check('edit: add_port result validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0);
  const port = r.rig?.nodes.find((n) => n.id === 'circuit')?.ports.find((p) => p.id === 'thru');
  check('edit: add_port landed with kind + label', port?.kind === 'midi_thru' && port.label === 'MIDI Thru');
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_port', device: 'circuit', id: 'midi1', kind: 'midi_din_out' });
  check('edit: add_port duplicate id -> error', r.ok === false && /already has a port "midi1"/.test(r.error ?? ''));
}
{
  // update_port carries output_role: the field checkAudioOutput keys on (§3).
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_port', device: 'rc505', port_id: 'main_out', output_role: 'main' });
  check('edit: update_port ok + returns a new rig', r.ok === true && r.rig !== undefined && r.port_id === 'main_out');
  check('edit: update_port is immutable (input untouched)',
    LOOPER_HUB_RIG.nodes.find((n) => n.id === 'rc505')?.ports.find((p) => p.id === 'main_out')?.output_role === undefined);
  check('edit: update_port result validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0);
  const port = r.rig?.nodes.find((n) => n.id === 'rc505')?.ports.find((p) => p.id === 'main_out');
  check('edit: update_port set output_role', port?.output_role === 'main');
  const cleared = applyRigEdit(r.rig!, { op: 'update_port', device: 'rc505', port_id: 'main_out', output_role: null });
  check('edit: update_port output_role null clears it',
    cleared.rig?.nodes.find((n) => n.id === 'rc505')?.ports.find((p) => p.id === 'main_out')?.output_role === undefined);
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_port', device: 'rc505', port_id: 'ghost', label: 'X' });
  check('edit: update_port unknown port -> error', r.ok === false && /has no port "ghost"/.test(r.error ?? ''));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_port', device: 'rc505', port_id: 'main_out' });
  check('edit: update_port with no patch fields -> error', r.ok === false && /nothing to change/.test(r.error ?? ''));
}
{
  // remove_port cascades: circuit.midi2 carries circuit-to-spdsx.
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_port', device: 'circuit', port_id: 'midi2' });
  check('edit: remove_port ok + names the cascade', r.ok === true
    && JSON.stringify(r.removed_edge_ids) === '["circuit-to-spdsx"]');
  check('edit: remove_port is immutable (input untouched)',
    LOOPER_HUB_RIG.nodes.find((n) => n.id === 'circuit')?.ports.some((p) => p.id === 'midi2') === true);
  check('edit: remove_port result validates clean (no dangling endpoints)',
    r.rig !== undefined && validateRig(r.rig).errors.length === 0,
    JSON.stringify(r.rig !== undefined ? validateRig(r.rig).errors : []));
  check('edit: remove_port dropped the port + its cable', r.rig !== undefined
    && r.rig.nodes.find((n) => n.id === 'circuit')?.ports.some((p) => p.id === 'midi2') === false
    && r.rig.edges.some((e) => e.id === 'circuit-to-spdsx') === false);
}
{
  // remove_port strips routing rules naming the port (rc505 consume/pass name midi_in).
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_port', device: 'rc505', port_id: 'midi_in' });
  check('edit: remove_port strips routing rules naming the port', r.ok === true
    && r.rig?.nodes.find((n) => n.id === 'rc505')?.routing?.consume?.length === 0
    && r.rig?.nodes.find((n) => n.id === 'rc505')?.routing?.pass?.length === 0);
  check('edit: remove_port routing strip validates clean (no routing-dangling-port)',
    r.rig !== undefined && validateRig(r.rig).errors.length === 0,
    JSON.stringify(r.rig !== undefined ? validateRig(r.rig).errors : []));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_port', device: 'circuit', port_id: 'ghost' });
  check('edit: remove_port unknown port -> error', r.ok === false && /has no port "ghost"/.test(r.error ?? ''));
}

// --- edit: binding CRUD (§4: authoring the authoritative contract) ----------
console.log('\nopenrig edit (bindings):');
{
  const r = applyRigEdit(LOOPER_HUB_RIG, {
    op: 'add_binding', id: 'am4-scene-flip', from: 'am4', to: 'rc505',
    emits: { type: 'cc', channel: 5, cc: 80 },
    expects: { type: 'cc', channel: 5, cc: 80, target: 'TRK3 REC/PLY' },
    note: 'AM4 scene 2 flips looper track 3',
  });
  check('edit: add_binding ok + returns a new rig', r.ok === true && r.rig !== undefined && r.binding_id === 'am4-scene-flip');
  check('edit: add_binding is immutable (input untouched)', (LOOPER_HUB_RIG.bindings ?? []).length === 0);
  check('edit: add_binding result validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0);
  const b = r.rig?.bindings?.find((x) => x.id === 'am4-scene-flip');
  check('edit: add_binding landed with both ends + inner node refs', b !== undefined
    && b.from.node === 'am4' && b.from.emits.node === 'am4' && b.from.emits.cc === 80
    && b.to.node === 'rc505' && b.to.expects.node === 'rc505' && b.to.expects.target === 'TRK3 REC/PLY');
  check('edit: add_binding agreement holds (compat check consistent)', (() => {
    if (r.rig === undefined) return false;
    const rep: CompatibilityReport = checkRigCompatibility(r.rig, {});
    return rep.bindings.find((x) => x.id === 'am4-scene-flip')?.agreement_ok === true;
  })());
}
{
  // expects omitted: the receiver end mirrors emits (agreement by construction).
  const r = applyRigEdit(LOOPER_HUB_RIG, {
    op: 'add_binding', id: 'mirror', from: 'am4', to: 'rc505', emits: { type: 'cc', channel: 5, cc: 81, target: 'sender-side-noise' },
  });
  const b = r.rig?.bindings?.find((x) => x.id === 'mirror');
  check('edit: add_binding defaults expects to emits (minus target)', b?.to.expects.cc === 81
    && b?.to.expects.channel === 5 && b?.to.expects.target === undefined);
}
{
  const withB = applyRigEdit(LOOPER_HUB_RIG, {
    op: 'add_binding', id: 'b1', from: 'am4', to: 'rc505', emits: { type: 'cc', channel: 5, cc: 80 },
  });
  const dup = applyRigEdit(withB.rig!, {
    op: 'add_binding', id: 'b1', from: 'circuit', to: 'spdsx', emits: { type: 'note', channel: 4 },
  });
  check('edit: add_binding duplicate id -> error', dup.ok === false && /already in this rig/.test(dup.error ?? ''));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_binding', id: 'x', from: 'nope', to: 'rc505', emits: { type: 'cc' } });
  check('edit: add_binding unknown device -> error', r.ok === false && /no device matches/.test(r.error ?? ''));
}
{
  // update_binding patches BOTH ends: the §4 headline edit (CC#80 -> CC#20).
  const withB = applyRigEdit(LOOPER_HUB_RIG, {
    op: 'add_binding', id: 'b1', from: 'am4', to: 'rc505',
    emits: { type: 'cc', channel: 5, cc: 80 }, expects: { type: 'cc', channel: 5, cc: 80, target: 'TRK3 REC/PLY' },
  });
  const r = applyRigEdit(withB.rig!, { op: 'update_binding', binding_id: 'b1', cc: 20 });
  check('edit: update_binding ok + returns a new rig', r.ok === true && r.rig !== undefined && r.binding_id === 'b1');
  check('edit: update_binding is immutable (input untouched)',
    withB.rig?.bindings?.find((b) => b.id === 'b1')?.from.emits.cc === 80);
  check('edit: update_binding result validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0);
  const b = r.rig?.bindings?.find((x) => x.id === 'b1');
  check('edit: update_binding patched BOTH ends (no drift)', b?.from.emits.cc === 20 && b?.to.expects.cc === 20);
  check('edit: update_binding kept the receiver target', b?.to.expects.target === 'TRK3 REC/PLY');
  const retarget = applyRigEdit(r.rig!, { op: 'update_binding', binding_id: 'b1', target: 'TRK4 REC/PLY' });
  check('edit: update_binding target patches the receiver end only',
    retarget.rig?.bindings?.find((x) => x.id === 'b1')?.to.expects.target === 'TRK4 REC/PLY'
    && retarget.rig?.bindings?.find((x) => x.id === 'b1')?.from.emits.target === undefined);
  const toClock = applyRigEdit(r.rig!, { op: 'update_binding', binding_id: 'b1', midi_type: 'clock' });
  const cb = toClock.rig?.bindings?.find((x) => x.id === 'b1');
  check('edit: update_binding to a channelless type drops both channels',
    cb?.from.emits.channel === undefined && cb?.to.expects.channel === undefined);
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'update_binding', binding_id: 'ghost', cc: 20 });
  check('edit: update_binding unknown binding -> error', r.ok === false && /no binding with id "ghost"/.test(r.error ?? ''));
}
{
  // remove_binding: happy when unreferenced, refused while referenced.
  const withB = applyRigEdit(LOOPER_HUB_RIG, {
    op: 'add_binding', id: 'b1', from: 'am4', to: 'rc505', emits: { type: 'cc', channel: 5, cc: 80 },
  });
  const gone = applyRigEdit(withB.rig!, { op: 'remove_binding', binding_id: 'b1' });
  check('edit: remove_binding ok when unreferenced', gone.ok === true
    && gone.rig?.bindings?.some((b) => b.id === 'b1') === false);
  check('edit: remove_binding result validates clean', gone.rig !== undefined && validateRig(gone.rig).errors.length === 0);

  const governed = JSON.parse(JSON.stringify(withB.rig)) as Rig;
  const edge = governed.edges.find((e) => e.id === 'am4-scene-cc')!;
  if (edge.signal.kind === 'midi') edge.signal.signals[0].binding = 'b1';
  const refused = applyRigEdit(governed, { op: 'remove_binding', binding_id: 'b1' });
  check('edit: remove_binding refused while a signal references it', refused.ok === false
    && /still referenced by: cable am4-scene-cc \(signal\)/.test(refused.error ?? ''));

  const routed = JSON.parse(JSON.stringify(withB.rig)) as Rig;
  routed.nodes.find((n) => n.id === 'rc505')!.routing!.consume![0].binding = 'b1';
  const refusedRouting = applyRigEdit(routed, { op: 'remove_binding', binding_id: 'b1' });
  check('edit: remove_binding refused while routing references it', refusedRouting.ok === false
    && /device rc505 routing/.test(refusedRouting.error ?? ''));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'remove_binding', binding_id: 'ghost' });
  check('edit: remove_binding unknown binding -> error', r.ok === false && /no binding with id "ghost"/.test(r.error ?? ''));
}

// --- edit: set_routing (§5.6) -----------------------------------------------
console.log('\nopenrig edit (set_routing):');
{
  const r = applyRigEdit(LOOPER_HUB_RIG, {
    op: 'set_routing', device: 'thru',
    routing: { pass: [{ port: 'in', to: 'out1' }, { port: 'in', to: 'out2' }] },
  });
  check('edit: set_routing ok + returns a new rig', r.ok === true && r.rig !== undefined && r.node_id === 'thru');
  check('edit: set_routing is immutable (input untouched)',
    LOOPER_HUB_RIG.nodes.find((n) => n.id === 'thru')?.routing === undefined);
  check('edit: set_routing result validates clean', r.rig !== undefined && validateRig(r.rig).errors.length === 0,
    JSON.stringify(r.rig !== undefined ? validateRig(r.rig).errors : []));
  check('edit: set_routing landed the declaration',
    r.rig?.nodes.find((n) => n.id === 'thru')?.routing?.pass?.length === 2);
}
{
  // routing naming a port the node does not have: applyRigEdit applies it, the
  // validator refuses it (routing-dangling-port), which is the executor's gate.
  const r = applyRigEdit(LOOPER_HUB_RIG, {
    op: 'set_routing', device: 'thru', routing: { consume: [{ port: 'ghost_port' }] },
  });
  check('edit: set_routing with a dangling port fails validateRig', r.ok === true
    && r.rig !== undefined && validateRig(r.rig).errors.some((e) => e.code === 'routing-dangling-port'));
}
{
  const cleared = applyRigEdit(LOOPER_HUB_RIG, { op: 'set_routing', device: 'rc505', routing: null });
  check('edit: set_routing null clears the declaration', cleared.ok === true
    && cleared.rig?.nodes.find((n) => n.id === 'rc505')?.routing === undefined);
  check('edit: set_routing clear is immutable (input untouched)',
    LOOPER_HUB_RIG.nodes.find((n) => n.id === 'rc505')?.routing !== undefined);
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'set_routing', device: 'nope', routing: null });
  check('edit: set_routing unknown device -> error', r.ok === false && /no device matches/.test(r.error ?? ''));
}

// --- edit: widened add_cable kinds ------------------------------------------
console.log('\nopenrig edit (widened cable kinds):');
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'circuit', to: 'spdsx', kind: 'usb_midi', midi_type: 'note', channel: 10 });
  check('edit: add_cable usb_midi ok + validates clean', r.ok === true
    && r.rig !== undefined && validateRig(r.rig).errors.length === 0,
    JSON.stringify(r.rig !== undefined ? validateRig(r.rig).errors : []));
  const edge = r.rig?.edges.find((e) => e.id === r.edge_id);
  check('edit: usb_midi cable carries a MIDI signal on usb_midi ports', edge?.signal.kind === 'midi'
    && r.rig?.nodes.find((n) => n.id === 'circuit')?.ports.some((p) => p.kind === 'usb_midi') === true
    && r.rig?.nodes.find((n) => n.id === 'spdsx')?.ports.some((p) => p.kind === 'usb_midi') === true);
}
{
  // A portless device, so both ends exercise the create path (§10's DIN inputs are all cabled).
  const base = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_device', id: 'synth2', name: 'Synth 2', roles: ['sound_source'] });
  const r = applyRigEdit(base.rig!, { op: 'add_cable', from: 'thru', to: 'synth2', kind: 'midi_thru', midi_type: 'clock' });
  const fromPort = r.rig?.nodes.find((n) => n.id === 'thru')?.ports.find((p) => p.kind === 'midi_thru');
  check('edit: add_cable midi_thru ok, THRU port out, DIN in', r.ok === true
    && r.rig !== undefined && validateRig(r.rig).errors.length === 0 && fromPort !== undefined,
    JSON.stringify(r.rig !== undefined ? validateRig(r.rig).errors : []));
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'circuit', to: 'am4', kind: 'cv' });
  const edge = r.rig?.edges.find((e) => e.id === r.edge_id);
  check('edit: add_cable cv carries control_voltage on cv ports', r.ok === true
    && edge?.signal.kind === 'control_voltage'
    && r.rig !== undefined && validateRig(r.rig).errors.length === 0,
    JSON.stringify(r.rig !== undefined ? validateRig(r.rig).errors : []));
  const gone = applyRigEdit(r.rig!, { op: 'remove_cable', from: 'circuit', to: 'am4', kind: 'cv' });
  check('edit: remove_cable resolves a cv cable by kind', gone.ok === true && gone.edge_id === r.edge_id);
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'am4', to: 'rc505', kind: 'expression' });
  const edge = r.rig?.edges.find((e) => e.id === r.edge_id);
  check('edit: add_cable expression ok + validates clean', r.ok === true
    && edge?.signal.kind === 'expression'
    && r.rig !== undefined && validateRig(r.rig).errors.length === 0);
}
{
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'circuit', to: 'spdsx', kind: 'analog_clock' });
  const edge = r.rig?.edges.find((e) => e.id === r.edge_id);
  check('edit: add_cable analog_clock ok + validates clean', r.ok === true
    && edge?.signal.kind === 'analog_clock'
    && r.rig !== undefined && validateRig(r.rig).errors.length === 0);
}

// --- edit: jack selection, direction, occupancy (portRules) -----------------
// The 2026-09-16 regressions: add_cable took the FIRST port of a kind (double-
// booking a thru box output already feeding a synth) and accepted a cable
// between two expression INPUTS, inventing a port instead of using the declared one.
console.log('\nopenrig edit (jack selection + direction + occupancy):');
{
  // implicit selection skips a busy jack: thru.out1 feeds the Circuit, out2 is free.
  const r = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'thru', to: 'spdsx', kind: 'midi', midi_type: 'clock', enabled: false, to_port: 'midi_in' });
  const e = r.rig?.edges.find((x) => x.id === r.edge_id);
  check('select: implicit from-jack skips the busy out1 and takes the free out2', r.ok === true && e?.from.port === 'out2', r.error ?? JSON.stringify(e?.from));
  check('select: the summary names the jacks chosen', /thru box\.out2 -> SPD-SX\.midi_in/i.test(r.summary ?? ''), r.summary);
  // both outputs busy -> refuse, listing each occupant
  const full = applyRigEdit(r.rig!, { op: 'set_cable_enabled', cable_id: r.edge_id!, enabled: true });
  check('select: enabling a planned cable onto a jack a live cable holds is refused',
    full.ok === false && /cannot enable cable .*SPD-SX\.midi_in already holds live cable circuit-to-spdsx/.test(full.error ?? ''), full.error);
  const withOut2 = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'thru', to: 'rc505', kind: 'midi', from_port: 'out2', to_port: 'midi_in', midi_type: 'clock', enabled: false });
  const none = applyRigEdit(withOut2.rig!, { op: 'add_cable', from: 'thru', to: 'am4', kind: 'midi', midi_type: 'clock' });
  check('select: every output busy (planned counts) -> refused naming each jack',
    none.ok === false && /no free MIDI output: out1 \(thru-to-circuit\), out2 \(.* \[planned\]\)/.test(none.error ?? ''), none.error);
  // a jack that is busy only with a DISABLED cable becomes enable-able once the live one goes
  const moved = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'thru', to: 'spdsx', kind: 'midi', from_port: 'out2', to_port: 'midi_in', midi_type: 'clock', enabled: false });
  const offOld = applyRigEdit(moved.rig!, { op: 'set_cable_enabled', cable_id: 'circuit-to-spdsx', enabled: false });
  const onNew = applyRigEdit(offOld.rig!, { op: 'set_cable_enabled', cable_id: moved.edge_id!, enabled: true });
  check('select: re-cable completes once the old cable is disabled first', onNew.ok === true, onNew.error);
  const viaUpdate = applyRigEdit(moved.rig!, { op: 'update_cable', cable_id: moved.edge_id!, enabled: true });
  check('select: update_cable enabled:true applies the same one-plug rule', viaUpdate.ok === false && /already holds live cable/.test(viaUpdate.error ?? ''), viaUpdate.error);
}
{
  // An effects pedal whose EXP jack is an INPUT, and an amp modeler with a PEDAL input.
  const pedal = applyRigEdit(LOOPER_HUB_RIG, {
    op: 'add_device', id: 'xs100', name: 'Pitch pedal', roles: ['effect'],
    ports: [{ id: 'ctl_exp2', kind: 'expression', direction: 'in' }, { id: 'midi_out', kind: 'midi_din_out' }],
  });
  const withPedalIn = applyRigEdit(pedal.rig!, { op: 'add_port', device: 'am4', id: 'pedal1', kind: 'expression' });
  const rig = applyRigEdit(withPedalIn.rig!, { op: 'update_port', device: 'am4', port_id: 'pedal1', label: 'PEDAL 1' }).rig!;
  const implicit = applyRigEdit(rig, { op: 'add_cable', from: 'xs100', to: 'am4', kind: 'expression' });
  check('direction: an expression cable FROM a pedal whose only EXP jack is an input is refused',
    implicit.ok === false && /\(ctl_exp2\) is an INPUT/.test(implicit.error ?? '')
      && /Pitch pedal has no expression output/.test(implicit.error ?? ''), implicit.error);
  check('direction: refusal invents no port', implicit.rig === undefined);
  const viaFootswitch = applyRigEdit(rig, { op: 'add_cable', from: 'xs100', to: 'am4', kind: 'footswitch' });
  check('direction: a footswitch cable finds the dual-mode EXP jack and is refused the same way (no invented "sw" port)',
    viaFootswitch.ok === false && /\(ctl_exp2\) is an INPUT/.test(viaFootswitch.error ?? '') && /no footswitch output/.test(viaFootswitch.error ?? ''), viaFootswitch.error);
  const explicit = applyRigEdit(rig, { op: 'add_cable', from: 'xs100', to: 'am4', kind: 'expression', from_port: 'ctl_exp2', to_port: 'pedal1' });
  check('direction: naming the input jack as from_port is refused',
    explicit.ok === false && /ctl_exp2 is an INPUT/.test(explicit.error ?? ''), explicit.error);
  // an expression PEDAL (jack declared out) into the pitch pedal's EXP input works, and uses the declared jack
  const evPedal = applyRigEdit(rig, { op: 'add_device', id: 'ev30', name: 'EV-30', roles: ['controller'], ports: [{ id: 'out', kind: 'expression', direction: 'out' }] });
  const intoPedal = applyRigEdit(evPedal.rig!, { op: 'add_cable', from: 'ev30', to: 'xs100', kind: 'expression' });
  const ie = intoPedal.rig?.edges.find((x) => x.id === intoPedal.edge_id);
  check('direction: an EXP pedal into a declared EXP input uses the declared jack + validates clean',
    intoPedal.ok === true && ie?.to.port === 'ctl_exp2' && ie.from.port === 'out'
      && validateRig(intoPedal.rig!).errors.length === 0, intoPedal.error);
  const fsIntoExp = applyRigEdit(evPedal.rig!, { op: 'add_device', id: 'fs6', name: 'FS-6', roles: ['controller'], ports: [{ id: 'out', kind: 'footswitch', direction: 'out' }] });
  const fsEdge = applyRigEdit(fsIntoExp.rig!, { op: 'add_cable', from: 'fs6', to: 'xs100', kind: 'footswitch' });
  check('direction: a footswitch into a dual-mode EXP-declared jack is legal (no port-signal-mismatch)',
    fsEdge.ok === true && fsEdge.rig?.edges.find((x) => x.id === fsEdge.edge_id)?.to.port === 'ctl_exp2'
      && validateRig(fsEdge.rig!).errors.length === 0, fsEdge.error ?? JSON.stringify(validateRig(fsEdge.rig!).errors));
  // a created control jack is stamped with the side it was created for
  const created = applyRigEdit(LOOPER_HUB_RIG, { op: 'add_cable', from: 'circuit', to: 'spdsx', kind: 'footswitch' });
  const sw = created.rig?.nodes.find((n) => n.id === 'circuit')?.ports.find((p) => p.id === 'sw');
  check('direction: a CREATED control jack records its direction', sw?.direction === 'out', JSON.stringify(sw));
  // capacity reports the declared direction, not the kind's "either"
  const cap = checkRigCapacity(rig);
  const expPort = cap.devices.find((d) => d.id === 'xs100')?.ports.find((p) => p.port_id === 'ctl_exp2');
  check('direction: capacity reports a declared-input EXP jack as a sink', expPort?.direction === 'sink', JSON.stringify(expPort));
}
{
  // validateRig: the three new port rules, on hand-built manifests (the edit path refuses to create them).
  const clone = (): Rig => JSON.parse(JSON.stringify(LOOPER_HUB_RIG)) as Rig;
  const reversed = clone();
  const edge = reversed.edges.find((x) => x.id === 'thru-to-circuit')!;
  edge.from = { node: 'circuit', port: 'midi_in' };
  edge.to = { node: 'thru', port: 'out1' };
  const rv = validateRig(reversed);
  check('validate: a cable leaving an INPUT jack -> edge-direction error',
    rv.errors.some((x) => x.code === 'edge-direction' && /leaves circuit\.midi_in, which is an INPUT/.test(x.message)), JSON.stringify(rv.errors));
  check('validate: ...and arriving at an OUTPUT jack -> edge-direction error',
    rv.errors.some((x) => x.code === 'edge-direction' && /arrives at thru\.out1, which is an OUTPUT/.test(x.message)));

  const contra = clone();
  contra.nodes.find((n) => n.id === 'spdsx')!.ports.find((p) => p.id === 'midi_in')!.direction = 'out';
  check('validate: a declared direction contradicting a fixed kind -> port-direction-contradicts-kind',
    validateRig(contra).errors.some((x) => x.code === 'port-direction-contradicts-kind'));

  const doubled = clone();
  doubled.edges.push({ ...JSON.parse(JSON.stringify(doubled.edges.find((x) => x.id === 'thru-to-circuit'))), id: 'thru-to-circuit-2', physical_link_id: 'din-9' });
  const dv = validateRig(doubled);
  check('validate: two live cables in one DIN jack -> port-double-booked warning (not an error)',
    dv.errors.length === 0 && dv.warnings.some((x) => x.code === 'port-double-booked' && /thru\.out1 carries 2 enabled cables/.test(x.message)), JSON.stringify(dv.warnings));

  const summing = clone();
  summing.edges.push({ id: 'am4-to-cab', from: { node: 'am4', port: 'out_lr' }, to: { node: 'cab', port: 'in' }, directed: true, physical_link_id: 'trs-9', signal: { kind: 'audio', channels: ['L', 'R'] } });
  check('validate: N cables into a monitor/mixer audio input is summing, not double-booking',
    !validateRig(summing).warnings.some((x) => x.code === 'port-double-booked' && /cab\.in/.test(x.message)));

  const duplex = clone();
  duplex.nodes.find((n) => n.id === 'circuit')!.ports.push({ id: 'usb', kind: 'usb_midi' });
  duplex.nodes.find((n) => n.id === 'spdsx')!.ports.push({ id: 'usb', kind: 'usb_midi' });
  duplex.edges.push(
    { id: 'usb-a', from: { node: 'circuit', port: 'usb' }, to: { node: 'spdsx', port: 'usb' }, directed: true, physical_link_id: 'usb-1', signal: { kind: 'midi', signals: [{ type: 'clock' }] } },
    { id: 'usb-b', from: { node: 'spdsx', port: 'usb' }, to: { node: 'circuit', port: 'usb' }, directed: true, physical_link_id: 'usb-1', signal: { kind: 'midi', signals: [{ type: 'clock' }] } },
  );
  check('validate: a duplex USB pair (two directed edges, one physical link) is one plug',
    !validateRig(duplex).warnings.some((x) => x.code === 'port-double-booked'), JSON.stringify(validateRig(duplex).warnings));
}

// --- capacity: "where is there room to plug something in" ---
console.log('\nopenrig capacity check:');
{
  const rep = checkRigCapacity(LOOPER_HUB_RIG);
  const partitions = rep.devices.every(
    (d) => d.totals.used + d.totals.reserved + d.totals.free === d.totals.total
      && d.totals.total === d.ports.length,
  );
  check('capacity: per-device totals partition every port', partitions);
  check('capacity: every rig node is reported', rep.devices.length === LOOPER_HUB_RIG.nodes.length);
}
// A port no cable names is FREE and shows up in the by-kind lookup. This is the
// exact lookup whose absence caused the 2026-07-25 miss.
{
  const r = clone();
  r.nodes[0].ports.push({ id: 'spare_out', kind: 'midi_din_out', label: 'Spare DIN Out' });
  const rep = checkRigCapacity(r);
  const free = rep.free_by_kind.midi_din_out ?? [];
  check('capacity: an uncabled port is free and listed by kind',
    free.some((p) => p.node_id === r.nodes[0].id && p.port_id === 'spare_out'));
  check('capacity: free port carries its label through to the lookup',
    free.find((p) => p.port_id === 'spare_out')?.label === 'Spare DIN Out');
}
// A [planned] (enabled:false) cable RESERVES the port: not free (recommending it
// would double-book) but distinguishable from a live connection.
{
  const r = clone();
  r.nodes[0].ports.push({ id: 'spare_out', kind: 'midi_din_out' });
  r.nodes[1].ports.push({ id: 'spare_in', kind: 'midi_din_in' });
  r.edges.push({
    id: 'planned-cable', directed: true, enabled: false,
    from: { node: r.nodes[0].id, port: 'spare_out' },
    to: { node: r.nodes[1].id, port: 'spare_in' },
    signal: { kind: 'midi', signals: [{ type: 'clock' }] },
  });
  const rep = checkRigCapacity(r);
  const port = rep.devices.find((d) => d.id === r.nodes[0].id)?.ports.find((p) => p.port_id === 'spare_out');
  check('capacity: planned cable marks the port reserved, not used', port?.state === 'reserved');
  check('capacity: reserved port is NOT offered as free',
    (rep.free_by_kind.midi_din_out ?? []).every((p) => p.port_id !== 'spare_out'));
  check('capacity: reserved port still names the claiming edge', port?.edge_ids.includes('planned-cable') === true);
}
// A fan-out hub with every output spoken for is the shape that sends someone
// hunting for a workaround, so it gets its own named issue.
{
  const r = clone();
  const sink = r.nodes[0];
  r.nodes.push({
    id: 'thrubox', name: 'Test Thru Box', identity: { manufacturer: 'Test', family: 'Thru' },
    server_device_id: null, roles: ['midi_router'],
    ports: [{ id: 'in', kind: 'midi_din_in' }, { id: 'out1', kind: 'midi_din_out' }],
  });
  sink.ports.push({ id: 'hub_in', kind: 'midi_din_in' });
  r.edges.push({
    id: 'hub-out1', directed: true,
    from: { node: 'thrubox', port: 'out1' },
    to: { node: sink.id, port: 'hub_in' },
    signal: { kind: 'midi', signals: [{ type: 'clock' }] },
  });
  const rep = checkRigCapacity(r);
  check('capacity: exhausted fan-out hub raises fanout-hub-exhausted',
    rep.issues.some((i) => i.code === 'fanout-hub-exhausted' && i.ref === 'thrubox'));
  check('capacity: exhausted-hub issue is advisory (warning, never error)',
    rep.issues.every((i) => i.severity === 'warning'));
  check('capacity: a hub with a spare output raises nothing',
    checkRigCapacity((() => {
      const r2 = JSON.parse(JSON.stringify(r)) as Rig;
      r2.nodes.find((n) => n.id === 'thrubox')!.ports.push({ id: 'out2', kind: 'midi_din_out' });
      return r2;
    })()).issues.every((i) => i.ref !== 'thrubox'));
}

// --- attachment ranking: "where do I plug this new device in?" ---
console.log('\nopenrig attachment ranking:');

/**
 * Minimal purpose-built rig: a sequencer with TWO free outputs, a thru box fed
 * from one of them with a spare output of its own, and a new synth with nothing
 * plugged in. Both a direct and a chained attachment are genuinely available, so
 * the tier ordering is actually exercised (the maintainer's real rig happens to
 * yield a single candidate, which would not test the ranking at all).
 */
function attachRig(): Rig {
  return {
    openrig_version: '0.1',
    id: 'attach-fixture',
    name: 'Attachment fixture',
    nodes: [
      {
        id: 'seq', name: 'Sequencer', identity: { manufacturer: 'T', family: 'Seq' },
        server_device_id: null, roles: ['sequencer'],
        ports: [
          { id: 'out_a', kind: 'midi_din_out', label: 'Out A' },
          { id: 'out_b', kind: 'midi_din_out', label: 'Out B' },
        ],
        routing: {
          originate: [
            { port: 'out_a', kind: 'midi', type: 'note', channel: 3 },
            { port: 'out_b', kind: 'midi', type: 'note', channel: 3 },
          ],
        },
      },
      {
        id: 'hub', name: 'Thru Box', identity: { manufacturer: 'T', family: 'Thru' },
        server_device_id: null, roles: ['midi_router'],
        ports: [
          { id: 'in', kind: 'midi_din_in' },
          { id: 'out1', kind: 'midi_din_out' },
          { id: 'out2', kind: 'midi_din_out' },
        ],
        routing: { pass: [{ port: 'in', kind: 'midi' }] },
      },
      {
        id: 'synth', name: 'New Synth', identity: { manufacturer: 'T', family: 'Synth' },
        server_device_id: null, roles: ['sound_source'],
        ports: [{ id: 'midi_in', kind: 'midi_din_in' }],
      },
    ],
    edges: [{
      id: 'seq-to-hub', directed: true,
      from: { node: 'seq', port: 'out_a' }, to: { node: 'hub', port: 'in' },
      signal: { kind: 'midi', signals: [{ type: 'note', channel: 3 }] },
    }],
  };
}
const NOTE3 = { type: 'note', channel: 3 } as const;

{
  const rep = rankAttachments(attachRig(), { device: 'synth', signal: NOTE3 });
  // 3 = the sequencer's free second out, plus BOTH of the thru box's free outs.
  check('attach: enumerates every free port that can carry the signal', rep.candidates.length === 3);
  check('attach: DIRECT wins over chained', rep.best?.from.node_id === 'seq' && rep.best?.from.port_id === 'out_b');
  check('attach: direct has zero relay dependencies', rep.best?.relay_dependencies.length === 0);
  check('attach: chained option names its intermediate device',
    rep.candidates[1].from.node_id === 'hub' && rep.candidates[1].relay_dependencies.includes('Thru Box'));
  check('attach: hop counts are direct=1, chained=2',
    rep.best?.hops === 1 && rep.candidates[1].hops === 2);
  check('attach: summary explains WHY it beat the runner-up',
    rep.summary.includes('Beats') && rep.summary.includes('intermediate device'));
}
// A signal that reaches nowhere is ELIMINATED, never ranked low. A candidate that
// cannot carry the signal is not a bad option, it is not an option.
{
  const rep = rankAttachments(attachRig(), { device: 'synth', signal: { type: 'note', channel: 9 } });
  check('attach: a signal nothing originates is an error, not a bad candidate',
    rep.ok === false && rep.candidates.length === 0);
}
// A [planned] cable RESERVES the port, so the planner must not double-book it.
{
  const r = attachRig();
  r.edges.push({
    id: 'planned', directed: true, enabled: false,
    from: { node: 'seq', port: 'out_b' }, to: { node: 'synth', port: 'midi_in' },
    signal: { kind: 'midi', signals: [{ type: 'note', channel: 3 }] },
  });
  const rep = rankAttachments(r, { device: 'synth', signal: NOTE3 });
  check('attach: a port reserved by a planned cable is not offered again',
    rep.candidates.every((c) => !(c.from.node_id === 'seq' && c.from.port_id === 'out_b')));
}
// Tie on relay dependencies -> more spare capacity left on the host wins.
{
  const r = attachRig();
  r.edges = [];                                   // both seq outs free, hub unreachable
  r.nodes[0].ports.push({ id: 'out_c', kind: 'midi_din_out' });
  const rep = rankAttachments(r, { device: 'synth', signal: NOTE3 });
  check('attach: all-tied candidates still rank deterministically',
    rep.candidates.length === 3 && rep.candidates.every((c) => c.relay_dependencies.length === 0));
  const again = rankAttachments(r, { device: 'synth', signal: NOTE3 });
  check('attach: same input gives the same answer (determinism)',
    JSON.stringify(rep.candidates) === JSON.stringify(again.candidates));
}
// Guard rails: the request itself can be unanswerable, and that is reported, not guessed.
{
  const rep = rankAttachments(attachRig(), { device: 'nope', signal: NOTE3 });
  check('attach: unknown device -> error', rep.ok === false && rep.error?.includes('not a node') === true);
}
{
  const r = attachRig();
  r.edges.push({
    id: 'occupied', directed: true,
    from: { node: 'seq', port: 'out_b' }, to: { node: 'synth', port: 'midi_in' },
    signal: { kind: 'midi', signals: [{ type: 'note', channel: 3 }] },
  });
  const rep = rankAttachments(r, { device: 'synth', signal: NOTE3 });
  check('attach: target with no free input -> error',
    rep.ok === false && rep.error?.includes('no free MIDI input') === true);
}
{
  const r = attachRig();
  r.nodes.push({
    id: 'seq2', name: 'Second Sequencer', identity: { manufacturer: 'T', family: 'Seq' },
    server_device_id: null, roles: ['sequencer'],
    ports: [{ id: 'out', kind: 'midi_din_out' }],
    routing: { originate: [{ port: 'out', kind: 'midi', type: 'note', channel: 3 }] },
  });
  const rep = rankAttachments(r, { device: 'synth', signal: NOTE3 });
  check('attach: ambiguous origin is reported, never guessed',
    rep.ok === false && rep.error?.includes('more than one node') === true);
  const pinned = rankAttachments(r, { device: 'synth', signal: NOTE3, origin: 'seq2' });
  check('attach: naming the origin resolves the ambiguity',
    pinned.ok === true && pinned.best?.from.node_id === 'seq2');
}

// --- audio payloads must declare their channels ----------------------------
// Found by running the view model against a real manifest for the first time:
// two edges carried `{kind:'audio', signals:[]}`, which validated clean and
// then threw inside summarizeSignal, blanking the entire render.
{
  const r = clone();
  const audio = r.edges.find((e) => e.signal.kind === 'audio');
  if (audio === undefined) throw new Error('fixture: no audio edge');
  (audio.signal as { channels?: unknown }).channels = undefined;
  check('validate: audio edge with no channels -> error', hasError(r, 'audio-signal-no-channels'));
  check('summarize: missing channels reported in words, never thrown',
    summarizeSignal(audio.signal) === 'audio (channels not declared)');
}
{
  const r = clone();
  const audio = r.edges.find((e) => e.signal.kind === 'audio');
  if (audio === undefined) throw new Error('fixture: no audio edge');
  (audio.signal as { channels?: unknown }).channels = [];
  check('validate: audio edge with an empty channel list -> error', hasError(r, 'audio-signal-no-channels'));
}
{
  const r = clone();
  const audio = r.edges.find((e) => e.signal.kind === 'audio');
  if (audio === undefined) throw new Error('fixture: no audio edge');
  (audio.signal as { channels?: unknown }).channels = ['L', 'X'];
  check('validate: audio channel outside L/R/M -> error', hasError(r, 'audio-signal-bad-channel'));
}
check('validate: §10 example still clean after the audio-channel rule', validateRig(LOOPER_HUB_RIG).errors.length === 0);

// --- the render view model + its text rendering ----------------------------
// The text rendering is an accessibility SHIP GATE, not a fallback
// (docs/design/accessibility-blind-support.md), so it is asserted to answer the
// same questions the diagram does rather than merely to be non-empty.
console.log('\nopenrig view model:');
{
  const view = buildRigView(LOOPER_HUB_RIG);
  check('view: one device per node', view.devices.length === LOOPER_HUB_RIG.nodes.length);
  check('view: one link per edge', view.links.length === LOOPER_HUB_RIG.edges.length);
  check('view: counts agree with the manifest',
    view.counts.devices === LOOPER_HUB_RIG.nodes.length &&
    view.counts.links === LOOPER_HUB_RIG.edges.length &&
    view.counts.bindings === (LOOPER_HUB_RIG.bindings?.length ?? 0));
  check('view: enabled + planned partition the links',
    view.counts.enabled_links + view.counts.planned_links === view.counts.links);
  check('view: all four checks reported', view.checks.length === 4 &&
    view.checks.map((c) => c.id).join(',') === 'validate,audio,compat,capacity');
  check('view: every check carries an actionable detail, never a bare count',
    view.checks.every((c) => c.detail.length > 0 && !/^\d+ issues?$/.test(c.detail)));
  check('view: opaque node flagged', view.devices.find((d) => d.id === 'cab')?.opaque === true);
  check('view: link endpoints carry resolved device + port names',
    view.links.every((l) => l.from.node_name.length > 0 && l.to.port_label.length > 0));
  // The §10 example declares no bindings, so governance is projected against a
  // governed variant. A vacuous "0 === 0" would pass while the field was never
  // read, which is exactly the drift the stale prototype literal came from.
  check('view: §10 example genuinely has no governed edge (guards the case below)',
    LOOPER_HUB_RIG.edges.every((e) => e.binding === undefined) && view.links.every((l) => !l.governed));
  {
    const governed = clone();
    governed.bindings = [{
      id: 'am4-scene-recall',
      from: { node: 'am4', emits: { node: 'am4', type: 'cc', channel: 5, cc: 80 } },
      to: { node: 'rc505', expects: { node: 'rc505', type: 'cc', channel: 5, cc: 80 } },
    }];
    const target = governed.edges.find((e) => e.signal.kind === 'midi');
    if (target === undefined) throw new Error('fixture: no midi edge to govern');
    target.binding = 'am4-scene-recall';
    const gv = buildRigView(governed);
    const link = gv.links.find((l) => l.id === target.id);
    check('view: governed link names its binding', link?.governed === true && link.binding === 'am4-scene-recall');
    check('view: only the governed link is marked governed', gv.links.filter((l) => l.governed).length === 1);
    check('view: binding row projected with an agreement verdict',
      gv.bindings.length === 1 && gv.bindings[0].id === 'am4-scene-recall' && typeof gv.bindings[0].agreement_ok === 'boolean');
    check('view: no capability lookup supplied -> gear legality reads unavailable, never passed',
      gv.bindings[0].capability !== 'passed');
    check('text: governed cables say so in words', renderRigText(gv).includes('governed by am4-scene-recall'));
  }
  {
    // §4 lets a binding be named on an individual MidiSignal as well as on the
    // edge, and that is the form real manifests use: one DIN cable carries
    // clock + transport + three note streams and only ONE of them is the
    // governed contract. Reading only edge.binding reported a fully governed
    // rig as fully ungoverned, which is how this case was found.
    const governed = clone();
    governed.bindings = [{
      id: 'circuit-spdsx',
      from: { node: 'circuit', emits: { node: 'circuit', type: 'note', channel: 4 } },
      to: { node: 'spdsx', expects: { node: 'spdsx', type: 'note', channel: 4 } },
    }];
    const target = governed.edges.find((e) => e.signal.kind === 'midi' && e.signal.signals.length > 1);
    if (target === undefined || target.signal.kind !== 'midi') throw new Error('fixture: no multi-signal midi edge');
    const note = target.signal.signals.find((s) => s.type === 'note') ?? target.signal.signals[0];
    note.binding = 'circuit-spdsx';
    const gv = buildRigView(governed);
    const link = gv.links.find((l) => l.id === target.id);
    check('view: signal-level binding marks the cable governed',
      link?.governed === true && link.bindings.includes('circuit-spdsx'));
    check('view: a cable carrying one governed signal among several is still one cable',
      gv.links.filter((l) => l.governed).length === 1);
    check('text: signal-level governance stated in words',
      renderRigText(gv).includes('governed by circuit-spdsx'));
  }
  check('view: timing links flagged distinctly from note data',
    view.links.some((l) => l.timing) && view.links.some((l) => !l.timing));
  check('view: sends/receives reference real link ids', view.devices.every((d) =>
    [...d.sends, ...d.receives].every((id) => view.links.some((l) => l.id === id))));
  check('view: audio verdict only on sound sources',
    view.devices.filter((d) => d.audio_status !== undefined)
      .every((d) => d.roles.some((r) => r === 'sound_source' || r === 'sampler')));
  check('view: findings carry the check that raised them',
    view.findings.every((f) => ['validate', 'audio', 'compat', 'capacity'].includes(f.source)));

  const text = renderRigText(view);
  check('text: names the rig', text.includes(LOOPER_HUB_RIG.name));
  check('text: every device appears', LOOPER_HUB_RIG.nodes.every((n) => text.includes(n.name)));
  check('text: every check question appears', view.checks.every((c) => text.includes(c.question)));
  check('text: states MIDI channels, not just "midi"', /ch\d+/.test(text));
  check('text: states planned cables in words, never by colour alone',
    view.counts.planned_links === 0 || text.includes('PLANNED, not patched'));
  check('text: states audibility in words', text.includes('heard'));
  check('text: never tells a non-sighted reader to look at the diagram',
    !/see the (diagram|graph)|shown above|as pictured/i.test(text));
}

// ---------------------------------------------------------------------------
// L2 / L3: repertoire + performance (§7)
// ---------------------------------------------------------------------------
{
  const rig = clone();
  const song = (): Song => ({
    id: 'night-drive',
    title: 'Night Drive',
    tempo_bpm: 96,
    sections: [{ name: 'Verse', from_bar: 1, to_bar: 16 }, { name: 'Chorus', from_bar: 17, to_bar: 32 }],
    units: [
      { kind: 'param', node: 'am4', block: 'amp', name: 'gain', value: 6.5, role: 'edge of breakup' },
      { kind: 'scene', node: 'am4', scene: 1, section: 'Verse' },
      { kind: 'scene', node: 'am4', scene: 2, section: 'Chorus' },
      { kind: 'recall', node: 'am4', location: 'B02', expected_name: 'Night Drive', status: 'confirmed' },
      { kind: 'recall', node: 'rc505', location: 12 },
      { kind: 'section_map', node: 'circuit', entries: [
        { section: 'Verse', location: 5 }, { section: 'Chorus', location: 6 }] },
      { kind: 'recall', node: 'spdsx', status: 'owed', role: 'kit' },
      { kind: 'recall', node: 'thru', location: 1 },
      { kind: 'channel', node: 'spdsx', channel: 10 },
      { kind: 'emit', node: 'am4', on: { scene: 2 }, to: 'circuit',
        message: { type: 'pc', channel: 16, value: 5 } },
    ],
  });
  const rep = (): Repertoire => ({ rig: rig.id, songs: [song()] });

  const ok = validateRepertoire(rig, rep());
  check('repertoire: a well-formed song validates', ok.ok, JSON.stringify(ok.errors));
  check('repertoire: an owed unit is a warning, not an error',
    ok.warnings.some((w) => w.code === 'owed-unit'));
  check('repertoire: a unit on opaque gear warns that it is set by hand',
    ok.warnings.some((w) => w.code === 'opaque-node'));

  const bad = (mutate: (s: Song) => void, code: string): boolean => {
    const r = rep();
    mutate(r.songs[0]);
    return validateRepertoire(rig, r).errors.some((e) => e.code === code);
  };
  check('repertoire: unknown node errors', bad((s) => { s.units[0].node = 'nope'; }, 'unknown-node'));
  check('repertoire: unknown section errors',
    bad((s) => { (s.units[1] as { section: string }).section = 'Bridge'; }, 'unknown-section'));
  check('repertoire: a recall with no location and not owed errors',
    bad((s) => { delete (s.units[4] as { location?: number }).location; }, 'missing-location'));
  check('repertoire: a bad MIDI message errors',
    bad((s) => { (s.units[9] as { message: { channel: number } }).message.channel = 17; }, 'bad-message'));
  check('repertoire: a bad channel errors',
    bad((s) => { (s.units[8] as { channel: number }).channel = 0; }, 'bad-channel'));
  check('repertoire: a section that ends before it starts errors',
    bad((s) => { s.sections![0].to_bar = 0; }, 'bad-section-range'));
  {
    const r = rep();
    r.songs.push(song());
    check('repertoire: duplicate song id errors',
      validateRepertoire(rig, r).errors.some((e) => e.code === 'duplicate-song'));
    check('repertoire: a repertoire for another rig errors',
      validateRepertoire(rig, { ...rep(), rig: 'other' }).errors.some((e) => e.code === 'rig-mismatch'));
  }

  const plan = planSong(rig, song());
  const tools = plan.steps.map((s) => `${s.tool}:${s.node}`);
  check('plan: recalls come first, then scenes, then edits (a recall would wipe an earlier edit)',
    JSON.stringify(tools) === JSON.stringify([
      'switch_preset:am4', 'switch_preset:rc505', 'switch_preset:circuit', 'switch_scene:am4', 'set_param:am4',
    ]), tools.join(' '));
  check('plan: the device id is the verb port',
    plan.steps[1].device === 'rc-505mk2' && plan.steps[1].args.port === 'rc-505mk2');
  check('plan: defaults to the first section', plan.steps[2].args.location === 5 && plan.steps[3].args.scene === 1);
  const chorus = planSong(rig, song(), { section: 'Chorus' });
  check('plan: a named section picks its own sequence and scene',
    chorus.steps.find((s) => s.node === 'circuit')?.args.location === 6
      && chorus.steps.find((s) => s.tool === 'switch_scene')?.args.scene === 2);
  check('plan: an owed unit is a gap, never a step',
    plan.gaps.some((g) => g.node === 'spdsx' && g.reason === 'owed'));
  check('plan: opaque gear is a by-hand gap',
    plan.gaps.some((g) => g.node === 'thru' && g.reason === 'by-hand'));
  check('plan: emitted MIDI and channels are facts, not steps',
    plan.gaps.filter((g) => g.reason === 'authored-fact').length === 2
      && !plan.steps.some((s) => s.node === 'spdsx'));
  {
    const s = song();
    (s.units[5] as { container?: string }).container = 'Night Drive';
    const p = planSong(rig, s);
    check('plan: a section map inside a container asks for the container to be loaded by hand, and still recalls',
      p.gaps.some((g) => g.node === 'circuit' && g.reason === 'by-hand' && g.detail.includes('Night Drive'))
        && p.steps.some((st) => st.node === 'circuit' && st.tool === 'switch_preset'));
  }
  {
    const p = planSong(rig, song(), { section: 'Chorus 2' });
    const st = p.steps.find((x) => x.node === 'circuit');
    check('plan: a repeat with no location of its own reuses the first occurrence, as a proposal that says so',
      st?.args.location === 6 && st.status === 'proposed' && /reusing the one for Chorus/.test(st.why ?? ''),
      JSON.stringify(st));
    const none = planSong(rig, song(), { section: 'Bridge' });
    check('plan: a named section with no location is a gap, never the first entry',
      !none.steps.some((x) => x.node === 'circuit')
        && none.gaps.some((g) => g.node === 'circuit' && g.reason === 'owed' && g.detail.includes('Bridge')),
      JSON.stringify(none.gaps));
  }
  check('plan: nothing in a plan persists', plan.steps.every((s) => s.effect === 'navigate' || s.effect === 'edit'));
  check('plan: tempo names the clock master', plan.tempo_bpm === 96 && plan.tempo_node === 'rc505');

  const perf: Performance = {
    id: 'set-a', name: 'Set A', rig: rig.id,
    songs: [{ ref: 'night-drive' }, { ref: 'night-drive', tempo_override: 100 }],
  };
  check('performance: a valid setlist validates', validatePerformance(rep(), perf).ok);
  check('performance: an unknown song errors',
    validatePerformance(rep(), { ...perf, songs: [{ ref: 'missing' }] }).errors.some((e) => e.code === 'unknown-song'));
  const plans = planPerformance(rig, rep(), perf);
  check('performance: one plan per position, in order, with the tempo override',
    plans.length === 2 && plans[0].tempo_bpm === 96 && plans[1].tempo_bpm === 100);
}

console.log(failures === 0 ? '\nopenrig: all checks passed' : `\nopenrig: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
