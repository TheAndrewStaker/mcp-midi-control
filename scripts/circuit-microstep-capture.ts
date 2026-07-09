/**
 * Circuit Tracks micro-step PLACEMENT decode — interactive on-device capture.
 *
 * WHY: the drum per-step `rhythm` byte is a 6-bit micro-hit mask
 * (drumPattern.ts), but we have only ever pinned its two ENDPOINTS — a plain
 * hit = 0x01 and a full buzz roll = 0x3F. The 60 values in between (placing a
 * hit on micro-tick 1..5, or any combination) are unconfirmed, so we author
 * only roll {1,6}. That caps faithful import of fast parts: the Sleep Token
 * "Gethsemane" bridge hat needs a hit at micro-tick 3 (32nd notes) and ticks
 * 2 & 4 (16th-triplets) — ~69% → ~87% fidelity hangs on this byte.
 *
 * HYPOTHESIS (strong; 0x01 and 0x3F are exactly the two endpoints of a
 * positional 6-bit mask): bit k (value 1<<k) = a hit fires on micro-tick k.
 *   plain hit      = 0x01  (bit 0)            [known]
 *   buzz (6 ticks) = 0x3F  (bits 0-5)         [known]
 *   32nd note      = 0x08  (bit 3)            [to confirm]
 *   triplet offset = 0x10 / 0x04 (bit 4 / 2)  [to confirm]
 *   two ticks 0+3  = 0x09                     [to confirm additivity]
 *
 * METHOD: the before/after on-device diff that decoded length/chain/scenes.
 * You author ONE controlled edit on the device, save to a scratch slot, press
 * Enter; the script downloads that slot and reports which `rhythm` byte changed
 * and its bit pattern. ONE variable per capture (RE-WORKFLOW.md discipline).
 * Readline-gated — never timer-gated — so you set the pace.
 *
 * SAFETY: read-only over MIDI (only downloadProject). YOU do the saves, to a
 * SCRATCH slot you don't mind overwriting (default 63 = Project 64). Close
 * Novation Components first (port contention = no-ack).
 *
 *   npx tsx scripts/circuit-microstep-capture.ts [scratchSlot=63] [--extended]
 */

import * as readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import { downloadProject } from '@mcp-midi-control/circuit-tracks/ncs/uploadProject.js';
import {
  META_OFFSETS, DRUM_BLOCK_START, NUM_DRUM_TRACKS, PATTERNS_PER_TRACK,
  STEPS_PER_PATTERN, drumRowBase,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';

const scratchSlot = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 63);
const extended = process.argv.includes('--extended');
const OUT = 'scripts/groove-analysis/_microstep-capture.json';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((r) => rl.question(q, r));

/** Map an absolute file offset to (track,pattern,step) if it lands in a drum rhythm row. */
function locateRhythmByte(off: number): { track: number; pattern: number; step: number } | undefined {
  for (let track = 0; track < NUM_DRUM_TRACKS; track++) {
    for (let pattern = 0; pattern < PATTERNS_PER_TRACK; pattern++) {
      const r0 = drumRowBase(track, pattern) + 96; // rhythm row start
      if (off >= r0 && off < r0 + STEPS_PER_PATTERN) return { track, pattern, step: off - r0 };
    }
  }
  return undefined;
}

const bits = (b: number): string => Array.from({ length: 6 }, (_, k) => ((b >> k) & 1) ? String(k) : '·').join('');
const setTicks = (b: number): number[] => Array.from({ length: 6 }, (_, k) => k).filter((k) => (b >> k) & 1);

async function snapshot(label: string): Promise<Uint8Array> {
  // Fresh connection per download — avoids the stale-handle reboot class (memory).
  const c = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found (powered on? Components closed?).' });
  try {
    const d = await downloadProject(c, scratchSlot);
    if (!d.bytes) throw new Error(`slot ${scratchSlot} empty / unreadable (${d.error ?? 'no bytes'}) — did you SAVE on the device?`);
    console.log(`   ↓ downloaded ${label}: ${d.bytes.length} bytes, crcOk=${d.crcOk}`);
    return d.bytes;
  } finally {
    c.close();
  }
}

interface Capture { label: string; expect?: number; changed: { off: number; from: number; to: number; loc?: string }[] }

