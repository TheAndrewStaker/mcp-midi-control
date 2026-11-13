/**
 * Hydrasynth Explorer DeviceDescriptor — DeviceWriter implementation.
 *
 * Scope (v1 scaffold, BK-031):
 *
 *   - **Pure builders:** `buildSetParam`, `buildSwitchPreset`. Wire-byte
 *     output without I/O — exercised by `verify-dispatcher.ts` byte-
 *     equivalence goldens against the legacy `hydra_*` builders.
 *   - **Execute methods:** `setParam`, `setParams`, `switchPreset`. Drive
 *     the wire round-trip via `ctx.conn` (cast to HydrasynthConnection
 *     when bound — the MidiConnection facade exposes `send` which is all
 *     the NRPN/CC encoders need).
 *
 * Out of scope (deferred to follow-up — legacy `hydra_*` tools still
 * cover these flows in v0.1.x):
 *
 *   - `applyPreset` — the full SysEx patch-dump path lives in
 *     `tools/patch.ts:apply_patch`. Wrapping its 6-chunk-with-ack
 *     pipeline into the unified `apply_preset` shape is its own
 *     ~200-LOC translation; deferred to keep BK-031 scoped.
 *   - `savePreset` — Hydrasynth's persistence envelope is the patch
 *     dump (not a discrete STORE op); rolled into the applyPreset
 *     work above.
 *   - `applySetlist` — depends on `applyPreset` landing first.
 *   - `setBlock` / `setBypass` — synthesizer modules aren't
 *     interchangeable or bypassable per-block. Returns
 *     capability_not_supported.
 *   - `switchScene` / `rename` — Hydrasynth has no scenes; preset
 *     rename happens within the patch-dump envelope, not as a
 *     standalone op.
 *
 * Per Q1 of the descriptor plan (mirrors Axe-Fx II Session 67): unified
 * tool dispatch for unsupported ops returns `capability_not_supported`
 * cleanly via the dispatcher's optional-method handling — the writer
 * just omits those methods.
 */

import type {
  BatchWriteResult,
  DeviceWriter,
  DispatchCtx,
  LocationRef,
  WriteOp,
  WriteResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { formatUnknownParamError } from '@mcp-midi-control/core/protocol-generic/dispatcher/errorFormat.js';

import { findHydraNrpn, HYDRASYNTH_NRPNS, type HydrasynthNrpn } from '../nrpn.js';
import { nrpnMessagesFor, resolveNrpnValue } from '../encoding.js';
import { decodeNrpnDisplay, decodeFxNrpnDisplay } from '../nrpnDisplay.js';
import { HYDRASYNTH_PARAMS_BY_ID } from '../params.js';

/**
 * Enumerate Hydrasynth param names belonging to a given module
 * prefix. The NRPN catalog stores entries as smushed names
 * (`osc1mode`, `osc1semi`). When the agent calls `set_param('osc1',
 * 'mode')` we strip the leading module prefix to surface a friendly
 * "Known params for osc1: mode, semi, …" line.
 */
function listParamNamesForHydraBlock(block: string): string[] {
  const out: string[] = [];
  const lc = block.toLowerCase();
  for (const e of HYDRASYNTH_NRPNS) {
    const n = e.name;
    if (n.toLowerCase().startsWith(lc) && n.length > lc.length) {
      const tail = n.slice(lc.length);
      if (!out.includes(tail)) out.push(tail);
    }
  }
  // CC-chart entries use dotted form (`block.param`).
  for (const k of HYDRASYNTH_PARAMS_BY_ID.keys()) {
    if (k.startsWith(`${lc}.`)) {
      const tail = k.slice(lc.length + 1);
      if (!out.includes(tail)) out.push(tail);
    }
  }
  return out;
}

import { parseHydrasynthLocation } from './schema.js';
import { restorePresetBinaryHydrasynth } from './presetRestore.js';

const DEVICE_LABEL = 'ASM Hydrasynth Explorer';
const DEFAULT_CHANNEL = 1;

// ── Param-name resolution ──────────────────────────────────────────
//
// The unified surface calls writer.setParam(block, name, wireValue).
// We assemble the (block, name) into Hydrasynth's lookup forms — both
// the dotted `module.param` and the smushed `moduleparam` NRPN-canonical
// shapes — and ask `findHydraNrpn` to resolve via its alias map.

function resolveNrpn(block: string, paramName: string): HydrasynthNrpn {
  const candidates = [
    `${block}.${paramName}`,             // CC chart / alias form
    `${block}${paramName.replace(/_/g, '')}`, // NRPN canonical form
    `${block}${paramName}`,               // permissive smushed
    paramName,                            // bare (system params)
  ];
  for (const c of candidates) {
    const hit = findHydraNrpn(c);
    if (hit) return hit;
  }
  // Last-resort: try the CC chart (system + macros + a few engine CCs).
  const ccHit = HYDRASYNTH_PARAMS_BY_ID.get(`${block}.${paramName}`);
  if (ccHit) {
    // Synthesize a degenerate NRPN entry so the rest of the writer can
    // use one shape. This branch only fires for params that exist on
    // the CC chart but aren't in HYDRASYNTH_NRPNS — rare.
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `Parameter '${block}.${paramName}' exists on the CC chart but isn't in the NRPN table; use the hydra_set_param tool to send it as a raw CC.`,
    );
  }
  throw new DispatchError(
    'unknown_param',
    DEVICE_LABEL,
    formatUnknownParamError({
      deviceName: DEVICE_LABEL,
      block,
      badParam: paramName,
      knownNames: listParamNamesForHydraBlock(block),
    }) +
      ` Call list_params({port:"hydrasynth", block:["${block}"]}) to see the canonical name list, or try apply_patch for whole-patch builds.`,
  );
}

