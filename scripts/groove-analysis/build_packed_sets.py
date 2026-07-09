"""
build_packed_sets.py — sweep ALL Sleep Token songs into PACKED groove projects
(sample-flip; more pieces than the 4-voice reduction), in two variants:

  - <slug>__full4bar.ncs : 4 FULL 4-bar grooves (each = a chained pattern PAIR);
    auto-advancing complete beats. THE DEFAULT.
  - <slug>__chop2bar.ncs : 8 short 2-bar grooves (one pattern each); max flip
    variety.

Output -> samples/circuit-tracks/grooves/packed/   (the user assigns slots later;
33-42 are reserved as the original-set backup.)

  python build_packed_sets.py
"""
import os, re, sys, subprocess
sys.path.insert(0, os.path.dirname(__file__))
from song_names import SONG_NAMES

ROOT = r"C:\dev\mcp-midi-tools"
HERE = os.path.dirname(__file__)
OUT = os.path.join(ROOT, "samples", "circuit-tracks", "grooves", "packed")
PY = sys.executable


def slug(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


def build(song, mode, suffix):
    s = slug(song)
    jpath = os.path.join(HERE, f"_packed_{s}_{mode}.json")
    ncs = os.path.join(OUT, f"{s}__{suffix}.ncs")
    r1 = subprocess.run([PY, os.path.join(HERE, "pack_groove.py"), song, mode, jpath],
                        cwd=ROOT, capture_output=True, text=True)
    if r1.returncode != 0:
        print(f"  {song:22} {mode:7} PACK FAIL: {r1.stderr.strip()[:120]}"); return False
    r2 = subprocess.run(["npx", "tsx", "scripts/author-circuit-groove-packed.ts", jpath, ncs],
                        cwd=ROOT, shell=True, capture_output=True, text=True)
    ok = os.path.exists(ncs) and r2.returncode == 0
    print(f"  {song:22} {mode:7} -> packed/{os.path.basename(ncs):32} {'OK' if ok else 'FAIL ' + r2.stderr.strip()[:120]}")
    # Surface pack_groove's drop/skip/flag report (never swallow it - no silent caps).
    for line in r1.stdout.splitlines():
        s = line.strip()
        if s.startswith(("DROPS", "UNMAPPED", "FREQUENCY-GATED")):
            print(f"        {s}")
    flagged = [l.strip() for l in r1.stdout.splitlines() if l.strip().startswith("- ")]
    if flagged:
        print(f"        flagged best-guess pieces: {len(flagged)} (run pack_groove.py {song!r} {mode} to review)")
    return ok


def main():
    os.makedirs(OUT, exist_ok=True)
    songs = list(SONG_NAMES.values())
    print(f"Building packed sets for {len(songs)} songs x 2 variants -> {OUT}\n")
    n = 0
    for song in songs:
        if build(song, "full", "full4bar"): n += 1
        if build(song, "chopped", "chop2bar"): n += 1
    print(f"\n{n}/{len(songs)*2} packed projects written.")
    print("Assign to slots on the device with upload_project (avoid 33-42, the original backup).")
    print("Load the 1..13 sample layout (Drum > Preset) so the flips sound; see any _packed_*.json sample_layout.")


if __name__ == "__main__":
    main()
