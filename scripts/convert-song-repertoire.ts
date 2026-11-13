/**
 * Convert the older per-song records into an OpenRig repertoire (spec §7).
 *
 *   npx tsx scripts/convert-song-repertoire.ts \
 *     --rig <rig.json> --specs <dir of song specs> [--mappings <song-mappings.json>]
 *     [--projects <folder of MPC song projects>] [--overlay <overlay.json>]
 *     --out <repertoire.json>
 *
 * The output is REGENERATED on every run, so nothing is ever hand-edited there.
 * Choices a person makes (a tone, a loop memory, a vocal patch, a setlist) live
 * in the OVERLAY, a hand-kept file this script only reads:
 *
 *   { "songs": { "<song id>": { "units": [ ...SongUnit ] } },
 *     "performances": [ ...Performance ] }
 *
 * An overlay unit replaces the generated units of the same kind on the same
 * node (for a scene: the same section too), then the rest are kept. A song id
 * the inputs did not produce is an error, not a new song.
 *
 * Two generated inputs, both optional per song:
 *   - a SONG SPEC (title, artist, tab source, sections with bar ranges). Its
 *     sections become the song's sections, and one section_map on the rig's
 *     sequencer. With --projects, each section's location is READ from the
 *     song's project file (matched by sequence name; a project interleaves
 *     fills and extras, so section N is rarely sequence N) and marked
 *     confirmed. A section the project has no sequence for is left out and
 *     reported. Without --projects the map is the guess "section N = location
 *     N", marked proposed.
 *   - a SONG MAPPING (claims = stored things a device must hold, assignments
 *     = channels and recalls). Rows for a device that is in the rig become
 *     recall / channel units. Rows for a device that is NOT in the rig are
 *     dropped and counted, never rewritten onto another node.
 *
 * It invents nothing: a tone nobody chose stays absent (or `owed` when the
 * mapping said so), and the report names every song that still has no unit on
 * a node that makes sound.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  validatePerformance,
  validateRepertoire,
  planSong,
  type Performance,
  type Repertoire,
  type Rig,
  type Song,
  type SongUnit,
  type UnitStatus,
} from '../packages/openrig/src/index.js';
import { parseXpj, sequenceTitle, summarizeXpj, type XpjSummary } from '../packages/akai-mpc/src/codec/project.js';

interface Spec {
  title: string;
  artist?: string;
  bpm?: number;
  source?: { songId?: number; revisionId?: number };
  sections?: Array<{ name: string; from?: number; to?: number }>;
}
interface Claim {
  device?: string;
  slot?: string | number;
  expected_name?: string;
  role?: string;
  status?: string;
}
interface Assignment {
  kind?: string;
  device?: string;
  channel?: number;
  part?: string;
  target_slot?: string | number;
  status?: string;
}
interface Mapping {
  song: string;
  artist?: string;
  claims?: Claim[];
  assignments?: Assignment[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const status = (s: string | undefined): UnitStatus =>
  s === 'confirmed' || s === 'owed' ? s : 'proposed';

const rigPath = arg('rig');
const specsDir = arg('specs');
const mappingsPath = arg('mappings');
const outPath = arg('out');
const projectsDir = arg('projects');
const overlayPath = arg('overlay');
if (rigPath === undefined || outPath === undefined || (specsDir === undefined && mappingsPath === undefined)) {
  console.error('usage: convert-song-repertoire.ts --rig <rig.json> [--specs <dir>] [--mappings <json>] [--projects <dir>] [--overlay <json>] --out <repertoire.json>');
  process.exit(2);
}

const rig = JSON.parse(readFileSync(rigPath, 'utf8')) as Rig;
const nodeOfDevice = new Map<string, string>();
for (const n of rig.nodes) {
  if (typeof n.server_device_id === 'string') nodeOfDevice.set(n.server_device_id, n.id);
}
const sequencer = rig.nodes.find((n) => n.roles.includes('sequencer') && typeof n.server_device_id === 'string');

const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const projectFolders = projectsDir !== undefined ? readdirSync(projectsDir) : [];
/** The song's project on disk: a folder that starts with the title, holding one .xpj. */
function findProject(title: string): { container: string; summary: XpjSummary } | undefined {
  if (projectsDir === undefined) return undefined;
  const folder = projectFolders.find((d) => norm(d) === norm(title) || norm(d).startsWith(`${norm(title)} `));
  if (folder === undefined) return undefined;
  const dir = join(projectsDir, folder);
  if (!existsSync(dir)) return undefined;
  const xpj = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.xpj'));
  if (xpj === undefined) return undefined;
  return { container: `${folder}/${xpj}`, summary: summarizeXpj(parseXpj(readFileSync(join(dir, xpj)))) };
}
const notes: string[] = [];

