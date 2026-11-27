/**
 * Axe-Fx III codec golden vectors.
 *
 * Source: Fractal's "Axe-Fx III MIDI for Third-Party Devices" v1.4
 * PDF, plus 10 public captures (FC-12 footswitch, plus a public forum
 * capture from 2019) that locked the fn=0x01 SET_PARAMETER
 * wire shape.
 *
 * Test cases lifted verbatim from the upstream
 * `scripts/verify-axe-fx-iii-encoding.ts` golden. Failure of this test
 * means the codec port drifted from spec/capture reality, NOT just
 * from internal expectations.
 *
 * Status: 🟡 community beta. Calibration coverage sparse (~11% of
 * 2017 params) because Fractal omits per-block param IDs from the
 * public spec. The wire shapes themselves are locked.
 */
import {
  buildSetBypass,
  buildGetBypass,
  buildSetChannel,
  buildGetChannel,
  buildSetScene,
  buildGetScene,
  buildQueryPatchName,
  buildQuerySceneName,
  buildSetLooper,
  buildGetLooperState,
  buildTempoTap,
  buildSetTuner,
  buildSetTempo,
  buildGetTempo,
  buildStatusDump,
  buildSwitchPresetPC,
  buildSwitchPresetSysEx,
  buildSetParameter,
  buildSetParameterContinuous,
  buildSetParameterBypass,
  buildRequestPresetDump,
  packValue16,
  unpackValue16,
  isSetGetParameterResponse,
  parseSetGetParameterResponse,
  isGetParameterResponse,
  parseGetParameterResponse,
  parseStateBroadcast,
  parseGen3StateBroadcastHead,
  parseGen3StateBroadcastBody,
  parseGen3SetValueEcho,
  resolveEffectId,
  resolveEnumValues,
  resolveGen3EnumOrdinal,
  createModernFractalCodec,
} from '../../../src/gen3/axe-fx-iii/index.js';

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Case {
  label: string;
  built: number[];
  expected: string;
}

