/**
 * circuit-card-scan.ts — MEASURE a Circuit Tracks card capture. No rendering.
 *
 * Everything the card map states as fact is derived here, out of the `.ncs`
 * files themselves rather than out of any document:
 *   - stored project name (0x10, 16 ASCII bytes), tempo (0x34), swing (0x35)
 *   - synth mixer levels (0x2701c/0x2701d) and drum levels (0x26fbd, stride 11)
 *   - which tracks carry content, and each track's pattern chain (0x2c4)
 *   - structural validity, which catches damage the CRC pass does not
 *   - bit-exact duplicates across the card, by sha256
 *   - same-name collisions, diffed byte-for-byte and attributed by REGION
 *   - post-capture drift: which slots were written after the backup was taken
 *   - a cross-reference against the `.ncs` corpus on disk, which recovers the
 *     provenance of projects no document explains
 *
 * The only thing this module takes on trust is `circuit-card-roster.ts`, and it
 * checks even that: a roster entry whose expected name disagrees with the file
 * is marked rather than believed.
 *
 * Presentation lives in `scripts/circuit-card-map.ts`. Nothing here writes.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import {
  NCS_FILE_SIZE, PATTERNS_PER_TRACK, NUM_DRUM_TRACKS, checkNcsStructure,
  PROJECT_TEMPO_OFFSET, PROJECT_SWING_OFFSET, SWING_DEFAULT, SWING_MIN, SWING_MAX,
  TEMPO_MIN_BPM, TEMPO_MAX_BPM,
  MIXER_SYNTH1_LEVEL, MIXER_SYNTH2_LEVEL, drumLevelOffset,
  PROJECT_COLOUR_OFFSET, PROJECT_COLOURS,
  META_OFFSETS, NOTE_STEP_REGION, DRUM_STEP_REGION, NOTE_TRACKS, type NoteTrack,
} from '../../packages/circuit-tracks/src/ncs/format.js';
import { decodeNotePattern } from '../../packages/circuit-tracks/src/ncs/notePattern.js';
import { decodeDrumPattern } from '../../packages/circuit-tracks/src/ncs/drumPattern.js';
import { ROSTER, type RosterEntry } from './circuit-card-roster.js';

export const PACKS = 5;
export const SLOTS_PER_PACK = 64;
/**
 * Bytes 0x04..0x0b are a fixed header constant on every project captured.
 *
 * NOT 0x04..0x0f, which is what this was until 2026-07-31: byte `0x0c` is the
 * PROJECT COLOUR (palette index 0..13, hardware-confirmed 2026-07-29), and the
 * original constant baked in `0x0b` = 11 = Blue because every project on the
 * card was unstamped at the time. Once the campaign started colouring songs,
 * that check called 126 perfectly good projects CORRUPT and refused to decode
 * their content, which is exactly the failure this map exists to prevent. The
 * colour is now range-checked as the variable field it is.
 */
const HEADER_CONST = [0x0c, 0x74, 0x02, 0x00, 0x01, 0x00, 0x00, 0x00];
/** 0x0d..0x0f are the colour field's three zero pad bytes. */
const COLOUR_PAD_ZEROES = 3;
const CHAIN_TABLE_BASE = 0x2c4;
const CHAIN_SLOT_STRIDE = 4;
const CHAIN_SLOT_DRUM1 = 4;

// ─── decode ─────────────────────────────────────────────────────────────────

export interface TrackContent { label: string; count: number; chain?: string }
export interface Decoded {
  name: string;
  tempo: number;
  swing: number;
  synthLevels: [number, number];
  drumLevels: number[];
  tracks: TrackContent[];
  faults: string[];
  sha256: string;
}

const readName = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0x10; i < 0x20; i++) { const c = b[i] & 0x7f; s += c >= 32 ? String.fromCharCode(c) : ''; }
  return s.trim();
};

