/**
 * Axe-Fx II codec golden vectors.
 *
 * Source: Fractal Audio Wiki "MIDI_SysEx" §"GET/SET_BLOCK_PARAMETER_
 * VALUE" + §"obtaining parameter values", verified against captured
 * Q8.02 firmware traffic (session-61). MSB-first wire
 * ordering for SWITCH_PRESET/STORE_PRESET locked from
 * a hardware test ruling out the wiki's documented LSB-first
 * ordering for preset >= 128.
 *
 * Test cases lifted verbatim from the upstream
 * `scripts/verify-axe-fx-ii-encoding.ts` golden. Failure of this test
 * means the codec port drifted from byte-level wire reality, NOT just
 * from internal expectations.
 */
import {
  AXE_FX_II_XL_PLUS_MODEL_ID,
  KNOWN_PARAMS,
  MODEL_IDS,
  packValue16,
  unpackValue16,
  buildSetBlockParameterValue,
  buildSetBlockParameterValueInteger,
  buildGetBlockParameterValue,
  buildSetBlockBypass,
  buildGetPresetName,
  buildSetSceneNumber,
  buildSetBlockChannel,
  buildSwitchPreset,
  buildSetPresetName,
  buildStorePreset,
  buildGetAllParams,
  buildQueryStates,
  parseQueryStatesResponse,
  mapQueryStatesToBlocks,
} from '../../../src/gen2/axe-fx-ii/index.js';
import { fractalChecksum } from '../../../src/shared/checksum.js';

function eqBytes(actual: readonly number[], expected: readonly number[]): boolean {
  if (actual.length !== expected.length) return false;
  for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) return false;
  return true;
}

