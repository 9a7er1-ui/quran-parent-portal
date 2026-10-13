// ============================================================
// إعدادات لا بد من تعبئتها قبل الاستخدام (من لوحة تحكم Supabase):
// ============================================================
const SUPABASE_URL = 'https://bobjfngkrepajfsmaihk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_tlHAjfYiVXXq81ponT7E-g_fniIquBM';
const TEACHER_EMAIL = '9a7er1@gmail.com';            // لتعبئة حقل الدخول تلقائيًا فقط؛ الصلاحية الفعلية مرتبطة بـ UID في schema.sql
const PARENT_PORTAL_URL = 'https://9a7er1-ui.github.io/quran-parent-portal/student.html';
const LINK_CODE_VALID_HOURS = 72; // مدة صلاحية رمز الربط قبل أن ينتهي// ============================================================

let supa = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('تعذّر تحميل ' + src));
    document.head.appendChild(s);
  });
}
async function ensureLibs() {
  if (!window.supabase) await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
  if (!supa) supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
function isSupabaseConfigured() {
  return !/^ضع_/.test(SUPABASE_URL) && !/^ضع_/.test(SUPABASE_ANON_KEY) && !/^ضع_/.test(TEACHER_EMAIL);
}
function isParentPortalConfigured() { return !/^ضع_/.test(PARENT_PORTAL_URL); }

// ---------- تجميع الطلاب اعتمادًا على studentUid الحقيقي المشترك بين مواده الثلاث ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function uniqueStudents() {
  const app = window.__app, seen = new Map();
  for (const s of app.db.students) {
    if (!s.studentUid) continue; // احتياطًا فقط؛ الترحيل التلقائي في index.html يمنع هذه الحالة عمليًا
    if (!seen.has(s.studentUid)) {
      seen.set(s.studentUid, { key: s.studentUid, name: app.cleanName(s.name), section: s.section || app.db.sections[0] });
    }
  }
  return [...seen.values()].sort((a, b) => a.section.localeCompare(b.section, 'ar') || a.name.localeCompare(b.name, 'ar'));
}

// ---------- بناء تقرير طالب واحد لعرضه لولي الأمر ----------
function buildReport(studentUid, name, section, t) {
  const app=window.__app;
  if(app?.buildAllSemesterStudentReport) return app.buildAllSemesterStudentReport(studentUid);
  return {generatedAt:new Date().toISOString(),name,section,semesters:[]};
}

// ---------- نشر تقارير الطلاب إلى بوابة ولي الأمر ----------
async function syncReports(root,students) {
  const status=root.querySelector('#paBulkStatus');
  const sem=Number(root.querySelector('#paSem')?.value||0);
  status.textContent='جارٍ تجهيز تقارير الطلاب...';
  let done=0;
  for(const st of students){
    const report=buildReport(st.key,st.name,st.section,sem);
    const portalEnabled=window.__app?.db?.studentSupport?.[st.key]?.portalEnabled!==false;
    const {error}=await supa.from('students_public').upsert({
      id:st.key,
      full_name:st.name,
      report:report,
      portal_enabled:portalEnabled
    },{onConflict:'id'});
    if(error){
      status.textContent=`توقفت المزامنة عند ${st.name}: ${error.message}`;
      return;
    }
    done++;
    status.textContent=`جارٍ المزامنة... ${done} من ${students.length}`;
  }
  status.textContent=`تمت مزامنة تقارير ${done} طالب بنجاح.`;
}

// ---------- واجهة المعلم داخل تبويبين مستقلين ----------
async function loginBox(root, returnTab) {
  root.innerHTML = `<p class="muted">سجّل دخول حساب المعلم.</p>
    <input id="paEmail" placeholder="البريد الإلكتروني" value="${TEACHER_EMAIL}">
    <input id="paPass" type="password" placeholder="كلمة المرور">
    <button id="paLogin" type="button">تسجيل الدخول</button><span id="paLoginStatus" class="muted"></span>`;
  root.querySelector('#paLogin').onclick = async () => {
    const status=root.querySelector('#paLoginStatus'); status.textContent='جارٍ تسجيل الدخول...';
    const {error}=await supa.auth.signInWithPassword({email:root.querySelector('#paEmail').value.trim(),password:root.querySelector('#paPass').value});
    if(error){status.textContent='خطأ: '+error.message;return;} await renderCloudTab(returnTab);
  };
}

// ============================================================
// النقل الكامل الآمن بين الأجهزة — الإصدار 2
// ------------------------------------------------------------
// المبادئ:
// • يُنقل كائن قاعدة البيانات كاملًا بكل حقوله كما هو (لا دمج، لا اختيار حقول).
// • يُكتب إلى صف جديد مستقل في Supabase (full-v2)، ولا يُقرأ الصف القديم main إلا للنسخ الاحتياطي.
// • كل نقل يسبقه: محاكاة لا تكتب شيئًا ← نسخة احتياطية ← كتابة ← قراءة عكسية ومقارنة شاملة لكل حقل وقيمة.
// • حذف اختبارات الدراسات الإسلامية القديمة يحدث مرة واحدة فقط في أول نقل، وتُسجَّل علامة دائمة داخل البيانات
//   (db.syncMarks.islamicTestsReset) حتى لا يتكرر الحذف أبدًا على الدرجات الجديدة.
// • يُمنع أي جهاز لا يحمل هذه العلامة من الرفع بعد وجود النسخة الكاملة في السحابة (يمنع عودة الاختبارات القديمة).
// ============================================================
const APP_STORAGE_KEY = 'quran-offline-v1';
const FULL_ROW_ID = 'full-v2';
const FULL_FORMAT = 'quran-gradebook-full-v2';
const FS_BASE_KEY = 'quran-fullsync-base-v2';      // بصمة آخر نسخة تطابق فيها هذا الجهاز مع السحابة
const FS_PENDING_KEY = 'quran-fullsync-pending-v2'; // تحقق ينتظر إعادة التحميل
const FS_IDB_NAME = 'quran-fullsync-v2';
const FS_UI_FIELDS = ['activeSection', 'activeSubject', 'view', 'lastBackupAt']; // تُنقل، لكنها لا تُعدّ «تعديلًا على البيانات»
const FS_LS_WARN_CHARS = 2000000;

const fsSim = { up: null, down: null, restore: null, conflict: null };

function loadJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } }
function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (_) { return false; } }
function fsClone(x) { return JSON.parse(JSON.stringify(x)); }
function fsType(x) { return x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x; }
function fsOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

// تسلسل ثابت الترتيب (مفاتيح مرتبة) حتى لا تتأثر البصمة بإعادة ترتيب Supabase للمفاتيح
function fsCanon(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return '[' + x.map(v => (v === undefined ? 'null' : fsCanon(v))).join(',') + ']';
  return '{' + Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => JSON.stringify(k) + ':' + fsCanon(x[k])).join(',') + '}';
}
function fsCyrb(str, seed) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) { ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
function fsFp(obj) { const s = fsCanon(obj); return fsCyrb(s, 1) + fsCyrb(s, 7) + '-' + s.length; }
function fsContentFp(db) { const c = fsClone(db); for (const f of FS_UI_FIELDS) delete c[f]; return fsFp(c); }

// مقارنة شاملة: كل حقل وكل قيمة في كل مستوى، وليس عدد السجلات فقط
function fsDeepDiff(a, b, limit = 200) {
  const out = { count: 0, paths: [] };
  const add = (p, kind) => { out.count++; if (out.paths.length < limit) out.paths.push(kind + ': ' + (p || '(الجذر)')); };
  const walk = (x, y, p) => {
    if (x === y) return;
    const tx = fsType(x), ty = fsType(y);
    if (tx !== ty) { add(p, 'نوع مختلف'); return; }
    if (tx === 'array') {
      if (x.length !== y.length) add(p, 'طول مختلف ' + x.length + '≠' + y.length);
      for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], p + '[' + i + ']');
      return;
    }
    if (tx === 'object') {
      for (const k of Object.keys(x)) { if (!fsOwn(y, k)) add(p + '.' + k, 'مفقود'); else walk(x[k], y[k], p + '.' + k); }
      for (const k of Object.keys(y)) if (!fsOwn(x, k)) add(p + '.' + k, 'زائد');
      return;
    }
    if (tx === 'number' && Number.isNaN(x) && Number.isNaN(y)) return;
    add(p, 'قيمة مختلفة');
  };
  walk(a, b, '');
  return out;
}

// نسخة مطابقة لدالة valid() في index.html؛ إن فشلت عند فتح التطبيق فسيبدأ ببيانات فارغة، لذلك نمنع الكتابة مسبقًا.
function fsValidDb(x) {
  return !!(x && x.version === 1 && Array.isArray(x.students) && x.students.every(s => typeof s.id === 'string' && typeof s.name === 'string') &&
    x.grades && typeof x.grades === 'object' && x.absences && typeof x.absences === 'object' && x.tests && typeof x.tests === 'object' &&
    x.actual && x.view && [0, 1].includes(x.actual.t) && [0, 1].includes(x.actual.p) && Number.isInteger(x.actual.w) && x.actual.w >= 0 && x.actual.w <= 6 &&
    Number.isInteger(x.actual.d) && x.actual.d >= 0 && x.actual.d <= 4 && [0, 1].includes(x.view.t) && [0, 1].includes(x.view.p) &&
    Number.isInteger(x.view.w) && x.view.w >= 0 && x.view.w <= 6);
}

// مفتاح درجة اختبار دراسات إسلامية: islamic|t|p|studentId|tests|i (أو نجمته star|islamic|...|tests|i)
function fsIsIslamicTestKey(k) {
  let p = String(k).split('|');
  if (p[0] === 'star') p = p.slice(1);
  return p[0] === 'islamic' && p[4] === 'tests';
}
function fsIslamicTestCount(db) { return Object.keys(db?.coursework || {}).filter(fsIsIslamicTestKey).length; }
function fsCourseBreakdown(cw) {
  const m = {};
  for (const k of Object.keys(cw || {})) {
    let p = k.split('|'), star = false;
    if (p[0] === 'star') { star = true; p = p.slice(1); }
    const label = (p[0] || '?') + '|' + (p[4] || '?') + (star ? '|star' : '');
    m[label] = (m[label] || 0) + 1;
  }
  return m;
}
function fsBreakdownLabel(label) {
  const [subj, cat, star] = label.split('|');
  const app = window.__app || {};
  const sName = (app.subjectNames && app.subjectNames[subj]) || subj;
  const def = (app.courseDefs && app.courseDefs[subj] || []).find(d => d.id === cat);
  return sName + ' — ' + (def ? def.name : cat) + (star ? ' (نجوم)' : '');
}
const FS_FIELD_LABELS = {
  version: 'إصدار البيانات', students: 'سجلات الطلاب', grades: 'درجات القرآن', absences: 'الغياب', tests: 'اختبارات القرآن',
  holidays: 'الإجازات', approvals: 'الاعتمادات', actual: 'الموعد الفعلي', view: 'الكشف المعروض', max: 'الدرجة العظمى',
  sections: 'الشعب', activeSection: 'الشعبة النشطة', activeSubject: 'المادة النشطة', coursework: 'درجات المواد',
  quranShare: 'نصيب القرآن', auditLog: 'سجل التعديلات', archives: 'الأرشيف', lastBackupAt: 'آخر نسخة احتياطية',
  studentSupport: 'متابعة الطلاب', syncMarks: 'علامات المزامنة', weeklyNotices: 'سجل الرسائل الأسبوعية', violationNotices: 'سجل إشعارات المخالفات', courseNotices: 'سجل رسائل المشاركات والواجبات', quranPlan: 'توزيع مقرر القرآن'
};
function fsSize(v) { const t = fsType(v); return t === 'array' ? v.length : t === 'object' ? Object.keys(v).length : t === 'undefined' ? '—' : 'قيمة'; }

// ---------- قراءة بيانات هذا الجهاز والتأكد من أن المحفوظ = المعروض ----------
function fsReadStoredDb() {
  const raw = localStorage.getItem(APP_STORAGE_KEY);
  if (!raw) return null;
  return JSON.parse(raw);
}
function fsSourceDb() {
  const stored = fsReadStoredDb();
  if (!stored) throw new Error('لا توجد بيانات محفوظة على هذا الجهاز.');
  const mem = fsClone(window.__app.db);
  const d = fsDeepDiff(stored, mem, 10);
  return { stored, memMatches: d.count === 0, memDiff: d };
}

// ---------- بناء حزمة النقل ----------
function fsBuildPayload(src, nowIso) {
  const payload = fsClone(src);
  const firstTransfer = !(src.syncMarks && src.syncMarks.islamicTestsReset);
  const removed = [];
  if (firstTransfer) {
    for (const k of Object.keys(payload.coursework || {})) if (fsIsIslamicTestKey(k)) { removed.push(k); delete payload.coursework[k]; }
    payload.syncMarks = Object.assign({}, payload.syncMarks || {}, { islamicTestsReset: { at: nowIso, removed: removed.length } });
    const uidFn = () => (crypto.randomUUID ? crypto.randomUUID() : 'uid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));
    payload.auditLog = [{ id: uidFn(), at: nowIso, type: 'sync-reset', text: 'النقل الكامل الآمن: حُذفت درجات اختبارات الدراسات الإسلامية القديمة (' + removed.length + ' خانة) مرة واحدة، وبقيت بقية البيانات كما هي.', studentUid: '' }, ...(Array.isArray(payload.auditLog) ? payload.auditLog : [])];
  }
  return { payload, firstTransfer, removed };
}

// ---------- فحوص السلامة للحزمة قبل أي كتابة ----------
function fsVerifyPayload(src, plan, check) {
  const { payload, firstTransfer, removed } = plan;
  check(fsValidDb(src), 'بنية بيانات هذا الجهاز صالحة');
  check(Array.isArray(src.students) && src.students.length > 0, 'بيانات هذا الجهاز غير فارغة', (src.students || []).length + ' سجل طالب');
  check(fsValidDb(payload), 'بنية حزمة النقل صالحة ويقبلها التطبيق عند الفتح');
  const missingTop = Object.keys(src).filter(k => !fsOwn(payload, k));
  check(missingTop.length === 0, 'جميع حقول قاعدة البيانات العليا موجودة في الحزمة', missingTop.length ? 'مفقود: ' + missingTop.join('، ') : Object.keys(src).length + ' حقلًا');

  // المقارنة الشاملة: نبني «النتيجة المتوقعة» من بيانات الجهاز ونطابقها مع الحزمة قيمةً بقيمة
  const expected = fsClone(src);
  if (firstTransfer) {
    for (const k of removed) delete expected.coursework[k];
    expected.syncMarks = fsClone(payload.syncMarks);
    expected.auditLog = [fsClone(payload.auditLog[0]), ...(Array.isArray(src.auditLog) ? src.auditLog : [])];
  }
  const d = fsDeepDiff(expected, payload);
  check(d.count === 0, 'مقارنة شاملة لكل الحقول والقيم: لا فرق سوى المسموح به', d.count ? d.count + ' فرق غير متوقع' : (firstTransfer ? 'الفرق الوحيد: ' + removed.length + ' خانة اختبار إسلامية + علامة الإصلاح + قيد في سجل التعديلات' : 'مطابقة تامة'), d.paths);
  check(removed.every(fsIsIslamicTestKey), 'كل ما حُذف هو اختبارات دراسات إسلامية فقط', removed.length + ' خانة');
  if (firstTransfer) check(fsIslamicTestCount(payload) === 0, 'عمودا اختبارَي الدراسات الإسلامية فارغان في الحزمة');

  const bs = fsCourseBreakdown(src.coursework), bp = fsCourseBreakdown(payload.coursework);
  const changedCats = [...new Set([...Object.keys(bs), ...Object.keys(bp)])].filter(l => {
    if ((bs[l] || 0) === (bp[l] || 0)) return false;
    const [subj, cat] = l.split('|');
    return !(firstTransfer && subj === 'islamic' && cat === 'tests');
  });
  check(changedCats.length === 0, 'بقية خانات المواد (المشاركة والواجبات والتفاعل والتجويد والمهارات...) لم تتغير', changedCats.length ? changedCats.map(fsBreakdownLabel).join('، ') : '');
  for (const f of ['students', 'grades', 'absences', 'tests', 'approvals', 'holidays', 'studentSupport', 'sections', 'archives', 'actual', 'view', 'quranShare', 'max'])
    if (fsOwn(src, f)) check(fsDeepDiff(src[f], payload[f], 1).count === 0, 'مطابقة تامة: ' + (FS_FIELD_LABELS[f] || f), fsSize(src[f]) + '');

  const rt = JSON.parse(JSON.stringify(payload));
  check(fsDeepDiff(payload, rt, 5).count === 0, 'التحويل إلى JSON والعودة دون فقد أي قيمة');
  check(fsValidDb(rt) && fsFp(rt) === fsFp(payload), 'محاكاة الاستقبال: الحزمة بعد فكّها صالحة وبصمتها مطابقة');
  const size = JSON.stringify(payload).length;
  check(true, 'حجم البيانات', Math.round(size / 1024) + ' ك.ب' + (size > FS_LS_WARN_CHARS ? ' — كبير نسبيًا على الآيباد' : ''));
  return { expectedDiff: d, breakdownBefore: bs, breakdownAfter: bp, size };
}

// ---------- Supabase (قراءة) ----------
async function fsFetchRow(id, cols = '*') {
  const { data, error } = await supa.from('gradebook_state').select(cols).eq('id', id).maybeSingle();
  if (error) throw new Error('تعذّرت قراءة السحابة: ' + error.message);
  return data || null;
}

// ---------- النسخ الاحتياطي (ملف يُنزَّل + نسخة داخل المتصفح IndexedDB) ----------
function fsDownload(obj, prefix) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = prefix + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function fsIdbOpen() {
  return new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('IndexedDB غير متاح'));
    const r = indexedDB.open(FS_IDB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function fsIdb(mode, fn) {
  const d = await fsIdbOpen();
  return new Promise((res, rej) => {
    const tx = d.transaction('items', mode), st = tx.objectStore('items'); let out;
    const req = fn(st); if (req) req.onsuccess = () => { out = req.result; };
    tx.oncomplete = () => { d.close(); res(out); };
    tx.onerror = tx.onabort = () => { d.close(); rej(tx.error || new Error('فشل IndexedDB')); };
  });
}
const fsIdbPut = item => fsIdb('readwrite', st => st.put(item));
const fsIdbGet = id => fsIdb('readonly', st => st.get(id));
const fsIdbAll = () => fsIdb('readonly', st => st.getAll());
const fsIdbDel = id => fsIdb('readwrite', st => st.delete(id));
async function fsListBackups() {
  try { return ((await fsIdbAll()) || []).filter(x => x.kind === 'backup').sort((a, b) => b.at.localeCompare(a.at)); } catch (_) { return []; }
}
async function fsMakeBackup(reason, cloudRows, opts) {
  const silent = !!(opts && opts.silent);
  const localDb = fsReadStoredDb();
  if (!localDb) throw new Error('لا توجد بيانات محلية لنسخها.');
  const at = new Date().toISOString(), id = 'backup-' + Date.now();
  const item = { id, kind: 'backup', at, reason, fp: fsFp(localDb), localDb, cloudRows: cloudRows || null };
  if (!silent) fsDownload({ exportKind: 'quran_full_backup_v2', reason, at, localDb, cloudRows: cloudRows || null }, 'نسخة-احتياطية-قبل-' + reason);
  let idbOk = false;
  try {
    await fsIdbPut(item);
    const back = await fsIdbGet(id);
    idbOk = !!back && fsFp(back.localDb) === item.fp;
    const all = await fsListBackups();
    for (const old of all.slice(8)) await fsIdbDel(old.id);
  } catch (_) { idbOk = false; }
  if (!idbOk && silent) throw new Error('تعذّر حفظ النسخة الاحتياطية داخل المتصفح؛ لم يتغير شيء.');
  if (!idbOk && !confirm('تعذّر حفظ النسخة الاحتياطية داخل المتصفح. هل ظهر ملف النسخة الاحتياطية في التنزيلات وتأكدت من وجوده؟\n(اضغط «إلغاء» لإيقاف العملية دون أي تغيير)'))
    throw new Error('أُوقفت العملية لعدم التأكد من النسخة الاحتياطية. لم يتغير شيء.');
  return { id, idbOk };
}

// ---------- استبدال بيانات هذا الجهاز ثم التحقق بعد إعادة التحميل ----------
async function fsReplaceLocal(newDb, kind, backupId) {
  if (!fsValidDb(newDb)) throw new Error('البيانات الجديدة لا يقبلها التطبيق؛ أُلغي الاستبدال.');
  const prevRaw = localStorage.getItem(APP_STORAGE_KEY);
  const expectedFp = fsFp(newDb), contentFp = fsContentFp(newDb);
  try { await fsIdbPut({ id: 'expected-pending', kind: 'expected', at: new Date().toISOString(), data: newDb }); } catch (_) {}
  try {
    localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(newDb));
    const back = fsReadStoredDb();
    const d = fsDeepDiff(newDb, back, 5);
    if (d.count || !fsValidDb(back)) throw new Error('القراءة العكسية من ذاكرة الجهاز غير مطابقة (' + d.count + ' فرق).');
  } catch (err) {
    try { if (prevRaw !== null) localStorage.setItem(APP_STORAGE_KEY, prevRaw); } catch (_) {}
    throw new Error('تعذّر حفظ البيانات على هذا الجهاز، وأُعيدت البيانات السابقة كما كانت: ' + err.message);
  }
  saveJSON(FS_PENDING_KEY, { kind, expectedFp, contentFp, backupId: backupId || null, at: new Date().toISOString() });
  const cover = document.createElement('div');
  cover.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,.94);z-index:99999;display:flex;align-items:center;justify-content:center;font:20px Tahoma;color:#205348';
  cover.textContent = 'جارٍ إعادة تحميل التطبيق للتحقق النهائي...';
  document.body.appendChild(cover);
  setTimeout(() => location.reload(), 400);
}

function fsBanner(html, ok) {
  const old = document.getElementById('fsBanner'); if (old) old.remove();
  const b = document.createElement('div'); b.id = 'fsBanner';
  b.style.cssText = 'margin:10px 0;padding:12px 14px;border-radius:10px;border:2px solid ' + (ok ? '#2e7d4f;background:#e9f6ee' : '#b42318;background:#fdecea') + ';color:#193d34';
  b.innerHTML = html;
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'إخفاء'; close.onclick = () => b.remove();
  b.appendChild(close);
  const header = document.querySelector('header');
  if (header && header.parentNode) header.parentNode.insertBefore(b, header.nextSibling); else document.body.prepend(b);
  return b;
}

