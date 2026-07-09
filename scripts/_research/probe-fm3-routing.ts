/**
 * FM3-Edit routing capture probe.
 *
 * Passively records what FM3-Edit emits over loopMIDI when you draw cables
 * in its grid. The script guides you through a specific set of cables,
 * then compares each captured frame against what both the 4-row and 6-row
 * variants of the gen-3 routing formula would predict.
 *
 * The result closes (or contradicts) the "FM3 routing gated" status:
 * once byte patterns are confirmed, `buildSetGridRouting` can be unlocked
 * for FM3 (rows=4) and the writer gate in fractal-gen3 removed.
 *
 * Prerequisites:
 *   - FM3-Edit installed and open
 *   - A loopMIDI port connecting FM3-Edit's MIDI output to this script
 *   - Any FM3 preset loaded with a mostly-empty grid (clear rows 1-4 first)
 *
 * Usage: npx tsx scripts/_research/probe-fm3-routing.ts
 *
 * READ BEFORE RUNNING:
 *   1. Open FM3-Edit. Open any preset.
 *   2. Clear the grid rows 1-4 so cables are visible.
 *   3. In FM3-Edit MIDI settings, set Output to the loopMIDI port.
 *   4. Start this script; it will list MIDI input ports.
 *   5. For each step, draw EXACTLY the cable described, then press Enter.
 *   6. After all steps, the script writes a results JSON to samples/captured/.
 *
 * The probe is read-only: it never sends any SysEx to FM3-Edit.
 */

import midi from "@julusian/midi";
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

// ─── readline helper ─────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise(r => rl.question(q, r));

// ─── Gen-3 routing formula (parameterized by rows) ───────────────────────────

function computeRoutingBytes(srcRow: number, srcCol: number, destRow: number, rows: 4 | 6): {
  srcGp: number; b21: number; b22: number; b23: number;
} {
  const srcGp = (srcCol - 1) * rows + (srcRow - 1);
  const b21 = Math.floor(srcGp / 2);
  const colTerm = Math.floor((3 * (srcCol - 1)) / 2) + 1;
  const destSign = destRow >= 3 ? 1 : 0;
  const b22 = ((srcGp & 1) << 6) | (colTerm + destSign);
  const b23 = ((Math.abs(destRow - 3) + (srcCol % 2 === 0 ? 2 : 0)) % 4) << 5;
  return { srcGp, b21, b22, b23 };
}

function hexByte(n: number): string { return n.toString(16).padStart(2, '0'); }
function hexBytes(arr: number[]): string { return arr.map(hexByte).join(' '); }

// ─── Routing frame detection ─────────────────────────────────────────────────

const FM3_MODEL_BYTE = 0x11;
const FN_PARAMETER_SETGET = 0x01;
const ROUTING_SUB_ACTION = 0x35;

function isRoutingFrame(bytes: number[]): boolean {
  return (
    bytes.length === 26 &&
    bytes[0] === 0xF0 &&
    bytes[4] === FM3_MODEL_BYTE &&
    bytes[5] === FN_PARAMETER_SETGET &&
    bytes[6] === ROUTING_SUB_ACTION &&
    bytes[25] === 0xF7
  );
}

function parseRoutingFrame(bytes: number[]): { op: number; b21: number; b22: number; b23: number } {
  return { op: bytes[12], b21: bytes[21], b22: bytes[22], b23: bytes[23] };
}

// ─── Test matrix ─────────────────────────────────────────────────────────────
//
// Cables chosen to distinguish 4-row vs 6-row formula:
//   - Col 1 cables: srcGp is THE SAME for rows=4 and rows=6 → baseline verification
//   - Col 2+ cables: srcGp DIFFERS between rows → pattern discrimination
//   - Row-1 even-col: currently refused on 6-row; may decode here for 4-row

