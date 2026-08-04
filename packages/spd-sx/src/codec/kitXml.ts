/**
 * SPD-SX kit `.spd` codec — encode / parse the MINIMAL kit format that Wave
 * Manager writes for a newly-built kit (and that the device accepts verbatim).
 *
 * Decoded format (STATE-SPDSX.md, from snapshot A): each kit is a small XML
 * document rooted at `<KitPrm>`:
 *   <Nm0..Nm7>      8 char-codes -> kit name (NUL-terminated, max 8 chars)
 *   <SubNm0..SubNm15>  16 char-codes -> sub-name (usually zeros)
 *   <PadPrm> x15    one per pad slot (9 main pads + 6 external), each
 *      <Wv>idx</Wv> <SubWv>idx</SubWv>   wave index, -1 = empty
 * A "full" kit additionally carries <Level>/<Tempo>/<Fx..> blocks; we never
 * author those — the minimal form is what the device rebuilds into a full kit.
 *
 * This is a BYTE-FOR-BYTE port of `scripts/spdsx/spdsx_author.py` (LF line
 * endings, tab indentation). The round-trip self-test against the snapshot
 * corpus is the proof it reproduces the device format exactly.
 */

export const PAD_COUNT = 15;
export const NAME_LEN = 8;
export const SUBNAME_LEN = 16;

export type Pad = readonly [wv: number, subwv: number];

/** Encode a minimal kit. nm: 8 codes; subnm: 16 codes; pads: 15 (wv, subwv). */
export function encodeMinimalKit(
  nmCodes: readonly number[],
  subnmCodes: readonly number[],
  pads: readonly Pad[],
): string {
  const out: string[] = ['<KitPrm>'];
  nmCodes.forEach((c, i) => out.push(`\t<Nm${i}>${c}</Nm${i}>`));
  subnmCodes.forEach((c, i) => out.push(`\t<SubNm${i}>${c}</SubNm${i}>`));
  for (const [wv, subwv] of pads) {
    out.push('\t<PadPrm>', `\t\t<Wv>${wv}</Wv>`, `\t\t<SubWv>${subwv}</SubWv>`, '\t</PadPrm>');
  }
  out.push('</KitPrm>');
  return out.join('\n') + '\n';
}

/** A minimal kit has no <Level>/<Fx1Sw> (the full-kit-only fields). */
export function isMinimalKit(text: string): boolean {
  return !text.includes('<Level>') && !text.includes('<Fx1Sw>');
}

function codes(text: string, prefix: string, n: number): number[] {
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    const m = text.match(new RegExp(`<${prefix}${i}>(-?\\d+)</${prefix}${i}>`));
    vals.push(m ? Number.parseInt(m[1], 10) : 0);
  }
  return vals;
}

/** Parse a minimal kit -> { nm[8], subnm[16], pads[] }. */
export function parseMinimalKit(text: string): { nm: number[]; subnm: number[]; pads: Pad[] } {
  const nm = codes(text, 'Nm', NAME_LEN);
  const subnm = codes(text, 'SubNm', SUBNAME_LEN);
  const pads: Pad[] = [];
  const blockRe = /<PadPrm>([\s\S]*?)<\/PadPrm>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const block = m[1];
    const wv = Number.parseInt(/<Wv>(-?\d+)<\/Wv>/.exec(block)![1], 10);
    const sub = Number.parseInt(/<SubWv>(-?\d+)<\/SubWv>/.exec(block)![1], 10);
    pads.push([wv, sub]);
  }
  return { nm, subnm, pads };
}

/** Kit name -> 8 char-codes, NUL-padded (as real device kits are). */
export function nameToCodes(name: string): number[] {
  for (const c of name) {
    const code = c.charCodeAt(0);
    if (code < 32 || code > 126) throw new Error(`kit name must be printable ASCII: ${JSON.stringify(name)}`);
  }
  if (name.length > NAME_LEN) throw new Error(`kit name max ${NAME_LEN} chars: ${JSON.stringify(name)}`);
  const out = [...name].map((c) => c.charCodeAt(0));
  while (out.length < NAME_LEN) out.push(0);
  return out;
}

