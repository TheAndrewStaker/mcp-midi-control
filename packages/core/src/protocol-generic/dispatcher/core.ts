/**
 * Dispatcher core — step-1 port resolution and step-5 connection setup.
 *
 * Every unified MCP tool routes through one of the `execute*` wrappers in
 * the sibling family files (`params.ts`, `navigation.ts`, etc.); each of
 * those wrappers starts by calling `requireDevice(port)` here, runs its
 * family-specific validation, then runs its device I/O inside
 * `withEndpoint(descriptor, fn)`, which acquires the per-endpoint lock and
 * hands `fn` a freshly-built `DispatchCtx` right before it delegates to
 * the descriptor's writer or reader.
 */

import { awaitDeviceLease, ensureConnection } from '../../server-shared/connections.js';
import {
  EndpointBusyError,
  runExclusiveOnEndpoint,
} from '../../server-shared/endpointArbiter.js';
import { withHandleFaultRetry } from '../../server-shared/handleHealth.js';
import { createLazyMidiConnection, createNullMidiConnection } from '../../midi/transport.js';
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
    // Two different situations reach here: a supported device that is not
    // plugged in, and gear this server has no profile for at all (found
    // 2026-09-16 when a new Boss XS-100 got only a list of 16 other devices).
    retry_action: 'If it is one of these, call list_midi_ports to see what is connected. If it is gear with no profile here, send it MIDI with the send_* tools (port = its OS MIDI port name) and add it to the rig with edit_rig add_device.',
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
 * NOT exported: every I/O path obtains its ctx through {@link withEndpoint},
 * which builds it fresh INSIDE the per-endpoint lock. Exporting this would
 * hand out a lock-free ctx, exactly the serialization hole the arbiter
 * exists to close — a missed wrap must be a tsc error, not a latent race.
 *
 * Branches on `descriptor.transport.kind` (default `'midi'`):
 *   - `'midi'` / `'serial'`: open (or reuse) the MIDI handle via
 *     `ensureConnection`. Serial is transparent here — its `MidiConnection`
 *     factory is registered under the device label like any other.
 *   - `'storage'`: resolve the mounted-volume root, or throw
 *     `device_not_mounted`. `conn` is a null object (no MIDI in this mode).
 *   - `'hybrid'`: drive mounted → the storage context; else try the MIDI
 *     surface (the two surfaces are mutually exclusive by hardware mode, unless
 *     the descriptor sets `transport.concurrent`: then a mounted drive yields
 *     the storage root PLUS a MIDI connection opened on first use). If
 *     NEITHER resolves (no drive AND no MIDI port), throw a hybrid-aware error
 *     naming both surfaces — a bare MIDI port-not-found would mis-direct a
 *     storage operation toward looking for a MIDI port it never needs.
 *
 * `opts.pack` is the 0-based microSD pack this dispatch addresses (Circuit
 * Tracks only; see `DispatchCtx.pack`). Every leg of a stored-slot write reads
 * it from the ctx, so a gate and its write cannot end up on different packs.
 */
