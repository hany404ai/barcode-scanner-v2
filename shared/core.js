/* ==========================================================================
   ATT core — منطق مشترك بين center/ و teacher/
   سكربت كلاسيكي (لا ES Modules) لكي يعمل المركز من file://.
   يُعرَّض عبر window.ATT، ويُصدَّر عبر module.exports لاختبارات Node.
   لا يستخدم هذا الملف أي طلب شبكة عند التحميل.
   ========================================================================== */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root) root.ATT = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ATT = {};
  ATT.version = "2.0.0";
  ATT.appVersion = "2.0";

  ATT.CENTER_KEY = "attendance_center_v3";
  ATT.TEACHER_KEY = "attendance_teacher_v1";
  ATT.LEGACY_V2_KEY = "attendance_app_v2";
  ATT.LEGACY_V1_KEY = "attendance_app_v1";
  ATT.LEGACY_V2_BACKUP_KEY = "attendance_app_v2_backup_migrated";

  /* ======================================================================
     1) مساعدات عامة
     ====================================================================== */
  ATT.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  ATT.pad = function (n) { return String(n).padStart(2, "0"); };

  /** مفتاح تاريخ محلي بصيغة YYYY-MM-DD (بتوقيت الجهاز، لا UTC). */
  ATT.dateKey = function (d) {
    var x = d instanceof Date ? d : new Date();
    return x.getFullYear() + "-" + ATT.pad(x.getMonth() + 1) + "-" + ATT.pad(x.getDate());
  };
  ATT.todayKey = function () { return ATT.dateKey(new Date()); };

  var timeFmt = null, dtFmt = null;
  ATT.fmtTime = function (iso) {
    try {
      timeFmt = timeFmt || new Intl.DateTimeFormat("ar-EG-u-nu-latn", { hour: "2-digit", minute: "2-digit" });
      return timeFmt.format(new Date(iso));
    } catch (e) { return String(iso || ""); }
  };
  ATT.fmtDateTime = function (iso) {
    try {
      dtFmt = dtFmt || new Intl.DateTimeFormat("ar-EG-u-nu-latn", { dateStyle: "short", timeStyle: "short" });
      return dtFmt.format(new Date(iso));
    } catch (e) { return String(iso || ""); }
  };
  ATT.sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  ATT.collator = new Intl.Collator("ar");

  ATT.uid = function () {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch (e) { }
    return "id_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
  };
  ATT.fileIdGen = function () { return ATT.uid(); };

  /** checksum الحالي — يجب ألا تتغير معادلته (توافق ATT-ABSENCE v1). */
  ATT.simpleChecksum = function (str) {
    var h = 0, s = String(str || "");
    for (var i = 0; i < s.length; i++) { h = (h * 131542391 + s.charCodeAt(i)) >>> 0; }
    return h.toString(16);
  };

  ATT.sanitizeFileName = function (name) { return String(name || "").replace(/[\\\/:*?"<>|]+/g, "_"); };
  ATT.sessionKey = function (d, p, g, c) { return d + "|" + p + "|" + g + "|" + c; };
  ATT.parseSessionKey = function (key) {
    var p = String(key || "").split("|");
    return { date: p[0] || "", period: Number(p[1]) || 0, grade: p[2] || "", cls: p[3] || "" };
  };

  ATT.toLatinDigits = function (s) {
    return String(s)
      .replace(/[٠-٩]/g, function (d) { return "٠١٢٣٤٥٦٧٨٩".indexOf(d); })
      .replace(/[۰-۹]/g, function (d) { return "۰۱۲۳۴۵۶۷۸۹".indexOf(d); });
  };

  ATT.fileExt = function (name) {
    var s = String(name || "");
    var i = s.lastIndexOf(".");
    return i < 0 ? "" : s.slice(i + 1).toLowerCase();
  };

  ATT.findStudent = function (students, code) {
    var c = String(code == null ? "" : code).trim().toLowerCase();
    if (!c) return null;
    var list = students || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s && s.code && String(s.code).toLowerCase() === c) return s;
    }
    return null;
  };

  ATT.filtered = function (list, grade, cls) {
    return (list || []).filter(function (s) {
      return (!grade || s.grade === grade) && (!cls || s.cls === cls);
    });
  };

  ATT.distinctValues = function (list, key) {
    var seen = {}, out = [];
    (list || []).forEach(function (s) {
      var v = s && s[key];
      if (v && !seen[v]) { seen[v] = true; out.push(v); }
    });
    return out.sort(ATT.collator.compare);
  };

  /* ======================================================================
     2) SHA-256 نقي + PIN (PBKDF2 عبر crypto.subtle مع بديل SHA-256 متكرر)
     ====================================================================== */
  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  /** UTF-8 bytes بدون الاعتماد على TextEncoder. */
  function utf8Bytes(str) {
    var s = String(str == null ? "" : str), out = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
        var c2 = s.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function sha256Bytes(bytes) {
    var H = new Int32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    var len = bytes.length;
    var total = (((len + 9) + 63) >> 6) << 6;
    var m = new Uint8Array(total);
    m.set(bytes);
    m[len] = 0x80;
    var bits = len * 8;
    var hi = Math.floor(bits / 0x100000000);
    var lo = bits >>> 0;
    m[total - 8] = (hi >>> 24) & 255; m[total - 7] = (hi >>> 16) & 255;
    m[total - 6] = (hi >>> 8) & 255; m[total - 5] = hi & 255;
    m[total - 4] = (lo >>> 24) & 255; m[total - 3] = (lo >>> 16) & 255;
    m[total - 2] = (lo >>> 8) & 255; m[total - 1] = lo & 255;

    var w = new Int32Array(64);
    for (var off = 0; off < total; off += 64) {
      var i;
      for (i = 0; i < 16; i++) {
        w[i] = (m[off + i * 4] << 24) | (m[off + i * 4 + 1] << 16) | (m[off + i * 4 + 2] << 8) | m[off + i * 4 + 3];
      }
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        var s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
        var s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = "";
    for (var k = 0; k < 8; k++) out += ("00000000" + (H[k] >>> 0).toString(16)).slice(-8);
    return out;
  }

  function bytesToHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += ("0" + (bytes[i] & 255).toString(16)).slice(-2);
    return out;
  }
  function hexToBytes(hex) {
    var s = String(hex || ""), out = new Uint8Array(Math.floor(s.length / 2));
    for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16) || 0;
    return out;
  }
  function concatBytes(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }
  function randomBytes(n) {
    var b = new Uint8Array(n);
    try {
      if (typeof crypto !== "undefined" && crypto.getRandomValues) { crypto.getRandomValues(b); return b; }
    } catch (e) { }
    for (var i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
    return b;
  }
  function constantTimeEqual(a, b) {
    var x = String(a || ""), y = String(b || "");
    if (x.length !== y.length) return false;
    var diff = 0;
    for (var i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
  }

  /** ATT.sha256(str) → hex. */
  ATT.sha256 = function (str) { return sha256Bytes(utf8Bytes(str)); };
  ATT.sha256Bytes = sha256Bytes;
  ATT.hexToBytes = hexToBytes;
  ATT.bytesToHex = bytesToHex;

  var PIN_DEFAULT_ITERATIONS = 120000;
  var PIN_FALLBACK_ITERATIONS = 50000;

  ATT.pin = {
    minLength: 4,
    maxLength: 8,
    defaultIterations: PIN_DEFAULT_ITERATIONS,
    fallbackIterations: PIN_FALLBACK_ITERATIONS,

    /** PIN من 4 إلى 8 أرقام لاتينية بعد تحويل الأرقام العربية. */
    valid: function (pin) { return /^\d{4,8}$/.test(ATT.toLatinDigits(String(pin == null ? "" : pin).trim())); },
    normalize: function (pin) { return ATT.toLatinDigits(String(pin == null ? "" : pin).trim()); },

    /**
     * يُنشئ سجل PIN: { alg, iterations, salt, hash }.
     * opts: { salt, iterations, forceFallback }
     */
    hash: async function (pin, opts) {
      var o = opts || {};
      var value = ATT.pin.normalize(pin);
      var salt = o.salt
        ? (typeof o.salt === "string" ? hexToBytes(o.salt) : o.salt)
        : randomBytes(16);
      var iterations = Math.max(1, Math.floor(Number(o.iterations) || PIN_DEFAULT_ITERATIONS));
      var subtle = null;
      try {
        if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.importKey) subtle = crypto.subtle;
      } catch (e) { subtle = null; }

      if (subtle && !o.forceFallback) {
        try {
          var key = await subtle.importKey("raw", utf8Bytes(value), "PBKDF2", false, ["deriveBits"]);
          var bits = await subtle.deriveBits(
            { name: "PBKDF2", salt: salt, iterations: iterations, hash: "SHA-256" }, key, 256
          );
          return { alg: "pbkdf2-sha256", iterations: iterations, salt: bytesToHex(salt), hash: bytesToHex(new Uint8Array(bits)) };
        } catch (e) { /* يسقط إلى البديل */ }
      }

      // بديل: سلسلة SHA-256 متكررة على (salt || pin). أضعف من PBKDF2 لكنها تعمل بلا crypto.subtle.
      var iter = o.iterations ? iterations : PIN_FALLBACK_ITERATIONS;
      var pinBytes = utf8Bytes(value);
      var cur = hexToBytes(sha256Bytes(concatBytes(salt, pinBytes)));
      for (var i = 1; i < iter; i++) cur = hexToBytes(sha256Bytes(concatBytes(salt, cur)));
      return { alg: "sha256-iter", iterations: iter, salt: bytesToHex(salt), hash: bytesToHex(cur) };
    },

    /** يتحقق من PIN مقابل سجل محفوظ. يعيد Promise<boolean>. */
    verify: async function (pin, rec) {
      if (!rec || !rec.salt || !rec.hash) return false;
      var algo = rec.alg || "pbkdf2-sha256";
      if (algo === "pbkdf2-sha256") {
        var subtle = null;
        try {
          if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.deriveBits) subtle = crypto.subtle;
        } catch (e) { subtle = null; }
        if (!subtle) return false; // لا يمكن إعادة الحساب بنفس الخوارزمية على هذا المتصفح
      }
      var out = await ATT.pin.hash(pin, {
        salt: rec.salt,
        iterations: rec.iterations,
        forceFallback: algo !== "pbkdf2-sha256"
      });
      return constantTimeEqual(out.hash, rec.hash);
    }
  };

  /* ======================================================================
     3) Code 128 (المجموعة B) — كما هو في النسخة الحالية
     ====================================================================== */
  var C128 = ["212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132", "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211", "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331", "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214", "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111", "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141", "114131", "311141", "411131", "211412", "211214", "211232", "2331112"];

  ATT.c128Valid = function (t) { return /^[\x20-\x7e]+$/.test(String(t == null ? "" : t)); };
  ATT.c128Widths = function (text) {
    var s = String(text == null ? "" : text);
    var vals = [104], sum = 104;
    for (var i = 0; i < s.length; i++) { var v = s.charCodeAt(i) - 32; vals.push(v); sum += v * (i + 1); }
    vals.push(sum % 103, 106);
    var w = [];
    for (var j = 0; j < vals.length; j++) {
      var pat = C128[vals[j]];
      for (var k = 0; k < pat.length; k++) w.push(+pat[k]);
    }
    return w;
  };

  ATT.c128Quiet = 10;
  ATT.c128Svg = function (text) {
    var s = String(text == null ? "" : text);
    var w = ATT.c128Widths(s), x = ATT.c128Quiet, r = "";
    w.forEach(function (n, i) {
      if (i % 2 === 0) r += '<rect x="' + x + '" y="0" width="' + n + '" height="1"/>';
      x += n;
    });
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + (x + ATT.c128Quiet) +
      ' 1" preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000" role="img" aria-label="' +
      ATT.esc(s) + '">' + r + "</svg>";
  };

  /** يحتاج document/canvas — يُستخدم في المتصفح فقط (اختبار التشخيص). */
  ATT.c128Canvas = function (text, scale, h) {
    var sc = scale || 3, height = h || 140;
    var w = ATT.c128Widths(text);
    var total = w.reduce(function (a, b) { return a + b; }, 0) + ATT.c128Quiet * 2;
    var c = document.createElement("canvas");
    c.width = total * sc; c.height = height;
    var g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#000";
    var x = ATT.c128Quiet * sc;
    w.forEach(function (n, i) {
      if (i % 2 === 0) g.fillRect(x, 10, n * sc, height - 20);
      x += n * sc;
    });
    return c;
  };

  /* ======================================================================
     4) CSV / Excel — نفس منطق استيراد الطلاب الحالي
     ====================================================================== */
  ATT.parseCSV = function (text) {
    var s = String(text == null ? "" : text).replace(/^﻿/, "");
    var first = s.split(/\r?\n/)[0] || "";
    var cnt = function (ch) { return first.split(ch).length; };
    var delim = cnt("\t") > 1 ? "\t" : (cnt(";") > cnt(",") ? ";" : ",");
    var rows = [], row = [], cur = "", q = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cur); cur = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        row.push(cur); rows.push(row); row = []; cur = "";
      } else cur += ch;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows;
  };

  ATT.normHeader = function (s) {
    return String(s == null ? "" : s).toLowerCase()
      .replace(/[ً-ٟـ\s_\-]/g, "")
      .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
  };
  ATT.FIELD_KEYS = {
    code: ["كود", "رقم", "code", "id", "باركود", "barcode"],
    name: ["اسم", "name"],
    cls: ["فصل", "شعبه", "class", "section"],
    grade: ["صف", "مرحله", "grade", "level"]
  };

  ATT.mapHeader = function (row) {
    var map = {};
    (row || []).forEach(function (cell, i) {
      var h = ATT.normHeader(cell);
      if (!h) return;
      ["code", "name", "cls", "grade"].some(function (f) {
        if (map[f] !== undefined) return false;
        var hit = ATT.FIELD_KEYS[f].some(function (k) { return h.indexOf(ATT.normHeader(k)) >= 0; });
        if (hit) map[f] = i;
        return hit;
      });
    });
    return map;
  };

  /**
   * يدمج صفوف Excel/CSV في مصفوفة الطلاب (تعديل مباشر للمصفوفة).
   * يعيد { added, updated, skipped, badBarcode, notes, assumed }.
   */
  ATT.mergeRows = function (rows, students) {
    var list = students || [];
    var map = null, start = 0;
    var limit = Math.min((rows || []).length, 10);
    for (var i = 0; i < limit; i++) {
      var m = ATT.mapHeader(rows[i]);
      if (m.name !== undefined && m.code !== undefined) { map = m; start = i + 1; break; }
    }
    var assumed = false;
    if (!map) { map = { name: 0, code: 1, grade: 2, cls: 3 }; assumed = true; }
    var res = { added: 0, updated: 0, skipped: 0, badBarcode: 0, notes: [], assumed: assumed };
    for (var r = start; r < (rows || []).length; r++) {
      var line = rows[r];
      if (!line || line.every(function (c) { return String(c == null ? "" : c).trim() === ""; })) continue;
      var get = function (f) { return map[f] === undefined ? "" : String(line[map[f]] == null ? "" : line[map[f]]).trim(); };
      var name = get("name"), code = ATT.toLatinDigits(get("code"));
      var grade = get("grade"), cls = get("cls");
      if (!name || !code) {
        res.skipped++;
        if (res.notes.length < 3) res.notes.push("سطر " + (r + 1) + ": الاسم أو الكود فارغ");
        continue;
      }
      if (!ATT.c128Valid(code)) res.badBarcode++;
      var ex = ATT.findStudent(list, code);
      if (ex) { ex.name = name; ex.grade = grade; ex.cls = cls; res.updated++; }
      else { list.push({ name: name, code: code, grade: grade, cls: cls }); res.added++; }
    }
    return res;
  };

  /* ======================================================================
     5) صيغة ملف الغياب ATT-ABSENCE v1 (المعادلة الحالية بلا تغيير)
     ====================================================================== */
  ATT.absenceChecksumSource = function (payload, absentCodes) {
    var p = payload || {};
    var base = [
      p.format, p.formatVersion, p.fileId, p.date, p.period, p.grade, p.cls,
      p.teacher, p.status, p.rosterCount, p.presentCount, p.absentCount, p.rosterVersionId
    ].join("|");
    var codes = (absentCodes || []).map(function (c) { return String(c); });
    codes.sort();
    return base + "|" + codes.join(",");
  };
  ATT.absenceChecksum = function (payload, absentCodes) {
    return ATT.simpleChecksum(ATT.absenceChecksumSource(payload, absentCodes));
  };

  /**
   * يبني كائن ATT-ABSENCE مع checksum.
   * opts: { session, absent, rosterVersionId, teacherId, fileVersion, fileId, exportedAt }
   * teacherId و fileVersion اختياريان ولا يدخلان في الـ checksum.
   */
  ATT.buildAbsencePayload = function (opts) {
    var o = opts || {};
    var session = o.session || {};
    var absent = Array.isArray(o.absent) ? o.absent : [];
    var payload = {
      format: "ATT-ABSENCE",
      formatVersion: 1,
      fileId: o.fileId || ATT.fileIdGen(),
      date: session.date || "",
      period: Number(session.period) || 1,
      grade: session.grade || "",
      cls: session.cls || "",
      teacher: session.teacher || "",
      status: session.status === "no_session" ? "no_session" : "completed",
      reason: session.reason || "",
      rosterCount: Number(session.rosterCount) || 0,
      presentCount: Number(session.presentCount) || 0,
      absentCount: absent.length,
      rosterVersionId: o.rosterVersionId || "",
      exportedAt: o.exportedAt || new Date().toISOString(),
      appVersion: o.appVersion || ATT.appVersion,
      absent: absent.map(function (s) {
        return { code: String(s.code), name: s.name || "", grade: s.grade || "", cls: s.cls || "" };
      }),
      checksum: ""
    };
    if (o.teacherId) payload.teacherId = String(o.teacherId);
    payload.fileVersion = Number(o.fileVersion) || 1;
    payload.checksum = ATT.absenceChecksum(payload, payload.absent.map(function (s) { return s.code; }));
    return payload;
  };

  /* ======================================================================
     6) حزمة المعلم ATT-TEACHER-PACK v1
     ====================================================================== */
  ATT.packChecksumSource = function (pack) {
    var p = pack || {};
    var codes = (p.students || []).map(function (s) { return String(s && s.code != null ? s.code : ""); });
    codes.sort();
    return [
      p.format, p.formatVersion, p.packId, p.teacherId, p.issuedAt, p.rosterVersionId
    ].join("|") + "|" + codes.join(",");
  };
  ATT.packChecksum = function (pack) { return ATT.simpleChecksum(ATT.packChecksumSource(pack)); };

  function packError(code, message) { return { code: code, message: message }; }

  /** يُرجع { ok, errors:[{code,message}] } — كل التحقق من صيغة الحزمة هنا. */
  ATT.validatePack = function (obj) {
    var errors = [];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return { ok: false, errors: [packError("format", "الملف ليس كائن JSON صالحًا.")] };
    }
    if (obj.format !== "ATT-TEACHER-PACK") {
      errors.push(packError("format", obj.format === "ATT-ABSENCE"
        ? "هذا ملف غياب وليس حزمة معلم."
        : "صيغة الملف غير معروفة، يجب أن تكون ATT-TEACHER-PACK."));
    }
    if (Number(obj.formatVersion) !== 1) {
      errors.push(packError("formatVersion", "نسخة الصيغة غير مدعومة (المطلوب 1)."));
    }
    ["packId", "teacherId", "teacherName", "issuedAt", "rosterVersionId"].forEach(function (k) {
      if (!obj[k] || typeof obj[k] !== "string") {
        errors.push(packError(k, "حقل مطلوب ناقص أو غير صالح: " + k + "."));
      }
    });
    if (obj.issuedAt && isNaN(new Date(obj.issuedAt).getTime())) {
      errors.push(packError("issuedAt", "تاريخ إصدار الحزمة غير صالح."));
    }

    var settings = obj.settings && typeof obj.settings === "object" ? obj.settings : null;
    var periodsPerDay = 0;
    if (!settings) {
      errors.push(packError("settings", "إعدادات الحزمة مفقودة."));
    } else {
      periodsPerDay = Number(settings.periodsPerDay);
      if (!isFinite(periodsPerDay) || periodsPerDay < 1 || Math.floor(periodsPerDay) !== periodsPerDay) {
        errors.push(packError("settings", "عدد الحصص اليومية غير صالح."));
        periodsPerDay = 0;
      }
      if (settings.schoolDays !== undefined) {
        if (!Array.isArray(settings.schoolDays) || settings.schoolDays.some(function (d) {
          return !isFinite(Number(d)) || Number(d) < 0 || Number(d) > 6 || Math.floor(Number(d)) !== Number(d);
        })) {
          errors.push(packError("schoolDays", "أيام الدراسة يجب أن تكون أرقامًا من 0 إلى 6."));
        }
      }
      if (settings.bellTimes !== undefined && !Array.isArray(settings.bellTimes)) {
        errors.push(packError("bellTimes", "أوقات الحصص يجب أن تكون قائمة."));
      }
      if (settings.centerWhatsapp !== undefined && settings.centerWhatsapp !== null && String(settings.centerWhatsapp).trim() !== "") {
        var w = String(settings.centerWhatsapp).trim().replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 1632); });
        if (!/^[0-9]{10,15}$/.test(w)) {
          errors.push(packError("centerWhatsapp", "رقم واتساب المركز غير صالح."));
        }
      }
      if (settings.includeNames !== undefined && typeof settings.includeNames !== "boolean") {
        errors.push(packError("includeNames", "includeNames يجب أن يكون منطقيًا."));
      }
    }

    var classes = Array.isArray(obj.classes) ? obj.classes : null;
    var classKeys = {};
    if (!classes) errors.push(packError("classes", "قائمة الفصول مفقودة."));
    else if (!classes.length) errors.push(packError("classes", "الحزمة لا تحتوي أي فصل."));
    else {
      classes.forEach(function (c, i) {
        if (!c || typeof c !== "object" || !c.grade || !c.cls) {
          errors.push(packError("class-fields", "فصل غير مكتمل في العنصر " + (i + 1) + "."));
          return;
        }
        var key = String(c.grade) + "|" + String(c.cls);
        if (classKeys[key]) errors.push(packError("class-duplicate", "فصل مكرر: " + c.grade + " / " + c.cls + "."));
        classKeys[key] = { count: 0 };
      });
    }

    var students = Array.isArray(obj.students) ? obj.students : null;
    var codeSeen = {};
    if (!students) errors.push(packError("students", "قائمة الطلاب مفقودة."));
    else if (!students.length) errors.push(packError("students", "الحزمة لا تحتوي أي طالب."));
    else {
      students.forEach(function (s, i) {
        if (!s || typeof s !== "object" || !String(s.code || "").trim() || !String(s.name || "").trim()) {
          errors.push(packError("student-fields", "طالب بلا اسم أو كود في العنصر " + (i + 1) + "."));
          return;
        }
        var code = String(s.code).trim();
        if (codeSeen[code]) errors.push(packError("code-duplicate", "كود طالب مكرر: " + code + "."));
        codeSeen[code] = true;
        var key = String(s.grade || "") + "|" + String(s.cls || "");
        if (classKeys[key]) classKeys[key].count++;
        else errors.push(packError("student-class", "الطالب " + s.name + " ينتمي لفصل غير مذكور في الحزمة."));
      });
    }

    if (classes && classes.length) {
      Object.keys(classKeys).forEach(function (key) {
        if (classKeys[key].count === 0) {
          errors.push(packError("class-empty", "الفصل " + key.replace("|", " / ") + " لا يحتوي أي طالب."));
        }
      });
    }

    if (obj.schedule !== undefined) {
      if (!Array.isArray(obj.schedule)) errors.push(packError("schedule", "الجدول يجب أن يكون قائمة."));
      else {
        obj.schedule.forEach(function (l, i) {
          if (!l || typeof l !== "object") {
            errors.push(packError("review-day", "عنصر جدول غير صالح في السطر " + (i + 1) + "."));
            return;
          }
          var day = Number(l.day);
          if (!isFinite(day) || day < 0 || day > 6 || Math.floor(day) !== day) {
            errors.push(packError("review-day", "اليوم في الجدول يجب أن يكون من 0 إلى 6."));
          }
          var period = Number(l.period);
          if (!isFinite(period) || period < 1 || (periodsPerDay && period > periodsPerDay) || Math.floor(period) !== period) {
            errors.push(packError("period-range", "رقم الحصة خارج النطاق في السطر " + (i + 1) + "."));
          }
          var key = String(l.grade || "") + "|" + String(l.cls || "");
          if (!classKeys[key]) errors.push(packError("class-missing", "الجدول يشير إلى فصل غير مذكور في الحزمة."));
        });
      }
    }

    var expected = ATT.packChecksum(obj);
    if (!obj.checksum || String(obj.checksum) !== expected) {
      errors.push(packError("checksum", "checksum الحزمة غير مطابق — قد تكون تالفة أو معدّلة."));
    }

    return { ok: errors.length === 0, errors: errors };
  };

  /**
   * يبني حزمة معلم صالحة. opts:
   * { teacherId, teacherName, schoolName, classes, schedule, students, settings,
   *   rosterVersionId, packId, issuedAt }
   */
  ATT.buildPack = function (opts) {
    var o = opts || {};
    var settings = o.settings || {};
    var pack = {
      format: "ATT-TEACHER-PACK",
      formatVersion: 1,
      packId: o.packId || ATT.uid(),
      teacherId: String(o.teacherId || ""),
      teacherName: String(o.teacherName || ""),
      schoolName: String(o.schoolName || ""),
      issuedAt: o.issuedAt || new Date().toISOString(),
      rosterVersionId: String(o.rosterVersionId || ""),
      settings: {
        periodsPerDay: Number(settings.periodsPerDay) || 7,
        schoolDays: Array.isArray(settings.schoolDays)
          ? settings.schoolDays.map(Number)
          : ATT.defaultSchoolDays.slice(),
        bellTimes: Array.isArray(settings.bellTimes) ? settings.bellTimes.map(function (b) {
          return { period: Number(b.period) || 0, start: String(b.start || ""), end: String(b.end || "") };
        }) : [],
        centerWhatsapp: settings.centerWhatsapp ? String(settings.centerWhatsapp).trim() : "",
        includeNames: !!settings.includeNames
      },
      classes: (o.classes || []).map(function (c) {
        return { grade: String(c.grade || ""), cls: String(c.cls || "") };
      }),
      schedule: (o.schedule || []).map(function (l) {
        return {
          day: Number(l.day) || 0,
          period: Number(l.period) || 0,
          grade: String(l.grade || ""),
          cls: String(l.cls || ""),
          subject: String(l.subject || "")
        };
      }).sort(ATT.compareLessons),
      students: (o.students || []).map(function (s) {
        return {
          code: String(s.code || "").trim(),
          name: String(s.name || "").trim(),
          grade: String(s.grade || ""),
          cls: String(s.cls || "")
        };
      }),
      checksum: ""
    };
    pack.checksum = ATT.packChecksum(pack);
    return pack;
  };

  ATT.packFileName = function (pack) {
    var p = pack || {};
    return ATT.sanitizeFileName("PACK_" + (p.teacherName || p.teacherId || "teacher") + "_" + String(p.issuedAt || "").slice(0, 10)) + ".json";
  };

  /* ======================================================================
     7) الجدول الدراسي و«حصص اليوم»
     ====================================================================== */
  ATT.defaultSchoolDays = [0, 1, 2, 3, 4];

  ATT.compareLessons = function (a, b) {
    var d = (Number(a.day) || 0) - (Number(b.day) || 0);
    if (d) return d;
    var p = (Number(a.period) || 0) - (Number(b.period) || 0);
    if (p) return p;
    return ATT.collator.compare(String(a.grade || "") + String(a.cls || ""), String(b.grade || "") + String(b.cls || ""));
  };

  /** رقم اليوم 0=الأحد … 6=السبت لالتقاط محلي. */
  ATT.dayIndex = function (date) {
    var d = date instanceof Date ? date : (date ? new Date(date) : new Date());
    return d.getDay();
  };

  /**
   * حصص يوم معيّن مرتبة بالحصة. يوم غير دراسي (خارج schoolDays) يعيد [].
   */
  ATT.lessonsForDay = function (schedule, day, schoolDays) {
    var days = Array.isArray(schoolDays) ? schoolDays.map(Number) : ATT.defaultSchoolDays.slice();
    var d = Number(day);
    if (days.indexOf(d) < 0) return [];
    return (schedule || []).filter(function (l) { return Number(l.day) === d; }).sort(ATT.compareLessons);
  };

  ATT.DAY_NAMES = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

  /** يحوّل اسم اليوم (عربي/إنجليزي) أو رقمه 0–6 إلى رقم، أو null. */
  ATT.parseDay = function (v) {
    if (typeof v === "number" && isFinite(v)) {
      return Math.floor(v) === v && v >= 0 && v <= 6 ? v : null;
    }
    var raw = String(v == null ? "" : v).trim();
    if (!raw) return null;
    var num = Number(ATT.toLatinDigits(raw));
    if (isFinite(num) && Math.floor(num) === num && num >= 0 && num <= 6) return num;
    var n = ATT.normHeader(raw).replace(/^يوم/, "");
    var map = {
      "احد": 0, "الاحد": 0, "sunday": 0, "sun": 0,
      "اثنين": 1, "الاثنين": 1, "monday": 1, "mon": 1,
      "ثلاثاء": 2, "الثلاثاء": 2, "tuesday": 2, "tue": 2,
      "اربعاء": 3, "الاربعاء": 3, "wednesday": 3, "wed": 3,
      "خميس": 4, "الخميس": 4, "thursday": 4, "thu": 4,
      "جمعه": 5, "الجمعه": 5, "friday": 5, "fri": 5,
      "سبت": 6, "السبت": 6, "saturday": 6, "sat": 6
    };
    return Object.prototype.hasOwnProperty.call(map, n) ? map[n] : null;
  };

  /** يبحث عن معلم بالمعرّف أو بالاسم (مقارنة عربية مطبّعة). */
  ATT.findTeacher = function (teachers, key) {
    var k = String(key == null ? "" : key).trim();
    if (!k) return null;
    var list = teachers || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].id) === k) return list[i];
    }
    var nk = ATT.normHeader(k);
    for (var j = 0; j < list.length; j++) {
      if (list[j] && ATT.normHeader(list[j].name) === nk) return list[j];
    }
    return null;
  };

  ATT.SCHEDULE_FIELDS = {
    teacher: ["معلم", "teacher"],
    day: ["يوم", "day"],
    period: ["حصة", "period"],
    grade: ["صف", "grade", "مرحلة"],
    cls: ["فصل", "شعبة", "class", "section"],
    subject: ["مادة", "subject"]
  };

  ATT.mapScheduleHeader = function (row) {
    var map = {};
    (row || []).forEach(function (cell, i) {
      var h = ATT.normHeader(cell);
      if (!h) return;
      Object.keys(ATT.SCHEDULE_FIELDS).some(function (f) {
        if (map[f] !== undefined) return false;
        var hit = ATT.SCHEDULE_FIELDS[f].some(function (k) { return h.indexOf(ATT.normHeader(k)) >= 0; });
        if (hit) map[f] = i;
        return hit;
      });
    });
    return map;
  };

  /**
   * يدمج صفوف جدول من Excel/CSV في schedule (تعديل مباشر).
   * الأعمدة: المعلم، اليوم، الحصة، الصف، الفصل، المادة (أو نفس ترتيبها بلا عناوين).
   * teachers تبقى كما هي؛ الصفوف التي تشير لمعلم غير موجود أو فصل بلا طلاب تُتخطى.
   * يعيد { added, updated, skipped, notes, assumed }.
   */
  ATT.mergeScheduleRows = function (rows, teachers, schedule, classes, periodsPerDay) {
    var list = schedule || [];
    var classList = classes || [];
    var classKeys = {};
    classList.forEach(function (c) {
      if (c && c.grade && c.cls) classKeys[String(c.grade) + "|" + String(c.cls)] = true;
    });

    var map = null, start = 0;
    var limit = Math.min((rows || []).length, 10);
    for (var i = 0; i < limit; i++) {
      var m = ATT.mapScheduleHeader(rows[i]);
      if (m.teacher !== undefined && m.day !== undefined && m.period !== undefined &&
        m.grade !== undefined && m.cls !== undefined) {
        map = m; start = i + 1; break;
      }
    }
    var assumed = false;
    if (!map) {
      map = { teacher: 0, day: 1, period: 2, grade: 3, cls: 4, subject: 5 };
      assumed = true;
    }

    var res = { added: 0, updated: 0, skipped: 0, notes: [], assumed: assumed };
    var note = function (msg) { if (res.notes.length < 5) res.notes.push(msg); };
    var maxP = Number(periodsPerDay) || 0;

    for (var r = start; r < (rows || []).length; r++) {
      var line = rows[r];
      if (!line || line.every(function (c) { return String(c == null ? "" : c).trim() === ""; })) continue;
      var get = function (f) { return map[f] === undefined ? "" : String(line[map[f]] == null ? "" : line[map[f]]).trim(); };
      var teacher = ATT.findTeacher(teachers, get("teacher"));
      if (!teacher) {
        res.skipped++;
        note("سطر " + (r + 1) + ": معلم غير موجود (" + get("teacher") + ")");
        continue;
      }
      var day = ATT.parseDay(get("day"));
      if (day == null) {
        res.skipped++;
        note("سطر " + (r + 1) + ": يوم غير مفهوم (" + get("day") + ")");
        continue;
      }
      var period = Number(ATT.toLatinDigits(get("period")));
      if (!isFinite(period) || Math.floor(period) !== period || period < 1 || (maxP && period > maxP)) {
        res.skipped++;
        note("سطر " + (r + 1) + ": رقم حصة غير صالح (" + get("period") + ")");
        continue;
      }
      var grade = get("grade"), cls = get("cls");
      if (!grade || !cls || !classKeys[grade + "|" + cls]) {
        res.skipped++;
        note("سطر " + (r + 1) + ": فصل بلا طلاب (" + grade + " / " + cls + ")");
        continue;
      }
      var existing = null;
      for (var k = 0; k < list.length; k++) {
        var l = list[k];
        if (l && l.teacherId === teacher.id && Number(l.day) === day && Number(l.period) === period) { existing = l; break; }
      }
      if (existing) {
        if (existing.grade === grade && existing.cls === cls) {
          existing.subject = get("subject");
          res.updated++;
        } else {
          res.skipped++;
          note("سطر " + (r + 1) + ": تعارض مع حصة أخرى لنفس المعلم");
        }
        continue;
      }
      list.push({
        id: ATT.uid(), teacherId: teacher.id, day: day, period: period,
        grade: grade, cls: cls, subject: get("subject")
      });
      res.added++;
    }
    return res;
  };

  ATT.parseHHMM = function (s) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? "" : s).trim());
    if (!m) return null;
    var h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  };

  /** رقم الحصة الجارية حسب bellTimes ودقائق اليوم، أو null. */
  ATT.periodAt = function (bellTimes, minutes) {
    if (!Array.isArray(bellTimes) || typeof minutes !== "number") return null;
    for (var i = 0; i < bellTimes.length; i++) {
      var b = bellTimes[i] || {};
      var st = ATT.parseHHMM(b.start), en = ATT.parseHHMM(b.end);
      if (st == null || en == null) continue;
      if (minutes >= st && minutes < en) return Number(b.period) || null;
    }
    return null;
  };
  ATT.periodAtNow = function (bellTimes, now) {
    var d = now instanceof Date ? now : new Date();
    return ATT.periodAt(bellTimes, d.getHours() * 60 + d.getMinutes());
  };

  /* ======================================================================
     8) إعادة التصدير: fileId ثابت ما دام المحتوى ثابتًا
     ====================================================================== */
  ATT.contentHash = function (session, absentCodes) {
    var s = session || {};
    var codes = (absentCodes || []).map(function (c) { return String(c); });
    codes.sort();
    return ATT.simpleChecksum([
      s.status || "", Number(s.rosterCount) || 0, Number(s.presentCount) || 0, Number(s.absentCount) || 0
    ].join("|") + "|" + codes.join(","));
  };

  /**
   * يقرر معرّف التصدير التالي.
   * prev: { fileId, exportedAt, version, contentHash } | null
   * opts: { contentHash, now, newFileId }
   * → { fileId, exportedAt, version, contentHash, reused }
   */
  ATT.nextExport = function (prev, opts) {
    var o = opts || {};
    var version = prev && prev.version ? Number(prev.version) : 0;
    if (prev && prev.fileId && prev.contentHash && o.contentHash && prev.contentHash === o.contentHash) {
      return {
        fileId: prev.fileId, exportedAt: prev.exportedAt, version: version || 1,
        contentHash: o.contentHash, reused: true
      };
    }
    return {
      fileId: o.newFileId || ATT.fileIdGen(),
      exportedAt: o.now || new Date().toISOString(),
      version: version + 1,
      contentHash: o.contentHash || "",
      reused: false
    };
  };

  /* ======================================================================
     9) المخططات والترحيل
     ====================================================================== */
  ATT.defaultCenterSettings = function () {
    return {
      periodsPerDay: 7,
      schoolDays: ATT.defaultSchoolDays.slice(),
      bellTimes: [],
      dailyRule: "first_only",
      schoolName: "",
      centralPin: null,
      pinGuard: { fails: 0, blockedUntil: 0 },
      lockMinutes: 10,
      centerWhatsapp: "",
      includeNames: false
    };
  };

  ATT.defaultCenterDb = function () {
    return {
      schemaVersion: 3,
      students: [],
      teachers: [],
      schedule: [],
      rosterVersion: { id: ATT.uid(), updatedAt: new Date().toISOString() },
      central: { received: {}, importLog: [] },
      settings: ATT.defaultCenterSettings(),
      attendance: {},
      sessions: {}
    };
  };

  ATT.defaultTeacherSettings = function () {
    return {
      onboarded: false,
      periodsPerDay: 7,
      schoolDays: ATT.defaultSchoolDays.slice(),
      bellTimes: [],
      beepTone: "default",
      beepVol: "med",
      theme: "auto"
    };
  };

  ATT.defaultTeacherDb = function () {
    return {
      schemaVersion: 1,
      pack: { packId: "", teacherId: "", teacherName: "", schoolName: "", issuedAt: "", rosterVersionId: "" },
      settings: ATT.defaultTeacherSettings(),
      classes: [],
      schedule: [],
      students: [],
      sessions: {},
      activeSessionKey: null
    };
  };

  function objOr(v, fallback) { return v && typeof v === "object" && !Array.isArray(v) ? v : fallback; }
  function arrOr(v) { return Array.isArray(v) ? v : []; }

  /**
   * ترحيل بيانات المركز من v2 (attendance_app_v2) إلى v3.
   * لا يحذف أي بيانات: الطلاب والحضور والجلسات والسجل والنسخة الاحتياطية تُنقل كما هي.
   */
  ATT.migrateV2ToV3 = function (v2) {
    var src = objOr(v2, {});
    var base = ATT.defaultCenterDb();
    var settings = Object.assign({}, ATT.defaultCenterSettings(), objOr(src.settings, {}));
    if (!Array.isArray(settings.schoolDays)) settings.schoolDays = ATT.defaultSchoolDays.slice();
    if (!Array.isArray(settings.bellTimes)) settings.bellTimes = [];
    if (!Number(settings.periodsPerDay)) settings.periodsPerDay = 7;
    if (!Number(settings.lockMinutes)) settings.lockMinutes = 10;
    // لا يُنقل الـ PIN القديم (centralPinHash) لأنه لم يكن PBKDF2؛ يُطلب تعيين PIN جديد.
    delete settings.centralPinHash;
    if (!settings.centralPin || typeof settings.centralPin !== "object" ||
      !settings.centralPin.salt || !settings.centralPin.hash) {
      settings.centralPin = null;
    }
    var guard = settings.pinGuard;
    settings.pinGuard = {
      fails: guard && Number(guard.fails) > 0 ? Math.floor(Number(guard.fails)) : 0,
      blockedUntil: guard && Number(guard.blockedUntil) > 0 ? Number(guard.blockedUntil) : 0
    };

    var roster = objOr(src.rosterVersion, null);
    return {
      schemaVersion: 3,
      students: arrOr(src.students).filter(function (s) { return s && typeof s === "object"; }).map(function (s) { return Object.assign({}, s); }),
      teachers: arrOr(src.teachers).filter(function (t) { return t && typeof t === "object"; }).map(function (t) { return Object.assign({}, t); }),
      schedule: arrOr(src.schedule).filter(function (l) { return l && typeof l === "object"; }).map(function (l) { return Object.assign({}, l); }),
      rosterVersion: roster && roster.id ? Object.assign({}, roster) : base.rosterVersion,
      central: {
        received: objOr(src.central && src.central.received, {}),
        importLog: arrOr(src.central && src.central.importLog)
      },
      settings: settings,
      attendance: objOr(src.attendance, {}),
      sessions: objOr(src.sessions, {})
    };
  };

  /**
   * يقرأ بيانات النسخة القديمة من مفتاح attendance_app_v2 ويحوّلها إلى مخطط المركز v3.
   * لا يحذف المفتاح القديم ولا يعدّله، ويحفظ نسخة خام في attendance_app_v2_backup_migrated
   * إن لم تكن هناك نسخة احتياطية سابقة.
   * storage اختياري للاختبار، والافتراضي localStorage.
   * يعيد { status, db, backupSaved, backupExisting, sourceKey, backupKey, students, received, error }
   * status: none | migrated | invalid | unavailable
   */
  ATT.migrateLegacyCenter = function (storage) {
    var s = storage === undefined ? ATT.safeLocalStorage() : storage;
    var out = {
      status: "none", db: null, backupSaved: false, backupExisting: false,
      sourceKey: ATT.LEGACY_V2_KEY, backupKey: ATT.LEGACY_V2_BACKUP_KEY,
      students: 0, received: 0, error: null
    };
    if (!s) { out.status = "unavailable"; return out; }

    var raw = null;
    try { raw = s.getItem(ATT.LEGACY_V2_KEY); }
    catch (e) { out.status = "unavailable"; out.error = e; return out; }
    if (!raw) return out;

    var parsed = null;
    try { parsed = JSON.parse(raw); }
    catch (e) { out.status = "invalid"; out.error = e; return out; }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.students)) {
      out.status = "invalid";
      return out;
    }
    if (Number(parsed.schemaVersion) === 1) parsed = ATT.migrateV1ToV2(parsed);
    if (Number(parsed.schemaVersion) > 3) {
      out.status = "invalid";
      return out;
    }

    var backup = null;
    try { backup = s.getItem(ATT.LEGACY_V2_BACKUP_KEY); } catch (e) { backup = null; }
    out.backupExisting = !!backup;
    if (backup) out.backupSaved = true;
    else {
      try { s.setItem(ATT.LEGACY_V2_BACKUP_KEY, raw); out.backupSaved = true; }
      catch (e) { out.error = e; out.backupSaved = false; }
    }

    out.db = ATT.migrateV2ToV3(parsed);
    out.students = out.db.students.length;
    out.received = Object.keys(out.db.central.received || {}).length;
    out.status = "migrated";
    return out;
  };

  /** ترحيل v1 (attendance_app_v1) إلى v2 — منقول من الكود الحالي. */
  ATT.migrateV1ToV2 = function (v1) {
    var src = objOr(v1, {});
    var out = {
      schemaVersion: 2,
      students: arrOr(src.students),
      attendance: objOr(src.attendance, {}),
      rosterVersion: { id: ATT.uid(), updatedAt: new Date().toISOString() },
      sessions: {},
      central: { received: {}, importLog: [] },
      settings: {
        periodsPerDay: 7, requiredPeriods: [], dailyRule: "first_only",
        mode: "teacher", centralPinHash: "", teacherName: ""
      }
    };
    try {
      var att = objOr(src.attendance, {});
      Object.keys(att).forEach(function (date) {
        var rec = objOr(att[date], {});
        var groups = {};
        Object.keys(rec).forEach(function (code) {
          var st = ATT.findStudent(out.students, code);
          var g = st && st.grade ? st.grade : "";
          var c = st && st.cls ? st.cls : "";
          var keyg = g + "|" + c;
          if (!groups[keyg]) groups[keyg] = { grade: g, cls: c, present: {} };
          groups[keyg].present[st ? st.code : code] = rec[code];
        });
        Object.keys(groups).forEach(function (keyg) {
          var gg = groups[keyg];
          var presentCodes = Object.keys(gg.present);
          out.sessions[ATT.sessionKey(date, 1, gg.grade, gg.cls)] = {
            id: ATT.uid(),
            date: date, period: 1, grade: gg.grade, cls: gg.cls,
            teacher: "قديم", status: "closed", reason: "",
            rosterCount: out.students.filter(function (s) { return s.grade === gg.grade && s.cls === gg.cls; }).length,
            presentCount: presentCodes.length, absentCount: 0,
            present: gg.present, closedAt: new Date().toISOString(), exports: []
          };
        });
      });
    } catch (e) { /* يبقى ما نُقل قبل الخطأ */ }
    return out;
  };

  /* ======================================================================
     10) مخزن localStorage (مصنع واحد للتطبيقين)
     ====================================================================== */
  ATT.memoryStorage = function () {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; }
    };
  };

  ATT.safeLocalStorage = function () {
    try {
      var s = window.localStorage;
      var probe = "__att_probe__";
      s.setItem(probe, "1"); s.removeItem(probe);
      return s;
    } catch (e) { return null; }
  };

  /**
   * createStore({ key, defaults, migrate, storage })
   * get db / set db / load() / save() / isOk() / lastError
   */
  ATT.createStore = function (opts) {
    var o = opts || {};
    var key = o.key;
    var defaults = o.defaults || function () { return {}; };
    var migrate = o.migrate || null;
    var storage = o.storage !== undefined ? o.storage : ATT.safeLocalStorage();
    var state = { db: defaults(), ok: true, error: null, created: true };

    function load() {
      var raw = null;
      state.error = null;
      try { raw = storage ? storage.getItem(key) : null; } catch (e) { state.ok = false; state.error = e; }
      if (!raw) { state.db = defaults(); state.created = true; state.ok = !!storage; return state; }
      try {
        var parsed = JSON.parse(raw);
        state.db = migrate ? migrate(parsed) : parsed;
        state.created = false;
        state.ok = true;
      } catch (e) {
        state.db = defaults();
        state.ok = false;
        state.created = true;
        state.error = e;
      }
      return state;
    }

    function save() {
      try {
        if (!storage) throw new Error("storage unavailable");
        storage.setItem(key, JSON.stringify(state.db));
        state.ok = true; state.error = null;
      } catch (e) { state.ok = false; state.error = e; }
      return state.ok;
    }

    return {
      key: key,
      get db() { return state.db; },
      set db(v) { state.db = v; },
      get isOk() { return state.ok; },
      get lastError() { return state.error; },
      get isNew() { return state.created; },
      load: load,
      save: save,
      reset: function () { state.db = defaults(); state.created = true; return state.db; }
    };
  };

  /* ======================================================================
     11) تنزيل الملفات
     ====================================================================== */
  ATT.downloadBlob = function (name, blob) {
    var a = document.createElement("a");
    var href = URL.createObjectURL(blob);
    a.href = href; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
  };

  ATT.downloadText = function (name, text, mime) {
    ATT.downloadBlob(name, new Blob([text], { type: mime || "text/plain;charset=utf-8" }));
  };

  /* ======================================================================
     12) حوارات ورسائل (تحتاج عناصر الواجهة المشتركة)
     ====================================================================== */
  ATT.toast = function (msg) {
    var t = typeof document !== "undefined" ? document.getElementById("toast") : null;
    if (!t) return;
    t.innerHTML = "<div>" + ATT.esc(msg) + "</div>";
    clearTimeout(ATT.toast._timer);
    ATT.toast._timer = setTimeout(function () { t.innerHTML = ""; }, 3500);
  };

  ATT._dialogOpener = null;
  ATT.anyDialogOpen = function () { return !!document.querySelector("dialog[open]"); };
  ATT.rememberFocus = function () {
    if (ATT.anyDialogOpen()) return;
    var a = document.activeElement;
    ATT._dialogOpener = a && a !== document.body ? a : null;
  };
  ATT.restoreFocus = function () {
    if (ATT.anyDialogOpen()) return;
    var a = ATT._dialogOpener; ATT._dialogOpener = null;
    if (a && a.isConnected && !a.disabled && typeof a.focus === "function") {
      try { a.focus({ preventScroll: true }); } catch (e) { try { a.focus(); } catch (e2) { } }
    }
  };
  ATT.openDialog = function (d) {
    if (!d) return;
    ATT.rememberFocus();
    if (!d.open) d.showModal();
  };

  /** يربط استعادة التركيز لكل الحوارات في الصفحة (يُنفّذ مرة واحدة عند البدء). */
  ATT.wireDialogs = function () {
    document.querySelectorAll("dialog").forEach(function (d) {
      d.addEventListener("close", ATT.restoreFocus);
    });
  };

  ATT.askConfirm = function (title, text, okLabel) {
    return new Promise(function (res) {
      var d = document.getElementById("dlgConfirm");
      var yes = document.getElementById("cfYes"), no = document.getElementById("cfNo");
      if (!d || !yes || !no) { res(window.confirm(title + "\n" + text)); return; }
      document.getElementById("cfTitle").textContent = title;
      document.getElementById("cfText").textContent = text;
      yes.textContent = okLabel || "تأكيد";
      var settled = false;
      var cleanup = function () { yes.onclick = no.onclick = null; d.removeEventListener("cancel", onCancel); };
      var done = function (v) { if (settled) return; settled = true; cleanup(); if (d.open) d.close(); res(v); };
      function onCancel(e) { e.preventDefault(); done(false); }
      yes.onclick = function () { done(true); };
      no.onclick = function () { done(false); };
      d.addEventListener("cancel", onCancel);
      ATT.openDialog(d);
      no.focus();
    });
  };

  ATT.askInput = function (title, placeholder, okLabel, opts) {
    opts = opts || {};
    return new Promise(function (res) {
      var d = document.getElementById("dlgInput");
      if (!d) { res(window.prompt(title, opts.value || "")); return; }
      var form = document.getElementById("inpForm"), inp = document.getElementById("inpValue");
      var err = document.getElementById("inpErr"), cancel = document.getElementById("inpCancel");
      document.getElementById("inpTitle").textContent = title;
      document.getElementById("inpLabel").textContent = opts.label || "القيمة";
      inp.value = opts.value || ""; inp.placeholder = placeholder || "";
      inp.dir = opts.dir || "auto"; inp.type = opts.type || "text";
      err.textContent = ""; inp.removeAttribute("aria-invalid");
      document.getElementById("inpOk").textContent = okLabel || "تأكيد";
      var settled = false;
      var cleanup = function () {
        form.removeEventListener("submit", onSubmit);
        cancel.onclick = null; d.removeEventListener("cancel", onCancel);
      };
      var done = function (v) { if (settled) return; settled = true; cleanup(); if (d.open) d.close(); res(v); };
      function onSubmit(e) {
        e.preventDefault();
        var v = inp.value.trim();
        if (opts.required && !v) {
          err.textContent = "هذا الحقل مطلوب.";
          inp.setAttribute("aria-invalid", "true"); inp.focus(); return;
        }
        done(v);
      }
      function onCancel(e) { e.preventDefault(); done(null); }
      form.addEventListener("submit", onSubmit);
      cancel.onclick = function () { done(null); };
      d.addEventListener("cancel", onCancel);
      ATT.openDialog(d);
      inp.focus(); if (inp.value) inp.select();
    });
  };

  /* ======================================================================
     13) تحميل المكتبات المحلية (vendor/ فقط، بلا CDN)
     ====================================================================== */
  ATT.assetsRoot = "../vendor/";
  ATT.setAssetsRoot = function (p) { if (p) ATT.assetsRoot = String(p).replace(/\/*$/, "/"); };

  var LIBS = {
    zxing: { global: "ZXing", file: "zxing.min.js" },
    xlsx: { global: "XLSX", file: "xlsx.full.min.js" },
    jszip: { global: "JSZip", file: "jszip.min.js" }
  };
  var libP = {};

  ATT.libUrl = function (name) {
    var L = LIBS[name];
    return L ? ATT.assetsRoot + L.file : "";
  };
  ATT.hasLib = function (name) {
    var L = LIBS[name];
    return !!(L && typeof window !== "undefined" && window[L.global]);
  };

  function loadScript(url) {
    return new Promise(function (res) {
      var s = document.createElement("script");
      s.src = url; s.async = true;
      var t = setTimeout(function () { s.remove(); res(false); }, 20000);
      s.onload = function () { clearTimeout(t); res(true); };
      s.onerror = function () { clearTimeout(t); s.remove(); res(false); };
      document.head.appendChild(s);
    });
  }

  /** يحمّل مكتبة محلية مرة واحدة. يعيد Promise<boolean>. */
  ATT.loadLib = function (name) {
    if (ATT.hasLib(name)) return Promise.resolve(true);
    if (!LIBS[name]) return Promise.resolve(false);
    if (libP[name]) return libP[name];
    libP[name] = loadScript(ATT.libUrl(name)).then(function (ok) {
      if (ok && ATT.hasLib(name)) return true;
      libP[name] = null;
      return false;
    });
    return libP[name];
  };

  ATT.libIsLocal = function (name) {
    var u = ATT.libUrl(name);
    return !!u && !/^(https?:)?\/\//i.test(u);
  };

  /**
   * يبني رسالة واتساب للغياب. يُرجع مصفوفة نصوص:
   * عنصر واحد عادةً، وأكثر من عنصر إذا تجاوز النص حد الرابط (1500 بعد الترميز).
   * كل الأجزاء تحمل نفس المرجع، ويُرقَّم رأس كل جزء (1/2).
   * opts: { unable, includeNames, rosterCount, presentCount, fileId, fileVersion }
   */
  ATT.buildAbsenceMessage = function (session, absentList, opts) {
    opts = opts || {};
    var s = session || {};
    var date = s.date || "";
    var period = s.period || "";
    var grade = s.grade || "";
    var cls = s.cls || "";
    var teacher = s.teacher || "";
    var absent = Array.isArray(absentList) ? absentList : [];
    var unable = !!opts.unable;
    var includeNames = !!opts.includeNames;
    var fileId = opts.fileId ? String(opts.fileId) : "";
    var fileVersion = Number(opts.fileVersion) || 1;
    var ref = (fileId ? fileId.slice(0, 8) : "") + "-v" + fileVersion;

    var roster = opts.rosterCount != null
      ? Math.max(0, Number(opts.rosterCount) || 0)
      : Math.max(0, (Number(opts.presentCount) || 0) + absent.length);
    var present = opts.presentCount != null
      ? Math.max(0, Number(opts.presentCount) || 0)
      : Math.max(0, roster - absent.length);

    var entries = absent.map(function (a) {
      var code = String((a && a.code) != null ? a.code : "");
      var name = includeNames && a && a.name ? " " + String(a.name) : "";
      return code + name;
    });

    function partText(chunk, index, total) {
      var head = "غياب | " + date + " | الحصة " + period + " | " + grade + " | " + cls + " | " + teacher;
      if (total > 1) head += " (" + (index + 1) + "/" + total + ")";
      var lines = [head];
      if (unable) {
        lines.push("تعذر التحضير");
      } else {
        lines.push("حضر " + present + " من " + roster + " | غائب " + absent.length);
        lines.push("الغائبون: " + (chunk.length ? chunk.join(" - ") : "لا يوجد"));
      }
      lines.push("مرجع: " + ref);
      return lines.join("\n");
    }

    var LIMIT = 1500;
    var encodedLen = function (str) { return encodeURIComponent(str).length; };
    // علامة الجزء أثناء القياس أطول من الفعلي دائمًا (999999)، فلا يتجاوز الناتج الحد.
    var PLACEHOLDER_TOTAL = 999999;

    function fitEntry(entry) {
      var e = entry;
      while (e.length > 1 && encodedLen(partText([e], 0, PLACEHOLDER_TOTAL)) > LIMIT) {
        e = e.slice(0, -1);
      }
      return e;
    }

    if (unable) return [partText([], 0, 1)];

    var chunks = [];
    var cur = [];
    entries.forEach(function (entry) {
      var trial = cur.concat([entry]);
      if (encodedLen(partText(trial, 0, PLACEHOLDER_TOTAL)) <= LIMIT) {
        cur = trial;
        return;
      }
      if (cur.length) {
        chunks.push(cur);
        cur = [];
      }
      if (encodedLen(partText([entry], 0, PLACEHOLDER_TOTAL)) <= LIMIT) {
        cur = [entry];
      } else {
        chunks.push([fitEntry(entry)]);
      }
    });
    if (cur.length) chunks.push(cur);
    if (!chunks.length) chunks = [[]];

    var total = chunks.length;
    return chunks.map(function (ch, i) { return partText(ch, i, total); });
  };

  ATT.toLatinDigits = function (s) {
    return String(s == null ? "" : s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 1632); })
      .replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 1776); });
  };

  /** ينظّف سطرًا من محادثة واتساب: علامات الاتجاه، المسافات غير القياسية، الأرقام العربية. */
  function cleanWaLine(line) {
    return ATT.toLatinDigits(line)
      .replace(/[\u00A0\u2007\u202F]/g, " ")
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  /** يحوّل تاريخًا بصيغة d/m/y أو y-m-d إلى YYYY-MM-DD إن أمكن. */
  function normalizeWaDate(v) {
    var s = String(v == null ? "" : v).trim();
    var m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
    if (m) {
      return m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2);
    }
    m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})$/);
    if (m) {
      var y = Number(m[3]);
      if (y < 100) y += 2000;
      return y + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
    }
    return s;
  }

  /**
   * يحلّل محادثة واتساب ملصوقة ويستخرج رسائل الغياب.
   * يتحمّل بادئات واتساب العربية/الإنجليزية بصيغة 12/24 ساعة، والأرقام العربية.
   * كل نتيجة: { date, period, grade, cls, teacher, status, absentCodes, ref,
   *             fileId8, fileVersion, partIndex, partTotal,
   *             presentCount, rosterCount, absentCount, complete }
   */
  ATT.parseAbsenceMessages = function (text) {
    if (!text) return [];
    var raw = String(text);
    if (raw.length > 500 * 1024) raw = raw.slice(0, 500 * 1024);
    var lines = raw.split(/\r?\n/);
    var blocks = [];
    var cur = null;

    lines.forEach(function (line) {
      var clean = cleanWaLine(line);
      if (!clean) return;
      var headerLine = clean;
      // إزالة بادئة واتساب: "[10:30 م, 30/10/2026] أحمد:" أو "10:30 - أحمد:" أو "أحمد:".
      var gi = clean.indexOf("غياب");
      if (gi > 0) {
        var prefix = clean.slice(0, gi);
        if (prefix.length <= 90 && /[:：]\s*$/.test(prefix)) headerLine = clean.slice(gi);
      }
      if (/^\s*غياب\s*[|¦]/.test(headerLine)) {
        if (cur) blocks.push(cur);
        cur = [headerLine];
      } else if (cur) {
        cur.push(clean);
      }
    });
    if (cur) blocks.push(cur);

    var results = [];
    blocks.forEach(function (blk) {
      var header = blk[0];
      var partIndex = 1, partTotal = 1;
      var pm = header.match(/\(\s*(\d+)\s*\/\s*(\d+)\s*\)\s*$/);
      if (pm) {
        partIndex = Number(pm[1]);
        partTotal = Number(pm[2]);
        header = header.slice(0, pm.index).trim();
      }
      var parts = header.split("|").map(function (x) { return x.trim(); });
      if (parts.length < 6) return;
      var periodM = parts[2].match(/(\d+)/);
      var unable = blk.some(function (l) { return l === "تعذر التحضير"; });
      var absentLine = "";
      var refLine = "";
      var countLine = "";
      blk.forEach(function (l) {
        if (!absentLine && l.indexOf("الغائبون:") >= 0) absentLine = l;
        if (!refLine && l.indexOf("مرجع:") >= 0) refLine = l;
        if (!countLine && /حضر\s*\d+\s*من\s*\d+/.test(l)) countLine = l;
      });

      var absentCodes = [];
      if (!unable && absentLine) {
        var am = absentLine.slice(absentLine.indexOf("الغائبون:") + "الغائبون:".length).trim();
        if (am && !/^لا\s*يوجد$/.test(am)) {
          var pieces = am.indexOf(" - ") >= 0 ? am.split(/\s+-\s+/) : am.split(/\s*[،,]\s*/);
          pieces.forEach(function (piece) {
            var code = piece.trim().split(/\s+/)[0];
            if (code && absentCodes.indexOf(code) < 0) absentCodes.push(code);
          });
        }
      }

      var ref = refLine ? refLine.slice(refLine.indexOf("مرجع:") + "مرجع:".length).trim() : "";
      var refM = ref.match(/^(.*)-v(\d+)$/);
      var fileId8 = refM ? refM[1] : "";
      var fileVersion = refM ? Number(refM[2]) : 0;

      var presentCount = null, rosterCount = null, absentCount = null;
      var cm = countLine.match(/حضر\s*(\d+)\s*من\s*(\d+)\s*[|¦]?\s*غائب\s*(\d+)/);
      if (cm) {
        presentCount = Number(cm[1]);
        rosterCount = Number(cm[2]);
        absentCount = Number(cm[3]);
      }

      results.push({
        date: normalizeWaDate(parts[1]),
        period: periodM ? Number(periodM[1]) : null,
        grade: parts[3],
        cls: parts[4],
        teacher: parts[5],
        status: unable ? "unable" : "present",
        absentCodes: absentCodes,
        ref: ref,
        fileId8: fileId8,
        fileVersion: fileVersion,
        partIndex: partIndex,
        partTotal: partTotal,
        presentCount: presentCount,
        rosterCount: rosterCount,
        absentCount: absentCount,
        complete: unable || !!absentLine
      });
    });
    return results;
  };

  ATT.pickRearCamera = function (devices) {
    devices = devices || [];
    var frontRe = /front|أمامية|user/i;
    var rearRe = /back|rear|environment|خلفية/i;
    var badRe = /ultra|wide|tele/i;
    var rear = devices.filter(function (d) { return rearRe.test(d.label || "") && !badRe.test(d.label || ""); });
    if (rear.length) return rear[0].deviceId || "";
    rear = devices.filter(function (d) { return rearRe.test(d.label || ""); });
    if (rear.length) return rear[0].deviceId || "";
    var nonFront = devices.filter(function (d) { return !frontRe.test(d.label || ""); });
    if (nonFront.length && nonFront.length < devices.length) return nonFront[0].deviceId || "";
    if (devices.length) return devices[0].deviceId || "";
    return "";
  };

  ATT.normalizeWhatsapp = function (v) {
    v = String(v == null ? "" : v).trim();
    v = v.replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 1632); });
    v = v.replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 1776); });
    return v.replace(/[^0-9]/g, "");
  };
  ATT.isValidWhatsapp = function (v) {
    var n = ATT.normalizeWhatsapp(v);
    return n === "" || (/^[0-9]{10,15}$/.test(n));
  };

  /* ======================================================================
     مسح الباركود — ROI + قواعد قبول
     ====================================================================== */
  ATT.SCAN_MIN_ROI_WIDTH = 640;
  ATT.SCAN_CENTER_TOLERANCE = 0.35;
  ATT.SCAN_CONFIRM_WINDOW_MS = 600;

  ATT.computeScanRoi = function (videoW, videoH, elemW, elemH, guideRect, objectFit) {
    objectFit = objectFit || "cover";
    var scale = (objectFit === "cover")
      ? Math.max(elemW / videoW, elemH / videoH)
      : Math.min(elemW / videoW, elemH / videoH);
    var renderedW = videoW * scale;
    var renderedH = videoH * scale;
    var offsetX = (renderedW - elemW) / 2;
    var offsetY = (renderedH - elemH) / 2;
    // guideRect is relative to the element (video viewport). Convert to video coords.
    var gx = guideRect.x + offsetX;
    var gy = guideRect.y + offsetY;
    var gw = guideRect.w;
    var gh = guideRect.h;
    var x = gx / scale;
    var y = gy / scale;
    var w = gw / scale;
    var h = gh / scale;
    // clamp
    if (x < 0) { w += x; x = 0; }
    if (y < 0) { h += y; y = 0; }
    if (x + w > videoW) w = videoW - x;
    if (y + h > videoH) h = videoH - y;
    if (w < 0) w = 0;
    if (h < 0) h = 0;
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  };

  ATT.pickScanResult = function (results, roiW, roiH, state) {
    state = state || {};
    if (!results || !results.length) return { action: "none" };
    // distinct codes
    var codes = [];
    results.forEach(function (r) { if (codes.indexOf(r.text) === -1) codes.push(r.text); });
    if (codes.length > 1) {
      return { action: "reject", reason: "ambiguous", message: "يوجد أكثر من باركود في المربع، قرّب باركودًا واحدًا فقط" };
    }
    var r = results[0];
    // center check
    if (r.cornerPoints || r.boundingBox) {
      var cx, cy;
      if (r.cornerPoints && r.cornerPoints.length) {
        cx = r.cornerPoints.reduce(function (a, p) { return a + p.x; }, 0) / r.cornerPoints.length;
        cy = r.cornerPoints.reduce(function (a, p) { return a + p.y; }, 0) / r.cornerPoints.length;
      } else {
        cx = r.boundingBox.x + r.boundingBox.width / 2;
        cy = r.boundingBox.y + r.boundingBox.height / 2;
      }
      // normalize to roi dims (results coords are within roi image already? assume normalized 0..roiW)
      var dx = Math.abs(cx - roiW / 2) / roiW;
      var dy = Math.abs(cy - roiH / 2) / roiH;
      if (dx > ATT.SCAN_CENTER_TOLERANCE || dy > ATT.SCAN_CENTER_TOLERANCE) {
        return { action: "reject", reason: "offcenter", message: "قرّب الباركود إلى مركز المربع" };
      }
    }
    // two-frame confirmation
    var now = Date.now();
    if (state.pendingCode === r.text && state.pendingAt && (now - state.pendingAt) <= ATT.SCAN_CONFIRM_WINDOW_MS) {
      return { action: "accept", code: r.text };
    }
    state.pendingCode = r.text;
    state.pendingAt = now;
    return { action: "pending", code: r.text };
  };

  return ATT;
});
