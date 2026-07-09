/**
 * Modern Fractal family, DeviceReader (get_param / get_params).
 *
 * Reads go through the gen-3 fn=0x1F block bulk-read: poll the block, collect
 * its 0x74/0x75(xN)/0x76 state-broadcast burst, and index the POSITIONAL 0x75
 * body. This is the only gen-3 read whose wire shape is byte-confirmed on
 * hardware (FM9 capture 2026-06-03); the fn=0x01 sub=0x09 per-param GET was
 * never observed on the wire, and the sub=0x01 info-GET is a descriptor query,
 * not a value read.
 *
 * ⚠️ The 0x75 body is NOT a flat paramId-indexed vector. It is CHANNEL-BLOCKED:
 * contiguous per-channel copies of every paramId slot, so
 *   broadcast_index = channel × stride + paramId,  stride = itemCount / channels.
 * FM9 capture 2026-06-04 (amp Balance, catalog paramId 2) changed only index
 * 149 = 1×147 + 2 (channel B), with the channel-A copy at index 2 unchanged
 * (DISTORT 588 = 147×4, REVERB 292 = 73×4), validated by a 5-refuter
 * adversarial pass. The CHANNEL COUNT IS PER-BLOCK, not a universal 4: the FM3
 * field test (fw 12.00, 2026-06-12) returned itemCounts NOT divisible by 4
 * (Send=2, Return=6, Ring Mod=26, Megatap=70; Looper 24 is likely 24×1 and
 * Resonator 80 likely 40×2), so `strideOf` derives each block's channel count
 * from the dump size against the catalog's max paramId instead of assuming 4.
 * The old code indexed `values[paramId]`, which silently read CHANNEL A only;
 * `projectParam` below resolves the requested channel (or refuses when a param
 * differs across channels and none is given).
 * See axe-fx-iii/SYSEX-MAP.md "gen-3 state-broadcast is channel-blocked".
 *
 * Community beta: the burst shape is confirmed on FM9 (front-panel-driven and
 * as the answer to a poll), but our SERVER issuing the poll and reading the reply
 * has not been confirmed end-to-end on hardware. Reads that get no burst time out
 * with a beta-flavored hint rather than asserting a value.
 */
import type {
  DeviceReader,
  DispatchCtx,
  ReadResult,
  BatchReadResult,
  ParamQuery,
  PresetSnapshot,
  PresetSnapshotSlot,
  SceneSpec,
  GetPresetOptions,
  PresetBinaryDump,
  Gen3WholePresetView,
  Gen3GridCellView,
  Gen3LiveMeters,
  OverwriteTargetInfo,
  LocationRef,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import type { ModernFractalCodec, Gen3BlockBulkRead } from 'fractal-midi/gen3/axe-fx-iii';
import {
  buildRequestPresetDump,
  parseGen3StateBroadcastHead,
  buildRequestGridLayout,
  parseGen3GridLayout,
  parseGen3LiveMeters,
} from 'fractal-midi/gen3/axe-fx-iii';
import {
  VP4_MODEL_ID,
  buildVp4GetStructureBlob,
  parseVp4StructureBlob,
} from 'fractal-midi/gen3/vp4';
import type { Vp4StructureBlob } from 'fractal-midi/gen3/vp4';
import { parsePresetDump, extractPresetName } from './presetDump.js';
import { decodeGen3PresetDump, effectName } from './presetBody.js';
import type { Gen3DecodedPreset } from './presetBody.js';
import type { ModernCatalog } from './catalog.js';

/**
 * Send the fn=0x1F poll for `effectId` and collect the 0x74/0x75/0x76 burst.
 *
 * Subscribes BEFORE sending so the device's reply (the burst lands ~1 ms after
 * the poll, often within a single USB callback frame) cannot outrace listener
 * registration. Gates on the 0x74 head's blockId matching `effectId` so an
 * unrelated front-panel broadcast for another block does not corrupt the read.
 *
 * Throws DispatchError('no_ack') when no head arrives within the window, and
 * when the burst is truncated (fewer values than the head advertised), so a
 * partial dump is never silently treated as a complete read.
 */
async function collectBlockBulkRead(
  ctx: DispatchCtx,
  codec: ModernFractalCodec,
  effectId: number,
  deviceLabel: string,
  timeoutMs: number,
): Promise<Gen3BlockBulkRead> {
  const frames: number[][] = [];
  let headSeen = false;
  let nackSeen = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });
  const unsubscribe = ctx.conn.onMessage((bytes) => {
    if (codec.isGen3BroadcastFrame(bytes, 0x74)) {
      if (headSeen) return; // already have our head; ignore duplicate / other blocks
      const { blockId } = parseGen3StateBroadcastHead(bytes);
      if (blockId !== effectId) return; // unrelated broadcast (e.g. a front-panel edit)
      headSeen = true;
      frames.push([...bytes]);
    } else if (codec.isGen3BroadcastFrame(bytes, 0x75)) {
      if (!headSeen) return; // body before our head; drop
      frames.push([...bytes]);
    } else if (codec.isGen3BroadcastFrame(bytes, 0x76)) {
      if (!headSeen) return; // end before our head; drop
      frames.push([...bytes]);
      resolveDone();
    } else if (!headSeen && codec.isMultipurposeResponse(bytes)) {
      // The device NACKs a poll for an UNPLACED block with a fn=0x64
      // multipurpose response instead of a burst. Resolve immediately so a
      // get_preset poll loop does not pay the full timeout for every empty
      // block (turning ~40 empty blocks from ~32s of timeouts into ~2s).
      nackSeen = true;
      resolveDone();
    }
  });
  // The timer always resolves (never rejects), so control returns to the
  // post-await integrity checks below and the no_ack DispatchError they build
  // is the single error surface. A head with no 0x76 (lost end frame) still
  // resolves here; the truncation check catches genuinely incomplete bursts.
  const timer = setTimeout(resolveDone, timeoutMs);
  try {
    ctx.conn.send(codec.buildBlockBulkReadPoll(effectId));
    await done;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  if (!headSeen) {
    throw new DispatchError(
      'no_ack',
      deviceLabel,
      nackSeen
        ? `get_param: ${deviceLabel} answered the fn=0x1F poll for effect ID ${effectId} with a ` +
          `multipurpose NACK, which means the block is not placed in the active preset.`
        : `get_param: no fn=0x74/0x75/0x76 state-broadcast burst from ${deviceLabel} within ${timeoutMs}ms ` +
          `in answer to the fn=0x1F poll for effect ID ${effectId}. Likely causes: the block is not placed ` +
          `in the active preset (gen-3 rejects a poll for an empty block with a multipurpose NACK, not a ` +
          `burst), or the gen-3 poll-to-burst read path is not yet confirmed on this hardware (community beta).`,
    );
  }
  const bulk = codec.assembleGen3BlockBulkRead(frames);
  if (bulk.values.length < bulk.itemCount) {
    throw new DispatchError(
      'no_ack',
      deviceLabel,
      `get_param: truncated state-broadcast burst from ${deviceLabel} for effect ID ${effectId}: ` +
        `the 0x74 head advertised ${bulk.itemCount} params but only ${bulk.values.length} arrived ` +
        `(a 0x75 body frame was lost). Refusing to report a partial dump as a complete read; retry.`,
    );
  }
  return bulk;
}