/** Build a minimal kit from a name + a list of wave indices for pads 1..N. */
export function buildKit(name: string, padWvs: readonly number[]): string {
  if (padWvs.length > PAD_COUNT) throw new Error(`max ${PAD_COUNT} pads`);
  const pads: Pad[] = padWvs.map((w) => [Math.trunc(w), -1] as Pad);
  while (pads.length < PAD_COUNT) pads.push([-1, -1]);
  return encodeMinimalKit(nameToCodes(name), new Array(SUBNAME_LEN).fill(0), pads);
}

// ── Full kit (per-pad MIDI note / voice / mute-group / dynamics) ──────
//
// The minimal kit above writes only <Wv>/<SubWv> per pad and lets the device
// fill every other PadPrm field with its defaults. That is byte-confirmed and
// hardware-confirmed, but it CANNOT set per-pad properties (the MIDI note that
// triggers the pad, POLY vs MONO voicing, mute group, velocity dynamics).
//
// The FULL kit writes the complete 19-field <PadPrm> the device's own full kits
// use, inside an FX-off <KitPrm> header. Both shapes are taken BYTE-EXACT from a
// real device file: the header reproduces kit016 (a real FX-off full kit on the
// unit — Level=100/Tempo=1200, both FX switches off, all Fx prms 0) and the
// PadPrm field set + order is exactly what every device kit carries.
//
// VoiceAsgn 0 = MONO, 1 = POLY. The DIRECTION is correlation-inferred (not
// byte-proven), but well-grounded by three independent signals: (a) the Owner's
// Manual MODE enum lists MONO before POLY (→ 0/1; SPD-SX_OM.txt MODE section),
// (b) looping pads correlate to VoiceAsgn 0 in 38/44 snapshot pads and ALT-trigger
// pads in 40/48 (both monophonic by nature), (c) no corpus kit contradicts it. The
// byte-identity golden proves the FORMAT, not this semantic — so it ships
// community-beta with a "confirm by ear" warning. See STATE-SPDSX.md.
//
// EVIDENCE TIER: the format is strong-evidence (byte-shaped like real device
// files), and device acceptance of a SERVER-authored full kit is now
// HARDWARE-CONFIRMED (2026-07-07: 20 full kits authored to the device loaded and
// played, with loop pads confirmed looping). The POLY/MONO choke DIRECTION stays
// correlation-inferred (VoiceAsgn 0 = MONO), confirmed only insofar as MONO loops
// retrigger correctly. See STATE-SPDSX.md.

const FX_PRM_COUNT = 20;

/** A fully-resolved PadPrm: every field the device writes, in device order. */
export interface ResolvedPad {
  wv: number;
  wvLevel: number;
  wvPan: number;
  playMode: number;
  outAsgn: number;
  muteGrp: number;
  tempoSync: number;
  padMidiCh: number;
  noteNum: number;
  midiCtrl: number;
  loop: number;
  trigType: number;
  gateTime: number;
  dynamics: number;
  voiceAsgn: number;
  reverse: number;
  subWv: number;
  subWvLevel: number;
  subWvPan: number;
}

/** FX-off full-kit header values (matches the real device kit016 skeleton). */
export interface KitHeader {
  level: number;
  tempo: number;
  fx2Asgn: number;
  linkPad0: number;
  linkPad1: number;
  fx1Sw: number;
  fx1Type: number;
  fx1Prm: readonly number[]; // 20
  fx2Sw: number;
  fx2Type: number;
  fx2Prm: readonly number[]; // 20
}

/** The clean FX-off header a freshly-authored kit uses (byte-exact = kit016). */
export const DEFAULT_FXOFF_HEADER: KitHeader = {
  level: 100,
  tempo: 1200,
  fx2Asgn: 0,
  linkPad0: -1,
  linkPad1: -1,
  fx1Sw: 0,
  fx1Type: 0,
  fx1Prm: new Array(FX_PRM_COUNT).fill(0),
  fx2Sw: 0,
  fx2Type: 0,
  fx2Prm: new Array(FX_PRM_COUNT).fill(0),
};

