/**
 * Offline regression for the Axe-Fx II fixes from the 2026-11-25 apply-
 * contract review (docs/_private/APPLY-CONTRACT-REVIEW-2026-11-25.md):
 *
 *   H5  switch_preset bounds the slot to the model's real preset count and
 *       reads the active preset back (fn 0x14); markClean only on a landing.
 *   H3  a fresh build authors all 8 scenes: unlisted scenes reset to the
 *       defaults (channel X, slot-level bypass else engaged), listed scenes
 *       are walked last; the reset is skipped when nothing structural changed.
 *   M11 the apply runner confirms its leading switch before any build write.
 *   M3  timeouts / verify failures are unconfirmed steps that flip ok and
 *       reach the agent as nacked_steps kind "unconfirmed:*".
 *   M5  set_bypass and rename read back; an unplaced block / mismatch is
 *       reported as not confirmed.
 *   L3  scenes[].name is reported as not written.
 *   L2  import_preset (restore) reads the edit buffer back and compares; a
 *       mismatch blocks the STORE.
 *
 * Fake connections only: no MIDI, no hardware.
 * Run: npm run build:fractal-gen2 && npx tsx scripts/verify-axefx2-contract-fixes.ts
 */
import { registerParamKindResolver } from '@mcp-midi-control/core/protocol-generic/paramKind.js';
import { resolveAxeFxIIParamKind } from '@mcp-midi-control/fractal-gen2/calibration.js';
registerParamKindResolver('axe-fx-ii', resolveAxeFxIIParamKind);

import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import type { DispatchCtx, PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { isDirty, markDirty, markClean } from '@mcp-midi-control/core/server-shared/bufferDirty.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { writer as xlWriter, createWriter, translateSpec } from '@mcp-midi-control/fractal-gen2/descriptor/writer.js';
import { AX8_CONFIG } from '@mcp-midi-control/fractal-gen2/configs/ax8.js';
import { restorePresetBinaryAxeFxII } from '@mcp-midi-control/fractal-gen2/descriptor/presetRestore.js';
import { serializePresetDump } from '@mcp-midi-control/fractal-gen2/presetDump.js';
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import {
  buildApplyPresetAtOps,
  runApplyPresetAtOps,
  type ApplyPresetAtOp,
} from '@mcp-midi-control/fractal-gen2/tools/applyExecutor.js';

delete process.env.MCP_MOCK_TRANSPORT;
const DIRTY = 'axe-fx-ii';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

// ── Fake II ─────────────────────────────────────────────────────────────

const MODEL = 0x07;
function frame(payload: number[]): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, MODEL, ...payload];
  return [...head, head.reduce((a, b) => a ^ b, 0) & 0x7f, 0xf7];
}

interface FakeOpts {
  /** Preset the device reports; 'follow' = whatever was last switched to. */
  presetAnswer?: number | 'follow' | 'silent';
  ackGridCells?: boolean;
  bypassReadBack?: 'track' | 'stuck-engaged' | 'silent';
  nameReadBack?: 'track' | string;
  /**
   * Edit-buffer dump reply. 'device' = the device re-serializes the buffer it
   * now holds (fresh envelope + checksum per frame, as the unit emits it);
   * 'converted' = the device rewrote content in several body frames (as a
   * firmware conversion of an older file would); 'silent' = no answer.
   */
  dump?: 'device' | 'converted' | 'silent';
  ackCables?: boolean;
  /** Block ids the grid read (fn 0x20) reports as placed, one per cell from cell 0. Default: empty grid. */
  placed?: number[];
}

interface Fake {
  conn: MidiConnection;
  sent: number[][];
}

