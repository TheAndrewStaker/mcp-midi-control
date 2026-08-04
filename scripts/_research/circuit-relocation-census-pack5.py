#!/usr/bin/env python3
"""
Pack 5 relocation census (2026-07-29 backup). READ-ONLY: opens files, prints a report.

Per song, does what the After Dark rebuild plan (section 0) did by hand:
  1. Full-file pairwise byte diff of every project pair within a song, with each
     differing byte classified against the shipped .ncs layout
     (packages/circuit-tracks/src/ncs/format.ts, chain.ts, notePattern.ts,
     drumPattern.ts) and a per-byte deadness verdict.
  2. Per-track 896-byte (note) / 144-byte (drum) pattern-cell hash census with
     After-Dark-style letter tables and distinct-cell counts.
  3. Pair verdicts: DUPLICATE / NEAR-DUP (dead+name/colour only) /
     CHAIN-ONLY (dead+name/colour+chain-table) / REAL.

Deadness rules are CONSERVATIVE, each grounded in the codec:
  - name 0x10..0x2f, colour 0x0c..0x0f: patchable by design (the relocation method).
  - note-cell byte in a slot whose slotMask bit is 0 in BOTH files: dead
    (mask is authoritative; notePattern.ts header).
  - note-cell probability/slot bytes on a step with slotMask 0 in both: dead.
  - drum-cell velocity/probability/choice byte on a step whose rhythm micro-hit
    mask is 0 in both: dead (no hit; drumPattern.ts).
  - chain-table / pattern-metadata / drum-binding / drum-level bytes on a track
    with ZERO active content in both files: dead (After Dark plan sec. 0 precedent).
  - 0x26fc7: last-selected-drum-sample UI byte (chain.ts CHAIN_TAIL note): dead-UI.
  - everything else: NOT provably dead -> REAL.
"""
import hashlib
import itertools
import json
import sys
from pathlib import Path

ROOT = Path("C:/dev/mcp-midi-tools/samples/circuit-ncs/card-backup-2026-07-29")
NCS_SIZE = 160_780
STEPS = 32
PATS = 8

META_OFFSETS = [
    # synth blocks 0-15
    0x664, 0x130C, 0x1FB4, 0x2C5C, 0x3904, 0x45AC, 0x5254, 0x5EFC,
    0x6BA4, 0x784C, 0x84F4, 0x919C, 0x9E44, 0xAAEC, 0xB794, 0xC43C,
    # drum blocks 16-47
    0xCDF4, 0xD49C, 0xDB44, 0xE1EC, 0xE894, 0xEF3C, 0xF5E4, 0xFC8C,
    0x10334, 0x109DC, 0x11084, 0x1172C, 0x11DD4, 0x1247C, 0x12B24, 0x131CC,
    0x13874, 0x13F1C, 0x145C4, 0x14C6C, 0x15314, 0x159BC, 0x16064, 0x1670C,
    0x16DB4, 0x1745C, 0x17B04, 0x181AC, 0x18854, 0x18EFC, 0x195A4, 0x19C4C,
    # midi blocks 48-63
    0x1A5FC, 0x1B2A4, 0x1BF4C, 0x1CBF4, 0x1D89C, 0x1E544, 0x1F1EC, 0x1FE94,
    0x20B3C, 0x217E4, 0x2248C, 0x23134, 0x23DDC, 0x24A84, 0x2572C, 0x263D4,
]
NOTE_REGION = 896   # 32 steps x 28 bytes, ends at META_OFFSETS[block]
DRUM_REGION = 144   # 16-byte header + 4 x 32 rows, ends at META_OFFSETS[block]
NOTE_STEP_BYTES = 28

# block index -> (track name, pattern 0-based)
def block_track(b):
    if b < 8: return ("synth1", b)
    if b < 16: return ("synth2", b - 8)
    if b < 48:
        d = (b - 16) // 8
        return (f"drum{d+1}", (b - 16) % 8)
    if b < 56: return ("midi1", b - 48)
    return ("midi2", b - 56)

