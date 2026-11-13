/**
 * Axe-Fx II preset-image DEFAULT block records + payload-length census
 * (GENERATED DATA; corpus-mined 2026-07-16, regenerate only from the
 * ii-block-record-encode mining artifacts).
 *
 * Firmware pinning: every table below is Q8.02 / XL+ scoped. Payload
 * lengths are per-dump self-described and drift across firmware; these
 * tables are provenance metadata and encoder inputs, never a substitute
 * for walking the TLV chain of the dump in hand.
 *
 * DEFAULT_RECORDS ships ONLY the five small, rarely-tweaked block types
 * whose factory-modal record is corpus-extractable byte-exactly AND
 * cross-confirmed on live Q8.02 hardware dumps (hw132: records
 * byte-identical to the factory modal for all five wireIds — NOTE, the
 * 2026-07-16 re-mine established hw132's stored-slot-7 / EB dumps are
 * unmodified factory A007 content, so this cross-check confirms the
 * live SERIALIZATION axis, not an independent defaults axis):
 *
 *   wireId 116 Chorus 1          modal exact in  41/146 factory instances
 *   wireId 118 Flanger 1         modal exact in  50/91
 *   wireId 120 Rotary Speaker 1  modal exact in  66/84
 *   wireId 122 Phaser 1          modal exact in  53/97
 *   wireId 124 Wah 1             modal exact in  56/106
 *
 * The always-tweaked types (Amp 106/107, Delay 112, Reverb 110,
 * Multi Delay 114, Pitch 130, Synth 144/145, Vocoder 146, Tone Match
 * 170) have NO corpus-derivable default (0 full-modal matches); they
 * deliberately have no entry here. Synthesizing them would be a guess
 * with no oracle (evidence bar: stays out). Placement of those types is
 * donor-record-only.
 *
 * PAYLOAD_LEN census: payloadLen is constant per wireId within each
 * source kind across the 502-dump census; the ONLY factory-vs-live
 * drift is Amp 106 (factory files 234, live Q8.02 hardware 236 — the
 * conversion is PINNED 2026-07-16: append one 32767/0x7FFF at the end
 * of each 117-word half; 6 witnesses + the fn=0x1F byte-identity
 * golden, verify-ii-image-continuous-apply Section 2c; so every
 * factory Amp record converts deterministically to live layout). When
 * an encoder needs a length for a wireId absent from the target dump,
 * prefer the live-observed length, applied per BLOCK FAMILY (both Amp
 * wireIds 106/107 resolve to live 236 — CONFIRMED for 107 too by the
 * 2026-07-16 fresh-default capture, closing the prediction noted here
 * previously). Pitch 130 shows no factory-vs-live drift (170/170),
 * also confirmed by the same session's fresh capture.
 *
 * Evidence: samples/captured/decoded/ii-block-record-encode/
 * (structure-summary.json, default-records-factory.json,
 * payload-len-by-wireid.json) + the 2026-07-16 adversarial
 * reproduction. Community-beta / hardware-unverified: a freshly
 * user-placed block receiving exactly the modal record has not been
 * hardware-confirmed; the corpus-internal oracle is modal recurrence
 * across 41..66 heterogeneous presets plus the A000+modal-Phaser ==
 * A001 structural synthesis.
 *
 * FRESH_DEFAULT_RECORDS (below) is the HARDWARE-FRESH tier: the 8
 * always-tweaked families (Amp 1/2, Cab, Reverb, Delay, Multi Delay,
 * Pitch, Drive) that DEFAULT_RECORDS deliberately excludes for lack of
 * a corpus oracle. These bytes are not a corpus-statistical guess —
 * they are the literal record the XL+ itself wrote when the family was
 * placed fresh on live hardware (captured 2026-07-16 late night,
 * splice-then-place route for the 6 families the device otherwise
 * remembers in-buffer; live remove/re-place for the 2 that were
 * unplaced going in), read back byte-exact via fn 0x1F (== the image
 * TLV payload, see `ii-fn1f-atomic-read`). Per the project's evidence
 * bar this is STRONGER evidence than DEFAULT_RECORDS' corpus-modal
 * tier (device-authored, not statistically inferred) — but it is a
 * SINGLE capture (one XL+ unit, one Q8.02 firmware, one session), so
 * generalization across other units/firmwares is unconfirmed, and
 * pushing a record built FROM this table through `insertBlockIntoImage`
 * has not itself been hardware round-tripped (the 2026-07-16 splice-
 * push hardware test exercised REMOVE-only images; a synthesized-
 * INSERT push is the next hardware ask). Record per-instance, do not
 * average: fresh Amp 1 (106) and Amp 2 (107) differ at exactly one
 * paramId (9, xformer_grind: 6553 vs 0, mirrored at the X/Y half
 * offset +118) — instances are NOT interchangeable defaults.
 *
 * Evidence: samples/captured/bk084-hw-mech-2026-07-17-02-07-16/
 * (Amp 2, Pitch — unplaced-family route) and
 * samples/captured/fresh-defaults-r2-2026-07-17-02-12-34/ (Amp 1, Cab,
 * Reverb, Delay, Multi Delay, Drive — splice-then-place route), each
 * dir's manifest.json records the exact protocol per family.
 */

