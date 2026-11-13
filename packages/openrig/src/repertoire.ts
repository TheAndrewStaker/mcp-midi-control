/**
 * OpenRig L2 (repertoire) and L3 (performance): what each song needs from each
 * device in a rig, and the order songs are played in (spec §7).
 *
 * Owns three things, all pure (no hardware, no descriptor registry):
 *   - the song / setlist types,
 *   - `validateRepertoire`, which checks a library against an L1 rig,
 *   - `planSong` / `planPerformance`, which turn a song into the ordered list of
 *     device actions that set the rig up for it.
 *
 * A plan is DATA, not execution. Each step names a verb on the unified tool
 * surface and its arguments; a host replays the steps through those verbs, so
 * every safety gate the verbs carry still applies. Nothing here persists
 * anything: a plan only navigates (recall a stored unit, pick a scene) or edits
 * a working buffer.
 */
import type { MidiChannel, Rig } from './types.js';
import type { ValidationIssue, ValidationResult } from './validate.js';

/** Where a song sits in the player's own lifecycle. */
export type SongStatus = 'aspiring' | 'learning' | 'gig_ready';

/**
 * How far a single unit is trusted:
 *   - `confirmed`  checked on the device,
 *   - `proposed`   decided but not checked,
 *   - `owed`       the song needs it and nobody has chosen it yet.
 */
export type UnitStatus = 'confirmed' | 'proposed' | 'owed';

export const SONG_STATUSES: readonly SongStatus[] = ['aspiring', 'learning', 'gig_ready'];
export const UNIT_STATUSES: readonly UnitStatus[] = ['confirmed', 'proposed', 'owed'];

/** A named part of the song (verse, chorus), optionally with its bar range. */
export interface SongSection {
  name: string;
  from_bar?: number;
  to_bar?: number;
}

interface UnitBase {
  /** The L1 node id this unit lives on. */
  node: string;
  /** What it plays or does in the song, for a human. */
  role?: string;
  /** Default `proposed`. */
  status?: UnitStatus;
}

/**
 * A stored unit the device recalls for this song: a preset, a patch, a kit, a
 * looper memory, a vocal memory. `location` uses the device's own numbering, as
 * its front panel shows it. Omit it on an `owed` unit.
 */
export interface RecallUnit extends UnitBase {
  kind: 'recall';
  location?: string | number;
  /** The name the device should report there; lets a checker catch drift. */
  expected_name?: string;
}

/** Which stored unit plays each section (MPC sequences, one project per part). */
export interface SectionMapUnit extends UnitBase {
  kind: 'section_map';
  /**
   * The stored thing that holds these locations when it is not the device's
   * whole memory (an MPC project holds its sequences). It has to be loaded
   * before any entry can be recalled; no verb loads it, so it is planned as a
   * by-hand gap.
   */
  container?: string;
  entries: Array<{ section: string; location: string | number; expected_name?: string }>;
}

/** The scene a multi-scene device should sit on, for the song or one section. */
export interface SceneUnit extends UnitBase {
  kind: 'scene';
  scene: number;
  section?: string;
}

/** One parameter value, in the device's display units. */
export interface ParamUnit extends UnitBase {
  kind: 'param';
  block: string;
  name: string;
  value: string | number;
  /** Per-block channel (A-D, X/Y) on devices that have them. */
  channel?: string | number;
}

/** The MIDI channel the device listens on for this song. A recorded fact. */
export interface ChannelUnit extends UnitBase {
  kind: 'channel';
  channel: MidiChannel;
}

/**
 * A MIDI message the device itself sends when the player acts (a scene stomp
 * that fires a Program Change at another box). It is authored into the device
 * ahead of the show, so it is a fact to check, not a step to replay.
 */
export interface EmitUnit extends UnitBase {
  kind: 'emit';
  /** The scene or section whose selection sends the message. */
  on?: { scene?: number; section?: string };
  message: { type: 'pc' | 'cc'; channel: MidiChannel; value: number; cc?: number };
  /** The node the message is meant for. */
  to?: string;
}

export type SongUnit =
  | RecallUnit
  | SectionMapUnit
  | SceneUnit
  | ParamUnit
  | ChannelUnit
  | EmitUnit;

export interface Song {
  /** Stable slug, unique in the repertoire. */
  id: string;
  title: string;
  artist?: string;
  status?: SongStatus;
  tempo_bpm?: number;
  /** Where the arrangement came from. A revision pins it: a re-fetch may differ. */
  source?: { kind: 'tab' | 'midi' | 'manual'; ref?: string | number; revision?: string | number };
  sections?: SongSection[];
  units: SongUnit[];
  note?: string;
}

