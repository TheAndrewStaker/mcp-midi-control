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
 *     `tools/patch.ts:hydra_apply_patch`. Wrapping its 6-chunk-with-ack
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

import { findHydraNrpn, type HydrasynthNrpn } from '../nrpn.js';
import { nrpnMessagesFor, resolveNrpnValue } from '../encoding.js';
import { HYDRASYNTH_PARAMS_BY_ID } from '../params.js';

import { parseHydrasynthLocation } from './schema.js';

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
      `Parameter '${block}.${paramName}' exists on the CC chart but isn't in the NRPN table — use the legacy hydra_set_param tool to send it as a raw CC.`,
    );
  }
  throw new DispatchError(
    'unknown_param',
    DEVICE_LABEL,
    `Parameter '${block}.${paramName}' is not registered on ASM Hydrasynth Explorer. Call list_params(port='hydrasynth', block='${block}') for the valid set; or use the legacy hydra_set_engine_param tool which accepts the full NRPN namespace.`,
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
    // Each NRPN message must be a discrete send (node-midi expects one
    // MIDI message per sendMessage call).
    for (const msg of nrpnMessagesFor(entry, DEFAULT_CHANNEL, wireValue)) {
      ctx.conn.send(msg);
    }
    return {
      op: 'set_param',
      target: `${block}.${name}`,
      block,
      name,
      wire_value: wireValue,
      acked: true,
      info:
        'Hydrasynth NRPN writes are fire-and-forget — verify by audible / visible response on the device front panel.',
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

  // setBlock / setBypass / switchScene / rename / applyPreset /
  // applySetlist / restoreDefaults intentionally omitted in v1 — the
  // dispatcher surfaces `capability_not_supported` for unified tool
  // calls hitting those. Legacy hydra_apply_patch / hydra_apply_init
  // tools cover the applyPreset semantics until BK-051 Session D.
};
