/**
 * circuit-colour-object-survey.ts — READ-ONLY survey of WHERE COLOUR (and any
 * colour-shaped small-valued field) lives across EVERY addressable object on a
 * Novation Circuit Tracks: projects, synth patches, patterns, notes, packs.
 *
 * ## Why this exists
 *
 * Project colour was decoded and then HARDWARE-CONFIRMED on 2026-07-29 (palette
 * index 0=Red and 8=Green written into `.ncs` offset 0x0C, one byte of 160,780
 * each, rendered by the device in Projects View). The follow-on question is
 * whether the same affordance exists for the other objects the device shows on
 * a grid of pads — above all SYNTH PATCHES, because grouping patch types by
 * category is exactly what a colour dimension is good for.
 *
 * This script answers the FILE half of that question with data. The DEVICE half
 * (what actually gets rendered) is answered by the Circuit Tracks User Guide v3
 * and is summarised at the end of this docstring, because a field we can write
 * that the device never renders is worth nothing.
 *
 * ## What it checks
 *
 *  1. **PATCH** — the 340-byte synth patch body. The v3 Programmer's Reference
 *     ("Synth Patch Format", p.15) names offset 16 `Patch_Category` (0..14) and
 *     offset 17 `Patch_Genre` (0..9), with 18..31 `Patch_Reserved1..14`. This
 *     validates that against three independent corpora and hunts the reserved
 *     region for any second small-valued field:
 *       (a) the 128 captured factory patch dumps,
 *       (b) the `.cpb` patchbank FILES from the CRC-verified card backup,
 *       (c) the patch bodies EMBEDDED in every `.ncs` project (0x26d14 Synth 1,
 *           0x26e68 Synth 2) — which is the writable copy that travels with a
 *           project upload.
 *
 *  2. **PATTERN** — every byte of every per-pattern metadata block, across the
 *     whole corpus, looking for a byte that (i) varies pattern-to-pattern inside
 *     one project and (ii) sits in the 0..13 palette window. A per-pattern
 *     colour would look exactly like that.
 *
 *  3. **WHOLE FILE** — the small-value constant hunt: bytes outside the step
 *     regions that are CONSTANT across the entire corpus and lie in 0..13. This
 *     is the class project colour itself sat in before Novation's factory demos
 *     (which carry 10=Cyan against the user default 11=Blue) discriminated it.
 *     Reporting the size of that class honestly bounds what could still be
 *     hiding: a field nobody has ever changed is invisible to a differential.
 *
 * ## What the DEVICE renders (User Guide v3, cited inline in the output)
 *
 *   Projects View  — per-project colour, 14-entry palette.      CONFIRMED, ours.
 *   Packs View     — per-pack colour, "set in Novation Components" (p.97).
 *   Patch View     — white = selected, VIOLET = every Synth 1 slot, PALE GREEN
 *                    = every Synth 2 slot (p.33). Two-tone by TRACK. Category is
 *                    NOT rendered.
 *   Patterns View  — colour = the TRACK's colour (the pad's column); brightness
 *                    and pulse carry state (p.73-74). Not per-pattern data.
 *   Note View      — keyboard pads = track colour, octave extremes paler;
 *                    step pads pale blue / bright blue (has note) / white
 *                    (cursor) / red (held) (p.33, p.38-39). Not per-note data.
 *   Mixer/Scenes   — white / gold / green by state (p.81-82). Not stored colour.
 *
 * Read-only: opens no MIDI port, writes no file, touches no device.
 *
 *   npx tsx scripts/_research/circuit-colour-object-survey.ts
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  NCS_FILE_SIZE, META_OFFSETS, NOTE_STEP_REGION, DRUM_STEP_REGION, DRUM_BLOCK_START,
} from '../../packages/circuit-tracks/src/ncs/format.js';

const ROOT = 'C:/dev/mcp-midi-tools';
const BACKUP = join(ROOT, 'samples/circuit-ncs/card-backup-2026-07-27T16-49Z');
const FACTORY_PATCHES = join(ROOT, 'samples/circuit-tracks/pack0/patches');
const FACTORY_PROJECTS = join(ROOT, 'samples/circuit-tracks/pack0/projects');

/** Embedded synth-patch bodies inside a `.ncs` (oracle-confirmed 2026-07-27). */
const EMBED = [
  { part: 'Synth 1', off: 0x26d14 },
  { part: 'Synth 2', off: 0x26e68 },
] as const;
const PATCH_BODY_LEN = 340;

