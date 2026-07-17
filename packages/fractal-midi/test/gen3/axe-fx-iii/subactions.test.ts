/**
 * Gen-3 sub-action + standalone-fn builders decoded from the 2026-06-09
 * Ghidra actions-and-shapes mine of the Axe-Edit III binary
 * (`docs/_private/III-SUBACTIONS-MINE-2026-06-09.md`):
 *
 *   - buildClearBlock / buildClearBlockCompanion (fn=0x01 sub=0x30/0x33)
 *   - buildRenamePreset (fn=0x01 sub=0x28, 32-byte name tail)
 *   - buildSetSceneName / buildClearAllSceneNames (fn=0x01 sub=0x2b)
 *   - buildSceneBlobHeader / buildSceneBlobChecksum (fn=0x5a / fn=0x5c)
 *
 * Goldens are byte literals derived from the decompiled emission sites
 * (hand-traced through the canonical fn=0x01 builder FUN_14033ec70 and
 * the fn=0x5a/0x5c emitters), NOT from hardware captures: everything
 * here is decoded / hardware-unverified, community-beta tier.
 *
 * The name-tail cases additionally cross-validate the production packer
 * (`packValueChunked`) against an independent reimplementation of the
 * editor's streaming 8-to-7 packer (FUN_14033f2d0, primitive
 * [[iii-byte-stream-septet-pack-8to7]]): the two algorithms must agree
 * byte-for-byte on every frame.
 */
import {
  buildClearBlock,
  buildClearBlockCompanion,
  buildRenamePreset,
  buildSetSceneName,
  buildClearAllSceneNames,
  buildSceneBlobHeader,
  buildSceneBlobChecksum,
  xorChecksum32Words,
} from '../../../src/gen3/axe-fx-iii/index.js';
import { fractalChecksum } from '../../../src/shared/checksum.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function hexStr(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
function parseHex(s: string): number[] {
  return s.trim().split(/\s+/).map((h) => parseInt(h, 16));
}
function assertBytes(got: readonly number[], want: readonly number[], label: string): void {
  assert(
    got.length === want.length && got.every((b, i) => b === want[i]),
    `${label}\n  got:  [${hexStr(got)}]\n  want: [${hexStr(want)}]`,
  );
}

/**
 * Independent reimplementation of the editor's streaming 8-to-7 packer
 * (FUN_14033f2d0), used as the oracle for the packed 32-byte name tail.
 * Kept separate from src on purpose: the production builder uses
 * `packValueChunked`, so agreement here cross-validates two
 * independently-written algorithms.
 */
function streamingPack8to7(input: readonly number[]): number[] {
  const out: number[] = [];
  let inIdx = 0;
  let bitsConsumed = 1;
  let carry = 0;
  while (inIdx < input.length) {
    if (bitsConsumed === 8) {
      out.push(carry & 0x7f);
      bitsConsumed = 1;
      carry = 0;
    } else {
      const b = input[inIdx] & 0xff;
      out.push(((b >> bitsConsumed) | carry) & 0x7f);
      carry = (b & ((1 << bitsConsumed) - 1)) << (7 - bitsConsumed);
      bitsConsumed += 1;
      inIdx += 1;
    }
  }
  out.push(carry & 0x7f);
  return out;
}

/** Build the expected fn=0x01 name frame from first principles. */
function expectedNameFrame(
  modelByte: number,
  subAction: number,
  paramId: number,
  name: string,
): number[] {
  const raw = new Array<number>(32).fill(0x20);
  for (let i = 0; i < name.length; i++) raw[i] = name.charCodeAt(i);
  const body = [
    0xf0, 0x00, 0x01, 0x74, modelByte, 0x01,
    subAction, 0x00,
    0x00, 0x00,
    paramId & 0x7f, (paramId >> 7) & 0x7f,
    0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00,
    0x20, 0x00,
    ...streamingPack8to7(raw),
  ];
  return [...body, fractalChecksum(body), 0xf7];
}

const III = 0x10;
const FM9 = 0x12;

const cases: Array<() => void> = [];

// ─── CLEAR BLOCK (fn=0x01 sub=0x30) ──────────────────────────────────────────

// Case 1: gridPos 0 (r1c1, model 0x10). This exact frame is cited twice:
// the post-loop emission of the editor's "Clearing preset..." routine
// (gridPos=0) and the loopMIDI-captured insert companion at r1c1.
cases.push(() => {
  const got = buildClearBlock({ row: 1, col: 1 }, III);
  const want = parseHex('f0 00 01 74 10 01 30 00 00 00 00 00 00 00 00 00 00 00 00 00 00 24 f7');
  assertBytes(got, want, 'clearBlock III r1c1 (gridPos 0)');
});

// Case 2: gridPos 15 (r4c3 on a 6-row grid) — the same cell the insert
// primitive entry cites with captured byte12 = 0x0f.
cases.push(() => {
  const got = buildClearBlock({ row: 4, col: 3 }, III);
  const want = parseHex('f0 00 01 74 10 01 30 00 00 00 00 00 0f 00 00 00 00 00 00 00 00 2b f7');
  assertBytes(got, want, 'clearBlock III r4c3 (gridPos 15)');
});

