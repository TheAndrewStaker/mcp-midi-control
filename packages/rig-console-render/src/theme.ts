/**
 * theme.ts — the Rig Console's design tokens as DATA (Phase A of the
 * console design workplan; rules in docs/design/RIG-CONSOLE-MENU-LANGUAGE.md).
 *
 * THE CONTRACT: every color, face, and size the console renders resolves
 * through these tokens. Markup is semantic (classes name ROLES, never
 * appearance), so a completely different look is a different ConsoleTheme
 * value with ZERO markup change (rule 28, themeable by construction).
 * `scripts/verify-console-design.ts` enforces the separation mechanically:
 * no hex literal outside the emitted token blocks, computed WCAG contrast
 * on the declared pairs, no status dots, and every font-size on the ladder.
 *
 * Token NAMES are stable across themes; only values swap. The active theme
 * is the tactical-overlay look the owner picked in the 2026-08-23 design
 * exploration; the pre-Phase-A quiet-dark palette could return as an
 * alternate theme without touching a selector.
 */

/** Every color token the console stylesheet may reference. */
export type TokenName =
  | 'bg' | 'panel' | 'sunk' | 'ink' | 'muted' | 'faint'
  | 'line' | 'line2'
  | 'audio' | 'timing' | 'midi' | 'fsw' | 'governed'
  | 'ok' | 'warn' | 'bad'
  | 'song' | 'groove' | 'scratch' | 'unknown' | 'empty'
  | 'pad-ink' | 'paper';

export interface ConsoleTheme {
  readonly name: string;
  /** Primary mode (the console is dark-first). */
  readonly dark: Readonly<Record<TokenName, string>>;
  /** prefers-color-scheme: light values. Same token names, always complete. */
  readonly light: Readonly<Record<TokenName, string>>;
}

/**
 * The tactical-overlay theme: deep blue-cyan monochrome ground, gold as
 * the noteworthy/location accent (doubling as `warn` per menu-language
 * rule 16), warm red for cost/danger. Signal-kind hues (audio/timing/
 * midi/fsw/governed) are FUNCTIONAL encodings, always paired with a text
 * label (page.ts header: "colour is never the only channel"), and are
 * re-tinted to sit on the blue ground.
 */
export const TACTICAL: ConsoleTheme = {
  name: 'tactical',
  // The dark values are the MOCKUP'S approved palette, verbatim
  // (RIG-CONSOLE-MOCKUP-REFERENCE.html): sea ground, cyan for the note
  // stream + interface accents, gold/amber for clock + noteworthy.
  dark: {
    bg: '#0a1e2c', panel: '#123650', sunk: '#071824',
    ink: '#cfe8f2', muted: '#7fa3b5', faint: '#7794a6',
    line: '#1b3242', line2: '#2a4a60',
    audio: '#d98e3f', timing: '#e8c25c', midi: '#7fd4e8',
    fsw: '#97abbc', governed: '#b49ae8',
    ok: '#4fae7e', warn: '#d9b23f', bad: '#f28d6e',
    song: '#9f7fd9', groove: '#7fd4e8', scratch: '#5e7c8e',
    unknown: '#d9b23f', empty: '#0e2836',
    'pad-ink': '#0a1e2c', paper: '#ffffff',
  },
  light: {
    bg: '#f4f6f8', panel: '#ffffff', sunk: '#e9eef2',
    ink: '#1c2830', muted: '#54707e', faint: '#7a929f',
    line: '#d5dee4', line2: '#c2cfd8',
    audio: '#a66214', timing: '#1c6fb8', midi: '#0b7a68',
    fsw: '#5e717d', governed: '#7247c4',
    ok: '#1e7e48', warn: '#8f6a10', bad: '#c43a28',
    song: '#7247c4', groove: '#0b7a68', scratch: '#8a98a2',
    unknown: '#8f6a10', empty: '#e4eaef',
    'pad-ink': '#10141a', paper: '#ffffff',
  },
};

/** The theme the console currently ships. Swap here, nowhere else. */
export const ACTIVE_THEME: ConsoleTheme = TACTICAL;

/**
 * Font stacks. 'RigUI' / 'RigMono' resolve when the HTTP host serves the
 * vendored faces (Titillium Web + Share Tech Mono, SIL OFL); the CLI-
 * generated file:// page falls through to the system stacks — a designed
 * degradation, not an accident.
 */
export const FONT_UI =
  `'RigUI',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`;
export const FONT_MONO =
  `'RigMono',ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace`;

/**
 * The sanctioned type ladder, px. A font-size outside this ladder fails
 * the design gate. Hierarchy note (menu-language rule 25): list/table
 * body sizes sit at the map-label size; only corner informational bits
 * drop to the fine-print end.
 */
export const TYPE_SCALE_PX: readonly number[] =
  [9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14.5, 15, 21, 26];

/**
 * Contrast pairs the gate computes (WCAG 2.x relative-luminance ratio),
 * per theme mode. `min` 7 = body text, 4.5 = AA normal, 3 = large/
 * secondary-only text (faint is documented secondary).
 */
export const CONTRAST_RULES: ReadonlyArray<{ fg: TokenName; bg: TokenName; min: number }> = [
  { fg: 'ink', bg: 'bg', min: 7 },
  { fg: 'ink', bg: 'panel', min: 7 },
  { fg: 'muted', bg: 'bg', min: 4.5 },
  { fg: 'muted', bg: 'panel', min: 4.5 },
  { fg: 'faint', bg: 'bg', min: 3 },
  { fg: 'faint', bg: 'panel', min: 3 },
  { fg: 'ok', bg: 'panel', min: 4.5 },
  { fg: 'warn', bg: 'panel', min: 4.5 },
  { fg: 'bad', bg: 'panel', min: 4.5 },
  { fg: 'audio', bg: 'panel', min: 4.5 },
  { fg: 'timing', bg: 'panel', min: 4.5 },
  { fg: 'midi', bg: 'panel', min: 4.5 },
  { fg: 'fsw', bg: 'panel', min: 4.5 },
  { fg: 'governed', bg: 'panel', min: 4.5 },
];

/** Emit one mode's custom-property declarations. */
function decls(tokens: Readonly<Record<TokenName, string>>): string {
  return (Object.entries(tokens) as [TokenName, string][])
    .map(([k, v]) => `--${k}:${v}`)
    .join('; ');
}

/**
 * The :root token blocks the stylesheet starts with. page.ts interpolates
 * this INSTEAD of hand-writing hex values; the gate treats everything this
 * emits as the sanctioned set.
 *
 * The screen look deliberately commits to ONE theme (the owner-approved
 * tactical dark of RIG-CONSOLE-MOCKUP-REFERENCE.html) — an OS light
 * preference must not swap a stage console to white mid-gig. The light set
 * is PRINT's palette (paper rendering), which keeps both modes real,
 * contrast-gated surfaces rather than dead code.
 */
export function tokensCss(theme: ConsoleTheme = ACTIVE_THEME): string {
  return `:root{ ${decls(theme.dark)}; --mono:${FONT_MONO}; --ui:${FONT_UI}; }
@media print{
  :root{ ${decls(theme.light)}; }
}`;
}

/** Every hex value the active theme sanctions (lowercased), both modes. */
export function sanctionedHex(theme: ConsoleTheme = ACTIVE_THEME): Set<string> {
  const out = new Set<string>();
  for (const mode of [theme.dark, theme.light]) {
    for (const v of Object.values(mode)) out.add(v.toLowerCase());
  }
  return out;
}
