/**
 * Axe-Fx II structural splice (PLACE / REMOVE) goldens.
 *
 * Section 1 (always runs, pure CPU): synthetic remove + re-add
 * byte-identity and default-record insert (mirrors the fractal-midi
 * package suite, proving the root wiring).
 *
 * Section 2 (capture-gated):
 *   a. GRID INVARIANTS corpus-wide: id domain, connector-mask domain,
 *      col>1 mask bits point at occupied prev-column cells, shunt-id
 *      uniqueness, and the grid-vs-chain block multiset identity, on
 *      every dump (384 factory + live hw dumps).
 *   b. REMOVE + RE-ADD BYTE-IDENTITY: for every non-tone-match factory
 *      preset, remove the FIRST and the LAST non-tail effect block and
 *      re-add it (span + grid cell from the remove result): the result
 *      must equal the original 12,951 bank bytes byte-for-byte (footer
 *      included). Exercises splice arithmetic, alphabetical
 *      re-insertion, shunt allocation, reserved-bit carriage, and the
 *      21-bit footer, across ~750 real compositions.
 *   c. A000 + MODAL PHASER == A001: inserting the corpus-modal default
 *      Phaser record into factory-A000 at the shunt cell (3,2) yields
 *      a TLV chain whose [wireId,payloadLen] signature equals
 *      factory-A001's (the real factory preset with exactly that
 *      composition) verbatim, and the patched dump passes the strict
 *      decoder + grid invariants.
 *   d. TONE-MATCH REFUSAL: every tone-match factory preset refuses
 *      structural ops.
 */

import { existsSync, readFileSync } from 'node:fs';

import {
  parseIIPresetDumpFrames,
  verifyImageRoundTrip,
  imageFromFrames,
  framesFromImage,
  serializeIIPresetDumpFrames,
  parseIIImageTlv,
  parseIIGrid,
  validateIIGridInvariants,
  gridCellWordIndex,
  removeBlockFromDump,
  insertBlockIntoDump,
  DEFAULT_RECORDS,
  II_IMAGE_WORDS,
  II_IMAGE_FORMAT_TAG,
  II_TLV_CHAIN_START,
  II_PRESET_DUMP_LEN,
  II_TAIL_RESIDENT_WIRE_IDS,
  isShuntId,
} from 'fractal-midi/gen2/axe-fx-ii';

