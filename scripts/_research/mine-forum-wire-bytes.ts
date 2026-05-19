/**
 * Scan all scraped forum corpora for wire-byte mentions, grouped by
 * Fractal model byte. Surfaces real-world wire captures we can use
 * to verify our SysEx builders without owning the hardware.
 *
 * Inputs: any forum-*.json file under docs/_private/.
 *
 * Run: npx tsx scripts/_research/mine-forum-wire-bytes.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? __dirname, '../..');
const PRIVATE = resolve(ROOT, 'docs/_private');

// All Fractal modern-family model bytes per
// docs/devices/axe-fx-iii/manuals/Axe-Fx-III-MIDI-for-3rd-Party-Devices.txt and docs/devices/axe-fx-iii/SYSEX-MAP.md.
const MODELS: Array<{ byte: string; label: string }> = [
  { byte: '00', label: 'Axe-Fx Standard (gen 1)' },
  { byte: '01', label: 'Axe-Fx Ultra (gen 1)' },
  { byte: '03', label: 'Axe-Fx II Mark I/II' },
  { byte: '06', label: 'Axe-Fx II XL' },
  { byte: '07', label: 'Axe-Fx II XL+' },
  { byte: '08', label: 'AX8' },
  { byte: '10', label: 'Axe-Fx III' },
  { byte: '11', label: 'FM3' },
  { byte: '12', label: 'FM9' },
  { byte: '14', label: 'VP4' },
  { byte: '15', label: 'AM4' },
];

interface Post {
  content: string;
  author: string;
  threadTitle: string;
  threadUrl?: string;
  postUrl?: string;
}

function flattenPosts(): Post[] {
  const out: Post[] = [];
  const files = readdirSync(PRIVATE).filter((n) => /^forum-.+\.json$/.test(n));
  for (const f of files) {
    const path = join(PRIVATE, f);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data.threads) {
      // forum-batch-*.json — thread-scrape output
      for (const t of data.threads) {
        for (const p of (t.posts ?? [])) {
          out.push({
            content: p.content ?? '',
            author: p.author ?? '???',
            threadTitle: t.title ?? '(unknown)',
            threadUrl: t.base ?? '',
            postUrl: '',
          });
        }
      }
    } else if (data.results) {
      // forum-search-*.json — search results
      for (const r of data.results) {
        out.push({
          content: r.snippet ?? '',
          author: r.author ?? '???',
          threadTitle: r.title ?? '',
          postUrl: r.url ?? '',
        });
      }
    }
  }
  return out;
}

const posts = flattenPosts();
console.log(`Loaded ${posts.length} posts/snippets from docs/_private/.\n`);

// Build per-model regex. Tolerate variable whitespace and the optional
// "0x" prefix on bytes.
function regexFor(modelByte: string): RegExp {
  // Match "F0 00 01 74 <model>" with optional 0x prefix and varying whitespace
  return new RegExp(
    `F0\\s*0?0\\s*0?1\\s*7[Aa4]\\s*${modelByte}`,
    'gi',
  );
}

interface Hit {
  model: string;
  label: string;
  author: string;
  thread: string;
  context: string;
}

const allHits: Hit[] = [];
for (const m of MODELS) {
  const re = regexFor(m.byte);
  for (const p of posts) {
    const matches = [...p.content.matchAll(re)];
    if (matches.length === 0) continue;
    for (const match of matches) {
      const idx = match.index ?? 0;
      // Capture a window with the matched bytes for inspection.
      const ctx = p.content
        .slice(Math.max(0, idx - 10), idx + 100)
        .replace(/\s+/g, ' ')
        .trim();
      allHits.push({
        model: m.byte,
        label: m.label,
        author: p.author,
        thread: p.threadTitle.slice(0, 50),
        context: ctx,
      });
    }
  }
}

// Group + report.
const byModel = new Map<string, Hit[]>();
for (const h of allHits) {
  const arr = byModel.get(h.model) ?? [];
  arr.push(h);
  byModel.set(h.model, arr);
}

console.log('Wire-byte mentions by Fractal model byte:\n');
for (const m of MODELS) {
  const hits = byModel.get(m.byte) ?? [];
  console.log(`  0x${m.byte} (${m.label}): ${hits.length} mention${hits.length === 1 ? '' : 's'}`);
}
console.log();

for (const m of MODELS) {
  const hits = byModel.get(m.byte) ?? [];
  if (hits.length === 0) continue;
  console.log('─'.repeat(72));
  console.log(`${m.byte} — ${m.label} (${hits.length} mentions)`);
  console.log('─'.repeat(72));
  // Deduplicate by context (some posts repeat themselves in quotes).
  const seen = new Set<string>();
  for (const h of hits) {
    const key = h.context.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  [${h.thread}]`);
    console.log(`    ${h.author}: ${h.context}`);
    console.log();
  }
}
