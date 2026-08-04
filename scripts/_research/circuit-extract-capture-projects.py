#!/usr/bin/env python3
"""
Extract the individual `.ncs` PROJECT files out of a Novation Components
"Get Pack from Circuit Tracks" USBPcap capture (device -> host direction).

Why: the maintainer's 98-project card corpus is one origin (his own device, his
own saves). A Components pack READ capture carries a completely INDEPENDENT
corpus -- Novation's factory demo pack, authored elsewhere, on other firmware.
Diffing the two origins narrows which config bytes are genuinely per-project
rather than per-device habit, which is what the project-colour hunt needs.

Reuses the de-framing primitives from `decode-circuit-usbmidi.py`; adds
per-file (not whole-stream) reassembly, keyed on WRITE_INIT -> WRITE_DATA* ->
WRITE_FINISH boundaries, and the msb-deinterleave that turns 8-byte
(1 header + 7 payload) groups back into raw bytes.

  python3 scripts/_research/circuit-extract-capture-projects.py <capture.pcapng> <outdir>

Read-only with respect to the device; touches only the capture file and outdir.
"""
import os
import sys
import importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('cudm', os.path.join(HERE, 'decode-circuit-usbmidi.py'))
cudm = importlib.util.module_from_spec(spec)
sys.argv_backup = sys.argv
sys.argv = [sys.argv[0]]  # the module runs main() on import unless argv is short
try:
    spec.loader.exec_module(cudm)
except (IndexError, SystemExit):
    pass
sys.argv = sys.argv_backup

FILE_TYPE_PROJECT = 0x03
NCS_SIZE = 160780


def main():
    path, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, exist_ok=True)

    packets = [pl for d, t, pl in cudm.usb_payloads(path) if d == 'IN']
    msgs = cudm.sysex_messages(cudm.deframe_usbmidi(packets))
    circ = [m for m in msgs if m[1:6] == cudm.HDR]

    # Walk the stream, cutting a new file at each WRITE_INIT and closing it at
    # WRITE_FINISH. Payload of WRITE_DATA (sub 0x02) is blockAddr(8) + fid(3)
    # then encoded body.
    cur_fid = None
    cur = bytearray()
    written = 0
    for m in circ:
        if m[6] != 0x03:
            continue
        sub = m[7]
        if sub == 0x01:                      # WRITE_INIT
            cur_fid, cur = tuple(m[8 + 8:8 + 11]), bytearray()
        elif sub == 0x02 and cur_fid is not None:   # WRITE_DATA
            cur += m[8 + 11:-1]
        elif sub == 0x03 and cur_fid is not None:   # WRITE_FINISH
            ftype, pack, slot = cur_fid
            if ftype == FILE_TYPE_PROJECT:
                dec = cudm.msb_deinterleave(bytes(cur))
                name = ''.join(chr(b) for b in dec[0x10:0x20] if 32 <= b < 127).strip()
                safe = ''.join(c if c.isalnum() else '_' for c in name) or 'unnamed'
                out = os.path.join(outdir, f'cap_p{pack}_s{slot:02d}__{safe}.ncs')
                with open(out, 'wb') as f:
                    f.write(dec)
                status = 'OK ' if len(dec) == NCS_SIZE else f'SIZE {len(dec)}'
                print(f'  {status} slot {slot:2d}  "{name}"  -> {os.path.basename(out)}')
                written += 1
            cur_fid, cur = None, bytearray()
    print(f'\nextracted {written} project file(s) to {outdir}')


if __name__ == '__main__':
    main()
