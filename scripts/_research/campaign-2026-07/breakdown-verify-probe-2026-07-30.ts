/**
 * INDEPENDENT verification probe: Breakdown card bytes vs Songsterr 23527 r5942415.
 * READ-ONLY, disk only, no MIDI. Does NOT assume the rebuild plan's window boundaries:
 * it SLIDES each slot against the source to find the best alignment first.
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { quantizeDrumEvents } from '../../packages/core/src/protocol-generic/patterns/drumScore.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { META_OFFSETS, noteBlockIndex, drumBlockIndex, type NoteTrack } from '../../packages/circuit-tracks/src/ncs/format.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s23527';
const ORACLE = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29/pack5';
const PROJECTS = [35, 36, 37, 38, 39];
const NOTE_VOICE: Record<number, string> = { 48: 'kick', 50: 'snare', 54: 'hat', 57: 'tom', 58: 'openhat', 61: 'crash' };

const load = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const drums = flattenSongsterrDrums(load(6));
const bufs = PROJECTS.map((s) => readFileSync(`${ORACLE}/proj${s}__${s - 1}_SESSION.ncs`));

// ---------- SOURCE: quantize the WHOLE song once, then slice per bar ----------
const totalBars = 77;
const wholeQ = quantizeDrumEvents(drums.events, { beats: totalBars * 4, stepsPerBeat: 4 });
// srcBar[m] = Set("stepInBar|voice|micro") + velocity map
type Cell = { key: string; vel: number };
const srcBar: Map<string, number>[] = Array.from({ length: totalBars + 1 }, () => new Map());
let srcTotal = 0, srcMicro3 = 0;
const srcVelHist = new Map<number, number>();
for (const [voice, steps] of Object.entries(wholeQ.voices)) {
  for (const [gs, s] of (steps as any[]).entries()) {
    if (!s.on) continue;
    const bar = Math.floor(gs / 16) + 1;
    const sib = gs % 16;
    const vel = s.velocity ?? (s.accent ? 120 : 100);
    for (const micro of (s.micro ?? [0]) as number[]) {
      srcBar[bar].set(`${sib}|${voice}|${micro}`, vel);
      srcTotal++; if (micro === 3) srcMicro3++;
      srcVelHist.set(vel, (srcVelHist.get(vel) ?? 0) + 1);
    }
  }
}

// ---------- CARD: decode midi2 per slot into bar-indexed cells ----------
interface SlotImg { slot: number; bars: Map<string, number>[]; nBars: number; lens: number[]; chainEnd: number; }
const slots: SlotImg[] = [];
let cardTotal = 0, cardDelay3 = 0;
const cardVelHist = new Map<number, number>();
for (const [i, slot] of PROJECTS.entries()) {
  const buf = bufs[i];
  const lens: number[] = [];
  for (let p = 0; p < 8; p++) lens.push(buf[META_OFFSETS[noteBlockIndex('midi2' as NoteTrack, p)]] + 1);
  const chainEnd = buf[0x2c4 + 3 * 4 + 1];
  const usedSteps = lens.slice(0, chainEnd + 1).reduce((a, b) => a + b, 0);
  const nBars = usedSteps / 16;
  const bars: Map<string, number>[] = Array.from({ length: nBars }, () => new Map());
  let cursor = 0;
  for (let p = 0; p <= chainEnd; p++) {
    const steps = decodeNotePattern(buf as unknown as Uint8Array, 'midi2' as NoteTrack, p);
    for (let si = 0; si < lens[p]; si++) {
      const s = steps[si];
      const gs = cursor + si;
      const bar = Math.floor(gs / 16); const sib = gs % 16;
      if (s.active) for (const n of s.notes) {
        bars[bar].set(`${sib}|${NOTE_VOICE[n.note] ?? 'n' + n.note}|${n.delay}`, n.velocity);
        cardTotal++; if (n.delay === 3) cardDelay3++;
        cardVelHist.set(n.velocity, (cardVelHist.get(n.velocity) ?? 0) + 1);
      }
    }
    cursor += lens[p];
  }
  slots.push({ slot, bars, nBars, lens, chainEnd });
}

const jac = (a: Map<string, number>, b: Map<string, number>): number => {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0; for (const k of a.keys()) if (b.has(k)) inter++;
  return inter / (a.size + b.size - inter);
};

console.log('=== 0. census ===');
console.log(`source drum events (flatten): ${drums.events.length}; quantized placements: ${srcTotal}; micro-tick-3: ${srcMicro3}`);
console.log(`source velocity histogram: ${[...srcVelHist.entries()].sort((x, y) => y[1] - x[1]).map(([v, c]) => `${v}x${c}`).join(' ')}`);
console.log(`card midi2 placements (all 5 slots): ${cardTotal}; delay-3: ${cardDelay3}`);
console.log(`card velocity histogram: ${[...cardVelHist.entries()].sort((x, y) => y[1] - x[1]).map(([v, c]) => `${v}x${c}`).join(' ')}`);
for (const s of slots) console.log(`  slot ${s.slot}: lens [${s.lens}] chainEnd ${s.chainEnd} -> ${s.nBars} bars`);

console.log('\n=== 1. ALIGNMENT SLIDE (no boundary assumed) ===');
for (const s of slots) {
  const scores: { off: number; score: number }[] = [];
  for (let off = 0; off + s.nBars <= totalBars + 2; off++) {
    let sc = 0;
    for (let b = 0; b < s.nBars; b++) {
      const src = srcBar[off + b + 1] ?? new Map();
      sc += jac(s.bars[b], src);
    }
    scores.push({ off, score: sc / s.nBars });
  }
  scores.sort((a, b) => b.score - a.score);
  const top = scores.slice(0, 3).map((x) => `m${x.off + 1} (${x.score.toFixed(3)})`).join(', ');
  console.log(`slot ${s.slot} (${s.nBars} bars): best starts -> ${top}`);
}

console.log('\n=== 2. PER-BAR DIFF at the length-byte boundaries ===');
const bounds: [number, number][] = [];
let m = 1;
for (const s of slots) { bounds.push([m, m + s.nBars - 1]); m += s.nBars; }
console.log(`boundaries: ${bounds.map(([a, b], i) => `P${i + 1} m${a}-${b}`).join(', ')}`);
let gTot = 0, gExact = 0, gVelOK = 0, gCardOnly = 0, gSrcOnly = 0;
for (const [i, s] of slots.entries()) {
  const [mFrom] = bounds[i];
  let exact = 0, velDiff = 0, cardOnly = 0, srcOnly = 0;
  const badBars: string[] = [];
  for (let b = 0; b < s.nBars; b++) {
    const srcM = mFrom + b;
    const src = srcBar[srcM] ?? new Map();
    const card = s.bars[b];
    let be = 0, bc = 0, bs = 0;
    for (const [k, v] of card) { if (src.has(k)) { if (src.get(k) === v) { exact++; be++; } else { velDiff++; be++; } } else { cardOnly++; bc++; } }
    for (const k of src.keys()) if (!card.has(k)) { srcOnly++; bs++; }
    const jj = jac(card, src);
    if (jj < 0.85) badBars.push(`m${srcM}(J=${jj.toFixed(2)} card${card.size}/src${src.size} +${bc}/-${bs})`);
  }
  gTot += exact + velDiff + cardOnly; gExact += exact; gVelOK += velDiff; gCardOnly += cardOnly; gSrcOnly += srcOnly;
  console.log(`P${i + 1} slot ${s.slot} m${bounds[i][0]}-${bounds[i][1]}: exact ${exact}, same-cell-diff-vel ${velDiff}, card-only ${cardOnly}, source-only ${srcOnly}`);
  if (badBars.length) console.log(`   divergent bars: ${badBars.join(' ')}`);
}
console.log(`TOTAL: exact ${gExact}, vel-differs ${gVelOK}, card-only ${gCardOnly}, source-only ${gSrcOnly}`);

console.log('\n=== 3. LOOP TEST: does the card repeat where the source varies? ===');
// count distinct bar-images in card vs source over the same span
for (const [i, s] of slots.entries()) {
  const [mFrom, mTo] = bounds[i];
  const cardSig = new Set(s.bars.map((b) => [...b.keys()].sort().join(',')));
  const srcSigs = new Set<string>();
  for (let mm = mFrom; mm <= mTo; mm++) srcSigs.add([...(srcBar[mm] ?? new Map()).keys()].sort().join(','));
  console.log(`P${i + 1} slot ${s.slot}: card distinct bars ${cardSig.size}/${s.nBars}, source distinct bars ${srcSigs.size}/${mTo - mFrom + 1}`);
}

console.log('\n=== 4. NAMED CLAIMS ===');
const barOf = (mm: number) => { for (const [i, [a, b]] of bounds.entries()) if (mm >= a && mm <= b) return { s: slots[i], b: mm - a, slot: PROJECTS[i] }; return undefined; };
for (const mm of [8, 22, 23]) {
  const loc = barOf(mm);
  const src = srcBar[mm] ?? new Map();
  console.log(`m${mm}: SOURCE  [${[...src.keys()].sort().join(' ')}]`);
  console.log(`m${mm}: CARD(s${loc?.slot}) [${loc ? [...loc.s.bars[loc.b].keys()].sort().join(' ') : 'n/a'}]`);
}
// crash census
let srcCrash = 0; for (let mm = 1; mm <= totalBars; mm++) for (const k of (srcBar[mm] ?? new Map()).keys()) if (k.includes('crash')) srcCrash++;
let cardCrash = 0; for (const s of slots) for (const b of s.bars) for (const k of b.keys()) if (k.includes('crash')) cardCrash++;
console.log(`crash placements: source ${srcCrash}, card ${cardCrash}`);
const srcCrashBars: number[] = []; for (let mm = 1; mm <= totalBars; mm++) if ([...(srcBar[mm] ?? new Map()).keys()].some((k) => k.includes('crash'))) srcCrashBars.push(mm);
const cardCrashBars: number[] = []; for (const [i, s] of slots.entries()) for (let b = 0; b < s.nBars; b++) if ([...s.bars[b].keys()].some((k) => k.includes('crash'))) cardCrashBars.push(bounds[i][0] + b);
console.log(`crash bars source: ${srcCrashBars.join(',')}`);
console.log(`crash bars card:   ${cardCrashBars.join(',')}`);
// voice census both sides
const vcount = (get: () => Iterable<Map<string, number>>) => { const mp = new Map<string, number>(); for (const b of get()) for (const k of b.keys()) { const v = k.split('|')[1]; mp.set(v, (mp.get(v) ?? 0) + 1); } return mp; };
const sv = vcount(function* () { for (let mm = 1; mm <= totalBars; mm++) yield srcBar[mm]; });
const cv = vcount(function* () { for (const s of slots) for (const b of s.bars) yield b; });
console.log(`source voices: ${[...sv].map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`card voices:   ${[...cv].map(([k, v]) => `${k}=${v}`).join(' ')}`);

console.log('\n=== 5. FIX PRESENCE in card bytes (internal drums + midi2) ===');
let dTot = 0, dMicroBit3 = 0; const dVel = new Map<number, number>();
for (const [i, s] of slots.entries()) {
  const buf = bufs[i];
  for (let t = 0; t < 4; t++) for (let p = 0; p <= s.chainEnd; p++) {
    const steps = decodeDrumPattern(buf as unknown as Uint8Array, t, p);
    const len = buf[META_OFFSETS[drumBlockIndex(t, p)]] + 1;
    for (let si = 0; si < len; si++) {
      const st = steps[si]; if (!st.active) continue;
      dTot++; if (st.microHits & 0x08) dMicroBit3++;
      dVel.set(st.velocity, (dVel.get(st.velocity) ?? 0) + 1);
    }
  }
}
console.log(`internal drum steps active: ${dTot}; carrying micro bit 3 (0x08): ${dMicroBit3}`);
console.log(`internal drum velocity histogram: ${[...dVel.entries()].sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v}x${c}`).join(' ')}`);
console.log(`midi2 note-slot delay==3: ${cardDelay3} of ${cardTotal}`);
// tail snare check: snare at step-in-bar 14 delay 3
let tail60 = 0, tailOther = 0;
for (const s of slots) for (const b of s.bars) for (const [k, v] of b) { if (k.startsWith('14|snare|3')) { if (v === 60) tail60++; else tailOther++; } }
console.log(`tail snare (sib14, delay3): vel 60 x${tail60}, other x${tailOther}`);
