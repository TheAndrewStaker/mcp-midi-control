/**
 * AM4 fn 0x01 action=0x1F bulk name-table read probe (READ-ONLY)
 * =============================================================
 * The 238-byte reply was decoded offline (preset + 4 scene names) but the
 * REQUEST shape was never isolated (passive captures are device-side only).
 * This tries a few candidate read-request encodings for action=0x1F,
 * pidLow=0xCE, pidHigh=0, finds which elicits the reply, reproduces the
 * name decode live, then probes non-zero pidHigh for a per-block/scene
 * snapshot. Read-only (action=0x1F is a READ); no writes.
 */
import midi from "@julusian/midi";
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

const MODEL = 0x15, MFR = [0x00, 0x01, 0x74], F0 = 0xf0, F7 = 0xf7;
const cks = (b: number[]) => b.reduce((a, x) => a ^ x, 0) & 0x7f;
const env = (payload: number[]) => { const h = [F0, ...MFR, MODEL, 0x01, ...payload]; return [...h, cks(h), F7]; };
const e14 = (n: number): number[] => [n & 0x7f, (n >> 7) & 0x7f];
const hex = (b: readonly number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const find = (io: midi.Input | midi.Output, ns: string[]) => { for (let i = 0; i < io.getPortCount(); i++) if (ns.some((n) => io.getPortName(i).toLowerCase().includes(n))) return i; return -1; };

// MSB-first 8-to-7 bitstream unpack (verified offline)
function unpackMSB(septets: number[]): number[] {
  const out: number[] = []; let acc = 0, bits = 0;
  for (const s of septets) { acc = (acc << 7) | (s & 0x7f); bits += 7; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
  return out;
}
const ascii = (b: number[]) => b.map((c) => (c >= 0x20 && c < 0x7f) ? String.fromCharCode(c) : '.').join('');

function decodeReply(frame: number[]): { raw: number[]; names: string[] } | undefined {
  if (frame.length < 30) return undefined;
  const septets = frame.slice(16, frame.length - 2); // strip 16B header + cks + F7
  const raw = unpackMSB(septets);
  const names = [0x10, 0x30, 0x50, 0x70, 0x90].map((o) => ascii(raw.slice(o, o + 32)).replace(/\.+$/, '').trim());
  return { raw, names };
}

async function main() {
  const out = new midi.Output(), inp = new midi.Input();
  const oi = find(out, ['am4 midi out', 'am4']);
  const ii = find(inp, ['am4 midi in', 'am4']);
  console.log('Output ports:'); for (let i = 0; i < out.getPortCount(); i++) console.log(`  [${i}] ${out.getPortName(i)}`);
  if (oi < 0 || ii < 0) { console.error('AM4 port not found'); process.exit(1); }
  console.log(`matched OUT[${oi}]=${out.getPortName(oi)} IN[${ii}]=${inp.getPortName(ii)}`);
  out.openPort(oi); inp.ignoreTypes(false, true, true);
  const got: number[][] = []; inp.on('message', (_d, b) => { if (b[0] === F0) got.push(b.slice()); }); inp.openPort(ii);
  await sleep(300);

  const ask = async (frame: number[], ms = 1000): Promise<number[][]> => {
    const before = got.length; out.sendMessage(frame); await sleep(ms);
    return got.slice(before).filter((f) => f[4] === MODEL);
  };

  const W: string[] = [`# AM4 fn 0x01 action=0x1F bulk read probe`, `> ${new Date().toISOString()}`, ''];

  // Candidate request encodings for action=0x1F, pidLow=0xCE, pidHigh=0
  const candidates: { label: string; payload: number[] }[] = [
    { label: 'A: header-mirror w/ hdr4=192', payload: [...e14(0xce), ...e14(0), 0x1f, 0x00, 0x00, 0x00, 0x40, 0x01] },
    { label: 'B: read-request read_type=1F + 4 zeros', payload: [...e14(0xce), ...e14(0), 0x1f, 0x00, 0x00, 0x00, 0x00] },
    { label: 'C: read_type 1 byte + 4 zeros', payload: [...e14(0xce), ...e14(0), 0x1f, 0x00, 0x00, 0x00] },
  ];

  let working: number[] | undefined;
  for (const c of candidates) {
    const frame = env(c.payload);
    const inbound = await ask(frame, 1000);
    const big = inbound.find((f) => f.length >= 100);
    console.log(`\n-- ${c.label} --\n   SEND ${hex(frame)}\n   ${inbound.length} reply frame(s); sizes ${inbound.map((f) => f.length).join(',')}`);
    W.push(`## ${c.label}`, `SEND \`${hex(frame)}\``, `replies: ${inbound.map((f) => f.length + 'B').join(', ') || 'none'}`, '');
    if (big) {
      const dec = decodeReply(big);
      console.log(`   reply ${big.length}B; names: ${dec?.names.join(' | ')}`);
      W.push(`reply ${big.length}B names: **${dec?.names.join(' | ')}**`, '');
      if (!working) working = c.payload;
    }
  }

  if (!working) {
    console.log('\nNo candidate elicited a bulk reply. AM4 action=0x1F request shape still unknown; needs an AM4-Edit capture.');
    W.push('## verdict', 'No candidate elicited a bulk reply; request shape needs an AM4-Edit OUT capture.', '');
  } else {
    // probe non-zero pidHigh with the working request template
    console.log('\n== non-zero pidHigh sweep (working request template) ==');
    W.push('## non-zero pidHigh sweep', '');
    const tmplTail = working.slice(4); // bytes after pidLow+pidHigh
    for (const ph of [1, 2, 3, 4]) {
      const frame = env([...e14(0xce), ...e14(ph), ...tmplTail]);
      const inbound = await ask(frame, 800);
      const big = inbound.find((f) => f.length >= 60);
      const dec = big ? decodeReply(big) : undefined;
      console.log(`   pidHigh=${ph}: replies ${inbound.map((f) => f.length).join(',') || 'none'}${dec ? ` names=${dec.names.join('|')}` : ''}`);
      W.push(`pidHigh=${ph}: ${inbound.map((f) => f.length + 'B').join(', ') || 'none'}${dec ? ` names: ${dec.names.join(' | ')}` : ''}`);
    }
  }

  mkdirSync('samples/captured', { recursive: true });
  const raw = ([] as number[]).concat(...got);
  writeFileSync(path.resolve('samples/captured/probe-am4-ce-snapshot.syx'), Uint8Array.from(raw));
  writeFileSync(path.resolve('samples/captured/probe-am4-ce-snapshot.md'), W.join('\n'));
  console.log('\nSaved samples/captured/probe-am4-ce-snapshot.{syx,md}');
  inp.closePort(); out.closePort(); process.exit(0);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
