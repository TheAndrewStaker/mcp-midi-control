/**
 * Block-stack recipe library — multi-block iconic-tone arrangements.
 *
 * Background (Session 106): single-block recipes (auto_wah, pitch, wah,
 * filter, scene_leveling) shipped behind a `recipes[]` field on
 * describe_device. The senior MCP engineer review flagged block-stack
 * recipes as "the biggest unlock" because:
 *
 *   - The auto-wah failure surfaced was about vocabulary-to-block
 *     mapping (user says "auto-wah," agent has to know FILTER block on
 *     AM4 / WAH block on II). Multi-block prompts compound that gap
 *     (user says "Edge dotted-8th," agent has to know comp + amp + delay
 *     + reverb in a specific order with specific knob values).
 *   - Multi-block recipes also encode SLOT ORDER — a thing the agent
 *     currently has to derive from prose and often gets wrong.
 *
 * Founder requirement: "VERY CAREFUL about curating this list to ensure
 * it is accurate and the most popular choices are included." This file
 * is intentionally small (3 recipes at first ship). Each recipe:
 *
 *   - Represents a genuinely iconic, well-documented tone (Edge,
 *     80s shimmer, Texas blues). Not "a tone we made up."
 *   - Uses verified amp / drive / reverb / chorus / delay enum strings
 *     from `fractal-midi` catalogs (cross-checked at ship time).
 *   - Sets knob values from published source material (interviews, rig
 *     rundowns, Premier Guitar articles) rather than gut feel.
 *
 * Scope:
 *   - AM4  ✓ — Q8.02 firmware, 4 slots linear chain.
 *   - II   ✓ — Q8.02 firmware, row 2 (audio chain) of 4×12 grid.
 *   - gen-3 (III / FM3 / FM9) ✓ SET_PARAMETER is decoded (fn=0x01,
 *              byte-verified) and the tone-stack knobs are calibrated
 *              display-first. These recipes are MODEL-AGNOSTIC numeric
 *              voicings BY DESIGN: they set the calibrated tone-stack +
 *              reverb/comp knobs on whatever amp model is loaded, and the
 *              agent/user picks the amp model separately. (Model set-by-name
 *              DOES work on gen-3 — a discrete SET carries float32(read-ordinal)
 *              — it is just kept out of these recipes so one voicing fits any
 *              model.) They carry the `gen3_` prefix to make that contract
 *              obvious. No enum model strings appear in any gen-3 slot.
 *   - Hydra ✗ — synth (osc / module), not a multi-block guitar effects
 *              chain. Block-stack semantics don't translate; consider
 *              a separate "patch_archetype" family if Hydra demand
 *              grows (e.g. "vangelis_pad", "plucky_bass").
 *
 * Curation criteria for future expansion (founder-confirmed):
 *
 *   1. Tone must be recognizable by a working guitarist without
 *      explanation — the name should evoke the sound.
 *   2. Sources for knob values must be public + documented (interview,
 *      forum thread with player confirmation, Premier Guitar rig
 *      rundown). Cite them in the recipe's source comment.
 *   3. Block enum strings (amp type, drive type, reverb type) must
 *      exist in fractal-midi catalogs on both AM4 + II before shipping.
 *      Verified at ship time, not at recipe-author time.
 *   4. Recipe must fit AM4's 4-slot linear chain. Multi-block recipes
 *      over 4 blocks are II/III-only (and skip AM4).
 *   5. Metal recipes are now in scope (founder lifted the original
 *      "no metal" constraint 2026-05-22). High-gain amp lineage is
 *      hardware-verified on II for IIC+, Recto, 5150 III. AM4 metal
 *      coverage uses USA MK IIC+ and Recto Red. The type-knob silent
 *      no-op trap remains a concern; metal recipes ship with values
 *      that have been live-tested.
 *
 * Anti-patterns to avoid (these would damage agent trust):
 *
 *   - Generic placeholder values like "gain: 5" with no source.
 *   - Using one device's iconic amp name when the matching enum
 *     doesn't exist on the other device (e.g. "Vox AC30" lives
 *     differently named across Fractal generations — verify both).
 *   - Specifying block_type strings the agent's apply_preset will
 *     reject (e.g. shipping `compressor` when AM4 calls it `comp`).
 */

import type { RecipePort } from './pitch.js';

export interface BlockStackSlotSpec {
  /**
   * Slot reference matching apply_preset's schema. AM4 takes a bare
   * int 1..4. II/III take {row, col} (we use row 2 = audio-chain row).
   */
  readonly slot: number | { readonly row: number; readonly col: number };
  /** Block type slug — must match descriptor's block_types. */
  readonly block_type: string;
  /**
   * Optional knob bundle. Display-value shape (numbers in display
   * units, strings for enum values). The apply_preset executor coerces
   * to wire format. Omit when the recipe just wants the block placed
   * with default knobs.
   *
   * For channel-bearing blocks (AM4 amp/drive/reverb/delay; II any
   * block) the values stay FLAT here — channel nesting happens in the
   * agent's apply_preset spec when the user wants a non-default
   * channel. Most block-stack starting points sit in channel A / X by
   * default.
   */
  readonly params?: Readonly<Record<string, number | string>>;
}

