---
name: iii-fn0e-fn16-from-ii-transfer
class: fn-byte-mapping
status: non-matching
verified_on:
  - axe-fx-iii-v14-pdf
  - axe-edit-iii-binary
golden: STUB (structural grep-against committed III SYSEX-MAP + string pool; no pure-CPU fixture applies, see Verification path)
retest_when:
  - a captured III connect-and-sync burst decoding the workflow-scoped reply BODIES (the fn 0x0A/0x0D/0x0C/0x47 param-info family and the fn 0x14 GET reply, flagged un-mined in the private captured-artifacts manifest)
  - a live III capture of the fn 0x0E QUERY SCENE NAME reply (currently grounded on the v1.4 PDF + committed wire map, not a hardware capture)
relates_to: [ii-fn0e-query-states, ii-fn16-get-param-info, iii-host-emitter-fn-table, iii-async-workflow-fn-registry, ii-fn1f-atomic-read]
consumed_in: []
---

# Axe-Fx II fn 0x0E / fn 0x16 do NOT transfer to Axe-Fx III by fn byte

The Axe-Fx II whole-state read (fn 0x20 GET_GRID plus fn 0x0E
QUERY_STATES) and the II per-parameter descriptor read (fn 0x16
GET_PARAM_INFO, see [[ii-fn16-get-param-info]]) do NOT carry over to
Axe-Fx III at the same fn-byte values. The two devices are separate
protocol families: II uses a dense flat OpcodeDescriptor table
(`wire = enum - 1`, [[ii-axeedit-opcode-table]]) where 0x0E / 0x16 / 0x20
are contiguous QUERY_STATES / GET_PARAM_INFO / GET_GRID, while III routes
inbound by a sparse runtime workflow registry
([[iii-async-workflow-fn-registry]]) where the same byte values mean
unrelated things.

## Evidence

- **III 0x0E is QUERY SCENE NAME, not QUERY_STATES.** The committed III
  wire map documents fn 0x0E as QUERY SCENE NAME with a request payload
  of a scene index (`7F` = current scene) and a response of
  `nn dd*32` (scene index plus 32 name bytes), per
  `packages/fractal-midi/docs/devices/axe-fx-iii/SYSEX-MAP.md` (the
  0x0E row in the function table, corroborated by the result-code
  example "host sent QUERY_SCENE_NAME (0x0E)"). Sending the II
  QUERY_STATES request to a III at 0x0E would query a scene name, not a
  block-state frame. Corroboration from the editor binary string pool:
  `samples/captured/decoded/axeedit3-strings.json` contains
  `SYSEX_GET_SCENENAME` and contains NO `QUERY_STATES` token.
- **III 0x16 is not host-emitted by AxeEdit III.** Byte 0x16 is absent
  from the III host-emitter caller table
  (`samples/captured/decoded/axeedit3-fnbyte-callers.md`) and from the
  21-fn binary inventory; the III function inventory jumps from 0x14 to
  0x19. It surfaces only in non-host-emitter contexts (an effect-type
  dispatcher case and a fn-0x64 result-code index), so there is no III
  host-side GET_PARAM_INFO at 0x16 to mirror the II descriptor read.

## Where the conceptual operations actually live on III

The operations exist on III, but workflow-scoped rather than as
standalone opcodes:

- **Param metadata** lives in a Query-All-Param-Definitions workflow
  using fn 0x0A / 0x0D / 0x0C / 0x47 (binary strings `msg_getParamInfo`,
  `get_param_info`, `get_param_info_all`, `dynamicParamInfo`), not a
  single fn 0x16 frame.
- **Whole-state read** is the III atomic-read family fn 0x19 (File
  Snapshot / Get Preset Data) plus fn 0x14, not a fn-0x0E-style
  5-byte-record frame. See the "Where it does NOT apply" note in
  [[ii-fn1f-atomic-read]].

## Cheapest probe (contributor-gated, III owner)

With AxeEdit III closed, on a scratch preset with Drive 1 placed,
USBPcap-capture AxeEdit III performing its block-definition read for
Drive 1 and isolate the device reply for one `(effectId, paramId)`.
Classify whether the reply tiles into the II fn 0x16 25-byte
5-group-of-5-septet descriptor or a different stride. Separately confirm
the III fn 0x0E QUERY SCENE NAME reply is `nn` plus 32 name bytes on
hardware (currently grounded on the v1.4 PDF and the committed wire map,
not on a live III capture).

## Symptoms / grep terms

Search these before re-attempting:

- "III fn 0x0E QUERY_STATES" / "0x0E is QUERY SCENE NAME on III"
- "III fn 0x16 GET_PARAM_INFO" / "0x16 not host-emitted"
- "II fn-byte transfer to III" / "same fn byte different meaning"

## Refinement history

- 2026-05-28: negative finding committed. Verified III 0x0E maps to
  QUERY SCENE NAME (committed III SYSEX-MAP plus binary string pool;
  `QUERY_STATES` token absent) and III 0x16 is absent from the III
  host-emitter caller table. The II to III fn-byte transfer for both
  reads is ruled out; the conceptual analogs are workflow-scoped on III.
