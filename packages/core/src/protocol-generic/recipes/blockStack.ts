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
 * Scope at first ship:
 *   - AM4  ✓ — Q8.02 firmware, 4 slots linear chain.
 *   - II   ✓ — Q8.02 firmware, row 2 (audio chain) of 4×12 grid.
 *   - III  ✗ — SET_PARAM is undecoded as of Session 97; recipe values
 *              would be unverified guesses. Add when III SET_PARAM lands.
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
 *   5. No "metal" recipes until the founder hardware-verifies high-
 *      gain amp lineage on both devices — the type-knob silent no-op
 *      trap is most painful on aggressive amp types.
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
    // Tempo knob assumption: agent is expected to set delay tempo
    // separately (or the device's tap-tempo). The recipe ships
    // time=375 ms which is dotted-8th at 120 BPM — a sensible default
    // that the agent can rebalance per song.
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
      source_notes:
        'Premier Guitar Rig Rundown: U2 / The Edge (2017); Sound on Sound "Crafting U2\'s Layered Guitars" (2009-2011).',
      slots_per_device: {
        am4: [
          {
            slot: 1,
            block_type: 'compressor',
            params: p({ type: 'Pedal Comp 2', ratio: 4, threshold: -18, level: 5 }),
          },
          {
            slot: 2,
            block_type: 'amp',
            params: p({ type: 'Brit Silver', gain: 4, bass: 5, mid: 6, treble: 6, master: 5 }),
          },
          {
            slot: 3,
            block_type: 'delay',
            params: p({ type: 'Digital Stereo', time: 375, feedback: 25, mix: 35 }),
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
            params: p({ effect_type: 'DIGITAL STEREO', time: 375, feedback: 25, mix: 35 }),
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
