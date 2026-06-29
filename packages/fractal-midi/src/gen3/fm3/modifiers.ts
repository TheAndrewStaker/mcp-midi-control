/**
 * FM3 Modifier parameter map.
 *
 * A modifier attaches a modulation source to a target parameter and shapes it (range + transfer
 * curve + damping). The FM3 has 32 modifier slots; slot N is its own virtual effect addressed as
 * effectId `FM3_MOD_EFFECT_ID + (N-1)`. Settings are written as standard gen-3 SET frames
 *   `F0 00 01 74 11 01 <sub> <eid:2×7bit LE> <pid:2×7bit LE> <value:5×7bit packed f32> 00 00 cs F7`
 *   sub `09 00` discrete · `52 00` continuous. Every value uses the 5×7bit IEEE-754 f32 payload
 *   (ordinals and effectId/paramId references are sent as the integer's float).
 *
 * Derived from the device's editor configuration tables. The kinds reflect the value semantics
 * (e.g. `offset` is bipolar / signed; `targetEffectId`/`targetParam` are block/param references).
 *
 * ── Target binding (per-control assignment) ─────────────────────────
 * The modifier→target link lives ON the modifier itself, as two of its own params:
 *   pid 8 = `targetEffectId` — the block being modulated
 *   pid 9 = `targetParam`    — the paramId within that block
 * To bind a modifier slot to `(blockEid, paramId)` with a given source, SET on the slot's eid:
 *   (eid, 8) = blockEid · (eid, 9) = paramId · (eid, 0) = sourceOrdinal · then shape with the curve pids.
 * See `fm3ModBindFrames`.
 */

/** ID_MODIFIER1. Slot N (1-based) = FM3_MOD_EFFECT_ID + (N-1), through slot 32. */
export const FM3_MOD_EFFECT_ID = 3;
export const FM3_MOD_SLOT_COUNT = 32;
export const fm3ModSlotEid = (slot1Based: number): number => FM3_MOD_EFFECT_ID + (slot1Based - 1);

export type Fm3ModField =
  | 'source'
  | 'min'
  | 'max'
  | 'start'
  | 'mid'
  | 'end'
  | 'slope'
  | 'attack'
  | 'targetEffectId'
  | 'targetParam'
  | 'autoEngage'
  | 'pcReset'
  | 'offValue'
  | 'scale'
  | 'offset'
  | 'release'
  | 'updateRate'
  | 'channel'
  | 'xMark'
  | 'yMark'
  | 'ctrlId2'
  | 'scale1'
  | 'scale2'
  | 'operation'
  | 'damping';

export interface Fm3ModFieldDef {
  pid: number;
  /** 'ordinal' = enum/index · 'norm' = 0..1 · 'bipolar' = signed (±) · 'ref' = effectId/paramId reference. */
  kind: 'ordinal' | 'norm' | 'bipolar' | 'ref';
  /** true = confirmed on the wire; false = present in the config tables but not yet exercised. */
  verified: boolean;
  /** short UI role label. */
  role: string;
}

export const FM3_MOD_FIELDS: Record<Fm3ModField, Fm3ModFieldDef> = {
  source: { pid: 0, kind: 'ordinal', verified: true, role: 'Source' },
  min: { pid: 1, kind: 'norm', verified: true, role: 'Range Min' },
  max: { pid: 2, kind: 'norm', verified: true, role: 'Range Max' },
  start: { pid: 3, kind: 'norm', verified: true, role: 'Mapping Start' },
  mid: { pid: 4, kind: 'norm', verified: true, role: 'Mapping Mid' },
  end: { pid: 5, kind: 'norm', verified: true, role: 'Mapping End' },
  slope: { pid: 6, kind: 'norm', verified: true, role: 'Mapping Slope' },
  attack: { pid: 7, kind: 'norm', verified: true, role: 'Damping Attack' },
  targetEffectId: { pid: 8, kind: 'ref', verified: true, role: 'Target block effectId (binding)' },
  targetParam: { pid: 9, kind: 'ref', verified: true, role: 'Target paramId (binding)' },
  autoEngage: { pid: 10, kind: 'ordinal', verified: true, role: 'Auto Engage' },
  pcReset: { pid: 11, kind: 'ordinal', verified: true, role: 'PC Reset' },
  offValue: { pid: 12, kind: 'norm', verified: true, role: 'Off Value' },
  scale: { pid: 13, kind: 'norm', verified: true, role: 'Mapping Scale' },
  offset: { pid: 14, kind: 'bipolar', verified: true, role: 'Mapping Offset' },
  release: { pid: 15, kind: 'norm', verified: true, role: 'Damping Release' },
  updateRate: { pid: 16, kind: 'ordinal', verified: true, role: 'Update Rate' },
  channel: { pid: 17, kind: 'ordinal', verified: true, role: 'Channel' },
  xMark: { pid: 18, kind: 'norm', verified: false, role: 'Graph X marker (editor display)' },
  yMark: { pid: 19, kind: 'norm', verified: false, role: 'Graph Y marker (editor display)' },
  ctrlId2: { pid: 20, kind: 'ordinal', verified: false, role: 'Secondary source' },
  scale1: { pid: 21, kind: 'norm', verified: false, role: 'Scale operand 1' },
  scale2: { pid: 22, kind: 'norm', verified: false, role: 'Scale operand 2' },
  operation: { pid: 23, kind: 'ordinal', verified: false, role: 'Source blend operation' },
  damping: { pid: 24, kind: 'ordinal', verified: true, role: 'Damping mode' }
};

