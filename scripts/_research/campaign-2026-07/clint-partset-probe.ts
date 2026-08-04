/**
 * Clint Eastwood FINAL part-set detail (plan-time, READ-ONLY).
 * Emits, for the 8-project set (Intro/V1/C1/V2/C2+S1a'/S2'/S3/Outro with the
 * solo re-cut at m85), per project: window bar spans, per-window step counts,
 * union letters, per-lane letters, expected chain/scene layout, tail facts.
 * Plus bar-level lane letters for m68-103 (the re-cut evidence) and the
 * crash/tom/openhat/timbale placement per project window.
 *
 * Run: npx tsx samples/_scratch/clint-partset-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s8562';
const loadPart = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const t6f = flattenSongsterrMelodic(loadPart(6));
const t11f = flattenSongsterrMelodic(loadPart(11));
const t12f = flattenSongsterrMelodic(loadPart(12));
const t14f = flattenSongsterrDrums(loadPart(14));
const t15f = flattenSongsterrDrums(loadPart(15));
const measures = t14f.measures;
const barStart = (mi: number): number => measures[mi].startBeat;
const barLen = (mi: number): number => (measures[mi].signature[0] * 4) / measures[mi].signature[1];

interface Ev { beat: number; key: string; voice?: string }
const mel = (fl: ReturnType<typeof flattenSongsterrMelodic>): Ev[] =>
  fl.notes.map((n) => ({ beat: n.beat, key: `${n.pitch}@${n.velocity ?? 'd'}:${n.durationBeats}` }));
const drm = (fl: ReturnType<typeof flattenSongsterrDrums>): Ev[] =>
  fl.events.map((e) => ({ beat: e.beat, key: `${e.voice}@${e.velocity ?? 'd'}`, voice: e.voice }));
const LANES: Array<[string, Ev[]]> = [
  ['s1', mel(t6f)], ['s2', mel(t11f)], ['m1', mel(t12f)], ['m2', [...drm(t14f), ...drm(t15f)]],
];
const barSig = (evs: Ev[], mi1: number): string => {
  const b0 = barStart(mi1 - 1); const b1 = b0 + barLen(mi1 - 1);
  return evs.filter((e) => e.beat >= b0 - 1e-9 && e.beat < b1 - 1e-9)
    .map((e) => `${Math.round((e.beat - b0) * 4)}:${e.key}`).sort().join(',');
};

// union + per-lane letter registries
const uReg = new Map<string, string>();
const lRegs = new Map<string, Map<string, string>>();
const uLetter = (bars: number[]): string => {
  const sig = `${bars.length}|` + LANES.map(([, evs]) => bars.map((b) => barSig(evs, b)).join(';')).join('||');
  let l = uReg.get(sig);
  if (!l) { const n = uReg.size; l = n < 26 ? String.fromCharCode(65 + n) : `a${n - 26}`; uReg.set(sig, l); }
  return l;
};
const lLetter = (lane: string, evs: Ev[], bars: number[]): string => {
  const sig = `${bars.length}|` + bars.map((b) => barSig(evs, b)).join(';');
  const empty = bars.every((b) => barSig(evs, b) === '');
  if (empty) return '.';
  let reg = lRegs.get(lane);
  if (!reg) { reg = new Map(); lRegs.set(lane, reg); }
  let l = reg.get(sig);
  if (!l) { const n = reg.size; l = n < 26 ? String.fromCharCode(65 + n) : `${lane}${n}`; reg.set(sig, l); }
  return l;
};

const PARTS: Array<{ slot: number; name: string; spans: Array<[number, number]> }> = [
  { slot: 27, name: 'Clint 01 Intro', spans: [[1, 15]] },
  { slot: 28, name: 'Clint 02 Verse 1', spans: [[16, 31]] },
  { slot: 29, name: 'Clint 03 Chorus 1', spans: [[32, 41]] },
  { slot: 30, name: 'Clint 04 Verse 2', spans: [[42, 57]] },
  { slot: 31, name: 'Clint 05 Cho2 Solo1', spans: [[58, 67], [68, 84]] },
  { slot: 32, name: 'Clint 06 Solo 2', spans: [[85, 103]] },
  { slot: 33, name: 'Clint 07 Solo 3', spans: [[104, 117]] },
  { slot: 34, name: 'Clint 08 Outro', spans: [[118, 123]] },
];
function minRunsWithRanges(order: string[]): { runs: number; ranges: string[] } {
  const slot = new Map<string, number>();
  for (const l of order) if (!slot.has(l)) slot.set(l, slot.size + 1);
  const s = order.map((l) => slot.get(l)!);
  const ranges: string[] = [];
  let i = 0;
  while (i < s.length) { let j = i + 1; while (j < s.length && s[j] === s[j - 1] + 1) j++; ranges.push(s[i] === s[j - 1] ? `[${s[i]}]` : `[${s[i]}-${s[j - 1]}]`); i = j; }
  return { runs: ranges.length, ranges };
}
for (const p of PARTS) {
  const wins: number[][] = [];
  for (const [f, t] of p.spans) for (let m = f; m <= t; m += 2) wins.push(m + 1 <= t ? [m, m + 1] : [m]);
  const order = wins.map((w) => uLetter(w));
  const steps = wins.map((w) => w.reduce((s, b) => s + barLen(b - 1) * 4, 0));
  const cells = new Set(order).size;
  const { runs, ranges } = minRunsWithRanges(order);
  const layout = order.length <= 8 ? `plain chain, ${order.length} slots` : `scene chain ${ranges.join('')} (${runs} steps)`;
  console.log(`\n== slot ${p.slot} "${p.name}"  m${p.spans[0][0]}-${p.spans[p.spans.length - 1][1]} (${wins.length} windows)`);
  console.log(`   windows: ${wins.map((w) => `m${w[0]}${w.length > 1 ? `-${w[1]}` : ''}`).join(' ')}`);
  console.log(`   steps:   ${steps.join(' ')}`);
  console.log(`   UNION:   ${order.join(' ')}   cells=${cells} plays=${order.length} -> ${layout}`);
  for (const [lane, evs] of LANES) console.log(`   ${lane}: ${wins.map((w) => lLetter(lane, evs, w)).join(' ')}`);
  // percussion colour per window
  const m2 = LANES[3][1];
  const marks = wins.map((w) => {
    const voices = new Set(m2.filter((e) => e.voice !== undefined && w.some((b) => {
      const b0 = barStart(b - 1); return e.beat >= b0 - 1e-9 && e.beat < b0 + barLen(b - 1) - 1e-9;
    })).map((e) => e.voice));
    return [voices.has('crash') ? 'C' : '', voices.has('tom') ? 't' : '', voices.has('openhat') ? 'o' : '', voices.has('timbale') ? 'T' : ''].join('');
  });
  console.log(`   perc marks (C=crash t=tom o=openhat T=timbale): ${marks.map((m) => m === '' ? '-' : m).join(' ')}`);
}
// re-cut evidence: bar-level lane letters m68-103
console.log('\n== bar-level lane letters m68-103 (re-cut evidence)');
for (const [lane, evs] of LANES) {
  const reg = new Map<string, string>();
  const out: string[] = [];
  for (let m = 68; m <= 103; m++) {
    const sig = barSig(evs, m);
    if (sig === '') { out.push('.'); continue; }
    let l = reg.get(sig);
    if (!l) { l = String.fromCharCode(97 + reg.size); reg.set(sig, l); }
    out.push(l);
  }
  console.log(`   ${lane}: m68 ${out.join('')} m103`);
}
console.log(`\nglobal union cells (this part set): ${uReg.size}`);
for (const [lane, reg] of lRegs) console.log(`lane ${lane}: ${reg.size} distinct cells`);
