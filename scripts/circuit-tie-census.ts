/**
 * circuit-tie-census.ts — count RAW tie-forward flags in a Circuit `.ncs`.
 *
 * WHY A RAW SCAN. `decodeNotePattern` now splits gate-lane bit 7 off into a
 * separate `tie` field, so a decoded `gate` NEVER shows the flag. Any audit that
 * asks "are the hand-set ties still there?" must read the RAW byte at
 * `noteStepBase + step*28 + 4 + slot*4 + 1` and test bit 7 itself. This script
 * does exactly that and nothing else.
 *
 * It is READ-ONLY. It never opens a write path, never uploads, and never
 * touches a byte. Use it as the independent before/after oracle around any
 * patch that claims "gate is untouched by construction" — a claim that has to
 * be measured, not asserted.
 *
 * Usage:
 *   npx tsx scripts/circuit-tie-census.ts --files samples/circuit-ncs/pack5/proj38.ncs ...
 *   npx tsx scripts/circuit-tie-census.ts --dir  samples/circuit-ncs/pack5 --slots 35-39
 *   npx tsx scripts/circuit-tie-census.ts --device --slots 35-39 [--pack 5]
 *
 * `--slots` / `--pack` are 1-BASED device numbering, as the front panel shows.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  NOTE_STEP_BYTES, NOTE_SLOTS_PER_STEP, STEPS_PER_PATTERN, PATTERNS_PER_TRACK,
  noteStepBase, NOTE_TRACKS, type NoteTrack,
} from '../packages/circuit-tracks/src/ncs/format.js';

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};

const TIE_BIT = 0x80;

export interface TieHit {
  track: NoteTrack;
  pattern: number;   // 0-based
  step: number;      // 0-based
  slot: number;      // 0-based
  raw: number;       // the raw gate-lane byte
}

/** Every raw gate-lane byte with bit 7 set, across all four note tracks. */
export function tieCensus(b: Uint8Array): TieHit[] {
  const hits: TieHit[] = [];
  for (const track of NOTE_TRACKS) {
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) {
      const base = noteStepBase(track, p);
      for (let s = 0; s < STEPS_PER_PATTERN; s++) {
        const stepBase = base + s * NOTE_STEP_BYTES;
        const mask = b[stepBase];
        for (let n = 0; n < NOTE_SLOTS_PER_STEP; n++) {
          if (!((mask >> n) & 1)) continue;          // muted slot: not a live tie
          const raw = b[stepBase + 4 + n * 4 + 1];   // gate lane
          if ((raw & TIE_BIT) !== 0) hits.push({ track, pattern: p, step: s, slot: n, raw });
        }
      }
    }
  }
  return hits;
}

const nameOf = (b: Uint8Array): string =>
  Array.from(b.slice(0x10, 0x30)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trim();

function parseSlots(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map((x) => Number(x.trim()));
    for (let i = a; i <= (b ?? a); i++) out.push(i);
  }
  return [...new Set(out)].sort((x, y) => x - y);
}

function report(label: string, b: Uint8Array): void {
  const hits = tieCensus(b);
  console.log(`  ${label.padEnd(28)} "${nameOf(b)}"  ${hits.length} tie flag(s)`);
  const byPlace = new Map<string, TieHit[]>();
  for (const h of hits) {
    const k = `${h.track} p${h.pattern + 1} s${h.step}`;
    byPlace.set(k, [...(byPlace.get(k) ?? []), h]);
  }
  for (const [k, hs] of byPlace) {
    console.log(`        ${k.padEnd(22)} x${hs.length} slot(s), raw ${[...new Set(hs.map((h) => h.raw))].join('/')}`);
  }
}

/** True when this file was run as the CLI, false when imported for `tieCensus`. */
const RUN_AS_CLI = (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('/circuit-tie-census.ts');

if (RUN_AS_CLI) {
  const files = argv.includes('--files') ? argv.slice(argv.indexOf('--files') + 1).filter((a) => !a.startsWith('--')) : [];
  const dir = flag('--dir');
  const slotSpec = flag('--slots');
  const devicePack = Number(flag('--pack') ?? '5');

  if (files.length > 0) {
    for (const f of files) report(f.split(/[\\/]/).pop() ?? f, readFileSync(f));
  } else if (dir !== undefined) {
    for (const slot of parseSlots(slotSpec ?? '1-64')) {
      const f = join(dir, `proj${String(slot).padStart(2, '0')}.ncs`);
      if (!existsSync(f)) continue;
      report(`project ${slot}`, readFileSync(f));
    }
  } else if (argv.includes('--device')) {
    // Imported lazily so the file modes above need no MIDI port at all.
    const { connect } = await import('../packages/core/src/midi/transport.js');
    const { endMidiScript, reconnectMidi } = await import('./_lib/midi-lifecycle.js');
    const { downloadProject } = await import('../packages/circuit-tracks/src/ncs/uploadProject.js');
    const CONNECT = { needles: ['circuit'], notFoundLeadIn: 'Circuit Tracks not found.' };
    let conn = connect(CONNECT);
    // Releases the old handle before reopening; a bare reassignment leaked a
    // loop-pinning input handle per reconnect.
    const reconnect = (): ReturnType<typeof connect> => { conn = reconnectMidi(conn, CONNECT); return conn; };
    for (const slot of parseSlots(slotSpec ?? '1')) {
      const r = await downloadProject(conn, slot - 1, { pack: devicePack - 1, reconnect });
      if (!r.ok || !r.crcOk || r.bytes === undefined) {
        console.log(`  project ${slot}  READ FAILED (ok=${r.ok} crcOk=${r.crcOk}) ${r.error ?? ''}`);
        continue;
      }
      report(`project ${slot}`, r.bytes);
    }
    // An open input port pins the event loop, so the census would otherwise
    // print its last line and hang holding the device.
    endMidiScript();
  } else {
    console.log('give --files <f...> | --dir <d> [--slots a-b] | --device --slots a-b');
  }
}
