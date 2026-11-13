/**
 * HW-CIRCUIT-013 — capture the Circuit's TRUE factory-INIT patch body.
 *
 * Reads a RANGE of stored synth-patch slots over the file-transfer read
 * (fileType 0x04, the mechanism Novation Components itself uses) and reports
 * each one's name, how non-zero it is, and a byte diff against its neighbour.
 * Read-only: dump requests only, nothing is written to the device.
 *
 *   npx tsx scripts/circuit-capture-init-patch.ts [fromFile=3] [toFile=6] [outDir]
 *
 * ## ⚠ THE ARGUMENT IS A FILE INDEX, NOT A PATCH NUMBER (measured 2026-08-16)
 *
 * `patchFileId(slot, pack = 0)` addresses a FILE, and a file holds SEVERAL patch
 * records at 512-byte stride. Measured on the maintainer's unit, pack 0:
 *
 *   file 0 -> 1876 B = 4 records: "Sub Hard", "PROBE85", "Jackson Bass",
 *                                 "Jackson Bass (mo"
 *   file 6 -> 3924 B = 8 records, ALL 0xFF
 *   file 7 -> 3924 B = 8 records, rec0 "Saw Pad", rec1-7 all 0xFF
 *
 * So the front-panel patch number maps to a (file, record) PAIR, and that
 * mapping is NOT decoded. Passing a panel patch number as this argument reads
 * some unrelated file. This confirms on hardware the mis-model recorded in
 * BK-CIRCUIT-PATCHN ("a fileType-0x04 read returns a 4-record/512-stride `.cpb`
 * GROUP, not a ~1876-byte patch FILE") and refines it: the record count VARIES
 * per file (4 and 8 both seen), so it cannot be assumed either.
 *
 * ## Two more traps this script had to learn, both worth keeping
 *
 * - **`readStoredPatch`'s `empty: true` is a TIMEOUT, not a device statement.**
 *   It is set when no READ_INIT reply arrives within `responseTimeoutMs`, and
 *   its own error string hedges "(empty slot?)". A first pass read files 0/6/7
 *   and reported every other index "EMPTY"; that is indistinguishable from a
 *   genuinely absent file at the call site. Do not report it as "the slot is
 *   empty".
 * - **`crcOk: true` passes on an all-0xFF read.** The CRC validates the
 *   TRANSFER, not the presence of content. An erased record round-trips
 *   perfectly. Check for 0xFF fill separately, which this script now does.
 *
 * WHY THIS CAPTURE EXISTS. `codec/blob.ts:60-71`'s `initPatchBody()` is 340 ZERO
 * bytes plus a name, and says so itself: "NOT a byte-accurate copy of the
 * device's true factory init patch (whose non-name bytes carry real defaults)."
 * The factory-modal evidence at `codec/patchLayout.ts:14-18` shows the real
 * defaults are non-zero (off54 osc1_level=127, off64 filter freq=127), so a zero
 * baseline closes the filter and zeroes the oscillator mix. Any `apply_patch`
 * built on it would ship a near-silent patch under an "applied" receipt.
 *
 * A derivation from registry defaults is NOT a substitute: the mod-matrix
 * (bytes 124-203) and macro (204-339) regions are 216 bytes with no registry
 * source. The capture is the only oracle.
 *
 * THE CROSS-CHECK THIS SCRIPT EXISTS TO MAKE (owner observation, 2026-08-16):
 * a slot written with Components' "Create Patch" and a never-touched factory
 * slot sound IDENTICAL. So they are two INDEPENDENT sources of "init" —
 * Components' generator and the factory shipped state. If their bodies are
 * byte-identical, the init body is confirmed by agreement rather than by a
 * single dump. If they differ, the diff localises exactly which bytes are
 * Components' idea of init versus the device's.
 *
 * BEFORE RUNNING: CLOSE Novation Components, and make sure no live MCP server
 * holds the Circuit — the USB MIDI port is exclusive.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { connect, closeAllMidiConnections } from '@mcp-midi-control/core/midi/transport.js';
import { readStoredPatch } from '@mcp-midi-control/circuit-tracks/codec/patchTransfer.js';
import { decodePatchName } from '@mcp-midi-control/circuit-tracks/codec/blob.js';
import { OFFSET_BY_PARAM } from '@mcp-midi-control/circuit-tracks/codec/patchLayout.js';

/** One patch record inside the `.cpb` group the stored read returns. */
const PATCH_BODY_LEN = 340;
/** Records sit at this stride inside the group; the last one is not padded. */
const RECORD_STRIDE = 512;

const fromSlot = Number(process.argv[2] ?? 3);
const toSlot = Number(process.argv[3] ?? 6);
const outDir = process.argv[4] ?? path.join('samples', 'circuit-ncs', 'init-patch-capture');

const PROBES = ['osc1.level', 'filter.frequency', 'osc1.wave', 'amp_env.sustain'];

interface Row {
  slot: number;
  name: string;
  body: Uint8Array;
  nonZero: number;
  probes: [string, number | undefined][];
}

function summarise(slot: number, body: Uint8Array): Row {
  return {
    slot,
    name: decodePatchName(body),
    body,
    nonZero: body.filter((b) => b !== 0).length,
    probes: PROBES.map((k) => {
      const off = OFFSET_BY_PARAM.get(k);
      return [k, off === undefined ? undefined : body[off]] as [string, number | undefined];
    }),
  };
}

