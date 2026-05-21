// extract-axe-fx-ii-params.ts
//
// Hardware-free generator for the Fractal Axe-Fx II XL+ parameter
// registry. Joins two existing data sources:
//
//   1. The Fractal Audio Wiki's `MIDI_SysEx` page (cached at
//      `docs/_private/wiki-cache/axe-fx-ii-midi-sysex.html`). Carries
//      the per-block parameter ID tables — the wire-IDs needed to
//      build SET_BLOCK_PARAMETER_VALUE messages. Source of truth for
//      `(blockGroup, paramId, name, type, options)`.
//
//   2. The Axe-Edit BinaryData XML catalog (already extracted by
//      `extract-axe-fx-ii-catalog.ts` to
//      `samples/captured/decoded/labels/axe-edit-catalog.json`).
//      Carries the symbolic parameterName (e.g. `DISTORT_DRIVE`) +
//      Title-Case UI label + type-applicability gates. **No wire IDs.**
//
// Outputs:
//   src/fractal/axe-fx-ii/blockTypes.ts      — block ID dictionary
//   src/fractal/axe-fx-ii/params.ts          — KNOWN_PARAMS registry
//   samples/captured/decoded/labels/axe-fx-ii-params.json
//                                            — full structured dump
//
// Run:
//   npx tsx scripts/extract-axe-fx-ii-params.ts
//
// Status: hardware-free RE artefact. Wiki data is documented "as of
// Quantum 8.02" but we have not yet captured live Axe-Edit ↔ device
// SysEx to verify the wiki spec holds on the founder's current
// firmware. Every entry stays 🟡 wiki-documented until HW-074 lands.
// See `docs/devices/axe-fx-ii/SYSEX-MAP.md` for the current state.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Hardware-verified header preservation ─────────────────────────────
//
// The emitter's default `Status:` paragraph reads
// `🟡 wiki-documented, not yet hardware-verified` — the right truth
// when the registry was first shipped. After HW-075/HW-077 verified
// the encoder + paramId resolution on Quantum 8.02 (founder's XL+,
// 2026-05-10), the file's header was hand-promoted to `🟢
// hardware-verified`. The old emitter clobbered that promotion on
// every regen, so the founder rejected regens that would otherwise
// have closed wiki gaps.
//
// The preservation step below reads the existing params.ts file (when
// present) and extracts whatever currently fills the `Status:`
// paragraph, then splices it back into the freshly-generated header.
// If the file is absent (first run / fresh worktree) or has no
// recognisable Status: block, the default 🟡 string ships unchanged.
//
// Match shape: a `Status:` paragraph runs from the line starting
// ` * Status: ` to the next blank-comment-line (` *\n`). That covers
// both the default one-line shape and the multi-line HW-075 / HW-077
// promotion paragraph the founder wrote.
//
// **Session 94 cont 2 (2026-05-17): hand-curated hardware calibrations
// are now BAKED INTO THE GENERATOR.** Specifically:
//   • `DELAY_TEMPO_VALUES` enum const (HW-091 / HW-093 measurement,
//     2026-05-11) — wire 0..32 tempo-division ladder — emitted from
//     `DELAY_TEMPO_VALUES_DATA` constant below, alongside the wiki-
//     derived enum tables.
//   • `displayScale?: 'linear' | 'log10'` field on `AxeFxIIParam`
//     interface (HW-090, 2026-05-11) — present in the emitted
//     interface template.
//   • Per-entry display calibrations measured on real Axe-Fx II XL+
//     (Q8.02) across HW-079/HW-088/HW-089/HW-090/HW-091/HW-092/HW-093
//     + Session 68 — emitted via the `HARDWARE_OVERRIDES` table below.
//     20 entries; each carries its provenance comment as a leading
//     line above the emitted entry in `params.ts`.
// Regen is now SAFE. The Status header + Ghidra addendum block
// preservation passes below still apply.

const STATUS_BLOCK_RE = /^( \* Status:[^\n]*(?:\n \* [^\n]*)*)$/m;

function readPreservedStatusBlock(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const src = readFileSync(path, 'utf8');
  const m = STATUS_BLOCK_RE.exec(src);
  return m ? m[1] : undefined;
}

function applyStatusPreservation(generated: string, preserved: string | undefined): string {
  if (!preserved) return generated;
  // Only one Status: paragraph in the header block — replace the
  // freshly-emitted default with the preserved one verbatim. If the
  // generator format ever changes shape such that the regex misses,
  // the function returns the generated text unchanged (lossless
  // fallback — no risk of corrupting the file).
  if (!STATUS_BLOCK_RE.test(generated)) return generated;
  return generated.replace(STATUS_BLOCK_RE, preserved);
}

// ── Ghidra-addendum block preservation ────────────────────────────────
//
// Session 94 (2026-05-17) added 221 net-new entries to `params.ts`
// recovered via direct-pattern-scan Ghidra mining of `Axe-Edit.exe`
// (`scripts/ghidra/SeekParamTablesII.java`). The block sits between
// the last wiki entry and the closing `} as const`, wrapped in
// `// >>> BEGIN_GHIDRA_ADDENDUM` / `// <<< END_GHIDRA_ADDENDUM`
// markers exactly so this preservation step can pattern-match and
// re-splice it across regens.
//
// Match shape: from the BEGIN marker line (indented 4 spaces) through
// the END marker line. Captures the entire block verbatim including
// the per-block section comments and trailing blank.
//
// Re-splice: just before the `} as const satisfies Readonly<Record
// <string, AxeFxIIParam>>;` close line, with a leading blank line
// separator from the last wiki entry.
//
// Lossless fallback: if the existing file has no addendum block
// (fresh worktree, or a future deletion), nothing is spliced and the
// regen output matches the legacy shape exactly.

const ADDENDUM_BLOCK_RE =
  /( {4}\/\/ >>> BEGIN_GHIDRA_ADDENDUM[\s\S]*?\/\/ <<< END_GHIDRA_ADDENDUM[^\r\n]*)/m;
const PARAMS_CLOSE_RE =
  /\n(} as const satisfies Readonly<Record<string, AxeFxIIParam>>;)/;

function readPreservedAddendumBlock(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const src = readFileSync(path, 'utf8');
  const m = ADDENDUM_BLOCK_RE.exec(src);
  return m ? m[1] : undefined;
}

function applyAddendumPreservation(generated: string, preserved: string | undefined): string {
  if (!preserved) return generated;
  if (!PARAMS_CLOSE_RE.test(generated)) return generated; // lossless fallback
  // Idempotency: if the freshly-generated text already contains an
  // addendum (e.g. future generator gains its own emit), don't double-
  // splice — leave generated as-is.
  if (ADDENDUM_BLOCK_RE.test(generated)) return generated;
  // Match line-ending convention of the generated file so the splice
  // doesn't mix LF/CRLF (round-trip identity test fails by 2 bytes
  // otherwise on Windows-checkout repos).
  const eol = generated.includes('\r\n') ? '\r\n' : '\n';
  return generated.replace(PARAMS_CLOSE_RE, eol + eol + preserved + eol + '$1');
}

// ── Hardware-verified overrides (HW-079..HW-093 + Session 68) ─────────
//
// Hand-measured fields the wiki + XML pipeline doesn't carry. Baked into
// the generator so regen preserves them; the wiki source remains the
// primary input, this layer only injects additional metadata on matching
// entries.
//
// Each entry shadows the wiki-derived emit() output: `displayMin`,
// `displayMax`, `displayScale`, `step`, and `enumValuesRef` (the latter
// for delay.tempo which points at the HW-091/HW-093 measured const).
// `comment` lines (one or more, joined by '\n') emit as `// ` prefix
// lines above the entry in `params.ts`, preserving the HW-NNN
// provenance for code review.

