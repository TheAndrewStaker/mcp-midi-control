/**
 * Hydrasynth Explorer — golden tests for the SysEx envelope codec.
 *
 * Locks `src/asm/hydrasynth-explorer/sysexEnvelope.ts` against the
 * worked example and inner-message vocabulary documented in
 * `docs/devices/hydrasynth-explorer/references/SysexEncoding.txt`
 * (edisyn, Sean Luke, May 2023).
 *
 * The byte-exact case to beat is the spec's "Request Dump of Bank A
 * Patch 128" example: info = 04 00 00 7F → wrapped F0 00 20 2B 00 6F
 * 47 64 74 6A 6B 51 51 41 41 48 38 3D F7. Round-trip cases also
 * exercise every short message the device protocol uses (handshake,
 * header/footer, chunk dump+ack, write/footer responses) plus a
 * 128-byte payload to mirror the chunk-dump size we'll be sending
 * during patch writes.
 *
 * Run:  npx tsx scripts/hydrasynth/verify-sysex-envelope.ts
 *       (or via `npm test`).
 */
import {
  wrapSysex,
  unwrapSysex,
  __internal,
} from '@mcp-midi-control/hydrasynth/sysexEnvelope.js';

interface Case {
  label: string;
  fn: () => boolean | string;
}

const cases: Case[] = [];

function check(label: string, fn: () => boolean | string): void {
  cases.push({ label, fn });
}

function deepEqBytes(actual: ArrayLike<number>, expected: ArrayLike<number>): boolean | string {
  if (actual.length !== expected.length) {
    return `length mismatch: expected ${expected.length}, got ${actual.length}\n` +
      `  expected: ${hexDump(expected)}\n` +
      `  actual:   ${hexDump(actual)}`;
  }
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      return `byte ${i} mismatch: expected 0x${expected[i].toString(16).padStart(2, '0').toUpperCase()}, got 0x${actual[i].toString(16).padStart(2, '0').toUpperCase()}\n` +
        `  expected: ${hexDump(expected)}\n` +
        `  actual:   ${hexDump(actual)}`;
    }
  }
  return true;
}

function hexDump(b: ArrayLike<number>): string {
  return Array.from(b as ArrayLike<number>, n =>
    n.toString(16).padStart(2, '0').toUpperCase(),
  ).join(' ');
}

function bytes(...vs: number[]): Uint8Array {
  return Uint8Array.from(vs);
}

// ---------------------------------------------------------------------------
// CRC-32 spot checks (sanity for the polynomial implementation).
// ---------------------------------------------------------------------------

