/**
 * AX8 config for `createAxeFxIIDescriptor` (`../descriptor.ts`). BK-094.
 *
 * The AX8 is Fractal's floor-unit multi-FX pedalboard: the Axe-Fx II engine
 * (same gen-2 codec: `00 01 74` envelope, XOR-`&0x7F` checksum, fn=0x02 SET,
 * fn=0x1F atomic read, fn=0x77/78/79 preset dump) in a different chassis, NOT
 * a new protocol. No AX8 unit is on hand; every fact below is evidence-backed
 * (citable, some self-validating via checksum) but UNTESTED end-to-end on
 * real AX8 hardware, per the shipping-bar rule in CLAUDE.md: untested is not
 * unbuilt, so this ships community-beta rather than staying out.
 *
 * Full citations + the community capture ask:
 * `docs/_private/AX8-RESEARCH-2026-07-09.md`.
 *
 * FACTS (each independently verified from >=2 sources; see the research note):
 *
 * - MODEL BYTE 0x08. Sources: (1) `fractal-midi/docs/devices/axe-fx-ii/
 *   SYSEX-MAP.md` family table + `setParam.ts`'s `MODEL_IDS.ax8` (both from
 *   the cached Fractal Audio Wiki "MIDI_SysEx" page); (2) an independently
 *   surfaced AX8 wire example `F0 00 01 74 08 14 00 00 19 F7` (fn=0x14
 *   GET_PRESET_NUMBER response), SELF-VALIDATING: XOR-`&0x7F` of
 *   `F0 00 01 74 08 14 00 00` is `0x19`, matching the frame's own checksum
 *   byte exactly under this codec's checksum function. A checksum match is
 *   the project's own "STRONG evidence" tier (self-gating, per CLAUDE.md).
 * - GRID: 4 rows x 12 columns, SAME shape as the XL+ (not reduced). Source:
 *   AX8 Owner's Manual, "The Grid Concept": "Virtual gear is selected from
 *   the inventory and placed as 'blocks' into the slots of a 12x4 'layout
 *   grid.'" (fractalaudio.com/downloads/manuals/AX8/AX8-Owners-Manual.pdf).
 * - PRESETS: 512 total, 64 banks x 8 presets/bank. Source: AX8 Owner's
 *   Manual, "Saving Changes": "The AX8 has 512 preset memory locations
 *   grouped in 64 numbered banks. Each bank contains 8 presets." The wire
 *   format + `parseAxeFxIILocation` ceiling (1..16384, the 14-bit wire
 *   field) are UNCHANGED from the XL+: same as the XL+ descriptor already
 *   doesn't hard-enforce its own 768-preset physical count, this config
 *   doesn't hard-enforce 512 either; the true physical envelope is
 *   documented here and in `verification` for agent narration.
 * - SCENES: 8 per preset, same X/Y-plus-bypass model as the XL+. Source: AX8
 *   Owner's Manual, "Selecting Scenes": "Every preset has eight scenes built
 *   in and ready to use," "The on/off state of every block in your preset
 *   can be programmed per Scene," and "turn effects ON/OFF and select X/Y
 *   states" per scene.
 * - X/Y CHANNELS: same model as the XL+, "Most blocks offer X/Y switching."
 *   No codec rework needed (confirms the BK-094 scoping note).
 * - BLOCK ROSTER: reduced vs the XL+, single-instance-only on several
 *   groups (Amp 2 / Cab 2 / Reverb 2 / Multi Delay 2 / Chorus 2 / Flanger 2 /
 *   Rotary Speaker 2 / Phaser 2 / Wah 2 / Tremolo/Panner 2 / Gate Expander 2 /
 *   Pitch 2 / Synth 2, plus Mixer / Mixer 2 / Vocoder / Megatap Delay /
 *   Crossover 1-2 / Multiband Compressor 1-2 / Quad Chorus 1-2 / Resonator
 *   1-2 / Graphic EQ 3-4 / Parametric EQ 3-4 / Filter 3-4 / Volume-Pan 3-4 /
 *   Tone Match are absent entirely). Source: `fractal-midi/gen2/axe-fx-ii/
 *   blockTypes.ts`'s `availableOnAX8` field, itself mined from the same
 *   Fractal Audio Wiki "MIDI_SysEx" page's Block IDs table (the wiki's AX8
 *   availability column) that supplies the block-ID table itself.
 *
 * GATING: none (since the BK-GEN2-FACTORY follow-up, 2026-07-15). The shared
 * multi-step build pipeline (`tools/applyExecutor.ts`) is now model-byte-
 * parameterized: `createWriter(config)` threads `config.modelByte` through
 * every op builder AND the runtime reads/verifies (grid read, safety mute,
 * channel/scene verify matchers + parsers), so `apply_preset` /
 * `apply_setlist` emit correctly-addressed `0x08` frames and ship un-gated,
 * community-beta (evidence-backed, untested on hardware), same as every
 * other write. The config's `isBlockAvailable` filter also applies inside
 * the apply pipeline: a spec addressing a block instance the AX8 lacks
 * (e.g. "Amp 2") refuses at build time, before any wire I/O. The
 * `writesGated` / `writeAllowlist` mechanism remains available in
 * `descriptor/config.ts` for future configs; this config no longer uses it.
 */
