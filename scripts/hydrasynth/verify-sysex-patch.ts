/**
 * Hydrasynth Explorer — golden tests for the patch byte-map encoder.
 *
 * Locks `src/asm/hydrasynth-explorer/patchEncoder.ts`:
 *
 *   - Encoding kinds (u16le / s16le / u8 / s8) write/read at the
 *     correct byte positions with correct sign-extension.
 *   - Curated `PATCH_OFFSETS` table is consistent: every name resolves
 *     in the canonical `HYDRASYNTH_NRPNS` registry; no duplicates.
 *   - The two BK-037 bipolar-bug params (filter1env1amount,
 *     filter1keytrack) land at the spec-documented byte offsets
 *     316/317 and 322/323 respectively, with `value 0` mapping to
 *     wire-center bytes after callers apply the bipolar resolver.
 *   - Round-trip: encode an override map, decode, get the same map.
 *   - Patch-name read/write at bytes 9..24 (16 chars).
 *   - Default patch buffer has spec's known-fixed bytes set
 *     (Save-to-RAM marker, version, ETCD magic bytes, the
 *     -100/-1 alternation at 2390..2399).
 *   - Chunk split/concat round-trip is exact across 22 chunks.
 *   - Spec-documented byte windows from the "Sawpressive GD" patch
 *     trace (chunk 0, chunk 1) decode to the documented values.
 *
 * Run:  npx tsx scripts/hydrasynth/verify-sysex-patch.ts
 *       (or via `npm test`).
 */
import {
  PATCH_BUFFER_SIZE,
  PATCH_CHUNK_COUNT,
  PATCH_CHUNK_SIZE,
  PATCH_LAST_CHUNK_SIZE,
  PATCH_OFFSETS,
  PATCH_META,
  PATCH_MAGIC_BYTES,
  PATCH_NAME,
  type PatchOffsetSpec,
  findPatchOffset,
  writePatchValue,
  readPatchValue,
  encodePatch,
  decodePatch,
  defaultPatchBuffer,
  writePatchName,
  readPatchName,
  splitIntoChunks,
  concatChunks,
  unmappedPatchOffsets,
} from '@mcp-midi-control/hydrasynth/patchEncoder.js';

interface Case {
  label: string;
  fn: () => boolean | string;
}

const cases: Case[] = [];

function check(label: string, fn: () => boolean | string): void {
  cases.push({ label, fn });
}

