/**
 * Gen-3 fresh-build apply_preset (chunk B of the 2026-11-25 whole-preset
 * build): the planner (inference, shunts, OUTPUT, duplicates, instance
 * limits, scene completion) and the executor against a stateful simulated
 * unit (scripts/_lib/gen3-stateful-sim.ts): clear by template load or the
 * paced per-cell fallback, placement, cables, every scene, name restore,
 * read-back verification, save gating, plus set_block's grid guard and the
 * gen-3 verify_chain. Offline; no MIDI I/O.
 *
 * Run: npx tsx scripts/verify-gen3-fresh-build.ts
 */
import { createModernFractalDescriptor } from '../packages/fractal-gen3/dist/factory.js';
import { FM9_CONFIG } from '../packages/fractal-gen3/dist/configs/fm9.js';
import { FM3_CONFIG } from '../packages/fractal-gen3/dist/configs/fm3.js';
import { planGen3Build, SHUNT_EFFECT_ID_BASE } from '../packages/fractal-gen3/dist/buildPlan.js';
import type { PlanContext } from '../packages/fractal-gen3/dist/buildPlan.js';
import { chainFromLiveGrid } from '../packages/fractal-gen3/dist/applyBuild.js';
import { SpecValidationError } from '@mcp-midi-control/core/protocol-generic/types.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { createGen3Sim } from './_lib/gen3-stateful-sim.js';

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { ok++; console.log(`  OK   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`); }
}

const FM9 = 0x12;
const FM3 = 0x11;
const EID = { input: 37, output: 42, comp: 46, amp: 58, amp2: 59, cab: 62, reverb: 66, delay: 70, drive: 118, drive2: 119 };
const fm9 = createModernFractalDescriptor(FM9_CONFIG);
const fm3 = createModernFractalDescriptor(FM3_CONFIG);
const BLOCK_IDS: Record<string, number> = { input: 37, output: 42, compressor: 46, amp: 58, cab: 62, reverb: 66, delay: 70, chorus: 78, drive: 118 };
const ctxFor = (model: number, rows: number, cols: number): PlanContext => ({
  rows, cols, modelByte: model, sceneCount: 8, channelNames: ['A', 'B', 'C', 'D'], deviceLabel: 'sim',
  resolveEffectId: (slug, inst) => { const b = BLOCK_IDS[slug]; if (b === undefined) throw new Error(`unknown block ${slug}`); return b + inst - 1; },
});
const P9 = ctxFor(FM9, 6, 14);
const P3 = ctxFor(FM3, 4, 12);

console.log('1. planner: routing inference');
{
  const spec: PresetSpec = {
    slots: [
      { slot: { row: 3, col: 2 }, block_type: 'drive' },
      { slot: { row: 3, col: 3 }, block_type: 'amp' },
      { slot: { row: 3, col: 4 }, block_type: 'cab' },
      { slot: { row: 3, col: 6 }, block_type: 'delay' },
      { slot: { row: 3, col: 9 }, block_type: 'reverb' },
    ],
  };
  const { plan, errors } = planGen3Build(spec, P9);
  check('plans with no errors', errors.length === 0 && plan !== undefined, JSON.stringify(errors));
  const at = (c: number) => plan!.cells.find((x) => x.row === 3 && x.col === c);
  check('Input 1 (37) at r3c1', at(1)?.effectId === EID.input && at(1)?.auto === true);
  check('Output 1 (42) at r3c10, the column after the last block', at(10)?.effectId === EID.output);
  const shunts = plan!.cells.filter((c) => c.kind === 'shunt');
  check('gaps c5, c7, c8 filled with shunts', shunts.map((s) => s.col).sort((a, b) => a - b).join() === '5,7,8', shunts.map((s) => s.col).join());
  check('shunt ids are 1024 + 0, 1, 2 (unique, lowest first)', shunts.map((s) => s.effectId - SHUNT_EFFECT_ID_BASE).sort().join() === '0,1,2');
  check('one cable per adjacent pair, c1 -> c10 (9 cables)', plan!.cables.length === 9 && plan!.cables.every((c) => c.from.row === 3 && c.to.row === 3 && c.to.col === c.from.col + 1));
  check('no scene writing needed (all A / engaged)', plan!.scenesNeedWriting === false && plan!.scenes.length === 8);
}
{
  const r = planGen3Build({ slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }] }, P9);
  check('a non-Input block in column 1 is refused (inference on)', r.errors.length === 1 && /Input 1 goes in column 1/.test(r.errors[0].error), JSON.stringify(r.errors));
  const r2 = planGen3Build({ slots: [{ slot: { row: 2, col: 2 }, block_type: 'amp' }, { slot: { row: 3, col: 3 }, block_type: 'cab' }] }, P9);
  check('blocks on two rows without routing are refused', r2.errors.length === 1 && /ONE row/.test(r2.errors[0].error));
  const r3 = planGen3Build({ slots: [{ slot: { row: 2, col: 12 }, block_type: 'amp' }] }, P3);
  check('FM3: a chain reaching column 12 has no room for Output -> refused', r3.errors.length === 1 && /no room for Output/.test(r3.errors[0].error), JSON.stringify(r3.errors));
  const r4 = planGen3Build({ slots: [{ slot: { row: 2, col: 2 }, block_type: 'amp' }] }, P3);
  check('FM3: amp at c2 -> Input c1, Output c3 on row 2', r4.plan?.cells.length === 3 && r4.plan.cells.some((c) => c.effectId === 42 && c.col === 3 && c.row === 2));
}

