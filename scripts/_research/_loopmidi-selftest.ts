/**
 * loopMIDI delivery self-test: can node-midi WRITE to a loopMIDI port and have
 * a separate node-midi READER on the same port receive it? Isolates whether our
 * emulator's replies physically reach loopMIDI (no editor involved).
 *
 *   npx tsx scripts/_research/_loopmidi-selftest.ts "Reply"
 */
import midi from "@julusian/midi";

const needle = (process.argv[2] ?? 'Reply').toLowerCase();
const findIdx = (io: midi.Input | midi.Output) => {
    for (let i = 0; i < io.getPortCount(); i++) if (io.getPortName(i).toLowerCase().includes(needle)) return i;
    return -1;
};

const input = new midi.Input();
const output = new midi.Output();
const inIdx = findIdx(input);
const outIdx = findIdx(output);
console.error(`input  match [${inIdx}] ${inIdx >= 0 ? input.getPortName(inIdx) : '(none)'}`);
console.error(`output match [${outIdx}] ${outIdx >= 0 ? output.getPortName(outIdx) : '(none)'}`);
if (inIdx < 0 || outIdx < 0) process.exit(1);

let got = 0;
input.ignoreTypes(false, true, true);
input.on('message', (_dt, bytes) => {
    got++;
    console.error(`RECEIVED #${got}: ${bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
});
input.openPort(inIdx);
output.openPort(outIdx);

const test = [0xf0, 0x00, 0x01, 0x74, 0x12, 0x00, 0x17, 0xf7];
console.error(`sending 3 test SysEx to output...`);
let n = 0;
const timer = setInterval(() => {
    output.sendMessage(test);
    console.error(`  sent #${++n}`);
    if (n >= 3) {
        clearInterval(timer);
        setTimeout(() => {
            console.error(got > 0
                ? `\nRESULT: PASS — node-midi -> loopMIDI -> node-midi delivered ${got}/3. Replies CAN reach a reader on this port.`
                : `\nRESULT: FAIL — wrote 3 but received 0. node-midi is NOT delivering into loopMIDI on this port.`);
            input.closePort(); output.closePort();
            process.exit(0);
        }, 600);
    }
}, 200);