/** v3 Programmer's Reference, "Synth Patch Format" p.15. */
const PATCH_CATEGORY_OFFSET = 16;
const PATCH_GENRE_OFFSET = 17;
const PATCH_CATEGORY_MAX = 14;
const PATCH_GENRE_MAX = 9;
const PATCH_RESERVED = [18, 31] as const;

/** `.cpb` patchbank: 512-byte stride, 340-byte body, file truncated after the last slot. */
const CPB_STRIDE = 512;

/** The project-colour palette window, for the "is this colour-shaped?" test. */
const PALETTE_MAX = 13;

const line = (s = ''): void => console.log(s);
const rule = (t: string): void => { line(); line(`${'='.repeat(78)}`); line(t); line('='.repeat(78)); };

const patchName = (b: Uint8Array | Buffer): string =>
  Array.from(b.subarray(0, 16)).map((c) => String.fromCharCode(c & 0x7f)).join('').replace(/\s+$/u, '');
const projName = (b: Uint8Array): string =>
  Array.from(b.subarray(0x10, 0x20)).map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '')).join('').trimEnd();

// ── corpora ────────────────────────────────────────────────────────────────

interface Proj { label: string; buf: Uint8Array }

function loadProjects(): { user: Proj[]; factory: Proj[] } {
  const user: Proj[] = [];
  const factory: Proj[] = [];
  for (let p = 1; p <= 5; p++) {
    const dir = join(BACKUP, `pack${p}`);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ncs')).sort()) {
      const buf = new Uint8Array(readFileSync(join(dir, f)));
      // Structural gate: the corrupt proj64 in the backup is the right LENGTH but
      // its header is a de-framing failure, so length alone is not enough.
      if (buf.length !== NCS_FILE_SIZE) continue;
      if (String.fromCharCode(...buf.subarray(0, 4)) !== 'USER') continue;
      if (new DataView(buf.buffer, buf.byteOffset).getUint32(4, true) !== NCS_FILE_SIZE) continue;
      user.push({ label: `pack${p}/${f}`, buf });
    }
  }
  if (existsSync(FACTORY_PROJECTS)) {
    for (const f of readdirSync(FACTORY_PROJECTS).filter((n) => n.endsWith('.ncs')).sort()) {
      const buf = new Uint8Array(readFileSync(join(FACTORY_PROJECTS, f)));
      if (buf.length === NCS_FILE_SIZE) factory.push({ label: f, buf });
    }
  }
  return { user, factory };
}

function loadFactoryPatchBodies(): { name: string; body: Uint8Array }[] {
  if (!existsSync(FACTORY_PATCHES)) return [];
  return readdirSync(FACTORY_PATCHES)
    .filter((f) => /^patch_\d+\.syx$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .map((f) => {
      const raw = readFileSync(join(FACTORY_PATCHES, f));
      const body = new Uint8Array(raw.subarray(9, 9 + PATCH_BODY_LEN)); // strip 9-byte prefix
      return { name: patchName(body), body };
    });
}

function loadCpbBodies(): { file: string; slot: number; body: Uint8Array }[] {
  const out: { file: string; slot: number; body: Uint8Array }[] = [];
  for (let p = 1; p <= 5; p++) {
    const dir = join(BACKUP, `pack${p}`, 'patchbanks');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.cpb')).sort()) {
      const raw = readFileSync(join(dir, f));
      const slots = Math.floor((raw.length - PATCH_BODY_LEN) / CPB_STRIDE) + 1;
      for (let s = 0; s < slots; s++) {
        const body = new Uint8Array(raw.subarray(s * CPB_STRIDE, s * CPB_STRIDE + PATCH_BODY_LEN));
        if (body.length !== PATCH_BODY_LEN) continue;
        if (body.every((c, i) => i >= 16 || c === 0xff)) continue; // 0xFF-filled = empty slot
        out.push({ file: `pack${p}/${f}`, slot: s, body });
      }
    }
  }
  return out;
}

// ── 1. PATCH ───────────────────────────────────────────────────────────────