const chainOf = (b: Uint8Array, slot: number): { start: number; end: number } => {
  const o = CHAIN_TABLE_BASE + slot * CHAIN_SLOT_STRIDE;
  return { start: b[o], end: b[o + 1] };
};

/** Render a chain as the 1-based pattern range the device shows. */
const chainLabel = (c: { start: number; end: number }): string | undefined =>
  c.end > c.start && c.end < PATTERNS_PER_TRACK ? `pat ${c.start + 1}-${c.end + 1}` : undefined;

/**
 * Structural faults, measured. These are the checks that separate "a project I
 * do not recognise" from "a file the device cannot have written": across the
 * 98-project card exactly ONE project trips any of them, and it is the known
 * bad `OOO`. A capture-level corruption that a CRC pass did not catch shows up
 * here, which is the point — `OOO`'s own backup entry reads CRC-verified.
 *
 * TWO LAYERS, deliberately. The first is `checkNcsStructure` from the codec
 * (length, `USER` magic, the file's own `totalSessionSize`): the shared
 * is-this-a-project-at-all gate that the transfer path, the upload pre-flight
 * and the backup manifest all use, so this map and the tools can never disagree
 * about what "corrupt" means. On top of it sit the checks that only make sense
 * when you have a whole card to compare against (the 0x04..0x0f header
 * constant, tempo and swing in the device's documented ranges, the chain table's
 * shape). Those are stricter than an upload should ever be, which is exactly why
 * they live here and not in the codec: refusing an upload over a tempo byte
 * would be wrong, flagging one on a map is useful.
 */
function structuralFaults(b: Uint8Array): string[] {
  const core = checkNcsStructure(b);
  const f: string[] = [...core.faults];
  if (b.length !== NCS_FILE_SIZE) return f;   // nothing below can be read safely
  if (HEADER_CONST.some((v, i) => b[4 + i] !== v)) f.push('header constant at 0x04..0x0b is not the value every other project carries');
  const colour = b[PROJECT_COLOUR_OFFSET];
  if (colour >= PROJECT_COLOURS.length) f.push(`colour byte ${colour} at 0x0c is outside the device's 0..${PROJECT_COLOURS.length - 1} palette`);
  for (let i = 1; i <= COLOUR_PAD_ZEROES; i++) {
    if (b[PROJECT_COLOUR_OFFSET + i] !== 0) { f.push(`colour pad byte at 0x${(PROJECT_COLOUR_OFFSET + i).toString(16)} is not zero`); break; }
  }
  const t = b[PROJECT_TEMPO_OFFSET];
  if (t < TEMPO_MIN_BPM || t > TEMPO_MAX_BPM) f.push(`tempo byte ${t} outside the device's ${TEMPO_MIN_BPM}..${TEMPO_MAX_BPM}`);
  const s = b[PROJECT_SWING_OFFSET];
  if (s < SWING_MIN || s > SWING_MAX) f.push(`swing byte ${s} outside the device's ${SWING_MIN}..${SWING_MAX}`);
  for (let i = 0; i < 8; i++) {
    const o = CHAIN_TABLE_BASE + i * CHAIN_SLOT_STRIDE;
    if (b[o] > 7 || b[o + 1] > 7 || b[o + 2] !== 0 || b[o + 3] !== 0) {
      f.push(`chain table at 0x${CHAIN_TABLE_BASE.toString(16)} is not 8 x [start,end,0,0] with 0..7 indices`);
      break;
    }
  }
  return f;
}

