/**
 * MPC drum program writer (`.xpm`, XML, `File_Version` 2.1).
 *
 * Owns: one drum program as text, shaped the way the device writes it: all 128
 * instruments (pads A01..H16), 8 layers each, a 128-entry PadNoteMap and
 * PadGroupMap, in the device's element order. Field set and defaults come from
 * device-saved programs (a factory drum kit for the instrument fields, a later
 * save for the per-layer slice fields).
 *
 * The XML form is the one every MPC from 2.9 through 3.x READS. From OS 3.9 the
 * device SAVES programs as JSON instead; it still loads this form.
 *
 * Layer play modes (`zonePlay`): 1 = Velocity (up to 8 velocity layers),
 * 0 = Cycle (up to 8 takes at one dynamic, for fast repeated hits). One pad
 * cannot both switch on velocity and cycle takes with Layer Play alone: Cycle
 * ignores the velocity ranges.
 *
 * Output is byte-identical to the reference writer this was ported from, for
 * the same inputs (goldens in `scripts/verify-akai-mpc.ts`). One deliberate
 * difference: that writer guesses a pad's colour from its sample name; here the
 * caller states a `role` or `colour` (see `padColour.ts`).
 *
 * Untested on hardware from THIS writer. The reference writer's programs load
 * on an MPC One G2.
 */
import { padColour, programPads, programPadsElement, type PadRole } from './padColour.js';

export const XPM_APP_VERSION = '3.5.0.54';
/** Header for a program that carries per-pad articulations (needs MPC 3.7+). */
export const XPM_ARTICULATION_APP_VERSION = '3.7.1.34';
export const XPM_LAYERS = 8;
export const XPM_PADS = 128;

/** Level 0 dB on every MPC fader field (`Volume`): the device's own unity value. */
export const XPM_UNITY_VOLUME = 0.707946;

/** A fader field value as dB (unity = 0 dB). The MPC's law is 40 log10. */
export function xpmVolumeToDb(volume: number): number {
  return 40 * Math.log10(volume / XPM_UNITY_VOLUME);
}

/** dB (0 = unity) as a fader field value. */
export function dbToXpmVolume(db: number): number {
  return XPM_UNITY_VOLUME * 10 ** (db / 40);
}

export interface XpmLayer {
  /** Sample name as the program refers to it: the WAV's file name without `.wav`. */
  sample: string;
  /** Sample length in frames; `SliceEnd` is `frames - 1`. */
  frames: number;
  /** Velocity range this layer answers, inclusive. Default 0..127. */
  velocity?: readonly [number, number];
  /** Layer level as a fader field value. Default 1.0. */
  volume?: number;
}

/** Per-pad articulation (MPC 3.7+), the same settings in all four XY quadrants. */
export interface XpmArticulation {
  /** The number on the device's installed articulation files (0 = none, 2 = Flam, 22 = Note Repeat 16). */
  type: number;
  /** 0..1; 0.5 = 100 %. */
  speed?: number;
  dynamics?: number;
  /** 1.0 applies the file's alternating pan; 0.0 keeps every repeat centred. */
  stereo?: number;
  scaling?: number;
}

export interface XpmPad {
  /** Up to 8 layers. A pad with none is written empty. */
  layers?: readonly XpmLayer[];
  /** MIDI note the pad answers. Default: chromatic from pad 1 = 36. */
  note?: number;
  /** 1 = Velocity (default), 0 = Cycle. */
  zonePlay?: number;
  /** 0 = none; pads sharing a group cut each other off. */
  muteGroup?: number;
  mono?: boolean;
  polyphony?: number;
  /** Pad level as a fader field value. Default unity (0.707946). */
  volume?: number;
  /** 0..1, 0.5 = centre. */
  pan?: number;
  velocitySensitivity?: number;
  articulation?: XpmArticulation;
  /** What the pad plays, for its colour. */
  role?: PadRole;
  /** Explicit 24-bit RGB, overriding `role`. */
  colour?: number;
}

const f = (x: number): string => x.toFixed(6);
const b = (x: boolean): string => (x ? 'True' : 'False');