function hex(bs: readonly number[]): string {
  return Array.from(bs, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

interface Case {
  label: string;
  built: number[];
  expected: number[];
}

// Wiki worked example: 52421 → packed septets [0x45, 0x19, 0x03].
const wikiPacked = packValue16(52421);

// Build expected envelopes using the imported checksum (same pure
// function the encoders use internally).
function envelope(head: number[]): number[] {
  const cs = fractalChecksum(head);
  return [...head, cs, 0xf7];
}

const cases: Case[] = [
  // SET_PARAM_DIRECT via fn=0x2e (AxeEdit's channel-aware write
  // opcode). AMP 1 (id=106), INPUT DRIVE (paramId=1), display value
  // 32767.0 packed as float32 LE into 5 septets. No action byte
  // (fn=0x2e is write-only).
  {
    label: 'buildSetBlockParameterValue(amp1, input_drive, 32767)',
    built: buildSetBlockParameterValue({ effectId: 106, paramId: 1 }, 32767),
    expected: [0xf0, 0x00, 0x01, 0x74, 0x07, 0x2e, 0x6a, 0x00, 0x01, 0x00, 0x00, 0x7c, 0x7f, 0x37, 0x04, 0x77, 0xf7],
  },
  // GET_BLOCK_PARAMETER_VALUE — value field zero, action=query.
  {
    label: 'buildGetBlockParameterValue(amp1, input_drive)',
    built: buildGetBlockParameterValue({ effectId: 106, paramId: 1 }),
    expected: envelope([
      0xf0, 0x00, 0x01, 0x74, 0x07, 0x02,
      0x6a, 0x00,
      0x01, 0x00,
      0x00, 0x00, 0x00,
      0x00,
    ]),
  },
  // Block bypass via paramId=255, value=1 (bypassed).
  // fn=0x02 PARAM_SET (channel-unaware) with packValue16(1) + ACTION_SET.
  {
    label: 'buildSetBlockBypass(amp1, true)',
    built: buildSetBlockBypass(106, true),
    expected: [0xf0, 0x00, 0x01, 0x74, 0x07, 0x02, 0x6a, 0x00, 0x7f, 0x01, 0x01, 0x00, 0x00, 0x01, 0x14, 0xf7],
  },
  // Block bypass engage via fn=0x02, value=0.
  {
    label: 'buildSetBlockBypass(amp1, false)',
    built: buildSetBlockBypass(106, false),
    expected: [0xf0, 0x00, 0x01, 0x74, 0x07, 0x02, 0x6a, 0x00, 0x7f, 0x01, 0x00, 0x00, 0x00, 0x01, 0x15, 0xf7],
  },
  // Enum param via fn=0x02 integer path (compressor.effect_type = 1).
  // fn=0x02 with packValue16(1) + ACTION_SET. effectId=100, paramId=12.
  {
    label: 'buildSetBlockParameterValueInteger(compressor, effect_type=1)',
    built: buildSetBlockParameterValueInteger({ effectId: 100, paramId: 12 }, 1),
    expected: [0xf0, 0x00, 0x01, 0x74, 0x07, 0x02, 0x64, 0x00, 0x0c, 0x00, 0x01, 0x00, 0x00, 0x01, 0x68, 0xf7],
  },
  // Enum param via fn=0x02 integer path (amp.effect_type = 31 = SHIVER CLEAN).
  // effectId=106, paramId=0, wireValue=31.
  {
    label: 'buildSetBlockParameterValueInteger(amp, effect_type=31)',
    built: buildSetBlockParameterValueInteger({ effectId: 106, paramId: 0 }, 31),
    expected: [0xf0, 0x00, 0x01, 0x74, 0x07, 0x02, 0x6a, 0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x74, 0xf7],
  },
  // GET_PRESET_NAME (function 0x0F) — empty body.
  {
    label: 'buildGetPresetName',
    built: buildGetPresetName(),
    expected: envelope([0xf0, 0x00, 0x01, 0x74, 0x07, 0x0f]),
  },
  // SET_SCENE_NUMBER (function 0x29) — scene 3 (display: scene 4).
  {
    label: 'buildSetSceneNumber(3)',
    built: buildSetSceneNumber(3),
    expected: envelope([0xf0, 0x00, 0x01, 0x74, 0x07, 0x29, 0x03]),
  },
  // X/Y channel — Axe-Fx II only has two channels per block (not
  // A/B/C/D like the AM4). Action byte 0x01 = set.
  {
    label: 'buildSetBlockChannel(amp1, X)',
    built: buildSetBlockChannel(106, 'X'),
    expected: envelope([0xf0, 0x00, 0x01, 0x74, 0x07, 0x11, 0x6a, 0x00, 0x00, 0x01]),
  },
  {
    label: 'buildSetBlockChannel(amp1, Y)',
    built: buildSetBlockChannel(106, 'Y'),
    expected: envelope([0xf0, 0x00, 0x01, 0x74, 0x07, 0x11, 0x6a, 0x00, 0x01, 0x01]),
  },
  // SWITCH_PRESET (function 0x3C) — MSB-first per .
  {
    label: 'buildSwitchPreset(0)',
    built: buildSwitchPreset(0),
    expected: envelope([0xf0, 0x00, 0x01, 0x74, 0x07, 0x3c, 0x00, 0x00]),
  },
  {
    label: 'buildSwitchPreset(128) — MSB-first boundary',
    built: buildSwitchPreset(128),
    expected: envelope([0xf0, 0x00, 0x01, 0x74, 0x07, 0x3c, 0x01, 0x00]),
  },
  {
    label: 'buildSwitchPreset(699) — HW-103 display-slot 700',
    built: buildSwitchPreset(699),
    expected: envelope([0xf0, 0x00, 0x01, 0x74, 0x07, 0x3c, 0x05, 0x3b]),
  },
  // STORE_PRESET (function 0x1D): cross-validation against a community
  // axe-fx-midi library plus a passive capture.
  {
    label: 'buildStorePreset(217, MarkII) vs community axe-fx-midi test case',
    built: buildStorePreset(217, { modelId: MODEL_IDS['axe-fx-ii'] }),
    expected: [0xf0, 0x00, 0x01, 0x74, 0x03, 0x1d, 0x01, 0x59, 0x43, 0xf7],
  },
  {
    label: 'buildStorePreset(699) XL+ — session-61 capture',
    built: buildStorePreset(699),
    expected: envelope([0xf0, 0x00, 0x01, 0x74, 0x07, 0x1d, 0x05, 0x3b]),
  },
  // SYSEX_GET_ALL_PARAMS (function 0x1F) — bulk per-block param dump.
  // Hardware-verified  (Q8.02 XL+): sending this for AMP 1
  // (effectId 106 = 0x6A) returned a 0x74/0x75/0x76 state-broadcast
  // triple with 236 16-bit values. Wire bytes captured in
  // samples/captured/probe-axefx2-bulk-read.syx (first AMP 1 probe).
  {
    label: 'buildGetAllParams(amp1 / effectId 106) — Session 103 probe wire bytes',
    built: buildGetAllParams(106),
    expected: envelope([0xf0, 0x00, 0x01, 0x74, 0x07, 0x1f, 0x6a, 0x00]),
  },
  {
    label: 'buildGetAllParams(reverb1 / effectId 110) — Session 103 fn1f-sweep',
    built: buildGetAllParams(110),
    expected: envelope([0xf0, 0x00, 0x01, 0x74, 0x07, 0x1f, 0x6e, 0x00]),
  },
  // SYSEX_QUERY_STATES (function 0x0E) — empty payload request. The
  // editor's whole-preset block-state read; response is payload-
  // insensitive so the request carries no body.
  {
    label: 'buildQueryStates() — fn 0x0E empty request',
    built: buildQueryStates(),
    expected: envelope([0xf0, 0x00, 0x01, 0x74, 0x07, 0x0e]),
  },
];

// fn 0x0E QUERY_STATES response: 62-byte capture for an 11-block preset.
// Byte-exact proven structure: 6-byte header, no trailing checksum, payload
// tiles into 5-byte records, record count == placed-block count.
const FN0E_RESPONSE = [
  0xf0, 0x00, 0x01, 0x74, 0x07, 0x0e,
  0x03, 0x4a, 0x10, 0x53, 0x06,
  0x03, 0x4e, 0x18, 0x63, 0x06,
  0x02, 0x52, 0x20, 0x23, 0x07,
  0x02, 0x56, 0x00, 0x20, 0x06,
  0x02, 0x5e, 0x28, 0x03, 0x07,
  0x02, 0x62, 0x30, 0x2b, 0x78,
  0x02, 0x70, 0x38, 0x33, 0x07,
  0x02, 0x0a, 0x7d, 0x17, 0x07,
  0x03, 0x26, 0x51, 0x73, 0x06,
  0x02, 0x2c, 0x75, 0x43, 0x07,
  0x02, 0x42, 0x59, 0x63, 0x07,
  0xf7,
];

export function runAxeFxIISetParamTests(): void {
  // packValue16 wiki worked example: 52421 = 0xCCC5
  //   bits  0..6 → 1000101  = 0x45
  //   bits  7..13 → 0011001 = 0x19
  //   bits 14..15 → 11      = 0x03
  if (wikiPacked[0] !== 0x45 || wikiPacked[1] !== 0x19 || wikiPacked[2] !== 0x03) {
    throw new Error(
      `packValue16(52421) wiki example failed — expected [0x45, 0x19, 0x03], got [${wikiPacked.map((b) => '0x' + b.toString(16)).join(', ')}]`,
    );
  }
  const round = unpackValue16(wikiPacked[0], wikiPacked[1], wikiPacked[2]);
  if (round !== 52421) {
    throw new Error(`unpackValue16 round-trip failed — expected 52421, got ${round}`);
  }

  // Endpoint round-trips for 14- and 16-bit boundaries.
  for (const v of [0, 1, 127, 128, 16383, 16384, 32767, 45871, 65534, 65535]) {
    const [a, b, c] = packValue16(v);
    const back = unpackValue16(a, b, c);
    if (back !== v) {
      throw new Error(`packValue16/unpackValue16 round-trip drift at ${v} — got ${back}`);
    }
  }

  // Out-of-range rejections.
  for (const bad of [-1, 0x10000, 1.5]) {
    let threw = false;
    try {
      packValue16(bad);
    } catch {
      threw = true;
    }
    if (!threw) {
      throw new Error(`packValue16(${bad}) should have thrown`);
    }
  }

  // Model-byte constant.
  if (AXE_FX_II_XL_PLUS_MODEL_ID !== 0x07) {
    throw new Error(
      `AXE_FX_II_XL_PLUS_MODEL_ID drift — expected 0x07, got 0x${AXE_FX_II_XL_PLUS_MODEL_ID.toString(16)}`,
    );
  }

  // fn 0x0E QUERY_STATES parse round-trip. The 62-byte capture must tile
  // into exactly 11 five-byte records, and re-emitting [tag, ...stateSeptets]
  // must reproduce the payload (header..F7 minus the trailing F7) byte-exact.
  const fn0eRecords = parseQueryStatesResponse(FN0E_RESPONSE);
  if (fn0eRecords.length !== 11) {
    throw new Error(`fn 0x0E parse — expected 11 records, got ${fn0eRecords.length}`);
  }
  const fn0ePayload = FN0E_RESPONSE.slice(6, FN0E_RESPONSE.length - 1);
  const fn0eReemit: number[] = [];
  for (const r of fn0eRecords) {
    fn0eReemit.push(r.tag, ...r.stateSeptets);
  }
  if (!eqBytes(fn0eReemit, fn0ePayload)) {
    throw new Error(
      `fn 0x0E re-emit drift\n  expected: [${hex(fn0ePayload)}]\n  got:      [${hex(fn0eReemit)}]`,
    );
  }

  // mapQueryStatesToBlocks: records sort by state28 (per-block address,
  // monotonic in blockId) then zip to placed effectIds ascending; the tag
  // byte gives engaged (0x01) + channel (0x02 set=X / clear=Y). Synthetic
  // set covers all four (engaged × channel) tag combos + out-of-order
  // state28 + unsorted effectIds. Mirrors the hardware-verified 11/11 rule.
  const synthRecords = [
    { tag: 0x03, stateSeptets: [0, 0, 0, 0] as [number, number, number, number], state28: 5000 }, // eng, X
    { tag: 0x01, stateSeptets: [0, 0, 0, 0] as [number, number, number, number], state28: 1000 }, // eng, Y
    { tag: 0x02, stateSeptets: [0, 0, 0, 0] as [number, number, number, number], state28: 9000 }, // byp, X
    { tag: 0x00, stateSeptets: [0, 0, 0, 0] as [number, number, number, number], state28: 3000 }, // byp, Y
  ];
  const mapped = mapQueryStatesToBlocks(synthRecords, [120, 100, 140, 110]);
  const expectedMap = [
    { effectId: 100, engaged: true, channel: 'Y' },  // state28=1000 -> recB
    { effectId: 110, engaged: false, channel: 'Y' }, // state28=3000 -> recD
    { effectId: 120, engaged: true, channel: 'X' },  // state28=5000 -> recA
    { effectId: 140, engaged: false, channel: 'X' }, // state28=9000 -> recC
  ];
  for (let i = 0; i < expectedMap.length; i++) {
    const got = mapped[i];
    const exp = expectedMap[i];
    if (got.effectId !== exp.effectId || got.engaged !== exp.engaged || got.channel !== exp.channel) {
      throw new Error(
        `mapQueryStatesToBlocks[${i}] — expected ${JSON.stringify(exp)}, got ${JSON.stringify(got)}`,
      );
    }
  }
  let threwOnMismatch = false;
  try {
    mapQueryStatesToBlocks(synthRecords.slice(0, 2), [1, 2, 3]);
  } catch {
    threwOnMismatch = true;
  }
  if (!threwOnMismatch) {
    throw new Error('mapQueryStatesToBlocks should throw when record/block counts differ');
  }

  // fn 0x16 GET_PARAM_INFO 25-byte payload decode + byte-exact re-encode
  // under the 5-group plain-LE-septet model. Two captured samples (AMP 1).
  const FN16_ENUM_PAYLOAD = [
    0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x12, 0x1c, 0x04, 0x00, 0x00, 0x00, 0x7c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  const FN16_KNOB_PAYLOAD = [
    0x41, 0x10, 0x00, 0x00, 0x00, 0x2c, 0x0b, 0x1f, 0x39, 0x03, 0x0a, 0x2e,
    0x0f, 0x61, 0x03, 0x00, 0x48, 0x50, 0x4b, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  const unpack5 = (p: readonly number[], g: number): number =>
    (((p[g * 5] & 0x7f) |
      ((p[g * 5 + 1] & 0x7f) << 7) |
      ((p[g * 5 + 2] & 0x7f) << 14) |
      ((p[g * 5 + 3] & 0x7f) << 21) |
      ((p[g * 5 + 4] & 0x7f) << 28)) >>> 0);
  const pack5 = (u: number): number[] => {
    const n = u >>> 0;
    return [n & 0x7f, (n >>> 7) & 0x7f, (n >>> 14) & 0x7f, (n >>> 21) & 0x7f, (n >>> 28) & 0x0f];
  };
  const f32bits = (v: number): number => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    return new DataView(buf).getUint32(0, true);
  };
  const asF32 = (u: number): number => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, u >>> 0, true);
    return new DataView(buf).getFloat32(0, true);
  };
  // Enum sample (paramId=0, amp.effect_type): G0=16 int, G1=0.0, G2=265.0, G3=1.0, G4=0.
  if (unpack5(FN16_ENUM_PAYLOAD, 0) !== 16) {
    throw new Error(`fn 0x16 enum G0 — expected 16, got ${unpack5(FN16_ENUM_PAYLOAD, 0)}`);
  }
  if (asF32(unpack5(FN16_ENUM_PAYLOAD, 1)) !== 0) {
    throw new Error(`fn 0x16 enum G1 — expected 0.0`);
  }
  if (asF32(unpack5(FN16_ENUM_PAYLOAD, 2)) !== 265) {
    throw new Error(`fn 0x16 enum G2 — expected 265.0, got ${asF32(unpack5(FN16_ENUM_PAYLOAD, 2))}`);
  }
  if (asF32(unpack5(FN16_ENUM_PAYLOAD, 3)) !== 1) {
    throw new Error(`fn 0x16 enum G3 — expected 1.0`);
  }
  if (unpack5(FN16_ENUM_PAYLOAD, 4) !== 0) {
    throw new Error(`fn 0x16 enum G4 — expected 0`);
  }
  // Knob sample (paramId=10, amp.bright_cap): G0=2113 int, G1~1e-5, G2~0.01, G3~1e6, G4=0.
  if (unpack5(FN16_KNOB_PAYLOAD, 0) !== 2113) {
    throw new Error(`fn 0x16 knob G0 — expected 2113, got ${unpack5(FN16_KNOB_PAYLOAD, 0)}`);
  }
  if (Math.abs(asF32(unpack5(FN16_KNOB_PAYLOAD, 1)) - 1e-5) > 1e-9) {
    throw new Error(`fn 0x16 knob G1 — expected ~1e-5, got ${asF32(unpack5(FN16_KNOB_PAYLOAD, 1))}`);
  }
  if (Math.abs(asF32(unpack5(FN16_KNOB_PAYLOAD, 2)) - 0.01) > 1e-6) {
    throw new Error(`fn 0x16 knob G2 — expected ~0.01, got ${asF32(unpack5(FN16_KNOB_PAYLOAD, 2))}`);
  }
  if (asF32(unpack5(FN16_KNOB_PAYLOAD, 3)) !== 1e6) {
    throw new Error(`fn 0x16 knob G3 — expected 1e6, got ${asF32(unpack5(FN16_KNOB_PAYLOAD, 3))}`);
  }
  if (unpack5(FN16_KNOB_PAYLOAD, 4) !== 0) {
    throw new Error(`fn 0x16 knob G4 — expected 0`);
  }
  // Byte-exact re-encode of the enum sample from its decoded group values.
  const fn16Reencode = [
    ...pack5(16),
    ...pack5(f32bits(0)),
    ...pack5(f32bits(265)),
    ...pack5(f32bits(1)),
    ...pack5(0),
  ];
  if (!eqBytes(fn16Reencode, FN16_ENUM_PAYLOAD)) {
    throw new Error(
      `fn 0x16 enum re-encode drift\n  expected: [${hex(FN16_ENUM_PAYLOAD)}]\n  got:      [${hex(fn16Reencode)}]`,
    );
  }

  // BK-PITCH-II codec-leg golden: pitch.voice_N_shift is declared over the
  // PANEL domain (signed semitones) with the offset-ordinal wire mapping
  // wire = display + 24 (unison at wire 24). Hardware anchor: XL+ 5-point
  // sweep per voice, 2026-08-02 (probe-ii-pitch-domain --sweep; the device
  // renders its own label into the GET frame): sent 0->wire 24, 1->25,
  // 3->27, 7->31, 12->36. A regen of params.ts that reverts these rows to
  // the wiki's wire-domain 0..48 copy fails here.
  for (const key of ['pitch.voice_1_shift', 'pitch.voice_2_shift'] as const) {
    const p = KNOWN_PARAMS[key];
    if (p.displayMin !== -24 || p.displayMax !== 24 || p.step !== 1) {
      throw new Error(
        `${key}: expected panel domain -24..+24 step 1, got ${p.displayMin}..${p.displayMax} step ${p.step}`,
      );
    }
    if (p.wireOrdinalOffset !== 24) {
      throw new Error(`${key}: expected wireOrdinalOffset 24, got ${p.wireOrdinalOffset}`);
    }
    for (const [display, wire] of [[0, 24], [1, 25], [3, 27], [7, 31], [12, 36], [-24, 0], [24, 48]] as const) {
      if (display + p.wireOrdinalOffset !== wire) {
        throw new Error(`${key}: display ${display} + offset must equal wire ${wire}`);
      }
    }
  }

  // Envelope goldens.
  const failed: string[] = [];
  for (const c of cases) {
    if (!eqBytes(c.built, c.expected)) {
      failed.push(`${c.label}\n  expected: [${hex(c.expected)}]\n  got:      [${hex(c.built)}]`);
    }
  }
  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${cases.length} Axe-Fx II codec golden(s) failed:\n` + failed.join('\n'),
    );
  }
}

export const AXEFX2_GOLDEN_CASE_COUNT = cases.length;
