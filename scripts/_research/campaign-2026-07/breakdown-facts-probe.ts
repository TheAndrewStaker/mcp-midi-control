/**
 * Breakdown (Tom Petty, s23527) plan-time facts probe. READ-ONLY: disk only,
 * no device, no network (cache = samples/songsterr-cache/s23527, saved by the
 * 2026-07-30 interview-brief fetch, revision 5942415).
 *
 * Sections:
 *   A. source facts (t6 drums through the CURRENT flatten + quantize path):
 *      censuses, dynamics ladder output, off-grid -> micro placement.
 *   B. carry-over oracle audit (card-backup-2026-07-29/pack5 proj35-39):
 *      headers, chains, lengths, drum velocity/micro image, midi2 delay image,
 *      midi1 harmony image (ties/gates/vels).
 *   C. harmony source hunt: which cached part (at +12 or +0) matches the old
 *      midi1 content.
 *   D. pipeline-reproduction check: fresh windowed import vs stored bytes,
 *      per project (velocity leg and micro leg SEPARATELY).
 *   E. union-keyed 2-bar window census (drums + harmony) -> the honest count.
 *
 * Run: npx tsx samples/_scratch/breakdown-facts-probe.ts
 */
import { readFileSync } from 'node:fs';
import {
  flattenSongsterrDrums, flattenSongsterrMelodic, isMelodicPart,
  type SongsterrPart,
} from '../../packages/core/src/protocol-generic/patterns/songsterr.js';
import { quantizeDrumEvents } from '../../packages/core/src/protocol-generic/patterns/drumScore.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import {
  getProjectName, NOTE_TRACKS, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { getSceneChainEnd } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s23527';
const ORACLE = 'C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29/pack5';
const PROJECTS = [35, 36, 37, 38, 39];
const CHAIN_TABLE_BASE = 0x2c4;
const NOTE_CHAIN_INDEX: Record<string, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
// stored midi2 note -> voice (the +12 external register)
const NOTE_VOICE: Record<number, string> = { 48: 'kick', 50: 'snare', 54: 'hat', 57: 'tom', 58: 'openhat', 61: 'crash' };
const VOICE_NOTE: Record<string, number> = { kick: 48, snare: 50, hat: 54, tom: 57, openhat: 58, crash: 61 };
// internal drum track -> voice (old build: D1 kick, D2 snare, D3 hat)
const DRUM_TRACK_VOICE = ['kick', 'snare', 'hat'] as const;

const meta = JSON.parse(readFileSync(`${CACHE}/meta.json`, 'utf8'));
const load = (id: number): SongsterrPart => JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;

console.log(`=== A. source facts (s${meta.songId} r${meta.revisionId}, "${meta.artist} - ${meta.title}") ===`);
const drums = flattenSongsterrDrums(load(6));
console.log(`t6 drums: ${drums.events.length} events, ghosts ${drums.ghosts}, accents ${drums.accents}, graces ${drums.graces_folded}, flams ${drums.flams_collapsed}, unmapped ${drums.unmapped}`);
console.log(`measures: ${drums.measures.length}, signature drift: ${drums.measures.every((m) => m.signature[0] === 4 && m.signature[1] === 4) ? 'none (4/4 x' + drums.measures.length + ')' : 'YES'}`);
console.log(`tempo marks: ${JSON.stringify((drums as any).tempos ?? 'n/a')}`);
{
  const voiceC = new Map<string, number>(); const velC = new Map<string, number>();
  let off = 0; const offsets = new Map<string, number>();
  for (const e of drums.events) {
    voiceC.set(e.voice, (voiceC.get(e.voice) ?? 0) + 1);
    const vk = e.velocity !== undefined ? String(e.velocity) : e.accent ? 'accent(120)' : e.ghost ? 'ghost(40)' : 'plain(100)';
    velC.set(vk, (velC.get(vk) ?? 0) + 1);
    const s = e.beat * 4;
    if (Math.abs(s - Math.round(s)) > 1e-6) { off++; offsets.set((s - Math.floor(s)).toFixed(3), (offsets.get((s - Math.floor(s)).toFixed(3)) ?? 0) + 1); }
  }
  console.log(`voices: ${[...voiceC].map(([v, c]) => `${v} ${c}`).join(', ')}`);
  console.log(`velocity classes: ${[...velC].map(([v, c]) => `${v} x${c}`).join(', ')}`);
  console.log(`off-16th-grid: ${off} at fractional offsets {${[...offsets].map(([o, c]) => `${o} x${c}`).join(', ')}}`);
  // per-voice velocity detail for the p/f/fff mapping
  const perVoiceVel = new Map<string, Map<string, number>>();
  for (const e of drums.events) {
    const vk = e.velocity !== undefined ? String(e.velocity) : e.accent ? 'acc120' : 'plain100';
    if (!perVoiceVel.has(e.voice)) perVoiceVel.set(e.voice, new Map());
    const m = perVoiceVel.get(e.voice)!;
    m.set(vk, (m.get(vk) ?? 0) + 1);
  }
  for (const [v, m] of perVoiceVel) console.log(`  ${v}: ${[...m].map(([k, c]) => `${k} x${c}`).join(', ')}`);
}
// quantize the whole song once: micro census
{
  const q = quantizeDrumEvents(drums.events, { beats: drums.totalBeats, stepsPerBeat: 4 });
  let cells = 0; let microCells = 0; const microVals = new Map<string, number>(); let multiOnset = 0;
  for (const [, steps] of Object.entries(q.voices)) {
    for (const s of steps) {
      if (!s.on) continue;
      cells++;
      if (s.micro) { microCells++; microVals.set(JSON.stringify(s.micro), (microVals.get(JSON.stringify(s.micro)) ?? 0) + 1); if (s.micro.length > 1 || (s.micro.length === 1 && s.micro[0] !== undefined && false)) multiOnset++; }
      if (s.micro && s.micro.length > 1) multiOnset++;
    }
  }
  console.log(`quantized (whole song, 16ths): ${cells} cells, ${microCells} carry micro, values {${[...microVals].map(([k, c]) => `${k} x${c}`).join(', ')}}, multi-onset cells ${multiOnset}`);
  console.log(`quantize warnings: ${q.warnings.join(' | ')}`);
}