/**
 * Modulation sources (MOD_CTRLID / pid 0), ordinal → name. The full list the editor offers for a
 * modifier's source; ordinal is the value written to pid 0 (0-based; the editor displays them 1-based).
 * Device-confirmed (writing ordinal 50 selected "Control Switch 1", row 51 in the editor's list).
 */
export const FM3_MOD_SOURCES: readonly { ordinal: number; name: string }[] = [
  { ordinal: 0, name: 'None' },
  { ordinal: 1, name: 'LFO 1A' },
  { ordinal: 2, name: 'LFO 1B' },
  { ordinal: 3, name: 'LFO 2A' },
  { ordinal: 4, name: 'LFO 2B' },
  { ordinal: 5, name: 'ADSR 1' },
  { ordinal: 6, name: 'ADSR 2' },
  { ordinal: 7, name: 'Sequencer' },
  { ordinal: 8, name: 'Envelope Follower' },
  { ordinal: 9, name: 'Pitch Follower' },
  { ordinal: 10, name: 'Pedal 1 (EXP/SW TIP)' },
  { ordinal: 11, name: 'Pedal 2 (EXP/SW TIP)' },
  { ordinal: 12, name: 'Pedal 1 (SW RING)' },
  { ordinal: 13, name: 'Pedal 2 (SW RING)' },
  { ordinal: 14, name: 'External 1' },
  { ordinal: 15, name: 'External 2' },
  { ordinal: 16, name: 'External 3' },
  { ordinal: 17, name: 'External 4' },
  { ordinal: 18, name: 'External 5' },
  { ordinal: 19, name: 'External 6' },
  { ordinal: 20, name: 'External 7' },
  { ordinal: 21, name: 'External 8' },
  { ordinal: 22, name: 'External 9' },
  { ordinal: 23, name: 'External 10' },
  { ordinal: 24, name: 'External 11' },
  { ordinal: 25, name: 'External 12' },
  { ordinal: 26, name: 'External 13' },
  { ordinal: 27, name: 'External 14' },
  { ordinal: 28, name: 'External 15' },
  { ordinal: 29, name: 'External 16' },
  { ordinal: 30, name: 'Scene Controller 1' },
  { ordinal: 31, name: 'Scene Controller 2' },
  { ordinal: 32, name: 'Scene Controller 3' },
  { ordinal: 33, name: 'Scene Controller 4' },
  { ordinal: 34, name: 'FC 1 Pedal 1' },
  { ordinal: 35, name: 'FC 1 Pedal 2' },
  { ordinal: 36, name: 'FC 1 Pedal 3' },
  { ordinal: 37, name: 'FC 1 Pedal 4' },
  { ordinal: 38, name: 'FC 1 Ext. Switch 1' },
  { ordinal: 39, name: 'FC 1 Ext. Switch 2' },
  { ordinal: 40, name: 'FC 1 Ext. Switch 3' },
  { ordinal: 41, name: 'FC 1 Ext. Switch 4' },
  { ordinal: 42, name: 'FC 2 Pedal 1' },
  { ordinal: 43, name: 'FC 2 Pedal 2' },
  { ordinal: 44, name: 'FC 2 Pedal 3' },
  { ordinal: 45, name: 'FC 2 Pedal 4' },
  { ordinal: 46, name: 'FC 2 Ext. Switch 1' },
  { ordinal: 47, name: 'FC 2 Ext. Switch 2' },
  { ordinal: 48, name: 'FC 2 Ext. Switch 3' },
  { ordinal: 49, name: 'FC 2 Ext. Switch 4' },
  { ordinal: 50, name: 'Control Switch 1' },
  { ordinal: 51, name: 'Control Switch 2' },
  { ordinal: 52, name: 'Control Switch 3' },
  { ordinal: 53, name: 'Control Switch 4' },
  { ordinal: 54, name: 'Control Switch 5' },
  { ordinal: 55, name: 'Control Switch 6' },
  { ordinal: 56, name: 'Manual 1' },
  { ordinal: 57, name: 'Manual 2' },
  { ordinal: 58, name: 'Manual 3' },
  { ordinal: 59, name: 'Manual 4' },
  { ordinal: 60, name: 'Manual 5' }
];

/** Known modulation-source ordinal (MOD_CTRLID / pid 0): Pedal 1 (EXP/SW TIP). */
export const FM3_MOD_SOURCE_PEDAL1 = 10;

/** paramId for a modifier field. */
export function fm3ModParamId(field: Fm3ModField): number {
  return FM3_MOD_FIELDS[field].pid;
}

/**
 * The (pid, value) writes that bind a modifier slot to a target parameter with a source. Send each
 * as a discrete SET (sub `09 00`) on the modifier slot's eid, then write the curve fields to shape it.
 */
export function fm3ModBindFrames(targetEffectId: number, targetParam: number, sourceOrdinal: number): { pid: number; value: number }[] {
  return [
    { pid: FM3_MOD_FIELDS.targetEffectId.pid, value: targetEffectId },
    { pid: FM3_MOD_FIELDS.targetParam.pid, value: targetParam },
    { pid: FM3_MOD_FIELDS.source.pid, value: sourceOrdinal }
  ];
}
