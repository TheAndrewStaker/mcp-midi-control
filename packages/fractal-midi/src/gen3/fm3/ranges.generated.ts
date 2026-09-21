// Vendored from sKuhLight/forgefx-midi@553d24b src/gen3/fm3/ranges.generated.ts (Apache-2.0, see NOTICE).
// Unmodified apart from this header. FM3 firmware 12.0 editor data.
// GENERATED — FM3 device-true display ranges. DO NOT EDIT BY HAND.
// Source: the FM3 editor's UI configuration data (FM3 firmware 12.0). The
// generator is maintained outside this package; only this derived DATA file
// ships here.
//
// Per (block family, paramId): the device's OWN display range.
//   displayMin/displayMax = (min, max) * scale, in front-panel units
//   scale                 = display-scale multiplier (display = value * scale)
//   step                  = front-panel increment, in pre-scale value units
//   typecode              = undecoded device bitfield (unit/taper candidate)
//   enumCount             = list length for enum-kind records (ordinal max = enumCount-1)
// Placeholder ids (unused wire slots) carry all-zero rows; they are kept so the
// table mirrors the device's fn=0x1F stride layout 1:1.
//
// Strides: per-family 'stride' is the fn=0x1F channel-block WIRE stride and
// counts ordinary records only (id < 0xff00); 'recordCount' is the raw source
// section count including special table records (0xffff name tables,
// 0xfff0..0xfff3 cab-IR tables). The gen-3 fn=0x01 sub=0x01 block-definition
// cross-validation is FM9-confirmed (CABINET 106 vs 110); the FM3 data shows
// the same 106/110, FM3 device-side cross-validation pending.
//
// sectionTag -> family: 5 hardware/evidence anchors (DISTORT=10, CABINET=11,
// REVERB=12, DELAY=13, FUZZ=25) + kind/range agreement voting against the
// device-true FM3 catalog for the rest (placeholder rows excluded from votes;
// byte-identical sections grouped as block instances). Anchors re-asserted at
// generation time (amp 331-enum, FUZZ 86-enum, reverb 79-enum,
// REVERB_TIME 0.1..100 step 0.02).
//
// Status: community-beta evidence grade, derived from the device's own editor
// UI configuration data, hardware-unverified beyond the anchor points.
// NOT yet wired into live catalog resolution.
/* eslint-disable */

export interface Fm3ParamRange {
  readonly kind: 'enum' | 'float';
  /** Device-true display minimum (= cache min * scale). */
  readonly displayMin: number;
  /** Device-true display maximum (= cache max * scale). */
  readonly displayMax: number;
  /** Display-scale multiplier: display = value * scale. 0 on placeholder rows. */
  readonly scale: number;
  /** Front-panel increment, in pre-scale value units. */
  readonly step: number;
  /** Undecoded device bitfield (unit/taper candidate). */
  readonly typecode: number;
  /** Enum list length (enum kind only); valid ordinals are 0..enumCount-1. */
  readonly enumCount?: number;
  /** Device DEFAULT as the stored u16 (0..65534 body model), from the
   *  live func-0x01 self-describe walk (off+16). Absent when the param
   *  was not reachable by the 7-bit walk or its capture row was garbage.
   *  Enum params store the default ordinal directly; float/int params store
   *  the linearly-normalized default (write it as the raw u16). */
  readonly defaultRaw?: number;
  /** Device-true unit token, verbatim from the CaptureRig v2 self-describe value
   *  view (e.g. 'Hz', 'dB', 'dB/OCT', 'dBu', 'dBV', 'SAMPLES', 'SECONDS').
   *  Present only where a capture observed a unit; absent for enum/label and
   *  unitless params. (FM3 has no CaptureRig v2 capture yet, so no FM3 row
   *  currently carries one — the field is declared for schema uniformity with
   *  FM9/Axe-Fx III.) */
  readonly unit?: string;
  /** Device-true value taper from the CaptureRig v2 curve fit (reliable fits
   *  only): 'linear' | 'log' | 'flat' emitted bare; 'custom' also carries
   *  `taperPoints`. Absent when no reliable taper was captured. */
  readonly taper?: 'linear' | 'log' | 'flat' | 'custom';
  /** Sample points [normalized 0..1, raw value] for a 'custom' taper only. */
  readonly taperPoints?: ReadonlyArray<readonly [number, number]>;
}

/** Per-family cache section tag + fn=0x1F channel-block stride. */
export interface Fm3RangeFamilyMeta {
  readonly sectionTag: number;
  /** fn=0x1F channel-block WIRE stride: ordinary records only (id < 0xff00).
   *  Excludes special table records (0xffff name tables, 0xfff0.. cab-IR
   *  tables); gen-3 sub=0x01 cross-validation is FM9-confirmed (CABINET 106 vs
   *  110); the FM3 cache matches, FM3 device-side cross-validation pending. */
  readonly stride: number;
  /** Raw cache section record count as declared, INCLUDING special table
   *  records. Equals stride for sections without specials. */
  readonly recordCount: number;
  /** Present when the device registers multiple byte-identical instance
   *  sections for this family (e.g. Input 1..4, Output 1..3). */
  readonly instanceTags?: readonly number[];
}

