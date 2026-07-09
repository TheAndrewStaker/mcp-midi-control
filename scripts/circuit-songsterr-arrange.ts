/**
 * circuit-songsterr-arrange — fetch a Songsterr drum track, decompose it into a
 * small groove bank, and author a MULTI-SCENE Circuit Tracks project that
 * auto-advances through the song's sections.
 *
 * This is the first end-to-end exercise of the Circuit's TWO advancement axes at
 * once (docs/design/songsterr-drum-import.md, circuit-ncs-format-decode.md):
 *
 *   • PATTERN advance (chain) — within a scene, a 2-pattern chain auto-steps
 *     groove→fill→loop (the "2 auto-advancing patterns where necessary").
 *   • SCENE advance (scene-chain) — the scene-chain sequences whole sections
 *     Verse→Chorus→Verse and loops (the "progress between scenes").
 *
 * SAFEST-EVIDENCE design: rather than AUTHOR scene bytes from the field decode
 * (the decode doc's standing guidance is "replicate the captured scene bytes
 * verbatim, do not over-derive"), we TEMPLATE off a project that already carries
 * the device-captured 4-scene block (the_summoning, slot 42, hardware-confirmed).
 * Its scenes select pattern-pairs (0,1)/(2,3)/(4,5)/(6,7). We overwrite ONLY the
 * drum step data of slots 0-5 with the song's grooves, set every pattern's length
 * to 32, then add the scene-chain (Scene 1→3 auto-advance) on top. No scene byte
 * is authored — the scenes are inherited byte-exact from the reference.
 *
 *   3-scene arrangement (Verse / Chorus / Verse reprise), bank = 3 grooves:
 *     Scene 1 "Verse"   → slots 0,1 = A (verse groove) + B (fill)   [2 patterns]
 *     Scene 2 "Chorus"  → slots 2,3 = C (chorus/solo groove) ×2
 *     Scene 3 "Verse'"  → slots 4,5 = A + B                          [2 patterns]
 *
 * EVIDENCE: patterns + length = hardware-confirmed; per-scene pattern-pair select
 * = inherited from a device capture; scene-chain auto-advance = decoded-beta
 * (sceneChain.ts, 1→4 confirmed; 1→3 interpolates). Tempo is NOT in the decoded
 * .ncs surface, so the project inherits the template's tempo — set it on the
 * device (Tempo button) to the song's BPM. Confirm the result by ear.
 *
 *   npx tsx scripts/circuit-songsterr-arrange.ts <songId|url> <out.ncs> [template.ncs]
 */
import { readFileSync, writeFileSync } from 'node:fs';

import {
  fetchSongsterrDrums,
  decomposeToPatterns,
  coalescePatterns,
  arrangementSummary,
  patternLabel,
  type Step,
  type QuantizedDrums,
} from '@mcp-midi-control/core/protocol-generic/patterns/index.js';

import { setDrumPattern, decodeDrumPattern, drumPatternToString } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';
import { setAllDrumLengths } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { setSceneChain, getSceneChainEnd } from '@mcp-midi-control/circuit-tracks/ncs/sceneChain.js';
import { NCS_FILE_SIZE, META_OFFSETS, drumBlockIndex } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

const DEFAULT_TEMPLATE = 'samples/circuit-tracks/grooves/packed/scened/the_summoning__full4bar__scenes.ncs';

// Merge the decomposition's up-to-9 neutral voices onto the Circuit's 4 drum
// pads. Covers every voice gmDrumToVoice emits (kick/snare/hat/openhat/crash/
// ride/tom/perc/clap) so nothing is silently dropped.
const TRACK_VOICES: readonly string[][] = [
  ['kick'],                  // Drum 1
  ['snare', 'clap', 'perc'], // Drum 2
  ['hat', 'openhat'],        // Drum 3
  ['crash', 'ride', 'tom'],  // Drum 4
];

/** One scene: a name + the two pattern-slots its inherited scene-pair selects,
 *  each filled from a bank groove index. */
interface SceneSpec { name: string; slots: [number, number]; grooves: [number, number]; }

type Cell = { active: boolean; velocity: number; microHits?: number };

/** OR-merge a groove's assigned voices into a 32-step drum-track grid. */
function trackGrid(pattern: QuantizedDrums, voices: readonly string[]): Cell[] {
  const out: Cell[] = Array.from({ length: 32 }, () => ({ active: false, velocity: 0 }));
  for (const v of voices) {
    const row = pattern.voices[v] as Step[] | undefined;
    if (!row) continue;
    for (let i = 0; i < Math.min(32, row.length); i++) {
      const s = row[i];
      if (s?.on && !out[i].active) {
        out[i] = { active: true, velocity: s.accent ? 120 : (s.velocity ?? 95), ...(s.roll === 6 ? { microHits: 6 } : {}) };
      }
    }
  }
  return out;
}

function setProjectName(buf: Uint8Array, name: string): void {
  const padded = name.slice(0, 16).padEnd(16, ' ');
  for (let i = 0; i < 16; i++) buf[0x10 + i] = padded.charCodeAt(i) & 0x7f;
}

function decodeProjectName(buf: Uint8Array): string {
  let s = '';
  for (let i = 0x10; i < 0x20; i++) s += String.fromCharCode(buf[i] & 0x7f);
  return s.replace(/[^\x20-\x7e]/g, '').trimEnd();
}

