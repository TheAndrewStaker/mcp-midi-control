/**
 * Gen-3 per-device block INSTANCE LIMITS: how many of each block a unit
 * actually lets you place (Amp 1 and Amp 2 on an FM9, one Amp on an FM3).
 *
 * The effect-id table (fractal-midi blockTypes.ts) reserves 4 ids for most
 * families on every gen-3 model, so `resolveEffectId('amp', 3)` happily
 * returns 60 on an FM3. The unit then ignores the insert without a 0x64
 * rejection, and the build reports a block that does not exist. These limits
 * let apply_preset / set_block refuse such a spec BEFORE anything is sent.
 *
 * SOURCES (labelled per device; neither is our own hardware run):
 *  - FM9 fw 12: fractone (GreyManSoftware, MIT) Catalog/fm9-12-hardware-block-
 *    instances.json, commit cb2d0b9: each instance isolated, placed at r1c1 and
 *    read back from the FM9 grid ("accepted": true/false). HARDWARE evidence.
 *    The highest accepted instance is the limit, except Mixer: 1, 2 and 4 were
 *    accepted and 3 was not (a probe artifact; ForgeFX also lists 4), so the
 *    limit is 4. Megatap is absent from that probe; ForgeFX's 2 is used.
 *  - FM3 and Axe-Fx III: ForgeFX (sKuhLight, MIT) server/src/devices.ts
 *    `instanceLimits` (~L759-800, commit 7163831), each unlisted family = 1.
 *    The FM3 table is ForgeFX's field-tested FM3 driver; the III table has no
 *    hardware report we know of. UNVERIFIED by us.
 *  - VP4: serial, no placement; not covered.
 *
 * A family absent from a device's table is limited to 1 instance.
 */

/** Evidence label for a device's limit table. */
export type InstanceLimitEvidence = 'fm9-hardware-fractone' | 'forgefx-unverified';

interface LimitTable {
  readonly evidence: InstanceLimitEvidence;
  readonly limits: Readonly<Record<string, number>>;
}

const FM9_LIMITS: LimitTable = {
  evidence: 'fm9-hardware-fractone',
  limits: {
    input: 4, output: 3, compressor: 2, graphic_eq: 4, parametric_eq: 4, amp: 2, cab: 2,
    reverb: 2, delay: 2, multitap_delay: 2, chorus: 2, flanger: 2, rotary: 2, phaser: 2,
    wah: 2, formant: 2, volume_pan: 4, pan_tremolo: 2, pitch: 1, filter: 4, drive: 3,
    enhancer: 2, mixer: 4, synth: 1, crossover: 2, gate_expander: 4, ring_modulator: 1,
    multiband_compressor: 2, ten_tap_delay: 2, resonator: 2, looper: 1, plex_delay: 1,
    send: 2, return: 2, multiplexer: 2, megatap_delay: 2,
  },
};

const FM3_LIMITS: LimitTable = {
  evidence: 'forgefx-unverified',
  limits: {
    input: 2, output: 2, drive: 2, compressor: 2, graphic_eq: 2, parametric_eq: 2, filter: 4,
    volume_pan: 2, gate_expander: 2, mixer: 4, multiplexer: 2, chorus: 2, flanger: 2, phaser: 2,
    rotary: 2, pan_tremolo: 2, wah: 2, formant: 2, enhancer: 2, resonator: 2, delay: 2,
    multitap_delay: 2, send: 2, return: 2,
  },
};

const III_LIMITS: LimitTable = {
  evidence: 'forgefx-unverified',
  limits: {
    amp: 2, cab: 2, drive: 4, compressor: 4, multiband_compressor: 2, graphic_eq: 4,
    parametric_eq: 4, filter: 4, volume_pan: 4, gate_expander: 4, mixer: 4, multiplexer: 2,
    input: 5, output: 4, chorus: 2, flanger: 2, phaser: 2, rotary: 2, pan_tremolo: 2, wah: 2,
    formant: 2, enhancer: 2, resonator: 2, reverb: 2, delay: 4, multitap_delay: 2,
    megatap_delay: 2, ten_tap_delay: 2, plex_delay: 2, pitch: 2, synth: 2, send: 2, return: 2,
  },
};

const TABLES: Readonly<Record<number, LimitTable>> = {
  0x10: III_LIMITS,
  0x11: FM3_LIMITS,
  0x12: FM9_LIMITS,
};

/**
 * Max instances of `block` (catalog slug) on the device with `modelByte`,
 * with the evidence label. Undefined when the model has no table (VP4).
 */
export function instanceLimitFor(
  modelByte: number,
  block: string,
): { limit: number; evidence: InstanceLimitEvidence } | undefined {
  const table = TABLES[modelByte];
  if (table === undefined) return undefined;
  return { limit: table.limits[block] ?? 1, evidence: table.evidence };
}
