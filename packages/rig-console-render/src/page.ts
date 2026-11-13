/**
 * page.ts — the Rig Console page: one self-contained HTML document.
 *
 * THREE PANELS, ONE QUESTION EACH.
 *   Rig     what is cabled to what, and what fails a check.
 *   Set     the songs in performance order, and whether the card holds them.
 *   Card    all 320 sequencer slots, laid out the way the device lays them out.
 *
 * THE SIGNATURE IS THE CARD GRID. Five packs of 64 projects, drawn as five 8x8
 * pad grids, because that is the shape the Circuit Tracks itself presents. A
 * song is a run of lit pads, so "where does this song live" is answered by looking
 * rather than by reading a table. Selecting a song in the Set panel lights its
 * run across the packs.
 *
 * SELF-CONTAINED, ZERO DEPENDENCIES, NO NETWORK. Inline CSS, inline SVG, one
 * small script. It opens from `file://` with the server stopped and Claude
 * Desktop closed, which is the point: nothing here is live, so nothing here
 * needs a listener, a token, or a port that the vendor editors would fight over.
 *
 * COLOUR IS NEVER THE ONLY CHANNEL. Signal type is carried by a text label as
 * well as a stroke colour; slot category by a legend and the slot's own title
 * text; check state by the words PASS / NEEDS ATTENTION, not by green and red.
 * The text rendering at the foot of the page is a peer view, always in the DOM,
 * findable with Ctrl+F and readable end to end by a screen reader.
 */
import type { RigView } from 'openrig';
import { renderRigText } from 'openrig';

import { PROJECT_COLOURS, PROJECT_COLOUR_DEFAULT } from '@mcp-midi-control/circuit-tracks/ncs/format.js';

import { renderDiagram, signalOrder } from './diagram.js';
import { FONT_FACE_DATA_CSS } from './fonts.generated.js';
import { songKey } from './join.js';
import { CONSOLE_MAP_JS, mapModel } from './map.js';
import { tokensCss } from './theme.js';
import type { ConsoleCard, ConsoleSlot, ConsoleSong, ConsoleVoice, SongJoin, SourceStatus } from './types.js';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The device's 14 project colours, rendered.
 *
 * PROVENANCE, STATED PLAINLY. The NAMES and their palette ORDER are Novation's
 * own and come from the codec (`PROJECT_COLOURS`, sourced from the user guide's
 * "Changing Project Colours" and the Components projects view). The hex values
 * below are NOT sampled from the hardware: Novation publishes no RGB for this
 * palette in either the user guide or the programmer's reference, and neither
 * does the `.ncs` file, which stores only the index. They are a faithful
 * rendering of the names as the 14-step hue walk the palette order describes,
 * respecting the pairs the codec documents as deliberately close in hue
 * (Red/Rose, Peach/Orange, Khaki/Lime, Green/Teal, Cyan/Blue, Purple/Pink).
 *
 * So: WHICH colour each project is, is device truth read from byte 0x0c. WHAT
 * that colour looks like on screen is an approximation. To make it exact, sample
 * the pads from a photograph of Projects view and replace this table; nothing
 * else has to change.
 */
const PROJECT_COLOUR_HEX: readonly string[] = [
  '#f0413a', // 0  Red
  '#f4557e', // 1  Rose
  '#ff8a5c', // 2  Peach
  '#f79021', // 3  Orange
  '#d9bd6b', // 4  Sand
  '#f2d02c', // 5  Yellow
  '#bfc457', // 6  Khaki
  '#9ad633', // 7  Lime
  '#35c05a', // 8  Green
  '#2ec4ac', // 9  Teal
  '#28c2dd', // 10 Cyan
  '#2f5fd0', // 11 Blue (the factory default; "dark blue" in the user guide)
  '#9b5cf0', // 12 Purple
  '#ec6bb4', // 13 Pink
];

/** Novation's own name for a palette index, for the legend. */
const PROJECT_COLOURS_NAME = (i: number): string => PROJECT_COLOURS[i] ?? `index ${i}`;

/**
 * A few "song is this colour" examples, so the legend says what the colours
 * MEAN on this card rather than only what they are called.
 *
 * Songs still on the factory default are skipped, and no colour is shown twice:
 * "Song A is Blue, Song B is Blue" demonstrates nothing, because Blue is
 * what a project reads when nobody has stamped it.
 */
function sampleSongColours(used: ConsoleSlot[]): string {
  const bySong = new Map<string, string>();
  const takenColours = new Set<string>();
  for (const s of used) {
    if (s.song === undefined || s.colour === undefined) continue;
    if (s.colour_index === PROJECT_COLOUR_DEFAULT) continue;
    if (bySong.has(s.song) || takenColours.has(s.colour)) continue;
    bySong.set(s.song, s.colour);
    takenColours.add(s.colour);
  }
  return [...bySong].slice(0, 3).map(([song, colour]) => `${song} is ${colour}`).join(', ');
}

const SLOT_KIND_LABEL: Record<string, string> = {
  song: 'song section',
  'groove-mixwave': 'groove (purchased pack, name is a guess)',
  'groove-transcribed': 'groove (hand-transcribed)',
  test: 'test / scratch',
  unknown: 'unclassified',
};

// ─── styles ─────────────────────────────────────────────────────────────────

/**
 * The console's full stylesheet. Exported (as `CONSOLE_CSS`) because the HTTP
 * host serves it as a static asset (`/assets/app.css`): the shell page carries
 * no inline styles under `style-src 'self'`, so the CSS must arrive as a file.
 * It is CONSTANT and information-free, same bytes for every user and launch.
 */