let pass = 0;
let fail = 0;
let skipped = 0;

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok    ${label}`);
    pass++;
  } else {
    console.log(`  FAIL  ${label}${detail ? ': ' + detail : ''}`);
    fail++;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const TAIL_RESIDENT: ReadonlySet<number> = new Set(II_TAIL_RESIDENT_WIRE_IDS);

// ═════════════════════════════════════════════════════════════════════
// Section 1: synthetic wiring (always runs)
// ═════════════════════════════════════════════════════════════════════

console.log('Section 1: synthetic splice wiring');
{
  const words = new Uint16Array(II_IMAGE_WORDS);
  const reserved = new Uint8Array(II_IMAGE_WORDS);
  words[0] = II_IMAGE_FORMAT_TAG;
  // grid row 2: Amp, Flanger, shunt, shunt across cols 1..4
  const row2 = [106, 118, 200, 201];
  for (let col = 1; col <= 4; col++) {
    const w = gridCellWordIndex(col, 2);
    words[w] = row2[col - 1];
    words[w + 1] = 0x02;
  }
  let i = II_TLV_CHAIN_START;
  words[i] = 106; words[i + 1] = 236; i += 2 + 236;
  words[i] = 118; words[i + 1] = 48; i += 2 + 48;
  words[i] = 139; words[i + 1] = 8; i += 2 + 8;
  words[i] = 140; words[i + 1] = 20; i += 2 + 20;
  words[i] = 141; words[i + 1] = 96; i += 2 + 96;
  reserved[II_TLV_CHAIN_START + 2 + 236 + 2 + 7] = 0x10; // a reserved bit inside the Flanger payload
  const bytes = serializeIIPresetDumpFrames(framesFromImage({ words, reserved }, new Uint8Array([0, 0, 0, 0x20])));

  const removed = removeBlockFromDump(bytes, 118);
  check('synthetic: remove Flanger succeeds', removed.ok, !removed.ok ? removed.reason : '');
  if (removed.ok) {
    const readd = insertBlockIntoDump(removed.patchedBytes, {
      wireId: 118,
      span: removed.removed,
      gridCell: removed.gridCell,
    });
    check('synthetic: re-add succeeds', readd.ok, !readd.ok ? readd.reason : '');
    if (readd.ok) {
      check('synthetic: remove + re-add is byte-identical (reserved bits + footer included)', bytesEqual(readd.patchedBytes, bytes));
    }
  }
  const phaser = insertBlockIntoDump(bytes, { wireId: 122, gridCell: { col: 3, row: 2 } });
  check('synthetic: default-record Phaser insert succeeds', phaser.ok, !phaser.ok ? phaser.reason : '');
  if (phaser.ok) {
    const tlv = parseIIImageTlv(imageFromFrames(parseIIPresetDumpFrames(phaser.patchedBytes)).words);
    check(
      'synthetic: Phaser lands between Flanger and the tail (alphabetical)',
      tlv.blocks.map((b) => b.wireId).join(',') === '106,118,122',
      tlv.blocks.map((b) => b.wireId).join(','),
    );
  }
}

// ═════════════════════════════════════════════════════════════════════
// Section 2: capture-gated corpus goldens
// ═════════════════════════════════════════════════════════════════════

console.log('\nSection 2: corpus grid invariants + remove/re-add identity (capture-gated)');

const BANK_PATHS = [
  'samples/factory/Axe-Fx-II_XL+_Bank-A_Q8p02.syx',
  'samples/factory/Axe-Fx-II_XL+_Bank-B_Q8p02.syx',
  'samples/factory/Axe-Fx-II_XL+_Bank-C_Q8p02.syx',
];
const LOCAL_DUMPS = [
  'samples/captured/bk070-loop-amp-bass-2-baseline.syx',
  'samples/captured/hw132/sentinel-eb-alpha.syx',
  'samples/captured/hw132/sentinel-eb-bravo.syx',
  'samples/captured/hw132/stored-slot-7.syx',
];

interface CorpusDump {
  readonly label: string;
  readonly bytes: Uint8Array;
}

const corpus: CorpusDump[] = [];
for (const p of BANK_PATHS) {
  if (!existsSync(p)) { console.log(`  skip  ${p} (not present)`); skipped++; continue; }
  const raw = new Uint8Array(readFileSync(p));
  const bank = p.replace(/^.*Bank-([A-C]).*$/, '$1');
  for (let off = 0, n = 0; off + II_PRESET_DUMP_LEN <= raw.length; off += II_PRESET_DUMP_LEN, n++) {
    corpus.push({ label: `${bank}${String(n).padStart(3, '0')}`, bytes: raw.slice(off, off + II_PRESET_DUMP_LEN) });
  }
}
for (const p of LOCAL_DUMPS) {
  if (!existsSync(p)) { console.log(`  skip  ${p} (not present)`); skipped++; continue; }
  corpus.push({ label: p, bytes: new Uint8Array(readFileSync(p)) });
}

if (corpus.length === 0) {
  console.log('  skip  no corpus fixtures present');
} else {
  // ── 2a: grid invariants ──
  let gridClean = 0;
  const gridFails: string[] = [];
  const toneMatchLabels: string[] = [];
  for (const d of corpus) {
    const rt = verifyImageRoundTrip(parseIIPresetDumpFrames(d.bytes));
    if (!rt.ok) { gridFails.push(`${d.label}: ${rt.reason}`); continue; }
    const tlv = parseIIImageTlv(rt.image.words);
    if (tlv.toneMatchPresent) toneMatchLabels.push(d.label);
    const violations = validateIIGridInvariants(parseIIGrid(rt.image.words), tlv.blocks.map((b) => b.wireId));
    if (violations.length === 0) gridClean++;
    else if (gridFails.length < 5) gridFails.push(`${d.label}: ${violations[0]}`);
  }
  check(
    `grid: ${gridClean}/${corpus.length} dumps pass all grid invariants + chain multiset identity`,
    gridClean === corpus.length,
    gridFails.join('; '),
  );

  // ── 2b: remove + re-add byte-identity (first + last effect block per preset) ──
  let identityOps = 0;
  let identityOk = 0;
  let refusedToneMatch = 0;
  const spliceFails: string[] = [];
  for (const d of corpus) {
    const rt = verifyImageRoundTrip(parseIIPresetDumpFrames(d.bytes));
    if (!rt.ok) continue;
    const tlv = parseIIImageTlv(rt.image.words);
    if (tlv.toneMatchPresent) continue;
    const candidates = tlv.blocks.filter((b) => !TAIL_RESIDENT.has(b.wireId));
    if (candidates.length === 0) continue;
    const targets = candidates.length === 1 ? [candidates[0]] : [candidates[0], candidates[candidates.length - 1]];
    for (const target of targets) {
      identityOps++;
      const removed = removeBlockFromDump(d.bytes, target.wireId);
      if (!removed.ok) {
        if (spliceFails.length < 5) spliceFails.push(`${d.label} remove ${target.wireId}: ${removed.reason}`);
        continue;
      }
      const readd = insertBlockIntoDump(removed.patchedBytes, {
        wireId: target.wireId,
        span: removed.removed,
        gridCell: removed.gridCell,
      });
      if (!readd.ok) {
        if (spliceFails.length < 5) spliceFails.push(`${d.label} re-add ${target.wireId}: ${readd.reason}`);
        continue;
      }
      if (bytesEqual(readd.patchedBytes, d.bytes)) identityOk++;
      else if (spliceFails.length < 5) spliceFails.push(`${d.label} ${target.wireId}: not byte-identical`);
    }
  }
  check(
    `splice: ${identityOk}/${identityOps} remove + re-add ops are byte-identical to the original dump`,
    identityOk === identityOps && identityOps > 700,
    spliceFails.join('; '),
  );

  // ── 2c: A000 + modal Phaser == A001 ──
  const a000 = corpus.find((d) => d.label === 'A000');
  const a001 = corpus.find((d) => d.label === 'A001');
  if (a000 !== undefined && a001 !== undefined) {
    const inserted = insertBlockIntoDump(a000.bytes, { wireId: 122, gridCell: { col: 3, row: 2 } });
    check('A000: modal-default Phaser insert at shunt (3,2) succeeds', inserted.ok, !inserted.ok ? inserted.reason : '');
    if (inserted.ok) {
      const chainSig = (bytes: Uint8Array): string => {
        const tlv = parseIIImageTlv(imageFromFrames(parseIIPresetDumpFrames(bytes)).words);
        const mods = tlv.modifiers.map((m) => `M${m.slotId}:${m.payloadLen}`);
        const blocks = [...tlv.blocks, ...tlv.systemTail]
          .sort((x, y) => x.tlvWord - y.tlvWord)
          .map((b) => `${b.wireId}:${b.payloadLen}`);
        return [...mods, ...blocks].join(' ');
      };
      const synth = chainSig(inserted.patchedBytes);
      const real = chainSig(a001.bytes);
      check('A000+Phaser: chain [wireId,payloadLen] signature equals factory-A001 verbatim', synth === real, `synth=${synth} real=${real}`);
      const rt = verifyImageRoundTrip(parseIIPresetDumpFrames(inserted.patchedBytes));
      check('A000+Phaser: patched dump passes the strict round-trip gate', rt.ok, !rt.ok ? rt.reason : '');
      if (rt.ok) {
        const tlv = parseIIImageTlv(rt.image.words);
        const violations = validateIIGridInvariants(parseIIGrid(rt.image.words), tlv.blocks.map((b) => b.wireId));
        check('A000+Phaser: grid invariants clean after insert', violations.length === 0, violations.join('; '));
        const cells = parseIIGrid(rt.image.words);
        const phaserCell = cells.find((c) => c.id === 122);
        check('A000+Phaser: cell (3,2) now holds the Phaser with routing preserved', phaserCell?.col === 3 && phaserCell?.row === 2 && phaserCell?.connectorMask === 0x02);
        check('A000+Phaser: no shunt id duplicated', cells.filter((c) => isShuntId(c.id)).length === new Set(cells.filter((c) => isShuntId(c.id)).map((c) => c.id)).size);
      }
      check('A000+Phaser: default-record payloadLen is 46', DEFAULT_RECORDS[122].payloadLen === 46);
    }
  } else {
    console.log('  skip  factory A000/A001 not present');
    skipped++;
  }

  // ── 2d: tone-match refusal ──
  if (toneMatchLabels.length > 0) {
    let refused = 0;
    for (const label of toneMatchLabels) {
      const d = corpus.find((x) => x.label === label)!;
      const tlv = parseIIImageTlv(imageFromFrames(parseIIPresetDumpFrames(d.bytes)).words);
      const target = tlv.blocks.find((b) => !TAIL_RESIDENT.has(b.wireId));
      if (target === undefined) continue;
      const result = removeBlockFromDump(d.bytes, target.wireId);
      if (!result.ok && result.reason.includes('Tone Match')) refused++;
      refusedToneMatch++;
    }
    check(
      `tone-match: ${refused}/${refusedToneMatch} tone-match presets refuse structural ops (corpus has ${toneMatchLabels.length})`,
      refused === refusedToneMatch && refusedToneMatch > 0,
      toneMatchLabels.join(','),
    );
  }
}

console.log(`\n${pass} ok, ${fail} fail, ${skipped} skipped.`);
if (fail > 0) process.exit(1);
