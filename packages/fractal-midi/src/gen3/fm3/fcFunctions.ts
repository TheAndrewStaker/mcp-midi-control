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
 * (1) has 3 functions in the export; only Select(0) is detailed here. Categories 5..13 (Utility,
 * Layout, Control Switch, Looper, Per-Preset, View, Setlist, Song, Song Section) have their function
 * names + ordinals and operand option-ranges transcribed from the editor UI. Slot indices are
 * WIRE-CONFIRMED contiguous (slot i → PARAMS base + i, NOT interleaved): a Layout/Inc-Dec capture
 * wrote Inc/Decrement→base+0, Lower Limit→base+2, Upper Limit→base+3, View→base+4 (Wrap=base+1
 * untouched), matching the display order here; the same capture confirmed FUNCS(pid 0)=category ordinal
 * and SUBFUNCS(pid 108)=function ordinal. The per-function label-mode lists are still partial (the
 * selected mode + Custom). Functions with no operands (Looper, Tap/Tuner under Utility) carry empty slots.
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

  // Utility (cat 5) — footswitch utility functions. Tap Tempo / Tuner are single-action (no operands);
  // the *+Save / Reveal Hold operands aren't transcribed yet (editor falls back to raw fields).
  5: [
    { ord: 0, name: 'Tuner', slots: [], labels: ['Function', 'Custom'] },
    { ord: 1, name: 'Tap Tempo', slots: [], labels: ['Function', 'Custom'] },
    { ord: 2, name: 'Amp Level+Save', slots: [], labels: ['Function', 'Custom'] },
    { ord: 3, name: 'Reveal Hold', slots: [], labels: ['Function', 'Custom'] },
    { ord: 4, name: 'Scene Level+Save', slots: [], labels: ['Function', 'Custom'] },
  ],

  // Layout (cat 6). Function names + operand option-ranges screenshot-verified; slot indices are
  // display-order (top-to-bottom in the editor), not yet wire-confirmed.
  6: [
    {
      ord: 0,
      name: 'Select',
      slots: [
        { i: 0, role: 'Layout', type: 'int', min: 1, max: 9 },
        { i: 1, role: 'View', type: 'int', min: 1, max: 4 },
      ],
      labels: ['Name', 'Custom'],
    },
    { ord: 1, name: 'Master Layout', slots: [{ i: 0, role: 'View', type: 'int', min: 1, max: 4 }], labels: ['Function', 'Custom'] },
    {
      ord: 2,
      name: 'Inc / Dec',
      slots: [
        { i: 0, role: 'Inc / Decrement', type: 'int', min: -4, max: 4 },
        { i: 1, role: 'Wrap', type: 'enum', options: ['Wrap', 'No Wrap'] },
        { i: 2, role: 'Lower Limit', type: 'int', min: 1, max: 9 },
        { i: 3, role: 'Upper Limit', type: 'int', min: 1, max: 9 },
        { i: 4, role: 'View', type: 'int', min: 1, max: 4 },
      ],
      labels: ['Action', 'Custom'],
    },
  ],

  // Control Switch (cat 7) — function = Momentary/Latching; the operand slot picks which CS (1..6).
  7: [
    {
      ord: 0,
      name: 'Momentary',
      slots: [{ i: 0, role: 'Control Switch', type: 'enum', options: ['CS1', 'CS2', 'CS3', 'CS4', 'CS5', 'CS6'] }],
      labels: ['Function', 'Custom'],
    },
    {
      ord: 1,
      name: 'Latching',
      slots: [{ i: 0, role: 'Control Switch', type: 'enum', options: ['CS1', 'CS2', 'CS3', 'CS4', 'CS5', 'CS6'] }],
      labels: ['Function', 'Custom'],
    },
  ],

  // Looper (cat 8) — single-action functions, no operands.
  8: [
    { ord: 0, name: 'Record', slots: [], labels: ['Function', 'Custom'] },
    { ord: 1, name: 'Play/Stop', slots: [], labels: ['Function', 'Custom'] },
    { ord: 2, name: 'Reverse', slots: [], labels: ['Function', 'Custom'] },
    { ord: 3, name: 'Once', slots: [], labels: ['Function', 'Custom'] },
    { ord: 4, name: 'Undo/Erase', slots: [], labels: ['Function', 'Custom'] },
    { ord: 5, name: 'Half Speed', slots: [], labels: ['Function', 'Custom'] },
  ],

  // Per-Preset (cat 9) — one function; the operand selects which Per-Preset switch (PP# 1..24).
  9: [{ ord: 0, name: 'Placeholder', slots: [{ i: 0, role: 'Preset Switch', type: 'int', min: 1, max: 24 }], labels: [] }],

  // View (cat 10).
  10: [
    { ord: 0, name: 'Select', slots: [{ i: 0, role: 'View', type: 'int', min: 1, max: 4 }], labels: ['Destination', 'Custom'] },
    {
      ord: 1,
      name: 'Inc / Dec',
      slots: [
        { i: 0, role: 'Inc / Decrement', type: 'int', min: -3, max: 3 },
        { i: 1, role: 'Wrap', type: 'enum', options: ['Wrap', 'No Wrap'] },
        { i: 2, role: 'Lower Limit', type: 'int', min: 1, max: 4 },
        { i: 3, role: 'Upper Limit', type: 'int', min: 1, max: 4 },
      ],
      labels: ['Action', 'Custom'],
    },
  ],

  // Setlist (cat 11). Song Load = None/First.
  11: [
    {
      ord: 0,
      name: 'Select',
      slots: [
        { i: 0, role: 'Setlist', type: 'int', min: 1, max: 4 },
        { i: 1, role: 'Song Load', type: 'enum', options: ['None', 'First'] },
      ],
      labels: ['Name', 'Custom'],
    },
    {
      ord: 1,
      name: 'Toggle',
      slots: [
        { i: 0, role: 'Primary Setlist', type: 'int', min: 1, max: 4 },
        { i: 1, role: 'Secondary Setlist', type: 'int', min: 1, max: 4 },
        { i: 2, role: 'Song Load', type: 'enum', options: ['None', 'First'] },
      ],
      labels: ['Destination Name', 'Custom'],
    },
    {
      ord: 2,
      name: 'Inc / Dec',
      slots: [
        { i: 0, role: 'Inc / Decrement', type: 'int', min: -1, max: 1 },
        { i: 1, role: 'Wrap', type: 'enum', options: ['Wrap', 'No Wrap'] },
        { i: 2, role: 'Lower Limit', type: 'int', min: 1, max: 4 },
        { i: 3, role: 'Upper Limit', type: 'int', min: 1, max: 4 },
        { i: 4, role: 'Song Load', type: 'enum', options: ['None', 'First'] },
      ],
      labels: ['Destination Name', 'Custom'],
    },
  ],

  // Song (cat 12) — 32 songs per setlist.
  12: [
    { ord: 0, name: 'Select in Set', slots: [{ i: 0, role: 'Song', type: 'int', min: 1, max: 32 }], labels: ['Name', 'Custom'] },
    {
      ord: 1,
      name: 'Toggle in Set',
      slots: [
        { i: 0, role: 'Primary Song', type: 'int', min: 1, max: 32 },
        { i: 1, role: 'Secondary Song', type: 'int', min: 1, max: 32 },
      ],
      labels: ['Destination Name', 'Custom'],
    },
    {
      ord: 2,
      name: 'Inc / Dec in Set',
      slots: [
        { i: 0, role: 'Inc / Decrement', type: 'int', min: -10, max: 10 },
        { i: 1, role: 'Wrap', type: 'enum', options: ['Wrap', 'No Wrap'] },
        { i: 2, role: 'Lower Limit', type: 'int', min: 1, max: 32 },
        { i: 3, role: 'Upper Limit', type: 'int', min: 1, max: 32 },
      ],
      labels: ['Destination Name', 'Custom'],
    },
  ],

  // Song Section (cat 13) — 6 sections per song.
  13: [
    { ord: 0, name: 'Select', slots: [{ i: 0, role: 'Song Section', type: 'int', min: 1, max: 6 }], labels: ['Name', 'Custom'] },
    {
      ord: 1,
      name: 'Toggle',
      slots: [
        { i: 0, role: 'Primary Section', type: 'int', min: 1, max: 6 },
        { i: 1, role: 'Secondary Section', type: 'int', min: 1, max: 6 },
      ],
      labels: ['Destination Name', 'Custom'],
    },
    {
      ord: 2,
      name: 'Inc / Dec',
      slots: [
        { i: 0, role: 'Inc / Decrement', type: 'int', min: -6, max: 6 },
        { i: 1, role: 'Wrap', type: 'enum', options: ['Wrap', 'No Wrap'] },
        { i: 2, role: 'Lower Limit', type: 'int', min: 1, max: 6 },
        { i: 3, role: 'Upper Limit', type: 'int', min: 1, max: 6 },
      ],
      labels: ['Destination Name', 'Custom'],
    },
  ],
};

/** Channel ordinals (A..D) used by Effect channel slots. */
export const FM3_FC_CHANNELS: readonly string[] = ['A', 'B', 'C', 'D'];

/** functions for a category ordinal (empty if not yet modelled — editor falls back to raw fields). */
export function fm3FcFunctions(category: number): readonly Fm3FcFunctionDef[] {
  return FM3_FC_FUNCTIONS[category] ?? [];
}
