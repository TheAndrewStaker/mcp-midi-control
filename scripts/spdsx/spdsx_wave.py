"""
Surgical SPD-SX wave import — add a wave to the mounted device WITHOUT Wave Manager.

Adding a wave (proven by the 2026-06-27 import A/B capture) touches ONLY two new files
at the next free index, plus NO SYSTEM edits (the device rebuilds its wave list from the
PRM tree on load):
  - WAVE/DATA/<bucket>/<short>.wav   the audio (44.1kHz/16-bit PCM, canonical RIFF)
  - WAVE/PRM/<bucket>/<slot>.spd     <WvPrm>: Nm0..Nm11 (name), Path, Tag

Wave INDEX = bucket*100 + slot. Indices are POSITIONAL and referenced by kits, so this
module is APPEND-ONLY: it allocates the next free index and NEVER renumbers or overwrites
an existing wave (a hard existence guard enforces this even if the flaky USB link makes the
index scan undercount — the corruption mode found in review).

The audio is rewritten as canonical PCM (fmt+data only) via the stdlib `wave` module, which
strips any JUNK/metadata chunk — the SPD-SX requires has_metadata==0 (a stray chunk is the
known "acked but silent" failure mode). Writes are atomic (temp on the same volume + fsync +
os.replace) so a mid-write USB drop can't leave a truncated file the device chokes on.

Self-test (no device): `python spdsx_wave.py --selftest`.
"""
import argparse
import os
import re
import sys
import tempfile
import wave as wavemod
from pathlib import Path

NM_LEN = 12
SNAP = Path(__file__).resolve().parents[2] / "samples" / "spdsx" / "snap-B-import" / "SPD-SX"
REQUIRED_RATE = 44100
REQUIRED_WIDTH = 2          # 16-bit
FIRST_UNOBSERVED_BUCKET = 5  # device-confirmed only for buckets 00-04 (indices 0-499)


# ---- WvPrm XML (byte-faithful to the device) -------------------------------------------

def encode_wave_prm(nm_codes, path, tag):
    out = ["<WvPrm>"]
    for i, c in enumerate(nm_codes):
        out.append(f"\t<Nm{i}>{c}</Nm{i}>")
    out.append(f"\t<Path>{path}</Path>")
    out.append(f"\t<Tag>{tag}</Tag>")
    out.append("</WvPrm>")
    return "\n".join(out) + "\n"


def parse_wave_prm(text):
    nm = []
    for i in range(NM_LEN):
        m = re.search(rf"<Nm{i}>(-?\d+)</Nm{i}>", text)
        nm.append(int(m.group(1)) if m else 0)
    path = re.search(r"<Path>(.*?)</Path>", text).group(1)
    tag = int(re.search(r"<Tag>(-?\d+)</Tag>", text).group(1))
    return nm, path, tag


def name_to_nm(name):
    """Wave name -> 12 char-codes, NUL-padded. Rejects non-printable-ASCII; warns on truncation."""
    if any(ord(c) < 32 or ord(c) > 126 for c in name):
        raise ValueError(f"wave name must be printable ASCII (no unicode/control chars): {name!r}")
    trimmed = name[:NM_LEN]
    if len(name) > NM_LEN:
        print(f"  warning: wave name truncated to {NM_LEN} chars: {name!r} -> {trimmed!r}", file=sys.stderr)
    return [ord(c) for c in trimmed] + [0] * (NM_LEN - len(trimmed))


# ---- index allocation + canonical audio ------------------------------------------------

def used_indices(device_root):
    """Indices in use. Robust to AppleDouble (._*) + non-numeric entries on a FAT mount."""
    idx = set()
    for p in (Path(device_root) / "WAVE" / "PRM").glob("*/*.spd"):
        if p.name.startswith("."):           # macOS sidecars: ._73.spd, .DS_Store, etc.
            continue
        if not (p.parent.name.isdigit() and p.stem.isdigit()):
            continue
        idx.add(int(p.parent.name) * 100 + int(p.stem))
    return idx


def next_free_index(device_root):
    """Next free wave index. RAISES if the PRM tree reads empty (unmounted / wrong path /
    a flaky-link short read) so we never start at 0 and clobber the first wave."""
    used = used_indices(device_root)
    if not used:
        raise RuntimeError(
            f"no waves found under {device_root}/WAVE/PRM — device unmounted, wrong path, or a "
            f"dropped USB link. Refusing to allocate (would start at index 0 and overwrite wave 0).")
    return max(used) + 1


def validate_wav(src):
    """Validate format without writing. Raises ValueError on anything the SPD-SX rejects."""
    try:
        with wavemod.open(str(src), "rb") as w:
            ch, sw, fr = w.getnchannels(), w.getsampwidth(), w.getframerate()
    except wavemod.Error as e:
        raise ValueError(f"{Path(src).name}: not canonical PCM WAV ({e})")
    if fr != REQUIRED_RATE or sw != REQUIRED_WIDTH:
        raise ValueError(f"{Path(src).name}: SPD-SX needs {REQUIRED_RATE} Hz / 16-bit, "
                         f"got {fr} Hz / {sw * 8}-bit (convert with `bouncer spdsx`)")
    return ch


