// verify-am4-getpreset-channel-stride.ts
//
// Gated test: AM4 get_preset channel-stride projection (READ path), fully
// offline. Covers the channel-blocked fn 0x1F decode shipped 2026-06-04.
//
// The AM4 fn 0x1F `0x75` body is CHANNEL-BLOCKED x4: four contiguous copies
// of every paramId slot, one per channel, FIXED order A/B/C/D, so
//   value index = channel * stride + pidHigh,  stride = itemCount / 4.
// get_preset(include_channel_state:true) reads all four channels from the
// SINGLE dump (no per-param fn 0x02 loop, no channel-state mutation). This
// test drives the SHIPPED AM4 reader against a fake connection whose fn 0x1F
// dump carries DISTINCT per-channel quarters for a channel-bearing block
// (Reverb) and asserts each channel reads its own quarter.
//
// It also covers:
//   - default get_preset → only the ACTIVE channel's quarter (channel
//     selector reads B; the slot must return B's quarter, NOT channel A;
//     the pre-fix bug returned quarter 0 mislabelled as the active channel).
//   - the amp channel-selector float32-packed-enum fallback in getParam
//     (amp's selector register reads back a non-index u32; the float fallback
//     decodes a float32-packed channel index to its A/B/C/D letter).
//
// Run: npx tsx scripts/verify-am4-getpreset-channel-stride.ts
// Status: offline, no hardware. Exits 0 on pass, non-zero on any failure.

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import type { DispatchCtx, PresetSnapshot } from '@mcp-midi-control/core/protocol-generic/types.js';
import {
  BLOCK_NAMES_BY_VALUE,
  BLOCK_SLOT_PID_HIGH_BASE,
  BLOCK_SLOT_PID_LOW,
  KNOWN_PARAMS,
  decode as am4Decode,
  roundDisplayValue,
  type Param,
} from 'fractal-midi/am4';
import { fractalChecksum, packValue } from 'fractal-midi/shared';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   -- ${label}`);
  } else {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

// ── AM4 wire constants (mirror the reader) ───────────────────────────────
const F0 = 0xf0;
const F7 = 0xf7;
const AM4_MODEL = 0x15;
const SCENE_PID_LOW = 0x00ce;
const SCENE_PID_HIGH = 0x000d;
const REVERB_PIDLOW = 0x0042; // effectId of the reverb chunk
const CHANNEL_PID_HIGH = 0x07d2; // <block>.channel selector

function dec14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}
function enc14(n: number): [number, number] {
  return [n & 0x7f, (n >> 7) & 0x7f];
}
function pack16(v: number): [number, number, number] {
  return [v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x03];
}
/** Frame a device-emitted message: F0 00 01 74 15 <payload> <cs> F7. */
function amFrame(payloadAfterModel: number[]): number[] {
  const full = [F0, 0x00, 0x01, 0x74, AM4_MODEL, ...payloadAfterModel];
  return [...full, fractalChecksum(full), F7];
}
/** Short-read (action 0x0E) response echoing the request, value = u32 LE. */
function shortReadResp(req: number[], rawValue: Uint8Array): number[] {
  const resp = [...req.slice(0, 12), 0x00, 0x00, 0x04, 0x00, ...Array.from(packValue(rawValue))];
  const cs = fractalChecksum(resp); // over F0..last payload (21 bytes)
  return [...resp, cs, F7];
}
function u32le(value: number): Uint8Array {
  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setUint32(0, value >>> 0, true);
  return raw;
}
/** Long-read (action 0x0D) bypass response, 64 bytes, byte 22 = bypass flag. */
function longReadResp(req: number[], bypassed: boolean): number[] {
  const resp = new Array<number>(64).fill(0x00);
  for (let i = 0; i < 12; i++) resp[i] = req[i];
  resp[12] = 0x00; resp[13] = 0x00;
  resp[14] = 0x28; resp[15] = 0x00; // hdr4 = 0x0028
  resp[22] = bypassed ? 0x01 : 0x00;
  resp[0] = F0; resp[63] = F7;
  resp[62] = fractalChecksum(resp.slice(0, 62));
  return resp;
}

// ── Reverb param model ────────────────────────────────────────────────────
const reverbParams: Param[] = [];
for (const key of Object.keys(KNOWN_PARAMS)) {
  const p = KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as Param;
  if (p.block === 'reverb') reverbParams.push(p);
}
// stride = device's per-channel param count. Mirror reality: the channel
// selector (pidHigh 0x07d2) sits FAR beyond the dump's stride, so it is not
// part of the channel-blocked body. Compute stride from the in-band params.
const inBandHighs = reverbParams.filter((p) => p.pidHigh < CHANNEL_PID_HIGH).map((p) => p.pidHigh);
const STRIDE = Math.max(...inBandHighs) + 1;
const ITEM_COUNT = STRIDE * 4;

// Distinct wire value per (channel, pidHigh). Bounded to 0..65000.
function wireFor(channel: number, pidHigh: number): number {
  return (1000 + channel * 9001 + pidHigh * 37) % 60000;
}
const dumpValues = new Array<number>(ITEM_COUNT).fill(0);
for (let c = 0; c < 4; c++) {
  for (const p of reverbParams) {
    if (p.pidHigh >= CHANNEL_PID_HIGH) continue; // out-of-band selector
    dumpValues[c * STRIDE + p.pidHigh] = wireFor(c, p.pidHigh);
  }
}

const MIX_OPT = reverbParams.find((p) => p.name === 'mix');
if (MIX_OPT === undefined) { console.error('fixture: reverb.mix not found'); process.exit(1); }
const MIX: Param = MIX_OPT;

function expectedDisplay(p: Param, wire: number): number | string {
  if (p.unit === 'enum') {
    const ev = p.enumValues as Record<number, string> | undefined;
    return ev?.[wire] ?? wire;
  }
  return roundDisplayValue(p, am4Decode(p, wire / 65534));
}

// Which block-slot value decodes to 'reverb'?
const REVERB_BLOCK_VALUE = Number(
  Object.keys(BLOCK_NAMES_BY_VALUE).find((k) => BLOCK_NAMES_BY_VALUE[Number(k)] === 'reverb'),
);
check('fixture: reverb block-slot value resolved', Number.isFinite(REVERB_BLOCK_VALUE), `value=${REVERB_BLOCK_VALUE}`);

// ── Fake AM4 connection ───────────────────────────────────────────────────
// activeChannelWire selects what the channel-selector short read returns.
function makeFakeConn(activeChannelWire: number): MidiConnection {
  const handlers = new Set<(bytes: number[]) => void>();

  function dispatch(frames: number[][]): void {
    if (frames.length === 0) return;
    setImmediate(() => {
      for (const f of frames) for (const h of [...handlers]) { try { h(f); } catch { /* swallow */ } }
    });
  }

  function responsesFor(out: number[]): number[][] {
    if (out[0] !== F0 || out[3] !== 0x74 || out[4] !== AM4_MODEL) return [];
    const fn = out[5];

    // fn 0x1F GET_ALL_PARAMS → channel-blocked triple for the reverb chunk.
    if (fn === 0x1f) {
      const effectId = dec14(out[6], out[7]);
      if (effectId !== REVERB_PIDLOW) return []; // other blocks NACK (timeout)
      const header = amFrame([0x74, ...enc14(effectId), ...enc14(ITEM_COUNT)]);
      const packed: number[] = [];
      for (const v of dumpValues) packed.push(...pack16(v));
      const chunk = amFrame([0x75, ...enc14(ITEM_COUNT), ...packed]);
      const footer = amFrame([0x76]);
      return [header, chunk, footer];
    }

    if (fn === 0x01) {
      const pidLow = dec14(out[6], out[7]);
      const pidHigh = dec14(out[8], out[9]);
      const action = dec14(out[10], out[11]);

      // Long read (bypass), action 0x0D.
      if (action === 0x0d) return [longReadResp(out, false)];

      // Block-layout slot reads.
      if (pidLow === BLOCK_SLOT_PID_LOW && pidHigh >= BLOCK_SLOT_PID_HIGH_BASE && pidHigh < BLOCK_SLOT_PID_HIGH_BASE + 4) {
        const slotIdx = pidHigh - BLOCK_SLOT_PID_HIGH_BASE;
        const value = slotIdx === 0 ? REVERB_BLOCK_VALUE : 0x0fffff; // slot 1 reverb, rest empty
        return [shortReadResp(out, u32le(value))];
      }

      // Channel selector.
      if (pidHigh === CHANNEL_PID_HIGH) {
        return [shortReadResp(out, u32le(activeChannelWire))];
      }

      // Scene-state register.
      if (pidLow === SCENE_PID_LOW && pidHigh === SCENE_PID_HIGH) {
        return [shortReadResp(out, u32le(0))]; // scene 1
      }

      // Any other short read → return 0 (keeps reads from timing out).
      return [shortReadResp(out, u32le(0))];
    }

    return [];
  }

  const conn: MidiConnection = {
    send: (bytes) => dispatch(responsesFor(bytes)),
    receiveSysEx: () => Promise.reject(new Error('receiveSysEx not used')),
    receiveSysExMatching: (predicate, timeoutMs = 800) =>
      new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          handlers.delete(handler);
          reject(new Error(`fake AM4 transport: no response within ${timeoutMs}ms`));
        }, timeoutMs);
        const handler = (b: number[]) => {
          if (b[0] !== F0 || !predicate(b)) return;
          clearTimeout(timer);
          handlers.delete(handler);
          resolve(b);
        };
        handlers.add(handler);
      }),
    onMessage: (handler) => { handlers.add(handler); return () => { handlers.delete(handler); }; },
    hasInput: true,
    close: () => { handlers.clear(); },
  };
  return conn;
}

function reportAndExit(): void {
  if (failures === 0) {
    console.log('\nverify-am4-getpreset-channel-stride: all assertions passed.');
    process.exit(0);
  }
  console.error(`\nverify-am4-getpreset-channel-stride: ${failures} failure(s).`);
  process.exit(1);
}

const reader = AM4_DESCRIPTOR.reader;
check('reader implements getPreset', typeof reader.getPreset === 'function');
check('reader implements getParam', typeof reader.getParam === 'function');

async function main(): Promise<void> {
  if (reader.getPreset === undefined || reader.getParam === undefined) { reportAndExit(); return; }

  // 1. include_channel_state:true → all four channels, each its own quarter.
  {
    const ctx: DispatchCtx = { conn: makeFakeConn(1 /* B active */), descriptor: AM4_DESCRIPTOR };
    let snap: PresetSnapshot | undefined;
    try { snap = await reader.getPreset(ctx, { include_channel_state: true }); }
    catch (err) { check('all-channels get_preset resolves', false, err instanceof Error ? err.message : String(err)); }
    if (snap !== undefined) {
      check('all-channels get_preset resolves', true);
      const slot = snap.slots.find((s) => s.block_type === 'reverb');
      check('all-channels: reverb slot present', slot !== undefined, `slots=${JSON.stringify(snap.slots.map((s) => s.block_type))}`);
      const pbc = slot?.params_by_channel;
      check("all-channels: channel_status === 'all_channels'", slot?.channel_status === 'all_channels', `status=${slot?.channel_status}`);
      check('all-channels: params_by_channel has A,B,C,D', !!pbc && ['A', 'B', 'C', 'D'].every((c) => pbc[c] !== undefined), `keys=${pbc ? Object.keys(pbc).join(',') : 'undefined'}`);
      if (pbc) {
        const mixes = ['A', 'B', 'C', 'D'].map((c) => pbc[c]?.mix);
        check('all-channels: reverb.mix distinct across A/B/C/D (each reads its own quarter)', new Set(mixes).size === 4, `mixes=${JSON.stringify(mixes)}`);
        let allMatch = true;
        for (let c = 0; c < 4; c++) {
          const expect = expectedDisplay(MIX, wireFor(c, MIX.pidHigh));
          if (pbc[['A', 'B', 'C', 'D'][c]]?.mix !== expect) allMatch = false;
        }
        check('all-channels: each quarter decodes to the expected wire value', allMatch, `mixes=${JSON.stringify(mixes)}`);
      }
    }
  }

  // 2. default (no options) → ALL FOUR channels, same as include_channel_state
  //    (BUG-1, 2026-07-04): the default no longer trusts the unreliable amp
  //    channel-selector to name one "active" channel. The channel-blocked dump
  //    holds every channel for free, so all four are returned and the active
  //    one is derivable from active_scene + a live get_param.
  {
    const ctx: DispatchCtx = { conn: makeFakeConn(1 /* B active — now irrelevant to getPreset */), descriptor: AM4_DESCRIPTOR };
    let snap: PresetSnapshot | undefined;
    try { snap = await reader.getPreset(ctx); }
    catch (err) { check('default get_preset resolves', false, err instanceof Error ? err.message : String(err)); }
    if (snap !== undefined) {
      check('default get_preset resolves', true);
      const slot = snap.slots.find((s) => s.block_type === 'reverb');
      const pbc = slot?.params_by_channel;
      check("default: channel_status === 'all_channels'", slot?.channel_status === 'all_channels', `status=${slot?.channel_status}`);
      check('default: params_by_channel has A/B/C/D', !!pbc && ['A', 'B', 'C', 'D'].every((k) => pbc[k] !== undefined), `keys=${pbc ? Object.keys(pbc).join(',') : 'undefined'}`);
      if (pbc !== undefined) {
        let allMatch = true;
        for (let c = 0; c < 4; c++) {
          if (pbc[['A', 'B', 'C', 'D'][c]]?.mix !== expectedDisplay(MIX, wireFor(c, MIX.pidHigh))) allMatch = false;
        }
        check('default: each quarter decodes to the expected wire value (no active-only truncation)', allMatch);
      }
    }
  }

  // 3. amp channel-selector float32-packed-enum fallback (getParam, task 3).
  //    The amp selector reads back a value that is NOT a clean 0..3 index;
  //    when it is a float32-packed enum, the fallback decodes it to a letter.
  {
    const ampChannel = KNOWN_PARAMS['amp.channel' as keyof typeof KNOWN_PARAMS] as Param | undefined;
    check('fixture: amp.channel registered', ampChannel !== undefined);
    if (ampChannel !== undefined) {
      // Fake conn whose amp.channel short read returns float32(2.0) (= 'C').
      const f32 = new Uint8Array(4);
      new DataView(f32.buffer).setFloat32(0, 2.0, true);
      const handlers = new Set<(b: number[]) => void>();
      const conn = {
        send: (bytes: number[]) => {
          if (bytes[5] !== 0x01) return;
          const pidHigh = dec14(bytes[8], bytes[9]);
          if (pidHigh !== CHANNEL_PID_HIGH) return;
          const resp = shortReadResp(bytes, f32);
          setImmediate(() => { for (const h of [...handlers]) { try { h(resp); } catch { /* */ } } });
        },
        receiveSysEx: () => Promise.reject(new Error('unused')),
        receiveSysExMatching: (predicate: (b: number[]) => boolean, timeoutMs = 800) =>
          new Promise<number[]>((resolve, reject) => {
            const timer = setTimeout(() => { handlers.delete(handler); reject(new Error('amp fake timeout')); }, timeoutMs);
            const handler = (b: number[]) => { if (b[0] !== F0 || !predicate(b)) return; clearTimeout(timer); handlers.delete(handler); resolve(b); };
            handlers.add(handler);
          }),
        onMessage: (h: (b: number[]) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
        hasInput: true,
        close: () => handlers.clear(),
      } as unknown as MidiConnection;
      const ctx: DispatchCtx = { conn, descriptor: AM4_DESCRIPTOR };
      try {
        const res = await reader.getParam(ctx, 'amp', 'channel');
        check('amp.channel float32-packed fallback decodes to a letter', res.display_value === 'C', `display=${JSON.stringify(res.display_value)} (expected 'C' from float32(2.0))`);
      } catch (err) {
        check('amp.channel float32-packed fallback decodes to a letter', false, err instanceof Error ? err.message : String(err));
      }
    }
  }

  reportAndExit();
}

void main();
