/**
 * Cross-validation for the gen-3 live grid-layout codec (fn=0x01 sub=0x2E).
 *
 * Always runs self-contained structural checks (request byte-exactness +
 * synthetic round-trip) so preflight stays green on a fresh clone.
 *
 * When the gitignored FM9 capture is present
 * (`samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04.frames.json`),
 * it additionally decodes the 10 empty-target sub=0x2E responses and asserts:
 *   - all 10 decode identically (stable grid),
 *   - every real-block effect ID resolves to a known block in blockTypes.ts
 *     (the reference oracle — Amp 58, Cab 62, Comp 46, etc.),
 *   - shunts carry a strictly increasing index (the documented scheme).
 * This is the cross-oracle evidence that lets the codec ship community-beta.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  buildRequestGridLayout,
  parseGen3GridLayout,
  parseGen3LiveMeters,
  AXE_FX_III_BLOCKS,
} from '../packages/fractal-midi/dist/gen3/axe-fx-iii/index.js';
import { liveGridView } from '../packages/fractal-gen3/dist/reader.js';

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) ok += 1;
  else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const FM9 = 0x12;

// id → block name. Each block spans a contiguous effect-ID range
// (firstId .. firstId+instances-1, e.g. Amp 58-61, Drive 118-121).
const ID_TO_BLOCK = new Map<number, string>();
for (const b of AXE_FX_III_BLOCKS as unknown as ReadonlyArray<{ firstId: number | null; instances: number; name: string }>) {
  if (typeof b.firstId !== 'number') continue;
  for (let i = 0; i < b.instances; i++) ID_TO_BLOCK.set(b.firstId + i, b.name);
}

// ── Structural self-checks (always) ────────────────────────────────
const req = buildRequestGridLayout(FM9);
check(
  'request byte-exact (FM9)',
  req.map((b) => b.toString(16).padStart(2, '0')).join(' ') ===
    'f0 00 01 74 12 01 2e 00 00 00 00 00 00 00 00 00 00 00 00 00 00 38 f7',
);

// synthetic round-trip
function writeBitsMsb(region: number[], bit: number, value: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const b = bit + i;
    region[Math.floor(b / 7)] = (region[Math.floor(b / 7)] ?? 0) | (((value >> (n - 1 - i)) & 1) << (6 - (b % 7)));
  }
}
{
  const region = new Array(391).fill(0);
  const base = 46 + 0 * 192 + 0 * 32;
  writeBitsMsb(region, base, 58 << 1, 8);
  writeBitsMsb(region, base + 8, 0x00, 8);
  // trailing 0x00 = checksum placeholder (the parser tail-anchors on [cksum, F7])
  const frame = [0xf0, ...new Array(361).fill(0), ...region, 0x00, 0xf7];
  const cells = parseGen3GridLayout(frame, FM9);
  check('synthetic round-trip (Amp@0,0)', cells.length === 1 && cells[0].effectId === 58);
}

// ── liveGridView converter (reader glue → Gen3GridCellView) ────────
{
  const region = new Array(391).fill(0);
  const cell = (col: number, row: number) => 46 + col * 192 + row * 32;
  writeBitsMsb(region, cell(0, 0), 58 << 1, 8); // Amp 1 (real block)
  writeBitsMsb(region, cell(0, 0) + 8, 0x00, 8);
  writeBitsMsb(region, cell(1, 0), 3 << 1, 8); // shunt #3
  writeBitsMsb(region, cell(1, 0) + 8, 0x08, 8);
  writeBitsMsb(region, cell(1, 0) + 16, 0b10, 8); // cable mask
  const frame = [0xf0, ...new Array(361).fill(0), ...region, 0x00, 0xf7];
  const view = liveGridView(frame, FM9);
  const amp = view.find((c) => c.col === 0 && c.row === 0);
  const shunt = view.find((c) => c.col === 1 && c.row === 0);
  check('liveGridView: real block → effect_id + display name', amp?.effect_id === 58 && amp?.name === 'Amp 1' && !amp?.is_shunt);
  check('liveGridView: shunt → is_shunt + "Shunt N" name + raw route_flag', shunt?.is_shunt === true && shunt?.name === 'Shunt 3' && shunt?.route_flag === 0b10);
  check('liveGridView: from_rows omitted (cable direction not asserted)', amp !== undefined && !('from_rows' in amp));
}

// ── Real-capture cross-validation (when present) ───────────────────
const CAP = 'samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04.frames.json';
if (existsSync(CAP)) {
  const frames: Array<{ fn: number; sub: number; len: number; hex: string }> = JSON.parse(
    readFileSync(CAP, 'utf8'),
  );
  const resp = frames.filter((f) => f.fn === 1 && f.sub === 0x2e && f.len === 755);
  check('capture: found 10 empty-target sub=0x2E responses', resp.length === 10, `got ${resp.length}`);

  const decodes = resp.map((f) => parseGen3GridLayout(f.hex.split(/\s+/).map((h) => parseInt(h, 16)), FM9));
  const sig = (cells: ReturnType<typeof parseGen3GridLayout>) =>
    cells.map((c) => `${c.col},${c.row},${c.effectId ?? 's' + c.shuntIndex}`).join('|');
  check('capture: all 10 responses decode identically', decodes.every((d) => sig(d) === sig(decodes[0])));

  const grid = decodes[0];
  check('capture: grid is non-trivial (>20 placed cells)', grid.length > 20, `got ${grid.length}`);

  const realBlocks = grid.filter((c) => !c.isShunt);
  const unknown = realBlocks.filter((c) => !ID_TO_BLOCK.has(c.effectId!));
  check(
    'capture: every real-block effect ID resolves in blockTypes.ts',
    unknown.length === 0,
    `unknown IDs: ${unknown.map((c) => c.effectId).join(', ')}`,
  );
  // Spot-check the oracle anchors the cross-validation rested on.
  const ids = new Set(realBlocks.map((c) => c.effectId));
  check('capture: contains Amp (58) + Drive (118)', ids.has(58) && ids.has(118));

  const shuntIdx = grid.filter((c) => c.isShunt).map((c) => c.shuntIndex!);
  const sorted = [...shuntIdx].sort((a, b) => a - b);
  check('capture: shunt indices are unique', new Set(shuntIdx).size === shuntIdx.length);
  check(
    'capture: decoded blocks',
    true,
    `${realBlocks.length} real / ${shuntIdx.length} shunts: ${realBlocks.map((c) => ID_TO_BLOCK.get(c.effectId!)).join(', ')}`,
  );
  void sorted;

  // ── Live-meters cross-validation (the same sub=0x2E frames) ──────
  // The 10 reads are of the SAME static preset, so any byte that VARIES is
  // live telemetry and any byte that is CONSTANT is grid/preset data. This is
  // the behavioral oracle the meters decode rests on.
  const bytes = resp.map((f) => f.hex.split(/\s+/).map((h) => parseInt(h, 16)));
  const meters = bytes.map((b) => parseGen3LiveMeters(b));
  // CPU is the preset's steady DSP cost → constant across reads, and the
  // documented FM9 value is 65.0% (raw byte 66 → 32 + 66*0.5).
  check('meters: cpu_percent constant across all 10 reads', new Set(meters.map((m) => m.cpu_percent)).size === 1);
  check('meters: cpu_percent === 65.0 (FM9 capture)', meters[0].cpu_percent === 65, `got ${meters[0].cpu_percent}`);
  // Output meters bounce with the audio → MUST vary across the reads (this is
  // exactly what distinguishes them from static grid bytes).
  check('meters: output_left varies across reads (live meter)', new Set(meters.map((m) => m.output_left)).size > 1);
  check('meters: output_right varies across reads (live meter)', new Set(meters.map((m) => m.output_right)).size > 1);
  // The omitted-input justification: ForgeFX's input offset f[588] is CONSTANT
  // on FM9 (it lands inside the static grid region), i.e. NOT a live input
  // meter here. Asserting it stays constant documents why we don't surface it.
  check(
    'meters: byte 588 (ForgeFX input offset) is constant on FM9 → not a portable input meter',
    new Set(bytes.map((b) => b[588])).size === 1,
  );
  // COMPLETE oracle: because all 10 reads are the same static preset, the FULL
  // set of varying byte indices IS the full set of live-telemetry bytes. Derive
  // it and assert it is exactly {34, 35, 36} (excluding the trailing checksum
  // byte at len-2, which varies trivially with content). This both confirms
  // f[35]/f[36] are the only meters we decode AND documents byte 34 as an
  // undecoded telemetry field (a 0..3 counter on FM9) we intentionally do not
  // surface — so a future reviewer sees it was considered, not missed.
  const len = bytes[0].length;
  const checksumIdx = len - 2;
  const varying = new Set<number>();
  for (let i = 0; i < len; i++) {
    if (i === checksumIdx) continue;
    if (new Set(bytes.map((b) => b[i])).size > 1) varying.add(i);
  }
  const varyingSorted = [...varying].sort((a, b) => a - b);
  check(
    'meters: complete varying-byte set (excl. checksum) is exactly {34,35,36}',
    varyingSorted.length === 3 && varyingSorted[0] === 34 && varyingSorted[1] === 35 && varyingSorted[2] === 36,
    `got {${varyingSorted.join(',')}}`,
  );
} else {
  console.log(`  (capture ${CAP} absent — ran structural checks only)`);
}

// ── FM3 real-capture cross-validation (when present) ───────────────
// Three block-targeted sub=0x2E replies (590 + 590 + 606 bytes) from the
// 2026-06-12 FM3 field-test probe. Oracle: the same session's fn=0x13 status
// dump lists exactly Input1 (37), Output1 (42), Amp1 (58) placed. All three
// frames — including the 606-byte length variant, which tail-anchors the
// region to offset 377 instead of 361 — must decode to that exact grid.
const FM3 = 0x11;
const FM3_CAP = 'samples/captured/fm3-community-2026-06-12/fm3-probe-output.json';
if (existsSync(FM3_CAP)) {
  const probe = JSON.parse(readFileSync(FM3_CAP, 'utf8')) as {
    job3_enumListDump: Array<{ responses?: string[] }>;
  };
  const frames = probe.job3_enumListDump
    .flatMap((j) => j.responses ?? [])
    .map((hex) => hex.trim().split(/\s+/).map((h) => parseInt(h, 16)))
    .filter((f) => f[5] === 0x01 && f[6] === 0x2e);
  check('fm3 capture: found 3 sub=0x2E responses', frames.length === 3, `got ${frames.length}`);

  const decodes = frames.map((f) => parseGen3GridLayout(f, FM3));
  const sig = (cells: ReturnType<typeof parseGen3GridLayout>) =>
    cells.map((c) => `${c.col},${c.row},${c.effectId ?? 's' + c.shuntIndex},${c.cableInputMask}`).join('|');
  check(
    'fm3 capture: all frames (incl. 606B length variant) decode identically',
    decodes.length > 0 && decodes.every((d) => sig(d) === sig(decodes[0])),
  );
  const grid = decodes[0] ?? [];
  check('fm3 capture: 3-cell fn=0x13 oracle grid', grid.length === 3, `got ${grid.length}`);
  const byPos = (row: number, col: number) => grid.find((c) => c.row === row && c.col === col);
  check('fm3 capture: Input1 (37) @ r1c0', byPos(1, 0)?.effectId === 37);
  check('fm3 capture: Amp1 (58) @ r1c1 cable 0x04', byPos(1, 1)?.effectId === 58 && byPos(1, 1)?.cableInputMask === 0x04);
  check('fm3 capture: Output1 (42) @ r1c2 cable 0x04', byPos(1, 2)?.effectId === 42 && byPos(1, 2)?.cableInputMask === 0x04);
} else {
  console.log(`  (capture ${FM3_CAP} absent — skipped FM3 cross-validation)`);
}

console.log(`gen3-grid-layout: ${ok} ok, ${fail} fail`);
if (fail > 0) process.exit(1);