NOTE_TRACKS = ["synth1", "synth2", "midi1", "midi2"]
DRUM_TRACKS = ["drum1", "drum2", "drum3", "drum4"]
CHAIN_BASE = 0x2C4  # 8 slots x 4 bytes [start,end,0,0]; synth1,synth2,midi1,midi2,drum1..4
CHAIN_ORDER = NOTE_TRACKS + DRUM_TRACKS

KNOWN = {  # exact single offsets / small windows in header + tail
    "colour": range(0x0C, 0x10),
    "name": range(0x10, 0x30),
    "tempo": range(0x34, 0x35),
    "swing?": range(0x35, 0x36),
    "drum_binding": range(0x1A278, 0x1A27C),
    "scale_root": range(0x26D0C, 0x26D0E),
    "synth1_patch": range(0x26D14, 0x26D14 + 340),
    "synth2_patch": range(0x26E68, 0x26E68 + 340),
    "session_ui_0x26fc7": range(0x26FC7, 0x26FC8),
    "synth_levels": range(0x2701C, 0x2701E),
}
DRUM_LEVEL_OFFS = {0x26FBD + n * 11: n for n in range(4)}  # drum1..4 mixer level

def cell_bounds(b):
    meta = META_OFFSETS[b]
    size = DRUM_REGION if 16 <= b < 48 else NOTE_REGION
    return meta - size, meta

# metadata region of block b: [META_OFFSETS[b], next block's cell start)
def meta_bounds(b):
    start = META_OFFSETS[b]
    if b + 1 < 64:
        end = cell_bounds(b + 1)[0]
    else:
        end = 0x26D0C  # tail landmark after the last midi2 metadata region
    return start, end

def load(path):
    data = path.read_bytes()
    assert len(data) == NCS_SIZE, f"{path}: {len(data)} bytes"
    return data

def note_track_active(buf, track):
    """Any step in any of the track's 8 patterns with slotMask != 0."""
    base_block = {"synth1": 0, "synth2": 8, "midi1": 48, "midi2": 56}[track]
    for p in range(PATS):
        start, _ = cell_bounds(base_block + p)
        for s in range(STEPS):
            if buf[start + s * NOTE_STEP_BYTES] != 0:
                return True
    return False

def drum_track_active(buf, d):  # d = 0..3
    for p in range(PATS):
        start, _ = cell_bounds(16 + d * 8 + p)
        rhythm = buf[start + 16 + 96: start + 16 + 128]
        if any(rhythm):
            return True
    return False

def track_active(buf, track):
    if track in NOTE_TRACKS:
        return note_track_active(buf, track)
    return drum_track_active(buf, int(track[-1]) - 1)

