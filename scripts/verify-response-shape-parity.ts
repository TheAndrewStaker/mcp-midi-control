// verify-response-shape-parity.ts
//
// Cross-device RESPONSE-SHAPE parity gate (P1a-response-shape-parity).
//
// Goal: catch the AM4-vs-Axe-Fx-II `get_preset` / `get_params` divergence
// class. Concretely, the bug this gate forecloses is a device whose
// reader silently STOPS declaring a field its sibling device declares
// (e.g. AM4 omitting `active_scene`, per-slot `bypassed`, `_meta`, or
// `ReadResult.raw_response` that the Axe-Fx II response includes), so an
// agent that learned the shape from one device breaks when pointed at the
// other.
//
// Approach (runtime, mock-driven, the reliable offline path):
//   1. Set MCP_MOCK_TRANSPORT=1 so the device connectXXX wrappers return
//      an in-memory mock MidiConnection (same pattern verify-dispatcher.ts
//      and the agent-regression harness use; see
//      packages/core/src/midi/transport.ts:mockConnect + each device's
//      midi.ts mock responder).
//   2. Build a real DispatchCtx { conn, descriptor } per device.
//   3. Drive the device's OWN reader (descriptor.reader.getPreset /
//      getParam) end-to-end against the mock. The returned object is the
//      actual response envelope the MCP tool layer would serialize.
//   4. Assert the envelope conforms to a CONTRACT: a set of fields the
//      response MUST declare, plus an EXPLICIT per-device allowlist of
//      intentional omissions (documented inline with the reason).
//
// AM4, Axe-Fx II, and the gen-3 Axe-Fx III all get RUNTIME shape
// assertions (their mock responders synthesize enough wire shapes to run
// getPreset and getParam against the mock). The gen-3 mock synthesizes the
// device's 0x74/0x75/0x76 state-broadcast burst in answer to the reader's
// fn=0x1F bulk-read poll (see packages/fractal-gen3/src/parityMock.ts).
// Hydrasynth does not implement the slot/scene getPreset contract and is
// reported as not-applicable, not silently skipped.
//
// Run:  npx tsx scripts/verify-response-shape-parity.ts
//
// Status: offline, no hardware required.

process.env.MCP_MOCK_TRANSPORT = '1';

import {
  registerDevice,
  listRegisteredDevices,
} from '@mcp-midi-control/core/protocol-generic/registry.js';
import type {
  DeviceDescriptor,
  DispatchCtx,
  PresetSnapshot,
  ReadResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';

// Importing each device's descriptor registers its param-kind resolver as
// a side effect (the descriptor module calls registerParamKindResolver at
// import time). Importing each device's midi module exposes the mock-aware
// connectXXX wrapper.
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import { AXEFX3_DESCRIPTOR } from '@mcp-midi-control/fractal-gen3/descriptor.js';
import { connectAxeFxIIIParityMock, connectAxeFxIIIParityMockWith } from '@mcp-midi-control/fractal-gen3/midi.js';

let failures = 0;
let passes = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passes++;
    console.log(`  OK   -- ${label}`);
    return;
  }
  failures++;
  console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
}

// ── Contract definitions ─────────────────────────────────────────────
//
// The "required" set is the floor: every device that implements the
// surface MUST declare these keys (value may be undefined, but the KEY
// must be present so the agent-facing shape is uniform). The "optional"
// set is the union of fields some device declares; for each, every device
// either declares it OR lists it on its `omits` allowlist with a reason.
// A field that is neither required, declared, nor allow-listed is a
// silent divergence and fails the gate.

interface ShapeContract {
  /** Keys every conforming device response MUST contain. */
  required: readonly string[];
  /** Keys that are legitimately device-optional (union across devices). */
  optional: readonly string[];
}

// PresetSnapshot top-level envelope contract.
const PRESET_SNAPSHOT_CONTRACT: ShapeContract = {
  required: ['slots', '_meta'],
  optional: [
    'name',
    'active_scene',
    'scenes',
    'routing',
    'chain_integrity',
    'read_warnings',
    'live_grid',
    'live_meters',
  ],
};

