"""
Surgical SPD-SX kit authoring — write ONE kit .spd directly to the mounted device,
no Wave Manager "Save All" (which rewrites the whole ~500MB device image).

Wave Manager writes new kits in a MINIMAL format (name + 15 PadPrm{Wv,SubWv}, no
Level/Tempo/FX). This module reproduces that format BYTE-FOR-BYTE — proven by a
round-trip self-test against real device kits — then writes a single kit file.

Safety model:
- Append-only by default: refuses to overwrite an existing kit unless --force.
- Validates the generated XML with verify_kit_xml before writing.
- Never touches the wave pool or SYSTEM files (a kit only references waves by index).
- The device rebuilds its wave list from PRM on load, so no wavelist edit is needed.
- Eject the drive cleanly after writing (and power-cycle if the kit doesn't appear).

Usage:
  python spdsx_author.py --selftest                         # round-trip vs snapshot kits
  python spdsx_author.py --device D:/Roland/SPD-SX --kit 41 \
      --name SURGTEST --pads 469,470,465,464,472,468,461,462,463 [--max-wave 473] [--force] [--dry-run]
  # --pads = wave INDEX per pad 1..N (subdir*100+slot, 0-based); remaining pads left empty (-1).
"""
import argparse
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_kit_xml as vk  # noqa: E402
import spdsx_wave as sw  # noqa: E402  (next_free_index + atomic_write_text)

PAD_COUNT = 15
NAME_LEN = 8
SUBNAME_LEN = 16
SNAP_KITS = Path(__file__).resolve().parents[2] / "samples" / "spdsx" / "snap-A" / "SPD-SX" / "KIT"


def encode_minimal_kit(nm_codes, subnm_codes, pads):
    """nm_codes: 8 ints; subnm_codes: 16 ints; pads: 15 (wv, subwv). -> str (LF, tab-indent)."""
    out = ["<KitPrm>"]
    for i, c in enumerate(nm_codes):
        out.append(f"\t<Nm{i}>{c}</Nm{i}>")
    for i, c in enumerate(subnm_codes):
        out.append(f"\t<SubNm{i}>{c}</SubNm{i}>")
    for wv, subwv in pads:
        out += ["\t<PadPrm>", f"\t\t<Wv>{wv}</Wv>", f"\t\t<SubWv>{subwv}</SubWv>", "\t</PadPrm>"]
    out.append("</KitPrm>")
    return "\n".join(out) + "\n"


def is_minimal_kit(text):
    """A minimal kit has no <Level>/<Tempo>/<Fx...> (the full-kit fields)."""
    return "<Level>" not in text and "<Fx1Sw>" not in text


def parse_minimal_kit(text):
    """Parse a minimal kit -> (nm_codes[8], subnm_codes[16], pads[15])."""
    def codes(prefix, n):
        vals = []
        for i in range(n):
            m = re.search(rf"<{prefix}{i}>(-?\d+)</{prefix}{i}>", text)
            vals.append(int(m.group(1)) if m else 0)
        return vals
    nm = codes("Nm", NAME_LEN)
    subnm = codes("SubNm", SUBNAME_LEN)
    pads = []
    for block in re.findall(r"<PadPrm>(.*?)</PadPrm>", text, re.S):
        wv = int(re.search(r"<Wv>(-?\d+)</Wv>", block).group(1))
        sub = int(re.search(r"<SubWv>(-?\d+)</SubWv>", block).group(1))
        pads.append((wv, sub))
    return nm, subnm, pads


def selftest():
    """Round-trip every MINIMAL snapshot kit: parse -> re-encode -> must be byte-identical."""
    files = sorted(SNAP_KITS.glob("kit*.spd"))
    n_tested = n_ok = 0
    for f in files:
        text = f.read_text(encoding="utf-8")
        if not is_minimal_kit(text):
            continue  # full kits (Level/Tempo/FX) are not the authored format
        n_tested += 1
        nm, subnm, pads = parse_minimal_kit(text)
        if encode_minimal_kit(nm, subnm, pads) == text:
            n_ok += 1
            print(f"  OK   {f.name} round-trips byte-identical ({len(pads)} pads)")
        else:
            print(f"  FAIL {f.name} round-trip MISMATCH")
    print(f"\n{n_ok}/{n_tested} minimal kit(s) round-trip byte-identical.")

    # Exercise name_to_codes + build_kit against a REAL device kit (kit035 "Yurt 1",
    # a <8-char NUL-padded name) — proves the authoring path, not just parsed round-trip.
    k035 = SNAP_KITS / "kit035.spd"
    if k035.exists():
        text = k035.read_text(encoding="utf-8")
        _, _, pads = parse_minimal_kit(text)
        wvs = [w for w, _ in pads if w != -1]
        rebuilt = build_kit("Yurt 1", wvs)
        if rebuilt == text:
            print("  OK   build_kit('Yurt 1', ...) reproduces kit035 byte-identical (name_to_codes verified)")
        else:
            print("  FAIL build_kit does not reproduce kit035 (name_to_codes padding bug?)")
            n_ok = -1
    assert name_to_codes("GGD") == [71, 71, 68, 0, 0, 0, 0, 0], "kit name must NUL-pad"

    return 0 if n_tested and n_ok == n_tested else 1


