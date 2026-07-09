/**
 * Hydrasynth Explorer — first round-trip smoke test.
 *
 * Deliberately self-contained: no AM4-specific imports, uses node-midi
 * directly. The point is to prove end-to-end MIDI to the device works
 * before we layer BK-030 generic-MIDI primitives or BK-031 schema sugar
 * on top.
 *
 * Target: CC #7 (Master Volume). Per the manual p. 82, CC 7 is exempt
 * from the device's Param TX/RX setting — it always responds, regardless
 * of whether the synth is in CC, NRPN, or Off mode for engine control.
 *
 * Self-contained verification: the script plays a sustained C4 note
 * itself and runs the volume sweep while the note is held, so the
 * founder doesn't have to time pressing a key against the script.
 *
 * Sequence (all on MIDI channel 1):
 *   1. Note On  C4 vel 100              — note starts at default volume
 *      wait 500 ms                       — establishes baseline level
 *   2. CC 7 = 0     (B0 07 00)          — silent
 *      wait 800 ms
 *   3. CC 7 = 127   (B0 07 7F)          — full
 *      wait 800 ms
 *   4. CC 7 = 100   (B0 07 64)          — moderate (~80%)
 *      wait 600 ms
 *   5. Note Off C4
 *   6. CC 7 = 127                        — restore default volume
 *   7. CC 123 = 0 (All Notes Off)        — panic safety
 *
 * Pre-requisites:
 *   - Hydrasynth Explorer powered on, USB connected, audio routed
 *     so you can hear it (headphones or main outs → mixer/speakers)
 *   - The physical Master Volume knob set to a comfortable listening
 *     level. CC 7 multiplies that, it doesn't override.
 *   - Any patch loaded that responds quickly to Note On (avoid pads
 *     with multi-second attacks for the first run).
 *
 * Run:  npm run hydra:smoke
 *   or: npx tsx scripts/hydrasynth/smoke.ts
 *
 * Expected outcome: ~3 seconds of held note, with the audio level
 * stepping through default → silent → full → moderate, then the
 * note releases and volume restores to full.
 *
 * Design doc: docs/devices/hydrasynth-explorer/FIRST-SMOKE.md
 */
import midi, { Output } from "@julusian/midi";

const HYDRA_PORT_NEEDLES = ['hydrasynth', 'asm hydra'];
const MIDI_CHANNEL = 1;            // Hydrasynth default; configurable on MIDI page 1
const CC_MASTER_VOLUME = 7;        // System CC, exempt from Param TX/RX setting
const CC_ALL_NOTES_OFF = 123;      // System CC, panic safety
const NOTE_C4 = 60;                // middle C
const NOTE_VELOCITY = 100;         // loud-but-not-clipping

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function findHydrasynthPort(out: Output): { index: number; name: string } | null {
  for (let i = 0; i < out.getPortCount(); i++) {
    const name = out.getPortName(i);
    const lower = name.toLowerCase();
    if (HYDRA_PORT_NEEDLES.some((n) => lower.includes(n))) {
      return { index: i, name };
    }
  }
  return null;
}

function ccBytes(channel: number, cc: number, value: number): number[] {
  // MIDI channel 1..16 maps to status nibble 0..15
  const status = 0xB0 | ((channel - 1) & 0x0F);
  return [status, cc & 0x7F, value & 0x7F];
}

function noteOnBytes(channel: number, note: number, velocity: number): number[] {
  const status = 0x90 | ((channel - 1) & 0x0F);
  return [status, note & 0x7F, velocity & 0x7F];
}

function noteOffBytes(channel: number, note: number): number[] {
  const status = 0x80 | ((channel - 1) & 0x0F);
  return [status, note & 0x7F, 0x00];
}

function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

async function main(): Promise<void> {
  const out = new midi.Output();
  const portCount = out.getPortCount();

  console.log(`Found ${portCount} MIDI output port${portCount === 1 ? '' : 's'}:`);
  for (let i = 0; i < portCount; i++) {
    console.log(`  [${i}] ${out.getPortName(i)}`);
  }
  console.log();

  const hydra = findHydrasynthPort(out);
  if (!hydra) {
    console.error('FAILED: no Hydrasynth port found.');
    console.error(`Looked for any port whose name contains: ${HYDRA_PORT_NEEDLES.join(' / ')}`);
    console.error('If the device is plugged in but the name is different, capture the');
    console.error('exact name from the listing above and add it to HYDRA_PORT_NEEDLES.');
    process.exit(1);
  }
  console.log(`Using port [${hydra.index}] "${hydra.name}"`);
  console.log();

  out.openPort(hydra.index);

  const send = (bytes: number[], note: string): void => {
    console.log(`-> ${toHex(bytes)}   ${note}`);
    out.sendMessage(bytes);
  };

  console.log('Step 1/4: Note On C4 (default volume baseline)');
  send(noteOnBytes(MIDI_CHANNEL, NOTE_C4, NOTE_VELOCITY), 'Note On C4 vel 100');
  await sleep(500);

  console.log('\nStep 2/4: Master Volume to 0 (silent)');
  send(ccBytes(MIDI_CHANNEL, CC_MASTER_VOLUME, 0), 'CC 7 = 0 → silent');
  await sleep(800);

  console.log('\nStep 3/4: Master Volume to 127 (full)');
  send(ccBytes(MIDI_CHANNEL, CC_MASTER_VOLUME, 127), 'CC 7 = 127 → full');
  await sleep(800);

  console.log('\nStep 4/4: Master Volume to 100 (~80%)');
  send(ccBytes(MIDI_CHANNEL, CC_MASTER_VOLUME, 100), 'CC 7 = 100 → moderate');
  await sleep(600);

  console.log('\nCleanup: Note Off, restore volume, panic safety');
  send(noteOffBytes(MIDI_CHANNEL, NOTE_C4), 'Note Off C4');
  await sleep(100);
  send(ccBytes(MIDI_CHANNEL, CC_MASTER_VOLUME, 127), 'CC 7 = 127 (restore)');
  send(ccBytes(MIDI_CHANNEL, CC_ALL_NOTES_OFF, 0), 'CC 123 (All Notes Off, panic)');

  out.closePort();

  console.log('\n✓ Done. The note should have stepped through:');
  console.log('  baseline → silent → full → moderate → released');
  console.log('  If you heard those four distinct levels, the round trip works');
  console.log('  and BK-031 step A is unblocked on the protocol-feasibility side.');
  console.log('\n  If you heard a note but no volume changes: the device is');
  console.log('  receiving Note On (so MIDI works) but ignoring CC 7 — unexpected;');
  console.log('  check the manual\'s MIDI: Page 1 (channel) and report back.');
  console.log('  If you heard nothing: check audio routing + physical volume knob.');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