interface HardwareOverride {
  displayMin?: number;
  displayMax?: number;
  displayScale?: 'log10';
  step?: number;
  enumValuesRef?: string;
  comment?: string;
}

const HARDWARE_OVERRIDES: Readonly<Record<string, HardwareOverride>> = {
  // HW-079 (Session 42, 2026-05-01): five amp first-page knobs at 0..10
  // linear. Group comment lives on the first entry (amp.1).
  'amp.1': {
    displayMin: 0, displayMax: 10,
    comment:
      'HW-079 calibration (2026-05-11): hardware sweep on Q8.02 confirmed\n' +
      'wire 0..65534 ↔ display 0.00..10.00 linear for these 5 amp params,\n' +
      'with quarter-scale anchors landing exactly at 2.50/5.00/7.50/10.00.\n' +
      'Conversion: display = wire / 65534 * 10. NOT regenerated from\n' +
      'wiki/XML — the wiki doesn\'t document display ranges for these.\n' +
      'If you regen this file via `scripts/extract-axe-fx-ii-params.ts`\n' +
      'and these displayMin/displayMax fields disappear, re-apply from\n' +
      'this commit. See `docs/_private/HARDWARE-TASKS-AXEFX2.md` HW-079.',
  },
  'amp.2': { displayMin: 0, displayMax: 10 },
  'amp.3': { displayMin: 0, displayMax: 10 },
  'amp.4': { displayMin: 0, displayMax: 10 },
  'amp.5': { displayMin: 0, displayMax: 10 },

  // HW-092 (2026-05-11): cab/amp filter freqs log10 over 2 decades.
  'amp.6': {
    displayMin: 10, displayMax: 1000, displayScale: 'log10',
    comment: 'HW-092 calibration (2026-05-11): 10..1000 Hz log10 over 2 decades.',
  },
  'amp.7': {
    displayMin: 400, displayMax: 40000, displayScale: 'log10',
    comment: 'HW-092 calibration (2026-05-11): 400..40000 Hz log10 over 2 decades.',
  },

  // Session 68: depth + presence are 0..10 same as input_drive et al.
  // Group comment on amp.16 (depth).
  'amp.16': {
    displayMin: 0, displayMax: 10,
    comment:
      'Session 68 calibration: depth + presence are 0..10 knobs on the\n' +
      'amp\'s front panel (same range as input_drive / bass / middle /\n' +
      'treble / master_volume). Adding the explicit displayMin/Max\n' +
      'unblocks apply_preset_at calls that pass display values like\n' +
      '`presence: 6.5` — previously rejected as "wire out of range".',
  },
  'amp.20': { displayMin: 0, displayMax: 10 },

  // HW-089 (2026-05-11): bipolar -100..+100.
  'amp.22': {
    displayMin: -100, displayMax: 100,
    comment:
      'HW-089 calibration (2026-05-11): wire 0..65534 ↔ -100..+100 ' +
      'bipolar linear (wire 32767 = 0.0).',
  },
  'cab.7': {
    displayMin: -100, displayMax: 100,
    comment:
      'HW-089 calibration (2026-05-11): wire 0..65534 ↔ -100..+100 ' +
      'bipolar linear.',
  },

  // HW-088 (2026-05-11): cab.level -80..+20 dB; %-linear knobs at 0..100.
  'cab.9': {
    displayMin: -80, displayMax: 20,
    comment:
      'HW-088 calibration (2026-05-11): wire 0..65534 ↔ -80..+20 dB linear.',
  },

  // HW-090 (2026-05-11): cab filter freqs log10.
  'cab.19': {
    displayMin: 20, displayMax: 2000, displayScale: 'log10',
    comment:
      'HW-090 calibration (2026-05-11): wire 0..65534 ↔ 20..2000 Hz log10\n' +
      '(2 decades). Verified at all 9 anchors against displayHz =\n' +
      '20 × 100^(wire/65534): wire 32767 → 200 Hz (geometric mean) ✓.',
  },
  'cab.20': {
    displayMin: 200, displayMax: 20000, displayScale: 'log10',
    comment:
      'HW-090 calibration (2026-05-11): wire 0..65534 ↔ 200..20000 Hz\n' +
      'log10 (2 decades). Verified at all 9 anchors.',
  },

  // HW-088 %-linear knobs at 0..100.
  'chorus.10': {
    displayMin: 0, displayMax: 100,
    comment:
      'HW-088 calibration (2026-05-11): wire 0..65534 ↔ 0..100% linear.',
  },

  // HW-091 (2026-05-11): delay.time 1..8000 ms.
  'delay.2': {
    displayMin: 1, displayMax: 8000,
    comment:
      'HW-091 calibration (2026-05-11, tempo sync DISABLED): wire 0..65534\n' +
      '↔ 1..8000 ms linear. NOTE: when `delay.tempo` is set to a non-NONE\n' +
      'sync value, the device IGNORES manual `delay.time` writes and shows\n' +
      'the tempo-derived time in parens (e.g. "(375 ms)"). Caller should\n' +
      'set `delay.tempo` to wire 0 (NONE) before setting `delay.time`\n' +
      'manually, OR accept that the time write will be silently overridden.',
  },

  // HW-088 delay.feedback bipolar.
  'delay.4': {
    displayMin: -100, displayMax: 100,
    comment:
      'HW-088 calibration (2026-05-11): wire 0..65534 ↔ -100..+100% ' +
      'bipolar linear (wire 32767 = exact zero crossing).',
  },

  // HW-091 + HW-093 delay.tempo enum. Const emitted below; this entry
  // references it via enumValuesRef.
  'delay.9': {
    enumValuesRef: 'DELAY_TEMPO_VALUES',
    comment: 'HW-091 + HW-093 enum table (2026-05-11): 33 entries mapped wire 0..32.',
  },

  // HW-092 drive.gain 0..10.
  'drive.1': {
    displayMin: 0, displayMax: 10,
    comment: 'HW-092 calibration (2026-05-11): 0..10 linear, same as AMP first-page knobs.',
  },

  // HW-088 reverb.mix %-linear.
  'reverb.13': {
    displayMin: 0, displayMax: 100,
    comment: 'HW-088 calibration (2026-05-11): wire 0..65534 ↔ 0..100% linear.',
  },
};

// ── Hardware-captured enum-value overrides (Session 107, 2026-05-20) ──
//
// fn 0x28 SYSEX_GET_PARAM_STRINGS on Q8.02 XL+ surfaced 4 wiki
// transcription errors in the AMP_EFFECT_TYPE table: the wiki's
// MIDI_SysEx page (the generator's primary input) differs from both
// the device's emitted display labels AND the wiki's own
// Amp_models_list page. Hardware ground truth wins per the
// "Verification sources of truth" rule in CLAUDE.md.
//
// Each entry overrides a single (block, paramId, wireIndex) ASCII
// label with the hardware-captured string. Generator emits the
// overridden value verbatim into the corresponding *_VALUES enum
// const.
//
// Re-validate / extend on the next fn 0x28 probe sweep:
//   npx tsx scripts/_research/probe-axefx2-enum-dump.ts
// Decoder + diff:
//   npx tsx scripts/_research/diff-fn28-vs-catalog.ts