function makeFake(opts: FakeOpts = {}): Fake {
  const handlers = new Set<(b: number[]) => void>();
  const sent: number[][] = [];
  let preset = 0;
  let scene = 0;
  let name = 'Old Name';
  const bypass = new Map<number, number>();
  const channel = new Map<number, number>();
  let pushed: number[][] = [];

  const respond = (b: number[]): number[][] => {
    const fn = b[5];
    if (fn === 0x3c) { preset = (b[6] << 7) | b[7]; return []; }
    if (fn === 0x14 && b.length < 10) {
      const p = opts.presetAnswer ?? 'follow';
      if (p === 'silent') return [];
      const v = p === 'follow' ? preset : p;
      return [frame([0x14, (v >> 7) & 0x7f, v & 0x7f])];
    }
    if (fn === 0x20) {
      const cells: number[] = new Array(48 * 4).fill(0);
      (opts.placed ?? []).forEach((id, k) => { cells[k * 4] = id & 0x7f; cells[k * 4 + 1] = (id >> 7) & 0x7f; });
      return [frame([0x20, ...cells])];
    }
    if (fn === 0x05) return opts.ackGridCells === false ? [] : [frame([0x64, 0x05, 0x00])];
    if (fn === 0x06) return opts.ackCables === false ? [] : [frame([0x64, 0x06, 0x00])];
    if (fn === 0x1d) return [frame([0x64, 0x1d, 0x00])];
    if (fn === 0x29) {
      if (b[6] !== 0x7f) { scene = b[6] & 7; return []; }
      return [frame([0x29, scene])];
    }
    if (fn === 0x11) {
      const eff = b[6] | (b[7] << 7);
      if (b[9] === 0x01) { channel.set(eff, b[8]); return []; }
      return [frame([0x11, b[6], b[7], channel.get(eff) ?? 0])];
    }
    if (fn === 0x02) {
      const eff = b[6] | (b[7] << 7);
      const pid = b[8] | (b[9] << 7);
      const isSet = b[13] === 0x01;
      if (pid === 255) {
        if (isSet) { bypass.set(eff, b[10] !== 0 ? 1 : 0); return []; }
        const mode = opts.bypassReadBack ?? 'track';
        if (mode === 'silent') return [];
        const v = mode === 'stuck-engaged' ? 0 : (bypass.get(eff) ?? 0);
        return [frame([0x02, b[6], b[7], b[8], b[9], v, 0, 0, 0, 0, 0, 0, 0, ...[...(v ? 'ON' : 'OFF')].map((c) => c.charCodeAt(0)), 0])];
      }
      if (isSet) return [];
      // Output level / any other GET: "0.00".
      return [frame([0x02, b[6], b[7], b[8], b[9], 0, 0, 0, 0, 0, 0, 0, 0, 0x30, 0x2e, 0x30, 0x30, 0])];
    }
    if (fn === 0x09) { name = String.fromCharCode(...b.slice(6, b.length - 2)).trim(); return []; }
    if (fn === 0x0f) {
      const v = opts.nameReadBack === undefined || opts.nameReadBack === 'track' ? name : opts.nameReadBack;
      return [frame([0x0f, ...[...v].map((c) => c.charCodeAt(0)), 0])];
    }
    if (fn === 0x77 || fn === 0x78 || fn === 0x79) { pushed.push([...b]); return []; }
    if (fn === 0x03) {
      const mode = opts.dump ?? 'device';
      if (mode === 'silent') return [];
      // Re-emit from the PAYLOAD (bytes 5..len-3), not the pushed frames:
      // the device builds its own envelope and checksum.
      const out = pushed.map((f) => frame(f.slice(5, f.length - 2)));
      pushed = [];
      if (mode === 'converted') {
        let k = 0;
        for (const f of out) {
          if (f[5] !== 0x78 || k++ % 8 !== 0) continue;
          f[12] = (f[12] + 1) & 0x7f;
          const body = f.slice(0, f.length - 2);
          f[f.length - 2] = body.reduce((a, b) => a ^ b, 0) & 0x7f;
        }
      }
      return out;
    }
    return [];
  };

  const conn = {
    send: (b: number[]) => {
      sent.push([...b]);
      const replies = respond(b);
      if (replies.length > 0) setImmediate(() => { for (const f of replies) for (const h of [...handlers]) h(f); });
    },
    onMessage: (h: (b: number[]) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
    receiveSysEx: () => Promise.reject(new Error('unused')),
    receiveSysExMatching: (pred: (b: number[]) => boolean, timeoutMs = 800) =>
      new Promise<number[]>((resolve, reject) => {
        const h = (b: number[]) => { if (!pred(b)) return; clearTimeout(t); handlers.delete(h); resolve(b); };
        const t = setTimeout(() => { handlers.delete(h); reject(new Error(`fake II: no reply in ${timeoutMs}ms`)); }, timeoutMs);
        handlers.add(h);
      }),
    hasInput: true,
    close: () => handlers.clear(),
  } as unknown as MidiConnection;
  return { conn, sent };
}

const ctxOf = (conn: MidiConnection): DispatchCtx =>
  ({ conn, descriptor: AXEFX2_DESCRIPTOR, reconnect: async () => conn }) as unknown as DispatchCtx;

async function expectThrow(fn: () => Promise<unknown>, re: RegExp): Promise<string | undefined> {
  try { await fn(); return 'did not throw'; } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return re.test(m) ? undefined : m;
  }
}