// ── Bank-PC navigation ─────────────────────────────────────────────
//
// Hydrasynth navigates via Bank Select MSB (always 0 on Explorer) +
// Bank Select LSB (0..7) + Program Change (0..127). Wire bytes:
//
//   B0 00 00          ← Bank MSB = 0
//   B0 20 BB          ← Bank LSB = bank
//   C0 PP             ← Program Change = patch
//
// (Channel byte | 0xB0 / 0xC0 — default channel 1 → 0xB0/0xC0.)

function ccBytes(channel: number, cc: number, value: number): number[] {
  const status = 0xB0 | ((channel - 1) & 0x0F);
  return [status, cc & 0x7F, value & 0x7F];
}

function programChangeBytes(channel: number, program: number): number[] {
  const status = 0xC0 | ((channel - 1) & 0x0F);
  return [status, program & 0x7F];
}

function buildBankPCBytes(bank: number, patch: number, channel: number): number[] {
  return [
    ...ccBytes(channel, 0, 0),       // Bank MSB = 0 (Explorer fixed)
    ...ccBytes(channel, 32, bank),   // Bank LSB
    ...programChangeBytes(channel, patch),
  ];
}

// ── Writer ─────────────────────────────────────────────────────────

/**
 * Send one resolved NRPN write. Each of the 4 CC messages must be a
 * discrete send (node-midi expects one MIDI message per sendMessage
 * call). Used by `setParam` (which additionally keeps the bypass wet
 * cache honest) and by `setBypass`'s own internal write (which must
 * NOT run the cache hook: writing wet = 0 to bypass would otherwise
 * clobber the very value the next engage is supposed to restore).
 */
function sendResolvedNrpn(ctx: DispatchCtx, entry: HydrasynthNrpn, wireValue: number): void {
  for (const msg of nrpnMessagesFor(entry, DEFAULT_CHANNEL, wireValue)) {
    ctx.conn.send(msg);
  }
}

