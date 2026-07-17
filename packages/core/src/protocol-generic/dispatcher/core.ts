/**
 * Dispatcher core — step-1 port resolution and step-5 connection setup.
 *
 * Every unified MCP tool routes through one of the `execute*` wrappers in
 * the sibling family files (`params.ts`, `navigation.ts`, etc.); each of
 * those wrappers starts by calling `requireDevice(port)` here, runs its
 * family-specific validation, then calls `openCtx(descriptor)` to obtain
 * the MIDI handle right before delegating to the descriptor's writer or
 * reader.
 */

import { ensureConnection } from '../../server-shared/connections.js';
import { withHandleFaultRetry } from '../../server-shared/handleHealth.js';
import { createNullMidiConnection } from '../../midi/transport.js';
import {
  DispatchError,
  type DeviceDescriptor,
  type DispatchCtx,
  type DispatchErrorDetails,
} from '../types.js';
import { listRegisteredDevices, resolveDevice } from '../registry.js';

/**
 * Resolves `port` to a registered descriptor or throws a
 * `port_not_found` DispatchError with the list of known devices.
 */
export function requireDevice(port: string): DeviceDescriptor {
  const desc = resolveDevice(port);
  if (desc) return desc;
  const known = listRegisteredDevices()
    .map((d) => d.display_name)
    .join(', ');
  const details: DispatchErrorDetails = {
    valid_options: listRegisteredDevices().map((d) => d.display_name),
    retry_action: 'Call list_midi_ports to see what is connected.',
  };
  throw new DispatchError(
    'port_not_found',
    '(no device matched)',
    known.length > 0
      ? `No registered device matches port '${port}'. Known devices: ${known}.`
      : `No registered device matches port '${port}'. No devices are registered yet.`,
    details,
  );
}

/**
 * Multi-instance gate. Devices that don't advertise
 * `capabilities.has_block_instances` (AM4, Hydrasynth) cannot address a
 * second instance of a block type; passing `instance > 1` to them would
 * be silently dropped and the write would land on instance 1. Refuse it
 * loudly instead. `instance` of undefined / 1 is always allowed, so the
 * single-instance contract is unchanged.
 *
 * `path` is an optional caller label (e.g. `ops[3] amp.gain`) folded into
 * the error so batch callers can point at the offending entry.
 */
export function assertInstanceSupported(
  descriptor: DeviceDescriptor,
  instance: number | undefined,
  path?: string,
): void {
  if (instance === undefined || instance === 1) return;
  if (descriptor.capabilities.has_block_instances) return;
  throw new DispatchError(
    'capability_not_supported',
    descriptor.display_name,
    `${path ? `${path}: ` : ''}${descriptor.display_name} has a single instance of each block type, ` +
      `so instance ${instance} is not addressable (only instance 1). Drop the \`instance\` arg ` +
      `(or pass instance: 1). Multi-instance addressing is available on grid Fractal devices ` +
      `(Axe-Fx II / III / FM3 / FM9) and Novation Circuit Tracks (Synth 1 / 2).`,
  );
}

/**
 * Open the endpoint for a descriptor and bundle it into the `DispatchCtx`
 * envelope the writer / reader sees. Step-5 of the dispatcher's 6-step
 * lifecycle.
 *
 * Branches on `descriptor.transport.kind` (default `'midi'`):
 *   - `'midi'` / `'serial'`: open (or reuse) the MIDI handle via
 *     `ensureConnection`. Serial is transparent here — its `MidiConnection`
 *     factory is registered under the device label like any other.
 *   - `'storage'`: resolve the mounted-volume root, or throw
 *     `device_not_mounted`. `conn` is a null object (no MIDI in this mode).
 *   - `'hybrid'`: drive mounted → the storage context; else try the MIDI
 *     surface (the two surfaces are mutually exclusive by hardware mode). If
 *     NEITHER resolves (no drive AND no MIDI port), throw a hybrid-aware error
 *     naming both surfaces — a bare MIDI port-not-found would mis-direct a
 *     storage operation toward looking for a MIDI port it never needs.
 *
 * `opts.pack` is the 0-based microSD pack this dispatch addresses (Circuit
 * Tracks only; see `DispatchCtx.pack`). Every leg of a stored-slot write reads
 * it from the ctx, so a gate and its write cannot end up on different packs.
 */
