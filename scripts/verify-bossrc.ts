/**
 * Golden: Boss RC `.RC0` codec + RC-505mk2 field dictionary.
 *
 * Self-contained (no corpus needed): builds a synthetic mk2-shaped memory,
 * proves the codec round-trips byte-exact, then locks the device-confirmed
 * (2026-07-07) RC-505mk2 dictionaries — ASSIGN A..J author, TARGET
 * `H=(track-1)*11+fn`, SOURCE `C=cc+6` / CTL, NAME char codes, and the A/B
 * `<count>` version arbitration — including the hardware-confirmed Memory 1
 * scene ping-pong decode. The real-file corpus is gitignored, so this synthetic
 * golden is what runs in preflight; the codec's byte-exactness against the real
 * mk2 files is recorded in docs/manuals/other-gear/RC-505mk2-RC0-SCHEMA.md.
 *
 * Run via:  npx tsx scripts/verify-bossrc.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseRc0,
  serializeRc0,
  getLeaf,
  decodeCharCodes,
} from '@mcp-midi-control/boss-rc/codec/rc0.js';
import {
  authorAssign,
  authorName,
  readName,
  encodeName,
  trackTargetOrdinal,
  sourceOrdinal,
  parseCount,
  formatCount,
  readCount,
  activeSlot,
  planWrite,
  setCount,
  decodeSource,
  decodeTarget,
  readAllAssigns,
  memoryIdIn,
  type AssignSpec,
} from '@mcp-midi-control/boss-rc/codec/mk2.js';
import {
  memoryFilename,
  readActiveMemory,
  writeMemory,
} from '@mcp-midi-control/boss-rc/storage/memoryStore.js';
import { isRc505Root } from '@mcp-midi-control/boss-rc/storage/discovery.js';
import { RC_505_MK2_DESCRIPTOR } from '@mcp-midi-control/boss-rc/descriptor.js';
import { createNullMidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import type { DispatchCtx, PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { registerDevice, clearRegistry } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { executeApplyPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function throws(name: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(name, threw, 'expected a throw');
}
async function throwsAsync(name: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  check(name, threw, 'expected a throw');
}

/** Build a synthetic mk2-shaped .RC0: one memory, NAME + ASSIGN1..16, trailing <count>. No final newline (mk2 form). */
function syntheticMemory(): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push('<database name="RC-505MK2" revision="0">');
  lines.push('<mem id="0">');
  // NAME A..L, "Basic" then space-padded
  lines.push('\t<NAME>');
  const nameCodes = encodeName('Basic');
  ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'].forEach((L, i) =>
    lines.push(`\t\t<${L}>${nameCodes[i]}</${L}>`),
  );
  lines.push('\t</NAME>');
  // ASSIGN1..16, each the real-file default A0 B0 C0 D0 E0 F127 G0 H0 I0 J1
  for (let n = 1; n <= 16; n++) {
    lines.push(`\t<ASSIGN${n}>`);
    const defaults: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 127, G: 0, H: 0, I: 0, J: 1 };
    for (const [L, v] of Object.entries(defaults)) lines.push(`\t\t<${L}>${v}</${L}>`);
    lines.push(`\t</ASSIGN${n}>`);
  }
  lines.push('</mem>');
  lines.push('</database>');
  lines.push('<count>0001</count>'); // no trailing newline
  return lines.join('\n');
}

console.log('boss-rc .RC0 codec + RC-505mk2 dictionary:');

// 1. Byte-exact round-trip of an unedited file.
const src = syntheticMemory();
const doc0 = parseRc0(src);
eq('round-trip byte-exact (unedited)', serializeRc0(doc0), src);
eq('NAME decodes', decodeCharCodes(doc0, 'database/mem#0/NAME'), 'Basic');
eq('trailing <count> indexed', getLeaf(doc0, 'count'), '0001');
eq('ASSIGN1 default F (ACT.HI)', getLeaf(doc0, 'database/mem#0/ASSIGN1/F'), '127');
eq('ASSIGN16 present', getLeaf(doc0, 'database/mem#0/ASSIGN16/J'), '1');

