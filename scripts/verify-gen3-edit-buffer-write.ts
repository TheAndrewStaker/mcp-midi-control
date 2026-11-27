/**
 * Goldens for the gen-3 edit-buffer preset-dump WRITE path (chunk A of the
 * 2026-11-25 whole-preset build) and the corrected stored-body decodes it
 * leans on:
 *
 *  1. retarget: a stored-addressed dump -> `7F 7F`, header checksum
 *     recomputed, every other byte untouched (byte-exact against the bundled
 *     fractone templates, which are device-addressed to the edit buffer);
 *  2. the per-frame ack predicate (`64 [fn] 00` ack vs refusal codes vs the
 *     0x64 status stream / other functions);
 *  3. the sender against a simulated unit: frame order, no `01 27`, per-frame
 *     ack wait, whole-transfer retry, settle, FM3 serial pacing;
 *  4. the edit-buffer read (fn=0x03 `7F 7F 00`) and the word compare with the
 *     recalculated-Amp-word allowlist (ids equal each device's catalog);
 *  5. the verified load's "resend once after 1 s" rule;
 *  6. the bundled empty templates (sha, parse, empty grid / no blocks);
 *  7. the modifier decode (source NONE = unused slot) on a synthetic body,
 *     and on the third-party fixtures when they are present locally.
 *
 * Self-contained: sections 1-7 run on a fresh clone (templates are
 * committed). Fixture checks under samples/ (gitignored) are skipped when absent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parsePresetDump, serializePresetDump } from '../packages/fractal-gen3/dist/presetDump.js';
import type { ParsedPresetDump } from '../packages/fractal-gen3/dist/presetDump.js';
import { decodeRawPatch, reencodeRawPatch } from '../packages/fractal-gen3/dist/presetHuffman.js';
import { reframeRawPatch } from '../packages/fractal-gen3/dist/presetAuthor.js';
import { decodeGen3Body, decodeGen3PresetDump } from '../packages/fractal-gen3/dist/presetBody.js';
import {
  buildEditBufferLoadFrames,
  buildRequestEditBufferPresetDump,
  classifyDumpFrameResponse,
  dumpTargetsEditBuffer,
  retargetPresetDumpToEditBuffer,
} from '../packages/fractal-gen3/dist/presetDumpEditBuffer.js';
import { loadPresetDumpToEditBuffer } from '../packages/fractal-gen3/dist/presetDumpSend.js';
import type { DumpTransferConnection } from '../packages/fractal-gen3/dist/presetDumpSend.js';
import { readEditBufferPresetDump } from '../packages/fractal-gen3/dist/presetDumpRead.js';
import { comparePresetDumps, AMP_RECALCULATED_WORDS } from '../packages/fractal-gen3/dist/presetDumpCompare.js';
import { loadPresetDumpVerified } from '../packages/fractal-gen3/dist/presetDumpLoad.js';
import { EMPTY_PRESET_TEMPLATES, loadEmptyPresetTemplate } from '../packages/fractal-gen3/dist/emptyPresetTemplates.js';
import { extractModifiers, findRecordWalkStart } from '../packages/fractal-gen3/dist/presetModifiers.js';
import { PARAMS_BY_FAMILY as III_PARAMS } from 'fractal-midi/gen3/axe-fx-iii';
import { FM3_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm3';
import { FM9_PARAMS_BY_FAMILY } from 'fractal-midi/gen3/fm9';

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) ok += 1;
  else { fail += 1; console.log(`  ✗ ${name}${detail ? `  : ${detail}` : ''}`); }
}
const hex = (b: readonly number[]): string => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const xorCs = (b: readonly number[]): number => b.reduce((a, x) => a ^ x, 0) & 0x7f;
function frame(model: number, fn: number, payload: number[]): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, model, fn, ...payload];
  return [...head, xorCs(head), 0xf7];
}

console.log('gen-3 edit-buffer preset dump write:\n');

const MODELS = [0x10, 0x11, 0x12] as const;
const templates = new Map<number, ParsedPresetDump>();
for (const m of MODELS) templates.set(m, loadEmptyPresetTemplate(m).dump);

// ── 1. retarget ───────────────────────────────────────────────────────
// Hand-computed header frames (XOR F0..last payload byte, & 0x7F).
const EXPECTED_HEADERS: Record<number, number[]> = {
  0x12: [0xf0, 0x00, 0x01, 0x74, 0x12, 0x77, 0x7f, 0x7f, 0x00, 0x40, 0x00, 0x20, 0xf7],
  0x11: [0xf0, 0x00, 0x01, 0x74, 0x11, 0x77, 0x7f, 0x7f, 0x00, 0x40, 0x00, 0x23, 0xf7],
  0x10: [0xf0, 0x00, 0x01, 0x74, 0x10, 0x77, 0x7f, 0x7f, 0x00, 0x00, 0x01, 0x63, 0xf7],
};
for (const m of MODELS) {
  const tpl = templates.get(m)!;
  check(`template 0x${m.toString(16)}: header frame byte-exact`, hex(Array.from(tpl.raw.subarray(0, 13))) === hex(EXPECTED_HEADERS[m]));
  check(`template 0x${m.toString(16)}: already targets the edit buffer`, dumpTargetsEditBuffer(tpl));
  // Re-address it to a stored preset (FM9 export header 01 17 = preset 151), then retarget back.
  const hp = Uint8Array.from(tpl.headerPayload); hp[0] = 0x01; hp[1] = 0x17;
  const storedRaw = serializePresetDump({ ...tpl, headerPayload: hp });
  const stored = parsePresetDump(storedRaw, 0, m);
  check(`0x${m.toString(16)}: stored-addressed copy does not target the edit buffer`, !dumpTargetsEditBuffer(stored));
  const before = Uint8Array.from(stored.raw);
  const back = retargetPresetDumpToEditBuffer(stored);
  check(`0x${m.toString(16)}: retarget reproduces the template byte for byte`, back.raw.length === tpl.raw.length && back.raw.every((v, i) => v === tpl.raw[i]));
  check(`0x${m.toString(16)}: retarget does not mutate its input`, stored.raw.every((v, i) => v === before[i]));
  const diffs: number[] = [];
  for (let i = 0; i < before.length; i++) if (before[i] !== back.raw[i]) diffs.push(i);
  check(`0x${m.toString(16)}: only header bytes 6, 7 and its checksum (11) change`, hex(diffs) === hex([6, 7, 11]), JSON.stringify(diffs));
  check(`0x${m.toString(16)}: retarget is idempotent`, retargetPresetDumpToEditBuffer(back).raw.every((v, i) => v === back.raw[i]));
  const frames = buildEditBufferLoadFrames(stored);
  const chunks = m === 0x10 ? 16 : 8;
  check(`0x${m.toString(16)}: load frames = 1 header + ${chunks} chunks + 1 footer`, frames.length === chunks + 2
    && frames[0][5] === 0x77 && frames[frames.length - 1][5] === 0x79 && frames.slice(1, -1).every((f) => f[5] === 0x78 && f.length === 3082));
  check(`0x${m.toString(16)}: no fn=0x01 frame (no 01 27 switch) in the load`, frames.every((f) => f[5] !== 0x01));
}

// ── 2. per-frame ack predicate ────────────────────────────────────────
{
  const m = 0x12;
  const ack78 = frame(m, 0x64, [0x78, 0x00]);
  check('ack golden bytes: F0 00 01 74 12 64 78 00 [cs] F7', hex(ack78) === 'f0 00 01 74 12 64 78 00 0b f7', hex(ack78));
  check('64 78 00 acks a 0x78 frame', classifyDumpFrameResponse(ack78, m, 0x78)?.kind === 'ack');
  check('64 78 00 does not ack a 0x77 frame (echoed fn must match)', classifyDumpFrameResponse(ack78, m, 0x77) === undefined);
  const refuse = classifyDumpFrameResponse(frame(m, 0x64, [0x78, 0x12]), m, 0x78);
  check('64 78 12 is a refusal with its code + label', refuse?.kind === 'refused' && refuse.resultCode === 0x12 && /checksum/.test(refuse.description ?? ''), JSON.stringify(refuse));
  check('a 0x64 from another model is ignored', classifyDumpFrameResponse(frame(0x10, 0x64, [0x78, 0x00]), m, 0x78) === undefined);
  check('the long 0x64 status stream is not an ack', classifyDumpFrameResponse(frame(m, 0x64, [0x78, 0x00, 1, 2, 3, 4, 5, 6]), m, 0x78) === undefined);
  check('a non-0x64 frame is not an ack', classifyDumpFrameResponse(frame(m, 0x78, [0x00, 0x00]), m, 0x78) === undefined);
  check('edit-buffer read request golden: F0 00 01 74 12 03 7F 7F 00 14 F7', hex(buildRequestEditBufferPresetDump(m)) === 'f0 00 01 74 12 03 7f 7f 00 14 f7', hex(buildRequestEditBufferPresetDump(m)));
}

// ── simulated unit ────────────────────────────────────────────────────
interface SimOpts {
  model: number;
  transportKind?: 'midi' | 'serial';
  /** Per transfer attempt (0-based) and frame index: answer to give, or 'silent'. */
  answer?: (attempt: number, frameIndex: number, fn: number) => number | 'silent';
  /** Loads (0-based) whose footer the unit "drops" (acks but keeps the old buffer). */
  dropLoads?: Set<number>;
  /** What the edit buffer holds to start with. */
  buffer: ParsedPresetDump;
  /** Mutate a loaded dump the way the unit would on import. */
  onLoad?: (d: ParsedPresetDump) => ParsedPresetDump;
  /** How the unit answers the fn=0x03 read. */
  readReply?: 'normal' | 'silent-after-head' | 'refuse';
  /** Interleave unrelated frames in the read burst. */
  strayMidBurst?: boolean;
  /** Refuse attempt 0's first chunk and trail a stale `64 78 00`. */
  lateAck?: boolean;
  /** The unit imports frames but never answers them (FM3 / III unknown-ack case). */
  noAcks?: boolean;
}
function simUnit(o: SimOpts): DumpTransferConnection & { sent: number[][]; writes: number[][]; buffer(): ParsedPresetDump; loads: number } {
  const handlers = new Set<(b: number[]) => void>();
  const sent: number[][] = [];
  const writes: number[][] = [];
  let pending: number[] = [];
  let importing: number[][] = [];
  let attempt = 0;
  let loads = 0;
  let buffer = o.buffer;
  const emit = (b: number[]): void => { queueMicrotask(() => { for (const h of [...handlers]) h(b); }); };
  const onFrame = (f: number[]): void => {
    sent.push(f);
    const fn = f[5];
    if (fn === 0x03) {
      if (o.readReply === 'silent-after-head') { emit(buildEditBufferLoadFrames(buffer)[0]); return; }
      if (o.readReply === 'refuse') { emit(frame(o.model, 0x64, [0x03, 0x03])); return; }
      const out = buildEditBufferLoadFrames(buffer);
      // Hardware answers the edit-buffer read with header `7F 00` (fractone fixture).
      const h = out[0].slice(0, -2); h[7] = 0x00;
      out[0] = [...h, xorCs(h), 0xf7];
      out.forEach((fr, i) => {
        emit(fr);
        // A stray tuner/tempo 0x64 and a foreign SysEx interleaved mid-burst.
        if (o.strayMidBurst && i === 2) { emit(frame(o.model, 0x64, [0x10, 0x01, 0x02])); emit([0xf0, 0x7e, 0x00, 0x06, 0x02, 0xf7]); emit([0x90, 0x40, 0x7f]); }
      });
      return;
    }
    if (o.lateAck && fn === 0x78 && attempt === 0 && importing.length === 1) {
      // First chunk of attempt 0: refuse now, and a stale ack trails it 30 ms later.
      emit(frame(o.model, 0x64, [0x78, 0x12]));
      setTimeout(() => { for (const h of [...handlers]) h(frame(o.model, 0x64, [0x78, 0x00])); }, 30);
      attempt++; importing = [];
      return;
    }
    if (fn === 0x77) importing = [];
    if (fn === 0x77 || fn === 0x78 || fn === 0x79) {
      importing.push(f);
      if (o.noAcks) {
        if (fn === 0x79) {
          if (!o.dropLoads?.has(loads)) buffer = parsePresetDump(new Uint8Array(importing.flat()), 0, o.model);
          loads++; attempt++;
        }
        return;
      }
      const code = o.answer ? o.answer(attempt, importing.length - 1, fn) : 0;
      if (code === 'silent') { attempt++; importing = []; return; }
      emit(frame(o.model, 0x64, [fn, code]));
      if (code !== 0) { attempt++; importing = []; return; }
      if (fn === 0x79) {
        const bytes = new Uint8Array(importing.flat());
        const d = parsePresetDump(bytes, 0, o.model);
        if (!o.dropLoads?.has(loads)) buffer = o.onLoad ? o.onLoad(d) : d;
        loads++;
        attempt++;
      }
    }
  };
  return {
    transportKind: o.transportKind,
    send: (bytes) => {
      writes.push([...bytes]);
      pending.push(...bytes);
      while (pending.includes(0xf7)) {
        const end = pending.indexOf(0xf7);
        onFrame(pending.slice(0, end + 1));
        pending = pending.slice(end + 1);
      }
    },
    onMessage: (h) => { handlers.add(h); return () => handlers.delete(h); },
    sent, writes,
    buffer: () => buffer,
    get loads() { return loads; },
  };
}
const sleeps: number[] = [];
const fakeSleep = async (ms: number): Promise<void> => { sleeps.push(ms); };