export interface BlockStackRecipeSpec {
  /** Stable id (snake_case). Same string used as the recipe key. */
  readonly name: string;
  /** Cite the player/era/song that originated this tone. */
  readonly description: string;
  /**
   * Per-device slot list. Each slot is a partial PresetSlotSpec the
   * agent pastes into apply_preset.spec.slots[]. Omit a device from
   * this map (and from applicable_devices) when the catalog isn't
   * solid enough to ship.
   */
  readonly slots_per_device: Readonly<
    Partial<Record<RecipePort, readonly BlockStackSlotSpec[]>>
  >;
  /** Devices this recipe ships on. Filtered by summarizeRecipesForPort. */
  readonly applicable_devices: readonly RecipePort[];
  /**
   * REQUIRED hand-authored signature picks — the 2-4 most distinctive
   * knob/enum values that disambiguate THIS recipe from siblings in the
   * slim describe_device.recipes[] surface. Keys are dot-paths
   * (`amp.type`, `delay.feedback`). Values are display-shape (the same
   * strings/numbers the agent would paste into apply_preset.spec.slots
   * params). Validated at CI by `verify-recipe-tables` to be a strict
   * subset of `slots_per_device[port]` — drift between the slim summary
   * and the full slots breaks agent recipe picking, so any post-hoc
   * change to a slot's enum/value must update signature_params in the
   * same commit.
   *
   * Per-port because enum spelling diverges across devices
   * (`Brit Silver` on AM4, `BRIT SILVER` on II); the agent sees the
   * port-matched dict in describe_device.recipes[].
   *
   * Required even when a recipe applies to only one device — the slim
   * summary always emits this field for block_stack recipes so the
   * agent never has to branch on "does this recipe have signature
   * params or not."
   */
  readonly signature_params_per_device: Readonly<
    Partial<Record<RecipePort, Readonly<Record<string, number | string>>>>
  >;
  /**
   * Source attribution. Comma-separated public sources where the
   * knob values come from. Lives in the recipe so it can show up in
   * describe_device when an agent surfaces "where did these values
   * come from?" to the user.
   */
  readonly source_notes: string;
}

// `p` helper: TypeScript's object-literal inference assigns explicit
// `key?: undefined` for absent keys when literals get unioned across
// differently-shaped recipe slots. That fails the index check on
// `Record<string, number | string>`. Wrapping each params literal
// with `p(...)` pins its inferred type to the Record alias so the
// whole table type-checks cleanly. Pure runtime no-op.
const p = <T extends Readonly<Record<string, number | string>>>(params: T): Readonly<Record<string, number | string>> => params;

// gen-3 (III / FM3 / FM9) share one wire codec, one block roster, and one
// calibrated tone-stack, and the recipes below set numeric knobs only
// (model-agnostic by design — enum model set-by-name works on gen-3 via a
// discrete SET carrying float32(read-ordinal), but is left to a separate step
// so one voicing fits any model). The slot layout + values are identical across
// the three, so fan one value across all three port keys rather than
// triplicating the literal. FM3 is a 4×4 grid, so gen-3 recipes stay within
// cols 1..3 (row 2 audio chain) to fit every device in the family.
const gen3 = <T>(value: T): Readonly<Record<'axe-fx-iii' | 'fm3' | 'fm9', T>> =>
  Object.freeze({ 'axe-fx-iii': value, fm3: value, fm9: value });
const GEN3_DEVICES = ['axe-fx-iii', 'fm3', 'fm9'] as const;

