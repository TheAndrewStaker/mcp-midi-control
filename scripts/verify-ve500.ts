// Golden + invariant checks for the Boss VE-500 codec and descriptor.
//
// Anchors are hand-verified DT1/RQ1 frames; the bulk is structural invariants
// over the full generated catalog (every frame is MIDI-safe + checksum-correct,
// every value round-trips encode->decode). Run: npx tsx scripts/verify-ve500.ts

import {
  rolandChecksum,
  encodeWire,
  decodeWire,
  wireByteCount,
  Size,
} from 'roland-midi/shared';
import {
  VE500_PARAMS,
  VE500_SYSTEM_PARAMS,
  findParam,
  buildSetParam,
  buildGetParam,
  buildSavePreset,
  buildCommMode,
  buildSwitchPatch,
  saveAckMatcher,
  decodeParamReply,
  TEMP_PATCH_ADDR,
} from 'roland-midi/ve-500';
import { VE500_DESCRIPTOR } from '@mcp-midi-control/ve-500/descriptor.js';
import { writer } from '@mcp-midi-control/ve-500/descriptor/writer.js';
import { reader } from '@mcp-midi-control/ve-500/descriptor/reader.js';
import { collectApplyPresetPreflight } from '@mcp-midi-control/core/protocol-generic/dispatcher/preflight.js';

let failures = 0;
const hex = (a: readonly number[]) =>
  a.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

function check(label: string, ok: boolean, detail = '') {
  if (!ok) {
    failures++;
    console.log(`FAIL: ${label}${detail ? `\n  ${detail}` : ''}`);
  }
}

// ── 1. Roland checksum against a hand-computed vector ──────────────────────
check(
  'rolandChecksum([0x20,0x00,0x20,0x01,0x32]) === 0x0D',
  rolandChecksum([0x20, 0x00, 0x20, 0x01, 0x32]) === 0x0d,
);

// ── 2. Hand-verified DT1 / RQ1 frames (enhancer.enhance on the active patch) ─
{
  const def = findParam('enhancer', 'enhance')!;
  const set = buildSetParam(def, 50);
  const setExpect = 'F0 41 10 00 00 00 55 12 20 00 20 01 32 0D F7';
  check('DT1 enhancer.enhance=50', hex(set) === setExpect, `got ${hex(set)}`);

  const get = buildGetParam(def);
  const getExpect = 'F0 41 10 00 00 00 55 11 20 00 20 01 00 00 00 01 3E F7';
  check('RQ1 enhancer.enhance', hex(get) === getExpect, `got ${hex(get)}`);

  // read-back round-trip: a synthetic DT1 reply decodes to the value we set
  check('decodeParamReply round-trips', decodeParamReply(def, set) === 50);
}

// Independent anchor: a multi-byte INTEGER3x4 param at a HIGH section base
// (fx1.delay_time_1, section PatchFX1 @ 0x9000), so the nibble packing AND the
// 7-bit address spread are checked where they actually matter. Frame computed
// by hand: value 400 = 0x190 -> nibbles [01 09 00]; abs addr 0x0400906A ->
// _7bitize -> 20 02 20 6A; checksum over 20 02 20 6A 01 09 00 = 0x4A.
{
  const def = findParam('fx1', 'delay_time_1')!;
  const set = buildSetParam(def, 400);
  const expect = 'F0 41 10 00 00 00 55 12 20 02 20 6A 01 09 00 4A F7';
  check('DT1 fx1.delay_time_1=400 (INTEGER3x4, high section)', hex(set) === expect, `got ${hex(set)}`);
  check('fx1.delay_time_1 read-back round-trips', decodeParamReply(def, set) === 400);
}

// ── 3. INTEGERnx4 nibble packing round-trips ────────────────────────────────
for (const [size, v] of [
  [Size.INTEGER2x4, 0xab],
  [Size.INTEGER3x4, 0xabc],
  [Size.INTEGER4x4, 1234],
  [Size.INTEGER6x4, 0xabcdef],
] as const) {
  const bytes = encodeWire(size, v, 0);
  check(
    `nibble round-trip size=0x${size.toString(16)} v=${v}`,
    bytes.length === wireByteCount(size) &&
      bytes.every((b) => b <= 0x0f) &&
      decodeWire(size, bytes, 0) === v,
    `bytes=${hex(bytes)}`,
  );
}

