/**
 * Surface map: archetype x device x verb, built from GROUND TRUTH.
 *
 * Every unified tool dispatches on the presence of a `DeviceReader` /
 * `DeviceWriter` method on the resolved descriptor. So the honest answer to
 * "which devices really have verb X" is not in any doc, it is in the
 * descriptors themselves. This script imports the registered set exactly as
 * `server-all` does and enumerates it.
 *
 * It classifies every (device, verb) cell as:
 *
 *   real     the device satisfies the dispatcher's guard for that verb
 *   absent   it does not
 *
 * and then classifies every VERB by how many devices actually answer it:
 *
 *   archetypal   real on 2+ devices        (the unified surface earning its name)
 *   solo         real on exactly 1 device  (a device tool wearing a bare name)
 *   dead         real on 0 devices
 *
 * The `solo` bucket is the point. A tool registered on the unified surface but
 * implemented for exactly one device costs the same per-turn context tax as a
 * genuinely shared verb while delivering none of the scaling, and it is
 * invisible from any single package. `docs/design/device-archetypes-and-
 * transport.md` is the law it is measured against.
 *
 * Package-registered tools (those declared from `packages/<device>/src/tools/`
 * rather than from core) are listed separately: they cannot be class-gated at
 * all, because they are not on the shared surface in the first place.
 *
 * ## What this map does NOT answer: write gating
 *
 * A first version of this script carried a third `gated` tier, reading
 * `capabilities.writes_gated` / `capabilities.write_allowlist`. **Those fields
 * do not exist.** `DeviceCapabilities` has no gating member at all, and the
 * gen-3 family's gating is passed into `makeWriter`'s private closure as
 * `writesGated` / `writeAllowlist` (`fractal-gen3/src/factory.ts:416-417`, from
 * e.g. `configs/vp4.ts:95,100`), where nothing outside the writer can read it.
 * The tier could therefore never fire: every gated VP4 verb printed as `real`
 * and the whole output contained zero gated cells, which is exactly the shape of
 * a check that looks like a feature and measures nothing.
 *
 * The tier is removed rather than faked. **Read this map as "is the verb WIRED
 * on this device", not "will it write."** VP4 in particular answers `real` for
 * `set_block` / `switch_scene` here and still refuses them at the writer.
 *
 * That is itself a finding: making `write_allowlist` declarative on the
 * descriptor would let this map tell the truth about gating, and would let a
 * preflight gate assert it. Until then the honest scope is wiring.
 *
 * Run: npx tsx scripts/surface-matrix.ts [--json]
 */

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR, AX8_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { AXEFXGEN1_DESCRIPTOR } from '@mcp-midi-control/fractal-gen1/descriptor.js';
import { MODERN_FRACTAL_DESCRIPTORS } from '@mcp-midi-control/fractal-gen3/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import { SPD_SX_DESCRIPTOR } from '@mcp-midi-control/spd-sx/descriptor.js';
import { VE500_DESCRIPTOR } from '@mcp-midi-control/ve-500/descriptor.js';
import { MICROFREAK_DESCRIPTOR, MINIFREAK_DESCRIPTOR } from '@mcp-midi-control/arturia/descriptor.js';
import { RC_505_MK2_DESCRIPTOR, RC_600_DESCRIPTOR } from '@mcp-midi-control/boss-rc/descriptor.js';
import { MPC_ONE_G2_DESCRIPTOR } from '@mcp-midi-control/akai-mpc/descriptor.js';
import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';

const DESCRIPTORS: readonly DeviceDescriptor[] = [
  ...MODERN_FRACTAL_DESCRIPTORS,
  AXEFXGEN1_DESCRIPTOR,
  AX8_DESCRIPTOR,
  AXEFX2_DESCRIPTOR,
  AM4_DESCRIPTOR,
  HYDRASYNTH_DESCRIPTOR,
  CIRCUIT_TRACKS_DESCRIPTOR,
  SPD_SX_DESCRIPTOR,
  VE500_DESCRIPTOR,
  MICROFREAK_DESCRIPTOR,
  MINIFREAK_DESCRIPTOR,
  RC_505_MK2_DESCRIPTOR,
  RC_600_DESCRIPTOR,
  MPC_ONE_G2_DESCRIPTOR,
];

type Side = 'reader' | 'writer';