function decode(b: Uint8Array): Decoded {
  const sha256 = createHash('sha256').update(b).digest('hex');
  const faults = structuralFaults(b);
  if (b.length !== NCS_FILE_SIZE) {
    return { name: readName(b), tempo: -1, swing: -1, synthLevels: [-1, -1], drumLevels: [], tracks: [], faults, sha256 };
  }
  const header = {
    name: readName(b),
    tempo: b[PROJECT_TEMPO_OFFSET],
    swing: b[PROJECT_SWING_OFFSET],
    synthLevels: [b[MIXER_SYNTH1_LEVEL], b[MIXER_SYNTH2_LEVEL]] as [number, number],
    drumLevels: Array.from({ length: NUM_DRUM_TRACKS }, (_, i) => b[drumLevelOffset(i)]),
    faults, sha256,
  };
  // A corrupt file still decodes to SOMETHING — `OOO` yields ~3,600 phantom
  // notes across all eight tracks, which would read as the busiest project on
  // the card. Reporting that is worse than reporting nothing.
  if (faults.length > 0) return { ...header, tracks: [] };

  const tracks: TrackContent[] = [];
  const NOTE_LABEL: Record<NoteTrack, string> = { synth1: 'Synth1', synth2: 'Synth2', midi1: 'MIDI1', midi2: 'MIDI2' };
  const NOTE_CHAIN_SLOT: Record<NoteTrack, number> = { synth1: 0, synth2: 1, midi1: 2, midi2: 3 };
  for (const t of NOTE_TRACKS) {
    let count = 0;
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) count += decodeNotePattern(b, t, p).reduce((a, s) => a + s.notes.length, 0);
    if (count > 0) tracks.push({ label: NOTE_LABEL[t], count, chain: chainLabel(chainOf(b, NOTE_CHAIN_SLOT[t])) });
  }
  for (let d = 0; d < NUM_DRUM_TRACKS; d++) {
    let count = 0;
    for (let p = 0; p < PATTERNS_PER_TRACK; p++) count += decodeDrumPattern(b, d, p).filter((s) => s.active).length;
    if (count > 0) tracks.push({ label: `Drum${d + 1}`, count, chain: chainLabel(chainOf(b, CHAIN_SLOT_DRUM1 + d)) });
  }
  return { ...header, tracks };
}

// ─── byte-diff regions ──────────────────────────────────────────────────────

/** Block index → the track it belongs to, in the device's own words. */
function blockTrack(block: number): string {
  if (block < 8) return 'Synth 1';
  if (block < 16) return 'Synth 2';
  if (block < 48) return `Drum ${Math.floor((block - 16) / PATTERNS_PER_TRACK) + 1}`;
  return block < 56 ? 'MIDI 1' : 'MIDI 2';
}

/**
 * Which part of the file an offset belongs to. Two projects sharing a name can
 * differ in a way that matters (note content: they are different music) or in
 * a way that does not (a mixer level). A bare byte count cannot tell those
 * apart, and on this card that distinction is load-bearing: an earlier note
 * called two "Sugar 2/10" copies a two-mixer-byte difference when 136 of the
 * 138 differing bytes were Synth 1 note data.
 */
function regionOf(off: number): string {
  if (off === PROJECT_TEMPO_OFFSET) return 'tempo';
  if (off === PROJECT_SWING_OFFSET) return 'swing';
  if (off >= 0x10 && off < 0x30) return 'project name';
  if (off >= CHAIN_TABLE_BASE && off < CHAIN_TABLE_BASE + 8 * CHAIN_SLOT_STRIDE) return 'pattern chains';
  if (off >= MIXER_SYNTH1_LEVEL && off <= MIXER_SYNTH1_LEVEL + 3) return 'synth mixer levels';
  for (let i = 0; i < NUM_DRUM_TRACKS; i++) if (off === drumLevelOffset(i)) return 'drum mixer levels';
  for (let b = 0; b < META_OFFSETS.length; b++) {
    const meta = META_OFFSETS[b];
    const size = b >= 16 && b < 48 ? DRUM_STEP_REGION : NOTE_STEP_REGION;
    if (off >= meta - size && off <= meta) return `${blockTrack(b)} pattern data`;
  }
  if (off < 0x400) return 'header';
  return 'other';
}

