/**
 * Axe-Fx Standard / Ultra (gen-1) whole-patch dump goldens — the SPEC-PINNED
 * SUBSET (fn 0x03 request + fn 0x04 dump header/name/grid).
 *
 * Source: the gen-1 wiki spec (docs/manuals/AxeFx-gen1-SysEx-Spec-wiki.
 * wikitext.txt, MIDI_GET_PATCH + MIDI_PATCH_DUMP sections). Request frames are
 * asserted byte-exact against EVERY worked example the spec gives for banks
 * A/B; bank-C requests (≥ 256) must REFUSE (the spec's own "or'd with unknown
 * value" wrinkle). The dump-side goldens build a synthetic frame byte-for-byte
 * from the spec's offset table and round-trip name + grid + edit-buffer flag.
 * The parameter region is asserted to come back as a byte COUNT only.
 */
import {
  buildGetPatchDump,
  parsePatchDump,
  isPatchDumpResponse,
  nibbleSplit,
  GEN1_PATCH_DUMP_MIN_LENGTH,
  GEN1_PATCH_DUMP_NOMINAL_LENGTH,
} from '../../src/gen1/index.js';

function eqBytes(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function hex(bs: readonly number[]): string {
  return Array.from(bs, (b) => b.toString(16).padStart(2, '0')).join(' ');
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ── Request goldens: every worked example in the spec for banks A/B, plus the
//    edit-buffer example frame. Byte-exact.
const REQUEST_CASES: Array<{ label: string; preset?: number; expected: number[] }> = [
  {
    label: 'edit buffer (spec example frame)',
    preset: undefined,
    expected: [0xf0, 0x00, 0x01, 0x74, 0x01, 0x03, 0x01, 0x00, 0x00, 0xf7],
  },
  {
    label: 'A000 (spec worked example)',
    preset: 0,
    expected: [0xf0, 0x00, 0x01, 0x74, 0x01, 0x03, 0x00, 0x00, 0x00, 0xf7],
  },
  {
    label: 'A127 (spec worked example)',
    preset: 127,
    expected: [0xf0, 0x00, 0x01, 0x74, 0x01, 0x03, 0x00, 0x0f, 0x07, 0xf7],
  },
  {
    label: 'B128 (spec worked example)',
    preset: 128,
    expected: [0xf0, 0x00, 0x01, 0x74, 0x01, 0x03, 0x00, 0x00, 0x08, 0xf7],
  },
  {
    label: 'B255 (spec worked example)',
    preset: 255,
    expected: [0xf0, 0x00, 0x01, 0x74, 0x01, 0x03, 0x00, 0x0f, 0x0f, 0xf7],
  },
];

// Bank-C presets whose request bytes the spec leaves unpinned (its C383
// example shows ls = 0x7F ≠ 383 & 0x0f, and C256 shows ls = 0x00 — the
// OR-value cannot be derived). These must REFUSE, never emit guessed bytes.
const BANK_C_REFUSALS = [256, 383];

/**
 * Build a synthetic fn 0x04 dump byte-for-byte from the spec's offset table.
 * Placed blocks land at chosen cell indices; everything undetermined is 0.
 */
function syntheticDump(args: {
  editBuffer: boolean;
  name: string;
  cells?: Array<{ index: number; effectId: number; state: [number, number] }>;
  totalLength?: number;
}): number[] {
  const total = args.totalLength ?? GEN1_PATCH_DUMP_NOMINAL_LENGTH;
  const f = new Array<number>(total).fill(0x00);
  // Header, offsets 0–6.
  f[0] = 0xf0; f[1] = 0x00; f[2] = 0x01; f[3] = 0x74; f[4] = 0x01; f[5] = 0x04;
  f[6] = args.editBuffer ? 0x01 : 0x00;
  // Offsets 7–12: undetermined ("patch number?") — left 0.
  // Name at 13: 20 chars in ls/ms nibble pairs, space-padded, null pair at 53–54.
  const padded = args.name.padEnd(20, ' ');
  for (let i = 0; i < 20; i++) {
    const [lo, hi] = nibbleSplit(padded.charCodeAt(i));
    f[13 + 2 * i] = lo;
    f[13 + 2 * i + 1] = hi;
  }
  f[53] = 0x00; f[54] = 0x00; // nibble-pair null terminator
  // Offsets 55–76: undetermined — left 0.
  // Grid at 77: 48 cells × 4 bytes (effect id nibble pair + 2 state bytes).
  for (const c of args.cells ?? []) {
    const at = 77 + c.index * 4;
    const [lo, hi] = nibbleSplit(c.effectId);
    f[at] = lo;
    f[at + 1] = hi;
    f[at + 2] = c.state[0];
    f[at + 3] = c.state[1];
  }
  // Param region 269..total-2: left 0 (unpinned). EOX.
  f[total - 1] = 0xf7;
  return f;
}

export const AXEFXGEN1_PATCHDUMP_CASE_COUNT = REQUEST_CASES.length + BANK_C_REFUSALS.length + 5;

export function runAxeFxGen1PatchDumpTests(): void {
  // 1. Request frames byte-exact vs every spec worked example.
  for (const c of REQUEST_CASES) {
    const built = buildGetPatchDump(c.preset);
    if (!eqBytes(built, c.expected)) {
      throw new Error(`gen-1 patch-dump request golden "${c.label}":\n  built    ${hex(built)}\n  expected ${hex(c.expected)}`);
    }
  }

  // 2. Bank-C refusal: presets ≥ 256 throw, citing the spec's unknown OR-value.
  for (const preset of BANK_C_REFUSALS) {
    let threw: Error | undefined;
    try {
      buildGetPatchDump(preset);
    } catch (err) {
      threw = err as Error;
    }
    assert(!!threw, `buildGetPatchDump(${preset}) must refuse (bank C is unpinned)`);
    assert(
      /bank-C|or'd with unknown/i.test(threw!.message),
      `bank-C refusal for ${preset} must cite the spec's unknown OR-value, got: ${threw!.message}`,
    );
  }
  // Bad inputs also refuse.
  for (const bad of [-1, 1.5]) {
    let threw = false;
    try { buildGetPatchDump(bad); } catch { threw = true; }
    assert(threw, `buildGetPatchDump(${bad}) must throw`);
  }

  // 3. Synthetic dump round-trip: edit-buffer flag + name + grid cells.
  //    Cell contents: Amp 1 (blockId 106) at index 0, Cabinet 1 (108) at
  //    index 4, an id NOT in the block table (37) at index 8.
  const dump = syntheticDump({
    editBuffer: true,
    name: 'BIG HAIR LEAD',
    cells: [
      { index: 0, effectId: 106, state: [0x01, 0x00] },
      { index: 4, effectId: 108, state: [0x00, 0x02] },
      { index: 8, effectId: 37, state: [0x03, 0x04] },
    ],
  });
  assert(dump.length === GEN1_PATCH_DUMP_NOMINAL_LENGTH, 'synthetic dump must be the spec-nominal 2060 bytes');
  const parsed = parsePatchDump(dump);
  assert(parsed.source === 'edit-buffer', `source expected 'edit-buffer', got ${parsed.source}`);
  assert(parsed.model === 0x01, `model expected 0x01, got ${parsed.model}`);
  assert(parsed.name === 'BIG HAIR LEAD', `name expected "BIG HAIR LEAD", got "${parsed.name}"`);
  assert(parsed.cells.length === 48, `expected 48 grid cells, got ${parsed.cells.length}`);
  const c0 = parsed.cells[0];
  assert(c0.effectId === 106 && c0.blockName === 'Amp 1', `cell 0 expected Amp 1 (106), got ${c0.effectId}/${c0.blockName}`);
  assert(c0.stateRaw[0] === 0x01 && c0.stateRaw[1] === 0x00, 'cell 0 stateRaw must carry the raw bytes');
  const c4 = parsed.cells[4];
  assert(c4.effectId === 108 && c4.blockName === 'Cabinet 1', `cell 4 expected Cabinet 1 (108), got ${c4.effectId}/${c4.blockName}`);
  const c8 = parsed.cells[8];
  assert(c8.effectId === 37 && c8.blockName === undefined, `cell 8 expected raw unresolved id 37, got ${c8.effectId}/${c8.blockName}`);
  // Empty cells parse as effectId 0, unresolved.
  assert(parsed.cells[1].effectId === 0 && parsed.cells[1].blockName === undefined, 'empty cell must be effectId 0, unresolved');
  // Param region is a COUNT only: 2060 - 269 (region start) - 1 (F7) = 1790.
  assert(parsed.paramBlockBytes === 1790, `paramBlockBytes expected 1790, got ${parsed.paramBlockBytes}`);
  assert(parsed.totalLength === 2060, `totalLength expected 2060, got ${parsed.totalLength}`);

  // 4. Stored-dump flag (byte 6 = 0x00) parses as 'stored'.
  const stored = syntheticDump({ editBuffer: false, name: 'RHYTHM' });
  const parsedStored = parsePatchDump(stored);
  assert(parsedStored.source === 'stored', `source expected 'stored', got ${parsedStored.source}`);
  assert(parsedStored.name === 'RHYTHM', `stored name expected "RHYTHM", got "${parsedStored.name}"`);

  // 5. Length-variance tolerance: the spec HEDGES the 2060 total, so any frame
  //    that contains the pinned regions parses. Minimum = grid end + F7 = 270.
  const short = syntheticDump({ editBuffer: true, name: 'MINI', totalLength: GEN1_PATCH_DUMP_MIN_LENGTH });
  const parsedShort = parsePatchDump(short);
  assert(parsedShort.paramBlockBytes === 0, `270-byte frame must report paramBlockBytes 0, got ${parsedShort.paramBlockBytes}`);
  const longer = syntheticDump({ editBuffer: true, name: 'MAXI', totalLength: 2200 });
  assert(parsePatchDump(longer).paramBlockBytes === 2200 - 270, 'longer frame must count its larger param region');

  // 6. Short-frame / malformed throw.
  for (const [label, frame] of [
    ['truncated below the pinned regions', dump.slice(0, 200).concat([0xf7])],
    ['wrong manufacturer id', [0xf0, 0x00, 0x00, 0x7d, ...dump.slice(4)]],
    ['wrong function byte', dump.map((b, i) => (i === 5 ? 0x02 : b))],
  ] as Array<[string, number[]]>) {
    let threw = false;
    try { parsePatchDump(frame); } catch { threw = true; }
    assert(threw, `parsePatchDump must throw on ${label}`);
  }

  // 7. isPatchDumpResponse: reply flag must match the request form.
  const editReq = buildGetPatchDump();
  const storedReq = buildGetPatchDump(12);
  assert(isPatchDumpResponse(editReq, dump), 'edit-buffer dump must match its edit-buffer request');
  assert(!isPatchDumpResponse(storedReq, dump), 'edit-buffer dump must NOT match a stored request');
  assert(isPatchDumpResponse(storedReq, stored), 'stored dump must match a stored request');
  assert(!isPatchDumpResponse(editReq, editReq), 'the outbound fn 0x03 request itself must not match');
}