function surveyPatchBodies(label: string, bodies: { name: string; body: Uint8Array }[]): void {
  if (bodies.length === 0) { line(`  ${label}: (corpus absent)`); return; }
  const cat = new Map<number, string[]>();
  const gen = new Map<number, number>();
  const reservedNonZero = new Map<number, Set<number>>();
  let catOutOfSpec = 0;
  let genOutOfSpec = 0;

  for (const { name, body } of bodies) {
    const c = body[PATCH_CATEGORY_OFFSET];
    const g = body[PATCH_GENRE_OFFSET];
    if (c > PATCH_CATEGORY_MAX) catOutOfSpec++;
    if (g > PATCH_GENRE_MAX) genOutOfSpec++;
    (cat.get(c) ?? cat.set(c, []).get(c)!).push(name);
    gen.set(g, (gen.get(g) ?? 0) + 1);
    for (let o = PATCH_RESERVED[0]; o <= PATCH_RESERVED[1]; o++) {
      if (body[o] !== 0) (reservedNonZero.get(o) ?? reservedNonZero.set(o, new Set()).get(o)!).add(body[o]);
    }
  }

  line(`  ${label}: ${bodies.length} bodies`);
  line(`    offset 16 Patch_Category  values ${[...cat.keys()].sort((a, b) => a - b).join(',')}` +
       `   spec 0..${PATCH_CATEGORY_MAX} -> ${catOutOfSpec === 0 ? 'ALL IN SPEC' : `${catOutOfSpec} OUT OF SPEC`}`);
  line(`    offset 17 Patch_Genre     values ${[...gen.keys()].sort((a, b) => a - b).join(',')}` +
       `   spec 0..${PATCH_GENRE_MAX} -> ${genOutOfSpec === 0 ? 'ALL IN SPEC' : `${genOutOfSpec} OUT OF SPEC`}`);
  line(`    offsets 18..31 Patch_Reserved1..14  -> ` +
       (reservedNonZero.size === 0
         ? 'ALL ZERO in every body (no second small-valued field hiding here)'
         : `NON-ZERO at ${[...reservedNonZero.entries()].map(([o, v]) => `${o}:{${[...v].join(',')}}`).join(' ')}`));
  for (const c of [...cat.keys()].sort((a, b) => a - b)) {
    const names = cat.get(c)!;
    line(`      cat ${String(c).padStart(2)} (${String(names.length).padStart(3)}): ` +
         names.slice(0, 8).join(', ') + (names.length > 8 ? ` …(+${names.length - 8})` : ''));
  }
}

function surveyEmbeddedPatches(projects: Proj[], label: string): void {
  if (projects.length === 0) { line(`  ${label}: (corpus absent)`); return; }
  const bodies: { name: string; body: Uint8Array }[] = [];
  for (const p of projects) {
    for (const { part, off } of EMBED) {
      bodies.push({ name: `${projName(p.buf)}/${part}`, body: p.buf.subarray(off, off + PATCH_BODY_LEN) });
    }
  }
  surveyPatchBodies(label, bodies);
}

// ── 2. PATTERN ─────────────────────────────────────────────────────────────

/**
 * A pattern's metadata block runs from META_OFFSETS[i] (byte 0 = length) up to
 * the start of the NEXT block's step region. Everything in there is per-pattern
 * data, and a per-pattern colour would have to live in it.
 */
function metaBlockBounds(i: number): { start: number; end: number } {
  const start = META_OFFSETS[i];
  const next = i + 1 < META_OFFSETS.length ? META_OFFSETS[i + 1] : NCS_FILE_SIZE;
  const nextIsDrum = i + 1 >= DRUM_BLOCK_START && i + 1 < DRUM_BLOCK_START + 32;
  const nextRegion = i + 1 < META_OFFSETS.length ? (nextIsDrum ? DRUM_STEP_REGION : NOTE_STEP_REGION) : 0;
  return { start, end: Math.max(start, next - nextRegion) };
}