export function openCtx(descriptor: DeviceDescriptor, opts: { pack?: number } = {}): DispatchCtx {
  const kind = descriptor.transport?.kind ?? 'midi';
  const label = descriptor.connection_label ?? descriptor.id;
  const pack = opts.pack;
  assertPackSupported(descriptor, pack);

  if (kind === 'storage' || kind === 'hybrid') {
    const root = descriptor.transport?.resolveRoot?.();
    if (root !== undefined) {
      // Storage surface: no MIDI wire. The null conn throws loudly if a method
      // miswires itself to the wire; storage methods use `ctx.storage.root`.
      return { conn: createNullMidiConnection(descriptor.display_name), storage: { root }, descriptor, pack };
    }
    if (kind === 'storage') {
      throw new DispatchError(
        'device_not_mounted',
        descriptor.display_name,
        descriptor.transport?.notMountedHint
          ?? `${descriptor.display_name} is a storage-transport device but is not mounted as a drive. ` +
             'Connect it and put it in its mass-storage / disk mode, then retry.',
      );
    }
    // hybrid + not mounted → the MIDI surface might still be live (the device in
    // its MIDI mode). Try it; if it ALSO fails, neither surface is connected, so
    // surface both paths instead of a MIDI-only port-not-found.
    try {
      const conn = ensureConnection(label);
      return { conn, descriptor, pack, reconnect: () => ensureConnection(label, true) };
    } catch (midiErr) {
      const storageHint = descriptor.transport?.notMountedHint
        ?? `${descriptor.display_name} is not mounted as a drive (its mass-storage mode).`;
      const midiDetail = midiErr instanceof Error ? midiErr.message.split('\n')[0] : String(midiErr);
      throw new DispatchError(
        'device_not_mounted',
        descriptor.display_name,
        `${descriptor.display_name} is not connected on either surface. ` +
          `For file/storage operations (kit + sample authoring): ${storageHint} ` +
          `For its MIDI surface (preset recall / pad triggers): connect it in its MIDI mode so a MIDI port ` +
          `appears (none matched right now: ${midiDetail}).`,
      );
    }
  }

  const conn = ensureConnection(label);
  // `reconnect` force-reopens the handle for this label (closing the stale one)
  // and returns the fresh handle, so a transfer that hits a dead handle can
  // recover itself instead of erroring out to the user.
  return { conn, descriptor, pack, reconnect: () => ensureConnection(label, true) };
}

/**
 * Pack-addressing gate, the sibling of {@link assertInstanceSupported}. Devices
 * that don't advertise `capabilities.has_packs` have exactly one world of stored
 * content, so a `pack > 1` request cannot be honored. Refuse it loudly instead of
 * dropping it and serving pack 1's data as though the arg had been applied — a
 * silently-ignored addressing arg is how `get_preset(location: 3, pack: 5)`
 * returns a different project than the caller asked for and nobody finds out.
 *
 * Takes the WIRE pack (0-based) because it is enforced inside `openCtx`, which
 * every dispatch already funnels through — so no executor can forget it, the
 * same reasoning that put `pack` on the ctx rather than on each call. Reports
 * the number the user typed (wire + 1). `pack` of undefined / wire 0 is always
 * allowed, so every packless device keeps its existing contract.
 */
export function assertPackSupported(descriptor: DeviceDescriptor, wirePack: number | undefined): void {
  if (wirePack === undefined || wirePack === 0) return;
  if (descriptor.capabilities.has_packs) return;
  throw new DispatchError(
    'capability_not_supported',
    descriptor.display_name,
    `${descriptor.display_name} does not store its content in packs, so pack ${wirePack + 1} is not addressable. ` +
      'Drop the `pack` arg (or pass pack: 1). Pack addressing is a Novation Circuit Tracks feature: its ' +
      'microSD card holds up to 32 packs, each a complete separate world of projects, patches, and samples.',
  );
}

/**
 * Convert the user-facing 1-based `pack` (what the Circuit's front panel shows:
 * "Pack 5") to the 0-based wire index the fileId carries (4). The ONLY place
 * this conversion happens — everything below the tool boundary is wire-side, per
 * the display-first convention in CLAUDE.md.
 *
 * `undefined` → `undefined` (not 0), so "no pack given" stays distinguishable
 * from "pack 1" for callers that care; `ctx.pack ?? 0` supplies the default at
 * the point of use. Guard rail: an off-by-one here writes to the WRONG PACK, so
 * this is deliberately one tiny function with goldens rather than an inline
 * `pack - 1` repeated at four call sites.
 */
export function toWirePack(pack: number | undefined): number | undefined {
  return pack === undefined ? undefined : pack - 1;
}