console.log('2. planner: explicit routing');
{
  const spec: PresetSpec = {
    slots: [
      { slot: { row: 3, col: 2 }, block_type: 'drive' },
      { slot: { row: 2, col: 3 }, block_type: 'amp' },
      { slot: { row: 4, col: 3 }, block_type: 'amp', instance: 2 },
      { slot: { row: 3, col: 6 }, block_type: 'reverb' },
    ],
    routing: [
      { from: 'drive', to: 'amp' }, { from: 'drive', to: 'amp_2' },
      { from: 'amp', to: 'reverb' }, { from: 'amp_2', to: 'reverb' }, { from: 'reverb', to: 'OUTPUT' },
    ],
  };
  const { plan, errors } = planGen3Build(spec, P9);
  check('wet/dry split plans', errors.length === 0, JSON.stringify(errors));
  const output = plan?.cells.find((c) => c.effectId === EID.output);
  check('{to:"OUTPUT"} places Output 1 at r3c7', output?.row === 3 && output.col === 7);
  check('Input 1 added at r3c1 feeding the drive', plan?.cells.some((c) => c.effectId === EID.input && c.row === 3 && c.col === 1) === true && plan!.cables.some((c) => c.from.col === 1 && c.to.col === 2));
  const bridge = plan?.cells.filter((c) => c.kind === 'shunt') ?? [];
  check('amp(r2c3) -> reverb(r3c6) bridged by shunts on r3 c4,c5 (shared by both amps)', bridge.length === 2 && bridge.every((s) => s.row === 3) && bridge.map((s) => s.col).sort().join() === '4,5', JSON.stringify(bridge));
  check('first bridge cable leaves the source row: r2c3 -> r3c4 and r4c3 -> r3c4', plan!.cables.some((c) => c.from.row === 2 && c.from.col === 3 && c.to.row === 3 && c.to.col === 4) && plan!.cables.some((c) => c.from.row === 4 && c.to.row === 3 && c.to.col === 4));
}
{
  const bad = planGen3Build({
    slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }, { slot: { row: 3, col: 3 }, block_type: 'cab' }, { slot: { row: 3, col: 4 }, block_type: 'reverb' }],
    routing: [{ from: 'amp', to: 'reverb' }, { from: 'ghost', to: 'OUTPUT' }],
  }, P9);
  check('a bridge through an occupied cell is a validation error', bad.errors.some((e) => /needs a shunt at r3c3/.test(e.error)), JSON.stringify(bad.errors));
  check('an unknown edge id is a validation error (never skipped)', bad.errors.some((e) => e.path === 'routing[1].from' && /no slot has id "ghost"/.test(e.error)));
}