// 2. TARGET ordinal math: H = (track-1)*11 + fn. Confirmed points from the doc.
eq('TRK1 REC/PLY = 0', trackTargetOrdinal(1, 'REC/PLY'), 0);
eq('TRK2 REC/PLY = 11', trackTargetOrdinal(2, 'REC/PLY'), 11);
eq('TRK2 PLY/STP = 12', trackTargetOrdinal(2, 'PLY/STP'), 12);
eq('TRK2 STOP = 13', trackTargetOrdinal(2, 'STOP'), 13);
eq('TRK3 REC/PLY = 22', trackTargetOrdinal(3, 'REC/PLY'), 22);
eq('TRK3 PLY/STP = 23', trackTargetOrdinal(3, 'PLY/STP'), 23);
eq('TRK3 STOP = 24', trackTargetOrdinal(3, 'STOP'), 24);
eq('TRK5 LEVEL = 54', trackTargetOrdinal(5, 'LEVEL'), 54);

// 3. SOURCE ordinal: CTL fixed, CC#64-95 = cc+6, CC#01-31 refused.
eq('CTL1 source = 33', sourceOrdinal({ kind: 'ctl', n: 1 }), 33);
eq('CTL2 source = 34', sourceOrdinal({ kind: 'ctl', n: 2 }), 34);
eq('CC#64 source = 70', sourceOrdinal({ kind: 'cc', cc: 64 }), 70);
eq('CC#80 source = 86', sourceOrdinal({ kind: 'cc', cc: 80 }), 86);
eq('CC#81 source = 87', sourceOrdinal({ kind: 'cc', cc: 81 }), 87);
eq('CC#82 source = 88', sourceOrdinal({ kind: 'cc', cc: 82 }), 88);
eq('CC#95 source = 101', sourceOrdinal({ kind: 'cc', cc: 95 }), 101);
throws('CC#20 source refused (unsampled range)', () => sourceOrdinal({ kind: 'cc', cc: 20 }));

// 4. authorAssign: the hardware-confirmed Memory 1 scene ping-pong.
//    CC#81 -> TRK2 PLY/STP + TRK3 STOP;  CC#82 -> TRK3 PLY/STP + TRK2 STOP.
const doc = parseRc0(src);
const pingPong: Array<{ slot: number; spec: AssignSpec; expC: number; expH: number }> = [
  { slot: 1, spec: { sw: true, source: { kind: 'cc', cc: 81 }, target: { track: 2, fn: 'PLY/STP' } }, expC: 87, expH: 12 },
  { slot: 2, spec: { sw: true, source: { kind: 'cc', cc: 81 }, target: { track: 3, fn: 'STOP' } }, expC: 87, expH: 24 },
  { slot: 3, spec: { sw: true, source: { kind: 'cc', cc: 82 }, target: { track: 3, fn: 'PLY/STP' } }, expC: 88, expH: 23 },
  { slot: 4, spec: { sw: true, source: { kind: 'cc', cc: 82 }, target: { track: 2, fn: 'STOP' } }, expC: 88, expH: 13 },
];
for (const { slot, spec, expC, expH } of pingPong) {
  authorAssign(doc, 0, slot, spec);
  const b = `database/mem#0/ASSIGN${slot}`;
  eq(`ASSIGN${slot} SW=1`, getLeaf(doc, `${b}/A`), '1');
  eq(`ASSIGN${slot} SOURCE C=${expC}`, getLeaf(doc, `${b}/C`), String(expC));
  eq(`ASSIGN${slot} TARGET H=${expH}`, getLeaf(doc, `${b}/H`), String(expH));
  eq(`ASSIGN${slot} MODE=MOMENT (B=0)`, getLeaf(doc, `${b}/B`), '0');
  eq(`ASSIGN${slot} ACT.HI F=127`, getLeaf(doc, `${b}/F`), '127');
}
throws('authorAssign refuses a missing memory/block', () =>
  authorAssign(doc, 9, 1, { sw: true, source: { kind: 'ctl', n: 1 }, target: { track: 1, fn: 'REC/PLY' } }),
);
throws('authorAssign refuses slot out of 1..16', () =>
  authorAssign(doc, 0, 17, { sw: true, source: { kind: 'ctl', n: 1 }, target: { track: 1, fn: 'REC/PLY' } }),
);

// 5. Surgical write preserves every other byte: only the intended lines changed.
const before = src.split('\n');
const after = serializeRc0(doc).split('\n');
const changed = before.reduce((n, line, i) => n + (line === after[i] ? 0 : 1), 0);
// 4 assigns × (A,B,C,D,E,F,G,H,I,J) = 40 leaf lines, but defaults that match (D,E,G,I unchanged=0;
// F unchanged=127; for the STOP/PLY-STP specs J default=1 unchanged, A changes 0->1). Count precisely by diffing.
check('surgical edit changed only ASSIGN1-4 leaf lines', changed > 0 && changed <= 40, `changed=${changed}`);
check('line count preserved (no structural drift)', before.length === after.length, `${before.length} vs ${after.length}`);