// Standard zlib/IEEE 802.3 CRC-32 reference values.
check('crc32: empty bytes → 0x00000000', () => {
  return __internal.crc32(new Uint8Array(0)) === 0x00000000
    ? true : `got 0x${__internal.crc32(new Uint8Array(0)).toString(16)}`;
});
check('crc32: "123456789" ASCII → 0xCBF43926 (canonical CRC-32 check value)', () => {
  const ascii = Uint8Array.from([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
  return __internal.crc32(ascii) === 0xcbf43926
    ? true : `got 0x${__internal.crc32(ascii).toString(16)}`;
});

// The spec's worked example: CRC-32 of [04 00 00 7F] = 0x6E9C24E6.
// Backed out from the documented checksum bytes 19 DB 63 91:
//   0xFF-0x19=0xE6, 0xFF-0xDB=0x24, 0xFF-0x63=0x9C, 0xFF-0x91=0x6E
//   reversed = 6E 9C 24 E6 (AA BB CC DD)
check('crc32: spec example [04 00 00 7F] → 0x6E9C24E6', () => {
  const got = __internal.crc32(bytes(0x04, 0x00, 0x00, 0x7f));
  return got === 0x6e9c24e6
    ? true : `got 0x${got.toString(16).toUpperCase()}`;
});

check('checksumBytes: [04 00 00 7F] → 19 DB 63 91 (per spec)', () => {
  const c = __internal.checksumBytes(bytes(0x04, 0x00, 0x00, 0x7f));
  return deepEqBytes(c, [0x19, 0xdb, 0x63, 0x91]);
});

// ---------------------------------------------------------------------------
// Byte-exact wrapping per the spec's worked example.
// ---------------------------------------------------------------------------

// SysexEncoding.txt lines 46–60. INFO = 04 00 00 7F encodes to the
// base64 string "GdtjkQQAAH8=" which has ASCII bytes
//   47 64 74 6A 6B 51 51 41 41 48 38 3D
const SPEC_EXAMPLE_INFO = bytes(0x04, 0x00, 0x00, 0x7f);
const SPEC_EXAMPLE_WRAPPED = [
  0xf0, 0x00, 0x20, 0x2b, 0x00, 0x6f,
  0x47, 0x64, 0x74, 0x6a, 0x6b, 0x51, 0x51, 0x41, 0x41, 0x48, 0x38, 0x3d,
  0xf7,
];

check('wrapSysex: spec example "Request Bank 0 Patch 127" byte-exact', () => {
  const wrapped = wrapSysex(SPEC_EXAMPLE_INFO);
  return deepEqBytes(wrapped, SPEC_EXAMPLE_WRAPPED);
});

check('unwrapSysex: spec example reverses to original info bytes', () => {
  const info = unwrapSysex(SPEC_EXAMPLE_WRAPPED);
  return deepEqBytes(info, SPEC_EXAMPLE_INFO);
});

// Worked example also embeds the base64 string "GdtjkQQAAH8=" between
// the header and footer; verify the base64 ASCII is exactly what we
// emit (no padding/encoding drift).
check('wrapSysex: ASCII-decoded payload matches "GdtjkQQAAH8="', () => {
  const wrapped = wrapSysex(SPEC_EXAMPLE_INFO);
  const ascii = String.fromCharCode(...wrapped.slice(6, -1));
  return ascii === 'GdtjkQQAAH8='
    ? true : `got "${ascii}"`;
});

// ---------------------------------------------------------------------------
// Round-trip cases for every short protocol message in the spec.
// SysexEncoding.txt §HANDSHAKING and the various flow sections enumerate
// these; we don't have wire-byte traces for them, so the goldens lock
// the round-trip property and the envelope header/footer.
// ---------------------------------------------------------------------------

const PROTOCOL_MESSAGES: Array<[string, number[]]> = [
  ['handshake (00 00)',                      [0x00, 0x00]],
  ['handshake response prefix (01 00)',      [0x01, 0x00]],
  ['version request (28 00)',                [0x28, 0x00]],
  ['header (18 00)',                         [0x18, 0x00]],
  ['header response (19 00)',                [0x19, 0x00]],
  ['footer (1A 00)',                         [0x1a, 0x00]],
  ['footer response (1B 00)',                [0x1b, 0x00]],
  ['write request (14 00)',                  [0x14, 0x00]],
  ['write request response (15 00)',         [0x15, 0x00]],
  ['patch request bank 0 patch 0 (04 00 00 00)',     [0x04, 0x00, 0x00, 0x00]],
  ['patch request bank 4 patch 127 (04 00 04 7F)',   [0x04, 0x00, 0x04, 0x7f]],
  ['patch names request bank A (02 00 00)',          [0x02, 0x00, 0x00]],
  ['chunk acknowledge chunk 0 (17 00 00 16)',        [0x17, 0x00, 0x00, 0x16]],
  ['chunk acknowledge chunk 21 (17 00 15 16)',       [0x17, 0x00, 0x15, 0x16]],
  ['patch saved ack (07 00 04 7F)',                  [0x07, 0x00, 0x04, 0x7f]],
];

for (const [label, info] of PROTOCOL_MESSAGES) {
  check(`round-trip: ${label}`, () => {
    const wrapped = wrapSysex(Uint8Array.from(info));
    if (wrapped[0] !== 0xf0 || wrapped[wrapped.length - 1] !== 0xf7) {
      return `bad envelope: starts 0x${wrapped[0].toString(16)}, ends 0x${wrapped[wrapped.length - 1].toString(16)}`;
    }
    const back = unwrapSysex(wrapped);
    return deepEqBytes(back, info);
  });
}

// ---------------------------------------------------------------------------
// Round-trip on chunk-sized payloads, the actual wire size we'll be using
// when patch encoding lands in the next BK-036 milestone.
// ---------------------------------------------------------------------------

// Realistic chunk dump shape: 16 00 CHUNK 16 [128 bytes of data].
// Picked the first chunk of "Sawpressive GD" verbatim from
// SysexEncoding.txt lines 211–215 so we have a recognizable, varied
// byte distribution rather than zeros.
const SAWPRESSIVE_CHUNK0_INFO = bytes(
  0x16, 0x00, 0x00, 0x16,
  0x05, 0x00, 0x00, 0x00, 0x9b, 0x00, 0x00, 0x00, 0x0d, 0x53, 0x61, 0x77,
  0x70, 0x72, 0x65, 0x73, 0x73, 0x69, 0x76, 0x65, 0x20, 0x47, 0x44, 0x00,
  0x20, 0x00, 0x20, 0x00, 0xb0, 0x04, 0x00, 0x00, 0x04, 0x00, 0x20, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00,
  0x73, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00,
  0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
);

check('round-trip: 132-byte chunk dump (chunk header + 128 data bytes)', () => {
  // Sanity: 4-byte header (16 00 CHUNK 16) + 128 data bytes = 132 total
  if (SAWPRESSIVE_CHUNK0_INFO.length !== 132) {
    return `test data wrong length: ${SAWPRESSIVE_CHUNK0_INFO.length}`;
  }
  const wrapped = wrapSysex(SAWPRESSIVE_CHUNK0_INFO);
  const back = unwrapSysex(wrapped);
  return deepEqBytes(back, SAWPRESSIVE_CHUNK0_INFO);
});

// ---------------------------------------------------------------------------
// Error paths.
// ---------------------------------------------------------------------------

check('unwrapSysex: rejects message without F0 start', () => {
  const bad = SPEC_EXAMPLE_WRAPPED.slice();
  bad[0] = 0xf1;
  try {
    unwrapSysex(bad);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && e.message.includes('start mismatch')
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

check('unwrapSysex: rejects message without F7 end', () => {
  const bad = SPEC_EXAMPLE_WRAPPED.slice();
  bad[bad.length - 1] = 0xf6;
  try {
    unwrapSysex(bad);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && e.message.includes('end mismatch')
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

check('unwrapSysex: rejects wrong manufacturer header (00 41 ... = Roland)', () => {
  const bad = SPEC_EXAMPLE_WRAPPED.slice();
  bad[1] = 0x41; // would-be Roland namespace
  try {
    unwrapSysex(bad);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && e.message.includes('header mismatch')
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

check('unwrapSysex: rejects message with corrupted payload (CRC mismatch)', () => {
  const bad = SPEC_EXAMPLE_WRAPPED.slice();
  // Flip one bit in the base64 ASCII payload — corrupts a payload byte
  // post-decode and the CRC must catch it.
  bad[10] = 0x42; // was 0x6B ('k'); 0x42 is 'B' — different decoded byte
  try {
    unwrapSysex(bad);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && e.message.includes('CRC-32 mismatch')
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
});

check('unwrapSysex: rejects too-short message', () => {
  try {
    unwrapSysex([0xf0, 0xf7]);
    return 'should have thrown';
  } catch (e) {
    return e instanceof Error && e.message.includes('too short')
      ? true : `wrong error: ${e instanceof Error ? e.message : e}`;
  }
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
  console.log(`✓ ${passed}/${cases.length} hydrasynth sysex-envelope cases pass.`);
} else {
  console.error(`${passed}/${cases.length} pass; ${failed} fail:\n`);
  for (const f of failures) console.error(f);
  process.exit(1);
}