export interface AxeFxIIDefaultRecord {
  /** TLV wire id the record is for. */
  readonly wireId: number;
  /** Display name of the block instance ("Phaser 1"). */
  readonly blockName: string;
  /** Self-described payload length (factory Q8.02). */
  readonly payloadLen: number;
  /** Factory instances whose record equals the modal byte-for-byte. */
  readonly fullModalMatches: number;
  /** Factory instances observed. */
  readonly occurrences: number;
  /** The modal payload words (length == payloadLen). */
  readonly payload: readonly number[];
}

/** Corpus-modal default records, keyed by wireId. See module docstring for scope. */
export const DEFAULT_RECORDS: Readonly<Record<number, AxeFxIIDefaultRecord>> = Object.freeze({
  116: Object.freeze({
    wireId: 116,
    blockName: "Chorus 1",
    payloadLen: 48,
    fullModalMatches: 41,
    occurrences: 146,
    payload: Object.freeze([3, 1, 32767, 0, 32767, 52495, 5350, 32767, 0, 1, 32767, 52427, 32767, 0, 0, 1, 0, 32767, 0, 0, 21845, 0, 65534, 0, 0, 1, 32767, 0, 32767, 65534, 25411, 0, 0, 1, 32767, 52427, 32767, 0, 0, 0, 0, 0, 0, 0, 0, 0, 65534, 0]),
  }),
  118: Object.freeze({
    wireId: 118,
    blockName: "Flanger 1",
    payloadLen: 48,
    fullModalMatches: 50,
    occurrences: 91,
    payload: Object.freeze([3, 28480, 0, 32767, 49233, 6553, 0, 32767, 0, 55670, 1, 32767, 52427, 32767, 0, 0, 1, 0, 0, 52495, 26238, 0, 65534, 0, 0, 28480, 0, 16384, 49233, 6553, 0, 0, 0, 55670, 1, 32767, 52427, 32767, 0, 0, 0, 0, 0, 65534, 26238, 0, 65534, 0]),
  }),
  120: Object.freeze({
    wireId: 120,
    blockName: "Rotary Speaker 1",
    payloadLen: 38,
    fullModalMatches: 66,
    occurrences: 84,
    payload: Object.freeze([42597, 16384, 16384, 32767, 0, 32767, 52427, 32767, 0, 0, 22894, 1, 32767, 31268, 42631, 29592, 32767, 0, 32767, 49937, 16384, 16384, 32767, 0, 65534, 52427, 32767, 0, 0, 22894, 256, 32767, 31268, 42631, 29592, 32767, 0, 32767]),
  }),
  122: Object.freeze({
    wireId: 122,
    blockName: "Phaser 1",
    payloadLen: 46,
    fullModalMatches: 53,
    occurrences: 97,
    payload: Object.freeze([5, 1, 41343, 0, 0, 27280, 32767, 25498, 0, 0, 24144, 32767, 52427, 32767, 0, 0, 1, 0, 0, 32767, 0, 0, 0, 0, 1, 32767, 1, 0, 16729, 32767, 25498, 0, 0, 24144, 32767, 52427, 32767, 0, 0, 0, 0, 0, 32767, 0, 0, 0]),
  }),
  124: Object.freeze({
    wireId: 124,
    blockName: "Wah 1",
    payloadLen: 30,
    fullModalMatches: 56,
    occurrences: 106,
    payload: Object.freeze([1, 39455, 39455, 37619, 49151, 0, 52427, 32767, 0, 0, 0, 0, 1, 26214, 22903, 1, 39455, 39455, 37619, 49151, 0, 52427, 32767, 0, 0, 0, 0, 0, 26214, 22903]),
  }),
});

