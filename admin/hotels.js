// סקר מלונות: the admin page for surveying hotels.
// Calls are recorded on the work phone; while "survey mode" is on, the Google script reads them with Gemini
// and fills the hotels here. Every hotel keeps its whole history: calls (summary, key sentences with their
// time, the full transcript, the recording), e-mails sent and the replies, and notes, all searchable.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

export async function hotelsPage(pg, c) {
  ctx = c;
  if (!home) {
    pg.append(h('<p class="hint">טוען…</p>'));
    try { home = await api('GET'); } catch (e) { pg.innerHTML = ''; if (e.message === 'not-configured') pg.append(notReady()); else fail(e); return; }
    pg.innerHTML = '';
  }
  if (openSurvey && (!cur || cur.survey.id !== openSurvey)) {
    pg.append(h('<p class="hint">טוען את הסקר…</p>'));
    try { cur = await api('GET', '?survey=' + encodeURIComponent(openSurvey)); } catch (e) { openSurvey = null; cur = null; fail(e); }
    pg.innerHTML = '';
  }
  pg.append(modeBar());
  pg.append(lookupCard());
  if (openSurvey && cur) surveyView(pg); else homeView(pg);
}
const again = () => ctx.rerender();
async function refreshHome() { home = await api('GET'); }
async function refreshSurvey() { cur = await api('GET', '?survey=' + encodeURIComponent(openSurvey)); }

function notReady() {
  return h(`<section class="card"><h2>סקר מלונות</h2><p class="hint hint--box">כדי שהסקר יעבוד צריך שמסד הנתונים של האתר (Upstash Redis, אותו אחד של הסטטיסטיקה) יהיה מחובר בפרויקט ב-Vercel.</p></section>`);
}

