// סקר מלונות: the admin page for surveying hotels.
// Calls are recorded on the work phone; while "survey mode" is on, the Google script reads them with Gemini
// and fills the hotels here. Every hotel keeps its whole history: calls (summary, key sentences with their
// time, the full transcript, the recording), e-mails sent and the replies, and notes, all searchable.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  if (openSurvey && cur) surveyView(pg); else { pg.append(lookupCard()); homeView(pg); }
  lastSeen = lastSeen || home.connection?.last || null; startPolling();
  if (!wizSeen) { const i = stepsState().findIndex(x => !x.done); if (i >= 0) setTimeout(() => openWizard(i), 500); else wizSeen = true; }
}
const again = () => ctx.rerender();
async function refreshHome() { home = await api('GET'); }
async function refreshSurvey() { cur = await api('GET', '?survey=' + encodeURIComponent(openSurvey)); }

function notReady() {
  return h(`<section class="card"><h2>בדיקת מלונות</h2><p class="hint hint--box">כדי שהסקר יעבוד צריך שמסד הנתונים של האתר (Upstash Redis, אותו אחד של הסטטיסטיקה) יהיה מחובר בפרויקט ב-Vercel.</p></section>`);
}

/* ---------- survey mode: the big switch (made for the phone) ---------- */
function modeBar() {
  const m = home.mode || {}, con = home.connection || {};
  const sv = home.surveys.find(s => s.id === m.surveyId);
  const el = h(`<section class="hs-mode ${m.on ? 'is-on' : ''}">
    <div class="hs-mode__txt">
      <b>${m.on ? 'מצב בדיקה פעיל' : 'מצב בדיקה כבוי'}</b>
      <span>${m.on ? `כל שיחה מעכשיו נכנסת ל<b>${esc(sv?.title || 'סקר')}</b> · מאז ${when(m.since)}` : 'שיחות לא נקראות. מדליקים לפני שמתחילים להתקשר למלונות.'}</span>
    </div>
    <div class="hs-mode__act">
      ${m.on ? '' : `<select class="hs-sel" aria-label="לאיזו כרטיסייה">${home.surveys.map(s => `<option value="${s.id}" ${s.id === (openSurvey || home.surveys[0]?.id) ? 'selected' : ''}>${esc(s.title)}</option>`).join('')}</select>`}
      <button type="button" class="hs-switch" role="switch" aria-checked="${!!m.on}"><span></span>${m.on ? 'לכבות' : 'להדליק'}</button>
    </div>
    <p class="hs-mode__con">${con.connected ? `<i class="dot ${con.ping && Date.now() - Date.parse(con.ping) < 20 * 60e3 ? 'ok' : 'warn'}"></i>החיבור לטלפון: בדיקה אחרונה ${ago(con.ping)}${con.last ? ` · שיחה אחרונה נקלטה ${ago(con.last)}` : ''}${con.skipped ? ` · ${con.skipped} שיחות לא קשורות דולגו` : ''}` : '<i class="dot no"></i>הטלפון עוד לא מחובר. <a href="#" data-connect>לשלבי החיבור</a>'}</p>
  </section>`);
  $('.hs-switch', el).addEventListener('click', async () => {
    if (!m.on && !home.surveys.length) return ctx.toast('קודם פותחים כרטיסייה', 'info');
    try {
      const r = await api('POST', '', { op: 'mode', on: !m.on, surveyId: m.on ? undefined : $('.hs-sel', el)?.value });
      home.mode = r.mode; ctx.toast(r.mode.on ? 'מצב בדיקה הודלק. אפשר להתחיל להתקשר' : 'מצב בדיקה כובה'); again();
    } catch (e) { fail(e); }
  });
  $('[data-connect]', el)?.addEventListener('click', e => { e.preventDefault(); openWizard(Math.max(0, stepsState().findIndex(x => !x.done))); });
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
function lookupCard() {
  const here = openSurvey && cur ? cur.survey : null;   // inside a card: offer to add a hotel from another card
  const c = h(`<section class="card hs-look" id="hs-look">
    <form class="hs-look__f"><label class="hs-look__l" for="hs-look-in">${here ? 'בדיקת מלון שכבר דיברתי איתו' : 'דיברתי כבר עם המקום הזה?'}</label>
      <div class="hs-look__row"><input id="hs-look-in" type="search" inputmode="tel" placeholder="מספר טלפון של מלון (או שם)" value="${esc(look.text)}"><button class="btn btn--dark" type="submit">בדיקה</button></div></form>
    <div class="hs-look__out" aria-live="polite"></div></section>`);
  const out = $('.hs-look__out', c);
  const draw = () => {
    out.innerHTML = '';
    if (look.results == null) return;
    const phone = (look.phone || []).filter(pc => !look.results.some(r => r.last?.file?.id === pc.id));
    if (!look.results.length && !phone.length) {
      out.append(h(look.indexed
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
    phone.forEach(pc => out.append(phoneCall(pc)));
  };
  // A call found on the phone (outside any card): "you talked N days ago, want a summary?" → yes → the robot listens to it
  const phoneCall = pc => {
    const who = pc.name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_ ]?\d{6}[_ -]\d{6}.*$/, '').replace(/^(call ?recording|recording|call)[ _-]*/i, '').trim() || pc.phone;
    const box = h(`<div class="hs-ans hs-ans--phone">
      <p class="hs-ans__q">שיחה בטלפון עם <b><bdi>${esc(who)}</bdi></b>: דיברת <b>${relDay(pc.at)}</b> (${when(pc.at)}).${pc.sum && !pc.sum.error ? '' : ' רוצה סיכום של השיחה?'}</p>
      <div class="row-tools hs-ans__yn"></div><div class="hs-ans__body"></div></div>`);
    const yn = $('.hs-ans__yn', box), body = $('.hs-ans__body', box);
    const show = () => {
      const sm = pc.sum;
      yn.innerHTML = safeUrl(pc.url) ? `<a class="btn btn--line btn--sm" href="${esc(pc.url)}" target="_blank" rel="noopener">להאזנה להקלטה</a>` : '';
      body.innerHTML = `${sm.duration ? `<small>אורך השיחה ${esc(sm.duration)}</small>` : ''}<p>${esc(sm.summary)}</p>
        ${(sm.quotes || []).length ? `<ul class="ev__q">${sm.quotes.map(q => `<li><time>${esc(q.time)}</time>${q.who ? `<b>${esc(q.who)}:</b> ` : ''}"${esc(q.text)}"</li>`).join('')}</ul>` : ''}
        ${sm.transcript ? `<details class="ev__tr"><summary>כל השיחה</summary><p>${esc(sm.transcript).replace(/\n/g, '<br>')}</p></details>` : ''}`;
      if (here) { const wa = h('<button class="btn btn--line btn--sm" type="button">לשלוח כהוכחה בוואטסאפ</button>'); wa.addEventListener('click', () => window.open('https://wa.me/?text=' + encodeURIComponent(`שיחה מ-${when(pc.at)} עם ${who}:\n${sm.summary}\n${(sm.quotes || []).map(q => `[${q.time}] "${q.text}"`).join('\n')}`), '_blank')); yn.append(wa); }
    };
    const waiting = () => { yn.innerHTML = ''; body.innerHTML = '<p class="hs-wait">המערכת מקשיבה לשיחה עכשיו. הסיכום יופיע כאן תוך כ-5 דקות, ותקבל התראה.</p>'; };
    const ask = async () => {
      try {
        const r = await api('POST', '', { op: 'ask', id: pc.id });
        Object.assign(pc, r);
        if (pc.sum && !pc.sum.error) return show();
        waiting(); waitFor(pc, () => { if (box.isConnected) show(); });
      } catch (e) { fail(e); }
    };
    if (pc.sum && !pc.sum.error) show();
    else if (pc.ask) { waiting(); waitFor(pc, () => { if (box.isConnected) show(); }); }
    else {
      const yes = h('<button class="btn btn--gold btn--sm" type="button">כן, סיכום</button>'), no = h('<button class="btn btn--line btn--sm" type="button">לא</button>');
      yes.addEventListener('click', ask); no.addEventListener('click', () => box.remove());
      yn.append(yes, no);
      if (pc.sum?.error) body.innerHTML = '<p class="hint">בפעם הקודמת לא הצלחתי לקרוא את ההקלטה. אפשר לנסות שוב.</p>';
    }
    return box;
  };
  $('form', c).addEventListener('submit', async e => {
    e.preventDefault();
    look.text = $('#hs-look-in', c).value.trim(); look.open = null;
    if (!look.text) { look.results = null; return draw(); }
    try { const r = await api('GET', '?lookup=' + encodeURIComponent(look.text)); look.results = r.results; look.phone = r.phone || []; look.indexed = r.indexed; } catch (e2) { fail(e2); look.results = null; }
    draw();
  });
  draw();
  return c;
}

/* ---------- home: the surveys ---------- */
let showConnect = false, newOpen = false;
function homeView(pg) {
  const list = h(`<section class="card"><div class="card__head"><div><h2>הכרטיסיות שלי</h2><p>כרטיסייה לכל אירוע: שם, סוג ותאריך. בפנים מוסיפים מלונות. רואים רק אתם ומי שבחרתם לשתף.</p></div>
    <div class="row-tools"><button class="btn btn--gold" type="button" data-new>+ כרטיסייה חדשה</button></div></div><div class="hs-surveys"></div></section>`);
  const box = $('.hs-surveys', list);
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
      if (!sv) { openSurvey = r.id; ctx.toast('הכרטיסייה נפתחה. עכשיו מוסיפים מלונות'); } else { await refreshSurvey(); ctx.toast('נשמר'); }
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
function stepsState() { const all = stepsAll(); return inApp() ? all.filter(x => x.id === 'google') : all; }
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
    rec: `<a class="btn btn--gold" href="/app/lbv-calls.apk" download data-dl>1. הורדת האפליקציה</a><button class="btn btn--dark" type="button" data-go>2. חיבור האפליקציה</button>`,
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
  $('[data-go]', w).addEventListener('click', async e => {
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
let editSurvey = false, shareOpen = false, addOpen = false, addPrefill = null, lookOpen = false;
function surveyView(pg) {
  const { survey: sv, hotels } = cur;
  const head = h(`<section class="card hs-head">
    <button type="button" class="hs-back" data-back>→ כל הכרטיסיות</button>
    <div class="hs-head__t"><h2>${esc(sv.title)}</h2>
      <p>${sv.kind ? esc(sv.kind) + ' · ' : ''}${sv.from ? 'תאריך: ' + dmy(sv.from) + (sv.to && sv.to !== sv.from ? ' – ' + dmy(sv.to) : '') : 'בלי תאריכים'}${sv.area ? ' · ' + esc(sv.area) : ''}${sv.need ? ' · ' + esc(sv.need) : ''}</p></div>
    <div class="hs-tools">
      <button class="btn btn--gold btn--sm" type="button" data-wa>סיכום לוואטסאפ</button>
      ${safeUrl(sv.sheetUrl) ? `<a class="btn btn--line btn--sm" href="${esc(sv.sheetUrl)}" target="_blank" rel="noopener">הגיליון בגוגל</a>` : ''}
      <button class="btn btn--line btn--sm" type="button" data-csv>הורדה לגוגל שיטס / אקסל</button>
      ${sv.manage ? '<button class="btn btn--line btn--sm" type="button" data-share>שיתוף</button><button class="btn btn--line btn--sm" type="button" data-edit>עריכה</button>' : ''}
    </div>
  </section>`);
  $('[data-back]', head).addEventListener('click', () => { openSurvey = null; cur = null; openHotel = null; addOpen = false; lookOpen = false; look = { text: '', results: null, open: null }; again(); });
  $('[data-wa]', head).addEventListener('click', () => { const t = waSummary(sv, hotels); window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank'); });
  $('[data-csv]', head).addEventListener('click', () => downloadCsv(sv, hotels));
  $('[data-share]', head)?.addEventListener('click', () => { shareOpen = !shareOpen; again(); });
  $('[data-edit]', head)?.addEventListener('click', () => { editSurvey = !editSurvey; again(); });
  pg.append(head);
  if (editSurvey) pg.append(surveyForm(sv));
  if (shareOpen && sv.manage) pg.append(shareCard(sv));

  if (openHotel) { const ho = hotels.find(x => x.id === openHotel); if (ho) return pg.append(hotelView(sv, ho)); openHotel = null; }

  // The two main actions inside a card
  const acts = h(`<section class="hs-acts">
    <button type="button" class="hs-act ${addOpen ? 'on' : ''}" data-a="add"><b>+ הוספת מלון</b><span>שם וטלפון, השאר מתמלא מהשיחה</span></button>
    <button type="button" class="hs-act ${lookOpen ? 'on' : ''}" data-a="look"><b>בדיקת מלון שכבר דיברתי איתו</b><span>לפי מספר טלפון או שם, מכל הכרטיסיות</span></button>
  </section>`);
  $('[data-a=add]', acts).addEventListener('click', () => { addOpen = !addOpen; addPrefill = null; lookOpen = false; again(); });
  $('[data-a=look]', acts).addEventListener('click', () => { lookOpen = !lookOpen; addOpen = false; again(); setTimeout(() => $('#hs-look-in')?.focus(), 0); });
  pg.append(acts);
  if (addOpen) pg.append(hotelForm(sv, null));
  if (lookOpen) pg.append(lookupCard());

  // Search across everything that was said and written
  const bar = h(`<section class="hs-bar">
    <input type="search" class="hs-q" placeholder="חיפוש בכל השיחות, המיילים וההערות (למשל: תפוס, מלון X, 1800)" value="${esc(query)}">
    <div class="hs-chips">${[['all', 'הכול'], ['avail', 'יש מקום'], ['followup', 'לחזור אליהם'], ['waiting', 'מחכים להצעה'], ['full', 'תפוס']].map(([k, n]) => `<button type="button" class="chip ${filter === k ? 'on' : ''}" data-f="${k}">${n}</button>`).join('')}
      <select class="hs-sort" aria-label="מיון">${[['price', 'לפי מחיר'], ['recent', 'לפי עדכון אחרון'], ['name', 'לפי שם']].map(([k, n]) => `<option value="${k}" ${sortBy === k ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
  </section>`);
  const q = $('.hs-q', bar);
  q.addEventListener('input', () => { query = q.value; drawList(); });
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
  if (window.LBVApp?.share) { window.LBVApp.share(`${sv.title}.csv`, csv); return; }   // inside the phone app: share / save the file
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `${sv.title}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  ctx.toast('הקובץ ירד. בגוגל שיטס: קובץ ← ייבוא ← העלאה');
}
