/**
 * Kit 40 (StokenII) pad-loudness measurement — ad hoc analysis script.
 *
 * Reads the actual source WAV files that were staged/uploaded for Kit 40's
 * 13 pads (device not currently mounted; these are the pre-upload masters
 * found on disk, bit-identical or near-identical to what upload_sample sent
 * since they are already 44.1kHz/16-bit mono, the SPD-SX's native format).
 * Uses this project's own BS.1770-4 engine (packages/core/src/audio/bs1770.ts,
 * built to dist) for consistency with the live measure_loudness tool.
 */
import { readFileSync } from 'node:fs';
import { measureBs1770 } from '@mcp-midi-control/core/audio/bs1770.js';
import { parseWav } from '@mcp-midi-control/spd-sx/codec/wav.js';

interface PadInfo {
  pad: number;
  wave: number;
  waveName: string;
  note: number;
  wvLevel: number;
  file: string;
}

const PADS: PadInfo[] = [
  { pad: 1, wave: 472, waveName: '12_china', note: 56, wvLevel: 95, file: 'C:/dev/bouncer/out/stoken_spdsx/12_china.wav' },
  { pad: 2, wave: 464, waveName: '04_ride', note: 51, wvLevel: 60, file: 'C:/dev/bouncer/out/stoken_spdsx/04_ride.wav' },
  { pad: 3, wave: 468, waveName: '08_crash', note: 49, wvLevel: 95, file: 'C:/dev/bouncer/out/stoken_spdsx/08_crash.wav' },
  { pad: 4, wave: 467, waveName: '07_snare_rol', note: 39, wvLevel: 64, file: 'C:/dev/bouncer/out/stoken_spdsx/07_snare_roll.wav' },
  { pad: 5, wave: 469, waveName: '09_tom', note: 45, wvLevel: 79, file: 'C:/dev/bouncer/out/stoken_spdsx/09_tom.wav' },
  { pad: 6, wave: 465, waveName: '05_open_hat', note: 46, wvLevel: 54, file: 'C:/dev/bouncer/out/stoken_spdsx/05_open_hat.wav' },
  { pad: 7, wave: 461, waveName: '01_kick', note: 36, wvLevel: 86, file: 'C:/dev/bouncer/out/stoken_spdsx/01_kick.wav' },
  { pad: 8, wave: 462, waveName: '02_snare', note: 38, wvLevel: 100, file: 'C:/dev/bouncer/out/stoken_spdsx/02_snare.wav' },
  { pad: 9, wave: 463, waveName: '03_closed_ha', note: 42, wvLevel: 64, file: 'C:/dev/bouncer/out/stoken_spdsx/03_closed_hat.wav' },
  { pad: 10, wave: 470, waveName: '10_ride_bell', note: 53, wvLevel: 61, file: 'C:/dev/bouncer/out/stoken_spdsx/10_ride_bell.wav' },
  { pad: 11, wave: 602, waveName: 'OFRBRTOM', note: 60, wvLevel: 100, file: 'C:/dev/mcp-midi-tools/samples/mixwave/the-offering-kit/spdsx-ready/offering_bridge.wav' },
  { pad: 12, wave: 603, waveName: 'OFRBUHAT', note: 61, wvLevel: 100, file: 'C:/dev/mcp-midi-tools/samples/mixwave/the-offering-kit/spdsx-ready/offering_buildup.wav' },
  { pad: 13, wave: 604, waveName: 'OFRBDSNR', note: 62, wvLevel: 100, file: 'C:/dev/mcp-midi-tools/samples/mixwave/the-offering-kit/spdsx-ready/offering_breakdo.wav' },
];

