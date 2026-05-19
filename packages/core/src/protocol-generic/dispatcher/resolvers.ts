/**
 * Step-3 + step-4 of the dispatcher lifecycle — name and value resolution.
 *
 * Family-agnostic helpers shared by every `execute*` tool wrapper:
 *   - `resolveBlockName` — block-name alias and canonical pass-through
 *   - `resolveParamName` — param-name alias + Levenshtein "did you mean" suggestions
 *   - `resolveChannel`   — channel-letter / index normalization
 *   - `encodeValue`      — display → wire conversion + error envelope
 *
 * Plus `encodeSetParam` — the pure-side full pipeline for `set_param` used
 * by `verify-dispatcher.ts` to assert byte-equivalence with the pre-
 * dispatcher legacy path.
 */

import {
  DispatchError,
  type DeviceDescriptor,
  type DispatchErrorDetails,
} from '../types.js';
import { resolveConceptKeyForBlock } from '../concept-keys.js';
import { resolveParamAlias } from '../cross-device-aliases.js';

import { requireDevice } from './core.js';
import {
  formatUnknownEnumError,
  formatUnknownParamError,
} from './errorFormat.js';

// ── Step 3a: block-name normalization ───────────────────────────────

export function resolveBlockName(
  descriptor: DeviceDescriptor,
  input: string,
): string {
  if (input in descriptor.blocks) return input;
  const aliased = descriptor.block_aliases?.[input];
  if (aliased !== undefined && aliased in descriptor.blocks) return aliased;
  const valid = Object.keys(descriptor.blocks);
  const sample = valid.slice(0, 8).join(', ');
  const details: DispatchErrorDetails = {
    valid_options: valid.length <= 8 ? valid : undefined,
    valid_options_tool: valid.length > 8 ? 'list_params(port)' : undefined,
    retry_action: valid.length > 8
      ? `Call list_params for the full block list on ${descriptor.display_name}.`
      : undefined,
  };
  throw new DispatchError(
    'unknown_block',
    descriptor.display_name,
    valid.length > 8
      ? `Block '${input}' is not valid on ${descriptor.display_name}. First few: ${sample}… (call list_params for the full list).`
      : `Block '${input}' is not valid on ${descriptor.display_name}. Blocks: ${sample}.`,
    details,
  );
}

// ── Step 3b: param-name normalization ───────────────────────────────

export function resolveParamName(
  descriptor: DeviceDescriptor,
  block: string,
  input: string,
): { name: string; aliased_from?: string } {
  const schema = descriptor.blocks[block];
  if (schema === undefined) {
    throw new DispatchError(
      'unknown_block',
      descriptor.display_name,
      `Block '${block}' is not registered on ${descriptor.display_name}.`,
    );
  }
  // Step 1: exact local-name match — the fast path.
  if (input in schema.params) return { name: input };
  // Step 1b: descriptor-supplied block-alias map.
  const aliased = schema.aliases?.[input];
  if (aliased !== undefined && aliased in schema.params) {
    return { name: aliased, aliased_from: input };
  }
  // Step 2: cross-device concept-key match. Accepts both fully-qualified
  // (`drive.output_level`) and bare (`output_level`, when the slot
  // block context provides the block prefix). The dispatcher rewrites
  // the typed concept-key to the device-local canonical name before the
  // writer sees it.
  const conceptResult = resolveConceptKeyForBlock(descriptor.id, block, input);
  if (
    conceptResult !== undefined
    && conceptResult.localName in schema.params
  ) {
    return { name: conceptResult.localName, aliased_from: input };
  }
  // Normalize user input (lowercase, collapse non-alphanumeric to "_")
  // so "Input Drive" / "INPUT DRIVE" / "input-drive" all match the
  // descriptor's auto-derived aliases for `input_drive`. This is the
  // device-agnostic fuzzy layer; per-device descriptors still own the
  // alias table.
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (normalized !== input && normalized in schema.params) {
    return { name: normalized, aliased_from: input };
  }
  if (schema.aliases?.[normalized] !== undefined && schema.aliases[normalized] in schema.params) {
    return { name: schema.aliases[normalized], aliased_from: input };
  }
  // Step 3: cross-device per-pair alias table (BK-065). Catches the
  // foreign-device vocabulary cases that aren't promoted to concept-keys.
  const crossDeviceAlias = resolveParamAlias(descriptor.id, block, input);
  if (
    crossDeviceAlias.aliasUsed !== undefined
    && crossDeviceAlias.canonical !== input
    && crossDeviceAlias.canonical in schema.params
  ) {
    return { name: crossDeviceAlias.canonical, aliased_from: input };
  }
  const suggestion = nearestParam(input, Object.keys(schema.params));
  const valid = Object.keys(schema.params);
  const details: DispatchErrorDetails = {
    suggestion,
    valid_options_tool: 'list_params(port, block)',
    retry_action: suggestion
      ? `Did you mean '${block}.${suggestion}' on ${descriptor.display_name}?`
      : `Call list_params(port='${descriptor.id}', block='${block}') for the full param list.`,
  };
  throw new DispatchError(
    'unknown_param',
    descriptor.display_name,
    formatUnknownParamError({
      deviceName: descriptor.display_name,
      block,
      badParam: input,
      knownNames: valid,
    }),
    details,
  );
}

