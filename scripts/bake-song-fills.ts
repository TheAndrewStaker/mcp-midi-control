/**
 * Fill worklist → `bouncer phrase` bridge (Item C of BK-SONG-PROJECTS-PLANNER).
 *
 * The planner (`songPlanner.ts`) emits a `fill_worklist`: per detected fill bar,
 * the drum hits (GM number + beat + velocity) that need rendering to a one-shot
 * WAV so the author can place a baked fill instead of a live loop. Baking is
 * `bouncer`, which is GPL and a SEPARATE process, so it is NEVER imported into the
 * Apache server. This script does the Apache-side half:
 *
 *   1. writes each fill to a `.mid` phrase, using the MINIMAL Standard-MIDI-File
 *      encoder below (the repo's `midiFile.ts` is parse-only — there is no writer),
 *   2. prints the exact `bouncer phrase … --state <state>` commands to run, and
 *   3. prints an `upload_sample` slot map (which baked WAV → which pool slot).
 *
 * It does NOT invoke bouncer. It prepares + prints; the maintainer (or a separate
 * `bounce_*.py`) runs the GPL renderer.
 *
 * Run:
 *   npx tsx scripts/plan-song-projects.ts 30509 --live 0,1 --json > plan.json
 *   npx tsx scripts/bake-song-fills.ts --json plan.json [--out samples/fills]
 *                                       [--state states/sleep-token-ii.bin]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { FillEvent, FillWorkItem, SongProjectPlan } from '../packages/core/src/protocol-generic/patterns/songPlanner.js';

// ── minimal SMF (Standard MIDI File) ENCODER — new code (midiFile.ts is parse-only) ──

/** Variable-length quantity (big-endian, 7 bits/byte, high bit = continue). */
function vlq(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const out = [v & 0x7f];
  v >>= 7;
  while (v > 0) { out.unshift((v & 0x7f) | 0x80); v >>= 7; }
  return out;
}

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

export interface EncodeMidiOptions {
  /** Ticks per quarter-note (division). Default 480. */
  ticksPerBeat?: number;
  /** 0-based MIDI channel (9 = channel 10, the GM drum channel). Default 9. */
  channel?: number;
  /** Gate length of each hit, in ticks. Drums are one-shots, so short. Default 60. */
  noteLenTicks?: number;
}

/**
 * Encode a fill's drum events to a Type-0 Standard MIDI File.
 *
 * Each event becomes a note-on (0x90) at `round(beat × ticksPerBeat)` and a
 * matching note-off (0x80) `noteLenTicks` later, on the drum channel. Round-trips
 * through this repo's own `parseMidiFile`.
 */
