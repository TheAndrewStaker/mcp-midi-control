/**
 * Songsterr → drum step-grid importer (the network FRONT-END).
 *
 * The pure parse/flatten/decompose logic lives in core
 * (`patterns/songsterr.ts` + `patterns/songStructure.ts`); this script owns the
 * one thing core can't: the 3-hop fetch off Songsterr's own JSON.
 *
 *   1. URL `…-s23527`            → songId 23527
 *   2. GET api/meta/{songId}     → revisionId, image (CDN hash), tracks[]
 *      (drum track = instrumentId 1024; its partId = its index in tracks[])
 *   3. GET {cdn}/{songId}/{revisionId}/{image}/{partId}.json  (gzip JSON)
 *
 * Two modes:
 *   (default)      window one section → a single 32-step pattern grid.
 *   --whole-song   decompose the ENTIRE track → a deduped pattern bank + the
 *                  song arrangement (see docs/design/songsterr-drum-import.md
 *                  for what plays today via chain vs. what waits on scenes).
 *
 * STATUS: prototype / read-only. Hits an unofficial CDN endpoint — fine for
 * local use; revisit before shipping as a product feature (ToS; the
 * partId-by-index assumption is verified on one song, see the design doc).
 *
 * Usage:
 *   npx tsx scripts/songsterr-drum-import.ts <url-or-id> [--from N] [--beats N] [--steps 4|8] [--json out.json]
 *   npx tsx scripts/songsterr-drum-import.ts <url-or-id> --whole-song [--bars-per-pattern 2] [--json out.json]
 */

import { writeFileSync } from 'node:fs';
import {
  quantizedToGrids,
  importSongsterrDrums,
  fetchSongsterrPart,
  flattenSongsterrDrums,
  unmappedSummary,
  decomposeToPatterns,
  coalescePatterns,
  planArrangement,
  arrangementSummary,
  patternLabel,
  type SongDecomposition,
} from '@mcp-midi-control/core/protocol-generic/patterns/index.js';

// The 3-hop fetch + track selection now lives in core (patterns/songsterrFetch.ts),
// shared with the import_songsterr MCP tool. This script is the CLI front-end.

// ── CLI ──────────────────────────────────────────────────────────────

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (flag: string): boolean => process.argv.includes(flag);

function printGrids(grids: Record<string, string>): void {
  const pad = Math.max(...Object.keys(grids).map((v) => v.length), 1);
  for (const [voice, grid] of Object.entries(grids)) console.log(`  ${voice.padEnd(pad)} | ${grid}`);
}