const CSS = `
${tokensCss()}
/* ── PORTED FROM docs/design/RIG-CONSOLE-MOCKUP-REFERENCE.html (the
   owner-approved 16-iteration design). Aliases map the mockup's names onto
   the token contract; translucents derive via color-mix so the gate's hex
   sanction holds. Start from the design; fit the data into it. ── */
:root{
  --sea:var(--bg); --cyan:var(--midi); --gold:var(--warn); --amber:var(--timing);
  --ink-dim:var(--muted); --data:var(--mono);
  --bar:color-mix(in srgb,var(--ink) 10%,transparent);
  --bar-solid:color-mix(in srgb,var(--ink) 86%,transparent);
  --sel:color-mix(in srgb,var(--ink) 88%,transparent);
  --sel-ink:var(--bg);
  --edge:color-mix(in srgb,var(--ink) 25%,transparent);
  --pane:color-mix(in srgb,var(--bg) 62%,transparent);
  /* map wire inks: cyan and the footswitch hue sit close to the blue
     ground, so the wires lift their luminance with ink (owner, 2026-08-24:
     "non-amber lines are also VERY faint"). The legend swatches use the
     SAME tokens — a legend that disagrees with the wires is worse than
     none. */
  --wire-midi:color-mix(in srgb,var(--midi) 62%,var(--ink));
  --wire-fsw:color-mix(in srgb,var(--fsw) 62%,var(--ink));
}
*{margin:0;box-sizing:border-box}
html{color-scheme:dark}
html,body{height:100%}
/* the served shell injects the page into #rc-root; without a height the
   whole flex column collapses and the foot bars stack UNDER the top strip,
   where the text-peer button sat exactly over the flow toggle and ate its
   clicks (owner: "MIDI Flow button is unclickable", 2026-08-24 dogfood) */
#rc-root{display:block;height:100%}
body{background:radial-gradient(130% 100% at 72% 25%,var(--panel),var(--sea) 62%);
  color:var(--ink);font-family:var(--ui);overflow:hidden}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:40;
  background-image:radial-gradient(color-mix(in srgb,var(--ink) 9%,transparent) 1px,transparent 1px);
  background-size:24px 24px}
/* mockup alphas exactly: scanlines at .16, vignette at .55 — the first
   port over-poured them (60%/80%) and the stripes shredded every light
   bar; readability lives in these two numbers */
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:41;
  background:repeating-linear-gradient(180deg,color-mix(in srgb,var(--sunk) 16%,transparent) 0 1px,transparent 1px 3px),
  radial-gradient(120% 100% at 50% 45%,transparent 55%,color-mix(in srgb,var(--sunk) 55%,transparent) 100%)}
@media (max-height:540px){body{overflow:auto}}
.wrap{position:relative;height:100%;display:flex;flex-direction:column;padding:.9rem 1.2rem}
.content{position:relative;flex:1;min-height:0}

/* THE MAP LAYER — the ground of every page; subject on Rig, ambient elsewhere */
.mapwrap{display:none;position:absolute;inset:0;z-index:0}
.mapwrap.on{display:block}
svg.rcmap{display:block;width:100%;height:100%;background:transparent}
html[data-rc-page="rig"] svg.rcmap{cursor:grab}
html[data-rc-page="rig"] svg.rcmap.panning{cursor:grabbing}
html[data-rc-page="set"] .mapwrap.on,html[data-rc-page="card"] .mapwrap.on{opacity:.45;pointer-events:none}
html[data-rc-page="set"] .flowtoggle,html[data-rc-page="card"] .flowtoggle,
html[data-rc-page="set"] .rc-inspect,html[data-rc-page="card"] .rc-inspect,
html[data-rc-page="set"] .mapwrap .legend,html[data-rc-page="card"] .mapwrap .legend{display:none}
.rcnode{cursor:pointer}
.rcnode rect{fill:color-mix(in srgb,var(--bg) 55%,transparent);stroke:color-mix(in srgb,var(--ink) 40%,transparent);stroke-width:1}
.rcnode text{fill:var(--ink);font-family:var(--data);font-size:var(--maptx,13.5px);
  text-shadow:0 0 7px color-mix(in srgb,var(--cyan) 35%,transparent)}
.rcnode.sel rect{fill:var(--sel);stroke:var(--cyan)}
.rcnode.sel text{fill:var(--sel-ink);text-shadow:none}
.rcnode:focus-visible rect{stroke:var(--cyan);stroke-width:2}
.rcnode:focus{outline:none}
path.rcw{stroke-width:2;opacity:.95;stroke-linecap:round;stroke-linejoin:round}
path.rcw.glow{stroke-width:5;opacity:.5}
path.rcw.hit{stroke:transparent;stroke-width:15;opacity:1;pointer-events:stroke;cursor:pointer}
path.rcw.midi{stroke:var(--wire-midi)}
path.rcw.timing{stroke:var(--gold)}
/* audio is the performance-critical signal and reads THIN at 2 (owner,
   2026-08-27): heaviest gauge of the three kinds. Scoped off the glow and
   hit passes so their widths stay their own. */
path.rcw.audio{stroke:var(--audio)}
path.rcw.audio:not(.glow):not(.hit){stroke-width:3}
path.rcw.governed{stroke:var(--gold);stroke-dasharray:6 4}
path.rcw.footswitch{stroke:var(--wire-fsw);stroke-dasharray:2 4}
path.rcw.planned{opacity:.3}
path.rcw.ghost{opacity:.12;stroke-width:1}
path.rcw.sel{stroke:var(--ink)}
/* the spine: the dim full-height guide through the hub's column track */
line.rcspine{stroke:color-mix(in srgb,var(--ink) 13%,transparent);stroke-width:1}
/* terminal pads: the PCB "connector" read where a trace meets its box */
rect.rcpad{stroke:none}
rect.rcpad.midi{fill:var(--wire-midi)} rect.rcpad.timing{fill:var(--gold)}
rect.rcpad.audio{fill:var(--audio)} rect.rcpad.governed{fill:var(--gold)}
rect.rcpad.footswitch{fill:var(--wire-fsw)}

/* top strip */
.shellbar{position:relative;z-index:2;display:flex;align-items:center;gap:1.2rem;flex:none}
.stamp b{display:block;font-family:var(--data);font-size:.66rem;color:var(--amber);
  letter-spacing:.08em;text-transform:uppercase;font-weight:400;
  text-shadow:0 0 8px color-mix(in srgb,var(--amber) 40%,transparent)}
.stamp .loc{display:block;font-family:var(--data);font-size:.6rem;color:var(--ink-dim);letter-spacing:.08em;text-transform:uppercase}
.tabs{display:flex;gap:.45rem;align-items:center;margin-left:1rem}
.kbd{font-family:var(--data);font-size:.6rem;color:var(--ink-dim);border:1px solid var(--edge);border-radius:2px;padding:.1rem .3rem}
.tab{font:600 .7rem/1 var(--ui);letter-spacing:.2em;color:var(--ink-dim);
  background:var(--bar);border:1px solid transparent;padding:.42rem .85rem;cursor:pointer;text-transform:uppercase}
.tab[aria-selected="true"]{color:var(--sel-ink);background:var(--sel)}
.tab:focus-visible,tr.song:focus-visible{outline:1px solid var(--cyan);outline-offset:1px}
/* the source status lives BOTTOM-LEFT as amber system text (the mgsv
   summary/status corner from the approved designs), not as top chips: the
   top strip stays identity + tabs only (owner: "top is crammed... bottom
   left is like system/summary/status info", 2026-08-24 dogfood). The Songs
   deck's bottom-left is the Voices panel, so the block rides the Rig page. */
/* Two-column ledger, ALL LEFT-ALIGNED (owner ruling, 2026-08-24, final
   after trying flush-right values: labels in a fixed left column, values
   left-aligned FROM the shared spine, so rows hug one vertical edge and
   the ragged right side never opens a gap). Tabular numerals keep digits
   column-aligned. */
.sysinfo{position:absolute;left:0;bottom:.4rem;z-index:1;display:grid;
  grid-template-columns:max-content max-content;gap:.3rem 1.4em;align-items:baseline;
  font-family:var(--data);font-size:.7rem;color:var(--amber);pointer-events:none}
.sysinfo .si{display:contents}
.sysinfo .si b{font-family:var(--ui);font-weight:600;font-size:.62rem;letter-spacing:.14em;
  text-transform:uppercase;color:var(--ink-dim);text-align:left}
.sysinfo .si span{text-align:left;font-variant-numeric:tabular-nums lining-nums;
  text-shadow:0 0 8px color-mix(in srgb,var(--amber) 35%,transparent)}
.sysinfo .si.error span{color:var(--bad)} .sysinfo .si.absent span{color:var(--faint)}
html[data-rc-page="set"] .sysinfo,html[data-rc-page="card"] .sysinfo{display:none}

/* decks: overlay layers; panels float, lists scroll INSIDE */
.deck{display:none;position:absolute;inset:.9rem 0 0;z-index:1;pointer-events:none}
.deck.on{display:block}
.deck.on#deck-set{display:grid;grid-template-columns:minmax(370px,46%) 1fr;gap:2rem}
.deck>*{pointer-events:auto}
.panel-h{background:var(--bar-solid);color:var(--sel-ink);padding:.28rem .6rem;
  font:700 .66rem/1.3 var(--ui);letter-spacing:.24em;text-transform:uppercase;width:max-content;min-width:46%}
.left{display:flex;flex-direction:column;gap:.7rem;min-height:0}
.right{display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;min-height:0;pointer-events:none}
.right>*{pointer-events:auto}
.songscroll{overflow-y:auto;max-height:56vh;scrollbar-width:thin}
table.songs{border-collapse:collapse;width:100%;font-size:.84rem}
.songs th{text-align:left;font:600 .6rem/1.3 var(--ui);letter-spacing:.16em;color:var(--ink-dim);
  padding:.2rem .5rem;border-bottom:1px solid var(--edge);text-transform:uppercase}
.songs td{padding:.28rem .5rem;font-family:var(--ui);font-weight:600}
.songs td.d{font-family:var(--data);font-weight:400}
tr.song{cursor:pointer;background:var(--bar)}
tr.song+tr.song td,tr.grp+tr.song td{border-top:2px solid color-mix(in srgb,var(--bg) 55%,transparent)}
tr.song.sel,tr.song[aria-selected="true"]{background:var(--sel)}
tr.song.sel td,tr.song[aria-selected="true"] td{color:var(--sel-ink)}
.songs .num{color:var(--gold)}
tr.song.sel .num{color:color-mix(in srgb,var(--gold) 55%,var(--bg))}
tr.grp td{font:600 .6rem/1.4 var(--ui);letter-spacing:.16em;text-transform:uppercase;
  color:var(--ink-dim);padding:.5rem .5rem .2rem;background:transparent}
tr.staged-empty td{opacity:.5}
.songs .artist{display:block;font-weight:400;font-size:.68rem;color:var(--ink-dim)}
tr.song.sel .artist{color:color-mix(in srgb,var(--sel-ink) 70%,var(--ink))}
.desc{font-size:.8rem;line-height:1.5;max-width:52ch;padding:.1rem .15rem;min-height:3.2em;font-weight:400}
.desc .t{color:var(--ink-dim)}
/* the Voices panel (mockup's gold rew table): the selected song's chosen
   voice per instrument; one tbody per song, toggled by selection */
.voices{margin-top:auto}
.panel-h.gold{background:color-mix(in srgb,var(--warn) 85%,transparent)}
table.rew{border-collapse:collapse;width:100%;font-size:.8rem}
.rew td{padding:.24rem .55rem;background:color-mix(in srgb,var(--warn) 14%,transparent);
  border-top:2px solid color-mix(in srgb,var(--bg) 55%,transparent)}
.rew td.k{color:var(--amber);width:40%;font-family:var(--data)}
.rew tbody.voi{display:none}
.rew tbody.voi.on{display:table-row-group}
.tag{display:inline-block;font-family:var(--data);font-size:.6rem;letter-spacing:.06em;
  text-transform:uppercase;padding:1px 6px;background:var(--bar);color:var(--ink-dim)}
.tag.ok{color:var(--ok)} .tag.warn{color:var(--gold)} .tag.bad{color:var(--bad)}
.tag.audio{color:var(--audio)} .tag.midi{color:var(--cyan)} .tag.timing{color:var(--gold)}
.tag.governed{color:var(--governed)} .tag.planned{border:1px dashed var(--edge);background:transparent}
.tasks{background:var(--bar);border-left:3px solid var(--gold);padding:.55rem .75rem;
  min-width:300px;max-height:50vh;overflow:auto;backdrop-filter:blur(2px)}
.tasks h3{font:600 .62rem/1.3 var(--ui);letter-spacing:.2em;color:var(--ink-dim);margin-bottom:.45rem;text-transform:uppercase}
.task{display:flex;gap:.5rem;align-items:baseline;font-size:.8rem;padding:.18rem 0}
.box{display:inline-block;width:11px;height:11px;border:1px solid var(--ink-dim);flex:none;position:relative;top:1px}
.box.done{border-color:var(--cyan);background:linear-gradient(135deg,transparent 46%,var(--cyan) 46%,var(--cyan) 58%,transparent 58%)}
.task.open{color:var(--amber)}
.cluster{text-align:right;font-family:var(--data);font-size:.7rem;line-height:1.75}
.cluster .k{color:var(--ink-dim);padding-right:.8em;font-family:var(--ui);font-weight:600;font-size:.62rem;letter-spacing:.12em;text-transform:uppercase}
.cluster .v{color:var(--ink)}
.cluster .v.gold{color:var(--gold);text-shadow:0 0 8px color-mix(in srgb,var(--gold) 45%,transparent)}

/* inspect: the top-left quadrant, header-bar grammar */
.rc-inspect{display:none;position:absolute;left:0;top:1.2rem;width:min(520px,46%);
  z-index:2;flex-direction:column;gap:.7rem}
.rc-inspect.on{display:flex}
.rc-inspect .ph{background:var(--bar-solid);color:var(--sel-ink);padding:.3rem .7rem;
  font:700 .8rem/1.3 var(--ui);letter-spacing:.24em;text-transform:uppercase;width:max-content;min-width:46%}
.rc-inspect .body{background:color-mix(in srgb,var(--bg) 66%,transparent);border-left:3px solid var(--cyan);
  padding:.75rem .95rem .85rem;backdrop-filter:blur(3px);max-height:60vh;overflow:auto;font-size:.8rem}
.rc-inspect .body h3{font-size:.86rem;letter-spacing:.1em;text-transform:uppercase;margin:0 0 2px}
.rc-inspect .body .top h3{display:none}
.rc-inspect .roles{color:var(--ink-dim);font-family:var(--data);font-size:.7rem;margin:.15rem 0 .4rem}
.rc-inspect .conns{display:flex;flex-direction:column;gap:4px;margin-top:.45rem}
.rc-inspect .conn{font-size:.78rem;color:var(--ink-dim);display:flex;gap:8px;align-items:baseline}
.rc-inspect .conn .ar{font-family:var(--data);color:var(--faint);flex:none;width:2.2em}
.rc-inspect .conn b{color:var(--ink);font-weight:600}
.rc-inspect details summary{color:var(--faint);font-size:.7rem;cursor:pointer}
.rc-inspect .notefull{color:var(--faint);font-size:.7rem;margin-top:.3rem}
.maplink{margin-top:.6rem;font:700 .68rem/1 var(--ui);letter-spacing:.12em;text-transform:uppercase;
  color:var(--sel-ink);background:var(--sel);border:0;padding:.34rem .85rem;cursor:pointer}
.flowtoggle{position:absolute;right:0;top:1.2rem;z-index:3;display:flex;gap:6px}
.flowtoggle button{font:600 .66rem/1 var(--ui);letter-spacing:.18em;text-transform:uppercase;
  color:var(--ink-dim);background:var(--bar);border:1px solid transparent;padding:.42rem .8rem;cursor:pointer}
.flowtoggle button[aria-pressed="true"]{color:var(--sel-ink);background:var(--sel)}

/* legend: bottom-right over the map */
.mapwrap .legend{position:absolute;right:0;bottom:.4rem;z-index:1;display:block;
  background:var(--pane);border-left:3px solid var(--edge);padding:.5rem .7rem;
  font-family:var(--data);font-size:.68rem;color:var(--ink-dim);backdrop-filter:blur(2px)}
.mapwrap .legend .lg{display:flex;align-items:center;gap:.55rem;padding:.14rem 0}
.mapwrap .legend .sw{width:26px;border-top:2px solid;display:inline-block}

/* the card page: the pad detail owns a RESERVED left column (owner,
   2026-08-24: a floating panel over the grids steals their clicks — "does
   this detail section need its own space?" — yes); the grids live to its
   right and are never occluded. Detail wears the amber/gold ledger, the
   same .rew grammar as Voices. */
#deck-card .cardcol{height:100%;display:flex;flex-direction:column;gap:.7rem;min-height:0;
  margin-left:calc(min(430px,32%) + 1.2rem)}
.packs{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:14px;
  overflow:auto;min-height:0;padding-right:6px}
.pack{background:var(--bar);backdrop-filter:blur(2px);padding:12px 13px 13px}
.pack .ph{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:9px}
.pack .pn{font-weight:600;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase}
.pack .pc{color:var(--ink-dim);font-size:.66rem;font-family:var(--data)}
.grid{display:grid;grid-template-columns:repeat(8,1fr);gap:3px}
.slot{aspect-ratio:1;border-radius:4px;background:var(--empty);border:1px solid transparent;
  display:flex;align-items:center;justify-content:center;font-family:var(--data);font-size:9.5px;
  color:var(--faint);position:relative}
.slot.used{background:color-mix(in srgb,var(--pad,var(--scratch)) 62%,var(--empty));color:var(--pad-ink);font-weight:600;
  box-shadow:inset 0 0 8px color-mix(in srgb,var(--paper) 22%,transparent)}
.slot.flag::after{content:"";position:absolute;top:2px;right:2px;width:5px;height:5px;background:var(--bad)}
/* Filtered resting state stays READABLE (owner, 2026-08-24: "resting state
   should show up better"): the un-hit pads recede but keep their colours,
   and the selected run pops via the ring + glow, not via blacking out the
   rest. .18 was the pre-mockup spotlight value. */
.packs.filtered .slot{opacity:.55}
.packs.filtered .slot.hit{opacity:1;border-color:var(--ink);
  box-shadow:0 0 0 2px var(--ink),0 0 14px color-mix(in srgb,var(--song) 70%,transparent)}
.slot.used{cursor:pointer}
.slot.sel,.packs.filtered .slot.sel{opacity:1;border-color:var(--ink);
  box-shadow:0 0 0 2px var(--ink),0 0 12px color-mix(in srgb,var(--song) 70%,transparent)}
/* pad inspect: the ph/body grammar in its own left column, amber (mgsv).
   top:0 = the deck's shared first row line, so this column's header bar
   starts at the SAME datum as the grids column's "THE CARD" bar (owner,
   2026-08-27: columns must start on one grid line — the codified-grid
   principle going into the design-system session). */
.padinspect{display:none;position:absolute;left:0;top:0;width:min(430px,32%);
  z-index:3;flex-direction:column;gap:.7rem}
.padinspect.on{display:flex}
.padinspect .ph{background:color-mix(in srgb,var(--warn) 85%,transparent);color:var(--bg);
  padding:.3rem .7rem;font:700 .8rem/1.3 var(--ui);letter-spacing:.24em;text-transform:uppercase;
  width:max-content;min-width:46%}
.padinspect .body{background:color-mix(in srgb,var(--bg) 66%,transparent);border-left:3px solid var(--gold);
  padding:.75rem .95rem .85rem;backdrop-filter:blur(3px);font-size:.8rem;max-height:60vh;overflow:auto}
.padinspect .body h3{font-size:.86rem;letter-spacing:.06em;margin:0 0 6px}
.padinspect .rew td{font-family:var(--ui)}
.padinspect .rew td.k{font-family:var(--data)}
.rew .t{color:var(--ink-dim)}
.runs{color:var(--faint);font-size:.66rem;margin-top:8px;font-family:var(--data)}
#deck-card .legend{display:flex;flex-wrap:wrap;gap:4px 18px;flex:none;
  font-family:var(--data);font-size:.68rem;color:var(--ink-dim);padding:.25rem 0 0}
#deck-card .legend .lg{display:flex;align-items:center;gap:.55rem}

/* foot */
.chipbar{position:relative;z-index:2;display:flex;align-items:center;gap:.9rem;padding-top:.7rem;font-size:.7rem;flex:none}
.chipbar .sub,#live{color:var(--ink-dim);font-family:var(--data);font-size:.64rem}
.chipbar .stats{display:flex;gap:14px;margin-left:auto}
.chipbar .stat b{font-family:var(--data);font-size:.7rem;font-weight:400;color:var(--ink)}
.chipbar .stat span{color:var(--ink-dim);font-size:.6rem;letter-spacing:.08em;text-transform:uppercase;padding-left:.4em}

/* the text peer: slim bar; hidden=until-found keeps it Ctrl+F-reachable */
.textpeer{flex:none;border-top:1px solid var(--edge)}
.textpeer>button{width:100%;text-align:left;font-family:var(--data);font-size:.6rem;letter-spacing:.12em;
  text-transform:uppercase;color:var(--ink-dim);background:none;border:0;padding:.45rem .1rem;cursor:pointer}
.textpeer>button:hover{color:var(--ink)}
#textpeer-body pre.text{max-height:32vh;overflow:auto;margin:0 0 6px;font-family:var(--data);
  font-size:.7rem;line-height:1.6;color:var(--ink);white-space:pre-wrap;
  background:var(--pane);padding:10px 12px}
#textpeer-body .note{color:var(--ink-dim);font-size:.7rem;margin:4px 0;max-width:80ch}
#textpeer-body .note b{color:var(--ink)}

/* ── FALLBACK + PRINT ONLY (the pre-map document): hidden on screen when
   the map is live; print gets the complete static record ── */
.mono{font-family:var(--data)}
.printonly{display:none}
/* scoped so it outranks the later .riggrid{display:grid} at any order */
.deck .map-fallback{display:none}
.riggrid{display:grid;grid-template-columns:minmax(0,564px) minmax(0,1fr);gap:22px;align-items:start}
svg.flow{display:block;width:100%;height:auto;max-width:564px;margin:0 auto;font:12px/1 var(--ui)}
.device rect{fill:var(--sunk);stroke:var(--line2);stroke-width:1.2}
.device.opaque rect{stroke-dasharray:4 3}
.device text.nm{fill:var(--ink);font-weight:620;font-size:12.5px}
.device text.rl{fill:var(--muted);font-size:9.5px}
.device text.ico{font-size:15px;fill:var(--muted)}
.heard{fill:var(--ok)} .unheard{fill:var(--bad)}
.cable path{fill:none;stroke-linecap:round;opacity:.8;stroke-width:1.7}
.cable.audio path{stroke:var(--audio);stroke-width:2}
.cable.midi path{stroke:var(--midi);stroke-dasharray:6 5}
.cable.midi.timing path{stroke:var(--timing);stroke-dasharray:2 5}
.cable.footswitch path{stroke:var(--fsw);stroke-dasharray:2 4}
.cable.governed path{stroke:var(--governed)}
.cable.planned path{opacity:.3}
.tip-audio{fill:var(--audio)} .tip-midi{fill:var(--midi)} .tip-timing{fill:var(--timing)} .tip-fsw{fill:var(--fsw)}
.dev{padding:10px 13px;border-top:1px solid var(--line)}
.dev:first-child{border-top:0}
.dev .top{display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
.dev .roles{color:var(--faint);font-size:11.5px}
.dev details summary{color:var(--faint);font-size:11.5px;cursor:pointer}
.dev .notefull{color:var(--faint);font-size:11.5px;margin-top:5px}
.conns{margin-top:7px;display:flex;flex-direction:column;gap:4px}
.conn{font-size:12.5px;color:var(--muted);display:flex;gap:8px;align-items:baseline}
.conn .ar{font-family:var(--data);color:var(--faint);flex:none;width:2.2em}
.conn b{color:var(--ink);font-weight:600}
.panel{background:var(--pane)}
.checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(238px,1fr));gap:10px;margin-bottom:16px}
.check{padding:11px 13px;background:var(--pane);border-left:3px solid var(--ok)}
.check.attn{border-left-color:var(--warn)}
.check .verdict{font-size:10.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--ok)}
.check.attn .verdict{color:var(--warn)}
.check .q{font-weight:600;margin:3px 0 4px;font-size:13.5px}
.check .d{color:var(--muted);font-size:12.5px}
.finding{display:flex;gap:11px;padding:10px 13px;border-top:1px solid var(--line);align-items:flex-start}
.finding:first-child{border-top:0}
.sev{flex:none;font-family:var(--data);font-size:10px;font-weight:700;letter-spacing:.06em;padding:2.5px 7px}
.sev.error{background:color-mix(in srgb,var(--bad) 17%,transparent);color:var(--bad)}
.sev.warning{background:color-mix(in srgb,var(--warn) 17%,transparent);color:var(--warn)}
.sev.info{background:color-mix(in srgb,var(--muted) 17%,transparent);color:var(--muted)}
.finding .msg{font-size:13px}
.finding .where{color:var(--faint);font-size:11.5px;font-family:var(--data);margin-top:2px}
.shead h2{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.shead .q{color:var(--faint);font-size:12.5px}
h3{font-size:15px;margin:0 0 2px;font-weight:620}
.sub{color:var(--muted);font-size:.7rem}
.note{color:var(--muted);font-size:12.5px;max-width:74ch}
.note b{color:var(--ink)}
.pos{font-family:var(--data);color:var(--faint)}
.title{font-weight:620}
.where{font-family:var(--data);font-size:.72rem}
a{color:inherit}
@media (prefers-reduced-motion:no-preference){
  .rcnode{transition:transform .18s ease}
  .slot,tr.song{transition:opacity .16s ease,background-color .16s ease}
}
@media print{
  body{background:var(--paper);overflow:visible;color:var(--pad-ink)}
  body::before,body::after{display:none}
  .wrap{height:auto;display:block;padding:0}
  .content{position:static}
  .deck{display:block;position:static;pointer-events:auto}
  .deck.on#deck-set{display:block}
  .mapwrap{display:none!important}
  .printonly,.deck .map-fallback{display:block}
  .deck .riggrid.map-fallback{display:grid}
  .songscroll,.tasks,.packs{max-height:none;overflow:visible}
  .rc-inspect,.flowtoggle,.sysinfo{display:none}
  .textpeer>button{display:none}
  #textpeer-body pre.text{max-height:none;overflow:visible}
  .shellbar .tabs,.shellbar .kbd,.chipbar{display:none}
}

`;

