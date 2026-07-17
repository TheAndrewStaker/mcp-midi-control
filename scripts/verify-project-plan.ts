/**
 * Golden: import_songsterr `project_plan` — the multi-project song layout.
 *
 * A real song never fits one Circuit project (8 pattern slots, 8 chained plays),
 * so `whole_song` chunks the play order into projects. These pin the properties
 * that matter and the two defects a 2026-07-17 review found:
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
// 5. every project still fits, on the real songs.
for (const [name, url] of [
  ['Amber', 'https://www.songsterr.com/a/wsa/311-amber-drum-tab-s24430'],
  ['Caught a Glimpse', 'https://www.songsterr.com/a/wsa/blindside-caught-a-glimpse-drum-tab-s2323977'],
] as const) {
  const r = await executeImportSongsterr({ url, whole_song: true, fuzz: 0 } as never) as any;
  const pp = r.arrangement.project_plan;
  const bad = pp.projects.filter((x: any) => x.order.length > 8 || x.patterns.length > 8);
  let i = 0, ok = true;
  for (const l of pp.projects.flatMap((x: any) => x.order)) { const j = r.arrangement.order.indexOf(l, i); if (j < 0) { ok = false; break; } i = j + 1; }
  ck(`${name}: all fit + order preserved (${pp.projects.length} projects)`, bad.length === 0 && ok);
  ck(`${name}: next_step points at project_plan`, /project_plan/.test(r.next_step), r.next_step.slice(0, 90));
}
console.log(fail ? `\n${fail} FAILED` : '\nall fix checks pass');
process.exit(fail ? 1 : 0);
