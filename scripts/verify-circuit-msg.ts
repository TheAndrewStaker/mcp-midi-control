/**
 * Golden: Novation Circuit Tracks wire codec (no hardware).
 *
 * Byte-exact targets from the handoff §"Golden test targets", confirmed
 * against the v3 Programmer's Reference Guide:
 *   - NRPN emit (env2 attack), CC signed (osc1 semitones), drum trigger,
 *     dump request, Replace-Current-Patch framing, patch-name round-trip,
 *     default-body re-encode invariant, signed windows, channel keying.
 *
 * Run via:  npx tsx scripts/verify-circuit-msg.ts
 */

import { buildNoteOn } from '@mcp-midi-control/core/midi/messages.js';
import { buildBlocks, findParam, CIRCUIT_PARAMS } from '@mcp-midi-control/circuit-tracks/params.js';
import { paramMessages, paramWire } from '@mcp-midi-control/circuit-tracks/codec/live.js';
import { writer } from '@mcp-midi-control/circuit-tracks/descriptor/writer.js';
import { buildDumpRequest, buildReplaceCurrentPatch, buildReplaceFlashPatch } from '@mcp-midi-control/circuit-tracks/codec/sysex.js';
import { decodePatch, decodePatchName, encodePatch, initPatchBody } from '@mcp-midi-control/circuit-tracks/codec/blob.js';
import { readCurrentPatch } from '@mcp-midi-control/circuit-tracks/codec/patchTransfer.js';
import { makeMessage, blockAddress, msbInterleave, crc32, intToNibbles } from '@mcp-midi-control/circuit-tracks/ncs/transfer.js';
import { decodePatchRawValues, OFFSET_BY_PARAM, validateLayout, isPatchDumpParam } from '@mcp-midi-control/circuit-tracks/codec/patchLayout.js';
import { CIRCUIT_TRACKS_DESCRIPTOR } from '@mcp-midi-control/circuit-tracks/descriptor.js';
import { reader } from '@mcp-midi-control/circuit-tracks/descriptor/reader.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? `, ${detail}` : ''}`); }
}
const eq = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (a: readonly number[]): string => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');

const blocks = buildBlocks();

// 1. NRPN emit: env2 attack = 10 on ch1 → B0 63 00 / B0 62 01 / B0 06 0A
{
  const wire = paramWire(findParam('env2', 'attack')!, 10);
  const want = [0xb0, 0x63, 0x00, 0xb0, 0x62, 0x01, 0xb0, 0x06, 0x0a];
  check('NRPN env2 attack=10 → B0 63 00 B0 62 01 B0 06 0A', eq(wire, want), hex(wire));
}

// 2. CC signed: osc1 semitones = +7 → wire 71 → B0 1A 47
{
  const wireVal = blocks.osc1.params.semitones.encode(7);
  const bytes = paramWire(findParam('osc1', 'semitones')!, wireVal);
  check('osc1 semitones +7 encodes to wire 71', wireVal === 71, String(wireVal));
  check('osc1 semitones +7 → B0 1A 47', eq(bytes, [0xb0, 0x1a, 0x47]), hex(bytes));
}

// 3. Signed windows (octave non-standard 58..69 = -6..+5)
{
  const oct = blocks.voice.params.octave;
  check('octave encode(0)=64, (-4)=60, (+4)=68',
    oct.encode(0) === 64 && oct.encode(-4) === 60 && oct.encode(4) === 68,
    `${oct.encode(0)},${oct.encode(-4)},${oct.encode(4)}`);
  check('octave decode(60) = -4', oct.decode(60) === -4, String(oct.decode(60)));
  check('octave out-of-range (+6) rejected', (() => { try { oct.encode(6); return false; } catch { return true; } })());
  check('pre_fx_level encode(0) = 64 (52..82 window)', blocks.mixer.params.pre_fx_level.encode(0) === 64);
}

