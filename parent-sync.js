// ============================================================
// إعدادات لا بد من تعبئتها قبل الاستخدام (من لوحة تحكم Supabase):
// ============================================================
const SUPABASE_URL = 'https://bobjfngkrepajfsmaihk.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_tlHAjfYiVXXq81ponT7E-g_fniIquBM';
const TEACHER_EMAIL = '9a7er1@gmail.com';            // لتعبئة حقل الدخول تلقائيًا فقط؛ الصلاحية الفعلية مرتبطة بـ UID في schema.sql
const PARENT_PORTAL_URL = 'https://9a7er1-ui.github.io/quran-parent-portal/student.html';
const LINK_CODE_VALID_HOURS = 72; // مدة صلاحية رمز الربط قبل أن ينتهي// ============================================================

const META_KEY = 'quran-sync-meta-v1';   // طوابع زمنية لكل خانة (محلي فقط)
const SNAP_KEY = 'quran-sync-prevsnap-v1'; // آخر نسخة قورنت بها التغييرات (محلي فقط)
const BUCKETS = ['grades', 'absences', 'tests', 'approvals', 'holidays', 'coursework', 'studentSupport', 'rosterOrder'];

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

// ---------- محرك الدمج: خانة بخانة، بعلامة حذف صريحة (Tombstone) لا اعتمادًا على غياب المفتاح ----------
// كل مدخل في meta هو {t: طابع زمني, deleted: هل هذا التغيير حذفًا}. الفائز هو الأحدث زمنيًا؛
// إن كان الفائز "محذوفًا" فلا تُستعاد القيمة أبدًا من الطرف الآخر مهما كانت موجودة عنده.
function mergeBucket(localVal, localMeta, remoteVal, remoteMeta) {
  const keys = new Set([...Object.keys(localMeta || {}), ...Object.keys(remoteMeta || {}),
                         ...Object.keys(localVal || {}), ...Object.keys(remoteVal || {})]);
  const outVal = {}, outMeta = {};
  for (const k of keys) {
    const mL = (localMeta && localMeta[k]) || null, mR = (remoteMeta && remoteMeta[k]) || null;
    const tL = mL ? mL.t : -1, tR = mR ? mR.t : -1;
    if (tL === -1 && tR === -1) {
      // بيانات قديمة قبل تفعيل هذه الميزة على أي الجهازين: لا حذف معروف، أبقِ القيمة إن وُجدت في أي طرف
      if (localVal && k in localVal) outVal[k] = localVal[k];
      else if (remoteVal && k in remoteVal) outVal[k] = remoteVal[k];
      continue;
    }
    const localWins = tL >= tR, winnerMeta = localWins ? mL : mR, winnerVal = localWins ? localVal : remoteVal;
    outMeta[k] = winnerMeta;
    if (!winnerMeta.deleted && winnerVal && (k in winnerVal)) outVal[k] = winnerVal[k];
  }
  return { val: outVal, meta: outMeta };
}

// ---------- تتبع تغييرات db محليًا بعد كل save() ----------
function emptyMeta() { return { grades: {}, absences: {}, tests: {}, approvals: {}, holidays: {}, coursework: {}, studentSupport: {}, rosterOrder: {}, students: {} }; }
function loadJSON(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (_) { return fallback; } }
function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }

function snapshotOf(db) {
  const studentsById = {}, rosterOrder = {};
  for (const s of db.students) {
    studentsById[s.id] = s;
    if (s.studentUid && (s.subject || 'quran') === 'quran') {
      rosterOrder[s.studentUid] = { section: s.section || (db.sections && db.sections[0]) || '', order: Number.isFinite(Number(s.rosterOrder)) ? Number(s.rosterOrder) : 999999 };
    }
  }
  return { grades: db.grades, absences: db.absences, tests: db.tests, approvals: db.approvals, holidays: db.holidays, coursework: db.coursework, studentSupport: db.studentSupport || {}, rosterOrder, students: studentsById };
}

function trackChange(db) {
  const meta = loadJSON(META_KEY, emptyMeta());
  for (const b of [...BUCKETS, 'students']) if (!meta[b]) meta[b] = {};
  const prev = loadJSON(SNAP_KEY, null);
  const cur = snapshotOf(db);
  const now = Date.now();
  for (const b of BUCKETS) {
    const curB = cur[b] || {}, prevB = (prev && prev[b]) || {};
    for (const k of new Set([...Object.keys(curB), ...Object.keys(prevB)])) {
      if (JSON.stringify(curB[k]) !== JSON.stringify(prevB[k])) meta[b][k] = { t: now, deleted: !(k in curB) };
    }
  }
  const curS = cur.students, prevS = (prev && prev.students) || {};
  for (const id of new Set([...Object.keys(curS), ...Object.keys(prevS)])) {
    if (JSON.stringify(curS[id]) !== JSON.stringify(prevS[id])) meta.students[id] = { t: now, deleted: !(id in curS) };
  }
  saveJSON(META_KEY, meta);
  saveJSON(SNAP_KEY, cur);
}
window.__onSave = trackChange;

