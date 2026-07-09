/**
 * Isolation probe: does Program Change on a synth channel actually SELECT a patch
 * on the Circuit Tracks (loading it from Flash into the working buffer), and does
 * the Current Patch Dump reflect it?
 *
 * The v3 guide (p.15) says PC on a synth channel loads the patch from Flash. The
 * HW-CIRCUIT-002 save probe found a PC did NOT change the dumped patch name — this
 * isolates that, independent of any save, with generous timing to rule out races.
 *
 *   npx tsx scripts/probe-circuit-pc-select.ts [synth=1]
 *
 * Reads only — sends CC + Program Change (no Flash writes). Non-destructive.
 */

import { connect } from '@mcp-midi-control/core/midi/transport.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { buildProgramChange, buildBankSelectMSB, buildBankSelectLSB } from '@mcp-midi-control/core/midi/messages.js';
import { readCurrentPatch } from '@mcp-midi-control/circuit-tracks/codec/patchTransfer.js';
import { OFFSET_BY_PARAM } from '@mcp-midi-control/circuit-tracks/codec/patchLayout.js';
import { decodePatchName } from '@mcp-midi-control/circuit-tracks/codec/blob.js';
import { paramWire } from '@mcp-midi-control/circuit-tracks/codec/live.js';
import { findParam } from '@mcp-midi-control/circuit-tracks/params.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FREQ_OFFSET = OFFSET_BY_PARAM.get('filter.frequency')!;
const FREQ = findParam('filter', 'frequency')!;
const synth = Number(process.argv[2] ?? 1);
const loc = (synth - 1) as 0 | 1;
const pcCh = synth - 1;

async function dump(conn: MidiConnection): Promise<{ freq: number; name: string }> {
  const r = await readCurrentPatch(conn, loc, {});
  if (!r.ok || !r.body) throw new Error(`dump failed: ${r.error ?? 'no reply'}`);
  return { freq: r.body[FREQ_OFFSET] & 0x7f, name: decodePatchName(r.body) };
}

async function main(): Promise<void> {
  console.log(`\n=== Circuit PC-patch-select isolation (Synth ${synth}, MIDI ch${synth}) ===\n`);
  const conn = connect({ needles: ['circuit'], notFoundLeadIn: 'Circuit not found (powered? Components closed?).' });
  if (!conn.hasInput) { console.error('FAIL: no MIDI input.'); conn.close(); process.exit(1); }
  try {
    const base = await dump(conn);
    console.log(`baseline: freq=${base.freq}, name="${base.name}"`);

    // A. Dump freshness: does a CC edit show up in the very next dump?
    const testFreq = base.freq >= 64 ? base.freq - 30 : base.freq + 30;
    conn.send(paramWire(FREQ, testFreq));
    await sleep(80);
    const afterCc = await dump(conn);
    console.log(`\n[A] dump freshness (CC): set freq ${testFreq} → dump reads ${afterCc.freq} ${afterCc.freq === testFreq ? '✓ FRESH (dump reflects live edits)' : '✗ STALE (dump did NOT update — read path may be caching frames)'}`);

    // B. PC patch-select: step through distinctive factory slots, generous settle.
    // Known factory names from the captured pack: 0 Random Decay, 1 BassOSC, 2 Bassix,
    // 4 Dirty Organ, 32 Saw Pad. If the dump name tracks the PC, select works.
    console.log(`\n[B] PC patch-select (300ms settle each). Expected names in parens if PC works:`);
    const slots = [
      { n: 1, expect: 'BassOSC' }, { n: 2, expect: 'Bassix' },
      { n: 4, expect: 'Dirty Organ' }, { n: 32, expect: 'Saw Pad' }, { n: 0, expect: 'Random Decay' },
    ];
    let changed = 0;
    let prevName = afterCc.name;
    for (const s of slots) {
      conn.send(buildProgramChange(pcCh, s.n));
      await sleep(300);
      const d = await dump(conn);
      const moved = d.name !== prevName;
      const matched = d.name === s.expect;
      console.log(`   PC ${String(s.n).padStart(2)} (expect "${s.expect}") → freq=${d.freq}, name="${d.name}" ${matched ? '✓ matches' : moved ? '~ changed but unexpected name' : '✗ unchanged'}`);
      if (moved) changed++;
      prevName = d.name;
    }

    // C. Bank Select experiment: the 128 patches are "4 pages of 32", so try Bank
    // Select (MSB and LSB variants) before a PC, looking for the dump name to move.
    console.log(`\n[C] Bank Select + PC experiment (does a bank prefix unlock selection?):`);
    const bankTries = [
      { msb: 0, lsb: 0, pc: 1, label: 'LSB0 PC1' },
      { msb: 0, lsb: 1, pc: 1, label: 'LSB1 PC1 (page 2?)' },
      { msb: 0, lsb: 2, pc: 0, label: 'LSB2 PC0 (page 3?)' },
      { msb: 1, lsb: 0, pc: 1, label: 'MSB1 PC1' },
      { msb: 0, lsb: 0, pc: 32, label: 'PC32 (no bank, page-2 index?)' },
    ];
    let bankChanged = 0;
    let bn = prevName;
    for (const b of bankTries) {
      conn.send(buildBankSelectMSB(pcCh, b.msb));
      conn.send(buildBankSelectLSB(pcCh, b.lsb));
      await sleep(30);
      conn.send(buildProgramChange(pcCh, b.pc));
      await sleep(300);
      const d = await dump(conn);
      const moved = d.name !== bn;
      console.log(`   ${b.label.padEnd(28)} → name="${d.name}" ${moved ? '✓ CHANGED' : '✗ unchanged'}`);
      if (moved) bankChanged++;
      bn = d.name;
    }
    console.log(`   → Bank Select ${bankChanged > 0 ? `unlocked selection (${bankChanged} changes) — pursue this addressing` : 'did NOT help — patch-select is not reachable this way'}.`);

    console.log('');
    if (changed === 0 && bankChanged === 0) {
      console.log(`VERDICT: ✗ Program Change on ch${synth} does NOT select patches (the dump name never changed).`);
      console.log(`         Either PC-patch-select is disabled/unsupported over MIDI on this unit, or it needs a`);
      console.log(`         Bank Select / a different message. This is why the save reload test can't confirm a`);
      console.log(`         write — we have no MIDI way to force a Flash reload. Next: try Bank Select MSB/LSB before`);
      console.log(`         the PC, and check Setup View for a patch-change Rx toggle; capture what Components sends`);
      console.log(`         when it changes a patch.`);
    } else if (changed >= 3) {
      console.log(`VERDICT: ✓ Program Change selects patches (dump tracked ${changed}/${slots.length} slots).`);
      console.log(`         The reload-based save test is valid; the earlier FAIL means the Flash WRITE is dropped.`);
    } else {
      console.log(`VERDICT: ~ PARTIAL — PC changed the patch ${changed}/${slots.length} times. Inconsistent; investigate timing / bank.`);
    }
  } catch (err) {
    console.error(`\nERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    conn.close();
  }
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
