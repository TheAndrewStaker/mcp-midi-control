/**
 * Hydrasynth — Patch Request: working memory or flash?
 *
 * Reuses the production `connectHydrasynth()` helper to ensure the
 * MIDI port-open order (output first, input last with listener
 * pre-attached) matches what `apply_patch` does — earlier scratch
 * scripts opened ports in the wrong order and never received inbound
 * SysEx, masking the real protocol question.
 *
 * Test plan:
 *   1. Operator manually tweaks `osc3 semi` to -24 on H128 BEFORE
 *      running. (TechnoSyndrome's flash value at H128 is 0.)
 *   2. Script sends Patch Request → assembles 22 chunks → decodes
 *      byte 138 (s8 = osc3semi).
 *   3. Verdict:
 *        -24 → reads working memory → save-in-place IS feasible
 *           0 → reads flash         → save-in-place dead
 *        other → tell me, we diagnose.
 *
 * Sequence (per SysexEncoding.txt lines 156-188):
 *   ->  18 00              Header
 *   <-  19 00              Header Response
 *   ->  04 00 BANK PATCH   Patch Request (BANK=7 for H, PATCH=127 for 128)
 *   <-  16 00 NN 16 DATA   Chunk Dump   (×22)
 *   ->  17 00 NN 16        Chunk ACK    (after each)
 *   ->  1A 00              Footer
 *   <-  1B 00              Footer Response
 */
import { connectHydrasynth } from '@mcp-midi-control/hydrasynth/midi.js';

const SYSEX_PREFIX = [0xf0, 0x00, 0x20, 0x2b, 0x00, 0x6f];
const SYSEX_END = 0xf7;

const TARGET_BANK = 0x07; // H = A+7
const TARGET_PATCH = 0x7f; // 128 = 127 (0-indexed)

const TOTAL_CHUNKS = 22;
const OSC3_SEMI_BYTE = 138; // patchEncoder.ts: s8 at byte 138
const READ_TIMEOUT_MS = 8000;

function wrap(inner: number[]): number[] {
  return [...SYSEX_PREFIX, ...inner, SYSEX_END];
}