// ── 4. Structural invariants over EVERY settable catalog param ──────────────
let checkedParams = 0;
for (const def of VE500_PARAMS) {
  if (def.size < 0x10000) continue; // skip the ASCII patch-name
  checkedParams++;
  // encode min, mid, max; every resulting frame must be MIDI-safe + checksummed
  const samples = [def.min, Math.round((def.min + def.max) / 2), def.max];
  for (const v of samples) {
    const frame = buildSetParam(def, v);
    const bodyOk =
      frame[0] === 0xf0 &&
      frame[frame.length - 1] === 0xf7 &&
      frame.slice(1, -1).every((b) => b <= 0x7f);
    // recompute checksum over addr+data (positions 8..len-3)
    const body = frame.slice(8, frame.length - 2);
    const cksumOk = frame[frame.length - 2] === rolandChecksum(body);
    const rt = decodeParamReply(def, frame);
    if (!bodyOk || !cksumOk || rt !== v) {
      check(
        `param ${def.block}.${def.param} v=${v}`,
        false,
        `bodyOk=${bodyOk} cksumOk=${cksumOk} rt=${rt} frame=${hex(frame)}`,
      );
      break;
    }
  }
}
check(`catalog params checked (>800)`, checkedParams > 800, `got ${checkedParams}`);

// ── 5. Descriptor path: schema encode/decode + writer.buildSetParam ─────────
{
  const blocks = VE500_DESCRIPTOR.blocks;
  check('descriptor exposes >40 blocks', Object.keys(blocks).length > 40);

  const eh = blocks['enhancer']?.params['enhance'];
  check('enhancer.enhance schema present', !!eh);
  if (eh) {
    check('schema.encode(50)===50', eh.encode(50) === 50);
    check('schema.decode(50)===50', eh.decode(50) === 50);
    check(
      'schema.encode rejects out-of-range',
      (() => {
        try {
          eh.encode(999);
          return false;
        } catch {
          return true;
        }
      })(),
    );
  }

  // a genuine *Switch param surfaces on/off
  const sw = blocks['enhancer']?.params['switch'];
  check('switch encodes on->1 / off->0', !!sw && sw.encode('on') === 1 && sw.encode('off') === 0);
  check('switch decodes 1->ON', !!sw && sw.decode(1) === 'ON');
  check('switch unit is bool', sw?.unit === 'bool');

  // 2-value MODE selectors now carry editor labels (enum), not bool ON/OFF
  const rs = blocks['fx1']?.params['rotary_speed'];
  check('rotary_speed is enum (not bool/count)', rs?.unit === 'enum');
  check('rotary_speed labels = SLOW/FAST', rs?.enum_values?.[0] === 'SLOW' && rs?.enum_values?.[1] === 'FAST');
  check('rotary_speed encodes "fast" -> 1', rs?.encode('fast') === 1);
  check('rotary_speed encodes "SLOW" -> 0', rs?.encode('SLOW') === 0);
  check('rotary_speed decodes 1 -> "FAST"', rs?.decode(1) === 'FAST');
  check('rotary_speed rejects a bogus label', !!rs && (() => { try { rs.encode('sideways'); return false; } catch { return true; } })());

  // type/voice selectors carry the full editor roster
  const fxType = blocks['fx1']?.params['type'];
  check('fx1.type is enum with 20 entries', fxType?.unit === 'enum' && Object.keys(fxType?.enum_values ?? {}).length === 20);
  check('fx1.type encodes "Chorus" -> 6', fxType?.encode('Chorus') === 6);
  check('fx1.type encodes "reverb" -> 19', fxType?.encode('reverb') === 19);
  const voice = blocks['harmony1']?.params['voice_manual'];
  check('harmony1.voice_manual encodes "+3RD" -> 7', voice?.encode('+3RD') === 7);
  check('harmony1.voice_manual decodes 9 -> "+5TH"', voice?.decode(9) === '+5TH');
  const pcType = blocks['pitch_correct']?.params['type'];
  check('pitch_correct.type encodes "robot" -> 3', pcType?.encode('robot') === 3);

  // writer.buildSetParam matches the codec
  const wbuilt = writer.buildSetParam!('enhancer', 'enhance', 50);
  check(
    'writer.buildSetParam == codec',
    hex(wbuilt) === 'F0 41 10 00 00 00 55 12 20 00 20 01 32 0D F7',
  );
  // every catalog write targets the active (temporary) patch base
  check('temp patch base is 0x04000000', TEMP_PATCH_ADDR === 0x04000000);
}

