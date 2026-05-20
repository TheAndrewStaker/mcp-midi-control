/**
 * BK-057 dispatcher golden: `verify_chain` decoration on `executeApplyPreset`.
 *
 * Asserts:
 *   1. The `ChainIntegrityResult` type round-trips through the
 *      dispatcher (default trivial-pass for devices without verifyChain).
 *   2. AM4 (no verifyChain) returns `chain_integrity: {ok: true,
 *      breaks: [], summary: 'not applicable on Fractal AM4...'}` when
 *      verify_chain: true is requested.
 *   3. The summary string includes the device's display name so the
 *      agent reading the response knows which device skipped the check.
 *
 * Hardware-free: the test fakes a successful apply by stubbing the
 * descriptor's writer.applyPreset and verifies the wiring around it.
 *
 * Run: npx tsx scripts/verify-verify-chain.ts
 */

import { registerDevice, unregisterDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { registerConnector } from '@mcp-midi-control/core/server-shared/connections.js';
import { executeApplyPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import type {
  ApplyResult,
  DeviceDescriptor,
  PresetSpec,
} from '@mcp-midi-control/core/protocol-generic/types.js';

function stubConn(): MidiConnection {
  return {
    send: () => undefined,
    receiveSysEx: async () => { throw new Error('stub conn has no inbound'); },
    receiveSysExMatching: async () => { throw new Error('stub conn has no inbound'); },
    onMessage: () => () => undefined,
    hasInput: false,
    close: () => undefined,
  };
}

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `. ${detail}` : ''}`);
  }
}

// Minimal stub device descriptor — exposes one block (`amp`) with one
// param (`gain`) so preflight is happy. Writer.applyPreset returns ok=true
// without firing any wire op; the dispatcher should layer chain_integrity
// on top.
const STUB_NO_VERIFY: DeviceDescriptor = {
  id: 'stub-no-verify',
  display_name: 'Stub (no verifyChain)',
  port_match: [{ pattern: 'stub-no-verify' }],
  capabilities: {
    slot_model: 'linear',
    slot_count: 4,
    has_scenes: false,
    has_channels: false,
    supports_save: false,
    supports_factory_restore: false,
    supports_lineage: false,
  },
  canonical_terms: { preset: 'preset', location: 'slot', slot: 'slot', block: 'block', channel: 'channel', scene: 'scene' },
  blocks: {
    amp: {
      display_name: 'Amp',
      params: {
        gain: {
          display_name: 'Gain',
          unit: 'knob',
          display_min: 0,
          display_max: 10,
          encode: (v) => Number(v),
          decode: (v) => v,
        },
      },
    },
  },
  reader: {
    async getParam() { throw new Error('not implemented'); },
    async getParams() { throw new Error('not implemented'); },
  },
  writer: {
    buildSetParam: () => [],
    async applyPreset(_ctx, _spec, _target): Promise<ApplyResult> {
      return { ok: true, steps: 0, duration_ms: 1 };
    },
    // No verifyChain — dispatcher should generate the trivial-pass shape.
  },
};

const STUB_VERIFY_OK: DeviceDescriptor = {
  ...STUB_NO_VERIFY,
  id: 'stub-verify-ok',
  display_name: 'Stub (verifyChain pass)',
  port_match: [{ pattern: 'stub-verify-ok' }],
  writer: {
    buildSetParam: () => [],
    async applyPreset(): Promise<ApplyResult> {
      return { ok: true, steps: 0, duration_ms: 1 };
    },
    async verifyChain() {
      return {
        ok: true,
        breaks: [],
        summary: 'verify_chain: chain intact (stub)',
        extra_round_trips: 1,
      };
    },
  },
};

const STUB_VERIFY_FAIL: DeviceDescriptor = {
  ...STUB_NO_VERIFY,
  id: 'stub-verify-fail',
  display_name: 'Stub (verifyChain fail)',
  port_match: [{ pattern: 'stub-verify-fail' }],
  writer: {
    buildSetParam: () => [],
    async applyPreset(): Promise<ApplyResult> {
      return { ok: true, steps: 0, duration_ms: 1 };
    },
    async verifyChain() {
      return {
        ok: false,
        breaks: [{ slot_ref: { row: 2, col: 3 }, reason: 'stub-induced break' }],
        summary: 'verify_chain: 1 broken cable on row 2',
        extra_round_trips: 1,
      };
    },
  },
};

const spec: PresetSpec = {
  slots: [{ slot: 1, block_type: 'amp', params: { gain: 5 } }],
};

async function run() {
  registerConnector(STUB_NO_VERIFY.id, stubConn);
  registerConnector(STUB_VERIFY_OK.id, stubConn);
  registerConnector(STUB_VERIFY_FAIL.id, stubConn);
  registerDevice(STUB_NO_VERIFY);
  registerDevice(STUB_VERIFY_OK);
  registerDevice(STUB_VERIFY_FAIL);

  console.log('Case 1: device without verifyChain + verify_chain: true → trivial-pass shape');
  {
    const result = await executeApplyPreset({
      port: 'stub-no-verify',
      spec,
      verify_chain: true,
    });
    check('ok=true (apply succeeded)', result.ok === true);
    check(
      `chain_integrity is present, got ${JSON.stringify(result.chain_integrity)}`,
      result.chain_integrity !== undefined,
    );
    check(
      `chain_integrity.ok=true (trivial pass)`,
      result.chain_integrity?.ok === true,
    );
    check(
      `chain_integrity.breaks is empty array`,
      Array.isArray(result.chain_integrity?.breaks) && result.chain_integrity!.breaks.length === 0,
    );
    check(
      `chain_integrity.summary mentions device name, got ${JSON.stringify(result.chain_integrity?.summary)}`,
      typeof result.chain_integrity?.summary === 'string' &&
        result.chain_integrity!.summary.includes(STUB_NO_VERIFY.display_name),
    );
    check(
      `chain_integrity.extra_round_trips=0 for trivial pass`,
      result.chain_integrity?.extra_round_trips === 0,
    );
  }

  console.log('\nCase 2: device WITH verifyChain (pass) + verify_chain: true → pass shape');
  {
    const result = await executeApplyPreset({
      port: 'stub-verify-ok',
      spec,
      verify_chain: true,
    });
    check('chain_integrity present', result.chain_integrity !== undefined);
    check('chain_integrity.ok=true', result.chain_integrity?.ok === true);
    check(
      `summary echoes stub text, got ${JSON.stringify(result.chain_integrity?.summary)}`,
      result.chain_integrity?.summary === 'verify_chain: chain intact (stub)',
    );
  }

  console.log('\nCase 3: device WITH verifyChain (fail) + verify_chain: true → fail shape');
  {
    const result = await executeApplyPreset({
      port: 'stub-verify-fail',
      spec,
      verify_chain: true,
    });
    check('chain_integrity present', result.chain_integrity !== undefined);
    check('chain_integrity.ok=false', result.chain_integrity?.ok === false);
    check('chain_integrity.breaks has 1 entry', result.chain_integrity?.breaks.length === 1);
  }

  console.log('\nCase 4: verify_chain omitted (default) → no chain_integrity field');
  {
    const result = await executeApplyPreset({
      port: 'stub-verify-ok',
      spec,
      // verify_chain not passed
    });
    check('chain_integrity is omitted', result.chain_integrity === undefined);
  }

  console.log('\nCase 5: verify_chain: false → no chain_integrity field');
  {
    const result = await executeApplyPreset({
      port: 'stub-verify-ok',
      spec,
      verify_chain: false,
    });
    check('chain_integrity is omitted', result.chain_integrity === undefined);
  }

  unregisterDevice(STUB_NO_VERIFY.id);
  unregisterDevice(STUB_VERIFY_OK.id);
  unregisterDevice(STUB_VERIFY_FAIL.id);

  console.log(`\n${failed === 0 ? 'all cases pass' : `${failed} case(s) failed`}.`);
  if (failed > 0) process.exit(1);
}

void run();