def classify(off, a, b):
    """Classify one differing byte offset. Returns (klass, detail, dead:bool)."""
    for name, rng in KNOWN.items():
        if off in rng:
            if name in ("colour", "name"):
                return (name, name, True)  # patchable-by-design
            if name == "session_ui_0x26fc7":
                return ("session_ui", "0x26fc7 last-selected-drum-sample UI byte (chain.ts)", True)
            if name == "drum_binding":
                dead = not any(drum_track_active(x, d) for x in (a, b) for d in range(4))
                return ("drum_binding", f"drum binding byte {off - 0x1A278}", dead)
            if name == "synth_levels":
                t = "synth1" if off == 0x2701C else "synth2"
                return ("mixer", f"{t} mixer level", False)  # never auto-dead
            return (name, name, False)
    if off in DRUM_LEVEL_OFFS:
        d = DRUM_LEVEL_OFFS[off]
        dead = not (drum_track_active(a, d) or drum_track_active(b, d))
        return ("drum_level", f"drum{d+1} mixer level", dead)
    if CHAIN_BASE <= off < CHAIN_BASE + 32:
        slot = (off - CHAIN_BASE) // 4
        track = CHAIN_ORDER[slot]
        which = ["start", "end", "pad", "pad"][(off - CHAIN_BASE) % 4]
        dead = not (track_active(a, track) or track_active(b, track))
        return ("chain", f"chain {track} {which} ({a[off]} vs {b[off]})", dead)
    for blk in range(64):
        cs, ce = cell_bounds(blk)
        track, pat = block_track(blk)
        if cs <= off < ce:
            if track.startswith("drum"):
                rel = off - cs
                if rel < 16:
                    return ("drum_cell_hdr", f"{track} P{pat+1} cell header +{rel}", False)
                row, step = divmod(rel - 16, 32)
                rname = ["velocity", "probability", "choice", "rhythm"][row]
                rhy = cs + 16 + 96 + step
                dead = rname != "rhythm" and a[rhy] == 0 and b[rhy] == 0
                return ("drum_cell", f"{track} P{pat+1} step{step+1} {rname}"
                        + (" [no hit both]" if dead else ""), dead)
            step, rel = divmod(off - cs, NOTE_STEP_BYTES)
            mask_a = a[cs + step * NOTE_STEP_BYTES]
            mask_b = b[cs + step * NOTE_STEP_BYTES]
            if rel == 0:
                return ("note_cell", f"{track} P{pat+1} step{step+1} slotMask "
                        f"({mask_a:#04x} vs {mask_b:#04x})", False)
            if rel < 4:
                fld = ["", "probability", "hdr2", "hdr3"][rel]
                dead = mask_a == 0 and mask_b == 0 and rel == 1
                return ("note_cell", f"{track} P{pat+1} step{step+1} {fld}"
                        + (" [step inactive both]" if dead else ""), dead)
            slot, lane = divmod(rel - 4, 4)
            lname = ["note", "gate", "delay", "velocity"][lane]
            dead = not ((mask_a >> slot) & 1) and not ((mask_b >> slot) & 1)
            return ("note_cell", f"{track} P{pat+1} step{step+1} slot{slot} {lname}"
                    + (" [slot masked off both]" if dead else ""), dead)
        ms, me = meta_bounds(blk)
        if ms <= off < me:
            dead = not (track_active(a, track) or track_active(b, track))
            what = "LENGTH byte" if off == ms else f"meta+{off - ms:#x}"
            return ("pattern_meta", f"{track} P{pat+1} {what} ({a[off]:#04x} vs {b[off]:#04x})"
                    + (" [track empty both]" if dead else ""), dead)
    return ("unknown", f"unmapped offset {off:#x} ({a[off]:#04x} vs {b[off]:#04x})", False)

def diff_pair(a, b):
    return [i for i in range(NCS_SIZE) if a[i] != b[i]]

def cell_hash(buf, blk):
    s, e = cell_bounds(blk)
    return hashlib.md5(buf[s:e]).hexdigest()

def cell_empty(buf, blk):
    s, _ = cell_bounds(blk)
    track, _p = block_track(blk)
    if track.startswith("drum"):
        return not any(buf[s + 16 + 96: s + 16 + 128])
    return all(buf[s + st * NOTE_STEP_BYTES] == 0 for st in range(STEPS))