// 4. Drum trigger: Drum3 (note 64) on ch10 → 99 40 <vel>
{
  const on = buildNoteOn(9, 64, 100); // wire channel 9 = MIDI ch10
  check('Drum3 hit → 99 40 64 (Note On ch10 note 64)', eq(on, [0x99, 0x40, 100]), hex(on));
  const hat = CIRCUIT_TRACKS_DESCRIPTOR.capabilities.voice_map?.hat;
  check('voice_map hat → ch10 note 64 (Drum 3)', hat?.channel === 10 && hat?.note === 64, JSON.stringify(hat));
}

// 5. Dump request Synth2 → F0 00 20 29 01 64 40 01 F7 (9 bytes)
{
  const req = buildDumpRequest(1);
  check('dump request Synth2 = F0 00 20 29 01 64 40 01 F7',
    eq(req, [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x40, 0x01, 0xf7]), hex(req));
}

// 6. Replace Current Patch Synth1 framing: 350 bytes, header, trailing F7
{
  const frame = buildReplaceCurrentPatch(initPatchBody(), 0);
  check('Replace Current Patch total length = 350', frame.length === 350, String(frame.length));
  check('Replace Current Patch header = F0 00 20 29 01 64 00 00 00',
    eq(frame.slice(0, 9), [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x00, 0x00, 0x00]), hex(frame.slice(0, 9)));
  check('Replace Current Patch ends F7', frame[349] === 0xf7);
}

// 7. Patch name round-trip (bytes 0-15, space-padded, no trim on raw)
{
  const body = initPatchBody();
  check('decode init name = "Initial Patch"', decodePatchName(body) === 'Initial Patch', decodePatchName(body));
  check('name padded to 16 with trailing spaces',
    body[12] === 'h'.charCodeAt(0) && body[13] === 0x20 && body[15] === 0x20,
    `${body[12]},${body[13]},${body[15]}`);
}

// 8. Default-body re-encode invariant (decode → encode is byte-exact)
{
  const body = initPatchBody();
  check('decodePatch→encodePatch round-trips byte-exact', eq(encodePatch(decodePatch(body)), body));
}

// 9. Enum encode/decode
{
  check('filter.type encode("LP24")=1, decode(1)="LP24"',
    blocks.filter.params.type.encode('LP24') === 1 && blocks.filter.params.type.decode(1) === 'LP24');
  // OSC saw-blend table is DESCENDING per the PDF (3=9:1 … 11=1:9); locks the
  // transcription so the invented-ascending-labels bug can't recur.
  check('osc1.wave "Saw 9:1 PW"=3 round-trips',
    blocks.osc1.params.wave.encode('Saw 9:1 PW') === 3 && blocks.osc1.params.wave.decode(3) === 'Saw 9:1 PW');
  check('osc1.wave decode(11)="Saw 1:9 PW"', blocks.osc1.params.wave.decode(11) === 'Saw 1:9 PW');
}

// 9b. Full drum-CC map locked to the PDF (raw flow-order extraction, pages 10-12).
{
  const DRUM_CC: Record<string, Record<string, number>> = {
    drum1: { patch: 8, level: 12, pitch: 14, decay: 15, distortion: 16, eq: 17, pan: 77 },
    drum2: { patch: 18, level: 23, pitch: 34, decay: 40, distortion: 42, eq: 43, pan: 78 },
    drum3: { patch: 44, level: 45, pitch: 46, decay: 47, distortion: 48, eq: 49, pan: 79 },
    drum4: { patch: 50, level: 53, pitch: 55, decay: 57, distortion: 61, eq: 76, pan: 80 },
  };
  let ok = true; let bad = '';
  for (const [blk, params] of Object.entries(DRUM_CC)) {
    for (const [name, cc] of Object.entries(params)) {
      const p = findParam(blk, name);
      const a = p?.addr;
      if (!p || p.channel !== 10 || !a || a.kind !== 'cc' || a.cc !== cc) { ok = false; bad = `${blk}.${name} expected ch10 CC${cc}`; break; }
    }
    if (!ok) break;
  }
  check('all 28 drum params map to the PDF CC numbers on ch10', ok, bad);
}