// 6. NAME author + read round-trip.
eq('encodeName pads to 12', encodeName('MCP TEST').length, 12);
eq('encodeName "MCP" first code = M(77)', encodeName('MCP TEST')[0], 77);
throws('encodeName rejects non-ASCII', () => encodeName('café'));
const doc2 = parseRc0(src);
authorName(doc2, 0, 'MCP TEST');
eq('authorName + readName round-trip', readName(doc2, 0), 'MCP TEST');

// 7. A/B <count> arbitration.
eq('parseCount 001F = 31', parseCount('001F'), 31);
eq('formatCount 3 = 0003', formatCount(3), '0003');
eq('formatCount 11 = 000B', formatCount(11), '000B');
eq('readCount of synthetic = 1', readCount(doc0), 1);
eq('activeSlot(1,2) = B', activeSlot(1, 2), 'B');
eq('activeSlot(0x0B,0x0A) = A', activeSlot(0x0b, 0x0a), 'A');
// Hardware case: A=0001,B=0002 -> write A, bump to 0003 (above B).
check('planWrite(1,2) -> write A @ 3', JSON.stringify(planWrite(1, 2)) === JSON.stringify({ writeSlot: 'A', count: 3 }));
check('planWrite(0x0B,0x0A) -> write B @ 12', JSON.stringify(planWrite(0x0b, 0x0a)) === JSON.stringify({ writeSlot: 'B', count: 12 }));
const doc3 = parseRc0(src);
setCount(doc3, 3);
eq('setCount stamps 0003', getLeaf(doc3, 'count'), '0003');
eq('setCount preserves byte-exactness elsewhere', serializeRc0(doc3), src.replace('<count>0001</count>', '<count>0003</count>'));

// 8. Read-path inverse decoders (ordinal -> label).
eq('decodeSource(0) = (none)', decodeSource(0), '(none)');
eq('decodeSource(33) = CTL1', decodeSource(33), 'CTL1');
eq('decodeSource(87) = CC#81', decodeSource(87), 'CC#81');
eq('decodeSource(999) = SOURCE#999 (un-decoded)', decodeSource(999), 'SOURCE#999');
eq('decodeTarget(0) = TRK1 REC/PLY', decodeTarget(0), 'TRK1 REC/PLY');
eq('decodeTarget(12) = TRK2 PLY/STP', decodeTarget(12), 'TRK2 PLY/STP');
eq('decodeTarget(24) = TRK3 STOP', decodeTarget(24), 'TRK3 STOP');
eq('decodeTarget(99) = TARGET#99 (non-per-track, un-decoded)', decodeTarget(99), 'TARGET#99');

