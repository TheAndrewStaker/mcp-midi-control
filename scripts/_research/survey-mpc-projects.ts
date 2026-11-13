/**
 * Read-only survey: for each song spec, find its project under a Projects
 * folder and report how its sections line up with the project's sequences.
 *   npx tsx scripts/_research/survey-mpc-projects.ts <specs dir> <projects dir>
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseXpj, summarizeXpj, sequenceTitle } from '../../packages/akai-mpc/src/codec/project.js';

const [specsDir, projectsDir] = process.argv.slice(2);
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const folders = readdirSync(projectsDir);
for (const file of readdirSync(specsDir).filter((f) => f.endsWith('.json')).sort()) {
  const spec = JSON.parse(readFileSync(join(specsDir, file), 'utf8')) as { title: string; sections: Array<{ name: string }> };
  const folder = folders.find((d) => norm(d).startsWith(norm(spec.title)));
  if (folder === undefined) { console.log(`${basename(file)}: NO PROJECT FOLDER`); continue; }
  const xpj = readdirSync(join(projectsDir, folder)).find((f) => f.endsWith('.xpj'));
  if (xpj === undefined || !existsSync(join(projectsDir, folder, xpj))) { console.log(`${basename(file)}: no .xpj in ${folder}`); continue; }
  const sum = summarizeXpj(parseXpj(readFileSync(join(projectsDir, folder, xpj))));
  const byTitle = new Map(sum.sequences.map((s) => [norm(sequenceTitle(s.name)), s]));
  const missing = spec.sections.filter((s) => !byTitle.has(norm(s.name))).map((s) => s.name);
  const bpms = [...new Set(sum.sequences.map((s) => s.bpm))];
  console.log(`${basename(file)}: ${xpj} v${sum.appVersion} ${sum.sequences.length} seq / ${spec.sections.length} sections, bpm ${bpms.join('/')}, songs ${sum.songs.map((s) => s.items.length).join(',')}${missing.length ? `, UNMATCHED: ${missing.join(' | ')}` : ''}`);
}