// ── 6. switch_preset Program Change mapping ─────────────────────────────────
{
  function pcBytes(loc: string | number): number[][] {
    const sent: number[][] = [];
    const ctx = { conn: { send: (b: number[]) => sent.push(b) } } as never;
    void writer.switchPreset!(ctx, loc);
    return sent;
  }
  // U01 -> a SINGLE bare Program Change 0, with NO Bank Select (the VE-500
  // ignores the recall if a CC0/CC32 bank select precedes the PC — HW-confirmed).
  const u01 = pcBytes('U01');
  check('U01 sends exactly one message', u01.length === 1, JSON.stringify(u01));
  check('U01 message is bare PC 0 (0xC0 00)', u01[0]?.[0] === 0xc0 && u01[0]?.[1] === 0);
  check('U01 sends NO Bank Select (no 0xB0)', !u01.some((m) => (m[0] & 0xf0) === 0xb0), JSON.stringify(u01));
  // U99 -> bare PC 98
  const u99 = pcBytes(99);
  check('U99 (n=99) sends bare PC 98', u99.length === 1 && u99[0][0] === 0xc0 && u99[0][1] === 98);

  // bad location rejects (switchPreset is async; await rejections)
  const noop = { conn: { send: () => {} } } as never;
  let badThrew = false;
  await writer.switchPreset!(noop, 'Z9').catch(() => {
    badThrew = true;
  });
  check('bad location rejected', badThrew);
}

// ── 6b. Factory PRESET recall (P01-P50): SysEx "Current Patch Number" write ──
// Decoded 2026-07-09 from the editor's OWN patch-switch handler (preset_patch.js:126,
// address_map.js:488-490/570-576), NOT a Program Change. See roland-midi/ve-500/patch.ts.
// Community-beta: hardware-unverified (the user-memory PC path above IS hardware-confirmed).
{
  // P01 -> index 99 (98 users + 1). Hand-verified frame: addr=0x00000000 -> 7bitize -> 00 00 00 00;
  // INTEGER2x4(99) = [6,3] (99 = 0x63); body = 00 00 00 00 06 03; sum=9; cksum=(128-9)&0x7F=0x77.
  const p01 = hex(buildSwitchPatch(99));
  const p01Expect = 'F0 41 10 00 00 00 55 12 00 00 00 00 06 03 77 F7';
  check('buildSwitchPatch(99) == P01 golden', p01 === p01Expect, `got ${p01}`);

  // U01 -> index 0: same register, value 0.
  const u01 = hex(buildSwitchPatch(0));
  const u01Expect = 'F0 41 10 00 00 00 55 12 00 00 00 00 00 00 00 F7';
  check('buildSwitchPatch(0) == U01 golden (register also recalls users)', u01 === u01Expect, `got ${u01}`);

  function sentFrames(loc: string | number): number[][] {
    const sent: number[][] = [];
    const ctx = { conn: { send: (b: number[]) => sent.push(b) } } as never;
    void writer.switchPreset!(ctx, loc);
    return sent;
  }

  // P01 recall is now UN-GATED: writer.switchPreset sends the SysEx write, not a throw.
  const p01Frames = sentFrames('P01');
  check('switch_preset(P01) sends exactly one frame', p01Frames.length === 1, JSON.stringify(p01Frames));
  check(
    'switch_preset(P01) frame == buildSwitchPatch(99)',
    p01Frames[0] && hex(p01Frames[0]) === p01Expect,
    JSON.stringify(p01Frames.map(hex)),
  );
  check('switch_preset(P01) sends NO Program Change (no 0xC0)', !p01Frames.some((m) => (m[0] & 0xf0) === 0xc0));

  // P50 -> index 148 (98 + 50).
  const p50Frames = sentFrames('P50');
  check('switch_preset(P50) frame == buildSwitchPatch(148)', p50Frames[0] && hex(p50Frames[0]) === hex(buildSwitchPatch(148)));

  // Out-of-range preset numbers still reject.
  let p51Threw = false;
  await writer.switchPreset!({ conn: { send: () => {} } } as never, 'P51').catch(() => { p51Threw = true; });
  check('switch_preset(P51) rejected (only P01-P50 exist)', p51Threw);

  // save_preset still refuses PRESET targets (factory/read-only); un-gating recall
  // must not un-gate writing to a factory preset.
  let saveRejected = false;
  await writer.savePreset!({ conn: { send: () => {} } } as never, 'P01').catch(() => { saveRejected = true; });
  check('save_preset(P01) still rejected (factory/read-only)', saveRejected);

  // User-memory recall is UNCHANGED: still a bare Program Change, not the SysEx write.
  const u10Frames = sentFrames('U10');
  check('switch_preset(U10) still sends bare PC (unchanged, hardware-confirmed path)', u10Frames[0]?.[0] === 0xc0 && u10Frames[0]?.[1] === 9);
}