// PresetSnapshot._meta sub-envelope contract.
const PRESET_SNAPSHOT_META_CONTRACT: ShapeContract = {
  required: ['device', 'read_at_ms', 'active_scene_only', 'routing_omitted'],
  optional: [
    'channel_state_omitted',
    'both_channels_read',
    'read_duration_ms',
    'channel_state_hint',
    'current_location',
    'is_dirty',
    // BK-081 (2026-07-09): Axe-Fx II atomic whole-preset-image read path.
    // 'read_path' names whether the snapshot's params came from the ONE
    // atomic preset-image dump (tear-free across blocks) or the legacy
    // per-block fn=0x1F loop; 'image_read_fallback_reason' explains why the
    // image path was skipped/partial, when it was. II-only for now, not
    // yet promoted into core's PresetSnapshotMeta type (see
    // descriptor/reader.ts PresetSnapshotMetaWithReadPath).
    'read_path',
    'image_read_fallback_reason',
  ],
};

// ReadResult (get_param / get_params element) contract.
const READ_RESULT_CONTRACT: ShapeContract = {
  required: ['block', 'name', 'wire_value', 'display_value', 'unit'],
  optional: ['raw_response'],
};

// Per-device EXPLICIT allowlist of intentionally-omitted OPTIONAL fields,
// each paired with the reason it is correct for that device to omit it.
// An entry here means "this device deliberately does not declare this
// optional field"; the gate treats the omission as conforming. Adding a
// field to a device's omit list is the documented, reviewable way to
// record a real shape divergence (vs. an accidental regression).
interface DeviceAllowlist {
  presetSnapshot: Record<string, string>;
  presetSnapshotMeta: Record<string, string>;
  readResult: Record<string, string>;
}