// ─── script ─────────────────────────────────────────────────────────────────

/**
 * The only client-side code on the page: select a song to light its slots,
 * select a device to light its cables. Everything readable is already in the
 * DOM, so with scripting off the page loses highlighting and nothing else.
 *
 * Split in two so the HTTP host can reuse it: `CONSOLE_INTERACTION_JS` is the
 * raw statement body (the host's `/assets/app.js` wraps it in a function it
 * calls again after every panel refresh, since CSP forbids eval), and the
 * generated file embeds it as the self-running IIFE it always was.
 */
const JS_BODY = `
  var packs=document.getElementById('packs'), flow=document.getElementById('flow');
  var songRows=[].slice.call(document.querySelectorAll('tr.song'));
  var devRows=[].slice.call(document.querySelectorAll('.dev'));
  var live=document.getElementById('live');

  var desc=document.getElementById('rc-desc');
  var descIdle=desc?desc.innerHTML:'';
  var voicesT=document.getElementById('rc-voices');
  function voiceShow(key){
    if(!voicesT)return;
    [].forEach.call(voicesT.querySelectorAll('tbody.voi'),function(b){
      b.classList.toggle('on', key ? b.getAttribute('data-song')===key : b.classList.contains('idle'));
    });
  }
  function clearSongs(){
    songRows.forEach(function(r){r.classList.remove('sel');r.setAttribute('aria-pressed','false');});
    if(packs){packs.classList.remove('filtered');
      [].forEach.call(packs.querySelectorAll('.slot.hit'),function(s){s.classList.remove('hit');});}
    if(desc)desc.innerHTML=descIdle;
    voiceShow(null);
  }
  function selectSong(row){
    var on=row.classList.contains('sel');
    clearSongs();
    if(on){say('Selection cleared. All slots shown.');return;}
    row.classList.add('sel');row.setAttribute('aria-pressed','true');
    var keys=(row.dataset.slots||'').split(',').filter(Boolean);
    if(packs&&keys.length){packs.classList.add('filtered');
      keys.forEach(function(k){var el=packs.querySelector('[data-slot="'+k+'"]');if(el)el.classList.add('hit');});}
    if(desc)desc.textContent=row.dataset.say||'';
    voiceShow(row.dataset.songkey||null);
    say(row.dataset.say||'');
  }
  songRows.forEach(function(r){
    r.addEventListener('click',function(){selectSong(r);});
    r.addEventListener('keydown',function(e){
      if(e.key==='Enter'||e.key===' '){e.preventDefault();selectSong(r);}
      if(e.key==='Escape'){clearSongs();say('Selection cleared.');}
    });
  });

  function clearDevices(){
    if(flow){flow.classList.remove('filtered');
      [].forEach.call(flow.querySelectorAll('.lit,.sel,.near'),function(el){el.classList.remove('lit','sel','near');});}
    devRows.forEach(function(d){d.classList.remove('sel');});
  }
  function selectDevice(id){
    if(!flow)return;
    var g=flow.querySelector('[data-device="'+id+'"]');
    var already=g&&g.classList.contains('sel');
    clearDevices();
    if(already){say('Selection cleared. All cables shown.');return;}
    flow.classList.add('filtered');
    if(g)g.classList.add('sel');
    var n=0;
    [].forEach.call(flow.querySelectorAll('.cable'),function(c){
      if(c.dataset.from===id||c.dataset.to===id){
        c.classList.add('lit');n++;
        var other=c.dataset.from===id?c.dataset.to:c.dataset.from;
        var og=flow.querySelector('[data-device="'+other+'"]');if(og)og.classList.add('near');
      }
    });
    var row=document.querySelector('.dev[data-device="'+id+'"]');
    if(row){row.classList.add('sel');}
    say((row?row.dataset.name:id)+': '+n+' cables highlighted.');
  }
  [].forEach.call(document.querySelectorAll('[data-device]'),function(el){
    el.addEventListener('click',function(){selectDevice(el.dataset.device);});
    el.addEventListener('keydown',function(e){
      if(e.key==='Enter'||e.key===' '){e.preventDefault();selectDevice(el.dataset.device);}
      if(e.key==='Escape'){clearDevices();say('Selection cleared.');}
    });
  });

  // ── pad inspect (Packs page): click a used pad, read the ph/body detail
  // built from the pad's own server-rendered tooltip lines — no second copy
  // of the data, the hover title stays the print/text fallback ──
  var padinsp=document.getElementById('rc-padinspect');
  function clearPad(){
    if(padinsp){padinsp.classList.remove('on');padinsp.innerHTML='';}
    if(packs)[].forEach.call(packs.querySelectorAll('.slot.sel'),function(s){s.classList.remove('sel');});
  }
  if(packs&&padinsp)[].forEach.call(packs.querySelectorAll('.slot.used'),function(s){
    s.setAttribute('tabindex','0');s.setAttribute('role','button');
    function go(){
      var on=s.classList.contains('sel');
      clearPad();
      if(on){say('Pad detail closed.');return;}
      s.classList.add('sel');
      var loc=(s.getAttribute('data-slot')||'').split(':');
      var name=s.getAttribute('data-name')||'';
      // the labeled amber ledger (the Voices .rew grammar): one row per
      // recorded fact, no tooltip re-parsing
      padinsp.innerHTML='<div class="ph"></div><div class="body"><h3></h3><table class="rew"><tbody></tbody></table></div>';
      padinsp.querySelector('.ph').textContent='P'+loc[0]+' \\u00b7 '+loc[1];
      padinsp.querySelector('h3').textContent=name;
      var tb=padinsp.querySelector('tbody');
      [['Song','data-song'],['Kind','data-kind'],['Pad colour','data-colour'],
       ['Tempo','data-bpm'],['Flags','data-flags']].forEach(function(f){
        var v=s.getAttribute(f[1]);
        if(!v)return;
        var tr=document.createElement('tr');
        var k=document.createElement('td');k.className='k';k.textContent=f[0];
        var val=document.createElement('td');val.textContent=v;
        tr.appendChild(k);tr.appendChild(val);tb.appendChild(tr);
      });
      padinsp.classList.add('on');
      say('Pack '+loc[0]+' project '+loc[1]+': '+name);
    }
    s.addEventListener('click',go);
    s.addEventListener('keydown',function(e){
      if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}
    });
  });

  function say(m){if(live)live.textContent=m;}
  // The old "Show everything" reset button is gone (owner, 2026-08-24
  // dogfood): Escape already clears every selection, and the map keeps one
  // item inspected at all times by design, so a global reset had no job.
  document.addEventListener('keydown',function(e){if(e.key==='Escape'){clearSongs();clearDevices();clearPad();}});

  // ── the text peer bar: toggled open, or revealed by find-in-page ──
  var tpB=document.getElementById('textpeer-toggle'),tpD=document.getElementById('textpeer-body');
  if(tpB&&tpD){
    tpB.addEventListener('click',function(){
      var opening=tpD.hasAttribute('hidden');
      if(opening){tpD.removeAttribute('hidden');}else{tpD.setAttribute('hidden','until-found');}
      tpB.setAttribute('aria-expanded',String(opening));
    });
    tpD.addEventListener('beforematch',function(){tpB.setAttribute('aria-expanded','true');});
  }

  // ── paged shell (Phase B): decks behind tabs, [ ] traversal ──
  // Active page rides <html data-rc-page> so it SURVIVES the host's
  // innerHTML refresh of #rc-root (wireConsole re-runs and re-applies).
  var tabs=[].slice.call(document.querySelectorAll('.tab[data-deck]'));
  function setPage(p){
    if(!document.getElementById('deck-'+p))return;
    document.documentElement.setAttribute('data-rc-page',p);
    tabs.forEach(function(t){t.setAttribute('aria-selected',String(t.getAttribute('data-deck')===p));});
    [].slice.call(document.querySelectorAll('.deck')).forEach(function(d){d.classList.toggle('on',d.id==='deck-'+p);});
    var loc=document.getElementById('rc-loc');
    if(loc){var a=tabs.filter(function(t){return t.getAttribute('data-deck')===p;})[0];if(a)loc.textContent=a.textContent;}
  }
  tabs.forEach(function(t){t.addEventListener('click',function(){setPage(t.getAttribute('data-deck'));});});
  if(tabs.length){
    document.addEventListener('keydown',function(e){
      if(e.key!=='['&&e.key!==']')return;
      var cur=document.documentElement.getAttribute('data-rc-page')||'rig';
      var order=tabs.map(function(t){return t.getAttribute('data-deck');});
      var i=order.indexOf(cur);if(i===-1)i=0;
      setPage(order[(i+(e.key===']'?1:order.length-1))%order.length]);
    });
    setPage(document.documentElement.getAttribute('data-rc-page')||'rig');
  }
`;

