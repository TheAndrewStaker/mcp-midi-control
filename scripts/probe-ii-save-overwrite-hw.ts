/**
 * probe-ii-save-overwrite-hw.ts: confirm the Axe-Fx II save_preset OVERWRITE
 * GATE on real hardware (plan item 2.5, shipped 2026-08-03).
 *
 * WHAT SHIPPED, AND WHY IT NEEDS A DEVICE. The II used to store, return
 * `acked: true`, and put the caution on the RECEIPT: "the target location was
 * not scanned". A warning printed AFTER a flash write is not a gate, and it
 * contradicted two absolute rules in CLAUDE.md on a `verified`-tier device
 * while the AM4 refused the identical call. Now a save to a NON-ACTIVE
 * location refuses until `confirm_overwrite: true`, because this device can
 * read which preset is ACTIVE but has no decoded read for what is stored at an
 * arbitrary location.
 *
 * The refusal is gated offline in `verify-axefx2-dirty-gate.ts` against the
 * MOCK, whose active preset is a fixed wire 0. What the mock cannot tell us:
 * whether the REAL device answers GET_PRESET_NUMBER (fn 0x14) promptly enough
 * for the pre-check, and whether the active-location branch correctly
 * recognises the preset you are actually sitting on. Both are hardware
 * questions and both are checked here.
 *
 * ── THIS PROBE IS NON-DESTRUCTIVE BY DEFAULT ────────────────────────────
 *
 * The default run NEVER persists anything. Its whole point is the REFUSAL
 * path, which by contract sends zero bytes, so there is nothing to restore and
 * nothing to lose. It does not write, does not save, and does not navigate.
 *
 * `--confirm-leg` additionally exercises the confirmed save, which DOES write
 * flash. It refuses to run without `--location=N` so you have to name the slot
 * you are willing to overwrite; there is no default and no "scratch" slot
 * assumed (CLAUDE.md: "Saving to an inactive location is a real workflow;
 * there is no ubiquitous scratch location, so don't assume one").
 *
 *   npx tsx scripts/probe-ii-save-overwrite-hw.ts
 *       Read-only + refusal legs. Writes NOTHING. Start here.
 *
 *   npx tsx scripts/probe-ii-save-overwrite-hw.ts --confirm-leg --location=42
 *       Also saves the CURRENT working buffer to preset 42, overwriting it.
 *       Interactive: asks before the write and asks you to read the panel after.
 *
 * PRE-FLIGHT: Axe-Fx II on, USB connected, AxeEdit CLOSED (its polling
 * pollutes the stream and can answer or consume the fn 0x14 exchange).
 */
import path from 'node:path';
import readline from 'node:readline';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');
const PORT = 'axe-fx-ii';
const CONFIRM_LEG = process.argv.includes('--confirm-leg');
const LOCATION_ARG = process.argv.find((a) => a.startsWith('--location='))?.split('=')[1];

/**
 * Skip every question that needs a human at the front panel, and report those
 * legs as NOT RUN rather than as passes.
 *
 * WHY THIS EXISTS AND WHAT IT DELIBERATELY GIVES UP. Most of this probe is
 * machine-adjudicable: whether the refusal fires, whether it says nothing was
 * sent, whether a confirmed save acks. Those need no eyes. Two legs DO need
 * eyes, and they are the two that matter most for trusting the rest: that the
 * server's active-preset read agrees with the FRONT PANEL, and that a refused
 * save left the device untouched. The panel is ground truth (CLAUDE.md
 * "Verification sources of truth"); an agent typing plausible answers into
 * those prompts would be manufacturing hardware evidence, which is the worst
 * failure available in this project.
 *
 * So in this mode they are SKIPPED and counted as unrun, never as OK. Auto-on
 * when stdin is not a TTY, so a piped or CI invocation cannot silently hang
 * waiting for an answer nobody is there to give.
 */
const NON_INTERACTIVE = process.argv.includes('--non-interactive') || !process.stdin.isTTY;
let skipped = 0;
/** Set to the location the confirm leg actually persisted to, so the closing line cannot overclaim. */
let persisted: number | undefined;
function skip(label: string, why: string): void {
  skipped++;
  console.log(`  ..    SKIPPED (needs a human at the panel): ${label}\n          ${why}`);
}

