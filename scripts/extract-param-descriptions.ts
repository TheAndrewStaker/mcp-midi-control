/**
 * Maintainer-time extractor for `param-descriptions.json`.
 *
 * Walks the Fractal Audio Blocks Guide (`docs/manuals/`) plus the
 * AM4 / Axe-Fx II / Axe-Fx III Owner's Manuals (.txt extractions
 * under `docs/devices/<device>/manuals/`), regex-scrapes
 * `Param Name <delim> description...` pairs, and joins them against
 * each device descriptor's blocks + params catalog to produce a
 * (device, block, param) -> short prose excerpt lookup.
 *
 * The output (`packages/core/src/protocol-generic/param-descriptions.json`)
 * is committed and bundled with the release. The runtime tool surface
 * (unified `list_params(include_descriptions: true)` and
 * `get_param(include_description: true)`) reads it via the helper in
 * `packages/core/src/protocol-generic/param-descriptions.ts`.
 *
 * Regenerating committed extractor output: per the CONTRIBUTING.md
 * convention, contributors who change this extractor commit the
 * regenerated JSON in the same PR. The script is idempotent (sorted
 * keys, deterministic order) — re-running with the same source
 * manuals produces a byte-identical JSON file.
 *
 * Run:
 *   npm run extract-param-descriptions
 *
 * Coverage policy: quality over coverage. When the join is ambiguous
 * (a label like "Mix" / "Level" / "Type" appears under multiple
 * blocks), the most-recent section header in the source manual wins
 * for that block's entry. When a label isn't reliably joinable to a
 * descriptor param, it's dropped — the tool layer omits descriptions
 * for params not in this file (the response field is absent, not an
 * empty string) so the agent never reads "Description: " followed by
 * nothing.
 *
 * Source text is verbatim from the manuals (short factual quotes —
 * fair-use derivative). No LLM rephrasing. Em dashes in the source
 * are normalized to ", " during extraction so the committed JSON is
 * dash-clean per the project style rule.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/axe-fx-ii/descriptor.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/axe-fx-iii/device.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';
import type { DeviceDescriptor } from '@mcp-midi-control/core/protocol-generic/types.js';

// ── Paths ───────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MANUALS = path.join(ROOT, 'docs', 'manuals');
const DEVICES = path.join(ROOT, 'docs', 'devices');
const OUT = path.join(
  ROOT,
  'packages',
  'core',
  'src',
  'protocol-generic',
  'param-descriptions.json',
);

// ── Source files ────────────────────────────────────────────────────
//
// Each file gets walked once; the Blocks Guide is shared across every
// device (cross-Fractal), the per-device Owner's Manuals add device-
// specific knobs the Blocks Guide doesn't cover.

interface ManualSource {
  /** Display label used in the verbose log. */
  label: string;
  /** Absolute path to the .txt extraction. */
  file: string;
  /**
   * Which device IDs should receive this manual's content. Blocks
   * Guide content fans out to every Fractal device (cross-device
   * prose); Owner's Manual content only attaches to its own device.
   */
  applyTo: readonly string[];
}

const SOURCES: readonly ManualSource[] = [
  {
    label: 'Blocks Guide',
    file: path.join(MANUALS, 'Fractal-Audio-Blocks-Guide.txt'),
    applyTo: ['am4', 'axe-fx-ii', 'axe-fx-iii'],
  },
  {
    label: 'AM4 Owner\'s Manual',
    file: path.join(DEVICES, 'am4', 'manuals', 'AM4-Owners-Manual.txt'),
    applyTo: ['am4'],
  },
  {
    label: 'Axe-Fx II Owner\'s Manual',
    file: path.join(DEVICES, 'axe-fx-ii', 'manuals', 'Axe-Fx-II-Owners-Manual.txt'),
    applyTo: ['axe-fx-ii'],
  },
  {
    label: 'Axe-Fx III Owner\'s Manual',
    file: path.join(DEVICES, 'axe-fx-iii', 'manuals', 'Axe-Fx-III-Owners-Manual.txt'),
    applyTo: ['axe-fx-iii'],
  },
];

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * The PDF extraction (pdftotext) lost the original em-dash byte and
 * replaced it with the Unicode replacement char U+FFFD. That's the
 * separator between the param name and its description across most
 * of the manuals. The Axe-Fx III Owner's Manual ships with the
 * separator as a literal ASCII `--` instead. Match either form.
 */
