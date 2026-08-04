/**
 * Golden gate for `scripts/song-interview-brief.ts`.
 *
 * Network-free: builds a small synthetic two-part song (one melodic staff, one
 * drum staff, three marked sections engineered to produce one EXACT merge, one
 * NEAR miss, and one per-part loop) and asserts the invariants the interview
 * schema demands of every briefing:
 *
 *   1. DETERMINISM: two renders of the same input are byte-identical, and the
 *      output carries no timestamp beyond the supplied --date value.
 *   2. SHAPE: the four schema sections appear, in order, under the schema's own
 *      names; every Section 4 block carries exactly the four fixed headings and
 *      one blank ANSWER slot; a block never asks two questions.
 *   3. BLANKNESS: the Section 3 mapping table keeps its part column blank (the
 *      script must never guess a musical assignment).
 *   4. HOUSE RULES: no em dash anywhere in the output.
 *   5. ANALYSIS WIRING: the engineered EXACT pair merges (saves a project), the
 *      engineered NEAR pair is reported as a question and NOT merged, and the
 *      engineered drum loop is detected.
 *
 * Run: npx tsx scripts/verify-interview-brief.ts
 */

import type { SongsterrPart, SsMeasure } from '@mcp-midi-control/core/protocol-generic/patterns/songsterr.js';
import { buildBriefing, type Args, type LoadedSong } from './song-interview-brief.js';

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) { console.log(`  ok  ${name}`); return; }
  failures++;
  console.error(`FAIL  ${name}${detail !== undefined ? `: ${detail}` : ''}`);
}

// ── synthetic song ───────────────────────────────────────────────────
// 12 bars of 4/4, three 4-bar sections:
//   A m1-4:  melodic riff X + drum groove G      (authored)
//   B m5-8:  melodic riff X + drum groove G      (EXACT copy of A -> merge)
//   C m9-12: melodic riff Y + drum groove G      (NEAR: differs on melody only;
//            the drums are ALSO a 1-bar cell across each window -> part loop)

const q = (notes: { fret: number; string?: number }[] | undefined): { duration: [number, number]; notes?: { fret: number; string?: number }[]; rest?: boolean } =>
  notes === undefined ? { duration: [1, 4], rest: true } : { duration: [1, 4], notes };

/** One 4/4 bar of quarter notes; `frets[i] === undefined` is a rest beat. */
function bar(frets: (number | undefined)[], opts: { marker?: string; signature?: [number, number]; melodic: boolean }): SsMeasure {
  return {
    ...(opts.signature !== undefined ? { signature: opts.signature } : {}),
    ...(opts.marker !== undefined ? { marker: { text: opts.marker } } : {}),
    voices: [{ beats: frets.map((f) => q(f === undefined ? undefined : [opts.melodic ? { fret: f, string: 0 } : { fret: f }])) }],
  } as SsMeasure;
}

function melodicPart(): SongsterrPart {
  const riffX = [0, 2, 3, 5];
  const riffY = [0, 2, 3, 7]; // one note different: the NEAR difference
  const measures: SsMeasure[] = [];
  const sections: [string, number[]][] = [['A', riffX], ['B', riffX], ['C', riffY]];
  for (const [name, riff] of sections) {
    for (let i = 0; i < 4; i++) {
      measures.push(bar(riff, { melodic: true, ...(i === 0 ? { marker: name, signature: [4, 4] as [number, number] } : {}) }));
    }
  }
  return { measures, tuning: [40], strings: 1, instrument: 'Synth Lead' } as SongsterrPart;
}

function drumPart(): SongsterrPart {
  const groove = [36, undefined, 38, undefined]; // kick . snare . -> a 1-bar cell
  const measures: SsMeasure[] = [];
  for (const name of ['A', 'B', 'C']) {
    for (let i = 0; i < 4; i++) {
      measures.push(bar(groove, { melodic: false, ...(i === 0 ? { marker: name, signature: [4, 4] as [number, number] } : {}) }));
    }
  }
  return { measures, tuningFlat: true, instrument: 'Drums' } as SongsterrPart;
}

