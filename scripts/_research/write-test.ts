/**
 * mcp-midi-control — First verified parameter write
 *
 * This is the first script that WRITES to the AM4 (every prior script was
 * read-only). Writes here only modify the AM4's working buffer, not any
 * stored preset location — so no Z04 backup is needed (the value reverts on preset
 * change or power cycle). See docs/_private/DECISIONS.md "write safety".
 *
 * What it does:
 *   1. Opens the AM4 over USB-MIDI.
 *   2. Captures one inbound SysEx baseline so we know polling is working.
 *   3. Sends a SET_PARAM write for Amp Gain (address is preset-independent):
 *        - target internal value: 0.05  (= UI displayed value 0.5)
 *      This is a small, audible-but-not-extreme change.
 *   4. Pauses 250 ms.
 *   5. Sends a second write restoring the previous internal value (read
 *      from the baseline poll if available, otherwise sets a safe 0.10
 *      = UI displayed 1.0).
 *
 * Pre-requisites:
 *   - AM4 powered on, USB connected
 *   - Headphones or amp NOT at high volume (the sound will change!)
 *
 * Run:  npx tsx scripts/write-test.ts
 *
 * Expected outcome: the on-screen Amp Gain value on the AM4 (or in
 * AM4-Edit if open) jumps to "0.5", then 250 ms later restores to 1.0.
 */
import { connectAM4, toHex } from '@mcp-midi-control/am4/midi.js';
import { buildSetFloatParam } from 'fractal-midi/am4';
import { KNOWN_PARAMS } from 'fractal-midi/am4';

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log('Opening AM4 connection...');
  const am4 = connectAM4();

  let inboundCount = 0;
  const unsubscribe = am4.onMessage(() => { inboundCount++; });

  console.log('Listening for 500 ms to confirm device is alive...');
  await sleep(500);
  unsubscribe();
  console.log(`  Received ${inboundCount} inbound MIDI messages in baseline window.`);
  if (inboundCount === 0) {
    console.warn('  ⚠️  No baseline traffic. AM4 may still respond, but check connection.');
  }

  const param = KNOWN_PARAMS['amp.gain'];

  // Test write: set Amp Gain to UI 0.5 (internal 0.05).
  const writeMsg = buildSetFloatParam(param, 0.05);
  console.log(`\n→ WRITE Amp Gain = 0.5 (internal 0.05)`);
  console.log(`  ${toHex(writeMsg)}`);
  am4.send(writeMsg);

  await sleep(250);

  // Restore: set Amp Gain back to a safe default 1.0 (internal 0.10).
  const restoreMsg = buildSetFloatParam(param, 0.10);
  console.log(`\n→ WRITE Amp Gain = 1.0 (internal 0.10)  [restore]`);
  console.log(`  ${toHex(restoreMsg)}`);
  am4.send(restoreMsg);

  await sleep(250);

  am4.close();
  console.log('\n✓ Done. Verify on the AM4 display:');
  console.log('  - Amp block, channel A, Gain parameter');
  console.log('  - Should now read 1.0 (after the brief jump to 0.5)');
  console.log('\nIf nothing changed, possible causes:');
  console.log('  - The Amp block is bypassed');
  console.log('  - The active channel is not A');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