const JS = `
(function(){${JS_BODY}})();
(function(){${CONSOLE_MAP_JS}})();
`;

/** The stylesheet, as a servable static asset. Constant and information-free. */
export const CONSOLE_CSS = CSS;

/**
 * The interaction wiring as a raw statement body (no IIFE), so a host page can
 * wrap it in a named function and re-run it after re-injecting panel content
 * (CSP forbids eval, so it must ship inside the static asset). It queries the
 * DOM fresh on every run; element listeners land on freshly-injected nodes.
 * The ONE document-level listener (Escape) is the caller's to de-duplicate:
 * add it once, or re-run only over injected content.
 */
export const CONSOLE_INTERACTION_JS = JS_BODY;

// ─── panels ─────────────────────────────────────────────────────────────────

/** The bottom-left system/summary/status corner (was the top source chips). */
function sysInfo(sources: SourceStatus[]): string {
  // Compact standardized labels (the SourceStatus label prose ran long) and
  // ISO timestamps squeezed to minute precision: the corner is a readout,
  // not a log line.
  const SHORT: Record<string, string> = { rig: 'Rig manifest', card: 'Card capture', setlist: 'Setlist' };
  const tidy = (d: string): string => d.replace(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}(?:\.\d+)?Z?/g, '$1 $2');
  return `<div class="sysinfo" id="rc-sysinfo">${sources.map((s) =>
    `<div class="si ${s.state === 'loaded' ? '' : s.state}">` +
    `<b>${esc(SHORT[s.id] ?? s.label)}</b><span>${esc(tidy(s.state === 'loaded' ? s.detail : `${s.state}: ${s.detail}`))}</span></div>`).join('')}</div>`;
}

