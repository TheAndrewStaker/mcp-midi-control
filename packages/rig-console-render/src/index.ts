/**
 * @mcp-midi-control/rig-console-render: the Rig Console's pure renderer.
 *
 * Extracted from `scripts/_lib/console-{diagram,render}.ts` so every consumer
 * (the CLI generator, the MCP App shell, the HTTP host) renders the SAME page
 * from the SAME model without a `packages/<pkg>/src` relative import, which works
 * under tsx and nowhere else. Pure by charter: no file I/O, no MIDI, no
 * listener. The disk loaders that populate the model stay beside the
 * gitignored maintainer data they read (`scripts/_lib/console-sources.ts`).
 */
export * from './types.js';
export * from './join.js';
export * from './diagram.js';
export * from './page.js';
export * from './theme.js';
export * from './map.js';
