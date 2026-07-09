---
name: iii-fn01-action-code-per-model-byte
class: dispatch-context
status: matched-singleton
discovered: 2026-05-22 (cookbook crosscheck mining of ghidra-axe-edit-iii-actions-and-shapes.txt)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: STUB (structural-only; de-facto coverage: the consumed_in dump-citation — actions-and-shapes dump per-caller dispatch lines)
relates_to: [iii-fn01-set-parameter-envelope, iii-multiproduct-editor-binary]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt
---

# Axe-Fx III fn=0x01 action code varies per model byte

Some of the 93 callers of `FUN_14033ec70` (the fn=0x01 builder per
[[iii-fn01-set-parameter-envelope]]) emit DIFFERENT action14 values
depending on the current device's model byte. A naive port that
copies the III's action code as a constant produces silently-wrong
wire frames on FM3 or FM9.

Most fn=0x01 callers are uniform across the three model bytes
(`0x10/0x11/0x12`); a real minority diverge. The split sites must be
identified case-by-case from the per-caller decompile.

## Formal definition

Within a fn=0x01 caller, the `action14` value passed to
`FUN_14033ec70` as `param_3[0]` may be assigned via one of three
patterns:

1. **Uniform constant**: `uVar7 = 0x1c;` (no model-byte branch).
   Same action emitted regardless of device.
2. **Per-model chained equality**: assignment guarded by
   `cVar1 == '\x10'` / `== '\x11'` / `== '\x12'` arms (see
   [[iii-multiproduct-editor-binary]] Pattern A).
3. **Family-bucket Pattern B**: shared assignment for some subset
   of the family + fallback. Less common in fn=0x01 callers; more
   common in cross-fn dispatch (descriptor tables, etc.).

This primitive registers the existence of pattern 2 (the
per-model-byte split) and provides the verified caller table.

## Where it's used

Verified split-per-model fn=0x01 callers in
`fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt`:

| Caller          | III (`0x10`) | FM3 (`0x11`) | FM9 (`0x12`) | Dump lines |
|-----------------|-------------|-------------|-------------|------------|
| `FUN_1401e38a0` | `0x84`      | `0x83`      | `0x7b`      | L793-800   |
| `FUN_1401e3a80` | `0x84`      | `0x83`      | `0x7b`      | L859-867   |
| `FUN_1401e41e0` | `0x72`      | `0x72`      | `0x79`      | L1040-1048 |

`FUN_1401e41e0` is the half-split case: III and FM3 share `0x72`;
FM9 alone takes `0x79`.

Verified uniform fn=0x01 callers (sampled across the dump's 93-caller
trace; non-exhaustive):

| Caller          | All three  | Dump lines |
|-----------------|-----------|------------|
| `FUN_1401e3b40` | `0x4b`    | L902-906   |
| `FUN_1401e4030` | `0x50`    | L957-958   |
| `FUN_1401e4130` | `0x51`    | L1003-1004 |
| `FUN_1401e42a0` | `0x1c`    | L1085-1086 |
| `FUN_1401e44b0` | `0x3a`    | L1160-1162 |
| `FUN_1401e4560` | `0x39`    | L1197-1199 |
| `FUN_1401e4610` | `0x23`    | L1234-1236 |
| `FUN_1401e46c0` | `0x22`    | L1272-1274 |
| `FUN_1401e4770` | `0x19`    | L1310-1312 |
| `FUN_1401e4820` | `0x1a`    | L1347-1349 |
| `FUN_1401e4a90` | `0x1b`    | L1384-1386 |
| `FUN_1402263a0` | `0x26`    | L1999-2001 |
| `FUN_140218f80` | `0x17`    | L2470-2472 |
| `FUN_140228410` | `0x27`    | L2231-2233 |

Verbatim L793-800 sample (full chained-equality decompile):

```c
cVar1 = *(char *)(param_1 + 0x38);
if (cVar1 == '\x10') {
  uVar7 = 0x84;
}
else if (cVar1 == '\x11') {
  uVar7 = 0x83;
}
else if (cVar1 == '\x12') {
  uVar7 = 0x7b;
}
**(undefined4 **)(param_1 + 0x40) = uVar7;   // write action14 to param_3[0]
...
FUN_14033ec70(param_1 + 0x38, &local_48, *(undefined8 *)(param_1 + 0x40));
```

## Misapplication failure modes

- **DO NOT** copy an action14 constant from a III-only capture or
  III-only test fixture into a fn=0x01 emitter without first
  walking the caller. If the caller is in the split table above,
  the III constant produces a wrong action on FM3 / FM9.
- **DO NOT** infer "the action codes are uniform" from a single
  uniform caller. The split callers are a minority but they exist
  and matter. Always check the specific caller you are porting.
- **DO NOT** assume `0x84` is always "the III's bookmark action"
  semantically. The same action14 constant can have different
  meanings in different callers; this primitive only registers the
  per-model split pattern, not the per-constant semantics.

## Where it does NOT apply

- AxeEdit II — has a different fn for SET_PARAMETER (`0x02`, not
  `0x01`), different builder function, different action-code
  enumeration. See [[ii-axeedit-opcode-table]].
- AM4-Edit — fn=0x01 family on AM4 is per-paramId not per-action.
  See [[am4-pidlow-register-families]].
- Hydrasynth — NRPN-based; no fn-byte action codes.

## Verification path

This entry's golden is a STUB (the structural claim is "the actions-and-shapes
dump contains the cited per-caller dispatch lines"; the
`consumed_in:` path existence check enforces this). The verified
table above is the corpus; future agents adding new split sites
should append rows here and cite the dump lines.

## Path to `matched`

Promotion from `matched-singleton` requires a second axis. Cheapest
path: capture a fn=0x01 wire frame from each of III, FM3, and FM9
exercising the same caller (e.g. the boost on/off path in
`FUN_1401e38a0`) and observe the action code byte on the wire. If
all three captures show the predicted action codes (0x84 / 0x83 /
0x7b respectively), the runtime axis is added.

Until then, this primitive remains a static-binary-evidence
singleton, on the same axis as
[[iii-multiproduct-editor-binary]].

## Refinement history

- 2026-05-22 (cookbook-mine cross-check pass against
  `ghidra-axe-edit-iii-actions-and-shapes.txt`): three split-site
  callers verified by direct line-citation in the dump; uniform
  callers sampled across the 93-caller trace as the supporting
  context. Same-session cookbook entry shipped per the
  discipline rule for newly surfaced primitives.
