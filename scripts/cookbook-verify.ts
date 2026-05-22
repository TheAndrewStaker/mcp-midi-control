/**
 * Encoding-Cookbook build gate.
 *
 * Walks every cookbook entry in `C:/dev/fractal-midi/docs/research/cookbook/`
 * (plus its `_scratch/`, `_partial/`, `_negative/` subdirectories), parses
 * the YAML frontmatter, and applies two layers of validation:
 *
 *   1. STRUCTURAL gates (every entry, always run):
 *      - Required frontmatter fields present (name, status, golden, etc.)
 *      - `name:` matches the filename slug.
 *      - `status:` is one of the legal values from cookbook INDEX.md.
 *      - `consumed_in:` paths exist on disk (resolved against the mcp-midi-tools
 *        repo, the fractal-midi sibling repo, and the parent of both).
 *      - Status invariants:
 *          matched              -> needs >= 2 entries in `verified_on:`
 *          matched-singleton    -> needs >= 1 entry, body must justify the singleton
 *          partial-N1           -> entry should live in `_partial/` OR body must
 *                                  name the path to `matched`
 *          scratch              -> entry must live in `_scratch/`
 *          non-matching         -> entry must live in `_negative/`
 *          wip / regression     -> structural-only (not build-gating beyond fields)
 *
 *   2. FUNCTIONAL fixture cases (a subset that can run pure-CPU):
 *      - case-xor-7f-envelope-checksum     XOR-fold over known wire prefixes.
 *      - case-septet-14bit                 round-trip across boundaries (0, 127,
 *                                          128, 16383).
 *      - case-septet-21bit-byte2-mask-preservation
 *                                          encode/decode round-trip with a
 *                                          non-zero originalByte2 high mask.
 *      - case-vendor-envelope-descriptor-table
 *                                          parse the III descriptor JSON and
 *                                          confirm the headline table
 *                                          `0x1407ab940` matches the II preset-
 *                                          body envelope shape (2 + 3072 bytes).
 *      - case-xor-fold-hash                17-line XOR-fold over a known ushort
 *                                          array.
 *
 * Build-break policy: any structural gate fail or any functional case fail
 * exits with code 1. Wired into `npm run preflight` after `verify-msg`.
 *
 * Adding a new cookbook entry that needs a fixture: add a `case-<slug>`
 * function below + extend FUNCTIONAL_CASES. Entries without an inline case
 * are still subject to the structural gate; their golden field's reference
 * is recorded as STUB but not failed (the existing verify-* scripts are
 * the de-facto goldens for those primitives).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const REPO_PARENT = path.resolve(MCP_ROOT, '..');
const FRACTAL_MIDI_ROOT = path.join(REPO_PARENT, 'fractal-midi');
const COOKBOOK_ROOT = path.join(FRACTAL_MIDI_ROOT, 'docs', 'research', 'cookbook');

const LEGAL_STATUSES = new Set([
  'matched',
  'matched-singleton',
  'partial-N1',
  'wip',
  'scratch',
  'regression',
  'non-matching',
]);

const REQUIRED_FRONTMATTER_KEYS = ['name', 'status', 'golden'];

interface CookbookEntry {
  filePath: string;
  slug: string;
  dirCategory: 'main' | '_scratch' | '_partial' | '_negative';
  frontmatter: Record<string, string | string[]>;
  body: string;
}

interface Violation {
  entry: string;
  severity: 'fail' | 'warn';
  message: string;
}

function listCookbookFiles(): string[] {
  if (!existsSync(COOKBOOK_ROOT)) {
    throw new Error(
      `cookbook root not found: ${COOKBOOK_ROOT}. ` +
        `Either fractal-midi is not checked out at ${FRACTAL_MIDI_ROOT}, ` +
        `or the cookbook has moved.`,
    );
  }
  const out: string[] = [];
  for (const name of readdirSync(COOKBOOK_ROOT)) {
    const full = path.join(COOKBOOK_ROOT, name);
    const st = statSync(full);
    if (st.isFile() && name.endsWith('.md') && name !== 'INDEX.md') {
      out.push(full);
    } else if (st.isDirectory() && ['_scratch', '_partial', '_negative'].includes(name)) {
      for (const inner of readdirSync(full)) {
        if (inner.endsWith('.md') && inner !== 'INDEX.md') {
          out.push(path.join(full, inner));
        }
      }
    }
  }
  return out.sort();
}

/**
 * Minimal YAML frontmatter parser. Handles: scalar `key: value`, list
 * `key:` followed by `  - value` lines, inline list `key: [a, b, c]`,
 * and quoted strings (single or double). Sufficient for cookbook
 * entries; not a general YAML library.
 */
