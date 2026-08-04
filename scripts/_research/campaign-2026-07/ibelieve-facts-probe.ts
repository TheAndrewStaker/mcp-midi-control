/**
 * I BELIEVE IN A THING CALLED LOVE — FACTS PROBE. OFFLINE, READ-ONLY.
 *
 * Decodes Pack 5 Projects 19-25 from their newest canonical export and reports
 * everything the populate needs to know BEFORE anything is staged:
 *
 *   - name / colour / tempo / binding / all six stored levels
 *   - midi2 plain chain (how many pattern slots the project actually plays)
 *   - per-pattern note census on EVERY note track (so a melodic leg that must be
 *     preserved is named, not assumed)
 *   - the midi2 drum content recovered by inverting the SPD-SX voice map (+12),
 *     with EVERY stored note accounted for as a mapped voice or an unclassified
 *     residue that is REPORTED rather than dropped
 *   - existing internal drum content (this must be zero: it is a populate)
 *   - scene-chain state
 *
 * Run: npx tsx scripts/_research/campaign-2026-07/ibelieve-facts-probe.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  NCS_FILE_SIZE, META_OFFSETS, PATTERNS_PER_TRACK, STEPS_PER_PATTERN,
  noteBlockIndex, getProjectName, getProjectColour, projectColourName, getProjectTempo,
  checkNcsStructure, MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, DRUM_LEVEL_BASE, DRUM_LEVEL_STRIDE,
} from '@mcp-midi-control/circuit-tracks/ncs/format.js';
import { getNoteChain } from '@mcp-midi-control/circuit-tracks/ncs/chain.js';
import { getSceneChainEnd } from '@mcp-midi-control/circuit-tracks/ncs/sceneChain.js';
import { getDrumSampleBinding } from '@mcp-midi-control/circuit-tracks/ncs/drumBinding.js';
import { decodeNotePattern } from '@mcp-midi-control/circuit-tracks/ncs/notePattern.js';
import { decodeDrumPattern } from '@mcp-midi-control/circuit-tracks/ncs/drumPattern.js';

const ROOT = 'C:/dev/mcp-midi-tools';
/**
 * The whole capture tree, walked recursively. "Newest canonical" is defined by
 * the DEVICE-READ filename stamp, not by a hand-maintained directory list — a
 * missed directory is how a stale oracle gets used. Staged/offline files carry
 * no timestamp (`pack5-project19.ncs`) so the strict pattern excludes them.
 */
const CAPTURE_ROOT = `${ROOT}/samples/circuit-ncs`;
const SLOTS = [19, 20, 21, 22, 23, 24, 25];

/** SPD-SX voice_map (GM) + the Circuit's midi2 note_offset. */
const SPDSX_GM: Record<string, number> = {
  kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56,
};
const NOTE_OFFSET = 12;
const STORED_TO_VOICE = new Map<number, string>(Object.entries(SPDSX_GM).map(([v, n]) => [n + NOTE_OFFSET, v]));

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) yield* walk(full);
    else if (e.endsWith('.ncs')) yield full;
  }
}

/** Newest DEVICE-READ capture for a pack-5 slot, across the whole capture tree. */
export function newestCanonical(slot: number, pack = 5): { file: string; when: string } {
  const re = new RegExp(`pack${pack}-project0*${slot}-.*?-(\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2})\\.ncs$`);
  let best: { file: string; when: string } | undefined;
  for (const f of walk(CAPTURE_ROOT)) {
    const m = re.exec(path.basename(f));
    if (!m) continue;
    if (best === undefined || m[1] > best.when) best = { file: f, when: m[1] };
  }
  if (best === undefined) throw new Error(`no canonical capture for pack ${pack} slot ${slot}`);
  return best;
}

if (process.argv[1] !== undefined && process.argv[1].includes('ibelieve-facts-probe')) {
  for (const slot of SLOTS) {
    const { file, when } = newestCanonical(slot);
    const buf = new Uint8Array(readFileSync(file));
    console.log(`\n===== Project ${slot} =====`);
    console.log(`  canonical: ${path.basename(file)} (${when})`);
    if (buf.length !== NCS_FILE_SIZE) { console.log(`  !! ${buf.length} bytes`); continue; }
    const st = checkNcsStructure(buf);
    console.log(`  structure: ${st.ok ? 'ok' : `FAULTS ${st.faults.join('; ')}`}`);
    console.log(`  name "${getProjectName(buf)}" colour ${projectColourName(getProjectColour(buf))} tempo ${getProjectTempo(buf)}`);
    console.log(`  binding [${getDrumSampleBinding(buf).join(',')}]`);
    const levels = [buf[MIXER_SYNTH1_LEVEL], buf[MIXER_SYNTH2_LEVEL], ...[0, 1, 2, 3].map((n) => buf[DRUM_LEVEL_BASE + n * DRUM_LEVEL_STRIDE])];
    console.log(`  levels s1/s2/d1-4 = [${levels.join(',')}]`);
    console.log(`  scene chain: ${getSceneChainEnd(buf) ?? 'absent (plain chain)'}`);

    for (const track of ['synth1', 'synth2', 'midi1', 'midi2'] as const) {
      const chain = getNoteChain(buf, track);
      let notes = 0;
      const perPattern: number[] = [];
      for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
        let n = 0;
        for (const s of decodeNotePattern(buf, track, p)) n += s.notes.length;
        perPattern.push(n); notes += n;
      }
      console.log(`  ${track}: chain ${chain ? `[${chain.start},${chain.end}]` : 'none'} notes ${notes} per-pattern [${perPattern.join(',')}]`);
    }

    let drumHits = 0;
    for (let t = 0; t < 4; t++) for (let p = 0; p < PATTERNS_PER_TRACK; p++) drumHits += decodeDrumPattern(buf, t, p).filter((c) => c.active).length;
    console.log(`  EXISTING internal drum hits: ${drumHits}`);

    // midi2 drum recovery
    const chain = getNoteChain(buf, 'midi2');
    if (chain === undefined) { console.log('  midi2 has NO chain — nothing to fold'); continue; }
    const byVoice = new Map<string, number>();
    const unmapped = new Map<number, number>();
    let delays = 0;
    for (let p = 0; p <= chain.end; p++) {
      const steps = decodeNotePattern(buf, 'midi2', p);
      const len = buf[META_OFFSETS[noteBlockIndex('midi2', p)]] + 1;
      let pn = 0;
      for (let s = 0; s < STEPS_PER_PATTERN; s++) {
        for (const n of steps[s].notes) {
          pn++;
          if (n.delay !== 0) delays++;
          const v = STORED_TO_VOICE.get(n.note);
          if (v === undefined) { unmapped.set(n.note, (unmapped.get(n.note) ?? 0) + 1); continue; }
          byVoice.set(v, (byVoice.get(v) ?? 0) + 1);
        }
      }
      console.log(`    p${p + 1}: len ${len} steps, ${pn} midi2 note(s)`);
    }
    console.log(`  FOLD: ${[...byVoice].map(([v, n]) => `${v}=${n}`).join(' ')} | unmapped: ${unmapped.size === 0 ? 'none' : [...unmapped].map(([n, c]) => `note ${n} x${c}`).join(', ')} | micro-delays: ${delays}`);
  }
}
