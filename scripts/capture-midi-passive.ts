/**
 * Passive MIDI capture — device-agnostic, no virtual ports needed.
 *
 * Opens a MIDI input port as a parallel listener (shares the port with
 * any other app reading it; Windows MIDI permits shared read access on
 * most drivers) and writes every received SysEx / channel message to a
 * raw `.syx` file on disk.
 *
 * **Why this approach works** (and why we landed on it after fighting
 * loopMIDI / rtpMIDI / ipMIDI / MIDI-OX for hours during HW-085 on
 * 2026-05-10/11):
 *
 *   - Windows MIDI input ports are SHARED-readable. This script can
 *     open `AXE-FX II MIDI In` while AxeEdit is also reading it; both
 *     see the same byte stream.
 *   - No virtual MIDI driver needed → no AxeEdit port filtering, no
 *     trial limits, no driver state to recover from, no MIDI-OX UI
 *     archaeology.
 *   - Output side (host → device) would need a bridge to intercept
 *     (the editor app's writes), but the input side (device → host) is
 *     the half that carries the wire format we want to decode.
 *     Capturing device responses is enough for most protocol RE — the
 *     bytes are byte-exact, which is what we test our decoder against.
 *
 * **What this WON'T capture:**
 *
 *   - Bytes sent FROM an editor app (AxeEdit, AM4-Edit, etc.) TO the
 *     device. Windows MIDI output ports are write-only; we can't
 *     passively read them. If you need outgoing captures, you need a
 *     virtual-port bridge (loopMIDI for non-Fractal apps; ipMIDI for
 *     AxeEdit / AM4-Edit since Fractal editors filter loopMIDI). See
 *     `scripts/sniff.ts` for the pre-existing bridge-based sniffer.
 *
 * Usage:
 *
 *   # List available MIDI input ports and exit (no capture):
 *   npx tsx scripts/capture-midi-passive.ts
 *
 *   # Capture from the first port whose name contains the substring
 *   # (case-insensitive match):
 *   npx tsx scripts/capture-midi-passive.ts <port-substring> <output.syx>
 *
 *   # Convenience npm aliases — port substring is pre-baked, you only
 *   # supply the output path:
 *   npm run capture-axefx2 -- <output.syx>     # matches "axe-fx" / "axefx"
 *   npm run capture-am4 -- <output.syx>        # matches "am4"
 *   npm run capture-midi -- <port-substring> <output.syx>  # generic
 *
 * Press Ctrl+C to stop. The output file is appended-to as messages
 * arrive, so partial captures survive crashes / Ctrl+C / power loss.
 *
 * If you see "Failed to open port" — another app may be holding the
 * port with exclusive access. Quit that app, re-run this script, then
 * relaunch the app AFTER the capture script is running (Windows MIDI
 * permits multiple readers if the second reader gets in first).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import midi from "@julusian/midi";

interface PortInfo {
    index: number;
    name: string;
}

function listInputPorts(): PortInfo[] {
    const input = new midi.Input();
    const ports: PortInfo[] = [];
    try {
        for (let i = 0; i < input.getPortCount(); i++) {
            ports.push({ index: i, name: input.getPortName(i) });
        }
    } finally {
        try { input.closePort(); } catch { /* not opened */ }
    }
    return ports;
}

function findPortBySubstring(needle: string): PortInfo | null {
    const lower = needle.toLowerCase();
    for (const p of listInputPorts()) {
        if (p.name.toLowerCase().includes(lower)) return p;
    }
    return null;
}

function printUsageAndPorts(): void {
    console.error('Passive MIDI capture — saves device → host SysEx to a `.syx` file.\n');
    console.error('Usage:');
    console.error('  npx tsx scripts/capture-midi-passive.ts <port-substring> <output.syx>\n');
    console.error('Convenience aliases (port substring is pre-baked, supply only the path):');
    console.error('  npm run capture-axefx2 -- <output.syx>       # matches Axe-Fx II ports');
    console.error('  npm run capture-am4 -- <output.syx>          # matches AM4 ports');
    console.error('  npm run capture-midi -- <port-substring> <output.syx>  # generic\n');
    console.error('Examples:');
    console.error('  npm run capture-axefx2 -- samples/captured/my-axefx2.syx');
    console.error('  npx tsx scripts/capture-midi-passive.ts hydra samples/captured/foo.syx\n');
    console.error('Available MIDI input ports:');
    const ports = listInputPorts();
    if (ports.length === 0) {
        console.error('  (no MIDI input ports found — plug in your device and confirm the driver is installed)');
    } else {
        for (const p of ports) console.error(`  [${p.index}] ${p.name}`);
    }
}

