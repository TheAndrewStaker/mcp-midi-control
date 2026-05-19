/**
 * Axe-Fx II 0x74/0x75/0x76 chunk decoder.
 *
 * Reads a passive-capture `.syx` file produced by
 * `scripts/capture-midi-passive.ts`, finds every Axe-Fx II state-broadcast
 * triple (function bytes 0x74 header → N×0x75 chunks → 0x76 footer), and
 * decodes the 16-bit values per the wire format documented in
 * `docs/devices/axe-fx-ii/state-broadcast-decode-research.md`.
 *
 * For each triple, prints:
 *   - target_id (matches `blockTypes.ts` effect IDs — 106 = AMP 1, etc.)
 *   - item_count (pre-announced in the header)
 *   - op_flag (01 = block edit, 00 = preset-structure edit)
 *   - decoded 16-bit value list with positions
 *   - AMP-block paramId overlay when target_id ∈ {106, 107} (AMP 1/2)
 *
 * Usage:
 *   npx tsx scripts/decode-axefx2-chunk.ts <path-to.syx> [--target=N]
 *   npx tsx scripts/decode-axefx2-chunk.ts samples/captured/session-58-knob-turn.syx
 *   npx tsx scripts/decode-axefx2-chunk.ts samples/captured/session-58-knob-turn.syx --target=106
 *
 * The optional `--target=N` filter limits output to triples for one
 * effect ID — useful when a capture contains state for several blocks
 * and you only care about one.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { KNOWN_PARAMS } from 'fractal-midi/axe-fx-ii';
import { BLOCK_BY_ID } from 'fractal-midi/axe-fx-ii';

const AXE_FX_II_PREFIX = [0xf0, 0x00, 0x01, 0x74, 0x07];

interface SysExMessage {
    readonly offset: number;
    readonly bytes: Uint8Array;
    readonly fn: number; // function byte (index 5 after the F0/manufacturer/model prefix)
}

interface HeaderInfo {
    readonly targetId: number;
    readonly itemCount: number;
    readonly opFlag: number;
}

interface DecodedTriple {
    readonly header: HeaderInfo;
    readonly chunkSizes: number[]; // item count per 0x75 chunk
    readonly values: number[]; // decoded 16-bit values, in stream order
    readonly headerMsgIdx: number; // index into the message list for cross-referencing
}

function splitSysEx(buf: Uint8Array): SysExMessage[] {
    const messages: SysExMessage[] = [];
    let i = 0;
    while (i < buf.length) {
        if (buf[i] !== 0xf0) { i++; continue; }
        const start = i;
        let end = i + 1;
        while (end < buf.length && buf[end] !== 0xf7) end++;
        if (end >= buf.length) break;
        const bytes = buf.subarray(start, end + 1);
        // Identify Axe-Fx II frames: bytes 0..4 == F0 00 01 74 07; byte 5 = fn
        if (
            bytes.length >= 7 &&
            bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x74 && bytes[4] === 0x07
        ) {
            messages.push({ offset: start, bytes, fn: bytes[5] });
        }
        i = end + 1;
    }
    return messages;
}

function decode14b(lo: number, hi: number): number {
    return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

function decode16bPacked(b0: number, b1: number, b2: number): number {
    // 3-septet packing per wiki "MIDI SysEx: obtaining parameter values":
    //   byte 0: bits 0-6
    //   byte 1: bits 7-13
    //   byte 2: bits 14-15 (in low 2 bits)
    return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}

function decodeHeader(msg: SysExMessage): HeaderInfo | null {
    // Expected layout:
    //   F0 00 01 74 07 74 [target_lo target_hi] [count_lo count_hi] [op] [cs] F7
    //   indices: 0  1  2  3  4  5    6         7        8         9         10  11  12
    if (msg.fn !== 0x74) return null;
    if (msg.bytes.length < 12) return null;
    return {
        targetId: decode14b(msg.bytes[6], msg.bytes[7]),
        itemCount: decode14b(msg.bytes[8], msg.bytes[9]),
        opFlag: msg.bytes[10],
    };
}

function decodeChunk(msg: SysExMessage): number[] {
    // F0 00 01 74 07 75 [count_lo count_hi] [N × 3 payload] [cs] F7
    if (msg.fn !== 0x75) return [];
    const itemCount = decode14b(msg.bytes[6], msg.bytes[7]);
    const values: number[] = [];
    const payloadStart = 8;
    const payloadEnd = msg.bytes.length - 2; // exclude cs + F7
    for (let i = 0; i < itemCount; i++) {
        const off = payloadStart + i * 3;
        if (off + 2 >= payloadEnd) break;
        values.push(decode16bPacked(msg.bytes[off], msg.bytes[off + 1], msg.bytes[off + 2]));
    }
    return values;
}

function findTriples(messages: SysExMessage[]): DecodedTriple[] {
    const triples: DecodedTriple[] = [];
    let i = 0;
    while (i < messages.length) {
        if (messages[i].fn !== 0x74) { i++; continue; }
        const header = decodeHeader(messages[i]);
        if (!header) { i++; continue; }
        // Walk forward collecting 0x75 chunks until 0x76 footer or non-chunk break
        const chunkSizes: number[] = [];
        const values: number[] = [];
        const headerIdx = i;
        let j = i + 1;
        while (j < messages.length && messages[j].fn === 0x75) {
            const chunkValues = decodeChunk(messages[j]);
            chunkSizes.push(chunkValues.length);
            values.push(...chunkValues);
            j++;
        }
        // Optional footer
        if (j < messages.length && messages[j].fn === 0x76) j++;
        triples.push({ header, chunkSizes, values, headerMsgIdx: headerIdx });
        i = j;
    }
    return triples;
}

type ParamDescriptor = { name: string; controlType: string; wikiName: string };

/** Build a paramId → descriptor map for a single block group's first instance. */
function buildParamMapForGroup(groupCode: string): Map<number, ParamDescriptor> {
    const map = new Map<number, ParamDescriptor>();
    for (const entry of Object.values(KNOWN_PARAMS)) {
        if (entry.groupCode !== groupCode) continue;
        map.set(entry.paramId, {
            name: entry.name,
            controlType: entry.controlType,
            wikiName: entry.wikiName,
        });
    }
    return map;
}

