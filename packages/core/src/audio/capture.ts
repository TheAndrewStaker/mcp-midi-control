/**
 * OS audio-input capture for loudness measurement, via `audify` (RtAudio
 * over N-API: WASAPI on Windows, CoreAudio on Mac, ALSA on Linux).
 *
 * audify is an OPTIONAL dependency loaded lazily at call time:
 *  - a platform without a matching prebuild still installs and runs the
 *    whole MIDI surface; only this module reports "capture unavailable",
 *  - the native module is never touched at server startup (same lazy
 *    pattern as the serial transport), so a broken audio backend cannot
 *    take the MCP server down.
 *
 * No audify types are imported: the structural interfaces below decouple
 * the TypeScript build from the optional dependency's presence.
 */

/** Minimal structural view of audify's RtAudio device info. */
interface RtDeviceInfo {
  id: number;
  name: string;
  inputChannels: number;
  outputChannels: number;
  isDefaultInput: boolean;
  sampleRates: number[];
  preferredSampleRate: number;
}

interface RtAudioLike {
  getDevices(): RtDeviceInfo[];
  openStream(
    output: unknown,
    input: { deviceId: number; nChannels: number; firstChannel: number },
    format: number,
    sampleRate: number,
    frameSize: number,
    streamName: string,
    inputCallback: (pcm: Buffer) => void,
    frameOutputCallback: null,
  ): void;
  start(): void;
  stop(): void;
  closeStream(): void;
  isStreamOpen(): boolean;
}

interface AudifyModule {
  RtAudio: new (api?: number) => RtAudioLike;
  RtAudioFormat: { RTAUDIO_FLOAT32: number };
  RtAudioApi: Record<string, number>;
}

export interface AudioInputDevice {
  id: number;
  name: string;
  input_channels: number;
  is_default: boolean;
  preferred_sample_rate: number;
}

export interface CaptureResult {
  /** Deinterleaved capture, one Float64Array per captured channel. */
  channels: Float64Array[];
  sampleRate: number;
  deviceName: string;
  /** Actual captured duration (may fall short if the stream stalled). */
  durationSeconds: number;
}

const CAPTURE_FRAME_SIZE = 480; // 10 ms at 48 kHz
const PREFERRED_SAMPLE_RATE = 48000;

let audifyPromise: Promise<AudifyModule> | undefined;

// Variable specifier on purpose: a literal import('audify') would make tsc
// resolve the optional dependency's types at build time, breaking source
// builds on platforms where the optional install was skipped.
const AUDIFY_SPECIFIER = 'audify';

/** Lazy-load audify once; a load failure is remembered as a rejected promise. */
async function loadAudify(): Promise<AudifyModule> {
  if (audifyPromise === undefined) {
    audifyPromise = import(AUDIFY_SPECIFIER).then(
      (m: { default?: unknown }) => {
        // CJS interop: audify is CommonJS, so dynamic import may deliver
        // the real exports under `.default` (depends on lexer detection).
        const mod = (m.default ?? m) as AudifyModule;
        if (typeof mod.RtAudio !== 'function') {
          throw new Error('audify loaded but exposes no RtAudio constructor');
        }
        return mod;
      },
      (err: unknown) => {
        audifyPromise = undefined; // allow retry after e.g. an npm rebuild
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          'Audio capture engine (audify/RtAudio) failed to load on this platform. ' +
            'Loudness measurement is unavailable; MIDI tools are unaffected. ' +
            `Underlying error: ${detail}`,
        );
      },
    );
  }
  return audifyPromise;
}

/**
 * Pick the shared-mode OS backend explicitly. RtAudio's default on Windows
 * probes ASIO first, which spews per-driver errors for every installed but
 * disconnected interface and takes exclusive device access; WASAPI shared
 * mode is the design-note choice (BK-105). Falls back to RtAudio's own
 * default when the platform isn't matched.
 */
function pickApi(audify: AudifyModule): number | undefined {
  const name =
    process.platform === 'win32' ? 'WINDOWS_WASAPI'
    : process.platform === 'darwin' ? 'MACOSX_CORE'
    : process.platform === 'linux' ? 'LINUX_ALSA'
    : undefined;
  return name === undefined ? undefined : audify.RtAudioApi[name];
}

// ONE RtAudio instance for the process lifetime. A live RtAudio handle
// keeps the Node event loop referenced even after closeStream() (verified
// on Windows/WASAPI 2026-07-15), so constructing one per call would leak a
// native handle per measurement in the long-lived MCP server. The
// singleton bounds that to one, at the cost of one-capture-at-a-time
// (enforced below, and the right behavior for a conversation anyway).
let rtSingleton: RtAudioLike | undefined;
let captureInFlight = false;