def oracle_selfcheck():
    """Validate the diff harness against the After Dark plan's hand-verified
    pack2 ground truth (after-dark-rebuild-plan-2026-07-29.md section 0):
    P3~P5 = exactly 1 byte at 0x1b (name digit); P2~P4 = 10 bytes, all
    name / dead-chain / dead-pattern-meta (midi1 empty on both)."""
    p2 = load(ROOT / "pack2/proj02__01_SESSION.ncs")
    p3 = load(ROOT / "pack2/proj03__02_SESSION.ncs")
    p4 = load(ROOT / "pack2/proj04__03_SESSION.ncs")
    p5 = load(ROOT / "pack2/proj05__04_SESSION.ncs")
    d35 = diff_pair(p3, p5)
    assert d35 == [0x1B], f"oracle P3~P5: {[hex(o) for o in d35]}"
    k, _, _ = classify(0x1B, p3, p5)
    assert k == "name", k
    d24 = diff_pair(p2, p4)
    assert len(d24) == 10, f"oracle P2~P4: {len(d24)} bytes {[hex(o) for o in d24]}"
    expected = [0x1B, 0x2CD] + [0x1A5FC, 0x1B2A4, 0x1BF4C, 0x1CBF4,
                                0x1D89C, 0x1E544, 0x1F1EC, 0x1FE94]
    assert sorted(d24) == sorted(expected), [hex(o) for o in d24]
    for off in d24:
        k, det, dead = classify(off, p2, p4)
        assert k == "name" or dead, (hex(off), k, det, dead)
    print("ORACLE SELF-CHECK PASSED: pack2 After Dark P3~P5 (1 name byte) and "
          "P2~P4 (10 bytes, all name/dead) reproduce the plan's section 0.")

def sounding_track_check(song, slots, bufs):
    """Item-3 check, explicit: pairs where EVERY sounding track's 8-cell hash
    sequence is identical (only chains/dead/name/colour could then differ)."""
    base_of = {"synth1": 0, "synth2": 8, "midi1": 48, "midi2": 56,
               "drum1": 16, "drum2": 24, "drum3": 32, "drum4": 40}
    found = False
    for x, y in itertools.combinations(slots, 2):
        ok = True
        for track, base in base_of.items():
            ax, ay = track_active(bufs[x], track), track_active(bufs[y], track)
            if not (ax or ay):
                continue
            if ax != ay:
                ok = False
                break
            for p in range(PATS):
                if cell_hash(bufs[x], base + p) != cell_hash(bufs[y], base + p):
                    ok = False
                    break
            if not ok:
                break
        if ok:
            found = True
            print(f"  ITEM-3 CANDIDATE {x}~{y}: all sounding tracks cell-identical")
    if not found:
        print(f"  item-3: NO pair in {song} has all sounding tracks cell-identical")