interface Verb {
  /** The registered MCP tool name. */
  tool: string;
  /** Which archetype the design doc assigns this verb to. */
  archetype: string;
  /**
   * Contract method(s) the dispatcher guards on. ANY present = answerable.
   * These mirror the guard EXACTLY; see `guard` for the file:line it came from.
   *
   * NOTE: no `build*` form appears here. Every dispatcher guard checks the
   * async method (`setParam`, `switchPreset`, `savePreset`, `switchScene`,
   * `setBlock`, `setBypass`), never the builder. An earlier version accepted
   * builders as alternates, which was wrong for all four it was applied to and
   * VACUOUS for `buildSetParam`, which is non-optional on `DeviceWriter`
   * (`types.ts:2452`) so every device passed it unconditionally.
   */
  needs: readonly { side: Side; method: string }[];
  /**
   * Extra capability precondition the dispatcher checks BEFORE the method
   * lookup. Only two verbs have one, and both are load-bearing.
   */
  requires?: (d: DeviceDescriptor) => boolean;
  /**
   * True when `needs` names a method that is NON-OPTIONAL on the interface, so
   * every device passes by construction. Reported as contract-guaranteed rather
   * than measured, because "real on 16/16" is not a measurement there.
   */
  mandatory?: boolean;
  /** Where the guard lives, so a reader can re-check this table against it. */
  guard: string;
}

/**
 * Verb -> dispatcher-guard map. Every entry was read out of the dispatcher's
 * own `capability_not_supported` throw; that guard IS the definition of "this
 * device answers this verb". Re-verified against the dispatchers 2026-08-15
 * after review found three mapping defects in the first version.
 */
const VERBS: readonly Verb[] = [
  // -- base surface: every archetype --
  { tool: 'get_param', archetype: 'base', mandatory: true, guard: 'types.ts:2440 (non-optional)', needs: [{ side: 'reader', method: 'getParam' }] },
  { tool: 'get_params', archetype: 'base', mandatory: true, guard: 'types.ts (non-optional)', needs: [{ side: 'reader', method: 'getParams' }] },
  { tool: 'set_param', archetype: 'base', guard: 'params.ts:185', needs: [{ side: 'writer', method: 'setParam' }] },
  { tool: 'set_params', archetype: 'base', guard: 'params.ts:305', needs: [{ side: 'writer', method: 'setParams' }] },
  { tool: 'switch_preset', archetype: 'base', guard: 'navigation.ts:33', needs: [{ side: 'writer', method: 'switchPreset' }] },
  { tool: 'save_preset', archetype: 'base', guard: 'navigation.ts:103', needs: [{ side: 'writer', method: 'savePreset' }] },
  { tool: 'scan_locations', archetype: 'base', guard: 'navigation.ts:347', needs: [{ side: 'reader', method: 'scanLocations' }] },
  { tool: 'get_preset', archetype: 'base', guard: 'preset.ts:371', needs: [{ side: 'reader', method: 'getPreset' }] },

  // -- byte-exact container: class-INDEPENDENT --
  // Two dump paths, two guards (preset.ts:406 active / :438 stored); a device
  // answering EITHER can be exported, so ANY-present is the right rule here.
  { tool: 'export_preset', archetype: 'container', guard: 'preset.ts:406,438', needs: [{ side: 'reader', method: 'dumpStoredPresetBinary' }, { side: 'reader', method: 'dumpActivePresetBinary' }] },
  { tool: 'backup_device', archetype: 'container', guard: 'backupSweep.ts (via resolveBackupPolicy)', needs: [{ side: 'reader', method: 'dumpStoredPresetBinary' }, { side: 'reader', method: 'dumpActivePresetBinary' }] },
  { tool: 'import_preset', archetype: 'container', guard: 'preset.ts:551', needs: [{ side: 'writer', method: 'restorePresetBinary' }] },

  // -- layout class --
  { tool: 'apply_preset', archetype: 'layout', guard: 'preset.ts:684', needs: [{ side: 'writer', method: 'applyPreset' }] },
  { tool: 'set_block', archetype: 'layout', guard: 'layout.ts:31', needs: [{ side: 'writer', method: 'setBlock' }] },
  { tool: 'set_bypass', archetype: 'layout', guard: 'layout.ts:68', needs: [{ side: 'writer', method: 'setBypass' }] },
  // TWO guards: has_scenes is checked FIRST (navigation.ts:244), then the
  // method (navigation.ts:251). A device with switchScene but has_scenes:false
  // still refuses, so the capability precondition is not decorative.
  {
    tool: 'switch_scene', archetype: 'layout', guard: 'navigation.ts:244 + :251',
    requires: (d) => d.capabilities.has_scenes === true,
    needs: [{ side: 'writer', method: 'switchScene' }],
  },
  { tool: 'lookup_lineage', archetype: 'layout', guard: 'reader.lookupLineage', needs: [{ side: 'reader', method: 'lookupLineage' }] },

  // -- sequencer class --
  // NOT `writer.realizePattern`. The gate is `selectRealizer`
  // (`patterns/realizers/index.ts:22-26`) against `capabilities.
  // pattern_realizers`; `writer.realizePattern` is only the bespoke/ncs_upload
  // branch, and the shared live_stream / record_capture realizers work for any
  // device that DECLARES the mode. Reading the writer method instead made this
  // verb look Circuit-only when the SPD-SX declares `pattern_realizers:
  // ['live_stream']` and the refusal text names it as a target.
  {
    tool: 'apply_pattern', archetype: 'sequencer', guard: 'patterns/realizers/index.ts:22',
    requires: (d) => (d.capabilities.pattern_realizers?.length ?? 0) > 0,
    needs: [],
  },

  // -- sampler / storage class --
  { tool: 'list_samples', archetype: 'sampler', guard: 'preset.ts:497', needs: [{ side: 'reader', method: 'readSampleDirectory' }] },
  { tool: 'upload_sample', archetype: 'sampler', guard: 'writer.uploadSample', needs: [{ side: 'writer', method: 'uploadSample' }] },
  { tool: 'author_kit', archetype: 'sampler', guard: 'writer.authorKit', needs: [{ side: 'writer', method: 'authorKit' }] },

  // -- project class (pack-addressed) --
  { tool: 'list_packs', archetype: 'project', guard: 'preset.ts:468', needs: [{ side: 'reader', method: 'readPackDirectory' }] },
  { tool: 'delete_project', archetype: 'project', guard: 'writer.deleteProjects', needs: [{ side: 'writer', method: 'deleteProjects' }] },
];

