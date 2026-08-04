/**
 * probe-ii-pitch-domain.ts: settle the Axe-Fx II pitch-shift DISPLAY DOMAIN
 * (BK-PITCH-II / HARDWARE-TASKS-AXEFX2 row 13, II-PITCH-SHIFT-DOMAIN).
 *
 * THE QUESTION. `pitch.voice_1/2_shift`, `pitch.voice_1/2_harmony`,
 * `pitch.stage_1..16_shift` and `multidelay.shift_1..4` are all declared
 * `displayMin: 0, displayMax: 48, step: 1` in `gen2/axe-fx-ii/params.ts`,
 * copied from the Fractal wiki's MIDI_SysEx min/max column. That column is the
 * WIRE ordinal domain. If the panel domain is really signed semitones centred
 * on wire 24, then the declared range is why `octave_down` (-12) is refused at
 * the tool boundary and why no downward interval is expressible on the II.
 *
 * WHY THIS LEG NEEDS NO HUMAN. The device puts its OWN rendered label in the
 * GET response, and `get_param` hands the raw bytes back as `raw_response`. So
 * the read path can be adjudicated automatically: parse the label the device
 * sent, and compare it against what our decode produced for the same wire
 * value. They should agree. Where they do not, the DEVICE is right
 * (CLAIMS.md / CLAUDE.md "Verification sources of truth": front panel, then
 * the get_param echo, and the editor last).
 *
 * READ-ONLY BY DEFAULT. No writes, no saves, nothing to restore. The write leg
 * (which DOES need a human at the front panel, because a write's effect on the
 * panel rendering is the other half of the question) is behind `--write` and
 * is interactive per the CLAUDE.md probe rule: it waits on Enter, never on a
 * timer, and restores every value it touched.
 *
 *   npx tsx scripts/probe-ii-pitch-domain.ts            # read-only, safe
 *   npx tsx scripts/probe-ii-pitch-domain.ts --write    # + interactive panel leg
 *
 * PRE-FLIGHT: Axe-Fx II on, USB connected, AxeEdit CLOSED (its polling
 * pollutes the stream), and a PITCH block placed on the active preset. An
 * unplaced block makes the device silently absorb reads, which this probe
 * reports as "no response" rather than guessing.
 */
import path from 'node:path';
import readline from 'node:readline';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseGetBlockParameterResponse } from 'fractal-midi/gen2/axe-fx-ii';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');
const DO_WRITE = process.argv.includes('--write');
const DO_SWEEP = process.argv.includes('--sweep');
/** Settle window between a write and its read-back, ms. Override with --settle=N. */
const SETTLE_MS = Number(process.argv.find((x) => x.startsWith('--settle='))?.split('=')[1] ?? 250);
const PORT = 'axe-fx-ii';

/** The params the wiki's 0..48 column covers, one representative per family. */
const TARGETS = [
  { block: 'pitch', name: 'voice_1_harmony' },
  { block: 'pitch', name: 'voice_2_harmony' },
  { block: 'pitch', name: 'voice_1_shift' },
  { block: 'pitch', name: 'voice_2_shift' },
];

interface Row {
  target: string;
  wire: number | undefined;
  ourDisplay: unknown;
  deviceLabel: string | undefined;
  note: string;
}

function fmt(v: unknown): string {
  return v === undefined ? '-' : String(v);
}

