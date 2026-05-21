/**
 * Axe-Fx II per-block enum dump probe (fn 0x28 SYSEX_GET_PARAM_STRINGS).
 *
 * Generalizes the one-off Session 104 probe (which only hit AMP 1 +
 * paramId=0) into a per-block, per-enum-paramId sweep. For every
 * registered `select`-type parameter in the fractal-midi II catalog,
 * fire fn 0x28 against the first instance of that block and capture
 * the device-emitted enum string table. One run = full Rosetta-stone
 * refresh of II enum vocabulary, hardware-validated for the connected
 * firmware revision.
 *
 * # Why this matters
 *
 * The catalog `KNOWN_PARAMS` enum strings come from the Fractal Audio
 * Wiki MIDI_SysEx page, which is community-RE and carries
 * transcription errors (Session 107 surfaced 4 in `AMP_EFFECT_TYPE_VALUES`
 * alone: CORNCOB vs CORNFED, CA vs CAROL-ANN, casing slips, dropped
 * suffixes). The device's emitted labels are the truth — agents that
 * propose the device's real vocabulary should not have their writes
 * rejected by stale wiki strings. fn 0x28 closes this gap entirely.
 *
 * # Output
 *
 * - `samples/captured/probe-axefx2-enum-dump.syx` — raw inbound bytes
 *   concatenated across all probes.
 * - `samples/captured/probe-axefx2-enum-dump-findings.md` — per-probe
 *   verdict (responsive / silent / truncated), decoded enum strings,
 *   and a diff against the current catalog.
 *
 * # Limitations
 *
 * - **node-midi truncates inbound SysEx at 2048 bytes** on Windows
 *   (see `node_modules/midi/CHANGELOG.md`). Large enum tables (AMP
 *   amp.type has 259 entries → ~3500 bytes) are silently cut off
 *   mid-string. Until we work around this (custom rtmidi bindings or
 *   the device chunking response into multiple ≤2048B frames), each
 *   probe captures only the first ~150 strings. The findings clearly
 *   flag truncated frames.
 * - **Requires a placed block** for fn 0x28 to return anything useful.
 *   Most blocks expose enum params even when not placed; the script
 *   picks the canonical instance-1 effect IDs and assumes the device
 *   responds whether the block is in the active preset or not. This
 *   is the same assumption the fn 0x28 AMP 1 probe verified.
 *
 * # Prereqs
 *
 * - Axe-Fx II XL+ powered on, USB connected.
 * - **Close AxeEdit** — its polling pollutes the inbound stream.
 *
 * # Run
 *
 * ```
 * npx tsx scripts/_research/probe-axefx2-enum-dump.ts                # all enum params
 * npx tsx scripts/_research/probe-axefx2-enum-dump.ts --block amp    # one block
 * npx tsx scripts/_research/probe-axefx2-enum-dump.ts --paramid 0    # one paramId across blocks
 * ```
 */

import midi from 'midi';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { KNOWN_PARAMS, AXE_FX_II_BLOCKS } from 'fractal-midi/axe-fx-ii';
import type { AxeFxIIParam } from 'fractal-midi/axe-fx-ii';

const AXE_FX_II_MODEL = 0x07;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const NODEMIDI_FRAME_CAP = 2048;

function fractalChecksum(bytes: number[]): number {
  return bytes.reduce((acc, b) => acc ^ b, 0) & 0x7f;
}

function buildEnvelope(fn: number, payload: number[] = []): number[] {
  const head = [SYSEX_START, ...FRACTAL_MFR, AXE_FX_II_MODEL, fn, ...payload];
  return [...head, fractalChecksum(head), SYSEX_END];
}

function encode14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}

function toHex(bytes: readonly number[]): string {
  return bytes
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function findPort(io: midi.Input | midi.Output, needles: string[]): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i);
    for (const n of needles) {
      if (name.toLowerCase().includes(n.toLowerCase())) return i;
    }
  }
  return -1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Decode the NULL-delimited 7-bit ASCII payload of a fn 0x28 response.
function decodeEnumStrings(frameBytes: number[]): {
  strings: string[];
  trailingPartial: string;
  truncated: boolean;
} {
  if (frameBytes.length < 8) {
    return { strings: [], trailingPartial: '', truncated: false };
  }
  const lastByte = frameBytes[frameBytes.length - 1];
  const terminated = lastByte === 0xf7;
  // Payload: skip 6-byte fractal header; if terminated, drop cksum + F7.
  const payload = terminated
    ? frameBytes.slice(6, frameBytes.length - 2)
    : frameBytes.slice(6);
  const strings: string[] = [];
  let cur: number[] = [];
  for (const b of payload) {
    if (b === 0x00) {
      strings.push(String.fromCharCode(...cur));
      cur = [];
    } else {
      cur.push(b);
    }
  }
  return {
    strings,
    trailingPartial: String.fromCharCode(...cur),
    truncated: !terminated || frameBytes.length >= NODEMIDI_FRAME_CAP,
  };
}

