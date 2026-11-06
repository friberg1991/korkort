// Övningskörning in 3D, seen from the driver's seat. Low poly, built with three.js.
// The game itself (course, traffic, rules, instructor) is spel.js; this only draws it.
// World (x, y) in spel.js is (x, z) here with y up, so a heading a looks along
// (sin a, 0, -cos a), and an object turned to heading a has rotation.y = -a.
// The roads are not rebuilt in 3D: spel.js paints them seen from above into a
// canvas that lies on the ground as a texture around the car.
"use strict";
(function () {
  if (!window.THREE) return;
  var T = window.THREE;
  var GROUND_PX = 2048, GROUND_M = 190, AHEAD = 25;   // ground texture size and how far ahead its centre sits
  var renderer = null, scene, camera, cockpit, wheel, grass, ground, groundCv, groundTex, gctx, canvas;
  var groundAt = null, lastG = null, lastPieces = 0, objs = [], npcMeshes = {}, signMeshes = [], lightSets = [];
  var camA = 0, wheelA = 0, prevA = null, failed = false;
  var mats = {}, geos = {};

  function mat(color, basic) {
    var key = color + (basic ? "b" : "");
    if (!mats[key]) mats[key] = basic ? new T.MeshBasicMaterial({ color: color }) : new T.MeshLambertMaterial({ color: color, flatShading: true });
    return mats[key];
  }
  function box(w, h, d) { var k = "b" + w + "," + h + "," + d; return geos[k] || (geos[k] = new T.BoxGeometry(w, h, d)); }
  function mesh(g, m, x, y, z) { var o = new T.Mesh(g, m); o.position.set(x || 0, y || 0, z || 0); return o; }

  function init() {
    try {
      canvas = document.createElement("canvas"); canvas.id = "cv3";
      var game = document.getElementById("game");
      game.insertBefore(canvas, document.getElementById("flash"));
      renderer = new T.WebGLRenderer({ canvas: canvas, antialias: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    } catch (e) { failed = true; if (canvas) canvas.remove(); return; }
    scene = new T.Scene();
    var sky = 0xc4dbec;
    scene.background = new T.Color(sky);
    scene.fog = new T.Fog(sky, 55, 135);
    camera = new T.PerspectiveCamera(70, 1, 0.05, 500);
    camera.rotation.order = "YXZ";
    scene.add(camera);
    scene.add(new T.HemisphereLight(0xeaf3ff, 0x6a8a50, 1.0));
    var sun = new T.DirectionalLight(0xfff4e0, 0.85); sun.position.set(40, 80, 25); scene.add(sun);
    buildSkyline();
    grass = mesh(new T.PlaneGeometry(3000, 3000), mat(0x709c54), 0, -0.4, 0);   // well below the road: the mirrors' depth is coarse
    grass.rotation.x = -Math.PI / 2; scene.add(grass);
    groundCv = document.createElement("canvas"); groundCv.width = groundCv.height = GROUND_PX;
    gctx = groundCv.getContext("2d");
    groundTex = new T.CanvasTexture(groundCv);
    groundTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (T.SRGBColorSpace) groundTex.colorSpace = T.SRGBColorSpace;
    ground = mesh(new T.PlaneGeometry(GROUND_M, GROUND_M), new T.MeshLambertMaterial({ map: groundTex }), 0, 0, 0);
    ground.rotation.x = -Math.PI / 2; scene.add(ground);
    buildCockpit();
    buildOwnCar();
    window.addEventListener("resize", resize);
    resize();
  }

  // The inside of the red car: dashboard, steering wheel, bonnet and pillars, fixed to the camera.
  function buildCockpit() {
    cockpit = new T.Group(); camera.add(cockpit);
    var dash = mat(0x2a2e33), dashTop = mat(0x1d2024), trim = mat(0x3a3f45), liner = mat(0xb9b3a7), door = mat(0x4a4f56), red = mat(0xe03832);
    // Dashboard: a long body, a darker top under the windscreen and a hump over the gauges.
    cockpit.add(mesh(box(2.6, 0.34, 0.75), dash, 0.35, -0.54, -0.88));
    cockpit.add(mesh(box(2.6, 0.05, 0.5), dashTop, 0.35, -0.38, -1.05));
    cockpit.add(mesh(box(0.6, 0.2, 0.28), dashTop, 0, -0.31, -0.88));
    // Bonnet in front.
    cockpit.add(mesh(box(1.8, 0.12, 2.0), red, 0.35, -0.74, -2.25));
    // Instrument cluster behind the wheel: speed, limit and blinker arrows, drawn into a canvas.
    clusterCv = document.createElement("canvas"); clusterCv.width = 512; clusterCv.height = 176;
    clusterTex = new T.CanvasTexture(clusterCv); if (T.SRGBColorSpace) clusterTex.colorSpace = T.SRGBColorSpace;
    var cl = new T.Mesh(new T.PlaneGeometry(0.5, 0.172), new T.MeshBasicMaterial({ map: clusterTex }));
    cl.position.set(0, -0.2, -0.74); cl.rotation.x = -0.12; cockpit.add(cl);
    // Centre screen and air vents.
    cockpit.add(mesh(box(0.3, 0.19, 0.03), mat(0x111417), 0.5, -0.33, -0.7));
    var scr = mesh(new T.PlaneGeometry(0.27, 0.16), new T.MeshBasicMaterial({ color: 0x1f4257 }), 0.5, -0.33, -0.684); cockpit.add(scr);
    cockpit.add(mesh(box(0.2, 0.012, 0.004), new T.MeshBasicMaterial({ color: 0x5fb3d9 }), 0.47, -0.3, -0.68));
    cockpit.add(mesh(box(0.12, 0.012, 0.004), new T.MeshBasicMaterial({ color: 0x3e7f9e }), 0.44, -0.33, -0.68));
    [[0.28, -0.29], [0.72, -0.29], [-0.42, -0.31]].forEach(function (v) { cockpit.add(mesh(box(0.14, 0.06, 0.03), mat(0x14171a), v[0], v[1], -0.72)); });
    // Door on the left, with window sill and handle.
    cockpit.add(mesh(box(0.08, 0.5, 1.3), door, -0.66, -0.55, -0.35));
    cockpit.add(mesh(box(0.12, 0.05, 1.3), trim, -0.63, -0.29, -0.35));
    cockpit.add(mesh(box(0.03, 0.04, 0.16), mat(0x8c9198), -0.61, -0.4, -0.3));
    // Windscreen pillars, roof lining and sun visors.
    [[-0.66, -0.95], [1.35, -1.0]].forEach(function (q) {
      var pil = mesh(box(0.1, 1.4, 0.1), trim, q[0], 0.2, q[1]); pil.rotation.x = -0.45; cockpit.add(pil);
    });
    cockpit.add(mesh(box(2.4, 0.1, 0.9), liner, 0.35, 0.62, -0.5));
    cockpit.add(mesh(box(0.42, 0.03, 0.2), liner, -0.15, 0.55, -0.82));
    cockpit.add(mesh(box(0.42, 0.03, 0.2), liner, 0.85, 0.55, -0.85));
    // Mirrors: rear-view in the middle of the roof edge, one on each door. Their pictures come from cameras looking back.
    mirrors = [
      makeMirror(0.38, 0.17, -0.72, 0.4, 0.11, 34, 0x16191c, 0.6),
      makeMirror(-1.0, -0.06, -0.98, 0.22, 0.14, 40, 0x2a2e33, 0.5),
      makeMirror(1.0, -0.07, -1.12, 0.22, 0.14, 40, 0x2a2e33, -0.5)
    ];
    cockpit.add(mesh(box(0.02, 0.4, 0.02), trim, 0.38, 0.4, -0.74));
    // Steering wheel and the blinker stalk on its left.
    var holder = new T.Group(); holder.position.set(0, -0.38, -0.56); holder.rotation.x = -0.42; cockpit.add(holder);
    var column = mesh(new T.CylinderGeometry(0.035, 0.05, 0.25, 8), mat(0x1b1e22), 0, 0, -0.13); column.rotation.x = Math.PI / 2; holder.add(column);
    stalk = new T.Group(); stalk.position.set(-0.05, 0, -0.07); holder.add(stalk);
    stalk.add(mesh(box(0.15, 0.015, 0.015), mat(0x2c3136), -0.075, 0, 0));
    wheel = new T.Group(); holder.add(wheel);
    wheel.add(new T.Mesh(new T.TorusGeometry(0.19, 0.03, 8, 24), mat(0x202326)));
    [0, 2.0, -2.0].forEach(function (a) {
      var sp = mesh(box(0.05, 0.15, 0.02), mat(0x34393f), Math.sin(a) * 0.1, -Math.cos(a) * 0.1, 0);
      sp.rotation.z = a; wheel.add(sp);
    });
    var hub = mesh(new T.CylinderGeometry(0.065, 0.07, 0.05, 10), mat(0x2c3136)); hub.rotation.x = Math.PI / 2; wheel.add(hub);
    var logo = mesh(new T.CylinderGeometry(0.02, 0.02, 0.012, 10), mat(0x9aa0a6), 0, 0, 0.03); logo.rotation.x = Math.PI / 2; wheel.add(logo);
    wheel.add(mesh(box(0.05, 0.03, 0.035), mat(0xb8b2a6), 0, 0.19, 0.0));   // stitching mark at the top
  }
  var clusterCv, clusterTex, clusterKey = "", mirrors = [], stalk, ownCar;
  function buildOwnCar() {
    ownCar = new T.Group();
    ownCar.add(mesh(box(1.9, 0.75, 4.5), mat(0xe03832), 0, 0.6, 0));
    ownCar.add(mesh(box(1.75, 0.55, 2.3), mat(0xe03832), 0, 1.22, 0.3));
    ownCar.add(mesh(box(1.77, 0.4, 2.1), mat(0x303a4a), 0, 1.25, 0.3));
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (w) {
      var wh = mesh(cyl(0.33, 0.33, 0.24, 10), mat(0x1c1c1c), w[0] * 0.88, 0.33, w[1] * 1.45); wh.rotation.z = Math.PI / 2; ownCar.add(wh);
    });
    ownCar.visible = false; scene.add(ownCar);
  }

  function makeMirror(x, y, z, w, h, fov, frame, yaw) {
    var rt = new T.WebGLRenderTarget(320, Math.round(320 * h / w));
    if (T.SRGBColorSpace) rt.texture.colorSpace = T.SRGBColorSpace;
    rt.texture.wrapS = T.RepeatWrapping; rt.texture.repeat.x = -1; rt.texture.offset.x = 1;   // a mirror shows things the other way round
    var g = new T.Group(); g.position.set(x, y, z); g.rotation.y = yaw * 0.4;
    g.add(mesh(box(w + 0.03, h + 0.03, 0.03), mat(frame), 0, 0, -0.02));
    var face = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ map: rt.texture }));
    face.position.z = 0.001; g.add(face);
    cockpit.add(g);
    var cam = new T.PerspectiveCamera(fov, w / h, 0.3, 200); cam.rotation.order = "YXZ";
    return { rt: rt, cam: cam, side: x < 0 ? -1 : x > 0.6 ? 1 : 0, g: g };
  }
  function renderMirrors(p, a) {
    var fx = Math.sin(a), fy = -Math.cos(a), rx = Math.cos(a), ry = Math.sin(a);
    cockpit.visible = false;
    // Our own car, seen only in the mirrors: its flank shows at the inner edge of the door mirrors.
    ownCar.visible = true; ownCar.position.set(p.x, 0, p.y); ownCar.rotation.y = -a;
    mirrors.forEach(function (m) {
      var off = m.side === 0 ? 0 : m.side * 1.08, fwd = m.side === 0 ? -0.9 : 0.5;
      m.cam.position.set(p.x + rx * off + fx * fwd, m.side === 0 ? 1.32 : 1.05, p.y + ry * off + fy * fwd);
      // Door mirrors look back and a little outwards; the rear-view one straight back, slightly down.
      m.cam.rotation.set(m.side === 0 ? -0.06 : -0.05, Math.PI - a + m.side * 0.2, 0);
      ownCar.visible = m.side !== 0;
      renderer.setRenderTarget(m.rt); renderer.render(scene, m.cam);
    });
    renderer.setRenderTarget(null);
    cockpit.visible = true; ownCar.visible = false;
  }
  function drawCluster(kmh, limit, blink, on) {
    var key = kmh + "|" + limit + "|" + blink + "|" + on;
    if (key === clusterKey) return;
    clusterKey = key;
    var x = clusterCv.getContext("2d"), W = 512, H = 176;
    x.fillStyle = "#07090c"; x.fillRect(0, 0, W, H);
    // Speed dial on the left, 0 to 160.
    var cx = 120, cy = 104, R = 78;
    x.lineWidth = 6; x.strokeStyle = "#2b3238"; x.beginPath(); x.arc(cx, cy, R, Math.PI * 0.8, Math.PI * 2.2); x.stroke();
    x.strokeStyle = "#0cd29d"; x.beginPath(); x.arc(cx, cy, R, Math.PI * 0.8, Math.PI * (0.8 + 1.4 * Math.min(kmh, 160) / 160)); x.stroke();
    x.fillStyle = "#8a9299"; x.font = "600 15px system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    for (var v = 0; v <= 160; v += 40) { var aa = Math.PI * (0.8 + 1.4 * v / 160); x.fillText(String(v), cx + Math.cos(aa) * (R - 22), cy + Math.sin(aa) * (R - 22)); }
    var na = Math.PI * (0.8 + 1.4 * Math.min(kmh, 160) / 160);
    x.strokeStyle = "#ff5a3c"; x.lineWidth = 4; x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(na) * (R - 8), cy + Math.sin(na) * (R - 8)); x.stroke();
    // Speed in figures in the middle; red when over the limit.
    x.fillStyle = kmh > limit + 3 ? "#ff8a80" : "#f2f4f5"; x.font = "800 64px system-ui, sans-serif"; x.fillText(String(kmh), 300, 92);
    x.fillStyle = "#8a9299"; x.font = "600 17px system-ui, sans-serif"; x.fillText("km/h", 300, 136);
    // The speed limit, as the car's sign reading shows it.
    x.fillStyle = "#fff"; x.beginPath(); x.arc(440, 92, 40, 0, 7); x.fill();
    x.fillStyle = "#e03832"; x.beginPath(); x.arc(440, 92, 38, 0, 7); x.fill();
    x.fillStyle = "#f8c628"; x.beginPath(); x.arc(440, 92, 28, 0, 7); x.fill();
    x.fillStyle = "#111"; x.font = "800 " + (limit >= 100 ? 24 : 30) + "px system-ui, sans-serif"; x.fillText(String(limit), 440, 94);
    // Blinker arrows.
    [-1, 1].forEach(function (d) {
      var lit = blink === d && on, ax = d < 0 ? 210 : 390;
      x.fillStyle = lit ? "#3ee07a" : "#1e2a22"; x.beginPath();
      x.moveTo(ax + d * 22, 26); x.lineTo(ax, 10); x.lineTo(ax, 18); x.lineTo(ax - d * 16, 18); x.lineTo(ax - d * 16, 34); x.lineTo(ax, 34); x.lineTo(ax, 42); x.closePath(); x.fill();
    });
    clusterTex.needsUpdate = true;
  }

  function resize() {
    if (!renderer) return;
    var w = window.innerWidth, h = window.innerHeight, asp = w / h;
    renderer.setSize(w, h, false);
    camera.aspect = asp;
    // About 90 degrees across, at least 60 high so the wheel shows; capped in portrait.
    camera.fov = Math.min(92, Math.max(60, 2 * Math.atan(Math.tan(45 * Math.PI / 180) / asp) * 180 / Math.PI));
    camera.updateProjectionMatrix();
  }

  function clearAll() {
    objs.forEach(function (o) { scene.remove(o); });
    Object.keys(npcMeshes).forEach(function (k) { scene.remove(npcMeshes[k]); });
    signMeshes.forEach(function (o) { scene.remove(o.obj); });
    lightSets.forEach(function (o) { o.groups.forEach(function (g) { scene.remove(g); }); });
    objs = []; npcMeshes = {}; signMeshes = []; lightSets = []; railSets = []; groundAt = null; prevA = null;
  }

  // ---------- things along the road ----------
  function place(o, x, y, a) { o.position.x = x; o.position.z = y; o.rotation.y = -a; scene.add(o); objs.push(o); return o; }
  function tree(x, y, r) {
    var g = new T.Group();
    g.add(mesh(new T.CylinderGeometry(0.15, 0.22, 1.6, 5), mat(0x6b4a2f), 0, 0.8, 0));
    if (!shadowMat) shadowMat = new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
    var sh = new T.Mesh(new T.CircleGeometry(r * 0.9, 8), shadowMat); sh.rotation.x = -Math.PI / 2; sh.position.set(0.4, 0.03, 0.4); g.add(sh);
    var top = mesh(new T.IcosahedronGeometry(r, 0), mat(snowy ? 0x4a6650 : (Math.random() < 0.5 ? 0x3f6e30 : 0x4d7a35)), 0, 1.4 + r * 0.8, 0);
    if (snowy) { var cap = mesh(new T.IcosahedronGeometry(r * 0.75, 0), mat(0xf2f5f7), 0, 1.4 + r * 1.35, 0); cap.scale.y = 0.6; g.add(cap); }
    top.scale.y = 1.25; g.add(top);
    return place(g, x, y, 0);
  }
  function house(api, pc, d, rnd) {
    var c = api.toG(pc.P, d.u + d.dep / 2, d.w + d.len / 2);
    var hgt = 5 + rnd * 5, g = new T.Group();
    g.add(mesh(box(d.dep, hgt, d.len), mat(d.c), 0, hgt / 2, 0));
    var roof = mesh(new T.ConeGeometry(Math.SQRT1_2, 1, 4), mat(d.roof), 0, hgt + 1.1, 0);
    roof.rotation.y = Math.PI / 4; roof.scale.set(d.dep, 2.2, d.len); g.add(roof);
    // A few windows on the road side.
    var side = d.u > 0 ? -1 : 1, win = mat(0x34404e);
    for (var k = -d.len / 2 + 2; k < d.len / 2 - 1.5; k += 3.2) {
      g.add(mesh(box(0.05, 1.1, 1.3), win, side * (d.dep / 2 + 0.03), hgt * 0.55, k));
      if (hgt > 7) g.add(mesh(box(0.05, 1.1, 1.3), win, side * (d.dep / 2 + 0.03), hgt * 0.85 - 0.3, k));
    }
    return place(g, c.x, c.y, pc.P.a);
  }
  function buildPiece(api, pc) {
    pc.built3d = true;
    var n = 0;
    (pc.decor || []).forEach(function (d) {
      n++;
      if (d.t === "house") house(api, pc, d, (n * 0.37) % 1);
      else if (d.t === "tree") { var q = api.toG(pc.P, d.u, d.w); tree(q.x, q.y, d.r * 0.8); }
    });
    if (pc.kind === "round") tree(pc.C.x, pc.C.y, 2.4);
    if (pc.kind === "road" || pc.kind === "mv") roadside(api, pc);
    if (pc.light) buildLights(api, pc);
  }

  function cyl(r1, r2, h, n) { var k = "c" + r1 + "," + r2 + "," + h + "," + n; return geos[k] || (geos[k] = new T.CylinderGeometry(r1, r2, h, n)); }
  // Street furniture along a piece: lamps in town, white edge posts on country roads,
  // the guard rail between the motorway's carriageways, a shelter at a bus stop.
  function roadside(api, pc) {
    var L = pc.len, st = pc.st, at = function (u, w) { return api.toG(pc.P, u, w); };
    if (pc.kind === "mv") {
      var c = at(-8.4, L / 2), rail = new T.Group();
      rail.add(mesh(box(0.1, 0.32, L), mat(0xc9c9c4), 0, 0.6, 0));
      for (var k = -L / 2 + 2; k < L / 2; k += 4) rail.add(mesh(box(0.12, 0.6, 0.12), mat(0x8a8e94), 0, 0.3, k));
      place(rail, c.x, c.y, pc.P.a);
      return;
    }
    if (pc.env === "stad") {
      var edge = 1.75 + (pc.parking ? 2.5 : 0) + 0.5;
      for (var w = 12; w < L - 8; w += 32) {
        var q = at(edge, w), lamp = new T.Group();
        lamp.add(mesh(cyl(0.06, 0.08, 6, 6), mat(0x55595e), 0, 3, 0));
        lamp.add(mesh(box(1.4, 0.08, 0.08), mat(0x55595e), -0.7, 5.95, 0));
        lamp.add(mesh(box(0.5, 0.12, 0.25), mat(0x3a3f45), -1.35, 5.88, 0));
        lamp.add(mesh(box(0.42, 0.03, 0.18), mat(0xfff3c4, true), -1.35, 5.81, 0));
        place(lamp, q.x, q.y, pc.P.a);
      }
    } else {
      // Kantstolpar: white posts with a black band, about every 50 m on both sides.
      for (var w2 = 25; w2 < L; w2 += 50) {
        [[2.7, 0], [-6.2, Math.PI]].forEach(function (o) {
          var q2 = at(o[0], w2), post = new T.Group();
          post.add(mesh(box(0.12, 1.0, 0.12), mat(0xeceef0), 0, 0.5, 0));
          post.add(mesh(box(0.13, 0.18, 0.13), mat(0x1c1c1c), 0, 0.85, 0));
          post.add(mesh(box(0.05, 0.08, 0.02), mat(0xffa61e, true), 0, 0.72, 0.07));
          place(post, q2.x, q2.y, pc.P.a + o[1]);
        });
      }
    }
    if (st.bus) {
      var b = at(7.2, st.bus.s), shelter = new T.Group();
      shelter.add(mesh(box(1.6, 0.1, 4.2), mat(0x3a3f45), 0, 2.4, 0));
      shelter.add(mesh(box(0.06, 2.3, 4.0), new T.MeshLambertMaterial({ color: 0x9fc3d6, transparent: true, opacity: 0.45 }), 0.75, 1.2, 0));
      [-1.95, 1.95].forEach(function (z) { shelter.add(mesh(box(1.5, 2.3, 0.06), new T.MeshLambertMaterial({ color: 0x9fc3d6, transparent: true, opacity: 0.45 }), 0, 1.2, z)); });
      shelter.add(mesh(box(0.5, 0.45, 2.6), mat(0x6b4a2f), 0.35, 0.45, 0));
      place(shelter, b.x, b.y, pc.P.a);
    }
  }

  // Signs stand on the right and face the traffic coming towards them.
  var speedTex = {};
  function speedTexture(n) {
    if (speedTex[n]) return speedTex[n];
    var c = document.createElement("canvas"); c.width = c.height = 128; var x = c.getContext("2d");
    x.fillStyle = "#fff"; x.beginPath(); x.arc(64, 64, 63, 0, 7); x.fill();
    x.fillStyle = "#e03832"; x.beginPath(); x.arc(64, 64, 60, 0, 7); x.fill();
    x.fillStyle = "#f8c628"; x.beginPath(); x.arc(64, 64, 44, 0, 7); x.fill();
    x.fillStyle = "#111"; x.font = "800 " + (n >= 100 ? 40 : 54) + "px system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    x.fillText(String(n), 64, 67);
    var t = new T.CanvasTexture(c); if (T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace;
    return (speedTex[n] = t);
  }
  var imgTex = {};
  function signTexture(api, code) {
    if (imgTex[code]) return imgTex[code];
    var img = api.signImg(code), t = new T.Texture(img);
    if (T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace;
    if (img.complete) t.needsUpdate = true; else img.addEventListener("load", function () { t.needsUpdate = true; });
    return (imgTex[code] = t);
  }
  function buildSign(api, G, sg) {
    var pose = G.course.poseAt(sg.s), q = api.toG(pose, sg.u, 0), g = new T.Group();
    g.add(mesh(new T.CylinderGeometry(0.04, 0.04, 2.2, 6), mat(0x8a8e94), 0, 1.1, 0));
    var tex = sg.speed ? speedTexture(sg.speed) : signTexture(api, sg.code);
    var face = new T.Mesh(new T.PlaneGeometry(1.15, 1.15), new T.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.3, fog: true }));
    face.position.set(0, 2.55, 0.03); g.add(face);
    var back = mesh(new T.PlaneGeometry(1.0, 1.0), mat(0x8a8e94), 0, 2.55, 0); back.rotation.y = Math.PI; g.add(back);
    g.position.set(q.x, 0, q.y); g.rotation.y = -pose.a; scene.add(g);
    return g;
  }

  // Traffic lights at each corner of a junction with signals.
  function buildLights(api, pc) {
    var set = { pc: pc, groups: [], lamps: [] };
    [270, 0, 90, 180].forEach(function (arm) {
      var r = api.rot({ x: api.HW + 1.2, y: -api.JH - 1 }, arm - 270), q = api.toG(pc.C, r.x, r.y);
      var g = new T.Group();
      g.add(mesh(new T.CylinderGeometry(0.06, 0.06, 2.6, 6), mat(0x55595e), 0, 1.3, 0));
      g.add(mesh(box(0.4, 1.1, 0.3), mat(0x15181c), 0, 3.0, 0));
      var lamps = [0xff3b30, 0xffcc00, 0x34c759].map(function (col, i) {
        var m = new T.MeshBasicMaterial({ color: 0x333a40 });
        var l = mesh(new T.CylinderGeometry(0.13, 0.13, 0.05, 10), m, 0, 3.35 - i * 0.34, 0.17); l.rotation.x = Math.PI / 2; g.add(l);
        return { m: m, on: col };
      });
      g.position.set(q.x, 0, q.y); g.rotation.y = -(pc.C.a + (270 - arm) * Math.PI / 180); scene.add(g);
      set.groups.push(g); set.lamps.push({ arm: arm, lamps: lamps });
    });
    lightSets.push(set);
  }
  function updateLights(api) {
    lightSets.forEach(function (set) {
      set.lamps.forEach(function (a) {
        var ph = api.lightFor(set.pc, a.arm);
        var on = [ph === "red" || ph === "redyellow", ph === "yellow" || ph === "redyellow", ph === "green"];
        a.lamps.forEach(function (l, i) { l.m.color.setHex(on[i] ? l.on : 0x333a40); });
      });
    });
  }

  // Level crossing: a lamp post on each side and a barrier arm that swings up.
  var railSets = [];
  function buildRail(api, G, f) {
    var pose = G.course.poseAt(f.s), set = { f: f, lamps: [], arms: [] };
    [[3.0, -5, 0], [-8.0, 5, Math.PI]].forEach(function (o) {
      var q = api.toG(pose, o[0], o[1]), g = new T.Group();
      g.add(mesh(new T.CylinderGeometry(0.07, 0.07, 2.8, 6), mat(0x55595e), 0, 1.4, 0));
      g.add(mesh(box(1.0, 0.45, 0.2), mat(0x15181c), 0, 2.6, 0));
      [-0.27, 0.27].forEach(function (x) {
        var m = new T.MeshBasicMaterial({ color: 0x40262a }), l = mesh(new T.CylinderGeometry(0.15, 0.15, 0.05, 10), m, x, 2.6, 0.13);
        l.rotation.x = Math.PI / 2; g.add(l); set.lamps.push(m);
      });
      g.position.set(q.x, 0, q.y); g.rotation.y = -(pose.a + o[2]); scene.add(g); objs.push(g);
    });
    [[2.6, -5, 1], [-6.1, 5, -1]].forEach(function (b) {
      var q = api.toG(pose, b[0], b[1]), base = new T.Group();
      base.add(mesh(box(0.35, 1.1, 0.35), mat(0xeceef0), 0, 0.55, 0));
      var pivot = new T.Group(); pivot.position.y = 1.0; base.add(pivot);
      for (var i = 0; i < 5; i++) pivot.add(mesh(box(0.8, 0.12, 0.08), mat(i % 2 ? 0xe03832 : 0xeceef0), -b[2] * (i * 0.8 + 0.4), 0, 0));
      base.position.set(q.x, 0, q.y); base.rotation.y = -pose.a; scene.add(base); objs.push(base);
      set.arms.push({ pivot: pivot, side: b[2] });
    });
    return set;
  }
  function updateRails(api, G) {
    railSets.forEach(function (set) {
      var f = set.f, down = api.barrierDown(f), blink = f.state !== "open" ? Math.floor(G.t * 3) % 2 : -1;
      set.lamps.forEach(function (m, i) { m.color.setHex(blink === i % 2 ? 0xff3b30 : 0x40262a); });
      set.arms.forEach(function (a) { a.pivot.rotation.z = -a.side * (1 - down) * Math.PI / 2; });
    });
  }

  // ---------- road users ----------
  function makeNpc(n) {
    var g = new T.Group(), col = n.color || "#286ee0";
    if (!shadowMat) shadowMat = new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false });
    if (n.mode !== "train") g.add(shadow(n.hw * 2 + 0.3, n.hl * 2 + 0.3));
    if (n.kind === "ped" || n.kind === "child" || n.kind === "stroll") {
      var h = n.kind === "child" ? 1.15 : 1.7;
      g.add(mesh(new T.CylinderGeometry(0.2, 0.24, h * 0.62, 6), mat(col), 0, h * 0.45 + h * 0.31 - h * 0.3, 0));
      g.add(mesh(box(0.28, h * 0.45, 0.2), mat(0x333840), 0, h * 0.22, 0));
      g.add(mesh(new T.IcosahedronGeometry(h * 0.1, 0), mat(0xe8c39e), 0, h * 0.93, 0));
    } else if (n.kind === "moose") {
      g.add(mesh(box(0.9, 1.0, 2.4), mat(0x5b3a22), 0, 1.6, 0));
      g.add(mesh(box(0.45, 0.6, 0.8), mat(0x4a2e1a), 0, 2.0, -1.5));
      g.add(mesh(box(1.4, 0.1, 0.3), mat(0xc8b48a), 0, 2.4, -1.4));
      [[-0.3, -0.9], [0.3, -0.9], [-0.3, 0.9], [0.3, 0.9]].forEach(function (l) { g.add(mesh(box(0.15, 1.1, 0.15), mat(0x3a2414), l[0], 0.55, l[1])); });
    } else if (n.kind === "train") {
      for (var k = 0; k < 4; k++) {
        g.add(mesh(box(3.2, 3.6, 12.8), mat(k === 0 ? 0xc0392b : 0x8e959e), 0, 2.0, k * 13.5));
        g.add(mesh(box(3.25, 0.6, 11), mat(0x30363e), 0, 2.6, k * 13.5));
      }
    } else {
      var L = n.hl * 2, Wd = n.hw * 2;
      var wheels = function (zs, r) {
        zs.forEach(function (z) { [-1, 1].forEach(function (sd) {
          var wh = mesh(cyl(r, r, 0.32, 12), mat(0x1c1c1c), sd * (n.hw - 0.12), r, z); wh.rotation.z = Math.PI / 2; g.add(wh);
          var hub = mesh(cyl(r * 0.45, r * 0.45, 0.34, 8), mat(0x9aa0a6), sd * (n.hw - 0.12), r, z); hub.rotation.z = Math.PI / 2; g.add(hub);
        }); });
      };
      if (n.kind === "bus") {
        g.add(mesh(box(Wd, 2.75, L), mat(col), 0, 0.3 + 1.375, 0));
        g.add(mesh(box(Wd + 0.02, 1.0, L - 2.2), mat(0x303a4a), 0, 2.1, 0.5));          // side windows
        g.add(mesh(box(Wd - 0.2, 1.3, 0.04), mat(0x303a4a), 0, 2.0, -n.hl - 0.01));      // windscreen
        g.add(mesh(box(Wd - 0.3, 0.3, 0.04), mat(0xffa61e, true), 0, 2.85, -n.hl - 0.02)); // destination sign
        g.add(mesh(box(0.04, 2.0, 1.1), mat(0x2a3038), n.hw + 0.01, 1.3, -n.hl + 1.4));   // front door, kerb side
        g.add(mesh(box(0.04, 2.0, 1.1), mat(0x2a3038), n.hw + 0.01, 1.3, 0.6));            // middle door
        g.add(mesh(box(Wd - 0.4, 0.15, 0.05), mat(0xd04030, true), 0, 0.9, n.hl + 0.01));
        wheels([-n.hl + 2.3, n.hl - 3.0], 0.5);
      } else if (n.kind === "truck") {
        g.add(mesh(box(Wd, 2.5, 2.4), mat(0xeceef0), 0, 1.75, -n.hl + 1.2));
        g.add(mesh(box(Wd + 0.02, 0.8, 0.1), mat(0x303a4a), 0, 2.3, -n.hl + 0.02));
        g.add(mesh(box(Wd, 3.2, L - 2.8), mat(0x9aa3b4), 0, 2.2, 1.4));
        g.add(mesh(box(Wd - 0.4, 0.15, 0.05), mat(0xd04030, true), 0, 0.9, n.hl + 0.01));
        wheels([-n.hl + 1.3, n.hl - 2.8, n.hl - 1.6], 0.5);
      } else if (n.kind === "bike") {
        [-0.55, 0.55].forEach(function (z) { var wh = mesh(cyl(0.34, 0.34, 0.05, 12), mat(0x1c1c1c), 0, 0.34, z); wh.rotation.z = Math.PI / 2; g.add(wh); });
        g.add(mesh(box(0.05, 0.05, 1.0), mat(0x8a8e94), 0, 0.6, 0));
        g.add(mesh(box(0.34, 0.6, 0.24), mat(col), 0, 1.25, 0.1));
        g.add(mesh(box(0.2, 0.5, 0.2), mat(0x333840), 0, 0.75, 0.15));
        g.add(mesh(new T.IcosahedronGeometry(0.13, 0), mat(0xf0c419), 0, 1.7, 0.05));
      } else if (n.kind === "tractor") {
        g.add(mesh(box(Wd - 0.6, 1.0, L), mat(0x2f8a3a), 0, 1.0, 0));
        g.add(mesh(box(Wd - 0.7, 1.3, 1.3), mat(0x303a4a), 0, 2.1, 0.5));
        [[-1, 1, 0.75], [1, 1, 0.75], [-1, -1, 0.45], [1, -1, 0.45]].forEach(function (w) {
          var wh = mesh(new T.CylinderGeometry(w[2], w[2], 0.4, 10), mat(0x1c1c1c), w[0] * (n.hw - 0.1), w[2], w[1] * 1.0);
          wh.rotation.z = Math.PI / 2; g.add(wh);
        });
      } else {
        var body = n.kind === "amb" ? "#f0e040" : col;
        g.add(mesh(box(Wd, 0.75, L), mat(body), 0, 0.6, 0));
        [-1, 1].forEach(function (sd) { g.add(mesh(box(0.34, 0.14, 0.05), mat(0xfff6d0, true), sd * (n.hw - 0.28), 0.72, -n.hl - 0.01)); });
        g.add(mesh(box(Wd - 0.7, 0.12, 0.04), mat(0x1c1f23), 0, 0.5, -n.hl - 0.01));   // grille
        g.add(mesh(box(Wd - 0.15, 0.6, L * 0.5), mat(body), 0, 1.25, 0.15));
        g.add(mesh(box(Wd - 0.13, 0.42, L * 0.46), mat(0x303a4a), 0, 1.25, 0.15));
        [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (w) {
          var wh = mesh(new T.CylinderGeometry(0.33, 0.33, 0.22, 8), mat(0x1c1c1c), w[0] * (n.hw - 0.08), 0.33, w[1] * (n.hl - 0.8));
          wh.rotation.z = Math.PI / 2; g.add(wh);
        });
        g.userData.brake = new T.MeshBasicMaterial({ color: 0x7a2018 });
        g.add(mesh(box(Wd - 0.3, 0.12, 0.05), g.userData.brake, 0, 0.75, n.hl + 0.01));   // rear lights, bright when braking
        if (n.kind === "amb") {
          g.userData.siren = [mesh(box(0.35, 0.18, 0.25), new T.MeshBasicMaterial({ color: 0x4aa0ff }), -0.35, 1.65, -0.3),
                              mesh(box(0.35, 0.18, 0.25), new T.MeshBasicMaterial({ color: 0x4aa0ff }), 0.35, 1.65, -0.3)];
          g.userData.siren.forEach(function (o) { g.add(o); });
        }
      }
      // Indicator lamps on each corner; lit on the side the vehicle blinks to.
      g.userData.blink = [-1, 1].map(function (side) {
        var m = new T.MeshBasicMaterial({ color: 0x4a3a20 });
        [-1, 1].forEach(function (end) { g.add(mesh(box(0.14, 0.12, 0.14), m, side * (n.hw - 0.02), 0.85, end * (n.hl - 0.05))); });
        return m;
      });
    }
    scene.add(g);
    return g;
  }
  function updateNpcs(api, G) {
    var seen = {};
    G.npcs.forEach(function (n) {
      var g = npcMeshes[n.id] || (npcMeshes[n.id] = makeNpc(n));
      seen[n.id] = true;
      var pose = n.mode === "train" ? n.poly.at(n.t) : api.npcPose(n);
      g.position.x = pose.x; g.position.z = pose.y; g.rotation.y = -pose.a;
      if (n.mode === "walk" && n.kind !== "moose") g.position.y = Math.abs(Math.sin(G.t * 9)) * 0.05;
      if (g.userData.brake) {
        var dv = (g.userData.lastV != null ? g.userData.lastV - n.v : 0);
        g.userData.lastV = n.v;
        g.userData.brakeT = dv > 0.04 || (n.v < 0.3 && !n.parked) ? 0.4 : Math.max(0, (g.userData.brakeT || 0) - 0.016);
        g.userData.brake.color.setHex(g.userData.brakeT > 0 ? 0xff2a1a : 0x7a2018);
      }
      if (g.userData.blink) {
        var on = Math.floor(G.t * 2.6) % 2 === 1;
        g.userData.blink[0].color.setHex(n.blink < 0 && on ? 0xffa61e : 0x4a3a20);
        g.userData.blink[1].color.setHex(n.blink > 0 && on ? 0xffa61e : 0x4a3a20);
      }
      if (g.userData.siren) {
        var f = Math.floor(G.t * 6) % 2;
        g.userData.siren[0].material.color.setHex(f ? 0x4aa0ff : 0x10224a);
        g.userData.siren[1].material.color.setHex(f ? 0x10224a : 0x4aa0ff);
      }
    });
    Object.keys(npcMeshes).forEach(function (k) { if (!seen[k]) { scene.remove(npcMeshes[k]); delete npcMeshes[k]; } });
  }

  // Sky dome with a soft gradient, a few low-poly clouds and a dark line of forest on the horizon.
  // All three follow the car; they are drawn past the fog, so they keep their colour.
  var skyDome, clouds, forest;
  function buildSkyline() {
    var geo = new T.SphereGeometry(420, 24, 12), col = [], pos = geo.attributes.position;
    for (var i = 0; i < pos.count; i++) col.push(0, 0, 0);
    geo.setAttribute("color", new T.Float32BufferAttribute(col, 3));
    skyDome = new T.Mesh(geo, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide, fog: false, depthWrite: false }));
    skyDome.renderOrder = -2; scene.add(skyDome);
    clouds = new T.Group();
    var r = Math.random, cm = new T.MeshLambertMaterial({ color: 0xffffff, fog: false, flatShading: true });
    for (var c = 0; c < 14; c++) {
      var cl = new T.Group(), a = r() * Math.PI * 2, dist = 160 + r() * 160;
      for (var k = 0; k < 4; k++) {
        var puff = new T.Mesh(new T.IcosahedronGeometry(8 + r() * 8, 0), cm);
        puff.position.set(k * 9 - 13 + r() * 4, r() * 3, r() * 6); puff.scale.y = 0.5; cl.add(puff);
      }
      cl.position.set(Math.cos(a) * dist, 70 + r() * 40, Math.sin(a) * dist); cl.rotation.y = r() * 3;
      clouds.add(cl);
    }
    scene.add(clouds);
    forest = new T.Group();
    var fm = new T.MeshBasicMaterial({ color: 0x5f7f6a, fog: false });
    for (var t = 0; t < 140; t++) {
      var ang = t / 140 * Math.PI * 2 + r() * 0.03, rad = 190 + r() * 25, h = 10 + r() * 14;
      var tr = new T.Mesh(new T.ConeGeometry(4 + r() * 3, h, 5), fm);
      tr.position.set(Math.cos(ang) * rad, h / 2 - 1, Math.sin(ang) * rad); forest.add(tr);
    }
    scene.add(forest);
    paintSky(false);
  }
  function paintSky(snow) {
    var geo = skyDome.geometry, pos = geo.attributes.position, col = geo.attributes.color;
    var top = new T.Color(snow ? 0xb8c2ca : 0x5d97d6), mid = new T.Color(snow ? 0xd9dee2 : 0xa9cbea), low = new T.Color(snow ? 0xd9dee2 : 0xc4dbec), c = new T.Color();
    for (var i = 0; i < pos.count; i++) {
      var y = pos.getY(i) / 420;
      if (y > 0.25) c.copy(mid).lerp(top, Math.min(1, (y - 0.25) / 0.6)); else c.copy(low).lerp(mid, Math.max(0, y / 0.25));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    clouds.visible = !snow;
    forest.children[0].material.color.setHex(snow ? 0xaab4b8 : 0x5f7f6a);
  }
  function shadow(w, l) {
    var m = new T.Mesh(new T.PlaneGeometry(w, l), shadowMat);
    m.rotation.x = -Math.PI / 2; m.position.y = 0.03; return m;
  }
  var shadowMat = null;

  var snowy = false, flakes = null;
  function setWeather(w) {
    snowy = w === "snow";
    var sky = snowy ? 0xd9dee2 : 0xc4dbec;
    scene.background.setHex(sky); scene.fog.color.setHex(sky);
    scene.fog.near = snowy ? 25 : 55; scene.fog.far = snowy ? 95 : 135;
    grass.material = mat(snowy ? 0xe6ebee : 0x709c54);
    paintSky(snowy);
    if (flakes) { scene.remove(flakes); flakes = null; }
    if (snowy) {
      var n = 1600, pos = new Float32Array(n * 3);
      for (var i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * 60; pos[i * 3 + 1] = Math.random() * 14; pos[i * 3 + 2] = (Math.random() - 0.5) * 60; }
      var geo = new T.BufferGeometry(); geo.setAttribute("position", new T.BufferAttribute(pos, 3));
      flakes = new T.Points(geo, new T.PointsMaterial({ color: 0xffffff, size: 0.09 }));
      scene.add(flakes);
    }
  }
  // Snow falls around the car; flakes that drop below the road start again at the top.
  function updateSnow(p, dt) {
    if (!flakes) return;
    var a = flakes.geometry.attributes.position, arr = a.array;
    for (var i = 0; i < arr.length; i += 3) {
      arr[i + 1] -= dt * 1.4;
      arr[i] += Math.sin((arr[i + 1] + i) * 0.7) * dt * 0.3;
      if (arr[i + 1] < 0) arr[i + 1] += 14;
    }
    a.needsUpdate = true;
    flakes.position.set(Math.round(p.x / 60) * 60, 0, Math.round(p.y / 60) * 60);
    // keep flakes around the car: wrap each into the 60 m box centred on it
    for (var j = 0; j < arr.length; j += 3) {
      var wx = arr[j] + flakes.position.x - p.x, wz = arr[j + 2] + flakes.position.z - p.y;
      if (wx > 30) arr[j] -= 60; else if (wx < -30) arr[j] += 60;
      if (wz > 30) arr[j + 2] -= 60; else if (wz < -30) arr[j + 2] += 60;
    }
  }

  // ---------- each frame ----------
  function render(G, dt) {
    if (!renderer) init();
    if (failed) return;
    var api = window.SPEL.api;
    canvas.style.display = "";
    if (G !== lastG) { clearAll(); lastG = G; lastPieces = 0; camA = G.p.a; setWeather(G.lesson.weather); }
    var p = G.p;
    // The ground texture follows the car, centred a little ahead.
    var fx = Math.sin(p.a), fy = -Math.cos(p.a);
    var cx = p.x + fx * AHEAD, cy = p.y + fy * AHEAD;
    if (!groundAt || Math.hypot(cx - groundAt.x, cy - groundAt.y) > 28 || G.course.pieces.length !== lastPieces) {
      api.paint(gctx, cx, cy, GROUND_PX / GROUND_M, GROUND_PX);
      groundTex.needsUpdate = true;
      ground.position.set(cx, 0, cy);
      groundAt = { x: cx, y: cy };
    }
    if (G.course.pieces.length !== lastPieces) lastPieces = G.course.pieces.length;
    G.course.pieces.forEach(function (pc) {
      if (!pc.built3d && pc.s0 - p.s < 300 && p.s - (pc.s0 + (pc.len || 0)) < 150) buildPiece(api, pc);
    });
    G.course.signs.forEach(function (sg) {
      if (!sg.built3d && Math.abs(sg.s - p.s) < 220) { sg.built3d = true; signMeshes.push({ obj: buildSign(api, G, sg) }); }
    });
    G.course.feats.forEach(function (f) {
      if (f.kind === "rail" && !f.built3d && Math.abs(f.s - p.s) < 260) { f.built3d = true; railSets.push(buildRail(api, G, f)); }
    });
    updateRails(api, G);
    updateLights(api);
    updateNpcs(api, G);
    grass.position.x = p.x; grass.position.z = p.y;
    skyDome.position.set(p.x, 0, p.y); forest.position.set(p.x, 0, p.y);
    clouds.position.set(p.x * 0.85, 0, p.y * 0.85); clouds.rotation.y += dt * 0.004;
    // Driver's eye: left of the centre of the car, a little behind its middle.
    camA += api.angDiff(p.a, camA) * Math.min(1, dt * 7);
    var rx = Math.cos(p.a), ry = Math.sin(p.a);
    // A jolt over speed bumps, harder the faster the car goes.
    var bump = 0;
    G.course.feats.forEach(function (f) {
      if (f.kind !== "bump") return;
      var dd = f.s - (p.s + 0.9);
      if (Math.abs(dd) < 2.2) bump += Math.cos(dd / 2.2 * Math.PI / 2) * Math.min(0.18, p.v * 0.012);
    });
    camera.position.set(p.x - rx * 0.36 - fx * 0.2, 1.22 + bump, p.y - ry * 0.36 - fy * 0.2);
    updateSnow(p, dt);
    camera.rotation.set(-0.04, -camA, 0);
    // Steering wheel turns with how fast the car turns.
    if (prevA === null) prevA = p.a;
    var rate = dt > 0 ? api.angDiff(p.a, prevA) / dt : 0; prevA = p.a;
    var want = G.manual ? -p.steer * 7 : Math.max(-2.6, Math.min(2.6, -rate * 2.2));
    wheelA += (want - wheelA) * Math.min(1, dt * 6);
    wheel.rotation.z = wheelA;
    stalk.rotation.z = -p.blink * 0.25;
    var pc = G.course.pieceAt(p.s);
    drawCluster(Math.round(p.v * 3.6), pc.limit, p.blink, Math.floor(G.t * 2.6) % 2 === 0);
    renderMirrors(p, camA);
    renderer.render(scene, camera);
  }

  window.SPEL3D = {
    ready: function () { if (!renderer && !failed) init(); return !failed; },
    render: render,
    hide: function () { if (canvas) canvas.style.display = "none"; }
  };
})();