interface EnumLabelOverride {
  readonly block: string;
  readonly paramId: number;
  readonly wireIndex: number;
  readonly hardwareLabel: string;
  readonly wikiLabel: string;
  readonly note: string;
}

const ENUM_VALUE_OVERRIDES: ReadonlyArray<EnumLabelOverride> = [
  {
    block: 'amp', paramId: 0, wireIndex: 22,
    hardwareLabel: 'USA IIC+ BRIGHT', wikiLabel: 'USA IIC+ BRight',
    note: 'Wiki MIDI_SysEx page has inconsistent casing; device emits all-caps.',
  },
  {
    block: 'amp', paramId: 0, wireIndex: 44,
    hardwareLabel: 'CORNFED M50', wikiLabel: 'CORNCOB M50',
    note:
      'Wiki MIDI_SysEx page has a transcription error ("CORNCOB"); ' +
      'Wiki Amp_models_list page + device both have "CORNFED M50". ' +
      'Amp models a Cornford MK50 II.',
  },
  {
    block: 'amp', paramId: 0, wireIndex: 45,
    hardwareLabel: 'CAROL-ANN OD-2', wikiLabel: 'CA OD-2',
    note: 'Wiki MIDI_SysEx page abbreviated to "CA"; full name is CAROL-ANN.',
  },
  {
    block: 'amp', paramId: 0, wireIndex: 65,
    hardwareLabel: 'SV BASS 1', wikiLabel: 'SV BASS',
    note: 'Wiki dropped the trailing "1".',
  },

  // ── Full-block sweep 2026-05-21 (probe-axefx2-enum-dump.ts on Q8.02 XL+) ──
  //
  // 145-probe sweep across every block's enum params surfaced 47 new
  // overridable mismatches (existing wireIndex, wrong label) split as:
  //   - LEFT/RIGHT/BOTH/NONE/MUTE/THRU casing diffs (~33 entries)
  //   - Wiki transcription errors: amp.bypass_mode had wrong table
  //     (Left/Right vs. THRU/MUTE), amp.sat_switch had abbreviated
  //     "AUTH"/"IDEAL" vs. full "ON (AUTH)"/"ON (IDEAL)", pantrem
  //     "PanNER" vs. "PANNER", chorus "JAPan CE-2" vs. "JAPAN CE-2"
  //   - looper.quantize wiki used English ("QUARTER","EIGTH"-typo,
  //     "SIXTEENTH") vs. firmware fractions ("1/4","1/8","1/16")
  //
  // 52 additional catalog-MISSING entries (delay.tempo idx 33-78 wide
  // expansion, amp.tone_stack idx 108-109 SPAWN NITROUS + SV BASS,
  // drive.effect_type idx 36 BLACKGLASS 7K, pitch.mode 1-5, etc) are
  // deferred — they need a generator extension to ADD wireIndexes,
  // not just override labels. Tracked as Session 108 follow-up.
  //
  // Source: samples/captured/probe-axefx2-enum-dump-findings.md
  // Generator: npx tsx scripts/_research/generate-enum-overrides.ts
  {
    block: 'amp', paramId: 15, wireIndex: 0,
    hardwareLabel: 'LEFT', wikiLabel: 'Left',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'amp', paramId: 15, wireIndex: 1,
    hardwareLabel: 'RIGHT', wikiLabel: 'Right',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'amp', paramId: 23, wireIndex: 0,
    hardwareLabel: 'THRU', wikiLabel: 'Left',
    note: 'Wiki MIDI_SysEx page had the wrong table (Left/Right copied from input_select); device emits "THRU"/"MUTE".',
  },
  {
    block: 'amp', paramId: 23, wireIndex: 1,
    hardwareLabel: 'MUTE', wikiLabel: 'Right',
    note: 'Wiki MIDI_SysEx page had the wrong table (Left/Right copied from input_select); device emits "THRU"/"MUTE".',
  },
  {
    block: 'amp', paramId: 54, wireIndex: 1,
    hardwareLabel: 'ON (AUTH)', wikiLabel: 'AUTH',
    note: 'Wiki MIDI_SysEx page abbreviated; device emits full "ON (AUTH)".',
  },
  {
    block: 'amp', paramId: 54, wireIndex: 2,
    hardwareLabel: 'ON (IDEAL)', wikiLabel: 'IDEAL',
    note: 'Wiki MIDI_SysEx page abbreviated; device emits full "ON (IDEAL)".',
  },
  {
    block: 'cab', paramId: 1, wireIndex: 0,
    hardwareLabel: 'NONE', wikiLabel: 'None',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'cab', paramId: 3, wireIndex: 0,
    hardwareLabel: 'NONE', wikiLabel: 'None',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'cab', paramId: 30, wireIndex: 1,
    hardwareLabel: 'LEFT', wikiLabel: 'Left',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'cab', paramId: 30, wireIndex: 2,
    hardwareLabel: 'RIGHT', wikiLabel: 'Right',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'cab', paramId: 31, wireIndex: 0,
    hardwareLabel: 'NONE', wikiLabel: 'None',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'chorus', paramId: 0, wireIndex: 4,
    hardwareLabel: 'JAPAN CE-2', wikiLabel: 'JAPan CE-2',
    note: 'Wiki MIDI_SysEx page used inconsistent casing; device emits all-caps.',
  },
  {
    block: 'chorus', paramId: 16, wireIndex: 0,
    hardwareLabel: 'NONE', wikiLabel: 'None',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'chorus', paramId: 16, wireIndex: 1,
    hardwareLabel: 'RIGHT', wikiLabel: 'Right',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'chorus', paramId: 16, wireIndex: 2,
    hardwareLabel: 'LEFT', wikiLabel: 'Left',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'chorus', paramId: 16, wireIndex: 3,
    hardwareLabel: 'BOTH', wikiLabel: 'Both',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'delay', paramId: 47, wireIndex: 0,
    hardwareLabel: 'NONE', wikiLabel: 'None',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'delay', paramId: 47, wireIndex: 1,
    hardwareLabel: 'RIGHT', wikiLabel: 'Right',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'delay', paramId: 47, wireIndex: 2,
    hardwareLabel: 'LEFT', wikiLabel: 'Left',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'delay', paramId: 47, wireIndex: 3,
    hardwareLabel: 'BOTH', wikiLabel: 'Both',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'delay', paramId: 48, wireIndex: 0,
    hardwareLabel: 'BOTH', wikiLabel: 'Both',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'delay', paramId: 48, wireIndex: 1,
    hardwareLabel: 'LEFT', wikiLabel: 'Left',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'delay', paramId: 48, wireIndex: 2,
    hardwareLabel: 'RIGHT', wikiLabel: 'Right',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'delay', paramId: 49, wireIndex: 0,
    hardwareLabel: 'BOTH', wikiLabel: 'Both',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'delay', paramId: 49, wireIndex: 1,
    hardwareLabel: 'LEFT', wikiLabel: 'Left',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'delay', paramId: 49, wireIndex: 2,
    hardwareLabel: 'RIGHT', wikiLabel: 'Right',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'drive', paramId: 17, wireIndex: 1,
    hardwareLabel: 'LEFT', wikiLabel: 'Left',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'drive', paramId: 17, wireIndex: 2,
    hardwareLabel: 'RIGHT', wikiLabel: 'Right',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'enhancer', paramId: 7, wireIndex: 0,
    hardwareLabel: 'NONE', wikiLabel: 'None',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'enhancer', paramId: 7, wireIndex: 1,
    hardwareLabel: 'RIGHT', wikiLabel: 'Right',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'enhancer', paramId: 7, wireIndex: 2,
    hardwareLabel: 'LEFT', wikiLabel: 'Left',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'enhancer', paramId: 7, wireIndex: 3,
    hardwareLabel: 'BOTH', wikiLabel: 'Both',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'filter', paramId: 11, wireIndex: 0,
    hardwareLabel: 'NONE', wikiLabel: 'None',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'filter', paramId: 11, wireIndex: 1,
    hardwareLabel: 'RIGHT', wikiLabel: 'Right',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'filter', paramId: 11, wireIndex: 2,
    hardwareLabel: 'LEFT', wikiLabel: 'Left',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'filter', paramId: 11, wireIndex: 3,
    hardwareLabel: 'BOTH', wikiLabel: 'Both',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'flanger', paramId: 17, wireIndex: 0,
    hardwareLabel: 'NONE', wikiLabel: 'None',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'flanger', paramId: 17, wireIndex: 1,
    hardwareLabel: 'RIGHT', wikiLabel: 'Right',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'flanger', paramId: 17, wireIndex: 2,
    hardwareLabel: 'LEFT', wikiLabel: 'Left',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'flanger', paramId: 17, wireIndex: 3,
    hardwareLabel: 'BOTH', wikiLabel: 'Both',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'looper', paramId: 9, wireIndex: 1,
    hardwareLabel: '1/4', wikiLabel: 'QUARTER',
    note: 'Wiki MIDI_SysEx page used English ("QUARTER"); device emits fraction "1/4".',
  },
  {
    block: 'looper', paramId: 9, wireIndex: 2,
    hardwareLabel: '1/8', wikiLabel: 'EIGTH',
    note: 'Wiki MIDI_SysEx page used English ("EIGTH", with typo); device emits fraction "1/8".',
  },
  {
    block: 'looper', paramId: 9, wireIndex: 3,
    hardwareLabel: '1/16', wikiLabel: 'SIXTEENTH',
    note: 'Wiki MIDI_SysEx page used English ("SIXTEENTH"); device emits fraction "1/16".',
  },
  {
    block: 'pantrem', paramId: 0, wireIndex: 1,
    hardwareLabel: 'PANNER', wikiLabel: 'PanNER',
    note: 'Wiki MIDI_SysEx page used inconsistent casing; device emits all-caps.',
  },
  {
    block: 'pitch', paramId: 37, wireIndex: 1,
    hardwareLabel: 'BOTH', wikiLabel: 'Both',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'volpan', paramId: 8, wireIndex: 1,
    hardwareLabel: 'LEFT ONLY', wikiLabel: 'Left ONLY',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
  {
    block: 'volpan', paramId: 8, wireIndex: 2,
    hardwareLabel: 'RIGHT ONLY', wikiLabel: 'Right ONLY',
    note: 'Wiki MIDI_SysEx page used title-case; device emits all-caps.',
  },
];

// HW-091 + HW-093 (2026-05-11): delay.tempo wire 0..32 → musical
// division enum. Wires 1..21 are the canonical musical-division ladder
// (TRIP / straight / DOT in increasing note-value); 22..24 are integer
// bar multiples; 25..26 are polymeter ratios; 27..32 are odd-numerator
// 64th-note ratios where 10/64 is parens-displayed as (5/32) — the
// Axe-Fx II firmware's "reduced fraction" convention.
const DELAY_TEMPO_VALUES_DATA: ReadonlyArray<readonly [number, string]> = [
  [0, 'NONE'],
  [1, '1/64 TRIP'], [2, '1/64'], [3, '1/64 DOT'],
  [4, '1/32 TRIP'], [5, '1/32'], [6, '1/32 DOT'],
  [7, '1/16 TRIP'], [8, '1/16'], [9, '1/16 DOT'],
  [10, '1/8 TRIP'], [11, '1/8'], [12, '1/8 DOT'],
  [13, '1/4 TRIP'], [14, '1/4'], [15, '1/4 DOT'],
  [16, '1/2 TRIP'], [17, '1/2'], [18, '1/2 DOT'],
  [19, '1 TRIP'], [20, '1'], [21, '1 DOT'],
  [22, '2'], [23, '3'], [24, '4'],
  [25, '4/3'], [26, '5/4'],
  [27, '5/64'], [28, '7/64'], [29, '9/64'],
  [30, '10/64 (5/32)'], [31, '11/64'], [32, '13/64'],
];

// ── Inputs / outputs ──────────────────────────────────────────────────

const WIKI_HTML = 'docs/_private/wiki-cache/axe-fx-ii-midi-sysex.html';
const XML_CATALOG_JSON = 'samples/captured/decoded/labels/axe-edit-catalog.json';

// Axe-Fx II params + blockTypes now live in the sibling `fractal-midi`
// repo (Phase B extraction, 2026-05-18). Maintainer-only regen — edits
// source files in fractal-midi/, so it can't use `require.resolve`
// (that points at built dist). Assumes sibling-repo layout
// `C:/dev/{mcp-midi-tools, fractal-midi}` per
// `docs/research/fractal-midi-extraction-plan.md`.
const _scriptDir = path.dirname(fileURLToPath(import.meta.url));
const FRACTAL_MIDI_REPO = path.resolve(_scriptDir, '..', '..', 'fractal-midi');
const FRACTAL_MIDI_AXEFX2_SRC = path.join(FRACTAL_MIDI_REPO, 'src', 'axe-fx-ii');

if (!existsSync(FRACTAL_MIDI_REPO)) {
    console.error(
        `extract-axe-fx-ii-params: sibling fractal-midi repo not found at ${FRACTAL_MIDI_REPO}.\n` +
        `Clone fractal-midi next to mcp-midi-tools to run this regen script.`,
    );
    process.exit(1);
}

const OUT_BLOCKTYPES_TS = path.join(FRACTAL_MIDI_AXEFX2_SRC, 'blockTypes.ts');
const OUT_PARAMS_TS = path.join(FRACTAL_MIDI_AXEFX2_SRC, 'params.ts');
const OUT_DEBUG_JSON = 'samples/captured/decoded/labels/axe-fx-ii-params.json';

// ── Wiki group code → Axe-Edit XML block name ────────────────────────
//
// The wiki uses 3-letter group codes (AMP, CPR, GEQ); Axe-Edit's XML
// uses CamelCase block names (Amp, Compressor, GraphicEQ). This is the
// only manual mapping the join needs — once paired, parameterName ↔
// paramId joins purely on (block, name) match.
//
// `''` value means the wiki group has no XML editor surface (typically
// I/O / global blocks Axe-Edit doesn't render as a block tile).

const WIKI_TO_XML: Record<string, string> = {
  AMP: 'Amp',
  CAB: 'Cab',
  CPR: 'Compressor',
  GEQ: 'GraphicEQ',
  PEQ: 'ParametricEQ',
  REV: 'Reverb',
  DLY: 'Delay',
  MTD: 'MultiDelay',
  CHO: 'Chorus',
  FLG: 'Flanger',
  ROT: 'Rotary',
  PHA: 'Phaser',
  WAH: 'Wah',
  FRM: 'Formant',
  VOL: 'VolPan',
  TRM: 'PanTrem',
  PIT: 'Pitch',
  FIL: 'Filter',
  DRV: 'Drive',
  ENH: 'Enhancer',
  FXL: 'EffectsLoop',
  INPUT: '',
  OUTPUT: 'Output',
  CONTROLLERS: 'Controllers',
  SYN: 'Synth',
  GTE: 'GateExpander',
  RNG: 'RingMod',
  LPR: 'Looper',
  SND: 'FeedbackSend',
  RTN: 'FeedbackReturn',
  MIX: 'Mixer',
  MBC: 'MultibandComp',
  XVR: 'Crossover',
  MGT: 'MegaTap',
};

// ── Helpers ───────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#10;/g, '\n')
        .replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
    return decodeEntities(html.replace(/<[^>]+>/g, ''));
}