const ALLOWLIST: Record<string, DeviceAllowlist> = {
  am4: {
    presetSnapshot: {
      // AM4 has no signal-routing grid: blocks sit in 4 linear slots,
      // so there is no chain-integrity / audibility check to run. II
      // (a grid device) reads the grid for free during get_preset and
      // attaches chain_integrity; AM4 has nothing to attach.
      chain_integrity: 'AM4 is a linear 4-slot device with no routing grid; no chain-integrity check applies.',
      // AM4 get_preset reflects the active scene only (v1 scope) and
      // does not serialize the per-scene channel/bypass table.
      scenes: 'AM4 get_preset is active-scene-only (v1); per-scene table not serialized.',
      // Routing edges are never read (routing_omitted: true in _meta).
      routing: 'AM4 has no routing grid; routing edges are not a concept.',
      // live_grid is the gen-3 live sub=0x2E routing-grid read; AM4 is a
      // linear 4-slot device with no grid, so there is no grid to read.
      live_grid: 'AM4 is a linear 4-slot device with no routing grid; the gen-3 live_grid read does not apply.',
      // live_meters rides the gen-3 sub=0x2E frame; AM4 has no such frame.
      live_meters: 'AM4 has no gen-3 sub=0x2E telemetry frame; live CPU/output meters do not apply.',
      // The preset name field is only populated when present; the AM4
      // reader omits the key entirely on the working-buffer snapshot.
      name: 'AM4 working-buffer snapshot does not read the preset name into the envelope.',
      // read_warnings is conditional on BOTH devices: present only when a
      // partial read fails. On a clean read neither device emits it.
      read_warnings: 'Conditional field, present only on a partial-read failure; absent on a clean read.',
    },
    presetSnapshotMeta: {
      // BUG-1 (2026-07-04): AM4 get_preset now always returns all four
      // channels, so there is no "channel state omitted" nudge to emit.
      // The hint was the omission signal; with nothing omitted it is
      // correctly absent. II still emits it (its default omits inactive Y).
      channel_state_hint: 'AM4 get_preset now returns all four channels (BUG-1 fix), so the "channel state omitted" nudge is never applicable.',
      // BK-081 (2026-07-09): the atomic whole-preset-image read path is
      // Axe-Fx-II-specific (the II's 0x77/0x78/0x79 preset-image dump);
      // AM4 has its own atomic read shape and does not emit this field.
      read_path: 'BK-081 atomic-image read-path field is Axe-Fx-II-specific; AM4 does not emit it.',
      image_read_fallback_reason: 'BK-081 atomic-image read-path field is Axe-Fx-II-specific; AM4 does not emit it.',
    },
    readResult: {},
  },
  'axe-fx-ii': {
    presetSnapshot: {
      // II get_preset is active-scene-only (v1 scope); per-scene table
      // and routing edges are deferred to a v2 PresetSnapshot field add.
      scenes: 'Axe-Fx II get_preset is active-scene-only (v1); per-scene table deferred to v2.',
      routing: 'Axe-Fx II routing edges are deferred to v2 (routing_omitted: true in _meta).',
      // live_grid is the gen-3 live sub=0x2E grid read; the Axe-Fx II is a
      // different (gen-2) codec with no sub=0x2E grid query.
      live_grid: 'Axe-Fx II is a gen-2 device; the gen-3 live_grid (fn=0x01 sub=0x2E) read does not apply.',
      // live_meters rides the gen-3 sub=0x2E frame; the gen-2 II has no such frame.
      live_meters: 'Axe-Fx II is a gen-2 device with no sub=0x2E telemetry frame; live CPU/output meters do not apply.',
      // read_warnings is conditional on BOTH devices: present only when a
      // partial read fails. On a clean read neither device emits it.
      read_warnings: 'Conditional field, present only on a partial-read failure; absent on a clean read.',
    },
    presetSnapshotMeta: {
      // channel_state_hint is emitted ONLY when channel state was omitted
      // AND a channel-bearing block is placed (the nudge toward
      // include_channel_state). The II mock fixture ('clean-scratch') has an
      // empty grid, so no channel-bearing block is placed and the hint is
      // legitimately absent here. AM4's mock places a channel-bearing block,
      // so it emits the hint and is held to the contract.
      channel_state_hint: 'Axe-Fx II mock has an empty grid (no channel-bearing block placed), so the omission nudge is legitimately absent; emitted on real presets with a channel-bearing block.',
      // current_location + is_dirty are surfaced by the AM4 reader (GAP-1,
      // 2026-07-04): the active stored-location pointer and the in-memory
      // dirty flag. The II reader does not yet read/track them, so it omits
      // them. Candidate to add to the II reader in a future pass.
      current_location: 'AM4-only (GAP-1): the II reader does not yet surface the active stored-location pointer.',
      is_dirty: 'AM4-only (GAP-1): the II reader does not yet surface a working-buffer dirty flag.',
    },
    readResult: {},
  },
  'axe-fx-iii': {
    presetSnapshot: {
      // Gen-3 get_preset is a block INVENTORY, not a positioned grid read:
      // no decoded grid-read exists, so there is no chain-integrity check.
      chain_integrity: 'Gen-3 get_preset is a block inventory (no decoded grid read); no chain-integrity check applies.',
      // The poll loop reads the active scene's placed blocks only; the
      // per-scene channel/bypass table is not serialized.
      scenes: 'Gen-3 get_preset is active-scene-only (block inventory); per-scene table not serialized.',
      // Slot indices are sequential placeholders, not grid edges; routing is
      // never read (routing_omitted: true in _meta).
      routing: 'Gen-3 has no decoded grid/routing read; slot indices are sequential placeholders, not edges.',
      // Gen-3 get_preset (active buffer) now ISSUES a scene query (fn=0x0C `7F`)
      // and surfaces active_scene when the device answers — but the shipped mock
      // does not respond to the scene query, so active_scene is legitimately
      // omitted in THIS parity run (and present on real hardware).
      active_scene: 'Gen-3 get_preset issues a fn=0x0C scene query, but the parity mock does not answer it, so active_scene is omitted here (present on hardware).',
      // read_warnings IS declared by the gen-3 reader (it always attaches the
      // block-inventory caveat), so it is NOT allow-listed here.
    },
    presetSnapshotMeta: {
      // The gen-3 reader has no second-channel read leg, so both_channels_read
      // is never set (channel_state_omitted: true instead).
      both_channels_read: 'Gen-3 reader has no second-channel read leg; channel state is omitted, never read for both channels.',
      // channel_state_hint is an Axe-Fx II-specific nudge field; the gen-3
      // reader does not emit it.
      channel_state_hint: 'Gen-3 reader does not emit the Axe-Fx II include_channel_state nudge; channel state is uniformly omitted in the block-inventory snapshot.',
      // current_location + is_dirty are AM4-only for now (GAP-1, 2026-07-04);
      // the gen-3 reader does not read the active-location pointer or track a
      // dirty flag.
      current_location: 'AM4-only (GAP-1): the gen-3 reader does not surface the active stored-location pointer.',
      is_dirty: 'AM4-only (GAP-1): the gen-3 reader does not surface a working-buffer dirty flag.',
      // BK-081 (2026-07-09): the atomic whole-preset-image read path is
      // Axe-Fx-II-specific; the gen-3 reader has its own atomic block-
      // inventory read shape and does not emit this field.
      read_path: 'BK-081 atomic-image read-path field is Axe-Fx-II-specific; the gen-3 reader does not emit it.',
      image_read_fallback_reason: 'BK-081 atomic-image read-path field is Axe-Fx-II-specific; the gen-3 reader does not emit it.',
    },
    readResult: {
      // The gen-3 reader projects a value out of the bulk-read burst and does
      // not attach the raw device-response frame the AM4 / Axe-Fx II readers
      // include. The wire value is already surfaced as `wire_value`.
      raw_response: 'Gen-3 projectParam reports wire_value out of the bulk-read burst without attaching the raw device frame; the wire value is surfaced via wire_value.',
    },
  },
};

