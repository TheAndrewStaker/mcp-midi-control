"""
analyze_grooves.py — deterministic catalog of a MixWave-style MIDI groove pack.

Parses every .mid under a groove-pack root and reports, per file and per song:
tempo, bars, hit count, distinct drum voices, a note-onset histogram, and
"roll/burst" detection (runs of the same note at <=32nd-note spacing — i.e.
hat rolls, buzzes, fast fills). Note numbers are reported raw; map them to
kick/snare/hat once the Kontakt discovery scan confirms the layout.

TEMPO NOTE (found 2026-07-04): every file's embedded tempo track is NOT
trustworthy — see bake_fills.py's docstring. It's a huge (~10hr), multi-entry
tempo-automation track that looks like an uncropped copy of the whole album's
timeline; the actual short performance always lands in its first segment, so
the first `set_tempo` read is always ~110 regardless of the file's real song
tempo. `bpm` below is therefore the PARENT-FOLDER-declared tempo ("Song NN
(BPM)"), the only value Mixwave actually stands behind; `embedded_tempo_bpm`
keeps the raw (unreliable) meta-read for reference/debugging only — never use
it for real-time rendering.

Writes a JSON catalog + prints a summary.
  python analyze_grooves.py "<groove pack root>"
"""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import mido


def analyze(path, folder_bpm, tpb_default=480):
    m = mido.MidiFile(path)
    tpb = m.ticks_per_beat or tpb_default
    tempo = None
    numerator = 4
    onsets = defaultdict(list)  # note -> [abs_tick]
    for tr in m.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "set_tempo" and tempo is None:
                tempo = msg.tempo
            elif msg.type == "time_signature":
                numerator = msg.numerator
            elif msg.type == "note_on" and msg.velocity > 0:
                onsets[msg.note].append(t)
    embedded_tempo_bpm = round(60_000_000 / tempo) if tempo else None
    bpm = folder_bpm if folder_bpm is not None else embedded_tempo_bpm
    last = max((v[-1] for v in onsets.values()), default=0)
    bars = round(last / (tpb * numerator), 2) if last else 0
    total = sum(len(v) for v in onsets.items().__iter__().__next__()[1:]) if False else sum(len(v) for v in onsets.values())
    # roll/burst detection: per note, count onsets spaced <= a 32nd note
    thirtysecond = tpb / 8
    bursts = 0
    burst_notes = Counter()
    for note, ts in onsets.items():
        ts = sorted(ts)
        run = 1
        for i in range(1, len(ts)):
            if ts[i] - ts[i - 1] <= thirtysecond + 1:
                run += 1
            else:
                if run >= 3:
                    bursts += 1
                    burst_notes[note] += 1
                run = 1
        if run >= 3:
            bursts += 1
            burst_notes[note] += 1
    return {
        "bpm": bpm,
        "embedded_tempo_bpm": embedded_tempo_bpm,
        "tpb": tpb,
        "time_sig_num": numerator,
        "bars": bars,
        "hits": total,
        "voices": len(onsets),
        "note_hist": {int(n): len(v) for n, v in sorted(onsets.items(), key=lambda kv: -len(kv[1]))},
        "bursts": bursts,
        "burst_notes": {int(n): c for n, c in burst_notes.most_common()},
    }


def main():
    root = Path(sys.argv[1])
    files = sorted(root.rglob("*.mid"))
    catalog = []
    global_hist = Counter()
    global_bursts = Counter()
    per_song = defaultdict(lambda: {"files": 0, "hits": 0, "bursts": 0, "voices": set()})
    for f in files:
        m = re.search(r"\((\d+)\s*BPM\)", f.parent.name, re.IGNORECASE)
        folder_bpm = int(m.group(1)) if m else None
        try:
            a = analyze(str(f), folder_bpm)
        except Exception as e:
            catalog.append({"file": str(f.relative_to(root)), "error": repr(e)})
            continue
        song = f.parent.name
        kind = "fill" if "fill" in f.stem.lower() else ("groove" if "groove" in f.stem.lower() else "other")
        rec = {"file": str(f.relative_to(root)), "song": song, "kind": kind, **a}
        catalog.append(rec)
        for n, c in a["note_hist"].items():
            global_hist[n] += c
        for n, c in a["burst_notes"].items():
            global_bursts[n] += c
        s = per_song[song]
        s["files"] += 1
        s["hits"] += a["hits"]
        s["bursts"] += a["bursts"]
        s["voices"].update(a["note_hist"].keys())

    out = Path(__file__).parent / "groove_catalog.json"
    out.write_text(json.dumps(catalog, indent=1))

    print(f"analyzed {len([c for c in catalog if 'error' not in c])}/{len(files)} files -> {out.name}\n")
    print("=== GLOBAL note-onset histogram (note: total onsets) — our drum-map evidence ===")
    for n, c in global_hist.most_common(25):
        roll = f"  rolls={global_bursts[n]}" if global_bursts[n] else ""
        print(f"  note {n:3d}: {c:5d}{roll}")
    print("\n=== PER-SONG ===")
    for song, s in sorted(per_song.items()):
        print(f"  {song:24} files={s['files']:2}  hits={s['hits']:5}  rollbursts={s['bursts']:3}  voices={len(s['voices'])}")
    print("\n=== TOP 12 files by roll/burst count (hat rolls / fast fills) ===")
    ranked = sorted((c for c in catalog if "bursts" in c), key=lambda c: -c["bursts"])[:12]
    for c in ranked:
        print(f"  bursts={c['bursts']:3}  hits={c['hits']:4}  {c['file']}")


if __name__ == "__main__":
    main()