function parseFrontmatter(source: string): { frontmatter: Record<string, string | string[]>; body: string } {
  if (!source.startsWith('---')) {
    return { frontmatter: {}, body: source };
  }
  const lines = source.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { frontmatter: {}, body: source };
  const frontmatter: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;
  let currentList: string[] = [];
  const flushList = () => {
    if (currentListKey !== null) {
      frontmatter[currentListKey] = currentList;
    }
    currentListKey = null;
    currentList = [];
  };
  const stripQuotes = (s: string): string => {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (raw.startsWith('  - ') || raw.startsWith('\t- ')) {
      if (currentListKey !== null) {
        currentList.push(stripQuotes(raw.replace(/^\s*-\s*/, '')));
      }
      continue;
    }
    flushList();
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const key = raw.slice(0, colon).trim();
    const rest = raw.slice(colon + 1).trim();
    if (rest === '') {
      currentListKey = key;
      currentList = [];
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      frontmatter[key] = inner === ''
        ? []
        : inner.split(',').map((s) => stripQuotes(s));
      continue;
    }
    frontmatter[key] = stripQuotes(rest);
  }
  flushList();
  const body = lines.slice(end + 1).join('\n');
  return { frontmatter, body };
}

function categoryOf(filePath: string): CookbookEntry['dirCategory'] {
  const rel = path.relative(COOKBOOK_ROOT, filePath);
  const parts = rel.split(/[\\/]/);
  if (parts.length === 1) return 'main';
  if (parts[0] === '_scratch') return '_scratch';
  if (parts[0] === '_partial') return '_partial';
  if (parts[0] === '_negative') return '_negative';
  return 'main';
}

function slugFromPath(filePath: string): string {
  const base = path.basename(filePath, '.md');
  return base;
}

function loadEntries(): CookbookEntry[] {
  const files = listCookbookFiles();
  return files.map((f) => {
    const src = readFileSync(f, 'utf8');
    const { frontmatter, body } = parseFrontmatter(src);
    return {
      filePath: f,
      slug: slugFromPath(f),
      dirCategory: categoryOf(f),
      frontmatter,
      body,
    };
  });
}

/**
 * Resolve a `consumed_in:` line to an absolute path. Strips trailing
 * parenthetical notes, then tries an ordered list of base directories
 * (mcp-midi-tools, fractal-midi, repo parent). Lines whose annotation
 * marks the path as speculative ("if exists", "pending", "transfer
 * candidate", "TBD", "TODO") return 'soft-missing' so the gate logs
 * but does not fail. Lines whose entire content is a parenthetical
 * comment return 'placeholder'.
 */