// ── 7. apply_preset: example_spec validates + applyPreset emits valid frames ──
{
  const spec = VE500_DESCRIPTOR.example_spec!;
  check('descriptor has example_spec', !!spec);

  const pf = collectApplyPresetPreflight(spec, VE500_DESCRIPTOR);
  check(
    'example_spec passes preflight with ZERO errors',
    pf.errors.length === 0,
    JSON.stringify(pf.errors),
  );

  check('writer.applyPreset is implemented', typeof writer.applyPreset === 'function');

  // run applyPreset against a fake ctx, capturing the wire frames
  const sent: number[][] = [];
  const ctx = {
    conn: { send: (b: number[]) => sent.push(b) },
    descriptor: VE500_DESCRIPTOR,
  } as never;
  const result = await writer.applyPreset!(ctx, pf.normalized_spec);
  check('applyPreset ok', result.ok === true, JSON.stringify(result.nacked_steps));
  // enhancer(switch + 3) + pitch_correct(switch + 3) + harmony1(3, no switch) + reverb1(switch + 3) = 15
  check('applyPreset emitted the expected frame count (15)', sent.length === 15, `got ${sent.length}`);
  check(
    'every applyPreset frame is a valid DT1 (F0..F7, body 7-bit)',
    sent.every(
      (f) => f[0] === 0xf0 && f[f.length - 1] === 0xf7 && f.slice(1, -1).every((b) => b <= 0x7f),
    ),
  );
  check('applyPreset reported steps === frames', result.steps === sent.length);

  // apply_preset BY NAME: an enum label in the spec emits the right wire ordinal
  // end-to-end (preflight → applyPreset → schema.encode). example_spec uses
  // 'Soft'/'+3RD'/'Hall', so prove harmony1.voice_manual landed ordinal 7.
  const vmDef = findParam('harmony1', 'voice_manual')!;
  const vmFrame = sent.find((f) => decodeParamReply(vmDef, f) === 7);
  check('apply_preset resolved "+3RD" -> ordinal 7 on the wire', vmFrame !== undefined);

  // partial-failure path: a bad value -> ok:false, nacked, steps counts successes only
  const badSent: number[][] = [];
  const badCtx = {
    conn: { send: (b: number[]) => badSent.push(b) },
    descriptor: VE500_DESCRIPTOR,
  } as never;
  const badResult = await writer.applyPreset!(badCtx, {
    slots: [{ slot: 1, block_type: 'enhancer', params: { enhance: 999, compressor: 30 } }],
  });
  check('applyPreset bad value -> ok:false', badResult.ok === false);
  check('applyPreset bad value -> 1 nacked step', (badResult.nacked_steps?.length ?? 0) === 1);
  check('applyPreset steps counts only successful sends', badResult.steps === badSent.length && badSent.length === 1);
}

// ── 8. enum-join aggregate guard (catches a future matchEnum regression) ──────
{
  const enumParams = VE500_PARAMS.filter((p) => p.enum_values);
  check(
    `catalog enum-param count is ~220 (got ${enumParams.length})`,
    enumParams.length >= 210 && enumParams.length <= 240,
  );
  // every enum_values must cover [0..max] contiguously (matchEnum's invariant)
  const broken = enumParams.filter((p) => {
    const keys = Object.keys(p.enum_values!).map(Number).sort((a, b) => a - b);
    return keys.length !== p.max + 1 || keys[0] !== 0 || keys[keys.length - 1] !== p.max;
  });
  check(
    'every enum_values covers 0..max contiguously',
    broken.length === 0,
    broken.slice(0, 4).map((p) => `${p.block}.${p.param}`).join(', '),
  );
}