// 10. Channel keying (no CC collision: keyed by channel/scope, not CC number)
{
  check('drum1.level → ch10 CC12', (() => { const p = findParam('drum1', 'level')!; return p.channel === 10 && p.addr.kind === 'cc' && p.addr.cc === 12; })());
  check('master_filter.frequency → ch16', findParam('master_filter', 'frequency')!.channel === 16);
  check('osc1.semitones → ch1', findParam('osc1', 'semitones')!.channel === 1);
}

// 11. Macro positions (CC 80-87) + Synth 2 channel override at the codec level
{
  check('macros.macro_1 → CC80 ch1 (B0 50 64)', eq(paramWire(findParam('macros', 'macro_1')!, 100), [0xb0, 80, 100]));
  const a8 = findParam('macros', 'macro_8')!.addr;
  check('macros.macro_8 → CC87', a8.kind === 'cc' && a8.cc === 87);
  check('macro_1 on ch2 override → B1 50 64', eq(paramMessages(findParam('macros', 'macro_1')!, 100, { channel: 2 }).flat(), [0xb1, 80, 100]));
}

// 12. Mod matrix NRPN addresses + source/destination enums (handoff §5/§6)
{
  check('mod1.depth → NRPN 1:86', eq(paramWire(findParam('mod1', 'depth')!, 64), [0xb0, 99, 1, 0xb0, 98, 86, 0xb0, 6, 64]));
  const d12 = findParam('mod12', 'destination')!.addr;
  check('mod12.destination → NRPN 2:13', d12.kind === 'nrpn' && d12.msb === 2 && d12.lsb === 13);
  check('mod1.source1 encode("LFO1+")=6, decode round-trips',
    blocks.mod1.params.source1.encode('LFO1+') === 6 && blocks.mod1.params.source1.decode(6) === 'LFO1+');
  check('mod1.destination encode("Filter Frequency")=12', blocks.mod1.params.destination.encode('Filter Frequency') === 12);
}

// 13. Project track mixer (ch16), no CC collision with drum levels (ch10)
{
  check('track_mixer.synth1_level → CC12 ch16 (BF 0C 64)', eq(paramWire(findParam('track_mixer', 'synth1_level')!, 100), [0xbf, 12, 100]));
  check('track_mixer.synth1_pan signed center 64', blocks.track_mixer.params.synth1_pan.encode(0) === 64);
  check('CC12 disambiguated by channel (track_mixer ch16 vs drum1 ch10)',
    findParam('track_mixer', 'synth1_level')!.channel === 16 && findParam('drum1', 'level')!.channel === 10);
}

// 14. Synth 2 via instance — through the REAL writer against a fake connection
{
  type Ctx = Parameters<NonNullable<typeof writer.setParam>>[0];
  const sent: number[][] = [];
  const ctx = { conn: { send: (b: number[]) => sent.push([...b]) }, descriptor: CIRCUIT_TRACKS_DESCRIPTOR } as unknown as Ctx;
  await writer.setParam!(ctx, 'osc1', 'semitones', 71, undefined, 2);
  check('Synth 2: instance 2 emits on ch2 (B1 1A 47)', sent.length === 1 && eq(sent[0], [0xb1, 0x1a, 0x47]), JSON.stringify(sent));
  sent.length = 0;
  await writer.setParam!(ctx, 'osc1', 'semitones', 71, undefined, 1);
  check('Synth 1: instance 1 emits on ch1 (B0 1A 47)', sent.length === 1 && eq(sent[0], [0xb0, 0x1a, 0x47]));
  let threw = false;
  try { await writer.setParam!(ctx, 'drum1', 'level', 100, undefined, 2); } catch { threw = true; }
  check('instance 2 on a drum param is rejected', threw);
}