const cases: Case[] = [
  // 0x0A SET/GET BYPASS — Compressor 1 = effectId 46.
  { label: 'buildSetBypass(46, false)', built: buildSetBypass(46, false), expected: 'f0000174100a2e000031f7' },
  { label: 'buildSetBypass(46, true)', built: buildSetBypass(46, true), expected: 'f0000174100a2e000130f7' },
  { label: 'buildGetBypass(46)', built: buildGetBypass(46), expected: 'f0000174100a2e007f4ef7' },
  { label: 'buildSetBypass(66, false) — Reverb 1', built: buildSetBypass(66, false), expected: 'f0000174100a4200005df7' },

  // 0x0B SET/GET CHANNEL
  { label: 'buildSetChannel(46, 0)', built: buildSetChannel(46, 0), expected: 'f0000174100b2e000030f7' },
  { label: 'buildSetChannel(46, 1)', built: buildSetChannel(46, 1), expected: 'f0000174100b2e000131f7' },
  { label: 'buildSetChannel(46, 3)', built: buildSetChannel(46, 3), expected: 'f0000174100b2e000333f7' },
  { label: 'buildGetChannel(46)', built: buildGetChannel(46), expected: 'f0000174100b2e007f4ff7' },

  // 0x0C SET/GET SCENE
  { label: 'buildSetScene(0)', built: buildSetScene(0), expected: 'f0000174100c0019f7' },
  { label: 'buildSetScene(7)', built: buildSetScene(7), expected: 'f0000174100c071ef7' },
  { label: 'buildGetScene()', built: buildGetScene(), expected: 'f0000174100c7f66f7' },

  // SWITCH PRESET — raw MIDI Bank Select (CC0+CC32) + Program Change.
  // Per-device bank encoding: 'standard' (III/FM3) = bank in CC0<<7|CC32;
  // 'msb' (FM9) = bank in CC0, CC32=0. Preset 412 = bank 3, PC 28 (0x1c).
  { label: 'buildSwitchPresetPC(0) standard', built: buildSwitchPresetPC(0), expected: 'b00000b02000c000' },
  { label: 'buildSwitchPresetPC(412) standard — bank 3 in CC32', built: buildSwitchPresetPC(412), expected: 'b00000b02003c01c' },
  { label: 'buildSwitchPresetPC(412, 1, "msb") FM9 — bank 3 in CC0', built: buildSwitchPresetPC(412, 1, 'msb'), expected: 'b00003b02000c01c' },
  { label: 'buildSwitchPresetPC(27, 1, "msb") FM9 — bank 0 unchanged', built: buildSwitchPresetPC(27, 1, 'msb'), expected: 'b00000b02000c01b' },
  // Codec binding: the III codec (default) stays standard; the FM9 codec
  // (bankSelect 'msb') threads the mode through to the builder.
  { label: 'codec(0x10).buildSwitchPresetPC(412) — III standard', built: createModernFractalCodec(0x10).buildSwitchPresetPC(412), expected: 'b00000b02003c01c' },
  { label: 'codec(0x12,msb).buildSwitchPresetPC(412) — FM9 MSB', built: createModernFractalCodec(0x12, { bankSelect: 'msb' }).buildSwitchPresetPC(412), expected: 'b00003b02000c01c' },

  // SWITCH PRESET via SysEx (fn=0x01 sub=0x27). Byte-exact vs the FM3-Edit
  // capture live-confirmed on FM3 fw 12.00 hardware (BoodieTraps 2026-06-10,
  // a server-issued frame moved the unit 475→100). Preset# is a 14-bit LE
  // int at pos 12 (encode14: 475 = 5b 03), NOT a float32 and NOT the BE form
  // the fn=0x03 dump request uses. blockId/paramId both zero.
  { label: 'buildSwitchPresetSysEx(475, 0x11) — FM3 capture frame', built: buildSwitchPresetSysEx(475, 0x11), expected: 'f000017411012700000000005b03000000000000006af7' },
  { label: 'codec(0x10).buildSwitchPresetSysEx(475) — III model byte', built: createModernFractalCodec(0x10).buildSwitchPresetSysEx(475), expected: 'f000017410012700000000005b03000000000000006bf7' },

  // 0x0D QUERY PATCH NAME — preset index 0..1023, or 'current' (two sentinel bytes).
  { label: 'buildQueryPatchName(0)', built: buildQueryPatchName(0), expected: 'f0000174100d000018f7' },
  { label: 'buildQueryPatchName(1023)', built: buildQueryPatchName(1023), expected: 'f0000174100d7f0760f7' },
  { label: "buildQueryPatchName('current')", built: buildQueryPatchName('current'), expected: 'f0000174100d7f7f18f7' },

  // 0x0E QUERY SCENE NAME
  { label: 'buildQuerySceneName(0)', built: buildQuerySceneName(0), expected: 'f0000174100e001bf7' },
  { label: 'buildQuerySceneName(7)', built: buildQuerySceneName(7), expected: 'f0000174100e071cf7' },
  { label: "buildQuerySceneName('current')", built: buildQuerySceneName('current'), expected: 'f0000174100e7f64f7' },

  // 0x0F LOOPER
  { label: "buildSetLooper('record')", built: buildSetLooper('record'), expected: 'f0000174100f001af7' },
  { label: "buildSetLooper('play')", built: buildSetLooper('play'), expected: 'f0000174100f011bf7' },
  { label: "buildSetLooper('half_speed')", built: buildSetLooper('half_speed'), expected: 'f0000174100f051ff7' },
  { label: 'buildGetLooperState()', built: buildGetLooperState(), expected: 'f0000174100f7f65f7' },

  // 0x10 TEMPO TAP — single-byte payload-free envelope.
  { label: 'buildTempoTap()', built: buildTempoTap(), expected: 'f00001741010 05f7'.replace(/\s/g, '') },

  // 0x11 TUNER
  { label: 'buildSetTuner(true)', built: buildSetTuner(true), expected: 'f0000174101101 05f7'.replace(/\s/g, '') },
  { label: 'buildSetTuner(false)', built: buildSetTuner(false), expected: 'f0000174101100 04f7'.replace(/\s/g, '') },

  // 0x13 STATUS DUMP
  { label: 'buildStatusDump()', built: buildStatusDump(), expected: 'f00001741013 06f7'.replace(/\s/g, '') },

  // 0x14 TEMPO — 120 BPM = 0x78
  { label: 'buildSetTempo(120)', built: buildSetTempo(120), expected: 'f0000174101478 0079f7'.replace(/\s/g, '') },
  { label: 'buildGetTempo()', built: buildGetTempo(), expected: 'f000017410147f 7f01f7'.replace(/\s/g, '') },

  // 0x01 SET/GET PARAMETER —  corrected envelope (fn=0x01,
  // NOT fn=0x02 as initially II-ported). 10 public captures.
  // Envelope: F0 00 01 74 10 01 [09 00] [eff_lo eff_hi] [pid_lo pid_hi]
  //   00 00 00 [v0 v1 v2] 00 00 00 [cs] F7  (23 bytes)
  // 0x03 REQUEST_PRESET_DUMP — fm=0x12 (FM9), big-endian septet preset#.
  // Wire-confirmed against FM9 hw fw 11.00 capture (preset indices 49, 129, 197, 273,
  // 274, 355, 443, 444 captured; these two are cross-checked from those captures).
  // Big-endian: hi7 = (n >> 7) & 0x7F, lo7 = n & 0x7F (unlike LE used in buildStorePreset).
  {
    label: 'buildRequestPresetDump(49, 0x12) — FM9 preset 49',
    built: buildRequestPresetDump(49, 0x12),
    expected: 'f0000174120300310025f7',
  },
  {
    label: 'buildRequestPresetDump(273, 0x12) — FM9 preset 273 (spans both septet bytes)',
    built: buildRequestPresetDump(273, 0x12),
    expected: 'f0000174120302110007f7',
  },

  {
    label: 'buildSetParameter(66, 0, 0) — Reverb 1 paramId 0 min',
    built: buildSetParameter(66, 0, 0),
    expected: 'f000017410010900420000000000000000000000005ff7',
  },
  {
    label: 'buildSetParameter(66, 0, 65534) — Reverb 1 paramId 0 max',
    built: buildSetParameter(66, 0, 65534),
    expected: 'f00001741001090042000000007c7f3b040000000063f7',
  },
  {
    label: 'buildSetParameter(66, 11, 32767) — Reverb 1 paramId 11 mid',
    built: buildSetParameter(66, 11, 32767),
    expected: 'f00001741001090042000b00007c7f37040000000064f7',
  },
  {
    label: 'buildSetParameterBypass(66, true) — Reverb 1 bypass via fn=0x01',
    built: buildSetParameterBypass(66, true),
    expected: 'f00001741001090042007f010000007c03000000005ef7',
  },
];

