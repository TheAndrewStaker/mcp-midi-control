/**
 * Controlled-capture runner — drive FM-Edit against the codec-backed simulator
 * to capture and auto-decode ONE isolated editor action, with no hardware.
 *
 * Three capture kinds, each closing one open gen-3 decode
 * (primitive gen3-editor-sync-read-surface):
 *
 *   routing  — drag ONE cable between two known cells. Pins the sub=0x35
 *              endpoint bytes (byte 21 rowMask / byte 22 endpoint) against a
 *              known source->dest, and the byte-12 connect/disconnect direction.
 *              FULLY offline-capable (editor->us write).
 *
 *   enum     — open a block's TYPE dropdown and pick each value (and/or insert
 *              each block type). Harvests {name -> raw-id} from sub=0x09 typed
 *              SET and {name -> effectId} from sub=0x32 insert. FULLY offline-
 *              capable (editor->us write). This is HW-GEN3-ENUM-ROSTER with no
 *              hardware.
 *
 *   layout   — build a KNOWN small grid (place one block in an empty preset).
 *              sub=0x2e is a DEVICE->editor response the sim can only replay
 *              verbatim, so this kind records the editor's incremental writes
 *              (the ground-truth layout) and DIFFS any 0x2e seen against the
 *              baseline. The decode itself needs a second known-layout 0x2e
 *              (a real device, or a fresh device-connect capture) — once that
 *              exists, `--analyze` diffs it here.
 *
 * Usage:
 *   # Live capture (default log name = samples/captured/fm9-cc-<kind>-<ts>.syx):
 *   npx tsx scripts/_research/sim/controlled-capture.ts \
 *     --capture routing --in "AXEloopMIDI Port" --out "AXEloopMIDI Port 2" --model 12
 *
 *   # Re-run a kind's report on an existing session log (no MIDI):
 *   npx tsx scripts/_research/sim/controlled-capture.ts \
 *     --capture routing --analyze samples/captured/fm9-sim-m2-2026-06-04.annotated.jsonl
 */
import path from 'node:path';
import { runEmulator, printPorts } from './emulator.js';
import { parseWriteFrames, parseFramesBySub, toHex } from './decodeWrites.js';
import { analyze2e, diff2e } from './layout2e.js';

type Kind = 'routing' | 'enum' | 'layout';

function getFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const kind = getFlag('capture') as Kind | undefined;
const analyzePath = getFlag('analyze');
const inNeedle = getFlag('in');
const outNeedle = getFlag('out');
const modelByte = parseInt(getFlag('model') ?? '12', 16);

const KINDS: ReadonlySet<string> = new Set(['routing', 'enum', 'layout']);
if (!kind || !KINDS.has(kind)) {
  console.error('Controlled-capture runner — capture + auto-decode ONE isolated FM-Edit action.\n');
  console.error('Usage:');
  console.error('  --capture <routing|enum|layout> --in "<in port>" --out "<out port>" --model 12   (live)');
  console.error('  --capture <routing|enum|layout> --analyze <existing .annotated.jsonl>             (report only)\n');
  printPorts();
  process.exit(kind ? 1 : 0);
}

// ── per-kind instructions printed before the user acts ─────────────────────
const BANNERS: Record<Kind, string> = {
  routing:
    'CAPTURE: routing (sub=0x35)\n' +
    '  1. Wait for FM-Edit to render the grid ("Connected!").\n' +
    '  2. Drag exactly ONE cable between two cells you can name (note the\n' +
    '     source cell and dest cell — e.g. r2c3 -> r3c4).\n' +
    '  3. Ctrl+C. The lone sub=0x35 will be decoded against your known cells.',
  enum:
    'CAPTURE: enum roster (sub=0x09 typed / sub=0x32 insert)\n' +
    '  1. Wait for the grid to render.\n' +
    '  2. To harvest BLOCK TYPES: insert each block type you want (note the\n' +
    '     order). To harvest a block\'s ENUM (amp model / reverb type): open it,\n' +
    '     open the TYPE dropdown, pick each value in order (note the names).\n' +
    '  3. Ctrl+C. Each pick\'s raw-id is printed in click order to map to names.',
  layout:
    'CAPTURE: layout (sub=0x2e occupancy/routing)\n' +
    '  NOTE: 0x2e is a DEVICE->editor response; the sim replays it verbatim, so\n' +
    '  this records the editor\'s incremental writes (your ground-truth layout)\n' +
    '  and diffs any 0x2e seen. The decode needs a SECOND known-layout 0x2e\n' +
    '  (a real device / fresh device-connect capture) — feed it via --analyze.\n' +
    '  1. Build a KNOWN minimal grid (e.g. one block in an empty preset).\n' +
    '  2. Ctrl+C.',
};