/** Device-true FM3 display ranges, keyed by catalog family then paramId. 1831 rows. */
export const FM3_RANGES: Readonly<Record<string, Readonly<Record<number, Fm3ParamRange>>>> = {
  /** sectionTag 11, wire stride 106 (fn=0x1F channel-block stride, ordinary records only); 110 cache records incl. 4 special table record(s). */
  CABINET: {
    0: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 1, typecode: 0x10, enumCount: 5, defaultRaw: 0 }, // CABINET_BANK1
    1: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 1, typecode: 0x10, enumCount: 5, defaultRaw: 0 }, // CABINET_BANK2
    2: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_BANK3
    3: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_BANK4
    4: { kind: 'float', displayMin: 0, displayMax: 1023, scale: 1, step: 1, typecode: 0x20, defaultRaw: 0 }, // CABINET_TYPE1
    5: { kind: 'float', displayMin: 0, displayMax: 1023, scale: 1, step: 1, typecode: 0x20, defaultRaw: 0 }, // CABINET_TYPE2
    6: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_TYPE3
    7: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_TYPE4
    8: { kind: 'float', displayMin: -40, displayMax: 0, scale: 1, step: 0.05, typecode: 0x162, defaultRaw: 65534 }, // CABINET_LEVEL1
    9: { kind: 'float', displayMin: -40, displayMax: 0, scale: 1, step: 0.05, typecode: 0x162, defaultRaw: 65534 }, // CABINET_LEVEL2
    10: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_LEVEL3
    11: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_LEVEL4
    12: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // CABINET_PAN1
    13: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // CABINET_PAN2
    14: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_PAN3
    15: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_PAN4
    16: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1000, step: 0.000001, typecode: 0x433, defaultRaw: 0 }, // CABINET_DELAY1
    17: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1000, step: 0.000001, typecode: 0x433, defaultRaw: 0 }, // CABINET_DELAY2
    18: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_DELAY3
    19: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_DELAY4
    20: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // CABINET_PROXIMITY1
    21: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // CABINET_PROXIMITY2
    22: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_PROXIMITY3
    23: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_PROXIMITY4
    24: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // CABINET_MUTE1
    25: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3, defaultRaw: 1 }, // CABINET_MUTE2
    26: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_MUTE3
    27: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_MUTE4
    28: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.05, typecode: 0x181, defaultRaw: 52427 }, // CABINET_LEVEL
    29: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // CABINET_PAN
    30: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0.001, typecode: 0xb0, enumCount: 2, defaultRaw: 0 }, // CABINET_BYPASSMODE
    31: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CABINET_MODE
    32: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // CABINET_BYPASS
    33: { kind: 'float', displayMin: 0.01, displayMax: 10, scale: 10, step: 0.001, typecode: 0x52, defaultRaw: 0 }, // CABINET_DRIVE
    34: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // CABINET_BIAS
    35: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CABINET_ROOMMIX
    36: { kind: 'float', displayMin: 3, displayMax: 30, scale: 1, step: 0, typecode: 0xc42, defaultRaw: 16990 }, // CABINET_ROOMSIZE
    37: { kind: 'float', displayMin: 0, displayMax: 100, scale: 1, step: 0.1, typecode: 0xa31, defaultRaw: 11141 }, // CABINET_MICSPACE
    38: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 0 }, // CABINET_LOCUT
    39: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 65534 }, // CABINET_HICUT
    40: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, defaultRaw: 0 }, // CABINET_ZOOM
    41: { kind: 'float', displayMin: 20, displayMax: 200, scale: 1, step: 0, typecode: 0x241, defaultRaw: 36408 }, // CABINET_PROXFREQ
    42: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 1 }, // CABINET_INPUTSEL
    43: { kind: 'enum', displayMin: 0, displayMax: 11, scale: 1, step: 0, typecode: 0x10, enumCount: 12, defaultRaw: 0 }, // CABINET_PRETYPE
    44: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x132, defaultRaw: 32767 }, // CABINET_BASS
    45: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x132, defaultRaw: 32767 }, // CABINET_MID
    46: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x132, defaultRaw: 32767 }, // CABINET_TREBLE
    47: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CABINET_OVERSAMPLE
    48: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_SMOOTH1
    49: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_SMOOTH2
    50: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_SMOOTH3
    51: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_SMOOTH4
    52: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_ORDER
    53: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 49150 }, // CABINET_FLOORLVL
    54: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CABINET_AIR
    55: { kind: 'float', displayMin: 2000, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 10922 }, // CABINET_AIRFREQ
    56: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CABINET_ROOMSHAPE
    57: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // CABINET_LFDAMPING
    58: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // CABINET_HFDAMPING
    59: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CABINET_DIFFUSION
    60: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_GAINMONITOR
    61: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_VUMETER
    62: { kind: 'float', displayMin: 20, displayMax: 200, scale: 1, step: 0, typecode: 0x241, defaultRaw: 0 }, // CABINET_LOCUT1
    63: { kind: 'float', displayMin: 20, displayMax: 200, scale: 1, step: 0, typecode: 0x241, defaultRaw: 0 }, // CABINET_LOCUT2
    64: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_LOCUT3
    65: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_LOCUT4
    66: { kind: 'float', displayMin: 2000, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 65534 }, // CABINET_HICUT1
    67: { kind: 'float', displayMin: 2000, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 65534 }, // CABINET_HICUT2
    68: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_HICUT3
    69: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_HICUT4
    70: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0.001, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CABINET_LENGTH1
    71: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0.001, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CABINET_LENGTH2
    72: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_LENGTH3
    73: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_LENGTH4
    74: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0.001, typecode: 0x10, enumCount: 4, defaultRaw: 1 }, // CABINET_LOSLOPE1
    75: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0.001, typecode: 0x10, enumCount: 4, defaultRaw: 1 }, // CABINET_LOSLOPE2
    76: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_LOSLOPE3
    77: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_LOSLOPE4
    78: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0.001, typecode: 0x10, enumCount: 4, defaultRaw: 1 }, // CABINET_HISLOPE1
    79: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0.001, typecode: 0x10, enumCount: 4, defaultRaw: 1 }, // CABINET_HISLOPE2
    80: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_HISLOPE3
    81: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_HISLOPE4
    82: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0.001, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // CABINET_PRELOSLOPE
    83: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0.001, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // CABINET_PREHISLOPE
    84: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CABINET_SCENEIGNORE
    85: { kind: 'enum', displayMin: 0, displayMax: 44, scale: 1, step: 0.001, typecode: 0x10, enumCount: 45, defaultRaw: 0 }, // CABINET_DYNACAB_TYPE1
    86: { kind: 'enum', displayMin: 0, displayMax: 44, scale: 1, step: 0.001, typecode: 0x10, enumCount: 45, defaultRaw: 0 }, // CABINET_DYNACAB_TYPE2
    87: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    88: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    89: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0.001, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // CABINET_DYNACAB_MIC1
    90: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0.001, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // CABINET_DYNACAB_MIC2
    91: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    92: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CABINET_DYNACAB_MIC4
    93: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // CABINET_DYNACAB_R1
    94: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // CABINET_DYNACAB_R2
    95: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    96: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    97: { kind: 'float', displayMin: 0, displayMax: 24, scale: 24, step: 0.001, typecode: 0xa32, defaultRaw: 13107 }, // CABINET_DYNACAB_Z1
    98: { kind: 'float', displayMin: 0, displayMax: 24, scale: 24, step: 0.001, typecode: 0xa32, defaultRaw: 13107 }, // CABINET_DYNACAB_Z2
    99: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    100: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    101: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    102: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    103: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    104: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    105: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CABINET_AUTO_ALIGN
  },
  /** sectionTag 16, wire stride 29 (fn=0x1F channel-block stride, ordinary records only). */
  CHORUS: {
    0: { kind: 'enum', displayMin: 0, displayMax: 17, scale: 1, step: 0, typecode: 0x10, enumCount: 18, defaultRaw: 0 }, // CHORUS_TYPE
    1: { kind: 'float', displayMin: 2, displayMax: 8, scale: 2, step: 0, typecode: 0x10, defaultRaw: 0 }, // CHORUS_VOICES
    2: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 5958 }, // CHORUS_RATE
    3: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // CHORUS_TEMPO
    4: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // CHORUS_DEPTH
    5: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 65534 }, // CHORUS_HICUT
    6: { kind: 'float', displayMin: 0.1, displayMax: 50, scale: 1000, step: 0.00001, typecode: 0x432, defaultRaw: 26135 }, // CHORUS_DELAYTIME
    7: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 0 }, // CHORUS_LFOPHASE
    8: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // CHORUS_LFOTYPE
    9: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 1 }, // CHORUS_AUTO
    10: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x570, defaultRaw: 32767 }, // CHORUS_MIX
    11: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // CHORUS_LEVEL
    12: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // CHORUS_PAN
    13: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0xa0, enumCount: 3, defaultRaw: 0 }, // CHORUS_BYPASSMODE
    14: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0, defaultRaw: 0 }, // CHORUS_GLOBALMIX
    15: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // CHORUS_BYPASS
    16: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // CHORUS_PHASEREV
    17: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CHORUS_WIDTH
    18: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 0 }, // CHORUS_RATE2
    19: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CHORUS_DEPTH2
    20: { kind: 'float', displayMin: 0.5, displayMax: 500, scale: 10, step: 0.001, typecode: 0x52, defaultRaw: 0 }, // CHORUS_DRIVE
    21: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 0 }, // CHORUS_LOWCUT
    22: { kind: 'float', displayMin: -200, displayMax: 200, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 49150 }, // CHORUS_SPREAD
    23: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // CHORUS_MODE
    24: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // CHORUS_DEPTHL
    25: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // CHORUS_DEPTHC
    26: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // CHORUS_DEPTHR
    27: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // CHORUS_TEMPO2
    28: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CHORUS_SCENEIGNORE
  },
  /** sectionTag 7, wire stride 37 (fn=0x1F channel-block stride, ordinary records only). */
  COMP: {
    0: { kind: 'float', displayMin: -60, displayMax: 20, scale: 1, step: 0.1, typecode: 0x161, defaultRaw: 16384 }, // COMP_THRESH
    1: { kind: 'float', displayMin: 1, displayMax: 20, scale: 1, step: 0.01, typecode: 0x43, defaultRaw: 3449 }, // COMP_RATIO
    2: { kind: 'float', displayMin: 0.1, displayMax: 100, scale: 1000, step: 0, typecode: 0x443, defaultRaw: 1246 }, // COMP_ATTACK
    3: { kind: 'float', displayMin: 2, displayMax: 2000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 3214 }, // COMP_RELEASE
    4: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // COMP_LEVEL
    5: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 0, step: 0, typecode: 0x10, enumCount: 5, defaultRaw: 2 }, // COMP_KNEE
    6: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // COMP_AUTO
    7: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 0, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 1 }, // COMP_PEAKRMS
    8: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 0 }, // COMP_LOWCUT
    9: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // COMP_BYPASS
    10: { kind: 'enum', displayMin: 0, displayMax: 8, scale: 0, step: 0, typecode: 0x10, enumCount: 9, defaultRaw: 0 }, // COMP_SIDECHAIN
    11: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // COMP_MIX
    12: { kind: 'enum', displayMin: 0, displayMax: 18, scale: 0, step: 0, typecode: 0x10, enumCount: 19, defaultRaw: 0 }, // COMP_TYPE
    13: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // COMP_SUSTAIN
    14: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0xa0, enumCount: 3, defaultRaw: 0 }, // COMP_BYPASSMODE
    15: { kind: 'float', displayMin: 0, displayMax: 2, scale: 1000, step: 0.000020833333, typecode: 0x433, defaultRaw: 0 }, // COMP_DELAYTIME
    16: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // COMP_AUTOMODE
    17: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // COMP_EMPHASIS
    18: { kind: 'float', displayMin: -10, displayMax: 10, scale: 10, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // COMP_DYNAMICS
    19: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // COMP_INPUTSWITCH
    20: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 65534 }, // COMP_HIGHCUT
    21: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // COMP_GAIN
    22: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 12577 }, // COMP_FREQ
    23: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // COMP_Q
    24: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // COMP_LIGHTTYPE
    25: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // COMP_GAINMONITOR
    26: { kind: 'enum', displayMin: 0, displayMax: 11, scale: 1, step: 0, typecode: 0x10, enumCount: 12, defaultRaw: 0 }, // COMP_EQTYPE
    27: { kind: 'float', displayMin: -60, displayMax: 20, scale: 1, step: 0.1, typecode: 0x161, defaultRaw: 0 }, // COMP_THRESH2
    28: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // COMP_XMARK
    29: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // COMP_YMARK
    30: { kind: 'float', displayMin: 1, displayMax: 10, scale: 1, step: 0.01, typecode: 0x43, defaultRaw: 21845 }, // COMP_COMPANSION
    31: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x443, defaultRaw: 590 }, // COMP_COMPTIME
    32: { kind: 'float', displayMin: -10, displayMax: 10, scale: 10, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // COMP_COMPMATCH
    33: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 5958 }, // COMP_EMPHFREQ
    34: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // COMP_SCENEIGNORE
    35: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // COMP_TONE
    36: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 15532 }, // COMP_DRIVE
  },
  /** sectionTag 2, wire stride 130 (fn=0x1F channel-block stride, ordinary records only). */
  CONTROLLERS: {
    0: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // CONTROLLERS_LFO1TYPE
    1: { kind: 'float', displayMin: 0.05, displayMax: 30, scale: 1, step: 0, typecode: 0x243, defaultRaw: 2079 }, // CONTROLLERS_LFO1FREQ
    2: { kind: 'float', displayMin: 0, displayMax: 100, scale: 200, step: 0.0005, typecode: 0x531, defaultRaw: 65534 }, // CONTROLLERS_LFO1DEPTH
    3: { kind: 'float', displayMin: 1, displayMax: 99, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // CONTROLLERS_LFO1DUTY
    4: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 65534 }, // CONTROLLERS_LFO1PHASE
    5: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // CONTROLLERS_LFO1TEMPO
    6: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // CONTROLLERS_LFO2TYPE
    7: { kind: 'float', displayMin: 0.05, displayMax: 30, scale: 1, step: 0, typecode: 0x243, defaultRaw: 2079 }, // CONTROLLERS_LFO2FREQ
    8: { kind: 'float', displayMin: 0, displayMax: 100, scale: 200, step: 0.0005, typecode: 0x531, defaultRaw: 65534 }, // CONTROLLERS_LFO2DEPTH
    9: { kind: 'float', displayMin: 1, displayMax: 99, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // CONTROLLERS_LFO2DUTY
    10: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 65534 }, // CONTROLLERS_LFO2PHASE
    11: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // CONTROLLERS_LFO2TEMPO
    12: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // CONTROLLERS_ADSR1MODE
    13: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CONTROLLERS_ADSR1RETRIG
    14: { kind: 'float', displayMin: 1, displayMax: 10000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 321 }, // CONTROLLERS_ADSR1ATTACK
    15: { kind: 'float', displayMin: 1, displayMax: 10000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 321 }, // CONTROLLERS_ADSR1DECAY
    16: { kind: 'float', displayMin: 1, displayMax: 10000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 321 }, // CONTROLLERS_ADSR1SUSTAIN
    17: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // CONTROLLERS_ADSR1LEVEL
    18: { kind: 'float', displayMin: 1, displayMax: 10000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 321 }, // CONTROLLERS_ADSR1RELEASE
    19: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 39320 }, // CONTROLLERS_ADSR1THRESH
    20: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // CONTROLLERS_ADSR2MODE
    21: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CONTROLLERS_ADSR2RETRIG
    22: { kind: 'float', displayMin: 1, displayMax: 10000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 321 }, // CONTROLLERS_ADSR2ATTACK
    23: { kind: 'float', displayMin: 1, displayMax: 10000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 321 }, // CONTROLLERS_ADSR2DECAY
    24: { kind: 'float', displayMin: 1, displayMax: 10000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 321 }, // CONTROLLERS_ADSR2SUSTAIN
    25: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // CONTROLLERS_ADSR2LEVEL
    26: { kind: 'float', displayMin: 1, displayMax: 10000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 321 }, // CONTROLLERS_ADSR2RELEASE
    27: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 39320 }, // CONTROLLERS_ADSR2THRESH
    28: { kind: 'float', displayMin: 1, displayMax: 10000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 0 }, // CONTROLLERS_ENVATTACK
    29: { kind: 'float', displayMin: 1, displayMax: 10000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 0 }, // CONTROLLERS_ENVRELEASE
    30: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 13107 }, // CONTROLLERS_ENVSENS
    31: { kind: 'float', displayMin: 1, displayMax: 4, scale: 1, step: 0.01, typecode: 0x32, defaultRaw: 0 }, // CONTROLLERS_ENVGAIN
    32: { kind: 'float', displayMin: 24, displayMax: 250, scale: 1, step: 0, typecode: 0xb20, defaultRaw: 27837 }, // CONTROLLERS_TEMPO
    33: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CONTROLLERS_TEMPOTOUSE
    34: { kind: 'float', displayMin: 1, displayMax: 30, scale: 1, step: 0, typecode: 0x243, defaultRaw: 9039 }, // CONTROLLERS_SEQFREQ
    35: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // CONTROLLERS_SEQTEMPO
    36: { kind: 'float', displayMin: 2, displayMax: 32, scale: 1, step: 0, typecode: 0x10, defaultRaw: 13107 }, // CONTROLLERS_SEQSTAGES
    37: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // CONTROLLERS_SEQRUN
    38: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ1
    39: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ2
    40: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ3
    41: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ4
    42: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ5
    43: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ6
    44: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ7
    45: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ8
    46: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ9
    47: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ10
    48: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ11
    49: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ12
    50: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ13
    51: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ14
    52: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ15
    53: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ16
    54: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ17
    55: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ18
    56: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ19
    57: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ20
    58: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ21
    59: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ22
    60: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ23
    61: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ24
    62: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ25
    63: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ26
    64: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ27
    65: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ28
    66: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ29
    67: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ30
    68: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ31
    69: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SEQ32
    70: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CONTROLLERS_LFO1RUN
    71: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CONTROLLERS_LFO2RUN
    72: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE1_VAL1
    73: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE1_VAL2
    74: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE1_VAL3
    75: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE1_VAL4
    76: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE1_VAL5
    77: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE1_VAL6
    78: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE1_VAL7
    79: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE1_VAL8
    80: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE2_VAL1
    81: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE2_VAL2
    82: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE2_VAL3
    83: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE2_VAL4
    84: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE2_VAL5
    85: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE2_VAL6
    86: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE2_VAL7
    87: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE2_VAL8
    88: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE3_VAL1
    89: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE3_VAL2
    90: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE3_VAL3
    91: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE3_VAL4
    92: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE3_VAL5
    93: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE3_VAL6
    94: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE3_VAL7
    95: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE3_VAL8
    96: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE4_VAL1
    97: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE4_VAL2
    98: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE4_VAL3
    99: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE4_VAL4
    100: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE4_VAL5
    101: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE4_VAL6
    102: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE4_VAL7
    103: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_SCENE4_VAL8
    104: { kind: 'enum', displayMin: 1, displayMax: 32, scale: 1, step: 1, typecode: 0x10, enumCount: 32, defaultRaw: 0 }, // CONTROLLERS_LFO1QUANTIZE
    105: { kind: 'enum', displayMin: 1, displayMax: 32, scale: 1, step: 1, typecode: 0x10, enumCount: 32, defaultRaw: 0 }, // CONTROLLERS_LFO2QUANTIZE
    106: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CONTROLLERS_ADSR1SOURCE
    107: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CONTROLLERS_ADSR2SOURCE
    108: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CONTROLLERS_ENVSOURCE
    109: { kind: 'float', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0xf0, defaultRaw: 0 }, // CONTROLLERS_ENV_GAINMONITOR
    110: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // CONTROLLERS_PITCH_SOURCE
    111: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x443, defaultRaw: 0 }, // CONTROLLERS_SEQ_DAMPING
    112: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_MANUAL1
    113: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_MANUAL2
    114: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_MANUAL3
    115: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_MANUAL4
    116: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // CONTROLLERS_MANUAL5
    117: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x243, defaultRaw: 0 }, // CONTROLLERS_ENVLOWCUT
    118: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x243, defaultRaw: 65534 }, // CONTROLLERS_ENVHIGHCUT
    119: { kind: 'float', displayMin: 0.1, displayMax: 99.9, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // CONTROLLERS_LFO1BETA
    120: { kind: 'float', displayMin: 0.1, displayMax: 99.9, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // CONTROLLERS_LFO2BETA
    121: { kind: 'float', displayMin: 0.5, displayMax: 50, scale: 1, step: 0, typecode: 0x242, defaultRaw: 65534 }, // CONTROLLERS_LFO1HICUT
    122: { kind: 'float', displayMin: 0.5, displayMax: 50, scale: 1, step: 0, typecode: 0x242, defaultRaw: 65534 }, // CONTROLLERS_LFO2HICUT
    123: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CONTROLLERS_ADSR1_XMARK
    124: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CONTROLLERS_ADSR1_YMARK
    125: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CONTROLLERS_ADSR2_XMARK
    126: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // CONTROLLERS_ADSR2_YMARK
    127: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, defaultRaw: 0 }, // CONTROLLERS_SEQ_STEP
    128: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // CONTROLLERS_ADSR1_TYPE
    129: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // CONTROLLERS_ADSR2_TYPE
  },
  /** sectionTag 13, wire stride 88 (fn=0x1F channel-block stride, ordinary records only). */
  DELAY: {
    0: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571, defaultRaw: 9830 }, // DELAY_MIX
    1: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // DELAY_LEVEL
    2: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // DELAY_PAN
    3: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 1, typecode: 0xc0, enumCount: 5, defaultRaw: 0 }, // DELAY_BYPASSMODE
    4: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0, defaultRaw: 0 }, // DELAY_GLOBALMIX
    5: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // DELAY_BYPASS
    6: { kind: 'enum', displayMin: 0, displayMax: 26, scale: 1, step: 0, typecode: 0x10, enumCount: 27, defaultRaw: 0 }, // DELAY_MODEL
    7: { kind: 'enum', displayMin: 0, displayMax: 7, scale: 1, step: 0, typecode: 0x10, enumCount: 8, defaultRaw: 0 }, // DELAY_TYPE
    8: { kind: 'float', displayMin: 1, displayMax: 16000, scale: 1000, step: 0.001, typecode: 0x430, defaultRaw: 2044 }, // DELAY_TIME
    9: { kind: 'float', displayMin: 1, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // DELAY_RATIO
    10: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 36044 }, // DELAY_FEED
    11: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 36044 }, // DELAY_FEEDL
    12: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 36044 }, // DELAY_FEEDR
    13: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // DELAY_DELAYPAN
    14: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 65534 }, // DELAY_SPREAD
    15: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // DELAY_TEMPO
    16: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 0 }, // DELAY_LOCUT
    17: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 65534 }, // DELAY_HICUT
    18: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 2648 }, // DELAY_RATE1
    19: { kind: 'float', displayMin: 0.2, displayMax: 20, scale: 1, step: 0, typecode: 0x243, defaultRaw: 15887 }, // DELAY_RATE2
    20: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // DELAY_DEPTH1
    21: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // DELAY_DEPTH2
    22: { kind: 'float', displayMin: 0.5, displayMax: 500, scale: 10, step: 0.001, typecode: 0x52, defaultRaw: 0 }, // DELAY_DRIVE
    23: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // DELAY_GAIN
    24: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // DELAY_LFO1TYPE
    25: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // DELAY_LFO2TYPE
    26: { kind: 'float', displayMin: 1, displayMax: 16000, scale: 1000, step: 0.001, typecode: 0x430, defaultRaw: 2044 }, // DELAY_TIMER
    27: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // DELAY_HOLD
    28: { kind: 'float', displayMin: 0, displayMax: 200, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // DELAY_MSTRFDBK
    29: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // DELAY_TEMPOR
    30: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // DELAY_FEEDLR
    31: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // DELAY_FEEDRL
    32: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // DELAY_LEVELL
    33: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // DELAY_LEVELR
    34: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 0 }, // DELAY_PANL
    35: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 65534 }, // DELAY_PANR
    36: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 0 }, // DELAY_LFO1PHASE
    37: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 0 }, // DELAY_LFO2PHASE
    38: { kind: 'float', displayMin: 1, displayMax: 255, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 2322 }, // DELAY_SPLICETIME
    39: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // DELAY_RUN
    40: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DELAY_MODE
    41: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0x10, enumCount: 5, defaultRaw: 0 }, // DELAY_LPF_ORDER
    42: { kind: 'float', displayMin: 0, displayMax: 80, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 0 }, // DELAY_ATTEN
    43: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 26214 }, // DELAY_THRESH
    44: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x441, defaultRaw: 590 }, // DELAY_RELEASE
    45: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // DELAY_DIFFUSE
    46: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // DELAY_DIFFTIME
    47: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // DELAY_PHASEREV
    48: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // DELAY_LFO1TARGET
    49: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // DELAY_LFO2TARGET
    50: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // DELAY_LFO1TEMPO
    51: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // DELAY_LFO2TEMPO
    52: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 0 }, // DELAY_RATE3
    53: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // DELAY_LFO3TYPE
    54: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 0 }, // DELAY_LFO3PHASE
    55: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // DELAY_LFO3TEMPO
    56: { kind: 'float', displayMin: 100, displayMax: 1000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 0 }, // DELAY_FSTART
    57: { kind: 'float', displayMin: 500, displayMax: 5000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 0 }, // DELAY_FSTOP
    58: { kind: 'float', displayMin: 2, displayMax: 200, scale: 10, step: 0, typecode: 0x52, defaultRaw: 993 }, // DELAY_Q
    59: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // DELAY_FILTERQ
    60: { kind: 'float', displayMin: 0, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 0 }, // DELAY_BITREDUCE
    61: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 12577 }, // DELAY_FREQ1
    62: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 4634 }, // DELAY_FREQ2
    63: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // DELAY_Q1
    64: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // DELAY_Q2
    65: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // DELAY_GAIN1
    66: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // DELAY_GAIN2
    67: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DELAY_MAXDEPTH
    68: { kind: 'float', displayMin: 0.5, displayMax: 2, scale: 1, step: 0, typecode: 0x43, defaultRaw: 21845 }, // DELAY_SPEED
    69: { kind: 'float', displayMin: 0, displayMax: 100, scale: 1000, step: 0.0001, typecode: 0x431, defaultRaw: 0 }, // DELAY_OFFSET
    70: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0x10, enumCount: 5, defaultRaw: 0 }, // DELAY_HPF_ORDER
    71: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DELAY_COMPANDER
    72: { kind: 'float', displayMin: 1, displayMax: 100, scale: 1000, step: 0, typecode: 0x443, defaultRaw: 5958 }, // DELAY_COMPTIME
    73: { kind: 'float', displayMin: -100, displayMax: -20, scale: 1, step: 0.05, typecode: 0x162, defaultRaw: 32767 }, // DELAY_COMPTHRESH
    74: { kind: 'float', displayMin: 25, displayMax: 400, scale: 100, step: 0.001, typecode: 0x541, defaultRaw: 13107 }, // DELAY_MSTRTIME
    75: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // DELAY_DIFFRATE
    76: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // DELAY_DIFFDEPTH
    77: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // DELAY_LFO4TYPE
    78: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 5958 }, // DELAY_RATE4
    79: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // DELAY_LFO4TEMPO
    80: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // DELAY_DEPTH4
    81: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 65534 }, // DELAY_LFO4PHASE
    82: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // DELAY_LFO4TARGET
    83: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DELAY_SCENEIGNORE
    84: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // DELAY_STACKFDBK
    85: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // DELAY_HOLDFDBK
    86: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DELAY_KILLDRY
    87: { kind: 'enum', displayMin: 1, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 2 }, // DELAY_SVFTYPE
  },
  /** sectionTag 10, wire stride 144 (fn=0x1F channel-block stride, ordinary records only). */
  DISTORT: {
    0: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    1: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 44563 }, // DISTORT_LEVEL
    2: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // DISTORT_PAN
    3: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2, defaultRaw: 0 }, // DISTORT_BYPASSMODE
    4: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    5: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // DISTORT_BYPASS
    6: { kind: 'enum', displayMin: 0, displayMax: 330, scale: 1, step: 0, typecode: 0x10, enumCount: 331, defaultRaw: 0 }, // DISTORT_TYPE
    7: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_DRIVE
    8: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_BASS
    9: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_MID
    10: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_TREBLE
    11: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_MASTER
    12: { kind: 'float', displayMin: 10, displayMax: 1000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 662 }, // DISTORT_HPFREQ
    13: { kind: 'float', displayMin: 400, displayMax: 40000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 15887 }, // DISTORT_LPFREQ
    14: { kind: 'float', displayMin: 200, displayMax: 2000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 10922 }, // DISTORT_TONEFREQ
    15: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x0, defaultRaw: 65534 }, // DISTORT_XFLEAKAGE
    16: { kind: 'float', displayMin: 10, displayMax: 10000, scale: 1000000, step: 0, typecode: 0x841, defaultRaw: 0 }, // DISTORT_BRIGHTCAP
    17: { kind: 'float', displayMin: 400, displayMax: 40000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 7613 }, // DISTORT_WSLPF
    18: { kind: 'float', displayMin: 5, displayMax: 500, scale: 1, step: 0, typecode: 0x241, defaultRaw: 1986 }, // DISTORT_XFHPF
    19: { kind: 'float', displayMin: 4000, displayMax: 40000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 10922 }, // DISTORT_XFLPF
    20: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0x10, enumCount: 5, defaultRaw: 0 }, // DISTORT_TONELOC
    21: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 2 }, // DISTORT_INPUTSELECT
    22: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // DISTORT_DEPTH
    23: { kind: 'float', displayMin: -1, displayMax: 1, scale: 1, step: 0.002, typecode: 0x33, defaultRaw: 32767 }, // DISTORT_OFFSET1
    24: { kind: 'enum', displayMin: 0, displayMax: 12, scale: 1, step: 0, typecode: 0x10, enumCount: 13, defaultRaw: 0 }, // DISTORT_CLIPTYPE2
    25: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 6553 }, // DISTORT_SUPPLYSAG
    26: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // DISTORT_PRESENCE
    27: { kind: 'float', displayMin: 0, displayMax: 10, scale: 100, step: 0.0001, typecode: 0x32, defaultRaw: 22937 }, // DISTORT_BETA
    28: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 65534 }, // DISTORT_PRESFREQ
    29: { kind: 'float', displayMin: 40, displayMax: 400, scale: 1, step: 0, typecode: 0x241, defaultRaw: 9102 }, // DISTORT_SPKRLFREQ
    30: { kind: 'float', displayMin: 0, displayMax: 10, scale: 0.41666666, step: 0.024, typecode: 0x32, defaultRaw: 1365 }, // DISTORT_SPKRLFGAIN
    31: { kind: 'float', displayMin: 50, displayMax: 500, scale: 1, step: 0, typecode: 0x242, defaultRaw: 0 }, // DISTORT_DEPTHFREQ
    32: { kind: 'enum', displayMin: 0, displayMax: 7, scale: 1, step: 0, typecode: 0x10, enumCount: 8, defaultRaw: 0 }, // DISTORT_DRIVETYPE
    33: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000000, step: 0, typecode: 0x841, defaultRaw: 0 }, // DISTORT_MVCAP
    34: { kind: 'float', displayMin: 2, displayMax: 2000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 0 }, // DISTORT_WSHPF
    35: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0.001, typecode: 0x33, defaultRaw: 0 }, // DISTORT_CFCLIP
    36: { kind: 'enum', displayMin: 0, displayMax: 137, scale: 1, step: 0, typecode: 0x10, enumCount: 138, defaultRaw: 0 }, // DISTORT_TONETYPE
    37: { kind: 'float', displayMin: 1, displayMax: 100, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 19197 }, // DISTORT_TIMECONST
    38: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // DISTORT_BIAS
    39: { kind: 'enum', displayMin: 0, displayMax: 68, scale: 1, step: 0, typecode: 0x10, enumCount: 69, defaultRaw: 0 }, // DISTORT_FBTYPE
    40: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0.001, typecode: 0x33, defaultRaw: 32767 }, // DISTORT_PI_RATIO
    41: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DISTORT_BRIGHT
    42: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DISTORT_BOOST
    43: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 0 }, // DISTORT_SPKRLFQ
    44: { kind: 'float', displayMin: -1, displayMax: 1, scale: 1, step: 0.002, typecode: 0x33, defaultRaw: 32767 }, // DISTORT_OFFSET2
    45: { kind: 'float', displayMin: 400, displayMax: 4000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 65534 }, // DISTORT_SPKRHFREQ
    46: { kind: 'float', displayMin: 0, displayMax: 10, scale: 0.41666666, step: 0.024, typecode: 0x32, defaultRaw: 1365 }, // DISTORT_SPKRHFGAIN
    47: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DISTORT_CUT
    48: { kind: 'float', displayMin: 0.01, displayMax: 10, scale: 1, step: 0, typecode: 0x42, defaultRaw: 6494 }, // DISTORT_XDRIVE
    49: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 5958 }, // DISTORT_TRIM
    50: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 55704 }, // DISTORT_HARDNESS2
    51: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // DISTORT_MVPOSITION
    52: { kind: 'float', displayMin: 0, displayMax: 10, scale: 2, step: 0.001, typecode: 0x32, defaultRaw: 13107 }, // DISTORT_SPKRDRIVE
    53: { kind: 'float', displayMin: 0.5, displayMax: 2, scale: 1, step: 0.001, typecode: 0x43, defaultRaw: 21845 }, // DISTORT_XFMATCH
    54: { kind: 'float', displayMin: 1, displayMax: 100, scale: 1, step: 0.001, typecode: 0x42, defaultRaw: 5958 }, // DISTORT_SCREENFREQ
    55: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0.001, typecode: 0x43, defaultRaw: 8605 }, // DISTORT_SCREENQ
    56: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // DISTORT_SATSWITCH
    57: { kind: 'float', displayMin: -12, displayMax: 12, scale: 12, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_EQ1
    58: { kind: 'float', displayMin: -12, displayMax: 12, scale: 12, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_EQ2
    59: { kind: 'float', displayMin: -12, displayMax: 12, scale: 12, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_EQ3
    60: { kind: 'float', displayMin: -12, displayMax: 12, scale: 12, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_EQ4
    61: { kind: 'float', displayMin: -12, displayMax: 12, scale: 12, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_EQ5
    62: { kind: 'float', displayMin: -12, displayMax: 12, scale: 12, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_EQ6
    63: { kind: 'float', displayMin: -12, displayMax: 12, scale: 12, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_EQ7
    64: { kind: 'float', displayMin: -12, displayMax: 12, scale: 12, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_EQ8
    65: { kind: 'float', displayMin: 0, displayMax: 200, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // DISTORT_BIASEXCURSION
    66: { kind: 'float', displayMin: 0.25, displayMax: 25, scale: 1000, step: 0, typecode: 0x443, defaultRaw: 0 }, // DISTORT_EXCURSIONTIME
    67: { kind: 'float', displayMin: 0.5, displayMax: 50, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 0 }, // DISTORT_RECOVERYTIME
    68: { kind: 'float', displayMin: 400, displayMax: 40000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 65534 }, // DISTORT_FEEDFWDFREQ2
    69: { kind: 'float', displayMin: 400, displayMax: 40000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 65534 }, // DISTORT_FEEDFWDFREQ1
    70: { kind: 'enum', displayMin: 0, displayMax: 24, scale: 1, step: 0, typecode: 0x10, enumCount: 25, defaultRaw: 2 }, // DISTORT_TUBETYPE
    71: { kind: 'enum', displayMin: 0, displayMax: 8, scale: 1, step: 0, typecode: 0x10, enumCount: 9, defaultRaw: 0 }, // DISTORT_PRETUBETYPE
    72: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 10, step: 0.001, typecode: 0x52, defaultRaw: 0 }, // DISTORT_CLARITY
    73: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0.001, typecode: 0x43, defaultRaw: 4018 }, // DISTORT_INEQQ
    74: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 19197 }, // DISTORT_INEQFREQ
    75: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // DISTORT_INEQGAIN
    76: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_DRIVE2
    77: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // DISTORT_COMPRESSION
    78: { kind: 'float', displayMin: -60, displayMax: 0, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 65534 }, // DISTORT_THRESHOLD
    79: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 0 }, // DISTORT_MVTRIM
    80: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DISTORT_FAT
    81: { kind: 'float', displayMin: -10.00014, displayMax: 10.00014, scale: 31.623, step: 0.000316, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_DEFINITION
    82: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // DISTORT_CFTHRESH
    83: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // DISTORT_CFGRID
    84: { kind: 'float', displayMin: 0, displayMax: 0, scale: 1, step: 0, typecode: 0x10, defaultRaw: 1 }, // DISTORT_VERSION
    85: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 0 }, // DISTORT_HICUT
    86: { kind: 'float', displayMin: -10, displayMax: 10, scale: 10, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_DYNPRES
    87: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // DISTORT_DYNDEPTH
    88: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DISTORT_SUPPLYTYPE
    89: { kind: 'float', displayMin: 30, displayMax: 100, scale: 1, step: 5, typecode: 0x230, defaultRaw: 28086 }, // DISTORT_LINEFREQ
    90: { kind: 'float', displayMin: 2.5, displayMax: 40, scale: 10, step: 0.001, typecode: 0x52, defaultRaw: 13107 }, // DISTORT_PAHARDNESS
    91: { kind: 'float', displayMin: 0.2, displayMax: 20, scale: 1, step: 0, typecode: 0x243, defaultRaw: 15887 }, // DISTORT_TREMFREQ
    92: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // DISTORT_TREMDEPTH
    93: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // DISTORT_BIASTYPE
    94: { kind: 'enum', displayMin: 0, displayMax: 10, scale: 1, step: 0, typecode: 0x10, enumCount: 11, defaultRaw: 0 }, // DISTORT_EQTYPE
    95: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // DISTORT_CBRATIO
    96: { kind: 'float', displayMin: 1, displayMax: 100, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 0 }, // DISTORT_CBTIME
    97: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // DISTORT_DYNIMP
    98: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // DISTORT_PRESAG
    99: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.024, typecode: 0x132, defaultRaw: 32767 }, // DISTORT_HITREBLE
    100: { kind: 'float', displayMin: -1, displayMax: 1, scale: 1, step: 0.002, typecode: 0x33, defaultRaw: 32767 }, // DISTORT_PAOFFSET
    101: { kind: 'float', displayMin: -10, displayMax: 10, scale: 10, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // DISTORT_INDYNAMICS
    102: { kind: 'float', displayMin: 1, displayMax: 10, scale: 10, step: 0, typecode: 0x43, defaultRaw: 19515 }, // DISTORT_SPKRHFQ
    103: { kind: 'float', displayMin: 50, displayMax: 150, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // DISTORT_VARIAC
    104: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 1 }, // DISTORT_INEQTYPE
    105: { kind: 'float', displayMin: 10, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 58252 }, // DISTORT_GRIDHARDNESS
    106: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DISTORT_PRESSHIFT
    107: { kind: 'float', displayMin: 1, displayMax: 10, scale: 1, step: 0.01, typecode: 0x33, defaultRaw: 0 }, // DISTORT_SATDRIVE
    108: { kind: 'float', displayMin: 0, displayMax: 200, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // DISTORT_TRIODE2RATIO
    109: { kind: 'float', displayMin: 0.1, displayMax: 100, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 0 }, // DISTORT_TRIODE2EXTIME
    110: { kind: 'float', displayMin: 0.2, displayMax: 200, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 0 }, // DISTORT_TRIODE2RECTIME
    111: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // DISTORT_COMPTYPE
    112: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // DISTORT_EQPOSITION
    113: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DISTORT_PRECOMPTYPE
    114: { kind: 'float', displayMin: -200, displayMax: 200, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // DISTORT_TRIODE1RATIO
    115: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // DISTORT_CFHARDNESS
    116: { kind: 'float', displayMin: 0, displayMax: 200, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // DISTORT_PIEXCURSION
    117: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 6553 }, // DISTORT_MOTORDRIVE
    118: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 12577 }, // DISTORT_MDTIME
    119: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x0, defaultRaw: 65534 }, // DISTORT_RESOLUTION
    120: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x0, defaultRaw: 0 }, // DISTORT_VCCMON
    121: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x0, defaultRaw: 0 }, // DISTORT_GAINMON
    122: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x0, defaultRaw: 0 }, // DISTORT_MDMON
    123: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x0, defaultRaw: 0 }, // DISTORT_INDYNMON
    124: { kind: 'float', displayMin: 0, displayMax: 24, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // DISTORT_BOOSTLVL
    125: { kind: 'enum', displayMin: 0, displayMax: 14, scale: 1, step: 0, typecode: 0x10, enumCount: 15, defaultRaw: 0 }, // DISTORT_BOOSTTYPE
    126: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // DISTORT_OUTPUTTYPE
    127: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // DISTORT_SPKRDYNAMICS
    128: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // DISTORT_EQONOFF
    129: { kind: 'float', displayMin: 0.5, displayMax: 2, scale: 1, step: 0.001, typecode: 0x43 }, // DISTORT_SPKRDCR
    130: { kind: 'enum', displayMin: 0, displayMax: 92, scale: 1, step: 0, typecode: 0x10, enumCount: 93 }, // DISTORT_SPKRMODEL
    131: { kind: 'float', displayMin: 0, displayMax: 200, scale: 100, step: 0.001, typecode: 0x531 }, // DISTORT_CABRESONANCE
    132: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x0 }, // DISTORT_VPLATEMON
    133: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32 }, // DISTORT_PREPRESENCE
    134: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // DISTORT_BIASX
    135: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32 }, // DISTORT_PAHICUT
    136: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // DISTORT_PAONOFF
    137: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // DISTORT_SCENEIGNORE
    138: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3 }, // DISTORT_SPKRBREAKUP
    139: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32 }, // DISTORT_SPKRTHUMP
    140: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // DISTORT_PLATEDIODE
    141: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32 }, // DISTORT_GLOBALMASTER
    142: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // DISTORT_AUTO_SPKR_Z
    143: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // DISTORT_NFBCOMP
  },
  /** sectionTag 26, wire stride 12 (fn=0x1F channel-block stride, ordinary records only). */
  ENHANCER: {
    0: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // ENHANCER_WIDTH
    1: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // ENHANCER_DEPTH
    2: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 2648 }, // ENHANCER_LOWCUT
    3: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 5958 }, // ENHANCER_HICUT
    4: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // ENHANCER_LEVEL
    5: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // ENHANCER_BYPASS
    6: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // ENHANCER_TYPE
    7: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // ENHANCER_PHASE
    8: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 0 }, // ENHANCER_PANL
    9: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 65534 }, // ENHANCER_PANR
    10: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // ENHANCER_PAN
    11: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // ENHANCER_SCENEIGNORE
  },
  /** sectionTag 30, wire stride 6 (fn=0x1F channel-block stride, ordinary records only). */
  FDBKRET: {
    0: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // FDBKRET_RETLEVEL
    1: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181 }, // FDBKRET_LEVEL
    2: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91 }, // FDBKRET_PAN
    3: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0xa0, enumCount: 3 }, // FDBKRET_BYPASSMODE
    4: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0 }, // FDBKRET_GLOBALMIX
    5: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0 }, // FDBKRET_BYPASS
  },
  /** sectionTag 29, wire stride 2 (fn=0x1F channel-block stride, ordinary records only). */
  FDBKSEND: {
    0: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // FDBKSEND_SENDLEVEL
    1: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181 }, // FDBKSEND_OUTLEVEL
  },
  /** sectionTag 24, wire stride 37 (fn=0x1F channel-block stride, ordinary records only). */
  FILTER: {
    0: { kind: 'enum', displayMin: 0, displayMax: 17, scale: 1, step: 0, typecode: 0x10, enumCount: 18, defaultRaw: 0 }, // FILTER_TYPE
    1: { kind: 'float', displayMin: 20, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 3214 }, // FILTER_FREQ
    2: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // FILTER_Q
    3: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // FILTER_GAIN
    4: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // FILTER_LEVEL
    5: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // FILTER_BAL
    6: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2, defaultRaw: 0 }, // FILTER_BYPASSMODE
    7: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // FILTER_ORDER
    8: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // FILTER_BYPASS
    9: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 0 }, // FILTER_PANL
    10: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 65534 }, // FILTER_PANR
    11: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // FILTER_PHASE
    12: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 0 }, // FILTER_LOWCUT
    13: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 65534 }, // FILTER_HICUT
    14: { kind: 'float', displayMin: 0, displayMax: 40, scale: 1000, step: 0.00001, typecode: 0x432, defaultRaw: 0 }, // FILTER_COMBTIME
    15: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // FILTER_FEEDBACK
    16: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // FILTER_LFOENABLE
    17: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // FILTER_LFOTYPE
    18: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 5958 }, // FILTER_LFOFREQ
    19: { kind: 'float', displayMin: 1, displayMax: 99, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // FILTER_LFODUTY
    20: { kind: 'float', displayMin: 20, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 3214 }, // FILTER_MODFREQ
    21: { kind: 'enum', displayMin: 1, displayMax: 32, scale: 1, step: 1, typecode: 0x10, enumCount: 32, defaultRaw: 0 }, // FILTER_QUANTIZE
    22: { kind: 'float', displayMin: 1, displayMax: 12, scale: 1, step: 0, typecode: 0x10, defaultRaw: 0 }, // FILTER_APORDER
    23: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // FILTER_SCENEIGNORE
    24: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // FILTER_EVFTYPE
    25: { kind: 'float', displayMin: 10, displayMax: 200, scale: 10, step: 0, typecode: 0x52, defaultRaw: 17246 }, // FILTER_EVFQ
    26: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 530 }, // FILTER_START
    27: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 11253 }, // FILTER_STOP
    28: { kind: 'float', displayMin: 1, displayMax: 400, scale: 10, step: 0, typecode: 0x52, defaultRaw: 3121 }, // FILTER_SENS
    29: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x443, defaultRaw: 197 }, // FILTER_ATTACK
    30: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 5461 }, // FILTER_RELEASE
    31: { kind: 'float', displayMin: 0, displayMax: 10, scale: 5, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // FILTER_BETA
    32: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // FILTER_SOURCE
    33: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // FILTER_DETMON
    34: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // FILTER_EMPH
    35: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // FILTER_TEMPO
    36: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x570, defaultRaw: 65534 }, // FILTER_MIX
  },
  /** sectionTag 17, wire stride 33 (fn=0x1F channel-block stride, ordinary records only). */
  FLANGER: {
    0: { kind: 'enum', displayMin: 0, displayMax: 30, scale: 1, step: 0, typecode: 0x10, enumCount: 31, defaultRaw: 0 }, // FLANGER_TYPE
    1: { kind: 'float', displayMin: 0.05, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 1317 }, // OLD_FLANGER_RATE
    2: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // OLD_FLANGER_TEMPO
    3: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 16384 }, // OLD_FLANGER_DEPTH
    4: { kind: 'float', displayMin: -99.5, displayMax: 99.5, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 49233 }, // OLD_FLANGER_FEEDBACK
    5: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // OLD_FLANGER_DELAYTIME
    6: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // OLD_FLANGER_MANUAL
    7: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 0 }, // OLD_FLANGER_LFOPHASE
    8: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // OLD_FLANGER_LFOTYPE
    9: { kind: 'float', displayMin: 0.5, displayMax: 50, scale: 1, step: 0, typecode: 0x242, defaultRaw: 65534 }, // OLD_FLANGER_LFOFILTER
    10: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 1 }, // OLD_FLANGER_AUTO
    11: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571, defaultRaw: 32767 }, // OLD_FLANGER_MIX
    12: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // OLD_FLANGER_LEVEL
    13: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // OLD_FLANGER_PAN
    14: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0xa0, enumCount: 3, defaultRaw: 0 }, // OLD_FLANGER_BYPASSMODE
    15: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0, defaultRaw: 0 }, // FLANGER_GLOBALMIX
    16: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // OLD_FLANGER_BYPASS
    17: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // OLD_FLANGER_PHASEREV
    18: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // OLD_FLANGER_THRUZERO
    19: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 65534 }, // OLD_FLANGER_HICUT
    20: { kind: 'float', displayMin: 0.05, displayMax: 50, scale: 10, step: 0.001, typecode: 0x52, defaultRaw: 984 }, // OLD_FLANGER_DRIVE
    21: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x243, defaultRaw: 0 }, // OLD_FLANGER_LOWCUT
    22: { kind: 'float', displayMin: -200, displayMax: 200, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 49150 }, // OLD_FLANGER_SPREAD
    23: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0x10, enumCount: 5, defaultRaw: 0 }, // OLD_FLANGER_LFORESET
    24: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 0, typecode: 0x10, enumCount: 6, defaultRaw: 0 }, // FLANGER_LPF_ORDER
    25: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // FLANGER_HPF_ORDER
    26: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 10, step: 0.001, typecode: 0x52, defaultRaw: 0 }, // FLANGER_FOCUS
    27: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 1 }, // FLANGER_VCO_CURVE
    28: { kind: 'float', displayMin: 0.34, displayMax: 2, scale: 1000, step: 0.000002, typecode: 0x433, defaultRaw: 26056 }, // FLANGER_TMIN
    29: { kind: 'float', displayMin: 2, displayMax: 20, scale: 1000, step: 0.00001, typecode: 0x432, defaultRaw: 29126 }, // FLANGER_TMAX
    30: { kind: 'enum', displayMin: 1, displayMax: 32, scale: 1, step: 1, typecode: 0x10, enumCount: 32, defaultRaw: 0 }, // FLANGER_LFOQUANTIZE
    31: { kind: 'float', displayMin: 0.01, displayMax: 100, scale: 1, step: 0, typecode: 0x43, defaultRaw: 649 }, // FLANGER_VCOK
    32: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // FLANGER_SCENEIGNORE
  },
  /** sectionTag 21, wire stride 12 (fn=0x1F channel-block stride, ordinary records only). */
  FORMANT: {
    0: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // FORMANT_F1
    1: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 1 }, // FORMANT_F2
    2: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 2 }, // FORMANT_F3
    3: { kind: 'float', displayMin: 40, displayMax: 400, scale: 10, step: 0, typecode: 0x52, defaultRaw: 7282 }, // FORMANT_Q
    4: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // FORMANT_CTRL
    5: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571, defaultRaw: 65534 }, // FORMANT_MIX
    6: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // FORMANT_LEVEL
    7: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // FORMANT_PAN
    8: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // FORMANT_BYPASS
    9: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0xa0, enumCount: 3, defaultRaw: 0 }, // FORMANT_BYPASSMODE
    10: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0, defaultRaw: 0 }, // FORMANT_GLOBALMIX
    11: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // FORMANT_SCENEIGNORE
  },
  /** sectionTag 25, wire stride 43 (fn=0x1F channel-block stride, ordinary records only). */
  FUZZ: {
    0: { kind: 'enum', displayMin: 0, displayMax: 85, scale: 1, step: 0, typecode: 0x10, enumCount: 86, defaultRaw: 0 }, // FUZZ_TYPE
    1: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_DRIVE
    2: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_TONE
    3: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_LEVEL
    4: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // FUZZ_MIX
    5: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2, defaultRaw: 0 }, // FUZZ_BYPASSMODE
    6: { kind: 'float', displayMin: 1, displayMax: 100, scale: 10, step: 0.001, typecode: 0x52, defaultRaw: 2648 }, // FUZZ_SLEW
    7: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // FUZZ_BYPASS
    8: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 5958 }, // FUZZ_LOCUT
    9: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 32436 }, // FUZZ_HICUT
    10: { kind: 'enum', displayMin: 0, displayMax: 13, scale: 1, step: 0, typecode: 0x10, enumCount: 14, defaultRaw: 0 }, // FUZZ_CLIPTYPE
    11: { kind: 'float', displayMin: -1, displayMax: 1, scale: 1, step: 0.002, typecode: 0x33, defaultRaw: 32767 }, // FUZZ_BIAS
    12: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_LOW
    13: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_MID
    14: { kind: 'float', displayMin: 200, displayMax: 2000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 15874 }, // FUZZ_MIDFREQ
    15: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_TREBLE
    16: { kind: 'float', displayMin: 0, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 0 }, // FUZZ_BITREDUCE
    17: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 1 }, // FUZZ_INPUTSELECT
    18: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // FUZZ_PAN
    19: { kind: 'float', displayMin: 48, displayMax: 48000, scale: 48000, step: 1, typecode: 0x240, defaultRaw: 65534 }, // FUZZ_RESAMPLE
    20: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_CLIPSHAPE
    21: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 1 }, // FUZZ_EQON
    22: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_EQ1
    23: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_EQ2
    24: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_EQ3
    25: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_EQ4
    26: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_EQ5
    27: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_EQ6
    28: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_EQ7
    29: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_EQ8
    30: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_EQ9
    31: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_EQ10
    32: { kind: 'enum', displayMin: 0, displayMax: 20, scale: 1, step: 0, typecode: 0x10, enumCount: 21, defaultRaw: 0 }, // FUZZ_PDTYPE
    33: { kind: 'float', displayMin: 1, displayMax: 4, scale: 1, step: 0, typecode: 0x10, defaultRaw: 0 }, // FUZZ_PDQTY
    34: { kind: 'enum', displayMin: 0, displayMax: 20, scale: 1, step: 0, typecode: 0x10, enumCount: 21, defaultRaw: 0 }, // FUZZ_NDTYPE
    35: { kind: 'float', displayMin: 1, displayMax: 4, scale: 1, step: 0, typecode: 0x10, defaultRaw: 0 }, // FUZZ_NDQTY
    36: { kind: 'float', displayMin: 0, displayMax: 200, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // FUZZ_DRYGAIN
    37: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_BASS
    38: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_HIMID
    39: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // FUZZ_SCENEIGNORE
    40: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // FUZZ_WICKER
    41: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // FUZZ_TONESWITCH
    42: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // FUZZ_DRIVE2
  },
  /** sectionTag 35, wire stride 19 (fn=0x1F channel-block stride, ordinary records only). */
  GATE: {
    0: { kind: 'float', displayMin: -100, displayMax: 0, scale: 1, step: 0.1, typecode: 0x161 }, // GATE_THRESH
    1: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x442 }, // GATE_ATTACK
    2: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x442 }, // GATE_HOLD
    3: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x442 }, // GATE_RELEASE
    4: { kind: 'float', displayMin: 1, displayMax: 20, scale: 1, step: 0, typecode: 0x42 }, // GATE_RATIO
    5: { kind: 'enum', displayMin: 0, displayMax: 8, scale: 0, step: 0, typecode: 0x10, enumCount: 9 }, // GATE_KEY
    6: { kind: 'float', displayMin: 10, displayMax: 1000, scale: 1, step: 0, typecode: 0x242 }, // GATE_LOWCUT
    7: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // GATE_HICUT
    8: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // GATE_MIX
    9: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181 }, // GATE_LEVEL
    10: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91 }, // GATE_PAN
    11: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2 }, // GATE_BYPASSMODE
    12: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0 }, // GATE_BYPASS
    13: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // GATE_GAINMONITOR
    14: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 0, step: 0, typecode: 0x10, enumCount: 4 }, // GATE_TYPE
    15: { kind: 'float', displayMin: -80, displayMax: 0, scale: 1, step: 0.1, typecode: 0x161 }, // GATE_RANGE
    16: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // GATE_PEAKRMS
    17: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // GATE_SCENEIGNORE
    18: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 0, step: 0, typecode: 0x10, enumCount: 5 }, // GATE_KNEE
  },
  /** sectionTag 8, wire stride 20 (fn=0x1F channel-block stride, ordinary records only). */
  GEQ: {
    0: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GEQ_GAIN1
    1: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GEQ_GAIN2
    2: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GEQ_GAIN3
    3: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GEQ_GAIN4
    4: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GEQ_GAIN5
    5: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GEQ_GAIN6
    6: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GEQ_GAIN7
    7: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GEQ_GAIN8
    8: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GEQ_GAIN9
    9: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GEQ_GAIN10
    10: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // GEQ_MIX
    11: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // GEQ_LEVEL
    12: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // GEQ_PAN
    13: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2, defaultRaw: 0 }, // GEQ_BYPASSMODE
    14: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // GEQ_GLOBALMIX
    15: { kind: 'enum', displayMin: 0, displayMax: 17, scale: 1, step: 0, typecode: 0x10, enumCount: 18, defaultRaw: 4 }, // GEQ_TYPE
    16: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x42, defaultRaw: 5958 }, // GEQ_MASTERQ
    17: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // GEQ_SPARE3
    18: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // GEQ_BYPASS
    19: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GEQ_SCENEIGNORE
  },
  /** sectionTag 1, wire stride 186 (fn=0x1F channel-block stride, ordinary records only); 187 cache records incl. 1 special table record(s). */
  GLOBAL: {
    1: { kind: 'float', displayMin: 50, displayMax: 150, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // GLOBAL_REVERBMIX
    2: { kind: 'float', displayMin: 50, displayMax: 150, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // GLOBAL_EFFECTSMIX
    3: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_CABINETBYP
    4: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_PWRAMPBYP
    5: { kind: 'float', displayMin: 430, displayMax: 450, scale: 1, step: 0.1, typecode: 0x231, defaultRaw: 32767 }, // GLOBAL_TUNINGREF
    6: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // GLOBAL_TUNERMUTE
    7: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 0, step: 0, typecode: 0x10, enumCount: 5, defaultRaw: 4 }, // GLOBAL_DELAYSPILL
    8: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_USETUNEOFFSETS
    9: { kind: 'float', displayMin: -25, displayMax: 25, scale: 1, step: 0.05, typecode: 0x732, defaultRaw: 32767 }, // GLOBAL_OFFSET1
    10: { kind: 'float', displayMin: -25, displayMax: 25, scale: 1, step: 0.05, typecode: 0x732, defaultRaw: 32767 }, // GLOBAL_OFFSET2
    11: { kind: 'float', displayMin: -25, displayMax: 25, scale: 1, step: 0.05, typecode: 0x732, defaultRaw: 32767 }, // GLOBAL_OFFSET3
    12: { kind: 'float', displayMin: -25, displayMax: 25, scale: 1, step: 0.05, typecode: 0x732, defaultRaw: 32767 }, // GLOBAL_OFFSET4
    13: { kind: 'float', displayMin: -25, displayMax: 25, scale: 1, step: 0.05, typecode: 0x732, defaultRaw: 32767 }, // GLOBAL_OFFSET5
    14: { kind: 'float', displayMin: -25, displayMax: 25, scale: 1, step: 0.05, typecode: 0x732, defaultRaw: 32767 }, // GLOBAL_OFFSET6
    15: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT1EQ1
    16: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT1EQ2
    17: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT1EQ3
    18: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT1EQ4
    19: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT1EQ5
    20: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT1EQ6
    21: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT1EQ7
    22: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT1EQ8
    23: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT1EQ9
    24: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT1EQ10
    25: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x62, defaultRaw: 32767 }, // GLOBAL_LEVEL1
    26: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT2EQ1
    27: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT2EQ2
    28: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT2EQ3
    29: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT2EQ4
    30: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT2EQ5
    31: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT2EQ6
    32: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT2EQ7
    33: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT2EQ8
    34: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT2EQ9
    35: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // GLOBAL_OUT2EQ10
    36: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x62, defaultRaw: 32767 }, // GLOBAL_LEVEL2
    39: { kind: 'float', displayMin: -40, displayMax: 40, scale: 1, step: 0.1, typecode: 0x132, defaultRaw: 32767 }, // GLOBAL_GATE_OFFSET
    40: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_TAP_TEMPO_MODE
    41: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 0, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // GLOBAL_IN2_CONFIG
    44: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 0, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 1 }, // GLOBAL_IN1_TRIM
    45: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // GLOBAL_IN2_TRIM
    48: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 0, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // GLOBAL_OUT1_CONFIG
    49: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // GLOBAL_OUT2_CONFIG
    52: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_OUT1_PHASE
    53: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_OUT2_PHASE
    56: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // GLOBAL_OUT1_PAD
    57: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 0, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // GLOBAL_OUT2_PAD
    60: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // GLOBAL_COPY_OUTPUT
    61: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_IN1_SOURCE
    63: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 1 }, // GLOBAL_AES_SOURCE
    66: { kind: 'enum', displayMin: 0, displayMax: 7, scale: 0, step: 0, typecode: 0x10, enumCount: 8, defaultRaw: 1 }, // GLOBAL_FC_HOLD_TIMEOUT
    67: { kind: 'float', displayMin: 1, displayMax: 12, scale: 1, step: 1, typecode: 0x10, defaultRaw: 11915 }, // GLOBAL_FC_BANKSIZE
    68: { kind: 'enum', displayMin: 0, displayMax: 16, scale: 0, step: 0, typecode: 0x10, enumCount: 17, defaultRaw: 0 }, // GLOBAL_MIDI_CHAN
    69: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // GLOBAL_MIDI_PROG_CHANGE
    70: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_NO_REDUNDANT_PC
    71: { kind: 'float', displayMin: 0, displayMax: 383, scale: 1, step: 0, typecode: 0x20, defaultRaw: 0 }, // GLOBAL_PC_OFFSET
    72: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, defaultRaw: 0 }, // GLOBAL_DISPLAY_OFFSET
    73: { kind: 'enum', displayMin: 0, displayMax: 17, scale: 1, step: 0, typecode: 0x10, enumCount: 18, defaultRaw: 0 }, // GLOBAL_SEND_MIDIPC
    80: { kind: 'enum', displayMin: 1, displayMax: 148, scale: 0, step: 0, typecode: 0x20, enumCount: 148, defaultRaw: 128 },
    81: { kind: 'enum', displayMin: 1, displayMax: 148, scale: 0, step: 0, typecode: 0x20, enumCount: 148, defaultRaw: 128 },
    84: { kind: 'enum', displayMin: 1, displayMax: 148, scale: 0, step: 0, typecode: 0x20, enumCount: 148, defaultRaw: 128 },
    85: { kind: 'enum', displayMin: 1, displayMax: 148, scale: 0, step: 0, typecode: 0x20, enumCount: 148, defaultRaw: 128 },
    88: { kind: 'enum', displayMin: 1, displayMax: 148, scale: 0, step: 0, typecode: 0x20, enumCount: 148, defaultRaw: 128 },
    89: { kind: 'enum', displayMin: 1, displayMax: 128, scale: 0, step: 0, typecode: 0x20, enumCount: 128, defaultRaw: 128 },
    90: { kind: 'enum', displayMin: 1, displayMax: 128, scale: 0, step: 0, typecode: 0x20, enumCount: 128, defaultRaw: 128 },
    91: { kind: 'enum', displayMin: 1, displayMax: 148, scale: 0, step: 0, typecode: 0x20, enumCount: 148, defaultRaw: 128 },
    92: { kind: 'enum', displayMin: 1, displayMax: 148, scale: 0, step: 0, typecode: 0x20, enumCount: 148, defaultRaw: 128 },
    93: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_SCENE_REVERT
    94: { kind: 'enum', displayMin: 1, displayMax: 128, scale: 0, step: 0, typecode: 0x20, enumCount: 128, defaultRaw: 128 },
    95: { kind: 'enum', displayMin: 1, displayMax: 128, scale: 0, step: 0, typecode: 0x20, enumCount: 128, defaultRaw: 128 },
    97: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_MIDI_MAPPING
    99: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 0, step: 0, typecode: 0x10, enumCount: 6, defaultRaw: 5 }, // GLOBAL_USB_OUTEP_BUFF_SIZE
    100: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // GLOBAL_TUNER_SOURCE
    104: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_CC_BYPASS_TYPE
    105: { kind: 'enum', displayMin: 0, displayMax: 8, scale: 0, step: 0, typecode: 0x10, enumCount: 9, defaultRaw: 0 }, // GLOBAL_DEFAULT_SCENE
    106: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_PRESET_PROMPT
    107: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_VALUE_PUSH_FUNC
    108: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // GLOBAL_FC_SHOW_PRESET_NUM
    109: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // GLOBAL_FC_SHOW_SCENE_NUM
    110: { kind: 'float', displayMin: 25, displayMax: 100, scale: 1, step: 1, typecode: 0x531, defaultRaw: 65534 }, // GLOBAL_FC_RING_BRIGHT_LEVEL
    111: { kind: 'float', displayMin: 1, displayMax: 50, scale: 1, step: 1, typecode: 0x531, defaultRaw: 8025 }, // GLOBAL_FC_RING_DIM_LEVEL
    112: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // GLOBAL_LINEFREQ
    113: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // GLOBAL_SEND_REALTIME_SYSEX
    115: { kind: 'enum', displayMin: 1, displayMax: 128, scale: 0, step: 0, typecode: 0x20, enumCount: 128, defaultRaw: 128 },
    116: { kind: 'enum', displayMin: 1, displayMax: 128, scale: 0, step: 0, typecode: 0x20, enumCount: 128, defaultRaw: 128 },
    117: { kind: 'float', displayMin: 0, displayMax: 511, scale: 1, step: 0, typecode: 0x20, defaultRaw: 0 },
    118: { kind: 'float', displayMin: 0, displayMax: 511, scale: 1, step: 0, typecode: 0x20, defaultRaw: 16287 },
    119: { kind: 'float', displayMin: -40, displayMax: 20, scale: 1, step: 0.1, typecode: 0x162, defaultRaw: 43689 }, // GLOBAL_METLEVEL1
    120: { kind: 'float', displayMin: -40, displayMax: 20, scale: 1, step: 0.1, typecode: 0x162, defaultRaw: 43689 }, // GLOBAL_METLEVEL2
    121: { kind: 'float', displayMin: -40, displayMax: 20, scale: 1, step: 0.1, typecode: 0x162, defaultRaw: 43689 }, // GLOBAL_METLEVEL3
    123: { kind: 'float', displayMin: -40, displayMax: 20, scale: 1, step: 0.1, typecode: 0x162, defaultRaw: 43689 }, // GLOBAL_USBLEVEL1
    124: { kind: 'float', displayMin: -40, displayMax: 20, scale: 1, step: 0.1, typecode: 0x162, defaultRaw: 43689 }, // GLOBAL_USBLEVEL2
    125: { kind: 'float', displayMin: -40, displayMax: 20, scale: 1, step: 0.1, typecode: 0x162, defaultRaw: 43689 }, // GLOBAL_USBLEVEL3
    126: { kind: 'float', displayMin: -40, displayMax: 20, scale: 1, step: 0.1, typecode: 0x162, defaultRaw: 43689 }, // GLOBAL_USBLEVEL4
    131: { kind: 'float', displayMin: -40, displayMax: 20, scale: 1, step: 0.1, typecode: 0x162 }, // GLOBAL_AESLEVEL
    3598: { kind: 'enum', displayMin: 1, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 2 }, // GLOBAL_FC_TYPE_PFC1
    3599: { kind: 'enum', displayMin: 1, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 2 }, // GLOBAL_FC_TYPE_PFC2
    3600: { kind: 'enum', displayMin: 1, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 2 }, // GLOBAL_FC_TYPE_PFC3
    3602: { kind: 'float', displayMin: 1, displayMax: 9, scale: 1, step: 0.1, typecode: 0x10 }, // GLOBAL_FC_DEFAULT_LAYOUT_PFC1
    3603: { kind: 'float', displayMin: 1, displayMax: 9, scale: 1, step: 0.1, typecode: 0x10 }, // GLOBAL_FC_DEFAULT_LAYOUT_PFC2
    3604: { kind: 'float', displayMin: 1, displayMax: 9, scale: 1, step: 0.1, typecode: 0x10 }, // GLOBAL_FC_DEFAULT_LAYOUT_PFC3
    3606: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 }, // GLOBAL_FC_CLONE_PFC1
    3607: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 }, // GLOBAL_FC_CLONE_PFC2
    3608: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 }, // GLOBAL_FC_CLONE_PFC3
    3610: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 }, // GLOBAL_FC_LAYOUT_SWITCHCFG_BEGIN
    3611: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 },
    3612: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 },
    3613: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 },
    3614: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 },
    3615: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 },
    3616: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 },
    3617: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 },
    3618: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0.1, typecode: 0x10, enumCount: 3 },
    5995: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_FC_MLM_DISABLED
    6113: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_FC_PERPRESETS_DISABLED
    6979: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_CS1_ENABLE
    6985: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 1, typecode: 0x10, enumCount: 6 }, // GLOBAL_CS_EDIT_NUMBER
    6986: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // GLOBAL_CS_COMMAND_BEGIN
    7010: { kind: 'float', displayMin: 1, displayMax: 16, scale: 1, step: 1, typecode: 0x10 }, // GLOBAL_CS_CHAN_BEGIN
    7107: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_CS1_EXCLUSIVE
    7108: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_CS2_EXCLUSIVE
    7109: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_CS3_EXCLUSIVE
    7110: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_CS4_EXCLUSIVE
    7111: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_CS5_EXCLUSIVE
    7112: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_CS6_EXCLUSIVE
    7113: { kind: 'enum', displayMin: 1, displayMax: 128, scale: 0, step: 0, typecode: 0x20, enumCount: 128 },
    7114: { kind: 'enum', displayMin: 1, displayMax: 128, scale: 0, step: 0, typecode: 0x20, enumCount: 128 },
    7115: { kind: 'float', displayMin: 0, displayMax: 100, scale: 1, step: 1, typecode: 0x531 }, // GLOBAL_FS_BRIGHTNESS
    7116: { kind: 'float', displayMin: 0, displayMax: 100, scale: 1, step: 1, typecode: 0x531 }, // GLOBAL_FS_LCD_CONTRAST
    7389: { kind: 'enum', displayMin: 1, displayMax: 5, scale: 1, step: 1, typecode: 0x10, enumCount: 5 }, // GLOBAL_FC_MAINLCD_NOTIF_TIMEOUT
    7422: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_FC_HOLD_FUNCTION_MODE
    7423: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x10, enumCount: 3 }, // GLOBAL_USB_RECORD
    7424: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x10, enumCount: 3 }, // GLOBAL_USB_3_4_PLAYBACK
    7425: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_FC_FC6_FC12_MODE
    7427: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 },
    8292: { kind: 'enum', displayMin: 1, displayMax: 148, scale: 1, step: 1, typecode: 0x20, enumCount: 148 },
    8293: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_FC_FS_TUNER_MODE
    8294: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_FC_FS_INVERT
    8645: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 0, step: 0, typecode: 0x10, enumCount: 5 }, // GLOBAL_DOWNTUNE
    8646: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x10, enumCount: 3 }, // GLOBAL_TUNERACCIDENTALS
    8647: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3 }, // GLOBAL_EQ1_TYPE
    8648: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3 }, // GLOBAL_EQ2_TYPE
    8649: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242 }, // GLOBAL_EQ1_FREQ1
    8650: { kind: 'float', displayMin: 20, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // GLOBAL_EQ1_FREQ2
    8651: { kind: 'float', displayMin: 20, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // GLOBAL_EQ1_FREQ3
    8652: { kind: 'float', displayMin: 20, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // GLOBAL_EQ1_FREQ4
    8653: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // GLOBAL_EQ1_FREQ5
    8654: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // GLOBAL_EQ1_Q1
    8655: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // GLOBAL_EQ1_Q2
    8656: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // GLOBAL_EQ1_Q3
    8657: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // GLOBAL_EQ1_Q4
    8658: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // GLOBAL_EQ1_Q5
    8659: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // GLOBAL_EQ1_GAIN1
    8660: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // GLOBAL_EQ1_GAIN2
    8661: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // GLOBAL_EQ1_GAIN3
    8662: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // GLOBAL_EQ1_GAIN4
    8663: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // GLOBAL_EQ1_GAIN5
    8664: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242 }, // GLOBAL_EQ2_FREQ1
    8665: { kind: 'float', displayMin: 20, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // GLOBAL_EQ2_FREQ2
    8666: { kind: 'float', displayMin: 20, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // GLOBAL_EQ2_FREQ3
    8667: { kind: 'float', displayMin: 20, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // GLOBAL_EQ2_FREQ4
    8668: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // GLOBAL_EQ2_FREQ5
    8669: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // GLOBAL_EQ2_Q1
    8670: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // GLOBAL_EQ2_Q2
    8671: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // GLOBAL_EQ2_Q3
    8672: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // GLOBAL_EQ2_Q4
    8673: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // GLOBAL_EQ2_Q5
    8674: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // GLOBAL_EQ2_GAIN1
    8675: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // GLOBAL_EQ2_GAIN2
    8676: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // GLOBAL_EQ2_GAIN3
    8677: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // GLOBAL_EQ2_GAIN4
    8678: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // GLOBAL_EQ2_GAIN5
    8679: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // GLOBAL_OUT2_LINE
    8680: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // GLOBAL_OUT2_TYPE
    8681: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // GLOBAL_EDIT_ON_SCENE_CHANGE
    8682: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // GLOBAL_FC_BANK_LIMITS
    8683: { kind: 'enum', displayMin: 0, displayMax: 93, scale: 1, step: 0, typecode: 0x10, enumCount: 94 }, // GLOBAL_SPRK_MODEL
    8684: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // GLOBAL_USB_1_2_PLAYBACK
    8686: { kind: 'float', displayMin: 1, displayMax: 4, scale: 1, step: 1, typecode: 0x10 }, // GLOBAL_FC_STARTUP_WINDOW_FC1
    8687: { kind: 'float', displayMin: 1, displayMax: 2, scale: 1, step: 1, typecode: 0x10 }, // GLOBAL_FC_STARTUP_WINDOW_FC2
    8688: { kind: 'float', displayMin: 1, displayMax: 2, scale: 1, step: 1, typecode: 0x10 }, // GLOBAL_FC_STARTUP_WINDOW_FC3
    14873: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // GLOBAL_GAP_FILL
    14874: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_RCV_MIDI_CLOCK
    14875: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2 }, // GLOBAL_SEND_MIDI_CLOCK
    14878: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // GLOBAL_METRONOME
    14879: { kind: 'enum', displayMin: 1, displayMax: 148, scale: 1, step: 1, typecode: 0x20, enumCount: 148 }, // GLOBAL_METRONOME_CC
  },
  /** sectionTag 41, wire stride 10 (fn=0x1F channel-block stride, ordinary records only); identical instance sections 41/42. */
  INPUT: {
    0: { kind: 'float', displayMin: -100, displayMax: 0, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 26214 }, // INPUT_THRESH
    1: { kind: 'float', displayMin: 1, displayMax: 20, scale: 1, step: 0, typecode: 0x42, defaultRaw: 6898 }, // INPUT_RATIO
    2: { kind: 'float', displayMin: 10, displayMax: 1000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 5958 }, // INPUT_RELEASE
    3: { kind: 'float', displayMin: 1, displayMax: 100, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 662 }, // INPUT_ATTACK
    4: { kind: 'enum', displayMin: 0, displayMax: 12, scale: 1, step: 0, typecode: 0x10, enumCount: 13, defaultRaw: 0 }, // INPUT_Z
    5: { kind: 'float', displayMin: -40, displayMax: 40, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // INPUT_LEVEL
    6: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // INPUT_BYPASS
    7: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 1 }, // INPUT_TYPE
    8: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // INPUT_GAINMONITOR
    9: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // INPUT_MODE
  },
  /** sectionTag 50, wire stride 24 (fn=0x1F channel-block stride, ordinary records only). */
  LOOPER: {
    0: { kind: 'float', displayMin: -60, displayMax: 0, scale: 1, step: 0.05, typecode: 0x162 }, // LOOPER_PLAYLEVEL
    1: { kind: 'float', displayMin: -60, displayMax: 0, scale: 1, step: 0.05, typecode: 0x162 }, // LOOPER_DUBLEVEL
    2: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91 }, // LOOPER_PAN
    3: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0xa0, enumCount: 3 }, // LOOPER_BYPASSMODE
    4: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0 }, // LOOPER_BYPASS
    5: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242 }, // LOOPER_LOWCUT
    6: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // LOOPER_HICUT
    7: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10 }, // LOOPER_REVERSE
    8: { kind: 'float', displayMin: 0, displayMax: 0, scale: 1, step: 0, typecode: 0xf0 }, // LOOPER_RECORD
    9: { kind: 'float', displayMin: 0, displayMax: 0, scale: 1, step: 0, typecode: 0xf0 }, // LOOPER_PLAY
    10: { kind: 'float', displayMin: 0, displayMax: 0, scale: 1, step: 0, typecode: 0xf0 }, // LOOPER_UNDO
    11: { kind: 'float', displayMin: 0, displayMax: 0, scale: 1, step: 0, typecode: 0xf0 }, // LOOPER_ONCE
    12: { kind: 'float', displayMin: 0, displayMax: 0, scale: 1, step: 0, typecode: 0xf0 }, // LOOPER_DUB
    13: { kind: 'float', displayMin: -60, displayMax: 0, scale: 1, step: 0.05, typecode: 0x162 }, // LOOPER_DRYLEVEL
    14: { kind: 'float', displayMin: 0, displayMax: 0, scale: 1, step: 0, typecode: 0xf0 }, // LOOPER_STOP
    15: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x161 }, // LOOPER_THRESH
    16: { kind: 'float', displayMin: 0, displayMax: 99, scale: 100, step: 0.001, typecode: 0x532 }, // LOOPER_START_TRIM
    17: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x532 }, // LOOPER_END_TRIM
    18: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // LOOPER_QUANTIZE
    19: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3 }, // LOOPER_RECORDMODE
    20: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // LOOPER_HALF
    21: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // LOOPER_XFADE
    22: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // LOOPER_LEVEL
    23: { kind: 'float', displayMin: 0, displayMax: 120, scale: 1, step: 0.1, typecode: 0x331 }, // LOOPER_MAXTIME
  },
  /** sectionTag 33, wire stride 35 (fn=0x1F channel-block stride, ordinary records only). */
  MEGATAP: {
    0: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // MEGATAP_INGAIN
    1: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // MEGATAP_MASTERLVL
    2: { kind: 'float', displayMin: 1, displayMax: 4000, scale: 1000, step: 0.001, typecode: 0x430 }, // MEGATAP_TIME
    3: { kind: 'float', displayMin: 1, displayMax: 64, scale: 1, step: 0, typecode: 0x10 }, // MEGATAP_NUMTAPS
    4: { kind: 'float', displayMin: 0, displayMax: 1000, scale: 1000, step: 0.001, typecode: 0x430 }, // MEGATAP_PREDELAY
    5: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4 }, // MEGATAP_TIMESHAPE
    6: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // MEGATAP_TIMEALPHA
    7: { kind: 'enum', displayMin: 0, displayMax: 6, scale: 1, step: 0, typecode: 0x10, enumCount: 7 }, // MEGATAP_AMPSHAPE
    8: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // MEGATAP_AMPALPHA
    9: { kind: 'enum', displayMin: 0, displayMax: 6, scale: 1, step: 0, typecode: 0x10, enumCount: 7 }, // MEGATAP_PANSHAPE
    10: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // MEGATAP_PANALPHA
    11: { kind: 'float', displayMin: 0, displayMax: 100, scale: 200, step: 0.0005, typecode: 0x531 }, // MEGATAP_RANDOM
    12: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // MEGATAP_DIFFMIX
    13: { kind: 'float', displayMin: 1, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // MEGATAP_DIFFTIME
    14: { kind: 'float', displayMin: -100, displayMax: 0, scale: 1, step: 0.1, typecode: 0x131 }, // MEGATAP_ENVTHRESH
    15: { kind: 'float', displayMin: 10, displayMax: 10000, scale: 1000, step: 0, typecode: 0x443 }, // MEGATAP_ENVATTACK
    16: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x443 }, // MEGATAP_ENVRELEASE
    17: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571 }, // MEGATAP_MIX
    18: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181 }, // MEGATAP_LEVEL
    19: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91 }, // MEGATAP_PAN
    20: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0xc0, enumCount: 5 }, // MEGATAP_BYPASSMODE
    21: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0 }, // MEGATAP_GLOBALMIX
    22: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0 }, // MEGATAP_BYPASS
    23: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3 }, // MEGATAP_INPUTSELECT
    24: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // MEGATAP_FEEDBACK
    25: { kind: 'float', displayMin: 1, displayMax: 32, scale: 1, step: 0, typecode: 0x10 }, // MEGATAP_FDBKTAP
    26: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242 }, // MEGATAP_LOWCUT
    27: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // MEGATAP_HICUT
    28: { kind: 'enum', displayMin: 0, displayMax: 21, scale: 1, step: 0, typecode: 0x10, enumCount: 22 }, // MEGATAP_TYPE
    29: { kind: 'float', displayMin: -200, displayMax: 200, scale: 100, step: 0.002, typecode: 0x531 }, // MEGATAP_SPREAD
    30: { kind: 'float', displayMin: 0, displayMax: 100, scale: 200, step: 0.0005, typecode: 0x531 }, // MEGATAP_AMPRAND
    31: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243 }, // MEGATAP_DIFFRATE
    32: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // MEGATAP_DIFFDEPTH
    33: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // MEGATAP_SCENEIGNORE
    34: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // MEGATAP_KILLDRY
  },
  /** sectionTag 28, wire stride 17 (fn=0x1F channel-block stride, ordinary records only). */
  MIXER: {
    0: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MIXER_GAIN1
    1: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MIXER_GAIN2
    2: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MIXER_GAIN3
    3: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MIXER_GAIN4
    4: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MIXER_GAIN5
    5: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MIXER_GAIN6
    6: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // MIXER_PAN1
    7: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // MIXER_PAN2
    8: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // MIXER_PAN3
    9: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // MIXER_PAN4
    10: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // MIXER_PAN5
    11: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // MIXER_PAN6
    12: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 52427 }, // MIXER_MASTER
    13: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // MIXER_PAN
    14: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // MIXER_MODE
    15: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2, defaultRaw: 0 }, // MIXER_BYPASSMODE
    16: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // MIXER_BYPASS
  },
  /** sectionTag 3, wire stride 25 (fn=0x1F channel-block stride, ordinary records only). */
  MOD: {
    0: { kind: 'enum', displayMin: 0, displayMax: 60, scale: 1, step: 0, typecode: 0x10, enumCount: 61, defaultRaw: 0 }, // MOD_CTRLID
    1: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MOD_MIN
    2: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MOD_MAX
    3: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MOD_STARTPT
    4: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // MOD_MIDPT
    5: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MOD_ENDPT
    6: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // MOD_SLOPE
    7: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 66 }, // MOD_ATTACK
    8: { kind: 'float', displayMin: 0, displayMax: 201, scale: 1, step: 0, typecode: 0x10, defaultRaw: 0 }, // MOD_EFFECTID
    9: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MOD_PARAM
    10: { kind: 'enum', displayMin: 0, displayMax: 6, scale: 1, step: 0, typecode: 0x10, enumCount: 7, defaultRaw: 0 }, // MOD_AUTOENGAGE
    11: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // MOD_PCRESET
    12: { kind: 'float', displayMin: 5, displayMax: 95, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MOD_OFFVAL
    13: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 5958 }, // MOD_SCALE
    14: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // MOD_OFFSET
    15: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 66 }, // MOD_RELEASE
    16: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // MOD_RATE
    17: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0x10, enumCount: 5, defaultRaw: 0 }, // MOD_CHANNEL
    18: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MOD_XMARK
    19: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MOD_YMARK
    20: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MOD_CTRLID2
    21: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MOD_SCALE1
    22: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MOD_SCALE2
    23: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MOD_OPERATION
    24: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // MOD_DAMPING
  },
  /** sectionTag 37, wire stride 37 (fn=0x1F channel-block stride, ordinary records only). */
  MULTICOMP: {
    0: { kind: 'float', displayMin: 50, displayMax: 5000, scale: 1, step: 0, typecode: 0x241 }, // MULTICOMP_FREQ1
    1: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x240 }, // MULTICOMP_FREQ2
    2: { kind: 'float', displayMin: -60, displayMax: 20, scale: 1, step: 0.1, typecode: 0x161 }, // MULTICOMP_THRESH1
    3: { kind: 'float', displayMin: 1, displayMax: 20, scale: 1, step: 0, typecode: 0x43 }, // MULTICOMP_RATIO1
    4: { kind: 'float', displayMin: 1, displayMax: 100, scale: 1000, step: 0, typecode: 0x443 }, // MULTICOMP_ATTACK1
    5: { kind: 'float', displayMin: 10, displayMax: 1000, scale: 1000, step: 0, typecode: 0x442 }, // MULTICOMP_RELEASE1
    6: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x162 }, // MULTICOMP_LEVEL1
    7: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // MULTICOMP_DETECT1
    8: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // MULTICOMP_MUTE1
    9: { kind: 'float', displayMin: -60, displayMax: 20, scale: 1, step: 0.1, typecode: 0x161 }, // MULTICOMP_THRESH2
    10: { kind: 'float', displayMin: 1, displayMax: 20, scale: 1, step: 0, typecode: 0x43 }, // MULTICOMP_RATIO2
    11: { kind: 'float', displayMin: 1, displayMax: 100, scale: 1000, step: 0, typecode: 0x443 }, // MULTICOMP_ATTACK2
    12: { kind: 'float', displayMin: 10, displayMax: 1000, scale: 1000, step: 0, typecode: 0x442 }, // MULTICOMP_RELEASE2
    13: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x162 }, // MULTICOMP_LEVEL2
    14: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // MULTICOMP_DETECT2
    15: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // MULTICOMP_MUTE2
    16: { kind: 'float', displayMin: -60, displayMax: 20, scale: 1, step: 0.1, typecode: 0x161 }, // MULTICOMP_THRESH3
    17: { kind: 'float', displayMin: 1, displayMax: 20, scale: 1, step: 0, typecode: 0x43 }, // MULTICOMP_RATIO3
    18: { kind: 'float', displayMin: 1, displayMax: 100, scale: 1000, step: 0, typecode: 0x443 }, // MULTICOMP_ATTACK3
    19: { kind: 'float', displayMin: 10, displayMax: 1000, scale: 1000, step: 0, typecode: 0x442 }, // MULTICOMP_RELEASE3
    20: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x162 }, // MULTICOMP_LEVEL3
    21: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // MULTICOMP_DETECT3
    22: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // MULTICOMP_MUTE3
    23: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571 }, // MULTICOMP_MIX
    24: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181 }, // MULTICOMP_LEVEL
    25: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91 }, // MULTICOMP_PAN
    26: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2 }, // MULTICOMP_BYPASSMODE
    27: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0 }, // MULTICOMP_BYPASS
    28: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MULTICOMP_GAINMON1
    29: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MULTICOMP_GAINMON2
    30: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MULTICOMP_GAINMON3
    31: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MULTICOMP_FREQMULT1
    32: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // MULTICOMP_FREQMULT2
    33: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // MULTICOMP_ORDER
    34: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // MULTICOMP_KNEE
    35: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // MULTICOMP_AUTO
    36: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // MULTICOMP_SCENEIGNORE
  },
  /** sectionTag 54, wire stride 7 (fn=0x1F channel-block stride, ordinary records only). */
  MULTIPLEXER: {
    0: { kind: 'enum', displayMin: 0, displayMax: 7, scale: 1, step: 1, typecode: 0x10, enumCount: 8 }, // MULTIPLEXER_INPUTSEL
    1: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 1, typecode: 0x10, enumCount: 4 }, // MULTIPLEXER_INPUTMODE
    2: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181 }, // MULTIPLEXER_LEVEL
    3: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91 }, // MULTIPLEXER_PAN
    4: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2 }, // MULTIPLEXER_BYPASSMODE
    5: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0 }, // MULTIPLEXER_BYPASS
    6: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // MULTIPLEXER_SCENEIGNORE
  },
  /** sectionTag 14, wire stride 121 (fn=0x1F channel-block stride, ordinary records only). */
  MULTITAP: {
    0: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 0, typecode: 0x10, enumCount: 6, defaultRaw: 0 }, // MULTITAP_BASETYPE
    1: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 13081 }, // MULTITAP_TIME1
    2: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 19637 }, // MULTITAP_TIME2
    3: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 26194 }, // MULTITAP_TIME3
    4: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 32751 }, // MULTITAP_TIME4
    5: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 14 }, // MULTITAP_TEMPO1
    6: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 11 }, // MULTITAP_TEMPO2
    7: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 12 }, // MULTITAP_TEMPO3
    8: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 15 }, // MULTITAP_TEMPO4
    9: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_LEVEL1
    10: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_LEVEL2
    11: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_LEVEL3
    12: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_LEVEL4
    13: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 36044 }, // MULTITAP_FEEDBACK1
    14: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 36044 }, // MULTITAP_FEEDBACK2
    15: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 36044 }, // MULTITAP_FEEDBACK3
    16: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 36044 }, // MULTITAP_FEEDBACK4
    17: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 16384 }, // MULTITAP_PAN1
    18: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 49150 }, // MULTITAP_PAN2
    19: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 0 }, // MULTITAP_PAN3
    20: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 65534 }, // MULTITAP_PAN4
    21: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 2648 }, // MULTITAP_RATE1
    22: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 32436 }, // MULTITAP_RATE2
    23: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 6553 }, // MULTITAP_DEPTH1
    24: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MULTITAP_DEPTH2
    25: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // MULTITAP_LFOTYPE1
    26: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // MULTITAP_LFOTYPE2
    27: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // MULTITAP_LFOTEMPO1
    28: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // MULTITAP_LFOTEMPO2
    29: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 32767 }, // MULTITAP_LFOPHASE1
    30: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 32767 }, // MULTITAP_LFOPHASE2
    31: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571, defaultRaw: 16384 }, // MULTITAP_MIX
    32: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // MULTITAP_LEVEL
    33: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // MULTITAP_PAN
    34: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0xc0, enumCount: 5, defaultRaw: 0 }, // MULTITAP_BYPASSMODE
    35: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0, defaultRaw: 0 }, // MULTITAP_GLOBALMIX
    36: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_INGAIN
    37: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // MULTITAP_BYPASS
    38: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MULTITAP_DIFFMIX
    39: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // MULTITAP_DIFFTIME
    40: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 0 }, // MULTITAP_THRESH
    41: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_MSTRTIME
    42: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_MSTRLVL
    43: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_MSTRPAN
    44: { kind: 'float', displayMin: 0.3162, displayMax: 3.162, scale: 1, step: 0, typecode: 0x43, defaultRaw: 15747 }, // MULTITAP_MSTRFREQ
    45: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 0 }, // MULTITAP_MSTRQ
    46: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_MSTRFDBK
    47: { kind: 'float', displayMin: 1, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_MSTRRATE
    48: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_MSTRDEPTH
    49: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 2648 }, // MULTITAP_FREQ1
    50: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 4634 }, // MULTITAP_FREQ2
    51: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 9929 }, // MULTITAP_FREQ3
    52: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 15887 }, // MULTITAP_FREQ4
    53: { kind: 'float', displayMin: 0.01, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 0 }, // MULTITAP_Q1
    54: { kind: 'float', displayMin: 0.01, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 0 }, // MULTITAP_Q2
    55: { kind: 'float', displayMin: 0.01, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 0 }, // MULTITAP_Q3
    56: { kind: 'float', displayMin: 0.01, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 0 }, // MULTITAP_Q4
    57: { kind: 'float', displayMin: 0, displayMax: 80, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 0 }, // MULTITAP_ATTEN
    58: { kind: 'float', displayMin: 0.5, displayMax: 2, scale: 1, step: 0, typecode: 0x43, defaultRaw: 21845 }, // MULTITAP_SPEED
    59: { kind: 'float', displayMin: 0, displayMax: 3, scale: 0, step: 0, typecode: 0xf0, defaultRaw: 65534 }, // MULTITAP_FBKSEND
    60: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xf0, defaultRaw: 0 }, // MULTITAP_FBKRET
    61: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 0 }, // MULTITAP_LOWCUT
    62: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 65534 }, // MULTITAP_HIGHCUT
    63: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MULTITAP_FEEDBACK
    64: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 590 }, // MULTITAP_RELEASE
    65: { kind: 'float', displayMin: 5, displayMax: 5000, scale: 10, step: 0.001, typecode: 0x52, defaultRaw: 0 }, // MULTITAP_DRIVE
    66: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 0 }, // MULTITAP_FLTRATE
    67: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MULTITAP_FLTDEPTH
    68: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 0 }, // MULTITAP_FLTTYPE
    69: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // MULTITAP_FLTTEMPO
    70: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 32767 }, // MULTITAP_FLTPHASE
    71: { kind: 'float', displayMin: -100, displayMax: 0, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 0 }, // MULTITAP_ENVTHRESH
    72: { kind: 'float', displayMin: 10, displayMax: 10000, scale: 1000, step: 0, typecode: 0x443, defaultRaw: 1902 }, // MULTITAP_ENVATTACK
    73: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x443, defaultRaw: 590 }, // MULTITAP_ENVRELEASE
    74: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_MSTRCOMBTIME
    75: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // MULTITAP_MSTRCOMBGAIN
    76: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // MULTITAP_COMBTYPE
    77: { kind: 'float', displayMin: 0, displayMax: 40, scale: 1000, step: 0.00001, typecode: 0x432, defaultRaw: 164 }, // MULTITAP_COMBTIME1
    78: { kind: 'float', displayMin: 0, displayMax: 40, scale: 1000, step: 0.00001, typecode: 0x432, defaultRaw: 328 }, // MULTITAP_COMBTIME2
    79: { kind: 'float', displayMin: 0, displayMax: 40, scale: 1000, step: 0.00001, typecode: 0x432, defaultRaw: 737 }, // MULTITAP_COMBTIME3
    80: { kind: 'float', displayMin: 0, displayMax: 40, scale: 1000, step: 0.00001, typecode: 0x432, defaultRaw: 1475 }, // MULTITAP_COMBTIME4
    81: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 58981 }, // MULTITAP_COMBGAIN1
    82: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 6553 }, // MULTITAP_COMBGAIN2
    83: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 55704 }, // MULTITAP_COMBGAIN3
    84: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 9830 }, // MULTITAP_COMBGAIN4
    85: { kind: 'float', displayMin: 0, displayMax: 200, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // MULTITAP_MSTRRINGFREQ
    86: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MULTITAP_MSTRRINGMIX
    87: { kind: 'float', displayMin: 0, displayMax: 2000, scale: 1, step: 0.1, typecode: 0x33, defaultRaw: 14352 }, // MULTITAP_RINGFREQ1
    88: { kind: 'float', displayMin: 0, displayMax: 2000, scale: 1, step: 0.1, typecode: 0x33, defaultRaw: 14385 }, // MULTITAP_RINGFREQ2
    89: { kind: 'float', displayMin: 0, displayMax: 2000, scale: 1, step: 0.1, typecode: 0x33, defaultRaw: 14417 }, // MULTITAP_RINGFREQ3
    90: { kind: 'float', displayMin: 0, displayMax: 2000, scale: 1, step: 0.1, typecode: 0x33, defaultRaw: 14450 }, // MULTITAP_RINGFREQ4
    91: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_RINGMIX1
    92: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_RINGMIX2
    93: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_RINGMIX3
    94: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_RINGMIX4
    95: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 1192 }, // MULTITAP_DRATE1
    96: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 1655 }, // MULTITAP_DRATE2
    97: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 1853 }, // MULTITAP_DRATE3
    98: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 2052 }, // MULTITAP_DRATE4
    99: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MULTITAP_DDEPTH1
    100: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MULTITAP_DDEPTH2
    101: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MULTITAP_DDEPTH3
    102: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MULTITAP_DDEPTH4
    103: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // MULTITAP_INPUTSELECT
    104: { kind: 'float', displayMin: 1, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_MSTRDRATE
    105: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // MULTITAP_MSTRDDEPTH
    106: { kind: 'enum', displayMin: 0, displayMax: 8, scale: 1, step: 0, typecode: 0x10, enumCount: 9, defaultRaw: 6 }, // MULTITAP_FILTER_TYPE
    107: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 2648 }, // MULTITAP_FREQ
    108: { kind: 'float', displayMin: 0.01, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4572 }, // MULTITAP_Q
    109: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // MULTITAP_GAIN
    110: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 0.001, typecode: 0x10, enumCount: 6, defaultRaw: 0 }, // MULTITAP_LOWSLOPE
    111: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 0.001, typecode: 0x10, enumCount: 6, defaultRaw: 0 }, // MULTITAP_HIGHSLOPE
    112: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 0 }, // MULTITAP_DIFFRATE
    113: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // MULTITAP_DIFFDEPTH
    114: { kind: 'enum', displayMin: 0, displayMax: 38, scale: 1, step: 0, typecode: 0x10, enumCount: 39, defaultRaw: 0 }, // MULTITAP_PRESETS
    115: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // MULTITAP_SCENEIGNORE
    116: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // MULTITAP_FEEDBACK12
    117: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // MULTITAP_FEEDBACK23
    118: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // MULTITAP_FEEDBACK34
    119: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // MULTITAP_FEEDBACK41
    120: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // MULTITAP_KILLDRY
  },
  /** sectionTag 46, wire stride 26 (fn=0x1F channel-block stride, ordinary records only); identical instance sections 46/47. */
  OUTPUT: {
    0: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_LEVEL1
    1: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_LEVEL2
    2: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_LEVEL3
    3: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_LEVEL4
    4: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_LEVEL5
    5: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_LEVEL6
    6: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // OUTPUT_PAN1
    7: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // OUTPUT_PAN2
    8: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // OUTPUT_PAN3
    9: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // OUTPUT_PAN4
    10: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // OUTPUT_PAN5
    11: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // OUTPUT_PAN6
    12: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // OUTPUT_LEVEL
    13: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // OUTPUT_PAN
    14: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // OUTPUT_BYPASSMODE
    15: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // OUTPUT_BYPASS
    16: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // OUTPUT_VUL
    17: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // OUTPUT_VUR
    18: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_SCENE1
    19: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_SCENE2
    20: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_SCENE3
    21: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_SCENE4
    22: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_SCENE5
    23: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_SCENE6
    24: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_SCENE7
    25: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.04, typecode: 0x132, defaultRaw: 32767 }, // OUTPUT_SCENE8
  },
  /** sectionTag 9, wire stride 33 (fn=0x1F channel-block stride, ordinary records only). */
  PEQ: {
    0: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 5958 }, // PEQ_FREQ1
    1: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 1986 }, // PEQ_FREQ2
    2: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 4634 }, // PEQ_FREQ3
    3: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 9929 }, // PEQ_FREQ4
    4: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 9929 }, // PEQ_FREQ5
    5: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // PEQ_Q1
    6: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // PEQ_Q2
    7: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // PEQ_Q3
    8: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // PEQ_Q4
    9: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // PEQ_Q5
    10: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // PEQ_GAIN1
    11: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // PEQ_GAIN2
    12: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // PEQ_GAIN3
    13: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // PEQ_GAIN4
    14: { kind: 'float', displayMin: -20, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // PEQ_GAIN5
    15: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0x10, enumCount: 5, defaultRaw: 0 }, // PEQ_TYPE1
    16: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // PEQ_TYPE2
    17: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PEQ_TYPE3
    18: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // PEQ_TYPE4
    19: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0x10, enumCount: 5, defaultRaw: 0 }, // PEQ_TYPE5
    20: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // PEQ_LEVEL
    21: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // PEQ_PAN
    22: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2, defaultRaw: 0 }, // PEQ_BYPASSMODE
    23: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0, defaultRaw: 0 }, // PEQ_GLOBALMIX
    24: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // PEQ_BYPASS
    25: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PEQ_SOLO1
    26: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PEQ_SOLO2
    27: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PEQ_SOLO3
    28: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PEQ_SOLO4
    29: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PEQ_SOLO5
    30: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 0.001, typecode: 0x10, enumCount: 6, defaultRaw: 1 }, // PEQ_LOWSLOPE
    31: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 0.001, typecode: 0x10, enumCount: 6, defaultRaw: 1 }, // PEQ_HIGHSLOPE
    32: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PEQ_SCENEIGNORE
  },
  /** sectionTag 19, wire stride 35 (fn=0x1F channel-block stride, ordinary records only). */
  PHASER: {
    0: { kind: 'enum', displayMin: 0, displayMax: 16, scale: 1, step: 0, typecode: 0x10, enumCount: 17, defaultRaw: 0 }, // PHASER_TYPE
    1: { kind: 'enum', displayMin: 0, displayMax: 10, scale: 2, step: 0, typecode: 0x10, enumCount: 6, defaultRaw: 1 }, // PHASER_ORDER
    2: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 5958 }, // PHASER_RATE
    3: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 1 }, // PHASER_LFOTYPE
    4: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // PHASER_TEMPO
    5: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // PHASER_DEPTH
    6: { kind: 'float', displayMin: -99.99, displayMax: 99.99, scale: 111.1, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // PHASER_FEEDBACK
    7: { kind: 'float', displayMin: 5, displayMax: 500, scale: 1, step: 0, typecode: 0x242, defaultRaw: 25816 }, // PHASER_FMIN
    8: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 5958 }, // PHASER_FMAX
    9: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 0 }, // PHASER_LFOPHASE
    10: { kind: 'float', displayMin: -1, displayMax: 1, scale: 1, step: 0.002, typecode: 0x33, defaultRaw: 32767 }, // PHASER_BIAS
    11: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571, defaultRaw: 32767 }, // PHASER_MIX
    12: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // PHASER_LEVEL
    13: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // PHASER_PAN
    14: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0xa0, enumCount: 3, defaultRaw: 0 }, // PHASER_BYPASSMODE
    15: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0, defaultRaw: 0 }, // PHASER_GLOBALMIX
    16: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // PHASER_BYPASS
    17: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // PHASER_MODE
    18: { kind: 'float', displayMin: 0, displayMax: 11, scale: 1, step: 0, typecode: 0x10, defaultRaw: 0 }, // PHASER_FBTAP
    19: { kind: 'float', displayMin: -10.00014, displayMax: 10.00014, scale: 31.623, step: 0.000316, typecode: 0x32, defaultRaw: 32767 }, // PHASER_TONE
    20: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PHASER_DIRECTION
    21: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 5958 }, // PHASER_Q
    22: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0x10, enumCount: 5, defaultRaw: 0 }, // PHASER_LFORESET
    23: { kind: 'enum', displayMin: 1, displayMax: 32, scale: 1, step: 1, typecode: 0x10, enumCount: 32, defaultRaw: 0 }, // PHASER_LFOQUANTIZE
    24: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 1 }, // PHASER_VCR_CURVE
    25: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 5958 }, // PHASER_VCRK
    26: { kind: 'float', displayMin: 0.01, displayMax: 0.99, scale: 1, step: 0.001, typecode: 0x33, defaultRaw: 30226 }, // PHASER_LFOBETA
    27: { kind: 'float', displayMin: 0.5, displayMax: 50, scale: 1, step: 0, typecode: 0x242, defaultRaw: 65534 }, // PHASER_LFOLPF
    28: { kind: 'float', displayMin: 10, displayMax: 1000, scale: 1000, step: 0, typecode: 0x443, defaultRaw: 2648 }, // PHASER_ATTACK
    29: { kind: 'float', displayMin: 1, displayMax: 100, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 2648 }, // PHASER_RELEASE
    30: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // PHASER_MANUAL
    31: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PHASER_SCENEIGNORE
    32: { kind: 'float', displayMin: 20, displayMax: 200, scale: 1, step: 0, typecode: 0x242, defaultRaw: 0 }, // PHASER_HPF
    33: { kind: 'float', displayMin: 2000, displayMax: 20000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 65534 }, // PHASER_LPF
    34: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PHASER_LFOMODE
  },
  /** sectionTag 23, wire stride 114 (fn=0x1F channel-block stride, ordinary records only). */
  PITCH: {
    0: { kind: 'enum', displayMin: 0, displayMax: 15, scale: 1, step: 0, typecode: 0x10, enumCount: 16, defaultRaw: 0 }, // PITCH_TYPE
    1: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 0, typecode: 0x10, enumCount: 6, defaultRaw: 0 }, // PITCH_PITCHMODE
    2: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 65534 }, // PITCH_CTRL
    3: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // PITCH_UCTRL
    4: { kind: 'enum', displayMin: 0, displayMax: 48, scale: 1, step: 1, typecode: 0x10, enumCount: 49, defaultRaw: 24 }, // PITCH_HARM1
    5: { kind: 'enum', displayMin: 0, displayMax: 48, scale: 1, step: 1, typecode: 0x10, enumCount: 49, defaultRaw: 24 }, // PITCH_HARM2
    6: { kind: 'enum', displayMin: 0, displayMax: 48, scale: 1, step: 1, typecode: 0x10, enumCount: 49, defaultRaw: 24 }, // PITCH_HARM3
    7: { kind: 'enum', displayMin: 0, displayMax: 48, scale: 1, step: 1, typecode: 0x10, enumCount: 49, defaultRaw: 24 }, // PITCH_HARM4
    8: { kind: 'enum', displayMin: 0, displayMax: 11, scale: 1, step: 1, typecode: 0x10, enumCount: 12, defaultRaw: 0 }, // PITCH_KEY
    9: { kind: 'enum', displayMin: 0, displayMax: 17, scale: 1, step: 0, typecode: 0x10, enumCount: 18, defaultRaw: 0 }, // PITCH_SCALE
    10: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PITCH_QUANTIZE
    11: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731, defaultRaw: 32767 }, // PITCH_DETUNE1
    12: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731, defaultRaw: 32767 }, // PITCH_DETUNE2
    13: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731, defaultRaw: 32767 }, // PITCH_DETUNE3
    14: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731, defaultRaw: 32767 }, // PITCH_DETUNE4
    15: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_SHIFT1
    16: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_SHIFT2
    17: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_SHIFT3
    18: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_SHIFT4
    19: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // PITCH_LEVEL1
    20: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // PITCH_LEVEL2
    21: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // PITCH_LEVEL3
    22: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // PITCH_LEVEL4
    23: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // PITCH_PAN1
    24: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // PITCH_PAN2
    25: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // PITCH_PAN3
    26: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // PITCH_PAN4
    27: { kind: 'float', displayMin: 0, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 0 }, // PITCH_DELAY1
    28: { kind: 'float', displayMin: 0, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 0 }, // PITCH_DELAY2
    29: { kind: 'float', displayMin: 0, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 0 }, // PITCH_DELAY3
    30: { kind: 'float', displayMin: 0, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 0 }, // PITCH_DELAY4
    31: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // PITCH_FEEDBACK1
    32: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // PITCH_FEEDBACK2
    33: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // PITCH_FEEDBACK3
    34: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // PITCH_FEEDBACK4
    35: { kind: 'enum', displayMin: 1, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // PITCH_TRACKMODE
    36: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 32767 }, // PITCH_TRACKING
    37: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // PITCH_FORMCORRECT
    38: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571, defaultRaw: 16384 }, // PITCH_MIX
    39: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // PITCH_LEVEL
    40: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // PITCH_PAN
    41: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0xc0, enumCount: 5, defaultRaw: 0 }, // PITCH_BYPASSMODE
    42: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0, defaultRaw: 0 }, // PITCH_GLOBALMIX
    43: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // PITCH_GAIN
    44: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // PITCH_BYPASS
    45: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // PITCH_XFADE
    46: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PITCH_XFADETYPE
    47: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 16359 }, // PITCH_SPLICE1
    48: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 16359 }, // PITCH_SPLICE2
    49: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // PITCH_DTEMPO1
    50: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // PITCH_DTEMPO2
    51: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // PITCH_DTEMPO3
    52: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // PITCH_DTEMPO4
    53: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // PITCH_STEMPO1
    54: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // PITCH_STEMPO2
    55: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // PITCH_FBTYPE
    56: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // PITCH_DIRECTION
    57: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 32436 }, // PITCH_LPFREQ
    58: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x442, defaultRaw: 0 }, // PITCH_GLIDE
    59: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // PITCH_MDELAY
    60: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // PITCH_MFDBK
    61: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 65534 }, // PITCH_MPAN
    62: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // PITCH_MLEVEL
    63: { kind: 'float', displayMin: 4, displayMax: 8, scale: 1, step: 1, typecode: 0x10, defaultRaw: 49150 }, // PITCH_CUSTOMNOTES
    64: { kind: 'float', displayMin: 1, displayMax: 6, scale: 1, step: 0, typecode: 0xf0, defaultRaw: 0 }, // PITCH_NOTE2
    65: { kind: 'float', displayMin: 2, displayMax: 7, scale: 1, step: 0, typecode: 0xf0, defaultRaw: 0 }, // PITCH_NOTE3
    66: { kind: 'float', displayMin: 3, displayMax: 8, scale: 1, step: 0, typecode: 0xf0, defaultRaw: 0 }, // PITCH_NOTE4
    67: { kind: 'float', displayMin: 4, displayMax: 9, scale: 1, step: 0, typecode: 0xf0, defaultRaw: 0 }, // PITCH_NOTE5
    68: { kind: 'float', displayMin: 5, displayMax: 10, scale: 1, step: 0, typecode: 0xf0, defaultRaw: 0 }, // PITCH_NOTE6
    69: { kind: 'float', displayMin: 6, displayMax: 11, scale: 1, step: 0, typecode: 0xf0, defaultRaw: 0 }, // PITCH_NOTE7
    70: { kind: 'float', displayMin: 7, displayMax: 12, scale: 1, step: 0, typecode: 0xf0, defaultRaw: 0 }, // PITCH_NOTE8
    71: { kind: 'float', displayMin: 0, displayMax: 31, scale: 1, step: 1, typecode: 0x10, defaultRaw: 0 }, // PITCH_CUSTOMSCALE1
    72: { kind: 'float', displayMin: 0, displayMax: 31, scale: 1, step: 1, typecode: 0x10, defaultRaw: 0 }, // PITCH_CUSTOMSCALE2
    73: { kind: 'float', displayMin: 2, displayMax: 16, scale: 1, step: 1, typecode: 0x10, defaultRaw: 9362 }, // PITCH_NUMSTEPS
    74: { kind: 'float', displayMin: 1, displayMax: 31, scale: 1, step: 1, typecode: 0x10, defaultRaw: 65534 }, // PITCH_NUMREPEATS
    75: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // PITCH_ARPRUN
    76: { kind: 'enum', displayMin: 1, displayMax: 78, scale: 1, step: 1, typecode: 0x10, enumCount: 78, defaultRaw: 6 }, // PITCH_TEMPO
    77: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP1
    78: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 35498 }, // PITCH_STEP2
    79: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 38228 }, // PITCH_STEP3
    80: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 42324 }, // PITCH_STEP4
    81: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP5
    82: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP6
    83: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP7
    84: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP8
    85: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP9
    86: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP10
    87: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP11
    88: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP12
    89: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP13
    90: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP14
    91: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP15
    92: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // PITCH_STEP16
    93: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 1, typecode: 0x10, enumCount: 6, defaultRaw: 0 }, // PITCH_AMPSHAPE
    94: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 6553 }, // PITCH_AMPALPHA
    95: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 1, typecode: 0x10, enumCount: 6, defaultRaw: 0 }, // PITCH_PANSHAPE
    96: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // PITCH_PANALPHA
    97: { kind: 'float', displayMin: 0, displayMax: 250, scale: 1000, step: 0.0001, typecode: 0x431, defaultRaw: 0 }, // PITCH_TIME1
    98: { kind: 'float', displayMin: 0, displayMax: 250, scale: 1000, step: 0.0001, typecode: 0x431, defaultRaw: 0 }, // PITCH_TIME2
    99: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // PITCH_SOURCE
    100: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PITCH_INMODE
    101: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 1, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PITCH_LEARN
    102: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 0 }, // PITCH_HPFREQ
    103: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PITCH_FDBKMODE
    104: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243, defaultRaw: 0 }, // PITCH_LFORATE
    105: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // PITCH_LFOTEMPO
    106: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // PITCH_LFODEPTH
    107: { kind: 'float', displayMin: 0, displayMax: 0, scale: 1, step: 0, typecode: 0xf0, defaultRaw: 0 }, // PITCH_TONIC
    108: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PITCH_TEMPERAMENT
    109: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // PITCH_DIFFMIX
    110: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // PITCH_DIFFTIME
    111: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PITCH_SCENEIGNORE
    112: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // PITCH_KILLDRY
    113: { kind: 'float', displayMin: -100, displayMax: 0, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 0 }, // PITCH_THRESH
  },
  /** sectionTag 15, wire stride 96 (fn=0x1F channel-block stride, ordinary records only). */
  PLEX: {
    0: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 0, step: 0, typecode: 0x10, enumCount: 5 }, // PLEX_BASETYPE
    1: { kind: 'float', displayMin: 4, displayMax: 8, scale: 2, step: 0, typecode: 0x10 }, // PLEX_NUMDLINES
    2: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 0, typecode: 0x10 }, // PLEX_SHIFT1
    3: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 0, typecode: 0x10 }, // PLEX_SHIFT2
    4: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 0, typecode: 0x10 }, // PLEX_SHIFT3
    5: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 0, typecode: 0x10 }, // PLEX_SHIFT4
    6: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 0, typecode: 0x10 }, // PLEX_SHIFT5
    7: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 0, typecode: 0x10 }, // PLEX_SHIFT6
    8: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 0, typecode: 0x10 }, // PLEX_SHIFT7
    9: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 0, typecode: 0x10 }, // PLEX_SHIFT8
    10: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731 }, // PLEX_DETUNE1
    11: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731 }, // PLEX_DETUNE2
    12: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731 }, // PLEX_DETUNE3
    13: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731 }, // PLEX_DETUNE4
    14: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731 }, // PLEX_DETUNE5
    15: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731 }, // PLEX_DETUNE6
    16: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731 }, // PLEX_DETUNE7
    17: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x731 }, // PLEX_DETUNE8
    18: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431 }, // PLEX_TIME1
    19: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431 }, // PLEX_TIME2
    20: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431 }, // PLEX_TIME3
    21: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431 }, // PLEX_TIME4
    22: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431 }, // PLEX_TIME5
    23: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431 }, // PLEX_TIME6
    24: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431 }, // PLEX_TIME7
    25: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431 }, // PLEX_TIME8
    26: { kind: 'enum', displayMin: 0, displayMax: 77, scale: 1, step: 0, typecode: 0x10, enumCount: 78 }, // PLEX_TEMPO1
    27: { kind: 'enum', displayMin: 0, displayMax: 77, scale: 1, step: 0, typecode: 0x10, enumCount: 78 }, // PLEX_TEMPO2
    28: { kind: 'enum', displayMin: 0, displayMax: 77, scale: 1, step: 0, typecode: 0x10, enumCount: 78 }, // PLEX_TEMPO3
    29: { kind: 'enum', displayMin: 0, displayMax: 77, scale: 1, step: 0, typecode: 0x10, enumCount: 78 }, // PLEX_TEMPO4
    30: { kind: 'enum', displayMin: 0, displayMax: 77, scale: 1, step: 0, typecode: 0x10, enumCount: 78 }, // PLEX_TEMPO5
    31: { kind: 'enum', displayMin: 0, displayMax: 77, scale: 1, step: 0, typecode: 0x10, enumCount: 78 }, // PLEX_TEMPO6
    32: { kind: 'enum', displayMin: 0, displayMax: 77, scale: 1, step: 0, typecode: 0x10, enumCount: 78 }, // PLEX_TEMPO7
    33: { kind: 'enum', displayMin: 0, displayMax: 77, scale: 1, step: 0, typecode: 0x10, enumCount: 78 }, // PLEX_TEMPO8
    34: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_LEVEL1
    35: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_LEVEL2
    36: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_LEVEL3
    37: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_LEVEL4
    38: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_LEVEL5
    39: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_LEVEL6
    40: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_LEVEL7
    41: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_LEVEL8
    42: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // PLEX_PAN1
    43: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // PLEX_PAN2
    44: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // PLEX_PAN3
    45: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // PLEX_PAN4
    46: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // PLEX_PAN5
    47: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // PLEX_PAN6
    48: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // PLEX_PAN7
    49: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // PLEX_PAN8
    50: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_INGAIN
    51: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_MSTRTIME
    52: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_MSTRLVL
    53: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_MSTRPAN
    54: { kind: 'float', displayMin: -200, displayMax: 200, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_MSTRPITCH
    55: { kind: 'float', displayMin: -200, displayMax: 200, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_MSTRDTN
    56: { kind: 'float', displayMin: 0.01, displayMax: 60, scale: 1, step: 0.05, typecode: 0x332 }, // PLEX_DECAY
    57: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_DIFFUSION
    58: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // PLEX_DIRECTION
    59: { kind: 'float', displayMin: 5, displayMax: 50, scale: 1000, step: 0.00005, typecode: 0x433 }, // PLEX_SPLICE
    60: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x241 }, // PLEX_LOWCUT
    61: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x241 }, // PLEX_HIGHCUT
    62: { kind: 'float', displayMin: 0, displayMax: 80, scale: 1, step: 0.1, typecode: 0x131 }, // PLEX_ATTEN
    63: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x131 }, // PLEX_THRESH
    64: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0.001, typecode: 0x431 }, // PLEX_RELEASE
    65: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_DIFFMIX
    66: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_DIFFTIME
    67: { kind: 'float', displayMin: 0.05, displayMax: 10, scale: 1, step: 0, typecode: 0x243 }, // PLEX_LFORATE
    68: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_LFODEPTH
    69: { kind: 'enum', displayMin: 0, displayMax: 77, scale: 1, step: 0, typecode: 0x10, enumCount: 78 }, // PLEX_LFOTEMPO
    70: { kind: 'float', displayMin: -100, displayMax: 0, scale: 1, step: 0.1, typecode: 0x131 }, // PLEX_ENVTHRESH
    71: { kind: 'float', displayMin: 10, displayMax: 10000, scale: 1000, step: 0, typecode: 0x443 }, // PLEX_ENVATTACK
    72: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x443 }, // PLEX_ENVRELEASE
    73: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x570 }, // PLEX_MIX
    74: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181 }, // PLEX_LEVEL
    75: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91 }, // PLEX_PAN
    76: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0xc0, enumCount: 5 }, // PLEX_BYPASSMODE
    77: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0 }, // PLEX_GLOBALMIX
    78: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0 }, // PLEX_BYPASS
    79: { kind: 'float', displayMin: 1, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // PLEX_SIZE
    80: { kind: 'float', displayMin: -200, displayMax: 200, scale: 100, step: 0.002, typecode: 0x531 }, // PLEX_SPREAD
    81: { kind: 'float', displayMin: 0, displayMax: 250, scale: 1000, step: 0.00025, typecode: 0x431 }, // PLEX_PREDELAY
    82: { kind: 'enum', displayMin: 0, displayMax: 11, scale: 1, step: 0, typecode: 0x10, enumCount: 12 }, // PLEX_FILTERTYPE
    83: { kind: 'float', displayMin: 20, displayMax: 20000, scale: 1, step: 0, typecode: 0x241 }, // PLEX_FILTERFREQ
    84: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // PLEX_FILTERQ
    85: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.05, typecode: 0x132 }, // PLEX_FILTERGAIN
    86: { kind: 'float', displayMin: 0, displayMax: 10, scale: 1, step: 0, typecode: 0x10 }, // PLEX_SHIMMERINTENS
    87: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3 }, // PLEX_INPUTSELECT
    88: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3 }, // PLEX_HOLD
    89: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 },
    90: { kind: 'enum', displayMin: 0, displayMax: 44, scale: 0, step: 0, typecode: 0x10, enumCount: 45 }, // PLEX_PRESETS
    91: { kind: 'enum', displayMin: 0, displayMax: 10, scale: 1, step: 0, typecode: 0x10, enumCount: 11 }, // PLEX_FLTLFOTYPE
    92: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x243 }, // PLEX_FLTLFOFREQ
    93: { kind: 'float', displayMin: 20, displayMax: 20000, scale: 1, step: 0, typecode: 0x241 }, // PLEX_FLTLFOMODFREQ
    94: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // PLEX_SCENEIGNORE
    95: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // PLEX_KILLDRY
  },
  /** sectionTag 57, wire stride 50 (fn=0x1F channel-block stride, ordinary records only). */
  PRESET: {
    0: { kind: 'enum', displayMin: 0, displayMax: 13, scale: 1, step: 0, typecode: 0x10, enumCount: 14 },
    216: { kind: 'enum', displayMin: 0, displayMax: 13, scale: 1, step: 0, typecode: 0x10, enumCount: 14 },
    1285: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE1_CS1_MODE
    1286: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE2_CS1_MODE
    1287: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE3_CS1_MODE
    1288: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE4_CS1_MODE
    1289: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE5_CS1_MODE
    1290: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE6_CS1_MODE
    1291: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE7_CS1_MODE
    1292: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE8_CS1_MODE
    1293: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE1_CS2_MODE
    1294: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE2_CS2_MODE
    1295: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE3_CS2_MODE
    1296: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE4_CS2_MODE
    1297: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE5_CS2_MODE
    1298: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE6_CS2_MODE
    1299: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE7_CS2_MODE
    1300: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE8_CS2_MODE
    1301: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE1_CS3_MODE
    1302: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE2_CS3_MODE
    1303: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE3_CS3_MODE
    1304: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE4_CS3_MODE
    1305: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE5_CS3_MODE
    1306: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE6_CS3_MODE
    1307: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE7_CS3_MODE
    1308: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE8_CS3_MODE
    1309: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE1_CS4_MODE
    1310: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE2_CS4_MODE
    1311: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE3_CS4_MODE
    1312: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE4_CS4_MODE
    1313: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE5_CS4_MODE
    1314: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE6_CS4_MODE
    1315: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE7_CS4_MODE
    1316: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE8_CS4_MODE
    1317: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE1_CS5_MODE
    1318: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE2_CS5_MODE
    1319: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE3_CS5_MODE
    1320: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE4_CS5_MODE
    1321: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE5_CS5_MODE
    1322: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE6_CS5_MODE
    1323: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE7_CS5_MODE
    1324: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE8_CS5_MODE
    1325: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE1_CS6_MODE
    1326: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE2_CS6_MODE
    1327: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE3_CS6_MODE
    1328: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE4_CS6_MODE
    1329: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE5_CS6_MODE
    1330: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE6_CS6_MODE
    1331: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE7_CS6_MODE
    1332: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3 }, // PRESET_FC_SCENE8_CS6_MODE
  },
  /** sectionTag 39, wire stride 40 (fn=0x1F channel-block stride, ordinary records only). */
  RESONATOR: {
    0: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // RESONATOR_MODE
    1: { kind: 'enum', displayMin: 0, displayMax: 8, scale: 1, step: 0, typecode: 0x10, enumCount: 9 }, // RESONATOR_CHORD
    2: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // RESONATOR_INGAIN
    3: { kind: 'float', displayMin: 50, displayMax: 5000, scale: 1, step: 0, typecode: 0x42 }, // RESONATOR_FREQ
    4: { kind: 'float', displayMin: 0.5, displayMax: 2, scale: 1, step: 0, typecode: 0x43 }, // RESONATOR_MASTERFREQ
    5: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // RESONATOR_MASTERLVL
    6: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // RESONATOR_MASTERPAN
    7: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // RESONATOR_MASTERFDBK
    8: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x42 }, // RESONATOR_MASTERQ
    9: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x42 }, // RESONATOR_FREQ1
    10: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x42 }, // RESONATOR_FREQ2
    11: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x42 }, // RESONATOR_FREQ3
    12: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x42 }, // RESONATOR_FREQ4
    13: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // RESONATOR_FDBK1
    14: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // RESONATOR_FDBK2
    15: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // RESONATOR_FDBK3
    16: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531 }, // RESONATOR_FDBK4
    17: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // RESONATOR_LOC1
    18: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // RESONATOR_LOC2
    19: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // RESONATOR_LOC3
    20: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // RESONATOR_LOC4
    21: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x42 }, // RESONATOR_Q1
    22: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x42 }, // RESONATOR_Q2
    23: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x42 }, // RESONATOR_Q3
    24: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x42 }, // RESONATOR_Q4
    25: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // RESONATOR_LEVEL1
    26: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // RESONATOR_LEVEL2
    27: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // RESONATOR_LEVEL3
    28: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // RESONATOR_LEVEL4
    29: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31 }, // RESONATOR_PAN1
    30: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31 }, // RESONATOR_PAN2
    31: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31 }, // RESONATOR_PAN3
    32: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31 }, // RESONATOR_PAN4
    33: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571 }, // RESONATOR_MIX
    34: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181 }, // RESONATOR_LEVEL
    35: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91 }, // RESONATOR_PAN
    36: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0xa0, enumCount: 3 }, // RESONATOR_BYPASSMODE
    37: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0 }, // RESONATOR_GLOBALMIX
    38: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0 }, // RESONATOR_BYPASS
    39: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // RESONATOR_INPUTMODE
  },
  /** sectionTag 12, wire stride 71 (fn=0x1F channel-block stride, ordinary records only). */
  REVERB: {
    0: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 5 }, // REVERB_TYPE
    1: { kind: 'float', displayMin: 0.1, displayMax: 100, scale: 1, step: 0.02, typecode: 0x332, defaultRaw: 1771 }, // REVERB_TIME
    2: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 15887 }, // REVERB_HICUT
    3: { kind: 'float', displayMin: 0.01, displayMax: 1, scale: 1, step: 0.001, typecode: 0x44, defaultRaw: 12577 }, // REVERB_HFRATIO
    4: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // REVERB_DIFFUSION
    5: { kind: 'float', displayMin: 1, displayMax: 100, scale: 100, step: 0.001, typecode: 0x31, defaultRaw: 22507 }, // REVERB_SIZE
    6: { kind: 'float', displayMin: 0, displayMax: 250, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 0 }, // REVERB_REVERBDELAY
    7: { kind: 'float', displayMin: -40, displayMax: 10, scale: 1, step: 0.05, typecode: 0x162, defaultRaw: 52427 }, // REVERB_EARLYLEVEL
    8: { kind: 'float', displayMin: -40, displayMax: 10, scale: 1, step: 0.05, typecode: 0x162, defaultRaw: 52427 }, // REVERB_REVERBLEVEL
    9: { kind: 'float', displayMin: 0, displayMax: 1000, scale: 1000, step: 0.00025, typecode: 0x431, defaultRaw: 2621 }, // REVERB_PREDELAY
    10: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x241, defaultRaw: 0 }, // REVERB_LOWCUT
    11: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 13107 }, // REVERB_DEPTH
    12: { kind: 'float', displayMin: 0.01, displayMax: 1, scale: 1, step: 0, typecode: 0x243, defaultRaw: 32436 }, // REVERB_RATE
    13: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571, defaultRaw: 16384 }, // REVERB_MIX
    14: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // REVERB_LEVEL
    15: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // REVERB_PAN
    16: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0xc0, enumCount: 5, defaultRaw: 0 }, // REVERB_BYPASSMODE
    17: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0, defaultRaw: 0 }, // REVERB_GLOBALMIX
    18: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 65534 }, // REVERB_GAIN
    19: { kind: 'float', displayMin: 4, displayMax: 8, scale: 1, step: 0, typecode: 0x10, defaultRaw: 0 }, // REVERB_DENSITY
    20: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // REVERB_INPDIFF
    21: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // REVERB_INDIFFTIME
    22: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // REVERB_BYPASS
    23: { kind: 'float', displayMin: 2, displayMax: 6, scale: 1, step: 0, typecode: 0x10, defaultRaw: 0 }, // REVERB_NUMSPRINGS
    24: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // REVERB_TONE
    25: { kind: 'float', displayMin: 0, displayMax: 200, scale: 200, step: 0.001, typecode: 0xa31, defaultRaw: 6553 }, // REVERB_WIDTH
    26: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 5958 }, // REVERB_FREQ1
    27: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 4634 }, // REVERB_FREQ2
    28: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // REVERB_Q1
    29: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // REVERB_Q2
    30: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // REVERB_GAIN1
    31: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.05, typecode: 0x132, defaultRaw: 32767 }, // REVERB_GAIN2
    32: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 10, step: 0.001, typecode: 0x52, defaultRaw: 1523 }, // REVERB_DRIVE
    33: { kind: 'float', displayMin: 0.02, displayMax: 2, scale: 1, step: 0, typecode: 0x44, defaultRaw: 32436 }, // REVERB_LFTIME
    34: { kind: 'float', displayMin: 100, displayMax: 10000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 993 }, // REVERB_LFXOVER
    35: { kind: 'float', displayMin: -200, displayMax: 200, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 49150 }, // REVERB_SPREAD
    36: { kind: 'float', displayMin: 0, displayMax: 80, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 0 }, // REVERB_ATTEN
    37: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 52427 }, // REVERB_THRESH
    38: { kind: 'float', displayMin: 1, displayMax: 1000, scale: 1000, step: 0, typecode: 0x441, defaultRaw: 0 }, // REVERB_RELEASE
    39: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // REVERB_EARLYDIFF
    40: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // REVERB_EARLYDIFFTIME
    41: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 65534 }, // REVERB_EARLYDECAY
    42: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // REVERB_EARLYSEND
    43: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // REVERB_QUALITY
    44: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // REVERB_HOLD
    45: { kind: 'float', displayMin: 0, displayMax: 8, scale: 1, step: 1, typecode: 0x10, defaultRaw: 0 }, // REVERB_BASETYPE
    46: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 32767 }, // REVERB_LFOPHASE
    47: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // REVERB_INPUTSELECT
    48: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // REVERB_DISPERSION
    49: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // REVERB_LOWSLOPE
    50: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // REVERB_HIGHSLOPE
    51: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // REVERB_SCENEIGNORE
    52: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // REVERB_KILLDRY
    53: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // REVERB_PITCHMIX
    54: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // REVERB_SHIFT1
    55: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10, defaultRaw: 32767 }, // REVERB_SHIFT2
    56: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // REVERB_PITCHFDBK
    57: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 1, typecode: 0x10, enumCount: 4, defaultRaw: 0 }, // REVERB_PITCHDIR
    58: { kind: 'float', displayMin: 10, displayMax: 2000, scale: 1000, step: 0.001, typecode: 0x431, defaultRaw: 32602 }, // REVERB_PITCHTIME
    59: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 1, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // REVERB_PITCHPOS
    60: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // REVERB_PITCHMOD
    61: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 32767 }, // REVERB_PITCHBAL
    62: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // REVERB_PREDLYTEMPO
    63: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // REVERB_PREDLYFDBK
    64: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 0 }, // REVERB_PREDLYMIX
    65: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 5958 }, // REVERB_PITCHLPF
    66: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // REVERB_SPRINGTYPE
    67: { kind: 'float', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, defaultRaw: 21845 }, // REVERB_TONETYPE
    68: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // REVERB_PREDLYTAP
    69: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // REVERB_LOWQ
    70: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 4018 }, // REVERB_HIGHQ
  },
  /** sectionTag 36, wire stride 13 (fn=0x1F channel-block stride, ordinary records only). */
  RINGMOD: {
    0: { kind: 'float', displayMin: 2, displayMax: 2000, scale: 1, step: 0, typecode: 0x242 }, // RINGMOD_COARSE
    1: { kind: 'float', displayMin: 0.25, displayMax: 4, scale: 1, step: 0, typecode: 0x43 }, // RINGMOD_FINE
    2: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 0, step: 0, typecode: 0x10, enumCount: 2 }, // RINGMOD_TRACK
    3: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x240 }, // RINGMOD_HICUT
    4: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571 }, // RINGMOD_MIX
    5: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181 }, // RINGMOD_LEVEL
    6: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91 }, // RINGMOD_PAN
    7: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0xa0, enumCount: 3 }, // RINGMOD_BYPASSMODE
    8: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0 }, // RINGMOD_GLOBALMIX
    9: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0 }, // RINGMOD_BYPASS
    10: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 0, step: 0, typecode: 0x10, enumCount: 3 }, // RINGMOD_TYPE
    11: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // RINGMOD_SCENEIGNORE
    12: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // RINGMOD_PD_RANGE
  },
  /** sectionTag 18, wire stride 21 (fn=0x1F channel-block stride, ordinary records only). */
  ROTARY: {
    0: { kind: 'float', displayMin: 0, displayMax: 10, scale: 1, step: 0.01, typecode: 0x233, defaultRaw: 42597 }, // ROTARY_RATE
    1: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 16384 }, // ROTARY_LFDEPTH
    2: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 16384 }, // ROTARY_HFDEPTH
    3: { kind: 'float', displayMin: -6, displayMax: 6, scale: 1, step: 0.012, typecode: 0x132, defaultRaw: 32767 }, // ROTARY_HFLEVEL
    4: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // ROTARY_TEMPO
    5: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571, defaultRaw: 32767 }, // ROTARY_MIX
    6: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // ROTARY_LEVEL
    7: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // ROTARY_PAN
    8: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0xa0, enumCount: 3, defaultRaw: 0 }, // ROTARY_BYPASSMODE
    9: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0, defaultRaw: 0 }, // ROTARY_GLOBALMIX
    10: { kind: 'float', displayMin: 0.1, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 22894 }, // ROTARY_HFLENGTH
    11: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // ROTARY_BYPASS
    12: { kind: 'float', displayMin: 0, displayMax: 100, scale: 31.830988, step: 0.0031415927, typecode: 0x531, defaultRaw: 32767 }, // ROTARY_WIDTH
    13: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x43, defaultRaw: 5296 }, // ROTARY_LOWRATE
    14: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x343, defaultRaw: 12577 }, // ROTARY_LOWTIME
    15: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 1, step: 0, typecode: 0x343, defaultRaw: 4634 }, // ROTARY_HIGHTIME
    16: { kind: 'float', displayMin: -200, displayMax: 200, scale: 100, step: 0.002, typecode: 0x531, defaultRaw: 40959 }, // ROTARY_SPREAD
    17: { kind: 'float', displayMin: 0.5, displayMax: 500, scale: 10, step: 0.001, typecode: 0x52, defaultRaw: 0 }, // ROTARY_DRIVE
    18: { kind: 'float', displayMin: 0.01, displayMax: 1, scale: 1, step: 0.001, typecode: 0x42, defaultRaw: 5958 }, // ROTARY_MICDIST
    19: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // ROTARY_INPUTSELECT
    20: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // ROTARY_SCENEIGNORE
  },
  /** sectionTag 31, wire stride 42 (fn=0x1F channel-block stride, ordinary records only). */
  SYNTH: {
    0: { kind: 'enum', displayMin: 0, displayMax: 7, scale: 1, step: 0, typecode: 0x10, enumCount: 8 }, // SYNTH_TYPE1
    1: { kind: 'float', displayMin: 40, displayMax: 4000, scale: 1, step: 1, typecode: 0x242 }, // SYNTH_FREQ1
    2: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4 }, // SYNTH_TRACK1
    3: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10 }, // SYNTH_SHIFT1
    4: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x732 }, // SYNTH_DETUNE1
    5: { kind: 'float', displayMin: 1, displayMax: 99, scale: 100, step: 0.001, typecode: 0x531 }, // SYNTH_DUTY1
    6: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // SYNTH_LEVEL1
    7: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31 }, // SYNTH_PAN1
    8: { kind: 'float', displayMin: 5, displayMax: 1000, scale: 1000, step: 0, typecode: 0x442 }, // SYNTH_ATTACK1
    9: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x240 }, // SYNTH_HICUT1
    10: { kind: 'float', displayMin: 0.5, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // SYNTH_Q1
    11: { kind: 'enum', displayMin: 0, displayMax: 7, scale: 1, step: 0, typecode: 0x10, enumCount: 8 }, // SYNTH_TYPE2
    12: { kind: 'float', displayMin: 40, displayMax: 4000, scale: 1, step: 1, typecode: 0x242 }, // SYNTH_FREQ2
    13: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4 }, // SYNTH_TRACK2
    14: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10 }, // SYNTH_SHIFT2
    15: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x732 }, // SYNTH_DETUNE2
    16: { kind: 'float', displayMin: 1, displayMax: 99, scale: 100, step: 0.001, typecode: 0x531 }, // SYNTH_DUTY2
    17: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // SYNTH_LEVEL2
    18: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31 }, // SYNTH_PAN2
    19: { kind: 'float', displayMin: 5, displayMax: 1000, scale: 1000, step: 0, typecode: 0x442 }, // SYNTH_ATTACK2
    20: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // SYNTH_HICUT2
    21: { kind: 'float', displayMin: 0.5, displayMax: 10, scale: 1, step: 0, typecode: 0x43 }, // SYNTH_Q2
    22: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // SYNTH_SPARE1
    23: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571 }, // SYNTH_MIX
    24: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181 }, // SYNTH_LEVEL
    25: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91 }, // SYNTH_PAN
    26: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0xa0, enumCount: 3 }, // SYNTH_BYPASSMODE
    27: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0 }, // SYNTH_GLOBALMIX
    28: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0 }, // SYNTH_BYPASS
    29: { kind: 'enum', displayMin: 0, displayMax: 7, scale: 1, step: 0, typecode: 0x10, enumCount: 8 }, // SYNTH_TYPE3
    30: { kind: 'float', displayMin: 20, displayMax: 20000, scale: 1, step: 1, typecode: 0x242 }, // SYNTH_FREQ3
    31: { kind: 'enum', displayMin: 0, displayMax: 3, scale: 1, step: 0, typecode: 0x10, enumCount: 4 }, // SYNTH_TRACK3
    32: { kind: 'float', displayMin: -24, displayMax: 24, scale: 1, step: 1, typecode: 0x10 }, // SYNTH_SHIFT3
    33: { kind: 'float', displayMin: -50, displayMax: 50, scale: 1, step: 0.1, typecode: 0x732 }, // SYNTH_DETUNE3
    34: { kind: 'float', displayMin: 1, displayMax: 99, scale: 100, step: 0.001, typecode: 0x531 }, // SYNTH_DUTY3
    35: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // SYNTH_LEVEL3
    36: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31 }, // SYNTH_PAN3
    37: { kind: 'float', displayMin: 5, displayMax: 1000, scale: 1000, step: 0, typecode: 0x442 }, // SYNTH_ATTACK3
    38: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x242 }, // SYNTH_HICUT3
    39: { kind: 'float', displayMin: 0.5, displayMax: 10, scale: 1, step: 0, typecode: 0x42 }, // SYNTH_Q3
    40: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // SYNTH_SCENEIGNORE
    41: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // SYNTH_PD_RANGE
  },
  /** sectionTag 38, wire stride 48 (fn=0x1F channel-block stride, ordinary records only). */
  TENTAP: {
    0: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // TENTAP_TYPE
    1: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // TENTAP_STEREO
    2: { kind: 'float', displayMin: 1, displayMax: 2000, scale: 1000, step: 0, typecode: 0x0 }, // TENTAP_TIMEM
    3: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79 }, // TENTAP_SUBDIV
    4: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79 }, // TENTAP_QUANTIZE
    5: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // TENTAP_RDECAY
    6: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10 }, // TENTAP_DECAYSTYLE
    7: { kind: 'float', displayMin: 1, displayMax: 10, scale: 1, step: 0, typecode: 0x10 }, // TENTAP_NUMTAPS
    8: { kind: 'float', displayMin: 0, displayMax: 50, scale: 100, step: 0.001, typecode: 0x531 }, // TENTAP_SHUFFLE
    9: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79 }, // TENTAP_RTEMPO
    10: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // TENTAP_SPREAD
    11: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 1, step: 0, typecode: 0x10, enumCount: 6 }, // TENTAP_PANSHAPE
    12: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // TENTAP_PANALPHA
    13: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x241 }, // TENTAP_LOWCUT
    14: { kind: 'float', displayMin: 200, displayMax: 20000, scale: 1, step: 0, typecode: 0x240 }, // TENTAP_HIGHCUT
    15: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // TENTAP_OFFSET
    16: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // TENTAP_FEEDBACK
    17: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0xf0 }, // TENTAP_TIME1M
    18: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0xf0 }, // TENTAP_TIME2M
    19: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0xf0 }, // TENTAP_TIME3M
    20: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0xf0 }, // TENTAP_TIME4M
    21: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0xf0 }, // TENTAP_TIME5M
    22: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0xf0 }, // TENTAP_TIME6M
    23: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0xf0 }, // TENTAP_TIME7M
    24: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0xf0 }, // TENTAP_TIME8M
    25: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0xf0 }, // TENTAP_TIME9M
    26: { kind: 'float', displayMin: 0, displayMax: 10000, scale: 1000, step: 0.001, typecode: 0xf0 }, // TENTAP_TIME10M
    27: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // TENTAP_RLEVEL1
    28: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // TENTAP_RLEVEL2
    29: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // TENTAP_RLEVEL3
    30: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // TENTAP_RLEVEL4
    31: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // TENTAP_RLEVEL5
    32: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // TENTAP_RLEVEL6
    33: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // TENTAP_RLEVEL7
    34: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // TENTAP_RLEVEL8
    35: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // TENTAP_RLEVEL9
    36: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.05, typecode: 0x132 }, // TENTAP_RLEVEL10
    37: { kind: 'float', displayMin: 30, displayMax: 250, scale: 0, step: 0, typecode: 0xf0 }, // TENTAP_REFTEMPO
    38: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // TENTAP_TRACKTEMPO
    39: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531 }, // TENTAP_INGAIN
    40: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x571 }, // TENTAP_MIX
    41: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181 }, // TENTAP_LEVEL
    42: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91 }, // TENTAP_PAN
    43: { kind: 'enum', displayMin: 0, displayMax: 4, scale: 1, step: 0, typecode: 0xc0, enumCount: 5 }, // TENTAP_BYPASSMODE
    44: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0xd0 }, // TENTAP_GLOBALMIX
    45: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0 }, // TENTAP_BYPASS
    46: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // TENTAP_LEARN
    47: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2 }, // TENTAP_SCENEIGNORE
  },
  /** sectionTag 22, wire stride 22 (fn=0x1F channel-block stride, ordinary records only). */
  TREMOLO: {
    0: { kind: 'enum', displayMin: 0, displayMax: 6, scale: 1, step: 0, typecode: 0x10, enumCount: 7, defaultRaw: 0 }, // TREMOLO_TYPE
    1: { kind: 'enum', displayMin: 0, displayMax: 9, scale: 1, step: 0, typecode: 0x10, enumCount: 10, defaultRaw: 1 }, // TREMOLO_LFOTYPE
    2: { kind: 'float', displayMin: 0.2, displayMax: 20, scale: 1, step: 0, typecode: 0x243, defaultRaw: 15887 }, // TREMOLO_RATE
    3: { kind: 'float', displayMin: 0, displayMax: 100, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 52427 }, // TREMOLO_DEPTH
    4: { kind: 'float', displayMin: 1, displayMax: 99, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // TREMOLO_DUTY
    5: { kind: 'enum', displayMin: 0, displayMax: 78, scale: 1, step: 0, typecode: 0x10, enumCount: 79, defaultRaw: 0 }, // TREMOLO_TEMPO
    6: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // TREMOLO_MIX
    7: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // TREMOLO_LEVEL
    8: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x90, defaultRaw: 32767 }, // TREMOLO_PAN
    9: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2, defaultRaw: 0 }, // TREMOLO_BYPASSMODE
    10: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // TREMOLO_GLOBALMIX
    11: { kind: 'float', displayMin: 0, displayMax: 180, scale: 57.295776, step: 0.003141593, typecode: 0x631, defaultRaw: 0 }, // TREMOLO_PHASE
    12: { kind: 'float', displayMin: 0, displayMax: 400, scale: 100, step: 0.004, typecode: 0x531, defaultRaw: 16384 }, // TREMOLO_WIDTH
    13: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 32767 }, // TREMOLO_CENTER
    14: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // TREMOLO_BYPASS
    15: { kind: 'float', displayMin: 0, displayMax: 360, scale: 114.59155, step: 0.003141593, typecode: 0x631, defaultRaw: 32767 }, // TREMOLO_STARTPHASE
    16: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // TREMOLO_ORDER
    17: { kind: 'float', displayMin: 200, displayMax: 2000, scale: 1, step: 0, typecode: 0x243, defaultRaw: 18204 }, // TREMOLO_XOVER
    18: { kind: 'float', displayMin: -60, displayMax: 20, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 0 }, // TREMOLO_THRESH
    19: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // TREMOLO_SCENEIGNORE
    20: { kind: 'float', displayMin: 0.1, displayMax: 99.9, scale: 100, step: 0.001, typecode: 0x531, defaultRaw: 32767 }, // TREMOLO_BETA
    21: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // TREMOLO_DUCKING
  },
  /** sectionTag 40, wire stride 15 (fn=0x1F channel-block stride, ordinary records only). */
  VOLUME: {
    0: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 65534 }, // VOLUME_GAIN
    1: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x32, defaultRaw: 32767 }, // VOLUME_BAL
    2: { kind: 'enum', displayMin: 0, displayMax: 6, scale: 1, step: 0, typecode: 0x10, enumCount: 7, defaultRaw: 2 }, // VOLUME_TAPER
    3: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // VOLUME_BYPASS
    4: { kind: 'float', displayMin: -99.9, displayMax: 99.9, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 0 }, // VOLUME_PANL
    5: { kind: 'float', displayMin: -99.9, displayMax: 99.9, scale: 100, step: 0.002, typecode: 0x31, defaultRaw: 65534 }, // VOLUME_PANR
    6: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // VOLUME_LEVEL
    7: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2, defaultRaw: 0 }, // VOLUME_BYPASSMODE
    8: { kind: 'enum', displayMin: 0, displayMax: 2, scale: 1, step: 0, typecode: 0x10, enumCount: 3, defaultRaw: 0 }, // VOLUME_INPUTSELECT
    9: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // VOLUME_TYPE
    10: { kind: 'float', displayMin: -80, displayMax: 0, scale: 1, step: 0.1, typecode: 0x131, defaultRaw: 24575 }, // VOLUME_THRESHOLD
    11: { kind: 'float', displayMin: 10, displayMax: 1000, scale: 1000, step: 0, typecode: 0x443, defaultRaw: 5958 }, // VOLUME_ATTACK
    12: { kind: 'float', displayMin: 1, displayMax: 100, scale: 1000, step: 0, typecode: 0x443, defaultRaw: 5958 }, // VOLUME_RELEASE
    13: { kind: 'float', displayMin: 0, displayMax: 12, scale: 1, step: 0.01, typecode: 0x131, defaultRaw: 32767 }, // VOLUME_HYSTERESIS
    14: { kind: 'float', displayMin: 0, displayMax: 0, scale: 0, step: 0, typecode: 0x0 }, // VOLUME_METER
  },
  /** sectionTag 20, wire stride 25 (fn=0x1F channel-block stride, ordinary records only). */
  WAH: {
    0: { kind: 'enum', displayMin: 0, displayMax: 8, scale: 1, step: 0, typecode: 0x10, enumCount: 9, defaultRaw: 1 }, // WAH_TYPE
    1: { kind: 'float', displayMin: 100, displayMax: 1000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 21845 }, // WAH_FSTART
    2: { kind: 'float', displayMin: 500, displayMax: 5000, scale: 1, step: 0, typecode: 0x240, defaultRaw: 21845 }, // WAH_FSTOP
    3: { kind: 'float', displayMin: 20, displayMax: 200, scale: 10, step: 0, typecode: 0x52, defaultRaw: 20024 }, // WAH_Q
    4: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 49150 }, // WAH_TRACK
    5: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // WAH_CONTROL
    6: { kind: 'float', displayMin: -80, displayMax: 20, scale: 1, step: 0.1, typecode: 0x181, defaultRaw: 52427 }, // WAH_LEVEL
    7: { kind: 'float', displayMin: -100, displayMax: 100, scale: 100, step: 0.002, typecode: 0x91, defaultRaw: 32767 }, // WAH_PAN
    8: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xb0, enumCount: 2, defaultRaw: 0 }, // WAH_BYPASSMODE
    9: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 0 }, // WAH_MIX
    10: { kind: 'float', displayMin: 0.1, displayMax: 10, scale: 10, step: 0, typecode: 0x52, defaultRaw: 0 }, // WAH_DRIVE
    11: { kind: 'enum', displayMin: 0, displayMax: 5, scale: 0, step: 0, typecode: 0x10, enumCount: 6, defaultRaw: 1 }, // WAH_TAPER
    12: { kind: 'float', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0xe0, defaultRaw: 0 }, // WAH_BYPASS
    13: { kind: 'float', displayMin: 0, displayMax: 10, scale: 10, step: 0.001, typecode: 0x32, defaultRaw: 26214 }, // WAH_BIAS
    14: { kind: 'float', displayMin: 20, displayMax: 2000, scale: 1, step: 0, typecode: 0x242, defaultRaw: 2648 }, // WAH_HPF
    15: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 1 }, // WAH_EQON
    16: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // WAH_EQ1
    17: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // WAH_EQ2
    18: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // WAH_EQ3
    19: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // WAH_EQ4
    20: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // WAH_EQ5
    21: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // WAH_EQ6
    22: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // WAH_EQ7
    23: { kind: 'float', displayMin: -12, displayMax: 12, scale: 1, step: 0.025, typecode: 0x32, defaultRaw: 32767 }, // WAH_EQ8
    24: { kind: 'enum', displayMin: 0, displayMax: 1, scale: 1, step: 0, typecode: 0x10, enumCount: 2, defaultRaw: 0 }, // WAH_SCENEIGNORE
  },
};

