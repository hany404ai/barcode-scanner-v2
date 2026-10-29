/* ==========================================================================
   center/center.js — تطبيق المركز (إدارة + مركز)
   يعتمد على window.ATT من ../shared/core.js. سكربت كلاسيكي، بلا كاميرا أو ماسح.
   ========================================================================== */
(function () {
  "use strict";

  var ATT = window.ATT;
  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  var PAGES = ["dashboard", "students", "teachers", "inbox", "reports", "settings"];
  var LEGACY = { "#home": "#dashboard", "#admin": "#students", "#central": "#inbox" };
  var TITLES = {
    dashboard: "لوحة اليوم — المركز",
    students: "الطلاب — المركز",
    teachers: "المعلمون — المركز",
    inbox: "الوارد — المركز",
    reports: "التقارير — المركز",
    settings: "الإعدادات — المركز"
  };

  var store = ATT.createStore({
    key: ATT.CENTER_KEY,
    defaults: ATT.defaultCenterDb,
    migrate: ATT.migrateV2ToV3
  });

  var db = null;
  var editing = null;
  var selected = new Set();
  var lastReport = "daily";

  /* ---------- حالة القفل ---------- */
  var locked = false;
  var pinBusy = false;
  var lockTimer = null;
  var lockTickTimer = null;
  var lastBump = 0;
  var pinSnoozed = false;
  var PIN_RESET_PHRASE = "حذف كل البيانات";
  var PIN_BLOCK_BASE_MS = 30000; // 30 ثانية لأول دفعة، ثم يتضاعف

  /* ---------- تخزين ---------- */
  function persist() {
    store.db = db;
    var ok = store.save();
    var warn = $("#storeWarn");
    if (warn) warn.hidden = ok;
    return ok;
  }

  function touchRoster() {
    db.rosterVersion = { id: ATT.uid(), updatedAt: new Date().toISOString() };
  }

  /* ---------- أدوات صغيرة ---------- */
  function fillSelect(sel, values, firstLabel, current) {
    if (!sel) return;
    var html = '<option value="">' + ATT.esc(firstLabel) + "</option>";
    values.forEach(function (v) { html += '<option value="' + ATT.esc(v) + '">' + ATT.esc(v) + "</option>"; });
    sel.innerHTML = html;
    sel.value = values.indexOf(current) >= 0 ? current : "";
  }

  function downloadJson(name, obj) {
    ATT.downloadText(name, JSON.stringify(obj, null, 2), "application/json");
  }

  /* ======================================================================
     الطلاب
     ====================================================================== */
  function refreshFilters() {
    var grades = ATT.distinctValues(db.students, "grade");
    var classes = ATT.distinctValues(db.students, "cls");
    var gSel = $("#aGrade"), cSel = $("#aClass");
    var curG = gSel ? gSel.value : "";
    var curC = cSel ? cSel.value : "";
    fillSelect(gSel, grades, "كل الصفوف", curG);
    fillSelect(cSel, classes, "كل الفصول", curC);
    var dlG = $("#dlGrade"), dlC = $("#dlClass");
    if (dlG) dlG.innerHTML = grades.map(function (v) { return '<option value="' + ATT.esc(v) + '">'; }).join("");
    if (dlC) dlC.innerHTML = classes.map(function (v) { return '<option value="' + ATT.esc(v) + '">'; }).join("");
  }

  function currentList() {
    var q = ($("#stuSearch") && $("#stuSearch").value ? $("#stuSearch").value : "").trim().toLowerCase();
    var g = $("#aGrade") ? $("#aGrade").value : "";
    var c = $("#aClass") ? $("#aClass").value : "";
    return ATT.filtered(db.students, g, c).filter(function (s) {
      return !q || String(s.name).toLowerCase().indexOf(q) >= 0 || String(s.code).toLowerCase().indexOf(q) >= 0;
    });
  }

  function renderStudents() {
    var t = $("#stuTbl");
    if (!t) return;
    var list = currentList();
    var count = $("#stuCount");
    if (count) count.textContent = "(" + list.length + " من " + db.students.length + ")";

    if (!db.students.length) {
      t.innerHTML = '<tbody><tr><td class="empty" colspan="6">لم تسجل أي طالب بعد. أضف طالبًا من النموذج، أو استورد ملف Excel/CSV، أو أضف طلابًا تجريبيين.</td></tr></tbody>';
      updateLblCount();
      return;
    }
    if (!list.length) {
      t.innerHTML = '<tbody><tr><td class="empty" colspan="6">لا توجد نتائج مطابقة.</td></tr></tbody>';
      updateLblCount();
      return;
    }
    t.innerHTML = '<thead><tr><th scope="col"><input type="checkbox" id="selAll" aria-label="تحديد الكل"></th>' +
      '<th scope="col">الاسم</th><th scope="col">الكود</th><th scope="col">الصف</th><th scope="col">الفصل</th>' +
      '<th scope="col"><span class="sr-only">إجراءات</span></th></tr></thead><tbody>' +
      list.map(function (s) {
        var valid = ATT.c128Valid(s.code);
        return '<tr><td><input type="checkbox" data-sel="' + ATT.esc(s.code) + '"' +
          (selected.has(s.code) ? " checked" : "") + ' aria-label="تحديد ' + ATT.esc(s.name) + '"></td>' +
          '<td class="name">' + ATT.esc(s.name) + "</td>" +
          '<td class="code">' + ATT.esc(s.code) +
          (valid ? "" : ' <span class="pill no" title="كود لا يمكن طباعة باركود له">!</span>') + "</td>" +
          "<td>" + ATT.esc(s.grade) + "</td><td>" + ATT.esc(s.cls) + "</td>" +
          '<td><button class="btn sm" data-edit="' + ATT.esc(s.code) + '" aria-label="تعديل بيانات ' + ATT.esc(s.name) + '" type="button">تعديل</button> ' +
          '<button class="btn sm danger" data-del="' + ATT.esc(s.code) + '" aria-label="حذف ' + ATT.esc(s.name) + '" type="button">حذف</button></td></tr>';
      }).join("") + "</tbody>";

    var all = $("#selAll");
    if (all) all.checked = list.length > 0 && list.every(function (s) { return selected.has(s.code); });
    updateLblCount();
  }

  function resetForm() {
    editing = null;
    var form = $("#stuForm");
    if (form) form.reset();
    var title = $("#formTitle"); if (title) title.textContent = "إضافة طالب";
    var saveBtn = $("#sSave"); if (saveBtn) saveBtn.textContent = "إضافة الطالب";
    var cancel = $("#sCancel"); if (cancel) cancel.hidden = true;
    var msg = $("#sMsg"); if (msg) msg.textContent = "";
  }

  function onStudentSubmit(e) {
    e.preventDefault();
    var name = $("#sName").value.trim();
    var code = ATT.toLatinDigits($("#sCode").value.trim());
    var grade = $("#sGrade").value.trim();
    var cls = $("#sClass").value.trim();
    var msg = $("#sMsg");
    msg.textContent = "";
    if (!name || !code) { msg.textContent = "الاسم والكود مطلوبان."; return; }

    var dup = ATT.findStudent(db.students, code);
    if (dup && dup.code !== editing) { msg.textContent = "هذا الكود مسجل للطالب: " + dup.name; return; }
    if (!ATT.c128Valid(code)) ATT.toast("الكود يحتوي رموزًا لا يدعمها الباركود. استخدم أرقامًا وحروفًا لاتينية.");

    if (editing) {
      var s = ATT.findStudent(db.students, editing);
      if (s) {
        if (s.code !== code) moveCode(s.code, code);
        s.name = name; s.code = code; s.grade = grade; s.cls = cls;
        ATT.toast("تم حفظ التعديل");
      }
    } else {
      db.students.push({ name: name, code: code, grade: grade, cls: cls });
      ATT.toast("تمت إضافة الطالب");
    }
    touchRoster();
    persist(); resetForm(); refreshFilters(); renderStudents(); renderDashboard();
    $("#sName").focus();
  }

  /** عند تغيير كود طالب: انقل سجلات الحضور القديمة والجلسات المحفوظة إلى الكود الجديد. */
  function moveCode(from, to) {
    Object.keys(db.attendance || {}).forEach(function (d) {
      var day = db.attendance[d];
      if (day && day[from]) { day[to] = day[from]; delete day[from]; }
    });
    Object.keys(db.sessions || {}).forEach(function (k) {
      var s = db.sessions[k];
      if (s && s.present && s.present[from]) { s.present[to] = s.present[from]; delete s.present[from]; }
    });
  }

  function deleteStudent(code) {
    var s = ATT.findStudent(db.students, code);
    if (!s) return;
    ATT.askConfirm("حذف الطالب", "سيتم حذف " + s.name + " وكل سجلات حضوره القديمة. لا يمكن التراجع.", "حذف").then(function (ok) {
      if (!ok) return;
      db.students = db.students.filter(function (x) { return x !== s; });
      selected.delete(s.code);
      Object.keys(db.attendance || {}).forEach(function (d) { delete db.attendance[d][s.code]; });
      Object.keys(db.sessions || {}).forEach(function (k) {
        if (db.sessions[k] && db.sessions[k].present) delete db.sessions[k].present[s.code];
      });
      touchRoster();
      persist(); refreshFilters(); renderStudents(); renderDashboard();
      ATT.toast("تم حذف الطالب");
    });
  }

  /* ---------- استيراد وتصدير Excel ---------- */
  async function exportTable(filename, aoa, sheetName) {
    if (await ATT.loadLib("xlsx")) {
      try {
        var ws = XLSX.utils.aoa_to_sheet(aoa);
        ws["!views"] = [{ rightToLeft: true }];
        ws["!cols"] = (aoa[0] || []).map(function () { return { wch: 22 }; });
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
        XLSX.writeFile(wb, filename + ".xlsx");
        return true;
      } catch (e) { /* يسقط إلى CSV */ }
    }
    var csv = "\uFEFF" + aoa.map(function (r) {
      return r.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\r\n");
    ATT.downloadText(filename + ".csv", csv, "text/csv;charset=utf-8");
    ATT.toast("تعذر إنشاء Excel، تم تنزيل الملف بصيغة CSV (يفتح في Excel).");
    return false;
  }

  async function importFile(file) {
    var msg = $("#impMsg");
    if (msg) msg.textContent = "جارٍ قراءة الملف…";
    try {
      var rows;
      var ext = ATT.fileExt(file.name);
      if (["csv", "tsv", "txt"].indexOf(ext) >= 0) {
        rows = ATT.parseCSV(await file.text());
      } else {
        if (!(await ATT.loadLib("xlsx"))) {
          if (msg) msg.textContent = "تعذر تحميل مكتبة Excel المحلية (vendor/xlsx.full.min.js).";
          return;
        }
        var wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        var first = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(first, { header: 1, defval: "", raw: false });
      }
      var r = ATT.mergeRows(rows, db.students);
      touchRoster();
      persist(); refreshFilters(); renderStudents(); renderDashboard();
      var text = "تم استيراد " + r.added + " طالب جديد وتحديث " + r.updated + ".";
      if (r.skipped) text += " تم تخطي " + r.skipped + " سطر (" + r.notes.join("، ") + ").";
      if (r.badBarcode) text += " تنبيه: " + r.badBarcode + " كود يحتوي رموزًا لا يدعمها الباركود.";
      if (r.assumed) text += " لم يُعثر على صف عناوين، فافترض الترتيب: الاسم، الكود، الصف، الفصل.";
      if (msg) msg.textContent = text;
    } catch (e) {
      if (msg) msg.textContent = "تعذرت قراءة الملف. تأكد أنه ملف Excel أو CSV سليم.";
    }
  }

  /* ======================================================================
     المعلمون والجدول وحزم المعلمين
     ====================================================================== */
  var editingTeacher = null;

  function ensureTeacherData() {
    var changed = false;
    if (!Array.isArray(db.teachers)) { db.teachers = []; changed = true; }
    if (!Array.isArray(db.schedule)) { db.schedule = []; changed = true; }
    db.teachers.forEach(function (t) {
      if (t && !t.id) { t.id = ATT.uid(); changed = true; }
    });
    return changed;
  }

  function sortedTeachers() {
    return (db.teachers || []).slice().sort(function (a, b) {
      return ATT.collator.compare(a.name || "", b.name || "");
    });
  }

  function teacherById(id) {
    var list = db.teachers || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function lessonsOf(teacherId) {
    return (db.schedule || []).filter(function (l) { return l.teacherId === teacherId; });
  }

  function renderTeachers() {
    var t = $("#teacherTbl");
    if (!t) return;
    var list = sortedTeachers();
    var count = $("#teacherCount");
    if (count) count.textContent = "(" + list.length + ")";
    if (!list.length) {
      t.innerHTML = '<tbody><tr><td class="empty" colspan="4">لم تضف معلمين بعد. أضف معلمًا من النموذج، ثم أضف حصصه في الجدول.</td></tr></tbody>';
      return;
    }
    t.innerHTML = '<thead><tr><th scope="col">المعلم</th><th scope="col">الهاتف</th>' +
      '<th scope="col">الحصص</th><th scope="col"><span class="sr-only">إجراءات</span></th></tr></thead><tbody>' +
      list.map(function (x) {
        var n = lessonsOf(x.id).length;
        return "<tr><td class=\"name\">" + ATT.esc(x.name) +
          (x.note ? '<div class="small muted">' + ATT.esc(x.note) + "</div>" : "") + "</td>" +
          '<td class="ltr">' + ATT.esc(x.phone || "—") + "</td><td>" + n + "</td><td>" +
          '<button class="btn sm" data-pack-teacher="' + ATT.esc(x.id) + '" aria-label="تصدير حزمة ' + ATT.esc(x.name) + '" type="button">حزمة</button> ' +
          '<button class="btn sm" data-edit-teacher="' + ATT.esc(x.id) + '" aria-label="تعديل ' + ATT.esc(x.name) + '" type="button">تعديل</button> ' +
          '<button class="btn sm danger" data-del-teacher="' + ATT.esc(x.id) + '" aria-label="حذف ' + ATT.esc(x.name) + '" type="button">حذف</button>' +
          "</td></tr>";
      }).join("") + "</tbody>";
  }

  function resetTeacherForm() {
    editingTeacher = null;
    var form = $("#teacherForm");
    if (form) form.reset();
    if ($("#teacherFormTitle")) $("#teacherFormTitle").textContent = "إضافة معلم";
    if ($("#tSave")) $("#tSave").textContent = "إضافة المعلم";
    if ($("#tCancel")) $("#tCancel").hidden = true;
    if ($("#tMsg")) $("#tMsg").textContent = "";
  }

  function onTeacherSubmit(e) {
    e.preventDefault();
    var name = $("#tName").value.trim();
    var phone = $("#tPhone").value.trim();
    var note = $("#tNote").value.trim();
    var msg = $("#tMsg");
    if (msg) msg.textContent = "";
    if (!name) { if (msg) msg.textContent = "اسم المعلم مطلوب."; return; }
    var norm = ATT.normHeader(name);
    var dup = (db.teachers || []).filter(function (t) {
      return t.id !== editingTeacher && ATT.normHeader(t.name) === norm;
    })[0];
    if (dup) { if (msg) msg.textContent = "يوجد معلم بهذا الاسم بالفعل."; return; }

    var teacher = editingTeacher ? teacherById(editingTeacher) : null;
    if (teacher) {
      teacher.name = name; teacher.phone = phone; teacher.note = note;
      ATT.toast("تم حفظ بيانات المعلم");
    } else {
      teacher = { id: ATT.uid(), name: name, phone: phone, note: note };
      db.teachers.push(teacher);
      ATT.toast("تمت إضافة المعلم");
    }
    persist();
    resetTeacherForm();
    renderTeachers();
    refreshTeacherSelects(teacher.id);
    renderSchedule();
  }

  function editTeacher(id) {
    var t = teacherById(id);
    if (!t) return;
    editingTeacher = id;
    $("#tName").value = t.name || "";
    $("#tPhone").value = t.phone || "";
    $("#tNote").value = t.note || "";
    $("#teacherFormTitle").textContent = "تعديل بيانات المعلم";
    $("#tSave").textContent = "حفظ التعديل";
    $("#tCancel").hidden = false;
    $("#tName").focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function deleteTeacher(id) {
    var t = teacherById(id);
    if (!t) return;
    var n = lessonsOf(id).length;
    ATT.askConfirm("حذف المعلم",
      "سيتم حذف " + t.name + (n ? " وحذف " + n + " حصة من جدوله" : "") + ". لا يمكن التراجع.",
      "حذف").then(function (ok) {
        if (!ok) return;
        db.teachers = (db.teachers || []).filter(function (x) { return x.id !== id; });
        db.schedule = (db.schedule || []).filter(function (l) { return l.teacherId !== id; });
        if (editingTeacher === id) resetTeacherForm();
        persist();
        renderTeachers();
        refreshTeacherSelects();
        renderSchedule();
        ATT.toast("تم حذف المعلم");
      });
  }

  function refreshTeacherSelects(preferredId) {
    var sel = $("#schTeacher");
    if (!sel) return;
    var list = sortedTeachers();
    var cur = preferredId || sel.value;
    var html = '<option value="">اختر معلمًا</option>';
    list.forEach(function (t) {
      html += '<option value="' + ATT.esc(t.id) + '">' + ATT.esc(t.name) + "</option>";
    });
    sel.innerHTML = html;
    var exists = list.some(function (t) { return t.id === cur; });
    sel.value = exists ? cur : (list[0] ? list[0].id : "");
    updateScheduleTeacherLabel();
  }

  function updateScheduleTeacherLabel() {
    var sel = $("#schTeacher");
    var label = $("#schTeacherLabel");
    if (!label) return;
    var t = sel ? teacherById(sel.value) : null;
    label.textContent = t ? t.name : "";
  }

  function refreshScheduleClasses() {
    var grades = ATT.distinctValues(db.students, "grade");
    var gSel = $("#schGrade"), cSel = $("#schCls");
    if (gSel) {
      var curG = gSel.value;
      gSel.innerHTML = '<option value="">اختر الصف</option>' + grades.map(function (g) {
        return '<option value="' + ATT.esc(g) + '">' + ATT.esc(g) + "</option>";
      }).join("");
      gSel.value = grades.indexOf(curG) >= 0 ? curG : "";
    }
    var g = gSel ? gSel.value : "";
    var classes = db.students.filter(function (s) { return !g || s.grade === g; });
    var clsValues = ATT.distinctValues(classes, "cls");
    if (cSel) {
      var curC = cSel.value;
      cSel.innerHTML = '<option value="">اختر الفصل</option>' + clsValues.map(function (c) {
        return '<option value="' + ATT.esc(c) + '">' + ATT.esc(c) + "</option>";
      }).join("");
      cSel.value = clsValues.indexOf(curC) >= 0 ? curC : "";
    }
    var p = $("#schPeriod");
    if (p) p.max = Math.max(1, Number(db.settings.periodsPerDay) || 7);
  }

  function renderSchedule() {
    var t = $("#schTbl");
    if (!t) return;
    var sel = $("#schTeacher");
    var teacher = sel ? teacherById(sel.value) : null;
    updateScheduleTeacherLabel();
    var count = $("#schCount");
    if (!teacher) {
      if (count) count.textContent = "";
      t.innerHTML = '<tbody><tr><td class="empty" colspan="6">أضف معلمًا أولًا، ثم أضف حصصه في الجدول.</td></tr></tbody>';
      return;
    }
    var rows = lessonsOf(teacher.id).slice().sort(ATT.compareLessons);
    if (count) count.textContent = "(" + rows.length + ")";
    if (!rows.length) {
      t.innerHTML = '<tbody><tr><td class="empty" colspan="6">لا توجد حصص لهذا المعلم بعد.</td></tr></tbody>';
      return;
    }
    t.innerHTML = '<thead><tr><th scope="col">اليوم</th><th scope="col">الحصة</th><th scope="col">الصف</th>' +
      '<th scope="col">الفصل</th><th scope="col">المادة</th><th scope="col"><span class="sr-only">إجراءات</span></th></tr></thead><tbody>' +
      rows.map(function (l) {
        var hasStudents = db.students.some(function (s) { return s.grade === l.grade && s.cls === l.cls; });
        return "<tr><td>" + ATT.esc(ATT.DAY_NAMES[Number(l.day)] || l.day) + "</td><td>" + Number(l.period) +
          "</td><td>" + ATT.esc(l.grade) + "</td><td>" + ATT.esc(l.cls) +
          (hasStudents ? "" : ' <span class="pill warn">بلا طلاب</span>') + "</td><td>" +
          ATT.esc(l.subject || "—") + '</td><td><button class="btn sm danger" data-del-lesson="' +
          ATT.esc(l.id) + '" aria-label="حذف حصة ' + ATT.esc((ATT.DAY_NAMES[Number(l.day)] || l.day) + " الحصة " + l.period) +
          '" type="button">حذف</button></td></tr>';
      }).join("") + "</tbody>";
  }

  function addLesson() {
    var msg = $("#schMsg");
    if (msg) msg.textContent = "";
    var sel = $("#schTeacher");
    var teacher = sel ? teacherById(sel.value) : null;
    if (!teacher) { if (msg) msg.textContent = "اختر معلمًا أولًا."; return; }
    var day = Number($("#schDay").value);
    var period = Number($("#schPeriod").value);
    var grade = $("#schGrade").value;
    var cls = $("#schCls").value;
    var subject = $("#schSubject").value.trim();
    var max = Math.max(1, Number(db.settings.periodsPerDay) || 7);
    if (isNaN(day) || day < 0 || day > 6) { if (msg) msg.textContent = "اختر يومًا صحيحًا."; return; }
    if (!isFinite(period) || Math.floor(period) !== period || period < 1 || period > max) {
      if (msg) msg.textContent = "رقم الحصة يجب أن يكون بين 1 و" + max + ".";
      return;
    }
    if (!grade || !cls) { if (msg) msg.textContent = "اختر الصف والفصل."; return; }

    var conflict = lessonsOf(teacher.id).filter(function (l) {
      return Number(l.day) === day && Number(l.period) === period;
    })[0];
    if (conflict) {
      if (conflict.grade === grade && conflict.cls === cls) {
        if (msg) msg.textContent = "هذه الحصة مضافة بالفعل لهذا المعلم.";
      } else {
        if (msg) msg.textContent = "لدى المعلم حصة أخرى في نفس اليوم والحصة (" + conflict.grade + " / " + conflict.cls + ").";
      }
      return;
    }

    db.schedule.push({
      id: ATT.uid(), teacherId: teacher.id, day: day, period: period,
      grade: grade, cls: cls, subject: subject
    });
    persist();
    $("#schSubject").value = "";
    renderSchedule();
    renderTeachers();
    ATT.toast("تمت إضافة الحصة إلى الجدول");
    if (!db.students.some(function (s) { return s.grade === grade && s.cls === cls; })) {
      ATT.toast("تنبيه: هذا الفصل لا يحتوي طلابًا، وقد تُستبعد حصته عند تصدير الحزمة.");
    }
  }

  function deleteLesson(id) {
    var l = (db.schedule || []).filter(function (x) { return x.id === id; })[0];
    if (!l) return;
    ATT.askConfirm("حذف حصة من الجدول",
      "سيتم حذف حصة " + (ATT.DAY_NAMES[Number(l.day)] || l.day) + " الحصة " + l.period + " (" + l.grade + " / " + l.cls + ").",
      "حذف").then(function (ok) {
        if (!ok) return;
        db.schedule = db.schedule.filter(function (x) { return x.id !== id; });
        persist(); renderSchedule(); renderTeachers();
        ATT.toast("تم حذف الحصة");
      });
  }

  function exportScheduleTemplate() {
    var teacher = sortedTeachers()[0];
    var st = db.students[0];
    exportTable("نموذج-الجدول", [
      ["المعلم", "اليوم", "الحصة", "الصف", "الفصل", "المادة"],
      [teacher ? teacher.name : "أ. مثال", "الأحد", 1, st ? st.grade : "الصف الأول", st ? st.cls : "1/أ", "رياضيات"]
    ], "الجدول");
  }

  async function importScheduleFile(file) {
    var msg = $("#schImpMsg");
    if (msg) msg.textContent = "جارٍ قراءة الملف…";
    try {
      var rows;
      var ext = ATT.fileExt(file.name);
      if (["csv", "tsv", "txt"].indexOf(ext) >= 0) {
        rows = ATT.parseCSV(await file.text());
      } else {
        if (!(await ATT.loadLib("xlsx"))) {
          if (msg) msg.textContent = "تعذر تحميل مكتبة Excel المحلية (vendor/xlsx.full.min.js).";
          return;
        }
        var wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        var first = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(first, { header: 1, defval: "", raw: false });
      }
      var r = ATT.mergeScheduleRows(rows, db.teachers, db.schedule, classList(), db.settings.periodsPerDay);
      persist();
      renderSchedule(); renderTeachers(); refreshTeacherSelects();
      var text = "تمت إضافة " + r.added + " حصة وتحديث " + r.updated + ".";
      if (r.skipped) text += " تم تخطي " + r.skipped + " سطر (" + r.notes.join("، ") + ").";
      if (r.assumed) text += " لم يُعثر على صف عناوين، فافترض الترتيب: المعلم، اليوم، الحصة، الصف، الفصل، المادة.";
      if (msg) msg.textContent = text;
    } catch (e) {
      if (msg) msg.textContent = "تعذرت قراءة ملف الجدول. تأكد أنه Excel أو CSV سليم.";
    }
  }

  /**
   * يبني حزمة معلم من جدوله. يستبعد الحصص التي لا طلاب لفصلها.
   * interactive=true يطلب تأكيدًا قبل الاستبعاد.
   */
  async function buildTeacherPack(teacher, interactive) {
    var lessons = lessonsOf(teacher.id);
    if (!lessons.length) return { error: "لا توجد حصص لهذا المعلم في الجدول." };
    var classMap = {}, valid = [], invalid = [];
    lessons.forEach(function (l) {
      var hasStudents = db.students.some(function (s) { return s.grade === l.grade && s.cls === l.cls; });
      if (!hasStudents) { invalid.push(l); return; }
      valid.push(l);
      classMap[l.grade + "|" + l.cls] = { grade: l.grade, cls: l.cls };
    });
    if (!valid.length) {
      return { error: "كل حصص المعلم تشير إلى فصول بلا طلاب. أضف الطلاب أو صحح الجدول أولًا." };
    }
    if (invalid.length && interactive) {
      var ok = await ATT.askConfirm("فصول بلا طلاب",
        "سيتم استبعاد " + invalid.length + " حصة لأن فصولها لا تحتوي طلابًا. هل تريد تصدير الحزمة بالحصص الصالحة فقط؟",
        "تصدير");
      if (!ok) return { canceled: true };
    }
    var classes = Object.keys(classMap).map(function (k) { return classMap[k]; });
    var students = db.students.filter(function (s) {
      return !!classMap[s.grade + "|" + s.cls];
    });
    var pack = ATT.buildPack({
      teacherId: teacher.id,
      teacherName: teacher.name,
      schoolName: db.settings.schoolName || "",
      rosterVersionId: db.rosterVersion.id,
      classes: classes,
      schedule: valid,
      students: students,
      settings: db.settings
    });
    var v = ATT.validatePack(pack);
    if (!v.ok) {
      return { error: "تعذر بناء حزمة صالحة: " + v.errors.map(function (e) { return e.message; }).join(" · ") };
    }
    return { pack: pack, excluded: invalid.length };
  }

  async function exportTeacherPack(teacher) {
    var msg = $("#packMsg");
    if (!msg) return;
    msg.textContent = "جارٍ بناء الحزمة…";
    var r = await buildTeacherPack(teacher, true);
    if (r.canceled) { msg.textContent = ""; return; }
    if (r.error) { msg.textContent = r.error; ATT.toast("تعذر تصدير الحزمة"); return; }
    ATT.downloadText(ATT.packFileName(r.pack), JSON.stringify(r.pack, null, 2), "application/json");
    msg.textContent = "تم تصدير حزمة " + teacher.name + "." +
      (r.excluded ? " استُبعدت " + r.excluded + " حصة لفصول بلا طلاب." : "");
    ATT.toast("تم تصدير حزمة المعلم");
  }

  async function exportAllTeacherPacks() {
    var msg = $("#packMsg");
    if (!msg) return;
    var teachers = sortedTeachers();
    if (!teachers.length) { msg.textContent = "لا يوجد معلمون لتصدير حزمهم."; return; }
    msg.textContent = "جارٍ بناء الحزم…";
    var packs = [], skipped = [], excluded = 0;
    for (var i = 0; i < teachers.length; i++) {
      var r = await buildTeacherPack(teachers[i], false);
      if (r.pack) packs.push(r.pack);
      else skipped.push(teachers[i].name + " (" + (r.error || "لا حصص") + ")");
      excluded += r.excluded || 0;
    }
    if (!packs.length) {
      msg.textContent = "لم تُصدَّر أي حزمة. " + skipped.join(" | ");
      return;
    }
    if (!(await ATT.loadLib("jszip"))) {
      msg.textContent = "تعذر تحميل مكتبة ZIP المحلية (vendor/jszip.min.js).";
      return;
    }
    try {
      var zip = new JSZip();
      packs.forEach(function (p) { zip.file(ATT.packFileName(p), JSON.stringify(p, null, 2)); });
      var blob = await zip.generateAsync({ type: "blob" });
      ATT.downloadBlob("PACKS_" + ATT.todayKey() + ".zip", blob);
      msg.textContent = "تم تصدير " + packs.length + " حزمة في ملف ZIP." +
        (excluded ? " استُبعدت " + excluded + " حصة لفصول بلا طلاب." : "") +
        (skipped.length ? " لم تُصدَّر: " + skipped.join(" | ") : "");
      ATT.toast("تم تصدير حزم المعلمين");
    } catch (e) {
      msg.textContent = "تعذر إنشاء ملف ZIP.";
    }
  }

  /* ---------- ملصقات الباركود ---------- */
  var SIZES = {
    s: { w: 50, h: 25, n: 7, m: 6, c: 6 },
    m: { w: 60, h: 30, n: 8.5, m: 7, c: 7 },
    l: { w: 90, h: 45, n: 12, m: 9, c: 9 }
  };

  function labelTargets() {
    var chosen = db.students.filter(function (s) { return selected.has(s.code); });
    return chosen.length ? chosen : currentList();
  }

  function updateLblCount() {
    var el = $("#lblCount");
    var t = labelTargets();
    var ok = t.filter(function (s) { return ATT.c128Valid(s.code); }).length;
    if (el) {
      el.textContent = "سيتم طباعة " + ok + " ملصق" +
        (t.length - ok ? " (تخطي " + (t.length - ok) + " كود غير صالح للباركود)" : "");
    }
    var btn = $("#btnPrint");
    if (btn) btn.disabled = !ok;
  }

  function labelsHtml() {
    var z = SIZES[($("#lSize") && $("#lSize").value) || "m"];
    return labelTargets().filter(function (s) { return ATT.c128Valid(s.code); }).map(function (s) {
      return '<div class="lbl" style="width:' + z.w + "mm;height:" + z.h + 'mm">' +
        '<div class="n" style="font-size:' + z.n + 'pt">' + ATT.esc(s.name) + "</div>" +
        '<div class="m" style="font-size:' + z.m + 'pt">' + ATT.esc([s.grade, s.cls].filter(Boolean).join(" — ")) + "</div>" +
        '<div class="b">' + ATT.c128Svg(s.code) + "</div>" +
        '<div class="c" style="font-size:' + z.c + 'pt">' + ATT.esc(s.code) + "</div></div>";
    }).join("");
  }

  function previewLabels() {
    var h = labelsHtml();
    var box = $("#lblPreview");
    if (box) box.innerHTML = h || '<p class="muted small">لا توجد ملصقات لعرضها. حدّد طلابًا لديهم أكواد صالحة.</p>';
  }

  function printLabels() {
    var h = labelsHtml();
    if (!h) { ATT.toast("لا توجد ملصقات للطباعة"); return; }
    var z = SIZES[($("#lSize") && $("#lSize").value) || "m"];
    var roll = ($("#lMode") && $("#lMode").value) === "roll";
    var margin = parseFloat(($("#lMargin") && $("#lMargin").value) || "2") || 0;
    var gap = parseFloat(($("#lGap") && $("#lGap").value) || "1") || 0;
    var crop = ($("#lCrop") && $("#lCrop").value) === "yes";
    var css = roll ? "@page{size:" + z.w + "mm " + z.h + "mm;margin:0}" : "@page{size:A4;margin:" + margin + "mm}";
    css += " body.printing #printArea{gap:" + gap + "mm;" + (crop ? "outline:1px dashed #999;outline-offset:-1px;" : "") + "}";
    css += " body.printing .lbl{" + (crop ? "outline:1px dashed #666;" : "") + "}";
    $("#pageStyle").textContent = css;
    $("#printArea").innerHTML = h;
    document.body.classList.add("printing");
    document.body.classList.toggle("roll", roll);
    var done = function () {
      document.body.classList.remove("printing", "roll");
      $("#printArea").innerHTML = "";
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    setTimeout(function () { window.print(); }, 50);
  }

  /* ======================================================================
     لوحة اليوم (مصفوفة الوصول)
     ====================================================================== */
  function classList() {
    var map = {}, out = [];
    db.students.forEach(function (s) {
      var k = s.grade + "|" + s.cls;
      if (!map[k]) { map[k] = { grade: s.grade || "", cls: s.cls || "" }; out.push(map[k]); }
    });
    return out.sort(function (a, b) {
      return ATT.collator.compare(a.grade + a.cls, b.grade + b.cls);
    });
  }

  function receivedFor(date, period, cl) {
    var central = db.central || {};
    var rec = central.received && central.received[ATT.sessionKey(date, period, cl.grade, cl.cls)];
    return rec || null;
  }

  function renderDashboard() {
    var dateEl = $("#dashDate");
    if (dateEl && !dateEl.value) dateEl.value = ATT.todayKey();
    var date = (dateEl && dateEl.value) || ATT.todayKey();

    var periods = Math.max(1, Number(db.settings.periodsPerDay) || 7);
    var classes = classList();
    var total = classes.length * periods, received = 0, noSession = 0, absentTotal = 0;

    classes.forEach(function (cl) {
      for (var p = 1; p <= periods; p++) {
        var rec = receivedFor(date, p, cl);
        if (rec) {
          received++;
          if (rec.status === "no_session") noSession++;
          absentTotal += Number(rec.absentCount) || 0;
        }
      }
    });

    var pct = total ? Math.round(received / total * 100) : 0;
    var stats = $("#dashStats");
    if (stats) {
      stats.innerHTML =
        '<div class="stat"><b>' + received + " / " + total + '</b><span>ملفات وصلت</span></div>' +
        '<div class="stat ' + (pct === 100 ? "p" : "w") + '"><b>' + pct + '%</b><span>اكتمال اليوم</span></div>' +
        '<div class="stat a"><b>' + (total - received) + '</b><span>لم يصل</span></div>' +
        '<div class="stat w"><b>' + noSession + '</b><span>تعذر التحضير</span></div>' +
        '<div class="stat a"><b>' + absentTotal + '</b><span>مجموع الغياب</span></div>';
    }

    var info = $("#matrixInfo");
    if (info) info.textContent = "التاريخ: " + date + " | فصول: " + classes.length + " | حصص: " + periods;

    var t = $("#matrixTbl");
    if (!t) return;
    if (!classes.length) {
      t.innerHTML = '<tbody><tr><td class="empty" colspan="' + (periods + 1) +
        '">لا يوجد طلاب مسجلون. أضف الطلاب أولًا من قسم الطلاب.</td></tr></tbody>';
      renderIncomplete();
      return;
    }
    var html = '<thead><tr><th scope="col">الصف/الفصل</th>';
    for (var p2 = 1; p2 <= periods; p2++) html += "<th scope=\"col\">ح" + p2 + "</th>";
    html += "</tr></thead><tbody>";
    classes.forEach(function (cl) {
      html += '<tr><th scope="row">' + ATT.esc(cl.grade) + "/" + ATT.esc(cl.cls) + "</th>";
      for (var p3 = 1; p3 <= periods; p3++) {
        var rec = receivedFor(date, p3, cl);
        if (!rec) html += '<td class="none">لم يصل</td>';
        else if (rec.status === "no_session") html += '<td class="none"><span class="pill warn">تعذر</span></td>';
        else {
          var n = Number(rec.absentCount) || 0;
          html += '<td class="' + (n ? "no" : "yes") + '" title="' + ATT.esc(rec.teacher || "") + '">' + n + "</td>";
        }
      }
      html += "</tr>";
    });
    html += "</tbody>";
    t.innerHTML = html;
    renderIncomplete();
  }

  function renderIncomplete() {
    var box = $("#dashIncomplete");
    if (!box) return;
    var bad = db.students.filter(function (s) { return !s.grade || !s.cls; });
    if (!bad.length) {
      box.innerHTML = '<p class="muted small">كل الطلاب لديهم صف وفصل. هذا مطلوب لتصدير الحزم ومطابقة الملفات.</p>';
      return;
    }
    box.innerHTML = '<p class="notice small">' + bad.length + " طالبًا بلا صف أو فصل، لن يظهروا في المصفوفة بشكل صحيح.</p>" +
      '<ul class="small" style="margin:8px 0 0">' +
      bad.slice(0, 20).map(function (s) {
        return "<li>" + ATT.esc(s.name) + " — <span class=\"code\">" + ATT.esc(s.code) + "</span></li>";
      }).join("") + "</ul>";
  }

  function copyReminder() {
    var date = ($("#dashDate") && $("#dashDate").value) || ATT.todayKey();
    var periods = Math.max(1, Number(db.settings.periodsPerDay) || 7);
    var classes = classList();
    var missing = [];
    classes.forEach(function (cl) {
      for (var p = 1; p <= periods; p++) {
        if (!receivedFor(date, p, cl)) missing.push(cl.grade + "/" + cl.cls + " ح" + p);
      }
    });
    var text = missing.length
      ? "يرجى إرسال غياب " + date + ": " + missing.slice(0, 20).join("، ") + (missing.length > 20 ? " ..." : "")
      : "تم استلام جميع الغيابات المطلوبة ليوم " + date;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { ATT.toast("تم نسخ الرسالة"); },
        function () { ATT.toast(text); });
    } else ATT.toast(text);
  }

  /* ======================================================================
     الوارد: استيراد ATT-ABSENCE (نفس منطق النسخة الحالية)
     ====================================================================== */
  function logImport(entry) {
    if (!db.central) db.central = { received: {}, importLog: [] };
    if (!Array.isArray(db.central.importLog)) db.central.importLog = [];
    db.central.importLog.push(entry);
  }

  async function handleCentralImport(files) {
    if (!files || !files.length) return;
    if (!(await ATT.loadLib("xlsx"))) {
      var m0 = $("#centralMsg");
      if (m0) m0.textContent = "تعذر تحميل مكتبة Excel المحلية (vendor/xlsx.full.min.js).";
      return;
    }
    if (!db.central) db.central = { received: {}, importLog: [] };
    var msg = $("#centralMsg");
    var count = 0;

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      try {
        var wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
        var wsMeta = wb.Sheets["Meta"], wsAbs = wb.Sheets["Absent"];
        if (!wsMeta || !wsAbs) {
          logImport({ at: new Date().toISOString(), fileName: file.name, fileId: "", key: "", result: "مرفوض", notes: "ورقتان مفقودتان أو تنسيق خاطئ" });
          continue;
        }
        var meta = XLSX.utils.sheet_to_json(wsMeta, { header: 1, defval: "", raw: false });
        var absentRows = XLSX.utils.sheet_to_json(wsAbs, { header: 1, defval: "", raw: false });
        var get = function (k) {
          for (var r = 1; r < meta.length; r++) {
            if (String(meta[r][0]).trim() === k) return String(meta[r][1] == null ? "" : meta[r][1]).trim();
          }
          return "";
        };

        var format = get("format"), fv = get("formatVersion");
        if (format !== "ATT-ABSENCE") {
          logImport({ at: new Date().toISOString(), fileName: file.name, fileId: get("fileId"), key: "", result: "مرفوض", notes: "ليس بصيغة ATT-ABSENCE" });
          continue;
        }
        if (fv && fv !== "1") {
          logImport({ at: new Date().toISOString(), fileName: file.name, fileId: get("fileId"), key: "", result: "مرفوض", notes: "نسخة صيغة غير مدعومة" });
          continue;
        }

        var date = get("date"), period = Number(get("period") || 0), grade = get("grade"), cls = get("cls");
        var teacher = get("teacher"), status = get("status"), reason = get("reason");
        var fileId = get("fileId"), exportedAt = get("exportedAt");
        var rosterCount = Number(get("rosterCount") || 0), presentCount = Number(get("presentCount") || 0);
        var absentCount = Number(get("absentCount") || 0), rosterVersionId = get("rosterVersionId");
        var checksum = get("checksum"), teacherId = get("teacherId"), fileVersion = get("fileVersion");
        var key = date + "|" + period + "|" + grade + "|" + cls;

        if (!date || !period || grade === "" || cls === "") {
          logImport({ at: new Date().toISOString(), fileName: file.name, fileId: fileId, key: key, result: "مرفوض", notes: "بيانات Meta ناقصة" });
          continue;
        }

        var absentCodes = [];
        for (var r2 = 1; r2 < absentRows.length; r2++) {
          var c = String(absentRows[r2][0] == null ? "" : absentRows[r2][0]).trim();
          if (c) absentCodes.push(c);
        }

        if (absentCodes.length !== absentCount) {
          var okCount = await ATT.askConfirm("تحذير", "عدد الغائبين لا يطابق absentCount. هل تقبل رغم التحذير؟", "قبول رغم التحذير");
          if (!okCount) {
            logImport({ at: new Date().toISOString(), fileName: file.name, fileId: fileId, key: key, result: "مرفوض", notes: "عدم تطابق عدد الغائبين" });
            continue;
          }
        }

        var checksumSrc = [format, fv, fileId, date, period, grade, cls, teacher, status, rosterCount, presentCount, absentCount, rosterVersionId].join("|") +
          "|" + absentCodes.slice().sort().join(",");
        var calcChk = ATT.simpleChecksum(checksumSrc);
        if (checksum && checksum !== calcChk) {
          var okChk = await ATT.askConfirm("تحذير", "checksum غير مطابق. قد يكون الملف معدّلًا. هل تقبل رغم التحذير؟", "قبول رغم التحذير");
          if (!okChk) {
            logImport({ at: new Date().toISOString(), fileName: file.name, fileId: fileId, key: key, result: "مرفوض", notes: "عدم تطابق checksum" });
            continue;
          }
        }

        try {
          var dfile = new Date(date + "T00:00:00");
          var nowd = new Date(ATT.todayKey() + "T00:00:00");
          var diff = Math.abs((nowd - dfile) / (1000 * 60 * 60 * 24));
          if (dfile > nowd) {
            var okFuture = await ATT.askConfirm("تحذير", "التاريخ في المستقبل. هل تقبل رغم التحذير؟", "قبول رغم التحذير");
            if (!okFuture) {
              logImport({ at: new Date().toISOString(), fileName: file.name, fileId: fileId, key: key, result: "مرفوض", notes: "تاريخ في المستقبل" });
              continue;
            }
          }
          if (diff > 14) {
            var okOld = await ATT.askConfirm("تحذير", "التاريخ يبعد أكثر من 14 يومًا. هل تقبل رغم التحذير؟", "قبول رغم التحذير");
            if (!okOld) {
              logImport({ at: new Date().toISOString(), fileName: file.name, fileId: fileId, key: key, result: "مرفوض", notes: "تاريخ بعيد جدًا" });
              continue;
            }
          }
        } catch (e) { }

        var unknown = absentCodes.filter(function (cd) { return !ATT.findStudent(db.students, cd); });
        if (unknown.length) ATT.toast("تحذير: " + unknown.length + " كود غير موجود في القائمة المركزية");
        var wrongClass = absentCodes.filter(function (cd) {
          var st = ATT.findStudent(db.students, cd);
          return st && (st.grade !== grade || st.cls !== cls);
        });
        if (wrongClass.length) ATT.toast("تحذير: " + wrongClass.length + " طالب ينتمي لفصل آخر");

        var existing = db.central.received[key];
        if (existing && existing.fileId === fileId) {
          logImport({ at: new Date().toISOString(), fileName: file.name, fileId: fileId, key: key, result: "متجاهل", notes: "نفس fileId مستورد سابقًا", teacherId: teacherId, fileVersion: fileVersion });
          continue;
        }
        if (existing && existing.exportedAt && exportedAt && existing.exportedAt >= exportedAt) {
          logImport({ at: new Date().toISOString(), fileName: file.name, fileId: fileId, key: key, result: "متجاهل", notes: "أقدم أو مساوي للمخزن", teacherId: teacherId, fileVersion: fileVersion });
          continue;
        }
        if (existing) {
          logImport({ at: new Date().toISOString(), fileName: file.name, fileId: fileId, key: key, result: "مستبدَل", notes: "حل محل نسخة أقدم", teacherId: teacherId, fileVersion: fileVersion });
        } else {
          logImport({
            at: new Date().toISOString(), fileName: file.name, fileId: fileId, key: key, result: "مقبول",
            notes: "تم الاستيراد" + (rosterVersionId && rosterVersionId !== (db.rosterVersion && db.rosterVersion.id) ? " | rosterVersion مختلف" : ""),
            teacherId: teacherId, fileVersion: fileVersion
          });
        }

        db.central.received[key] = {
          fileId: fileId, exportedAt: exportedAt, importedAt: new Date().toISOString(),
          status: status, reason: reason, teacher: teacher,
          teacherId: teacherId, fileVersion: fileVersion,
          rosterCount: rosterCount, presentCount: presentCount, absentCount: absentCount,
          absentCodes: absentCodes, sourceFileName: file.name,
          warnings: { unknown: unknown, wrongClass: wrongClass }
        };
        count++;
      } catch (e) {
        logImport({ at: new Date().toISOString(), fileName: file.name, fileId: "", key: "", result: "مرفوض", notes: "خطأ في القراءة" });
      }
    }

    persist();
    renderLog();
    renderDashboard();
    if (msg) msg.textContent = "تمت معالجة " + count + " ملف/ملفات";
  }

  function renderLog() {
    var t = $("#centralLogTbl");
    if (!t) return;
    var central = db.central && typeof db.central === "object" ? db.central : {};
    var log = Array.isArray(central.importLog) ? central.importLog : [];
    if (!log.length) {
      t.innerHTML = '<tbody><tr><td class="empty" colspan="6">لا توجد عمليات استيراد بعد.</td></tr></tbody>';
      return;
    }
    var rows = log.slice().reverse().slice(0, 100);
    var pill = function (r) {
      var kind = r === "مقبول" || r === "مستبدَل" ? "ok" : (r === "متجاهل" ? "mute" : "no");
      return '<span class="pill ' + kind + '">' + ATT.esc(r) + "</span>";
    };
    t.innerHTML = '<thead><tr><th scope="col">الوقت</th><th scope="col">الملف</th><th scope="col">fileId</th>' +
      '<th scope="col">المفتاح</th><th scope="col">النتيجة</th><th scope="col">ملاحظات</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return "<tr><td>" + ATT.esc(ATT.fmtDateTime(r.at)) + '</td><td class="name">' + ATT.esc(r.fileName || "") +
          '</td><td class="code">' + ATT.esc(r.fileId || "") + '</td><td class="code">' + ATT.esc(r.key || "") +
          "</td><td>" + pill(r.result || "") + '</td><td class="name">' + ATT.esc(r.notes || "") + "</td></tr>";
      }).join("") + "</tbody>";
  }

  /* ======================================================================
     التقارير
     ====================================================================== */
  async function renderReport(type) {
    lastReport = type;
    var t = $("#repTbl");
    var msg = $("#repMsg");
    if (!t) return;
    if (msg) msg.textContent = "";
    var from = $("#repFrom") && $("#repFrom").value;
    var to = $("#repTo") && $("#repTo").value;
    var central = (db.central && db.central.received) || {};
    var periodsPerDay = Math.max(1, Number(db.settings.periodsPerDay) || 7);

    if (type === "daily") {
      var date = to || from || ATT.todayKey();
      var rule = db.settings && db.settings.dailyRule ? db.settings.dailyRule : "first_only";
      var periods = rule === "first_only" ? [1] : Array.from({ length: periodsPerDay }, function (_, i) { return i + 1; });
      var map = {};
      periods.forEach(function (p) {
        Object.keys(central).forEach(function (k) {
          var rec = central[k];
          var parts = k.split("|");
          if (parts[0] !== date || parts[1] != String(p)) return;
          (rec.absentCodes || []).forEach(function (c) {
            if (!map[c]) map[c] = { count: 0 };
            map[c].count++;
          });
        });
      });
      var rows = Object.keys(map).map(function (c) {
        var st = ATT.findStudent(db.students, c);
        return { c: c, name: st ? st.name : "", grade: st ? st.grade : "", cls: st ? st.cls : "", count: map[c].count };
      }).sort(function (a, b) { return (a.grade + a.cls + a.name).localeCompare(b.grade + b.cls + b.name); });

      t.innerHTML = '<thead><tr><th scope="col">الكود</th><th scope="col">الاسم</th><th scope="col">الصف</th>' +
        '<th scope="col">الفصل</th><th scope="col">عدد الحصص</th></tr></thead><tbody>' +
        (rows.length ? rows.map(function (r) {
          return "<tr><td>" + ATT.esc(r.c) + '</td><td class="name">' + ATT.esc(r.name) + "</td><td>" +
            ATT.esc(r.grade) + "</td><td>" + ATT.esc(r.cls) + "</td><td>" + r.count + "</td></tr>";
        }).join("") : '<tr><td class="empty" colspan="5">لا توجد غيابات مسجلة لهذا التاريخ.</td></tr>') + "</tbody>";
      if (msg) msg.textContent = "قاعدة: " + (rule === "first_only" ? "الحصة الأولى" : "كل الحصص") + " | تاريخ: " + date + " | عدد الطلاب: " + rows.length;
      return;
    }

    if (type === "byperiod") {
      var date2 = to || from || ATT.todayKey();
      var out = [];
      Object.keys(central).forEach(function (k) {
        var rec = central[k];
        var parts = k.split("|");
        if (parts[0] !== date2) return;
        out.push({ p: Number(parts[1]), grade: parts[2], cls: parts[3], status: rec.status, absent: rec.absentCount, teacher: rec.teacher || "" });
      });
      out.sort(function (a, b) { return (a.p - b.p) || (a.grade + a.cls).localeCompare(b.grade + b.cls); });
      t.innerHTML = '<thead><tr><th scope="col">الحصة</th><th scope="col">الصف</th><th scope="col">الفصل</th>' +
        '<th scope="col">الحالة</th><th scope="col">عدد الغائبين</th><th scope="col">المعلم</th></tr></thead><tbody>' +
        (out.length ? out.map(function (r) {
          return "<tr><td>" + r.p + "</td><td>" + ATT.esc(r.grade) + "</td><td>" + ATT.esc(r.cls) + "</td><td>" +
            ATT.esc(r.status) + "</td><td>" + r.absent + '</td><td class="name">' + ATT.esc(r.teacher) + "</td></tr>";
        }).join("") : '<tr><td class="empty" colspan="6">لا توجد سجلات لهذا التاريخ.</td></tr>') + "</tbody>";
      if (msg) msg.textContent = "تاريخ: " + date2 + " | عدد السجلات: " + out.length;
      return;
    }

    if (type === "student") {
      var code = await ATT.askInput("ملخص طالب", "أدخل كود الطالب ثم اضغط عرض الملخص", "عرض الملخص", { label: "كود الطالب", required: true, dir: "ltr" });
      if (!code) return;
      var c2 = ATT.toLatinDigits(code);
      var st = ATT.findStudent(db.students, c2);
      var list = [];
      Object.keys(central).forEach(function (k) {
        var rec = central[k];
        var codes = rec.absentCodes || [];
        if (codes.indexOf(c2) >= 0 || (st && codes.indexOf(st.code) >= 0)) list.push(k);
      });
      t.innerHTML = '<thead><tr><th scope="col">التاريخ</th><th scope="col">الحصة</th><th scope="col">الصف</th>' +
        '<th scope="col">الفصل</th></tr></thead><tbody>' +
        (list.length ? list.map(function (k) {
          var p = ATT.parseSessionKey(k);
          return "<tr><td>" + ATT.esc(p.date) + "</td><td>" + p.period + "</td><td>" + ATT.esc(p.grade) +
            "</td><td>" + ATT.esc(p.cls) + "</td></tr>";
        }).join("") : '<tr><td class="empty" colspan="4">لا توجد سجلات غياب لهذا الطالب.</td></tr>') + "</tbody>";
      if (msg) msg.textContent = (st ? st.name : c2) + " | عدد مرات الغياب: " + list.length;
      return;
    }

    if (type === "class") {
      var grade = await ATT.askInput("ملخص فصل", "اكتب اسم الصف", "التالي", { label: "الصف", required: true, value: ($("#aGrade") && $("#aGrade").value) || "" });
      if (!grade) return;
      var cls = await ATT.askInput("ملخص فصل", "اكتب اسم الفصل", "عرض الملخص", { label: "الفصل", required: true, value: ($("#aClass") && $("#aClass").value) || "" });
      if (!cls) return;
      var totalAbsent = 0, sessions = 0;
      Object.keys(central).forEach(function (k) {
        var rec = central[k];
        var p = ATT.parseSessionKey(k);
        if (p.grade === grade && p.cls === cls) { totalAbsent += Number(rec.absentCount) || 0; sessions++; }
      });
      t.innerHTML = '<thead><tr><th scope="col">الصف</th><th scope="col">الفصل</th>' +
        '<th scope="col">عدد الملفات</th><th scope="col">مجموع الغائبين</th></tr></thead><tbody><tr><td>' +
        ATT.esc(grade) + "</td><td>" + ATT.esc(cls) + "</td><td>" + sessions + "</td><td>" + totalAbsent + "</td></tr></tbody>";
      if (msg) msg.textContent = "ملخص فصل " + grade + " / " + cls;
    }
  }

  function exportRoster(kind) {
    var list = (db.students || []).slice();
    var title = kind === "filtered" ? "قائمة-طلاب-مفلترة" : "قائمة-طلاب-كاملة";
    if (kind === "filtered") list = currentList();
    var rid = db.rosterVersion && db.rosterVersion.id ? db.rosterVersion.id : "";
    var aoa = [["الاسم", "كود الطالب", "الصف الدراسي", "الفصل", "rosterVersionId"]];
    list.forEach(function (s) { aoa.push([s.name, s.code, s.grade, s.cls, rid]); });
    exportTable(title, aoa, "الطلاب");
  }

  /* ======================================================================
     الإعدادات
     ====================================================================== */
  function renderSettings() {
    var s = db.settings || {};
    if ($("#setSchoolName")) $("#setSchoolName").value = s.schoolName || "";
    if ($("#setPeriods")) $("#setPeriods").value = Number(s.periodsPerDay) || 7;
    if ($("#setDailyRule")) $("#setDailyRule").value = s.dailyRule || "first_only";
    var school = $("#centerSchoolName");
    if (school) school.textContent = s.schoolName || "حضور الطلاب";
    renderPinCard();

    var info = $("#storeInfo");
    if (info) {
      var size = 0;
      try { size = new Blob([JSON.stringify(db)]).size; } catch (e) { size = 0; }
      info.innerHTML =
        "<dt>مفتاح التخزين</dt><dd class=\"ltr\">" + ATT.esc(ATT.CENTER_KEY) + "</dd>" +
        "<dt>حجم البيانات</dt><dd>" + (size / 1024).toFixed(1) + " كيلوبايت</dd>" +
        "<dt>الطلاب</dt><dd>" + db.students.length + "</dd>" +
        "<dt>ملفات الواردة</dt><dd>" + Object.keys((db.central && db.central.received) || {}).length + "</dd>" +
        "<dt>نسخة القائمة</dt><dd class=\"ltr\">" + ATT.esc((db.rosterVersion && db.rosterVersion.id) || "—") + "</dd>";
    }
  }

  function saveSettings() {
    var periods = Math.floor(Number($("#setPeriods").value));
    if (!periods || periods < 1 || periods > 20) {
      $("#setMsg").textContent = "عدد الحصص يجب أن يكون بين 1 و20.";
      return;
    }
    var mins = Math.floor(Number($("#setLockMinutes").value));
    if (!mins || mins < 1 || mins > 60) {
      $("#setMsg").textContent = "مدة القفل التلقائي يجب أن تكون بين دقيقة و60 دقيقة.";
      return;
    }
    db.settings.periodsPerDay = periods;
    db.settings.schoolName = $("#setSchoolName").value.trim();
    db.settings.dailyRule = $("#setDailyRule").value;
    db.settings.lockMinutes = mins;
    persist(); renderSettings(); renderDashboard(); startIdle();
    $("#setMsg").textContent = "تم الحفظ.";
    setTimeout(function () { var el = $("#setMsg"); if (el) el.textContent = ""; }, 2500);
  }

  /* ======================================================================
     قفل المركز بـ PIN (T11)
     ====================================================================== */
  function hasPin() {
    return !!(db && db.settings && db.settings.centralPin && db.settings.centralPin.hash);
  }

  function lockMinutes() {
    var n = Math.floor(Number(db.settings && db.settings.lockMinutes));
    return n >= 1 && n <= 60 ? n : 10;
  }

  function minutesLabel(n) {
    if (n === 1) return "دقيقة واحدة";
    if (n === 2) return "دقيقتان";
    if (n <= 10) return n + " دقائق";
    return n + " دقيقة";
  }

  function pinGuard() {
    if (!db.settings.pinGuard || typeof db.settings.pinGuard !== "object") {
      db.settings.pinGuard = { fails: 0, blockedUntil: 0 };
    }
    return db.settings.pinGuard;
  }

  function blockRemaining() {
    var g = pinGuard();
    return Math.max(0, Number(g.blockedUntil) - Date.now());
  }

  function recordPinFail() {
    var g = pinGuard();
    g.fails = (Number(g.fails) || 0) + 1;
    if (g.fails % 5 === 0) {
      var batch = Math.floor(g.fails / 5);
      var wait = Math.min(30 * 60000, PIN_BLOCK_BASE_MS * Math.pow(2, batch - 1));
      g.blockedUntil = Date.now() + wait;
    }
    persist();
  }

  function clearPinFails() {
    var g = pinGuard();
    if (!g.fails && !g.blockedUntil) return;
    g.fails = 0;
    g.blockedUntil = 0;
    persist();
  }

  function waitText(ms) {
    return "محاولات كثيرة. انتظر " + Math.ceil(ms / 1000) + " ثانية قبل المحاولة مجددًا.";
  }

  /* ---------- شاشة القفل ---------- */
  function setLockMessage(text) {
    var el = $("#lockMsg");
    if (el) el.textContent = text || "";
  }

  function setLockEnabled(on) {
    var inp = $("#lockPin"), btn = $("#btnUnlock");
    if (inp) inp.disabled = !on;
    if (btn) btn.disabled = !on;
  }

  function stopLockTick() {
    if (lockTickTimer) { clearInterval(lockTickTimer); lockTickTimer = null; }
  }

  function startLockTick() {
    stopLockTick();
    lockTickTimer = setInterval(function () {
      var rem = blockRemaining();
      if (rem <= 0 || !locked) {
        stopLockTick();
        setLockEnabled(true);
        setLockMessage("");
        return;
      }
      setLockMessage(waitText(rem));
    }, 500);
  }

  /** يعرض شاشة القفل بلا رسم أي بيانات. تُستدعى عند الإقلاع وعند القفل اليدوي/التلقائي. */
  function showLock() {
    if (!hasPin()) return false;
    locked = true;
    stopIdle();
    var box = $("#lockScreen");
    if (box) box.hidden = false;
    var bar = $("#appbar"), main = $("#main");
    if (bar) { bar.setAttribute("inert", ""); bar.setAttribute("aria-hidden", "true"); }
    if (main) { main.setAttribute("inert", ""); main.setAttribute("aria-hidden", "true"); }
    document.body.classList.add("locked");
    document.title = "مقفل — المركز";
    var school = $("#lockSchoolName");
    if (school) school.textContent = (db.settings && db.settings.schoolName) || "حضور الطلاب";
    var inp = $("#lockPin");
    if (inp) { inp.value = ""; }
    setLockMessage("");
    if (blockRemaining() > 0) {
      setLockEnabled(false);
      setLockMessage(waitText(blockRemaining()));
      startLockTick();
    } else {
      setLockEnabled(true);
      if (inp) { try { inp.focus(); } catch (e) { } }
    }
    return true;
  }

  function hideLock() {
    locked = false;
    stopLockTick();
    stopIdle();
    var box = $("#lockScreen");
    if (box) box.hidden = true;
    var bar = $("#appbar"), main = $("#main");
    if (bar) { bar.removeAttribute("inert"); bar.removeAttribute("aria-hidden"); }
    if (main) { main.removeAttribute("inert"); main.removeAttribute("aria-hidden"); }
    document.body.classList.remove("locked");
    renderAll();
    startIdle();
    var inp = $("#lockPin");
    if (inp) inp.value = "";
  }

  /** القفل الفوري: إعادة تحميل تُبقي الصفحة بلا أي بيانات مرسومة. */
  function lockNow() {
    if (!hasPin()) return;
    stopIdle();
    stopLockTick();
    location.reload();
  }

  async function unlockWith(pin) {
    if (!hasPin() || pinBusy) return false;
    var rem = blockRemaining();
    if (rem > 0) {
      setLockEnabled(false);
      setLockMessage(waitText(rem));
      startLockTick();
      return false;
    }
    var value = ATT.pin.normalize(pin);
    if (!ATT.pin.valid(value)) {
      setLockMessage("رمز PIN يجب أن يكون من 4 إلى 8 أرقام.");
      return false;
    }
    pinBusy = true;
    setLockEnabled(false);
    setLockMessage("جارٍ التحقق…");
    var ok = false;
    try {
      ok = await ATT.pin.verify(value, db.settings.centralPin);
    } catch (e) {
      ok = false;
    }
    pinBusy = false;
    if (!ok) {
      recordPinFail();
      setLockEnabled(true);
      setLockMessage("رمز PIN غير صحيح.");
      var inp = $("#lockPin");
      if (inp) { inp.value = ""; try { inp.focus(); } catch (e) { } }
      if (blockRemaining() > 0) {
        setLockEnabled(false);
        setLockMessage(waitText(blockRemaining()));
        startLockTick();
      }
      return false;
    }
    clearPinFails();
    setLockEnabled(true);
    hideLock();
    ATT.toast("تم فتح المركز");
    return true;
  }

  /* ---------- تأكيد PIN للعمليات الحساسة ---------- */
  function askPin(reason) {
    return new Promise(function (resolve) {
      if (!hasPin()) { resolve(true); return; }
      var d = $("#dlgPin");
      if (!d) { resolve(false); return; }
      var form = $("#pinDlgForm"), inp = $("#pinDlgInput"), err = $("#pinDlgErr");
      var okBtn = $("#pinDlgOk"), cancel = $("#pinDlgCancel");
      var title = $("#pinDlgTitle"), text = $("#pinDlgText");
      if (title) title.textContent = "تأكيد بـ PIN";
      if (text) text.textContent = (reason || "هذه العملية حساسة") + ". أدخل رمز PIN للمتابعة.";
      inp.value = ""; err.textContent = ""; inp.disabled = false; okBtn.disabled = false;
      var settled = false;
      var waitTimer = null;
      var cleanup = function () {
        form.removeEventListener("submit", onSubmit);
        cancel.onclick = null;
        d.removeEventListener("cancel", onCancel);
        if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
      };
      var done = function (v) { if (settled) return; settled = true; cleanup(); if (d.open) d.close(); resolve(v); };
      function applyBlock() {
        var rem = blockRemaining();
        if (rem <= 0) return false;
        inp.disabled = true; okBtn.disabled = true;
        err.textContent = waitText(rem);
        if (waitTimer) clearTimeout(waitTimer);
        waitTimer = setTimeout(function () {
          inp.disabled = false; okBtn.disabled = false;
          err.textContent = "";
        }, rem + 150);
        return true;
      }
      async function onSubmit(e) {
        e.preventDefault();
        if (applyBlock()) return;
        var v = ATT.pin.normalize(inp.value);
        if (!ATT.pin.valid(v)) { err.textContent = "رمز PIN يجب أن يكون من 4 إلى 8 أرقام."; inp.focus(); return; }
        okBtn.disabled = true;
        var ok = false;
        try { ok = await ATT.pin.verify(v, db.settings.centralPin); } catch (ex) { ok = false; }
        if (ok) {
          clearPinFails();
          done(true);
          return;
        }
        recordPinFail();
        okBtn.disabled = false;
        inp.value = "";
        inp.focus();
        if (!applyBlock()) err.textContent = "رمز PIN غير صحيح.";
      }
      function onCancel(e) { e.preventDefault(); done(false); }
      form.addEventListener("submit", onSubmit);
      cancel.onclick = function () { done(false); };
      d.addEventListener("cancel", onCancel);
      ATT.openDialog(d);
      if (!applyBlock()) inp.focus();
    });
  }

  /** يتحقق من PIN فقط إذا كان مضبوطًا. يعيد true عند النجاح أو عند عدم وجود PIN. */
  async function requirePin(reason) {
    if (!hasPin()) return true;
    return (await askPin(reason)) === true;
  }

  /* ---------- إعداد/إزالة PIN ---------- */
  async function savePinFlow() {
    var msg = $("#pinMsg");
    var a = ATT.pin.normalize($("#pinNew").value);
    var b = ATT.pin.normalize($("#pinNew2").value);
    if (!ATT.pin.valid(a)) { if (msg) msg.textContent = "PIN يجب أن يكون من 4 إلى 8 أرقام."; return; }
    if (a !== b) { if (msg) msg.textContent = "الرمزان غير متطابقين."; return; }
    if (!(await requirePin("تغيير رمز PIN"))) return;
    if (msg) msg.textContent = "جارٍ الحفظ…";
    var rec = null;
    try { rec = await ATT.pin.hash(a); } catch (e) { rec = null; }
    if (!rec || !rec.hash) { if (msg) msg.textContent = "تعذر إنشاء PIN على هذا المتصفح."; return; }
    db.settings.centralPin = {
      alg: rec.alg, iterations: rec.iterations, salt: rec.salt, hash: rec.hash
    };
    delete db.settings.centralPinHash;
    db.settings.pinGuard = { fails: 0, blockedUntil: 0 };
    persist();
    renderPinCard();
    renderSettingsSummary();
    startIdle();
    if (msg) msg.textContent = "تم تعيين PIN. سيُطلب عند فتح المركز أو بعد خمول " + minutesLabel(lockMinutes()) + ".";
    ATT.toast("تم تعيين PIN");
  }

  async function removePinFlow() {
    if (!hasPin()) return;
    if (!(await requirePin("إزالة رمز PIN"))) return;
    var ok = await ATT.askConfirm("إزالة PIN",
      "سيصبح المركز مفتوحًا لأي شخص يستخدم هذا الجهاز. هل تريد إزالة الحماية؟", "إزالة PIN");
    if (!ok) return;
    db.settings.centralPin = null;
    db.settings.pinGuard = { fails: 0, blockedUntil: 0 };
    persist();
    stopIdle();
    renderPinCard();
    renderSettingsSummary();
    ATT.toast("تم إزالة PIN");
  }

  function renderPinCard() {
    var state = $("#pinState");
    if (state) {
      state.textContent = hasPin()
        ? "الحماية مفعّلة: يُطلب PIN عند فتح المركز وبعد خمول " + minutesLabel(lockMinutes()) + "، وعند العمليات الحساسة."
        : "لا يوجد PIN. المركز غير محمي، وأي شخص يفتح هذا الجهاز يستطيع الوصول للبيانات.";
    }
    var save = $("#btnPinSave");
    if (save) save.textContent = hasPin() ? "تغيير PIN" : "تعيين PIN";
    var remove = $("#btnPinRemove");
    if (remove) remove.hidden = !hasPin();
    var lockBtn = $("#btnLockNow");
    if (lockBtn) lockBtn.hidden = !hasPin();
    var n1 = $("#pinNew"), n2 = $("#pinNew2");
    if (n1) n1.value = "";
    if (n2) n2.value = "";
    var msg = $("#pinMsg");
    if (msg) msg.textContent = "";
    var sel = $("#setLockMinutes");
    if (sel) sel.value = String(lockMinutes());
  }

  /* ---------- الخمول ---------- */
  function startIdle() {
    stopIdle();
    if (locked || !hasPin()) return;
    lockTimer = setTimeout(function () {
      lockTimer = null;
      lockNow();
    }, lockMinutes() * 60000);
  }

  function stopIdle() {
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
  }

  function bumpIdle() {
    if (locked || !hasPin()) return;
    var now = Date.now();
    if (now - lastBump < 5000) return; // لا نعيد ضبط المؤقت مع كل حركة
    lastBump = now;
    startIdle();
  }

  /* ---------- نسيان PIN: إعادة ضبط المركز ---------- */
  async function resetCenterFlow() {
    var phrase = await ATT.askInput("إعادة ضبط المركز",
      PIN_RESET_PHRASE, "متابعة", { label: "اكتب عبارة التأكيد", required: true });
    if (phrase == null) return;
    if (String(phrase).trim() !== PIN_RESET_PHRASE) {
      ATT.toast("العبارة غير مطابقة. لم يُحذف شيء.");
      return;
    }
    var ok = await ATT.askConfirm("تأكيد الحذف النهائي",
      "سيُحذف كل بيانات المركز: الطلاب والمعلمون والجداول والوارد وكل السجلات ورمز PIN. لا يمكن التراجع. احرص على وجود نسخة احتياطية JSON.",
      "احذف كل بيانات المركز");
    if (!ok) return;
    try {
      localStorage.removeItem(ATT.CENTER_KEY);
    } catch (e) {
      ATT.toast("تعذر حذف البيانات من هذا المتصفح.");
      return;
    }
    location.reload();
  }


  /** يرسم كل الصفحات بعد فتح القفل أو عند الإقلاع بلا PIN. */
  function renderAll() {
    refreshFilters();
    renderStudents();
    renderSettings();
    renderLog();
    route();
    selfCheck();
  }

  /* ======================================================================
     التوجيه
     ====================================================================== */
  function pageFromHash() {
    var h = location.hash || "";
    if (LEGACY[h]) { location.replace(LEGACY[h]); return pageFromHash(); }
    var p = h.replace(/^#\/?/, "");
    return PAGES.indexOf(p) >= 0 ? p : "dashboard";
  }

  function renderPage(page) {
    if (page === "dashboard") { renderDashboard(); renderSettingsSummary(); }
    else if (page === "students") { refreshFilters(); renderStudents(); }
    else if (page === "teachers") { renderTeachers(); refreshTeacherSelects(); refreshScheduleClasses(); renderSchedule(); }
    else if (page === "inbox") { renderLog(); }
    else if (page === "settings") { renderSettings(); }
  }

  function renderSettingsSummary() {
    var pinWarn = $("#pinWarn");
    if (pinWarn) pinWarn.hidden = !!hasPin() || pinSnoozed;
  }

  function route() {
    if (locked) return;
    var page = pageFromHash();
    PAGES.forEach(function (p) {
      var el = document.getElementById("page-" + p);
      if (el) el.classList.toggle("on", p === page);
    });
    var nav = $("#mainNav");
    if (nav) {
      [].forEach.call(nav.querySelectorAll("a[data-page]"), function (a) {
        if (a.dataset.page === page) a.setAttribute("aria-current", "page");
        else a.removeAttribute("aria-current");
      });
    }
    document.title = TITLES[page] || "المركز — حضور الطلاب";
    renderPage(page);
    var main = $("#main");
    if (main) main.focus({ preventScroll: true });
  }

  /* ======================================================================
     الربط والبدء
     ====================================================================== */
  function wire() {
    var form = $("#stuForm");
    if (form) form.addEventListener("submit", onStudentSubmit);
    if ($("#sCancel")) $("#sCancel").onclick = resetForm;

    var tbl = $("#stuTbl");
    if (tbl) {
      tbl.addEventListener("click", function (e) {
        var ed = e.target.closest("[data-edit]"), del = e.target.closest("[data-del]");
        if (ed) {
          var s = ATT.findStudent(db.students, ed.dataset.edit);
          if (!s) return;
          editing = s.code;
          $("#sName").value = s.name; $("#sCode").value = s.code;
          $("#sGrade").value = s.grade; $("#sClass").value = s.cls;
          $("#formTitle").textContent = "تعديل بيانات الطالب";
          $("#sSave").textContent = "حفظ التعديل";
          $("#sCancel").hidden = false;
          $("#sName").focus();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
        if (del) deleteStudent(del.dataset.del);
      });
      tbl.addEventListener("change", function (e) {
        if (e.target.id === "selAll") {
          currentList().forEach(function (s) {
            if (e.target.checked) selected.add(s.code); else selected.delete(s.code);
          });
          renderStudents();
        } else if (e.target.dataset.sel !== undefined) {
          if (e.target.checked) selected.add(e.target.dataset.sel); else selected.delete(e.target.dataset.sel);
          updateLblCount();
        }
      });
    }

    ["stuSearch", "aGrade", "aClass"].forEach(function (id) {
      var el = $("#" + id);
      if (el) el.addEventListener("input", function () { renderStudents(); });
    });

    if ($("#fileIn")) $("#fileIn").addEventListener("change", function (e) {
      var f = e.target.files[0];
      if (f) importFile(f);
      e.target.value = "";
    });

    if ($("#teacherForm")) $("#teacherForm").addEventListener("submit", onTeacherSubmit);
    if ($("#tCancel")) $("#tCancel").onclick = resetTeacherForm;
    var ttbl = $("#teacherTbl");
    if (ttbl) {
      ttbl.addEventListener("click", function (e) {
        var ed = e.target.closest("[data-edit-teacher]");
        var del = e.target.closest("[data-del-teacher]");
        var pack = e.target.closest("[data-pack-teacher]");
        if (ed) editTeacher(ed.dataset.editTeacher);
        if (del) deleteTeacher(del.dataset.delTeacher);
        if (pack) {
          var t = teacherById(pack.dataset.packTeacher);
          if (t) exportTeacherPack(t);
        }
      });
    }

    var daySel = $("#schDay");
    if (daySel) {
      daySel.innerHTML = ATT.DAY_NAMES.map(function (name, i) {
        return '<option value="' + i + '">' + ATT.esc(name) + "</option>";
      }).join("");
    }
    if ($("#schTeacher")) $("#schTeacher").addEventListener("change", function () { renderSchedule(); });
    if ($("#schGrade")) $("#schGrade").addEventListener("change", refreshScheduleClasses);
    if ($("#schAdd")) $("#schAdd").onclick = addLesson;
    var stbl = $("#schTbl");
    if (stbl) {
      stbl.addEventListener("click", function (e) {
        var del = e.target.closest("[data-del-lesson]");
        if (del) deleteLesson(del.dataset.delLesson);
      });
    }
    if ($("#schFileIn")) $("#schFileIn").addEventListener("change", function (e) {
      var f = e.target.files[0];
      e.target.value = "";
      if (f) importScheduleFile(f);
    });
    if ($("#btnSchTemplate")) $("#btnSchTemplate").onclick = exportScheduleTemplate;
    if ($("#btnExportPack")) $("#btnExportPack").onclick = function () {
      var t = teacherById($("#schTeacher").value);
      if (!t) { if ($("#packMsg")) $("#packMsg").textContent = "اختر معلمًا أولًا."; return; }
      exportTeacherPack(t);
    };
    if ($("#btnExportAllPacks")) $("#btnExportAllPacks").onclick = exportAllTeacherPacks;
    if ($("#btnTemplate")) $("#btnTemplate").onclick = function () {
      exportTable("نموذج-الطلاب", [
        ["الاسم", "كود الطالب", "الصف الدراسي", "الفصل"],
        ["أحمد محمد علي (مثال)", "1001", "الصف الأول", "1/أ"],
        ["سارة محمود حسن (مثال)", "1002", "الصف الأول", "1/ب"]
      ], "الطلاب");
    };
    if ($("#btnDemo")) $("#btnDemo").onclick = function () {
      var demo = [
        ["أحمد محمد علي", "1001", "الصف الأول", "1/أ"],
        ["سارة محمود حسن", "1002", "الصف الأول", "1/أ"],
        ["يوسف إبراهيم سعيد", "1003", "الصف الأول", "1/ب"],
        ["مريم خالد عبد الله", "1004", "الصف الثاني", "2/أ"],
        ["عمر طارق فؤاد", "1005", "الصف الثاني", "2/أ"],
        ["نور الدين حسام", "1006", "الصف الثاني", "2/ب"]
      ];
      var n = 0;
      demo.forEach(function (row) {
        if (!ATT.findStudent(db.students, row[1])) {
          db.students.push({ name: row[0], code: row[1], grade: row[2], cls: row[3] });
          n++;
        }
      });
      if (n) touchRoster();
      persist(); refreshFilters(); renderStudents(); renderDashboard();
      ATT.toast(n ? "تمت إضافة " + n + " طلاب تجريبيين" : "الطلاب التجريبيون مضافون بالفعل");
    };

    if ($("#btnLblPreview")) $("#btnLblPreview").onclick = previewLabels;
    if ($("#btnPrint")) $("#btnPrint").onclick = printLabels;
    if ($("#lSize")) $("#lSize").onchange = function () {
      var box = $("#lblPreview");
      if (box && box.children.length) previewLabels();
    };

    if ($("#dashDate")) $("#dashDate").value = ATT.todayKey();
    if ($("#dashDate")) $("#dashDate").addEventListener("change", renderDashboard);
    if ($("#btnRefreshMatrix")) $("#btnRefreshMatrix").onclick = renderDashboard;
    if ($("#btnCopyReminder")) $("#btnCopyReminder").onclick = copyReminder;

    if ($("#centralFileIn")) $("#centralFileIn").addEventListener("change", function (e) {
      // نأخذ نسخة من الملفات قبل تفريغ الحقل، لأن تفريغه يمسح FileList بينما الدالة async
      var picked = Array.prototype.slice.call(e.target.files || []);
      e.target.value = "";
      handleCentralImport(picked);
    });
    if ($("#btnInboxRefresh")) $("#btnInboxRefresh").onclick = renderLog;

    if ($("#btnRepDaily")) $("#btnRepDaily").onclick = function () { renderReport("daily"); };
    if ($("#btnRepByPeriod")) $("#btnRepByPeriod").onclick = function () { renderReport("byperiod"); };
    if ($("#btnRepStudent")) $("#btnRepStudent").onclick = function () { renderReport("student"); };
    if ($("#btnRepClass")) $("#btnRepClass").onclick = function () { renderReport("class"); };
    if ($("#repFrom")) $("#repFrom").value = ATT.todayKey();
    if ($("#repTo")) $("#repTo").value = ATT.todayKey();
    if ($("#btnExportRosterAll")) $("#btnExportRosterAll").onclick = function () { exportRoster("all"); };
    if ($("#btnExportRosterFiltered")) $("#btnExportRosterFiltered").onclick = function () { exportRoster("filtered"); };

    if ($("#btnSaveSettings")) $("#btnSaveSettings").onclick = saveSettings;
    if ($("#btnPinSave")) $("#btnPinSave").onclick = savePinFlow;
    if ($("#btnPinRemove")) $("#btnPinRemove").onclick = removePinFlow;
    if ($("#btnPinSnooze")) $("#btnPinSnooze").onclick = function () {
      pinSnoozed = true;
      renderSettingsSummary();
    };
    if ($("#btnLockNow")) $("#btnLockNow").onclick = lockNow;
    if ($("#lockForm")) $("#lockForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var inp = $("#lockPin");
      unlockWith(inp ? inp.value : "");
    });
    if ($("#btnResetCenter")) $("#btnResetCenter").onclick = resetCenterFlow;
    ["pointerdown", "keydown", "touchstart", "wheel"].forEach(function (ev) {
      document.addEventListener(ev, bumpIdle, { passive: true });
    });
    if ($("#btnBackupExport")) $("#btnBackupExport").onclick = function () {
      downloadJson("attendance_center_backup_" + ATT.todayKey() + ".json", db);
      var m = $("#backupMsg"); if (m) m.textContent = "تم تنزيل النسخة الاحتياطية.";
    };
    if ($("#backupIn")) $("#backupIn").addEventListener("change", async function (e) {
      var f = e.target.files[0];
      e.target.value = "";
      if (!f) return;
      var m = $("#backupMsg");
      try {
        var obj = JSON.parse(await f.text());
        if (!obj || typeof obj !== "object" || !Array.isArray(obj.students)) throw new Error("bad");
        var ok = await ATT.askConfirm("استعادة نسخة احتياطية", "سيتم استبدال بيانات المركز الحالية بالنسخة المختارة. هل تريد المتابعة؟", "استعادة");
        if (!ok) return;
        if (!(await requirePin("استعادة نسخة احتياطية"))) return;
        db = ATT.migrateV2ToV3(obj);
        persist(); refreshFilters(); renderStudents(); renderDashboard(); renderSettings(); renderLog();
        renderSettingsSummary(); startIdle();
        if (m) m.textContent = "تم استعادة النسخة الاحتياطية.";
      } catch (ex) {
        if (m) m.textContent = "فشل استعادة النسخة: الملف ليس نسخة احتياطية صالحة.";
      }
    });

    if ($("#btnClearAtt")) $("#btnClearAtt").onclick = async function () {
      var ok = await ATT.askConfirm("حذف سجلات الحضور القديمة",
        "سيتم حذف سجلات الحضور القديمة (attendance) والجلسات المحفوظة. الطلاب وملفات الوارد تبقى كما هي.", "حذف السجلات");
      if (!ok) return;
      if (!(await requirePin("حذف سجلات الحضور"))) return;
      db.attendance = {};
      db.sessions = {};
      persist(); renderDashboard(); renderSettings();
      ATT.toast("تم حذف سجلات الحضور القديمة");
    };

    if ($("#btnClearAll")) $("#btnClearAll").onclick = async function () {
      var ok = await ATT.askConfirm("حذف كل بيانات المركز",
        "سيتم حذف الطلاب والمعلمين والجداول وملفات الوارد وكل السجلات نهائيًا. نزّل نسخة احتياطية أولًا.", "حذف الكل");
      if (!ok) return;
      var again = await ATT.askConfirm("تأكيد نهائي", "هل أنت متأكد؟ لا يمكن التراجع عن هذه العملية.", "نعم، احذف الكل");
      if (!again) return;
      if (!(await requirePin("حذف كل بيانات المركز"))) return;
      db = ATT.defaultCenterDb();
      selected.clear();
      persist(); refreshFilters(); renderStudents(); renderDashboard(); renderSettings(); renderLog();
      ATT.toast("تم حذف كل بيانات المركز");
    };
  }

  function migrationNotice(m) {
    var el = $("#migrateNotice");
    if (!el) return;
    if (m.status === "migrated") {
      el.className = "notice info";
      el.textContent = "تم ترحيل بيانات النسخة السابقة: " + m.students + " طالبًا و" + m.received +
        " ملف غياب. لم يُحذف المفتاح القديم " + m.sourceKey + "، وحُفظت نسخة احتياطية في " + m.backupKey + ".";
      if (!m.backupSaved) el.textContent += " تعذر حفظ النسخة الاحتياطية، لكن بيانات المفتاح القديم ما زالت كما هي.";
    } else {
      el.className = "notice danger";
      el.textContent = m.status === "invalid"
        ? "تعذر ترحيل بيانات النسخة السابقة: محتوى " + m.sourceKey + " غير صالح. لم يُحذف المفتاح القديم."
        : "تعذر قراءة التخزين المحلي لترحيل بيانات النسخة السابقة.";
    }
    el.hidden = false;
  }

  function selfCheck() {
    var info = $("#bootInfo");
    if (!info) return;
    var pieces = ["النواة: " + (ATT && ATT.version ? ATT.version : "غير محمّلة")];
    ATT.loadLib("xlsx").then(function (ok) {
      info.textContent = pieces.join(" · ") + " · Excel المحلي: " + (ok ? "جاهز" : "غير متاح");
    });
  }

  function init() {
    ATT.wireDialogs();
    var hadCenter = true;
    try { hadCenter = !!window.localStorage.getItem(ATT.CENTER_KEY); } catch (e) { hadCenter = true; }
    var st = store.load();
    db = st.db;
    if (!hadCenter) {
      var mig = ATT.migrateLegacyCenter();
      if (mig.status === "migrated") {
        db = mig.db;
        store.db = db;
        if (!store.save()) {
          var mw = $("#storeWarn");
          if (mw) mw.hidden = false;
        }
        migrationNotice(mig);
      } else if (mig.status === "invalid" || mig.status === "unavailable") {
        migrationNotice(mig);
      }
    }
    if (!st.ok) {
      var warn = $("#storeWarn");
      if (warn) warn.hidden = false;
    }
    if (!db.settings) db.settings = ATT.defaultCenterSettings();
    if (!db.settings.pinGuard || typeof db.settings.pinGuard !== "object") {
      db.settings.pinGuard = { fails: 0, blockedUntil: 0 };
    }
    if (ensureTeacherData()) persist();
    wire();
    window.addEventListener("hashchange", route);
    // لا نرسم أي بيانات قبل فتح القفل عند وجود PIN.
    if (hasPin()) {
      showLock();
      return;
    }
    renderAll();
    startIdle();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.CENTER = {
    route: route,
    pageFromHash: pageFromHash,
    get db() { return db; },
    handleCentralImport: handleCentralImport,
    renderDashboard: renderDashboard,
    labelsHtml: labelsHtml,
    pinState: function () {
      return { locked: locked, hasPin: hasPin(), blockedMs: blockRemaining(), snoozed: pinSnoozed };
    },
    unlockWithPin: unlockWith,
    lockNow: lockNow,
    requirePin: requirePin
  };
})();