import type { AxeFxIIConfig } from '../descriptor/config.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';

const AX8_MODEL_BYTE = 0x08;

/**
 * AX8-safe `describe_device.example_spec`. The XL+'s shared example places a
 * SECOND Amp instance (`amp_2`, effectId 107); `availableOnAX8: false` on
 * that block (`fractal-midi/gen2/axe-fx-ii/blockTypes.ts`), so this config
 * supplies its own single-amp variant (drive -> amp -> cab -> reverb) that
 * only ever addresses instance-1 blocks, all of which ARE present on AX8.
 */
const AX8_EXAMPLE_SPEC: PresetSpec = {
  name: 'Demo',
  slots: [
    {
      slot: { row: 2, col: 1 },
      block_type: 'drive',
      params_by_channel: {
        X: { effect_type: 'TUBE DRV 3-KNOB', gain: 3, tone: 6, volume: 5 },
      },
    },
    {
      slot: { row: 2, col: 2 },
      block_type: 'amp',
      params_by_channel: {
        X: { effect_type: 'USA CLEAN', input_drive: 3, master_volume: 5 },
        Y: { effect_type: 'USA IIC+', input_drive: 6, master_volume: 4 },
      },
    },
    { slot: { row: 2, col: 3 }, block_type: 'cab' },
    {
      slot: { row: 2, col: 4 },
      block_type: 'reverb',
      params_by_channel: {
        X: { effect_type: 'MEDIUM PLATE', mix: 25 },
      },
    },
  ],
  scenes: [
    { scene: 1, name: 'Clean', channels: { amp: 'X', reverb: 'X' }, bypassed: { drive: true } },
    { scene: 2, name: 'Lead', channels: { amp: 'Y', reverb: 'X' }, bypassed: { drive: false } },
  ],
  landingScene: 1,
};

export const AX8_CONFIG: AxeFxIIConfig = {
  id: 'ax8',
  displayName: 'Fractal AX8',
  modelByte: AX8_MODEL_BYTE,
  connectionLabel: 'ax8',
  portMatch: [{ pattern: /ax8/i }],
  supportTier: 'community-beta',
  verification:
    'No AX8 hardware on hand; every fact is evidence-backed (community-beta, untested end-to-end). ' +
    'Model byte 0x08: Fractal Audio Wiki "MIDI_SysEx" page (cached in this repo\'s SYSEX-MAP.md + ' +
    'setParam.ts MODEL_IDS) plus an independently-surfaced AX8 capture whose checksum byte matches ' +
    'this codec\'s XOR-&0x7F formula exactly (self-validating). Grid (4x12, same as XL+), preset count ' +
    '(512 across 64 banks), and scene count (8) are cited from the AX8 Owner\'s Manual. ' +
    'set_param / set_params / get_param / get_params / set_block / set_bypass / switch_preset / ' +
    'switch_scene / save_preset / scan_locations / get_preset / export_preset / import_preset / ' +
    'apply_preset / apply_setlist ship community-beta: every frame, including the multi-step apply ' +
    'pipeline, is correctly model-byte-addressed (0x08), but no owner round-trip yet (hardware-unverified).',
  isBlockAvailable: (block) => block.availableOnAX8,
  exampleSpec: AX8_EXAMPLE_SPEC,
  agentGuidanceOverlay: {
    device_note: [
      'This is the Fractal AX8 floor unit (community beta; no AX8 hardware on hand, evidence-backed',
      'from the wiki + owner\'s manual). It reuses the',
      'Axe-Fx II gen-2 codec with model byte 0x08. Grid, X/Y channels, and 8 scenes/preset are the',
      'same as the XL+; the block roster is REDUCED to single-instance-only on several groups (no Amp 2,',
      'Cab 2, Reverb 2, Multi Delay 2, Chorus 2, Flanger 2, Rotary 2, Phaser 2, Wah 2, Tremolo/Panner 2,',
      'Gate Expander 2, Pitch 2, Synth 2; Mixer, Vocoder, Megatap Delay, Crossover, Multiband Compressor,',
      'Quad Chorus, Resonator, and the 3rd/4th GEQ/PEQ/Filter/Volume-Pan instances are absent entirely).',
      'Addressing an unavailable block/instance refuses with a clear message rather than silently',
      'building a frame the device will never answer. 512 presets across 64 banks (8 per bank); the',
      'wire location format still accepts 1..16384 (the 14-bit wire ceiling, same as the XL+) but only',
      '1..512 are physically present on the unit.',
      '',
      'set_param / set_params / get_param / get_params / set_block / set_bypass / switch_preset /',
      'switch_scene / save_preset / scan_locations / get_preset / export_preset / import_preset /',
      'apply_preset / apply_setlist are correctly model-byte-addressed (0x08) and ship community-beta',
      '(hardware-unverified): drive them normally, then ask the user to confirm by ear / front panel.',
      'An apply_preset spec that addresses a block instance the AX8 lacks (e.g. "Amp 2") refuses at',
      'build time with a clear message, before any wire I/O.',
    ].join('\n'),
  },
};
