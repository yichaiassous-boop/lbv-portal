// The LBV app pages: the home screen of the app, the events calendar (לוח אירועים) and the screens remote (השלט).
// Data: /api/events (api/_events.js). The remote reads the same Redis keys as lbv-screens: no link, no key (owner/admin only).
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const dmy = s => (s || '').split('-').reverse().join('.');

export const KIND = { wedding: 'חתונה', barmitzvah: 'בר מצווה', batmitzvah: 'בת מצווה', shabbat: 'שבת חתן', gala: 'ערב גאלה', holiday: 'נופש / חג', other: 'אחר' };
export const STATUS = { option: 'אופציה', confirmed: 'סגור', done: 'בוצע', cancelled: 'בוטל' };
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const WD = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const WD_LONG = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const dayName = s => { const d = new Date(s + 'T12:00'); return `יום ${WD_LONG[d.getDay()]}, ${d.getDate()} ב${MONTHS[d.getMonth()]}`; };

let ctx = null;            // { toast, showLogin, go, me }
let data = null;           // GET /api/events
let month = null;          // 'YYYY-MM' shown in the calendar
let picked = null;         // 'YYYY-MM-DD' selected day

async function api(method, qs = '', body) {
  const r = await fetch('/api/events' + qs, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { ctx.toast('פג תוקף הכניסה. היכנסו שוב', 'err'); ctx.showLogin(); throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}
const fail = e => { if (e.message !== 'login') ctx.toast(e.message === 'not-configured' ? 'מסד הנתונים עוד לא מחובר לאתר' : e.message === 'forbidden' ? 'אין לך הרשאה לפעולה הזאת' : 'משהו השתבש. נסו שוב', 'err'); };
async function load(force) { if (!data || force) data = await api('GET'); return data; }
const evOn = d => (data?.events || []).filter(e => e.date === d || (e.end && e.date <= d && e.end >= d));
const upcoming = (n = 6) => (data?.events || []).filter(e => (e.end || e.date) >= today() && e.status !== 'cancelled').slice(0, n);

function evRow(e) {
  const multi = e.end && e.end !== e.date;
  return `<button type="button" class="ev-row ev--${e.status}" data-ev="${esc(e.id)}">
    <span class="ev-row__date"><b>${+e.date.slice(8)}</b><small>${MONTHS[+e.date.slice(5, 7) - 1].slice(0, 3)}</small></span>
    <span class="ev-row__main"><b>${esc(e.title)}</b><small>${esc(KIND[e.kind] || '')}${e.time ? ' · ' + esc(e.time) : ''}${e.place ? ' · ' + esc(e.place) : ''}${multi ? ' · עד ' + dmy(e.end) : ''}</small></span>
    <span class="ev-pill ev-pill--${e.status}">${STATUS[e.status]}</span></button>`;
}
function bindRows(root) { $$('[data-ev]', root).forEach(b => b.addEventListener('click', () => openSheet(data.events.find(e => e.id === b.dataset.ev)))); }

/* ================= the calendar ================= */
export async function eventsPage(pg, c) {
  ctx = c;
  pg.append(h('<p class="hint">טוען…</p>'));
  try { await load(true); } catch (e) { pg.innerHTML = ''; fail(e); return; }
  pg.innerHTML = '';
  month = month || today().slice(0, 7);
  picked = picked || today();
  draw(pg);
}
function draw(pg) {
  pg.innerHTML = '';
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate();
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push('<span class="cal__d cal__d--pad"></span>');
  for (let d = 1; d <= days; d++) {
    const s = `${month}-${pad(d)}`, list = evOn(s), wd = new Date(y, m - 1, d).getDay();
    cells.push(`<button type="button" class="cal__d${s === today() ? ' is-today' : ''}${s === picked ? ' is-picked' : ''}${wd >= 5 ? ' is-weekend' : ''}" data-day="${s}" aria-label="${dayName(s)}${list.length ? ', ' + list.length + ' אירועים' : ''}">
      <span class="cal__n">${d}</span>
      <span class="cal__evs">${list.slice(0, 3).map(e => `<i class="ev--${e.status}"><em>${esc(e.title)}</em></i>`).join('')}${list.length > 3 ? `<small>+${list.length - 3}</small>` : ''}</span></button>`);
  }
  const canEdit = data.can?.edit;
  const c = h(`<section class="card cal">
    <div class="cal__head">
      <div class="cal__title"><h2>${MONTHS[m - 1]} <span>${y}</span></h2></div>
      <div class="cal__nav">
        <button class="icon" type="button" data-mv="-1" aria-label="החודש הקודם">›</button>
        <button class="btn btn--line btn--sm" type="button" data-today>היום</button>
        <button class="icon" type="button" data-mv="1" aria-label="החודש הבא">‹</button>
        ${canEdit ? '<button class="btn btn--gold btn--sm" type="button" data-new>+ אירוע חדש</button>' : ''}
      </div>
    </div>
    <div class="cal__wd">${WD.map(w => `<span>${w}</span>`).join('')}</div>
    <div class="cal__grid">${cells.join('')}</div>
    <div class="cal__legend">${Object.entries(STATUS).map(([k, v]) => `<span><i class="ev--${k}"></i>${v}</span>`).join('')}</div>
  </section>`);
  $$('[data-mv]', c).forEach(b => b.addEventListener('click', () => { const d = new Date(y, m - 1 + Number(b.dataset.mv), 1); month = iso(d).slice(0, 7); draw(pg); }));
  $('[data-today]', c).addEventListener('click', () => { month = today().slice(0, 7); picked = today(); draw(pg); });
  $('[data-new]', c)?.addEventListener('click', () => openSheet(null, picked));
  $$('[data-day]', c).forEach(b => b.addEventListener('click', () => { picked = b.dataset.day; draw(pg); $('.cal-day')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }));
  pg.append(c);

  const list = evOn(picked);
  const dayCard = h(`<section class="card cal-day">
    <div class="card__head"><div><h2>${dayName(picked)}</h2><p>${list.length ? list.length === 1 ? 'אירוע אחד' : list.length + ' אירועים' : 'אין אירועים ביום הזה'}</p></div>
    ${canEdit ? '<div class="row-tools"><button class="btn btn--line btn--sm" type="button" data-add>+ אירוע ביום הזה</button></div>' : ''}</div>
    <div class="ev-list">${list.map(evRow).join('')}</div></section>`);
  $('[data-add]', dayCard)?.addEventListener('click', () => openSheet(null, picked));
  bindRows(dayCard);
  pg.append(dayCard);

  const up = upcoming(8);
  const upCard = h(`<section class="card"><div class="card__head"><div><h2>הקרובים</h2><p>${up.length ? 'מהיום והלאה' : 'אין אירועים קרובים ביומן'}</p></div></div>
    <div class="ev-list">${up.map(evRow).join('')}</div></section>`);
  bindRows(upCard);
  pg.append(upCard);
  pg.__redraw = () => draw(pg);
}

/** The add / change sheet. */
function openSheet(ev, date) {
  $('.ev-sheet')?.remove();
  const canEdit = data.can?.edit, e = ev || { date: date || today(), status: 'option', kind: 'wedding' };
  const ro = !canEdit ? 'disabled' : '';
  const opt = (map, v) => Object.entries(map).map(([k, t]) => `<option value="${k}"${k === v ? ' selected' : ''}>${t}</option>`).join('');
  const w = h(`<div class="ev-sheet" role="dialog" aria-modal="true" aria-label="${ev ? 'פרטי האירוע' : 'אירוע חדש'}">
    <form class="ev-sheet__card">
      <div class="ev-sheet__top"><h2>${ev ? esc(ev.title) : 'אירוע חדש'}</h2><button class="icon" type="button" data-x aria-label="סגירה">✕</button></div>
      <label class="f">שם האירוע<input name="title" required maxlength="120" value="${esc(e.title)}" placeholder="למשל: חתונת כהן" ${ro}></label>
      <div class="f2"><label class="f">סוג<select name="kind" ${ro}>${opt(KIND, e.kind)}</select></label>
        <label class="f">מצב<select name="status" ${ro}>${opt(STATUS, e.status)}</select></label></div>
      <div class="f2"><label class="f">תאריך<input type="date" name="date" required value="${esc(e.date)}" ${ro}></label>
        <label class="f">שעה<input type="time" name="time" value="${esc(e.time)}" ${ro}></label></div>
      <label class="f">עד תאריך <small>(לאירוע של כמה ימים, כמו שבת או נופש)</small><input type="date" name="end" value="${esc(e.end)}" ${ro}></label>
      <label class="f">מקום<input name="place" maxlength="160" value="${esc(e.place)}" placeholder="אולם, מלון, עיר" ${ro}></label>
      <div class="f2"><label class="f">לקוח<input name="client" maxlength="120" value="${esc(e.client)}" ${ro}></label>
        <label class="f">טלפון<input name="phone" type="tel" dir="ltr" maxlength="40" value="${esc(e.phone)}" ${ro}></label></div>
      <div class="f2"><label class="f">מספר אורחים<input name="guests" type="number" min="0" max="5000" inputmode="numeric" value="${esc(e.guests)}" ${ro}></label>
        <label class="f">צוות<input name="staff" maxlength="300" value="${esc(e.staff)}" placeholder="מי עובד באירוע" ${ro}></label></div>
      <label class="f">הערות<textarea name="notes" rows="3" maxlength="3000" ${ro}>${esc(e.notes)}</textarea></label>
      <div class="ev-sheet__acts">
        ${canEdit ? `<button class="btn btn--gold" type="submit">${ev ? 'שמירה' : 'הוספה ללוח'}</button>` : ''}
        ${ev?.phone ? `<a class="btn btn--line" href="tel:${esc(ev.phone)}">התקשרות</a>` : ''}
        ${ev ? '<button class="btn btn--line" type="button" data-wa>שליחה בוואטסאפ</button>' : ''}
        ${ev && data.can?.del ? '<button class="btn btn--danger" type="button" data-del>מחיקה</button>' : ''}
      </div>
    </form></div>`);
  const close = () => w.remove();
  w.addEventListener('click', x => { if (x.target === w) close(); });
  $('[data-x]', w).addEventListener('click', close);
  $('form', w).addEventListener('submit', async x => {
    x.preventDefault();
    const f = Object.fromEntries(new FormData(x.target));
    try {
      await api('POST', '', { op: 'event', id: ev?.id, ...f });
      await load(true);
      picked = f.date; month = f.date.slice(0, 7);
      close(); ctx.toast(ev ? 'נשמר' : 'האירוע נוסף ללוח'); ctx.rerender();
    } catch (e2) { fail(e2); }
  });
  $('[data-wa]', w)?.addEventListener('click', () => {
    const t = [ev.title, `${KIND[ev.kind]} · ${STATUS[ev.status]}`, dayName(ev.date) + (ev.time ? ' · ' + ev.time : '') + (ev.end && ev.end !== ev.date ? ' עד ' + dmy(ev.end) : ''), ev.place, ev.client && 'לקוח: ' + ev.client, ev.guests && 'אורחים: ' + ev.guests, ev.staff && 'צוות: ' + ev.staff, ev.notes].filter(Boolean).join('\n');
    window.open('https://wa.me/?text=' + encodeURIComponent(t), '_blank');
  });
  $('[data-del]', w)?.addEventListener('click', async () => {
    if (!confirm(`למחוק את "${ev.title}" מהלוח? אי אפשר לבטל.`)) return;
    try { await api('DELETE', '?id=' + encodeURIComponent(ev.id)); await load(true); close(); ctx.toast('נמחק'); ctx.rerender(); } catch (e2) { fail(e2); }
  });
  document.body.append(w);
  if (!ev && canEdit) $('[name=title]', w).focus();
}

/* ================= the screens remote (inside the app, no link and no key) ================= */
const CUES = [
  { id: 'WELCOME', t: 'כניסה', s: 'הלוגו וברוכים הבאים' },
  { id: 'FLAME', t: 'הלהבה', s: 'מתמלאת מהתרומות' },
  { id: 'FULL', t: 'להבה מלאה', s: 'פרץ האותיות' },
  { id: 'THANKS', t: 'תודה', s: 'Merci, בסוף הערב' },
];
const GALA_ERR = { NO_LINK: 'עוד לא הודבק הקישור של הערב', LINK_REFUSED: 'אתר הגאלה לא מכיר את הקישור. אולי נוצר קישור חדש לערב', OFFLINE: 'אין חיבור לאתר הגאלה כרגע' };
const openHint = () => (window.LBVApp || !matchMedia('(min-width: 860px)').matches ? 'מהטלפון: נשלח קישור לפעם אחת, ופותחים אותו במחשב של המקרן' : 'נפתח בכרטיסייה חדשה במחשב הזה, וגוררים אותה למקרן');
let rTimer = null, rBusy = false, rState = null;
const money = (n, cur) => (typeof n === 'number' ? n.toLocaleString('he-IL') + ' ' + (cur && cur !== 'EUR' ? cur : '€') : '–');
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

export async function remotePage(pg, c) {
  ctx = c;
  clearInterval(rTimer);
  const root = h(`<div class="rc" aria-live="polite"><p class="rc__wait">מתחבר למסכים…</p></div>`);
  pg.append(root);
  const get = async () => { const r = await fetch('/api/events?screens=1', { cache: 'no-store' }); if (r.status === 401) { ctx.showLogin(); throw new Error('login'); } if (!r.ok) throw new Error(r.status === 403 ? 'forbidden' : 'server'); return r.json(); };
  const send = async (op, body, okMsg) => {
    if (rBusy) return; rBusy = true; root.classList.add('is-busy');
    try { const j = await api('POST', '', { op, ...body }); if (j.state) { rState = j.state; draw(); } if (okMsg) ctx.toast(okMsg); return j; }
    catch (e) { const m = { 'bad-link': 'הקישור לא תקין. צריך את הקישור המלא של הערב, שמסתיים ב-#s=…&k=…', 'bad-price': 'מחיר לא תקין' }[e.message]; m ? ctx.toast(m, 'err') : fail(e); }
    finally { rBusy = false; root.classList.remove('is-busy'); }
  };
  function draw() {
    if (!document.body.contains(root)) { clearInterval(rTimer); return; }
    const s = rState, g = s.gala;
    const pct = g.ok && g.goal ? Math.min(100, Math.round((g.raised || 0) / g.goal * 100)) : 0;
    const focus = document.activeElement && root.contains(document.activeElement) && document.activeElement.matches('input') ? document.activeElement.name : null;
    if (focus) return;   // don't redraw under the fingers
    const dot = `<span class="rc__dot${s.video.live ? ' is-live' : ''}">${s.video.live ? (s.video.playing ? 'מנגן עכשיו' : 'הנגן פתוח על המקרן') : 'הנגן עוד לא פתוח'}</span>`;
    root.innerHTML = `
      <section class="rc__prep">
        <h2>הכנת הערב</h2>
        <ol class="rc__steps">
          <li class="rc__step${s.link.set ? ' is-done' : ' is-now'}">
            <span class="rc__n" aria-hidden="true">${s.link.set ? svg('M5 12l5 5 9-10') : '1'}</span>
            <div class="rc__body">
              <b>הקישור של המסך מיונתן</b>
              <small>${s.link.set ? `מחובר לאתר <bdi dir="ltr">${esc(s.link.host)}</bdi>. מדביקים קישור חדש רק כדי להחליף.` : 'מעתיקים מדף הניהול של הגאלה את קישור המסך (זה שמסתיים ב-<bdi dir="ltr">#s=…&amp;k=…</bdi>) ומדביקים כאן.'}</small>
              <form class="rc__link"><input name="link" type="url" dir="ltr" autocomplete="off" spellcheck="false" aria-label="הקישור של המסך" placeholder="${s.link.set ? 'הדבקת קישור חדש' : 'https://…/live-screen#s=…&k=…'}"><button class="btn btn--gold btn--sm" type="submit">${s.link.set ? 'החלפה' : 'שמירה'}</button></form>
            </div>
          </li>
          <li class="rc__step${s.link.set ? ' is-now' : ''}">
            <span class="rc__n" aria-hidden="true">2</span>
            <div class="rc__body">
              <b>מסך הערב על המקרן</b>
              <small>${openHint()}</small>
              <button type="button" class="rc__big" data-open="screen">${svg('M3 5h18v12H3zM8 21h8M12 17v4')}<span><b>פתיחת מסך הערב</b><small>הלהבה, התרומות והאותיות</small></span></button>
            </div>
          </li>
          <li class="rc__step">
            <span class="rc__n" aria-hidden="true">3</span>
            <div class="rc__body">
              <div class="rc__vhead"><b>הסרטונים</b>${dot}</div>
              <small>קודם פותחים את הנגן במחשב של המקרן, ואז שולטים בו מהשלט.</small>
              <div class="rc__pair">
                <button type="button" class="rc__big" data-open="video">${svg('M4 6h11v12H4zM15 10l5-3v10l-5-3')}<span><b>פתיחת נגן הסרטונים</b><small>על המקרן</small></span></button>
                <button type="button" class="rc__big rc__big--gold" data-open="videoremote">${svg('M7 3h10v18H7zM12 7v.01M10 11h4M10 14h4')}<span><b>שלט הסרטונים</b><small>תוכנית הערב, סרטונים וקריוקי</small></span></button>
              </div>
            </div>
          </li>
        </ol>
      </section>
      <section class="rc__live">
        <h2>במהלך הערב</h2>
        <p class="rc__lbl">מה מוצג עכשיו על מסך הערב</p>
        <div class="rc__cues">${CUES.map(q => `<button type="button" class="rc__cue${s.step === q.id ? ' is-on' : ''}" data-step="${q.id}" aria-pressed="${s.step === q.id}"><b>${q.t}</b><small>${q.s}</small></button>`).join('')}</div>
        <div class="rc__gala${g.ok ? '' : ' is-off'}">
        ${g.ok ? `<div class="rc__sum"><span><small>נאסף עד עכשיו</small><b>${money(g.raised, g.currency)}</b></span><span class="rc__goal"><small>היעד</small><b>${money(g.goal, g.currency)}</b></span></div>
          <div class="rc__bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
          <p class="rc__donor">${g.lastDonor ? `תרומה אחרונה: <b>${esc(g.lastDonor)}</b>` : 'עוד אין תרומות הערב'}</p>`
        : `<p class="rc__off">${esc(GALA_ERR[g.error] || 'אין חיבור לאתר הגאלה')}</p>`}
        </div>
      </section>
      <details class="rc__set">
        <summary>מחירי החבילות וערב חדש</summary>
        <form class="rc__prices"><p class="rc__lbl">מחירי החבילות ביורו (0 = לא נספר)</p>
          <div class="f2">${[['plaques', 'Plaques'], ['noms', 'Noms'], ['mots', 'Mots'], ['lettres', 'Lettres']].map(([k, t]) => `<label class="f">${t}<input name="${k}" type="number" min="0" step="0.01" inputmode="decimal" dir="ltr" value="${esc(s.prices[k])}"></label>`).join('')}</div>
          <button class="btn btn--gold btn--sm" type="submit">שמירת המחירים</button></form>
        <div class="rc__new"><p>ערב חדש מרוקן את הלהבה ואת הריבועים, וחוזר למסך הכניסה.</p><button type="button" class="btn btn--danger btn--sm" data-new>התחלת ערב חדש</button></div>
      </details>`;
    if (root.dataset.open === '1') $('.rc__set', root).open = true;
    $('.rc__set', root).addEventListener('toggle', e => { root.dataset.open = e.target.open ? '1' : ''; });
    $$('[data-step]', root).forEach(b => b.addEventListener('click', () => send('screens', { step: b.dataset.step })));
    // On the projector's computer: opens the page in a new tab. On a phone: shares or copies a one-time
    // link (10 minutes) to open on the projector's computer.
    $$('[data-open]', root).forEach(b => b.addEventListener('click', async () => {
      const mine = b.dataset.open === 'videoremote';
      const here = !window.LBVApp && (mine || matchMedia('(min-width: 860px)').matches);
      const w = here ? window.open('', '_blank') : null;   // a browser blocks a window opened after the await
      const j = await send('open', { page: b.dataset.open });
      if (!j?.url) { w?.close(); return; }
      if (w) { w.opener = null; w.location = j.url; return; }
      if (mine) { location.href = j.url; return; }
      const what = b.dataset.open === 'video' ? 'נגן הסרטונים' : 'מסך הערב';
      if (navigator.share) { try { await navigator.share({ title: what, text: what + ' (קישור לפעם אחת, ל-10 דקות)', url: j.url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
      try { await navigator.clipboard.writeText(j.url); ctx.toast('הקישור הועתק. פותחים אותו במחשב של המקרן בתוך 10 דקות'); }
      catch (e) { prompt('הקישור למחשב של המקרן (לפעם אחת, ל-10 דקות):', j.url); }
    }));
    $('.rc__link', root).addEventListener('submit', e => { e.preventDefault(); const u = e.target.link.value.trim(); if (u) send('screens', { link: u }, 'הקישור של המסך נשמר').then(() => { e.target.link.value = ''; }); });
    $('.rc__prices', root).addEventListener('submit', e => { e.preventDefault(); const f = e.target; send('screens', { prices: { plaques: f.plaques.value, noms: f.noms.value, mots: f.mots.value, lettres: f.lettres.value } }, 'המחירים נשמרו'); });
    $('[data-new]', root).addEventListener('click', () => { if (confirm('להתחיל ערב חדש? הלהבה והריבועים יתרוקנו.')) send('screens', { newEvening: true }, 'התחיל ערב חדש'); });
  }
  const tick = async () => { if (rBusy || document.hidden) return; try { const n = await get(); if (!document.body.contains(root)) { clearInterval(rTimer); return; } const sig = x => JSON.stringify({ ...x, now: 0 }); if (sig(n) === sig(rState)) return; rState = n; draw(); } catch (e) { if (e.message === 'forbidden') { root.innerHTML = '<p class="rc__wait">השלט פתוח רק לבעלים ולמנהלים.</p>'; clearInterval(rTimer); } } };
  try { rState = await get(); draw(); } catch (e) { root.innerHTML = `<p class="rc__wait">${e.message === 'forbidden' ? 'השלט פתוח רק לבעלים ולמנהלים.' : 'אין חיבור למסכים כרגע. נסו שוב בעוד רגע.'}</p>`; return; }
  rTimer = setInterval(tick, 3000);
}

/* ================= the home screen of the app ================= */
const daysTo = d => Math.round((new Date(d + 'T12:00') - new Date(today() + 'T12:00')) / 864e5);
const whenText = n => (n <= 0 ? 'היום' : n === 1 ? 'מחר' : n === 2 ? 'מחרתיים' : `בעוד ${n} ימים`);

export async function appHome(pg, c, tiles) {
  ctx = c;
  try { await load(true); } catch (e) { data = { events: [], can: {} }; }
  const hr = new Date().getHours();
  const hello = hr < 5 ? 'לילה טוב' : hr < 12 ? 'בוקר טוב' : hr < 17 ? 'צהריים טובים' : hr < 21 ? 'ערב טוב' : 'לילה טוב';
  const name = c.me?.role === 'owner' ? '' : c.me?.name || '';
  const next = upcoming(1)[0];
  const head = h(`<section class="ah">
    <p class="ah__date">${dayName(today())}</p>
    <h1 class="ah__hi">${hello}${name ? ', ' + esc(name) : ''}</h1>
  </section>`);
  pg.append(head);
  if (next) {
    const n = daysTo(next.date);
    const card = h(`<div class="inv-wrap"><button type="button" class="inv ev--${next.status}" data-ev="${esc(next.id)}">
      <span class="inv__frame">
        <small class="inv__kind">${n <= 0 ? 'האירוע של היום' : 'האירוע הבא'}${KIND[next.kind] && KIND[next.kind] !== next.title ? ' · ' + esc(KIND[next.kind]) : ''}</small>
        <b class="inv__title">${esc(next.title)}</b>
        <span class="inv__when">${dayName(next.date)}${next.time ? ', ' + esc(next.time) : ''}</span>
        ${next.place ? `<span class="inv__place">${esc(next.place)}</span>` : ''}
        <span class="inv__count">${whenText(n)}</span>
      </span></button></div>`);
    bindRows(card);
    pg.append(card);
  } else if (data.can?.edit) {
    const empty = h(`<button type="button" class="inv inv--empty"><span class="inv__frame"><b class="inv__title">אין אירועים קרובים בלוח</b><span class="inv__when">מוסיפים את האירוע הראשון, והוא יופיע כאן</span></span></button>`);
    empty.addEventListener('click', () => c.go('events'));
    pg.append(empty);
  }
  const [lead, ...rest] = tiles;
  const grid = h(`<nav class="ah-grid" aria-label="האפליקציה">${[lead, ...rest].filter(Boolean).map((t, i) => `<button type="button" class="ah-tile${i === 0 ? ' ah-tile--lead' : ''}" data-go="${t.id}">
      <span class="ah-tile__ic">${`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${t.icon}"/></svg>`}</span>
      <span class="ah-tile__tx"><b>${esc(t.title)}</b><small>${esc(t.sub)}</small></span>${t.badge ? `<span class="ah-tile__n" aria-label="${t.badge} חדשות">${t.badge}</span>` : ''}</button>`).join('')}</nav>`);
  $$('[data-go]', grid).forEach(b => b.addEventListener('click', () => c.go(b.dataset.go)));
  pg.append(grid);
  const up = upcoming(5).filter(e => e.id !== next?.id).slice(0, 4);
  if (up.length) {
    const l = h(`<section class="ah-up"><div class="ah-up__head"><h2>בהמשך</h2><button class="ah-up__all" type="button" data-cal>כל הלוח</button></div><div class="ev-list">${up.map(evRow).join('')}</div></section>`);
    $('[data-cal]', l).addEventListener('click', () => c.go('events'));
    bindRows(l);
    pg.append(l);
  }
  // Who is logged in here + switch user (the phone's recordings go to the robot of the user logged in on it).
  const who = h(`<section class="ah-who"><span>מחובר בתור <b>${esc(c.me?.role === 'owner' ? 'הבעלים' : c.me?.name || '')}</b></span><button type="button" class="ah-who__sw" data-switch>החלפת משתמש</button></section>`);
  $('[data-switch]', who).addEventListener('click', async () => {
    if (!confirm('לצאת ולהיכנס עם משתמש אחר?')) return;
    try { await fetch('/api/login', { method: 'DELETE' }); } catch (e) {}
    try { window.LBVApp?.loggedOut?.(); } catch (e) {}
    location.reload();
  });
  pg.append(who);
}

/** "עריכת האתר" inside the app: the parts of the site, as a list. */
export function appSite(pg, c, pages) {
  ctx = c;
  pg.append(h(`<section class="card"><div class="card__head"><div><h2>עריכת האתר</h2><p>בוחרים חלק באתר, משנים, ולוחצים "שמירה ופרסום".</p></div></div>
    <div class="as-list">${pages.map(p => `<button type="button" class="as-row" data-go="${esc(p.id)}"><b>${esc(p.title)}</b><small>${esc(p.sub || '')}</small><span aria-hidden="true">‹</span></button>`).join('')}</div></section>`));
  $$('[data-go]', pg).forEach(b => b.addEventListener('click', () => c.go(b.dataset.go)));
}
