#!/usr/bin/env python3
"""
Diff the HOST->DEVICE (OUT) control-frame sequence of two Circuit Tracks upload
captures (e.g. OURS vs Components). Reassembles OUT SysEx, drops the WRITE_DATA
bulk, NORMALIZES each control frame (masks sample-specific size/CRC/name bytes),
collapses the 64x ENUM_0d run, and prints a unified diff so a structural
divergence (extra/missing frame, different order, different prelude args) pops.

Usage:
  python3 scripts/_research/diff-upload-captures.py <ours.pcapng> <components.pcapng>
Requires tshark on PATH or at the default Wireshark location.
"""
import subprocess, sys, os, difflib

import shutil
TS = next((p for p in [r"C:\Program Files\Wireshark\tshark.exe", "/c/Program Files/Wireshark/tshark.exe"] if os.path.exists(p)), shutil.which("tshark") or "tshark")
SUB = {0x40: "OPEN", 0x41: "CLOSE", 0x0b: "DIR_CONTROL", 0x09: "QUERY_INFO",
       0x0d: "ENUM_0d", 0x08: "INFO_0d", 0x01: "WRITE_INIT", 0x02: "WRITE_DATA",
       0x03: "WRITE_FINISH", 0x07: "SET_FILENAME"}

def out_frames(pcap):
    """Reassemble OUT (endpoint 0x01) SysEx → list of normalized control-frame labels."""
    cmd = [TS, "-r", pcap, "-T", "fields", "-e", "usb.endpoint_address", "-e", "usbaudio.midi.event"]
    rows = subprocess.run(cmd, capture_output=True, text=True).stdout.splitlines()
    buf, frames = [], []
    for line in rows:
        parts = line.split("\t")
        if len(parts) < 2 or parts[0].strip() != "0x01" or not parts[1]:
            continue
        raw = parts[1].replace(",", "")
        for i in range(0, len(raw) - 1, 2):
            b = int(raw[i:i+2], 16)
            if b == 0xf0:
                buf = [0xf0]
            elif buf:
                buf.append(b)
                if b == 0xf7:
                    frames.append(buf); buf = []
    out = []
    for m in frames:
        if len(m) < 9 or m[1:7] != [0x00, 0x20, 0x29, 0x01, 0x64, 0x03]:
            out.append(f"?? {' '.join(f'{x:02x}' for x in m[:8])}"); continue
        sub = m[7]; name = SUB.get(sub, f"sub{sub:02x}")
        body = m[8:-1]
        if sub == 0x02:            # WRITE_DATA bulk — skip
            continue
        if sub == 0x0d:            # ENUM: keep the slot index
            out.append(f"ENUM_0d slot={body[-1]:02x}")
        elif sub == 0x08:
            out.append(f"INFO_0d slot={body[-1]:02x}")
        elif sub == 0x01:          # WRITE_INIT: addr + fileId, MASK the size nibbles
            out.append(f"WRITE_INIT addr={' '.join(f'{x:02x}' for x in body[:8])} fid={' '.join(f'{x:02x}' for x in body[8:11])} +flags <size>")
        elif sub == 0x03:          # WRITE_FINISH: fileId, MASK the crc
            out.append(f"WRITE_FINISH fid={' '.join(f'{x:02x}' for x in body[8:11])} <crc>")
        elif sub == 0x07:          # SET_FILENAME: fileId, MASK the ascii name
            out.append(f"SET_FILENAME fid={' '.join(f'{x:02x}' for x in body[:3])} <name>")
        else:                      # OPEN / CLOSE / DIR_CONTROL / QUERY_INFO: keep args verbatim
            args = ' '.join(f'{x:02x}' for x in body)
            out.append(f"{name}{(' ' + args) if args else ''}")
    return out

def collapse(seq):
    """Collapse a run of >3 identical-prefix ENUM_0d into one summary line."""
    res, i = [], 0
    while i < len(seq):
        if seq[i].startswith("ENUM_0d"):
            j = i
            while j < len(seq) and seq[j].startswith("ENUM_0d"):
                j += 1
            res.append(f"ENUM_0d x{j-i} (slots {seq[i].split('=')[1]}..{seq[j-1].split('=')[1]})")
            i = j
        else:
            res.append(seq[i]); i += 1
    return res

a_path, b_path = sys.argv[1], sys.argv[2]
a, b = collapse(out_frames(a_path)), collapse(out_frames(b_path))
print(f"A (ours)      = {os.path.basename(a_path)}: {len(a)} OUT control frames")
print(f"B (components)= {os.path.basename(b_path)}: {len(b)} OUT control frames")
print("=" * 70)
print("UNIFIED DIFF (A=ours '-', B=components '+'):")
for line in difflib.unified_diff(a, b, fromfile="ours", tofile="components", lineterm=""):
    print(line)
print("=" * 70)
same = sum(1 for x, y in zip(a, b) if x == y)
print(f"first {min(len(a),len(b))} frames: {same} identical; first divergence at index "
      f"{next((i for i,(x,y) in enumerate(zip(a,b)) if x!=y), 'none (one is a prefix of the other)')}")
