/**
 * Hydrasynth byte-exact preset restore: backs the unified `import_preset`
 * tool via `DeviceWriter.restorePresetBinary`.
 *
 * Pushes a 22-frame `.syx` backup (written by `export_preset` /
 * `backup_device`) back to a STORED slot over the WRITING-A-SERIES-OF-PATCHES
 * flow in `patchWrite.ts`, the flow hardware-confirmed end-to-end by the
 * 2026-08-10 full-device reorg (1024 patches flashed, per-bank 15 00
 * receipts, 1024/1024 name verifies incl. post-power-cycle).
 *
 * Restore shape on this device (deliberate, all three gates required):
 *
 *   - `target_location` REQUIRED. There is no working-buffer restore: the
 *     working buffer has no byte-level write of its own, and a RAM-level
 *     dump is NOT reversible (SysexEncoding NOTE 0: it lives in the bank's
 *     RAM copy until power-off, and a later flash save of ANY patch in that
 *     bank would persist it). Refusing is honest; "reversible audition"
 *     would be false.
 *   - `save_authorized` REQUIRED: a restore here is always a flash write.
 *   - `confirm_overwrite` REQUIRED: every Hydrasynth slot is occupied, so
 *     a restore always overwrites. The occupant's stored name is pre-read
 *     and surfaced in the refusal (same BK-110/BK-112 gate as
 *     apply_patch save:true).
 *
 * Verification is receipt-true (BK-112): `ok` requires the 15 00 flash
 * receipt or a post-write name read-back matching the pushed buffer, never
 * an intent echo. A missing receipt + failed read-back names Protect ON.
 */
