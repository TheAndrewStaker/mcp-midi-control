#!/usr/bin/env python3
"""
USBPcap (.pcapng, linktype 249) -> USB-MIDI -> reassembled SysEx de-framer for
Novation Circuit Tracks captures.

Unlike a naive contiguous scan, this parses the pcapng EPBs and USBPcap headers,
concatenates each direction's bulk/interrupt USB-MIDI payload in capture order,
de-frames the 4-byte USB-MIDI event packets, and reassembles complete SysEx
messages ACROSS URB boundaries (so multi-URB WRITE_DATA bodies survive).

  python3 scripts/_research/decode-circuit-usbmidi.py <capture.pcapng> [--data]

Prints the Circuit file-transfer session per direction. --data also de-interleaves
and dumps the reassembled file payload (WRITE_DATA blocks).
"""
import struct, sys

CIN_LEN = {0x04: 3, 0x05: 1, 0x06: 2, 0x07: 3, 0x08: 2, 0x09: 2, 0x0A: 2,
           0x0B: 2, 0x0C: 1, 0x0D: 1, 0x0E: 3, 0x0F: 1, 0x02: 2, 0x03: 3}
HDR = bytes.fromhex('0020290164')  # Novation 00 20 29 + product 01 64


def usb_payloads(path):
    """Yield (direction, transfer_type, payload_bytes) per EPB, in file order.
    direction: 'OUT' host->device, 'IN' device->host."""
    b = open(path, 'rb').read()
    off = 0
    while off + 12 <= len(b):
        btype, blen = struct.unpack_from('<II', b, off)
        if blen < 12 or off + blen > len(b):
            break
        if btype == 0x00000006:  # Enhanced Packet Block
            cap_len = struct.unpack_from('<I', b, off + 20)[0]
            pkt = b[off + 28: off + 28 + cap_len]
            if len(pkt) >= 27:
                header_len = struct.unpack_from('<H', pkt, 0)[0]
                endpoint = pkt[21]
                transfer = pkt[22]
                data_len = struct.unpack_from('<I', pkt, 23)[0]
                payload = pkt[header_len: header_len + data_len]
                if payload:
                    direction = 'IN' if (endpoint & 0x80) else 'OUT'
                    yield direction, transfer, payload
        off += blen


def deframe_usbmidi(packets):
    """Concatenate USB-MIDI 4-byte event packets -> raw MIDI byte stream."""
    out = bytearray()
    for p in packets:
        for i in range(0, len(p) - (len(p) % 4), 4):
            cin = p[i] & 0x0f
            n = CIN_LEN.get(cin)
            if n:
                out += p[i + 1: i + 1 + n]
    return bytes(out)


def sysex_messages(stream):
    """Split a MIDI byte stream into complete SysEx messages (F0..F7)."""
    msgs = []
    i = 0
    while True:
        s = stream.find(0xF0, i)
        if s < 0:
            break
        e = stream.find(0xF7, s)
        if e < 0:
            break
        msgs.append(stream[s:e + 1])
        i = e + 1
    return msgs


SUB = {0x40: 'OPEN', 0x41: 'CLOSE', 0x01: 'WRITE_INIT', 0x02: 'WRITE_DATA',
       0x03: 'WRITE_FINISH', 0x04: 'ACK', 0x05: 'DIR_SESSION', 0x06: 'READ_BLOCK?',
       0x07: 'SET_FILENAME', 0x09: 'QUERY', 0x0b: 'DIR', 0x0c: 'DIR_ENTRY'}
FTYPE = {0x03: 'project', 0x04: 'PATCH', 0x05: 'sample'}


def ascii(bs):
    return ''.join(chr(x) if 32 <= x < 127 else '.' for x in bs)