function buildCtx(descriptor: DeviceDescriptor, opts: { pack?: number } = {}): DispatchCtx {
  const kind = descriptor.transport?.kind ?? 'midi';
  const label = descriptor.connection_label ?? descriptor.id;
  const pack = opts.pack;
  assertPackSupported(descriptor, pack);

  if (kind === 'storage' || kind === 'hybrid') {
    const root = descriptor.transport?.resolveRoot?.();
    if (root !== undefined && kind === 'hybrid' && descriptor.transport?.concurrent === true) {
      // Both surfaces at once (a card in a reader, the device still on USB).
      // The MIDI handle is opened only if a method actually sends.
      return {
        conn: createLazyMidiConnection(() => ensureConnection(label)),
        storage: { root },
        descriptor,
        pack,
        reconnect: () => ensureConnection(label, true),
      };
    }
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
 * Connection-arbiter Phase B R1 (docs/design/connection-arbiter.md "The
 * seam"): run `fn` against a `DispatchCtx` while holding the exclusive
 * per-endpoint lock, so at most one operation touches a device at a time.
 * Ops on different devices never wait on each other.
 *
 * The ctx is built fresh INSIDE the lock (an SPD-SX USB-mode flip is seen
 * on the next acquire; a stale key is never served), and this is the ONLY
 * way to obtain one — `buildCtx` is module-private, so a new executor that
 * skips the lock fails to compile rather than shipping a latent race. The
 * offline sibling {@link openOfflineCtx} stays lock-free by construction:
 * it opens no port, so it has nothing to serialize.
 *
 * Contention: a caller queued behind a busy endpoint waits
 * `endpointWaiterTimeoutMs()` (default 5 s), then fails fast with a
 * `device_busy` DispatchError naming the in-flight op and its age —
 * distinguishing "briefly busy, retry" from "busy for a whole stream,
 * don't wait". Holders hold for their whole op by design: a live-stream
 * IS exclusive use of that device.
 *
 * The holder's own in-op recovery (`ctx.reconnect`, `withHandleRetry`)
 * never re-enters the lock — it operates on the held slot. Re-entering the
 * SAME endpoint from a locked op throws `EndpointReentrancyError` loudly
 * instead of deadlocking; composites (set_mod_route → set_param ×3,
 * translate_preset source-read then target-apply) acquire SEQUENTIALLY,
 * never nested.
 *
 * `opName` labels the holder for `device_busy` messages ("busy:
 * apply_pattern started 4 s ago"). Kill-switch:
 * `MCP_DISABLE_ENDPOINT_ARBITER=1` bypasses the lock entirely.
 */
export async function withEndpoint<T>(
  descriptor: DeviceDescriptor,
  fn: (ctx: DispatchCtx) => Promise<T>,
  opts: { pack?: number; opName?: string } = {},
): Promise<T> {
  const key = descriptor.connection_label ?? descriptor.id;
  const opName = opts.opName ?? 'a device operation';
  try {
    return await runExclusiveOnEndpoint(key, opName, async () => {
      // Another mcp-midi-control instance may hold this device's port. Its
      // idle-release grace frees it within seconds of that session's last
      // operation, so ride that out (bounded, MCP_PORT_WAIT_MS) before the
      // handle open below reports the holder in words. Free when we already
      // hold the handle or the lease.
      await awaitDeviceLease(key);
      return fn(buildCtx(descriptor, { pack: opts.pack }));
    });
  } catch (err) {
    if (err instanceof EndpointBusyError) {
      const holder = err.holder;
      const heldFor = holder !== undefined
        ? `${Math.max(1, Math.round((Date.now() - holder.acquiredAt) / 1000))} s`
        : undefined;
      throw new DispatchError(
        'device_busy',
        descriptor.display_name,
        `${descriptor.display_name} is busy: ` +
          (holder !== undefined
            ? `${holder.opName} has been using its connection for ${heldFor}. `
            : 'another operation is still using its connection. ') +
          `This ${opName} waited ${err.waitedMs} ms, then stopped rather than risk interleaving two operations on one port. Nothing was sent.`,
        {
          retry_action:
            'Retry when the in-flight operation finishes; a long transfer or live stream can hold a device for ' +
            'its whole duration, so tell the user what is running rather than re-calling in a loop. Do NOT call ' +
            'reconnect_midi to force it — that would cut the in-flight operation off mid-write.',
        },
      );
    }
    throw err;
  }
}

/**
 * Pack-addressing gate, the sibling of {@link assertInstanceSupported}. Devices
 * that don't advertise `capabilities.has_packs` have exactly one world of stored
 * content, so a `pack > 1` request cannot be honored. Refuse it loudly instead of
 * dropping it and serving pack 1's data as though the arg had been applied — a
 * silently-ignored addressing arg is how `get_preset(location: 3, pack: 5)`
 * returns a different project than the caller asked for and nobody finds out.
 *
 * Takes the WIRE pack (0-based) because it is enforced inside the ctx build
 * (`withEndpoint` / `openOfflineCtx`), which every dispatch already funnels
 * through — so no executor can forget it, the same reasoning that put `pack`
 * on the ctx rather than on each call. Reports
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
 * `withEndpoint`'s ctx build resolves a live handle via `ensureConnection`,
 * which throws `port_not_found` when the device is absent. A dry run neither
 * reads nor writes, so requiring the port was a false dependency that failed
 * exactly the use case the flag exists for.
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