import type {
  DispatchCtx,
  LocationRef,
  RestorePresetResult,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';

import { framesToPatchBuffer, writeStoredPatches, type SeriesWriteOptions } from '../patchWrite.js';
import { readBankNames } from '../patchRead.js';
import { readPatchName, PATCH_CHUNK_COUNT } from '../patchEncoder.js';
import { parseHydrasynthLocation } from './schema.js';

const DEVICE_LABEL = 'ASM Hydrasynth Explorer';

/** Format the source slot embedded in a read buffer's chunk-0 header. */
function sourceSlotOf(buffer: Uint8Array): string {
  const bank = buffer[2]!;
  const patch = buffer[3]!;
  if (bank > 7 || patch > 127) return 'unknown';
  return `${String.fromCharCode(65 + bank)}${(patch + 1).toString().padStart(3, '0')}`;
}

export async function restorePresetBinaryHydrasynth(
  ctx: DispatchCtx,
  bytes: Uint8Array,
  options?: { target_location?: LocationRef; save_authorized?: boolean; confirm_overwrite?: boolean },
  // Beyond the DeviceWriter contract; the dispatcher never passes it. Offline
  // goldens use it to shrink the spec-mandated 3500 ms flash settle (see
  // SeriesWriteOptions.flashSettleMs; never override on hardware).
  seriesOptions?: SeriesWriteOptions,
): Promise<RestorePresetResult> {
  // Parse + validate the backup FIRST (envelope, CRC, chunk order, 2790-byte
  // total): a wrong-model .syx (AM4, Axe-Fx) fails the ASM envelope check
  // here, before any gate prose or wire byte.
  let buffer: Uint8Array;
  try {
    buffer = framesToPatchBuffer(bytes);
  } catch (err) {
    throw new DispatchError(
      'value_out_of_range',
      DEVICE_LABEL,
      `import_preset: the file is not a Hydrasynth patch backup (${err instanceof Error ? err.message : String(err)}). ` +
        `Pass the ${PATCH_CHUNK_COUNT}-frame .syx that export_preset wrote for THIS device; another model's dump cannot restore here.`,
    );
  }
  const name = readPatchName(buffer);
  const source = sourceSlotOf(buffer);

  if (options?.target_location === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      DEVICE_LABEL,
      `import_preset on ${DEVICE_LABEL} restores to a STORED slot only; there is no reversible working-buffer restore ` +
        `(the working buffer has no byte-level write, and a RAM-level dump persists as a side effect of any later flash save ` +
        `in its bank). This backup holds "${name}" (dumped from ${source}; slot numbering may predate a reorg). ` +
        `Confirm the target slot with the user, then re-call with target_location plus save_authorized and confirm_overwrite.`,
    );
  }
  const target = parseHydrasynthLocation(options.target_location);

  if (options.save_authorized !== true) {
    throw new DispatchError(
      'save_authorization_required',
      DEVICE_LABEL,
      `import_preset to ${target.display} is a FLASH write (a restore on this device always persists). ` +
        `Requires explicit save intent from the user ("restore it to ${target.display}", "put it back", "overwrite ${target.display}"); ` +
        `then re-call with save_authorized: true.`,
    );
  }

  // Read-before-write occupancy gate (BK-110/BK-112, same as apply_patch
  // save:true): every slot is occupied, so pre-read the occupant's stored
  // name and require confirm_overwrite. A failed read still refuses:
  // degraded but loud, never a silent unverified overwrite.
  let occupantName: string | undefined;
  let occupantReadError: string | undefined;
  try {
    occupantName = (await readBankNames(ctx.conn, target.bank))[target.patch];
  } catch (err) {
    occupantReadError = err instanceof Error ? err.message : String(err);
  }
  if (options.confirm_overwrite !== true) {
    const occupantLine = occupantName !== undefined
      ? `${target.display} currently stores "${occupantName}".`
      : `${target.display}'s stored name could not be read (${occupantReadError ?? 'unknown error'}), so what is there is UNKNOWN.`;
    throw new DispatchError(
      'overwrite_confirmation_required',
      DEVICE_LABEL,
      `REFUSING TO OVERWRITE: ${occupantLine} Restoring "${name}" there replaces it permanently. ` +
        `Tell the user what the slot holds and, once they confirm, re-call with confirm_overwrite: true ` +
        `(keep save_authorized: true). The write takes ~5 s (spec-mandated flash settle).`,
    );
  }

  // The hardware-confirmed series flow, single-entry batch: header, 22
  // ack-driven chunks, ONE 14 00 commit, 15 00 receipt, 3.5 s settle, footer.
  const series = await writeStoredPatches(ctx.conn, [
    { bank: target.bank, patch: target.patch, buffer },
  ], seriesOptions);

  // Receipt-true verification: the 15 00 receipt is the device's flash
  // acknowledgment; the name read-back is the independent decider when the
  // receipt is missing (Protect ON silently no-ops the commit).
  let readbackName: string | undefined;
  let readbackError: string | undefined;
  try {
    readbackName = (await readBankNames(ctx.conn, target.bank))[target.patch];
  } catch (err) {
    readbackError = err instanceof Error ? err.message : String(err);
  }
  const readbackMatches = readbackName !== undefined && readbackName === name;
  const persisted = series.flash_receipt || readbackMatches;
  // Read-back is ground truth over the receipt: a mismatch fails the restore
  // even when the receipt arrived; a receipt with an unreadable read-back
  // passes on the receipt alone (best-effort verification).
  const ok = readbackMatches || (series.flash_receipt && readbackName === undefined);

  let warning: string | undefined;
  if (!series.flash_receipt) {
    warning = readbackMatches
      ? `The 15 00 flash receipt never arrived, but the post-write read-back shows ${target.display} now stores "${name}". The restore persisted.`
      : `NOT CONFIRMED: no 15 00 flash receipt, and the post-write read-back ${
          readbackName !== undefined
            ? `shows ${target.display} still stores "${readbackName}"`
            : `failed (${readbackError ?? 'unknown error'})`
        }. If System Menu -> Protect is ON the write silently no-ops; check the device and retry with Protect OFF.`;
  } else if (readbackName !== undefined && !readbackMatches) {
    // Receipt arrived but the slot reads back differently; surface it
    // rather than letting the receipt win silently.
    warning = `The 15 00 flash receipt arrived, but ${target.display} reads back "${readbackName}" instead of "${name}". Verify on the device.`;
  }

  return {
    ok,
    // The 22 patch chunk frames are the payload; header/commit/footer are
    // transaction framing. Every chunk was individually acked (the flow
    // throws on the first missing ack), so acks == frames on success.
    frames_sent: PATCH_CHUNK_COUNT,
    acks_received: series.patches_acked * PATCH_CHUNK_COUNT,
    nacks: [],
    name,
    ...(persisted ? { saved_to_location: target.display } : {}),
    format: 'hydrasynth-patch-dump',
    ...(warning !== undefined ? { warning } : {}),
  };
}