const songs = new Map<string, Song>();
const dropped = new Map<string, number>();
const drop = (what: string): void => { dropped.set(what, (dropped.get(what) ?? 0) + 1); };

if (specsDir !== undefined) {
  for (const file of readdirSync(specsDir).filter((f) => f.endsWith('.json')).sort()) {
    const spec = JSON.parse(readFileSync(join(specsDir, file), 'utf8')) as Spec;
    const id = basename(file, '.json');
    const sections = (spec.sections ?? []).map((s) => ({
      name: s.name,
      ...(s.from !== undefined ? { from_bar: s.from } : {}),
      ...(s.to !== undefined ? { to_bar: s.to } : {}),
    }));
    const units: SongUnit[] = [];
    const project = findProject(spec.title);
    if (projectsDir !== undefined && project === undefined) notes.push(`${id}: no project found under --projects; section map is the unread guess`);
    if (sequencer !== undefined && sections.length > 0 && project !== undefined) {
      const byTitle = new Map<string, { number: number; name: string }>();
      for (const q of project.summary.sequences) {
        const k = norm(sequenceTitle(q.name));
        if (!byTitle.has(k)) byTitle.set(k, q);
      }
      const entries: Array<{ section: string; location: number; expected_name: string }> = [];
      const absent: string[] = [];
      for (const sec of sections) {
        const q = byTitle.get(norm(sec.name));
        if (q === undefined) absent.push(sec.name);
        else entries.push({ section: sec.name, location: q.number, expected_name: q.name });
      }
      // A repeat with no sequence of its own name ("Chorus 2") may be played
      // by a chart piece: a `cNN <part>` sequence the project's full-song
      // playlist uses where no loop covers that stretch. Map it only when the
      // answer is unambiguous: one unmatched section and one chart piece
      // share the part name, and a playlist actually plays that piece.
      // First, the project's own playlists. One that has exactly one item per
      // section, and agrees with every section already matched by name, IS
      // the section order: an unmatched section plays whatever sits at its
      // position (a repeat that reuses an earlier sequence shows up this way).
      for (const sg of project.summary.songs) {
        if (absent.length === 0 || sg.items.length !== sections.length) continue;
        const at = (i: number): number => sg.items[i].sequenceIndex + 1;
        const agrees = sections.every((sec, i) => {
          const known = entries.find((e) => e.section === sec.name);
          return known === undefined || known.location === at(i);
        });
        if (!agrees) continue;
        sections.forEach((sec, i) => {
          if (!absent.includes(sec.name)) return;
          const q = project.summary.sequences.find((x) => x.number === at(i));
          if (q === undefined) return;
          entries.push({ section: sec.name, location: q.number, expected_name: q.name });
          absent.splice(absent.indexOf(sec.name), 1);
          notes.push(`${id}: ${sec.name} plays "${q.name}" (sequence ${q.number}), read from its position in the playlist "${sg.name}"`);
        });
      }
      const played = new Set(project.summary.songs.flatMap((sg) => sg.items.map((it) => it.sequenceIndex + 1)));
      const base = (name: string): string => norm(name.replace(/\s+\d+$/, ''));
      for (const name of [...absent]) {
        const pieces = project.summary.sequences.filter((q) => /^c\d+\s/i.test(q.name) && norm(sequenceTitle(q.name)) === base(name));
        const rivals = absent.filter((other) => base(other) === base(name));
        if (pieces.length === 1 && rivals.length === 1 && played.has(pieces[0].number)) {
          entries.push({ section: name, location: pieces[0].number, expected_name: pieces[0].name });
          absent.splice(absent.indexOf(name), 1);
          notes.push(`${id}: ${name} is played by the chart piece "${pieces[0].name}" (sequence ${pieces[0].number}), the only one of that part in the full-song playlist`);
        }
      }
      if (absent.length > 0) notes.push(`${id}: the project has no sequence named for ${absent.join(', ')} (left out of the map)`);
      units.push({
        kind: 'section_map',
        node: sequencer.id,
        role: 'the sequence that plays each section, read from the project file',
        container: project.container,
        entries,
        status: 'confirmed',
      });
    } else if (sequencer !== undefined && sections.length > 0) {
      units.push({
        kind: 'section_map',
        node: sequencer.id,
        role: 'one sequence per section, in song order (not read from a project)',
        container: spec.title,
        entries: sections.map((s, i) => ({ section: s.name, location: i + 1, expected_name: s.name })),
      });
    }
    const projectBpms = project !== undefined ? [...new Set(project.summary.sequences.map((q) => q.bpm).filter((b): b is number => b !== undefined))] : [];
    const tempo = spec.bpm ?? (projectBpms.length === 1 ? projectBpms[0] : undefined);
    if (spec.bpm !== undefined && projectBpms.length === 1 && projectBpms[0] !== spec.bpm) {
      notes.push(`${id}: spec says ${spec.bpm} BPM, the project plays ${projectBpms[0]}`);
    }
    songs.set(slug(spec.title), {
      id,
      title: spec.title,
      ...(spec.artist !== undefined ? { artist: spec.artist } : {}),
      ...(tempo !== undefined ? { tempo_bpm: tempo } : {}),
      ...(spec.source?.songId !== undefined
        ? { source: { kind: 'tab' as const, ref: spec.source.songId, ...(spec.source.revisionId !== undefined ? { revision: spec.source.revisionId } : {}) } }
        : {}),
      ...(sections.length > 0 ? { sections } : {}),
      units,
    });
  }
}