def describe(m):
    if m[1:6] != HDR:
        return f'(non-Circuit sysex, {len(m)}B)'
    cmd = m[6]
    if cmd == 0x03:  # file transfer
        sub = m[7]; p = m[8:-1]
        lab = SUB.get(sub, f'sub0x{sub:02x}')
        if sub in (0x01,) and len(p) >= 11:
            fid = p[8:11]
            op = p[11] if len(p) > 11 else None
            ft = FTYPE.get(fid[0], f'0x{fid[0]:02x}')
            return f'WRITE_INIT  file={ft} slot={fid[1]*128+fid[2]} tail={p[11:].hex()}'
        if sub == 0x02 and len(p) >= 11:
            fid = p[8:11]; blk = p[6]*16 + p[7]
            return f'WRITE_DATA  file={FTYPE.get(fid[0],hex(fid[0]))} slot={fid[1]*128+fid[2]} block~{blk} datalen={len(p)-11}'
        if sub == 0x07:
            fid = p[0:3]
            return f'SET_FILENAME file={FTYPE.get(fid[0],hex(fid[0]))} slot={fid[1]*128+fid[2]} name="{ascii(p[3:])}"'
        return f'{lab:12s} payload={p.hex()}  "{ascii(p)}"'
    if cmd == 0x00:
        return f'REPLACE_CURRENT loc={m[7]} name="{ascii(m[9:25])}" len={len(m)}'
    if cmd == 0x01:
        return f'REPLACE_PATCH(FLASH) slot={m[7]} name="{ascii(m[9:25])}" len={len(m)}'
    if cmd == 0x40:
        return f'DUMP_REQUEST loc={m[7]}'
    if cmd == 0x08:
        return f'COMMIT_DONE (group 0x08)'
    return f'cmd=0x{cmd:02x} len={len(m)} {m[6:12].hex()}'


def main():
    path = sys.argv[1]
    show_data = '--data' in sys.argv[2:]
    for direction in ('OUT', 'IN'):
        packets = [pl for d, t, pl in usb_payloads(path) if d == direction]
        stream = deframe_usbmidi(packets)
        msgs = sysex_messages(stream)
        circ = [m for m in msgs if m[1:6] == HDR]
        print(f'\n===== {direction} ({"host->device" if direction=="OUT" else "device->host"}): '
              f'{len(circ)} Circuit SysEx / {len(msgs)} total =====')
        # collapse runs of identical WRITE_DATA descriptions
        prev = None; run = 0
        for m in circ:
            d = describe(m)
            key = d.split('datalen')[0] if 'WRITE_DATA' in d else d
            if key == prev:
                run += 1; continue
            if run > 1:
                print(f'      … x{run}')
            prev = key; run = 1
            print(f'  {d}')
        if run > 1:
            print(f'      … x{run}')
        # reassemble WRITE_DATA payload if asked
        if show_data and direction == 'OUT':
            reassemble_file(circ)


def msb_deinterleave(enc):
    """Inverse of the project/sample msb-interleave: per 8 bytes, 1 header + 7 data."""
    out = bytearray()
    i = 0
    while i < len(enc):
        header = enc[i]; i += 1
        for j in range(7):
            if i >= len(enc):
                break
            out.append((enc[i] & 0x7f) | (((header >> j) & 1) << 7)); i += 1
    return bytes(out)


def reassemble_file(circ):
    data = bytearray()
    init = None
    for m in circ:
        if m[6] == 0x03 and m[7] == 0x01:
            init = m
        if m[6] == 0x03 and m[7] == 0x02:  # WRITE_DATA
            data += m[8 + 11:-1]  # strip blockAddr(8)+fid(3) from the payload
    print(f'\n  --- reassembled WRITE_DATA: {len(data)} encoded bytes ---')
    if init:
        print(f'  WRITE_INIT: {init.hex(" ")}')
    dec = msb_deinterleave(bytes(data))
    print(f'  de-interleaved: {len(dec)} bytes')
    print(f'  first 64: {dec[:64].hex(" ")}')
    print(f'  ascii:    "{ascii(dec[:64])}"')


if __name__ == '__main__':
    main()
