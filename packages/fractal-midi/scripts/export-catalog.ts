/**
 * export-catalog.ts — generate the language-agnostic JSON catalog.
 *
 * Emits one JSON file per device under `catalog/`, mirroring the package's
 * own TypeScript data exports verbatim (same key names as the TS symbols).
 * The catalog is the consumption path for non-TypeScript users (Python
 * tooling, librarians, other codecs): pin the npm package or a git tag and
 * read the JSON instead of vendoring source files.
 *
 * The committed files are GENERATED — never hand-edit them. Preflight runs
 * `--check` (regenerate in memory, diff against disk) so the catalog can
 * never drift from the TypeScript source of truth.
 *
 * Shape contract: docs/CATALOG-SCHEMA.md. Bump `schema_version` there and
 * here together on any breaking shape change.
 *
 * Usage:
 *   tsx scripts/export-catalog.ts            # write catalog/*.json
 *   tsx scripts/export-catalog.ts --check    # verify committed files match
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KNOWN_PARAMS as AM4_KNOWN_PARAMS,
  PARAM_ALIASES as AM4_PARAM_ALIASES,
  BLOCK_TYPE_VALUES,
  BLOCK_NAMES_BY_VALUE,
  AMP_TYPES_VALUES,
  DRIVE_TYPES_VALUES,
  REVERB_TYPES_VALUES,
  DELAY_TYPES_VALUES,
  CHORUS_TYPES_VALUES,
  FLANGER_TYPES_VALUES,
  PHASER_TYPES_VALUES,
  WAH_TYPES_VALUES,
  COMPRESSOR_TYPES_VALUES,
  GEQ_TYPES_VALUES,
  FILTER_TYPES_VALUES,
  TREMOLO_TYPES_VALUES,
  ENHANCER_TYPES_VALUES,
  GATE_TYPES_VALUES,
  VOLPAN_MODES_VALUES,
  TEMPO_DIVISIONS_VALUES,
  LFO_WAVEFORMS_VALUES,
} from '../src/am4/index.js';
import {
  KNOWN_PARAMS as AXEFX2_KNOWN_PARAMS,
  AXE_FX_II_BLOCKS,
  PARAM_ALIASES_AXEFX2,
} from '../src/gen2/axe-fx-ii/index.js';
import {
  PARAMS as AXEFX3_PARAMS,
  AXE_FX_III_BLOCKS,
  GEN3_READ_ROSTERS,
} from '../src/gen3/axe-fx-iii/index.js';
import { FM3_PARAMS, FM3_RANGES } from '../src/gen3/fm3/index.js';
import {
  FM9_PARAMS,
  FM9_ENUM_OVERRIDES,
  FM9_RANGES,
} from '../src/gen3/fm9/index.js';
import {
  FM9_AMP_ROSTER,
  FM9_DRIVE_ROSTER,
  FM9_REVERB_TYPE_ROSTER,
} from '../src/gen3/fm9/rosters.generated.js';
import { VP4_PARAMS } from '../src/gen3/vp4/index.js';
import {
  KNOWN_PARAMS as GEN1_KNOWN_PARAMS,
  AXE_FX_GEN1_BLOCKS,
} from '../src/gen1/index.js';

const SCHEMA_VERSION = 1;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DIR = path.join(PACKAGE_ROOT, 'catalog');

interface DeviceCatalog {
  schema_version: number;
  device: string;
  model_byte: string;
  support_status: string;
  source: string;
  notes?: string[];
  data: Record<string, unknown>;
}

const GEN3_BLOCK_NOTE =
  'Gen-3 block effect IDs are family-shared: the block table lives in axe-fx-iii.json ' +
  '(AXE_FX_III_BLOCKS). paramIds are DEVICE-SPECIFIC — never reuse another gen-3 ' +
  "device's paramIds; always use this file's params for this device.";

const CATALOGS: DeviceCatalog[] = [
  {
    schema_version: SCHEMA_VERSION,
    device: 'am4',
    model_byte: '0x15',
    support_status: 'hardware-verified',
    source:
      'fractal-midi/src/am4 — AM4-Edit metadata cache + hardware captures; ' +
      'see docs/devices/am4/SYSEX-MAP.md',
    data: {
      KNOWN_PARAMS: AM4_KNOWN_PARAMS,
      PARAM_ALIASES: AM4_PARAM_ALIASES,
      BLOCK_TYPE_VALUES,
      BLOCK_NAMES_BY_VALUE,
      enums: {
        AMP_TYPES_VALUES,
        DRIVE_TYPES_VALUES,
        REVERB_TYPES_VALUES,
        DELAY_TYPES_VALUES,
        CHORUS_TYPES_VALUES,
        FLANGER_TYPES_VALUES,
        PHASER_TYPES_VALUES,
        WAH_TYPES_VALUES,
        COMPRESSOR_TYPES_VALUES,
        GEQ_TYPES_VALUES,
        FILTER_TYPES_VALUES,
        TREMOLO_TYPES_VALUES,
        ENHANCER_TYPES_VALUES,
        GATE_TYPES_VALUES,
        VOLPAN_MODES_VALUES,
        TEMPO_DIVISIONS_VALUES,
        LFO_WAVEFORMS_VALUES,
      },
    },
  },
  {
    schema_version: SCHEMA_VERSION,
    device: 'axe-fx-ii',
    model_byte: '0x07',
    support_status: 'hardware-verified (XL+, firmware Quantum 8.02)',
    source:
      'fractal-midi/src/gen2/axe-fx-ii — wiki SysEx tables + Axe-Edit __block_layout.xml + ' +
      'Ghidra param-table scan; enum values inline per param (enumValues)',
    data: {
      KNOWN_PARAMS: AXEFX2_KNOWN_PARAMS,
      AXE_FX_II_BLOCKS,
      PARAM_ALIASES_AXEFX2,
    },
  },
  {
    schema_version: SCHEMA_VERSION,
    device: 'axe-fx-iii',
    model_byte: '0x10',
    support_status: 'community-beta (decoded; hardware confirmations from community captures)',
    source:
      'fractal-midi/src/gen3/axe-fx-iii — Axe-Edit III binary mining + published v1.4 ' +
      'third-party MIDI spec + community captures',
    notes: [
      'AXE_FX_III_BLOCKS (effect IDs) is shared across the gen-3 family (III/FM3/FM9).',
      'GEN3_READ_ROSTERS maps enum ordinals to display names for set-by-name; the ' +
        'ordinal IS the wire set value (float32(ordinal)).',
    ],
    data: {
      PARAMS: AXEFX3_PARAMS,
      AXE_FX_III_BLOCKS,
      GEN3_READ_ROSTERS,
    },
  },
  {
    schema_version: SCHEMA_VERSION,
    device: 'fm3',
    model_byte: '0x11',
    support_status:
      'community-beta (device-true catalog; discrete set-by-name and striped read ' +
      'hardware-confirmed on FM3 by a community collaborator)',
    source:
      'fractal-midi/src/gen3/fm3 — mined from the FM3-Edit binary; paramIds are FM3-true, ' +
      'NOT reused from the Axe-Fx III',
    notes: [
      GEN3_BLOCK_NOTE,
      'FM3_RANGES carries device-true display ranges (display = value * scale), ' +
        'decoded from a device-synced FM3-Edit effectDefinitions cache (community-beta, ' +
        'hardware-unverified beyond the cache anchors). Generated by ' +
        'scripts/gen-fm3-ranges-from-cache.ts; gate scripts/verify-fm3-ranges.ts.',
      'Enum display names: resolve via axe-fx-iii.json GEN3_READ_ROSTERS ' +
        '(family-shared); no FM3-specific overrides exist yet.',
    ],
    data: {
      FM3_PARAMS,
      FM3_RANGES,
    },
  },
  {
    schema_version: SCHEMA_VERSION,
    device: 'fm9',
    model_byte: '0x12',
    support_status: 'community-beta (decoded from FM9-Edit cache + community captures)',
    source:
      'fractal-midi/src/gen3/fm9 — mined from the FM9-Edit binary + effectDefinitions cache; ' +
      'paramIds are FM9-true, NOT reused from the Axe-Fx III',
    notes: [
      GEN3_BLOCK_NOTE,
      'FM9_RANGES carries device-true display ranges (display = value * scale).',
      'Effective enum table per param = GEN3_READ_ROSTERS (axe-fx-iii.json, ' +
        'family-shared) overlaid by FM9_ENUM_OVERRIDES — the DEVICE override wins ' +
        'per ordinal where both define one.',
    ],
    data: {
      FM9_PARAMS,
      FM9_RANGES,
      FM9_ENUM_OVERRIDES,
      FM9_AMP_ROSTER,
      FM9_DRIVE_ROSTER,
      FM9_REVERB_TYPE_ROSTER,
    },
  },
  {
    schema_version: SCHEMA_VERSION,
    device: 'vp4',
    model_byte: '0x14',
    support_status:
      'community-beta (reads + continuous-knob writes decoded from community captures; ' +
      'display calibration pending — wire values pass through as raw 0..65534)',
    source:
      'fractal-midi/src/gen3/vp4 — mined from the VP4-Edit binary; paramIds are VP4-true, ' +
      'NOT reused from the Axe-Fx III',
    notes: ['VP4 is a serial 4-slot chain with no amp/cab blocks.'],
    data: {
      VP4_PARAMS,
    },
  },
  {
    schema_version: SCHEMA_VERSION,
    device: 'axe-fx-gen1',
    model_byte: '0x01',
    support_status:
      'community-beta (decoded byte-exactly from the published gen-1 SysEx spec; ' +
      'not hardware-verified; params with scaling "pending" require raw wire values)',
    source:
      'fractal-midi/src/gen1 — published "Axe-FX Ultra System Exclusive Messages" ' +
      'doc + its 0..255 conversion table',
    data: {
      KNOWN_PARAMS: GEN1_KNOWN_PARAMS,
      AXE_FX_GEN1_BLOCKS,
    },
  },
];

function renderIndex(): string {
  return serialize({
    schema_version: SCHEMA_VERSION,
    description:
      'Generated parameter/block/enum catalog for Fractal Audio devices. ' +
      'One file per device; keys under "data" mirror the same-named TypeScript ' +
      'exports in fractal-midi. See docs/CATALOG-SCHEMA.md. GENERATED — do not edit.',
    license: 'Apache-2.0 (see LICENSE and NOTICE at the package root)',
    devices: CATALOGS.map((c) => ({
      device: c.device,
      file: `${c.device}.json`,
      model_byte: c.model_byte,
      support_status: c.support_status,
    })),
  });
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  const files = new Map<string, string>();
  for (const cat of CATALOGS) files.set(`${cat.device}.json`, serialize(cat));
  files.set('index.json', renderIndex());

  if (checkMode) {
    const stale: string[] = [];
    for (const [name, expected] of files) {
      const target = path.join(CATALOG_DIR, name);
      const onDisk = fs.existsSync(target)
        ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
        : undefined;
      if (onDisk !== expected) stale.push(name);
    }
    // Orphan detection: a renamed/removed device must not leave a stale
    // committed JSON that ships to npm forever.
    if (fs.existsSync(CATALOG_DIR)) {
      for (const onDisk of fs.readdirSync(CATALOG_DIR)) {
        if (!files.has(onDisk)) stale.push(`${onDisk} (orphan — no generator produces it; delete it)`);
      }
    }
    if (stale.length > 0) {
      console.error(
        `catalog:check FAILED — ${stale.length} file(s) out of date with src/: ` +
          `${stale.join(', ')}\nRun: npm run catalog:export --workspace=fractal-midi`,
      );
      process.exit(1);
    }
    console.log(`catalog:check OK — ${files.size} files match the TypeScript source.`);
    return;
  }

  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  for (const [name, content] of files) {
    fs.writeFileSync(path.join(CATALOG_DIR, name), content, 'utf8');
    console.log(`wrote catalog/${name} (${(content.length / 1024).toFixed(0)} KB)`);
  }
}

main();
