/**
 * Long-form agent guidance for the Axe-Fx Standard/Ultra (gen-1), surfaced via
 * describe_device. Keyed by topic.
 */

export const AXEFXGEN1_AGENT_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  support_tier:
    'gen-1 (Axe-Fx Standard/Ultra) is COMMUNITY-BETA. Its wire is decoded byte-exactly from the ' +
    "published Ultra SysEx doc (and verified against the doc's full 0..255 conversion table), but " +
    'the project owns no gen-1 hardware, so nothing is hardware-confirmed. Tell the user changes are ' +
    'beta and to confirm on the front panel. If the user wants the missing preset-authoring surface ' +
    '(apply_preset / save), tell them ONE capture of a gen-1 AxeEdit editing session (place a block, ' +
    'route, save, while USBPcap or MIDI Monitor records) is the single unlock: the how-to is ' +
    "docs/contributing/devices/axe-fx-gen1.md (ask CAPTURE-2) in the project's repo on GitHub.",
  read_back:
    'gen-1 SUPPORTS parameter read-back (community-beta): function 0x02 with the trailing flag set to ' +
    'query(0) returns a MIDI_PARAM_VALUE response carrying the live value and the device\'s own label ' +
    'string. get_param / get_params are wired and return that label as ground truth. BUT this is decoded ' +
    'from the spec and UNCONFIRMED on hardware (the project owns no gen-1 unit): if a read times out the ' +
    'tool returns no_ack; fall back to the front panel and report the result so we can confirm gen-1 ' +
    'reads.',
  get_preset:
    'get_preset IS wired (community-beta) as the SPEC-PINNED SUBSET of the gen-1 patch dump (fn 0x03 -> ' +
    'fn 0x04): it returns the preset NAME, the placed-block layout from the 4x12 effect grid, and whether ' +
    'the dump came from the edit buffer or a stored preset. It does NOT return per-parameter values: the ' +
    "published spec leaves the dump's ~1790-byte parameter region \"undetermined\", so decoding it would be " +
    'a guess; say so plainly and use get_param / get_params for values. Stored reads take location 0..255 ' +
    '(banks A/B); bank C (256..383) refuses because the spec flags those request bytes as OR\'d with an ' +
    'unknown value. All of it is hardware-unverified; ask the user to compare the returned name/blocks to ' +
    'the front panel and report the result.',
  capabilities:
    'Supported: set_param / set_params (full parameter WRITE surface, 922 params / 35 blocks), ' +
    'get_param / get_params (community-beta read-back), get_preset (community-beta, name + block layout ' +
    'ONLY; see the get_preset guidance), and describe_device / list_params / lookup-style ' +
    'introspection. NOT supported: apply_preset, save, scene/channel ops, and block placement; the ' +
    'published gen-1 spec pins no structural WRITE paths, so those are unknown (not gated, unknown). They ' +
    'refuse with capability_not_supported; do not improvise wire bytes for them.',
  preset_workflow:
    'The practical gen-1 workflow: switch presets with send_program_change (standard MIDI Program ' +
    'Change, which works on gen-1 like any MIDI device; bank select CC0 first for presets past 127 per the ' +
    "device's manual), then reshape the loaded preset with set_param / set_params. \"Pick the closest " +
    'preset, then repaint it\" covers most tone requests; what gen-1 cannot do is author a block chain ' +
    'from scratch (no placement wire path). When the user asks for a from-scratch build, say exactly ' +
    'that and offer the switch-then-tweak path instead.',
  scaling:
    'Most knobs are display-first (0..10, dB, Hz). Some params the doc marks non-linear have no decoded ' +
    'curve and take a raw wire value 0..254; list_params shows which. Pass the front-panel reading for ' +
    'display-first params; for the raw ones, set and confirm on the panel.',
});