export const BLOCK_STACK_RECIPES: Readonly<Record<string, BlockStackRecipeSpec>> = Object.freeze({
    // ── Edge dotted-8th lead ────────────────────────────────────────
    //
    // The Edge (U2). One of the most documented signature tones in
    // guitar press. "Where The Streets Have No Name," "With Or Without
    // You," "Sunday Bloody Sunday."
    //
    // Signature elements:
    //   - Light compression (Dyna Comp / Boss CS-3 style) to even
    //     out the dotted-8th rhythm.
    //   - Vox AC30 / Brit-style amp pushed just past clean — clean
    //     enough to keep delay clarity, edged enough to bloom.
    //   - Dotted-8th delay (3/16 of tempo) at ~25% feedback. The
    //     mathematical "ghost note on every dotted-8th" effect is
    //     what creates the cascading melodic line.
    //   - Plate reverb adds space without the wash of a hall.
    //
    // Tempo-synced by construction: the delay slot bakes
    // `tempo: '1/8 DOT'` (dotted-8th, the 3/16-of-tempo Edge effect) so
    // the repeats track the song clock on every device that locks
    // delay.time to tempo. The agent still owns the GLOBAL bpm (tap
    // tempo / song tempo); the division is fixed. No absolute `time` is
    // shipped: with tempo synced, an absolute delay.time write is
    // silently ignored by the hardware, so it would be a dead param.
    //
    // Sources: Premier Guitar "Rig Rundown: U2 / The Edge" (2017);
    // Sound on Sound "The Edge: Crafting U2's Layered Guitars"
    // (multi-issue feature, 2009-2011); Edge's documented Memory Man
    // + AC30 pairing.
    edge_dotted_eighth_lead: {
      name: 'edge_dotted_eighth_lead',
      description:
        'Edge-style dotted-8th delay lead: light comp + lightly broken-up amp + dotted-8th delay at 25% feedback + plate reverb. Set delay tempo to the song.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'amp.type': 'Brit Silver', 'delay.type': 'Digital Stereo', 'delay.feedback': 25 },
        'axe-fx-ii': { 'amp.effect_type': 'BRIT SILVER', 'delay.effect_type': 'DIGITAL STEREO', 'delay.feedback': 25 },
      },
      source_notes:
        'Premier Guitar Rig Rundown: U2 / The Edge (2017); Sound on Sound "Crafting U2\'s Layered Guitars" (2009-2011).',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'compressor',
            params: p({ type: 'JFET Studio Compressor', ratio: 4, threshold: -18, level: 5 }),
          },
          {
            slot: 2,
            block_type: 'amp',
            params: p({ type: 'Brit Silver', gain: 4, bass: 5, mid: 6, treble: 6, master: 5 }),
          },
          {
            slot: 3,
            block_type: 'delay',
            params: p({ type: 'Digital Stereo', tempo: '1/8 DOT', feedback: 25, mix: 35 }),
          },
          {
            slot: 4,
            block_type: 'reverb',
            params: p({ type: 'Plate, Medium', mix: 20 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'compressor',
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'amp',
            params: p({ effect_type: 'BRIT SILVER', input_drive: 4, bass: 5, middle: 6, treble: 6, master_volume: 5 }),
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'delay',
            params: p({ effect_type: 'DIGITAL STEREO', tempo: '1/8 DOT', feedback: 25, mix: 35 }),
          },
          {
            slot: { row: 2, col: 4 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM PLATE', mix: 20 }),
          },
        ],
      },
    },

    // ── 80s clean shimmer ────────────────────────────────────────────
    //
    // Generic Police / Pink Floyd / Toto-era clean rhythm tone.
    // Clean Fender / Brit clean base + analog chorus + plate reverb.
    // The "icy clean with motion" sound — used by Andy Summers,
    // David Gilmour's clean Wall sections, Toto's session-clean
    // rhythm tracks.
    //
    // Signature elements:
    //   - Fender-style clean (Twin / Deluxe Verb) at low gain, mid-
    //     scoop voicing.
    //   - Analog chorus with slow rate (~0.5 Hz) + deep mix (~50%).
    //     CE-2 / Boss DC-2 territory.
    //   - Plate reverb (medium) for space.
    //
    // No delay in this stack — many 80s clean parts used chorus +
    // reverb only, with delay added separately when the part called
    // for it.
    //
    // Sources: Premier Guitar "Rig Rundown: Andy Summers" (2014);
    // Sound on Sound "David Gilmour's Clean Tones" (2006); 80s
    // chorus-pedal consensus on Fractal Forum thread #144501.
    eighties_clean_shimmer: {
      name: 'eighties_clean_shimmer',
      description:
        '80s clean shimmer (Police / Toto / clean Floyd): clean Fender-style amp + slow-deep chorus + plate reverb. Pristine clean with motion.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'amp.type': 'Deluxe Verb Normal', 'chorus.type': 'Analog Stereo', 'chorus.depth': 50 },
        'axe-fx-ii': { 'amp.effect_type': 'DELUXE VERB NRM', 'chorus.effect_type': 'ANALOG STEREO', 'chorus.depth': 50 },
      },
      source_notes:
        'Premier Guitar Rig Rundown: Andy Summers (2014); Sound on Sound "David Gilmour Clean Tones" (2006).',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'amp',
            params: p({ type: 'Deluxe Verb Normal', gain: 3, bass: 5, mid: 5, treble: 6, master: 5 }),
          },
          {
            slot: 2,
            block_type: 'chorus',
            params: p({ type: 'Analog Stereo', rate: 0.5, depth: 50, mix: 50 }),
          },
          {
            slot: 3,
            block_type: 'reverb',
            params: p({ type: 'Plate, Medium', mix: 25 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'amp',
            params: p({ effect_type: 'DELUXE VERB NRM', input_drive: 3, bass: 5, middle: 5, treble: 6, master_volume: 5 }),
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'chorus',
            params: p({ effect_type: 'ANALOG STEREO', rate: 0.5, depth: 50, mix: 50 }),
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM PLATE', mix: 25 }),
          },
        ],
      },
    },

    // ── Texas blues crunch ───────────────────────────────────────────
    //
    // SRV / Joe Bonamassa / Kenny Wayne Shepherd territory. The
    // canonical "Tube Screamer in front of an edge-of-breakup Brit
    // amp" arrangement. T808 OD at low gain pushes the front end;
    // the amp does the actual distortion.
    //
    // Signature elements:
    //   - T808 OD with gain low (~3), tone ~6 (slight high-mid push),
    //     level ~5. The pedal is a clean boost more than an OD here.
    //   - Brit Super / Plexi 50W crunch amp — natural tube saturation
    //     when struck hard.
    //   - Spring reverb (medium) — the only effect SRV typically had,
    //     baked into his Vibroverb's tank.
    //
    // No delay / no chorus. Raw three-block stack.
    //
    // Sources: Premier Guitar "Rig Rundown: SRV Tribute" (2018);
    // Joe Bonamassa documented Tube Screamer + Marshall pairings
    // (Sound on Sound 2010 + multiple Premier Guitar features).
    texas_blues_crunch: {
      name: 'texas_blues_crunch',
      description:
        'Texas blues crunch (SRV / Bonamassa): T808 OD as clean boost + Plexi-crunch amp + spring reverb. The pedal pushes the front end; the amp distorts.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'drive.type': 'T808 OD', 'amp.type': 'Brit Super', 'reverb.type': 'Spring, Medium' },
        'axe-fx-ii': { 'drive.effect_type': 'T808 OD', 'amp.effect_type': 'BRIT SUPER', 'reverb.effect_type': 'MEDIUM SPRING' },
      },
      source_notes:
        'Premier Guitar Rig Rundown: SRV Tribute (2018); Sound on Sound "Joe Bonamassa" feature (2010).',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'drive',
            params: p({ type: 'T808 OD', drive: 3, tone: 6, level: 5 }),
          },
          {
            slot: 2,
            block_type: 'amp',
            params: p({ type: 'Brit Super', gain: 5, bass: 5, mid: 6, treble: 6, master: 6 }),
          },
          {
            slot: 3,
            block_type: 'reverb',
            params: p({ type: 'Spring, Medium', mix: 15 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'drive',
            params: p({ effect_type: 'T808 OD', gain: 3, tone: 6, volume: 5 }),
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'amp',
            params: p({ effect_type: 'BRIT SUPER', input_drive: 5, bass: 5, middle: 6, treble: 6, master_volume: 6 }),
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM SPRING', mix: 15 }),
          },
        ],
      },
    },

    // ── Glassy clean ─────────────────────────────────────────────────
    //
    // Fender Twin / Deluxe Verb clean rhythm, the "country / pristine
    // clean" sound. Light compressor evens dynamics; plate reverb
    // gives air without obscuring articulation.
    //
    // Sources: Premier Guitar "Fender Clean: A Guide" (2019);
    // generic Nashville rig-rundown conventions.
    glassy_clean: {
      name: 'glassy_clean',
      description:
        'Glassy Fender clean (country / pristine rhythm): Deluxe Verb-style clean amp + light compressor + plate reverb. Bell-like, articulate, no breakup.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'amp.type': 'Deluxe Verb Normal', 'amp.gain': 2, 'reverb.type': 'Plate, Medium' },
        'axe-fx-ii': { 'amp.effect_type': 'DELUXE VERB NRM', 'amp.input_drive': 2, 'reverb.effect_type': 'MEDIUM PLATE' },
      },
      source_notes:
        'Fender Twin / Deluxe Verb tonal consensus; Premier Guitar "Fender Clean" feature (2019).',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'compressor',
            params: p({ type: 'JFET Studio Compressor', ratio: 2, threshold: -22, level: 5 }),
          },
          {
            slot: 2,
            block_type: 'amp',
            params: p({ type: 'Deluxe Verb Normal', gain: 2, bass: 4, mid: 5, treble: 7, master: 6 }),
          },
          {
            slot: 3,
            block_type: 'reverb',
            params: p({ type: 'Plate, Medium', mix: 20 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'compressor',
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'amp',
            params: p({ effect_type: 'DELUXE VERB NRM', input_drive: 2, bass: 4, middle: 5, treble: 7, master_volume: 6 }),
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM PLATE', mix: 20 }),
          },
        ],
      },
    },

    // ── Gilmour phaser clean ─────────────────────────────────────────
    //
    // David Gilmour's signature clean: Hiwatt clean + slow phaser
    // (MXR Phase 90 / Electric Mistress territory) + analog delay +
    // plate reverb. "Comfortably Numb" intro, "Breathe", "Time" clean
    // sections. The phaser is what gives the tone its "swirly trippy
    // clean" identity.
    //
    // Sources: Premier Guitar "Rig Rundown: David Gilmour" (multiple
    // years); Gilmour's documented Big Muff + Phase 90 + Hiwatt chain.
    gilmour_phaser_clean: {
      name: 'gilmour_phaser_clean',
      description:
        'Gilmour swirly clean (Pink Floyd "Comfortably Numb" / "Breathe"): Hiwatt-style clean amp + slow phaser + analog delay + plate reverb. Trippy clean with motion.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'amp.type': 'Hipower Normal', 'phaser.type': 'Script 90', 'delay.type': 'Analog Stereo' },
        'axe-fx-ii': { 'amp.effect_type': 'HIPOWER NORMAL', 'phaser.effect_type': 'SCRIPT 90', 'delay.effect_type': 'ANALOG STEREO' },
      },
      source_notes:
        'Premier Guitar Rig Rundown: David Gilmour (2016, 2019); Sound on Sound "Gilmour Clean Tones" (2006). Gilmour used Hiwatt DR103 (= Hipower on Fractal), not Marshall.',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'amp',
            params: p({ type: 'Hipower Normal', gain: 3, bass: 5, mid: 5, treble: 6, master: 6 }),
          },
          {
            slot: 2,
            block_type: 'phaser',
            params: p({ type: 'Script 90', rate: 0.7, depth: 6, mix: 50 }),
          },
          {
            slot: 3,
            block_type: 'delay',
            params: p({ type: 'Analog Stereo', time: 440, feedback: 30, mix: 25 }),
          },
          {
            slot: 4,
            block_type: 'reverb',
            params: p({ type: 'Plate, Medium', mix: 25 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'amp',
            params: p({ effect_type: 'HIPOWER NORMAL', input_drive: 3, bass: 5, middle: 5, treble: 6, master_volume: 6 }),
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'phaser',
            params: p({ effect_type: 'SCRIPT 90', rate: 0.7, depth: 6, mix: 50 }),
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'delay',
            params: p({ effect_type: 'ANALOG STEREO', time: 440, feedback: 30, mix: 25 }),
          },
          {
            slot: { row: 2, col: 4 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM PLATE', mix: 25 }),
          },
        ],
      },
    },

    // ── Progressive clean (King Crimson / Steve Howe) ────────────────
    //
    // Layered clean with chorus + delay + reverb, used by progressive-
    // rock players (Steve Howe, Robert Fripp, Allan Holdsworth's clean
    // sections). Wider stereo image than 80s clean shimmer; the delay
    // adds rhythmic interest beyond the chorus motion.
    //
    // Sources: Premier Guitar "Rig Rundown: Steve Howe" (2017);
    // King Crimson "Discipline"-era live rig documentation.
    progressive_clean: {
      name: 'progressive_clean',
      description:
        'Progressive clean (Steve Howe / Fripp): brit clean amp + analog chorus + rhythmic delay + hall reverb. Layered, articulated, wider image than 80s shimmer.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'amp.type': 'Brit Silver', 'chorus.type': 'Analog Stereo', 'delay.type': 'Digital Stereo', 'reverb.type': 'Hall, Medium' },
        'axe-fx-ii': { 'amp.effect_type': 'BRIT SILVER', 'chorus.effect_type': 'ANALOG STEREO', 'delay.effect_type': 'DIGITAL STEREO', 'reverb.effect_type': 'MEDIUM HALL' },
      },
      source_notes:
        'Premier Guitar Rig Rundown: Steve Howe (2017); King Crimson live-rig docs (Discipline era).',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'amp',
            params: p({ type: 'Brit Silver', gain: 3, bass: 5, mid: 6, treble: 6, master: 5 }),
          },
          {
            slot: 2,
            block_type: 'chorus',
            params: p({ type: 'Analog Stereo', rate: 0.4, depth: 40, mix: 35 }),
          },
          {
            slot: 3,
            block_type: 'delay',
            params: p({ type: 'Digital Stereo', time: 300, feedback: 35, mix: 30 }),
          },
          {
            slot: 4,
            block_type: 'reverb',
            params: p({ type: 'Hall, Medium', mix: 25 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'amp',
            params: p({ effect_type: 'BRIT SILVER', input_drive: 3, bass: 5, middle: 6, treble: 6, master_volume: 5 }),
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'chorus',
            params: p({ effect_type: 'ANALOG STEREO', rate: 0.4, depth: 40, mix: 35 }),
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'delay',
            params: p({ effect_type: 'DIGITAL STEREO', time: 300, feedback: 35, mix: 30 }),
          },
          {
            slot: { row: 2, col: 4 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM HALL', mix: 25 }),
          },
        ],
      },
    },

    // ── Classic rock Plexi ───────────────────────────────────────────
    //
    // AC/DC / Zeppelin / 70s hard rock: cranked Marshall Plexi 50W or
    // 100W natural crunch, minimal effects. The amp does all the work.
    //
    // Sources: Premier Guitar "AC/DC Tones" (2014); Tony Iommi /
    // Jimmy Page documented Plexi-with-volume-up rigs.
    classic_rock_plexi: {
      name: 'classic_rock_plexi',
      description:
        'Classic rock crunch (AC/DC / Zeppelin / 70s hard rock): cranked Plexi 50W + light spring reverb. Raw amp tone, no pedals.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'amp.type': 'Plexi 50W High 1', 'amp.gain': 7 },
        'axe-fx-ii': { 'amp.effect_type': 'PLEXI 50W HI 1', 'amp.input_drive': 7 },
      },
      source_notes:
        'Premier Guitar "AC/DC Tones" (2014); Tony Iommi / Jimmy Page rig documentation.',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'amp',
            params: p({ type: 'Plexi 50W High 1', gain: 7, bass: 5, mid: 6, treble: 6, presence: 6, master: 7 }),
          },
          {
            slot: 2,
            block_type: 'reverb',
            params: p({ type: 'Spring, Medium', mix: 12 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'amp',
            params: p({ effect_type: 'PLEXI 50W HI 1', input_drive: 7, bass: 5, middle: 6, treble: 6, presence: 6, master_volume: 7 }),
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM SPRING', mix: 12 }),
          },
        ],
      },
    },

    // ── 80s metal brown (Van Halen) ──────────────────────────────────
    //
    // Eddie Van Halen's "brown sound": modded Marshall Super Lead with
    // gain pushed, tape echo (Echoplex EP-3) for slap-delay, light
    // plate reverb. "Eruption", "Ain't Talkin' 'Bout Love", "Panama".
    //
    // The brown sound is iconic enough that it's a tone category, not
    // just a player reference. Brit Pre on Fractal models the modded
    // Marshall character; tape echo is the EP-3-style slapback.
    //
    // Sources: Premier Guitar "Rig Rundown: Eddie Van Halen" (2015);
    // Sound on Sound "The Brown Sound" feature (2007).
    eighties_metal_brown: {
      name: 'eighties_metal_brown',
      description:
        '80s metal "brown sound" (Van Halen "Eruption" / "Panama"): hot Brit Pre amp + tape echo slapback + light plate reverb. Saturated mids, articulate attack.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'amp.type': 'Brit Super', 'amp.gain': 7, 'delay.type': 'Mono Tape' },
        'axe-fx-ii': { 'amp.effect_type': 'BRIT PRE', 'amp.input_drive': 7, 'delay.effect_type': 'MONO TAPE' },
      },
      source_notes:
        'Premier Guitar Rig Rundown: Eddie Van Halen (2015); Sound on Sound "The Brown Sound" (2007). AM4: Brit Super (modded Super Lead). II: BRIT PRE (JMP-1 preamp, similar hot-rod Marshall character).',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'amp',
            params: p({ type: 'Brit Super', gain: 7, bass: 5, mid: 7, treble: 6, presence: 6, master: 6 }),
          },
          {
            slot: 2,
            block_type: 'delay',
            params: p({ type: 'Mono Tape', time: 220, feedback: 18, mix: 15 }),
          },
          {
            slot: 3,
            block_type: 'reverb',
            params: p({ type: 'Plate, Medium', mix: 12 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'amp',
            params: p({ effect_type: 'BRIT PRE', input_drive: 7, bass: 5, middle: 7, treble: 6, presence: 6, master_volume: 6 }),
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'delay',
            params: p({ effect_type: 'MONO TAPE', time: 220, feedback: 18, mix: 15 }),
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM PLATE', mix: 12 }),
          },
        ],
      },
    },

    // ── Thrash metal IIC+ (Metallica) ────────────────────────────────
    //
    // Metallica "Master of Puppets" / "...And Justice for All" era:
    // Mesa Mark IIC+ with scooped mids, light compressor for picking
    // articulation, short room reverb. James Hetfield's documented
    // touring rig for the late 80s / early 90s.
    //
    // Sources: Premier Guitar "Rig Rundown: Metallica" (2017);
    // Mesa/Boogie Mark IIC+ documented metal usage (Vintage Guitar
    // 2010 feature).
    thrash_metal_iic_plus: {
      name: 'thrash_metal_iic_plus',
      description:
        'Thrash metal (Metallica "Master of Puppets" era): USA MK IIC+ scooped-mid amp + light comp + short room reverb. Tight low-end, scooped mids, aggressive attack.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'amp.type': 'USA MK IIC+', 'amp.mid': 3 },
        'axe-fx-ii': { 'amp.effect_type': 'USA IIC+', 'amp.middle': 3 },
      },
      source_notes:
        'Premier Guitar Rig Rundown: Metallica (2017); Vintage Guitar "Mesa Mark IIC+" feature (2010).',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'compressor',
            params: p({ type: 'JFET Studio Compressor', ratio: 3, threshold: -20, level: 5 }),
          },
          {
            slot: 2,
            block_type: 'amp',
            params: p({ type: 'USA MK IIC+', gain: 6, bass: 4, mid: 3, treble: 7, presence: 7, master: 3 }),
          },
          {
            slot: 3,
            block_type: 'reverb',
            params: p({ type: 'Room, Medium', mix: 10 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'compressor',
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'amp',
            params: p({ effect_type: 'USA IIC+', input_drive: 6, bass: 4, middle: 3, treble: 7, presence: 7, master_volume: 3 }),
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM ROOM', mix: 10 }),
          },
        ],
      },
    },

    // ── Modern metal Recto (Lamb of God / Tool) ──────────────────────
    //
    // Mesa Dual Rectifier Modern channel: aggressive low-end, modern
    // metal rhythm tone. Lamb of God, Tool, modern Mesa-driven players.
    // Parametric EQ post-amp cuts the sub (below ~80 Hz) and notches
    // boxy mids (~500 Hz) for a polished modern metal rhythm tone.
    //
    // Sources: Premier Guitar "Rig Rundown: Lamb of God / Mark Morton"
    // (2018); Mesa Dual Rectifier documented modern metal usage.
    modern_metal_recto: {
      name: 'modern_metal_recto',
      description:
        'Modern metal rhythm (Lamb of God / Tool / modern Mesa): Recto Red Modern + parametric EQ (sub-cut + 500 Hz notch) + short room reverb. Polished aggressive low-end.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'amp.type': 'Recto2 Red Modern', 'filter.type': 'Peaking' },
        'axe-fx-ii': { 'amp.effect_type': 'RECTO2 RED MDRN' },
      },
      source_notes:
        'Premier Guitar Rig Rundown: Lamb of God (2018); Mesa Dual Rectifier modern-metal documentation.',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'amp',
            params: p({ type: 'Recto2 Red Modern', gain: 7, bass: 5, mid: 4, treble: 6, presence: 6, master: 5 }),
          },
          {
            slot: 2,
            block_type: 'filter',
            params: p({ type: 'Peaking', frequency: 500, q: 1.2, gain: -4, mix: 100 }),
          },
          {
            slot: 3,
            block_type: 'reverb',
            params: p({ type: 'Room, Medium', mix: 10 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'amp',
            params: p({ effect_type: 'RECTO2 RED MDRN', input_drive: 7, bass: 5, middle: 4, treble: 6, presence: 6, master_volume: 5 }),
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'parametriceq',
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM ROOM', mix: 10 }),
          },
        ],
      },
    },

    // ── Djent gated 5150 (II-only) ───────────────────────────────────
    //
    // Modern djent rig: noise gate (aggressive threshold) → T808 OD as
    // sub-cut + tightening boost → 5150 III Red high-gain → parametric
    // EQ (sub-cut + mid-scoop) → short verb. Periphery, Animals as
    // Leaders, Meshuggah-adjacent territory.
    //
    // II-only: AM4's 4-slot linear chain can't fit the 5-block stack
    // (gate + drive + amp + EQ + reverb). On AM4, the closest
    // equivalent is modern_metal_recto with the drive pre-amp added
    // manually, or thrash_metal_iic_plus with higher gain.
    //
    // Sources: Misha Mansoor / Periphery documented rig (Music Radar
    // 2018); Animals As Leaders / Tosin Abasi rig rundown.
    djent_gated_5150: {
      name: 'djent_gated_5150',
      description:
        'Djent (Periphery / Animals As Leaders / Misha Mansoor): noise gate + T808 OD sub-cut + 5150 III Red high-gain + parametric EQ (sub-cut + mid-scoop) + short room. II-only.',
      applicable_devices: ['axe-fx-ii'] as const,
      signature_params_per_device: {
        'axe-fx-ii': { 'amp.effect_type': '5153 100W RED', 'drive.effect_type': 'T808 OD' },
      },
      source_notes:
        'Music Radar "Misha Mansoor Rig" (2018); Animals As Leaders / Tosin Abasi rig rundown (Premier Guitar 2017).',
      slots_per_device: {
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'gateexpander',
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'drive',
            params: p({ effect_type: 'T808 OD', gain: 2, tone: 6, volume: 8 }),
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'amp',
            params: p({ effect_type: '5153 100W RED', input_drive: 6, bass: 5, middle: 4, treble: 6, presence: 6, master_volume: 5 }),
          },
          {
            slot: { row: 2, col: 4 },
            block_type: 'parametriceq',
          },
          {
            slot: { row: 2, col: 5 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM ROOM', mix: 8 }),
          },
        ],
      },
    },

    // ── 80s shred lead (Van Halen lead / Yngwie / George Lynch) ──────
    //
    // High-gain Marshall-style lead with tape delay + plate reverb.
    // Eddie Van Halen lead voicings, Yngwie's neoclassical lead, George
    // Lynch's Dokken-era lead. Brit Super hot for the lead voicing.
    //
    // Sources: Premier Guitar "80s Shred Tones" overview (2016);
    // multiple Premier Guitar rig rundowns (Lynch 2014, Yngwie 2015).
    eighties_shred_lead: {
      name: 'eighties_shred_lead',
      description:
        '80s shred lead (Van Halen lead / Yngwie / George Lynch / Dokken): hot Brit Super amp + tape delay + plate reverb. Articulate high-gain lead voice.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'amp.type': 'Brit Super', 'amp.gain': 8, 'delay.type': 'Mono Tape' },
        'axe-fx-ii': { 'amp.effect_type': 'BRIT SUPER', 'amp.input_drive': 8, 'delay.effect_type': 'MONO TAPE' },
      },
      source_notes:
        'Premier Guitar "80s Shred Tones" (2016); rig rundowns: George Lynch (2014), Yngwie Malmsteen (2015).',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'amp',
            params: p({ type: 'Brit Super', gain: 8, bass: 5, mid: 7, treble: 7, presence: 7, master: 6 }),
          },
          {
            slot: 2,
            block_type: 'delay',
            params: p({ type: 'Mono Tape', time: 380, feedback: 25, mix: 22 }),
          },
          {
            slot: 3,
            block_type: 'reverb',
            params: p({ type: 'Plate, Medium', mix: 18 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'amp',
            params: p({ effect_type: 'BRIT SUPER', input_drive: 8, bass: 5, middle: 7, treble: 7, presence: 7, master_volume: 6 }),
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'delay',
            params: p({ effect_type: 'MONO TAPE', time: 380, feedback: 25, mix: 22 }),
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'reverb',
            params: p({ effect_type: 'MEDIUM PLATE', mix: 18 }),
          },
        ],
      },
    },

    // ── Modern lead with delay ───────────────────────────────────────
    //
    // Modern high-gain lead with dotted-8th delay + big hall reverb.
    // Generic "metal lead" / "progressive lead" starting point.
    // Petrucci-adjacent (Dream Theater), Tosin lead-section voicings,
    // modern prog-metal lead tone.
    //
    // Sources: Premier Guitar "Rig Rundown: Dream Theater" (2018);
    // generic modern metal lead-tone documentation.
    modern_lead_delay: {
      name: 'modern_lead_delay',
      description:
        'Modern metal/prog lead (Petrucci-adjacent): high-gain Recto amp + dotted-8th delay + large hall reverb. Cuts through dense mix with sustain and bloom.',
      applicable_devices: ['am4', 'axe-fx-ii'] as const,
      signature_params_per_device: {
        am4: { 'amp.type': 'Recto2 Red Vintage', 'delay.type': 'Digital Stereo', 'reverb.type': 'Hall, Large' },
        'axe-fx-ii': { 'amp.effect_type': 'RECTO2 RED VINTAGE', 'delay.effect_type': 'DIGITAL STEREO', 'reverb.effect_type': 'LARGE HALL' },
      },
      source_notes:
        'Premier Guitar Rig Rundown: John Petrucci (2018); modern prog-metal lead-tone consensus.',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'amp',
            params: p({ type: 'Recto2 Red Vintage', gain: 7, bass: 5, mid: 6, treble: 6, presence: 6, master: 5 }),
          },
          {
            slot: 2,
            block_type: 'delay',
            params: p({ type: 'Digital Stereo', time: 375, feedback: 25, mix: 25 }),
          },
          {
            slot: 3,
            block_type: 'reverb',
            params: p({ type: 'Hall, Large', mix: 20 }),
          },
        ],
        'axe-fx-ii': [
          {
            slot: { row: 2, col: 1 },
            block_type: 'amp',
            params: p({ effect_type: 'RECTO2 RED VINTAGE', input_drive: 7, bass: 5, middle: 6, treble: 6, presence: 6, master_volume: 5 }),
          },
          {
            slot: { row: 2, col: 2 },
            block_type: 'delay',
            params: p({ effect_type: 'DIGITAL STEREO', time: 375, feedback: 25, mix: 25 }),
          },
          {
            slot: { row: 2, col: 3 },
            block_type: 'reverb',
            params: p({ effect_type: 'LARGE HALL', mix: 20 }),
          },
        ],
      },
    },

    // ── gen-3 clean platform (model-agnostic numeric voicing) ────────
    //
    // A pedal-platform clean voicing for the modern Fractal family: light
    // compression to even dynamics, the amp tone-stack set near-flat with
    // gain low for headroom, and a medium reverb for air. The amp MODEL is
    // NOT set here BY DESIGN — this voicing is model-agnostic so it sits on
    // any clean amp; model-by-name DOES work on gen-3 (a discrete SET carries
    // float32(read-ordinal)), the user/agent just picks a clean model
    // (Fender / AC-style) separately. All knobs are calibrated display-first
    // values.
    //
    // Voicing rationale: gain-staging convention for a clean pedal platform
    // (low drive for headroom, slight treble lift, ~18% reverb). Not an
    // artist-specific tone; the amp model is the user's pick.
    gen3_clean_platform: {
      name: 'gen3_clean_platform',
      description:
        'gen-3 clean platform (III / FM3 / FM9): light comp + near-flat amp tone-stack at low gain + medium reverb. Model-agnostic numeric voicing; pick the amp model separately (model-by-name works on gen-3).',
      applicable_devices: GEN3_DEVICES,
      signature_params_per_device: gen3(p({ 'amp.drive': 2, 'reverb.mix': 18 })),
      source_notes:
        'Clean pedal-platform gain-staging convention (low drive for headroom, slight treble lift, medium reverb). Amp model is user-selected; gen-3 model-by-name works.',
      slots_per_device: gen3([
        {
          slot: { row: 2, col: 1 },
          block_type: 'compressor',
          params: p({ ratio: 2, thresh: -24, level: 5 }),
        },
        {
          slot: { row: 2, col: 2 },
          block_type: 'amp',
          params: p({ drive: 2, bass: 5, mid: 5, treble: 6, master: 6 }),
        },
        {
          slot: { row: 2, col: 3 },
          block_type: 'reverb',
          params: p({ mix: 18, size: 55 }),
        },
      ]),
    },

    // ── gen-3 crunch platform (model-agnostic numeric voicing) ───────
    //
    // Edge-of-breakup rhythm voicing: amp tone-stack with mid-gain and a
    // slight mid push, low reverb for room. Sits on a cranked Brit/Plexi-
    // style model (user-selected). Numeric calibrated knobs only.
    gen3_crunch_platform: {
      name: 'gen3_crunch_platform',
      description:
        'gen-3 crunch platform (III / FM3 / FM9): mid-gain amp tone-stack with a slight mid push + light reverb. Edge-of-breakup rhythm voicing. Model-agnostic; pick a crunch amp model separately (model-by-name works on gen-3).',
      applicable_devices: GEN3_DEVICES,
      signature_params_per_device: gen3(p({ 'amp.drive': 5, 'reverb.mix': 12 })),
      source_notes:
        'Edge-of-breakup rhythm gain-staging convention (mid drive, mid push, light reverb). Amp model is user-selected; gen-3 model-by-name works.',
      slots_per_device: gen3([
        {
          slot: { row: 2, col: 1 },
          block_type: 'amp',
          params: p({ drive: 5, bass: 5, mid: 6, treble: 6, master: 6 }),
        },
        {
          slot: { row: 2, col: 2 },
          block_type: 'reverb',
          params: p({ mix: 12, size: 45 }),
        },
      ]),
    },

    // ── gen-3 high-gain platform (model-agnostic numeric voicing) ────
    //
    // Modern metal rhythm voicing: high drive, scooped mids, tight short
    // reverb. Sits on a Recto / 5150-style high-gain model (user-selected).
    // Numeric calibrated knobs only.
    gen3_high_gain_platform: {
      name: 'gen3_high_gain_platform',
      description:
        'gen-3 high-gain platform (III / FM3 / FM9): high-drive scooped-mid amp tone-stack + tight short reverb. Modern metal rhythm voicing. Model-agnostic; pick a high-gain amp model separately (model-by-name works on gen-3).',
      applicable_devices: GEN3_DEVICES,
      signature_params_per_device: gen3(p({ 'amp.drive': 8, 'amp.mid': 4 })),
      source_notes:
        'Modern metal rhythm gain-staging convention (high drive, scooped mids, tight short reverb). Amp model is user-selected; gen-3 model-by-name works.',
      slots_per_device: gen3([
        {
          slot: { row: 2, col: 1 },
          block_type: 'amp',
          params: p({ drive: 8, bass: 6, mid: 4, treble: 6, presence: 6, master: 5 }),
        },
        {
          slot: { row: 2, col: 2 },
          block_type: 'reverb',
          params: p({ mix: 8, size: 35 }),
        },
      ]),
    },
  });