/** Family -> (sectionTag, wire stride, raw recordCount). The wire stride
 *  counts ordinary records only (FM3 REVERB 71, DISTORT 144, CABINET 106 all
 *  match the wire-derived values; CABINET's raw count is 110 incl. the 4
 *  special cab-table records the wire stride excludes). */
export const FM3_RANGE_SECTIONS: Readonly<Record<string, Fm3RangeFamilyMeta>> = {
  CABINET: { sectionTag: 11, stride: 106, recordCount: 110 },
  CHORUS: { sectionTag: 16, stride: 29, recordCount: 29 },
  COMP: { sectionTag: 7, stride: 37, recordCount: 37 },
  CONTROLLERS: { sectionTag: 2, stride: 130, recordCount: 130 },
  DELAY: { sectionTag: 13, stride: 88, recordCount: 88 },
  DISTORT: { sectionTag: 10, stride: 144, recordCount: 144 },
  ENHANCER: { sectionTag: 26, stride: 12, recordCount: 12 },
  FDBKRET: { sectionTag: 30, stride: 6, recordCount: 6 },
  FDBKSEND: { sectionTag: 29, stride: 2, recordCount: 2 },
  FILTER: { sectionTag: 24, stride: 37, recordCount: 37 },
  FLANGER: { sectionTag: 17, stride: 33, recordCount: 33 },
  FORMANT: { sectionTag: 21, stride: 12, recordCount: 12 },
  FUZZ: { sectionTag: 25, stride: 43, recordCount: 43 },
  GATE: { sectionTag: 35, stride: 19, recordCount: 19 },
  GEQ: { sectionTag: 8, stride: 20, recordCount: 20 },
  GLOBAL: { sectionTag: 1, stride: 186, recordCount: 187 },
  INPUT: { sectionTag: 41, stride: 10, recordCount: 10, instanceTags: [41, 42] },
  LOOPER: { sectionTag: 50, stride: 24, recordCount: 24 },
  MEGATAP: { sectionTag: 33, stride: 35, recordCount: 35 },
  MIXER: { sectionTag: 28, stride: 17, recordCount: 17 },
  MOD: { sectionTag: 3, stride: 25, recordCount: 25 },
  MULTICOMP: { sectionTag: 37, stride: 37, recordCount: 37 },
  MULTIPLEXER: { sectionTag: 54, stride: 7, recordCount: 7 },
  MULTITAP: { sectionTag: 14, stride: 121, recordCount: 121 },
  OUTPUT: { sectionTag: 46, stride: 26, recordCount: 26, instanceTags: [46, 47] },
  PEQ: { sectionTag: 9, stride: 33, recordCount: 33 },
  PHASER: { sectionTag: 19, stride: 35, recordCount: 35 },
  PITCH: { sectionTag: 23, stride: 114, recordCount: 114 },
  PLEX: { sectionTag: 15, stride: 96, recordCount: 96 },
  PRESET: { sectionTag: 57, stride: 50, recordCount: 50 },
  RESONATOR: { sectionTag: 39, stride: 40, recordCount: 40 },
  REVERB: { sectionTag: 12, stride: 71, recordCount: 71 },
  RINGMOD: { sectionTag: 36, stride: 13, recordCount: 13 },
  ROTARY: { sectionTag: 18, stride: 21, recordCount: 21 },
  SYNTH: { sectionTag: 31, stride: 42, recordCount: 42 },
  TENTAP: { sectionTag: 38, stride: 48, recordCount: 48 },
  TREMOLO: { sectionTag: 22, stride: 22, recordCount: 22 },
  VOLUME: { sectionTag: 40, stride: 15, recordCount: 15 },
  WAH: { sectionTag: 20, stride: 25, recordCount: 25 },
};

/** Cache sections with no confident catalog-family match (system/telemetry
 *  blocks and families whose paramId overlap stayed under the voting floor).
 *  recordCount = raw declared count; wireStride = ordinary records only. */
export const FM3_UNMAPPED_SECTIONS: readonly { sectionTag: number; recordCount: number; wireStride: number }[] = [
  { sectionTag: 4, recordCount: 7, wireStride: 7 },
  { sectionTag: 53, recordCount: 257, wireStride: 257 },
  { sectionTag: 56, recordCount: 8, wireStride: 8 },
  { sectionTag: 58, recordCount: 350, wireStride: 350 },
];
