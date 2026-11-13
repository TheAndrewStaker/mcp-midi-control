/**
 * Golden: deterministic song → Circuit-projects PLANNER (no hardware, no network).
 *
 * Exercises `planSongProjects` + the `bake-song-fills` SMF encoder against an INVENTED song,
 * Test Song A, built in code by `scripts/syntheticSong.ts` in the part JSON shape the importer
 * reads. The song is written to carry each thing the planner corrects (see `testSongA` for the
 * bar-by-bar reasons), and every relation asserted here is COMPUTED by the planner from it.
 *
 * Roster:
 *   0 Lead Guitar     [live]
 *   1 Rhythm Guitar   [live]
 *   2 Bass            backing
 *   3 Drums           backing
 *   4 Voice Oohs      decorative vocal
 *
 * Run via:  npx tsx scripts/verify-song-planner.ts
 */

import {
  toChopPart,
  planSongProjects,
  formatSongProjectPlan,
  GM_TOMS,
  type ChopPartFlat,
  type SongProject,
} from '../packages/core/src/protocol-generic/patterns/index.js';
import { parseMidiFile } from '../packages/core/src/protocol-generic/patterns/midiFile.js';
import { type SongsterrPart } from '../packages/core/src/protocol-generic/patterns/songsterr.js';
import { encodeFillMidi, buildBakePlan } from './bake-song-fills.js';
import { testSongA, TEST_SONG_A_BREAKDOWN_FILL, TEST_SONG_A_LIVE, TEST_SONG_A_SPINE } from './syntheticSong.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}${detail !== undefined ? `  (${detail})` : ''}`); }
}

const rawParts = new Map<number, SongsterrPart>();
const parts: ChopPartFlat[] = [];
for (const p of testSongA()) {
  rawParts.set(p.partId, p.part);
  parts.push(toChopPart(p.partId, p.label, p.part));
}

const plan = planSongProjects(parts, rawParts, { live: TEST_SONG_A_LIVE });

// Print the human-readable plan (so the report can quote it).
console.log(formatSongProjectPlan(plan, 'Test Song A (invented)'));
console.log('\n──────────────────────────────────────────────────────────────');
console.log('ASSERTIONS\n');

const bySection = (name: string): SongProject | undefined => plan.projects.find((p) => p.section === name);
const proj = (name: string): SongProject => {
  const p = bySection(name);
  if (p === undefined) throw new Error(`no project for section ${name}`);
  return p;
};

// ── 1) SECTION SPINE ─────────────────────────────────────────────────
check('spine: ten sections', plan.section_spine.length === TEST_SONG_A_SPINE.length, String(plan.section_spine.length));
for (const [name, m] of TEST_SONG_A_SPINE) {
  const s = plan.section_spine.find((x) => x.name === name);
  check(`spine: ${name} starts m${m}`, s !== undefined && s.from_measure === m, JSON.stringify(s));
}

// ── 2) LIVE-AWARE Intro trim: keeps m3-18 (oohs enter m3, the band at m5) ─────
{
  const intro = proj('Intro');
  check('Intro kept window is m3-18 (head-trimmed to where the oohs enter)',
    intro.from_measure === 3 && intro.to_measure === 18, `m${intro.from_measure}-${intro.to_measure}`);
  check('Intro was head-trimmed by 2 bars (guitar-only m1-2), nothing off the tail',
    intro.trimmed !== undefined && intro.trimmed.head_bars === 2 && intro.trimmed.tail_bars === 0, JSON.stringify(intro.trimmed));
  check('Intro is not m5-18 (a drums-only trim); the oohs at m3 stop the trim',
    intro.from_measure !== 5, `from=${intro.from_measure}`);
  check('the trimmed Intro is exactly the 16-bar ceiling', intro.bars === 16 && intro.over_ceiling === true, `${intro.bars} bars`);
  check('a live-only trim is reported', plan.live_only_trims.length >= 1 && plan.live_only_trims.some((t) => t.includes('Intro')));
}