// ── per-kind reports ───────────────────────────────────────────────────────

async function reportRouting(jsonl: string): Promise<void> {
  const writes = await parseWriteFrames(jsonl);
  const ctx = writes.filter((w) => w.sub === 0x30 || w.sub === 0x32 || w.sub === 0x35);
  console.log('\n=== routing report ===');
  console.log('context (selects / inserts / routing), chronological:');
  for (const w of ctx) console.log(`  t=${w.t} 0x${w.sub.toString(16)}(${w.subName}) ${w.label}`);

  const routes = writes.filter((w) => w.sub === 0x35);
  const seen = new Map<string, { count: number; t: string }>();
  for (const r of routes) {
    const k = toHex(r.bytes);
    const p = seen.get(k);
    if (p) p.count++; else seen.set(k, { count: 1, t: r.t });
  }
  console.log(`\nunique sub=0x35 frames: ${seen.size} (${routes.length} total)`);
  console.log('byte layout: [12]=op(connect/disconnect) [21]=rowMask [22]=endpoint [23]=destRow<<5');
  for (const r of routes) {
    const k = toHex(r.bytes);
    if (seen.has(k)) {
      seen.delete(k); // print each unique once, with full decode
      console.log(`  ${r.label}`);
      console.log(`    op=0x${(r.fields.op as number).toString(16)} rowMask=0b${(r.fields.rowMask as number).toString(2).padStart(4, '0')} endpoint=0x${(r.fields.endpoint as number).toString(16)} destRow=${r.fields.destRow}`);
      console.log(`    ${k}`);
    }
  }
  if (routes.length === 0) console.log('  (no sub=0x35 captured — did the cable drag register?)');
  else console.log('\nMap the source cell you dragged FROM to byte 22 (endpoint) and the dest\nrow(s) to byte 21 (rowMask) / byte 23 (destRow). One cable = clean binding.');
}

async function reportEnum(jsonl: string): Promise<void> {
  const writes = await parseWriteFrames(jsonl);
  const picks = writes.filter((w) => w.sub === 0x09 || w.sub === 0x32);
  console.log('\n=== enum roster report ===');
  console.log('picks in CLICK ORDER (map each to the name you selected):');
  for (const w of picks) {
    if (w.sub === 0x32 && w.fields.kind === 'effect') {
      console.log(`  t=${w.t} INSERT block-type effectId=${w.fields.effectId}  (-> {name -> effectId})`);
    } else if (w.sub === 0x32 && w.fields.kind === 'shunt') {
      console.log(`  t=${w.t} INSERT shunt#${w.fields.instance}`);
    } else if (w.sub === 0x09) {
      console.log(`  t=${w.t} TYPED  eff ${w.fields.effectId} param ${w.fields.paramId} raw-id=${w.fields.value}  (-> {name -> raw-id})`);
    }
  }
  // dedup tables
  const blockTypes = new Set<number>();
  const rawIds = new Map<string, number>();
  for (const w of picks) {
    if (w.sub === 0x32 && w.fields.kind === 'effect') blockTypes.add(w.fields.effectId as number);
    if (w.sub === 0x09) rawIds.set(`eff${w.fields.effectId}/param${w.fields.paramId}=${w.fields.value}`, w.fields.value as number);
  }
  console.log(`\nblock-type effectIds seen: ${[...blockTypes].sort((a, b) => a - b).join(', ') || '(none)'}`);
  console.log(`enum raw-ids seen: ${[...rawIds.keys()].join('  ') || '(none — open a TYPE dropdown and pick a value)'}`);
}

