/**
 * Gen-3 fn=0x03 REQUEST_PRESET_DUMP over a live connection: collect the
 * 0x77 head + 0x78 body frames + 0x79 tail for a stored preset, or for the
 * EDIT BUFFER (preset number 0x3FFF, `03 7F 7F 00`).
 *
 * Stored reads are wire-confirmed on FM9 fw 11.00 (capture 2026-06-04): host
 * sends `F0 00 01 74 <model> 03 <hi> <lo> 00 <cs> F7`, device replies with one
 * 0x77 (13 B), N x 0x78 (3082 B each; FM9/FM3 8, III 16) and one 0x79 (11 B).
 * The edit-buffer read (0x3FFF) is what fractone (MIT) uses to read back every
 * FM9 load (Fm9StoredPresetReader.ReadAsync(0x3FFF), FM9 fw 12 hardware);
 * untested by us. It is the read-back half of the edit-buffer load
 * (presetDumpSend.ts) and the input to the word compare (presetDumpCompare.ts).
 */
import { buildRequestPresetDump } from 'fractal-midi/gen3/axe-fx-iii';
import { parsePresetDump } from './presetDump.js';
import type { ParsedPresetDump } from './presetDump.js';
import { EDIT_BUFFER_PRESET_NUMBER } from './presetDumpEditBuffer.js';
import type { DumpTransferConnection } from './presetDumpSend.js';

/** fractone allows a dump read 10 s (its transports' preset-dump timeout). */
export const PRESET_DUMP_READ_TIMEOUT_MS = 10_000;
/** Once the head is in, a burst that goes quiet this long is abandoned. */
export const PRESET_DUMP_QUIET_MS = 2_000;
/** Hard ceiling on one whole read, head wait included. */
export const PRESET_DUMP_OVERALL_MS = 20_000;

export interface CollectDumpOptions {
  /** Max silence between dump frames once the head arrived (default 2 s). */
  quietMs?: number;
  /** Hard ceiling on the whole read (default max(20 s, head timeout + 10 s)). */
  overallMs?: number;
}

/**
 * Send fn=0x03 for `presetNum` and collect the dump frames. Subscribes BEFORE
 * sending so the burst cannot outrace the listener. Settles on every path:
 *  - resolves on the 0x79 tail (with at least one 0x78 chunk);
 *  - rejects when no 0x77 head arrives within `timeoutMs`, when the unit
 *    refuses the request (`64 03 <code>`, fail fast instead of waiting), when
 *    the burst goes quiet for `quietMs` after the head, or at `overallMs`.
 * Inbound frames that are not this model's Fractal SysEx (stray broadcasts,
 * other devices, non-SysEx) are IGNORED, never treated as the end of the
 * burst; a Fractal frame that is not a dump frame is ignored too (the 0x64
 * tuner/tempo stream interleaves on gen-3).
 */
export function collectPresetDumpFrames(
  conn: Pick<DumpTransferConnection, 'send' | 'onMessage'>,
  modelByte: number,
  presetNum: number,
  deviceLabel: string,
  timeoutMs: number,
  opts: CollectDumpOptions = {},
): Promise<number[][]> {
  const FN_HEAD = 0x77;
  const FN_BODY = 0x78;
  const FN_TAIL = 0x79;
  const quietMs = opts.quietMs ?? PRESET_DUMP_QUIET_MS;
  const overallMs = opts.overallMs ?? Math.max(PRESET_DUMP_OVERALL_MS, timeoutMs + 10_000);
  const isOurs = (b: readonly number[]): boolean =>
    b.length >= 8 && b[0] === 0xf0 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x74 && b[4] === modelByte
    && b[b.length - 1] === 0xf7;

  return new Promise<number[][]>((resolve, reject) => {
    const frames: number[][] = [];
    let headSeen = false;
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(headTimer);
      clearTimeout(overallTimer);
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      unsubscribe();
      if (err !== undefined) reject(err);
      else if (frames.length < 2 || frames[frames.length - 1][5] !== FN_TAIL) {
        reject(new Error(`stored-preset dump from ${deviceLabel} ended without a fn=0x79 tail`));
      } else resolve(frames);
    };
    const armQuiet = (): void => {
      if (quietTimer !== undefined) clearTimeout(quietTimer);
      quietTimer = setTimeout(
        () => finish(new Error(`stored-preset dump from ${deviceLabel} went silent for ${quietMs} ms after ${frames.length} frame(s)`)),
        quietMs,
      );
    };
    const unsubscribe = conn.onMessage((bytes) => {
      const arr = [...bytes];
      if (!isOurs(arr)) return;
      const fn = arr[5];
      if (!headSeen && fn === 0x64 && arr.length >= 9 && arr[6] === 0x03) {
        finish(new Error(`${deviceLabel} refused the dump request (fn=0x64 echo 0x03, code 0x${arr[7].toString(16)})`));
        return;
      }
      if (fn === FN_HEAD) {
        if (headSeen) return; // unexpected second head; ignore
        headSeen = true;
        clearTimeout(headTimer);
        frames.push(arr);
        armQuiet();
      } else if (headSeen && fn === FN_BODY) {
        frames.push(arr);
        armQuiet();
      } else if (headSeen && fn === FN_TAIL) {
        frames.push(arr);
        if (frames.length < 3) finish(new Error(`stored-preset dump head arrived with no fn=0x78 body frames from ${deviceLabel}`));
        else finish();
      }
      // Anything else (before the head, or a non-dump Fractal frame) is ignored.
    });
    const headTimer = setTimeout(
      () => finish(new Error(`no fn=0x77 stored-preset dump head from ${deviceLabel} within ${timeoutMs}ms`)),
      timeoutMs,
    );
    const overallTimer = setTimeout(
      () => finish(new Error(`stored-preset dump from ${deviceLabel} did not complete within ${overallMs} ms`)),
      overallMs,
    );
    // Send AFTER subscribing.
    conn.send(buildRequestPresetDump(presetNum, modelByte));
  });
}

/** Concatenate collected frames and parse them as one dump of `modelByte`. */
export function parseCollectedDump(frames: readonly number[][], modelByte: number): ParsedPresetDump {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const f of frames) { bytes.set(f, off); off += f.length; }
  return parsePresetDump(bytes, 0, modelByte);
}

/** Read the edit buffer as a 0x77/0x78/0x79 dump (fn=0x03, preset 0x3FFF). */
export async function readEditBufferPresetDump(
  conn: Pick<DumpTransferConnection, 'send' | 'onMessage'>,
  modelByte: number,
  deviceLabel: string,
  timeoutMs = PRESET_DUMP_READ_TIMEOUT_MS,
  opts: CollectDumpOptions = {},
): Promise<ParsedPresetDump> {
  const frames = await collectPresetDumpFrames(conn, modelByte, EDIT_BUFFER_PRESET_NUMBER, deviceLabel, timeoutMs, opts);
  return parseCollectedDump(frames, modelByte);
}
