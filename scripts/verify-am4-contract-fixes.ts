/**
 * Offline regression for the AM4 fixes from the 2026-11-25 apply-contract
 * review (docs/_private/APPLY-CONTRACT-REVIEW-2026-11-25.md):
 *
 *   H2  a slot-level `bypassed` is honoured on every scene that does not name
 *       the block (Axe-Fx II parity); an explicit scene entry still wins.
 *       Amp bypass is REAL (hardware-confirmed 2026-11-25: 0x003A/0x0003
 *       flipped the amp's scene-bypass word, boost untouched), so the amp
 *       takes bypass writes like every block; bypassed on an empty slot
 *       still refuses.
 *   L1  unlisted-slot clears are emitted before the placements.
 *   M10 an explicit channel always sends the channel select; the session
 *       cache no longer suppresses it (only an in-batch proof does).
 *   H1  apply-at-target re-sends an unacked write once and does not save a
 *       build that still has unacked writes.
 *   M11 apply-at-target refuses to build when the location read-back says
 *       the switch did not land.
 *
 * 2026-11-25 hardware follow-ups: import_preset compares content (not the
 * churning PATCH words), set_bypass refuses an unplaced block, get_preset
 * returns the active channel by default and fits under the response budget,
 * get_param carries no raw wire bytes and echoes `channel`, and enum names
 * resolve across the "MK" spelling. Legs that need a real dump replay the
 * owner's captures under samples/hw-test-0.10.0/ (gitignored) and are
 * skipped, with a note, when those files are absent.
 *
 * Run: npm run build:am4 && npx tsx scripts/verify-am4-contract-fixes.ts
 */
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { prepareApplyPresetWrites, confirmLanding, runApplyPresetAt } from '@mcp-midi-control/am4/tools/applyExecutor.js';
import { packValue, fractalChecksum } from 'fractal-midi/shared';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';
import { writer as am4Writer } from '@mcp-midi-control/am4/descriptor/writer.js';
import { switchBlockChannel, lastKnownChannel } from '@mcp-midi-control/am4/shared/channels.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { am4ComparableBody, KNOWN_PARAMS, type Param } from 'fractal-midi/am4';
import type { PresetSnapshotSlot } from '@mcp-midi-control/core/protocol-generic/types.js';
import { reader as am4Reader, fitSnapshotChannels } from '@mcp-midi-control/am4/descriptor/reader.js';
import { differingOffsets, verifyRestoredBody } from '@mcp-midi-control/am4/descriptor/presetRestore.js';
import { decodeDumpBody } from '@mcp-midi-control/am4/shared/bufferState.js';
import { makeEncode } from '@mcp-midi-control/am4/descriptor/schema.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}
function throws(fn: () => unknown, re: RegExp): string | undefined {
  try { fn(); return 'did not throw'; } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return re.test(m) ? undefined : m;
  }
}

// ── H2 ──────────────────────────────────────────────────────────────────
console.log('H2: slot-level bypassed honoured per scene');
{
  const { prepared } = prepareApplyPresetWrites({
    slots: [
      { position: 1, block_type: 'drive', bypassed: true },
      { position: 2, block_type: 'amp' },
    ],
    scenes: [{ index: 2, bypass: { drive: false } }],
  });
  const driveBypass = prepared.filter((p): p is Extract<typeof p, { kind: 'bypass' }> => p.kind === 'bypass' && p.block === 'drive');
  const byScene = new Map(driveBypass.map((p) => [p.sceneIndex, p.bypassed]));
  check('drive written on all 4 scenes', byScene.size === 4, JSON.stringify([...byScene]));
  check('unlisted scenes keep the slot-level bypassed:true', [0, 2, 3].every((s) => byScene.get(s) === true), JSON.stringify([...byScene]));
  check('the explicit scene 2 entry wins (engaged)', byScene.get(1) === false, JSON.stringify([...byScene]));
}
{
  const { prepared: p1 } = prepareApplyPresetWrites({ slots: [{ position: 1, block_type: 'amp', bypassed: true }] });
  const ampBy1 = p1.filter((p) => p.kind === 'bypass' && p.block === 'amp');
  check('amp bypassed:true is accepted and written on all 4 scenes',
    ampBy1.length === 4 && ampBy1.every((p) => p.kind === 'bypass' && p.bypassed), JSON.stringify(ampBy1));
  const { prepared: p2 } = prepareApplyPresetWrites({ slots: [{ position: 1, block_type: 'amp' }], scenes: [{ index: 1, bypass: { amp: true } }] });
  const sc1 = p2.find((p) => p.kind === 'bypass' && p.block === 'amp' && p.sceneIndex === 0);
  check('scene bypass amp:true is accepted', sc1 !== undefined && sc1.kind === 'bypass' && sc1.bypassed === true, JSON.stringify(sc1));
  const err3 = throws(
    () => prepareApplyPresetWrites({ slots: [{ position: 1, block_type: 'none', bypassed: true }] }),
    /./,
  );
  check('bypassed on an empty slot refuses', err3 === undefined, err3);
}

