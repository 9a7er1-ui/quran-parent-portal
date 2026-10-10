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

const fsSim = { up: null, down: null, restore: null };

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
  studentSupport: 'متابعة الطلاب', syncMarks: 'علامات المزامنة'
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
    if (pend.kind !== 'restore') saveJSON(FS_BASE_KEY, { contentFp: pend.contentFp, fp: pend.expectedFp, at: new Date().toISOString(), kind: pend.kind });
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
    saveJSON(FS_BASE_KEY, { contentFp: meta.contentFp, fp, at: new Date().toISOString(), kind: 'upload' });
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
    if (allOk && guard && guard.same && !loadJSON(FS_BASE_KEY, null)) saveJSON(FS_BASE_KEY, { contentFp: row.meta.contentFp, fp: row.meta.fp, at: new Date().toISOString(), kind: 'match' });
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
  saveJSON(FS_BASE_KEY, { contentFp: meta.contentFp, fp: meta.fp, at: new Date().toISOString(), kind: 'auto-upload' });
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
      if (localChanged || cloudChanged) saveJSON(FS_BASE_KEY, { contentFp: cc, fp: row.meta.fp, at: new Date().toISOString(), kind: 'match' });
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
    fsBadge('⚠ تعارض: عُدّل هذا الجهاز وجهاز آخر قبل المزامنة. لم يُكتب شيء — افتح «مزامنة الأجهزة»', 'err');
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
  root.innerHTML=`${notice}<div class="summary-card">الفصل الدراسي لبناء تقارير أولياء الأمور:
    <select id="paSem">${semesterOptions}</select><button id="paSyncAll" type="button">مزامنة تقارير أولياء الأمور الآن</button>
    <span id="paBulkStatus" class="muted"></span></div><button id="paLogout" type="button">تسجيل خروج</button>
    <div id="paList" style="overflow-x:auto"></div>`;
  root.querySelector('#paLogout').onclick=async()=>{await supa.auth.signOut();loginBox(root,'parentPortal');};
  root.querySelector('#paSyncAll').onclick=()=>syncReports(root,students);

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
      bubble.innerHTML=`<div>${msgSafe(m.body)}</div><div class="muted" style="font-size:11px;margin-top:4px">${mine?'المعلم':'ولي الأمر'} — ${msgTime(m.created_at)}</div>`;
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