// 15. Per-track FX sends (handoff §8): 6 reverb + 6 delay, all CC on ch16.
{
  const SENDS: Record<string, Record<string, number>> = {
    reverb: { synth1_send: 88, synth2_send: 89, drum1_send: 90, drum2_send: 106, drum3_send: 109, drum4_send: 110 },
    delay: { synth1_send: 111, synth2_send: 112, drum1_send: 113, drum2_send: 114, drum3_send: 115, drum4_send: 116 },
  };
  let ok = true; let bad = '';
  for (const [blk, sends] of Object.entries(SENDS)) {
    for (const [name, cc] of Object.entries(sends)) {
      const p = findParam(blk, name);
      const a = p?.addr;
      if (!p || p.channel !== 16 || !a || a.kind !== 'cc' || a.cc !== cc) { ok = false; bad = `${blk}.${name} expected ch16 CC${cc}`; break; }
    }
    if (!ok) break;
  }
  check('all 12 FX sends map to the PDF CC numbers on ch16', ok, bad);
  check('reverb.synth1_send → BF 58 64 (CC88 ch16)', eq(paramWire(findParam('reverb', 'synth1_send')!, 100), [0xbf, 88, 100]));
  check('delay.drum4_send → BF 74 7F (CC116 ch16)', eq(paramWire(findParam('delay', 'drum4_send')!, 127), [0xbf, 116, 127]));
  check('reverb send default is dry (0)', findParam('reverb', 'synth1_send')!.default === 0);
}

// 15b. Sidechain (handoff §8): per-synth, distinct NRPN address sets on ch16.
{
  const s1src = findParam('sidechain1', 'source')!;
  check('sidechain1.source → ch16 NRPN 2:55', s1src.channel === 16 && s1src.addr.kind === 'nrpn' && s1src.addr.msb === 2 && s1src.addr.lsb === 55);
  check('sidechain1.depth → NRPN 2:59', eq(paramWire(findParam('sidechain1', 'depth')!, 100), [0xbf, 99, 2, 0xbf, 98, 59, 0xbf, 6, 100]));
  check('sidechain2.source → NRPN 2:65', (() => { const a = findParam('sidechain2', 'source')!.addr; return a.kind === 'nrpn' && a.msb === 2 && a.lsb === 65; })());
  check('sidechain2.depth → NRPN 2:69 (VERIFY note carried)', (() => { const p = findParam('sidechain2', 'depth')!; return p.addr.kind === 'nrpn' && p.addr.lsb === 69 && !!p.notes; })());
  check('sidechain1.source enum: "Drum 1"=0, decode(4)="OFF", default OFF',
    blocks.sidechain1.params.source.encode('Drum 1') === 0 && blocks.sidechain1.params.source.decode(4) === 'OFF' && findParam('sidechain1', 'source')!.default === 4);
}

// 15c. Per-macro A-D routing (handoff §5): NRPN MSB 3, ch1, 128 params total.
{
  const a = findParam('macro1', 'a_destination')!;
  check('macro1.a_destination → ch1 NRPN 3:0', a.channel === 1 && a.addr.kind === 'nrpn' && a.addr.msb === 3 && a.addr.lsb === 0);
  check('macro1.a_depth → NRPN 3:3, bipolar center 64', eq(paramWire(findParam('macro1', 'a_depth')!, 64), [0xb0, 99, 3, 0xb0, 98, 3, 0xb0, 6, 64]) && blocks.macro1.params.a_depth.encode(0) === 64);
  check('macro8.d_depth → NRPN 3:127 (last routing LSB)', (() => { const x = findParam('macro8', 'd_depth')!.addr; return x.kind === 'nrpn' && x.msb === 3 && x.lsb === 127; })());
  const routingCount = CIRCUIT_PARAMS.filter((p) => /^macro[1-8]$/.test(p.block)).length;
  check('macro routing = 128 params (8 knobs x 4 slots x 4 fields)', routingCount === 128, String(routingCount));
  check('macro1.a_destination instance:2 → ch2 (NRPN MSB on B1)', eq(paramMessages(a, 5, { channel: 2 }).flat(), [0xb1, 99, 3, 0xb1, 98, 0, 0xb1, 6, 5]));
}