// ── 3. sender ─────────────────────────────────────────────────────────
for (const m of MODELS) {
  const tpl = templates.get(m)!;
  const hp = Uint8Array.from(tpl.headerPayload); hp[0] = 0x00; hp[1] = 0x05;
  const stored = parsePresetDump(serializePresetDump({ ...tpl, headerPayload: hp }), 0, m);
  const sim = simUnit({ model: m, buffer: stored });
  sleeps.length = 0;
  const r = await loadPresetDumpToEditBuffer(sim, m, stored, { sleep: fakeSleep, ackTimeoutMs: 50 });
  const frames = m === 0x10 ? 18 : 10;
  check(`0x${m.toString(16)}: load acked on the first attempt`, r.ok && r.attempts === 1 && r.failures.length === 0, JSON.stringify(r));
  check(`0x${m.toString(16)}: ${frames} frames sent, header addressed 7F 7F`, sim.sent.length === frames && sim.sent[0][6] === 0x7f && sim.sent[0][7] === 0x7f);
  check(`0x${m.toString(16)}: 300 ms settle after the footer ack`, sleeps[sleeps.length - 1] === 300, JSON.stringify(sleeps));
  check(`0x${m.toString(16)}: MIDI connection is not paced`, !r.paced && sim.writes.every((w) => w[0] === 0xf0 && w[w.length - 1] === 0xf7));
}
{
  const m = 0x12;
  const tpl = templates.get(m)!;
  // Refuse chunk 3 (frame index 3) on the first attempt, then accept.
  const sim = simUnit({ model: m, buffer: tpl, answer: (a, i) => (a === 0 && i === 3 ? 0x12 : 0) });
  sleeps.length = 0;
  const r = await loadPresetDumpToEditBuffer(sim, m, tpl, { sleep: fakeSleep, ackTimeoutMs: 50 });
  check('refused frame -> whole transfer retried, ok on attempt 2', r.ok && r.attempts === 2 && r.failures.length === 1
    && r.failures[0].reason === 'refused' && r.failures[0].result_code === 0x12 && r.failures[0].frame_index === 3, JSON.stringify(r));
  check('retry restarts from the 0x77 header', sim.sent[4][5] === 0x77 && sim.sent.length === 4 + 10, `sent=${sim.sent.length}`);
  check('150 ms between attempts', sleeps[0] === 150, JSON.stringify(sleeps));

  const silent = simUnit({ model: m, buffer: tpl, answer: (_a, i) => (i === 0 ? 'silent' : 0) });
  const r2 = await loadPresetDumpToEditBuffer(silent, m, tpl, { sleep: fakeSleep, ackTimeoutMs: 20 });
  check('FM9 header never acked -> not ok, no retry (no_ack on frame 0)', !r2.ok && r2.attempts === 1 && r2.failures.length === 1 && r2.failures[0].reason === 'no_ack' && r2.failures[0].fn === 0x77, JSON.stringify(r2));
  check('an un-acked frame stops the attempt (next frame not sent)', silent.sent.length === 1, `sent=${silent.sent.length}`);
  check('FM9 load result says acked', r.acked && r.mode === 'acked');

  // A send error (dead port) is not retried.
  const dead = simUnit({ model: m, buffer: tpl });
  const deadConn = { ...dead, send: (b: number[]) => { dead.send(b); }, lastSendError: new Error('port closed') };
  const r3 = await loadPresetDumpToEditBuffer(deadConn, m, tpl, { sleep: fakeSleep, ackTimeoutMs: 20 });
  check('send_error -> one attempt, not retried', !r3.ok && r3.attempts === 1 && r3.failures[0].reason === 'send_error', JSON.stringify(r3));

  // A refusal followed by a stale ack: drained, the retry is judged on its own answers.
  const late = simUnit({ model: m, buffer: tpl, lateAck: true });
  const r4 = await loadPresetDumpToEditBuffer(late, m, tpl, { sleep: fakeSleep, ackTimeoutMs: 50 });
  check('refusal + stale ack -> drained, ok on attempt 2', r4.ok && r4.attempts === 2 && late.loads === 1, JSON.stringify(r4));

  // Overall deadline: a clock already past it sends nothing.
  let t = 0;
  const r5 = await loadPresetDumpToEditBuffer(simUnit({ model: m, buffer: tpl }), m, tpl, { sleep: fakeSleep, now: () => (t += 10_000), deadlineMs: 5_000 });
  check('deadline -> not ok, reason deadline, not retried', !r5.ok && r5.attempts === 1 && r5.failures[0].reason === 'deadline', JSON.stringify(r5));
}
for (const m of [0x11, 0x10]) {
  // FM3 / III: per-frame ack unevidenced. A silent header -> the rest un-acked, 150 ms apart.
  const tpl = templates.get(m)!;
  const sim = simUnit({ model: m, buffer: tpl, noAcks: true });
  sleeps.length = 0;
  const r = await loadPresetDumpToEditBuffer(sim, m, tpl, { sleep: fakeSleep, probeMs: 20 });
  const n = m === 0x10 ? 18 : 10;
  check(`0x${m.toString(16)}: silent header -> un-acked mode, every frame sent, acked:false`, r.ok && !r.acked && r.mode === 'unacked' && sim.sent.length === n, JSON.stringify({ ...r, sent: sim.sent.length }));
  check(`0x${m.toString(16)}: un-acked frames 150 ms apart`, sleeps.filter((s) => s === 150).length === n - 1, JSON.stringify(sleeps));
  // Un-acked load judged by the read-back: holds when the unit took it.
  const vs = simUnit({ model: m, buffer: editBody(tpl, 4, 0x4242), noAcks: true });
  const v = await loadPresetDumpVerified(vs, m, tpl, { sleep: fakeSleep, probeMs: 20, readTimeoutMs: 200 });
  check(`0x${m.toString(16)}: un-acked load + matching read-back -> ok`, v.ok && v.sends[0].mode === 'unacked' && vs.loads === 1, JSON.stringify({ ok: v.ok, err: v.read_error }));
  const vd = simUnit({ model: m, buffer: editBody(tpl, 4, 0x4242), noAcks: true, dropLoads: new Set([0, 1]) });
  const vdr = await loadPresetDumpVerified(vd, m, tpl, { sleep: fakeSleep, probeMs: 20, readTimeoutMs: 200 });
  check(`0x${m.toString(16)}: un-acked load the unit did not take -> not ok (read-back is the judge)`, !vdr.ok && vdr.compare?.holds === false && vdr.sends.length === 2, JSON.stringify({ ok: vdr.ok, sends: vdr.sends.length }));

  let threw = false;
  try { await loadPresetDumpToEditBuffer(simUnit({ model: m, buffer: tpl }), m, tpl, { pacing: { chunkBytes: 64, gapMs: 3 } }); } catch { threw = true; }
  check('explicit byte pacing on a MIDI connection refuses', threw);
  threw = false;
  const other = m === 0x11 ? 0x10 : 0x11;
  try { await loadPresetDumpToEditBuffer(simUnit({ model: other, buffer: templates.get(other)! }), other, tpl); } catch { threw = true; }
  check(`a dump of another model refuses before any frame goes out (0x${m.toString(16)} dump)`, threw);
}
{
  const m = 0x11; // FM3 over USB-CDC serial
  const tpl = templates.get(m)!;
  const sim = simUnit({ model: m, buffer: tpl, transportKind: 'serial' });
  sleeps.length = 0;
  const r = await loadPresetDumpToEditBuffer(sim, m, tpl, { sleep: fakeSleep, ackTimeoutMs: 50 });
  check('FM3 serial: paced automatically', r.ok && r.paced);
  check('FM3 serial: every write is at most 64 bytes', sim.writes.every((w) => w.length <= 64), String(Math.max(...sim.writes.map((w) => w.length))));
  check('FM3 serial: writes reassemble the frames exactly', hex(sim.writes.flat()) === hex(buildEditBufferLoadFrames(tpl).flat()));
  // 12 ms after every 4 slices within a frame (never after a frame's last slice).
  const perFrame = buildEditBufferLoadFrames(tpl).map((f) => Math.floor((Math.ceil(f.length / 64) - 1) / 4));
  const want = perFrame.reduce((a, b) => a + b, 0);
  check('FM3 serial: 12 ms after every 4 slices', sleeps.filter((s) => s === 12).length === want, `${sleeps.filter((s) => s === 12).length} vs ${want}`);
}