console.log(`\n=== B. oracle audit (proj35-39, card-backup-2026-07-29) ===`);
interface OracleProj {
  slot: number; buf: Buffer;
  midi1: { step: number; pattern: number; note: number; gate: number; tie: boolean; vel: number; delay: number }[];
  midi2: { step: number; pattern: number; note: number; gate: number; tie: boolean; vel: number; delay: number }[];
  drum: { track: number; pattern: number; step: number; vel: number; mask: number }[];
  chains: Record<string, [number, number]>;
}
const oracle: OracleProj[] = [];
for (const slot of PROJECTS) {
  const buf = readFileSync(`${ORACLE}/proj${slot}__${slot - 1}_SESSION.ncs`);
  const name = getProjectName(buf as unknown as Uint8Array);
  const drumLv = [0, 1, 2, 3].map((n) => buf[0x26fbd + n * 11]);
  const binding = [...buf.slice(0x1a278, 0x1a27c)];
  console.log(`\nslot ${slot} "${name}" col=${buf[0x0c]} bpm=${buf[0x34]} swing=${buf[0x35]} scale=${buf[0x26d0c]}/${buf[0x26d0d]} mix=${buf[0x2701c]}/${buf[0x2701d]} drumLv=[${drumLv}] bind=[${binding}] sceneEnd=${getSceneChainEnd(buf as unknown as Uint8Array) ?? '-'}`);
  const chains: Record<string, [number, number]> = {};
  const chainStrs: string[] = [];
  for (const t of NOTE_TRACKS) {
    const off = CHAIN_TABLE_BASE + NOTE_CHAIN_INDEX[t] * 4;
    chains[t] = [buf[off], buf[off + 1]];
    chainStrs.push(`${t}[${buf[off]},${buf[off + 1]}]`);
  }
  for (let d = 0; d < 4; d++) {
    const off = CHAIN_TABLE_BASE + (4 + d) * 4;
    chains[`drum${d + 1}`] = [buf[off], buf[off + 1]];
    chainStrs.push(`dr${d + 1}[${buf[off]},${buf[off + 1]}]`);
  }
  console.log(`  chains: ${chainStrs.join(' ')}`);
  const proj: OracleProj = { slot, buf, midi1: [], midi2: [], drum: [], chains };
  for (const t of ['midi1', 'midi2'] as const) {
    for (let p = 0; p < 8; p++) {
      const steps = decodeNotePattern(buf as unknown as Uint8Array, t as NoteTrack, p);
      for (const [i, s] of steps.entries()) {
        if (!s.active) continue;
        for (const n of s.notes) proj[t].push({ step: i, pattern: p, note: n.note, gate: n.gate, tie: n.tie, vel: n.velocity, delay: n.delay });
      }
    }
  }
  for (let d = 0; d < 4; d++) {
    for (let p = 0; p < 8; p++) {
      for (const [i, s] of decodeDrumPattern(buf as unknown as Uint8Array, d, p).entries()) {
        if (s.active) proj.drum.push({ track: d, pattern: p, step: i, vel: s.velocity, mask: s.microHits });
      }
    }
  }
  oracle.push(proj);
  const velH = new Map<number, number>(); const maskH = new Map<number, number>();
  for (const h of proj.drum) { velH.set(h.vel, (velH.get(h.vel) ?? 0) + 1); maskH.set(h.mask, (maskH.get(h.mask) ?? 0) + 1); }
  console.log(`  internal drums: ${proj.drum.length} hits, vel {${[...velH].sort((a, b) => a[0] - b[0]).map(([v, c]) => `${v} x${c}`).join(', ')}}, micro-mask {${[...maskH].sort((a, b) => a[0] - b[0]).map(([m, c]) => `0x${m.toString(16).padStart(2, '0')} x${c}`).join(', ')}}`);
  const m2vel = new Map<number, number>(); const m2del = new Map<number, number>(); const m2notes = new Map<number, number>();
  for (const h of proj.midi2) { m2vel.set(h.vel, (m2vel.get(h.vel) ?? 0) + 1); m2del.set(h.delay, (m2del.get(h.delay) ?? 0) + 1); m2notes.set(h.note, (m2notes.get(h.note) ?? 0) + 1); }
  console.log(`  midi2: ${proj.midi2.length} onsets, notes {${[...m2notes].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}(${NOTE_VOICE[n] ?? '?'}) x${c}`).join(', ')}}, vel {${[...m2vel].sort((a, b) => a[0] - b[0]).map(([v, c]) => `${v} x${c}`).join(', ')}}, delay {${[...m2del].sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d} x${c}`).join(', ')}}`);
  if (proj.midi1.length > 0) {
    const g = new Map<number, number>(); const v = new Map<number, number>(); const d = new Map<number, number>(); let ties = 0;
    const notes = new Map<number, number>();
    for (const h of proj.midi1) { g.set(h.gate, (g.get(h.gate) ?? 0) + 1); v.set(h.vel, (v.get(h.vel) ?? 0) + 1); d.set(h.delay, (d.get(h.delay) ?? 0) + 1); if (h.tie) ties++; notes.set(h.note, (notes.get(h.note) ?? 0) + 1); }
    console.log(`  midi1: ${proj.midi1.length} onsets, ties ${ties}, notes {${[...notes].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n} x${c}`).join(' ')}}`);
    console.log(`    gates {${[...g].sort((a, b) => a[0] - b[0]).map(([x, c]) => `${x} x${c}`).join(', ')}}, vels {${[...v].sort((a, b) => a[0] - b[0]).map(([x, c]) => `${x} x${c}`).join(', ')}}, delays {${[...d].sort((a, b) => a[0] - b[0]).map(([x, c]) => `${x} x${c}`).join(', ')}}`);
  } else console.log('  midi1: (empty)');
  // per-track pattern lengths (drum + note length bytes are covered by chains x lens in the As-executed; report drum row lens)
}

console.log(`\n=== C. harmony source hunt (old midi1 vs each cached melodic part) ===`);
// Old build project boundaries: flat 16-bar chop from m1 (P1 m1-16, ..., P5 m65-77).
// Global step of an oracle midi1 onset = (slot-35)*256 + pattern*32 + step.
const oldMidi1 = oracle.flatMap((p) => p.midi1.map((h) => ({ g: (p.slot - 35) * 256 + h.pattern * 32 + h.step, note: h.note })));
const oldSet = new Set(oldMidi1.map((h) => `${h.g}|${h.note}`));
console.log(`old midi1 total onsets: ${oldMidi1.length}`);
for (const t of meta.allTracks ?? []) {
  if (t.isDrums) continue;
  let part: SongsterrPart;
  try { part = load(t.partId); } catch { continue; }
  if (!isMelodicPart(part)) continue;
  const flat = flattenSongsterrMelodic(part);
  for (const shift of [12, 0]) {
    const src = flat.notes.map((n) => ({ g: Math.round(n.beat * 4), note: n.pitch + shift }));
    const srcSet = new Set(src.map((h) => `${h.g}|${h.note}`));
    let inter = 0; for (const k of oldSet) if (srcSet.has(k)) inter++;
    if (inter > 0) console.log(`  t${t.partId} ${t.instrument} +${shift}: ${inter}/${oldSet.size} old onsets matched (src has ${srcSet.size})`);
  }
}

console.log(`\n=== D. pipeline-reproduction check (fresh windowed import vs stored, per project) ===`);
// Old chop: P1 m1-16 (beats 0..64), P2 m17-32, P3 m33-48, P4 m49-64, P5 m65-77 (beats 256..308).
for (const [i, slot] of PROJECTS.entries()) {
  const fromBeat = i * 64;
  const beats = Math.min(64, drums.totalBeats - fromBeat);
  const windowed = drums.events.filter((e) => e.beat >= fromBeat - 1e-9 && e.beat < fromBeat + beats).map((e) => ({ ...e, beat: e.beat - fromBeat }));
  const q = quantizeDrumEvents(windowed, { beats, stepsPerBeat: 4 });
  const proj = oracle[i];
  // fresh image per voice -> compare against stored (midi2 leg AND internal leg)
  let velMatch = 0; let velMiss = 0; let microMatch = 0; let microMiss = 0; let missing = 0; let extra = 0;
  const storedByKey = new Map<string, { vel: number; delay: number }>();
  for (const h of proj.midi2) {
    const g = h.pattern * 32 + h.step;
    storedByKey.set(`${g}|${NOTE_VOICE[h.note] ?? h.note}`, { vel: h.vel, delay: h.delay });
  }
  const freshKeys = new Set<string>();
  for (const [voice, steps] of Object.entries(q.voices)) {
    for (const [stepIdx, s] of steps.entries()) {
      if (!s.on) continue;
      const key = `${stepIdx}|${voice}`;
      freshKeys.add(key);
      const st = storedByKey.get(key);
      if (!st) { missing++; continue; }
      const freshVel = s.velocity ?? (s.accent ? 120 : 100);
      if (freshVel === st.vel) velMatch++; else velMiss++;
      const freshDelay = s.micro?.[0] ?? 0;
      if (freshDelay === st.delay) microMatch++; else microMiss++;
    }
  }
  for (const k of storedByKey.keys()) if (!freshKeys.has(k)) extra++;
  console.log(`slot ${slot} (m${i * 16 + 1}-${Math.min(77, i * 16 + 16)}): midi2 fresh-vs-stored vel ${velMatch} match / ${velMiss} differ; delay ${microMatch} match / ${microMiss} differ; fresh-only ${missing}, stored-only ${extra}`);
  // internal leg (D1 kick / D2 snare / D3 hat): same comparison, mask bit vs micro
  let iVelMatch = 0; let iVelMiss = 0; let iMaskMatch = 0; let iMaskMiss = 0; let iMissing = 0; let iExtra = 0;
  const storedDrum = new Map<string, { vel: number; mask: number }>();
  for (const h of proj.drum) {
    if (h.track > 2) continue;
    storedDrum.set(`${h.pattern * 32 + h.step}|${DRUM_TRACK_VOICE[h.track]}`, { vel: h.vel, mask: h.mask });
  }
  const freshDrumKeys = new Set<string>();
  for (const [voice, steps] of Object.entries(q.voices)) {
    if (!(DRUM_TRACK_VOICE as readonly string[]).includes(voice)) continue;
    for (const [stepIdx, s] of steps.entries()) {
      if (!s.on) continue;
      const key = `${stepIdx}|${voice}`;
      freshDrumKeys.add(key);
      const st = storedDrum.get(key);
      if (!st) { iMissing++; continue; }
      const freshVel = s.velocity ?? (s.accent ? 120 : 100);
      if (freshVel === st.vel) iVelMatch++; else iVelMiss++;
      const freshMask = s.micro ? s.micro.reduce((m, t) => m | (1 << t), 0) || 1 : 1;
      if (freshMask === st.mask) iMaskMatch++; else iMaskMiss++;
    }
  }
  for (const k of storedDrum.keys()) if (!freshDrumKeys.has(k)) iExtra++;
  console.log(`         internal D1-3: vel ${iVelMatch}/${iVelMiss} match/differ; mask ${iMaskMatch}/${iMaskMiss}; fresh-only ${iMissing}, stored-only ${iExtra}`);
}

console.log(`\n=== E. union-keyed 2-bar window census (drums + harmony) ===`);
// Harmony = the part C names as the match (computed above); use best match by score.
// For the census, re-run with each plausible harmony (t0 at +12) if matched; here:
// key windows on drums (step,voice,vel,micro) + harmony (step,note,gate,tie,vel).
// Alignment: bar-pair windows from m1 (window w covers bars 2w+1, 2w+2; last window = bar 77 alone).
{
  const barsTotal = drums.measures.length;
  const windows = Math.ceil(barsTotal / 2);
  const q = quantizeDrumEvents(drums.events, { beats: drums.totalBeats, stepsPerBeat: 4 });
  // choose harmony: highest-scoring from part C (re-run quickly, keep best)
  let best: { partId: number; shift: number; score: number } | undefined;
  for (const t of meta.allTracks ?? []) {
    if (t.isDrums) continue;
    let part: SongsterrPart; try { part = load(t.partId); } catch { continue; }
    if (!isMelodicPart(part)) continue;
    const flat = flattenSongsterrMelodic(part);
    for (const shift of [12, 0]) {
      const srcSet = new Set(flat.notes.map((n) => `${Math.round(n.beat * 4)}|${n.pitch + shift}`));
      let inter = 0; for (const k of oldSet) if (srcSet.has(k)) inter++;
      if (!best || inter > best.score) best = { partId: t.partId, shift, score: inter };
    }
  }
  console.log(`harmony pick for the census: t${best?.partId} shift +${best?.shift} (matched ${best?.score}/${oldSet.size})`);
  const harm = flattenSongsterrMelodic(load(best!.partId));
  const winKey: string[] = [];
  for (let w = 0; w < windows; w++) {
    const s0 = w * 32; const s1 = Math.min(barsTotal * 16, s0 + 32);
    const parts: string[] = [];
    for (const [voice, steps] of Object.entries(q.voices)) {
      for (let s = s0; s < s1 && s < steps.length; s++) {
        const st = steps[s];
        if (!st?.on) continue;
        parts.push(`${voice}:${s - s0}:${st.velocity ?? (st.accent ? 120 : 100)}:${JSON.stringify(st.micro ?? [0])}`);
      }
    }
    for (const n of harm.notes) {
      const g = Math.round(n.beat * 4);
      if (g < s0 || g >= s1) continue;
      parts.push(`H:${g - s0}:${n.pitch}:${n.durationBeats?.toFixed(3) ?? '?'}:${n.tie ? 'T' : ''}:${n.velocity ?? 'def'}`);
    }
    winKey.push(parts.sort().join('|'));
  }
  const distinct = new Map<string, number[]>();
  for (const [w, k] of winKey.entries()) { if (!distinct.has(k)) distinct.set(k, []); distinct.get(k)!.push(w); }
  console.log(`windows ${windows}, union-distinct ${distinct.size} (floor by slots alone: ${Math.ceil(distinct.size / 8)})`);
  // letters per window for part-set design
  const letters = new Map<string, string>();
  let li = 0;
  const label = (i: number): string => i < 26 ? String.fromCharCode(65 + i) : `a${i - 26}`;
  const seq: string[] = [];
  for (const k of winKey) { if (!letters.has(k)) letters.set(k, label(li++)); seq.push(letters.get(k)!); }
  for (let i = 0; i < seq.length; i += 8) console.log(`  w${i}: bars ${i * 2 + 1}-${Math.min(barsTotal, i * 2 + 16)}: ${seq.slice(i, i + 8).join(' ')}`);
  // per-section census at the marker boundaries m1/m15/m24/m68 (sections not 2-bar aligned; report bar-level too)
  // bar-level distinct census for boundary work:
  const barKey: string[] = [];
  for (let b = 0; b < barsTotal; b++) {
    const s0 = b * 16; const s1 = s0 + 16;
    const parts: string[] = [];
    for (const [voice, steps] of Object.entries(q.voices)) {
      for (let s = s0; s < s1 && s < steps.length; s++) {
        const st = steps[s];
        if (!st?.on) continue;
        parts.push(`${voice}:${s - s0}:${st.velocity ?? (st.accent ? 120 : 100)}:${JSON.stringify(st.micro ?? [0])}`);
      }
    }
    for (const n of harm.notes) {
      const g = Math.round(n.beat * 4);
      if (g < s0 || g >= s1) continue;
      parts.push(`H:${g - s0}:${n.pitch}:${n.durationBeats?.toFixed(3) ?? '?'}:${n.tie ? 'T' : ''}:${n.velocity ?? 'def'}`);
    }
    barKey.push(parts.sort().join('|'));
  }
  const barDistinct = new Set(barKey);
  console.log(`bar-level: ${barsTotal} bars, ${barDistinct.size} union-distinct`);
  // bar letter map
  const bl = new Map<string, string>(); let bi = 0;
  const bseq = barKey.map((k) => { if (!bl.has(k)) bl.set(k, label(bi++)); return bl.get(k)!; });
  for (let i = 0; i < bseq.length; i += 16) console.log(`  m${i + 1}-${Math.min(barsTotal, i + 16)}: ${bseq.slice(i, i + 16).join(' ')}`);
}
console.log('\ndone.');