/** Inter-frame quiet window that terminates the tail-less edit-buffer burst. */
const EDIT_BUFFER_QUIET_MS = 250;

/**
 * Send the fn=0x43 REQUEST_EDIT_BUFFER_DUMP and collect the reply: a 0x51 head
 * + a homogeneous run of 0x52 body frames. The gen-3 edit-buffer dump has NO
 * tail frame (unlike the stored dump's 0x79), so the burst is terminated by
 * "read until quiet": once the head has arrived, each new dump frame re-arms an
 * inter-frame timer, and the burst is complete when no new dump frame lands
 * within `EDIT_BUFFER_QUIET_MS` (or when a non-dump inbound frame arrives).
 * This reads only what the device sends, so it emits no speculative bytes and
 * cannot truncate early (it stops only when the 0x52 frames stop).
 *
 * Subscribes BEFORE the caller sends so the burst can't outrace the listener.
 * Rejects if no 0x51 head arrives within `headTimeoutMs`, or if a head arrives
 * with no 0x52 body (a malformed / empty dump).
 */
function collectEditBufferDump(
  ctx: DispatchCtx,
  codec: ModernFractalCodec,
  headTimeoutMs: number,
): Promise<number[][]> {
  return new Promise<number[][]>((resolve, reject) => {
    const frames: number[][] = [];
    let headSeen = false;
    let settled = false;
    let interTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(headTimer);
      if (interTimer !== undefined) clearTimeout(interTimer);
      unsubscribe();
      if (!headSeen) {
        reject(new Error(`no 0x51 edit-buffer dump head within ${headTimeoutMs}ms`));
      } else if (frames.length < 2) {
        reject(new Error('edit-buffer dump head arrived with no 0x52 body frames'));
      } else {
        resolve(frames);
      }
    };
    const armQuietTimer = (): void => {
      if (interTimer !== undefined) clearTimeout(interTimer);
      interTimer = setTimeout(finish, EDIT_BUFFER_QUIET_MS);
    };
    const unsubscribe = ctx.conn.onMessage((bytes) => {
      if (codec.isEditBufferDumpHead(bytes)) {
        if (headSeen) return; // ignore an unexpected second head
        headSeen = true;
        clearTimeout(headTimer); // initial-head guard satisfied
        frames.push([...bytes]);
        armQuietTimer();
      } else if (headSeen && codec.isEditBufferDumpBody(bytes)) {
        frames.push([...bytes]);
        armQuietTimer();
      } else if (headSeen) {
        finish(); // a non-dump inbound frame after the burst started ends it
      }
      // Frames before the head are ignored (stray broadcasts).
    });
    const headTimer = setTimeout(finish, headTimeoutMs);
  });
}

/**
 * Send fn=0x03 REQUEST_PRESET_DUMP for `presetNum` and collect the
 * 0x77 head + 0x78 body frames + 0x79 tail. Wire-confirmed on FM9 fw 11.00
 * (capture 2026-06-04): host sends `F0 00 01 74 <model> 03 <hi> <lo> <cs> F7`,
 * device replies with one 0x77 (13 B), N x 0x78 body frames (3082 B each), and
 * one 0x79 tail (11 B). Frame count varies by device (FM9 = 8 chunks).
 *
 * Subscribes BEFORE sending so the burst cannot outrace the listener.
 * Rejects if no 0x77 head arrives within `timeoutMs`, or if the head arrives
 * with no 0x78 body frames.
 */
function collectStoredPresetDump(
  ctx: DispatchCtx,
  codec: ModernFractalCodec,
  presetNum: number,
  deviceLabel: string,
  timeoutMs: number,
): Promise<number[][]> {
  // fn bytes for the stored-preset dump triple.
  const FN_HEAD = 0x77;
  const FN_BODY = 0x78;
  const FN_TAIL = 0x79;
  const isHead = (b: number[]): boolean => b[5] === FN_HEAD;
  const isBody = (b: number[]): boolean => b[5] === FN_BODY;
  const isTail = (b: number[]): boolean => b[5] === FN_TAIL;

  return new Promise<number[][]>((resolve, reject) => {
    const frames: number[][] = [];
    let headSeen = false;
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(headTimer);
      unsubscribe();
      if (err !== undefined) {
        reject(err);
      } else if (!headSeen) {
        reject(new Error(`no fn=0x77 stored-preset dump head from ${deviceLabel} within ${timeoutMs}ms`));
      } else if (frames.length < 2) {
        reject(new Error(`stored-preset dump head arrived with no fn=0x78 body frames from ${deviceLabel}`));
      } else {
        resolve(frames);
      }
    };
    const unsubscribe = ctx.conn.onMessage((bytes) => {
      const arr = [...bytes];
      if (isHead(arr)) {
        if (headSeen) return; // unexpected second head; ignore
        headSeen = true;
        clearTimeout(headTimer);
        frames.push(arr);
      } else if (headSeen && isBody(arr)) {
        frames.push(arr);
      } else if (headSeen && isTail(arr)) {
        frames.push(arr);
        finish();
      } else if (headSeen && !isBody(arr) && !isTail(arr)) {
        // A non-dump inbound frame after the burst started ends it.
        finish();
      }
      // Frames before the head are ignored (stray broadcasts).
    });
    const headTimer = setTimeout(() => finish(), timeoutMs);
    // Send AFTER subscribing.
    ctx.conn.send(buildRequestPresetDump(presetNum, codec.modelByte));
  });
}

/**
 * Read the LIVE routing grid of the active buffer in one round-trip:
 * `fn=0x01 sub=0x2E` empty-target query → a single ~755-byte reply carrying the
 * 7-bit-packed grid bitstream. Subscribes BEFORE sending (the reply can land in
 * the same USB callback). Resolves with the reply frame, or throws no_ack on
 * timeout. Gates on a LARGE sub=0x2E inbound frame so a small echo/value frame
 * for the same sub-action isn't mistaken for the grid dump.
 */
async function collectGridLayout(
  ctx: DispatchCtx,
  codec: ModernFractalCodec,
  deviceLabel: string,
  timeoutMs: number,
): Promise<number[]> {
  let frame: number[] | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });
  const unsubscribe = ctx.conn.onMessage((bytes) => {
    // fn=0x01 sub=0x2E reply; the grid dump is the large (~755B) one.
    if (bytes[1] === 0x00 && bytes[5] === 0x01 && bytes[6] === 0x2e && bytes.length > 400) {
      if (frame) return;
      frame = [...bytes];
      resolveDone();
    }
  });
  const timer = setTimeout(resolveDone, timeoutMs);
  try {
    ctx.conn.send(buildRequestGridLayout(codec.modelByte));
    await done;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  if (!frame) {
    throw new DispatchError(
      'no_ack',
      deviceLabel,
      `get_preset: no live grid (fn=0x01 sub=0x2E) reply from ${deviceLabel} within ${timeoutMs}ms.`,
    );
  }
  return frame;
}

