/**
 * Stateful gen-3 grid unit for offline tests (no MIDI I/O). Models the edit
 * buffer the way the decoded wire describes it: a cell cursor (sub=0x30), block
 * insert at the cursor (sub=0x32, id 0 clears, 1024+n = shunt n), cables
 * (sub=0x35), the live grid reply (sub=0x2E), per-scene bypass / channel
 * (fn 0x0A / 0x0B / 0x0C / 0x13), names (fn 0x0D, sub=0x28 / 0x2B), store
 * (sub=0x26), Program Change preset switches, and the edit-buffer dump load
 * + read (0x77/0x78/0x79, fn=0x03 7F 7F).
 *
 * Fault knobs let a test make the unit drop a block, ignore a cable, refuse
 * a template load, or stay silent on a query.
 */
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import {
  buildSelectCell,
  buildSetGridRouting,
  ROUTING_OP_CONNECT,
  ROUTING_OP_DISCONNECT,
} from 'fractal-midi/gen3/axe-fx-iii';
import { unpackValueChunked } from 'fractal-midi/shared';
import { buildGen3GridLayoutFrame, buildGen3StatusDumpFrame, recomputeGen3Checksum } from '../../packages/fractal-gen3/dist/simResponders.js';
import { parsePresetDump } from '../../packages/fractal-gen3/dist/presetDump.js';
import type { ParsedPresetDump } from '../../packages/fractal-gen3/dist/presetDump.js';
import { buildEditBufferLoadFrames } from '../../packages/fractal-gen3/dist/presetDumpEditBuffer.js';
import { decodeGen3PresetDump } from '../../packages/fractal-gen3/dist/presetBody.js';

export interface SimFaults {
  /** Effect ids whose insert is silently ignored. */
  dropInsert?: Set<number>;
  /** Cable (dst "r,c") silently ignored. */
  dropCableTo?: Set<string>;
  /** 'ok' (default), 'drop' (acks every frame but keeps the old buffer), 'refuse' (64 77 12). */
  templateLoad?: 'ok' | 'drop' | 'refuse';
  /** The unit does not answer fn=0x0D. */
  silentNameQuery?: boolean;
  /** The unit does not answer the grid read. */
  silentGrid?: boolean;
  /** Shunt indices the unit reports in use: an insert of 1024+n answers 0x64 01 02 (no-op). */
  shuntInUse?: Set<number>;
  /** Blocks that come in BYPASSED on every scene when inserted (a unit whose fresh insert is not engaged). */
  freshBypassed?: Set<number>;
  /** Ignore SET_BYPASS on this effect id. */
  ignoreBypassOf?: number;
}

interface Cell { id: number; mask: number }
interface BlockScene { channel: number; bypassed: boolean }

export interface Gen3Sim {
  ctx: DispatchCtx;
  sent: Array<{ t: number; bytes: number[] }>;
  grid: Map<string, Cell>;
  scenes: Array<Map<number, BlockScene>>;
  state: { activeScene: number; presetNumber: number; name: string; sceneNames: string[] };
  stored: Map<number, string>;
  faults: SimFaults;
}

const SYSEX_PREFIX = [0xf0, 0x00, 0x01, 0x74];
const hexKey = (b: readonly number[]): string => b.join(',');