function eq<T>(actual: T, expected: T, ctx = ''): boolean | string {
  if (actual === expected) return true;
  return `${ctx ? ctx + ': ' : ''}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

function deepEqBytes(actual: ArrayLike<number>, expected: ArrayLike<number>, ctx = ''): boolean | string {
  if (actual.length !== expected.length) {
    return `${ctx}: length mismatch — expected ${expected.length}, got ${actual.length}`;
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      return `${ctx}: byte ${i} mismatch — expected 0x${expected[i].toString(16).padStart(2, '0')}, got 0x${actual[i].toString(16).padStart(2, '0')}`;
    }
  }
  return true;
}

function buildSpec(name: string): PatchOffsetSpec {
  const s = findPatchOffset(name);
  if (!s) throw new Error(`PATCH_OFFSETS missing "${name}" — extend the table`);
  return s;
}

// ---------------------------------------------------------------------------
// Constants sanity.
// ---------------------------------------------------------------------------

check('PATCH_BUFFER_SIZE = 21*128 + 102 = 2790 (matches spec chunk math)', () => {
  return PATCH_BUFFER_SIZE === 21 * PATCH_CHUNK_SIZE + PATCH_LAST_CHUNK_SIZE
    ? true : `got ${PATCH_BUFFER_SIZE}`;
});

check('PATCH_CHUNK_COUNT = 22 (21 full + 1 short)', () => {
  return PATCH_CHUNK_COUNT === 22 ? true : `got ${PATCH_CHUNK_COUNT}`;
});

// ---------------------------------------------------------------------------
// PATCH_OFFSETS table consistency.
// ---------------------------------------------------------------------------

check('PATCH_OFFSETS: every name resolves in the canonical NRPN registry', () => {
  const orphans = unmappedPatchOffsets();
  return orphans.length === 0
    ? true : `orphaned: ${orphans.join(', ')}`;
});

check('PATCH_OFFSETS: no duplicate names (lookup table built without throwing)', () => {
  // Constructor would have thrown if a duplicate existed — but we
  // also explicitly verify here so the reason is loud if it ever does.
  const seen = new Set<string>();
  for (const s of PATCH_OFFSETS) {
    if (seen.has(s.name)) return `duplicate: ${s.name}`;
    seen.add(s.name);
  }
  return true;
});

check('PATCH_OFFSETS: every offset within buffer bounds', () => {
  for (const s of PATCH_OFFSETS) {
    if (s.byte < 0 || s.byte + 1 >= PATCH_BUFFER_SIZE) {
      return `${s.name} byte=${s.byte} out of bounds`;
    }
  }
  return true;
});

// ---------------------------------------------------------------------------
// Low-level encoding kinds.
// ---------------------------------------------------------------------------

// u16le — used by all 14-bit linear params. Values are NRPN WIRE
// (0..8192 typical, 0..16383 for full 14-bit). Encoder writes wire/8 to
// the bytes per BK-036.5 — confirmed against INIT_PATCH_BUFFER bytes
// (Session 39): every u16le param in the factory INIT lands at
// `wire/8` of its sensible default.
check('u16le: filter1cutoff wire=4096 (display 64.0) → bytes 310,311 = 0x00,0x02 (= patch 512)', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('filter1cutoff'), 4096);
  if (buf[310] !== 0x00 || buf[311] !== 0x02) {
    return `got [${buf[310].toString(16)}, ${buf[311].toString(16)}]`;
  }
  return readPatchValue(buf, buildSpec('filter1cutoff')) === 4096
    ? true : `read-back mismatch`;
});

check('u16le: filter1cutoff max wire=8192 → bytes 0x00,0x04 (= patch 1024, INIT default)', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('filter1cutoff'), 8192);
  const back = readPatchValue(buf, buildSpec('filter1cutoff'));
  return back === 8192 && buf[310] === 0x00 && buf[311] === 0x04
    ? true : `back=${back} bytes=${buf[310].toString(16)},${buf[311].toString(16)}`;
});

check('u16le: filter1cutoff wire=0 → bytes 0x00,0x00 (= patch 0)', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('filter1cutoff'), 0);
  return buf[310] === 0x00 && buf[311] === 0x00 && readPatchValue(buf, buildSpec('filter1cutoff')) === 0
    ? true : `bytes=[${buf[310]},${buf[311]}]`;
});

check('u16le: rejects negative values', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  try {
    writePatchValue(buf, buildSpec('filter1cutoff'), -1);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && e.message.includes('out of range')
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

check('u16le: non-multiple-of-8 wire value rounds to nearest (spec note: "increments of 8")', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  // Wire 2500 → /8 = 312.5 → rounds to 313. Read back: 313*8 = 2504.
  // The 0.5 ULP loss is unavoidable — the patch buffer literally can't
  // represent finer granularity. Confirms rounding (not truncation).
  writePatchValue(buf, buildSpec('filter1resonance'), 2500);
  const back = readPatchValue(buf, buildSpec('filter1resonance'));
  return back === 2504 ? true : `back=${back}`;
});

// s8 — single signed byte with sign-extension.
check('s8: osc1semi value=+12 → byte 84=0x0C, byte 85=0x00 (no sign-extend)', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('osc1semi'), 12);
  return buf[84] === 0x0c && buf[85] === 0x00
    ? true : `got [${buf[84].toString(16)}, ${buf[85].toString(16)}]`;
});

check('s8: osc1semi value=-1 → byte 84=0xFF, byte 85=0xFF (sign-extended)', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('osc1semi'), -1);
  return buf[84] === 0xff && buf[85] === 0xff
    ? true : `got [${buf[84].toString(16)}, ${buf[85].toString(16)}]`;
});

check('s8: osc1semi value=-36 → byte 84=0xDC, byte 85=0xFF (sign-extended)', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('osc1semi'), -36);
  return buf[84] === 0xdc && buf[85] === 0xff
    ? true : `got [${buf[84].toString(16)}, ${buf[85].toString(16)}]`;
});

check('s8: osc1semi -36 round-trips through read', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('osc1semi'), -36);
  return readPatchValue(buf, buildSpec('osc1semi')) === -36
    ? true : 'mismatch';
});

check('s8: rejects values outside -128..127', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  try { writePatchValue(buf, buildSpec('osc1semi'), 128); return 'should throw on 128'; }
  catch (e) { /* expected */ }
  try { writePatchValue(buf, buildSpec('osc1semi'), -129); return 'should throw on -129'; }
  catch (e) { /* expected */ }
  return true;
});

// s16le — signed 16-bit (osc1cent uses this for the -50..+50 ring).
check('s16le: osc1cent value=+50 → byte 86=0x32, byte 87=0x00', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('osc1cent'), 50);
  return buf[86] === 0x32 && buf[87] === 0x00
    ? true : `got [${buf[86].toString(16)}, ${buf[87].toString(16)}]`;
});

check('s16le: osc1cent value=-1 → bytes 0xFF 0xFF (full sign extension)', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('osc1cent'), -1);
  return buf[86] === 0xff && buf[87] === 0xff
    ? true : `got [${buf[86].toString(16)}, ${buf[87].toString(16)}]`;
});

check('s16le: osc1cent -50 round-trips', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('osc1cent'), -50);
  return readPatchValue(buf, buildSpec('osc1cent')) === -50
    ? true : 'mismatch';
});

// u8 — single unsigned byte.
check('u8: filter1type value=10 (Vowel) → byte 308=10, byte 309=0', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('filter1type'), 10);
  return buf[308] === 10 && buf[309] === 0
    ? true : `got [${buf[308]}, ${buf[309]}]`;
});

// ---------------------------------------------------------------------------
// BK-037 bipolar bug params land at the spec offsets (316, 322).
// ---------------------------------------------------------------------------

check('filter1env1amount mapped to byte 316 (low)/317 (high) per spec line 433', () => {
  const s = buildSpec('filter1env1amount');
  return s.byte === 316 && s.enc === 'u16le'
    ? true : `got byte=${s.byte} enc=${s.enc}`;
});

check('filter1keytrack mapped to byte 322 (low)/323 (high) per spec line 439', () => {
  const s = buildSpec('filter1keytrack');
  return s.byte === 322 && s.enc === 'u16le'
    ? true : `got byte=${s.byte} enc=${s.enc}`;
});

check('bipolar: filter1env1amount wire 4096 (display 0) → bytes 0x00, 0x02 at 316/317 (patch byte 512 = spec bipolar center)', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('filter1env1amount'), 4096);
  return buf[316] === 0x00 && buf[317] === 0x02
    ? true : `got [${buf[316].toString(16)}, ${buf[317].toString(16)}]`;
});

check('bipolar: filter1keytrack wire 4096 (display 0%) → bytes 0x00, 0x02 at 322/323', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('filter1keytrack'), 4096);
  return buf[322] === 0x00 && buf[323] === 0x02
    ? true : `got [${buf[322].toString(16)}, ${buf[323].toString(16)}]`;
});

// Lock the original Van Halen "Jump" silence regression: wire 768
// = display -52 (the bug case from BK-037). Encoder must round-trip
// the WIRE value (encoder applies /8 internally).
check('regression: filter1env1amount wire 768 (display -52) round-trips through wire-in encoder', () => {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  writePatchValue(buf, buildSpec('filter1env1amount'), 768);
  // 768 / 8 = 96 → bytes 0x60, 0x00
  if (buf[316] !== 0x60 || buf[317] !== 0x00) {
    return `got [${buf[316].toString(16)}, ${buf[317].toString(16)}]`;
  }
  return readPatchValue(buf, buildSpec('filter1env1amount')) === 768
    ? true : 'read-back mismatch';
});

// BK-036.5 hypothesis confirmation: factory INIT bytes for the curated
// filter/amp/mixer u16le params decode to the sensible display defaults
// when read through the wire-in decoder. This locks the universal /8
// rule against the bundled INIT_PATCH_BUFFER — if a future encoder
// regression breaks scaling, this is the canary.
check('INIT_PATCH_BUFFER: filter1cutoff decodes to wire 8192 (display 128.0 max)', () => {
  const init = defaultPatchBuffer();
  const wire = readPatchValue(init, buildSpec('filter1cutoff'));
  return wire === 8192 ? true : `got wire=${wire}`;
});

check('INIT_PATCH_BUFFER: filter1env1amount decodes to wire 4096 (bipolar display 0)', () => {
  const init = defaultPatchBuffer();
  const wire = readPatchValue(init, buildSpec('filter1env1amount'));
  return wire === 4096 ? true : `got wire=${wire}`;
});

check('INIT_PATCH_BUFFER: filter1keytrack decodes to wire 6144 (display +100%)', () => {
  const init = defaultPatchBuffer();
  const wire = readPatchValue(init, buildSpec('filter1keytrack'));
  return wire === 6144 ? true : `got wire=${wire}`;
});

check('INIT_PATCH_BUFFER: amplevel decodes to wire 4096 (display 64.0 mid)', () => {
  const init = defaultPatchBuffer();
  const wire = readPatchValue(init, buildSpec('amplevel'));
  return wire === 4096 ? true : `got wire=${wire}`;
});

check('INIT_PATCH_BUFFER: mixerosc1vol decodes to wire 8192 (display 128.0 full)', () => {
  const init = defaultPatchBuffer();
  const wire = readPatchValue(init, buildSpec('mixerosc1vol'));
  return wire === 8192 ? true : `got wire=${wire}`;
});

check('INIT_PATCH_BUFFER: env1sustain decodes to wire 8192 (display 128.0 full sustain)', () => {
  const init = defaultPatchBuffer();
  const wire = readPatchValue(init, buildSpec('env1sustain'));
  return wire === 8192 ? true : `got wire=${wire}`;
});

// ---------------------------------------------------------------------------
// encodePatch / decodePatch round-trip.
// ---------------------------------------------------------------------------

check('encodePatch: applies overrides on default buffer; unspecified params stay default', () => {
  const overrides = new Map<string, number>([
    ['filter1cutoff', 4096],     // wire (display 64.0)
    ['filter1resonance', 1024],  // wire (display 16.0)
    ['amplevel', 8192],          // wire (display 128.0 max)
  ]);
  const buf = encodePatch(overrides);
  if (readPatchValue(buf, buildSpec('filter1cutoff')) !== 4096) return 'cutoff';
  if (readPatchValue(buf, buildSpec('filter1resonance')) !== 1024) return 'resonance';
  if (readPatchValue(buf, buildSpec('amplevel')) !== 8192) return 'amplevel';
  // Unspecified bipolar param stays at the default value from the factory
  // INIT (filter1env1amount = 512 patch byte in INIT_PATCH_BUFFER ⇒ wire 4096).
  if (readPatchValue(buf, buildSpec('filter1env1amount')) !== 4096) return 'env1 amount drifted from INIT';
  // Magic bytes preserved from default.
  if (buf[1766] !== 69 || buf[1767] !== 84 || buf[1768] !== 67 || buf[1769] !== 68) {
    return 'magic bytes corrupted by encodePatch';
  }
  return true;
});

check('encodePatch: rejects unknown param name with helpful error', () => {
  try {
    encodePatch(new Map([['totally_made_up_param', 42]]));
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && e.message.includes('totally_made_up_param') && e.message.includes('PATCH_OFFSETS')
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

check('encodePatch: rejects base buffer of wrong size', () => {
  try {
    encodePatch(new Map(), { base: new Uint8Array(100) });
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && e.message.includes('2790')
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

check('encodePatch: does not mutate input base buffer', () => {
  const base = defaultPatchBuffer();
  const beforeByte310 = base[310];
  encodePatch(new Map([['filter1cutoff', 4096]]), { base });
  return base[310] === beforeByte310
    ? true : `base mutated: byte 310 was ${beforeByte310}, now ${base[310]}`;
});

check('decodePatch: returns map containing every PATCH_OFFSETS name', () => {
  const buf = encodePatch(new Map([['filter1cutoff', 4096], ['amplevel', 8192]]));
  const params = decodePatch(buf);
  for (const spec of PATCH_OFFSETS) {
    if (!params.has(spec.name)) return `missing ${spec.name}`;
  }
  return params.get('filter1cutoff') === 4096 && params.get('amplevel') === 8192
    ? true : 'override values not in decoded map';
});

check('round-trip: encode → decode → encode is byte-stable for a 12-param override', () => {
  // Wire values for u16le must be multiples of 8 to round-trip exactly
  // (the patch buffer literally can't represent finer granularity per
  // the spec note "[0,8192] seemingly only output in increments of 8").
  // Display authors don't see this — they pass display values which the
  // tool layer routes through resolveNrpnValue, which always produces
  // multiples of 8 wire from clean integer display inputs.
  const overrides = new Map<string, number>([
    ['osc1mode', 0],
    ['osc1type', 5],
    ['osc1semi', -12],
    ['osc1cent', -25],
    ['filter1type', 10],
    ['filter1cutoff', 6000],       // wire (display 93.75) — multiple of 8
    ['filter1resonance', 2496],    // wire (display 39.0) — multiple of 8
    ['filter1env1amount', 4864],   // wire bipolar +12 (display)
    ['filter1keytrack', 6144],     // wire bipolar +100%
    ['amplevel', 7000],            // wire — multiple of 8
    ['env1sustain', 8192],         // wire max
    ['env1atkcurve', -50],         // s8 negative
  ]);
  const buf1 = encodePatch(overrides);
  const decoded = decodePatch(buf1);
  // Compare each override value made it back.
  for (const [name, expected] of overrides) {
    if (decoded.get(name) !== expected) {
      return `${name}: expected ${expected}, decoded ${decoded.get(name)}`;
    }
  }
  // Re-encoding the decoded map yields the same bytes.
  const buf2 = encodePatch(decoded);
  return deepEqBytes(buf1, buf2, 'second-pass encode');
});

// ---------------------------------------------------------------------------
// Patch-name helpers.
// ---------------------------------------------------------------------------

check('writePatchName: "Sawpressive GD" lands at bytes 9..22 with trailing zero', () => {
  const buf = defaultPatchBuffer();
  writePatchName(buf, 'Sawpressive GD');
  // Spec line 211: chunk 0 of Sawpressive starts with metadata then
  // "53 61 77 70 72 65 73 73 69 76 65 20 47 44 00" at the name region.
  const expected = [
    0x53, 0x61, 0x77, 0x70, 0x72, 0x65, 0x73, 0x73,
    0x69, 0x76, 0x65, 0x20, 0x47, 0x44, 0x00, 0x00,
  ];
  for (let i = 0; i < expected.length; i++) {
    if (buf[PATCH_NAME.startByte + i] !== expected[i]) {
      return `byte ${PATCH_NAME.startByte + i} expected 0x${expected[i].toString(16)}, got 0x${buf[PATCH_NAME.startByte + i].toString(16)}`;
    }
  }
  return true;
});

check('readPatchName: round-trips "Hello"', () => {
  const buf = defaultPatchBuffer();
  writePatchName(buf, 'Hello');
  return readPatchName(buf) === 'Hello' ? true : `got "${readPatchName(buf)}"`;
});

check('writePatchName: truncates to 16 chars', () => {
  const buf = defaultPatchBuffer();
  writePatchName(buf, 'TwentyCharacterName_');
  return readPatchName(buf) === 'TwentyCharacterN'
    ? true : `got "${readPatchName(buf)}"`;
});

check('writePatchName: rejects non-ASCII char', () => {
  const buf = defaultPatchBuffer();
  try {
    writePatchName(buf, 'Hellö');
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && e.message.includes('non-ASCII')
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

// ---------------------------------------------------------------------------
// Default patch buffer has the spec's known-fixed bytes.
// ---------------------------------------------------------------------------

check('defaultPatchBuffer: byte 0 = 0x06 (Save to RAM)', () => {
  return defaultPatchBuffer()[PATCH_META.saveMarker] === 0x06 ? true : 'mismatch';
});

check('defaultPatchBuffer: byte 4 = 0xa0 (factory INIT firmware tag)', () => {
  // The bundled `Single INIT Bank.hydra` was developed against firmware
  // 1.6.0 (byte 4 = 0xa0) — undocumented in the spec but valid per
  // SysexPatchFormat.txt line 99 ("other version numbers ... mostly
  // from patches developed in-house at ASM"). Spec versions: 1.5.5=0x9b,
  // 2.0.0=0xc8, 2.2.0=0xdc.
  return defaultPatchBuffer()[PATCH_META.version] === 0xa0 ? true : 'mismatch';
});

check('defaultPatchBuffer: bytes 1766..1769 = 69, 84, 67, 68 (ETCD magic)', () => {
  const buf = defaultPatchBuffer();
  for (let i = 0; i < PATCH_MAGIC_BYTES.offsets.length; i++) {
    if (buf[PATCH_MAGIC_BYTES.offsets[i]] !== PATCH_MAGIC_BYTES.defaults[i]) {
      return `byte ${PATCH_MAGIC_BYTES.offsets[i]}: expected ${PATCH_MAGIC_BYTES.defaults[i]}, got ${buf[PATCH_MAGIC_BYTES.offsets[i]]}`;
    }
  }
  return true;
});

check('defaultPatchBuffer: bytes 2390..2399 = -100,-1,-100,-1,... (signed 8-bit)', () => {
  const buf = defaultPatchBuffer();
  for (let i = 0; i < 10; i++) {
    const expected = i % 2 === 0 ? 0x9c : 0xff; // -100 = 0x9C, -1 = 0xFF
    if (buf[2390 + i] !== expected) {
      return `byte ${2390 + i}: expected 0x${expected.toString(16)}, got 0x${buf[2390 + i].toString(16)}`;
    }
  }
  return true;
});

check('defaultPatchBuffer: exactly PATCH_BUFFER_SIZE bytes', () => {
  return defaultPatchBuffer().length === PATCH_BUFFER_SIZE ? true : 'mismatch';
});

// ---------------------------------------------------------------------------
// Wire-chunking — split / concat round-trip.
// ---------------------------------------------------------------------------

check('splitIntoChunks: produces 22 chunks with correct sizes', () => {
  const buf = defaultPatchBuffer();
  const chunks = splitIntoChunks(buf);
  if (chunks.length !== PATCH_CHUNK_COUNT) return `count=${chunks.length}`;
  for (let i = 0; i < 21; i++) {
    if (chunks[i].info.length !== 4 + PATCH_CHUNK_SIZE) {
      return `chunk ${i} info size = ${chunks[i].info.length}`;
    }
    if (chunks[i].index !== i) return `chunk ${i} index = ${chunks[i].index}`;
  }
  if (chunks[21].info.length !== 4 + PATCH_LAST_CHUNK_SIZE) {
    return `last chunk size ${chunks[21].info.length}`;
  }
  return true;
});

check('splitIntoChunks: chunk header is [0x16, 0x00, CHUNK, 0x16]', () => {
  const buf = defaultPatchBuffer();
  const chunks = splitIntoChunks(buf);
  for (const c of chunks) {
    if (c.info[0] !== 0x16 || c.info[1] !== 0x00 || c.info[2] !== c.index || c.info[3] !== 0x16) {
      return `chunk ${c.index} header [${c.info[0].toString(16)}, ${c.info[1].toString(16)}, ${c.info[2].toString(16)}, ${c.info[3].toString(16)}]`;
    }
  }
  return true;
});

check('splitIntoChunks then concatChunks: byte-exact round-trip on default buffer', () => {
  const buf = defaultPatchBuffer();
  const chunks = splitIntoChunks(buf);
  const back = concatChunks(chunks);
  return deepEqBytes(back, buf, 'round-trip');
});

check('splitIntoChunks then concatChunks: byte-exact round-trip on a populated buffer', () => {
  const buf = encodePatch(new Map<string, number>([
    ['filter1cutoff', 6000],        // wire — multiple of 8
    ['filter1env1amount', 5504],    // wire — multiple of 8
    ['osc1semi', -7],
    ['amplevel', 7000],             // wire — multiple of 8
  ]));
  writePatchName(buf, 'TestPatch01');
  const chunks = splitIntoChunks(buf);
  const back = concatChunks(chunks);
  return deepEqBytes(back, buf, 'populated round-trip');
});

check('concatChunks: rejects wrong chunk count', () => {
  const chunks = splitIntoChunks(defaultPatchBuffer()).slice(0, 21);
  try {
    concatChunks(chunks);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && e.message.includes('22 chunks')
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

check('concatChunks: rejects out-of-order chunk index', () => {
  const chunks = splitIntoChunks(defaultPatchBuffer());
  // Swap chunks 0 and 1 (by reassigning index but keeping data in place
  // would change semantics — instead just relabel chunk 0 as index 5).
  const bad = [...chunks];
  bad[0] = { ...bad[0], index: 5 };
  try {
    concatChunks(bad);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && e.message.includes('wrong index')
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

// ---------------------------------------------------------------------------
// Spec-documented byte windows from "Sawpressive GD" patch trace.
//
// SysexEncoding.txt §"REQUESTING A SINGLE PATCH" gives chunk 0:
//   16 00 00 16 05 00 00 00 9B 00 00 00 0D 53 61 77
//   70 72 65 73 73 69 76 65 20 47 44 00 20 00 20 00
//   B0 04 00 00 04 00 20 00 00 00 00 00 00 00 00 00 ...
//
// Mapping the documented header bytes back to PATCH_META and the
// patch-name region:
//   byte 0    = 0x05  ("Receive from RAM" marker — note: spec lists
//                      0x06 as the "Save to RAM" marker; 0x05 appears
//                      in dump traffic. defaultPatchBuffer uses 0x06
//                      since we're constructing a write.)
//   byte 4    = 0x9B  (firmware version 1.5.5 — Sawpressive was
//                      developed on 1.5.5; we default to 0xC8 = 2.0.0)
//   byte 9..  = "Sawpressive GD" patch name
// ---------------------------------------------------------------------------

const SAWPRESSIVE_FIRST_48_BYTES = [
  // header from chunk 0:
  0x05, 0x00, 0x00, 0x00, 0x9b, 0x00, 0x00, 0x00,
  // category + name:
  0x0d, 0x53, 0x61, 0x77, 0x70, 0x72, 0x65, 0x73,
  0x73, 0x69, 0x76, 0x65, 0x20, 0x47, 0x44, 0x00,
  // post-name region:
  0x20, 0x00, 0x20, 0x00, 0xb0, 0x04, 0x00, 0x00,
  0x04, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00,
];

check('spec trace: Sawpressive header byte 4 (firmware) = 0x9B (1.5.5)', () => {
  return SAWPRESSIVE_FIRST_48_BYTES[PATCH_META.version] === 0x9b
    ? true : 'spec data wrong';
});

check('spec trace: read patch name from Sawpressive bytes → "Sawpressive GD"', () => {
  // Build a buffer with just the spec's first 48 bytes copied in.
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  buf.set(SAWPRESSIVE_FIRST_48_BYTES, 0);
  return readPatchName(buf) === 'Sawpressive GD'
    ? true : `got "${readPatchName(buf)}"`;
});

check('spec trace: byte 8 (Category) of Sawpressive = 13 (0x0D)', () => {
  // Spec note line 125: "Category [goes 1-32, not 0-31]". Sawpressive
  // shows 0x0D = 13 in chunk 0 byte 8.
  return SAWPRESSIVE_FIRST_48_BYTES[8] === 13 ? true : 'mismatch';
});

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

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
  console.log(`✓ ${passed}/${cases.length} hydrasynth sysex-patch cases pass.`);
} else {
  console.error(`${passed}/${cases.length} pass; ${failed} fail:\n`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