// ── Shape assertion engine ───────────────────────────────────────────

function assertShape(
  deviceId: string,
  surfaceLabel: string,
  obj: Record<string, unknown>,
  contract: ShapeContract,
  omitAllowlist: Record<string, string>,
): void {
  const presentKeys = new Set(Object.keys(obj));

  // 1. Every required key must be present (key present; value may be
  //    undefined, but the property itself must exist on the object).
  for (const key of contract.required) {
    check(
      `${deviceId} ${surfaceLabel}: declares required field "${key}"`,
      key in obj,
      `present keys: [${[...presentKeys].join(', ')}]`,
    );
  }

  // 2. Every optional key is EITHER declared by this device OR explicitly
  //    allow-listed as an intentional omission (with a documented reason).
  //    A field that is neither declared nor allow-listed is a silent
  //    divergence -> FAIL.
  for (const key of contract.optional) {
    const declared = key in obj;
    const allowed = key in omitAllowlist;
    check(
      `${deviceId} ${surfaceLabel}: optional field "${key}" is declared or allow-listed`,
      declared || allowed,
      declared
        ? undefined
        : `not declared and NOT on ${deviceId}'s omit allowlist. Either the reader regressed (lost a field its sibling declares) or this is an intentional omission that must be added to ALLOWLIST['${deviceId}'].${surfaceLabel.includes('_meta') ? 'presetSnapshotMeta' : surfaceLabel.includes('ReadResult') ? 'readResult' : 'presetSnapshot'} with a reason.`,
    );
  }

  // 3. Allowlist hygiene: a device must not allow-list a field it actually
  //    declares (stale entry); that hides a future real regression.
  for (const key of Object.keys(omitAllowlist)) {
    check(
      `${deviceId} ${surfaceLabel}: omit-allowlist entry "${key}" is not stale (field is actually absent)`,
      !(key in obj),
      `field "${key}" IS declared by ${deviceId} but is also on its omit allowlist; remove the stale allowlist entry so a future omission is caught.`,
    );
  }

  // 4. No undeclared mystery keys outside the known contract universe.
  //    Catches a device adding a one-off field its sibling never gets
  //    (the inverse divergence direction). New shared fields must be
  //    added to the contract's optional set first.
  const known = new Set([...contract.required, ...contract.optional]);
  for (const key of presentKeys) {
    check(
      `${deviceId} ${surfaceLabel}: field "${key}" is part of the declared contract`,
      known.has(key),
      `"${key}" is emitted by ${deviceId} but not in the ${surfaceLabel} contract. If this is a real shared field, add it to the contract's optional[] so the sibling device is held to the same parity.`,
    );
  }
}

// ── Per-device runtime drivers ───────────────────────────────────────

interface DeviceRig {
  id: string;
  descriptor: DeviceDescriptor;
  connect: () => { send: (b: number[]) => void; close: () => void } & DispatchCtx['conn'];
  // A known (block, param) pair the mock responder can answer for getParam.
  getParamProbe: { block: string; name: string };
}

const RIGS: DeviceRig[] = [
  {
    id: 'am4',
    descriptor: AM4_DESCRIPTOR,
    connect: connectAM4,
    getParamProbe: { block: 'amp', name: 'gain' },
  },
  {
    id: 'axe-fx-ii',
    descriptor: AXEFX2_DESCRIPTOR,
    connect: connectAxeFxII,
    getParamProbe: { block: 'amp', name: 'bass' },
  },
  {
    // Gen-3 (Axe-Fx III): getPreset polls each block via fn=0x1F; the parity
    // mock answers a placed block (Reverb 1 = effect ID 66) with the
    // 0x74/0x75/0x76 state-broadcast burst and NACKs the rest. `reverb.mix`
    // (REVERB_MIX, paramId 0) projects a real value. The 0x75 body is
    // channel-blocked (index = channel × stride + paramId); the mock fills equal
    // values across channels, so the reader's channel-invariant path returns it.
    // The channel-varying projection (refuse-without-channel / read-with-channel)
    // is exercised in the dedicated reader unit test, not here.
    id: 'axe-fx-iii',
    descriptor: AXEFX3_DESCRIPTOR,
    connect: connectAxeFxIIIParityMock,
    getParamProbe: { block: 'reverb', name: 'mix' },
  },
];