/** `{ 'Synth 1 pattern data': 136, 'synth mixer levels': 2 }`, ordered by size. */
export function diffByRegion(a: Uint8Array, b: Uint8Array): { total: number; byRegion: [string, number][] } {
  const counts = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    total++;
    const r = regionOf(i);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return { total, byRegion: [...counts.entries()].sort((x, y) => y[1] - x[1]) };
}

// ─── capture + post-capture drift ───────────────────────────────────────────

interface ManifestProject {
  device_project: number; wire_slot: number; embedded_name: string; file: string; bytes: number; sha256: string;
  crc_verified: boolean;
  /**
   * The manifest's OWN structural verdict, recorded separately from
   * `crc_verified` since 2026-07-29. Absent on captures taken before that, which
   * is why the map never trusts it: the faults reported here are always measured
   * from the bytes. It is read only to say whether the backup KNOWS about the
   * damage it is carrying.
   */
  structurally_valid?: boolean;
}
interface ManifestPack { device_pack: number; pack_name: string; projects_occupied: number; projects: ManifestProject[] }
export interface Manifest { captured_at: string; packs: ManifestPack[] }

export interface Drift { pack: number; slot: number; dir: string; kind: 'pre-write backup' | 'other capture'; file: string; mtime: number }

/**
 * Find `.ncs` files written AFTER the capture that name a pack and a slot.
 *
 * `restore-*` directories are what the write scripts leave behind, and they are
 * the image taken BEFORE the patch (`circuit-set-project-tempo.ts` writes its
 * backup, then patches, then uploads). So one of them existing PROVES the slot
 * was written after the capture, but its bytes are the OLD state — the new
 * value is on the device and in no capture on disk. That asymmetry is why the
 * map can flag staleness mechanically but has to source the corrected value
 * from the roster.
 */
export function findDrift(captureDir: string, capturedAt: number): Drift[] {
  const parent = dirname(resolve(captureDir));
  if (!existsSync(parent)) return [];
  const out: Drift[] = [];
  for (const e of readdirSync(parent, { withFileTypes: true })) {
    if (!e.isDirectory() || join(parent, e.name) === resolve(captureDir)) continue;
    const dir = join(parent, e.name);
    for (const f of readdirSync(dir)) {
      const m = /^(?:.*-)?pack(\d+)-proj(\d+)\.ncs$/.exec(f);
      if (!m) continue;
      const p = join(dir, f);
      const mtime = statSync(p).mtimeMs;
      if (mtime <= capturedAt) continue;
      out.push({
        pack: Number(m[1]), slot: Number(m[2]), dir: e.name,
        kind: e.name.startsWith('restore-') ? 'pre-write backup' : 'other capture',
        file: p, mtime,
      });
    }
  }
  return out.sort((a, b) => a.pack - b.pack || a.slot - b.slot || a.mtime - b.mtime);
}

/**
 * sha256 of every `.ncs` under `root`, so a project can be matched to the
 * authoring artifact, groove file or earlier snapshot it came from. This is
 * how Pack 4's two unexplained "Sugar 2/10" projects were identified (they are
 * byte-identical to the before/after images of a 2026-07-26 mixer experiment)
 * and how Pack 1 project 11 turned out to be an untouched blank template.
 */
export function buildXref(root: string, exclude: string, enabled = true): Map<string, string[]> {
  const index = new Map<string, string[]>();
  if (!enabled || !existsSync(root)) return index;
  const skip = resolve(exclude);
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (resolve(p) !== skip) walk(p); continue; }
      if (!e.name.endsWith('.ncs')) continue;
      const h = createHash('sha256').update(readFileSync(p)).digest('hex');
      index.set(h, [...(index.get(h) ?? []), relative(root, p).split(/[\\/]/).join('/')]);
    }
  };
  walk(root);
  // A match inside a timestamped restore/backup directory says only "we took a
  // backup", which the map already reports. A match against an authoring
  // artifact (`grooves/gm/all/granite_gm.ncs`, `blank_slot20.ncs`) says where
  // the project CAME FROM. Rank the second kind first.
  const transient = /(^|\/)(restore|backup|card-backup|metre-test)[-/]/;
  for (const [h, paths] of index) {
    index.set(h, [...paths].sort((a, b) =>
      Number(transient.test(a)) - Number(transient.test(b)) || a.length - b.length || a.localeCompare(b)));
  }
  return index;
}

