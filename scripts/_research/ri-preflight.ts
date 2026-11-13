// Diagnostic: run an apply_preset spec (JSON file arg) through the server's own preflight, no device.
import { readFileSync } from 'node:fs';
import { collectApplyPresetPreflight } from '@mcp-midi-control/core/protocol-generic/dispatcher/preflight.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const r = collectApplyPresetPreflight(input.spec, AM4_DESCRIPTOR);
console.log('ERRORS', JSON.stringify(r.errors, null, 1));
console.log('INFO', JSON.stringify(r.info, null, 1));
console.log('NORMALIZED', JSON.stringify(r.normalized_spec.slots.map((s) => s.params)));