// Register descriptors so resolveDevice-style lookups (and the param-kind
// resolvers imported above) are wired exactly as at server boot.
registerDevice(AXEFX2_DESCRIPTOR);
registerDevice(AM4_DESCRIPTOR);
registerDevice(AXEFX3_DESCRIPTOR);

const registeredIds = new Set(listRegisteredDevices().map((d) => d.id));
check(
  'AM4, Axe-Fx II, and Axe-Fx III descriptors registered',
  registeredIds.has('am4') && registeredIds.has('axe-fx-ii') && registeredIds.has('axe-fx-iii'),
  `registered: [${[...registeredIds].join(', ')}]`,
);

// A mock-coverage gap is a timeout / "no synthesized response" surfaced by
// the in-memory transport when a reader needs a wire shape the device's
// mock responder does not synthesize (the shipped AM4 mock has no fn 0x1F
// chunk-dump responder for getPreset; the II mock has no fn 0x02
// GET_BLOCK_PARAMETER responder for getParam). These are TEST-harness gaps,
// not product bugs, so we report them as NOTEs and do not fail the gate on
// them. They are distinct from a malformed response (which would resolve
// and then trip the shape assertions) and from any other thrown error
// (which DOES fail, since it is a real reader fault).
function isMockCoverageGap(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('no synthesized response')
    || msg.includes('no fn 0x74 header')
    || msg.includes('Timeout waiting for')
    || msg.includes('within 500ms')
    || msg.includes('within 800ms')
    || msg.includes('no_ack')
    || msg.includes('read failed on every placed block')
  );
}

// Tracks which surfaces actually produced a runtime response somewhere, so
// the final report can prove the gate is not a silent no-op.
const runtimeCoverage = {
  presetSnapshot: [] as string[],
  readResult: [] as string[],
};

function note(label: string, detail: string): void {
  console.log(`  NOTE -- ${label}: ${detail}`);
}