export function createGen3Sim(opts: {
  modelByte: number;
  rows: number;
  cols: number;
  sceneCount?: number;
  presetNumber?: number;
  name?: string;
  stored?: Record<number, string>;
  /** Cells already on the grid (1-based), e.g. the preset being replaced. */
  initial?: Array<{ row: number; col: number; id: number; mask?: number }>;
  faults?: SimFaults;
}): Gen3Sim {
  const { modelByte: model, rows, cols } = opts;
  const sceneCount = opts.sceneCount ?? 8;
  const faults = opts.faults ?? {};
  const handlers = new Set<(b: number[]) => void>();
  const sent: Gen3Sim['sent'] = [];
  const grid = new Map<string, Cell>();
  const scenes: Array<Map<number, BlockScene>> = Array.from({ length: sceneCount }, () => new Map());
  const state = { activeScene: 0, presetNumber: opts.presetNumber ?? 5, name: opts.name ?? 'Old Tone', sceneNames: new Array<string>(sceneCount).fill('') };
  const stored = new Map<number, string>(Object.entries(opts.stored ?? {}).map(([k, v]) => [Number(k), v]));
  stored.set(state.presetNumber, state.name);
  let cursor = 0;
  let buffer: ParsedPresetDump | undefined;
  let importing: number[][] = [];
  let bank = 0;
  const t0 = Date.now();

  // Lookup tables for frames whose packing we do not hand-decode.
  const selectByFrame = new Map<string, number>();
  const routeByFrame = new Map<string, { from: { row: number; col: number }; destRow: number; connect: boolean }>();
  for (let c = 1; c <= cols; c++) {
    for (let r = 1; r <= rows; r++) {
      selectByFrame.set(hexKey(buildSelectCell({ row: r, col: c, rows }, model)), (c - 1) * rows + (r - 1));
      if (c < cols) {
        for (let d = 1; d <= rows; d++) {
          routeByFrame.set(hexKey(buildSetGridRouting({ srcRow: r, srcCol: c, destRow: d, rows, op: ROUTING_OP_CONNECT }, model)), { from: { row: r, col: c }, destRow: d, connect: true });
          routeByFrame.set(hexKey(buildSetGridRouting({ srcRow: r, srcCol: c, destRow: d, rows, op: ROUTING_OP_DISCONNECT }, model)), { from: { row: r, col: c }, destRow: d, connect: false });
        }
      }
    }
  }
  const posToRC = (pos: number): { row: number; col: number } => ({ row: (pos % rows) + 1, col: Math.floor(pos / rows) + 1 });
  const k = (r: number, c: number): string => `${r},${c}`;
  const frame = (fn: number, payload: number[]): number[] => recomputeGen3Checksum([...SYSEX_PREFIX, model, fn, ...payload, 0x00, 0xf7]);
  const emit = (b: number[]): void => { setTimeout(() => { for (const h of [...handlers]) h(b); }, 2); };
  const ensureBlock = (id: number): void => { for (const s of scenes) if (!s.has(id)) s.set(id, { channel: 0, bypassed: faults.freshBypassed?.has(id) === true }); };
  const nameBytes = (s: string): number[] => { const a = new Array<number>(32).fill(0); for (let i = 0; i < Math.min(32, s.length); i++) a[i] = s.charCodeAt(i); return a; };
  // Name frames: [sub, pad, block14, param14, value32(5), modifier14, count14=32, 8-to-7-packed name (37 B)].
  const readName = (b: number[]): string => {
    const raw = [...unpackValueChunked(Uint8Array.from(b.slice(21, -2)), 32)];
    const z = raw.indexOf(0);
    return String.fromCharCode(...(z >= 0 ? raw.slice(0, z) : raw)).trimEnd();
  };
  const loadStored = (n: number): void => {
    grid.clear();
    for (const s of scenes) s.clear();
    state.presetNumber = n;
    state.name = stored.get(n) ?? '<EMPTY>';
    state.activeScene = 0;
  };
  for (const c of opts.initial ?? []) { grid.set(k(c.row, c.col), { id: c.id, mask: c.mask ?? 0 }); if (c.id > 0 && c.id < 1024) ensureBlock(c.id); }

  const onFrame = (b: number[]): void => {
    sent.push({ t: Date.now() - t0, bytes: b });
    if (b[0] !== 0xf0) {
      // Channel voice: CC0 / CC32 bank, Program Change.
      if ((b[0] & 0xf0) === 0xb0 && b[1] === 0x00) bank = b[2] * 128 + (bank % 128);
      if ((b[0] & 0xf0) === 0xb0 && b[1] === 0x20) bank = Math.floor(bank / 128) * 128 + b[2];
      if ((b[0] & 0xf0) === 0xc0) loadStored(bank * 128 + b[1]);
      return;
    }
    if (b[4] !== model) return;
    const fn = b[5];
    if (fn === 0x77 || fn === 0x78 || fn === 0x79) {
      if (fn === 0x77) importing = [];
      importing.push(b);
      if (faults.templateLoad === 'refuse') { emit(frame(0x64, [fn, 0x12])); importing = []; return; }
      emit(frame(0x64, [fn, 0x00]));
      if (fn === 0x79 && faults.templateLoad !== 'drop') {
        const d = parsePresetDump(new Uint8Array(importing.flat()), 0, model);
        buffer = d;
        const dec = decodeGen3PresetDump(d.raw, model);
        grid.clear();
        for (const s of scenes) s.clear();
        for (const c of dec.grid ?? []) grid.set(k(c.row + 1, c.col + 1), { id: c.is_shunt ? 1024 + c.effect_id : c.effect_id, mask: c.route_flag });
        state.name = dec.preset_name ?? '';
        state.activeScene = 0;
      }
      return;
    }
    if (fn === 0x03) {
      if (b[6] === 0x7f && b[7] === 0x7f && buffer) for (const f of buildEditBufferLoadFrames(buffer)) emit(f);
      return;
    }
    if (fn === 0x0a) {
      const id = b[6] | (b[7] << 7);
      if (b[8] === 0x7f) return;
      if (faults.ignoreBypassOf === id) return;
      const s = scenes[state.activeScene].get(id);
      if (s) s.bypassed = b[8] === 1;
      return;
    }
    if (fn === 0x0b) {
      const id = b[6] | (b[7] << 7);
      const s = scenes[state.activeScene].get(id);
      if (s && b[8] !== 0x7f) s.channel = b[8];
      return;
    }
    if (fn === 0x0c) {
      if (b[6] === 0x7f) emit(frame(0x0c, [state.activeScene]));
      else state.activeScene = b[6] & 0x07;
      return;
    }
    if (fn === 0x0d) {
      if (faults.silentNameQuery) return;
      if (b[6] === 0x7f && b[7] === 0x7f) emit(frame(0x0d, [state.presetNumber & 0x7f, state.presetNumber >> 7, ...nameBytes(state.name)]));
      else { const n = b[6] | (b[7] << 7); emit(frame(0x0d, [b[6], b[7], ...nameBytes(stored.get(n) ?? '<EMPTY>')])); }
      return;
    }
    if (fn === 0x13) {
      const entries = [...grid.values()].filter((c) => c.id > 0 && c.id < 1024).map((c) => ({ effectId: c.id, ...(scenes[state.activeScene].get(c.id) ?? { channel: 0, bypassed: false }) }));
      emit(buildGen3StatusDumpFrame(model, entries));
      return;
    }
    if (fn !== 0x01) return;
    const sub = b[6];
    if (sub === 0x30) { const pos = selectByFrame.get(hexKey(b)); if (pos !== undefined) cursor = pos; return; }
    if (sub === 0x32) {
      const id = b[8] | (b[9] << 7);
      const { row, col } = posToRC(cursor);
      if (id === 0) { grid.delete(k(row, col)); return; }
      if (faults.dropInsert?.has(id)) return;
      if (id >= 1024 && faults.shuntInUse?.has(id - 1024)) { emit(frame(0x64, [0x01, 0x02])); return; }
      // A block already on the grid elsewhere: the unit ignores the insert (field evidence), it does not move it.
      if (id < 1024 && [...grid.values()].some((c) => c.id === id)) return;
      grid.set(k(row, col), { id, mask: 0 });
      if (id < 1024) ensureBlock(id);
      return;
    }
    if (sub === 0x35) {
      const r = routeByFrame.get(hexKey(b));
      if (!r) return;
      const dst = k(r.destRow, r.from.col + 1);
      if (faults.dropCableTo?.has(dst)) return;
      const cell = grid.get(dst);
      if (!cell || !grid.has(k(r.from.row, r.from.col))) return;
      cell.mask = r.connect ? cell.mask | (1 << (r.from.row - 1)) : cell.mask & ~(1 << (r.from.row - 1));
      return;
    }
    if (sub === 0x2e) {
      if (faults.silentGrid) return;
      emit(buildGen3GridLayoutFrame(model, [...grid.entries()].map(([kk, c]) => { const [r, cc] = kk.split(',').map(Number); return { row: r - 1, col: cc - 1, id: c.id, mask: c.mask }; })));
      return;
    }
    if (sub === 0x28) { state.name = readName(b); return; }
    if (sub === 0x2b) { const idx = b[10] | (b[11] << 7); state.sceneNames[idx] = readName(b); return; }
    if (sub === 0x26) { const n = b[12] | (b[13] << 7); stored.set(n, state.name); return; }
    if (sub === 0x27) { loadStored(b[12] | (b[13] << 7)); return; }
  };

  const conn = {
    transportKind: 'midi',
    lastSendError: undefined,
    send: (bytes: number[]) => onFrame([...bytes]),
    onMessage: (h: (b: number[]) => void) => { handlers.add(h); return () => handlers.delete(h); },
    receiveSysEx: () => Promise.reject(new Error('timeout')),
    receiveSysExMatching: (pred: (b: number[]) => boolean, timeoutMs: number) =>
      new Promise<number[]>((resolve, reject) => {
        const h = (b: number[]): void => { if (pred(b)) { clearTimeout(t); handlers.delete(h); resolve(b); } };
        const t = setTimeout(() => { handlers.delete(h); reject(new Error('timeout')); }, timeoutMs);
        handlers.add(h);
      }),
  } as unknown as MidiConnection;
  return { ctx: { conn } as DispatchCtx, sent, grid, scenes, state, stored, faults };
}
