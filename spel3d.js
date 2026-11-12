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
  // Looking around: the rig is the car's seat, the camera the driver's head turned by dragging the mouse.
  var rig, lookY = 0, lookP = 0, dragging = null, lookKey = 0, lookHeld = 0, NECK = 0.09, lastLook = { "-1": -99, "1": -99 };
  var mats = {}, geos = {};

  function keep(x) { x.userData.keep = true; return x; }
  function mat(color, basic) {
    var key = color + (basic ? "b" : "");
    if (!mats[key]) mats[key] = keep(basic ? new T.MeshBasicMaterial({ color: color }) : new T.MeshLambertMaterial({ color: color, flatShading: true }));
    return mats[key];
  }
  function box(w, h, d) { var k = "b" + w + "," + h + "," + d; return geos[k] || (geos[k] = keep(new T.BoxGeometry(w, h, d))); }
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
    rig = new T.Group(); scene.add(rig); rig.add(camera);
    hemi = new T.HemisphereLight(0xeaf3ff, 0x6a8a50, 1.0); scene.add(hemi);
    sun = new T.DirectionalLight(0xfff4e0, 0.85); sun.position.set(40, 80, 25); scene.add(sun);
    // Headlights: a spot from the front of the car, longer with full beam.
    beam = new T.SpotLight(0xfff2d6, 0, 70, 0.5, 0.55, 1.1); beam.position.set(0.36, -0.8, -3.5);
    beam.target.position.set(0.36, -1.2, -25); rig.add(beam); rig.add(beam.target);
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
    mouseLook();
  }
  // Hold a mouse button on the 3D view and drag to look around; the view turns back ahead on release.
  // Mouse only: on a phone the screen is the pedals and blinkers.
  function mouseLook() {
    canvas.addEventListener("pointerdown", function (e) {
      if (e.pointerType !== "mouse") return;
      dragging = { x: e.clientX, y: e.clientY, ly: lookY, lp: lookP };
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not needed */ }
      canvas.style.cursor = "grabbing"; e.preventDefault();
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      lookY = Math.max(-2.4, Math.min(2.4, dragging.ly + (e.clientX - dragging.x) * 0.005));
      lookP = Math.max(-0.5, Math.min(0.45, dragging.lp - (e.clientY - dragging.y) * 0.004));
    });
    function stop() { dragging = null; canvas.style.cursor = "grab"; }
    canvas.addEventListener("pointerup", stop); canvas.addEventListener("pointercancel", stop);
    canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    // Z and X held: a glance left or right, held longer a look over the shoulder (the blind spot).
    function lookDir(e) { var k = e.key; return k === "z" || k === "Z" ? -1 : k === "x" || k === "X" ? 1 : 0; }
    document.addEventListener("keydown", function (e) {
      var d = lookDir(e); if (!d) return;
      if (lookKey !== d) { lookKey = d; lookHeld = 0; }
      e.preventDefault();
    });
    document.addEventListener("keyup", function (e) { if (lookDir(e) === lookKey) lookKey = 0; });
    window.addEventListener("blur", function () { lookKey = 0; dragging = null; });
    if (!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches)) canvas.style.cursor = "grab";
  }

  // The inside of the red car, built to a real car's proportions around the driver's eye at (0, 0, 0),
  // forward is -z. The far edge of the bonnet sits about 11 degrees below eye level, and the top of the
  // gauges and the dashboard stay below it, so nothing inside the car hides the road. The wheel sits in
  // front of the dashboard, below the gauges, against the dashboard's lighter lower face.
  var clusterCv, clusterTex, clusterKey = "", mirrors = [], stalk, ownCar;
  function soft(c, e) { return new T.MeshLambertMaterial({ color: c, emissive: e || 0 }); }
  function buildCockpit() {
    cockpit = new T.Group(); rig.add(cockpit);
    var trim = soft(0x33373c), door = soft(0x41454b), metal = soft(0xa7adb4, 0x2a2c2e);
    cockpit.add(mesh(box(1.8, 0.12, 2.0), mat(0xe03832), 0.35, -0.68, -2.25));   // bonnet
    buildDash(metal);
    buildWheel(metal);
    buildBody(trim, door, metal);
    buildCabin();
    // Mirrors: rear-view below the top of the windscreen, one on each door. Their pictures come from cameras looking back.
    mirrors = [
      makeMirror(0.38, 0.15, -0.7, 0.4, 0.11, 34, 0x16191c, 0.6),
      makeMirror(-1.0, -0.06, -0.98, 0.22, 0.14, 40, 0x2a2e33, 0.5),
      makeMirror(1.0, -0.07, -1.12, 0.22, 0.14, 40, 0x2a2e33, -0.5)
    ];
    cockpit.add(mesh(box(0.02, 0.08, 0.02), trim, 0.38, 0.24, -0.68));
  }
  // The dashboard: a rounded panel across the whole width (dark padded top against windscreen glare,
  // a lighter lower face), the gauges in a framed housing in front of the driver, a centre stack with the
  // screen, two vents, the hazard button and the climate knobs, round vents at both ends and a glovebox.
  function buildDash(metal) {
    var top = soft(0x24272b, 0x0c0d0e), face = soft(0x7a756d, 0x1c1b19), dark = soft(0x15171a);
    var L = -0.64, R = 1.34, W = R - L, cx = 0.36;
    // Side profile drawn as (-z, y), pushed out across the width: turned a quarter about y, the shape's x
    // becomes -z and the push runs along +x.
    var pr = new T.Shape();
    pr.moveTo(1.25, -0.3); pr.lineTo(1.15, -0.27);
    pr.quadraticCurveTo(0.95, -0.235, 0.8, -0.24);
    pr.quadraticCurveTo(0.72, -0.245, 0.72, -0.3);
    pr.lineTo(0.74, -0.52); pr.lineTo(0.82, -0.72); pr.lineTo(1.25, -0.72); pr.closePath();
    var body = new T.Mesh(new T.ExtrudeGeometry(pr, { depth: W, bevelEnabled: false, curveSegments: 14 }), top);
    body.rotation.y = Math.PI / 2; body.position.x = L; cockpit.add(body);
    cockpit.add(mesh(box(W - 0.02, 0.2, 0.02), face, (L + R) / 2, -0.42, -0.722));     // lighter lower face
    cockpit.add(mesh(box(0.72, 0.014, 0.012), metal, 0.95, -0.335, -0.711));            // trim strip
    cockpit.add(mesh(box(0.46, 0.12, 0.012), soft(0x6c675f, 0x181715), 0.95, -0.44, -0.708));   // glovebox
    cockpit.add(mesh(box(0.1, 0.018, 0.02), metal, 0.95, -0.395, -0.7));
    // Gauges: a rounded, bevelled frame on a housing that rises a little above the dashboard.
    cockpit.add(mesh(box(0.44, 0.15, 0.14), top, 0, -0.255, -0.79));
    var fr = new T.Shape(), hw = 0.205, hh = 0.074, r = 0.03;
    fr.moveTo(-hw + r, -hh); fr.lineTo(hw - r, -hh); fr.quadraticCurveTo(hw, -hh, hw, -hh + r); fr.lineTo(hw, hh - r);
    fr.quadraticCurveTo(hw, hh, hw - r, hh); fr.lineTo(-hw + r, hh); fr.quadraticCurveTo(-hw, hh, -hw, hh - r);
    fr.lineTo(-hw, -hh + r); fr.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
    var hole = new T.Path(); hole.moveTo(-0.182, -0.064); hole.lineTo(0.182, -0.064); hole.lineTo(0.182, 0.064); hole.lineTo(-0.182, 0.064); hole.closePath();
    fr.holes.push(hole);
    var frame = new T.Mesh(new T.ExtrudeGeometry(fr, { depth: 0.035, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.01, bevelSegments: 3, curveSegments: 8 }), top);
    frame.position.set(0, -0.227, -0.715); frame.rotation.x = -0.25; cockpit.add(frame);
    // The cluster itself: speed, limit and blinker arrows, drawn into a canvas.
    clusterCv = document.createElement("canvas"); clusterCv.width = 512; clusterCv.height = 176;
    clusterTex = new T.CanvasTexture(clusterCv); if (T.SRGBColorSpace) clusterTex.colorSpace = T.SRGBColorSpace;
    var cl = new T.Mesh(new T.PlaneGeometry(0.36, 0.124), new T.MeshBasicMaterial({ map: clusterTex }));
    cl.position.set(0, -0.227, -0.7); cl.rotation.x = -0.25; cockpit.add(cl);
    // Centre stack: screen with a map, then two vents with the hazard button between, then the knobs.
    cockpit.add(mesh(box(0.36, 0.5, 0.1), top, cx, -0.48, -0.69));
    var sy = -0.33, sz = -0.627;
    var bez = mesh(box(0.29, 0.17, 0.02), dark, cx, sy, sz - 0.005); bez.rotation.x = -0.12; cockpit.add(bez);
    var scr = new T.Mesh(new T.PlaneGeometry(0.27, 0.15), new T.MeshBasicMaterial({ color: 0x1b3a4f }));
    scr.position.set(cx, sy, sz + 0.006); scr.rotation.x = -0.12; cockpit.add(scr);
    [[0, 0, 0.24, 0.011, 0x6b8797], [0.05, 0.035, 0.011, 0.12, 0x6b8797], [-0.08, -0.035, 0.011, 0.08, 0x4f6878]].forEach(function (q) {
      var m = new T.Mesh(new T.PlaneGeometry(q[2], q[3]), new T.MeshBasicMaterial({ color: q[4] }));
      m.position.set(cx + q[0], sy + q[1], sz + 0.008 + q[1] * 0.12); m.rotation.x = -0.12; cockpit.add(m);
    });
    var arrow = new T.Mesh(new T.CircleGeometry(0.013, 3), new T.MeshBasicMaterial({ color: 0x0cd29d }));
    arrow.position.set(cx + 0.05, sy, sz + 0.01); arrow.rotation.set(-0.12, 0, Math.PI / 2); cockpit.add(arrow);
    function vent(x, y, z, w, h) {
      cockpit.add(mesh(box(w + 0.02, h + 0.02, 0.02), metal, x, y, z));
      cockpit.add(mesh(box(w, h, 0.022), dark, x, y, z + 0.002));
      for (var k = 1; k < 4; k++) cockpit.add(mesh(box(w - 0.01, 0.006, 0.026), top, x, y - h / 2 + k * h / 4, z + 0.003));
    }
    vent(cx - 0.09, -0.46, -0.632, 0.13, 0.06); vent(cx + 0.09, -0.46, -0.632, 0.13, 0.06);
    var haz = mesh(new T.CylinderGeometry(0.018, 0.018, 0.01, 3), soft(0xd23a30, 0x401010), cx, -0.46, -0.625);
    haz.rotation.x = Math.PI / 2; cockpit.add(haz);
    [-0.1, 0, 0.1].forEach(function (dx, i) {
      var k = mesh(new T.CylinderGeometry(0.026, 0.028, 0.03, 16), i === 1 ? dark : metal, cx + dx, -0.57, -0.625);
      k.rotation.x = Math.PI / 2; cockpit.add(k);
    });
    // Round vents at both ends of the dashboard.
    [L + 0.13, R - 0.13].forEach(function (x) {
      cockpit.add(mesh(new T.TorusGeometry(0.045, 0.01, 8, 20), metal, x, -0.36, -0.708));
      cockpit.add(mesh(new T.CircleGeometry(0.045, 20), dark, x, -0.36, -0.711));
      cockpit.add(mesh(box(0.08, 0.006, 0.01), soft(0x2c2f33), x, -0.36, -0.706));
    });
  }
  // Steering wheel in black leather with silver spokes, its top just below the gauges; the blinker stalk on its left.
  function buildWheel(metal) {
    var holder = new T.Group(); holder.position.set(0, -0.45, -0.48); holder.rotation.x = -0.45; cockpit.add(holder);
    var leather = new T.MeshPhongMaterial({ color: 0x1a1c1f, specular: 0x4a4e55, shininess: 30 });
    var column = mesh(new T.CylinderGeometry(0.045, 0.06, 0.3, 14), soft(0x1b1e22), 0, 0, -0.17); column.rotation.x = Math.PI / 2; holder.add(column);
    stalk = new T.Group(); stalk.position.set(-0.06, 0, -0.09); holder.add(stalk);
    stalk.add(mesh(box(0.17, 0.016, 0.016), soft(0x2c3136), -0.085, 0, 0));
    wheel = new T.Group(); holder.add(wheel);
    wheel.add(new T.Mesh(new T.TorusGeometry(0.185, 0.028, 14, 48), leather));
    [0, Math.PI / 2, -Math.PI / 2].forEach(function (a) {
      var sp = mesh(box(0.05, 0.15, 0.022), leather, Math.sin(a) * 0.1, -Math.cos(a) * 0.1, 0); sp.rotation.z = a; wheel.add(sp);
      var inl = mesh(box(0.012, 0.13, 0.024), metal, Math.sin(a) * 0.1, -Math.cos(a) * 0.1, 0.002); inl.rotation.z = a; wheel.add(inl);
    });
    var hub = mesh(new T.CylinderGeometry(0.075, 0.08, 0.06, 20), leather); hub.rotation.x = Math.PI / 2; wheel.add(hub);
    var logo = mesh(new T.CylinderGeometry(0.02, 0.02, 0.012, 14), metal, 0, 0, 0.035); logo.rotation.x = Math.PI / 2; wheel.add(logo);
    wheel.add(mesh(box(0.05, 0.03, 0.06), soft(0xd8b27a, 0x2a2010), 0, 0.185, 0));   // stitching mark at the top
  }
  // The car's body around the cabin: front and rear doors on both sides, the pillars (the rear ones wide,
  // like a real car's blind spot), roof lining, rear window and floor, so turning the head shows a whole car.
  function buildBody(trim, door, metal) {
    var liner = soft(0xb9b3a7, 0x67635b);
    [-0.66, 1.36].forEach(function (x) {
      var s = x < 0 ? 1 : -1;   // towards the inside
      cockpit.add(mesh(box(0.08, 0.5, 1.3), door, x, -0.55, -0.35));
      cockpit.add(mesh(box(0.08, 0.5, 0.85), door, x, -0.55, 0.78));
      cockpit.add(mesh(box(0.12, 0.05, 2.25), trim, x + s * 0.03, -0.29, 0.1));          // window sill
      cockpit.add(mesh(box(0.08, 0.04, 0.5), trim, x + s * 0.07, -0.47, -0.2));          // armrest
      cockpit.add(mesh(box(0.03, 0.04, 0.16), metal, x + s * 0.05, -0.4, -0.45));       // handles
      cockpit.add(mesh(box(0.03, 0.04, 0.14), metal, x + s * 0.05, -0.4, 0.62));
      var spk = mesh(new T.CircleGeometry(0.07, 14), soft(0x1a1d21), x + s * 0.045, -0.66, -0.75);
      spk.rotation.y = s * Math.PI / 2; cockpit.add(spk);
      var a = mesh(box(0.08, 0.79, 0.1), trim, x + s * 0.04, 0.02, -0.885); a.rotation.x = 0.74; cockpit.add(a);   // windscreen pillar
      cockpit.add(mesh(box(0.1, 1.11, 0.14), trim, x + s * 0.03, -0.245, 0.42));                                  // middle pillar
      var c = mesh(box(0.1, 0.67, 0.25), trim, x + s * 0.03, 0.01, 1.1); c.rotation.x = -0.464; cockpit.add(c);   // rear pillar
      cockpit.add(mesh(box(0.08, 0.07, 1.62), trim, x + s * 0.04, 0.31, 0.19));                                   // roof rail
    });
    cockpit.add(mesh(box(2.0, 0.06, 0.08), trim, 0.35, 0.31, -0.62));      // top of the windscreen
    cockpit.add(mesh(box(2.0, 0.06, 0.08), trim, 0.35, 0.31, 0.98));       // top of the rear window
    cockpit.add(mesh(box(2.0, 0.04, 1.62), liner, 0.35, 0.35, 0.19));      // roof lining
    cockpit.add(mesh(box(0.42, 0.03, 0.2), liner, -0.15, 0.3, -0.5));      // sun visors
    cockpit.add(mesh(box(0.42, 0.03, 0.2), liner, 0.85, 0.3, -0.5));
    cockpit.add(mesh(box(1.9, 0.03, 0.45), soft(0x1d2023), 0.35, -0.21, 1.42));   // shelf under the rear window
    cockpit.add(mesh(box(2.0, 0.04, 2.6), soft(0x16181b), 0.35, -1.02, 0.25));    // floor
  }
  // Console, gear lever, armrest, front and rear seats and the instructor.
  function buildCabin() {
    var seat = mat(0x2b2f36), seatSide = mat(0x3a3f47), con = soft(0x24272b);
    cockpit.add(mesh(box(0.3, 0.3, 0.8), con, 0.36, -0.78, -0.3));                    // centre console
    cockpit.add(mesh(box(0.22, 0.02, 0.5), soft(0x15181b), 0.36, -0.625, -0.25));
    var lever = mesh(cyl(0.012, 0.015, 0.18, 6), soft(0x8c9198), 0.36, -0.53, -0.32); lever.rotation.x = 0.2; cockpit.add(lever);
    cockpit.add(mesh(new T.SphereGeometry(0.04, 12, 10), soft(0x1b1e22), 0.36, -0.44, -0.34));
    cockpit.add(mesh(box(0.28, 0.1, 0.4), soft(0x2b2f36), 0.36, -0.58, 0.2));           // armrest
    // Rear bench: cushion, back and three head rests.
    var rc = mesh(new T.CapsuleGeometry(0.1, 1.05, 4, 10), seat, 0.35, -0.84, 0.92); rc.rotation.z = Math.PI / 2; rc.scale.set(1.3, 1, 2.6); cockpit.add(rc);
    var rb = mesh(box(1.25, 0.62, 0.14), seat, 0.35, -0.47, 1.22); rb.rotation.x = 0.18; cockpit.add(rb);
    [-0.12, 0.35, 0.82].forEach(function (x) {
      var hr = mesh(new T.CapsuleGeometry(0.06, 0.12, 4, 10), seatSide, x, -0.07, 1.29); hr.rotation.z = Math.PI / 2; hr.scale.z = 0.7; cockpit.add(hr);
    });
    // Seats: the driver's back behind the camera, the passenger's with the instructor in it.
    [0, 0.72].forEach(function (x) {
      var cush = mesh(new T.CapsuleGeometry(0.1, 0.32, 4, 10), seat, x, -0.86, 0.05); cockpit.add(cush); cush.rotation.z = Math.PI / 2; cush.scale.set(1.3, 1, 2.5);
      var back = mesh(new T.CapsuleGeometry(0.12, 0.5, 4, 10), seat, x, -0.45, 0.38); back.rotation.x = 0.18; back.scale.set(2.0, 1, 0.6); cockpit.add(back);
      var rest = mesh(new T.CapsuleGeometry(0.07, 0.12, 4, 10), seatSide, x, 0.02, 0.45); rest.rotation.z = Math.PI / 2; rest.scale.z = 0.7; cockpit.add(rest);
    });
    // The instructor: rounded shapes, leaning into the seat, head turned a little towards the driver.
    var shirt = soft(0x2d5d8a), skin = soft(0xe0b08a), trousers = soft(0x30343c);
    var t = new T.Group(); t.position.set(0.72, 0, 0.12); cockpit.add(t);
    var body = mesh(new T.CapsuleGeometry(0.16, 0.3, 6, 14), shirt, 0, -0.5, 0.14); body.rotation.x = 0.12; body.scale.z = 0.7; t.add(body);
    t.add(mesh(new T.CylinderGeometry(0.045, 0.05, 0.1, 10), skin, 0, -0.2, 0.12));
    var head = new T.Group(); head.position.set(0, -0.08, 0.1); head.rotation.y = 0.4; t.add(head);
    head.add(mesh(new T.SphereGeometry(0.095, 18, 14), skin, 0, 0, 0));
    var hair = mesh(new T.SphereGeometry(0.1, 18, 14), soft(0x5a3d26), 0, 0.025, 0.025); hair.scale.y = 0.95; head.add(hair);
    [-0.033, 0.033].forEach(function (x) { head.add(mesh(new T.SphereGeometry(0.011, 8, 6), mat(0x222222), x, 0.005, -0.088)); });   // eyes
    head.add(mesh(new T.SphereGeometry(0.016, 8, 6), skin, 0, -0.025, -0.095));                                                   // nose
    [-1, 1].forEach(function (sd) {
      var up = mesh(new T.CapsuleGeometry(0.045, 0.22, 4, 10), shirt, sd * 0.2, -0.47, 0.13); up.rotation.z = sd * 0.08; t.add(up);
      var fore = mesh(new T.CapsuleGeometry(0.04, 0.2, 4, 10), shirt, sd * 0.15, -0.66, 0.0); fore.rotation.x = Math.PI / 2 - 0.25; t.add(fore);
      t.add(mesh(new T.SphereGeometry(0.04, 10, 8), skin, sd * 0.12, -0.69, -0.13));                           // hand
      var thigh = mesh(new T.CapsuleGeometry(0.07, 0.3, 4, 10), trousers, sd * 0.09, -0.76, -0.08); thigh.rotation.x = Math.PI / 2; t.add(thigh);
      t.add(mesh(new T.CapsuleGeometry(0.06, 0.3, 4, 10), trousers, sd * 0.09, -0.95, -0.3));                 // shin
    });
    var clip = mesh(box(0.16, 0.012, 0.22), mat(0xf2f2f2), 0, -0.68, -0.18); clip.rotation.x = -0.5; t.add(clip);   // clipboard
  }
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
  var gearR = false;
  function drawCluster(kmh, limit, blink, on, high) {
    var key = kmh + "|" + limit + "|" + blink + "|" + on + "|" + high + "|" + gearR;
    if (key === clusterKey) return;
    clusterKey = key;
    var x = clusterCv.getContext("2d"), W = 512, H = 176;
    x.fillStyle = "#07090c"; x.fillRect(0, 0, W, H);
    // Speed dial on the left, 0 to 160.
    var cx = 120, cy = 104, R = 78;
    x.lineWidth = 6; x.strokeStyle = "#2b3238"; x.beginPath(); x.arc(cx, cy, R, Math.PI * 0.8, Math.PI * 2.2); x.stroke();
    x.strokeStyle = kmh > limit + 5 ? "#ff5a4f" : kmh > limit ? "#ffc96b" : "#0cd29d"; x.beginPath(); x.arc(cx, cy, R, Math.PI * 0.8, Math.PI * (0.8 + 1.4 * Math.min(kmh, 160) / 160)); x.stroke();
    x.fillStyle = "#8a9299"; x.font = "600 15px system-ui, sans-serif"; x.textAlign = "center"; x.textBaseline = "middle";
    for (var v = 0; v <= 160; v += 40) { var aa = Math.PI * (0.8 + 1.4 * v / 160); x.fillText(String(v), cx + Math.cos(aa) * (R - 22), cy + Math.sin(aa) * (R - 22)); }
    var na = Math.PI * (0.8 + 1.4 * Math.min(kmh, 160) / 160);
    x.strokeStyle = "#ff5a3c"; x.lineWidth = 4; x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + Math.cos(na) * (R - 8), cy + Math.sin(na) * (R - 8)); x.stroke();
    // Speed in figures in the middle; red when over the limit.
    x.fillStyle = kmh > limit + 5 ? "#ff5a4f" : kmh > limit ? "#ffc96b" : "#f2f4f5"; x.font = "800 64px system-ui, sans-serif"; x.fillText(String(Math.abs(kmh)), 300, 92);
    if (gearR) { x.fillStyle = "#ffc040"; x.font = "800 26px system-ui, sans-serif"; x.fillText("R", 214, 126); }
    x.fillStyle = "#8a9299"; x.font = "600 17px system-ui, sans-serif"; x.fillText("km/h", 300, 136);
    // The speed limit, as the car's sign reading shows it.
    x.fillStyle = "#fff"; x.beginPath(); x.arc(440, 92, 40, 0, 7); x.fill();
    x.fillStyle = "#e03832"; x.beginPath(); x.arc(440, 92, 38, 0, 7); x.fill();
    x.fillStyle = "#f8c628"; x.beginPath(); x.arc(440, 92, 28, 0, 7); x.fill();
    x.fillStyle = "#111"; x.font = "800 " + (limit >= 100 ? 24 : 30) + "px system-ui, sans-serif"; x.fillText(String(limit), 440, 94);
    // Full beam lamp, blue.
    if (high) { x.fillStyle = "#3f8cff"; x.font = "800 22px system-ui, sans-serif"; x.fillText("≡D", 300, 26); }
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

  function drop(o) {
    scene.remove(o);
    o.traverse(function (m) {
      if (m.geometry && !m.geometry.userData.keep) m.geometry.dispose();
      (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []).forEach(function (x) { if (!x.userData.keep) x.dispose(); });
    });
  }
  // On a long drive, what lies far behind is dropped every couple of seconds.
  var tidyT = 0;
  function tidy(G) {
    var p = G.p, far = function (o) { return Math.hypot(o.position.x - p.x, o.position.z - p.y) > 450; };
    objs = objs.filter(function (o) { if (far(o)) { drop(o); return false; } return true; });
    signMeshes = signMeshes.filter(function (m) { if (far(m.obj)) { drop(m.obj); return false; } return true; });
    lightSets = lightSets.filter(function (l) { if (far(l.groups[0])) { l.groups.forEach(drop); return false; } return true; });
    railSets = railSets.filter(function (r) { return r.f.s > p.s - 450; });
  }
  // ---------- the real map: every street and house out to 500 m ----------
  // Streets are flat ribbons just under the painted ground, so they show past its edge; houses are
  // the map's own outlines raised to walls and a roof, merged into one mesh per 120 m square.
  var treeParts = null, MAP_R = 500, TILE = 120, mapRoads = null, mapAt = null, mapTiles = {}, mapT = -9, mapMat = null;
  function ribbon(pos, pts, w, y) {
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy);
      if (l < 0.05) continue;
      var ux = dx / l, uy = dy / l, e = w * 0.3, nx = -uy * w / 2, ny = ux * w / 2;
      var ax = a.x - ux * e, ay = a.y - uy * e, bx = b.x + ux * e, by = b.y + uy * e;
      pos.push(ax + nx, y, ay + ny, bx + nx, y, by + ny, bx - nx, y, by - ny, ax + nx, y, ay + ny, bx - nx, y, by - ny, ax - nx, y, ay - ny);
    }
  }
  function flatMesh(pos, color) {
    var g = new T.BufferGeometry(), nrm = [];
    for (var i = 0; i < pos.length; i += 3) nrm.push(0, 1, 0);
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3)); g.setAttribute("normal", new T.Float32BufferAttribute(nrm, 3));
    return new T.Mesh(g, new T.MeshLambertMaterial({ color: color, side: T.DoubleSide }));
  }
  var mapPieces = 0, G3 = null;
  function buildMapRoads(api, A, p) {
    if (mapRoads) mapRoads.forEach(drop);
    var walk = [], asph = [], r = MAP_R + 150, drv = {};
    G3.course.pieces.forEach(function (pc) { (pc.st.edges || []).forEach(function (i) { drv[i] = true; }); });
    mapPieces = G3.course.pieces.length;
    A.edges.concat(A.lines || []).forEach(function (e) {
      if (e.i != null && drv[e.i]) return;
      var P = e.dpts || e.pts;   // as the map has it: a roundabout's ring, and the roads ending at it
      if (!P.some(function (q) { return Math.abs(q.x - p.x) < r && Math.abs(q.y - p.y) < r; })) return;
      var w = api.roadWidth(e);
      ribbon(walk, P, w + api.walkWidth(e), -0.07); ribbon(asph, P, w, -0.035);
    });
    mapRoads = [flatMesh(walk, api.COL.walk), flatMesh(asph, api.COL.asph)];
    mapRoads.forEach(function (m) { scene.add(m); });
    mapAt = { x: p.x, y: p.y };
  }
  function buildTile(api, A, tx, ty) {
    var pos = [], nrm = [], col = [], hidden = 0, COL = api.COL;
    var hs = api.housesNear(A, tx * TILE + TILE / 2, ty * TILE + TILE / 2, TILE / 2, true).filter(function (h) {
      return Math.floor(h.cx / TILE) === tx && Math.floor(h.cy / TILE) === ty;
    });
    hs.forEach(function (h) {
      if (h.hide) { hidden++; return; }
      var P = h.pts, n = P.length, area = 0, i;
      for (i = 0; i < n; i++) { var a = P[i], b = P[(i + 1) % n]; area += a.x * b.y - b.x * a.y; }
      var H = h.h || 5.5 + (h.id % 5) * 0.9, sgn = area > 0 ? 1 : -1;
      var wc = new T.Color(COL.houses[h.id % COL.houses.length]), rc = new T.Color(COL.roofs[Math.floor(h.id / 7) % COL.roofs.length]);
      for (i = 0; i < n; i++) {
        var A0 = P[i], B0 = P[(i + 1) % n], dx = B0.x - A0.x, dy = B0.y - A0.y, l = Math.hypot(dx, dy) || 1;
        var nx = dy / l * sgn, nz = -dx / l * sgn;
        pos.push(A0.x, 0, A0.y, B0.x, 0, B0.y, B0.x, H, B0.y, A0.x, 0, A0.y, B0.x, H, B0.y, A0.x, H, A0.y);
        for (var k = 0; k < 6; k++) { nrm.push(nx, 0, nz); col.push(wc.r, wc.g, wc.b); }
      }
      var big = Math.abs(area) / 2;
      if (big < 350) {
        // A villa: a pitched roof rising from every wall to a point above the middle.
        var cx = 0, cz = 0;
        P.forEach(function (q) { cx += q.x; cz += q.y; }); cx /= n; cz /= n;
        var top = H + Math.min(3.6, 0.32 * Math.sqrt(big));
        for (i = 0; i < n; i++) {
          var a1 = P[i], b1 = P[(i + 1) % n];
          var ux = b1.x - a1.x, uz = b1.y - a1.y, vx = cx - a1.x, vy = top - H, vz = cz - a1.y;
          var fx = -(uz * vy), fy = uz * vx - ux * vz, fz = ux * vy, fl = Math.hypot(fx, fy, fz) || 1;
          if (fy < 0) { fx = -fx; fy = -fy; fz = -fz; }
          pos.push(a1.x, H, a1.y, b1.x, H, b1.y, cx, top, cz);
          for (var k2 = 0; k2 < 3; k2++) { nrm.push(fx / fl, fy / fl, fz / fl); col.push(rc.r, rc.g, rc.b); }
        }
      } else {
        var tris = T.ShapeUtils.triangulateShape(P.map(function (q) { return new T.Vector2(q.x, q.y); }), []);
        tris.forEach(function (t) {
          t.forEach(function (ix) { pos.push(P[ix].x, H, P[ix].y); nrm.push(0, 1, 0); col.push(rc.r, rc.g, rc.b); });
        });
      }
    });
    // Garden trees: a trunk and a rough crown, put into the same mesh.
    var tr = api.treesNear(A, tx * TILE + TILE / 2, ty * TILE + TILE / 2, TILE / 2).filter(function (t) {
      return Math.floor(t.x / TILE) === tx && Math.floor(t.y / TILE) === ty;
    });
    if (!treeParts) treeParts = { crown: new T.IcosahedronGeometry(1, 0).toNonIndexed(), trunk: new T.CylinderGeometry(0.15, 0.22, 1.6, 5).toNonIndexed(),
      spruce: new T.ConeGeometry(1, 1, 6, 1, true).toNonIndexed() };
    var greens = [0x3f6e30, 0x4d7a35, 0x5a8a3a, 0x46733a, 0x2f5a34], brown = new T.Color(0x6b4a2f);
    tr.forEach(function (t) {
      if (t.hide) { hidden++; return; }
      var gc = new T.Color(greens[t.id % greens.length]);
      var parts = t.sp ? [[treeParts.spruce, t.r * 0.9, t.r * 4, t.r * 2 + 0.6, new T.Color(0x2c5532)]] : [[treeParts.trunk, 1, 1, 0.8, brown], [treeParts.crown, t.r * 0.85, t.r * 1.05, 1.4 + t.r * 0.8, gc]];
      parts.forEach(function (part) {
        var P2 = part[0].attributes.position.array, N2 = part[0].attributes.normal.array;
        for (var i = 0; i < P2.length; i += 3) {
          pos.push(t.x + P2[i] * part[1], P2[i + 1] * part[2] + part[3], t.y + P2[i + 2] * part[1]);
          nrm.push(N2[i], N2[i + 1], N2[i + 2]); col.push(part[4].r, part[4].g, part[4].b);
        }
      });
    });
    if (!mapMat) mapMat = keep(new T.MeshLambertMaterial({ vertexColors: true, side: T.DoubleSide }));
    var g = new T.BufferGeometry();
    g.setAttribute("position", new T.Float32BufferAttribute(pos, 3)); g.setAttribute("normal", new T.Float32BufferAttribute(nrm, 3));
    g.setAttribute("color", new T.Float32BufferAttribute(col, 3));
    var m = new T.Mesh(g, mapMat); scene.add(m);
    return { mesh: m, hidden: hidden, hs: hs.concat(tr) };
  }
  function updateMap(api, G) {
    var A = api.mapArea(), p = G.p;
    if (!A) return;
    if (G.t - mapT < 0.5 && G.t >= mapT) return;
    mapT = G.t;
    G3 = G;
    if (!mapAt || Math.hypot(p.x - mapAt.x, p.y - mapAt.y) > 150 || G.course.pieces.length !== mapPieces) buildMapRoads(api, A, p);
    var t0x = Math.floor((p.x - MAP_R) / TILE), t1x = Math.floor((p.x + MAP_R) / TILE), t0y = Math.floor((p.y - MAP_R) / TILE), t1y = Math.floor((p.y + MAP_R) / TILE);
    for (var tx = t0x; tx <= t1x; tx++) for (var ty = t0y; ty <= t1y; ty++) {
      var cx = (tx + 0.5) * TILE, cy = (ty + 0.5) * TILE;
      if (Math.hypot(cx - p.x, cy - p.y) > MAP_R + TILE * 0.7) continue;
      var k = tx + "," + ty, tl = mapTiles[k];
      if (tl && tl.hs.filter(function (h) { return h.hide; }).length === tl.hidden) continue;
      if (tl) drop(tl.mesh);
      mapTiles[k] = buildTile(api, A, tx, ty);
    }
    Object.keys(mapTiles).forEach(function (k) {
      var xy = k.split(",").map(Number);
      if (Math.hypot((xy[0] + 0.5) * TILE - p.x, (xy[1] + 0.5) * TILE - p.y) > MAP_R + TILE * 2) { drop(mapTiles[k].mesh); delete mapTiles[k]; }
    });
  }
  function clearMap() {
    if (mapRoads) mapRoads.forEach(drop);
    Object.keys(mapTiles).forEach(function (k) { drop(mapTiles[k].mesh); });
    mapRoads = null; mapAt = null; mapTiles = {}; mapT = -9;
  }
  function clearAll() {
    clearMap();
    objs.forEach(drop);
    Object.keys(npcMeshes).forEach(function (k) { drop(npcMeshes[k]); });
    signMeshes.forEach(function (o) { drop(o.obj); });
    lightSets.forEach(function (o) { o.groups.forEach(drop); });
    objs = []; npcMeshes = {}; signMeshes = []; lightSets = []; railSets = []; groundAt = null; prevA = null;
  }

  // ---------- things along the road ----------
  function place(o, x, y, a) { o.position.x = x; o.position.z = y; o.rotation.y = -a; scene.add(o); objs.push(o); return o; }
  function tree(x, y, r) {
    var g = new T.Group();
    g.add(mesh(new T.CylinderGeometry(0.15, 0.22, 1.6, 5), mat(0x6b4a2f), 0, 0.8, 0));
    if (!shadowMat) shadowMat = keep(new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
    var sh = new T.Mesh(new T.CircleGeometry(r * 0.9, 8), shadowMat); sh.rotation.x = -Math.PI / 2; sh.position.set(0.4, 0.03, 0.4); g.add(sh);
    if (Math.random() < 0.4) {
      // A spruce: three stacked cones, white tips in winter.
      var dark = snowy ? 0x3d5a46 : 0x2f5a34;
      for (var k = 0; k < 3; k++) {
        var cr = r * (1.05 - k * 0.28), ch = r * 1.3;
        g.add(mesh(new T.CylinderGeometry(0.01, cr, ch, 7), mat(k === 2 && snowy ? 0xf2f5f7 : dark), 0, 1.2 + k * r * 0.75 + ch / 2, 0));   // own shape: sizes vary
      }
      return place(g, x, y, Math.random() * 6);
    }
    var tone = [0x3f6e30, 0x4d7a35, 0x5a8a3a, 0x46733a][Math.floor(Math.random() * 4)];
    var top = mesh(new T.IcosahedronGeometry(r, 0), mat(snowy ? 0x4a6650 : tone), 0, 1.4 + r * 0.8, 0);
    if (snowy) { var cap = mesh(new T.IcosahedronGeometry(r * 0.75, 0), mat(0xf2f5f7), 0, 1.4 + r * 1.35, 0); cap.scale.y = 0.6; g.add(cap); }
    top.scale.y = 1.25; g.add(top);
    if (!snowy) {   // a second, smaller crown so the tree is less round
      var top2 = mesh(new T.IcosahedronGeometry(r * 0.6, 0), mat(tone), r * 0.45, 1.6 + r * 1.2, -r * 0.2);
      top2.scale.y = 1.2; g.add(top2);
    }
    return place(g, x, y, Math.random() * 6);
  }
  function house(api, pc, d, rnd) {
    var c = pc.at(d.u + d.dep / 2, d.w + d.len / 2);
    var hgt = d.h || 5 + rnd * 5, g = new T.Group();
    // A unit box stretched to size: houses vary, and one shared shape keeps memory flat on a long drive.
    var walls = mesh(box(1, 1, 1), mat(d.c), 0, hgt / 2, 0); walls.scale.set(d.dep, hgt, d.len); g.add(walls);
    var roof = mesh(new T.ConeGeometry(Math.SQRT1_2, 1, 4), mat(d.roof), 0, hgt + 1.1, 0);
    roof.rotation.y = Math.PI / 4; roof.scale.set(d.dep, 2.2, d.len); g.add(roof);
    // Windows with white frames on the road side; some are lit after dark.
    var side = d.u > 0 ? -1 : 1, win = mat(0x34404e), lit = mat(0xffd98a, true), frame = mat(0xeeeae0), fx = side * (d.dep / 2 + 0.02);
    function addWin(y, z) {
      g.add(mesh(box(0.04, 1.3, 1.5), frame, fx, y, z));
      g.add(mesh(box(0.05, 1.1, 1.3), night && Math.random() < 0.45 ? lit : win, fx + side * 0.02, y, z));
    }
    var doorAt = Math.round((rnd - 0.5) * (d.len - 4) / 3.2) * 3.2;
    for (var k = -d.len / 2 + 2; k < d.len / 2 - 1.5; k += 3.2) {
      if (Math.abs(k - doorAt) < 1.6 && d.len > 6) {
        g.add(mesh(box(0.06, 2.1, 1.1), mat(0x5a3a26), fx + side * 0.02, 1.05, k));   // door
        g.add(mesh(box(0.5, 0.12, 1.5), mat(0x9a9590), fx + side * 0.25, 0.06, k));   // step
      } else addWin(1.8, k);
      if (hgt > 6) addWin(hgt * 0.72, k);
    }
    // Plinth and a chimney.
    var plinth = mesh(box(1, 1, 1), mat(0x77736e), 0, 0.25, 0); plinth.scale.set(d.dep + 0.1, 0.5, d.len + 0.1); g.add(plinth);
    g.add(mesh(box(0.7, 2.2, 0.7), mat(0x8a4b3a), d.dep * 0.18, hgt + 1.6, d.len * 0.25));
    return place(g, c.x, c.y, c.a);
  }
  function buildPiece(api, pc) {
    pc.built3d = true;
    var n = 0;
    (pc.decor || []).forEach(function (d) {
      n++;
      if (d.gone) return;
      if (d.t === "house") d.obj = house(api, pc, d, (n * 0.37) % 1);
      else if (d.t === "tree") { var q = pc.at(d.u, d.w); tree(q.x, q.y, d.r * 0.8); }
    });
    if (pc.kind === "round" && !(pc.st.real && pc.st.turn)) {   // a turning area has no island
      tree(pc.C.x, pc.C.y, 2.4);
      // A big real roundabout's island gets a ring of trees too, so it does not look bare.
      var isl = pc.g ? pc.g.island : 0, nt = Math.floor(isl / 3.5);
      for (var ti = 0; isl > 9 && ti < nt; ti++) {
        var ta = ti / nt * Math.PI * 2 + 0.4, tr = isl * 0.6;
        tree(pc.C.x + Math.cos(ta) * tr, pc.C.y + Math.sin(ta) * tr, 1.6 + (ti % 3) * 0.4);
      }
    }
    if (pc.kind === "road" || pc.kind === "mv") roadside(api, pc);
    if (pc.light) buildLights(api, pc);
  }

  function cyl(r1, r2, h, n) { var k = "c" + r1 + "," + r2 + "," + h + "," + n; return geos[k] || (geos[k] = keep(new T.CylinderGeometry(r1, r2, h, n))); }
  // Street furniture along a piece: lamps in town, white edge posts on country roads,
  // the guard rail between the motorway's carriageways, a shelter at a bus stop.
  function roadside(api, pc) {
    var L = pc.len, st = pc.st, at = function (u, w) { return pc.at(u, w); };
    // Bridges: a concrete edge and a railing along both sides, in 3 m lengths that follow the bends.
    (st.bridges || []).forEach(function (b) {
      var walk = pc.env === "stad" && !st.noWalk, pr = pc.parking ? 2.5 : 0, er = st.eR != null ? st.eR : 1.75, el = st.eL != null ? st.eL : -5.25;
      var edges = walk ? [el - 2.6 - 0.35, er + pr + 2.6 + 0.35] : [el - 0.75, er + pr + 0.75];
      edges.forEach(function (u) {
        for (var w = b[0]; w < b[1] - 0.5; w += 3) {
          var seg = Math.min(3, b[1] - w), q = at(u, w + seg / 2), r = new T.Group();
          r.add(mesh(box(0.4, 0.35, seg + 0.05), mat(0xa19f97), 0, 0.17, 0));
          r.add(mesh(box(0.08, 0.08, seg + 0.05), mat(0x5a6068), 0, 1.05, 0));
          r.add(mesh(box(0.06, 0.06, seg + 0.05), mat(0x5a6068), 0, 0.65, 0));
          r.add(mesh(box(0.1, 0.75, 0.1), mat(0x4a5058), 0, 0.7, 0));
          place(r, q.x, q.y, q.a);
        }
      });
    });
    if (pc.kind === "mv") {
      var c = at(-8.4, L / 2), rail = new T.Group();
      rail.add(mesh(new T.BoxGeometry(0.1, 0.32, L), mat(0xc9c9c4), 0, 0.6, 0));
      for (var k = -L / 2 + 2; k < L / 2; k += 4) rail.add(mesh(box(0.12, 0.6, 0.12), mat(0x8a8e94), 0, 0.3, k));
      place(rail, c.x, c.y, c.a);
      return;
    }
    if (pc.env === "stad") {
      var edge = (st.eR != null ? st.eR : 1.75) + (pc.parking ? 2.5 : 0) + 0.5;
      for (var w = 12; w < L - 8; w += 32) {
        var q = at(edge, w), lamp = new T.Group();
        lamp.add(mesh(cyl(0.06, 0.08, 6, 6), mat(0x55595e), 0, 3, 0));
        lamp.add(mesh(box(1.4, 0.08, 0.08), mat(0x55595e), -0.7, 5.95, 0));
        lamp.add(mesh(box(0.5, 0.12, 0.25), mat(0x3a3f45), -1.35, 5.88, 0));
        lamp.add(mesh(box(0.42, 0.03, 0.18), mat(0xfff3c4, true), -1.35, 5.81, 0));
        place(lamp, q.x, q.y, q.a);
      }
    } else {
      // Kantstolpar: white posts with a black band, about every 50 m on both sides.
      for (var w2 = 25; w2 < L; w2 += 50) {
        if ((st.bridges || []).some(function (b) { return w2 > b[0] - 3 && w2 < b[1] + 3; })) continue;   // the railing is there
        [[2.7, 0], [-6.2, Math.PI]].forEach(function (o) {
          var q2 = at(o[0], w2), post = new T.Group();
          post.add(mesh(box(0.12, 1.0, 0.12), mat(0xeceef0), 0, 0.5, 0));
          post.add(mesh(box(0.13, 0.18, 0.13), mat(0x1c1c1c), 0, 0.85, 0));
          post.add(mesh(box(0.05, 0.08, 0.02), mat(0xffa61e, true), 0, 0.72, 0.07));
          place(post, q2.x, q2.y, q2.a + o[1]);
        });
      }
    }
    (st.props || []).concat(st.camera ? [{ s: st.camera.s, u: 4.6, kind: "camera" }] : []).forEach(function (pr) {
      var qp = at(pr.u, pr.s), o = new T.Group();
      if (pr.kind === "triangle") {
        var tri = new T.Mesh(new T.CircleGeometry(0.42, 3), mat(0xe03832)); tri.rotation.z = Math.PI / 2; tri.position.y = 0.4; o.add(tri);
        var inner = new T.Mesh(new T.CircleGeometry(0.24, 3), mat(0xf2f2f2)); inner.rotation.z = Math.PI / 2; inner.position.set(0, 0.4, 0.01); o.add(inner);
      } else {
        o.add(mesh(cyl(0.08, 0.1, 3.2, 6), mat(0x55595e), 0, 1.6, 0));
        o.add(mesh(box(0.55, 0.5, 0.7), mat(0xc9c9c4), 0, 3.3, 0));
        o.add(mesh(box(0.25, 0.25, 0.05), mat(0x15181c), 0, 3.3, 0.36));
      }
      place(o, qp.x, qp.y, qp.a);
    });
    if (st.works) {
      for (var cw = st.works.s; cw <= st.works.s + st.works.len; cw += 4) {
        var qc = at(-1.45, cw), cone = new T.Group();
        cone.add(mesh(cyl(0.02, 0.22, 0.7, 8), mat(0xff7a1a), 0, 0.35, 0));
        cone.add(mesh(cyl(0.11, 0.15, 0.12, 8), mat(0xffffff), 0, 0.38, 0));
        place(cone, qc.x, qc.y, 0);
      }
      var qb = at(0.2, st.works.s), bar = new T.Group();
      for (var k = 0; k < 6; k++) bar.add(mesh(box(0.55, 0.3, 0.06), mat(k % 2 ? 0x111111 : 0xf8c628), -1.4 + k * 0.55, 0.9, 0));
      [-1.5, 1.4].forEach(function (x) { bar.add(mesh(box(0.06, 0.9, 0.06), mat(0xeceef0), x, 0.45, 0)); });
      place(bar, qb.x, qb.y, qb.a);
      var qd = at(0.3, st.works.s + st.works.len / 2), dig = new T.Group();
      dig.add(mesh(box(1.6, 1.0, 3.0), mat(0xf2b31b), 0, 0.9, 0));
      dig.add(mesh(box(1.2, 1.0, 1.2), mat(0x303a4a), 0, 1.9, 0.6));
      dig.add(mesh(box(0.25, 0.25, 2.6), mat(0xf2b31b), 0, 2.2, -1.6));
      place(dig, qd.x, qd.y, qd.a + 0.3);
    }
    if (st.bus) {
      var b = at(7.2, st.bus.s), shelter = new T.Group();
      shelter.add(mesh(box(1.6, 0.1, 4.2), mat(0x3a3f45), 0, 2.4, 0));
      shelter.add(mesh(box(0.06, 2.3, 4.0), new T.MeshLambertMaterial({ color: 0x9fc3d6, transparent: true, opacity: 0.45 }), 0.75, 1.2, 0));
      [-1.95, 1.95].forEach(function (z) { shelter.add(mesh(box(1.5, 2.3, 0.06), new T.MeshLambertMaterial({ color: 0x9fc3d6, transparent: true, opacity: 0.45 }), 0, 1.2, z)); });
      shelter.add(mesh(box(0.5, 0.45, 2.6), mat(0x6b4a2f), 0.35, 0.45, 0));
      place(shelter, b.x, b.y, b.a);
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
    var pose = sg.pos || G.course.poseAt(sg.s), q = sg.pos || api.toG(pose, sg.u, 0), g = new T.Group();
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
  // ---------- people, cyclists and animals ----------
  // Built from rounded parts; arms and legs hang from pivots so they can swing when walking or
  // running, and a cyclist's legs follow the pedals. Every figure faces -z, like the cars.
  var UP = new T.Vector3(0, 1, 0), tubeGeos = {}, tv = new T.Vector3();
  function V(x, y, z) { return new T.Vector3(x, y, z); }
  function capsule(r, len) { var k = "cap" + r + "," + len; return geos[k] || (geos[k] = keep(new T.CapsuleGeometry(r, len, 4, 10))); }
  function ball(r) { var k = "ball" + r; return geos[k] || (geos[k] = keep(new T.SphereGeometry(r, 14, 10))); }
  // A round rod from a to b (a unit cylinder stretched and turned).
  function tube(a, b, r, m) {
    var o = new T.Mesh(tubeGeos[r] || (tubeGeos[r] = keep(new T.CylinderGeometry(r, r, 1, 8))), m);
    setTube(o, a, b); return o;
  }
  function setTube(o, a, b) {
    tv.subVectors(b, a); var len = tv.length() || 0.001;
    o.position.copy(a).addScaledVector(tv, 0.5); o.scale.set(1, len, 1);
    o.quaternion.setFromUnitVectors(UP, tv.divideScalar(len));
  }
  // A limb hanging down from a pivot: parts are [radius, length, material], stacked downwards.
  function limb(parent, x, y, z, parts) {
    var piv = new T.Group(), yy = 0; piv.position.set(x, y, z); parent.add(piv);
    parts.forEach(function (q) { var m = new T.Mesh(capsule(q[0], q[1]), q[2]); m.position.y = yy - q[1] / 2; piv.add(m); yy -= q[1]; });
    return piv;
  }
  var SKIN = [0xe8c39e, 0xd9a77e, 0xb07a52, 0x8d5a3b, 0xf1d2b3], HAIR = [0x2a1d14, 0x5a3d26, 0xc9a35a, 0x1a1a1a, 0x8a5a3a, 0xb8b8b8],
    LEGS = [0x2b3a55, 0x333840, 0x5a4a3a, 0x1d1f24, 0x6b6f76, 0x3a4a3a];
  function pick(list, id, k) { return list[(id * 7 + (k || 0)) % list.length]; }
  // A standing person about 1.75 m tall (scaled for a child), arms and legs on pivots.
  function person(o) {
    var g = new T.Group(), sh = soft(o.shirt), tr = soft(o.trousers), sk = soft(o.skin), shoe = soft(0x222428);
    var legs = [-1, 1].map(function (sd) {
      var l = limb(g, sd * 0.1, 0.92, 0, [[0.075, 0.42, tr], [0.065, 0.36, tr]]);
      l.add(mesh(box(0.11, 0.08, 0.25), shoe, 0, -0.86, -0.05));
      return l;
    });
    var pelvis = mesh(capsule(0.12, 0.14), tr, 0, 0.95, 0); pelvis.rotation.z = Math.PI / 2; pelvis.scale.z = 0.75; g.add(pelvis);
    var torso = mesh(capsule(0.16, 0.3), sh, 0, 1.22, 0); torso.scale.set(1.12, 1, 0.68); g.add(torso);
    g.add(mesh(cyl(0.05, 0.055, 0.1, 10), sk, 0, 1.57, 0));
    var head = mesh(ball(0.105), sk, 0, 1.69, 0); head.scale.y = 1.1; g.add(head);
    if (o.hair != null) { var hair = mesh(ball(0.11), soft(o.hair), 0, 1.72, 0.02); hair.scale.set(1, 0.85, 1); g.add(hair); }
    [-0.037, 0.037].forEach(function (x) { g.add(mesh(ball(0.012), mat(0x1a1a1a), x, 1.7, -0.1)); });
    var arms = [-1, 1].map(function (sd) {
      var a = limb(g, sd * 0.205, 1.47, 0, [[0.052, 0.28, sh], [0.046, 0.25, sh]]);
      a.add(mesh(ball(0.045), sk, 0, -0.58, 0)); a.rotation.z = sd * 0.07;
      return a;
    });
    if (o.scale) g.scale.setScalar(o.scale);
    g.userData.legs = legs; g.userData.arms = arms; g.userData.stride = 4.5 / (o.scale || 1); g.userData.swing = 0.5; g.userData.bob = true;
    return g;
  }
  // A bicycle with its rider: diamond frame, tyres, bars and saddle; the rider leans forward and pedals.
  function cyclist(n, col) {
    var g = new T.Group(), frame = soft(pick([0x1f6fb2, 0xc0392b, 0x2e8b57, 0x222222, 0xd0d4d8], n.id)), dark = soft(0x1c1c1c), metal = soft(0xa7adb4);
    [0.52, -0.52].forEach(function (z) {
      var t = mesh(new T.TorusGeometry(0.31, 0.035, 8, 24), dark, 0, 0.34, z); t.rotation.y = Math.PI / 2; g.add(t);
      [0, Math.PI / 2].forEach(function (a) { var sp = mesh(box(0.01, 0.6, 0.012), metal, 0, 0.34, z); sp.rotation.x = a; g.add(sp); });
    });
    var rear = V(0, 0.34, 0.52), front = V(0, 0.34, -0.52), bb = V(0, 0.3, 0.05), seat = V(0, 0.85, 0.2), headT = V(0, 0.9, -0.36), headB = V(0, 0.75, -0.4);
    [[bb, seat], [bb, headB], [seat, headT], [bb, rear], [seat, rear], [headB, front], [headB, headT]].forEach(function (q) { g.add(tube(q[0], q[1], 0.022, frame)); });
    g.add(tube(headT, V(0, 1.0, -0.38), 0.018, metal));
    g.add(tube(V(-0.25, 1.0, -0.38), V(0.25, 1.0, -0.38), 0.016, metal));                 // handlebar
    g.add(mesh(box(0.11, 0.04, 0.24), dark, 0, 0.9, 0.22));                                 // saddle
    // The rider: torso leaning forward from the saddle, arms to the bar, a helmet.
    var sh = soft(col), sk = soft(pick(SKIN, n.id)), tr = soft(pick(LEGS, n.id, 2));
    var body = new T.Group(); body.position.set(0, 0.98, 0.22); body.rotation.x = -0.55; g.add(body);
    var tor = mesh(capsule(0.15, 0.3), sh, 0, 0.3, 0); tor.scale.set(1.1, 1, 0.7); body.add(tor);
    var hd = new T.Group(); hd.position.set(0, 0.62, 0); hd.rotation.x = 0.45; body.add(hd);
    hd.add(mesh(ball(0.1), sk, 0, 0.06, 0));
    var helm = mesh(new T.SphereGeometry(0.125, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), soft(0xf0c419), 0, 0.08, 0.02); helm.scale.z = 1.2; hd.add(helm);
    var sx = Math.sin(-0.55), cx = Math.cos(-0.55);
    [-1, 1].forEach(function (sd) {
      var shoulder = V(sd * 0.18, 0.98 + 0.5 * cx, 0.22 + 0.5 * sx), grip = V(sd * 0.23, 1.0, -0.37);
      g.add(tube(shoulder, grip, 0.045, sh)); g.add(mesh(ball(0.045), sk, grip.x, grip.y, grip.z));
    });
    // Legs from the hips to the pedals; updated each frame from the crank angle.
    var crank = new T.Group(); crank.position.copy(bb); g.add(crank);
    crank.add(mesh(box(0.03, 0.36, 0.03), metal, 0.06, 0, 0));
    var legs = [-1, 1].map(function (sd) {
      return { sd: sd, thigh: tube(V(0, 0, 0), V(0, -1, 0), 0.07, tr), shin: tube(V(0, 0, 0), V(0, -1, 0), 0.058, tr), foot: mesh(box(0.1, 0.07, 0.22), dark) };
    });
    legs.forEach(function (l) { g.add(l.thigh); g.add(l.shin); g.add(l.foot); });
    var hip = V(0, 0.98, 0.22), pedal = V(), knee = V();
    g.userData.pedal = function (ph) {
      crank.rotation.x = ph;
      legs.forEach(function (l) {
        var a = ph + (l.sd > 0 ? Math.PI : 0);
        hip.set(l.sd * 0.1, 0.98, 0.22);
        pedal.set(l.sd * 0.12, bb.y + Math.cos(a) * 0.17, bb.z - Math.sin(a) * 0.17);
        // Knee by two-bone reach: thigh and shin 0.45 m each, the knee bending forwards.
        var dz = pedal.z - hip.z, dy = pedal.y - hip.y, d = Math.min(0.89, Math.sqrt(dz * dz + dy * dy)), h = Math.sqrt(Math.max(0, 0.2025 - d * d / 4));
        var uz = dz / d, uy = dy / d, pz = uy, py = -uz;
        if (pz > 0) { pz = -pz; py = -py; }
        knee.set(l.sd * 0.11, hip.y + uy * d / 2 + py * h, hip.z + uz * d / 2 + pz * h);
        setTube(l.thigh, hip, knee); setTube(l.shin, knee, pedal);
        l.foot.position.set(pedal.x, pedal.y + 0.02, pedal.z - 0.04);
      });
    };
    g.userData.pedal(0); g.userData.stride = 1.8;
    return g;
  }
  // Four legs on pivots in the order front left, front right, rear left, rear right.
  function quadLegs(g, xs, zFront, zRear, top, upper, lower, upMat, loMat, hoofMat) {
    var legs = [];
    [zFront, zRear].forEach(function (z) {
      [-xs, xs].forEach(function (x) {
        var l = limb(g, x, top, z, [[upper[0], upper[1], upMat], [lower[0], lower[1], loMat]]);
        l.add(mesh(box(lower[0] * 2.4, 0.08, lower[0] * 2.8), hoofMat, 0, -(upper[1] + lower[1]) - lower[0], 0));
        legs.push(l);
      });
    });
    return legs;
  }
  // A bull moose: dark body with a high shoulder hump, long pale legs, a long drooping muzzle, the
  // bell under the throat and broad palmate antlers.
  function moose() {
    var g = new T.Group(), coat = soft(0x3b2a1c), legC = soft(0x8a7660), dark = soft(0x1e1610), horn = soft(0xcbb48c);
    var body = mesh(capsule(0.45, 1.3), coat, 0, 1.5, 0.05); body.rotation.x = Math.PI / 2; body.scale.set(0.85, 1, 1.05); g.add(body);
    var hump = mesh(ball(0.42), coat, 0, 1.78, -0.45); hump.scale.set(0.85, 0.85, 1.15); g.add(hump);
    var rump = mesh(ball(0.4), coat, 0, 1.55, 0.65); rump.scale.set(0.9, 0.95, 1); g.add(rump);
    g.add(tube(V(0, 1.75, -0.7), V(0, 1.95, -1.15), 0.2, coat));                               // neck
    var hd = new T.Group(); hd.position.set(0, 1.98, -1.2); hd.rotation.x = -0.45; g.add(hd);
    var skull = mesh(capsule(0.15, 0.4), coat, 0, 0, -0.25); skull.rotation.x = Math.PI / 2; hd.add(skull);
    var nose = mesh(ball(0.16), dark, 0, -0.03, -0.55); nose.scale.set(0.9, 1, 1.25); hd.add(nose);
    [-1, 1].forEach(function (sd) {
      hd.add(mesh(ball(0.025), mat(0x0a0a0a), sd * 0.12, 0.06, -0.18));                       // eyes
      var ear = mesh(new T.ConeGeometry(0.06, 0.22, 6), coat, sd * 0.14, 0.17, 0.0); ear.rotation.z = -sd * 0.7; hd.add(ear);
      // Antler: a flat palm out to the side with a row of tines along its edge.
      var palm = mesh(ball(0.3), horn, sd * 0.42, 0.28, 0.02); palm.scale.set(1.1, 0.12, 0.7); palm.rotation.z = sd * 0.35; hd.add(palm);
      for (var k = 0; k < 4; k++) { var tine = mesh(new T.ConeGeometry(0.03, 0.18, 5), horn, sd * (0.55 + k * 0.05), 0.42 + k * 0.03, -0.15 + k * 0.1); tine.rotation.z = -sd * 0.3; hd.add(tine); }
      hd.add(tube(V(sd * 0.1, 0.12, 0.02), V(sd * 0.25, 0.22, 0.02), 0.035, horn));
    });
    g.add(mesh(capsule(0.05, 0.2), coat, 0, 1.62, -1.12));                                       // the bell under the throat
    g.add(mesh(capsule(0.05, 0.1), coat, 0, 1.6, 1.05));                                         // short tail
    g.userData.legs = quadLegs(g, 0.22, -0.55, 0.65, 1.26, [0.1, 0.55], [0.055, 0.6], coat, legC, dark);
    g.userData.stride = 2.2; g.userData.swing = 0.55;
    return g;
  }
  // A horse with its rider sitting up in the saddle, legs down each side, in a reflective vest.
  function horse(n) {
    var g = new T.Group(), coat = soft(pick([0x7a4a2a, 0x5a3520, 0x2a1d14, 0xb08a5a], n.id)), dk = soft(0x221710), sock = soft(0x2a2420);
    var body = mesh(capsule(0.34, 1.05), coat, 0, 1.35, 0.05); body.rotation.x = Math.PI / 2; body.scale.set(0.82, 1, 1.05); g.add(body);
    g.add(mesh(ball(0.36), coat, 0, 1.42, 0.62));                                                // hindquarters
    g.add(tube(V(0, 1.5, -0.6), V(0, 2.0, -0.95), 0.16, coat));                                  // neck
    var hd = new T.Group(); hd.position.set(0, 2.05, -1.0); hd.rotation.x = -0.9; g.add(hd);
    var skull = mesh(capsule(0.11, 0.38), coat, 0, 0, -0.22); skull.rotation.x = Math.PI / 2; hd.add(skull);
    hd.add(mesh(ball(0.1), dk, 0, -0.02, -0.45));                                                  // muzzle
    [-1, 1].forEach(function (sd) {
      hd.add(mesh(ball(0.02), mat(0x0a0a0a), sd * 0.09, 0.05, -0.12));
      var ear = mesh(new T.ConeGeometry(0.035, 0.14, 6), coat, sd * 0.06, 0.13, 0.05); hd.add(ear);
    });
    var mane = tube(V(0, 1.7, -0.68), V(0, 2.12, -0.98), 0.05, dk); mane.position.z += 0.06; g.add(mane);
    g.add(tube(V(0, 1.5, 0.95), V(0, 0.85, 1.12), 0.07, dk));                                    // tail
    g.userData.legs = quadLegs(g, 0.18, -0.5, 0.62, 1.11, [0.085, 0.5], [0.05, 0.52], coat, sock, dk);
    g.add(mesh(box(0.5, 0.08, 0.55), soft(0x4a2a18), 0, 1.68, -0.05));                            // saddle
    // Rider.
    var vest = soft(0xd8f02c), tr = soft(0x30343c), sk = soft(pick(SKIN, n.id, 1)), boot = soft(0x1a1a1a);
    var tor = mesh(capsule(0.15, 0.3), vest, 0, 2.02, 0.0); tor.scale.set(1.1, 1, 0.7); g.add(tor);
    g.add(mesh(ball(0.1), sk, 0, 2.48, -0.02));
    var helm = mesh(new T.SphereGeometry(0.12, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), soft(0x2a2d33), 0, 2.5, 0.0); helm.scale.z = 1.15; g.add(helm);
    [-1, 1].forEach(function (sd) {
      g.add(tube(V(sd * 0.12, 1.75, 0.0), V(sd * 0.3, 1.5, -0.2), 0.07, tr));                  // thigh down the side
      g.add(tube(V(sd * 0.3, 1.5, -0.2), V(sd * 0.3, 1.08, -0.05), 0.055, tr));                 // shin
      g.add(mesh(box(0.1, 0.08, 0.24), boot, sd * 0.3, 1.04, -0.09));
      g.add(tube(V(sd * 0.18, 2.24, -0.02), V(sd * 0.12, 1.9, -0.32), 0.045, vest));            // arms to the reins
      g.add(mesh(ball(0.04), sk, sd * 0.12, 1.88, -0.34));
    });
    g.userData.stride = 2.0; g.userData.swing = 0.35;
    return g;
  }
  function makeNpc(n) {
    var g = new T.Group(), col = n.color || "#286ee0";
    if (!shadowMat) shadowMat = keep(new T.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }));
    if (n.mode !== "train") g.add(shadow(n.hw * 2 + 0.3, n.hl * 2 + 0.3));
    var fig = null;
    if (n.kind === "officer") {
      fig = person({ shirt: 0xd8f02c, trousers: 0x1d2a4a, skin: pick(SKIN, n.id), hair: null });
      fig.add(mesh(cyl(0.11, 0.115, 0.08, 14), mat(0x1d2a4a), 0, 1.79, 0));                 // cap
      fig.add(mesh(box(0.22, 0.02, 0.1), mat(0x111111), 0, 1.76, -0.1));
      fig.userData.raise = fig.userData.arms[1];                                            // the arm raised for stop
    } else if (n.kind === "ped" || n.kind === "child" || n.kind === "stroll") {
      var child = n.kind === "child";
      fig = person({ shirt: col, trousers: pick(LEGS, n.id, 1), skin: pick(SKIN, n.id), hair: pick(HAIR, n.id, 3), scale: child ? 0.62 : 0.94 + (n.id % 3) * 0.03 });
      if (child) fig.add(mesh(box(0.26, 0.3, 0.12), mat(0xd04a3a), 0, 1.28, 0.16));          // school bag
    } else if (n.kind === "cyclist" || n.kind === "bike") {
      fig = cyclist(n, col);
    } else if (n.kind === "horse") {
      fig = horse(n);
    } else if (n.kind === "moose") {
      fig = moose();
    } else if (n.kind === "train" || n.kind === "tram") {
      var tram = n.kind === "tram";
      for (var k = 0; k < (n.cars || 4); k++) {
        g.add(mesh(box(tram ? 2.6 : 3.2, tram ? 3.2 : 3.6, 12.8), mat(tram ? 0x2a62b8 : k === 0 ? 0xc0392b : 0x8e959e), 0, tram ? 1.8 : 2.0, k * 13.5));
        g.add(mesh(box(tram ? 2.65 : 3.25, 0.8, 11), mat(0x30363e), 0, tram ? 2.4 : 2.6, k * 13.5));
        if (tram) g.add(mesh(box(2.65, 0.25, 12.8), mat(0xf2f4f6), 0, 0.9, k * 13.5));
      }
      if (tram) g.add(mesh(box(0.08, 1.4, 0.08), mat(0x30363e), 0, 4.0, 0));
    } else if (n.kind === "cone") {
      g.add(mesh(cyl(0.03, 0.26, 0.75, 8), mat(0xff7a1a), 0, 0.38, 0));
      g.add(mesh(cyl(0.12, 0.17, 0.12, 8), mat(0xffffff), 0, 0.4, 0));
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
      } else if (n.kind === "tractor") {
        g.add(mesh(box(Wd - 0.6, 1.0, L), mat(0x2f8a3a), 0, 1.0, 0));
        g.add(mesh(box(Wd - 0.7, 1.3, 1.3), mat(0x303a4a), 0, 2.1, 0.5));
        [[-1, 1, 0.75], [1, 1, 0.75], [-1, -1, 0.45], [1, -1, 0.45]].forEach(function (w) {
          var wh = mesh(new T.CylinderGeometry(w[2], w[2], 0.4, 10), mat(0x1c1c1c), w[0] * (n.hw - 0.1), w[2], w[1] * 1.0);
          wh.rotation.z = Math.PI / 2; g.add(wh);
        });
      } else {
        var body = n.kind === "amb" ? "#f0e040" : n.kind === "police" ? "#f2f4f6" : col;
        carBody(g, n, body);
        [-1, 1].forEach(function (sd) { g.add(mesh(box(0.34, 0.14, 0.05), mat(0xfff6d0, true), sd * (n.hw - 0.28), 0.72, -n.hl - 0.01)); });
        g.add(mesh(box(Wd - 0.7, 0.12, 0.04), mat(0x1c1f23), 0, 0.5, -n.hl - 0.01));   // grille
        g.add(mesh(box(Wd - 0.1, 0.16, 0.08), mat(0x2a2d31), 0, 0.36, -n.hl + 0.01));  // bumpers
        g.add(mesh(box(Wd - 0.1, 0.16, 0.08), mat(0x2a2d31), 0, 0.36, n.hl - 0.01));
        [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(function (w) {
          var wh = mesh(cyl(0.33, 0.33, 0.22, 16), mat(0x1c1c1c), w[0] * (n.hw - 0.08), 0.33, w[1] * (n.hl - 0.8));
          wh.rotation.z = Math.PI / 2; g.add(wh);
          var rim = mesh(cyl(0.19, 0.19, 0.24, 12), mat(0xb8bec6), w[0] * (n.hw - 0.08), 0.33, w[1] * (n.hl - 0.8));
          rim.rotation.z = Math.PI / 2; g.add(rim);
        });
        g.userData.brake = new T.MeshBasicMaterial({ color: 0x7a2018 });
        g.add(mesh(box(Wd - 0.3, 0.12, 0.05), g.userData.brake, 0, 0.75, n.hl + 0.01));   // rear lights, bright when braking
        if (n.kind === "police") {
          g.add(mesh(box(Wd + 0.02, 0.22, L - 0.6), mat(0x1d4fa8), 0, 0.68, 0));
          g.add(mesh(box(Wd + 0.02, 0.1, L - 0.6), mat(0xf8c628), 0, 0.84, 0));
        }
        if (n.kind === "amb" || n.kind === "police") {
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
    if (fig) { g.add(fig); Object.assign(g.userData, fig.userData); }
    scene.add(g);
    return g;
  }
  // A car body seen from the side, pushed out across the width with rounded edges: bonnet, glass
  // all round (windscreen, side and rear windows) under a roof in the body colour, and door mirrors.
  var paints = {}, carGeos = {};
  function paint(c) { return paints[c] || (paints[c] = keep(new T.MeshPhongMaterial({ color: c, specular: 0x666666, shininess: 70 }))); }
  function carBody(g, n, col) {
    var hl = n.hl - 0.06, hw = n.hw - 0.06, k = hl + "," + hw;
    if (!carGeos[k]) {
      var ext = function (pts, depth, bev) {
        var sh = new T.Shape(); sh.moveTo(pts[0][0], pts[0][1]);
        for (var i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
        var geo = new T.ExtrudeGeometry(sh, { depth: depth, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelSegments: 2 });
        geo.translate(0, 0, -depth / 2); return keep(geo);
      };
      // Shape x is -z (the car's front is at z = -hl): a quarter turn about y puts the push across the width.
      var lo = 0.3, belt = 0.98, roof = 1.42, f = hl, r = -hl;
      carGeos[k] = {
        body: ext([[f, lo], [f, 0.74], [f - 0.2, 0.86], [f - 1.15, belt], [r + 0.5, belt + 0.02], [r, 0.9], [r, lo]], hw * 2 - 0.08, 0.06),
        glass: ext([[f - 1.1, belt], [f - 1.85, roof - 0.02], [r + 1.15, roof - 0.02], [r + 0.55, belt]], hw * 2 - 0.26, 0.04),
        roof: ext([[f - 1.83, roof - 0.04], [r + 1.17, roof - 0.04], [r + 1.2, roof + 0.02], [f - 1.86, roof + 0.02]], hw * 2 - 0.24, 0.03)
      };
    }
    var G3 = carGeos[k], glass = paint(0x26303c);
    [[G3.body, paint(col)], [G3.glass, glass], [G3.roof, paint(col)]].forEach(function (q) {
      var m = new T.Mesh(q[0], q[1]); m.rotation.y = Math.PI / 2; g.add(m);
    });
    g.add(mesh(box(n.hw * 2 - 0.14, 0.42, 0.1), paint(col), 0, 1.2, 0.1));            // middle pillar
    [-1, 1].forEach(function (sd) { g.add(mesh(box(0.16, 0.1, 0.12), paint(col), sd * (n.hw + 0.05), 1.0, -hl + 1.25)); });   // door mirrors
  }
  function updateNpcs(api, G, dt) {
    var seen = {};
    G.npcs.forEach(function (n) {
      var g = npcMeshes[n.id] || (npcMeshes[n.id] = makeNpc(n));
      seen[n.id] = true;
      var pose = n.mode === "train" ? n.poly.at(n.t) : api.npcPose(n);
      g.position.x = pose.x; g.position.z = pose.y; g.rotation.y = -pose.a;
      // Arms and legs: a walking swing in step with the speed, the pedals going round on a bike.
      var ud = g.userData;
      if (ud.raise) ud.raise.rotation.z = n.vu ? 0.07 : 2.75;
      if (ud.legs || ud.pedal) {
        var spd = n.mode === "walk" ? Math.abs(n.vu || 0) + Math.abs(n.vs || 0) : Math.abs(n.v || 0);
        ud.ph = (ud.ph || 0) + spd * (dt || 0) * (ud.stride || 4.5);
        if (ud.pedal) ud.pedal(ud.ph);
        if (ud.legs) {
          ud.amp = (ud.amp || 0) + (Math.min(1, spd / 1.2) * (ud.swing || 0.5) - (ud.amp || 0)) * Math.min(1, (dt || 0) * 6);
          var sw = Math.sin(ud.ph) * ud.amp;
          ud.legs[0].rotation.x = sw; ud.legs[1].rotation.x = -sw;
          if (ud.legs[3]) { ud.legs[2].rotation.x = -sw; ud.legs[3].rotation.x = sw; }
          if (ud.arms) { ud.arms[0].rotation.x = -sw * 0.8; ud.arms[1].rotation.x = ud.raise && !n.vu ? 0 : sw * 0.8; }
          if (ud.bob) g.position.y = Math.abs(Math.sin(ud.ph)) * 0.07 * ud.amp;
        }
      }
      if (g.userData.brake) {
        var dv = (g.userData.lastV != null ? g.userData.lastV - n.v : 0);
        g.userData.lastV = n.v;
        g.userData.brakeT = dv > 0.04 || (n.v < 0.3 && !n.parked) ? 0.4 : Math.max(0, (g.userData.brakeT || 0) - 0.016);
        g.userData.brake.color.setHex(g.userData.brakeT > 0 ? 0xff2a1a : 0x7a2018);
      }
      if (g.userData.blink) {
        var on = Math.floor(G.t * 2.6) % 2 === 1;
        g.userData.blink[0].color.setHex((n.blink < 0 || n.blink === 2) && on ? 0xffa61e : 0x4a3a20);
        g.userData.blink[1].color.setHex(n.blink > 0 && on ? 0xffa61e : 0x4a3a20);
      }
      if (g.userData.siren) {
        var f = Math.floor(G.t * 6) % 2;
        g.userData.siren[0].material.color.setHex(f ? 0x4aa0ff : 0x10224a);
        g.userData.siren[1].material.color.setHex(f ? 0x10224a : 0x4aa0ff);
      }
    });
    Object.keys(npcMeshes).forEach(function (k) { if (!seen[k]) { drop(npcMeshes[k]); delete npcMeshes[k]; } });
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
    var r = Math.random, cm = new T.MeshLambertMaterial({ color: 0xffffff, emissive: 0x8c939b, fog: false, flatShading: true });   // lit from within, or the green ground light tints their undersides
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
  function paintSky(snow, dark) {
    var geo = skyDome.geometry, pos = geo.attributes.position, col = geo.attributes.color;
    var top = new T.Color(dark ? 0x03050c : snow ? 0xb8c2ca : 0x5d97d6), mid = new T.Color(dark ? 0x081022 : snow ? 0xd9dee2 : 0xa9cbea),
      low = new T.Color(dark ? 0x0b1222 : snow ? 0xd9dee2 : 0xc4dbec), c = new T.Color();
    for (var i = 0; i < pos.count; i++) {
      var y = pos.getY(i) / 420;
      if (y > 0.25) c.copy(mid).lerp(top, Math.min(1, (y - 0.25) / 0.6)); else c.copy(low).lerp(mid, Math.max(0, y / 0.25));
      col.setXYZ(i, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
    clouds.visible = !snow && !dark;
    forest.children[0].material.color.setHex(dark ? 0x05080a : snow ? 0xaab4b8 : 0x5f7f6a);
  }
  function shadow(w, l) {
    var m = new T.Mesh(new T.PlaneGeometry(w, l), shadowMat);
    m.rotation.x = -Math.PI / 2; m.position.y = 0.03; return m;
  }
  var shadowMat = null;

  var snowy = false, flakes = null, night = false, rainy = false, hemi, sun, beam, baseFog = [55, 135];
  function setWeather(w) {
    snowy = w === "snow" || w === "ice"; night = w === "night"; rainy = w === "rain";
    var sky = night ? 0x0b1222 : rainy ? 0x9aa5ae : snowy ? 0xd9dee2 : 0xc4dbec;
    hemi.intensity = night ? 0.12 : 1.0; sun.intensity = night ? 0.03 : 0.85;
    scene.background.setHex(sky); scene.fog.color.setHex(sky);
    scene.fog.near = night ? 20 : rainy ? 22 : snowy ? 25 : 55; scene.fog.far = night ? 110 : rainy ? 90 : snowy ? 95 : 135;
    baseFog = [scene.fog.near, scene.fog.far];
    grass.material = mat(snowy ? 0xe6ebee : 0x709c54);
    paintSky(snowy, night);
    if (rainy) { clouds.visible = false; forest.children[0].material.color.setHex(0x7f8a86); }
    if (flakes) { scene.remove(flakes); flakes = null; }
    if (snowy && w !== "ice" || rainy) {
      var n = rainy ? 2400 : 1600, pos = new Float32Array(n * 3);
      for (var i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * 60; pos[i * 3 + 1] = Math.random() * 14; pos[i * 3 + 2] = (Math.random() - 0.5) * 60; }
      var geo = new T.BufferGeometry(); geo.setAttribute("position", new T.BufferAttribute(pos, 3));
      flakes = new T.Points(geo, new T.PointsMaterial({ color: rainy ? 0xc8d4de : 0xffffff, size: rainy ? 0.05 : 0.09, transparent: rainy, opacity: rainy ? 0.7 : 1 }));
      scene.add(flakes);
    }
  }
  // Snow falls around the car; flakes that drop below the road start again at the top.
  function updateSnow(p, dt) {
    if (!flakes) return;
    var a = flakes.geometry.attributes.position, arr = a.array;
    for (var i = 0; i < arr.length; i += 3) {
      arr[i + 1] -= dt * (rainy ? 9 : 1.4);
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
    if (G !== lastG) {
      clearAll(); lastG = G; lastPieces = 0; lastLook = { "-1": -99, "1": -99 }; camA = G.p.a; setWeather(G.lesson.weather);
      // On the real map one sees far: the haze starts later and the painted forest ring moves out.
      var real = !!api.mapArea();
      if (real) { scene.fog.near = 140; scene.fog.far = MAP_R; baseFog = [140, MAP_R]; }
      forest.scale.set(real ? 2.7 : 1, real ? 1.6 : 1, real ? 2.7 : 1);
      camera.far = real ? 720 : 500; camera.updateProjectionMatrix();
    }
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
    if (G.t - tidyT > 2 || G.t < tidyT) { tidyT = G.t; tidy(G); }
    updateMap(api, G);
    updateRails(api, G);
    updateLights(api);
    updateNpcs(api, G, dt);
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
    rig.position.set(p.x - rx * 0.36 - fx * 0.2, 1.22 + bump, p.y - ry * 0.36 - fy * 0.2);
    updateSnow(p, dt);
    var foggy = G.course.pieceAt(p.s).st.fog, fn = foggy ? 6 : baseFog[0], ff = foggy ? 38 : baseFog[1];
    scene.fog.near += (fn - scene.fog.near) * Math.min(1, dt * 0.8); scene.fog.far += (ff - scene.fog.far) * Math.min(1, dt * 0.8);
    rig.rotation.set(0, -camA, 0);
    if (lookKey) {
      lookHeld += dt;
      lookY += (lookKey * (lookHeld < 0.45 ? 1.45 : 2.35) - lookY) * Math.min(1, dt * 7);
    } else if (!dragging) { var back = Math.min(1, dt * 4); lookY -= lookY * back; lookP -= lookP * back; }
    // The head turns about the neck, a little behind the eyes, and looks slightly down at the road.
    if (Math.abs(lookY) > 1.1) lastLook[lookY < 0 ? -1 : 1] = G.t;
    camera.rotation.set(-0.1 + lookP, -lookY, 0);
    camera.position.set(Math.sin(lookY) * NECK, 0, NECK - Math.cos(lookY) * NECK);
    // Steering wheel turns with how fast the car turns.
    if (prevA === null) prevA = p.a;
    var rate = dt > 0 ? api.angDiff(p.a, prevA) / dt : 0; prevA = p.a;
    var want = G.manual ? -p.steer * 7 : Math.max(-2.6, Math.min(2.6, -rate * 2.2));
    wheelA += (want - wheelA) * Math.min(1, dt * 6);
    wheel.rotation.z = wheelA;
    stalk.rotation.z = -p.blink * 0.25;
    var pc = G.course.pieceAt(p.s);
    gearR = p.gear === "R";
    beam.intensity = night ? (p.high ? 900 : 380) : 0; beam.distance = p.high ? 130 : 60; beam.angle = p.high ? 0.42 : 0.5;
    beam.target.position.y = p.high ? -0.9 : -1.6;
    drawCluster(Math.round(p.v * 3.6), G.limit || pc.limit, p.blink, Math.floor(G.t * 2.6) % 2 === 0, night && p.high);
    renderMirrors(p, camA);
    renderer.render(scene, camera);
  }

  window.SPEL3D = {
    ready: function () { if (!renderer && !failed) init(); return !failed; },
    render: render,
    hide: function () { if (canvas) canvas.style.display = "none"; },
    look: function (y, p) { lookY = y; lookP = p || 0; },   // for the scripted test bots
    stats: function () { return renderer ? { objs: objs.length, signs: signMeshes.length, lights: lightSets.length, npcs: Object.keys(npcMeshes).length,
      geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, sceneChildren: scene.children.length } : null; },
    // Whether the driver looked over that shoulder (-1 left, 1 right) since game time t.
    looked: function (dir, t) { return lastLook[dir] >= t; }
  };
})();