// Case 3: model-byte propagation — FM9 frame differs only at byte 4 and
// the checksum.
cases.push(() => {
  const iii = buildClearBlock({ row: 4, col: 3 }, III);
  const fm9 = buildClearBlock({ row: 4, col: 3 }, FM9);
  const wantFm9 = parseHex('f0 00 01 74 12 01 30 00 00 00 00 00 0f 00 00 00 00 00 00 00 00 29 f7');
  assertBytes(fm9, wantFm9, 'clearBlock FM9 r4c3');
  for (let i = 0; i < fm9.length; i++) {
    if (i === 4 || i === 21) continue;
    assert(fm9[i] === iii[i], `clearBlock FM9 vs III byte[${i}] must match outside model+checksum`);
  }
});

// Case 4: gridPos 83 (r6c14) — the last index of the editor's 0..0x53
// clear loop; high septet still 0 (83 < 128).
cases.push(() => {
  const got = buildClearBlock({ row: 6, col: 14 }, III);
  const want = parseHex('f0 00 01 74 10 01 30 00 00 00 00 00 53 00 00 00 00 00 00 00 00 77 f7');
  assertBytes(got, want, 'clearBlock III r6c14 (gridPos 0x53)');
});

// Case 5: 4-row stride (FM3-shape grids): r2c2 with rows=4 → gridPos 5.
cases.push(() => {
  const got = buildClearBlock({ row: 2, col: 2, rows: 4 }, 0x11);
  const want = parseHex('f0 00 01 74 11 01 30 00 00 00 00 00 05 00 00 00 00 00 00 00 00 20 f7');
  assertBytes(got, want, 'clearBlock FM3 r2c2 rows=4 (gridPos 5)');
});

// Case 6: companion frame (sub=0x33) carries the same gridPos.
cases.push(() => {
  const got = buildClearBlockCompanion({ row: 4, col: 3 }, III);
  const want = parseHex('f0 00 01 74 10 01 33 00 00 00 00 00 0f 00 00 00 00 00 00 00 00 28 f7');
  assertBytes(got, want, 'clearBlockCompanion III r4c3');
});

// Case 7: range validation refuses out-of-grid cells.
cases.push(() => {
  let threw = false;
  try {
    buildClearBlock({ row: 7, col: 1 }, III);
  } catch {
    threw = true;
  }
  assert(threw, 'clearBlock row 7 on a 6-row grid must throw');
});

// ─── RENAME PRESET (fn=0x01 sub=0x28) ────────────────────────────────────────

// Case 8: the "<EMPTY>" frame from the editor's "Clearing preset..."
// flow — full hand-traced byte literal (header fields plus the
// 37-byte packed tail traced through the FUN_14033f2d0 algorithm).
cases.push(() => {
  const got = buildRenamePreset('<EMPTY>', III);
  const want = parseHex(
    'f0 00 01 74 10 01 28 00 00 00 00 00 00 00 00 00 00 00 00 20 00 ' +
    '1e 11 29 55 02 51 32 3e ' +
    '10 08 04 02 01 00 40 20 ' +
    '10 08 04 02 01 00 40 20 ' +
    '10 08 04 02 01 00 40 20 ' +
    '10 08 04 02 00 ' +
    '51 f7',
  );
  assertBytes(got, want, 'renamePreset III "<EMPTY>"');
  assert(got.length === 60, `rename frame must be 60 bytes, got ${got.length}`);
  // Cross-validate against the independent streaming-packer oracle.
  assertBytes(got, expectedNameFrame(III, 0x28, 0, '<EMPTY>'), 'renamePreset vs streaming-pack oracle');
});

// Case 9: an arbitrary name + FM9 model byte, validated against the
// independent streaming-packer oracle (chunked vs streaming packers
// must agree byte-for-byte).
cases.push(() => {
  const name = 'BLUES RIG 2';
  const got = buildRenamePreset(name, FM9);
  assertBytes(got, expectedNameFrame(FM9, 0x28, 0, name), `renamePreset FM9 "${name}"`);
  for (let i = 1; i < got.length - 1; i++) {
    assert((got[i] & 0x80) === 0, `rename frame byte[${i}] must be 7-bit clean`);
  }
});

// Case 10: name validation — >32 chars and non-printables refuse.
cases.push(() => {
  let threw = false;
  try {
    buildRenamePreset('X'.repeat(33), III);
  } catch {
    threw = true;
  }
  assert(threw, 'renamePreset must refuse 33-char names');
  threw = false;
  try {
    buildRenamePreset('BAD\tNAME', III);
  } catch {
    threw = true;
  }
  assert(threw, 'renamePreset must refuse non-printable chars');
});

// ─── SCENE NAMES (fn=0x01 sub=0x2b) ──────────────────────────────────────────