async function main(): Promise<void> {
  console.log(`Circuit Tracks micro-step PLACEMENT capture → scratch slot ${scratchSlot} (Project ${scratchSlot + 1}).`);
  console.log('Close Novation Components. Each step: do the device edit, SAVE to the scratch slot, press Enter.\n');

  // The capture plan. CORE reads the whole bit-ordering directly (one single-tick
  // hit per micro position); EXTENDED adds rolls + a combo for additivity.
  const core = [
    { label: 'pos0 — single hit on micro-tick 1 of 6 (the default / leftmost)', expect: 0x01 },
    { label: 'pos1 — single hit on micro-tick 2 of 6 only', expect: 0x02 },
    { label: 'pos2 — single hit on micro-tick 3 of 6 only', expect: 0x04 },
    { label: 'pos3 — single hit on micro-tick 4 of 6 only (the 32nd-note spot)', expect: 0x08 },
    { label: 'pos4 — single hit on micro-tick 5 of 6 only (a 16th-triplet spot)', expect: 0x10 },
    { label: 'pos5 — single hit on micro-tick 6 of 6 only (rightmost)', expect: 0x20 },
    { label: 'buzz — all six micro-ticks on (re-confirm the known anchor)', expect: 0x3f },
  ];
  const ext = [
    { label: 'combo — micro-ticks 1 AND 4 on (a 32nd-note pair in one step)', expect: 0x09 },
    { label: 'roll2 — the device "roll/repeat = 2" control on one hit', expect: undefined },
    { label: 'roll3 — roll/repeat = 3 (tests the un-shipped 0x07 guess)', expect: undefined },
    { label: 'roll4 — roll/repeat = 4', expect: undefined },
  ];
  const plan = extended ? [...core, ...ext] : core;

  console.log('Baseline: author a pattern with ONE plain drum hit (Drum 1, step 1, NO micro-steps).');
  await ask(`Save it to slot ${scratchSlot}, then press Enter… `);
  const baseline = await snapshot('baseline');

  const captures: Capture[] = [];
  for (const item of plan) {
    console.log(`\n► ${item.label}`);
    console.log('   On the SAME single step, set exactly this micro-step state, clear everything else.');
    await ask('   Save to the scratch slot, then press Enter… ');
    let buf: Uint8Array;
    try { buf = await snapshot(item.label); }
    catch (e) { console.log(`   ⚠ ${e instanceof Error ? e.message : e} — skipping.`); continue; }

    const changed: Capture['changed'] = [];
    for (let off = 0; off < buf.length; off++) {
      if (buf[off] !== baseline[off]) {
        const loc = locateRhythmByte(off);
        changed.push({ off, from: baseline[off], to: buf[off], loc: loc ? `Drum${loc.track + 1} pat${loc.pattern + 1} step${loc.step + 1} rhythm` : undefined });
      }
    }
    const rhythmChanges = changed.filter((c) => c.loc);
    if (rhythmChanges.length === 0) {
      console.log('   (no rhythm byte changed vs baseline — re-check the edit; logged anyway)');
    }
    for (const c of rhythmChanges) {
      const ok = item.expect !== undefined ? (c.to === item.expect ? 'MATCH' : `≠ expected 0x${item.expect.toString(16)}`) : 'observed';
      console.log(`   0x${c.off.toString(16)} ${c.loc}: 0x${c.from.toString(16).padStart(2, '0')} → 0x${c.to.toString(16).padStart(2, '0')}  bits[${bits(c.to)}] ticks{${setTicks(c.to).join(',')}}  ${ok}`);
    }
    captures.push({ label: item.label, expect: item.expect, changed });
  }

  // ── Decode summary + hypothesis check ──
  console.log('\n══ DECODE SUMMARY ══');
  let positional = true;
  for (const cap of captures) {
    const r = cap.changed.find((c) => c.loc);
    if (!r) continue;
    if (cap.expect !== undefined && r.to !== cap.expect) positional = false;
    console.log(`  ${cap.label.split(' —')[0].padEnd(7)} → 0x${r.to.toString(16).padStart(2, '0')} (ticks {${setTicks(r.to).join(',')}})${cap.expect !== undefined ? `  expect 0x${cap.expect.toString(16).padStart(2, '0')}` : ''}`);
  }
  console.log(positional
    ? '\n  ✅ Positional 6-bit mask CONFIRMED (bit k = micro-tick k). Unlocks micro-placement authoring:'
    : '\n  ⚠ Bytes DIVERGE from the positional hypothesis — record the real mapping above; do NOT ship the guess.');
  if (positional) {
    console.log('     32nd note → 0x08 (bit 3) ; 16th-triplet offsets → 0x04 & 0x10 (bits 2,4) ; combos are additive.');
  }

  writeFileSync(OUT, JSON.stringify({ scratchSlot, hypothesisPositional: positional, captures }, null, 2));
  console.log(`\nWrote ${OUT}. Next: wire micro_hits to accept 1..63 (placement), add a verify-msg golden, update drumPattern.ts doc + the design doc.`);
  rl.close();
}

main().catch((e) => { console.error('\nERROR:', e instanceof Error ? e.message : e); rl.close(); process.exit(1); });