console.log('3. planner: duplicates, limits, scenes');
{
  const dup = planGen3Build({ slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }, { slot: { row: 3, col: 3 }, block_type: 'amp' }] }, P9);
  check('the same block twice is refused', dup.errors.some((e) => /already places amp 1/.test(e.error)), JSON.stringify(dup.errors));
  const lim = planGen3Build({ slots: [{ slot: { row: 2, col: 2 }, block_type: 'amp', instance: 2 }] }, P3);
  check('FM3 Amp 2 is refused by the instance limit (source labelled)', lim.errors.some((e) => /allows 1 amp block/.test(e.error) && /forgefx-unverified/.test(e.error)), JSON.stringify(lim.errors));
  const lim9 = planGen3Build({ slots: [{ slot: { row: 2, col: 2 }, block_type: 'amp', instance: 3 }] }, P9);
  check('FM9 Amp 3 is refused (fractone hardware limit 2)', lim9.errors.some((e) => /allows 2 amp blocks/.test(e.error) && /fm9-hardware-fractone/.test(e.error)));
  const cell = planGen3Build({ slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }, { slot: { row: 3, col: 2 }, block_type: 'cab' }] }, P9);
  check('two blocks in one cell are refused', cell.errors.some((e) => /already taken/.test(e.error)));

  const sc = planGen3Build({
    slots: [
      { slot: { row: 3, col: 2 }, block_type: 'drive', bypassed: true },
      { slot: { row: 3, col: 3 }, block_type: 'amp' },
      { slot: { row: 3, col: 4 }, block_type: 'cab' },
    ],
    scenes: [
      { scene: 1, channels: { amp: 'A' } },
      { scene: 3, channels: { amp: 'C' }, bypassed: { drive: false } },
    ],
  }, P9);
  const s = (n: number, id: string) => sc.plan!.scenes[n - 1].blocks.find((b) => b.id === id)!;
  check('scene 1: drive bypassed from slot.bypassed, amp A', s(1, 'drive').bypassed && s(1, 'amp').channel === 0);
  check('scene 3 (authored): amp C, drive engaged, cab copied from scene 1', s(3, 'amp').channel === 2 && !s(3, 'drive').bypassed && s(3, 'cab').channel === 0 && !s(3, 'cab').bypassed);
  check('scene 5 (unauthored) copies scene 1', s(5, 'drive').bypassed && s(5, 'amp').channel === 0 && !sc.plan!.scenes[4].authored);
  check('scenes need writing', sc.plan!.scenesNeedWriting);
  const badKey = planGen3Build({ slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }], scenes: [{ scene: 2, channels: { amp_9: 'B' } }] }, P9);
  check('a scene key that is not a placed block is a validation error', badKey.errors.some((e) => e.path === 'scenes[0].channels.amp_9'));
}

console.log('4. validatePreset reports every planner error at once');
{
  let caught: unknown;
  try { fm9.writer.validatePreset!({ slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }, { slot: { row: 2, col: 2 }, block_type: 'amp' }] }); } catch (e) { caught = e; }
  check('throws SpecValidationError with structured errors', caught instanceof SpecValidationError && caught.errors.length >= 1, String(caught));
  let none: unknown;
  try { fm9.writer.validatePreset!({ slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }] }); } catch (e) { none = e; }
  check('a valid spec does not throw', none === undefined, String(none));
}