/** Per-pad device defaults for a one-shot, MIDI-triggerable drum pad. */
export const PAD_DEFAULTS: Omit<ResolvedPad, 'wv' | 'noteNum'> = {
  wvLevel: 100,
  wvPan: 15,
  playMode: -1,
  outAsgn: 0,
  muteGrp: 0,
  tempoSync: 0,
  padMidiCh: -1, // GLOBAL
  midiCtrl: 0,
  loop: 0,
  trigType: 0,    // SHOT
  gateTime: -1,
  dynamics: 1,    // ON (velocity scales volume — wanted for sequenced drums)
  voiceAsgn: 1,   // POLY (overlapping trails — wanted for hat rolls)
  reverse: 0,
  subWv: -1,
  subWvLevel: 100,
  subWvPan: 15,
};

/** Encode one full <PadPrm> block (19 fields, device order, tab-indented). */
export function encodePadPrm(p: ResolvedPad): string {
  return [
    '\t<PadPrm>',
    `\t\t<Wv>${p.wv}</Wv>`,
    `\t\t<WvLevel>${p.wvLevel}</WvLevel>`,
    `\t\t<WvPan>${p.wvPan}</WvPan>`,
    `\t\t<PlayMode>${p.playMode}</PlayMode>`,
    `\t\t<OutAsgn>${p.outAsgn}</OutAsgn>`,
    `\t\t<MuteGrp>${p.muteGrp}</MuteGrp>`,
    `\t\t<TempoSync>${p.tempoSync}</TempoSync>`,
    `\t\t<PadMidiCh>${p.padMidiCh}</PadMidiCh>`,
    `\t\t<NoteNum>${p.noteNum}</NoteNum>`,
    `\t\t<MidiCtrl>${p.midiCtrl}</MidiCtrl>`,
    `\t\t<Loop>${p.loop}</Loop>`,
    `\t\t<TrigType>${p.trigType}</TrigType>`,
    `\t\t<GateTime>${p.gateTime}</GateTime>`,
    `\t\t<Dynamics>${p.dynamics}</Dynamics>`,
    `\t\t<VoiceAsgn>${p.voiceAsgn}</VoiceAsgn>`,
    `\t\t<Reverse>${p.reverse}</Reverse>`,
    `\t\t<SubWv>${p.subWv}</SubWv>`,
    `\t\t<SubWvLevel>${p.subWvLevel}</SubWvLevel>`,
    `\t\t<SubWvPan>${p.subWvPan}</SubWvPan>`,
    '\t</PadPrm>',
  ].join('\n');
}

/** Encode a full kit: FX-off header + 15 full PadPrm blocks. */
export function encodeFullKit(
  nmCodes: readonly number[],
  subnmCodes: readonly number[],
  header: KitHeader,
  pads: readonly ResolvedPad[],
): string {
  if (pads.length !== PAD_COUNT) throw new Error(`a full kit has exactly ${PAD_COUNT} pads, got ${pads.length}`);
  const out: string[] = ['<KitPrm>'];
  out.push(`\t<Level>${header.level}</Level>`, `\t<Tempo>${header.tempo}</Tempo>`);
  nmCodes.forEach((c, i) => out.push(`\t<Nm${i}>${c}</Nm${i}>`));
  subnmCodes.forEach((c, i) => out.push(`\t<SubNm${i}>${c}</SubNm${i}>`));
  out.push(`\t<Fx2Asgn>${header.fx2Asgn}</Fx2Asgn>`);
  out.push(`\t<LinkPad0>${header.linkPad0}</LinkPad0>`, `\t<LinkPad1>${header.linkPad1}</LinkPad1>`);
  out.push(`\t<Fx1Sw>${header.fx1Sw}</Fx1Sw>`, `\t<Fx1Type>${header.fx1Type}</Fx1Type>`);
  header.fx1Prm.forEach((v, i) => out.push(`\t<Fx1Prm${i}>${v}</Fx1Prm${i}>`));
  out.push(`\t<Fx2Sw>${header.fx2Sw}</Fx2Sw>`, `\t<Fx2Type>${header.fx2Type}</Fx2Type>`);
  header.fx2Prm.forEach((v, i) => out.push(`\t<Fx2Prm${i}>${v}</Fx2Prm${i}>`));
  for (const p of pads) out.push(encodePadPrm(p));
  out.push('</KitPrm>');
  return out.join('\n') + '\n';
}