function toHex(bytes: number[], max = 32): string {
  const slice = bytes.slice(0, max).map((b) => b.toString(16).padStart(2, '0'));
  return slice.join(' ') + (bytes.length > max ? ` …(${bytes.length} total)` : '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ChunkDump {
  index: number;
  data: number[];
}

function parseChunkDump(msg: number[]): ChunkDump | null {
  if (msg.length < SYSEX_PREFIX.length + 5 + 1) return null;
  for (let i = 0; i < SYSEX_PREFIX.length; i++) {
    if (msg[i] !== SYSEX_PREFIX[i]) return null;
  }
  if (msg[msg.length - 1] !== SYSEX_END) return null;
  const inner = msg.slice(SYSEX_PREFIX.length, -1);
  if (inner[0] !== 0x16 || inner[1] !== 0x00 || inner[3] !== 0x16) return null;
  return { index: inner[2]!, data: inner.slice(4) };
}

function isInner(msg: number[], inner: number[]): boolean {
  if (msg.length !== SYSEX_PREFIX.length + inner.length + 1) return false;
  for (let i = 0; i < SYSEX_PREFIX.length; i++) {
    if (msg[i] !== SYSEX_PREFIX[i]) return false;
  }
  for (let i = 0; i < inner.length; i++) {
    if (msg[SYSEX_PREFIX.length + i] !== inner[i]) return false;
  }
  return msg[msg.length - 1] === SYSEX_END;
}

async function main(): Promise<void> {
  const conn = connectHydrasynth();
  console.log(`Connected (hasInput=${conn.hasInput})`);
  if (!conn.hasInput) {
    console.error('FAILED: no input port — Hydrasynth not exposing one or held by another app.');
    process.exit(1);
  }

  const chunks: ChunkDump[] = [];
  let sawHeaderResp = false;
  let sawFooterResp = false;
  const startMs = Date.now();
  const inboundTrace: Array<{ ms: number; bytes: number[] }> = [];

  const unsubscribe = conn.onMessage((bytes) => {
    inboundTrace.push({ ms: Date.now() - startMs, bytes: [...bytes] });

    if (isInner(bytes, [0x19, 0x00])) {
      sawHeaderResp = true;
      return;
    }
    if (isInner(bytes, [0x1b, 0x00])) {
      sawFooterResp = true;
      return;
    }
    const chunk = parseChunkDump(bytes);
    if (chunk) {
      chunks.push(chunk);
      conn.send(wrap([0x17, 0x00, chunk.index, 0x16]));
    }
  });

  await sleep(100);

  console.log('-> 18 00   Header');
  conn.send(wrap([0x18, 0x00]));
  await sleep(150);

  console.log(
    `-> 04 00 ${TARGET_BANK.toString(16).padStart(2, '0')} ${TARGET_PATCH.toString(16).padStart(2, '0')}   Patch Request (Bank H, Patch 128)`,
  );
  conn.send(wrap([0x04, 0x00, TARGET_BANK, TARGET_PATCH]));

  const deadline = Date.now() + READ_TIMEOUT_MS;
  while (chunks.length < TOTAL_CHUNKS && Date.now() < deadline) {
    await sleep(50);
  }

  console.log('-> 1A 00   Footer');
  conn.send(wrap([0x1a, 0x00]));
  await sleep(400);

  unsubscribe();
  conn.close();

  console.log();
  console.log('--- Results ---');
  console.log(`  Header Response (19 00):    ${sawHeaderResp ? 'YES' : 'NO'}`);
  console.log(`  Footer Response (1B 00):    ${sawFooterResp ? 'YES' : 'NO'}`);
  console.log(`  Chunks received:            ${chunks.length}/${TOTAL_CHUNKS}`);

  if (chunks.length === 0) {
    console.log();
    console.log('✗ No chunks received. Inbound trace:');
    for (const e of inboundTrace) {
      console.log(`    +${e.ms}ms  ${toHex(e.bytes)}`);
    }
    return;
  }

  const byIndex = new Map<number, ChunkDump>();
  for (const c of chunks) {
    if (byIndex.has(c.index)) {
      console.log(`  ⚠ duplicate chunk ${c.index}`);
    }
    byIndex.set(c.index, c);
  }
  const missing: number[] = [];
  for (let i = 0; i < TOTAL_CHUNKS; i++) {
    if (!byIndex.has(i)) missing.push(i);
  }
  if (missing.length > 0) {
    console.log(`  ⚠ missing chunks: ${missing.join(', ')}`);
  }

  const ordered = [...chunks].sort((a, b) => a.index - b.index);
  console.log(`  Chunk sizes:                ${ordered.map((c) => c.data.length).join(', ')}`);

  const buffer: number[] = [];
  for (let i = 0; i < TOTAL_CHUNKS; i++) {
    const c = byIndex.get(i);
    if (c) buffer.push(...c.data);
  }
  console.log(`  Total bytes after concat:   ${buffer.length}`);

  if (buffer.length <= OSC3_SEMI_BYTE) {
    console.log(`  ✗ buffer too short to read byte ${OSC3_SEMI_BYTE}.`);
    return;
  }

  const raw = buffer[OSC3_SEMI_BYTE]!;
  const osc3semi = raw > 127 ? raw - 256 : raw;
  console.log();
  console.log(`  Byte ${OSC3_SEMI_BYTE} (osc3semi, s8): raw=0x${raw.toString(16).padStart(2, '0')}  decoded=${osc3semi}`);

  console.log();
  console.log('--- Verdict ---');
  if (osc3semi === -24) {
    console.log('✓ osc3semi = -24 — Patch Request returned WORKING MEMORY.');
    console.log('  Save-in-place via read-modify-write is FEASIBLE.');
  } else if (osc3semi === 0) {
    console.log('✗ osc3semi = 0 — Patch Request returned the FLASH copy.');
    console.log('  Save-in-place via read-modify-write is NOT feasible.');
    console.log('  Fall back to Option C: document apply_patch+save as recipe-only.');
  } else {
    console.log(`? osc3semi = ${osc3semi} — neither -24 nor 0. Either the manual`);
    console.log('  tweak wasn\'t applied (re-do step 1 and try again) or the buffer');
    console.log('  layout differs from PATCH_OFFSETS. Tell me the value seen.');
  }

  const nameBytes = buffer.slice(9, 23);
  const name = nameBytes
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·'))
    .join('')
    .replace(/\0+$/, '')
    .trim();
  console.log(`  Patch name (bytes 9..22):   ${JSON.stringify(name)}`);
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