function checksPanel(view: RigView): string {
  return `<div class="checks">${view.checks.map((c) =>
    `<div class="check${c.ok ? '' : ' attn'}">` +
    `<div class="verdict">${c.ok ? 'Pass' : 'Needs attention'}</div>` +
    `<div class="q">${esc(c.question)}</div><div class="d">${esc(c.detail)}</div></div>`).join('')}</div>`;
}

function findingsPanel(view: RigView): string {
  if (view.findings.length === 0) {
    return `<div class="panel"><div class="finding"><span class="sev info">clear</span>` +
      `<div class="msg">Every check passed. Nothing needs attention.</div></div></div>`;
  }
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...view.findings].sort((a, b) => order[a.severity] - order[b.severity]);
  return `<div class="panel">${sorted.map((f) =>
    `<div class="finding"><span class="sev ${f.severity}">${f.severity}</span>` +
    `<div><div class="msg">${esc(f.message)}</div>` +
    `<div class="where">${esc(f.source)} · ${esc(f.code)}${f.ref ? ` · ${esc(f.ref)}` : ''}</div></div></div>`).join('')}</div>`;
}

function deviceList(view: RigView): string {
  const byId = new Map(view.links.map((l) => [l.id, l]));
  // Phase B: the list shares the diagram's signal-priority order (one
  // comparator, `signalOrder`) — reading down the list IS reading down the
  // chain, and the two panels can never disagree about what comes first.
  const rows = signalOrder(view.devices).map((d) => {
    const conn = (id: string, dir: 'out' | 'in'): string => {
      const l = byId.get(id);
      if (l === undefined) return '';
      const other = dir === 'out' ? l.to : l.from;
      const mine = dir === 'out' ? l.from : l.to;
      const tags = [
        `<span class="tag ${l.timing ? 'timing' : l.kind}">${esc(l.timing ? 'timing' : l.kind)}</span>`,
        l.governed ? `<span class="tag governed">governed</span>` : '',
        l.enabled ? '' : `<span class="tag planned">planned</span>`,
      ].filter(Boolean).join('');
      return `<div class="conn"><span class="ar">${dir === 'out' ? 'out' : 'in'}</span>` +
        `<span>${tags} <b>${esc(other.node_name)}</b> · ${esc(l.label)} ` +
        `<span style="color:var(--faint)">(${esc(mine.port_label)} &rarr; ${esc(other.port_label)})</span></span></div>`;
    };
    const badges = [
      d.opaque ? `<span class="tag">opaque</span>` : '',
      d.audio_status === 'reaches_output' ? `<span class="tag ok">heard</span>` : '',
      d.audio_status === 'no_output' || d.audio_status === 'dead_end' ? `<span class="tag bad">not heard</span>` : '',
      d.free_ports > 0 ? `<span class="tag">${d.free_ports} free</span>` : '',
    ].filter(Boolean).join(' ');
    return `<div class="dev" data-device="${esc(d.id)}" data-name="${esc(d.name)}" tabindex="0" role="button">` +
      `<div class="top"><h3>${esc(d.name)}</h3>${badges}</div>` +
      `<div class="roles">${esc(d.roles.join(' · '))}${d.extra_roles.length > 0 ? ` · ${esc(d.extra_roles.join(' · '))}` : ''}</div>` +
      // A short note reads as a label; a long one needs to fold, or it buries
      // the connection list under 800 characters of settings provenance.
      (d.note === undefined ? ''
        : d.note.length <= 140
          ? `<div class="notefull">${esc(d.note)}</div>`
          : `<details><summary>${esc(d.note)}</summary></details>`) +
      `<div class="conns">${[...d.sends.map((i) => conn(i, 'out')), ...d.receives.map((i) => conn(i, 'in'))].join('')}</div>` +
      `</div>`;
  }).join('');
  return `<div class="panel dlist">${rows}</div>`;
}

// Swatches MUST match path.rcw styling exactly (solid gold = clock, solid
// cyan = notes/PC/CC, dashed gold = governed, dotted = footswitch): a
// legend that disagrees with the wires is worse than none.
const LEGEND = `<div class="legend">
<span class="lg"><span class="sw" style="border-color:var(--timing)"></span> MIDI clock &amp; transport</span>
<span class="lg"><span class="sw" style="border-color:var(--wire-midi)"></span> MIDI notes, PC, CC</span>
<span class="lg"><span class="sw" style="border-color:var(--audio);border-top-width:3px"></span> audio</span>
<span class="lg"><span class="sw" style="border-color:var(--warn);border-top-style:dashed"></span> governed binding</span>
<span class="lg"><span class="sw" style="border-color:var(--wire-fsw);border-top-style:dotted"></span> footswitch</span>
<span class="lg"><span style="width:8px;height:8px;background:var(--ok);display:inline-block"></span> heard at front of house</span>
</div>`;