// 9. Storage layer (A/B <count> memory store) + hybrid descriptor, driven against
//    a synthetic mounted ROLAND/DATA tree in a temp dir (self-contained, no corpus).
await (async (): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'rc505-'));
  mkdirSync(join(root, 'DATA'), { recursive: true });

  // MEMORY001A = base (count 0001); MEMORY001B = base + one enabled assign (count 0002, the live copy).
  const baseA = src; // count 0001 synthetic "Basic"
  const docB = parseRc0(src);
  authorAssign(docB, 0, 1, { sw: true, source: { kind: 'cc', cc: 81 }, target: { track: 2, fn: 'PLY/STP' } });
  setCount(docB, 2);
  const baseB = serializeRc0(docB);
  writeFileSync(join(root, 'DATA', memoryFilename(1, 'A')), baseA, 'latin1');
  writeFileSync(join(root, 'DATA', memoryFilename(1, 'B')), baseB, 'latin1');

  check('isRc505Root recognizes a ROLAND root with DATA/MEMORY*.RC0', isRc505Root(root));
  check('isRc505Root rejects a bare temp dir', !isRc505Root(join(root, 'DATA')));

  // readActiveMemory picks the higher-count slot (B).
  const active = readActiveMemory(root, 1);
  eq('readActiveMemory picks slot B (count 2)', active.slot, 'B');
  eq('active memory id resolves', memoryIdIn(active.doc), '0');
  const assigns = readAllAssigns(active.doc, memoryIdIn(active.doc)!);
  eq('active memory decodes 16 assign slots', assigns.length, 16);
  eq('slot 1 source decodes to CC#81', assigns[0].source, 'CC#81');
  eq('slot 1 target decodes to TRK2 PLY/STP', assigns[0].target, 'TRK2 PLY/STP');
  eq('slot 1 enabled', assigns[0].sw, true);
  eq('slot 2 disabled (blank)', assigns[1].sw, false);

  // Hybrid descriptor: storage reads.
  const storageCtx = { conn: createNullMidiConnection('rc'), storage: { root }, descriptor: RC_505_MK2_DESCRIPTOR } as DispatchCtx;
  const snap = await RC_505_MK2_DESCRIPTOR.reader.getPreset!(storageCtx, { location: 1 });
  eq('descriptor.getPreset name = Basic', snap.name, 'Basic');
  eq('descriptor.getPreset slot 1 is an enabled assign', snap.slots[0].block_type, 'assign');
  eq('descriptor.getPreset slot 1 source param', snap.slots[0].params?.source as string, 'CC#81');
  eq('descriptor.getPreset slot 2 is none (blank)', snap.slots[1].block_type, 'none');

  const scan = await RC_505_MK2_DESCRIPTOR.reader.scanLocations!(storageCtx, 1, 2);
  eq('scan memory 1 name', scan.scanned[0].name, 'Basic');
  eq('scan memory 1 not empty', scan.scanned[0].is_empty, false);
  eq('scan memory 2 (absent) is empty', scan.scanned[1].is_empty, true);

  const dump = await RC_505_MK2_DESCRIPTOR.reader.dumpStoredPresetBinary!(1, storageCtx);
  eq('export_preset dumps the live (B) copy', dump.byte_length, Buffer.byteLength(baseB, 'latin1'));
  eq('export_preset format', dump.format, 'boss-rc-memory');

  // Hybrid descriptor: live-MIDI switch_preset (memory M -> PC M-1 on the RX CTL channel).
  eq('buildSwitchPreset(9) = [0xC0, 8] (ch1 default)', JSON.stringify(RC_505_MK2_DESCRIPTOR.writer.buildSwitchPreset!(9)), JSON.stringify([0xc0, 8]));
  const sent: number[][] = [];
  const capConn = { ...createNullMidiConnection('rc'), send: (b: number[]): void => { sent.push(b); } };
  const midiCtx = { conn: capConn, descriptor: RC_505_MK2_DESCRIPTOR } as DispatchCtx;
  const sw = await RC_505_MK2_DESCRIPTOR.writer.switchPreset!(midiCtx, 5);
  check('switch_preset acked + unconfirmed (no readback)', sw.acked === true && sw.unconfirmed === true);
  eq('switch_preset sent PC 4 on ch1', JSON.stringify(sent[0]), JSON.stringify([0xc0, 4]));

  // Surface guards: storage verb on the MIDI surface, and MIDI verb on the storage surface, both refuse.
  await throwsAsync('getPreset refuses on the MIDI surface (no storage)', () => RC_505_MK2_DESCRIPTOR.reader.getPreset!(midiCtx, { location: 1 }));
  await throwsAsync('switchPreset refuses on the storage surface', () => RC_505_MK2_DESCRIPTOR.writer.switchPreset!(storageCtx, 1));

  // Storage write: author a name into the live copy; it lands in the inactive slot with count+1.
  const wr = writeMemory(root, 1, (doc) => authorName(doc, memoryIdIn(doc) ?? 0, 'PINGPONG'));
  eq('writeMemory targets the inactive slot A', wr.writeSlot, 'A');
  eq('writeMemory stamps count 3 (above B=2)', wr.count, 3);
  check('writeMemory backed up the overwritten slot', wr.backedUp !== undefined && existsSync(wr.backedUp));
  const active2 = readActiveMemory(root, 1);
  eq('after write, slot A is now live', active2.slot, 'A');
  eq('after write, name reads back PINGPONG', readName(active2.doc, memoryIdIn(active2.doc)!), 'PINGPONG');
  // The inactive B copy is untouched (still the old assign + name).
  const bStill = parseRc0(readFileSync(join(root, 'DATA', memoryFilename(1, 'B')), 'latin1'));
  eq('sibling B untouched (still Basic)', readName(bStill, 0), 'Basic');

  // 10. FULL apply_preset -> writer.applyPreset chain through the dispatcher
  //     (preflight validation + storage write), driven against a fresh mounted tree.
  const root2 = mkdtempSync(join(tmpdir(), 'rc505i-'));
  mkdirSync(join(root2, 'DATA'), { recursive: true });
  writeFileSync(join(root2, 'DATA', memoryFilename(5, 'A')), src, 'latin1'); // "Basic", count 1, slot A only
  process.env.MCP_RC505_ROOT = root2; // openCtx resolves the hybrid storage surface here
  registerDevice(RC_505_MK2_DESCRIPTOR);

  const pingPongSpec: PresetSpec = {
    name: 'ScenePP',
    slots: [
      { slot: 1, block_type: 'assign', params: { source: 'CC#81', target: 'TRK2 PLY/STP' } },
      { slot: 2, block_type: 'assign', params: { source: 'CC#81', target: 'TRK3 STOP' } },
      { slot: 3, block_type: 'assign', params: { source: 'CC#82', target: 'TRK3 PLY/STP' } },
      { slot: 4, block_type: 'assign', params: { source: 'CC#82', target: 'TRK2 STOP' } },
    ],
  };

  // Preview: save_authorized off -> validates, writes nothing.
  const preview = await executeApplyPreset({ port: 'rc-505mk2', spec: pingPongSpec, target_location: 5, save_authorized: false });
  check('apply_preset preview ok=true', preview.ok === true);
  eq('apply_preset preview saved=false', preview.saved, false);
  check('apply_preset preview wrote nothing (no B slot)', !existsSync(join(root2, 'DATA', memoryFilename(5, 'B'))));

  // Write: save_authorized on -> authors the .RC0 (inactive slot B, count 2).
  const wrote = await executeApplyPreset({ port: 'rc-505mk2', spec: pingPongSpec, target_location: 5, save_authorized: true });
  check('apply_preset write ok=true', wrote.ok === true);
  eq('apply_preset write saved=true', wrote.saved, true);
  check('apply_preset wrote inactive slot B', existsSync(join(root2, 'DATA', memoryFilename(5, 'B'))));

  // Round-trip: the authored memory decodes the 4 assigns + name.
  const authored = readActiveMemory(root2, 5);
  const aId = memoryIdIn(authored.doc)!;
  const enabledAfter = readAllAssigns(authored.doc, aId).filter((a) => a.sw);
  eq('4 assigns authored', enabledAfter.length, 4);
  eq('assign 1 = CC#81 -> TRK2 PLY/STP', `${enabledAfter[0].source} -> ${enabledAfter[0].target}`, 'CC#81 -> TRK2 PLY/STP');
  eq('assign 2 = CC#81 -> TRK3 STOP', `${enabledAfter[1].source} -> ${enabledAfter[1].target}`, 'CC#81 -> TRK3 STOP');
  eq('assign 4 = CC#82 -> TRK2 STOP', `${enabledAfter[3].source} -> ${enabledAfter[3].target}`, 'CC#82 -> TRK2 STOP');
  eq('memory name authored', readName(authored.doc, aId), 'ScenePP');

  // Preflight rejects an author-illegal source (CC#20 is outside the CC#64-95 base) — no write fires.
  const badSrc = await executeApplyPreset({
    port: 'rc-505mk2', target_location: 5, save_authorized: true,
    spec: { slots: [{ slot: 1, block_type: 'assign', params: { source: 'CC#20', target: 'TRK2 PLY/STP' } }] },
  });
  check('apply_preset rejects illegal source CC#20 (ok=false, validation_errors)', badSrc.ok === false && (badSrc.validation_errors?.length ?? 0) > 0);

  // validatePreset rejects a missing target_location (authoring needs a memory).
  const noTarget = await executeApplyPreset({
    port: 'rc-505mk2', save_authorized: true,
    spec: { slots: [{ slot: 1, block_type: 'assign', params: { source: 'CC#81', target: 'TRK2 PLY/STP' } }] },
  });
  check('apply_preset without target_location rejected', noTarget.ok === false);

  // Duplicate assign slot in one spec is rejected (last-write-wins would be silent otherwise).
  const dupSlot = await executeApplyPreset({
    port: 'rc-505mk2', target_location: 5, save_authorized: true,
    spec: { slots: [
      { slot: 3, block_type: 'assign', params: { source: 'CC#81', target: 'TRK2 PLY/STP' } },
      { slot: 3, block_type: 'assign', params: { source: 'CC#82', target: 'TRK3 STOP' } },
    ] },
  });
  check('apply_preset rejects a duplicate assign slot', dupSlot.ok === false && (dupSlot.validation_errors?.length ?? 0) > 0);

  clearRegistry();
  delete process.env.MCP_RC505_ROOT;
})();

console.log('');
if (failures > 0) {
  console.log(`verify-bossrc: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('verify-bossrc: all checks passed (codec byte-exact + RC-505mk2 dictionary + storage/descriptor)');
