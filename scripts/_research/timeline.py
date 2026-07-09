#!/usr/bin/env python3
"""Merged, timestamped timeline of Circuit SysEx across BOTH directions.
Reassembles SysEx per direction across EPBs, tags each completed message with the
timestamp of the EPB that completed it, then merges by time."""
import sys, importlib
sys.path.insert(0, 'scripts/_research')
d = importlib.import_module('usb_transport_probe')
dec = importlib.import_module('decode-circuit-usbmidi')

CIN_LEN = d.CIN_LEN
HDR = dec.HDR

def deframe_epb(payload):
    out = bytearray()
    for i in range(0, len(payload) - (len(payload) % 4), 4):
        cin = payload[i] & 0x0f
        n = CIN_LEN.get(cin)
        if n:
            out += payload[i+1:i+1+n]
    return bytes(out)

def main():
    path = sys.argv[1]
    es = list(d.epbs(path))
    if not es: return
    t0 = d.ts_us(es[0])
    bufs = {'OUT': bytearray(), 'IN': bytearray()}
    events = []  # (t_rel_ms, dir, sysex)
    for e in es:
        if not e['payload']:
            continue
        dr = e['dir']
        if dr not in bufs:
            continue
        # only USB-MIDI endpoints (ep 0x01 out, 0x81 in typically)
        if (e['endpoint'] & 0x7f) != 0x01:
            continue
        bufs[dr] += deframe_epb(e['payload'])
        t = d.ts_us(e) - t0
        # extract complete sysex
        buf = bufs[dr]
        while True:
            s = buf.find(0xF0)
            if s < 0:
                del buf[:]; break
            en = buf.find(0xF7, s)
            if en < 0:
                del buf[:s]; break
            msg = bytes(buf[s:en+1])
            events.append((t/1000.0, dr, msg))
            del buf[:en+1]
    events.sort(key=lambda x: x[0])
    prev_t = None
    for t, dr, msg in events:
        if msg[1:6] != HDR:
            continue
        desc = dec.describe(msg)
        dt = '' if prev_t is None else f'+{(t-prev_t)*1000:7.1f}ms'
        arrow = '-->' if dr == 'OUT' else '<--'
        print(f't={t:9.3f}ms {dt:>12} {arrow} {desc}')
        prev_t = t

if __name__ == '__main__':
    main()