async function reportLayout(jsonl: string): Promise<void> {
  console.log('\n=== layout report ===');
  // The editor's incremental writes = the ground-truth grid you built.
  const writes = await parseWriteFrames(jsonl);
  const struct = writes.filter((w) => w.sub === 0x32 || w.sub === 0x35);
  console.log('built grid (inserts + routing), chronological:');
  for (const w of struct) console.log(`  t=${w.t} 0x${w.sub.toString(16)}(${w.subName}) ${w.label}`);

  const frames2e = await parseFramesBySub(jsonl, 0x2e);
  // Only full-length (755-byte) 0x2e frames are real layout maps; short ones are
  // same-sub fallbacks / truncated reads and must not pollute the diff. Dedupe
  // on the BODY (bytes 12..len-3), ignoring the echoed query-address region, so
  // two reads of the same layout at different addresses count as one.
  const FULL_LEN = 755;
  const lenHist = new Map<number, number>();
  for (const f of frames2e) lenHist.set(f.bytes.length, (lenHist.get(f.bytes.length) ?? 0) + 1);
  const distinct = new Map<string, number[]>();
  for (const f of frames2e) {
    if (f.bytes.length !== FULL_LEN) continue;
    distinct.set(toHex(f.bytes.slice(12, f.bytes.length - 2)), f.bytes);
  }
  console.log(`\nsub=0x2e frames: ${frames2e.length} (lengths: ${[...lenHist.entries()].sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}×${n}`).join(' ')})`);
  console.log(`full-length (${FULL_LEN}B) distinct layouts: ${distinct.size}`);
  const uniq = [...distinct.values()];
  if (uniq.length >= 2) {
    const d = diff2e(uniq[0], uniq[1]);
    console.log(`DIFF of the two distinct 0x2e (septet-unpacked): ${d.length} changed bytes — the occupancy/routing encoding:`);
    for (const c of d.slice(0, 60)) console.log(`  unpacked[${c.index}]: 0x${(c.from < 0 ? 0 : c.from).toString(16)} -> 0x${(c.to < 0 ? 0 : c.to).toString(16)}`);
    if (d.length > 60) console.log(`  ... (${d.length - 60} more)`);
  } else if (uniq.length === 1) {
    const a = analyze2e(uniq[0]);
    console.log(`one 0x2e only (the served/baseline). septet-unpacked ${a.unpackedLen} bytes; ${a.content.length} non-background (non-0x40/0x00) bytes:`);
    for (const c of a.content.slice(0, 40)) console.log(`  unpacked[${c.index}] = 0x${c.value.toString(16)}`);
    if (a.content.length > 40) console.log(`  ... (${a.content.length - 40} more)`);
    console.log('\nNo second layout to diff. The decode needs a known-layout 0x2e from a real\ndevice (or a fresh device-connect capture); re-run with --analyze on that log.');
  } else {
    console.log('  (no 0x2e captured)');
  }
}

const REPORTS: Record<Kind, (jsonl: string) => Promise<void>> = {
  routing: reportRouting,
  enum: reportEnum,
  layout: reportLayout,
};

// ── dispatch ───────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  if (analyzePath) {
    await REPORTS[kind!](path.resolve(process.cwd(), analyzePath));
    return;
  }
  if (!inNeedle || !outNeedle) {
    console.error('Live capture needs --in and --out (or use --analyze <jsonl>). Ports:\n');
    printPorts();
    process.exit(1);
  }
  const ts = new Date(Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logPath = getFlag('log') ?? `samples/captured/fm9-cc-${kind}-${ts}.syx`;
  runEmulator({
    modelByte,
    inNeedle,
    outNeedle,
    logPath,
    seedPath: getFlag('seed'),
    banner: BANNERS[kind!],
    onStop: (jsonlPath) => REPORTS[kind!](jsonlPath),
  });
}

main();
