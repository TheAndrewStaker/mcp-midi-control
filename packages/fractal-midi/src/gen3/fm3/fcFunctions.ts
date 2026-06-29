/**
 * FM3 Foot Controller — per-category FUNCTION model (the SUBFUNCS vocabulary + the meaning of the
 * 6 PARAMS value-slots + the per-function label-mode options).
 *
 * Derived from the device's editor UI behaviour, cross-confirmed against a controlled capture
 * (SUBFUNCS pid 108 = function ordinal; PARAMS pids 324.. = the 6-wide value block; DISPFUNCS pid
 * 216 = the chosen label index) and the editor's `.fclayout` export (attributes category/function/
 * displayFunc/ringColor + 6×param map 1:1 to the wire pids).
 *
 * Addressing (with footController.ts): a function's value slot `i` is written to
 *   fm3FcParamId('tapParams'|'holdParams', layout, view, switch) + i      (6 slots per config)
 * the function ordinal to the FUNCS field, the label index to the DISPLAY field.
 *
 * ── Confidence ───────────────────────────────────────────────────────
 * Preset (cat 2), Scene (3) and Effect (4) function ordinals are capture-VERIFIED (FUNC writes
 * 0..4 / 0..2 / 0..3) and their slot roles match the captured value writes + the editor UI. Bank
 * (1) has 3 functions in the export; only Select(0) is detailed here. Categories 5..13
 * (Utility/Layout/Control-Switch/Looper/Per-Preset/View/Setlist/Song/Song-Section) appear in the
 * export with their function ordinals but their slot roles aren't transcribed yet — the editor
 * shows raw fields for those until a second capture pass.
 */

export type Fm3FcSlotType = 'preset' | 'scene' | 'channel' | 'block' | 'int' | 'enum' | 'bool';

export interface Fm3FcSlot {
  /** which of the 6 PARAMS slots (0..5). */
  i: number;
  role: string;
  type: Fm3FcSlotType;
  min?: number;
  max?: number;
  /** option labels for type 'enum' (wire value = index). */
  options?: readonly string[];
}

export interface Fm3FcFunctionDef {
  /** SUBFUNCS ordinal. */
  ord: number;
  name: string;
  /** the value slots this function uses, within the 6-wide PARAMS block. */
  slots: readonly Fm3FcSlot[];
  /** label-mode options in dropdown order — the DISPLAY field wire value is the index here. */
  labels: readonly string[];
}

const RANGE_LABELS = ['Destination Name', 'Action', 'Destination #', 'Current Name', 'Current #', 'Custom'] as const;
const TOGGLE_LABELS = ['Destination Name', 'Both #', 'Destination #', 'Current Name', 'Current #', 'Custom'] as const;