async function driveDevice(rig: DeviceRig): Promise<void> {
  console.log(`\n[${rig.id}] runtime response-shape assertions`);
  const conn = rig.connect();
  const ctx: DispatchCtx = { conn, descriptor: rig.descriptor };

  const allow = ALLOWLIST[rig.id];
  if (allow === undefined) {
    check(`${rig.id}: has an ALLOWLIST entry`, false, 'add an allowlist (even if empty) so omissions are explicit');
    conn.close();
    return;
  }

  try {
    // ── get_preset (PresetSnapshot) ──────────────────────────────────
    if (rig.descriptor.reader.getPreset === undefined) {
      check(`${rig.id}: reader implements getPreset`, false, 'no getPreset on reader');
    } else {
      let snapshot: PresetSnapshot | undefined;
      try {
        snapshot = await rig.descriptor.reader.getPreset(ctx);
      } catch (err) {
        if (isMockCoverageGap(err)) {
          note(
            `${rig.id} PresetSnapshot`,
            `getPreset not runtime-drivable against the shipped mock (mock-coverage gap, not a reader fault): ${err instanceof Error ? err.message : String(err)}`,
          );
        } else {
          check(
            `${rig.id}: getPreset(ctx) resolves against mock transport`,
            false,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (snapshot !== undefined) {
        check(`${rig.id}: getPreset(ctx) resolves against mock transport`, true);
        runtimeCoverage.presetSnapshot.push(rig.id);

        assertShape(
          rig.id,
          'PresetSnapshot',
          snapshot as unknown as Record<string, unknown>,
          PRESET_SNAPSHOT_CONTRACT,
          allow.presetSnapshot,
        );

        // _meta is itself a contracted sub-envelope.
        const meta = (snapshot as unknown as Record<string, unknown>)._meta;
        if (meta && typeof meta === 'object') {
          assertShape(
            rig.id,
            'PresetSnapshot._meta',
            meta as Record<string, unknown>,
            PRESET_SNAPSHOT_META_CONTRACT,
            allow.presetSnapshotMeta,
          );
        } else {
          check(`${rig.id}: PresetSnapshot._meta is an object`, false, `got ${typeof meta}`);
        }
      }
    }

    // ── get_param (ReadResult) ───────────────────────────────────────
    if (rig.descriptor.reader.getParam === undefined) {
      check(`${rig.id}: reader implements getParam`, false, 'no getParam on reader');
    } else {
      let read: ReadResult | undefined;
      try {
        read = await rig.descriptor.reader.getParam(
          ctx,
          rig.getParamProbe.block,
          rig.getParamProbe.name,
        );
      } catch (err) {
        if (isMockCoverageGap(err)) {
          note(
            `${rig.id} ReadResult`,
            `getParam not runtime-drivable against the shipped mock (mock-coverage gap, not a reader fault): ${err instanceof Error ? err.message : String(err)}`,
          );
        } else {
          check(
            `${rig.id}: getParam(${rig.getParamProbe.block}.${rig.getParamProbe.name}) resolves against mock transport`,
            false,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      if (read !== undefined) {
        check(
          `${rig.id}: getParam(${rig.getParamProbe.block}.${rig.getParamProbe.name}) resolves against mock transport`,
          true,
        );
        runtimeCoverage.readResult.push(rig.id);

        assertShape(
          rig.id,
          'ReadResult',
          read as unknown as Record<string, unknown>,
          READ_RESULT_CONTRACT,
          allow.readResult,
        );
      }
    }
  } finally {
    conn.close();
  }
}

// ── Not-applicable devices: report, do not silently skip ─────────────
//
// Hydrasynth (patch model, no slot/scene get_preset) does not implement the
// PresetSnapshot contract. We surface it explicitly so a future reader
// addition is a reminder to extend this gate, not an undetected gap. (FM3 /
// FM9 share the gen-3 codec + reader with the Axe-Fx III rig; the III rig
// holds that shared shape to the contract.)

function reportNotApplicable(): void {
  console.log('\n[not-applicable] devices outside the PresetSnapshot/ReadResult parity contract:');
  const covered = new Set(RIGS.map((r) => r.id));
  for (const d of listRegisteredDevices()) {
    if (covered.has(d.id)) continue;
    const hasGetPreset = d.reader?.getPreset !== undefined;
    console.log(
      `  - ${d.id}: getPreset ${hasGetPreset ? 'IMPLEMENTED (extend this gate!)' : 'not implemented'} (declared-only, not runtime-asserted here).`,
    );
    // If a non-rig device suddenly implements getPreset, force a failure
    // so the gate is extended rather than silently under-covering.
    check(
      `${d.id}: not-applicable device does not silently gain an unverified getPreset`,
      !hasGetPreset,
      `${d.id} now implements getPreset but is not in RIGS; add it so its response shape is held to parity.`,
    );
  }
}

// ── Runtime-coverage floor ───────────────────────────────────────────
//
// Guards against the gate degrading into a silent no-op. Every RIG device
// has a mock responder that synthesizes both surfaces (AM4 fn 0x1F triple
// for getPreset + fn 0x01 short-read for getParam; II fn 0x20/0x0f for
// getPreset + fn 0x02 GET for getParam), so EVERY rig must produce BOTH a
// runtime PresetSnapshot and a runtime ReadResult. Requiring every rig
// (not just "at least one") makes a mock-responder regression a hard FAIL:
// if a device's getPreset/getParam mock breaks, its shape stops being
// asserted on live data, and previously that silently degraded to a NOTE
// while the sibling carried the gate. The per-device responders exist
// precisely so neither half is exercised only-by-proxy.
const PRESET_MOCK_HINT: Record<string, string> = {
  am4: 'am4MockResponder fn 0x1F triple',
  'axe-fx-ii': 'mockAxeFxIIConnection fn 0x20/0x0f',
  'axe-fx-iii': 'parityMock fn 0x1F → 0x74/0x75/0x76 broadcast burst',
};
const READ_MOCK_HINT: Record<string, string> = {
  am4: 'am4MockResponder fn 0x01 short-read',
  'axe-fx-ii': 'mockAxeFxIIConnection fn 0x02 GET',
  'axe-fx-iii': 'parityMock fn 0x1F → 0x74/0x75/0x76 broadcast burst',
};

function assertRuntimeFloor(): void {
  const expected = RIGS.map((r) => r.id);
  for (const id of expected) {
    check(
      `${id} produced a runtime PresetSnapshot for shape assertion`,
      runtimeCoverage.presetSnapshot.includes(id),
      `runtime PresetSnapshot coverage: [${runtimeCoverage.presetSnapshot.join(', ') || 'none'}]. ${id} did not produce a snapshot — its getPreset mock responder regressed (see ${PRESET_MOCK_HINT[id] ?? `${id} mock responder`}); the shape contract is no longer exercised on ${id} live data.`,
    );
    check(
      `${id} produced a runtime ReadResult for shape assertion`,
      runtimeCoverage.readResult.includes(id),
      `runtime ReadResult coverage: [${runtimeCoverage.readResult.join(', ') || 'none'}]. ${id} did not produce a ReadResult — its getParam mock responder regressed (see ${READ_MOCK_HINT[id] ?? `${id} mock responder`}); the shape contract is no longer exercised on ${id} live data.`,
    );
  }
}

// ── Gen-3 channel-blocked projection ─────────────────────────────────
//
// The 0x75 body packs four channel copies of every paramId (index = channel ×
// stride + paramId, stride = itemCount/4). This drives the reader with a mock
// whose value is distinct per channel (1000 + channelIndex), so:
//   - get_param without a channel must REFUSE (the copies differ), and
//   - get_param WITH a channel must return exactly that channel's copy.
// The mock itemCount is 256 → stride 64; channel c copy of any paramId P sits at
// index c×64 + P and carries wire value 1000 + c.
async function assertGen3ChannelStride(): Promise<void> {
  console.log('\n[axe-fx-iii] gen-3 channel-blocked read projection');
  const MOCK_STRIDE = 64;
  const conn = connectAxeFxIIIParityMockWith((_eff, index) => 1000 + Math.floor(index / MOCK_STRIDE));
  const ctx: DispatchCtx = { conn, descriptor: AXEFX3_DESCRIPTOR };
  const reader = AXEFX3_DESCRIPTOR.reader;
  try {
    if (reader.getParam === undefined) {
      check('axe-fx-iii: reader implements getParam', false, 'no getParam');
      return;
    }
    // 1) No channel + per-channel difference → refuse (not a silent guess).
    let refused = false;
    let detail = 'getParam returned a value instead of refusing';
    try {
      await reader.getParam(ctx, 'amp', 'drive');
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
      refused = /differs across channels/.test(detail);
    }
    check('axe-fx-iii: get_param(amp.drive) without a channel refuses when channels differ', refused, detail);

    // 2) Explicit channel → that channel's copy (channel c carries wire 1000+c).
    for (const c of [0, 2]) {
      let wire: number | undefined;
      let err2 = '';
      try {
        wire = (await reader.getParam(ctx, 'amp', 'drive', c)).wire_value;
      } catch (e) {
        err2 = e instanceof Error ? e.message : String(e);
      }
      check(
        `axe-fx-iii: get_param(amp.drive, channel ${c}) reads channel ${c}'s copy (wire ${1000 + c})`,
        wire === 1000 + c,
        err2 || `got wire ${wire}, expected ${1000 + c}`,
      );
    }
  } finally {
    conn.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Register the not-applicable devices too so reportNotApplicable() can
  // confirm they have NOT silently grown a getPreset that would need
  // parity coverage. Dynamic import keeps the static import list focused
  // on the runtime-driven rigs.
  try {
    const { HYDRASYNTH_DESCRIPTOR } = await import('@mcp-midi-control/hydrasynth/descriptor.js');
    registerDevice(HYDRASYNTH_DESCRIPTOR);
  } catch (err) {
    note('hydrasynth', `descriptor not registered: ${err instanceof Error ? err.message : String(err)}`);
  }

  for (const rig of RIGS) {
    await driveDevice(rig);
  }

  await assertGen3ChannelStride();

  console.log('\n[coverage floor]');
  assertRuntimeFloor();

  reportNotApplicable();

  console.log(
    `\n[runtime coverage] PresetSnapshot: [${runtimeCoverage.presetSnapshot.join(', ') || 'none'}]; ` +
    `ReadResult: [${runtimeCoverage.readResult.join(', ') || 'none'}].`,
  );
  console.log(`\nverify-response-shape-parity: ${passes} OK, ${failures} FAIL.`);
  if (failures > 0) {
    process.exit(1);
  }
  process.exit(0);
}

void main();