interface EnumProbe {
  readonly block: string;
  readonly paramId: number;
  readonly name: string;
  readonly groupCode: string;
  readonly effectId: number;
  readonly expectedCount: number;
  readonly catalogStrings: ReadonlyArray<string>;
}

function buildProbeList(filters: {
  block?: string;
  paramId?: number;
}): EnumProbe[] {
  // Group catalog by groupCode → pick first instance from AXE_FX_II_BLOCKS.
  const firstInstanceByGroup = new Map<string, number>();
  for (const b of AXE_FX_II_BLOCKS) {
    if (!firstInstanceByGroup.has(b.groupCode)) {
      firstInstanceByGroup.set(b.groupCode, b.id);
    }
  }

  const probes: EnumProbe[] = [];
  const seen = new Set<string>();
  for (const p of Object.values(KNOWN_PARAMS) as ReadonlyArray<AxeFxIIParam>) {
    if (p.controlType !== 'select') continue;
    if (!p.enumValues || Object.keys(p.enumValues).length === 0) continue;
    if (filters.block && p.block !== filters.block) continue;
    if (filters.paramId !== undefined && p.paramId !== filters.paramId) continue;
    const effectId = firstInstanceByGroup.get(p.groupCode);
    if (effectId === undefined) continue;
    const key = `${p.block}.${p.paramId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const catalogStrings = Object.entries(p.enumValues)
      .map(([k, v]) => [Number(k), v] as [number, string])
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v);
    probes.push({
      block: p.block,
      paramId: p.paramId,
      name: p.name,
      groupCode: p.groupCode,
      effectId,
      expectedCount: catalogStrings.length,
      catalogStrings,
    });
  }
  return probes;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filterBlock = args[args.indexOf('--block') + 1] || undefined;
  const filterPidStr = args[args.indexOf('--paramid') + 1];
  const filterPid =
    filterPidStr && !filterPidStr.startsWith('--')
      ? Number(filterPidStr)
      : undefined;

  const probes = buildProbeList({ block: filterBlock, paramId: filterPid });
  console.log(`Axe-Fx II enum-dump probe (fn 0x28 SYSEX_GET_PARAM_STRINGS)`);
  console.log(`═══════════════════════════════════════════════════════════`);
  console.log(`Probes queued: ${probes.length}`);
  if (filterBlock) console.log(`  filter: block=${filterBlock}`);
  if (filterPid !== undefined) console.log(`  filter: paramId=${filterPid}`);
  if (probes.length === 0) {
    console.error('No matching enum params — check filters.');
    process.exit(1);
  }

  const input = new midi.Input();
  const output = new midi.Output();
  const needles = ['Axe-Fx II', 'AxeFxII', 'AXE-FX II', 'XL+'];
  const outIdx = findPort(output, needles);
  const inIdx = findPort(input, needles);
  if (outIdx < 0 || inIdx < 0) {
    console.error('ERROR: Axe-Fx II port not found. Is the device connected?');
    process.exit(1);
  }
  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  const collected: number[][] = [];
  input.on('message', (_dt, bytes) => {
    if (bytes[0] === 0xf0) collected.push(bytes.slice());
  });
  input.openPort(inIdx);
  console.log(`Ports open. Pre-cleaning inbound queue ...\n`);
  await sleep(500);
  collected.length = 0;

  // Handshake.
  output.sendMessage(buildEnvelope(0x08));
  await sleep(400);
  collected.length = 0;

  interface ProbeResult {
    probe: EnumProbe;
    request: number[];
    inbound: number[][];
    decodedStrings: string[];
    truncated: boolean;
    trailingPartial: string;
    matchCount: number;
    mismatchList: Array<{ idx: number; hw: string; cat: string | undefined }>;
  }

  const results: ProbeResult[] = [];
  for (let pIdx = 0; pIdx < probes.length; pIdx++) {
    const probe = probes[pIdx]!;
    const request = buildEnvelope(0x28, [
      ...encode14(probe.effectId),
      ...encode14(probe.paramId),
    ]);
    const before = collected.length;
    output.sendMessage(request);
    // Listen window scales loosely with expected enum count.
    const listenMs = Math.min(
      4000,
      Math.max(500, probe.expectedCount * 15),
    );
    await sleep(listenMs);
    const inbound = collected.slice(before);

    // Find the fn 0x28 response frame (filter out fn 0x10 acks etc).
    const responseFrame =
      inbound.find((f) => f.length >= 6 && f[5] === 0x28) ??
      inbound[0] ??
      [];
    const { strings, trailingPartial, truncated } = decodeEnumStrings(
      responseFrame,
    );

    // Compare against catalog.
    //
    // Session 114 (2026-05-22): display-first match. The Axe-Fx II
    // pads several single-letter / short labels with trailing
    // whitespace ("A " for chromatic notes, "NONE " for delay.tempo
    // idx 0, "AUTO: " for input.input_z idx 0) — purely display-layer
    // padding the firmware emits to align fixed-width readouts. Our
    // catalog stores the trimmed form (the "display-first" string a
    // musician reads); the dispatcher trims when matching agent input.
    // Treat `hw.trimEnd() === cat` as a match so this probe stops
    // surfacing whitespace-only diffs as catalog gaps. Future
    // catalog-missing entries still surface (leading/embedded text
    // differs) and truncated frames still flag in the headline.
    let exact = 0;
    const mismatches: ProbeResult['mismatchList'] = [];
    for (let i = 0; i < strings.length; i++) {
      const hw = strings[i]!;
      const cat = probe.catalogStrings[i];
      if (cat === hw || (cat !== undefined && hw.trimEnd() === cat)) exact++;
      else mismatches.push({ idx: i, hw, cat });
    }

    const tag = truncated ? '⚠️ TRUNC' : '✅';
    console.log(
      `[${(pIdx + 1).toString().padStart(3)}/${probes.length}] ${tag} ${probe.block}.${probe.name} ` +
        `(effId=${probe.effectId} paramId=${probe.paramId}) → ` +
        `${strings.length}/${probe.expectedCount} captured, ` +
        `${exact} match, ${mismatches.length} diff` +
        (truncated ? ` (last partial="${trailingPartial}")` : ''),
    );

    results.push({
      probe,
      request,
      inbound,
      decodedStrings: strings,
      truncated,
      trailingPartial,
      matchCount: exact,
      mismatchList: mismatches,
    });
    await sleep(150);
  }

  // ── Save artifacts ───────────────────────────────────────────────
  mkdirSync('samples/captured', { recursive: true });
  const concatBytes = results.flatMap((r) => [
    ...r.request,
    ...r.inbound.flat(),
  ]);
  writeFileSync(
    'samples/captured/probe-axefx2-enum-dump.syx',
    Uint8Array.from(concatBytes),
  );

  const md: string[] = [
    `# Axe-Fx II enum-dump probe — findings`,
    ``,
    `> Auto-generated by \`scripts/_research/probe-axefx2-enum-dump.ts\``,
    `> at ${new Date().toISOString()}`,
    ``,
    `Probed ${results.length} enum params across all blocks.`,
    ``,
    `## Headline diff vs. fractal-midi catalog`,
    ``,
    `| Block | Param | Captured | Catalog | Matches | Mismatches | Truncated |`,
    `|---|---|---|---|---|---|---|`,
  ];
  for (const r of results) {
    md.push(
      `| ${r.probe.block} | ${r.probe.name} | ${r.decodedStrings.length} | ${r.probe.expectedCount} | ${r.matchCount} | ${r.mismatchList.length} | ${r.truncated ? '⚠️' : ''} |`,
    );
  }

  md.push('', '## Per-probe details', '');
  for (const r of results) {
    md.push(
      `### ${r.probe.block}.${r.probe.name} (effId=${r.probe.effectId}, paramId=${r.probe.paramId})`,
      '',
    );
    md.push(
      `- Sent: \`${toHex(r.request)}\``,
      `- Response frames: ${r.inbound.length}`,
      `- Decoded strings: ${r.decodedStrings.length} / catalog ${r.probe.expectedCount}`,
      `- Frame truncated: ${r.truncated ? `yes (partial = "${r.trailingPartial}")` : 'no'}`,
      `- Display-equal matches: ${r.matchCount} (treats trailing whitespace as equivalent)`,
      `- Mismatches: ${r.mismatchList.length}`,
      '',
    );
    if (r.mismatchList.length > 0) {
      md.push(`**Mismatches:**`, '', `| idx | hardware | catalog |`, `|---|---|---|`);
      for (const m of r.mismatchList) {
        md.push(`| ${m.idx} | ${m.hw} | ${m.cat ?? '(absent)'} |`);
      }
      md.push('');
    }
  }

  writeFileSync(
    'samples/captured/probe-axefx2-enum-dump-findings.md',
    md.join('\n'),
  );

  console.log(
    `\nWrote findings to samples/captured/probe-axefx2-enum-dump-findings.md`,
  );
  console.log(
    `Wrote raw bytes to samples/captured/probe-axefx2-enum-dump.syx`,
  );

  // Quick summary.
  const totalCaptured = results.reduce(
    (a, r) => a + r.decodedStrings.length,
    0,
  );
  const totalExact = results.reduce((a, r) => a + r.matchCount, 0);
  const totalDiff = results.reduce((a, r) => a + r.mismatchList.length, 0);
  const truncCount = results.filter((r) => r.truncated).length;
  console.log(
    `\nTotals: ${totalCaptured} strings captured, ${totalExact} display-equal ` +
      `matches (trim-tolerant), ${totalDiff} mismatches, ${truncCount}/${results.length} ` +
      `probes hit the 2048B frame cap.`,
  );

  input.closePort();
  output.closePort();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
