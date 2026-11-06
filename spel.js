// Övningskörning: a small top-down driving game with a driving instructor.
// The world is in metres. A heading a points along (sin a, -cos a), so 0 is up
// on the screen and a right turn adds PI/2. The player's car follows the
// course (a chain of pieces) along its distance s; d is its sideways offset
// from the centre of its lane, plus to the right. Pieces are built ahead of
// the car; at a junction the next piece is built once the car picks a way.
"use strict";
(function () {
  var COL = {
    grass: "#709c54", grassDark: "#5f8a46", walk: "#c6c2b8", curb: "#aaa69c", asph: "#4c5056", paint: "#f4f4ee",
    red: "#e03832", blue: "#286ee0", yellow: "#f8c628", silver: "#b0b4ba", grey: "#787c82", white: "#eceef0",
    green: "#2e9660", orange: "#ffa61e", glass: "#303a4a", tree: "#3f6e30", treeLight: "#4f8a3c",
    houses: ["#b9876a", "#d8c9a8", "#9fb0bf", "#c9a0a0", "#e2dccb", "#a8b59a", "#8c97a6"],
    roofs: ["#7d4a3a", "#5b5f66", "#8a5a44", "#4f5560"]
  };
  var HW = 3.5;            // half width of a two-lane road; a lane is 3.5 m
  var RC = 6;              // corner radius at junctions
  var JH = HW + RC;        // half size of a junction square
  var ARM = 90;            // length drawn of a junction's side roads
  var RB = { outer: 14, island: 7.5, path: 10.75, arm: 36 };  // roundabout
  var DEG = Math.PI / 180;
  var KMH = 3.6;
  var CAR = { hl: 2.25, hw: 0.95 };

  // ---------- small helpers ----------
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function toG(P, u, w) {
    var c = Math.cos(P.a), s = Math.sin(P.a);
    return { x: P.x + u * c + w * s, y: P.y + u * s - w * c };
  }
  function headingOf(dx, dy) { return Math.atan2(dx, -dy); }
  function angDiff(a, b) { var d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
  function rng(seed) { var x = seed * 9301 + 49297; return function () { x = (x * 9301 + 49297) % 233280; return x / 233280; }; }
  function rot(p, deg) { var c = Math.cos(deg * DEG), s = Math.sin(deg * DEG); return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }; }

  // A polyline with distances, in world or local coordinates.
  function Poly(pts) {
    pts = pts.filter(function (q, i) { return i === 0 || Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y) > 1e-3; });
    this.pts = pts; this.cum = [0];
    for (var i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    this.len = this.cum[this.cum.length - 1];
  }
  Poly.prototype.at = function (t) {
    var p = this.pts, c = this.cum, n = p.length, i;
    if (t <= 0) i = 0;
    else if (t >= this.len) i = n - 2;
    else { var lo = 0, hi = n - 1; while (hi - lo > 1) { var m = (lo + hi) >> 1; if (c[m] <= t) lo = m; else hi = m; } i = lo; }
    var seg = c[i + 1] - c[i] || 1e-6, f = (t - c[i]) / seg;
    var dx = p[i + 1].x - p[i].x, dy = p[i + 1].y - p[i].y;
    return { x: p[i].x + dx * f, y: p[i].y + dy * f, a: headingOf(dx, dy) };
  };
  // Local (u right, w forward) points to world, around pose C.
  function polyG(C, local) { return new Poly(local.map(function (q) { return toG(C, q.x, q.y); })); }
  function arcPts(cx, cy, r, a0, a1, step) {
    var out = [], n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (step || 6)));
    for (var i = 0; i <= n; i++) { var a = (a0 + (a1 - a0) * i / n) * DEG; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); }
    return out;
  }
  function bez(p0, c, p1, n) {
    var out = [];
    for (var i = 1; i < n; i++) { var t = i / n, k = 1 - t; out.push({ x: k * k * p0.x + 2 * k * t * c.x + t * t * p1.x, y: k * k * p0.y + 2 * k * t * c.y + t * t * p1.y }); }
    return out;
  }

  // ---------- junction and roundabout paths (local: u right, w forward) ----------
  // Through a junction for traffic entering from the bottom arm in the right lane.
  function turnLocal(turn, lead, tail) {
    var pts = [{ x: 1.75, y: -JH - lead }];
    if (turn === 0) { pts.push({ x: 1.75, y: -JH }, { x: 1.75, y: JH }, { x: 1.75, y: JH + tail }); }
    else if (turn === 1) { pts = pts.concat(arcPts(JH, -JH, JH - 1.75, 180, 90, 10).map(function (q) { return q; })); pts.push({ x: JH + tail, y: -1.75 }); }
    else { pts = pts.concat(arcPts(-JH, -JH, JH + 1.75, 0, 90, 6)); pts.push({ x: -JH - tail, y: 1.75 }); }
    return pts;
  }
  // The same path for traffic from arm alpha (degrees, local math angle: 0 right, 90 ahead, 180 left, 270 back).
  function turnFromArm(alpha, turn, lead, tail) {
    return turnLocal(turn, lead, tail).map(function (q) { return rot(q, alpha - 270); });
  }
  // Roundabout path from arm ain to arm aout (degrees), traffic going anticlockwise as seen from above.
  function laneIn(a, t) { return { x: t * Math.cos(a * DEG) - 1.75 * Math.sin(a * DEG), y: t * Math.sin(a * DEG) + 1.75 * Math.cos(a * DEG) }; }
  function laneOut(a, t) { return { x: t * Math.cos(a * DEG) + 1.75 * Math.sin(a * DEG), y: t * Math.sin(a * DEG) - 1.75 * Math.cos(a * DEG) }; }
  function ringAt(th) { return { x: RB.path * Math.cos(th * DEG), y: RB.path * Math.sin(th * DEG) }; }
  function roundLocal(ain, thEnd, aout, lead, tail) {
    var th0 = ain + 30;
    var pts = [laneIn(ain, RB.arm + lead), laneIn(ain, 17)];
    pts = pts.concat(bez(laneIn(ain, 17), laneIn(ain, 11), ringAt(th0), 5));
    pts = pts.concat(arcPts(0, 0, RB.path, th0, thEnd, 5));
    if (aout !== null) {
      pts = pts.concat(bez(ringAt(thEnd), laneOut(aout, 11), laneOut(aout, 17), 5));
      pts.push(laneOut(aout, 17), laneOut(aout, RB.arm + tail));
    }
    return pts;
  }
  function ringEnd(ain, aout) { var th = aout - 30; while (th <= ain + 30) th += 360; return th; }

  // ---------- the course ----------
  function Course(steps, game) {
    this.steps = steps; this.i = 0; this.game = game;
    this.pieces = []; this.signs = []; this.feats = [];
    this.endS = 0; this.endP = { x: 0, y: 0, a: 0 }; this.pending = null;
    this.env = "stad"; this.limit = 50;
  }
  Course.prototype.build = function () {
    while (!this.pending && this.i < this.steps.length) {
      var st = this.steps[this.i++];
      var pc = makePiece(st, this, this.steps[this.i]);
      pc.index = this.pieces.length;
      this.pieces.push(pc);
      if (pc.open) { this.pending = pc; break; }
      this.endS += pc.len; this.endP = pc.endPose();
    }
  };
  Course.prototype.close = function (pc) {
    this.pending = null; this.endS = pc.s0 + pc.len; this.endP = pc.endPose(); this.build();
  };
  Course.prototype.pieceAt = function (s) {
    for (var i = this.pieces.length - 1; i >= 0; i--) if (s >= this.pieces[i].s0) return this.pieces[i];
    return this.pieces[0];
  };
  Course.prototype.poseAt = function (s) { var pc = this.pieceAt(s); return pc.poseAt(s - pc.s0); };
  Course.prototype.addSign = function (s, sg, env) {
    var u = sg.u != null ? sg.u : env === "stad" ? 3.3 : env === "mv" ? 6.2 : 4.4;
    this.signs.push({ s: s, code: sg.code, speed: sg.speed, u: u, img: sg.code ? signImg(sg.code) : null, pos: sg.pos || null });
  };

  function basePiece(st, course, kind) {
    var pc = {
      kind: kind, st: st, s0: course.endS, P: course.endP, env: st.env || course.env, limit: st.limit || course.limit,
      lanes: st.lanes || [0], said: {}, faultsAt: 0
    };
    course.env = pc.env; course.limit = pc.limit;
    pc.poseAt = function (t) { var q = toG(pc.P, 0, t); return { x: q.x, y: q.y, a: pc.P.a }; };
    pc.endPose = function () { return pc.poseAt(pc.len); };
    (st.signs || []).forEach(function (sg) { course.addSign(pc.s0 + sg.s, sg, pc.env); });
    return pc;
  }

  function makePiece(st, course, next) {
    if (st.type === "junction") return makeJunction(st, course);
    if (st.type === "round") return makeRound(st, course);
    var pc = basePiece(st, course, st.type === "mv" ? "mv" : "road");
    pc.len = st.len;
    pc.center = st.center || (pc.env === "stad" && st.small ? "none" : "dash");
    pc.warnEnd = next && (next.type === "junction" || next.type === "round");
    pc.solid = st.solid || [];
    pc.isSolid = function (t) { for (var i = 0; i < pc.solid.length; i++) if (t >= pc.solid[i][0] && t <= pc.solid[i][1]) return true; return pc.center === "solid"; };
    pc.decor = makeDecor(pc);
    if (st.zebra) course.feats.push({ kind: "zebra", s: pc.s0 + st.zebra.s, pc: pc, peds: st.zebra.peds || [], started: false });
    if (st.rail) course.feats.push({ kind: "rail", s: pc.s0 + st.rail.s, pc: pc, state: "open", t: 0 });
    if (st.bus) course.feats.push({ kind: "bus", s: pc.s0 + st.bus.s, pc: pc });
    (st.bumps || []).forEach(function (b) { course.feats.push({ kind: "bump", s: pc.s0 + b, pc: pc }); });
    if (st.parking) pc.parking = st.parking;
    return pc;
  }

  function makeDecor(pc) {
    var r = rng(pc.s0 * 7 + 13), out = [];
    if (pc.kind === "mv") {
      for (var w = 10; w < pc.len - 5; w += 14 + r() * 30) out.push({ t: "tree", u: 16 + r() * 22, w: w, r: 2 + r() * 2 });
      for (w = 10; w < pc.len - 5; w += 14 + r() * 30) out.push({ t: "tree", u: -30 - r() * 20, w: w, r: 2 + r() * 2 });
      return out;
    }
    var margin = 16;
    if (pc.env === "stad") {
      [1, -1].forEach(function (side) {
        var w = margin;
        while (w < pc.len - margin - 8) {
          var len = 10 + r() * 12; if (w + len > pc.len - margin) break;
          var dep = 8 + r() * 6, off = (side > 0 ? 1.75 + 2.6 + (pc.parking ? 2.5 : 0) : 5.25 + 2.6) + 1.5 + r() * 2;
          out.push({ t: "house", u: side > 0 ? off : -off - dep, w: w, len: len, dep: dep, c: COL.houses[Math.floor(r() * COL.houses.length)], roof: COL.roofs[Math.floor(r() * COL.roofs.length)] });
          w += len + 2 + r() * 6;
        }
      });
    } else {
      for (var i = 0; i < pc.len / 9; i++) {
        var side = r() < 0.5 ? 1 : -1, ww = margin + r() * (pc.len - 2 * margin);
        out.push({ t: "tree", u: side > 0 ? 7 + r() * 22 : -11 - r() * 22, w: ww, r: 1.6 + r() * 1.8 });
      }
      if (r() < 0.5) out.push({ t: "field", u: 12 + r() * 6, w: margin + 10, len: Math.max(20, pc.len - 2 * margin - 20), dep: 40 });
    }
    return out;
  }

  // A crossroads or T-junction. Its path is set when the car reaches its edge.
  function makeJunction(st, course) {
    var pc = basePiece(st, course, "junction");
    pc.open = true; pc.len = 0;
    pc.arms = { 0: st.right !== false, 90: st.fwd !== false, 180: st.left !== false };
    pc.C = (function () { var q = toG(pc.P, -1.75, JH); return { x: q.x, y: q.y, a: pc.P.a }; })();
    pc.ctrl = st.ctrl;
    pc.want = st.want || 0;
    pc.npcs = [];
    pc.spawned = false;
    if (pc.ctrl === "ljus") pc.light = { ph: "green", t: 0, triggered: false };
    pc.poseAt = function (t) {
      if (pc.poly) return pc.poly.at(t);
      var q = toG(pc.P, 0, t); return { x: q.x, y: q.y, a: pc.P.a };
    };
    pc.endPose = function () { return pc.poly.at(pc.poly.len); };
    if (st.ctrl === "stopp") course.addSign(pc.s0 - 1, { code: "B2" }, pc.env);
    if (st.ctrl === "vaj") course.addSign(pc.s0 - 1, { code: "B1" }, pc.env);
    // Signs for one arm: they stand where that road starts and face the cars turning into it.
    (st.armSigns || []).forEach(function (as) {
      var al = armOf(as.arm), dir = { x: Math.cos(al * DEG), y: Math.sin(al * DEG) }, rn = { x: dir.y, y: -dir.x };
      var q = toG(pc.C, dir.x * (JH + 1.5) + rn.x * (HW + 1.6), dir.y * (JH + 1.5) + rn.y * (HW + 1.6));
      course.addSign(pc.s0, { code: as.code, pos: { x: q.x, y: q.y, a: pc.C.a + (90 - al) * DEG } }, pc.env);
    });
    return pc;
  }

  function makeRound(st, course) {
    var pc = basePiece(st, course, "round");
    pc.open = true;
    pc.want = st.want || 2;
    pc.C = (function () { var q = toG(pc.P, -1.75, RB.arm); return { x: q.x, y: q.y, a: pc.P.a }; })();
    var th0 = 300;
    // Before an exit is chosen the path goes round twice.
    pc.loop = polyG(pc.C, roundLocal(270, th0 + 720, null, 0, 0));
    pc.poly = pc.loop; pc.len = pc.loop.len;
    pc.joinT = new Poly(roundLocal(270, th0 + 1, null, 0, 0)).len;
    pc.exitAt = [];
    for (var k = 1; k <= 7; k++) {
      var a = (270 + 90 * k) % 360, th = a - 30;
      while (th <= th0) th += 360;
      if (k > 4) th += 360;
      pc.exitAt.push({ k: k, a: a, th: th, t: new Poly(roundLocal(270, th, null, 0, 0)).len });
    }
    pc.npcs = []; pc.spawned = false;
    pc.poseAt = function (t) { return pc.poly.at(t); };
    pc.endPose = function () { return pc.poly.at(pc.poly.len); };
    course.addSign(pc.s0 + RB.arm - 18, { code: "B1" }, pc.env);
    course.addSign(pc.s0 + RB.arm - 18, { code: "D3", u: (pc.env === "stad" ? 3.3 : 4.4) + 2.4 }, pc.env);
    return pc;
  }

  // ---------- sign pictures ----------
  var imgCache = {};
  function signImg(code) {
    if (!imgCache[code]) { var im = new Image(); im.src = "signs/" + code + ".png"; imgCache[code] = im; }
    return imgCache[code];
  }

  // ---------- vehicles and walkers ----------
  var nextId = 1;
  function PathCar(o) {
    this.id = nextId++; this.mode = "path"; this.kind = o.kind || "car"; this.s = o.s; this.d = o.d || 0; this.td = this.d;
    this.dir = o.dir || 1; this.v = o.v != null ? o.v : 0; this.vt = o.vt != null ? o.vt : this.v; this.color = o.color || pickColor();
    this.vtAt = o.vtAt || null; this.blink = 0; this.siren = this.kind === "amb"; this.parked = !!o.parked; this.ttl = o.ttl || 0;
    var dims = { car: [2.2, 0.9], bus: [6, 1.25], truck: [7.5, 1.25], amb: [2.8, 1.0], tractor: [2.0, 1.1], bike: [0.9, 0.35], police: [2.3, 0.92] }[this.kind];
    this.yaw = o.yaw || 0; if (o.blink) this.blink = o.blink;
    this.hl = dims[0]; this.hw = dims[1];
  }
  function PolyCar(o) {
    this.id = nextId++; this.mode = "poly"; this.kind = o.kind || "car"; this.poly = o.poly; this.t = o.t; this.v = o.v; this.vt = o.vt;
    this.color = o.color || pickColor(); this.prio = !!o.prio; this.canGo = o.canGo || function () { return true; };
    this.stopT = o.stopT; this.blink = o.blink || 0; this.hl = 2.2; this.hw = 0.9; this.owner = o.owner || null;
  }
  function Walker(o) {
    this.id = nextId++; this.mode = "walk"; this.kind = o.kind || "ped"; this.s = o.s; this.u = o.u; this.vu = o.vu || 0; this.vs = o.vs || 0; this.go = false;
    this.color = o.color || ["#d1495b", "#2e86ab", "#f18f01", "#6a4c93", "#3d9970"][this.id % 5];
    this.hl = this.kind === "moose" ? 1.4 : 0.35; this.hw = this.kind === "moose" ? 0.55 : 0.3;
    this.owner = o.owner || null; this.trigger = o.trigger; this.ttl = 0;
  }
  var palette = [COL.blue, COL.yellow, COL.silver, COL.white, "#2d6a4f", COL.grey, "#5a4fcf"];
  function pickColor() { return palette[Math.floor(Math.random() * palette.length)]; }

  // ---------- the game ----------
  var cv = document.getElementById("cv"), ctx = cv.getContext("2d");
  var W = 0, H = 0, DPR = 1;
  var G = null;                 // the running lesson
  var keys = { gas: false, brake: false, left: false, right: false };
  var touchUI = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  var store = loadStore();

  function loadStore() {
    try { var o = JSON.parse(localStorage.getItem("korkort-spel") || "{}"); o.best = o.best || {}; return o; }
    catch (e) { return { best: {} }; }
  }
  function saveStore() { try { localStorage.setItem("korkort-spel", JSON.stringify(store)); } catch (e) { /* private mode */ } }

  var BASE_COL = { grass: COL.grass, grassDark: COL.grassDark, walk: COL.walk, tree: COL.tree, treeLight: COL.treeLight, asph: COL.asph };
  function setWeather(w) {
    var snow = w === "snow";
    COL.grass = snow ? "#e6ebee" : BASE_COL.grass; COL.grassDark = snow ? "#d5dce0" : BASE_COL.grassDark;
    COL.walk = snow ? "#dfe3e6" : BASE_COL.walk; COL.treeLight = snow ? "#f2f5f7" : BASE_COL.treeLight;
    COL.tree = snow ? "#3b5a40" : BASE_COL.tree; COL.asph = snow ? "#5d6268" : BASE_COL.asph;
  }
  function startLesson(idx) {
    var L = LESSONS[idx];
    setWeather(L.weather);
    G = {
      idx: idx, lesson: L, t: 0, npcs: [], faults: [], faultKeys: {}, msg: [], cur: null, curT: 0, over: false, paused: false,
      p: { s: L.start ? L.start.s : 4, v: L.start ? L.start.v / KMH : 0, d: L.start ? L.start.d : 0, td: L.start ? L.start.d : 0,
           blink: 0, blinkS: -1e9, laneT: 0, a: 0, x: 0, y: 0, stillT: 0, overT: 0, leftT: 0, closeT: 0, hl: CAR.hl, hw: CAR.hw },
      cam: { x: 0, y: 0, a: 0, sc: 12 }, crashed: false, finishT: -1, factShown: {}, factNext: null, factT: 0, lastFact: -99
    };
    G.grip = L.weather === "snow" ? 0.45 : 1;
    G.manual = store.steer !== "auto";
    document.getElementById("pad").classList.toggle("auto", !G.manual);
    G.p.steer = 0;
    G.course = new Course(L.make ? L.make() : L.steps, G);
    G.course.build();
    G.prevS = G.p.s;
    factEl.classList.remove("show");
    var pose = G.course.poseAt(G.p.s);
    G.cam.x = pose.x; G.cam.y = pose.y; G.cam.a = pose.a;
    G.p.a = pose.a; G.p.x = pose.x + Math.cos(pose.a) * G.p.d; G.p.y = pose.y + Math.sin(pose.a) * G.p.d;
    if (G.manual) say(touchUI ? "Du styr själv med pilknapparna. Blinka med de små knapparna ovanför dem." :
      "Du styr själv med vänster- och högerpil. Blinka med Q och E.");
    show("game");
    ensureAudio();
    lastFrame = performance.now();
  }

  // ---------- instructor ----------
  var sayEl = document.getElementById("say"), sayText = document.getElementById("sayText");
  function say(text, tone, urgent) {
    if (!G) return;
    if (urgent) { G.msg.length = 0; G.cur = null; if (window.speechSynthesis) speechSynthesis.cancel(); }
    G.msg.push({ text: text, tone: tone || "" });
  }
  function updateSay(dt) {
    G.curT -= dt;
    if ((!G.cur || G.curT <= 0) && G.msg.length) {
      G.cur = G.msg.shift();
      G.curT = Math.max(3.2, G.cur.text.length * 0.065);
      sayText.textContent = G.cur.text;
      sayEl.className = G.cur.tone;
      speak(G.cur.text);
    }
  }
  // ---------- "Visste du att…": small facts that fit what is happening ----------
  // One at a time, at least 35 s apart, never right after a fault or close to a junction.
  var FACTS = {
    B1: "Väjningspliktsskylten är en triangel med spetsen nedåt. Hajtänderna i vägen visar var du stannar om det behövs.",
    B2: "Stoppskylten är åttakantig, så den går att känna igen även bakifrån eller när den är täckt av snö.",
    B3: "Den blå skylten för övergångsställe sitter vid själva övergångsstället. Blå fyrkantiga skyltar ger upplysningar.",
    B4: "Huvudled är en gul romb. Den gäller tills skylten Huvudled upphör kommer.",
    B5: "När huvudleden upphör gäller vanliga regler igen. I en korsning utan skyltar blir det högerregeln.",
    B6: "På skylten väjningsplikt mot mötande är den röda pilen din riktning: det är du som ska vänta.",
    C1: "Förbud mot infart är en röd rund skylt med en vågrät list. Den sitter ofta där en enkelriktad gata slutar.",
    C27: "Omkörningsförbudet gäller motorfordon med fler än två hjul. Cyklar och motorcyklar får du köra om.",
    C28: "Ett snett streck över en skylt betyder oftast att förbudet eller sträckan slutar.",
    C39: "Förbud att stanna och parkera gäller på den sida där skylten står, fram till nästa korsning om inget annat anges.",
    D1: "Blå runda skyltar är påbud. De talar om vad du måste göra, till exempel vilket håll du ska köra.",
    E1: "På motorväg får du inte vända, backa eller stanna, utom om det är nödvändigt.",
    E5: "Tättbebyggt område betyder 50 km/h, om ingen annan skylt säger något annat.",
    E6: "Utanför tättbebyggt område är grundhastigheten 70 km/h om inga skyltar visar annat.",
    E9: "I ett gångfartsområde får du bara parkera på platser som är särskilt utmärkta.",
    E19: "P-skylten betyder att parkering är tillåten. En tilläggstavla under den kan begränsa tiden.",
    E24: "Skylten för trafiksäkerhetskamera sitter före kameran, så att alla hinner se den och sakta in.",
    A9: "Varning för farthinder sitter före gupp och avsmalningar som ska få ner farten.",
    A10: "Varning för slirig väg varnar för att vägen kan vara hal, av till exempel is, löv eller lera.",
    A15: "Varning för barn sitter ofta nära skolor och lekplatser.",
    A19: "Tusentals viltolyckor sker varje år i Sverige. Ser du ett djur finns det ofta fler i närheten.",
    A20: "Vid vägarbeten är hastigheten ofta tillfälligt sänkt för att skydda dem som jobbar där.",
    A30: "Varning för cirkulationsplats sitter en bit före. I rondellen kör alla moturs.",
    A34: "Köer bildas ofta efter kurvor och backkrön. Släpp gasen tidigt, det sparar både bränsle och bromsar.",
    A35: "Tåg kan inte väja och har mycket lång bromssträcka. Därför sitter varningen långt före korsningen.",
    A39: "Kryssmärket sitter vid själva järnvägskorsningen."
  };
  var SITUATION_FACTS = {
    round: "Du behöver inte blinka när du kör in i en cirkulationsplats, men du ska blinka höger när du kör ut.",
    mv: "Ett fordon måste kunna köra i minst 40 km/h för att få köra på motorväg.",
    mv2: "Omkörning görs till vänster. I tät kö får det ändå gå fortare i högra körfältet än i det vänstra.",
    snow: "Bromssträckan på is kan bli flera gånger längre än på torr asfalt.",
    snow2: "Vinterdäck är krav från 1 december till 31 mars när det är vinterväglag.",
    rail: "Ett tåg i hög fart kan behöva över en kilometer för att stanna.",
    zebra: "Du får inte köra om ett fordon strax före ett övergångsställe.",
    bike: "Två cyklister får cykla bredvid varandra om det inte hindrar annan trafik.",
    police: "Ha alltid körkortet med dig när du kör. Polisen kan stoppa dig för kontroll när som helst.",
    accident: "Vid en olycka: varna andra, larma 112 och hjälp de skadade. Varningstriangeln ställs en bit bakom bilen.",
    light: "Gult blinkande trafikljus betyder att signalen är ur funktion. Då gäller skyltarna och de vanliga reglerna."
  };
  var GENERAL_FACTS = [
    "Gränsen för alkohol i blodet är 0,2 promille för den som kör bil i Sverige.",
    "Du får inte hålla mobilen i handen när du kör.",
    "Halvljus eller varselljus ska alltid vara tänt när du kör.",
    "Alla i bilen ska ha bilbälte, både fram och bak.",
    "Barn som är kortare än 135 cm ska sitta i bilbarnstol eller på bälteskudde.",
    "En trött förare är nästan lika farlig som en berusad. Ta paus om du blir sömnig."
  ];
  var factEl = document.getElementById("fact"), factText = document.getElementById("factText");
  factEl.addEventListener("pointerdown", function (e) { e.preventDefault(); hideFact(); });
  function hideFact() { factEl.classList.remove("show"); if (G) G.factT = 0; }
  function showFact(text) {
    G.factShown[text] = true; G.lastFact = G.t; G.factT = 9;
    factText.textContent = text;
    var r = sayEl.getBoundingClientRect();
    factEl.style.top = Math.round(r.bottom + 8) + "px";
    factEl.classList.add("show");
  }
  // What fits the moment goes before a general fact, and is dropped if it waits too long.
  function wantFact(text, general) {
    if (!text || G.factShown[text]) return;
    if (G.factNext && (G.factNext.general ? general : true)) return;
    G.factNext = { text: text, general: !!general, at: G.t };
  }
  function updateFacts(dt) {
    if (G.factT > 0) { G.factT -= dt; if (G.factT <= 0) hideFact(); }
    if (store.facts === false) return;
    var p = G.p, c = G.course;
    // What fits right now: a sign just ahead, then the situation, then something general.
    c.signs.forEach(function (sg) { if (sg.code && FACTS[sg.code] && sg.s - p.s < 45 && sg.s - p.s > 0) wantFact(FACTS[sg.code]); });
    var pc = curPiece(), pend = c.pending;
    if (pend && pend.kind === "round" && pend.s0 - p.s < 120) wantFact(SITUATION_FACTS.round);
    if (pend && pend.light && pend.s0 - p.s < 140) wantFact(SITUATION_FACTS.light);
    if (pc.kind === "mv") wantFact(p.s - pc.s0 > 200 ? SITUATION_FACTS.mv2 : SITUATION_FACTS.mv);
    if (G.lesson.weather === "snow" && G.t > 20) wantFact(G.t > 70 ? SITUATION_FACTS.snow2 : SITUATION_FACTS.snow);
    c.feats.forEach(function (f) {
      if (f.kind === "rail" && f.s - p.s < 200 && f.s - p.s > 60) wantFact(SITUATION_FACTS.rail);
      if (f.kind === "zebra" && f.s - p.s < 90 && f.s - p.s > 40) wantFact(SITUATION_FACTS.zebra);
    });
    if (pc.st.police && p.s - pc.s0 > pc.st.police.s + 10) wantFact(SITUATION_FACTS.police);
    if (pc.st.accident && p.s - pc.s0 > pc.st.accident.s + pc.st.accident.len + 15) wantFact(SITUATION_FACTS.accident);
    if (G.npcs.some(function (n) { return n.kind === "bike" && n.s - p.s < 80 && n.s > p.s + 30; })) wantFact(SITUATION_FACTS.bike);
    if (G.factNext && G.t - G.factNext.at > 25) G.factNext = null;
    if (!G.factNext && G.t > 30 && G.t - G.lastFact > 70) {
      var left = GENERAL_FACTS.filter(function (f) { return !G.factShown[f]; });
      if (left.length) wantFact(left[Math.floor(Math.random() * left.length)], true);
    }
    // Only when it is calm.
    var calm = G.t > 12 && G.t - G.lastFact > 35 && G.factT <= 0 && G.t - (G.lastFaultT || -99) > 8 &&
      !(pend && pend.kind === "junction" && pend.s0 - p.s < 45) && !G.ambActive &&
      !G.npcs.some(function (n) { return (n.kind === "moose" || n.kind === "child" || (n.kind === "ped" && n.vu)) && !n.done; });
    if (calm && G.factNext) { showFact(G.factNext.text); G.factNext = null; }
  }
  var svVoice = null;
  function pickVoice() {
    if (!window.speechSynthesis) return;
    var vs = speechSynthesis.getVoices();
    svVoice = vs.filter(function (v) { return /^sv/i.test(v.lang); })[0] || null;
  }
  if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function speak(text) {
    if (!store.voice || !window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text.replace(/km\/h/g, "kilometer i timmen"));
    u.lang = "sv-SE"; if (svVoice) u.voice = svVoice; u.rate = 1.05;
    speechSynthesis.speak(u);
  }

  // ---------- faults ----------
  var FAULT_INFO = {
    speed: "Håll hastighetsgränsen. Skylten gäller från där den står, så sakta in innan du når den.",
    yield: "Du hade väjningsplikt. Den som har väjningsplikt ska sakta in eller stanna i god tid och låta den andra köra först.",
    stop: "Vid stopplikt ska bilen stå helt still vid stopplinjen, även om ingen kommer.",
    red: "Rött ljus betyder stopp. Gult betyder stopp om du kan stanna utan fara.",
    ped: "Förare ska lämna företräde åt gående som är på väg ut på eller redan går på ett obevakat övergångsställe.",
    blink: "Visa i god tid vart du ska, så att andra hinner se det.",
    turn: "Sakta in före svängen. Ungefär 20 km/h räcker i en vanlig korsning.",
    route: "Lyssna på läraren och blinka åt det håll ni ska.",
    solid: "Heldragen mittlinje (spärrlinje) får inte korsas.",
    keepRight: "Kör i högra körfältet när du inte kör om.",
    close: "Håll minst tre sekunders avstånd på landsväg, så hinner du stanna om bilen framför bromsar.",
    merge: "På accelerationsfältet ska du få upp farten så att du kan glida in i en lucka i samma fart som trafiken.",
    accel: "Kör in på motorvägen innan accelerationsfältet tar slut. Gasa och leta lucka i god tid.",
    exit: "Byt till högra körfältet i god tid före avfarten och blinka in i avfartens körfält.",
    rail: "När ljusen blinkar eller bommarna rör sig ska du stanna. Ett tåg kan inte väja eller stanna snabbt.",
    amb: "Ge fri väg åt utryckningsfordon: blinka, kör åt sidan och sakta in.",
    bus: "Där högsta tillåtna hastighet är 50 km/h eller lägre ska du släppa ut en buss som blinkar för att lämna hållplatsen.",
    crash: "Krock. Lektionen avbröts."
  };
  function fault(key, title, serious, once) {
    if (G.over) return;
    G.lastFaultT = G.t;
    if (G.factT > 0) hideFact();
    if (once !== false) { if (G.faultKeys[key]) return; G.faultKeys[key] = true; }
    var kind = key.split(":")[0];
    G.faults.push({ title: title, info: FAULT_INFO[kind] || "", serious: !!serious });
    say(title, "bad", true);
    flash(); beep(serious ? 220 : 330, 0.18);
  }
  function praise(text) { say(text, "good"); }
  var flashEl = document.getElementById("flash");
  function flash() { flashEl.classList.add("on"); setTimeout(function () { flashEl.classList.remove("on"); }, 120); }

  // ---------- input ----------
  function setBlink(dir) {
    if (!G || G.over) return;
    var p = G.p;
    if (p.blink === dir) { p.blink = 0; }
    else { p.blink = dir; p.blinkS = p.s; p.laneT = 0; }
    tick(0.5);
  }
  document.addEventListener("keydown", function (e) {
    if (!G || document.getElementById("game").hidden) return;
    var k = e.key;
    if (k === "ArrowUp" || k === "w" || k === "W") keys.gas = true;
    else if (k === "ArrowDown" || k === "s" || k === "S" || k === " ") keys.brake = true;
    else if (k === "ArrowLeft" || k === "a" || k === "A") { if (G.manual) keys.left = true; else if (!e.repeat) setBlink(-1); }
    else if (k === "ArrowRight" || k === "d" || k === "D") { if (G.manual) keys.right = true; else if (!e.repeat) setBlink(1); }
    else if ((k === "q" || k === "Q") && !e.repeat) setBlink(-1);
    else if ((k === "e" || k === "E") && !e.repeat) setBlink(1);
    else if (k === "Escape" || k === "p" || k === "P") pause();
    else return;
    e.preventDefault();
  });
  document.addEventListener("keyup", function (e) {
    var k = e.key;
    if (k === "ArrowUp" || k === "w" || k === "W") keys.gas = false;
    if (k === "ArrowDown" || k === "s" || k === "S" || k === " ") keys.brake = false;
    if (k === "ArrowLeft" || k === "a" || k === "A") keys.left = false;
    if (k === "ArrowRight" || k === "d" || k === "D") keys.right = false;
  });
  function hold(id, key) {
    var b = document.getElementById(id);
    function on(e) { e.preventDefault(); keys[key] = true; b.classList.add("down"); ensureAudio(); }
    function off(e) { e.preventDefault(); keys[key] = false; b.classList.remove("down"); }
    b.addEventListener("pointerdown", on); b.addEventListener("pointerup", off);
    b.addEventListener("pointercancel", off); b.addEventListener("pointerleave", off);
    b.addEventListener("contextmenu", function (e) { e.preventDefault(); });
  }
  hold("gas", "gas"); hold("brake", "brake");
  // The arrow buttons blink when the car follows the road, and steer when he steers himself.
  [["bl", "left", -1], ["br", "right", 1]].forEach(function (b) {
    var el = document.getElementById(b[0]);
    el.addEventListener("pointerdown", function (e) { e.preventDefault(); if (G && G.manual) { keys[b[1]] = true; el.classList.add("down"); } else setBlink(b[2]); });
    var up = function (e) { e.preventDefault(); keys[b[1]] = false; el.classList.remove("down"); };
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up); el.addEventListener("pointerleave", up);
  });
  document.getElementById("kl").addEventListener("pointerdown", function (e) { e.preventDefault(); setBlink(-1); });
  document.getElementById("kr").addEventListener("pointerdown", function (e) { e.preventDefault(); setBlink(1); });
  window.addEventListener("blur", function () { keys.gas = keys.brake = keys.left = keys.right = false; });

  // ---------- sound ----------
  var AC = null, sirenOsc = null, sirenGain = null;
  function ensureAudio() {
    if (AC || !store.sound) return;
    try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { AC = null; }
  }
  function beep(freq, len, vol) {
    if (!AC || !store.sound) return;
    var o = AC.createOscillator(), g = AC.createGain();
    o.frequency.value = freq; o.type = "square";
    g.gain.setValueAtTime(vol || 0.05, AC.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, AC.currentTime + len);
    o.connect(g); g.connect(AC.destination); o.start(); o.stop(AC.currentTime + len);
  }
  function tick(vol) { beep(1800, 0.03, 0.03 * (vol || 1)); }
  function siren(level) {
    if (!AC || !store.sound) return;
    if (!sirenOsc) {
      sirenOsc = AC.createOscillator(); sirenGain = AC.createGain(); sirenOsc.type = "triangle";
      sirenGain.gain.value = 0; sirenOsc.connect(sirenGain); sirenGain.connect(AC.destination); sirenOsc.start();
    }
    sirenOsc.frequency.value = Math.floor(G.t * 1.6) % 2 ? 660 : 880;
    sirenGain.gain.value = level * 0.05;
  }

  // ---------- update ----------
  function curPiece() { return G.course.pieceAt(G.p.s); }
  function allowedLanes() {
    var pc = curPiece(), p = G.p, t = p.s - pc.s0, out = pc.lanes.slice();
    var st = pc.st;
    if (pc.kind === "mv") {
      out = [0, -3.5];
      if (st.acc && t < st.acc) out.push(3.5);
      if (st.dec && t > st.dec[0] && t < st.dec[1]) out.push(3.5);
    }
    if (G.ambActive && pc.kind === "road") out.push(1.3);
    if (st.works && t > st.works.s - 60 && t < st.works.s + st.works.len + 10) out.push(-3.5);
    if (st.accident && t > st.accident.s - 60 && t < st.accident.s + st.accident.len + 10) out.push(-3.5);
    if (st.park && t > st.park.zone[0] - 20) out.push(3.0);
    // Room to pass a cyclist: half a lane out to the left.
    if (pc.kind === "road" && G.npcs.some(function (n) { return n.kind === "bike" && n.s > G.p.s - 6 && n.s - G.p.s < 60; })) out.push(-1.7);
    return out;
  }

  function update(dt) {
    var p = G.p, course = G.course;
    G.t += dt;
    // Pedals.
    var a;
    if (keys.brake) a = -7.5 * G.grip;
    else if (keys.gas) a = (3.4 * (1 - p.v / 48) + 0.3) * (0.55 + 0.45 * G.grip);
    else a = -0.3 - p.v * 0.006;
    p.v = Math.max(0, p.v + a * dt);
    if (G.manual) moveManual(dt);
    else moveOnPath(dt);
    p.stillT = p.v < 0.3 ? p.stillT + dt : 0;

    // Pieces near the car: spawning, signals and rule checks.
    course.pieces.forEach(function (pc) {
      if (pc.s0 - p.s < 260 && p.s - (pc.s0 + (pc.len || 0)) < 120) updatePiece(pc, dt);
    });
    course.feats.forEach(function (f) { if (Math.abs(f.s - p.s) < 300) updateFeat(f, dt); });
    // Other road users.
    for (var i = G.npcs.length - 1; i >= 0; i--) {
      var n = G.npcs[i];
      if (n.mode === "path") updatePathCar(n, dt);
      else if (n.mode === "poly") updatePolyCar(n, dt);
      else if (n.mode === "walk") updateWalker(n, dt);
      else if (n.mode === "train") updateTrain(n, dt);
      if (n.gone) G.npcs.splice(i, 1);
    }
    G.ambActive = G.npcs.some(function (n) { return n.kind === "amb" && !n.passed && !n.parked; });
    checkRules(dt);
    checkCrash();
    updateSay(dt);
    updateFacts(dt);
  }

  // The car follows the course; the blinker picks lanes and turns.
  function moveOnPath(dt) {
    var p = G.p, course = G.course;
    // Lane changes follow the blinker after a short while, away from junctions.
    var lanes = allowedLanes();
    var nearJunction = course.pending && course.pending.s0 - p.s < 80 && course.pending.kind === "junction";
    var inRound = curPiece().kind === "round" || (course.pending && course.pending.kind === "round" && course.pending.s0 - p.s < 60);
    if (p.blink && !nearJunction && !inRound) {
      var cand = lanes.filter(function (l) { return p.blink > 0 ? l > p.td + 0.5 : l < p.td - 0.5; })
        .sort(function (x, y) { return Math.abs(x - p.td) - Math.abs(y - p.td); })[0];
      if (cand !== undefined) {
        p.laneT += dt;
        if (p.laneT > 0.9 && (p.v > 1 || G.stuck)) { p.td = cand; p.laneT = -99; }
      }
    }
    if (lanes.indexOf(p.td) < 0 && !(p.td > 2 && curPiece().kind === "mv")) {
      // The lane we were in has ended (a passing lane, or room made for a siren).
      if (p.td === 1.3) p.td = 0;
    }
    if (G.stuck && p.d < 1) G.stuck = false;
    var moving = p.td !== p.d;
    if (moving) {
      var step = Math.min(Math.abs(p.td - p.d), (1.2 + p.v * 0.12) * dt);
      p.d += p.td > p.d ? step : -step;
      if (Math.abs(p.td - p.d) < 0.01) { p.d = p.td; if (p.laneT < 0) { p.blink = 0; p.laneT = 0; } }
    }
    // Motorway: the acceleration lane ends.
    var pc0 = curPiece(), p0 = p;
    if (pc0.kind === "mv" && pc0.st.acc && p.d > 1 && p.s - pc0.s0 > pc0.st.acc + 25) {
      p.s = pc0.s0 + pc0.st.acc + 25; p.v = 0; G.stuck = true;
      fault("accel", "Accelerationsfältet tog slut! Du måste in på motorvägen innan det tar slut.", true);
    }
    // Move along the course; a junction ahead is decided when the car reaches it.
    G.prevS = p.s;
    var ns = p.s + p.v * dt;
    if (course.pending && course.pending.kind === "junction" && ns >= course.pending.s0) decideJunction(course.pending);
    p.s = ns;
    var pose = course.poseAt(p.s);
    var r = { x: Math.cos(pose.a), y: Math.sin(pose.a) };
    p.x = pose.x + r.x * p.d; p.y = pose.y + r.y * p.d;
    var yaw = moving && p.v > 0.5 ? Math.atan2(p.td > p.d ? 1 : -1, 6) * 0.6 : 0;
    p.a = pose.a + yaw;
  }

  // He steers: a simple car model moves the car, and its place along the course is worked out from where it is.
  function project(s) {
    var p = G.p;
    for (var k = 0; k < 5; k++) {
      var q = G.course.poseAt(s), along = (p.x - q.x) * Math.sin(q.a) - (p.y - q.y) * Math.cos(q.a);
      s += clamp(along, -8, 8);
      if (Math.abs(along) < 0.01) break;
    }
    return s;
  }
  function sideOf(s) {
    var p = G.p, q = G.course.poseAt(s);
    return (p.x - q.x) * Math.cos(q.a) + (p.y - q.y) * Math.sin(q.a);
  }
  function localTo(C) {
    var p = G.p, dx = p.x - C.x, dy = p.y - C.y;
    return { u: dx * Math.cos(C.a) + dy * Math.sin(C.a), w: dx * Math.sin(C.a) - dy * Math.cos(C.a) };
  }
  function moveManual(dt) {
    var p = G.p, course = G.course;
    var maxS = 0.62 / (1 + p.v * p.v / 60);
    var want = keys.left && !keys.right ? -maxS : keys.right && !keys.left ? maxS : 0;
    var rate = want === 0 ? 2.4 : 1.5;
    p.steer += clamp(want - p.steer, -rate * dt, rate * dt);
    p.steer = clamp(p.steer, -maxS - 0.04, maxS + 0.04);
    p.a += p.v * Math.tan(p.steer) / 2.6 * dt;
    p.x += Math.sin(p.a) * p.v * dt; p.y -= Math.cos(p.a) * p.v * dt;
    G.prevS = p.s;
    var pend = course.pending;
    var s = project(p.s);
    if (pend && pend.kind === "junction") s = Math.min(s, pend.s0 + 2 * JH + 4);
    p.s = s; p.d = sideOf(s); p.td = p.d;
    if (p.blinkOffAt && G.t > p.blinkOffAt) { p.blink = 0; p.blinkOffAt = 0; }
    if (pend && pend.kind === "junction") manualJunction(pend);
    else if (pend && pend.kind === "round") manualRound(pend);
    var pc = curPiece();
    if (pc.kind === "round" && Math.hypot(p.x - pc.C.x, p.y - pc.C.y) < RB.island + 0.45) return crash("Du körde upp på mitten av cirkulationsplatsen!");
    if (pc.kind !== "road" && pc.kind !== "mv") { G.lane = null; return; }
    // Off the road, onto the pavement or into the barrier.
    var t = p.s - pc.s0, st = pc.st, prev = course.pieces[pc.index - 1];
    var nearJ = (pc.warnEnd && t > pc.len - 10) || (prev && (prev.kind === "junction" || prev.kind === "round") && t < 10);
    if (!nearJ) {
      var right, left, give;
      if (pc.kind === "mv") {
        right = (st.acc && t < st.acc + 40) || (st.dec && t > st.dec[0] - 40) ? 5.25 : 4.3; left = -6.0; give = 2.4;
        if (st.acc && t > st.acc + 40 && p.d > 2.6) { fault("accel", "Accelerationsfältet tog slut! Du måste in på motorvägen innan det tar slut.", true); return crash("Du körde av vägen där accelerationsfältet tog slut."); }
        if (p.d < -7.6) return crash("Du körde in i mitträcket!");
      } else {
        right = 1.75 + (pc.parking ? 2.5 : 0) + (st.bus && Math.abs(t - st.bus.s) < 16 ? 3.5 : 0); left = -5.25;
        give = pc.env === "stad" ? 0.45 : 2.2;
      }
      if (p.d + CAR.hw > right + give || p.d - CAR.hw < left - give)
        return crash(pc.env === "stad" && pc.kind === "road" ? "Du körde upp på trottoaren!" : "Du körde av vägen!");
    }
    // Changing lanes: the blinker has to be on first.
    var lane = pc.kind === "mv" ? (p.d < -1.75 ? -1 : p.d > 1.75 ? 1 : 0) : (p.d < -1.75 ? -1 : 0);
    if (G.lane != null && lane !== G.lane && G.lanePiece === pc.index) {
      var dirC = lane > G.lane ? 1 : -1;
      if (p.blink !== dirC) fault("lane:" + pc.index, "Blinka innan du byter körfält eller kör ut för att köra om.", false);
      else p.blinkOffAt = G.t + 1.5;
    }
    G.lane = lane; G.lanePiece = pc.index;
  }
  function armOk(pc, d) { return d === 0 ? pc.arms[90] : d === 1 ? pc.arms[0] : pc.arms[180]; }
  function manualJunction(pc) {
    var p = G.p, L = localTo(pc.C);
    if (!pc.entered && L.w > -JH - 1.5) {
      pc.entered = true; pc.entryBlink = p.blink; pc.entryBlinkS = p.blinkS; pc.maxV = 0;
      var guess = p.blink && armOk(pc, p.blink) ? p.blink : armOk(pc, 0) ? 0 : pc.want;
      if (pc.st.ctrl === "stopp" && !pc.stopped) fault("stop:" + pc.index, "Du stannade inte vid stopplinjen. Vid stopplikt ska bilen stå helt still.", true);
      yieldCheck(pc, polyG(pc.C, [{ x: 1.75, y: -JH }].concat(turnLocal(guess, 0, 0).slice(1))));
    }
    if (!pc.entered) return;
    pc.maxV = Math.max(pc.maxV, p.v);
    var dir = L.w > JH + 1.5 && Math.abs(L.u) < JH ? 0 : L.u > JH + 1.5 ? 1 : L.u < -JH - 1.5 ? -1 : null;
    if (dir === null) return;
    if (!armOk(pc, dir)) return crash("Du körde av vägen!");
    signRules(pc, dir);
    if (dir !== pc.want && !pc.st.free) fault("route:" + pc.index, pc.st.routeMsg || (pc.want === 0 ? "Vi skulle köra rakt fram." : pc.want === 1 ? "Vi skulle svänga höger." : "Vi skulle svänga vänster."), false);
    if (dir !== 0 && pc.entryBlink !== dir) fault("blink:" + pc.index, "Du glömde blinka före svängen.", false);
    else if (dir !== 0 && pc.entryBlinkS > pc.s0 - 22) fault("blink:" + pc.index, "Blinka tidigare, i god tid före svängen.", false);
    if (dir !== 0 && pc.maxV * KMH > 32) fault("turn:" + pc.index, "För hög fart i svängen!", false);
    pc.dir = dir;
    pc.poly = polyG(pc.C, [{ x: 1.75, y: -JH }].concat(turnLocal(dir, 0, 0).slice(1)));
    pc.len = pc.poly.len; pc.open = false;
    if (dir !== 0) p.blink = 0;
    G.course.close(pc);
    p.s = project(pc.s0 + pc.len); p.d = sideOf(p.s); G.prevS = p.s; G.lane = null;
  }
  function manualRound(pc) {
    var p = G.p, t = p.s - pc.s0;
    if (t < pc.joinT + 4) return;
    var L = localTo(pc.C), r = Math.hypot(L.u, L.w);
    if (r < RB.outer + 2.5) return;
    var ang = (Math.atan2(L.w, L.u) / DEG + 360) % 360, arm = Math.round(ang / 90) * 90 % 360;
    if (Math.abs(angDiff(ang * DEG, arm * DEG)) > 28 * DEG) return crash("Du körde av vägen!");
    var cand = pc.exitAt.filter(function (ex) { return ex.a === arm && ex.t <= t + 25; });
    var ex = cand.length ? cand[cand.length - 1] : pc.exitAt.filter(function (e) { return e.a === arm; })[0];
    var k = ((ex.k - 1) % 4) + 1;
    if (k !== pc.want) fault("route:" + pc.index, "Fel avfart. Vi skulle ta avfart nummer " + pc.want + ".", false);
    if (p.blink !== 1) fault("blink:" + pc.index, "Blinka höger innan du kör ut ur cirkulationsplatsen.", false);
    pc.poly = polyG(pc.C, roundLocal(270, ex.th, ex.a, 0, 0)); pc.len = pc.poly.len; pc.open = false;
    p.blink = 0;
    G.course.close(pc);
    p.s = project(pc.s0 + ex.t + 12); p.d = sideOf(p.s); G.prevS = p.s; G.lane = null;
  }

  function crossed(x) { return G.prevS < x && G.p.s >= x; }
  function front() { return G.p.s + CAR.hl; }

  // The limit that applies where the car is: from the last speed sign passed
  // (tätort 50, outside 70, gångfart about 7), or the stretch's own limit before any sign.
  var SIGN_LIMIT = { E5: 50, E6: 70, E9: 7, E10: 50 };
  function limitAt(s) {
    var best = null;
    G.course.signs.forEach(function (sg) {
      var v = sg.speed || SIGN_LIMIT[sg.code];
      if (v && !sg.pos && sg.s <= s + CAR.hl && (!best || sg.s >= best.s)) best = { s: sg.s, v: v };
    });
    return best ? best.v : G.course.pieceAt(s).limit;
  }
  function checkRules(dt) {
    var p = G.p, pc = curPiece(), kmh = p.v * KMH, lim = G.limit = limitAt(p.s);
    // Passing a cyclist: keep well out to the side.
    G.npcs.forEach(function (n) {
      if (n.kind !== "bike" || n.passedBy) return;
      if (G.prevS < n.s && p.s >= n.s) {
        n.passedBy = true;
        if (Math.abs(n.d - p.d) < 2.2) fault("bike:" + n.id, "För nära cyklisten! Kör om med ordentligt avstånd i sidled.", false);
        else if (!n.praised) { n.praised = true; praise("Bra, du gav cyklisten gott om plats."); }
      }
    });
    // Speed bumps.
    G.course.feats.forEach(function (f) {
      if (f.kind === "bump" && crossedFront(f.s) && kmh > lim + 7) fault("bump:" + f.s, "För fort över farthindret!", false);
    });
    // Speed: more than 5 km/h over for two seconds.
    if (kmh > lim + 5) p.overT += dt; else p.overT = 0;
    if (p.overT > 2) fault("speed:" + pc.index, "För fort! Här gäller " + lim + " km/h.", kmh > lim + 15);
    // Driving on the wrong side of a two-lane road.
    if (pc.kind === "road" && p.d < -1.2) {
      p.leftT += dt;
      if (pc.isSolid(p.s - pc.s0) && p.d < -1.6) fault("solid:" + pc.index, "Du körde över heldragen linje!", true);
      if (p.leftT > 9) fault("keepRight:" + pc.index, "Kör tillbaka till höger sida när du har kört om.", false);
    } else if (pc.kind === "mv" && p.d < -2) {
      var busyRight = G.npcs.some(function (n) { return n.mode === "path" && n.dir > 0 && Math.abs(n.d) < 1.5 && n.s > p.s - 5 && n.s < p.s + 80; });
      p.leftT = busyRight ? 0 : p.leftT + dt;
      if (p.leftT > 14) fault("keepRight:" + pc.index, "Kör i högra körfältet när du inte kör om.", false);
    } else p.leftT = 0;
    // Following distance.
    var ahead = null;
    G.npcs.forEach(function (n) {
      if (n.mode === "path" && n.dir > 0 && !n.parked && Math.abs(n.d - p.d) < 1.6 && n.s > p.s) { if (!ahead || n.s < ahead.s) ahead = n; }
    });
    if (ahead && p.v > 30 / KMH) {
      var gap = ahead.s - ahead.hl - p.s - CAR.hl;
      if (gap / p.v < 1.0) p.closeT += dt; else p.closeT = Math.max(0, p.closeT - dt);
      if (p.closeT > 2.5) fault("close:" + pc.index, "Du ligger för nära bilen framför. Håll större avstånd.", false);
    } else p.closeT = Math.max(0, p.closeT - dt);
  }

  // ---------- pieces ----------
  function updatePiece(pc, dt) {
    var p = G.p, st = pc.st, t = p.s - pc.s0;
    // Instructor lines at distances along the piece.
    (st.say || []).forEach(function (sy, i) {
      if (!pc.said[i] && t >= sy[0]) { pc.said[i] = true; say(sy[1]); }
    });
    if (pc.kind === "road" || pc.kind === "mv") updateRoad(pc, dt, t);
    else if (pc.kind === "junction") updateJunction(pc, dt);
    else if (pc.kind === "round") updateRound(pc, dt);
  }

  function updateRoad(pc, dt, t) {
    var st = pc.st, p = G.p, course = G.course;
    if (!pc.started && t > -200) {
      pc.started = true;
      (st.ahead || []).forEach(function (a) {
        var vtAt = a.queue ? queueFn(pc, a) : a.brakeAt ? brakeFn(pc, a) : null;
        var car = new PathCar({ s: pc.s0 + a.s, d: a.d != null ? a.d : a.kind === "bike" ? 1.15 : 0, v: a.v / KMH, kind: a.kind || "car", color: a.color, vtAt: vtAt, ttl: a.ttl ? pc.s0 + a.ttl : 0 });
        if (a.brakeAt) car.suddenAt = pc.s0 + a.brakeAt;
        G.npcs.push(car);
      });
      (st.parked || []).forEach(function (s) {
        G.npcs.push(new PathCar({ s: pc.s0 + s, d: 3.0, v: 0, kind: "car", parked: true }));
      });
    }
    (st.oncoming || []).forEach(function (o, i) {
      var key = "on" + i;
      if (!pc[key] && t >= o) {
        pc[key] = true;
        var s = Math.min(p.s + 230, course.endS - 4);
        if (s - p.s > 60) G.npcs.push(new PathCar({ s: s, d: pc.kind === "mv" ? -12 : -3.5, dir: -1, v: (pc.limit - 8) / KMH }));
      }
    });
    (st.behind || []).forEach(function (b, i) {
      var key = "bh" + i;
      if (!pc[key] && t >= b.at) {
        pc[key] = true;
        var car = new PathCar({ s: p.s - (b.back || 110), d: b.d != null ? b.d : 0, v: b.v / KMH, kind: b.kind || "car" });
        G.npcs.push(car);
        if (b.kind === "amb") say("Jag hör sirener! Utryckningsfordon bakifrån. Blinka höger så kör du åt sidan och saktar in.", "", true);
      }
    });
    extraLife(pc, dt, t);
    if (st.moose && !pc.mooseOn && t >= st.moose.s - 85) {
      pc.mooseOn = true;
      G.npcs.push(new Walker({ kind: "moose", s: pc.s0 + st.moose.s, u: 14, vu: -3.4, owner: pc, trigger: 0 }));
    }
    if (st.child && !pc.childOn && t >= st.child.s - 20) {
      pc.childOn = true;
      G.npcs.push(new Walker({ kind: "child", s: pc.s0 + st.child.s, u: 3.4, vu: -1.7, owner: pc, trigger: 0, color: "#f18f01" }));
    }
    signRoad(pc, dt, t);
    if (st.finish && t > pc.len - 45 && t <= pc.len + 30) {
      if (p.v < 0.3 && G.finishT < 0) G.finishT = G.t;
      if (t > pc.len - 3) { p.v = 0; if (G.finishT < 0) G.finishT = G.t; }
    }
    if (pc.kind === "mv" && st.dec && t >= st.dec[1] - 2 && !pc.exitDone) {
      pc.exitDone = true;
      if (p.d > 2) { praise("Snyggt! Nu har vi lämnat motorvägen."); G.finishT = G.t + 2; }
      else { fault("exit", "Vi missade avfarten. Byt körfält i god tid nästa gång.", false); G.finishT = G.t + 2; }
    }
    if (pc.kind === "mv" && st.acc && !pc.mergeChecked && p.d < 0.5 && t < st.acc + 30) {
      pc.mergeChecked = true;
      if (p.v * KMH < 65) fault("merge", "Du körde in på motorvägen för sakta. Gasa upp i accelerationsfältet.", false);
      else praise("Bra påfart!");
    }
  }
  // More traffic and more people than the lesson itself has, from the menu settings.
  function extraLife(pc, dt, t) {
    var p = G.p, lvT = store.traffic || 0, lvP = store.walkers || 0;
    if (pc.env === "stad" && lvP && !pc.strollers && t > -150) {
      pc.strollers = true;
      var r = rng(pc.s0 + 5), n = Math.round(pc.len / 45 * lvP);
      for (var i = 0; i < n; i++) {
        var right = r() < 0.5, u = right ? 3.05 + (pc.parking ? 2.5 : 0) : -6.55;
        var wk = new Walker({ kind: "stroll", s: pc.s0 + 10 + r() * (pc.len - 20), u: u, vs: (r() < 0.5 ? -1 : 1) * (1.0 + r() * 0.5) });
        wk.lo = pc.s0 + 4; wk.hi = pc.s0 + pc.len - 4; G.npcs.push(wk);
      }
    }
    if (!lvT || t < 0 || t > pc.len) return;
    pc.extraT = (pc.extraT || 0) - dt;
    if (pc.extraT > 0) return;
    pc.extraT = (lvT === 1 ? 8 : 4) * (0.7 + Math.random() * 0.6);
    var course = G.course, s = Math.min(p.s + 230, course.endS - 4);
    if (pc.kind === "mv") {
      G.npcs.push(new PathCar({ s: s, d: Math.random() < 0.5 ? -14.35 : -17.85, dir: -1, v: (100 + Math.random() * 20) / KMH }));
      var free = !G.npcs.some(function (o) { return o.mode === "path" && o.dir > 0 && Math.abs(o.d + 3.5) < 1 && Math.abs(o.s - (p.s - 110)) < 30; });
      if (free && Math.random() < 0.6) G.npcs.push(new PathCar({ s: p.s - 110, d: -3.5, v: 125 / KMH }));
      return;
    }
    if (s - p.s < 80) return;
    var busy = G.npcs.some(function (o) { return o.mode === "path" && o.dir < 0 && Math.abs(o.s - s) < 30; });
    if (!busy) G.npcs.push(new PathCar({ s: s, d: -3.5, dir: -1, v: (pc.limit - 6) / KMH }));
  }
  function signRoad(pc, dt, t) {
    var st = pc.st, p = G.p;
    events(pc, dt, t);
    // Omkörningsförbud: passing a motor vehicle inside the zone.
    if (st.noOvertake && t > st.noOvertake[0] && t < st.noOvertake[1]) {
      G.npcs.forEach(function (n) {
        if (n.mode !== "path" || n.dir < 0 || n.parked || n.kind === "bike") return;
        if (G.prevS < n.s && p.s >= n.s) fault("overtake:" + pc.index, "Omkörningsförbud! Skylten förbjuder omkörning här.", true);
      });
    }
    // Vägarbete: the right lane is shut; B6 says oncoming traffic goes first.
    if (st.works) {
      var w0 = pc.s0 + st.works.s, w1 = w0 + st.works.len;
      if (crossedFront(w0) && G.npcs.some(function (n) { return n.mode === "path" && n.dir < 0 && n.s > w0 - 5 && n.s < w1 + 40; }))
        fault("works:" + pc.index, "Väjningsplikt mot mötande! Vänta tills mötande har passerat vägarbetet.", true);
      if (p.s + CAR.hl > w0 && p.s - CAR.hl < w1 && p.d > -1.15) return crash("Du körde in i vägarbetet!");
    }
    // Parking: stop at the edge where parking is allowed, not where stopping is forbidden.
    if (st.park && !pc.parkDone && p.stillT > 1.2) {
      if (t > st.park.noStop[0] && t < st.park.noStop[1]) fault("park:" + pc.index, "Här får du inte stanna. Skylten förbjuder att stanna och parkera.", true);
      else if (t > st.park.zone[0] && t < st.park.zone[1]) {
        if (p.d > 1.8) { pc.parkDone = true; praise("Snyggt parkerat! Här är parkering tillåten."); G.finishT = G.t + 1.5; }
        else if (!pc.parkHint) { pc.parkHint = true; say("Kör in i parkeringsfickan till höger och stanna där."); }
      }
    }
    if (st.park && !pc.parkDone && t > pc.len - 4) { pc.parkDone = true; fault("park:" + pc.index, "Vi missade parkeringen. Stanna där skylten P står.", false); G.finishT = G.t + 1; }
    // People walking in a gångfartsområde.
    if (st.street && !pc.streetOn && t > -120) {
      pc.streetOn = true;
      for (var i = 0; i < st.street; i++) {
        var wk = new Walker({ kind: "stroll", s: pc.s0 + 20 + i * (pc.len - 40) / st.street, u: i % 2 ? -4.4 : 1.45, vs: (i % 3 ? 1 : -1) * 1.1 });
        wk.lo = pc.s0 + 6; wk.hi = pc.s0 + pc.len - 6; G.npcs.push(wk);
      }
    }
  }
  function events(pc, dt, t) {
    var st = pc.st, p = G.p, f = front();
    if (!pc.evOn && t > -200) {
      pc.evOn = true;
      if (st.police) {
        G.npcs.push(new PathCar({ s: pc.s0 + st.police.s + 14, d: 3.7, v: 0, kind: "police", parked: true }));
        pc.officer = new Walker({ kind: "officer", s: pc.s0 + st.police.s, u: 2.4, vu: 0 }); G.npcs.push(pc.officer);
        pc.pol = { state: "wait", t: 0 };
      }
      if (st.accident) {
        var a0 = pc.s0 + st.accident.s;
        G.npcs.push(new PathCar({ s: a0 + 8, d: 0.35, v: 0, parked: true, yaw: 0.45, blink: 2, color: "#5a4fcf" }));
        G.npcs.push(new PathCar({ s: a0 + 14, d: 0.5, v: 0, parked: true, yaw: -0.35, blink: 2, color: COL.silver }));
        G.npcs.push(new PathCar({ s: a0 + st.accident.len, d: 3.9, v: 0, parked: true, kind: "amb" }));
        G.npcs.push(new Walker({ kind: "ped", s: a0 + 11, u: 2.9, vu: 0 }));
      }
      if (st.breakdown) {
        pc.broken = new PathCar({ s: pc.s0 + st.breakdown.s, d: 3.0, v: 0, parked: true, blink: 2, color: COL.yellow });
        G.npcs.push(pc.broken);
        G.npcs.push(new Walker({ kind: "ped", s: pc.s0 + st.breakdown.s + 4, u: 6.5, vu: 0 }));
      }
    }
    // Polisman's stop sign: arm raised. Police signals come before signs, signals and other rules.
    if (st.police && pc.pol) {
      var ps = pc.s0 + st.police.s, P = pc.pol;
      P.t += dt;
      if (P.state === "wait") {
        if (f > ps - 24 && f < ps - 1 && p.stillT > 0.8) {
          P.state = "talk"; P.t = 0;
          say("Polisen: Hej! Det här är en nykterhetskontroll. Blås i den här, tack.", "", true);
        } else if (f >= ps - 1) {
          P.state = "done"; pc.officer.vu = 1.2;
          fault("police:" + pc.index, "Du stannade inte för polisens stopptecken! Polisens tecken gäller före skyltar, signaler och andra regler.", true);
        } else if (p.stillT > 1.5 && f < ps - 24 && !P.hint) { P.hint = true; say("Kör fram lite närmare polisen och stanna där."); }
      } else if (P.state === "talk") {
        if (P.t > 3.6 && !P.said) { P.said = true; say("Polisen: Tack, det var bra. Kör försiktigt!"); }
        if (p.v > 1 && P.t < 5) fault("police:" + pc.index, "Vänta tills polisen säger att du får köra.", false);
        if (P.t > 6) { P.state = "done"; pc.officer.vu = 1.2; praise("Bra! Du stannade direkt när polisen gav tecken."); }
      }
    }
    // Trafiksäkerhetskamera.
    if (st.camera && crossedFront(pc.s0 + st.camera.s)) {
      var kmh = p.v * KMH, lim = G.limit || pc.limit;
      if (kmh > lim + 3) fault("camera:" + pc.index, "Blixt! Kameran fotograferade dig i " + Math.round(kmh) + " km/h där det är " + lim + ".", kmh > lim + 10);
      else praise("Bra fart förbi kameran.");
    }
    // Olycka: the cars stand in our lane, so oncoming traffic goes first.
    if (st.accident) {
      var w0 = pc.s0 + st.accident.s, w1 = w0 + st.accident.len;
      if (crossedFront(w0 - 2) && G.npcs.some(function (n) { return n.mode === "path" && n.dir < 0 && n.s > w0 - 5 && n.s < w1 + 40; }))
        fault("accident:" + pc.index, "Hindret står i ditt körfält, så du ska låta mötande passera först.", true);
    }
    // A car stopped on the verge: pass with room to spare.
    if (pc.broken && !pc.brokenDone && G.prevS < pc.broken.s && p.s >= pc.broken.s) {
      pc.brokenDone = true;
      if (p.d > 0.3 && p.v * KMH > 40) fault("verge:" + pc.index, "Ge mer plats och sakta in när du kör förbi en bil på vägrenen.", false);
      else praise("Bra, du gav bilen på vägrenen plats.");
    }
    // Someone crossing where there is no zebra crossing.
    if (st.jaywalk && !pc.jayOn && t >= st.jaywalk.s - 26) {
      pc.jayOn = true;
      G.npcs.push(new Walker({ kind: "ped", s: pc.s0 + st.jaywalk.s, u: 4.0, vu: -1.4, color: "#6a4c93" }));
    }
  }
  // A car ahead that brakes hard at one spot, then drives on.
  function brakeFn(pc, a) {
    var b0 = pc.s0 + a.brakeAt, vt = a.v / KMH;
    return function (s) { return s > b0 && s < b0 + 35 ? 8 / KMH : vt; };
  }
  function queueFn(pc, a) {
    var q0 = pc.s0 + a.queue[0], q1 = q0 + a.queue[1], vt = a.v / KMH;
    return function (s) { return s > q0 - 40 && s < q1 ? 22 / KMH : vt; };
  }

  // Junctions: cross traffic is timed to meet the car, so it has to give way.
  function armOf(name) { return { right: 0, fwd: 90, left: 180 }[name]; }
  function turnOf(name) { return { straight: 0, right: 1, left: -1 }[name]; }
  function lightFor(pc, arm) {
    var L = pc.light; if (!L) return "green";
    var mine = arm === 90 || arm === 270;
    if (mine) return L.ph;
    if (L.ph === "red" && L.t > 1.2 && L.t < 5.6) return "green";
    if (L.ph === "red" && L.t >= 5.6 && L.t < 7) return "yellow";
    return "red";
  }
  function spawnJunctionCar(pc, spec, lead) {
    var arm = armOf(spec.from), turn = turnOf(spec.to || "straight");
    var land = pc.env !== "stad";
    var vt = (spec.v || (land ? 70 : 40)) / KMH;
    lead = lead || (land ? 160 : 90);
    var poly = polyG(pc.C, turnFromArm(arm, turn, lead, 120));
    var p = G.p, eta = Math.max(1.6, (pc.s0 - p.s) / Math.max(p.v, 7)) * (spec.eta || 1);
    var t0 = spec.prio === false ? lead - 45 : Math.max(0, lead - vt * eta);
    if (spec.at != null) t0 = lead - spec.at;
    var car = new PolyCar({ poly: poly, t: t0, v: vt, vt: vt, prio: spec.prio !== false, stopT: lead - 1.2, owner: pc,
      blink: turn === 1 ? 1 : turn === -1 ? -1 : 0, color: spec.color });
    car.arm = arm; car.entryT = lead;
    if (pc.light) car.canGo = function () { var l = lightFor(pc, arm); return l === "green" || (l === "yellow" && car.t > car.stopT - 8); };
    else if (spec.prio === false) car.canGo = function () {
      var pp = G.p, cleared = pp.s > pc.s0 + (pc.len || 0) + 3 && !pc.open;
      if (cleared) return true;
      if (pp.stillT > 2.5 && pc.s0 - pp.s < 25) { car.waved = true; return true; }
      return car.waved || pc.s0 - pp.s > 70;
    };
    G.npcs.push(car); pc.npcs.push(car);
    return car;
  }
  function updateJunction(pc, dt) {
    var p = G.p, st = pc.st, dist = pc.s0 - p.s;
    if (!pc.spawned && dist < (pc.env === "stad" ? 65 : 110)) {
      pc.spawned = true; pc.faultsAt = G.faults.length;
      if (!pc.light) (st.npcs || []).forEach(function (sp) { spawnJunctionCar(pc, sp); });
    }
    var L = pc.light;
    if (L) {
      L.t += dt;
      if (!L.triggered && dist < 46 && dist > 12) { L.triggered = true; L.ph = "yellow"; L.t = 0; }
      if (L.ph === "yellow" && L.t > 2.5) { L.ph = "red"; L.t = 0;
        spawnJunctionCar(pc, { from: "right", to: "straight", at: 50 }); spawnJunctionCar(pc, { from: "left", to: "straight", at: 70 }); }
      else if (L.ph === "red" && L.t > 7.5) { L.ph = "redyellow"; L.t = 0; }
      else if (L.ph === "redyellow" && L.t > 1.5) { L.ph = "green"; L.t = 0;
        if (!pc.oncomingDone && st.want === -1) { pc.oncomingDone = true; spawnJunctionCar(pc, { from: "fwd", to: "straight", at: 40, v: 40 }); } }
      else if (L.ph === "green" && L.triggered && L.t > 14) { L.ph = "yellow"; L.t = 0; }
      if (crossedFront(pc.s0 - 0.3) && L.ph === "red") fault("red:" + pc.index, "Du körde mot rött ljus!", true);
    }
    // Stop sign: the car has to stand still within the last metres before the line.
    if (st.ctrl === "stopp") {
      var f = front();
      if (f > pc.s0 - 12 && f < pc.s0 + 0.5 && p.v < 0.2) pc.stopped = true;
    }
    // Good words once through without new faults.
    if (!pc.open && !pc.praised && p.s > pc.s0 + pc.len + 2) {
      pc.praised = true;
      if (G.faults.length === pc.faultsAt && st.good) praise(st.good);
    }
  }
  function crossedFront(x) { return G.prevS + CAR.hl < x && G.p.s + CAR.hl >= x; }

  function decideJunction(pc) {
    var p = G.p, st = pc.st, want = pc.want;
    var dir = p.blink, ok = function (d) { return d === 0 ? pc.arms[90] : d === 1 ? pc.arms[0] : pc.arms[180]; };
    if (!ok(dir)) {
      if (dir === 0) { dir = ok(want) ? want : ok(1) ? 1 : -1; fault("blink:" + pc.index, "Du glömde blinka före svängen.", false); }
      else dir = ok(want) ? want : ok(0) ? 0 : -dir;
    }
    if (dir !== 0 && p.blinkS > pc.s0 - 22 && !G.faultKeys["blink:" + pc.index]) fault("blink:" + pc.index, "Blinka tidigare, i god tid före svängen.", false);
    signRules(pc, dir);
    if (dir !== want && !pc.st.free) fault("route:" + pc.index, pc.st.routeMsg || (want === 0 ? "Vi skulle köra rakt fram." : want === 1 ? "Vi skulle svänga höger." : "Vi skulle svänga vänster."), false);
    if (dir !== 0 && p.v * KMH > 32) fault("turn:" + pc.index, "För hög fart i svängen!", false);
    if (st.ctrl === "stopp" && !pc.stopped) fault("stop:" + pc.index, "Du stannade inte vid stopplinjen. Vid stopplikt ska bilen stå helt still.", true);
    pc.dir = dir;
    var local = turnLocal(dir, 0, 0).slice(1);
    local.unshift({ x: 1.75, y: -JH });
    pc.poly = polyG(pc.C, local);
    pc.len = pc.poly.len; pc.open = false;
    yieldCheck(pc, pc.poly);
    if (p.blink) p.blink = 0;
    G.course.close(pc);
  }
  // Give way: a car with right of way that will cross our path soon.
  function yieldCheck(pc, poly) {
    var st = pc.st, mine = sample(poly, 1);
    pc.npcs.forEach(function (n) {
      if (!n.prio || n.gone) return;
      var tc = conflictT(n.poly, mine, n.t);
      if (tc < 0) return;
      var togo = tc - n.t;
      if (togo > -3 && togo < n.v * 2.6 + 6) {
        if (pc.light && n.arm !== 90) return;   // their red is our green
        fault("yield:" + pc.index, pc.light ? "Mötande trafik som kör rakt fram har företräde när du svänger vänster!" :
          st.ctrl === "hoger" ? "Högerregeln! Bilen från höger hade företräde." : "Du lämnade inte företräde!", true);
      }
    });
  }
  // Turns the signs forbid: no entry into a side road, no left turn, a direction you must take.
  function signRules(pc, dir) {
    var st = pc.st, name = dir === 0 ? "fwd" : dir === 1 ? "right" : "left";
    if ((st.noEntry || []).indexOf(name) >= 0) fault("sign:" + pc.index, "Infart förbjuden! Skylten vid gatan visar att du inte får köra in där.", true);
    if (st.noLeft && dir === -1) fault("sign:" + pc.index, "Skylten förbjuder vänstersväng i korsningen!", true);
    if (st.mustGo != null && dir !== st.mustGo) fault("sign:" + pc.index, "Skylten visar påbjuden körriktning. Där måste du köra dit pilen pekar.", true);
  }
  function sample(poly, step) { var out = []; for (var t = 0; t <= poly.len; t += step) out.push(poly.at(t)); return out; }
  function conflictT(poly, pts, fromT) {
    for (var t = Math.max(0, fromT - 10); t < poly.len; t += 1) {
      var q = poly.at(t);
      for (var i = 0; i < pts.length; i++) if (Math.abs(pts[i].x - q.x) < 2.4 && Math.abs(pts[i].y - q.y) < 2.4) return t;
    }
    return -1;
  }

  function updateRound(pc, dt) {
    var p = G.p, st = pc.st, t = p.s - pc.s0;
    if (!pc.spawned && t > -70) {
      pc.spawned = true; pc.faultsAt = G.faults.length;
      (st.npcs || []).forEach(function (sp) {
        var ain = armOf(sp.from), aout = sp.to === "back" ? 270 : armOf(sp.to);
        var lead = 60, th = ringEnd(ain, aout);
        var poly = polyG(pc.C, roundLocal(ain, th, aout, lead, 80));
        var vt = 25 / KMH;
        var tc = conflictT(poly, [pc.poly.at(pc.joinT)], 0);
        var eta = Math.max(1.5, (pc.joinT - t) / Math.max(p.v, 6)) * (sp.eta || 1);
        var car = new PolyCar({ poly: poly, t: Math.max(0, (tc > 0 ? tc : lead + 20) - vt * eta), v: vt, vt: vt, prio: true, stopT: -1, owner: pc, color: sp.color });
        car.tConf = tc;
        G.npcs.push(car); pc.npcs.push(car);
      });
    }
    if (crossedFront(pc.s0 + RB.arm - RB.outer - 0.5)) {
      pc.npcs.forEach(function (n) {
        if (n.gone || n.tConf < 0) return;
        var togo = n.tConf - n.t;
        if (togo > -2 && togo < n.v * 2.4 + 5) fault("yield:" + pc.index, "Bilen i cirkulationsplatsen hade företräde!", true);
      });
    }
    // Leave at the exit the car is at while blinking right.
    if (pc.open && !G.manual) {
      for (var i = 0; i < pc.exitAt.length; i++) {
        var ex = pc.exitAt[i];
        var last = i === pc.exitAt.length - 1;
        if (crossed(pc.s0 + ex.t - 6) && (p.blink === 1 || last)) {
          var poly = polyG(pc.C, roundLocal(270, ex.th, ex.a, 0, 0));
          pc.poly = poly; pc.len = poly.len; pc.open = false;
          var k = ((ex.k - 1) % 4) + 1;
          if (k !== pc.want) fault("route:" + pc.index, "Fel avfart. Vi skulle ta avfart nummer " + pc.want + ".", false);
          if (p.blinkS > pc.s0 + ex.t - 14 && !last) fault("blink:" + pc.index, "Blinka höger lite tidigare innan du kör ut.", false);
          p.blink = 0;
          G.course.close(pc);
          break;
        }
      }
    } else if (!pc.open && !pc.praised && t > pc.len + 2) {
      pc.praised = true;
      if (G.faults.length === pc.faultsAt && st.good) praise(st.good);
    }
  }

  // ---------- features on roads ----------
  function updateFeat(f, dt) {
    var p = G.p;
    if (f.kind === "zebra") {
      if (!f.started && f.s - p.s < (f.peds[0] && f.peds[0].dist || 48)) {
        f.started = true;
        var list = f.peds.slice(), extra = [0, 1, 3][store.walkers || 0];
        for (var e = 0; e < extra; e++) list.push({ side: e % 2 ? "right" : "left" });
        list.forEach(function (pd, i) {
          var fromRight = pd.side !== "left";
          G.npcs.push(new Walker({ s: f.s + (i % 2 ? 0.6 : -0.6), u: fromRight ? 4.2 + i * 1.2 : -8.7 - i * 1.2, vu: fromRight ? -1.35 : 1.35, owner: f }));
        });
      }
      if (crossedFront(f.s - 1.6)) {
        var onIt = G.npcs.some(function (n) { return n.owner === f && n.u > -6.1 && n.u < 2.6 && !n.done; });
        if (onIt) fault("ped:" + f.s, "Stanna! Gående på övergångsstället har företräde.", true);
        else if (f.peds.length && !G.faultKeys["ped:" + f.s]) { f.ok = true; }
      }
      if (f.ok && !f.praised && p.s > f.s + 5) { f.praised = true; praise("Bra, du lät den gående gå över."); }
    } else if (f.kind === "rail") {
      f.t += dt;
      if (f.state === "open" && f.s - p.s < 150 && f.s - p.s > 0 && !f.used) {
        f.used = true; f.state = "warn"; f.t = 0;
      }
      if (f.state === "warn" && f.t > 3) { f.state = "down"; f.t = 0;
        var pose = G.course.poseAt(f.s);
        var tr = { mode: "train", id: nextId++, kind: "train", hl: 32, hw: 1.6, owner: f, gone: false,
          poly: new Poly([toG(pose, 260, 0), toG(pose, -260, 0)]), t: 0, v: 26 };
        G.npcs.push(tr); f.train = tr; }
      if (f.state === "down" && f.train && f.train.t > 300) { f.state = "up"; f.t = 0; }
      if (f.state === "up" && f.t > 3) { f.state = "open"; praise("Bommarna är uppe. Nu kan vi köra."); }
      if (crossedFront(f.s - 6) && f.state !== "open") fault("rail", "Stanna när ljusen vid järnvägskorsningen blinkar!", true);
      if (f.state === "open" && f.used && !f.praised && p.s > f.s + 5 && !G.faultKeys.rail) { f.praised = true; }
    } else if (f.kind === "bus") {
      if (!f.bus) {
        f.bus = new PathCar({ s: f.s, d: 3.5, v: 0, kind: "bus", color: "#d33a3a" });
        f.bus.busState = "wait"; G.npcs.push(f.bus);
      }
      var b = f.bus;
      if (b.busState === "wait" && f.s - p.s < 55) { b.busState = "signal"; b.blink = -1; b.wait = 1.4; }
      if (b.busState === "signal") { b.wait -= dt; if (b.wait <= 0) { b.busState = "out"; b.td = 0; b.vt = 30 / KMH; } }
      if (b.busState === "out" && Math.abs(b.d) < 0.05) { b.busState = "drive"; b.blink = 0; b.vt = 38 / KMH; }
      if ((b.busState === "signal" || b.busState === "out") && front() > b.s - b.hl + 2 && p.s < b.s + b.hl)
        fault("bus", "Bussen blinkade för att köra ut. Här skulle du släppa ut den!", false);
    }
  }

  // ---------- road users ----------
  function updatePathCar(n, dt) {
    var p = G.p;
    if (n.parked) { if (n.s < p.s - 80) n.gone = true; return; }
    var vt = n.vtAt ? n.vtAt(n.s) : n.vt;
    if (n.dir < 0 && p.d < -2 && n.s > p.s && n.s - p.s < 30) vt = 0;
    if (n.dir > 0) {
      // Keep a distance to whatever is ahead in the same lane.
      var gap = Infinity, ov = 0;
      var check = function (s, d, hl, v) {
        if (Math.abs(d - n.d) < 1.8 && s > n.s) { var g = s - hl - n.s - n.hl; if (g < gap) { gap = g; ov = v; } }
      };
      check(p.s, p.d, CAR.hl, p.v);
      G.npcs.forEach(function (o) { if (o !== n && o.mode === "path" && o.dir > 0) check(o.s, o.d, o.hl, o.v); });
      var safe = 3 + n.v * 1.1;
      if (gap < safe) vt = Math.min(vt, Math.max(0, ov - 1 + (gap - 3) * 0.3));
      // The ambulance goes round the car in front.
      if (n.kind === "amb") {
        var dp = p.s - n.s;
        if (!n.passed && dp > -10 && dp < 45) { n.td = -3.2; vt = n.vt; }
        if (!n.passed && n.s > p.s + 3) {
          n.passed = true;
          if (p.d < 0.6 && p.v * KMH > 30) fault("amb", "Du gav inte plats åt utryckningsfordonet!", false);
          else praise("Bra, du gav plats.");
        }
        if (n.passed && n.s > p.s + 18) n.td = 0;
        siren(clamp(1 - Math.abs(n.s - p.s) / 250, 0, 1));
      }
      if (n.kind === "bus" && (n.busState === "wait" || n.busState === "signal")) vt = 0;
    }
    if (n.ttl && (n.kind === "tractor" || n.kind === "bike")) {
      // The tractor turns off onto a field road, the cyclist onto a side street.
      if (n.s > n.ttl - 40) n.blink = 1;
      if (n.s > n.ttl) { n.td = 6; vt = Math.min(vt, 3); }
      if (n.d > 5.9) n.gone = true;
    } else if (n.ttl && n.s > n.ttl && n.s - p.s > 140) n.gone = true;
    var acc = vt > n.v ? 2.2 : -7;
    n.v = vt > n.v ? Math.min(vt, n.v + acc * dt) : Math.max(vt, n.v + acc * dt);
    n.s += n.v * dt * n.dir;
    if (n.td !== n.d) { var st = Math.min(Math.abs(n.td - n.d), 2.2 * dt); n.d += n.td > n.d ? st : -st; }

    if (n.s > p.s + 420 || n.s < p.s - 200) { n.gone = true; if (n.kind === "amb") siren(0); }
  }
  function npcPose(n) {
    if (n.mode === "path") {
      var q = G.course.poseAt(n.s);
      var x = q.x + Math.cos(q.a) * n.d, y = q.y + Math.sin(q.a) * n.d;
      return { x: x, y: y, a: q.a + (n.dir < 0 ? Math.PI : 0) + (n.yaw || 0) };
    }
    if (n.mode === "poly" || n.mode === "train") return n.poly.at(n.t);
    var w = G.course.poseAt(n.s);
    var wa = n.kind === "officer" ? w.a + Math.PI : n.kind === "stroll" ? w.a + (n.vs < 0 ? Math.PI : 0) : w.a + (n.vu < 0 ? -Math.PI / 2 : Math.PI / 2);
    return { x: w.x + Math.cos(w.a) * n.u, y: w.y + Math.sin(w.a) * n.u, a: wa };
  }
  function updatePolyCar(n, dt) {
    var vt = n.vt;
    if (n.stopT > 0 && n.t < n.stopT && !n.canGo()) vt = Math.min(vt, Math.sqrt(2 * 4.5 * Math.max(0, n.stopT - n.t - 0.3)));
    // Brake for the player's car if it stands in the way.
    var me = n.poly.at(n.t), p = G.p;
    var fx = Math.sin(me.a), fy = -Math.cos(me.a), dx = p.x - me.x, dy = p.y - me.y;
    var ahead = dx * fx + dy * fy, side = Math.abs(dx * fy - dy * fx);
    if (ahead > 0 && ahead < 14 && side < 2.6) vt = Math.min(vt, Math.max(0, (ahead - 5.5) * 0.8));
    n.v = vt > n.v ? Math.min(vt, n.v + 2.5 * dt) : Math.max(vt, n.v - 7 * dt);
    n.t += n.v * dt;
    if (n.t > n.poly.len) n.gone = true;
  }
  function updateWalker(n, dt) {
    var p = G.p;
    n.u += n.vu * dt;
    if (n.kind === "stroll") {
      // Walks along its own block and turns round at the corners.
      n.s += n.vs * dt;
      if ((n.s < n.lo && n.vs < 0) || (n.s > n.hi && n.vs > 0)) n.vs = -n.vs;
      if (Math.abs(n.s - p.s) > 220) n.gone = true;
      return;
    }
    if (n.kind === "moose" || n.kind === "child") {
      if (!n.done && (n.vu < 0 ? n.u < -9 : n.u > 4)) {
        n.done = true;
        if (n.kind === "moose") praise("Bra reagerat! Älgen kom över vägen.");
        else praise("Bra! Barn kan springa ut mellan parkerade bilar.");
      }
    }
    if (n.u < -14 || n.u > 18) n.gone = true;
    if (n.kind === "ped" && n.vu && (n.vu < 0 ? n.u < -8.2 : n.u > 3.8)) { n.done = true; n.gone = true; }
    if (n.kind === "officer" && n.u > 4.6) n.vu = 0;
    if (n.s < p.s - 120) n.gone = true;
  }
  function updateTrain(n, dt) { n.t += n.v * dt; if (n.t > n.poly.len + 80) { n.gone = true; } }

  // ---------- crashes ----------
  function boxOf(o, pose) { return { x: pose.x, y: pose.y, a: pose.a, hl: o.hl, hw: o.hw }; }
  function overlap(A, B) {
    var axes = [A.a, A.a + Math.PI / 2, B.a, B.a + Math.PI / 2];
    for (var i = 0; i < 4; i++) {
      var ax = Math.sin(axes[i]), ay = -Math.cos(axes[i]);
      var ra = A.hl * Math.abs(Math.sin(A.a) * ax - Math.cos(A.a) * ay) + A.hw * Math.abs(Math.cos(A.a) * ax + Math.sin(A.a) * ay);
      var rb = B.hl * Math.abs(Math.sin(B.a) * ax - Math.cos(B.a) * ay) + B.hw * Math.abs(Math.cos(B.a) * ax + Math.sin(B.a) * ay);
      var dist = Math.abs((B.x - A.x) * ax + (B.y - A.y) * ay);
      if (dist > ra + rb) return false;
    }
    return true;
  }
  function checkCrash() {
    var p = G.p, me = { x: p.x, y: p.y, a: p.a, hl: CAR.hl, hw: CAR.hw };
    for (var i = 0; i < G.npcs.length; i++) {
      var n = G.npcs[i];
      if (n.mode === "train") {
        var tp = n.poly.at(n.t);
        var box = { x: tp.x, y: tp.y, a: tp.a, hl: 6, hw: 1.6 };
        for (var k = 0; k < 4; k++) {
          box.x = tp.x - Math.sin(tp.a) * k * 13.5; box.y = tp.y + Math.cos(tp.a) * k * 13.5;
          if (overlap(me, box)) return crash("Du krockade med tåget!");
        }
        continue;
      }
      if (overlap(me, boxOf(n, npcPose(n)))) {
        var what = { ped: "en gående", stroll: "en gående", officer: "polisen", police: "polisbilen", bike: "en cyklist", child: "ett barn", moose: "en älg", bus: "bussen", truck: "lastbilen", amb: "ambulansen", tractor: "traktorn" }[n.kind] || "en bil";
        return crash("Krock med " + what + "!");
      }
    }
  }
  function crash(text) {
    if (G.crashed) return;
    G.crashed = true; G.p.v = 0;
    G.faults.push({ title: text, info: FAULT_INFO.crash, serious: true });
    say(text, "bad", true); flash(); beep(110, 0.5, 0.08);
    G.finishT = G.t + 1.6;
  }

  // ---------- drawing ----------
  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  }
  window.addEventListener("resize", resize);

  function rr(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function rect(c, u0, u1, w0, w1) { ctx.fillStyle = c; ctx.fillRect(u0, -w1, u1 - u0, w1 - w0); }
  function disc(c, x, y, r) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
  // Dashed line along w in a piece frame; phase keeps dashes continuous between pieces.
  function dashes(u, w0, w1, dash, gap, width, phase, color) {
    ctx.fillStyle = color || COL.paint;
    var per = dash + gap, start = w0 - ((w0 + phase) % per + per) % per;
    for (var w = start; w < w1; w += per) {
      var a = Math.max(w, w0), b = Math.min(w + dash, w1);
      if (b > a) ctx.fillRect(u - width / 2, -b, width, b - a);
    }
  }
  // Faint speckles on the grass, like the situation pictures; one tile is 10 m.
  var speckle = null;
  function speckles(c2, x, y, w, h) {
    if (!speckle) {
      var cv2 = document.createElement("canvas"); cv2.width = cv2.height = 128;
      var x2 = cv2.getContext("2d"), r = rng(7);
      for (var i = 0; i < 260; i++) {
        x2.fillStyle = r() < 0.5 ? "rgba(255,255,255,0.10)" : "rgba(0,40,0,0.10)";
        x2.fillRect(Math.floor(r() * 128), Math.floor(r() * 128), 2, 2);
      }
      speckle = c2.createPattern(cv2, "repeat");
      if (speckle.setTransform && window.DOMMatrix) speckle.setTransform(new DOMMatrix().scale(10 / 128));
    }
    c2.fillStyle = speckle; c2.fillRect(x, y, w, h);
  }
  function framePiece(P) { ctx.save(); ctx.translate(P.x, P.y); ctx.rotate(P.a); }

  function drawRoadGround(pc) {
    framePiece(pc.P);
    var L = pc.len;
    if (pc.kind === "mv") {
      pc.decor.forEach(function (d) { disc(COL.tree, d.u, -d.w, d.r); disc(COL.treeLight, d.u - d.r * 0.25, -d.w - d.r * 0.25, d.r * 0.55); });
    } else if (pc.env === "stad") {
      var pr = pc.parking ? 2.5 : 0;
      rect(COL.walk, 1.75 + pr, 1.75 + pr + 2.6, 0, L); rect(COL.walk, -5.25 - 2.6, -5.25, 0, L);
      pc.decor.forEach(function (d) {
        if (d.t !== "house") return;
        ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(d.u + 0.6, -d.w - d.len + 0.8, d.dep, d.len);
        ctx.fillStyle = d.c; ctx.fillRect(d.u, -d.w - d.len, d.dep, d.len);
        ctx.fillStyle = d.roof; ctx.fillRect(d.u + 0.8, -d.w - d.len + 0.8, d.dep - 1.6, d.len - 1.6);
        ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fillRect(d.u + 0.8, -d.w - d.len / 2 - 0.15, d.dep - 1.6, 0.3);
      });
    } else {
      pc.decor.forEach(function (d) {
        if (d.t === "field") { ctx.fillStyle = "#8fae5c"; ctx.fillRect(d.u, -d.w - d.len, d.dep, d.len);
          ctx.fillStyle = "rgba(0,0,0,0.06)"; for (var k = 1; k < d.dep; k += 2.2) ctx.fillRect(d.u + k, -d.w - d.len, 0.6, d.len); }
      });
      pc.decor.forEach(function (d) { if (d.t === "tree") { disc("rgba(0,0,0,0.18)", d.u + 0.5, -d.w + 0.7, d.r); disc(COL.tree, d.u, -d.w, d.r); disc(COL.treeLight, d.u - d.r * 0.25, -d.w - d.r * 0.25, d.r * 0.55); } });
    }
    ctx.restore();
  }
  function drawRoadAsphalt(pc) {
    framePiece(pc.P);
    var L = pc.len, st = pc.st;
    if (pc.kind === "mv") {
      rect("#8c8a82", -6.2, 4.5, 0, L);
      rect(COL.asph, -6.0, 4.3, 0, L);
      rect(COL.grassDark, -10.5, -6.2, 0, L);
      rect("#8c8a82", -21.5, -10.5, 0, L);
      rect(COL.asph, -21.3, -10.7, 0, L);
      if (st.acc) { rect(COL.asph, 4.3, 5.25, 0, st.acc); taper(5.25, st.acc, st.acc + 40, 4.3); }
      if (st.dec) { taper2(4.3, st.dec[0] - 50, st.dec[0], 5.25); rect(COL.asph, 4.3, 5.25, st.dec[0], L);
        // the ramp bends off to the right at the end
        ctx.fillStyle = COL.asph; ctx.beginPath(); ctx.moveTo(1.75, -st.dec[1]); ctx.lineTo(5.25, -st.dec[1]); ctx.lineTo(30, -st.dec[1] - 60); ctx.lineTo(24, -st.dec[1] - 62); ctx.closePath(); ctx.fill(); }
    } else {
      rect(COL.asph, -5.25, 1.75 + (pc.parking ? 2.5 : 0), 0, L);
      if (pc.env === "stad") { rect(COL.curb, 1.75 + (pc.parking ? 2.5 : 0), 1.95 + (pc.parking ? 2.5 : 0), 0, L); rect(COL.curb, -5.45, -5.25, 0, L); }
    }
    ctx.restore();
  }
  function taper(u0, w0, w1, uEnd) { ctx.fillStyle = COL.asph; ctx.beginPath(); ctx.moveTo(4.3, -w0); ctx.lineTo(u0, -w0); ctx.lineTo(uEnd, -w1); ctx.closePath(); ctx.fill(); }
  function taper2(uStart, w0, w1, u1) { ctx.fillStyle = COL.asph; ctx.beginPath(); ctx.moveTo(uStart, -w0); ctx.lineTo(u1, -w1); ctx.lineTo(uStart, -w1); ctx.closePath(); ctx.fill(); }

  function drawRoadMarks(pc) {
    framePiece(pc.P);
    var L = pc.len, st = pc.st, ph = pc.s0;
    if (pc.kind === "mv") {
      ctx.fillStyle = COL.paint;
      ctx.fillRect(1.75 + 0.05, -L, 0.2, L);              // edge line, right
      ctx.fillRect(-5.45, -L, 0.2, L);                     // edge line, left
      dashes(-1.75, 0, L, 3, 9, 0.15, ph);                  // lane line 3+9
      ctx.fillRect(-12.6, -L, 0.2, L); ctx.fillRect(-19.6, -L, 0.2, L);
      dashes(-16.1, 0, L, 3, 9, 0.15, ph);
      ctx.fillStyle = "#c9c9c4"; ctx.fillRect(-8.4, -L, 0.25, L);   // guard rail
      if (st.acc) { ctx.fillStyle = COL.asph; ctx.fillRect(1.6, -st.acc, 0.6, st.acc); dashes(1.75, 0, st.acc, 1, 2, 0.3, ph); }
      if (st.dec) { ctx.fillStyle = COL.asph; ctx.fillRect(1.6, -st.dec[1], 0.6, st.dec[1] - st.dec[0]); dashes(1.75, st.dec[0], st.dec[1], 1, 2, 0.3, ph);
        ctx.fillStyle = COL.paint; ctx.fillRect(5.0, -st.dec[1], 0.2, st.dec[1] - st.dec[0]); }
      ctx.restore(); return;
    }
    var land = pc.env !== "stad";
    // Centre line: mittlinje 3+9 outside built-up areas, 3+3 in them; varningslinje 9+3 before a junction; heldragen where marked.
    var warnFrom = pc.warnEnd ? Math.max(0, L - 45) : L;
    if (pc.center !== "none") {
      if (pc.center === "solid") rect(COL.paint, -1.85, -1.65, 0, L);
      else {
        var segs = [], last = 0;
        pc.solid.slice().sort(function (a, b) { return a[0] - b[0]; }).forEach(function (sg) { if (sg[0] > last) segs.push([last, sg[0]]); rect(COL.paint, -1.85, -1.65, sg[0], Math.min(L, sg[1])); last = sg[1]; });
        if (last < L) segs.push([last, L]);
        segs.forEach(function (sg) {
          var a = sg[0], b = Math.min(sg[1], warnFrom);
          if (b > a) dashes(-1.75, a, b, 3, land ? 9 : 3, 0.12, ph);
          if (sg[1] > warnFrom) dashes(-1.75, Math.max(a, warnFrom), sg[1], 9, 3, 0.12, ph);
        });
      }
    }
    if (land) { dashes(1.6, 0, L, 1, 2, 0.1, ph); dashes(-5.1, 0, L, 1, 2, 0.1, ph); }
    if (st.zebra) {
      var zw = st.zebra.s;
      ctx.fillStyle = COL.paint;
      for (var u = -5.0; u < 1.6; u += 1.0) ctx.fillRect(u, -zw - 1.5, 0.5, 3);
    }
    if (st.bus) {
      var bw = st.bus.s;
      ctx.fillStyle = COL.asph; ctx.fillRect(1.75, -bw - 14, 3.5, 28);
      ctx.beginPath(); ctx.moveTo(1.75, -bw + 14); ctx.lineTo(5.25, -bw + 14); ctx.lineTo(1.75, -bw + 30); ctx.fill();
      ctx.beginPath(); ctx.moveTo(1.75, -bw - 14); ctx.lineTo(5.25, -bw - 14); ctx.lineTo(1.75, -bw - 26); ctx.fill();
      ctx.fillStyle = COL.yellow;
      for (var z = -12; z < 12; z += 2) { ctx.beginPath(); ctx.moveTo(5.0, -bw - z); ctx.lineTo(4.4, -bw - z - 1); ctx.lineTo(5.0, -bw - z - 2); ctx.lineWidth = 0.15; ctx.strokeStyle = COL.yellow; ctx.stroke(); }
      ctx.fillStyle = COL.walk; ctx.fillRect(5.25, -bw - 14, 2.0, 28);
    }
    if (st.works) {
      var ws = st.works.s, wl = st.works.len;
      ctx.fillStyle = "#7b6a55"; ctx.fillRect(-1.3, -ws - wl, 3.0, wl);
      ctx.fillStyle = COL.orange;
      for (var cw = ws; cw <= ws + wl; cw += 4) { ctx.beginPath(); ctx.arc(-1.45, -cw, 0.3, 0, Math.PI * 2); ctx.fill(); }
      for (var k = 0; k < 6; k++) { ctx.fillStyle = k % 2 ? "#111" : COL.yellow; ctx.fillRect(-1.6 + k * 0.55, -ws + 0.2, 0.55, 0.4); }
    }
    (st.props || []).concat(st.camera ? [{ s: st.camera.s, u: 4.6, kind: "camera" }] : []).forEach(function (pr) {
      if (pr.kind === "triangle") {
        ctx.fillStyle = COL.red; ctx.beginPath(); ctx.moveTo(pr.u, -pr.s - 0.45); ctx.lineTo(pr.u + 0.4, -pr.s + 0.25); ctx.lineTo(pr.u - 0.4, -pr.s + 0.25); ctx.closePath(); ctx.fill();
      } else if (pr.kind === "camera") {
        ctx.fillStyle = "#55595e"; ctx.fillRect(pr.u - 0.25, -pr.s - 0.25, 0.5, 0.5);
        ctx.fillStyle = "#c9c9c4"; ctx.fillRect(pr.u - 0.35, -pr.s - 0.6, 0.7, 0.45);
      }
    });
    if (st.park) {
      ctx.fillStyle = COL.paint;
      for (var pz = st.park.zone[0]; pz <= st.park.zone[1]; pz += 6) ctx.fillRect(1.75, -pz - 0.06, 2.5, 0.12);
      ctx.fillStyle = COL.yellow;
      dashes(1.9, st.park.noStop[0], st.park.noStop[1], 1, 1, 0.12, 0, COL.yellow);
    }
    (st.bumps || []).forEach(function (bw) {
      ctx.fillStyle = "#62666c"; ctx.fillRect(-5.25, -bw - 2, 7, 4);
      ctx.fillStyle = COL.paint;
      for (var u = -4.9; u < 1.5; u += 1.6) { ctx.beginPath(); ctx.moveTo(u, -bw + 1.6); ctx.lineTo(u + 0.8, -bw + 1.6); ctx.lineTo(u + 0.4, -bw - 1.6); ctx.closePath(); ctx.fill(); }
    });
    if (st.rail) {
      var rw = st.rail.s;
      ctx.fillStyle = "#8c8274"; ctx.fillRect(-60, -rw - 2.2, 120, 4.4);
      ctx.fillStyle = "#6e523c"; for (var x = -60; x < 60; x += 1.4) ctx.fillRect(x, -rw - 1.7, 0.5, 3.4);
      ctx.fillStyle = COL.asph; ctx.fillRect(-5.25, -rw - 2.2, 7, 4.4);
      ctx.fillStyle = "#2e3034"; ctx.fillRect(-60, -rw - 0.85, 120, 0.2); ctx.fillRect(-60, -rw + 0.65, 120, 0.2);
      ctx.fillStyle = COL.paint; ctx.fillRect(-1.75, -rw + 6.2, 3.5, 0.4);
    }
    ctx.restore();
  }

  function drawJunction(pc, pass) {
    ctx.save(); ctx.translate(pc.C.x, pc.C.y); ctx.rotate(pc.C.a);
    var stad = pc.env === "stad", verge = stad ? COL.walk : COL.grass;
    var arms = [270, 0, 90, 180].filter(function (a) { return a === 270 || pc.arms[a]; });
    if (pass === 0) {
      if (stad) {
        rect(COL.walk, -JH - 2.6, JH + 2.6, -JH - 2.6, JH + 2.6);
        arms.forEach(function (a) { if (a === 270) return; ctx.save(); ctx.rotate((270 - a) * DEG); rect(COL.walk, -HW - 2.6, HW + 2.6, -JH - ARM, -JH); ctx.restore(); });
      }
    } else if (pass === 1) {
      rect(COL.asph, -JH, JH, -JH, JH);
      [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(function (c) { disc(verge, c[0] * JH, -c[1] * JH, RC); });
      arms.forEach(function (a) { if (a === 270) return; ctx.save(); ctx.rotate((270 - a) * DEG); rect(COL.asph, -HW, HW, -JH - ARM, -JH + 0.01); ctx.restore(); });
      if (!pc.arms[90]) rect(verge, -JH, JH, HW, JH + 0.1);
      if (!pc.arms[0]) rect(verge, HW, JH + 0.1, -JH, JH);
      if (!pc.arms[180]) rect(verge, -JH - 0.1, -HW, -JH, JH);
      if (stad && !pc.arms[90]) rect(COL.curb, -JH, JH, HW, HW + 0.2);
    } else {
      arms.forEach(function (a) {
        ctx.save(); ctx.rotate((270 - a) * DEG);
        if (a !== 270) dashes(0, JH, JH + ARM, 3, stad ? 3 : 9, 0.12, 0);
        var line = entryLine(pc, a);
        if (line === "stop") rect(COL.paint, 0, HW, -JH - 0.5, -JH);
        else if (line === "yield") { ctx.fillStyle = COL.paint; for (var u = 0.2; u < HW - 0.4; u += 0.9) { ctx.beginPath(); ctx.moveTo(u, JH + 0.2); ctx.lineTo(u + 0.6, JH + 0.2); ctx.lineTo(u + 0.3, JH + 1.2); ctx.closePath(); ctx.fill(); } }
        ctx.restore();
      });
    }
    ctx.restore();
  }
  function entryLine(pc, a) {
    var c = pc.ctrl;
    if (c === "ljus") return "stop";
    if (c === "stopp") return a === 270 || a === 90 ? "stop" : "";
    if (c === "vaj") return a === 270 || a === 90 ? "yield" : "";
    if (c === "huvud") return a === 0 || a === 180 ? "yield" : "";
    return "";
  }

  function drawRound(pc, pass) {
    ctx.save(); ctx.translate(pc.C.x, pc.C.y); ctx.rotate(pc.C.a);
    var stad = pc.env === "stad";
    var arms = [270, 0, 90, 180];
    if (pass === 0) {
      if (stad) { disc(COL.walk, 0, 0, RB.outer + 2.6); arms.forEach(function (a) { ctx.save(); ctx.rotate((270 - a) * DEG); rect(COL.walk, -HW - 2.6, HW + 2.6, -RB.arm - (a === 270 ? 0 : ARM), -RB.outer + 2); ctx.restore(); }); }
    } else if (pass === 1) {
      disc(COL.asph, 0, 0, RB.outer);
      arms.forEach(function (a) { ctx.save(); ctx.rotate((270 - a) * DEG); rect(COL.asph, -HW, HW, -RB.arm - (a === 270 ? 0 : ARM), -RB.outer + 3); ctx.restore(); });
      disc(COL.curb, 0, 0, RB.island + 0.5); disc(COL.grass, 0, 0, RB.island);
      disc(COL.tree, 1.2, -0.8, 2.8); disc(COL.treeLight, 0.6, -1.4, 1.5);
    } else {
      arms.forEach(function (a) {
        ctx.save(); ctx.rotate((270 - a) * DEG);
        // splitter island and give-way teeth
        ctx.fillStyle = COL.walk; ctx.beginPath(); ctx.moveTo(-0.15, RB.outer + 0.5); ctx.lineTo(0.15, RB.outer + 0.5); ctx.lineTo(0.7, RB.outer + 8); ctx.lineTo(-0.7, RB.outer + 8); ctx.closePath(); ctx.fill();
        dashes(0, RB.outer + 8, RB.arm + (a === 270 ? 0 : ARM), 3, stad ? 3 : 9, 0.12, 0);
        ctx.fillStyle = COL.paint;
        for (var u = 0.9; u < HW - 0.4; u += 0.9) { ctx.beginPath(); ctx.moveTo(u, RB.outer + 0.6); ctx.lineTo(u + 0.6, RB.outer + 0.6); ctx.lineTo(u + 0.3, RB.outer + 1.6); ctx.closePath(); ctx.fill(); }
        ctx.restore();
      });
    }
    ctx.restore();
  }

  // Cars as seen from above, like the situation pictures.
  function drawVehicle(n, pose) {
    ctx.save(); ctx.translate(pose.x, pose.y); ctx.rotate(pose.a);
    var hl = n.hl, hw = n.hw, kind = n.kind;
    ctx.fillStyle = "rgba(0,0,0,0.25)"; rr(-hw + 0.15, -hl + 0.25, hw * 2, hl * 2, 0.5); ctx.fill();
    if (kind === "bike") {
      ctx.fillStyle = "#222"; ctx.fillRect(-0.05, -hl, 0.1, hl * 2);
      ctx.fillStyle = n.color; ctx.beginPath(); ctx.ellipse(0, 0.1, 0.32, 0.22, 0, 0, Math.PI * 2); ctx.fill();
      disc("#f0c419", 0, 0.05, 0.15);
      ctx.restore(); return;
    }
    if (kind === "truck") {
      ctx.fillStyle = COL.white; rr(-hw, -hl, hw * 2, 2.4, 0.4); ctx.fill();
      ctx.fillStyle = COL.glass; ctx.fillRect(-hw + 0.2, -hl + 0.2, hw * 2 - 0.4, 0.6);
      ctx.fillStyle = "#9aa3b4"; rr(-hw, -hl + 2.7, hw * 2, hl * 2 - 2.7, 0.2); ctx.fill();
    } else if (kind === "bus") {
      ctx.fillStyle = n.color; rr(-hw, -hl, hw * 2, hl * 2, 0.5); ctx.fill();
      ctx.fillStyle = COL.glass; ctx.fillRect(-hw + 0.2, -hl + 0.2, hw * 2 - 0.4, 0.8);
      ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(-hw + 0.3, -hl + 1.6, hw * 2 - 0.6, hl * 2 - 2.2);
    } else if (kind === "tractor") {
      ctx.fillStyle = "#222"; ctx.fillRect(-hw - 0.15, 0.2, 0.5, 1.5); ctx.fillRect(hw - 0.35, 0.2, 0.5, 1.5);
      ctx.fillRect(-hw + 0.1, -hl + 0.2, 0.35, 0.9); ctx.fillRect(hw - 0.45, -hl + 0.2, 0.35, 0.9);
      ctx.fillStyle = "#2f8a3a"; rr(-hw + 0.35, -hl, hw * 2 - 0.7, hl * 2, 0.3); ctx.fill();
      ctx.fillStyle = COL.glass; ctx.fillRect(-hw + 0.5, 0, hw * 2 - 1, 1.2);
      if (Math.floor(G.t * 2) % 2) { disc(COL.orange, 0, 0.6, 0.25); }
    } else {
      var body = kind === "amb" ? "#f0e040" : kind === "police" ? "#f2f4f6" : n.color;
      ctx.fillStyle = body; rr(-hw, -hl, hw * 2, hl * 2, 0.6); ctx.fill();
      if (kind === "police") { ctx.fillStyle = "#1d4fa8"; ctx.fillRect(-hw, -0.4, hw * 2, 0.5); ctx.fillStyle = COL.yellow; ctx.fillRect(-hw, 0.1, hw * 2, 0.25); }
      if (kind === "amb") { ctx.fillStyle = "#2e9660"; for (var k = -hl + 0.6; k < hl - 0.4; k += 0.8) ctx.fillRect(((k * 10) % 2 ? -hw : hw - 0.35), k, 0.35, 0.4); }
      ctx.fillStyle = COL.glass;
      ctx.fillRect(-hw + 0.2, -hl * 0.48, hw * 2 - 0.4, 0.75);
      ctx.fillRect(-hw + 0.25, hl * 0.42, hw * 2 - 0.5, 0.55);
      ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.fillRect(-hw + 0.3, -hl * 0.2, hw * 2 - 0.6, hl * 0.6);
      ctx.fillStyle = "#fff6d0"; ctx.fillRect(-hw + 0.15, -hl, 0.4, 0.2); ctx.fillRect(hw - 0.55, -hl, 0.4, 0.2);
      if (kind === "amb" || kind === "police") {
        var on = Math.floor(G.t * 6) % 2;
        disc(on ? "#4aa0ff" : "#1a3a7a", -0.4, -0.3, 0.32); disc(on ? "#1a3a7a" : "#4aa0ff", 0.4, -0.3, 0.32);
        if (on) disc("rgba(74,160,255,0.25)", 0, -0.3, 2.2);
      }
    }
    if (n.blink && Math.floor(G.t * 2.6) % 2) {
      (n.blink === 2 ? [-1, 1] : [n.blink]).forEach(function (sd) {   // 2: hazard lights, both sides
        var x = sd > 0 ? hw - 0.1 : -hw + 0.1;
        disc(COL.orange, x, -hl + 0.25, 0.32); disc(COL.orange, x, hl - 0.25, 0.32);
        disc("rgba(255,166,30,0.3)", x, -hl + 0.25, 0.8);
      });
    }
    ctx.restore();
  }
  function drawWalker(n, pose) {
    ctx.save(); ctx.translate(pose.x, pose.y); ctx.rotate(pose.a);
    if (n.kind === "moose") {
      ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.beginPath(); ctx.ellipse(0.2, 0.3, 0.6, 1.4, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#5b3a22"; ctx.beginPath(); ctx.ellipse(0, 0.2, 0.55, 1.3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#4a2e1a"; ctx.beginPath(); ctx.ellipse(0, -1.45, 0.3, 0.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#c8b48a"; ctx.lineWidth = 0.18; ctx.beginPath(); ctx.moveTo(-0.9, -1.4); ctx.lineTo(0.9, -1.4); ctx.stroke();
    } else if (n.kind === "officer") {
      ctx.fillStyle = "#1d2a4a"; ctx.beginPath(); ctx.ellipse(0, 0, 0.34, 0.22, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#d8f02c"; ctx.fillRect(-0.3, -0.08, 0.6, 0.16);
      disc("#1d2a4a", 0, 0, 0.15);
      ctx.fillStyle = "#e8c39e"; ctx.fillRect(0.28, -0.05, 0.35, 0.1);   // arm raised: stop
    } else {
      var sc = n.kind === "child" ? 0.75 : 1, sw = Math.sin(G.t * 9) * 0.25 * sc;
      ctx.fillStyle = "#333"; ctx.fillRect(-0.22 * sc, sw - 0.1, 0.14 * sc, 0.3); ctx.fillRect(0.08 * sc, -sw - 0.1, 0.14 * sc, 0.3);
      ctx.fillStyle = n.color; ctx.beginPath(); ctx.ellipse(0, 0, 0.32 * sc, 0.2 * sc, 0, 0, Math.PI * 2); ctx.fill();
      disc("#e8c39e", 0, 0, 0.14 * sc);
      if (n.kind === "child") disc("#7a4a24", 0, 0.03, 0.1);
    }
    ctx.restore();
  }
  function drawTrain(n) {
    var tp = n.poly.at(n.t);
    for (var k = 0; k < 4; k++) {
      var x = tp.x - Math.sin(tp.a) * k * 13.5, y = tp.y + Math.cos(tp.a) * k * 13.5;
      ctx.save(); ctx.translate(x, y); ctx.rotate(tp.a);
      ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(-1.45, -6.2, 3.2, 12.6);
      ctx.fillStyle = k === 0 ? "#c0392b" : "#8e959e"; rr(-1.6, -6.4, 3.2, 12.8, 0.6); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.2)"; ctx.fillRect(-1.2, -5.6, 2.4, 11.2);
      if (k === 0) { ctx.fillStyle = COL.glass; ctx.fillRect(-1.3, -6.1, 2.6, 0.9); }
      ctx.restore();
    }
  }

  function w2s(x, y) {
    var c = G.cam, dx = x - c.x, dy = y - c.y, ca = Math.cos(-c.a), sa = Math.sin(-c.a);
    return { x: W / 2 + (dx * ca - dy * sa) * c.sc, y: H * 0.66 + (dx * sa + dy * ca) * c.sc };
  }
  function drawSpeedSign(x, y, r, n) {
    disc("#fff", x, y, r + 1); disc(COL.red, x, y, r); disc(COL.yellow, x, y, r * 0.72);
    ctx.fillStyle = "#111"; ctx.font = "800 " + Math.round(r * (n >= 100 ? 0.78 : 0.95)) + "px system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(n), x, y + 1);
  }
  function drawSigns() {
    var size = clamp(G.cam.sc * 2.6, 24, 40);
    G.course.signs.forEach(function (sg) {
      if (Math.abs(sg.s - G.p.s) > 260) return;
      var pose = G.course.poseAt(sg.s), q = sg.pos || toG(pose, sg.u, 0), sp = w2s(q.x, q.y);
      if (sp.x < -50 || sp.x > W + 50 || sp.y < -60 || sp.y > H + 60) return;
      ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.beginPath(); ctx.arc(sp.x, sp.y, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#666"; ctx.fillRect(sp.x - 1.5, sp.y - size * 0.75, 3, size * 0.75);
      var cy = sp.y - size * 0.75 - size / 2;
      if (sg.speed) drawSpeedSign(sp.x, cy, size / 2, sg.speed);
      else if (sg.img && sg.img.complete && sg.img.naturalWidth) ctx.drawImage(sg.img, sp.x - size / 2, cy - size / 2, size, size);
    });
  }
  function drawLights() {
    var c = G.course;
    c.pieces.forEach(function (pc) {
      if (!pc.light || Math.abs(pc.s0 - G.p.s) > 250) return;
      [270, 0, 90, 180].forEach(function (arm) {
        var q = { x: HW + 1.2, y: -JH - 1 }, r = rot(q, arm - 270), g = toG(pc.C, r.x, r.y), sp = w2s(g.x, g.y);
        var ph = lightFor(pc, arm), big = arm === 270, s = big ? 1.25 : 0.8;
        var w = 14 * s, h = 36 * s, x = sp.x - w / 2, y = sp.y - h - 4;
        ctx.fillStyle = "#666"; ctx.fillRect(sp.x - 1.5, sp.y - 6, 3, 6);
        ctx.fillStyle = "#15181c"; rr(x, y, w, h, 4 * s); ctx.fill();
        var lamps = [["#ff3b30", ph === "red" || ph === "redyellow"], ["#ffcc00", ph === "yellow" || ph === "redyellow"], ["#34c759", ph === "green"]];
        lamps.forEach(function (l, i) {
          ctx.fillStyle = l[1] ? l[0] : "#333a40"; ctx.beginPath(); ctx.arc(sp.x, y + 6 * s + i * 11 * s, 4.2 * s, 0, Math.PI * 2); ctx.fill();
        });
      });
    });
    c.feats.forEach(function (f) {
      if (f.kind !== "rail" || Math.abs(f.s - G.p.s) > 250) return;
      var pose = c.poseAt(f.s);
      [[3.0, -5], [-8.0, 5]].forEach(function (o, side) {
        var g = toG(pose, o[0], o[1]), sp = w2s(g.x, g.y);
        var blink = f.state !== "open" && Math.floor(G.t * 3) % 2;
        ctx.fillStyle = "#666"; ctx.fillRect(sp.x - 1.5, sp.y - 10, 3, 10);
        ctx.fillStyle = "#15181c"; rr(sp.x - 16, sp.y - 26, 32, 16, 6); ctx.fill();
        ctx.fillStyle = blink ? "#ff3b30" : "#40262a"; ctx.beginPath(); ctx.arc(sp.x - 8, sp.y - 18, 5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = !blink && f.state !== "open" ? "#ff3b30" : "#40262a"; ctx.beginPath(); ctx.arc(sp.x + 8, sp.y - 18, 5, 0, Math.PI * 2); ctx.fill();
      });
    });
  }
  function barrierDown(f) {
    return f.state === "down" ? 1 : f.state === "warn" ? clamp((f.t - 1.5) / 1.5, 0, 1) : f.state === "up" ? 1 - clamp(f.t / 2, 0, 1) : 0;
  }
  function drawBarriers() {
    G.course.feats.forEach(function (f) {
      if (f.kind !== "rail" || Math.abs(f.s - G.p.s) > 250) return;
      var down = barrierDown(f);
      var pose = G.course.poseAt(f.s);
      [[2.6, -5, 1], [-6.1, 5, -1]].forEach(function (b) {
        var base = toG(pose, b[0], b[1]);
        ctx.save(); ctx.translate(base.x, base.y); ctx.rotate(pose.a);
        ctx.rotate(-(1 - down) * 80 * DEG);
        var len = 4.0;
        for (var i = 0; i < 5; i++) { ctx.fillStyle = i % 2 ? COL.red : COL.white; ctx.fillRect(-b[2] * (i * len / 5) - (b[2] > 0 ? len / 5 : 0), -0.12, len / 5, 0.24); }
        ctx.restore();
        disc("#333", base.x, base.y, 0.35);
      });
    });
  }

  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    var pc = curPiece();
    ctx.fillStyle = COL.grass; ctx.fillRect(0, 0, W, H);
    var c = G.cam;
    ctx.save();
    ctx.translate(W / 2, H * 0.66); ctx.rotate(-c.a); ctx.scale(c.sc, c.sc); ctx.translate(-c.x, -c.y);
    var reach = Math.hypot(W, H) / c.sc;
    speckles(ctx, c.x - reach, c.y - reach, reach * 2, reach * 2);
    drawPieces();
    drawBarriers();
    G.npcs.forEach(function (n) {
      if (n.mode === "walk") drawWalker(n, npcPose(n));
      else if (n.mode === "train") drawTrain(n);
      else drawVehicle(n, npcPose(n));
    });
    drawVehicle({ kind: "car", hl: CAR.hl, hw: CAR.hw, color: COL.red, blink: G.p.blink }, { x: G.p.x, y: G.p.y, a: G.p.a });
    ctx.restore();
    drawSigns();
    drawLights();
    drawHud(pc);
  }
  function drawPieces() {
    var vis = G.course.pieces.filter(function (q) { return q.s0 - G.p.s < 320 && G.p.s - (q.s0 + (q.len || 0)) < 140; });
    // The road also runs on behind where the lesson starts, so the mirrors show a road.
    var first = G.course.pieces[0];
    if (first && (first.kind === "road" || first.kind === "mv") && G.p.s < 140) {
      var lead = Object.create(first);
      lead.P = toG(first.P, 0, -150); lead.P.a = first.P.a; lead.len = 150; lead.s0 = first.s0 - 150;
      lead.st = first.kind === "mv" ? { acc: 150 } : {}; lead.parking = false; lead.solid = []; lead.warnEnd = false;
      lead.decor = first.decor.filter(function (d) { return d.w + (d.len || 0) < 130; });
      vis.unshift(lead);
    }
    for (var pass = 0; pass < 3; pass++) {
      vis.forEach(function (q) {
        if (q.kind === "road" || q.kind === "mv") { if (pass === 0) drawRoadGround(q); else if (pass === 1) drawRoadAsphalt(q); else drawRoadMarks(q); }
        else if (q.kind === "junction") drawJunction(q, pass);
        else drawRound(q, pass);
      });
    }
  }
  // The ground seen from above, painted into another canvas: the 3D view lays it on the ground.
  function paintGround(c2, cx, cy, sc, size) {
    var saved = ctx; ctx = c2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COL.grass; ctx.fillRect(0, 0, size, size);
    ctx.save(); ctx.translate(size / 2, size / 2); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
    speckles(ctx, cx - size / sc / 2, cy - size / sc / 2, size / sc, size / sc);
    drawPieces();
    ctx.restore();
    ctx = saved;
  }
  function drawHud(pc) {
    pc = pc || curPiece();
    var kmh = Math.round(G.p.v * KMH);
    hud.speed.textContent = kmh;
    var lim = G.limit || pc.limit;
    hud.speed.className = kmh > lim + 3 ? "over" : "";
    hud.limit.textContent = lim;
    var on = Math.floor(G.t * 2.6) % 2 === 0;
    hud.l.className = "blink" + (G.p.blink < 0 && on ? " on" : "");
    hud.r.className = "blink" + (G.p.blink > 0 && on ? " on" : "");
    var bl = G.manual ? hud.kl : hud.bl, br = G.manual ? hud.kr : hud.br;
    hud.bl.classList.toggle("on", !G.manual && G.p.blink < 0); hud.br.classList.toggle("on", !G.manual && G.p.blink > 0);
    bl.classList.toggle("on", G.p.blink < 0); br.classList.toggle("on", G.p.blink > 0);
    if (G.p.blink && on !== G.lastOn) tick();
    G.lastOn = on;
  }
  var hud = { speed: document.getElementById("speed"), limit: document.getElementById("limit"), l: document.getElementById("hudL"), r: document.getElementById("hudR"),
    bl: document.getElementById("bl"), br: document.getElementById("br"), kl: document.getElementById("kl"), kr: document.getElementById("kr") };

  function updateCam(dt) {
    var c = G.cam, p = G.p;
    var base = clamp(Math.min(W, H * 0.8) / 24, 8, 20);
    var want = base / (1 + p.v / 20);
    c.sc += (want - c.sc) * Math.min(1, dt * 1.5);
    var k = Math.min(1, dt * 6);
    c.x += (p.x - c.x) * k; c.y += (p.y - c.y) * k;
    c.a += angDiff(G.manual ? p.a : G.course.poseAt(p.s).a, c.a) * Math.min(1, dt * 3);
  }

  var lastFrame = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    if (!G || G.paused || document.getElementById("game").hidden) { lastFrame = now; return; }
    var dt = Math.min(0.05, (now - lastFrame) / 1000); lastFrame = now;
    if (!G.over) {
      var n = Math.ceil(dt / 0.017);
      for (var i = 0; i < n; i++) if (!G.crashed) update(dt / n); else { G.t += dt / n; updateSay(dt / n); }
      if (G.finishT > 0 && G.t > G.finishT + 1.2) finish();
    }
    updateCam(dt);
    var use3d = store.view3d && window.SPEL3D && window.SPEL3D.ready();
    cv.style.display = use3d ? "none" : "";
    document.getElementById("hud").style.display = use3d ? "none" : "";
    if (use3d) { window.SPEL3D.render(G, dt); drawHud(); }
    else { if (window.SPEL3D) window.SPEL3D.hide(); draw(); }
    viewBtn.textContent = use3d ? "2D" : "3D";
  }
  var viewBtn = document.getElementById("view");
  viewBtn.addEventListener("click", function () { store.view3d = !store.view3d; saveStore(); });

  // ---------- screens ----------
  function show(id) {
    ["menu", "game", "paused", "result"].forEach(function (s) { document.getElementById(s).hidden = s !== id && !(id === "paused" && s === "game") && !(id === "result" && s === "game"); });
    if (id === "game") resize();
  }
  function pause() { if (!G || G.over) return; G.paused = true; keys.gas = keys.brake = keys.left = keys.right = false; if (window.speechSynthesis) speechSynthesis.cancel(); siren(0); show("paused"); }
  function finish() {
    G.over = true; siren(0);
    if (sirenGain) sirenGain.gain.value = 0;
    var serious = G.faults.filter(function (f) { return f.serious; }).length, minor = G.faults.length - serious;
    var ok = serious === 0 && minor <= 2;
    var prev = store.best[G.lesson.id];
    if (ok || !prev) { store.best[G.lesson.id] = ok ? "ok" : "no"; saveStore(); }
    var v = document.getElementById("verdict");
    v.textContent = ok ? "Godkänd!" : "Inte godkänd än";
    v.className = "verdict " + (ok ? "ok" : "no");
    document.getElementById("summary").textContent = G.faults.length === 0 ? "Inga fel alls. Läraren är nöjd!" :
      (serious ? serious + (serious === 1 ? " allvarligt fel" : " allvarliga fel") : "Inga allvarliga fel") + (minor ? ", " + minor + (minor === 1 ? " mindre anmärkning" : " mindre anmärkningar") : "") + ".";
    var list = document.getElementById("faultList"); list.innerHTML = "";
    G.faults.forEach(function (f) {
      var d = document.createElement("div"); d.className = "fault" + (f.serious ? " serious" : "");
      var b = document.createElement("b"); b.textContent = f.title; d.appendChild(b);
      var s = document.createElement("span"); s.textContent = f.info; d.appendChild(s);
      list.appendChild(d);
    });
    document.getElementById("next").hidden = !(ok && G.idx < LESSONS.length - 1);
    setTimeout(function () { show("result"); }, 300);
  }
  function buildMenu() {
    var box = document.getElementById("lessons"); box.innerHTML = "";
    LESSONS.forEach(function (L, i) {
      var b = document.createElement("button"); b.type = "button"; b.className = "lesson";
      var best = store.best[L.id];
      b.innerHTML = '<span class="num">' + (L.icon || i + 1) + '</span><span class="txt"><span class="name"></span><br><span class="what"></span></span>' +
        (best ? '<span class="mark ' + best + '">' + (best === "ok" ? "Godkänd" : "Övning kvar") + "</span>" : "");
      b.querySelector(".name").textContent = L.name; b.querySelector(".what").textContent = L.what;
      b.addEventListener("click", function () { startLesson(i); });
      box.appendChild(b);
    });
    var v = document.getElementById("optVoice"), s = document.getElementById("optSound");
    v.checked = !!store.voice; s.checked = !!store.sound;
    document.getElementById("opt3d").checked = !!store.view3d;
    document.getElementById("optFacts").checked = store.facts !== false;
    document.getElementById("optTraffic").value = String(store.traffic || 0);
    document.getElementById("optSteer").value = store.steer === "auto" ? "auto" : "manual";
    document.getElementById("optWalkers").value = String(store.walkers || 0);
    document.getElementById("pad").hidden = false;
  }
  document.getElementById("optVoice").addEventListener("change", function (e) { store.voice = e.target.checked; saveStore(); if (store.voice) speak("Hej! Jag är din lärare."); });
  document.getElementById("optSteer").addEventListener("change", function (e) { store.steer = e.target.value; saveStore(); });
  document.getElementById("optTraffic").addEventListener("change", function (e) { store.traffic = +e.target.value; saveStore(); });
  document.getElementById("optWalkers").addEventListener("change", function (e) { store.walkers = +e.target.value; saveStore(); });
  document.getElementById("optFacts").addEventListener("change", function (e) { store.facts = e.target.checked; saveStore(); });
  document.getElementById("opt3d").addEventListener("change", function (e) { store.view3d = e.target.checked; saveStore(); });
  document.getElementById("optSound").addEventListener("change", function (e) { store.sound = e.target.checked; saveStore(); ensureAudio(); });
  document.getElementById("pause").addEventListener("click", pause);
  document.getElementById("resume").addEventListener("click", function () { G.paused = false; show("game"); });
  document.getElementById("restart").addEventListener("click", function () { startLesson(G.idx); });
  document.getElementById("quit").addEventListener("click", function () { G = null; buildMenu(); show("menu"); });
  document.getElementById("again").addEventListener("click", function () { startLesson(G.idx); });
  document.getElementById("next").addEventListener("click", function () { startLesson(G.idx + 1); });
  document.getElementById("toMenu").addEventListener("click", function () { G = null; buildMenu(); show("menu"); });
  // Touch buttons only where there is touch.
  if (!touchUI) document.getElementById("pad").style.display = "none";

  // ---------- the lessons ----------
  // Distances in metres along each piece. Signs stand on the right; "speed" draws a speed limit sign.
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function makeFree() {
    var steps = [], env = "stad", turn = 0;
    var dirWord = { "0": "köra rakt fram", "1": "svänga höger", "-1": "svänga vänster" };
    var hint = {
      hoger: "Inga skyltar, så högerregeln gäller.",
      stopp: "Det är stopplikt, så stanna helt vid linjen.",
      vaj: "Vi har väjningsplikt där.",
      huvud: "Vi kör på huvudled, de från sidan har väjningsplikt.",
      ljus: "Det är trafikljus, och svänger vi vänster har mötande företräde."
    };
    steps.push({ type: "road", env: "stad", limit: 50, len: 110, signs: [{ s: 8, speed: 50 }],
      say: [[0, "Fri körning! Jag säger vart vi ska, så följer du trafikreglerna. Lycka till."]] });
    var n = 4 + Math.floor(Math.random() * 3);
    for (var i = 0; i < n; i++) {
      // A road with something on it, then a junction or a roundabout.
      if (i === 2 && Math.random() < 0.7) {
        env = env === "stad" ? "land" : "stad";
        steps.push(env === "land"
          ? { type: "road", env: "land", limit: 70, len: 260, signs: [{ s: 4, code: "E6" }, { s: 10, speed: 70 }], oncoming: [30, 150],
              moose: Math.random() < 0.5 ? { s: 200 } : null, lanes: [0, -3.5],
              ahead: Math.random() < 0.5 ? [{ s: 90, v: 25, kind: "tractor", ttl: 240 }] : [],
              say: [[12, "Nu lämnar vi tätorten. Här gäller 70."]] }
          : { type: "road", env: "stad", limit: 50, len: 160, signs: [{ s: 4, code: "E5" }, { s: 8, speed: 50 }],
              say: [[10, "Vi kommer in i en tätort igen. 50 gäller."]] });
      }
      var road = { type: "road", len: 140 + Math.floor(Math.random() * 60), say: [] };
      var extra = Math.random();
      if (env === "stad") {
        if (extra < 0.25) { road.zebra = { s: 50, peds: [{ side: pick(["right", "left"]) }] }; road.signs = [{ s: 48, code: "B3" }]; }
        else if (extra < 0.45) { road.ahead = [{ s: 45, v: 17, kind: "bike", ttl: road.len - 12 }]; road.say.push([6, "Cyklist framför. Kör om först när det är fritt, och håll avstånd i sidled."]); }
        else if (extra < 0.6) { road.bus = { s: 70 }; road.signs = [{ s: 60, code: "E22" }]; }
        else if (extra < 0.72) { road.bumps = [60]; road.signs = [{ s: 30, code: "A9" }]; road.say.push([20, "Farthinder framåt, sakta in."]); }
        else if (extra < 0.82) { road.camera = { s: 90 }; road.signs = [{ s: 20, code: "E24" }]; }
        else if (extra < 0.9) { road.jaywalk = { s: 70 }; }
      } else if (extra < 0.3) { road.ahead = [{ s: 70, v: 60, brakeAt: 110 }]; road.say.push([8, "Håll avstånd till bilen framför."]); }
      else if (extra < 0.5) { road.len = 220; road.police = { s: 150 }; road.say.push([70, "Polisen ger stopptecken där framme. Stanna vid polisen."]); }
      else if (extra < 0.65) { road.len = 240; road.lanes = [0, -3.5]; road.accident = { s: 150, len: 22 }; road.props = [{ s: 100, u: 1.0, kind: "triangle" }]; road.oncoming = [20];
        road.say.push([60, "Varningstriangel! En olycka framför. Sakta in och låt mötande passera först."]); }
      else if (extra < 0.75) { road.camera = { s: 100 }; road.signs = [{ s: 20, code: "E24" }]; }
      var round = Math.random() < 0.3;
      var want;
      if (round) {
        want = pick([1, 2, 3]);
        road.say.push([road.len - 95, "I cirkulationsplatsen tar vi avfart nummer " + want + ". Blinka höger efter avfarten före."]);
        steps.push(road);
        steps.push({ type: "round", want: want, good: "Bra i cirkulationsplatsen!", npcs: Math.random() < 0.7 ? [{ from: "left", to: "right" }] : [] });
        turn += want === 1 ? 1 : want === 3 ? -1 : 0;
      } else {
        var ctrl = pick(env === "stad" ? ["hoger", "stopp", "vaj", "ljus", "huvud"] : ["vaj", "stopp", "huvud"]);
        var opts = [0, 1, -1].filter(function (d) { return !(turn >= 1 && d === 1) && !(turn <= -1 && d === -1); });
        want = pick(opts);
        var tee = (ctrl === "stopp" || ctrl === "vaj") && want !== 0 && Math.random() < 0.5;
        if (ctrl === "huvud") road.signs = (road.signs || []).concat([{ s: 15, code: "B4" }]);
        road.say.push([road.len - 90, "I nästa korsning ska vi " + dirWord[want] + ". " + hint[ctrl]]);
        steps.push(road);
        var npcs = ctrl === "hoger" ? [{ from: "right", to: "straight" }] :
          ctrl === "huvud" ? [{ from: "right", to: "straight", prio: false }] :
          ctrl === "ljus" ? [] : [{ from: "left", to: "straight", eta: 1.2 }, { from: "right", to: "straight", eta: 1.6 }];
        steps.push({ type: "junction", ctrl: ctrl, want: want, fwd: !tee, good: pick(["Bra!", "Snyggt.", "Fint kört."]), npcs: npcs });
        turn += want;
      }
    }
    steps.push({ type: "road", len: 130, finish: true, say: [[10, "Bra kört! Stanna här vid kanten, så är vi klara."]] });
    return steps;
  }

  var LESSONS = [
    { id: "stad", icon: "🏙️", name: "Stadskörning", what: "Högerregeln, övergångsställe, stopplikt och trafikljus",
      steps: [
        { type: "road", env: "stad", limit: 50, len: 120, signs: [{ s: 8, speed: 50 }],
          say: [[0, "Hej! Pil upp gasar och pil ned bromsar. På mobilen har du knappar. Här i tätorten gäller 50 km/h."],
                [50, "Korsningen framför har inga skyltar. Då gäller högerregeln: släpp fram den som kommer från höger. Vi ska rakt fram."]] },
        { type: "junction", ctrl: "hoger", want: 0, good: "Snyggt, du släppte fram bilen från höger.",
          npcs: [{ from: "right", to: "straight" }, { from: "left", to: "straight", prio: false }] },
        { type: "road", len: 160, zebra: { s: 70, peds: [{ side: "right" }] }, signs: [{ s: 68, code: "B3" }],
          say: [[8, "Där framme är ett övergångsställe. Gående som är på väg ut har företräde, så var beredd att stanna."],
                [100, "Vid stoppskylten svänger vi höger. Blinka höger i god tid och stanna helt vid stopplinjen."]] },
        { type: "junction", ctrl: "stopp", fwd: false, want: 1, good: "Bra stopp, och bra att du väntade in bilen.",
          npcs: [{ from: "left", to: "straight", eta: 1.6 }, { from: "right", to: "straight", eta: 0.7 }] },
        { type: "road", len: 160,
          say: [[10, "Fint. I korsningen med trafikljus ska vi svänga vänster. Blinka vänster. Mötande som kör rakt fram har företräde."]] },
        { type: "junction", ctrl: "ljus", want: -1, good: "Bra vänstersväng!" },
        { type: "road", len: 130, finish: true, say: [[10, "Bra kört! Stanna här vid kanten."]] }
      ] },
    { id: "land", icon: "🌲", name: "Landsväg", what: "Hastighet, avstånd, älg, omkörning och väjningsplikt",
      steps: [
        { type: "road", env: "stad", limit: 50, len: 100, signs: [{ s: 8, speed: 50 }, { s: 92, code: "E6" }],
          say: [[0, "Nu kör vi ut på landsvägen. Håll 50 tills vi lämnar tätorten."]] },
        { type: "road", env: "land", limit: 80, len: 320, signs: [{ s: 6, speed: 80 }], ahead: [{ s: 150, v: 78, ttl: 320 }], oncoming: [20, 170],
          say: [[8, "Här gäller 80. Ligger du bakom någon, håll minst tre sekunders avstånd."]] },
        { type: "road", len: 300, signs: [{ s: 20, code: "A19" }], moose: { s: 220 }, oncoming: [60],
          say: [[22, "Varning för djur. En älg kan springa ut, så var redo att bromsa."]] },
        { type: "road", len: 340, lanes: [0, -3.5], solid: [[270, 340]], ahead: [{ s: 70, v: 25, kind: "tractor", ttl: 330 }], oncoming: [10, 120],
          say: [[5, "Traktorn kör sakta. Kör om när det är fritt framåt: blinka vänster, kör förbi och blinka höger tillbaka. Aldrig över heldragen linje."]] },
        { type: "road", len: 170, limit: 70, signs: [{ s: 6, speed: 70 }],
          say: [[10, "Snart svänger vi vänster ut på en större väg. Vi har väjningsplikt: skylten och hajtänderna visar det."]] },
        { type: "junction", ctrl: "vaj", fwd: false, want: -1, good: "Bra, du väntade ut en lucka.",
          npcs: [{ from: "left", to: "straight" }, { from: "right", to: "straight", eta: 1.5 }] },
        { type: "road", len: 180, limit: 80, finish: true, signs: [{ s: 20, speed: 80 }], say: [[15, "Bra körning på landsvägen! Sakta in och stanna här framme."]] }
      ] },
    { id: "rondell", icon: "🔄", name: "Cirkulationsplatser", what: "Väjningsplikt vid infart, välja avfart och blinka ut",
      steps: [
        { type: "road", env: "stad", limit: 50, len: 140, signs: [{ s: 8, speed: 50 }],
          say: [[2, "Nu övar vi cirkulationsplatser. Bilar som redan kör runt har företräde, för du har väjningsplikt när du kör in."],
                [70, "Vi ska rakt fram, det är andra avfarten. Blinka höger när du har passerat första avfarten."]] },
        { type: "round", want: 2, good: "Snyggt! Rätt avfart och du blinkade ut.", npcs: [{ from: "left", to: "right" }] },
        { type: "road", len: 160, say: [[10, "I nästa cirkulationsplats ska vi vänster. Det är tredje avfarten."]] },
        { type: "round", want: 3, good: "Bra! Tredje avfarten.", npcs: [{ from: "left", to: "right", eta: 1.3 }, { from: "fwd", to: "back", eta: 0.8 }] },
        { type: "road", len: 140, finish: true, say: [[10, "Bra jobbat! Stanna här vid kanten."]] }
      ] },
    { id: "motorvag", icon: "🛣️", name: "Motorväg", what: "Påfart, omkörning, kö och avfart", start: { s: 8, v: 50, d: 3.5 },
      steps: [
        { type: "mv", env: "mv", limit: 110, len: 330, acc: 230, signs: [{ s: 4, code: "E1" }, { s: 140, speed: 110 }],
          ahead: [{ s: -60, v: 92 }, { s: 20, v: 92 }, { s: 95, v: 92 }, { s: 175, v: 92 }, { s: 255, v: 92 }],
          say: [[0, "Vi kör ut på motorvägen. Gasa i accelerationsfältet upp till trafikens fart, blinka vänster och glid in i en lucka."]] },
        { type: "mv", len: 650, ahead: [{ s: 260, v: 80, kind: "truck" }], behind: [{ at: 120, d: -3.5, v: 125 }, { at: 380, d: -3.5, v: 125 }],
          say: [[10, "Håll dig i högra körfältet. Lastbilen framför kör långsamt. Kör om i vänster körfält och blinka höger tillbaka när du är förbi."]] },
        { type: "mv", len: 560, signs: [{ s: 60, code: "A34" }],
          ahead: [{ s: 230, v: 100, queue: [330, 200] }, { s: 300, v: 100, queue: [330, 200] }, { s: 360, v: 100, queue: [330, 200] }, { s: 320, d: -3.5, v: 105, queue: [330, 200] }],
          say: [[62, "Varning för kö! Släpp gasen och bromsa i god tid."]] },
        { type: "mv", len: 420, dec: [220, 410],
          say: [[20, "Vi tar nästa avfart. Byt till högra körfältet, och blinka höger in i avfartens körfält. Sakta in först där."]] }
      ] },
    { id: "special", icon: "🚂", name: "Järnväg, utryckning och skola", what: "Bommar, ambulans, huvudled, barn och buss",
      steps: [
        { type: "road", env: "land", limit: 70, len: 270, signs: [{ s: 6, speed: 70 }, { s: 25, code: "A35" }, { s: 228, code: "A39" }], rail: { s: 240 },
          say: [[6, "Här gäller 70. Det kommer en järnvägskorsning med bommar. Blinkar de röda ljusen ska du stanna före bommen."]] },
        { type: "road", len: 320, behind: [{ at: 30, kind: "amb", v: 105, back: 160 }], oncoming: [200] },
        { type: "road", len: 160, signs: [{ s: 10, code: "B4" }],
          say: [[12, "Nu kör vi på huvudled, skylten visar det. Bilen från höger har väjningsplikt, men håll ändå ett öga på den. Vi kör rakt fram."]] },
        { type: "junction", ctrl: "huvud", want: 0, good: "Bra, rakt fram på huvudleden.", npcs: [{ from: "right", to: "straight", prio: false }] },
        { type: "road", env: "stad", limit: 30, len: 230, parking: true, parked: [70, 82, 94, 130, 142, 168],
          signs: [{ s: 4, code: "E5" }, { s: 8, speed: 30 }, { s: 40, code: "A15" }], child: { s: 150 },
          bumps: [210],
          say: [[6, "Vi kommer in i tätorten. Här ligger en skola, så det är 30. Var beredd på barn mellan bilarna."]] },
        { type: "road", limit: 40, len: 220, signs: [{ s: 6, speed: 40 }, { s: 100, code: "E22" }], bus: { s: 110 },
          say: [[8, "Bussen vid hållplatsen kommer att blinka för att köra ut. Här är det högst 50, så då ska du släppa ut den."]] },
        { type: "road", len: 120, finish: true, say: [[10, "Stanna här vid kanten. Bra jobbat!"]] }
      ] },
    { id: "vinter", icon: "❄️", name: "Vinterkörning", what: "Snö, halka, längre bromssträcka och cyklist", weather: "snow",
      steps: [
        { type: "road", env: "stad", limit: 50, len: 160, signs: [{ s: 8, speed: 50 }], ahead: [{ s: 70, v: 16, kind: "bike", color: "#2e86ab", ttl: 150 }],
          say: [[0, "Det har snöat och vägen är hal. Bromssträckan blir mycket längre, så kör mjukt och håll avstånd."],
                [30, "Cyklist framför. Kör om först när det är fritt, med ordentligt avstånd i sidled. Blinka vänster för att gå ut."]] },
        { type: "road", len: 140, zebra: { s: 80, peds: [{ side: "left" }, { side: "right", dist: 40 }] }, signs: [{ s: 78, code: "B3" }],
          say: [[10, "Övergångsställe. På halt väglag måste du börja bromsa mycket tidigare."]] },
        { type: "road", env: "land", limit: 70, len: 330, signs: [{ s: 4, code: "E6" }, { s: 10, speed: 70 }, { s: 60, code: "A10" }],
          ahead: [{ s: 120, v: 60, brakeAt: 230 }], oncoming: [40, 200],
          say: [[12, "Här gäller 70, men på snö är det klokt att köra saktare. Varning för slirig väg."],
                [80, "Bilen framför kan bromsa plötsligt. Håll minst sex sekunders avstånd på halt väglag."]] },
        { type: "road", len: 160, signs: [{ s: 20, code: "A30" }],
          say: [[10, "Cirkulationsplats. Vi ska rakt fram, andra avfarten. Sakta in i god tid."]] },
        { type: "round", want: 2, good: "Bra, mjukt och lugnt.", npcs: [{ from: "left", to: "right" }] },
        { type: "road", len: 150, finish: true, say: [[10, "Bra vinterkörning! Bromsa försiktigt och stanna här."]] }
      ] },
    { id: "skyltar", icon: "🪧", name: "Skyltar i stan", what: "Påbjuden körriktning, infart förbjuden, huvudled upphör, gångfart och parkering",
      steps: [
        { type: "road", env: "stad", limit: 50, len: 150, signs: [{ s: 8, speed: 50 }, { s: 120, code: "D1" }],
          say: [[0, "Nu övar vi vägmärken. Titta efter skyltarna och följ dem."],
                [70, "Vad visar den blå skylten med pilen? Följ den i korsningen."]] },
        { type: "junction", ctrl: "hoger", want: -1, mustGo: -1, routeMsg: "Skylten visade att du måste svänga vänster.", good: "Rätt! Den blå runda skylten är ett påbud: du måste köra dit pilen visar.",
          npcs: [{ from: "right", to: "straight", eta: 1.5 }] },
        { type: "road", len: 160, signs: [{ s: 10, speed: 40 }],
          say: [[10, "Nu ska vi till höger i korsningen. Men kolla vad som står vid gatan till höger."]] },
        { type: "junction", ctrl: "hoger", want: 0, noEntry: ["right"], armSigns: [{ arm: "right", code: "C1" }],
          routeMsg: "Vi fick inte köra in till höger, så rakt fram var rätt.", good: "Bra! Där var det infart förbjuden, så vi fortsatte rakt fram.",
          npcs: [{ from: "left", to: "straight", prio: false }] },
        { type: "road", len: 170, signs: [{ s: 10, code: "B4" }, { s: 120, code: "B5" }],
          say: [[12, "Nu kör vi på huvudled."], [118, "Huvudleden upphör här. Vad gäller då i nästa korsning utan skyltar?"],
                [150, "Efter korsningen börjar ett gångfartsområde, så sakta in."]] },
        { type: "junction", ctrl: "hoger", want: 0, good: "Rätt, högerregeln! Huvudleden hade upphört.", npcs: [{ from: "right", to: "straight" }] },
        { type: "road", len: 200, limit: 7, signs: [{ s: 6, code: "E9" }, { s: 192, code: "E10" }], street: 5,
          say: [[4, "Gångfartsområde! Här kör du i gångfart, ungefär 7 km/h, och gående har företräde."]] },
        { type: "road", len: 220, limit: 50, parking: true, signs: [{ s: 6, speed: 50 }, { s: 60, code: "C39" }, { s: 140, code: "E19" }],
          park: { noStop: [60, 130], zone: [140, 205] },
          say: [[10, "Nu ska du parkera till höger. Stanna inte där det är förbud, utan där skylten P står."]] }
      ] },
    { id: "vagarbete", icon: "🚧", name: "Vägarbete och omkörningsförbud", what: "Omkörningsförbud, vägarbete, väjningsplikt mot mötande och tillfälliga hastigheter",
      steps: [
        { type: "road", env: "land", limit: 80, len: 330, signs: [{ s: 6, speed: 80 }, { s: 30, code: "C27" }, { s: 230, code: "C28" }],
          lanes: [0, -3.5], noOvertake: [30, 230], ahead: [{ s: 90, v: 30, kind: "tractor", ttl: 320 }], oncoming: [120],
          say: [[8, "Omkörningsförbud börjar vid skylten med de två bilarna. Kör inte om traktorn förrän förbudet slutar."],
                [232, "Nu är förbudet slut. Kör om om det är fritt, annars stannar vi bakom."]] },
        { type: "road", len: 330, lanes: [0, -3.5], signs: [{ s: 10, code: "A20" }, { s: 40, speed: 50 }, { s: 96, code: "B6" }, { s: 100, code: "A5" }, { s: 250, code: "A21" }, { s: 256, speed: 70 }],
          works: { s: 110, len: 60 }, oncoming: [30],
          say: [[10, "Varning för vägarbete. Tillfälligt 50 km/h."],
                [80, "Vägarbetet stänger vårt körfält. Skylten med den röda pilen betyder att vi har väjningsplikt mot mötande. Vänta, kör sedan förbi på vänster sida och tillbaka."]] },
        { type: "road", len: 150, limit: 70, finish: true, say: [[10, "Bra kört genom vägarbetet! Stanna här vid kanten."]] }
      ] },
    { id: "polis", icon: "👮", name: "Polis och oväntade händelser", what: "Fartkamera, poliskontroll, olycka, bil på vägrenen och fotgängare utan övergångsställe",
      steps: [
        { type: "road", env: "stad", limit: 50, len: 230, signs: [{ s: 8, speed: 50 }, { s: 40, code: "E24" }], camera: { s: 160 }, jaywalk: { s: 100 },
          say: [[0, "Nu kör vi en tur där det kan hända saker. Var uppmärksam hela tiden!"],
                [42, "Den blå skylten med kameran betyder automatisk trafikövervakning. Håll hastigheten."]] },
        { type: "road", env: "land", limit: 70, len: 320, signs: [{ s: 4, code: "E6" }, { s: 10, speed: 70 }], police: { s: 220 },
          say: [[120, "Där framme står en polis med uppsträckt arm. Det är ett stopptecken: stanna vid polisen."]] },
        { type: "road", len: 340, lanes: [0, -3.5], accident: { s: 210, len: 22 }, props: [{ s: 150, u: 1.0, kind: "triangle" }], oncoming: [40],
          say: [[100, "Varningsblinkers och varningstriangel! Det har hänt en olycka. Sakta in och var beredd att stanna."],
                [175, "Bilarna står i vårt körfält. Låt mötande passera först, kör sedan förbi lugnt på vänster sida."]] },
        { type: "road", len: 260, breakdown: { s: 170 }, props: [{ s: 120, u: 2.6, kind: "triangle" }],
          say: [[70, "En bil har fått motorstopp på vägrenen. Sakta in och ge den gott om plats."]] },
        { type: "road", len: 150, finish: true, say: [[10, "Det var en händelserik tur! Stanna här vid kanten."]] }
      ] },
    { id: "fri", icon: "🎲", name: "Fri körning", what: "En ny slumpad runda varje gång, som ett uppkörningsprov", make: makeFree, steps: [] }
  ];

  // Hooks for automated checks.
  window.SPEL = { lessons: LESSONS, start: startLesson, state: function () { return G; }, keys: keys, setBlink: setBlink,
    api: { paint: paintGround, npcPose: npcPose, lightFor: lightFor, toG: toG, rot: rot, signImg: signImg, angDiff: angDiff,
      barrierDown: barrierDown, roundPath: function (pc, k) { var ex = pc.exitAt[k - 1]; return polyG(pc.C, roundLocal(270, ex.th, ex.a, 0, 30)); }, turnPath: function (pc, dir) { return polyG(pc.C, [{ x: 1.75, y: -JH }].concat(turnLocal(dir, 0, 0).slice(1))); }, JH: JH, HW: HW, RB: RB, COL: COL } };

  buildMenu();
  show("menu");
  requestAnimationFrame(frame);
})();