// ── H5 ──────────────────────────────────────────────────────────────────
console.log('H5: switch_preset range + landing read-back');
{
  const { conn } = makeFake();
  const miss = await expectThrow(() => xlWriter.switchPreset!(ctxOf(conn), 769), /out of range.*768/);
  check('XL+ refuses slot 769 (has 768)', miss === undefined, miss);
  const ax8 = createWriter(AX8_CONFIG);
  const miss8 = await expectThrow(() => ax8.switchPreset!(ctxOf(conn), 513), /out of range.*512/);
  check('AX8 refuses slot 513 (has 512)', miss8 === undefined, miss8);

  markDirty(DIRTY);
  const ok = await xlWriter.switchPreset!(ctxOf(conn), 768);
  check('slot 768 lands, confirmed by read-back', ok.acked && ok.confirmed_by === 'read_back', JSON.stringify(ok));
  check('confirmed landing marks the buffer clean', !isDirty(DIRTY));
}
{
  const { conn } = makeFake({ presetAnswer: 4 });
  markDirty(DIRTY);
  const r = await xlWriter.switchPreset!(ctxOf(conn), 11);
  check('landing on another preset → acked:false naming the real slot', !r.acked && /still on slot 5/.test(r.warning ?? ''), JSON.stringify(r));
  check('failed landing keeps the dirty flag', isDirty(DIRTY));
}
{
  const { conn } = makeFake({ presetAnswer: 'silent' });
  markDirty(DIRTY);
  const r = await xlWriter.switchPreset!(ctxOf(conn), 3);
  check('silent read-back → acked:false, unconfirmed', !r.acked && /unconfirmed/.test(r.warning ?? ''), JSON.stringify(r));
  check('unconfirmed landing keeps the dirty flag', isDirty(DIRTY));
  markClean(DIRTY);
}

// ── H3 op shape ─────────────────────────────────────────────────────────
console.log('\nH3: every scene is authored on a fresh build');
const sceneSpec: PresetSpec = {
  slots: [
    { slot: { row: 2, col: 1 }, block_type: 'drive', bypassed: true },
    { slot: { row: 2, col: 2 }, block_type: 'amp' },
    { slot: { row: 2, col: 3 }, block_type: 'cab' },
  ],
  scenes: [{ scene: 3, channels: { amp: 'Y' }, bypassed: { drive: false } }],
};
const at = (spec: PresetSpec): ApplyPresetAtOp[] =>
  buildApplyPresetAtOps({ preset_number: 5, ...translateSpec(spec) } as Parameters<typeof buildApplyPresetAtOps>[0], { wire: true });
{
  const ops = at(sceneSpec);
  const walks = ops.filter((o) => o.kind === 'switch_scene' && /per-scene state walk/.test(o.summary));
  check('8 scene walks (1 listed + 7 unlisted)', walks.length === 8, `got ${walks.length}`);
  check('the 7 unlisted walks come first and are flagged', walks.slice(0, 7).every((o) => o.unlistedSceneDefault === true));
  check('the listed scene 3 is walked last, unflagged', /scene 3\)/.test(walks[7]?.summary ?? '') && walks[7]?.unlistedSceneDefault !== true, walks[7]?.summary);
  const s1DriveBypass = ops.find((o) => o.kind === 'bypass' && o.summary.startsWith('[scene 1] Drive'));
  check('unlisted scene keeps the slot-level bypassed:true', /BYPASSED/.test(s1DriveBypass?.summary ?? ''), s1DriveBypass?.summary);
  const s3DriveBypass = ops.find((o) => o.kind === 'bypass' && o.summary.startsWith('[scene 3] Drive'));
  check('listed scene override wins (drive engaged on scene 3)', /ENGAGED/.test(s3DriveBypass?.summary ?? ''), s3DriveBypass?.summary);
  const landing = ops.find((o) => o.awaitResponse === 'scene_verify');
  check('landing op present and not flagged when scenes are listed', landing !== undefined && landing.unlistedSceneDefault !== true);
  check('leading switch carries expectedPreset (M11)', ops[0].kind === 'switch_preset' && ops[0].expectedPreset === 5);
}
{
  const ops = at({ slots: sceneSpec.slots });
  const walks = ops.filter((o) => o.kind === 'switch_scene' && /per-scene state walk/.test(o.summary));
  check('no scenes listed → still 8 walks, all flagged', walks.length === 8 && walks.every((o) => o.unlistedSceneDefault === true), `got ${walks.length}`);
  const landing = ops.find((o) => o.awaitResponse === 'scene_verify');
  check('no scenes listed → landing flagged with the walk', landing?.unlistedSceneDefault === true);
}

