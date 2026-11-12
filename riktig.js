// Riktiga vägar: hämtar vägar och hus runt en plats från OpenStreetMap och gör en körning av dem.
// Kartdata © OpenStreetMap-bidragsgivare, fri att använda under ODbL; spelet skriver ut det.
// The drive is the game's usual chain of pieces: a road with the real road's bends and houses, then
// the real junction or roundabout, drawn the game's way (arms at right angles). The next road is
// worked out once the car has left the junction, so a wrong turn goes on along the real road taken.
// Coordinates are metres with x east and y south, as in the game; a heading a points along
// (sin a, -cos a), and u is sideways, plus to the right.
"use strict";
(function () {
  // Public map servers, tried in turn: a busy one answers with an error or not at all.
  // The main one often answers "busy" at once and does fine a moment later, so it is asked twice first.
  var OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
  var SEARCH = "https://nominatim.openstreetmap.org/search";
  var ROADS = "trunk|primary|secondary|tertiary|unclassified|residential|living_street|road|trunk_link|primary_link|secondary_link|tertiary_link";
  var RANK = { trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, road: 2, residential: 1, living_street: 0 };
  var R_ROADS = 1200, R_HOUSES = 1000, R_DRIVE = 900;    // metres around the place
  var RR = R_ROADS, RD = R_DRIVE;                        // the radii of the area being driven (bigger for a packed map)
  var DW = 2;                                            // the game's bend step (spel.js bendPiece)
  var DEG = Math.PI / 180, RND = Math.random;
  var WORD = { "0": "köra rakt fram", "1": "svänga höger", "-1": "svänga vänster" };
  var HINTS = {
    hoger: "Där gäller högerregeln.", stopp: "Där är det stopplikt, stanna helt vid linjen.", vaj: "Vi har väjningsplikt där.",
    huvud: "De från sidan har väjningsplikt.", ljus: "Där är det trafikljus."
  };
  var GOOD = ["Bra!", "Snyggt.", "Fint kört."];
  function pick(a) { return a[Math.floor(RND() * a.length)]; }
  function angDiff(a, b) { var d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
  function headingOf(dx, dy) { return Math.atan2(dx, -dy); }
  function r1(v) { return Math.round(v * 10) / 10; }

  // ---------- fetching ----------
  function search(text) {
    var url = SEARCH + "?format=jsonv2&limit=6&countrycodes=se&accept-language=sv&q=" + encodeURIComponent(text);
    return fetch(url).then(function (r) { if (!r.ok) throw new Error("search " + r.status); return r.json(); }).then(function (list) {
      var seen = {};
      return list.map(function (x) {
        var parts = x.display_name.split(", ").filter(function (p) { return !/^\d{3} ?\d{2}$/.test(p) && p !== "Sverige"; });
        return { name: parts.slice(0, 3).join(", "), lat: +x.lat, lon: +x.lon };
      }).filter(function (x) { if (seen[x.name]) return false; seen[x.name] = 1; return true; });
    });
  }
  function overpass(query, i) {
    i = i || 0;
    var ctl = typeof AbortController === "function" ? new AbortController() : null, timer = ctl ? setTimeout(function () { ctl.abort(); }, 60000) : 0;
    return fetch(OVERPASS[i], { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error("overpass " + r.status); return r.json(); })
      .then(function (j) { clearTimeout(timer); return j; })
      .catch(function (e) {
        clearTimeout(timer);
        if (i + 1 >= OVERPASS.length) throw e;
        return new Promise(function (ok) { setTimeout(ok, 2000); }).then(function () { return overpass(query, i + 1); });
      });
  }
  function load(lat, lon) {
    var ar = "(around:" + R_ROADS + "," + lat + "," + lon + ")", ah = "(around:" + R_HOUSES + "," + lat + "," + lon + ")";
    var q = '[out:json][timeout:90];way["highway"~"^(' + ROADS + ')$"]' + ar + ";out body qt;node(w);out body qt;" +
      'way["building"]' + ah + ";out geom qt;";
    return overpass(q).then(function (json) { return makeArea(json, lat, lon); });
  }

  // A map packed with the app (verktyg/karta.js makes it): no waiting for the map servers,
  // and it works without internet. It is unpacked to the shape the servers send.
  function loadFile(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error("map " + r.status); return r.json(); }).then(function (m) {
      var el = [];
      m.n.forEach(function (x) { el.push({ type: "node", id: x[0], lat: x[1], lon: x[2], tags: x[3] }); });
      m.w.forEach(function (x) { el.push({ type: "way", id: x[0], nodes: x[1], tags: x[2] }); });
      m.b.forEach(function (x) {
        var g = [], tags = { building: "yes" };
        for (var i = 0; i < x[2].length; i += 2) g.push({ lat: x[2][i], lon: x[2][i + 1] });
        if (x[1]) tags["building:levels"] = String(x[1]);
        el.push({ type: "way", id: x[0], tags: tags, geometry: g });
      });
      var area = makeArea({ elements: el }, m.lat, m.lon);
      area.rRoads = m.rRoads; area.rDrive = m.rRoads - 400; area.lat0 = m.lat; area.lon0 = m.lon;
      // Ground: forest, water, pitches, parks and fields, in the game's metres.
      var K = 111320, kx = K * Math.cos(m.lat * DEG);
      area.lands = (m.a || []).map(function (x) {
        var pts = [], bb = [1e9, 1e9, -1e9, -1e9];
        for (var i = 0; i < x[1].length; i += 2) {
          var q = { x: (x[1][i + 1] - m.lon) * kx, y: -(x[1][i] - m.lat) * K };
          pts.push(q); bb[0] = Math.min(bb[0], q.x); bb[1] = Math.min(bb[1], q.y); bb[2] = Math.max(bb[2], q.x); bb[3] = Math.max(bb[3], q.y);
        }
        return { k: x[0], pts: pts, bb: bb };
      });
      return area;
    });
  }

  // ---------- GPS: the shortest way to a street ----------
  // Every street name on the map, for the list to pick from.
  function streets(area) {
    var seen = {};
    area.edges.forEach(function (e) { var n = nameOf(e.tags); if (n) seen[n] = true; });
    return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b, "sv"); });
  }
  // For every way out along a road (a half edge), how far it is from its start to the street, driving
  // only where one may, never straight back the way one came. Dijkstra, run backwards from the street.
  function routeTo(area, name) {
    var dist = {}, heap = [];
    function push(k, d, h) {
      heap.push({ k: k, d: d, h: h });
      for (var i = heap.length - 1; i > 0;) { var p = (i - 1) >> 1; if (heap[p].d <= heap[i].d) break; var t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p; }
    }
    function pop() {
      var top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (var i = 0; ;) {
          var l = 2 * i + 1, r = l + 1, m = i;
          if (l < heap.length && heap[l].d < heap[m].d) m = l;
          if (r < heap.length && heap[r].d < heap[m].d) m = r;
          if (m === i) break; var t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
        }
      }
      return top;
    }
    area.edges.forEach(function (e) {
      if (nameOf(e.tags) !== name) return;
      [true, false].forEach(function (f) { var h = H(e, f); if (okDir(h)) push(hk(h), 0, h); });
    });
    while (heap.length) {
      var it = pop();
      if (dist[it.k] !== undefined) continue;
      dist[it.k] = it.d;
      var v = from(it.h);
      v.edges.forEach(function (e) {
        if (e.a === e.b) return;
        var g = H(e, e.b === v);                 // the half edge that ends at v
        if (!okDir(g) || (e === it.h.e && g.f !== it.h.f)) return;
        var gk = hk(g);
        if (dist[gk] === undefined) push(gk, it.d + e.len, g);
      });
    }
    return dist;
  }
  // The instructor's pick, or with a GPS goal the way that gets there soonest.
  function chooseFor(run, arms, fn) {
    if (!run.dist) return choose(arms, fn);
    var best = null;
    arms.forEach(function (a) {
      var s = fn(a.rel), d = run.dist[hk(a.h)];
      if (!a.ok || s === null || d === undefined) return;
      if (!best || d < best.d) best = { a: a, s: s, w: 1, d: d };
    });
    return best || choose(arms, fn);
  }

  // ---------- the map as a graph ----------
  function cumOf(pts) {
    var c = [0];
    for (var i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    return c;
  }
  function line(pts) { var c = cumOf(pts); return { pts: pts, cum: c, len: c[c.length - 1] }; }
  function pointAt(L, t) {
    var p = L.pts, c = L.cum, n = p.length;
    if (n === 1) return p[0];
    if (t <= 0) return p[0];
    if (t >= L.len) return p[n - 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (c[m] <= t) lo = m; else hi = m; }
    var f = (t - c[lo]) / (c[lo + 1] - c[lo] || 1e-6);
    return { x: p[lo].x + (p[lo + 1].x - p[lo].x) * f, y: p[lo].y + (p[lo + 1].y - p[lo].y) * f };
  }
  function drivable(t) {
    if (t.area === "yes") return false;
    var mv = t.motor_vehicle || t.motorcar || "";
    if (/^(no|private)$/.test(mv)) return false;
    if (/^(no|private)$/.test(t.access || "") && !/^(yes|destination|permissive)$/.test(mv)) return false;
    return true;
  }
  function makeArea(json, lat0, lon0) {
    var K = 111320, kx = K * Math.cos(lat0 * DEG);
    function P(lat, lon) { return { x: (lon - lon0) * kx, y: -(lat - lat0) * K }; }
    var nodes = {}, ways = [], houses = [];
    json.elements.forEach(function (e) {
      if (e.type === "node") { var p = P(e.lat, e.lon); p.id = e.id; p.tags = e.tags || null; nodes[e.id] = p; return; }
      if (e.type !== "way" || !e.tags) return;
      if (e.tags.building && e.geometry) { var hs = makeHouse(e, P); if (hs) houses.push(hs); }
      else if (e.tags.highway && drivable(e.tags)) ways.push(e);
    });
    // A roundabout's nodes all become one point, at their middle.
    var parent = {};
    function find(a) { if (parent[a] === undefined) parent[a] = a; while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    ways.forEach(function (w) {
      if (!/^(roundabout|circular)$/.test(w.tags.junction || "")) return;
      w.rb = true;
      w.nodes.forEach(function (id) { var a = find(id), b = find(w.nodes[0]); if (a !== b) parent[a] = b; });
    });
    var rbOf = {}, mid = {};
    Object.keys(parent).forEach(function (id) { if (nodes[id]) rbOf[id] = "R" + find(id); });
    Object.keys(nodes).forEach(function (id) { var t = nodes[id].tags; if (t && t.highway === "mini_roundabout" && !rbOf[id]) rbOf[id] = "R" + id; });
    Object.keys(rbOf).forEach(function (id) {
      var m = mid[rbOf[id]] || (mid[rbOf[id]] = { x: 0, y: 0, n: 0 });
      m.x += nodes[id].x; m.y += nodes[id].y; m.n++;
    });
    Object.keys(mid).forEach(function (k) { mid[k].x /= mid[k].n; mid[k].y /= mid[k].n; mid[k].r = 0; });
    // The ring's size: its nodes' mean distance from the middle (a mini roundabout, one node, has none).
    Object.keys(rbOf).forEach(function (id) { var m = mid[rbOf[id]]; if (m.n > 2) m.r += Math.hypot(nodes[id].x - m.x, nodes[id].y - m.y) / m.n; });
    // Every end of a way, and every node shared by ways, is a vertex.
    var use = {};
    ways.forEach(function (w) {
      if (w.rb) return;
      var n = w.nodes.length;
      w.nodes.forEach(function (id, i) { use[id] = (use[id] || 0) + (i === 0 || i === n - 1 ? 2 : 1); });
    });
    var verts = {}, edges = [];
    function vert(id) {
      var key = rbOf[id] || "n" + id, v = verts[key];
      if (!v) { var c = rbOf[id] ? mid[key] : nodes[id]; v = verts[key] = { key: key, x: c.x, y: c.y, rb: !!rbOf[id], rr: rbOf[id] ? c.r : 0, node: rbOf[id] ? null : nodes[id], edges: [] }; }
      return v;
    }
    function addEdge(w, ids) {
      var a = vert(ids[0]), b = vert(ids[ids.length - 1]);
      if (a === b) return;
      var pts = ids.map(function (id) { return nodes[id]; });
      if (a.rb) pts[0] = { x: a.x, y: a.y };
      if (b.rb) pts[pts.length - 1] = { x: b.x, y: b.y };
      var t = w.tags, ow = /^(yes|true|1)$/.test(t.oneway || "") ? 1 : /^(-1|reverse)$/.test(t.oneway || "") ? -1 : 0;
      var hw = t.highway.replace("_link", ""), L = line(pts);
      if (L.len < 0.5) return;
      var e = { a: a, b: b, pts: pts, tags: t, rank: RANK[hw] != null ? RANK[hw] : 1, ow: ow, seen: 0, len: L.len, lf: L };
      e.i = edges.length; edges.push(e); a.edges.push(e); b.edges.push(e);
    }
    ways.forEach(function (w) {
      if (w.rb) return;
      var ids = w.nodes.filter(function (id) { return nodes[id]; }), from = 0;
      for (var i = 1; i < ids.length; i++) {
        if (i === ids.length - 1 || use[ids[i]] >= 2 || rbOf[ids[i]]) { addEdge(w, ids.slice(from, i + 1)); from = i; }
      }
    });
    var grid = {};
    houses.forEach(function (h) { var k = Math.floor(h.cx / 60) + "," + Math.floor(h.cy / 60); (grid[k] = grid[k] || []).push(h); });
    return { ok: edges.some(function (e) { return e.rank >= 1 && e.len > 50; }), verts: verts, edges: edges, grid: grid, houses: houses.length };
  }
  function makeHouse(e, P) {
    if (e.tags.building === "roof") return null;
    var pts = e.geometry.map(function (g) { return P(g.lat, g.lon); });
    if (pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y) pts.pop();
    if (pts.length < 3) return null;
    var cx = 0, cy = 0;
    pts.forEach(function (q) { cx += q.x; cy += q.y; });
    var lv = parseFloat(e.tags["building:levels"]);
    return { id: e.id, pts: pts, cx: cx / pts.length, cy: cy / pts.length, h: lv > 0 ? Math.min(40, lv * 3 + 1.2) : null };
  }

  // ---------- ways out of a vertex ----------
  function H(e, f) { return { e: e, f: f }; }
  function hk(h) { return h.e.i * 2 + (h.f ? 0 : 1); }
  function from(h) { return h.f ? h.e.a : h.e.b; }
  function to(h) { return h.f ? h.e.b : h.e.a; }
  function okDir(h) { return h.e.ow === 0 || (h.e.ow === 1) === h.f; }
  function hline(h) { return h.f ? h.e.lf : h.e.lr || (h.e.lr = line(h.e.pts.slice().reverse())); }
  function outHeading(h) {
    var L = hline(h), q = pointAt(L, Math.min(from(h).rb ? 24 : 12, L.len)), p = L.pts[0];
    return headingOf(q.x - p.x, q.y - p.y);
  }
  function inHeading(h) {
    var L = hline(h), q = pointAt(L, Math.max(0, L.len - (to(h).rb ? 24 : 12))), p = L.pts[L.pts.length - 1];
    return headingOf(p.x - q.x, p.y - q.y);
  }
  // Along a road to the next junction, roundabout or end: through points where only two roads meet.
  function legFrom(h) {
    var hs = [h], v = to(h), n = 0;
    while (!v.rb && v.edges.length === 2 && n++ < 80) {
      var last = hs[hs.length - 1], e2 = v.edges[0] === last.e ? v.edges[1] : v.edges[0];
      if (e2 === last.e || hs.some(function (x) { return x.e === e2; })) break;
      var nh = H(e2, e2.a === v);
      hs.push(nh); v = to(nh);
    }
    var far = Math.hypot(v.x, v.y) > RR - 80;
    var kind = far ? "dead" : v.rb ? "round" : v.edges.length >= 3 ? "junction" : "dead";
    var pts = [];
    hs.forEach(function (x) { var p = hline(x).pts; (pts.length ? p.slice(1) : p).forEach(function (q) { pts.push(q); }); });
    return { hs: hs, end: v, kind: kind, line: line(pts) };
  }
  function joinLegs(a, b) {
    var pts = a.line.pts.concat(b.line.pts.slice(1));
    return { hs: a.hs.concat(b.hs), end: b.end, kind: b.kind, line: line(pts) };
  }
  function armsAt(v, last) {
    var hin = inHeading(last), out = [];
    v.edges.forEach(function (e) {
      [true, false].forEach(function (f) {
        if ((f ? e.a : e.b) !== v) return;
        if (e === last.e && f !== last.f) return;   // back the way we came
        var h = H(e, f);
        out.push({ h: h, rel: angDiff(outHeading(h), hin), ok: okDir(h) });
      });
    });
    return out;
  }
  // A roundabout's size in the game: the ring the cars drive on (the map's ring line is its middle), and how far
  // from the middle the roads in and out start. A mini roundabout gets the game's usual size.
  function rbGeom(v, std) {
    var path = v && v.rr ? Math.max(9, Math.min(28, v.rr)) : 10.75;
    return { path: Math.round(path * 10) / 10, arm: Math.max(std, Math.round(path + 3.25 + 22)) };
  }
  // The game's ways: at a junction 0 ahead, 1 right, -1 left; in a roundabout exit 1 right, 2 ahead, 3 left.
  function jsec(rel) { var d = rel / DEG; return Math.abs(d) <= 50 ? 0 : d > 50 && d <= 150 ? 1 : d < -50 && d >= -150 ? -1 : null; }
  function rsec(rel) { var d = rel / DEG; return Math.abs(d) <= 45 ? 2 : d > 45 && d <= 135 ? 1 : d < -45 && d >= -135 ? 3 : null; }
  // A real roundabout may be left by any exit but the way in: straight on gets the same small bonus as at a junction.
  function rall(rel) { var d = Math.abs(rel / DEG); return d <= 45 ? 2 : d <= 172 ? 1 : null; }
  function secMid(fn, s) { return (fn === rsec ? (2 - s) : s) * 90 * DEG; }
  // The roads from which a drive can go on for ever without turning round: every road to a dead end,
  // or into streets that only lead to dead ends, is struck out, again and again until none is left.
  var LIVE = null;
  function liveRoads(area) {
    if (area.live) return area.live;
    var succ = {}, all = [], live = {};
    area.edges.forEach(function (e) {
      [true, false].forEach(function (f) {
        var h = H(e, f);
        if (!okDir(h)) return;
        var leg = legFrom(h), next = [];
        if (leg.kind !== "dead") {
          var fn = leg.kind === "round" ? rall : jsec;
          armsAt(leg.end, leg.hs[leg.hs.length - 1]).forEach(function (a) { if (a.ok && fn(a.rel) !== null) next.push(hk(a.h)); });
        }
        succ[hk(h)] = next; all.push(hk(h)); live[hk(h)] = true;
      });
    });
    for (var changed = true; changed;) {
      changed = false;
      all.forEach(function (k) { if (live[k] && !succ[k].some(function (n) { return live[n]; })) { live[k] = false; changed = true; } });
    }
    return (area.live = live);
  }
  // The way the instructor picks: new streets first, bigger roads a little more, back towards the
  // middle near the edge of the map, never into a dead end.
  function weight(a, s) {
    if (!a.ok || s === null) return 0;
    if (!LIVE[hk(a.h)]) return 0;
    var leg = legFrom(a.h);
    var seen = 0;
    leg.hs.forEach(function (x) { seen += x.e.seen; });
    var w = (1 + 0.25 * a.h.e.rank) / (1 + 2 * seen);
    var dc = Math.hypot(leg.end.x, leg.end.y);
    if (dc > RD - 250) w *= Math.max(0.03, (RD - dc) / 250);
    if (s === 0 || s === 2) w *= 1.4;
    return w;
  }
  function choose(arms, fn) {
    var c = arms.map(function (a) { var s = fn(a.rel); return { a: a, s: s, w: weight(a, s) }; }), tot = 0;
    c.forEach(function (x) { tot += x.w; });
    if (tot <= 0) {
      c = c.filter(function (x) { return x.a.ok && x.s !== null; });
      return c.length ? pick(c) : null;
    }
    var r = RND() * tot;
    for (var i = 0; i < c.length; i++) { r -= c[i].w; if (r <= 0) return c[i]; }
    return c[c.length - 1];
  }
  // One real road for each of the game's ways: the chosen one, else one we may drive, else the nearest.
  function bySector(arms, fn, ch) {
    var out = {};
    arms.forEach(function (a) {
      var s = fn(a.rel);
      if (s === null) return;
      var cur = out[s], m = secMid(fn, s);
      if (ch && ch.a === a) { out[s] = a; return; }
      if (cur && ch && ch.a === cur) return;
      if (!cur || (a.ok && !cur.ok) || (a.ok === cur.ok && Math.abs(angDiff(a.rel, m)) < Math.abs(angDiff(cur.rel, m)))) out[s] = a;
    });
    return out;
  }

  // ---------- one leg as the game's steps ----------
  // A gångfartsområde (OSM living_street, or maxspeed "walk" or 5) means walking pace, whatever else
  // is tagged; the game counts it as 7 km/h, as its E9 sign does.
  var WALK = 7;
  function limitOf(t) {
    var m = t.maxspeed || "";
    if (t.highway === "living_street" || /walk/i.test(m)) return WALK;
    if (/urban/i.test(m)) return 50;
    if (/rural/i.test(m)) return 70;
    var n = parseInt(m, 10);
    if (n > 0 && n <= WALK) return WALK;
    if (n > 0) return /mph/.test(m) ? Math.round(n * 1.609) : n;
    return null;
  }
  // A road's name as signs show it: the street name, else the road number.
  function nameOf(t) { return t.name || (t.ref ? "Väg " + t.ref.split(";")[0] : ""); }
  function snap(v) { return v === WALK ? WALK : Math.max(20, Math.min(110, Math.round(v / 10) * 10)); }
  // Houses along the road, in the road's own terms: w along it, u sideways from the middle of the right lane.
  function housesAlong(run, L, cutS, len) {
    var S = [], cand = {}, out = [];
    for (var w = 0; w <= len; w += 4) {
      var a = pointAt(L, cutS + w - 4), b = pointAt(L, cutS + w + 4), q = pointAt(L, cutS + w), hd = headingOf(b.x - a.x, b.y - a.y);
      S.push({ w: w, x: q.x, y: q.y, c: Math.cos(hd), s: Math.sin(hd) });
      var gx = Math.floor(q.x / 60), gy = Math.floor(q.y / 60);
      for (var i = -1; i <= 1; i++) for (var j = -1; j <= 1; j++) (run.area.grid[(gx + i) + "," + (gy + j)] || []).forEach(function (h) { cand[h.id] = h; });
    }
    Object.keys(cand).forEach(function (id) {
      var h = cand[id], best = null, bd = 1e9;
      if (run.prevUsed[id]) return;   // already beside the road before this one
      S.forEach(function (sm) { var d = (h.cx - sm.x) * (h.cx - sm.x) + (h.cy - sm.y) * (h.cy - sm.y); if (d < bd) { bd = d; best = sm; } });
      if (bd > 45 * 45) return;
      var u0 = 1e9, u1 = -1e9, w0 = 1e9, w1 = -1e9;
      h.pts.forEach(function (p) {
        var dx = p.x - best.x, dy = p.y - best.y, u = dx * best.c + dy * best.s - 1.75, ww = best.w + dx * best.s - dy * best.c;
        u0 = Math.min(u0, u); u1 = Math.max(u1, u); w0 = Math.min(w0, ww); w1 = Math.max(w1, ww);
      });
      // Clear of the road and the pavement: moved out a little if need be, left out if it stands on it.
      if (u0 + u1 > 0) {
        if (u0 < 4.9) { if (4.9 - u0 > 6) return; u1 += 4.9 - u0; u0 = 4.9; }
        u1 = Math.min(u1, u0 + 30);
      } else {
        if (u1 > -8.2) { if (u1 + 8.2 > 6) return; u0 -= u1 + 8.2; u1 = -8.2; }
        u0 = Math.max(u0, u1 - 30);
      }
      w0 = Math.max(w0, 1.5); w1 = Math.min(w1, len - 1.5);
      if (w1 - w0 < 3 || u1 - u0 < 3) return;
      run.used[id] = 1;
      out.push({ t: "house", id: h.id, u: r1(u0), w: r1(w0), len: r1(w1 - w0), dep: r1(u1 - u0), h: h.h });
    });
    return out;
  }
  // Bridges along a leg, as [from, to] in the game road's metres: where the map tags the way as a bridge
  // (a packed map has no such tag), and where the road crosses water on the map.
  function inPoly(pts, x, y) {
    var c = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var a = pts[i], b = pts[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  }
  function bridgesAlong(run, leg, cutS, Lr, len) {
    var on = [], k = len / Lr, t, c = 0;
    var water = (run.area.lands || []).filter(function (l) { return l.k === "water"; });
    leg.hs.forEach(function (x) {
      var b = x.e.tags.bridge;
      if (b && b !== "no") on.push([c, c + x.e.len]);
      c += x.e.len;
    });
    if (water.length) {
      var isWet = function (x, y) { return water.some(function (l) { return x >= l.bb[0] && x <= l.bb[2] && y >= l.bb[1] && y <= l.bb[3] && inPoly(l.pts, x, y); }); };
      // Water on both sides of the road too, out past the pavement: a street along a quay is no bridge,
      // even where the map's water edge overlaps it a little.
      var crosses = function (t0, t1) {
        for (var f = 0.25; f < 0.8; f += 0.25) {
          var tm = t0 + (t1 - t0) * f, a = pointAt(leg.line, tm - 2), b = pointAt(leg.line, tm + 2), m = pointAt(leg.line, tm);
          var dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
          if (isWet(m.x + nx * 12, m.y + ny * 12) && isWet(m.x - nx * 12, m.y - ny * 12)) return true;
        }
        return false;
      };
      var from = null;
      for (t = cutS; t <= cutS + Lr + 2; t += 2) {
        var q = pointAt(leg.line, Math.min(t, cutS + Lr)), wet = t <= cutS + Lr && isWet(q.x, q.y);
        if (wet && from === null) from = t;
        if (!wet && from !== null) { if (crosses(from, t)) on.push([from - 4, t + 2]); from = null; }
      }
    }
    // In the game road's metres, joined where they meet, short ones (a ditch, a culvert) left out.
    var out = [];
    on.map(function (r) { return [Math.max(0, (r[0] - cutS) * k), Math.min(len, (r[1] - cutS) * k)]; })
      .filter(function (r) { return r[1] - r[0] >= 8; }).sort(function (a, b) { return a[0] - b[0]; })
      .forEach(function (r) { var l = out[out.length - 1]; if (l && r[0] <= l[1] + 4) l[1] = Math.max(l[1], r[1]); else out.push([r1(r[0]), r1(r[1])]); });
    return out;
  }
  // P is where the game's road starts (the way out of the junction before, always at right angles in the
  // game, so a little off the real road); null for the first road, which starts on the real one.
  function legSteps(run, leg, startKind, offset, P) {
    var cutS = startKind === "junction" ? run.jh : startKind === "round" ? run.lastArm || run.rbArm : offset || 0;
    // A junction too close for the game's junction to fit before it is driven straight through as part
    // of the road (when the way goes straight on), so the next one still lands in its real place.
    for (var guard = 0; leg.kind === "junction" && leg.line.len - cutS - run.jh < 12 && guard < 6; guard++) {
      var ch0 = chooseFor(run, armsAt(leg.end, leg.hs[leg.hs.length - 1]), jsec);
      if (!ch0 || ch0.s !== 0) break;
      leg = joinLegs(leg, legFrom(ch0.a.h));
    }
    var cutE = leg.kind === "junction" ? run.jh : leg.kind === "round" ? rbGeom(leg.end, run.rbArm).arm : run.rbArm;   // a dead end gets a turning circle
    var Lr = leg.line.len - cutS - cutE, len, n, rel = [0], i, start = null;
    if (Lr >= 12) {
      // The real road's right lane, every metre, its heading taken across 12 m so a corner becomes a curve.
      // The game's road starts where the game is and bends over to end where the real road ends, so a
      // street driven twice lies in the same place both times.
      var Q = [], R0 = null, h0 = 0, da = 0;
      for (var w = 0; w <= Lr; w += 1) {
        var t = cutS + w, a = pointAt(leg.line, t - 6), b = pointAt(leg.line, t + 6), q = pointAt(leg.line, t);
        var hd = headingOf(b.x - a.x, b.y - a.y), r = { x: q.x + Math.cos(hd) * 1.75, y: q.y + Math.sin(hd) * 1.75 };
        if (!R0) { R0 = r; h0 = hd; da = P ? angDiff(P.a, hd) : 0; start = { x: r.x, y: r.y, a: hd }; }
        if (!P) { Q.push(r); continue; }
        var f = Math.min(1, w / Math.min(Lr, 45)), g = 1 - f * f * (3 - 2 * f), c = Math.cos(da), sn = Math.sin(da), vx = r.x - R0.x, vy = r.y - R0.y;
        Q.push({ x: (P.x + vx * c - vy * sn) * g + r.x * (1 - g), y: (P.y + vx * sn + vy * c) * g + r.y * (1 - g) });
      }
      var QL = line(Q);
      n = Math.max(2, Math.round(QL.len / DW) + 1); len = (n - 1) * DW;
      var k = QL.len / len, prev = P ? P.a : h0;
      for (i = 1; i < n; i++) {
        var A = pointAt(QL, (i - 1) * DW * k), B = pointAt(QL, Math.min(QL.len, (i + 1) * DW * k));
        var hh = headingOf(B.x - A.x, B.y - A.y);
        rel.push(Math.round((rel[i - 1] + angDiff(hh, prev)) * 1e4) / 1e4);
        prev = hh;
      }
    } else {
      len = 12; n = len / DW + 1;
      for (i = 1; i < n; i++) rel.push(0);
      var q0 = pointAt(leg.line, cutS), q1 = pointAt(leg.line, cutS + 6), h1 = headingOf(q1.x - q0.x, q1.y - q0.y);
      start = { x: q0.x + Math.cos(h1) * 1.75, y: q0.y + Math.sin(h1) * 1.75, a: h1 };
    }
    var main = leg.hs.reduce(function (m, x) { return x.e.len > m.e.len ? x : m; });
    var lim = limitOf(main.e.tags), houses = Lr >= 20 ? housesAlong(run, leg.line, cutS, len) : [];
    var dens = houses.length / Math.max(len, 60) * 100;
    var env = (lim ? lim <= 50 : main.e.rank <= 1 || dens >= 2) || dens >= 3 ? "stad" : "land";
    var limit = snap(lim || (env === "stad" ? 50 : 70));
    var road = { type: "road", len: len, bend: rel, start: start, env: env, limit: limit, real: true, street: nameOf(main.e.tags), houses: houses, signs: [], say: [],
      edges: leg.hs.map(function (x) { return x.e.i; }) };
    // A small residential street: no pavement and no centre line, as in a villa area.
    if (main.e.rank <= 1 && env === "stad") { road.noWalk = true; road.small = true; }
    if (Lr >= 12) {
      road.bridges = bridgesAlong(run, leg, cutS, Lr, len);
      if (road.bridges.length && !run.bridgeSaid) {
        run.bridgeSaid = true;
        road.say.push([Math.max(1, road.bridges[0][0] - 40), "Nu kör vi över en bro. Tänk på att broar kan vara hala när resten av vägen inte är det, de kyls ner både uppifrån och underifrån."]);
      }
    }
    if (run.env && env !== run.env) road.signs.push({ s: 3, code: env === "stad" ? "E5" : "E6" });
    // Walking pace has its own signs: E9 where it starts, E10 where it ends (then 50 unless a sign says else).
    if (limit === WALK && run.limit !== WALK) {
      road.signs.push({ s: 8, code: "E9" });
      road.say.push([4, "Gångfartsområde! Här kör du i gångfart, ungefär 7 km/h, och gående har företräde."]);
    } else if (limit !== WALK && run.limit === WALK) {
      road.signs.push({ s: 2, code: "E10" });
      if (limit !== 50) road.signs.push({ s: 8, speed: limit });
    } else if (limit !== run.limit) road.signs.push({ s: 8, speed: limit });
    if (run.dest) {
      // GPS: the street we are going to. On it, we are there.
      if (run.first) road.say.push([0, "Nu kör vi till " + run.dest + ". Följ kartan uppe till höger, så säger jag vart vi ska."]);
      if (run.recalc) { road.say.unshift([0, "Ingen fara, jag räknar om vägen."]); run.recalc = false; }
      if (!run.first && leg.hs.some(function (x) { return nameOf(x.e.tags) === run.dest; })) {
        road.street = run.dest; road.finish = true; road.gps = { to: run.dest, left: 0 };
        road.say.push([0, "Nu är vi på " + run.dest + ". Framme!"]);
        road.say.push([Math.max(5, len - 60), "Stanna vid kanten här, så är vi klara. Bra kört!"]);
        run.first = false;
        return [road];
      }
    } else if (run.first) road.say.push([0, "Nu kör vi på riktiga gator" + (run.name ? " vid " + run.name.split(",")[0] : "") + ". Jag säger vart vi ska."]);
    // Crossings, speed bumps and signals from the map.
    var zeb = null, bumps = [], sig = null, P = leg.line.pts, C = leg.line.cum;
    for (i = 0; i < P.length - 1; i++) {
      var tg = P[i].tags;
      if (!tg) continue;
      var w = C[i] - cutS, toEnd = leg.line.len - C[i];
      if (zeb === null && (tg.highway === "crossing" || tg.crossing) && !/traffic_signals|^no$|unmarked|informal/.test(tg.crossing || "") && w > 18 && w < len - 14) zeb = w;
      if (/^(bump|hump|table|cushion)$/.test(tg.traffic_calming || "") && w > 12 && w < len - 12 && (!bumps.length || w - bumps[bumps.length - 1] > 25)) bumps.push(Math.round(w));
      if (toEnd < 35 && leg.kind === "junction") {
        if (tg.highway === "traffic_signals") sig = "ljus";
        else if (tg.highway === "stop" && sig !== "ljus") sig = "stopp";
        else if (tg.highway === "give_way" && !sig) sig = "vaj";
      }
    }
    if (zeb !== null) { road.zebra = { s: Math.round(zeb), peds: RND() < 0.65 ? [{ side: pick(["right", "left"]) }] : [] }; road.signs.push({ s: Math.round(zeb) - 2, code: "B3" }); }
    if (bumps.length) { road.bumps = bumps; road.say.push([Math.max(1, bumps[0] - 40), "Farthinder framåt, sakta in."]); }
    // A sharp bend on a fast road: the instructor warns.
    if (limit >= 60) {
      for (i = 0; i + 30 < n; i += 5) if (Math.abs(rel[i + 30] - rel[i]) > 1.05) { road.say.push([Math.max(1, i * DW - 70), "Skarp kurva framåt. Sakta in före kurvan."]); break; }
    }
    if (main.e.ow === 0 && len > 90 && RND() < (env === "stad" ? 0.45 : 0.7)) road.oncoming = [Math.round(len * (0.2 + RND() * 0.4))];
    if (env === "stad" && len > 130 && RND() < 0.12) road.ahead = [{ s: 40, v: 17, kind: "bike", ttl: len - 12 }];
    leg.hs.forEach(function (x) { x.e.seen++; });
    run.first = false; run.env = env; run.limit = limit; run.prevUsed = run.used; run.used = {};

    var last = leg.hs[leg.hs.length - 1], steps = [road], jst = null;
    if (leg.kind === "junction") {
      var arms = armsAt(leg.end, last), ch = chooseFor(run, arms, jsec);
      if (ch) {
        var by = bySector(arms, jsec, ch), ctrl = sig || ctrlAt(leg, last, arms);
        var npcs = ctrl === "hoger" ? [{ from: "right", to: "straight" }] : ctrl === "huvud" ? [{ from: "right", to: "straight", prio: false }] :
          ctrl === "ljus" ? [] : [{ from: "left", to: "straight", eta: 1.2 }, { from: "right", to: "straight", eta: 1.6 }];
        jst = { type: "junction", ctrl: ctrl, want: ch.s, right: !!by[1], fwd: !!by[0], left: !!by[-1], good: pick(GOOD), npcs: npcs, real: { by: by, back: H(last.e, !last.f), key: leg.end.key } };
        var bad = [];
        [[1, "right"], [0, "fwd"], [-1, "left"]].forEach(function (x) { if (by[x[0]] && !by[x[0]].ok) bad.push(x[1]); });
        if (bad.length) { jst.noEntry = bad; jst.armSigns = bad.map(function (nm) { return { arm: nm, code: "C1" }; }); }
        var into = nameOf(ch.a.h.e.tags), on = into && into !== road.street ? (ch.s ? " in på " : ", in på ") + into : "";
        road.say.push([Math.max(1, len - 90), "I nästa korsning ska vi " + WORD[ch.s] + on + ". " + HINTS[ctrl]]);
        if (run.dest) road.gps = { to: run.dest, left: ch.d != null ? len + ch.d : null, turn: ch.s, into: into || "" };
      }
    } else if (leg.kind === "round") {
      // The real roundabout: its exits where they really are, counted in the order they come
      // (anticlockwise, the first on the right), the way back last when the road in is two-way.
      var arms2 = armsAt(leg.end, last), ch2 = chooseFor(run, arms2, rall), G2 = rbGeom(leg.end, run.rbArm);
      var off = 30 * 10.75 / G2.path, aMin = -90 + 2 * off + 4;
      var exits = arms2.filter(function (a) { return a.ok; }).sort(function (x, y) { return y.rel - x.rel; });
      var back = okDir(H(last.e, !last.f));
      if (ch2 && exits.indexOf(ch2.a) >= 0) {
        var by2 = {}, angs = [];
        exits.forEach(function (a, i) {
          by2[i + 1] = a;
          // The game's angle (0 right, 90 ahead, 180 left, the way in at 270), kept clear of the way in.
          angs.push(Math.round(Math.max(aMin, Math.min(270 - off, 90 - a.rel / DEG))));
        });
        var k2 = exits.indexOf(ch2.a) + 1;
        run.lastArm = G2.arm;
        jst = { type: "round", want: k2, good: "Bra i cirkulationsplatsen!",
          npcs: exits.length >= 2 && RND() < 0.6 ? [{ fromA: angs[angs.length - 1], toA: angs[0] }] : [],
          rb: { path: G2.path, arm: G2.arm, exits: angs, back: back },
          real: { by: by2, backK: back ? exits.length + 1 : null, back: H(last.e, !last.f), key: leg.end.key } };
        var out2 = nameOf(ch2.a.h.e.tags), nEx = exits.length + (back ? 1 : 0);
        road.say.push([Math.max(1, len - 95), "I cirkulationsplatsen tar vi avfart nummer " + k2 + (out2 && out2 !== road.street ? " mot " + out2 : "") + "." +
          (nEx !== 4 ? " Den har " + nEx + " avfarter." : "") +
          (k2 === 1 ? " Blinka höger redan när du kör in." : " Blinka höger när du har passerat avfarten före.")]);
        if (run.dest) road.gps = { to: run.dest, left: ch2.d != null ? len + ch2.d : null, exit: k2, into: out2 || "" };
      }
    }
    if (!jst && leg.kind === "dead") {
      // The end of a street, or of the map: round a turning circle and back the way we came.
      jst = { type: "round", turn: true, want: 4, good: "Snyggt vänt.", npcs: [], real: { by: {}, back: H(last.e, !last.f), key: leg.end.key } };
      road.say.push([Math.max(1, len - 80), (leg.end.edges.length <= 1 ? "Gatan tar slut där framme." : "Här tar kartan slut.") +
        " Vi kör runt vändplanen och tillbaka."]);
    }
    if (jst) steps.push(jst);
    else {
      road.finish = true;
      road.say.push([Math.max(1, len - 60), (leg.end.edges.length <= 1 ? "Gatan tar slut här." : "Här tar kartan slut.") + " Stanna vid kanten, så är vi klara. Bra kört!"]);
    }
    return steps;
  }
  // Who goes first where this road meets the others: signals and signs from the map, else the size of the roads.
  function ctrlAt(leg, last, arms) {
    var v = leg.end, mine = last.e.rank, others = 0, sideYields = false, tg = (v.node && v.node.tags) || {};
    arms.forEach(function (a) {
      others = Math.max(others, a.h.e.rank);
      var L = hline(a.h);
      L.pts.forEach(function (q, i) { if (i && L.cum[i] < 35 && q.tags && /^(stop|give_way)$/.test(q.tags.highway || "")) sideYields = true; });
    });
    if (tg.highway === "traffic_signals") return "ljus";
    if (/^(stop|give_way)$/.test(tg.highway || "")) return mine < others ? (tg.highway === "stop" ? "stopp" : "vaj") : "huvud";
    if (sideYields) return "huvud";
    if (mine >= 3 && others <= 2) return "huvud";
    if (mine <= 2 && others >= 3) return "vaj";
    return "hoger";
  }

  // ---------- a drive ----------
  // The steps for a drive in the area: the first road, then one road and junction more each time the
  // car leaves a junction (steps.onExit, called by the course when a junction or roundabout is decided).
  function steps(area, opts) {
    var run = { area: area, jh: opts.jh, rbArm: opts.rbArm, env: null, limit: null, used: {}, prevUsed: {}, name: area.name || "", first: true };
    RR = area.rRoads || R_ROADS; RD = area.rDrive || R_DRIVE;
    if (opts.dest) { run.dest = opts.dest; run.dist = routeTo(area, opts.dest); }
    area.edges.forEach(function (e) { e.seen = 0; });
    LIVE = liveRoads(area);
    // Start on the street nearest the place, or nearest the spot picked on the satellite map (opts.at).
    var ax = opts.at ? opts.at.x : 0, ay = opts.at ? opts.at.y : 0, best = null, bd = 1e9;
    area.edges.forEach(function (e) {
      if (e.rank < 1 || e.len < 60 || !(LIVE[e.i * 2] || LIVE[e.i * 2 + 1])) return;
      for (var i = 1; i < e.pts.length; i++) {
        var a = e.pts[i - 1], b = e.pts[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-6;
        var f = Math.max(0, Math.min(1, ((ax - a.x) * dx + (ay - a.y) * dy) / l2)), x = a.x + dx * f, y = a.y + dy * f, d = Math.hypot(x - ax, y - ay);
        if (d < bd) { bd = d; best = { e: e, t: e.lf.cum[i - 1] + Math.sqrt(l2) * f }; }
      }
    });
    var out = [];
    if (!best) return out;
    var dirs = [true, false].filter(function (f) { return LIVE[hk(H(best.e, f))]; }), f = pick(dirs);
    var h = H(best.e, f), leg = legFrom(h), off = f ? best.t : best.e.len - best.t;
    var cutE = leg.kind === "junction" ? run.jh : leg.kind === "round" ? rbGeom(leg.end, run.rbArm).arm : run.rbArm;
    off = Math.max(0, Math.min(off, leg.line.len - cutE - 80));
    legSteps(run, leg, "start", off, null).forEach(function (s) { out.push(s); });
    out.start = out[0].start;   // the game's world is the map's: the course starts on the real road
    out.onExit = function (pc, course) {
      var r = pc.st.real;
      if (!r) return;
      var k = pc.kind === "round" ? pc.exitK : pc.dir, arm = r.by[k];
      if (!arm && pc.kind === "round" && (r.backK ? k === r.backK : k === 4)) arm = { h: r.back };
      if (!arm) {   // the game let the car out where the map has no road: the nearest real one
        var ks = Object.keys(r.by).map(Number).sort(function (x, y) { return Math.abs(x - k) - Math.abs(y - k); });
        arm = ks.length ? r.by[ks[0]] : { h: r.back };
      }
      if (run.dest && k !== pc.st.want) run.recalc = true;   // a wrong turn: the next road says so
      course.steps.length = course.i;
      legSteps(run, legFrom(arm.h), pc.kind === "round" ? "round" : "junction", 0, course.endP).forEach(function (s) { course.steps.push(s); });
    };
    return out;
  }

  // The drivable street nearest a point, for the start picker: its name (or "") and how far away it is.
  function nearStreet(area, x, y) {
    var best = null, bd = 1e9;
    area.edges.forEach(function (e) {
      if (e.rank < 1 || e.len < 60) return;
      for (var i = 1; i < e.pts.length; i++) {
        var a = e.pts[i - 1], b = e.pts[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1e-6;
        var f = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)), d = Math.hypot(a.x + dx * f - x, a.y + dy * f - y);
        if (d < bd) { bd = d; best = e; }
      }
    });
    return best ? { name: nameOf(best.tags), d: bd } : null;
  }

  window.RIKTIG = { search: search, load: load, loadFile: loadFile, streets: streets, steps: steps, nearStreet: nearStreet };
})();
