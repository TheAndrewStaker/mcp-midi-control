---
name: iii-multiproduct-editor-binary
class: dispatch-context
status: matched-singleton
discovered: 2026-05-22 (cookbook crosscheck mining of ghidra-axe-edit-iii-actions-and-shapes.txt)
verified_on:
  - axe-edit-iii-binary
firmware_sensitive: false
golden: STUB (structural-only; de-facto coverage: the consumed_in dump citation + literal line refs in the body)
relates_to: [vendor-envelope-descriptor-table, iii-host-emitter-fn-table, iii-fn01-set-parameter-envelope, iii-fn01-action-code-per-model-byte]
consumed_in:
  - fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt
---

# AxeEdit III is a multi-product editor binary

AxeEdit III's binary serves three Fractal model bytes simultaneously:

| Model byte | Device  |
|------------|---------|
| `0x10`     | Axe-Fx III |
| `0x11`     | FM3     |
| `0x12`     | FM9     |

Action-code tables, descriptor tables, and per-fn envelopes can each
diverge across these three within the same binary. When mining the
III editor for any wire fact, the answer is potentially three answers
dispatched by the current-device model byte held in `DAT_1412633f8`.

This is a `dispatch-context` primitive: it does not encode a wire
shape itself, but it establishes the axis along which every other III
primitive's claims must be qualified. Treat the model-byte axis as a
first-class dispatch dimension.

## Formal definition

The III editor holds a global current-model-byte at `DAT_1412633f8`.
Most code paths gate behavior on this byte using one of two patterns:

**Pattern A — chained equality (per-model branch):**

```c
cVar1 = *(char *)(param_1 + 0x38);    // local model byte from a struct
if (cVar1 == '\x10') {                 // III
  uVar7 = 0x84;
}
else if (cVar1 == '\x11') {            // FM3
  uVar7 = 0x83;
}
else if (cVar1 == '\x12') {            // FM9
  uVar7 = 0x7b;
}
```

Verbatim from `FUN_1401e38a0` L793-800 in
`fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt`.

**Pattern B — model-family gate (treat the three as equivalent):**

```c
if (((DAT_1412633f8 == 0x10) || (DAT_1412633f8 == 0x11))
   || (DAT_1412633f8 == 0x12)) {
  uVar18 = 10;        // family branch
}
else {
  uVar18 = 0x42;      // non-family fallback
}
```

Verbatim from `FUN_14033c6e0` L23433-23436 (same dump).

Pattern A is used where per-product behavior diverges (action codes,
specific descriptor table addresses); Pattern B is used where the
three are treated as one family against earlier II XL+ / II products
the same binary still supports as legacy.

## Where it's used

Sample call sites from the actions-and-shapes dump (non-exhaustive):

- L793-800 (`FUN_1401e38a0`): fn=0x01 action code 0x84/0x83/0x7b.
- L1040-1048 (`FUN_1401e41e0`): fn=0x01 action code 0x72/0x72/0x79.
- L1085-1086 (`FUN_1401e42a0`): fn=0x01 action code uniform 0x1c.
- L20433-20435 (case 7): model-byte literal-field gate.
- L23138-23339 (`FUN_14033c6e0`): descriptor table address selected
  by model-byte; tables `0x1407ab490` (other II), `0x1407ab590`
  (II XL/XL+), `0x1407abb00` (III/FM3/FM9). See
  [[vendor-envelope-descriptor-table]] §1.D refinement.
- L23433-23436 (`FUN_14033c6e0`): family-bucket Pattern B example.

`DAT_1412633f8` is written at L20420 (`DAT_1412633f8 = bVar2`) and
L25720 (`DAT_1412633f8 = local_1d7[0]`); read at L23433, L25084,
L25149, L25209 (and many others). Whichever code path sets the
device byte at session start determines which dispatch arm fires for
every subsequent wire emission.

## Applicability

Apply this primitive when reading or writing any III-editor-binary
fact. Every claim of the form "the III does X" must be qualified to
"for model byte 0x10, the III emits X; for 0x11 it MAY emit Y; for
0x12 it MAY emit Z." Most fn-byte builders use a uniform action code
across all three (the "MAY" reduces to "does emit X"), but a real
minority of callers diverge per model byte (see
[[iii-fn01-action-code-per-model-byte]]).

When porting III-derived code to FM3 or FM9: do not assume the wire
behavior is byte-identical. Walk the per-caller dispatch and confirm
the model-byte arm explicitly.

## Misapplication failure modes

- **DO NOT** treat "verified against III public captures" as
  evidence for FM3 or FM9. The captures are model-byte 0x10 specific
  even when the bytes appear generic. Any III primitive whose
  `verified_on` only mentions III captures applies to model 0x10
  alone until the FM3 / FM9 dispatch arm is independently checked.
- **DO NOT** copy action-code constants from one fn=0x01 caller to
  another assuming the model dispatch is identical. Some callers
  split (0x84/0x83/0x7b) while most are uniform. The pattern is
  per-caller, not per-family. See
  [[iii-fn01-action-code-per-model-byte]] for the verified split sites.
- **DO NOT** assume `DAT_1412633f8` is constant across a session.
  The byte is rewritten on device-attach events; long-lived caches
  of "the III's behavior" can desync from the current device.

## Where it does NOT apply

- AxeEdit II — separate binary, single product line (Axe-Fx II with
  XL/XL+ legacy under a different code path).
- AM4-Edit — separate binary, single product line.
- Hydrasynth — different vendor / protocol family entirely.
- Future Fractal multi-product editors — if Fractal ships a
  successor that drops one of the three model bytes (or adds a
  fourth), the dispatch logic above changes shape; the primitive
  itself stays but the verified set rotates.

## Verification path

This entry's golden is a STUB (covered by existing verify-* scripts plus the
dump-citation in `consumed_in`). The structural assertion is "the
actions-and-shapes dump contains both Pattern A and Pattern B
dispatch sites at the cited line numbers"; this is enforced by the
`consumed_in:` path existing on disk and the line refs above being
literal.

If a future III dump regeneration causes the cited line numbers to
shift, update this entry's line refs in the same session; the
`consumed_in:` resolution will not break (the file still exists), but
the citations rot silently.

## Path to `matched`

Promotion from `matched-singleton` to `matched` requires a second
axis. Plausible second axes:

- A successor Fractal multi-product editor (none ships today; this
  is the "axis: multi-product editor binary" honest singleton).
- A captured wire trace from each of III, FM3, FM9 demonstrating
  the action-code split at runtime against real devices (closes
  the runtime side; cookbook discipline prefers binary evidence
  alone but live wire verification strengthens the claim).
- A different multi-product editor binary from a non-Fractal vendor
  using an isomorphic dispatch pattern (transfers the abstract
  primitive but not the III-specific facts).

## Refinement history

- 2026-05-22 (cookbook-mine cross-check pass against
  `ghidra-axe-edit-iii-actions-and-shapes.txt`): primitive
  discovered via the 93-caller analysis of `FUN_14033ec70` plus
  the model-byte family gate in `FUN_14033c6e0`. Same-session
  cookbook entry shipped per the discipline rule that newly
  surfaced primitives get registered in the discovery session
  rather than queued.