async function fsPostReloadCheck() {
  const pend = loadJSON(FS_PENDING_KEY, null);
  if (!pend) return;
  let stored = null, memOk = false;
  try { stored = fsReadStoredDb(); memOk = fsDeepDiff(stored, fsClone(window.__app.db), 1).count === 0; } catch (_) {}
  const fpNow = stored ? fsFp(stored) : '';
  const kindText = { upload: 'الرفع الأول من هذا الجهاز', receive: 'الاستقبال من السحابة', restore: 'استعادة النسخة الاحتياطية', 'auto-receive': 'استقبال تلقائي لآخر نسخة من السحابة', 'restore-cloud': 'استعادة نسخة من سجل السحابة' }[pend.kind] || pend.kind;
  if (stored && memOk && fpNow === pend.expectedFp) {
    if (pend.kind !== 'restore') { saveJSON(FS_BASE_KEY, { contentFp: pend.contentFp, fp: pend.expectedFp, at: new Date().toISOString(), kind: pend.kind }); fsSaveBaseContent(stored); }
    localStorage.removeItem(FS_PENDING_KEY);
    try { await fsIdbDel('expected-pending'); } catch (_) {}
    const okb = fsBanner('<b>✓ نجح التحقق النهائي بعد إعادة التحميل (' + escapeHtml(kindText) + ').</b><br>بيانات التطبيق الآن مطابقة حقلًا بحقل وقيمةً بقيمة للنسخة المعتمدة. (' + (stored.students || []).length + ' سجل طالب)', true);
    if (pend.kind === 'auto-receive') setTimeout(() => okb.remove(), 9000);
    return;
  }
  let detail = '';
  try {
    const exp = await fsIdbGet('expected-pending');
    if (exp && stored) { const d = fsDeepDiff(exp.data, stored, 15); detail = '<br>عدد الفروق: ' + d.count + '<br><small>' + d.paths.map(escapeHtml).join('<br>') + '</small>'; }
  } catch (_) {}
  const b = fsBanner('<b>✗ التحقق النهائي بعد إعادة التحميل لم يتطابق (' + escapeHtml(kindText) + ').</b><br>لا تُدخل درجات الآن. يمكنك استعادة النسخة الاحتياطية التي أُخذت قبل العملية.' + detail + '<br>', false);
  if (pend.backupId) {
    const r = document.createElement('button'); r.type = 'button'; r.textContent = 'استعادة النسخة الاحتياطية السابقة';
    r.onclick = () => fsRestoreBackup(pend.backupId, null);
    b.insertBefore(r, b.lastChild);
  }
}

async function fsRestoreBackup(id, status) {
  try {
    const item = await fsIdbGet(id);
    if (!item || !item.localDb) throw new Error('لم تُعثر على النسخة الاحتياطية.');
    if (!confirm('ستُستبدل بيانات هذا الجهاز بالنسخة الاحتياطية المؤرخة ' + new Date(item.at).toLocaleString('ar-SA') + ' (' + (item.localDb.students || []).length + ' سجل طالب). لن تتغير السحابة. متابعة؟')) return;
    localStorage.removeItem(FS_PENDING_KEY);
    const bk = await fsMakeBackup('الاستعادة', null);
    await fsReplaceLocal(item.localDb, 'restore', bk.id);
  } catch (e) { if (status) status.textContent = 'تعذّرت الاستعادة: ' + e.message; else alert('تعذّرت الاستعادة: ' + e.message); }
}

// ---------- عرض التقرير ----------
function fsRenderReport(summary, title, checks, fieldRows, breakdown) {
  summary.replaceChildren();
  const h = document.createElement('b'); h.textContent = title; summary.appendChild(h);
  const ul = document.createElement('ul'); ul.style.cssText = 'list-style:none;padding:0;margin:8px 0';
  for (const c of checks) {
    const li = document.createElement('li'); li.style.cssText = 'margin:4px 0;color:' + (c.ok ? '#1f6b3f' : '#b42318');
    li.textContent = (c.ok ? '✓ ' : '✗ ') + c.label + (c.detail ? ' — ' + c.detail : '');
    if (!c.ok && c.paths && c.paths.length) { const s = document.createElement('div'); s.style.cssText = 'font-size:12px;direction:ltr;text-align:left'; s.textContent = c.paths.slice(0, 15).join('\n'); s.style.whiteSpace = 'pre-wrap'; li.appendChild(s); }
    ul.appendChild(li);
  }
  summary.appendChild(ul);
  const mk = (head, rows) => {
    const t = document.createElement('table'); t.style.cssText = 'width:100%;min-width:560px;margin:8px 0';
    t.innerHTML = '<thead><tr>' + head.map(x => '<th>' + escapeHtml(x) + '</th>').join('') + '</tr></thead><tbody></tbody>';
    for (const r of rows) { const tr = document.createElement('tr'); for (const v of r) { const td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td); } t.tBodies[0].appendChild(tr); }
    summary.appendChild(t);
  };
  if (fieldRows) mk(fieldRows.head, fieldRows.rows);
  if (breakdown) mk(breakdown.head, breakdown.rows);
}
function fsFieldRows(a, b, headA, headB, allowedNote) {
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])];
  const rows = keys.map(k => {
    const same = fsDeepDiff(a?.[k], b?.[k], 1).count === 0;
    return [FS_FIELD_LABELS[k] || k, fsSize(a?.[k]), fsSize(b?.[k]), same ? 'متطابق' : (allowedNote && allowedNote[k]) || 'مختلف'];
  });
  return { head: ['الحقل', headA, headB, 'النتيجة'], rows };
}
function fsBreakdownRows(a, b, headA, headB) {
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
  return { head: ['خانات المواد', headA, headB], rows: keys.map(k => [fsBreakdownLabel(k), a[k] || 0, b[k] || 0]) };
}
function fsReportForDownload(title, checks) {
  return { kind: 'quran_fullsync_check_report_no_names', title, at: new Date().toISOString(), checks: checks.map(c => ({ ok: c.ok, label: c.label, detail: c.detail || '' })) };
}

// ---------- فحص حالة السحابة قبل الرفع ----------
function fsUploadGuard(src, cloudMeta) {
  const hasMark = !!(src.syncMarks && src.syncMarks.islamicTestsReset);
  const base = loadJSON(FS_BASE_KEY, null);
  if (!hasMark) {
    if (!cloudMeta) return { ok: true, text: 'السحابة لا تحتوي نسخة كاملة بعد؛ سيكون هذا هو النقل الأول من هذا الجهاز.' };
    if (cloudMeta.sourceFp && cloudMeta.sourceFp === fsFp(src)) return { ok: true, text: 'إعادة محاولة للنقل الأول نفسه من هذا الجهاز.' };
    return { ok: false, text: 'توجد نسخة كاملة معتمدة في السحابة، وهذا الجهاز لم يستقبلها بعد (بياناته أقدم وقد تحتوي اختبارات الإسلامية القديمة). استقبل من السحابة بدل الرفع.' };
  }
  if (!cloudMeta) return { ok: true, text: 'لا توجد نسخة كاملة في السحابة؛ سيُرفع هذا الجهاز كنسخة أولى.' };
  const localContent = fsContentFp(src);
  if (cloudMeta.contentFp === localContent) return { ok: true, same: true, text: 'السحابة مطابقة لهذا الجهاز بالفعل.' };
  if (base && base.contentFp === cloudMeta.contentFp) return { ok: true, text: 'السحابة لم تتغير منذ آخر مزامنة لهذا الجهاز؛ الرفع آمن.' };
  return { ok: false, text: 'السحابة تغيّرت من جهاز آخر منذ آخر مزامنة لهذا الجهاز. لمنع ضياع أي درجات أُوقف الرفع؛ استقبل أولًا ثم أعد إدخال ما يلزم، أو راجعني.' };
}

// ---------- ١) محاكاة الرفع ----------
async function fsSimulateUpload(ui) {
  fsSim.up = null; ui.upBtn.disabled = true;
  const checks = [], check = (ok, label, detail, paths) => { checks.push({ ok: !!ok, label, detail, paths }); return ok; };
  ui.status.textContent = 'جارٍ المحاكاة... لا يُكتب أي شيء.';
  try {
    const { stored: src, memMatches, memDiff } = fsSourceDb();
    check(memMatches, 'البيانات المحفوظة مطابقة لما يعرضه التطبيق الآن', memMatches ? '' : 'أعد تحميل الصفحة ثم أعد المحاكاة', memDiff.paths);
    const plan = fsBuildPayload(src, new Date().toISOString());
    const res = fsVerifyPayload(src, plan, check);
    let cloudMeta = null, guard = null;
    try {
      const row = await fsFetchRow(FULL_ROW_ID, 'id,meta,updated_at');
      cloudMeta = row ? row.meta : null;
      guard = fsUploadGuard(src, cloudMeta);
      check(guard.ok, 'حالة السحابة تسمح بالرفع دون دمج أو فقد', guard.text);
    } catch (e) { check(false, 'قراءة حالة السحابة', e.message); }
    const allOk = checks.every(c => c.ok);
    const note = plan.firstTransfer ? { coursework: 'متوقع: حذف اختبارات الإسلامية فقط', auditLog: 'متوقع: قيد واحد جديد', syncMarks: 'متوقع: علامة الإصلاح' } : null;
    fsRenderReport(ui.summary, (allOk ? '✓ نجحت جميع فحوص المحاكاة' : '✗ فشل فحص واحد أو أكثر؛ الرفع يبقى معطّلًا') + (plan.firstTransfer ? ' — وضع النقل الأول' : ' — وضع الرفع العادي'),
      checks, fsFieldRows(src, plan.payload, 'هذا الجهاز الآن', 'ما سيُرفع', note), fsBreakdownRows(res.breakdownBefore, res.breakdownAfter, 'الآن', 'بعد النقل'));
    const dl = document.createElement('button'); dl.type = 'button'; dl.textContent = 'تنزيل تقرير الفحص (دون أسماء أو درجات)';
    dl.onclick = () => fsDownload(fsReportForDownload('محاكاة الرفع', checks), 'تقرير-محاكاة-الرفع'); ui.summary.appendChild(dl);
    if (allOk && !(guard && guard.same)) { fsSim.up = { srcFp: fsFp(src), firstTransfer: plan.firstTransfer, at: Date.now() }; ui.upBtn.disabled = false; }
    ui.status.textContent = allOk ? (guard && guard.same ? 'المحاكاة ناجحة، والسحابة مطابقة لهذا الجهاز؛ لا حاجة للرفع.' : 'نجحت المحاكاة دون أي كتابة. زر الرفع الحقيقي أصبح متاحًا.') : 'لم يُكتب شيء. الرفع معطّل حتى تنجح جميع الفحوص.';
  } catch (e) { ui.status.textContent = 'تعذّرت المحاكاة: ' + e.message + ' (لم يُكتب شيء)'; }
}


// رفع حزمة إلى السحابة ثم قراءتها عكسيًا ومقارنتها كاملة؛ عند أي اختلاف تُعاد السحابة لحالتها السابقة
async function fsPushPayload(payload, meta, prevFull, say) {
  const fp = meta.fp;
  say && say('حفظ النسخة السابقة في سجل النسخ...');
  try { await fsSnapshotCloud(prevFull, 'قبل الرفع', false); } catch (e) { console.warn(e); }
  say && say('جارٍ الرفع...');
  const { error } = await supa.from('gradebook_state').upsert({ id: FULL_ROW_ID, db: payload, meta, updated_at: new Date().toISOString() });
  if (error) throw new Error('رفضت السحابة الرفع: ' + error.message + ' (لم يتغير شيء على هذا الجهاز)');
  say && say('التحقق: قراءة النسخة من السحابة ومقارنتها كاملة...');
  const back = await fsFetchRow(FULL_ROW_ID);
  const d = back ? fsDeepDiff(payload, back.db) : { count: -1, paths: [] };
  if (!back || d.count !== 0 || fsFp(back.db) !== fp || back.meta?.fp !== fp) {
    try { if (prevFull) await supa.from('gradebook_state').upsert(prevFull); else await supa.from('gradebook_state').delete().eq('id', FULL_ROW_ID); } catch (_) {}
    throw new Error('النسخة المقروءة من السحابة لا تطابق ما رُفع (' + d.count + ' فرق)؛ أُعيدت السحابة لحالتها السابقة ولم يتغير هذا الجهاز.');
  }
}
function fsMakeMeta(payload, src, plan) {
  return { format: FULL_FORMAT, fp: fsFp(payload), contentFp: fsContentFp(payload), sourceFp: fsFp(src), firstTransfer: plan.firstTransfer,
    removedIslamicTests: plan.removed.length, islamicTests: fsIslamicTestCount(payload), students: payload.students.length,
    uploadedAt: new Date().toISOString(), device: (navigator.userAgent || '').slice(0, 140), deviceKind: fsThisDeviceKind() };
}
function fsThisDeviceKind() {
  const ua = navigator.userAgent || '';
  return (/iPad|iPhone/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) ? 'ipad' : 'laptop';
}

// ---------- ٢) الرفع الحقيقي ----------
async function fsUpload(ui) {
  if (!fsSim.up) { ui.status.textContent = 'شغّل المحاكاة أولًا.'; return; }
  ui.upBtn.disabled = true;
  const checks = [], check = (ok, label, detail, paths) => { checks.push({ ok: !!ok, label, detail, paths }); return ok; };
  try {
    const { stored: src, memMatches } = fsSourceDb();
    if (!memMatches || fsFp(src) !== fsSim.up.srcFp) throw new Error('تغيّرت البيانات بعد المحاكاة؛ أعد المحاكاة أولًا.');
    ui.status.textContent = 'قراءة السحابة للنسخ الاحتياطي...';
    const prevFull = await fsFetchRow(FULL_ROW_ID);
    let prevMain = null; try { prevMain = await fsFetchRow('main'); } catch (_) {}
    const guard = fsUploadGuard(src, prevFull ? prevFull.meta : null);
    if (!guard.ok) throw new Error(guard.text);
    const plan = fsBuildPayload(src, new Date().toISOString());
    fsVerifyPayload(src, plan, check);
    if (!checks.every(c => c.ok)) throw new Error('فشل فحص سلامة أثناء التحضير: ' + checks.filter(c => !c.ok).map(c => c.label).join('، '));
    const msg = plan.firstTransfer
      ? 'النقل الأول: سيُرفع ' + src.students.length + ' سجل طالب وجميع الحقول كما هي، مع حذف ' + plan.removed.length + ' خانة من اختبارات الدراسات الإسلامية القديمة فقط (من السحابة ومن هذا الجهاز).\nستُنزَّل نسخة احتياطية أولًا. متابعة؟'
      : 'سيُرفع ' + src.students.length + ' سجل طالب وجميع الحقول كما هي دون أي دمج. ستُنزَّل نسخة احتياطية أولًا. متابعة؟';
    if (!confirm(msg)) { ui.status.textContent = 'أُلغي الرفع. لم يتغير شيء.'; ui.upBtn.disabled = false; return; }
    ui.status.textContent = 'إنشاء النسخة الاحتياطية...';
    const bk = await fsMakeBackup('الرفع', { full: prevFull, main: prevMain });
    const payload = plan.payload, fp = fsFp(payload);
    const meta = fsMakeMeta(payload, src, plan);
    await fsPushPayload(payload, meta, prevFull, t => { ui.status.textContent = t; });
    if (plan.firstTransfer) {
      ui.status.textContent = 'تطابقت السحابة تمامًا. جارٍ تطبيق حذف اختبارات الإسلامية على هذا الجهاز...';
      await fsReplaceLocal(payload, 'upload', bk.id);
      return;
    }
    saveJSON(FS_BASE_KEY, { contentFp: meta.contentFp, fp, at: new Date().toISOString(), kind: 'upload' }); fsSaveBaseContent(payload);
    fsSim.up = null;
    ui.status.textContent = '✓ تم الرفع، وتطابقت نسخة السحابة مع هذا الجهاز حقلًا بحقل وقيمةً بقيمة.';
  } catch (e) { ui.status.textContent = 'توقف الرفع: ' + e.message; fsSim.up = null; }
}

// ---------- ١) محاكاة الاستقبال ----------
function fsVerifyCloudRow(row, check) {
  if (!check(!!row && !!row.db, 'وُجدت نسخة كاملة في السحابة')) return false;
  const m = row.meta || {};
  check(m.format === FULL_FORMAT, 'صيغة النسخة هي صيغة النقل الكامل', m.format || 'غير معروفة');
  check(fsFp(row.db) === m.fp, 'بصمة البيانات سليمة (لم تتغير أو تنقص في الطريق)');
  check(fsValidDb(row.db), 'بنية البيانات صالحة ويقبلها التطبيق عند الفتح');
  check(Array.isArray(row.db.students) && row.db.students.length > 0 && row.db.students.length === m.students, 'عدد سجلات الطلاب مطابق لما سُجّل عند الرفع', (row.db.students || []).length + '');
  check(!!(row.db.syncMarks && row.db.syncMarks.islamicTestsReset), 'تحمل علامة حذف اختبارات الإسلامية القديمة');
  check(fsIslamicTestCount(row.db) === m.islamicTests && (!m.firstTransfer || m.islamicTests === 0), 'لا توجد اختبارات إسلامية قديمة مستعادة', fsIslamicTestCount(row.db) + ' خانة');
  const rt = JSON.parse(JSON.stringify(row.db));
  check(fsDeepDiff(row.db, rt, 5).count === 0, 'محاكاة الحفظ على الجهاز دون فقد أي قيمة');
  const size = JSON.stringify(row.db).length;
  check(true, 'حجم البيانات', Math.round(size / 1024) + ' ك.ب' + (size > FS_LS_WARN_CHARS ? ' — كبير نسبيًا' : ''));
  return true;
}
function fsReceiveGuard(local, row) {
  const base = loadJSON(FS_BASE_KEY, null);
  if (!local) return { ok: true, text: 'لا توجد بيانات محلية على هذا الجهاز.' };
  const lc = fsContentFp(local);
  if (row.meta.contentFp === lc) return { ok: true, same: true, text: 'هذا الجهاز مطابق للسحابة بالفعل.' };
  if (!base) return { ok: true, warnReplace: true, text: 'هذا الجهاز لم يزامن بالنظام الجديد من قبل؛ ستُستبدل بياناته القديمة كاملةً بالنسخة المعتمدة (بعد نسخة احتياطية).' };
  if (base.contentFp === lc) return { ok: true, text: 'لا توجد تعديلات محلية غير مرفوعة؛ الاستقبال آمن.' };
  return { ok: true, localChanges: true, text: 'تنبيه: يوجد على هذا الجهاز تعديلات بعد آخر مزامنة لم تُرفع. الاستقبال سيستبدلها (تبقى في النسخة الاحتياطية).' };
}
async function fsSimulateReceive(ui) {
  fsSim.down = null; ui.downBtn.disabled = true;
  const checks = [], check = (ok, label, detail, paths) => { checks.push({ ok: !!ok, label, detail, paths }); return ok; };
  ui.status.textContent = 'جارٍ محاكاة الاستقبال... لا يُكتب أي شيء.';
  try {
    const row = await fsFetchRow(FULL_ROW_ID);
    fsVerifyCloudRow(row, check);
    let local = null; try { local = fsReadStoredDb(); } catch (_) {}
    let guard = null;
    if (row && row.db) { guard = fsReceiveGuard(local, row); check(guard.ok, 'حالة هذا الجهاز', guard.text); }
    const allOk = checks.every(c => c.ok);
    fsRenderReport(ui.summary, allOk ? '✓ نجحت جميع فحوص محاكاة الاستقبال' : '✗ فشل فحص؛ الاستقبال يبقى معطّلًا', checks,
      row && row.db ? fsFieldRows(local || {}, row.db, 'هذا الجهاز الآن', 'بعد الاستقبال') : null,
      row && row.db ? fsBreakdownRows(fsCourseBreakdown(local?.coursework), fsCourseBreakdown(row.db.coursework), 'الآن', 'بعد الاستقبال') : null);
    const dl = document.createElement('button'); dl.type = 'button'; dl.textContent = 'تنزيل تقرير الفحص (دون أسماء أو درجات)';
    dl.onclick = () => fsDownload(fsReportForDownload('محاكاة الاستقبال', checks), 'تقرير-محاكاة-الاستقبال'); ui.summary.appendChild(dl);
    if (allOk && !(guard && guard.same)) { fsSim.down = { fp: row.meta.fp, guard, at: Date.now() }; ui.downBtn.disabled = false; }
    ui.status.textContent = allOk ? (guard && guard.same ? 'هذا الجهاز مطابق للسحابة؛ لا حاجة للاستقبال.' : 'نجحت المحاكاة دون أي كتابة. زر الاستقبال الحقيقي أصبح متاحًا.') : 'لم يُكتب شيء.';
    if (allOk && guard && guard.same && !loadJSON(FS_BASE_KEY, null)) { saveJSON(FS_BASE_KEY, { contentFp: row.meta.contentFp, fp: row.meta.fp, at: new Date().toISOString(), kind: 'match' }); fsSaveBaseContent(local); }
  } catch (e) { ui.status.textContent = 'تعذّرت المحاكاة: ' + e.message + ' (لم يُكتب شيء)'; }
}

// ---------- ٢) الاستقبال الحقيقي ----------
async function fsReceive(ui) {
  if (!fsSim.down) { ui.status.textContent = 'شغّل محاكاة الاستقبال أولًا.'; return; }
  ui.downBtn.disabled = true;
  try {
    const row = await fsFetchRow(FULL_ROW_ID);
    if (!row || row.meta?.fp !== fsSim.down.fp) throw new Error('تغيّرت نسخة السحابة بعد المحاكاة؛ أعد المحاكاة.');
    const checks = [], check = (ok, label) => { checks.push({ ok: !!ok, label }); return ok; };
    fsVerifyCloudRow(row, check);
    if (!checks.every(c => c.ok)) throw new Error('فشل فحص سلامة: ' + checks.filter(c => !c.ok).map(c => c.label).join('، '));
    let local = null; try { local = fsReadStoredDb(); } catch (_) {}
    const guard = fsReceiveGuard(local, row);
    if (guard.localChanges) {
      const typed = prompt(guard.text + '\nللمتابعة اكتب كلمة: استبدال');
      if ((typed || '').trim() !== 'استبدال') { ui.status.textContent = 'أُلغي الاستقبال. لم يتغير شيء.'; ui.downBtn.disabled = false; return; }
    } else if (!confirm('سيُستبدل كل ما على هذا الجهاز بالنسخة المعتمدة من السحابة (' + row.db.students.length + ' سجل طالب، بجميع الحقول). ستُنزَّل نسخة احتياطية أولًا. متابعة؟')) {
      ui.status.textContent = 'أُلغي الاستقبال. لم يتغير شيء.'; ui.downBtn.disabled = false; return;
    }
    ui.status.textContent = 'إنشاء النسخة الاحتياطية...';
    const bk = local ? await fsMakeBackup('الاستقبال', null) : { id: null };
    ui.status.textContent = 'جارٍ الحفظ على هذا الجهاز...';
    await fsReplaceLocal(row.db, 'receive', bk.id);
  } catch (e) { ui.status.textContent = 'توقف الاستقبال: ' + e.message; fsSim.down = null; }
}

async function fsExportCloud(status) {
  status.textContent = 'جارٍ قراءة السحابة وتنزيلها دون تغيير...';
  try {
    const full = await fsFetchRow(FULL_ROW_ID); let main = null; try { main = await fsFetchRow('main'); } catch (_) {}
    if (!full && !main) { status.textContent = 'لا توجد بيانات في السحابة.'; return; }
    fsDownload({ exportKind: 'gradebook_cloud_readonly_backup_v2', exportedAt: new Date().toISOString(), full, main }, 'نسخة-السحابة');
    status.textContent = 'نُزّلت نسخة السحابة. لم يتغير شيء.';
  } catch (e) { status.textContent = 'تعذّر التنزيل: ' + e.message; }
}

function fsDeviceStateText() {
  let local = null; try { local = fsReadStoredDb(); } catch (_) {}
  const base = loadJSON(FS_BASE_KEY, null), pend = loadJSON(FS_PENDING_KEY, null);
  const parts = [];
  parts.push(local ? (local.students || []).length + ' سجل طالب محفوظ على هذا الجهاز' : 'لا توجد بيانات على هذا الجهاز');
  parts.push(local && local.syncMarks && local.syncMarks.islamicTestsReset ? 'تم حذف اختبارات الإسلامية القديمة' : 'لم يُطبَّق حذف اختبارات الإسلامية القديمة بعد');
  parts.push(base ? 'آخر مزامنة ناجحة: ' + new Date(base.at).toLocaleString('ar-SA') : 'لم يزامن بالنظام الجديد بعد');
  if (base && local) parts.push(fsContentFp(local) === base.contentFp ? 'لا تعديلات غير مرفوعة' : 'يوجد تعديلات بعد آخر مزامنة');
  if (pend) parts.push('يوجد تحقق معلّق بعد إعادة التحميل');
  return parts.join(' • ');
}

