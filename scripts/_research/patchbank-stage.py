#!/usr/bin/env python3
"""
patchbank-stage.py - OFFLINE. Build the synth patch bank to write to every pack.

WHY THIS EXISTS. A Novation Components pack send runs a delete loop over the fileType-0x04 patch
slots and writes nothing back when the pack was authored without patches, so every pack we create
comes out with an EMPTY synth bank. The owner hit this on Pack 2 on 2026-07-30 and again tonight on
Pack 4: he raised the internal synth faders to play along and there was nothing to select.

WHAT GOES IN. The stock factory 128 (Novation's own bank, which is genuinely bass-rich: 32 of the 128
are category Bass), with THREE of the owner's own patches kept at the bank slots they already occupy
on Pack 1, so his muscle memory transfers:

    slot 0  Sub Hard            his
    slot 1  BassOSC             factory  (was PROBE85, one of our probe artifacts - dropped)
    slot 2  Jackson Bass        his
    slot 3  Jackson Bass (mo..  his

That displaces factory `Random Decay`, `Bassix` and `Basseven`. The Circuit holds exactly 128 patches
shared across both synth tracks (four pages of 32; Synth 2 lands on page 3), so there is no free
space - including his three necessarily costs three factory patches.

LAYOUT, decoded from a real Components capture and CRC-proven 16/16 against it. Each group file is 8
patch bodies of 340 bytes at 512-byte stride, gaps filled 0xFF, the last record unpadded:
7*512 + 340 = 3924 bytes. Group g holds bank slots 8g..8g+7. Sixteen groups = 128 patches.

The owner's three come from the card backups, not from a guess: `00_PATCHBANK.cpb` in
card-backup-2026-07-27T16-49Z / -07-29 / -07-31 are byte-identical to each other, so that bank has
been stable since July.

Output is the 16 .cpb files plus a manifest. It writes NO device; the upload is a separate step.
"""
import json, os, hashlib, zlib

REPO = 'C:/dev/mcp-midi-tools'
FACTORY = f'{REPO}/samples/circuit-tracks/pack0/patches'
OWNER_CPB = f'{REPO}/samples/circuit-ncs/card-backup-2026-07-31/pack1/patchbanks/00_PATCHBANK.cpb'
OUT = f'{REPO}/samples/circuit-tracks/patchbank-all-packs-2026-09-20'

BODY, STRIDE, GROUP_LEN = 340, 512, 3924
BODY_OFF_IN_SYX = 9          # the factory dumps are SysEx frames; the body starts at byte 9

def name_of(body):
    return ''.join(chr(c) for c in body[:16] if 32 <= c < 127).strip()

# ---- the factory 128, indexed by bank slot -------------------------------------------------
factory = {}
for f in os.listdir(FACTORY):
    if not f.endswith('.syx'):
        continue
    n = int(''.join(ch for ch in f if ch.isdigit()))
    raw = open(os.path.join(FACTORY, f), 'rb').read()
    body = raw[BODY_OFF_IN_SYX:BODY_OFF_IN_SYX + BODY]
    assert len(body) == BODY, f'{f}: body is {len(body)} bytes, expected {BODY}'
    factory[n] = body
assert len(factory) == 128, f'expected 128 factory patches, found {len(factory)}'
assert sorted(factory) == list(range(128)), 'factory patch indices are not a clean 0..127'

# ---- the owner's three, lifted out of Pack 1's group 0 --------------------------------------
cpb = open(OWNER_CPB, 'rb').read()
owner = {}
for rec in range(4):                                   # that group is a 4-record fragment
    off = rec * STRIDE
    if off + BODY > len(cpb):
        break
    b = cpb[off:off + BODY]
    owner[rec] = b
mine = {0: owner[0], 2: owner[2], 3: owner[3]}         # slot 1 was PROBE85, ours, dropped
for slot, b in mine.items():
    assert len(b) == BODY
    assert b not in factory.values(), f'slot {slot} ({name_of(b)}) is actually a factory body'
    print(f"  keeping  slot {slot}: {name_of(b):20s} (displaces factory {name_of(factory[slot])})")

bank = dict(factory)
bank.update(mine)

# ---- build the 16 group files ----------------------------------------------------------------
os.makedirs(OUT, exist_ok=True)
manifest = {
    'created': '2026-09-20',
    'purpose': "Factory 128 with the owner's three patches at bank slots 0/2/3, for EVERY pack.",
    'cpb_layout': '8 bodies of 340 B at 512 B stride, 0xFF gap fill, last record unpadded = 3924 B',
    'owner_patches': {str(s): name_of(b) for s, b in mine.items()},
    'displaced_factory': {str(s): name_of(factory[s]) for s in mine},
    'files': [],
}
for g in range(16):
    body = b''
    for r in range(8):
        body += bank[g * 8 + r] + (b'\xff' * (STRIDE - BODY) if r < 7 else b'')
    assert len(body) == GROUP_LEN, f'group {g} is {len(body)} bytes, expected {GROUP_LEN}'
    path = os.path.join(OUT, f'{g:02d}_PATCHBANK.cpb')
    open(path, 'wb').write(body)
    manifest['files'].append({
        'file': f'{g:02d}_PATCHBANK.cpb',
        'group': g,
        'bank_slots': f'{g*8}-{g*8+7}',
        'device_patches': f'{g*8+1}-{g*8+8}',
        'sha256': hashlib.sha256(body).hexdigest(),
        'crc32': f'0x{zlib.crc32(body) & 0xffffffff:08X}',
        'names': [name_of(bank[g * 8 + r]) for r in range(8)],
    })
json.dump(manifest, open(os.path.join(OUT, 'MANIFEST.json'), 'w'), indent=1)

print(f'\n{len(manifest["files"])} group files written to {OUT}')
print('group 0 :', ' | '.join(manifest['files'][0]['names']))
print('group 15:', ' | '.join(manifest['files'][15]['names']))

# ---- cross-check against the July Pack 2 staging, which is CRC-proven against Components -----
REF = f'{REPO}/samples/circuit-tracks/pack2-patch-upload-2026-07-30'
ref = json.load(open(os.path.join(REF, 'MANIFEST.json')))
same = diff = 0
for a, b in zip(manifest['files'], ref['files']):
    if a['sha256'] == b['sha256']:
        same += 1
    else:
        diff += 1
        print(f"  group {a['group']:2d} differs from the CRC-proven factory staging (expected for group 0 only)")
print(f'\nvs the 2026-07-30 factory staging: {same} groups identical, {diff} changed')
print('=> only group 0 should differ; every other group must be byte-identical to the bank')
print('   Novation Components itself sent to this card, which is what makes them trustworthy.')