// 16. Registry invariant: no two params share the same (channel, addr). CCs and
// NRPNs are allowed to repeat ACROSS channels (the scope disambiguates), never
// within one. Catches a fat-fingered duplicate the moment it is added.
{
  const seen = new Map<string, string>();
  let dup = '';
  for (const cp of CIRCUIT_PARAMS) {
    const key = cp.addr.kind === 'cc'
      ? `ch${cp.channel}/cc${cp.addr.cc}`
      : `ch${cp.channel}/nrpn${cp.addr.msb}:${cp.addr.lsb}`;
    const prior = seen.get(key);
    if (prior) { dup = `${key}: ${prior} vs ${cp.block}.${cp.name}`; break; }
    seen.set(key, `${cp.block}.${cp.name}`);
  }
  check('no (channel, addr) collision across the whole registry', dup === '', dup);
}

// 17. Replace Patch (Flash write) framing: 5-byte prefix `01 00 <slotHi> <slotLo> 00`,
// 352 bytes total. Byte-matched to a real Components capture (components-patch-save.pcapng):
// four Replace-Patch messages to slots 0-3 all carry the slot at body-offset 3.
{
  const frame = buildReplaceFlashPatch(initPatchBody(), 7);
  check('Replace Patch total length = 352', frame.length === 352, String(frame.length));
  check('Replace Patch header = F0 00 20 29 01 64 01 00 00 07 00 (cmd 01, 00 00, slot 7, 00)',
    eq(frame.slice(0, 11), [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x01, 0x00, 0x00, 0x07, 0x00]), hex(frame.slice(0, 11)));
  check('Replace Patch ends F7', frame[351] === 0xf7);
  check('Replace Patch slot out of range (64) rejected',
    (() => { try { buildReplaceFlashPatch(initPatchBody(), 64); return false; } catch { return true; } })());
}