// ── 3) OUTRO dropped (oohs + guitar only, no rhythm section) ──────────
{
  const outro = proj('Outro');
  check('Outro is DROPPED (only live + decorative vocal back it)', outro.drop === true, JSON.stringify({ drop: outro.drop, reason: outro.drop_reason }));
  check('Outro drop names the decorative vocal as what is left', /Voice Oohs/.test(outro.drop_reason ?? ''), outro.drop_reason);
  check('Outro is NOT a Chorus reuse', outro.relation === 'unique' && outro.reuse_of === undefined, outro.relation);
  check('Outro drop is listed in dropped[]', plan.dropped.some((d) => d.section === 'Outro'));
}

// ── 4) DEDUP: Verse 1 vs Verse 2 = shared-groove, NOT superset ───────
{
  const v1 = proj('Verse 1');
  const v2 = proj('Verse 2');
  check('Verse 1 is authored (unique first occurrence)', v1.relation === 'unique' && plan.authored_projects.includes(v1.project));
  check('Verse 2 is shared-groove with Verse 1', v2.relation === 'shared-groove' && v2.reuse_of === v1.project,
    `${v2.relation} reuse_of=${v2.reuse_of}`);
  check('Verse 2 is NOT a superset', v2.relation !== 'superset', v2.relation);
  check('Verse 2 agrees on 3 of its 4 bars and reports the fourth (m30, its fill) to bake per-use',
    v2.groove_agreement === 0.75 && JSON.stringify(v2.differing_bars) === '[30]', JSON.stringify({ a: v2.groove_agreement, d: v2.differing_bars }));
  check('Verse 2 is not re-authored (reuses Verse 1)', !plan.authored_projects.includes(v2.project));
}

// ── 5) DEDUP: Chorus 1 / 2 / 3 share one groove ───────────────────
{
  const c1 = proj('Chorus 1');
  const c2 = proj('Chorus 2');
  const c3 = proj('Chorus 3');
  check('Chorus 1 is authored (first occurrence)', c1.relation === 'unique' && plan.authored_projects.includes(c1.project));
  check('Chorus 1 is not merged into Verse 1 (same length, a different groove)', c1.reuse_of === undefined);
  check('Chorus 2 is shared-groove reusing Chorus 1', c2.relation === 'shared-groove' && c2.reuse_of === c1.project, `${c2.relation} reuse_of=${c2.reuse_of}`);
  check('Chorus 3 is shared-groove reusing Chorus 1', c3.relation === 'shared-groove' && c3.reuse_of === c1.project, `${c3.relation} reuse_of=${c3.reuse_of}`);
  check('only ONE chorus project is authored', [c1, c2, c3].filter((c) => plan.authored_projects.includes(c.project)).length === 1);
}

// ── Solo is its own project (has full drum+bass backing) ─────────────
{
  const solo = proj('Solo');
  check('Solo is NOT dropped (full drum+bass backing)', solo.drop === false);
  check('Solo is its own project (not a reuse)', solo.relation === 'unique' && plan.authored_projects.includes(solo.project), solo.relation);
  check('six projects are authored: Intro, Verse 1, Chorus 1, Bridge, Breakdown, Solo',
    plan.authored_projects.map((n) => plan.projects.find((p) => p.project === n)!.section).join(',') === 'Intro,Verse 1,Chorus 1,Bridge,Breakdown,Solo',
    JSON.stringify(plan.authored_projects));
}

// ── 6) TOM LANES: Breakdown ⊇ {45,47} (the doubled-tom drive) ─────────
{
  const bd = proj('Breakdown');
  check('Breakdown tom lanes ⊇ {45,47}', bd.tom_lanes.includes(45) && bd.tom_lanes.includes(47), JSON.stringify(bd.tom_lanes));
  check('Breakdown is flagged doubled-toms (>1 lane)', bd.doubled_toms === true, JSON.stringify(bd.tom_lanes));
  check('a one-tom section (Verse 1) and a tomless one (Bridge) are not flagged doubled',
    proj('Verse 1').doubled_toms === false && JSON.stringify(proj('Verse 1').tom_lanes) === '[45]' && proj('Bridge').tom_lanes.length === 0);
}

// ── 7) FILL WORKLIST includes the breakdown's last bar ───────────────
const FILL_M = TEST_SONG_A_BREAKDOWN_FILL;
const fill = plan.fill_worklist.find((f) => f.section === 'Breakdown' && f.from_measure === FILL_M);
check(`Breakdown fill worklist includes m${FILL_M}`, fill !== undefined, JSON.stringify(plan.fill_worklist.filter((f) => f.section === 'Breakdown')));
check('that bar is flagged ONLY by the crash on the next section\'s downbeat (it is no denser, and toms drive the section)',
  fill !== undefined && fill.reasons.join('|') === 'crash on next section downbeat', fill?.reasons.join('|'));