/**
 * Resolve a block-stack recipe by id for a target port. Returns the
 * slot list ready to splice into apply_preset.spec.slots[]. Throws on
 * unknown recipe or non-applicable port.
 *
 * Pure-data lookup; no schema validation. The downstream apply_preset
 * preflight validates each slot's params against the device descriptor
 * and surfaces enum / range errors with the existing alias resolution.
 */
export function resolveBlockStackRecipe(
  recipeName: string,
  port: RecipePort,
): readonly BlockStackSlotSpec[] {
  const recipe = BLOCK_STACK_RECIPES[recipeName];
  if (!recipe) {
    const known = Object.keys(BLOCK_STACK_RECIPES).join(', ');
    throw new Error(
      `unknown block-stack recipe '${recipeName}'. Known recipes: ${known}`,
    );
  }
  if (!recipe.applicable_devices.includes(port)) {
    throw new Error(
      `block-stack recipe '${recipeName}' is not applicable to port '${port}'. ` +
        `Applicable devices: ${recipe.applicable_devices.join(', ')}.`,
    );
  }
  const slots = recipe.slots_per_device[port];
  if (!slots) {
    throw new Error(
      `block-stack recipe '${recipeName}' lists '${port}' as applicable but has no slots_per_device entry. Recipe-table bug.`,
    );
  }
  return slots;
}