let failures = 0;
let checks = 0;
function check(label: string, cond: boolean, detail?: string): void {
  checks++;
  if (cond) { console.log(`  OK    ${label}`); return; }
  failures++;
  console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe' });
  const client = new Client({ name: 'probe-ii-save-overwrite', version: '1.0.0' });
  await client.connect(transport);

  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    return (res as { content?: { text?: string }[] }).content?.[0]?.text ?? '';
  };

  try {
    console.log('\nAxe-Fx II save_preset overwrite gate, on hardware');
    console.log('='.repeat(64));

    // ── 0. The device has to be there, and it has to be the II ──────────
    const preset = JSON.parse(await call('get_preset', { port: PORT }));
    if (preset.ok === false || preset.code !== undefined) {
      console.log(`\n  Could not read the Axe-Fx II: ${String(preset.message ?? preset.code)}`);
      console.log('  Check: device on, USB connected, AxeEdit closed. Nothing was sent.');
      rl.close();
      await client.close();
      process.exit(2);
    }
    // WHICH SLOT IS ACTIVE, and why it is not read from `get_preset`.
    //
    // The II's `get_preset` does not report it. Measured 2026-08-03: the
    // response carries name / slots / active_scene / chain_integrity / _meta,
    // and _meta carries device, timings and read-path flags. No preset number
    // anywhere, unlike the AM4. An earlier draft of this probe read
    // `_meta.display_slot`, got undefined, and then "passed" a check that
    // compared NaN to NaN. Filed as BK-GEN2-GETPRESET-ACTIVE-SLOT.
    //
    // `export_preset` DOES know it (its `source` string says "device at
    // display slot N"), it is read-only on the device, and it leaves a .syx
    // backup of the working buffer, which is worth having before the confirm
    // leg overwrites anything. So it is the source here.
    const exported = JSON.parse(await call('export_preset', { port: PORT }));
    const activeSlot = Number(/display slot (\d+)/.exec(String(exported.source ?? ''))?.[1] ?? NaN);
    console.log(`\n  Working buffer "${String(exported.name ?? '?')}" backed up to ${String(exported.file_name ?? '(none)')}.`);
    console.log(`  Active preset reads as display slot ${Number.isFinite(activeSlot) ? activeSlot : '(NOT OBTAINABLE)'}.`);
    if (!Number.isFinite(activeSlot)) {
      console.log('\n  Cannot determine the active slot, so cannot choose a target that is safely NON-active.');
      console.log('  Refusing to guess: picking wrong would save to the location you are editing. Nothing was sent.');
      rl.close();
      await client.close();
      process.exit(2);
    }
    const panelSlot = NON_INTERACTIVE
      ? ''
      : (await ask('  What preset number does the FRONT PANEL show? ')).trim();

    // ── 1. The pre-check must agree with the front panel ────────────────
    //
    // This is the leg the mock cannot run. The gate's whole active-vs-
    // non-active decision rests on GET_PRESET_NUMBER (fn 0x14) answering, and
    // answering with the slot you are really on. If this disagrees, every
    // other result below is measuring the wrong thing, so it is checked first
    // and against the panel, which is ground truth (CLAUDE.md "Verification
    // sources of truth").
    const panelN = Number.parseInt(panelSlot, 10);
    if (NON_INTERACTIVE) {
      skip('server active-preset read vs FRONT PANEL',
        `server says slot ${Number.isFinite(activeSlot) ? activeSlot : '(not reported)'}; nobody read the panel. `
        + 'This is the leg the whole active-vs-non-active decision rests on, so the rest of this run is '
        + 'conditional on it. Re-run interactively to close it.');
    } else if (Number.isFinite(panelN) && Number.isFinite(activeSlot)) {
      check(`the server's active-preset read agrees with the panel (${activeSlot} vs ${panelN})`,
        activeSlot === panelN,
        'If these disagree the overwrite gate will mis-classify which target is "the one you are editing".');
    } else {
      console.log('  ..    skipped panel/server agreement (one of the two was not a number)');
    }

    // ── 2. THE REFUSAL. Nothing is sent, so nothing can be lost ─────────
    //
    // Pick a target that is definitely NOT the active one, without caring
    // what is in it: the contract says this call sends zero bytes.
    // Pick a target that is definitely not the active one. Prefer the panel
    // reading when a human gave one; otherwise the export's own slot, which is
    // now guaranteed to be a real number (the run aborts above if it is not).
    const activeRef = Number.isFinite(panelN) ? panelN : activeSlot;
    const nonActive = activeRef === 1 ? 2 : 1;
    const nameBefore = String(preset.name ?? '');
    console.log(`\n  Attempting an UNCONFIRMED save to preset ${nonActive} (not the one you are on).`);
    console.log('  By contract this must refuse and send nothing.');
    const refusal = JSON.parse(await call('save_preset', { port: PORT, location: nonActive }));
    const rtext = JSON.stringify(refusal);
    check('an unconfirmed save to a NON-ACTIVE location is REFUSED', refusal.acked === false, rtext.slice(0, 200));
    check('the refusal says nothing was sent', /Nothing was sent/i.test(rtext), rtext.slice(0, 200));
    check('the refusal admits it could not read the target (does not imply a check happened)',
      /NO decoded way to read what is stored there/i.test(rtext), rtext.slice(0, 200));
    check('the refusal names the argument that proceeds', /confirm_overwrite/i.test(rtext), rtext.slice(0, 200));

    if (NON_INTERACTIVE) {
      skip('front panel unchanged after the refused save',
        'A refusal is supposed to be completely inert. Nobody looked, so "inert" is asserted only from '
        + 'the response shape (acked:false + "Nothing was sent"), not from the device.');
      // What CAN be checked without eyes. NOT the slot number: `get_preset`
      // does not report it on this device, and an earlier draft compared two
      // NaNs here and called it a pass. The working-buffer NAME is reported,
      // is read back the same way, and changes if a refusal navigated, so it
      // is a real observation rather than a shaped one.
      const after = JSON.parse(await call('get_preset', { port: PORT }));
      const nameAfter = String(after.name ?? '');
      check('the refused save did not change the working buffer (name read back identical)',
        nameAfter.length > 0 && nameAfter === nameBefore,
        `name was ${JSON.stringify(nameBefore)}, now ${JSON.stringify(nameAfter)}.`);
    } else {
      const panelAfter = (await ask(`\n  Look at the front panel. What preset number does it show now? `)).trim();
      check('the refused save did NOT move or alter the device',
        panelAfter.trim() === panelSlot.trim(),
        `panel was "${panelSlot}", now "${panelAfter}". A refusal must be inert.`);
    }

    // ── 3. The ACTIVE location is not gated (it is a refresh) ───────────
    //
    // Deliberately NOT executed by default: it is still a flash write, even
    // though it writes the buffer back to where it came from. The check here
    // is that the gate does not REFUSE it, which is visible from the refusal
    // text of a dry attempt... except there is no dry mode. So this is asked,
    // not assumed.
    console.log('\n  (Skipping the save-to-active leg: it would write flash. The offline gate covers it.)');

    // ── 4. Optional: the confirmed save actually lands ──────────────────
    if (CONFIRM_LEG) {
      if (LOCATION_ARG === undefined) {
        console.log('\n  --confirm-leg needs --location=N. Refusing to pick a slot to overwrite for you.');
        failures++;
      } else {
        const target = Number.parseInt(LOCATION_ARG, 10);
        console.log(`\n  CONFIRM LEG: this will OVERWRITE preset ${target} with the current working buffer.`);
        console.log(`  This device cannot read what preset ${target} currently holds, so neither this probe`);
        console.log('  nor you can be told what is about to be replaced. That is the limitation the gate exists for.');
        // In non-interactive mode `--confirm-leg --location=N` IS the
        // authorization: it was typed deliberately, names the slot, and has no
        // default. Re-prompting a process with no human attached would just
        // read EOF and skip, turning an explicit instruction into a silent
        // no-op.
        const go = NON_INTERACTIVE ? 'overwrite' : (await ask(`  Type the word "overwrite" to proceed, anything else to skip: `)).trim();
        if (go.toLowerCase() !== 'overwrite') {
          console.log('  Skipped. Nothing was sent.');
        } else {
          const saved = JSON.parse(await call('save_preset', { port: PORT, location: target, confirm_overwrite: true }));
          if (saved.acked === true) persisted = target;
          check(`a CONFIRMED save to preset ${target} proceeds`, saved.acked === true, JSON.stringify(saved).slice(0, 240));
          check(`the confirmed save was NOT refused by the overwrite gate`,
            !/REFUSING TO SAVE/i.test(JSON.stringify(saved)), JSON.stringify(saved).slice(0, 200));
          if (NON_INTERACTIVE) {
            skip(`preset ${target} holds the saved tone`,
              `The device ACKed the store, which is the wire half. Whether ${target} sounds like the buffer `
              + 'is the other half and needs the panel.');
          } else {
            const seen = (await ask(`  Navigate to preset ${target} on the panel. Does it hold the tone you just saved? (y/n) `)).trim();
            check('the confirmed save actually landed on the device', /^y/i.test(seen), `you answered "${seen}"`);
          }
        }
      }
    } else {
      console.log('\n  (Confirm leg not run. Re-run with --confirm-leg --location=N to exercise it.)');
    }
  } finally {
    rl.close();
    await client.close();
  }

  console.log('\n' + '='.repeat(64));
  console.log(`${checks - failures}/${checks} checks passed${skipped > 0 ? `, ${skipped} SKIPPED (need a human at the panel)` : ''}.`);
  if (skipped > 0) {
    console.log('A skipped leg is NOT a pass. The panel is ground truth and nothing read it,');
    console.log('so this run is machine-adjudicated only. Re-run interactively to close them.');
  }
  if (failures > 0) {
    console.log('\nA failure here is worth reporting: the refusal path is supposed to be');
    console.log('inert, and the active-preset read is what the whole gate keys on.');
    process.exit(1);
  }
  // State what THIS run did, not what the default run does. The earlier
  // wording printed "Nothing was persisted" unconditionally, including
  // straight after the confirm leg had just overwritten a preset.
  console.log(`\nThe overwrite gate behaves on hardware. ${
    persisted === undefined
      ? 'Nothing was persisted: the refusal path sends no bytes.'
      : `Preset ${persisted} WAS overwritten with the working buffer (you asked for it via --confirm-leg).`
  }`);
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); rl.close(); process.exit(1); });