async function renderSyncTab(root) {
  fsSim.up = null; fsSim.down = null; fsSim.restore = null;
  root.innerHTML = `<div class="summary-card"><b>النقل الكامل الآمن بين الأجهزة</b>
    <p class="muted">ينقل قاعدة البيانات كاملة بكل حقولها دون أي دمج مع بيانات السحابة القديمة. لا يتفعّل أي زر حقيقي قبل نجاح المحاكاة، وتُنزَّل نسخة احتياطية قبل كل استبدال. أغلق أي نافذة أخرى مفتوحة للتطبيق على هذا الجهاز قبل البدء.</p>
    <p id="fsState" class="muted"></p>
    <div class="summary-card"><label><input type="checkbox" id="fsAutoToggle"> <b>المزامنة التلقائية على هذا الجهاز</b></label>
      <p class="muted">عند فتح التطبيق يستقبل آخر نسخة تلقائيًا، وبعد كل رصد يرفع تلقائيًا خلال ثوانٍ. لا يدمج ولا يحذف شيئًا: إن وُجدت تعديلات على جهازين معًا يتوقف وينبّهك. الأزرار اليدوية أدناه للحالات الخاصة فقط.</p></div>
    <div class="summary-card"><b>عند ظهور «تعارض»</b>
      <p class="muted">اعرض الفروق أولًا (لا يكتب شيئًا)، ثم اعتمد نسخة واحدة كاملة. النسخة الأخرى لا تضيع: نسخة السحابة تُحفظ في «سجل النسخ»، ونسخة هذا الجهاز تُحفظ في «النسخ الاحتياطية».</p>
      <button id="fsDiffBtn" type="button">عرض الفروق بين هذا الجهاز والسحابة (لا يكتب شيئًا)</button>
      <div id="fsConflictActions" style="display:none;margin-top:8px"><button id="fsKeepLocal" type="button">اعتماد نسخة هذا الجهاز ورفعها</button> <button id="fsKeepCloud" type="button">اعتماد نسخة السحابة على هذا الجهاز</button></div></div>
    <div class="summary-card"><b>رفع بيانات هذا الجهاز إلى السحابة</b><br>
      <button id="fsSimUp" type="button">١. محاكاة الرفع والتحقق (لا يكتب شيئًا)</button>
      <button id="fsUp" type="button" disabled>٢. الرفع الحقيقي (يتفعّل بعد نجاح المحاكاة)</button></div>
    <div class="summary-card"><b>استقبال آخر نسخة من السحابة إلى هذا الجهاز</b><br>
      <button id="fsSimDown" type="button">١. محاكاة الاستقبال والتحقق (لا يكتب شيئًا)</button>
      <button id="fsDown" type="button" disabled>٢. الاستقبال الحقيقي (يتفعّل بعد نجاح المحاكاة)</button></div>
    <details><summary>أدوات النسخ الاحتياطي</summary>
      <button id="fsBackupNow" type="button">تنزيل نسخة احتياطية كاملة من هذا الجهاز</button>
      <button id="fsExportCloud" type="button">تنزيل نسخة من السحابة (قراءة فقط)</button>
      <div id="fsBackups"></div></details>
    <details id="fsHistDetails"><summary>سجل النسخ في السحابة (للرجوع إلى نسخة سابقة)</summary>
      <p class="muted">قبل كل جلسة رصد تُحفظ نسخة من حالة البيانات تلقائيًا (آخر 30 نسخة). «معاينة» لا تكتب شيئًا، وتعرض ما سيتغير قبل أي استعادة.</p>
      <div id="fsHistList" style="overflow-x:auto"></div></details>
    <details id="fsShareDetails"><summary>مشاركة للقراءة فقط لمدة 24 ساعة (باركود)</summary>
      <p class="muted">لمن تريد أن يطّلع على الدرجات والغياب والتقارير دون أي صلاحية تعديل، كالمدير أو المشرف. لا تظهر له متابعة الطلاب ولا ملاحظاتك ولا قسما أولياء الأمور وإدارة البيانات. ينتهي الرابط بعد 24 ساعة تلقائيًا، ويمكنك إلغاؤه قبل ذلك.</p>
      <label>اسم المستلم (اختياري): <input id="fsShareLabel" type="text" maxlength="60" placeholder="مثال: مدير المدرسة"></label>
      <button id="fsShareCreate" type="button">إنشاء باركود مشاهدة لمدة 24 ساعة</button>
      <div id="fsShareOut" style="margin:10px 0"></div>
      <div id="fsShareList" style="overflow-x:auto"></div></details>
    <p id="fsStatus" class="muted" style="font-weight:bold"></p>
    <div id="fsSummary" style="overflow-x:auto;margin-top:12px"></div>
    <button id="fsRestoreBtn" type="button" disabled style="display:none"></button></div>
    <button id="paLogout" type="button">تسجيل خروج</button>`;
  const ui = { status: root.querySelector('#fsStatus'), summary: root.querySelector('#fsSummary'), upBtn: root.querySelector('#fsUp'), downBtn: root.querySelector('#fsDown'), restoreBtn: root.querySelector('#fsRestoreBtn') };
  ui.restoreBtn.onclick = () => fsRestoreCloudVersion(ui);
  const cActions = root.querySelector('#fsConflictActions');
  root.querySelector('#fsDiffBtn').onclick = () => fsShowConflict(ui, cActions);
  root.querySelector('#fsKeepLocal').onclick = () => fsKeepLocal(ui);
  root.querySelector('#fsKeepCloud').onclick = () => fsKeepCloud(ui);
  root.querySelector('#fsHistDetails').addEventListener('toggle', e => { if (e.target.open) fsRenderHistory(root, ui); });
  const shareList = root.querySelector('#fsShareList');
  root.querySelector('#fsShareDetails').addEventListener('toggle', e => { if (e.target.open) fsRenderViewerLinks(shareList); });
  root.querySelector('#fsShareCreate').onclick = () => fsCreateViewerLink(root.querySelector('#fsShareLabel').value.trim(), root.querySelector('#fsShareOut'), () => fsRenderViewerLinks(shareList));
  root.querySelector('#fsState').textContent = fsDeviceStateText();
  const tg = root.querySelector('#fsAutoToggle'); tg.checked = fsAutoEnabled();
  tg.onchange = () => { localStorage.setItem(FS_AUTO_KEY, tg.checked ? '1' : '0'); if (tg.checked) fsAutoRun('toggle'); else fsBadge('المزامنة التلقائية متوقفة على هذا الجهاز', 'warn'); };
  root.querySelector('#fsSimUp').onclick = () => fsSimulateUpload(ui);
  ui.upBtn.onclick = () => fsUpload(ui);
  root.querySelector('#fsSimDown').onclick = () => fsSimulateReceive(ui);
  ui.downBtn.onclick = () => fsReceive(ui);
  root.querySelector('#fsBackupNow').onclick = async () => { try { await fsMakeBackup('يدوي', null); ui.status.textContent = 'أُنشئت نسخة احتياطية كاملة.'; renderBackups(); } catch (e) { ui.status.textContent = e.message; } };
  root.querySelector('#fsExportCloud').onclick = () => fsExportCloud(ui.status);
  root.querySelector('#paLogout').onclick = async () => { await supa.auth.signOut(); loginBox(root, 'syncDevices'); };
  async function renderBackups() {
    const host = root.querySelector('#fsBackups'); host.replaceChildren();
    const list = await fsListBackups();
    if (!list.length) { host.textContent = 'لا توجد نسخ احتياطية محفوظة داخل المتصفح بعد.'; return; }
    for (const b of list) {
      const row = document.createElement('div'); row.className = 'muted';
      row.textContent = new Date(b.at).toLocaleString('ar-SA') + ' — قبل ' + b.reason + ' — ' + ((b.localDb && b.localDb.students) || []).length + ' سجل طالب ';
      const r = document.createElement('button'); r.type = 'button'; r.textContent = 'استعادة';
      r.onclick = () => fsRestoreBackup(b.id, ui.status); row.appendChild(r); host.appendChild(row);
    }
  }
  renderBackups();
}


// ============================================================
// سجل النسخ في السحابة
// • قبل أي رفع يستبدل النسخة الحالية في السحابة، تُحفظ النسخة السابقة كصف مستقل (hist-...) في الجدول نفسه
//   (يحميه قيد «المعلم فقط» ذاته)، بحد أدنى 30 دقيقة بين لقطة وأخرى حتى يمثل كل لقطة «حالة قبل جلسة رصد».
// • يُحتفظ بآخر 30 لقطة، وتُحذف الأقدم تلقائيًا.
// • الاستعادة: محاكاة لا تكتب شيئًا ← نسخة احتياطية ← لقطة إجبارية من النسخة الحالية ← رفع اللقطة كنسخة معتمدة
//   ← قراءة عكسية ومطابقة ← تطبيقها على هذا الجهاز ← تحقق بعد إعادة التحميل. الجهاز الآخر يستقبلها تلقائيًا.
// ============================================================
const FS_HIST_PREFIX = 'hist-';
const FS_HIST_FORMAT = 'quran-gradebook-history-v2';
const FS_HIST_KEEP = 30;
const FS_HIST_SPACING_MS = 30 * 60 * 1000;

function fsHistId(d) { return FS_HIST_PREFIX + d.toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', ''); }

async function fsListHistory(limit) {
  let q = supa.from('gradebook_state').select('id,meta,updated_at').like('id', FS_HIST_PREFIX + '%').order('id', { ascending: false });
  if (limit) q = q.limit(limit);
  const { data, error } = await q;
  if (error) throw new Error('تعذّرت قراءة سجل النسخ: ' + error.message);
  return (data || []).filter(r => r.meta && r.meta.format === FS_HIST_FORMAT);
}

// يحفظ نسخة السحابة الحالية (prevFull) كلقطة؛ force يتجاوز شرط المدة الزمنية
async function fsSnapshotCloud(prevFull, reason, force) {
  if (!prevFull || !prevFull.db || !prevFull.meta) return 'none';
  const latest = (await fsListHistory(1))[0];
  if (latest && latest.meta.contentFp === prevFull.meta.contentFp) return 'duplicate';
  if (!force && latest && Date.now() - new Date(latest.meta.snapshotAt).getTime() < FS_HIST_SPACING_MS) return 'recent';
  const now = new Date();
  const meta = { format: FS_HIST_FORMAT, fp: fsFp(prevFull.db), contentFp: prevFull.meta.contentFp, students: (prevFull.db.students || []).length,
    islamicTests: fsIslamicTestCount(prevFull.db), snapshotAt: now.toISOString(), versionUploadedAt: prevFull.meta.uploadedAt || prevFull.updated_at || null,
    versionDevice: prevFull.meta.device || '', versionDeviceKind: prevFull.meta.deviceKind || '', reason: reason || '' };
  const id = fsHistId(now);
  const { error } = await supa.from('gradebook_state').insert({ id, db: prevFull.db, meta, updated_at: now.toISOString() });
  if (error) throw new Error('تعذّر حفظ لقطة في سجل النسخ: ' + error.message);
  const back = await fsFetchRow(id);
  if (!back || fsFp(back.db) !== meta.fp) {
    try { await supa.from('gradebook_state').delete().eq('id', id); } catch (_) {}
    throw new Error('لقطة سجل النسخ لم تُحفظ مطابقة.');
  }
  try {
    const all = await fsListHistory();
    for (const old of all.slice(FS_HIST_KEEP)) await supa.from('gradebook_state').delete().eq('id', old.id);
  } catch (_) {}
  return 'saved';
}

function fsDeviceLabel(ua) {
  ua = ua || '';
  if (/iPad|iPhone/.test(ua)) return 'الآيباد';
  if (/Windows|Linux/.test(ua)) return 'اللابتوب';
  return '';
}

// ---------- معاينة الاستعادة (لا تكتب شيئًا) ----------
async function fsSimulateRestore(id, ui) {
  fsSim.restore = null; ui.restoreBtn.disabled = true; ui.restoreBtn.style.display = 'none';
  const checks = [], check = (ok, label, detail, paths) => { checks.push({ ok: !!ok, label, detail, paths }); return ok; };
  ui.status.textContent = 'جارٍ معاينة النسخة... لا يُكتب أي شيء.';
  try {
    const row = await fsFetchRow(id);
    if (!check(!!row && !!row.db && row.meta && row.meta.format === FS_HIST_FORMAT, 'وُجدت النسخة في سجل السحابة')) throw new Error('النسخة غير موجودة.');
    check(fsFp(row.db) === row.meta.fp, 'بصمة النسخة سليمة (لم تتغير منذ حفظها)');
    check(fsValidDb(row.db), 'بنية النسخة صالحة ويقبلها التطبيق');
    check(!!(row.db.syncMarks && row.db.syncMarks.islamicTestsReset), 'النسخة من بعد حذف اختبارات الإسلامية القديمة');
    check(fsIslamicTestCount(row.db) === row.meta.islamicTests, 'لا توجد اختبارات إسلامية قديمة مستعادة', fsIslamicTestCount(row.db) + ' خانة');
    const local = fsReadStoredDb(), base = loadJSON(FS_BASE_KEY, null);
    const cloud = await fsFetchRow(FULL_ROW_ID, 'id,meta,updated_at');
    const inSync = !!(local && base && cloud && cloud.meta && fsContentFp(local) === base.contentFp && cloud.meta.contentFp === base.contentFp);
    check(inSync, 'هذا الجهاز متزامن مع السحابة (لا تعديلات غير مرفوعة على أي جهاز)', inSync ? '' : 'انتظر «✓ متزامن» على الجهازين ثم أعد المعاينة');
    check(!(cloud && cloud.meta && cloud.meta.contentFp === row.meta.contentFp), 'النسخة تختلف عن الحالية', '');
    const allOk = checks.every(c => c.ok);
    fsRenderReport(ui.summary, (allOk ? '✓ المعاينة ناجحة — نسخة ' : '✗ لا يمكن استعادة هذه النسخة الآن — نسخة ') + new Date(row.meta.versionUploadedAt || row.meta.snapshotAt).toLocaleString('ar-SA'),
      checks, local ? fsFieldRows(local, row.db, 'الآن', 'بعد الاستعادة') : null,
      local ? fsBreakdownRows(fsCourseBreakdown(local.coursework), fsCourseBreakdown(row.db.coursework), 'الآن', 'بعد الاستعادة') : null);
    if (allOk) {
      fsSim.restore = { id, fp: row.meta.fp, cloudContentFp: cloud.meta.contentFp };
      ui.restoreBtn.disabled = false; ui.restoreBtn.style.display = '';
      ui.restoreBtn.textContent = 'استعادة هذه النسخة (' + new Date(row.meta.versionUploadedAt || row.meta.snapshotAt).toLocaleString('ar-SA') + ')';
      ui.status.textContent = 'راجع الجدول: «الآن» مقابل «بعد الاستعادة». لم يُكتب شيء.';
    } else ui.status.textContent = 'لم يُكتب شيء.';
  } catch (e) { ui.status.textContent = 'تعذّرت المعاينة: ' + e.message + ' (لم يُكتب شيء)'; }
}

// ---------- الاستعادة الحقيقية ----------
async function fsRestoreCloudVersion(ui) {
  const sim = fsSim.restore;
  if (!sim) { ui.status.textContent = 'اضغط «معاينة» أولًا.'; return; }
  ui.restoreBtn.disabled = true;
  try {
    const row = await fsFetchRow(sim.id);
    const current = await fsFetchRow(FULL_ROW_ID);
    if (!row || fsFp(row.db) !== sim.fp || row.meta.fp !== sim.fp) throw new Error('تغيّرت النسخة المحفوظة بعد المعاينة؛ أعد المعاينة.');
    if (!current || current.meta.contentFp !== sim.cloudContentFp) throw new Error('تغيّرت السحابة بعد المعاينة؛ أعد المعاينة.');
    const local = fsReadStoredDb(), base = loadJSON(FS_BASE_KEY, null);
    if (!base || fsContentFp(local) !== base.contentFp) throw new Error('يوجد على هذا الجهاز تعديلات بعد المعاينة؛ انتظر «✓ متزامن» وأعد المعاينة.');
    if (!confirm('ستصبح نسخة ' + new Date(row.meta.versionUploadedAt || row.meta.snapshotAt).toLocaleString('ar-SA') + ' هي النسخة المعتمدة على السحابة وهذا الجهاز، ثم يستقبلها الجهاز الآخر تلقائيًا.\nستُحفظ النسخة الحالية أولًا في سجل النسخ وفي ملف احتياطي، فيمكن الرجوع عنها. متابعة؟')) {
      ui.status.textContent = 'أُلغيت الاستعادة. لم يتغير شيء.'; ui.restoreBtn.disabled = false; return;
    }
    const wasAuto = fsAutoEnabled(); if (wasAuto) localStorage.setItem(FS_AUTO_KEY, '0');
    try {
      ui.status.textContent = 'إنشاء النسخة الاحتياطية...';
      const bk = await fsMakeBackup('استعادة-نسخة-سحابية', { full: current });
      ui.status.textContent = 'حفظ النسخة الحالية في سجل النسخ...';
      await fsSnapshotCloud(current, 'قبل الاستعادة', true);
      const payload = fsClone(row.db);
      const meta = Object.assign(fsMakeMeta(payload, payload, { firstTransfer: false, removed: [] }), { restoredFrom: sim.id });
      await fsPushPayload(payload, meta, current, t => { ui.status.textContent = t; });
      ui.status.textContent = 'تطابقت السحابة. جارٍ تطبيق النسخة على هذا الجهاز...';
      if (wasAuto) localStorage.setItem(FS_AUTO_KEY, '1');
      await fsReplaceLocal(payload, 'restore-cloud', bk.id);
    } finally { if (wasAuto) localStorage.setItem(FS_AUTO_KEY, '1'); }
  } catch (e) { ui.status.textContent = 'توقفت الاستعادة: ' + e.message; fsSim.restore = null; }
}

async function fsRenderHistory(root, ui) {
  const host = root.querySelector('#fsHistList');
  host.textContent = 'جارٍ التحميل...';
  try {
    const list = await fsListHistory();
    host.replaceChildren();
    if (!list.length) { host.textContent = 'لا توجد نسخ في السجل بعد؛ ستُحفظ أول نسخة تلقائيًا عند الرفع القادم.'; return; }
    const t = document.createElement('table'); t.style.cssText = 'width:100%;min-width:520px';
    t.innerHTML = '<thead><tr><th>تاريخ النسخة</th><th>من جهاز</th><th>سجلات الطلاب</th><th></th></tr></thead><tbody></tbody>';
    for (const r of list) {
      const tr = document.createElement('tr');
      for (const v of [new Date(r.meta.versionUploadedAt || r.meta.snapshotAt).toLocaleString('ar-SA'), ({ ipad: 'الآيباد', laptop: 'اللابتوب' }[r.meta.versionDeviceKind] || fsDeviceLabel(r.meta.versionDevice) || '—'), r.meta.students]) {
        const td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td);
      }
      const td = document.createElement('td'); const b = document.createElement('button'); b.type = 'button'; b.textContent = 'معاينة';
      b.onclick = () => fsSimulateRestore(r.id, ui); td.appendChild(b); tr.appendChild(td);
      t.tBodies[0].appendChild(tr);
    }
    host.appendChild(t);
  } catch (e) { host.textContent = e.message; }
}


// ============================================================
// مشاركة للقراءة فقط لمدة 24 ساعة (باركود)
// الرمز يُولَّد على هذا الجهاز ولا يُرسَل إلى أي موقع آخر؛ يُحفظ في السحابة بصمته فقط.
// الصلاحية والإلغاء يُفحصان في الخادم (get_shared_gradebook)، والمشاهد لا يملك أي صلاحية كتابة.
// ============================================================
const VIEWER_URL = PARENT_PORTAL_URL.replace(/student\.html.*$/, 'viewer.html');
const QR_LIB_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';

function fsB64url(bytes) { let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function fsSha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function fsQrSvg(text) {
  if (!window.qrcode) await loadScript(QR_LIB_URL);
  const qr = window.qrcode(0, 'M'); qr.addData(text); qr.make();
  return qr.createSvgTag(5, 3);
}

async function fsCreateViewerLink(label, out, onDone) {
  out.textContent = 'جارٍ إنشاء الرابط...';
  try {
    const token = fsB64url(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await fsSha256Hex(token);
    const { data, error } = await supa.from('viewer_links').insert({ token_hash: hash, label: label || null }).select('id,expires_at').single();
    if (error) throw new Error(error.message);
    const url = VIEWER_URL + '#t=' + token;
    out.replaceChildren();
    const head = document.createElement('div');
    head.innerHTML = '<b>باركود المشاهدة جاهز</b> — ' + (label ? 'للمستلم: ' + escapeHtml(label) + ' — ' : '') + 'ينتهي ' + escapeHtml(new Date(data.expires_at).toLocaleString('ar-SA'));
    out.appendChild(head);
    const qrBox = document.createElement('div'); qrBox.style.cssText = 'margin:10px auto;text-align:center;background:#fff;display:inline-block;padding:6px;border-radius:8px';
    try { qrBox.innerHTML = await fsQrSvg(url); } catch (_) { qrBox.textContent = 'تعذّر رسم الباركود؛ استخدم الرابط أدناه.'; }
    const wrap = document.createElement('div'); wrap.style.textAlign = 'center'; wrap.appendChild(qrBox); out.appendChild(wrap);
    const linkRow = document.createElement('div'); linkRow.style.cssText = 'direction:ltr;text-align:left;word-break:break-all;font-size:12px;background:#f3f6f4;padding:6px;border-radius:6px';
    linkRow.textContent = url; out.appendChild(linkRow);
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'نسخ الرابط';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(url); copy.textContent = 'تم النسخ ✓'; } catch (_) { copy.textContent = 'انسخه يدويًا من السطر أعلاه'; } };
    out.appendChild(copy);
    const note = document.createElement('p'); note.className = 'muted';
    note.textContent = 'صوّر الباركود أو انسخ الرابط الآن؛ لا يمكن عرضه مرة أخرى بعد إغلاق هذه الصفحة لأنه لا يُحفظ في أي مكان. من يملكه يرى الدرجات والغياب والتقارير لجميع الطلاب حتى انتهاء المدة، دون أي صلاحية تعديل.';
    out.appendChild(note);
    onDone && onDone();
  } catch (e) { out.textContent = 'تعذّر إنشاء الرابط: ' + e.message; }
}

