/**
 * Redbone plan probe: replicate the EXACT shipped whole_song parts:[5,7,9,10]
 * pipeline (dispatcher/songsterr.ts buildWholeSongBank + planProjects +
 * planSongChop) offline from the cached source (s434040 rev 7419203).
 * Read-only, no device, no network.
 */
import { readFileSync } from 'node:fs';

import {
  flattenSongsterrDrums,
  flattenSongsterrMelodic,
  isMelodicPart,
  type SongsterrPart,
} from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';
import {
  decomposeToPatterns,
  coalescePatterns,
  planArrangement,
  patternLabel,
  arrangementSummary,
  planProjects,
  type DecomposeLayer,
} from '@mcp-midi-control/core/protocol-generic/patterns/songStructure.js';
import {
  planSongChop, toChopPart, type ChopPartFlat,
} from '@mcp-midi-control/core/protocol-generic/patterns/songChop.js';
import { quantizedToGrids } from '@mcp-midi-control/core/protocol-generic/patterns/midiFile.js';

const CACHE = 'samples/songsterr-cache/s434040';
const part = (n: number): SongsterrPart =>
  JSON.parse(readFileSync(`${CACHE}/part-${n}.json`, 'utf8')) as SongsterrPart;

const SELECTED = [5, 7, 9, 10];
const LABELS: Record<number, string> = {
  5: 'Piano 1 (synth2)', 7: 'Synths 1 (synth1)', 9: 'Synths 3 (midi1)', 10: 'Drums (midi2+internal)',
};
const chopSteps = 4;

// ── drum flat + ghost/accent census ──────────────────────────────────
const p10 = part(10);
const drumFlat = flattenSongsterrDrums(p10); // defaults: ghostVelocity 40
const velCensus = new Map<number, number>();
for (const e of drumFlat.events) velCensus.set(e.velocity ?? -1, (velCensus.get(e.velocity ?? -1) ?? 0) + 1);
console.log('=== DRUMS (p10) ===');
console.log('events:', drumFlat.events.length, 'ghosts:', drumFlat.ghosts, 'unmapped:', drumFlat.unmapped,
  'flams_collapsed:', drumFlat.flams_collapsed, 'graces_folded:', drumFlat.graces_folded);
console.log('velocity census:', [...velCensus.entries()].sort((a, b) => a[0] - b[0])
  .map(([v, n]) => `${v}:${n}`).join('  '));
const byVoice = new Map<string, Map<number, number>>();
for (const e of drumFlat.events) {
  const m = byVoice.get(e.voice) ?? new Map<number, number>();
  m.set(e.velocity ?? -1, (m.get(e.velocity ?? -1) ?? 0) + 1);
  byVoice.set(e.voice, m);
}
for (const [v, m] of byVoice) {
  console.log(`  ${v}: ` + [...m.entries()].sort((a, b) => a[0] - b[0]).map(([vel, n]) => `v${vel}x${n}`).join(' '));
}
console.log('tempos:', JSON.stringify(drumFlat.tempos), 'totalBeats:', drumFlat.totalBeats);
console.log('sections:', drumFlat.sections.map((s) => `${s.name}@m${s.startMeasure + 1}`).join(' | '));

// ── marker chop (song_plan) over the four parts ──────────────────────
const chopParts: ChopPartFlat[] = SELECTED.map((id) => toChopPart(id, LABELS[id], part(id)));
const chop = planSongChop(chopParts, { stepsPerBeat: chopSteps });
console.log('\n=== MARKER CHOP (song_plan) ===');
console.log('boundaries: m' + chop.boundaries.join(', m'));
for (const pr of chop.projects) {
  console.log(`P${pr.project} m${pr.from_measure}-${pr.to_measure} bars=${pr.bars} patterns=${pr.pattern_count}`
    + ` steps=[${pr.pattern_steps.join(',')}] uniform=${pr.uniform_patterns}`
    + ` parts=[${pr.parts.map((x) => x.partId).join(',')}]`);
}
console.log('warnings:', chop.warnings.length ? chop.warnings : '(none)');

// ── union-keyed groove bank + content-driven project plan ────────────
const layers: DecomposeLayer[] = [];
for (const id of SELECTED) {
  if (id === 10) continue;
  const p = part(id);
  if (!isMelodicPart(p)) throw new Error(`p${id} unexpectedly not melodic`);
  const m = flattenSongsterrMelodic(p);
  layers.push({
    label: LABELS[id],
    onsets: m.notes.map((n) => ({
      beat: n.beat,
      token: `${n.pitch}:${Math.max(1, Math.round(n.durationBeats * chopSteps))}`,
    })),
  });
}
const walkEnd = (cp: ChopPartFlat): number => {
  const lm = cp.measures[cp.measures.length - 1];
  return lm === undefined ? 0 : lm.startBeat + (lm.signature[0] * 4) / lm.signature[1];
};
const totalBeats = Math.max(drumFlat.totalBeats, ...chopParts.map(walkEnd));

for (const fuzz of [0, 0.10]) {
  const decomp = decomposeToPatterns(drumFlat.events, {
    totalBeats, stepsPerPattern: 32, stepsPerBeat: chopSteps, layers,
  });
  const co = coalescePatterns(decomp, { maxDistance: fuzz });
  const plan = planArrangement(co, { maxPatterns: 8, barsPerWindow: 2 });
  const sections = co.patterns.map((q, i) => {
    const grids = quantizedToGrids(q);
    return { name: patternLabel(i), voices: Object.keys(grids).length > 0 ? grids : { kick: '.'.repeat(q.steps) } };
  });
  const order = co.order.map((i) => patternLabel(i));
  console.log(`\n=== CONTENT PLAN (fuzz ${fuzz}) ===`);
  console.log('windows:', co.windowCount, 'distinct sections:', co.patterns.length,
    'scene_steps(one-project):', plan.sceneCount,
    'fits: one_pattern', plan.fitsInOnePattern, 'chain_only', plan.fitsViaChainOnly, 'slots', plan.fitsInPatternSlots);
  console.log('summary:', arrangementSummary(co));
  console.log('order:', order.join(' '));
  const pp = planProjects(sections, order);
  console.log('project_plan note:', pp.note);
  console.log('dropped_silent:', pp.dropped_silent_projects);
  for (const e of pp.projects) {
    console.log(`  proj ${e.project} advance=${e.advance} patterns=${e.patterns.length} [${e.patterns.join(' ')}]`
      + ` plays=${e.order.length} starts_silent=${e.starts_silent}`);
    console.log(`    order: ${e.summary}`);
  }
  console.log('coalesce warnings:', co.warnings.length ? co.warnings : '(none)');
  console.log('decomp warnings:', decomp.warnings.length ? decomp.warnings.slice(0, 6) : '(none)');
}
