// verify-am4-cab-polish.ts
//
// Golden for BK-103b: the AM4 apply executor ENFORCES the mix-ready
// cab-polish defaults (low cut 80 Hz, high cut 6500 Hz, 12 dB/OCT slopes,
// room 8%) on every amp channel a fresh build writes, unless the spec
// expresses any cab opinion of its own.
//
// Why executor-level and not guidance: the 2026-07-16 bench test built a
// fresh FRFR preset via apply_preset and the device read back wide open
// (20 Hz / 20 kHz / 6 dB/OCT / 0% room) - the cab_polish guidance topic
// never fired because nothing forces the model to have read it. Explicit
// spec values always win; the response carries `auto_applied` with a
// relay-ready note + undo phrase.
//
// Offline op-emission check: prepared write list only, no MIDI I/O.
//
// Run: npx tsx scripts/verify-am4-cab-polish.ts

import {
  prepareApplyPresetWrites,
  type ApplyPresetPreparedWrite,
} from '@mcp-midi-control/am4/tools/applyExecutor.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   -- ${label}`);
  } else {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

type ParamWrite = Extract<ApplyPresetPreparedWrite, { kind: 'param' }>;
type ChannelWrite = Extract<ApplyPresetPreparedWrite, { kind: 'channel' }>;

const CAB_NAMES = ['master_low_cut', 'cab_master_high_cut', 'master_low_slope', 'master_high_slope', 'room_level'];

const cabWrites = (prepared: ApplyPresetPreparedWrite[]): ParamWrite[] =>
  prepared.filter(
    (p): p is ParamWrite => p.kind === 'param' && p.block === 'amp' && CAB_NAMES.includes(p.paramName),
  );

// ── Case 1: fresh flat-params amp build → defaults injected on channel A ──
console.log('Case 1: fresh flat-params amp build injects the defaults');
{
  const { prepared, cabPolish } = prepareApplyPresetWrites({
    slots: [{ position: 1, block_type: 'amp', params: { type: 'Brit Silver', gain: 4 } }],
  });
  const cab = cabWrites(prepared);
  check('all 5 cab-polish params injected', cab.length === 5, `got ${cab.map((c) => c.paramName).join(',')}`);
  const typeIdx = prepared.findIndex((p) => p.kind === 'param' && p.block === 'amp' && p.paramName === 'type');
  const firstCabIdx = prepared.findIndex((p) => p.kind === 'param' && CAB_NAMES.includes((p as ParamWrite).paramName));
  check('cab writes come AFTER the amp type write (Amp->DynaCab reset trap)', typeIdx !== -1 && firstCabIdx > typeIdx);
  check('cabPolish reported with channel A', cabPolish !== undefined && cabPolish.channels.length === 1 && cabPolish.channels[0] === 'A');
  check('cabPolish note carries the undo phrase', cabPolish !== undefined && /wide open/i.test(cabPolish.note));
  const lowCut = cab.find((c) => c.paramName === 'master_low_cut');
  const highCut = cab.find((c) => c.paramName === 'cab_master_high_cut');
  check('low cut resolves to 80 Hz display', lowCut !== undefined && lowCut.display === '80');
  check('high cut resolves to 6500 Hz display', highCut !== undefined && highCut.display === '6500');
}

// ── Case 2: explicit cab param anywhere suppresses ALL injection ──
console.log('Case 2: any explicit cab opinion suppresses injection');
{
  const { prepared, cabPolish } = prepareApplyPresetWrites({
    slots: [{ position: 1, block_type: 'amp', params: { type: 'Brit Silver', master_low_cut: 100 } }],
  });
  const cab = cabWrites(prepared);
  check('only the explicit cab write is present', cab.length === 1 && cab[0].paramName === 'master_low_cut');
  check('cabPolish is undefined', cabPolish === undefined);
}

// ── Case 3: bypassed cab section suppresses (4CM / real-cab case) ──
console.log('Case 3: cab_section BYPASSED suppresses injection');
{
  const { prepared, cabPolish } = prepareApplyPresetWrites({
    slots: [{ position: 1, block_type: 'amp', params: { type: 'Brit Silver', cab_section: 'BYPASSED' } }],
  });
  check('no cut/room writes injected', cabWrites(prepared).length === 0);
  check('cabPolish is undefined', cabPolish === undefined);
}

// ── Case 4: per-channel build → injected inside EACH written channel window ──
console.log('Case 4: channels map injects per written channel, inside its window');
{
  const { prepared, cabPolish } = prepareApplyPresetWrites({
    slots: [{
      position: 1,
      block_type: 'amp',
      channels: {
        A: { type: 'Brit Silver', gain: 4 },
        B: { type: '5153 100W Blue', gain: 7 },
      },
    }],
  });
  const cab = cabWrites(prepared);
  check('10 cab writes total (5 per channel)', cab.length === 10, `got ${cab.length}`);
  check('cabPolish reports channels A and B', cabPolish !== undefined && cabPolish.channels.join(',') === 'A,B');
  // Window check: every cab write must come after the most recent channel
  // switch AND after that window's type write.
  const chanIdxs = prepared
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.kind === 'channel' && (p as ChannelWrite).block === 'amp');
  check('two amp channel switches emitted', chanIdxs.length === 2);
  if (chanIdxs.length === 2) {
    const [aSwitch, bSwitch] = chanIdxs.map(({ i }) => i);
    const aCab = prepared.slice(aSwitch, bSwitch).filter((p) => p.kind === 'param' && CAB_NAMES.includes((p as ParamWrite).paramName));
    const bCab = prepared.slice(bSwitch).filter((p) => p.kind === 'param' && CAB_NAMES.includes((p as ParamWrite).paramName));
    check('5 cab writes inside channel A window', aCab.length === 5, `got ${aCab.length}`);
    check('5 cab writes inside channel B window', bCab.length === 5, `got ${bCab.length}`);
  }
}

