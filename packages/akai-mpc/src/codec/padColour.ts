/**
 * Pad colours for an MPC drum program: the `ProgramPads-v2.10` element.
 *
 * Owns: the role-to-colour table (Akai's factory-kit scheme), the ProgramPads
 * object, and its on-disk form (JSON with a 4-space indent, XML-escaped, quotes
 * as `&quot;`, exactly as the device writes it).
 *
 * The colours live per program: `pads.valueN` is pad N+1's colour as a 24-bit
 * RGB int, shown per pad only while `Universal` is false. Field set and
 * defaults follow the factory kits (Universal false, Type 5, UnusedPads 1,
 * PadsFollowTrackColour false) and the device's universal default (65280).
 *
 * Scheme, by what a pad plays and never by sample length: kick red, snare and
 * clap yellow, hat and cymbal brown, tom and perc teal, 808 and bass green, FX
 * pink, vocal blue, melodic purple; an unknown pad teal; an empty pad 0.
 *
 * Not here: guessing a role from a sample's NAME. The caller states the role
 * (or an explicit colour); a sampled pad with neither is coloured as unknown.
 */

export const PAD_COLOUR = {
  kick: 0xff0000,
  snare: 0xffff00,
  hat: 0x5f3300,
  perc: 0x229ed0,
  bass: 0x00ff00,
  fx: 0xee2288,
  vocal: 0x0000ff,
  melodic: 0xa000ff,
  empty: 0,
} as const;

/** A sampled pad whose role nobody stated. */
export const UNKNOWN_PAD_COLOUR = PAD_COLOUR.perc;

export type PadRole =
  | 'kick' | 'snare' | 'clap' | 'hat' | 'hat_open' | 'cymbal'
  | 'tom' | 'perc' | 'bass' | '808' | 'fx' | 'vocal' | 'melodic';

export const ROLE_COLOUR: Readonly<Record<PadRole, number>> = {
  kick: PAD_COLOUR.kick,
  snare: PAD_COLOUR.snare,
  clap: PAD_COLOUR.snare,
  hat: PAD_COLOUR.hat,
  hat_open: PAD_COLOUR.hat,
  cymbal: PAD_COLOUR.hat,
  tom: PAD_COLOUR.perc,
  perc: PAD_COLOUR.perc,
  bass: PAD_COLOUR.bass,
  808: PAD_COLOUR.bass,
  fx: PAD_COLOUR.fx,
  vocal: PAD_COLOUR.vocal,
  melodic: PAD_COLOUR.melodic,
};

export const PROGRAM_PADS_TAG = 'ProgramPads-v2.10';

/** A pad's RGB int: an explicit colour wins, then the role, else unknown. */
export function padColour(role?: PadRole, colour?: number): number {
  if (colour !== undefined) {
    if (!Number.isInteger(colour) || colour < 0 || colour > 0xffffff) {
      throw new RangeError(`pad colour ${String(colour)} is not a 24-bit RGB int`);
    }
    return colour;
  }
  if (role === undefined) return UNKNOWN_PAD_COLOUR;
  const c = ROLE_COLOUR[role];
  if (c === undefined) {
    throw new RangeError(`unknown pad role "${String(role)}" (one of ${Object.keys(ROLE_COLOUR).sort().join(', ')})`);
  }
  return c;
}

export interface ProgramPadsOptions {
  type?: number;
  unused?: number;
  universalPad?: number;
  follow?: boolean;
}

/**
 * The ProgramPads object of a per-pad coloured drum program.
 * `colours` maps pad 1..128 to RGB; a pad not listed is 0.
 */
export function programPads(colours: ReadonlyMap<number, number>, opts: ProgramPadsOptions = {}): Record<string, unknown> {
  for (const p of colours.keys()) {
    if (!Number.isInteger(p) || p < 1 || p > 128) throw new RangeError(`pad ${p} out of range 1..128`);
  }
  const pads: Record<string, number> = {};
  for (let i = 0; i < 128; i++) pads[`value${i}`] = colours.get(i + 1) ?? 0;
  return {
    [PROGRAM_PADS_TAG]: {
      Universal: { value0: false },
      Type: { value0: opts.type ?? 5 },
      universalPad: opts.universalPad ?? 65280,
      pads,
      UnusedPads: { value0: opts.unused ?? 1 },
      PadsFollowTrackColour: { value0: opts.follow ?? false },
    },
  };
}

/** `<ProgramPads-v2.10>{...}</ProgramPads-v2.10>` as the device writes it. */
export function programPadsElement(obj: Record<string, unknown>, newline = '\n'): string {
  const body = JSON.stringify(obj, null, 4)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, newline);
  return `<${PROGRAM_PADS_TAG}>${body}</${PROGRAM_PADS_TAG}>`;
}
