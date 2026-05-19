/**
 * Hydrasynth Explorer — diagnostic for the Session 48 ambient-pad bug
 * "patch name didn't land on the device" report.
 *
 * Strategy:
 *   1. Round-trip a patch name through `encodePatch({}, { name })`
 *      and `readPatchName(buf)` — exercises writePatchName + the
 *      `encodePatch` plumbing that hands `name` through to it.
 *   2. Verify the bytes written to bytes 9..24 match expected ASCII +
 *      zero-padding semantics.
 *   3. Verify that splitting the resulting buffer into chunks places
 *      the name bytes in chunk 0 (bytes 0..127) — so the device receives
 *      them as part of the patch dump, not lost between chunks.
 *
 * If this script's checks all pass locally, the issue is on the wire
 * side (e.g. a follow-up SysEx that overwrites bytes 9..24, or the
 * device caching the displayed name from flash rather than re-reading
 * working memory after our dump).
 *
 * Run:  npx tsx scripts/hydrasynth/test-patch-name.ts
 */
import {
  PATCH_BUFFER_SIZE,
  PATCH_NAME,
  encodePatch,
  readPatchName,
  splitIntoChunks,
} from '@mcp-midi-control/hydrasynth/patchEncoder.js';

interface Case {
  label: string;
  fn: () => boolean | string;
}

const cases: Case[] = [];

function check(label: string, fn: () => boolean | string): void {
  cases.push({ label, fn });
}

check('encodePatch({}, { name: "Eno Wash" }) round-trips through readPatchName', () => {
  const buf = encodePatch(new Map(), { name: 'Eno Wash' });
  const back = readPatchName(buf);
  return back === 'Eno Wash' ? true : `got "${back}"`;
});

check('encodePatch({}, { name: "TestName" }) places "T" at byte 9, "e" at 10, etc.', () => {
  const buf = encodePatch(new Map(), { name: 'TestName' });
  const expected = 'TestName';
  for (let i = 0; i < expected.length; i++) {
    if (buf[PATCH_NAME.startByte + i] !== expected.charCodeAt(i)) {
      return `byte ${PATCH_NAME.startByte + i} expected '${expected[i]}' (0x${expected.charCodeAt(i).toString(16)}), got 0x${buf[PATCH_NAME.startByte + i].toString(16)}`;
    }
  }
  // Beyond the 8 chars of "TestName", zero-pad up to 16.
  for (let i = expected.length; i < PATCH_NAME.maxLength; i++) {
    if (buf[PATCH_NAME.startByte + i] !== 0) {
      return `byte ${PATCH_NAME.startByte + i} expected 0 (zero pad), got 0x${buf[PATCH_NAME.startByte + i].toString(16)}`;
    }
  }
  return true;
});

check('encodePatch with name + filter override: both land independently', () => {
  const buf = encodePatch(new Map([['filter1cutoff', 4096]]), { name: 'Combo' });
  const name = readPatchName(buf);
  if (name !== 'Combo') return `name: "${name}"`;
  // Bytes 310/311 should be filter1cutoff wire 4096 → patch 512 → 0x00, 0x02.
  return buf[310] === 0x00 && buf[311] === 0x02 ? true : `bytes [${buf[310]}, ${buf[311]}]`;
});

check('splitIntoChunks places bytes 9..24 inside chunk 0', () => {
  const buf = encodePatch(new Map(), { name: 'Eno Wash' });
  const chunks = splitIntoChunks(buf);
  // Chunk 0 has data at info[4..132). Byte 9 of the buffer = info[4+9] = info[13].
  const chunk0Data = chunks[0]!.info.subarray(4); // strip [0x16, 0x00, 0x00, 0x16] header
  // First 8 chars of "Eno Wash" should appear at offsets 9..16 of chunk0 data.
  const expectedStart = 'Eno Wash';
  for (let i = 0; i < expectedStart.length; i++) {
    if (chunk0Data[PATCH_NAME.startByte + i] !== expectedStart.charCodeAt(i)) {
      return `chunk0 byte ${PATCH_NAME.startByte + i}: expected '${expectedStart[i]}', got 0x${chunk0Data[PATCH_NAME.startByte + i].toString(16)}`;
    }
  }
  return true;
});

check('encodePatch without name leaves INIT default name "Init" intact', () => {
  // INIT_PATCH_BUFFER has "Init" at bytes 9-12 followed by null + spaces.
  const buf = encodePatch(new Map([['filter1cutoff', 4096]]));
  return readPatchName(buf) === 'Init' ? true : `got "${readPatchName(buf)}"`;
});

check('long name truncates to 16 chars (no overflow into byte 25)', () => {
  // A 20-char name should write only the first 16 chars (bytes 9..24).
  // Byte 25 should be untouched (UNNOWN per spec line 142). Verify by
  // comparing with the INIT default at byte 25.
  const initByte25 = encodePatch(new Map())[25]; // baseline from INIT
  const buf = encodePatch(new Map(), { name: 'TwentyCharacterName_' });
  if (buf[25] !== initByte25) {
    return `byte 25 mutated: was 0x${initByte25.toString(16)}, now 0x${buf[25].toString(16)}`;
  }
  return readPatchName(buf) === 'TwentyCharacterN' ? true : `got "${readPatchName(buf)}"`;
});

check('buffer length stays exactly PATCH_BUFFER_SIZE after name write', () => {
  const buf = encodePatch(new Map(), { name: 'TestName' });
  return buf.length === PATCH_BUFFER_SIZE ? true : `got ${buf.length}`;
});

let passed = 0;
let failed = 0;
const failures: string[] = [];

for (const c of cases) {
  let result: boolean | string;
  try {
    result = c.fn();
  } catch (err) {
    result = err instanceof Error ? `threw: ${err.message}` : String(err);
  }
  if (result === true) {
    passed++;
  } else {
    failed++;
    failures.push(`✗ ${c.label}\n    ${result}`);
  }
}

if (failed === 0) {
  console.log(`✓ ${passed}/${cases.length} hydrasynth patch-name round-trip cases pass.`);
} else {
  console.error(`${passed}/${cases.length} pass; ${failed} fail:\n`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