console.log('5. executor: FM9 5-block, 8-scene build on a populated preset');
{
  const sim = createGen3Sim({
    modelByte: FM9, rows: 6, cols: 14, presetNumber: 12, name: 'Old Tone',
    initial: [{ row: 2, col: 1, id: EID.input }, { row: 2, col: 2, id: EID.comp, mask: 2 }, { row: 2, col: 3, id: EID.output, mask: 2 }],
  });
  const spec: PresetSpec = {
    name: 'Lead Rig',
    slots: [
      { slot: { row: 3, col: 2 }, block_type: 'drive', bypassed: true },
      { slot: { row: 3, col: 3 }, block_type: 'amp' },
      { slot: { row: 3, col: 4 }, block_type: 'cab' },
      { slot: { row: 3, col: 5 }, block_type: 'delay' },
      { slot: { row: 3, col: 7 }, block_type: 'reverb' },
    ],
    scenes: [
      { scene: 1, name: 'Rhythm', channels: { amp: 'A' } },
      { scene: 2, channels: { amp: 'B' }, bypassed: { drive: false } },
      { scene: 3, channels: { amp: 'C', delay: 'B' }, bypassed: { drive: false } },
      { scene: 4, channels: {}, bypassed: { reverb: true } },
    ],
    landingScene: 2,
  };
  const t = Date.now();
  const r = await fm9.writer.applyPreset!(sim.ctx, spec);
  const elapsed = Date.now() - t;
  check('apply ok', r.ok, `${r.failed_step?.description}: ${r.failed_step?.error} | ${r.warning}`);
  check('chain_integrity from the read-back: ok', r.chain_integrity?.ok === true && /matches the build/.test(r.chain_integrity.summary), r.chain_integrity?.summary);
  const g = (row: number, col: number) => sim.grid.get(`${row},${col}`);
  check('old blocks gone (template load cleared the buffer)', g(2, 2) === undefined && g(2, 1) === undefined);
  check('Input 1 r3c1, drive c2, amp c3, cab c4, delay c5, shunt c6, reverb c7, Output 1 c8',
    g(3, 1)?.id === 37 && g(3, 2)?.id === 118 && g(3, 3)?.id === 58 && g(3, 4)?.id === 62 && g(3, 5)?.id === 70 && g(3, 6)?.id === 1024 && g(3, 7)?.id === 66 && g(3, 8)?.id === 42);
  check('every cell c2..c8 cabled from row 3', [2, 3, 4, 5, 6, 7, 8].every((c) => g(3, c)?.mask === 0b100));
  const st = (scene: number, id: number) => sim.scenes[scene - 1].get(id)!;
  check('scene 1: drive bypassed, amp A', st(1, 118).bypassed && st(1, 58).channel === 0);
  check('scene 2: amp B, drive engaged', st(2, 58).channel === 1 && !st(2, 118).bypassed);
  check('scene 3: amp C, delay B', st(3, 58).channel === 2 && st(3, 70).channel === 1);
  check('scene 4: reverb bypassed, drive bypassed (from scene 1)', st(4, 66).bypassed && st(4, 118).bypassed);
  check('scenes 5-8 (unauthored) copy scene 1', [5, 6, 7, 8].every((n) => st(n, 118).bypassed && st(n, 58).channel === 0 && !st(n, 66).bypassed));
  check('landed on scene 2', sim.state.activeScene === 1);
  check('preset named "Lead Rig" (read back)', sim.state.name === 'Lead Rig');
  check('scene 1 name sent', sim.state.sceneNames[0] === 'Rhythm');
  check('nothing stored (no target)', sim.stored.get(12) === 'Old Tone');
  const frames = sim.sent.length;
  console.log(`  (measured: ${frames} frames sent, ${elapsed} ms wall clock in the sim; budget 5000 ms excl. device latency)`);
  check(`5-block 8-scene build within the 5 s budget in the sim (${elapsed} ms)`, elapsed < 5000);
  // Selects always precede inserts.
  const inserts = sim.sent.map((s, i) => ({ s, i })).filter(({ s }) => s.bytes[5] === 0x01 && s.bytes[6] === 0x32);
  check('every insert follows a cell select', inserts.every(({ i }) => sim.sent[i - 1].bytes[6] === 0x30));
}

console.log('6. executor: name restored when the spec gives none');
{
  const sim = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, name: 'Keep Me' });
  const r = await fm9.writer.applyPreset!(sim.ctx, { slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }] });
  check('ok', r.ok, r.warning);
  check('the template\'s "<EMPTY>" is replaced by the old name', sim.state.name === 'Keep Me', sim.state.name);
  check('no scene WRITES for a default build (one active-scene read + one status read only)', !sim.sent.some((s) => (s.bytes[5] === 0x0c && s.bytes[6] !== 0x7f) || s.bytes[5] === 0x0a) && sim.sent.filter((s) => s.bytes[5] === 0x13).length === 1);
}