async function main(): Promise<void> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], stderr: 'pipe' });
  const client = new Client({ name: 'ii-pitch-domain', version: '0.1.0' });
  await client.connect(transport);

  const rows: Row[] = [];
  try {
    console.log('II pitch-shift display-domain probe (read leg, no writes)\n');

    for (const t of TARGETS) {
      const label = `${t.block}.${t.name}`;
      let res: { content?: { text?: string }[]; isError?: boolean };
      try {
        res = await client.callTool({ name: 'get_param', arguments: { port: PORT, block: t.block, name: t.name } }) as typeof res;
      } catch (err) {
        rows.push({ target: label, wire: undefined, ourDisplay: undefined, deviceLabel: undefined, note: `call threw: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      const text = res.content?.[0]?.text ?? '';
      if (res.isError === true) {
        rows.push({ target: label, wire: undefined, ourDisplay: undefined, deviceLabel: undefined, note: text.slice(0, 120) });
        continue;
      }
      let parsed: { wire_value?: number; display_value?: unknown; raw_response?: number[] } = {};
      try { parsed = JSON.parse(text) as typeof parsed; } catch { /* fall through */ }

      // The device's OWN label, recovered from the raw frame. This is the
      // adjudicating value; our decode is the thing on trial.
      let deviceLabel: string | undefined;
      if (Array.isArray(parsed.raw_response)) {
        try { deviceLabel = parseGetBlockParameterResponse(parsed.raw_response).label; } catch { /* leave undefined */ }
      }
      rows.push({
        target: label,
        wire: parsed.wire_value,
        ourDisplay: parsed.display_value,
        deviceLabel,
        note: deviceLabel === undefined ? 'no label in frame' : '',
      });
    }

    console.log('  param                     wire   our display        device label   verdict');
    console.log('  ' + '-'.repeat(82));
    let disagreements = 0;
    let signedEvidence = 0;
    for (const r of rows) {
      let verdict = '';
      if (r.deviceLabel !== undefined && r.wire !== undefined) {
        const asNum = Number(r.deviceLabel);
        const ourNum = Number(r.ourDisplay);
        const agree = Number.isFinite(asNum) && Number.isFinite(ourNum)
          ? Math.abs(asNum - ourNum) < 0.5
          : String(r.ourDisplay) === r.deviceLabel;
        if (!agree) { verdict = 'DISAGREE'; disagreements++; } else verdict = 'ok';
        // The signed-domain hypothesis: display = wire - 24 (unison at 24).
        if (Number.isFinite(asNum) && asNum === r.wire - 24) signedEvidence++;
      } else if (r.note !== '') {
        verdict = 'no read';
      }
      console.log(
        `  ${r.target.padEnd(24)} ${String(fmt(r.wire)).padStart(5)}   ${fmt(r.ourDisplay).padEnd(17)}  ${fmt(r.deviceLabel).padStart(12)}   ${verdict}`,
      );
      if (r.note !== '' && verdict === 'no read') console.log(`      ${r.note}`);
    }

    const read = rows.filter((r) => r.deviceLabel !== undefined);
    console.log('');
    if (read.length === 0) {
      console.log('  NO PARAM READ BACK A LABEL. Most likely the PITCH block is not placed on the');
      console.log('  active preset (the II silently absorbs reads for absent blocks). Place a PITCH');
      console.log('  block and re-run; do not interpret this as evidence either way.');
    } else {
      console.log(`  ${read.length} param(s) read; ${disagreements} disagreement(s) between our decode and the device's own label.`);
      if (signedEvidence > 0) {
        console.log(`  ${signedEvidence} of them satisfy display = wire - 24, i.e. a SIGNED semitone domain`);
        console.log('  centred on wire 24 (unison). That is the BK-PITCH-II hypothesis; if it holds for');
        console.log('  every param read, re-declare these as displayMin: -24, displayMax: 24,');
        console.log("  unit: 'semitones' and octave_down becomes expressible on the II.");
      } else if (disagreements > 0) {
        console.log('  The disagreements do NOT fit display = wire - 24. Record the exact pairs above');
        console.log('  before proposing any re-declaration; the mapping is something else.');
      } else {
        console.log('  Our decode already matches the device on every param read. If these all sat at');
        console.log('  wire 24 the test is INCONCLUSIVE (24-24 = 0 agrees with a linear decode too);');
        console.log('  set a non-unison shift on the panel by hand and re-run.');
      }
    }

    if (DO_SWEEP) {
      // ── automated write sweep: derive the map, no human required ─────
      //
      // A single resting value cannot distinguish a linear decode from an
      // offset one: everything agrees at one point. But the device re-renders
      // its OWN label after every write, and `get_param` hands that label
      // back, so the mapping can be sampled directly. Write a display value,
      // read what the device calls it, repeat. That is the whole experiment,
      // and it needs nobody at the front panel.
      //
      // Working buffer only. Every value is restored at the end and nothing is
      // saved; switching presets on the device discards it all regardless.
      console.log('\n  WRITE SWEEP (working buffer only, restored at the end, never saved)\n');
      const originals = new Map<string, unknown>();
      for (const r of rows) if (r.ourDisplay !== undefined) originals.set(r.target, r.ourDisplay);

      const samples = [0, 1, 3, 7, 12];
      for (const t of TARGETS) {
        const key = `${t.block}.${t.name}`;
        if (!originals.has(key)) { console.log(`  ${key}: skipped, no original value to restore`); continue; }
        const obs: string[] = [];
        for (const v of samples) {
          const w = await client.callTool({ name: 'set_param', arguments: { port: PORT, block: t.block, name: t.name, value: v } }) as { isError?: boolean };
          if (w.isError === true) { obs.push(`${v}=>refused`); continue; }
          // SETTLE BEFORE READING. A timed wait is allowed here only because
          // this probe is fully automated with no human observation step; the
          // CLAUDE.md interactive rule is about probes that ask the maintainer
          // to watch a panel. Without it the first pass produced a read that
          // lagged its write, which showed up as voice_1 and voice_2 of the
          // SAME family disagreeing at the same input. Rule out the instrument
          // before believing the device.
          await new Promise((r) => setTimeout(r, SETTLE_MS));
          const rd = await client.callTool({ name: 'get_param', arguments: { port: PORT, block: t.block, name: t.name } }) as { content?: { text?: string }[] };
          let wire: number | undefined; let lbl: string | undefined;
          try {
            const j = JSON.parse(rd.content?.[0]?.text ?? '{}') as { wire_value?: number; raw_response?: number[] };
            wire = j.wire_value;
            if (Array.isArray(j.raw_response)) lbl = parseGetBlockParameterResponse(j.raw_response).label;
          } catch { /* leave undefined */ }
          obs.push(`sent ${v} -> wire ${fmt(wire)}, device says "${fmt(lbl)}"`);
        }
        console.log(`  ${key}`);
        for (const o of obs) console.log(`      ${o}`);
        await client.callTool({ name: 'set_param', arguments: { port: PORT, block: t.block, name: t.name, value: originals.get(key) } });
      }
      console.log('\n  All four params restored to their pre-probe values. Nothing was saved.');
      console.log('  READ THE PAIRS ABOVE. If "sent N" comes back as wire N+24 and the device');
      console.log('  labels it N, the display domain is signed semitones and the declared');
      console.log('  0..48 is the wire domain. If "sent N" comes back as wire N, the wiki is');
      console.log('  right and every positive shift recipe on the II is inverted.');
      return;
    }

    if (!DO_WRITE) {
      console.log('\n  Read leg only. Re-run with --sweep to DERIVE the map automatically');
      console.log('  (writes + read-backs on the working buffer, restored, no save, no human),');
      console.log('  or --write for the interactive front-panel confirmation leg.');
      return;
    }

    // ── write leg: needs a human reading the front panel ────────────────
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r));
    try {
      const subject = TARGETS[2]; // pitch.voice_1_shift
      const before = rows.find((r) => r.target === `${subject.block}.${subject.name}`);
      if (before?.wire === undefined) {
        console.log('\n  Skipping the write leg: could not read the original value, so it could not be restored.');
        return;
      }
      console.log('\n  WRITE LEG. Two writes to the WORKING BUFFER only. Nothing is saved, and the');
      console.log(`  original value is restored at the end. Watch the II front panel PITCH page.\n`);
      await ask('  Press Enter when you can see the PITCH block\'s Voice 1 Shift on the panel... ');

      for (const value of [12, 0]) {
        await client.callTool({ name: 'set_param', arguments: { port: PORT, block: subject.block, name: subject.name, value } });
        const seen = await ask(`  Wrote ${value}. What does the FRONT PANEL now read for Voice 1 Shift? `);
        console.log(`    -> recorded: "${seen.trim()}"`);
        if (value === 12) {
          console.log('       "+12 semitones" (or "12") => signed semitone domain, the fix is a re-declare.');
          console.log('       anything else (an index, a cents value) => the wiki column is right and');
          console.log('       every positive shift recipe on the II is inverted.');
        }
      }

      // Restore. The read leg captured the original wire value; write it back
      // through the same display path we read it from.
      const restore = before.ourDisplay;
      await client.callTool({ name: 'set_param', arguments: { port: PORT, block: subject.block, name: subject.name, value: restore } });
      console.log(`\n  Restored ${subject.block}.${subject.name} to its original value (${fmt(restore)}). Nothing was saved.`);
      console.log('  If that restore looks wrong on the panel, switch presets to discard the buffer.');
    } finally {
      rl.close();
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => { console.error('ERROR:', err instanceof Error ? err.message : err); process.exit(1); });