if (mappingsPath !== undefined) {
  const mappings = (JSON.parse(readFileSync(mappingsPath, 'utf8')) as { songs: Mapping[] }).songs;
  for (const m of mappings) {
    const key = slug(m.song);
    const units: SongUnit[] = [];
    for (const c of m.claims ?? []) {
      if (c.device === undefined) continue;
      const node = nodeOfDevice.get(c.device);
      if (node === undefined) { drop(`claim on ${c.device} (not in this rig)`); continue; }
      const named = c.expected_name !== undefined && !/^\(.*\)$/.test(c.expected_name);
      units.push({
        kind: 'recall',
        node,
        ...(c.slot !== undefined ? { location: c.slot } : {}),
        ...(named ? { expected_name: c.expected_name } : {}),
        ...(c.role !== undefined ? { role: c.role } : {}),
        status: c.slot === undefined ? 'owed' : status(c.status),
      });
    }
    for (const a of m.assignments ?? []) {
      if (a.kind === undefined) continue;
      if (a.kind === 'channel' || a.kind === 'recall') {
        const node = a.device !== undefined ? nodeOfDevice.get(a.device) : undefined;
        if (node === undefined) { drop(`${a.kind} on ${a.device ?? 'no device'} (not in this rig)`); continue; }
        if (a.kind === 'channel' && a.channel !== undefined && a.channel >= 1 && a.channel <= 16) {
          units.push({ kind: 'channel', node, channel: a.channel as 1, ...(a.part !== undefined ? { role: a.part } : {}), status: status(a.status) });
        } else if (a.kind === 'recall') {
          units.push({
            kind: 'recall', node,
            ...(a.target_slot !== undefined ? { location: a.target_slot } : {}),
            status: a.target_slot === undefined ? 'owed' : status(a.status),
          });
        }
        continue;
      }
      // Scene-to-Program-Change tables are written against the device they
      // address; when that device left the rig the numbers mean nothing here.
      drop(`${a.kind} (addresses a device outside this rig)`);
    }
    const existing = songs.get(key);
    if (existing !== undefined) {
      existing.units.push(...units);
    } else if (units.length > 0) {
      songs.set(key, { id: key, title: m.song, ...(m.artist !== undefined ? { artist: m.artist } : {}), units });
    } else {
      drop('song with nothing left for this rig');
    }
  }
}