/**
 * Offline dispatch context: a `DispatchCtx` with NO port opened, for callers
 * that are contractually device-free — today, `apply_pattern dry_run`, whose
 * whole job is planning a set at a desk with the rig unplugged.
 *
 * `openCtx` resolves a live handle via `ensureConnection`, which throws
 * `port_not_found` when the device is absent. A dry run neither reads nor
 * writes, so requiring the port was a false dependency that failed exactly the
 * use case the flag exists for.
 *
 * The connection is the null object, not a real handle, which makes "a dry run
 * sends nothing" STRUCTURAL: any dry-run path that miswires itself to the wire
 * throws this message instead of silently transmitting. That is deliberately
 * stronger than each writer branch promising to return before it sends.
 */
export function openOfflineCtx(descriptor: DeviceDescriptor, opts: { pack?: number } = {}): DispatchCtx {
  // A dry run refuses an unaddressable pack too: a preview that quietly ignored
  // `pack` would greenlight a real call that then refuses (or worse, is honored
  // against a device that has no such pack).
  assertPackSupported(descriptor, opts.pack);
  return {
    conn: createNullMidiConnection(
      descriptor.display_name,
      `${descriptor.display_name}: this is a dry run — no MIDI port is open, so nothing can be sent. ` +
        'A dry run must not read, gate, back up, or transfer. Re-call without dry_run to touch the device.',
    ),
    descriptor,
    // Carried so a dry run REPORTS the pack it would write to. A dry run that
    // silently previewed pack 0 while the real call targeted pack 4 would make
    // the preview a lie about the one field most likely to be wrong.
    pack: opts.pack,
  };
}

/**
 * Phase A.5 (docs/design/connection-arbiter.md "R2 explicitly did NOT
 * touch... unclaimed work: natural Phase A.5"): reconnect-and-retry-once
 * wrapper for a SINGLE leaf wire operation — one `set_param` / `get_param` /
 * `set_block` / `switch_preset` / ... call. This is the seam every simple
 * `execute*` in `params.ts` / `layout.ts` / `navigation.ts` / `preset.ts`
 * routes its terminal `descriptor.writer.X(ctx, ...)` / `descriptor.reader.X
 * (ctx, ...)` call through, so the FIRST post-replug call on any handle-based
 * device self-heals in-band instead of surfacing "Internal RtMidi error" to
 * the user (the 2026-07-10 hardware-confirmed gap: Phase A's acquire-time
 * canary in `ensureConnection` cannot catch a fault that only appears once
 * THIS call's own send fires into a handle that looked healthy at acquire
 * time).
 *
 * Deliberately NOT used by composite ops (`apply_preset`, `apply_setlist`,
 * `port_preset`, `restore_preset` — multi-step; left for Phase B's
 * `withEndpoint` seam once the reentrancy invariant work lands) or by the
 * Circuit's multi-block transfer functions (`uploadProject`/`downloadProject`
 * own their own guard via `withReconnectRetry`; wrapping their callers here
 * too would risk a double-reconnect on top of a transfer already mid-guard).
 * No lock is introduced in this phase — each retry just re-acquires the
 * shared connection registry entry via `ctx.reconnect`, same as today's
 * `reconnect_midi`; composite callers that invoke several wrapped leaf
 * `execute*`s in sequence (e.g. `set_mod_route` calling `executeSetParam`
 * 2-3×) are unaffected, since each call is independent and sequential, never
 * nested under a held lock.
 *
 * `fn` receives a `DispatchCtx` on each attempt — the ORIGINAL `ctx` on the
 * first try, a rebuilt one carrying the fresh `conn` on the retry — so a
 * retry always sends on a live handle with its OWN freshly-registered
 * inbound listeners. Swapping `conn` transparently mid-send would orphan
 * listeners already registered on the stale handle (the ack-wait pattern
 * `sendAndAwaitAck` uses registers `onMessage` BEFORE `send`), so this
 * rebuilds the whole ctx and re-runs `fn` from the top instead of trying to
 * hot-swap the connection inside an in-flight send.
 */
export function withHandleRetry<T>(
  ctx: DispatchCtx,
  fn: (ctx: DispatchCtx) => Promise<T>,
): Promise<T> {
  return withHandleFaultRetry(
    ctx.conn,
    (conn) => fn(conn === ctx.conn ? ctx : { ...ctx, conn }),
    { reconnect: ctx.reconnect },
  );
}