function snakeCase(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

function blockSlug(xmlName: string, groupCode: string): string {
    if (xmlName) return snakeCase(xmlName);
    return snakeCase(groupCode);
}

// ── Wiki HTML parsing ─────────────────────────────────────────────────

interface BlockId {
    id: number;
    name: string;
    groupCode: string;
    canBypass: boolean;
    availableOnAX8: boolean;
    xY: boolean;
    xlY: boolean;
    ax8XY: boolean;
}

interface WikiOption {
    index: number;
    name: string;
}

interface WikiParamRow {
    groupCode: string;
    paramId: number;
    name: string;            // wiki "Name" column verbatim
    type: 'knob' | 'select' | 'switch' | 'unknown';
    options: WikiOption[];
    min?: string;            // verbatim wiki min cell (numbers may be floats)
    max?: string;
    step?: string;
    modifierAssignable: boolean;
    fwAdded?: string;
}

const wikiHtml = readFileSync(WIKI_HTML, 'utf8');

/** Extract the contents of a wikitable starting near `startOffset`. */
function findNextWikitable(html: string, startOffset: number): { start: number; end: number } | null {
    const tableStart = html.indexOf('<table class="wikitable"', startOffset);
    if (tableStart < 0) return null;
    const tableEnd = html.indexOf('</table>', tableStart);
    if (tableEnd < 0) return null;
    return { start: tableStart, end: tableEnd + '</table>'.length };
}

/** Split a `<tbody>` chunk into `<tr>...</tr>` slices. */
function splitRows(tableHtml: string): string[] {
    const rows: string[] = [];
    const re = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tableHtml)) !== null) rows.push(m[1]);
    return rows;
}

