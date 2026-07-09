/**
 * Read-only probe: does the AM4 FIRMWARE answer fn 0x0E QUERY_STATES?
 *
 * AM4-Edit never issues fn 0x0E (cookbook
 * _negative/am4-query-states-fn0e-transfer.md — 0 frames in 21036), but the
 * firmware-level response was explicitly left open as a ~30s read-only probe.
 * This sends the single frame F0 00 01 74 15 0E <cksum> F7 and classifies the
 * reply:
 *   - SILENT (no reply in window)            -> firmware ignores fn 0x0E
 *   - fn 0x64 multipurpose / NACK            -> firmware rejects it
 *   - 0x74/0x75/0x76 state-broadcast triple  -> firmware ANSWERS (the win:
 *       would let AM4 get_preset batch per-block channel state in one read)
 *   - other                                  -> dumped for inspection
 *
 * Read-only by policy: sends only a query, never a SET / save / preset-store.
 * Run: npx tsx scripts/_research/probe-am4-fn0e.ts
 */
import midi from "@julusian/midi";

const AM4_MODEL = 0x15;
const FRACTAL_MFR = [0x00, 0x01, 0x74] as const;
const F0 = 0xf0;
const F7 = 0xf7;
const FN_QUERY_STATES = 0x0e;

function cksum(bytes: number[]): number {
  return bytes.reduce((a, b) => a ^ b, 0) & 0x7f;
}
function envelope(fn: number, payload: number[] = []): number[] {
  const head = [F0, ...FRACTAL_MFR, AM4_MODEL, fn, ...payload];
  return [...head, cksum(head), F7];
}
function findPort(io: midi.Input | midi.Output, needles: string[]): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i).toLowerCase();
    if (needles.some((n) => name.includes(n))) return i;
  }
  return -1;
}
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

async function main(): Promise<void> {
  const out = new midi.Output();
  const inp = new midi.Input();
  const oi = findPort(out, ['am4']);
  const ii = findPort(inp, ['am4']);
  if (oi < 0 || ii < 0) {
    console.error(`AM4 port not found (out=${oi}, in=${ii}).`);
    process.exit(2);
  }
  inp.ignoreTypes(false, true, true); // keep SysEx, drop timing/active-sensing
  const got: number[][] = [];
  inp.on('message', (_d, b) => {
    if (b[0] === F0) got.push(b.slice());
  });
  try {
    out.openPort(oi);
    inp.openPort(ii);
  } catch (e) {
    console.error(`openPort FAILED (port busy — is the in-session MCP server holding it?): ${e}`);
    process.exit(3);
  }

  const frame = envelope(FN_QUERY_STATES);
  console.log(`-> fn 0x0E QUERY_STATES: ${hex(frame)}`);
  out.sendMessage(frame);
  await new Promise((r) => setTimeout(r, 1500));

  inp.closePort();
  out.closePort();

  if (got.length === 0) {
    console.log('RESULT: SILENT (no SysEx reply in 1.5s). Firmware does not answer fn 0x0E.');
    return;
  }
  console.log(`RESULT: ${got.length} SysEx frame(s) received:`);
  for (const f of got) {
    const fn = f[5];
    const tag =
      fn === 0x64 ? 'fn 0x64 NACK/multipurpose'
      : fn === 0x74 ? 'fn 0x74 STATE HEADER'
      : fn === 0x75 ? 'fn 0x75 STATE CHUNK'
      : fn === 0x76 ? 'fn 0x76 STATE FOOTER'
      : `fn 0x${fn.toString(16).padStart(2, '0')}`;
    console.log(`  [${tag}] len=${f.length}: ${hex(f)}`);
    // Body = indices 6..(len-3): between fn and the cksum/F7 tail.
    const body = f.slice(6, f.length - 2);
    console.log(`     body(${body.length}): ${hex(body)}`);
    console.log(`     body ascii: ${body.map((x) => (x >= 0x20 && x < 0x7f ? String.fromCharCode(x) : '.')).join('')}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