function decodeChannels(bytes: Uint8Array): { channels: Float64Array[]; sampleRate: number; bitsPerSample: number; numChannels: number } {
  const w = parseWav(bytes);
  const { data, bitsPerSample, channels, audioFormat, sampleRate } = w;
  const bytesPer = bitsPerSample >> 3;
  const frames = Math.floor(data.length / (bytesPer * channels));
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: Float64Array[] = Array.from({ length: channels }, () => new Float64Array(frames));
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const p = (f * channels + c) * bytesPer;
      let v: number;
      if (audioFormat === 3 && bitsPerSample === 32) v = dv.getFloat32(p, true);
      else if (bitsPerSample === 16) v = dv.getInt16(p, true) / 32768;
      else if (bitsPerSample === 24) v = (((data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)) << 8) >> 8) / 8388608;
      else if (bitsPerSample === 32) v = dv.getInt32(p, true) / 2147483648;
      else if (bitsPerSample === 8) v = (data[p] - 128) / 128;
      else throw new Error(`unsupported bit depth ${bitsPerSample}`);
      out[c][f] = v;
    }
  }
  return { channels: out, sampleRate, bitsPerSample, numChannels: channels };
}

console.log(
  ['pad', 'wave', 'name', 'note', 'wvLevel', 'sr', 'bits', 'ch', 'dur_s', 'LUFS_int', 'LUFS_mom_max', 'truePeak_dBTP', 'samplePeak_dBFS'].join('\t'),
);

const results: Array<PadInfo & { lufsInt: number | null; lufsMom: number | null; tp: number; sp: number; sr: number; bits: number; ch: number; dur: number }> = [];

for (const p of PADS) {
  const bytes = readFileSync(p.file);
  const { channels, sampleRate, bitsPerSample, numChannels } = decodeChannels(new Uint8Array(bytes));
  const dur = channels[0].length / sampleRate;
  const res = measureBs1770(channels, sampleRate);
  results.push({ ...p, lufsInt: res.lufsIntegrated, lufsMom: res.lufsMomentaryMax, tp: res.truePeakDbtp, sp: res.samplePeakDbfs, sr: sampleRate, bits: bitsPerSample, ch: numChannels, dur });
  console.log(
    [
      p.pad,
      p.wave,
      p.waveName,
      p.note,
      p.wvLevel,
      sampleRate,
      bitsPerSample,
      numChannels,
      dur.toFixed(3),
      res.lufsIntegrated?.toFixed(2) ?? 'null',
      res.lufsMomentaryMax?.toFixed(2) ?? 'null',
      res.truePeakDbtp.toFixed(2),
      res.samplePeakDbfs.toFixed(2),
    ].join('\t'),
  );
}

console.log('\n--- ranked by integrated LUFS (loudest sample first) ---');
for (const r of [...results].sort((a, b) => (b.lufsInt ?? -999) - (a.lufsInt ?? -999))) {
  console.log(`pad ${r.pad} (${r.waveName}): ${r.lufsInt?.toFixed(2)} LUFS integrated, mom-max ${r.lufsMom?.toFixed(2)}, wvLevel ${r.wvLevel}`);
}

console.log('\n--- ranked by momentary-max LUFS (loudest instant first) ---');
for (const r of [...results].sort((a, b) => (b.lufsMom ?? -999) - (a.lufsMom ?? -999))) {
  console.log(`pad ${r.pad} (${r.waveName}): mom-max ${r.lufsMom?.toFixed(2)} LUFS, integrated ${r.lufsInt?.toFixed(2)}, wvLevel ${r.wvLevel}`);
}

// Rough "perceived" estimate: LUFS + a coarse linear-ish level-to-dB proxy.
// SPD-SX WvLevel is documented 0..127 as a linear pad-volume control; without
// a published dB curve we report the level DELTA from the kit's own median
// (not an invented absolute dB scalar) alongside measured LUFS, per the task's
// instruction not to fabricate a precise curve.
const median = [...results.map((r) => r.wvLevel)].sort((a, b) => a - b)[Math.floor(results.length / 2)];
console.log(`\n--- kit median WvLevel: ${median} ---`);
console.log('pad\twaveName\tLUFS_int\twvLevel\twvLevel_delta_from_median');
for (const r of results) {
  console.log(`${r.pad}\t${r.waveName}\t${r.lufsInt?.toFixed(2)}\t${r.wvLevel}\t${r.wvLevel - median >= 0 ? '+' : ''}${r.wvLevel - median}`);
}