export function encodeFillMidi(events: readonly FillEvent[], opts: EncodeMidiOptions = {}): Uint8Array {
  const tpb = opts.ticksPerBeat ?? 480;
  const ch = (opts.channel ?? 9) & 0x0f;
  const gate = opts.noteLenTicks ?? 60;

  interface Ev { tick: number; off: boolean; note: number; vel: number }
  const evs: Ev[] = [];
  for (const e of events) {
    const on = Math.max(0, Math.round(e.beat * tpb));
    const vel = Math.min(127, Math.max(1, Math.round(e.vel)));
    evs.push({ tick: on, off: false, note: e.gm & 0x7f, vel });
    evs.push({ tick: on + gate, off: true, note: e.gm & 0x7f, vel: 0 });
  }
  // Sort by tick; at equal ticks a note-off precedes a note-on so a re-struck
  // pitch is released before it is hit again.
  evs.sort((a, b) => a.tick - b.tick || (a.off === b.off ? 0 : a.off ? -1 : 1) || a.note - b.note);

  const track: number[] = [];
  let last = 0;
  for (const e of evs) {
    track.push(...vlq(e.tick - last));
    last = e.tick;
    track.push((e.off ? 0x80 : 0x90) | ch, e.note, e.vel);
  }
  track.push(...vlq(0), 0xff, 0x2f, 0x00); // End of Track

  const header = [...ascii('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(tpb)];
  const chunk = [...ascii('MTrk'), ...u32(track.length), ...track];
  return new Uint8Array([...header, ...chunk]);
}

// ── worklist → commands + slot map (pure, testable) ──────────────────

export interface BakePlanEntry {
  /** The fill this renders. */
  fill: FillWorkItem;
  /** Basename (no dir) of the `.mid` phrase. */
  midi_file: string;
  /** Basename of the WAV `bouncer` will produce. */
  wav_file: string;
  /** The exact command to run (bouncer is external; this is not executed here). */
  bouncer_command: string;
  /** The Circuit sample-pool slot this WAV should upload to. */
  pool_slot: number;
}

export interface BakePlan {
  out_dir: string;
  state: string;
  entries: BakePlanEntry[];
  /** `upload_sample` slot map: pool slot → wav basename. */
  slot_map: { slot: number; wav: string; fill: string }[];
}

/** A filesystem-safe token from a section name ("Chorus I" → "chorus_i"). */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'fill';
}

/**
 * Build the bake plan from a planner result: one `.mid` + `bouncer` command +
 * pool slot per fill worklist entry. Pure; writing + printing is the CLI's job.
 * `firstSlot` is where the baked WAVs start in the Circuit sample pool.
 */
export function buildBakePlan(
  plan: SongProjectPlan,
  opts: { outDir: string; state: string; firstSlot?: number } = { outDir: 'samples/fills', state: 'states/sleep-token-ii.bin' },
): BakePlan {
  const outDir = opts.outDir;
  const state = opts.state;
  let slot = opts.firstSlot ?? 1;
  const entries: BakePlanEntry[] = [];
  const slotMap: BakePlan['slot_map'] = [];
  const seen = new Map<string, number>();
  for (const fill of plan.fill_worklist) {
    const base = `${slug(fill.section)}_m${fill.from_measure}${fill.to_measure !== fill.from_measure ? `-${fill.to_measure}` : ''}`;
    const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
    const stem = n > 1 ? `${base}_${n}` : base;
    const midi = `${stem}.mid`;
    const wav = `${stem}.wav`;
    const poolSlot = slot++;
    entries.push({
      fill,
      midi_file: midi,
      wav_file: wav,
      bouncer_command: `bouncer phrase --midi ${outDir}/${midi} --state ${state} --out ${outDir}/${wav}`,
      pool_slot: poolSlot,
    });
    slotMap.push({ slot: poolSlot, wav, fill: `${fill.section} m${fill.from_measure}` });
  }
  return { out_dir: outDir, state, entries, slot_map: slotMap };
}

// ── CLI ──────────────────────────────────────────────────────────────

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const jsonPath = argVal('--json');
  if (jsonPath === undefined) {
    console.error('usage: npx tsx scripts/bake-song-fills.ts --json <plan.json> [--out DIR] [--state FILE] [--first-slot N]');
    process.exit(1);
  }
  const plan = JSON.parse(readFileSync(jsonPath, 'utf8')) as SongProjectPlan;
  const outDir = argVal('--out') ?? 'samples/fills';
  const state = argVal('--state') ?? 'states/sleep-token-ii.bin';
  const firstSlot = Number(argVal('--first-slot') ?? 1);

  if (!Array.isArray(plan.fill_worklist) || plan.fill_worklist.length === 0) {
    console.log('No fills in the worklist — nothing to bake.');
    return;
  }

  const bake = buildBakePlan(plan, { outDir, state, firstSlot });
  mkdirSync(outDir, { recursive: true });
  for (const e of bake.entries) {
    const bytes = encodeFillMidi(e.fill.events);
    writeFileSync(`${outDir}/${e.midi_file}`, bytes);
  }

  console.log(`\nWrote ${bake.entries.length} fill phrase(s) to ${outDir}/`);
  console.log('\n# 1) RENDER each phrase to a one-shot WAV (bouncer is GPL / external — run these yourself):');
  for (const e of bake.entries) console.log(`  ${e.bouncer_command}`);
  console.log('\n# 2) UPLOAD each WAV to its Circuit sample-pool slot:');
  for (const s of bake.slot_map) console.log(`  upload_sample  slot ${String(s.slot).padStart(2)}  <- ${outDir}/${s.wav}   (${s.fill})`);
  console.log('\n# 3) In the authored projects, point the fill bar\'s pad at the matching pool slot.');
}

// Run only as a CLI, not when imported by the verifier.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bake-song-fills.ts')) {
  main();
}