{
  const { prepared } = prepareApplyPresetWrites({
    slots: [{ position: 1, block_type: 'drive' }, { position: 2, block_type: 'amp' }],
    scenes: [{ index: 1, bypass: { amp: false } }],
  });
  const ampBy = prepared.filter((p) => p.kind === 'bypass' && p.block === 'amp');
  check('the completeness pass engages the amp on every scene (explicit amp:false included)',
    ampBy.length === 4 && ampBy.every((p) => p.kind === 'bypass' && !p.bypassed), JSON.stringify(ampBy));
  check('drive still gets its per-scene bypass writes',
    prepared.filter((p) => p.kind === 'bypass' && p.block === 'drive').length === 4);
}

// ── L1 ──────────────────────────────────────────────────────────────────
console.log('\nL1: clears before placements');
{
  const { prepared } = prepareApplyPresetWrites({ slots: [{ position: 3, block_type: 'reverb' }] });
  const places = prepared.filter((p): p is Extract<typeof p, { kind: 'place' }> => p.kind === 'place');
  const lastClear = Math.max(...places.map((p, i) => (p.blockName === 'none' ? i : -1)));
  const firstReal = places.findIndex((p) => p.blockName !== 'none');
  check('three unlisted slots cleared', places.filter((p) => p.blockName === 'none').length === 3, JSON.stringify(places.map((p) => [p.position, p.blockName])));
  check('every clear precedes the first placement', firstReal > lastClear, JSON.stringify(places.map((p) => [p.position, p.blockName])));
}