// ── H3 / M11 / M3 runtime ───────────────────────────────────────────────
console.log('\nRuntime: default-scene walk, switch confirmation, unconfirmed steps');
{
  const { conn, sent } = makeFake();
  const r = await runApplyPresetAtOps(conn as never, at({ slots: sceneSpec.slots }), { modelId: MODEL });
  const sceneSets = sent.filter((f) => f[5] === 0x29 && f[6] !== 0x7f).length;
  check('fresh build sends the 8 scene walks + landing', sceneSets === 9, `got ${sceneSets}`);
  check('clean run: ok, no unconfirmed steps', r.ok && r.unconfirmedSteps.length === 0, JSON.stringify(r.unconfirmedSteps));
}
{
  const { conn, sent } = makeFake({ presetAnswer: 2 });
  const r = await runApplyPresetAtOps(conn as never, at({ slots: sceneSpec.slots }), { modelId: MODEL });
  check('switch landing elsewhere aborts: ok:false + aborted', !r.ok && /still on slot 3/.test(r.aborted ?? ''), r.aborted);
  check('aborted run sends no grid write', !sent.some((f) => f[5] === 0x05));
}
{
  const { conn } = makeFake({ ackGridCells: false });
  const r = await runApplyPresetAtOps(conn as never, at({ slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }] }), { modelId: MODEL });
  check('unacked grid cells → ok:false', !r.ok);
  check('unacked grid cells → unconfirmed set_grid_cell steps', r.unconfirmedSteps.some((u) => u.kind === 'set_grid_cell'), JSON.stringify(r.unconfirmedSteps.map((u) => u.kind)));
}

// ── M3 + L3 via the writer ──────────────────────────────────────────────
console.log('\nWriter: apply_preset evidence + scene names');
{
  const { conn } = makeFake({ ackGridCells: false });
  const r = await xlWriter.applyPreset!(ctxOf(conn), { slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }] });
  check('working-buffer apply with unacked cells → ok:false', !r.ok, JSON.stringify(r.warning));
  check('unconfirmed steps reach nacked_steps as unconfirmed:*', (r.nacked_steps ?? []).some((n) => n.kind === 'unconfirmed:set_grid_cell'));
  check('warning names the unconfirmed steps', /could not be confirmed/.test(r.warning ?? ''), r.warning);
}
{
  const { conn } = makeFake();
  const r = await xlWriter.applyPreset!(ctxOf(conn), {
    slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }],
    scenes: [{ scene: 1, name: 'Clean', channels: {} }],
  });
  check('scenes[].name → explicit "NOT written" warning', /Scene names were NOT written \(scene 1\)/.test(r.warning ?? ''), r.warning);
}

