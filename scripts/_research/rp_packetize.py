#!/usr/bin/env python3
"""Extract the Replace-Patch (cmd 0x01) OUT burst and analyze its USB-MIDI packetization:
count packets, CIN histogram, terminator, reassembled sysex length, and per-EPB grouping."""
import struct, sys
sys.path.insert(0, 'scripts/_research')
import importlib
d = importlib.import_module('usb_transport_probe')

CIN_LEN = {0x04: 3, 0x05: 1, 0x06: 2, 0x07: 3, 0x08: 2, 0x09: 2, 0x0A: 2,
           0x0B: 2, 0x0C: 1, 0x0D: 1, 0x0E: 3, 0x0F: 1, 0x02: 2, 0x03: 3}

def main():
    path = sys.argv[1]
    es = list(d.epbs(path))
    t0 = d.ts_us(es[0])
    # Find the Replace-Patch: OUT EPB whose payload starts with 04 f0 00 20 04 29 01 64 04 01 00 ...
    # i.e. USB-MIDI framed F0 00 20 29 01 64 01
    start = None
    for i, e in enumerate(es):
        if e['dir'] != 'OUT':
            continue
        p = e['payload']
        if p[:8] == bytes.fromhex('04f0002004290164') and len(p) >= 12 and p[8] == 0x04 and p[9] == 0x01:
            start = i
            break
    if start is None:
        print('Replace-Patch burst not found'); return
    # gather consecutive OUT EPBs on ep 0x01 until the sysex terminates (CIN 0x05/06/07)
    burst = []
    i = start
    while i < len(es):
        e = es[i]
        if e['dir'] == 'OUT' and (e['endpoint'] & 0x7f) == 0x01 and e['payload']:
            burst.append((i, e))
            # check terminator in this EPB
            p = e['payload']
            term = False
            for j in range(0, len(p) - (len(p) % 4), 4):
                if (p[j] & 0x0f) in (0x05, 0x06, 0x07):
                    term = True
            if term and len(burst) > 1:
                break
        elif burst:
            # non-EPB interruption; keep scanning a little only if contiguous
            pass
        i += 1
        if len(burst) > 20:
            break
    print(f'Replace-Patch burst: {len(burst)} EPBs, EPB indices {[b[0] for b in burst]}')
    first_t = d.ts_us(burst[0][1])
    last_t = d.ts_us(burst[-1][1])
    print(f'burst span: {(last_t-first_t):.1f} us  (start t={first_t-t0:.3f}us rel)')
    print('per-EPB: idx  dataLen  irp  dt_from_prev_us')
    prev = None
    all_pkts = bytearray()
    for idx, e in burst:
        t = d.ts_us(e)
        dt = '' if prev is None else f'{t-prev:.1f}'
        print(f'  [{idx}] len={e["data_len"]:3d} irp={e["irp"]:#018x} dt={dt}')
        prev = t
        all_pkts += e['payload']
    # analyze packets
    cin_hist = {}
    sysex = bytearray()
    npk = 0
    term_pkt = None
    for j in range(0, len(all_pkts) - (len(all_pkts) % 4), 4):
        cin = all_pkts[j] & 0x0f
        cable = all_pkts[j] >> 4
        cin_hist[cin] = cin_hist.get(cin, 0) + 1
        n = CIN_LEN.get(cin, 0)
        sysex += all_pkts[j+1:j+1+n]
        npk += 1
        if cin in (0x05, 0x06, 0x07):
            term_pkt = all_pkts[j:j+4]
    print(f'\ntotal USB bytes in burst: {len(all_pkts)}  packets: {npk}')
    print(f'CIN histogram: {{{", ".join(f"0x{k:02x}:{v}" for k,v in sorted(cin_hist.items()))}}}')
    print(f'cable nibbles seen: {sorted(set(all_pkts[j]>>4 for j in range(0,len(all_pkts)-3,4)))}')
    print(f'terminator packet: {term_pkt.hex() if term_pkt else None}')
    print(f'reassembled SysEx length: {len(sysex)}  starts F0={sysex[0]==0xF0} ends F7={sysex[-1]==0xF7}')
    print(f'sysex head: {sysex[:12].hex()}')
    print(f'sysex tail: {sysex[-8:].hex()}')

if __name__ == '__main__':
    main()
