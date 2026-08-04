/**
 * Golden: import_songsterr `project_plan` — the multi-project song layout.
 *
 * A real song never fits one Circuit project (8 pattern slots per track), so
 * `whole_song` chunks the play order into projects. Since 2026-07-29 the
 * DEFAULT chop is content-driven and scene-chain-aware (a project spans up to
 * 4 scene steps x 8 patterns; `maxPlays` explicitly passed keeps the old pure
 * play budget); see scripts/verify-patterns.ts for the default-change goldens.
 * These pin the properties that matter and the two defects a 2026-07-17 review
 * found:
 *
 *  - a project boundary is a FOOT-SWITCH point, so a cut inside a repeated run is
 *    a live-performance failure. Back off to the run start when it is CHEAP; a
 *    project slot is scarcer than a tidy boundary, so decline an expensive one.
 *  - `starts_silent` must be real. It was dead code (always false) and it is
 *    load-bearing: a stored read decodes only pattern 1, so a chain that opens on
 *    a rest bar reads back as "empty" and looks like a failed write.
 *  - `next_step` must point at project_plan. It used to steer the agent to the
 *    lossy fuzz-merge workaround in the exact case that computed the plan.
 *
 * Network: hits Songsterr for the last two cases (same as the other import goldens).
 *
 * Run:  npx tsx scripts/verify-project-plan.ts
 */
import { planProjects } from '@mcp-midi-control/core/protocol-generic/patterns/songStructure.js';
import { executeImportSongsterr } from '@mcp-midi-control/core/protocol-generic/dispatcher/songsterr.js';