// ── M5 ──────────────────────────────────────────────────────────────────
console.log('\nM5: set_bypass / rename read back');
const AMP1_ID = 106;
{
  const { conn } = makeFake({ placed: [AMP1_ID] });
  const r = await xlWriter.setBypass!(ctxOf(conn), 'amp', true);
  check('bypass that reads back → acked + read_back', r.acked && r.confirmed_by === 'read_back', JSON.stringify(r));
}
{
  const { conn } = makeFake({ placed: [AMP1_ID], bypassReadBack: 'stuck-engaged' });
  const r = await xlWriter.setBypass!(ctxOf(conn), 'amp', true);
  check('bypass that reads back different → acked:false', !r.acked && /did not land/.test(r.warning ?? ''), JSON.stringify(r));
}
{
  const { conn } = makeFake({ placed: [AMP1_ID], bypassReadBack: 'silent' });
  const r = await xlWriter.setBypass!(ctxOf(conn), 'amp', true);
  check('no bypass answer → acked:false, says not placed', !r.acked && /not placed/.test(r.warning ?? ''), JSON.stringify(r));
}
{
  // 2026-11-25 hardware: an UNPLACED block's bypass GET still answers, so the
  // read-back "confirmed" a no-op. The grid read now refuses first.
  const { conn, sent } = makeFake();
  const r = await xlWriter.setBypass!(ctxOf(conn), 'amp', true);
  const bypassSets = sent.filter((f) => f[5] === 0x02 && ((f[8] | (f[9] << 7)) === 255) && f[13] === 0x01);
  check('unplaced block (grid has no amp) → refuses, says not placed, sends no bypass SET',
    !r.acked && /not placed/.test(r.warning ?? '') && bypassSets.length === 0, JSON.stringify(r));
}
{
  const { conn } = makeFake();
  const r = await xlWriter.rename!(ctxOf(conn), 'preset', 'Lead Tone');
  check('rename that reads back → acked + read_back', r.acked && r.confirmed_by === 'read_back', JSON.stringify(r));
}
{
  const { conn } = makeFake({ nameReadBack: 'Something Else' });
  const r = await xlWriter.rename!(ctxOf(conn), 'preset', 'Lead Tone');
  check('rename that reads back different → acked:false', !r.acked && /Something Else/.test(r.warning ?? ''), JSON.stringify(r));
}
{
  // The shipped mock transport models bypass + name state for these receipts.
  process.env.MCP_MOCK_TRANSPORT = '1';
  const mock = connectAxeFxII() as unknown as MidiConnection;
  delete process.env.MCP_MOCK_TRANSPORT;
  const b = await xlWriter.setBypass!(ctxOf(mock), 'amp', true);
  // The shipped mock's default grid is empty, so the placement check refuses
  // (the read-back receipt itself is covered by the fake cases above).
  check('mock transport: set_bypass on its empty grid refuses as not placed', !b.acked && /not placed/.test(b.warning ?? ''), JSON.stringify(b));
  const n = await xlWriter.rename!(ctxOf(mock), 'preset', 'Mock Rename');
  check('mock transport: rename reads back what it wrote', n.acked && n.confirmed_by === 'read_back', JSON.stringify(n));
  mock.close?.();
}