// ── 3b. dump read robustness ──────────────────────────────────────────
{
  const m = 0x12;
  const tpl = templates.get(m)!;
  const t0 = Date.now();
  let err = '';
  try { await readEditBufferPresetDump(simUnit({ model: m, buffer: tpl, readReply: 'silent-after-head' }), m, 'sim', 500, { quietMs: 60 }); } catch (e) { err = String(e); }
  check('head then silence -> rejects on the quiet timer (no hang)', /went silent/.test(err) && Date.now() - t0 < 400, err);
  err = '';
  const t1 = Date.now();
  try { await readEditBufferPresetDump(simUnit({ model: m, buffer: tpl, readReply: 'refuse' }), m, 'sim', 5_000); } catch (e) { err = String(e); }
  check('64 03 refusal -> fails fast', /refused the dump request/.test(err) && Date.now() - t1 < 500, err);
  const back = await readEditBufferPresetDump(simUnit({ model: m, buffer: tpl, strayMidBurst: true }), m, 'sim', 500);
  check('stray 0x64 / foreign SysEx / note-on mid-burst are ignored', back.chunkPayloads.length === 8 && comparePresetDumps(tpl, back).holds);
  check('read-back header 7F 00 (as on hardware) still parses', back.headerPayload[1] === 0x00);
}

