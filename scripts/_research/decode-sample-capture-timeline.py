#!/usr/bin/env python3
"""
Decode a Circuit Tracks "Send samples" USBPcap capture into a TIMED, BOTH-DIRECTION
SysEx timeline, so we can see Components' PACING (does it wait for replies?) and the
exact commit sequence. Reassembles SysEx (F0..F7) per direction across USB packets,
tags each with the timestamp of its first byte, merges in time order, decodes the
subcmd, summarizes WRITE_DATA bulk, and flags inter-frame gaps.

Usage:
  TS="/c/Program Files/Wireshark/tshark.exe"
  "$TS" -r <capture.pcapng> -T fields -e frame.time_relative -e usb.endpoint_address \
        -e usbaudio.midi.event | python3 scripts/_research/decode-sample-capture-timeline.py
"""
import sys

HDR = [0x00, 0x20, 0x29, 0x01, 0x64, 0x03]
SUB = {0x40: "OPEN", 0x41: "CLOSE", 0x0b: "DIR_CONTROL", 0x09: "QUERY_INFO",
       0x0d: "ENUM_0d", 0x08: "INFO_0d", 0x0c: "REPLY_0c", 0x04: "ACK",
       0x01: "WRITE_INIT", 0x02: "WRITE_DATA", 0x03: "WRITE_FINISH", 0x07: "SET_FILENAME"}

# Per-direction reassembly. A row's event field is comma-separated 3-byte groups.
buf = {"OUT": [], "IN": []}
start = {"OUT": None, "IN": None}
frames = []  # (time, dir, bytes)

for line in sys.stdin:
    parts = line.rstrip("\n").split("\t")
    if len(parts) < 3 or not parts[2]:
        continue
    t = float(parts[0]); ep = parts[1].strip()
    direction = "IN" if ep == "0x81" else "OUT"
    raw = parts[2].replace(",", "")
    bs = [int(raw[i:i+2], 16) for i in range(0, len(raw) - 1, 2)]
    for b in bs:
        if b == 0xf0:
            buf[direction] = [0xf0]; start[direction] = t
        elif buf[direction]:
            buf[direction].append(b)
            if b == 0xf7:
                frames.append((start[direction], direction, buf[direction]))
                buf[direction] = []

frames.sort(key=lambda f: f[0])

def label(m):
    if len(m) < 8 or m[1:7] != HDR:
        # IN replies sometimes use a different cmd-group byte at m[6]; still decode subcmd
        if len(m) >= 8 and m[1:4] == [0x00, 0x20, 0x29]:
            return f"{SUB.get(m[7], hex(m[7]))} (grp {hex(m[6])})", m[7]
        return f"non-novation len{len(m)}", None
    return SUB.get(m[7], hex(m[7])), m[7]

# Emit: collapse runs of WRITE_DATA in the same direction; print everything else with
# the gap from the previous OUT frame (pacing) and the time to the next IN reply.
print(f"{'t(s)':>10} {'gap_ms':>8} dir  frame")
print("-" * 64)
prev_out_t = None
i = 0
n = len(frames)
while i < n:
    t, d, m = frames[i]
    lab, sub = label(m)
    if sub == 0x02 and d == "OUT":
        j = i
        while j < n and frames[j][2][7:8] == [0x02] and frames[j][1] == "OUT":
            j += 1
        t0 = frames[i][0]; t1 = frames[j-1][0]
        print(f"{t0:>10.4f} {'':>8} OUT  WRITE_DATA x{j-i}  ({t0:.3f}..{t1:.3f}s, {(t1-t0)*1000:.0f}ms)")
        i = j
        prev_out_t = t1
        continue
    gap = ""
    if d == "OUT":
        if prev_out_t is not None:
            gap = f"{(t-prev_out_t)*1000:.1f}"
        prev_out_t = t
    tail = " ".join(f"{b:02x}" for b in m[7:min(len(m), 16)])
    print(f"{t:>10.4f} {gap:>8} {d:>3}  {lab:<14} {tail}")
    i += 1

print(f"\ntotal frames: {n}  (OUT={sum(1 for f in frames if f[1]=='OUT')}, IN={sum(1 for f in frames if f[1]=='IN')})")
