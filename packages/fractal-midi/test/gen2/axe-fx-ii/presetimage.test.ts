/**
 * Axe-Fx II preset-image encode-lane goldens (synthetic, no fixtures).
 *
 * Pure-CPU cases over a synthetic-but-invariant-complete image (valid
 * grid multiset, alphabetical chain, system tail, footer hash):
 *   - frame codec round-trip identity (parse -> image -> frames ->
 *     bytes, byte-identical), reserved byte-2 bit carriage
 *   - strict TLV walk incl. the single-channel full-payload refinement
 *   - grid parse + corpus invariants + shunt allocation
 *   - discrete rostered-select patch: X apply by label + by ordinal,
 *     the itemized refusal set (knob, switch, no-roster, tempo,
 *     bypass-pid identity, MTD/CONTROLLERS Y, stale-Y read-before-write)
 *   - scene-state word codec: bit semantics + RMW + refusals
 *   - structural splice: remove + re-add byte-identity, default-record
 *     insert at the alphabetical position (corpus-modal AND the
 *     HARDWARE-FRESH tier for the always-tweaked families), tone-match
 *     refusal
 *   - atomic compose (rebuild to a target wireId/cell set): untouched
 *     blocks keep their exact prior payload, unwanted blocks are
 *     removed, new ones inserted via FRESH_DEFAULT_RECORDS, targeting
 *     the exact current chain is a byte-identical no-op, all-or-nothing
 *     target validation (duplicate cell/wireId, tail-resident target)
 *
 * Corpus-scale validation (384 factory presets + live hardware dumps +
 * BK-070 paired replays) lives in the repo-root goldens
 * `verify-ii-image-{discrete-encode,scene-words,structural-splice}.ts`
 * (capture-gated; samples are local-only).
 */
import {
  parseIIPresetDumpFrames,
  serializeIIPresetDumpFrames,
  framesFromImage,
  imageFromFrames,
  verifyImageRoundTrip,
  computeImageHash,
  copyImage,
  II_IMAGE_WORDS,
  II_IMAGE_FORMAT_TAG,
  II_TLV_CHAIN_START,
  II_MODIFIER_PAYLOAD_LEN,
  parseIIImageTlv,
  findIIImageBlock,
  imageParamWordIndex,
  sceneStateWordIndex,
  parseIIGrid,
  validateIIGridInvariants,
  allocateShuntId,
  gridCellWordIndex,
  applyDiscreteSelectsToImage,
  applyDiscreteSelectsToDump,
  applySceneStateToImage,
  applySceneStateToDump,
  decodeSceneStateWord,
  encodeSceneStateWord,
  removeBlockFromDump,
  insertBlockIntoDump,
  removeBlockFromImage,
  insertBlockIntoImage,
  composeImageChain,
  planIILiveComposeOps,
  DEFAULT_RECORDS,
  FRESH_DEFAULT_RECORDS,
  type AxeFxIIImageBuffer,
} from '../../../src/gen2/axe-fx-ii/index.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ── Synthetic image ──────────────────────────────────────────────────
// Chain (alphabetical by squashed display name):
//   modifier(3), Amp 1(106/236), Cab 1(108/78), Delay 1(112/140),
//   Filter 1(131/14), Flanger 1(118/48), Multi Delay 1(114/118),
//   Quad Chorus 1(156/46), Reverb 1(110/90), Volume/Pan 1(127/9),
//   tail: 139/8, 140/20, 141/96.
// Grid row 2: the 9 blocks in signal order across cols 1..9, shunts at
// (10,2) (11,2) (12,2); every col>1 cell fed from prev col row 2.
const CHAIN: Array<[number, number]> = [
  [106, 236], [108, 78], [112, 140], [131, 14], [118, 48],
  [114, 118], [156, 46], [110, 90], [127, 9],
  [139, 8], [140, 20], [141, 96],
];
const GRID_ROW2_IDS = [106, 108, 112, 131, 118, 114, 156, 110, 127, 200, 201, 202];

