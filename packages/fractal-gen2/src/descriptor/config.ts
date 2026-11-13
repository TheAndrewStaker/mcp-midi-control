/**
 * Per-model config for the Axe-Fx II family descriptor factory
 * (`createAxeFxIIDescriptor` in `../descriptor.ts`, `createWriter` in
 * `./writer.ts`, `createReader` in `./reader.ts`).
 *
 * BK-094 / BK-GEN2-FACTORY: the Axe-Fx II XL+ and the AX8 floor unit share
 * ONE gen-2 SysEx codec (`fractal-midi/gen2/axe-fx-ii`): same `00 01 74`
 * envelope, XOR-`&0x7F` checksum, and function-byte space (fn=0x02 SET,
 * fn=0x1F atomic read, fn=0x77/78/79 preset dump, fn=0x28 enum strings),
 * differing only by (a) the wire model byte, (b) a reduced block roster
 * (single-instance-only on several groups), and (c) LLM-facing surface
 * (example_spec, agent_guidance, canonical terms). This mirrors the
 * `fractal-gen3` factory (`createModernFractalDescriptor`) and the
 * `boss-rc` factory (`createBossRcDescriptor`): one codec, per-model configs.
 *
 * Every wire-affecting fact in a config MUST be citable. See
 * `docs/_private/AX8-RESEARCH-2026-07-09.md` for the AX8 config's sources.
 */
import type { PresetSpec, SupportTier } from '@mcp-midi-control/core/protocol-generic/types.js';
import type { AxeFxIIBlock } from 'fractal-midi/gen2/axe-fx-ii';

export interface AxeFxIIConfig {
  /** Stable device id + connection-registry key (e.g. 'axe-fx-ii', 'ax8'). */
  id: string;
  displayName: string;
  /** SysEx model byte: II Mark I/II 0x03, II XL 0x06, II XL+ 0x07, AX8 0x08. */
  modelByte: number;
  connectionLabel: string;
  portMatch: readonly { pattern: RegExp | string }[];
  supportTier: SupportTier;
  /** One-line note on what is hardware-confirmed vs spec/manual-only for THIS model. */
  verification: string;
  /**
   * Per-block-INSTANCE availability filter. Undefined (XL+) = every block in
   * `AXE_FX_II_BLOCKS` is available (unchanged behavior). AX8 passes
   * `(block) => block.availableOnAX8` (the wiki-sourced per-block flag
   * already carried in `fractal-midi/gen2/axe-fx-ii/blockTypes.ts`) so
   * `resolveBlockWithInstance` refuses e.g. "Amp 2" / "Reverb 2" with a clear
   * message instead of silently building a frame the device will never
   * answer. Applied in the writer/reader block resolvers AND in
   * `buildBlockTypes()` (so `describe_device`/`list_params` don't advertise
   * instances the physical unit lacks).
   */
  isBlockAvailable?: (block: AxeFxIIBlock) => boolean;
  /**
   * When true, the write ops NOT in `writeAllowlist` refuse with
   * `capability_not_supported` (mirrors the `writes_gated` /
   * `write_allowlist` pattern `fractal-gen3`'s VP4 config uses). Kept as a
   * generic per-config mechanism for future family members whose write
   * paths are only partially confirmed. No current gen-2 config sets it:
   * the AX8 used it to gate `apply_preset` / `apply_setlist` while the
   * shared build pipeline (`tools/applyExecutor.ts`) always emitted the
   * XL+'s `0x07`; that pipeline has been model-byte-parameterized
   * (BK-GEN2-FACTORY follow-up, 2026-07-15), so every write on every
   * config now carries `config.modelByte`. Defaults false.
   */
  writesGated?: boolean;
  /** Op names exempt from the gate above. Ignored when `writesGated` is falsy. */
  writeAllowlist?: readonly string[];
  /**
   * BK-084 mode-collapse: enable `set_params`' internal atomic dump/
   * patch/push/verify image path (formerly reached via apply_preset
   * mode:'retune'; the mechanism is unchanged, only its entry point —
   * now an invisible batch-size heuristic inside set_params rather than
   * a caller-visible mode). True ONLY on the XL+ today: the image codec
   * is oracled against the XL+ Q8.02 corpus (388 dumps) and the XL+'s
   * own hardware captures. The AX8 is deliberately excluded — zero AX8
   * dumps on disk means no corpus oracle for its image grammar (the
   * evidence bar keeps it out); once an AX8 dump corpus exists, enabling
   * it is this config flip. Defaults false.
   */
  supportsAtomicParamImage?: boolean;
  /** Reason appended to a gated-write refusal. Falls back to a generic model-byte note. */
  gatedWriteReason?: string;
  /**
   * Override `describe_device.example_spec`. Defaults (undefined) to the
   * XL+'s `AXEFX2_EXAMPLE_SPEC` in `descriptor.ts`. AX8 supplies its own
   * (the XL+ example places a second Amp instance, which the AX8 doesn't
   * have; `isBlockAvailable` would refuse it if apply_preset tried it).
   */
  exampleSpec?: PresetSpec;
  /**
   * Extra agent-guidance prose merged on top of the shared
   * `AXEFX2_AGENT_GUIDANCE` (keys here win). Used for a `device_note` topic
   * naming the model + its block-roster caveats (mirrors how the gen-3
   * VP4 config layers a `device_note` over `MODERN_AGENT_GUIDANCE`).
   */
  agentGuidanceOverlay?: Readonly<Record<string, string>>;
}