/** Escape text for an XML element body, as the reference writer does (`&`, `<`, `>` only). */
export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function layerXml(n: number, layer?: XpmLayer): string {
  const sample = layer?.sample ?? '';
  const active = sample !== '';
  const vel = layer?.velocity ?? [0, 127];
  const frames = layer?.frames ?? 0;
  return `          <Layer number="${n}">
            <Active>${b(true)}</Active>
            <Volume>${f(layer?.volume ?? 1.0)}</Volume>
            <Pan>0.500000</Pan>
            <Pitch>0.000000</Pitch>
            <TuneCoarse>0</TuneCoarse>
            <TuneFine>0</TuneFine>
            <VelStart>${active ? vel[0] : 0}</VelStart>
            <VelEnd>${active ? vel[1] : 127}</VelEnd>
            <SampleStart>0</SampleStart>
            <SampleEnd>0</SampleEnd>
            <LoopStart>0</LoopStart>
            <LoopEnd>0</LoopEnd>
            <LoopCrossfadeLength>0</LoopCrossfadeLength>
            <LoopTune>0</LoopTune>
            <RootNote>0</RootNote>
            <KeyTrack>False</KeyTrack>
            <SampleName>${xmlEscape(sample)}</SampleName>
            <PitchRandom>0.000000</PitchRandom>
            <VolumeRandom>0.000000</VolumeRandom>
            <PanRandom>0.000000</PanRandom>
            <OffsetRandom>0.000000</OffsetRandom>
            <SliceIncrement>0</SliceIncrement>
            <SliceCycleLength>1</SliceCycleLength>
            <SliceIncrementRngSeed>0</SliceIncrementRngSeed>
            <SampleFile></SampleFile>
            <SliceIndex>129</SliceIndex>
            <Direction>0</Direction>
            <Offset>0</Offset>
            <SliceStart>0</SliceStart>
            <SliceEnd>${Math.max(0, frames - 1)}</SliceEnd>
            <SliceLoopStart>0</SliceLoopStart>
            <SliceLoop>0</SliceLoop>
            <SliceLoopCrossFadeLength>-1</SliceLoopCrossFadeLength>
            <SliceTailPosition>0.500000</SliceTailPosition>
            <SliceTailLength>0.000000</SliceTailLength>
          </Layer>
`;
}

/** The device's default DrumPadEffects order. */
const PAD_EFFECT_TYPES = [0, 9, 1, 2, 3, 7, 4, 13] as const;

function articulationXml(art?: XpmArticulation): string {
  if (art === undefined) return '';
  const t = Math.trunc(art.type);
  const sp = f(art.speed ?? 0.5);
  const dy = f(art.dynamics ?? 0.5);
  const st = f(art.stereo ?? 0.0);
  const sc = Math.trunc(art.scaling ?? 1);
  let rows = '';
  for (let q = 0; q < 4; q++) {
    rows += `        <ArticulationType num="${q}">${t}</ArticulationType>\n`
      + `        <ArticulationSpeed num="${q}">${sp}</ArticulationSpeed>\n`
      + `        <ArticulationDynamics num="${q}">${dy}</ArticulationDynamics>\n`
      + `        <ArticulationStereo num="${q}">${st}</ArticulationStereo>\n`
      + `        <ArticulationSpeedScaling num="${q}">${sc}</ArticulationSpeedScaling>\n`;
  }
  return `        <ArticulationUseXY>False</ArticulationUseXY>\n${rows}`;
}