// ── 3c. load refusals ─────────────────────────────────────────────────
{
  const m = 0x12;
  const tpl = templates.get(m)!;
  const dec = decodeRawPatch(tpl.chunkPayloads);
  const erased = reframeRawPatch(tpl, new Uint8Array(dec.rawPatch.length).fill(0xff));
  const sim = simUnit({ model: m, buffer: tpl });
  const r = await loadPresetDumpVerified(sim, m, erased, { sleep: fakeSleep, ackTimeoutMs: 50 });
  check('erased slot (raw patch all 0xFF) -> refused, nothing sent', !r.ok && /ERASED/.test(r.refused ?? '') && sim.sent.length === 0, JSON.stringify({ refused: r.refused, sent: sim.sent.length }));
  // Body word 0 (scene on load) differs: exempt, reported.
  const c = comparePresetDumps(tpl, editBody(tpl, 0, 3));
  check('body word 0 (scene on load) difference holds and is reported', c.holds && c.scene_on_load?.read_back === 3, JSON.stringify(c));
}

// ── 4. read + compare ─────────────────────────────────────────────────
function editBody(d: ParsedPresetDump, byteOffset: number, value: number): ParsedPresetDump {
  const dec = decodeRawPatch(d.chunkPayloads);
  const body = Uint8Array.from(dec.body);
  body[byteOffset] = value & 0xff; body[byteOffset + 1] = (value >> 8) & 0xff;
  return reframeRawPatch(d, reencodeRawPatch(dec.rawPatch, body));
}
for (const m of MODELS) {
  const tpl = templates.get(m)!;
  const sim = simUnit({ model: m, buffer: tpl });
  const back = await readEditBufferPresetDump(sim, m, 'sim');
  check(`0x${m.toString(16)}: edit-buffer read sends 03 7F 7F 00 and parses the reply`, hex(sim.sent[0]) === hex(buildRequestEditBufferPresetDump(m)) && back.chunkPayloads.length === tpl.chunkPayloads.length);
  const same = comparePresetDumps(tpl, back);
  check(`0x${m.toString(16)}: compare of a dump with its own read-back is identical`, same.holds && same.identical, JSON.stringify(same));
  check(`0x${m.toString(16)}: allowlist evidence label`, same.allowlist_evidence === (m === 0x12 ? 'hardware-fm9' : 'unverified'));
  // A scene-name word changed: not an Amp word -> does not hold.
  const changed = comparePresetDumps(tpl, editBody(tpl, 4, 0x4141));
  check(`0x${m.toString(16)}: a changed non-Amp word does not hold (words)`, !changed.holds && changed.mismatch === 'words' && changed.unexpected_offsets[0] === 4, JSON.stringify(changed));
  // A grid cell changed: layout mismatch.
  const grid = comparePresetDumps(tpl, editBody(tpl, 0x104, 58));
  check(`0x${m.toString(16)}: a changed grid does not hold (layout)`, !grid.holds && grid.mismatch === 'layout', JSON.stringify(grid));
}
// Allowlist ids equal each device's own catalog paramId for the symbol.
{
  const cat: Record<number, readonly { name: string; paramId: number }[]> = {
    0x10: III_PARAMS.DISTORT ?? [], 0x11: FM3_PARAMS_BY_FAMILY.DISTORT ?? [], 0x12: FM9_PARAMS_BY_FAMILY.DISTORT ?? [],
  };
  for (const w of AMP_RECALCULATED_WORDS) {
    for (const m of MODELS) {
      const p = cat[m].find((x) => x.name === w.symbol);
      check(`allowlist ${w.symbol} on 0x${m.toString(16)} = catalog paramId`, p?.paramId === w.ids[m], `catalog=${p?.paramId} list=${w.ids[m]}`);
    }
  }
}

