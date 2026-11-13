/**
 * map.ts — the living map (Phase C1+C2): the Rig page's full-bleed,
 * client-rendered connection map in the overlay design language
 * (docs/design/RIG-CONSOLE-MENU-LANGUAGE.md).
 *
 * PROGRESSIVE ENHANCEMENT, NEVER A FORK. The server-rendered gutter-lane
 * diagram + device list stay in the document as the no-JS/print fallback;
 * this script builds the map from the embedded JSON model (`#rc-map`) and
 * hides the fallback. The inspect panel projects the SERVER-RENDERED
 * device detail (cloned from the hidden list) so device facts render once,
 * from one code path.
 *
 * THE FLOW TOGGLE (rule 38, owner-accepted): AUDIO is the default view —
 * a tree rooted at the audio hub (the box the performance terminates in),
 * feeders descending by hop depth, exactly the owner's reference-tree
 * orientation; MIDI is the band layout (rule 34: note-receivers center
 * under the clock master, routers + timing-only devices flank). Each view
 * has its OWN deterministic layout computed from its OWN edges; devices
 * ANIMATE between homes (<200 ms, reduced-motion respected); the
 * non-focused flow GHOSTS at low opacity and never drives layout; devices
 * with no edge in the focused flow hide (the space tells the truth).
 *
 * Wire grammar is rule 35 v4 (cable-tray): conduit corridor routing.
 * Horizontal runs live only in the corridors between bands; FOCUSED
 * wires own each box side's centred port fan (ghosts take outer slots);
 * a fan's edges form an ATOMIC BUNDLE on adjacent lanes ordered like the
 * port fan; ONE pitch spaces ports and lanes alike; corners are true
 * SVG arcs with radius RAD + laneDepth×PITCH — concentric quarter-turns
 * whose gap never changes. The 2026-08-24 library research (D3/elkjs/
 * libavoid/dagre/X6) concluded no shippable JS library owns this
 * routing; the ~200-line hand-rolled router stays by verdict.
 */
import type { RigView } from 'openrig';

/** The minimal per-device model the client map needs. */
export interface MapNode {
  id: string;
  name: string;
  /** Signal-priority index (diagram.ts signalOrder) for stable ordering. */
  tier: number;
  roles: string[];
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  /** SignalKind: audio | midi | timing | footswitch (matches cable classes). */
  kind: string;
  governed: boolean;
  enabled: boolean;
  label: string;
}

export interface MapModel {
  nodes: MapNode[];
  edges: MapEdge[];
}

import { signalOrder } from './diagram.js';

/** Build the embeddable model from the view. Pure; JSON-safe. */
export function mapModel(view: RigView): MapModel {
  const ordered = signalOrder(view.devices);
  const tierIndex = new Map<string, number>();
  ordered.forEach((d, i) => tierIndex.set(d.id, i));
  return {
    nodes: ordered.map((d) => ({
      id: d.id,
      name: d.name,
      tier: tierIndex.get(d.id) ?? 9,
      roles: [...d.roles],
    })),
    edges: view.links.map((l) => ({
      id: l.id,
      from: l.from.node,
      to: l.to.node,
      kind: l.kind,
      governed: l.governed,
      enabled: l.enabled,
      label: l.label,
    })),
  };
}

/**
 * The client map renderer, as a raw statement body like
 * CONSOLE_INTERACTION_JS: the host wraps it, the generated page inlines it.
 * Queries the DOM fresh per run; safe to re-run after a panel refresh.
 */