const TEST_CABLES: Array<{
  srcRow: number; srcCol: number; destRow: number;
  note: string;
}> = [
  // Col 1 baselines (srcGp identical for rows=4 and rows=6 when srcCol=1)
  { srcRow: 2, srcCol: 1, destRow: 2, note: 'baseline: same-row serial (srcGp=1 for both)' },
  { srcRow: 3, srcCol: 1, destRow: 2, note: 'col-1 cross-row up (srcGp=2)' },
  { srcRow: 4, srcCol: 1, destRow: 4, note: 'col-1 bottom row (srcGp=3)' },
  { srcRow: 2, srcCol: 1, destRow: 4, note: 'col-1 fan-out to bottom' },
  { srcRow: 1, srcCol: 1, destRow: 1, note: 'row-1 odd-col forward (srcGp=0)' },

  // Col 2+ — srcGp diverges between rows=4 and rows=6
  { srcRow: 2, srcCol: 2, destRow: 2, note: 'even srcCol (srcGp: 4r=5, 6r=7) — KEY DISCRIMINATOR' },
  { srcRow: 3, srcCol: 2, destRow: 2, note: 'even srcCol cross-row (srcGp: 4r=6, 6r=8)' },
  { srcRow: 2, srcCol: 3, destRow: 2, note: 'col 3 same-row (srcGp: 4r=9, 6r=13)' },
  { srcRow: 4, srcCol: 3, destRow: 2, note: 'col 3 cross-row (srcGp: 4r=11, 6r=15)' },

  // Row-1 even-col: currently REFUSED on 6-row (encoding unknown); capture here
  { srcRow: 1, srcCol: 2, destRow: 1, note: 'ROW-1 EVEN-COL — currently refused on 6-row; decode opportunity' },
];

// ─── Main ────────────────────────────────────────────────────────────────────

interface CaptureResult {
  srcRow: number; srcCol: number; destRow: number;
  note: string;
  capturedFrames: number[][];
  formula4row: ReturnType<typeof computeRoutingBytes>;
  formula6row: ReturnType<typeof computeRoutingBytes>;
  match4row: boolean;
  match6row: boolean;
}

