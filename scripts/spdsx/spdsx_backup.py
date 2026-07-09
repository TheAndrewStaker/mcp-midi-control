"""
Back up an SPD-SX `Roland/SPD-SX` tree to a timestamped folder — your real undo before
surgical writes (the device has no CRC recovery, and "Save All onto the device" is NOT a
backup).

Default (fast, ~1 MB): copies the config that surgical writes can change — KIT/, WAVE/PRM/,
SYSTEM/ — plus a manifest (path + size) of WAVE/DATA so a missing/clobbered wave is
detectable. Surgical writes are append-only, so existing audio is never modified and a
config backup is enough to recover an authoring mistake.

--full also copies WAVE/DATA (the audio, hundreds of MB) for disaster recovery (e.g. FAT
corruption from a bad eject) — slow, but the only true full restore.

Usage:
  python spdsx_backup.py --device D:/Roland/SPD-SX --out C:/dev/bouncer/out/spdsx-backups [--full]
"""
import argparse
import shutil
import sys
from datetime import datetime
from pathlib import Path


def backup(device_root, out_dir, full=False):
    device_root = Path(device_root)
    if not (device_root / "KIT").is_dir():
        raise SystemExit(f"not an SPD-SX root (no KIT/): {device_root}")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = Path(out_dir) / f"spdsx-{stamp}"
    dest.mkdir(parents=True, exist_ok=True)

    for sub in ("KIT", "SYSTEM", "WAVE/PRM"):
        src = device_root / sub
        if src.is_dir():
            shutil.copytree(src, dest / sub, dirs_exist_ok=True)

    # WAVE/DATA: manifest always; full copy only on request.
    data = device_root / "WAVE" / "DATA"
    if data.is_dir():
        lines = []
        for f in sorted(data.glob("*/*.wav")):
            lines.append(f"{f.parent.name}/{f.name}\t{f.stat().st_size}")
        (dest / "DATA-MANIFEST.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        if full:
            print(f"  copying audio ({len(lines)} waves) — this is the slow part ...", file=sys.stderr)
            shutil.copytree(data, dest / "WAVE" / "DATA", dirs_exist_ok=True)

    kits = len(list((dest / "KIT").glob("kit*.spd"))) if (dest / "KIT").is_dir() else 0
    prms = len(list((dest / "WAVE" / "PRM").glob("*/*.spd"))) if (dest / "WAVE" / "PRM").is_dir() else 0
    print(f"backed up -> {dest}")
    print(f"  {kits} kits, {prms} wave-PRMs, DATA manifest{' + full audio' if full else ''}")
    return dest


def main(argv=None):
    ap = argparse.ArgumentParser(description="Back up an SPD-SX Roland/SPD-SX tree.")
    ap.add_argument("--device", required=True, help="device SPD-SX root, e.g. D:/Roland/SPD-SX")
    ap.add_argument("--out", required=True, help="backup destination directory")
    ap.add_argument("--full", action="store_true", help="also copy WAVE/DATA audio (slow, full restore)")
    a = ap.parse_args(argv)
    backup(a.device, a.out, a.full)
    return 0


if __name__ == "__main__":
    sys.exit(main())