/** Caller-facing per-pad spec for a full kit (only the knobs we expose). */
export interface FullPad {
  /** Wave index, or -1 for an empty pad. */
  wv: number;
  /** MIDI note that triggers this pad (0..127). Default: 60 + pad index (the SPD-SX descriptor supplies a General MIDI note per pad role). */
  note?: number;
  /** POLY = overlapping trails (hat rolls); MONO = each hit chokes the last. Default 'poly' for a one-shot pad, 'mono' for a loop pad (a re-trigger restarts the loop instead of stacking copies). */
  voice?: 'poly' | 'mono';
  /**
   * LOOP the wave (a groove/bed you drum along to) instead of a one-shot hit.
   * Reproduces the real device loop-pad signature PlayMode=2 / Loop=1 /
   * TrigType=1 / VoiceAsgn=0 (MONO) — mined byte-exact from the device snapshot
   * corpus (156/156 loop pads carry exactly this combo). Default false (one-shot
   * SHOT). The loop plays at its native recorded tempo (TempoSync off).
   */
  loop?: boolean;
  /** Mute group 0..9 (0 = off; pads sharing a group cut each other off — e.g. open/closed hat). Default 0. */
  muteGroup?: number;
  /** Per-pad wave LEVEL 0..127 (device WvLevel = the pad's volume). Default 100. Lower it to balance a loud pad (e.g. a hi-hat) below the shells without re-baking the wave. */
  level?: number;
  /** Velocity → volume (DYNAMICS). Default true (on). */
  dynamics?: boolean;
  /** Optional second (sub) wave index layered on the pad. Default -1 (none). */
  subWv?: number;
}

/** The kit already at a location, for a re-author to inherit from (see buildFullKit). */
export interface FullKitBase {
  header: KitHeader;
  subnm: readonly number[];
  pads: readonly ResolvedPad[];
}

export interface BuildFullKitOptions {
  /**
   * The kit CURRENTLY at this location. Every per-pad field the caller does not
   * name — level, note, mute group, pan, dynamics, voice — plus the Level/Tempo/
   * FX header is inherited from it, so a re-author changes only what it was
   * asked to change. Omit for a fresh kit (device defaults apply).
   */
  base?: FullKitBase;
  /**
   * Device-convention <NoteNum> for pad i, used ONLY when neither the pad nor
   * `base` names one (i.e. on a fresh kit). Default: 60 + padIndex.
   */
  defaultNote?: (padIndex: number) => number;
}

/**
 * Resolve one FullPad to a ResolvedPad. Precedence per field: what the CALLER
 * named wins; else what `base` (the pad on the device now) holds; else the fresh-
 * kit default. That precedence is what stops a re-author from silently flattening
 * levels/mute groups the caller never mentioned — see buildFullKit.
 */
