/**
 * Per-device config for the Arturia Freak family.
 *
 * Same shape of idea as `createModernFractalDescriptor`: ONE codec + one
 * descriptor factory, with each device supplying only what genuinely differs.
 * Here what differs is more than a model byte, so the config is explicit about
 * which surfaces a given device has EVIDENCE for.
 *
 * **The CC table is per-device and must never be shared across the family.**
 * The MicroFreak and MiniFreak CC numbers do not merely differ, they COLLIDE
 * with different meanings: CC 24 is Cycling-Env Amount on the MicroFreak and
 * VCF Env Amount on the MiniFreak; CC 26 is Filter Amount vs FX2 Time; cutoff
 * is CC 23 vs CC 74. A shared table would silently move the wrong parameter,
 * which is the "opcode not portable across model bytes" trap in
 * docs/TOOL-AUTHORING-GUIDE.md.
 */

/**
 * How good the evidence for a CC NUMBER is. Deliberately separate from
 * `hardware_confirmed`, because these are two independent axes and collapsing
 * them into one "unverified" is what lets a guess pass for a confident value:
 *
 *   - `vendor-documented`: read out of the manufacturer's own published CC
 *     table. Unconfirmed on hardware still means very likely correct.
 *   - `transcribed-unvalidated`: copied from a third-party mirror because the
 *     vendor's page is not machine-readable. It may be right, but nothing on
 *     hand can catch it being wrong, and a wrong CC number moves a DIFFERENT
 *     parameter rather than failing. That is a louder class of risk and gets a
 *     louder label, never the same "untested" banner as the above.
 */
export type CcEvidence = 'vendor-documented' | 'transcribed-unvalidated';

/** One CC-addressable preset parameter. */
export interface FreakCc {
  block: string;
  param: string;
  cc: number;
  /** The manufacturer's own label. */
  label: string;
  /** True for a toggle rather than a continuous value. */
  toggle?: boolean;
  /** True only when THIS project has confirmed it on hardware. */
  hardware_confirmed?: boolean;
  /** Defaults to `vendor-documented` when omitted. */
  evidence?: CcEvidence;
}

/** The caveat a given CC's evidence earns, or undefined when it needs none. */
export function ccEvidenceNote(cc: FreakCc): string | undefined {
  if (cc.evidence !== 'transcribed-unvalidated') return undefined;
  return 'UNVALIDATED CC number: transcribed from a third-party mirror, not read from the '
    + "manufacturer's own published table and not confirmed on hardware. If it is wrong it will "
    + 'move a different parameter rather than do nothing. Confirm by ear before relying on it.';
}

/** One SysEx-addressable Utility/global setting. */
export interface FreakGlobal {
  param: string;
  /** SysEx param id. */
  id: number;
  label: string;
  /** Display <-> wire labels for enum-ish values. Absent = plain integer. */
  values?: readonly string[];
  /** MIDI channel params store 0-BASED: displayed channel = stored + 1. */
  channel?: boolean;
  /** Writing a non-USB value here would sever the server's own transport. */
  usb_critical?: boolean;
  /**
   * The values of this global that keep the device's physical MIDI Out relaying.
   * Present only on globals that can silence the DIN leg.
   *
   * Deliberately a SEPARATE axis from `usb_critical`, and deliberately advisory
   * rather than a refusal, because the two failures are not the same shape.
   * Severing USB breaks the server's own transport and cannot be undone from
   * here, so it is always wrong and is always refused. Silencing the DIN leg
   * breaks whatever the user has plugged into MIDI Out, which on most rigs is
   * nothing at all, so a blanket refusal would block a legitimate setting for
   * every owner. The write proceeds; `downstream.ts` decides whether anyone is
   * actually listening, and only then does the caller get warned.
   */
  din_alive?: ReadonlySet<number>;
  note?: string;
}

/**
 * The SysEx surface, present only when the device code is KNOWN. A guessed
 * device byte is not shipped: it would address some other Arturia product.
 */
export interface FreakSysexSupport {
  /** Device code byte in the Arturia envelope (MicroFreak = 0x07). */
  device_code: number;
  /** Utility globals reachable by 0x43 (read) / 0x42 (write). */
  globals: readonly FreakGlobal[];
  /** Preset slots addressable by the name-read path. */
  preset_count: number;
  /** Values of `output_dest` that keep the USB transport alive. */
  output_dest_usb_alive?: ReadonlySet<number>;
}

export interface FreakConfig {
  /** Descriptor id, e.g. `microfreak`. */
  id: string;
  display_name: string;
  /**
   * Port matcher. MUST be specific to this model. A broad `/arturia/i` would
   * capture every other Arturia device on the bus and drive it with this
   * device's CC numbers, which mean different things per model.
   */
  port_match: readonly RegExp[];
  ccs: readonly FreakCc[];
  /** Present only when the SysEx device code is confirmed for this model. */
  sysex?: FreakSysexSupport;
  /** Highest preset reachable by plain Program Change (no Bank Select decoded). */
  pc_max_preset: number;
  /** Total preset slots, for location validation and messaging. */
  preset_count: number;
  /**
   * Must be one of core's SupportTier values. `generic-only` is the honest tier
   * for a Freak with no confirmed SysEx device code: nothing device-specific
   * works, only the generic CC/PC primitives with a curated map.
   */
  support_tier: 'verified' | 'community-beta' | 'generic-only';
  verification: string;
  agent_guidance: Readonly<Record<string, string>>;
  /** Env var that overrides the MIDI channel this device is addressed on. */
  channel_env: string;
}

export function findCc(config: FreakConfig, block: string, param: string): FreakCc | undefined {
  const b = block.trim().toLowerCase();
  const p = param.trim().toLowerCase();
  return config.ccs.find((c) => c.block === b && c.param === p);
}

export function findGlobal(config: FreakConfig, param: string): FreakGlobal | undefined {
  if (config.sysex === undefined) return undefined;
  const p = param.trim().toLowerCase().replace(/^system[._]/, '');
  return config.sysex.globals.find((g) => g.param === p);
}
