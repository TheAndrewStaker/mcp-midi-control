"""
pack_groove.py — pack a FULL 4-bar (64-step) Sleep Token groove into the Circuit's
4 monophonic drum tracks using per-step SAMPLE FLIP (drum_choice), so we keep the
complete iconic beat (not a 2-bar slice) AND carry more pieces than the old
4-voice reduction.

Model (matches the "piece classes priority" brief):
  - Each track is anchored to a CLASS FAMILY: T1 kick, T2 snare-family, T3 hat-
    family, T4 ride/cymbal-family. A piece prefers its family's track.
  - Per step, firing pieces are placed by PRIORITY (class tier + frequency). A
    piece lands on its family track if free; else any free track via a flip; if
    NO track is free (all 4 already firing) the lowest-priority piece is DROPPED
    and reported — we never merge two co-occurring pieces onto one track.
  - drum_choice = the piece's absolute sample slot when it differs from the
    track's base (a FLIP); 0xFF when the piece IS the track's base sample.

Output: a packed JSON (2 patterns x 4 tracks x 32 steps per groove) for the TS
authoring step, plus a readable report (grids, flips, flagged guesses, drops).

  python pack_groove.py "The Summoning" [out.json]
"""
import json, os, sys, glob, collections
import mido
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from song_names import SONG_NAMES  # folder -> display name

GP = r"C:\Users\Public\Documents\Sleep Token - II\MIDI Files\Sleep Token II - Groove Pack"
NAME_TO_FOLDER = {v: k for k, v in SONG_NAMES.items()}

# Note -> piece. CONFIRMED by ear: 1/3/14/2/41. The rest are BEST-GUESS (flagged).
NOTE_TO_PIECE = {
    1: "kick", 3: "snare", 14: "closed_hat", 2: "busy_hat", 41: "ride",
    13: ("open_hat", "guess: 16th-positioned hat-ish note"),
    20: ("ride_bell", "guess: 94% on quarter-notes = cymbal pulse"),
    7:  ("tom", "weak guess: mid-freq 16ths near beats 3-4"),
    19: ("perc", "weak guess: off-beat, uncertain"),
}
# Frequency-gate: notes below this many hits in the song are skipped (low value,
# high guess-error). Cores are never gated.
MIN_EXTRA_HITS = 10
CORES = {"kick", "snare", "closed_hat", "ride"}

# Sample slots the .ncs flips reference (user loads these on the device).
SAMPLE_SLOT = {
    "kick": 1, "snare": 2, "closed_hat": 3, "ride": 4, "open_hat": 5,
    "busy_hat": 6, "snare_roll": 7, "crash": 8, "tom": 9, "ride_bell": 10,
    "sticks": 11, "china": 12, "perc": 13,
}
# Track families: which track a piece prefers. T1..T4 = 0..3.
TRACK_BASE = ["kick", "snare", "closed_hat", "ride"]   # base sample per track
PREF_TRACK = {
    "kick": 0, "tom": 0,
    "snare": 1, "snare_roll": 1, "sticks": 1, "perc": 1,
    "closed_hat": 2, "busy_hat": 2, "open_hat": 2,
    "ride": 3, "ride_bell": 3, "crash": 3, "china": 3,
}
# Class tier (higher = keep first on overflow). Frequency bump added at runtime.
TIER = {
    "kick": 100, "snare": 90, "snare_roll": 88, "sticks": 86, "closed_hat": 80,
    "busy_hat": 76, "ride": 70, "open_hat": 60, "crash": 50, "tom": 40,
    "ride_bell": 30, "perc": 20, "china": 10,
}


def piece_of(note):
    p = NOTE_TO_PIECE.get(note)
    if p is None:
        return None, None
    if isinstance(p, tuple):
        return p[0], p[1]
    return p, None


def read_groove(mid_path, steps):
    """note -> list of (step 0..steps-1, velocity)."""
    m = mido.MidiFile(mid_path)
    st = m.ticks_per_beat * 4 / 16
    grid = collections.defaultdict(list)
    for tr in m.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                s = int(round(t / st))
                if 0 <= s < steps:
                    grid[msg.note].append((s, msg.velocity))
    return grid


def pack(grid, song_hist, steps):
    """Return (tracks, flags, drops, skips). skips records what we did NOT place,
    so nothing is silently dropped (per the project's no-silent-caps rule)."""
    # Build per-step firing list of pieces (resolve notes -> pieces, gate extras).
    flags = {}
    skips = {"unmapped_notes": collections.Counter(), "frequency_gated": collections.Counter()}
    step_pieces = collections.defaultdict(dict)  # step -> piece -> velocity (max)
    for note, hits in grid.items():
        piece, flag = piece_of(note)
        if piece is None:
            skips["unmapped_notes"][note] += len(hits)  # note has no piece mapping
            continue
        if piece not in CORES and song_hist.get(note, 0) < MIN_EXTRA_HITS:
            skips["frequency_gated"][piece] += len(hits)  # below MIN_EXTRA_HITS, omitted
            continue
        if flag:
            flags[piece] = f"note {note} -> {piece} ({flag})"
        for s, v in hits:
            step_pieces[s][piece] = max(step_pieces[s].get(piece, 0), v)

    # Priority = tier + frequency bump (0..15 by how often the piece fires).
    maxhits = max((len(h) for h in grid.values()), default=1)
    def freq_of(piece):
        return sum(len(grid[n]) for n in grid if piece_of(n)[0] == piece)
    def score(piece):
        return TIER.get(piece, 0) + (freq_of(piece) / maxhits) * 15

    tracks = [[None] * steps for _ in range(4)]
    drops = []
    for s in range(steps):
        firing = sorted(step_pieces[s].items(), key=lambda kv: -score(kv[0]))
        used = {}
        for piece, vel in firing:
            pt = PREF_TRACK.get(piece, 1)
            if pt not in used:
                tt = pt
            else:
                free = [t for t in range(4) if t not in used]
                if not free:
                    drops.append((s, piece))
                    continue
                # nearest free track to the preference keeps families together
                tt = min(free, key=lambda t: abs(t - pt))
            used[tt] = piece
            flip = None if piece == TRACK_BASE[tt] else SAMPLE_SLOT[piece]
            tracks[tt][s] = {"piece": piece, "velocity": vel, "flip_slot": flip}
    return tracks, flags, drops, skips