export function resolveFullPad(p: FullPad, padIndex: number, base?: ResolvedPad, defaultNote?: number): ResolvedPad {
  const note = p.note ?? base?.noteNum ?? defaultNote ?? 60 + padIndex;
  if (!Number.isInteger(note) || note < 0 || note > 127) throw new Error(`pad ${padIndex + 1} note must be 0..127, got ${note}`);
  const muteGrp = p.muteGroup ?? base?.muteGrp ?? 0;
  if (!Number.isInteger(muteGrp) || muteGrp < 0 || muteGrp > 9) throw new Error(`pad ${padIndex + 1} mute group must be 0..9, got ${muteGrp}`);
  const wvLevel = p.level ?? base?.wvLevel ?? PAD_DEFAULTS.wvLevel;
  if (!Number.isInteger(wvLevel) || wvLevel < 0 || wvLevel > 127) throw new Error(`pad ${padIndex + 1} level must be 0..127, got ${wvLevel}`);

  // `loop` drives four fields at once (PlayMode/Loop/TrigType + the MONO voice
  // default). Naming it re-derives all four — it changes the pad's nature, so the
  // loop-pad signature must come out coherent rather than half-inherited. Leaving
  // it unnamed inherits the pad exactly as it stands.
  const loopNamed = p.loop !== undefined;
  const loop = p.loop ?? base?.loop === 1;
  const loopFields = loopNamed || !base
    ? (loop
      ? { playMode: 2, loop: 1, trigType: 1 }
      : { playMode: PAD_DEFAULTS.playMode, loop: PAD_DEFAULTS.loop, trigType: PAD_DEFAULTS.trigType })
    : { playMode: base.playMode, loop: base.loop, trigType: base.trigType };
  // A loop pad defaults to MONO (a re-trigger restarts the bed rather than
  // stacking overlapping copies) — matching the corpus, where every loop pad is
  // VoiceAsgn 0. An explicit `voice` still wins for the rare poly-loop case.
  const voice = p.voice ?? (loopNamed || !base ? (loop ? 'mono' : 'poly') : (base.voiceAsgn === 0 ? 'mono' : 'poly'));

  const inherited: Omit<ResolvedPad, 'wv' | 'noteNum'> = base ?? PAD_DEFAULTS;
  return {
    ...inherited,
    ...loopFields,
    wv: Math.trunc(p.wv),
    noteNum: note,
    muteGrp,
    wvLevel,
    dynamics: (p.dynamics ?? (base ? base.dynamics === 1 : true)) ? 1 : 0,
    voiceAsgn: voice === 'mono' ? 0 : 1,
    subWv: p.subWv !== undefined ? Math.trunc(p.subWv) : (base?.subWv ?? PAD_DEFAULTS.subWv),
  };
}

/**
 * Build a FULL kit from a name + per-pad specs. Pads beyond the supplied list
 * are emitted empty (Wv -1), so the file always carries all 15 PadPrm blocks the
 * device expects — `pads` DECLARES the kit's pad list, it is not a patch.
 *
 * Pass `opts.base` (the kit already at this location) for a re-author: within a
 * listed pad, any field the caller did not name keeps its current device value
 * instead of snapping back to a default. Without it, re-authoring a kit to swap
 * ONE wave rewrites every level to 100 and every mute group to 0 — the documented
 * regression that flattened a balanced kit into a loud one.
 */
export function buildFullKit(name: string, pads: readonly FullPad[], opts: BuildFullKitOptions = {}): string {
  if (pads.length > PAD_COUNT) throw new Error(`max ${PAD_COUNT} pads`);
  const resolved: ResolvedPad[] = [];
  for (let i = 0; i < PAD_COUNT; i++) {
    resolved.push(resolveFullPad(pads[i] ?? { wv: -1 }, i, opts.base?.pads[i], opts.defaultNote?.(i)));
  }
  const subnm = opts.base?.subnm ?? new Array(SUBNAME_LEN).fill(0);
  return encodeFullKit(nameToCodes(name), subnm, opts.base?.header ?? DEFAULT_FXOFF_HEADER, resolved);
}

/**
 * Surgically set per-pad NoteNum on a FULL kit's XML, leaving every other byte
 * UNTOUCHED — this is the non-destructive note edit: waves, levels, FX, pan,
 * mute groups, etc. are preserved exactly (the file round-trips byte-for-byte
 * except the patched <NoteNum> digits). `notes` maps a 0-based pad index (0..14)
 * to a MIDI note (0..127). MINIMAL kits carry no <NoteNum>, so this is a no-op
 * on them; callers MUST gate on `isMinimalKit` and refuse minimal kits first.
 */
export function editKitNotes(text: string, notes: ReadonlyMap<number, number>): string {
  let i = -1;
  return text.replace(/<PadPrm>[\s\S]*?<\/PadPrm>/g, (block) => {
    i += 1;
    const note = notes.get(i);
    if (note === undefined) return block;
    return block.replace(/<NoteNum>-?\d+<\/NoteNum>/, `<NoteNum>${note}</NoteNum>`);
  });
}