def name_to_codes(name):
    if any(ord(c) > 126 or ord(c) < 32 for c in name):
        raise ValueError(f"kit name must be printable ASCII: {name!r}")
    if len(name) > NAME_LEN:
        raise ValueError(f"kit name max {NAME_LEN} chars: {name!r}")
    return [ord(c) for c in name] + [0] * (NAME_LEN - len(name))  # NUL-padded, as real device kits are


def build_kit(name, pad_wvs):
    """pad_wvs: list of wave indices for pads 1..N (-1 or omitted = empty)."""
    if len(pad_wvs) > PAD_COUNT:
        raise ValueError(f"max {PAD_COUNT} pads")
    pads = [(int(w), -1) for w in pad_wvs] + [(-1, -1)] * (PAD_COUNT - len(pad_wvs))
    return encode_minimal_kit(name_to_codes(name), [0] * SUBNAME_LEN, pads)


def author_kit(device_root, kit_number, name, pad_wvs, max_wave=None, force=False,
               dry_run=False, allow_unbounded=False):
    device_root = Path(device_root)
    target = device_root / "KIT" / f"kit{kit_number - 1:03d}.spd"
    text = build_kit(name, pad_wvs)

    # Referential-integrity gate ON by default: derive the wave-index ceiling from the
    # device so a pad can never reference a non-existent wave. (Was bypassed when --max-wave
    # was omitted — the most damaging silent authoring mistake.)
    if max_wave is None and not allow_unbounded:
        try:
            max_wave = sw.next_free_index(device_root) - 1
        except Exception as e:
            print(f"REFUSING to author: cannot read the device wave tree to bound wave indices "
                  f"({e}). Pass --max-wave N, or --allow-unbounded to skip the check.", file=sys.stderr)
            return 1

    # Validate before writing (temp file, same gate as the verifier).
    with tempfile.NamedTemporaryFile("w", suffix=".spd", delete=False, encoding="utf-8", newline="") as tf:
        tf.write(text)
        tmp = tf.name
    ok, nm, assigned, errs = vk.validate_kit(tmp, max_wave)
    Path(tmp).unlink(missing_ok=True)
    if not ok:
        print(f"REFUSING to write — generated kit failed validation:\n  " + "\n  ".join(errs), file=sys.stderr)
        return 1

    print(f"Kit {kit_number}  ->  {target}")
    print(f"  name={nm!r}  pads_assigned={assigned}/{PAD_COUNT}  bytes={len(text)}  max_wave={max_wave}")
    if target.exists() and not force:
        print(f"REFUSING to overwrite existing {target.name} (pass --force to replace).", file=sys.stderr)
        return 1
    if dry_run:
        print("--dry-run: not written.\n" + text)
        return 0
    # Back up an existing kit before a --force overwrite (no undo on the device otherwise).
    if target.exists():
        bak = target.with_suffix(".spd.bak")
        sw.atomic_write_text(bak, target.read_text(encoding="utf-8"))
        print(f"  backed up existing kit -> {bak.name}")
    sw.atomic_write_text(target, text)  # temp+fsync+os.replace (USB-drop safe)
    print(f"  WROTE {target}.  Eject the drive cleanly; power-cycle if the kit doesn't appear.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Author one SPD-SX kit .spd surgically.")
    ap.add_argument("--selftest", action="store_true", help="round-trip vs snapshot kits and exit")
    ap.add_argument("--device", help="device SPD-SX root, e.g. D:/Roland/SPD-SX")
    ap.add_argument("--kit", type=int, help="kit number 1..100 (device numbering)")
    ap.add_argument("--name", help="kit name (<=8 printable ASCII chars)")
    ap.add_argument("--pads", help="comma list of wave indices for pads 1..N")
    ap.add_argument("--max-wave", type=int, default=None,
                    help="highest valid wave index (default: derived from the device)")
    ap.add_argument("--allow-unbounded", action="store_true",
                    help="skip the wave-index range check (unsafe; only for offline corpus use)")
    ap.add_argument("--force", action="store_true", help="allow overwriting an existing kit (backs it up first)")
    ap.add_argument("--dry-run", action="store_true", help="print the kit, do not write")
    a = ap.parse_args(argv)

    if a.selftest:
        return selftest()
    if not (a.device and a.kit and a.name and a.pads is not None):
        ap.error("authoring needs --device, --kit, --name, --pads")
    if not (1 <= a.kit <= 100):
        ap.error("--kit must be 1..100")
    try:
        pad_wvs = [int(x) for x in a.pads.split(",") if x.strip() != ""]
    except ValueError:
        ap.error(f"--pads must be a comma list of integers (wave indices), got: {a.pads!r}")
    return author_kit(a.device, a.kit, a.name, pad_wvs, a.max_wave, a.force, a.dry_run, a.allow_unbounded)


if __name__ == "__main__":
    sys.exit(main())
