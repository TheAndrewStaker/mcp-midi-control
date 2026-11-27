/**
 * AM4 fw 2.02 / AM4-Edit 1.00.09 scale + precision anchors.
 *
 * Read anchors are wire values read live on 2026-11-26 (preset Y2, amp
 * Plexi 100W High) next to the value AM4-Edit's expert pages showed for the
 * same control. Write anchors pin the `encodeScale` corrections taken from
 * the editor cache's per-record display scale (`c`): before them a write of
 * Speaker Low Reso 6 stored 0.6 and the panel showed 0.25 (hardware, same day).
 */
import { decode, encode, roundDisplayValue, KNOWN_PARAMS } from '../../src/am4/index.js';

type Key = keyof typeof KNOWN_PARAMS;

const reads: Array<{ key: Key; wire: number; shown: number }> = [
  { key: 'amp.preamp_bias', wire: 0.5388042847987304, shown: 0.078 },
  { key: 'amp.harmonics', wire: 0.48280281991027557, shown: 0.483 },
  { key: 'amp.negative_fb', wire: 0.5299996948149053, shown: 5.3 },
  { key: 'amp.b_plus_time_constant', wire: 0.43752861110263375, shown: 7.5 },
  { key: 'amp.grid_bias', wire: 0.44500564592425307, shown: 44.5 },
  { key: 'amp.xformer_low_freq', wire: 0.2631763664662618, shown: 16.8 },
  { key: 'amp.cab_dynacab_z_1', wire: 0.10499893185216834, shown: 2.52 },
  // typecode 66 (0x42) is log10: linear would give 38345 and 364.
  { key: 'amp.high_cut_frequency', wire: 0.9582201605273598, shown: 32999 },
  { key: 'amp.depth_freq', wire: 0.6989654225287637, shown: 250 },
  { key: 'amp.low_reso', wire: 0.5288, shown: 5.29 },
  // A percent range starting at 0.1 keeps percent's one decimal (live read 2026-11-26).
  { key: 'tremolo.shape', wire: 0.7504959257789849, shown: 75 },
  // typecode-80 knob: the register IS the knob position (AM4-Edit 3.01).
  { key: 'rotary.drive', wire: 0.3010345774712363, shown: 3.01 },
];

// display -> internal (the MESSAGE_SET value) = display / cache scale c.
const writes: Array<{ key: Key; display: number; internal: number }> = [
  { key: 'amp.low_reso', display: 6, internal: 14.4 },
  { key: 'amp.hi_reso', display: 7.5, internal: 18 },
  { key: 'amp.spkr_drive', display: 10, internal: 5 },
  { key: 'amp.definition', display: 10, internal: 0.316228 },
  { key: 'amp.cab_dynacab_z_1', display: 2.52, internal: 0.105 },
  { key: 'phaser.feedback', display: 50, internal: 0.450045 },
  { key: 'phaser.tone', display: -10, internal: -0.316228 },
  { key: 'filter.sweep_shape', display: 10, internal: 2 },
  { key: 'tremolo.trigger_phase', display: 180, internal: Math.PI / 2 },
  { key: 'drive.sample_rate', display: 48000, internal: 1 },
  // typecode 80: knob position 3.01 <-> internal 0.4 (AM4-Edit, rotary Drive, 2026-11-26).
  { key: 'rotary.drive', display: 3.0103, internal: 0.4 },
  { key: 'rotary.drive', display: 0, internal: 0.05 },
  { key: 'flanger.bass_focus', display: 10, internal: 2000 },
  // Unit default still applies where the cache scale matches it.
  { key: 'amp.gain', display: 6, internal: 0.6 },
];

const close = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-4);

export function runAm4Fw202ScaleTests(): void {
  const failed: string[] = [];
  for (const c of reads) {
    const p = KNOWN_PARAMS[c.key];
    const got = roundDisplayValue(p, decode(p, c.wire));
    if (got !== c.shown) failed.push(`read ${c.key} wire ${c.wire}: expected ${c.shown} (AM4-Edit), got ${got}`);
  }
  for (const c of writes) {
    const got = encode(KNOWN_PARAMS[c.key], c.display);
    if (!close(got, c.internal)) failed.push(`write ${c.key} ${c.display}: expected internal ${c.internal}, got ${got}`);
  }
  const phaserOrder = KNOWN_PARAMS['phaser.order'];
  if (phaserOrder.unit !== 'enum' || phaserOrder.enumValues?.[1] !== '4') {
    failed.push('phaser.order must be the cache enum 2/4/6/8/10/12 (ordinal 1 = "4")');
  }
  if (KNOWN_PARAMS['flanger.auto_depth'].enumValues?.[3] !== 'HIGH') {
    failed.push('flanger.auto_depth must be OFF/LOW/MED/HIGH');
  }
  // Rosters checked against AM4-Edit through UI Automation (2026-11-26).
  const rosters: Array<[Key, number, string]> = [
    ['amp.dynacab_1_cab', 23, '2x12 5153 Stealth'], // editor "24: 2x12 5153 Stealth"
    ['amp.dynacab_1_cab', 24, '2x12 65 Bassguy'],
    ['reverb.low_cut_slope', 0, '6 dB/OCT'],
    ['reverb.predly_tap', 1, 'OUTPUT'],
    ['gate.knee', 0, 'Hard'],
    ['volpan.input_select', 1, 'Left Only'],
  ];
  for (const [key, i, name] of rosters) {
    const got = (KNOWN_PARAMS[key].enumValues as Record<number, string> | undefined)?.[i];
    if (got !== name) failed.push(`roster ${key}[${i}]: expected "${name}", got "${got}"`);
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} AM4 fw 2.02 scale case(s) failed:\n` + failed.join('\n'));
  }
}

export const AM4_FW202_SCALE_CASE_COUNT = reads.length + writes.length + 2 + 6;
