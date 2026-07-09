"""
preview_groove.py — render an audible preview of each Sleep Token song's groove.

Maps each groove MIDI's notes to the bounced Sleep Token samples (Default kit)
and mixes them at the folder's real BPM into a WAV you can play in any media
player (no MIDI player needed) — to identify which song each anonymized folder is.

  python preview_groove.py
Outputs one WAV per song to sleep-token-ii/previews/.
"""
import glob
import os
import re
import wave

import numpy as np
import mido

ROOT = r"C:\dev\mcp-midi-tools\samples\drum-sources\sleep-token-ii"
PAGE = os.path.join(ROOT, "page")
OUT = os.path.join(ROOT, "previews")
GP = r"C:\Users\Public\Documents\Sleep Token - II\MIDI Files\Sleep Token II - Groove Pack"
SR = 44100

# groove note -> piece name (role map from metric analysis + guide)
GROOVE_TO_PIECE = {
    14: "kick", 23: "kick2", 0: "kick2",
    3: "snr", 13: "snroll", 29: "snr",
    1: "hatC", 2: "hatO", 32: "hatP", 19: "sticks",
    11: "rtom1", 9: "rtom2", 7: "ftom",
    41: "ride", 53: "crash", 54: "china", 52: "china",
}


def load_samples():
    m = {}
    for f in glob.glob(os.path.join(PAGE, "*_k1_*.wav")):
        name = re.search(r"_k1_(.+)\.wav$", f).group(1)
        with wave.open(f, "rb") as w:
            m[name] = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    return m


def fullest_groove(folder):
    best, bestn = None, -1
    for f in glob.glob(os.path.join(folder, "*.mid")):
        if "groove" not in os.path.basename(f).lower():
            continue
        n = sum(1 for tr in mido.MidiFile(f).tracks for msg in tr if msg.type == "note_on" and msg.velocity > 0)
        if n > bestn:
            bestn, best = n, f
    return best


def render(folder, samples):
    bpm = int(re.search(r"\((\d+) BPM\)", os.path.basename(folder)).group(1))
    g = fullest_groove(folder)
    if not g:
        return None
    mid = mido.MidiFile(g)
    spt = (60.0 / bpm) / mid.ticks_per_beat  # seconds per tick at real BPM
    events = []
    for tr in mid.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                events.append((t, msg.note, msg.velocity))
    if not events:
        return None
    length = int(max(t for t, _, _ in events) * spt * SR) + SR
    buf = np.zeros(length, dtype=np.float32)
    for t, note, vel in events:
        piece = GROOVE_TO_PIECE.get(note)
        s = samples.get(piece) if piece else None
        if s is None:
            continue
        off = int(t * spt * SR)
        end = min(length, off + len(s))
        buf[off:end] += s[: end - off] * (vel / 127.0)
    pk = np.max(np.abs(buf))
    if pk > 0:
        buf = buf / pk * 0.9
    return bpm, os.path.basename(g), buf


def main():
    os.makedirs(OUT, exist_ok=True)
    samples = load_samples()
    for folder in sorted(glob.glob(os.path.join(GP, "*"))):
        if not os.path.isdir(folder):
            continue
        r = render(folder, samples)
        if not r:
            continue
        bpm, gname, buf = r
        num = re.search(r"Song (\d+)", os.path.basename(folder)).group(1)
        out = os.path.join(OUT, f"Song{num}_{bpm}bpm.wav")
        with wave.open(out, "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
            w.writeframes((np.clip(buf, -1, 1) * 32767).astype(np.int16).tobytes())
        print(f"Song {num} ({bpm} bpm)  <- {gname}  {len(buf)/SR:.1f}s")


if __name__ == "__main__":
    main()
