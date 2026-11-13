/**
 * Golden: the rig-edit write path a second client (web UI / MCP App) rides.
 *
 * Covers the rig-edit prerequisites end-to-end against TEMP-dir manifests:
 *   - single-op `executeRigEdit` keeps the pre-batch response shape (no plural fields)
 *   - a batch applies in order, writes the file ONCE with ONE backup
 *   - a batch is all-or-nothing: a failing op reports `failed_op_index` and the
 *     file on disk stays byte-identical
 *   - a validation failure (post-apply `validateRig` errors) writes nothing
 *   - `.bak` retention pruning: newest 20 + anything younger than 7 days survive,
 *     including the backup the triggering write just made
 *   - `absent` (configured path, no file) vs `error` (file present, malformed)
 *   - `createRigManifest`: creates once, refuses to overwrite
 *   - the manifest cache is PATH-aware: changing MCP_RIG_MANIFEST reloads
 *   - the manifest cache is STAMP-aware: a hand edit reloads, a later edit keeps
 *     it, and a write on a stale stamp is refused (RigManifestChangedError)
 *   - edit_rig args: an EXP input cannot drive another pedal input, an implicit
 *     pick never double-books a busy thru-box jack, a named [planned] re-cable
 *     warns, enabling it before unplugging the old cable is refused, and the
 *     response's capacity lists only the touched devices
 *   - `buildRigEditOp` rejects an unknown role naming it + the legal set
 *
 * Run via:  npx tsx scripts/verify-rig-edit.ts
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Rig, RigEditOp, Role } from 'openrig';

import {
  executeRigEdit,
  buildRigEditOp,
  loadRigManifest,
  invalidateRigManifest,
  clearRigManifestCache,
  writeRigManifest,
  createRigManifest,
  loadedRigManifestStamp,
  RigManifestChangedError,
  stampFile,
  sameStamp,
  RIG_MANIFEST_ENV,
} from '../packages/core/src/protocol-generic/openrig/index.js';

let failures = 0;
const fail = (msg: string) => { console.error(`  FAIL ${msg}`); failures++; };
const ok = (msg: string) => console.log(`  OK   ${msg}`);
const assert = (cond: boolean, msg: string) => { cond ? ok(msg) : fail(msg); };

const priorManifest = process.env[RIG_MANIFEST_ENV];
const tempDirs: string[] = [];
function tempDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `verify-rig-edit-${tag}-`));
  tempDirs.push(dir);
  return dir;
}
function pointAt(manifestPath: string): void {
  process.env[RIG_MANIFEST_ENV] = manifestPath;
  invalidateRigManifest();
}
function bakCount(manifestPath: string): number {
  const prefix = `${path.basename(manifestPath)}.`;
  return fs.readdirSync(path.dirname(manifestPath))
    .filter((f) => f.startsWith(prefix) && f.endsWith('.bak')).length;
}

/** A minimal rig that validates clean: a synth cabled to a mixer/monitor. */
function baseRig(): Rig {
  return {
    openrig_version: '0.1',
    id: 'verify-rig-edit',
    name: 'Verify rig',
    nodes: [
      { id: 'synth', name: 'Synth', server_device_id: null, identity: { manufacturer: null, family: 'synth' }, roles: ['sound_source'], ports: [{ id: 'out', kind: 'audio_out' }], capabilities: null },
      { id: 'mixer', name: 'Mixer', server_device_id: null, identity: { manufacturer: null, family: 'mixer' }, roles: ['mixer', 'monitor'], ports: [{ id: 'in', kind: 'audio_in' }], capabilities: null },
    ],
    edges: [
      { id: 'synth-audio', from: { node: 'synth', port: 'out' }, to: { node: 'mixer', port: 'in' }, directed: true, physical_link_id: 'c1', signal: { kind: 'audio', channels: ['L', 'R'] } },
    ],
  };
}