console.log('7. executor: verification mismatch -> not ok');
{
  const sim = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, faults: { dropInsert: new Set([EID.reverb]) } });
  const r = await fm9.writer.applyPreset!(sim.ctx, { slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }, { slot: { row: 3, col: 3 }, block_type: 'reverb' }] });
  check('a dropped insert makes the apply NOT ok', r.ok === false);
  check('chain_integrity lists the missing block', r.chain_integrity?.ok === false && r.chain_integrity.breaks.some((b) => /missing/.test(b.reason)), JSON.stringify(r.chain_integrity));
  const sim2 = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, faults: { dropCableTo: new Set(['3,3']) } });
  const r2 = await fm9.writer.applyPreset!(sim2.ctx, { slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }, { slot: { row: 3, col: 3 }, block_type: 'cab' }] });
  check('a dropped cable makes the apply NOT ok, naming the cell', r2.ok === false && r2.chain_integrity?.breaks.some((b) => /cables in from rows none, expected 3/.test(b.reason)) === true, JSON.stringify(r2.chain_integrity));
  const sim3 = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, faults: { ignoreBypassOf: EID.drive } });
  const r3 = await fm9.writer.applyPreset!(sim3.ctx, { slots: [{ slot: { row: 3, col: 2 }, block_type: 'drive', bypassed: true }, { slot: { row: 3, col: 3 }, block_type: 'amp' }] });
  check('a scene bypass that does not land makes the apply NOT ok', r3.ok === false && /drive should be A\/bypassed/.test(r3.failed_step?.error ?? ''), r3.failed_step?.error);
}

console.log('8. executor: template load fails -> paced per-cell clear');
{
  const sim = createGen3Sim({
    modelByte: FM9, rows: 6, cols: 14, faults: { templateLoad: 'drop' },
    initial: [{ row: 2, col: 1, id: EID.input }, { row: 2, col: 2, id: EID.comp, mask: 2 }, { row: 2, col: 5, id: EID.output, mask: 2 }],
  });
  const r = await fm9.writer.applyPreset!(sim.ctx, { slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }] });
  check('build ok after the fallback clear', r.ok, r.warning);
  check('warning names the fallback and ToneCommand #250', /cleared one by one/.test(r.warning ?? '') && /#250/.test(r.warning ?? ''), r.warning);
  const clears = sim.sent.map((s, i) => ({ s, i })).filter(({ s }) => s.bytes[6] === 0x32 && s.bytes[8] === 0 && s.bytes[9] === 0);
  check('3 cells cleared', clears.length === 3, String(clears.length));
  check('>= 40 ms between each select and its insert-0', clears.every(({ i }) => sim.sent[i].t - sim.sent[i - 1].t >= 39), clears.map(({ i }) => sim.sent[i].t - sim.sent[i - 1].t).join(','));
  check('old Input/comp/output gone', !sim.grid.has('2,1') && !sim.grid.has('2,2') && !sim.grid.has('2,5'));
}

console.log('9. executor: save gating');
{
  const sim = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, presetNumber: 3, name: 'Current', stored: { 40: 'Someone Else' } });
  const r = await fm9.writer.applyPreset!(sim.ctx, { slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }] }, 40, { save: true });
  check('save over an occupied, non-loaded location is refused', r.ok === false && r.steps === 0 && r.validation_errors?.[0]?.path === 'target_location', JSON.stringify(r.validation_errors));
  check('zero writes (only name queries went out)', sim.sent.every((s) => s.bytes[5] === 0x0d), sim.sent.map((s) => s.bytes[5]).join());

  const sim2 = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, presetNumber: 3, name: 'Current', stored: { 41: '<EMPTY>' } });
  const r2 = await fm9.writer.applyPreset!(sim2.ctx, { name: 'New One', slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }] }, 41, { save: true });
  check('build + save to an empty location: ok, saved', r2.ok && r2.saved === true, `${r2.warning} | ${r2.failed_step?.error}`);
  check('stored name at 41 is the build\'s', sim2.stored.get(41) === 'New One', sim2.stored.get(41));

  const sim3 = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, presetNumber: 41, name: 'Mine', faults: { dropInsert: new Set([EID.amp]) } });
  const r3 = await fm9.writer.applyPreset!(sim3.ctx, { slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }] }, 41, { save: true });
  check('a build that did not land is NOT saved', r3.ok === false && r3.saved === false && !sim3.sent.some((s) => s.bytes[6] === 0x26), r3.warning);
}