function getRtAudio(audify: AudifyModule): RtAudioLike {
  if (rtSingleton === undefined) {
    const api = pickApi(audify);
    rtSingleton = api === undefined ? new audify.RtAudio() : new audify.RtAudio(api);
  }
  return rtSingleton;
}

/** Enumerate OS audio INPUT devices (inputChannels > 0). */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  const audify = await loadAudify();
  const rt = getRtAudio(audify);
  const devices = rt.getDevices();
  return devices
    .filter((d) => d.inputChannels > 0)
    .map((d) => ({
      id: d.id,
      name: d.name,
      input_channels: d.inputChannels,
      is_default: d.isDefaultInput,
      preferred_sample_rate: d.preferredSampleRate,
    }));
}

export interface CaptureOptions {
  deviceId: number;
  seconds: number;
  /** Channels to capture (1 or 2). Clamped to the device's input count. */
  channelCount: number;
  /** First input channel (0-based); lets a 4-in interface (AM4) expose pairs beyond 0/1. */
  firstChannel: number;
}

/**
 * Capture N seconds of float32 PCM from one input device.
 *
 * The stream is watchdog-guarded: if the device delivers nothing for 5 s
 * beyond the expected duration, capture resolves with what arrived instead
 * of hanging the tool call (the MIDI-port lesson: never block forever on a
 * stalled native queue).
 */
export async function captureAudio(opts: CaptureOptions): Promise<CaptureResult> {
  const audify = await loadAudify();
  const { RtAudioFormat } = audify;
  const rt = getRtAudio(audify);
  if (captureInFlight) {
    throw new Error('An audio capture is already in progress; wait for it to finish.');
  }
  const device = rt.getDevices().find((d) => d.id === opts.deviceId);
  if (device === undefined) {
    throw new Error(`Audio input device id ${opts.deviceId} not found (it may have been unplugged).`);
  }
  if (device.inputChannels < 1) {
    throw new Error(`Device "${device.name}" has no input channels.`);
  }

  const nChannels = Math.min(Math.max(1, opts.channelCount), device.inputChannels - opts.firstChannel);
  if (nChannels < 1) {
    throw new Error(
      `first_channel ${opts.firstChannel} is out of range: "${device.name}" has ${device.inputChannels} input channel(s).`,
    );
  }
  const sampleRate = device.sampleRates.includes(PREFERRED_SAMPLE_RATE)
    ? PREFERRED_SAMPLE_RATE
    : device.preferredSampleRate;

  const targetSamples = Math.round(opts.seconds * sampleRate);
  const chunks: Buffer[] = [];
  let samplesSeen = 0; // per channel

  return new Promise<CaptureResult>((resolve, reject) => {
    let settled = false;
    let watchdog: NodeJS.Timeout;

    const finish = () => {
      if (settled) return;
      settled = true;
      captureInFlight = false;
      clearTimeout(watchdog);
      try {
        rt.stop();
        rt.closeStream();
      } catch {
        // closing a wedged stream must not mask the captured data
      }
      const interleaved = Buffer.concat(chunks);
      const frameCount = Math.min(
        targetSamples,
        Math.floor(interleaved.length / 4 / nChannels),
      );
      const channels: Float64Array[] = Array.from(
        { length: nChannels },
        () => new Float64Array(frameCount),
      );
      for (let i = 0; i < frameCount; i++) {
        for (let c = 0; c < nChannels; c++) {
          channels[c][i] = interleaved.readFloatLE((i * nChannels + c) * 4);
        }
      }
      resolve({
        channels,
        sampleRate,
        deviceName: device.name,
        durationSeconds: frameCount / sampleRate,
      });
    };

    // Expected duration + 5 s grace; fires only if the device stalls.
    watchdog = setTimeout(finish, opts.seconds * 1000 + 5000);

    captureInFlight = true;
    try {
      rt.openStream(
        null,
        { deviceId: device.id, nChannels, firstChannel: opts.firstChannel },
        RtAudioFormat.RTAUDIO_FLOAT32,
        sampleRate,
        CAPTURE_FRAME_SIZE,
        'mcp-midi-control loudness capture',
        (pcm: Buffer) => {
          if (settled) return;
          chunks.push(Buffer.from(pcm)); // copy: RtAudio reuses its buffer
          samplesSeen += pcm.length / 4 / nChannels;
          if (samplesSeen >= targetSamples) finish();
        },
        null,
      );
      rt.start();
    } catch (err) {
      settled = true;
      captureInFlight = false;
      clearTimeout(watchdog);
      try {
        if (rt.isStreamOpen()) rt.closeStream();
      } catch {
        // already failing; surface the original error
      }
      reject(
        err instanceof Error
          ? new Error(`Failed to open audio input "${device.name}": ${err.message}`)
          : err,
      );
    }
  });
}