function buildSyntheticImage(): AxeFxIIImageBuffer {
  const words = new Uint16Array(II_IMAGE_WORDS);
  const reserved = new Uint8Array(II_IMAGE_WORDS);
  words[0] = II_IMAGE_FORMAT_TAG;
  const name = 'IMG GOLD';
  for (let i = 0; i < name.length; i++) words[2 + i] = name.charCodeAt(i);
  for (let col = 1; col <= 12; col++) {
    const w = gridCellWordIndex(col, 2);
    words[w] = GRID_ROW2_IDS[col - 1];
    words[w + 1] = 0x02; // fed from prev-column row 2 (col 1: input-node row bit)
  }
  let i = II_TLV_CHAIN_START;
  // one modifier record targeting the Flanger (payload[8] = 118)
  words[i] = 3;
  words[i + 1] = II_MODIFIER_PAYLOAD_LEN;
  words[i + 2 + 8] = 118;
  i += 2 + II_MODIFIER_PAYLOAD_LEN;
  for (const [id, len] of CHAIN) {
    words[i] = id;
    words[i + 1] = len;
    // Y-half seeds for the discrete-lane tests:
    if (id === 110) words[i + 2 + 45 + 0] = 1; // reverb Y effect_type in roster
    if (id === 112) words[i + 2 + 70 + 0] = 26214; // delay Y effect_type STALE (0x6666)
    if (id === 114) words[i + 2 + 59 + 35] = 2621; // multidelay "Y" garbage
    i += 2 + len;
  }
  // terminator at words[i] = 0 (already zero)
  // one reserved byte-2 bit inside the Flanger payload (moves with splice)
  const tlv = parseIIImageTlv(words);
  const flg = findIIImageBlock(tlv, 118)!;
  reserved[flg.baseWord + 5] = 0x08;
  return { words, reserved };
}