// ---------- تطبيق ناتج الدمج مرة أخرى داخل db الحيّة وإعادة الرسم ----------
function applyMergedIntoApp(mergedVal, mergedMeta) {
  const app = window.__app, db = app.db;
  for (const b of BUCKETS) if (b !== 'rosterOrder') db[b] = mergedVal[b] || {};
  const studentsArr = Object.values(mergedVal.students || {});
  db.students = studentsArr;
  const orderMap = mergedVal.rosterOrder || {};
  for (const st of db.students) {
    const rec = st.studentUid ? orderMap[st.studentUid] : null;
    if (rec && rec.section === (st.section || (db.sections && db.sections[0]) || '')) st.rosterOrder = rec.order;
  }
  // مهم: واجهات التطبيق تعتمد أيضًا على ترتيب db.students نفسه، لا على rosterOrder وحده.
  // لذلك نعيد ترتيب المصفوفة فعليًا بعد الدمج، مع إبقاء نسخ الطالب في مواده متجاورة
  // وبالترتيب المعتمد نفسه داخل كل شعبة.
  const subjectRank = { quran: 0, islamic: 1, tajweed: 2, life: 3, lifeskills: 3, 'life-skills': 3 };
  db.students.sort((a, b) => {
    const secA = a.section || (db.sections && db.sections[0]) || '';
    const secB = b.section || (db.sections && db.sections[0]) || '';
    if (secA !== secB) return String(secA).localeCompare(String(secB), 'ar');
    const ra = a.studentUid && orderMap[a.studentUid] && orderMap[a.studentUid].section === secA ? Number(orderMap[a.studentUid].order) : Number(a.rosterOrder);
    const rb = b.studentUid && orderMap[b.studentUid] && orderMap[b.studentUid].section === secB ? Number(orderMap[b.studentUid].order) : Number(b.rosterOrder);
    const oa = Number.isFinite(ra) ? ra : 999999;
    const ob = Number.isFinite(rb) ? rb : 999999;
    if (oa !== ob) return oa - ob;
    if ((a.studentUid || '') !== (b.studentUid || '')) return String(a.name || '').localeCompare(String(b.name || ''), 'ar');
    return (subjectRank[a.subject || 'quran'] ?? 99) - (subjectRank[b.subject || 'quran'] ?? 99);
  });
  app.save();
  saveJSON(META_KEY, mergedMeta);
  saveJSON(SNAP_KEY, snapshotOf(db));
  app.render();
}

