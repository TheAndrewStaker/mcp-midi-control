"""
build_groove_sets.py — one swappable-pattern .ncs per Sleep Token song.

For each song folder, picks up to 8 grooves spanning simple->complex (by hit
count), reduces each to a 4-voice/32-step Circuit pattern (groove_to_pattern),
and packs them as patterns 1..8 of one .ncs named by the song (song_names).
Output -> samples/circuit-tracks/grooves/<song-slug>.ncs

  python build_groove_sets.py
"""
import glob
import os
import re
import subprocess
import sys

import mido
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from song_names import SONG_NAMES  # noqa: E402

ROOT = r"C:\dev\mcp-midi-tools"
GP = r"C:\Users\Public\Documents\Sleep Token - II\MIDI Files\Sleep Token II - Groove Pack"
OUT = os.path.join(ROOT, "samples", "circuit-tracks", "grooves")
PY = sys.executable


def hits(f):
    return sum(1 for tr in mido.MidiFile(f).tracks for m in tr if m.type == "note_on" and m.velocity > 0)


def main():
    os.makedirs(OUT, exist_ok=True)
    for folder in sorted(glob.glob(os.path.join(GP, "Song*"))):
        base = os.path.basename(folder)
        name = SONG_NAMES.get(base, base)
        slug = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
        grooves = sorted(glob.glob(os.path.join(folder, "*Groove*.mid")))
        if not grooves:
            continue
        ranked = sorted(grooves, key=hits)
        idxs = sorted(set(np.linspace(0, len(ranked) - 1, min(8, len(ranked))).round().astype(int)))
        picks = [ranked[i] for i in idxs]
        jsons = []
        for p in picks:
            subprocess.run([PY, os.path.join(ROOT, "scripts", "groove-analysis", "groove_to_pattern.py"), p],
                           cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            jsons.append(os.path.splitext(p)[0] + ".circuit.json")
        out = os.path.join(OUT, f"{slug}.ncs")
        subprocess.run(["npx", "tsx", "scripts/author-circuit-groove.ts", out] + jsons,
                       cwd=ROOT, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ok = os.path.exists(out)
        print(f"{name:22} ({base})  -> grooves/{slug}.ncs  [{len(picks)} patterns]  {'OK' if ok else 'FAIL'}")


if __name__ == "__main__":
    main()
