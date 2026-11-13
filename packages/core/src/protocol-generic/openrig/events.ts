/**
 * Rig-store change events: the in-process channel that tells a second client
 * (the HTTP host's SSE stream) that the manifest changed under it.
 *
 * DESIGN (RIG-CONSOLE-DESIGN.md "Change propagation"): the browser and the
 * agent share ONE process, so an agent-side `edit_rig` and a future app-side
 * write both land in `writeRigManifest` / `createRigManifest`, which emit
 * here. The event carries the kind and source that changed, NOT the data:
 * subscribers refetch through the same loader everything else reads, so there
 * is one read path rather than two.
 *
 * Deliberately not Node's EventEmitter: three functions and a Set keep the
 * subscriber list typed, synchronous, and impossible to leak listeners onto a
 * shared global emitter. A throwing subscriber is isolated (caught, reported
 * to stderr) so a broken SSE socket can never fail a manifest write that
 * already succeeded.
 */

export interface RigStoreWrite {
  /** What was written. `manifest` is the only kind today; L2/L3 stores will add theirs. */
  kind: 'manifest';
  /** The file path written. */
  source: string;
  /** Whether this was a first-time create or an edit of an existing file. */
  created: boolean;
}

type Subscriber = (event: RigStoreWrite) => void;

const subscribers = new Set<Subscriber>();

/** Subscribe to store writes. Returns the unsubscribe function. */
export function onRigStoreWrite(cb: Subscriber): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

/** Emit a store write to every subscriber. Never throws. */
export function emitRigStoreWrite(event: RigStoreWrite): void {
  for (const cb of subscribers) {
    try {
      cb(event);
    } catch (err) {
      console.error(`rig-store subscriber failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