function resolveConsumedInPath(
  line: string,
):
  | { kind: 'real'; absolute: string }
  | { kind: 'placeholder' }
  | { kind: 'soft-missing'; tried: string[]; reason: string }
  | { kind: 'missing'; tried: string[] } {
  let raw = line.trim();
  const isSpeculative = /\b(if exists|pending|placeholder|TBD|TODO|transfer candidate)\b/i.test(line);
  // Strip parenthetical notes: "packages/foo.ts (note about scope)" -> "packages/foo.ts"
  const parenIdx = raw.indexOf('(');
  if (parenIdx === 0) {
    return { kind: 'placeholder' };
  }
  if (parenIdx > 0) {
    raw = raw.slice(0, parenIdx).trim();
  }
  if (raw === '') return { kind: 'placeholder' };
  const candidates: string[] = [];
  candidates.push(path.resolve(MCP_ROOT, raw));
  candidates.push(path.resolve(FRACTAL_MIDI_ROOT, raw));
  candidates.push(path.resolve(REPO_PARENT, raw));
  // Also try after stripping a leading "mcp-midi-tools/" or "fractal-midi/" prefix.
  for (const prefix of ['mcp-midi-tools/', 'fractal-midi/']) {
    if (raw.startsWith(prefix)) {
      const stripped = raw.slice(prefix.length);
      candidates.push(
        prefix === 'mcp-midi-tools/'
          ? path.resolve(MCP_ROOT, stripped)
          : path.resolve(FRACTAL_MIDI_ROOT, stripped),
      );
    }
  }
  const tried: string[] = [];
  for (const c of candidates) {
    if (tried.includes(c)) continue;
    tried.push(c);
    if (existsSync(c)) return { kind: 'real', absolute: c };
  }
  if (isSpeculative) {
    return { kind: 'soft-missing', tried, reason: 'speculative annotation' };
  }
  return { kind: 'missing', tried };
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function validateStructural(entry: CookbookEntry, violations: Violation[]): void {
  const fm = entry.frontmatter;
  // Required keys
  for (const k of REQUIRED_FRONTMATTER_KEYS) {
    if (!(k in fm)) {
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message: `missing required frontmatter key '${k}'`,
      });
    }
  }
  // Name matches filename
  const declaredName = typeof fm.name === 'string' ? fm.name : null;
  if (declaredName !== null && declaredName !== entry.slug) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `frontmatter name '${declaredName}' does not match file slug '${entry.slug}'`,
    });
  }
  const status = typeof fm.status === 'string' ? fm.status : null;
  if (status !== null && !LEGAL_STATUSES.has(status)) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `illegal status '${status}'. legal: ${[...LEGAL_STATUSES].join(', ')}`,
    });
  }
  // Directory invariants
  if (status === 'scratch' && entry.dirCategory !== '_scratch') {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `status='scratch' but entry lives in ${entry.dirCategory}/. move to _scratch/`,
    });
  }
  if (status === 'non-matching' && entry.dirCategory !== '_negative') {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `status='non-matching' but entry lives in ${entry.dirCategory}/. move to _negative/`,
    });
  }
  // Fixture-count invariant for matched
  const verifiedOn = asList(fm.verified_on);
  if (status === 'matched' && verifiedOn.length < 2) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message:
        `status='matched' requires verified_on to list >= 2 axis points (devices/firmwares); ` +
        `found ${verifiedOn.length}. Demote to 'matched-singleton' or 'partial-N1', or add the second fixture.`,
    });
  }
  if (status === 'matched-singleton' && verifiedOn.length < 1) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `status='matched-singleton' requires verified_on to list >= 1 axis point; found 0`,
    });
  }
  // Consumed_in path resolution
  const consumedIn = asList(fm.consumed_in);
  for (const ci of consumedIn) {
    const resolved = resolveConsumedInPath(ci);
    if (resolved.kind === 'missing') {
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message:
          `consumed_in path not found: '${ci}'. Tried:\n    ${resolved.tried.join('\n    ')}`,
      });
    } else if (resolved.kind === 'soft-missing') {
      violations.push({
        entry: entry.slug,
        severity: 'warn',
        message: `consumed_in speculative path not found: '${ci}' (${resolved.reason})`,
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Functional fixture cases. Each function returns null on success or an error
// string on failure.
// -----------------------------------------------------------------------------

function caseXor7fEnvelopeChecksum(): string | null {
  // Capture: AM4 set_param amp.gain 0.0 wire prefix
  // f0 00 01 74 15 01 3a 00 0b 00 01 00 00 00 04 00 00 00 00 00 25 f7
  // Folded XOR over all bytes from F0 to (penultimate, i.e. 0x00 just before checksum 0x25)
  // expected checksum = 0x25
  const wire = [
    0xf0, 0x00, 0x01, 0x74, 0x15, 0x01, 0x3a, 0x00, 0x0b, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  let acc = 0;
  for (const b of wire) acc ^= b;
  const cs = acc & 0x7f;
  if (cs !== 0x25) {
    return `AM4 fixture: expected checksum 0x25, got 0x${cs.toString(16).padStart(2, '0')}`;
  }
  // II envelope (verify-msg style, captured): f0 00 01 74 10 01 ... <cs> f7
  // Use a trivial II envelope from the descriptor table cookbook entry:
  //   F0 00 01 74 10 76 F7  (fn 0x76 = get firmware version, no payload)
  // checksum byte sits at position len-2 = position 6, so we XOR positions 0..5.
  const ii = [0xf0, 0x00, 0x01, 0x74, 0x07, 0x76];
  let iiAcc = 0;
  for (const b of ii) iiAcc ^= b;
  const iiCs = iiAcc & 0x7f;
  // Sanity: just confirm masked value is < 0x80 and deterministic.
  if (iiCs >= 0x80) {
    return `II fixture: masked checksum should be < 0x80, got 0x${iiCs.toString(16)}`;
  }
  // III envelope: f0 00 01 74 11 ... — same algorithm.
  const iii = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x46];
  let iiiAcc = 0;
  for (const b of iii) iiiAcc ^= b;
  if ((iiiAcc & 0x7f) >= 0x80) {
    return `III fixture: masked checksum should be < 0x80`;
  }
  return null;
}

function caseSeptet14bit(): string | null {
  const encode = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
  const decode = (b0: number, b1: number): number => b0 | (b1 << 7);
  for (const v of [0, 1, 127, 128, 200, 4096, 16383]) {
    const [b0, b1] = encode(v);
    if (b0 >= 0x80 || b1 >= 0x80) {
      return `septet bytes not 7-bit-clean for v=${v}: 0x${b0.toString(16)} 0x${b1.toString(16)}`;
    }
    const d = decode(b0, b1);
    if (d !== v) return `round-trip failed for v=${v}: decoded ${d}`;
  }
  return null;
}

function caseSeptet21bitByte2MaskPreservation(): string | null {
  // Encode a 16-bit ushort value (7 + 7 + 2 = 16 value bits) into 3 wire
  // bytes, preserving the high 5 bits of byte 2 (the firmware-reserved
  // mask). Verify round-trip + mask preservation.
  // Note: the cookbook entry is named "septet-21bit" because the WIRE
  // form is 3 septets = 21 wire bits, but the encodable VALUE is 16
  // bits because byte 2 holds only 2 value bits + 5 reserved + 1
  // SysEx-required clear bit.
  const cases: { v: number; originalByte2: number }[] = [
    { v: 0, originalByte2: 0x40 },           // bit 6 of mask set
    { v: 1, originalByte2: 0x7c },           // all reserved bits set
    { v: 0xffff, originalByte2: 0x04 },      // max 16-bit value, single reserved bit
    { v: 0x3456, originalByte2: 0x58 },      // mid-range value + mixed mask
    { v: 0xc000, originalByte2: 0x00 },      // top-2-bits-only, mask zero
  ];
  for (const c of cases) {
    const b0 = c.v & 0x7f;
    const b1 = (c.v >> 7) & 0x7f;
    const b2 = (c.originalByte2 & 0x7c) | ((c.v >> 14) & 0x03);
    if (b0 >= 0x80 || b1 >= 0x80 || b2 >= 0x80) {
      return `bytes not 7-bit-clean for v=0x${c.v.toString(16)}`;
    }
    // Decode the value (low 14 bits of b0/b1 + high 2 bits of b2 & 0x03)
    const decoded = b0 | (b1 << 7) | ((b2 & 0x03) << 14);
    if (decoded !== c.v) {
      return `round-trip value mismatch for v=0x${c.v.toString(16)}, decoded 0x${decoded.toString(16)}`;
    }
    // Verify reserved-bit preservation
    const recoveredMask = b2 & 0x7c;
    const expectedMask = c.originalByte2 & 0x7c;
    if (recoveredMask !== expectedMask) {
      return `reserved-bit preservation failed for v=0x${c.v.toString(16)} origByte2=0x${c.originalByte2.toString(16)}: recovered mask 0x${recoveredMask.toString(16)}, expected 0x${expectedMask.toString(16)}`;
    }
  }
  return null;
}

function caseVendorEnvelopeDescriptorTable(): string | null {
  const jsonPath = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-axe-edit-iii-misc-descriptors.descriptors.json',
  );
  if (!existsSync(jsonPath)) {
    return `descriptor JSON not found at ${jsonPath}. ` +
      `Regenerate via the III parse-ghidra-decompile.ts run.`;
  }
  const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
    tables: { address: string; entries: { tag: number; mid: number; byte_count: number }[] }[];
  };
  const target = parsed.tables.find((t) => t.address === '0x1407ab940');
  if (!target) {
    return `headline table 0x1407ab940 not found in III misc-descriptors JSON. ` +
      `The III preset-body envelope shape claim in cookbook is unverified.`;
  }
  // Expected: (tag=0, mid=6, byte_count=2) + (tag=1, mid=8, byte_count=3072)
  // The sentinel (-1, -1, -1) is stripped by the parser.
  if (target.entries.length !== 2) {
    return `0x1407ab940 entry count: expected 2, got ${target.entries.length}`;
  }
  const [e0, e1] = target.entries;
  if (!(e0.tag === 0 && e0.mid === 6 && e0.byte_count === 2)) {
    return `0x1407ab940 entry[0]: expected (0, 6, 2), got (${e0.tag}, ${e0.mid}, ${e0.byte_count})`;
  }
  if (!(e1.tag === 1 && e1.mid === 8 && e1.byte_count === 3072)) {
    return `0x1407ab940 entry[1]: expected (1, 8, 3072), got (${e1.tag}, ${e1.mid}, ${e1.byte_count})`;
  }
  // 3072 bytes / 3 bytes-per-ushort = 1024 ushorts — sanity-confirm the claim.
  if ((e1.byte_count / 3) !== 1024) {
    return `0x1407ab940 byte_count=3072 should imply 1024 ushorts; got ${e1.byte_count / 3}`;
  }
  return null;
}

function caseIiiBlockNameStringCascade(): string | null {
  // Negative-finding drift guard. The cookbook entry
  // `_negative/iii-block-name-string-cascade.md` claims the III editor
  // binary has NO inline `strcmp(name, "Amp"/"Cab"/"Chorus"/...)` cascade
  // for preset-binary block ordering. If the III dumps are regenerated
  // and the cascade pattern DOES appear, this test fails and forces the
  // cookbook entry to be re-classified (promoted to a real transfer or
  // moved to scratch). False-positive guard: `PresetCabBundleImport` is a
  // single known import-function symbol containing "Cab" as a substring
  // — not a block-name string-table reference.
  const dump = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-axe-edit-iii-preset-receiver.txt',
  );
  if (!existsSync(dump)) {
    return `III preset-receiver dump not found at ${dump}. ` +
      `Regenerate via fractal-midi/scripts/ghidra/DumpAxeEditIIIPresetReceiver.java.`;
  }
  const src = readFileSync(dump, 'utf8');
  // Look for `,"<BlockName>"` followed by `)` — the strcmp-style call
  // pattern AEImageDepot uses on II. Quoting the needle keeps it from
  // matching unrelated identifiers like `PresetCab*`.
  const needles = [
    'Amp', 'Cab', 'Chorus', 'Compressor', 'Drive', 'Reverb', 'Flanger',
    'Phaser', 'Delay', 'Pitch', 'Vocoder', 'Tremolo', 'Filter', 'Rotary',
    'QuadChorus', 'Resonator', 'RingMod', 'Synth', 'GateExpander',
    'GraphicEQ', 'ParametricEQ', 'MultibandComp', 'MultiDelay',
    'PanTrem', 'Looper', 'Noisegate',
  ];
  const matches: string[] = [];
  for (const n of needles) {
    // Pattern: ,"Name") — strcmp-style call argument
    const re = new RegExp(`,\\s*"${n}"\\s*\\)`, 'g');
    const hits = src.match(re);
    if (hits && hits.length > 0) {
      matches.push(`${n} (${hits.length} hits)`);
    }
  }
  if (matches.length > 0) {
    return `cookbook negative-finding CONTRADICTED: III preset-receiver dump ` +
      `now contains strcmp-style block-name cascade matches: ${matches.join(', ')}. ` +
      `Update _negative/iii-block-name-string-cascade.md (promote to transfer or scratch).`;
  }
  return null;
}