// ─── rows ───────────────────────────────────────────────────────────────────

export interface Row {
  pack: number;
  slot: number;
  occupied: boolean;
  decoded?: Decoded;
  roster?: RosterEntry;
  /** Not in the capture at all — reconstructed from a post-capture file. */
  postCaptureOnly?: boolean;
  drift: Drift[];
  notes: string[];
  markers: string[];
  duplicateOf?: string;
  /** Other projects on the card carrying the same stored name. */
  nameShared?: boolean;
  /**
   * Does the capture's manifest carry a structural verdict for this slot at all?
   * `false` means the backup predates the check and is silent about it, which is
   * worth saying on a row the map is calling corrupt.
   */
  manifestKnows?: boolean;
  /** Paths under the xref root holding byte-identical copies. */
  alsoOnDisk: string[];
  bytes?: Uint8Array;
}

const key = (pack: number, slot: number): string => `${pack}:${slot}`;

/** One row per slot of every pack, occupied or not, in device order. */
export function buildRows(captureDir: string, man: Manifest, drift: Drift[], xref: Map<string, string[]>): Row[] {
  const byKey = new Map<string, ManifestProject & { pack: number }>();
  for (const p of man.packs) for (const pr of p.projects) byKey.set(key(p.device_pack, pr.device_project), { ...pr, pack: p.device_pack });

  const driftByKey = new Map<string, Drift[]>();
  for (const d of drift) {
    const k = key(d.pack, d.slot);
    driftByKey.set(k, [...(driftByKey.get(k) ?? []), d]);
  }

  const rows: Row[] = [];
  for (let pack = 1; pack <= PACKS; pack++) {
    for (let slot = 1; slot <= SLOTS_PER_PACK; slot++) {
      const k = key(pack, slot);
      const mp = byKey.get(k);
      const rowDrift = driftByKey.get(k) ?? [];
      const roster = ROSTER[k];
      if (!mp && rowDrift.length === 0) { rows.push({ pack, slot, occupied: false, drift: [], notes: [], markers: [], alsoOnDisk: [] }); continue; }
      // A slot absent from the capture is read from the NEWEST post-capture
      // file that names it — the closest thing on disk to what is on the card.
      const src = mp ? join(captureDir, mp.file) : rowDrift[rowDrift.length - 1].file;
      const bytes = new Uint8Array(readFileSync(src));
      const decoded = decode(bytes);
      rows.push({
        pack, slot, occupied: true, decoded, roster, postCaptureOnly: !mp, drift: rowDrift,
        manifestKnows: mp === undefined ? undefined : mp.structurally_valid !== undefined,
        notes: [], markers: [], bytes, alsoOnDisk: xref.get(decoded.sha256) ?? [],
      });
    }
  }

  // Bit-exact duplicates across the whole card. Names collide on this device;
  // sha256 is the only thing that says whether two same-named projects are the
  // same project.
  const bySha = new Map<string, Row[]>();
  for (const r of rows) if (r.decoded) bySha.set(r.decoded.sha256, [...(bySha.get(r.decoded.sha256) ?? []), r]);
  for (const [, group] of bySha) {
    if (group.length < 2) continue;
    for (const r of group) {
      r.duplicateOf = group.filter((o) => o !== r).map((o) => `Pack ${o.pack} project ${o.slot}`).join(', ');
    }
  }

  for (const r of nameGroups(rows).flatMap(([, g]) => g)) r.nameShared = true;
  for (const r of rows) annotate(r);
  return rows;
}