const MARKER_RE = /^([A-Z][A-Za-z0-9 ,/\-&'()]*?)\s(?:�|--)\s(.*)$/;

const SECTION_RE = /^THE ([A-Z][A-Z /\-]+?) BLOCK(?:\s+[A-Z]{2,5})?$/;

/**
 * Fractal section headers map to canonical block-name slugs the way
 * each device descriptor exposes them. The Blocks Guide groups
 * sections by spelled-out display names; the descriptors key on
 * lowercased slugs. Keep this map in lockstep with the descriptors'
 * block keys; new sections without a mapping silently no-op (the
 * scrape just won't attribute params to that block).
 */
const SECTION_TO_BLOCK: Readonly<Record<string, string>> = {
  AMP: 'amp',
  CAB: 'cab',
  CHORUS: 'chorus',
  COMPRESSOR: 'compressor',
  CROSSOVER: 'crossover',
  DELAY: 'delay',
  DRIVE: 'drive',
  ENHANCER: 'enhancer',
  FILTER: 'filter',
  FLANGER: 'flanger',
  FORMANT: 'formant',
  'GATE/EXPANDER': 'gate',
  'GRAPHIC EQ': 'graphic_eq',
  LOOPER: 'looper',
  MEGATAP: 'megatap',
  MIXER: 'mixer',
  'MULTIBAND COMPRESSOR': 'multiband_compressor',
  'MULTITAP DELAY': 'multitap',
  'PARAMETRIC EQ': 'parametric_eq',
  PHASER: 'phaser',
  PITCH: 'pitch',
  'PLEX DELAY': 'plex_delay',
  REVERB: 'reverb',
  'RING MODULATOR': 'ring_modulator',
  ROTARY: 'rotary',
  'SCENE MIDI': 'scene_midi',
  SEND: 'send',
  RETURN: 'return',
  'TREMOLO/PANNER': 'tremolo',
  'VOLUME/PAN': 'volume',
  WAHWAH: 'wah',
  SYNTH: 'synth',
  VOCODER: 'vocoder',
  RESONATOR: 'resonator',
};

/**
 * Per-device alias map for section-name -> block-id when a device's
 * block slug differs from the canonical SECTION_TO_BLOCK target above.
 * Empty for now; populated only if a device descriptor disagrees with
 * the Blocks Guide spelling.
 */
const DEVICE_BLOCK_ALIASES: Readonly<Record<string, Record<string, string>>> = {
  am4: {
    // AM4 uses "amp", "cab", "drive", "chorus", "delay", "reverb",
    // "phaser", "flanger", "filter" etc. matching the canonical names.
  },
  'axe-fx-ii': {},
  'axe-fx-iii': {},
  hydrasynth: {},
};

function isSentenceEnd(text: string): boolean {
  return /[.!?][\)\"']?\s*$/.test(text);
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Normalize Unicode em / en dashes and the U+FFFD replacement char (a
 * common pdftotext artifact) to ASCII commas so the committed JSON is
 * dash-clean per the project style rule. Also collapses leftover
 * whitespace runs and strips trailing junk.
 */
function cleanDescription(text: string): string {
  return text
    // Unicode dashes inside descriptions -> comma + space
    .replace(/[–—]/g, ', ')
    // Stray PDF replacement chars
    .replace(/�/g, ',')
    // ASCII double dash (em dash substitute used inline by some
    // manuals, e.g. "phase shifting circuits--or stages--in")
    .replace(/\s*--\s*/g, ', ')
    // Collapse multi-space runs
    .replace(/\s+/g, ' ')
    .trim()
    // Drop trailing comma artifact from earlier replacements
    .replace(/,\s*$/, '')
    .trim();
}

/**
 * The pdftotext layout output preserves two-column page structure.
 * The marker regex would otherwise mix left-column and right-column
 * content. To isolate, we pre-pass the stream and emit two virtual
 * streams: left-column lines (in order) followed by right-column lines
 * (in order). Markers + continuation are then scanned within each
 * stream. A line without a wide-gap is left-only; right is "".
 */
function splitColumns(raw: string): string[] {
  const lines = raw.split(/\r?\n/);
  const left: string[] = [];
  const right: string[] = [];
  for (const l of lines) {
    const m = l.match(/^(.{1,90}?\S)\s{6,}(\S.*)$/);
    if (m) {
      left.push(m[1]);
      right.push(m[2]);
    } else {
      left.push(l);
      right.push('');
    }
  }
  // Concatenate left then right — markers reset state per stream-half.
  return [...left, '', ...right];
}

// ── Extractor ───────────────────────────────────────────────────────

interface RawDescription {
  block: string;             // canonical block slug per SECTION_TO_BLOCK
  paramLabel: string;        // raw label from the manual ("Master Volume")
  description: string;
  /** Source label for the verbose log. */
  source: string;
}

function extractFromManual(filePath: string, label: string): RawDescription[] {
  const raw = readFileSync(filePath, 'utf8');
  const stream = splitColumns(raw);

  const out: RawDescription[] = [];
  let currentBlock: string | undefined;

  for (let i = 0; i < stream.length; i++) {
    const line = stream[i];
    const trimmed = line.trim();

    // Section header — update the current-block context.
    const sec = trimmed.match(SECTION_RE);
    if (sec) {
      const name = sec[1].trim().toUpperCase();
      currentBlock = SECTION_TO_BLOCK[name];
      continue;
    }

    // Param marker — start capturing.
    const m = line.match(MARKER_RE);
    if (!m) continue;
    if (!currentBlock) continue;          // marker before any section
    const label0 = m[1].trim();
    let desc = m[2].trim();

    // Append continuation lines until first sentence end OR another
    // marker OR section boundary OR a hard cap on length.
    let j = i + 1;
    while (j < stream.length && !isSentenceEnd(desc) && desc.length < 400) {
      const next = stream[j];
      const ntrim = next.trim();
      if (!ntrim) break;
      if (SECTION_RE.test(ntrim)) break;
      if (MARKER_RE.test(next)) break;
      // Skip pure page-header junk (running page title, page number).
      if (/^FRACTAL AUDIO BLOCKS GUIDE/.test(ntrim)) { j++; continue; }
      if (/^\d+$/.test(ntrim)) { j++; continue; }
      desc += ' ' + ntrim;
      j++;
    }

    const cleaned = cleanDescription(desc);
    if (cleaned.length < 10) continue;     // junk match

    out.push({
      block: currentBlock,
      paramLabel: label0,
      description: cleaned,
      source: label,
    });
  }

  return out;
}

// ── Join against device descriptors ─────────────────────────────────

interface ParamRef {
  block: string;
  name: string;
  descriptor: DeviceDescriptor;
  /** Searchable normalized labels (display_name, host_label, snake_case name). */
  matchKeys: string[];
}

function collectParamRefs(desc: DeviceDescriptor): ParamRef[] {
  const refs: ParamRef[] = [];
  for (const [block, schema] of Object.entries(desc.blocks)) {
    for (const [name, param] of Object.entries(schema.params)) {
      const keys = new Set<string>();
      keys.add(normalizeName(name));
      keys.add(normalizeName(param.display_name));
      if (param.host_label) keys.add(normalizeName(param.host_label));
      refs.push({
        block,
        name,
        descriptor: desc,
        matchKeys: [...keys],
      });
    }
  }
  return refs;
}

interface OutputShape {
  [deviceId: string]: {
    [blockSlug: string]: {
      [paramName: string]: string;
    };
  };
}

/**
 * Sort an object's keys deterministically — used to ensure idempotence.
 */
function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

function deepSort(obj: OutputShape): OutputShape {
  const sorted: OutputShape = {};
  for (const dev of Object.keys(obj).sort()) {
    sorted[dev] = {};
    for (const block of Object.keys(obj[dev]).sort()) {
      sorted[dev][block] = sortKeys(obj[dev][block]);
    }
  }
  return sorted;
}

// ── Main ────────────────────────────────────────────────────────────

const DEVICES: readonly DeviceDescriptor[] = [
  AM4_DESCRIPTOR,
  AXEFX2_DESCRIPTOR,
  AXEFX3_DESCRIPTOR,
  HYDRASYNTH_DESCRIPTOR,
];

function main(): void {
  console.log('extract-param-descriptions: scanning manuals...');

  // 1. Pull all raw (block, paramLabel, description) tuples per source.
  const rawByApply: Record<string, RawDescription[]> = {};
  for (const src of SOURCES) {
    const tuples = extractFromManual(src.file, src.label);
    console.log(`  ${src.label}: ${tuples.length} candidate tuples`);
    for (const id of src.applyTo) {
      rawByApply[id] ??= [];
      rawByApply[id].push(...tuples);
    }
  }

  // 2. Per-device join: for each device descriptor, walk its (block,
  //    param) tuples and try to find a matching raw description.
  const out: OutputShape = {};
  for (const dev of DEVICES) {
    out[dev.id] = {};
    const rawList = rawByApply[dev.id] ?? [];

    // Index by (block, normalizedLabel) -> description. When the same
    // label appears under multiple blocks (Tone, Level, Mix), each
    // block gets its own entry, so the per-block keying disambiguates.
    const lookup = new Map<string, string>();
    for (const r of rawList) {
      const key = `${r.block}::${normalizeName(r.paramLabel)}`;
      // First-wins: earlier sources / earlier sections take priority.
      if (!lookup.has(key)) lookup.set(key, r.description);
    }

    const refs = collectParamRefs(dev);
    let matched = 0;
    for (const ref of refs) {
      // Block-aware exact match only. Cross-block fallback was
      // initially tempting (one Blocks Guide entry could fan out to
      // multiple devices' equivalent block) but in practice the same
      // common label ("Level", "Mix", "Type", "Mode") appears under
      // many sections, and a cross-block fallback collides them
      // (e.g. `amp.level` picks up the EQ-section "Level — A
      // duplicate control"). Drop the fallback. A param without an
      // exact (block::label) hit is omitted from the JSON; the tool
      // surface gracefully omits descriptions for params not in the
      // file.
      let found: string | undefined;
      for (const key of ref.matchKeys) {
        const full = `${ref.block}::${key}`;
        const v = lookup.get(full);
        if (v) { found = v; break; }
      }
      if (found) {
        out[dev.id][ref.block] ??= {};
        out[dev.id][ref.block][ref.name] = found;
        matched++;
      }
    }
    console.log(`  ${dev.display_name}: ${matched} param descriptions joined (across ${Object.keys(out[dev.id]).length} blocks)`);
  }

  // 3. Sort and write.
  const sorted = deepSort(out);
  const json = JSON.stringify(sorted, undefined, 2) + '\n';
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, json, 'utf8');

  const total = Object.values(sorted).reduce(
    (sum, blocks) =>
      sum +
      Object.values(blocks).reduce((bs, params) => bs + Object.keys(params).length, 0),
    0,
  );
  console.log(`extract-param-descriptions: wrote ${total} entries to ${path.relative(ROOT, OUT)}`);
}

main();
