#!/usr/bin/env python3
"""
patchbank-frames.py - OFFLINE. Emit the ordered SysEx frame plan that writes the staged patch bank
to ONE wire pack. Same frame shapes as the 2026-06-27 Novation Components capture, which is what
makes them trustworthy; only the pack byte in each file id differs.

  usage: python3 scripts/_research/patchbank-frames.py <wirePack>
         wire 0 = device Pack 1, wire 1 = Pack 2, wire 2 = Pack 3, wire 3 = Pack 4, wire 4 = Pack 5

Groups 1..15 are asserted byte-identical to the CRC-proven factory staging before any frame is
emitted. Group 0 is EXPECTED to differ - it carries the owner's three patches - so it is exempted
explicitly rather than silently.
"""
import json, os, sys, zlib, hashlib

REPO = 'C:/dev/mcp-midi-tools'
SRC  = f'{REPO}/samples/circuit-tracks/patchbank-all-packs-2026-09-20'
REF  = f'{REPO}/samples/circuit-tracks/pack2-patch-upload-2026-07-30'
# The Circuit Tracks file-transfer header is SIX bytes: 00 20 29 01 64 = Novation / product type /
# Circuit Tracks, then 03 = the file-command GROUP byte. Canonical definition:
# packages/circuit-tracks/src/ncs/transfer.ts `HEADER`, and the same six bytes lead every frame in
# the Components capture and in the proven pack2-patch-upload-2026-07-30 plan.
#
# DO NOT DROP THE 03. A five-byte header emits frames addressed to a command group that does not
# exist; the Circuit ignores every one of them and answers NOTHING, with no error anywhere. That is
# exactly what happened on 2026-09-20: a whole frame plan replayed into silence and read as a dead
# inbound path / a broken `onMessage`. Proof (real device, read-only): the plan's own prelude +
# QUERY_EXISTS sent verbatim -> 0 inbound messages; the identical frames with 03 restored -> 17,
# including the documented EMPTY_RECORD answer `f0 00 20 29 01 64 03 05 00 .. 07 f7`.
XHDR = [0x00, 0x20, 0x29, 0x01, 0x64, 0x03]

def make(sub, payload=()): return bytes([0xF0, *XHDR, sub, *payload, 0xF7])
def block_addr(b): return [0, 0, 0, 0, 0, 0, (b >> 4) & 0x7f, b & 0x0f]
def nibbles(v, n): return [(v >> (4 * i)) & 0xF for i in range(n - 1, -1, -1)]
def interleave(data):
    out = []
    for i in range(0, len(data), 7):
        grp = data[i:i+7]; hdr = 0
        for j, byte in enumerate(grp):
            if byte & 0x80: hdr |= 1 << j
        out.append(hdr); out += [b & 0x7f for b in grp]
    return out

PACK = int(sys.argv[1])
assert 0 <= PACK <= 4, 'wire pack must be 0..4 (device Pack 1..5)'
ref = {f['group']: f for f in json.load(open(f'{REF}/MANIFEST.json'))['files']}
mine = json.load(open(f'{SRC}/MANIFEST.json'))

frames = []
def add(label, frame, ack_addr=None, fid=None, expect=None):
    e = {'label': label, 'hex': frame.hex()}
    if ack_addr is not None: e['ack'] = {'addr': ack_addr, 'fid': fid}
    if expect: e['expect'] = expect
    frames.append(e)

add('close_session (defensive reset; drop replies)', make(0x41))
add('open_session', make(0x40))
add('dir_control_1', make(0x0b, [0x01]))
add('query_info_1_0', make(0x09, [0x01, 0x00]))
add('query_info_1_1', make(0x09, [0x01, 0x01]))
add('dir_control_2', make(0x0b, [0x02]))
add(f'dir_scope_patch_wirepack{PACK}', make(0x0b, [0x04, PACK]))

for g in range(16):
    body = open(f'{SRC}/{g:02d}_PATCHBANK.cpb', 'rb').read()
    assert len(body) == 3924, f'group {g}: {len(body)} bytes'
    crc = zlib.crc32(body) & 0xffffffff
    if g == 0:
        assert hashlib.sha256(body).hexdigest() != ref[0]['sha256'], 'group 0 should differ (owner patches)'
    else:
        assert hashlib.sha256(body).hexdigest() == ref[g]['sha256'], \
            f'group {g} is NOT the Components-proven factory bank - refusing to emit frames'
    fid = [0x04, PACK, g]
    add(f'query_exists g{g}', make(0x0d, fid),
        expect='EMPTY_RECORD (sub 0x05). A sub-0x0d CRC reply means OCCUPIED: ABORT that group.')
    add(f'write_init g{g}', make(0x01, [*block_addr(0), *fid, 0x01, 0x00, 0x00, 0x00, *nibbles(3924, 5)]),
        ack_addr=block_addr(0), fid=fid)
    add(f'write_data g{g}', make(0x02, [*block_addr(1), *fid, *interleave(body)]),
        ack_addr=block_addr(1), fid=fid)
    add(f'write_finish g{g}', make(0x03, [*block_addr(2), *fid, *nibbles(crc, 8)]),
        ack_addr=block_addr(2), fid=fid)
add('close_session', make(0x41))

out = f'{REPO}/samples/circuit-tracks/patchbank-wire{PACK}-2026-09-20'
os.makedirs(out, exist_ok=True)
with open(f'{out}/frames.jsonl', 'w') as f:
    for e in frames: f.write(json.dumps(e) + '\n')
man = dict(mine); man['pack_wire'] = PACK; man['pack_device'] = PACK + 1
for fobj in man['files']:
    fobj['crc32'] = f"{zlib.crc32(open(f'{SRC}/' + fobj['file'],'rb').read()) & 0xffffffff:08x}"
json.dump(man, open(f'{out}/MANIFEST.json', 'w'), indent=1)
print(f'wire pack {PACK} (device Pack {PACK+1}): {len(frames)} frames -> {out}')
print('  groups 1-15 verified byte-identical to the Components-proven factory bank')
print('  group 0 carries: ' + ' | '.join(mine['files'][0]['names'][:4]) + ' ...')
