/**
 * songPartRelations — the per-part, per-section-pair comparison matrix
 * (BK-AUTHORING-ENGINE, Item B).
 *
 * The planner already tokenizes every part into per-bar `BarToken`s
 * (`buildPartWindow` in `songPlanner.ts`, extracted verbatim from
 * `scripts/song-superset.ts`). Dedup consumes those tokens internally to reach a
 * single reuse verdict per section; this module SURFACES the same tokens as the
 * section×section×part matrix the owner asked for: for every pair of sections and
 * every part, "does this part play the same thing in both?" — the UI's indicator
 * row ("drums identical · bass identical · guitar different") AND the evidence a
 * reuse offer is shown against.
 *
 * It is NOT new comparison math. It reuses `buildPartWindow`'s exact tokenization
 * (post-quantization, signature-tagged, hit-set-per-bar) and only compares the
 * already-built tokens bar for bar. The only thing added over `song-superset.ts`
 * is the per-part-per-pair loop and the four-way verdict.
 *
 * Pure and network-free, like the planner: raw `SongsterrPart`s (for the reading)
 * + a section spine (name + measure span) in, `PartRelation[]` out.
 */

import { buildPartWindow, type PartWindow } from './songPlanner.js';
import { type ChopPartFlat } from './songChop.js';
import { type SongsterrPart, type MeasureInfo } from './songsterr.js';
import { type PartRelation } from './songAuthorTypes.js';

/** A section span to compare: a name plus its 1-based DISPLAYED measure range. */
export interface RelationSection {
  name: string;
  from_measure: number;
  to_measure: number;
}

export interface RelationOptions {
  /** Grid resolution (steps per quarter beat). 4 = 16ths (default), matching the planner. */
  stepsPerBeat?: number;
}

/** The `step:*` hit tokens of one bar body, as a set (empty string ⇒ empty set). */
function hitSet(body: string): Set<string> {
  return new Set(body.split(' ').filter(Boolean));
}

/** True when every element of `a` is also in `b` (a ⊆ b). */
function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Classify one part across two section spans from its per-bar tokens.
 *
 * The two spans are aligned bar-for-bar over their common length. The verdict:
 *  - `identical`: same bar count and every aligned bar equal (both-silent counts).
 *  - `prefix`:    aligned bars all equal but the spans are different lengths, so the
 *                 shorter is a strict prefix of the longer.
 *  - `superset`:  same aligned length, not identical, but one span's hits contain
 *                 the other's in every bar (a fill/variation ADDED, none removed).
 *  - `different`: anything else.
 *
 * `differingBars` are the DISPLAYED measure numbers of `b` (the second/later span)
 * whose token differs — the per-use bake candidates, anchored the same way the
 * planner anchors `SongProject.differing_bars`.
 */
function classifyPart(
  win: PartWindow,
  a: RelationSection,
  b: RelationSection,
): { relation: PartRelation['relation']; differingBars: number[] } {
  const aBars = win.bars.slice(a.from_measure - 1, a.to_measure);
  const bBars = win.bars.slice(b.from_measure - 1, b.to_measure);
  const n = Math.min(aBars.length, bBars.length);

  const differingBars: number[] = [];
  let aSubB = true; // a ⊆ b in every aligned bar
  let bSubA = true; // b ⊆ a in every aligned bar
  for (let i = 0; i < n; i++) {
    const at = `${aBars[i].sig}|${aBars[i].body}`;
    const bt = `${bBars[i].sig}|${bBars[i].body}`;
    if (at !== bt) differingBars.push(b.from_measure + i);
    if (aBars[i].sig !== bBars[i].sig) { aSubB = false; bSubA = false; continue; }
    const aset = hitSet(aBars[i].body);
    const bset = hitSet(bBars[i].body);
    if (!isSubset(aset, bset)) aSubB = false;
    if (!isSubset(bset, aset)) bSubA = false;
  }

  const sameLength = aBars.length === bBars.length;
  let relation: PartRelation['relation'];
  if (sameLength && differingBars.length === 0) relation = 'identical';
  else if (differingBars.length === 0) relation = 'prefix';
  else if (sameLength && (aSubB || bSubA)) relation = 'superset';
  else relation = 'different';

  return { relation, differingBars };
}

/**
 * Build the section×section×part relation matrix from the raw parts and a spine.
 *
 * Mirrors how `planSongProjects` builds its comparison windows: the anchor is the
 * LONGEST part's measure walk, and every part is tokenized against it with
 * `buildPartWindow`. One row is emitted per unordered section pair (in spine
 * order, `a` before `b`) and per part, so a caller can index by `(a, b, part)` or
 * filter to the mapped parts for a reuse decision.
 *
 * `parts` supplies the id/label/melodic roster and the anchor walk; `rawParts` the
 * source measures the tokenizer reads; `sections` the spans to compare. `part` in
 * each row is the part's LABEL (what the UI shows and the seeder resolves).
 */
export function computePartRelations(
  parts: readonly ChopPartFlat[],
  rawParts: ReadonlyMap<number, SongsterrPart>,
  sections: readonly RelationSection[],
  opts: RelationOptions = {},
): PartRelation[] {
  if (parts.length === 0) return [];
  const spb = opts.stepsPerBeat ?? 4;

  // Anchor on the longest measure walk, exactly as planSongProjects does.
  let anchor = parts[0];
  for (const p of parts) if (p.measures.length > anchor.measures.length) anchor = p;
  const measures: readonly MeasureInfo[] = anchor.measures;

  const windows = parts.map((p) => {
    const raw = rawParts.get(p.partId);
    if (raw === undefined) throw new Error(`computePartRelations: no raw part for partId ${p.partId} (${p.label}).`);
    return buildPartWindow(p.partId, p.label, raw, measures, spb);
  });

  const out: PartRelation[] = [];
  for (let i = 0; i < sections.length; i++) {
    for (let j = i + 1; j < sections.length; j++) {
      const a = sections[i];
      const b = sections[j];
      for (const win of windows) {
        const { relation, differingBars } = classifyPart(win, a, b);
        out.push({ a: a.name, b: b.name, part: win.label, relation, differingBars });
      }
    }
  }
  return out;
}

/**
 * Look one part's relation up for an unordered section pair. Returns undefined
 * when the pair/part was not compared. Used by the seeder to gate reuse on the
 * LIVE parts (a live diff is allowed to block reuse only when the policy says so).
 */
export function findRelation(
  relations: readonly PartRelation[],
  sectionX: string,
  sectionY: string,
  partLabel: string,
): PartRelation | undefined {
  return relations.find(
    (r) => r.part === partLabel
      && ((r.a === sectionX && r.b === sectionY) || (r.a === sectionY && r.b === sectionX)),
  );
}