def grid_str(track, lo, hi):
    out = []
    for s in range(lo, hi):
        c = track[s]
        if c is None:
            out.append(".")
        elif c["flip_slot"] is None:
            out.append("X" if c["velocity"] >= 90 else "x")   # base sample
        else:
            out.append(c["piece"][0].upper())                  # flip: piece initial
    return "".join(out)


def hit_count(mid):
    return sum(1 for tr in mido.MidiFile(mid).tracks for m in tr if m.type == "note_on" and m.velocity > 0)


def main():
    song = sys.argv[1] if len(sys.argv) > 1 else "The Summoning"
    mode = sys.argv[2] if len(sys.argv) > 2 else "full"      # full (4x 4-bar) | chopped (8x 2-bar)
    out_path = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), "_packed.json")
    steps = 64 if mode == "full" else 32
    n_grooves = 4 if mode == "full" else 8

    folder = os.path.join(GP, NAME_TO_FOLDER[song])
    sections = sorted(glob.glob(os.path.join(folder, "*Groove*.mid")), key=hit_count)  # simple -> complex
    if not sections:
        raise SystemExit(f"no groove MIDIs in {folder}")
    idx = sorted(set(np.linspace(0, len(sections) - 1, min(n_grooves, len(sections))).round().astype(int)))
    chosen = [sections[i] for i in idx]

    # Song-wide note histogram (frequency gate) over all sections in the folder.
    song_hist = collections.Counter()
    for mid in sections:
        for note, hits in read_groove(mid, 64).items():
            song_hist[note] += len(hits)

    out = {"song": song, "mode": mode, "sample_layout": SAMPLE_SLOT, "track_base": TRACK_BASE, "grooves": []}
    print(f"# {song} — {len(chosen)} {'full 4-bar' if mode == 'full' else '2-bar'} grooves (packed, {mode})\n")
    all_flags = {}
    all_unmapped = collections.Counter()
    all_gated = collections.Counter()
    for gi, mid in enumerate(chosen):
        grid = read_groove(mid, steps)
        tracks, flags, drops, skips = pack(grid, song_hist, steps)
        all_flags.update(flags)
        all_unmapped.update(skips["unmapped_notes"])
        all_gated.update(skips["frequency_gated"])
        name = os.path.basename(mid).replace(".mid", "")
        print(f"## Groove {gi+1} — {name}")
        for t in range(4):
            rows = "".join(f"{grid_str(tracks[t], h*32, h*32+32)}|" for h in range(steps // 32))
            print(f"  T{t+1} [{TRACK_BASE[t]:10s}] |{rows}")
        if drops:
            print(f"  DROPS (all 4 tracks busy): {dict(collections.Counter(p for _, p in drops))}")
        if skips["unmapped_notes"]:
            print(f"  UNMAPPED notes (no piece, omitted): {dict(skips['unmapped_notes'])}")
        if skips["frequency_gated"]:
            print(f"  FREQUENCY-GATED (below {MIN_EXTRA_HITS} hits, omitted): {dict(skips['frequency_gated'])}")
        print()
        patterns = []
        for half in range(steps // 32):
            lo = half * 32
            ptracks = []
            for t in range(4):
                cells = []
                for s in range(lo, lo + 32):
                    c = tracks[t][s]
                    cells.append(None if c is None else {"velocity": c["velocity"], "flip_slot": c["flip_slot"]})
                ptracks.append({"track": t, "base": TRACK_BASE[t], "steps": cells})
            patterns.append(ptracks)
        out["grooves"].append({"name": name, "source": name, "patterns": patterns,
                                "drops": [{"step": s, "piece": p} for s, p in drops]})

    print("## Flagged best-guess pieces (review):")
    for piece, msg in sorted(all_flags.items()):
        print(f"  - {piece}: {msg}")
    print("\nLegend: lower-case = base sample (track's class), UPPER initial = sample FLIP")
    print("  (K=kick S=snare/snare_roll/sticks O=open_hat B=busy_hat R=ride/ride_bell T=tom P=perc C=crash)")
    json.dump(out, open(out_path, "w"), indent=1)
    print(f"\n-> {out_path}")


if __name__ == "__main__":
    main()