/** Pull every `<td>...</td>` out of a row, in order, with text content. */
function rowCells(rowHtml: string): string[] {
    const cells: string[] = [];
    const re = /<td[^>]*>([\s\S]*?)<\/td>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rowHtml)) !== null) cells.push(m[1]);
    return cells;
}

/** Skip rows that are header-only (`<th>` cells) or completely empty. */
function isDataRow(cells: string[]): boolean {
    if (cells.length === 0) return false;
    return cells.some((c) => stripTags(c).trim() !== '');
}

// ── Block IDs table ───────────────────────────────────────────────────

function parseBlockIds(html: string): BlockId[] {
    const anchor = html.indexOf('id="Axe-Fx_II_MIDI_SysEx:_Block_IDs"');
    if (anchor < 0) throw new Error('Block IDs heading not found in wiki HTML');
    const tbl = findNextWikitable(html, anchor);
    if (!tbl) throw new Error('Block IDs wikitable not found');
    const tableHtml = html.slice(tbl.start, tbl.end);

    const rows = splitRows(tableHtml).filter((r) => !/<th[\s>]/.test(r));
    const out: BlockId[] = [];
    for (const r of rows) {
        const cells = rowCells(r).map((c) => stripTags(c).trim());
        if (!isDataRow(cells)) continue;
        if (cells.length < 4) continue;
        const id = Number(cells[0]);
        if (!Number.isFinite(id)) continue;
        out.push({
            id,
            name: cells[1] ?? '',
            groupCode: cells[2] ?? '',
            canBypass: /^yes$/i.test(cells[3] ?? ''),
            availableOnAX8: /^yes$/i.test(cells[4] ?? ''),
            xY: /^yes$/i.test(cells[5] ?? ''),
            xlY: /^yes$/i.test(cells[6] ?? ''),
            ax8XY: /^yes$/i.test(cells[7] ?? ''),
        });
    }
    return out;
}

// ── Per-block parameter tables ────────────────────────────────────────