try {
  // --- single-op back-compat: no plural fields, today's exact shape ---------
  console.log('single-op back-compat shape:');
  {
    const dir = tempDir('single');
    const rigPath = path.join(dir, 'rig.json');
    fs.writeFileSync(rigPath, `${JSON.stringify(baseRig(), null, 2)}\n`, 'utf8');
    pointAt(rigPath);

    const res = executeRigEdit({ op: 'set_cable_enabled', cable_id: 'synth-audio', enabled: false });
    assert(res.ok === true && res.saved === true && res.dry_run === false, `single op applies + saves (error: ${res.error})`);
    assert(res.edge_id === 'synth-audio' && typeof res.summary === 'string', 'singular edge_id + summary populated');
    assert(res.backup !== undefined && fs.existsSync(res.backup), 'a .bak was made and exists on disk');
    assert(!('summaries' in res) && !('edge_ids' in res) && !('node_ids' in res), 'no plural fields on a single-op response');
    assert(!('failed_op_index' in res), 'no failed_op_index on a single-op response');
    assert(res.pruned === undefined, 'no pruning on a young backup set');

    const single = executeRigEdit({ op: 'remove_device', device: 'nope' });
    assert(single.ok === false && !('failed_op_index' in single), 'single-op FAILURE also carries no failed_op_index');

    // --- batch happy path: in-order apply, ONE write, ONE backup ------------
    console.log('\nbatch happy path:');
    const baksBefore = bakCount(rigPath);
    const batch = executeRigEdit([
      { op: 'add_device', id: 'mf', name: 'MicroFreak', roles: ['sound_source'], ports: [{ id: 'out', kind: 'audio_out' }] },
      { op: 'add_cable', from: 'MicroFreak', to: 'Mixer', kind: 'audio' },
    ]);
    assert(batch.ok === true && batch.saved === true, `batch applies + saves (error: ${batch.error})`);
    assert(bakCount(rigPath) === baksBefore + 1, `batch write made exactly ONE new .bak (got ${bakCount(rigPath) - baksBefore})`);
    assert(batch.summaries?.length === 2, `batch carries one summary per op (got ${JSON.stringify(batch.summaries)})`);
    assert(JSON.stringify(batch.node_ids) === '["mf"]', `batch node_ids lists the added device (got ${JSON.stringify(batch.node_ids)})`);
    assert(batch.edge_ids?.length === 1, `batch edge_ids lists the added cable (got ${JSON.stringify(batch.edge_ids)})`);
    assert(batch.summary === batch.summaries?.[1], 'singular summary = LAST op\'s (back-compat)');
    const onDisk = JSON.parse(fs.readFileSync(rigPath, 'utf8')) as Rig;
    assert(onDisk.nodes.some((n) => n.id === 'mf') && onDisk.edges.length === 2, 'both ops landed in the written file');

    // --- batch all-or-nothing -----------------------------------------------
    console.log('\nbatch all-or-nothing:');
    const bytesBefore = fs.readFileSync(rigPath);
    const baksBeforeFail = bakCount(rigPath);
    const failed = executeRigEdit([
      { op: 'set_cable_enabled', cable_id: 'synth-audio', enabled: true },
      { op: 'remove_device', device: 'ghost-device' },
      { op: 'remove_cable', cable_id: 'synth-audio' },
    ]);
    assert(failed.ok === false && failed.saved === false, 'failing op mid-batch -> ok=false, nothing saved');
    assert(failed.failed_op_index === 1, `failed_op_index names the failing op (got ${failed.failed_op_index})`);
    assert(fs.readFileSync(rigPath).equals(bytesBefore), 'manifest on disk is byte-identical after the aborted batch');
    assert(bakCount(rigPath) === baksBeforeFail, 'no backup made for an aborted batch');

    // --- validation failure writes nothing ----------------------------------
    console.log('\nvalidation failure:');
    const invalid = executeRigEdit({ op: 'add_device', id: 'bad', name: 'Bad', roles: ['bogus' as Role] });
    assert(invalid.ok === false && invalid.saved === false, 'validateRig-failing edit is refused');
    assert(/unknown-role/.test(invalid.error ?? ''), `refusal names the validation code (got: ${invalid.error})`);
    assert(fs.readFileSync(rigPath).equals(bytesBefore), 'manifest on disk untouched by the refused edit');

    // --- expanded-op batch: the wizard-step shape the op expansion exists for
    console.log('\nexpanded-op batch (wizard step):');
    const baksBeforeWizard = bakCount(rigPath);
    const wizard = executeRigEdit([
      { op: 'add_device', id: 'freak', name: 'MicroFreak', roles: ['sound_source'], ports: [{ id: 'out', kind: 'audio_out', audio: 'mono' }, { id: 'usb', kind: 'usb_midi' }] },
      { op: 'add_cable', from: 'freak', to: 'Mixer', kind: 'audio' },
      { op: 'add_port', device: 'Mixer', id: 'main_out', kind: 'audio_out', label: 'MAIN OUT' },
      { op: 'update_port', device: 'Mixer', port_id: 'main_out', output_role: 'main' },
      { op: 'add_binding', id: 'freak-cutoff', from: 'synth', to: 'freak', emits: { type: 'cc', channel: 3, cc: 23, target: 'cutoff' } },
      { op: 'set_routing', device: 'Mixer', routing: { consume: [{ port: 'in', kind: 'audio' }] } },
    ]);
    assert(wizard.ok === true && wizard.saved === true, `expanded-op batch applies + saves (error: ${wizard.error})`);
    assert(bakCount(rigPath) === baksBeforeWizard + 1, 'wizard batch made exactly ONE new .bak');
    assert(JSON.stringify(wizard.port_ids) === '["main_out","main_out"]', `batch port_ids collects port ops in order (got ${JSON.stringify(wizard.port_ids)})`);
    assert(JSON.stringify(wizard.binding_ids) === '["freak-cutoff"]', `batch binding_ids collects binding ops (got ${JSON.stringify(wizard.binding_ids)})`);
    assert(wizard.summaries?.length === 6, `one summary per op (got ${wizard.summaries?.length})`);
    const wizardDisk = JSON.parse(fs.readFileSync(rigPath, 'utf8')) as Rig;
    assert(wizardDisk.nodes.find((n) => n.id === 'mixer')?.ports.find((p) => p.id === 'main_out')?.output_role === 'main',
      'output_role landed in the written file');
    assert(wizardDisk.bindings?.some((b) => b.id === 'freak-cutoff') === true, 'binding landed in the written file');
    assert(wizardDisk.nodes.find((n) => n.id === 'mixer')?.routing?.consume?.length === 1, 'routing landed in the written file');

    // update_cable patches in place through the executor; single-op response
    // stays singular (no plural fields).
    const patch = executeRigEdit({ op: 'update_cable', cable_id: 'synth-audio', audio_channels: ['M'] });
    assert(patch.ok === true && patch.edge_id === 'synth-audio' && !('edge_ids' in patch), 'single update_cable keeps the singular shape');
    const patched = JSON.parse(fs.readFileSync(rigPath, 'utf8')) as Rig;
    const patchedSig = patched.edges.find((e) => e.id === 'synth-audio')?.signal;
    assert(patchedSig?.kind === 'audio' && JSON.stringify(patchedSig.channels) === '["M"]', 'update_cable patch landed on disk');

    // remove_binding refusal is a plain failed op through the executor too.
    const govern = executeRigEdit({ op: 'update_cable', cable_id: 'synth-audio', note: 'governed test prep' });
    assert(govern.ok === true, 'prep patch applies');
    const refuse = executeRigEdit([
      { op: 'set_routing', device: 'freak', routing: { consume: [{ port: 'usb', binding: 'freak-cutoff' }] } },
      { op: 'remove_binding', binding_id: 'freak-cutoff' },
    ]);
    assert(refuse.ok === false && refuse.failed_op_index === 1, `referenced remove_binding fails the batch at index 1 (got ${refuse.failed_op_index}, error: ${refuse.error})`);
    assert(/still referenced by: device freak routing/.test(refuse.error ?? ''), `refusal names the routing referent (got: ${refuse.error})`);
  }

  // --- .bak pruning: newest 20 + anything under 7 days survive --------------
  console.log('\n.bak pruning:');
  {
    const dir = tempDir('prune');
    const rigPath = path.join(dir, 'rig.json');
    fs.writeFileSync(rigPath, `${JSON.stringify(baseRig(), null, 2)}\n`, 'utf8');
    pointAt(rigPath);

    const oldDate = new Date('2019-06-01T00:00:00Z');
    const oldNames: string[] = [];
    for (let i = 0; i < 25; i++) {
      const name = `rig.json.2019-06-01T00-00-${String(i).padStart(2, '0')}-000Z.bak`;
      const full = path.join(dir, name);
      fs.writeFileSync(full, '{}', 'utf8');
      fs.utimesSync(full, oldDate, oldDate);
      oldNames.push(name);
    }
    // Lexically OLDEST name but a FRESH mtime: age protection must keep it.
    const youngName = 'rig.json.2000-01-01T00-00-00-000Z.bak';
    fs.writeFileSync(path.join(dir, youngName), '{}', 'utf8');

    const wrote = writeRigManifest(baseRig());
    // 26 seeded + 1 current = 27; excess past the newest 20 = 7 lexically-oldest;
    // of those the young-mtime one is protected, so 6 old ones go.
    assert(wrote.pruned?.length === 6, `6 stale backups pruned (got ${wrote.pruned?.length}: ${JSON.stringify(wrote.pruned)})`);
    assert(wrote.pruned?.every((f) => oldNames.includes(f)) === true, 'every pruned file is one of the seeded stale .baks');
    assert(fs.existsSync(path.join(dir, youngName)), 'a <7-day-old backup survives even past the keep count');
    assert(wrote.backup !== undefined && fs.existsSync(wrote.backup), 'the CURRENT write\'s backup survives pruning');
    assert(bakCount(rigPath) === 21, `21 backups remain: newest 20 + the young protected one (got ${bakCount(rigPath)})`);
  }

  // --- absent vs error ------------------------------------------------------
  console.log('\nabsent vs error:');
  {
    const dir = tempDir('absent');
    const rigPath = path.join(dir, 'missing.json');
    pointAt(rigPath);

    const missing = loadRigManifest();
    assert(missing.status === 'absent', `configured path with no file -> status absent (got ${missing.status})`);
    assert(missing.status === 'absent' && missing.source === rigPath, 'absent carries the configured source path');

    const edit = executeRigEdit({ op: 'remove_cable', cable_id: 'x' });
    assert(edit.ok === false && /does not exist yet/.test(edit.error ?? ''), 'edit on an absent manifest is refused as not-yet-created');
    assert(/createRigManifest/.test(edit.error ?? ''), `the refusal names the create path (got: ${edit.error})`);

    fs.writeFileSync(rigPath, '{ this is not json', 'utf8');
    invalidateRigManifest();
    const malformed = loadRigManifest();
    assert(malformed.status === 'error', `malformed JSON -> status error, not absent (got ${malformed.status})`);
    assert(malformed.status === 'error' && /not valid JSON/.test(malformed.error), 'error names the JSON parse failure');
  }

  // --- createRigManifest: create once, refuse overwrite ---------------------
  console.log('\ncreateRigManifest:');
  {
    const dir = tempDir('create');
    const rigPath = path.join(dir, 'new-rig.json');
    pointAt(rigPath);
    assert(loadRigManifest().status === 'absent', 'starts absent');

    const created = createRigManifest(baseRig());
    assert(created.created === true && created.source === rigPath && fs.existsSync(rigPath), 'createRigManifest writes the file');
    const loaded = loadRigManifest();
    assert(loaded.status === 'loaded' && loaded.rig.id === 'verify-rig-edit', 'create invalidated the cache: next load sees the new rig');

    let threw = '';
    try { createRigManifest(baseRig()); } catch (e) { threw = (e as Error).message; }
    assert(/already exists/.test(threw), `second create refuses (got: ${threw || 'no throw'})`);
  }

  // --- path-aware cache: env change reloads without an explicit invalidate --
  console.log('\npath-aware cache:');
  {
    const dir = tempDir('cache');
    const pathA = path.join(dir, 'rig-a.json');
    const pathB = path.join(dir, 'rig-b.json');
    fs.writeFileSync(pathA, JSON.stringify({ ...baseRig(), id: 'rig-a' }), 'utf8');
    fs.writeFileSync(pathB, JSON.stringify({ ...baseRig(), id: 'rig-b' }), 'utf8');

    pointAt(pathA);
    const a = loadRigManifest();
    assert(a.status === 'loaded' && a.rig.id === 'rig-a', 'loads rig A');
    process.env[RIG_MANIFEST_ENV] = pathB; // NO invalidate: the path change alone must reload
    const b = loadRigManifest();
    assert(b.status === 'loaded' && b.rig.id === 'rig-b', `env path change reloads without invalidate (got ${b.status === 'loaded' ? b.rig.id : b.status})`);
    assert(clearRigManifestCache === invalidateRigManifest, 'clearRigManifestCache stays as an alias of invalidateRigManifest');
  }

  // --- stamp-aware cache: a HAND EDIT is seen, and never overwritten ---------
  // 2026-09-16: describe_rig reported 20 cables against 23 on disk after a hand
  // edit, and the next edit_rig would have rebuilt from the stale copy and
  // written it back over the hand edits.
  console.log('\nstamp-aware cache (hand edits):');
  {
    const dir = tempDir('stamp');
    const rigPath = path.join(dir, 'rig.json');
    fs.writeFileSync(rigPath, `${JSON.stringify(baseRig(), null, 2)}\n`, 'utf8');
    pointAt(rigPath);
    const first = loadRigManifest();
    assert(first.status === 'loaded' && first.rig.nodes.length === 2, 'loads the base rig');

    // hand edit: add a node outside the server
    const hand = baseRig();
    hand.nodes.push({ id: 'hand', name: 'Hand-added', server_device_id: null, identity: { manufacturer: null, family: null }, roles: ['sound_source'], ports: [], capabilities: null });
    fs.writeFileSync(rigPath, `${JSON.stringify(hand, null, 2)}\n`, 'utf8');
    const second = loadRigManifest();
    assert(second.status === 'loaded' && second.rig.nodes.some((n) => n.id === 'hand'), 'a hand edit is visible on the next load, with no invalidate call');

    const edit = executeRigEdit({ op: 'add_device', id: 'viaTool', name: 'Via tool', roles: ['effect'] });
    const onDisk = JSON.parse(fs.readFileSync(rigPath, 'utf8')) as Rig;
    assert(edit.ok === true && onDisk.nodes.some((n) => n.id === 'hand') && onDisk.nodes.some((n) => n.id === 'viaTool'),
      `an edit after a hand edit keeps the hand edit (error: ${edit.error})`);

    // write guard: a stale stamp refuses, nothing written, no backup
    loadRigManifest();
    const staleStamp = loadedRigManifestStamp();
    fs.writeFileSync(rigPath, `${JSON.stringify({ ...onDisk, name: 'changed underneath, longer name' }, null, 2)}\n`, 'utf8');
    const bytes = fs.readFileSync(rigPath);
    const baks = bakCount(rigPath);
    let guardErr: unknown;
    try { writeRigManifest(baseRig(), { ifUnchangedSince: staleStamp }); } catch (e) { guardErr = e; }
    assert(guardErr instanceof RigManifestChangedError, `a write on a stale stamp throws RigManifestChangedError (got ${String(guardErr)})`);
    assert(fs.readFileSync(rigPath).equals(bytes) && bakCount(rigPath) === baks, 'the refused write left the file and backups untouched');
    assert(sameStamp(stampFile(rigPath), stampFile(rigPath)) && !sameStamp('absent', stampFile(rigPath)), 'stamp helpers: equal to itself, differs from absent');
  }

  // --- edit_rig through the tool args: jack choice, direction, response size --
  console.log('\nedit_rig args (jack choice + direction):');
  {
    const dir = tempDir('jacks');
    const rigPath = path.join(dir, 'rig.json');
    const rig = baseRig();
    rig.nodes.push(
      { id: 'thru', name: 'Quadra Thru', server_device_id: null, identity: { manufacturer: null, family: null }, roles: ['midi_router'], capabilities: null,
        ports: [{ id: 'in', kind: 'midi_din_in' }, { id: 'out1', kind: 'midi_din_out' }, { id: 'out4', kind: 'midi_din_out' }] },
      { id: 'hydra', name: 'Hydrasynth', server_device_id: null, identity: { manufacturer: null, family: null }, roles: ['sound_source'], capabilities: null,
        ports: [{ id: 'midi_in', kind: 'midi_din_in' }] },
      { id: 'am4', name: 'AM4', server_device_id: null, identity: { manufacturer: null, family: null }, roles: ['effect'], capabilities: null,
        ports: [{ id: 'midi_in', kind: 'midi_din_in' }, { id: 'pedal1', kind: 'expression', direction: 'in' }] },
    );
    rig.edges.push(
      { id: 'quadra-to-hydra', from: { node: 'thru', port: 'out1' }, to: { node: 'hydra', port: 'midi_in' }, directed: true, physical_link_id: 'd1', signal: { kind: 'midi', signals: [{ type: 'clock' }] } },
      { id: 'quadra-to-am4', from: { node: 'thru', port: 'out4' }, to: { node: 'am4', port: 'midi_in' }, directed: true, physical_link_id: 'd4', signal: { kind: 'midi', signals: [{ type: 'clock' }] } },
    );
    fs.writeFileSync(rigPath, `${JSON.stringify(rig, null, 2)}\n`, 'utf8');
    pointAt(rigPath);

    const pedal = executeRigEdit(buildRigEditOp({
      operation: 'add_device', id: 'xs100', name: 'XS-100', roles: ['effect'],
      ports: [{ id: 'ctl_exp2', kind: 'expression', direction: 'in' }, { id: 'midi_in', kind: 'midi_din_in' }, { id: 'midi_out', kind: 'midi_din_out' }],
    }));
    assert(pedal.ok === true, `add_device with a direction-declared EXP input applies (error: ${pedal.error})`);
    assert(pedal.capacity?.devices.length === 1 && pedal.capacity.devices[0].id === 'xs100',
      `capacity.devices lists only the touched device (got ${JSON.stringify(pedal.capacity?.devices.map((d) => d.id))})`);
    assert(pedal.capacity?.free_by_kind.midi_din_in?.some((p) => p.node_id === 'xs100') === true, 'capacity.free_by_kind still covers the whole rig');

    const bytes = fs.readFileSync(rigPath);
    const exp = executeRigEdit(buildRigEditOp({ operation: 'add_cable', from: 'XS-100', to: 'AM4', kind: 'expression' }));
    assert(exp.ok === false && /\(ctl_exp2\) is an INPUT/.test(exp.error ?? '') && /XS-100 has no expression output/.test(exp.error ?? ''),
      `EXP input -> pedal input is refused with the reason (got: ${exp.error})`);
    assert(fs.readFileSync(rigPath).equals(bytes), 'the refused cable wrote nothing');

    const busy = executeRigEdit(buildRigEditOp({ operation: 'add_cable', from: 'thru', to: 'xs100', kind: 'midi', midi_type: 'clock', enabled: false }));
    assert(busy.ok === false && /no free MIDI output: out1 \(quadra-to-hydra\), out4 \(quadra-to-am4\)/.test(busy.error ?? ''),
      `implicit pick onto a full thru box refuses instead of double-booking the Hydra's jack (got: ${busy.error})`);

    const planned = executeRigEdit(buildRigEditOp({ operation: 'add_cable', from: 'thru', to: 'xs100', from_port: 'out4', kind: 'midi', midi_type: 'clock', enabled: false }));
    assert(planned.ok === true && planned.warnings?.length === 1 && /out4 still holds live cable quadra-to-am4/.test(planned.warnings[0]),
      `a named [planned] re-cable onto out4 applies with a warning (error: ${planned.error}, warnings: ${JSON.stringify(planned.warnings)})`);
    const planDisk = JSON.parse(fs.readFileSync(rigPath, 'utf8')) as Rig;
    const planEdge = planDisk.edges.find((e) => e.id === planned.edge_id);
    assert(planEdge?.from.port === 'out4' && planEdge.to.port === 'midi_in' && planEdge.enabled === false, 'the planned cable landed on out4 -> xs100.midi_in');

    const enableEarly = executeRigEdit(buildRigEditOp({ operation: 'set_cable_enabled', cable_id: planned.edge_id!, enabled: true }));
    assert(enableEarly.ok === false && /already holds live cable quadra-to-am4/.test(enableEarly.error ?? ''), `enabling before unplugging the old cable is refused (got: ${enableEarly.error})`);
    const unplug = executeRigEdit(buildRigEditOp({ operation: 'set_cable_enabled', cable_id: 'quadra-to-am4', enabled: false }));
    const plugIn = executeRigEdit(buildRigEditOp({ operation: 'set_cable_enabled', cable_id: planned.edge_id!, enabled: true }));
    assert(unplug.ok === true && plugIn.ok === true, `the re-cable completes in order: disable old, enable new (errors: ${unplug.error} / ${plugIn.error})`);
  }

  // --- buildRigEditOp: shared arg validation --------------------------------
  console.log('\nbuildRigEditOp:');
  {
    const op = buildRigEditOp({ operation: 'add_device', id: 'mf', name: 'MicroFreak', roles: ['sound_source'] });
    assert(op.op === 'add_device' && (op as Extract<RigEditOp, { op: 'add_device' }>).id === 'mf', 'happy add_device builds the typed op');

    let roleErr = '';
    try { buildRigEditOp({ operation: 'add_device', id: 'x', name: 'X', roles: ['sound_sorce'] }); } catch (e) { roleErr = (e as Error).message; }
    assert(/"sound_sorce" is not an OpenRig role/.test(roleErr), `unknown role throws naming the bad role (got: ${roleErr || 'no throw'})`);
    assert(/sound_source/.test(roleErr) && /clock_master/.test(roleErr), 'the role error names the legal set');

    let missingErr = '';
    try { buildRigEditOp({ operation: 'add_cable', from: 'a' }); } catch (e) { missingErr = (e as Error).message; }
    assert(missingErr === 'edit_rig add_cable needs from, to, and kind.', `missing-arg message unchanged (got: ${missingErr})`);
  }
} finally {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  if (priorManifest === undefined) delete process.env[RIG_MANIFEST_ENV];
  else process.env[RIG_MANIFEST_ENV] = priorManifest;
  invalidateRigManifest();
}

console.log(failures === 0 ? '\nverify-rig-edit passed.' : `\n${failures} verify-rig-edit assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