function instrumentXml(num: number, pad: XpmPad = {}): string {
  const layers = pad.layers ?? [];
  const fx = PAD_EFFECT_TYPES
    .map((t, i) => `          <DrumPadEffect Num="${i}" Parameter="0.0" Type="${t}"/>\n`)
    .join('');
  let body = '';
  for (let i = 0; i < XPM_LAYERS; i++) body += layerXml(i + 1, layers[i]);
  return `      <Instrument number="${num}">
        <CueBusEnable>False</CueBusEnable>
        <AudioRoute>
          <AudioRoute>0</AudioRoute>
          <AudioRouteSubIndex>0</AudioRouteSubIndex>
          <AudioRouteChannelBitmap>3</AudioRouteChannelBitmap>
          <InsertsEnabled>True</InsertsEnabled>
        </AudioRoute>
        <Send1>0.000000</Send1>
        <Send2>0.000000</Send2>
        <Send3>0.000000</Send3>
        <Send4>0.000000</Send4>
        <Volume>${f(pad.volume ?? XPM_UNITY_VOLUME)}</Volume>
        <Mute>False</Mute>
        <Solo>False</Solo>
        <Pan>${f(pad.pan ?? 0.5)}</Pan>
        <AutomationFilter>1</AutomationFilter>
        <FilterKeytrack>0.000000</FilterKeytrack>
        <FilterType>2</FilterType>
        <Cutoff>1.000000</Cutoff>
        <Resonance>0.000000</Resonance>
        <FilterEnvAmt>0.000000</FilterEnvAmt>
        <AfterTouchToFilter>0.000000</AfterTouchToFilter>
        <VelocityToFilter>0.000000</VelocityToFilter>
        <VelocityToFilterEnvelope>0.000000</VelocityToFilterEnvelope>
        <VelocityToStart>0.000000</VelocityToStart>
        <VelocityToFilterAttack>0.000000</VelocityToFilterAttack>
        <FilterAttack>0.000000</FilterAttack>
        <FilterDecay>0.047244</FilterDecay>
        <FilterSustain>1.000000</FilterSustain>
        <FilterRelease>0.000000</FilterRelease>
        <FilterAttackCurve>0.375000</FilterAttackCurve>
        <FilterDecayCurve>0.375000</FilterDecayCurve>
        <FilterReleaseCurve>0.375000</FilterReleaseCurve>
        <FilterHold>0.000000</FilterHold>
        <FilterDecayType>True</FilterDecayType>
        <FilterADEnvelope>True</FilterADEnvelope>
        <VolumeHold>0.000000</VolumeHold>
        <VolumeDecayType>True</VolumeDecayType>
        <VolumeADEnvelope>True</VolumeADEnvelope>
        <VolumeAttack>0.000000</VolumeAttack>
        <VolumeDecay>0.047244</VolumeDecay>
        <VolumeSustain>1.000000</VolumeSustain>
        <VolumeRelease>0.000000</VolumeRelease>
        <VolumeAttackCurve>0.375000</VolumeAttackCurve>
        <VolumeDecayCurve>0.375000</VolumeDecayCurve>
        <VolumeReleaseCurve>0.375000</VolumeReleaseCurve>
        <PitchHold>0.000000</PitchHold>
        <PitchDecayType>True</PitchDecayType>
        <PitchADEnvelope>True</PitchADEnvelope>
        <PitchAttack>0.000000</PitchAttack>
        <PitchDecay>0.047244</PitchDecay>
        <PitchSustain>1.000000</PitchSustain>
        <PitchRelease>0.000000</PitchRelease>
        <PitchAttackCurve>0.375000</PitchAttackCurve>
        <PitchDecayCurve>0.375000</PitchDecayCurve>
        <PitchReleaseCurve>0.375000</PitchReleaseCurve>
        <PitchEnvAmount>0.500000</PitchEnvAmount>
        <VelocityToPitch>0.000000</VelocityToPitch>
        <VelocityToVolumeAttack>0.000000</VelocityToVolumeAttack>
        <VelocitySensitivity>${f(pad.velocitySensitivity ?? 1.0)}</VelocitySensitivity>
        <VelocityToPan>0.000000</VelocityToPan>
        <RandomizationScale>1.000000</RandomizationScale>
        <AttackRandom>0.000000</AttackRandom>
        <DecayRandom>0.000000</DecayRandom>
        <CutoffRandom>0.000000</CutoffRandom>
        <ResonanceRandom>0.000000</ResonanceRandom>
        <LFO LfoNum="0">
          <Type>Sine</Type>
          <Rate>0.500000</Rate>
          <Sync>0</Sync>
          <Reset>True</Reset>
          <LfoPitch>0.000000</LfoPitch>
          <LfoCutoff>0.000000</LfoCutoff>
          <LfoVolume>0.000000</LfoVolume>
          <LfoPan>0.000000</LfoPan>
        </LFO>
        <DrumPadEffects>
${fx}        </DrumPadEffects>
        <TuneCoarse>0</TuneCoarse>
        <TuneFine>0</TuneFine>
        <Mono>${b(pad.mono ?? false)}</Mono>
        <Polyphony>${Math.trunc(pad.polyphony ?? 0)}</Polyphony>
        <LowNote>0</LowNote>
        <HighNote>127</HighNote>
        <IgnoreBaseNote>False</IgnoreBaseNote>
        <ZonePlay>${Math.trunc(pad.zonePlay ?? 1)}</ZonePlay>
        <MuteGroup>${Math.trunc(pad.muteGroup ?? 0)}</MuteGroup>
        <MuteTarget1>0</MuteTarget1>
        <MuteTarget2>0</MuteTarget2>
        <MuteTarget3>0</MuteTarget3>
        <MuteTarget4>0</MuteTarget4>
        <SimultTarget1>0</SimultTarget1>
        <SimultTarget2>0</SimultTarget2>
        <SimultTarget3>0</SimultTarget3>
        <SimultTarget4>0</SimultTarget4>
        <TriggerMode>0</TriggerMode>
        <WarpTempo>120.000000</WarpTempo>
        <BpmLock>True</BpmLock>
        <WarpEnable>False</WarpEnable>
        <StretchPercentage>100</StretchPercentage>
${articulationXml(pad.articulation)}        <EditAllLayers>False</EditAllLayers>
        <Layers>
${body}        </Layers>
      </Instrument>
`;
}

/**
 * The MIDI note each of the 128 pads answers.
 *
 * Listed pads keep their note (default chromatic, pad 1 = 36), and two listed
 * pads may not share one. An unlisted pad takes its chromatic default unless a
 * listed pad or an earlier pad already holds it, in which case it takes the
 * next note no LISTED pad uses.
 */