export interface AxeFxIIFreshDefaultRecord {
  /** TLV wire id the record is for. */
  readonly wireId: number;
  /** Display name of the block instance ("Amp 1"). */
  readonly blockName: string;
  /** Self-described payload length (live Q8.02 hardware layout). */
  readonly payloadLen: number;
  /** The captured payload words (length == payloadLen), device-authored. */
  readonly payload: readonly number[];
  /** Capture directory (under samples/captured/) this record was read from. */
  readonly capturedFrom: string;
}

/**
 * HARDWARE-FRESH default block records for the 8 always-tweaked
 * families, keyed by wireId. See module docstring for provenance and
 * the evidence-tier distinction from DEFAULT_RECORDS.
 */
export const FRESH_DEFAULT_RECORDS: Readonly<Record<number, AxeFxIIFreshDefaultRecord>> = Object.freeze({
  106: Object.freeze({
    wireId: 106,
    blockName: "Amp 1",
    payloadLen: 236,
    payload: Object.freeze([0, 32767, 32767, 32767, 32767, 65534, 0, 62796, 37619, 6553, 21845, 65534, 6688, 44346, 1, 2, 0, 26214, 10, 8192, 32767, 44563, 32767, 0, 18284, 32767, 15518, 28125, 0, 45806, 0, 0, 8693, 39320, 1, 29592, 39320, 0, 22282, 1, 0, 48845, 38272, 39455, 43689, 0, 52382, 32767, 55049, 0, 0, 32767, 42631, 37555, 0, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 34078, 32767, 44620, 65534, 65534, 4, 0, 42631, 27833, 32767, 32767, 32767, 0, 21845, 32767, 0, 32767, 49603, 32767, 1, 32767, 32767, 0, 0, 28086, 38010, 0, 0, 0, 0, 0, 22903, 6182, 1, 32767, 29490, 32767, 37082, 32767, 1, 62621, 0, 21845, 8519, 42258, 47536, 0, 0, 0, 32767, 49151, 49151, 19660, 22903, 32767, 0, 32767, 32767, 32767, 32767, 65534, 0, 62796, 37619, 6553, 21845, 65534, 6688, 44346, 1, 2, 0, 26214, 10, 8192, 32767, 44563, 32767, 0, 18284, 32767, 15518, 28125, 0, 45806, 0, 0, 8693, 39320, 1, 29592, 39320, 0, 22282, 1, 0, 48845, 38272, 39455, 43689, 0, 52382, 32767, 55049, 0, 0, 32767, 42631, 37555, 0, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 34078, 32767, 44620, 65534, 65534, 4, 0, 42631, 27833, 32767, 32767, 32767, 0, 21845, 32767, 0, 32767, 49603, 32767, 1, 32767, 32767, 0, 0, 28086, 38010, 0, 0, 0, 0, 0, 22903, 6182, 1, 32767, 29490, 32767, 37082, 32767, 1, 62621, 0, 21845, 8519, 42258, 47536, 0, 0, 0, 32767, 49151, 49151, 19660, 22903, 32767]),
    capturedFrom: "fresh-defaults-r2-2026-07-17-02-12-34/fresh-106-amp-1.syx (splice-then-place)",
  }),
  107: Object.freeze({
    wireId: 107,
    blockName: "Amp 2",
    payloadLen: 236,
    payload: Object.freeze([0, 32767, 32767, 32767, 32767, 65534, 0, 62796, 37619, 0, 21845, 65534, 6688, 44346, 1, 2, 0, 26214, 10, 8192, 32767, 44563, 32767, 0, 18284, 32767, 15518, 28125, 0, 45806, 0, 0, 8693, 39320, 1, 29592, 39320, 0, 22282, 1, 0, 48845, 38272, 39455, 43689, 0, 52382, 32767, 55049, 0, 0, 32767, 42631, 37555, 0, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 34078, 32767, 44620, 65534, 65534, 4, 0, 42631, 27833, 32767, 32767, 32767, 0, 21845, 32767, 0, 32767, 49603, 32767, 1, 32767, 32767, 0, 0, 28086, 38010, 0, 0, 0, 0, 0, 22903, 6182, 1, 32767, 29490, 32767, 37082, 32767, 1, 62621, 0, 21845, 8519, 42258, 47536, 0, 0, 0, 32767, 49151, 49151, 19660, 22903, 32767, 0, 32767, 32767, 32767, 32767, 65534, 0, 62796, 37619, 0, 21845, 65534, 6688, 44346, 1, 2, 0, 26214, 10, 8192, 32767, 44563, 32767, 0, 18284, 32767, 15518, 28125, 0, 45806, 0, 0, 8693, 39320, 1, 29592, 39320, 0, 22282, 1, 0, 48845, 38272, 39455, 43689, 0, 52382, 32767, 55049, 0, 0, 32767, 42631, 37555, 0, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 34078, 32767, 44620, 65534, 65534, 4, 0, 42631, 27833, 32767, 32767, 32767, 0, 21845, 32767, 0, 32767, 49603, 32767, 1, 32767, 32767, 0, 0, 28086, 38010, 0, 0, 0, 0, 0, 22903, 6182, 1, 32767, 29490, 32767, 37082, 32767, 1, 62621, 0, 21845, 8519, 42258, 47536, 0, 0, 0, 32767, 49151, 49151, 19660, 22903, 32767]),
    capturedFrom: "bk084-hw-mech-2026-07-17-02-07-16/fresh-107-amp-2.syx (unplaced-family route)",
  }),
  108: Object.freeze({
    wireId: 108,
    blockName: "Cab 1",
    payloadLen: 78,
    payload: Object.freeze([0, 0, 0, 0, 1, 65534, 65534, 26214, 39320, 52427, 32767, 0, 0, 0, 0, 0, 0, 29126, 6553, 0, 55670, 32767, 0, 0, 0, 26079, 0, 0, 0, 50995, 0, 0, 32767, 32767, 32767, 0, 0, 1, 32767, 0, 0, 0, 0, 1, 65534, 65534, 26214, 39320, 52427, 32767, 0, 0, 0, 0, 0, 0, 29126, 6553, 0, 55670, 32767, 0, 0, 0, 26079, 0, 0, 0, 50995, 0, 0, 32767, 32767, 32767, 0, 0, 1, 32767]),
    capturedFrom: "fresh-defaults-r2-2026-07-17-02-12-34/fresh-108-cab-1.syx (splice-then-place)",
  }),
  110: Object.freeze({
    wireId: 110,
    blockName: "Reverb 1",
    payloadLen: 90,
    payload: Object.freeze([1, 525, 42631, 39455, 65534, 19197, 2621, 34078, 51117, 0, 0, 13107, 9864, 13107, 52427, 32767, 0, 0, 65534, 8, 13107, 19660, 0, 3, 0, 13107, 32767, 29592, 27833, 27833, 32767, 32767, 0, 32767, 27691, 52427, 0, 65534, 0, 19660, 39320, 32767, 45874, 0, 0, 1, 525, 42631, 39455, 65534, 19197, 2621, 34078, 51117, 0, 0, 13107, 9864, 13107, 52427, 32767, 0, 0, 65534, 8, 13107, 19660, 0, 3, 0, 13107, 32767, 29592, 27833, 27833, 32767, 32767, 0, 32767, 27691, 52427, 0, 65534, 0, 19660, 39320, 32767, 45874, 0, 0]),
    capturedFrom: "fresh-defaults-r2-2026-07-17-02-12-34/fresh-110-reverb-1.syx (splice-then-place)",
  }),
  112: Object.freeze({
    wireId: 112,
    blockName: "Delay 1",
    payloadLen: 140,
    payload: Object.freeze([0, 0, 4088, 65534, 36044, 36044, 36044, 32767, 65534, 0, 0, 65534, 22903, 45806, 0, 0, 0, 9830, 52427, 32767, 0, 0, 2, 65534, 0, 0, 4088, 0, 32767, 0, 32767, 32767, 65534, 65534, 0, 65534, 0, 0, 2322, 1, 0, 0, 0, 32767, 21845, 0, 29126, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22903, 27833, 0, 42631, 29592, 27833, 27833, 32767, 32767, 0, 32767, 0, 0, 0, 4088, 65534, 36044, 36044, 36044, 32767, 65534, 0, 0, 65534, 22903, 45806, 0, 0, 0, 9830, 52427, 32767, 0, 0, 0, 65534, 0, 0, 4088, 0, 32767, 0, 32767, 32767, 65534, 65534, 0, 65534, 0, 0, 2322, 1, 0, 0, 0, 32767, 21845, 0, 29126, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 22903, 27833, 0, 42631, 29592, 27833, 27833, 32767, 32767, 0, 32767, 0]),
    capturedFrom: "fresh-defaults-r2-2026-07-17-02-12-34/fresh-112-delay-1.syx (splice-then-place)",
  }),
  114: Object.freeze({
    wireId: 114,
    blockName: "Multi Delay 1",
    payloadLen: 118,
    payload: Object.freeze([13081, 19637, 26194, 32751, 14, 11, 12, 15, 65534, 65534, 65534, 65534, 36044, 36044, 36044, 36044, 16384, 49151, 0, 65534, 23089, 23089, 23089, 23089, 0, 0, 0, 0, 16384, 52427, 32767, 0, 0, 65534, 10, 0, 5451, 65534, 0, 32767, 0, 32767, 65534, 65534, 65534, 32770, 0, 65534, 49151, 49151, 38010, 35388, 30146, 27524, 24, 24, 24, 24, 22903, 29592, 39455, 45806, 40400, 40400, 40400, 40400, 65534, 0, 65534, 0, 32767, 0, 0, 0, 0, 1, 3, 0, 0, 3214, 0, 0, 32767, 0, 6, 0, 0, 65534, 0, 32767, 0, 65534, 65534, 0, 2621, 3277, 3277, 3277, 3277, 3277, 3277, 3277, 3277, 3277, 52427, 52427, 52427, 52427, 52427, 52427, 52427, 52427, 52427, 52427, 120, 0, 590, 0]),
    capturedFrom: "fresh-defaults-r2-2026-07-17-02-12-34/fresh-114-multi-delay-1.syx (splice-then-place)",
  }),
  130: Object.freeze({
    wireId: 130,
    blockName: "Pitch 1",
    payloadLen: 170,
    payload: Object.freeze([0, 0, 65534, 65534, 24, 24, 0, 0, 0, 32767, 32767, 24, 24, 65534, 65534, 32767, 32767, 0, 0, 0, 0, 1, 40360, 16384, 52427, 32767, 0, 0, 65534, 0, 32767, 16359, 16359, 0, 0, 0, 0, 0, 1, 45806, 21845, 65534, 65534, 65534, 65534, 7, 1, 2, 3, 4, 5, 6, 7, 0, 0, 4, 31, 1, 6, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 65534, 65534, 24, 24, 0, 0, 0, 32767, 32767, 24, 24, 65534, 65534, 32767, 32767, 0, 0, 0, 0, 1, 40360, 16384, 52427, 32767, 0, 0, 65534, 0, 32767, 16359, 16359, 0, 0, 0, 0, 0, 1, 45806, 21845, 65534, 65534, 65534, 65534, 7, 1, 2, 3, 4, 5, 6, 7, 0, 0, 4, 31, 1, 6, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 48, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    capturedFrom: "bk084-hw-mech-2026-07-17-02-07-16/fresh-130-pitch-1.syx (unplaced-family route)",
  }),
  133: Object.freeze({
    wireId: 133,
    blockName: "Drive 1",
    payloadLen: 42,
    payload: Object.freeze([0, 32767, 32767, 32767, 65534, 0, 31268, 2, 15634, 61440, 6, 33095, 32767, 32767, 32926, 32767, 0, 0, 32767, 65534, 32767, 0, 32767, 32767, 32767, 65534, 0, 31268, 0, 15634, 61440, 6, 33095, 32767, 32767, 32926, 32767, 0, 0, 32767, 65534, 32767]),
    capturedFrom: "fresh-defaults-r2-2026-07-17-02-12-34/fresh-133-drive-1.syx (splice-then-place)",
  }),
});

/**
 * Per-wireId payloadLen census (Q8.02): factory bank files vs live
 * hardware dumps. `undefined` = no observation of that kind on disk.
 * Only Amp 106 drifts between kinds (234 vs 236).
 */
export const PAYLOAD_LEN_CENSUS: Readonly<Record<number, { readonly factory?: number; readonly live?: number }>> = Object.freeze({
  100: Object.freeze({ factory: 40, live: 40 }),
  101: Object.freeze({ factory: 40, live: undefined }),
  102: Object.freeze({ factory: 38, live: undefined }),
  103: Object.freeze({ factory: 38, live: undefined }),
  104: Object.freeze({ factory: 48, live: undefined }),
  105: Object.freeze({ factory: 48, live: undefined }),
  106: Object.freeze({ factory: 234, live: 236 }),
  107: Object.freeze({ factory: 234, live: 236 }),
  108: Object.freeze({ factory: 78, live: 78 }),
  109: Object.freeze({ factory: 78, live: undefined }),
  110: Object.freeze({ factory: 90, live: 90 }),
  111: Object.freeze({ factory: 90, live: 90 }),
  112: Object.freeze({ factory: 140, live: 140 }),
  113: Object.freeze({ factory: 140, live: undefined }),
  114: Object.freeze({ factory: 118, live: 118 }),
  115: Object.freeze({ factory: 118, live: 118 }),
  116: Object.freeze({ factory: 48, live: 48 }),
  117: Object.freeze({ factory: 48, live: 48 }),
  118: Object.freeze({ factory: 48, live: 48 }),
  119: Object.freeze({ factory: 48, live: undefined }),
  120: Object.freeze({ factory: 38, live: 38 }),
  121: Object.freeze({ factory: 38, live: undefined }),
  122: Object.freeze({ factory: 46, live: 46 }),
  124: Object.freeze({ factory: 30, live: 30 }),
  125: Object.freeze({ factory: 30, live: undefined }),
  126: Object.freeze({ factory: 12, live: undefined }),
  127: Object.freeze({ factory: 9, live: 9 }),
  128: Object.freeze({ factory: 32, live: undefined }),
  130: Object.freeze({ factory: 170, live: 170 }),
  131: Object.freeze({ factory: 14, live: undefined }),
  132: Object.freeze({ factory: 14, live: undefined }),
  133: Object.freeze({ factory: 42, live: 42 }),
  134: Object.freeze({ factory: 42, live: undefined }),
  135: Object.freeze({ factory: 11, live: undefined }),
  136: Object.freeze({ factory: 20, live: undefined }),
  139: Object.freeze({ factory: 8, live: 8 }),
  140: Object.freeze({ factory: 20, live: 20 }),
  141: Object.freeze({ factory: 96, live: 96 }),
  142: Object.freeze({ factory: 2, live: undefined }),
  143: Object.freeze({ factory: 6, live: undefined }),
  144: Object.freeze({ factory: 40, live: undefined }),
  145: Object.freeze({ factory: 40, live: undefined }),
  147: Object.freeze({ factory: 17, live: undefined }),
  148: Object.freeze({ factory: 15, live: undefined }),
  150: Object.freeze({ factory: 26, live: undefined }),
  152: Object.freeze({ factory: 10, live: undefined }),
  153: Object.freeze({ factory: 170, live: undefined }),
  154: Object.freeze({ factory: 28, live: undefined }),
  156: Object.freeze({ factory: 46, live: undefined }),
  158: Object.freeze({ factory: 40, live: undefined }),
  162: Object.freeze({ factory: 48, live: undefined }),
  164: Object.freeze({ factory: 14, live: undefined }),
  166: Object.freeze({ factory: 9, live: undefined }),
  167: Object.freeze({ factory: 9, live: undefined }),
  170: Object.freeze({ factory: 37, live: undefined }),
});