console.log('10. set_block: grid guard, shunts, read-back');
{
  const sim = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, initial: [{ row: 3, col: 4, id: EID.amp }, { row: 3, col: 5, id: 1024 }] });
  let msg = '';
  try { await fm9.writer.setBlock!(sim.ctx, { row: 3, col: 2 }, { block_type: 'amp' }); } catch (e) { msg = String(e); }
  check('placing a block that sits elsewhere is refused, naming its cell', /already placed at r3c4/.test(msg), msg);
  const own = await fm9.writer.setBlock!(sim.ctx, { row: 3, col: 4 }, { block_type: 'amp' });
  check('its own cell is a no-op', own.acked && /no insert was sent/.test(own.info ?? ''));
  const sh = await fm9.writer.setBlock!(sim.ctx, { row: 3, col: 6 }, { block_type: 'shunt' });
  check('a shunt takes the lowest free index (1025) and is confirmed by read-back', sh.acked && sim.grid.get('3,6')?.id === 1025, JSON.stringify(sh));
  const cab = await fm9.writer.setBlock!(sim.ctx, { row: 3, col: 7 }, { block_type: 'cab' });
  check('a placed block is acked from the grid read-back', cab.acked && /confirmed by a grid read-back/.test(cab.info ?? ''));
  const lim = fm3.writer.setBlock!(createGen3Sim({ modelByte: FM3, rows: 4, cols: 12 }).ctx, { row: 2, col: 2 }, { block_type: 'amp', instance: 2 });
  let lmsg = '';
  try { await lim; } catch (e) { lmsg = String(e); }
  check('FM3 Amp 2 refused by set_block too', /allows 1 amp block/.test(lmsg), lmsg);
  const dropped = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, faults: { dropInsert: new Set([EID.delay]) } });
  const d = await fm9.writer.setBlock!(dropped.ctx, { row: 2, col: 2 }, { block_type: 'delay' });
  check('an insert the unit ignored is NOT acked', !d.acked && !d.unconfirmed && /did not land/.test(d.warning ?? ''));
}