// ── Case 5: bare amp placement still gets defaults, pinned to channel A ──
console.log('Case 5: bare amp placement (no params) pins channel A + injects');
{
  const { prepared, cabPolish } = prepareApplyPresetWrites({
    slots: [{ position: 1, block_type: 'amp' }],
  });
  const cab = cabWrites(prepared);
  check('5 cab writes injected', cab.length === 5, `got ${cab.length}`);
  const chanIdx = prepared.findIndex((p) => p.kind === 'channel' && (p as ChannelWrite).block === 'amp');
  const firstCabIdx = prepared.findIndex((p) => p.kind === 'param' && CAB_NAMES.includes((p as ParamWrite).paramName));
  check('channel A pinned before the injected writes', chanIdx !== -1 && chanIdx < firstCabIdx);
  check('cabPolish reports channel A', cabPolish !== undefined && cabPolish.channels.join(',') === 'A');
}

// ── Case 6: non-amp build injects nothing ──
console.log('Case 6: non-amp build injects nothing');
{
  const { prepared, cabPolish } = prepareApplyPresetWrites({
    slots: [{ position: 1, block_type: 'drive', params: { type: 'T808 OD', gain: 5 } }],
  });
  check('no cab writes', cabWrites(prepared).length === 0);
  check('cabPolish is undefined', cabPolish === undefined);
}

// ── Case 7: scene levels always initialized; unknown-offset amp -> 0 dB reset ──
console.log('Case 7: scene levels reset to 0 on a fresh build (amp without corpus offset)');
{
  const { prepared, sceneLevels } = prepareApplyPresetWrites({
    slots: [{ position: 1, block_type: 'amp', params: { type: 'Friedman BE', gain: 5.5 } }],
  });
  const levelWrites = prepared.filter(
    (p): p is ParamWrite => p.kind === 'param' && p.block === 'preset' && /^scene_[1-4]_level$/.test(p.paramName),
  );
  check('all 4 scene-level writes emitted', levelWrites.length === 4, `got ${levelWrites.length}`);
  check('source is reset (Friedman BE has no corpus offset)', sceneLevels.source === 'reset');
  check('all values 0.0 dB', Object.values(sceneLevels.values).every((v) => v === '0.0 dB'));
  check('note explains stale-trim reset', /stale/i.test(sceneLevels.note));
}

// ── Case 8: corpus-known amps per scene -> data-driven starting trims ──
console.log('Case 8: per-amp offset starting trims (Brit Silver +1 vs Plexi 100W High +4)');
{
  const { sceneLevels } = prepareApplyPresetWrites({
    slots: [{
      position: 1,
      block_type: 'amp',
      channels: {
        A: { type: 'Brit Silver' },        // corpus offset +1 dB
        B: { type: 'Plexi 100W High' },    // corpus offset +4 dB (loudest = reference)
      },
    }],
    scenes: [
      { index: 1, channels: { amp: 'A' } },
      { index: 2, channels: { amp: 'B' } },
      // scenes 3-4 unlisted -> default to channel A
    ],
  });
  check('source is amp_offsets', sceneLevels.source === 'amp_offsets', sceneLevels.source);
  check('scene 1 (Brit Silver) lifted +3.0 dB toward the Plexi', sceneLevels.values.scene_1_level === '3.0 dB', sceneLevels.values.scene_1_level);
  check('scene 2 (Plexi, loudest) stays 0.0 dB reference', sceneLevels.values.scene_2_level === '0.0 dB', sceneLevels.values.scene_2_level);
  check('unlisted scenes 3-4 (default channel A) also +3.0 dB', sceneLevels.values.scene_3_level === '3.0 dB' && sceneLevels.values.scene_4_level === '3.0 dB');
  check('note labels trims unverified + points at measure_loudness', /UNVERIFIED/.test(sceneLevels.note) && /measure_loudness/.test(sceneLevels.note));
}

// ── Case 9: no amp placed -> plain reset ──
console.log('Case 9: no amp placed still resets scene levels');
{
  const { sceneLevels } = prepareApplyPresetWrites({
    slots: [{ position: 1, block_type: 'drive', params: { type: 'T808 OD' } }],
  });
  check('source is reset', sceneLevels.source === 'reset');
  check('all values 0.0 dB', Object.values(sceneLevels.values).every((v) => v === '0.0 dB'));
}

console.log('');
if (failures > 0) {
  console.error(`verify-am4-cab-polish: ${failures} failure(s)`);
  process.exit(1);
}
console.log('verify-am4-cab-polish: all checks passed');
