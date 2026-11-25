// סקר מלונות: the admin page for surveying hotels.
// Calls are recorded on the work phone; while "survey mode" is on, the Google script reads them with Gemini
// and fills the hotels here. Every hotel keeps its whole history: calls (summary, key sentences with their
// time, the full transcript, the recording), e-mails sent and the replies, and notes, all searchable.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const photoSrc = u => /^media\/uploads\//.test(u) ? '/' + u : safeUrl(u);   // my photos (storage) or ones from the hotel's site
const siteName = u => String(u || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
const rateTxt = x => x.ratingScale === 10 ? `${x.rating}/10` : `${x.rating} ★`;
const safeUrl = u => (/^https:\/\//i.test(String(u || '')) ? u : '');   // links from the robot / replies: https only
const h = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const dmy = iso => (iso || '').slice(0, 10).split('-').reverse().join('.');
const when = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' }) + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); };
const ago = iso => { if (!iso) return 'אף פעם'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 2 ? 'עכשיו' : m < 60 ? `לפני ${m} דקות` : m < 1440 ? `לפני ${Math.round(m / 60)} שעות` : `לפני ${Math.round(m / 1440)} ימים`; };
const money = (n, c = 'ILS') => n == null || n === '' ? '' : Number(n).toLocaleString('he-IL') + ' ' + ({ ILS: '₪', EUR: '€', USD: '$' }[c] || '₪');

const AV = { unknown: ['לא ידוע', 'gray'], available: ['יש מקום', 'ok'], partial: ['מקום חלקי', 'warn'], full: ['תפוס', 'no'] };
const ST = { new: 'חדש', followup: 'לחזור אליהם', waiting: 'מחכים להצעה', good: 'מתאים', closed: 'נסגר', no: 'לא רלוונטי' };
const BOARDS = ['לינה וארוחת בוקר', 'חצי פנסיון', 'פנסיון מלא', 'הכול כלול'];

let ctx = null;               // { toast, showLogin, rerender }
let home = null;              // GET /api/hotels
let cur = null;               // { survey, hotels } of the open survey
let openSurvey = null, openHotel = null, query = '', filter = 'all', sortBy = 'price';
let busy = false;

async function api(method, qs = '', body) {
  const r = await fetch('/api/hotels' + qs, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { ctx.toast('פג תוקף הכניסה. היכנסו שוב', 'err'); ctx.showLogin(); throw new Error('login'); }
  if (r.status === 503) throw new Error('not-configured');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}
const fail = e => { if (e.message !== 'login') ctx.toast(e.message === 'not-configured' ? 'מסד הנתונים (Redis) עוד לא מחובר לאתר' : 'משהו השתבש. נסו שוב', 'err'); };

/** Open one hotel card (from the hotels catalog, owner 22.11). */
export function showHotel(surveyId, hotelId) { openSurvey = surveyId; openHotel = hotelId; cur = null; look = { text: '', results: null, open: null }; }
export async function hotelsPage(pg, c) {
  ctx = c;
  if (!home) {
    pg.append(h('<p class="hint">טוען…</p>'));
    try { home = await api('GET'); pushWindows(); } catch (e) { pg.innerHTML = ''; if (e.message === 'not-configured') pg.append(notReady()); else fail(e); return; }
    pg.innerHTML = '';
  }
  if (openSurvey && (!cur || cur.survey.id !== openSurvey)) {
    pg.append(h('<p class="hint">טוען את הסקר…</p>'));
    try { cur = await api('GET', '?survey=' + encodeURIComponent(openSurvey)); } catch (e) { openSurvey = null; cur = null; fail(e); }
    pg.innerHTML = '';
  }
  pg.append(modeBar());
  if (openSurvey && cur) surveyView(pg); else { pg.append(lookupCard()); homeView(pg); }
  lastSeen = lastSeen || home.connection?.last || null; startPolling();
  // owner 22.11: no window pops up by itself any more; the "חיבור למערכת" card on the page opens it
}
const again = () => ctx.rerender();
async function refreshHome() { home = await api('GET'); pushWindows(); reportPhone(); }
/** Inside the phone app (owner 25.11): tell the site what the phone has done, so a stuck phone shows on the computer too. */
function reportPhone() {
  try {
    if (!window.LBVApp?.phone) return;
    const p = JSON.parse(window.LBVApp.phone() || '{}');
    if (!p.version) return;
    fetch('/api/hotels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'phonestat', p }) }).catch(() => {});
  } catch (e) {}
}
/** Inside the phone app: tell it when check mode was on, so only those calls go up by themselves. */
function pushWindows() {
  try {
    if (!window.LBVApp?.setWindows || !home) return;
    const w = (home.windows || []).map(x => ({ from: Date.parse(x.from) || 0, to: x.to ? Date.parse(x.to) || 0 : 0 })).filter(x => x.from);
    window.LBVApp.setWindows(JSON.stringify(w));
    if (window.LBVApp.setWa) window.LBVApp.setWa(JSON.stringify(home.wa || []));
    if (window.LBVApp.setWatch) window.LBVApp.setWatch(JSON.stringify((home.watch || []).map(x => ({ phone: x.phone, from: Date.parse(x.from) || 0, to: Date.parse(x.to) || 0 }))));
  } catch (e) {}
}
/** Inside the phone app: calls on this phone with that number / contact, and whether each has a recording. */
function phoneFind(q) {
  try { return window.LBVApp?.findCalls ? JSON.parse(window.LBVApp.findCalls(String(q || '')) || '[]') : null; } catch (e) { return null; }
}
/** "יש הקלטות בטלפון": a box with the calls found and one button that brings their recordings. */
function phoneRecsBox(q, list, intro) {
  const recs = list.filter(x => x.rec), todo = recs.filter(x => !x.sent);
  const box = h(`<div class="hs-ans hs-ans--phone hs-prec">
    <p class="hs-ans__q">${intro}</p>
    <ul class="hs-prec__l">${list.slice(0, 12).map((x, i) => { const can = x.rec && !x.sent; return `<li>${can ? `<label class="hs-prec__c"><input type="checkbox" data-k="${i}" ${todo.length <= 2 || todo[0] === x ? 'checked' : ''}>` : '<span class="hs-prec__c">'}<span><b><bdi>${esc(x.name || x.number)}</bdi></b> · ${relDay(x.at)} (${when(x.at)}) · ${Math.max(1, Math.round(x.dur / 60))} דק' · ${x.rec ? (x.sent ? 'ההקלטה כבר במערכת' : 'יש הקלטה בטלפון') : 'בלי הקלטה'}</span>${can ? '</label>' : '</span>'}</li>`; }).join('')}</ul>
    <div class="row-tools hs-ans__yn"></div></div>`);
  const yn = $('.hs-ans__yn', box);
  if (todo.length) {
    const shown = list.slice(0, 12);
    const picked = () => [...box.querySelectorAll('input[data-k]:checked')].map(i => shown[+i.dataset.k]);
    const go = h('<button class="btn btn--gold btn--sm" type="button"></button>');
    const label = () => { const n = picked().length; go.textContent = n ? (n === 1 ? 'להביא את השיחה שבחרתי' : `להביא את ${n} השיחות שבחרתי`) : 'בוחרים שיחה'; go.disabled = !n; };
    box.addEventListener('change', label); label();
    go.addEventListener('click', async () => {
      const sel = picked(); if (!sel.length) return;
      window.LBVApp.fetchCalls(JSON.stringify(sel.map(x => x.key)));
      const question = (look.q || '').trim();
      if (question) { try { await api('POST', '', { op: 'askLater', phone: sel[0].number || q, at: sel.map(x => x.at), q: question }); } catch (e) {} }
      yn.innerHTML = question ? `<p class="hs-wait">השיחות עולות עכשיו מהטלפון. בעוד כ-5 עד 10 דקות אחפש בהן "${esc(question)}" ואראה כאן מה נאמר.</p>` : '<p class="hs-wait">השיחות עולות עכשיו מהטלפון. בעוד כ-5 דקות הן יופיעו כאן, ואז אפשר לבקש סיכום.</p>';
    });
    yn.append(go);
  }
  return box;
}
async function refreshSurvey() { cur = await api('GET', '?survey=' + encodeURIComponent(openSurvey)); }

function notReady() {
  return h(`<section class="card"><h2>בדיקת מלונות ואולמות</h2><p class="hint hint--box">כדי שהסקר יעבוד צריך שמסד הנתונים של האתר (Upstash Redis, אותו אחד של הסטטיסטיקה) יהיה מחובר בפרויקט ב-Vercel.</p></section>`);
}

/* ---------- survey mode: the big switch (made for the phone) ---------- */
function modeBar() {
  const m = home.mode || {}, con = home.connection || {};
  const sv = home.surveys.find(s => s.id === m.surveyId);
  const el = h(`<section class="hs-mode ${m.on ? 'is-on' : ''}">
    <div class="hs-mode__txt">
      <b>${m.on ? 'מצב בדיקה פעיל' : 'מצב בדיקה כבוי'}</b>
      <span>${m.on ? (home.surveys.filter(x => x.manage && (!(x.to || x.from) || (x.to || x.from) >= new Date(Date.now() - 864e5).toISOString().slice(0, 10))).length > 1 ? `כל שיחה נכנסת לאירוע שמדברים עליו בה. כשלא ברור, היא מחכה באזור ההמתנה · מאז ${when(m.since)}` : `כל שיחה מעכשיו נכנסת ל<b>${esc(sv?.title || 'סקר')}</b> · מאז ${when(m.since)}`) : 'שיחות לא נקראות. מדליקים לפני שמתחילים להתקשר למלונות.'}</span>
    </div>
    <div class="hs-mode__act">
      ${m.on ? '' : `<select class="hs-sel" aria-label="לאיזו כרטיסייה">${home.surveys.map(s => `<option value="${s.id}" ${s.id === (openSurvey || home.surveys[0]?.id) ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select>`}
      <button type="button" class="hs-switch" role="switch" aria-checked="${!!m.on}"><span></span>${m.on ? 'לכבות' : 'להדליק'}</button>
    </div>
    <p class="hs-mode__con">${con.connected ? `${con.ping && Date.now() - Date.parse(con.ping) < 20 * 60e3 ? '' : '<i class="dot warn"></i>'}החיבור לטלפון: בדיקה אחרונה ${ago(con.ping)}${con.last ? ` · שיחה אחרונה נקלטה ${ago(con.last)}` : ''}${con.skipped ? ` · ${con.skipped} שיחות לא קשורות דולגו` : ''}` : '<i class="dot no"></i>הטלפון עוד לא מחובר. <a href="#" data-connect>לשלבי החיבור</a>'}</p>
  </section>`);
  $('.hs-switch', el).addEventListener('click', async () => {
    if (!m.on && !home.surveys.length) return ctx.toast('קודם פותחים כרטיסייה', 'info');
    try {
      const r = await api('POST', '', { op: 'mode', on: !m.on, surveyId: m.on ? undefined : $('.hs-sel', el)?.value });
      home.mode = r.mode; refreshHome().catch(() => {}); ctx.toast(r.mode.on ? 'מצב בדיקה הודלק. אפשר להתחיל להתקשר' : 'מצב בדיקה כובה'); again();
    } catch (e) { fail(e); }
  });
  $('[data-connect]', el)?.addEventListener('click', e => { e.preventDefault(); openWizard(Math.max(0, stepsState().findIndex(x => !x.done))); });
  const ph = phonePanel(m, con);
  if (ph) el.append(ph);
  return el;
}

/* ---------- inside the LBV phone app: what this phone has and hasn't done, so a stuck step is visible ---------- */
function phonePanel(m, con) {
  if (!window.LBVApp?.phone) return null;
  let p = {};
  try { p = JSON.parse(window.LBVApp.phone() || '{}'); } catch (e) { p = {}; }
  if (!p.version) return null;
  const rows = [
    [con.connected, 'הרובוט של גוגל מחובר', 'הרובוט של גוגל עוד לא מחובר'],
    [p.paired, 'הטלפון מחובר לרובוט', con.app ? 'הטלפון עוד לא מחובר לרובוט. לוחצים "לחבר את הטלפון"' : 'הרובוט עוד לא פתוח לטלפון. זה צעד חד-פעמי בחשבון הגוגל, לא בטלפון'],
    [!!p.folder, `תיקיית ההקלטות: ${esc(p.folder)}`, 'לא נבחרה תיקיית ההקלטות'],
    [p.callLog, 'יש גישה ליומן השיחות', 'אין גישה ליומן השיחות'],
    [p.battery, 'האפליקציה רצה ברקע', 'הטלפון עלול לעצור את האפליקציה ברקע'],
    [!!m.on, 'מצב בדיקה דולק', 'מצב בדיקה כבוי: שיחות לא נקראות'],
    ...(p.wa !== undefined ? [[p.wa, 'הודעות וואטסאפ ממלונות נקלטות לבד', 'הודעות וואטסאפ ממלונות עוד לא נקלטות. לוחצים "לאשר וואטסאפ" ומדליקים את LBV']] : []),
    // what the phone found in the folder (from 1.11): how many, the newest, how many wait for Wi-Fi
    ...(p.found >= 0 && p.lastSync ? [[p.found > 0, `בתיקייה יש ${p.found} הקלטות מחצי השנה האחרונה${p.newest ? ` · האחרונה ${ago(new Date(p.newest).toISOString())}` : ''}`, 'בתיקייה שנבחרה אין הקלטות מחצי השנה האחרונה. כנראה זו לא התיקייה של הקלטות השיחות']] : []),
    ...(p.waiting > 0 ? [[false, '', `${p.waiting} הקלטות ישנות מחכות ל-Wi-Fi. "לשלוח הכול עכשיו" שולח גם בלי Wi-Fi`]] : []),
    // from 1.14 only calls made while check mode is on go up by themselves, or the ones asked for by number
    [p.sent > 0 || (!!p.lastSync && !p.err), p.sent > 0 ? `נשלחו מהטלפון ${p.sent} הקלטות. עולות לבד רק שיחות שנעשו כשמצב בדיקה דלוק` : 'עולות לבד רק שיחות שנעשו כשמצב בדיקה דלוק. הקלטות ישנות מביאים לפי מספר, בחיפוש למטה', p.lastSync ? 'השליחה מהטלפון נתקעה. רואים את התקלה למטה' : p.paired ? 'הטלפון עוד לא בדק הקלטות' : 'הבדיקה תתחיל לבד מיד אחרי החיבור לרובוט'],
  ];
  const needFix = !p.folder || !p.callLog || !p.battery || !p.notify;
  // The robot of the LBV Google account belongs to the owner. Logged in as someone else, the phone has no robot to join.
  const meNow = home.me || {}, other = !p.paired && !con.app && meNow.id && meNow.id !== 'owner';
  const el = h(`<div class="hs-phone">
    <b class="hs-phone__t">מצב הטלפון</b>
    ${other ? `<p class="hs-phone__who">באפליקציה נכנסת בתור <b>${esc(meNow.name || '')}</b>. הרובוט של LBV מחובר לחשבון של הבעלים, ולכן הטלפון לא מתחבר. יוצאים ונכנסים עם שם המשתמש של הבעלים והסיסמה הראשית.</p><button type="button" class="btn btn--gold btn--sm" data-switch>לצאת ולהיכנס כבעלים</button>` : ''}
    ${rows.some(r => !r[0]) ? `<ul>${rows.filter(r => !r[0] && r[2]).map(([ok, yes, no]) => `<li class="is-no"><i class="dot no"></i>${no}</li>`).join('')}</ul>` : '<p class="hs-phone__ok">הכול מחובר ועובד.</p>'}
    <details class="hs-phone__more"><summary>פרטים</summary><ul>${rows.filter(r => r[0]).map(([ok, yes]) => `<li>${yes}</li>`).join('')}</ul></details>
    <small>${p.lastSync ? `בדיקה אחרונה בטלפון: ${ago(new Date(p.lastSync).toISOString())}` : ''}${p.err ? ` · תקלה אחרונה: ${esc(String(p.err).slice(0, 120))}` : ''} ${p.pairSt && !p.paired ? ` · חיבור: ${esc(String(p.pairSt).slice(0, 20))}` : ''} · גרסה ${esc(p.version)}</small>
    <div class="hs-phone__act">${p.wa === false ? '<button type="button" class="btn btn--line btn--sm" data-wa>לאשר וואטסאפ</button>' : ''}${needFix ? '<button type="button" class="btn btn--gold btn--sm" data-fix>לסדר את ההרשאות</button>' : ''}${p.paired ? (p.waiting > 0 ? '<button type="button" class="btn btn--gold btn--sm" data-sync>לשלוח הכול עכשיו</button>' : '<button type="button" class="btn btn--line btn--sm" data-sync>לבדוק הקלטות עכשיו</button>') : con.app ? '<button type="button" class="btn btn--gold btn--sm" data-pair>לחבר את הטלפון</button>' : ''}</div>
  </div>`);
  $('[data-fix]', el)?.addEventListener('click', () => window.LBVApp.approvals());
  $('[data-wa]', el)?.addEventListener('click', () => { window.LBVApp.waAccess?.(); ctx.toast('מדליקים את LBV ברשימה, וחוזרים לכאן', 'info'); });
  $('[data-switch]', el)?.addEventListener('click', async () => { try { await fetch('/api/login', { method: 'DELETE' }); } catch (e) {} location.href = '/admin/?out=' + Date.now() + '#apphome'; });
  $('[data-pair]', el)?.addEventListener('click', () => { (window.LBVApp.pairNow || window.LBVApp.syncNow)?.call(window.LBVApp); ctx.toast('מחברים את הטלפון לרובוט', 'info'); setTimeout(() => again(), 4000); });
  $('[data-sync]', el)?.addEventListener('click', () => { window.LBVApp.syncNow?.(); ctx.toast('הטלפון בודק עכשיו את ההקלטות', 'info'); setTimeout(() => again(), 20000); });
  return el;
}

/* ---------- "did I already talk to this number?" ---------- */
let look = { text: '', results: null, open: null, asked: false };
const relDay = iso => {
  if (!iso) return '';
  const day = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const n = Math.round((day(Date.now()) - day(iso)) / 864e5);
  if (n <= 0) return 'היום'; if (n === 1) return 'אתמול'; if (n < 7) return `לפני ${n} ימים`;
  if (n < 14) return 'לפני שבוע'; if (n < 30) return `לפני ${Math.round(n / 7)} שבועות`;
  if (n < 60) return 'לפני חודש'; return `לפני ${Math.round(n / 30)} חודשים`;
};
/** Checks every 30 seconds (up to 15 minutes) whether the summary the owner asked for is ready. */
function waitFor(pc, done) {
  let n = 0;
  const t = setInterval(async () => {
    if (++n > 30) return clearInterval(t);
    try {
      const r = await api('GET', '?lookup=' + encodeURIComponent(pc.phone || pc.name));
      const x = (r.phone || []).find(y => y.id === pc.id);
      if (x?.sum) { clearInterval(t); Object.assign(pc, x); if (!x.sum.error) { notify('הסיכום מוכן', 'השיחה מ-' + when(pc.at)); done(); } }
    } catch (e) { clearInterval(t); }
  }, 30e3);
}
/** "לייבא את זה?": a call found on the phone goes into a hotel (one that has this number, or a new one in a card). */
function importBox(pc, who) {
  const opts = [];
  for (const r of look.results || []) opts.push({ v: r.surveyId + '|' + r.id, t: `${r.name} (${r.survey})` });
  for (const s of home.surveys || []) opts.push({ v: s.id + '|', t: `מלון חדש בכרטיסייה "${s.title}"` });
  if (!opts.length) return h('<span></span>');
  const el = h(`<div class="hs-imp"><b>לייבא את השיחה הזאת למלון?</b>
    <div class="hs-imp__row"><select>${opts.map(o => `<option value="${esc(o.v)}">${esc(o.t)}</option>`).join('')}</select><button class="btn btn--gold btn--sm" type="button">לייבא</button></div></div>`);
  $('button', el).addEventListener('click', async () => {
    const [surveyId, hotelId] = $('select', el).value.split('|');
    try {
      const r = await api('POST', '', { op: 'attach', id: pc.id, surveyId, hotelId: hotelId || undefined, name: who });
      el.innerHTML = `<p class="hs-wait">${r.already ? 'השיחה כבר נמצאת במלון הזה.' : 'יובא. השיחה נמצאת עכשיו בהיסטוריה של המלון.'}</p>`;
      const open = h('<button class="btn btn--line btn--sm" type="button">לפתוח את המלון</button>');
      open.addEventListener('click', () => { openSurvey = surveyId; openHotel = r.id; cur = null; look = { text: '', results: null, open: null }; again(); scrollTo({ top: 0 }); });
      el.append(open);
    } catch (e) { fail(e); }
  });
  return el;
}
function lookupCard() {
  const here = openSurvey && cur ? cur.survey : null;   // inside a card: offer to add a hotel from another card
  const c = h(`<section class="card hs-look" id="hs-look">
    <form class="hs-look__f" role="search"><label class="hs-look__l" for="hs-look-in">חיפוש</label>
      <div class="hs-look__row"><input id="hs-look-in" type="search" enterkeyhint="search" autocomplete="off" placeholder="מספר טלפון, שם מלון או אולם, או נושא" value="${esc(look.raw || '')}"><button class="btn btn--dark" type="submit">חיפוש</button></div>
      <p class="hs-look__ex">מחפש בכל המלונות והאולמות, השיחות, המיילים והוואטסאפ. למשל: <button type="button" data-ex="מחיר לשבת">מחיר לשבת</button> <button type="button" data-ex="תפוס">תפוס</button> <button type="button" data-ex="052-0000000 שעת כניסה">מספר + נושא</button></p></form>
    <div class="hs-look__out" aria-live="polite"></div></section>`);
  const out = $('.hs-look__out', c);
  const draw = () => {
    out.innerHTML = '';
    if (look.results == null) return;
    const found = (look.found || []).slice().sort((a, b) => (here && b.surveyId === here.id ? 1 : 0) - (here && a.surveyId === here.id ? 1 : 0));
    const sec = t => out.append(h(`<h3 class="hs-look__h">${t}</h3>`));
    let sections = 0;
    const startSec = t => { sections++; sec(t); };
    const phone = (look.phone || []).filter(pc => !look.results.some(r => r.last?.file?.id === pc.id));
    const local = (look.local || []).filter(x => !x.sent || !phone.length);
    if (local.length) out.append(phoneRecsBox(look.text, local, (n => local.some(x => x.rec && !x.sent) ? `בטלפון הזה יש ${n === 1 ? 'שיחה מוקלטת אחת' : n + ' שיחות מוקלטות'} עם "<bdi>${esc(look.text)}</bdi>"` : `בטלפון הזה יש ${local.length === 1 ? 'שיחה אחת' : local.length + ' שיחות'} עם "<bdi>${esc(look.text)}</bdi>"`)(local.filter(x => x.rec).length)));
    if (!look.results.length && !phone.length && found.length) {
      if (local.length) startSec('');
      foundList(found);
      return;
    }
    if (!look.results.length && !phone.length) {
      if (local.length) return;
      out.append(h(look.local ? `<p class="hint">לא מצאתי שיחה עם "${esc(look.text)}" בטלפון, וגם לא מלון כזה באף כרטיסייה.</p>` : look.indexed
        ? `<p class="hint">לא מצאתי שיחה עם "${esc(look.text)}" בטלפון, וגם לא מלון כזה באף כרטיסייה.</p>`
        : `<p class="hint hint--box">עוד אין שיחות מהטלפון במערכת, כי הטלפון עוד לא מחובר. אחרי שלבי החיבור, כל השיחות שבטלפון ייבדקו כאן לפי מספר. <a href="#" data-wiz>לשלבי החיבור</a></p>`));
      $('[data-wiz]', out)?.addEventListener('click', e => { e.preventDefault(); openWizard(Math.max(0, stepsState().findIndex(x => !x.done))); });
      if (here) { const add = h('<button class="btn btn--gold btn--sm" type="button">+ להוסיף אותו כמלון חדש</button>'); add.addEventListener('click', () => { addOpen = true; addPrefill = /\d{6,}/.test(look.text.replace(/\D/g, '')) ? { phone: look.text } : { name: look.text }; again(); }); out.append(add); }
      return;
    }
    look.results.forEach((r, i) => {
      const [an, ac] = AV[r.avail] || AV.unknown;
      const inHere = here && r.surveyId === here.id;
      const box = h(`<div class="hs-ans">
        <p class="hs-ans__q"><b>${esc(r.name || 'מלון')}</b>${r.city ? ' · ' + esc(r.city) : ''}: ${r.calls ? `דיברת איתם <b>${relDay(r.lastAt)}</b> (${when(r.lastAt)})` : `נמצא, עוד בלי שיחה מוקלטת`} · ${inHere ? 'כבר בכרטיסייה הזאת' : `בכרטיסייה "${esc(r.survey)}"`}${r.calls ? '. רוצה סיכום של השיחה?' : ''}</p>
        <div class="row-tools hs-ans__yn"></div><div class="hs-ans__body"></div></div>`);
      const yn = $('.hs-ans__yn', box), body = $('.hs-ans__body', box);
      const openIt = h('<button class="btn btn--line btn--sm" type="button">לפתוח את המלון</button>');
      openIt.addEventListener('click', () => { openSurvey = r.surveyId; openHotel = r.id; cur = null; look = { text: '', results: null, open: null }; again(); scrollTo({ top: 0 }); });
      const addHere = h(`<button class="btn btn--gold btn--sm" type="button">+ להוסיף לכרטיסייה הזאת</button>`);
      addHere.addEventListener('click', async () => {
        try {
          const n = await api('POST', '', { op: 'copy', surveyId: here.id, fromSurvey: r.surveyId, id: r.id });
          look = { text: '', results: null, open: null }; await refreshSurvey(); openHotel = n.id; again(); scrollTo({ top: 0 });
          ctx.toast('המלון נוסף, עם כל ההיסטוריה שלו');
        } catch (e) { fail(e); }
      });
      const acts = () => { yn.innerHTML = ''; if (here && !inHere) yn.append(addHere); yn.append(openIt); };
      const showSummary = () => {
        acts();
        const l = r.last || {};
        body.innerHTML = `<span class="pill pill--${ac}">${an}</span>${r.availText ? ' ' + esc(r.availText) : ''}
          ${l.summary || r.summary ? `<p>${esc(l.summary || r.summary)}</p>` : ''}
          ${(l.quotes || []).length ? `<ul class="ev__q">${l.quotes.map(q => `<li><time>${esc(q.time)}</time>${q.who ? `<b>${esc(q.who)}:</b> ` : ''}"${esc(q.text)}"</li>`).join('')}</ul>` : ''}
          ${r.prices.length ? `<div class="hs-ho__pr">${r.prices.map(p => `<span>${esc([p.level, p.board].filter(Boolean).join(' · ') || 'מחיר')}: <b>${money(p.price, p.currency)}</b>${p.per ? ' ' + esc(p.per) : ''}</span>`).join('')}</div>` : ''}
          ${r.followUp || r.followWhat ? `<p class="hs-follow">לחזור${r.followUp ? ' ב-' + dmy(r.followUp) : ''}${r.followWhat ? ': ' + esc(r.followWhat) : ''}</p>` : ''}
          ${safeUrl(l.file?.url) ? `<a class="btn btn--line btn--sm" href="${esc(l.file.url)}" target="_blank" rel="noopener">להאזנה להקלטה</a>` : ''}`;
      };
      if (!r.calls) acts();
      else if (look.open === i) showSummary();
      else {
        const yes = h('<button class="btn btn--gold btn--sm" type="button">כן, סיכום</button>'), no = h('<button class="btn btn--line btn--sm" type="button">לא</button>');
        yes.addEventListener('click', () => { look.open = i; showSummary(); });
        no.addEventListener('click', () => { look.results.splice(i, 1); if (!look.results.length) { look.results = null; look.text = ''; $('#hs-look-in', c).value = ''; } draw(); });
        yn.append(yes, no);
        if (here && !inHere) yn.append(addHere);
      }
      out.append(box);
    });
    if (found.length) { startSec(`נמצא גם במלונות אחרים (${found.length})`); foundList(found); }
    if (phone.length) { startSec('שיחות מהטלפון'); phone.forEach(pc => out.append(phoneCall(pc))); }
  };
  // a hotel where the words were said / written: name, card, price, and where exactly (with the words marked)
  const foundList = list => {
    const words = (look.words || '').toLowerCase().split(/\s+/).filter(w => w.length >= 2);
    for (const r of list) {
      const [an, ac] = AV[r.avail] || AV.unknown;
      const b = h(`<button type="button" class="hs-fd">
        <span class="hs-fd__t"><b>${esc(r.name || 'מלון')}</b>${r.rating ? `<span class="hs-rate">${rateTxt(r)}</span>` : ''}<span class="pill pill--${ac}">${an}</span></span>
        <span class="hs-fd__s">${here && r.surveyId === here.id ? 'בכרטיסייה הזאת' : 'בכרטיסייה "' + esc(r.survey) + '"'}${r.city ? ' · ' + esc(r.city) : ''}${r.min ? ' · החל מ-' + money(r.min) : ''}</span>
        ${r.where.map(w => `<span class="hs-fd__w"><em>${w.kind}${w.at ? ' מ-' + when(w.at) : ''}:</em> …${mark(w.text, words)}…</span>`).join('')}
      </button>`);
      b.addEventListener('click', () => { openSurvey = r.surveyId; openHotel = r.id; cur = null; look = { text: '', results: null, open: null }; again(); scrollTo({ top: 0 }); });
      out.append(b);
    }
  };
  // A call found on the phone (outside any card): "you talked N days ago, want a summary?" → yes → the robot listens to it
  const phoneCall = pc => {
    const who = pc.name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_ ]?\d{6}[_ -]\d{6}.*$/, '').replace(/^(call ?recording|recording|call)[ _-]*/i, '').trim() || pc.phone;
    const box = h(`<div class="hs-ans hs-ans--phone">
      <p class="hs-ans__q">שיחה בטלפון עם <b><bdi>${esc(who)}</bdi></b>: דיברת <b>${relDay(pc.at)}</b> (${when(pc.at)}).${pc.byText ? ' המילים שחיפשת נאמרו בה.' : pc.sum && !pc.sum.error ? '' : ' רוצה סיכום של השיחה?'}</p>
      <div class="row-tools hs-ans__yn"></div><div class="hs-ans__body"></div></div>`);
    const yn = $('.hs-ans__yn', box), body = $('.hs-ans__body', box);
    const show = () => {
      const sm = pc.sum;
      yn.innerHTML = safeUrl(pc.url) ? `<a class="btn btn--line btn--sm" href="${esc(pc.url)}" target="_blank" rel="noopener">להאזנה להקלטה</a>` : '';
      body.innerHTML = `${sm.q ? `<div class="hs-found ${sm.found ? '' : 'is-no'}"><b>מה שחיפשת: ${esc(sm.q)}</b><p>${esc(sm.answer || (sm.found ? '' : 'בשיחה הזאת לא דיברתם על זה.'))}</p>${(sm.answerQuotes || []).length ? `<ul class="ev__q">${sm.answerQuotes.map(q => `<li><time>${esc(q.time)}</time>${q.who ? `<b>${esc(q.who)}:</b> ` : ''}"${esc(q.text)}"</li>`).join('')}</ul>` : ''}</div>` : ''}
        ${sm.duration ? `<small>אורך השיחה ${esc(sm.duration)}</small>` : ''}<p>${esc(sm.summary)}</p>
        ${(sm.quotes || []).length ? `<ul class="ev__q">${sm.quotes.map(q => `<li><time>${esc(q.time)}</time>${q.who ? `<b>${esc(q.who)}:</b> ` : ''}"${esc(q.text)}"</li>`).join('')}</ul>` : ''}
        ${sm.transcript ? `<details class="ev__tr"><summary>כל השיחה</summary><p>${esc(sm.transcript).replace(/\n/g, '<br>')}</p></details>` : ''}`;
      if ((look.q || '').trim() && sm.q !== look.q.trim()) { const again2 = h(`<button class="btn btn--gold btn--sm" type="button">לחפש בה: ${esc(look.q.trim())}</button>`); again2.addEventListener('click', ask); yn.append(again2); }
      body.append(importBox(pc, who));
      if (here) { const wa = h('<button class="btn btn--line btn--sm" type="button">לשלוח כהוכחה בוואטסאפ</button>'); wa.addEventListener('click', () => window.open('https://wa.me/?text=' + encodeURIComponent(`שיחה מ-${when(pc.at)} עם ${who}:\n${sm.summary}\n${(sm.quotes || []).map(q => `[${q.time}] "${q.text}"`).join('\n')}`), '_blank')); yn.append(wa); }
    };
    const waiting = () => { yn.innerHTML = ''; body.innerHTML = pc.q ? `<p class="hs-wait">המערכת מקשיבה לשיחה ומחפשת "${esc(pc.q)}". התשובה תופיע כאן תוך כ-5 דקות, ותקבל התראה.</p>` : '<p class="hs-wait">המערכת מקשיבה לשיחה עכשיו. הסיכום יופיע כאן תוך כ-5 דקות, ותקבל התראה.</p>'; };
    const ask = async () => {
      try {
        const r = await api('POST', '', { op: 'ask', id: pc.id, q: (look.q || '').trim() });
        Object.assign(pc, r);
        if (pc.sum && !pc.sum.error) return show();
        waiting(); waitFor(pc, () => { if (box.isConnected) show(); });
      } catch (e) { fail(e); }
    };
    if (pc.sum && !pc.sum.error) show();
    else if (pc.ask) { waiting(); waitFor(pc, () => { if (box.isConnected) show(); }); }
    else {
      const yes = h(`<button class="btn btn--gold btn--sm" type="button">${(look.q || '').trim() ? 'לחפש בשיחה: ' + esc(look.q.trim()) : 'כן, סיכום'}</button>`), no = h('<button class="btn btn--line btn--sm" type="button">לא</button>');
      yes.addEventListener('click', ask); no.addEventListener('click', () => box.remove());
      yn.append(yes, no);
      if (pc.sum?.error) body.innerHTML = '<p class="hint">בפעם הקודמת לא הצלחתי לקרוא את ההקלטה. אפשר לנסות שוב.</p>';
    }
    return box;
  };
  $$('[data-ex]', c).forEach(b => b.addEventListener('click', () => { const i = $('#hs-look-in', c); i.value = b.dataset.ex.includes('052-0000000') ? '' : b.dataset.ex; i.focus(); if (i.value) $('form', c).requestSubmit(); else i.placeholder = 'מספר טלפון ואחריו נושא, למשל: 0521234567 מחיר'; }));
  $('form', c).addEventListener('submit', async e => {
    e.preventDefault();
    // one box: a phone number (if any) + the words. Number + words = "find this in the calls with that number"
    look.raw = $('#hs-look-in', c).value.trim(); look.open = null;
    const num = (look.raw.match(/\+?\d[\d\s\-]{6,}\d/) || [''])[0], rest = look.raw.replace(num, ' ').replace(/\s+/g, ' ').trim();
    look.text = num ? num.trim() : rest; look.q = num ? rest : ''; look.words = rest;
    if (!look.raw) { look.results = null; return draw(); }
    try { const r = await api('GET', '?lookup=' + encodeURIComponent(look.text || rest) + '&q=' + encodeURIComponent(num ? '' : rest)); look.results = r.results; look.found = r.found || []; look.phone = r.phone || []; look.indexed = r.indexed; } catch (e2) { fail(e2); look.results = null; }
    // the phone's own calls: by number, or by a contact name when the words found nothing in the texts
    look.local = num ? phoneFind(num) : rest.length >= 2 && !(look.found || []).length && !(look.phone || []).some(p => p.byText) ? phoneFind(rest) : null;
    draw();
  });
  draw();
  return c;
}

/* ---------- home: the surveys ---------- */
let showConnect = false, newOpen = false;
function homeView(pg) {
  const list = h(`<section class="card"><div class="card__head"><div><h2>הכרטיסיות שלי</h2><p>כרטיסייה לכל אירוע: שם, סוג ותאריך. בפנים מוסיפים מלונות. רואים רק אתם ומי שבחרתם לשתף.</p></div>
    <div class="row-tools">${home.surveys.filter(s => s.manage).length > 1 ? '<button class="btn btn--line" type="button" data-recheck>לבדוק לאיזה אירוע שייך כל מקום</button>' : ''}<button class="btn btn--gold" type="button" data-new>+ כרטיסייה חדשה</button></div></div><div class="hs-surveys"></div></section>`);
  const box = $('.hs-surveys', list);
  if ((home.follow || []).length) pg.append(followCard());
  if ((home.wait || []).length) pg.append(waitCard());
  const asks = home.surveys.filter(s => s.manage && (s.afterAsk || []).length);
  if (asks.length) {
    const c = h(`<section class="card hs-aftercard"><div class="card__head"><div><h2>אירועים שעברו</h2><p>איך היה במקום שסגרתם איתו? כמה מילים ותמונות נשמרים עם המקום לפעם הבאה.</p></div></div><div class="hs-wait__btns"></div></section>`);
    for (const s of asks) for (const a of s.afterAsk) {
      const b = h(`<button type="button" class="btn btn--gold btn--sm">${esc(a.name || 'המקום')} · ${esc(s.title)}</button>`);
      b.addEventListener('click', async () => { openSurvey = s.id; openHotel = null; try { await refreshSurvey(); } catch (e) { fail(e); return; } again(); scrollTo({ top: 0 }); });
      $('.hs-wait__btns', c).append(b);
    }
    pg.append(c);
  }
  $('[data-recheck]', list)?.addEventListener('click', async e => {
    e.currentTarget.disabled = true; e.currentTarget.textContent = 'בודק…';
    try {
      const r = await api('POST', '', { op: 'recheck' });
      await refreshHome();
      ctx.toast(r.found ? (r.found === 1 ? 'מקום אחד נראה שייך לאירוע אחר. הוא באזור ההמתנה' : r.found + ' מקומות נראים שייכים לאירוע אחר. הם באזור ההמתנה') : 'כל המקומות בכרטיסייה הנכונה');
      again();
    } catch (e2) { fail(e2); again(); }
  });
  if (!home.surveys.length) box.append(h('<p class="hint">עוד אין כרטיסיות. פותחים כרטיסייה לאירוע (למשל "שבת חתן משפחת כהן"), ובפנים מוסיפים מלונות.</p>'));
  for (const s of home.surveys) {
    const b = h(`<button type="button" class="hs-sv">
      <b>${esc(s.title)}</b>
      <span>${s.kind ? esc(s.kind) + ' · ' : ''}${s.from ? dmy(s.from) + (s.to && s.to !== s.from ? ' – ' + dmy(s.to) : '') : 'בלי תאריכים'}${s.area ? ' · ' + esc(s.area) : ''}</span>
      <span class="hs-sv__n"><em>${s.count}</em> מלונות · <em>${s.avail}</em> עם מקום${s.follow ? ` · <em class="w">${s.follow}</em> לחזור` : ''}</span>
      <small>${s.mine ? 'שלי' : 'שותף איתי · ' + esc(s.by?.name || '')}${home.mode?.on && home.mode.surveyId === s.id ? ' · <b class="live">פעיל עכשיו</b>' : ''}</small>
    </button>`);
    b.addEventListener('click', () => { openSurvey = s.id; openHotel = null; query = ''; filter = 'all'; again(); });
    box.append(b);
  }
  $('[data-new]', list).addEventListener('click', () => { newOpen = !newOpen; again(); });
  pg.append(list);
  if (newOpen) list.after(surveyForm());
  pg.append(connectCard());
  if (home.robot) pg.append(robotCard(home.robot));
}

/** owner 24.11: the places of a card side by side; you choose which ones the client sees, the price for him and what to tell him,
 *  and get a page in the La Belle Vie look (a link for WhatsApp, or print it as a PDF). Our cost and the places' phones never go there. */
function compareCard(sv, hotels) {
  const order = ['available', 'partial', 'unknown', 'full'];
  const rows = [...hotels].filter(x => x.status !== 'no').sort((a, b) => order.indexOf(a.avail) - order.indexOf(b.avail) || (a.min ?? 1e12) - (b.min ?? 1e12));
  const kept = compareCard.state?.sv === sv.id ? compareCard.state : (compareCard.state = { sv: sv.id, pick: {}, price: {}, per: {}, note: {}, intro: '' });
  const minTxt = x => { const p = (x.prices || []).filter(p => p.price > 0).sort((a, b) => a.price - b.price)[0]; return p ? money(p.price, p.currency) + (p.per ? ' ' + p.per : '') : 'עוד אין מחיר'; };
  const c = h(`<section class="card hs-cmp">
    <div class="card__head"><div><h2>השוואה ללקוח</h2><p>מסמנים את המקומות שהלקוח יראה, כותבים לו מחיר ומה חשוב לדעת. המחיר שקיבלנו, הטלפונים והשיחות לא מופיעים אצלו.</p></div></div>
    <label class="field"><span>כותרת הדף (מה שהלקוח רואה למעלה)</span><input data-title placeholder="למשל: חתונה של משפחת כהן"></label>
    <label class="field"><span>פתיח ללקוח</span><textarea rows="2" data-intro placeholder="למשל: בחרנו עבורכם שלושה מקומות שמתאימים לחתונה ב-25.3, עם כל הפרטים"></textarea></label>
    <div class="hs-cmp__list"></div>
    <div class="hs-cmp__foot"><span class="hs-cmp__n"></span><button class="btn btn--gold" type="button" data-make>יצירת דף ללקוח</button></div>
    <div class="hs-cmp__out"></div>
  </section>`);
  if (kept.title == null) kept.title = sv.title || '';
  $('[data-title]', c).value = kept.title;
  $('[data-title]', c).addEventListener('input', e => { kept.title = e.target.value; });
  $('[data-intro]', c).value = kept.intro;
  $('[data-intro]', c).addEventListener('input', e => { kept.intro = e.target.value; });
  const list = $('.hs-cmp__list', c), nEl = $('.hs-cmp__n', c);
  const count = () => { const n = rows.filter(x => kept.pick[x.id]).length; nEl.textContent = n ? (n === 1 ? 'נבחר מקום אחד' : 'נבחרו ' + n + ' מקומות') : 'עוד לא נבחר מקום'; };
  for (const x of rows) {
    const [an, ac] = avOf(x, sv);
    if (kept.note[x.id] == null) kept.note[x.id] = x.availText || '';
    const it = h(`<article class="hs-cmp__it">
      <label class="hs-cmp__pick"><input type="checkbox" data-pick><span><b>${esc(x.name || 'בלי שם')}</b><small>${esc(x.city || '')}</small></span></label>
      <div class="hs-cmp__facts"><span class="pill pill--${ac}">${an}</span><span>מה שקיבלנו: <b>${esc(minTxt(x))}</b></span>${x.summary ? `<p>${esc(x.summary)}</p>` : ''}</div>
      <div class="hs-cmp__fill">
        <label class="field"><span>מחיר ללקוח (₪)</span><input type="number" min="0" inputmode="numeric" data-price placeholder="לא חובה"></label>
        <label class="field"><span>על מה המחיר</span><input data-per placeholder="למשל: לאורח, כולל אולם"></label>
        <label class="field hs-cmp__note"><span>מה לכתוב ללקוח</span><textarea rows="2" data-note></textarea></label>
      </div>
    </article>`);
    const pick = $('[data-pick]', it);
    pick.checked = !!kept.pick[x.id]; it.classList.toggle('on', pick.checked);
    pick.addEventListener('change', () => { kept.pick[x.id] = pick.checked; it.classList.toggle('on', pick.checked); count(); });
    $('[data-price]', it).value = kept.price[x.id] || ''; $('[data-price]', it).addEventListener('input', e => { kept.price[x.id] = e.target.value; });
    $('[data-per]', it).value = kept.per[x.id] || ''; $('[data-per]', it).addEventListener('input', e => { kept.per[x.id] = e.target.value; });
    $('[data-note]', it).value = kept.note[x.id]; $('[data-note]', it).addEventListener('input', e => { kept.note[x.id] = e.target.value; });
    list.append(it);
  }
  count();
  const out = $('.hs-cmp__out', c);
  const showLink = url => {
    const full = location.origin + url;
    out.innerHTML = `<div class="hs-cmp__link"><p>הדף מוכן. רק מי שיש לו את הקישור יכול לראות אותו.</p><div class="hs-wait__btns">
      <a class="btn btn--gold btn--sm" href="${esc(url)}" target="_blank" rel="noopener">לפתוח את הדף</a>
      <button class="btn btn--line btn--sm" type="button" data-copy>להעתיק קישור</button>
      <a class="btn btn--line btn--sm" href="https://wa.me/?text=${encodeURIComponent(full)}" target="_blank" rel="noopener">לשלוח בוואטסאפ</a>
      <a class="btn btn--line btn--sm" href="${esc(url)}&print=1" target="_blank" rel="noopener">PDF להדפסה</a></div></div>`;
    $('[data-copy]', out).addEventListener('click', () => copy(full, 'הקישור הועתק'));
  };
  if (offerLink) showLink(offerLink);
  $('[data-make]', c).addEventListener('click', async e => {
    const items = rows.filter(x => kept.pick[x.id]).map(x => ({ hotelId: x.id, price: kept.price[x.id] || '', per: kept.per[x.id] || '', note: kept.note[x.id] || '' }));
    if (!items.length) { ctx.toast('מסמנים לפחות מקום אחד'); return; }
    const b = e.currentTarget; b.disabled = true; b.textContent = 'יוצר…';
    try {
      const r = await api('POST', '', { op: 'offer', surveyId: sv.id, intro: kept.intro, title: (kept.title || '').trim() || sv.title, date: sv.from ? dmy(sv.from) + (sv.to && sv.to !== sv.from ? ' – ' + dmy(sv.to) : '') : '', items });
      offerLink = r.url; showLink(r.url); ctx.toast('הדף ללקוח מוכן');
    } catch (e2) { fail(e2); }
    b.disabled = false; b.textContent = 'יצירת דף ללקוח';
  });
  return c;
}

/** owner 24.11: is the robot working? When it last ran, how Gemini answered today, what waits in line, and the last errors. */
function robotCard(r) {
  const mins = r.last ? Math.round((Date.now() - Date.parse(r.last.at)) / 60000) : null;
  const ago = mins == null ? 'עוד לא דיווח' : mins < 1 ? 'עכשיו' : mins < 60 ? 'לפני ' + mins + ' דק\'' : 'ב-' + when(r.last.at);
  const g = r.gem || {}, tries = (g.ok || 0) + (g.busy || 0) + (g.quota || 0);
  const crowded = tries > 0 && (g.busy + g.quota) > g.ok;
  const st = mins == null || mins > 15 ? ['bad', mins == null ? 'הרובוט עוד לא דיווח' : 'הרובוט לא רץ מאז ' + when(r.last.at)]
    : r.killedToday > 2 ? ['warn', 'הרובוט עובד, אבל ' + r.killedToday + ' ריצות היום נעצרו באמצע (6 דקות). מה שלא הספיק ממשיך בריצה הבאה']
    : crowded ? ['warn', 'הרובוט עובד, אבל Gemini עמוס היום. דברים לוקחים יותר זמן']
    : ['ok', 'הרובוט עובד כרגיל'];
  const q = r.queue || {}, line = [];
  if (q.sort) line.push(q.sort === 1 ? 'שיחה אחת לזיהוי' : q.sort + ' שיחות לזיהוי');
  if (q.photos) line.push(q.photos === 1 ? 'מקום אחד לבדיקת תמונות' : q.photos + ' מקומות לבדיקת תמונות');
  if (q.web) line.push(q.web === 1 ? 'מקום אחד לחיפוש באתר שלו' : q.web + ' מקומות לחיפוש באתר שלהם');
  if (q.mail) line.push(q.mail === 1 ? 'תיבת מייל אחת לבדיקה' : q.mail + ' בדיקות מייל');
  if (q.ilanMerge) line.push('איחוד המטלות של אילן');
  const plain = e => /\b(429|RESOURCE_EXHAUSTED)\b/.test(e) ? 'Gemini: נגמרה המכסה היומית של אחד המפתחות' : /\b(503|UNAVAILABLE|overloaded)\b|out of time/.test(e) ? 'Gemini עמוס, ננסה בריצה הבאה' : e;
  const errs = [];
  for (const e of r.errors || []) { const t = plain(e.text); if (!errs.some(x => x.t === t)) errs.push({ t, at: e.at }); }
  const c = h(`<section class="card hs-bot hs-bot--${st[0]}">
    <div class="card__head"><div><h2>מצב הרובוט</h2><p><i class="hs-bot__dot"></i>${esc(st[1])}</p></div></div>
    <dl class="hs-bot__grid">
      <div><dt>ריצה אחרונה</dt><dd>${esc(ago)}${r.last ? ' · ' + r.last.secs + ' שניות' : ''}</dd></div>
      <div><dt>ריצות היום</dt><dd>${r.runsToday || 0}${r.killedToday ? ' · ' + r.killedToday + ' נעצרו באמצע' : ''}</dd></div>
      <div><dt>Gemini היום</dt><dd>${g.ok || 0} תשובות${g.busy ? ' · ' + g.busy + ' פעמים עמוס' : ''}${g.quota ? ' · ' + g.quota + ' בלי מכסה' : ''}</dd></div>
      <div><dt>מחכה בתור</dt><dd>${line.length ? esc(line.join(', ')) : 'כלום, הכול מעודכן'}</dd></div>
    </dl>
    ${errs.length ? `<details class="hs-bot__err"><summary>תקלות אחרונות (${errs.length})</summary><ul>${errs.map(e => `<li><small>${esc(when(e.at))}</small> ${esc(e.t)}</li>`).join('')}</ul></details>` : ''}
  </section>`);
  return c;
}

/** owner 24.11: places to call back today. A place that said "I'll check and call you back" and did not, within a day, shows here by itself. */
function followCard() {
  const list = home.follow || [];
  const c = h(`<section class="card hs-fol"><div class="card__head"><div><h2>לחזור אליהם היום</h2><p>${list.length === 1 ? 'מקום אחד' : list.length + ' מקומות'} שאמרו שיחזרו או שצריך לחזור אליהם, ועוד לא נסגר.</p></div></div><div class="hs-fol__list"></div></section>`);
  const box = $('.hs-fol__list', c);
  for (const f of list) {
    const tel = String(f.phone || '').replace(/[^\d+]/g, '');
    const it = h(`<article class="hs-fol__it${f.late ? ' late' : ''}">
      <div class="hs-fol__t"><b>${esc(f.name || 'בלי שם')}</b><small>${esc(f.title)} · ${f.late ? 'מחכה מ-' + dmy(f.due) : 'להיום'}</small></div>
      ${f.what ? `<p>${esc(f.what)}</p>` : ''}
      <div class="hs-wait__btns">
        ${tel ? `<a class="btn btn--gold btn--sm" href="tel:${esc(tel)}">להתקשר <bdi>${esc(f.phone)}</bdi></a>` : ''}
        <button class="btn btn--line btn--sm" type="button" data-done>טופל</button>
        <button class="btn btn--line btn--sm" type="button" data-tom>להזכיר מחר</button>
        <button class="btn btn--line btn--sm" type="button" data-open>לפתוח את המקום</button>
      </div></article>`);
    const act = async (a, msg) => {
      it.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try { const r = await api('POST', '', { op: 'follow', surveyId: f.surveyId, id: f.hotelId, act: a }); home.follow = r.follow || []; ctx.toast(msg); again(); }
      catch (e) { fail(e); it.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
    };
    $('[data-done]', it).addEventListener('click', () => act('done', 'סומן שטופל'));
    $('[data-tom]', it).addEventListener('click', () => act('tomorrow', 'אזכיר מחר'));
    $('[data-open]', it).addEventListener('click', () => { openSurvey = f.surveyId; openHotel = f.hotelId; again(); scrollTo({ top: 0 }); });
    box.append(it);
  }
  return c;
}

/** owner 24.11: calls and places the system was not sure about (several events at the same time). The owner says where they go. */
function waitCard() {
  const c = h(`<section class="card hs-wait"><div class="card__head"><div><h2>אזור המתנה</h2><p>כמה אירועים פתוחים יחד, והמערכת לא בטוחה לאיזה מהם זה שייך. בוחרים לאן להכניס.</p></div></div><div class="hs-wait__list"></div></section>`);
  const box = $('.hs-wait__list', c);
  for (const w of home.wait) {
    const move = w.type === 'move';
    const it = h(`<article class="hs-wait__it">
      <header><b>${esc(w.name || 'שיחה')}</b><small>${move ? 'מקום שכבר בכרטיסייה' : 'שיחה'} · ${when(w.at)}</small></header>
      ${move ? `<p>נמצא בכרטיסייה "${esc(w.fromTitle)}", אבל לפי מה שנאמר עליו הוא שייך ל"${esc(w.toTitle)}"${(w.why || []).length ? ' (נאמר: ' + w.why.map(esc).join(', ') + ')' : ''}.</p>` : `<p>${esc(w.summary || 'אין סיכום')}</p>`}
      ${!move && w.transcript ? `<details class="sm-call__txt"><summary>התמלול</summary><pre dir="auto">${esc(w.transcript)}</pre></details>` : ''}
      <div class="hs-wait__btns"></div></article>`);
    const btns = $('.hs-wait__btns', it);
    const go = async (surveyId, done) => {
      btns.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try { await api('POST', '', { op: 'place', id: w.id, surveyId }); await refreshHome(); ctx.toast(done); again(); }
      catch (e) { fail(e); btns.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
    };
    const add = (label, cls, fn) => { const b = h(`<button class="btn btn--${cls} btn--sm" type="button"></button>`); b.textContent = label; b.addEventListener('click', fn); btns.append(b); };
    if (move) {
      add('להעביר ל"' + w.toTitle + '"', 'gold', () => go(w.to, 'המקום הועבר'));
      add('להשאיר ב"' + w.fromTitle + '"', 'line', () => go('', 'המקום נשאר בכרטיסייה'));
    } else {
      [...(w.cards || [])].sort((a, b) => b.score - a.score).forEach((cd, i) => add('להכניס ל"' + cd.title + '"', i ? 'line' : 'gold', () => go(cd.surveyId, 'השיחה נכנסה ל"' + cd.title + '"')));
      add('לא שייך לאף אירוע', 'line', () => go('', 'השיחה נשארה רק ברשימת השיחות'));
    }
    box.append(it);
  }
  return c;
}

const KINDS = ['שבת חתן', 'בר מצווה', 'בת מצווה', 'חתונה', 'חג', 'אחר'];
function surveyForm(sv) {
  const s = sv || { title: '', kind: 'שבת חתן', from: '', to: '', need: '', area: '', note: '', levels: ['רגיל', 'משודרג', 'סוויטה', 'חבילת שבת', 'אולם וסעודות'], mailLang: 'he', sheet: true };
  const f = h(`<form class="card hs-form">
    <h2>${sv ? 'פרטי הכרטיסייה' : 'כרטיסייה חדשה'}</h2>
    <label class="field"><span>שם</span><input name="title" required placeholder="למשל: שבת חתן משפחת כהן" value="${esc(s.title)}"></label>
    <div class="grid2">
      <label class="field"><span>מה זה</span><select name="kind">${[...new Set([...KINDS, s.kind].filter(Boolean))].map(k => `<option ${s.kind === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></label>
      <label class="field"><span>תאריך</span><input name="from" type="date" required value="${esc(s.from)}"></label>
    </div>
    <details class="hs-more" ${sv ? 'open' : ''}><summary>עוד פרטים (לא חובה)</summary>
      <div class="grid2">
        <label class="field"><span>עד תאריך</span><input name="to" type="date" value="${esc(s.to)}"></label>
        <label class="field"><span>אזור</span><input name="area" placeholder="למשל: טבריה והכנרת" value="${esc(s.area)}"></label>
      </div>
      <label class="field"><span>מה צריך (נכנס גם למייל למלון)</span><input name="need" placeholder="למשל: 25 חדרים, אולם ל-120 איש, 3 סעודות, כשרות מהדרין" value="${esc(s.need)}"></label>
      <label class="field"><span>רמות מחיר (מופרדות בפסיק)</span><input name="levels" value="${esc((s.levels || []).join(', '))}"></label>
      <div class="grid2">
        <label class="field"><span>שפת המייל למלונות</span><select name="mailLang">${[['he', 'עברית'], ['fr', 'צרפתית'], ['en', 'אנגלית']].map(([v, n]) => `<option value="${v}" ${s.mailLang === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="field hs-check"><input type="checkbox" name="sheet" ${s.sheet !== false ? 'checked' : ''}><span>לעדכן גיליון בגוגל שיטס אוטומטית</span></label>
      </div>
      <label class="field"><span>הערות לעצמי</span><textarea name="note" rows="2">${esc(s.note)}</textarea></label>
    </details>
    <div class="row-tools"><button class="btn btn--gold" type="submit">${sv ? 'שמירה' : 'פתיחת הכרטיסייה'}</button><button class="btn btn--line" type="button" data-x>ביטול</button>
    ${sv?.manage ? '<button class="btn btn--danger btn--sm hs-push" type="button" data-del>מחיקת הכרטיסייה</button>' : ''}</div>
  </form>`);
  // Shabbat: Friday chosen -> "until" becomes the Saturday by itself
  const fromIn = $('[name=from]', f), toIn = $('[name=to]', f), kindIn = $('[name=kind]', f);
  const autoTo = () => { if (!fromIn.value || toIn.dataset.touched) return; const d = new Date(fromIn.value + 'T12:00'); if (/שבת/.test(kindIn.value) && d.getDay() === 5) { d.setDate(d.getDate() + 1); toIn.value = d.toISOString().slice(0, 10); } };
  fromIn.addEventListener('change', autoTo); kindIn.addEventListener('change', autoTo); toIn.addEventListener('input', () => { toIn.dataset.touched = 1; });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    try {
      const r = await api('POST', '', { op: 'survey', id: sv?.id, title: d.title, kind: d.kind, area: d.area, from: d.from, to: d.to, need: d.need, note: d.note, mailLang: d.mailLang, sheet: !!d.sheet, levels: d.levels.split(/[,،]/).map(x => x.trim()).filter(Boolean) });
      newOpen = false; editSurvey = false; await refreshHome();
      if (!sv) { openSurvey = r.id; importOpen = true; ctx.toast('הכרטיסייה נפתחה. אפשר לייבא מקומות מהמאגר, או להוסיף מלון חדש'); } else { await refreshSurvey(); ctx.toast('נשמר'); }
      again();
    } catch (e2) { fail(e2); }
  });
  $('[data-x]', f).addEventListener('click', () => { newOpen = false; editSurvey = false; again(); });
  $('[data-del]', f)?.addEventListener('click', async () => {
    if (!confirm(`למחוק את הכרטיסייה "${sv.title}" עם כל המלונות, השיחות והמיילים שבו? אי אפשר לבטל.`)) return;
    try { await api('DELETE', '?survey=' + sv.id); openSurvey = null; cur = null; editSurvey = false; await refreshHome(); again(); ctx.toast('הכרטיסייה נמחקה'); } catch (e) { fail(e); }
  });
  return f;
}

/* ---------- connecting (one time): 4 steps that pop up by themselves ---------- */
let newKey = '', wizStep = null, wizSeen = false, installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
addEventListener('appinstalled', () => { markStep('home'); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' }).catch(() => {});
const marks = () => { try { return JSON.parse(localStorage.getItem('hs-setup') || '{}'); } catch (e) { return {}; } };
function markStep(id) { try { localStorage.setItem('hs-setup', JSON.stringify({ ...marks(), [id]: 1 })); } catch (e) {} }
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
const inApp = () => document.documentElement.classList.contains('lbv-app');
const phoneUA = () => /android|iphone|ipad/i.test(navigator.userAgent);
function stepsState() { const all = stepsAll(); return inApp() || !phoneUA() ? all.filter(x => x.id === 'google') : all; }   // the computer needs no phone steps: it shows the same cards, live
function stepsAll() {
  const con = home.connection || {}, m = marks();
  return [
    { id: 'google', done: !!con.connected, title: 'חיבור לחשבון הגוגל של LBV',
      why: 'רובוט קטן בחשבון הגוגל של LBV שעושה את כל העבודה לבד:',
      items: ['קורא את תיקיית "הקלטות שיחות" בדרייב', 'שולח מיילים למלונות מהמייל של LBV וקורא את התשובות', 'מעדכן גיליון בגוגל שיטס'],
      fine: 'לוחצים "יצירת מפתח", ואת ההתקנה בחשבון של LBV עושים ביחד פעם אחת (כ-5 דקות). בהפעלה הראשונה גוגל מקפיץ חלון "לאשר גישה?" ולוחצים "אישור". השלב מסתמן לבד כשהרובוט מתחבר.' },
    { id: 'rec', done: !!con.appLast || !!con.last, title: 'האפליקציה LBV בטלפון',
      why: 'אפליקציה קטנה של LBV ששולחת את הקלטות השיחות למערכת לבד. רק לוחצים "אישור":',
      items: ['"הורדת האפליקציה", ואז "התקנה". בפעם הראשונה אנדרואיד שואל "לאפשר התקנה מהמקור הזה?" ולוחצים "אישור"', '"חיבור האפליקציה": האפליקציה נפתחת ומתחברת לבד', 'באפליקציה קופצים 4 אישורים: תיקיית ההקלטות, יומן השיחות, עבודה ברקע, התראות. לוחצים "אישור" בכל אחד'],
      fine: 'עושים את זה בטלפון העבודה. השלב מסתמן לבד כשההקלטה הראשונה מגיעה.' },
    { id: 'notify', done: typeof Notification !== 'undefined' && Notification.permission === 'granted', title: 'התראות לטלפון',
      why: 'הטלפון יודיע לך כש:', items: ['שיחה עם מלון נקלטה ונכנסה לכרטיסייה', 'סיכום שביקשת על שיחה מוכן'],
      fine: 'ההתראות מגיעות כשהסקר פתוח בטלפון, גם ברקע. אנדרואיד מקפיץ עכשיו "לאפשר התראות?" ולוחצים "אישור".' },
    { id: 'home', done: !!m.home || standalone(), title: 'אייקון על מסך הבית',
      why: 'כדי שהבדיקה תיפתח בלחיצה אחת, כמו אפליקציה:', items: ['אייקון "LBV" עם הלוגו של LBV', 'נפתח ישר לכרטיסיות ולמתג "מצב סקר"'],
      fine: 'כרום מקפיץ "להוסיף למסך הבית?" ולוחצים "הוספה". אם לא קפץ: בכרום לוחצים ⋮ למעלה ואז "הוספה למסך הבית".' },
  ];
}
function connectCard() {
  const st = stepsState(), n = st.filter(x => x.done).length;
  const c = h(`<section class="card hs-setup">
    <div class="card__head"><div><h2>חיבור למערכת: ${n} מתוך ${st.length}</h2><p>${n === st.length ? 'הכול מחובר.' : st.length === 1 ? 'שלב אחד, פעם אחת. אחריו הכול עובד לבד.' : 'ארבעה אישורים, פעם אחת. אחריהם הכול עובד לבד.'}</p></div>
    ${n < st.length ? '<div class="row-tools"><button class="btn btn--gold" type="button" data-wiz>להמשיך בחיבור</button></div>' : ''}</div>
    <ol class="hs-setup__list">${st.map((x, i) => `<li class="${x.done ? 'ok' : ''}"><button type="button" data-i="${i}"><i>${x.done ? '✓' : i + 1}</i><b>${esc(x.title)}</b><span>${x.done ? 'מחובר' : 'לא עדיין'}</span></button></li>`).join('')}</ol>
  </section>`);
  $('[data-wiz]', c)?.addEventListener('click', () => openWizard(st.findIndex(x => !x.done)));
  $$('[data-i]', c).forEach(b => b.addEventListener('click', () => openWizard(+b.dataset.i)));
  return c;
}
/** The pop-up sheet, one step at a time (opens by itself the first time the page is entered while steps are missing). */
function openWizard(i) {
  $('.hs-wiz')?.remove();
  const st = stepsState();
  if (i < 0 || i >= st.length) { again(); return; }
  wizStep = i; wizSeen = true;
  const x = st[i], con = home.connection || {};
  const act = {
    google: `<button class="btn btn--gold" type="button" data-go>${con.connected ? 'מחובר. הלאה' : 'יצירת מפתח'}</button>`,
    rec: phoneUA() ? `<a class="btn btn--gold" href="/app/lbv-calls.apk" download data-dl>1. הורדת האפליקציה</a><button class="btn btn--dark" type="button" data-go>2. חיבור האפליקציה</button>` : `<p class="hs-wiz__desk">את השלב הזה עושים בטלפון, לא במחשב: פותחים את האפליקציה LBV, נכנסים עם שם המשתמש של הבעלים, ובדף "מלונות" לוחצים "לחבר את הטלפון".</p>`,
    notify: `<button class="btn btn--gold" type="button" data-go>${x.done ? 'מאושר. הלאה' : 'לאפשר התראות'}</button>`,
    home: `<button class="btn btn--gold" type="button" data-go>${x.done ? 'יש אייקון. סיום' : 'הוספה למסך הבית'}</button>`,
  }[x.id];
  const w = h(`<div class="hs-wiz" role="dialog" aria-modal="true" aria-label="${esc(x.title)}"><div class="hs-wiz__sheet">
    <div class="hs-wiz__dots">${st.map((y, j) => `<i class="${y.done ? 'ok' : ''} ${j === i ? 'cur' : ''}"></i>`).join('')}</div>
    <small class="hs-wiz__k">שלב ${i + 1} מתוך ${st.length}${x.done ? ' · מחובר' : ''}</small>
    <h3>${esc(x.title)}</h3>
    <p>${esc(x.why)}</p>
    <ul>${x.items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>
    ${x.id === 'google' && newKey ? `<p class="hs-key"><code>${esc(newKey)}</code><button class="btn btn--line btn--sm" type="button" data-copy>העתקה</button><small>המפתח מוצג רק עכשיו. שומרים אותו להתקנה.</small></p>` : ''}
    <p class="hs-wiz__fine">${esc(x.fine)}</p>
    <div class="hs-wiz__act">${act}</div>
    <div class="hs-wiz__nav"><button type="button" data-later>אחר כך</button>${i < 3 ? '<button type="button" data-next>לשלב הבא ←</button>' : ''}</div>
  </div></div>`);
  const next = () => { const s2 = stepsState(); const j = s2.findIndex((y, k) => k > i && !y.done); if (j < 0) { w.remove(); ctx.toast(s2.every(y => y.done) ? 'הכול מחובר' : 'אפשר להמשיך מתי שרוצים מהכרטיס "חיבור למערכת"'); again(); } else openWizard(j); };
  $('[data-later]', w).addEventListener('click', () => { w.remove(); again(); });
  $('[data-next]', w)?.addEventListener('click', next);
  w.addEventListener('click', e => { if (e.target === w) { w.remove(); again(); } });
  $('[data-copy]', w)?.addEventListener('click', () => copy(newKey, 'המפתח הועתק'));
  $('[data-done]', w)?.addEventListener('click', () => { markStep('rec'); next(); });
  $('[data-go]', w)?.addEventListener('click', async e => {
    if (x.id === 'google') {
      if (con.connected) return next();
      try { newKey = (await api('POST', '', { op: 'connect' })).key; await refreshHome(); openWizard(i); } catch (e2) { fail(e2); }
    } else if (x.id === 'rec') {
      // The app connects itself after its login (the robot's secret never travels in a link).
      if (!con.connected) { ctx.toast('קודם צריך את שלב 1 (הרובוט בגוגל). אחריו החיבור עובד', 'info'); return; }
      if (/android/i.test(navigator.userAgent)) location.href = '/app/lbv-calls.apk';
      ctx.toast('מתקינים את האפליקציה LBV, נכנסים עם הסיסמה, והיא מתחברת לבד', 'info');
    }
    else if (x.id === 'notify') {
      if (x.done) return next();
      if (typeof Notification === 'undefined') { ctx.toast('הדפדפן הזה לא תומך בהתראות. פותחים בכרום בטלפון', 'info'); return; }
      const r = await Notification.requestPermission();
      if (r === 'granted') { notify('ההתראות פועלות', 'כך תיראה התראה על שיחה חדשה עם מלון'); next(); }
      else ctx.toast('ההתראות נחסמו. אפשר לאשר אחר כך בהגדרות האתר בכרום', 'info');
    } else if (x.id === 'home') {
      if (x.done) return next();
      if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; if (r.outcome === 'accepted') { markStep('home'); next(); } }
      else ctx.toast('בכרום לוחצים ⋮ למעלה ואז "הוספה למסך הבית"', 'info');
    }
  });
  document.body.append(w);
}
function notify(title, body) {
  try { navigator.serviceWorker?.getRegistration('/admin/').then(r => r ? r.showNotification(title, { body, icon: '/media/icon-gold.png', lang: 'he', dir: 'rtl' }) : new Notification(title, { body, icon: '/media/icon-gold.png' })); } catch (e) {}
}
// While the page is open (also in the background): tell about new calls and ready summaries.
let lastSeen = null, pollT = null, pollSig = null;
function startPolling() {
  if (pollT) return;
  // Every 30 seconds: what changed on another screen (the phone app, a call that came in, the computer) shows here by itself.
  pollT = setInterval(async () => {
    if (document.hidden || !document.querySelector('#page .hs-acts, #page .hs-setup, #page .hs-look, #page .card')) return;
    try {
      const r = await fetch('/api/hotels'); if (!r.ok) return; const j = await r.json();
      const last = j.connection?.last || null;
      if (lastSeen && last && last !== lastSeen && typeof Notification !== 'undefined' && Notification.permission === 'granted') notify('שיחה חדשה עם מלון נקלטה', 'פותחים את סקר המלונות לראות מה נכנס');
      lastSeen = last;
      const sig = JSON.stringify([last, (j.surveys || []).map(x => [x.id, x.count, x.avail, x.follow, x.updatedAt || x.title])]);
      const busy = document.activeElement?.matches?.('input, textarea, select') || document.querySelector('#page form:not(.hs-look__f), .hs-wiz, .hs-look__out:not(:empty), dialog[open]');
      if (sig === pollSig || busy) { if (!busy) pollSig = sig; return; }   // nothing new, or a form is open: try again next time
      const first = pollSig === null; pollSig = sig;
      if (first) return;
      home = j;
      if (cur) { try { cur = await api('GET', '?survey=' + encodeURIComponent(cur.survey.id)); } catch (e) {} }
      const y = scrollY; again(); requestAnimationFrame(() => scrollTo(0, y));
    } catch (e) {}
  }, 30e3);
}
async function copy(text, ok) { try { await navigator.clipboard.writeText(text); ctx.toast(ok); } catch (e) { prompt('העתיקו:', text); } }

/* ---------- one survey ---------- */
let compareOpen = false, offerLink = null;   // owner 24.11: the comparison for a client opens only on request
let editSurvey = false, shareOpen = false, addOpen = false, addPrefill = null, lookOpen = false;
function surveyView(pg) {
  const { survey: sv, hotels } = cur;
  const head = h(`<section class="card hs-head">
    <button type="button" class="hs-back" data-back>→ כל הכרטיסיות</button>
    <div class="hs-head__t"><h2>${esc(sv.title)}</h2>
      <p>${sv.kind ? esc(sv.kind) + ' · ' : ''}${sv.from ? 'תאריך: ' + dmy(sv.from) + (sv.to && sv.to !== sv.from ? ' – ' + dmy(sv.to) : '') : 'בלי תאריכים'}${sv.area ? ' · ' + esc(sv.area) : ''}${sv.need ? ' · ' + esc(sv.need) : ''}</p></div>
    <div class="hs-tools">
      ${sv.manage && hotels.length ? `<button class="btn btn--${compareOpen ? 'gold' : 'line'} btn--sm" type="button" data-cmp>השוואה ללקוח</button>` : ''}
      <button class="btn btn--gold btn--sm" type="button" data-wa>סיכום לוואטסאפ</button>
      ${safeUrl(sv.sheetUrl) ? `<a class="btn btn--line btn--sm" href="${esc(sv.sheetUrl)}" target="_blank" rel="noopener">הגיליון בגוגל</a>` : ''}
      <button class="btn btn--${exportOpen ? 'gold' : 'line'} btn--sm" type="button" data-csv>ייצוא לגיליון</button>
      ${hotels.length ? '<button class="btn btn--line btn--sm" type="button" data-sumsheet>גיליון מסוכם</button>' : ''}
      ${sv.manage ? '<button class="btn btn--line btn--sm" type="button" data-share>שיתוף</button><button class="btn btn--line btn--sm" type="button" data-edit>עריכה</button>' : ''}
    </div>
  </section>`);
  $('[data-cmp]', head)?.addEventListener('click', () => { compareOpen = !compareOpen; offerLink = null; openHotel = null; again(); });
  $('[data-back]', head).addEventListener('click', () => { compareOpen = false; exportOpen = false; offerLink = null; openSurvey = null; cur = null; openHotel = null; addOpen = false; lookOpen = false; look = { text: '', results: null, open: null }; again(); });
  $('[data-wa]', head).addEventListener('click', () => { const t = waSummary(sv, hotels); window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank'); });
  $('[data-csv]', head).addEventListener('click', () => { exportOpen = !exportOpen; again(); });
  // owner 25.11: the summary sheet (site, photos, price, availability, one line) one click away, not hidden inside the export
  $('[data-sumsheet]', head)?.addEventListener('click', () => downloadSummary(sv, hotels, exportPref || sv.prefDate || sv.from || ''));
  $('[data-share]', head)?.addEventListener('click', () => { shareOpen = !shareOpen; again(); });
  $('[data-edit]', head)?.addEventListener('click', () => { editSurvey = !editSurvey; again(); });
  pg.append(head);
  if (editSurvey) pg.append(surveyForm(sv));
  if (shareOpen && sv.manage) pg.append(shareCard(sv));
  if (exportOpen) pg.append(exportCard(sv, hotels));
  if (compareOpen && sv.manage) { pg.append(compareCard(sv, hotels)); return; }

  if (openHotel) { const ho = hotels.find(x => x.id === openHotel); if (ho) return pg.append(hotelView(sv, ho)); openHotel = null; }
  const booked = hotels.filter(x => x.booked);
  if (booked.length) {
    const end = sv.to || sv.from || '', passed = !!end && end < new Date().toISOString().slice(0, 10);
    for (const x of booked) if (passed && sv.manage && !x.after && !x.afterSkip) pg.append(afterCard(sv, x));
    const bc = h(`<section class="card hs-bookedcard"><h3>סגרנו עם</h3><div class="hs-wait__btns">${booked.map(x => `<button type="button" class="btn btn--line btn--sm" data-ho="${esc(x.id)}">${esc(x.name || 'בלי שם')}</button>`).join('')}</div></section>`);
    $$('[data-ho]', bc).forEach(b => b.addEventListener('click', () => { openHotel = b.dataset.ho; again(); scrollTo({ top: 0 }); }));
    pg.append(bc);
  }

  // The two main actions inside a card
  const acts = h(`<section class="hs-acts">
    <button type="button" class="hs-act ${addOpen ? 'on' : ''}" data-a="add"><b>+ הוספת מלון</b><span>שם וטלפון, השאר מתמלא מהשיחה</span></button>
    ${sv.manage ? `<button type="button" class="hs-act ${importOpen ? 'on' : ''}" data-a="imp"><b>+ מהמאגר שלי</b><span>מלונות ואולמות שכבר דיברנו איתם</span></button>` : ''}
  </section>`);
  $('[data-a=add]', acts).addEventListener('click', () => { addOpen = !addOpen; importOpen = false; addPrefill = null; lookOpen = false; again(); });
  $('[data-a=imp]', acts)?.addEventListener('click', () => { importOpen = !importOpen; addOpen = false; again(); });
  pg.append(lookupCard());
  pg.append(acts);
  if (addOpen) pg.append(hotelForm(sv, null));
  if (importOpen && sv.manage) pg.append(importCard(sv, hotels));

  // Search across everything that was said and written
  const bar = h(`<section class="hs-bar">
    <div class="hs-chips">${[['all', 'הכול'], ['avail', 'יש מקום'], ['followup', 'לחזור אליהם'], ['waiting', 'מחכים להצעה'], ['full', 'תפוס']].map(([k, n]) => `<button type="button" class="chip ${filter === k ? 'on' : ''}" data-f="${k}">${n}</button>`).join('')}
      <select class="hs-sort" aria-label="מיון">${[['price', 'לפי מחיר'], ['recent', 'לפי עדכון אחרון'], ['name', 'לפי שם']].map(([k, n]) => `<option value="${k}" ${sortBy === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
  </section>`);
  $$('[data-f]', bar).forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; $$('[data-f]', bar).forEach(x => x.classList.toggle('on', x === b)); drawList(); }));
  $('.hs-sort', bar).addEventListener('change', e => { sortBy = e.target.value; drawList(); });
  pg.append(bar);
  const listEl = h('<section class="hs-list"></section>');
  pg.append(listEl);
  function drawList() {
    listEl.innerHTML = '';
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let rows = hotels.filter(x => filter === 'all' || (filter === 'avail' ? ['available', 'partial'].includes(x.avail) : filter === 'full' ? x.avail === 'full' : x.status === filter));
    const hits = new Map();
    if (words.length) rows = rows.filter(x => { const m = searchHotel(x, words); if (m) hits.set(x.id, m); return !!m; });
    rows.sort(sortBy === 'name' ? (a, b) => a.name.localeCompare(b.name, 'he') : sortBy === 'recent' ? (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') : (a, b) => (a.min ?? 1e12) - (b.min ?? 1e12));
    if (!hotels.length) listEl.append(h(`<p class="hint hint--box">עוד אין מלונות בכרטיסייה. לוחצים "הוספת מלון", או מדליקים "מצב בדיקה" למעלה ומתקשרים: כל שיחה עם מלון נכנסת לכאן לבד אחרי כמה דקות.</p>`));
    else if (!rows.length) listEl.append(h('<p class="hint">לא נמצא כלום.</p>'));
    for (const x of rows) {
      const [an, ac] = avOf(x, sv);
      const calls = (x.log || []).filter(l => l.t === 'call').length, mails = (x.log || []).filter(l => l.t === 'mail-in' || l.t === 'mail-out').length;
      const card = h(`<button type="button" class="hs-ho">
        <div class="hs-ho__top"><b>${esc(x.name || 'בלי שם')}</b>${x.rating ? `<span class="hs-rate">${rateTxt(x)}</span>` : ''}<span class="pill pill--${ac}">${an}</span></div>
        <div class="hs-ho__sub">${esc(x.city)}${x.contact ? ' · ' + esc(x.contact) : ''}${x.phone ? ' · <bdi>' + esc(x.phone) + '</bdi>' : ''}</div>
        ${x.prices?.length ? `<div class="hs-ho__pr">${x.prices.slice(0, 4).map(p => `<span>${esc([p.level, p.board].filter(Boolean).join(' · ') || 'מחיר')}: <b>${money(p.price, p.currency)}</b>${p.per ? ' ' + esc(p.per) : ''}</span>`).join('')}${x.prices.length > 4 ? `<span>+${x.prices.length - 4}</span>` : ''}</div>` : '<div class="hs-ho__pr muted">עוד אין מחירים</div>'}
        ${hits.get(x.id) ? `<div class="hs-ho__hit">${hits.get(x.id)}</div>` : x.summary ? `<div class="hs-ho__sum">${esc(x.summary)}</div>` : ''}
        <div class="hs-ho__foot"><span class="st st--${x.status}">${ST[x.status] || ''}</span>${x.followUp ? `<span>לחזור ב-${dmy(x.followUp)}</span>` : ''}<span>${calls} שיחות · ${mails} מיילים</span></div>
      </button>`);
      card.addEventListener('click', () => { openHotel = x.id; again(); scrollTo({ top: 0 }); });
      listEl.append(card);
    }
  }
  drawList();
}

/** Where the words appear in this hotel (fields, calls, e-mails, notes) → a short highlighted line, or null. */
function searchHotel(x, words) {
  const fields = [x.name, x.city, x.contact, x.phone, x.phone2, x.email, x.availText, x.summary, x.notes, ...(x.prices || []).map(p => `${p.level} ${p.board} ${p.price} ${p.per} ${p.note}`)].join(' ').toLowerCase();
  const logs = (x.log || []).flatMap(l => [...(l.quotes || []).map(q => ({ l, text: `[${q.time}] ${q.text}` })), { l, text: [l.summary, l.availText, l.subject, l.body, l.text].filter(Boolean).join(' ') }, { l, text: l.transcript || '' }]);
  const all = fields + ' ' + logs.map(o => o.text.toLowerCase()).join(' ');
  if (!words.every(w => all.includes(w))) return null;
  for (const o of logs) {
    const low = o.text.toLowerCase(), i = low.indexOf(words[0]);
    if (i >= 0) {
      const part = o.text.slice(Math.max(0, i - 50), i + 90);
      const kind = o.l.t === 'call' ? 'בשיחה' : o.l.t === 'mail-in' ? 'במייל מהמלון' : o.l.t === 'mail-out' ? 'במייל שנשלח' : 'בהערה';
      return `${kind} מ-${when(o.l.at)}: …${mark(part, words)}…`;
    }
  }
  return null;
}
const mark = (text, words) => { let s = esc(text); for (const w of words) s = s.replace(new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), m => `<mark>${m}</mark>`); return s; };

function shareCard(sv) {
  const mates = (home.managers || []).filter(m => m.id !== sv.by?.id);
  const link = sv.token ? `${location.origin}/hotels/?id=${sv.id}&t=${sv.token}` : '';
  const c = h(`<section class="card"><h2>שיתוף</h2><p class="hint">הצוות לא רואה את הסקר עד שמשתפים. רק הבעלים ומי שפתח את הסקר יכולים לשתף.</p>
    <div class="hs-mates">${mates.length ? mates.map(m => `<label class="hs-check"><input type="checkbox" value="${esc(m.id)}" ${(sv.shared || []).includes(m.id) ? 'checked' : ''}><span>${esc(m.name)}</span></label>`).join('') : '<p class="hint">אין עוד מנהלים באתר.</p>'}</div>
    <label class="hs-check"><input type="checkbox" data-link ${sv.link ? 'checked' : ''}><span>קישור צפייה בלבד (בלי כניסה, בלי הקלטות ובלי מיילים) לשליחה לקבוצה</span></label>
    ${link ? `<p class="hs-key"><code>${esc(link)}</code><button class="btn btn--line btn--sm" type="button" data-cl>העתקה</button><a class="btn btn--line btn--sm" target="_blank" href="https://wa.me/?text=${encodeURIComponent(sv.title + '\n' + link)}">לוואטסאפ</a></p>` : ''}
    <div class="row-tools"><button class="btn btn--gold btn--sm" type="button" data-save>שמירת השיתוף</button></div></section>`);
  $('[data-cl]', c)?.addEventListener('click', () => copy(link, 'הקישור הועתק'));
  $('[data-save]', c).addEventListener('click', async () => {
    try {
      const users = $$('.hs-mates input:checked', c).map(i => i.value);
      const r = await api('POST', '', { op: 'share', surveyId: sv.id, users, link: $('[data-link]', c).checked });
      Object.assign(cur.survey, { shared: r.shared, link: r.link, token: r.token }); ctx.toast('השיתוף נשמר'); again();
    } catch (e) { fail(e); }
  });
  return c;
}

/* ---------- one hotel: details, prices, history, e-mail ---------- */
function hotelForm(sv, x) {
  const v = x || { name: '', city: '', contact: '', phone: '', email: '', ...(addPrefill || {}), avail: 'unknown', availText: '', rooms: '', prices: [], status: 'new', followUp: '', followWhat: '', notes: '' };
  const f = h(`<form class="card hs-form">
    ${x ? '' : '<h2>הוספת מלון</h2>'}
    <div class="grid2">
      <label class="field"><span>שם המלון</span><input name="name" required value="${esc(v.name)}"></label>
      <label class="field"><span>עיר / מקום</span><input name="city" value="${esc(v.city)}"></label>
      <label class="field"><span>איש קשר</span><input name="contact" value="${esc(v.contact)}"></label>
      <label class="field"><span>טלפון</span><input name="phone" type="tel" dir="ltr" value="${esc(v.phone)}"></label>
      <label class="field"><span>מייל</span><input name="email" type="email" dir="ltr" value="${esc(v.email)}"></label>
    </div>
    ${x ? '' : '<details class="hs-more"><summary>עוד: זמינות, מחירים והערות (אפשר אחר כך)</summary>'}
    <div class="grid2">
      <label class="field"><span>כמה חדרים יש</span><input name="rooms" value="${esc(v.rooms)}"></label>
      <label class="field"><span>זמינות</span><select name="avail">${Object.entries(AV).map(([k, [n]]) => `<option value="${k}" ${v.avail === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="field"><span>סטטוס</span><select name="status">${Object.entries(ST).map(([k, n]) => `<option value="${k}" ${v.status === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="field"><span>לחזור אליהם בתאריך</span><input name="followUp" type="date" value="${esc(v.followUp)}"></label>
      <label class="field"><span>מה לבדוק כשחוזרים</span><input name="followWhat" value="${esc(v.followWhat)}"></label>
    </div>
    <label class="field"><span>פירוט זמינות</span><input name="availText" value="${esc(v.availText)}"></label>
    <div class="field"><span>מחירים לפי רמות</span>
      <div class="hs-prices"></div>
      <button class="btn btn--line btn--sm" type="button" data-addp>+ שורת מחיר</button>
    </div>
    <label class="field"><span>הערות</span><textarea name="notes" rows="3">${esc(v.notes)}</textarea></label>
    ${x ? '' : '</details>'}
    <div class="row-tools"><button class="btn btn--gold" type="submit">${x ? 'שמירה' : 'הוספה לכרטיסייה'}</button>${x ? '' : '<button class="btn btn--line" type="button" data-x>ביטול</button>'}</div>
  </form>`);
  const box = $('.hs-prices', f);
  const levels = sv.levels?.length ? sv.levels : ['רגיל', 'משודרג', 'סוויטה'];
  const addRow = p => {
    const r = h(`<div class="hs-prow">
      <input list="hs-lv" placeholder="רמה" value="${esc(p.level)}" data-k="level">
      <input list="hs-bd" placeholder="לינה" value="${esc(p.board)}" data-k="board">
      <input inputmode="decimal" placeholder="מחיר" value="${p.price ?? ''}" data-k="price" dir="ltr">
      <select data-k="currency">${['ILS', 'EUR', 'USD'].map(c => `<option ${p.currency === c ? 'selected' : ''} value="${c}">${{ ILS: '₪', EUR: '€', USD: '$' }[c]}</option>`).join('')}</select>
      <input placeholder="לזוג ללילה / לאדם…" value="${esc(p.per)}" data-k="per">
      <input placeholder="הערה" value="${esc(p.note)}" data-k="note">
      <button type="button" class="icon icon--del" aria-label="מחיקה">✕</button></div>`);
    $('.icon--del', r).addEventListener('click', () => r.remove());
    box.append(r);
  };
  box.append(h(`<datalist id="hs-lv">${levels.map(l => `<option value="${esc(l)}">`).join('')}</datalist>`), h(`<datalist id="hs-bd">${BOARDS.map(l => `<option value="${esc(l)}">`).join('')}</datalist>`));
  (v.prices?.length ? v.prices : [{ level: levels[0], board: '', price: null, currency: 'ILS', per: '', note: '' }]).forEach(addRow);
  $('[data-addp]', f).addEventListener('click', () => addRow({ level: '', board: '', price: null, currency: 'ILS', per: '', note: '' }));
  $('[data-x]', f)?.addEventListener('click', () => { addOpen = false; again(); });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    d.prices = $$('.hs-prow', f).map(r => Object.fromEntries($$('[data-k]', r).map(i => [i.dataset.k, i.value])));
    try {
      const saved = await api('POST', '', { op: 'hotel', surveyId: sv.id, id: x?.id, ...d });
      addOpen = false; addPrefill = null; await refreshSurvey(); openHotel = saved.id; ctx.toast('נשמר'); again();
      const found = d.phone && !x ? (phoneFind(d.phone) || []).filter(y => y.rec && !y.sent) : [];
      if (found.length) setTimeout(() => { const host = $('.hs-hotel') || $('#hs-look')?.parentElement; if (host) host.prepend(phoneRecsBox(d.phone, found, `רגע: עם המספר הזה כבר יש ${found.length === 1 ? 'הקלטה' : found.length + ' הקלטות'} בטלפון. להביא ${found.length === 1 ? 'אותה' : 'אותן'}?`)); }, 300);
    } catch (e2) { fail(e2); }
  });
  return f;
}

let mailOpen = false, mailDraft = null;
function hotelView(sv, x) {
  const wrap = h('<div class="hs-hotel"></div>');
  const [an, ac] = avOf(x, sv);
  const head = h(`<section class="card hs-hhead">
    <button type="button" class="hs-back" data-back>→ כל המלונות</button>
    <div class="hs-hhead__t"><h2>${esc(x.name || 'בלי שם')}</h2><span class="pill pill--${ac}">${an}</span><span class="st st--${x.status}">${ST[x.status]}</span></div>
    <p>${esc(x.city)}${x.contact ? ' · ' + esc(x.contact) : ''}${x.availText ? ' · ' + esc(x.availText) : ''}</p>
    ${x.about ? `<p class="hs-about">${esc(x.about)}</p>` : ''}
    ${safeUrl(x.website) ? `<p class="hs-site">האתר של המקום: <a href="${esc(x.website)}" target="_blank" rel="noopener"><bdi>${esc(siteName(x.website))}</bdi></a></p>` : ''}
    ${x.rating || x.reviewsText ? `<div class="hs-rev">${x.rating ? `<b class="hs-rate">${rateTxt(x)}</b><span>${x.reviewsCount ? x.reviewsCount.toLocaleString('he-IL') + ' ביקורות' : 'דירוג'} ב${esc(x.reviewsSource || 'גוגל')}</span>` : ''}${x.reviewsText ? `<p>${esc(x.reviewsText)}</p>` : ''}${safeUrl(x.reviewsUrl) ? `<a href="${esc(x.reviewsUrl)}" target="_blank" rel="noopener">לכל הביקורות</a>` : ''}</div>` : ''}
    <div class="hs-photos">${[...(x.myPhotos || []), ...(x.photos || []).filter(safeUrl)].map(u => `<figure class="hs-ph"><a href="${esc(photoSrc(u))}" target="_blank" rel="noopener"><img src="${esc(photoSrc(u))}" alt="" loading="lazy" referrerpolicy="no-referrer"></a><button type="button" class="hs-ph__x" data-rm="${esc(u)}" aria-label="להסיר את התמונה">×</button></figure>`).join('')}
      <label class="hs-ph hs-ph--add"><input type="file" accept="image/*" multiple hidden><span>+ להוסיף תמונות</span></label></div>
    ${(x.myPhotos || []).length || (x.photos || []).length ? '' : `<p class="hs-ph__hint">${x.webDone ? 'לא מצאתי תמונות של המלון ברשת.' : 'תמונות מהרשת יגיעו לבד תוך כמה דקות.'} אפשר גם להוסיף תמונות מהטלפון או מהמחשב.</p>`}
    ${x.relisten ? '<p class="hs-mailnow">קורא את השיחה מחדש. הכרטיס יתעדכן כאן תוך כמה דקות.</p>' : ''}
    ${x.mailAsk ? '<p class="hs-mailnow">בודק את המייל של LBV על המלון הזה. התשובה תופיע כאן תוך כמה דקות.</p>'
      : x.mailAskDone ? `<p class="hs-mailnow">נבדק במייל ${esc(new Date(x.mailAskDone.at).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }))}: ${x.mailAskDone.found ? (x.mailAskDone.found === 1 ? 'נמצא מייל אחד, הוא בהיסטוריה' : 'נמצאו ' + x.mailAskDone.found + ' מיילים, הם בהיסטוריה') : (x.mailAskDone.by === 'email' ? 'לא נמצאו מיילים עם הכתובת של המלון' : 'לא נמצאו מיילים עם השם או המספר של המלון')}.</p>` : ''}
    <div class="hs-tools">
      ${x.phone ? `<a class="btn btn--dark btn--sm" href="tel:${esc(x.phone.replace(/[^\d+]/g, ''))}">להתקשר <bdi>${esc(x.phone)}</bdi></a>` : ''}
      <button class="btn btn--gold btn--sm" type="button" data-mail>מייל למלון</button>
      <button class="btn btn--line btn--sm" type="button" data-mailnow ${x.mailAsk ? 'disabled' : ''}>${x.mailAsk ? 'בודק במייל…' : 'לבדוק במייל'}</button>
      <button class="btn btn--line btn--sm" type="button" data-paste>להדביק הצעת מחיר או הודעה</button>
      ${(x.log || []).some(l => l.t === 'call') ? `<button class="btn btn--line btn--sm" type="button" data-relisten ${x.relisten ? 'disabled' : ''}>${x.relisten ? 'קורא את השיחה מחדש…' : 'לקרוא את השיחה מחדש'}</button>` : ''}
      ${safeUrl(x.website) ? `<a class="btn btn--line btn--sm" href="${esc(x.website)}" target="_blank" rel="noopener">לאתר של המלון</a>` : ''}
      ${sv.manage && moveTargets(sv).length ? `<button class="btn btn--line btn--sm" type="button" data-move>להעביר לכרטיסייה אחרת</button><button class="btn btn--line btn--sm" type="button" data-dup>לשכפל לכרטיסייה אחרת</button>` : ''}
      ${sv.manage ? (x.booked ? '<button class="btn btn--line btn--sm" type="button" data-book="0">לבטל "סגרנו איתו"</button>' : '<button class="btn btn--gold btn--sm" type="button" data-book="1">סגרתי עם המקום הזה</button>') : ''}
      <label class="btn btn--line btn--sm" data-vid><input type="file" accept="video/mp4,video/quicktime,video/*" hidden><span>+ להוסיף סרטון</span></label>
      <button class="btn btn--line btn--sm" type="button" data-one>גיליון של המקום הזה</button>
      <button class="btn btn--line btn--sm" type="button" data-onesum>תקציר של המקום הזה</button>
      ${sv.manage ? '<button class="btn btn--danger btn--sm" type="button" data-del>מחיקת המלון</button>' : ''}
    </div>
    ${x.booked ? `<p class="hs-booked">סגרנו עם המקום הזה לאירוע${dmy(x.booked.slice(0, 10)) ? ' (סומן ב-' + dmy(x.booked.slice(0, 10)) + ')' : ''}.</p>` : ''}
    ${x.after ? `<p class="hs-after"><b>אחרי האירוע:</b> ${esc(x.after.text)}</p>` : ''}
    ${moveOpen === x.id ? `<div class="hs-move"><p>${moveMode === 'dup' ? `לאיזו כרטיסייה לשכפל את "${esc(x.name || 'המקום')}"? הוא יישאר גם כאן, ויופיע גם שם עם כל השיחות, המיילים וההערות.` : `לאיזו כרטיסייה להעביר את "${esc(x.name || 'המקום')}"? הוא עובר עם כל השיחות, המיילים וההערות.`}</p><div class="hs-wait__btns">${moveTargets(sv).map(t => `<button class="btn btn--gold btn--sm" type="button" data-to="${esc(t.id)}">${esc(t.title)}${t.from ? ' · ' + dmy(t.from) : ''}</button>`).join('')}<button class="btn btn--line btn--sm" type="button" data-nomove>ביטול</button></div></div>` : ''}
  </section>`);
  $('[data-move]', head)?.addEventListener('click', () => { moveOpen = moveOpen === x.id && moveMode === 'move' ? null : x.id; moveMode = 'move'; again(); });
  $('[data-dup]', head)?.addEventListener('click', () => { moveOpen = moveOpen === x.id && moveMode === 'dup' ? null : x.id; moveMode = 'dup'; again(); });
  $('[data-nomove]', head)?.addEventListener('click', () => { moveOpen = null; again(); });
  head.querySelectorAll('[data-to]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      if (moveMode === 'dup') {   // owner 24.11: the same place in two cards (e.g. the wedding and the שבת חתן)
        const r = await api('POST', '', { op: 'copy', surveyId: b.dataset.to, fromSurvey: sv.id, id: x.id, keep: true });
        moveOpen = null; await refreshHome();
        ctx.toast(r.already ? 'הוא כבר נמצא ב"' + r.toTitle + '"' : 'שוכפל ל"' + r.toTitle + '". הוא נמצא בשתיהן'); again(); return;
      }
      const r = await api('POST', '', { op: 'move', surveyId: sv.id, id: x.id, toSurvey: b.dataset.to });
      moveOpen = null; openHotel = null; await refreshSurvey(); await refreshHome();
      ctx.toast('הועבר ל"' + r.toTitle + '"'); again();
    } catch (e2) { fail(e2); b.disabled = false; }
  }));
  $('[data-book]', head)?.addEventListener('click', async e => {
    const on = e.currentTarget.dataset.book === '1';
    if (!on && !confirm('לבטל את הסימון שסגרתם עם המקום הזה?')) return;
    try { await api('POST', '', { op: 'booked', surveyId: sv.id, id: x.id, on }); await refreshSurvey(); await refreshHome(); ctx.toast(on ? 'סומן: סגרתם עם "' + (x.name || 'המקום') + '"' : 'הסימון בוטל'); again(); } catch (e2) { fail(e2); }
  });
  $('[data-back]', head).addEventListener('click', () => { openHotel = null; mailOpen = false; pasteOpen = false; again(); });
  $('[data-paste]', head).addEventListener('click', () => { pasteOpen = !pasteOpen; again(); });
  $('[data-relisten]', head)?.addEventListener('click', async () => {
    if (!confirm('לקרוא את השיחה מחדש? אם דיברו בה על כמה מקומות, כל מקום יקבל כרטיס משלו, והמחירים מהקריאה הקודמת יוחלפו.')) return;
    try { await api('POST', '', { op: 'relisten', surveyId: sv.id, id: x.id }); await refreshSurvey(); ctx.toast('קורא את השיחה מחדש. זה ייקח כמה דקות'); again(); } catch (e2) { fail(e2); }
  });
  $('[data-mailnow]', head).addEventListener('click', async () => {
    try { await api('POST', '', { op: 'mailNow', surveyId: sv.id, id: x.id }); await refreshSurvey(); ctx.toast('בודק במייל. התשובה תגיע תוך כמה דקות'); again(); } catch (e2) { fail(e2); }
  });
  head.querySelectorAll('.hs-photos img').forEach(img => img.addEventListener('error', () => img.closest('.hs-ph').remove()));
  // add photos: from the phone (gallery / camera) or the computer
  $('.hs-ph--add input', head).addEventListener('change', async e => {
    const files = [...e.target.files].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name)).slice(0, 12);
    if (!files.length) return;
    if (!ctx.upload) return ctx.toast('אי אפשר להעלות מכאן', 'err');
    const lab = $('.hs-ph--add span', head); lab.textContent = `מעלה ${files.length === 1 ? 'תמונה' : files.length + ' תמונות'}…`;
    try {
      const urls = [];
      for (const f of files) { if (f.size > 25 * 1024 * 1024) { ctx.toast('תמונה גדולה מדי (עד 25MB)', 'err'); continue; } urls.push(await ctx.upload(f)); }
      if (urls.length) { await api('POST', '', { op: 'photos', surveyId: sv.id, id: x.id, add: urls }); await refreshSurvey(); ctx.toast(urls.length === 1 ? 'התמונה נוספה' : 'התמונות נוספו'); again(); }
    } catch (e2) { fail(e2); lab.textContent = '+ להוסיף תמונות'; }
  });
  head.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('להסיר את התמונה מהמלון?')) return;
    try { await api('POST', '', { op: 'photos', surveyId: sv.id, id: x.id, remove: [b.dataset.rm] }); await refreshSurvey(); again(); } catch (e2) { fail(e2); }
  }));
  $('[data-mail]', head).addEventListener('click', async () => {
    mailOpen = !mailOpen;
    if (mailOpen) { try { mailDraft = await api('POST', '', { op: 'draft', surveyId: sv.id, id: x.id }); } catch (e) { fail(e); } }
    again();
  });
  // owner 25.11: a video of the place (from WhatsApp / the phone): saved in our storage, shown in the history with a "watch" button
  $('[data-vid] input', head)?.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    if (!ctx.upload) return ctx.toast('אי אפשר להעלות מכאן', 'err');
    if (f.size > 100 * 1024 * 1024) return ctx.toast('הסרטון גדול מדי (עד 100MB)', 'err');
    const lab = $('[data-vid] span', head); lab.textContent = 'מעלה את הסרטון…';
    try {
      const url = await ctx.upload(f);
      await api('POST', '', { op: 'note', surveyId: sv.id, id: x.id, text: 'סרטון של המקום', files: [{ name: 'לצפייה בסרטון', url }] });
      await refreshSurvey(); ctx.toast('הסרטון נוסף'); again();
    } catch (e2) { fail(e2); lab.textContent = '+ להוסיף סרטון'; }
  });
  // owner 25.11: the sheet / the summary of this one place only
  const one = { ...sv, title: sv.title + ' - ' + (x.name || 'מקום') };
  $('[data-one]', head)?.addEventListener('click', () => downloadCsv(one, [x], exportPref || sv.prefDate || sv.from || ''));
  $('[data-onesum]', head)?.addEventListener('click', () => downloadSummary(one, [x], exportPref || sv.prefDate || sv.from || ''));
  $('[data-del]', head)?.addEventListener('click', async () => {
    if (!confirm(`למחוק את "${x.name}" עם כל השיחות והמיילים שלו? אי אפשר לבטל.`)) return;
    try { await api('DELETE', `?survey=${sv.id}&hotel=${x.id}`); openHotel = null; await refreshSurvey(); again(); ctx.toast('נמחק'); } catch (e) { fail(e); }
  });
  wrap.append(head);
  if (mailOpen && mailDraft) wrap.append(mailForm(sv, x));
  if (pasteOpen) wrap.append(pasteForm(sv, x));

  const cols = h('<div class="hs-cols"></div>');
  cols.append(timeline(sv, x));
  const side = h('<div></div>');
  if (x.summary) side.append(h(`<section class="card hs-sumcard"><h3>סיכום אחרון</h3><p>${esc(x.summary)}</p>${x.followUp || x.followWhat ? `<p class="hs-follow">לחזור${x.followUp ? ' ב-' + dmy(x.followUp) : ''}${x.followWhat ? ': ' + esc(x.followWhat) : ''}</p>` : ''}</section>`));
  side.append(hotelForm(sv, x));
  cols.append(side);
  wrap.append(cols);
  return wrap;
}

/* ---------- owner 25.11: after the event: how it was at the place we closed with (notes + photos) ---------- */
function afterCard(sv, x) {
  const c = h(`<section class="card hs-aftercard">
    <div class="card__head"><div><h2>האירוע עבר. איך היה ב"${esc(x.name || 'המקום')}"?</h2><p>מה היה טוב, מה פחות, ומה לזכור לפעם הבאה. זה נשמר עם המקום ויופיע במאגר כשתחפשו אותו שוב.</p></div></div>
    <textarea class="input" rows="4" maxlength="2000" placeholder="למשל: השירות היה מצוין, האוכל חם, האולם קטן ל-250. לבקש מראש את החדר הצדדי."></textarea>
    <div class="hs-wait__btns"><button class="btn btn--gold btn--sm" type="button" data-save>לשמור</button>
      <label class="btn btn--line btn--sm"><input type="file" accept="image/*" multiple hidden><span>להוסיף תמונות מהאירוע</span></label>
      <button class="btn btn--line btn--sm" type="button" data-skip>לא עכשיו</button></div>
  </section>`);
  $('[data-save]', c).addEventListener('click', async e => {
    const text = $('textarea', c).value.trim();
    if (text.length < 2) { ctx.toast('כתבו כמה מילים על המקום', 'err'); return; }
    e.target.disabled = true;
    try { await api('POST', '', { op: 'after', surveyId: sv.id, id: x.id, text }); await refreshSurvey(); await refreshHome(); ctx.toast('נשמר עם המקום'); again(); } catch (e2) { fail(e2); e.target.disabled = false; }
  });
  $('[data-skip]', c).addEventListener('click', async () => {
    try { await api('POST', '', { op: 'after', surveyId: sv.id, id: x.id, skip: true }); await refreshSurvey(); await refreshHome(); again(); } catch (e2) { fail(e2); }
  });
  $('input[type=file]', c).addEventListener('change', async e => {
    const files = [...e.target.files].filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name)).slice(0, 12);
    if (!files.length) return;
    if (!ctx.upload) return ctx.toast('אי אפשר להעלות מכאן', 'err');
    const lab = $('label span', c); lab.textContent = 'מעלה…';
    try {
      const urls = [];
      for (const f of files) { if (f.size > 25 * 1024 * 1024) { ctx.toast('תמונה גדולה מדי (עד 25MB)', 'err'); continue; } urls.push(await ctx.upload(f)); }
      if (urls.length) { await api('POST', '', { op: 'photos', surveyId: sv.id, id: x.id, add: urls }); ctx.toast(urls.length === 1 ? 'התמונה נוספה למקום' : 'התמונות נוספו למקום'); }
      lab.textContent = urls.length ? 'נוספו ' + urls.length + '. להוסיף עוד' : 'להוסיף תמונות מהאירוע';
    } catch (e2) { fail(e2); lab.textContent = 'להוסיף תמונות מהאירוע'; }
  });
  return c;
}

/* ---------- owner 24.11: import places from my catalogs (hotels + halls) into this card ---------- */
let importOpen = false, impData = null, impQ = '', impKind = '';
function importCard(sv, hotels) {
  const box = h('<section class="card hs-imp"><div class="card__head"><div><h2>לייבא מהמאגר שלי</h2><p>מסמנים את המקומות שרוצים בכרטיסייה הזאת. הם נכנסים עם הפרטים, התמונות וההיסטוריה. הזמינות מתחילה כ"לא ידוע", עד שמתקשרים לתאריך הזה.</p></div></div><p class="hint">טוען…</p></section>');
  const hall = /אולם|חתונ/.test((sv.kind || '') + ' ' + (sv.title || ''));
  if (!impKind) impKind = hall ? 'venues' : 'hotels';
  (async () => {
    try {
      if (!impData) { const [a, b] = await Promise.all([api('GET', '?catalog=1'), api('GET', '?catalog=venues')]); impData = { hotels: a.hotels || [], venues: b.hotels || [] }; }
    } catch (e) { fail(e); return; }
    box.querySelector('.hint')?.remove();
    const has = x => x.surveys.some(s => s.surveyId === sv.id) || hotels.some(y => (y.phone && x.phone && y.phone.replace(/\D/g, '').slice(-9) === x.phone.replace(/\D/g, '').slice(-9)) || (y.name && y.name === x.name));
    const bar = h(`<div class="hs-imp__bar"><input class="input" type="search" placeholder="שם, עיר או אזור" value="${esc(impQ)}" aria-label="חיפוש במאגר">
      <div class="hs-chips">${[['hotels', 'מלונות'], ['venues', 'אולמות']].map(([k, n]) => `<button type="button" class="chip ${impKind === k ? 'on' : ''}" data-k="${k}">${n}</button>`).join('')}</div></div>`);
    const list = h('<div class="hs-imp__list"></div>');
    const go = h('<div class="hs-wait__btns"><button class="btn btn--gold btn--sm" type="button" data-go disabled>לייבא</button><button class="btn btn--line btn--sm" type="button" data-close>סגירה</button></div>');
    const picked = new Map();
    const count = () => { const b = $('[data-go]', go); b.disabled = !picked.size; b.textContent = picked.size ? (picked.size === 1 ? 'לייבא מקום אחד' : 'לייבא ' + picked.size + ' מקומות') : 'לייבא'; };
    const draw = () => {
      const words = impQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const rows = (impData[impKind] || []).filter(x => words.every(w => [x.name, x.city, x.area, x.contact].join(' ').toLowerCase().includes(w))).sort((a, b) => (has(a) - has(b)) || a.name.localeCompare(b.name, 'he'));
      list.innerHTML = rows.length ? '' : '<p class="hint">לא נמצא במאגר.</p>';
      for (const x of rows) {
        const there = has(x), ph = photoSrc(x.photo) || "";
        const row = h(`<label class="hs-imp__row"><input type="checkbox" ${there ? 'disabled checked' : picked.has(x.key) ? 'checked' : ''}>${ph ? `<img src="${esc(ph)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<i class="hs-imp__ph"></i>'}<span><b>${esc(x.name)}</b><small>${esc([x.city, x.min ? 'מ-' + money(x.min.price, x.min.currency) + ' ' + (x.min.per || '') : '', there ? 'כבר בכרטיסייה' : ''].filter(Boolean).join(' · '))}</small></span></label>`);
        $('img', row)?.addEventListener('error', e => { e.target.replaceWith(h('<i class="hs-imp__ph"></i>')); });
        $('input', row).addEventListener('change', e => { if (e.target.checked) picked.set(x.key, x); else picked.delete(x.key); count(); });
        list.append(row);
      }
    };
    $('input', bar).addEventListener('input', e => { impQ = e.target.value; draw(); });
    $$('[data-k]', bar).forEach(b => b.addEventListener('click', () => { impKind = b.dataset.k; $$('[data-k]', bar).forEach(y => y.classList.toggle('on', y === b)); draw(); }));
    $('[data-close]', go).addEventListener('click', () => { importOpen = false; again(); });
    $('[data-go]', go).addEventListener('click', async e => {
      e.target.disabled = true; let n = 0;
      for (const x of picked.values()) {
        const src = x.surveys[x.surveys.length - 1];
        try { const r = await api('POST', '', { op: 'copy', surveyId: sv.id, fromSurvey: src.surveyId, id: src.hotelId }); if (!r.already) n++; } catch (e2) { fail(e2); }
      }
      impData = null; importOpen = false; await refreshSurvey(); await refreshHome();
      ctx.toast(n === 1 ? 'מקום אחד יובא' : n + ' מקומות יובאו'); again();
    });
    box.append(bar, list, go); draw();
  })();
  return box;
}

let pasteOpen = false;
let moveOpen = null, moveMode = 'move';
const moveTargets = sv => (home?.surveys || []).filter(t => t.manage && t.id !== sv.id);
/** Paste a price quote / a WhatsApp message / notes: the robot reads it and fills prices, rooms, hours, conditions. */
function pasteForm(sv, x) {
  const f = h(`<form class="card hs-form hs-paste">
    <h2>להדביק טקסט על ${esc(x.name)}</h2>
    <p class="hint">הצעת מחיר, הודעת וואטסאפ או מה שהמלון כתב. המחירים, החדרים, השעות והתנאים יתמלאו כאן לבד תוך כ-5 דקות.</p>
    <label class="field"><span>הטקסט</span><textarea name="text" rows="8" required minlength="10"></textarea></label>
    <div class="row-tools"><button class="btn btn--gold" type="submit">למלא את הפרטים</button><button class="btn btn--line" type="button" data-x>ביטול</button></div>
  </form>`);
  $('[data-x]', f).addEventListener('click', () => { pasteOpen = false; again(); });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return; busy = true;
    try {
      await api('POST', '', { op: 'paste', surveyId: sv.id, id: x.id, text: f.text.value });
      pasteOpen = false; await refreshSurvey(); ctx.toast('התקבל. הפרטים יתמלאו תוך כ-5 דקות'); again();
    } catch (e2) { fail(e2); } finally { busy = false; }
  });
  return f;
}

function mailForm(sv, x) {
  const f = h(`<form class="card hs-form hs-mail">
    <h2>מייל ל${esc(x.name)}</h2>
    <p class="hint">יוצא מהמייל של LBV תוך כמה דקות. התשובות של המלון נשמרות כאן אוטומטית.</p>
    <label class="field"><span>אל</span><input name="to" type="email" dir="ltr" required value="${esc(x.email)}" placeholder="reservations@hotel.co.il"></label>
    <label class="field"><span>נושא</span><input name="subject" required value="${esc(mailDraft.subject)}"></label>
    <label class="field"><span>תוכן</span><textarea name="body" rows="10" required dir="${sv.mailLang === 'he' ? 'rtl' : 'ltr'}">${esc(mailDraft.body)}</textarea></label>
    <div class="row-tools"><button class="btn btn--gold" type="submit">שליחה</button><button class="btn btn--line" type="button" data-x>ביטול</button></div>
  </form>`);
  $('[data-x]', f).addEventListener('click', () => { mailOpen = false; again(); });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return; busy = true;
    const d = Object.fromEntries(new FormData(f));
    try {
      await api('POST', '', { op: 'mail', surveyId: sv.id, id: x.id, ...d });
      mailOpen = false; await refreshSurvey(); ctx.toast('המייל בתור. יישלח מהמייל של LBV תוך כמה דקות'); again();
    } catch (e2) { fail(e2); } finally { busy = false; }
  });
  return f;
}

/** The hotel's whole history, newest first: the place to find "they told us it's full" weeks later. */
function timeline(sv, x) {
  const c = h(`<section class="card hs-tl"><div class="card__head"><div><h2>כל ההיסטוריה</h2><p>שיחות, מיילים והערות. אפשר לשלוח כל שיחה כהוכחה.</p></div></div>
    <form class="hs-note"><input name="text" placeholder="הערה מהירה (למשל: דיברתי עם דנה, מחכה לאישור מנהל)"><button class="btn btn--dark btn--sm" type="submit">הוספה</button></form>
    <ol class="hs-log"></ol></section>`);
  $('.hs-note', c).addEventListener('submit', async e => {
    e.preventDefault();
    const text = e.target.text.value.trim(); if (!text) return;
    try { await api('POST', '', { op: 'note', surveyId: sv.id, id: x.id, text }); await refreshSurvey(); again(); } catch (e2) { fail(e2); }
  });
  const ol = $('.hs-log', c);
  const techNote = l => l.t === 'note' && (l.by === 'המערכת' || /^נוספו \d+ תמונות|^נוספה תמונה|נבדקו ידנית|^הוסרו \d+ תמונות|Error|gemini/i.test(l.text || ''));
  const ours = l => l.t === 'wa' && (/ilan|אילן|belle\s*vie|לה\s*בל\s*וי/i.test(l.from || '') || /^\s*(שיחת וידאו|שיחה קולית|שיחת וידאו פעילה|שיחה שלא נענתה|הודעה זו נמחקה)/.test(l.text || ''));
  // owner 25.11: a WhatsApp reading that says nothing ("נמסר שאין לו את המידע בטלפון") is not shown
  const emptyWa = l => l.t === 'text' && l.src === 'wa' && /אין (לו|לה|להם|לי)? ?(את )?ה?מידע|לא (נמסר|צוין|ידוע|ברור)|אין לי על הטלפון|תמונה בלבד|ללא פרטים|^התקבלה הודעה/.test(l.summary || '') && !(l.prices || []).length;
  const all = [...(x.log || [])].filter(l => !techNote(l) && !ours(l) && !emptyWa(l)).sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  const waRaw = all.filter(l => l.t === 'wa'), log = all.filter(l => l.t !== 'wa');
  if (!log.length && !waRaw.length) ol.append(h('<li class="hint">עוד אין היסטוריה.</li>'));
  // owner 25.11: the WhatsApp messages themselves are not shown (short replies without our questions say nothing);
  // only what the robot read from them, and only while it is still reading, one line
  if (waRaw.length && Date.now() - new Date(waRaw[0].at || 0) < 36e5 && !log.some(l => l.t === 'text' && l.src === 'wa' && (l.at || '') >= (waRaw[0].at || ''))) {
    ol.append(h(`<li class="ev ev--wa"><div class="ev__h"><b>${waRaw.length === 1 ? 'הודעת וואטסאפ חדשה' : waRaw.length + ' הודעות וואטסאפ חדשות'}</b><time>${when(waRaw[0].at)}</time></div><p class="hint">הרובוט יסכם מהן את מה שחשוב תוך כמה דקות.</p></li>`));
  }
  for (const l of log) {
    if (l.t === 'call') {
      const [an, ac] = AV[l.avail] || AV.unknown;
      const li = h(`<li class="ev ev--call"><div class="ev__h"><b>שיחה</b><time>${when(l.at)}</time>${l.dur ? `<span>${esc(l.dur)}</span>` : ''}${l.avail && l.avail !== 'unknown' ? `<span class="pill pill--${ac}">${an}</span>` : ''}</div>
        ${l.summary ? `<p>${esc(l.summary)}</p>` : ''}
        ${l.quotes?.length ? `<ul class="ev__q">${l.quotes.map(q => `<li><time>${esc(q.time)}</time>${q.who ? `<b>${esc(q.who)}:</b> ` : ''}"${esc(q.text)}"</li>`).join('')}</ul>` : ''}
        <div class="row-tools">${safeUrl(l.file?.url) ? `<a class="btn btn--line btn--sm" href="${esc(l.file.url)}" target="_blank" rel="noopener">להאזנה להקלטה</a>` : ''}
          <button class="btn btn--line btn--sm" type="button" data-proof>לשלוח כהוכחה</button>
          ${l.transcript ? '<button class="btn btn--line btn--sm" type="button" data-tr>תמלול מלא</button>' : ''}</div>
        <pre class="ev__tr" hidden>${esc(l.transcript || '')}</pre></li>`);
      $('[data-tr]', li)?.addEventListener('click', () => { const p = $('.ev__tr', li); p.hidden = !p.hidden; });
      $('[data-proof]', li).addEventListener('click', () => {
        const t = `${x.name}\nשיחה מיום ${when(l.at)}${x.contact ? ' עם ' + x.contact : ''}\n\n${(l.quotes || []).map(q => `${q.time ? '[' + q.time + '] ' : ''}${q.who ? q.who + ': ' : ''}"${q.text}"`).join('\n') || l.summary || ''}${l.file?.url ? '\n\nההקלטה: ' + l.file.url : ''}`;
        window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank');
      });
      ol.append(li);
    } else if (l.t === 'mail-out' || l.t === 'mail-in') {
      const out = l.t === 'mail-out';
      const li = h(`<li class="ev ev--${out ? 'out' : 'in'}"><div class="ev__h"><b>${out ? 'מייל שנשלח' : 'תשובה מהמלון'}</b><time>${when(l.at)}</time>
        ${out ? `<span>${l.state === 'queued' ? 'בתור לשליחה' : l.state === 'error' ? 'השליחה נכשלה' : 'נשלח'} · אל ${esc(l.to)}</span>` : `<span>מאת ${esc(l.from)}</span>`}</div>
        <p class="ev__subj">${esc(l.subject)}</p><details><summary>התוכן</summary><pre>${esc(l.body)}</pre></details>
        ${(l.files || []).length ? `<div class="row-tools">${l.files.filter(f => safeUrl(f.url)).map(f => `<a class="btn btn--line btn--sm" href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join('')}</div>` : ''}
        ${l.error ? `<p class="err">${esc(l.error)}</p>` : ''}</li>`);
      ol.append(li);
    } else if (l.t === 'text') {
      const [an, ac] = AV[l.avail] || AV.unknown;
      ol.append(h(`<li class="ev ev--text"><div class="ev__h"><b>${l.src === 'mail' ? 'נקרא מהמיילים' : l.src === 'wa' ? 'נקרא מהוואטסאפ' : 'נקרא מטקסט שהודבק'}</b><time>${when(l.at)}</time>${l.avail && l.avail !== 'unknown' ? `<span class="pill pill--${ac}">${an}</span>` : ''}</div>
        ${l.summary ? `<p>${esc(l.summary)}</p>` : ''}
        ${(l.files || []).filter(f => safeUrl(f.url)).length ? `<div class="row-tools">${l.files.filter(f => safeUrl(f.url)).map(f => `<a class="btn btn--line btn--sm" href="${esc(f.url)}" target="_blank" rel="noopener">לפתוח את הקובץ: ${esc(f.name)}</a>`).join('')}</div>` : ''}
        ${l.quotes?.length && l.src !== 'wa' ? `<ul class="ev__q">${l.quotes.map(q => `<li>${q.who ? `<b>${esc(q.who)}:</b> ` : ''}"${esc(q.text)}"</li>`).join('')}</ul>` : ''}</li>`));
    } else {
      ol.append(h(`<li class="ev ev--note"><div class="ev__h"><b>הערה</b><time>${when(l.at)}</time>${l.by ? `<span>${esc(l.by)}</span>` : ''}</div><p>${esc(l.text)}</p>${(l.files || []).filter(f => safeUrl(f.url)).length ? `<div class="row-tools">${l.files.filter(f => safeUrl(f.url)).map(f => `<a class="btn btn--line btn--sm" href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join('')}</div>` : ''}</li>`));
    }
  }
  return c;
}

/* ---------- summaries out ---------- */
function waSummary(sv, hotels) {
  const lines = [`*${sv.title}*`];
  if (sv.from) lines.push(`תאריכים: ${dmy(sv.from)}${sv.to && sv.to !== sv.from ? ' – ' + dmy(sv.to) : ''}`);
  if (sv.need) lines.push(sv.need);
  const order = ['available', 'partial', 'unknown', 'full'];
  const sorted = [...hotels].filter(x => x.status !== 'no').sort((a, b) => order.indexOf(a.avail) - order.indexOf(b.avail) || (a.min ?? 1e12) - (b.min ?? 1e12));
  for (const x of sorted) {
    lines.push('', `*${x.name}*${x.city ? ' – ' + x.city : ''}`, `${(AV[x.avail] || AV.unknown)[0]}${x.availText ? ': ' + x.availText : ''}`);
    for (const p of x.prices || []) lines.push(`• ${[p.level, p.board].filter(Boolean).join(' · ') || 'מחיר'}: ${money(p.price, p.currency)}${p.per ? ' ' + p.per : ''}${p.note ? ' (' + p.note + ')' : ''}`);
    if (x.followUp || x.followWhat) lines.push(`לחזור${x.followUp ? ' ב-' + dmy(x.followUp) : ''}${x.followWhat ? ': ' + x.followWhat : ''}`);
  }
  const no = hotels.filter(x => x.status === 'no').map(x => x.name);
  if (no.length) lines.push('', 'לא רלוונטי: ' + no.join(', '));
  return lines.join('\n');
}
/** owner 24.11: what the place said about each date, read from its availability text ("25.03.2027 תפוס, 24.03.2027 פנוי").
 *  { '2027-03-25': 'taken', '2027-03-24': 'free' }. A date with no word near it is 'said' (mentioned, status unclear). */
function datesSaid(text, year) {
  const t = String(text || ''), out = {}, re = /(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/g, hits = [];
  let m;
  while ((m = re.exec(t))) {
    const d = +m[1], mo = +m[2]; let y = m[3] ? +m[3] : +year || new Date().getFullYear(); if (y < 100) y += 2000;
    if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    hits.push({ iso: y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'), s: m.index, e: m.index + m[0].length });
  }
  const word = s => /בספק|אולי|בבדיקה|לבדוק|ממתינ|יבדוק|יבדקו|לא בטוח|maybe/i.test(s) ? 'maybe' : /לא פנוי|אין מקום|תפוס|תפוסה|מלא|סגור|complet|booked|not available/i.test(s) ? 'taken' : /פנוי|פנויה|יש מקום|זמין|אפשרי|libre|available|free/i.test(s) ? 'free' : '';
  hits.forEach((x, i) => {
    const after = t.slice(x.e, i + 1 < hits.length ? hits[i + 1].s : t.length).split(/[.;\n]/)[0];
    const before = t.slice(i ? hits[i - 1].e : 0, x.s).split(/[.;\n,]/).pop();
    const st = word(after) || word(before) || 'said';
    if (!out[x.iso] || out[x.iso] === 'said') out[x.iso] = st;
  });
  return out;
}
/** The place on the preferred date: from the text, or (when the text names no date and the card has this one date) from its availability. */
function onDate(x, pref, svFrom, svTo) {
  const said = datesSaid(x.availText, (pref || svFrom || '').slice(0, 4));
  let st = said[pref] || '';
  if ((!st || st === 'said') && pref && pref === svFrom && (!svTo || svTo === svFrom || !Object.keys(said).length)) st = { available: 'free', partial: 'maybe', full: 'taken' }[x.avail] || st;
  const other = Object.keys(said).filter(d => d !== pref && said[d] === 'free').sort();
  return { st: st === 'said' ? '' : st, other };
}
const PREF_HE = { free: 'פנוי', maybe: 'בספק', taken: 'תפוס', '': 'לא ידוע' };
/** owner 25.11: a place that is not free (or not known) on the card's date but said another date is free shows "פנוי בתאריך אחר", not "לא ידוע". */
function avOf(x, sv) {
  const base = AV[x.avail] || AV.unknown;
  const o = onDate(x, (sv && sv.from) || '', (sv && sv.from) || '', (sv && sv.to) || '');
  if (o.st === 'taken' && o.other.length) return ['תפוס, פנוי בתאריך אחר', 'warn'];
  if (o.st === 'free') return AV.available;
  if (o.st === 'maybe') return AV.partial;
  if (x.avail === 'available' || x.avail === 'partial' || !o.other.length) return base;
  return [(o.st === 'taken' || x.avail === 'full' ? 'תפוס, ' : '') + 'פנוי בתאריך אחר', 'warn'];
}
/** owner 24.11: which date the client prefers: every date of the card and every date the places talked about. */
function cardDates(sv, hotels) {
  const all = new Set([sv.from, sv.to].filter(Boolean));
  for (const x of hotels) for (const d of Object.keys(datesSaid(x.availText, (sv.from || '').slice(0, 4)))) all.add(d);
  return [...all].sort();
}
let exportOpen = false, exportPref = '';
function exportCard(sv, hotels) {
  const ds = cardDates(sv, hotels);
  if (!ds.includes(exportPref)) exportPref = sv.from && ds.includes(sv.from) ? sv.from : ds[0] || '';
  const c = h(`<section class="card hs-exp">
    <div class="card__head"><div><h2>ייצוא לגיליון</h2><p>איזה תאריך הלקוח מעדיף? המקומות שפנויים בו יופיעו ראשונים. מקומות שפנויים רק בתאריך אחר יופיעו אחריהם, עם התאריך בעמודה בצד.</p></div></div>
    ${ds.length ? `<div class="hs-chips" role="radiogroup" aria-label="התאריך המועדף">${ds.map(d => `<button type="button" role="radio" aria-checked="${d === exportPref}" class="chip ${d === exportPref ? 'on' : ''}" data-d="${d}">${dmy(d)}${d === sv.from ? ' (התאריך של הכרטיסייה)' : ''}</button>`).join('')}</div>` : '<p>בכרטיסייה אין תאריכים, הגיליון יסודר לפי זמינות ומחיר.</p>'}
    <div class="hs-exp__foot"><button class="btn btn--gold" type="button" data-go>הורדת הגיליון</button><button class="btn btn--gold" type="button" data-sum>הורדת תקציר</button><button class="btn btn--line" type="button" data-x>סגירה</button></div>
  </section>`);
  c.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => { exportPref = b.dataset.d; again(); }));
  $('[data-go]', c).addEventListener('click', () => downloadCsv(sv, hotels, exportPref));
  $('[data-sum]', c).addEventListener('click', () => downloadSummary(sv, hotels, exportPref));
  $('[data-x]', c).addEventListener('click', () => { exportOpen = false; again(); });
  return c;
}
/** owner 25.11: "מה חשוב לדעת" = everything important that was said: availability, rooms, and the call / mail summary
    (what is included, extras, conditions), not only the availability line. */
function mustKnow(x) {
  // what is still open with them (e.g. "can send a price quote on Sunday") is important too
  const open = x.followWhat ? 'מה שנשאר פתוח: ' + x.followWhat + (x.followUp ? ' (' + dmy(x.followUp) + ')' : '') : '';
  const parts = [x.availText, x.rooms ? 'חדרים: ' + x.rooms : '', open, x.summary].map(t => String(t || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return parts.filter((t, i) => !parts.some((o, j) => j !== i && o.length > t.length && o.includes(t))).join('\n').slice(0, 1200);
}
function downloadCsv(sv, hotels, pref) {
  // owner 24.11: short and clear, the same columns as the Google sheet; the preferred date first, other dates on the side
  pref = pref || sv.from || '';
  const head = ['מקום', 'תמונה', 'כל התמונות', 'אתר', 'עיר', pref ? 'ב-' + dmy(pref) : 'זמינות', 'תאריכים חלופיים', 'הכי זול', 'המחירים', 'מה חשוב לדעת', 'איש קשר וטלפון', 'סטטוס'];
  const firstPic = x => [...(x.myPhotos || []), ...(x.photos || [])].map(u => /^media\/uploads\//.test(u || '') ? location.origin + '/' + u : safeUrl(u)).find(u => /^https:\/\//.test(u || '')) || '';
  // owner 25.11: a link to a photo page on the site, not a single picture
  const pic = x => { const all = [...new Set([...(x.myPhotos || []), ...(x.photos || [])].map(u => /^media\/uploads\//.test(u || '') ? location.origin + '/' + u : safeUrl(u)).filter(u => /^https:\/\//.test(u || '')))];
    let link = location.origin + '/hotels/photos.html?n=' + encodeURIComponent(x.name || ''), k = 0;
    for (const u of all.slice(0, 12)) { const add = '&u=' + encodeURIComponent(u); if ((link + add).length > 1900) break; link += add; k++; }
    return k ? link : ''; };
  const info = new Map(hotels.map(x => [x, onDate(x, pref, sv.from || '', sv.to || '')]));
  const rank = x => { const o = info.get(x); return x.status === 'no' ? 9 : o.st === 'free' ? 0 : o.st === 'maybe' ? 1 : o.other.length ? 2 : o.st === '' ? 3 : 4; };
  const list = [...hotels].sort((a, b) => rank(a) - rank(b) || (a.min ?? 1e12) - (b.min ?? 1e12));
  const rows = list.map(x => [x.name, firstPic(x), pic(x), safeUrl(x.website) || '', x.city, avOf(x, { from: pref, to: pref })[0], info.get(x).other.map(dmy).join(', '), x.min ?? '',
    (x.prices || []).filter(p => p.price > 0).map(p => ([p.level, p.board].filter(Boolean).join(', ') || 'מחיר') + ': ' + money(p.price, p.currency) + (p.per ? ' ' + p.per : '') + (p.note ? ' (' + p.note + ')' : '')).join('\n'),
    mustKnow(x), [x.contact, [x.phone, x.phone2].filter(Boolean).join(' / ')].filter(Boolean).join(' · '), ST[x.status] || '']);
  saveCsv(sv.title, [head, ...rows]);
}
/** owner 25.11: the summary sheet: site, photos, price, availability and one line about the place. Same order as the full sheet. */
function downloadSummary(sv, hotels, pref) {
  pref = pref || sv.from || '';
  const head = ['מקום', 'אתר', 'תמונות', 'מחיר', 'זמינות', 'בקצרה על המקום'];
  const info = new Map(hotels.map(x => [x, onDate(x, pref, sv.from || '', sv.to || '')]));
  const rank = x => { const o = info.get(x); return x.status === 'no' ? 9 : o.st === 'free' ? 0 : o.st === 'maybe' ? 1 : o.other.length ? 2 : o.st === '' ? 3 : 4; };
  const full = u => /^media\/uploads\//.test(u) ? location.origin + '/' + u : safeUrl(u);
  const line = x => { const t = String(x.about || x.summary || '').replace(/\s+/g, ' ').trim(); const m = t.match(/^.{20,220}?[.!?](\s|$)/); return m ? m[0].trim() : t.slice(0, 220); };
  const rows = [...hotels].sort((a, b) => rank(a) - rank(b) || (a.min ?? 1e12) - (b.min ?? 1e12)).map(x => {
    const o = info.get(x), cheap = (x.prices || []).filter(p => p.price > 0).sort((a, b) => a.price - b.price)[0];
    const av = pref && !o.st && o.other.length ? 'פנוי בתאריך אחר: ' + o.other.map(dmy).join(', ') : (pref ? PREF_HE[o.st] + ' ב-' + dmy(pref) : avOf(x, sv)[0]) + (o.other.length ? '. פנוי גם ב-' + o.other.map(dmy).join(', ') : '');
    return [x.name + (x.city ? ', ' + x.city : ''), safeUrl(x.website) || '', [...(x.myPhotos || []), ...(x.photos || [])].map(full).filter(Boolean).slice(0, 3).join('\n'),
      cheap ? money(cheap.price, cheap.currency) + (cheap.per ? ' ' + cheap.per : '') + ([cheap.level, cheap.board].filter(Boolean).length ? ' (' + [cheap.level, cheap.board].filter(Boolean).join(', ') + ')' : '') : 'עוד אין מחיר',
      av, line(x)];
  });
  saveCsv(sv.title + ' - תקציר', [head, ...rows]);
}
function saveCsv(name, table) {
  const csv = '\uFEFF' + table.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  if (window.LBVApp?.share) { window.LBVApp.share(`${name}.csv`, csv); return; }   // inside the phone app: share / save the file
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  ctx.toast('הקובץ ירד. בגוגל שיטס: קובץ ← ייבוא ← העלאה');
}
