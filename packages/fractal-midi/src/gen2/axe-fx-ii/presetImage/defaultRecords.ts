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
 * byte-identical to the factory modal for all five wireIds):
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
 * drift is Amp 106 (factory files 234, live Q8.02 hardware 236). When
 * an encoder needs a length for a wireId absent from the target dump,
 * prefer the live-observed length, applied per BLOCK FAMILY (both Amp
 * wireIds 106/107 resolve to the live 236 on a live device even though
 * 107 itself has zero live observations).
 *
 * Evidence: samples/captured/decoded/ii-block-record-encode/
 * (structure-summary.json, default-records-factory.json,
 * payload-len-by-wireid.json) + the 2026-07-16 adversarial
 * reproduction. Community-beta / hardware-unverified: a freshly
 * user-placed block receiving exactly the modal record has not been
 * hardware-confirmed; the corpus-internal oracle is modal recurrence
 * across 41..66 heterogeneous presets plus the A000+modal-Phaser ==
 * A001 structural synthesis.
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
  107: Object.freeze({ factory: 234, live: undefined }),
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
  130: Object.freeze({ factory: 170, live: undefined }),
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