export interface Repertoire {
  /** The L1 rig id these songs are written against. */
  rig: string;
  songs: Song[];
  /** Setlists drawn from these songs (L3). Optional: a song book with none is complete. */
  performances?: Performance[];
}

export interface Performance {
  id: string;
  name: string;
  rig: string;
  /** Play order. A song may appear twice. */
  songs: Array<{ ref: string; tempo_override?: number; note?: string }>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function issue(
  severity: 'error' | 'warning', code: string, message: string, ref?: string,
): ValidationIssue {
  return { severity, code, message, ...(ref !== undefined ? { ref } : {}) };
}

const isChannel = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 16;
const is7bit = (n: unknown): boolean => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 127;

/**
 * Check a repertoire against its rig. Errors are things a plan cannot survive
 * (an unknown node, a duplicate id, a malformed message). Warnings are honest
 * gaps (an owed unit, a node this server cannot drive).
 */
export function validateRepertoire(rig: Rig, repertoire: Repertoire): ValidationResult {
  const issues: ValidationIssue[] = [];
  const nodes = new Map(rig.nodes.map((n) => [n.id, n]));
  if (repertoire.rig !== rig.id) {
    issues.push(issue('error', 'rig-mismatch',
      `Repertoire targets rig "${repertoire.rig}" but was checked against "${rig.id}".`));
  }
  const seen = new Set<string>();
  for (const song of repertoire.songs) {
    const ref = song.id;
    if (seen.has(song.id)) {
      issues.push(issue('error', 'duplicate-song', `Song id "${song.id}" appears twice.`, ref));
    }
    seen.add(song.id);
    if (song.status !== undefined && !SONG_STATUSES.includes(song.status)) {
      issues.push(issue('error', 'bad-song-status', `"${song.title}": status "${song.status}" is not one of ${SONG_STATUSES.join(', ')}.`, ref));
    }
    if (song.tempo_bpm !== undefined && !(song.tempo_bpm > 0)) {
      issues.push(issue('error', 'bad-tempo', `"${song.title}": tempo must be above 0.`, ref));
    }
    const sectionNames = new Set((song.sections ?? []).map((s) => s.name));
    const knowsSection = (name: string): boolean => song.sections === undefined || sectionNames.has(name);
    for (const s of song.sections ?? []) {
      if (s.from_bar !== undefined && s.to_bar !== undefined && s.to_bar < s.from_bar) {
        issues.push(issue('error', 'bad-section-range', `"${song.title}" section "${s.name}" ends before it starts.`, ref));
      }
    }
    for (const unit of song.units) {
      const where = `"${song.title}" ${unit.kind} on "${unit.node}"`;
      const node = nodes.get(unit.node);
      if (node === undefined) {
        issues.push(issue('error', 'unknown-node', `${where}: the rig has no node with that id.`, ref));
        continue;
      }
      if (unit.status !== undefined && !UNIT_STATUSES.includes(unit.status)) {
        issues.push(issue('error', 'bad-unit-status', `${where}: status "${unit.status}" is not one of ${UNIT_STATUSES.join(', ')}.`, ref));
      }
      if (unit.status === 'owed') {
        issues.push(issue('warning', 'owed-unit', `${where}: still owed${unit.role ? ` (${unit.role})` : ''}.`, ref));
      }
      const drivable = typeof node.server_device_id === 'string' && node.server_device_id !== '';
      if (!drivable && (unit.kind === 'recall' || unit.kind === 'scene' || unit.kind === 'param' || unit.kind === 'section_map')) {
        issues.push(issue('warning', 'opaque-node', `${where}: this node has no server device, so the step is set by hand.`, ref));
      }
      switch (unit.kind) {
        case 'recall':
          if (unit.location === undefined && unit.status !== 'owed') {
            issues.push(issue('error', 'missing-location', `${where}: needs a location, or status "owed".`, ref));
          }
          break;
        case 'section_map':
          if (unit.entries.length === 0) {
            issues.push(issue('error', 'empty-section-map', `${where}: has no entries.`, ref));
          }
          for (const e of unit.entries) {
            if (!knowsSection(e.section)) {
              issues.push(issue('error', 'unknown-section', `${where}: section "${e.section}" is not in the song.`, ref));
            }
          }
          break;
        case 'scene':
          if (!Number.isInteger(unit.scene) || unit.scene < 1) {
            issues.push(issue('error', 'bad-scene', `${where}: scene must be a whole number from 1.`, ref));
          }
          if (unit.section !== undefined && !knowsSection(unit.section)) {
            issues.push(issue('error', 'unknown-section', `${where}: section "${unit.section}" is not in the song.`, ref));
          }
          break;
        case 'channel':
          if (!isChannel(unit.channel)) {
            issues.push(issue('error', 'bad-channel', `${where}: channel must be 1..16.`, ref));
          }
          break;
        case 'emit': {
          const m = unit.message;
          if (!isChannel(m.channel) || !is7bit(m.value) || (m.type === 'cc' && !is7bit(m.cc))) {
            issues.push(issue('error', 'bad-message', `${where}: channel 1..16, value 0..127, and a cc number for a cc message.`, ref));
          }
          if (unit.to !== undefined && !nodes.has(unit.to)) {
            issues.push(issue('error', 'unknown-node', `${where}: target node "${unit.to}" is not in the rig.`, ref));
          }
          if (unit.on?.section !== undefined && !knowsSection(unit.on.section)) {
            issues.push(issue('error', 'unknown-section', `${where}: section "${unit.on.section}" is not in the song.`, ref));
          }
          break;
        }
        case 'param':
          break;
      }
    }
  }
  const errors = issues.filter((i) => i.severity === 'error');
  return { ok: errors.length === 0, errors, warnings: issues.filter((i) => i.severity === 'warning') };
}

/** Check a setlist against its repertoire. */
export function validatePerformance(repertoire: Repertoire, performance: Performance): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (performance.rig !== repertoire.rig) {
    issues.push(issue('error', 'rig-mismatch',
      `Performance "${performance.name}" targets rig "${performance.rig}" but the repertoire is for "${repertoire.rig}".`));
  }
  const ids = new Set(repertoire.songs.map((s) => s.id));
  performance.songs.forEach((entry, i) => {
    if (!ids.has(entry.ref)) {
      issues.push(issue('error', 'unknown-song', `Position ${i + 1}: no song "${entry.ref}" in the repertoire.`, entry.ref));
    }
    if (entry.tempo_override !== undefined && !(entry.tempo_override > 0)) {
      issues.push(issue('error', 'bad-tempo', `Position ${i + 1}: tempo override must be above 0.`, entry.ref));
    }
  });
  const errors = issues.filter((i) => i.severity === 'error');
  return { ok: errors.length === 0, errors, warnings: issues.filter((i) => i.severity === 'warning') };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** One device action, expressed as a verb on the unified tool surface. */
export interface PlanStep {
  node: string;
  /** The server descriptor id; pass it as the verb's `port`. */
  device: string;
  tool: 'switch_preset' | 'switch_scene' | 'set_param';
  args: Record<string, string | number>;
  /** `navigate` loads something stored; `edit` changes the working buffer. */
  effect: 'navigate' | 'edit';
  status: UnitStatus;
  why?: string;
}

/** Something the plan cannot do for the player, and why. */
export interface PlanGap {
  node: string;
  reason: 'owed' | 'by-hand' | 'authored-fact';
  detail: string;
}

export interface SongPlan {
  song: string;
  title: string;
  tempo_bpm?: number;
  /** The node that owns the tempo (the rig's clock master), when there is one. */
  tempo_node?: string;
  steps: PlanStep[];
  gaps: PlanGap[];
}

export interface PlanOptions {
  /** Set the rig up for this section. Default: the song's first section. */
  section?: string;
  /** Replaces the song's own tempo (a setlist's per-show override). */
  tempo_override?: number;
}

/** "Chorus 2" -> "Chorus": the name a repeated section shares with its first occurrence. */
function repeatBase(section: string): string {
  return section.replace(/\s+\d+$/, '').trim();
}

/**
 * The ordered actions that set the rig up for one song.
 *
 * Order matters and is fixed: recalls first (a recall replaces the working
 * buffer, so anything edited before it would be lost), then scenes, then
 * parameter edits. Within each group the song's own unit order is kept.
 */
export function planSong(rig: Rig, song: Song, options: PlanOptions = {}): SongPlan {
  const nodes = new Map(rig.nodes.map((n) => [n.id, n]));
  const section = options.section ?? song.sections?.[0]?.name;
  const recalls: PlanStep[] = [];
  const scenes: PlanStep[] = [];
  const edits: PlanStep[] = [];
  const gaps: PlanGap[] = [];

  for (const unit of song.units) {
    const status = unit.status ?? 'proposed';
    const node = nodes.get(unit.node);
    const device = node?.server_device_id ?? undefined;
    const label = unit.role ?? unit.kind;
    if (unit.kind === 'channel') {
      gaps.push({ node: unit.node, reason: 'authored-fact', detail: `Listens on channel ${unit.channel}${unit.role ? ` (${unit.role})` : ''}. Set on the device.` });
      continue;
    }
    if (unit.kind === 'emit') {
      const m = unit.message;
      const what = m.type === 'pc' ? `Program Change ${m.value}` : `CC ${m.cc} = ${m.value}`;
      gaps.push({ node: unit.node, reason: 'authored-fact', detail: `Sends ${what} on channel ${m.channel}${unit.to ? ` to ${unit.to}` : ''}. Authored into the device ahead of time.` });
      continue;
    }
    if (status === 'owed') {
      gaps.push({ node: unit.node, reason: 'owed', detail: `${label}: not chosen yet.` });
      continue;
    }
    if (typeof device !== 'string' || device === '') {
      gaps.push({ node: unit.node, reason: 'by-hand', detail: `${label}: this node has no server device, set it by hand.` });
      continue;
    }
    const base = { node: unit.node, device, status, ...(unit.role !== undefined ? { why: unit.role } : {}) };
    switch (unit.kind) {
      case 'recall':
        if (unit.location === undefined) {
          gaps.push({ node: unit.node, reason: 'owed', detail: `${label}: no location recorded.` });
        } else {
          recalls.push({ ...base, tool: 'switch_preset', args: { port: device, location: unit.location }, effect: 'navigate' });
        }
        break;
      case 'section_map': {
        // A repeat ("Chorus 2") often has no location of its own: the device
        // plays the first occurrence again. Reuse that one, as a proposal the
        // player confirms, never as a fact. A section asked for by name that
        // matches nothing is a gap: falling back to the first entry would
        // send the rig to the wrong part of the song without saying so.
        const exact = unit.entries.find((e) => e.section === section);
        const base_name = section !== undefined ? repeatBase(section) : undefined;
        const reused = exact === undefined && base_name !== undefined
          ? unit.entries.find((e) => e.section === base_name || repeatBase(e.section) === base_name)
          : undefined;
        const entry = exact ?? reused ?? (options.section === undefined ? unit.entries[0] : undefined);
        if (unit.container !== undefined) {
          gaps.push({ node: unit.node, reason: 'by-hand', detail: `Load "${unit.container}" on the device first; the locations below are inside it.` });
        }
        if (unit.entries.length === 0) {
          gaps.push({ node: unit.node, reason: 'owed', detail: `${label}: no section entries.` });
        } else if (entry === undefined) {
          gaps.push({ node: unit.node, reason: 'owed', detail: `${label}: no location recorded for "${section}".` });
        } else if (reused !== undefined) {
          recalls.push({
            ...base,
            status: 'proposed',
            tool: 'switch_preset',
            args: { port: device, location: entry.location },
            effect: 'navigate',
            why: `${section} has no location of its own; reusing the one for ${entry.section}. Confirm it is the same part.`,
          });
        } else {
          recalls.push({ ...base, tool: 'switch_preset', args: { port: device, location: entry.location }, effect: 'navigate', why: `${entry.section}${unit.role ? `: ${unit.role}` : ''}` });
        }
        break;
      }
      case 'scene':
        if (unit.section === undefined || unit.section === section) {
          scenes.push({ ...base, tool: 'switch_scene', args: { port: device, scene: unit.scene }, effect: 'navigate' });
        }
        break;
      case 'param':
        edits.push({
          ...base,
          tool: 'set_param',
          args: { port: device, block: unit.block, name: unit.name, value: unit.value, ...(unit.channel !== undefined ? { channel: unit.channel } : {}) },
          effect: 'edit',
        });
        break;
    }
  }

  const tempo = options.tempo_override ?? song.tempo_bpm;
  const master = rig.nodes.find((n) => n.roles.includes('clock_master'));
  return {
    song: song.id,
    title: song.title,
    ...(tempo !== undefined ? { tempo_bpm: tempo } : {}),
    ...(tempo !== undefined && master !== undefined ? { tempo_node: master.id } : {}),
    steps: [...recalls, ...scenes, ...edits],
    gaps,
  };
}

/** One plan per setlist position, in play order. Unknown songs are skipped; validate first. */
export function planPerformance(rig: Rig, repertoire: Repertoire, performance: Performance): SongPlan[] {
  const byId = new Map(repertoire.songs.map((s) => [s.id, s]));
  const plans: SongPlan[] = [];
  for (const entry of performance.songs) {
    const song = byId.get(entry.ref);
    if (song === undefined) continue;
    plans.push(planSong(rig, song, entry.tempo_override !== undefined ? { tempo_override: entry.tempo_override } : {}));
  }
  return plans;
}