/**
 * The Songs page in the mockup's two-column grammar (RIG-CONSOLE-MOCKUP-
 * REFERENCE.html): LEFT a solid-bar-headed song list scrolling inside its
 * own layer, then the selected song's say-line (.desc); RIGHT the gold
 * staging panel (what the card does not hold yet) and the numbers cluster.
 * The doctrine paragraphs (two-owners note, drift headline) have no screen
 * home in the design — they ride print + the text peer (`notes`), while the
 * drift itself stays visible as row tags and open staging tasks.
 */
function setPanel(join: SongJoin, card: ConsoleCard | undefined): { left: string; tasks: string; notes: string } {
  if (join.songs.length === 0) {
    return {
      left: `<div class="left"><div class="panel-h">Song List</div><div class="desc"><span class="t">` +
        `No setlist and no songs on the card. Add a markdown setlist under docs/_private/rig/setlists/ ` +
        `and back up the sequencer card to populate this.</span></div></div>`,
      tasks: '', notes: '',
    };
  }
  const row = (s: ConsoleSong): string => {
    const slotKeys = s.slots.filter((x) => x.occupied).map((x) => `${x.pack}:${x.slot}`).join(',');
    const tempo = s.tempo !== undefined ? `${s.tempo}`
      : s.tempo_disagreement !== undefined ? s.tempo_disagreement.join(' / ') : '';
    // The maintainer's own verdict, which no capture can supply. Absence is
    // shown as an explicit "not checked": an unrecorded ear-check is a real,
    // actionable state, and a blank reads as an oversight.
    const ear = s.ear_checked === undefined
      ? `<span class="tag">not checked</span>`
      : /^(y|yes|ok|good|approved|signed)/i.test(s.ear_checked)
        ? `<span class="tag ok">${esc(s.ear_checked)}</span>`
        : `<span class="tag warn">${esc(s.ear_checked)}</span>`;
    // Ready cell: a measured disagreement outranks the ear verdict (it means
    // the roster row itself is suspect); otherwise the owner's check shows.
    // A card-less song with no disagreement wears the staging tag: "not
    // checked" would be noise on a song that has nothing to hear yet.
    const status = s.disagreement === 'stale_claim'
      ? `<span class="tag warn" title="${esc(`The setlist says "${s.claim_text ?? 'no'}". The capture holds ${s.project_count} projects.`)}">setlist behind</span>`
      : s.disagreement === 'missing'
        ? `<span class="tag bad" title="${esc(`The setlist says "${s.claim_text ?? 'yes'}" and the capture holds nothing.`)}">missing</span>`
        : s.position === undefined ? `<span class="tag">not in the set</span>`
          : !s.on_card ? `<span class="tag">staging</span>` : ear;
    const alerts = s.alerts.map((m) => `<span class="tag bad">${esc(m.toLowerCase())}</span>`).join(' ');
    const say = s.on_card
      ? `${s.title}: ${s.project_count} projects, ${s.where}${tempo ? `, ${tempo} BPM` : ''}.`
      : `${s.title}: nothing on the card.`;
    // The mockup's Pack / Slots split: two SHORT mono columns (gold pack =
    // location accent) instead of one long "Pack 5 projects 35-39" cell —
    // the full sentence stays in the say-line.
    const occ = s.slots.filter((x) => x.occupied);
    const packNos = [...new Set(occ.map((x) => x.pack))];
    const packCell = packNos.map((p) => `P${p}`).join(' ');
    const slotCell = packNos.map((p) => {
      const ss = occ.filter((x) => x.pack === p).map((x) => x.slot);
      const lo = Math.min(...ss), hi = Math.max(...ss);
      return lo === hi ? `${lo}` : `${lo}-${hi}`;
    }).join(', ');
    return `<tr class="song${s.on_card ? '' : ' staged-empty'}" tabindex="0" role="button" aria-pressed="false" ` +
      `data-slots="${esc(slotKeys)}" data-say="${esc(say)}" data-songkey="${esc(songKey(s.title))}">` +
      `<td class="pos d">${s.position ?? '&mdash;'}</td>` +
      `<td><div class="title">${esc(s.title)}</div>` +
      (s.artist ? `<div class="artist">${esc(s.artist)}</div>` : '') +
      (s.position === undefined ? `<div class="artist">on the card, not in the setlist</div>` : '') + `</td>` +
      `<td class="d num">${esc(packCell)}</td>` +
      `<td class="d">${esc(slotCell)}</td>` +
      `<td>${status}${alerts ? ` ${alerts}` : ''}</td></tr>`;
  };
  // The board/staging split (menu-language staging concept), grouped by the
  // MEASURED truth only: `on_card` says the capture holds the song's
  // projects — a stale setlist claim still sits on the board (measurement
  // wins; its warn tag carries the drift). One table, two groups; the
  // columns keep one geometry across both (rule 12).
  const board = join.songs.filter((s) => s.on_card);
  // `join.unplaced` is NOT added here: every unplaced setlist row is already
  // built into `join.songs` (with on_card false), so rendering the unplaced
  // list as well drew each card-less song TWICE and double-counted the group.
  // Caught by the Phase D fixture (a staging song read "Staging · 2"); the
  // real card never showed it because all 17 set songs are placed. Card-less
  // rows get the dimmed staged-empty treatment inside row() instead.
  const staging = join.songs.filter((s) => !s.on_card);
  const grp = (label: string, n: number): string =>
    `<tr class="grp"><td colspan="5">${label} · ${n}</td></tr>`;
  const stagingCount = staging.length;
  const grouped =
    (board.length > 0 ? grp('On the board', board.length) + board.map(row).join('') : '') +
    (stagingCount > 0 ? grp('Staging', stagingCount) + staging.map(row).join('') : '');
  // The Voices panel (the mockup's gold table): per selected song, the voice
  // each instrument is set to, from the mapping registry's claims. One tbody
  // per song, toggled by selection; the idle tbody reports coverage honestly
  // (most songs have nothing filed yet — that IS the panel's message).
  const DEVICE_LABEL: Record<string, string> = {
    microfreak: 'MicroFreak', hydrasynth: 'Hydrasynth', 'circuit-tracks': 'Circuit',
    'spd-sx': 'SPD-SX', am4: 'AM4',
  };
  // A claim with no chosen preset yet (an OWED row) still says WHAT is
  // owed: the role rides the value cell dimmed, so no row ever reads as a
  // blank label (owner, 2026-08-24: "voice list labels missing").
  const voiceRows = (vs: ConsoleVoice[]): string => vs.map((v) => {
    const st = v.status === 'confirmed' ? 'ok' : v.status === 'owed' ? 'bad' : 'warn';
    const value = v.name !== undefined && v.name !== ''
      ? esc(v.name)
      : v.role !== undefined
        ? `<span class="t">${esc(v.role.length > 46 ? `${v.role.slice(0, 45)}…` : v.role)}</span>`
        : '';
    return `<tr${v.role ? ` title="${esc(v.role)}"` : ''}>` +
      `<td class="k">${esc(DEVICE_LABEL[v.device] ?? v.device)} ${esc(v.slot)}</td>` +
      `<td>${value}${v.status ? ` <span class="tag ${st}">${esc(v.status)}</span>` : ''}</td></tr>`;
  }).join('');
  const filed = join.songs.filter((s) => (s.voices?.length ?? 0) > 0).length;
  const unmatchedNote = (join.voices_unmatched?.length ?? 0) > 0
    ? ` Filed but unknown to the setlist and the capture: ${esc(join.voices_unmatched!.join(', '))} (re-capture the card / update the setlist).`
    : '';
  const voiceBodies =
    `<tbody class="voi idle on"><tr><td class="k">Coverage</td>` +
    `<td>${filed} of ${join.songs.length} songs have voices filed in song-mappings.json. Select one.${unmatchedNote}</td></tr></tbody>` +
    join.songs.map((s) => `<tbody class="voi" data-song="${esc(songKey(s.title))}">` +
      ((s.voices?.length ?? 0) > 0 ? voiceRows(s.voices!)
        : `<tr><td class="k">Not filed</td><td>No voices filed for ${esc(s.title)} yet.</td></tr>`) +
      `</tbody>`).join('');
  const left = `<div class="left">
<div class="panel-h">Song List</div>
<div class="songscroll"><table class="songs"><thead><tr>
<th>#</th><th>Song</th><th>Pack</th><th>Slots</th><th>Ready</th>
</tr></thead><tbody>${grouped}</tbody></table></div>
<div class="desc" id="rc-desc"><span class="t">Select a song — its projects light on the card page, and its trace lands here.</span></div>
<div class="voices">
<div class="panel-h gold">Voices</div>
<table class="rew" id="rc-voices">${voiceBodies}</table>
</div>
</div>`;
  // The gold staging panel: everything the card does not hold yet plus the
  // measured drift as OPEN tasks; the board rides as the one done line.
  const items = [
    board.length > 0 ? `<div class="task"><span class="box done"></span><span>${board.length} song${board.length === 1 ? '' : 's'} on the board</span></div>` : '',
    ...join.songs.filter((s) => s.disagreement !== undefined).map((s) =>
      `<div class="task open"><span class="box"></span><span>${esc(s.title)}: ${s.disagreement === 'missing' ? 'claimed built, nothing on the card' : 'setlist behind the capture'}</span></div>`),
    ...staging.map((s) => `<div class="task open"><span class="box"></span><span>${esc(s.title)}: nothing on the card</span></div>`),
    ...join.songs.flatMap((s) => s.alerts.map((a) =>
      `<div class="task open"><span class="box"></span><span>${esc(s.title)}: ${esc(a.toLowerCase())}</span></div>`)),
  ].filter(Boolean).join('');
  const tasks = `<div class="tasks"><h3>Staging · ${stagingCount === 0 ? 'clear' : stagingCount}</h3>${items}</div>`;
  // Print + text-peer prose: the drift headline and the two-owners doctrine.
  const stale = join.songs.filter((s) => s.disagreement === 'stale_claim');
  const missing = join.songs.filter((s) => s.disagreement === 'missing');
  const headline = stale.length > 0 || missing.length > 0
    ? `<p class="note"><b>The setlist and the card disagree on ${stale.length + missing.length} ` +
      `song${stale.length + missing.length === 1 ? '' : 's'}.</b> ` +
      (stale.length > 0 ? `The setlist says ${esc(stale.map((s) => s.title).join(', '))} ${stale.length === 1 ? 'is' : 'are'} not built; the capture holds projects for ${stale.length === 1 ? 'it' : 'them'}. ` : '') +
      (missing.length > 0 ? `It claims ${esc(missing.map((s) => s.title).join(', '))} built with nothing on the card. ` : '') +
      `The measurement wins; the setlist is the thing to update.</p>`
    : '';
  const unchecked = join.songs.filter((s) => s.position !== undefined && s.ear_checked === undefined).length;
  const doctrine = `<p class="note"><b>Two columns, two owners.</b> <b>Where/Proj</b> are measured from the ` +
    `${card ? `capture taken ${esc(card.captured_at.slice(0, 10))}` : 'card capture'} and nothing else: they say the projects ` +
    `exist at the slots the roster places, never that a song is finished. <b>Ready</b> is yours, and no ` +
    `script ever writes it` +
    (unchecked > 0 ? `; <b>${unchecked} of ${join.songs.filter((s) => s.position !== undefined).length} are still unchecked</b>` : '') +
    `. They are split because conflating them is what made this rig's old hand-kept "Built?" column wrong ` +
    `on ten of seventeen rows. Run <code>npm run setlist-sync</code> to refresh the measured half.</p>`;
  const notes = `<div class="printonly">${headline}${doctrine}` +
    (join.unplaced.length > 0
      ? `<p class="note"><b>${join.unplaced.length} setlist ${join.unplaced.length === 1 ? 'song has' : 'songs have'} nothing on the card:</b> ` +
        `${esc(join.unplaced.map((e) => e.title).join(', '))}.</p>`
      : '') + `</div>`;
  return { left, tasks, notes };
}

