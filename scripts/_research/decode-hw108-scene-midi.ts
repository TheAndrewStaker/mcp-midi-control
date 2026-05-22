/**
 * HW-108 decode: extract AM4 SysEx envelopes from the 2026-05-16
 * Scene-MIDI test-button captures, group by fn + pidHigh + pidLow,
 * surface what the host wrote when each test button was clicked.
 *
 * Inputs (large; never load into context directly):
 *   samples/captured/session-85-scene-midi.tshark.txt             (459 MB)
 *   samples/captured/session-86-scene-midi-disambiguate.tshark.txt (245 MB)
 *   samples/captured/session-87-scene-midi-test-buttons.tshark.txt (305 MB)
 *
 * Output:
 *   samples/captured/decoded/hw108-scene-midi-decode.md
 *   (compact human-readable summary — bytes grouped + counted)
 *
 * AM4 wire layout per fractal-midi/docs/devices/am4/SYSEX-MAP.md:
 *   F0 00 01 74 15 [fn] [...] [cksum] F7
 *
 *   fn 0x01 SET_PARAM:
 *     F0 00 01 74 15 01 [action_lo action_hi] [pidLow_lo pidLow_hi]
 *                      [pidHigh_lo pidHigh_hi] [val 4 bytes] [cksum] F7
 *     - action 0x0001 = SET (host→device write)
 *     - action 0x024e = NOTIFY (device→host echo)
 *     - pidLow/pidHigh are septet-packed 14-bit; pidHigh names the block
 *
 * PATCH-block traffic uses pidLow=0xCE (= 0x4e_lo | 0x01_hi). Scene-MIDI
 * messages are PATCH_SCENE_N_MIDI_MSG_M cache_ids 64..79, exposed at
 * pidHigh = cache_id when the variant resolver doesn't remap.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const FILES = [
  'samples/captured/session-85-scene-midi.tshark.txt',
  'samples/captured/session-86-scene-midi-disambiguate.tshark.txt',
  'samples/captured/session-87-scene-midi-test-buttons.tshark.txt',
];
const OUT = 'samples/captured/decoded/hw108-scene-midi-decode.md';
mkdirSync('samples/captured/decoded', { recursive: true });

interface Envelope {
  /** Full hex of the SysEx envelope, lowercase, no spaces. */
  hex: string;
  /** Function byte. */
  fn: number;
  /** First payload byte (lots of variation here). */
  b6: number;
  /** Second payload byte. */
  b7: number;
  /** Third payload byte. */
  b8: number;
  /** Fourth payload byte. */
  b9: number;
  /** Total envelope length in bytes. */
  len: number;
}

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

/** Parse an envelope's hex string. Returns undefined for non-AM4 frames. */
function parseEnvelope(hex: string): Envelope | undefined {
  // Expected: f0000174150...f7
  if (!hex.startsWith('f0000174')) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substr(i, 2), 16));
  }
  if (bytes[4] !== 0x15) return undefined; // AM4 model byte
  if (bytes[bytes.length - 1] !== 0xf7) return undefined;
  const fn = bytes[5];
  return {
    hex,
    fn,
    b6: bytes[6] ?? 0,
    b7: bytes[7] ?? 0,
    b8: bytes[8] ?? 0,
    b9: bytes[9] ?? 0,
    len: bytes.length,
  };
}

const RE_REASSEMBLED = /\[Reassembled data: ([0-9a-f]+)\]/g;

interface FileStats {
  filename: string;
  total: number;
  /** Per-fn counts. */
  perFn: Map<number, number>;
  /** Per-(fn, pidHigh) for fn 0x01 host-write traffic — pidHigh derived
   *  from septet-packed bytes 8-9. */
  perFn01PidHigh: Map<number, { count: number; samples: string[] }>;
  /** Distinct envelope hex strings for short messages (< 30 bytes) —
   *  surfaces button-click writes (preset dumps are long, button clicks
   *  are typically the short envelopes). */
  shortEnvelopes: Map<string, number>;
}

