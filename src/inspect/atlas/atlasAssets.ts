/**
 * Atlas same-origin browser assets (v1.5.0, PR 5 — 2D + 3D architecture map).
 *
 * Served from `/atlas/app.js` and `/atlas/app.css` so the page satisfies
 * `script-src 'self'; style-src 'self'` with NO inline script or style.
 *
 * `app.js` is a self-authored, dependency-free renderer with two production
 * views over the SAME `/atlas/graph.json` payload (PR-2 projection, consumed
 * as-is):
 *   - 2D: pan/zoom/click on an HTML5 canvas (default).
 *   - 3D: a hand-written perspective projection onto the same 2D canvas —
 *     no three.js, no WebGL library, no CDN. Rotate/zoom/pan, depth-sorted
 *     painter's-algorithm draw, reset-camera.
 *
 * Both layouts are deterministic: seeded (mulberry32, seed = FNV hash of node
 * id) fixed-iteration force simulations. No `Math.random`, no animation-timer
 * dependence — the same payload lays out identically every load.
 *
 * Safety: no `eval`, no `Function`, no remote URLs, no `innerHTML`. The only
 * network call is a same-origin `fetch('/atlas/graph.json')`
 * (`connect-src 'self'`). Labels are drawn via canvas `fillText`.
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
  var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  var mode = '2d';
  var view = { scale: 1, tx: 0, ty: 0 };                 // 2D pan/zoom
  var cam = { yaw: 0.6, pitch: 0.5, dist: 700, panX: 0, panY: 0 }; // 3D camera
  var SALIENCE_HI = 0.5; // "high salience" threshold for the filter chip
  function emptyFilters() {
    return {
      source: false, changed: false, risk: false, salience: false,
      checkpoint: false, session: false,
      hideDocs: false, hideTests: false, hideExamples: false, hideGenerated: false
    };
  }
  var model = {
    nodes: [], edges: [], pos2: {}, pos3: {}, screen: {}, sel: null, neighbors: {},
    filters: emptyFilters(), query: '', matches: {}, matchNeighbors: {}, byId: {}
  };

  function radiusOf(n) { return 4 + (n.salience || 0) * 18; }
  function clampScale(s) { return Math.max(0.6, Math.min(1.6, s)); }

  // ---- filters: a node is visible if it passes all active "hide" toggles
  //      AND (no "focus" toggle active, OR it matches at least one) ----------
  function isVisible(n) {
    var f = model.filters;
    if (f.hideDocs && n.group === 'docs') return false;
    if (f.hideTests && n.group === 'test') return false;
    if (f.hideExamples && n.group === 'example') return false;
    if (f.hideGenerated && n.group === 'generated') return false;
    var focus = [];
    if (f.source) focus.push(n.group === 'source');
    if (f.changed) focus.push(!!(n.flags && n.flags.changed));
    if (f.risk) focus.push(n.risk === 'medium' || n.risk === 'high');
    if (f.salience) focus.push((n.salience || 0) >= SALIENCE_HI);
    if (f.checkpoint) focus.push(!!(n.flags && n.flags.checkpoint));
    if (f.session) focus.push(!!(n.flags && n.flags.session));
    if (focus.length === 0) return true;
    for (var i = 0; i < focus.length; i++) if (focus[i]) return true;
    return false;
  }

  // ---- search: match by id or label substring; track matched + neighbours --
  function recomputeMatches() {
    model.matches = {}; model.matchNeighbors = {};
    var q = (model.query || '').trim().toLowerCase();
    if (!q) return;
    for (var i = 0; i < model.nodes.length; i++) {
      var n = model.nodes[i];
      if (!isVisible(n)) continue;
      if (n.id.toLowerCase().indexOf(q) !== -1 || (n.label || '').toLowerCase().indexOf(q) !== -1) {
        model.matches[n.id] = true;
      }
    }
    for (var e = 0; e < model.edges.length; e++) {
      var ed = model.edges[e];
      if (model.matches[ed.from]) model.matchNeighbors[ed.to] = true;
      if (model.matches[ed.to]) model.matchNeighbors[ed.from] = true;
    }
  }

  // ===== 2D layout (seeded force) =========================================
  function layout2d(graph) {
    var n = graph.nodes.length, pos = {};
    for (var i = 0; i < n; i++) {
      var node = graph.nodes[i], rnd = mulberry32(hashStr(node.id));
      var ang = (i / Math.max(1, n)) * Math.PI * 2, rad = 160 + rnd() * 160;
      pos[node.id] = { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad, vx: 0, vy: 0 };
    }
    var ITER = n > 160 ? 160 : 240;
    for (var it = 0; it < ITER; it++) {
      for (var a = 0; a < n; a++) {
        var A = pos[graph.nodes[a].id];
        for (var b = a + 1; b < n; b++) {
          var B = pos[graph.nodes[b].id];
          var dx = A.x - B.x, dy = A.y - B.y, d2 = dx * dx + dy * dy; if (d2 < 0.01) d2 = 0.01;
          var d = Math.sqrt(d2), f = 5200 / d2, ux = dx / d, uy = dy / d;
          A.vx += ux * f; A.vy += uy * f; B.vx -= ux * f; B.vy -= uy * f;
        }
      }
      for (var e = 0; e < graph.edges.length; e++) {
        var ed = graph.edges[e], P = pos[ed.from], Q = pos[ed.to]; if (!P || !Q) continue;
        var ex = Q.x - P.x, ey = Q.y - P.y, el = Math.sqrt(ex * ex + ey * ey) || 1;
        var fa = (el - 90) * 0.018 * (1 + Math.log(1 + (ed.weight || 1)));
        var ax = ex / el, ay = ey / el;
        P.vx += ax * fa; P.vy += ay * fa; Q.vx -= ax * fa; Q.vy -= ay * fa;
      }
      for (var k = 0; k < n; k++) {
        var p = pos[graph.nodes[k].id]; p.vx *= 0.85; p.vy *= 0.85;
        p.x += Math.max(-14, Math.min(14, p.vx)); p.y += Math.max(-14, Math.min(14, p.vy));
        p.x -= p.x * 0.0009; p.y -= p.y * 0.0009;
      }
    }
    return pos;
  }

  // ===== 3D layout (seeded force in 3 dimensions) =========================
  function layout3d(graph) {
    var n = graph.nodes.length, pos = {};
    for (var i = 0; i < n; i++) {
      var node = graph.nodes[i], rnd = mulberry32(hashStr(node.id) ^ 0x9e3779b9);
      // seeded point on a sphere shell
      var u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, r = 150 + rnd() * 90;
      var sq = Math.sqrt(1 - u * u);
      pos[node.id] = { x: r * sq * Math.cos(th), y: r * sq * Math.sin(th), z: r * u, vx: 0, vy: 0, vz: 0 };
    }
    var ITER = n > 160 ? 130 : 200;
    for (var it = 0; it < ITER; it++) {
      for (var a = 0; a < n; a++) {
        var A = pos[graph.nodes[a].id];
        for (var b = a + 1; b < n; b++) {
          var B = pos[graph.nodes[b].id];
          var dx = A.x - B.x, dy = A.y - B.y, dz = A.z - B.z;
          var d2 = dx * dx + dy * dy + dz * dz; if (d2 < 0.01) d2 = 0.01;
          var d = Math.sqrt(d2), f = 6000 / d2, ux = dx / d, uy = dy / d, uz = dz / d;
          A.vx += ux * f; A.vy += uy * f; A.vz += uz * f;
          B.vx -= ux * f; B.vy -= uy * f; B.vz -= uz * f;
        }
      }
      for (var e = 0; e < graph.edges.length; e++) {
        var ed = graph.edges[e], P = pos[ed.from], Q = pos[ed.to]; if (!P || !Q) continue;
        var ex = Q.x - P.x, ey = Q.y - P.y, ez = Q.z - P.z, el = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
        var fa = (el - 100) * 0.016 * (1 + Math.log(1 + (ed.weight || 1)));
        var ax = ex / el, ay = ey / el, az = ez / el;
        P.vx += ax * fa; P.vy += ay * fa; P.vz += az * fa;
        Q.vx -= ax * fa; Q.vy -= ay * fa; Q.vz -= az * fa;
      }
      for (var k = 0; k < n; k++) {
        var p = pos[graph.nodes[k].id];
        p.vx *= 0.84; p.vy *= 0.84; p.vz *= 0.84;
        p.x += Math.max(-14, Math.min(14, p.vx));
        p.y += Math.max(-14, Math.min(14, p.vy));
        p.z += Math.max(-14, Math.min(14, p.vz));
        p.x -= p.x * 0.0009; p.y -= p.y * 0.0009; p.z -= p.z * 0.0009;
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

  // ---- 2D camera fit ------------------------------------------------------
  function fitView() {
    if (!canvas) return;
    if (model.nodes.length === 0) { view = { scale: 1, tx: canvas.width / 2, ty: canvas.height / 2 }; return; }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < model.nodes.length; i++) {
      var p = model.pos2[model.nodes[i].id]; if (!p) continue;
      if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
    }
    var w = (maxX - minX) || 1, h = (maxY - minY) || 1, pad = 60 * dpr;
    view.scale = Math.max(0.05, Math.min(4, Math.min((canvas.width - pad * 2) / w, (canvas.height - pad * 2) / h)));
    view.tx = canvas.width / 2 - ((minX + maxX) / 2) * view.scale;
    view.ty = canvas.height / 2 - ((minY + maxY) / 2) * view.scale;
  }
  function resetCamera() { cam = { yaw: 0.6, pitch: 0.5, dist: 700, panX: 0, panY: 0 }; }

  function worldToScreen2(p) { return { x: p.x * view.scale + view.tx, y: p.y * view.scale + view.ty }; }

  // ---- 3D perspective projection -----------------------------------------
  function project3(p) {
    var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    var x1 = p.x * cy + p.z * sy, z1 = -p.x * sy + p.z * cy, y1 = p.y;
    var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    var y2 = y1 * cp - z1 * sp, z2 = y1 * sp + z1 * cp, x2 = x1;
    var denom = cam.dist - z2; if (denom < 1) denom = 1;
    var focal = cam.dist; // ~unit scale at z=0
    var s = (focal / denom) * dpr;
    return {
      x: canvas.width / 2 + x2 * s + cam.panX * dpr,
      y: canvas.height / 2 + y2 * s + cam.panY * dpr,
      s: focal / denom,
      depth: z2
    };
  }

  function draw() { if (mode === '3d') draw3d(); else draw2d(); }

  function draw2d() {
    if (!ctx || !canvas) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var hasSel = !!model.sel;
    var vis = visibleSet();
    for (var i = 0; i < model.edges.length; i++) {
      var ed = model.edges[i];
      if (!vis[ed.from] || !vis[ed.to]) continue;
      var P = model.pos2[ed.from], Q = model.pos2[ed.to]; if (!P || !Q) continue;
      var sp = worldToScreen2(P), sq = worldToScreen2(Q);
      var active = hasSel && (ed.from === model.sel || ed.to === model.sel);
      ctx.strokeStyle = active ? 'rgba(59,130,246,0.85)' : (hasSel ? 'rgba(140,140,140,0.10)' : 'rgba(140,140,140,0.28)');
      ctx.lineWidth = (active ? 1.6 : 1) * dpr;
      ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(sq.x, sq.y); ctx.stroke();
    }
    model.screen = {};
    for (var j = 0; j < model.nodes.length; j++) {
      var n = model.nodes[j]; if (!vis[n.id]) continue;
      var p = model.pos2[n.id]; if (!p) continue;
      var s = worldToScreen2(p); model.screen[n.id] = s;
      drawNode(n, s.x, s.y, radiusOf(n) * clampScale(view.scale), hasSel);
    }
    ctx.globalAlpha = 1;
  }

  // Set of node ids currently passing the filters (computed once per draw).
  function visibleSet() {
    var v = {};
    for (var i = 0; i < model.nodes.length; i++) {
      if (isVisible(model.nodes[i])) v[model.nodes[i].id] = true;
    }
    return v;
  }

  function draw3d() {
    if (!ctx || !canvas) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    var hasSel = !!model.sel;
    var vis = visibleSet();

    // project all visible nodes once
    var proj = {};
    for (var i = 0; i < model.nodes.length; i++) {
      var n = model.nodes[i]; if (!vis[n.id]) continue;
      var p = model.pos3[n.id]; if (!p) continue;
      proj[n.id] = project3(p);
    }
    model.screen = proj;

    // edges (drawn first, dimmed)
    for (var e = 0; e < model.edges.length; e++) {
      var ed = model.edges[e], A = proj[ed.from], B = proj[ed.to]; if (!A || !B) continue;
      var active = hasSel && (ed.from === model.sel || ed.to === model.sel);
      ctx.strokeStyle = active ? 'rgba(59,130,246,0.8)' : (hasSel ? 'rgba(140,140,140,0.07)' : 'rgba(140,140,140,0.18)');
      ctx.lineWidth = (active ? 1.5 : 0.8) * dpr;
      ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
    }

    // nodes back-to-front (painter's algorithm): larger depth = farther
    var order = model.nodes.slice().sort(function (a, b) {
      var pa = proj[a.id], pb = proj[b.id];
      return (pb ? pb.depth : 0) - (pa ? pa.depth : 0);
    });
    for (var k = 0; k < order.length; k++) {
      var nd = order[k], pr = proj[nd.id]; if (!pr) continue;
      drawNode(nd, pr.x, pr.y, radiusOf(nd) * Math.max(0.45, Math.min(1.8, pr.s)), hasSel);
    }
    ctx.globalAlpha = 1;
  }

  // shared node draw (screen coords + radius supplied by the caller)
  function drawNode(n, x, y, r, hasSel) {
    var hasQuery = !!(model.query && model.query.trim());
    var isMatch = hasQuery && model.matches[n.id];
    var isMatchN = hasQuery && model.matchNeighbors[n.id];
    var dim;
    if (hasQuery) dim = !isMatch && !isMatchN;
    else dim = hasSel && n.id !== model.sel && !model.neighbors[n.id];
    ctx.globalAlpha = dim ? 0.16 : 1;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = GROUP_COLORS[n.group] || GROUP_COLORS.other; ctx.fill();
    var ring = n.risk ? RISK_RING[n.risk] : '';
    if (ring) { ctx.lineWidth = 2 * dpr; ctx.strokeStyle = ring; ctx.stroke(); }
    if (isMatch) {
      // bright search-match halo (drawn over any risk ring)
      ctx.lineWidth = 2.5 * dpr; ctx.strokeStyle = '#f59e0b';
      ctx.beginPath(); ctx.arc(x, y, r + 3 * dpr, 0, Math.PI * 2); ctx.stroke();
    }
    if (n.flags && n.flags.changed) {
      ctx.beginPath(); ctx.arc(x + r * 0.8, y - r * 0.8, 2.2 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#111827'; ctx.fill();
    }
    ctx.globalAlpha = 1;
    var showLabel = r > 9 * dpr || n.id === model.sel || model.neighbors[n.id] || isMatch;
    if (showLabel) {
      ctx.fillStyle = 'rgba(80,80,80,0.95)';
      ctx.font = (11 * dpr) + 'px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(n.label, x + r + 3 * dpr, y + 3 * dpr);
    }
  }

  function selectNode(id) {
    model.sel = id; model.neighbors = {};
    if (id) {
      for (var i = 0; i < model.edges.length; i++) {
        var ed = model.edges[i];
        if (ed.from === id) model.neighbors[ed.to] = true;
        if (ed.to === id) model.neighbors[ed.from] = true;
      }
    }
    updateDetail(id);
    draw();
  }

  // ---- node detail panel (client-side, from the delivered payload) -------
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function hideDetail() {
    var box = byId('atlas-detail'); if (box) { box.textContent = ''; box.classList.add('atlas-hidden'); }
  }
  function labelOf(id) { var n = model.byId[id]; return n ? n.label : id; }

  function updateDetail(id) {
    var box = byId('atlas-detail'); if (!box) return;
    if (!id) { hideDetail(); return; }
    var n = model.byId[id]; if (!n) { hideDetail(); return; }
    box.textContent = '';

    var head = el('div', 'atlas-detail-head');
    head.appendChild(el('span', 'atlas-detail-title', n.label));
    var close = el('button', 'atlas-detail-close', '×');
    close.setAttribute('type', 'button');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', function () { selectNode(null); });
    head.appendChild(close);
    box.appendChild(head);

    box.appendChild(el('div', 'atlas-detail-id', n.id));

    // group + flag badges
    var badges = el('div', 'atlas-detail-badges');
    badges.appendChild(el('span', 'atlas-badge atlas-badge-group', n.group));
    if (n.risk) badges.appendChild(el('span', 'atlas-badge atlas-badge-risk-' + n.risk, 'risk: ' + n.risk));
    if (n.flags && n.flags.changed) badges.appendChild(el('span', 'atlas-badge', 'changed'));
    if (n.flags && n.flags.checkpoint) badges.appendChild(el('span', 'atlas-badge', 'checkpoint'));
    if (n.flags && n.flags.session) badges.appendChild(el('span', 'atlas-badge', 'session'));
    box.appendChild(badges);

    // metrics grid
    var metrics = el('dl', 'atlas-detail-metrics');
    var addMetric = function (k, v) { metrics.appendChild(el('dt', null, k)); metrics.appendChild(el('dd', null, v)); };
    addMetric('salience', String(n.salience));
    addMetric('centrality', String(n.centrality));
    addMetric('fan-in', String(n.fanIn));
    addMetric('fan-out', String(n.fanOut));
    box.appendChild(metrics);

    // edges
    var incoming = [], outgoing = [];
    for (var i = 0; i < model.edges.length; i++) {
      var ed = model.edges[i];
      if (ed.to === id) incoming.push(ed);
      if (ed.from === id) outgoing.push(ed);
    }
    incoming.sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; });
    outgoing.sort(function (a, b) { return a.to < b.to ? -1 : a.to > b.to ? 1 : 0; });

    box.appendChild(edgeSection('Depends on (out: ' + outgoing.length + ')', outgoing, 'to'));
    box.appendChild(edgeSection('Depended on by (in: ' + incoming.length + ')', incoming, 'from'));

    box.classList.remove('atlas-hidden');
  }

  function edgeSection(title, edges, endKey) {
    var sec = el('div', 'atlas-detail-section');
    sec.appendChild(el('div', 'atlas-detail-subtitle', title));
    if (edges.length === 0) { sec.appendChild(el('div', 'atlas-detail-empty', 'none')); return sec; }
    var ul = el('ul', 'atlas-detail-edges');
    for (var i = 0; i < edges.length; i++) {
      var other = edges[i][endKey];
      var li = el('li', null);
      var link = el('button', 'atlas-edge-link', labelOf(other));
      link.setAttribute('type', 'button');
      (function (oid) { link.addEventListener('click', function () { focusNode(oid); }); })(other);
      li.appendChild(link);
      if (edges[i].weight && edges[i].weight > 1) li.appendChild(el('span', 'atlas-edge-w', ' ×' + edges[i].weight));
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    return sec;
  }

  function hitTest(sx, sy) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < model.nodes.length; i++) {
      var n = model.nodes[i], s = model.screen[n.id]; if (!s) continue;
      if (!isVisible(n)) continue;
      var base = radiusOf(n);
      var r = (mode === '3d') ? base * Math.max(0.45, Math.min(1.8, s.s || 1)) : base * clampScale(view.scale);
      var dx = sx - s.x, dy = sy - s.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d <= r + 4 * dpr && d < bestD) { best = n.id; bestD = d; }
    }
    return best;
  }

  // ---- interaction --------------------------------------------------------
  function attach() {
    if (!canvas) return;
    var dragging = false, moved = false, lastX = 0, lastY = 0, shiftDrag = false;
    canvas.addEventListener('pointerdown', function (ev) {
      dragging = true; moved = false; shiftDrag = ev.shiftKey;
      lastX = ev.clientX; lastY = ev.clientY; canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      var dx = ev.clientX - lastX, dy = ev.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      lastX = ev.clientX; lastY = ev.clientY;
      if (mode === '3d') {
        if (shiftDrag) { cam.panX += dx; cam.panY += dy; }
        else {
          cam.yaw += dx * 0.01;
          cam.pitch += dy * 0.01;
          var lim = Math.PI / 2 - 0.05;
          if (cam.pitch > lim) cam.pitch = lim; if (cam.pitch < -lim) cam.pitch = -lim;
        }
      } else { view.tx += dx * dpr; view.ty += dy * dpr; }
      draw();
    });
    canvas.addEventListener('pointerup', function (ev) {
      dragging = false;
      if (!moved) {
        var rect = canvas.getBoundingClientRect();
        selectNode(hitTest((ev.clientX - rect.left) * dpr, (ev.clientY - rect.top) * dpr));
      }
    });
    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      if (mode === '3d') {
        var f = ev.deltaY < 0 ? 1 / 1.12 : 1.12;
        cam.dist = Math.max(180, Math.min(3000, cam.dist * f));
      } else {
        var rect = canvas.getBoundingClientRect();
        var mx = (ev.clientX - rect.left) * dpr, my = (ev.clientY - rect.top) * dpr;
        var factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        var ns = Math.max(0.05, Math.min(6, view.scale * factor));
        view.tx = mx - (mx - view.tx) * (ns / view.scale);
        view.ty = my - (my - view.ty) * (ns / view.scale);
        view.scale = ns;
      }
      draw();
    }, { passive: false });
    window.addEventListener('resize', function () { resizeCanvas(); draw(); });

    var reset = byId('atlas-reset');
    if (reset) reset.addEventListener('click', function () {
      selectNode(null);
      clearSearch();
      clearFilters();
      resizeCanvas();
      if (mode === '3d') resetCamera(); else fitView();
      draw();
    });
    var top = byId('atlas-top');
    if (top) top.addEventListener('change', function () { load(); });
    var m2 = byId('atlas-mode-2d'), m3 = byId('atlas-mode-3d');
    if (m2) m2.addEventListener('click', function () { setMode('2d'); });
    if (m3) m3.addEventListener('click', function () { setMode('3d'); });

    // ---- search ----------------------------------------------------------
    var search = byId('atlas-search');
    if (search) {
      search.addEventListener('input', function () {
        model.query = search.value || '';
        recomputeMatches();
        renderResults();
        draw();
      });
      search.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') { search.value = ''; model.query = ''; recomputeMatches(); renderResults(); draw(); search.blur(); }
      });
    }
    // '/' focuses search (unless already typing in it)
    document.addEventListener('keydown', function (ev) {
      if (ev.key === '/' && document.activeElement !== search) {
        ev.preventDefault();
        if (search) search.focus();
      }
    });

    // ---- filter chips ----------------------------------------------------
    var chips = document.querySelectorAll('[data-filter]');
    for (var c = 0; c < chips.length; c++) {
      (function (chip) {
        chip.addEventListener('click', function () {
          var key = chip.getAttribute('data-filter');
          model.filters[key] = !model.filters[key];
          chip.classList.toggle('atlas-chip-active', !!model.filters[key]);
          // selection/search may now reference hidden nodes — recompute matches.
          recomputeMatches(); renderResults(); draw();
        });
      })(chips[c]);
    }
  }

  function clearSearch() {
    model.query = ''; model.matches = {}; model.matchNeighbors = {};
    var search = byId('atlas-search'); if (search) search.value = '';
    renderResults();
  }
  function clearFilters() {
    model.filters = emptyFilters();
    var chips = document.querySelectorAll('[data-filter]');
    for (var i = 0; i < chips.length; i++) chips[i].classList.remove('atlas-chip-active');
  }

  // Render the search result list (matched node labels; click to focus).
  function renderResults() {
    var box = byId('atlas-results'); if (!box) return;
    box.textContent = '';
    var ids = Object.keys(model.matches);
    if (ids.length === 0) { box.classList.add('atlas-hidden'); return; }
    ids.sort();
    var shown = ids.slice(0, 12);
    for (var i = 0; i < shown.length; i++) {
      (function (id) {
        var item = document.createElement('div');
        item.className = 'atlas-result';
        item.setAttribute('role', 'option');
        item.textContent = id;
        item.addEventListener('click', function () { focusNode(id); });
        box.appendChild(item);
      })(shown[i]);
    }
    if (ids.length > shown.length) {
      var more = document.createElement('div');
      more.className = 'atlas-result atlas-result-more';
      more.textContent = '+' + (ids.length - shown.length) + ' more';
      box.appendChild(more);
    }
    box.classList.remove('atlas-hidden');
  }

  // Select a node and center the view on it (2D pans; 3D just selects).
  function focusNode(id) {
    selectNode(id);
    if (mode === '2d') {
      var p = model.pos2[id];
      if (p && canvas) { view.tx = canvas.width / 2 - p.x * view.scale; view.ty = canvas.height / 2 - p.y * view.scale; }
    }
    draw();
  }

  function setMode(m) {
    if (m === mode) return;
    mode = m;
    var m2 = byId('atlas-mode-2d'), m3 = byId('atlas-mode-3d');
    if (m2) m2.classList.toggle('atlas-mode-active', m === '2d');
    if (m3) m3.classList.toggle('atlas-mode-active', m === '3d');
    resizeCanvas();
    if (mode === '3d') { if (Object.keys(model.pos3).length === 0 && model.nodes.length) model.pos3 = layout3d({ nodes: model.nodes, edges: model.edges }); resetCamera(); }
    else { fitView(); }
    draw();
  }

  function currentTop() { var t = byId('atlas-top'); return t ? t.value : '50'; }

  async function load() {
    try {
      setText('atlas-status', 'Loading…');
      var st0 = byId('atlas-status'); if (st0) st0.classList.remove('atlas-hidden');
      var res = await fetch('/atlas/graph.json' + '?top=' + encodeURIComponent(currentTop()), { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('graph.json HTTP ' + res.status);
      var g = await res.json();

      setText('atlas-overview', g.repoName + ' · ' + g.graphKind + ' · ' + g.totals.nodes + ' nodes / ' + g.totals.edges + ' edges');
      var banner = byId('atlas-banner');
      if (banner) {
        if (g.truncated && g.truncation && g.truncation.message) { banner.textContent = g.truncation.message; banner.classList.remove('atlas-hidden'); }
        else { banner.textContent = ''; banner.classList.add('atlas-hidden'); }
      }

      if (!g.hasGraph || g.nodes.length === 0) {
        model = {
          nodes: [], edges: [], pos2: {}, pos3: {}, screen: {}, sel: null, neighbors: {},
          filters: emptyFilters(), query: '', matches: {}, matchNeighbors: {}, byId: {}
        };
        clearSearch(); clearFilters(); hideDetail();
        setText('atlas-status', g.note || 'No graph to display.');
        resizeCanvas(); draw(); return;
      }

      model.nodes = g.nodes; model.edges = g.edges;
      model.byId = {};
      for (var bi = 0; bi < g.nodes.length; bi++) model.byId[g.nodes[bi].id] = g.nodes[bi];
      model.pos2 = layout2d(g);
      model.pos3 = (mode === '3d') ? layout3d(g) : {};
      model.sel = null; model.neighbors = {};
      model.query = ''; model.matches = {}; model.matchNeighbors = {};
      clearSearch(); hideDetail();
      setText('atlas-status', '');
      var st = byId('atlas-status'); if (st) st.classList.add('atlas-hidden');
      resizeCanvas();
      if (mode === '3d') resetCamera(); else fitView();
      draw();
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
  font-size: 13px; flex-wrap: wrap;
}
.atlas-overview-line { font-variant-numeric: tabular-nums; opacity: 0.85; }
.atlas-spacer { flex: 1; }
.atlas-modes { display: inline-flex; gap: 4px; }
.atlas-ctl {
  display: inline-flex; align-items: center; gap: 6px;
  font: inherit; padding: 4px 10px;
  border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
  border-radius: 6px; background: transparent; color: inherit; cursor: pointer;
}
/* Explicit Canvas/CanvasText so the native option popup is readable in both
   light and dark themes. A transparent/inherited select renders the dropdown
   list white-on-white in dark mode (the OS popup background ignores
   'transparent'); pinning both colours fixes the contrast. */
