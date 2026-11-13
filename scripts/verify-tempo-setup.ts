/**
 * Golden: import_songsterr `tempo_setup`, the "set the clock master to N BPM"
 * surface (Tier-0 of the slaved-rig tempo plan).
 *
 * The stored drum patterns carry no tempo; the sequencer that plays them is
 * slaved to the rig's clock master, so a song's tempo must be set THERE. This
 * pins the two things that make the feature a general rig-control feature rather
 * than a special case for any one device:
 *
 *  - the clock master is named by ROLE from the rig manifest (any device can hold
 *    it), and falls back to a generic "your clock master" phrase with no manifest.
 *  - SINGLE-tempo scope: one distinct tempo → one "set to N BPM" line; more than
 *    one → a per-section notice that stops short of a per-region plan.
 *
 * Most cases are pure (no network) by unit-testing buildTempoSetup / distinctTempos.
 * The last case DRIVES the real tool on a known single-tempo song (network, like
 * the other import goldens) to confirm the field is wired onto the live result.
 *
 * Run:  npx tsx scripts/verify-tempo-setup.ts
 */
import {
  buildTempoSetup,
  distinctTempos,
  executeImportSongsterr,
} from '@mcp-midi-control/core/protocol-generic/dispatcher/songsterr.js';
import { FIXTURE_SONG_A_URL, installSongsterrReplay } from './songsterr-replay.js';

let fail = 0;
const ck = (l: string, ok: boolean, d?: string) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${l}${ok || !d ? '' : ' :: ' + d}`); if (!ok) fail++; };

// 1. distinctTempos: first-appearance order, de-duplicates repeated bpm marks (a
//    tempo "reset" to the same value is NOT a tempo change).
ck('distinctTempos de-dups + keeps order',
  distinctTempos([{ bpm: 120 }, { bpm: 120 }, { bpm: 96 }, { bpm: 120 }]).join(',') === '120,96',
  distinctTempos([{ bpm: 120 }, { bpm: 120 }, { bpm: 96 }, { bpm: 120 }]).join(','));

// 2. single-tempo, named clock master (the RC-505 dogfood case, but by role).
{
  const ts = buildTempoSetup([128], { masters: ['RC-505mk2'], followers: ['Novation Circuit Tracks', 'Fractal AM4'] })!;
  ck('single-tempo: multi_tempo false', ts.multi_tempo === false);
  ck('single-tempo: one bpm', ts.bpms.length === 1 && ts.bpms[0] === 128);
  ck('single-tempo: names the master', ts.clock_master === 'RC-505mk2');
  ck('single-tempo: instruction sets one BPM on the named master',
    /Set your clock master \(RC-505mk2\) to 128 BPM/.test(ts.instruction) &&
    /Novation Circuit Tracks and Fractal AM4 follow its clock/.test(ts.instruction), ts.instruction);
}

// 3. generalization: a DIFFERENT device as clock master is named (not hardwired).
{
  const ts = buildTempoSetup([90], { masters: ['Novation Circuit Tracks'], followers: [] })!;
  ck('any device can be the clock master', ts.clock_master === 'Novation Circuit Tracks' && /Circuit Tracks\) to 90 BPM/.test(ts.instruction), ts.instruction);
}

// 4. no rig manifest: generic phrase, no clock_master/followers fields, still usable.
{
  const ts = buildTempoSetup([100], { masters: [], followers: [] })!;
  ck('no manifest: generic "your clock master"', ts.clock_master === undefined && ts.followers === undefined && /Set your clock master to 100 BPM/.test(ts.instruction), ts.instruction);
}

// 5. multi-tempo: single-tempo scope means a per-section notice, NOT a per-region plan.
{
  const ts = buildTempoSetup([71, 141, 148], { masters: ['RC-505mk2'], followers: [] })!;
  ck('multi-tempo: multi_tempo true', ts.multi_tempo === true);
  ck('multi-tempo: lists every distinct tempo', ts.bpms.join(',') === '71,141,148');
  ck('multi-tempo: notice sets tempo per section (no per-region automation)',
    /changes tempo \(71 → 141 → 148 BPM\)/.test(ts.instruction) && /sets ONE tempo/.test(ts.instruction) && /change it by hand at each tempo boundary/.test(ts.instruction), ts.instruction);
}

// 6. no tempo in the tab → no instruction (nothing to report).
ck('empty tempo map → undefined', buildTempoSetup([], { masters: ['RC-505mk2'], followers: [] }) === undefined);

// 7. fractional bpm renders cleanly (no float noise), integer stays bare.
ck('fmt: integer bare', /to 120 BPM/.test(buildTempoSetup([120], { masters: [], followers: [] })!.instruction));
ck('fmt: fractional one decimal', /to 92\.5 BPM/.test(buildTempoSetup([92.5], { masters: [], followers: [] })!.instruction));

// 8. Whole-import drive (a generated single-tempo song from scripts/songsterr-replay.ts):
//    a single-tempo song carries tempo_setup on the real result (no manifest here →
//    generic phrase, and the field is present).
{
  const restoreFetch = installSongsterrReplay();
  const r = await executeImportSongsterr({ url: FIXTURE_SONG_A_URL, whole_song: true, fuzz: 0 }) as any;
  ck('live: tempo_setup present on the result', r.tempo_setup !== undefined && r.tempo_setup.multi_tempo === false && r.tempo_setup.bpms.length === 1, JSON.stringify(r.tempo_setup));
  ck('live: next_step points at the tempo setup', /tempo_setup/.test(r.next_step), r.next_step.slice(-90));
  restoreFetch();
}

console.log(fail ? `\n${fail} FAILED` : '\nall tempo-setup checks pass');
process.exit(fail ? 1 : 0);
