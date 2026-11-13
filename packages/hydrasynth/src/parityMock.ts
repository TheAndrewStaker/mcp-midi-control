/**
 * Hydrasynth parity-gate mock connection.
 *
 * Speaks the STORED-PATCH Request flow (SysexEncoding.txt "REQUESTING A
 * SINGLE PATCH") over the core in-memory `mockConnect`, so
 * `verify-response-shape-parity.ts` can drive the REAL reader
 * (`reader.getPreset({location})` → `patchRead.readStoredPatch`)
 * end-to-end offline: header handshake, 22 ack-driven chunk dumps built
 * from the factory INIT buffer, footer handshake.
 *
 * Mirrors `packages/fractal-gen3/src/parityMock.ts` in role: a
 * shape-parity harness, not a behavioral simulator. The served patch is
 * INIT + a stamped name ("Parity Mock") and category (Pad) so the
 * snapshot's name/category fields are exercised with known values.
 */

import { mockConnect, type MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { wrapSysex, unwrapSysex } from './sysexEnvelope.js';
import { encodePatch, splitIntoChunks, categoryNameToIndex } from './patchEncoder.js';
import { INIT_PATCH_BUFFER } from './initPatchBuffer.js';

export function connectHydrasynthParityMock(): MidiConnection {
  let chunks: { info: Uint8Array }[] = [];
  let sent = 0;

  const responder = (outgoing: number[]): number[][] => {
    let info: Uint8Array;
    try {
      info = unwrapSysex(outgoing);
    } catch {
      return [];
    }
    if (info[0] === 0x18) return [wrapSysex([0x19, 0x00])];
    if (info[0] === 0x1a) return [wrapSysex([0x1b, 0x00])];
    if (info[0] === 0x04 && info.length === 4) {
      const buf = encodePatch(new Map(), {
        base: INIT_PATCH_BUFFER,
        name: 'Parity Mock',
        category: categoryNameToIndex('Pad'),
      });
      buf[2] = info[2]!;
      buf[3] = info[3]!;
      chunks = splitIntoChunks(buf);
      sent = 0;
      return [wrapSysex(chunks[sent++]!.info)];
    }
    if (info[0] === 0x17 && info.length === 4) {
      // Chunk ack. The real device correlates on the echoed TYPE byte;
      // a wrong echo gets no next chunk, which times the reader out —
      // exactly the loud failure the parity gate should see.
      if (info[3] !== 0x16) return [];
      if (sent < chunks.length) return [wrapSysex(chunks[sent++]!.info)];
      return [];
    }
    return [];
  };

  return mockConnect({ responder, ackLatencyMs: 2 });
}
