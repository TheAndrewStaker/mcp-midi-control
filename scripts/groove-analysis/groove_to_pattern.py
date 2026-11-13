"""
groove_to_pattern.py — reduce a Mixwave groove-pack MIDI to a Circuit Tracks
4-voice / 32-step drum pattern (2 bars @ 16th notes).

Maps the groove's note roles (resolved by metric-position analysis) onto Circuit's
4 drum tracks, quantizes onsets to a 32-step grid, keeps peak velocity per step.
Prints a readable grid and emits JSON for the .ncs authoring step.

Role map (Sleep Token II groove pack, by metric analysis):
  kick=1  snare=3 (+ ghost lane 2)  hat(closed)=14  ride=41

  python groove_to_pattern.py "<groove.mid>" [--accent ride|hat2]
"""
import argparse
import json
import sys
from pathlib import Path

import mido

STEPS = 32          # 2 bars @ 16th
# Groove-pack note map (ear-confirmed via A/B preview): note 1 is the
# double-bass KICK (the most-frequent voice), 3 = snare (beat-3 half-time),
# 14 = closed hat, 41 = ride. 2 = the soft/ghost SNARE lane (re-mapped from
# "busy hat" 2026-11-07: its accents sit on the snare's beat-3/4 steps; evidence
# in packages/core/src/protocol-generic/patterns/drumMapPresets.ts).
# Several groove notes can feed one Circuit drum track.
NOTE_TO_TRACK = {1: "kick", 3: "snare", 14: "hat", 2: "snare", 41: "ride"}
TRACKS = ["kick", "snare", "hat", "ride"]   # Circuit's 4 drum tracks (D1..D4)


def reduce_groove(path):
    m = mido.MidiFile(path)
    step_ticks = m.ticks_per_beat * 4 / 16  # 16th note
    grid = {t: [0] * STEPS for t in TRACKS}
    for tr in m.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                track = NOTE_TO_TRACK.get(msg.note)
                if track:
                    s = int(round(t / step_ticks))
                    if 0 <= s < STEPS:
                        grid[track][s] = max(grid[track][s], msg.velocity)
    return TRACKS, grid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("midi")
    args = ap.parse_args()
    tracks, grid = reduce_groove(args.midi)

    print(f"## {Path(args.midi).name}   (4 voices x {STEPS} steps, 2 bars)")
    print("            " + "".join((str((i // 4 % 4) + 1) if i % 4 == 0 else " ") for i in range(STEPS)))
    for role in tracks:
        row = "".join("#" if v >= 90 else ("+" if v > 0 else ".") for v in grid[role])
        print(f"  {role:>6} |{row}|")
    print("  legend: # accent (vel>=90), + ghost/soft, . rest; numbers = beats")

    out = Path(args.midi).with_suffix(".circuit.json")
    out.write_text(json.dumps({"steps": STEPS, "tracks": {t: grid[t] for t in tracks}}, indent=1))
    print(f"  -> {out.name}")


if __name__ == "__main__":
    main()
