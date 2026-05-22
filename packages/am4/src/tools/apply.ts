/**
 * AM4 apply tools removed v0.3, use the unified surface:
 *
 *   apply_preset({ port:'am4', spec, target_location?, save_authorized?,
 *                  on_active_preset_edited? })
 *   apply_setlist({ port:'am4', entries, on_error?, dry_run?, verify?,
 *                   on_active_preset_edited? })
 *
 * Both unified tools route through descriptor.writer.applyPreset /
 * descriptor.writer.applySetlist which wrap the same `prepareApplyPreset
 * Writes` / `runApplyPresetAt` executor used by the legacy
 * am4_apply_preset / am4_apply_preset_at / am4_apply_setlist tools.
 * Validation messages (channel letter rejection, "doesn't have channels",
 * scene-index dedup, etc.) are identical because they're emitted by the
 * shared executor below the dispatcher.
 *
 * The behavioral guidance the long descriptions carried (control-surface
 * discipline, compressor type groups, scene-structure-for-songs rules,
 * naming conventions, fresh-build clearing semantics, save-intent rule)
 * migrated into describe_device.agent_guidance in chunk 1.
 *
 * applyExecutor.ts is retained, it's the shared executor for the unified
 * surface.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function registerApplyTools(_server: McpServer): void {
    // intentionally empty, am4_apply_preset, am4_apply_preset_at,
    // am4_apply_setlist removed v0.3 (use unified apply_preset / apply_setlist).
}