const song: LoadedSong = {
  songId: 999001,
  revisionId: 1,
  title: 'Verify Fixture',
  artist: 'Nobody',
  tracks: [
    { partId: 0, name: 'Lead', instrument: 'Synth Lead', instrumentId: 81, isDrums: false },
    { partId: 1, name: 'Kit', instrument: 'Drums', instrumentId: 1024, isDrums: true },
  ],
  raw: new Map<number, SongsterrPart>([[0, melodicPart()], [1, drumPart()]]),
};

const args: Args = {
  ref: '999001',
  mine: [],
  stepsPerBeat: 4,
  date: '2026-07-29',
  manifest: 'nonexistent-manifest.json', // exercises the graceful fallback line
  write: false,
};

// ── render + assertions ──────────────────────────────────────────────

const a = buildBriefing(song, args);
const b = buildBriefing(song, args);

check('deterministic: two renders byte-identical', a === b);
check('no em dash in output', !a.includes('—') && !a.includes('–'));
check('the only date is the supplied one', (a.match(/\d{4}-\d{2}-\d{2}/g) ?? []).every((d) => d === '2026-07-29'));

const sectionOrder = [
  '## Section 1: the whole-song briefing',
  '### Source', '### Shape', '### Cost', '### Grid loss', '### Density', '### Playability',
  '## Section 2: squash proposals',
  '### Merge (safe by construction)', '### Loop (safe by construction)',
  '### Trim (a judgement with a named cost, never applied without an answer)',
  '## Section 3: the default mapping',
  '## Section 4: the per-part question block',
];
let last = -1;
let ordered = true;
for (const h of sectionOrder) {
  const at = a.indexOf(h);
  if (at < 0 || at < last) { ordered = false; check(`section heading present and in order: ${h}`, false); break; }
  last = at;
}
if (ordered) check('all schema section headings present, in order', true);

const blocks = a.split(/^### P\d+ {2}/m).slice(1);
check('at least two Section 4 blocks (A+B merged share one, C has its own)', blocks.length >= 2, `got ${blocks.length}`);
for (const [i, blk] of blocks.entries()) {
  const one = (needle: string): boolean => blk.split(needle).length === 2;
  check(`block ${i + 1} has the four fixed headings exactly once each`,
    one('WHAT IS HERE') && one('DEFAULT') && one('THE CHOICE') && one('ANSWER: ______'));
  const qMarks = (blk.match(/\?/g) ?? []).length;
  const choice = blk.split('THE CHOICE')[1]?.split('ANSWER')[0] ?? '';
  const choiceQs = (choice.match(/\?/g) ?? []).length;
  check(`block ${i + 1} asks at most one question in THE CHOICE`, choiceQs <= 1, `${choiceQs} questions, ${qMarks} in block`);
}

check('mapping part column left blank', /\| Synth 1 \| ch1 \| Circuit synth \+ Hydrasynth \| ______ \| ______ \|/.test(a));
check('EXACT merge detected between A and B', /IDENTICAL|EXACT/.test(a.split('### Merge')[1]?.split('### Loop')[0] ?? ''));
check('merge saves a project', /SAVED [1-9]/.test(a));
check('NEAR reported as a question, not merged', a.includes('NEAR') && a.includes('NEVER merged'));
check('drum loop cell detected', /1-bar cell|\*\*1 bars?\*\*/.test(a));
check('missing manifest reported gracefully', a.includes('manifest not found at'));
check('deep links use the verified s<id>t<part>?measure= form', a.includes('https://www.songsterr.com/a/wsa/s999001t0?measure=1'));

if (failures > 0) {
  console.error(`\nverify-interview-brief: ${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nverify-interview-brief: all checks passed');