function classifyValue(v: number): string {
    if (v === 0) return 'zero';
    if (v === 65534) return 'MAX';
    if (v === 32767) return 'MID';
    if (v === 65535) return 'TOP';
    return '';
}

function printTriple(t: DecodedTriple, filterTarget?: number): void {
    if (filterTarget !== undefined && t.header.targetId !== filterTarget) return;
    const block = BLOCK_BY_ID[t.header.targetId];
    const blockLabel = block ? ` (${block.name}, group=${block.groupCode})` : '';

    console.log('');
    console.log('━'.repeat(78));
    console.log(`HEADER  target_id=${t.header.targetId}${blockLabel}  item_count=${t.header.itemCount}  op_flag=0x${t.header.opFlag.toString(16).padStart(2, '0')}`);
    console.log(`CHUNKS  ${t.chunkSizes.length} × 0x75  sizes=[${t.chunkSizes.join(', ')}]  decoded=${t.values.length}`);
    console.log('━'.repeat(78));

    let zeros = 0, mid = 0, max = 0, top = 0;
    for (const v of t.values) {
        if (v === 0) zeros++;
        else if (v === 32767) mid++;
        else if (v === 65534) max++;
        else if (v === 65535) top++;
    }
    console.log(`STATS   zeros=${zeros} (${((zeros / t.values.length) * 100).toFixed(0)}%)  32767=${mid}  65534=${max}  65535=${top}  other=${t.values.length - zeros - mid - max - top}`);

    const paramMap = block ? buildParamMapForGroup(block.groupCode) : undefined;
    const maxPid = paramMap ? Math.max(...paramMap.keys()) : -1;

    console.log('');
    if (paramMap) {
        console.log(`POS    VALUE    HEX     CLASS  POSITION-AS-PARAMID OVERLAY`);
    } else {
        console.log(`POS    VALUE    HEX     CLASS`);
    }
    console.log('─'.repeat(78));

    for (let i = 0; i < t.values.length; i++) {
        const v = t.values[i];
        const cls = classifyValue(v);
        const hex = v.toString(16).padStart(4, '0');
        let candidate = '';
        if (paramMap) {
            const direct = paramMap.get(i);
            if (direct) {
                candidate = `pid${i}=${direct.name}(${direct.controlType})`;
            } else if (i <= maxPid) {
                candidate = `pid${i}=<undocumented>`;
            }
        }
        console.log(`${i.toString().padStart(4, ' ')}   ${v.toString().padStart(6, ' ')}   ${hex}    ${cls.padEnd(5, ' ')}  ${candidate}`);
    }
}

// ---- Main ----

const arg = process.argv[2];
const targetArg = process.argv.find((a) => a.startsWith('--target='));
const filterTarget = targetArg ? parseInt(targetArg.split('=')[1], 10) : undefined;

if (!arg) {
    console.error('Usage: decode-axefx2-chunk <path-to.syx> [--target=N]');
    process.exit(1);
}
const absPath = path.resolve(arg);
if (!existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
}

const buf = readFileSync(absPath);
const messages = splitSysEx(buf);
const triples = findTriples(messages);

console.log(`File: ${absPath}`);
console.log(`Total Axe-Fx II SysEx messages: ${messages.length}`);
console.log(`Total 0x74/0x75/0x76 triples:    ${triples.length}`);
const fnCounts = new Map<number, number>();
for (const m of messages) fnCounts.set(m.fn, (fnCounts.get(m.fn) ?? 0) + 1);
const fnSummary = [...fnCounts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([fn, n]) => `0x${fn.toString(16).padStart(2, '0')}:${n}`)
    .join('  ');
console.log(`Function distribution: ${fnSummary}`);

if (filterTarget !== undefined) {
    console.log(`Filter: target_id == ${filterTarget}`);
}

for (const t of triples) {
    printTriple(t, filterTarget);
}