/**
 * Tools registered from a DEVICE package rather than from core. These are not
 * on the shared surface at all, so no descriptor can opt into them and no
 * class gate can reach them. Listed so the map is honest about the whole
 * registered roster, not just the class-gateable part.
 */
const PACKAGE_REGISTERED: readonly { tool: string; owner: string; note: string }[] = [
  { tool: 'apply_patch', owner: 'hydrasynth', note: "voice-class apply tool per the trichotomy; implementation is Hydrasynth-specific (INIT_PATCH_BUFFER, bankPcDance, 22-chunk dump)" },
  { tool: 'init_patch', owner: 'hydrasynth', note: 'RAM-only reset to factory INIT; deliberately skips the Write Request' },
  { tool: 'set_macro', owner: 'hydrasynth', note: 'macro depth/start authoring' },
  { tool: 'set_system_param', owner: 'hydrasynth', note: 'device globals' },
  { tool: 'hydra_navigate_to', owner: 'hydrasynth', note: 'NOT registered (diagnostic kept commented out)' },
];

function has(desc: DeviceDescriptor, side: Side, method: string): boolean {
  const bag = side === 'reader' ? desc.reader : desc.writer;
  return (bag as unknown as Record<string, unknown>)[method] !== undefined;
}

type Cell = 'real' | 'absent';

/**
 * Reproduce the dispatcher's guard: the capability precondition (if any) AND
 * the method lookup. Both must pass, in that order, exactly as the dispatcher
 * evaluates them.
 */
function classify(desc: DeviceDescriptor, verb: Verb): Cell {
  if (verb.requires !== undefined && !verb.requires(desc)) return 'absent';
  // A verb whose whole guard IS the capability check (apply_pattern) declares
  // no methods; passing `requires` is sufficient.
  if (verb.needs.length === 0) return 'real';
  return verb.needs.some((n) => has(desc, n.side, n.method)) ? 'real' : 'absent';
}

const GLYPH: Record<Cell, string> = { real: '#', absent: '.' };