// Public-capture parser goldens — verify the parser accepts and decodes
// real wire frames AxeEdit III emits to a real Axe-Fx III.
interface ParseCase {
  label: string;
  bytes: number[];
  expected: { effectId: number; paramId: number; value: number };
}

const parseCases: ParseCase[] = [
  // FC-12: Amp 1 boost ON (effectId=58 = the Amp block, paramId=40). The value
  // is the 5-septet float32 at pos 12 = 1.0 (boost ON); the old "508" was that
  // float's high bytes misread as a packValue16 at pos 15.
  {
    label: 'FC-12 Amp 1 boost ON (float32 1.0)',
    bytes: [
      0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x52, 0x00, 0x3a, 0x00, 0x28, 0x00,
      0x00, 0x00, 0x00, 0x7c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x2b, 0xf7,
    ],
    expected: { effectId: 58, paramId: 40, value: 1 },
  },
  // Public forum capture, typed Delay 1 TIME (effectId=70, paramId=2).
  // float32 @pos12 = 8.0 (the old "520" was the pos-15 misread).
  {
    label: 'forum capture, typed Delay TIME (float32 8.0)',
    bytes: [
      0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x09, 0x00, 0x46, 0x00, 0x02, 0x00,
      0x00, 0x00, 0x00, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x55, 0xf7,
    ],
    expected: { effectId: 70, paramId: 2, value: 8 },
  },
  // Public forum capture, continuous drag (sub 52 00) Delay 1 TIME.
  // float32(normalized) @pos12 = 0.45474… (the old "503" was the pos-15 misread).
  {
    label: 'forum capture, drag Delay TIME (float32 normalized)',
    bytes: [
      0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x52, 0x00, 0x46, 0x00, 0x02, 0x00,
      0x49, 0x27, 0x23, 0x77, 0x03, 0x00, 0x00, 0x00, 0x00, 0x3b, 0xf7,
    ],
    expected: { effectId: 70, paramId: 2, value: 0.4547407925128937 },
  },
  // STATE_BROADCAST (sub-action 04 01) — paramId zero by convention.
  {
    label: 'STATE_BROADCAST 04 01',
    bytes: [
      0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x04, 0x01, 0x3a, 0x00, 0x00, 0x00,
      0x46, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x6c, 0xf7,
    ],
    expected: { effectId: 58, paramId: 0, value: 198 },
  },
];