async function main() {
  const input = process.argv[2];
  if (!input || input.startsWith('--')) {
    console.error('usage: tsx scripts/songsterr-drum-import.ts <url-or-id> [--from N --beats N --steps 4|8 | --whole-song --bars-per-pattern 2] [--drum-map "0=clap,31=39"] [--json out.json]');
    process.exit(1);
  }
  const stepsPerBeat = Number(argVal('--steps') ?? 4);
  const jsonOut = argVal('--json');
  // --drum-map "0=clap,31=39": per-tab percussion remap (number → voice name or GM number).
  const drumMapArg = argVal('--drum-map');
  const drumMap = drumMapArg
    ? Object.fromEntries(drumMapArg.split(',').map((pair) => {
      const [k, v] = pair.split('=').map((s) => s.trim());
      const num = Number(v);
      return [Number(k), v !== '' && Number.isFinite(num) ? num : v];
    }))
    : undefined;

  console.log(`fetching ${input}…`);
  const trackName = argVal('--track-name');
  const cliTrack = argVal('--track') !== undefined ? Number(argVal('--track')) : undefined;
  const fetched = await fetchSongsterrPart(input, {
    ...(cliTrack !== undefined ? { track: cliTrack } : {}),
    ...(trackName !== undefined ? { trackName } : {}),
  });
  const { part, drumTracks } = fetched;
  // A --drum-map re-flattens the part with the remap; fetched.flat is map-less.
  const flat = drumMap ? flattenSongsterrDrums(part, { drumMap }) : fetched.flat;
  const usingUrlSelector = /-s\d+t\d+/.test(input);
  if (drumTracks.length > 1 && cliTrack === undefined && trackName === undefined && !usingUrlSelector) {
    console.log(`  NOTE: ${drumTracks.length} drum tracks — choose with …tN, --track N, or --track-name:`);
    for (const t of drumTracks) console.log(`     [${t.partId}] "${t.name}"  ${t.views ?? '?'} views${t.popular ? '  ← popular (default)' : ''}${t.partId === fetched.selectedPartId ? '  (using)' : ''}`);
  }
  console.log(`"${fetched.artist} — ${fetched.title}"  rev ${fetched.revisionId}  drum part ${fetched.selectedPartId} ("${drumTracks.find((t) => t.partId === fetched.selectedPartId)?.name ?? ''}")`);
  const tempoStr = flat.tempos.length > 1
    ? `${flat.tempos.map((t) => `${t.bpm}@m${flat.measures.find((m) => m.startBeat === t.beat)?.index ?? 0 + 1}`).join(' → ')} (multi-tempo)`
    : `${flat.bpm ?? '?'} bpm`;
  console.log(`tempo ${tempoStr}   signature ${flat.signature[0]}/${flat.signature[1]}   ${flat.measures.length} measures / ${Math.ceil(flat.totalBeats)} beats`);
  if (flat.unmapped > 0) {
    console.log(`  ⚠ ${flat.unmapped} hit(s) on non-GM percussion number(s) [${unmappedSummary(flat)}] skipped — remap with --drum-map "0=clap" if a layer is missing.`);
  }
  if (flat.flams_collapsed > 0) {
    console.log(`  (${flat.flams_collapsed} grace/flam doubling(s) folded into single hits)`);
  }
  if (flat.graces_folded > 0) {
    console.log(`  (${flat.graces_folded} grace-ornament beat(s) folded onto the following onset; a grace takes no measure time)`);
  }
  if (flat.ghosts > 0) {
    console.log(`  (${flat.ghosts} ghosted hit(s) imported SOFT at velocity 40, not dropped; a ghost note is played quietly)`);
  }
  if (flat.sections.length > 0) {
    console.log(`sections: ${flat.sections.map((s) => `${s.name}@m${s.startMeasure + 1}`).join('  ')}`);
    console.log(`  (window one with --section "<name>" or --from-measure N [--to-measure M])`);
  }

  if (hasFlag('--whole-song')) {
    const barsPerPattern = Number(argVal('--bars-per-pattern') ?? 2);
    const fuzz = hasFlag('--exact') ? 0 : Number(argVal('--fuzz') ?? 0.10);
    const maxPatterns = Number(argVal('--slots') ?? 8);
    // one bar = (sig0 * 4 / sig1) quarter-beats; × stepsPerBeat steps; × barsPerPattern.
    const stepsPerBar = Math.round((flat.signature[0] * 4 / flat.signature[1]) * stepsPerBeat);
    const windowSteps = stepsPerBar * barsPerPattern;
    const exact = decomposeToPatterns(flat.events, { stepsPerPattern: windowSteps, stepsPerBeat, totalBeats: flat.totalBeats });

    // Fuzzy-coalesce the bank (unless --exact); the plan is built over whichever we use.
    const used: SongDecomposition = fuzz > 0
      ? { ...exact, ...coalescePatterns(exact, { maxDistance: fuzz }) }
      : exact;
    const plan = planArrangement(used, { maxPatterns, barsPerWindow: barsPerPattern });

    console.log(`\nwhole-song: ${exact.windowCount} windows of ${barsPerPattern} bar(s) (${windowSteps} steps)`);
    console.log(`  exact dedup  → ${exact.uniquePatternCount} unique patterns`);
    if (fuzz > 0) console.log(`  fuzzy(${fuzz}) → ${used.uniquePatternCount} patterns (folds near-variants; --exact to disable, --fuzz N to tune)`);
    console.log(`arrangement: ${arrangementSummary(used)}`);

    console.log(`\npattern bank (label : grid):`);
    used.patterns.forEach((p, i) => { console.log(`\n  [${patternLabel(i)}]`); printGrids(quantizedToGrids(p)); });

    console.log('\n— scene-chain plan (anticipates scene coding) —');
    console.log(`  bank ${plan.bankSize}/${plan.maxPatterns} slots   scene-chain ${plan.sceneCount} steps`);
    for (const n of plan.notes) console.log(`  ${n}`);
    console.log('  scene-chain:');
    for (const s of plan.scenes) console.log(`    scene → pattern ${s.label}  × ${s.windows} window(s)${s.bars ? ` (${s.bars} bars)` : ''}`);
    for (const w of [...used.warnings, ...exact.warnings]) console.log(`  • ${w}`);
    if (flat.tempos.length > 1) {
      console.log(`  • MULTI-TEMPO (${flat.tempos.map((t) => t.bpm).join('/')} bpm): this single-tempo render uses ${flat.bpm} bpm. Per-scene tempo lands once scene-chain encoding does.`);
    }

    if (jsonOut) {
      writeFileSync(jsonOut, JSON.stringify({
        song: { songId: fetched.songId, revisionId: fetched.revisionId, title: fetched.title, artist: fetched.artist },
        tempo: flat.bpm, tempos: flat.tempos, signature: flat.signature, barsPerPattern, stepsPerPattern: windowSteps, stepsPerBeat,
        windowCount: exact.windowCount, exactUnique: exact.uniquePatternCount, fuzz, bankSize: plan.bankSize,
        order: used.order, arrangement: arrangementSummary(used),
        patterns: used.patterns.map((p) => quantizedToGrids(p)),
        sceneChain: plan.scenes,
        fits: { onePattern: plan.fitsInOnePattern, patternSlots: plan.fitsInPatternSlots, chainOnly: plan.fitsViaChainOnly },
      }, null, 2));
      console.log(`\nwrote ${jsonOut}`);
    }
    return;
  }

  // Single-window mode — address by beat, DISPLAYED measure, or section name.
  // Disambiguate a repeated section name (Gethsemane has TWO "Bridge"s) — the
  // resolver picks the first; tell the user how to reach the others.
  const sectionArg = argVal('--section');
  if (sectionArg !== undefined) {
    const matches = flat.sections.filter((s) => s.name.toLowerCase().includes(sectionArg.toLowerCase()));
    if (matches.length > 1) {
      console.log(`  NOTE: ${matches.length} sections match "${sectionArg}": ${matches.map((s) => `m${s.startMeasure + 1}`).join(', ')}. Using the first (m${matches[0].startMeasure + 1}); target another with --from-measure N.`);
    }
  }
  // importSongsterrDrums resolves the window AND the local tempo in force there.
  const q = importSongsterrDrums(part, {
    ...(drumMap !== undefined ? { drumMap } : {}),
    stepsPerBeat,
    ...(argVal('--from') !== undefined ? { fromBeat: Number(argVal('--from')) } : {}),
    ...(argVal('--beats') !== undefined ? { beats: Number(argVal('--beats')) } : {}),
    ...(argVal('--from-measure') !== undefined ? { fromMeasure: Number(argVal('--from-measure')) } : {}),
    ...(argVal('--to-measure') !== undefined ? { toMeasure: Number(argVal('--to-measure')) } : {}),
    ...(argVal('--section') !== undefined ? { section: argVal('--section') } : {}),
  });
  const grids = quantizedToGrids(q);

  const w = q.window;
  const where = w.section ? `section "${w.section}"` : w.fromMeasure ? `from measure ${w.fromMeasure}` : `beats ${w.fromBeat}..${w.fromBeat + w.beats}`;
  console.log(`\nwindow: ${where}  (beats ${w.fromBeat}..${(w.fromBeat + w.beats).toFixed(0)})  grid: ${q.steps} steps @ ${stepsPerBeat}/beat  tempo ${q.bpm ?? '?'} bpm\n`);
  printGrids(grids);
  if (q.warnings.length) { console.log('\nwarnings:'); for (const ww of q.warnings) console.log(`  • ${ww}`); }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({
      song: { songId: fetched.songId, revisionId: fetched.revisionId, title: fetched.title, artist: fetched.artist },
      tempo: q.bpm, signature: flat.signature, window: q.window, steps: q.steps, stepsPerBeat, grids, voices: q.voices, warnings: q.warnings,
    }, null, 2));
    console.log(`\nwrote ${jsonOut}`);
  }
  console.log('\nfeed `grids` to apply_pattern (mode: tab/ncs_upload) via the voice_map for your device.');
}

main().catch((e) => { console.error('\nERROR:', e instanceof Error ? e.message : e); process.exit(1); });