const portArg = process.argv[2];
const outPathArg = process.argv[3];

if (!portArg || !outPathArg) {
    printUsageAndPorts();
    process.exit(portArg && !outPathArg ? 1 : 0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const absOut = path.isAbsolute(outPathArg)
    ? outPathArg
    : path.resolve(__dirname, '..', outPathArg);

// Refuse a directory path early — without this guard, fs.createWriteStream
// produces the cryptic "EISDIR: illegal operation on a directory, write"
// error only after the first inbound MIDI message arrives. Common cause:
// a space in the npm-run args splits the path into two argv entries
// ("samples/captured/ foo.syx" → outPathArg="samples/captured/").
if (fs.existsSync(absOut) && fs.statSync(absOut).isDirectory()) {
    console.error(`❌ Output path "${outPathArg}" is a DIRECTORY, not a file path.`);
    console.error('   You likely have a space in the path argument. Common slip:');
    console.error('     npm run capture-axefx2 -- samples/captured/ foo.syx   ← BAD (space)');
    console.error('     npm run capture-axefx2 -- samples/captured/foo.syx    ← GOOD');
    console.error('   Or for Bash with a literal space, quote it:');
    console.error('     npm run capture-axefx2 -- "samples/captured/foo.syx"');
    process.exit(1);
}
if (outPathArg.endsWith('/') || outPathArg.endsWith('\\')) {
    console.error(`❌ Output path "${outPathArg}" ends with a directory separator.`);
    console.error('   Pass a full file path (e.g. samples/captured/foo.syx), not a directory.');
    process.exit(1);
}

fs.mkdirSync(path.dirname(absOut), { recursive: true });

const port = findPortBySubstring(portArg);
if (!port) {
    console.error(`❌ No MIDI input port found whose name contains "${portArg}" (case-insensitive).`);
    console.error('\nAvailable input ports:');
    const ports = listInputPorts();
    if (ports.length === 0) {
        console.error('  (none — plug in your device and confirm the driver is installed)');
    } else {
        for (const p of ports) console.error(`  [${p.index}] ${p.name}`);
    }
    process.exit(1);
}

console.error(`✓ Found input port matching "${portArg}": [${port.index}] "${port.name}"`);

const input = new midi.Input();
const stream = fs.createWriteStream(absOut, { flags: 'a' });
// Timestamped note-on log (one JSON object per line) alongside the raw .syx, so a
// downstream analyzer can DETERMINISTICALLY measure the loop period / playback tempo
// from the real sequence — the fix for baking loop-clips at the wrong (notated vs
// rig) tempo. See scripts/_research/measure_loop.ts.
const eventsPath = absOut.replace(/\.syx$/i, '') + '.events.jsonl';
const eventsStream = fs.createWriteStream(eventsPath, { flags: 'a' });
let messageCount = 0;
let byteCount = 0;
const start = Date.now();

// Decoded summary of channel-voice traffic (the "what channel + note is this
// device transmitting" question). Channels reported 1..16 (musician convention).
const noteOnsByChannel = new Map<number, Map<number, number>>(); // ch -> note -> count
const ccByChannel = new Map<number, Set<number>>();              // ch -> set of CC#
let lastNote: { ch: number; note: number; vel: number } | undefined; // most-recent note-on, for the live line
function noteName(n: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[n % 12]}${Math.floor(n / 12) - 1}`;
}
function decode(bytes: number[]): void {
  if (bytes.length < 2) return;
  const status = bytes[0];
  if (status >= 0xf0) return; // SysEx / system — captured raw, not summarized here
  const type = status & 0xf0;
  const ch = (status & 0x0f) + 1;
  if (type === 0x90 && bytes[2] > 0) { // note on (velocity > 0)
    const perNote = noteOnsByChannel.get(ch) ?? new Map<number, number>();
    perNote.set(bytes[1], (perNote.get(bytes[1]) ?? 0) + 1);
    noteOnsByChannel.set(ch, perNote);
    lastNote = { ch, note: bytes[1], vel: bytes[2] };
  } else if (type === 0xb0) { // control change
    const set = ccByChannel.get(ch) ?? new Set<number>();
    set.add(bytes[1]);
    ccByChannel.set(ch, set);
  }
}
function printSummary(): void {
  console.error('\n── decoded channel-voice summary ───────────────────────');
  if (noteOnsByChannel.size === 0 && ccByChannel.size === 0) {
    console.error('  (no note-on or CC channel messages seen — only SysEx/clock, or nothing arrived)');
  }
  for (const ch of [...noteOnsByChannel.keys()].sort((a, b) => a - b)) {
    const notes = [...noteOnsByChannel.get(ch)!.entries()].sort((a, b) => a[0] - b[0]);
    const list = notes.map(([n, c]) => `${n}(${noteName(n)})×${c}`).join(', ');
    console.error(`  NOTE-ONs on MIDI ch ${ch}:  ${list}`);
  }
  for (const ch of [...ccByChannel.keys()].sort((a, b) => a - b)) {
    console.error(`  CCs on MIDI ch ${ch}:  ${[...ccByChannel.get(ch)!].sort((a, b) => a - b).join(', ')}`);
  }
  console.error('────────────────────────────────────────────────────────');
}

// Don't ignore SysEx (false). Do ignore timing clock + active-sensing
// (true, true) so we capture the protocol-meaningful messages, not
// the 24 PPQN clock spam and 0xFE keep-alive bytes.
input.ignoreTypes(false, true, true);

input.on('message', (_dt, bytes) => {
    messageCount++;
    byteCount += bytes.length;
    stream.write(Buffer.from(bytes));
    decode(bytes);
    // Deterministic loop-measurement log: one JSON line per note-on (velocity > 0).
    if (bytes.length >= 3 && (bytes[0] & 0xf0) === 0x90 && bytes[2] > 0) {
        eventsStream.write(JSON.stringify({ t_ms: Date.now() - start, ch: (bytes[0] & 0x0f) + 1, note: bytes[1], vel: bytes[2] }) + '\n');
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    // Live per-channel note list (the "what notes is it actually sending" answer,
    // without waiting for the Ctrl+C summary). Distinct notes per channel, capped.
    const noteSummary = [...noteOnsByChannel.keys()].sort((a, b) => a - b)
        .map((ch) => {
            const ns = [...noteOnsByChannel.get(ch)!.keys()].sort((a, b) => a - b);
            const shown = ns.length > 16 ? `${ns.slice(0, 16).join(',')},…` : ns.join(',');
            return `ch${ch}:[${shown}]`;
        })
        .join(' ');
    const last = lastNote
        ? ` last:${lastNote.note}(${noteName(lastNote.note)}) ch${lastNote.ch} v${lastNote.vel}`
        : '';
    process.stderr.write(
        `\r[${elapsed}s] ${messageCount} msgs ${byteCount}B${noteSummary ? ` | notes ${noteSummary}` : ''}${last} → ${path.basename(absOut)}     `,
    );
});

try {
    input.openPort(port.index);
} catch (err) {
    console.error(`\n❌ Failed to open port ${port.index}: ${err instanceof Error ? err.message : String(err)}`);
    console.error('   This usually means another app is holding the port with exclusive access.');
    console.error('   Quit that app, re-run this script, then relaunch the app AFTER the capture is running.');
    process.exit(1);
}

console.error(`Capturing to: ${absOut}`);
console.error('Trigger MIDI traffic on the device or in your editor. Press Ctrl+C to stop.\n');

process.on('SIGINT', () => {
    console.error('\n\nStopping...');
    try { input.closePort(); } catch { /* already closed */ }
    eventsStream.end();
    stream.end(() => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.error(`✓ Saved ${messageCount} messages (${byteCount} bytes) over ${elapsed}s to:`);
        console.error(`  ${absOut}`);
        console.error(`  ${eventsPath}  (timestamped note-ons; measure_loop.ts reads this)`);
        printSummary();
        process.exit(0);
    });
});