// 18. readCurrentPatch: dump request → parse the device's Replace-Current reply.
// Offline fake connection that synthesizes the device's USB reply on a dump req.
{
  const body = initPatchBody(); // the device's "current" Synth 1 sound
  let handler: ((b: number[]) => void) | undefined;
  const conn = {
    hasInput: true,
    isPortOpen: () => true,
    onMessage: (h: (b: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
    send: (b: number[]) => { if (b.length === 9 && b[6] === 0x40) handler?.(buildReplaceCurrentPatch(body, b[7] as 0 | 1)); },
  } as unknown as Parameters<typeof readCurrentPatch>[0];
  const res = await readCurrentPatch(conn, 0);
  check('readCurrentPatch returns a 340-byte body', res.ok && res.body?.length === 340, res.error);
  check('readCurrentPatch body byte-exact to the reply', !!res.body && eq(Array.from(res.body), body));
  check('readCurrentPatch decodes the name "Initial Patch"', !!res.body && decodePatchName(res.body) === 'Initial Patch');
}

// 19. savePreset end-to-end through the REAL writer: reads Synth 1 RAM, then
// writes a Replace-Patch (Flash) frame to the slot, with a name override.
{
  type SaveCtx = Parameters<NonNullable<typeof writer.savePreset>>[0];
  const ram = initPatchBody();
  // body[17] is `Patch_Genre` (0..9), NOT the "dirty edit-buffer marker" the
  // 2026-07-03 review called it (refuted 2026-07-29; see patchTransfer.savePatch).
  // 7 is deliberate: it is a value no boolean flag could hold, so this golden pins
  // the KNOWN, deliberate data loss rather than re-asserting the refuted reading.
  ram[17] = 0x07;
  ram[16] = 0x0a; // Patch_Category "Poly" — the header-region CONTROL for the check below
  const sent: number[][] = [];
  let handler: ((b: number[]) => void) | undefined;
  const commit08 = [0xf0, 0x00, 0x20, 0x29, 0x01, 0x64, 0x08, 0x00, 0xf7]; // device post-CLOSE 0x08 ack
  const conn = {
    hasInput: true,
    isPortOpen: () => true,
    onMessage: (h: (b: number[]) => void) => { handler = h; return () => { handler = undefined; }; },
    send: (b: number[]) => {
      sent.push([...b]);
      if (b.length === 9 && b[6] === 0x40) handler?.(buildReplaceCurrentPatch(ram, b[7] as 0 | 1));  // dump reply
      if (b.length >= 9 && b[6] === 0x03 && b[7] === 0x41) handler?.(commit08);                       // ack CLOSE with 0x08
    },
  };
  const ctx = { conn, descriptor: CIRCUIT_TRACKS_DESCRIPTOR } as unknown as SaveCtx;
  const res = await writer.savePreset!(ctx, 5, 'My Bass');
  const flash = sent.find((m) => m.length === 352 && m[6] === 0x01);
  check('savePreset dumps Synth 1 (loc 0) then emits a Replace-Patch (cmd 01) frame', !!flash);
  check('savePreset targets Flash slot 5 (slot at body-offset 3, m[9])', !!flash && flash[9] === 5);
  check('savePreset wrote the new name into the body name region', !!flash && decodePatchName(flash.slice(11, 11 + 16)) === 'My Bass');
  check('savePreset zeroes body[17]=Patch_Genre (frame[28] → 0x00; ram had genre 7). KNOWN LOSS, open: HW-CIRCUIT-008', !!flash && flash[28] === 0x00, flash ? `frame[28]=${flash[28]}` : 'no frame');
  // Companion: byte 16 `Patch_Category` is NOT zeroed. This is what proves the
  // header region is passed through in general and that byte 17 alone is the
  // casualty, so a future fix has a same-file control to compare against.
  check('savePreset PRESERVES body[16]=Patch_Category (ram had 10 → frame[27] = 10)', !!flash && flash[27] === 0x0a, flash ? `frame[27]=${flash[27]}` : 'no frame');
  check('savePreset result acked, target "patch slot 5"', res.acked && res.target === 'patch slot 5', JSON.stringify({ acked: res.acked, target: res.target }));

  let threw = false;
  try {
    const noInput = { conn: { ...conn, hasInput: false }, descriptor: CIRCUIT_TRACKS_DESCRIPTOR } as unknown as SaveCtx;
    await writer.savePreset!(noInput, 5);
  } catch { threw = true; }
  check('savePreset refuses without a bidirectional connection', threw);

  // instance 2 → Synth 2: the Dump Request must target loc 1, and the receipt
  // names Synth 2. Re-use the same fake conn (records every send in `sent`).
  sent.length = 0;
  const res2 = await writer.savePreset!(ctx, 9, undefined, 2);
  const dumpReq = sent.find((m) => m.length === 9 && m[6] === 0x40);
  check('savePreset instance 2 sends a Dump Request for Synth 2 (loc 1)', !!dumpReq && dumpReq[7] === 1, JSON.stringify(dumpReq));
  check('savePreset instance 2 receipt names Synth 2 + slot 9',
    res2.target === 'patch slot 9' && /Synth 2/.test(res2.info ?? ''), res2.info);
  let threw2 = false;
  try { await writer.savePreset!(ctx, 9, undefined, 3); } catch { threw2 = true; }
  check('savePreset rejects instance 3 (only two synth engines)', threw2);
}

// 20. Overwrite gate: reads the target Flash patch slot (occupied → name; no input → degrade).
{
  type OWCtx = Parameters<NonNullable<typeof reader.checkOverwriteTarget>>[0];
  // A mock that replies to a read WRITE_INIT with an occupied patch named "Existing".
  const occFile = new Uint8Array(340);
  for (let i = 0; i < 'Existing'.length; i++) occFile[i] = 'Existing'.charCodeAt(i);
  occFile.fill(0x20, 'Existing'.length, 16); // space-pad the name region
  const fidO = [0x04, 0x00, 5];
  const rInit = makeMessage(0x01, [...blockAddress(0), ...fidO, 0x01, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0]);
  const rData = makeMessage(0x02, [...blockAddress(1), ...fidO, ...msbInterleave(occFile)]);
  const rFin = makeMessage(0x03, [...blockAddress(2), ...fidO, ...intToNibbles(crc32(occFile), 8)]);
  const occConn = {
    hasInput: true, isPortOpen: () => true,
    onMessage: (h: (b: number[]) => void) => { (occConn as { _h?: (b: number[]) => void })._h = h; return () => {}; },
    send: (b: number[]) => { if (b.length >= 12 && b[6] === 0x03 && b[7] === 0x01 && b[b.length - 2] === 0x02) { const h = (occConn as { _h?: (b: number[]) => void })._h; h?.(rInit); h?.(rData); h?.(rFin); } },
  } as { _h?: (b: number[]) => void } & Record<string, unknown>;
  const occCtx = { conn: occConn, descriptor: CIRCUIT_TRACKS_DESCRIPTOR } as unknown as OWCtx;

  const occ = await reader.checkOverwriteTarget!(occCtx, 5);
  check('checkOverwriteTarget: OCCUPIED slot surfaces the patch name → gate refuses',
    !!occ && occ.occupant_name === 'Existing' && occ.is_active_location === false, JSON.stringify(occ));
  const noInput = await reader.checkOverwriteTarget!({ conn: { hasInput: false } } as unknown as OWCtx, 5);
  check('checkOverwriteTarget: no input → undefined (dispatcher degrades, does not hard-refuse)', noInput === undefined);
  const bad = await reader.checkOverwriteTarget!({ conn: { hasInput: true } } as unknown as OWCtx, 99);
  check('checkOverwriteTarget: out-of-range slot → undefined (writer raises bad_location)', bad === undefined);
}

// 21. Structured patch layout (Leg 2): self-consistency + offset anchors.
{
  const problems = validateLayout();
  check('patch layout self-consistent (every offset unique, in range, maps to a registry param)', problems.length === 0, problems.join('; '));
  // §13 offsets that the 128-patch oracle confirms (scripts/decode-circuit-patches.ts).
  check('filter.frequency at offset 64', OFFSET_BY_PARAM.get('filter.frequency') === 64);
  check('eq.treble_frequency at offset 109', OFFSET_BY_PARAM.get('eq.treble_frequency') === 109);
  check('fx.distortion_compensation at offset 117', OFFSET_BY_PARAM.get('fx.distortion_compensation') === 117);
  check('drum/project/macro params are NOT in the patch dump', !isPatchDumpParam('drum1', 'level') && !isPatchDumpParam('mod1', 'depth'));
}

// 22. Structured decode + get_param end-to-end through the REAL reader.
{
  // Craft a body with known values at their §13 offsets.
  const body = initPatchBody();
  body[OFFSET_BY_PARAM.get('filter.frequency')!] = 100;
  body[OFFSET_BY_PARAM.get('filter.type')!] = 1;       // enum → "LP24"
  body[OFFSET_BY_PARAM.get('osc1.semitones')!] = 71;   // signed → +7

  const raw = decodePatchRawValues(body);
  check('decodePatchRawValues reads filter.frequency=100', raw.get('filter.frequency') === 100, String(raw.get('filter.frequency')));

  type GetCtx = Parameters<NonNullable<typeof reader.getParam>>[0];
  const conn = {
    hasInput: true,
    isPortOpen: () => true,
    onMessage: (h: (b: number[]) => void) => { (conn as { _h?: (b: number[]) => void })._h = h; return () => { (conn as { _h?: (b: number[]) => void })._h = undefined; }; },
    send: (b: number[]) => { if (b.length === 9 && b[6] === 0x40) (conn as { _h?: (b: number[]) => void })._h?.(buildReplaceCurrentPatch(body, b[7] as 0 | 1)); },
  } as { _h?: (b: number[]) => void } & Record<string, unknown>;
  const ctx = { conn, descriptor: CIRCUIT_TRACKS_DESCRIPTOR } as unknown as GetCtx;

  const fq = await reader.getParam!(ctx, 'filter', 'frequency');
  check('get_param filter.frequency → wire 100, display 100', fq.wire_value === 100 && fq.display_value === 100, JSON.stringify(fq));
  const ty = await reader.getParam!(ctx, 'filter', 'type');
  check('get_param filter.type → enum "LP24"', ty.display_value === 'LP24', JSON.stringify(ty.display_value));
  const semi = await reader.getParam!(ctx, 'osc1', 'semitones');
  check('get_param osc1.semitones → signed display +7', semi.display_value === 7, JSON.stringify(semi.display_value));

  let threw = false;
  try { await reader.getParam!(ctx, 'drum1', 'level'); } catch { threw = true; }
  check('get_param refuses a non-patch-dump param (drum1.level)', threw);
}

// 23. get_params batch: mixed queries, ONE dump per part, per-query failure isolation.
{
  const body = initPatchBody();
  body[OFFSET_BY_PARAM.get('filter.frequency')!] = 100;
  body[OFFSET_BY_PARAM.get('filter.type')!] = 1;
  let dumps = 0;
  const conn = {
    hasInput: true,
    isPortOpen: () => true,
    onMessage: (h: (b: number[]) => void) => { (conn as { _h?: (b: number[]) => void })._h = h; return () => { (conn as { _h?: (b: number[]) => void })._h = undefined; }; },
    send: (b: number[]) => { if (b.length === 9 && b[6] === 0x40) { dumps++; (conn as { _h?: (b: number[]) => void })._h?.(buildReplaceCurrentPatch(body, b[7] as 0 | 1)); } },
  } as { _h?: (b: number[]) => void } & Record<string, unknown>;
  type GetCtx = Parameters<NonNullable<typeof reader.getParams>>[0];
  const ctx = { conn, descriptor: CIRCUIT_TRACKS_DESCRIPTOR } as unknown as GetCtx;

  const res = await reader.getParams!(ctx, [
    { block: 'filter', name: 'frequency' },
    { block: 'filter', name: 'type' },
    { block: 'drum1', name: 'level' },  // not in the patch dump → failed
  ]);
  check('get_params: 2 good reads, 1 failure isolated', res.reads.length === 2 && res.failed_indices.length === 1 && res.failed_indices[0] === 2, JSON.stringify({ reads: res.reads.length, failed: res.failed_indices }));
  check('get_params: filter.frequency=100 + filter.type="LP24"',
    res.reads[0].display_value === 100 && res.reads[1].display_value === 'LP24', JSON.stringify(res.reads.map((r) => r.display_value)));
  check('get_params: only ONE dump issued for two same-part (Synth 1) queries', dumps === 1, `dumps=${dumps}`);
}

// 24. get_preset("patch:N") — stored bank-patch read via PC-load + dump (the
// store save_preset writes to), through the REAL reader with a mock dump reply.
{
  const patchName = 'StoredTest';
  const body = initPatchBody();
  for (let i = 0; i < patchName.length; i++) body[i] = patchName.charCodeAt(i);
  body.fill(0x20, patchName.length, 16); // space-pad the name region (real device behavior)
  let h: ((b: number[]) => void) | undefined;
  const conn = {
    hasInput: true,
    isPortOpen: () => true,
    onMessage: (fn: (b: number[]) => void) => { h = fn; return () => { h = undefined; }; },
    // Reply to every Dump Request (cmd 0x40) with the stored patch body (PC-load +
    // restore Replace-Current are ignored — the mock always returns `body`).
    send: (b: number[]) => { if (b.length === 9 && b[6] === 0x40) h?.(buildReplaceCurrentPatch(body, b[7] as 0 | 1)); },
  };
  type GetPCtx = Parameters<NonNullable<typeof reader.getPreset>>[0];
  const ctx = { conn, descriptor: CIRCUIT_TRACKS_DESCRIPTOR } as unknown as GetPCtx;

  const snap = await reader.getPreset!(ctx, { location: 'patch:5' });
  check('get_preset("patch:5") returns the loaded bank-patch name', snap.name === patchName, snap.name);
  check('get_preset patch snapshot: patch_name + decoded synth params present',
    snap.slots[0]?.params?.patch_name === patchName && 'filter.frequency' in (snap.slots[0]?.params ?? {}),
    JSON.stringify(Object.keys(snap.slots[0]?.params ?? {}).slice(0, 4)));
  let threw = false;
  try { await reader.getPreset!(ctx, { location: 'patch:99' }); } catch { threw = true; }
  check('get_preset("patch:99") rejects out-of-range slot', threw);
}

console.log('');
if (failed > 0) { console.error(`x ${failed} circuit-msg check(s) FAILED.`); process.exit(1); }
console.log('OK verify-circuit-msg: Circuit Tracks wire codec golden verified.');