// ── 5. verified load: resend once when the first load was dropped ──────
{
  const m = 0x12;
  const tpl = templates.get(m)!;
  const old = editBody(tpl, 4, 0x4242); // what the buffer held before
  const target = editBody(tpl, 4, 0x4343);
  const sim = simUnit({ model: m, buffer: old, dropLoads: new Set([0]) });
  sleeps.length = 0;
  const r = await loadPresetDumpVerified(sim, m, target, { sleep: fakeSleep, ackTimeoutMs: 50, readTimeoutMs: 200 });
  check('dropped first load -> waits 1 s, resends once, ok', r.ok && r.resent && r.sends.length === 2 && sleeps.includes(1000), JSON.stringify({ ok: r.ok, resent: r.resent, sleeps }));
  const sim2 = simUnit({ model: m, buffer: old, dropLoads: new Set([0, 1]) });
  const r2 = await loadPresetDumpVerified(sim2, m, target, { sleep: fakeSleep, ackTimeoutMs: 50, readTimeoutMs: 200 });
  check('dropped twice -> not ok, no third send', !r2.ok && r2.resent && r2.sends.length === 2 && r2.compare?.mismatch === 'words');
  const sim3 = simUnit({ model: m, buffer: old });
  const r3 = await loadPresetDumpVerified(sim3, m, target, { sleep: fakeSleep, ackTimeoutMs: 50, readTimeoutMs: 200 });
  check('taken first time -> ok, no resend', r3.ok && !r3.resent && r3.sends.length === 1 && r3.compare?.identical === true);
}

