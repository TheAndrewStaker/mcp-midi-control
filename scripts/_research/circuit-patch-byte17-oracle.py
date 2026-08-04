#!/usr/bin/env python3
"""
Byte-17 oracle: what does Novation Components itself put at patch-body offset 17
(`Patch_Genre`, v3 Programmer's Reference p.15) in a Replace-Patch (Flash save)
frame, and in a Replace-Current (live-buffer) frame?

Reads USBPcap .pcapng captures, de-frames USB-MIDI, reassembles SysEx across URB
boundaries (same machinery as decode-circuit-usbmidi.py), then prints, for every
Circuit patch-carrying frame:

  cmd  slot/loc  name  body[16] (Category)  body[17] (Genre)  + the header hex

Also de-interleaves any device->host PATCH file-transfer (fileType 0x04) payload
and reports its offset 16/17, since the patch FILE carries the same header.

  python3 scripts/_research/circuit-patch-byte17-oracle.py <capture.pcapng> [...]

Read-only. No device. Written 2026-07-29 to settle whether `savePatch`'s
`clean[17] = 0x00` matches the reference implementation.
"""
import struct
import sys

CIN_LEN = {0x04: 3, 0x05: 1, 0x06: 2, 0x07: 3, 0x08: 2, 0x09: 2, 0x0A: 2,
           0x0B: 2, 0x0C: 1, 0x0D: 1, 0x0E: 3, 0x0F: 1, 0x02: 2, 0x03: 3}
HDR = bytes.fromhex('0020290164')
CMD_REPLACE_CURRENT = 0x00
CMD_REPLACE_PATCH = 0x01


def usb_payloads(path):
    b = open(path, 'rb').read()
    off = 0
    while off + 12 <= len(b):
        btype, blen = struct.unpack_from('<II', b, off)
        if blen < 12 or off + blen > len(b):
            break
        if btype == 0x00000006:
            cap_len = struct.unpack_from('<I', b, off + 20)[0]
            pkt = b[off + 28: off + 28 + cap_len]
            if len(pkt) >= 27:
                header_len = struct.unpack_from('<H', pkt, 0)[0]
                endpoint = pkt[21]
                data_len = struct.unpack_from('<I', pkt, 23)[0]
                payload = pkt[header_len: header_len + data_len]
                if payload:
                    yield ('IN' if (endpoint & 0x80) else 'OUT'), payload
        off += blen


def deframe(packets):
    out = bytearray()
    for p in packets:
        for i in range(0, len(p) - (len(p) % 4), 4):
            n = CIN_LEN.get(p[i] & 0x0f)
            if n:
                out += p[i + 1: i + 1 + n]
    return bytes(out)


def sysex_messages(stream):
    msgs, i = [], 0
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


def msb_deinterleave(enc):
    out, i = bytearray(), 0
    while i < len(enc):
        header = enc[i]
        i += 1
        for j in range(7):
            if i >= len(enc):
                break
            out.append((enc[i] & 0x7f) | (((header >> j) & 1) << 7))
            i += 1
    return bytes(out)


def ascii(bs):
    return ''.join(chr(x) if 32 <= x < 127 else '.' for x in bs)


def report_patch_frames(path):
    print(f'\n########## {path} ##########')
    for direction in ('OUT', 'IN'):
        stream = deframe([pl for d, pl in usb_payloads(path) if d == direction])
        circ = [m for m in sysex_messages(stream) if m[1:6] == HDR]
        label = 'host->device (what Components SENT)' if direction == 'OUT' else 'device->host (what the DEVICE sent)'
        print(f'\n=== {direction}: {label} ===')
        found = 0
        for m in circ:
            cmd = m[6]
            if cmd not in (CMD_REPLACE_CURRENT, CMD_REPLACE_PATCH):
                continue
            found += 1
            # Replace-Current: F0 | 00 20 29 01 64 | 00 | loc | reserved | body(340) | F7  -> body at 9
            # Replace-Patch:   F0 | 00 20 29 01 64 | 01 | 00 | patchHi | patchLo | 00 | body(340) | F7 -> body at 11
            #   (matches codec/sysex.ts buildReplaceFlashPatch; total frame 352 bytes)
            base = 9 if cmd == CMD_REPLACE_CURRENT else 11
            body = m[base:-1]
            slot = m[7] if cmd == CMD_REPLACE_CURRENT else (m[8] << 7) | m[9]
            kind = 'REPLACE_CURRENT (live buffer)' if cmd == CMD_REPLACE_CURRENT else 'REPLACE_PATCH  (FLASH SAVE)'
            print(f'  {kind}  slot/loc={slot} bodyBase={base} bodylen={len(body)}')
            print(f'    name          = "{ascii(body[0:16])}"')
            print(f'    body[16] Category = {body[16]}   (0x{body[16]:02x})')
            print(f'    body[17] GENRE    = {body[17]}   (0x{body[17]:02x})   <<<<')
            print(f'    body[18:32] reserved = {body[18:32].hex(" ")}')
            print(f'    frame offset of body[17] = {base + 17} (0-based, from F0)')
            print(f'    frame bytes [{base+13}..{base+20}] = {m[base+13:base+21].hex(" ")}')
        if found == 0:
            print('  (no Replace-Current / Replace-Patch frames in this direction)')

    # PATCH file-transfer payloads (fileType 0x04) -> same 16/17 header, offset 0 = name
    for direction in ('OUT', 'IN'):
        stream = deframe([pl for d, pl in usb_payloads(path) if d == direction])
        circ = [m for m in sysex_messages(stream) if m[1:6] == HDR]
        data = bytearray()
        ftype = None
        for m in circ:
            if m[6] == 0x03 and m[7] == 0x01 and len(m) > 8 + 11:
                ftype = m[8 + 8]
            if m[6] == 0x03 and m[7] == 0x02:
                data += m[8 + 11:-1]
        if data and ftype == 0x04:
            dec = msb_deinterleave(bytes(data))
            print(f'\n=== {direction}: PATCH file-transfer payload ({len(dec)} bytes de-interleaved) ===')
            print(f'    name          = "{ascii(dec[0:16])}"')
            print(f'    file[16] Category = {dec[16]}')
            print(f'    file[17] GENRE    = {dec[17]}   <<<<')
            print(f'    file[18:32]   = {dec[18:32].hex(" ")}')


if __name__ == '__main__':
    for p in sys.argv[1:]:
        report_patch_frames(p)
