/**
 * OpenRig AUDIO-OUTPUT check: the easy, high-value "will I actually hear this
 * instrument?" verification. Pure, no hardware, no capability data (same shape
 * as the MIDI cycle check in validate.ts).
 *
 * For each sound-producing instrument, does its audio reach the rig's output
 * stage (a monitor / front-of-house node), following ENABLED audio edges through
 * whatever mixers / effects / loopers / interfaces sit in between? An intermediate
 * node is treated as audio-transparent (its inputs feed its outputs), which is how
 * audio actually flows through a mixer or looper.
 *
 * Deliberately SIMPLE (the maintainer's call, 2026-07-12: looper track-arming and
 * record-isolation are overkill for a first pass). It answers only: is the
 * instrument's audio patched, and does it reach an output. NOT: which looper track
 * records it, nor whether it can be looped independently of another source. Those
 * are deferred.
 */
import type { Rig } from './types.js';

export type AudioOutputStatus = 'reaches_output' | 'no_output' | 'dead_end';

export interface InstrumentAudio {
  id: string;
  name: string;
  status: AudioOutputStatus;
}

export interface AudioIssue {
  severity: 'warning';
  code: 'instrument-no-audio-output' | 'instrument-audio-dead-end';
  message: string;
  ref: string;
}

export interface AudioOutputReport {
  /** True when every checked instrument's audio reaches an output/monitor node. */
  ok: boolean;
  /** Per-instrument audio-output status (sound sources + samplers with an audio out). */
  instruments: InstrumentAudio[];
  /** Advisory issues: an instrument that will not be heard (warnings, never errors). */
  issues: AudioIssue[];
  /**
   * False when the rig declares no monitor / output node, so reachability cannot
   * be judged (the dead-end check is then skipped and instruments with any audio
   * out read as reaches_output). The consumer should add an OUT / front-of-house
   * node to make the check meaningful.
   */
  has_output_node: boolean;
}

/** Roles that produce sound and therefore should reach the output. */
const SOUND_ROLES = new Set(['sound_source', 'sampler']);

/**
 * Check that every sound-producing instrument's audio reaches the rig's output.
 * Pure. Follows only ENABLED audio edges, so an `enabled:false` (parked / not
 * patched) cable does not count, and toggling a wiring option flips the result.
 */
export function checkAudioOutput(rig: Rig): AudioOutputReport {
  // node -> nodes reachable via one enabled audio edge. Intermediate nodes are
  // audio-transparent (inputs feed outputs), which is how a mixer/looper passes
  // audio, so plain node-level reachability over audio edges is correct.
  const adj = new Map<string, Set<string>>();
  for (const e of rig.edges) {
    if (e.enabled === false) continue;
    if (e.signal.kind !== 'audio') continue;
    if (e.from.node === e.to.node) continue;
    let set = adj.get(e.from.node);
    if (set === undefined) { set = new Set(); adj.set(e.from.node, set); }
    set.add(e.to.node);
  }
  const monitors = new Set(rig.nodes.filter((n) => n.roles.includes('monitor')).map((n) => n.id));
  const hasOutputNode = monitors.size > 0;

  const reachesMonitor = (start: string): boolean => {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (monitors.has(n)) return true;
      for (const m of adj.get(n) ?? []) {
        if (!seen.has(m)) { seen.add(m); stack.push(m); }
      }
    }
    return false;
  };

  const instruments: InstrumentAudio[] = [];
  const issues: AudioIssue[] = [];
  for (const node of rig.nodes) {
    const isInstrument = node.roles.some((r) => SOUND_ROLES.has(r));
    if (!isInstrument) continue;
    const hasAudioOut = node.ports.some((p) => p.kind === 'audio_out');
    if (!hasAudioOut) continue; // a MIDI-only instrument: nothing to route to output

    let status: AudioOutputStatus;
    if (monitors.has(node.id)) {
      // The instrument IS its own output (a workstation with built-in speakers
      // roled sound_source + monitor); its sound is heard through itself, so an
      // uncabled audio out is not "unheard".
      status = 'reaches_output';
    } else if ((adj.get(node.id)?.size ?? 0) === 0) {
      status = 'no_output';
      issues.push({
        severity: 'warning', code: 'instrument-no-audio-output', ref: node.id,
        message: `${node.name} makes sound but no audio cable leaves it, so it will not be heard. Patch its audio output toward the rig's output (a mixer / looper / interface that reaches front-of-house).`,
      });
    } else if (hasOutputNode && !reachesMonitor(node.id)) {
      status = 'dead_end';
      issues.push({
        severity: 'warning', code: 'instrument-audio-dead-end', ref: node.id,
        message: `${node.name}'s audio is patched but the chain does not reach any output / monitor node; it dead-ends before front-of-house. Follow its audio path and connect it through to the output.`,
      });
    } else {
      status = 'reaches_output';
    }
    instruments.push({ id: node.id, name: node.name, status });
  }

  return { ok: issues.length === 0, instruments, issues, has_output_node: hasOutputNode };
}