def main():
    manifest = json.loads((ROOT / "manifest.json").read_text())
    pack5 = next(p for p in manifest["packs"] if p["device_pack"] == 5)
    projects = {pr["device_project"]: (pr["embedded_name"], ROOT / pr["file"].replace("pack5/", "pack5/"))
                for pr in pack5["projects"]}
    bufs = {slot: load(ROOT / next(pr["file"] for pr in pack5["projects"]
                                   if pr["device_project"] == slot))
            for slot in projects}

    songs = {
        "Stranglehold": [1, 2, 3, 4, 5, 6],
        "Amber": [8, 9, 10, 11, 12],
        "CaughtGlim": [14, 15, 16, 17],
        "IBelieve": [19, 20, 21, 22, 23, 24, 25],
        "ClintEastwood": [27, 28, 29, 30, 31, 32, 33, 34],
        "Breakdown": [35, 36, 37, 38, 39],
        "Sugar": [7, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55],
        "Offering": [57, 58, 59, 60, 61, 62, 63],
        "TESTS": [41, 42, 43, 44, 45],
    }
    # roster check: every occupied slot accounted for exactly once
    listed = sorted(s for sl in songs.values() for s in sl)
    assert listed == sorted(projects), (listed, sorted(projects))

    oracle_selfcheck()

    # ---- targeted detail: the slot-7 question (task #34) ----
    a, b = bufs[7], bufs[47]
    offs = diff_pair(a, b)
    print(f"\nSLOT 7 ('Sugar 2/10') vs SLOT 47 ('Sugar 2/10'): {len(offs)} differing bytes")
    print(f"  synth levels: s7=({a[0x2701C]},{a[0x2701D]}) s47=({b[0x2701C]},{b[0x2701D]})")
    by_cell = {}
    for off in offs:
        k, det, dead = classify(off, a, b)
        key = det.split(" step")[0] if k == "note_cell" else det
        by_cell.setdefault(key, []).append(off)
    for key, lst in sorted(by_cell.items(), key=lambda kv: kv[1][0]):
        print(f"  {key}: {len(lst)} bytes ({min(lst):#x}..{max(lst):#x})")

    for song, slots in songs.items():
        print("=" * 100)
        print(f"SONG {song}: slots {slots}")
        for s in slots:
            print(f"  slot {s:2d} = {projects[s][0]!r}  tempo={bufs[s][0x34]}  colour={bufs[s][0x0C]}")
        if song == "TESTS":
            continue

        # ---- pairwise full-file diff ----
        verdicts = {}
        for x, y in itertools.combinations(slots, 2):
            a, b = bufs[x], bufs[y]
            offs = diff_pair(a, b)
            n = len(offs)
            if n == 0:
                verdicts[(x, y)] = "DUPLICATE"
                print(f"  PAIR {x:2d}~{y:2d}: IDENTICAL (0 bytes)")
                continue
            classes = {}
            all_dead_or_patch = True
            chain_only_extra = True
            details = []
            for off in offs:
                k, det, dead = classify(off, a, b)
                classes[k] = classes.get(k, 0) + 1
                if not dead and k not in ("name", "colour"):
                    all_dead_or_patch = False
                    if k != "chain":
                        chain_only_extra = False
                if n <= 64:
                    details.append((off, det, dead))
            if all_dead_or_patch:
                v = "NEAR-DUP (name/colour/dead only)"
            elif chain_only_extra:
                v = "CHAIN-ONLY (plus name/colour/dead)"
            else:
                v = "REAL"
            verdicts[(x, y)] = v
            summ = ", ".join(f"{k}:{c}" for k, c in sorted(classes.items()))
            print(f"  PAIR {x:2d}~{y:2d}: {n} bytes | {summ} | {v}")
            if n <= 64:
                for off, det, dead in details:
                    print(f"      {off:#08x}  {'DEAD ' if dead else 'LIVE '} {det}")

        # ---- per-track cell letter census ----
        print(f"  --- cell census ({song}) ---")
        for track in NOTE_TRACKS + DRUM_TRACKS:
            base = {"synth1": 0, "synth2": 8, "midi1": 48, "midi2": 56,
                    "drum1": 16, "drum2": 24, "drum3": 32, "drum4": 40}[track]
            letters = {}
            rows = []
            distinct = set()
            for s in slots:
                cells = []
                for p in range(PATS):
                    blk = base + p
                    if cell_empty(bufs[s], blk):
                        cells.append(".")
                        continue
                    h = cell_hash(bufs[s], blk)
                    if h not in letters:
                        letters[h] = chr(ord("A") + len(letters)) if len(letters) < 26 \
                            else chr(ord("a") + len(letters) - 26)
                    distinct.add(h)
                    cells.append(letters[h])
                rows.append((s, " ".join(cells)))
            if distinct or any("." not in r[1].replace(" ", "") is False for r in rows):
                pass
            print(f"    {track:7s} distinct={len(distinct):2d}  "
                  + " | ".join(f"s{s}:[{c}]" for s, c in rows))
        sounding_track_check(song, slots, bufs)
        # surface any 'unknown' offsets so nothing stays unexplained
        for x, y in itertools.combinations(slots, 2):
            unk = [(off, bufs[x][off], bufs[y][off]) for off in diff_pair(bufs[x], bufs[y])
                   if classify(off, bufs[x], bufs[y])[0] == "unknown"]
            if unk:
                print(f"  UNKNOWN bytes {x}~{y}: "
                      + ", ".join(f"{o:#x}({va:#04x} vs {vb:#04x})" for o, va, vb in unk))
    print("=" * 100)
    print("Slot 7 vs slot 47 settled above in the Sugar section.")

if __name__ == "__main__":
    sys.exit(main())