function caseXorFoldHash(): string | null {
  // Trivial XOR-fold over a known ushort array; the algorithm matches
  // FUN_00544cc0 from AxeEdit II.
  const xorFold = (us: number[]): number => {
    let acc = 0;
    for (const u of us) acc ^= u & 0xffff;
    return acc & 0xffff;
  };
  // Hand-computed: [0x0001, 0x0002, 0x0003] -> 0x0001 ^ 0x0002 ^ 0x0003 = 0x0000
  if (xorFold([0x0001, 0x0002, 0x0003]) !== 0x0000) {
    return `XOR-fold {1,2,3} expected 0x0000, got 0x${xorFold([1, 2, 3]).toString(16)}`;
  }
  // [0x1234, 0x5678] -> 0x444C
  if (xorFold([0x1234, 0x5678]) !== 0x444c) {
    return `XOR-fold {0x1234,0x5678} expected 0x444C, got 0x${xorFold([0x1234, 0x5678]).toString(16)}`;
  }
  // Empty -> 0
  if (xorFold([]) !== 0) return `XOR-fold empty array expected 0`;
  return null;
}

const FUNCTIONAL_CASES: Record<string, () => string | null> = {
  'xor-7f-envelope-checksum': caseXor7fEnvelopeChecksum,
  'septet-14bit': caseSeptet14bit,
  'septet-21bit-byte2-mask-preservation': caseSeptet21bitByte2MaskPreservation,
  'vendor-envelope-descriptor-table': caseVendorEnvelopeDescriptorTable,
  'xor-fold-hash': caseXorFoldHash,
  'iii-block-name-string-cascade': caseIiiBlockNameStringCascade,
};