function parseOptionsCell(cellHtml: string): WikiOption[] {
    // Cell content is `0: NAME<br />1: NAME<br />...`. Split on <br /> /
    // newlines and parse `INDEX: NAME`.
    const text = decodeEntities(cellHtml.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
    const out: WikiOption[] = [];
    for (const line of text.split('\n')) {
        const m = /^\s*(\d+)\s*:\s*(.+?)\s*$/.exec(line);
        if (!m) continue;
        out.push({ index: Number(m[1]), name: m[2] });
    }
    return out;
}

function classifyType(rawType: string): WikiParamRow['type'] {
    const t = rawType.trim().toLowerCase();
    if (t === 'knob' || t === 'select' || t === 'switch') return t;
    return 'unknown';
}

function parseBlockParams(html: string, groupCode: string): WikiParamRow[] {
    const headingRe = new RegExp(`id="${groupCode}"`);
    const m = headingRe.exec(html);
    if (!m) return [];
    const tbl = findNextWikitable(html, m.index);
    if (!tbl) return [];
    const tableHtml = html.slice(tbl.start, tbl.end);

    const rows = splitRows(tableHtml).filter((r) => !/<th[\s>]/.test(r));
    const out: WikiParamRow[] = [];
    for (const r of rows) {
        const cells = rowCells(r);
        if (!isDataRow(cells.map((c) => stripTags(c)))) continue;
        if (cells.length < 4) continue;
        const text = cells.map((c) => stripTags(c).trim());
        // Cell layout: [Block, ID, Name, Type, Options, Min, Max, Step, ModAssign, Added]
        const paramId = Number(text[1]);
        if (!Number.isFinite(paramId)) continue;
        const name = text[2] ?? '';
        if (!name) continue;
        out.push({
            groupCode,
            paramId,
            name,
            type: classifyType(text[3] ?? ''),
            options: parseOptionsCell(cells[4] ?? ''),
            min: text[5] || undefined,
            max: text[6] || undefined,
            step: text[7] || undefined,
            modifierAssignable: /^yes$/i.test(text[8] ?? ''),
            fwAdded: text[9] || undefined,
        });
    }
    return out;
}

// ── XML catalog (already-decoded JSON) ────────────────────────────────

interface XmlEntry {
    label: string;
    parameterName: string;
    controlType: string;
    block: string;
    variant: string;
    variantValue: string;
    page: string;
    pageLayout: string;
    controllingParamName?: string;
    controllingParamValue?: string;
}

interface XmlCatalog {
    totalEntries: number;
    totalUniqueParams: number;
    entries: XmlEntry[];
}

const xmlCatalog: XmlCatalog = JSON.parse(readFileSync(XML_CATALOG_JSON, 'utf8'));

/**
 * Map of XML block name → unique parameterName entries. We dedupe on
 * parameterName because the same symbol appears across many variants —
 * we only need one canonical UI label per symbol for the join.
 */
function buildXmlIndex(): Map<string, Map<string, XmlEntry>> {
    const byBlock = new Map<string, Map<string, XmlEntry>>();
    for (const e of xmlCatalog.entries) {
        if (!e.parameterName) continue;
        if (!byBlock.has(e.block)) byBlock.set(e.block, new Map());
        const inner = byBlock.get(e.block)!;
        // Prefer entries from the "Basic" page (more representative
        // labels) but accept any if Basic is unavailable.
        const existing = inner.get(e.parameterName);
        if (!existing || (e.page === 'Basic' && existing.page !== 'Basic')) {
            inner.set(e.parameterName, e);
        }
    }
    return byBlock;
}

const xmlIndex = buildXmlIndex();

// ── Join wiki rows → XML symbols ──────────────────────────────────────
//
// Match rule: case-insensitive whitespace-collapsed equality between
// wiki Name (e.g. "INPUT DRIVE") and XML label (e.g. "Input Drive").
//
// When the wiki name is something like "EFFECT TYPE" but the XML label
// is "Type", the join misses — we accept that loss; the wire ID is
// what matters and the wiki is authoritative for it.

function normaliseName(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

interface JoinedParam extends WikiParamRow {
    xmlBlock?: string;
    xmlLabel?: string;
    parameterName?: string;
    xmlControlType?: string;
    controllingParamName?: string;
    controllingParamValue?: string;
}

function joinWikiToXml(row: WikiParamRow): JoinedParam {
    const xmlBlock = WIKI_TO_XML[row.groupCode];
    if (!xmlBlock) return { ...row };
    const inner = xmlIndex.get(xmlBlock);
    if (!inner) return { ...row, xmlBlock };
    const target = normaliseName(row.name);
    for (const e of inner.values()) {
        if (normaliseName(e.label) === target) {
            return {
                ...row,
                xmlBlock,
                xmlLabel: e.label,
                parameterName: e.parameterName,
                xmlControlType: e.controlType,
                controllingParamName: e.controllingParamName,
                controllingParamValue: e.controllingParamValue,
            };
        }
    }
    return { ...row, xmlBlock };
}

// ── Run extraction ────────────────────────────────────────────────────

const blockIds = parseBlockIds(wikiHtml);
const allWikiGroups = Array.from(new Set(blockIds.map((b) => b.groupCode))).sort();

// Some wiki sections live under group codes that don't appear in the
// Block IDs table (e.g. `INPUT`, `OUTPUT`, `CONTROLLERS` — global
// surfaces without a block ID). Pick those up by scanning headings.
const headingGroupRe = /<h2><span class="mw-headline" id="([A-Z]{2,12})"/g;
const headingGroups = new Set<string>();
let hm: RegExpExecArray | null;
while ((hm = headingGroupRe.exec(wikiHtml)) !== null) headingGroups.add(hm[1]);

const targetGroups = Array.from(new Set([...allWikiGroups, ...headingGroups])).sort();

const allParams: JoinedParam[] = [];
const groupSummary: Record<string, { rows: number; matched: number }> = {};
for (const g of targetGroups) {
    if (!(g in WIKI_TO_XML) && !headingGroups.has(g)) continue;
    if (!headingGroups.has(g)) continue;
    const rows = parseBlockParams(wikiHtml, g);
    const joined = rows.map(joinWikiToXml);
    allParams.push(...joined);
    groupSummary[g] = {
        rows: rows.length,
        matched: joined.filter((j) => j.parameterName).length,
    };
}

// ── Emit blockTypes.ts ────────────────────────────────────────────────

function emitBlockTypes(): string {
    const sorted = blockIds.slice().sort((a, b) => a.id - b.id);
    const entries = sorted.map((b) =>
        `  { id: ${b.id}, name: ${JSON.stringify(b.name)}, groupCode: ${JSON.stringify(b.groupCode)}, canBypass: ${b.canBypass}, availableOnAX8: ${b.availableOnAX8} },`,
    ).join('\n');

    return `/**
 * Axe-Fx II block ID dictionary (generated).
 *
 * Source: Fractal Audio Wiki "MIDI_SysEx" page, "Axe-Fx II MIDI SysEx:
 * Block IDs" table, cached at
 * \`docs/_private/wiki-cache/axe-fx-ii-midi-sysex.html\`.
 *
 * Wire context: the Axe-Fx II family addresses each block by its
 * 14-bit \`effectId\` in the GET/SET_BLOCK_PARAMETER_VALUE message
 * (function \`0x02\`). Multiple instances of the same block group
 * (e.g. Amp 1 + Amp 2) have distinct ids but share the parameter
 * table — see \`KNOWN_PARAMS\` in \`./params.ts\`, keyed by group code.
 *
 * **DO NOT EDIT BY HAND** — regenerate via:
 *   npx tsx scripts/extract-axe-fx-ii-params.ts
 *
 * Status: 🟡 wiki-documented, not yet hardware-verified on Q8.02.
 * The factory bank file's preset chunks reference these block IDs
 * indirectly; live capture (HW-074) would promote to 🟢.
 */

export interface AxeFxIIBlock {
    /** 14-bit \`effectId\` used in GET/SET_BLOCK_PARAMETER_VALUE. */
    readonly id: number;
    /** Display name (e.g. "Amp 1", "Reverb 2"). */
    readonly name: string;
    /** 3-letter group code shared by all instances (e.g. "AMP"). */
    readonly groupCode: string;
    /** Whether the block exposes a bypass toggle. */
    readonly canBypass: boolean;
    /** Whether the AX8 floorboard exposes this block. */
    readonly availableOnAX8: boolean;
}

export const AXE_FX_II_BLOCKS: readonly AxeFxIIBlock[] = [
${entries}
] as const;

/** Reverse lookup: effectId → block. */
export const BLOCK_BY_ID: Readonly<Record<number, AxeFxIIBlock>> =
    Object.freeze(Object.fromEntries(AXE_FX_II_BLOCKS.map((b) => [b.id, b])));

/** Group code → list of effectIds (in order). e.g. AMP → [106, 107]. */
export const IDS_BY_GROUP: Readonly<Record<string, readonly number[]>> = (() => {
    const out: Record<string, number[]> = {};
    for (const b of AXE_FX_II_BLOCKS) {
        (out[b.groupCode] ??= []).push(b.id);
    }
    return Object.freeze(
        Object.fromEntries(
            Object.entries(out).map(([k, v]) => [k, Object.freeze(v.slice())]),
        ),
    );
})();

/** Block name (e.g. "Amp 1") → block. Case-insensitive. */
const NAMES_BY_LOWER: Record<string, AxeFxIIBlock> = Object.fromEntries(
    AXE_FX_II_BLOCKS.map((b) => [b.name.toLowerCase(), b]),
);

/** Resolve a user-supplied block reference (id or name) to its block. */
export function resolveBlock(input: string | number): AxeFxIIBlock | undefined {
    if (typeof input === 'number') return BLOCK_BY_ID[input];
    return NAMES_BY_LOWER[input.trim().toLowerCase()];
}
`;
}

// ── Emit params.ts ────────────────────────────────────────────────────

function emitParams(): string {
    const byBlock = new Map<string, JoinedParam[]>();
    for (const p of allParams) {
        if (!(p.groupCode in WIKI_TO_XML)) continue;
        const xmlName = WIKI_TO_XML[p.groupCode];
        const slug = blockSlug(xmlName, p.groupCode);
        if (!byBlock.has(slug)) byBlock.set(slug, []);
        byBlock.get(slug)!.push(p);
    }

    // Build entries deterministically: block alphabetic, paramId asc.
    const blocks = Array.from(byBlock.keys()).sort();
    const lines: string[] = [];
    const enumDecls: string[] = [];
    let totalEntries = 0;
    let totalEnumEntries = 0;

    for (const block of blocks) {
        const rows = byBlock.get(block)!.slice().sort((a, b) => a.paramId - b.paramId);
        // Deduplicate: same paramId can occur with different snake names
        // when the wiki repeats due to formatting; keep first occurrence.
        const seenParamIds = new Set<number>();
        const seenKeys = new Set<string>();
        for (const r of rows) {
            if (seenParamIds.has(r.paramId)) continue;
            seenParamIds.add(r.paramId);

            const baseKey = snakeCase(r.name);
            if (!baseKey) continue;
            const fullKey = `${block}.${baseKey}`;
            if (seenKeys.has(fullKey)) continue;
            seenKeys.add(fullKey);

            const props: string[] = [];
            props.push(`groupCode: ${JSON.stringify(r.groupCode)}`);
            props.push(`block: ${JSON.stringify(block)}`);
            props.push(`paramId: ${r.paramId}`);
            props.push(`wikiName: ${JSON.stringify(r.name)}`);
            props.push(`name: ${JSON.stringify(baseKey)}`);
            props.push(`controlType: ${JSON.stringify(r.type)}`);

            if (r.parameterName) props.push(`parameterName: ${JSON.stringify(r.parameterName)}`);
            if (r.xmlLabel) props.push(`xmlLabel: ${JSON.stringify(r.xmlLabel)}`);

            const overrideKey = `${block}.${r.paramId}`;
            const override = HARDWARE_OVERRIDES[overrideKey];

            if (override?.enumValuesRef === 'DELAY_TEMPO_VALUES') {
                // Hardware-measured enum (HW-091/HW-093). The const itself
                // is emitted by the alphabetic-position-injection pass
                // below (see `injectDelayTempoConstAtAlphabeticPosition`)
                // so it lands between DELAY_LFO1_DEPTH_RANGE_VALUES and
                // DRIVE_EFFECT_TYPE_VALUES in the enumDecls output.
                props.push(`enumValues: ${override.enumValuesRef}`);
            } else if (r.type === 'select' && r.options.length > 0) {
                const enumName = `${block.toUpperCase()}_${baseKey.toUpperCase()}_VALUES`;
                // Apply per-(block, paramId, wireIndex) ASCII label
                // overrides from hardware-captured fn 0x28 dumps. The
                // wiki MIDI_SysEx page carries a handful of transcription
                // errors; the device's emitted label is the truth.
                const labelOverrides = new Map<number, EnumLabelOverride>();
                for (const ov of ENUM_VALUE_OVERRIDES) {
                    if (ov.block === block && ov.paramId === r.paramId) {
                        labelOverrides.set(ov.wireIndex, ov);
                    }
                }
                enumDecls.push(
                    `export const ${enumName}: Readonly<Record<number, string>> = Object.freeze({\n` +
                    r.options.map((o) => {
                        const ov = labelOverrides.get(o.index);
                        const label = ov ? ov.hardwareLabel : o.name;
                        const trailer = ov
                            ? `  // hw fn 0x28 override (was ${JSON.stringify(ov.wikiLabel)}): ${ov.note}`
                            : '';
                        return `    ${o.index}: ${JSON.stringify(label)},${trailer}`;
                    }).join('\n') +
                    `\n});`,
                );
                props.push(`enumValues: ${enumName}`);
                totalEnumEntries += r.options.length;
            }

            const trimmedMin = r.min?.trim();
            const trimmedMax = r.max?.trim();
            const trimmedStep = r.step?.trim();
            // Wiki-derived ranges first (legacy order). Override values
            // are emitted at end-of-entry (after modifierAssignable +
            // gates) to match the shipping hand-curated entry shape —
            // see HARDWARE_OVERRIDES above.
            if (!override?.displayMin && trimmedMin && Number.isFinite(Number(trimmedMin)))
                props.push(`displayMin: ${Number(trimmedMin)}`);
            if (!override?.displayMax && trimmedMax && Number.isFinite(Number(trimmedMax)))
                props.push(`displayMax: ${Number(trimmedMax)}`);
            if (!override?.step && trimmedStep && Number.isFinite(Number(trimmedStep)))
                props.push(`step: ${Number(trimmedStep)}`);

            if (r.modifierAssignable) props.push(`modifierAssignable: true`);
            if (r.fwAdded) props.push(`fwAdded: ${JSON.stringify(r.fwAdded)}`);
            if (r.controllingParamName) props.push(`gateOn: ${JSON.stringify(r.controllingParamName)}`);
            if (r.controllingParamValue) props.push(`gateValues: ${JSON.stringify(r.controllingParamValue)}`);

            // Hardware-override fields emit at end-of-entry. Matches the
            // shipping shape where hand-edits appended displayMin/Max
            // after the existing wiki + XML fields.
            if (override?.displayMin !== undefined) props.push(`displayMin: ${override.displayMin}`);
            if (override?.displayMax !== undefined) props.push(`displayMax: ${override.displayMax}`);
            if (override?.step !== undefined) props.push(`step: ${override.step}`);
            if (override?.displayScale) props.push(`displayScale: '${override.displayScale}'`);

            // Emit leading provenance comment for hand-curated entries
            // (HW-079 / HW-088 / HW-089 / HW-090 / HW-091 / HW-092 /
            // HW-093 / Session 68). Multi-line comments preserve the
            // measurement context across regens.
            if (override?.comment) {
                for (const line of override.comment.split('\n')) {
                    lines.push(`    // ${line}`);
                }
            }
            lines.push(`    ${JSON.stringify(fullKey)}: { ${props.join(', ')} },`);
            totalEntries++;
        }
    }

    // Inject the hardware-measured DELAY_TEMPO_VALUES const into the
    // wiki-derived enumDecls in alphabetic position (between
    // DELAY_LFO1_DEPTH_RANGE_VALUES and DRIVE_EFFECT_TYPE_VALUES, per
    // the shipping file's ordering). The const + its docstring are
    // baked into the generator from DELAY_TEMPO_VALUES_DATA.
    if (HARDWARE_OVERRIDES['delay.9']?.enumValuesRef === 'DELAY_TEMPO_VALUES') {
        const delayTempoConstText =
            '/**\n' +
            ' * Delay tempo-sync division enum — hardware-measured 2026-05-11 via\n' +
            ' * HW-091 (wire 0..8) and HW-093 (wire 9..32). Wire 33+ not yet\n' +
            ' * probed; the device likely saturates at wire 32 or rejects further.\n' +
            ' *\n' +
            ' * Pattern: wire 0 = NONE (disables sync); wires 1..21 are the\n' +
            ' * canonical musical-division ladder TRIP/straight/DOT in increasing\n' +
            ' * note-value; wires 22..24 are integer bar multiples; wires 25..26\n' +
            ' * are polymeter ratios (4/3, 5/4); wires 27..32 are odd-numerator\n' +
            ' * 64th-note ratios where 10/64 is parens-displayed as (5/32) — the\n' +
            ' * Axe-Fx II firmware\'s "reduced fraction" convention (parens =\n' +
            ' * computed value, same convention as tempo-gated `(375 ms)` on\n' +
            ' * delay.time).\n' +
            ' */\n' +
            'export const DELAY_TEMPO_VALUES: Readonly<Record<number, string>> = Object.freeze({\n' +
            DELAY_TEMPO_VALUES_DATA.map(
                ([wire, label]) => `    ${wire}: ${JSON.stringify(label)},`,
            ).join('\n') +
            '\n});';
        // Splice in after the last DELAY_*_VALUES const, before the
        // first DRIVE_*_VALUES const. enumDecls is appended in entry-
        // emit order, so we find the splice index by scanning for the
        // DELAY→DRIVE family transition.
        let spliceIdx = enumDecls.findIndex(
            (d) => /export const DRIVE_/.test(d),
        );
        if (spliceIdx < 0) spliceIdx = enumDecls.length; // append fallback
        enumDecls.splice(spliceIdx, 0, delayTempoConstText);
        totalEnumEntries += DELAY_TEMPO_VALUES_DATA.length;
    }

    return `/**
 * Axe-Fx II parameter registry (generated).
 *
 * Each entry describes one addressable parameter on the Axe-Fx II
 * family. Wire-side identity is \`(effectId, paramId)\` — \`paramId\` is
 * shared across every block instance in the same group (e.g. Amp 1 and
 * Amp 2 both expose \`paramId: 1\` for INPUT DRIVE), so the registry is
 * keyed by group + parameter, with \`effectId\` resolved at the tool
 * boundary via \`./blockTypes.ts\` \`IDS_BY_GROUP\`.
 *
 * Sources joined:
 *   • Fractal Audio Wiki "MIDI_SysEx" — wire-IDs + UPPERCASE name +
 *     control type + enum options + min/max/step (where present).
 *     Cached at \`docs/_private/wiki-cache/axe-fx-ii-midi-sysex.html\`.
 *   • Axe-Edit \`__block_layout.xml\` — symbolic \`parameterName\` (e.g.
 *     \`DISTORT_DRIVE\`) + Title-Case UI label + type-applicability
 *     gates. Catalogued at
 *     \`samples/captured/decoded/labels/axe-edit-catalog.json\`.
 *
 * **DO NOT EDIT BY HAND** — regenerate via:
 *   npx tsx scripts/extract-axe-fx-ii-params.ts
 *
 * Status: 🟡 wiki-documented, not yet hardware-verified on Quantum 8.02.
 * Wiki min/max/step are populated only for the subset of params the
 * wiki documents — most knobs are blank in the wiki and need hardware
 * spotchecks to anchor display ranges. Until then, encoders should
 * treat absent ranges as "wire 0..65534, display unknown" and pass
 * the value through verbatim.
 *
 * Wire encoding (per wiki "MIDI SysEx: obtaining parameter values"):
 *   value range  : 0..65534 integer
 *   3-septet pack: [bits 6-0, bits 13-7, bits 14-15 in low 2 bits]
 *
 * Reference encoder lives in \`./setParam.ts\` (TBD when the encoder
 * lands in the multi-vendor refactor).
 */

export type AxeFxIIControlType = 'knob' | 'select' | 'switch' | 'unknown';

export interface AxeFxIIParam {
    /** Wiki block group (e.g. "AMP", "CPR", "GEQ"). */
    readonly groupCode: string;
    /** Block slug used in the registry key (e.g. "amp", "compressor"). */
    readonly block: string;
    /** Wire-side \`paramId\` within the block (0..255). */
    readonly paramId: number;
    /** Wiki "Name" column (UPPERCASE, e.g. "INPUT DRIVE"). */
    readonly wikiName: string;
    /** Snake-case key matching the registry suffix. */
    readonly name: string;
    /** Wiki control type. */
    readonly controlType: AxeFxIIControlType;
    /** Axe-Edit XML symbolic name when matched (e.g. "DISTORT_DRIVE"). */
    readonly parameterName?: string;
    /** Axe-Edit XML UI label when matched (e.g. "Input Drive"). */
    readonly xmlLabel?: string;
    /** Enum values for \`select\` controls (wire int → display name). */
    readonly enumValues?: Readonly<Record<number, string>>;
    /** Display min from wiki (when populated). */
    readonly displayMin?: number;
    /** Display max from wiki (when populated). */
    readonly displayMax?: number;
    /** Display step from wiki (when populated). */
    readonly step?: number;
    /**
     * Scale shape mapping wire 0..65534 to displayMin..displayMax.
     * Defaults to \`'linear'\` when omitted. \`'log10'\` is for frequency
     * knobs and similar log-perceptual scales (confirmed for Axe-Fx II
     * cab/amp filter frequencies via HW-090, 2026-05-11). Requires
     * positive displayMin/displayMax.
     */
    readonly displayScale?: 'linear' | 'log10';
    /** Whether a modifier can target this param. */
    readonly modifierAssignable?: boolean;
    /** Firmware version that introduced this param. */
    readonly fwAdded?: string;
    /** XML applicability gate: which other parameter controls visibility. */
    readonly gateOn?: string;
    /** XML gate values (comma-separated string of variant indices). */
    readonly gateValues?: string;
}

${enumDecls.join('\n\n')}

export const KNOWN_PARAMS = {
${lines.join('\n')}
} as const satisfies Readonly<Record<string, AxeFxIIParam>>;

export type AxeFxIIParamKey = keyof typeof KNOWN_PARAMS;

/** Extraction summary (refresh by re-running the generator). */
export const REGISTRY_STATS = Object.freeze({
    totalParams: ${totalEntries},
    totalEnumEntries: ${totalEnumEntries},
});
`;
}

// ── Persist ───────────────────────────────────────────────────────────

mkdirSync(FRACTAL_MIDI_AXEFX2_SRC, { recursive: true });
mkdirSync('samples/captured/decoded/labels', { recursive: true });

// Splice the preserved Status: paragraph from each existing file
// (when present) so the hardware-verified promotion the founder
// applied after HW-075/HW-076/HW-077 survives the regen. Applied
// independently to params.ts and blockTypes.ts because each carries
// its own status note (HW-075/HW-077 promoted params.ts; HW-076
// promoted blockTypes.ts). First-run or fresh-worktree case (no file
// on disk) leaves the default 🟡 string in place — that's correct
// behaviour, nothing to preserve.
const PRESERVED_BLOCKTYPES_STATUS = readPreservedStatusBlock(OUT_BLOCKTYPES_TS);
const PRESERVED_PARAMS_STATUS = readPreservedStatusBlock(OUT_PARAMS_TS);
const PRESERVED_PARAMS_ADDENDUM = readPreservedAddendumBlock(OUT_PARAMS_TS);
writeFileSync(OUT_BLOCKTYPES_TS, applyStatusPreservation(emitBlockTypes(), PRESERVED_BLOCKTYPES_STATUS), 'utf8');
writeFileSync(
    OUT_PARAMS_TS,
    applyAddendumPreservation(
        applyStatusPreservation(emitParams(), PRESERVED_PARAMS_STATUS),
        PRESERVED_PARAMS_ADDENDUM,
    ),
    'utf8',
);
writeFileSync(
    OUT_DEBUG_JSON,
    JSON.stringify(
        {
            extractedAt: new Date().toISOString(),
            blockCount: blockIds.length,
            paramCount: allParams.length,
            groupSummary,
            blockIds,
            params: allParams,
        },
        null,
        2,
    ),
    'utf8',
);

// ── Stdout report ─────────────────────────────────────────────────────

const matched = allParams.filter((p) => p.parameterName).length;
const total = allParams.length;
const matchPct = total === 0 ? 0 : ((matched / total) * 100).toFixed(1);

console.log(`extract-axe-fx-ii-params: parsed ${blockIds.length} block IDs, ${total} parameters across ${Object.keys(groupSummary).length} groups.`);
console.log(`  XML join: ${matched}/${total} matched (${matchPct}%).`);
console.log(`  output: ${OUT_BLOCKTYPES_TS}`);
console.log(`  output: ${OUT_PARAMS_TS}`);
console.log(`  output: ${OUT_DEBUG_JSON}`);

const sortedGroups = Object.keys(groupSummary).sort();
console.log(`  per-group rows / matched:`);
for (const g of sortedGroups) {
    const s = groupSummary[g];
    console.log(`    ${g.padEnd(12)} ${String(s.rows).padStart(4)} rows, ${String(s.matched).padStart(4)} matched`);
}