function surveyPatternMeta(projects: Proj[]): void {
  if (projects.length === 0) { line('  (corpus absent)'); return; }

  // A per-pattern colour must VARY between the 8 patterns of one track inside a
  // single project (otherwise it is a project-level field, not a pattern one).
  // Score every RELATIVE offset within a meta block by how often it does that.
  const relVaries = new Map<number, number>();       // rel offset -> projects where it varies across patterns
  const relValues = new Map<number, Set<number>>();  // rel offset -> every value ever seen
  const blockLen = Math.min(...META_OFFSETS.map((_, i) => metaBlockBounds(i).end - metaBlockBounds(i).start));

  for (const p of projects) {
    for (let rel = 0; rel < blockLen; rel++) {
      // synth1's 8 patterns are meta blocks 0..7 — one track, eight patterns.
      const vals = new Set<number>();
      for (let b = 0; b < 8; b++) vals.add(p.buf[META_OFFSETS[b] + rel]);
      for (const v of vals) (relValues.get(rel) ?? relValues.set(rel, new Set()).get(rel)!).add(v);
      if (vals.size > 1) relVaries.set(rel, (relVaries.get(rel) ?? 0) + 1);
    }
  }

  line(`  per-pattern metadata block = ${blockLen} bytes (byte 0 = pattern length, decoded + hardware-confirmed)`);
  line(`  scanned ${projects.length} projects x 8 synth1 patterns x ${blockLen} offsets`);
  line('');
  const varying = [...relVaries.entries()].sort((a, b) => b[1] - a[1]);
  line(`  ${varying.length} of ${blockLen} offsets vary pattern-to-pattern in at least one project.`);
  line('');

  // THE test that matters: a per-pattern COLOUR must vary between patterns AND
  // never leave the 0..13 palette window across the whole corpus. Anything that
  // reaches 14+ is some other field (velocity, gate, probability, note data).
  const candidates = varying
    .map(([rel, n]) => ({ rel, n, vals: [...(relValues.get(rel) ?? [])].sort((a, b) => a - b) }))
    .filter((c) => c.vals.length > 1 && c.vals[c.vals.length - 1] <= PALETTE_MAX);

  line(`  COLOUR-SHAPED CANDIDATES (varies across patterns AND every observed value <= ${PALETTE_MAX}): ${candidates.length}`);
  for (const c of candidates.slice(0, 30)) {
    line(`    +0x${c.rel.toString(16).padStart(3, '0')}  ${String(c.n).padStart(3)} proj  values ${c.vals.join(',')}`);
  }
  if (candidates.length > 30) line(`    …(+${candidates.length - 30} more)`);
  line('');
  line('  For reference, the 10 offsets that vary in the MOST projects (all far outside the palette window):');
  for (const [rel, n] of varying.slice(0, 10)) {
    const vals = [...(relValues.get(rel) ?? [])].sort((a, b) => a - b);
    line(`    +0x${rel.toString(16).padStart(3, '0')}  ${String(n).padStart(3)} proj  ` +
         `min ${vals[0]} max ${vals[vals.length - 1]} (${vals.length} distinct)`);
  }
}

// ── 3. WHOLE-FILE small-value constant hunt ────────────────────────────────

function stepMask(): Uint8Array {
  const mask = new Uint8Array(NCS_FILE_SIZE);
  META_OFFSETS.forEach((meta, i) => {
    const region = i >= DRUM_BLOCK_START && i < DRUM_BLOCK_START + 32 ? DRUM_STEP_REGION : NOTE_STEP_REGION;
    for (let o = meta - region; o < meta; o++) mask[o] = 1;
  });
  return mask;
}

function surveyConstants(all: Proj[]): void {
  if (all.length === 0) { line('  (corpus absent)'); return; }
  const mask = stepMask();
  let constantSmall = 0;
  let constantZeroSmall = 0;
  let varying = 0;
  const smallNonZero: { off: number; val: number }[] = [];

  for (let off = 0; off < NCS_FILE_SIZE; off++) {
    if (mask[off]) continue;
    const v0 = all[0].buf[off];
    let same = true;
    for (const p of all) if (p.buf[off] !== v0) { same = false; break; }
    if (!same) { varying++; continue; }
    if (v0 <= PALETTE_MAX) {
      constantSmall++;
      if (v0 === 0) constantZeroSmall++; else smallNonZero.push({ off, val: v0 });
    }
  }
  line(`  corpus: ${all.length} projects (user saves + Novation factory demos together)`);
  line(`  outside the step regions: ${varying} bytes VARY across the corpus.`);
  line(`  ${constantSmall} bytes are CONSTANT and sit in the 0..${PALETTE_MAX} palette window,`);
  line(`    of which ${constantZeroSmall} are constant ZERO (the overwhelming majority: padding/reserved)`);
  line(`    and ${smallNonZero.length} are constant NON-ZERO.`);
  line('');
  line('  Constant NON-ZERO small-valued bytes (the only shape a never-yet-set colour could take):');
  for (const { off, val } of smallNonZero.slice(0, 40)) line(`    0x${off.toString(16).padStart(5, '0')} = ${val}`);
  if (smallNonZero.length > 40) line(`    …(+${smallNonZero.length - 40} more)`);
}