console.log('12. review fixes: read-back, channel restore, ambiguous acks, names, scene check, target preflight');
{
  // H1: no grid answer -> dump fallback; a dump that does not show the build
  // (the sim's dump is the template) -> NOT ok, and never saved.
  const sim = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, presetNumber: 3, stored: { 41: '<EMPTY>' }, faults: { silentGrid: true } });
  const r = await fm9.writer.applyPreset!(sim.ctx, { name: 'X', slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }] }, 41, { save: true });
  check('silent grid read: the build is NOT ok', r.ok === false, r.chain_integrity?.summary);
  check('silent grid read: chain_integrity falls back to the edit-buffer dump', /edit-buffer dump/.test(r.chain_integrity?.summary ?? ''), r.chain_integrity?.summary);
  check('silent grid read: nothing stored', r.saved === false && !sim.sent.some((s) => s.bytes[6] === 0x26));

  // H2: channel-nested params end with the scene on its planned channel.
  const sim2 = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14 });
  const r2 = await fm9.writer.applyPreset!(sim2.ctx, {
    slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp', params: { A: { drive: 5 }, B: { drive: 8 } } as never }],
  });
  const paramFrames = sim2.sent.filter((s) => s.bytes[5] === 0x01 && (s.bytes[6] === 0x09 || s.bytes[6] === 0x52));
  check('nested params: one param write per channel', paramFrames.length === 2, String(paramFrames.length));
  check('nested params: the amp is back on channel A on scene 1', sim2.scenes[0].get(EID.amp)?.channel === 0, String(sim2.scenes[0].get(EID.amp)?.channel));
  check('nested params: build ok', r2.ok, r2.warning);

  // M1: a shunt index the unit says is in use (64 01 02) retries with the next.
  const sim3 = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, faults: { shuntInUse: new Set([0]) } });
  const r3 = await fm9.writer.applyPreset!(sim3.ctx, { slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }, { slot: { row: 3, col: 4 }, block_type: 'reverb' }] });
  check('shunt "no-op" answer: retried as index 1, build ok', r3.ok && sim3.grid.get('3,3')?.id === 1025 && /retried as 1/.test(r3.warning ?? ''), `${r3.warning} | ${sim3.grid.get('3,3')?.id}`);

  // M2: a save with no name anywhere never stores "<EMPTY>".
  const sim4 = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, presetNumber: 41, name: '<EMPTY>' });
  const r4 = await fm9.writer.applyPreset!(sim4.ctx, { slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }] }, 41, { save: true });
  check('save with no name: stored as "New Preset", not "<EMPTY>"', r4.saved === true && sim4.stored.get(41) === 'New Preset', `${sim4.stored.get(41)} | ${r4.warning}`);
  const sim4b = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, name: '<EMPTY>' });
  await fm9.writer.applyPreset!(sim4b.ctx, { slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }] });
  check('audition with no name on an "<EMPTY>" buffer: no rename to "<EMPTY>"', !sim4b.sent.some((s) => s.bytes[6] === 0x28));

  // M5: a unit whose fresh insert is bypassed: the scene check catches it and walks.
  const sim5 = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, faults: { freshBypassed: new Set([EID.amp]) } });
  const r5 = await fm9.writer.applyPreset!(sim5.ctx, { slots: [{ slot: { row: 3, col: 2 }, block_type: 'amp' }] });
  check('default build: a fresh insert that is not engaged triggers the scene walk', r5.ok && /every scene is written/.test(r5.warning ?? '') && [0, 4, 7].every((i) => sim5.scenes[i].get(EID.amp)?.bypassed === false), r5.warning);

  // M6: the overwrite refusal runs as a read-only preflight (dispatcher calls it before its dirty guard).
  const sim6 = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, presetNumber: 3, stored: { 40: 'Theirs' } });
  const pre = await fm9.writer.preflightApplyTarget!(sim6.ctx, 40, { save: true });
  check('preflightApplyTarget refuses saving over an occupied location', pre?.[0]?.path === 'target_location');
  check('preflightApplyTarget sends only name queries', sim6.sent.every((s) => s.bytes[5] === 0x0d));
  check('preflightApplyTarget lets an audition through', (await fm9.writer.preflightApplyTarget!(sim6.ctx, 40, { save: false })) === undefined);

  // verify_chain with no read at all is NOT ok.
  const sim7 = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, faults: { silentGrid: true } });
  const v7 = await fm9.writer.verifyChain!(sim7.ctx, { slots: [] });
  check('verify_chain with neither read answering: NOT VERIFIED, ok false', !v7.ok && /NOT VERIFIED/.test(v7.summary), v7.summary);
}

console.log('11. verify_chain walk');
{
  const okChain = chainFromLiveGrid([
    { row: 3, col: 1, effectId: 37, isShunt: false, inputMask: 0 },
    { row: 3, col: 2, effectId: 58, isShunt: false, inputMask: 4 },
    { row: 3, col: 3, isShunt: true, shuntIndex: 0, inputMask: 4 },
    { row: 3, col: 4, effectId: 42, isShunt: false, inputMask: 4 },
  ]);
  check('intact chain: ok, counts blocks and shunts separately', okChain.ok && /3 blocks \(\+1 shunts\)/.test(okChain.summary), okChain.summary);
  const broken = chainFromLiveGrid([
    { row: 3, col: 1, effectId: 37, isShunt: false, inputMask: 0 },
    { row: 3, col: 2, effectId: 58, isShunt: false, inputMask: 0 },
    { row: 3, col: 3, effectId: 42, isShunt: false, inputMask: 4 },
  ]);
  check('an uncabled amp is a break -> ok false', !broken.ok && broken.breaks.some((b) => /gets no signal/.test(b.reason)), broken.summary);
  const sim = createGen3Sim({ modelByte: FM9, rows: 6, cols: 14, initial: [{ row: 3, col: 1, id: 37 }, { row: 3, col: 2, id: 58, mask: 4 }] });
  const v = await fm9.writer.verifyChain!(sim.ctx, { slots: [] });
  check('writer.verifyChain reads the live grid (no Output -> not ok)', !v.ok && v.breaks.some((b) => /no Output/.test(b.reason)), v.summary);
}

console.log(`\n${ok} ok, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
