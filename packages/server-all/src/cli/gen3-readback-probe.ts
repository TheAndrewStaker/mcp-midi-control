#!/usr/bin/env node
/**
 * Gen-3 Fractal read-back probe — a READ-ONLY, tester-runnable diagnostic
 * for the FM9, FM3, and Axe-Fx III (one codec family, model byte aside).
 *
 * Ships in the release so an owner can confirm our gen-3 read path on real
 * hardware in one step (via `installer/<device>-probe.cmd`) — no Wireshark,
 * no editor, no menu clicking. It connects over USB MIDI, polls the active
 * preset's blocks, and writes a JSON file to email back.
 *
 * Two jobs, both READ-ONLY (this probe NEVER sends a SET / store / save —
 * only bulk-read polls and a value GET, neither of which mutates device
 * state; consistent with the project's probe-is-read-only policy):
 *
 *   JOB 1 — verify the read path. For each addressable block we send the
 *     fn=0x1F block bulk-read poll and collect the 0x74/0x75/0x76
 *     state-broadcast burst it triggers (~1 ms later).
 *     `assembleGen3BlockBulkRead` turns the burst into a paramId-indexed
 *     value array. First broad hardware confirmation of get_param /
 *     get_preset across many blocks (today only reverb is spot-checked).
 *
 *   JOB 2 — a GET-response read-back spot-check. We fire the canonical
 *     fn=0x01 sub=0x09 GET at Reverb 1's TYPE param (effectId 66; paramId
 *     resolved from the device-true catalog — 0 on FM3/III, 10 on FM9)
 *     and log what comes back. RESOLVED (2026-06-08): there is NO separate
 *     "raw-id" space — the SET value is float32(read-ordinal) @ pos 12, and
 *     the read roster ordinal IS the set-by-name value. "Medium Spring" =
 *     ordinal 16 (the old "raw 524" was a pos-15 packValue16 misread). So this
 *     job now just confirms the GET response carries the ordinal; the primary
 *     read path is the fn=0x1f broadcast.
 *
 * Usage:
 *   node dist/cli/gen3-readback-probe.js <fm9|fm3|axe-fx-iii> [output.json]
 *   (dev) npm run fm9:probe -- [output.json]   (and fm3:/axefx3:)
 *
 * Exit codes: 0 = ran and wrote the report; 1 = bad device / no port found.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  connectFM9,
  connectFM3,
  connectAxeFxIII,
  toHex,
  type MidiConnection,
} from '@mcp-midi-control/fractal-gen3/midi.js';
import {
  AXE_FX_III_BLOCKS,
  type AxeFxIIIBlock,
  PARAMS_BY_FAMILY,
  buildBlockBulkReadPoll,
  assembleGen3BlockBulkRead,
  isGen3BroadcastFrame,
  buildRequestCurrentTypeName,
  isSetGetParameterResponse,
  parseSetGetParameterResponse,
  buildQueryPatchName,
  buildGetScene,
  buildGetTempo,
  buildStatusDump,
} from 'fractal-midi/gen3/axe-fx-iii';
import { FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';

// Universal MIDI Identity Request (not Fractal-specific): F0 7E 7F 06 01 F7.
// Every class-compliant device should reply with F0 7E <ch> 06 02 <mfr…>
// <family> <member> <version…> F7 — confirms the device is alive and reports
// its firmware without the owner typing it. 100% read-only, standard MIDI.
const IDENTITY_REQUEST = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];

type ParamsByFamily = Readonly<Record<string, readonly { name: string; paramId: number }[]>>;

interface DeviceSpec {
  label: string;
  modelByte: number;
  connect: () => MidiConnection;
  /** Device-true param catalog — paramIds DIFFER across the gen-3 family. */
  paramsByFamily: ParamsByFamily;
}
const DEVICES: Record<string, DeviceSpec> = {
  fm9: { label: 'FM9', modelByte: 0x12, connect: connectFM9, paramsByFamily: FM9_PARAMS_BY_FAMILY },
  fm3: { label: 'FM3', modelByte: 0x11, connect: connectFM3, paramsByFamily: FM3_PARAMS_BY_FAMILY },
  'axe-fx-iii': { label: 'Axe-Fx III', modelByte: 0x10, connect: connectAxeFxIII, paramsByFamily: PARAMS_BY_FAMILY },
};

