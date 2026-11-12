// Emils Körkort on the phone: the addon's quiz, offline. data.js (made by
// export.lua) holds the chapters, the written questions and the sign list;
// the sign questions are built here the way the addon builds them.
(function () {
  "use strict";

  var D = window.KORKORT;
  var STORE = "korkort.v1";

  // ---------------------------------------------------------------------
  // Saved progress (only on this phone)
  // ---------------------------------------------------------------------

  function defaults() {
    return { boxes: {}, chapter: "all", best: 0, soundOff: false, ttsAuto: false, onlyWrong: false };
  }

  function load() {
    var db = defaults();
    try {
      var saved = JSON.parse(localStorage.getItem(STORE));
      if (saved && typeof saved === "object") {
        for (var k in saved) db[k] = saved[k];
      }
    } catch (e) { /* private window or blocked storage: start fresh */ }
    if (!db.boxes || typeof db.boxes !== "object") db.boxes = {};
    return db;
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(db)); } catch (e) { /* not saved */ }
  }

  var db = load();

  // ---------------------------------------------------------------------
  // Questions
  // ---------------------------------------------------------------------

  var CHAPTERS = D.chapters.map(function (c) { return { key: c[0], name: c[1], pictures: c[2] }; });
  var CHAPTER_NAME = {};
  CHAPTERS.forEach(function (c) { CHAPTER_NAME[c.key] = c.name; });

  var QUESTIONS = D.questions.map(function (q) {
    return { ch: q[0], text: q[1], answers: q[2], why: q[3], pic: q[4] };
  });

  // Each sign both ways, wrong answers from the same group (as in the addon).
  var GROUPS = {
    A: ["skylten", "bild", "Varningsmärken (A) är gula trianglar med röd kant.", true],
    B: ["skylten", "bild", "Väjningspliktsmärken (B) visar vem som ska släppa fram vem.", true],
    C: ["skylten", "bild", "Förbudsmärken (C) är oftast runda med röd kant.", true],
    D: ["skylten", "bild", "Påbudsmärken (D) är runda och blå.", true],
    E: ["skylten", "bild", "Anvisningsmärken (E) är oftast fyrkantiga.", true],
    T: ["tilläggstavlan", "bild2", "Tilläggstavlor (T) sitter under ett annat märke och gäller tillsammans med det.", true],
    SIG: ["signalen", "bild2", "Trafiksignaler (SIG).", true],
    M: ["vägmarkeringen", "bild2", "Vägmarkeringar (M) är målade på vägen.", true],
    P: ["polisens tecken", "bild2", "Tecken av polis (P) gäller före signaler, märken och regler.", true],
    V: ["vaktens tecken", "bild2", "Tecken av vakt (V), till exempel vid ett vägarbete.", false],
    X: ["anordningen", "bild2", "Andra anordningar för trafiken (X), ofta vid vägarbeten och hinder.", false],
    Y: ["signalen", "bild2", "Signaler vid järnväg och spårväg (Y).", false],
    S: ["symbolen", "bild2", "Symboler (S) används på andra märken och tavlor.", false],
    F: ["skylten", "bild3", "Lokaliseringsmärken för vägvisning (F) visar vägen.", false],
    G: ["skylten", "bild3", "Upplysning om allmänna inrättningar (G).", false],
    H: ["skylten", "bild3", "Upplysning om service (H).", false],
    I: ["skylten", "bild3", "Turistiskt intressanta mål (I).", false],
    J: ["skylten", "bild3", "Upplysningsmärken (J).", false]
  };
  var POOL = { V: "P", Y: "SIG", G: "H", I: "H", J: "H" };
  var LOOKALIKE = { SIG5: "SIG18", SIG18: "SIG5" };

  function groupOf(code) { return code.indexOf("SIG") === 0 ? "SIG" : code.charAt(0); }

  function others(list, right) {
    var seen = {}, pick = [], out = [];
    seen[right[1]] = true;
    list.forEach(function (o) {
      if (!seen[o[1]] && LOOKALIKE[right[0]] !== o[0]) { seen[o[1]] = true; pick.push(o); }
    });
    for (var i = 0; i < 3 && pick.length; i++) {
      out.push(pick.splice(Math.floor(Math.random() * pick.length), 1)[0]);
    }
    return out;
  }

  (function buildSignQuestions() {
    var pools = {};
    D.signs.forEach(function (s) {
      var p = POOL[groupOf(s[0])] || groupOf(s[0]);
      (pools[p] = pools[p] || []).push(s);
    });
    D.signs.forEach(function (s) {
      var g = groupOf(s[0]), info = GROUPS[g];
      if (!info) return;
      var pool = pools[POOL[g] || g];
      var why = "Det är ”" + s[1] + "” (" + s[0] + "). " + info[2];
      QUESTIONS.push({
        ch: info[1], text: "Vad betyder " + info[0] + "?",
        answers: [s[1]].concat(others(pool, s).map(function (o) { return o[1]; })),
        why: why, pic: s[0], key: "sign:" + s[0]
      });
      if (info[3]) {
        QUESTIONS.push({
          ch: "hitta", text: "Vilken bild visar ”" + s[1] + "”?",
          answers: [s[0]].concat(others(pool, s).map(function (o) { return o[0]; })),
          why: why, key: "find:" + s[0], pictureAnswers: true
        });
      }
    });
  })();

  function key(q) { return q.key || (q.pic ? q.text + " " + q.pic : q.text); }

  // Drawn situations are k01 and up; everything else is a sign code.
  function isWide(code) { return /^k\d/.test(code); }
  function picUrl(code) { return isWide(code) ? "situations/" + code + ".jpg" : "signs/" + code + ".png"; }

  var COUNT = {};
  QUESTIONS.forEach(function (q) { COUNT[q.ch] = (COUNT[q.ch] || 0) + 1; });
  CHAPTERS = CHAPTERS.filter(function (c) { return COUNT[c.key]; });

  // ---------------------------------------------------------------------
  // Picking: wrong answers come back often, known ones seldom
  // ---------------------------------------------------------------------

  var WEIGHT = [8, 4, 2, 1, 0.5, 0.25];
  var NEW_WEIGHT = 5, KNOWN_BOX = 3, RECENT = 5;
  var recent = [];

  function pool() {
    var list = QUESTIONS.filter(function (q) { return db.chapter === "all" || q.ch === db.chapter; });
    if (!list.length) { db.chapter = "all"; return QUESTIONS.slice(); }
    return list;
  }

  // "Bara fel": the chosen chapter's questions whose last answer was wrong.
  function wrongPool() { return pool().filter(function (q) { return db.boxes[key(q)] === 0; }); }

  function pickQuestion() {
    var list = db.onlyWrong ? wrongPool() : pool();
    if (!list.length) list = pool();
    var keep = Math.min(RECENT, list.length - 1);
    var lately = recent.slice(recent.length - keep);
    var total = 0, weights = list.map(function (q) {
      var box = db.boxes[key(q)];
      var w = lately.indexOf(q) >= 0 ? 0 : (box === undefined ? NEW_WEIGHT : WEIGHT[box]);
      total += w;
      return w;
    });
    var r = Math.random() * total;
    for (var i = 0; i < list.length; i++) {
      r -= weights[i];
      if (r <= 0 && weights[i] > 0) return list[i];
    }
    return list[list.length - 1];
  }

  // ---------------------------------------------------------------------
  // Sound: short tones made on the phone, no files
  // ---------------------------------------------------------------------

  var audio;
  function tones(freqs, step, type, volume) {
    if (db.soundOff) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var t = audio.currentTime;
      freqs.forEach(function (f, i) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.type = type;
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + i * step);
        g.gain.exponentialRampToValueAtTime(volume, t + i * step + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * step + step * 1.8);
        o.connect(g).connect(audio.destination);
        o.start(t + i * step);
        o.stop(t + i * step + step * 2);
      });
    } catch (e) { /* no sound on this phone */ }
  }
  var SOUND = {
    right: function () { tones([660, 880], 0.09, "sine", 0.18); },
    wrong: function () { tones([220], 0.16, "triangle", 0.12); },
    cheer: function () { tones([523, 659, 784, 1047], 0.1, "sine", 0.2); }
  };

  // ---------------------------------------------------------------------
  // Reading aloud with the phone's own voice
  // ---------------------------------------------------------------------

  var synth = window.speechSynthesis;
  var SAY = [
    [/km\/h/g, "kilometer i timmen"], [/m\/s/g, "meter per sekund"],
    [/t\.ex\./g, "till exempel"], [/bl\.a\./g, "bland annat"], [/m\.fl\./g, "med flera"],
    [/kl\. /g, "klockan "], [/°C/g, " grader"], [/‰/g, " promille"], [/%/g, " procent"],
    [/(\d) ?kg/g, "$1 kilo"], [/(\d) ?cm/g, "$1 centimeter"], [/(\d) ?mm/g, "$1 millimeter"],
    [/(\d) ?m(?![a-zåäöA-ZÅÄÖ])/g, "$1 meter"], [/(\d)–(\d)/g, "$1 till $2"], [/×/g, " gånger "],
    [/→/g, " till "], [/[”“"]/g, ""]
  ];

  function speakable(text) {
    SAY.forEach(function (rule) { text = text.replace(rule[0], rule[1]); });
    return text;
  }

  function swedishVoice() {
    var voices = synth ? synth.getVoices() : [];
    for (var i = 0; i < voices.length; i++) {
      if (/^sv/i.test(voices[i].lang)) return voices[i];
    }
    return null;
  }

  function speak(texts) {
    if (!synth) return;
    synth.cancel();
    var voice = swedishVoice();
    texts.forEach(function (t) {
      var u = new SpeechSynthesisUtterance(speakable(t));
      u.lang = "sv-SE";
      if (voice) u.voice = voice;
      synth.speak(u);
    });
  }

  // ---------------------------------------------------------------------
  // The window
  // ---------------------------------------------------------------------

  var $ = function (id) { return document.getElementById(id); };
  var el = {
    chapter: $("chapter"), fill: $("fill"), pic: $("pic"), question: $("question"),
    answers: $("answers"), explain: $("explain"), result: $("result"), why: $("why"),
    stats: $("stats"), next: $("next"), speak: $("speak"), menuBtn: $("menuBtn"),
    sheet: $("sheet"), chapters: $("chapters"), optSound: $("optSound"), optTts: $("optTts"),
    ttsRow: $("ttsRow"), reset: $("reset"), close: $("close"),
    optWrong: $("optWrong"), wrongRow: $("wrongRow"), examBtn: $("examBtn"), examDone: $("examDone")
  };

  var LETTERS = ["A", "B", "C", "D"];
  var current, answered, lastRight, buttons = [];
  var session = { right: 0, total: 0, streak: 0 };

  // Övningsprov, like the real knowledge test: 65 questions that count, 52 right to pass, 50 minutes.
  // Null when no test is on; while one is: list, i (index shown), pick (the button chosen, which can
  // change until "Nästa fråga"), right, wrong ([{ q, picked }]), left (seconds, counted only while the
  // app is on screen), done, review (index into wrong while going through them).
  var EXAM_COUNT = 65, EXAM_PASS = 52, EXAM_SECONDS = 50 * 60, EXAM_SIGNS = 10;
  var exam = null, examTimer = null;
  function clock(s) { return Math.floor(s / 60) + ":" + ("0" + (s % 60)).slice(-2); }

  function updateStats() {
    if (exam) {
      var n = exam.list.length, through = exam.done ? n : exam.i;
      el.stats.innerHTML = exam.done ? "Övningsprov: " + exam.right + " rätt av " + n
        : (exam.left <= 300 ? '<span class="no">Tid kvar ' + clock(exam.left) + "</span>" : "Tid kvar " + clock(exam.left));
      el.fill.style.width = (100 * through / n) + "%";
      return;
    }
    var list = pool(), known = 0;
    list.forEach(function (q) { if ((db.boxes[key(q)] || 0) >= KNOWN_BOX) known++; });
    var html = "Rätt " + session.right + " av " + session.total + " · " +
      (db.onlyWrong ? "Fel kvar " + wrongPool().length : "Kan " + known + " av " + list.length);
    if (session.streak >= 2) html += ' · <span class="gold">' + session.streak + " i rad</span>";
    if (db.best >= 5) html += "<br>Rekord: " + db.best + " i rad";
    el.stats.innerHTML = html;
    el.fill.style.width = (100 * known / list.length) + "%";
  }

  function show(q) {
    current = q;
    answered = false;
    recent.push(q);
    if (recent.length > RECENT) recent.shift();

    if (exam) {
      el.chapter.textContent = "Övningsprov · fråga " + (exam.i + 1) + " av " + exam.list.length;
      el.next.textContent = exam.i === exam.list.length - 1 ? "Lämna in" : "Nästa fråga";
    } else {
      el.chapter.textContent = (CHAPTER_NAME[q.ch] || "") + (db.onlyWrong ? " · bara fel" : "");
      el.next.textContent = "Nästa fråga";
    }
    el.examDone.hidden = true;
    el.answers.hidden = false;
    el.question.textContent = q.text;
    if (q.pic) {
      el.pic.src = picUrl(q.pic);
      el.pic.className = isWide(q.pic) ? "wide" : "sign";
      el.pic.hidden = false;
    } else {
      el.pic.hidden = true;
      el.pic.removeAttribute("src");
    }

    // Shuffle so the right answer is not always first.
    var order = q.answers.map(function (_, i) { return i; });
    for (var i = order.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = order[i]; order[i] = order[j]; order[j] = t;
    }
    el.answers.className = q.pictureAnswers ? "grid" : "";
    el.answers.innerHTML = "";
    buttons = order.map(function (n, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "answer" + (q.pictureAnswers ? " pic" : "");
      var badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = LETTERS[i];
      b.appendChild(badge);
      if (q.pictureAnswers) {
        var img = document.createElement("img");
        img.src = picUrl(q.answers[n]);
        img.alt = "Bild " + LETTERS[i];
        b.appendChild(img);
      } else {
        var label = document.createElement("span");
        label.textContent = q.answers[n];
        b.appendChild(label);
      }
      b.isRight = n === 0;
      b.answerText = q.answers[n];
      b.badge = badge;
      b.addEventListener("click", function () { answer(b); });
      el.answers.appendChild(b);
      return b;
    });

    el.explain.hidden = true;
    el.next.hidden = true;
    updateStats();
    window.scrollTo(0, 0);
    if (db.ttsAuto) speakQuestion();
  }

  function cheer(text) {
    var t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2400);
  }

  // In the test a pick shows nothing about right or wrong, and can change until "Nästa fråga".
  function examPick(picked) {
    exam.pick = picked;
    buttons.forEach(function (b) { b.classList.toggle("picked", b === picked); });
    el.next.hidden = false;
  }

  // After an answer (or going through a test's wrong ones): marks, why, and the next button.
  function reveal(picked, right) {
    buttons.forEach(function (b) {
      b.disabled = true;
      b.classList.remove("picked");
      if (b.isRight) { b.classList.add("right"); b.badge.textContent = "✓"; }
      else if (b === picked) { b.classList.add("wrong"); b.badge.textContent = "✕"; }
      else b.classList.add("faded");
    });
    el.why.textContent = current.why;
    el.explain.className = right ? "" : "bad";
    el.explain.hidden = false;
    el.next.hidden = false;
    updateStats();
    el.explain.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function wrongResult() {
    el.result.innerHTML = '<span class="no">Fel.</span> ';
    if (current.pictureAnswers) el.result.appendChild(document.createTextNode("Rätt bild är markerad med grönt."));
    else el.result.appendChild(document.createTextNode("Rätt svar: " + current.answers[0]));
  }

  function answer(picked) {
    if (answered || !current) return;
    if (exam) { examPick(picked); return; }
    answered = true;
    var right = picked.isRight, k = key(current), praise = null;
    lastRight = right;
    if (right) {
      db.boxes[k] = Math.min((db.boxes[k] || 0) + 1, WEIGHT.length - 1);
      session.right++;
      session.streak++;
      if (session.streak > db.best) {
        db.best = session.streak;
        if (session.streak >= 5) praise = "Nytt rekord: " + session.streak + " i rad!";
      }
      if (!praise && session.streak % 5 === 0) praise = session.streak + " rätt i rad!";
    } else {
      db.boxes[k] = 0;
      session.streak = 0;
    }
    session.total++;
    save();

    if (right) {
      el.result.innerHTML = '<span class="ok">Rätt!</span>' +
        (session.streak >= 2 ? ' <span class="gold">' + session.streak + " i rad</span>" : "");
    } else wrongResult();
    reveal(picked, right);

    if (praise) { cheer(praise); SOUND.cheer(); }
    else if (right) SOUND.right();
    else SOUND.wrong();
    if (db.ttsAuto) speakQuestion();
  }

  // Before an answer: the question and the choices in the order shown.
  // After: right or wrong, and why.
  function speakQuestion() {
    if (!current) return;
    if (answered) {
      var verdict = lastRight ? "Rätt!" : (current.pictureAnswers ? "Fel." : "Fel. Rätt svar: " + current.answers[0] + ".");
      speak([verdict, current.why]);
      return;
    }
    var texts = [current.text];
    if (current.pictureAnswers) texts.push("Välj rätt bild.");
    else {
      texts.push("Svaren är:");
      buttons.forEach(function (b, i) { texts.push(LETTERS[i] + ". " + b.answerText + "."); });
    }
    speak(texts);
  }

  function next() {
    if (db.onlyWrong && !wrongPool().length) { db.onlyWrong = false; save(); cheer("Inga fel kvar!"); }
    show(pickQuestion());
  }

  // ---------------------------------------------------------------------
  // Övningsprov
  // ---------------------------------------------------------------------

  function endExam() {
    clearInterval(examTimer); examTimer = null;
    exam = null;
    next();
  }

  // Going through the wrong ones after the test, one at a time, as after a wrong answer.
  function showReview() {
    var w = exam.wrong[exam.review];
    show(w.q);
    answered = true; lastRight = false;
    var picked = null;
    buttons.forEach(function (b) { if (b.answerText === w.picked) picked = b; });
    wrongResult();
    el.chapter.textContent = "Övningsprov · fel " + (exam.review + 1) + " av " + exam.wrong.length;
    el.next.textContent = exam.review < exam.wrong.length - 1 ? "Nästa fel" : "Klar";
    reveal(picked, false);
  }

  function examResult(timeUp) {
    clearInterval(examTimer); examTimer = null;
    if (synth) synth.cancel();
    exam.done = true;
    current = null; answered = true;
    var n = exam.list.length, passed = exam.right >= EXAM_PASS;
    el.chapter.textContent = "Övningsprov";
    el.pic.hidden = true; el.pic.removeAttribute("src");
    el.answers.hidden = true;
    el.question.textContent = "Provet är klart.";
    el.result.innerHTML = passed ? '<span class="ok">Godkänt!</span>' : '<span class="no">Inte godkänt.</span>';
    el.why.textContent = "Du fick " + exam.right + " rätt av " + n + ". För godkänt krävs " + EXAM_PASS + " rätt." +
      (timeUp ? " Tiden tog slut, så frågorna du inte hann räknas som fel." : " Tid: " + clock(EXAM_SECONDS - exam.left) + " av " + clock(EXAM_SECONDS) + ".");
    el.explain.className = passed ? "" : "bad";
    el.explain.hidden = false;
    el.next.textContent = exam.wrong.length ? "Gå igenom felen" : "Klar";
    el.next.hidden = false;
    el.examDone.hidden = !exam.wrong.length;
    updateStats();
    window.scrollTo(0, 0);
    if (passed) { cheer("Godkänt!"); SOUND.cheer(); }
  }

  // "Nästa fråga" in the test: the pick counts, and is learnt like any answer.
  function examNext() {
    var q = exam.list[exam.i], b = exam.pick, k = key(q);
    if (b && b.isRight) { exam.right++; db.boxes[k] = Math.min((db.boxes[k] || 0) + 1, WEIGHT.length - 1); }
    else { db.boxes[k] = 0; exam.wrong.push({ q: q, picked: b ? b.answerText : null }); }
    save();
    exam.pick = null;
    exam.i++;
    if (exam.i >= exam.list.length) examResult(false); else show(exam.list[exam.i]);
  }

  // The clock stands still while the app is not on screen.
  function examTick() {
    if (!exam || exam.done || document.hidden) return;
    exam.left--;
    if (exam.left <= 0) {
      if (exam.pick) examNext(); // a pick made but not yet sent in still counts
      if (!exam.done) examResult(true);
    } else updateStats();
  }

  // 55 written questions (pictures and situations among them) and 10 sign questions, from every chapter.
  function startExam() {
    var written = QUESTIONS.filter(function (q) { return !q.key; }), signs = QUESTIONS.filter(function (q) { return !!q.key; });
    var list = [];
    function take(from, n) { for (var i = 0; i < n && from.length; i++) list.push(from.splice(Math.floor(Math.random() * from.length), 1)[0]); }
    take(written, EXAM_COUNT - EXAM_SIGNS);
    take(signs, EXAM_SIGNS);
    for (var i = list.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = list[i]; list[i] = list[j]; list[j] = t; }
    exam = { list: list, i: 0, right: 0, wrong: [], left: EXAM_SECONDS, pick: null, done: false, review: -1 };
    clearInterval(examTimer);
    examTimer = setInterval(examTick, 1000);
    closeMenu();
    show(list[0]);
  }

  // ---------------------------------------------------------------------
  // Menu: chapter and settings
  // ---------------------------------------------------------------------

  function chapterRow(value, name, count) {
    var label = document.createElement("label");
    label.className = "row";
    var input = document.createElement("input");
    input.type = "radio";
    input.name = "chapter";
    input.value = value;
    input.checked = db.chapter === value;
    input.addEventListener("change", function () {
      db.chapter = value;
      save();
      recent = [];
      closeMenu();
      next();
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(name));
    var c = document.createElement("span");
    c.className = "count";
    c.textContent = count;
    label.appendChild(c);
    return label;
  }

  function buildMenu() {
    el.chapters.innerHTML = "";
    el.chapters.appendChild(chapterRow("all", "Alla kapitel", QUESTIONS.length));
    [["Teori", false], ["Bilder", true]].forEach(function (group) {
      var d = document.createElement("details");
      var s = document.createElement("summary");
      s.textContent = group[0];
      d.appendChild(s);
      CHAPTERS.forEach(function (c) {
        if (!!c.pictures !== group[1]) return;
        if (db.chapter === c.key) d.open = true;
        d.appendChild(chapterRow(c.key, c.name, COUNT[c.key]));
      });
      el.chapters.appendChild(d);
    });
    el.optSound.checked = !db.soundOff;
    el.optTts.checked = !!db.ttsAuto;
    el.optWrong.checked = !!db.onlyWrong;
    // During a test the menu only offers the way out, so nothing else changes under it.
    el.chapters.hidden = el.wrongRow.hidden = !!exam;
    el.examBtn.textContent = !exam ? "📝 Övningsprov: 65 frågor, 50 min" : exam.done ? "Tillbaka till frågorna" : "Avbryt provet";
  }

  function openMenu() { buildMenu(); el.sheet.hidden = false; }
  function closeMenu() { el.sheet.hidden = true; }

  el.menuBtn.addEventListener("click", openMenu);
  el.close.addEventListener("click", closeMenu);
  el.sheet.addEventListener("click", function (e) { if (e.target === el.sheet) closeMenu(); });
  el.optSound.addEventListener("change", function () { db.soundOff = !el.optSound.checked; save(); });
  el.optTts.addEventListener("change", function () { db.ttsAuto = el.optTts.checked; save(); });
  el.reset.addEventListener("click", function () {
    if (!window.confirm("Nollställa alla svar och rekordet i den här mobilen?")) return;
    db = defaults();
    save();
    session = { right: 0, total: 0, streak: 0 };
    closeMenu();
    next();
  });
  el.next.addEventListener("click", function () {
    if (!exam) next();
    else if (exam.review >= 0) { if (exam.review < exam.wrong.length - 1) { exam.review++; showReview(); } else endExam(); }
    else if (exam.done) { if (exam.wrong.length) { exam.review = 0; showReview(); } else endExam(); }
    else examNext();
  });
  el.examDone.addEventListener("click", endExam);
  el.examBtn.addEventListener("click", function () { if (exam) { closeMenu(); endExam(); } else startExam(); });
  el.optWrong.addEventListener("change", function () {
    if (el.optWrong.checked && !wrongPool().length) { el.optWrong.checked = false; closeMenu(); cheer("Inga fel att öva på här"); return; }
    db.onlyWrong = el.optWrong.checked; save();
    recent = [];
    closeMenu();
    next();
  });
  el.speak.addEventListener("click", function () {
    if (synth && synth.speaking) synth.cancel(); else speakQuestion();
  });

  // Reading aloud only where the phone can do it.
  if (synth) {
    el.speak.hidden = false;
  } else {
    el.ttsRow.hidden = true;
  }

  // Works offline once opened: everything is kept by the service worker.
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(function () { /* online only */ });
  }

  next();
})();