// ── 9. save_preset: comm-mode-ON + the editor store command (DT1 0x7F000104) ──
// HW-VE500 2026-07-08: a bare store command was HARDWARE-REFUTED (a MIDI-set
// value did not survive a save + reload). Re-derived from the editor's own
// connect handshake (js/product/midi.js): Editor Communication Mode ON must
// precede any command.write(). savePreset now sends that mode-on command
// first and waits for the device's store-ack echo (saveAckMatcher) before
// reporting `acked`. See save.ts / writer.ts for the full evidence trail.
{
  // Save to U10 = user index 9. Hand-verified frame.
  const got = hex(buildSavePreset(9));
  const expect = 'F0 41 10 00 00 00 55 12 7F 00 01 04 00 09 73 F7';
  check('save_preset U10 store command', got === expect, `got ${got}`);

  // Editor Communication Mode ON — hand-verified frame (must precede the store).
  // body = 7F 00 00 01 01; sum = 0x7F+0+0+1+1 = 0x81 (129); cksum = (128-129%128)&0x7F = 0x7F.
  const commOn = hex(buildCommMode(true));
  const commOnExpect = 'F0 41 10 00 00 00 55 12 7F 00 00 01 01 7F F7';
  check('buildCommMode(true) frame (must precede the store)', commOn === commOnExpect, `got ${commOn}`);

  // saveAckMatcher recognizes the device's store-address echo and rejects
  // unrelated frames (an ordinary set_param write to a normal patch address).
  const echoFrame = buildSavePreset(0);
  const unrelatedFrame = buildSetParam(findParam('enhancer', 'enhance')!, 50);
  check('saveAckMatcher matches a store-address echo', saveAckMatcher()(echoFrame));
  check('saveAckMatcher rejects an unrelated (ordinary param) frame', !saveAckMatcher()(unrelatedFrame));

  check('writer.savePreset is implemented', typeof writer.savePreset === 'function');

  // U01 -> index 0. Mock a device that either echoes the store ack or times out.
  function mockCtx(ackBehavior: 'resolve' | 'reject') {
    const sent: number[][] = [];
    const ctx = {
      conn: {
        send: (b: number[]) => sent.push(b),
        receiveSysExMatching: () =>
          ackBehavior === 'resolve'
            ? Promise.resolve(buildSavePreset(0))
            : Promise.reject(new Error('timeout')),
      },
    } as never;
    return { sent, ctx };
  }

  {
    const { sent, ctx } = mockCtx('resolve');
    const result = await writer.savePreset!(ctx, 'U01');
    check(
      'savePreset U01 sends comm-mode-ON THEN the store command (index 0)',
      sent.length === 2 &&
        hex(sent[0]) === commOnExpect &&
        hex(sent[1]).includes('7F 00 01 04 00 00'),
      JSON.stringify(sent.map(hex)),
    );
    check('savePreset acked=true when the device echoes the store', result.acked === true);
  }

  {
    const { ctx } = mockCtx('reject');
    const result = await writer.savePreset!(ctx, 'U01');
    check('savePreset acked=false when no device echo arrives (honest, not fabricated)', result.acked === false, JSON.stringify(result));
  }

  // presets are factory/read-only -> rejected (before any send happens)
  let presetRejected = false;
  const { ctx: rejCtx } = mockCtx('resolve');
  await writer.savePreset!(rejCtx, 'P01').catch(() => { presetRejected = true; });
  check('savePreset rejects a preset target (P01)', presetRejected);
}

// ── 10. buildSwitchPatch: structural sweep over the FULL 0..148 recall range ──
{
  let allOk = true;
  for (let n = 0; n <= 148; n++) {
    const frame = buildSwitchPatch(n);
    const bodyOk =
      frame[0] === 0xf0 &&
      frame[frame.length - 1] === 0xf7 &&
      frame.slice(1, -1).every((b) => b <= 0x7f);
    const body = frame.slice(8, frame.length - 2);
    const cksumOk = frame[frame.length - 2] === rolandChecksum(body);
    const rt = decodeWire(Size.INTEGER2x4, frame.slice(12, 14), 0);
    if (!bodyOk || !cksumOk || rt !== n) {
      allOk = false;
      check(`buildSwitchPatch(${n})`, false, `bodyOk=${bodyOk} cksumOk=${cksumOk} rt=${rt}`);
      break;
    }
  }
  check('buildSwitchPatch round-trips MIDI-safe+checksum-correct over 0..148', allOk);
}

