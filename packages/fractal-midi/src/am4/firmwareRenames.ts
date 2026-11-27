/**
 * AM4 effect-type names that a firmware release RENAMED in place: the wire
 * ordinal kept its meaning, only the display string changed. Keyed
 * `block.param`, old name -> current name.
 *
 * Evidence (both must hold for a row):
 *   1. The AM4-Edit metadata cache for the new firmware (effectDefinitions_15_2p2.cache,
 *      fw 2.02) has the new string at the SAME ordinal the old cache
 *      (effectDefinitions_15_2p0.cache, fw 2.00) had the old one; nothing before or
 *      after moved (new types were appended at the end).
 *   2. Fractal's firmware 2.01 release notes call it a rename
 *      (forum.fractalaudio.com/threads/am4-v2-01-release.220982/): "Deluxe Tweed"
 *      became "Deluxe Tweed Bright"; "Vibrato 1" became "Vibrato" and "Vibrato 2"
 *      became "Japan CE-1 Vibrato". "80s Style" -> "80'S Style" is a spelling change
 *      at the same ordinal.
 *
 * The table lets a user, a recipe, or a preset written against the old names
 * keep resolving. The codec's enum rosters carry the CURRENT names only.
 */
export const AM4_FIRMWARE_RENAMED_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  'amp.type': Object.freeze({
    'Deluxe Tweed': 'Deluxe Tweed Bright',
  }),
  'chorus.type': Object.freeze({
    '80s Style': "80'S Style",
    'Vibrato 1': 'Vibrato',
    'Vibrato 2': 'Japan CE-1 Vibrato',
  }),
});

/** The current name for a renamed AM4 type, or undefined when `name` was never renamed. Case-insensitive. */
export function am4RenamedTypeName(block: string, param: string, name: string): string | undefined {
  const table = AM4_FIRMWARE_RENAMED_TYPES[`${block}.${param}`];
  if (table === undefined) return undefined;
  const want = name.trim().toLowerCase();
  for (const [oldName, current] of Object.entries(table)) {
    if (oldName.toLowerCase() === want) return current;
  }
  return undefined;
}