async function main() {
  console.log('\n═══ FM3-Edit Routing Capture Probe ═══\n');
  console.log('This script captures cable-draw SysEx from FM3-Edit over loopMIDI.');
  console.log('It compares each capture against the 4-row and 6-row gen-3 formula predictions.\n');

  // List MIDI input ports
  const input = new midi.Input();
  const portCount = input.getPortCount();
  if (portCount === 0) {
    console.error('No MIDI input ports found. Connect FM3-Edit to a loopMIDI port first.');
    process.exit(1);
  }

  console.log('Available MIDI input ports:');
  for (let i = 0; i < portCount; i++) {
    console.log(`  [${i}] ${input.getPortName(i)}`);
  }

  const portIndexStr = await ask('\nEnter port number to listen on: ');
  const portIndex = parseInt(portIndexStr.trim(), 10);
  if (isNaN(portIndex) || portIndex < 0 || portIndex >= portCount) {
    console.error(`Invalid port index: ${portIndexStr}`);
    process.exit(1);
  }

  // Open MIDI input. MUST enable SysEx reception — node-midi ignores it
  // by default. ignoreTypes(sysex, timing, activeSensing).
  input.ignoreTypes(false, false, false);
  const captureBuffer: number[][] = [];
  input.on('message', (_deltaTime, message) => {
    captureBuffer.push([...message]);
  });
  input.openPort(portIndex);
  console.log(`\nListening on: ${input.getPortName(portIndex)}`);
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('SETUP: In FM3-Edit, ensure the grid is visible with an empty');
  console.log('preset. Cables will appear as wires between cells.');
  console.log('─────────────────────────────────────────────────────────────\n');

  await ask('Press Enter when FM3-Edit is ready...');

  const results: CaptureResult[] = [];

  for (let i = 0; i < TEST_CABLES.length; i++) {
    const { srcRow, srcCol, destRow, note } = TEST_CABLES[i];
    const destCol = srcCol + 1;

    const f4 = computeRoutingBytes(srcRow, srcCol, destRow, 4);
    const f6 = computeRoutingBytes(srcRow, srcCol, destRow, 6);

    console.log(`\n──── Step ${i + 1}/${TEST_CABLES.length} ────`);
    console.log(`Cable: row ${srcRow} col ${srcCol}  →  row ${destRow} col ${destCol}`);
    console.log(`Note:  ${note}`);
    console.log(`4-row prediction: b21=${hexByte(f4.b21)} b22=${hexByte(f4.b22)} b23=${hexByte(f4.b23)}`);
    console.log(`6-row prediction: b21=${hexByte(f6.b21)} b22=${hexByte(f6.b22)} b23=${hexByte(f6.b23)}`);
    console.log(`${f4.b21 === f6.b21 && f4.b22 === f6.b22 && f4.b23 === f6.b23 ? '⚠ Identical predictions — cannot discriminate with this cable' : '✓ Predictions differ — discriminating cable'}`);
    console.log('\nIn FM3-Edit: draw the cable described above, then press Enter.');
    console.log('(If FM3-Edit does not emit SysEx on cable draw, check MIDI output settings.)');

    // Clear buffer and wait for user
    captureBuffer.length = 0;
    await ask('');

    // Give a brief moment for any trailing bytes
    await new Promise(r => setTimeout(r, 100));

    // Collect routing frames from the buffer
    const routingFrames = captureBuffer
      .filter(msg => {
        // SysEx arrives byte-by-byte in some configurations; handle both
        // complete-frame and individual bytes by checking the full message
        return isRoutingFrame(msg);
      });

    // Also try reassembling from raw sysex bytes if needed
    // (node-midi may deliver SysEx as one message or fragmented)
    const allFrames = [...routingFrames];

    if (allFrames.length === 0) {
      console.log('  ⚠ No fn=0x01 sub=0x35 routing frame captured.');
      console.log(`  Raw buffer had ${captureBuffer.length} message(s):`);
      for (const msg of captureBuffer.slice(0, 5)) {
        console.log(`    [${hexBytes(msg)}]`);
      }
    } else {
      for (const frame of allFrames) {
        const parsed = parseRoutingFrame(frame);
        const match4 = parsed.b21 === f4.b21 && parsed.b22 === f4.b22 && parsed.b23 === f4.b23;
        const match6 = parsed.b21 === f6.b21 && parsed.b22 === f6.b22 && parsed.b23 === f6.b23;
        console.log(`  Captured:   b21=${hexByte(parsed.b21)} b22=${hexByte(parsed.b22)} b23=${hexByte(parsed.b23)}`);
        console.log(`  Full frame: [${hexBytes(frame)}]`);
        console.log(`  Matches 4-row: ${match4 ? '✓ YES' : '✗ no'}  |  Matches 6-row: ${match6 ? '✓ YES' : '✗ no'}`);
      }
    }

    results.push({
      srcRow, srcCol, destRow, note,
      capturedFrames: allFrames,
      formula4row: f4,
      formula6row: f6,
      match4row: allFrames.length > 0 && allFrames.every(f => {
        const p = parseRoutingFrame(f);
        return p.b21 === f4.b21 && p.b22 === f4.b22 && p.b23 === f4.b23;
      }),
      match6row: allFrames.length > 0 && allFrames.every(f => {
        const p = parseRoutingFrame(f);
        return p.b21 === f6.b21 && p.b22 === f6.b22 && p.b23 === f6.b23;
      }),
    });
  }

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log('\n\n═══ Summary ═══\n');
  console.log('Cable                          | Captured          | 4-row | 6-row | Note');
  console.log('─────────────────────────────────────────────────────────────────────────');
  for (const r of results) {
    const cableStr = `r${r.srcRow}c${r.srcCol}→r${r.destRow}c${r.srcCol + 1}`.padEnd(30);
    if (r.capturedFrames.length === 0) {
      console.log(`${cableStr} | (no capture)       |       |       | ${r.note}`);
    } else {
      const p = parseRoutingFrame(r.capturedFrames[0]);
      const capStr = `${hexByte(p.b21)} ${hexByte(p.b22)} ${hexByte(p.b23)}`.padEnd(17);
      const m4 = r.match4row ? '  ✓  ' : '  ✗  ';
      const m6 = r.match6row ? '  ✓  ' : '  ✗  ';
      console.log(`${cableStr} | ${capStr}  | ${m4} | ${m6} | ${r.note}`);
    }
  }

  const captured = results.filter(r => r.capturedFrames.length > 0);
  const matches4 = captured.filter(r => r.match4row).length;
  const matches6 = captured.filter(r => r.match6row).length;
  console.log(`\nOf ${captured.length} captured cables: ${matches4}/${captured.length} match 4-row formula; ${matches6}/${captured.length} match 6-row formula.`);

  if (matches4 === captured.length && captured.length > 0) {
    console.log('\n✓ ALL captured cables match the 4-row formula.');
    console.log('  → Update buildSetGridRouting to accept rows=4 and remove the FM3 writer gate.');
  } else if (matches6 === captured.length && captured.length > 0) {
    console.log('\n⚠ All captured cables match the 6-ROW formula — FM3 may use the same formula as III/FM9.');
    console.log('  → If confirmed on more cables, pass rows=6 for FM3 and just update the deviceOutputCol.');
  } else if (captured.length > 0) {
    console.log('\n⚠ Mixed or no match — the formula needs further analysis.');
    console.log('  → Inspect the captured b21/b22/b23 values against both predictions to derive the actual pattern.');
  }

  // ─── Save results JSON ─────────────────────────────────────────────────────

  const outDir = 'samples/captured';
  const outPath = path.join(outDir, `fm3-routing-probe-${Date.now()}.json`);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify({ capturedAt: new Date().toISOString(), results }, null, 2));
    console.log(`\nResults saved to ${outPath}`);
  } catch (err) {
    console.warn(`\nCould not save results: ${err}`);
  }

  input.closePort();
  rl.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