function cardPanel(card: ConsoleCard | undefined): string {
  if (card === undefined) {
    return `<div class="panel"><div class="finding"><span class="sev info">empty</span><div class="msg">` +
      `No card capture found. Back up the sequencer card to <code>samples/circuit-ncs/card-backup-*</code> to fill this in.` +
      `</div></div></div>`;
  }
  const packs = card.packs.map((p) => {
    const slots = p.slots.map((s) => {
      // The pad is painted in the colour the DEVICE stores for that project, so
      // the grid on screen matches the grid under your hands. Category is not
      // dropped: it stays in the tooltip and in the text rendering, and the
      // legend explains what the colours are.
      const hex = s.occupied && s.colour_index !== undefined ? PROJECT_COLOUR_HEX[s.colour_index] : undefined;
      const badColour = s.occupied && s.colour_index !== undefined && hex === undefined;
      const cls = ['slot', s.occupied ? 'used' : '',
        s.markers.some((m) => m === 'CORRUPT' || m === 'NAME MISMATCH' || m === 'NOT IN THE CAPTURE') || badColour ? 'flag' : ''].filter(Boolean).join(' ');
      const style = hex !== undefined ? ` style="--pad:${hex}"` : '';
      const title = s.occupied
        ? `Pack ${p.pack} project ${s.slot}: ${s.name ?? 'unnamed'}` +
          (s.song ? `\n${s.song}${s.part ? ` (${s.part})` : ''}` : '') +
          (s.kind ? `\n${SLOT_KIND_LABEL[s.kind] ?? s.kind}` : '') +
          (s.colour !== undefined ? `\npad colour: ${s.colour}`
            : badColour ? `\npad colour: index ${s.colour_index}, outside the 14-colour palette` : '') +
          (s.tempo_post_capture !== undefined ? `\n${s.tempo_post_capture} BPM (written after the capture)`
            : s.tempo !== undefined ? `\n${s.tempo} BPM` : '') +
          (s.markers.length > 0 ? `\n${s.markers.join(', ')}` : '')
        : `Pack ${p.pack} project ${s.slot}: free`;
      // Structured fields ride data attributes so the pad detail renders a
      // LABELED amber ledger (same .rew grammar as Voices) instead of
      // re-parsing the tooltip prose; the title stays for hover + print.
      const bpmText = s.tempo_post_capture !== undefined
        ? `${s.tempo_post_capture} BPM (written after the capture)`
        : s.tempo !== undefined ? `${s.tempo} BPM` : '';
      const data = s.occupied
        ? ` data-name="${esc(s.name ?? 'unnamed')}"` +
          (s.song ? ` data-song="${esc(`${s.song}${s.part ? ` (${s.part})` : ''}`)}"` : '') +
          (s.kind ? ` data-kind="${esc(SLOT_KIND_LABEL[s.kind] ?? s.kind)}"` : '') +
          (s.colour !== undefined ? ` data-colour="${esc(s.colour)}"`
            : badColour ? ` data-colour="index ${s.colour_index}, outside the palette"` : '') +
          (bpmText !== '' ? ` data-bpm="${esc(bpmText)}"` : '') +
          (s.markers.length > 0 ? ` data-flags="${esc(s.markers.join(', '))}"` : '')
        : '';
      return `<div class="slot ${cls}"${style} data-slot="${p.pack}:${s.slot}"${data} title="${esc(title)}">${s.slot}</div>`;
    }).join('');
    const runs = p.free_runs.filter((r) => r.to - r.from >= 2)
      .sort((a, b) => (b.to - b.from) - (a.to - a.from)).slice(0, 3)
      .map((r) => `${r.from}-${r.to} (${r.to - r.from + 1})`).join(', ');
    return `<div class="panel pack"><div class="ph"><span class="pn">Pack ${p.pack}</span>` +
      `<span class="pc">${p.occupied}/${p.slots.length} used</span></div>` +
      `<div class="pc" style="margin:-7px 0 10px">${esc(p.name)}</div>` +
      `<div class="grid">${slots}</div>` +
      (runs !== '' ? `<div class="runs">room for a whole song: ${esc(runs)}</div>` : '') +
      `</div>`;
  }).join('');
  const used = card.packs.flatMap((p) => p.slots).filter((s) => s.occupied);
  const seen = [...new Set(used.map((s) => s.colour_index).filter((i): i is number => i !== undefined && PROJECT_COLOUR_HEX[i] !== undefined))]
    .sort((a, b) => a - b);
  const swatches = seen.map((i) =>
    `<span class="lg"><span class="slot used" style="--pad:${PROJECT_COLOUR_HEX[i]};width:13px;height:13px;aspect-ratio:auto;border-radius:3px"></span> ${esc(PROJECT_COLOURS_NAME(i))}</span>`).join('');
  // Mockup grammar: one solid header bar, the grids scrolling inside their
  // own layer, the colour key as fine print beneath. The prose explaining
  // WHY the pads wear device colours has no screen home in the design; it
  // rides print + the text peer.
  const key = `<div class="legend">${swatches}` +
    `<span class="lg"><span class="slot" style="width:13px;height:13px;aspect-ratio:auto;border-radius:3px"></span> free</span>` +
    `<span class="lg"><span class="slot used flag" style="--pad:var(--scratch);width:13px;height:13px;aspect-ratio:auto;border-radius:3px"></span> needs a look</span></div>`;
  const prose = `<p class="note"><b>Each pad wears the colour the device stores for that project</b>, read from the
    project file, so this grid matches the Projects view under your hands. On this card the colour is
    per song: ${esc(sampleSongColours(used))}. What each project IS stays in its tooltip and in the text
    rendering below.</p>`;
  return `<div class="cardcol"><div class="panel-h">The Card — ${card.totals.occupied}/${card.totals.slots}</div>` +
    `<div class="packs" id="packs">${packs}</div>${key}<div class="printonly">${prose}</div></div>`;
}

// ─── text rendering (the accessibility peer view) ───────────────────────────

function renderSetText(join: SongJoin): string {
  const out: string[] = ['', 'The set', '======='];
  for (const s of join.songs) {
    const pos = s.position !== undefined ? `${s.position}.` : '  (not in the setlist)';
    out.push(`${pos} ${s.title}${s.artist ? ` (${s.artist})` : ''}`);
    out.push(s.on_card
      ? `     on the card: ${s.project_count} project${s.project_count === 1 ? '' : 's'} at ${s.where}` +
        (s.tempo !== undefined ? `, ${s.tempo} BPM` : s.tempo_disagreement ? `, tempos disagree: ${s.tempo_disagreement.join(' / ')}` : '')
      : '     nothing on the card');
    if (s.disagreement === 'stale_claim') out.push(`     DISAGREEMENT: the setlist says "${s.claim_text ?? 'no'}" and the capture holds ${s.project_count} projects. The setlist is behind.`);
    if (s.disagreement === 'missing') out.push(`     DISAGREEMENT: the setlist says "${s.claim_text ?? 'yes'}" and the capture holds nothing.`);
    for (const v of s.voices ?? []) {
      out.push(`     voice: ${v.device} ${v.slot}${v.name ? ` "${v.name}"` : ''}${v.status ? ` (${v.status})` : ''}${v.role ? ` — ${v.role}` : ''}`);
    }
    for (const a of s.alerts) out.push(`     ATTENTION: ${a}`);
    for (const h of s.hazards) out.push(`     hazard: ${h}`);
  }
  if (join.unplaced.length > 0) out.push('', `Setlist songs with nothing on the card: ${join.unplaced.map((e) => e.title).join(', ')}`);
  if (join.not_in_setlist.length > 0) out.push(`On the card but not in the setlist: ${join.not_in_setlist.join(', ')}`);
  return out.join('\n');
}

