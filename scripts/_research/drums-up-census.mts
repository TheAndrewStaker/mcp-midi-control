/**
 * drums-up-census.mts — READ-ONLY, OFFLINE. Facts the drums-up rebuild depends on, per Pack 1-2
 * project: every stored midi2 note against the SPD-SX voice map (+12), micro-delays and
 * probabilities in use, and whether the internal drum STRUCTURE (chain, scene selections, pattern
 * lengths) already mirrors midi2's. Any "no" here is a project the rebuild cannot treat generically.
 *
 * Usage: npx tsx scripts/_research/drums-up-census.mts <backupRoot>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectName, META_OFFSETS, noteBlockIndex, drumBlockIndex } from '../../packages/circuit-tracks/src/ncs/format.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { getSceneNoteChain, getSceneDrumChain, getSceneChainEnd } from '../../packages/circuit-tracks/src/ncs/sceneChain.js';

const root = process.argv[2];
const SPDSX_GM: Record<string, number> = { kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56 };
const STORED_TO_VOICE = new Map<number, string>(Object.entries(SPDSX_GM).map(([v, n]) => [n + 12, v]));

const unmappedBySong = new Map<string, Map<number, number>>();
for (const pack of [1, 2]) {
  for (const file of readdirSync(join(root, `pack${pack}`)).filter((f) => f.endsWith('.ncs')).sort()) {
    const slot = Number(/project(\d+)-/.exec(file)![1]);
    const buf = new Uint8Array(readFileSync(join(root, `pack${pack}`, file)));
    const name = getProjectName(buf);
    const song = name.replace(/\s*\d.*$/, '').replace(/\s+(Intro|Verse|PreCh|Chorus|Bridge).*$/, '');
    const notes: string[] = [];
    // structure
    const mChain = [buf[0x2d0], buf[0x2d1]];
    const dChains = [0, 1, 2, 3].map((t) => [buf[0x2d4 + 4 * t], buf[0x2d4 + 4 * t + 1]]);
    const chainMirror = dChains.every((c) => c[0] === mChain[0] && c[1] === mChain[1]);
    const sceneEnd = getSceneChainEnd(buf);
    let sceneMirror = true; let scenesDefined = 0;
    for (let s = 0; s < 16; s++) {
      const m = getSceneNoteChain(buf, s, 'midi2');
      if (!m) continue;
      scenesDefined++;
      for (let t = 0; t < 4; t++) {
        const d = getSceneDrumChain(buf, s, t)!;
        if (d.start !== m.start || d.end !== m.end) sceneMirror = false;
      }
    }
    const played = new Set<number>();
    for (let p = mChain[0]; p <= Math.min(mChain[1], 7); p++) played.add(p);
    for (let s = 0; s < 16; s++) { const r = getSceneNoteChain(buf, s, 'midi2'); if (r) for (let p = r.start; p <= r.end; p++) played.add(p); }
    let lenMirror = true; const delays = new Map<number, number>(); const probs = new Map<number, number>();
    let midiNotes = 0; let internal = 0; let internalOutside = 0;
    for (let p = 0; p < 8; p++) {
      const mLen = buf[META_OFFSETS[noteBlockIndex('midi2', p)]] + 1;
      const steps = decodeNotePattern(buf, 'midi2', p);
      const hasMidi = steps.some((s) => s.active && s.notes.length > 0);
      const dHits = [0, 1, 2, 3].reduce((a, t) => a + decodeDrumPattern(buf, t, p).filter((c) => c.active).length, 0);
      if (played.has(p)) {
        internal += dHits;
        for (let t = 0; t < 4; t++) if (buf[META_OFFSETS[drumBlockIndex(t, p)]] + 1 !== mLen && (hasMidi || dHits)) lenMirror = false;
        steps.forEach((st, i) => {
          if (!st.active || i >= mLen) return;
          for (const n of st.notes) {
            midiNotes++;
            if (n.delay) delays.set(n.delay, (delays.get(n.delay) ?? 0) + 1);
            if (st.probability !== undefined && st.probability !== 7) probs.set(st.probability, (probs.get(st.probability) ?? 0) + 1);
            if (!STORED_TO_VOICE.has(n.note)) {
              const m = unmappedBySong.get(song) ?? new Map<number, number>();
              m.set(n.note, (m.get(n.note) ?? 0) + 1); unmappedBySong.set(song, m);
              notes.push(String(n.note));
            }
          }
        });
      } else {
        internalOutside += dHits;
      }
    }
    const flags = [
      !chainMirror && `drumChain=${JSON.stringify(dChains[0])} midi2Chain=${JSON.stringify(mChain)}${dChains.some((c) => c[0] !== dChains[0][0] || c[1] !== dChains[0][1]) ? ' (drum chains differ per track)' : ''}`,
      !sceneMirror && `scene drum≠midi2 (${scenesDefined} scenes, chainEnd ${sceneEnd ?? '-'})`,
      scenesDefined > 0 && sceneMirror && `scenes mirrored (${scenesDefined}, chainEnd ${sceneEnd ?? '-'})`,
      !lenMirror && 'drum lengths ≠ midi2',
      delays.size > 0 && `micro-delays ${JSON.stringify([...delays])}`,
      probs.size > 0 && `probabilities ${JSON.stringify([...probs])}`,
      internalOutside > 0 && `${internalOutside} internal hits outside played patterns`,
      notes.length > 0 && `unmapped notes x${notes.length}`,
    ].filter(Boolean);
    console.log(`${pack}:${String(slot).padEnd(3)} ${name.padEnd(22)} midi2=${String(midiNotes).padStart(4)} int=${String(internal).padStart(4)} played=[${[...played]}] ${flags.join(' | ')}`);
  }
}
console.log('\nUNMAPPED stored midi2 notes (not in SPD-SX voice_map+12), per song:');
for (const [song, m] of unmappedBySong) console.log(`  ${song}: ${[...m.entries()].sort((a, b) => a[0] - b[0]).map(([n, c]) => `${n}(GM ${n - 12})x${c}`).join(' ')}`);
