"""Do II / the groove libraries play fast ALTERNATING two-kick bursts?

The per-note fast-figure census misses them: an L/R double-kick (note 36 then 35,
alternating) shows up as two HALF-rate single-note streams. This merges the two
kick pieces (GM 35=kick2/left, 36=kick/right — ST II uses exactly these) into one
time-ordered stream and detects fast runs there, reporting the L/R note pattern so
we can see genuine alternation vs a repeated single kick.

Usage: py scripts/_research/kick_alternation_census.py <midi_dir> [<midi_dir> ...]
"""
import sys, glob, os
from collections import defaultdict
import mido

KICKS = {35, 36}          # both kick pieces
MIN_HITS = 4
MAX_GAP_MS = 75.0


def kick_stream(path):
    mid = mido.MidiFile(path)
    tpb = mid.ticks_per_beat
    tempo = 500000
    t = 0.0
    hits = []          # (t_sec, note, vel)
    tempos = []
    for msg in mido.merge_tracks(mid.tracks):
        t += mido.tick2second(msg.time, tpb, tempo)
        if msg.type == "set_tempo":
            tempo = msg.tempo; tempos.append(tempo)
        elif msg.type == "note_on" and msg.velocity > 0 and msg.note in KICKS:
            hits.append((t, msg.note, msg.velocity))
    bpm = round(60_000_000/(sum(tempos)/len(tempos))) if tempos else 120
    return hits, bpm


def runs(hits):
    hits.sort()
    # merge coincident (<8ms) keeping loudest
    merged = [hits[0]] if hits else []
    for h in hits[1:]:
        if (h[0]-merged[-1][0])*1000 < 8.0:
            if h[1] > merged[-1][1]: merged[-1] = h
        else:
            merged.append(h)
    out, run = [], [merged[0]] if merged else []
    for h in merged[1:]:
        if (h[0]-run[-1][0])*1000 <= MAX_GAP_MS:
            run.append(h)
        else:
            if len(run) >= MIN_HITS: out.append(run)
            run = [h]
    if len(run) >= MIN_HITS: out.append(run)
    return out


def main():
    dirs = sys.argv[1:]
    paths = []
    for d in dirs:
        paths += glob.glob(os.path.join(d, "**", "*.mid"), recursive=True)
    print(f"scanning {len(paths)} MIDI(s) for fast MERGED-kick runs\n")

    total = alternating = single = 0
    by_lib = defaultdict(lambda: [0, 0])  # lib -> [alt, single]
    examples = []
    for p in sorted(paths):
        try:
            hits, bpm = kick_stream(p)
        except Exception:
            continue
        for run in runs(hits):
            total += 1
            notes = [h[1] for h in run]
            vels = [h[2] for h in run]
            gaps = [(run[i+1][0]-run[i][0])*1000 for i in range(len(run)-1)]
            avg = sum(gaps)/len(gaps)
            # alternation: how often consecutive notes differ
            flips = sum(1 for i in range(len(notes)-1) if notes[i] != notes[i+1])
            is_alt = flips >= len(notes)-1  # strictly alternating
            lib = os.path.basename(os.path.dirname(os.path.dirname(p)))
            if is_alt: alternating += 1; by_lib[lib][0] += 1
            else: single += 1; by_lib[lib][1] += 1
            if len(examples) < 14:
                examples.append(f"  {lib[:20]:20} bpm={bpm} n={len(notes)} rate={1000/avg:.1f}Hz "
                                f"{'ALT-LR' if is_alt else 'single'} notes={notes} vels={vels} | {os.path.basename(p)[:40]}")

    print(f"fast merged-kick runs: {total}  (alternating L/R: {alternating}, single-kick repeat: {single})")
    print("by library [alt, single]:", {k: v for k, v in by_lib.items()})
    print("\nexamples:")
    for e in examples: print(e)


if __name__ == "__main__":
    main()