function renderCardText(card: ConsoleCard | undefined): string {
  if (card === undefined) return '\nThe card\n========\nNo capture found.';
  const out: string[] = ['', 'The card', '========',
    `Captured ${card.captured_at}. ${card.totals.occupied} of ${card.totals.slots} projects occupied.`];
  for (const p of card.packs) {
    out.push('', `Pack ${p.pack} "${p.name}": ${p.occupied} used, ${p.free} free`);
    for (const s of p.slots) {
      if (!s.occupied) continue;
      const bpm = s.tempo_post_capture ?? s.tempo;
      const colour = s.colour !== undefined ? `  pad ${s.colour}`
        : s.colour_index !== undefined ? `  pad colour index ${s.colour_index} (outside the palette)` : '';
      out.push(`  ${String(s.slot).padStart(2)}  ${(s.name ?? 'unnamed').padEnd(17)}` +
        `${s.song ? `${s.song}${s.part ? ` (${s.part})` : ''}` : (s.what ?? '')}`.trimEnd() +
        (bpm !== undefined ? `  [${bpm} BPM]` : '') + colour +
        (s.markers.length > 0 ? `  ${s.markers.join(', ')}` : ''));
    }
    const runs = p.free_runs.filter((r) => r.to - r.from >= 2).map((r) => `${r.from}-${r.to}`).join(', ');
    if (runs !== '') out.push(`  free runs: ${runs}`);
  }
  return out.join('\n');
}

// ─── document ───────────────────────────────────────────────────────────────

export interface RenderInput {
  view?: RigView;
  card?: ConsoleCard;
  join: SongJoin;
  sources: SourceStatus[];
  generatedAt: string;
  command: string;
}

/**
 * The data-bearing content of the console: everything between `<body>` and the
 * interaction script, as one `<div class="wrap">` fragment. The HTTP host
 * serves THIS (bearer-authenticated) and injects it into a constant shell;
 * `renderConsole` wraps the same fragment into the self-contained file.
 */
export function renderConsoleBody(input: RenderInput): { title: string; body: string } {
  const { view, card, join, sources, generatedAt, command } = input;
  const diagram = view !== undefined ? renderDiagram(view) : undefined;
  const title = view?.name ?? 'Rig Console';

  const text = [
    view !== undefined ? renderRigText(view) : 'The rig\n=======\nNo rig manifest found.',
    renderSetText(join),
    renderCardText(card),
  ].join('\n');

  const sp = setPanel(join, card);
  // The numbers cluster (mockup .cluster, bottom-right of the Songs page):
  // label left, mono value right, capture date in glowing gold.
  const cluster = [
    view !== undefined ? ['Devices', `${view.counts.devices}`, false] : undefined,
    view !== undefined ? ['Cables', `${view.counts.links}`, false] : undefined,
    view !== undefined ? ['Free jacks', `${view.counts.free_ports}`, false] : undefined,
    ['In the set', `${join.songs.filter((s) => s.position !== undefined).length}`, false],
    card !== undefined ? ['Projects', `${card.totals.occupied} / ${card.totals.slots}`, false] : undefined,
    card !== undefined ? ['Captured', card.captured_at.slice(0, 10), true] : undefined,
  ].filter((x): x is [string, string, boolean] => x !== undefined)
    .map(([k, v, gold]) => `<div><span class="k">${esc(k)}</span><span class="v${gold ? ' gold' : ''}">${esc(v)}</span></div>`).join('');

  // On screen the Rig page IS the map (the mockup's whole-page subject);
  // the checks grid and findings list have no screen home in the design
  // and ride print + the text peer. The riggrid (static diagram + device
  // list) stays in the DOM as the no-JS fallback and the print rendering —
  // the map JS classes it away when the live map takes over, and the
  // inspect panel projects device detail FROM its .dlist.
  const rigSection = view !== undefined
    ? `<section id="rig" aria-labelledby="rig-h">
  <div class="printonly"><div class="shead"><h2 id="rig-h">The rig</h2><span class="q">What is cabled to what, and what fails a check</span></div>
  ${checksPanel(view)}
  ${findingsPanel(view)}</div>
  <div class="riggrid" style="margin-top:20px">
    <div class="rigleft"><div class="panel stage">${diagram!.svg.replace('<svg ', '<svg class="flow" id="flow" ')}</div>${LEGEND}</div>
    ${deviceList(view)}
  </div>
</section>`
    : `<section id="rig" aria-labelledby="rig-h">
  <div class="shead"><h2 id="rig-h">The rig</h2><span class="q">What is cabled to what</span></div>
  <div class="panel"><div class="finding"><span class="sev info">empty</span><div class="msg">
  No rig manifest found. Point <code>MCP_RIG_MANIFEST</code> at a rig.json, or create one with <code>edit_rig</code>.
  </div></div></div>
</section>`;

  // Phase B shell: places in the top strip (stamp = identity + amber
  // location; tabs bracketed by their traversal keys; source chips as the
  // persistent top-right state), one deck visible at a time, verbs + vitals
  // in the sticky foot. The TEXT peer view deliberately stays OUTSIDE the
  // decks: its charter is "always in the DOM, findable with Ctrl+F", and a
  // hidden deck is not findable.
  const body = `<div class="wrap">
<div class="shellbar">
  <div class="stamp"><b>${esc(title)}</b><span class="loc" id="rc-loc">Rig</span></div>
  <div class="tabs" role="tablist" aria-label="Console pages">
    <span class="kbd" aria-hidden="true">[</span>
    <button class="tab" role="tab" data-deck="rig" aria-selected="true" type="button">Rig</button>
    <button class="tab" role="tab" data-deck="set" aria-selected="false" type="button">Songs</button>
    <button class="tab" role="tab" data-deck="card" aria-selected="false" type="button">Packs</button>
    <span class="kbd" aria-hidden="true">]</span>
  </div>
</div>

<div class="content">
  ${sysInfo(sources)}
  <div class="mapwrap">
    <div class="flowtoggle" role="group" aria-label="Flow view">
      <button type="button" data-flow="audio" aria-pressed="true">Audio flow</button>
      <button type="button" data-flow="midi" aria-pressed="false">MIDI flow</button>
    </div>
    <div id="rc-maphost"></div>
    <div class="rc-inspect" id="rc-inspect" aria-live="polite"></div>
    ${LEGEND}
  </div>
  ${view !== undefined ? `<script type="application/json" id="rc-map">${JSON.stringify(mapModel(view)).replace(/</g, '\\u003c')}</script>` : ''}

  <div class="deck on" id="deck-rig" role="tabpanel">
${rigSection}
  </div>

  <div class="deck" id="deck-set" role="tabpanel" aria-label="The set">
${sp.left}
<div class="right">${sp.tasks}<div class="cluster">${cluster}</div></div>
${sp.notes}
  </div>

  <div class="deck" id="deck-card" role="tabpanel" aria-label="The card">
<div class="printonly"><div class="shead"><h2 id="card-h">The card</h2><span class="q">All ${card ? card.totals.slots : 320} sequencer projects, laid out the way the device lays them out</span></div></div>
${cardPanel(card)}
<div class="padinspect" id="rc-padinspect" aria-live="polite"></div>
  </div>
</div>

<section class="textpeer" id="text" aria-labelledby="textpeer-toggle">
  <button id="textpeer-toggle" type="button" aria-expanded="false">Everything as text — the same answers, findable end to end (Ctrl+F reaches inside)</button>
  <div id="textpeer-body" hidden="until-found">
    <p class="note">A peer view of the three panels, not a summary: what connects to what, on which channel,
    what fails a check, where every song lives, and what is in every occupied slot.</p>
    <pre class="text">${esc(text)}</pre>
    <p class="note">Generated by <code>${esc(command)}</code> on ${esc(generatedAt)}. Nothing here is live: the rig comes from
    the manifest, the card from the last backup, the set from the setlist file. Re-run after any of them changes.</p>
  </div>
</section>

<div class="chipbar">
  <span class="kbd" aria-hidden="true">[ ]</span><span class="sub">page</span>
  <span class="kbd" aria-hidden="true">Esc</span><span class="sub">clear</span>
  <span id="live" aria-live="polite" class="sub"></span>
</div>
</div>`;
  return { title, body };
}

export function renderConsole(input: RenderInput): string {
  const { title, body } = renderConsoleBody(input);
  // The self-contained file embeds the faces as data URIs so file:// shows
  // the SAME typography as the hosted app (the hosted page loads them via
  // its own /assets/fonts route instead; CONSOLE_CSS stays lean for it).
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${FONT_FACE_DATA_CSS}${CSS}</style>
</head>
<body>
${body}
<script>${JS}</script>
</body>
</html>
`;
}
