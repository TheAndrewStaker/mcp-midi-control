/**
 * Realizer selection + shared dispatch.
 *
 * `selectRealizer` is the capability gate (mirrors how switch_scene is
 * gated on `has_scenes`): the requested mode must be in the target's
 * `pattern_realizers`; with no request, the first declared mode wins; a
 * target with none is not a pattern target at all.
 *
 * `runSharedRealizer` runs the device-agnostic realizer for a plan's mode.
 * The dispatcher prefers a device's own `writer.realizePattern` when it
 * exists (phase-C / bespoke paths) and falls back here for the
 * live_stream / record_capture modes every device gets for free.
 */

import type { MidiConnection } from '../../../midi/transport.js';
import type { DeviceCapabilities, RealizePlan, RealizeResult, RealizerMode } from '../../types.js';
import { PatternError } from '../types.js';
import { realizeLiveStream } from './liveStream.js';
import { realizeRecordCapture } from './recordCapture.js';
import { realizeNcsUpload } from './ncsUpload.js';

export function selectRealizer(caps: DeviceCapabilities, requested?: RealizerMode): RealizerMode {
  const supported = caps.pattern_realizers ?? [];
  if (supported.length === 0) {
    throw new PatternError('not_a_pattern_target', 'Target device is not a pattern target (no pattern_realizers).');
  }
  if (requested) {
    if (!supported.includes(requested)) {
      throw new PatternError(
        'realizer_not_supported',
        `Target does not support realizer mode "${requested}". Supported: ${supported.join(', ')}.`,
        { requested, supported },
      );
    }
    return requested;
  }
  return supported[0];
}

export async function runSharedRealizer(conn: MidiConnection, plan: RealizePlan): Promise<RealizeResult> {
  switch (plan.mode) {
    case 'live_stream':
      return realizeLiveStream(conn, plan);
    case 'record_capture':
      return realizeRecordCapture(conn, plan);
    case 'ncs_upload':
      return realizeNcsUpload(plan);
    default:
      throw new PatternError('realizer_not_supported', `Unknown realizer mode "${plan.mode as string}".`);
  }
}

export { realizeLiveStream, realizeRecordCapture, realizeNcsUpload };