/** Occupied rows grouped by stored project name, only where 2+ share one. */
export function nameGroups(rows: Row[]): [string, Row[]][] {
  const byName = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.decoded || !r.occupied) continue;
    byName.set(r.decoded.name, [...(byName.get(r.decoded.name) ?? []), r]);
  }
  return [...byName.entries()].filter(([, g]) => g.length > 1)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/** Everything in the Notes column that is DERIVED rather than written by hand. */
function annotate(r: Row): void {
  const d = r.decoded;
  if (!d) return;

  if (d.faults.length > 0) {
    r.markers.push('**CORRUPT**');
    r.notes.push(
      `Structurally invalid: ${d.faults.join('; ')}. Its backup entry nonetheless reads CRC-verified, and that entry is ` +
      `not wrong: the device's transfer CRC32 covers the ENCODED STREAM, not the decoded file, so it cannot see this ` +
      `class of damage at all. The backup now records structural validity as its own field beside the CRC verdict` +
      `${r.manifestKnows === false ? ', but THIS capture predates that field and does not carry it' : ''}. ` +
      `Not restorable; \`upload_project\` refuses it.`,
    );
  }
  if (r.roster && r.roster.name !== d.name) {
    r.markers.push('**NAME MISMATCH**');
    r.notes.push(`The map expected \`${r.roster.name}\` here and the file says \`${d.name}\`. The slot has been rewritten since the roster entry; treat the description as unverified.`);
  }
  if (!r.roster) {
    r.markers.push('**UNCLASSIFIED**');
    r.notes.push('No entry in `scripts/_lib/circuit-card-roster.ts`. Nothing on disk records what this is.');
  }
  if (r.postCaptureOnly) {
    r.markers.push('**NOT IN THE CAPTURE**');
    r.notes.push('Written to the device after this capture was taken, and never backed up. Read from a post-capture file on disk instead.');
  } else if (r.drift.some((x) => x.kind === 'pre-write backup')) {
    r.markers.push('**TEMPO STALE**');
  }
  if (r.duplicateOf) r.notes.push(`Bit-exact duplicate (sha256) of ${r.duplicateOf}.`);
  if (r.nameShared && !r.duplicateOf) {
    r.markers.push('**NAME SHARED**');
    r.notes.push('Another project on the card carries this exact name and is a different file — see [Same name, different project](#same-name-different-project).');
  }
  if (r.alsoOnDisk.length > 0) {
    const [first, ...rest] = r.alsoOnDisk;
    r.notes.push(`Also on disk: \`${first}\`${rest.length > 0 ? ` +${rest.length}` : ''}.`);
  }

  // Level 0 on a track with NO content is the card-wide default after the
  // deliberate mixer pass and says nothing; level 0 on a track that CARRIES
  // NOTES is the case that reads as a broken project at the rig. Only flag the
  // second, or the marker fires on half the card and stops meaning anything.
  const synthContent = d.tracks.some((t) => t.label.startsWith('Synth'));
  if (d.synthLevels[0] === 0 && d.synthLevels[1] === 0 && synthContent) {
    r.markers.push('**SILENT SYNTHS**');
    r.notes.push('Both synth mixer levels are stored at 0 while Synth 1/2 carry notes, so the Circuit itself makes no sound here. Deliberate on the projects that drive external gear over MIDI, and indistinguishable from a broken project when you are standing at the rig.');
  }
  const silentDrums = d.drumLevels
    .map((lv, i) => ({ lv, i }))
    .filter(({ lv, i }) => lv === 0 && d.tracks.some((t) => t.label === `Drum${i + 1}`));
  if (silentDrums.length > 0) {
    r.markers.push('**SILENT DRUMS**');
    r.notes.push(`Drum ${silentDrums.map(({ i }) => i + 1).join('/')} carry hits at mixer level 0 — a blend layer laid in silently, dialled up from the mixer on demand.`);
  }
  if (d.swing !== SWING_DEFAULT && d.faults.length === 0) r.notes.push(`Swing ${d.swing} (50 is even).`);
}