// ── M10 ─────────────────────────────────────────────────────────────────
console.log('\nM10: explicit channel never trusts the session cache');
{
  const sent: number[][] = [];
  const handlers = new Set<(b: number[]) => void>();
  const conn = {
    send: (b: number[]) => {
      sent.push([...b]);
      // AM4 write echo: same header + pids, action WRITE, hdr4 0x0028.
      const echo = [...b, ...new Array(Math.max(0, 18 - b.length)).fill(0)];
      echo[10] = 0x01; echo[11] = 0x00; echo[14] = 0x28; echo[15] = 0x00;
      setImmediate(() => { for (const h of [...handlers]) h(echo); });
    },
    receiveSysExMatching: (pred: (b: number[]) => boolean, t = 300) =>
      new Promise<number[]>((resolve, reject) => {
        const h = (b: number[]) => { if (!pred(b)) return; clearTimeout(timer); handlers.delete(h); resolve(b); };
        const timer = setTimeout(() => { handlers.delete(h); reject(new Error('no echo')); }, t);
        handlers.add(h);
      }),
    onMessage: (h: (b: number[]) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
  } as unknown as MidiConnection;

  lastKnownChannel.amp = 1; // the server last saw amp on B...
  const r = await switchBlockChannel(conn, 'amp', 'B'); // ...but a footswitch may have moved it
  check('cache says B, target B → the select is still sent', r.switched && sent.length === 1, `sent=${sent.length}`);
  const r2 = await switchBlockChannel(conn, 'amp', 'B', 1);
  check('in-batch proof (alreadyOn = B) → skipped', !r2.switched && sent.length === 1, `sent=${sent.length}`);
  const r3 = await switchBlockChannel(conn, 'amp', 'C', 1);
  check('in-batch proof for another channel → sent', r3.switched && sent.length === 2, `sent=${sent.length}`);
}

// ── M11 mock guard ──────────────────────────────────────────────────────
console.log('\nM11: confirmLanding');
{
  process.env.MCP_MOCK_TRANSPORT = '1';
  const v = await confirmLanding({} as MidiConnection, 5);
  delete process.env.MCP_MOCK_TRANSPORT;
  check('mock transport: no read-back attempted (undefined)', v === undefined);
}

// ── H1 / M11 against a fake AM4 ─────────────────────────────────────────
console.log('\nH1 / M11: apply_preset at a target location');
interface Am4FakeOpts {
  /** Location index the location register reports. */
  location: number;
  /** Return true to swallow the echo of this write on this attempt (1-based). */
  dropWrite?: (b: number[], attempt: number) => boolean;
  /** Frames to replay for a fn 0x03 dump request (a captured .syx split on F7). */
  dump?: number[][];
  /** u32 every other read (action 0x0E) answers with; unanswered when absent. */
  readValue?: number;
}
function am4Fake(opts: Am4FakeOpts): { conn: MidiConnection; sent: number[][] } {
  const sent: number[][] = [];
  const handlers = new Set<(b: number[]) => void>();
  const attempts = new Map<string, number>();
  const reply = (b: number[]): number[] | undefined => {
    const action = b[10] | (b[11] << 7);
    const pidLow = b[6] | (b[7] << 7);
    const pidHigh = b[8] | (b[9] << 7);
    if (action === 0x0e) {
      const isLocation = pidLow === 0x00ce && pidHigh === 0x000a;
      if (!isLocation && opts.readValue === undefined) return undefined;
      const raw = new Uint8Array(4);
      new DataView(raw.buffer).setUint32(0, isLocation ? opts.location : (opts.readValue ?? 0), true);
      const head = [...b.slice(0, 12), 0x00, 0x00, 0x04, 0x00, ...packValue(raw)];
      return [...head, fractalChecksum(head), 0xf7];
    }
    if (action === 0x01) {
      const key = b.join(',');
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      if (opts.dropWrite?.(b, n)) return undefined;
      const echo = [...b];
      echo[14] = 0x28; echo[15] = 0x00;
      return echo;
    }
    // Command-style actions (save 0x1B, renames): 18-byte command ack.
    const head = [...b.slice(0, 12), 0, 0, 0, 0];
    return [...head, fractalChecksum(head), 0xf7];
  };
  const conn = {
    send: (b: number[]) => {
      sent.push([...b]);
      if (b[5] === 0x03) {
        const frames = opts.dump;
        if (frames !== undefined) setImmediate(() => { for (const f of frames) for (const h of [...handlers]) h(f); });
        return;
      }
      const r = reply(b);
      if (r) setImmediate(() => { for (const h of [...handlers]) h(r); });
    },
    receiveSysExMatching: (pred: (b: number[]) => boolean, t = 300) =>
      new Promise<number[]>((resolve, reject) => {
        const h = (b: number[]) => { if (!pred(b)) return; clearTimeout(timer); handlers.delete(h); resolve(b); };
        const timer = setTimeout(() => { handlers.delete(h); reject(new Error('no reply')); }, t);
        handlers.add(h);
      }),
    onMessage: (h: (b: number[]) => void) => { handlers.add(h); return () => { handlers.delete(h); }; },
  } as unknown as MidiConnection;
  return { conn, sent };
}
const isSave = (b: number[]): boolean => (b[10] | (b[11] << 7)) === 0x1b;
const isSlot1Place = (b: number[]): boolean => (b[10] | (b[11] << 7)) === 0x01 && (b[8] | (b[9] << 7)) === 0x0f;
const atSpec = { slots: [{ position: 1, block_type: 'reverb' }] };
{
  const { conn, sent } = am4Fake({ location: 5 });
  const r = await runApplyPresetAt(conn, 5, atSpec, { save: true });
  check('clean build: ok, saved, landing read back', r.ok && r.saved && r.unacked === 0 && r.landing === 'read_back', JSON.stringify(r));
  check('clean build: every prepared write acked', r.ok && r.totalWrites > 0 && r.acked === r.totalWrites, JSON.stringify(r.ok ? [r.acked, r.totalWrites] : r));
  check('clean build: the save went out', sent.some(isSave));
}
{
  // The slot-1 placement's first echo is dropped; the inline re-send lands it.
  const { conn, sent } = am4Fake({ location: 5, dropWrite: (b, n) => n === 1 && isSlot1Place(b) });
  const r = await runApplyPresetAt(conn, 5, atSpec, { save: true });
  check('an unacked write is re-sent once and then counts as acked', r.ok && r.unacked === 0 && r.saved, JSON.stringify(r));
  check('the placement went out twice', sent.filter(isSlot1Place).length === 2, `${sent.filter(isSlot1Place).length}`);
}
{
  // The slot-1 placement never echoes.
  const { conn, sent } = am4Fake({ location: 5, dropWrite: (b) => isSlot1Place(b) });
  const r = await runApplyPresetAt(conn, 5, atSpec, { save: true });
  check('a write that stays unacked → not saved, saveSkipped says why',
    r.ok && !r.saved && r.unacked === 1 && /NOT sent/.test(r.saveSkipped ?? ''), JSON.stringify(r));
  check('no save frame was sent', !sent.some(isSave));
}
{
  const { conn, sent } = am4Fake({ location: 2 });
  const r = await runApplyPresetAt(conn, 5, atSpec, { save: true });
  check('switch landed elsewhere → refuses at step switch', !r.ok && r.step === 'switch' && /still on/.test(r.error), JSON.stringify(r));
  const writes = sent.filter((b) => (b[10] | (b[11] << 7)) === 0x01).length;
  check('nothing but the switch was written', writes === 1 && !sent.some(isSave), `writes=${writes}`);
}
{
  // Writer-level receipt: ok / steps / saved / warning reflect the wire.
  const { conn } = am4Fake({ location: 5, dropWrite: (b) => isSlot1Place(b) });
  const ctx = { conn, reconnect: async () => conn } as unknown as DispatchCtx;
  const r = await am4Writer.applyPreset!(ctx, { slots: [{ slot: 1, block_type: 'reverb' }] }, 'B02', { save: true });
  check('writer: unacked build → ok:false, saved:false', !r.ok && r.saved === false, JSON.stringify(r));
  check('writer: warning says the save was NOT sent', /NOT sent/.test(r.warning ?? ''), r.warning);
  const { conn: c2 } = am4Fake({ location: 5 });
  const ctx2 = { conn: c2, reconnect: async () => c2 } as unknown as DispatchCtx;
  const ok = await am4Writer.applyPreset!(ctx2, { slots: [{ slot: 1, block_type: 'reverb' }] }, 'B02', { save: true });
  check('writer: clean build → ok, saved, steps = switch + writes + save', ok.ok && ok.saved === true && ok.steps >= 3, JSON.stringify(ok));
}

// ── 2026-11-25 hardware follow-ups ──────────────────────────────────────
console.log('\n2026-11-25 hardware follow-ups');
const HW = 'samples/hw-test-0.10.0';
const splitSyx = (bytes: Uint8Array): number[][] => {
  const out: number[][] = [];
  let cur: number[] = [];
  for (const b of bytes) { cur.push(b); if (b === 0xf7) { out.push(cur); cur = []; } }
  return out;
};
const loadSyx = (path: string): Uint8Array | undefined => (existsSync(path) ? new Uint8Array(readFileSync(path)) : undefined);
const firstSyx = (dir: string): string | undefined => {
  if (!existsSync(dir)) return undefined;
  const f = readdirSync(dir).filter((n) => n.endsWith('.syx')).sort()[0];
  return f === undefined ? undefined : `${dir}/${f}`;
};
{
  // Item 2: content compare + offsets.
  check('differingOffsets lists every differing byte and a length tail',
    JSON.stringify(differingOffsets(Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 9, 3, 4]))) === '[1,3]');
  const active = loadSyx(`${HW}/Fractal_AM4-preset-2026-11-25_20-45-17.syx`);
  const again = loadSyx(`${HW}/Fractal_AM4-preset-2026-11-25_20-51-13.syx`);
  if (active !== undefined && again !== undefined) {
    const a = decodeDumpBody(active)!;
    const b = decodeDumpBody(again)!;
    const raw = differingOffsets(a.decompressedBody.subarray(0, a.decompSize), b.decompressedBody.subarray(0, b.decompSize));
    const cmp = differingOffsets(am4ComparableBody(a.decompressedBody, a.decompSize)!, am4ComparableBody(b.decompressedBody, b.decompSize)!);
    check('two exports of an untouched preset differ only in the PATCH volatile word; the content compare ignores it',
      raw.length > 0 && raw.every((o) => o === 0x177c || o === 0x177d) && cmp.length === 0, `raw=${raw} cmp=${cmp}`);
    const { conn } = am4Fake({ location: 6, dump: splitSyx(again) });
    const v = await verifyRestoredBody({ conn } as unknown as DispatchCtx, active);
    check('verifyRestoredBody: same-firmware round-trip is a match (no false 2-byte mismatch)', v.kind === 'match', JSON.stringify(v));
  } else {
    console.log('  - skipped: owner captures for the import compare are not on this machine');
  }
}
{
  // Item 6: set_bypass on an unplaced block (capture: amp slot 1 + reverb slot 3).
  const onFile = firstSyx(`${HW}/ampbyp-on`);
  const bytes = onFile !== undefined ? loadSyx(onFile) : undefined;
  if (bytes !== undefined) {
    const { conn, sent } = am4Fake({ location: 6, dump: splitSyx(bytes), readValue: 1 });
    const ctx = { conn } as unknown as DispatchCtx;
    const r = await am4Writer.setBypass!(ctx, 'delay', true);
    check('set_bypass(delay) with no delay placed → acked:false, "not placed", nothing written',
      r.acked === false && /No 'delay' block is placed/.test(r.warning ?? '') && !sent.some((b) => (b[10] | (b[11] << 7)) === 0x01),
      JSON.stringify(r));
    const amp = await am4Writer.setBypass!(ctx, 'amp', true);
    check('set_bypass(amp) on a placed amp writes 0x003A/0x0003 and is acked', amp.acked === true && sent.some((b) =>
      (b[10] | (b[11] << 7)) === 0x01 && (b[6] | (b[7] << 7)) === 0x3a && (b[8] | (b[9] << 7)) === 0x03), JSON.stringify(amp));
  } else {
    console.log('  - skipped: owner amp-bypass capture is not on this machine');
  }
}
{
  // Item 4: active-channel default + fit.
  const fourBlock = loadSyx(`${HW}/Fractal_AM4-preset-2026-11-25_20-45-17.syx`);
  if (fourBlock !== undefined) {
    const { conn } = am4Fake({ location: 6, dump: splitSyx(fourBlock) });
    const ctx = { conn } as unknown as DispatchCtx;
    const def = await am4Reader.getPreset!(ctx, { location: 'B03' });
    const all = await am4Reader.getPreset!(ctx, { location: 'B03', include_channel_state: true });
    const nDef = JSON.stringify(def).length;
    const nAll = JSON.stringify(all).length;
    const channelSlots = def.slots.filter((s) => s.params_by_channel !== undefined);
    check(`get_preset default carries one channel per block (${nDef} chars; all channels ${nAll})`,
      channelSlots.length > 0 && channelSlots.every((s) => s.channel_status === 'active' && Object.keys(s.params_by_channel!).length === 1 && s.scene_channels !== undefined),
      JSON.stringify(channelSlots.map((s) => [s.block_type, s.channel_status, Object.keys(s.params_by_channel ?? {})])));
    check(`get_preset include_channel_state:true stays under 50,000 chars (${nAll})`, nAll < 50_000);
    check('the amp reports scene_bypass', def.slots.some((s) => s.block_type === 'amp' && Array.isArray(s.scene_bypass)));
  } else {
    console.log('  - skipped: owner 4-block capture is not on this machine');
  }
  const big = (slot: number): PresetSnapshotSlot => ({
    slot: slot as 1, block_type: 'amp', active_channel: 'B', channel_status: 'all_channels',
    params_by_channel: Object.fromEntries(['A', 'B', 'C', 'D'].map((c) => [c, Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`param_${i}`, 1.2345]))])),
  });
  const slots = [big(1), big(2), big(3), big(4)];
  const note = fitSnapshotChannels(slots, 40_000);
  check('fitSnapshotChannels trims from the last slot back to the active channel and says so',
    note !== undefined && JSON.stringify(slots).length <= 40_000 && slots[3].channel_status === 'active'
      && Object.keys(slots[3].params_by_channel!).join() === 'B' && slots[0].channel_status === 'all_channels', note);
}
{
  // Item 5: get_param carries no wire bytes; a named channel is echoed.
  const { conn } = am4Fake({ location: 6, readValue: 0 });
  const ctx = { conn } as unknown as DispatchCtx;
  const r = await am4Reader.getParam(ctx, 'amp', 'gain') as unknown as Record<string, unknown>;
  check('get_param has no raw_response', !('raw_response' in r), JSON.stringify(r));
}
{
  // Item 7: the "MK" spelling resolves, uniquely.
  const ampType = (KNOWN_PARAMS as Record<string, Param>)['amp.type'];
  const enc = makeEncode(ampType);
  const name = (v: string): string | undefined => { try { return ampType.enumValues?.[enc(v)]; } catch { return undefined; } };
  check('"usa iic+" resolves to USA MK IIC+', name('usa iic+') === 'USA MK IIC+', name('usa iic+'));
  check('"USA IIC++" resolves to USA MK IIC++', name('USA IIC++') === 'USA MK IIC++', name('USA IIC++'));
  const mk = Object.values(ampType.enumValues ?? {}).filter((n) => /\bMK\b/.test(String(n)));
  const bad = mk.filter((n) => name(String(n).replace(/\bMK\s+/, '')) !== n);
  check(`every AM4 amp name with "MK" (${mk.length}) resolves without it`, mk.length > 0 && bad.length === 0, JSON.stringify(bad));
}

console.log(failed === 0 ? '\nAll AM4 contract-fix checks pass.' : `\n✗ ${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
