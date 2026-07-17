/**
 * Axe-Fx II preset-image SCENE-STATE word codec.
 *
 * Located 2026-07-16 (TLV-relative, layout- and composition-
 * independent): for every placed block whose family has a registered
 * `<block>.bypass` housekeeping paramId k, the per-scene state ushort
 * lives at image word `baseWord + k` (baseWord = tlvWord + 2). Bit
 * semantics (primitive `scene-state-ushort`):
 *
 *   low  byte bit (s-1)  = block BYPASSED in scene s   (s = 1..8)
 *   high byte bit (s-1)  = block on channel Y in scene s
 *
 * Evidence: 32/32 informative BK-070 one-variable hardware pairs each
 * changed EXACTLY ONE word, at exactly baseWord + k, by exactly the
 * predicted single bit (set and clear directions both confirmed);
 * 7 remaining pairs are byte-identical no-op toggles. Corpus: 388/388
 * strict decode, 2885 block scene words, zero impossible states.
 *
 * CAVEATS (honest carve-outs, enforced here):
 *   - Y-mask bits 12..15 (channel Y in scenes 5..8) have no direct
 *     hardware pair; corpus instances decode consistently under the +8
 *     pattern. Writes touching them are pattern-extrapolated
 *     community-beta and get a per-op note.
 *   - Single-channel blocks (odd payload, or the full-payload families
 *     in II_SINGLE_CHANNEL_FULL_PAYLOAD_GROUPS) carry zero Y-mask bits
 *     corpus-wide (88 + 448 instances); channel-Y ops on them refuse.
 *   - Families with NO registered bypass pid (Quad Chorus, FX Loop,
 *     Feedback Send, Tone Match, Mixer, Noisegate) have no located
 *     scene word: refused by name, never guessed.
 *   - Scene words DO carry meaningful byte-2 reserved bits, and they
 *     are now DECODED (2026-07-16, this session): the reserved bits
 *     MIRROR the bypass mask for scenes 1..5,
 *     `b2 & 0x7c == (word & 0x1f) << 2`, i.e. the scene-state field is
 *     really a 21-bit field whose bits 16..20 duplicate bypass bits
 *     0..4 (scenes 6..8 have no mirror room in the septet). Evidence:
 *     16 bk070 hardware pairs flip the mirror bit in lockstep with the
 *     bypass bit (set AND clear directions; Amp, Drive, Delay; scene
 *     1..5 flips carry it, scene 6..8 flips do not; channel-Y flips
 *     never touch it), and the rule holds at 4093/4093 located scene
 *     words across 503 on-disk dumps. Every write here maintains the
 *     mirror; this is what makes the paired-capture replay BYTE-exact,
 *     and it explains the Session-115 NACK 0x13 lesson (a blind-zero
 *     write at a Delay scene word clobbered the mirror).
 *
 * Support status: community-beta / hardware-unverified as a PUSHED
 * image (the paired-capture replay proves the encoding byte-exactly;
 * Session-115 precedent landed scene-word writes on hardware with 0
 * NACKs at old composition-fragile coordinates). Q8.02 / XL+ scoped.
 */

import type { AxeFxIIImageBuffer } from './frames.js';
import {
  parseIIImageTlv,
  findIIImageBlock,
  sceneStateWordIndex,
  II_BYPASS_PID_BY_GROUP,
  type IIImageBlock,
} from './tlv.js';

export const II_SCENE_COUNT = 8;

/**
 * The byte-2 reserved-bit MIRROR at a scene word: bypass bits for
 * scenes 1..5 duplicated at `(word & 0x1f) << 2`. Corpus-universal
 * (4093/4093 scene words, 503 dumps) and hardware-paired in both
 * directions. Scene-word writes must maintain it.
 */
export function sceneWordReservedMirror(word: number): number {
  return (word & 0x1f) << 2;
}

/** Decoded per-scene state for one block. */
export interface IISceneState {
  /** 1-based scene number. */
  readonly scene: number;
  readonly bypassed: boolean;
  readonly channelY: boolean;
}

/** Decode a scene-state ushort into all 8 scenes' state. */
export function decodeSceneStateWord(word: number): IISceneState[] {
  const out: IISceneState[] = [];
  for (let s = 1; s <= II_SCENE_COUNT; s++) {
    out.push({
      scene: s,
      bypassed: (word & (1 << (s - 1))) !== 0,
      channelY: (word & (1 << (7 + s))) !== 0,
    });
  }
  return out;
}

/** One scene-state mutation for one block. */
export interface IISceneStateOp {
  /** Block wire id (must be placed in the image's TLV chain). */
  readonly blockWireId: number;
  /** 1-based scene number, 1..8. */
  readonly scene: number;
  /** New bypass state for that scene (omit = leave unchanged). */
  readonly bypassed?: boolean;
  /** New channel-Y state for that scene (omit = leave unchanged). */
  readonly channelY?: boolean;
}

export interface IIAppliedSceneOp {
  readonly op: IISceneStateOp;
  readonly wordIndex: number;
  readonly beforeWord: number;
  readonly afterWord: number;
  /** Present when the op touched a pattern-extrapolated bit (Y, scenes 5..8). */
  readonly note?: string;
}

