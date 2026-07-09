/**
 * RC-505mk2 memory read/write over the mounted `ROLAND/DATA` tree, with the
 * A/B `<count>` double-buffer arbitration baked in.
 *
 * Each memory M (1..99) is stored as a redundant pair `MEMORY<MMM>A.RC0` /
 * `MEMORY<MMM>B.RC0`. The device reads whichever file of the pair has the HIGHER
 * trailing `<count>` (4-char HEX after `</database>`), and on save writes the
 * OTHER slot with count+1 so the newest copy is always the max-count file (see
 * the hardware-confirmed write path in docs/manuals/other-gear/RC-505mk2-RC0-SCHEMA.md).
 *
 * READ picks the higher-count slot. WRITE is read-modify-write of the CURRENTLY
 * ACTIVE copy: edit the active doc, stamp it count = active+1, and write it to
 * the inactive slot (which then becomes active) — mirroring the device's own
 * save so the edit shows on the next storage disconnect with no power cycle. The
 * slot being overwritten is backed up to `<file>.bak` first.
 *
 * Files are read/written byte-preserving via latin1 (names are stored as integer
 * char CODES, so there is no multibyte concern; same discipline as the codec).
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseRc0, serializeRc0, type Rc0Doc } from '../codec/rc0.js';
import { activeSlot, planWrite, readCount, setCount, type PairSlot } from '../codec/mk2.js';

/** The device-facing memory-number range on the RC-505mk2. */
export const MEMORY_MIN = 1;
export const MEMORY_MAX = 99;

/** `MEMORY<MMM><slot>.RC0` — 3-digit zero-padded, uppercase slot (device form). */
export function memoryFilename(memNum: number, slot: PairSlot): string {
  return `MEMORY${String(memNum).padStart(3, '0')}${slot}.RC0`;
}

function memoryPath(root: string, memNum: number, slot: PairSlot): string {
  return join(root, 'DATA', memoryFilename(memNum, slot));
}

/** Read one A/B file into a parsed doc + its `<count>`, or undefined if absent. */
function readSlot(root: string, memNum: number, slot: PairSlot): { doc: Rc0Doc; count: number } | undefined {
  const path = memoryPath(root, memNum, slot);
  if (!existsSync(path)) return undefined;
  const doc = parseRc0(readFileSync(path, 'latin1'));
  return { doc, count: readCount(doc) ?? 0 };
}

export interface ActiveMemory {
  /** The parsed, currently-live copy of the memory (the higher-count slot). */
  doc: Rc0Doc;
  /** Which physical slot the doc came from. */
  slot: PairSlot;
  /** That slot's `<count>`. */
  count: number;
  /** The sibling slot's `<count>`, or undefined when the sibling file is absent. */
  siblingCount?: number;
}

/**
 * Read the currently-active copy of memory `memNum` (the higher-count slot of
 * its A/B pair). Throws if neither file exists.
 */
export function readActiveMemory(root: string, memNum: number): ActiveMemory {
  const a = readSlot(root, memNum, 'A');
  const b = readSlot(root, memNum, 'B');
  if (!a && !b) {
    throw new Error(`RC-505mk2: memory ${memNum} not found (no ${memoryFilename(memNum, 'A')} / ${memoryFilename(memNum, 'B')} under ${join(root, 'DATA')}).`);
  }
  // A missing sibling reads as count -1 so the present file always wins.
  const countA = a?.count ?? -1;
  const countB = b?.count ?? -1;
  const winner = activeSlot(countA, countB);
  const chosen = winner === 'A' ? a : b;
  if (!chosen) {
    // The winner slot's file is missing; fall back to whichever exists.
    const present = a ?? b!;
    const presentSlot: PairSlot = a ? 'A' : 'B';
    return { doc: present.doc, slot: presentSlot, count: present.count };
  }
  const sibling = winner === 'A' ? b : a;
  return { doc: chosen.doc, slot: winner, count: chosen.count, siblingCount: sibling?.count };
}

export interface MemoryWriteResult {
  /** The slot that was written (the newly-active copy). */
  writeSlot: PairSlot;
  /** The `<count>` stamped on the written slot. */
  count: number;
  /** Absolute path of the file written. */
  path: string;
  /** Absolute path of the `.bak` made before overwriting, or undefined if the target slot was empty. */
  backedUp?: string;
  /** Bytes written. */
  bytes: number;
}

export interface MemoryWriteOptions {
  /** Validate + report without touching the disk. */
  dryRun?: boolean;
}

/**
 * Read-modify-write memory `memNum`: apply `mutate` to the active copy, stamp it
 * with a `<count>` one above its live sibling, and write it to the inactive slot
 * (which becomes the new active copy). The overwritten slot is backed up to
 * `<file>.bak` first. `mutate` edits the doc in place (authorAssign / authorName).
 */
export function writeMemory(
  root: string,
  memNum: number,
  mutate: (doc: Rc0Doc) => void,
  opts: MemoryWriteOptions = {},
): MemoryWriteResult {
  const a = readSlot(root, memNum, 'A');
  const b = readSlot(root, memNum, 'B');
  if (!a && !b) {
    throw new Error(`RC-505mk2: memory ${memNum} not found; cannot author a memory that is not on the device.`);
  }
  const countA = a?.count ?? -1;
  const countB = b?.count ?? -1;
  // planWrite targets the inactive slot and returns count = active + 1.
  const { writeSlot, count } = planWrite(countA, countB);
  // Edit the currently-ACTIVE copy (the higher-count doc holds the live content).
  const active = readActiveMemory(root, memNum);
  mutate(active.doc);
  setCount(active.doc, count);
  const out = serializeRc0(active.doc);
  const path = memoryPath(root, memNum, writeSlot);
  const bytes = Buffer.byteLength(out, 'latin1');
  if (opts.dryRun) {
    return { writeSlot, count, path, bytes };
  }
  let backedUp: string | undefined;
  if (existsSync(path)) {
    backedUp = `${path}.bak`;
    copyFileSync(path, backedUp);
  }
  writeFileSync(path, out, 'latin1');
  return { writeSlot, count, path, backedUp, bytes };
}
