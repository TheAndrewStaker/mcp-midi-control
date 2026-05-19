/**
 * Factory-data extraction (tier 2: names + block layout).
 *
 * One-time founder action: walks all 104 preset locations on the
 * AM4, reads each preset's name and 4-slot block layout, writes the
 * result to `data/factory-data.json`. The output is committed (lives
 * outside `samples/` which is fully gitignored) so it ships with the
 * binary. Regenerate only when Fractal ships an AM4 firmware update
 * that changes factory presets — uncommon.
 *
 * Why this exists. The factory bank file's chunk binary is ~95%
 * not-decoded (see `docs/devices/am4/preset-binary-format-research.md` §3.4):
 * only the 96-byte block-layout table at chunk1 0x00E-0x6D is
 * cleartext, and the byte0/byte1 → block_type mapping isn't pinned
 * yet. Names live entirely in the disputed region. So the practical
 * way to get a canonical "what's at factory G3?" reference table
 * today is to ask the device itself.
 *
 * The output JSON serves two purposes:
 *   - Agent reference: at runtime the agent can answer "what blocks
 *     are in factory X?" without touching hardware.
 *   - Ground truth for the §6 hardware probe series: when the
 *     block-layout records get decoded, this JSON's per-slot block
 *     names validate the static decode end-to-end.
 *
 * Tier 1 (names only) ships as a side-effect; tier 3 (per-channel
 * params, scenes, channel assignments) is a separate v0.1.x task
 * (#23) reachable either via slow live-readout or via the BK-036
 * encoder once §6 lands.
 *
 * # Future optimization (HW-073)
 *
 * AM4-Edit's File menu has "Refresh Preset Names" and "Display
 * Preset List" actions. If "Refresh Preset Names" is a bulk wire
 * command (rather than 104 sequential per-slot reads), this script
 * could become non-destructive of the working buffer (no preset
 * switches needed) and significantly faster. HW-073 captures that
 * traffic; if a bulk read is decoded, this script and
 * `am4_scan_locations` should both be upgraded to use it.
 *
 * # CRITICAL: pre-flight
 *
 * The script reads from the device, so the device's state at run
 * time is what gets captured. If any of the 104 slots holds a user
 * customization, this script will write that customization's name +
 * layout into the JSON, NOT the factory one.
 *
 * Recommended pre-flight is to first call `am4_restore_factory_range`
 * over A01..Z04 to put every slot back to factory. That is
 * destructive to all user customizations — back up anything you
 * want to keep via AM4-Edit before running.
 *
 * Alternative: confirm the AM4 has been at factory state since
 * unboxing with no customizations. If you've ever saved a preset
 * via the front panel or AM4-Edit, this path is unsafe.
 *
 * The script does NOT call restore_factory_range itself — that
 * would be too easy to invoke accidentally. Pre-flight is the
 * founder's call.
 *
 * # Working-buffer side effects
 *
 * Reading the per-preset block layout requires switching to that
 * preset (the layout PIDs read from the working buffer, not from
 * arbitrary stored slots). The script switches through all 104
 * locations in order, so the AM4 will land on Z04 when done. Switch
 * back to wherever you were via the front panel or
 * `am4_switch_preset`.
 *
 * Any unsaved working-buffer edits will be discarded by the first
 * switch. Save them first via the front panel STORE workflow or
 * AM4-Edit.
 *
 * # Run
 *
 *   npm run extract-factory-data
 *
 * Or directly: `npx tsx scripts/extract-factory-data.ts`.
 *
 * Wall time ~30-45 s. Output written to `data/factory-data.json`
 * (committed, ships with binary; samples/ stays fully gitignored).
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  TOTAL_LOCATIONS,
  formatLocationCode,
} from 'fractal-midi/am4';
import {
  BLOCK_SLOT_PID_HIGH_BASE,
  BLOCK_SLOT_PID_LOW,
  buildGetPresetName,
  buildReadParam,
  buildSwitchPreset,
  isReadResponse,
  parseGetPresetNameResponse,
  parseReadResponse,
} from 'fractal-midi/am4';
import { BLOCK_NAMES_BY_VALUE } from 'fractal-midi/am4';
import { connectAM4, type MidiConnection } from '@mcp-midi-control/am4/midi.js';

const OUTPUT_PATH = path.resolve(
  process.cwd(),
  'data',
  'factory-data.json',
);

/**
 * Wall pacing between distinct preset visits. The AM4's switch + 4
 * layout reads is ~200 ms; we leave ~50 ms of breathing room before
 * the next visit so the device has settled. Empirically the AM4 is
 * happy at much tighter pacing for read-only flows but tier 2 is
 * a one-off operation - extra padding doesn't hurt.
 */
const INTER_PRESET_DELAY_MS = 50;

/** Read timeout for any single name / layout response. Matches
 *  production tools. */
const READ_TIMEOUT_MS = 300;

interface SlotEntry {
  readonly position: 1 | 2 | 3 | 4;
  readonly block_type: string;
}

interface PresetEntry {
  readonly location: string;
  readonly name: string;
  readonly is_empty: boolean;
  readonly slots: readonly SlotEntry[];
}

