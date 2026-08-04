/**
 * Channel awareness + applicability advisory state shared by every tool
 * that writes to or reads a channel-bearing block (amp / drive / reverb /
 * delay).
 *
 * Channels (A/B/C/D) are the data container for block param values; scenes
 * are selectors that choose which channel each block uses. Two scenes
 * pointing at the same channel will both reflect any write to that channel,
 * confirmed on hardware HW-009 (2026-04-19). See SYSEX-MAP.md §6a and
 * docs/_private/HARDWARE-TASKS.md HW-009 for the full explanation.
 *
 * The cache below holds whatever channel the server LAST EXPLICITLY SET
 * for each channel-bearing block. It is not authoritative — a hardware
 * footswitch, hardware knob, or AM4-Edit interaction can move the block
 * to a different channel without our knowledge. The cache is invalidated
 * on `am4_switch_preset` / `am4_switch_scene` / `reconnect_midi` to avoid
 * reporting stale data across those boundaries.
 */

import { type ParamKey } from 'fractal-midi/am4';
import {
    checkApplicability,
    describeApplicability,
} from 'fractal-midi/am4';
import {
    buildSetParam,
    isWriteEcho,
} from 'fractal-midi/am4';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';

import { WRITE_ECHO_TIMEOUT_MS, recordAckOutcome } from '@mcp-midi-control/core/server-shared/connections.js';

export const CHANNEL_BLOCKS = new Set(['amp', 'drive', 'reverb', 'delay']);

export const lastKnownChannel: Partial<Record<string, number>> = {};

/**
 * Per-block last-known type-enum value. Populated by:
 *  - `am4_set_param` writes to `<block>.type` (or volpan.mode) — recorded
 *    after wire ack via `observeWrittenParam`.
 *  - `am4_apply_preset` block-type writes — same path.
 *  - `am4_get_param` reads of `<block>.type` — recorded when the read
 *    response decodes successfully.
 *
 * Used by `preflightApplicabilityWarning` to surface a non-blocking
 * advisory when the agent calls `am4_set_param` on a type-gated knob whose
 * gate doesn't include the current type. The firmware always accepts
 * the wire write; the warning lets the agent decide whether to switch
 * type first or pick a different param.
 *
 * Unset entries mean "we don't yet know this block's type" — the
 * preflight skips the warning rather than guessing wrong.
 */
export const lastKnownType: Record<string, number> = {};

export function invalidateChannelCache(): void {
    for (const key of Object.keys(lastKnownChannel)) delete lastKnownChannel[key];
}

export function channelLetter(index: number): 'A' | 'B' | 'C' | 'D' {
    return (['A', 'B', 'C', 'D'] as const)[index];
}

/**
 * Parse a user-supplied channel argument ("A"/"B"/"C"/"D" or 0..3) into
 * the 0..3 internal index. Case-insensitive on letters.
 */
export function resolveChannel(input: string | number): number {
    if (typeof input === 'number') {
        if (!Number.isInteger(input) || input < 0 || input > 3) {
            throw new Error(`channel must be 0..3 or A/B/C/D, got ${input}`);
        }
        return input;
    }
    const letter = input.trim().toUpperCase();
    const idx = ['A', 'B', 'C', 'D'].indexOf(letter);
    if (idx < 0) throw new Error(`channel must be A/B/C/D (or 0..3), got "${input}"`);
    return idx;
}

/**
 * Render the channel-context status line appended to every param-write
 * response. Returns empty string for blocks that don't have channels
 * (chorus, flanger, phaser, etc. — the secondary effect blocks).
 *
 * `justSwitched` is true when the caller explicitly used the `channel`
 * param on this call and the switch acked; the message is more assertive
 * in that case because we know the write went to a known channel.
 */
export function channelStatusLine(block: string, justSwitched: boolean): string {
    if (!CHANNEL_BLOCKS.has(block)) return '';
    const idx = lastKnownChannel[block];
    if (idx === undefined) {
        return (
            ` (Wrote to whatever channel ${block} is on — server hasn't tracked a ` +
            `channel switch this session. Pass \`channel\` to target a specific ` +
            `A/B/C/D, or note that channels are shared across scenes that point ` +
            `at the same one.)`
        );
    }
    if (justSwitched) {
        return ` (Wrote to channel ${channelLetter(idx)}.)`;
    }
    return (
        ` (Wrote to channel ${channelLetter(idx)} — last channel the server ` +
        `explicitly switched this block to. If the user has moved it via ` +
        `footswitch / hardware / AM4-Edit, the real channel may differ.)`
    );
}