// ── L2 ──────────────────────────────────────────────────────────────────
console.log('\nL2: restore reads the edit buffer back');
const chunkPayloads: Uint8Array[] = [];
for (let c = 0; c < 64; c++) chunkPayloads.push(Uint8Array.from({ length: 194 }, (_, i) => (c * 7 + i) & 0x7f));
const dump = serializePresetDump({
  raw: new Uint8Array(0),
  headerPayload: new Uint8Array([0, 0, 0, 0x20]),
  chunkPayloads,
  footerPayload: new Uint8Array([0, 0, 0]),
});
{
  const { conn, sent } = makeFake({ dump: 'device' });
  const r = await restorePresetBinaryAxeFxII(ctxOf(conn), dump, { modelId: MODEL, save_authorized: true, target_location: 4 });
  check('matching read-back → ok:true, info', r.ok && /matches the file/.test(r.info ?? ''), JSON.stringify({ ok: r.ok, warning: r.warning }));
  check('matching read-back → STORE sent', sent.some((f) => f[5] === 0x1d) && r.saved_to_location === 4);
}
{
  const { conn, sent } = makeFake({ dump: 'converted' });
  const r = await restorePresetBinaryAxeFxII(ctxOf(conn), dump, { modelId: MODEL, save_authorized: true, target_location: 4 });
  check('converted read-back → ok:false, names the differing frames', !r.ok && /8 of 64 body frames differ/.test(r.warning ?? ''), r.warning);
  check('converted read-back → says it may be firmware conversion', /converting a file/.test(r.warning ?? ''), r.warning);
  check('converted read-back → STORE never sent, says how to keep it', !sent.some((f) => f[5] === 0x1d) && /save_preset/.test(r.warning ?? ''), r.warning);
}
{
  const { conn } = makeFake({ dump: 'silent' });
  const r = await restorePresetBinaryAxeFxII(ctxOf(conn), dump, { modelId: MODEL });
  check('no read-back → ok:false, unconfirmed', !r.ok && /unconfirmed/.test(r.warning ?? ''), r.warning);
}
{
  const { conn, sent } = makeFake({ dump: 'silent' });
  const r = await restorePresetBinaryAxeFxII(ctxOf(conn), dump, { modelId: MODEL, save_authorized: true, target_location: 4 });
  check('no read-back + save → STORE sent and the receipt says it WAS saved',
    sent.some((f) => f[5] === 0x1d) && r.saved_to_location === 4 && /WAS saved to slot 4/.test(r.warning ?? ''), r.warning);
}

// ── Review follow-ups: STORE gate, X/Y gating, reset cost, range ────────
console.log('\nFollow-ups: STORE gate (H1), X/Y-only channel ops (H3), reset cost, range on save');
{
  const { conn, sent } = makeFake({ ackCables: false });
  const r = await xlWriter.applyPreset!(ctxOf(conn), {
    slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }, { slot: { row: 2, col: 2 }, block_type: 'cab' }],
  }, 9, { save: true });
  check('unconfirmed cable → STORE not sent', !sent.some((f) => f[5] === 0x1d));
  check('unconfirmed cable → ok:false, saved:false, warning says not saved', !r.ok && r.saved === false && /STORE was NOT sent/.test(r.warning ?? ''), r.warning);
}
{
  const { conn, sent } = makeFake();
  const r = await xlWriter.applyPreset!(ctxOf(conn), {
    slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }],
  }, 9, { save: true });
  check('clean build to a slot → STORE sent, saved', r.ok && r.saved === true && sent.some((f) => f[5] === 0x1d), r.warning);
  check('receipt reports the unlisted-scene reset and its cost', /8 scene\(s\) the spec did not list were reset.*ms of wire time/.test(r.warning ?? ''), r.warning);
}
{
  const ops = at({ slots: [{ slot: { row: 2, col: 1 }, block_type: 'amp' }, { slot: { row: 2, col: 2 }, block_type: 'enhancer' }] });
  const enhChannelOps = ops.filter((o) => o.kind === 'channel' && /Enhancer/.test(o.summary));
  const ampChannelOps = ops.filter((o) => o.kind === 'channel' && /Amp 1/.test(o.summary));
  check('single-set block (Enhancer) gets no channel select/verify', enhChannelOps.length === 0, `${enhChannelOps.length}`);
  check('X/Y block (Amp) still gets one per scene', ampChannelOps.length === 8, `${ampChannelOps.length}`);
  const enhBypass = ops.filter((o) => o.kind === 'bypass' && /Enhancer/.test(o.summary) && /^\[scene/.test(o.summary));
  check('single-set block still gets its per-scene bypass', enhBypass.length === 8, `${enhBypass.length}`);
}
{
  const { conn } = makeFake();
  const miss = await expectThrow(() => xlWriter.savePreset!(ctxOf(conn), 769), /out of range.*768/);
  check('save_preset refuses slot 769 on the XL+', miss === undefined, miss);
}

console.log(failed === 0 ? '\nAll Axe-Fx II contract-fix checks pass.' : `\n✗ ${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