/** Byte positions where two equal-length bodies differ. */
function diffOffsets(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

async function main(): Promise<void> {
  const conn = connect({
    needles: ['circuit'],
    notFoundLeadIn: 'Circuit Tracks not found (powered on? Components closed?).',
  });

  fs.mkdirSync(outDir, { recursive: true });
  const rows: Row[] = [];

  // Back-to-back file-transfer sessions need recovery time: the first pass at
  // this (2026-08-16) read slots 0/6/7 and timed out on every other slot, which
  // is a read-reliability artifact, not a sparse pack. Note that
  // `readStoredPatch` reports `empty: true` when NO reply arrives within the
  // timeout -- its own error string hedges "(empty slot?)" -- so a timeout is
  // indistinguishable from a genuinely empty slot at the call site. Give the
  // device room and a long window before believing either.
  const settleMs = Number(process.env.CIRCUIT_SETTLE_MS ?? 1200);
  const readTimeoutMs = Number(process.env.CIRCUIT_READ_TIMEOUT_MS ?? 10_000);

  for (let slot = fromSlot; slot <= toSlot; slot++) {
    if (slot > fromSlot) await new Promise<void>((r) => setTimeout(r, settleMs));
    process.stdout.write(`slot ${slot}: `);
    const res = await readStoredPatch(conn, slot, { responseTimeoutMs: readTimeoutMs });
    if (!res.ok || res.bytes === undefined) {
      console.log(res.empty === true ? 'EMPTY' : `FAILED (${res.error ?? 'no bytes'})`);
      continue;
    }
    // MEASURED 2026-08-16: the reply is a multi-record FILE, not one patch.
    // File 0 came back 1876 B = 4 records; files 6 and 7 came back 3924 B = 8.
    // Enumerate every record rather than assuming record 0 is "the" patch.
    const bytes = res.bytes;
    const recCount = Math.floor((bytes.length - PATCH_BODY_LEN) / RECORD_STRIDE) + 1;
    console.log(`${bytes.length} B = ${recCount} record(s), crcOk=${res.crcOk}`);
    for (let rec = 0; rec < recCount; rec++) {
      const off = rec * RECORD_STRIDE;
      const body = bytes.slice(off, off + PATCH_BODY_LEN);
      if (body.length < PATCH_BODY_LEN) break;
      const row = summarise(slot, body);
      const ff = body.filter((b) => b === 0xff).length;
      // An all-0xFF record is ERASED FLASH, not a patch. Note that crcOk is
      // true for these: the CRC validates the transfer, and says nothing about
      // whether a patch is present.
      const erased = ff === PATCH_BODY_LEN;
      console.log(`    rec${rec} @${String(off).padStart(4)}: `
        + (erased ? 'ERASED (all 0xFF)' : `"${row.name}"  ${row.nonZero}/${PATCH_BODY_LEN} non-zero`));
      if (erased) continue;
      rows.push(row);
      fs.writeFileSync(
        path.join(outDir, `file${String(slot).padStart(2, '0')}-rec${rec}.bin`),
        Buffer.from(body),
      );
    }
  }

  if (rows.length === 0) {
    console.error('\nNo slots read. Nothing captured.');
    process.exitCode = 1;
    return;
  }

  console.log('\nPROBES (a true init should be NON-zero here)\n');
  const w = Math.max(...PROBES.map((p) => p.length));
  console.log(`  ${'param'.padEnd(w)}  ${rows.map((r) => `s${String(r.slot).padStart(2)}`).join('  ')}`);
  for (let i = 0; i < PROBES.length; i++) {
    const vals = rows.map((r) => String(r.probes[i]![1] ?? '-').padStart(3));
    console.log(`  ${PROBES[i]!.padEnd(w)}  ${vals.join('  ')}`);
  }

  console.log('\nPAIRWISE DIFF (consecutive captured slots)\n');
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    const d = diffOffsets(a.body, b.body);
    const nameOnly = d.every((o) => o < 16);
    console.log(`  s${a.slot} vs s${b.slot}: ${d.length} byte(s) differ`
      + (d.length === 0 ? '  <- BYTE-IDENTICAL'
        : nameOnly ? '  <- NAME ONLY (bodies identical)'
          : `  first at ${d[0]}, last at ${d[d.length - 1]}`));
    if (d.length > 0 && !nameOnly) {
      const beyondName = d.filter((o) => o >= 16);
      console.log(`      ${beyondName.length} outside the 0-15 name field: `
        + `${beyondName.slice(0, 24).join(', ')}${beyondName.length > 24 ? ', ...' : ''}`);
    }
  }

  console.log(`\nBodies written to ${outDir}`);
  console.log('A pair reading BYTE-IDENTICAL (or NAME ONLY) confirms the init body from two');
  console.log('independent sources: Components\' generator and the factory shipped state.');
}

// An open MIDI port keeps the event loop alive, so transport.ts's
// process.on('exit') cleanup can never fire on its own: a standalone script must
// close the ports itself or it hangs after finishing, still holding the
// instance lock, and the next run refuses with port_held_elsewhere.
main()
  .catch((err) => {
    console.error(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => { closeAllMidiConnections(); });