/** category ordinal → its function definitions (ordered by SUBFUNCS ordinal). */
export const FM3_FC_FUNCTIONS: Readonly<Record<number, readonly Fm3FcFunctionDef[]>> = {
  0: [{ ord: 0, name: 'Unassigned', slots: [], labels: [] }],

  // Bank (cat 1) — Select detailed; Inc/Dec + a third function exist in the export (slots TBD).
  1: [
    {
      ord: 0,
      name: 'Select',
      slots: [
        { i: 0, role: 'Bank', type: 'int', min: 1, max: 8 },
        { i: 1, role: 'Preset Load', type: 'enum', options: ['None', 'Current', 'First'] },
        { i: 2, role: '2nd Press = Prev. Bank', type: 'bool' },
      ],
      labels: ['Number', 'Custom'],
    },
  ],

  // Preset (cat 2) — function ordinals 0..4 capture-verified.
  2: [
    {
      ord: 0,
      name: 'Select by #',
      slots: [
        { i: 0, role: 'Preset', type: 'preset' },
        { i: 1, role: '2nd Press = Prev. Preset', type: 'bool' },
      ],
      labels: ['Name', 'Number', 'Custom'],
    },
    {
      ord: 1,
      name: 'Select in Bank',
      slots: [
        { i: 0, role: 'Preset', type: 'enum', options: ['1', '2', '3'] },
        { i: 1, role: '2nd Press = Prev. Preset', type: 'bool' },
      ],
      labels: ['Name', 'P#', 'Number', 'Custom'],
    },
    {
      ord: 2,
      name: 'Toggle by #',
      slots: [
        { i: 0, role: 'Primary Preset', type: 'preset' },
        { i: 1, role: 'Secondary Preset', type: 'preset' },
      ],
      labels: [...TOGGLE_LABELS],
    },
    {
      ord: 3,
      name: 'Toggle in Bank',
      slots: [
        { i: 0, role: 'Primary Preset', type: 'enum', options: ['1', '2', '3'] },
        { i: 1, role: 'Secondary Preset', type: 'enum', options: ['1', '2', '3'] },
      ],
      labels: [...TOGGLE_LABELS],
    },
    {
      ord: 4,
      name: 'Increment / Decrement',
      slots: [
        { i: 0, role: 'Increment', type: 'int', min: -10, max: 10 },
        { i: 1, role: 'Wrap', type: 'bool' },
        { i: 2, role: 'Lower Limit', type: 'preset' },
        { i: 3, role: 'Upper Limit', type: 'preset' },
      ],
      labels: [...RANGE_LABELS],
    },
  ],

  // Scene (cat 3) — ordinals 0..2 capture-verified.
  3: [
    {
      ord: 0,
      name: 'Select',
      slots: [
        { i: 0, role: 'Scene', type: 'scene', min: 1, max: 8 },
        { i: 1, role: '2nd Press = Prev. Scene', type: 'bool' },
      ],
      labels: ['Name', 'Number', 'Custom'],
    },
    {
      ord: 1,
      name: 'Toggle',
      slots: [
        { i: 0, role: 'Primary Scene', type: 'scene', min: 1, max: 8 },
        { i: 1, role: 'Secondary Scene', type: 'scene', min: 1, max: 8 },
      ],
      labels: [...TOGGLE_LABELS],
    },
    {
      ord: 2,
      name: 'Increment / Decrement',
      slots: [
        { i: 0, role: 'Increment', type: 'int', min: -4, max: 4 },
        { i: 1, role: 'Wrap', type: 'bool' },
        { i: 2, role: 'Lower Limit', type: 'scene', min: 1, max: 8 },
        { i: 3, role: 'Upper Limit', type: 'scene', min: 1, max: 8 },
      ],
      labels: [...RANGE_LABELS],
    },
  ],

  // Effect (cat 4) — ordinals 0..3 capture-verified. 'block' = a placed-block id (the editor's
  // effect dropdown / Amp 1, Cab 1, …); 'channel' = A..D.
  4: [
    {
      ord: 0,
      name: 'Bypass',
      slots: [{ i: 0, role: 'Effect', type: 'block' }],
      labels: ['Long Name', 'Short Name', 'Long Name + Channel', 'Short Name + Channel', 'Custom'],
    },
    {
      ord: 1,
      name: 'Channel Select',
      slots: [
        { i: 0, role: 'Effect', type: 'block' },
        { i: 1, role: 'Channel', type: 'channel' },
        { i: 2, role: '2nd Press', type: 'enum', options: ['Off', 'Smart Bypass', 'Prev. Channel'] },
      ],
      labels: ['Short Name + Channel', 'Long Name + Channel', 'Custom'],
    },
    {
      ord: 2,
      name: 'Channel Toggle',
      slots: [
        { i: 0, role: 'Effect', type: 'block' },
        { i: 1, role: 'Primary Channel', type: 'channel' },
        { i: 2, role: 'Secondary Channel', type: 'channel' },
      ],
      labels: ['Both Channel', 'Destination Channel', 'Current Channel', 'Custom'],
    },
    {
      ord: 3,
      name: 'Channel Inc / Dec',
      slots: [
        { i: 0, role: 'Effect', type: 'block' },
        { i: 1, role: 'Increment', type: 'int', min: -2, max: 2 },
        { i: 2, role: 'Wrap', type: 'bool' },
        { i: 3, role: 'Lower Limit', type: 'channel' },
        { i: 4, role: 'Upper Limit', type: 'channel' },
      ],
      labels: ['Action', 'Destination Channel', 'Current Channel', 'Custom'],
    },
  ],
};

/** Channel ordinals (A..D) used by Effect channel slots. */
export const FM3_FC_CHANNELS: readonly string[] = ['A', 'B', 'C', 'D'];

/** functions for a category ordinal (empty if not yet modelled — editor falls back to raw fields). */
export function fm3FcFunctions(category: number): readonly Fm3FcFunctionDef[] {
  return FM3_FC_FUNCTIONS[category] ?? [];
}
