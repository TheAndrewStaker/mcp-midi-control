/**
 * Redbone Phase-0 staging (mirror of schism-tailfix-stage.ts). READ-ONLY: no
 * device, no network. Run: npx tsx samples/_scratch/redbone-stage.ts
 *
 * Builds the EIGHT per-project `arrangement` payloads (Pack 2 slots 25-32) from
 * the PINNED cache (samples/songsterr-cache/s434040, rev 7419203, re-confirmed
 * live 2026-07-29) via the EXACT import path the MCP tool uses
 * (importSongsterrMelodic / importSongsterrDrums, codec-default options), plus:
 *   - melodic rows per plan SS2a incl. the EDGE-TIE RULE (a note sounding across
 *     a 2-bar window edge = clip-to-edge + tie-forward + continuation at the
 *     next window's step 1); every instance listed in output
 *   - drum rows as mini-notation with per-hit @vel (plan SS2b; NEVER char grids)
 * Asserts (all must pass): per-part off_grid == 0; drums ghosts == 0; the 28
 * v127 events at their staged steps; V2 == V1-head per part; the SS0e elision
 * spot-rows reproduce; per-project letters == plan SS1; PreCh2 packs
 * [32,32,32,16]; closing-bar content for every project tail (plan step 12).
 * Emits samples/_scratch/redbone-staged.json for the apply_pattern calls.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  importSongsterrMelodic, importSongsterrDrums, flattenSongsterrMelodic,
  flattenSongsterrDrums, type SongsterrPart,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';

const CACHE = 'C:/dev/mcp-midi-tools/samples/songsterr-cache/s434040';
const load = (id: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${id}.json`, 'utf8')) as SongsterrPart;
const p5 = load(5);   // Piano 1      -> synth2 (the INTERNAL voice, stored 100)
const p7 = load(7);   // Synths 1     -> synth1 (Hydrasynth ch1, stored 0)
const p9 = load(9);   // Synth Str. 1 -> midi1  (MicroFreak ch3)
const p10 = load(10); // Drums        -> midi2 external + condensed internal

let failures = 0;
const fail = (msg: string): void => { failures++; console.log(`  FAIL: ${msg}`); };
const ok = (msg: string): void => console.log(`  ok: ${msg}`);
const info = (msg: string): void => console.log(`  info: ${msg}`);

// ── project set (plan SS1) ───────────────────────────────────────────
interface Proj {
  slot: number; project_name: string; from: number; to: number;
  expectSteps: number[]; expectOrder: string;
}
const PROJECTS: Proj[] = [
  { slot: 25, project_name: 'Redbone 1 Intro',   from: 1,  to: 10,  expectSteps: [32, 32, 32, 32, 32],                 expectOrder: 'A B C D E' },
  { slot: 26, project_name: 'Redbone 2 Verse',   from: 11, to: 26,  expectSteps: [32, 32, 32, 32, 32, 32, 32, 32],     expectOrder: 'A B C D E B F G' },
  { slot: 27, project_name: 'Redbone 3 PreChor', from: 27, to: 40,  expectSteps: [32, 32, 32, 32, 32, 32, 32],         expectOrder: 'A B C D E F G' },
  { slot: 28, project_name: 'Redbone 4 PreCh2',  from: 49, to: 55,  expectSteps: [32, 32, 32, 16],                     expectOrder: 'A B C D' },
  { slot: 29, project_name: 'Redbone 5 Chorus2', from: 56, to: 71,  expectSteps: [32, 32, 32, 32, 32, 32, 32, 32],     expectOrder: 'A B C D E B C F' },
  { slot: 30, project_name: 'Redbone 6 BridgeA', from: 72, to: 83,  expectSteps: [32, 32, 32, 32, 32, 32],             expectOrder: 'A B C A B C' },
  // NAMED DEVIATION from plan SS1 (which said 'A B C A D C', an onset-only census):
  // the SS2a edge rule is mandatory and p9's d#4 (18 steps, onset m93 beat 3.5,
  // SS0f "holds up to 18-32 steps") rings 4 beats into m94, so m94-95 carries a
  // d#4:16 continuation and is distinct from m88-89. Plays/chain/steps unchanged.
  { slot: 31, project_name: 'Redbone 7 BridgeB', from: 84, to: 95,  expectSteps: [32, 32, 32, 32, 32, 32],             expectOrder: 'A B C A D E' },
  { slot: 32, project_name: 'Redbone 8 Outro',   from: 96, to: 107, expectSteps: [32, 32, 32, 32, 32, 32],             expectOrder: 'A B C A D E' },
];
const MEL: Array<{ part: SongsterrPart; voice: 'synth1' | 'synth2' | 'midi1'; id: number }> = [
  { part: p7, voice: 'synth1', id: 7 },
  { part: p5, voice: 'synth2', id: 5 },
  { part: p9, voice: 'midi1', id: 9 },
];

// ── token helpers ────────────────────────────────────────────────────
const SIX = 6; // sixths per step
const tokensOf = (row: string): string[] => row.trim().split(/\s+/);
const isRest = (t: string): boolean => t === '~';
const pitchesOf = (t: string): string => t.split(/[:@_]/)[0];
const gateTok = (sixths: number): string => {
  if (sixths % SIX === 0) return String(sixths / SIX);
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(sixths, SIX);
  return `${sixths / g}/${SIX / g}`;
};
const mkTok = (pitches: string, sixths: number, vel: number | undefined, tie: boolean): string =>
  `${pitches}:${gateTok(sixths)}${vel !== undefined ? `@${vel}` : ''}${tie ? '_' : ''}`;

// ── melodic per-window import + edge-tie rule ────────────────────────
interface Carry { pitches: string; sixths: number; vel?: number }
interface WinVoices { name: string; steps: number; from: number; to: number; voices: Record<string, string> }

const fidelityUnion = new Map<string, string>(); // field -> class
const edgeInstances: string[] = [];
let totOffGrid = 0; let totChordOverflow = 0; let totMerged = 0;

function windowsOf(pr: Proj): Array<{ from: number; to: number; steps: number }> {
  const out: Array<{ from: number; to: number; steps: number }> = [];
  for (let b = pr.from; b <= pr.to; b += 2) {
    const to = Math.min(b + 1, pr.to);
    out.push({ from: b, to, steps: (to - b + 1) * 16 });
  }
  return out;
}

function stageProject(pr: Proj): { wins: WinVoices[]; v127: Array<{ win: number; voice: string; step: number }> } {
  const wins0 = windowsOf(pr);
  const steps = wins0.map((w) => w.steps);
  if (JSON.stringify(steps) !== JSON.stringify(pr.expectSteps)) {
    fail(`slot ${pr.slot} packing [${steps}] != expected [${pr.expectSteps}]`);
  } else ok(`slot ${pr.slot} packing [${steps}]`);

  const wins: WinVoices[] = wins0.map((w) => ({
    name: `m${w.from}${w.to !== w.from ? '-' + w.to : ''}`, steps: w.steps, from: w.from, to: w.to, voices: {},
  }));

  // melodic voices, with the edge-tie rule applied chronologically
  for (const { part, voice, id } of MEL) {
    let carry: Carry | undefined;
    const rows: string[][] = [];
    for (let wi = 0; wi < wins.length; wi++) {
      const w = wins[wi];
      const imp = importSongsterrMelodic(part, { stepsPerBeat: 4, fromMeasure: w.from, toMeasure: w.to });
      if (imp.step_count !== w.steps) fail(`slot ${pr.slot} ${voice} ${w.name} step_count ${imp.step_count} != ${w.steps}`);
      totOffGrid += imp.off_grid; totChordOverflow += imp.chord_overflow; totMerged += imp.merged;
      for (const [f, d] of Object.entries(imp.dropped_fidelity.not_parsed)) fidelityUnion.set(`p${id}:${f}`, `not_parsed (${(d as { count: number }).count})`);
      for (const [f, d] of Object.entries(imp.dropped_fidelity.parsed_not_authored)) fidelityUnion.set(`p${id}:${f}`, `parsed_not_authored (${JSON.stringify(d)})`);
      const toks = tokensOf(imp.notation);
      if (toks.length !== w.steps) fail(`slot ${pr.slot} ${voice} ${w.name} row has ${toks.length} tokens != ${w.steps}`);

      // 1) incoming carry from the previous window (continuation chain from step 0)
      if (carry !== undefined) {
        let remain = carry.sixths;
        let at = 0;
        while (remain > 0) {
          if (at >= w.steps) { carry = { pitches: carry.pitches, sixths: remain, ...(carry.vel !== undefined ? { vel: carry.vel } : {}) }; break; }
          if (!isRest(toks[at])) { fail(`slot ${pr.slot} ${voice} ${w.name} continuation collision at step ${at}: "${toks[at]}"`); remain = 0; break; }
          const toEdge = (w.steps - at) * SIX;
          const piece = Math.min(96, remain, toEdge);
          const cont = remain > piece; // note continues past this piece
          toks[at] = mkTok(carry.pitches, piece, carry.vel, cont);
          edgeInstances.push(`slot ${pr.slot} ${voice} ${w.name} step ${at}: continuation ${carry.pitches}:${gateTok(piece)}${cont ? '_' : ''}`);
          remain -= piece;
          at += 16;
          if (remain > 0 && at >= w.steps) { carry = { pitches: carry.pitches, sixths: remain, ...(carry.vel !== undefined ? { vel: carry.vel } : {}) }; break; }
          if (remain === 0) carry = undefined;
        }
        if (remain === 0) carry = undefined;
      }

      // 2) this window's own edge crossers (clip final piece to edge + tie)
      for (const c of imp.cells) {
        const gs = c.gate_sixths ?? c.duration_steps * SIX;
        const endSixth = c.step * SIX + gs;
        if (endSixth <= w.steps * SIX) continue; // ends in-window
        // find the importer's final piece for this cell (16-step hops from onset)
        const cellSteps = new Set(imp.cells.map((x) => x.step));
        let remaining = gs; let at = c.step;
        while (remaining > 96) {
          const next = at + 16;
          if (next >= w.steps || cellSteps.has(next)) break;
          remaining -= 96; at = next;
        }
        const finalTok = toks[at];
        if (isRest(finalTok) || pitchesOf(finalTok) !== c.token) {
          fail(`slot ${pr.slot} ${voice} ${w.name} crosser at step ${c.step}: expected final piece of ${c.token} at step ${at}, found "${finalTok}"`);
          continue;
        }
        const toEdge = (w.steps - at) * SIX;
        toks[at] = mkTok(c.token, toEdge, c.velocity, true);
        const carrySixths = endSixth - w.steps * SIX;
        edgeInstances.push(`slot ${pr.slot} ${voice} ${w.name} step ${c.step} (${c.token}, ${gs / SIX} steps): clip final piece @${at} to ${gateTok(toEdge)}_ , carry ${carrySixths / SIX} step(s)${wi === wins.length - 1 ? ' [PROJECT EDGE]' : ''}`);
        if (wi === wins.length - 1) {
          // project-final window: no next pattern to continue into. Hold to edge,
          // UNTIED (a tie into the loop wrap would suppress pattern 1's re-attack).
          toks[at] = mkTok(c.token, toEdge, c.velocity, false);
          edgeInstances[edgeInstances.length - 1] += ' -> UNTIED (project boundary, carry dropped)';
        } else if (carry !== undefined && carry.pitches !== c.token) {
          // merge simultaneous carries into one continuation chord
          fail(`slot ${pr.slot} ${voice} ${w.name}: TWO different carries cross one edge (${carry.pitches} + ${c.token}) - merge unimplemented, inspect`);
        } else {
          carry = { pitches: c.token, sixths: carrySixths, ...(c.velocity !== undefined ? { vel: c.velocity } : {}) };
        }
      }
      rows.push(toks);
    }
    if (carry !== undefined) fail(`slot ${pr.slot} ${voice}: carry left over past the last window`);
    for (let wi = 0; wi < wins.length; wi++) {
      const row = rows[wi].join(' ');
      if (rows[wi].some((t) => !isRest(t))) wins[wi].voices[voice] = row;
    }
  }

  // drums: mini-notation with per-hit @vel (NEVER char grids)
  const v127: Array<{ win: number; voice: string; step: number }> = [];
  for (let wi = 0; wi < wins.length; wi++) {
    const w = wins[wi];
    const dr = importSongsterrDrums(p10, { stepsPerBeat: 4, fromMeasure: w.from, toMeasure: w.to });
    if (dr.steps !== w.steps) fail(`slot ${pr.slot} drums ${w.name} steps ${dr.steps} != ${w.steps}`);
    for (const [dvoice, dsteps] of Object.entries(dr.voices)) {
      const toks: string[] = [];
      let any = false;
      dsteps.forEach((s, i) => {
        if (!s.on) { toks.push('~'); return; }
        any = true;
        if (s.accent === true) fail(`slot ${pr.slot} drums ${w.name} ${dvoice} step ${i}: unexpected accent flag`);
        if (s.roll !== undefined) fail(`slot ${pr.slot} drums ${w.name} ${dvoice} step ${i}: unexpected roll`);
        if (s.micro !== undefined && JSON.stringify(s.micro) !== '[0]') fail(`slot ${pr.slot} drums ${w.name} ${dvoice} step ${i}: off-grid micro [${s.micro}]`);
        if (s.velocity !== undefined && s.velocity !== 127) fail(`slot ${pr.slot} drums ${w.name} ${dvoice} step ${i}: unexpected velocity ${s.velocity}`);
        if (s.velocity === 127) { toks.push(`${dvoice}@127`); v127.push({ win: wi, voice: dvoice, step: i }); }
        else toks.push(dvoice);
      });
      if (any) wins[wi].voices[dvoice] = toks.join(' ');
    }
  }
  return { wins, v127 };
}

// ── stage all 8 + letter census ──────────────────────────────────────
interface StagedSection { name: string; steps: number; voices: Record<string, string> }
interface Staged {
  slot: number; project_name: string; order: string[]; letters: string;
  sections: StagedSection[];
  v127: Array<{ pattern: number; voice: string; step: number }>;
}
const staged: Staged[] = [];

for (const pr of PROJECTS) {
  console.log(`\n=== slot ${pr.slot} "${pr.project_name}" m${pr.from}-${pr.to} ===`);
  const { wins, v127 } = stageProject(pr);

  // letter census over PROCESSED content (voices incl. ties + drums w/ velocity)
  const seen = new Map<string, string>();
  const letters = wins.map((w) => {
    const key = JSON.stringify({ steps: w.steps, voices: w.voices });
    if (!seen.has(key)) seen.set(key, String.fromCharCode(65 + seen.size));
    return seen.get(key)!;
  });
  const lettersStr = letters.join(' ');
  if (lettersStr === pr.expectOrder) ok(`letters == SS1 (${lettersStr})`);
  else fail(`letters "${lettersStr}" != SS1 "${pr.expectOrder}"`);

  // dedupe into sections + order (first occurrence carries the content)
  const sections: StagedSection[] = [];
  const secName = new Map<string, string>();
  const order: string[] = [];
  for (let wi = 0; wi < wins.length; wi++) {
    const key = JSON.stringify({ steps: wins[wi].steps, voices: wins[wi].voices });
    if (!secName.has(key)) {
      secName.set(key, wins[wi].name);
      const voices = Object.keys(wins[wi].voices).length > 0
        ? wins[wi].voices
        : { kick: Array(wins[wi].steps).fill('~').join(' ') }; // all-rest hold
      sections.push({ name: wins[wi].name, steps: wins[wi].steps, voices });
    }
    order.push(secName.get(key)!);
  }
  info(`sections=${sections.length} order=[${order.join(' ')}]`);
  staged.push({
    slot: pr.slot, project_name: pr.project_name, order, letters: lettersStr, sections,
    v127: v127.map((v) => ({ pattern: v.win + 1, voice: v.voice, step: v.step })),
  });
}

// ── global assertions ────────────────────────────────────────────────
console.log('\n=== global assertions ===');
if (totOffGrid === 0) ok('melodic off_grid == 0 across all windows'); else fail(`melodic off_grid == ${totOffGrid}`);
if (totChordOverflow === 0) ok('chord_overflow == 0'); else fail(`chord_overflow == ${totChordOverflow}`);
info(`melodic merged (same-step chord merges): ${totMerged}`);

// drums track-wide: ghosts 0, 28 x v127
{
  const f = flattenSongsterrDrums(p10);
  if (f.ghosts === 0) ok('drums ghosts == 0'); else fail(`drums ghosts == ${f.ghosts}`);
  const v127all = f.events.filter((e) => e.velocity === 127).length;
  if (v127all === 28) ok('drums carry exactly 28 v127 events track-wide'); else fail(`drums v127 == ${v127all} != 28`);
  const stagedCount = staged.reduce((a, s) => a + s.v127.length, 0);
  if (stagedCount === 28) ok(`staged v127 count == 28 (${staged.map((s) => `slot${s.slot}:${s.v127.length}`).filter((x) => !x.endsWith(':0')).join(' ')})`);
  else fail(`staged v127 count == ${stagedCount} != 28`);
  const bySlot: Record<number, number> = { 25: 7, 26: 7, 27: 5, 28: 1, 29: 8, 30: 0, 31: 0, 32: 0 };
  for (const s of staged) {
    if (s.v127.length !== bySlot[s.slot]) fail(`slot ${s.slot} v127 ${s.v127.length} != ${bySlot[s.slot]}`);
  }
}

// V2 == V1-head per part (m41-48 vs m11-18), raw import identity per 2-bar window
{
  let same = true;
  for (const { part, voice } of [...MEL, { part: p10, voice: 'drums' as const }]) {
    for (let i = 0; i < 4; i++) {
      const a = part === p10
        ? JSON.stringify(importSongsterrDrums(p10, { stepsPerBeat: 4, fromMeasure: 41 + i * 2, toMeasure: 42 + i * 2 }).voices)
        : importSongsterrMelodic(part, { stepsPerBeat: 4, fromMeasure: 41 + i * 2, toMeasure: 42 + i * 2 }).notation;
      const b = part === p10
        ? JSON.stringify(importSongsterrDrums(p10, { stepsPerBeat: 4, fromMeasure: 11 + i * 2, toMeasure: 12 + i * 2 }).voices)
        : importSongsterrMelodic(part, { stepsPerBeat: 4, fromMeasure: 11 + i * 2, toMeasure: 12 + i * 2 }).notation;
      if (a !== b) { same = false; fail(`V2 window m${41 + i * 2}-${42 + i * 2} != V1 m${11 + i * 2}-${12 + i * 2} on ${voice}`); }
    }
  }
  if (same) ok('V2 (m41-48) == V1 head (m11-18) on all four parts (the revisit is lossless)');
}

// SS0e spot rows: BridgeA 6-bar period; m84 == m78; outro head == cycle; m107 ending
{
  const barBody = (part: SongsterrPart, bar: number, drums: boolean): string => {
    if (drums) {
      const f = flattenSongsterrDrums(part);
      return f.events.filter((e) => e.beat >= (bar - 1) * 4 && e.beat < bar * 4)
        .map((e) => `${Math.round((e.beat - (bar - 1) * 4) * 4)}:${e.voice}${e.velocity !== undefined ? '@' + e.velocity : ''}`)
        .sort().join(' ');
    }
    const m = flattenSongsterrMelodic(part);
    return m.notes.filter((n) => n.beat >= (bar - 1) * 4 && n.beat < bar * 4)
      .map((n) => `${Math.round((n.beat - (bar - 1) * 4) * 4)}:${n.pitch}:${Math.round(n.durationBeats * 4)}`)
      .sort().join(' ');
  };
  const rowOf = (bar: number): string => [
    barBody(p5, bar, false), barBody(p7, bar, false), barBody(p9, bar, false), barBody(p10, bar, true),
  ].join(' # ');
  let periodOk = true;
  for (let b = 78; b <= 83; b++) if (rowOf(b) !== rowOf(b - 6)) { periodOk = false; fail(`BridgeA m${b} != m${b - 6} (period-6 broken)`); }
  if (periodOk) ok('BridgeA bed cell period 6 holds (m78-83 == m72-77)');
  if (rowOf(84) === rowOf(78)) ok('m84 == m78 (BridgeB opens on a cycle HEAD - SS0e clean)');
  else fail('m84 != m78');
  if (rowOf(96) === rowOf(84)) ok('m96 == m84 (Outro opens on a cycle HEAD - SS0e clean)');
  else fail('m96 != m84');
  if (rowOf(107) !== rowOf(101)) ok('m107 (ending bar) differs from the bed backbeat bar m101');
  else fail('m107 == m101: the ending figure is missing');
}

// ── closing-bar assertions (plan step 12), on the STAGED processed rows ──
console.log('\n=== closing-bar assertions (project tails) ===');
const bySlot = new Map(staged.map((s) => [s.slot, s]));
const lastSection = (slot: number): StagedSection => {
  const s = bySlot.get(slot)!;
  const name = s.order[s.order.length - 1];
  return s.sections.find((x) => x.name === name)!;
};
const hitSteps = (sec: StagedSection, voice: string): number[] =>
  sec.voices[voice] === undefined ? [] : tokensOf(sec.voices[voice]).flatMap((t, i) => (isRest(t) ? [] : [i]));
const tokAt = (sec: StagedSection, voice: string, step: number): string =>
  sec.voices[voice] === undefined ? '~' : tokensOf(sec.voices[voice])[step] ?? '~';

// 1. Intro tail = m9-10; drone chain: pat1-5 midi1 = d#6:16_ @0 (+ @16), final untied
{
  const s = bySlot.get(25)!;
  const t = lastSection(25);
  if (t.name === 'm9-10') ok('slot 25 tail section = m9-10'); else fail(`slot 25 tail = ${t.name}`);
  let droneOk = true;
  for (let wi = 0; wi < 5; wi++) {
    const sec = s.sections.find((x) => x.name === s.order[wi])!;
    const t0 = tokAt(sec, 'midi1', 0); const t16 = tokAt(sec, 'midi1', 16);
    const wantLast = wi === 4;
    if (t0 !== 'd#6:16_') { droneOk = false; fail(`slot 25 pat${wi + 1} midi1 step0 "${t0}" != "d#6:16_"`); }
    if (t16 !== (wantLast ? 'd#6:16' : 'd#6:16_')) { droneOk = false; fail(`slot 25 pat${wi + 1} midi1 step16 "${t16}" != "${wantLast ? 'd#6:16' : 'd#6:16_'}"`); }
  }
  if (droneOk) ok('slot 25 drone = tied chain d#6:16_ x9 + final d#6:16 (10 bars, one attack)');
}
// 2. Verse tail = m25-26: 7 v127 + p9's one m25 note
{
  const s = bySlot.get(26)!; const t = lastSection(26);
  if (t.name === 'm25-26') ok('slot 26 tail section = m25-26'); else fail(`slot 26 tail = ${t.name}`);
  const n127 = s.v127.filter((v) => v.pattern === 8).length;
  if (n127 === 7) ok('slot 26 pat8 carries 7 v127 hits (the m25-26 fill)'); else fail(`slot 26 pat8 v127 = ${n127} != 7`);
  // p9's ONE m25 note is 32 steps (2 bars), so the importer authors it as its
  // own 2-token tied chain: :16_ @0 + :16 @16. One note, one attack.
  const m1 = hitSteps(t, 'midi1');
  const tok0 = tokAt(t, 'midi1', 0); const tok16 = tokAt(t, 'midi1', 16);
  if (m1.length === 2 && m1[0] === 0 && m1[1] === 16 && tok0.endsWith('_')
    && pitchesOf(tok0) === pitchesOf(tok16) && !tok16.endsWith('_'))
    ok(`slot 26 pat8 midi1 = p9's one m25 note as a tied chain (${tok0} + ${tok16})`);
  else fail(`slot 26 pat8 midi1 hits [${m1}] ("${tok0}", "${tok16}") != one 32-step tied chain`);
}
// 3. PreChor tail = m39-40: 5 v127
{
  const s = bySlot.get(27)!; const t = lastSection(27);
  if (t.name === 'm39-40') ok('slot 27 tail section = m39-40'); else fail(`slot 27 tail = ${t.name}`);
  const n = s.v127.filter((v) => v.pattern === 7).length;
  if (n === 5) ok('slot 27 pat7 carries 5 v127 hits'); else fail(`slot 27 pat7 v127 = ${n} != 5`);
}
// 4. PreCh2 tail = m55, 16 steps, 1 v127
{
  const s = bySlot.get(28)!; const t = lastSection(28);
  if (t.name === 'm55' && t.steps === 16) ok('slot 28 tail = m55 @ 16 steps'); else fail(`slot 28 tail = ${t.name} @ ${t.steps}`);
  const n = s.v127.filter((v) => v.pattern === 4).length;
  if (n === 1) ok('slot 28 pat4 carries 1 v127 hit'); else fail(`slot 28 pat4 v127 = ${n} != 1`);
}
// 5. Chorus2 tail = m70-71: 7 v127
{
  const s = bySlot.get(29)!; const t = lastSection(29);
  if (t.name === 'm70-71') ok('slot 29 tail section = m70-71'); else fail(`slot 29 tail = ${t.name}`);
  const n = s.v127.filter((v) => v.pattern === 8).length;
  if (n === 7) ok('slot 29 pat8 carries 7 v127 hits'); else fail(`slot 29 pat8 v127 = ${n} != 7`);
}
// 6. BridgeA tail = cell close (play 6 == play 3 content)
{
  const s = bySlot.get(30)!;
  if (s.order[5] === s.order[2] && s.order[2] === 'm76-77') ok('slot 30 pat6 = pat3 content (m76-77, cell close)');
  else fail(`slot 30 pat6 "${s.order[5]}" != pat3 "${s.order[2]}" (m76-77)`);
}
// 7. BridgeB tail = m94-95 = the m88-89 cell close PLUS the d#4:16 strings-tail
//    continuation at midi1 step 0 (the named SS1 deviation; every other track identical)
{
  const s = bySlot.get(31)!;
  const tail = s.sections.find((x) => x.name === s.order[5])!;
  const p3 = s.sections.find((x) => x.name === s.order[2])!;
  if (tail.name === 'm94-95' && p3.name === 'm88-89') ok('slot 31 pat6 = m94-95, pat3 = m88-89');
  else fail(`slot 31 pat6 "${tail.name}" / pat3 "${p3.name}"`);
  const keysA = Object.keys(tail.voices).filter((v) => v !== 'midi1').sort();
  const keysB = Object.keys(p3.voices).filter((v) => v !== 'midi1').sort();
  const sameOthers = JSON.stringify(keysA) === JSON.stringify(keysB)
    && keysA.every((v) => tail.voices[v] === p3.voices[v]);
  if (sameOthers) ok('slot 31 pat6 == pat3 on every track except midi1 (cell close intact)');
  else fail('slot 31 pat6 differs from pat3 beyond midi1');
  const m1hits = hitSteps(tail, 'midi1');
  if (p3.voices.midi1 === undefined && m1hits.length === 1 && m1hits[0] === 0 && tokAt(tail, 'midi1', 0) === 'd#4:16')
    ok('slot 31 pat6 midi1 = the d#4:16 continuation alone (pat3 midi1 empty)');
  else fail(`slot 31 pat6 midi1 [${m1hits}] "${tokAt(tail, 'midi1', 0)}" != d#4:16 continuation alone`);
}
// 8. Outro tail = m106-107 with the decoded m107 ending image
{
  const t = lastSection(32);
  if (t.name === 'm106-107') ok('slot 32 tail section = m106-107'); else fail(`slot 32 tail = ${t.name}`);
  const want: Array<[string, number[]]> = [
    ['kick', [16, 22, 24]], ['hat', [16, 18, 20, 22, 24, 28]], ['snare', [20]],
  ];
  const bad: string[] = [];
  for (const [voice, steps] of want) {
    const got = hitSteps(t, voice).filter((x) => x >= 16);
    if (JSON.stringify(got) !== JSON.stringify(steps)) bad.push(`${voice} [${got}] != [${steps}]`);
  }
  if (bad.length === 0) ok('slot 32 pat6 m107 ending image (0:hat+kick 2:hat 4:hat+snare 6:hat+kick 8:hat+kick 12:hat)');
  else fail(`slot 32 pat6 m107 ending: ${bad.join('; ')}`);
}

// ── edge-tie instance list + fidelity union ──────────────────────────
console.log(`\n=== edge-tie rule instances (${edgeInstances.length}) ===`);
for (const e of edgeInstances) console.log(`  ${e}`);
console.log('\n=== dropped-fidelity union (melodic imports) ===');
for (const [f, c] of [...fidelityUnion.entries()].sort()) console.log(`  ${f}: ${c}`);

writeFileSync('C:/dev/mcp-midi-tools/samples/_scratch/redbone-staged.json', JSON.stringify(staged, null, 2));
console.log(`\n${failures === 0 ? 'ALL STAGING CHECKS PASS' : failures + ' FAILURES'} - staged JSON written to samples/_scratch/redbone-staged.json`);
process.exitCode = failures === 0 ? 0 : 1;