function main(): void {
  const asJson = process.argv.includes('--json');

  const rows = DESCRIPTORS.map((d) => ({
    id: d.id,
    name: d.display_name,
    preset_class: d.preset_class ?? 'layout',
    transport: d.transport?.kind ?? 'midi',
    tier: (d.capabilities as unknown as { support_tier?: string }).support_tier ?? '(undeclared)',
    cells: Object.fromEntries(VERBS.map((v) => [v.tool, classify(d, v)])) as Record<string, Cell>,
  }));

  const verbStats = VERBS.map((v) => {
    const real = rows.filter((r) => r.cells[v.tool] === 'real');
    return {
      tool: v.tool,
      archetype: v.archetype,
      mandatory: v.mandatory === true,
      real: real.map((r) => r.id),
      // A contract-mandatory method is real everywhere by construction, so
      // calling it "archetypal" would be counting the interface, not the
      // devices. Reported separately.
      verdict: v.mandatory === true
        ? 'mandatory'
        : real.length === 0 ? 'dead' : real.length === 1 ? 'solo' : 'archetypal',
    };
  });

  if (asJson) {
    console.log(JSON.stringify({ rows, verbStats, packageRegistered: PACKAGE_REGISTERED }, null, 2));
    return;
  }

  // ── device table ──
  console.log('\nREGISTERED DEVICES\n');
  console.log(`  ${'id'.padEnd(14)} ${'class'.padEnd(7)} ${'transport'.padEnd(9)} tier`);
  console.log(`  ${'-'.repeat(14)} ${'-'.repeat(7)} ${'-'.repeat(9)} ${'-'.repeat(20)}`);
  for (const r of rows) {
    console.log(`  ${r.id.padEnd(14)} ${r.preset_class.padEnd(7)} ${r.transport.padEnd(9)} ${r.tier}`);
  }

  // ── matrix ──
  console.log(`\n\nVERB x DEVICE   ${GLYPH.real} wired   ${GLYPH.absent} absent`);
  console.log('  (WIRED, not "will write": write-gating is not descriptor-readable — see the header.)\n');
  const idW = 22;
  const colW = 4;
  // Header: device ids written vertically so the grid stays narrow.
  const maxId = Math.max(...rows.map((r) => r.id.length));
  for (let line = 0; line < maxId; line++) {
    let out = ' '.repeat(idW);
    for (const r of rows) out += (r.id[line] ?? ' ').padEnd(colW);
    console.log(out);
  }
  console.log(`  ${'-'.repeat(idW - 2)}${'-'.repeat(rows.length * colW)}`);

  let lastArch = '';
  for (const v of VERBS) {
    if (v.archetype !== lastArch) {
      console.log(`  [${v.archetype}]`);
      lastArch = v.archetype;
    }
    const stat = verbStats.find((s) => s.tool === v.tool)!;
    const flag = stat.verdict === 'solo' ? ' <- SOLO'
      : stat.verdict === 'dead' ? ' <- DEAD'
        : stat.verdict === 'mandatory' ? ' (contract-mandatory)' : '';
    let out = `  ${v.tool.padEnd(idW - 2)}`;
    for (const r of rows) out += GLYPH[r.cells[v.tool]!].padEnd(colW);
    console.log(out + flag);
  }

  // ── verdicts ──
  const solo = verbStats.filter((s) => s.verdict === 'solo');
  const dead = verbStats.filter((s) => s.verdict === 'dead');
  const archetypal = verbStats.filter((s) => s.verdict === 'archetypal');

  const mandatory = verbStats.filter((s) => s.verdict === 'mandatory');
  console.log(`\n\nVERB VERDICTS   ${archetypal.length} archetypal, ${solo.length} solo, ${dead.length} dead, ${mandatory.length} contract-mandatory\n`);
  for (const s of solo) {
    console.log(`  SOLO  ${s.tool.padEnd(18)} wired only on: ${s.real.join(', ')}`);
  }
  for (const s of dead) {
    console.log(`  DEAD  ${s.tool.padEnd(18)} no device answers it`);
  }
  for (const s of mandatory) {
    console.log(`  MAND  ${s.tool.padEnd(18)} non-optional on the interface; every device passes by construction`);
  }

  console.log('\n\nPACKAGE-REGISTERED TOOLS (not on the shared surface, cannot be class-gated)\n');
  for (const p of PACKAGE_REGISTERED) {
    console.log(`  ${p.tool.padEnd(18)} owner=${p.owner}`);
    console.log(`  ${' '.repeat(18)} ${p.note}`);
  }

  // ── the voice-class question, answered directly ──
  const voice = rows.filter((r) => r.preset_class === 'voice');
  console.log(`\n\nVOICE CLASS: ${voice.length} devices declare preset_class:'voice'\n`);
  for (const r of voice) {
    console.log(`  ${r.id.padEnd(14)} import_preset=${r.cells['import_preset']}  apply_preset=${r.cells['apply_preset']}  get_preset=${r.cells['get_preset']}`);
  }
  console.log(`\n  apply_patch (the class's own apply verb) is registered from packages/hydrasynth/,`);
  console.log(`  so it is reachable for 1 of these ${voice.length} devices regardless of what they declare.`);
  console.log('');
}

main();