function extractFile(path: string): FileStats {
  console.log(`Reading ${path}...`);
  const text = readFileSync(path, 'utf8');
  console.log(`  ${text.length} chars, scanning for SysEx envelopes...`);
  const stats: FileStats = {
    filename: path,
    total: 0,
    perFn: new Map(),
    perFn01PidHigh: new Map(),
    shortEnvelopes: new Map(),
  };
  let m;
  RE_REASSEMBLED.lastIndex = 0;
  while ((m = RE_REASSEMBLED.exec(text)) !== null) {
    const env = parseEnvelope(m[1]);
    if (!env) continue;
    stats.total++;
    stats.perFn.set(env.fn, (stats.perFn.get(env.fn) ?? 0) + 1);

    if (env.fn === 0x01) {
      // For SET_PARAM-family traffic, the byte layout is:
      //   bytes 6-7  = action (14-bit septet)
      //   bytes 8-9  = pidLow (14-bit septet)
      //   bytes 10-11 = pidHigh (14-bit septet)
      // Decode pidHigh from bytes 10-11 if envelope is long enough.
      const bytes: number[] = [];
      for (let i = 0; i < env.hex.length; i += 2) {
        bytes.push(parseInt(env.hex.substr(i, 2), 16));
      }
      if (bytes.length >= 12) {
        const pidLow = decode14(bytes[8], bytes[9]);
        const pidHigh = decode14(bytes[10], bytes[11]);
        // Group by (pidLow, pidHigh) for SET_PARAM writes
        const key = (pidLow << 16) | pidHigh;
        const entry = stats.perFn01PidHigh.get(key) ?? { count: 0, samples: [] };
        entry.count++;
        if (entry.samples.length < 3) entry.samples.push(env.hex);
        stats.perFn01PidHigh.set(key, entry);
      }
    }

    // Track short envelopes — host-side button clicks usually under 30 bytes.
    if (env.len < 30) {
      stats.shortEnvelopes.set(env.hex, (stats.shortEnvelopes.get(env.hex) ?? 0) + 1);
    }
  }
  return stats;
}

const allStats = FILES.map(extractFile);

// Build the report
const lines: string[] = [];
lines.push('# HW-108 AM4 PATCH Scene-MIDI capture decode');
lines.push('');
lines.push('Generated by `scripts/_research/decode-hw108-scene-midi.ts` from the');
lines.push('2026-05-16 capture set. Goal: classify each Scene-MIDI button');
lines.push('(`btnMidiTest`, `labelMenuArrow`, `btnRectangle`) as');
lines.push('fires-action / arms-slot / no-op based on observed wire bytes.');
lines.push('');

for (const s of allStats) {
  lines.push(`## ${s.filename}`);
  lines.push('');
  lines.push(`Total AM4 SysEx envelopes: ${s.total}`);
  lines.push('');
  lines.push('### Per-function counts');
  lines.push('');
  lines.push('| fn (hex) | count |');
  lines.push('|---|---|');
  for (const [fn, count] of [...s.perFn.entries()].sort((a, b) => a[0] - b[0])) {
    lines.push(`| 0x${fn.toString(16).padStart(2, '0')} | ${count} |`);
  }
  lines.push('');

  // Filter SET_PARAM groups: PATCH-family is pidLow=0xCE. Surface those
  // plus any other heavy pidLow groups (top 10 by count).
  const fn01Groups = [...s.perFn01PidHigh.entries()].map(([key, v]) => {
    const pidLow = (key >> 16) & 0xffff;
    const pidHigh = key & 0xffff;
    return { pidLow, pidHigh, ...v };
  });
  const patchGroups = fn01Groups.filter((g) => g.pidLow === 0xce);
  const otherGroups = fn01Groups
    .filter((g) => g.pidLow !== 0xce)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  if (patchGroups.length > 0) {
    lines.push('### fn 0x01 SET_PARAM writes against PATCH block (pidLow = 0xCE)');
    lines.push('');
    lines.push('| pidHigh | count | sample envelope (1st) |');
    lines.push('|---|---|---|');
    for (const g of patchGroups.sort((a, b) => a.pidHigh - b.pidHigh)) {
      lines.push(`| 0x${g.pidHigh.toString(16).padStart(4, '0')} (${g.pidHigh}) | ${g.count} | \`${g.samples[0] ?? ''}\` |`);
    }
    lines.push('');
  } else {
    lines.push('### fn 0x01 SET_PARAM writes against PATCH block (pidLow = 0xCE)');
    lines.push('');
    lines.push('_(none observed)_');
    lines.push('');
  }

  if (otherGroups.length > 0) {
    lines.push('### Top 10 other fn 0x01 SET_PARAM groups (by count)');
    lines.push('');
    lines.push('| pidLow | pidHigh | count | sample (1st) |');
    lines.push('|---|---|---|---|');
    for (const g of otherGroups) {
      lines.push(`| 0x${g.pidLow.toString(16).padStart(4, '0')} | 0x${g.pidHigh.toString(16).padStart(4, '0')} | ${g.count} | \`${g.samples[0] ?? ''}\` |`);
    }
    lines.push('');
  }

  // Short distinct envelopes (host clicks are typically <30 bytes and
  // appear a small handful of times, not hundreds of times).
  const distinctShort = [...s.shortEnvelopes.entries()]
    .filter(([, c]) => c <= 8)         // exclude polling traffic
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);
  if (distinctShort.length > 0) {
    lines.push('### Top distinct short envelopes (likely host button writes)');
    lines.push('');
    lines.push('Filter: envelope <30 bytes, appears ≤8 times (excludes polling).');
    lines.push('');
    lines.push('| count | envelope |');
    lines.push('|---|---|');
    for (const [hex, count] of distinctShort) {
      lines.push(`| ${count} | \`${hex}\` |`);
    }
    lines.push('');
  }
}

writeFileSync(OUT, lines.join('\n'));
console.log(`\nWrote ${OUT}`);
