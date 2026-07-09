/**
 * Realizer C, NCS offline authoring + SysEx upload (PHASE C, STUB).
 *
 * The maintainer's real "prep a gig" vision: author a NAMED Circuit Tracks
 * project (.ncs) offline, full step data, p-locks, scenes, patches, and
 * push it over the (community-reverse-engineered) Components WebMIDI SysEx
 * transfer, which the device gates with a CRC32 it validates itself. Then
 * whole-project recall over MIDI (PGM ch16) becomes "switch between named
 * beats."
 *
 * NOT YET BUILT. It needs a clean-room TypeScript reimplementation of the
 * .ncs codec + the CRC32-gated transfer (reference: namirsab/circuit-tracks-
 * tools, MIT). The neutral pattern model (Step velocity/accent/probability,
 * named voices, bars) is deliberately rich enough to compile into .ncs
 * without rework when this lands. No device lists 'ncs_upload' in its
 * pattern_realizers until then, so this path is never selected; the stub
 * exists to mark the contract and fail loudly if reached.
 *
 * Planned shape (phase C):
 *   compilePatternToNcs(project: NeutralPattern[]): Uint8Array  // CRC32-gated
 *   transferNcs(ctx, bytes): Promise<RealizeResult>             // Components SysEx
 */

import type { RealizePlan, RealizeResult } from '../../types.js';
import { PatternError } from '../types.js';

export async function realizeNcsUpload(_plan: RealizePlan): Promise<RealizeResult> {
  throw new PatternError(
    'not_implemented',
    'NCS offline authoring + upload is phase C (not yet implemented). ' +
    'To play a beat today, call apply_pattern with one of the target\'s advertised ' +
    'realizers (see list_pattern_recipes target.realizers).',
  );
}
