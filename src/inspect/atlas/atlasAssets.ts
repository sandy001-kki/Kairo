/**
 * Atlas same-origin browser assets (v1.5.0, PR 4 — 2D architecture map).
 *
 * Served from `/atlas/app.js` and `/atlas/app.css` so the page satisfies
 * `script-src 'self'; style-src 'self'` with NO inline script or style.
 *
 * `app.js` is a self-authored, dependency-free, deterministic 2D canvas
 * renderer. It consumes `/atlas/graph.json` exactly as the PR-2 projection
 * produces it and adds no analysis. Layout is a seeded, fixed-iteration
 * force simulation (seed derived from node ids) so the same payload always
 * lays out identically — no `Math.random`, no animation-timer dependence.
 *
 * Safety: no `eval`, no `Function`, no remote URLs, no `innerHTML`. The only
 * network call is a same-origin `fetch('/atlas/graph.json')`
 * (allowed by `connect-src 'self'`). Labels are drawn via canvas
 * `fillText`, never injected as markup.
 */

export const ATLAS_APP_JS = `(() => {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var setText = function (id, v) { var el = byId(id); if (el) el.textContent = v; };

  var GROUP_COLORS = {
    source: '#3b82f6', test: '#22c55e', docs: '#a855f7',
    example: '#06b6d4', generated: '#9ca3af', other: '#f59e0b'
  };
  var RISK_RING = { low: '', medium: '#d97706', high: '#dc2626' };

  // ---- deterministic PRNG (mulberry32) seeded per node id ----------------
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var canvas = byId('atlas-canvas');
  var ctx = canvas ? canvas.getContext('2d') : null;
  var view = { scale: 1, tx: 0, ty: 0 };
  var model = { nodes: [], edges: [], pos: {}, screen: {}, sel: null, neighbors: {} };
  var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  function radiusOf(n) { return 4 + (n.salience || 0) * 18; }

  // ---- seeded, fixed-iteration force layout (deterministic) --------------
  function layout(graph) {
    var n = graph.nodes.length;
    var pos = {};
    for (var i = 0; i < n; i++) {
      var node = graph.nodes[i];
      var rnd = mulberry32(hashStr(node.id));
      var ang = (i / Math.max(1, n)) * Math.PI * 2;
      var rad = 160 + rnd() * 160;
      pos[node.id] = { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, vx: 0, vy: 0 };
    }
    var ITER = n > 160 ? 160 : 240;
    for (var it = 0; it < ITER; it++) {
      for (var a = 0; a < n; a++) {
        var A = pos[graph.nodes[a].id];
        for (var b = a + 1; b < n; b++) {
          var B = pos[graph.nodes[b].id];
          var dx = A.x - B.x, dy = A.y - B.y;
          var d2 = dx * dx + dy * dy; if (d2 < 0.01) d2 = 0.01;
          var d = Math.sqrt(d2);
          var f = 5200 / d2;
          var ux = dx / d, uy = dy / d;
          A.vx += ux * f; A.vy += uy * f; B.vx -= ux * f; B.vy -= uy * f;
        }
      }
      for (var e = 0; e < graph.edges.length; e++) {
        var ed = graph.edges[e];
        var P = pos[ed.from], Q = pos[ed.to]; if (!P || !Q) continue;
        var ex = Q.x - P.x, ey = Q.y - P.y;
        var ed2 = Math.sqrt(ex * ex + ey * ey) || 1;
        var w = ed.weight || 1;
        var fa = (ed2 - 90) * 0.018 * (1 + Math.log(1 + w));
        var ax = ex / ed2, ay = ey / ed2;
        P.vx += ax * fa; P.vy += ay * fa; Q.vx -= ax * fa; Q.vy -= ay * fa;
      }
      for (var k = 0; k < n; k++) {
        var Pp = pos[graph.nodes[k].id];
        Pp.vx *= 0.85; Pp.vy *= 0.85;
        var step = 14;
        Pp.x += Math.max(-step, Math.min(step, Pp.vx));
        Pp.y += Math.max(-step, Math.min(step, Pp.vy));
        Pp.x -= Pp.x * 0.0009; Pp.y -= Pp.y * 0.0009;
      }
    }
    return pos;
  }

  function resizeCanvas() {
    if (!canvas) return;
    var rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  }

  function fitView() {
    if (!canvas || model.nodes.length === 0) { view = { scale: 1, tx: canvas ? canvas.width / 2 : 0, ty: canvas ? canvas.height / 2 : 0 }; return; }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < model.nodes.length; i++) {
      var p = model.pos[model.nodes[i].id]; if (!p) continue;
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    var w = (maxX - minX) || 1, h = (maxY - minY) || 1;
    var pad = 60 * dpr;
    var sx = (canvas.width - pad * 2) / w, sy = (canvas.height - pad * 2) / h;
    view.scale = Math.max(0.05, Math.min(4, Math.min(sx, sy)));
    view.tx = canvas.width / 2 - ((minX + maxX) / 2) * view.scale;
    view.ty = canvas.height / 2 - ((minY + maxY) / 2) * view.scale;
  }

  function worldToScreen(p) { return { x: p.x * view.scale + view.tx, y: p.y * view.scale + view.ty }; }

  function draw() {
    if (!ctx || !canvas) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var hasSel = !!model.sel;

    // edges
    for (var i = 0; i < model.edges.length; i++) {
      var ed = model.edges[i];
      var P = model.pos[ed.from], Q = model.pos[ed.to]; if (!P || !Q) continue;
      var sp = worldToScreen(P), sq = worldToScreen(Q);
      var active = hasSel && (ed.from === model.sel || ed.to === model.sel);
      ctx.strokeStyle = active ? 'rgba(59,130,246,0.85)' : (hasSel ? 'rgba(140,140,140,0.10)' : 'rgba(140,140,140,0.28)');
      ctx.lineWidth = active ? 1.6 * dpr : 1 * dpr;
      ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(sq.x, sq.y); ctx.stroke();
    }

    // nodes
    model.screen = {};
    for (var j = 0; j < model.nodes.length; j++) {
      var n = model.nodes[j];
      var p = model.pos[n.id]; if (!p) continue;
      var s = worldToScreen(p); model.screen[n.id] = s;
      var r = radiusOf(n) * Math.max(0.6, Math.min(1.6, view.scale));
      var dim = hasSel && n.id !== model.sel && !model.neighbors[n.id];
      ctx.globalAlpha = dim ? 0.22 : 1;
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = GROUP_COLORS[n.group] || GROUP_COLORS.other;
      ctx.fill();
      var ring = n.risk ? RISK_RING[n.risk] : '';
      if (ring) { ctx.lineWidth = 2 * dpr; ctx.strokeStyle = ring; ctx.stroke(); }
      if (n.flags && n.flags.changed) {
        ctx.beginPath(); ctx.arc(s.x + r * 0.8, s.y - r * 0.8, 2.2 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = '#111827'; ctx.fill();
      }
      ctx.globalAlpha = 1;
      var showLabel = (r > 9 * dpr) || n.id === model.sel || model.neighbors[n.id];
      if (showLabel) {
        ctx.fillStyle = 'rgba(80,80,80,0.95)';
        ctx.font = (11 * dpr) + 'px ui-sans-serif, system-ui, sans-serif';
        ctx.fillText(n.label, s.x + r + 3 * dpr, s.y + 3 * dpr);
      }
    }
    ctx.globalAlpha = 1;
  }

  function selectNode(id) {
    model.sel = id;
    model.neighbors = {};
    if (id) {
      for (var i = 0; i < model.edges.length; i++) {
        var ed = model.edges[i];
        if (ed.from === id) model.neighbors[ed.to] = true;
        if (ed.to === id) model.neighbors[ed.from] = true;
      }
    }
    draw();
  }

  function hitTest(sx, sy) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < model.nodes.length; i++) {
      var n = model.nodes[i]; var s = model.screen[n.id]; if (!s) continue;
      var dx = sx - s.x, dy = sy - s.y; var d = Math.sqrt(dx * dx + dy * dy);
      var r = radiusOf(n) * Math.max(0.6, Math.min(1.6, view.scale)) + 4 * dpr;
      if (d <= r && d < bestD) { best = n.id; bestD = d; }
    }
    return best;
  }

  // ---- interaction: pan, zoom, click -------------------------------------
  function attach() {
    if (!canvas) return;
    var dragging = false, moved = false, lastX = 0, lastY = 0;
    canvas.addEventListener('pointerdown', function (ev) {
      dragging = true; moved = false; lastX = ev.clientX; lastY = ev.clientY;
      canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      var dx = (ev.clientX - lastX) * dpr, dy = (ev.clientY - lastY) * dpr;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      view.tx += dx; view.ty += dy; lastX = ev.clientX; lastY = ev.clientY; draw();
    });
    canvas.addEventListener('pointerup', function (ev) {
      dragging = false;
      if (!moved) {
        var rect = canvas.getBoundingClientRect();
        var sx = (ev.clientX - rect.left) * dpr, sy = (ev.clientY - rect.top) * dpr;
        var hit = hitTest(sx, sy);
        selectNode(hit);
      }
    });
    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var rect = canvas.getBoundingClientRect();
      var mx = (ev.clientX - rect.left) * dpr, my = (ev.clientY - rect.top) * dpr;
      var factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      var ns = Math.max(0.05, Math.min(6, view.scale * factor));
      view.tx = mx - (mx - view.tx) * (ns / view.scale);
      view.ty = my - (my - view.ty) * (ns / view.scale);
      view.scale = ns; draw();
    }, { passive: false });
    window.addEventListener('resize', function () { resizeCanvas(); draw(); });
    var reset = byId('atlas-reset');
    if (reset) reset.addEventListener('click', function () { selectNode(null); resizeCanvas(); fitView(); draw(); });
    var top = byId('atlas-top');
    if (top) top.addEventListener('change', function () { load(); });
  }

  function currentTop() {
    var top = byId('atlas-top');
    return top ? top.value : '50';
  }

  async function load() {
    try {
      setText('atlas-status', 'Loading…');
      var qs = '?top=' + encodeURIComponent(currentTop());
      var res = await fetch('/atlas/graph.json' + qs, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('graph.json HTTP ' + res.status);
      var g = await res.json();

      setText('atlas-overview', g.repoName + ' · ' + g.graphKind + ' · ' + g.totals.nodes + ' nodes / ' + g.totals.edges + ' edges');

      var banner = byId('atlas-banner');
      if (banner) {
        if (g.truncated && g.truncation && g.truncation.message) {
          banner.textContent = g.truncation.message;
          banner.classList.remove('atlas-hidden');
        } else {
          banner.textContent = '';
          banner.classList.add('atlas-hidden');
        }
      }

      if (!g.hasGraph || g.nodes.length === 0) {
        model = { nodes: [], edges: [], pos: {}, screen: {}, sel: null, neighbors: {} };
        setText('atlas-status', g.note || 'No graph to display.');
        resizeCanvas(); draw();
        return;
      }

      model.nodes = g.nodes;
      model.edges = g.edges;
      model.pos = layout(g);
      model.sel = null; model.neighbors = {};
      setText('atlas-status', '');
      var st = byId('atlas-status'); if (st) st.classList.add('atlas-hidden');
      resizeCanvas(); fitView(); draw();
    } catch (err) {
      var st2 = byId('atlas-status'); if (st2) st2.classList.remove('atlas-hidden');
      setText('atlas-status', 'Could not load Atlas data: ' + (err && err.message ? err.message : String(err)));
    }
  }

  attach();
  load();
})();
`;