// ── 11. SYSTEM (global) catalog: address-region math + set_param/get_param reuse ──
// Decoded 2026-07-09: address_map.js's System tree (base 0x02000000, lines 538-568),
// walked by the SAME generator that produces VE500_PARAMS (scripts/generate-ve500-catalog.ts),
// with `region:'system'` marking `addr` as the FULL absolute address (no patch base added).
{
  check(
    'catalog produced a substantial SYSTEM param set (>200)',
    VE500_SYSTEM_PARAMS.length > 200,
    `got ${VE500_SYSTEM_PARAMS.length}`,
  );
  const sysBlockCount = new Set(VE500_SYSTEM_PARAMS.map((p) => p.block)).size;
  check('SYSTEM catalog spans >20 blocks', sysBlockCount > 20, `got ${sysBlockCount}`);
  check('every SYSTEM entry is tagged region:"system"', VE500_SYSTEM_PARAMS.every((p) => p.region === 'system'));
  check('no SYSTEM block collides with a per-patch block id', VE500_SYSTEM_PARAMS.every((p) => !VE500_PARAMS.some((t) => t.block === p.block)));

  // Hand-verified anchor: SystemMIDI "MIDI Rx Channel" (address_map.js:396), absolute
  // addr = System root 0x02000000 + SystemMIDI 0x00000800 + param 0x0 = 0x02000800.
  // _7bitize(0x02000800) -> 10 00 10 00 (independently hand-computed); INTEGER1x5(3) = [03];
  // body = 10 00 10 00 03; sum=0x23=35; cksum=(128-35)&0x7F=0x5D.
  const rxCh = findParam('system_midi', 'midi_rx_channel');
  check('system_midi.midi_rx_channel resolves', !!rxCh);
  if (rxCh) {
    check('system_midi.midi_rx_channel absolute addr == 0x02000800', rxCh.addr === 0x02000800, `got 0x${rxCh.addr.toString(16)}`);
    const frame = hex(buildSetParam(rxCh, 3));
    const expect = 'F0 41 10 00 00 00 55 12 10 00 10 00 03 5D F7';
    check('DT1 system_midi.midi_rx_channel=3', frame === expect, `got ${frame}`);
    check('read-back round-trips', decodeParamReply(rxCh, buildSetParam(rxCh, 3)) === 3);

    // Reused via the SAME generic writer path as any per-patch param (no new code).
    const wbuilt = writer.buildSetParam!('system_midi', 'midi_rx_channel', 3);
    check('writer.buildSetParam(system_midi.midi_rx_channel) == codec', hex(wbuilt) === expect);

    // Reused via the SAME descriptor block map (list_params / set_param dispatch).
    const schema = VE500_DESCRIPTOR.blocks['system_midi']?.params['midi_rx_channel'];
    check('descriptor exposes system_midi.midi_rx_channel', !!schema);
    check('schema encode/decode round-trips (3)', schema?.encode(3) === 3 && schema?.decode(3) === 3);

    // reader.getParam (the get_param dispatch path) also reuses the SAME
    // generic machinery for a SYSTEM param, with no reader.ts code changes.
    const readCtx = {
      conn: {
        send: () => {},
        receiveSysExMatching: () => Promise.resolve(buildSetParam(rxCh, 3)),
      },
      descriptor: VE500_DESCRIPTOR,
    } as never;
    const readResult = await reader.getParam!(readCtx, 'system_midi', 'midi_rx_channel');
    check('reader.getParam(system_midi.midi_rx_channel) == 3', readResult.wire_value === 3, JSON.stringify(readResult));
  }

  // Structural invariants over EVERY settable SYSTEM param (min/mid/max, MIDI-safe + checksum).
  let sysChecked = 0;
  for (const def of VE500_SYSTEM_PARAMS) {
    sysChecked++;
    const samples = [def.min, Math.round((def.min + def.max) / 2), def.max];
    for (const v of samples) {
      const frame = buildSetParam(def, v);
      const bodyOk =
        frame[0] === 0xf0 &&
        frame[frame.length - 1] === 0xf7 &&
        frame.slice(1, -1).every((b) => b <= 0x7f);
      const body = frame.slice(8, frame.length - 2);
      const cksumOk = frame[frame.length - 2] === rolandChecksum(body);
      const rt = decodeParamReply(def, frame);
      if (!bodyOk || !cksumOk || rt !== v) {
        check(`SYSTEM param ${def.block}.${def.param} v=${v}`, false, `bodyOk=${bodyOk} cksumOk=${cksumOk} rt=${rt} frame=${hex(frame)}`);
        break;
      }
    }
  }
  check('every SYSTEM catalog param checked', sysChecked === VE500_SYSTEM_PARAMS.length);
}

if (failures) {
  console.log(`\n❌ verify-ve500: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  `✅ verify-ve500: all checks passed (${checkedParams} catalog params, ${Object.keys(VE500_DESCRIPTOR.blocks).length} blocks)`,
);