async function fsRenderViewerLinks(host) {
  host.textContent = 'جارٍ التحميل...';
  try {
    const { data, error } = await supa.from('viewer_links').select('id,label,created_at,expires_at,revoked,last_used_at,use_count').order('created_at', { ascending: false }).limit(20);
    if (error) throw new Error(error.message);
    host.replaceChildren();
    if (!data || !data.length) { host.textContent = 'لا توجد روابط مشاهدة بعد.'; return; }
    const t = document.createElement('table'); t.style.cssText = 'width:100%;min-width:560px';
    t.innerHTML = '<thead><tr><th>المستلم</th><th>أُنشئ</th><th>الحالة</th><th>مرات الفتح</th><th></th></tr></thead><tbody></tbody>';
    for (const r of data) {
      const active = !r.revoked && new Date(r.expires_at).getTime() > Date.now();
      const state = r.revoked ? 'أُلغي' : active ? 'نشط حتى ' + new Date(r.expires_at).toLocaleString('ar-SA') : 'انتهى';
      const tr = document.createElement('tr');
      for (const v of [r.label || '—', new Date(r.created_at).toLocaleString('ar-SA'), state, (r.use_count || 0) + (r.last_used_at ? ' (آخرها ' + new Date(r.last_used_at).toLocaleString('ar-SA') + ')' : '')]) {
        const td = document.createElement('td'); td.textContent = String(v); tr.appendChild(td);
      }
      const td = document.createElement('td');
      if (active) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = 'إلغاء الآن';
        b.onclick = async () => {
          if (!confirm('إلغاء هذا الرابط فورًا؟ لن يستطيع صاحبه فتح البيانات بعد الآن.')) return;
          const { error: ue } = await supa.from('viewer_links').update({ revoked: true }).eq('id', r.id);
          if (ue) alert('تعذّر الإلغاء: ' + ue.message);
          fsRenderViewerLinks(host);
        };
        td.appendChild(b);
      }
      tr.appendChild(td); t.tBodies[0].appendChild(tr);
    }
    host.appendChild(t);
  } catch (e) {
    host.textContent = /viewer_links|relation|does not exist|schema cache/i.test(e.message)
      ? 'ميزة المشاركة تحتاج تجهيز قاعدة البيانات أولًا (ملف viewer-links.sql).'
      : 'تعذّرت قراءة الروابط: ' + e.message;
  }
}


// ============================================================
// حل التعارض: عرض الفروق بأسماء الطلاب والخانات، ثم اعتماد نسخة واحدة كاملة.
// لا دمج. النسخة غير المعتمدة تبقى محفوظة: نسخة السحابة في «سجل النسخ»، ونسخة الجهاز في «النسخ الاحتياطية».
// وتُحفظ على كل جهاز نسخة «آخر مزامنة» حتى يبيّن التقرير أي الطرفين غيّر كل خانة.
// ============================================================
async function fsSaveBaseContent(db) {
  try { if (db) await fsIdbPut({ id: 'base-content', kind: 'base', at: new Date().toISOString(), contentFp: fsContentFp(db), data: db }); } catch (_) {}
}
async function fsLoadBaseContent() {
  try {
    const base = loadJSON(FS_BASE_KEY, null), item = await fsIdbGet('base-content');
    if (base && item && item.contentFp === base.contentFp) return item.data;
  } catch (_) {}
  return null;
}

function fsKeyDescribe(bucket, key, stu) {
  const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
  const who = id => (stu[id] ? stu[id].name + ' — ' + (stu[id].section || '') : id);
  const term = (t, p) => 'الفصل ' + (+t + 1) + ' / الفترة ' + (+p + 1);
  let p = String(key).split('|');
  if (bucket === 'grades' || bucket === 'absences') { const [t, pp, w, d, id] = p; return [who(id), (bucket === 'grades' ? 'تسميع القرآن' : 'غياب') + ' — ' + term(t, pp) + ' — الأسبوع ' + (+w + 1) + ' ' + (DAYS[+d] || '')]; }
  if (bucket === 'tests' || bucket === 'approvals') { const [t, pp, id] = p; return [who(id), (bucket === 'tests' ? 'اختبار القرآن' : 'اعتماد') + ' — ' + term(t, pp)]; }
  if (bucket === 'holidays') { const [t, pp, w, d] = p; return ['—', 'إجازة — ' + term(t, pp) + ' — الأسبوع ' + (+w + 1) + ' ' + (DAYS[+d] || '')]; }
  if (bucket === 'coursework') {
    let star = false; if (p[0] === 'star') { star = true; p = p.slice(1); }
    const [subj, t, pp, id, cat, i] = p;
    return [who(id), fsBreakdownLabel(subj + '|' + cat) + ' — ' + term(t, pp) + ' — خانة ' + (+i + 1) + (star ? ' (نجمة)' : '')];
  }
  return ['—', (FS_FIELD_LABELS[bucket] || bucket) + ' ' + key];
}
function fsShowVal(v) { return v === undefined ? '—' : v === true ? '✓' : v === false ? '✗' : typeof v === 'object' ? 'بيانات' : String(v); }

function fsReadableDiff(local, cloud, base) {
  const rows = []; let count = 0, onlyLocal = 0, onlyCloud = 0, both = 0;
  const same = (x, y) => fsCanon(x === undefined ? null : x) === fsCanon(y === undefined ? null : y);
  const side = (bv, lv, cv) => {
    if (!base) return 'غير معروف';
    const l = !same(lv, bv), c = !same(cv, bv);
    if (l && c) { both++; return 'الطرفان'; }
    if (l) { onlyLocal++; return 'هذا الجهاز'; }
    if (c) { onlyCloud++; return 'السحابة'; }
    return '—';
  };
  const stu = {};
  for (const s of [...(cloud.students || []), ...(local.students || [])]) stu[s.id] = s;
  for (const b of ['grades', 'absences', 'tests', 'approvals', 'holidays', 'coursework']) {
    const L = local[b] || {}, C = cloud[b] || {}, B = (base && base[b]) || {};
    for (const k of new Set([...Object.keys(L), ...Object.keys(C)])) {
      if (same(L[k], C[k])) continue;
      count++;
      const [who, what] = fsKeyDescribe(b, k, stu);
      rows.push([who, what, fsShowVal(L[k]), fsShowVal(C[k]), side(B[k], L[k], C[k])]);
    }
  }
  const byId = arr => Object.fromEntries((arr || []).map(s => [s.id, s]));
  const Ls = byId(local.students), Cs = byId(cloud.students), Bs = byId(base && base.students);
  for (const id of new Set([...Object.keys(Ls), ...Object.keys(Cs)])) {
    if (same(Ls[id], Cs[id])) continue;
    count++;
    const s = Ls[id] || Cs[id];
    rows.push([s.name + ' — ' + (s.section || ''), 'سجل الطالب (' + ((window.__app && window.__app.subjectNames && window.__app.subjectNames[s.subject]) || s.subject) + ')', Ls[id] ? (Cs[id] ? 'معدّل' : 'موجود') : '—', Cs[id] ? (Ls[id] ? 'معدّل' : 'موجود') : '—', side(Bs[id], Ls[id], Cs[id])]);
  }
  const lIds = (local.students || []).map(s => s.id), cIds = (cloud.students || []).map(s => s.id);
  if (!same(lIds, cIds) && same([...lIds].sort(), [...cIds].sort())) {
    count++; rows.push(['—', 'ترتيب الطلاب', 'مختلف', 'مختلف', side((base && base.students || []).map(s => s.id), (local.students || []).map(s => s.id), (cloud.students || []).map(s => s.id))]);
  }
  const skip = new Set(['grades', 'absences', 'tests', 'approvals', 'holidays', 'coursework', 'students', ...FS_UI_FIELDS]);
  for (const f of new Set([...Object.keys(local), ...Object.keys(cloud)])) {
    if (skip.has(f) || same(local[f], cloud[f])) continue;
    if (f === 'studentSupport') {
      const L = local[f] || {}, C = cloud[f] || {}, B = (base && base[f]) || {};
      for (const uid of new Set([...Object.keys(L), ...Object.keys(C)])) {
        if (same(L[uid], C[uid])) continue;
        count++;
        const s = (local.students || []).find(x => x.studentUid === uid) || (cloud.students || []).find(x => x.studentUid === uid);
        rows.push([s ? s.name : uid, 'متابعة الطالب', L[uid] ? 'موجود' : '—', C[uid] ? 'موجود' : '—', side(B[uid], L[uid], C[uid])]);
      }
      continue;
    }
    if (f === 'auditLog') continue; // سجل التعديلات يتبع النسخة المعتمدة ولا يُعرض كفرق
    count++;
    rows.push(['—', FS_FIELD_LABELS[f] || f, fsShowVal(local[f]), fsShowVal(cloud[f]), side(base && base[f], local[f], cloud[f])]);
  }
  return { rows, count, onlyLocal, onlyCloud, both, hasBase: !!base };
}

async function fsShowConflict(ui, actions) {
  actions.style.display = 'none';
  ui.status.textContent = 'جارٍ مقارنة هذا الجهاز بالسحابة... لا يُكتب أي شيء.';
  try {
    const { stored: local, memMatches } = fsSourceDb();
    if (!memMatches) throw new Error('أعد تحميل الصفحة ثم أعد المحاولة.');
    const row = await fsFetchRow(FULL_ROW_ID);
    if (!row || !row.db) throw new Error('لا توجد نسخة في السحابة.');
    const base = await fsLoadBaseContent();
    const d = fsReadableDiff(local, row.db, base);
    ui.summary.replaceChildren();
    const h = document.createElement('div');
    const when = row.meta && row.meta.uploadedAt ? new Date(row.meta.uploadedAt).toLocaleString('ar-SA') : '—';
    const dev = row.meta ? ({ ipad: 'الآيباد', laptop: 'اللابتوب' }[row.meta.deviceKind] || fsDeviceLabel(row.meta.device) || 'جهاز آخر') : '—';
    h.innerHTML = '<b>الفروق بين هذا الجهاز والسحابة: ' + d.count + ' خانة</b><br><span class="muted">آخر رفع إلى السحابة: ' + escapeHtml(when) + ' من ' + escapeHtml(dev) + '</span>' +
      (d.hasBase ? '<br>تغيّر على هذا الجهاز فقط: ' + d.onlyLocal + ' • في السحابة فقط: ' + d.onlyCloud + ' • على الطرفين: ' + d.both : '<br><span class="muted">(لا تتوفر نسخة آخر مزامنة على هذا الجهاز، فعمود «تغيّر في» غير معروف هذه المرة.)</span>');
    ui.summary.appendChild(h);
    if (d.count) {
      const t = document.createElement('table'); t.style.cssText = 'width:100%;min-width:640px;margin-top:8px';
      t.innerHTML = '<thead><tr><th>الطالب</th><th>الخانة</th><th>هذا الجهاز</th><th>السحابة</th><th>تغيّر في</th></tr></thead><tbody></tbody>';
      for (const r of d.rows.slice(0, 400)) { const tr = document.createElement('tr'); for (const v of r) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); } t.tBodies[0].appendChild(tr); }
      ui.summary.appendChild(t);
      if (d.rows.length > 400) { const m = document.createElement('p'); m.className = 'muted'; m.textContent = 'عُرضت أول 400 خانة من ' + d.rows.length + '.'; ui.summary.appendChild(m); }
      actions.style.display = '';
      ui.status.textContent = 'لم يُكتب شيء. راجع الجدول ثم اختر النسخة التي تعتمدها.';
    } else {
      ui.status.textContent = 'لا توجد فروق في الدرجات أو البيانات؛ سيُصلح هذا تلقائيًا.';
      saveJSON(FS_BASE_KEY, { contentFp: row.meta.contentFp, fp: row.meta.fp, at: new Date().toISOString(), kind: 'match' });
      fsSaveBaseContent(local);
      fsBadge('✓ متزامن', 'ok');
    }
    fsSim.conflict = { cloudFp: row.meta.fp, localFp: fsFp(local) };
  } catch (e) { ui.status.textContent = 'تعذّرت المقارنة: ' + e.message + ' (لم يُكتب شيء)'; }
}

async function fsKeepLocal(ui) {
  const c = fsSim.conflict; if (!c) return;
  try {
    const { stored: local, memMatches } = fsSourceDb();
    if (!memMatches || fsFp(local) !== c.localFp) throw new Error('تغيّرت بيانات هذا الجهاز؛ اعرض الفروق من جديد.');
    if (!(local.syncMarks && local.syncMarks.islamicTestsReset)) throw new Error('هذا الجهاز لم يُكمل المزامنة الأولى؛ لا يمكن اعتماده.');
    const current = await fsFetchRow(FULL_ROW_ID);
    if (!current || current.meta.fp !== c.cloudFp) throw new Error('تغيّرت السحابة؛ اعرض الفروق من جديد.');
    const typed = prompt('ستُعتمد نسخة هذا الجهاز كاملة وتُرفع إلى السحابة، ثم يستقبلها الجهاز الآخر.\nنسخة السحابة الحالية ستُحفظ في «سجل النسخ» ويمكن استعادتها.\nللمتابعة اكتب: اعتماد');
    if ((typed || '').trim() !== 'اعتماد') { ui.status.textContent = 'أُلغي. لم يتغير شيء.'; return; }
    const checks = [], check = (ok, label) => { checks.push({ ok: !!ok, label }); return ok; };
    const plan = fsBuildPayload(local, new Date().toISOString());
    fsVerifyPayload(local, plan, check);
    if (plan.firstTransfer || !checks.every(x => x.ok)) throw new Error('فشل فحص سلامة: ' + checks.filter(x => !x.ok).map(x => x.label).join('، '));
    ui.status.textContent = 'نسخة احتياطية...';
    await fsMakeBackup('اعتماد-هذا-الجهاز', { full: current });
    ui.status.textContent = 'حفظ نسخة السحابة الحالية في سجل النسخ...';
    await fsSnapshotCloud(current, 'قبل اعتماد نسخة جهاز في تعارض', true);
    const meta = fsMakeMeta(plan.payload, local, plan);
    await fsPushPayload(plan.payload, meta, current, t => { ui.status.textContent = t; });
    saveJSON(FS_BASE_KEY, { contentFp: meta.contentFp, fp: meta.fp, at: new Date().toISOString(), kind: 'keep-local' });
    fsSaveBaseContent(plan.payload);
    fsSim.conflict = null;
    ui.status.textContent = '✓ اعتُمدت نسخة هذا الجهاز ورُفعت وتطابقت السحابة. افتح التطبيق على الجهاز الآخر ليستقبلها.';
    fsBadge('✓ متزامن', 'ok');
  } catch (e) { ui.status.textContent = 'توقف: ' + e.message; }
}

async function fsKeepCloud(ui) {
  const c = fsSim.conflict; if (!c) return;
  try {
    const row = await fsFetchRow(FULL_ROW_ID);
    if (!row || row.meta.fp !== c.cloudFp) throw new Error('تغيّرت السحابة؛ اعرض الفروق من جديد.');
    const checks = [], check = (ok, label) => { checks.push({ ok: !!ok, label }); return ok; };
    fsVerifyCloudRow(row, check);
    if (!checks.every(x => x.ok)) throw new Error('نسخة السحابة لم تجتز فحص السلامة.');
    const typed = prompt('ستُستبدل بيانات هذا الجهاز بنسخة السحابة كاملة.\nنسخة هذا الجهاز الحالية ستُحفظ كنسخة احتياطية (ملف + داخل المتصفح) ويمكن استعادتها.\nللمتابعة اكتب: اعتماد');
    if ((typed || '').trim() !== 'اعتماد') { ui.status.textContent = 'أُلغي. لم يتغير شيء.'; return; }
    const bk = await fsMakeBackup('اعتماد-السحابة', { full: row });
    await fsReplaceLocal(row.db, 'receive', bk.id);
  } catch (e) { ui.status.textContent = 'توقف: ' + e.message; }
}


// ============================================================
// التقرير الأسبوعي للقرآن: يُحسب على أيام الحفظ (الأحد–الأربعاء) فقط؛ خطط علاجية (أقل من 40٪) وخطابات شكر (الدرجة الكاملة دون غياب)
// يُراجعها المعلم ويعدّلها، ولا يُرسَل شيء إلا بعد ضغط «اعتماد وإرسال».
// تُسجَّل الإرسالات داخل البيانات (db.weeklyNotices) فتنتقل للجهاز الآخر ولا تتكرر.
// ============================================================
const WN_THRESHOLD = 40;
const WN_HIFZ_DAYS = [0, 1, 2, 3]; // أيام الحفظ: الأحد إلى الأربعاء؛ الخميس تلاوة ولا يُحتسب
const WN_DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس'];
const WN_WEEKS = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع'];
const WN_DAY_MAX = 7;
const WN_WEAK_MAX = 3; // درجة 3 فأقل أو غياب = مقطع يحتاج تعويضًا
const WN_MAKEUP_MIN = 4; // التعويض المقبول: درجة 4 فأكثر
const wnState = { items: {}, links: null };


// ---------- توزيع مقرر القرآن (المقطع المقرر لكل يوم) ----------
// مقترح من استمارتي الفصل الأول: الفترة الأولى = الأسابيع 1–6 من استمارتها + أسبوع 30/4 في الأسبوع السابع؛ الفترة الثانية تبدأ 7/5 (الأسابيع 1–5)، والأسبوعان 6–7 (سورة الرعد) لاحقًا.
const QP_SEED = {"0|0|0|0": {"date": "17/3", "surah": "الإسراء", "from": 1, "to": 6}, "0|0|0|1": {"date": "18/3", "surah": "الإسراء", "from": 7, "to": 12}, "0|0|0|2": {"date": "19/3", "surah": "الإسراء", "from": 13, "to": 17}, "0|0|0|3": {"date": "20/3", "surah": "الإسراء", "from": 18, "to": 24}, "0|0|0|4": {"date": "21/3", "surah": "يوسف", "from": 1, "to": 29}, "0|0|1|0": {"date": "24/3", "surah": "الإسراء", "from": 25, "to": 32}, "0|0|1|1": {"date": "25/3", "surah": "الإسراء", "from": 33, "to": 44}, "0|0|1|2": {"date": "26/3", "surah": "الإسراء", "from": 45, "to": 53}, "0|0|1|3": {"date": "27/3", "surah": "الإسراء", "from": 54, "to": 60}, "0|0|1|4": {"date": "28/3", "surah": "يوسف", "from": 30, "to": 53}, "0|0|2|0": {"date": "2/4", "surah": "الإسراء", "from": 61, "to": 69}, "0|0|2|1": {"date": "3/4", "surah": "الإسراء", "from": 70, "to": 79}, "0|0|2|2": {"date": "4/4", "surah": "الإسراء", "from": 80, "to": 89}, "0|0|2|3": {"date": "5/4", "surah": "الإسراء", "from": 90, "to": 98}, "0|0|2|4": {"date": "6/4", "surah": "يوسف", "from": 54, "to": 81}, "0|0|3|0": {"date": "9/4", "surah": "الإسراء", "from": 99, "to": 104}, "0|0|3|1": {"date": "10/4", "surah": "الإسراء", "from": 105, "to": 111}, "0|0|3|2": {"date": "11/4", "surah": "النحل", "from": 1, "to": 9}, "0|0|3|3": {"date": "12/4", "note": "إجازة اليوم الوطني"}, "0|0|3|4": {"date": "13/4", "note": ""}, "0|0|4|0": {"date": "16/4", "surah": "النحل", "from": 10, "to": 14}, "0|0|4|1": {"date": "17/4", "surah": "النحل", "from": 15, "to": 23}, "0|0|4|2": {"date": "18/4", "surah": "النحل", "from": 24, "to": 29}, "0|0|4|3": {"date": "19/4", "surah": "النحل", "from": 30, "to": 34}, "0|0|4|4": {"date": "20/4", "surah": "يوسف", "from": 82, "to": 111}, "0|0|5|0": {"date": "23/4", "surah": "النحل", "from": 35, "to": 37}, "0|0|5|1": {"date": "24/4", "surah": "النحل", "from": 38, "to": 44}, "0|0|5|2": {"date": "25/4", "surah": "النحل", "from": 45, "to": 55}, "0|0|5|3": {"date": "26/4", "surah": "النحل", "from": 56, "to": 62}, "0|0|5|4": {"date": "27/4", "surah": "هود", "from": 1, "to": 24}, "0|0|6|0": {"date": "30/4", "surah": "النحل", "from": 63, "to": 67}, "0|0|6|1": {"date": "1/5", "surah": "النحل", "from": 68, "to": 74}, "0|0|6|2": {"date": "2/5", "surah": "النحل", "from": 75, "to": 79}, "0|0|6|3": {"date": "3/5", "surah": "النحل", "from": 80, "to": 87}, "0|0|6|4": {"date": "4/5", "surah": "هود", "from": 25, "to": 49}, "0|1|0|0": {"date": "7/5", "surah": "النحل", "from": 88, "to": 93}, "0|1|0|1": {"date": "8/5", "surah": "النحل", "from": 94, "to": 102}, "0|1|0|2": {"date": "9/5", "surah": "النحل", "from": 103, "to": 110}, "0|1|0|3": {"date": "10/5", "surah": "النحل", "from": 111, "to": 118}, "0|1|0|4": {"date": "11/5", "surah": "هود", "from": 50, "to": 96}, "0|1|1|0": {"date": "14/5", "surah": "النحل", "from": 119, "to": 128}, "0|1|1|1": {"date": "15/5", "surah": "الحجر", "from": 1, "to": 13}, "0|1|1|2": {"date": "16/5", "surah": "الحجر", "from": 14, "to": 25}, "0|1|1|3": {"date": "17/5", "surah": "الحجر", "from": 26, "to": 44}, "0|1|1|4": {"date": "18/5", "surah": "هود", "from": 97, "to": 123}, "0|1|2|0": {"date": "21/5", "surah": "الحجر", "from": 45, "to": 60}, "0|1|2|1": {"date": "22/5", "surah": "الحجر", "from": 61, "to": 84}, "0|1|2|2": {"date": "23/5", "surah": "الحجر", "from": 85, "to": 99}, "0|1|2|3": {"date": "24/5", "surah": "إبراهيم", "from": 1, "to": 5}, "0|1|2|4": {"date": "25/5", "surah": "يونس", "from": 1, "to": 20}, "0|1|3|0": {"date": "28/5", "surah": "إبراهيم", "from": 6, "to": 9}, "0|1|3|1": {"date": "29/5", "surah": "إبراهيم", "from": 10, "to": 12}, "0|1|3|2": {"date": "30/5", "surah": "إبراهيم", "from": 13, "to": 18}, "0|1|3|3": {"date": "1/6", "surah": "إبراهيم", "from": 19, "to": 22}, "0|1|3|4": {"date": "2/6", "surah": "يونس", "from": 21, "to": 47}, "0|1|4|0": {"date": "5/6", "surah": "إبراهيم", "from": 23, "to": 31}, "0|1|4|1": {"date": "6/6", "surah": "إبراهيم", "from": 32, "to": 37}, "0|1|4|2": {"date": "7/6", "surah": "إبراهيم", "from": 38, "to": 44}, "0|1|4|3": {"date": "8/6", "surah": "إبراهيم", "from": 45, "to": 52}, "0|1|4|4": {"date": "9/6", "surah": "يونس", "from": 48, "to": 70}};
const QP_AR = '٠١٢٣٤٥٦٧٨٩';
function qpToAr(v) { return String(v ?? '').replace(/[0-9]/g, c => QP_AR[c]); }
function qpFromAr(v) { return String(v ?? '').replace(/[\u200e\u200f\u061c]/g, '').replace(/[٠-٩]/g, c => QP_AR.indexOf(c)).replace(/[۰-۹]/g, c => '۰۱۲۳۴۵۶۷۸۹'.indexOf(c)).trim(); }
// التاريخ يُعرض: اليوم يمينًا والشهر يسارًا بالأرقام الهندية (علامة RLM تمنع انقلاب الترتيب)
function qpDateShow(v) { const s = qpFromAr(v); const m = s.match(/^(\d{1,2})\s*\/\s*(\d{1,2})$/); return m ? qpToAr(m[1]) + '\u200f/' + qpToAr(m[2]) : qpToAr(s); }
function qpEntry(t, p, w, d) { const db = window.__app.db, days = db.quranPlan && db.quranPlan.days; return days ? days[[t, p, w, d].join('|')] || null : null; }
function qpText(e) { return e && e.surah ? 'سورة ' + e.surah + ' من آية ' + e.from + ' إلى آية ' + e.to : ''; }