async function main(): Promise<void> {
  const songRef = process.argv[2];
  const outPath = process.argv[3];
  const templatePath = process.argv[4] ?? DEFAULT_TEMPLATE;
  if (!songRef || !outPath) {
    console.error('usage: tsx scripts/circuit-songsterr-arrange.ts <songId|url> <out.ncs> [template.ncs]');
    process.exit(1);
  }

  console.log(`fetching ${songRef}…`);
  const fetched = await fetchSongsterrDrums(songRef);
  const { flat } = fetched;
  console.log(`"${fetched.artist} — ${fetched.title}"  ${flat.bpm ?? '?'} bpm  ${flat.signature[0]}/${flat.signature[1]}  ${flat.measures.length} measures`);

  // Decompose → fuzzy-coalesce to a small bank (the verse/fill/chorus grooves).
  const stepsPerBar = Math.round((flat.signature[0] * 4 / flat.signature[1]) * 4); // 16th grid
  const windowSteps = stepsPerBar * 2; // 2 bars = 32 steps
  const exact = decomposeToPatterns(flat.events, { stepsPerPattern: windowSteps, stepsPerBeat: 4, totalBeats: flat.totalBeats });
  const coalesced = coalescePatterns(exact, { maxDistance: 0.10 });
  const bank = coalesced.patterns;
  console.log(`decompose: ${exact.windowCount} windows → ${exact.uniquePatternCount} exact → ${bank.length} grooves (fuzzy)`);
  console.log(`arrangement: ${arrangementSummary(coalesced)}`);
  if (bank.length < 3) {
    console.warn(`WARNING: only ${bank.length} groove(s) after coalesce; scenes will reuse them.`);
  }
  const g = (i: number): number => Math.min(i, bank.length - 1); // clamp to available grooves

  // 3-scene Verse / Chorus / Verse' plan over the template's inherited scene-pairs.
  const scenes: SceneSpec[] = [
    { name: 'Verse',   slots: [0, 1], grooves: [g(0), g(1)] }, // A verse + B fill
    { name: 'Chorus',  slots: [2, 3], grooves: [g(2), g(2)] }, // C chorus/solo ×2
    { name: "Verse'",  slots: [4, 5], grooves: [g(0), g(1)] }, // A + B (reprise/outro)
  ];

  const buf = new Uint8Array(readFileSync(templatePath));
  if (buf.length !== NCS_FILE_SIZE) throw new Error(`template ${templatePath} is ${buf.length} bytes, expected ${NCS_FILE_SIZE}`);
  console.log(`template: ${templatePath} (was "${decodeProjectName(buf)}")`);

  // Author each scene's two pattern slots across all 4 drum tracks.
  for (const sc of scenes) {
    sc.slots.forEach((slot, k) => {
      const pat = bank[sc.grooves[k]];
      for (let t = 0; t < 4; t++) setDrumPattern(buf, t, slot, trackGrid(pat, TRACK_VOICES[t]));
    });
  }
  // Clear the template's leftover grooves in slots 6,7 (Scene 4, past the chain).
  for (const slot of [6, 7]) for (let t = 0; t < 4; t++) setDrumPattern(buf, t, slot, []);

  // Length 32 on every drum pattern (else a 32-step pattern plays only its first bar).
  setAllDrumLengths(buf, 32);
  // Scene-chain: auto-advance Scene 1 → 3 and loop (the song axis).
  setSceneChain(buf, scenes.length);
  setProjectName(buf, fetched.title);

  writeFileSync(outPath, buf);

  // ── Verify what landed (decode back from the buffer) ──────────────────
  console.log(`\nwrote ${outPath} ("${decodeProjectName(buf)}")`);
  const lenOk = scenes.flatMap((s) => s.slots).every((slot) =>
    [0, 1, 2, 3].every((t) => buf[META_OFFSETS[drumBlockIndex(t, slot)]] === 0x1f));
  console.log(`  lengths: all authored drum patterns = 32 steps → ${lenOk ? 'OK' : 'MISMATCH'}`);
  console.log(`  scene-chain end (read-back): Scene 1 → ${getSceneChainEnd(buf)} (auto-advance + loop)`);
  console.log('\n  pattern bank authored into slots:');
  for (const sc of scenes) {
    console.log(`  Scene "${sc.name}" → patterns ${sc.slots.map((s) => s + 1).join('+')} (groove ${sc.grooves.map(patternLabel).join(',')})`);
    for (let t = 0; t < 4; t++) {
      const rows = sc.slots.map((slot) => drumPatternToString(decodeDrumPattern(buf, t, slot))).join(' | ');
      console.log(`     D${t + 1} [${TRACK_VOICES[t].join('/').padEnd(16)}] ${rows}`);
    }
  }
  console.log('\nNext: upload with upload_project to the target slot, then on the device:');
  console.log('  • set Tempo to the song BPM (tempo is not stored in the .ncs)');
  console.log('  • assign the drum-pad samples (Drum > Sample) for the loaded Pack');
  console.log('  • press Play — the scene-chain auto-advances Verse → Chorus → Verse and loops');
}

main().catch((e) => { console.error('\nERROR:', e instanceof Error ? e.message : e); process.exit(1); });
