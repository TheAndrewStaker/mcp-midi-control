#!/usr/bin/env python3
"""For each capture, list OUTBOUND (host->device) cmd 0x00 (REPLACE_CURRENT/load-buffer)
and cmd 0x01 (REPLACE_PATCH/save-flash) with name + body fingerprint, in time order,
to test the 'load-before-save' pairing hypothesis."""
import sys, importlib, hashlib
sys.path.insert(0, 'scripts/_research')
d = importlib.import_module('usb_transport_probe')
dec = importlib.import_module('decode-circuit-usbmidi')
HDR = dec.HDR
CIN_LEN = d.CIN_LEN

def deframe(payload):
    out = bytearray()
    for i in range(0, len(payload)-(len(payload)%4), 4):
        n = CIN_LEN.get(payload[i]&0x0f)
        if n: out += payload[i+1:i+1+n]
    return bytes(out)

def msgs_out(path):
    es = list(d.epbs(path)); t0 = d.ts_us(es[0])
    buf = bytearray(); res = []
    for e in es:
        if not e['payload'] or e['dir'] != 'OUT' or (e['endpoint']&0x7f)!=0x01: continue
        buf += deframe(e['payload']); t = d.ts_us(e)-t0
        while True:
            s = buf.find(0xF0)
            if s<0: del buf[:]; break
            en = buf.find(0xF7,s)
            if en<0: del buf[:s]; break
            res.append((t/1000.0, bytes(buf[s:en+1]))); del buf[:en+1]
    return res

def name_of(m):
    # patch name is 16 ascii chars; for cmd0x00 near m[9:25], cmd0x01 near m[11:27]
    # search for a run of printable
    txt = ''.join(chr(x) if 32<=x<127 else '.' for x in m)
    return txt

for path in sys.argv[1:]:
    print(f'\n===== {path.split("/")[-1]} =====')
    last00 = None
    for t, m in msgs_out(path):
        if m[1:6]!=HDR: continue
        cmd = m[6]
        if cmd == 0x00:  # REPLACE_CURRENT load
            nm = ''.join(chr(x) if 32<=x<127 else '.' for x in m[9:25])
            body = m[9:-1]  # from name to before F7
            last00 = (t, nm, hashlib.md5(bytes(body)).hexdigest()[:8], len(m))
            print(f'  t={t:8.2f}ms OUT cmd=0x00 REPLACE_CURRENT(load-buffer) name="{nm}" len={len(m)} bodyhash={last00[2]}')
        elif cmd == 0x01:  # REPLACE_PATCH save
            nm = ''.join(chr(x) if 32<=x<127 else '.' for x in m[11:27])
            body = m[11:-1]
            bh = hashlib.md5(bytes(body)).hexdigest()[:8]
            slot = m[8]*128 + m[9]
            paired = ''
            if last00:
                same = 'SAME-NAME' if last00[1].strip()==nm.strip() else 'diff-name'
                dt = t - last00[0]
                paired = f'  <-- preceded {dt:.0f}ms earlier by cmd0x00 "{last00[1]}" ({same}); bodyhash-match={last00[2]==bh}'
            else:
                paired = '  <-- NO preceding outbound cmd0x00 (buffer NOT loaded)'
            print(f'  t={t:8.2f}ms OUT cmd=0x01 REPLACE_PATCH(save-flash) slot={slot} name="{nm}" len={len(m)} bodyhash={bh}{paired}')