// ---------- المزامنة الثنائية الاتجاه بين الأجهزة (المعلم فقط) ----------
// ---------- أداة إنقاذ: فرض رفع بيانات هذا الجهاز بالكامل، متجاوزةً الدمج تمامًا ----------
// تُستخدم فقط عند التأكد أن بيانات هذا الجهاز صحيحة وأن السحابة تحمل نسخة خاطئة/قديمة.
async function forceUploadLocal(statusEl) {
  if (!confirm('سيتم استبدال كل ما في السحابة ببيانات هذا الجهاز فقط، دون أي دمج مع أي جهاز آخر. تأكد أن بيانات هذا الجهاز هي الصحيحة فعلاً. متابعة؟')) return;
  statusEl.textContent = 'جارٍ التجهيز...';
  const db = window.__app.db;
  const stamp = Date.now();
  const snap = snapshotOf(db);
  const forcedMeta = emptyMeta();
  for (const b of BUCKETS) for (const k of Object.keys(snap[b] || {})) forcedMeta[b][k] = { t: stamp, deleted: false };
  for (const k of Object.keys(snap.students || {})) forcedMeta.students[k] = { t: stamp, deleted: false };
  statusEl.textContent = 'جارٍ الرفع القسري...';
  const { error } = await supa.from('gradebook_state').upsert({ id: 'main', db: snap, meta: forcedMeta, updated_at: new Date().toISOString() });
  if (error) { statusEl.textContent = 'خطأ في الرفع: ' + error.message; return; }
  saveJSON(META_KEY, forcedMeta);
  saveJSON(SNAP_KEY, snap);
  statusEl.textContent = 'تم فرض رفع بيانات هذا الجهاز بنجاح. زامن بقية الأجهزة الآن لتحديثها.';
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_, reject) => {
      timer=setTimeout(()=>reject(new Error(label+' تجاوز المهلة المحددة. تحقق من الاتصال ثم أعد المحاولة.')),ms);
    })]);
  } finally { if(timer) clearTimeout(timer); }
}
async function syncDevices(statusEl) {
  const button=document.getElementById('paSyncDevices');
  if(button) button.disabled=true;
  try {
    statusEl.textContent='جارٍ جلب حالة الخادم...'; saveSyncStatus(statusEl.textContent,'working');
    const db=window.__app.db;
    const hadPreviousSnapshot=!!loadJSON(SNAP_KEY,null);
    if(hadPreviousSnapshot) trackChange(db);
    let localMeta=loadJSON(META_KEY,emptyMeta());
    for(const b of [...BUCKETS,'students']) if(!localMeta[b]) localMeta[b]={};
    const localSnap=snapshotOf(db);

    const fetchResult=await withTimeout(supa.from('gradebook_state').select('*').eq('id','main').maybeSingle(),20000,'جلب بيانات المزامنة');
    const {data,error}=fetchResult||{};
    if(error) throw new Error('خطأ في الجلب: '+error.message);
    const remoteSnap=(data&&data.db)||{};
    const remoteMeta=(data&&data.meta)||emptyMeta();
    for(const b of [...BUCKETS,'students']) if(!remoteMeta[b]) remoteMeta[b]={};

    const remoteHasData=[...BUCKETS,'students'].some(b=>remoteSnap[b]&&Object.keys(remoteSnap[b]).length);
    if(!hadPreviousSnapshot&&!remoteHasData){
      const seeded=emptyMeta(),stamp=Date.now();
      for(const b of BUCKETS) for(const k of Object.keys(localSnap[b]||{})) seeded[b][k]={t:stamp,deleted:false};
      for(const k of Object.keys(localSnap.students||{})) seeded.students[k]={t:stamp,deleted:false};
      localMeta=seeded; saveJSON(META_KEY,localMeta);
    }

    const mergedVal={},mergedMeta={};
    for(const b of [...BUCKETS,'students']){
      const r=mergeBucket(localSnap[b],localMeta[b],remoteSnap[b],remoteMeta[b]);
      mergedVal[b]=r.val; mergedMeta[b]=r.meta;
    }

    statusEl.textContent='جارٍ رفع النتيجة المدمجة...'; saveSyncStatus(statusEl.textContent,'working');
    const upResult=await withTimeout(
      supa.from('gradebook_state').upsert({id:'main',db:mergedVal,meta:mergedMeta,updated_at:new Date().toISOString()}).select('id,updated_at').maybeSingle(),
      20000,'رفع بيانات المزامنة'
    );
    const {data:savedRow,error:upErr}=upResult||{};
    if(upErr) throw new Error('خطأ في الرفع: '+upErr.message);
    if(!savedRow||savedRow.id!=='main') throw new Error('لم يؤكد الخادم حفظ سجل المزامنة.');

    statusEl.textContent='جارٍ التحقق من البيانات المحفوظة...'; saveSyncStatus(statusEl.textContent,'working');
    const verifyResult=await withTimeout(supa.from('gradebook_state').select('id,updated_at').eq('id','main').maybeSingle(),15000,'التحقق من حفظ المزامنة');
    const {data:verified,error:verifyErr}=verifyResult||{};
    if(verifyErr) throw new Error('خطأ في التحقق: '+verifyErr.message);
    if(!verified||verified.id!=='main') throw new Error('لم يمكن التحقق من حفظ بيانات المزامنة في السحابة.');

    const successRec=saveSyncStatus('تمت المزامنة بنجاح بين الأجهزة.','success');
    statusEl.textContent=successRec.message;
    applyMergedIntoApp(mergedVal,mergedMeta);
    setTimeout(async()=>{
      try{
        if(document.getElementById('syncDevicesBody')) await renderCloudTab('syncDevices');
      }catch(_){}
      const current=document.getElementById('paSyncStatus');
      if(current) paintSyncStatus(current,successRec);
    },0);
  } catch(err) {
    console.error('Device sync failed:',err);
    const failRec=saveSyncStatus('تعذرت المزامنة: '+(err&&err.message?err.message:String(err)),'error');
    statusEl.textContent=failRec.message;
  } finally { if(button) button.disabled=false; }
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
const SYNC_STATUS_KEY='quran-device-sync-status-v1';
function saveSyncStatus(message, kind='info'){
  const rec={message:String(message||''),kind,at:new Date().toISOString()};
  try{localStorage.setItem(SYNC_STATUS_KEY,JSON.stringify(rec));}catch(_){}
  return rec;
}
function loadSyncStatus(){
  try{return JSON.parse(localStorage.getItem(SYNC_STATUS_KEY)||'null');}catch(_){return null;}
}
function paintSyncStatus(el,rec){
  if(!el||!rec)return;
  const when=rec.at?new Date(rec.at).toLocaleString('ar-SA'):'';
  el.textContent=rec.message+(when?' — '+when:'');
  el.style.display='inline-block';
  el.style.marginInlineStart='8px';
  el.style.fontWeight='700';
  el.style.border='1px solid #cbd8d2';
  el.style.background=rec.kind==='success'?'#eef8f2':rec.kind==='error'?'#fff2f2':'#f7f8f7';
}
async function adoptThisDeviceRosterOrder(statusEl){
  try{
    const app=window.__app, counters={};
    // نعتمد ترتيب القائمة الظاهر فعليًا في هذا الجهاز، لا قيمة قديمة محفوظة في rosterOrder.
    for(const st of app.db.students){
      if((st.subject || 'quran') !== 'quran' || !st.studentUid) continue;
      const sec=st.section || (app.db.sections && app.db.sections[0]) || '';
      const n=counters[sec] || 0;
      st.rosterOrder=n;
      counters[sec]=n+1;
      // نفس ترتيب الطالب لجميع نسخه في المواد.
      for(const copy of app.db.students){
        if(copy.studentUid===st.studentUid && (copy.section || (app.db.sections && app.db.sections[0]) || '')===sec) copy.rosterOrder=n;
      }
    }
    const snap=snapshotOf(app.db);
    const meta=loadJSON(META_KEY,emptyMeta());
    if(!meta.rosterOrder) meta.rosterOrder={};
    const stamp=Date.now();
    for(const uid of Object.keys(snap.rosterOrder||{})) meta.rosterOrder[uid]={t:stamp,deleted:false};
    saveJSON(META_KEY,meta);
    saveJSON(SNAP_KEY,snap);
    app.save();
    const rec=saveSyncStatus('تم اعتماد ترتيب الطلاب الظاهر في هذا الجهاز. جارٍ رفعه للسحابة...','working');
    statusEl.textContent=rec.message;
    await syncDevices(statusEl);
  }catch(err){
    const rec=saveSyncStatus('تعذر اعتماد ترتيب هذا الجهاز: '+(err&&err.message?err.message:String(err)),'error');
    statusEl.textContent=rec.message;
  }
}
async function renderSyncTab(root) {
  const last=loadSyncStatus();
  root.innerHTML=`
    <div class="card">
      <h3>مزامنة الدرجات بين هذا الجهاز والسحابة والأجهزة الأخرى</h3>
      <p class="muted">تُدمج التغييرات خانة بخانة عبر Supabase.</p>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button id="paSyncDevices" class="btn primary">مزامنة الأجهزة الآن</button>
        <button id="paAdoptRosterOrder" class="btn">اعتماد ترتيب هذا الجهاز</button>
        <span id="paSyncStatus" role="status" aria-live="polite"
          style="display:inline-block;min-height:24px;padding:5px 8px;border-radius:8px"></span>
      </div>
      <div id="paSyncLast" class="muted" style="margin-top:8px"></div>
      <details style="margin-top:14px">
        <summary>أداة الطوارئ</summary>
        <p class="muted">لا تستخدمها إلا عند التأكد أن بيانات هذا الجهاز هي النسخة الصحيحة التي تريد استبدال السحابة بها.</p>
        <button id="paForceUpload" class="btn">فرض رفع بيانات هذا الجهاز</button>
      </details>
    </div>`;
  const syncStatus=root.querySelector('#paSyncStatus');
  const lastBox=root.querySelector('#paSyncLast');
  if(last){
    paintSyncStatus(syncStatus,last);
    if(last.at) lastBox.textContent='آخر حالة محفوظة: '+new Date(last.at).toLocaleString('ar-SA');
  }else{
    syncStatus.textContent='جاهز للمزامنة.';
  }
  root.querySelector('#paSyncDevices').onclick=()=>syncDevices(syncStatus);
  root.querySelector('#paAdoptRosterOrder').onclick=()=>adoptThisDeviceRosterOrder(syncStatus);
  root.querySelector('#paForceUpload').onclick=()=>forceUploadLocal(syncStatus);
}
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

async function init() {
  let reviewed=false;try{reviewed=localStorage.getItem(MIGRATION_REVIEWED_KEY)==='1';}catch(_){}
  if(!reviewed){const root=document.getElementById('syncDevicesBody');if(root)renderMigrationReview(root,()=>renderCloudTab('syncDevices'));}
}
if(window.__app)init();else window.addEventListener('app-ready',init,{once:true});