/**
 * Issue a channel-switch write and wait for the echo. Updates
 * `lastKnownChannel[block]` on success. Used by set_param / set_params /
 * apply_preset when the caller passes an explicit `channel`.
 *
 * Throws on validation errors (unknown block without a channel register,
 * out-of-range index). Returns `{ switched: boolean }` — switched=false
 * means the cache already showed the requested channel, so no wire write
 * was issued.
 */
export async function switchBlockChannel(
    conn: MidiConnection,
    block: string,
    channel: string | number,
): Promise<{ switched: boolean }> {
    if (!CHANNEL_BLOCKS.has(block)) {
        throw new Error(
            `Block "${block}" doesn't expose a channel register (only amp / drive / reverb / delay have channels on AM4). Drop the \`channel\` argument.`,
        );
    }
    const targetIndex = resolveChannel(channel);
    if (lastKnownChannel[block] === targetIndex) {
        return { switched: false };
    }
    const key = `${block}.channel` as ParamKey;
    const bytes = buildSetParam(key, targetIndex);
    const echoPromise = conn.receiveSysExMatching(
        (resp) => isWriteEcho(bytes, resp),
        WRITE_ECHO_TIMEOUT_MS,
    );
    conn.send(bytes);
    try {
        await echoPromise;
        recordAckOutcome(true);
        lastKnownChannel[block] = targetIndex;
        return { switched: true };
    } catch {
        recordAckOutcome(false);
        throw new Error(
            `Channel switch to ${channelLetter(targetIndex)} for ${block} ` +
            `didn't ack within ${WRITE_ECHO_TIMEOUT_MS} ms. The subsequent ` +
            `param write was NOT attempted to avoid writing to the wrong channel. ` +
            `Check USB/driver status or call reconnect_midi.`,
        );
    }
}

/**
 * Observer called after every successful `am4_set_param` write. If the write
 * targeted a `<block>.channel` param, update the cache so the server knows
 * which channel that block is now on. Also caches `<block>.type` writes
 * so the applicability preflight knows the active type without an extra
 * wire read on every set_param call.
 */
export function observeWrittenParam(block: string, paramName: string, numericValue: number): void {
    if (paramName === 'channel' && CHANNEL_BLOCKS.has(block)) {
        const idx = Math.round(numericValue);
        if (idx >= 0 && idx <= 3) lastKnownChannel[block] = idx;
    }
    if (paramName === 'type' || paramName === 'mode') {
        // 'type' is the canonical name for block-type enums; volpan uses
        // 'mode' for historical reasons. Both gate per-type knob visibility.
        lastKnownType[block] = Math.round(numericValue);
    }
}

/**
 * Observer called after every successful `am4_get_param` read. Keeps
 * `lastKnownType` fresh when the agent reads `<block>.type` — populates
 * the cache without requiring a write to have happened first.
 */
export function observeReadParam(block: string, paramName: string, numericValue: number): void {
    if (paramName === 'type' || paramName === 'mode') {
        lastKnownType[block] = Math.round(numericValue);
    }
}

/**
 * Returns a one-line warning when the agent is about to write a
 * type-gated knob whose gate doesn't include the active type. The
 * write proceeds regardless (firmware accepts it on any type), so this
 * is advisory: nudges the agent to either switch type first or pick a
 * different knob. Returns undefined when the param is universal, when
 * the cached type matches a gate, or when the cache is empty for this
 * block (no false alarms).
 */
export function preflightApplicabilityWarning(blockDotName: string): string | undefined {
    const result = checkApplicability(blockDotName, { currentTypes: lastKnownType });
    if (result.applicable === true) return undefined;
    if (result.applicable === 'unknown') return undefined;
    // Strictly gated AND we know the active type AND it doesn't match.
    const block = blockDotName.split('.')[0];
    const activeIndex = lastKnownType[block];
    // `detail: 'full'` deliberately. The SUMMARY rendering exists to bound a
    // long roster inside a per-row survey of a whole block; this message is
    // about ONE param and has no size pressure, and its closing instruction is
    // literally "set <block>.type to one of the applicable values". Rendered
    // as a summary it ends with "call find_compatible_types for the exact
    // list" and then tells the reader to pick from a list it did not print:
    // on 25 AM4 params, including amp.master / bass / mid / treble, the
    // warning named zero applicable types.
    const expected = describeApplicability(blockDotName, { detail: 'full' });
    return (
        `WARNING: ${blockDotName} is type-gated and the active ${block}.type ` +
        `(wire index ${activeIndex}) is not in the applicable set. ${expected ?? ''} ` +
        `The firmware accepts the write on any type but it may not be audible on ` +
        `the current type. To make it audible, set ${block}.type to one of the ` +
        `applicable values first, then retry this write.`
    );
}