let performances: Performance[] | undefined;
if (overlayPath !== undefined && existsSync(overlayPath)) {
  const overlay = JSON.parse(readFileSync(overlayPath, 'utf8')) as {
    songs?: Record<string, { units?: SongUnit[] }>;
    performances?: Performance[];
  };
  const byId = new Map([...songs.values()].map((sg) => [sg.id, sg]));
  const slot = (u: SongUnit): string => `${u.node}/${u.kind}${u.kind === 'scene' ? `/${u.section ?? ''}` : ''}`;
  let placed = 0;
  for (const [id, entry] of Object.entries(overlay.songs ?? {})) {
    const target = byId.get(id);
    if (target === undefined) {
      console.error(`overlay names song "${id}", which the inputs did not produce. Song ids: ${[...byId.keys()].sort().join(', ')}`);
      process.exit(1);
    }
    const mine = entry.units ?? [];
    const taken = new Set(mine.map(slot));
    target.units = [...target.units.filter((u) => !taken.has(slot(u))), ...mine];
    placed += mine.length;
  }
  performances = overlay.performances;
  notes.push(`overlay: ${placed} hand-chosen unit(s) across ${Object.keys(overlay.songs ?? {}).length} song(s), ${performances?.length ?? 0} setlist(s)`);
} else if (overlayPath !== undefined) {
  notes.push(`overlay: ${overlayPath} does not exist yet, nothing merged`);
}

const repertoire: Repertoire = {
  rig: rig.id,
  songs: [...songs.values()].sort((a, b) => a.id.localeCompare(b.id)),
  ...(performances !== undefined && performances.length > 0 ? { performances } : {}),
};
const result = validateRepertoire(rig, repertoire);
for (const perf of performances ?? []) {
  const pr = validatePerformance(repertoire, perf);
  for (const e of pr.errors) { result.errors.push(e); result.ok = false; }
}
writeFileSync(outPath, `${JSON.stringify(repertoire, null, 1)}\n`);

const soundNodes = new Set(
  rig.nodes
    .filter((n) => typeof n.server_device_id === 'string' && n.id !== sequencer?.id
      && n.roles.some((r) => r === 'sound_source' || r === 'effect' || r === 'looper'))
    .map((n) => n.id),
);
console.log(`${repertoire.songs.length} songs written to ${outPath}`);
console.log(`validation: ${result.ok ? 'ok' : 'ERRORS'} (${result.errors.length} errors, ${result.warnings.length} warnings)`);
for (const e of result.errors) console.log(`  error ${e.code}: ${e.message}`);
for (const [what, n] of [...dropped].sort()) console.log(`  dropped ${n}: ${what}`);
for (const n of notes) console.log(`  note ${n}`);
for (const nodeId of soundNodes) {
  const missing = repertoire.songs.filter((s) => !s.units.some((u) => u.node === nodeId && (u.status ?? 'proposed') !== 'owed'));
  console.log(`  ${nodeId}: ${repertoire.songs.length - missing.length} songs have a chosen unit, ${missing.length} do not`);
}
const steps = repertoire.songs.reduce((n, s) => n + planSong(rig, s).steps.length, 0);
const gaps = repertoire.songs.reduce((n, s) => n + planSong(rig, s).gaps.length, 0);
console.log(`plans: ${steps} steps, ${gaps} gaps across the repertoire`);
process.exit(result.ok ? 0 : 1);