/**
 * VP4 only: read the active preset's STRUCTURE in one round-trip via the
 * eid206 pid0 tc=0x1f blob (preset name, scene names, current scene, and the
 * serial 4-slot chain). This is the register VP4-Edit itself polls to render
 * the chain; the request/response are byte-decoded from two fw 4.03 community
 * captures (`fractal-midi/src/gen3/vp4/structureBlob.ts`). Subscribes BEFORE
 * sending (the reply can land in the same USB callback). Throws no_ack on
 * timeout; the caller treats the structure read as best-effort.
 */
async function collectVp4StructureBlob(
  ctx: DispatchCtx,
  deviceLabel: string,
  timeoutMs: number,
): Promise<Vp4StructureBlob> {
  let frame: number[] | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => {
    resolveDone = res;
  });
  const unsubscribe = ctx.conn.onMessage((bytes) => {
    // fn=0x01 reply on the structure register: eid206 (4E 01), pid0, tc=0x1f.
    // Gate on a LARGE frame so the editor-style 18-byte query echo (if any)
    // isn't mistaken for the 238-byte blob response.
    if (
      bytes[4] === VP4_MODEL_ID && bytes[5] === 0x01 &&
      bytes[6] === 0x4e && bytes[7] === 0x01 &&
      bytes[8] === 0x00 && bytes[9] === 0x00 &&
      bytes[10] === 0x1f && bytes.length > 100
    ) {
      if (frame) return;
      frame = [...bytes];
      resolveDone();
    }
  });
  const timer = setTimeout(resolveDone, timeoutMs);
  try {
    ctx.conn.send(buildVp4GetStructureBlob());
    await done;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  if (!frame) {
    throw new DispatchError(
      'no_ack',
      deviceLabel,
      `get_preset: no structure-blob (eid206 pid0 tc=0x1f) reply from ${deviceLabel} within ${timeoutMs}ms.`,
    );
  }
  return parseVp4StructureBlob(frame);
}

/**
 * Read a DISCRETE (type/model) param's CURRENT name directly off the device via
 * the fn=0x01 sub=0x1F type-name GET (reply decoded by parseGetParameterResponse,
 * `.displayString`). The positional fn=0x1F BULK read mis-addresses type
 * selectors — its value is not the roster ordinal (FM9 capture 2026-06-19: a
 * reverb whose device name was "Small Room"/ordinal 0 read back as positional
 * value 5 = "Large Hall"), so for enum/type params the device's own name string
 * is authoritative. Byte-grounded on FM9 fw 11.0 (the device answered both the
 * sub=0x1F and sub=0x09 type GETs with the name). Returns the name, or undefined
 * when the device doesn't answer (caller falls back to the bulk read — older
 * firmware / III·FM3 where this GET reply isn't yet confirmed).
 */
async function readCurrentTypeName(
  ctx: DispatchCtx,
  codec: ModernFractalCodec,
  effectId: number,
  typeParamId: number,
  timeoutMs: number,
): Promise<string | undefined> {
  const respPromise = ctx.conn.receiveSysExMatching(
    (b) => codec.isGetParameterResponse(b),
    timeoutMs,
  );
  ctx.conn.send(codec.buildRequestCurrentTypeName(effectId, typeParamId));
  try {
    const resp = await respPromise;
    const parsed = codec.parseGetParameterResponse(resp);
    if (parsed.effectId === effectId && parsed.displayString.length > 0) {
      return parsed.displayString;
    }
  } catch {
    // device didn't answer the type-name GET; caller falls back to the bulk read.
  }
  return undefined;
}

/**
 * Best-effort read of the device's CURRENT active scene index (fn=0x0C with the
 * `7F` query sentinel → a 0x0C reply whose payload byte is the scene). The scene
 * QUERY is the spec-documented form and has NO write side-effect — unlike the
 * tempo query (fn=0x14 `7F 7F`), which on early-firmware III is reported to SET
 * the tempo to 250 BPM, so tempo is deliberately NOT auto-read here. Returns
 * undefined when the device doesn't answer in time; the caller then leaves the
 * active scene simply unknown rather than failing the whole read.
 */
async function readActiveScene(
  ctx: DispatchCtx,
  codec: ModernFractalCodec,
  timeoutMs: number,
): Promise<number | undefined> {
  const respPromise = ctx.conn.receiveSysExMatching(
    (b) => codec.isSetGetSceneResponse(b),
    Math.min(250, timeoutMs),
  );
  // send() is INSIDE the try: it throws synchronously on a dead/closed handle,
  // and this helper's whole contract is best-effort (return undefined, never
  // throw) — letting a send throw escape would trip get_preset's outer grid
  // catch and mislabel a present live_grid as absent. respPromise is already
  // pre-observed by receiveSysExMatching, so not awaiting it on the throw path
  // does not leak an unhandled rejection.
  try {
    ctx.conn.send(codec.buildGetScene());
    return codec.parseSceneResponse(await respPromise).scene;
  } catch {
    return undefined;
  }
}

/**
 * Convert a live sub=0x2E grid reply into the same `Gen3GridCellView[]` shape as
 * the stored-dump grid (`whole_preset.grid`), labeling blocks with the SAME
 * `effectName` convention. The cable bitmask is carried raw in `route_flag`;
 * `from_rows` (edge direction) is intentionally NOT emitted — its decode is
 * community-beta and unvalidated, and a wrong edge is worse than none.
 */
export function liveGridView(frame: number[], modelByte: number): Gen3GridCellView[] {
  return parseGen3GridLayout(frame, modelByte).map((c) =>
    c.isShunt
      ? {
          effect_id: c.shuntIndex ?? 0,
          row: c.row,
          col: c.col,
          route_flag: c.cableInputMask,
          name: `Shunt ${c.shuntIndex ?? 0}`,
          is_shunt: true,
        }
      : {
          effect_id: c.effectId ?? 0,
          row: c.row,
          col: c.col,
          route_flag: c.cableInputMask,
          name: effectName(c.effectId ?? -1) ?? `eid_${c.effectId}`,
        },
  );
}

/** Map a fully-decoded gen-3 preset to the rich `whole_preset` view. */
function wholePresetView(
  decoded: Gen3DecodedPreset,
  source: Gen3WholePresetView['source'],
): Gen3WholePresetView {
  return {
    source,
    model: decoded.model_name,
    model_id: decoded.model_id,
    preset_name: decoded.preset_name,
    crc_valid: decoded.crc_valid,
    scene_names: decoded.scene_names,
    grid: decoded.grid,
    blocks: decoded.blocks,
    amp: decoded.amp1,
    modifiers: decoded.modifiers,
    scene_controllers: decoded.scene_controllers,
  };
}