def canonical_wav(src, dst):
    """Atomically write a clean 44.1k/16 PCM copy (fmt+data only) at dst."""
    with wavemod.open(str(src), "rb") as w:
        ch, sw, fr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        frames = w.readframes(n)
    fd, tmp = tempfile.mkstemp(dir=str(Path(dst).parent), suffix=".tmp")
    os.close(fd)
    try:
        with wavemod.open(tmp, "wb") as w:
            w.setnchannels(ch)
            w.setsampwidth(sw)
            w.setframerate(fr)
            w.writeframes(frames)
        with open(tmp, "rb+") as f:
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, dst)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def atomic_write_text(path, text):
    """temp-on-same-volume -> fsync -> os.replace, so a USB drop can't truncate the file."""
    path = Path(path)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def data_filename(name, bucket_dir, planned):
    """A short (<=8.3) DATA filename unique within its bucket, case-folded (FAT is
    case-INSENSITIVE) for both the on-disk and intra-batch checks."""
    base = "".join(c for c in name if c.isalnum() or c in "_-")[:8] or "wave"
    cand, i = base, 1
    def taken(c):
        return (bucket_dir / f"{c}.wav").exists() or f"{c}.wav".lower() in planned
    while taken(cand):
        sfx = f"_{i:02d}"
        cand = base[: 8 - len(sfx)] + sfx
        i += 1
    return f"{cand}.wav"


# ---- the operation ---------------------------------------------------------------------

def add_waves(device_root, items, dry_run=False):
    """items: list of (wav_path, name). Returns [(name, index)]. Append-only, fail-fast.

    Pre-flight validates every name + WAV BEFORE any write (no partial batch from a late bad
    file). Each write is guarded against overwriting an existing index and is atomic.
    """
    device_root = Path(device_root)
    idx = next_free_index(device_root)  # raises if the tree reads empty

    # Pre-flight: validate all names + audio up front.
    prepared = []
    for wav_path, name in items:
        nm = name_to_nm(name)        # raises on bad name
        validate_wav(wav_path)       # raises on wrong format / non-PCM
        prepared.append((wav_path, name, nm))

    results, committed, planned = [], [], set()  # planned: lower-cased DATA names this batch
    for wav_path, name, nm in prepared:
        bucket, slot = idx // 100, idx % 100
        if bucket >= FIRST_UNOBSERVED_BUCKET:
            print(f"  WARNING: index {idx} falls in bucket {bucket:02d}, which is NOT device-confirmed "
                  f"(only 00-04 are). Device wave/memory ceiling unverified.", file=sys.stderr)
        data_dir = device_root / "WAVE" / "DATA" / f"{bucket:02d}"
        prm_dir = device_root / "WAVE" / "PRM" / f"{bucket:02d}"
        fname = data_filename(name, data_dir, planned)
        planned.add(fname.lower())
        prm_path = prm_dir / f"{slot:02d}.spd"
        data_path = data_dir / fname
        # Hard append-only guard: NEVER overwrite an existing index or DATA file.
        if prm_path.exists() or data_path.exists():
            raise RuntimeError(
                f"refusing to overwrite existing files at index {idx} ({prm_path.name} / {fname}); "
                f"the index scan is inconsistent — aborting (committed {len(committed)} so far: "
                f"{[c[1] for c in committed]}).")
        rel = f"{bucket:02d}/{fname}"
        print(f"  wave {idx:4}  '{name}'  -> DATA/{rel}  + PRM/{bucket:02d}/{slot:02d}.spd")
        if not dry_run:
            data_dir.mkdir(parents=True, exist_ok=True)
            prm_dir.mkdir(parents=True, exist_ok=True)
            try:
                canonical_wav(wav_path, data_path)                        # DATA first (orphan-safe)
                atomic_write_text(prm_path, encode_wave_prm(nm, rel, 0))  # then PRM
            except Exception as e:
                print(f"  FAILED at index {idx} ('{name}'): {e}. Committed: {[c[1] for c in committed]}",
                      file=sys.stderr)
                raise
        committed.append((idx, name))
        results.append((name, idx))
        idx += 1
    return results


# ---- self-test -------------------------------------------------------------------------

def selftest():
    prms = sorted((SNAP / "WAVE" / "PRM").glob("*/*.spd"))[:60]
    if not prms:
        print("no snapshot PRM files found for self-test", file=sys.stderr)
        return 2
    ok = 0
    for p in prms:
        t = p.read_text(encoding="utf-8")
        nm, path, tag = parse_wave_prm(t)
        if encode_wave_prm(nm, path, tag) == t:
            ok += 1
        else:
            print(f"  FAIL {p.parent.name}/{p.name} round-trip mismatch")
    print(f"{ok}/{len(prms)} PRM files round-trip byte-identical.")
    # name_to_nm: NUL-padded, ASCII-guarded
    assert name_to_nm("01_kick") == [48, 49, 95, 107, 105, 99, 107, 0, 0, 0, 0, 0], "NUL-pad"
    try:
        name_to_nm("kïck"); assert False, "should reject non-ASCII"
    except ValueError:
        pass
    print("name_to_nm: NUL-pad + ASCII-guard OK")
    print(f"next_free_index(snapshot) = {next_free_index(SNAP)}  (expect 474)")
    return 0 if ok == len(prms) else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="Surgically add waves to an SPD-SX (append-only).")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--device", help="device SPD-SX root, e.g. D:/Roland/SPD-SX")
    ap.add_argument("--folder", help="folder of 44.1k/16 WAVs to add (name = filename stem)")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not (a.device and a.folder):
        ap.error("need --device and --folder")
    wavs = sorted(Path(a.folder).glob("*.wav"))
    if not wavs:
        ap.error(f"no .wav files in {a.folder}")
    items = [(w, w.stem) for w in wavs]
    print(f"adding {len(items)} wave(s) to {a.device} (next free index {next_free_index(a.device)}):")
    res = add_waves(a.device, items, a.dry_run)
    print(f"{'planned' if a.dry_run else 'wrote'} {len(res)} wave(s): "
          f"{res[0][1]}..{res[-1][1]}" if res else "(none)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
