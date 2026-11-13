/**
 * Print the four OpenRig checks for a manifest on disk.
 *   npx tsx scripts/_research/check-rig-manifest.ts <rig.json>
 */
import { readFileSync } from 'node:fs';
import { buildRigView, renderRigText, type Rig } from '../../packages/openrig/src/index.js';

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: check-rig-manifest.ts <rig.json>');
  process.exit(2);
}
const rig = JSON.parse(readFileSync(path, 'utf8')) as Rig;
console.log(renderRigText(buildRigView(rig)));