function buildSyntheticDump(image: AxeFxIIImageBuffer): Uint8Array {
  const frames = framesFromImage(image, new Uint8Array([0, 0, 0, 0x20]));
  return serializeIIPresetDumpFrames(frames);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Case {
  name: string;
  run: () => void;
}

const cases: Case[] = [
  {
    name: 'frame codec: parse -> serialize is byte-identical, reserved bits carried',
    run: () => {
      const image = buildSyntheticImage();
      const bytes = buildSyntheticDump(image);
      const frames = parseIIPresetDumpFrames(bytes);
      assert(bytesEqual(serializeIIPresetDumpFrames(frames), bytes), 're-serialize differs');
      const rt = verifyImageRoundTrip(frames);
      assert(rt.ok, `round trip refused: ${rt.ok ? '' : rt.reason}`);
      if (rt.ok) {
        const flg = findIIImageBlock(parseIIImageTlv(rt.image.words), 118)!;
        assert(rt.image.reserved[flg.baseWord + 5] === 0x08, 'reserved bit not carried through frames');
      }
      const back = imageFromFrames(frames);
      assert(computeImageHash(back.words) === computeImageHash(image.words), 'hash drift');
    },
  },
  {
    name: 'round trip: footer-hash mismatch refuses',
    run: () => {
      const image = buildSyntheticImage();
      const bytes = buildSyntheticDump(image);
      const frames = parseIIPresetDumpFrames(bytes);
      const badFooter = Uint8Array.from(frames.footerPayload);
      badFooter[0] ^= 0x01;
      const rt = verifyImageRoundTrip({ ...frames, footerPayload: badFooter });
      assert(!rt.ok && rt.reason.includes('footer hash mismatch'), 'bad footer not refused');
    },
  },
  {
    name: 'TLV walk: chain order, tail split, single-channel full-payload refinement',
    run: () => {
      const image = buildSyntheticImage();
      const tlv = parseIIImageTlv(image.words);
      assert(tlv.name === 'IMG GOLD', `name ${tlv.name}`);
      assert(tlv.modifiers.length === 1 && tlv.modifiers[0].payload[8] === 118, 'modifier');
      assert(tlv.blocks.length === 9 && tlv.systemTail.length === 3, 'block split');
      const fil = findIIImageBlock(tlv, 131)!;
      assert(fil.singleChannelFullPayload && fil.xToYOffset === undefined, 'filter must be single-channel');
      // X pid 13 is addressable in the FULL 14-word payload (would throw under halving)
      assert(imageParamWordIndex(fil, 13, 'X') === fil.baseWord + 13, 'filter X full-payload bound');
      let threw = false;
      try { imageParamWordIndex(fil, 0, 'Y'); } catch { threw = true; }
      assert(threw, 'filter Y must refuse');
      const amp = findIIImageBlock(tlv, 106)!;
      assert(imageParamWordIndex(amp, 2, 'Y') === amp.baseWord + 118 + 2, 'amp Y half math');
      // scene accessor: filter bypass pid 8 sits past len/2 but inside the payload
      assert(sceneStateWordIndex(fil) === fil.baseWord + 8, 'filter scene word');
      const qch = findIIImageBlock(tlv, 156)!;
      assert(sceneStateWordIndex(qch) === undefined, 'quadchorus has no located scene word');
    },
  },
  {
    name: 'grid: parse + invariants clean + multiset identity + shunt allocation',
    run: () => {
      const image = buildSyntheticImage();
      const tlv = parseIIImageTlv(image.words);
      const cells = parseIIGrid(image.words);
      const violations = validateIIGridInvariants(cells, tlv.blocks.map((b) => b.wireId));
      assert(violations.length === 0, `grid violations: ${violations.join('; ')}`);
      assert(allocateShuntId([200, 201, 202]) === 203, 'lowest-unused shunt id');
    },
  },
  {
    name: 'discrete: X patch by label and by ordinal, exactly one word each',
    run: () => {
      const image = buildSyntheticImage();
      const result = applyDiscreteSelectsToImage(image, [
        { blockWireId: 106, paramName: 'effect_type', channel: 'X', value: 'BRIT JM45' },
        { blockWireId: 110, paramName: 'effect_type', channel: 'X', value: 2 },
      ]);
      assert(result.ok, `refused: ${result.ok ? '' : result.reason}`);
      if (result.ok) {
        assert(result.applied.length === 2 && result.refused.length === 0, 'apply counts');
        assert(result.applied[0].afterWire === 9, `BRIT JM45 must be ordinal 9, got ${result.applied[0].afterWire}`);
        assert(result.applied[0].note !== undefined, 'type-selector note missing');
        let diff = 0;
        for (let i = 0; i < II_IMAGE_WORDS; i++) if (result.image.words[i] !== image.words[i]) diff++;
        assert(diff === 2, `diff ${diff}, expected 2`);
      }
    },
  },
  {
    name: 'discrete: itemized refusals (knob, no-roster tempo, bypass pid, unknown label)',
    run: () => {
      const image = buildSyntheticImage();
      const result = applyDiscreteSelectsToImage(image, [
        { blockWireId: 106, paramName: 'bass', channel: 'X', value: 5 },
        { blockWireId: 141, paramName: 'tempo', channel: 'X', value: 3 },
        { blockWireId: 106, paramName: 'bypass', channel: 'X', value: 0 },
        { blockWireId: 106, paramName: 'effect_type', channel: 'X', value: 'NOT AN AMP' },
      ]);
      assert(!result.ok, 'all four must refuse');
      if (!result.ok) {
        const reasons = (result.refused ?? []).map((r) => r.reason);
        assert(reasons.length === 4, `refused ${reasons.length}`);
        assert(reasons[0].includes('controlType="knob"'), `knob: ${reasons[0]}`);
        assert(reasons[1].includes('dual-mode tempo'), `tempo: ${reasons[1]}`);
        assert(reasons[2].includes('scene-state'), `bypass pid: ${reasons[2]}`);
        assert(reasons[3].includes('not in the registered roster'), `label: ${reasons[3]}`);
      }
    },
  },
  {
    name: 'discrete: Y gates (clean group passes, stale Y refuses, MTD Y never)',
    run: () => {
      const image = buildSyntheticImage();
      const clean = applyDiscreteSelectsToImage(image, [
        { blockWireId: 110, paramName: 'effect_type', channel: 'Y', value: 3 },
      ]);
      assert(clean.ok && clean.applied.length === 1, 'clean-group Y (REV) must pass');
      const stale = applyDiscreteSelectsToImage(image, [
        { blockWireId: 112, paramName: 'effect_type', channel: 'Y', value: 3 },
      ]);
      assert(!stale.ok && (stale.refused?.[0].reason.includes('read-before-write') ?? false), 'stale DLY Y must refuse');
      const mtd = applyDiscreteSelectsToImage(image, [
        { blockWireId: 114, paramName: 'effect_type', channel: 'Y', value: 3 },
      ]);
      assert(!mtd.ok && (mtd.refused?.[0].reason.includes('NOT an X/Y param mirror') ?? false), 'MTD Y must refuse outright');
    },
  },
  {
    name: 'discrete: dump-level patch recomputes the footer and re-verifies',
    run: () => {
      const image = buildSyntheticImage();
      const bytes = buildSyntheticDump(image);
      const result = applyDiscreteSelectsToDump(bytes, [
        { blockWireId: 106, paramName: 'effect_type', channel: 'X', value: 'BRIT JM45' },
      ]);
      assert(result.ok, `dump patch refused: ${result.ok ? '' : result.reason}`);
      if (result.ok) {
        const frames = parseIIPresetDumpFrames(result.patchedBytes);
        assert(verifyImageRoundTrip(frames).ok, 'patched dump fails its own round trip');
      }
    },
  },
  {
    name: 'scene words: bit semantics + RMW encode',
    run: () => {
      const decoded = decodeSceneStateWord(0x0803);
      assert(decoded[0].bypassed && decoded[1].bypassed && !decoded[2].bypassed, 'bypass bits');
      assert(decoded[3].channelY && !decoded[0].channelY, 'Y bit scene 4');
      let w = 0;
      w = encodeSceneStateWord(w, { blockWireId: 0, scene: 1, bypassed: true });
      w = encodeSceneStateWord(w, { blockWireId: 0, scene: 4, channelY: true });
      assert(w === 0x0801, `encode got 0x${w.toString(16)}`);
      w = encodeSceneStateWord(w, { blockWireId: 0, scene: 1, bypassed: false });
      assert(w === 0x0800, 'clear direction');
    },
  },
  {
    name: 'scene words: apply + refusals (unlocated family, single-channel Y, unplaced)',
    run: () => {
      const image = buildSyntheticImage();
      const tlv = parseIIImageTlv(image.words);
      const amp = findIIImageBlock(tlv, 106)!;
      const ok = applySceneStateToImage(image, [
        { blockWireId: 106, scene: 2, bypassed: true },
        { blockWireId: 106, scene: 6, channelY: true },
      ]);
      assert(ok.ok, `scene apply refused: ${ok.ok ? '' : ok.reason}`);
      if (ok.ok) {
        const wordIndex = sceneStateWordIndex(amp)!;
        assert(ok.applied.every((a) => a.wordIndex === wordIndex), 'scene word address');
        assert(ok.image.words[wordIndex] === ((1 << 1) | (1 << 13)), 'scene bits');
        // byte-2 bypass mirror (scenes 1..5): bypass bit 1 mirrors at 0x04 << 1
        assert(ok.image.reserved[wordIndex] === 0x08, `mirror 0x${ok.image.reserved[wordIndex].toString(16)}`);
        assert(ok.applied[1].note?.includes('pattern-extrapolated') ?? false, 'scenes 5..8 Y note');
      }
      const refusals = applySceneStateToImage(image, [
        { blockWireId: 156, scene: 1, bypassed: true }, // Quad Chorus: no bypass pid
        { blockWireId: 127, scene: 1, channelY: true }, // VolPan: single-channel
        { blockWireId: 133, scene: 1, bypassed: true }, // Drive: not placed
      ]);
      assert(!refusals.ok, 'all three must refuse');
      if (!refusals.ok) {
        const reasons = (refusals.refused ?? []).map((r) => r.reason);
        assert(reasons[0].includes('UNLOCATED'), `qch: ${reasons[0]}`);
        assert(reasons[1].includes('no channel Y'), `volpan: ${reasons[1]}`);
        assert(reasons[2].includes('not placed'), `drive: ${reasons[2]}`);
      }
    },
  },
  {
    name: 'scene words: dump-level apply survives round trip',
    run: () => {
      const bytes = buildSyntheticDump(buildSyntheticImage());
      const result = applySceneStateToDump(bytes, [{ blockWireId: 108, scene: 3, bypassed: true }]);
      assert(result.ok, `refused: ${result.ok ? '' : result.reason}`);
      if (result.ok) {
        assert(verifyImageRoundTrip(parseIIPresetDumpFrames(result.patchedBytes)).ok, 'round trip');
      }
    },
  },
  {
    name: 'structure: remove + re-add is byte-identical (reserved bits included)',
    run: () => {
      const bytes = buildSyntheticDump(buildSyntheticImage());
      const removed = removeBlockFromDump(bytes, 118);
      assert(removed.ok, `remove refused: ${removed.ok ? '' : removed.reason}`);
      if (!removed.ok) return;
      assert(removed.shuntId === 203, `fresh shunt ${removed.shuntId}`);
      assert(removed.warnings.some((w) => w.includes('modifier slot 3')), 'dangling-modifier warning');
      const tlvAfter = parseIIImageTlv(imageFromFrames(parseIIPresetDumpFrames(removed.patchedBytes)).words);
      assert(findIIImageBlock(tlvAfter, 118) === undefined, 'flanger still in chain');
      const readd = insertBlockIntoDump(removed.patchedBytes, {
        wireId: 118,
        span: removed.removed,
        gridCell: removed.gridCell,
      });
      assert(readd.ok, `re-add refused: ${readd.ok ? '' : readd.reason}`);
      if (readd.ok) {
        // The re-added grid cell id swaps back, but the shunt id 203 that
        // replaced it is gone again, so the whole dump must be byte-identical.
        assert(bytesEqual(readd.patchedBytes, bytes), 'remove + re-add not byte-identical');
      }
    },
  },
  {
    name: 'structure: default-record insert lands at the alphabetical position',
    run: () => {
      const image = buildSyntheticImage();
      const bytes = buildSyntheticDump(image);
      const result = insertBlockIntoDump(bytes, { wireId: 122, gridCell: { col: 10, row: 2 } });
      assert(result.ok, `insert refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return;
      const tlv = parseIIImageTlv(imageFromFrames(parseIIPresetDumpFrames(result.patchedBytes)).words);
      const order = tlv.blocks.map((b) => b.wireId).join(',');
      // Phaser 1 sorts between Multi Delay 1 (114) and Quad Chorus 1 (156).
      assert(order === '106,108,112,131,118,114,122,156,110,127', `chain order ${order}`);
      const cells = parseIIGrid(tlv === undefined ? image.words : imageFromFrames(parseIIPresetDumpFrames(result.patchedBytes)).words);
      const violations = validateIIGridInvariants(cells, tlv.blocks.map((b) => b.wireId));
      assert(violations.length === 0, `grid violations after insert: ${violations.join('; ')}`);
      assert(result.warnings.some((w) => w.includes('community-beta')), 'default-record provenance warning');
      assert(DEFAULT_RECORDS[122].payloadLen === 46, 'phaser default len');
    },
  },
  {
    name: 'structure: FRESH_DEFAULT_RECORDS insert succeeds for always-tweaked families, byte-exact, HARDWARE-FRESH warning',
    run: () => {
      // 107 (Amp 2), 130 (Pitch), 133 (Drive) are unplaced in the synthetic
      // chain and previously had no default record anywhere (refused).
      for (const wireId of [107, 130, 133]) {
        const image = buildSyntheticImage();
        const bytes = buildSyntheticDump(image);
        const result = insertBlockIntoDump(bytes, { wireId, gridCell: { col: 10, row: 2 } });
        assert(result.ok, `wireId ${wireId} insert refused: ${result.ok ? '' : result.reason}`);
        if (!result.ok) continue;
        const words = imageFromFrames(parseIIPresetDumpFrames(result.patchedBytes)).words;
        const tlv = parseIIImageTlv(words);
        const block = findIIImageBlock(tlv, wireId);
        assert(block !== undefined, `wireId ${wireId} not found post-insert`);
        const fresh = FRESH_DEFAULT_RECORDS[wireId];
        assert(fresh !== undefined, `wireId ${wireId} missing from FRESH_DEFAULT_RECORDS`);
        if (block !== undefined) {
          const payload = Array.from(words.slice(block.baseWord, block.baseWord + block.payloadLen));
          assert(
            payload.length === fresh.payload.length && payload.every((v, i) => v === fresh.payload[i]),
            `wireId ${wireId} inserted payload does not match FRESH_DEFAULT_RECORDS byte-exactly`,
          );
        }
        assert(result.warnings.some((w) => w.includes('HARDWARE-FRESH')), `wireId ${wireId} missing HARDWARE-FRESH provenance warning`);
        const cells = parseIIGrid(words);
        const violations = validateIIGridInvariants(cells, tlv.blocks.map((b) => b.wireId));
        assert(violations.length === 0, `wireId ${wireId} grid violations after insert: ${violations.join('; ')}`);
      }
    },
  },
  {
    name: 'structure: refusals (tone-match preset, tail block, non-shunt cell, no default)',
    run: () => {
      const image = buildSyntheticImage();
      const bytes = buildSyntheticDump(image);
      // tone-match refusal: place 170 into a copy's chain
      const tm = copyImage(image);
      const tlv = parseIIImageTlv(tm.words);
      const term = tlv.terminatorWord;
      tm.words[term] = 170;
      tm.words[term + 1] = 4;
      const tmCell = gridCellWordIndex(10, 2);
      tm.words[tmCell] = 170; // replace shunt 200 so the multiset stays intact
      const tmBytes = buildSyntheticDump(tm);
      const r1 = removeBlockFromDump(tmBytes, 118);
      assert(!r1.ok && r1.reason.includes('Tone Match'), 'tone-match remove must refuse');
      const r2 = removeBlockFromDump(bytes, 140);
      assert(!r2.ok && r2.reason.includes('tail'), 'tail remove must refuse');
      const r3 = insertBlockIntoDump(bytes, { wireId: 122, gridCell: { col: 1, row: 2 } });
      assert(!r3.ok && r3.reason.includes('not a shunt'), 'non-shunt cell must refuse');
      const r4 = insertBlockIntoDump(bytes, { wireId: 144, gridCell: { col: 10, row: 2 } });
      assert(!r4.ok && r4.reason.includes('no corpus-derivable or') && r4.reason.includes('default record'), 'insert with no default record anywhere must refuse without donor');
    },
  },
  {
    name: 'compose: leaves correctly-placed blocks untouched, removes unwanted, inserts new via FRESH_DEFAULT_RECORDS',
    run: () => {
      const image = buildSyntheticImage();
      // Keep 106/108/112/131 exactly where they are; drop 118/114/156/110/127;
      // insert 133 (Drive, FRESH_DEFAULT_RECORDS) at (7,2), vacated by 156.
      const result = composeImageChain(image, [
        { wireId: 106, gridCell: { col: 1, row: 2 } },
        { wireId: 108, gridCell: { col: 2, row: 2 } },
        { wireId: 112, gridCell: { col: 3, row: 2 } },
        { wireId: 131, gridCell: { col: 4, row: 2 } },
        { wireId: 133, gridCell: { col: 7, row: 2 } },
      ]);
      assert(result.ok, `compose refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return;
      assert(
        result.unchanged.length === 4 && [106, 108, 112, 131].every((id) => result.unchanged.includes(id)),
        `unchanged should be exactly [106,108,112,131], got [${result.unchanged.join(',')}]`,
      );
      assert(
        result.removed.length === 5 && [118, 114, 156, 110, 127].every((id) => result.removed.includes(id)),
        `removed should be exactly [118,114,156,110,127], got [${result.removed.join(',')}]`,
      );
      assert(result.inserted.length === 1 && result.inserted[0] === 133, `inserted should be [133], got [${result.inserted.join(',')}]`);

      const tlv = parseIIImageTlv(result.image.words);
      // Untouched blocks must retain their EXACT prior payload (compose must
      // not reset an already-correct block to its default).
      for (const id of [106, 108, 112, 131]) {
        const before = findIIImageBlock(parseIIImageTlv(image.words), id)!;
        const after = findIIImageBlock(tlv, id)!;
        const beforePayload = Array.from(image.words.slice(before.baseWord, before.baseWord + before.payloadLen));
        const afterPayload = Array.from(result.image.words.slice(after.baseWord, after.baseWord + after.payloadLen));
        assert(
          beforePayload.length === afterPayload.length && beforePayload.every((v, i) => v === afterPayload[i]),
          `unchanged wireId ${id} payload drifted through compose`,
        );
      }
      const drive = findIIImageBlock(tlv, 133);
      assert(drive !== undefined, 'wireId 133 not found post-compose');
      if (drive !== undefined) {
        const payload = Array.from(result.image.words.slice(drive.baseWord, drive.baseWord + drive.payloadLen));
        const fresh = FRESH_DEFAULT_RECORDS[133];
        assert(
          payload.length === fresh.payload.length && payload.every((v, i) => v === fresh.payload[i]),
          'inserted wireId 133 payload does not match FRESH_DEFAULT_RECORDS byte-exactly',
        );
      }
      for (const id of [118, 114, 156, 110, 127]) {
        assert(findIIImageBlock(tlv, id) === undefined, `removed wireId ${id} still present in chain`);
      }
      const cells = parseIIGrid(result.image.words);
      const violations = validateIIGridInvariants(cells, tlv.blocks.map((b) => b.wireId));
      assert(violations.length === 0, `grid violations after compose: ${violations.join('; ')}`);
    },
  },
  {
    name: 'compose: targeting the exact current chain is a no-op (byte-identical image, nothing removed or inserted)',
    run: () => {
      const image = buildSyntheticImage();
      const targets = [106, 108, 112, 131, 118, 114, 156, 110, 127].map((wireId, i) => ({
        wireId,
        gridCell: { col: i + 1, row: 2 },
      }));
      const result = composeImageChain(image, targets);
      assert(result.ok, `compose refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return;
      assert(result.removed.length === 0, `expected zero removals, got [${result.removed.join(',')}]`);
      assert(result.inserted.length === 0, `expected zero insertions, got [${result.inserted.join(',')}]`);
      assert(result.unchanged.length === 9, `expected all 9 unchanged, got ${result.unchanged.length}`);
      assert(
        image.words.length === result.image.words.length && image.words.every((v, i) => v === result.image.words[i]),
        'no-op compose must be byte-identical to the source image',
      );
    },
  },
  {
    name: 'compose: refusals (duplicate cell, duplicate wireId, tail-resident target)',
    run: () => {
      const image = buildSyntheticImage();
      const r1 = composeImageChain(image, [
        { wireId: 133, gridCell: { col: 10, row: 2 } },
        { wireId: 107, gridCell: { col: 10, row: 2 } },
      ]);
      assert(!r1.ok && r1.reason.includes('both name grid cell'), 'duplicate target cell must refuse');
      const r2 = composeImageChain(image, [
        { wireId: 133, gridCell: { col: 10, row: 2 } },
        { wireId: 133, gridCell: { col: 11, row: 2 } },
      ]);
      assert(!r2.ok && r2.reason.includes('more than once'), 'duplicate target wireId must refuse');
      const r3 = composeImageChain(image, [{ wireId: 140, gridCell: { col: 10, row: 2 } }]);
      assert(!r3.ok && r3.reason.includes('tail-resident'), 'tail-resident target must refuse');
    },
  },
  {
    name: 'planIILiveComposeOps: same-cell replace collapses to ONE write (no clear-then-place), untouched cells get zero ops',
    run: () => {
      const image = buildSyntheticImage();
      const cells = parseIIGrid(image.words);
      // Same target set as the composeImageChain golden above: keep
      // 106/108/112/131, drop 118/114/156/110/127, insert 133 at (7,2)
      // (156's own prior cell) — this is the AxeEdit "type replace" shape.
      const result = planIILiveComposeOps(cells, [
        { wireId: 106, gridCell: { col: 1, row: 2 } },
        { wireId: 108, gridCell: { col: 2, row: 2 } },
        { wireId: 112, gridCell: { col: 3, row: 2 } },
        { wireId: 131, gridCell: { col: 4, row: 2 } },
        { wireId: 133, gridCell: { col: 7, row: 2 } },
      ]);
      assert(result.ok, `plan refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return;
      assert(
        result.unchanged.length === 4 && [106, 108, 112, 131].every((id) => result.unchanged.includes(id)),
        `unchanged should be [106,108,112,131], got [${result.unchanged.join(',')}]`,
      );
      assert(
        result.removed.length === 5 && [118, 114, 156, 110, 127].every((id) => result.removed.includes(id)),
        `removed should be [118,114,156,110,127], got [${result.removed.join(',')}]`,
      );
      assert(result.inserted.length === 1 && result.inserted[0] === 133, `inserted should be [133], got [${result.inserted.join(',')}]`);
      // The AxeEdit-fidelity assertion: 156 and 133 share cell (7,2), so
      // this must be exactly ONE write (blockId 133), never a clear-to-0
      // followed by a separate place. Total ops = 4 clears (118/114/110/127,
      // at cols 5/6/8/9) + 1 set (133 at col 7) = 5, not 6.
      assert(result.ops.length === 5, `expected exactly 5 live ops, got ${result.ops.length}: ${JSON.stringify(result.ops)}`);
      const col7Ops = result.ops.filter((op) => op.col === 7 && op.row === 2);
      assert(col7Ops.length === 1 && col7Ops[0].blockId === 133, `cell (7,2) must get exactly one write (blockId 133), got ${JSON.stringify(col7Ops)}`);
      for (const col of [5, 6, 8, 9]) {
        const op = result.ops.find((o) => o.col === col && o.row === 2);
        assert(op !== undefined && op.blockId === 0, `col ${col} row 2 must get a blockId=0 clear write, got ${JSON.stringify(op)}`);
      }
      for (const col of [1, 2, 3, 4]) {
        assert(result.ops.every((o) => !(o.col === col && o.row === 2)), `unchanged cell col ${col} row 2 must get zero ops`);
      }
    },
  },
  {
    name: 'planIILiveComposeOps: targeting the exact current chain emits zero ops',
    run: () => {
      const image = buildSyntheticImage();
      const cells = parseIIGrid(image.words);
      const targets = [106, 108, 112, 131, 118, 114, 156, 110, 127].map((wireId, i) => ({
        wireId,
        gridCell: { col: i + 1, row: 2 },
      }));
      const result = planIILiveComposeOps(cells, targets);
      assert(result.ok, `plan refused: ${result.ok ? '' : result.reason}`);
      if (!result.ok) return;
      assert(result.ops.length === 0, `no-op compose must emit zero live ops, got ${result.ops.length}`);
      assert(result.unchanged.length === 9, `expected all 9 unchanged, got ${result.unchanged.length}`);
    },
  },
  {
    name: 'planIILiveComposeOps: refuses a target on a currently-empty cell (never-wired territory)',
    run: () => {
      const image = buildSyntheticImage();
      const cells = parseIIGrid(image.words);
      // Row 1 col 1 is empty (id 0) in the synthetic image — only row 2
      // carries content. This planner must refuse rather than guess
      // whether fresh fn 0x06 routing is needed there.
      const result = planIILiveComposeOps(cells, [{ wireId: 133, gridCell: { col: 1, row: 1 } }]);
      assert(!result.ok, 'targeting a currently-empty cell must refuse');
      if (result.ok) return;
      assert(result.reason.includes('currently-EMPTY'), `refusal reason should cite the empty-cell gap, got: ${result.reason}`);
    },
  },
  {
    name: 'planIILiveComposeOps: shares composeImageChain\'s all-or-nothing target validation (duplicate cell, duplicate wireId, tail-resident)',
    run: () => {
      const image = buildSyntheticImage();
      const cells = parseIIGrid(image.words);
      const r1 = planIILiveComposeOps(cells, [
        { wireId: 133, gridCell: { col: 10, row: 2 } },
        { wireId: 107, gridCell: { col: 10, row: 2 } },
      ]);
      assert(!r1.ok && r1.reason.includes('both name grid cell'), 'duplicate target cell must refuse');
      const r2 = planIILiveComposeOps(cells, [
        { wireId: 133, gridCell: { col: 10, row: 2 } },
        { wireId: 133, gridCell: { col: 11, row: 2 } },
      ]);
      assert(!r2.ok && r2.reason.includes('more than once'), 'duplicate target wireId must refuse');
      const r3 = planIILiveComposeOps(cells, [{ wireId: 140, gridCell: { col: 10, row: 2 } }]);
      assert(!r3.ok && r3.reason.includes('tail-resident'), 'tail-resident target must refuse');
    },
  },
];

export function runAxeFxIIPresetImageTests(): void {
  for (const c of cases) c.run();
}

export const AXEFX2_PRESET_IMAGE_CASE_COUNT = cases.length;