export interface IIRefusedSceneOp {
  readonly op: IISceneStateOp;
  readonly reason: string;
}

export type IISceneApplyResult =
  | {
      readonly ok: true;
      readonly image: AxeFxIIImageBuffer;
      readonly applied: readonly IIAppliedSceneOp[];
      readonly refused: readonly IIRefusedSceneOp[];
    }
  | { readonly ok: false; readonly reason: string; readonly refused?: readonly IIRefusedSceneOp[] };

/** RMW a scene-state word's 16-bit value for one op. Pure. */
export function encodeSceneStateWord(current: number, op: IISceneStateOp): number {
  if (!Number.isInteger(op.scene) || op.scene < 1 || op.scene > II_SCENE_COUNT) {
    throw new Error(`encodeSceneStateWord: scene ${op.scene} out of range 1..${II_SCENE_COUNT}`);
  }
  let word = current & 0xffff;
  if (op.bypassed !== undefined) {
    const bit = 1 << (op.scene - 1);
    word = op.bypassed ? word | bit : word & ~bit;
  }
  if (op.channelY !== undefined) {
    const bit = 1 << (7 + op.scene);
    word = op.channelY ? word | bit : word & ~bit;
  }
  return word & 0xffff;
}

function refuseChannelY(block: IIImageBlock): string | undefined {
  if (block.xToYOffset !== undefined) return undefined;
  const why = block.singleChannelFullPayload
    ? 'a single-channel full-payload family'
    : `single-channel (odd payload ${block.payloadLen})`;
  return (
    `wire_id ${block.wireId} is ${why}: it has no channel Y, and the corpus carries zero ` +
    `Y-mask bits on such blocks. Refusing the channel-Y scene op.`
  );
}

/**
 * Apply scene-state ops to a COPY of the image. Per-op refusals are
 * itemized in `refused[]`; ops that pass their gates apply. Whole-op
 * failure only when zero ops applied. Footer recompute is the frame
 * layer's job (`framesFromImage`); this operates at the word layer.
 */
export function applySceneStateToImage(
  source: AxeFxIIImageBuffer,
  ops: readonly IISceneStateOp[],
): IISceneApplyResult {
  if (ops.length === 0) {
    return { ok: false, reason: 'applySceneStateToImage: no ops given.' };
  }
  const tlv = parseIIImageTlv(source.words);
  const words = Uint16Array.from(source.words);
  const reserved = Uint8Array.from(source.reserved);
  const applied: IIAppliedSceneOp[] = [];
  const refused: IIRefusedSceneOp[] = [];

  for (const op of ops) {
    if (!Number.isInteger(op.scene) || op.scene < 1 || op.scene > II_SCENE_COUNT) {
      refused.push({ op, reason: `scene ${op.scene} out of range 1..${II_SCENE_COUNT}.` });
      continue;
    }
    if (op.bypassed === undefined && op.channelY === undefined) {
      refused.push({ op, reason: 'op changes nothing (neither bypassed nor channelY given).' });
      continue;
    }
    const block = findIIImageBlock(tlv, op.blockWireId);
    if (block === undefined) {
      refused.push({ op, reason: `wire_id ${op.blockWireId} is not placed in this preset's TLV chain.` });
      continue;
    }
    const group = block.block?.groupCode;
    if (group === undefined || !II_BYPASS_PID_BY_GROUP.has(group)) {
      refused.push({
        op,
        reason:
          `wire_id ${op.blockWireId}${group ? ` (${group})` : ''} has no registered <block>.bypass ` +
          `housekeeping paramId: its scene-state word is UNLOCATED. Refused by name, never guessed.`,
      });
      continue;
    }
    const wordIndex = sceneStateWordIndex(block);
    if (wordIndex === undefined) {
      refused.push({
        op,
        reason:
          `wire_id ${op.blockWireId}: registered bypass pid ` +
          `${II_BYPASS_PID_BY_GROUP.get(group)} falls outside this dump's self-described ` +
          `payload (${block.payloadLen} words); refusing rather than mis-addressing.`,
      });
      continue;
    }
    if (op.channelY !== undefined) {
      const yRefusal = refuseChannelY(block);
      if (yRefusal !== undefined) {
        refused.push({ op, reason: yRefusal });
        continue;
      }
    }
    const before = words[wordIndex];
    const after = encodeSceneStateWord(before, op);
    words[wordIndex] = after;
    // Maintain the byte-2 bypass mirror (scenes 1..5) alongside the value.
    reserved[wordIndex] = sceneWordReservedMirror(after);
    const note =
      op.channelY !== undefined && op.scene >= 5
        ? 'channel-Y bits for scenes 5..8 are pattern-extrapolated (no direct hardware pair); community-beta.'
        : undefined;
    applied.push(note === undefined
      ? { op, wordIndex, beforeWord: before, afterWord: after }
      : { op, wordIndex, beforeWord: before, afterWord: after, note });
  }

  if (applied.length === 0) {
    return { ok: false, reason: 'no scene ops applied (all refused).', refused };
  }
  return { ok: true, image: { words, reserved }, applied, refused };
}