export const CONSOLE_MAP_JS = `
  var mapData = document.getElementById('rc-map');
  var mapHost = document.getElementById('rc-maphost');
  if (mapData && mapHost) (function () {
    var model = JSON.parse(mapData.textContent || '{}');
    if (!model.nodes || !model.nodes.length) return;
    var NS = 'http://www.w3.org/2000/svg';
    // Uniform modules (owner, 2026-08-24 round 2): every box is the SAME
    // width and height — name-driven widths made the whole shape overly
    // wide, and identical modules are the video-game-display read. Long
    // names wrap to two lines inside the module (parenthetical suffixes
    // dropped on the map only; the inspect keeps the full name).
    var W = 1500, H = 860, NODE_W = 190, BOXH = 24, GAP = 12, SPREAD = 20;
    var LINE_CHARS = 20;
    // The fit region: the right half, both quadrants tall (owner, 2026-08-24
    // round 2; mild overscan past the quadrant is accepted). PERROW derives
    // from it — the widest row is exactly what the region holds.
    var FIT_X0 = W * 0.42, FIT_Y0 = 70, FIT_X1 = W - 30, FIT_Y1 = H - 30;
    var ROW_GAP = 26;
    var PERROW = Math.max(2, Math.floor((FIT_X1 - FIT_X0 + ROW_GAP) / (NODE_W + ROW_GAP)));

    function mapLabel(name) {
      // NOTE this whole script ships inside a TS template literal: every
      // regex backslash below is doubled so the CLIENT sees \\s, not s.
      // (An un-doubled \\s here once stripped the letter s from every
      // label: "Boss" rendered "Bo". Owner-visible, 2026-08-24.)
      var short = name.replace(/\\s*\\([^)]*\\)\\s*$/, '');
      if (short === '') short = name;
      var words = short.split(/\\s+/);
      var lines = [''], truncated = false;
      words.forEach(function (w) {
        var li = lines.length - 1;
        var t = lines[li] === '' ? w : lines[li] + ' ' + w;
        if (t.length <= LINE_CHARS) { lines[li] = t; return; }
        if (lines.length === 1) { lines.push(w); return; }
        truncated = true;
      });
      lines = lines.map(function (L) { return L.length <= LINE_CHARS ? L : L.slice(0, LINE_CHARS - 1) + '\\u2026'; });
      if (truncated && lines[1].length <= LINE_CHARS - 1) lines[1] += '\\u2026';
      var maxLen = 1;
      lines.forEach(function (L) { maxLen = Math.max(maxLen, L.length); });
      return { lines: lines, maxLen: maxLen };
    }

    var roles = {}, names = {}, labels = {};
    model.nodes.forEach(function (n) { roles[n.id] = n.roles; names[n.id] = n.name; labels[n.id] = mapLabel(n.name); });
    function has(id, r) { return (roles[id] || []).indexOf(r) !== -1; }
    // Voice-class ordering (owner, 2026-08-24: "grouped in rows or columns
    // by both type AND connection order"): connection order picks the ROW
    // (hop depth / band); class picks the ORDER WITHIN it, so same-class
    // devices sit adjacent. Substring match lets extra_roles tags (synth,
    // drum, vocal...) refine the coarse core roles.
    var CLASS_ORDER = ['sequencer', 'clock_master', 'synth', 'keys', 'sampler', 'drum',
      'sound_source', 'vocal', 'effect', 'looper', 'mixer', 'audio_interface',
      'monitor', 'controller', 'midi_router'];
    function classRank(id) {
      var rs = roles[id] || [], best = CLASS_ORDER.length;
      rs.forEach(function (r) {
        CLASS_ORDER.forEach(function (c, i) { if (i < best && String(r).indexOf(c) !== -1) best = i; });
      });
      return best;
    }
    function byClassThenTier(a, b) { return classRank(a.id) - classRank(b.id) || a.tier - b.tier; }
    function widthOf() { return NODE_W; }
    // FIXED COLUMN TRACKS (2026-08-24 layout research, FUI precedent:
    // iDroid/Elite/EVE grids snap modules to strict column tracks; a short
    // row centre-offset between full rows is the #1 "auto-laid-out" tell).
    // PERROW tracks span the fit region exactly; every row occupies
    // consecutive tracks biased around the SPINE track, and the flow's
    // primary box (the hub) is PINNED to the spine, which also carries a
    // dim full-height guide line.
    var SPINE = 1;
    function trackX(i) { return FIT_X0 + NODE_W / 2 + i * (NODE_W + ROW_GAP); }
    function packRow(list, y, pos, primary) {
      var k = list.length;
      var start = Math.max(0, Math.min(PERROW - k, SPINE - Math.floor((k - 1) / 2)));
      var order = list.slice();
      // the hub rides the spine track whenever it is in this row
      order.forEach(function (n, i) {
        if (primary !== undefined && n.id === primary) {
          var want = SPINE - start;
          if (want >= 0 && want < k && want !== i) { order.splice(i, 1); order.splice(want, 0, n); }
        }
      });
      order.forEach(function (n, i) {
        pos[n.id] = { x: trackX(start + i), y: y, w: NODE_W };
      });
    }
    // Split a wide band into stacked rows of at most PERROW modules,
    // BALANCED (5 -> 3+2, 6 -> 3+3, never 4+1: balanced reads designed,
    // greedy reads like overflow — Coffman-Graham-style width bound).
    // Returns the next free row y.
    function chunkRows(list, y0, pos, pitch, primary) {
      if (list.length === 0) return y0;
      var rows = Math.ceil(list.length / PERROW);
      var per = Math.ceil(list.length / rows);
      var y = y0;
      for (var i = 0; i < list.length; i += per) {
        packRow(list.slice(i, i + per), y, pos, primary);
        y += pitch;
      }
      return y;
    }

    // ── LAYOUTS: one per flow, each computed from its own edges ──
    function layoutMidi() {
      var receives = {};
      model.edges.forEach(function (e) {
        if (e.kind === 'audio') return;
        (receives[e.to] = receives[e.to] || {})[e.kind] = true;
      });
      function band(n) {
        if (has(n.id, 'clock_master') || has(n.id, 'sequencer')) return 'master';
        if (has(n.id, 'midi_router')) return 'infra';
        var rx = receives[n.id] || {};
        if (rx.midi) return 'voice';
        if (rx.timing || rx.footswitch) return 'infra';
        return null; // no part in the MIDI flow
      }
      var bands = { master: [], voice: [], infra: [] };
      model.nodes.forEach(function (n) { var b = band(n); if (b) bands[b].push(n); });
      // Vertical band stack (was flat rows with a side flank): master on
      // top, infra between, voices below, each band chunked into rows of
      // uniform modules on the column tracks — the tall right-half layout.
      // Within a band, class groups devices (synths adjacent, drums
      // adjacent...), connection order having already picked the band.
      var primary = bands.master[0] ? bands.master[0].id : model.nodes[0].id;
      bands.master.sort(byClassThenTier);
      bands.infra.sort(byClassThenTier);
      bands.voice.sort(byClassThenTier);
      var pos = {}, y = 150;
      y = chunkRows(bands.master, y, pos, 130, primary);
      y = chunkRows(bands.infra, y, pos, 130, primary);
      chunkRows(bands.voice, y, pos, 130, primary);
      // primary = the clock master: the inspect panel is never empty (owner,
      // 2026-08-24: one item stays selected at all times), so each flow
      // nominates the box a fresh look should start from.
      return { pos: pos, primary: primary };
    }

    function layoutAudio() {
      // Root = the audio hub (looper/mixer role; fallback: most inbound
      // audio). Feeders descend by hop depth over REVERSED audio edges —
      // the owner's reference-tree orientation. What the hub FEEDS (front
      // of house) sits the row above the root.
      var audio = model.edges.filter(function (e) { return e.kind === 'audio'; });
      var inCount = {};
      audio.forEach(function (e) { inCount[e.to] = (inCount[e.to] || 0) + 1; });
      var hub = null;
      model.nodes.forEach(function (n) {
        if (hub) return;
        if (has(n.id, 'looper') || has(n.id, 'mixer')) hub = n.id;
      });
      if (!hub) model.nodes.forEach(function (n) {
        if (!hub || (inCount[n.id] || 0) > (inCount[hub] || 0)) hub = n.id;
      });
      var depth = {}; depth[hub] = 0;
      var frontier = [hub];
      while (frontier.length) {
        var next = [];
        frontier.forEach(function (id) {
          audio.forEach(function (e) {
            if (e.to === id && depth[e.from] === undefined) { depth[e.from] = depth[id] + 1; next.push(e.from); }
          });
        });
        frontier = next;
      }
      var pos = {};
      var rows = {};
      model.nodes.forEach(function (n) {
        var d = depth[n.id];
        if (d === undefined) {
          // downstream of the hub (front of house) sits above the root
          var down = audio.some(function (e) { return e.from === hub && e.to === n.id; });
          if (down) d = -1; else return; // not in the audio flow: hidden
        }
        (rows[d] = rows[d] || []).push(n);
      });
      var y = 150;
      Object.keys(rows).map(Number).sort(function (a, b) { return a - b; }).forEach(function (d) {
        var list = rows[d].sort(byClassThenTier);
        y = chunkRows(list, y, pos, 130, hub);
      });
      return { pos: pos, primary: hub };
    }

    var FOCUS = { audio: { kinds: ['audio'], layout: layoutAudio },
                  midi: { kinds: ['midi', 'timing', 'footswitch'], layout: layoutMidi } };

    // ── svg scaffold ──
    mapHost.innerHTML = '';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'rcmap');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Rig connection map. Toggle audio or MIDI flow; drag to pan, wheel to zoom, select a device or cable for details. The device list below holds the same facts as text.');
    var defs = document.createElementNS(NS, 'defs');
    defs.innerHTML = '<filter id="rc-bloom" x="-40%" y="-40%" width="180%" height="180%">' +
      '<feGaussianBlur stdDeviation="4" result="b"/>' +
      '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
    svg.appendChild(defs);
    var world = document.createElementNS(NS, 'g');
    var spineG = document.createElementNS(NS, 'g');
    var wireG = document.createElementNS(NS, 'g');
    var nodeG = document.createElementNS(NS, 'g');
    world.appendChild(spineG); world.appendChild(wireG); world.appendChild(nodeG);
    svg.appendChild(world);
    mapHost.appendChild(svg);

    // Nodes are created ONCE at the origin and PLACED via transform, so a
    // flow toggle animates them to their new homes (CSS transition).
    var nodeEls = {};
    model.nodes.forEach(function (n) {
      var g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'rcnode');
      g.setAttribute('data-device', n.id);
      g.setAttribute('tabindex', '0');
      g.setAttribute('role', 'button');
      g.setAttribute('aria-label', n.name);
      var w = widthOf(n);
      var r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', -w / 2); r.setAttribute('y', -BOXH);
      r.setAttribute('width', w); r.setAttribute('height', BOXH * 2);
      g.appendChild(r);
      // 1-2 label lines centred in the uniform module (full name stays on
      // the aria-label and in the inspect detail).
      var ls = labels[n.id].lines;
      ls.forEach(function (L, i) {
        var t = document.createElementNS(NS, 'text');
        t.setAttribute('x', 0);
        t.setAttribute('y', ls.length === 1 ? 5 : (i === 0 ? -4 : 16));
        t.setAttribute('text-anchor', 'middle');
        t.textContent = L;
        g.appendChild(t);
      });
      nodeG.appendChild(g);
      nodeEls[n.id] = g;
    });

    // ── wires: conduit corridor routing (rule 35 v4, cable-tray) ──
    // v3 + the 2026-08-24 library-research verdict (keep the hand-rolled
    // router; no shippable JS library owns this) and its three finishing
    // rules: ONE pitch for ports and lanes; a fan's edges form an ATOMIC
    // BUNDLE occupying adjacent lanes ordered like the port fan (outermost
    // port ↔ lane nearest the fan's band), so risers climb the untouched
    // central gap; and corners are TRUE SVG ARCS with per-edge radius
    // RAD + laneDepth×PITCH — concentric quarter-turns, so a bundle's gap
    // never changes through a corner. That triple is the server-room
    // cable-tray read the owner asked for.
    var PITCH = 13, RAD = 16, EDGEPAD = 16;

    function roundedPath(pts, rad) {
      if (pts.length < 2) return '';
      var d = 'M' + pts[0][0] + ' ' + pts[0][1];
      for (var i = 1; i < pts.length - 1; i++) {
        var p = pts[i - 1], c = pts[i], n = pts[i + 1];
        var l1 = Math.hypot(c[0] - p[0], c[1] - p[1]), l2 = Math.hypot(n[0] - c[0], n[1] - c[1]);
        var r = Math.min(rad, l1 / 2, l2 / 2);
        if (r < 4) { d += ' L' + c[0] + ' ' + c[1]; continue; }
        var ax = c[0] - (c[0] - p[0]) / l1 * r, ay = c[1] - (c[1] - p[1]) / l1 * r;
        var bx = c[0] + (n[0] - c[0]) / l2 * r, by = c[1] + (n[1] - c[1]) / l2 * r;
        var sweep = ((c[0] - p[0]) * (n[1] - c[1]) - (c[1] - p[1]) * (n[0] - c[0])) > 0 ? 1 : 0;
        d += ' L' + ax + ' ' + ay + ' A' + r + ' ' + r + ' 0 0 ' + sweep + ' ' + bx + ' ' + by;
      }
      var last = pts[pts.length - 1];
      return d + ' L' + last[0] + ' ' + last[1];
    }

    function drawWires(pos, kinds, flowName) {
      wireG.innerHTML = '';
      var edges = model.edges.filter(function (e) { return pos[e.from] && pos[e.to]; });
      if (!edges.length) return;

      var ys = [];
      Object.keys(pos).forEach(function (id) { if (ys.indexOf(pos[id].y) === -1) ys.push(pos[id].y); });
      ys.sort(function (a, b) { return a - b; });
      function corridorToward(fromY, toY) {
        var i = ys.indexOf(fromY), dir = toY > fromY ? 1 : -1;
        var next = ys[i + dir];
        return next === undefined ? fromY + dir * 90 : (fromY + next) / 2;
      }
      function corridorAbove(y) {
        var i = ys.indexOf(y);
        return i > 0 ? (ys[i - 1] + y) / 2 : y - 90;
      }

      // Rows strictly between two row-ys. A wire spanning intermediate rows
      // may NEVER take a straight or box-column path: the vertical stack
      // (2026-08-24 rounds 2-3) places boxes on shared column tracks, so a
      // track-aligned riser would draw straight THROUGH every intermediate
      // box (owner-reported: the Hydrasynth->hub line through Fractal AM4).
      // Long spans descend through the GUTTERS between tracks instead.
      function rowsBetween(y1, y2) {
        var lo = Math.min(y1, y2), hi = Math.max(y1, y2), n = 0;
        ys.forEach(function (y) { if (y > lo + 1 && y < hi - 1) n++; });
        return n;
      }

      var plans = edges.map(function (e) {
        var a = pos[e.from], b = pos[e.to];
        var up = b.y < a.y;
        return {
          e: e, a: a, b: b, ghost: kinds.indexOf(e.kind) === -1,
          span: rowsBetween(a.y, b.y),
          aSide: a.y === b.y ? 't' : (up ? 't' : 'b'),
          bSide: a.y === b.y ? 't' : (up ? 'b' : 't'),
        };
      });

      // centred port fans: FOCUSED wires own the fan (k ports symmetric
      // around the edge centre, far-endpoint ordered); ghosts take outer
      // slots so the visible geometry is identical with or without them
      var groups = {};
      plans.forEach(function (p) {
        [['aSide', p.e.from, 'aPort', p.b.x], ['bSide', p.e.to, 'bPort', p.a.x]].forEach(function (t) {
          var k = t[1] + '|' + p[t[0]];
          (groups[k] = groups[k] || { id: t[1], side: p[t[0]], atts: [] })
            .atts.push({ plan: p, endKey: t[2], farX: t[3] });
        });
      });
      Object.keys(groups).forEach(function (k) {
        var g = groups[k], n = pos[g.id];
        var vis = [], gho = [];
        g.atts.forEach(function (t) { (t.plan.ghost ? gho : vis).push(t); });
        vis.sort(function (x, y) { return x.farX - y.farX; });
        gho.sort(function (x, y) { return x.farX - y.farX; });
        vis.forEach(function (t, ix) {
          t.plan[t.endKey] = n.x + (ix - (vis.length - 1) / 2) * PITCH;
          t.plan[t.endKey === 'aPort' ? 'aFan' : 'bFan'] = vis.length;
        });
        var lOut = -(vis.length - 1) / 2 - 1, rOut = (vis.length - 1) / 2 + 1;
        gho.forEach(function (t) {
          if (t.farX < n.x) { t.plan[t.endKey] = n.x + lOut * PITCH; lOut -= 1; }
          else { t.plan[t.endKey] = n.x + rOut * PITCH; rOut += 1; }
          t.plan[t.endKey === 'aPort' ? 'aFan' : 'bFan'] = 99;
        });
      });

      // snap-to-straight: exact alignment is free; a sub-corner jog may only
      // pull ports when BOTH ends are single-attachment
      plans.forEach(function (p) {
        if (p.a.y === p.b.y) return;
        if (p.span > 0) return; // intermediate rows: never straight, gutter-routed below
        var diff = Math.abs(p.aPort - p.bPort);
        if (diff < 1) { p.straight = true; return; }
        if (diff >= 2 * RAD + 2 || p.aFan > 1 || p.bFan > 1) return;
        var la = p.a.x - p.a.w / 2 + EDGEPAD, ha = p.a.x + p.a.w / 2 - EDGEPAD;
        var lb = p.b.x - p.b.w / 2 + EDGEPAD, hb = p.b.x + p.b.w / 2 - EDGEPAD;
        var mid = Math.max(Math.max(la, lb), Math.min(Math.min(ha, hb), (p.aPort + p.bPort) / 2));
        if (mid >= la && mid <= ha && mid >= lb && mid <= hb) { p.aPort = mid; p.bPort = mid; p.straight = true; }
      });

      // corridor routes, each tagged with its BUNDLE: the fan it belongs
      // to (the larger fan of its two ends; ghosts and fanless edges are
      // strays). A bundle's lanes stay adjacent and ordered like its port
      // fan, which is what keeps the conduit parallel end to end.
      var routes = [];
      plans.forEach(function (p) {
        if (p.straight) { routes.push({ p: p, kind: 'straight' }); return; }
        var r = { p: p, x1: Math.min(p.aPort, p.bPort), x2: Math.max(p.aPort, p.bPort) };
        if (p.a.y === p.b.y) { r.kind = 'sameband'; r.cy = corridorAbove(p.a.y); }
        else { r.kind = 'comb'; r.cy = corridorToward(p.a.y, p.b.y); r.long = p.span > 0; }
        var aF = p.aFan || 1, bF = p.bFan || 1;
        if (!p.ghost && (aF >= 2 || bF >= 2) && aF !== 99 && bF !== 99) {
          if (bF >= aF) { r.bKey = p.e.to + '|' + p.bSide; r.bCx = p.b.x; r.bPortX = p.bPort; }
          else { r.bKey = p.e.from + '|' + p.aSide; r.bCx = p.a.x; r.bPortX = p.aPort; }
        }
        routes.push(r);
      });

      var byCorr = {};
      routes.forEach(function (r) {
        if (r.cy === undefined) return;
        (byCorr[String(r.cy)] = byCorr[String(r.cy)] || []).push(r);
      });
      Object.keys(byCorr).forEach(function (key) {
        var runs = byCorr[key], cy = runs[0].cy;
        var upVotes = 0, downVotes = 0;
        runs.forEach(function (r) {
          [['a', r.p.aFan], ['b', r.p.bFan]].forEach(function (t) {
            var fan = t[1] || 1;
            if (fan < 2 || fan === 99) return;
            if (r.p[t[0]].y < cy) upVotes += fan; else downVotes += fan;
          });
        });
        var hubUpper = upVotes >= downVotes;
        // blocks: bundles first (largest fan, then widest), strays after
        var blocks = {}, order = [];
        runs.forEach(function (r) {
          var gk = r.bKey || ('_stray_' + r.p.e.id);
          if (!blocks[gk]) { blocks[gk] = []; order.push(gk); }
          blocks[gk].push(r);
        });
        function widthOfBlock(gk) {
          var w = 0;
          blocks[gk].forEach(function (r) { w = Math.max(w, r.x2 - r.x1); });
          return w;
        }
        order.sort(function (g1, g2) {
          var b1 = blocks[g1].length, b2 = blocks[g2].length;
          if (b1 !== b2) return b2 - b1;
          return widthOfBlock(g2) - widthOfBlock(g1);
        });
        var base = 0;
        order.forEach(function (gk) {
          var members = blocks[gk];
          // outermost port first: it takes the lane nearest the fan's band,
          // so inner risers climb through the fan's central gap
          members.sort(function (m1, m2) {
            return Math.abs((m2.bPortX || 0) - (m2.bCx || 0)) - Math.abs((m1.bPortX || 0) - (m1.bCx || 0));
          });
          var local = [];
          members.forEach(function (r) {
            for (var i = 0; i < local.length; i++) {
              var ok = true;
              for (var j = 0; j < local[i].length; j++) {
                var o = local[i][j];
                if (!(r.x2 < o.x1 - 24 || r.x1 > o.x2 + 24)) { ok = false; break; }
              }
              if (ok) { local[i].push(r); r.depth = i; return; }
            }
            local.push([r]); r.depth = local.length - 1;
          });
          members.forEach(function (r) { r.lane = base + r.depth; });
          base += local.length;
        });
        runs.forEach(function (r) {
          var off = (r.lane - (base - 1) / 2) * PITCH;
          r.ly = cy + (hubUpper ? off : -off);
          r.rad = RAD + r.depth * PITCH;
        });
        // bundle-coherent clamp: if any member's corner would clamp its
        // radius, shrink the WHOLE bundle by the same amount — concentric
        // spacing survives, only the sweep tightens
        order.forEach(function (gk) {
          var members = blocks[gk];
          if (members.length < 2) return;
          var deficit = 0;
          members.forEach(function (r) {
            var pts = polyline(r);
            for (var i = 1; i < pts.length - 1; i++) {
              var l1 = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
              var l2 = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
              deficit = Math.max(deficit, r.rad - Math.min(l1 / 2, l2 / 2));
            }
          });
          if (deficit > 0) members.forEach(function (r) { r.rad = Math.max(6, r.rad - deficit); });
        });
      });

      // GUTTER RISERS for long spans: a wire crossing intermediate rows
      // descends through the gutter between column tracks (box-free by
      // construction), reserved so overlapping spans never share an x.
      // Its b-side corridor run sits half a pitch off the corridor centre,
      // keyed off the gutter offset, so it cannot coincide with a packed
      // lane there.
      var GUTW = NODE_W + ROW_GAP;
      function gutterX(i) { return FIT_X0 - ROW_GAP / 2 + i * GUTW; }
      var gutterRes = [];
      routes.forEach(function (r) {
        if (!r.long) return;
        var p = r.p;
        var cyB = corridorToward(p.b.y, p.a.y);
        var lo = Math.min(r.ly, cyB), hi = Math.max(r.ly, cyB);
        var ideal = (p.aPort + p.bPort) / 2;
        var gi = Math.max(0, Math.min(PERROW, Math.round((ideal - gutterX(0)) / GUTW)));
        var pick;
        var order = [0, 1, -1, 2, -2, 3, -3];
        for (var oi = 0; oi < order.length && pick === undefined; oi++) {
          var g = gi + order[oi];
          if (g < 0 || g > PERROW) continue;
          var offs = [0, -PITCH / 2, PITCH / 2];
          for (var fi = 0; fi < offs.length; fi++) {
            var x = gutterX(g) + offs[fi], clash = false;
            for (var ri = 0; ri < gutterRes.length; ri++) {
              var q = gutterRes[ri];
              if (Math.abs(q.x - x) < PITCH - 2 && !(hi < q.lo - 10 || lo > q.hi + 10)) { clash = true; break; }
            }
            if (!clash) { pick = x; break; }
          }
        }
        r.gx = pick === undefined ? gutterX(gi) : pick;
        gutterRes.push({ x: r.gx, lo: lo, hi: hi });
        r.cyB = cyB + (r.gx - gutterX(Math.round((r.gx - gutterX(0)) / GUTW)) === 0 ? 6.5 : -6.5) * (p.b.y > p.a.y ? 1 : -1);
      });

      function edgeYOf(nodePos, side) { return side === 't' ? nodePos.y - BOXH : nodePos.y + BOXH; }
      function polyline(r) {
        var p = r.p;
        if (r.kind === 'straight') {
          return [[p.aPort, edgeYOf(p.a, p.aSide)], [p.bPort, edgeYOf(p.b, p.bSide)]];
        }
        if (r.kind === 'sameband') {
          return [[p.aPort, edgeYOf(p.a, 't')], [p.aPort, r.ly], [p.bPort, r.ly], [p.bPort, edgeYOf(p.b, 't')]];
        }
        if (r.gx !== undefined) {
          return [[p.aPort, edgeYOf(p.a, p.aSide)], [p.aPort, r.ly], [r.gx, r.ly],
            [r.gx, r.cyB], [p.bPort, r.cyB], [p.bPort, edgeYOf(p.b, p.bSide)]];
        }
        return [[p.aPort, edgeYOf(p.a, p.aSide)], [p.aPort, r.ly], [p.bPort, r.ly], [p.bPort, edgeYOf(p.b, p.bSide)]];
      }

      // ghosts beneath, then bloom+wire+hit per focused edge, then terminal
      // pads — bloom rides ONLY the focused layer
      var ordered = routes.filter(function (r) { return r.p.ghost; })
        .concat(routes.filter(function (r) { return !r.p.ghost; }));
      ordered.forEach(function (r) {
        var e = r.p.e, pts = polyline(r), d = roundedPath(pts, r.rad || RAD);
        if (r.p.ghost) {
          var gp = document.createElementNS(NS, 'path');
          gp.setAttribute('d', d); gp.setAttribute('fill', 'none');
          gp.setAttribute('class', 'rcw ghost ' + e.kind);
          wireG.appendChild(gp);
          return;
        }
        var cls = 'rcw ' + e.kind + (e.governed ? ' governed' : '') + (e.enabled ? '' : ' planned');
        ['glow', 'wire', 'hit'].forEach(function (pass) {
          var el = document.createElementNS(NS, 'path');
          el.setAttribute('d', d); el.setAttribute('fill', 'none');
          if (pass === 'glow') { el.setAttribute('class', cls + ' glow'); el.setAttribute('filter', 'url(#rc-bloom)'); }
          if (pass === 'wire') { el.setAttribute('class', cls); el.setAttribute('data-edge', e.id); }
          if (pass === 'hit') { el.setAttribute('class', 'rcw hit'); el.setAttribute('data-edge', e.id); }
          wireG.appendChild(el);
        });
        [pts[0], pts[pts.length - 1]].forEach(function (pt) {
          var pad = document.createElementNS(NS, 'rect');
          pad.setAttribute('x', pt[0] - 2.5); pad.setAttribute('y', pt[1] - 2.5);
          pad.setAttribute('width', 5); pad.setAttribute('height', 5);
          pad.setAttribute('class', 'rcpad ' + e.kind);
          wireG.appendChild(pad);
        });
      });
    }

    // ── flow switching: nodes glide, wires follow ──
    var curPos = null;
    // Fit the flow into the RIGHT HALF, both quadrants tall (owner,
    // 2026-08-24 round 2: "make it more vertical... fill the top right AND
    // bottom right quadrant"; mild overscan accepted). The left half stays
    // free for the inspect (top) and the system status (bottom). Content
    // is scaled into the region (never past 1.15x: a two-box rig must not
    // balloon) and centred within it. Pan/zoom still reach everything.
    function fitView(pos) {
      var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, any = false;
      Object.keys(pos).forEach(function (id) {
        var p = pos[id]; any = true;
        minX = Math.min(minX, p.x - p.w / 2); maxX = Math.max(maxX, p.x + p.w / 2);
        minY = Math.min(minY, p.y - BOXH); maxY = Math.max(maxY, p.y + BOXH);
      });
      if (!any) return;
      minX -= 70; maxX += 70; minY -= 60; maxY += 60;
      var bw = maxX - minX, bh = maxY - minY;
      scale = Math.min((FIT_X1 - FIT_X0) / bw, (FIT_Y1 - FIT_Y0) / bh, 1.15);
      tx = (FIT_X0 + FIT_X1) / 2 - (minX + bw / 2) * scale;
      ty = (FIT_Y0 + FIT_Y1) / 2 - (minY + bh / 2) * scale;
      apply();
      // Map-anchored type (menu-language rule 25), a CAP since the quadrant
      // fit: labels render at the LIST body size (13.5 CSS px) whenever the
      // uniform module can hold the longest visible label line; a crowded
      // fit caps them at what the module allows so neighbouring labels
      // never collide. Two-line labels also bound the size vertically.
      var maxLen = 1, twoLine = false;
      Object.keys(pos).forEach(function (id) {
        var L = labels[id];
        if (!L) return;
        maxLen = Math.max(maxLen, L.maxLen);
        if (L.lines.length > 1) twoLine = true;
      });
      var fvMax = Math.min((NODE_W - 24) / (0.62 * maxLen), twoLine ? 16 : 24);
      svg.style.setProperty('--maptx', Math.min(13.5 * unitsPerPx() / scale, fvMax).toFixed(2) + 'px');
    }
    // What the inspect panel currently shows. One item stays selected at all
    // times (owner, 2026-08-24), so this is empty only before the first
    // setFlow, which immediately selects the flow's primary box.
    var curInspect = {};
    function edgeFocused(id, pos, kinds) {
      var hit = null;
      model.edges.forEach(function (x) { if (x.id === id) hit = x; });
      return !!hit && !!pos[hit.from] && !!pos[hit.to] && kinds.indexOf(hit.kind) !== -1;
    }
    function setFlow(name) {
      var f = FOCUS[name] || FOCUS.audio;
      var lay = f.layout();
      var pos = lay.pos;
      curPos = pos;
      document.documentElement.setAttribute('data-rc-flow', name);
      [].slice.call(document.querySelectorAll('.flowtoggle button')).forEach(function (b) {
        b.setAttribute('aria-pressed', String(b.getAttribute('data-flow') === name));
      });
      model.nodes.forEach(function (n) {
        var el = nodeEls[n.id], p = pos[n.id];
        if (!p) { el.style.display = 'none'; return; }
        el.style.display = '';
        el.setAttribute('transform', 'translate(' + p.x + ' ' + p.y + ')');
      });
      // the spine: a dim guide along the hub's track, drawn as SEGMENTS
      // between the boxes that sit on it — never through one (box fills
      // are translucent, so a continuous line showed inside every spine
      // box and read as a wire through it; owner-reported 2026-08-27) and
      // never overhanging past the first or last box.
      spineG.innerHTML = '';
      var sx = trackX(SPINE);
      var spineYs = [];
      Object.keys(pos).forEach(function (id) {
        if (Math.abs(pos[id].x - sx) < 1) spineYs.push(pos[id].y);
      });
      spineYs.sort(function (a, b) { return a - b; });
      for (var si = 0; si + 1 < spineYs.length; si++) {
        var sp = document.createElementNS(NS, 'line');
        sp.setAttribute('x1', sx); sp.setAttribute('x2', sx);
        sp.setAttribute('y1', spineYs[si] + BOXH + 10);
        sp.setAttribute('y2', spineYs[si + 1] - BOXH - 10);
        sp.setAttribute('class', 'rcspine');
        spineG.appendChild(sp);
      }
      drawWires(pos, f.kinds, name);
      fitView(pos);
      // keep the selection across the switch when it survives; else the
      // flow's primary box takes it, so the detail quadrant never empties
      if (curInspect.d && pos[curInspect.d]) inspectDevice(curInspect.d);
      else if (curInspect.e && edgeFocused(curInspect.e, pos, f.kinds)) inspectEdge(curInspect.e);
      else inspectDevice(lay.primary);
    }
    [].slice.call(document.querySelectorAll('.flowtoggle button')).forEach(function (b) {
      b.addEventListener('click', function () { setFlow(b.getAttribute('data-flow')); });
    });

    // ── inspect: project the SERVER-RENDERED device detail ──
    var inspect = document.getElementById('rc-inspect');
    function inspectDevice(id) {
      var src = document.querySelector('.dlist .dev[data-device="' + id + '"]');
      if (!inspect || !src) return;
      curInspect = { d: id };
      // The mockup's inspect grammar: a solid header bar (.ph) carrying the
      // name, the detail in a translucent .body (the .top h3 the server
      // rendered inside the detail is CSS-hidden to keep the name single).
      inspect.innerHTML = '<div class="ph">' + (src.getAttribute('data-name') || id) + '</div>' +
        '<div class="body">' + src.innerHTML + '</div>';
      // The mapping-surface link (rules 29-31): the sequencer's inspect
      // links to its storage view — the Packs deck's colored pad grids,
      // where selecting a song lights its run.
      if (has(id, 'sequencer') || has(id, 'clock_master')) {
        var go = document.createElement('button');
        go.type = 'button';
        go.className = 'maplink';
        go.textContent = 'View card mapping \\u2192';
        go.addEventListener('click', function () {
          var tab = document.querySelector('.tab[data-deck="card"]');
          if (tab) tab.click();
        });
        (inspect.querySelector('.body') || inspect).appendChild(go);
      }
      inspect.classList.add('on');
      [].slice.call(document.querySelectorAll('.rcnode')).forEach(function (nEl) {
        nEl.classList.toggle('sel', nEl.getAttribute('data-device') === id);
      });
      [].slice.call(wireG.querySelectorAll('path.rcw.sel')).forEach(function (w) { w.classList.remove('sel'); });
    }
    function inspectEdge(id) {
      var e = null;
      model.edges.forEach(function (x) { if (x.id === id) e = x; });
      if (!inspect || !e) return;
      curInspect = { e: id };
      inspect.innerHTML = '<div class="ph">' + names[e.from] + ' → ' + names[e.to] + '</div>' +
        '<div class="body"><div class="top">' +
        '<span class="tag ' + e.kind + '">' + e.kind + '</span>' +
        (e.governed ? ' <span class="tag governed">governed</span>' : '') +
        (e.enabled ? '' : ' <span class="tag planned">planned</span>') + '</div>' +
        '<div class="conns"><div class="conn"><span>' + e.label + '</span></div></div></div>';
      inspect.classList.add('on');
      [].slice.call(document.querySelectorAll('.rcnode.sel')).forEach(function (nEl) { nEl.classList.remove('sel'); });
      [].slice.call(wireG.querySelectorAll('path.rcw:not(.hit):not(.glow)')).forEach(function (w) {
        w.classList.toggle('sel', w.getAttribute('data-edge') === id);
      });
    }

    // ── pan / zoom / select (pointer-capture-safe: resolve at DOWN) ──
    var tx = 0, ty = 0, scale = 1, panning = false, sx = 0, sy = 0, moved = false, downEl = null;
    function apply() { world.setAttribute('transform', 'translate(' + tx + ' ' + ty + ') scale(' + scale + ')'); }
    // viewBox units per CSS pixel under xMidYMid meet (same on both axes)
    function unitsPerPx() {
      var r = svg.getBoundingClientRect();
      return Math.max(W / r.width, H / r.height);
    }
    svg.addEventListener('pointerdown', function (e) {
      panning = true; moved = false; sx = e.clientX; sy = e.clientY;
      var t2 = e.target.closest ? e.target.closest('[data-device],[data-edge]') : null;
      downEl = t2 ? (t2.getAttribute('data-device') ? { d: t2.getAttribute('data-device') } : { e: t2.getAttribute('data-edge') }) : null;
      svg.classList.add('panning');
      // capture keeps the drag when the cursor leaves the svg; synthetic
      // pointers (tests, odd touch stacks) have no capturable id — pan
      // still works uncaptured, so a throw here must not kill the handler
      try { svg.setPointerCapture(e.pointerId); } catch (err) { /* uncaptured pan */ }
    });
    svg.addEventListener('pointermove', function (e) {
      if (!panning) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      // meet letterboxes: ONE ratio holds on both axes (units per px);
      // the old per-axis pair skewed pan/zoom on wide windows
      var k1 = unitsPerPx();
      tx += dx * k1; ty += dy * k1;
      sx = e.clientX; sy = e.clientY; apply();
    });
    svg.addEventListener('pointerup', function () {
      panning = false; svg.classList.remove('panning');
      if (!moved && downEl) { if (downEl.d) inspectDevice(downEl.d); else inspectEdge(downEl.e); }
      downEl = null;
    });
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var k = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      var ns = Math.min(2.6, Math.max(0.55, scale * k));
      var rect = svg.getBoundingClientRect();
      var k2 = unitsPerPx();
      var px = (e.clientX - rect.left - (rect.width - W / k2) / 2) * k2;
      var py = (e.clientY - rect.top - (rect.height - H / k2) / 2) * k2;
      tx = px - (px - tx) * (ns / scale);
      ty = py - (py - ty) * (ns / scale);
      scale = ns; apply();
    }, { passive: false });
    [].slice.call(document.querySelectorAll('.rcnode')).forEach(function (g) {
      g.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { inspectDevice(g.getAttribute('data-device')); e.preventDefault(); }
      });
    });

    // The map is live: the fallback diagram+list hide (still in the DOM for
    // Ctrl+F and print; CSS un-hides them on paper). Audio is the default
    // flow (rule 38); a previous choice survives the refresh.
    var fb = document.querySelector('#deck-rig .riggrid');
    if (fb) fb.classList.add('map-fallback');
    (mapHost.parentElement || mapHost).classList.add('on');
    setFlow(document.documentElement.getAttribute('data-rc-flow') || 'audio');
  })();
`;