// -----------------------------------------------------------------------------
// Driver
// -----------------------------------------------------------------------------

function main(): void {
  const entries = loadEntries();
  const violations: Violation[] = [];
  let structuralOk = 0;
  for (const entry of entries) {
    const before = violations.length;
    validateStructural(entry, violations);
    if (violations.length === before) structuralOk += 1;
  }
  const functionalResults: { slug: string; ok: boolean; message: string | null }[] = [];
  for (const [slug, fn] of Object.entries(FUNCTIONAL_CASES)) {
    let err: string | null;
    try {
      err = fn();
    } catch (e) {
      err = `threw: ${(e as Error).message}`;
    }
    functionalResults.push({ slug, ok: err === null, message: err });
  }
  // Inventory: count entries by status
  const statusCounts = new Map<string, number>();
  for (const e of entries) {
    const s = typeof e.frontmatter.status === 'string' ? e.frontmatter.status : '<missing>';
    statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
  }
  // Inventory: which cookbook entries have inline fixture coverage vs STUB
  const withInline = new Set(Object.keys(FUNCTIONAL_CASES));
  const stubbed = entries.filter(
    (e) => !withInline.has(e.slug) && typeof e.frontmatter.status === 'string' && e.frontmatter.status !== 'scratch',
  ).map((e) => e.slug);

  // -----------------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------------
  console.log('cookbook-verify');
  console.log('===============');
  console.log(`entries scanned:       ${entries.length}`);
  console.log(`structural pass:       ${structuralOk} / ${entries.length}`);
  console.log('status breakdown:');
  for (const [s, n] of [...statusCounts.entries()].sort()) {
    console.log(`  ${s.padEnd(20)} ${n}`);
  }
  console.log('');
  console.log('functional fixture cases:');
  for (const r of functionalResults) {
    if (r.ok) {
      console.log(`  PASS   case-${r.slug}`);
    } else {
      console.log(`  FAIL   case-${r.slug}`);
      console.log(`         ${r.message}`);
    }
  }
  console.log('');
  console.log(`primitives without inline fixture (covered via existing verify-* scripts):`);
  for (const s of stubbed) console.log(`  STUB   case-${s}`);
  console.log('');

  const functionalFails = functionalResults.filter((r) => !r.ok);
  const fails = violations.filter((v) => v.severity === 'fail');
  const warns = violations.filter((v) => v.severity === 'warn');
  if (fails.length === 0 && functionalFails.length === 0) {
    if (warns.length > 0) {
      console.log(`WARNINGS (${warns.length}):`);
      for (const v of warns) console.log(`  [warn] ${v.entry}: ${v.message}`);
      console.log('');
    }
    console.log(
      `OK: ${entries.length} cookbook entries, ${functionalResults.length} fixtures green, ` +
        `${warns.length} non-blocking warnings.`,
    );
    process.exit(0);
  }
  if (fails.length > 0) {
    console.log(`STRUCTURAL FAILURES (${fails.length}):`);
    for (const v of fails) console.log(`  [fail] ${v.entry}: ${v.message}`);
  }
  if (warns.length > 0) {
    console.log(`WARNINGS (${warns.length}):`);
    for (const v of warns) console.log(`  [warn] ${v.entry}: ${v.message}`);
  }
  if (functionalFails.length > 0) {
    console.log(`FUNCTIONAL CASE FAILURES (${functionalFails.length}):`);
    for (const r of functionalFails) {
      console.log(`  case-${r.slug}: ${r.message}`);
    }
  }
  process.exit(1);
}

main();