check('the tom-driven breakdown bars before it are groove, not fills',
  JSON.stringify(proj('Breakdown').fill_candidates) === `[${FILL_M}]`, JSON.stringify(proj('Breakdown').fill_candidates));
check('the worklist lists ≥1 chorus fill too', plan.fill_worklist.some((f) => /Chorus/.test(f.section)));
check('the Bridge (four identical bars) contributes no fill', !plan.fill_worklist.some((f) => f.section === 'Bridge'));

// ── 8) The fill .mid decodes to open-hat(46)+kick+descending toms 50→47→45→41 ──
if (fill !== undefined) {
  const tpb = 480;
  const bytes = encodeFillMidi(fill.events, { ticksPerBeat: tpb });
  const parsed = parseMidiFile(bytes);
  check('fill .mid round-trips: note count preserved', parsed.notes.length === fill.events.length && fill.events.length === 7, `mid=${parsed.notes.length} events=${fill.events.length}`);
  check('fill .mid contains an open hi-hat (GM 46)', parsed.notes.some((n) => n.note === 46));
  check('fill .mid contains a kick (GM 35/36)', parsed.notes.some((n) => n.note === 36 || n.note === 35));
  const toms = parsed.notes.filter((n) => GM_TOMS.has(n.note)).sort((a, b) => a.tick - b.tick).map((n) => n.note);
  check('fill toms descend 50 → 47 → 45 → 41', JSON.stringify(toms) === JSON.stringify([50, 47, 45, 41]), JSON.stringify(toms));
  // first/last onset (computed from the events, not hard-coded)
  const evsSorted = [...fill.events].sort((a, b) => a.beat - b.beat);
  const firstTick = Math.round(evsSorted[0].beat * tpb);
  const lastTick = Math.round(evsSorted[evsSorted.length - 1].beat * tpb);
  const parsedTicks = parsed.notes.map((n) => n.tick);
  check('fill .mid first onset matches the fill', Math.min(...parsedTicks) === firstTick, `mid=${Math.min(...parsedTicks)} expect=${firstTick}`);
  check('fill .mid last onset matches the fill', Math.max(...parsedTicks) === lastTick, `mid=${Math.max(...parsedTicks)} expect=${lastTick}`);
  check('the fill starts on beat 2 of the bar (relative beat 1.0) and ends on the last 8th (3.5)',
    Math.abs(evsSorted[0].beat - 1.0) < 1e-6 && Math.abs(evsSorted[evsSorted.length - 1].beat - 3.5) < 1e-6, `first beat=${evsSorted[0].beat}`);
}

// ── 9) BAKE PLAN: worklist → bouncer commands + upload_sample slot map ─
{
  const bake = buildBakePlan(plan, { outDir: 'samples/fills', state: 'states/test-kit.bin', firstSlot: 1 });
  check('bake plan: one entry per fill', bake.entries.length === plan.fill_worklist.length && bake.entries.length === 8, `${bake.entries.length} vs ${plan.fill_worklist.length}`);
  check('bake plan: every entry has a distinct pool slot', new Set(bake.entries.map((e) => e.pool_slot)).size === bake.entries.length);
  check('bake plan: commands reference --state and never invoke bouncer inline',
    bake.entries.every((e) => e.bouncer_command.includes('--state states/test-kit.bin') && e.bouncer_command.startsWith('bouncer phrase')));
  check('bake plan: the breakdown fill is present in the slot map', bake.slot_map.some((s) => /Breakdown/.test(s.fill) && new RegExp(`m${FILL_M}\\b`).test(s.fill)));
  const entry = bake.entries.find((e) => e.fill.section === 'Breakdown' && e.fill.from_measure === FILL_M);
  check('bake plan: the breakdown fill has an entry', entry !== undefined);
  if (entry !== undefined) {
    const parsed = parseMidiFile(encodeFillMidi(entry.fill.events));
    check('bake plan: the breakdown fill entry encodes a valid SMF', parsed.notes.length === entry.fill.events.length);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