// ── main ───────────────────────────────────────────────────────────────────

function main(): void {
  line('Circuit Tracks — COLOUR SURVEY ACROSS EVERY ADDRESSABLE OBJECT (read-only, no device)');

  const { user, factory } = loadProjects();
  const all = [...user, ...factory];

  rule('0. PROJECT — the confirmed baseline (offset 0x0C, LE uint32, palette 0..13)');
  const tally = new Map<number, number>();
  for (const p of all) tally.set(p.buf[0x0c], (tally.get(p.buf[0x0c]) ?? 0) + 1);
  for (const [v, n] of [...tally.entries()].sort((a, b) => a[0] - b[0])) {
    line(`  0x0C = ${String(v).padStart(2)}  x${String(n).padStart(3)}` +
         (v === 11 ? '   (Blue — the untouched user default)' : v === 10 ? '   (Cyan — Novation\'s factory demos)' : ''));
  }
  line('  HARDWARE-CONFIRMED 2026-07-29: 0 -> Red and 8 -> Green rendered on the device in Projects View.');

  rule('1. PATCH — does a synth patch carry a colour? (340-byte body)');
  line('  Spec: v3 Programmer\'s Reference, "Synth Patch Format" p.15 —');
  line('    offset 16 = Patch_Category (min 0, default 0, MAX 14)   <- 15 values, NOT the 14-entry pad palette');
  line('    offset 17 = Patch_Genre    (min 0, default 0, MAX  9)');
  line('    offsets 18..31 = Patch_Reserved1..14');
  line('  There is NO Patch_Colour in the spec. The whole 340-byte body is enumerated and every');
  line('  offset is named; a colour field would have to be one of the reserved bytes.');
  line('');
  surveyPatchBodies('(a) 128 captured FACTORY patch dumps', loadFactoryPatchBodies());
  line('');
  const cpb = loadCpbBodies();
  surveyPatchBodies('(b) .cpb PATCHBANK files from the card backup',
    cpb.map((c) => ({ name: `${c.file}#${c.slot} ${patchName(c.body)}`, body: c.body })));
  line('');
  surveyEmbeddedPatches(user, '(c) patch bodies EMBEDDED in user .ncs projects (0x26d14 / 0x26e68)');
  line('');
  surveyEmbeddedPatches(factory, '(d) patch bodies EMBEDDED in Novation factory demo .ncs projects');

  rule('2. PATTERN — is pad colour per-pattern data, per-track, or positional?');
  surveyPatternMeta(all);

  rule('3. WHOLE FILE — what small-valued constants could still hide a colour?');
  surveyConstants(all);

  rule('4. .cpb PATCHBANK container layout (decoded here, for the record)');
  for (let p = 1; p <= 5; p++) {
    const dir = join(BACKUP, `pack${p}`, 'patchbanks');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.cpb')).sort()) {
      const size = statSync(join(dir, f)).size;
      const slots = Math.floor((size - PATCH_BODY_LEN) / CPB_STRIDE) + 1;
      line(`  pack${p}/${f}  ${size} bytes = ${slots - 1} x ${CPB_STRIDE} + ${PATCH_BODY_LEN}  -> ${slots} slots` +
           (size === (slots - 1) * CPB_STRIDE + PATCH_BODY_LEN ? '  (exact)' : '  (INEXACT — layout hypothesis wrong)'));
    }
  }
  line('');
  line('  Layout: 512-byte stride, 340-byte body at each slot base, file truncated after the last');
  line('  occupied slot; an empty slot is 0xFF-filled. Slot base + 16 = Patch_Category.');
  line('');
}

main();
