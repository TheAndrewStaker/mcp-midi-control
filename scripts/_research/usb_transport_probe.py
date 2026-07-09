#!/usr/bin/env python3
"""Parse USBPcap pcapng at the URB/EPB level: per-EPB timestamp, endpoint,
transfer type, data length, and payload. Then locate the Replace-Patch (cmd 0x01)
SysEx and dump how it is physically transported over USB-MIDI packets and URBs."""
import struct, sys

HDR = bytes.fromhex('0020290164')
CIN_LEN = {0x04: 3, 0x05: 1, 0x06: 2, 0x07: 3, 0x08: 2, 0x09: 2, 0x0A: 2,
           0x0B: 2, 0x0C: 1, 0x0D: 1, 0x0E: 3, 0x0F: 1, 0x02: 2, 0x03: 3}

def epbs(path):
    """Yield dict per Enhanced Packet Block with USBPcap fields + timestamp."""
    b = open(path, 'rb').read()
    off = 0
    ts_num = 1  # ns resolution assumption; USBPcap uses 1us default (if_tsresol)
    # find tsresol from IDB if present
    tsresol = 6  # default 10^-6
    while off + 12 <= len(b):
        btype, blen = struct.unpack_from('<II', b, off)
        if blen < 12 or off + blen > len(b):
            break
        if btype == 0x00000001:  # IDB
            # options after linktype(2)+reserved(2)+snaplen(4) = at off+8..
            # parse options for if_tsresol (code 9)
            opt_off = off + 8 + 8
            while opt_off + 4 <= off + blen - 4:
                code, olen = struct.unpack_from('<HH', b, opt_off)
                if code == 0:
                    break
                if code == 9 and olen >= 1:
                    tsresol = b[opt_off + 4]
                opt_off += 4 + ((olen + 3) & ~3)
        if btype == 0x00000006:  # EPB
            tsh, tsl = struct.unpack_from('<II', b, off + 12)
            cap_len = struct.unpack_from('<I', b, off + 20)[0]
            pkt = b[off + 28: off + 28 + cap_len]
            ts = (tsh << 32) | tsl
            if len(pkt) >= 27:
                header_len = struct.unpack_from('<H', pkt, 0)[0]
                irp = struct.unpack_from('<Q', pkt, 2)[0]  # IRP id (URB id)
                status = struct.unpack_from('<I', pkt, 12)[0]
                func = struct.unpack_from('<H', pkt, 16)[0]
                info = pkt[18]
                endpoint = pkt[21]
                transfer = pkt[22]
                data_len = struct.unpack_from('<I', pkt, 23)[0]
                payload = pkt[header_len: header_len + data_len]
                yield {
                    'ts': ts, 'tsresol': tsresol, 'irp': irp, 'status': status,
                    'func': func, 'info': info, 'endpoint': endpoint,
                    'transfer': transfer, 'data_len': data_len,
                    'dir': 'IN' if (endpoint & 0x80) else 'OUT',
                    'payload': payload, 'header_len': header_len,
                }
        off += blen

def ts_us(e):
    # convert timestamp to microseconds
    r = e['tsresol']
    if r & 0x80:
        base = 2 ** (r & 0x7f)
        return e['ts'] / base * 1e6
    else:
        return e['ts'] * (10 ** (-r)) * 1e6

TRANSFER = {0: 'ISO', 1: 'INT', 2: 'CTRL', 3: 'BULK'}

def main():
    path = sys.argv[1]
    es = list(epbs(path))
    t0 = ts_us(es[0]) if es else 0
    print(f'total EPBs: {len(es)}')
    # Find OUT EPBs whose payload (USB-MIDI) reassembles to contain a Replace-Patch.
    # A Replace-Patch SysEx is 352 bytes: F0 00 20 29 01 64 01 ... F7
    # Reassemble per-EPB midi and search across EPBs.
    # We'll scan OUT EPBs, and for each that carries USB-MIDI, note it.
    print('\n=== OUT EPBs carrying USB-MIDI (ep, transfer, dataLen, firstbytes) ===')
    for i, e in enumerate(es):
        if e['dir'] != 'OUT':
            continue
        p = e['payload']
        if not p:
            continue
        # is this USB-MIDI? endpoint 0x01 typically. Show all OUT bulk/int with data
        if e['transfer'] in (1, 3) and len(p) >= 4:
            rel = ts_us(e) - t0
            print(f'  [{i}] t={rel/1000:.3f}ms ep=0x{e["endpoint"]:02x} '
                  f'{TRANSFER.get(e["transfer"])} irp={e["irp"]:#x} '
                  f'info={e["info"]} dataLen={e["data_len"]} first16={p[:16].hex()}')

if __name__ == '__main__':
    main()
