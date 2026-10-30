/* ==========================================================================
   teacher/teacher.js — تطبيق المعلم (PWA)
   يعتمد على window.ATT من ../shared/core.js. سكربت كلاسيكي.
   لا يوجد هنا أي كود إدارة أو مركز أو حذف بيانات.
   ========================================================================== */
(function () {
  "use strict";

  var ATT = window.ATT;
  var $ = function (id) { return document.getElementById(id); };

  var store = null;
  var db = null;
  // الجلسة المعروضة على الشاشة الآن (قد تكون مغلقة). الحصة المفتوحة تُقرأ من db.activeSessionKey.
  var viewKey = null;
  var view = { tab: "present" };
  var lastShown = null;

  /* ======================================================================
     التخزين
     ====================================================================== */
  function migrateTeacherDb(raw) {
    var base = ATT.defaultTeacherDb();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
    return {
      schemaVersion: 1,
      pack: Object.assign(base.pack, raw.pack && typeof raw.pack === "object" ? raw.pack : {}),
      settings: Object.assign(ATT.defaultTeacherSettings(), raw.settings && typeof raw.settings === "object" ? raw.settings : {}),
      classes: Array.isArray(raw.classes) ? raw.classes.filter(function (c) { return c && c.grade && c.cls; })
        .map(function (c) { return { grade: String(c.grade), cls: String(c.cls) }; }) : [],
      schedule: Array.isArray(raw.schedule) ? raw.schedule.filter(function (l) { return l && typeof l === "object"; }) : [],
      students: Array.isArray(raw.students) ? raw.students.filter(function (s) { return s && s.code; })
        .map(function (s) { return { code: String(s.code), name: String(s.name || ""), grade: String(s.grade || ""), cls: String(s.cls || "") }; }) : [],
      sessions: raw.sessions && typeof raw.sessions === "object" && !Array.isArray(raw.sessions) ? raw.sessions : {},
      activeSessionKey: raw.activeSessionKey || null,
      lastPage: raw.lastPage === "today" || raw.lastPage === "session" || raw.lastPage === "settings" ? raw.lastPage : null
    };
  }

  function persist() {
    var ok = store.save();
    var warn = $("storeWarn");
    if (warn) warn.hidden = ok;
    return ok;
  }

  function paintNet() {
    var el = $("netState");
    if (!el) return;
    var on = navigator.onLine !== false;
    el.classList.toggle("off", !on);
    el.textContent = on ? "متصل" : "بدون اتصال";
  }

  /* ======================================================================
     التنقل
     ====================================================================== */
  function isOnboarded() { return !!(db && db.settings && db.settings.onboarded); }

  function showPage(name) {
    if (!isOnboarded() && name !== "setup") name = "setup";
    if (name !== "session") stopScan(true);
    lastShown = name;
    if (db && isOnboarded() && (name === "today" || name === "session" || name === "settings") && db.lastPage !== name) {
      db.lastPage = name;
      persist();
    }
    ["setup", "today", "session", "settings"].forEach(function (p) {
      var el = document.getElementById("page-" + p);
      if (el) el.classList.toggle("on", p === name);
    });
    var titles = { setup: "إعداد المعلم", session: "الجلسة", settings: "الإعدادات", today: "حصصي اليوم" };
    document.title = (titles[name] || "حصصي اليوم") + " — حضور الطلاب";
    var sb = $("btnSettings");
    if (sb) sb.hidden = !isOnboarded() || name === "settings";
    var main = $("main");
    if (main) main.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  /** الحصة المفتوحة المحفوظة في db.activeSessionKey، أو null. */
  function getActiveSession() {
    var key = db && db.activeSessionKey;
    if (!key) return null;
    var s = (db.sessions || {})[key];
    if (!s || s.status !== "open") {
      db.activeSessionKey = null;
      return null;
    }
    return { key: key, session: s };
  }

  /** الجلسة المعروضة على شاشة الجلسة (قد تكون مغلقة). */
  function viewSession() { return viewKey ? sessionForKey(viewKey) : null; }

  /** هل توجد حصة مفتوحة في التخزين؟ */
  function hasOpenSession() { return !!findOpenSession(); }

  /* ======================================================================
     الحزمة
     ====================================================================== */
  function packSummary(obj) {
    var classes = obj.classes || [];
    var students = obj.students || [];
    var schedule = obj.schedule || [];
    return {
      teacherName: obj.teacherName || "معلم",
      schoolName: obj.schoolName || "",
      issuedAt: obj.issuedAt || "",
      rosterVersionId: obj.rosterVersionId || "",
      classes: classes.length,
      students: students.length,
      schedule: schedule.length
    };
  }

  function msgEl(mode) { return $(mode === "update" ? "setPackMsg" : "packMsg"); }

  function setPackMsg(mode, text) {
    var el = msgEl(mode);
    if (el) el.textContent = text;
  }

  function failPack(mode, message) {
    setPackMsg(mode, message);
    if (mode !== "update") ATT.toast("تعذر تحميل الحزمة");
    else ATT.toast("لم يتم تحديث الحزمة");
  }

  /** رسالة عربية واضحة لأهم خطأ، مع عدد الأخطاء الأخرى. */
  function packErrorText(errors) {
    var list = Array.isArray(errors) ? errors : [];
    if (!list.length) return "الحزمة غير صالحة.";
    var pick = function (code) { return list.filter(function (e) { return e.code === code; })[0]; };
    var fmt = pick("format"), chk = pick("checksum"), ver = pick("formatVersion");
    var main;
    if (fmt && /ملف غياب/.test(fmt.message)) {
      main = "هذا ملف غياب (ATT-ABSENCE) وليس حزمة معلم. اختر ملف الحزمة الذي ينتهي بـ .json.";
    } else if (fmt) {
      main = "الملف ليس حزمة معلم صالحة (ATT-TEACHER-PACK). تأكد أنك اخترت ملف الحزمة الصحيح.";
    } else if (ver) {
      main = "نسخة الحزمة غير مدعومة. اطلب من المركز تصدير حزمة جديدة.";
    } else if (chk) {
      main = "الحزمة تالفة أو معدّلة (checksum غير مطابق). اطلب حزمة جديدة من المركز.";
    } else if (pick("classes") || pick("class-fields") || pick("class-empty") || pick("class-duplicate")) {
      main = "الحزمة لا تحتوي فصولًا صالحة بطلاب. اطلب من المركز تصديرها مرة أخرى.";
    } else if (pick("students") || pick("student-fields") || pick("student-class")) {
      main = "بيانات الطلاب في الحزمة غير مكتملة أو لا تنتمي إلى فصولها.";
    } else {
      main = list[0].message || "الحزمة غير صالحة.";
    }
    var others = list.length - 1;
    return main + (others > 0 ? " (" + others + " خطأ إضافي)" : "");
  }

  /** يكتب الحزمة في التخزين مع الحفاظ على تفضيلات الجهاز والجلسات. */
  function applyPack(obj, mode) {
    var old = db.settings || {};
    db.pack = {
      packId: obj.packId,
      teacherId: obj.teacherId,
      teacherName: obj.teacherName,
      schoolName: obj.schoolName || "",
      issuedAt: obj.issuedAt,
      rosterVersionId: obj.rosterVersionId
    };
    db.settings = Object.assign(ATT.defaultTeacherSettings(), obj.settings || {});
    // تفضيلات الجهاز لا تأتي من الحزمة
    db.settings.beepTone = old.beepTone || db.settings.beepTone;
    db.settings.beepVol = old.beepVol || db.settings.beepVol;
    db.settings.theme = old.theme || db.settings.theme;
    db.settings.onboarded = mode === "update" ? !!old.onboarded : false;
    db.classes = (obj.classes || []).map(function (c) { return { grade: c.grade, cls: c.cls }; });
    db.schedule = (obj.schedule || []).map(function (l) {
      return { day: Number(l.day), period: Number(l.period), grade: l.grade, cls: l.cls, subject: l.subject || "" };
    });
    db.students = (obj.students || []).map(function (s) {
      return { code: String(s.code), name: s.name || "", grade: s.grade || "", cls: s.cls || "" };
    });
    // db.sessions يبقى كما هو دائمًا
    persist();
    applyTheme();
    fillExtraSelects();
    renderTeacherName();
    renderToday();
    renderSettings();
  }

  /**
   * يستورد حزمة. mode: "onboarding" (مراجعة ثم بدء) أو "update" (من الإعدادات).
   */
  async function importPackFile(file, mode) {
    mode = mode === "update" ? "update" : "onboarding";
    setPackMsg(mode, "جارٍ قراءة الملف…");
    var obj;
    try {
      obj = JSON.parse(await file.text());
    } catch (e) {
      failPack(mode, "الملف ليس JSON صالحًا. اختر ملف الحزمة الذي صدّره المركز.");
      return false;
    }
    var v = ATT.validatePack(obj);
    if (!v.ok) {
      failPack(mode, packErrorText(v.errors));
      return false;
    }
    if (hasOpenSession()) {
      failPack(mode, "أنهِ الحصة المفتوحة أولًا ثم استورد الحزمة.");
      return false;
    }
    var sameTeacher = db.pack && db.pack.teacherId === obj.teacherId;
    if (db.pack && db.pack.teacherId && !sameTeacher) {
      var okTeacher = await ATT.askConfirm("حزمة معلم آخر",
        "هذه الحزمة للمعلم " + obj.teacherName + " بينما الحزمة الحالية للمعلم " + db.pack.teacherName + ". سيتم استبدال بيانات المعلم الحالية مع الإبقاء على الجلسات. هل تريد المتابعة؟",
        "استبدال");
      if (!okTeacher) { setPackMsg(mode, "أُلغيت العملية."); return false; }
    } else if (sameTeacher && db.pack.issuedAt && obj.issuedAt <= db.pack.issuedAt) {
      var okOld = await ATT.askConfirm("حزمة ليست أحدث",
        "تاريخ إصدار هذه الحزمة (" + ATT.fmtDateTime(obj.issuedAt) + ") ليس أحدث من الحالية (" + ATT.fmtDateTime(db.pack.issuedAt) + "). هل تريد المتابعة رغم ذلك؟",
        "متابعة");
      if (!okOld) { setPackMsg(mode, "أُلغيت العملية."); return false; }
    }

    var summary = packSummary(obj);
    applyPack(obj, mode);
    setPackMsg(mode, "");
    if (mode === "update") {
      ATT.toast("تم تحديث الحزمة — " + summary.students + " طالبًا و" + summary.schedule + " حصة");
      showPage("today");
    } else {
      renderReview();
      obShow(2);
      ATT.toast("تم تحميل حزمة " + summary.teacherName);
    }
    return true;
  }

  /* ======================================================================
     معالج الإعداد (Onboarding)
     ====================================================================== */
  var OB_STEPS = 4;

  function obShow(step) {
    var s = Math.max(1, Math.min(OB_STEPS, Number(step) || 1));
    if (s > 1 && !(db.pack && db.pack.teacherId)) s = 1;
    for (var i = 1; i <= OB_STEPS; i++) {
      var panel = $("obStep" + i);
      if (panel) panel.hidden = i !== s;
    }
    var lis = document.querySelectorAll("#obSteps li");
    for (var j = 0; j < lis.length; j++) {
      var n = j + 1;
      lis[j].classList.toggle("on", n === s);
      lis[j].classList.toggle("done", n < s);
      if (n === s) lis[j].setAttribute("aria-current", "step");
      else lis[j].removeAttribute("aria-current");
    }
    var badge = $("obBadge");
    if (badge) badge.textContent = "خطوة " + s + " من " + OB_STEPS;
    if (s === 2) renderReview();
    if (s === 4) setupInstallUI();
    showPage("setup");
    var h = document.querySelector("#obStep" + s + " h2");
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }

  function renderReview() {
    var dl = $("obReview");
    if (!dl) return;
    var classes = db.classes || [];
    var students = db.students || [];
    var schedule = db.schedule || [];
    dl.innerHTML =
      "<dt>المعلم</dt><dd>" + ATT.esc(db.pack.teacherName || "—") + "</dd>" +
      "<dt>المدرسة</dt><dd>" + ATT.esc(db.pack.schoolName || "—") + "</dd>" +
      "<dt>الفصول</dt><dd>" + classes.length + "</dd>" +
      "<dt>الطلاب</dt><dd>" + students.length + "</dd>" +
      "<dt>حصص الأسبوع</dt><dd>" + schedule.length + "</dd>" +
      "<dt>إصدار الحزمة</dt><dd>" + ATT.esc(ATT.fmtDateTime(db.pack.issuedAt)) + "</dd>";
    var cl = $("obReviewClasses");
    if (cl) {
      cl.textContent = classes.length
        ? "فصولك: " + classes.map(function (c) { return c.grade + " / " + c.cls; }).join("، ")
        : "";
    }
  }

  function finishOnboarding() {
    if (!(db.pack && db.pack.teacherId)) { obShow(1); return; }
    db.settings.onboarded = true;
    persist();
    fillExtraSelects();
    renderToday();
    renderSettings();
    renderTeacherName();
    var sb = $("btnSettings");
    if (sb) sb.hidden = false;
    showPage("today");
    setupTopInstall();
    ensurePersist();
    ATT.toast("أهلًا " + (db.pack.teacherName || "") + " — التطبيق جاهز");
  }

  /** يعيد المعالج إلى الخطوة 1 ويلغي الحزمة غير المؤكَّدة (الجلسات لا تُمس). */
  function resetPackDraft() {
    db.pack = ATT.defaultTeacherDb().pack;
    db.classes = [];
    db.schedule = [];
    db.students = [];
    persist();
    renderTeacherName();
    setPackMsg("onboarding", "");
    obShow(1);
    var f = $("packFile");
    if (f) { try { f.focus({ preventScroll: true }); } catch (e) { } }
  }

  var deferredPrompt = null;

  function isStandalone() {
    try {
      return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
    } catch (e) { return false; }
  }

  function setupInstallUI() {
    var state = $("installState"), row = $("installRow"), ios = $("iosHelp");
    if (!state) return;
    if (isStandalone()) {
      state.textContent = "التطبيق مثبت ويعمل الآن كتطبيق مستقل.";
      if (row) row.hidden = true;
      if (ios) ios.hidden = true;
      return;
    }
    if (ios) ios.hidden = false;
    if (deferredPrompt) {
      state.textContent = "يمكنك تثبيت التطبيق على جهازك ليعمل بملء الشاشة.";
      if (row) row.hidden = false;
    } else {
      state.textContent = "لتثبيت التطبيق: من قائمة المتصفح اختر «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية». يمكنك المتابعة الآن واستخدامه من المتصفح.";
      if (row) row.hidden = true;
    }
  }

  async function promptInstall() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (e) { }
    deferredPrompt = null;
    setupInstallUI();
    setupTopInstall();
  }

  /* ======================================================================
     PWA: الـ Service Worker، شريط التحديث، والتخزين
     ====================================================================== */
  var swReg = null;
  var swReload = false;

  function showUpdateBar(on) {
    var bar = $("updateBar");
    if (!bar) return;
    bar.classList.toggle("on", !!on);
    bar.setAttribute("aria-hidden", on ? "false" : "true");
    if (on) {
      var btn = $("btnUpdateNow");
      if (btn) { btn.disabled = false; btn.textContent = "تحديث الآن"; }
    }
  }

  /** يظهر الشريط فقط عند وجود إصدار جديد بانتظار التنشيط (لا عند أول تثبيت). */
  function maybeShowUpdate(reg) {
    if (!reg || !reg.waiting) return;
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    showUpdateBar(true);
  }

  function initSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    navigator.serviceWorker.register("../sw.js").then(function (reg) {
      swReg = reg;
      maybeShowUpdate(reg);
      reg.addEventListener("updatefound", function () {
        var nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", function () {
          if (nw.state === "installed") maybeShowUpdate(reg);
        });
      });
      // فحص هادئ بعد الإقلاع: لا يعيد التحميل أبدًا، يكتفي بإظهار الشريط.
      setTimeout(function () { try { reg.update(); } catch (e) { } }, 4000);
    }).catch(function () { });
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (!swReload) return;
      swReload = false;
      location.reload();
    });
  }

  async function applyUpdate() {
    if (!swReg || !swReg.waiting) { showUpdateBar(false); return; }
    if (getActiveSession()) {
      var ok = await ATT.askConfirm("تحديث التطبيق",
        "لديك حصة مفتوحة. ستُحفظ بياناتك على هذا الجهاز ثم تُعاد الصفحة بعد التحديث. هل تريد التحديث الآن؟",
        "تحديث الآن");
      if (!ok) return;
    }
    var btn = $("btnUpdateNow");
    if (btn) { btn.disabled = true; btn.textContent = "جارٍ التحديث…"; }
    swReload = true;
    try {
      swReg.waiting.postMessage({ type: "SKIP_WAITING" });
    } catch (e) {
      swReload = false;
      showUpdateBar(false);
      return;
    }
    // احتياط للمتصفحات التي لا تطلق controllerchange بعد skipWaiting.
    setTimeout(function () {
      if (!swReload) return;
      swReload = false;
      location.reload();
    }, 3000);
  }

  function checkUpdate() {
    if (!swReg) {
      setStorageMsg("التحديثات التلقائية تعمل عند فتح التطبيق من خادم (http/https) أو بعد تثبيته على الشاشة الرئيسية.");
      return;
    }
    setStorageMsg("جارٍ التحقق من التحديث…");
    // لا ننتظر وعد update() لأنه قد يتأخر؛ النتيجة تُقرأ من الحالة بعد مهلة قصيرة.
    try {
      var p = swReg.update();
      if (p && p.catch) p.catch(function () { });
    } catch (e) { }
    setTimeout(function () {
      if (swReg && swReg.waiting) {
        showUpdateBar(true);
        setStorageMsg("يتوفر تحديث جديد — استخدم الشريط بالأسفل.");
      } else {
        setStorageMsg(navigator.onLine === false
          ? "لا يوجد اتصال. التطبيق يعمل من النسخة المحفوظة."
          : "أنت تستخدم أحدث إصدار متاح.");
      }
    }, 2000);
  }

  function setStorageMsg(text) {
    var el = $("storageMsg");
    if (el) el.textContent = text || "";
  }

  function fmtBytes(n) {
    if (n == null || isNaN(n)) return "—";
    if (n < 1024) return n + " بايت";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " ك.ب";
    return (n / (1024 * 1024)).toFixed(1) + " م.ب";
  }

  var storageInfo = null;

  async function readStorage() {
    var info = { persisted: null, usage: null, quota: null, pct: null };
    try {
      if (navigator.storage && navigator.storage.persisted) info.persisted = await navigator.storage.persisted();
    } catch (e) { }
    try {
      if (navigator.storage && navigator.storage.estimate) {
        var est = await navigator.storage.estimate();
        info.usage = typeof est.usage === "number" ? est.usage : null;
        info.quota = typeof est.quota === "number" ? est.quota : null;
        if (info.quota) info.pct = Math.round((info.usage || 0) * 1000 / info.quota) / 10;
      }
    } catch (e) { }
    storageInfo = info;
    return info;
  }

  async function renderStorage() {
    var dl = $("storageInfo");
    var warn = $("storageWarn");
    var info = await readStorage();
    if (dl) {
      var pctTxt = info.pct == null ? "—" : info.pct + "%";
      dl.innerHTML =
        "<dt>التثبيت</dt><dd>" + (isStandalone() ? "مثبَّت كتطبيق" : "يعمل من المتصفح") + "</dd>" +
        "<dt>تخزين دائم</dt><dd>" + (info.persisted === true ? "مفعّل" : info.persisted === false ? "غير مفعّل" : "غير معروف") + "</dd>" +
        "<dt>المستخدم</dt><dd>" + ATT.esc(fmtBytes(info.usage)) + " من " + ATT.esc(fmtBytes(info.quota)) + " (" + ATT.esc(pctTxt) + ")</dd>";
    }
    if (warn) {
      var text = "";
      if (info.persisted === false) {
        text = "لم يمنح المتصفح تخزينًا دائمًا؛ قد تُحذف بيانات التطبيق عند امتلاء مساحة الجهاز. ثبّت التطبيق وأبقِ مساحة كافية.";
      }
      if (info.pct != null && info.pct >= 80) {
        text = "استخدام التخزين مرتفع (" + info.pct + "%). فرّغ مساحة على الجهاز لتجنّب فقدان البيانات.";
      }
      warn.textContent = text;
      warn.hidden = !text;
    }
  }

  /** يُطلب بعد إكمال الإعداد فقط، ثم تُعرض الحالة في الإعدادات. */
  async function ensurePersist() {
    try {
      if (navigator.storage && navigator.storage.persist && navigator.storage.persisted) {
        var already = await navigator.storage.persisted();
        if (!already) await navigator.storage.persist();
      }
    } catch (e) { }
    renderStorage();
  }

  function setupTopInstall() {
    var btn = $("btnInstallTop");
    if (!btn) return;
    btn.hidden = !(deferredPrompt && !isStandalone() && isOnboarded());
  }

  /* ======================================================================
     الإعدادات
     ====================================================================== */
  function applyTheme() {
    var theme = (db.settings && db.settings.theme) || "auto";
    var root = document.documentElement;
    if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
    else root.removeAttribute("data-theme");
  }

  function renderSettings() {
    var dl = $("setPackInfo");
    if (dl) {
      var classes = db.classes || [], students = db.students || [], schedule = db.schedule || [];
      dl.innerHTML =
        "<dt>المعلم</dt><dd>" + ATT.esc(db.pack.teacherName || "—") + "</dd>" +
        "<dt>المدرسة</dt><dd>" + ATT.esc(db.pack.schoolName || "—") + "</dd>" +
        "<dt>الفصول</dt><dd>" + classes.length + "</dd>" +
        "<dt>الطلاب</dt><dd>" + students.length + "</dd>" +
        "<dt>حصص الأسبوع</dt><dd>" + schedule.length + "</dd>" +
        "<dt>إصدار الحزمة</dt><dd>" + ATT.esc(ATT.fmtDateTime(db.pack.issuedAt)) + "</dd>" +
        "<dt>رقم إصدار القائمة</dt><dd class=\"ltr\">" + ATT.esc(db.pack.rosterVersionId || "—") + "</dd>";
    }
    var tone = $("setTone"), vol = $("setVol"), theme = $("setTheme");
    if (tone) tone.value = db.settings.beepTone || "default";
    if (vol) vol.value = db.settings.beepVol || "med";
    if (theme) theme.value = db.settings.theme || "auto";
    renderStorage();
  }

  /* ======================================================================
     فحص الكاميرا (اختياري)
     ====================================================================== */
  var test = { stream: null, running: false, timer: 0, busy: false, video: null, canvas: null, ctx: null };

  function testStatus(txt, kind) {
    var s = $("testStatus");
    if (s) s.className = "status " + (kind || "");
    var t = $("testStatusTxt");
    if (t) t.textContent = txt;
  }

  async function startTestCamera() {
    if (test.running) return;
    var vp = $("testViewport");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      testStatus("هذا المتصفح لا يدعم الكاميرا. استخدم Chrome أو Edge من رابط https أو localhost.", "err");
      return;
    }
    testStatus("جارٍ تشغيل الكاميرا…", "info");
    try {
      await ensureEngines();
      test.stream = await getStream("");
      test.video.srcObject = test.stream;
      await test.video.play();
      test.running = true;
      test.busy = false;
      if (vp) vp.classList.add("live");
      testStatus("الكاميرا تعمل. قرّب الباركود داخل الإطار.", "ok");
      testTick();
    } catch (e) {
      stopTestCamera(true);
      testStatus(camError(e), "err");
    }
  }

  function stopTestCamera(silent) {
    test.running = false;
    clearTimeout(test.timer);
    if (test.stream) {
      test.stream.getTracks().forEach(function (t) { t.stop(); });
      test.stream = null;
    }
    if (test.video) test.video.srcObject = null;
    var vp = $("testViewport");
    if (vp) vp.classList.remove("live");
    if (!silent) testStatus("الكاميرا متوقفة");
  }

  async function testTick() {
    if (!test.running) return;
    if (!test.busy && test.video && test.video.readyState >= 2 && test.video.videoWidth) {
      test.busy = true;
      try {
        var vw = test.video.videoWidth, vh = test.video.videoHeight;
        var k = Math.min(1, 1000 / vw);
        test.canvas.width = Math.round(vw * k);
        test.canvas.height = Math.round(vh * k);
        test.ctx.drawImage(test.video, 0, 0, test.canvas.width, test.canvas.height);
        var r = await decodeSource(test.canvas, test.canvas);
        if (r) {
          var m = $("testMsg");
          if (m) m.textContent = "تم التعرف على باركود: " + r.text + " (" + r.engine + ")";
          testStatus("الكاميرا تعمل والقراءة ناجحة.", "ok");
        }
      } catch (e) { }
      test.busy = false;
    }
    if (test.running) test.timer = setTimeout(testTick, 250);
  }

  function openCamTest() {
    test.video = $("testVideo");
    test.canvas = document.createElement("canvas");
    test.ctx = test.canvas.getContext("2d", { willReadFrequently: true });
    var m = $("testMsg");
    if (m) m.textContent = "";
    testStatus("الكاميرا متوقفة", "");
    var d = $("dlgCam");
    if (d) ATT.openDialog(d);
    startTestCamera();
  }

  function closeCamTest() {
    stopTestCamera(true);
    var d = $("dlgCam");
    if (d) d.close();
  }


  function renderTeacherName() {
    var el = $("teacherName");
    if (!el) return;
    var name = db.pack && db.pack.teacherName ? db.pack.teacherName : "المعلم";
    el.textContent = db.pack && db.pack.schoolName ? name + " · " + db.pack.schoolName : name;
  }

  /* ======================================================================
     حصصي اليوم
     ====================================================================== */
  function selectedDate() {
    var el = $("todayDate");
    var v = el && el.value ? el.value : "";
    return v || ATT.todayKey();
  }

  function findOpenSession() {
    var sessions = db.sessions || {};
    var keys = Object.keys(sessions);
    for (var i = 0; i < keys.length; i++) {
      var s = sessions[keys[i]];
      if (s && s.status === "open") return { key: keys[i], session: s };
    }
    return null;
  }

  function sessionForKey(key) { return (db.sessions || {})[key] || null; }

  function bellRange(period) {
    var list = (db.settings && db.settings.bellTimes) || [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i] || {};
      if (Number(b.period) === Number(period) && b.start && b.end) return b.start + " – " + b.end;
    }
    return "";
  }

  function sessionState(s) {
    if (!s) return { key: "none", label: "لم تبدأ", cls: "mute" };
    if (s.status === "open") {
      return { key: "open", label: "مفتوحة · " + countPresent(s) + "/" + (s.rosterCount || 0), cls: "ok" };
    }
    if (s.status === "no_session") return { key: "no_session", label: "تعذر التحضير", cls: "warn" };
    return { key: "closed", label: "منتهية" + (s.absentCount ? " · " + s.absentCount + " غائب" : ""), cls: "no" };
  }

  function lessonCard(lesson, date) {
    var key = ATT.sessionKey(date, lesson.period, lesson.grade, lesson.cls);
    var s = sessionForKey(key);
    var st = sessionState(s);
    var time = bellRange(lesson.period);
    var label = "الحصة " + Number(lesson.period) + " — " + lesson.grade + " " + lesson.cls + " — " + st.label;
    return '<button class="lesson" type="button" data-key="' + ATT.esc(key) + '" data-period="' + Number(lesson.period) +
      '" aria-label="' + ATT.esc(label) + '">' +
      '<span class="lesson-main">' +
      '<span class="lp">الحصة ' + Number(lesson.period) +
      (time ? ' <span class="lt">' + ATT.esc(time) + "</span>" : "") + "</span>" +
      '<span class="lc">' + ATT.esc(lesson.grade) + " / " + ATT.esc(lesson.cls) + "</span>" +
      '<span class="lm">' + ATT.esc(lesson.subject || "دون مادة") + "</span>" +
      "</span>" +
      (s && s.status !== "open" && s.sentAt ? '<span class="pill ok">أُرسلت عبر واتساب</span>' : "") +
      '<span class="pill ' + st.cls + '">' + ATT.esc(st.label) + "</span>" +
      "</button>";
  }

  function renderOpenNotice() {
    var notice = $("openNotice");
    var text = $("openNoticeText");
    var open = findOpenSession();
    if (notice) notice.hidden = !open;
    if (text && open) {
      var s = open.session;
      text.textContent = "لديك حصة مفتوحة: الحصة " + s.period + " — " + s.grade + " / " + s.cls +
        " (حضر " + countPresent(s) + " من " + (s.rosterCount || 0) + ")";
    }
  }

  function renderToday() {
    var date = selectedDate();
    var dayEl = $("todayDate");
    if (dayEl && !dayEl.value) dayEl.value = date;
    var day = ATT.dayIndex(new Date(date + "T00:00:00"));
    var nameEl = $("todayDayName");
    if (nameEl) nameEl.textContent = (ATT.DAY_NAMES[day] || "") + " · " + date;
    var lessons = ATT.lessonsForDay(db.schedule, day, db.settings && db.settings.schoolDays);
    var host = $("lessonList");
    if (host) {
      host.innerHTML = lessons.length
        ? lessons.map(function (l) { return lessonCard(l, date); }).join("")
        : '<div class="empty">لا توجد حصص في هذا اليوم.' +
          '<div style="margin-top:10px"><button class="btn" type="button" data-extra="1">حصة إضافية</button></div></div>';
    }
    var count = $("todayCount");
    if (count) count.textContent = lessons.length ? lessons.length + " حصة" : "";
    var msg = $("todayMsg");
    if (msg) msg.textContent = "";
    renderOpenNotice();

    var cur = ATT.periodAtNow(db.settings && db.settings.bellTimes, new Date());
    if (host && date === ATT.todayKey() && cur) {
      var el = host.querySelector('[data-period="' + cur + '"]');
      if (el) {
        el.classList.add("now");
        try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { }
      }
    }
    renderStale();
    renderUnsent();
  }

  /* ======================================================================
     «حصص لم تُنهَ» — جلسات مفتوحة من أيام سابقة
     ====================================================================== */
  function staleSessions() {
    var today = ATT.todayKey();
    return Object.keys(db.sessions || {}).filter(function (k) {
      var s = db.sessions[k];
      return s && s.status === "open" && s.date && s.date < today;
    }).sort(function (a, b) {
      var x = db.sessions[a] || {}, y = db.sessions[b] || {};
      return String(x.date).localeCompare(String(y.date)) || (Number(x.period) || 0) - (Number(y.period) || 0);
    });
  }

  function renderStale() {
    var card = $("staleCard"), host = $("staleList"), cnt = $("staleCount");
    var keys = staleSessions();
    if (card) card.hidden = !keys.length;
    if (cnt) cnt.textContent = keys.length ? keys.length + " حصة" : "";
    if (!host) return;
    host.innerHTML = keys.map(function (k) {
      var s = db.sessions[k];
      return '<div class="lesson stale">' +
        '<span class="lesson-main">' +
        '<span class="lp">' + ATT.esc(s.date) + " · الحصة " + Number(s.period) + "</span>" +
        '<span class="lc">' + ATT.esc(s.grade) + " / " + ATT.esc(s.cls) + "</span>" +
        '<span class="lm">حضر ' + countPresent(s) + " من " + (s.rosterCount || 0) + "</span>" +
        "</span>" +
        '<span class="stale-actions">' +
        '<button class="btn sm primary" type="button" data-stale-end="' + ATT.esc(k) + '">إنهاء وإرسال</button>' +
        '<button class="btn sm" type="button" data-stale-none="' + ATT.esc(k) + '">تعذر التحضير</button>' +
        "</span></div>";
    }).join("");
  }

  /* ======================================================================
     «حصص لم تُرسل» — جلسات مغلقة لم يُفتح لها واتساب المركز
     ====================================================================== */
  function unsentSessions() {
    return Object.keys(db.sessions || {}).filter(function (k) {
      var s = db.sessions[k];
      return s && (s.status === "closed" || s.status === "no_session") && !s.sentAt;
    }).sort(function (a, b) {
      var x = db.sessions[a] || {}, y = db.sessions[b] || {};
      return String(y.date).localeCompare(String(x.date)) || (Number(y.period) || 0) - (Number(x.period) || 0);
    });
  }

  function renderUnsent() {
    var card = $("unsentCard"), host = $("unsentList"), cnt = $("unsentCount");
    var keys = unsentSessions();
    if (card) card.hidden = !keys.length;
    if (cnt) cnt.textContent = keys.length ? keys.length + " حصة" : "";
    if (!host) return;
    host.innerHTML = keys.map(function (k) {
      var s = db.sessions[k];
      var label = s.status === "no_session" ? "تعذر التحضير" : "منتهية" +
        (s.absentCount ? " · " + s.absentCount + " غائب" : "");
      return '<div class="lesson stale">' +
        '<span class="lesson-main">' +
        '<span class="lp">' + ATT.esc(s.date) + " · الحصة " + Number(s.period) + "</span>" +
        '<span class="lc">' + ATT.esc(s.grade) + " / " + ATT.esc(s.cls) + "</span>" +
        '<span class="lm">' + ATT.esc(label) + "</span>" +
        "</span>" +
        '<span class="stale-actions">' +
        '<button class="btn sm primary" type="button" data-send-now="' + ATT.esc(k) + '">إرسال الآن</button>' +
        '<button class="btn sm" type="button" data-open-send="' + ATT.esc(k) + '">خيارات الإرسال</button>' +
        "</span></div>";
    }).join("");
  }

  async function sendNow(key) {
    var s = sessionForKey(key);
    if (!s) return;
    var number = centerWhatsapp();
    if (!number) {
      viewKey = key;
      loadSession(key);
      var sm = $("sendMsg");
      if (sm) sm.textContent = "لم يُضبط رقم المركز، اطلب حزمة محدثة.";
      return;
    }
    var msgs = sessionMessages(s);
    openWhatsapp(number, msgs[0]);
    markSessionSent(s);
    var msg = $("sendMsg");
    if (msgs.length > 1) {
      viewKey = key;
      loadSession(key);
      if (msg) msg.textContent = "تم فتح واتساب (الجزء 1 من " + msgs.length + "). أرسل بقية الأجزاء من هنا.";
    } else {
      renderToday();
      if (msg) msg.textContent = "تم فتح واتساب";
      ATT.toast("تم فتح واتساب");
    }
  }

  async function settleStale(key, mode) {
    var s = sessionForKey(key);
    if (!s || s.status !== "open") return;
    viewKey = key;
    db.activeSessionKey = key;
    persist();
    if (mode === "none") await noSession();
    else await endSession();
    renderToday();
    var active = getActiveSession();
    if (active) loadSession(active.key);
    else if (viewKey === key) { viewKey = null; showPage("today"); }
  }

  /** نقر بطاقة حصة: لم تبدأ ← فتح، مفتوحة ← متابعة، منتهية ← ملخص. */
  function onLessonClick(key) {
    var s = sessionForKey(key);
    if (!s) {
      var p = ATT.parseSessionKey(key);
      if (p.date) startLesson(p.date, p.period, p.grade, p.cls);
      return;
    }
    if (s.status === "open") { loadSession(key); return; }
    openSummary(key);
  }

  /* ======================================================================
     فتح الحصة وقاعدة «جلسة واحدة نشطة»
     ====================================================================== */
  var activeResolver = null;

  function askActiveSession(s) {
    return new Promise(function (res) {
      var d = $("dlgActive");
      if (!d) {
        var ok = window.confirm("لديك حصة مفتوحة (الحصة " + s.period + " — " + s.grade + " / " + s.cls +
          "). هل تريد العودة إليها؟");
        res(ok ? "resume" : "cancel");
        return;
      }
      var t = $("actText");
      if (t) t.textContent = "لديك حصة مفتوحة (الحصة " + s.period + " — " + s.grade + " / " + s.cls +
        "). لا يمكن فتح حصة ثانية قبل إنهائها.";
      activeResolver = res;
      ATT.openDialog(d);
    });
  }

  function settleActive(choice) {
    var res = activeResolver;
    activeResolver = null;
    var d = $("dlgActive");
    if (d && d.open) d.close();
    if (res) res(choice);
  }

  function loadSession(key) {
    var s = sessionForKey(key);
    if (!s) return false;
    viewKey = key;
    if (s.status === "open") db.activeSessionKey = key;
    ensureSessionRosterCount(s);
    persist();
    showPage("session");
    renderSessionUI();
    var sm = $("sessMsg");
    if (sm) sm.textContent = s.status === "open"
      ? ""
      : "هذه الحصة مغلقة. يمكنك إعادة تصديرها أو إعادة فتحها من حصصي اليوم.";
    if (s.status === "open") setStatus("الكاميرا متوقفة. شغّلها أو استخدم الإدخال اليدوي.", "");
    renderOpenNotice();
    return true;
  }

  /**
   * يفتح حصة بعد التحقق من عدم وجود حصة أخرى مفتوحة.
   * يرجع "opened" أو "blocked".
   */
  async function startLesson(date, period, grade, cls) {
    if (!isOnboarded()) { obShow(db.pack && db.pack.teacherId ? 2 : 1); return "blocked"; }
    period = Number(period) || 1;
    if (!date || !grade || !cls) { ATT.toast("اختر التاريخ والصف والفصل."); return "blocked"; }
    if (!classExists(grade, cls)) { ATT.toast("هذا الفصل ليس ضمن حزمتك."); return "blocked"; }
    var key = ATT.sessionKey(date, period, grade, cls);
    var open = findOpenSession();
    if (open && open.key !== key) {
      var choice = await askActiveSession(open.session);
      if (choice === "resume") { loadSession(open.key); return "blocked"; }
      if (choice !== "end") { renderToday(); return "blocked"; }
      loadSession(open.key);
      await endSession();
      if (findOpenSession()) { loadSession(open.key); return "blocked"; }
    }
    var res = getSession(date, period, grade, cls);
    if (res.session.status !== "open") { openSummary(res.key); return "blocked"; }
    res.session.teacher = db.pack.teacherName || res.session.teacher;
    db.activeSessionKey = res.key;
    viewKey = res.key;
    ensureSessionRosterCount(res.session);
    persist();
    loadSession(res.key);
    return "opened";
  }

  /* ======================================================================
     حصة إضافية خارج الجدول
     ====================================================================== */
  function fillExtraSelects() {
    var periodSel = $("extraPeriod");
    if (periodSel) {
      var max = Math.max(1, Number(db.settings.periodsPerDay) || 7);
      var cur = periodSel.value;
      var html = "";
      for (var i = 1; i <= max; i++) html += '<option value="' + i + '">الحصة ' + i + "</option>";
      periodSel.innerHTML = html;
      if (cur && Number(cur) <= max) periodSel.value = cur;
    }
    var gradeSel = $("extraGrade");
    if (gradeSel) {
      var curG = gradeSel.value;
      var grades = [];
      (db.classes || []).forEach(function (c) {
        if (grades.indexOf(c.grade) < 0) grades.push(c.grade);
      });
      grades.sort(ATT.collator.compare);
      gradeSel.innerHTML = '<option value="">اختر الصف</option>' + grades.map(function (g) {
        return '<option value="' + ATT.esc(g) + '">' + ATT.esc(g) + "</option>";
      }).join("");
      gradeSel.value = grades.indexOf(curG) >= 0 ? curG : "";
    }
    fillExtraClasses();
  }

  function fillExtraClasses() {
    var gradeSel = $("extraGrade");
    var clsSel = $("extraClass");
    if (!clsSel) return;
    var g = gradeSel ? gradeSel.value : "";
    var values = (db.classes || []).filter(function (c) { return !g || c.grade === g; }).map(function (c) { return c.cls; });
    var unique = [];
    values.forEach(function (v) { if (unique.indexOf(v) < 0) unique.push(v); });
    unique.sort(ATT.collator.compare);
    var cur = clsSel.value;
    clsSel.innerHTML = '<option value="">اختر الفصل</option>' + unique.map(function (c) {
      return '<option value="' + ATT.esc(c) + '">' + ATT.esc(c) + "</option>";
    }).join("");
    clsSel.value = unique.indexOf(cur) >= 0 ? cur : "";
  }

  function classExists(grade, cls) {
    return (db.classes || []).some(function (c) { return c.grade === grade && c.cls === cls; });
  }

  function openExtraDialog(date) {
    var d = $("dlgExtra");
    if (!d) return;
    fillExtraSelects();
    var dt = $("extraDate");
    if (dt) dt.value = date || ATT.todayKey();
    var msg = $("extraMsg");
    if (msg) msg.textContent = "";
    ATT.openDialog(d);
  }

  async function onExtraSubmit(e) {
    if (e) e.preventDefault();
    var date = $("extraDate") ? $("extraDate").value : "";
    var period = Number($("extraPeriod") ? $("extraPeriod").value : 1);
    var grade = $("extraGrade") ? $("extraGrade").value : "";
    var cls = $("extraClass") ? $("extraClass").value : "";
    var msg = $("extraMsg");
    if (!date) { if (msg) msg.textContent = "اختر التاريخ."; return; }
    if (!grade || !cls) { if (msg) msg.textContent = "اختر الصف والفصل."; return; }
    if (!classExists(grade, cls)) { if (msg) msg.textContent = "هذا الفصل ليس ضمن حزمتك."; return; }
    var d = $("dlgExtra");
    if (d && d.open) d.close();
    await startLesson(date, period, grade, cls);
  }

  /* ======================================================================
     ملخص الحصة المنتهية وإعادة التصدير/الفتح
     ====================================================================== */
  var summaryKey = null;

  function absentForSession(s) {
    var roster = ensureSessionRosterCount(s);
    var present = s.present || {};
    return roster.filter(function (st) { return !present[st.code]; });
  }

  function openSummary(key) {
    var s = sessionForKey(key);
    if (!s) return;
    summaryKey = key;
    var st = sessionState(s);
    var body = $("sumBody");
    if (body) {
      var list = s.exports || [];
      var last = s.lastExport || list[list.length - 1];
      body.innerHTML =
        "<dt>التاريخ</dt><dd>" + ATT.esc(s.date) + "</dd>" +
        "<dt>الحصة</dt><dd>" + Number(s.period) + "</dd>" +
        "<dt>الفصل</dt><dd>" + ATT.esc(s.grade) + " / " + ATT.esc(s.cls) + "</dd>" +
        "<dt>الحالة</dt><dd>" + ATT.esc(st.label) + "</dd>" +
        "<dt>الطلاب</dt><dd>" + (s.rosterCount || 0) + "</dd>" +
        "<dt>الحاضرون</dt><dd>" + countPresent(s) + "</dd>" +
        "<dt>الغائبون</dt><dd>" + (s.status === "no_session" ? 0 : (s.absentCount || 0)) + "</dd>" +
        "<dt>آخر ملف</dt><dd>" + ATT.esc(last ? ATT.fmtDateTime(last.exportedAt) + (last.version ? " · إصدار " + last.version : "") : "لم يُنشأ بعد") + "</dd>" +
        "<dt>إرسال واتساب</dt><dd>" + ATT.esc(s.sentAt ? ATT.fmtDateTime(s.sentAt) : "لم يُرسل بعد") + "</dd>";
    }
    var msg = $("sumMsg");
    if (msg) msg.textContent = "";
    var reopen = $("sumReopen");
    if (reopen) reopen.hidden = s.status !== "closed";
    var summSend = $("sumSend");
    if (summSend) summSend.hidden = s.status !== "closed" && s.status !== "no_session";
    var d = $("dlgSummary");
    if (d) ATT.openDialog(d);
  }

  async function reExportSession(key) {
    var s = sessionForKey(key);
    if (!s) return;
    var absent = s.status === "no_session" ? [] : absentForSession(s);
    var r = await exportSessionExcel(s, absent);
    var msg = $("sumMsg");
    if (r) {
      if (msg) msg.textContent = r.reused
        ? "لم يتغير المحتوى: أُعيد نفس ملف الغياب — " + r.name + " (سيتجاهله المركز لأنه مستورد)."
        : "تم إنشاء ملف الغياب: " + r.name;
      ATT.toast(r.reused ? "أُعيد إنشاء نفس الملف" : "تم إنشاء ملف الغياب");
    } else if (msg) {
      msg.textContent = "تعذر إنشاء الملف. تحقق من توفر مكتبة Excel المحلية.";
    }
    renderToday();
  }

  async function reopenClosed(key) {
    var s = sessionForKey(key);
    if (!s || s.status !== "closed") return;
    var ok = await ATT.askConfirm("إعادة فتح الحصة",
      "ستُعاد الحصة إلى حالة مفتوحة ويمكن تعديل الحضور. سيُولَّد ملف جديد عند الإنهاء. هل تريد المتابعة؟",
      "إعادة فتح");
    if (!ok) return;
    s.status = "open";
    s.closedAt = null;
    s.sentAt = null;
    s.sendPlan = null;
    s.reopenedAt = (s.reopenedAt || []).concat(new Date().toISOString());
    db.activeSessionKey = key;
    persist();
    var d = $("dlgSummary");
    if (d && d.open) d.close();
    loadSession(key);
    renderToday();
  }

  /* ======================================================================
     الجلسات
     ====================================================================== */
  function getSession(date, period, grade, cls) {
    if (!db.sessions) db.sessions = {};
    var k = ATT.sessionKey(date, period, grade, cls);
    if (!db.sessions[k]) {
      db.sessions[k] = {
        id: ATT.uid(), date: date, period: Number(period) || 1, grade: grade || "", cls: cls || "",
        teacher: db.pack.teacherName || "", status: "open", reason: "",
        rosterCount: 0, presentCount: 0, absentCount: 0,
        present: {}, closedAt: null, exports: []
      };
    }
    return { key: k, session: db.sessions[k] };
  }

  function ensureSessionRosterCount(s) {
    var list = (db.students || []).filter(function (st) { return st.grade === s.grade && st.cls === s.cls; });
    s.rosterCount = list.length;
    return list;
  }

  function countPresent(s) {
    return Object.keys(s.present || {}).length;
  }

  function setTab(tab) {
    view.tab = tab === "absent" ? "absent" : "present";
    renderSessionUI();
  }

  function renderSessionUI() {
    var s = viewSession();
    var info = $("sessionInfo");
    if (info) {
      info.textContent = s ? (s.date + " | الحصة " + s.period + " | " + s.grade + " / " + s.cls +
        (s.status === "open" ? " | مفتوحة" : (s.sentAt ? " | أُرسلت عبر واتساب" : " | مغلقة"))) : "لا توجد جلسة";
    }
    var stats = $("sessionStats");
    var sendCard = $("sendCard");
    var sessionActions = $("sessionActions");
    if (!s) {
      if (stats) stats.innerHTML = "";
      if (sendCard) sendCard.hidden = true;
      if (sessionActions) sessionActions.hidden = false;
      return;
    }
    if (sendCard) sendCard.hidden = s.status === "open";
    if (sessionActions) sessionActions.hidden = s.status !== "open";
    var roster = ensureSessionRosterCount(s);
    var present = countPresent(s);
    var absent = Math.max(0, roster.length - present);
    var pct = roster.length ? Math.round(present / roster.length * 100) : 0;
    if (stats) {
      stats.innerHTML =
        '<div class="stat p"><b>' + present + "</b><span>حاضر</span></div>" +
        '<div class="stat a"><b>' + absent + "</b><span>غائب</span></div>" +
        '<div class="stat"><b>' + roster.length + "</b><span>إجمالي الفصل</span></div>";
    }
    var meter = $("meter");
    if (meter) meter.style.width = pct + "%";

    var presentList = roster.filter(function (st) { return s.present && s.present[st.code]; })
      .sort(function (a, b) { return String(s.present[b.code]).localeCompare(String(s.present[a.code])); });
    var absentList = roster.filter(function (st) { return !(s.present && s.present[st.code]); })
      .sort(function (a, b) { return ATT.collator.compare(a.name, b.name); });

    var tabP = $("tabP"), tabA = $("tabA");
    if (tabP) {
      tabP.setAttribute("aria-selected", String(view.tab === "present"));
      tabP.tabIndex = view.tab === "present" ? 0 : -1;
      tabP.textContent = "الحاضرون (" + presentList.length + ")";
    }
    if (tabA) {
      tabA.setAttribute("aria-selected", String(view.tab === "absent"));
      tabA.tabIndex = view.tab === "absent" ? 0 : -1;
      tabA.textContent = "الغائبون (" + absentList.length + ")";
    }
    var panel = $("listPanel");
    if (panel) panel.setAttribute("aria-labelledby", view.tab === "present" ? "tabP" : "tabA");
    var count = $("listCount");
    if (count) count.textContent = roster.length + " طالبًا";

    // حالة الأزرار تُحدَّث قبل أي خروج مبكر (القوائم الفارغة)
    var end = $("btnEndSession"), no = $("btnNoSession");
    if (end) end.disabled = s.status !== "open";
    if (no) no.disabled = s.status !== "open";
    renderSendCard();

    var t = $("listTbl");
    if (!t) return;
    var list = view.tab === "present" ? presentList : absentList;
    var isP = view.tab === "present";
    t.setAttribute("aria-label", isP ? "قائمة الحاضرين" : "قائمة الغائبين");
    if (!roster.length) {
      t.innerHTML = '<tbody><tr><td class="empty" colspan="4">لا يوجد طلاب في فصل هذه الجلسة.</td></tr></tbody>';
      return;
    }
    if (!list.length) {
      t.innerHTML = '<tbody><tr><td class="empty" colspan="4">' +
        (isP ? "لم يُسجَّل أي حضور بعد. ابدأ بمسح باركود طالب." : "لا يوجد غائبون. حضر الجميع.") +
        "</td></tr></tbody>";
      return;
    }
    t.innerHTML = '<thead><tr><th scope="col">#</th><th scope="col">الاسم</th><th scope="col">الكود</th>' +
      '<th scope="col">' + (isP ? "وقت الحضور" : "الحالة") + "</th></tr></thead><tbody>" +
      list.map(function (st, i) {
        return "<tr><td>" + (i + 1) + '</td><td class="name">' + ATT.esc(st.name) +
          '</td><td class="code">' + ATT.esc(st.code) + "</td><td>" +
          (isP ? ATT.esc(ATT.fmtTime(s.present[st.code])) : '<span class="pill no">غائب</span>') +
          "</td></tr>";
      }).join("") + "</tbody>";
  }

  function showResult(kind, title, sub) {
    var r = $("result");
    if (!r) return;
    r.className = "result " + kind;
    r.innerHTML = "<b>" + ATT.esc(title) + '</b><span class="small">' + ATT.esc(sub) + "</span>";
    void r.offsetWidth;
    r.classList.add("flash");
  }

  async function registerByCode(raw) {
    var code = ATT.toLatinDigits(String(raw == null ? "" : raw).trim());
    if (!code) return false;
    var active = getActiveSession();
    if (!active) {
      showResult("err", "لا توجد حصة مفتوحة", "افتح الحصة أولًا ثم امسح الباركود.");
      return false;
    }
    if (viewKey && viewKey !== active.key) {
      showResult("err", "هذه الجلسة ليست المفتوحة", "ارجع إلى «حصصي اليوم» وافتح الحصة المفتوحة.");
      return false;
    }
    var now = Date.now();
    if (code === scan.last.code && now - scan.last.at < 2500) {
      scan.last.at = now;
      return false;
    }
    scan.last = { code: code, at: now };
    var st = ATT.findStudent(db.students, code);
    if (!st) {
      showResult("err", "باركود غير مسجل", "الكود: " + code + " — ليس ضمن طلاب حزمتك.");
      beep("err");
      return false;
    }
    var s = active.session;
    if (st.grade !== s.grade || st.cls !== s.cls) {
      beep("warn");
      var ok = await ATT.askConfirm("طالب من فصل آخر",
        "هذا الطالب من فصل مختلف عن جلسة الحصة الحالية. هل تريد تسجيله رغم ذلك؟", "تسجيل رغم ذلك");
      if (!ok) {
        showResult("warn", "لم يتم التسجيل", st.name + " — فصل مختلف");
        return false;
      }
    }
    var present = s.present || (s.present = {});
    if (present[st.code]) {
      showResult("warn", "مسجل مسبقًا", st.name + " — الساعة " + ATT.fmtTime(present[st.code]));
      beep("warn");
      return false;
    }
    present[st.code] = new Date().toISOString();
    s.present = present;
    s.presentCount = Object.keys(present).length;
    var roster = ensureSessionRosterCount(s);
    s.absentCount = Math.max(0, roster.length - s.presentCount);
    persist();
    showResult("ok", st.name, [st.grade, st.cls].filter(Boolean).join(" / ") + " — تم تسجيل الحضور");
    beep("ok");
    if (navigator.vibrate) { try { navigator.vibrate(35); } catch (e) { } }
    renderSessionUI();
    return true;
  }

  /* ======================================================================
     الإرسال عبر واتساب والملف
     ====================================================================== */
  function centerWhatsapp() {
    var fromSettings = db.settings && db.settings.centerWhatsapp ? db.settings.centerWhatsapp : "";
    var fromPack = db.pack && db.pack.settings ? db.pack.settings.centerWhatsapp : "";
    var n = ATT.normalizeWhatsapp(fromSettings || fromPack || "");
    return n && ATT.isValidWhatsapp(n) ? n : "";
  }

  function includeNamesSetting() {
    if (db.settings && typeof db.settings.includeNames === "boolean") return db.settings.includeNames;
    return !!(db.pack && db.pack.settings && db.pack.settings.includeNames);
  }

  /** يثبّت مرجع الملف (fileId/version) للجلسة دون إنشاء ملف، ليبقى نفسه في الرسالة والمشاركة. */
  function sessionPlan(s) {
    var absent = s.status === "no_session" ? [] : absentForSession(s);
    var codes = absent.map(function (st) { return String(st.code); });
    var contentHash = ATT.contentHash(s, codes);
    if (s.sendPlan && s.sendPlan.fileId && s.sendPlan.contentHash === contentHash) {
      return { plan: s.sendPlan, absent: absent };
    }
    var next = ATT.nextExport(s.lastExport, { contentHash: contentHash });
    s.sendPlan = {
      fileId: next.fileId, exportedAt: next.exportedAt, version: next.version,
      contentHash: contentHash, reused: !!next.reused
    };
    persist();
    return { plan: s.sendPlan, absent: absent };
  }

  function sessionMessages(s) {
    var r = sessionPlan(s);
    return ATT.buildAbsenceMessage(s, r.absent, {
      unable: s.status === "no_session",
      includeNames: includeNamesSetting(),
      rosterCount: s.rosterCount,
      presentCount: s.presentCount,
      fileId: r.plan.fileId,
      fileVersion: r.plan.version
    });
  }

  function openWhatsapp(number, text) {
    var url = "https://wa.me/" + number + "?text=" + encodeURIComponent(text);
    var w = window.open(url, "_blank", "noopener");
    if (!w) {
      // بديل عند حجب النوافذ: رابط حقيقي يُنقر برمجيًا داخل معالج النقر نفسه.
      var a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    return url;
  }

  function markSessionSent(s) {
    s.sentAt = new Date().toISOString();
    persist();
    renderToday();
  }

  function buildSessionWorkbook(session, absentList, plan) {
    var payload = ATT.buildAbsencePayload({
      session: session,
      absent: absentList || [],
      rosterVersionId: db.pack.rosterVersionId,
      teacherId: db.pack.teacherId,
      fileId: plan.fileId,
      exportedAt: plan.exportedAt,
      fileVersion: plan.version
    });
    var meta = [
      ["key", "value"],
      ["format", payload.format],
      ["formatVersion", payload.formatVersion],
      ["fileId", payload.fileId],
      ["date", payload.date],
      ["period", payload.period],
      ["grade", payload.grade],
      ["cls", payload.cls],
      ["teacher", payload.teacher],
      ["status", payload.status],
      ["reason", payload.reason],
      ["rosterCount", payload.rosterCount],
      ["presentCount", payload.presentCount],
      ["absentCount", payload.absentCount],
      ["rosterVersionId", payload.rosterVersionId],
      ["exportedAt", payload.exportedAt],
      ["appVersion", payload.appVersion],
      ["fileVersion", payload.fileVersion]
    ];
    if (payload.teacherId) meta.push(["teacherId", payload.teacherId]);
    meta.push(["checksum", payload.checksum]);

    var absentRows = [["code", "name", "grade", "cls"]];
    (absentList || []).forEach(function (st) {
      absentRows.push([String(st.code), st.name || "", st.grade || "", st.cls || ""]);
    });
    var wb = XLSX.utils.book_new();
    var wsMeta = XLSX.utils.aoa_to_sheet(meta); wsMeta["!views"] = [{ rightToLeft: true }];
    var wsAbs = XLSX.utils.aoa_to_sheet(absentRows); wsAbs["!views"] = [{ rightToLeft: true }];
    XLSX.utils.book_append_sheet(wb, wsMeta, "Meta");
    XLSX.utils.book_append_sheet(wb, wsAbs, "Absent");
    var name = ATT.sanitizeFileName("ABS_" + payload.date + "_P" + payload.period + "_" + payload.grade + "-" + payload.cls + ".xlsx");
    var out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    var blob = new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    return { payload: payload, name: name, blob: blob };
  }

  function recordProducedFile(session, plan) {
    if (session.sentAt && session.lastExport && session.lastExport.fileId !== plan.fileId) {
      session.sentAt = null;
    }
    session.lastExport = {
      fileId: plan.fileId, contentHash: plan.contentHash,
      exportedAt: plan.exportedAt, version: plan.version
    };
    session.exports = session.exports || [];
    session.exports.push({
      fileId: plan.fileId, exportedAt: plan.exportedAt, version: plan.version, reused: !!plan.reused
    });
    persist();
  }

  async function exportSessionExcel(session, absentList) {
    if (!(await ATT.loadLib("xlsx"))) {
      ATT.toast("تعذر تحميل مكتبة Excel المحلية.");
      return null;
    }
    var plan = session.sendPlan && session.sendPlan.fileId
      ? session.sendPlan : sessionPlan(session).plan;
    var built = buildSessionWorkbook(session, absentList, plan);
    ATT.downloadBlob(built.name, built.blob);
    recordProducedFile(session, plan);
    renderSessionUI();
    return { payload: built.payload, name: built.name, reused: !!plan.reused };
  }

  async function shareSessionFile(session) {
    if (!session) return false;
    if (!(await ATT.loadLib("xlsx"))) {
      ATT.toast("تعذر تحميل مكتبة Excel المحلية.");
      return false;
    }
    var r = sessionPlan(session);
    var built = buildSessionWorkbook(session, r.absent, r.plan);
    var file = null;
    try { file = new File([built.blob], built.name, { type: built.blob.type }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      try {
        await navigator.share({ files: [file], title: "ملف غياب " + session.date });
        recordProducedFile(session, r.plan);
        ATT.toast("تمت مشاركة الملف");
        renderSessionUI();
        return true;
      } catch (e) {
        if (e && e.name === "AbortError") return false;
      }
    }
    ATT.downloadBlob(built.name, built.blob);
    recordProducedFile(session, r.plan);
    ATT.toast("تم تنزيل ملف الغياب");
    renderSessionUI();
    return true;
  }

  function sendMessagePart(s, msgs, index) {
    var number = centerWhatsapp();
    if (!number) {
      var notice = $("noWaNotice");
      if (notice) notice.hidden = false;
      ATT.toast("لم يُضبط رقم المركز، اطلب حزمة محدثة");
      return;
    }
    openWhatsapp(number, msgs[index]);
    markSessionSent(s);
    var msg = $("sendMsg");
    if (msg) msg.textContent = "تم فتح واتساب" +
      (msgs.length > 1 ? " (الجزء " + (index + 1) + " من " + msgs.length + ")" : "");
    ATT.toast("تم فتح واتساب");
    renderSendCard();
  }

  function renderSendCard() {
    var s = viewSession();
    var card = $("sendCard");
    if (!card) return;
    if (!s || s.status === "open") { card.hidden = true; return; }
    card.hidden = false;

    var msgs = sessionMessages(s);
    var number = centerWhatsapp();
    var info = $("sendInfo");
    if (info) {
      info.textContent = s.date + " · الحصة " + s.period + " · " + s.grade + " / " + s.cls +
        (msgs.length > 1 ? " · ستُرسل في " + msgs.length + " أجزاء" : "");
    }
    var notice = $("noWaNotice");
    if (notice) notice.hidden = !!number;
    var badge = $("sendBadge");
    if (badge) badge.hidden = !s.sentAt;

    var host = $("sendActions");
    if (!host) return;
    host.innerHTML = "";

    function add(label, cls, onClick) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = cls;
      b.textContent = label;
      b.onclick = onClick;
      host.appendChild(b);
    }

    if (!number) {
      add("مشاركة الملف", "btn primary lg wide", function () { shareSessionFile(s); });
      return;
    }
    if (msgs.length === 1) {
      add("إرسال للمركز عبر واتساب", "btn primary lg wide", function () {
        sendMessagePart(s, msgs, 0);
      });
    } else {
      msgs.forEach(function (m, i) {
        add("إرسال الجزء " + (i + 1) + " من " + msgs.length, i === 0 ? "btn primary lg wide" : "btn lg wide", function () {
          sendMessagePart(s, msgs, i);
        });
      });
    }
    add("مشاركة الملف", "btn wide", function () { shareSessionFile(s); });
  }

  async function endSession() {
    var active = getActiveSession();
    if (!active) return;
    if (viewKey && viewKey !== active.key) return;
    var s = active.session;
    var roster = ensureSessionRosterCount(s);
    var present = s.present || {};
    var absent = roster.filter(function (st) { return !present[st.code]; });
    s.presentCount = Object.keys(present).length;
    s.absentCount = absent.length;
    var ok = await ATT.askConfirm("إنهاء الحصة",
      "عدد الطلاب: " + roster.length + " | حاضرون: " + s.presentCount + " | غائبون: " + absent.length +
      ". ستُفتح خيارات إرسال الغياب إلى المركز عبر واتساب أو مشاركة الملف.", "إنهاء الحصة");
    if (!ok) return;
    stopScan(true);
    s.status = "closed";
    s.closedAt = new Date().toISOString();
    s.sentAt = null;
    s.sendPlan = null;
    db.activeSessionKey = null;
    persist();
    renderSessionUI();
    var sm = $("sessMsg");
    if (sm) sm.textContent = "أُغلقت الحصة. أرسل الغياب إلى المركز عبر واتساب أو شارك الملف من الأسفل.";
    ATT.toast("أُغلقت الحصة");
  }

  async function noSession() {
    var active = getActiveSession();
    if (!active) return;
    if (viewKey && viewKey !== active.key) return;
    var s = active.session;
    var ok = await ATT.askConfirm("تعذر التحضير",
      "سيتم إغلاق الجلسة بحالة «تعذر التحضير». هل تريد المتابعة؟", "متابعة");
    if (!ok) return;
    stopScan(true);
    s.status = "no_session";
    s.reason = "تعذر التحضير";
    s.present = s.present || {};
    s.presentCount = Object.keys(s.present).length;
    ensureSessionRosterCount(s);
    s.absentCount = 0;
    s.closedAt = new Date().toISOString();
    s.sentAt = null;
    s.sendPlan = null;
    db.activeSessionKey = null;
    persist();
    renderSessionUI();
    var sm = $("sessMsg");
    if (sm) sm.textContent = "أُغلقت الجلسة بحالة «تعذر التحضير». أرسل الإشعار إلى المركز عبر واتساب أو شارك الملف.";
    ATT.toast("أُغلقت الجلسة");
  }

  /* ======================================================================
     الصوت
     ====================================================================== */
  var actx = null;
  function beep(kind) {
    try {
      var tone = db.settings && db.settings.beepTone ? db.settings.beepTone : "default";
      var vol = db.settings && db.settings.beepVol ? db.settings.beepVol : "med";
      var vols = { silent: 0, low: 0.08, med: 0.18, high: 0.32 };
      var gainVal = vols[vol] !== undefined ? vols[vol] : 0.18;
      if (gainVal === 0 && kind === "ok") return;
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.connect(g); g.connect(actx.destination);
      var freq = kind === "ok" ? 1000 : kind === "warn" ? 620 : 300;
      var type = "sine";
      if (kind === "ok") {
        if (tone === "click") { freq = 1200; type = "square"; }
        else if (tone === "short") { freq = 880; type = "sine"; }
      }
      o.frequency.value = freq; o.type = type;
      var dur = kind === "err" ? 0.4 : 0.18;
      g.gain.setValueAtTime(gainVal, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
      o.start(); o.stop(actx.currentTime + dur);
    } catch (e) { }
  }

  /* ======================================================================
     الكاميرا والماسح
     ====================================================================== */
  var WANTED = ["code_128", "code_39", "code_93", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "codabar", "qr_code", "data_matrix"];
  var detector = null, zxReader = null, zxHints = null, engineReady = false;
  var video = null, work = null, wctx = null;
  var scan = { stream: null, running: false, timer: 0, busy: false, last: { code: "", at: 0 }, frames: 0 };

  /* إبقاء الشاشة مضاءة أثناء المسح (اختياري حسب دعم المتصفح). */
  var wakeLock = null;
  async function requestWakeLock() {
    if (!navigator.wakeLock || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", function () { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  function releaseWakeLock() {
    var w = wakeLock;
    wakeLock = null;
    if (w) { try { w.release(); } catch (e) { } }
  }
  var pref = {
    get: function (k) { try { return localStorage.getItem("att_pref_" + k) || ""; } catch (e) { return ""; } },
    set: function (k, v) { try { localStorage.setItem("att_pref_" + k, v); } catch (e) { } }
  };

  function setStatus(txt, kind) {
    var s = $("status");
    if (s) s.className = "status " + (kind || "");
    var t = $("statusTxt");
    if (t) t.textContent = txt;
  }

  function camError(e) {
    switch (e && e.name) {
      case "NotAllowedError": case "SecurityError": return "تم رفض إذن الكاميرا. اضغط أيقونة القفل بجوار عنوان الصفحة ثم اسمح بالكاميرا وأعد المحاولة.";
      case "NotFoundError": case "DevicesNotFoundError": return "لم يتم العثور على كاميرا في هذا الجهاز.";
      case "NotReadableError": case "TrackStartError": return "الكاميرا مستخدمة من برنامج آخر. أغلق البرامج الأخرى التي تستخدمها وأعد المحاولة.";
      case "OverconstrainedError": return "الكاميرا المختارة غير متاحة. اختر كاميرا أخرى.";
      default: return "تعذر تشغيل الكاميرا" + (e && e.message ? " (" + e.message + ")" : "") + ".";
    }
  }

  async function refreshCams() {
    try {
      var list = (await navigator.mediaDevices.enumerateDevices()).filter(function (d) { return d.kind === "videoinput"; });
      var sel = $("camSel");
      if (!sel) return;
      var cur = sel.value || pref.get("cam");
      sel.innerHTML = '<option value="">الكاميرا الافتراضية</option>' + list.map(function (d, i) {
        return '<option value="' + ATT.esc(d.deviceId) + '">' + ATT.esc(d.label || "كاميرا " + (i + 1)) + "</option>";
      }).join("");
      if ([].some.call(sel.options, function (o) { return o.value === cur; })) sel.value = cur;
    } catch (e) { }
  }

  var BASE_VIDEO = { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } };
  async function getStream(deviceId) {
    try {
      var constraints = { video: deviceId ? Object.assign({}, BASE_VIDEO, { deviceId: { exact: deviceId } }) : BASE_VIDEO, audio: false };
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      if (e && e.name === "OverconstrainedError") {
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }
      throw e;
    }
  }

  async function ensureEngines() {
    if (engineReady) return;
    if ("BarcodeDetector" in window) {
      try {
        var sup = await BarcodeDetector.getSupportedFormats();
        var fm = WANTED.filter(function (f) { return sup.indexOf(f) >= 0; });
        if (fm.indexOf("code_128") >= 0) detector = new BarcodeDetector({ formats: fm });
      } catch (e) { detector = null; }
    }
    await ATT.loadLib("zxing");
    if (window.ZXing && !zxReader) {
      var Z = window.ZXing;
      zxReader = new Z.MultiFormatReader();
      zxHints = new Map();
      var B = Z.BarcodeFormat;
      zxHints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [B.CODE_128, B.CODE_39, B.CODE_93, B.EAN_13, B.EAN_8, B.UPC_A, B.UPC_E, B.ITF, B.CODABAR, B.QR_CODE, B.DATA_MATRIX]);
      zxHints.set(Z.DecodeHintType.TRY_HARDER, true);
    }
    engineReady = true;
    var info = $("engineInfo");
    if (info) info.textContent = detector ? "BarcodeDetector" : (zxReader ? "ZXing" : "لا يوجد محرك");
  }

  function zxDecode(canvas) {
    if (!zxReader) return null;
    try {
      var lum = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      return zxReader.decode(new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum)), zxHints).getText();
    } catch (e) { return null; }
  }

  async function decodeSource(src, canvas) {
    if (detector) {
      try {
        var r = await detector.detect(src);
        if (r.length) return { text: r[0].rawValue, engine: "BarcodeDetector" };
      } catch (e) { }
    }
    var t = zxDecode(canvas);
    if (t) return { text: t, engine: "ZXing" };
    return null;
  }

  async function startScan() {
    if (scan.running) return;
    if (!getActiveSession()) { setStatus("افتح الحصة أولًا قبل تشغيل الكاميرا.", "err"); return false; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("هذا المتصفح لا يدعم الكاميرا. استخدم Chrome أو Edge وافتح الصفحة من رابط https أو localhost.", "err");
      return false;
    }
    var btnStart = $("btnStart");
    setStatus("جارٍ تشغيل الكاميرا…", "info");
    if (btnStart) btnStart.disabled = true;
    try {
      await ensureEngines();
      if (!detector && !zxReader) {
        setStatus("تعذر تحميل مكتبة قراءة الباركود المحلية (vendor/zxing.min.js).", "err");
        if (btnStart) btnStart.disabled = false;
        return false;
      }
      scan.stream = await getStream($("camSel").value);
      video.srcObject = scan.stream;
      await video.play();
      await refreshCams();
      var track = scan.stream.getVideoTracks()[0];
      var id = track ? track.getSettings().deviceId : "";
      var camSel = $("camSel");
      if (id && camSel && [].some.call(camSel.options, function (o) { return o.value === id; })) camSel.value = id;
      if (camSel) pref.set("cam", camSel.value);
      scan.running = true; scan.frames = 0; scan.last = { code: "", at: 0 };
      var vp = $("viewport");
      if (vp) vp.classList.add("live");
      var btnStop = $("btnStop");
      if (btnStop) btnStop.disabled = false;
      setStatus("الكاميرا تعمل. قرّب الباركود داخل الإطار.", "ok");
      requestWakeLock();
      tick();
      return true;
    } catch (e) {
      stopScan(true);
      setStatus(camError(e), "err");
      return false;
    }
  }

  function stopScan(silent) {
    scan.running = false;
    clearTimeout(scan.timer);
    releaseWakeLock();
    if (scan.stream) {
      scan.stream.getTracks().forEach(function (t) { t.stop(); });
      scan.stream = null;
    }
    if (video) video.srcObject = null;
    var vp = $("viewport");
    if (vp) vp.classList.remove("live");
    var btnStart = $("btnStart"), btnStop = $("btnStop");
    if (btnStart) btnStart.disabled = false;
    if (btnStop) btnStop.disabled = true;
    if (!silent) setStatus("الكاميرا متوقفة");
  }

  async function tick() {
    if (!scan.running) return;
    if (!scan.busy && video && video.readyState >= 2 && video.videoWidth) {
      scan.busy = true;
      try {
        var vw = video.videoWidth, vh = video.videoHeight;
        var k = Math.min(1, 1100 / vw);
        work.width = Math.round(vw * k);
        work.height = Math.round(vh * k);
        wctx.drawImage(video, 0, 0, work.width, work.height);
        var r = await decodeSource(work, work);
        scan.frames++;
        if (r) registerByCode(r.text);
      } catch (e) { }
      scan.busy = false;
    }
    if (scan.running) scan.timer = setTimeout(tick, 130);
  }

  /* ======================================================================
     الربط والبدء
     ====================================================================== */
  function wire() {
    if ($("packFile")) $("packFile").addEventListener("change", function (e) {
      var f = e.target.files[0];
      e.target.value = "";
      if (f) importPackFile(f, "onboarding");
    });
    if ($("packFileSettings")) $("packFileSettings").addEventListener("change", function (e) {
      var f = e.target.files[0];
      e.target.value = "";
      if (f) importPackFile(f, "update");
    });

    // معالج الإعداد
    if ($("btnObStart")) $("btnObStart").onclick = function () { obShow(3); };
    if ($("btnObOtherPack")) $("btnObOtherPack").onclick = resetPackDraft;
    if ($("btnObCam")) $("btnObCam").onclick = openCamTest;
    if ($("btnObSkipCam")) $("btnObSkipCam").onclick = function () { obShow(4); };
    if ($("btnObFinish")) $("btnObFinish").onclick = finishOnboarding;
    if ($("btnInstall")) $("btnInstall").onclick = promptInstall;

    // الإعدادات
    if ($("btnSettings")) $("btnSettings").onclick = function () { renderSettings(); showPage("settings"); };
    if ($("btnSettingsBack")) $("btnSettingsBack").onclick = function () { renderToday(); showPage("today"); };
    if ($("btnSettingsCam")) $("btnSettingsCam").onclick = openCamTest;
    if ($("btnCheckUpdate")) $("btnCheckUpdate").onclick = checkUpdate;
    if ($("btnInstallTop")) $("btnInstallTop").onclick = promptInstall;
    if ($("btnUpdateNow")) $("btnUpdateNow").onclick = applyUpdate;
    if ($("btnUpdateLater")) $("btnUpdateLater").onclick = function () { showUpdateBar(false); };
    if ($("setTone")) $("setTone").addEventListener("change", function () {
      db.settings.beepTone = this.value || "default";
      persist(); beep("ok");
    });
    if ($("setVol")) $("setVol").addEventListener("change", function () {
      db.settings.beepVol = this.value || "med";
      persist(); beep("ok");
    });
    if ($("setTheme")) $("setTheme").addEventListener("change", function () {
      db.settings.theme = this.value || "auto";
      persist(); applyTheme();
    });
    if ($("btnTestBeep")) $("btnTestBeep").onclick = function () { beep("ok"); };

    // حوار فحص الكاميرا
    if ($("btnCamClose")) $("btnCamClose").onclick = closeCamTest;
    if ($("dlgCam")) {
      $("dlgCam").addEventListener("close", function () { stopTestCamera(true); });
      $("dlgCam").addEventListener("cancel", function () { stopTestCamera(true); });
    }

    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferredPrompt = e;
      if (lastShown === "setup") setupInstallUI();
      setupTopInstall();
    });
    window.addEventListener("appinstalled", function () {
      deferredPrompt = null;
      setupInstallUI();
      setupTopInstall();
      ATT.toast("تم تثبيت التطبيق");
    });

    // حصصي اليوم
    if ($("todayDate")) $("todayDate").addEventListener("change", renderToday);
    if ($("btnExtraLesson")) $("btnExtraLesson").onclick = function () { openExtraDialog(selectedDate()); };
    if ($("lessonList")) $("lessonList").addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("[data-extra]")) { openExtraDialog(selectedDate()); return; }
      var card = t.closest("[data-key]");
      if (card) onLessonClick(card.getAttribute("data-key"));
    });
    if ($("btnResumeSession")) $("btnResumeSession").onclick = function () {
      var open = findOpenSession();
      if (open) loadSession(open.key);
    };

    // حوار «لديك حصة مفتوحة»
    if ($("actResume")) $("actResume").onclick = function () { settleActive("resume"); };
    if ($("actEnd")) $("actEnd").onclick = function () { settleActive("end"); };
    if ($("actCancel")) $("actCancel").onclick = function () { settleActive("cancel"); };
    if ($("dlgActive")) $("dlgActive").addEventListener("cancel", function () { settleActive("cancel"); });

    // ملخص الحصة المنتهية
    if ($("sumExport")) $("sumExport").onclick = function () { if (summaryKey) reExportSession(summaryKey); };
    if ($("sumReopen")) $("sumReopen").onclick = function () { if (summaryKey) reopenClosed(summaryKey); };
    if ($("sumClose")) $("sumClose").onclick = function () {
      var d = $("dlgSummary");
      if (d && d.open) d.close();
    };

    // حصة إضافية
    if ($("extraGrade")) $("extraGrade").addEventListener("change", fillExtraClasses);
    if ($("extraForm")) $("extraForm").addEventListener("submit", onExtraSubmit);
    if ($("extraCancel")) $("extraCancel").onclick = function () {
      var d = $("dlgExtra");
      if (d && d.open) d.close();
    };

    // حصص لم تُرسل
    if ($("unsentList")) $("unsentList").addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var send = t.closest("[data-send-now]");
      if (send) { sendNow(send.getAttribute("data-send-now")); return; }
      var open = t.closest("[data-open-send]");
      if (open) {
        var k = open.getAttribute("data-open-send");
        viewKey = k;
        loadSession(k);
      }
    });
    if ($("sumSend")) $("sumSend").onclick = function () {
      if (summaryKey) {
        var d = $("dlgSummary");
        if (d && d.open) d.close();
        viewKey = summaryKey;
        loadSession(summaryKey);
      }
    };
    if ($("btnShareFile")) $("btnShareFile").onclick = function () {
      var s = viewSession();
      if (s) shareSessionFile(s);
    };
      var t = e.target;
      if (!t || !t.closest) return;
      var end = t.closest("[data-stale-end]");
      if (end) { settleStale(end.getAttribute("data-stale-end"), "end"); return; }
      var none = t.closest("[data-stale-none]");
      if (none) settleStale(none.getAttribute("data-stale-none"), "none");
    });
    if ($("btnBackToday")) $("btnBackToday").onclick = function () {
      var s = viewSession();
      if (s && s.status !== "open") viewKey = null;
      stopScan(true);
      renderToday();
      showPage("today");
    };
    if ($("btnStart")) $("btnStart").onclick = startScan;
    if ($("btnStop")) $("btnStop").onclick = function () { stopScan(); };
    if ($("camSel")) $("camSel").onchange = async function () {
      pref.set("cam", $("camSel").value);
      if (scan.running) { stopScan(true); await startScan(); }
    };
    if ($("manualForm")) $("manualForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var input = $("manualCode");
      var v = input ? input.value : "";
      if (input) input.value = "";
      if (input) input.focus();
      registerByCode(v);
    });
    if ($("btnEndSession")) $("btnEndSession").onclick = endSession;
    if ($("btnNoSession")) $("btnNoSession").onclick = noSession;
    if ($("tabP")) $("tabP").onclick = function () { setTab("present"); };
    if ($("tabA")) $("tabA").onclick = function () { setTab("absent"); };
    var tablist = document.querySelector(".tabs");
    if (tablist) tablist.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setTab(view.tab === "present" ? "absent" : "present");
      var target = $(view.tab === "present" ? "tabP" : "tabA");
      if (target) target.focus();
    });
    window.addEventListener("online", paintNet);
    window.addEventListener("offline", paintNet);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && scan.running) requestWakeLock();
    });
    window.addEventListener("pagehide", function () { stopScan(true); });
  }

  /** يتبنّى جلسة مفتوحة قديمة بلا activeSessionKey (توافق مع بيانات T6–T8). */
  function ensureActiveKey() {
    var key = db.activeSessionKey;
    var s = key ? (db.sessions || {})[key] : null;
    if (s && s.status === "open") return;
    var open = findOpenSession();
    var next = open ? open.key : null;
    if (db.activeSessionKey !== next) { db.activeSessionKey = next; persist(); }
  }

  /** الكاميرا لا تبدأ تلقائيًا إلا إذا كان إذن الكاميرا ممنوحًا مسبقًا. */
  async function maybeAutoStartCam() {
    if (scan.running || !getActiveSession()) return;
    try {
      if (!navigator.permissions || !navigator.permissions.query) return;
      var p = await navigator.permissions.query({ name: "camera" });
      if (p && p.state === "granted") await startScan();
    } catch (e) { }
  }

  function init() {
    ATT.wireDialogs();
    video = $("video");
    work = document.createElement("canvas");
    wctx = work.getContext("2d", { willReadFrequently: true });
    store = ATT.createStore({ key: ATT.TEACHER_KEY, defaults: ATT.defaultTeacherDb, migrate: migrateTeacherDb });
    store.load();
    db = store.db;
    persist();
    applyTheme();
    paintNet();
    initSW();
    renderTeacherName();
    wire();
    setupTopInstall();
    var info = $("bootInfo");
    if (info) info.textContent = "النواة: " + ATT.version + " · التخزين: " + ATT.TEACHER_KEY;
    if (isOnboarded()) {
      ensureActiveKey();
      fillExtraSelects();
      renderToday();
      renderSettings();
      var active = getActiveSession();
      if (active && db.lastPage === "session") {
        loadSession(active.key);
        maybeAutoStartCam();
      } else {
        showPage("today");
      }
    } else if (db.pack && db.pack.teacherId) {
      renderReview();
      obShow(2);
    } else {
      obShow(1);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.TEACHER = {
    paintNet: paintNet,
    getDb: function () { return db; },
    isOnboarded: isOnboarded,
    hasOpenSession: hasOpenSession,
    obShow: obShow,
    finishOnboarding: finishOnboarding,
    applyTheme: applyTheme,
    importPackFile: importPackFile,
    showPage: showPage,
    openSession: function (date, period, grade, cls) {
      return startLesson(date, period, grade, cls);
    },
    startLesson: startLesson,
    renderToday: renderToday,
    openSummary: openSummary,
    registerByCode: registerByCode,
    exportSessionExcel: exportSessionExcel,
    getSession: getSession,
    getCurrent: function () {
      var s = viewSession();
      var a = getActiveSession();
      return { key: viewKey, session: s, open: !!(a && viewKey && a.key === viewKey) };
    },
    getActiveSession: getActiveSession,
    viewSession: viewSession,
    showUpdateBar: showUpdateBar,
    renderStorage: renderStorage,
    swState: function () {
      return { registered: !!swReg, build: swReg && swReg.active ? "active" : null, waiting: !!(swReg && swReg.waiting) };
    }
  };
})();
