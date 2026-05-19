/**
 * BK-064 part 3 goldens: per-amp + per-drive loudness lookup.
 *
 * Asserts that `lookupAmpLoudness` / `lookupDriveLoudness` /
 * `formatLoudnessAppendix` resolve known names (case + whitespace
 * tolerant), return `undefined` for unknown names, and surface the
 * expected reference anchor metadata.
 *
 * Run: npx tsx scripts/verify-loudness-lookup.ts
 */

import {
  lookupAmpLoudness,
  lookupDriveLoudness,
  loudnessReferenceAnchors,
  formatLoudnessAppendix,
} from '@mcp-midi-control/core/fractal-shared/loudness.js';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `. ${detail}` : ''}`);
  }
}

console.log('Reference anchors');
const anchors = loudnessReferenceAnchors();
check(
  `reference amp present, got ${JSON.stringify(anchors.amp)}`,
  typeof anchors.amp === 'string' && anchors.amp.length > 0,
);
check(
  `reference drive present, got ${JSON.stringify(anchors.drive)}`,
  typeof anchors.drive === 'string' && anchors.drive.length > 0,
);
check(
  `precision string present, got ${JSON.stringify(anchors.precision)}`,
  typeof anchors.precision === 'string' && anchors.precision.length > 0,
);

console.log('\nKnown amp lookups (reference = Double Verb Normal at 0 dB)');
{
  const dvn = lookupAmpLoudness('Double Verb Normal');
  check(
    `lookupAmpLoudness("Double Verb Normal") returns an entry`,
    dvn !== undefined,
  );
  if (dvn) {
    check(
      `Double Verb Normal master_sweet_spot = 6.0, got ${dvn.master_sweet_spot_display}`,
      dvn.master_sweet_spot_display === 6.0,
    );
    check(
      `Double Verb Normal relative_loudness_dB = 0, got ${dvn.relative_loudness_dB}`,
      dvn.relative_loudness_dB === 0,
    );
  }
}
{
  // Case-insensitive lookup.
  const upper = lookupAmpLoudness('DOUBLE VERB NORMAL');
  check(`case-insensitive lookup works`, upper !== undefined);
  // Whitespace-tolerant lookup.
  const padded = lookupAmpLoudness('  Double Verb Normal  ');
  check(`whitespace-tolerant lookup works`, padded !== undefined);
}

console.log('\nUnknown lookups → undefined');
check(
  `lookupAmpLoudness("Not A Real Amp") === undefined`,
  lookupAmpLoudness('Not A Real Amp') === undefined,
);
check(
  `lookupDriveLoudness("Not A Real Drive") === undefined`,
  lookupDriveLoudness('Not A Real Drive') === undefined,
);

console.log('\nformatLoudnessAppendix');
{
  const appendix = formatLoudnessAppendix('Double Verb Normal');
  check(
    `appendix non-empty for known amp, got ${JSON.stringify(appendix)}`,
    appendix.length > 0,
  );
  check(
    `appendix mentions master_sweet_spot`,
    appendix.includes('master_sweet_spot'),
  );
  check(
    `appendix mentions relative_loudness_dB`,
    appendix.includes('relative_loudness_dB'),
  );
  const empty = formatLoudnessAppendix('Not A Real Amp');
  check(`appendix empty string for unknown name`, empty === '');
}

console.log(`\n${failed === 0 ? 'all cases pass' : `${failed} case(s) failed`}.`);
if (failed > 0) process.exit(1);
