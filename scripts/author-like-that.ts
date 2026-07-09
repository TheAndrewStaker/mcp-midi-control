/**
 * author-like-that — map Sleep Token "Like That" (Songsterr 577223, track
 * "Synth Drums", 148 bpm) into per-SECTION Circuit Tracks projects, OFFLINE,
 * ready to upload when the device is connected.
 *
 * Why per-section: the whole song is 65 two-bar windows — beyond the chain(8)
 * / scene(4-step) primitives — and the founder's live rig switches Circuit
 * PROJECTS as song parts via PC ch16 anyway (rig doc). So each section becomes
 * one project looping its own groove chain; a MIDI Commander / AM4-scene PC
 * advances the song.
 *
 * Pipeline per section (PRODUCTION code path, micro-placement included):
 *   fetchSongsterrDrums → per-2-measure-window importSongsterrDrums (the
 *   quantizer PLACES 32nds/triplets as Step.micro — B0-confirmed wire timing)
 *   → dedupe identical windows → compileToPlan (ch4 / GM+12 overrides, the
 *   SPD-SX route) → authorArrangementIntoProject (chain ≤8 / scenes ≤4 runs).
 * A section whose windows repeat (verse = 2 identical passes) is folded to one
 * pass before the capacity check. All-silent sections are skipped (this track
 * rests there; the acoustic kit carries those parts).
 *
 *   npx tsx scripts/author-like-that.ts
 *   -> samples/circuit-tracks/grooves/gm/like-that/like_that_<NN>_<section>.ncs
 *
 * Upload later: upload_project(circuit-tracks, <file>, <page-1 slot>).
 * SPD-SX: Circuit MIDI-2 ch4, pads on GM notes (kick 36 / snare 38 / hat 42 /
 * openhat 46...), hat pad POLY. Set the Circuit tempo to 148 (or clock it).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  fetchSongsterrDrums,
  importSongsterrDrums,
  quantizedToGrids,
  compileToPlan,
  type NeutralPattern,
  type Voice,
} from '@mcp-midi-control/core/protocol-generic/patterns/index.js';
import type { DeviceCapabilities, VoiceTarget, RealizePlan } from '@mcp-midi-control/core/protocol-generic/types.js';
import { authorArrangementIntoProject } from '@mcp-midi-control/circuit-tracks/descriptor/writer.js';

const SONG = '577223';
const TRACK = 'Synth';
const BPM = 148;
const GM: Readonly<Record<string, number>> = {
  kick: 36, snare: 38, hat: 42, openhat: 46, clap: 39, tom: 45, ride: 51, crash: 49, perc: 56,
  bongo: 60, conga: 63, timbale: 65, agogo: 67, cabasa: 69, maracas: 70, claves: 75, woodblock: 76, triangle: 81,
};
const OCTAVE = 12;   // Circuit MIDI-track octave-low transmit compensation
const CH_MIDI2 = 4;

const TEMPLATE = 'samples/circuit-tracks/blank_slot20.ncs';
const OUT_DIR = 'samples/circuit-tracks/grooves/gm/like-that';

const CAPS: DeviceCapabilities = {
  slot_model: 'linear', has_scenes: false, has_channels: false,
  supports_save: false, supports_lineage: false, pattern_realizers: ['ncs_upload'],
};

function setProjectName(buf: Uint8Array, name: string): void {
  const padded = name.slice(0, 16).padEnd(16, ' ');
  for (let i = 0; i < 16; i++) buf[0x10 + i] = padded.charCodeAt(i) & 0x7f;
}

/** Fold a window order that is N identical passes into one pass. */
function foldRepeats(order: number[]): number[] {
  let o = order;
  for (;;) {
    const half = o.length / 2;
    if (!Number.isInteger(half) || half === 0) return o;
    const a = o.slice(0, half).join(',');
    const b = o.slice(half).join(',');
    if (a !== b) return o;
    o = o.slice(0, half);
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`fetching Songsterr ${SONG} track "${TRACK}"…`);
  const fetched = await fetchSongsterrDrums(SONG, { trackName: TRACK });
  // This tab writes its CLAP layer on percussion number 0 (not a GM number:
  // 75 hits, always stacked with the doubled snare on backbeats, plus
  // clap-only doubles at fill turnarounds). drumMap places it as the clap
  // voice instead of it being skipped as exotic percussion.
  const DRUM_MAP = { 0: 'clap' } as const;
  console.log('  drum_map: percussion number 0 → clap (this tab\'s clap layer).');
  const flat = fetched.flat;
  const totalMeasures = flat.measures.length;
  console.log(`"${fetched.artist} — ${fetched.title}"  ${totalMeasures} measures, sections: ${flat.sections.map((s) => `${s.name}@m${s.startMeasure + 1}`).join('  ')}\n`);

  const templateBytes = readFileSync(TEMPLATE);
  const nameCount = new Map<string, number>();
  let fileIndex = 0;
  const manifest: string[] = [];

  for (let si = 0; si < flat.sections.length; si++) {
    const sec = flat.sections[si];
    const fromM = sec.startMeasure + 1;                                              // displayed, 1-based
    const toM = (flat.sections[si + 1]?.startMeasure ?? totalMeasures) as number;    // exclusive → last displayed measure of section
    const label = sec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const n = (nameCount.get(label) ?? 0) + 1;
    nameCount.set(label, n);
    const slug = n > 1 ? `${label}-${n}` : label;

    // 2-measure windows across the section (a trailing odd measure becomes a 1-measure window).
    const sigToUnique = new Map<string, number>();
    const uniques: { name: string; plan: RealizePlan; grids: Record<string, string>; placed: number }[] = [];
    const order: number[] = [];
    let onsetTotal = 0;
    for (let m = fromM; m <= toM; m += 2) {
      const imp = importSongsterrDrums(fetched.part, { fromMeasure: m, toMeasure: Math.min(m + 1, toM), stepsPerBeat: 4, drumMap: DRUM_MAP });
      const sig = JSON.stringify(imp.voices);
      let idx = sigToUnique.get(sig);
      if (idx === undefined) {
        const voices: Record<string, Voice> = {};
        const overrides: Record<string, readonly VoiceTarget[]> = {};
        for (const [voice, steps] of Object.entries(imp.voices)) {
          const gm = GM[voice];
          if (gm === undefined) throw new Error(`no GM note for voice "${voice}" (section ${sec.name})`);
          voices[voice] = { steps };
          overrides[voice] = [{ channel: CH_MIDI2, note: gm + OCTAVE }];
        }
        const pattern: NeutralPattern = { name: `${slug}-w${uniques.length}`, steps: imp.steps, voices };
        const plan = compileToPlan(pattern, CAPS, { bpm: imp.bpm ?? BPM, mode: 'ncs_upload', overrides });
        const placed = plan.events.filter((e) => e.micro !== undefined).length;
        idx = uniques.length;
        uniques.push({ name: pattern.name, plan, grids: quantizedToGrids(imp), placed });
        sigToUnique.set(sig, idx);
      }
      onsetTotal += uniques[idx].plan.events.length;
      order.push(idx);
    }

    if (onsetTotal === 0) {
      console.log(`[${sec.name} m${fromM}-${toM}] SILENT on this track — skipped (the acoustic kit carries it).`);
      manifest.push(`- ${sec.name} (m${fromM}-${toM}): silent, no project`);
      continue;
    }

    const folded = foldRepeats(order);
    // A section longer than the 8-slot chain splits into -a/-b/… projects (8
    // windows = 16 bars each) so no bars are dropped; live, they are just two
    // consecutive PC targets.
    const chunks: number[][] = [];
    for (let i = 0; i < folded.length; i += 8) chunks.push(folded.slice(i, i + 8));
    const placedTotal = uniques.reduce((a, u) => a + u.placed, 0);

    console.log(`[${sec.name} m${fromM}-${toM}] ${order.length} windows${folded.length !== order.length ? ` → ${folded.length} after fold` : ''}${chunks.length > 1 ? `, split into ${chunks.length} projects` : ''}; micro-placed onsets: ${placedTotal}`);
    for (const [ci, chunk] of chunks.entries()) {
      const part = chunks.length > 1 ? String.fromCharCode(97 + ci) : '';
      const buf = new Uint8Array(templateBytes);
      const res = authorArrangementIntoProject(buf, uniques.map((u) => ({ name: u.name, plan: u.plan })), chunk);
      fileIndex++;
      const projName = `LT ${sec.name}${part ? ` ${part.toUpperCase()}` : ''}`.slice(0, 16);
      setProjectName(buf, projName);
      const file = path.join(OUT_DIR, `like_that_${String(fileIndex).padStart(2, '0')}_${slug}${part ? `-${part}` : ''}.ncs`);
      writeFileSync(file, buf);
      console.log(`  → ${file}  (layout=${res.layout.kind}, ${chunk.length} window(s), name "${projName}")`);
      manifest.push(`- ${sec.name}${part ? ` (${part})` : ''} (m${fromM}-${toM}): ${path.basename(file)} — ${res.layout.kind}, ${chunk.length} window(s)`);
    }
    for (const [i, u] of uniques.entries()) {
      const lanes = Object.entries(u.grids).map(([v, g]) => `${v}:${g}`).join('  ');
      console.log(`    w${i}${u.placed ? ` (+${u.placed} placed)` : ''}: ${lanes || '(empty window)'}`);
    }
  }

  console.log(`\nMANIFEST (${fileIndex} project file(s), upload in PC-order when the Circuit is connected):`);
  for (const line of manifest) console.log(`  ${line}`);
  console.log(`\n  148 bpm — set the Circuit tempo (or clock it from the RC-505).`);
  console.log('  SPD-SX: Circuit MIDI-2 ch4, pads on GM 36/38/42(/46), hat pad POLY.');
}

main().catch((e) => { console.error(e); process.exit(1); });