interface OutputDocument {
  readonly schema_version: 1;
  readonly source: 'AM4 device, live readout';
  readonly extracted_at: string;
  readonly tier: 2;
  readonly note: string;
  readonly presets: readonly PresetEntry[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readPresetName(
  conn: MidiConnection,
  locationIndex: number,
): Promise<{ name: string; isEmpty: boolean }> {
  const bytes = buildGetPresetName(locationIndex);
  const predicate = (resp: number[]): boolean => {
    if (resp.length < 16) return false;
    for (let i = 0; i < 6; i++) if (resp[i] !== bytes[i]) return false;
    return true;
  };
  const respPromise = conn.receiveSysExMatching(predicate, READ_TIMEOUT_MS);
  conn.send(bytes);
  const resp = await respPromise;
  const parsed = parseGetPresetNameResponse(resp, locationIndex);
  return { name: parsed.isEmpty ? '' : parsed.name, isEmpty: parsed.isEmpty };
}

async function readBlockLayout(
  conn: MidiConnection,
): Promise<readonly SlotEntry[]> {
  const slots: SlotEntry[] = [];
  for (const position of [1, 2, 3, 4] as const) {
    const pidHigh = BLOCK_SLOT_PID_HIGH_BASE + (position - 1);
    const bytes = buildReadParam({ pidLow: BLOCK_SLOT_PID_LOW, pidHigh });
    const respPromise = conn.receiveSysExMatching(
      (resp) => isReadResponse(bytes, resp),
      READ_TIMEOUT_MS,
    );
    conn.send(bytes);
    const resp = await respPromise;
    const parsed = parseReadResponse(resp);
    const u32 = parsed.asUInt32LE();
    const block_type = BLOCK_NAMES_BY_VALUE[u32] ?? `unknown(0x${u32.toString(16)})`;
    slots.push({ position, block_type });
  }
  return slots;
}

async function switchPreset(
  conn: MidiConnection,
  locationIndex: number,
): Promise<void> {
  const bytes = buildSwitchPreset(locationIndex);
  conn.send(bytes);
  // The switch is fire-and-forget at the wire layer; the device
  // settles within ~30-50 ms. Brief wait avoids racing the layout
  // reads against the switch.
  await sleep(40);
}

async function main(): Promise<number> {
  console.log('AM4 factory-data extraction (tier 2: names + block layout)');
  console.log('============================================================');
  console.log('');
  console.log('IMPORTANT: this script reads from your AM4 in its CURRENT state.');
  console.log('If any preset slot holds a user customization, the JSON will');
  console.log('capture THAT, not the factory data. Run am4_restore_factory_range');
  console.log('A01..Z04 first if your device has been customized at all.');
  console.log('');
  console.log('Side effects:');
  console.log('  - Working-buffer edits will be discarded.');
  console.log(`  - The AM4 will land on Z04 when done (switch ${TOTAL_LOCATIONS} times).`);
  console.log('');
  console.log('Starting in 3 seconds. Ctrl+C to abort.');
  await sleep(3000);

  const conn = connectAM4();
  const startMs = Date.now();
  const presets: PresetEntry[] = [];
  let failureLocation: string | undefined;
  let failureReason: string | undefined;
  try {
    for (let i = 0; i < TOTAL_LOCATIONS; i++) {
      const location = formatLocationCode(i);
      try {
        await switchPreset(conn, i);
        const { name, isEmpty } = await readPresetName(conn, i);
        const slots = await readBlockLayout(conn);
        presets.push({ location, name, is_empty: isEmpty, slots });
        const slotSummary = slots.map((s) => s.block_type).join(', ');
        console.log(
          `  ${i + 1}/${TOTAL_LOCATIONS} ${location}: "${name || '<EMPTY>'}" [${slotSummary}]`,
        );
      } catch (err) {
        failureLocation = location;
        failureReason = err instanceof Error ? err.message : String(err);
        console.error(`  ${location}: FAILED — ${failureReason}`);
        break;
      }
      if (i < TOTAL_LOCATIONS - 1) await sleep(INTER_PRESET_DELAY_MS);
    }
  } finally {
    conn.close();
  }
  const wallTimeMs = Date.now() - startMs;

  if (failureLocation) {
    console.error('');
    console.error(`Aborted at ${failureLocation}: ${failureReason}`);
    console.error(`Captured ${presets.length}/${TOTAL_LOCATIONS} presets before failure.`);
    console.error(`Partial output NOT written. Fix the failure and re-run.`);
    return 2;
  }

  // Sanity check uniqueness of names. Factory presets all have
  // distinct names; duplicates are a strong signal that the device
  // wasn't at factory state when the script ran.
  const nameCounts = new Map<string, number>();
  for (const p of presets) {
    if (p.is_empty) continue;
    nameCounts.set(p.name, (nameCounts.get(p.name) ?? 0) + 1);
  }
  const duplicates = [...nameCounts.entries()].filter(([, n]) => n > 1);
  if (duplicates.length > 0) {
    console.warn('');
    console.warn(`WARNING: ${duplicates.length} duplicate preset name(s) detected:`);
    for (const [name, count] of duplicates) {
      const locs = presets
        .filter((p) => p.name === name)
        .map((p) => p.location)
        .join(', ');
      console.warn(`  "${name}" × ${count} at ${locs}`);
    }
    console.warn('Factory presets have distinct names; duplicates suggest the');
    console.warn('device was not at factory state. Run am4_restore_factory_range');
    console.warn('A01..Z04 first, then re-run this script.');
    console.warn('Writing JSON anyway, but treat with skepticism.');
  }

  const output: OutputDocument = {
    schema_version: 1,
    source: 'AM4 device, live readout',
    extracted_at: new Date().toISOString(),
    tier: 2,
    note:
      'Tier 2 = preset names + 4-slot block layouts. Per-channel params, ' +
      'scenes, and channel assignments are not in this tier; see ' +
      'docs/devices/am4/preset-binary-format-research.md §6 for the path forward.',
    presets,
  };
  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log('');
  console.log(`Wrote ${presets.length} presets to ${OUTPUT_PATH}`);
  console.log(`Wall time: ${(wallTimeMs / 1000).toFixed(1)}s`);
  console.log('');
  console.log('Next: spot-check 2-3 entries against your physical device,');
  console.log('then commit the JSON. Mark HW-072 done.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('FAIL: ' + (err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