/**
 * Parse a full kit's Level/Tempo/FX header. Returns undefined for a minimal kit
 * (which carries no header). Tag matches are exact, so <Level> never catches
 * <WvLevel> and <Fx1Prm1> never catches <Fx1Prm10>.
 */
export function parseKitHeader(text: string): KitHeader | undefined {
  const num = (tag: string): number | undefined => {
    const m = new RegExp(`<${tag}>(-?\\d+)</${tag}>`).exec(text);
    return m ? Number.parseInt(m[1], 10) : undefined;
  };
  const level = num('Level');
  const tempo = num('Tempo');
  if (level === undefined || tempo === undefined) return undefined;
  const prms = (prefix: string): number[] =>
    Array.from({ length: FX_PRM_COUNT }, (_, i) => num(`${prefix}${i}`) ?? 0);
  return {
    level,
    tempo,
    fx2Asgn: num('Fx2Asgn') ?? 0,
    linkPad0: num('LinkPad0') ?? -1,
    linkPad1: num('LinkPad1') ?? -1,
    fx1Sw: num('Fx1Sw') ?? 0,
    fx1Type: num('Fx1Type') ?? 0,
    fx1Prm: prms('Fx1Prm'),
    fx2Sw: num('Fx2Sw') ?? 0,
    fx2Type: num('Fx2Type') ?? 0,
    fx2Prm: prms('Fx2Prm'),
  };
}

/**
 * Read an existing kit's full state (header + sub-name + all 15 resolved pads)
 * so a re-author can inherit it. Returns undefined when `text` is a MINIMAL kit
 * — it stores no per-pad state, so there is nothing to preserve. THROWS if the
 * kit looks full but will not parse: silently falling back to defaults is the
 * exact flattening this exists to prevent.
 */
export function parseFullKitBase(text: string): FullKitBase | undefined {
  if (isMinimalKit(text)) return undefined;
  const header = parseKitHeader(text);
  if (header === undefined) return undefined;
  const { subnm, pads } = parseFullKit(text);
  if (pads.length !== PAD_COUNT) {
    throw new Error(`kit has ${pads.length} <PadPrm> blocks, expected ${PAD_COUNT}`);
  }
  return { header, subnm, pads };
}

/** Parse a full kit's Nm/SubNm + all 15 PadPrm blocks (for the round-trip golden). */
export function parseFullKit(text: string): { nm: number[]; subnm: number[]; pads: ResolvedPad[] } {
  const nm = codes(text, 'Nm', NAME_LEN);
  const subnm = codes(text, 'SubNm', SUBNAME_LEN);
  const num = (block: string, tag: string): number => {
    const m = new RegExp(`<${tag}>(-?\\d+)</${tag}>`).exec(block);
    if (!m) throw new Error(`PadPrm missing <${tag}>`);
    return Number.parseInt(m[1], 10);
  };
  const pads: ResolvedPad[] = [];
  const blockRe = /<PadPrm>([\s\S]*?)<\/PadPrm>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const b = m[1];
    pads.push({
      wv: num(b, 'Wv'), wvLevel: num(b, 'WvLevel'), wvPan: num(b, 'WvPan'), playMode: num(b, 'PlayMode'),
      outAsgn: num(b, 'OutAsgn'), muteGrp: num(b, 'MuteGrp'), tempoSync: num(b, 'TempoSync'), padMidiCh: num(b, 'PadMidiCh'),
      noteNum: num(b, 'NoteNum'), midiCtrl: num(b, 'MidiCtrl'), loop: num(b, 'Loop'), trigType: num(b, 'TrigType'),
      gateTime: num(b, 'GateTime'), dynamics: num(b, 'Dynamics'), voiceAsgn: num(b, 'VoiceAsgn'), reverse: num(b, 'Reverse'),
      subWv: num(b, 'SubWv'), subWvLevel: num(b, 'SubWvLevel'), subWvPan: num(b, 'SubWvPan'),
    });
  }
  return { nm, subnm, pads };
}
