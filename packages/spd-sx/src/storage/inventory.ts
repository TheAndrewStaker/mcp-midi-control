/**
 * SPD-SX device state reader — list the kits and the wave pool from a mounted
 * `Roland/SPD-SX` tree. Read-only; the safe inspection surface.
 *
 * Kits are read from KIT/kitNNN.spd (name + per-pad wave refs). Waves are read
 * from WAVE/PRM/<bucket>/<slot>.spd (index = bucket*100 + slot, name, path).
 * Wave names on each kit pad are resolved against the pool so a kit reads as
 * "pad 1 -> 461 'kick'" rather than a bare index.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseMinimalKit, parseFullKit, isMinimalKit } from '../codec/kitXml.js';
import { parseWavePrm, NM_LEN } from '../codec/wavePrm.js';

export interface WaveEntry {
  index: number;
  name: string;
  path: string;
}

export interface PadEntry {
  pad: number; // 0..14 (0-8 main pads, 9-14 external)
  wave: number; // wave index, -1 = empty
  subWave: number;
  waveName?: string; // resolved from the pool, if present
  /**
   * MIDI note that triggers this pad. Present for FULL kits (the NoteNum is
   * stored in the .spd); UNDEFINED for MINIMAL kits — those store only Wv/SubWv,
   * so the note is the device's own default (not in the file). See `noteSource`.
   */
  noteNum?: number;
  /** Per-pad MIDI channel (-1 = GLOBAL). Present for FULL kits only. */
  padMidiCh?: number;
  /**
   * Per-pad wave LEVEL (0..127). Present for FULL kits (stored in the file);
   * undefined for MINIMAL kits (the device applies its own, louder, default).
   * This is the loudness signal: an explicit 100 here is quieter than the
   * minimal-kit default.
   */
  wvLevel?: number;
  /** 'kit' = note read from the file; 'device-default' = minimal kit, note not stored. */
  noteSource: 'kit' | 'device-default';
}

export interface KitEntry {
  kit: number; // device-facing 1..100
  file: string; // kitNNN.spd
  name: string;
  minimal: boolean; // true = no Level/Tempo/FX block
  assignedPads: number;
  pads: PadEntry[];
  /** Kit master Level (0..127). FULL kits only (minimal kits store no Level → device default). */
  level?: number;
  /** Whether either kit FX slot is switched on. FULL kits only. */
  fxOn?: boolean;
}

export interface SpdsxInventory {
  root: string;
  waveCount: number;
  kitCount: number;
  waves: WaveEntry[];
  kits: KitEntry[];
}

function codesToName(codes: readonly number[]): string {
  const out: string[] = [];
  for (const v of codes) {
    if (v === 0) break;
    if (v >= 32 && v <= 126) out.push(String.fromCharCode(v));
  }
  return out.join('').replace(/\s+$/, '');
}

/** Read the wave pool: WAVE/PRM/<bucket>/<slot>.spd -> WaveEntry, sorted by index. */
export function readWaves(root: string): WaveEntry[] {
  const prmRoot = join(root, 'WAVE', 'PRM');
  const waves: WaveEntry[] = [];
  let buckets: string[];
  try {
    buckets = readdirSync(prmRoot);
  } catch {
    return waves;
  }
  for (const bucket of buckets) {
    if (!/^\d+$/.test(bucket)) continue;
    let files: string[];
    try {
      files = readdirSync(join(prmRoot, bucket));
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.startsWith('.')) continue;
      const m = /^(\d+)\.spd$/.exec(f);
      if (!m) continue;
      const index = Number.parseInt(bucket, 10) * 100 + Number.parseInt(m[1], 10);
      try {
        const { nm, path } = parseWavePrm(readFileSync(join(prmRoot, bucket, f), 'utf-8'));
        waves.push({ index, name: codesToName(nm.slice(0, NM_LEN)), path });
      } catch {
        waves.push({ index, name: '(unreadable)', path: '' });
      }
    }
  }
  waves.sort((a, b) => a.index - b.index);
  return waves;
}

/**
 * Resolve a kit's pads from its .spd text. FULL kits carry per-pad NoteNum +
 * PadMidiCh (read from the file → `noteSource:'kit'`); MINIMAL kits store only
 * Wv/SubWv, so the note is the device's own default — not in the file — and is
 * reported as `noteSource:'device-default'` with `noteNum` undefined. Pure (no
 * I/O), so it is golden-testable on kit text alone.
 */
