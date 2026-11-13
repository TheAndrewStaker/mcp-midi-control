/**
 * Offline check for GitHub #33: where the AM4-shared effect-type overlay and
 * the shared gen-3 read roster both name an ordinal, do they agree? A
 * disagreement means set-by-name (overlay wins on the III) and the read path
 * (roster) name different models for one ordinal. No device needed.
 */
import { GEN3_READ_ROSTERS, resolveEnumValues } from 'fractal-midi/gen3/axe-fx-iii';

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const rosters = GEN3_READ_ROSTERS as Record<string, Record<number, string>>;
for (const [sym, roster] of Object.entries(rosters)) {
  const overlay = resolveEnumValues(sym)?.values as Record<number, string> | undefined;
  if (overlay === undefined) {
    console.log(`${sym}: no overlay (roster only, ${Object.keys(roster).length})`);
    continue;
  }
  let same = 0;
  let spelling = 0;
  const hard: string[] = [];
  const onlyOverlay: number[] = [];
  for (const [k, name] of Object.entries(overlay)) {
    const r = roster[Number(k)];
    if (r === undefined) onlyOverlay.push(Number(k));
    else if (r === name) same++;
    else if (norm(r) === norm(name)) spelling++;
    else hard.push(`${k}: overlay "${name}" vs roster "${r}"`);
  }
  console.log(
    `${sym}: overlay ${Object.keys(overlay).length} / roster ${Object.keys(roster).length}; ` +
      `same ${same}, spelling-only ${spelling}, DISAGREE ${hard.length}, overlay-only ordinals ${onlyOverlay.length}`,
  );
  for (const h of hard.slice(0, 6)) console.log(`    ${h}`);
  if (hard.length > 6) console.log(`    ... ${hard.length - 6} more`);
}