export const ATLAS_APP_CSS = `:root { color-scheme: light dark; }
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  background: Canvas;
  color: CanvasText;
  display: flex;
  flex-direction: column;
}
.atlas-header { padding: 16px 24px 12px; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }
.atlas-header h1 { margin: 0; font-size: 19px; }
.atlas-sub { margin: 4px 0 0; opacity: 0.7; font-size: 13px; }
.atlas-controls {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 24px; border-bottom: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
  font-size: 13px;
}
.atlas-overview-line { font-variant-numeric: tabular-nums; opacity: 0.85; }
.atlas-spacer { flex: 1; }
.atlas-ctl {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 13px; padding: 4px 8px;
  border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
  border-radius: 6px; background: transparent; color: inherit; cursor: pointer;
}
.atlas-ctl select { background: transparent; color: inherit; border: 0; font: inherit; cursor: pointer; }
.atlas-banner {
  padding: 8px 24px; font-size: 13px;
  background: color-mix(in srgb, #b8860b 18%, transparent);
  border-bottom: 1px solid color-mix(in srgb, #b8860b 40%, transparent);
}
.atlas-hidden { display: none !important; }
.atlas-stage { position: relative; flex: 1; min-height: 360px; }
.atlas-canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.atlas-canvas:active { cursor: grabbing; }
.atlas-status {
  position: absolute; top: 12px; left: 24px; margin: 0;
  font-style: italic; opacity: 0.8;
}
.atlas-legend {
  position: absolute; right: 16px; bottom: 16px;
  padding: 10px 12px; font-size: 12px; line-height: 1.7;
  background: color-mix(in srgb, Canvas 86%, transparent);
  border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
  border-radius: 8px; backdrop-filter: blur(3px); max-width: 260px;
}
.atlas-legend-title { font-weight: 600; margin-bottom: 4px; }
.atlas-legend ul { list-style: none; margin: 0 0 6px; padding: 0; }
.atlas-legend li { display: flex; align-items: center; gap: 6px; opacity: 0.85; }
.atlas-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; }
.atlas-g-source { background: #3b82f6; }
.atlas-g-test { background: #22c55e; }
.atlas-g-docs { background: #a855f7; }
.atlas-g-example { background: #06b6d4; }
.atlas-g-generated { background: #9ca3af; }
.atlas-g-other { background: #f59e0b; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;