export function padsFromKit(
  text: string,
  waveNames?: Map<number, string>,
): { pads: PadEntry[]; minimal: boolean; nm: number[]; level?: number; fxOn?: boolean } {
  if (isMinimalKit(text)) {
    const { nm, pads } = parseMinimalKit(text);
    return {
      minimal: true,
      nm,
      pads: pads.map((p, i) => ({
        pad: i,
        wave: p[0],
        subWave: p[1],
        waveName: p[0] !== -1 ? waveNames?.get(p[0]) : undefined,
        noteSource: 'device-default',
      })),
    };
  }
  const { nm, pads } = parseFullKit(text);
  // Kit-level loudness/FX, read straight from the full-kit header.
  const levelM = /<Level>(-?\d+)<\/Level>/.exec(text);
  const fx1M = /<Fx1Sw>(-?\d+)<\/Fx1Sw>/.exec(text);
  const fx2M = /<Fx2Sw>(-?\d+)<\/Fx2Sw>/.exec(text);
  const level = levelM ? Number.parseInt(levelM[1], 10) : undefined;
  const fxOn = ((fx1M ? Number.parseInt(fx1M[1], 10) : 0) !== 0) || ((fx2M ? Number.parseInt(fx2M[1], 10) : 0) !== 0);
  return {
    minimal: false,
    nm,
    level,
    fxOn,
    pads: pads.map((p, i) => ({
      pad: i,
      wave: p.wv,
      subWave: p.subWv,
      waveName: p.wv !== -1 ? waveNames?.get(p.wv) : undefined,
      noteNum: p.noteNum,
      padMidiCh: p.padMidiCh,
      wvLevel: p.wvLevel,
      noteSource: 'kit',
    })),
  };
}

function kitEntryFromText(file: string, kitNumber: number, text: string, waveNames?: Map<number, string>): KitEntry {
  const { pads, minimal, nm, level, fxOn } = padsFromKit(text, waveNames);
  return {
    kit: kitNumber,
    file,
    name: codesToName(nm),
    minimal,
    assignedPads: pads.filter((p) => p.wave !== -1).length,
    pads,
    level,
    fxOn,
  };
}

/** Read all kits: KIT/kitNNN.spd -> KitEntry, sorted by kit number. */
export function readKits(root: string, waveNames?: Map<number, string>): KitEntry[] {
  const kitRoot = join(root, 'KIT');
  const kits: KitEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(kitRoot);
  } catch {
    return kits;
  }
  for (const f of files) {
    const m = /^kit(\d+)\.spd$/.exec(f);
    if (!m) continue;
    const kitNumber = Number.parseInt(m[1], 10) + 1; // device-facing 1..100
    let text: string;
    try {
      text = readFileSync(join(kitRoot, f), 'utf-8');
    } catch {
      continue;
    }
    kits.push(kitEntryFromText(f, kitNumber, text, waveNames));
  }
  kits.sort((a, b) => a.kit - b.kit);
  return kits;
}

/**
 * Read ONE kit by device number (1..100). Returns undefined if the kit file is
 * absent/unreadable. Reads a single small .spd — far cheaper than scanning all
 * kits — so `get_preset(location)` can resolve one kit without the full sweep.
 */
export function readKit(root: string, kitNumber: number, waveNames?: Map<number, string>): KitEntry | undefined {
  const file = `kit${String(kitNumber - 1).padStart(3, '0')}.spd`;
  let text: string;
  try {
    text = readFileSync(join(root, 'KIT', file), 'utf-8');
  } catch {
    return undefined;
  }
  return kitEntryFromText(file, kitNumber, text, waveNames);
}

/**
 * Resolve wave names for ONLY the given indices (e.g. one kit's pad waves),
 * reading just the buckets those waves live in — O(pads), NOT the whole pool.
 * This is what lets `get_preset` surface pad notes + wave names fast, instead of
 * the full `readWaves` pool scan (the ~6.5 s path). Negative indices are ignored.
 */
export function readWaveNames(root: string, indices: readonly number[]): Map<number, string> {
  const names = new Map<number, string>();
  const wanted = new Set(indices.filter((i) => i >= 0));
  if (wanted.size === 0) return names;
  const prmRoot = join(root, 'WAVE', 'PRM');
  const buckets = new Set([...wanted].map((i) => Math.floor(i / 100)));
  for (const bucket of buckets) {
    const dir = join(prmRoot, String(bucket).padStart(2, '0'));
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      const m = /^(\d+)\.spd$/.exec(f);
      if (!m) continue;
      const index = bucket * 100 + Number.parseInt(m[1], 10);
      if (!wanted.has(index)) continue;
      try {
        const { nm } = parseWavePrm(readFileSync(join(dir, f), 'utf-8'));
        names.set(index, codesToName(nm.slice(0, NM_LEN)));
      } catch {
        names.set(index, '(unreadable)');
      }
    }
  }
  return names;
}

/** Full device inventory: waves + kits (with pad wave-names resolved). */
export function readInventory(root: string): SpdsxInventory {
  const waves = readWaves(root);
  const waveNames = new Map(waves.map((w) => [w.index, w.name]));
  const kits = readKits(root, waveNames);
  return { root, waveCount: waves.length, kitCount: kits.length, waves, kits };
}

/** True if `root` has the expected KIT + WAVE/PRM structure. */
export function looksMounted(root: string): boolean {
  return existsSync(join(root, 'KIT')) && existsSync(join(root, 'WAVE', 'PRM'));
}