export const writer: DeviceWriter = {
  // ── Pure builders ────────────────────────────────────────────────

  buildSetParam(block, name, wireValue): number[] {
    const entry = resolveNrpn(block, name);
    // nrpnMessagesFor returns one array per CC message (4 messages for
    // a standard NRPN write). Flatten into a single byte sequence — the
    // unified surface concatenates everything per call.
    return nrpnMessagesFor(entry, DEFAULT_CHANNEL, wireValue).flat();
  },

  buildSwitchPreset(location): number[] {
    const parsed = parseHydrasynthLocation(location);
    return buildBankPCBytes(parsed.bank, parsed.patch, DEFAULT_CHANNEL);
  },

  // ── Execute methods ──────────────────────────────────────────────

  async setParam(ctx, block, name, wireValue): Promise<WriteResult> {
    const entry = resolveNrpn(block, name);
    sendResolvedNrpn(ctx, entry, wireValue);
    // A14-2: a DIRECT write to an FX wet/mix param is the freshest truth
    // about that block's wet level; record it so a later bypass/engage
    // cycle restores THIS value, not a stale earlier one.
    noteWetLevelWrite(entry.name, wireValue);
    // Bug H in the alpha.13 report: Hydrasynth set_param responses were
    // missing display_value, breaking cross-device consistency with the
    // Fractal devices (which return both wire and display). Decode via
    // the curated nrpnDisplay table when available; fall back to
    // omitting display_value when no decoder ships for this param.
    const decoded = decodeNrpnDisplay(entry.name, wireValue)
      ?? decodeFxNrpnDisplay(entry.name, wireValue);
    return {
      op: 'set_param',
      target: `${block}.${name}`,
      block,
      name,
      wire_value: wireValue,
      ...(decoded !== undefined ? { display_value: decoded } : {}),
      acked: true,
      info:
        'Hydrasynth NRPN writes are fire-and-forget; verify by audible / visible response on the device front panel.',
    };
  },

  async setParams(ctx, ops: readonly WriteOp[]): Promise<BatchWriteResult> {
    const writes: WriteResult[] = [];
    let acked_count = 0;
    let unacked_count = 0;
    for (const op of ops) {
      try {
        const r = await writer.setParam!(ctx, op.block, op.name, op.value as number, op.channel);
        writes.push(r);
        if (r.acked) acked_count++;
        else unacked_count++;
      } catch (err) {
        writes.push({
          op: 'set_param',
          target: `${op.block}.${op.name}`,
          block: op.block,
          name: op.name,
          acked: false,
          warning: err instanceof Error ? err.message : String(err),
        });
        unacked_count++;
      }
    }
    return { writes, acked_count, unacked_count };
  },

  async switchPreset(ctx, location: LocationRef): Promise<WriteResult> {
    const parsed = parseHydrasynthLocation(location);
    const bytes = buildBankPCBytes(parsed.bank, parsed.patch, DEFAULT_CHANNEL);
    // Split into 3 discrete MIDI messages (Bank MSB / Bank LSB / PC):
    ctx.conn.send(bytes.slice(0, 3)); // CC 0 = 0
    ctx.conn.send(bytes.slice(3, 6)); // CC 32 = bank
    ctx.conn.send(bytes.slice(6, 8)); // PC = patch
    // The new patch carries its own wet levels; the bypass-engage cache
    // built from prior set_bypass calls is no longer valid.
    clearBypassWetCache();
    return {
      op: 'switch_preset',
      target: parsed.display,
      acked: true,
      info:
        `Switched to ${parsed.display} (bank ${parsed.bank}, patch ${parsed.patch}). ` +
        `Requires "Pgm Chg RX = On" on MIDI Page 11 of System Setup. ` +
        `Any unsaved working-buffer edits were discarded by the patch load.`,
    };
  },

  async setBypass(ctx, block, bypassed): Promise<WriteResult> {
    // Hydrasynth has no protocol-level "block bypass" toggle. The unified
    // surface implements set_bypass by writing the block's wet / mix
    // param to 0 (bypassed) or to a remembered / default value (engaged).
    // This matches what agent_guidance.diagnostic_isolation tells agents
    // to do — and lets the unified tool surface stay symmetric across
    // devices that DO have a native bypass (Fractal) and devices that
    // don't (synths).
    //
    // Limitation: the device doesn't expose working-buffer reads, so we
    // can't capture the user's wet value before bypass to restore it
    // exactly on engage. The wet cache below holds whatever value the
    // server last wrote — accurate when bypass/engage happen in pairs
    // within the same session and no out-of-band edits intervened. A
    // fresh server (no cache hit) restores to a sensible mid-wet default.
    const bypassEntry = HYDRASYNTH_BYPASS_PARAMS[block.toLowerCase()];
    if (bypassEntry === undefined) {
      const supported = Object.keys(HYDRASYNTH_BYPASS_PARAMS).join(', ');
      throw new DispatchError(
        'unknown_block',
        DEVICE_LABEL,
        `set_bypass on ${DEVICE_LABEL} only supports FX-class blocks (${supported}). Got "${block}". To mute the whole patch, send_panic; to silence a specific knob, set_param with value 0.`,
      );
    }
    let wireValue: number;
    let infoExtra: string;
    if (bypassed) {
      wireValue = 0;
      infoExtra =
        `To re-engage, call set_bypass(block:"${block}", bypassed:false). The wet level will restore to ${
          bypassWetCache[block.toLowerCase()] ?? bypassEntry.engageDefault
        } (server-cached last-known value); call set_param(${bypassEntry.block}, ${bypassEntry.name}, <value>) afterward if you need a different wet level.`;
    } else {
      const cached = bypassWetCache[block.toLowerCase()];
      wireValue = cached ?? bypassEntry.engageDefault;
      bypassWetCache[block.toLowerCase()] = wireValue;
      infoExtra =
        `Wet level restored to ${wireValue} (${cached !== undefined ? 'server-cached' : 'default'}).`;
    }
    // Deliberately NOT writer.setParam: its A14-2 cache hook would record
    // the bypass write (wet = 0) as the block's last-known wet level and
    // the next engage would "restore" silence.
    sendResolvedNrpn(ctx, resolveNrpn(bypassEntry.block, bypassEntry.name), wireValue);
    return {
      op: 'set_bypass',
      target: `${block}:${bypassed ? 'bypassed' : 'engaged'}`,
      acked: true,
      info:
        `${block} ${bypassed ? 'bypassed' : 'engaged'} by writing ${bypassEntry.block}.${bypassEntry.name} = ${wireValue} ` +
        `(Hydrasynth has no protocol-level bypass; mute via the block's wet/mix knob is the equivalent). ` +
        infoExtra,
    };
  },

  // Byte-exact restore of an export_preset/backup_device `.syx` to a
  // stored slot over the hardware-confirmed BK-113 series-write flow.
  // Requires target_location + save_authorized + confirm_overwrite (a
  // restore on this device is always a flash overwrite; see the module
  // header of presetRestore.ts).
  restorePresetBinary: restorePresetBinaryHydrasynth,

  // setBlock / switchScene / rename / applyPreset / applySetlist
  // intentionally omitted in v1 — the dispatcher surfaces
  // `capability_not_supported` for unified tool calls hitting those.
  // Legacy apply_patch / hydra_apply_init tools cover the applyPreset
  // semantics until BK-051 Session D.
};

