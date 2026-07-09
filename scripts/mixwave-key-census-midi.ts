/**
 * mixwave-key-census-midi — author a probe SMF for identifying the Mixwave
 * Sleep Token II key map BY EAR/AUDIO instead of a (blocked) Kontakt mapping
 * read: one hit per key, in ascending key order, 2 seconds apart, on the
 * channel the library's own Groove Pack uses (ch16).
 *
 * Keys probed = every note number the 160 Groove Pack MIDIs actually use
 * (census 2026-07-02) plus the low-octave neighbors, so nothing mapped is
 * missed. Render this file through the Sleep Token II Kontakt instrument with
 * the bounce program (offline render, no live audio engine needed), then feed
 * the WAV to the analysis probe: each 2-second slot is one key; multiple
 * onsets in one slot = a ROLL articulation (the baked-roll prize).
 *
 *   npx tsx scripts/mixwave-key-census-midi.ts
 *   -> samples/mixwave/key-census.mid  (+ key-census-manifest.json)
 */
import { writeFileSync, mkdirSync } from 'node:fs';

// Every key seen in the Groove Pack census + gap-fill 0..57 low range neighbors
// that could plausibly hold articulations the grooves never used.
const CENSUS_KEYS = [0, 1, 2, 3, 4, 7, 9, 11, 13, 14, 16, 17, 18, 19, 20, 21, 22, 23, 25, 27, 28, 29, 30, 32, 35, 38, 41, 44, 47, 50, 51, 52, 53, 54, 57];
const GAP_FILL = [5, 6, 8, 10, 12, 15, 24, 26, 31, 33, 34, 36, 37, 39, 40, 42, 43, 45, 46, 48, 49, 55, 56];
const KEYS = [...new Set([...CENSUS_KEYS, ...GAP_FILL])].sort((a, b) => a - b);

const CHANNEL = 15;        // 0-based → MIDI ch16 (the Groove Pack convention)
const VELOCITY = 110;
const TPB = 480;
const BPM = 120;           // 2s per key = 4 beats at 120
const BEATS_PER_KEY = 4;
const GATE_TICKS = TPB * 2; // 1s note length so long articulations ring

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}

const events: number[] = [];
// tempo meta: 120 bpm = 500000 us/qn
events.push(0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);
let first = true;
for (const key of KEYS) {
  const restToNext = first ? 0 : BEATS_PER_KEY * TPB - GATE_TICKS;
  events.push(...vlq(restToNext), 0x90 | CHANNEL, key, VELOCITY);
  events.push(...vlq(GATE_TICKS), 0x80 | CHANNEL, key, 0);
  first = false;
}
events.push(0x00, 0xff, 0x2f, 0x00);

const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (TPB >> 8) & 0xff, TPB & 0xff];
const len = events.length;
const trk = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff];

mkdirSync('samples/mixwave', { recursive: true });
writeFileSync('samples/mixwave/key-census.mid', Uint8Array.from([...header, ...trk, ...events]));

const secondsPerKey = (BEATS_PER_KEY * 60) / BPM;
const manifest = KEYS.map((key, i) => ({ key, start_s: i * secondsPerKey }));
writeFileSync('samples/mixwave/key-census-manifest.json', JSON.stringify({
  channel: CHANNEL + 1, bpm: BPM, seconds_per_key: secondsPerKey, velocity: VELOCITY, keys: manifest,
}, null, 2));

console.log(`key-census.mid: ${KEYS.length} keys on ch${CHANNEL + 1}, one hit / ${secondsPerKey}s, ${(KEYS.length * secondsPerKey / 60).toFixed(1)} min total`);
console.log('  -> samples/mixwave/key-census.mid  (+ key-census-manifest.json)');
console.log('Bounce it through the Sleep Token II Kontakt instrument (default snapshot, no FX changes),');
console.log('save the WAV as samples/mixwave/key-census.wav, and the analysis probe takes it from there.');
