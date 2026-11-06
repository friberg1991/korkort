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
    this.signs.push({ s: s, code: sg.code, speed: sg.speed, u: u, img: sg.code ? signImg(sg.code) : null });
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
    var dims = { car: [2.2, 0.9], bus: [6, 1.25], truck: [7.5, 1.25], amb: [2.8, 1.0], tractor: [2.0, 1.1] }[this.kind];
    this.hl = dims[0]; this.hw = dims[1];
  }
  function PolyCar(o) {
    this.id = nextId++; this.mode = "poly"; this.kind = o.kind || "car"; this.poly = o.poly; this.t = o.t; this.v = o.v; this.vt = o.vt;
    this.color = o.color || pickColor(); this.prio = !!o.prio; this.canGo = o.canGo || function () { return true; };
    this.stopT = o.stopT; this.blink = o.blink || 0; this.hl = 2.2; this.hw = 0.9; this.owner = o.owner || null;
  }
  function Walker(o) {
    this.id = nextId++; this.mode = "walk"; this.kind = o.kind || "ped"; this.s = o.s; this.u = o.u; this.vu = o.vu; this.go = false;
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
  var keys = { gas: false, brake: false };
  var store = loadStore();

  function loadStore() {
    try { var o = JSON.parse(localStorage.getItem("korkort-spel") || "{}"); o.best = o.best || {}; return o; }
    catch (e) { return { best: {} }; }
  }
  function saveStore() { try { localStorage.setItem("korkort-spel", JSON.stringify(store)); } catch (e) { /* private mode */ } }

  function startLesson(idx) {
    var L = LESSONS[idx];
    G = {
      idx: idx, lesson: L, t: 0, npcs: [], faults: [], faultKeys: {}, msg: [], cur: null, curT: 0, over: false, paused: false,
      p: { s: L.start ? L.start.s : 4, v: L.start ? L.start.v / KMH : 0, d: L.start ? L.start.d : 0, td: L.start ? L.start.d : 0,
           blink: 0, blinkS: -1e9, laneT: 0, a: 0, x: 0, y: 0, stillT: 0, overT: 0, leftT: 0, closeT: 0, hl: CAR.hl, hw: CAR.hw },
      cam: { x: 0, y: 0, a: 0, sc: 12 }, crashed: false, finishT: -1
    };
    G.course = new Course(L.steps, G);
    G.course.build();
    G.prevS = G.p.s;
    var pose = G.course.poseAt(G.p.s);
    G.cam.x = pose.x; G.cam.y = pose.y; G.cam.a = pose.a;
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
    else if ((k === "ArrowLeft" || k === "a" || k === "A") && !e.repeat) setBlink(-1);
    else if ((k === "ArrowRight" || k === "d" || k === "D") && !e.repeat) setBlink(1);
    else if (k === "Escape" || k === "p" || k === "P") pause();
    else return;
    e.preventDefault();
  });
  document.addEventListener("keyup", function (e) {
    var k = e.key;
    if (k === "ArrowUp" || k === "w" || k === "W") keys.gas = false;
    if (k === "ArrowDown" || k === "s" || k === "S" || k === " ") keys.brake = false;
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
  document.getElementById("bl").addEventListener("pointerdown", function (e) { e.preventDefault(); setBlink(-1); });
  document.getElementById("br").addEventListener("pointerdown", function (e) { e.preventDefault(); setBlink(1); });
  window.addEventListener("blur", function () { keys.gas = keys.brake = false; });

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
    return out;
  }

  function update(dt) {
    var p = G.p, course = G.course;
    G.t += dt;
    // Pedals.
    var a;
    if (keys.brake) a = -7.5;
    else if (keys.gas) a = 3.4 * (1 - p.v / 48) + 0.3;
    else a = -0.3 - p.v * 0.006;
    p.v = Math.max(0, p.v + a * dt);
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
    var pc0 = curPiece();
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
    G.ambActive = G.npcs.some(function (n) { return n.kind === "amb" && !n.passed; });
    checkRules(dt);
    checkCrash();
    updateSay(dt);
  }

  function crossed(x) { return G.prevS < x && G.p.s >= x; }
  function front() { return G.p.s + CAR.hl; }

  function checkRules(dt) {
    var p = G.p, pc = curPiece(), kmh = p.v * KMH, lim = pc.limit;
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
      if (n.mode === "path" && n.dir > 0 && Math.abs(n.d - p.d) < 1.6 && n.s > p.s) { if (!ahead || n.s < ahead.s) ahead = n; }
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
        G.npcs.push(new PathCar({ s: pc.s0 + a.s, d: a.d || 0, v: a.v / KMH, kind: a.kind || "car", color: a.color, vtAt: a.queue ? queueFn(pc, a) : null, ttl: a.ttl ? pc.s0 + a.ttl : 0 }));
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
    if (st.moose && !pc.mooseOn && t >= st.moose.s - 85) {
      pc.mooseOn = true;
      G.npcs.push(new Walker({ kind: "moose", s: pc.s0 + st.moose.s, u: 14, vu: -3.4, owner: pc, trigger: 0 }));
    }
    if (st.child && !pc.childOn && t >= st.child.s - 20) {
      pc.childOn = true;
      G.npcs.push(new Walker({ kind: "child", s: pc.s0 + st.child.s, u: 3.4, vu: -1.7, owner: pc, trigger: 0, color: "#f18f01" }));
    }
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
    if (dir !== want) fault("route:" + pc.index, want === 0 ? "Vi skulle köra rakt fram." : want === 1 ? "Vi skulle svänga höger." : "Vi skulle svänga vänster.", false);
    if (dir !== 0 && p.v * KMH > 32) fault("turn:" + pc.index, "För hög fart i svängen!", false);
    if (st.ctrl === "stopp" && !pc.stopped) fault("stop:" + pc.index, "Du stannade inte vid stopplinjen. Vid stopplikt ska bilen stå helt still.", true);
    pc.dir = dir;
    var local = turnLocal(dir, 0, 0).slice(1);
    local.unshift({ x: 1.75, y: -JH });
    pc.poly = polyG(pc.C, local);
    pc.len = pc.poly.len; pc.open = false;
    // Give way: a car with right of way that will cross our path soon.
    var mine = sample(pc.poly, 1);
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
    if (p.blink) p.blink = 0;
    G.course.close(pc);
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
    if (pc.open) {
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
    } else if (!pc.praised && t > pc.len + 2) {
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
        f.peds.forEach(function (pd, i) {
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
    if (n.ttl && n.kind === "tractor") {
      // The tractor turns off onto a field road.
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
      return { x: x, y: y, a: q.a + (n.dir < 0 ? Math.PI : 0) };
    }
    if (n.mode === "poly" || n.mode === "train") return n.poly.at(n.t);
    var w = G.course.poseAt(n.s);
    return { x: w.x + Math.cos(w.a) * n.u, y: w.y + Math.sin(w.a) * n.u, a: w.a + (n.vu < 0 ? -Math.PI / 2 : Math.PI / 2) };
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
    if (n.kind === "moose" || n.kind === "child") {
      if (!n.done && (n.vu < 0 ? n.u < -9 : n.u > 4)) {
        n.done = true;
        if (n.kind === "moose") praise("Bra reagerat! Älgen kom över vägen.");
        else praise("Bra! Barn kan springa ut mellan parkerade bilar.");
      }
    }
    if (n.u < -14 || n.u > 18) n.gone = true;
    if (n.kind === "ped" && (n.vu < 0 ? n.u < -8.2 : n.u > 3.8)) { n.done = true; n.gone = true; }
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
        var what = { ped: "en gående", child: "ett barn", moose: "en älg", bus: "bussen", truck: "lastbilen", amb: "ambulansen", tractor: "traktorn" }[n.kind] || "en bil";
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
      var body = kind === "amb" ? "#f0e040" : n.color;
      ctx.fillStyle = body; rr(-hw, -hl, hw * 2, hl * 2, 0.6); ctx.fill();
      if (kind === "amb") { ctx.fillStyle = "#2e9660"; for (var k = -hl + 0.6; k < hl - 0.4; k += 0.8) ctx.fillRect(((k * 10) % 2 ? -hw : hw - 0.35), k, 0.35, 0.4); }
      ctx.fillStyle = COL.glass;
      ctx.fillRect(-hw + 0.2, -hl * 0.48, hw * 2 - 0.4, 0.75);
      ctx.fillRect(-hw + 0.25, hl * 0.42, hw * 2 - 0.5, 0.55);
      ctx.fillStyle = "rgba(255,255,255,0.18)"; ctx.fillRect(-hw + 0.3, -hl * 0.2, hw * 2 - 0.6, hl * 0.6);
      ctx.fillStyle = "#fff6d0"; ctx.fillRect(-hw + 0.15, -hl, 0.4, 0.2); ctx.fillRect(hw - 0.55, -hl, 0.4, 0.2);
      if (kind === "amb") {
        var on = Math.floor(G.t * 6) % 2;
        disc(on ? "#4aa0ff" : "#1a3a7a", -0.4, -0.3, 0.32); disc(on ? "#1a3a7a" : "#4aa0ff", 0.4, -0.3, 0.32);
        if (on) disc("rgba(74,160,255,0.25)", 0, -0.3, 2.2);
      }
    }
    if (n.blink && Math.floor(G.t * 2.6) % 2) {
      var x = n.blink > 0 ? hw - 0.1 : -hw + 0.1;
      disc(COL.orange, x, -hl + 0.25, 0.32); disc(COL.orange, x, hl - 0.25, 0.32);
      disc("rgba(255,166,30,0.3)", x, -hl + 0.25, 0.8);
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
      var pose = G.course.poseAt(sg.s), q = toG(pose, sg.u, 0), sp = w2s(q.x, q.y);
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
  function drawBarriers() {
    G.course.feats.forEach(function (f) {
      if (f.kind !== "rail" || Math.abs(f.s - G.p.s) > 250) return;
      var down = f.state === "down" ? 1 : f.state === "warn" ? clamp((f.t - 1.5) / 1.5, 0, 1) : f.state === "up" ? 1 - clamp(f.t / 2, 0, 1) : 0;
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
    drawPieces();
    ctx.restore();
    ctx = saved;
  }
  function drawHud(pc) {
    pc = pc || curPiece();
    var kmh = Math.round(G.p.v * KMH);
    hud.speed.textContent = kmh;
    hud.speed.className = kmh > pc.limit + 3 ? "over" : "";
    hud.limit.textContent = pc.limit;
    var on = Math.floor(G.t * 2.6) % 2 === 0;
    hud.l.className = "blink" + (G.p.blink < 0 && on ? " on" : "");
    hud.r.className = "blink" + (G.p.blink > 0 && on ? " on" : "");
    hud.bl.classList.toggle("on", G.p.blink < 0); hud.br.classList.toggle("on", G.p.blink > 0);
    if (G.p.blink && on !== G.lastOn) tick();
    G.lastOn = on;
  }
  var hud = { speed: document.getElementById("speed"), limit: document.getElementById("limit"), l: document.getElementById("hudL"), r: document.getElementById("hudR"),
    bl: document.getElementById("bl"), br: document.getElementById("br") };

  function updateCam(dt) {
    var c = G.cam, p = G.p;
    var base = clamp(Math.min(W, H * 0.8) / 24, 8, 20);
    var want = base / (1 + p.v / 20);
    c.sc += (want - c.sc) * Math.min(1, dt * 1.5);
    var k = Math.min(1, dt * 6);
    c.x += (p.x - c.x) * k; c.y += (p.y - c.y) * k;
    c.a += angDiff(G.course.poseAt(p.s).a, c.a) * Math.min(1, dt * 3);
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
  function pause() { if (!G || G.over) return; G.paused = true; keys.gas = keys.brake = false; if (window.speechSynthesis) speechSynthesis.cancel(); siren(0); show("paused"); }
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
      b.innerHTML = '<span class="num">' + (i + 1) + '</span><span class="txt"><span class="name"></span><br><span class="what"></span></span>' +
        (best ? '<span class="mark ' + best + '">' + (best === "ok" ? "Godkänd" : "Övning kvar") + "</span>" : "");
      b.querySelector(".name").textContent = L.name; b.querySelector(".what").textContent = L.what;
      b.addEventListener("click", function () { startLesson(i); });
      box.appendChild(b);
    });
    var v = document.getElementById("optVoice"), s = document.getElementById("optSound");
    v.checked = !!store.voice; s.checked = !!store.sound;
    document.getElementById("opt3d").checked = !!store.view3d;
    document.getElementById("pad").hidden = false;
  }
  document.getElementById("optVoice").addEventListener("change", function (e) { store.voice = e.target.checked; saveStore(); if (store.voice) speak("Hej! Jag är din lärare."); });
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
  var touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
  if (!touch) document.getElementById("pad").style.display = "none";

  // ---------- the lessons ----------
  // Distances in metres along each piece. Signs stand on the right; "speed" draws a speed limit sign.
  var LESSONS = [
    { id: "stad", name: "Stadskörning", what: "Högerregeln, övergångsställe, stopplikt och trafikljus",
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
    { id: "land", name: "Landsväg", what: "Hastighet, avstånd, älg, omkörning och väjningsplikt",
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
    { id: "rondell", name: "Cirkulationsplatser", what: "Väjningsplikt vid infart, välja avfart och blinka ut",
      steps: [
        { type: "road", env: "stad", limit: 50, len: 140, signs: [{ s: 8, speed: 50 }],
          say: [[2, "Nu övar vi cirkulationsplatser. Bilar som redan kör runt har företräde, för du har väjningsplikt när du kör in."],
                [70, "Vi ska rakt fram, det är andra avfarten. Blinka höger när du har passerat första avfarten."]] },
        { type: "round", want: 2, good: "Snyggt! Rätt avfart och du blinkade ut.", npcs: [{ from: "left", to: "right" }] },
        { type: "road", len: 160, say: [[10, "I nästa cirkulationsplats ska vi vänster. Det är tredje avfarten."]] },
        { type: "round", want: 3, good: "Bra! Tredje avfarten.", npcs: [{ from: "left", to: "right", eta: 1.3 }, { from: "fwd", to: "back", eta: 0.8 }] },
        { type: "road", len: 140, finish: true, say: [[10, "Bra jobbat! Stanna här vid kanten."]] }
      ] },
    { id: "motorvag", name: "Motorväg", what: "Påfart, omkörning, kö och avfart", start: { s: 8, v: 50, d: 3.5 },
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
    { id: "special", name: "Järnväg, utryckning och skola", what: "Bommar, ambulans, huvudled, barn och buss",
      steps: [
        { type: "road", env: "land", limit: 70, len: 270, signs: [{ s: 6, speed: 70 }, { s: 25, code: "A35" }, { s: 228, code: "A39" }], rail: { s: 240 },
          say: [[6, "Här gäller 70. Det kommer en järnvägskorsning med bommar. Blinkar de röda ljusen ska du stanna före bommen."]] },
        { type: "road", len: 320, behind: [{ at: 30, kind: "amb", v: 105, back: 160 }], oncoming: [200] },
        { type: "road", len: 160, signs: [{ s: 10, code: "B4" }],
          say: [[12, "Nu kör vi på huvudled, skylten visar det. Bilen från höger har väjningsplikt, men håll ändå ett öga på den. Vi kör rakt fram."]] },
        { type: "junction", ctrl: "huvud", want: 0, good: "Bra, rakt fram på huvudleden.", npcs: [{ from: "right", to: "straight", prio: false }] },
        { type: "road", env: "stad", limit: 30, len: 230, parking: true, parked: [70, 82, 94, 130, 142, 168],
          signs: [{ s: 4, code: "E5" }, { s: 8, speed: 30 }, { s: 40, code: "A15" }], child: { s: 150 },
          say: [[6, "Vi kommer in i tätorten. Här ligger en skola, så det är 30. Var beredd på barn mellan bilarna."]] },
        { type: "road", limit: 40, len: 220, signs: [{ s: 6, speed: 40 }, { s: 100, code: "E22" }], bus: { s: 110 },
          say: [[8, "Bussen vid hållplatsen kommer att blinka för att köra ut. Här är det högst 50, så då ska du släppa ut den."]] },
        { type: "road", len: 120, finish: true, say: [[10, "Det var sista lektionen. Stanna här vid kanten. Bra jobbat!"]] }
      ] }
  ];

  // Hooks for automated checks.
  window.SPEL = { lessons: LESSONS, start: startLesson, state: function () { return G; }, keys: keys, setBlink: setBlink,
    api: { paint: paintGround, npcPose: npcPose, lightFor: lightFor, toG: toG, rot: rot, signImg: signImg, angDiff: angDiff,
      JH: JH, HW: HW, RB: RB, COL: COL } };

  buildMenu();
  show("menu");
  requestAnimationFrame(frame);
})();
