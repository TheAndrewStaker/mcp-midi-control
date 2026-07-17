/**
 * BK-055: Axe-Fx III / FM9 / FM3 DSP-usage / CPU-load query probe (read-only).
 *
 * Background (see packages/fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md
 * "Ghidra mining, BK-054" section for the full evidence chain): the v1.4
 * third-party MIDI spec has no documented DSP/CPU-usage query. AxeEdit III's
 * binary DOES contain a `SYSEX_DSP_MESSAGE` string (part of a 23-entry
 * SYSEX_* symbol pool), suggesting a dedicated opcode once existed, but an
 * exhaustive static-analysis sweep (string-offset-index fit, PE relocations,
 * pointer-array scan at every stride, RIP-relative effective-address scan
 * across 1.39M instructions, AND a full grep of the ~140-row async-workflow
 * registry for any DSP/CPU/meter-named workflow) found **zero** code
 * references to that string or any workflow bound to it anywhere in
 * Axe-Edit III.exe. Static analysis is exhausted; binding `SYSEX_DSP_MESSAGE`
 * to a function byte needs a live capture (USBPcap of AxeEdit III's own
 * status-bar DSP meter), not more Ghidra.
 *
 * The GOOD news: a real, wire-confirmed DSP/CPU signal already exists on a
 * DIFFERENT, already-decoded opcode. The gen-3 family's `fn=0x01 sub=0x2E`
 * empty-target reply (the same frame that carries the live routing grid)
 * ALSO carries `cpu_percent` + stereo output meters in fixed low offsets
 * (`packages/fractal-midi/src/gen3/axe-fx-iii/liveMeters.ts`). That decode is
 * cross-validated (ForgeFX's independent FM3 hardware testing + our own FM9
 * capture behavioral oracle) but has never been read back against a live
 * front-panel DSP meter. THIS PROBE'S PRIMARY JOB is exactly that
 * confirmation: one read, compare the printed % against the front panel.
 *
 * As a SECONDARY, clearly separate EXPERIMENTAL job, this probe also tries a
 * short list of standalone candidate function bytes that static analysis
 * left unbound (0x00 with its Ghidra-decoded 0x7F trailer; bare-envelope
 * guesses at 0x04 / 0x08 / 0xFF) purely to see whether the device answers or
 * cleanly NACKs (0x64 MULTIPURPOSE_RESPONSE) any of them; a positive hit
 * would be a real lead, but these are UNVALIDATED GUESSES at the payload
 * shape (unlike the sub=0x2E job, which is a decoded, shipped codec path).
 * Per project policy this experimental job is loudly labeled as such and
 * never conflated with the "decoded" result above.
 *
 * READ-ONLY. Every request here is a query (sub=0x2E empty-target read, or a
 * bare/near-bare envelope with no SET semantics known). Nothing is written,
 * saved, or applied to the device.
 *
 * Usage:
 *   npx tsx scripts/probe-iii-dsp-usage.ts [axe-fx-iii|fm9|fm3] [output.json]
 *
 * Defaults to axe-fx-iii. FM9/FM3 share the same gen-3 codec and sub=0x2E
 * live-meters payload, so the same probe applies verbatim to either.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  connectAxeFxIII,
  connectFM9,
  connectFM3,
  toHex,
  type MidiConnection,
} from '@mcp-midi-control/fractal-gen3/midi.js';
import {
  buildRequestGridLayout,
  parseGen3LiveMeters,
} from 'fractal-midi/gen3/axe-fx-iii';
import { fractalChecksum } from 'fractal-midi/shared';
import { guardAgainstRunningEditors } from './_lib/editor-guard.js';

interface DeviceSpec {
  label: string;
  modelByte: number;
  connect: () => MidiConnection;
}
const DEVICES: Record<string, DeviceSpec> = {
  'axe-fx-iii': { label: 'Axe-Fx III', modelByte: 0x10, connect: connectAxeFxIII },
  fm9: { label: 'FM9', modelByte: 0x12, connect: connectFM9 },
  fm3: { label: 'FM3', modelByte: 0x11, connect: connectFM3 },
};

const deviceKey = (process.argv[2] ?? 'axe-fx-iii').toLowerCase();
const device = DEVICES[deviceKey];
if (!device) {
  console.error(`Usage: probe-iii-dsp-usage <axe-fx-iii|fm9|fm3> [output.json]`);
  console.error(`Unknown device "${process.argv[2] ?? '(none)'}".`);
  process.exit(1);
}
const MODEL = device.modelByte;
const outArg = process.argv[3] ?? `${deviceKey}-dsp-usage-probe-output.json`;
const outPath = path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Bare envelope with no known payload: F0 00 01 74 <model> <fn> <cks> F7. */
function buildBareEnvelope(fn: number): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, MODEL, fn];
  return [...head, fractalChecksum(head), 0xf7];
}

/** The Ghidra-decoded fn=0x00 shape (both host call sites hardcode this exact
 * trailer byte): F0 00 01 74 <model> 00 7F <cks> F7. Real decoded bytes, NOT
 * a guess, but the ROLE of fn=0x00 (what it queries) is still undetermined. */
function buildFn00DecodedShape(): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, MODEL, 0x00, 0x7f];
  return [...head, fractalChecksum(head), 0xf7];
}

