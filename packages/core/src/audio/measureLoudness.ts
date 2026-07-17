/**
 * `measure_loudness` executor (BK-105 phase 1): capture N seconds from an
 * OS audio input and return BS.1770 loudness. Read-only, no MIDI I/O, not
 * device-gated: any input the OS exposes works (a Fractal unit's USB audio
 * interface, a mic on an amp, a mixer bus), which is what makes this a rig
 * capability instead of a device feature.
 *
 * Agent-as-UX contract: called without `input_device` it returns the input
 * roster and asks; it never guesses a device. Corrections stay in the
 * existing write path (e.g. AM4 `preset.scene_N_level`) behind the existing
 * gates; this tool only ever listens.
 */

import { measureBs1770 } from './bs1770.js';
import { captureAudio, listAudioInputs, type AudioInputDevice } from './capture.js';

export interface MeasureLoudnessArgs {
  input_device?: string;
  seconds?: number;
  channels?: 'stereo' | 'left' | 'right';
  first_channel?: number;
}

export interface MeasureLoudnessDeviceList {
  devices: AudioInputDevice[];
  note: string;
}

export interface MeasureLoudnessResult {
  /** Integrated (gated) loudness, LUFS. null = no signal above the -70 LUFS gate. */
  lufs_integrated: number | null;
  /** Loudest 400 ms momentary block, LUFS. */
  lufs_momentary_max: number | null;
  /** True peak (4x oversampled), dBTP. null = digital silence. */
  true_peak_dbtp: number | null;
  duration_s: number;
  device: string;
  sample_rate: number;
  channels_measured: 'stereo' | 'left' | 'right' | 'mono';
  quality_flags: string[];
  note?: string;
}

const DEFAULT_SECONDS = 8;
const MAX_SECONDS = 30;
const TOO_QUIET_LUFS = -50;
const MIN_GATED_BLOCKS = 10; // < ~1.3 s of gated signal

const round1 = (x: number): number => Math.round(x * 10) / 10;
const dbOrNull = (x: number): number | null => (Number.isFinite(x) ? round1(x) : null);

function deviceList(devices: AudioInputDevice[], note: string): MeasureLoudnessDeviceList {
  return { devices, note };
}

export async function executeMeasureLoudness(
  args: MeasureLoudnessArgs,
): Promise<MeasureLoudnessDeviceList | MeasureLoudnessResult> {
  const inputs = await listAudioInputs();

  if (args.input_device === undefined) {
    return deviceList(
      inputs,
      'No input_device given. Ask the user which input to measure (match by substring), then call again. ' +
        'A modeler connected over USB usually appears under its own name.',
    );
  }

  const needle = args.input_device.toLowerCase();
  const matches = inputs.filter((d) => d.name.toLowerCase().includes(needle));
  const exact = inputs.filter((d) => d.name.toLowerCase() === needle);
  const chosen = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
  if (chosen === undefined) {
    return deviceList(
      matches.length > 1 ? matches : inputs,
      matches.length > 1
        ? `input_device "${args.input_device}" matches ${matches.length} inputs; narrow the substring.`
        : `input_device "${args.input_device}" matches no input; pick from the list.`,
    );
  }

  const seconds = Math.min(Math.max(args.seconds ?? DEFAULT_SECONDS, 1), MAX_SECONDS);
  const mode = args.channels ?? 'stereo';
  const firstChannel = args.first_channel ?? 0;

  const capture = await captureAudio({
    deviceId: chosen.id,
    seconds,
    channelCount: 2,
    firstChannel,
  });

  const captured = capture.channels;
  let measured: readonly Float64Array[];
  let channelsMeasured: MeasureLoudnessResult['channels_measured'];
  let monoNote: string | undefined;
  if (captured.length === 1) {
    measured = captured;
    channelsMeasured = 'mono';
  } else if (mode === 'left') {
    measured = [captured[0]];
    channelsMeasured = 'left';
  } else if (mode === 'right') {
    measured = [captured[1]];
    channelsMeasured = 'right';
  } else {
    measured = captured;
    channelsMeasured = 'stereo';
  }
  if (channelsMeasured !== 'stereo') {
    monoNote =
      'Single-channel measurement: absolute LUFS reads ~3 LU lower than the same ' +
      'signal on stereo L+R (BS.1770 mono convention). Scene-to-scene deltas are unaffected.';
  }

  const m = measureBs1770(measured, capture.sampleRate);

  const flags: string[] = [];
  if (m.lufsIntegrated === null) flags.push('no-signal');
  else if (m.lufsIntegrated < TOO_QUIET_LUFS) flags.push('too-quiet');
  if (m.samplePeakDbfs > -0.1 || m.truePeakDbtp > 0) flags.push('clipped');
  if (m.lufsIntegrated !== null && m.gatedBlockCount < MIN_GATED_BLOCKS) {
    flags.push('short-gated-signal');
  }
  if (capture.durationSeconds < seconds - 0.5) flags.push('short-capture');

  return {
    lufs_integrated: m.lufsIntegrated === null ? null : round1(m.lufsIntegrated),
    lufs_momentary_max: m.lufsMomentaryMax === null ? null : round1(m.lufsMomentaryMax),
    true_peak_dbtp: dbOrNull(m.truePeakDbtp),
    duration_s: Math.round(capture.durationSeconds * 100) / 100,
    device: capture.deviceName,
    sample_rate: capture.sampleRate,
    channels_measured: channelsMeasured,
    quality_flags: flags,
    ...(monoNote === undefined ? {} : { note: monoNote }),
  };
}