/* ---------- survey mode: the big switch (made for the phone) ---------- */
function modeBar() {
  const m = home.mode || {}, con = home.connection || {};
  const sv = home.surveys.find(s => s.id === m.surveyId);
  const el = h(`<section class="hs-mode ${m.on ? 'is-on' : ''}">
    <div class="hs-mode__txt">
      <b>${m.on ? 'מצב סקר פעיל' : 'מצב סקר כבוי'}</b>
      <span>${m.on ? `כל שיחה מעכשיו נכנסת ל<b>${esc(sv?.title || 'סקר')}</b> · מאז ${when(m.since)}` : 'שיחות לא נקראות. מדליקים לפני שמתחילים להתקשר למלונות.'}</span>
    </div>
    <div class="hs-mode__act">
      ${m.on ? '' : `<select class="hs-sel" aria-label="לאיזה סקר">${home.surveys.map(s => `<option value="${s.id}" ${s.id === (openSurvey || home.surveys[0]?.id) ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select>`}
      <button type="button" class="hs-switch" role="switch" aria-checked="${!!m.on}"><span></span>${m.on ? 'לכבות' : 'להדליק'}</button>
    </div>
    <p class="hs-mode__con">${con.connected ? `<i class="dot ${con.ping && Date.now() - Date.parse(con.ping) < 20 * 60e3 ? 'ok' : 'warn'}"></i>החיבור לטלפון: בדיקה אחרונה ${ago(con.ping)}${con.last ? ` · שיחה אחרונה נקלטה ${ago(con.last)}` : ''}${con.skipped ? ` · ${con.skipped} שיחות לא קשורות דולגו` : ''}` : '<i class="dot no"></i>הטלפון עוד לא מחובר. <a href="#" data-connect>איך מחברים</a>'}</p>
  </section>`);
  $('.hs-switch', el).addEventListener('click', async () => {
    if (!m.on && !home.surveys.length) return ctx.toast('קודם פותחים סקר חדש', 'info');
    try {
      const r = await api('POST', '', { op: 'mode', on: !m.on, surveyId: m.on ? undefined : $('.hs-sel', el)?.value });
      home.mode = r.mode; ctx.toast(r.mode.on ? 'מצב סקר הודלק. אפשר להתחיל להתקשר' : 'מצב סקר כובה'); again();
    } catch (e) { fail(e); }
  });
  $('[data-connect]', el)?.addEventListener('click', e => { e.preventDefault(); openSurvey = null; showConnect = true; again(); });
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
function lookupCard() {
  const c = h(`<section class="card hs-look">
    <form class="hs-look__f"><label class="hs-look__l" for="hs-look-in">דיברתי כבר עם המקום הזה?</label>
      <div class="hs-look__row"><input id="hs-look-in" type="search" inputmode="tel" placeholder="מספר טלפון של מלון (או שם)" value="${esc(look.text)}"><button class="btn btn--dark" type="submit">בדיקה</button></div></form>
    <div class="hs-look__out" aria-live="polite"></div></section>`);
  const out = $('.hs-look__out', c);
  const draw = () => {
    out.innerHTML = '';
    if (look.results == null) return;
    if (!look.results.length) { out.append(h(`<p class="hint">לא מצאתי שיחה או מלון עם "${esc(look.text)}" באף סקר שלך.</p>`)); return; }
    look.results.forEach((r, i) => {
      const [an, ac] = AV[r.avail] || AV.unknown;
      const box = h(`<div class="hs-ans">
        <p class="hs-ans__q"><b>${esc(r.name || 'מלון')}</b>${r.city ? ' · ' + esc(r.city) : ''}: ${r.calls ? `דיברת איתם <b>${relDay(r.lastAt)}</b> (${when(r.lastAt)})` : `נמצא בסקר, עוד בלי שיחה מוקלטת`} · סקר "${esc(r.survey)}"${r.calls ? '. רוצה סיכום של השיחה?' : ''}</p>
        <div class="row-tools hs-ans__yn"></div><div class="hs-ans__body"></div></div>`);
      const yn = $('.hs-ans__yn', box), body = $('.hs-ans__body', box);
      const openIt = h('<button class="btn btn--line btn--sm" type="button">לפתוח את המלון</button>');
      openIt.addEventListener('click', () => { openSurvey = r.surveyId; openHotel = r.id; cur = null; again(); scrollTo({ top: 0 }); });
      const showSummary = () => {
        yn.innerHTML = ''; yn.append(openIt);
        const l = r.last || {};
        body.innerHTML = `<span class="pill pill--${ac}">${an}</span>${r.availText ? ' ' + esc(r.availText) : ''}
          ${l.summary || r.summary ? `<p>${esc(l.summary || r.summary)}</p>` : ''}
          ${(l.quotes || []).length ? `<ul class="ev__q">${l.quotes.map(q => `<li><time>${esc(q.time)}</time>${q.who ? `<b>${esc(q.who)}:</b> ` : ''}"${esc(q.text)}"</li>`).join('')}</ul>` : ''}
          ${r.prices.length ? `<div class="hs-ho__pr">${r.prices.map(p => `<span>${esc([p.level, p.board].filter(Boolean).join(' · ') || 'מחיר')}: <b>${money(p.price, p.currency)}</b>${p.per ? ' ' + esc(p.per) : ''}</span>`).join('')}</div>` : ''}
          ${r.followUp || r.followWhat ? `<p class="hs-follow">לחזור${r.followUp ? ' ב-' + dmy(r.followUp) : ''}${r.followWhat ? ': ' + esc(r.followWhat) : ''}</p>` : ''}
          ${l.file?.url ? `<a class="btn btn--line btn--sm" href="${esc(l.file.url)}" target="_blank" rel="noopener">להאזנה להקלטה</a>` : ''}`;
      };
      if (!r.calls) yn.append(openIt);
      else if (look.open === i) showSummary();
      else {
        const yes = h('<button class="btn btn--gold btn--sm" type="button">כן, סיכום</button>'), no = h('<button class="btn btn--line btn--sm" type="button">לא</button>');
        yes.addEventListener('click', () => { look.open = i; showSummary(); });
        no.addEventListener('click', () => { look.results.splice(i, 1); if (!look.results.length) { look.results = null; look.text = ''; $('#hs-look-in', c).value = ''; } draw(); });
        yn.append(yes, no);
      }
      out.append(box);
    });
  };
  $('form', c).addEventListener('submit', async e => {
    e.preventDefault();
    look.text = $('#hs-look-in', c).value.trim(); look.open = null;
    if (!look.text) { look.results = null; return draw(); }
    try { look.results = (await api('GET', '?lookup=' + encodeURIComponent(look.text))).results; } catch (e2) { fail(e2); look.results = null; }
    draw();
  });
  draw();
  return c;
}

/* ---------- home: the surveys ---------- */
let showConnect = false, newOpen = false;
function homeView(pg) {
  const list = h(`<section class="card"><div class="card__head"><div><h2>הסקרים</h2><p>כל סקר הוא תאריכים אחד ורשימת מלונות. רואים רק אתם ומי שבחרתם לשתף.</p></div>
    <div class="row-tools"><button class="btn btn--gold" type="button" data-new>+ סקר חדש</button></div></div><div class="hs-surveys"></div></section>`);
  const box = $('.hs-surveys', list);
  if (!home.surveys.length) box.append(h('<p class="hint">עוד אין סקרים. פותחים סקר, בוחרים תאריכים, ומדליקים "מצב סקר" לפני שמתקשרים.</p>'));
  for (const s of home.surveys) {
    const b = h(`<button type="button" class="hs-sv">
      <b>${esc(s.title)}</b>
      <span>${s.from ? dmy(s.from) + (s.to && s.to !== s.from ? ' – ' + dmy(s.to) : '') : 'בלי תאריכים'}${s.area ? ' · ' + esc(s.area) : ''}</span>
      <span class="hs-sv__n"><em>${s.count}</em> מלונות · <em>${s.avail}</em> עם מקום${s.follow ? ` · <em class="w">${s.follow}</em> לחזור` : ''}</span>
      <small>${s.mine ? 'שלי' : 'שותף איתי · ' + esc(s.by?.name || '')}${home.mode?.on && home.mode.surveyId === s.id ? ' · <b class="live">פעיל עכשיו</b>' : ''}</small>
    </button>`);
    b.addEventListener('click', () => { openSurvey = s.id; openHotel = null; query = ''; filter = 'all'; again(); });
    box.append(b);
  }
  $('[data-new]', list).addEventListener('click', () => { newOpen = !newOpen; again(); });
  if (newOpen) pg.append(surveyForm());
  pg.append(list);
  pg.append(connectCard());
}

function surveyForm(sv) {
  const s = sv || { title: '', from: '', to: '', need: '', area: '', note: '', levels: ['רגיל', 'משודרג', 'סוויטה', 'חבילת שבת', 'אולם וסעודות'], mailLang: 'he', sheet: true };
  const f = h(`<form class="card hs-form">
    <h2>${sv ? 'פרטי הסקר' : 'סקר חדש'}</h2>
    <div class="grid2">
      <label class="field"><span>שם הסקר</span><input name="title" required placeholder="למשל: שבת חתן משפחת כהן" value="${esc(s.title)}"></label>
      <label class="field"><span>אזור</span><input name="area" placeholder="למשל: טבריה והכנרת" value="${esc(s.area)}"></label>
      <label class="field"><span>מתאריך</span><input name="from" type="date" value="${esc(s.from)}"></label>
      <label class="field"><span>עד תאריך</span><input name="to" type="date" value="${esc(s.to)}"></label>
    </div>
    <label class="field"><span>מה צריך (נכנס גם למייל למלון)</span><input name="need" placeholder="למשל: שבת חתן, 25 חדרים, אולם ל-120 איש, 3 סעודות, כשרות מהדרין" value="${esc(s.need)}"></label>
    <label class="field"><span>רמות מחיר (מופרדות בפסיק)</span><input name="levels" value="${esc((s.levels || []).join(', '))}"></label>
    <div class="grid2">
      <label class="field"><span>שפת המייל למלונות</span><select name="mailLang">${[['he', 'עברית'], ['fr', 'צרפתית'], ['en', 'אנגלית']].map(([v, n]) => `<option value="${v}" ${s.mailLang === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <label class="field hs-check"><input type="checkbox" name="sheet" ${s.sheet !== false ? 'checked' : ''}><span>לעדכן גיליון בגוגל שיטס אוטומטית</span></label>
    </div>
    <label class="field"><span>הערות לעצמי</span><textarea name="note" rows="2">${esc(s.note)}</textarea></label>
    <div class="row-tools"><button class="btn btn--gold" type="submit">${sv ? 'שמירה' : 'פתיחת הסקר'}</button><button class="btn btn--line" type="button" data-x>ביטול</button>
    ${sv?.manage ? '<button class="btn btn--danger btn--sm hs-push" type="button" data-del>מחיקת הסקר</button>' : ''}</div>
  </form>`);
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    try {
      const r = await api('POST', '', { op: 'survey', id: sv?.id, title: d.title, area: d.area, from: d.from, to: d.to, need: d.need, note: d.note, mailLang: d.mailLang, sheet: !!d.sheet, levels: d.levels.split(/[,،]/).map(x => x.trim()).filter(Boolean) });
      newOpen = false; editSurvey = false; await refreshHome();
      if (!sv) { openSurvey = r.id; ctx.toast('הסקר נפתח'); } else { await refreshSurvey(); ctx.toast('נשמר'); }
      again();
    } catch (e2) { fail(e2); }
  });
  $('[data-x]', f).addEventListener('click', () => { newOpen = false; editSurvey = false; again(); });
  $('[data-del]', f)?.addEventListener('click', async () => {
    if (!confirm(`למחוק את הסקר "${sv.title}" עם כל המלונות, השיחות והמיילים שבו? אי אפשר לבטל.`)) return;
    try { await api('DELETE', '?survey=' + sv.id); openSurvey = null; cur = null; editSurvey = false; await refreshHome(); again(); ctx.toast('הסקר נמחק'); } catch (e) { fail(e); }
  });
  return f;
}

/* ---------- connecting the phone (one time) ---------- */
let newKey = '';
function connectCard() {
  const con = home.connection || {};
  const c = h(`<details class="card hs-connect" ${showConnect || !con.connected ? 'open' : ''}>
    <summary><h2>חיבור הטלפון והמייל (פעם אחת)</h2><span>${con.connected ? 'מחובר' : 'עוד לא מחובר'}</span></summary>
    <ol class="hs-steps">
      <li><b>הטלפון מקליט שיחות</b> (כבר מוגדר אצלכם).</li>
      <li><b>הקלטות עולות לדרייב לבד:</b> מתקינים בטלפון העבודה את האפליקציה Autosync for Google Drive, נכנסים עם חשבון הגוגל של LBV, ומחברים את תיקיית הקלטות השיחות לתיקייה בדרייב בשם <b>הקלטות שיחות</b>.</li>
      <li><b>הרובוט בגוגל:</b> סקריפט קטן בחשבון של LBV שקורא את ההקלטות, שולח מיילים ומעדכן את הגיליון. אנחנו מתקינים אותו ביחד. הוא צריך את המפתח הזה:</li>
    </ol>
    <div class="row-tools"><button class="btn btn--dark btn--sm" type="button" data-key>${con.connected ? 'מפתח חדש (הישן יפסיק לעבוד)' : 'יצירת מפתח'}</button></div>
    ${newKey ? `<p class="hs-key"><code>${esc(newKey)}</code><button class="btn btn--line btn--sm" type="button" data-copy>העתקה</button><small>המפתח מוצג רק עכשיו. מדביקים אותו בסקריפט בשדה LBV_KEY.</small></p>` : ''}
    <p class="hint hint--box">שיחות נקראות רק בזמן ש"מצב סקר" דולק. גם אז, שיחה שאינה עם מלון מדולגת ולא נשמר ממנה כלום.</p>
  </details>`);
  $('[data-key]', c).addEventListener('click', async () => {
    if (con.connected && !confirm('ליצור מפתח חדש? הסקריפט יפסיק לעבוד עד שמדביקים בו את החדש.')) return;
    try { newKey = (await api('POST', '', { op: 'connect' })).key; await refreshHome(); showConnect = true; again(); } catch (e) { fail(e); }
  });
  $('[data-copy]', c)?.addEventListener('click', () => copy(newKey, 'המפתח הועתק'));
  return c;
}
async function copy(text, ok) { try { await navigator.clipboard.writeText(text); ctx.toast(ok); } catch (e) { prompt('העתיקו:', text); } }

/* ---------- one survey ---------- */
let editSurvey = false, shareOpen = false, addOpen = false;
function surveyView(pg) {
  const { survey: sv, hotels } = cur;
  const head = h(`<section class="card hs-head">
    <button type="button" class="hs-back" data-back>→ כל הסקרים</button>
    <div class="hs-head__t"><h2>${esc(sv.title)}</h2>
      <p>${sv.from ? 'תאריכים: ' + dmy(sv.from) + (sv.to && sv.to !== sv.from ? ' – ' + dmy(sv.to) : '') : 'בלי תאריכים'}${sv.area ? ' · ' + esc(sv.area) : ''}${sv.need ? ' · ' + esc(sv.need) : ''}</p></div>
    <div class="hs-tools">
      <button class="btn btn--gold btn--sm" type="button" data-wa>סיכום לוואטסאפ</button>
      ${sv.sheetUrl ? `<a class="btn btn--line btn--sm" href="${esc(sv.sheetUrl)}" target="_blank" rel="noopener">הגיליון בגוגל</a>` : ''}
      <button class="btn btn--line btn--sm" type="button" data-csv>הורדה לגוגל שיטס / אקסל</button>
      ${sv.manage ? '<button class="btn btn--line btn--sm" type="button" data-share>שיתוף</button><button class="btn btn--line btn--sm" type="button" data-edit>עריכה</button>' : ''}
    </div>
  </section>`);
  $('[data-back]', head).addEventListener('click', () => { openSurvey = null; cur = null; openHotel = null; again(); });
  $('[data-wa]', head).addEventListener('click', () => { const t = waSummary(sv, hotels); window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank'); });
  $('[data-csv]', head).addEventListener('click', () => downloadCsv(sv, hotels));
  $('[data-share]', head)?.addEventListener('click', () => { shareOpen = !shareOpen; again(); });
  $('[data-edit]', head)?.addEventListener('click', () => { editSurvey = !editSurvey; again(); });
  pg.append(head);
  if (editSurvey) pg.append(surveyForm(sv));
  if (shareOpen && sv.manage) pg.append(shareCard(sv));

  if (openHotel) { const ho = hotels.find(x => x.id === openHotel); if (ho) return pg.append(hotelView(sv, ho)); openHotel = null; }

  // Search across everything that was said and written
  const bar = h(`<section class="hs-bar">
    <input type="search" class="hs-q" placeholder="חיפוש בכל השיחות, המיילים וההערות (למשל: תפוס, מלון X, 1800)" value="${esc(query)}">
    <div class="hs-chips">${[['all', 'הכול'], ['avail', 'יש מקום'], ['followup', 'לחזור אליהם'], ['waiting', 'מחכים להצעה'], ['full', 'תפוס']].map(([k, n]) => `<button type="button" class="chip ${filter === k ? 'on' : ''}" data-f="${k}">${n}</button>`).join('')}
      <select class="hs-sort" aria-label="מיון">${[['price', 'לפי מחיר'], ['recent', 'לפי עדכון אחרון'], ['name', 'לפי שם']].map(([k, n]) => `<option value="${k}" ${sortBy === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
      <button class="btn btn--dark btn--sm" type="button" data-add>+ מלון ידני</button></div>
  </section>`);
  const q = $('.hs-q', bar);
  q.addEventListener('input', () => { query = q.value; drawList(); });
  $$('[data-f]', bar).forEach(b => b.addEventListener('click', () => { filter = b.dataset.f; $$('[data-f]', bar).forEach(x => x.classList.toggle('on', x === b)); drawList(); }));
  $('.hs-sort', bar).addEventListener('change', e => { sortBy = e.target.value; drawList(); });
  $('[data-add]', bar).addEventListener('click', () => { addOpen = !addOpen; again(); });
  pg.append(bar);
  if (addOpen) pg.append(hotelForm(sv, null));
  const listEl = h('<section class="hs-list"></section>');
  pg.append(listEl);
  function drawList() {
    listEl.innerHTML = '';
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let rows = hotels.filter(x => filter === 'all' || (filter === 'avail' ? ['available', 'partial'].includes(x.avail) : filter === 'full' ? x.avail === 'full' : x.status === filter));
    const hits = new Map();
    if (words.length) rows = rows.filter(x => { const m = searchHotel(x, words); if (m) hits.set(x.id, m); return !!m; });
    rows.sort(sortBy === 'name' ? (a, b) => a.name.localeCompare(b.name, 'he') : sortBy === 'recent' ? (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '') : (a, b) => (a.min ?? 1e12) - (b.min ?? 1e12));
    if (!hotels.length) listEl.append(h(`<p class="hint hint--box">עוד אין מלונות בסקר. מדליקים "מצב סקר" למעלה ומתקשרים: כל שיחה עם מלון תופיע כאן לבד אחרי כמה דקות. אפשר גם להוסיף מלון ידנית.</p>`));
    else if (!rows.length) listEl.append(h('<p class="hint">לא נמצא כלום.</p>'));
    for (const x of rows) {
      const [an, ac] = AV[x.avail] || AV.unknown;
      const calls = (x.log || []).filter(l => l.t === 'call').length, mails = (x.log || []).filter(l => l.t === 'mail-in' || l.t === 'mail-out').length;
      const card = h(`<button type="button" class="hs-ho">
        <div class="hs-ho__top"><b>${esc(x.name || 'בלי שם')}</b><span class="pill pill--${ac}">${an}</span></div>
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
  const v = x || { name: '', city: '', contact: '', phone: '', email: '', avail: 'unknown', availText: '', rooms: '', prices: [], status: 'new', followUp: '', followWhat: '', notes: '' };
  const f = h(`<form class="card hs-form">
    ${x ? '' : '<h2>מלון חדש</h2>'}
    <div class="grid2">
      <label class="field"><span>שם המלון</span><input name="name" required value="${esc(v.name)}"></label>
      <label class="field"><span>עיר / מקום</span><input name="city" value="${esc(v.city)}"></label>
      <label class="field"><span>איש קשר</span><input name="contact" value="${esc(v.contact)}"></label>
      <label class="field"><span>טלפון</span><input name="phone" type="tel" dir="ltr" value="${esc(v.phone)}"></label>
      <label class="field"><span>מייל</span><input name="email" type="email" dir="ltr" value="${esc(v.email)}"></label>
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
    <div class="row-tools"><button class="btn btn--gold" type="submit">שמירה</button>${x ? '' : '<button class="btn btn--line" type="button" data-x>ביטול</button>'}</div>
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
      addOpen = false; await refreshSurvey(); openHotel = saved.id; ctx.toast('נשמר'); again();
    } catch (e2) { fail(e2); }
  });
  return f;
}

let mailOpen = false, mailDraft = null;
function hotelView(sv, x) {
  const wrap = h('<div class="hs-hotel"></div>');
  const [an, ac] = AV[x.avail] || AV.unknown;
  const head = h(`<section class="card hs-hhead">
    <button type="button" class="hs-back" data-back>→ כל המלונות</button>
    <div class="hs-hhead__t"><h2>${esc(x.name || 'בלי שם')}</h2><span class="pill pill--${ac}">${an}</span><span class="st st--${x.status}">${ST[x.status]}</span></div>
    <p>${esc(x.city)}${x.contact ? ' · ' + esc(x.contact) : ''}${x.availText ? ' · ' + esc(x.availText) : ''}</p>
    <div class="hs-tools">
      ${x.phone ? `<a class="btn btn--dark btn--sm" href="tel:${esc(x.phone.replace(/[^\d+]/g, ''))}">להתקשר <bdi>${esc(x.phone)}</bdi></a>` : ''}
      <button class="btn btn--gold btn--sm" type="button" data-mail>מייל למלון</button>
      ${sv.manage ? '<button class="btn btn--danger btn--sm" type="button" data-del>מחיקת המלון</button>' : ''}
    </div>
  </section>`);
  $('[data-back]', head).addEventListener('click', () => { openHotel = null; mailOpen = false; again(); });
  $('[data-mail]', head).addEventListener('click', async () => {
    mailOpen = !mailOpen;
    if (mailOpen) { try { mailDraft = await api('POST', '', { op: 'draft', surveyId: sv.id, id: x.id }); } catch (e) { fail(e); } }
    again();
  });
  $('[data-del]', head)?.addEventListener('click', async () => {
    if (!confirm(`למחוק את "${x.name}" עם כל השיחות והמיילים שלו? אי אפשר לבטל.`)) return;
    try { await api('DELETE', `?survey=${sv.id}&hotel=${x.id}`); openHotel = null; await refreshSurvey(); again(); ctx.toast('נמחק'); } catch (e) { fail(e); }
  });
  wrap.append(head);
  if (mailOpen && mailDraft) wrap.append(mailForm(sv, x));

  const cols = h('<div class="hs-cols"></div>');
  cols.append(timeline(sv, x));
  const side = h('<div></div>');
  if (x.summary) side.append(h(`<section class="card hs-sumcard"><h3>סיכום אחרון</h3><p>${esc(x.summary)}</p>${x.followUp || x.followWhat ? `<p class="hs-follow">לחזור${x.followUp ? ' ב-' + dmy(x.followUp) : ''}${x.followWhat ? ': ' + esc(x.followWhat) : ''}</p>` : ''}</section>`));
  side.append(hotelForm(sv, x));
  cols.append(side);
  wrap.append(cols);
  return wrap;
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
  const log = [...(x.log || [])].sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  if (!log.length) ol.append(h('<li class="hint">עוד אין היסטוריה.</li>'));
  for (const l of log) {
    if (l.t === 'call') {
      const [an, ac] = AV[l.avail] || AV.unknown;
      const li = h(`<li class="ev ev--call"><div class="ev__h"><b>שיחה</b><time>${when(l.at)}</time>${l.dur ? `<span>${esc(l.dur)}</span>` : ''}${l.avail && l.avail !== 'unknown' ? `<span class="pill pill--${ac}">${an}</span>` : ''}</div>
        ${l.summary ? `<p>${esc(l.summary)}</p>` : ''}
        ${l.quotes?.length ? `<ul class="ev__q">${l.quotes.map(q => `<li><time>${esc(q.time)}</time>${q.who ? `<b>${esc(q.who)}:</b> ` : ''}"${esc(q.text)}"</li>`).join('')}</ul>` : ''}
        <div class="row-tools">${l.file?.url ? `<a class="btn btn--line btn--sm" href="${esc(l.file.url)}" target="_blank" rel="noopener">להאזנה להקלטה</a>` : ''}
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
        ${(l.files || []).length ? `<div class="row-tools">${l.files.map(f => `<a class="btn btn--line btn--sm" href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>`).join('')}</div>` : ''}
        ${l.error ? `<p class="err">${esc(l.error)}</p>` : ''}</li>`);
      ol.append(li);
    } else {
      ol.append(h(`<li class="ev ev--note"><div class="ev__h"><b>הערה</b><time>${when(l.at)}</time>${l.by ? `<span>${esc(l.by)}</span>` : ''}</div><p>${esc(l.text)}</p></li>`));
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
function downloadCsv(sv, hotels) {
  const combos = [];
  for (const x of hotels) for (const p of x.prices || []) { const k = [p.level, p.board].filter(Boolean).join(' · ') || 'מחיר'; if (!combos.includes(k)) combos.push(k); }
  const head = ['מלון', 'עיר / אזור', 'איש קשר', 'טלפון', 'מייל', 'זמינות', 'פירוט זמינות', ...combos, 'הכי זול', 'סטטוס', 'לחזור בתאריך', 'מה לבדוק', 'סיכום', 'הערות'];
  const rows = hotels.map(x => [x.name, x.city, x.contact, x.phone, x.email, (AV[x.avail] || AV.unknown)[0], x.availText,
    ...combos.map(k => { const p = (x.prices || []).find(p => ([p.level, p.board].filter(Boolean).join(' · ') || 'מחיר') === k); return p ? `${p.price ?? ''} ${p.per || ''}`.trim() : ''; }),
    x.min ?? '', ST[x.status] || '', dmy(x.followUp), x.followWhat, x.summary, x.notes]);
  const csv = '﻿' + [head, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${sv.title}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  ctx.toast('הקובץ ירד. בגוגל שיטס: קובץ ← ייבוא ← העלאה');
}