export function runAxeFxIIISetParamTests(): void {
  // packValue16 round-trips for the 16-bit value field.
  for (const v of [0, 1, 127, 128, 16383, 16384, 32767, 65534]) {
    const [a, b, c] = packValue16(v);
    const back = unpackValue16(a, b, c);
    if (back !== v) {
      throw new Error(`packValue16/unpackValue16 round-trip drift at ${v} — got ${back}`);
    }
  }

  // Envelope goldens.
  const failed: string[] = [];
  for (const c of cases) {
    const got = hex(c.built);
    if (got !== c.expected) {
      failed.push(`${c.label}\n  expected: ${c.expected}\n  got:      ${got}`);
    }
  }

  // Parser cases — verify recognizer + parser.
  for (const pc of parseCases) {
    if (!isSetGetParameterResponse(pc.bytes)) {
      failed.push(`${pc.label}: isSetGetParameterResponse returned false on capture`);
      continue;
    }
    const parsed = parseSetGetParameterResponse(pc.bytes);
    if (
      parsed.effectId !== pc.expected.effectId ||
      parsed.paramId !== pc.expected.paramId ||
      parsed.value !== pc.expected.value
    ) {
      failed.push(
        `${pc.label}: parser drift\n  expected: ${JSON.stringify(pc.expected)}\n  got:      ${JSON.stringify(parsed)}`,
      );
    }
  }

  // resolveEffectId sanity.
  if (resolveEffectId('Reverb 1') !== 66) {
    throw new Error(`resolveEffectId("Reverb 1") drift — expected 66, got ${resolveEffectId('Reverb 1')}`);
  }
  if (resolveEffectId('Compressor 1') !== 46) {
    throw new Error(`resolveEffectId("Compressor 1") drift — expected 46, got ${resolveEffectId('Compressor 1')}`);
  }
  // ID_DISTORT1=58 is the AMP block; ID_FUZZ1=118 is the user-facing Drive pedal.
  if (resolveEffectId('Amp 1') !== 58) {
    throw new Error(`resolveEffectId("Amp 1") drift — expected 58, got ${resolveEffectId('Amp 1')}`);
  }
  if (resolveEffectId('Drive 1') !== 118) {
    throw new Error(`resolveEffectId("Drive 1") drift — expected 118, got ${resolveEffectId('Drive 1')}`);
  }

  // fn=0x01 GET-response parser — real-hardware FM9 captures (model 0x12),
  // community fm9-catalog branch (commit a2a4664, 2026-06-06). The frame
  // carries the param's internal float + the device's own display string.
  const GET_AMP = [0xf0,0x00,0x01,0x74,0x12,0x01,0x09,0x00,0x3a,0x00,0x05,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x20,0x00,0x22,0x53,0x48,0x74,0x0a,0x1d,0x0a,0x44,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x14,0xf7];
  const GET_DLY = [0xf0,0x00,0x01,0x74,0x12,0x01,0x09,0x00,0x46,0x00,0x11,0x00,0x00,0x00,0x00,0x78,0x03,0x00,0x00,0x20,0x00,0x18,0x0b,0x46,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x46,0xf7];
  const FM9_MODEL = 0x12;
  for (const [label, frame, eff, pid, bits] of [
    ['GET_AMP', GET_AMP, 58, 5, 0x00000000],
    ['GET_DLY', GET_DLY, 70, 17, 0x3f000000],
  ] as const) {
    if (!isGetParameterResponse(frame, FM9_MODEL)) {
      failed.push(`${label}: isGetParameterResponse returned false on a captured GET frame`);
      continue;
    }
    const g = parseGetParameterResponse(frame, FM9_MODEL);
    if (g.effectId !== eff || g.paramId !== pid || g.valueBits !== bits) {
      failed.push(`${label}: GET parse drift — expected eff=${eff} pid=${pid} bits=0x${bits.toString(16)}, got eff=${g.effectId} pid=${g.paramId} bits=0x${g.valueBits.toString(16)}`);
    }
    if (g.displayString.length === 0 || !/^[\x20-\x7e]+$/.test(g.displayString)) {
      failed.push(`${label}: GET display string not printable/non-empty — got ${JSON.stringify(g.displayString)}`);
    }
  }
  // A 23-byte SET echo is NOT a 60-byte GET response.
  if (isGetParameterResponse(parseCases[0].bytes)) {
    failed.push('isGetParameterResponse false-positive on a SET-echo frame');
  }

  // Round-trip self-consistency: build → parse → equality. Anchors the
  // codec ✅ claim independent of hardware verification — proves
  // buildSetParameter and parseSetGetParameterResponse agree on the
  // wire layout for every value in the supported 16-bit range.
  const roundTripValues = [0, 1, 127, 128, 8191, 8192, 16383, 16384, 32767, 32768, 65534];
  const roundTripCases: Array<{ effectId: number; paramId: number; value: number }> = [];
  for (const effectId of [46, 58, 66, 70]) {
    for (const paramId of [0, 1, 11, 40, 255, 1023]) {
      for (const value of roundTripValues) {
        roundTripCases.push({ effectId, paramId, value });
      }
    }
  }
  for (const rt of roundTripCases) {
    const built = buildSetParameter(rt.effectId, rt.paramId, rt.value);
    const parsed = parseSetGetParameterResponse(built);
    if (
      parsed.kind !== 'set_echo' ||
      parsed.effectId !== rt.effectId ||
      parsed.paramId !== rt.paramId ||
      parsed.value !== rt.value
    ) {
      failed.push(
        `round-trip drift effectId=${rt.effectId} paramId=${rt.paramId} value=${rt.value}: ` +
          `kind=${parsed.kind} effectId=${parsed.effectId} paramId=${parsed.paramId} value=${parsed.value}`,
      );
    }
  }

  // parseStateBroadcast: throws on non-broadcast frames, returns
  // {effectId, value} on `04 01` sub-action.
  const broadcastFrame = [
    0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x04, 0x01, 0x3a, 0x00, 0x00, 0x00,
    0x46, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x6c, 0xf7,
  ];
  const broadcast = parseStateBroadcast(broadcastFrame);
  if (broadcast.effectId !== 58 || broadcast.value !== 198) {
    failed.push(
      `parseStateBroadcast drift: expected {effectId:58,value:198}, got ${JSON.stringify(broadcast)}`,
    );
  }
  const setEchoFrame = buildSetParameter(66, 0, 100);
  let threwOnEcho = false;
  try {
    parseStateBroadcast(setEchoFrame);
  } catch {
    threwOnEcho = true;
  }
  if (!threwOnEcho) {
    failed.push('parseStateBroadcast: expected throw on set_echo frame, got silent return');
  }

  // Gen-3 0x74/0x75 STATE-BROADCAST burst — byte-verified from the first
  // FM9 hardware capture (model 0x12, htrom2015 2026-06-03). The 0x74 head
  // identifies block 66 (Reverb); the 0x75 body's first three packValue16
  // triples are Reverb Mix (65534 = 100%), Level (39320), Pan (32767 = center).
  const bcastHead = [0xf0, 0x00, 0x01, 0x74, 0x12, 0x74, 0x42, 0x00, 0x24, 0x02, 0x07, 0xf7];
  const head = parseGen3StateBroadcastHead(bcastHead);
  if (head.blockId !== 66 || head.itemCount !== 292) {
    failed.push(`parseGen3StateBroadcastHead drift: expected {blockId:66,itemCount:292}, got ${JSON.stringify(head)}`);
  }
  const bcastBody = [
    0xf0, 0x00, 0x01, 0x74, 0x12, 0x75, 0x00, 0x02,
    0x7e, 0x7f, 0x03, // Mix   = 65534 (100.00% front-panel reading)
    0x18, 0x33, 0x02, // Level = 39320
    0x7f, 0x7f, 0x01, // Pan   = 32767 (center)
    0x00, 0xf7,       // cksum + F7
  ];
  const body = parseGen3StateBroadcastBody(bcastBody);
  if (
    body.sectionId !== 0 || body.values.length !== 3
    || body.values[0] !== 65534 || body.values[1] !== 39320 || body.values[2] !== 32767
  ) {
    failed.push(`parseGen3StateBroadcastBody drift: expected sectionId 0 + [65534,39320,32767], got ${JSON.stringify(body)}`);
  }
  let threwOnBadFn = false;
  try {
    parseGen3StateBroadcastBody(bcastHead); // 0x74, not 0x75
  } catch {
    threwOnBadFn = true;
  }
  if (!threwOnBadFn) {
    failed.push('parseGen3StateBroadcastBody: expected throw on non-0x75 frame');
  }

  // Gen-3 typed SET (sub 09 00) round-trips byte-exact against the captured
  // FM9-Edit Reverb TYPE change (Medium Room → Medium Spring), FW 11.00 2026-06-03.
  // The set value is float32(read-ordinal): Medium Spring = REVERB_TYPE ordinal
  // 16 → float32 16.0 → septets [00,00,00,0c,04] at pos 12. (The old "524" was
  // this float's high bytes misread as a packValue16 at pos 15.)
  const fm9TypeSet = buildSetParameter(66, 10, 16, 0x12);
  const fm9TypeSetExpected = [
    0xf0, 0x00, 0x01, 0x74, 0x12, 0x01, 0x09, 0x00, 0x42, 0x00, 0x0a, 0x00,
    0x00, 0x00, 0x00, 0x0c, 0x04, 0x00, 0x00, 0x00, 0x00, 0x5f, 0xf7,
  ];
  if (hex(fm9TypeSet) !== hex(fm9TypeSetExpected)) {
    failed.push(`FM9 typed-SET drift: buildSetParameter(66,10,16,0x12) != captured frame\n  ours: ${hex(fm9TypeSet)}\n  cap:  ${hex(fm9TypeSetExpected)}`);
  }

  // Gen-3 60-byte SET value-echo response (FM9-confirmed): the device echoes
  // effectId/paramId + a 5-septet float32 normalized value. The captured TYPE
  // echo's float = 16/78 = 0.205128 (Medium Spring = ordinal 16 of 79 types).
  const fm9Echo = [
    0xf0, 0x00, 0x01, 0x74, 0x12, 0x01, 0x09, 0x00, 0x42, 0x00, 0x0a, 0x00,
    0x20, 0x1a, 0x48, 0x72, 0x03, 0x00, 0x00, 0x20, 0x00, 0x26, 0x59, 0x2c,
    0x46, 0x4b, 0x55, 0x5a, 0x20, 0x29, 0x5c, 0x0e, 0x26, 0x4b, 0x39, 0x4e,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0xf7,
  ];
  const echo = parseGen3SetValueEcho(fm9Echo);
  if (echo.effectId !== 66 || echo.paramId !== 10 || Math.abs(echo.normalizedValue - 16 / 78) > 1e-5) {
    failed.push(`parseGen3SetValueEcho drift: expected {eff:66,pid:10,val~0.20513}, got ${JSON.stringify(echo)}`);
  }

  // ── Enum overlay + set-by-name ordinal goldens ─────────────────────────────
  //
  // FUZZ_TYPE (eff=118, drive/fuzz pedal type selector) is in the family-shared
  // EFFECT_TYPE_OVERRIDES (enumOverlay.ts) from AM4's DRIVE_TYPES. Byte-anchored:
  // FM9 hw capture confirmed ordinals 15 (Blues OD) and 36 (Blackglass 7K). The
  // read ordinal IS the set value: set-by-name resolves name → ordinal directly.

  // FUZZ_TYPE family overlay coverage.
  const fuzzOverlay = resolveEnumValues('FUZZ_TYPE');
  if (fuzzOverlay === undefined) {
    failed.push('resolveEnumValues("FUZZ_TYPE") returned undefined — FUZZ_TYPE missing from family overlay');
  } else {
    if (fuzzOverlay.values[15] !== 'Blues OD') {
      failed.push(`FUZZ_TYPE ordinal 15: expected "Blues OD", got "${fuzzOverlay.values[15]}"`);
    }
    if (fuzzOverlay.values[36] !== 'Blackglass 7K') {
      failed.push(`FUZZ_TYPE ordinal 36: expected "Blackglass 7K", got "${fuzzOverlay.values[36]}"`);
    }
    if (fuzzOverlay.provenance !== 'am4-shared') {
      failed.push(`FUZZ_TYPE provenance: expected "am4-shared", got "${fuzzOverlay.provenance}"`);
    }
  }

  // Set-by-name = read-roster ORDINAL (the float32(ordinal) set value). Blues
  // OD resolves to ordinal 15; Blackglass 7K to 36. No raw-id space.
  const bluesOrd = resolveGen3EnumOrdinal('FUZZ_TYPE', 'Blues OD');
  if (!('ordinal' in bluesOrd) || bluesOrd.ordinal !== 15) {
    failed.push(`resolveGen3EnumOrdinal("FUZZ_TYPE","Blues OD"): expected ordinal 15, got ${JSON.stringify(bluesOrd)}`);
  }
  const bgOrd = resolveGen3EnumOrdinal('FUZZ_TYPE', 'Blackglass 7K');
  if (!('ordinal' in bgOrd) || bgOrd.ordinal !== 36) {
    failed.push(`resolveGen3EnumOrdinal("FUZZ_TYPE","Blackglass 7K"): expected ordinal 36, got ${JSON.stringify(bgOrd)}`);
  }

  // ── BoodieTraps 2026-06-08 byte-exact oracle frames (FM3 fw 12.00 + FM9) ────
  // Discrete select = float32(read-ordinal) @pos12, sub 09 00; continuous knob
  // drag = float32(normalized) @pos12, sub 52 00. These are real device frames.
  const oracle: Array<[string, number[], string]> = [
    ['FM3 amp "Shiver Clean" ordinal 31', buildSetParameter(58, 6, 31, 0x11), 'f0000174110109003a0006000000600f04000000004bf7'],
    ['FM3 reverb "Recording Studio A" ordinal 38', buildSetParameter(66, 0, 38, 0x11), 'f000017411010900420000000000601004000000002af7'],
    ['FM3 amp Gain drag first (norm 0.498408)', buildSetParameterContinuous(58, 7, 0.4984084367752075, 0x11), 'f0000174110152003a000700645e7c77030000000048f7'],
    ['FM3 amp Gain drag last (norm 0.722817)', buildSetParameterContinuous(58, 7, 0.7228167653083801, 0x11), 'f0000174110152003a00070005156479030000000074f7'],
  ];
  for (const [label, built, want] of oracle) {
    if (hex(built) !== want) failed.push(`oracle frame drift: ${label}\n  ours: ${hex(built)}\n  want: ${want}`);
  }

  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${cases.length + parseCases.length + roundTripCases.length + 2} Axe-Fx III codec golden(s) failed:\n` +
        failed.join('\n'),
    );
  }
}

export const AXEFX3_GOLDEN_CASE_COUNT = (() => {
  // Mirror the runner's count for the test runner's progress line.
  // (cases + parseCases + 264 round-trips + 2 legacy-broadcast + 3 gen-3-broadcast
  //  + 2 FM9 write-path (typed-SET match + value-echo) + 4 FUZZ_TYPE enum assertions.)
  return cases.length + parseCases.length + 4 * 6 * 11 + 2 + 3 + 2 + 4;
})();