/**
 * Build a PresetSnapshot from a fully-decoded gen-3 preset dump. The standard
 * envelope (name / slots / scenes) is filled as a friendly summary; the full
 * fidelity (routing grid, per-channel block types, scene controllers, modifiers)
 * lives in `whole_preset`. Slots/scenes are derived from the decoded block chain
 * and are informational — NOT a positioned grid that round-trips through
 * apply_preset.
 */
function snapshotFromDecoded(
  decoded: Gen3DecodedPreset,
  source: Gen3WholePresetView['source'],
  deviceLabel: string,
  readStartedMs: number,
): PresetSnapshot {
  const placed = decoded.blocks ?? [];
  // Unique id per block (family, with _N suffix when a family repeats), so
  // scene channel/bypass maps key cleanly even with two Comps / two Amps.
  const counts: Record<string, number> = {};
  const ids: string[] = [];
  const slots: PresetSnapshotSlot[] = placed.map((b, i) => {
    counts[b.block] = (counts[b.block] ?? 0) + 1;
    const id = counts[b.block] === 1 ? b.block : `${b.block}_${counts[b.block]}`;
    ids.push(id);
    const params: Record<string, number | string> = {};
    const type = b.type ?? b.channels?.A?.type;
    if (typeof type === 'string') params.type = type;
    return { slot: i + 1, block_type: b.block, id, params };
  });

  const sceneNames = decoded.scene_names ?? [];
  const scenes: SceneSpec[] = [];
  for (let s = 0; s < 8; s++) {
    const channels: Record<string, string | number> = {};
    const bypassed: Record<string, boolean> = {};
    placed.forEach((b, i) => {
      const ch = b.scene_channels?.[s];
      if (ch !== undefined) channels[ids[i]] = ch;
      const byp = b.scene_bypass?.[s];
      if (byp !== undefined) bypassed[ids[i]] = byp;
    });
    scenes.push({ scene: s + 1, channels, bypassed, name: sceneNames[s] });
  }

  const warnings = [
    `gen-3 whole-preset decode (${source}): the patch body was Huffman-decompressed and ` +
      `structurally decoded (CRC ${decoded.crc_valid ? 'valid' : 'INVALID, values may be unreliable'}). ` +
      `'slots'/'scenes' are a summary; the full routing grid, per-channel (A/B/C/D) block types, ` +
      `scene controllers, and modifiers are in 'whole_preset'. This snapshot is informational; ` +
      `it is NOT a positioned grid that round-trips through apply_preset by slot. Named knob VALUES ` +
      `beyond amp are not yet decoded (the body word->knob map awaits a value-scale ground truth).`,
  ];

  return {
    name: decoded.preset_name,
    slots,
    scenes,
    whole_preset: wholePresetView(decoded, source),
    read_warnings: warnings,
    _meta: {
      device: deviceLabel,
      read_at_ms: readStartedMs,
      active_scene_only: false,
      routing_omitted: false,
      channel_state_omitted: false,
      read_duration_ms: Date.now() - readStartedMs,
    },
  };
}