.atlas-ctl select {
  background: Canvas;
  color: CanvasText;
  border: 0;
  font: inherit;
  cursor: pointer;
}
.atlas-ctl select option {
  background: Canvas;
  color: CanvasText;
}
.atlas-mode-active {
  background: color-mix(in srgb, #3b82f6 22%, transparent);
  border-color: color-mix(in srgb, #3b82f6 60%, transparent);
}
.atlas-controls-filters { gap: 8px; }
.atlas-search-wrap { position: relative; }
.atlas-search {
  background: Canvas; color: CanvasText;
  border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
  border-radius: 6px; padding: 5px 10px; font: inherit; min-width: 220px;
}
.atlas-search::placeholder { color: color-mix(in srgb, CanvasText 50%, transparent); }
.atlas-results {
  position: absolute; top: 100%; left: 0; margin-top: 4px; z-index: 5;
  min-width: 220px; max-height: 240px; overflow: auto;
  background: Canvas; color: CanvasText;
  border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
  border-radius: 8px; box-shadow: 0 6px 20px color-mix(in srgb, CanvasText 25%, transparent);
}
.atlas-result { padding: 6px 10px; cursor: pointer; font-size: 13px; }
.atlas-result:hover { background: color-mix(in srgb, #3b82f6 18%, transparent); }
.atlas-result-more { opacity: 0.6; cursor: default; font-style: italic; }
.atlas-result-more:hover { background: transparent; }
.atlas-filters { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.atlas-chip {
  font: inherit; font-size: 12px; padding: 3px 9px;
  border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
  border-radius: 999px; background: transparent; color: inherit; cursor: pointer; opacity: 0.85;
}
.atlas-chip:hover { opacity: 1; }
.atlas-chip-active {
  background: color-mix(in srgb, #3b82f6 22%, transparent);
  border-color: color-mix(in srgb, #3b82f6 60%, transparent);
  opacity: 1;
}
.atlas-banner {
  padding: 8px 24px; font-size: 13px;
  background: color-mix(in srgb, #b8860b 18%, transparent);
  border-bottom: 1px solid color-mix(in srgb, #b8860b 40%, transparent);
}
.atlas-hidden { display: none !important; }
.atlas-stage { position: relative; flex: 1; min-height: 360px; }
.atlas-canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.atlas-canvas:active { cursor: grabbing; }
.atlas-status { position: absolute; top: 12px; left: 24px; margin: 0; font-style: italic; opacity: 0.8; }
.atlas-legend {
  position: absolute; right: 16px; bottom: 16px;
  padding: 10px 12px; font-size: 12px; line-height: 1.7;
  background: color-mix(in srgb, Canvas 86%, transparent);
  border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
  border-radius: 8px; backdrop-filter: blur(3px); max-width: 280px;
}
.atlas-detail {
  position: absolute; top: 16px; left: 16px; z-index: 6;
  width: 280px; max-height: calc(100% - 32px); overflow: auto;
  padding: 14px 16px;
  background: color-mix(in srgb, Canvas 92%, transparent);
  color: CanvasText;
  border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
  border-radius: 10px; box-shadow: 0 8px 28px color-mix(in srgb, CanvasText 28%, transparent);
  backdrop-filter: blur(4px); font-size: 13px;
}
.atlas-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.atlas-detail-title { font-size: 15px; font-weight: 700; word-break: break-word; }
.atlas-detail-close {
  border: 0; background: transparent; color: inherit; cursor: pointer;
  font-size: 18px; line-height: 1; padding: 0 4px; opacity: 0.7;
}
.atlas-detail-close:hover { opacity: 1; }
.atlas-detail-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; opacity: 0.65; margin-top: 2px; word-break: break-all; }
.atlas-detail-badges { display: flex; flex-wrap: wrap; gap: 4px; margin: 10px 0; }
.atlas-badge {
  font-size: 11px; padding: 2px 7px; border-radius: 999px;
  background: color-mix(in srgb, CanvasText 12%, transparent);
}
.atlas-badge-group { background: color-mix(in srgb, #3b82f6 22%, transparent); }
.atlas-badge-risk-medium { background: color-mix(in srgb, #d97706 30%, transparent); }
.atlas-badge-risk-high { background: color-mix(in srgb, #dc2626 32%, transparent); }
.atlas-detail-metrics {
  display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px;
  margin: 8px 0 4px;
}
.atlas-detail-metrics dt { opacity: 0.6; }
.atlas-detail-metrics dd { margin: 0; font-variant-numeric: tabular-nums; }
.atlas-detail-section { margin-top: 12px; }
.atlas-detail-subtitle { font-weight: 600; font-size: 12px; opacity: 0.8; margin-bottom: 4px; }
.atlas-detail-empty { opacity: 0.5; font-style: italic; font-size: 12px; }
.atlas-detail-edges { list-style: none; margin: 0; padding: 0; }
.atlas-detail-edges li { display: flex; align-items: baseline; gap: 2px; }
.atlas-edge-link {
  border: 0; background: transparent; color: #3b82f6; cursor: pointer;
  font: inherit; padding: 2px 0; text-align: left;
}
.atlas-edge-link:hover { text-decoration: underline; }
.atlas-edge-w { opacity: 0.55; font-size: 11px; }
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
