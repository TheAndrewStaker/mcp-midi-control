/**
 * Bundled EMPTY gen-3 preset templates (zero grid, zero blocks, no
 * modifiers, preset name "<EMPTY>"), already addressed to the edit buffer
 * (`7F 7F`). A clean slate to load before building a preset, or to author a
 * whole preset body against.
 *
 * Source: fractone (GreyManSoftware, MIT License; copyright notice and licence
 * text in assets/empty-presets/LICENSE-fractone.txt), files
 * Presets/gen3-{fm9-12.00,fm3-13.00,axe3-32.06}-empty.syx at fractone commit
 * cb2d0b9. Copied byte for byte; the SHA-256 of each is pinned below and
 * checked on load.
 *
 * Evidence: each parses as a valid dump of its model (every frame checksum,
 * the raw-patch CRC and the footer XOR valid) and decodes to an empty grid
 * with no blocks (scripts/verify-gen3-edit-buffer-write.ts). All three are
 * fractone's PROBE empty templates: the FM9 one (fw 12.00) is what fractone's
 * FM9 hardware probes load (fractone's production FM9 builds start from a
 * different baseline, Presets/EMPTY.syx); the FM3 and Axe-Fx III ones have no
 * hardware load report (fractone calls FM3 / III presets an unverified beta).
 * None has been loaded by us. An empty preset has NO Input or Output block,
 * so it passes no audio until a chain is placed.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parsePresetDump } from './presetDump.js';
import type { ParsedPresetDump } from './presetDump.js';

export interface EmptyPresetTemplateInfo {
  modelId: number;
  device: string;
  file: string;
  firmware: string;
  sha256: string;
  /** 'fm9-fractone-probe': fractone's FM9 fw 12 probe template (hardware-loaded by fractone's probes, not by us). */
  evidence: 'fm9-fractone-probe' | 'unverified';
}

export const EMPTY_PRESET_TEMPLATES: Readonly<Record<number, EmptyPresetTemplateInfo>> = {
  0x12: {
    modelId: 0x12,
    device: 'FM9',
    file: 'gen3-fm9-12.00-empty.syx',
    firmware: '12.00',
    sha256: '735f66305caf79e5708a96fbace2640af3d0d36eaedfacf724ce77f38413c405',
    evidence: 'fm9-fractone-probe',
  },
  0x11: {
    modelId: 0x11,
    device: 'FM3',
    file: 'gen3-fm3-13.00-empty.syx',
    firmware: '13.00',
    sha256: 'acf979fda7a3450efb33243a7685c05b5f415ab61da463ec0f118f526444dfcb',
    evidence: 'unverified',
  },
  0x10: {
    modelId: 0x10,
    device: 'Axe-Fx III',
    file: 'gen3-axe3-32.06-empty.syx',
    firmware: '32.06',
    sha256: '860e5b83e2877fc210fa04fa5d37db6f9d3aeb4a4fb68c8da808217703de229d',
    evidence: 'unverified',
  },
};

/** The raw template bytes for `modelId`, SHA-256 checked. Throws for VP4 / unknown models. */
export function readEmptyPresetTemplateBytes(modelId: number): Uint8Array {
  const info = EMPTY_PRESET_TEMPLATES[modelId];
  if (!info) throw new Error(`no empty preset template for model 0x${modelId.toString(16)}`);
  // Resolves to src/assets when run from source, dist/assets once built
  // (scripts/copy-build-assets.ts mirrors the directory).
  const bytes = new Uint8Array(readFileSync(new URL(`./assets/empty-presets/${info.file}`, import.meta.url)));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== info.sha256) {
    throw new Error(`empty preset template ${info.file} is corrupt (sha256 ${digest}, expected ${info.sha256})`);
  }
  return bytes;
}

/** The parsed empty template for `modelId` (edit-buffer addressed). */
export function loadEmptyPresetTemplate(modelId: number): { info: EmptyPresetTemplateInfo; dump: ParsedPresetDump } {
  const bytes = readEmptyPresetTemplateBytes(modelId);
  return { info: EMPTY_PRESET_TEMPLATES[modelId], dump: parsePresetDump(bytes, 0, modelId) };
}
