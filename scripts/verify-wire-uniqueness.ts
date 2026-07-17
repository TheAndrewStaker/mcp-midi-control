/**
 * BK-106 gate: no two catalog entries on the SAME DEVICE may register the
 * same wire address under different keys.
 *
 * Why this exists: the AM4 shipped for some time with TWO registrations of
 * pidHigh 0x41-0x44 — a guessed, wrongly-ordered `amp.dynacab_type_*` quad
 * AND the hardware-anchored `amp.dynacab_*_cab` entries — and every gate
 * stayed green (verify-cache-params checks duplicate KEYS only; a JS object
 * can't even hold a duplicate key). A set-by-name via the stale quad placed
 * the WRONG CAB on the device. Two names for one register means at least one
 * of them is wrong or stale; deliberate synonyms belong in PARAM_ALIASES,
 * never as a second registration.
 *
 * Wire-identity per catalog (what "same address" means):
 *   AM4                (pidLow, pidHigh)   — pidLow = block/slot, pidHigh = register
 *   Axe-Fx II          (block, paramId)    — paramId is per-effect; block slug
 *                                            stands in for the effect id (no two
 *                                            slugs share an effect id today)
 *   gen-3 III/FM3/FM9/VP4 (family, paramId) — per device; paramIds >= 0xFFF0 are
 *                                            firmware-internal sentinels, NOT
 *                                            wire-addressable (see gen3/types.ts),
 *                                            excluded from the scan
 *   gen-1              (block, paramId)    — blockId resolves from the slug
 *
 * Same-key overrides (AM4's KNOWN_PARAMS spread: cache -> ghosts -> hand
 * entries) are invisible here by construction — the merged object is what the
 * runtime resolves against, and that is exactly what we scan.
 *
 *   npx tsx scripts/verify-wire-uniqueness.ts
 */
import { KNOWN_PARAMS as AM4_PARAMS } from 'fractal-midi/am4';
import { KNOWN_PARAMS as II_PARAMS } from 'fractal-midi/gen2/axe-fx-ii';
import { PARAMS as III_PARAMS } from 'fractal-midi/gen3/axe-fx-iii';
import { FM3_PARAMS } from 'fractal-midi/gen3/fm3';
import { FM9_PARAMS } from 'fractal-midi/gen3/fm9';
import { VP4_PARAMS } from 'fractal-midi/gen3/vp4';
import { KNOWN_PARAMS as GEN1_PARAMS } from 'fractal-midi/gen1';

/** Gen-3 sentinel floor: paramIds at/above this are firmware-internal. */
const GEN3_SENTINEL_FLOOR = 0xfff0;

/**
 * Known-legitimate shared wire addresses. Key = `<device>|<wireKey>`; value =
 * the reason it is allowed. Add entries ONLY with an evidence citation — a
 * bare "the scan flagged it" is not a reason.
 */
const ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({});

/**
 * Gen-3 firmware-legacy overlays are documented-intentional duplicates:
 * "(family, paramId) is NOT unique. Some families (notably FLANGER) keep
 * older symbol names alongside the current ones at the same paramIds …
 * older firmware presets store under the `_OLD_` symbols, while new writes
 * use the current names. The composite key `(family, name)` IS unique."
 * — src/gen3/axe-fx-iii/params.ts file header ("Firmware-legacy overlays").
 * FM3's generated catalog spells the marker as an `OLD_` prefix instead.
 *
 * An address passes ONLY as exactly one current + one OLD-marked name; any
 * other shape (two current names, two OLD names, 3+ names) still fails.
 */
function gen3LegacyOverlayRule(names: string[]): string | undefined {
  if (names.length !== 2) return undefined;
  const old = names.filter((n) => /(^|[._])OLD_/.test(n));
  if (old.length !== 1) return undefined;
  return `firmware-legacy overlay (${old[0]} is the old-firmware symbol; see the III params.ts header)`;
}

interface Collision {
  wireKey: string;
  names: string[];
  allowed?: string;
}

