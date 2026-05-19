/**
 * Post-build asset copier.
 *
 * As of the Phase-B `fractal-midi` extraction (2026-05-18), the lineage
 * JSON data lives inside the `fractal-midi` package, the MCP server
 * reads it via `runLineageLookup` imported from `fractal-midi/shared`,
 * which resolves at runtime to the lineage JSON files bundled in the
 * linked package's compiled output.
 *
 * The `COPIES` list still has one entry: `param-descriptions.json`,
 * the maintainer-time Blocks Guide extraction read at module load by
 * `packages/core/src/protocol-generic/param-descriptions.ts`. The TS
 * compiler doesn't emit JSON files by default, so we mirror it to the
 * built `dist/protocol-generic/` tree here.
 */
import { readdirSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface AssetCopy {
  src: string;
  dst: string;
}

const COPIES: AssetCopy[] = [
  {
    src: 'packages/core/src/protocol-generic/param-descriptions.json',
    dst: 'packages/core/dist/protocol-generic/param-descriptions.json',
  },
  // BK-064 part 1: per-amp + per-drive loudness corpus. Loaded by
  // packages/core/src/fractal-shared/loudness.ts at runtime; ts-only
  // emits don't include the JSON, so mirror it explicitly.
  {
    src: 'packages/core/src/fractal-shared/lineage/loudness.json',
    dst: 'packages/core/dist/fractal-shared/lineage/loudness.json',
  },
];

function copyTree(srcDir: string, distDir: string): number {
  let count = 0;
  if (!safeExists(srcDir)) return 0;
  mkdirSync(distDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const srcPath = join(srcDir, name);
    const distPath = join(distDir, name);
    const st = statSync(srcPath);
    if (st.isDirectory()) {
      count += copyTree(srcPath, distPath);
    } else if (!srcPath.endsWith('.ts')) {
      copyFileSync(srcPath, distPath);
      count++;
    }
  }
  return count;
}

function safeExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

let total = 0;
for (const { src, dst } of COPIES) {
  if (!safeExists(src)) {
    console.log(`  skipped (missing source): ${src}`);
    continue;
  }
  const st = statSync(src);
  if (st.isDirectory()) {
    const n = copyTree(src, dst);
    console.log(`  copied ${n} file(s) from ${src} → ${dst}`);
    total += n;
  } else {
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    console.log(`  copied ${src} → ${dst}`);
    total++;
  }
}
console.log(`copy-build-assets: ${total} file(s) mirrored.`);
