// The LBV app pages: the home screen of the app, the events calendar (לוח אירועים) and the screens remote (השלט).
// Data: /api/events (api/_events.js). The remote's link holds its key: the server sends it only to owner/admin.
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

/* ================= the screens remote ================= */
export async function remotePage(pg, c) {
  ctx = c;
  pg.append(h('<p class="hint">טוען…</p>'));
  try { await load(true); } catch (e) { pg.innerHTML = ''; fail(e); return; }
  pg.innerHTML = '';
  const r = data.remote || {}, owner = data.can?.setRemote;
  const card = h(`<section class="card remote">
    <div class="remote__hero">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="3"/><circle cx="12" cy="8" r="2"/><path d="M10 13h4M10 16h4"/></svg>
      <div><h2>השלט של המסכים</h2><p>שולטים מהטלפון במסך של האירוע: מה מוצג, מתי, ובאיזה מסך.</p></div>
    </div>
    ${r.url ? `<a class="btn btn--gold btn--block remote__go" href="${esc(r.url)}">פתיחת השלט</a>` : `<p class="msg">${owner ? 'עוד לא חובר. מדביקים כאן פעם אחת את הקישור של השלט, וזהו.' : 'השלט עוד לא חובר. רק הבעלים יכול לחבר אותו.'}</p>`}
    ${owner ? `<details class="remote__set"${r.url ? '' : ' open'}><summary>${r.url ? 'החלפת הקישור של השלט' : 'חיבור השלט'}</summary>
      <form class="remote__f"><label class="f">הקישור של השלט <small>(הכתובת שבה פותחים את השלט בטלפון, מתחילה ב-https://lbv-screens.vercel.app)</small>
        <input name="url" type="url" dir="ltr" autocomplete="off" spellcheck="false" placeholder="https://lbv-screens.vercel.app/admin#k=…"></label>
        <div class="row-tools"><button class="btn btn--dark btn--sm" type="submit">שמירה</button>${r.url ? '<button class="btn btn--danger btn--sm" type="button" data-rm>ניתוק</button>' : ''}</div>
        <p class="hint">הקישור נשמר בשרת בלבד ונשלח רק לבעלים ולמנהלים. הוא לא מופיע בקוד ולא נשלח לאף מקום אחר.</p></form></details>` : ''}
  </section>`);
  const f = $('.remote__f', card);
  const save = async u => {
    try { await api('POST', '', { op: 'remote', url: u }); await load(true); ctx.toast(u ? 'השלט חובר' : 'השלט נותק'); ctx.rerender(); }
    catch (e) { if (e.message === 'bad-url') ctx.toast('זה לא הקישור של השלט. הוא מתחיל ב-https://lbv-screens.vercel.app', 'err'); else fail(e); }
  };
  f?.addEventListener('submit', x => { x.preventDefault(); const u = f.url.value.trim(); if (u) save(u); });
  $('[data-rm]', card)?.addEventListener('click', () => { if (confirm('לנתק את השלט מהאפליקציה?')) save(''); });
  pg.append(card);
}

/* ================= the home screen of the app ================= */
export async function appHome(pg, c, tiles) {
  ctx = c;
  try { await load(true); } catch (e) { data = { events: [], can: {}, remote: {} }; }
  const hr = new Date().getHours();
  const hello = hr < 5 ? 'לילה טוב' : hr < 12 ? 'בוקר טוב' : hr < 17 ? 'צהריים טובים' : hr < 21 ? 'ערב טוב' : 'לילה טוב';
  const name = c.me?.role === 'owner' ? '' : c.me?.name || '';
  const next = upcoming(1)[0];
  const head = h(`<section class="ah">
    <p class="ah__date">${dayName(today())}</p>
    <h1 class="ah__hi">${hello}${name ? ', ' + esc(name) : ''}</h1>
    ${next ? `<button type="button" class="ah__next" data-ev="${esc(next.id)}"><small>האירוע הבא</small><b>${esc(next.title)}</b><span>${dayName(next.date)}${next.time ? ' · ' + esc(next.time) : ''}${next.place ? ' · ' + esc(next.place) : ''}</span></button>` : ''}
  </section>`);
  bindRows(head);
  pg.append(head);
  const grid = h(`<section class="ah-grid">${tiles.map(t => `<button type="button" class="ah-tile" data-go="${t.id}">
      <span class="ah-tile__ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${t.icon}"/></svg></span>
      <b>${esc(t.title)}</b><small>${esc(t.sub)}</small>${t.badge ? `<span class="ah-tile__n">${t.badge}</span>` : ''}</button>`).join('')}</section>`);
  $$('[data-go]', grid).forEach(b => b.addEventListener('click', () => c.go(b.dataset.go)));
  pg.append(grid);
  const up = upcoming(4);
  if (up.length) {
    const l = h(`<section class="card"><div class="card__head"><div><h2>השבועות הקרובים</h2></div><div class="row-tools"><button class="btn btn--line btn--sm" type="button" data-cal>ללוח המלא</button></div></div><div class="ev-list">${up.map(evRow).join('')}</div></section>`);
    $('[data-cal]', l).addEventListener('click', () => c.go('events'));
    bindRows(l);
    pg.append(l);
  }
}

/** "עריכת האתר" inside the app: the parts of the site, as a list. */
export function appSite(pg, c, pages) {
  ctx = c;
  pg.append(h(`<section class="card"><div class="card__head"><div><h2>עריכת האתר</h2><p>בוחרים חלק באתר, משנים, ולוחצים "שמירה ופרסום".</p></div></div>
    <div class="as-list">${pages.map(p => `<button type="button" class="as-row" data-go="${esc(p.id)}"><b>${esc(p.title)}</b><small>${esc(p.sub || '')}</small><span aria-hidden="true">‹</span></button>`).join('')}</div></section>`));
  $$('[data-go]', pg).forEach(b => b.addEventListener('click', () => c.go(b.dataset.go)));
}
