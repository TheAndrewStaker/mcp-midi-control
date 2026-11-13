import sys, re, struct, os, glob
from collections import defaultdict
exec(open('mf2.py').read().split("def parse(")[0])

SECT = re.compile(rb'#(VCO|VCF|EG1|EG2|Kbd|Arp|LFO|Gen|Sys|Mat|Co\d)')
REC  = re.compile(rb'([\x41-\x4F])([A-Za-z][A-Za-z0-9]{0,14})c')

def parse(d):
    """Sections are `#XXX`; records are <0x40|len><name>'c'<3-byte LE value>."""
    out = {}; sect = '?'; i = 0
    while i < len(d):
        m = SECT.match(d, i)
        if m: sect = m.group(1).decode(); i = m.end(); continue
        if d[i] == 0x40: i += 1; continue          # section terminator / pad
        m = REC.match(d, i)
        if m and (m.group(1)[0] & 0x0F) == len(m.group(2)):
            v = d[m.end():m.end()+3]
            if len(v) == 3:
                out[f'{sect}.{m.group(2).decode()}'] = int.from_bytes(v, 'little')
            i = m.end()+3; continue
        i += 1
    return out

files = sorted(glob.glob(os.path.expanduser('~/mcp-midi-backups/microfreak-pre-send-2026-08-15T15-22-52/*.syx')))
vals = defaultdict(list); names = {}
for path in files:
    base = os.path.basename(path)
    try:
        f = parse(unpack7(frames_payload(path)))
    except Exception as e:
        continue
    if not f: continue
    names[base] = f
    for k,v in f.items(): vals[k].append(v)

print(f'parsed {len(names)} presets')
for k in ('Gen.PrstVol','Kbd.PresAmp','Kbd.Veloc','Gen.Parafon','Gen.PolyCnt','EG2.Mode','EG2.Legato','VCO.Type','VCF.Type','EG1.Mode','Gen.Volume'):
    v = vals.get(k,[])
    if not v: print(f'{k:<14} MISSING'); continue
    u = sorted(set(v))
    print(f'{k:<14} n={len(v):<4} distinct={len(u):<4} min={min(v)} max={max(v)}  sample={u[:12]}')

# ---------------------------------------------------------------------------
# Decoded 2026-09-12. See docs/_private/MICROFREAK-PRESET-FORMAT-2026-09-12.md
# for the format spec, the evidence, and the library-wide census this produced.
# Research script: the shipping decode belongs in packages/arturia/src/codec/.
# ---------------------------------------------------------------------------