function scan(
  device: string,
  entries: Iterable<[name: string, wireKey: string | undefined]>,
  allowRule?: (names: string[]) => string | undefined,
): { total: number; skipped: number; collisions: Collision[] } {
  const byAddress = new Map<string, string[]>();
  let total = 0;
  let skipped = 0;
  for (const [name, wireKey] of entries) {
    total++;
    if (wireKey === undefined) {
      skipped++;
      continue;
    }
    const names = byAddress.get(wireKey);
    if (names) names.push(name);
    else byAddress.set(wireKey, [name]);
  }
  const collisions: Collision[] = [];
  for (const [wireKey, names] of byAddress) {
    if (names.length < 2) continue;
    const allowed = ALLOWLIST[`${device}|${wireKey}`] ?? allowRule?.(names);
    collisions.push({ wireKey, names, allowed });
  }
  collisions.sort((a, b) => a.wireKey.localeCompare(b.wireKey));
  return { total, skipped, collisions };
}

const hex = (n: number) => `0x${n.toString(16).padStart(2, '0')}`;

function* am4Entries(): Iterable<[string, string | undefined]> {
  for (const [key, p] of Object.entries(AM4_PARAMS) as [string, { pidLow: number; pidHigh: number }][]) {
    yield [key, `pid ${hex(p.pidLow)}:${hex(p.pidHigh)}`];
  }
}

function* blockParamEntries(
  table: Record<string, { block?: string; paramId?: number }>,
): Iterable<[string, string | undefined]> {
  for (const [key, p] of Object.entries(table)) {
    yield [
      key,
      p.block !== undefined && typeof p.paramId === 'number' ? `${p.block}:${p.paramId}` : undefined,
    ];
  }
}

function* gen3Entries(
  params: readonly { family: string; paramId: number; name: string }[],
): Iterable<[string, string | undefined]> {
  for (const p of params) {
    yield [
      `${p.family}.${p.name}`,
      p.paramId >= GEN3_SENTINEL_FLOOR ? undefined : `${p.family}:${p.paramId}`,
    ];
  }
}

type AllowRule = ((names: string[]) => string | undefined) | undefined;
const devices: [device: string, entries: Iterable<[string, string | undefined]>, skipLabel: string, allowRule: AllowRule][] = [
  ['am4', am4Entries(), 'no wire address', undefined],
  ['axe-fx-ii', blockParamEntries(II_PARAMS as never), 'no wire address', undefined],
  ['axe-fx-iii', gen3Entries(III_PARAMS), 'sentinel paramIds', gen3LegacyOverlayRule],
  ['fm3', gen3Entries(FM3_PARAMS), 'sentinel paramIds', gen3LegacyOverlayRule],
  ['fm9', gen3Entries(FM9_PARAMS), 'sentinel paramIds', gen3LegacyOverlayRule],
  ['vp4', gen3Entries(VP4_PARAMS), 'sentinel paramIds', gen3LegacyOverlayRule],
  ['gen1', blockParamEntries(GEN1_PARAMS as never), 'no wire address', undefined],
];

let failed = false;
for (const [device, entries, skipLabel, allowRule] of devices) {
  const { total, skipped, collisions } = scan(device, entries, allowRule);
  const blocked = collisions.filter((c) => !c.allowed);
  const allowed = collisions.length - blocked.length;
  const skipNote = skipped > 0 ? `, ${skipped} skipped (${skipLabel})` : '';
  const allowNote = allowed > 0 ? `, ${allowed} allowlisted` : '';
  if (blocked.length === 0) {
    console.log(`✓ ${device}: ${total} entries, 0 duplicate wire addresses${allowNote}${skipNote}`);
    continue;
  }
  failed = true;
  console.error(`❌ ${device}: ${blocked.length} wire addresses registered more than once${skipNote}:`);
  for (const c of blocked) {
    console.error(`  - ${c.wireKey}: ${c.names.join(' + ')}`);
  }
}

if (failed) {
  console.error(
    '\nTwo names for one register means at least one is wrong or stale (the ' +
      'shipped dynacab_type_* bug class). Fix the stale entry (synonyms go in ' +
      'PARAM_ALIASES), or — only with cited evidence that both registrations ' +
      'are correct — add the address to ALLOWLIST with the reason.',
  );
  process.exit(1);
}
console.log('All device catalogs register each wire address at most once.');