function qpRender(host) {
  const app = window.__app; if (!app || !host) return;
  const box = document.createElement('div'); box.className = 'summary-card';
  box.innerHTML = `<details id="qpDetails"><summary><b>توزيع مقرر القرآن (لتحديد الآيات في الخطط ورسائل التعويض)</b></summary>
    <p class="muted">المقطع المقرر لكل يوم. راجع ربط الأسابيع والتواريخ، وعدّل ما يلزم، ثم اضغط «اعتماد التوزيع» لهذه الفترة.</p>
    <label>الفصل <select id="qpT"><option value="0">الأول</option><option value="1">الثاني</option></select></label>
    <label>الفترة <select id="qpP"><option value="0">الأولى</option><option value="1">الثانية</option></select></label>
    <div id="qpOut" style="overflow-x:auto;margin-top:8px"></div></details>`;
  host.appendChild(box);
  const a = app.db.actual; box.querySelector('#qpT').value = a.t; box.querySelector('#qpP').value = a.p;
  const draw = () => qpDraw(box);
  box.querySelector('#qpT').onchange = draw; box.querySelector('#qpP').onchange = draw;
  box.querySelector('#qpDetails').addEventListener('toggle', e => { if (e.target.open) draw(); });
}
function qpDraw(box) {
  const db = window.__app.db, t = +box.querySelector('#qpT').value, p = +box.querySelector('#qpP').value, out = box.querySelector('#qpOut');
  const saved = db.quranPlan && db.quranPlan.days || {};
  const hasSaved = Object.keys(saved).some(k => k.startsWith(t + '|' + p + '|'));
  const src = hasSaved ? saved : QP_SEED;
  out.replaceChildren();
  const note = document.createElement('p');
  note.style.cssText = hasSaved ? 'color:#1f6b3f' : 'color:#7a5600;font-weight:bold';
  note.textContent = hasSaved ? '✓ توزيع هذه الفترة معتمد. يمكنك تعديله ثم الاعتماد من جديد.' : (Object.keys(QP_SEED).some(k => k.startsWith(t + '|' + p + '|')) ? 'هذا مقترح من الاستمارة ولم يُعتمد بعد. راجع أن كل أسبوع في مكانه الصحيح ثم اضغط «اعتماد التوزيع».' : 'لا يوجد توزيع لهذه الفترة بعد. اكتبه ثم اضغط «اعتماد التوزيع».');
  out.appendChild(note);
  const tb = document.createElement('table'); tb.style.cssText = 'width:100%;min-width:620px';
  tb.innerHTML = '<thead><tr><th style="text-align:center">الأسبوع</th><th style="text-align:center">اليوم</th><th style="text-align:center">التاريخ</th><th style="text-align:center">السورة</th><th style="text-align:center">من آية</th><th style="text-align:center">إلى آية</th><th style="text-align:center">النوع</th></tr></thead><tbody></tbody>';
  const inputs = [];
  for (let w = 0; w < 7; w++) for (let d = 0; d < 5; d++) {
    const k = [t, p, w, d].join('|'), e = src[k] || {}, tr = document.createElement('tr');
    if (d === 0) tr.style.borderTop = '3px solid #9fb8ad';
    const mk = (val, width, numeric) => { const i = document.createElement('input'); i.value = val ?? ''; i.style.cssText = 'width:' + width + ';padding:4px;text-align:center'; if (numeric) { i.inputMode = 'numeric'; i.onblur = () => { i.value = qpToAr(qpFromAr(i.value)); }; } return i; };
    const date = mk(qpDateShow(e.date || ''), '80px'), sur = mk(e.surah || e.note || '', '120px'), fr = mk(qpToAr(e.from ?? ''), '64px', true), to = mk(qpToAr(e.to ?? ''), '64px', true);
    date.onblur = () => { date.value = qpDateShow(date.value); };
    const c = x => { const td = document.createElement('td'); td.style.textAlign = 'center'; if (typeof x === 'string') td.textContent = x; else td.appendChild(x); return td; };
    tr.append(c(d === 0 ? WN_WEEKS[w] : ''), c(WN_DAYS[d]), c(date), c(sur), c(fr), c(to), c(d === 4 ? 'تلاوة' : 'حفظ'));
    tb.tBodies[0].appendChild(tr);
    inputs.push({ k, date, sur, fr, to });
  }
  out.appendChild(tb);
  const refill = document.createElement('button'); refill.type = 'button'; refill.textContent = 'تعبئة الجدول من الاستمارة (المقترح)';
  refill.onclick = () => {
    for (const x of inputs) {
      const e = QP_SEED[x.k] || {};
      x.date.value = qpDateShow(e.date || ''); x.sur.value = e.surah || e.note || ''; x.fr.value = qpToAr(e.from ?? ''); x.to.value = qpToAr(e.to ?? '');
    }
    note.style.cssText = 'color:#7a5600;font-weight:bold';
    note.textContent = 'عُبّئ الجدول من الاستمارة ولم يُحفظ بعد. راجعه ثم اضغط «اعتماد التوزيع لهذه الفترة».';
  };
  out.append(refill, document.createTextNode(' '));
  const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'اعتماد التوزيع لهذه الفترة';
  const st = document.createElement('span'); st.className = 'muted';
  btn.onclick = () => {
    const app = window.__app, db2 = app.db; db2.quranPlan = db2.quranPlan || { days: {} }; db2.quranPlan.days = db2.quranPlan.days || {};
    for (const x of inputs) {
      const sur = x.sur.value.trim(), fr = parseInt(qpFromAr(x.fr.value), 10), to = parseInt(qpFromAr(x.to.value), 10), date = qpFromAr(x.date.value).replace(/\s+/g, '');
      if (sur && fr > 0 && to >= fr) db2.quranPlan.days[x.k] = { date, surah: sur, from: fr, to };
      else if (date || sur) db2.quranPlan.days[x.k] = { date, note: sur };
      else delete db2.quranPlan.days[x.k];
    }
    db2.quranPlan.updatedAt = new Date().toISOString();
    app.save(); st.textContent = ' ✓ اعتُمد التوزيع.'; qpDraw(box);
  };
  out.append(btn, st);
}

function wnWeekLabel(t, p, w) { return 'الفصل ' + (t + 1) + ' — الفترة ' + (p + 1) + ' — الأسبوع ' + WN_WEEKS[w]; }
function wnTag(t, p, w) { return [t, p, w].join('|'); }

function wnCompute(t, p, w) {
  const app = window.__app, db = app.db;
  const out = { remedial: [], thanks: [], incomplete: [], middle: 0, reqDays: [] };
  out.reqDays = WN_HIFZ_DAYS.filter(d => !(w === 6 && d === 4) && !db.holidays[[t, p, w, d].join('|')]);
  if (!out.reqDays.length) return out;
  const qs = db.students.filter(s => (s.subject || 'quran') === 'quran' && (s.status || 'active') === 'active');
  for (const s of qs) {
    let sum = 0, abs = 0, graded = 0; const cells = [], missing = [], days = [];
    for (const d of out.reqDays) {
      const k = [t, p, w, d, s.id].join('|'), passage = qpText(qpEntry(t, p, w, d));
      if (db.absences[k]) { abs++; cells.push(WN_DAYS[d] + ': غياب'); days.push({ d, k, v: null, abs: true, passage }); }
      else if (db.grades[k]) { const v = Number(db.grades[k].value) || 0; sum += v; graded++; cells.push(WN_DAYS[d] + ': ' + v); days.push({ d, k, v, abs: false, passage }); }
      else { missing.push(WN_DAYS[d]); cells.push(WN_DAYS[d] + ': لم يُرصد'); days.push({ d, k, v: null, abs: false, missing: true, passage }); }
    }
    const max = WN_DAY_MAX * out.reqDays.length, pct = sum / max * 100;
    const item = { uid: s.studentUid, name: app.cleanName(s.name), section: s.section || db.sections[0], sum, max, pct, abs, graded, cells, missing, days };
    if (missing.length) out.incomplete.push(item);
    else if (pct < WN_THRESHOLD) out.remedial.push(item);
    else if (abs === 0 && sum === max) out.thanks.push(item);
    else out.middle++;
  }
  const sort = (a, b) => a.section.localeCompare(b.section, 'ar') || a.name.localeCompare(b.name, 'ar');
  out.remedial.sort(sort); out.thanks.sort(sort); out.incomplete.sort(sort);
  return out;
}

function wnRemedialText(it, label) {
  const avg = it.graded ? (it.sum / it.graded) : 0;
  const needs = [];
  if (it.abs) needs.push('• الالتزام بالحضور: غاب ' + it.abs + (it.abs === 1 ? ' يومًا' : ' أيام') + ' من أيام الحفظ هذا الأسبوع، وكل غياب يُفقده درجة الحفظ لذلك اليوم.');
  if (it.graded && avg < 3.5) needs.push('• تقوية الحفظ قبل الحصة: متوسط درجته في أيام الحفظ ' + avg.toFixed(1) + ' من ' + WN_DAY_MAX + '.');
  else if (it.graded) needs.push('• المحافظة على مستوى التسميع في الأيام التي حضرها، مع تعويض ما فاته.');
  const weak = (it.days || []).filter(x => x.abs || (x.v !== null && x.v <= WN_WEAK_MAX));
  const plan = [];
  if (weak.some(x => x.passage)) plan.push('إعادة حفظ هذه المقاطع وتسميعها للمعلم لتعويضها: ' + weak.filter(x => x.passage).map(x => x.passage).join('، ') + '.');
  plan.push(
    'تسميع المقطع المقرر لابنكم في البيت يوميًا قبل يوم الحصة (10 إلى 15 دقيقة).',
    'الاستماع إلى المقطع بصوت قارئ متقن مرتين يوميًا لتثبيت الحفظ وصحة النطق.',
    'مراجعة ما حُفظ هذا الأسبوع حتى لا يُنسى.'
  );
  if (it.abs) plan.push('الحرص على حضوره جميع الحصص، وإبلاغ المعلم بأي عذر.');
  return ['الخطة العلاجية الأسبوعية — القرآن الكريم',
    'الطالب: ' + it.name + ' — ' + it.section,
    label,
    'نتيجة أيام الحفظ (الأحد إلى الأربعاء): ' + it.sum + ' من ' + it.max + ' (' + Math.round(it.pct) + '٪)، وهي دون الحد المطلوب ' + WN_THRESHOLD + '٪.',
    ...((it.days || []).some(x => x.passage)
      ? ['', 'المقاطع المقررة هذا الأسبوع ودرجاته فيها:', ...it.days.map(x => '• ' + WN_DAYS[x.d] + ': ' + (x.passage || 'غير محدد') + ' — ' + (x.abs ? 'غياب' : x.missing ? 'لم يُرصد' : x.v + ' من ' + WN_DAY_MAX))]
      : ['تفاصيل أيام الحفظ: ' + it.cells.join('، ') + '.']),
    '',
    'ما يحتاجه ابنكم:',
    ...needs,
    '',
    'المطلوب خلال الأسبوع القادم:',
    ...plan.map((x, i) => (i + 1) + '. ' + x),
    '',
    'ومن جهة المعلم: متابعته يوميًا في الحصة، وإتاحة فرصة لتعويض التسميع.',
    'نسأل الله لابنكم التوفيق والسداد.'].join('\n');
}

function wnThanksText(it, label) {
  return ['خطاب شكر وعرفان',
    'نتقدم بالشكر والتقدير لابنكم الطالب ' + it.name + ' (' + it.section + ')',
    'على إتمامه حفظ ' + label.replace(/^.*— الأسبوع /, 'الأسبوع ') + ' كاملًا بالدرجة الكاملة (' + it.sum + ' من ' + it.max + ') دون أي غياب في أيام الحفظ.',
    'ونشكر لكم حرصكم ومتابعتكم، فهذا ثمرة جهدكم معه.',
    'نسأل الله أن يجعله من أهل القرآن الذين هم أهل الله وخاصته.',
    '',
    'معلم القرآن الكريم'].join('\n');
}


// رسائل الشكر على تعويض مقاطع الخطة العلاجية: مقطع كان غيابًا أو 3 فأقل، ثم أصبح 4 فأكثر
function wnMakeups() {
  const app = window.__app, db = app.db, out = [];
  const stuByUid = new Map(db.students.filter(s => (s.subject || 'quran') === 'quran').map(s => [s.studentUid, s]));
  for (const [recKey, rec] of Object.entries(db.weeklyNotices || {})) {
    if (rec.type !== 'remedial' || !Array.isArray(rec.weak) || !rec.weak.length) continue;
    const [t, p, w, uid] = recKey.split('|'), s = stuByUid.get(uid); if (!s) continue;
    const sent = new Set(rec.improvedSent || []), improved = [];
    for (const x of rec.weak) {
      if (sent.has(x.k)) continue;
      const g = db.grades[x.k], v = g ? Number(g.value) || 0 : null;
      if (v !== null && v >= WN_MAKEUP_MIN && (x.v === 'abs' || v > Number(x.v))) improved.push({ k: x.k, from: x.v, to: v, passage: x.passage, day: x.day });
    }
    if (!improved.length) continue;
    out.push({ uid, name: app.cleanName(s.name), section: s.section || db.sections[0], recKey, improved, remaining: rec.weak.filter(x => !sent.has(x.k)).length - improved.length, weekLabel: wnWeekLabel(+t, +p, +w), sum: improved.length, max: rec.weak.length, pct: 100, cells: [] });
  }
  return out.sort((a, b) => a.section.localeCompare(b.section, 'ar') || a.name.localeCompare(b.name, 'ar'));
}
function wnMakeupText(it) {
  return ['خطاب شكر وعرفان — تعويض مقاطع الخطة العلاجية',
    'نشكر ابنكم الطالب ' + it.name + ' (' + it.section + ')',
    'على عودته وتسميع ما كان يحتاج إلى تعويض من خطة ' + it.weekLabel.replace(/^.*— الأسبوع /, 'الأسبوع ') + ':',
    ...it.improved.map(m => '• ' + (m.passage || m.day) + ' — ' + (m.from === 'abs' ? 'كان غائبًا' : 'كانت درجته ' + m.from) + '، وأصبحت ' + m.to + ' من ' + WN_DAY_MAX),
    it.remaining > 0 ? 'وبقي ' + it.remaining + (it.remaining === 1 ? ' مقطع' : ' مقاطع') + ' نرجو متابعته في تعويضها.' : 'وبهذا أتمّ تعويض كل ما في الخطة، بارك الله فيه.',
    'وهذا دليل على حرصه وحرصكم، فجزاكم الله خيرًا.',
    '',
    'معلم القرآن الكريم'].join('\n');
}

async function wnLoadLinks() {
  try {
    if (!isSupabaseConfigured()) return null;
    await ensureLibs();
    const { data: sess } = await supa.auth.getSession();
    if (!sess || !sess.session) return null;
    const { data, error } = await supa.from('parent_links').select('student_id,parent_uid');
    if (error) return null;
    const m = new Map();
    for (const l of data || []) { if (!m.has(l.student_id)) m.set(l.student_id, []); m.get(l.student_id).push(l.parent_uid); }
    return m;
  } catch (_) { return null; }
}

function wnRender(host) {
  const app = window.__app; if (!app || !host) return;
  const a = app.db.actual;
  host.innerHTML = `<div class="summary-card"><details id="wnDetails" open><summary><b>التقرير الأسبوعي: الخطط العلاجية وخطابات الشكر (القرآن الكريم)</b></summary>
    <p class="muted">يُحسب على أيام الحفظ فقط (الأحد إلى الأربعاء)، ولا يُحتسب الخميس لأنه تلاوة. خطة علاجية لمن نتيجته أقل من ${WN_THRESHOLD}٪، وخطاب شكر لمن أتم أيام الحفظ بالدرجة الكاملة دون غياب. راجع الكشفين وعدّل النص إن شئت؛ لا يُرسل شيء قبل «اعتماد وإرسال».</p>
    <label>الفصل <select id="wnT"><option value="0">الأول</option><option value="1">الثاني</option></select></label>
    <label>الفترة <select id="wnP"><option value="0">الأولى</option><option value="1">الثانية</option></select></label>
    <label>الأسبوع <select id="wnW">${WN_WEEKS.map((n, i) => `<option value="${i}">${n}</option>`).join('')}</select></label>
    <button id="wnBuild" type="button">تجهيز الكشفين</button>
    <div id="wnOut" style="overflow-x:auto;margin-top:10px"></div></details></div>`;
  host.querySelector('#wnT').value = a.t; host.querySelector('#wnP').value = a.p; host.querySelector('#wnW').value = a.w;
  host.querySelector('#wnBuild').onclick = () => wnBuild(host);
}

