"""Fast-figure census across MIDI groove libraries.

For the "auto-bake fast figures through the engine" pipeline: scan every groove
MIDI, find runs of same-voice onsets fast enough that a single-sample hardware
pad would machine-gun/comb (the research "forbidden zone", ~<=75 ms inter-onset,
i.e. 32nd-and-faster), and capture each run's rhythm + REAL velocities so we can
(a) census what baked figures are needed and (b) settle whether the dynamics are
an even ramp or a RUDIMENT (accent/ghost pattern).

Usage:  py scripts/_research/fast_figure_census.py <midi_dir> [<midi_dir> ...]
Writes: scripts/groove-analysis/fast_figure_census.json  (+ prints a summary)
"""
import sys, json, glob, os
from collections import defaultdict
import mido

# A figure = >=MIN_HITS onsets on one note whose consecutive gaps are all
# <= MAX_GAP_MS (forbidden zone). 75 ms ~ a 32nd at 100 bpm / 64th at 200 bpm.
MIN_HITS = 4
MAX_GAP_MS = 75.0

GM = {35:"kick",36:"kick",38:"snare",40:"snare",37:"sidestick",39:"clap",
      42:"hat_closed",44:"hat_pedal",46:"hat_open",41:"tom_lo",43:"tom_lo",45:"tom_mid",
      47:"tom_mid",48:"tom_hi",50:"tom_hi",49:"crash",57:"crash",51:"ride",59:"ride",
      52:"china",53:"ride_bell",55:"splash",54:"tamb",56:"cowbell",25:"snare_roll"}


def note_events(path):
    """Return (list of (t_sec, note, vel), tempo_bpm_est). Merges all tracks; uses
    absolute seconds honoring tempo changes."""
    mid = mido.MidiFile(path)
    tpb = mid.ticks_per_beat
    # Build an absolute-time event list across all tracks, tracking tempo.
    events = []
    tempos = []
    # mido.merge_tracks + iterate with running tempo.
    tempo = 500000  # default 120 bpm
    t = 0.0
    for msg in mido.merge_tracks(mid.tracks):
        t += mido.tick2second(msg.time, tpb, tempo)
        if msg.type == "set_tempo":
            tempo = msg.tempo
            tempos.append(tempo)
        elif msg.type == "note_on" and msg.velocity > 0:
            events.append((t, msg.note, msg.velocity))
    bpm = round(60_000_000 / (sum(tempos)/len(tempos))) if tempos else 120
    return events, bpm


def detect_figures(events):
    """Per-note, find runs of onsets with all consecutive gaps <= MAX_GAP_MS."""
    by_note = defaultdict(list)
    for t, note, vel in events:
        by_note[note].append((t, vel))
    figures = []
    for note, hits in by_note.items():
        hits.sort()
        # Merge near-coincident onsets (layered velocities / flam graces < 8 ms):
        # they are one strike, not a fast run. Keep the loudest.
        merged = [hits[0]]
        for h in hits[1:]:
            if (h[0] - merged[-1][0]) * 1000 < 8.0:
                if h[1] > merged[-1][1]:
                    merged[-1] = h
            else:
                merged.append(h)
        hits = merged
        run = [hits[0]]
        for i in range(1, len(hits)):
            gap_ms = (hits[i][0] - run[-1][0]) * 1000
            if gap_ms <= MAX_GAP_MS:
                run.append(hits[i])
            else:
                if len(run) >= MIN_HITS:
                    figures.append((note, run))
                run = [hits[i]]
        if len(run) >= MIN_HITS:
            figures.append((note, run))
    return figures


def main():
    dirs = sys.argv[1:]
    if not dirs:
        print("usage: fast_figure_census.py <midi_dir> ...")
        return
    paths = []
    for d in dirs:
        paths += glob.glob(os.path.join(d, "**", "*.mid"), recursive=True)
        paths += glob.glob(os.path.join(d, "**", "*.midi"), recursive=True)
    print(f"scanning {len(paths)} MIDI file(s)\n")

    records = []
    errors = 0
    for p in sorted(paths):
        try:
            events, bpm = note_events(p)
        except Exception as e:
            errors += 1
            continue
        for note, run in detect_figures(events):
            times = [h[0] for h in run]
            vels = [h[1] for h in run]
            gaps_ms = [(times[i+1]-times[i])*1000 for i in range(len(times)-1)]
            avg_gap = sum(gaps_ms)/len(gaps_ms)
            records.append({
                "file": os.path.relpath(p, os.path.commonpath(dirs)) if len(dirs) == 1 else os.path.basename(p),
                "lib": os.path.basename(os.path.dirname(os.path.dirname(p))) or os.path.basename(os.path.dirname(p)),
                "note": note, "voice": GM.get(note, f"note{note}"),
                "bpm": bpm, "n_hits": len(run),
                "span_ms": round((times[-1]-times[0])*1000, 1),
                "avg_gap_ms": round(avg_gap, 1),
                "rate_hz": round(1000/avg_gap, 1),
                "vels": vels,
            })

    out = "scripts/groove-analysis/fast_figure_census.json"
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(records, f, indent=1)

    # ---- summary ----
    print(f"{len(records)} fast figure(s) found across {len(paths)-errors} files ({errors} unreadable)\n")
    byvoice = defaultdict(int)
    byhits = defaultdict(int)
    for r in records:
        byvoice[r["voice"]] += 1
        byhits[r["n_hits"]] += 1
    print("by voice:", dict(sorted(byvoice.items(), key=lambda x:-x[1])))
    print("by hit-count:", dict(sorted(byhits.items())))
    # velocity-shape signal: for each figure, is max velocity at the END (ramp),
    # or MID-run (rudiment/accent)? and how much internal variation (even vs spiky)?
    end_max = mid_max = 0
    spiky = even = 0
    for r in records:
        v = r["vels"]
        if len(v) < 3: continue
        peak_idx = v.index(max(v))
        if peak_idx >= len(v)-1: end_max += 1
        else: mid_max += 1
        rng = max(v) - min(v)
        (spiky if rng >= 30 else even).__class__  # noop to keep names
        if rng >= 30: spiky += 1
        else: even += 1
    print(f"\nvelocity shape: peak-at-END(ramp)={end_max}  peak-MID-run(rudiment)={mid_max}")
    print(f"velocity spread: spiky(range>=30)={spiky}  even(range<30)={even}")
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
