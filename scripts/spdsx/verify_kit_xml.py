"""
Deterministic validator for Roland SPD-SX (original / SE) kit files (KIT/kitNNN.spd).

The SPD-SX stores each kit as a small XML document rooted at <KitPrm>. This script
checks the structural invariants that hold across every real kit, so an AUTHORED kit
can be proven well-formed BEFORE it is written to the device, and so the real kits on
a device (or a snapshot) can be used as a deterministic regression corpus.

Decoded format (see docs STATE-SPDSX.md):
  <KitPrm>
    [<Level>0..127</Level> <Tempo>tempo*10</Tempo>]   # present on full kits, omitted on minimal kits
    <Nm0>..<Nm7>      8 char-codes  -> kit name (NUL-terminated, max 8 chars)
    <SubNm0>..<SubNm15>  16 char-codes -> sub-name (often spaces/zeros)
    [ kit FX block: <Fx1Sw> <Fx1Type> <Fx1Prm0..19> <Fx2Sw> <Fx2Type> <Fx2Prm0..19> ... ]
    <PadPrm> x15      one per pad slot (9 main pads + 6 external), each:
       <Wv>idx</Wv>   wave index, -1 = empty
       <SubWv>idx</SubWv>
  </KitPrm>

Usage:
  python verify_kit_xml.py <kit.spd | KIT-dir> [--max-wave N] [--quiet]
  # default target is the captured snapshot KIT dir (the regression corpus).

Exit code 0 = all valid, 1 = at least one invalid (deterministic for CI).
"""
import argparse
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

PAD_COUNT = 15            # 9 main pads + 6 external trigger slots
NAME_LEN = 8              # Nm0..Nm7
SUBNAME_LEN = 16          # SubNm0..SubNm15
DEFAULT_CORPUS = Path(__file__).resolve().parents[2] / "samples" / "spdsx" / "snap-A" / "SPD-SX" / "KIT"


def _int(el):
    if el is None or el.text is None:
        return None
    try:
        return int(el.text.strip())
    except ValueError:
        return None


def decode_name(root, prefix, n):
    """Decode <prefix0..prefixN-1> char-codes into a string (stop at NUL)."""
    out = []
    for i in range(n):
        v = _int(root.find(f"{prefix}{i}"))
        if v is None:
            return None  # missing field
        if v == 0:
            break
        if 32 <= v <= 126:
            out.append(chr(v))
    return "".join(out).rstrip()


def validate_kit(path, max_wave=None):
    """Return (ok: bool, name: str|None, assigned_pads: int, errors: list[str])."""
    errs = []
    raw = Path(path).read_bytes().decode("utf-8-sig", errors="replace")
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        return False, None, 0, [f"XML parse error: {e}"]

    if root.tag != "KitPrm":
        errs.append(f"root tag is <{root.tag}>, expected <KitPrm>")

    # Name (required) — must be NUL or printable-ASCII codes, and non-empty.
    name = decode_name(root, "Nm", NAME_LEN)
    if name is None:
        errs.append(f"missing/invalid Nm0..Nm{NAME_LEN - 1} (kit name)")
    else:
        for i in range(NAME_LEN):
            v = _int(root.find(f"Nm{i}"))
            if v is not None and v != 0 and not (32 <= v <= 126):
                errs.append(f"Nm{i} = {v} is not NUL or printable ASCII (32..126)")
        if name == "":
            errs.append("kit name is empty")

    # Sub-name (required structurally, content may be blank)
    for i in range(SUBNAME_LEN):
        if root.find(f"SubNm{i}") is None:
            errs.append(f"missing SubNm{i}")
            break

    # Optional Level / Tempo: if present must be in range
    lvl = _int(root.find("Level"))
    if lvl is not None and not (0 <= lvl <= 127):
        errs.append(f"Level out of range 0..127: {lvl}")
    tempo = _int(root.find("Tempo"))
    if tempo is not None and not (200 <= tempo <= 3000):  # 20.0..300.0 BPM, stored *10
        errs.append(f"Tempo out of range 200..3000 (BPM*10): {tempo}")

    # Pads: exactly PAD_COUNT <PadPrm>, each with valid Wv + SubWv
    pads = root.findall("PadPrm")
    if len(pads) != PAD_COUNT:
        errs.append(f"found {len(pads)} <PadPrm>, expected {PAD_COUNT}")
    assigned = 0
    for idx, pad in enumerate(pads):
        for field in ("Wv", "SubWv"):
            v = _int(pad.find(field))
            if v is None:
                errs.append(f"pad {idx}: missing/invalid <{field}>")
                continue
            if v < -1:
                errs.append(f"pad {idx}: <{field}> = {v} (< -1)")
            elif v != -1 and max_wave is not None and v > max_wave:
                errs.append(f"pad {idx}: <{field}> = {v} exceeds max wave index {max_wave}")
            if field == "Wv" and v != -1:
                assigned += 1
    if len(pads) == PAD_COUNT and assigned == 0:
        errs.append("kit has no waves assigned to any pad (all Wv = -1)")

    return (len(errs) == 0), name, assigned, errs


def main(argv=None):
    ap = argparse.ArgumentParser(description="Validate SPD-SX kit .spd XML structure.")
    ap.add_argument("target", nargs="?", default=str(DEFAULT_CORPUS),
                    help="a kit .spd file or a directory of them (default: captured snapshot KIT dir)")
    ap.add_argument("--max-wave", type=int, default=None,
                    help="highest valid wave index (Wv must be -1 or <= this)")
    ap.add_argument("--quiet", action="store_true", help="only print the summary line + failures")
    a = ap.parse_args(argv)

    target = Path(a.target)
    if target.is_dir():
        files = sorted(target.glob("kit*.spd"))
    elif target.is_file():
        files = [target]
    else:
        print(f"error: not found: {target}", file=sys.stderr)
        return 2
    if not files:
        print(f"error: no kit .spd files under {target}", file=sys.stderr)
        return 2

    n_ok = 0
    for f in files:
        ok, name, assigned, errs = validate_kit(f, a.max_wave)
        if ok:
            n_ok += 1
            if not a.quiet:
                print(f"  OK   {f.name:14} name={name!r:12} pads_assigned={assigned}/{PAD_COUNT}")
        else:
            print(f"  FAIL {f.name:14} name={name!r}")
            for e in errs:
                print(f"         - {e}")
    print(f"\n{n_ok}/{len(files)} kit file(s) valid.")
    return 0 if n_ok == len(files) else 1


if __name__ == "__main__":
    sys.exit(main())
