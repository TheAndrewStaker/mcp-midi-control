/**
 * HW-CIRCUIT-002 probe — does `save_preset` (Replace-Patch, Flash) PERSIST?
 *
 * Fully automated (no human observation). Verifies via the file-transfer patch
 * READ (fileType 0x04) — the mechanism Novation Components actually uses — NOT
 * Program Change (which does not select patches on this device). It saves a patch
 * with a DISTINCTIVE NAME, then reads the slot back from Flash and checks the name.
 *
 *   npx tsx scripts/probe-circuit-patch-save.ts [scratchSlot=63] [synth=1]
 *
 * ⚠️ DESTRUCTIVE: overwrites the scratch PATCH slot and does NOT restore it (the
 * file→body decode needed to reconstruct the original isn't wired). Use a slot you
 * don't mind losing (default 63); reload your pack in Components afterwards if needed.
 * Requires the Circuit connected over USB, Components closed.
 */

import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { readCurrentPatch, readStoredPatch, savePatch } from '@mcp-midi-control/circuit-tracks/codec/patchTransfer.js';
import { encodePatchName } from '@mcp-midi-control/circuit-tracks/codec/blob.js';
import { OFFSET_BY_PARAM } from '@mcp-midi-control/circuit-tracks/codec/patchLayout.js';
import { paramWire } from '@mcp-midi-control/circuit-tracks/codec/live.js';
import { findParam } from '@mcp-midi-control/circuit-tracks/params.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FREQ = findParam('filter', 'frequency')!;
const FREQ_OFFSET = OFFSET_BY_PARAM.get('filter.frequency')!;

const scratchSlot = Number(process.argv[2] ?? 63);
const synth = Number(process.argv[3] ?? 1);
const loc = (synth - 1) as 0 | 1;

if (!Number.isInteger(scratchSlot) || scratchSlot < 0 || scratchSlot > 63 || ![1, 2].includes(synth)) {
  console.error('Usage: probe-circuit-patch-save.ts [scratchSlot 0..63] [synth 1|2]');
  process.exit(2);
}

async function main(): Promise<void> {
  console.log(`\n=== HW-CIRCUIT-002 probe: does save_preset persist to Flash? ===`);
  console.log(`Synth ${synth}, scratch PATCH slot ${scratchSlot}. Verifies via file-transfer READ (fileType 0x04).`);
  console.log(`⚠️  OVERWRITES slot ${scratchSlot} and does NOT restore it.\n`);

  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found (powered on? Components closed?).' });
  if (!conn.hasInput) { console.error('FAIL: no MIDI input — bidirectional connection required.'); conn.close(); process.exit(1); }

  try {
    // 1. Read the slot from Flash (baseline). An EMPTY slot is fine — the write
    // then turns empty → our test patch, which is the cleanest possible proof.
    const before = await readStoredPatch(conn, scratchSlot);
    if (!before.ok && !before.empty) { console.error(`FAIL: read error on slot ${scratchSlot}: ${before.error}`); return; }
    console.log(`[1] slot ${scratchSlot} BEFORE: ${before.empty ? 'EMPTY' : `name="${before.name}", ${before.bytes!.length}B, crcOk=${before.crcOk}`}`);

    // 2. Edit Synth 1's live sound distinctively.
    const testValue = 85;
    conn.send(paramWire(FREQ, testValue));
    await sleep(50);
    const distinctiveName = `PROBE${testValue}`;

    // 3. SAVE: dump the (edited) current patch, stamp the name, Replace-Patch to Flash.
    const dumped = await readCurrentPatch(conn, loc, {});
    if (!dumped.ok || !dumped.body) { console.error(`FAIL: dump before save failed: ${dumped.error}`); return; }
    const body = Uint8Array.from(dumped.body);
    if ((body[FREQ_OFFSET] & 0x7f) !== testValue) { console.error(`FAIL: CC edit did not register (dump reads ${body[FREQ_OFFSET]}).`); return; }
    encodePatchName(body, distinctiveName);
    // Save via the session-wrapped, FIRE-AND-FORGET protocol Components uses, with
    // a CLEAN body (byte 17 = 0x00). savePatch makes the Replace-Patch the last thing
    // on the wire; the device commits silently (no ack) — so we do NOT read back
    // in-band (a verify read opens a session that aborts the flash commit).
    const save = await savePatch(conn, Array.from(body), scratchSlot);
    console.log(`[2] savePatch (fire-and-forget) → slot ${scratchSlot} = Patch ${scratchSlot + 1}: freq ${testValue}, clean body[17]=00, pre-write 0x08 ack=${save.committed}${save.error ? ` (sendErr: ${save.error})` : ''}\n`);
    console.log(`Saved a BRIGHT filter (freq ${testValue}) to Patch ${scratchSlot + 1} on Synth ${synth}.`);
    console.log(`Now: power-cycle the Circuit, load Patch ${scratchSlot + 1} on Synth ${synth}, and confirm the filter is open/bright.`);
  } catch (err) {
    console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    conn.close();
  }
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