async function main(): Promise<void> {
  guardAgainstRunningEditors();
  console.error(`${device.label} DSP-usage probe (READ-ONLY: never writes/saves your presets)`);

  let conn: MidiConnection;
  try {
    conn = device.connect();
  } catch (err) {
    console.error(`\n${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!conn.hasInput) {
    console.error(`\nFound a ${device.label} output port but no input port; the probe needs`);
    console.error('to read replies. Unplug/replug the USB cable and try again.');
    conn.close();
    process.exit(1);
  }

  const inbound: number[][] = [];
  conn.onMessage((bytes) => { if (bytes[0] === 0xf0) inbound.push(bytes); });

  async function sendAndCollect(bytes: number[], windowMs: number): Promise<number[][]> {
    const startLen = inbound.length;
    conn.send(bytes);
    await sleep(windowMs);
    return inbound.slice(startLen);
  }

  const outDir = path.join('samples', 'captured', 'iii-dsp-usage');
  mkdirSync(outDir, { recursive: true });

  // ── PRIMARY (decoded, shipped): sub=0x2E empty-target live-meters read ──
  console.error('\nPRIMARY: fn=0x01 sub=0x2E empty-target read (decoded + shipped: liveMeters.ts)…');
  const gridReq = buildRequestGridLayout(MODEL);
  console.error(`  → ${toHex(gridReq)}`);
  const gridFrames = await sendAndCollect(gridReq, 800);
  let liveMeters: { cpu_percent: number; output_left: number; output_right: number } | undefined;
  let primaryVerdict: string;
  if (gridFrames.length === 0) {
    primaryVerdict = 'NO RESPONSE to sub=0x2E empty-target query. (Some firmwares may need the grid read triggered by a placed preset; try again with a preset loaded.)';
  } else {
    try {
      liveMeters = parseGen3LiveMeters(gridFrames[0]);
      primaryVerdict =
        `cpu_percent=${liveMeters.cpu_percent}%  output_left=${liveMeters.output_left}  ` +
        `output_right=${liveMeters.output_right}. COMPARE cpu_percent AGAINST THE FRONT-PANEL ` +
        `DSP/CPU METER NOW: this is the confirmation this probe exists to get.`;
    } catch (err) {
      primaryVerdict = `Got ${gridFrames.length} frame(s) but failed to parse live meters: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  console.error(`  ${primaryVerdict}`);

  // ── SECONDARY (EXPERIMENTAL / GUESSED): unbound candidate fn-bytes ──
  console.error('\nSECONDARY (EXPERIMENTAL, UNVALIDATED GUESSES, not a decoded wire shape):');
  console.error('probing fn-bytes left unbound by static analysis, watching for ANY reply or a');
  console.error('0x64 MULTIPURPOSE_RESPONSE (which would at least confirm the device parses the');
  console.error('opcode, even if it rejects the payload shape).');

  interface Candidate { label: string; bytes: number[]; note: string }
  const candidates: Candidate[] = [
    {
      label: 'fn=0x00 (Ghidra-decoded shape: bare + 0x7F trailer)',
      bytes: buildFn00DecodedShape(),
      note: 'Bytes are decoded (2 independent AxeEdit III call sites hardcode this exact trailer); the ROLE fn=0x00 plays is still undetermined: a cross-device hint (AM4-Edit\'s own inbound dispatcher labels ITS fn=0x00 "stream-start") suggests a session/connection housekeeping ping, not a data query.',
    },
    {
      label: 'fn=0x04 (bare envelope, GUESS)',
      bytes: buildBareEnvelope(0x04),
      note: 'Host-emitted (1 site); nearby decompile context references a "cab bank" error dialog, so this is more likely cab-library-adjacent than DSP-related. Bare-envelope payload is an unvalidated guess.',
    },
    {
      label: 'fn=0x08 (bare envelope, GUESS)',
      bytes: buildBareEnvelope(0x08),
      note: 'Host-emitted (6 sites, all structurally "send small query, then asynchronously collect a variable-length list"); NOT bound to any named workflow in the async-workflow registry. Bare-envelope payload is an unvalidated guess.',
    },
    {
      label: 'fn=0xFF (bare envelope, GUESS)',
      bytes: buildBareEnvelope(0xff),
      note: 'Host-emitted (1 site); same "collect a list" shape as 0x08, caller shares code with the fn=0x77 preset-dump path (preset/bank enumeration candidate, not DSP). Bare-envelope payload is an unvalidated guess.',
    },
  ];

  const experimental: Array<{ label: string; request: string; note: string; responseCount: number; responseFns: string[]; responses: string[] }> = [];
  for (const c of candidates) {
    const frames = await sendAndCollect(c.bytes, 500);
    const fns = frames.map((f) => (f[5] !== undefined ? `0x${f[5].toString(16)}` : '?'));
    experimental.push({
      label: c.label,
      request: toHex(c.bytes),
      note: c.note,
      responseCount: frames.length,
      responseFns: fns,
      responses: frames.map((f) => toHex(f)),
    });
    console.error(`  ${c.label.padEnd(52)} → ${frames.length ? `${frames.length} reply frame(s) [fn ${fns.join(',')}]` : 'no response'}`);
    await sleep(150);
  }

  const report = {
    probe: 'probe-iii-dsp-usage',
    device: device.label,
    modelByte: MODEL,
    capturedAt: new Date().toISOString(),
    note: 'READ-ONLY. PRIMARY = decoded/shipped sub=0x2E live-meters read (confirm-only ask). SECONDARY = experimental unbound-fn-byte guesses, clearly non-decoded.',
    primary: {
      request: toHex(gridReq),
      responseCount: gridFrames.length,
      responses: gridFrames.map((f) => toHex(f)),
      liveMeters,
      verdict: primaryVerdict,
    },
    secondaryExperimental: experimental,
  };
  writeFileSync(outPath, JSON.stringify(report, undefined, 2));
  conn.close();

  console.error(`\n✓ Wrote ${outPath}`);
  console.error('Please report: (1) did cpu_percent above match the front-panel DSP meter, and');
  console.error('(2) did ANY of the secondary experimental fn-bytes get a reply (even a 0x64 NACK)?');
  console.error('Please send/email this JSON file back. Thank you!');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nProbe failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