/**
 * Resolve a device-true paramId by family + name. paramIds are DEVICE-SPECIFIC
 * (reverb TYPE is 10 on FM9 but 0 on the III and FM3; amp TYPE is 10 / 0 / 6) —
 * hardcoded FM9-shaped ids mis-addressed the 2026-06-12 FM3 field test.
 */
function paramIdOf(byFamily: ParamsByFamily, family: string, name: string): number {
  const p = (byFamily[family] ?? []).find((x) => x.name === name);
  if (!p) throw new Error(`device catalog has no ${family}.${name}`);
  return p.paramId;
}

// Reverb 1 TYPE — our one ground-truth enum: "Medium Spring" = ordinal 16.
// (The "raw 524" was a retired pos-15 packValue16 misread of float32(16); there
// is no separate raw-id space — the SET value is float32(read-ordinal) @ pos 12.)
const REVERB_EFFECT_ID = 66;
const GROUND_TRUTH = { name: 'Medium Spring', ordinal: 16, enumCount: 79 };

// Per-poll listen window. Bursts arrive ~1 ms after the poll; 400 ms is a
// generous ceiling that also bounds the worst case for un-placed blocks
// (which simply return nothing and time out cleanly).
const POLL_WINDOW_MS = 400;
const GET_WINDOW_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// argv[2] = device key (fm9 / fm3 / axe-fx-iii); argv[3] = optional output path.
const deviceKey = (process.argv[2] ?? '').toLowerCase();
const device = DEVICES[deviceKey];
if (!device) {
  console.error(`Usage: gen3-readback-probe <fm9|fm3|axe-fx-iii> [output.json]`);
  console.error(`Unknown device "${process.argv[2] ?? '(none)'}".`);
  process.exit(1);
}
const MODEL = device.modelByte;
const REVERB_TYPE_PARAM_ID = paramIdOf(device.paramsByFamily, 'REVERB', 'REVERB_TYPE');
const outArg = process.argv[3] ?? `${deviceKey}-probe-output.json`;
const outPath = path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg);

console.error(`${device.label} read-back probe (READ-ONLY — never writes/saves your presets)`);

let conn: MidiConnection;
try {
  conn = device.connect();
} catch (err) {
  // connect throws a device-specific "not found" message with driver /
  // port-exclusivity hints already filled in.
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!conn.hasInput) {
  console.error(`\nFound a ${device.label} output port but no input port — the probe needs`);
  console.error('to read replies. Unplug/replug the USB cable and try again.');
  conn.close();
  process.exit(1);
}

// One persistent listener; each send slices off only frames that arrived
// in its window. `connect` reassembles fragmented SysEx before delivery.
const inbound: number[][] = [];
conn.onMessage((bytes) => { if (bytes[0] === 0xf0) inbound.push(bytes); });

/**
 * Send `bytes`, then collect every SysEx that arrives until either `windowMs`
 * elapses or `doneWhen(framesSoFar)` returns true. The early-exit lets a
 * completed burst (terminated by its 0x76 END frame) return in ~1 ms instead
 * of waiting out the full window; un-placed blocks that never reply still
 * cost the full `windowMs` so we can record them as silent.
 */
async function sendAndCollect(
  bytes: number[],
  windowMs: number,
  doneWhen?: (frames: number[][]) => boolean,
): Promise<number[][]> {
  const startLen = inbound.length;
  conn!.send(bytes);
  const deadline = Date.now() + windowMs;
  for (;;) {
    const frames = inbound.slice(startLen);
    if (doneWhen && frames.length > 0 && doneWhen(frames)) return frames;
    if (Date.now() >= deadline) return frames;
    await sleep(15);
  }
}

interface BlockResult {
  block: string;
  groupCode: string;
  effectId: number;
  framesReceived: number;
  headFrames: number;
  bodyFrames: number;
  endFrames: number;
  blockId?: number;
  itemCount?: number;
  valueCount?: number;
  reverbTypeOrdinal?: number; // reverb block only: positional record[REVERB_TYPE_PARAM_ID] (device-true)
  assembled: boolean;
  error?: string;
}

