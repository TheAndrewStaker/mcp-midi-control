"""
bake_fills.py — bounce every Sleep Token II Groove Pack Fill MIDI through the
source Kontakt engine (real round-robins/velocity layers), one WAV per fill,
via `bouncer phrase` (see project_auto_bake_fast_figures_engine memory: HALF A
of "FILL RECOGNITION from song sources" — render library fills -> WAVs).

TEMPO FIX (found 2026-07-04): every file in the pack except Song 01's carries
a stale `set_tempo` meta of 110 BPM regardless of its real song tempo (PPQ is
a fixed 480 across all songs too, so nothing compensates) — bouncer's
`phrase` command trusts the file's own embedded tempo (mido `tick2second`) to
convert ticks -> real seconds, so bouncing these files as-is would render
9 of the 10 songs at the WRONG (110-implied) speed. Fixed by rewriting every
set_tempo meta to the folder-declared BPM (ticks/PPQ are tempo-independent,
so this only corrects timing, never the pattern).

NOTE-REMAP FIX (found 2026-07-04, `bouncer/docs/kontakt-state-and-mixwave.md`):
the pack's own semantic keys (1=kick, 2/14=hat, 3=snare, 41=ride — see
MIXWAVE_ST2_GROOVES in drumMapPresets.ts) are SILENT when played directly on
the instrument; they only sound through Kontakt's own Groove Player remap,
which a headless engine bounce never runs. Confirmed empirically: 3 of the
first 8 fills baked pre-fix came out at peak=0.0000 (dead silence). Fixed by
translating each of the 5 confirmed semantic keys to the real, screenshot-
confirmed instrument note bouncer's own `examples/local/libraries.py` already
uses (kick 36, snare 38, hat 73, ride 51 — hat 73 is the same note the
HW-confirmed Gethsemane hatline bake used) before bouncing. Any OTHER note
("the secondary tail" — 11/7/9/13/32/23/19/... , not in the 4-role sidecar
per the same doc) is DROPPED, same policy `groove_to_pattern.py` already uses
for Circuit patterns (NOTE_TO_TRACK.get() -> None -> skipped) — counted and
printed so the loss is visible, never silent.

Output: samples/mixwave/groove-pack-fills/Song NN (BPM)/S0N Fill 0N.wav
        samples/mixwave/groove-pack-fills/catalog.json

  python bake_fills.py
"""
import glob
import json
import os
import re
import subprocess
import sys
import tempfile

import mido

sys.path.insert(0, os.path.dirname(__file__))
from song_names import SONG_NAMES  # noqa: E402

ROOT = r"C:\dev\mcp-midi-tools"
GP = r"C:\Users\Public\Documents\Sleep Token - II\MIDI Files\Sleep Token II - Groove Pack"
BOUNCER = r"C:\dev\bouncer"
VST3 = "C:/Program Files/Common Files/VST3/Kontakt 8.vst3"
STATE = os.path.join(BOUNCER, "states", "sleep-token-ii.bin")
OUT = os.path.join(ROOT, "samples", "mixwave", "groove-pack-fills")
PY = sys.executable

# Groove-pack semantic key (MIXWAVE_ST2_GROOVES) -> real instrument note
# (bouncer/examples/local/libraries.py "sleeptoken" pieces; hat=73 is the
# same note the HW-confirmed Gethsemane hatline bake used).
NOTE_REMAP = {1: 36, 2: 73, 3: 38, 14: 73, 41: 51}


def prepare_for_bounce(midi_path, real_bpm, tmp_dir):
    """Copy midi_path into tmp_dir with (a) every set_tempo meta forced to
    real_bpm and (b) every note_on/note_off remapped via NOTE_REMAP, dropping
    anything not in it. Returns (out_path, kept_count, dropped_count)."""
    mid = mido.MidiFile(midi_path)
    new_tempo = mido.bpm2tempo(real_bpm)
    found_tempo = False
    kept = dropped = 0
    for track in mid.tracks:
        i = 0
        while i < len(track):
            msg = track[i]
            if msg.type == "set_tempo":
                msg.tempo = new_tempo
                found_tempo = True
                i += 1
            elif msg.type in ("note_on", "note_off"):
                mapped = NOTE_REMAP.get(msg.note)
                if mapped is None:
                    dropped += 1
                    # preserve the delta-time by folding it onto the next event
                    if i + 1 < len(track):
                        track[i + 1].time += msg.time
                    del track[i]
                    continue
                msg.note = mapped
                kept += 1
                i += 1
            else:
                i += 1
    if not found_tempo:
        mid.tracks[0].insert(0, mido.MetaMessage("set_tempo", tempo=new_tempo, time=0))
    out_path = os.path.join(tmp_dir, os.path.basename(midi_path))
    mid.save(out_path)
    return out_path, kept, dropped


def bake_one(midi_path, out_folder):
    result = subprocess.run(
        [PY, "-m", "bouncer.cli", "phrase",
         "--vst3", VST3, "--state", STATE,
         "--midi", midi_path, "--out", out_folder],
        cwd=BOUNCER, capture_output=True, text=True)
    return result


def main():
    os.makedirs(OUT, exist_ok=True)
    catalog = []
    with tempfile.TemporaryDirectory(prefix="st2-fills-") as tmp_dir:
        for folder in sorted(glob.glob(os.path.join(GP, "Song*"))):
            base = os.path.basename(folder)
            name = SONG_NAMES.get(base, base)
            m = re.search(r"\((\d+) BPM\)", base)
            real_bpm = int(m.group(1))
            fills = sorted(glob.glob(os.path.join(folder, "*Fill*.mid")))
            if not fills:
                continue
            song_out = os.path.join(OUT, base)
            os.makedirs(song_out, exist_ok=True)
            for f in fills:
                stem = os.path.splitext(os.path.basename(f))[0]
                wav = os.path.join(song_out, stem + ".wav")
                prepared, kept, dropped = prepare_for_bounce(f, real_bpm, tmp_dir)
                if os.path.exists(wav):
                    print(f"{base:22} {stem:16} @ {real_bpm} bpm  kept={kept:3} dropped={dropped:3} -> SKIP (already baked)")
                    ok = True
                else:
                    result = bake_one(prepared, song_out)
                    ok = result.returncode == 0 and os.path.exists(wav)
                    print(f"{base:22} {stem:16} @ {real_bpm} bpm  kept={kept:3} dropped={dropped:3} -> {'OK' if ok else 'FAIL'}")
                    if not ok:
                        print((result.stderr or "")[-800:])
                catalog.append({
                    "song": name, "folder": base, "bpm": real_bpm,
                    "source_midi": f, "wav": wav if ok else None, "ok": ok,
                    "notes_kept": kept, "notes_dropped": dropped,
                })
            # level per song-folder (bouncer level globs *.wav non-recursively)
            subprocess.run([PY, "-m", "bouncer.cli", "level", "--mode", "loudness", song_out],
                           cwd=BOUNCER, capture_output=True)

    with open(os.path.join(OUT, "catalog.json"), "w") as fh:
        json.dump(catalog, fh, indent=2)
    n_ok = sum(1 for c in catalog if c["ok"])
    total_dropped = sum(c["notes_dropped"] for c in catalog)
    total_kept = sum(c["notes_kept"] for c in catalog)
    print(f"\n{n_ok}/{len(catalog)} fills baked -> {OUT}")
    print(f"notes: {total_kept} kept, {total_dropped} dropped (unmapped secondary-tail articulations)")


if __name__ == "__main__":
    main()