async function wnBuild(host) {
  const app = window.__app, db = app.db;
  const t = +host.querySelector('#wnT').value, p = +host.querySelector('#wnP').value, w = +host.querySelector('#wnW').value;
  const out = host.querySelector('#wnOut');
  out.textContent = 'جارٍ التجهيز...';
  const r = wnCompute(t, p, w), label = wnWeekLabel(t, p, w), tag = wnTag(t, p, w);
  if (!r.reqDays.length) { out.textContent = 'لا توجد أيام حفظ محتسبة في هذا الأسبوع (إجازة).'; return; }
  wnState.links = await wnLoadLinks();
  const sent = db.weeklyNotices || {};
  const receipts = await wnLoadReceipts(Object.entries(sent).filter(([k]) => k.startsWith(tag + '|')).flatMap(([, v]) => v.ids || []));
  wnState.items = {}; wnState.week = { t, p, w, label, tag };
  out.replaceChildren();
  const sum = document.createElement('p');
  sum.innerHTML = '<b>' + escapeHtml(label) + '</b> — أيام الحفظ المحتسبة: ' + r.reqDays.map(d => WN_DAYS[d]).join('، ') +
    '<br>خطط علاجية: <b>' + r.remedial.length + '</b> • خطابات شكر: <b>' + r.thanks.length + '</b> • بين ذلك: ' + r.middle + ' • لم يكتمل رصدهم: ' + r.incomplete.length +
    (wnState.links ? '' : '<br><span style="color:#b42318">تعذّرت معرفة أولياء الأمور المرتبطين (سجّل الدخول من «بوابة أولياء الأمور»). يمكنك المراجعة والطباعة الآن، والإرسال بعد تسجيل الدخول.</span>');
  out.appendChild(sum);
  const sentHere = Object.entries(sent).filter(([k]) => k.startsWith(tag + '|')).map(([, v]) => v);
  if (sentHere.length) {
    const st = { read: 0, ack: 0, none: 0 };
    for (const v of sentHere) { const s = wnReceiptState(v, receipts); st[s]++; }
    const rs = document.createElement('p');
    rs.innerHTML = 'الاستلام لهذا الأسبوع: أُرسل ' + sentHere.length + ' • أقرّ بالاطلاع <b>' + st.ack + '</b> • قرأ فقط <b>' + st.read + '</b> • <span style="color:#b42318">لم يقرأ بعد <b>' + st.none + '</b></span>';
    out.appendChild(rs);
  }
  if (r.incomplete.length) {
    const inc = document.createElement('details');
    inc.innerHTML = '<summary style="color:#7a5600">طلاب لم يكتمل رصد أسبوعهم (' + r.incomplete.length + ') — أكمل رصدهم ثم أعد التجهيز</summary>';
    const ul = document.createElement('ul');
    for (const it of r.incomplete) { const li = document.createElement('li'); li.textContent = it.name + ' — ' + it.section + ': لم يُرصد ' + it.missing.join('، '); ul.appendChild(li); }
    inc.appendChild(ul); out.appendChild(inc);
  }
  const table = (title, list, type) => {
    const h = document.createElement('h4'); h.textContent = title + ' (' + list.length + ')'; out.appendChild(h);
    if (!list.length) { const m = document.createElement('p'); m.className = 'muted'; m.textContent = 'لا يوجد.'; out.appendChild(m); return; }
    const tb = document.createElement('table'); tb.style.cssText = 'width:100%;min-width:760px';
    tb.innerHTML = '<thead><tr><th style="width:40px">إرسال</th><th>الطالب</th><th>النتيجة</th><th>ولي الأمر والاستلام</th><th>النص الذي سيُرسل (يمكن تعديله)</th></tr></thead><tbody></tbody>';
    for (const it of list) {
      const id = type + '|' + it.uid, doneKey = tag + '|' + it.uid + '|' + type, already = sent[doneKey];
      const parents = wnState.links ? (wnState.links.get(it.uid) || []) : null;
      const text = type === 'remedial' ? wnRemedialText(it, label) : wnThanksText(it, label);
      const tr = document.createElement('tr');
      const c0 = document.createElement('td'), cb = document.createElement('input'); cb.type = 'checkbox';
      cb.checked = !already && (!parents || parents.length > 0); cb.disabled = !!already || (parents && !parents.length);
      c0.appendChild(cb);
      const c1 = document.createElement('td'); c1.textContent = it.name + ' — ' + it.section;
      const c2 = document.createElement('td'); c2.textContent = it.sum + ' / ' + it.max + ' (' + Math.round(it.pct) + '٪)' + (it.abs ? ' — غياب ' + it.abs : '');
      const c3 = document.createElement('td'); c3.style.whiteSpace = 'pre-line';
      c3.textContent = already ? wnReceiptText(already, receipts) : parents === null ? 'غير معروف' : parents.length ? 'مرتبط — لم يُرسل بعد' : 'لا يوجد ولي أمر مرتبط (اطبع الخطاب للتوقيع)';
      const c4 = document.createElement('td'), ta = document.createElement('textarea'); ta.value = text; ta.rows = type === 'remedial' ? 9 : 5; ta.style.cssText = 'width:100%;min-width:320px;font:13px Tahoma'; c4.appendChild(ta);
      tr.append(c0, c1, c2, c3, c4); tb.tBodies[0].appendChild(tr);
      wnState.items[id] = { it, type, cb, ta, parents, doneKey };
    }
    out.appendChild(tb);
  };
  table('كشف الخطط العلاجية (أقل من ' + WN_THRESHOLD + '٪)', r.remedial, 'remedial');
  table('كشف خطابات الشكر والعرفان (الدرجة الكاملة في أيام الحفظ دون غياب)', r.thanks, 'thanks');
  const mks = wnMakeups();
  {
    const h = document.createElement('h4'); h.textContent = 'رسائل الشكر على تعويض مقاطع الخطة العلاجية (' + mks.length + ')'; out.appendChild(h);
    const pnote = document.createElement('p'); pnote.className = 'muted'; pnote.textContent = 'لمن أُرسلت له خطة علاجية ثم أعاد تسميع مقطع منها بدرجة ' + WN_MAKEUP_MIN + ' فأكثر. تظهر هنا مهما كان الأسبوع المختار.'; out.appendChild(pnote);
    if (mks.length) {
      const tb = document.createElement('table'); tb.style.cssText = 'width:100%;min-width:760px';
      tb.innerHTML = '<thead><tr><th style="width:40px">إرسال</th><th>الطالب</th><th>ما عوّضه</th><th>ولي الأمر</th><th>النص (يمكن تعديله)</th></tr></thead><tbody></tbody>';
      for (const it of mks) {
        const parents = wnState.links ? (wnState.links.get(it.uid) || []) : null;
        const tr = document.createElement('tr');
        const c0 = document.createElement('td'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !parents || parents.length > 0; cb.disabled = !!(parents && !parents.length); c0.appendChild(cb);
        const c1 = document.createElement('td'); c1.textContent = it.name + ' — ' + it.section;
        const c2 = document.createElement('td'); c2.textContent = it.improved.length + ' من ' + it.max + ' — ' + it.weekLabel;
        const c3 = document.createElement('td'); c3.textContent = parents === null ? 'غير معروف' : parents.length ? 'مرتبط' : 'لا يوجد ولي أمر مرتبط';
        const c4 = document.createElement('td'), ta = document.createElement('textarea'); ta.value = wnMakeupText(it); ta.rows = 8; ta.style.cssText = 'width:100%;min-width:320px;font:13px Tahoma'; c4.appendChild(ta);
        tr.append(c0, c1, c2, c3, c4); tb.tBodies[0].appendChild(tr);
        wnState.items['makeup|' + it.recKey + '|' + it.improved.map(m => m.k).join(',')] = { it, type: 'makeup', cb, ta, parents, recKey: it.recKey, doneKey: it.recKey + '|makeup|' + Date.now() };
      }
      out.appendChild(tb);
    }
  }
  const bar = document.createElement('div'); bar.style.marginTop = '10px';
  const send = document.createElement('button'); send.type = 'button'; send.textContent = 'اعتماد وإرسال المحدد إلى أولياء الأمور';
  const pr = document.createElement('button'); pr.type = 'button'; pr.textContent = 'طباعة الكشفين';
  const st = document.createElement('p'); st.className = 'muted'; st.id = 'wnStatus';
  send.onclick = () => wnSend(host, st); pr.onclick = () => wnPrint();
  bar.append(send, document.createTextNode(' '), pr, st); out.appendChild(bar);
}


async function wnLoadReceipts(ids) {
  const m = new Map(); if (!ids.length || !wnState.links) return m;
  try {
    let { data, error } = await supa.from('parent_messages').select('id,read_at,acknowledged_at,ack_name').in('id', ids);
    if (error) ({ data, error } = await supa.from('parent_messages').select('id,read_at,acknowledged_at').in('id', ids));
    if (error) ({ data, error } = await supa.from('parent_messages').select('id,read_at').in('id', ids));
    for (const r of data || []) m.set(String(r.id), r);
  } catch (_) {}
  return m;
}
function wnReceiptState(v, receipts) {
  const rs = (v.ids || []).map(id => receipts.get(String(id))).filter(Boolean);
  if (rs.some(r => r.acknowledged_at)) return 'ack';
  if (rs.some(r => r.read_at)) return 'read';
  return 'none';
}
function wnReceiptText(v, receipts) {
  const rs = (v.ids || []).map(id => receipts.get(String(id))).filter(Boolean);
  const fmt = x => new Date(x).toLocaleString('ar-SA', { dateStyle: 'short', timeStyle: 'short' });
  let t = '✓ أُرسل ' + fmt(v.at);
  const ack = rs.map(r => r.acknowledged_at).filter(Boolean).sort()[0], rd = rs.map(r => r.read_at).filter(Boolean).sort()[0];
  const ackRow = rs.filter(r => r.acknowledged_at).sort((a, b) => a.acknowledged_at.localeCompare(b.acknowledged_at))[0];
  if (ack) t += '\n✓ أقرّ' + (v.type === 'thanks' ? ' بالاطلاع ' : ' وتعهد ') + (ackRow && ackRow.ack_name ? 'باسم «' + ackRow.ack_name + '» ' : '') + fmt(ack);
  else if (rd) t += '\n✓ قرأها ' + fmt(rd) + ' (لم يضغط «اطّلعت»)';
  else t += '\n✗ لم يقرأها بعد (منذ ' + Math.max(1, Math.round((Date.now() - new Date(v.at)) / 3600000)) + ' ساعة)';
  return t;
}

async function wnSend(host, st) {
  const app = window.__app, db = app.db;
  const chosen = Object.values(wnState.items).filter(x => x.cb.checked && !x.cb.disabled);
  if (!chosen.length) { st.textContent = 'لم تحدد أي طالب للإرسال.'; return; }
  if (!wnState.links) { st.textContent = 'سجّل الدخول من «بوابة أولياء الأمور» أولًا، ثم أعد التجهيز.'; return; }
  const rem = chosen.filter(x => x.type === 'remedial').length, mk = chosen.filter(x => x.type === 'makeup').length, th = chosen.length - rem - mk;
  if (!confirm('سيُرسل إلى أولياء الأمور المرتبطين: ' + rem + ' خطة علاجية و' + th + ' خطاب شكر' + (mk ? ' و' + mk + ' رسالة شكر على التعويض' : '') + ' عن ' + wnState.week.label + '.\nمتابعة؟')) return;
  db.weeklyNotices = db.weeklyNotices || {};
  let ok = 0, fail = 0;
  for (const x of chosen) {
    const body = x.ta.value.trim(); if (!body) continue;
    let good = true;
    const ids = [];
    for (const pu of x.parents || []) {
      const { data, error } = await supa.from('parent_messages').insert({ student_id: x.it.uid, parent_uid: pu, sender_role: 'teacher', body }).select('id');
      if (error) { good = false; break; }
      for (const r of (Array.isArray(data) ? data : data ? [data] : [])) if (r && r.id !== undefined) ids.push(String(r.id));
    }
    if (good && (x.parents || []).length) {
      if (x.type === 'makeup') {
        const rec = db.weeklyNotices[x.recKey]; if (rec) rec.improvedSent = [...new Set([...(rec.improvedSent || []), ...x.it.improved.map(m => m.k)])];
        db.weeklyNotices[x.doneKey] = { at: new Date().toISOString(), type: 'makeup', ids };
      } else {
        const rec = { at: new Date().toISOString(), type: x.type, ids };
        if (x.type === 'remedial') rec.weak = (x.it.days || []).filter(d => d.abs || (d.v !== null && d.v <= WN_WEAK_MAX)).map(d => ({ k: d.k, v: d.abs ? 'abs' : d.v, passage: d.passage || '', day: WN_DAYS[d.d] }));
        db.weeklyNotices[x.doneKey] = rec;
      }
      ok++;
    } else fail++;
    st.textContent = 'جارٍ الإرسال... ' + (ok + fail) + ' من ' + chosen.length;
  }
  app.save();
  st.textContent = '✓ أُرسل ' + ok + (fail ? ' — تعذّر ' + fail + ' (أعد المحاولة لاحقًا)' : '') + '. تظهر الرسائل لولي الأمر في بوابته.';
  wnBuild(host).then(() => { const s2 = host.querySelector('#wnStatus'); if (s2) s2.textContent = st.textContent; });
}

function wnPrint() {
  const w = wnState.week; if (!w) return;
  const items = Object.values(wnState.items);
  const block = (type, title) => {
    const list = items.filter(x => x.type === type);
    if (!list.length) return '<h2>' + title + '</h2><p>لا يوجد.</p>';
    return '<h2>' + title + ' (' + list.length + ')</h2><table><tr><th>م</th><th>الطالب</th><th>الشعبة</th><th>النتيجة</th></tr>' +
      list.map((x, i) => '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(x.it.name) + '</td><td>' + escapeHtml(x.it.section) + '</td><td>' + x.it.sum + ' / ' + x.it.max + ' (' + Math.round(x.it.pct) + '٪)</td></tr>').join('') + '</table>' +
      list.map(x => '<div class="letter"><pre>' + escapeHtml(x.ta.value) + '</pre><p class="sig">اسم ولي الأمر: ........................ التوقيع: ................ تاريخ الاطلاع: ..../..../........</p></div>').join('');
  };
  const html = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>' + escapeHtml(w.label) + '</title><style>body{font:14px Tahoma;margin:24px}table{border-collapse:collapse;width:100%;margin-bottom:16px}td,th{border:1px solid #999;padding:5px}h1{font-size:18px}h2{font-size:16px;margin-top:24px}.letter{page-break-inside:avoid;border:1px solid #ccc;border-radius:8px;padding:10px;margin:10px 0}.sig{margin-top:14px;border-top:1px dashed #999;padding-top:8px}pre{white-space:pre-wrap;font:14px Tahoma;margin:0}</style></head><body><h1>التقرير الأسبوعي — القرآن الكريم — ' + escapeHtml(w.label) + '</h1>' +
    block('remedial', 'كشف الخطط العلاجية') + block('thanks', 'كشف خطابات الشكر والعرفان') + '<script>window.onload=function(){window.print()}<\/script></body></html>';
  const win = window.open('', '_blank'); if (!win) { alert('اسمح بالنوافذ المنبثقة للطباعة.'); return; }
  win.document.write(html); win.document.close();
}


// ============================================================
// إشعار المخالفات لأولياء الأمور (متى شاء المعلم)
// يرسل المخالفات الجديدة فقط منذ آخر إشعار لكل طالب ومادة وفترة، بعد مراجعة المعلم واعتماده.
// ============================================================
const VN_SUBJECTS = [['islamic', 'الدراسات الإسلامية'], ['tajweed', 'التجويد']];
const vnState = { items: [] };
function vnTimesWord(n) { return n === 1 ? 'مرة واحدة' : n === 2 ? 'مرتان' : n + ' مرات'; }

function vnCompute(t, p) {
  const app = window.__app, db = app.db, out = [];
  const sentAll = db.violationNotices || {};
  for (const [subject, title] of VN_SUBJECTS) {
    const defs = (app.courseDefs[subject] || []).filter(d => d.violation);
    if (!defs.length) continue;
    const studs = db.students.filter(s => (s.subject || 'quran') === subject && (s.status || 'active') === 'active');
    for (const s of studs) {
      const all = [], fresh = [];
      for (const d of defs) for (let i = 0; i < d.count; i++) {
        const k = [subject, t, p, s.id, d.id, i].join('|');
        if (Number(db.coursework[k]) > 0) { all.push({ k, d }); }
      }
      if (!all.length) continue;
      const tag = [s.studentUid, subject, t, p].join('|'), sent = new Set((sentAll[tag] && sentAll[tag].keys) || []);
      for (const x of all) if (!sent.has(x.k)) fresh.push(x);
      if (!fresh.length) continue;
      const count = list => { const m = new Map(); for (const x of list) m.set(x.d.name, (m.get(x.d.name) || 0) + 1); return [...m.entries()]; };
      out.push({ uid: s.studentUid, name: app.cleanName(s.name), section: s.section || db.sections[0], subject, title, tag, all, fresh, freshCounts: count(fresh), total: all.length, deduction: Math.min(5, Math.floor(all.length / 2)) });
    }
  }
  return out.sort((a, b) => a.section.localeCompare(b.section, 'ar') || a.name.localeCompare(b.name, 'ar'));
}

function vnText(it, t, p) {
  return ['إشعار مخالفات — ' + it.title,
    'الطالب: ' + it.name + ' — ' + it.section,
    'الفصل ' + (t + 1) + ' — الفترة ' + (p + 1),
    '',
    'سُجّل على ابنكم:',
    ...it.freshCounts.map(([n, c]) => '• ' + n + ': ' + vnTimesWord(c)),
    '',
    'مجموع مخالفاته في هذه الفترة: ' + it.total + '، وكل مخالفتين تُحسم منهما درجة واحدة' + (it.deduction ? ' (المحسوم حتى الآن: ' + it.deduction + ')' : '') + '.',
    'نأمل تعاونكم في توجيهه، شاكرين حرصكم.',
    '',
    'معلم المادة'].join('\n');
}

function vnRender(host) {
  const app = window.__app; if (!app || !host) return;
  const a = app.db.actual;
  const box = document.createElement('div'); box.className = 'summary-card';
  box.innerHTML = `<details id="vnDetails"><summary><b>إشعار المخالفات لأولياء الأمور</b></summary>
    <p class="muted">يعرض المخالفات الجديدة فقط منذ آخر إشعار لكل طالب، في الدراسات الإسلامية والتجويد. راجع النص، ثم «اعتماد وإرسال». يمكنك الإرسال في أي يوم.</p>
    <label>الفصل <select id="vnT"><option value="0">الأول</option><option value="1">الثاني</option></select></label>
    <label>الفترة <select id="vnP"><option value="0">الأولى</option><option value="1">الثانية</option></select></label>
    <button id="vnBuild" type="button">عرض المخالفات الجديدة</button>
    <div id="vnOut" style="overflow-x:auto;margin-top:10px"></div></details>`;
  host.appendChild(box);
  box.querySelector('#vnT').value = a.t; box.querySelector('#vnP').value = a.p;
  box.querySelector('#vnBuild').onclick = () => vnBuild(box);
}

async function vnBuild(box) {
  const t = +box.querySelector('#vnT').value, p = +box.querySelector('#vnP').value, out = box.querySelector('#vnOut');
  out.textContent = 'جارٍ التجهيز...';
  const list = vnCompute(t, p);
  const links = await wnLoadLinks();
  out.replaceChildren(); vnState.items = []; vnState.tp = { t, p };
  if (!list.length) { out.textContent = 'لا توجد مخالفات جديدة لم يُرسل عنها إشعار.'; return; }
  if (!links) { const w = document.createElement('p'); w.style.color = '#b42318'; w.textContent = 'تعذّرت معرفة أولياء الأمور المرتبطين (سجّل الدخول من «بوابة أولياء الأمور»). يمكنك المراجعة الآن والإرسال بعد تسجيل الدخول.'; out.appendChild(w); }
  const tb = document.createElement('table'); tb.style.cssText = 'width:100%;min-width:720px';
  tb.innerHTML = '<thead><tr><th style="width:40px">إرسال</th><th>الطالب</th><th>المادة</th><th>الجديد</th><th>ولي الأمر</th><th>النص (يمكن تعديله)</th></tr></thead><tbody></tbody>';
  for (const it of list) {
    const parents = links ? (links.get(it.uid) || []) : null;
    const tr = document.createElement('tr');
    const c0 = document.createElement('td'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !parents || parents.length > 0; cb.disabled = !!(parents && !parents.length); c0.appendChild(cb);
    const c1 = document.createElement('td'); c1.textContent = it.name + ' — ' + it.section;
    const c2 = document.createElement('td'); c2.textContent = it.title;
    const c3 = document.createElement('td'); c3.textContent = it.freshCounts.map(([n, c]) => n + ' (' + c + ')').join('، ');
    const c4 = document.createElement('td'); c4.textContent = parents === null ? 'غير معروف' : parents.length ? 'مرتبط' : 'لا يوجد ولي أمر مرتبط';
    const c5 = document.createElement('td'), ta = document.createElement('textarea'); ta.value = vnText(it, t, p); ta.rows = 8; ta.style.cssText = 'width:100%;min-width:300px;font:13px Tahoma'; c5.appendChild(ta);
    tr.append(c0, c1, c2, c3, c4, c5); tb.tBodies[0].appendChild(tr);
    vnState.items.push({ it, cb, ta, parents });
  }
  out.appendChild(tb);
  const send = document.createElement('button'); send.type = 'button'; send.textContent = 'اعتماد وإرسال المحدد';
  const st = document.createElement('p'); st.className = 'muted'; st.id = 'vnStatus';
  send.onclick = () => vnSend(box, st);
  out.append(send, st);
}

async function vnSend(box, st) {
  const app = window.__app, db = app.db;
  const chosen = vnState.items.filter(x => x.cb.checked && !x.cb.disabled);
  if (!chosen.length) { st.textContent = 'لم تحدد أي طالب.'; return; }
  if (chosen.some(x => x.parents === null)) { st.textContent = 'سجّل الدخول من «بوابة أولياء الأمور» أولًا، ثم أعد العرض.'; return; }
  if (!confirm('سيُرسل إشعار مخالفات إلى أولياء أمور ' + chosen.length + ' طالبًا. متابعة؟')) return;
  db.violationNotices = db.violationNotices || {};
  let ok = 0, fail = 0;
  for (const x of chosen) {
    const body = x.ta.value.trim(); if (!body) continue;
    let good = true;
    for (const pu of x.parents) {
      const { error } = await supa.from('parent_messages').insert({ student_id: x.it.uid, parent_uid: pu, sender_role: 'teacher', body });
      if (error) { good = false; break; }
    }
    if (good) {
      const prev = (db.violationNotices[x.it.tag] && db.violationNotices[x.it.tag].keys) || [];
      db.violationNotices[x.it.tag] = { keys: [...new Set([...prev, ...x.it.fresh.map(f => f.k)])], at: new Date().toISOString() };
      ok++;
    } else fail++;
  }
  app.save();
  const msg = '✓ أُرسل ' + ok + (fail ? ' — تعذّر ' + fail : '') + '. تظهر لك حالة القراءة في «رسائل أولياء الأمور».';
  await vnBuild(box);
  const s2 = box.querySelector('#vnStatus'); if (s2) s2.textContent = msg; else { const p = document.createElement('p'); p.textContent = msg; box.querySelector('#vnOut').appendChild(p); }
}


// ============================================================
// خطط المشاركات والواجبات وخطابات الشكر (الدراسات الإسلامية، التجويد، المهارات الحياتية)
// • «ما مضى» = الخانات التي رصدتها لطلاب الشعبة (خانة رُصدت لأحدهم تُعدّ ماضية للجميع، والفارغة للطالب = لم يؤدِّ).
// • المرة الأولى: على كل ما مضى في الفترة. بعدها: على الخانات الجديدة منذ آخر إرسال فقط (واجبات الأسبوع).
// • خطة علاجية لمن لم يتجاوز CN_THRESHOLD٪، وخطاب شكر لمن أخذ الدرجة الكاملة. لا يُرسل شيء قبل اعتماد المعلم.
// ============================================================
const CN_THRESHOLD = 30;
const CN_SUBJECTS = [['islamic', 'الدراسات الإسلامية'], ['tajweed', 'التجويد'], ['life', 'المهارات الحياتية']];
const CN_CATS = ['participation', 'homework'];
const cnState = { items: {}, ctx: null };

function cnPastColumns(subject, t, p, section) {
  const app = window.__app, db = app.db, cols = {};
  const studs = db.students.filter(s => (s.subject || 'quran') === subject && (s.section || db.sections[0]) === section && (s.status || 'active') === 'active');
  for (const d of (app.courseDefs[subject] || []).filter(d => CN_CATS.includes(d.id))) {
    cols[d.id] = [];
    for (let i = 0; i < d.count; i++) if (studs.some(s => db.coursework[[subject, t, p, s.id, d.id, i].join('|')] !== undefined)) cols[d.id].push(i);
  }
  return { cols, studs };
}
function cnSnapKey(subject, t, p, section) { return [subject, t, p, section].join('|'); }

function cnCompute(t, p) {
  const app = window.__app, db = app.db, notes = db.courseNotices || {}, snaps = notes.snap || {};
  const groups = [];
  for (const [subject, title] of CN_SUBJECTS) {
    const defs = (app.courseDefs[subject] || []).filter(d => CN_CATS.includes(d.id));
    if (!defs.length) continue;
    for (const section of db.sections) {
      const { cols, studs } = cnPastColumns(subject, t, p, section);
      if (!studs.length) continue;
      const sk = cnSnapKey(subject, t, p, section), snap = snaps[sk];
      const mode = snap ? 'new' : 'all';
      const use = {};
      for (const d of defs) use[d.id] = (cols[d.id] || []).filter(i => !snap || !(snap[d.id] || []).includes(i));
      const nCols = defs.reduce((a, d) => a + use[d.id].length, 0);
      const g = { subject, title, section, mode, sk, cols, use, nCols, remedial: [], thanks: [], middle: 0, defs };
      if (nCols) {
        for (const s of studs) {
          const parts = defs.map(d => {
            let got = 0; const idx = use[d.id];
            for (const i of idx) got += Number(db.coursework[[subject, t, p, s.id, d.id, i].join('|')] || 0);
            return { name: d.name, got, max: idx.length * d.max, cnt: idx.length, done: idx.filter(i => Number(db.coursework[[subject, t, p, s.id, d.id, i].join('|')] || 0) > 0).length };
          }).filter(x => x.max > 0);
          const got = parts.reduce((a, x) => a + x.got, 0), max = parts.reduce((a, x) => a + x.max, 0), pct = max ? got / max * 100 : 0;
          const it = { uid: s.studentUid, name: app.cleanName(s.name), section, subject, title, parts, got, max, pct, mode };
          if (pct <= CN_THRESHOLD) g.remedial.push(it); else if (got === max) g.thanks.push(it); else g.middle++;
        }
        const sort = (a, b) => a.name.localeCompare(b.name, 'ar');
        g.remedial.sort(sort); g.thanks.sort(sort);
      }
      groups.push(g);
    }
  }
  return groups;
}

function cnScopeText(it) { return it.mode === 'all' ? 'فيما رُصد منذ بداية الفترة' : 'فيما رُصد منذ آخر تقرير (هذا الأسبوع)'; }
function cnRemedialText(it, t, p) {
  const lines = it.parts.map(x => '• ' + x.name + ': ' + x.got + ' من ' + x.max + ' (أدّى ' + x.done + ' من ' + x.cnt + ')');
  const needs = [];
  const part = it.parts.find(x => x.name === 'المشاركة'), hw = it.parts.find(x => x.name === 'الواجبات');
  if (hw && hw.done < hw.cnt) needs.push('حلّ الواجبات وتسليمها في موعدها؛ لم يُسلّم ' + (hw.cnt - hw.done) + ' من ' + hw.cnt + '.');
  if (part && part.done < part.cnt) needs.push('المشاركة في الحصة؛ لم يشارك في ' + (part.cnt - part.done) + ' من ' + part.cnt + ' فرص.');
  return ['خطة علاجية — المشاركات والواجبات — ' + it.title,
    'الطالب: ' + it.name + ' — ' + it.section,
    'الفصل ' + (t + 1) + ' — الفترة ' + (p + 1),
    'نتيجته ' + cnScopeText(it) + ': ' + it.got + ' من ' + it.max + ' (' + Math.round(it.pct) + '٪)، ولم تتجاوز ' + CN_THRESHOLD + '٪.',
    ...lines,
    '',
    'ما يحتاجه ابنكم:',
    ...needs.map(x => '• ' + x),
    '',
    'المطلوب خلال الأسبوع القادم:',
    '1. متابعة واجباته يوميًا والتأكد من حلها وإحضارها.',
    '2. مراجعة الدرس معه في البيت ليستطيع المشاركة في الحصة.',
    '3. تشجيعه على السؤال والمشاركة، وإبلاغ المعلم بأي صعوبة يواجهها.',
    '',
    'نسأل الله لابنكم التوفيق والسداد.'].join('\n');
}
function cnThanksText(it, t, p) {
  return ['خطاب شكر وعرفان — ' + it.title,
    'نتقدم بالشكر والتقدير لابنكم الطالب ' + it.name + ' (' + it.section + ')',
    'على تميّزه في المشاركة وأداء الواجبات كاملة ' + cnScopeText(it) + ' (' + it.got + ' من ' + it.max + ').',
    'ونشكر لكم متابعتكم وحرصكم، فهذا ثمرة جهدكم معه.',
    'بارك الله فيه وزاده علمًا وتوفيقًا.',
    '',
    'معلم المادة'].join('\n');
}

function cnRender(host) {
  const app = window.__app; if (!app || !host) return;
  const a = app.db.actual;
  const box = document.createElement('div'); box.className = 'summary-card';
  box.innerHTML = `<details id="cnDetails"><summary><b>المشاركات والواجبات: الخطط العلاجية وخطابات الشكر</b></summary>
    <p class="muted">لكل مادة وشعبة: أول مرة يُحسب على كل ما رُصد منذ بداية الفترة، وبعد كل إرسال يُحسب على الخانات الجديدة فقط (واجبات الأسبوع). خطة علاجية لمن لم يتجاوز ${CN_THRESHOLD}٪، وخطاب شكر لمن أخذ الدرجة الكاملة. لا يُرسل شيء قبل «اعتماد وإرسال».</p>
    <label>الفصل <select id="cnT"><option value="0">الأول</option><option value="1">الثاني</option></select></label>
    <label>الفترة <select id="cnP"><option value="0">الأولى</option><option value="1">الثانية</option></select></label>
    <button id="cnBuild" type="button">تجهيز الكشوف</button>
    <div id="cnOut" style="overflow-x:auto;margin-top:10px"></div></details>`;
  host.appendChild(box);
  box.querySelector('#cnT').value = a.t; box.querySelector('#cnP').value = a.p;
  box.querySelector('#cnBuild').onclick = () => cnBuild(box);
  try {
    const pending = cnCompute(a.t, a.p).filter(g => g.mode === 'new' && g.nCols);
    if (pending.length) {
      const n = document.createElement('p'); n.style.cssText = 'color:#7a5600;font-weight:bold';
      n.textContent = '🔔 رُصدت مشاركات أو واجبات جديدة منذ آخر تقرير في: ' + pending.map(g => g.title + ' (' + g.section + ')').join('، ') + '. هل تريد تجهيز رسائلها؟ افتح هذا القسم واضغط «تجهيز الكشوف».';
      box.insertBefore(n, box.firstChild.nextSibling);
    }
  } catch (_) {}
}

async function cnBuild(box) {
  const db = window.__app.db, t = +box.querySelector('#cnT').value, p = +box.querySelector('#cnP').value, out = box.querySelector('#cnOut');
  out.textContent = 'جارٍ التجهيز...';
  const groups = cnCompute(t, p), links = await wnLoadLinks();
  const sent = (db.courseNotices && db.courseNotices.sent) || {};
  const receipts = await wnLoadReceipts(Object.values(sent).flatMap(v => v.ids || []));
  cnState.items = {}; cnState.ctx = { t, p, groups };
  out.replaceChildren();
  if (!links) { const w = document.createElement('p'); w.style.color = '#b42318'; w.textContent = 'تعذّرت معرفة أولياء الأمور المرتبطين (سجّل الدخول من «بوابة أولياء الأمور»). يمكنك المراجعة والطباعة الآن، والإرسال بعد تسجيل الدخول.'; out.appendChild(w); }
  let any = false;
  for (const g of groups) {
    const h = document.createElement('h4');
    h.textContent = g.title + ' — ' + g.section + ' — ' + (g.mode === 'all' ? 'منذ بداية الفترة' : 'الجديد منذ آخر تقرير') + ' (' + g.nCols + ' خانة)';
    out.appendChild(h);
    if (!g.nCols) { const m = document.createElement('p'); m.className = 'muted'; m.textContent = g.mode === 'all' ? 'لم تُرصد مشاركات أو واجبات بعد.' : 'لا توجد خانات جديدة منذ آخر تقرير.'; out.appendChild(m); continue; }
    const s = document.createElement('p'); s.className = 'muted'; s.textContent = 'خطط علاجية: ' + g.remedial.length + ' • خطابات شكر: ' + g.thanks.length + ' • بين ذلك: ' + g.middle; out.appendChild(s);
    for (const [type, list] of [['remedial', g.remedial], ['thanks', g.thanks]]) {
      if (!list.length) continue;
      any = true;
      const tb = document.createElement('table'); tb.style.cssText = 'width:100%;min-width:760px;margin-bottom:8px';
      tb.innerHTML = '<thead><tr><th style="width:40px">إرسال</th><th>' + (type === 'remedial' ? 'خطة علاجية' : 'خطاب شكر') + '</th><th>النتيجة</th><th>ولي الأمر والاستلام</th><th>النص (يمكن تعديله)</th></tr></thead><tbody></tbody>';
      for (const it of list) {
        const parents = links ? (links.get(it.uid) || []) : null;
        const tr = document.createElement('tr');
        const c0 = document.createElement('td'), cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !parents || parents.length > 0; cb.disabled = !!(parents && !parents.length); c0.appendChild(cb);
        const c1 = document.createElement('td'); c1.textContent = it.name;
        const c2 = document.createElement('td'); c2.textContent = it.got + ' / ' + it.max + ' (' + Math.round(it.pct) + '٪)';
        const c3 = document.createElement('td'); c3.textContent = parents === null ? 'غير معروف' : parents.length ? 'مرتبط' : 'لا يوجد ولي أمر مرتبط (اطبع الخطاب للتوقيع)';
        const c4 = document.createElement('td'), ta = document.createElement('textarea'); ta.value = type === 'remedial' ? cnRemedialText(it, t, p) : cnThanksText(it, t, p); ta.rows = type === 'remedial' ? 10 : 6; ta.style.cssText = 'width:100%;min-width:320px;font:13px Tahoma'; c4.appendChild(ta);
        tr.append(c0, c1, c2, c3, c4); tb.tBodies[0].appendChild(tr);
        cnState.items[type + '|' + g.sk + '|' + it.uid] = { it, type, g, cb, ta, parents };
      }
      out.appendChild(tb);
    }
  }
  // سجل ما أُرسل سابقًا في هذه الفترة مع حالة الاستلام
  const prev = Object.entries(sent).filter(([k]) => k.split('|')[1] === String(t) && k.split('|')[2] === String(p));
  if (prev.length) {
    const d = document.createElement('details'); d.innerHTML = '<summary>ما أُرسل سابقًا في هذه الفترة وحالة استلامه (' + prev.length + ')</summary>';
    const ul = document.createElement('ul');
    for (const [, v] of prev.sort((a, b) => (b[1].at || '').localeCompare(a[1].at || ''))) { const li = document.createElement('li'); li.style.whiteSpace = 'pre-line'; li.textContent = (v.label || '') + ' — ' + wnReceiptText(v, receipts).replace(/\n/g, ' • '); ul.appendChild(li); }
    d.appendChild(ul); out.appendChild(d);
  }
  const bar = document.createElement('div'); bar.style.marginTop = '10px';
  const send = document.createElement('button'); send.type = 'button'; send.textContent = 'اعتماد وإرسال المحدد';
  const pr = document.createElement('button'); pr.type = 'button'; pr.textContent = 'طباعة الكشوف';
  const st = document.createElement('p'); st.className = 'muted'; st.id = 'cnStatus';
  send.onclick = () => cnSend(box, st); pr.onclick = () => cnPrint();
  if (!any) send.disabled = true;
  bar.append(send, document.createTextNode(' '), pr, st); out.appendChild(bar);
}

async function cnSend(box, st) {
  const app = window.__app, db = app.db, ctx = cnState.ctx; if (!ctx) return;
  const all = Object.values(cnState.items), chosen = all.filter(x => x.cb.checked && !x.cb.disabled);
  if (!chosen.length) { st.textContent = 'لم تحدد أي طالب.'; return; }
  if (chosen.some(x => x.parents === null)) { st.textContent = 'سجّل الدخول من «بوابة أولياء الأمور» أولًا، ثم أعد التجهيز.'; return; }
  const rem = chosen.filter(x => x.type === 'remedial').length;
  if (!confirm('سيُرسل ' + rem + ' خطة علاجية و' + (chosen.length - rem) + ' خطاب شكر.\nبعدها تُحسب التقارير القادمة على الخانات الجديدة فقط. متابعة؟')) return;
  db.courseNotices = db.courseNotices || {}; db.courseNotices.sent = db.courseNotices.sent || {}; db.courseNotices.snap = db.courseNotices.snap || {};
  let ok = 0, fail = 0; const stamp = new Date().toISOString();
  for (const x of chosen) {
    const body = x.ta.value.trim(); if (!body) continue;
    const ids = []; let good = true;
    for (const pu of x.parents) {
      const { data, error } = await supa.from('parent_messages').insert({ student_id: x.it.uid, parent_uid: pu, sender_role: 'teacher', body }).select('id');
      if (error) { good = false; break; }
      for (const r of (Array.isArray(data) ? data : data ? [data] : [])) if (r && r.id !== undefined) ids.push(String(r.id));
    }
    if (good) { db.courseNotices.sent[[x.g.subject, ctx.t, ctx.p, x.g.section, x.it.uid, x.type, stamp].join('|')] = { at: stamp, type: x.type, ids, label: x.it.name + ' — ' + x.g.title + ' — ' + (x.type === 'remedial' ? 'خطة علاجية' : 'خطاب شكر') }; ok++; } else fail++;
    st.textContent = 'جارٍ الإرسال... ' + (ok + fail) + ' من ' + chosen.length;
  }
  // بعد الإرسال: تُعلَّم الخانات الحالية كـ«سبق تقريرها» لكل مجموعة أُرسل منها شيء، فتُحسب المرة القادمة على الجديد فقط
  for (const g of ctx.groups) if (g.nCols) db.courseNotices.snap[g.sk] = JSON.parse(JSON.stringify(g.cols));
  app.save();
  const msg = '✓ أُرسل ' + ok + (fail ? ' — تعذّر ' + fail : '') + '. التقرير القادم سيكون على الخانات الجديدة فقط.';
  await cnBuild(box); const s2 = box.querySelector('#cnStatus'); if (s2) s2.textContent = msg;
}

function cnPrint() {
  const ctx = cnState.ctx; if (!ctx) return;
  const items = Object.values(cnState.items);
  const html = '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>المشاركات والواجبات</title><style>body{font:14px Tahoma;margin:24px}table{border-collapse:collapse;width:100%;margin-bottom:16px}td,th{border:1px solid #999;padding:5px}.letter{page-break-inside:avoid;border:1px solid #ccc;border-radius:8px;padding:10px;margin:10px 0}pre{white-space:pre-wrap;font:14px Tahoma;margin:0}.sig{margin-top:14px;border-top:1px dashed #999;padding-top:8px}</style></head><body><h1>المشاركات والواجبات — الفصل ' + (ctx.t + 1) + ' — الفترة ' + (ctx.p + 1) + '</h1><table><tr><th>م</th><th>الطالب</th><th>المادة</th><th>النوع</th><th>النتيجة</th></tr>' +
    items.map((x, i) => '<tr><td>' + (i + 1) + '</td><td>' + escapeHtml(x.it.name) + ' — ' + escapeHtml(x.it.section) + '</td><td>' + escapeHtml(x.it.title) + '</td><td>' + (x.type === 'remedial' ? 'خطة علاجية' : 'خطاب شكر') + '</td><td>' + x.it.got + ' / ' + x.it.max + '</td></tr>').join('') + '</table>' +
    items.map(x => '<div class="letter"><pre>' + escapeHtml(x.ta.value) + '</pre><p class="sig">اسم ولي الأمر: ........................ التوقيع: ................ تاريخ الاطلاع: ..../..../........</p></div>').join('') +
    '<script>window.onload=function(){window.print()}<\/script></body></html>';
  const win = window.open('', '_blank'); if (!win) { alert('اسمح بالنوافذ المنبثقة للطباعة.'); return; }
  win.document.write(html); win.document.close();
}

// ============================================================
// المزامنة التلقائية الآمنة
// القاعدة: نقل كامل فقط، ولا يحدث تلقائيًا إلا إذا تغيّر طرف واحد منذ آخر مزامنة:
//   • تغيّر هذا الجهاز والسحابة لم تتغير  ← رفع تلقائي
//   • تغيّرت السحابة وهذا الجهاز لم يتغير ← استقبال تلقائي (بعد نسخة احتياطية داخل المتصفح)
//   • تغيّر الطرفان ← توقف وتنبيه، دون أي كتابة
// ولا يعمل إلا على جهاز أتمّ المزامنة اليدوية الأولى (يحمل علامة حذف اختبارات الإسلامية وبصمة آخر مزامنة).
// ============================================================
const FS_AUTO_KEY = 'quran-fullsync-auto-v2';
const FS_AUTO_DELAY_MS = 15000;
const FS_LOCAL_UI_FIELDS = ['activeSection', 'activeSubject', 'view']; // يحتفظ كل جهاز بما يعرضه عند الاستقبال التلقائي
let fsAutoTimer = null, fsAutoBusy = false, fsAutoAgain = false;

function fsAutoEnabled() { return localStorage.getItem(FS_AUTO_KEY) !== '0'; }

function fsBadge(text, kind) {
  let b = document.getElementById('fsAutoBadge');
  if (!b) {
    b = document.createElement('div'); b.id = 'fsAutoBadge';
    b.className = 'no-print';
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:9998;max-width:min(420px,80vw);padding:7px 12px;border-radius:9px;font:13px Tahoma,Arial;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:pointer;direction:rtl';
    b.title = 'اضغط لفتح مزامنة الأجهزة';
    b.onclick = () => {
      const a = document.querySelector('#mainAreas button[data-area="data"]'); if (a) a.click();
      setTimeout(() => { const t = [...document.querySelectorAll('#tabs button')].find(x => x.textContent.includes('مزامنة')); if (t) t.click(); }, 60);
    };
    document.body.appendChild(b);
  }
  const c = { ok: ['#e9f6ee', '#1f6b3f', '#9fd0b2'], busy: ['#eef4fb', '#24507a', '#a9c4e0'], warn: ['#fff6e0', '#7a5600', '#e6c46a'], err: ['#fdecea', '#b42318', '#f0a49b'] }[kind] || ['#eef4fb', '#24507a', '#a9c4e0'];
  b.style.background = c[0]; b.style.color = c[1]; b.style.border = '1px solid ' + c[2];
  b.textContent = '☁ ' + text;
}

async function fsAutoSession() {
  if (!isSupabaseConfigured()) return false;
  await ensureLibs();
  const { data } = await supa.auth.getSession();
  return !!(data && data.session);
}

async function fsAutoUpload(local, prevFull) {
  const checks = [], check = (ok, label) => { checks.push({ ok: !!ok, label }); return ok; };
  const plan = fsBuildPayload(local, new Date().toISOString());
  if (plan.firstTransfer) throw new Error('هذا الجهاز لم يتم النقل الأول؛ الرفع التلقائي غير مسموح.');
  fsVerifyPayload(local, plan, check);
  const failed = checks.filter(c => !c.ok);
  if (failed.length) throw new Error('فشل فحص سلامة قبل الرفع: ' + failed.map(c => c.label).join('، '));
  const guard = fsUploadGuard(local, prevFull ? prevFull.meta : null);
  if (!guard.ok) throw new Error(guard.text);
  if (guard.same) return 'same';
  // نسخة احتياطية من نسخة السحابة السابقة قبل استبدالها (داخل المتصفح)
  if (prevFull) {
    await fsIdbPut({ id: 'cloud-' + Date.now(), kind: 'cloud-backup', at: new Date().toISOString(), row: prevFull });
    try { const olds = ((await fsIdbAll()) || []).filter(x => x.kind === 'cloud-backup').sort((a, b) => b.at.localeCompare(a.at)); for (const o of olds.slice(5)) await fsIdbDel(o.id); } catch (_) {}
  }
  const meta = fsMakeMeta(plan.payload, local, plan);
  await fsPushPayload(plan.payload, meta, prevFull, null);
  // تأكد أن الجهاز لم يتغير أثناء الرفع؛ وإلا تُرفع التعديلات الأحدث في الدورة التالية
  saveJSON(FS_BASE_KEY, { contentFp: meta.contentFp, fp: meta.fp, at: new Date().toISOString(), kind: 'auto-upload' }); fsSaveBaseContent(plan.payload);
  if (fsFp(fsReadStoredDb()) !== fsFp(local)) fsAutoAgain = true; // عُدّل أثناء الرفع: تُرفع التعديلات الأحدث في الدورة التالية
  return 'uploaded';
}

async function fsAutoReceive(local) {
  const row = await fsFetchRow(FULL_ROW_ID);
  const checks = [], check = (ok, label) => { checks.push({ ok: !!ok, label }); return ok; };
  fsVerifyCloudRow(row, check);
  const failed = checks.filter(c => !c.ok);
  if (failed.length) throw new Error('نسخة السحابة لم تجتز فحص السلامة: ' + failed.map(c => c.label).join('، '));
  const incoming = fsClone(row.db);
  for (const f of FS_LOCAL_UI_FIELDS) if (fsOwn(local, f)) incoming[f] = fsClone(local[f]);
  if (!incoming.sections.includes(incoming.activeSection)) incoming.activeSection = row.db.activeSection;
  if (!fsValidDb(incoming)) { for (const f of FS_LOCAL_UI_FIELDS) incoming[f] = fsClone(row.db[f]); }
  if (fsContentFp(incoming) !== row.meta.contentFp) throw new Error('تعذّر تجهيز النسخة المستقبلة بدقة.');
  // التأكد مرة أخيرة أن هذا الجهاز لم يُعدَّل منذ قرار الاستقبال
  const base = loadJSON(FS_BASE_KEY, null), cur = fsReadStoredDb();
  if (!base || fsContentFp(cur) !== base.contentFp) throw new Error('تغيّر هذا الجهاز أثناء المزامنة؛ أُلغي الاستقبال.');
  const bk = await fsMakeBackup('استقبال تلقائي', null, { silent: true });
  await fsReplaceLocal(incoming, 'auto-receive', bk.id);
  return 'received';
}

async function fsAutoRun(reason) {
  if (!fsAutoEnabled()) return;
  if (fsAutoBusy) { fsAutoAgain = true; return; }
  if (loadJSON(FS_PENDING_KEY, null)) return;
  if (!navigator.onLine) { fsBadge('غير متصل — ستتم المزامنة عند عودة الاتصال', 'warn'); return; }
  fsAutoBusy = true; fsAutoAgain = false;
  try {
    clearTimeout(fsAutoTimer); fsAutoTimer = null;
    if (!(await fsAutoSession())) { fsBadge('سجّل الدخول من «مزامنة الأجهزة» لتعمل المزامنة التلقائية', 'warn'); return; }
    const local = fsReadStoredDb(), base = loadJSON(FS_BASE_KEY, null);
    if (!local || !base || !(local.syncMarks && local.syncMarks.islamicTestsReset)) { fsBadge('المزامنة التلقائية تنتظر مزامنة يدوية أولى على هذا الجهاز', 'warn'); return; }
    if (fsDeepDiff(local, fsClone(window.__app.db), 1).count) { fsBadge('أعد تحميل الصفحة لتكمل المزامنة', 'warn'); return; }
    fsBadge('جارٍ التحقق من السحابة...', 'busy');
    const row = await fsFetchRow(FULL_ROW_ID, 'id,meta,updated_at');
    if (!row || !row.meta) { fsBadge('لا توجد نسخة في السحابة — افتح «مزامنة الأجهزة»', 'err'); return; }
    const lc = fsContentFp(local), cc = row.meta.contentFp;
    const localChanged = lc !== base.contentFp, cloudChanged = cc !== base.contentFp;
    if (lc === cc) {
      if (localChanged || cloudChanged) { saveJSON(FS_BASE_KEY, { contentFp: cc, fp: row.meta.fp, at: new Date().toISOString(), kind: 'match' }); fsSaveBaseContent(local); }
      else fsLoadBaseContent().then(b => { if (!b) fsSaveBaseContent(local); });
      fsBadge('✓ متزامن', 'ok'); return;
    }
    if (localChanged && !cloudChanged) {
      fsBadge('جارٍ رفع التعديلات...', 'busy');
      await fsAutoUpload(local, await fsFetchRow(FULL_ROW_ID));
      fsBadge('✓ رُفعت التعديلات وتطابقت السحابة — ' + new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' }), 'ok');
      return;
    }
    if (!localChanged && cloudChanged) {
      const ae = document.activeElement;
      if (reason === 'interval' && ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) { fsBadge('توجد نسخة أحدث في السحابة — ستُستقبل بعد انتهائك من الكتابة', 'busy'); return; }
      fsBadge('جارٍ استقبال آخر نسخة...', 'busy');
      await fsAutoReceive(local);
      return;
    }
    fsBadge('⚠ تعارض: عُدّل هذا الجهاز وجهاز آخر قبل المزامنة. لم يُكتب شيء — اضغط هنا ثم «عرض الفروق»', 'err');
  } catch (e) {
    fsBadge('توقفت المزامنة التلقائية دون أي تغيير: ' + e.message, 'err');
  } finally {
    fsAutoBusy = false;
    if (fsAutoAgain) { fsAutoAgain = false; fsAutoSchedule(3000); }
  }
}

function fsAutoSchedule(ms) {
  if (!fsAutoEnabled() || loadJSON(FS_PENDING_KEY, null)) return;
  clearTimeout(fsAutoTimer);
  fsAutoTimer = setTimeout(() => fsAutoRun('timer'), ms);
}

function fsAutoStart() {
  // بعد كل حفظ في التطبيق: جدولة رفع بعد ثوانٍ من آخر تعديل
  window.__onSave = () => {
    if (!fsAutoEnabled()) return;
    fsBadge('تعديلات جديدة — ستُرفع تلقائيًا خلال ثوانٍ', 'busy');
    fsAutoSchedule(FS_AUTO_DELAY_MS);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fsAutoSchedule(800);
    else if (fsAutoTimer) fsAutoRun('hidden');
  });
  window.addEventListener('online', () => fsAutoSchedule(1000));
  // فحص خفيف كل دقيقة أثناء فتح التطبيق، حتى يستقبل الجهاز الظاهر ما رُفع من الجهاز الآخر قبل أن تبدأ الرصد عليه
  setInterval(() => { if (document.visibilityState === 'visible' && !fsAutoTimer && !fsAutoBusy) fsAutoRun('interval'); }, 60000);
  window.addEventListener('pagehide', () => { if (fsAutoTimer) fsAutoRun('pagehide'); });
  if (fsAutoEnabled()) fsAutoSchedule(1500);
}

async function fsBoot() {
  await fsPostReloadCheck();
  fsAutoStart();
}
if (window.__app) fsBoot(); else window.addEventListener('app-ready', fsBoot, { once: true });

async function renderParentTab(root) {
  const students=uniqueStudents(), semesterOptions=['الأول','الثاني'].map((n,i)=>`<option value="${i}">${n}</option>`).join('');
  const notice=isParentPortalConfigured()?'':'<div class="summary-card"><b>بوابة ولي الأمر لم تُنشر بعد.</b><p class="muted">سننشر parent.html على رابط HTTPS عام، ثم نضع الرابط في PARENT_PORTAL_URL.</p></div>';
  root.innerHTML=`${notice}<div id="wnHost"></div><div class="summary-card">الفصل الدراسي لبناء تقارير أولياء الأمور:
    <select id="paSem">${semesterOptions}</select><button id="paSyncAll" type="button">مزامنة تقارير أولياء الأمور الآن</button>
    <span id="paBulkStatus" class="muted"></span></div><button id="paLogout" type="button">تسجيل خروج</button>
    <div id="paList" style="overflow-x:auto"></div>`;
  root.querySelector('#paLogout').onclick=async()=>{await supa.auth.signOut();loginBox(root,'parentPortal');};
  root.querySelector('#paSyncAll').onclick=()=>syncReports(root,students);
  wnRender(root.querySelector('#wnHost'));
  qpRender(root.querySelector('#wnHost'));
  cnRender(root.querySelector('#wnHost'));
  vnRender(root.querySelector('#wnHost'));

  let linked=new Set();
  let lastView=new Map();
  try{
    const {data,error}=await supa.from('parent_links').select('student_id');
    if(!error) linked=new Set((data||[]).map(x=>x.student_id));
  }catch(_){}
  try{
    const {data,error}=await supa.from('students_public').select('id,last_parent_view');
    if(!error) for(const r of (data||[])) if(r.last_parent_view) lastView.set(r.id,r.last_parent_view);
  }catch(_){}

  const list=root.querySelector('#paList');
  const table=document.createElement('table');
  table.style.cssText='width:100%;min-width:985px;table-layout:fixed;border-collapse:collapse;margin-top:14px;background:#fff;direction:rtl';
  table.innerHTML=`<thead><tr>
    <th style="padding:10px;border:1px solid #d7e3dd;width:55px">م</th>
    <th style="padding:10px;border:1px solid #d7e3dd;text-align:right;width:280px">اسم الطالب</th>
    <th style="padding:10px;border:1px solid #d7e3dd;width:150px">الشعبة</th>
    <th style="padding:10px;border:1px solid #d7e3dd;width:380px">رمز الربط</th>
    <th style="padding:10px;border:1px solid #d7e3dd;width:120px">الحالة</th>
    <th style="padding:10px;border:1px solid #d7e3dd;width:150px">آخر اطّلاع</th>
  </tr></thead><tbody></tbody>`;
  const tbody=table.querySelector('tbody');

  students.forEach((st,i)=>{
    const tr=document.createElement('tr');
    if(i%2) tr.style.background='#F7FAF8';
    const status=linked.has(st.key)?'تم الربط':'لم يُربط';
    const viewedAt=lastView.get(st.key);
    const viewedText=viewedAt?new Date(viewedAt).toLocaleString('ar-SA'):'—';
    tr.innerHTML=`<td style="padding:9px;border:1px solid #d7e3dd;text-align:center">${i+1}</td>
      <td style="padding:9px;border:1px solid #d7e3dd;font-weight:700">${escapeHtml(st.name)}</td>
      <td style="padding:9px;border:1px solid #d7e3dd;text-align:center">${escapeHtml(st.section)}</td>
      <td style="padding:9px;border:1px solid #d7e3dd;text-align:center">
        <button type="button" class="gen-code">توليد/تجديد رمز الربط</button>
        <div class="code-out" style="margin-top:6px"></div>
      </td>
      <td class="link-status" style="padding:9px;border:1px solid #d7e3dd;text-align:center;font-weight:700">${status}</td>
      <td style="padding:9px;border:1px solid #d7e3dd;text-align:center;font-size:13px">${viewedText}</td>`;
    tr.querySelector('.gen-code').onclick=()=>generateCode(tr,st);
    tbody.appendChild(tr);
    ensureStudentCurrentCode(tr,st,false);
  });
  list.appendChild(table);

  if(window.__parentCodeTimer) clearInterval(window.__parentCodeTimer);
  window.__parentCodeTimer=setInterval(()=>{
    if(!document.getElementById('parentPortalBody')) return;
    const rows=[...tbody.querySelectorAll('tr')];
    students.forEach((st,i)=>{if(rows[i]) ensureStudentCurrentCode(rows[i],st,false);});
  },5*60*1000);
}

function randomLinkCode() {
  // رمز ربط قصير من 8 خانات، بحروف وأرقام واضحة مع تجنب الرموز الملتبسة.
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes=new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let code='';
  for(let i=0;i<8;i++) code+=chars[bytes[i]%chars.length];
  return code;
}


async function latestValidLinkCode(studentId) {
  const nowIso = new Date().toISOString();
  const {data,error}=await supa.from('link_codes')
    .select('code,expires_at')
    .eq('student_id',studentId)
    .gt('expires_at',nowIso)
    .order('expires_at',{ascending:false})
    .limit(1);
  if(error) return {error};
  return {item:(data&&data[0])||null};
}

async function createFreshLinkCode(st) {
  const portalEnabled=window.__app?.db?.studentSupport?.[st.key]?.portalEnabled!==false;
  const {error:upErr}=await supa.from('students_public').upsert({id:st.key,full_name:st.name,portal_enabled:portalEnabled},{onConflict:'id'});
  if(upErr) return {error:upErr};
  const code=randomLinkCode();
  const expiresAt=new Date(Date.now()+LINK_CODE_VALID_HOURS*3600*1000).toISOString();
  const {error}=await supa.from('link_codes').insert({code,student_id:st.key,expires_at:expiresAt});
  if(error) return {error};
  return {item:{code,expires_at:expiresAt}};
}

function showLinkCodeAndQr(codeOut,item) {
  const code=item.code, expiresAt=item.expires_at;
  const link=PARENT_PORTAL_URL+'?code='+encodeURIComponent(code);
  const qrSrc='https://quickchart.io/qr?size=180&margin=2&text='+encodeURIComponent(link);
  const leftMs=Math.max(0,new Date(expiresAt).getTime()-Date.now());
  const leftHours=Math.ceil(leftMs/3600000);
  codeOut.innerHTML=`<div>الرمز: <b>${code}</b> (متبقي نحو ${leftHours} ساعة) — <a href="${link}" target="_blank" rel="noopener">رابط الدخول</a></div>
    <div style="margin:10px auto 3px;text-align:center">
      <img class="student-qr" src="${qrSrc}" alt="QR للطالب" width="180" height="180"
        style="display:block;width:180px;height:180px;margin:auto;background:#fff;padding:7px;border:1px solid #d7e3dd;border-radius:8px"
        onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
      <div style="display:none;color:#b42318;font-size:12px">تعذّر تحميل QR الآن؛ تحقق من اتصال الإنترنت.</div>
    </div>
    <div class="muted" style="font-size:12px">يتجدد الرمز والـ QR تلقائيًا بعد انتهاء مدة الصلاحية.</div>`;
}

async function ensureStudentCurrentCode(row,st,forceNew=false) {
  const codeOut=row.querySelector('.code-out');
  if(!codeOut || !isParentPortalConfigured()) return;
  codeOut.textContent=forceNew?'جارٍ التجديد...':'جارٍ التحقق من الرمز...';

  let item=null;
  if(!forceNew){
    const cur=await latestValidLinkCode(st.key);
    if(cur.error){codeOut.textContent='خطأ: '+cur.error.message;return;}
    item=cur.item;
  }
  if(!item){
    const fresh=await createFreshLinkCode(st);
    if(fresh.error){codeOut.textContent='خطأ: '+fresh.error.message;return;}
    item=fresh.item;
  }
  showLinkCodeAndQr(codeOut,item);
}

async function generateCode(row,st) {
  if(!isParentPortalConfigured()){
    row.querySelector('.code-out').textContent='يجب نشر بوابة ولي الأمر أولًا قبل إنشاء رمز الربط.';
    return;
  }
  await ensureStudentCurrentCode(row,st,true);
}


// ---------- الرسائل الخاصة بين المعلم وأولياء الأمور ----------
function msgTime(v){try{return new Date(v).toLocaleString('ar-SA')}catch(_){return v||''}}
function msgSafe(s){return escapeHtml(String(s||''))}

// ---------- إشعار غياب تلقائي لأولياء الأمور المرتبطين ----------
async function sendTodayAbsenceNotices(status){
  const app=window.__app;
  if(!app){status.textContent='تعذّر الوصول لبيانات التطبيق.';return;}
  const {t,p,w,d}=app.db.actual;
  const students=uniqueStudents();
  const NOTIFIED_KEY='quran-absence-notified-v1';
  let notified={}; try{notified=JSON.parse(localStorage.getItem(NOTIFIED_KEY))||{}}catch(_){}
  const {data:links,error:le}=await supa.from('parent_links').select('student_id,parent_uid');
  if(le){status.textContent='خطأ: '+le.message;return;}
  const byStudent=new Map();
  for(const l of links||[]){ if(!byStudent.has(l.student_id)) byStudent.set(l.student_id,[]); byStudent.get(l.student_id).push(l.parent_uid); }
  let sent=0, skippedNoParent=0, skippedAlready=0, notAbsent=0;
  for(const st of students){
    const qid=app.db.students.find(s=>s.studentUid===st.key&&(s.subject||'quran')==='quran')?.id;
    if(!qid){notAbsent++;continue;}
    const k=app.key(t,p,w,d,qid);
    if(!app.db.absences[k]){notAbsent++;continue;}
    const dedupKey=st.key+'|'+k;
    if(notified[dedupKey]){skippedAlready++;continue;}
    const parents=byStudent.get(st.key)||[];
    if(!parents.length){skippedNoParent++;continue;}
    const body='تنبيه: سُجّل غياب ابنكم/ابنتكم '+st.name+' اليوم في حصة القرآن الكريم.';
    for(const pu of parents){
      await supa.from('parent_messages').insert({student_id:st.key,parent_uid:pu,sender_role:'teacher',body});
    }
    notified[dedupKey]=true; sent++;
  }
  try{localStorage.setItem(NOTIFIED_KEY,JSON.stringify(notified))}catch(_){}
  status.textContent=`أُرسل إشعار لـ ${sent} طالبًا غائبًا اليوم. (${skippedNoParent} بلا ولي أمر مرتبط، ${skippedAlready} أُرسل لهم سابقًا لنفس اليوم)`;
}

// ---------- ملخص أسبوعي تلقائي لكل الطلاب المرتبطين ----------
async function sendWeeklySummaries(status){
  const app=window.__app;
  if(!app){status.textContent='تعذّر الوصول لبيانات التطبيق.';return;}
  const {t,p,w}=app.db.actual;
  const weekTag=[t,p,w].join('-');
  const WEEKLY_KEY='quran-weekly-notified-v1';
  let notified={}; try{notified=JSON.parse(localStorage.getItem(WEEKLY_KEY))||{}}catch(_){}
  const students=uniqueStudents();
  const {data:links,error:le}=await supa.from('parent_links').select('student_id,parent_uid');
  if(le){status.textContent='خطأ: '+le.message;return;}
  const byStudent=new Map();
  for(const l of links||[]){ if(!byStudent.has(l.student_id)) byStudent.set(l.student_id,[]); byStudent.get(l.student_id).push(l.parent_uid); }
  let sent=0, skippedNoParent=0, skippedAlready=0;
  for(const st of students){
    const dedupKey=st.key+'|'+weekTag;
    if(notified[dedupKey]){skippedAlready++;continue;}
    const parents=byStudent.get(st.key)||[];
    if(!parents.length){skippedNoParent++;continue;}
    const qid=app.db.students.find(s=>s.studentUid===st.key&&(s.subject||'quran')==='quran')?.id;
    let scoreLine='';
    if(qid){
      const sum=app.summary(t,p,qid);
      scoreLine=sum.complete?(' نتيجته الحالية في الفترة: '+(sum.finalScore??sum.score??'—')+'.'):' لم تكتمل بيانات الفترة الحالية بعد.';
    }
    const support=app.db.studentSupport?.[st.key];
    const praiseLine=support?.praise?(' ملاحظة المعلم: '+support.praise):'';
    const body='ملخص أسبوعي عن '+st.name+':'+scoreLine+praiseLine;
    for(const pu of parents){
      await supa.from('parent_messages').insert({student_id:st.key,parent_uid:pu,sender_role:'teacher',body});
    }
    notified[dedupKey]=true; sent++;
  }
  try{localStorage.setItem(WEEKLY_KEY,JSON.stringify(notified))}catch(_){}
  status.textContent=`أُرسل ملخص أسبوعي لـ ${sent} طالبًا. (${skippedNoParent} بلا ولي أمر مرتبط، ${skippedAlready} أُرسل لهم سابقًا لهذا الأسبوع)`;
}

async function teacherMessageThreads(){
  const {data:links,error}=await supa.from('parent_links').select('student_id,parent_uid,created_at');
  if(error) return {error};
  const {data:students,error:se}=await supa.from('students_public').select('id,full_name');
  if(se) return {error:se};
  const sm=new Map((students||[]).map(x=>[x.id,x.full_name]));
  const {data:msgs,error:me}=await supa.from('parent_messages').select('*').order('created_at',{ascending:true});
  if(me) return {error:me};
  const grouped=new Map();
  for(const l of links||[]){
    const key=l.student_id+'|'+l.parent_uid;
    grouped.set(key,{student_id:l.student_id,parent_uid:l.parent_uid,name:sm.get(l.student_id)||'طالب',messages:[]});
  }
  for(const m of msgs||[]){
    const key=m.student_id+'|'+m.parent_uid;
    if(!grouped.has(key)) grouped.set(key,{student_id:m.student_id,parent_uid:m.parent_uid,name:sm.get(m.student_id)||'طالب',messages:[]});
    grouped.get(key).messages.push(m);
  }
  return {threads:[...grouped.values()].sort((a,b)=>{
    const at=a.messages.at(-1)?.created_at||'', bt=b.messages.at(-1)?.created_at||'';
    return bt.localeCompare(at)||a.name.localeCompare(b.name,'ar');
  })};
}

async function renderTeacherMessages(root){
  root.innerHTML='<p class="muted">جارٍ تحميل الرسائل...</p>';
  const r=await teacherMessageThreads();
  if(r.error){root.innerHTML='<p class="error">تعذّر جلب الرسائل: '+msgSafe(r.error.message)+'</p>';return;}
  const threads=r.threads||[];
  if(!threads.length){
    root.innerHTML='<div class="summary-card"><b>لا توجد محادثات بعد.</b><p class="muted">تظهر المحادثة هنا بعد ربط ولي الأمر بالطالب. يستطيع ولي الأمر إرسال رسالة من بوابته.</p></div>';
    return;
  }
  const unreadAll=threads.reduce((n,x)=>n+x.messages.filter(m=>m.sender_role==='parent'&&!m.read_at).length,0);
  root.innerHTML=`<div class="summary-card">
    <b>إشعار غياب اليوم</b>
    <p class="muted">يرسل رسالة تلقائية لكل طالب مسجَّل غائبًا اليوم (حسب الموعد الفعلي الحالي) لأولياء أموره المرتبطين فقط. لن يُرسل تكرارًا لنفس الغياب مرتين.</p>
    <button id="sendAbsenceNotices" type="button">إرسال إشعارات الغياب الآن</button>
    <button id="sendWeeklySummaries" type="button">إرسال الملخص الأسبوعي الآن</button>
    <span id="absenceNoticeStatus" class="muted"></span>
  </div>
  <div class="summary-card"><b>المحادثات الخاصة</b>
    <p class="muted">كل محادثة مرتبطة بولي أمر وطالب محددين، ولا تظهر لبقية أولياء الأمور.</p>
    <button id="msgRefresh" type="button">تحديث الرسائل${unreadAll?' — غير مقروءة: '+unreadAll:''}</button>
    <div id="msgThreads"></div></div>`;
  root.querySelector('#sendAbsenceNotices').onclick=()=>sendTodayAbsenceNotices(root.querySelector('#absenceNoticeStatus'));
  root.querySelector('#sendWeeklySummaries').onclick=()=>sendWeeklySummaries(root.querySelector('#absenceNoticeStatus'));
  root.querySelector('#msgRefresh').onclick=()=>renderTeacherMessages(root);
  const host=root.querySelector('#msgThreads');
  for(const th of threads){
    const unread=th.messages.filter(m=>m.sender_role==='parent'&&!m.read_at).length;
    const box=document.createElement('div'); box.className='summary-card';
    box.innerHTML=`<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap">
      <b>${msgSafe(th.name)}</b><span class="muted">${unread?'رسائل غير مقروءة: '+unread:'لا توجد رسائل جديدة'}</span></div>
      <div class="teacher-chat" style="max-height:310px;overflow:auto;padding:8px;background:#f7faf8;border-radius:8px;margin:8px 0"></div>
      <textarea class="teacher-reply" rows="2" placeholder="اكتب ردك هنا..." style="width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid #aac1b4;border-radius:7px"></textarea>
      <button type="button" class="teacher-send">إرسال الرد</button><span class="teacher-status muted"></span>`;
    const chat=box.querySelector('.teacher-chat');
    for(const m of th.messages){
      const mine=m.sender_role==='teacher';
      const bubble=document.createElement('div');
      bubble.style.cssText=`margin:6px 0;padding:8px 10px;border-radius:10px;max-width:82%;${mine?'margin-right:auto;background:#dfeee8':'margin-left:auto;background:#fff;border:1px solid #d6e3dd'}`;
      const receipt=mine?(m.acknowledged_at?' — ✓ أقرّ ولي الأمر'+(m.ack_name?' باسم «'+msgSafe(m.ack_name)+'»':'')+' '+msgTime(m.acknowledged_at):m.read_at?' — ✓ قرأها '+msgTime(m.read_at):' — لم تُقرأ بعد'):'';
      bubble.innerHTML=`<div style="white-space:pre-wrap;line-height:1.8">${msgSafe(m.body)}</div><div class="muted" style="font-size:11px;margin-top:4px">${mine?'المعلم':'ولي الأمر'} — ${msgTime(m.created_at)}${receipt}</div>`;
      chat.appendChild(bubble);
    }
    chat.scrollTop=chat.scrollHeight;
    if(unread){
      const ids=th.messages.filter(m=>m.sender_role==='parent'&&!m.read_at).map(m=>m.id);
      await supa.from('parent_messages').update({read_at:new Date().toISOString()}).in('id',ids);
    }
    box.querySelector('.teacher-send').onclick=async()=>{
      const ta=box.querySelector('.teacher-reply'), status=box.querySelector('.teacher-status'), body=ta.value.trim();
      if(!body){status.textContent='اكتب الرسالة أولًا.';return;}
      status.textContent='جارٍ الإرسال...';
      const {error}=await supa.from('parent_messages').insert({
        student_id:th.student_id,parent_uid:th.parent_uid,sender_role:'teacher',body
      });
      if(error){status.textContent='خطأ: '+error.message;return;}
      ta.value=''; status.textContent='تم الإرسال.'; await renderTeacherMessages(root);
    };
    host.appendChild(box);
  }
  /* منع إعادة رسم المحادثة أثناء الكتابة حتى لا يضيع النص */
  if(window.__teacherMsgTimer){
    clearInterval(window.__teacherMsgTimer);
    window.__teacherMsgTimer=null;
  }
}

async function renderCloudTab(which) {
  const root=document.getElementById(which==='syncDevices'?'syncDevicesBody':which==='parentMessages'?'parentMessagesBody':'parentPortalBody'); if(!root)return;
  if(!isSupabaseConfigured()){root.innerHTML='<p class="muted">لم تُعبَّأ إعدادات Supabase الأساسية بعد.</p>';return;}
  try{
    await ensureLibs();
    const {data}=await supa.auth.getSession();
    if(!data.session)return loginBox(root,which);
    if(which==='syncDevices') return renderSyncTab(root);
    if(which==='parentMessages') return renderTeacherMessages(root);
    return renderParentTab(root);
  }catch(err){root.innerHTML='<p class="muted">تعذّر تحميل القسم: '+escapeHtml(err.message)+'</p>';}
}
window.__cloudRender=renderCloudTab;

// ---------- مراجعة الترحيل لمرة واحدة قبل أول رفع للسحابة ----------
const MIGRATION_REVIEWED_KEY = 'quran-migration-reviewed-v1';
function levenshtein(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j], d[i][j - 1], d[i - 1][j - 1]);
  return d[m][n];
}
function normalizeStudentNameForReview(name) {
  return String(name || '').normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '').replace(/\u0640/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/[ى]/g, 'ي').replace(/\s+/g, '').trim();
}
function findPotentialDuplicates(students) {
  const pairs = [];
  for (let i=0;i<students.length;i++) for (let j=i+1;j<students.length;j++) {
    const a=students[i], b=students[j];
    if (a.section !== b.section || a.key === b.key) continue;
    const na=normalizeStudentNameForReview(a.name), nb=normalizeStudentNameForReview(b.name);
    if (na===nb || levenshtein(na,nb)<=2) pairs.push([a,b]);
  }
  return pairs;
}
function subjectsOf(studentUid) {
  const app = window.__app;
  return ['quran', 'islamic', 'tajweed'].filter(subj =>
    app.db.students.some(s => s.studentUid === studentUid && (s.subject || 'quran') === subj));
}
function canSafelyMergeStudentUids(aUid, bUid) {
  const a = new Set(subjectsOf(aUid)), b = new Set(subjectsOf(bUid));
  return ![...a].some(x => b.has(x));
}
function mergeStudentUids(primaryUid, secondaryUid) {
  const app = window.__app;
  if (!primaryUid || !secondaryUid || primaryUid === secondaryUid) return false;
  if (!canSafelyMergeStudentUids(primaryUid, secondaryUid)) return false;
  let changed = false;
  for (const s of app.db.students) {
    if (s.studentUid === secondaryUid) { s.studentUid = primaryUid; changed = true; }
  }
  if (changed) {
    // لا نغيّر s.id ولا مفاتيح الدرجات؛ التعديل يخص الهوية المشتركة فقط.
    app.save();
    try { localStorage.removeItem(MIGRATION_REVIEWED_KEY); } catch (_) {}
  }
  return changed;
}
function preferredPrimaryUid(a, b) {
  const sa = subjectsOf(a.key), sb = subjectsOf(b.key);
  if (sa.includes('quran') && !sb.includes('quran')) return a.key;
  if (sb.includes('quran') && !sa.includes('quran')) return b.key;
  return a.key;
}
function renderMigrationReview(container, onConfirm) {
  const students = uniqueStudents();
  const dups = findPotentialDuplicates(students);
  const rows = students.map(st => `<tr><td>${escapeHtml(st.name)}</td><td>${escapeHtml(st.section)}</td><td>${subjectsOf(st.key).map(s => ({ quran: 'قرآن', islamic: 'إسلامية', tajweed: 'تجويد' }[s])).join('، ') || '—'}</td></tr>`).join('');
  const dupWarning = dups.length ? `<div class="summary-card" style="border-color:#b42318"><b>تنبيه: توجد أسماء متقاربة في الشعبة نفسها. إذا كان الصفّان للطالب نفسه في مادتين مختلفتين، استخدم زر «دمج كسجل طالب واحد». وإذا كانا لطالبين مختلفين فاتركهما كما هما.</b><div id="paDupList"></div></div>` : '';
  container.innerHTML = `
    <div class="summary-card">
      <b>مراجعة لمرة واحدة قبل رفع أي بيانات للسحابة</b>
      <p class="muted">راجع قائمة الطلاب والمواد المرتبطة بكل طالب. الدمج أدناه يغيّر studentUid الداخلي فقط، ولا يغيّر اسم الطالب أو رقم سجله الداخلي أو أي درجة أو غياب أو اختبار.</p>
      ${dupWarning}
      <div class="scroll"><table><tr><th>الاسم</th><th>الشعبة</th><th>المواد المسجَّلة</th></tr>${rows}</table></div>
      <button id="paMigrationConfirm" type="button">راجعت القائمة، تابع الآن</button>
    </div>`;

  const dupList = container.querySelector('#paDupList');
  if (dupList) {
    for (const [a, b] of dups) {
      const box = document.createElement('div'); box.className = 'summary-card';
      const safe = canSafelyMergeStudentUids(a.key, b.key);
      box.innerHTML = `<b>${escapeHtml(a.name)}</b> (${subjectsOf(a.key).join('، ') || '—'}) ↔ <b>${escapeHtml(b.name)}</b> (${subjectsOf(b.key).join('، ') || '—'})<br><span class="muted">${escapeHtml(a.section)}</span>`;
      if (safe) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.textContent = 'دمج كسجل طالب واحد';
        btn.onclick = () => {
          if (!confirm(`سيتم ربط «${a.name}» و«${b.name}» بهوية طالب واحدة فقط، دون تغيير الدرجات أو سجلات المواد. هل تريد المتابعة؟`)) return;
          const primary = preferredPrimaryUid(a, b), secondary = primary === a.key ? b.key : a.key;
          if (mergeStudentUids(primary, secondary)) renderMigrationReview(container, onConfirm);
        };
        box.appendChild(btn);
      } else {
        const note = document.createElement('p'); note.className = 'muted';
        note.textContent = 'لا يسمح البرنامج بالدمج التلقائي لأن السجلين يحتويان مادة مشتركة؛ راجعهما يدويًا حتى لا يُدمج طالبان مختلفان بالخطأ.';
        box.appendChild(note);
      }
      dupList.appendChild(box);
    }
  }

  container.querySelector('#paMigrationConfirm').onclick = () => {
    try { localStorage.setItem(MIGRATION_REVIEWED_KEY, '1'); } catch (_) {}
    onConfirm();
  };
}

// وضع الفحص: تعطيل مراجعة الترحيل التلقائية؛ قد تغيّر هوية الطلاب عند التأكيد.
// لا تنفّذ هذه النسخة أي عملية رفع أو استقبال لبيانات سجل الدرجات.
