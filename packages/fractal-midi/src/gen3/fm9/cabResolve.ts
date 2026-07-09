/**
 * FM9 cab name resolution: factory cab/IR NAME → (bank ordinal, within-bank
 * TYPE ordinal).
 *
 * Why this is a resolver and NOT a flat enum table on CABINET_TYPEn: the cab
 * TYPE ordinal space is BANK-CONDITIONED — the same CABINET_TYPE1 ordinal
 * names a different IR depending on the paired CABINET_BANK1 value (banks:
 * 0=FACTORY 1, 1=FACTORY 2, 2=USER, 3=LEGACY, 4=SCRATCHPAD). Registering one
 * flat ordinal→name table would mislabel reads and mis-set writes for every
 * bank but the one it was copied from, so cab-by-name is a TWO-param
 * operation: resolve the name here, then set BOTH `CABINET_BANKn` (the bank
 * ordinal; its 5-name vocabulary IS wired into FM9_ENUM_OVERRIDES —
 * unconditional) and `CABINET_TYPEn` (the within-bank ordinal, discrete
 * float32(ordinal) like every gen-3 selector).
 *
 * Source tables: `cabRosters.generated.ts` (FM9-Edit cache, cross-validated
 * across six firmware walks; USER/SCRATCHPAD banks excluded by design).
 * Community-beta, index-0 caveat: no hardware anchor yet pins name[0] ↔
 * within-bank ordinal 0; the LEGACY table's length is anchored to the III
 * hardware roundtrip's CABINET_TYPE1 quantization max (188).
 */
import { FM9_CAB_ROSTERS_BY_BANK, FM9_CAB_BANK_NAMES } from './cabRosters.generated.js';

/** One (bank, type-ordinal) location a cab name resolves to. */
export interface Fm9CabMatch {
  /** CABINET_BANKn ordinal (0=FACTORY 1, 1=FACTORY 2, 3=LEGACY). */
  readonly bank: number;
  /** The bank's display name ("FACTORY 1" / "FACTORY 2" / "LEGACY"). */
  readonly bankName: string;
  /** Within-bank CABINET_TYPEn ordinal (the discrete-SET value). */
  readonly type: number;
  /** The roster's exact display name at that location. */
  readonly name: string;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Lazy-built reverse index: normalized name → matches (a name could in
// principle appear in more than one bank; every location is returned).
let index: Map<string, Fm9CabMatch[]> | undefined;

function buildIndex(): Map<string, Fm9CabMatch[]> {
  const idx = new Map<string, Fm9CabMatch[]>();
  for (const [bankStr, roster] of Object.entries(FM9_CAB_ROSTERS_BY_BANK)) {
    const bank = Number(bankStr);
    const bankName = FM9_CAB_BANK_NAMES[bank] ?? String(bank);
    for (const [ordStr, name] of Object.entries(roster)) {
      const match: Fm9CabMatch = { bank, bankName, type: Number(ordStr), name };
      const key = normalize(name);
      const list = idx.get(key);
      if (list === undefined) idx.set(key, [match]);
      else list.push(match);
    }
  }
  return idx;
}

/**
 * Resolve a factory cab/IR display name to its (bank, TYPE ordinal)
 * locations. Case- and whitespace-insensitive exact match; returns EVERY
 * bank the name appears in (empty array = not a factory cab name — it may
 * still be a USER-bank IR, which this data deliberately does not cover).
 */
export function resolveFm9CabName(name: string): readonly Fm9CabMatch[] {
  if (index === undefined) index = buildIndex();
  return index.get(normalize(name)) ?? [];
}