// ── 6. bundled templates ──────────────────────────────────────────────
for (const m of MODELS) {
  const { info, dump } = loadEmptyPresetTemplate(m);
  const d = decodeGen3PresetDump(dump.raw, m);
  check(`template ${info.device}: model + chunk count`, dump.modelId === m && dump.chunkPayloads.length === (m === 0x10 ? 16 : 8));
  check(`template ${info.device}: raw-patch CRC valid`, d.crc_valid);
  check(`template ${info.device}: name "<EMPTY>"`, d.preset_name === '<EMPTY>', d.preset_name);
  check(`template ${info.device}: zero grid, zero blocks, no modifiers`, (d.grid?.length ?? 0) === 0 && (d.blocks?.length ?? -1) === 0 && !d.modifiers, JSON.stringify({ g: d.grid?.length, b: d.blocks?.length }));
  check(`template ${info.device}: an empty grid is identified as 'grid' (no false table-size warning)`, d.blocks_identified_by === 'grid', String(d.blocks_identified_by));
  check(`template ${info.device}: evidence label`, info.evidence === (m === 0x12 ? 'fm9-fractone-probe' : 'unverified'));
}
check('no VP4 template', EMPTY_PRESET_TEMPLATES[0x14] === undefined);

// ── 7. modifiers: source NONE = unused slot ───────────────────────────
{
  const m = 0x12;
  const tpl = templates.get(m)!;
  const dec = decodeRawPatch(tpl.chunkPayloads);
  const body = Uint8Array.from(dec.body);
  const ws = findRecordWalkStart(body);
  check('template: record walk found', ws > 0);
  const put = (off: number, v: number): void => { body[off] = v & 0xff; body[off + 1] = v >> 8; };
  // Slot 1: freed (source 0) but target words left behind -> must NOT report.
  put(ws + 17 * 2, 0); put(ws + 25 * 2, 70); put(ws + 26 * 2, 28);
  // Slot 2: live (FM9 source 29 = Scene Controller 1) on Amp 1 param 11.
  put(ws + 96 + 17 * 2, 29); put(ws + 96 + 25 * 2, 58); put(ws + 96 + 26 * 2, 11);
  // Slot 3: a source but a target that is not an effect id -> not reported.
  put(ws + 192 + 17 * 2, 1); put(ws + 192 + 25 * 2, 900); put(ws + 192 + 26 * 2, 3);
  const mods = extractModifiers(body, m, ws);
  check('synthetic: only the live slot is reported', mods.length === 1 && mods[0].slot === 2 && mods[0].target === 'Amp 1' && mods[0].param === 11, JSON.stringify(mods));
  check('synthetic: FM9 source 29 is named "Scene Controller 1" (device-true roster)', mods[0]?.source === 'Scene Controller 1', mods[0]?.source);
  check('synthetic: decodeGen3Body drops it, Amp 1 is not placed on the (empty) grid', decodeGen3Body(body, m).modifiers === undefined);
  check('synthetic: with Amp 1 placed it is reported', JSON.stringify(extractModifiers(body, m, ws, new Set([58]))) === JSON.stringify(mods));
  put(ws + 96 + 17 * 2, 4000); // a source id past the FM9 roster
  check('synthetic: a source id past the device roster is not a live modifier', extractModifiers(body, m, ws).length === 0);
}
const FIX = 'samples/third-party-2026-11-25';
const fx = (p: string): Uint8Array | undefined => (existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined);
{
  const p82 = fx(`${FIX}/sKuhLight_forgefx-midi/test/gen3/fm3/fixtures/preset-82.syx`);
  if (p82) {
    const d = decodeGen3PresetDump(p82, 0x11);
    check('forgefx FM3 preset-82: freed slots with stale targets dropped, External 1 -> Wah 1.5 kept',
      JSON.stringify(d.modifiers?.map((x) => `${x.source}>${x.target}.${x.param}`)) === JSON.stringify(['External 1>Wah 1.5']), JSON.stringify(d.modifiers));
  }
  const p5 = fx(`${FIX}/sKuhLight_forgefx-midi/test/gen3/fm3/fixtures/preset-5.syx`);
  if (p5) check('forgefx FM3 preset-5: a lone freed slot reports no modifier', decodeGen3PresetDump(p5, 0x11).modifiers === undefined);
  const sent = fx(`${FIX}/fractone/Presets/fm9-synthetic-ride.syx`);
  const back = fx(`${FIX}/fractone/Presets/fm9-synthetic-ride-fm9-readback.syx`);
  if (sent && back) {
    const c = comparePresetDumps(parsePresetDump(sent, 0, 0x12), parsePresetDump(back, 0, 0x12));
    check('fractone FM9 hardware read-back of the Ride template holds (only recalculated Amp words differ)',
      c.holds && !c.identical && c.recalculated.length > 0 && c.recalculated.every((w) => w.block.startsWith('Amp')), JSON.stringify({ ...c, recalculated: c.recalculated.length }));
    check('fractone FM9 read-back: the recalculated words include the three hardness words',
      ['DISTORT_CFGRID', 'DISTORT_GRIDHARDNESS', 'DISTORT_CFHARDNESS'].every((s) => c.recalculated.some((w) => w.symbol === s)),
      [...new Set(c.recalculated.map((w) => w.symbol))].join(','));
    check('fractone FM9 read-back header reads 7F 00 (not 7F 7F)', parsePresetDump(back, 0, 0x12).headerPayload[1] === 0x00);
  } else {
    console.log('  (skip) fractone Ride fixtures not present');
  }
}

console.log(`\n${ok} ok, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
