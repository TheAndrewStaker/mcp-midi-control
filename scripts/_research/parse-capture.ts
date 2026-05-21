/**
 * mcp-midi-control — USB Capture Parser
 *
 * Reads a `tshark -V -Y sysex` text dump of a USBPcap capture and extracts
 * every reassembled AM4 SysEx message with direction and timestamp. Used
 * to reverse-engineer AM4-Edit's undocumented `0x01` parameter-set command
 * from captures where the user performed a single deliberate action.
 *
 * Pipeline:
 *   1. Capture USB traffic with Wireshark + USBPcap (AM4 on USBPcap2).
 *   2. `tshark -r file.pcapng -Y sysex -V > file.tshark.txt`
 *   3. `npx tsx scripts/parse-capture.ts file.tshark.txt`
 *
 * Output: a table of OUT-direction SysEx messages grouped by 10-byte body
 * so reads (repeating poll pattern) separate from writes (rare, distinct).
 */
import fs from 'fs';

const [, , file] = process.argv;
if (!file) {
  console.error('Usage: tsx scripts/parse-capture.ts <file.tshark.txt>');
  process.exit(1);
}

type Record = {
  frame: number;
  time: number;
  direction: 'IN' | 'OUT';
  endpoint: string;
  hex: string;
};

const text = fs.readFileSync(file, 'utf8');
const lines = text.split(/\r?\n/);

const records: Record[] = [];
let cur: Partial<Record> | undefined;

const frameRe = /^Frame (\d+):/;
const timeRe = /Time since reference or first frame:\s+([\d.]+)\s+seconds/;
const endpointRe = /Endpoint:\s+(0x[0-9a-f]+),\s+Direction:\s+(IN|OUT)/;
const reassembledRe = /\[Reassembled data:\s+([0-9a-f]+)\]/;

for (const line of lines) {
  const m = line.match(frameRe);
  if (m) {
    if (cur?.frame && cur.hex && cur.direction) {
      records.push(cur as Record);
    }
    cur = { frame: Number(m[1]) };
    continue;
  }
  if (!cur) continue;
  const t = line.match(timeRe);
  if (t) cur.time = Number(t[1]);
  const e = line.match(endpointRe);
  if (e) {
    cur.endpoint = e[1];
    cur.direction = e[2] as 'IN' | 'OUT';
  }
  const r = line.match(reassembledRe);
  if (r) cur.hex = r[1];
}
if (cur?.frame && cur.hex && cur.direction) records.push(cur as Record);

console.log(`Parsed ${records.length} SysEx messages.\n`);

const out = records.filter((r) => r.direction === 'OUT');
const inp = records.filter((r) => r.direction === 'IN');
console.log(`  OUT (host → AM4): ${out.length}`);
console.log(`  IN  (AM4 → host): ${inp.length}\n`);

const am4Envelope = 'f000017415';
const stripped = out.map((r) => {
  if (!r.hex.startsWith(am4Envelope)) return { ...r, body: r.hex };
  const body = r.hex.slice(am4Envelope.length, r.hex.length - 2 - 2);
  return { ...r, body };
});

console.log('OUT SysEx length distribution:');
const outByLen = new Map<number, Record[]>();
for (const r of out) {
  const list = outByLen.get(r.hex.length) ?? [];
  list.push(r);
  outByLen.set(r.hex.length, list);
}
for (const [len, list] of [...outByLen.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  OUT ${len / 2} bytes: ${list.length} messages`);
  console.log(`    sample: ${list[0].hex}`);
  if (list.length > 1) console.log(`    sample: ${list[list.length - 1].hex}`);
}
console.log('IN SysEx length distribution:');
const inByLen = new Map<number, Record[]>();
for (const r of inp) {
  const list = inByLen.get(r.hex.length) ?? [];
  list.push(r);
  inByLen.set(r.hex.length, list);
}
for (const [len, list] of [...inByLen.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  IN  ${len / 2} bytes: ${list.length} messages`);
}
console.log();

const byBody = new Map<string, Record[]>();
for (const r of stripped) {
  const list = byBody.get(r.body) ?? [];
  list.push(r);
  byBody.set(r.body, list);
}

const sorted = Array.from(byBody.entries()).sort((a, b) => b[1].length - a[1].length);

console.log(`OUT unique body patterns: ${sorted.length}\n`);
console.log('Most common (likely read-poll) patterns:');
for (const [body, list] of sorted.slice(0, 8)) {
  console.log(`  [${list.length.toString().padStart(4)}×] ${body}`);
}

console.log('\nAll OUT body patterns (rarest first):');
const asc = [...sorted].reverse();
for (const [body, list] of asc) {
  const times = list.map((r) => (r.time ?? 0).toFixed(3)).slice(0, 8).join(', ');
  console.log(`  [${list.length.toString().padStart(4)}×] ${body}   @ t=[${times}]`);
}