// Map from a Hydrasynth "block" to the wet/mix param that effectively
// bypasses it when written to 0. Mirrors the FX block list named in
// agent_guidance.diagnostic_isolation. dry_wet / mix wire range is
// 0..127 (standard CC); engageDefault picks a useful half-wet value so
// the engage path produces an audible signal when the cache is empty.
const HYDRASYNTH_BYPASS_PARAMS: Record<
  string,
  { block: string; name: string; engageDefault: number }
> = {
  prefx: { block: 'prefx', name: 'mix', engageDefault: 64 },
  postfx: { block: 'postfx', name: 'mix', engageDefault: 64 },
  delay: { block: 'delay', name: 'dry_wet', engageDefault: 64 },
  reverb: { block: 'reverb', name: 'dry_wet', engageDefault: 64 },
  mutator1: { block: 'mutator1', name: 'dry_wet', engageDefault: 64 },
  mutator2: { block: 'mutator2', name: 'dry_wet', engageDefault: 64 },
  mutator3: { block: 'mutator3', name: 'dry_wet', engageDefault: 64 },
  mutator4: { block: 'mutator4', name: 'dry_wet', engageDefault: 64 },
};

// Cache of the wet value last written to each FX block. set_bypass(engage)
// reads from here so a bypass/engage cycle within the same session ends
// at the same wet level the agent / user just set. Kept honest by (A14-2):
//   - noteWetLevelWrite: a direct set_param/set_params write to an
//     underlying wet/mix param updates (or, at 0, drops) the entry;
//   - clearBypassWetCache on every path that replaces the whole working
//     buffer: switchPreset here, apply_patch / init_patch in tools/patch.ts
//     (the new patch carries its own wet values, so anything cached before
//     it is stale).
const bypassWetCache: Record<string, number> = {};

/**
 * Drop every cached wet level. Exported for the whole-buffer write paths
 * (apply_patch / init_patch) whose SysEx dump replaces all wet values at
 * once; switchPreset calls it too.
 */
export function clearBypassWetCache(): void {
  for (const key of Object.keys(bypassWetCache)) delete bypassWetCache[key];
}

// Lazy map from an underlying wet/mix param's CANONICAL NRPN name to its
// bypass-cache key. Resolved through the same resolveNrpn path the writes
// use, so every alias spelling a caller might use ("delay.dry_wet",
// "delaywet", ...) lands on the same canonical entry and hits the cache.
// Built lazily to keep declaration order flexible (resolveNrpn + the table
// above both need to exist first).
let wetParamCanonicalToKey: Map<string, string> | undefined;

function bypassKeyForCanonicalName(canonicalName: string): string | undefined {
  if (wetParamCanonicalToKey === undefined) {
    wetParamCanonicalToKey = new Map();
    for (const [key, p] of Object.entries(HYDRASYNTH_BYPASS_PARAMS)) {
      try {
        wetParamCanonicalToKey.set(resolveNrpn(p.block, p.name).name, key);
      } catch {
        // A bypass entry whose param does not resolve cannot be cached;
        // set_bypass on it would already fail at the same resolveNrpn.
      }
    }
  }
  return wetParamCanonicalToKey.get(canonicalName);
}

/**
 * A14-2 cache hook, called from setParam only (never from setBypass's own
 * internal write). A positive direct write IS the block's current wet level:
 * record it. A direct write of 0 is a manual mute; caching 0 would make the
 * next engage "restore" silence, so the entry is dropped instead and engage
 * falls back to the audible default.
 */
function noteWetLevelWrite(canonicalName: string, wireValue: number): void {
  const key = bypassKeyForCanonicalName(canonicalName);
  if (key === undefined) return;
  if (wireValue > 0) bypassWetCache[key] = wireValue;
  else delete bypassWetCache[key];
}