let fail = 0;
const ck = (l: string, ok: boolean, d?: string) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${l}${ok || !d ? '' : ' :: ' + d}`); if (!ok) fail++; };
const secs = (labels: string[], silent: string[] = []) =>
  labels.map((n) => ({ name: n, voices: silent.includes(n) ? { kick: '.'.repeat(32) } : { kick: 'x'.repeat(32) } }));

// 1. phrase back-off: a CHEAP cut inside a run (<= maxBackoff) backs off so the run
//    stays whole in the next project.
{
  const order = ['A', 'A', 'B', 'B', 'B', 'B', 'C', 'C', 'C', 'D'];
  const p = planProjects(secs(['A', 'B', 'C', 'D']), order);
  const flat = p.projects.flatMap((x) => x.order);
  ck('cheap back-off keeps the run whole', p.projects[0].order.join('') === 'AABBBB' && p.projects[1].order.join('') === 'CCCD',
    JSON.stringify(p.projects.map((x) => x.summary)));
  ck('back-off preserves the full order', flat.join(',') === order.join(','), flat.join(','));
}
// 1b. an EXPENSIVE back-off is declined: a project slot is scarcer than a tidy
//     boundary, so a long run at the limit is cut rather than giving up 4 plays.
{
  const order = ['A', 'A', 'B', 'B', 'C', 'C', 'C', 'C', 'C', 'D'];
  const p = planProjects(secs(['A', 'B', 'C', 'D']), order);
  const flat = p.projects.flatMap((x) => x.order);
  ck('expensive back-off declined (cuts at the limit)', p.projects[0].order.length === 8, JSON.stringify(p.projects.map((x) => x.summary)));
  ck('declined back-off still preserves the order', flat.join(',') === order.join(','), flat.join(','));
}
// 2. a vamp longer than maxPlays cannot be helped: cut at the limit, no infinite loop.
{
  const order = Array(9).fill('A');
  const p = planProjects(secs(['A']), order);
  ck('A x9 cuts at the limit (8 + 1)', p.projects.map((x) => x.order.length).join(',') === '8,1', JSON.stringify(p.projects.map((x) => x.summary)));
}
// 3. no back-off when the cut is already at a pattern change.
{
  const order = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  const p = planProjects(secs(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']), order);
  ck('clean boundary is not backed off', p.projects[0].order.length === 8, JSON.stringify(p.projects.map((x) => x.summary)));
}
// 4. starts_silent is now real (was always false).
{
  const p = planProjects(secs(['S', 'B'], ['S']), ['S', 'B', 'B']);
  ck('starts_silent true when the chain opens on a rest bar', p.projects[0].starts_silent === true, JSON.stringify(p.projects[0]));
  const q = planProjects(secs(['B', 'S'], ['S']), ['B', 'S', 'B']);
  ck('starts_silent false when it opens on content', q.projects[0].starts_silent === false);
}
// 5. every project still fits, on the real songs. "Fits" is the realizer's own
//    layout test: a plain chain (<=8 plays, one slot per play) OR a scene chain
//    (<=8 distinct patterns whose order compresses into <=4 contiguous
//    ascending scene steps), the shapes apply_pattern `arrangement` accepts.
const sceneRuns = (order: string[]): number => {
  const slot = new Map<string, number>();
  let runs = 0, last = -2;
  for (const l of order) {
    let s = slot.get(l);
    if (s === undefined) { s = slot.size; slot.set(l, s); }
    if (s !== last + 1) runs++;
    last = s;
  }
  return runs;
};
for (const [name, url] of [
  ['Amber', 'https://www.songsterr.com/a/wsa/311-amber-drum-tab-s24430'],
  ['Caught a Glimpse', 'https://www.songsterr.com/a/wsa/blindside-caught-a-glimpse-drum-tab-s2323977'],
] as const) {
  const r = await executeImportSongsterr({ url, whole_song: true, fuzz: 0 } as never) as any;
  const pp = r.arrangement.project_plan;
  const bad = pp.projects.filter((x: any) =>
    !(x.order.length <= 8 || (x.patterns.length <= 8 && sceneRuns(x.order) <= 4)));
  let i = 0, ok = true;
  for (const l of pp.projects.flatMap((x: any) => x.order)) { const j = r.arrangement.order.indexOf(l, i); if (j < 0) { ok = false; break; } i = j + 1; }
  ck(`${name}: all fit + order preserved (${pp.projects.length} projects)`, bad.length === 0 && ok);
  ck(`${name}: next_step points at project_plan`, /project_plan/.test(r.next_step), r.next_step.slice(0, 90));
}
// 6. THE WORKED CASE. "After Dark" (Mr.Kitty, song 501859 revision 4102120) was
//    laid out onto eight Circuit projects BY HAND in July 2026, and that hand
//    layout is the reference this algorithm has to reproduce from the source
//    alone. Its markers fall at m1, 19, 35, 51, 67, 83, 99 and 115: every gap is
//    exactly 16 bars except the Intro (18) and the final Chorus (21), so a
//    16-bar project lands on a section boundary every time once the two silent
//    tails are dropped. If this ever disagrees with the hand answer, work out
//    which is right before assuming it is this one.
//
//    Network: 7 parts, one fetch each.
{
  const r = await executeImportSongsterr({ url: '501859', whole_song: true, parts: 'all' } as never) as any;
  const p = r.song_plan;
  ck('After Dark: the golden is about the revision it was built from',
    r.song.revisionId === 4102120, String(r.song.revisionId));
  ck('After Dark: the source is read as 135 measures over 7 parts',
    p.measures === 135 && p.parts.length === 7, JSON.stringify({ m: p.measures, parts: p.parts.length }));
  ck('After Dark: the source markers are found at m1/19/35/51/67/83/99/115',
    p.sections.map((s: any) => s.from_measure).join(',') === '1,19,35,51,67,83,99,115',
    JSON.stringify(p.sections.map((s: any) => `${s.name}@${s.from_measure}`)));
  const windows = p.projects.map((x: any) => `m${x.from_measure}-${x.to_measure}`).join(' ');
  ck('After Dark: the chop reproduces the hand-built EIGHT windows exactly',
    windows === 'm1-16 m19-34 m35-50 m51-66 m67-82 m83-98 m99-114 m115-130', windows);
  ck('After Dark: every project is exactly 16 bars = 256 steps = 8 patterns',
    p.projects.every((x: any) => x.bars === 16 && x.steps === 256 && x.patterns === 8)
    && p.ceiling.max_steps === 256 && p.ceiling.max_bars === 16,
    JSON.stringify(p.projects.map((x: any) => `${x.bars}b/${x.steps}s/${x.patterns}p`)));
  ck('After Dark: the two trims are the SILENT TAILS m17-18 and m131-135, nothing else',
    p.trims.length === 2 && /tail m17-18/.test(p.trims[0]) && /tail m131-135/.test(p.trims[1])
    && p.projects[0].trimmed?.head_bars === 0 && p.projects[7].trimmed?.head_bars === 0
    && p.projects[0].trimmed?.tail_bars === 2 && p.projects[7].trimmed?.tail_bars === 5,
    JSON.stringify(p.trims));
  ck('After Dark: no section had to be split, and nothing was dropped as silent-only',
    p.splits.length === 0 && p.dropped_silent.length === 0,
    JSON.stringify({ splits: p.splits, dropped: p.dropped_silent }));
  ck('After Dark: all 7 parts share ONE boundary set (each is placed in every project)',
    p.boundaries.join(',') === '1,19,35,51,67,83,99,115'
    && p.projects.every((x: any) => x.parts.length + x.silent_parts.length === 7),
    JSON.stringify(p.boundaries));
  // Spot-check the occupancy against the hand-built build sheet: P1 is the two
  // pianos alone, P6 (the Break) is bass + pad only, and the sawtooth lead sounds
  // in the three Choruses and nowhere else. Those are the facts that decide which
  // part goes on which track, so a wrong one is a wrong song.
  const sounding = (i: number): string => p.projects[i].parts.map((x: any) => x.partId).join(',');
  ck('After Dark: P1 (Intro) is the pianos alone', sounding(0) === '1,5', sounding(0));
  ck('After Dark: P6 (Break) is bass + pad only, no leads and no drums', sounding(5) === '0,2', sounding(5));
  ck('After Dark: the sawtooth (part 3) sounds in P3/P5/P8 and in no other project',
    [0, 1, 3, 5, 6].every((i) => !p.projects[i].parts.some((x: any) => x.partId === 3))
    && [2, 4, 7].every((i) => p.projects[i].parts.find((x: any) => x.partId === 3)?.onsets === 84),
    JSON.stringify(p.projects.map((x: any) => x.parts.find((y: any) => y.partId === 3)?.onsets ?? 0)));
  ck('After Dark: the per-project onset counts match the hand build (bass 125, drums 157)',
    p.projects[1].parts.find((x: any) => x.partId === 0)?.onsets === 125
    && p.projects[1].parts.find((x: any) => x.partId === 6)?.onsets === 157
    && p.projects[5].parts.find((x: any) => x.partId === 0)?.onsets === 64
    && p.projects[6].parts.find((x: any) => x.partId === 0)?.onsets === 121,
    JSON.stringify(p.projects.map((x: any) => x.parts.map((y: any) => `${y.partId}:${y.onsets}`).join(' '))));
  ck('After Dark: the plan is offered for review, not authored',
    /READ THIS PLAN TO THE USER BEFORE AUTHORING/.test(r.next_step) && /once the user confirms/.test(r.next_step),
    r.next_step.slice(0, 90));
}

console.log(fail ? `\n${fail} FAILED` : '\nall fix checks pass');
process.exit(fail ? 1 : 0);