// Case 11: indexed scene-name write — index rides in the paramId14 field.
cases.push(() => {
  const got = buildSetSceneName(5, 'SOLO', III);
  const want = expectedNameFrame(III, 0x2b, 5, 'SOLO');
  assertBytes(got, want, 'setSceneName III scene 5 "SOLO"');
  assert(got[6] === 0x2b && got[10] === 0x05, 'sub=0x2b at byte 6, scene index at byte 10');
});

// Case 12: the editor's "Clear All Names" sequence — 8 frames, scene
// index 0..7, empty (all-spaces) name each. Frame 0 as a full literal.
cases.push(() => {
  const frames = buildClearAllSceneNames(III);
  assert(frames.length === 8, `clearAllSceneNames must emit 8 frames, got ${frames.length}`);
  const want0 = parseHex(
    'f0 00 01 74 10 01 2b 00 00 00 00 00 00 00 00 00 00 00 00 20 00 ' +
    '10 08 04 02 01 00 40 20 ' +
    '10 08 04 02 01 00 40 20 ' +
    '10 08 04 02 01 00 40 20 ' +
    '10 08 04 02 01 00 40 20 ' +
    '10 08 04 02 00 ' +
    '01 f7',
  );
  assertBytes(frames[0], want0, 'clearAllSceneNames frame 0');
  for (let i = 0; i < 8; i++) {
    assertBytes(frames[i], expectedNameFrame(III, 0x2b, i, ''), `clearAllSceneNames frame ${i}`);
    assert(frames[i][10] === i, `frame ${i} must carry scene index ${i} at byte 10`);
  }
});

// Case 13: scene index validation.
cases.push(() => {
  let threw = false;
  try {
    buildSetSceneName(8, 'X', III);
  } catch {
    threw = true;
  }
  assert(threw, 'setSceneName must refuse scene index 8');
});

// ─── SCENE-BLOB TRANSFER (fn=0x5a header, fn=0x5c trailer) ───────────────────

// Case 14: header frame — scene byte 0, 14-bit arg at bytes 1-2,
// 21-bit word count at bytes 3-5 (all septet boundaries exercised:
// arg 291 = [0x23, 0x02], wordCount 300 = [0x2c, 0x02, 0x00]).
cases.push(() => {
  const got = buildSceneBlobHeader({ scene: 3, arg14: 291, dataWordCount: 300 }, III);
  const want = parseHex('f0 00 01 74 10 5a 03 23 02 2c 02 00 43 f7');
  assertBytes(got, want, 'sceneBlobHeader III scene 3 arg 291 words 300');
});

// Case 15: header with single-septet values — field positions stay fixed.
cases.push(() => {
  const got = buildSceneBlobHeader({ scene: 0, arg14: 1, dataWordCount: 2 }, FM9);
  assert(got[5] === 0x5a, 'fn byte must be 0x5a');
  assert(got[6] === 0x00, 'scene at payload byte 0');
  assert(got[7] === 0x01 && got[8] === 0x00, 'arg14 septets at payload bytes 1-2');
  assert(got[9] === 0x02 && got[10] === 0x00 && got[11] === 0x00, 'wordCount septets at payload bytes 3-5');
  assert(got.length === 14, `header frame must be 14 bytes, got ${got.length}`);
});

// Case 16: checksum trailer — 5-septet LSB-first XOR-32, byte 4 = top
// 4 bits only ((v >>> 28) & 0x0f), per both decompiled 0x5c emitters.
cases.push(() => {
  const got = buildSceneBlobChecksum(0xdeadbeef, III);
  const want = parseHex('f0 00 01 74 10 5c 6f 7d 36 75 0d 15 f7');
  assertBytes(got, want, 'sceneBlobChecksum III 0xDEADBEEF');
});

// Case 17: xorChecksum32Words helper + round-trip into the trailer.
cases.push(() => {
  const xor = xorChecksum32Words([0xdeadbeef, 0x12345678]);
  assert(xor === 0xcc99e897, `xorChecksum32Words: expected 0xcc99e897, got 0x${xor.toString(16)}`);
  const frame = buildSceneBlobChecksum(xor, III);
  assert(frame[6] === (0xcc99e897 & 0x7f), 'trailer low septet');
  assert(frame[10] === ((0xcc99e897 >>> 28) & 0x0f), 'trailer top nibble');
  // XOR of a word with itself cancels.
  assert(xorChecksum32Words([0xdeadbeef, 0xdeadbeef]) === 0, 'xor self-cancel');
});

// Case 18: scene range validation on the header.
cases.push(() => {
  let threw = false;
  try {
    buildSceneBlobHeader({ scene: 8, arg14: 0, dataWordCount: 0 }, III);
  } catch {
    threw = true;
  }
  assert(threw, 'sceneBlobHeader must refuse scene 8');
});

export const GEN3_SUBACTION_CASE_COUNT = cases.length;

export function runGen3SubactionTests(): void {
  cases.forEach((run, i) => {
    try {
      run();
    } catch (err) {
      throw new Error(`gen-3 subaction golden case ${i + 1}/${cases.length} failed: ${(err as Error).message}`);
    }
  });
}