export function makeReader(opts: {
  codec: ModernFractalCodec;
  catalog: ModernCatalog;
  deviceLabel: string;
  getResponseTimeoutMs: number;
  /** Channel names in wire-index order (A,B,C,D). Index i == channel i. */
  channelNames: readonly string[];
  /**
   * True when the catalog is DEVICE-TRUE (mined from this device's own editor
   * tables, so the per-block max paramId equals the device's actual per-block
   * param count). Gates the per-block channel-count derivation in `strideOf`:
   * the maxPid floor is only a valid stride oracle when the catalog is not a
   * superset (the III's mined catalog over-counts some blocks, which would
   * mis-derive a 4-channel dump as flat). Defaults false → legacy ÷4 rule.
   */
  deviceTrueCatalog?: boolean;
}): DeviceReader {
  const { codec, catalog, deviceLabel, getResponseTimeoutMs, channelNames } = opts;
  const deviceTrueCatalog = opts.deviceTrueCatalog ?? false;
  const { resolveBlockOrThrow, resolveParamOrThrow } = catalog;

  // The gen-3 0x75 state-broadcast is CHANNEL-BLOCKED: the body packs per-
  // channel copies of every paramId slot (channel-major), so
  //   broadcast_index = channel × stride + paramId,  stride = itemCount / channels.
  // FM9 capture 2026-06-04 (amp Balance, paramId 2) changed only index 149 =
  // 1×147 + 2 (channel B); the channel-A copy at index 2 stayed constant
  // (DISTORT 588 = 147×4, REVERB 292 = 73×4). But the channel count is
  // PER-BLOCK, not a universal 4: the FM3 field test (fw 12.00, 2026-06-12)
  // returned itemCounts not divisible by 4 — Send=2, Return=6, Ring Mod=26,
  // Megatap=70 — and blocks where the ÷4 split would mis-address real catalog
  // params (Looper 24 vs max paramId 23 is likely 24×1; Resonator 80 vs max
  // paramId 39 likely 40×2). strideOf derives each block's channel count from
  // the dump size against the catalog's max paramId. Indexing values[paramId]
  // (the old code) only read CHANNEL A; projectParam projects the requested
  // channel instead. See axe-fx-iii/SYSEX-MAP.md.
  const LEGACY_NUM_CHANNELS = 4;

  // Largest catalog paramId per block slug (memoized) — the floor any
  // candidate stride must clear for the catalog's params to be addressable.
  const maxPidBySlug = new Map<string, number | undefined>();
  function maxCatalogPid(blockSlug: string): number | undefined {
    if (maxPidBySlug.has(blockSlug)) return maxPidBySlug.get(blockSlug);
    let max: number | undefined;
    for (const key of Object.keys(catalog.blocks[blockSlug]?.params ?? {})) {
      try {
        const pid = resolveParamOrThrow(blockSlug, key, deviceLabel).param.paramId;
        if (max === undefined || pid > max) max = pid;
      } catch {
        // name not resolvable to a paramId — skip
      }
    }
    maxPidBySlug.set(blockSlug, max);
    return max;
  }

  /**
   * Per-channel stride + channel count of a bulk dump. Channel count is
   * derived PER BLOCK: the largest c in {4, 2, 1} such that the dump divides
   * evenly into c copies AND each copy is big enough to hold every catalog
   * paramId (itemCount/c >= maxPid+1). When no candidate fits (or the catalog
   * gives no paramIds), fall back to the legacy rule — ÷4 when divisible,
   * else one flat copy — so non-conforming blocks degrade the same way they
   * did before the FM3 per-block-channel finding.
   *
   * The maxPid derivation runs ONLY on device-true catalogs (FM3/FM9/VP4):
   * there maxPid+1 equals the device's actual per-block param count, so it is
   * a sound stride floor. The III's catalog is a mined SUPERSET — its maxPid
   * can exceed a real 4-channel dump's stride, which would mis-derive the
   * dump as 2-channel or flat (wrong-channel reads). The III keeps the
   * legacy rule until its catalog is device-true.
   */
  function strideOf(bulk: Gen3BlockBulkRead, maxPid: number | undefined): { stride: number; channels: number } {
    if (bulk.itemCount > 0 && bulk.values.length >= bulk.itemCount) {
      // Descending candidate channel counts. On a DEVICE-TRUE catalog
      // stride == maxPid+1 exactly, so the correct channel count is the LARGEST
      // c that still leaves room for every paramId (itemCount/c >= maxPid+1); any
      // larger c under-sizes the stride and is rejected, so trying 6/3 ahead of
      // 4/2 cannot mis-derive a 4-channel block. 6 covers the Multiplexer
      // (itemCount 42 = 6×7, maxPid 6 — the ÷4 rule fell through to 2×21 and
      // mis-addressed channels B-D; FM9 capture 2026-06-19).
      if (deviceTrueCatalog && maxPid !== undefined) {
        for (const c of [6, 4, 3, 2, 1]) {
          if (bulk.itemCount % c === 0 && bulk.itemCount / c >= maxPid + 1) {
            return { stride: bulk.itemCount / c, channels: c };
          }
        }
      }
      if (bulk.itemCount % LEGACY_NUM_CHANNELS === 0) {
        return { stride: bulk.itemCount / LEGACY_NUM_CHANNELS, channels: LEGACY_NUM_CHANNELS };
      }
    }
    return { stride: bulk.values.length, channels: 1 };
  }

  /** Normalize a channel arg (already a 0-based index from the dispatcher, but
   *  tolerate a name string) to a channel index, or undefined if unspecified. */
  function channelArgToIndex(channel?: string | number): number | undefined {
    if (channel === undefined) return undefined;
    if (typeof channel === 'number') {
      return Number.isInteger(channel) && channel >= 0 ? channel : undefined;
    }
    const idx = channelNames.findIndex((c) => c.toUpperCase() === channel.toUpperCase());
    return idx >= 0 ? idx : undefined;
  }

  /**
   * Project one param out of a (possibly cached) whole-block bulk dump, honoring
   * the channel-blocked broadcast layout (index = channel × stride + paramId).
   *
   * Channel selection:
   *  - explicit `channel` arg → read that channel's copy if the dump carries
   *    it; refuse when the index is past the dump's derived channel count
   *    (including the 1-channel case: silently returning the only copy for a
   *    channel-B request would be a wrong-channel guess);
   *  - no channel + the param is identical across all channels → return it
   *    (the common case: channel only differs for params the user varied);
   *  - no channel + the copies differ → refuse and list every channel's value,
   *    so the caller can re-ask with a channel rather than get a silent guess.
   */
  function projectParam(
    blockSlug: string,
    name: string,
    param: { paramId: number; unit: string },
    bulk: Gen3BlockBulkRead,
    channel?: string | number,
  ): ReadResult {
    const { stride, channels } = strideOf(bulk, maxCatalogPid(blockSlug));
    if (param.paramId >= stride) {
      throw new DispatchError(
        'no_ack',
        deviceLabel,
        `get_param: ${blockSlug}.${name} (paramId ${param.paramId}) is past the end of the ` +
          `${stride}-param block dump from ${deviceLabel} (head advertised ${bulk.itemCount} = ` +
          `${channels}×${stride}). The block may have paged a shorter dump than its catalog, or the ` +
          `param is not exposed by the active block type.`,
      );
    }
    const schema = catalog.blocks[blockSlug]?.params[name];
    const decode = (w: number): number | string => (schema !== undefined ? schema.decode(w) : w);
    const copyAt = (c: number): number => bulk.values[c * stride + param.paramId];

    let wire: number;
    const want = channelArgToIndex(channel);
    if (want !== undefined) {
      // Explicit channel: refuse past the derived channel count instead of
      // guessing. This includes the 1-channel case — when the dump carries a
      // single copy, a request for channel B must not silently get that copy
      // (it may be the only channel the block HAS, or a flat fallback whose
      // channel layout we could not derive; either way it is not "channel B").
      if (want >= channels) {
        throw new DispatchError(
          'bad_channel',
          deviceLabel,
          `get_param: channel index ${want} is out of range for ${blockSlug}.${name}; ` +
            (channels === 1
              ? `this block's dump carries a single channel copy (read it as channel ` +
                `"${channelNames[0]}" or omit the channel arg).`
              : `this block broadcasts ${channels} channels: ${channelNames.slice(0, channels).join('/')}.`),
        );
      }
      wire = copyAt(want);
    } else if (channels === 1) {
      wire = copyAt(0);
    } else {
      const copies = Array.from({ length: channels }, (_, c) => copyAt(c));
      if (copies.every((v) => v === copies[0])) {
        wire = copies[0]; // channel-invariant — no channel needed
      } else {
        const shown = copies
          .map((v, c) => `${channelNames[c] ?? c}=${decode(v)}`)
          .join(', ');
        throw new DispatchError(
          'bad_channel',
          deviceLabel,
          `get_param: ${blockSlug}.${name} differs across channels (${shown}). The gen-3 state ` +
            `broadcast holds one value per channel; specify which channel to read ` +
            `(e.g. channel "${channelNames[0]}").`,
          { valid_options: channelNames.slice(0, channels) as string[] },
        );
      }
    }
    // Label/decode via the catalog's ParamSchema (enum read leg from the S1
    // overlay; raw passthrough otherwise). Fall back to raw wire if absent.
    return {
      block: blockSlug,
      name,
      wire_value: wire,
      display_value: decode(wire),
      unit: param.unit,
    };
  }

  const reader: DeviceReader = {
    async getParam(
      ctx: DispatchCtx,
      blockSlugIn: string,
      name: string,
      channel?: string | number,
      instance?: number,
    ): Promise<ReadResult> {
      const { effectId } = resolveBlockOrThrow(blockSlugIn, deviceLabel, instance);
      const { param } = resolveParamOrThrow(blockSlugIn, name, deviceLabel);
      // DISCRETE type/model param: read the device's CURRENT type NAME directly.
      // The positional bulk read mis-addresses type selectors (its value is not
      // the roster ordinal), so the device's own name string is authoritative.
      const schema = catalog.blocks[blockSlugIn]?.params[name];
      if (schema?.wire_kind === 'discrete') {
        const typeName = await readCurrentTypeName(
          ctx, codec, effectId, param.paramId, Math.min(250, getResponseTimeoutMs),
        );
        if (typeName !== undefined) {
          // Best-effort reverse-resolve the wire ordinal from the partial enum
          // table for callers that want it; the NAME is the authoritative value.
          let wire = 0;
          if (schema.enum_values !== undefined) {
            const hit = Object.entries(schema.enum_values).find(([, v]) => v === typeName);
            if (hit !== undefined) wire = Number(hit[0]);
          }
          return {
            block: blockSlugIn,
            name,
            wire_value: wire,
            display_value: typeName,
            unit: param.unit,
          };
        }
        // else: device didn't answer the type-name GET — fall back to the bulk read.
      }
      const bulk = await collectBlockBulkRead(ctx, codec, effectId, deviceLabel, getResponseTimeoutMs);
      return projectParam(blockSlugIn, name, param, bulk, channel);
    },

    // Structured (non-byte-exact) whole-preset snapshot via the fn=0x1F poll
    // loop: poll every catalogued block; the ones that answer with a burst are
    // placed (unplaced blocks NACK fast, so the loop is ~1-2s, not ~30s of
    // timeouts). This is a BLOCK INVENTORY, not a positioned grid read: gen-3
    // has no decoded grid-read, so slot indices are sequential placeholders,
    // not row/col, and the snapshot is not round-trippable through
    // apply_preset by position. Community beta, server-driven poll not yet
    // hardware-confirmed end to end.
    async getPreset(ctx: DispatchCtx, options?: GetPresetOptions): Promise<PresetSnapshot> {
      const readStartedMs = Date.now();

      // STORED-PRESET WHOLE-DECODE: when a location is given, dump that stored
      // slot (fn=0x03, wire-confirmed on FM9) and decode the entire patch body
      // — routing grid, per-channel block types, scenes, amp, modifiers, scene
      // controllers — into `whole_preset`. The decode is byte-validated offline
      // against 384 III factory presets + an FM9 export; the stored-dump wire
      // path is FM9-confirmed (III/FM3 share the codec, community beta).
      if (options?.location !== undefined) {
        const loc =
          typeof options.location === 'number'
            ? options.location
            : Number.parseInt(String(options.location), 10);
        if (!Number.isInteger(loc) || loc < 0) {
          throw new DispatchError(
            'bad_location',
            deviceLabel,
            `get_preset: location must be a non-negative integer preset number, got ${JSON.stringify(options.location)}.`,
          );
        }
        let frames: number[][];
        try {
          frames = await collectStoredPresetDump(ctx, codec, loc, deviceLabel, getResponseTimeoutMs);
        } catch (err) {
          throw new DispatchError(
            'no_ack',
            deviceLabel,
            `get_preset(location=${loc}): no stored-preset dump from ${deviceLabel}. ` +
              `${err instanceof Error ? err.message : String(err)}. The gen-3 stored-preset dump ` +
              `(fn=0x03) is FM9-confirmed; III/FM3 share the codec but are community beta. Check the ` +
              `preset number is valid and an editor isn't holding the port (try reconnect_midi).`,
          );
        }
        const flat: number[] = [];
        for (const f of frames) for (const b of f) flat.push(b);
        let decoded: Gen3DecodedPreset;
        try {
          decoded = decodeGen3PresetDump(Uint8Array.from(flat), codec.modelByte);
        } catch (err) {
          throw new DispatchError(
            'no_ack',
            deviceLabel,
            `get_preset(location=${loc}): the stored-preset dump from ${deviceLabel} did not parse as a ` +
              `gen-3 preset (${err instanceof Error ? err.message : String(err)}).`,
          );
        }
        return snapshotFromDecoded(decoded, 'stored-dump', deviceLabel, readStartedMs);
      }

      // ACTIVE BUFFER. The whole-patch body (amp/scenes/modifiers) still isn't
      // decodable live (the edit-buffer dump fn=0x43 -> 0x51/0x52 is a different,
      // undecoded format than the stored 0x77/0x78/0x79 dump). But the live
      // ROUTING GRID is now readable in ONE round-trip via fn=0x01 sub=0x2E, so
      // we read it first: it gives the positioned signal chain (`live_grid`) the
      // poll inventory below never had, AND lets us poll ONLY the blocks the grid
      // says are placed instead of probing every catalog block.
      const warnings: string[] = [];
      let liveGrid: Gen3GridCellView[] | undefined;
      let placedEffectIds: Set<number> | undefined;
      let liveMeters: Gen3LiveMeters | undefined;
      let activeScene: number | undefined;
      let vp4Structure: Vp4StructureBlob | undefined;

      // VP4 (serial AM4-shape): the whole preset STRUCTURE — name, scene
      // names, current scene, and the 4-slot chain — is one eid206 pid0
      // tc=0x1f blob read (the register VP4-Edit itself polls; byte-decoded
      // from two fw 4.03 community captures). One round-trip replaces the
      // grid read (sub=0x2E is a grid-family read VP4-Edit never issues) AND
      // the fn=0x0C scene query, and scopes the per-block poll below to the
      // blocks the chain actually holds. Community beta: the blob layout is
      // capture-decoded; this server issuing the read is untested on hardware.
      // Best-effort — on no reply we fall through to the generic path.
      if (codec.modelByte === VP4_MODEL_ID) {
        try {
          vp4Structure = await collectVp4StructureBlob(ctx, deviceLabel, getResponseTimeoutMs);
          placedEffectIds = new Set(
            vp4Structure.chain.filter((s): s is NonNullable<typeof s> => s !== null).map((s) => s.effectId),
          );
          activeScene = vp4Structure.currentSceneDisplay; // PresetSnapshot.active_scene is 1-indexed
        } catch {
          warnings.push(
            'vp4 structure read (eid206 pid0 tc=0x1f) returned nothing; fell back to polling every ' +
              'catalog block. The snapshot has no preset name / scene names / chain positions.',
          );
        }
      }

      // Grid-family live read. Skipped when the VP4 structure blob already
      // answered: the VP4 is a serial chain with no grid, sub=0x2E is a
      // grid-family read VP4-Edit never issues, and the blob carries the
      // scene, so neither the grid attempt nor the fn=0x0C query would add
      // anything but a timeout.
      if (vp4Structure === undefined) {
        try {
          const gridFrame = await collectGridLayout(ctx, codec, deviceLabel, getResponseTimeoutMs);
          liveGrid = liveGridView(gridFrame, codec.modelByte);
          placedEffectIds = new Set(liveGrid.filter((c) => !c.is_shunt).map((c) => c.effect_id));
          // The SAME sub=0x2E frame carries live CPU + output meters at fixed
          // low offsets (before the grid region) — decode them for free, no extra
          // round-trip. Best-effort: a malformed frame just omits meters.
          try {
            liveMeters = parseGen3LiveMeters(gridFrame);
          } catch {
            // meters absent; not worth a warning (the grid read still succeeded).
          }
          // The grid reply proves the device is answering, so a short scene query
          // won't pay a full timeout. (Skipped entirely when the grid read failed,
          // so a dead/held port isn't probed twice.)
          activeScene = await readActiveScene(ctx, codec, getResponseTimeoutMs);
        } catch {
          // No grid reply (older firmware / port held / III-FM3 unconfirmed):
          // fall back to probing every catalog block, as before.
          warnings.push(
            'gen-3 live grid read (fn=0x01 sub=0x2E) returned nothing; fell back to polling every ' +
              'catalog block. The snapshot has no positioned routing (live_grid absent).',
          );
        }
      }

      // Short per-block cap: a real burst lands in ~1ms and an unplaced block
      // NACKs nearly as fast; this only bounds a block that neither answers.
      const POLL_TIMEOUT_MS = Math.min(250, getResponseTimeoutMs);
      const slots: PresetSnapshotSlot[] = [];
      let placedIndex = 0;
      for (const slug of Object.keys(catalog.blocks)) {
        let effectId: number;
        try {
          ({ effectId } = resolveBlockOrThrow(slug, deviceLabel));
        } catch {
          continue; // block exposes no effect id; not pollable
        }
        // When the grid is known, skip blocks it reports as unplaced — same
        // coverage as the poll (which reads each block's instance-1 effectId),
        // minus the wasted round-trips on absent blocks.
        if (placedEffectIds && !placedEffectIds.has(effectId)) continue;
        let bulk;
        try {
          bulk = await collectBlockBulkRead(ctx, codec, effectId, deviceLabel, POLL_TIMEOUT_MS);
        } catch {
          continue; // not placed (NACK) or no answer
        }
        placedIndex++;
        const blockParams = catalog.blocks[slug].params;
        const params: Record<string, number | string> = {};
        // The 0x75 broadcast is channel-blocked (index = channel × stride + paramId,
        // channel count derived per block — see strideOf); a whole-preset snapshot
        // reads the FIRST-CHANNEL copy (paramId < stride) for each param. Per-channel
        // values for a specific channel come from get_param with a channel arg;
        // channel-A is the stable, documented default here.
        const { stride } = strideOf(bulk, maxCatalogPid(slug));
        for (const key of Object.keys(blockParams)) {
          let paramId: number;
          try {
            paramId = resolveParamOrThrow(slug, key, deviceLabel).param.paramId;
          } catch {
            continue;
          }
          if (paramId < stride) {
            params[key] = blockParams[key].decode(bulk.values[paramId]);
          }
        }
        // slot: on VP4 with a decoded structure blob this is the block's REAL
        // 1-based chain position (gaps = empty slots); on grid devices it is a
        // sequential placeholder (no grid position is read on gen-3).
        const chainPos = vp4Structure?.chain.findIndex((s) => s !== null && s.effectId === effectId);
        slots.push({
          slot: chainPos !== undefined && chainPos >= 0 ? chainPos + 1 : placedIndex,
          block_type: slug,
          params,
        });
      }
      if (vp4Structure !== undefined) slots.sort((a, b) => Number(a.slot) - Number(b.slot));
      warnings.push(
        vp4Structure
          ? 'vp4 get_preset: `name`, `scenes` (with names), `active_scene`, and the `slots` slot ' +
              'numbers (REAL 1-based chain positions; gaps = empty slots) come from ONE structure-blob ' +
              'read (eid206 pid0 tc=0x1f, the register VP4-Edit itself polls, byte-decoded from two ' +
              'fw 4.03 community captures). Community beta: the blob layout is capture-decoded but this ' +
              "server's own read is untested on hardware — confirm against the front panel. Narrate the " +
              'chain as a linear signal path (Input → slot 1 → … → slot 4 → Output). Per-block param ' +
              'VALUES still come from the fn=0x1F bulk poll, which VP4-Edit never uses (that read-path ' +
              'audit item stands); treat values as unconfirmed; enum params read as ordinal labels, ' +
              'uncalibrated continuous as raw wire.'
          : liveGrid
          ? 'gen-3 get_preset: `live_grid` holds the positioned routing (row/col + block per cell) ' +
              'from the live fn=0x01 sub=0x2E read; `slots` carries the per-block param VALUES (a flat ' +
              'inventory; its `slot` numbers are sequential, not grid positions; match a slot to its ' +
              'cell via block_type/effect name in live_grid). Cable directions are surfaced raw in ' +
              'live_grid[].route_flag (edge decode is community-beta, not asserted). Per-channel params ' +
              'are the channel-A copy (use get_param with a channel arg); enum params read as ordinal ' +
              'labels, uncalibrated continuous as raw wire. When describing this to the user, narrate ' +
              'live_grid as a linear signal path (Input → block → block → Output), not a row/column ' +
              'grid or coordinates; it reads cleanly aloud and is clearer for everyone. Community beta: ' +
              'server-issued reads are not yet hardware-confirmed end to end.'
          : 'gen-3 get_preset is a block inventory, not a positioned grid read: slot indices are ' +
              'sequential placeholders (no grid read), so the snapshot is not round-trippable ' +
              'through apply_preset by position. Per-channel params are reported as their channel-A ' +
              'copy (use get_param with a channel arg for a specific channel). Enum params read back ' +
              'as ordinal labels; uncalibrated continuous params read back as raw wire values. ' +
              'Community beta: the server-driven fn=0x1F poll is not yet hardware-confirmed end to end.',
      );
      if (liveMeters !== undefined) {
        warnings.push(
          `gen-3 live_meters: cpu_percent (${liveMeters.cpu_percent}%) is the active preset's steady ` +
            'DSP cost (the headroom answer); output_left/right are momentary peaks at read time. ' +
            'Decoded from the same sub=0x2E frame as live_grid (no extra round-trip). Evidence: the ' +
            'output meters are FM9-behaviorally-confirmed (they vary across reads); cpu_percent is ' +
            'FM3(ForgeFX)-sourced and FM9-consistent. Community beta. The device input meter is not ' +
            'surfaced (its offset is not portable across the gen-3 family).',
        );
      }
      // VP4: scene names from the structure blob (channel/bypass per scene are
      // not in the blob — left empty, not asserted).
      const vp4Scenes: SceneSpec[] | undefined = vp4Structure?.sceneNames.map((n, i) => ({
        scene: i + 1,
        channels: {},
        bypassed: {},
        name: n,
      }));
      return {
        name: vp4Structure?.presetName,
        slots,
        ...(vp4Scenes ? { scenes: vp4Scenes } : {}),
        ...(liveGrid ? { live_grid: liveGrid } : {}),
        ...(liveMeters ? { live_meters: liveMeters } : {}),
        ...(activeScene !== undefined ? { active_scene: activeScene } : {}),
        read_warnings: warnings,
        _meta: {
          device: deviceLabel,
          read_at_ms: readStartedMs,
          active_scene_only: true,
          // The VP4 structure blob carries the serial chain = the routing.
          routing_omitted: liveGrid === undefined && vp4Structure === undefined,
          channel_state_omitted: true,
          read_duration_ms: Date.now() - readStartedMs,
        },
      };
    },

    // Byte-exact backup of the ACTIVE working buffer via the gen-3 edit-buffer
    // dump (fn=0x43 → 0x51 head + 0x52 body run, no tail). Backs export_preset.
    // The frames are concatenated verbatim into a .syx the user can keep; the
    // inner layout is treated as opaque (a blob round-trips regardless). The
    // request is FM9-confirmed (no args); III/FM3/VP4 share the gen-3 codec but
    // are not yet hardware-confirmed for this path, so a device that does not
    // answer times out with a beta-flavored no_ack rather than a partial dump.
    async dumpActivePresetBinary(ctx: DispatchCtx): Promise<PresetBinaryDump> {
      // Subscribe before sending so the burst can't outrace the listener.
      const framesPromise = collectEditBufferDump(ctx, codec, getResponseTimeoutMs);
      ctx.conn.send(codec.buildRequestEditBufferDump());
      let frames: number[][];
      try {
        frames = await framesPromise;
      } catch (err) {
        throw new DispatchError(
          'no_ack',
          deviceLabel,
          `export_preset: no edit-buffer dump from ${deviceLabel}. ${err instanceof Error ? err.message : String(err)}. ` +
            `The gen-3 edit-buffer dump (fn=0x43) is FM9-confirmed; III/FM3/VP4 share the gen-3 codec but are not yet ` +
            `hardware-confirmed for this path. Check the device is connected and an editor isn't holding the port ` +
            `(try reconnect_midi).`,
        );
      }
      // Flatten the frames into the verbatim .syx byte stream (opaque blob).
      const flat: number[] = [];
      for (const f of frames) for (const b of f) flat.push(b);
      const bytes = Uint8Array.from(flat);
      return {
        bytes,
        byte_length: bytes.length,
        frame_count: frames.length,
        format: 'fractal-gen3-edit-buffer-dump',
        source: 'active working buffer (gen-3 edit-buffer dump, fn=0x43)',
      };
    },

    // Byte-exact backup of a STORED preset via the gen-3 stored-preset dump
    // (fn=0x03 request -> 0x77 head + 0x78 body run + 0x79 tail). Wire-confirmed
    // on FM9 fw 11.00 (capture 2026-06-04): host sends REQUEST_PRESET_DUMP and
    // the device replies with the same 0x77/0x78/0x79 chain used for file export.
    // The frames are concatenated verbatim; the inner layout is treated as opaque.
    async dumpStoredPresetBinary(location: number, ctx: DispatchCtx): Promise<PresetBinaryDump> {
      let frames: number[][];
      try {
        frames = await collectStoredPresetDump(ctx, codec, location, deviceLabel, getResponseTimeoutMs);
      } catch (err) {
        throw new DispatchError(
          'no_ack',
          deviceLabel,
          `export_preset: no stored-preset dump from ${deviceLabel} for preset ${location}. ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `The gen-3 stored-preset dump (fn=0x03) is FM9-confirmed; III/FM3/VP4 share the gen-3 codec ` +
            `but are not yet hardware-confirmed for this path. Check the preset number is valid and ` +
            `the device is connected (try reconnect_midi).`,
        );
      }
      // Flatten the frames into the verbatim .syx byte stream (opaque blob).
      const flat: number[] = [];
      for (const f of frames) for (const b of f) flat.push(b);
      const bytes = Uint8Array.from(flat);
      // Try to extract the preset name from the dump for the filename.
      let name: string | undefined;
      try {
        const parsed = parsePresetDump(bytes, 0, codec.modelByte);
        const extracted = extractPresetName(parsed);
        if (extracted.length > 0) name = extracted;
      } catch {
        // Name extraction is best-effort; a corrupt header is not a fatal error.
      }
      return {
        bytes,
        byte_length: bytes.length,
        frame_count: frames.length,
        format: 'fractal-gen3-stored-preset-dump',
        source: `stored preset location ${location}`,
        name,
      };
    },

    // Non-destructive overwrite pre-check for save_preset: read the target
    // location's stored name (fn=0x0F QUERY PATCH NAME by number, spec-
    // documented) plus the active preset number, so the dispatcher's
    // confirmable overwrite gate runs on gen-3 like it does on AM4: the
    // agent sees what a save would clobber BEFORE the destructive store.
    // Best-effort: any read failure returns undefined and the dispatcher
    // degrades (proceeds, flags the unverified overwrite) rather than
    // blocking the save. VP4's letter locations (A01..Z04) skip the check:
    // its store op saves in place, so a named-location occupancy check would
    // be checking the wrong thing.
    async checkOverwriteTarget(
      ctx: DispatchCtx,
      location: LocationRef,
    ): Promise<OverwriteTargetInfo | undefined> {
      const n = typeof location === 'number' ? location : Number(location);
      if (!Number.isInteger(n) || n < 0) return undefined;
      const queryName = async (preset: number | 'current') => {
        const respPromise = ctx.conn.receiveSysExMatching(
          (b) => codec.isQueryPatchNameResponse(b),
          getResponseTimeoutMs,
        );
        ctx.conn.send(codec.buildQueryPatchName(preset));
        return codec.parseQueryPatchNameResponse(await respPromise);
      };
      try {
        const target = await queryName(n);
        const occupant = target.name.trim();
        let isActive = false;
        try {
          const active = await queryName('current');
          isActive = active.presetNumber === n;
        } catch {
          // Active-number read failed: keep isActive=false. The gate may then
          // ask one unnecessary confirm when saving the active location —
          // safer than skipping the gate on a destructive flash write.
        }
        return {
          target_display: `preset ${n}`,
          occupant_name: occupant.length > 0 ? occupant : undefined,
          is_active_location: isActive,
        };
      } catch {
        return undefined; // dispatcher degrades: proceed + flag unverified overwrite
      }
    },

    async getParams(
      ctx: DispatchCtx,
      queries: readonly ParamQuery[],
    ): Promise<BatchReadResult> {
      const reads: ReadResult[] = [];
      const failed: number[] = [];
      const errors: Record<number, string> = {};
      // One bulk read per distinct block: a batch over several params of the
      // same block polls the device once, not once per param. Failures are
      // cached too, so a batch over several DISTINCT dead blocks does not pay a
      // full timeout per query (only once per distinct effectId).
      const cache = new Map<number, { bulk?: Gen3BlockBulkRead; err?: string }>();
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        try {
          const { effectId } = resolveBlockOrThrow(q.block, deviceLabel, q.instance);
          const { param } = resolveParamOrThrow(q.block, q.name, deviceLabel);
          let entry = cache.get(effectId);
          if (entry === undefined) {
            try {
              entry = { bulk: await collectBlockBulkRead(ctx, codec, effectId, deviceLabel, getResponseTimeoutMs) };
            } catch (pollErr) {
              entry = { err: pollErr instanceof Error ? pollErr.message : String(pollErr) };
            }
            cache.set(effectId, entry);
          }
          if (entry.err !== undefined) throw new DispatchError('no_ack', deviceLabel, entry.err);
          reads.push(projectParam(q.block, q.name, param, entry.bulk!, q.channel));
        } catch (err) {
          failed.push(i);
          errors[i] = err instanceof Error ? err.message : String(err);
        }
      }
      return {
        reads,
        failed_indices: failed,
        errors: failed.length > 0 ? errors : undefined,
      };
    },
  };
  return reader;
}