function nearestParam(input: string, candidates: readonly string[]): string | undefined {
  const lower = input.toLowerCase();
  let best: { name: string; d: number } | undefined;
  for (const candidate of candidates) {
    const d = levenshtein(lower, candidate.toLowerCase());
    if (d <= 2 && (best === undefined || d < best.d)) best = { name: candidate, d };
  }
  return best?.name;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > 2) return 3;
  const dp: number[] = Array.from({ length: bl + 1 }, (_, j) => j);
  for (let i = 1; i <= al; i++) {
    let prev = i - 1;
    let curr = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      curr = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(prev, dp[j], dp[j - 1]) + 1;
      dp[j - 1] = prev;
      prev = tmp;
      dp[j] = curr;
    }
  }
  return dp[bl];
}

// ── Step 3c: channel normalization ──────────────────────────────────

export function resolveChannel(
  descriptor: DeviceDescriptor,
  block: string,
  input: string | number | undefined,
): number | undefined {
  if (input === undefined) return undefined;
  const caps = descriptor.capabilities;
  if (!caps.has_channels) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `Channels are not a concept on ${descriptor.display_name}. Drop the channel argument.`,
    );
  }
  const names = caps.channel_names ?? [];
  if (caps.channel_blocks && !caps.channel_blocks.includes(block)) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `Block '${block}' on ${descriptor.display_name} does not expose channels — only ${caps.channel_blocks.join('/')} do. Drop the channel argument for this block.`,
    );
  }
  if (typeof input === 'number') {
    if (Number.isInteger(input) && input >= 0 && input < names.length) return input;
    throw new DispatchError(
      'bad_channel',
      descriptor.display_name,
      `Channel index ${input} is out of range on ${descriptor.display_name} (valid: 0..${names.length - 1} / ${names.join('/')}).`,
    );
  }
  const upper = input.toUpperCase();
  const idx = names.indexOf(upper);
  if (idx >= 0) return idx;
  throw new DispatchError(
    'bad_channel',
    descriptor.display_name,
    `Channel '${input}' is not valid on ${descriptor.display_name} (channels are ${names.join('/')}).`,
    { valid_options: names },
  );
}

// ── Step 4: value validation + display→wire encoding ────────────────

export function encodeValue(
  descriptor: DeviceDescriptor,
  block: string,
  name: string,
  value: number | string,
): number {
  const schema = descriptor.blocks[block]?.params[name];
  if (schema === undefined) {
    const blockSchema = descriptor.blocks[block];
    const knownNames = blockSchema !== undefined ? Object.keys(blockSchema.params) : [];
    throw new DispatchError(
      'unknown_param',
      descriptor.display_name,
      formatUnknownParamError({
        deviceName: descriptor.display_name,
        block,
        badParam: name,
        knownNames,
      }),
    );
  }
  try {
    return schema.encode(value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code =
      schema.unit === 'enum'
        ? (msg.toLowerCase().includes('ambiguous') ? 'ambiguous_enum_value' : 'unknown_enum_value')
        : 'value_out_of_range';
    // Pull structured candidates off the underlying error (e.g. AM4's
    // EnumAmbiguityError carries `.candidates`) so the agent can pick a
    // verbatim choice from the response without re-parsing prose. See
    // shared.ts:asError for the duck-typed shape contract.
    const candidates: readonly string[] | undefined =
      err !== null
      && typeof err === 'object'
      && Array.isArray((err as { candidates?: unknown }).candidates)
      && (err as { candidates: unknown[] }).candidates.every((x) => typeof x === 'string')
        ? (err as { candidates: string[] }).candidates
        : undefined;
    // For unknown enum values, escalate to the AM4-style unified
    // formatter so the message lists candidates ordered by closeness
    // and supplies a top-3 "did you mean…?" line. Out-of-range numeric
    // values use the encoder's own range-formatted message verbatim.
    if (code === 'unknown_enum_value' && schema.unit === 'enum' && typeof value === 'string') {
      const validValues = schema.enum_values !== undefined
        ? Object.values(schema.enum_values)
        : (candidates ?? []);
      throw new DispatchError(
        code,
        descriptor.display_name,
        formatUnknownEnumError({
          block,
          paramName: name,
          badValue: value,
          validValues,
        }),
        candidates !== undefined ? { valid_options: candidates } : undefined,
      );
    }
    throw new DispatchError(
      code,
      descriptor.display_name,
      `set_param: ${block}.${name} on ${descriptor.display_name} — ${msg}`,
      candidates !== undefined ? { valid_options: candidates } : undefined,
    );
  }
}

// ── Pure-side full pipeline for set_param (used by goldens) ─────────

export interface EncodedSetParam {
  device: string;
  canonical_block: string;
  canonical_name: string;
  wire_value: number;
  bytes: number[];
}

/**
 * Pure-side full pipeline for `set_param`: resolve port → resolve
 * block/param → encode value → produce the wire bytes the dispatcher
 * WOULD send. Hardware-free; the verify-dispatcher.ts golden uses this
 * to assert byte-equivalence with the pre-dispatcher path.
 *
 * Does NOT produce channel-switch bytes — channel switching is the
 * writer's runtime responsibility. The golden only asserts the
 * param-write bytes match.
 */
export function encodeSetParam(args: {
  port: string;
  block: string;
  name: string;
  value: number | string;
}): EncodedSetParam {
  const descriptor = requireDevice(args.port);
  const canonical_block = resolveBlockName(descriptor, args.block);
  const { name: canonical_name } = resolveParamName(descriptor, canonical_block, args.name);
  const wire_value = encodeValue(descriptor, canonical_block, canonical_name, args.value);
  const bytes = descriptor.writer.buildSetParam(canonical_block, canonical_name, wire_value);
  return {
    device: descriptor.display_name,
    canonical_block,
    canonical_name,
    wire_value,
    bytes,
  };
}