async function runJob1(): Promise<BlockResult[]> {
  const targets = AXE_FX_III_BLOCKS.filter(
    (b): b is AxeFxIIIBlock & { firstId: number } =>
      b.firstId !== null && (b as AxeFxIIIBlock).addressable !== false,
  );
  console.error(`\nJOB 1 — polling ${targets.length} block types (instance 1)…`);
  const results: BlockResult[] = [];
  for (const b of targets) {
    const effectId = b.firstId;
    let frames: number[][];
    try {
      frames = await sendAndCollect(
        buildBlockBulkReadPoll(effectId, MODEL),
        POLL_WINDOW_MS,
        (fs) => fs.some((f) => isGen3BroadcastFrame(f, 0x76, MODEL)), // burst terminator
      );
    } catch (err) {
      results.push({
        block: b.name, groupCode: b.groupCode, effectId,
        framesReceived: 0, headFrames: 0, bodyFrames: 0, endFrames: 0,
        assembled: false, error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const heads = frames.filter((f) => isGen3BroadcastFrame(f, 0x74, MODEL));
    const bodies = frames.filter((f) => isGen3BroadcastFrame(f, 0x75, MODEL));
    const ends = frames.filter((f) => isGen3BroadcastFrame(f, 0x76, MODEL));
    const r: BlockResult = {
      block: b.name, groupCode: b.groupCode, effectId,
      framesReceived: frames.length,
      headFrames: heads.length, bodyFrames: bodies.length, endFrames: ends.length,
      assembled: false,
    };
    if (heads.length > 0) {
      try {
        const burst = assembleGen3BlockBulkRead(frames, MODEL);
        r.blockId = burst.blockId;
        r.itemCount = burst.itemCount;
        r.valueCount = burst.values.length;
        r.assembled = true;
        if (effectId === REVERB_EFFECT_ID) r.reverbTypeOrdinal = burst.values[REVERB_TYPE_PARAM_ID];
      } catch (err) {
        r.error = err instanceof Error ? err.message : String(err);
      }
    }
    results.push(r);
    const tag = r.assembled
      ? `block=${r.blockId} items=${r.itemCount} values=${r.valueCount}`
      : (frames.length ? `${frames.length} frames, not assembled` : 'no response (likely not placed)');
    console.error(`  ${b.name.padEnd(18)} eff=${String(effectId).padStart(3)} → ${tag}`);
  }
  return results;
}

interface GetExperiment {
  effectId: number;
  paramId: number;
  request: string;
  framesReceived: number;
  frames: Array<{ kind: string; hex: string; effectId?: number; paramId?: number; value?: number }>;
  verdict: string;
}

async function runJob2(): Promise<GetExperiment> {
  console.error(`\nJOB 2 — GET experiment on Reverb 1 TYPE (eff ${REVERB_EFFECT_ID}, pid ${REVERB_TYPE_PARAM_ID})…`);
  // sub 1F 00 type-name GET, not buildGetParameter: that frame is a discrete SET
  // of ordinal 0 and would reset the reverb type before replying.
  const req = buildRequestCurrentTypeName(REVERB_EFFECT_ID, REVERB_TYPE_PARAM_ID, MODEL);
  const frames = await sendAndCollect(req, GET_WINDOW_MS);
  const decoded: GetExperiment['frames'] = [];
  const carriedValues: number[] = [];

  for (const f of frames) {
    if (isSetGetParameterResponse(f, MODEL)) {
      try {
        const p = parseSetGetParameterResponse(f, MODEL);
        decoded.push({ kind: `fn01:${p.kind}`, hex: toHex(f), effectId: p.effectId, paramId: p.paramId, value: p.value });
        carriedValues.push(p.value);
      } catch {
        decoded.push({ kind: 'fn01:unparsed', hex: toHex(f) });
      }
    } else if (
      isGen3BroadcastFrame(f, 0x74, MODEL)
      || isGen3BroadcastFrame(f, 0x75, MODEL)
      || isGen3BroadcastFrame(f, 0x76, MODEL)
    ) {
      decoded.push({ kind: 'broadcast', hex: toHex(f) });
    } else {
      decoded.push({ kind: 'other', hex: toHex(f) });
    }
  }

  // If the GET triggered a broadcast burst, the reverb-type ordinal lives at
  // record[REVERB_TYPE_PARAM_ID] (the device-true catalog id — 0 on FM3/III,
  // 10 on FM9). Pull it so the verdict can compare against ground truth too.
  // CAVEAT: broadcast positional index == catalog paramId is only verified for
  // REVERB_MIX (paramId 0). It is FALSIFIED for the amp/DISTORT block (paramId
  // 2 -> index 149; FM9 capture 2026-06-04). This probe's verdict cross-checks
  // multiple candidate values, so it tolerates the index being off, but do not
  // copy `values[paramId]` into a shipping read path — see reader.ts guard.
  if (frames.some((f) => isGen3BroadcastFrame(f, 0x74, MODEL))) {
    try {
      const burst = assembleGen3BlockBulkRead(frames, MODEL);
      if (burst.values[REVERB_TYPE_PARAM_ID] !== undefined) carriedValues.push(burst.values[REVERB_TYPE_PARAM_ID]);
    } catch { /* not a clean burst — ignore */ }
  }

  let verdict: string;
  if (frames.length === 0) {
    verdict = 'NO RESPONSE — sub=0x09 GET not honored on this firmware. Read path is broadcast-only (fn=0x1f).';
  } else if (carriedValues.includes(GROUND_TRUTH.ordinal)) {
    verdict = `ORDINAL ${GROUND_TRUTH.ordinal} carried — the GET response reports the read ordinal (which IS the set-by-name value; no raw-id space). Read-back confirmed.`;
  } else {
    verdict = `RESPONDED but did not carry ordinal ${GROUND_TRUTH.ordinal} — current reverb type differs, or a new field layout. Inspect frames.`;
  }
  console.error(`  ${frames.length} frame(s). ${verdict}`);
  return { effectId: REVERB_EFFECT_ID, paramId: REVERB_TYPE_PARAM_ID, request: toHex(req), framesReceived: frames.length, frames: decoded, verdict };
}

// ── JOB 0: documented-query sweep ──────────────────────────────────
//
// Fire each documented v1.4 query (and the universal MIDI Identity
// Request) and record the RAW reply. These commands are documented for
// the III but have NEVER been confirmed on ANY gen-3 hardware, so this
// is pure discovery: which documented reads actually answer, and with
// what frame shape. All READ-ONLY (queries + identity; none mutate
// state). We log raw bytes and decode offline rather than trust the
// model-byte-specific parsers, since the reply shape is what we're here
// to learn.
interface QueryResult {
  query: string;
  request: string;
  responded: boolean;
  responseFns: string[]; // function byte of each reply frame (hex)
  responses: string[]; // raw hex of each reply frame
}

async function runJob0(): Promise<QueryResult[]> {
  const queries: Array<{ name: string; bytes: number[] }> = [
    { name: 'midi_identity_request', bytes: IDENTITY_REQUEST },
    { name: 'query_patch_name (fn=0x0D)', bytes: buildQueryPatchName('current', MODEL) },
    { name: 'get_active_scene (fn=0x0C)', bytes: buildGetScene(MODEL) },
    { name: 'get_tempo (fn=0x14)', bytes: buildGetTempo(MODEL) },
    { name: 'status_dump (fn=0x13)', bytes: buildStatusDump(MODEL) },
  ];
  console.error('\nJOB 0 — documented-query sweep (which spec reads answer on hardware)…');
  const results: QueryResult[] = [];
  for (const q of queries) {
    const frames = await sendAndCollect(q.bytes, GET_WINDOW_MS);
    const r: QueryResult = {
      query: q.name,
      request: toHex(q.bytes),
      responded: frames.length > 0,
      responseFns: frames.map((f) => (f[5] !== undefined ? `0x${f[5].toString(16)}` : '?')),
      responses: frames.map((f) => toHex(f)),
    };
    results.push(r);
    console.error(`  ${q.name.padEnd(28)} → ${r.responded ? `${frames.length} reply frame(s) [fn ${r.responseFns.join(',')}]` : 'no response'}`);
  }
  return results;
}

// ── JOB 3: enum value-list dump (EXPERIMENTAL, READ-ONLY) ──────────
//
// To SET a model BY NAME we need its typed-SET RAW id (a permutation of the
// read ordinal; reverb read-16 -> write-524). Those ids are NOT in the editor
// binary (the model roster is device-fetched) and amps echo numerically, so the
// one route is the device's enum value-LIST dump: the editor triggers it when a
// Type dropdown opens, and that reply embeds {raw-id, name} per entry. This job
// sends a CANDIDATE list request (fn=0x01 sub=0x2e, mirroring the GET builder;
// also tries sub=0x1f, the device-fetched-roster path amps may use) at each
// known block Type selector and logs the raw replies for offline decode.
// READ-ONLY: a list request is a query; an unrecognized envelope is ignored and
// reported as "no response". The exact request bytes are a hypothesis pending
// one editor capture — this job gathers data either way, and once the envelope
// is confirmed it becomes the one-click "set by name" closer (no Wireshark).
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const enc14 = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
const xor7 = (bytes: number[]): number => bytes.reduce((a, b) => a ^ b, 0) & 0x7f;
function buildEnumListRequest(sub0: number, effectId: number, paramId: number): number[] {
  const head = [0xf0, ...FRACTAL_MFR, MODEL, 0x01, sub0, 0x00, ...enc14(effectId), ...enc14(paramId), 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return [...head, xor7(head), 0xf7];
}
// (effectId, type-selector paramId) for the blocks we have ground truth for —
// typeParamId resolved from the DEVICE-TRUE catalog (amp TYPE is 10 on FM9 but
// 0 on the III and 6 on the FM3). Expand to the full block set once a capture
// confirms the request shape.
const ENUM_LIST_TARGETS = [
  { block: 'amp (DISTORT)', effectId: 58, typeParamId: paramIdOf(device.paramsByFamily, 'DISTORT', 'DISTORT_TYPE') },
  { block: 'reverb', effectId: 66, typeParamId: REVERB_TYPE_PARAM_ID },
  { block: 'drive (FUZZ)', effectId: 118, typeParamId: paramIdOf(device.paramsByFamily, 'FUZZ', 'FUZZ_TYPE') },
];
const ENUM_LIST_SUBS = [0x2e, 0x1f];

async function runJob3(): Promise<unknown[]> {
  console.error('\nJOB 3 — enum value-list dump experiment (candidate sub=0x2e / 0x1f)…');
  const out: unknown[] = [];
  for (const t of ENUM_LIST_TARGETS) {
    for (const sub of ENUM_LIST_SUBS) {
      const req = buildEnumListRequest(sub, t.effectId, t.typeParamId);
      const frames = await sendAndCollect(req, GET_WINDOW_MS);
      const fns = frames.map((f) => (f[5] !== undefined ? `0x${f[5].toString(16)}` : '?'));
      out.push({
        block: t.block, effectId: t.effectId, typeParamId: t.typeParamId,
        subAction: `0x${sub.toString(16)}`, request: toHex(req),
        responseCount: frames.length, responseFns: fns,
        responses: frames.map((f) => toHex(f)),
      });
      console.error(`  ${t.block.padEnd(16)} sub=0x${sub.toString(16)} → ${frames.length ? `${frames.length} frame(s) [fn ${fns.join(',')}]` : 'no response'}`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const job0 = await runJob0();
  const job1 = await runJob1();
  const job2 = await runJob2();
  const job3 = await runJob3();
  const placed = job1.filter((r) => r.assembled);
  const answeredQueries = job0.filter((q) => q.responded).map((q) => q.query);

  const job3Answered = job3.filter((r) => (r as { responseCount: number }).responseCount > 0).length;

  const report = {
    probe: 'gen3-readback-probe',
    version: 4, // v4: paramIds resolved from the device-true catalog (FM9-shaped hardcodes mis-addressed FM3/III)
    device: device.label,
    capturedAt: new Date().toISOString(),
    modelByte: MODEL,
    groundTruth: GROUND_TRUTH,
    note: 'READ-ONLY diagnostic. Job0 = documented-query sweep (raw replies). Job1 = fn=0x1F poll → 0x74/0x75/0x76 burst decode. Job2 = sub=0x09 GET-response experiment on reverb type. Job3 = EXPERIMENTAL enum value-list dump (candidate sub=0x2e/0x1f) — raw replies for offline {raw-id→name} decode toward set-by-name.',
    summary: {
      documentedQueriesAnswered: answeredQueries,
      blocksPolled: job1.length,
      blocksWithData: placed.length,
      reverbTypeOrdinalObserved: job1.find((r) => r.effectId === REVERB_EFFECT_ID)?.reverbTypeOrdinal,
      getExperimentVerdict: job2.verdict,
      enumListRequestsAnswered: job3Answered,
    },
    job0_documentedQueries: job0,
    job1_blockReads: job1,
    job2_getExperiment: job2,
    job3_enumListDump: job3,
  };

  fs.writeFileSync(outPath, JSON.stringify(report, undefined, 2));
  conn!.close();

  console.error(`\n✓ Wrote ${outPath}`);
  console.error(`  Documented queries answered: ${answeredQueries.length ? answeredQueries.join(', ') : '(none)'}`);
  console.error(`  ${placed.length}/${job1.length} block types returned data.`);
  console.error(`  GET experiment: ${job2.verdict}`);
  console.error(`  Enum-list experiment: ${job3Answered}/${job3.length} candidate requests got a reply.`);
  console.error('\nPlease email me this JSON file. Thank you!');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nProbe failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  try { conn?.close(); } catch { /* ignore */ }
  process.exit(1);
});