export function xpmPadNotes(pads: ReadonlyMap<number, XpmPad>, programName = 'program'): Map<number, number> {
  const notes = new Map<number, number>();
  for (const [p, spec] of pads) notes.set(p, Math.trunc(spec.note ?? 35 + p));
  const used = [...notes.values()];
  if (used.length !== new Set(used).size) {
    throw new RangeError(`${programName}: two pads answer the same MIDI note: ${[...used].sort((x, y) => x - y).join(', ')}`);
  }
  const usedSet = new Set(used);
  const free: number[] = [];
  for (let n = 0; n < 128; n++) if (!usedSet.has(n)) free.push(n);
  let nextFree = 0;
  const taken = new Set(used);
  for (let p = 1; p <= XPM_PADS; p++) {
    if (notes.has(p)) continue;
    const d = (35 + p) % 128;
    let note: number;
    if (!taken.has(d)) {
      note = d;
    } else {
      if (nextFree >= free.length) throw new RangeError(`${programName}: no free MIDI note left for pad ${p}`);
      note = free[nextFree++];
    }
    notes.set(p, note);
    taken.add(note);
  }
  return notes;
}

export interface DrumProgramOptions {
  /** `Platform` header field. The device writes "Linux". */
  platform?: string;
}

/**
 * Build a drum `.xpm` as text.
 *
 * `pads` maps pad number 1..128 to its spec; pads not listed are written empty.
 * Every sampled pad gets a colour from its `colour` or `role`.
 */
export function drumProgram(name: string, pads: ReadonlyMap<number, XpmPad>, opts: DrumProgramOptions = {}): string {
  for (const [p, spec] of pads) {
    if (!Number.isInteger(p) || p < 1 || p > XPM_PADS) throw new RangeError(`pad ${p} out of range 1..${XPM_PADS}`);
    const n = spec.layers?.length ?? 0;
    if (n > XPM_LAYERS) throw new RangeError(`pad ${p}: ${n} layers > ${XPM_LAYERS}`);
  }
  const notes = xpmPadNotes(pads, name);
  const version = [...pads.values()].some((s) => s.articulation !== undefined)
    ? XPM_ARTICULATION_APP_VERSION
    : XPM_APP_VERSION;
  const colours = new Map<number, number>();
  for (const [p, spec] of pads) {
    if ((spec.layers?.length ?? 0) > 0) colours.set(p, padColour(spec.role, spec.colour));
  }
  let insts = '';
  let noteMap = '';
  let groupMap = '';
  for (let p = 1; p <= XPM_PADS; p++) {
    insts += instrumentXml(p, pads.get(p));
    noteMap += `      <PadNote number="${p}">\n        <Note>${notes.get(p)}</Note>\n      </PadNote>\n`;
    groupMap += `      <PadGroup number="${p}">\n        <Group>0</Group>\n      </PadGroup>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>

<MPCVObject>
  <Version>
    <File_Version>2.1</File_Version>
    <Application>MPC-V</Application>
    <Application_Version>${version}</Application_Version>
    <Platform>${opts.platform ?? 'Linux'}</Platform>
  </Version>
  <Program type="Drum">
    <ProgramName>${xmlEscape(name)}</ProgramName>
    ${programPadsElement(programPads(colours))}
    <CueBusEnable>False</CueBusEnable>
    <AudioRoute>
      <AudioRoute>2</AudioRoute>
      <AudioRouteSubIndex>0</AudioRouteSubIndex>
      <AudioRouteChannelBitmap>3</AudioRouteChannelBitmap>
      <InsertsEnabled>True</InsertsEnabled>
    </AudioRoute>
    <Send1>0.000000</Send1>
    <Send2>0.000000</Send2>
    <Send3>0.000000</Send3>
    <Send4>0.000000</Send4>
    <Volume>0.707946</Volume>
    <Mute>False</Mute>
    <Solo>False</Solo>
    <Pan>0.500000</Pan>
    <AutomationFilter>1</AutomationFilter>
    <Pitch>0.000000</Pitch>
    <TuneCoarse>0</TuneCoarse>
    <TuneFine>0</TuneFine>
    <Mono>False</Mono>
    <Program_Polyphony>0</Program_Polyphony>
    <PortamentoTime>0.000000</PortamentoTime>
    <PortamentoLegato>False</PortamentoLegato>
    <PortamentoQuantized>False</PortamentoQuantized>
    <Program.Xfader.Route>0</Program.Xfader.Route>
    <Instruments>
${insts}    </Instruments>
    <PadNoteMap>
${noteMap}    </PadNoteMap>
    <PadGroupMap>
${groupMap}    </PadGroupMap>
    <QLinkAssignments/>
  </Program>
</MPCVObject>
`;
}
