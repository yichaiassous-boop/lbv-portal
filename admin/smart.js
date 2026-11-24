// owner 22.11: the "smart" pages.
//  - השיחות: every call on the work phone, sorted by who called (by the number): Ilan, a hotel, an artist, a client, other.
//    A number nobody knows can be tagged once, and every call from it (now and later) goes under that tag.
//    It includes the calls with Ilan, so only the owner and מעיין see it (api/_hotels.js, like the Ilan tab).
//  - מאגר המלונות: every hotel we ever called, from all the surveys, once each. Search by area / name, max price,
//    and the best options first (has room, then the cheapest).
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const safeUrl = u => (/^https:\/\//i.test(String(u || '')) ? u : '');
const when = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' }) + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); };
const day = iso => (iso ? new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' }) : '');
const money = (n, c) => (c === 'EUR' ? '€' : c === 'USD' ? '$' : '₪') + Number(n).toLocaleString('he-IL');

let ctx = null;
async function api(method, qs = '', body) {
  const r = await fetch('/api/hotels' + qs, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { ctx.toast('פג תוקף הכניסה. היכנסו שוב', 'err'); ctx.showLogin(); throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}
const fail = e => { if (e.message !== 'login') ctx.toast(e.message === 'forbidden' ? 'אין לך הרשאה לזה' : 'משהו השתבש. נסו שוב', 'err'); };

/* ---------------- השיחות ---------------- */
const CATS = {
  ilan: { t: 'אילן', c: '#6b4fa0' }, hotel: { t: 'מלונות', c: '#1f6f8b' }, artist: { t: 'אמנים', c: '#7a2e4d' }, client: { t: 'לקוחות', c: '#2f7d4f' },
  supplier: { t: 'ספקים', c: '#a8661c' }, team: { t: 'צוות', c: '#44546a' }, private: { t: 'פרטי', c: '#8a8f98' }, other: { t: 'לא מזוהה', c: '#b42318' },
};
const TAGGABLE = ['hotel', 'artist', 'client', 'supplier', 'team', 'private', 'other'];
const ONE = { hotel: 'מלון', artist: 'אמן', client: 'לקוח', supplier: 'ספק', team: 'צוות', private: 'פרטי', other: 'אחר' };
let calls = null, callCat = 'all', callQ = '';

export async function callsPage(pg, c) {
  ctx = c;
  if (!calls) {
    pg.append(h('<p class="hint">טוען…</p>'));
    try { calls = await api('GET', '?calls=1'); } catch (e) { pg.innerHTML = ''; fail(e); return; }
    pg.innerHTML = '';
  }
  const list = calls.calls || [], counts = calls.counts || {};
  const bar = h(`<div class="sm-bar">
    <div class="sm-chips" role="group" aria-label="סינון לפי מי התקשר">
      <button type="button" data-cat="all"${callCat === 'all' ? ' aria-pressed="true"' : ''}>הכול <small>${list.length}</small></button>
      ${Object.entries(CATS).filter(([k]) => counts[k]).map(([k, v]) => `<button type="button" data-cat="${k}" style="--cc:${v.c}"${callCat === k ? ' aria-pressed="true"' : ''}><i></i>${v.t} <small>${counts[k]}</small></button>`).join('')}
    </div>
    <input class="input sm-q" type="search" placeholder="חיפוש: שם, מספר או מילה מהסיכום" value="${esc(callQ)}" aria-label="חיפוש בשיחות">
  </div>`);
  bar.querySelectorAll('[data-cat]').forEach(b => b.addEventListener('click', () => { callCat = b.dataset.cat; ctx.rerender(); }));
  const q = bar.querySelector('.sm-q');
  q.addEventListener('input', () => { callQ = q.value; draw(); });
  const box = h('<div class="sm-list"></div>');
  pg.append(bar);
  if (counts.other) pg.append(h(`<p class="hint sm-note">${counts.other} שיחות ממספרים שהמערכת עוד לא מכירה. לוחצים "מי זה?" פעם אחת, וכל שיחה מהמספר הזה תיכנס מעכשיו למקום הנכון.</p>`));
  pg.append(box);
  function draw() {
    const words = callQ.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = list.filter(x => (callCat === 'all' || x.cat === callCat) && words.every(w => [x.who, x.sub, x.name, x.phone, x.summary, x.survey, x.artist].join(' ').toLowerCase().includes(w)));
    box.innerHTML = rows.length ? '' : '<p class="hint">אין שיחות שמתאימות.</p>';
    for (const x of rows.slice(0, 150)) box.append(callRow(x));
  }
  draw();
}
const againCalls = async () => { try { calls = await api('GET', '?calls=1'); } catch (e) { fail(e); } ctx.rerender(); };

function callRow(x) {
  const k = CATS[x.cat] || CATS.other, url = safeUrl(x.url);
  const el = h(`<article class="sm-call" style="--cc:${esc(x.color || k.c)}">
    <span class="sm-call__cat">${k.t}</span>
    <div class="sm-call__main">
      <b>${esc(x.who || x.name || x.phone || 'מספר לא ידוע')}${x.artist ? ` <small>(${esc(x.artist)})</small>` : ''}</b>
      <small>${[x.sub, x.survey ? 'בדיקה: ' + x.survey : '', x.phone ? `<span dir="ltr">${esc(x.phone)}</span>` : '', when(x.at)].filter(Boolean).map(v => (v.startsWith('<span') ? v : esc(v))).join(' · ')}</small>
      ${x.summary ? `<p>${esc(x.summary)}</p>` : ''}
    </div>
    <div class="sm-call__acts">
      ${url ? `<a class="btn btn--line" href="${esc(url)}" target="_blank" rel="noopener">להקשיב</a>` : ''}
      ${ctx.quote && !['ilan', 'hotel', 'supplier', 'team', 'private'].includes(x.cat) ? '<button type="button" class="btn btn--gold" data-q>הצעת מחיר</button>' : ''}
      ${x.phone ? `<button type="button" class="btn btn--line" data-tag>${x.cat === 'other' ? 'מי זה?' : 'לשנות'}</button>` : ''}
    </div>
  </article>`);
  el.querySelector('[data-tag]')?.addEventListener('click', () => tagSheet(x));
  el.querySelector('[data-q]')?.addEventListener('click', () => ctx.quote(x));
  return el;
}

function tagSheet(x) {
  document.querySelector('.ev-sheet')?.remove();
  const w = h(`<div class="ev-sheet" role="dialog" aria-modal="true" aria-label="מי זה?">
    <form class="ev-sheet__card">
      <div class="ev-sheet__top"><h2>מי זה? <small dir="ltr">${esc(x.phone)}</small></h2><button class="icon" type="button" data-x aria-label="סגירה">✕</button></div>
      <p class="hint">כל שיחה מהמספר הזה, גם הישנות וגם הבאות, תיכנס לכאן.</p>
      <div class="sm-chips sm-chips--pick" role="radiogroup" aria-label="סוג">
        ${TAGGABLE.map(k2 => `<label style="--cc:${CATS[k2].c}"><input type="radio" name="cat" value="${k2}"${(x.byHand ? x.cat : x.cat === 'other' ? '' : x.cat) === k2 ? ' checked' : ''} required><i></i>${ONE[k2]}</label>`).join('')}
      </div>
      <label class="f">שם <small>(למשל: מלון יהודה, ספק הגברה, אמא של החתן)</small><input name="name" maxlength="80" value="${esc(x.byHand ? x.who : '')}"></label>
      <div class="ev-sheet__acts"><button class="btn btn--gold" type="submit">לשמור</button>${x.byHand ? '<button class="btn btn--danger" type="button" data-clear>לבטל את הסימון</button>' : ''}</div>
    </form></div>`);
  const close = () => w.remove();
  w.addEventListener('click', e => { if (e.target === w) close(); });
  w.querySelector('[data-x]').addEventListener('click', close);
  w.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('POST', '', { op: 'tag', phone: x.phone, cat: f.cat, name: f.name }); close(); ctx.toast('נשמר'); againCalls(); } catch (e2) { fail(e2); }
  });
  w.querySelector('[data-clear]')?.addEventListener('click', async () => {
    try { await api('POST', '', { op: 'tag', phone: x.phone, cat: '' }); close(); ctx.toast('הסימון בוטל'); againCalls(); } catch (e2) { fail(e2); }
  });
  document.body.append(w);
}

/* ---------------- מאגר המלונות ---------------- */
const AV = { available: ['יש מקום', 'ok'], partial: ['מקום חלקי', 'mid'], full: ['תפוס', 'no'], unknown: ['לא ידוע', 'unk'] };
const AV_RANK = { available: 0, partial: 1, unknown: 2, full: 3 };
let cat = null, cq = '', cmax = '', cavail = false;

export async function catalogPage(pg, c) {
  ctx = c;
  pg.append(h('<p class="hint">טוען…</p>'));
  try { cat = await api('GET', '?catalog=1'); } catch (e) { pg.innerHTML = ''; fail(e); return; }
  pg.innerHTML = '';
  const all = cat.hotels || [];
  if (!all.length) { pg.append(h('<section class="card"><h2>עוד אין מלונות במאגר</h2><p class="hint">כל מלון שמתקשרים אליו בבדיקת מלונות נכנס לכאן לבד, עם המחיר והזמינות האחרונים.</p></section>')); return; }
  const bar = h(`<form class="sm-bar sm-bar--cat" role="search">
    <input class="input" name="q" type="search" placeholder="אזור, עיר או שם מלון" value="${esc(cq)}" aria-label="חיפוש לפי אזור, עיר או שם">
    <label class="sm-max">עד <input class="input" name="max" type="number" inputmode="numeric" min="0" step="50" value="${esc(cmax)}" placeholder="מחיר" aria-label="מחיר מקסימלי"> ₪</label>
    <label class="sm-check"><input type="checkbox" name="av"${cavail ? ' checked' : ''}> רק עם מקום</label>
  </form>`);
  const box = h('<div class="sm-cat"></div>'), sum = h('<p class="hint sm-note"></p>');
  bar.addEventListener('submit', e => e.preventDefault());
  bar.addEventListener('input', () => { cq = bar.q.value; cmax = bar.max.value; cavail = bar.av.checked; draw(); });
  pg.append(bar, sum, box);
  function draw() {
    const words = cq.trim().toLowerCase().split(/\s+/).filter(Boolean), max = Number(cmax) || 0;
    const rows = all.filter(x => words.every(w => [x.name, x.city, x.area, x.contact, x.summary].join(' ').toLowerCase().includes(w))
      && (!max || (x.min && x.min.price <= max)) && (!cavail || x.avail === 'available' || x.avail === 'partial'))
      .sort((a, b) => (AV_RANK[a.avail] - AV_RANK[b.avail]) || ((a.min ? a.min.price : 1e9) - (b.min ? b.min.price : 1e9)) || String(b.lastAt).localeCompare(String(a.lastAt)));
    sum.textContent = `${rows.length} מתוך ${all.length} מלונות. הכי טובים קודם: יש מקום, ואז הכי זול.`;
    box.innerHTML = rows.length ? '' : '<p class="hint">אין מלון שמתאים. נסו מחיר גבוה יותר או אזור אחר.</p>';
    rows.forEach((x, i) => box.append(hotelCard(x, i < 3 && x.avail !== 'full' && x.min && !words.length ? i + 1 : 0)));
  }
  draw();
}

function hotelCard(x, best) {
  const av = AV[x.avail] || AV.unknown, photo = safeUrl(x.photo);
  const el = h(`<article class="sm-h">
    ${photo ? `<img class="sm-h__img" src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="sm-h__img sm-h__img--none" aria-hidden="true"></div>'}
    <div class="sm-h__body">
      <div class="sm-h__top"><h3>${esc(x.name)}</h3>${best ? `<span class="sm-best">בחירה ${best}</span>` : ''}</div>
      <p class="sm-h__where">${esc([x.city, x.area && x.area !== x.city ? x.area : ''].filter(Boolean).join(', '))}${x.rating ? ` · ${esc(x.rating)}★` : ''}</p>
      <div class="sm-h__facts">
        <span class="sm-av sm-av--${av[1]}">${av[0]}</span>
        ${x.min ? `<span class="sm-price"><b>${money(x.min.price, x.min.currency)}</b> ${esc(x.min.per)}${x.min.what ? ` <small>(${esc(x.min.what)})</small>` : ''}</span>` : '<span class="hint">עוד אין מחיר</span>'}
      </div>
      ${x.availText ? `<p class="sm-h__txt">${esc(x.availText)}</p>` : ''}
      <p class="sm-h__meta">${[x.calls ? `${x.calls} שיחות` : '', x.lastAt ? 'קשר אחרון ' + day(x.lastAt) : '', x.surveys.map(s => s.title).filter(Boolean).join(', ')].filter(Boolean).map(esc).join(' · ')}</p>
      <div class="sm-h__acts">
        ${x.phone ? `<a class="btn btn--line" href="tel:${esc(x.phone.replace(/[^\d+]/g, ''))}" dir="ltr">${esc(x.phone)}</a>` : ''}
        ${safeUrl(x.website) ? `<a class="btn btn--line" href="${esc(x.website)}" target="_blank" rel="noopener">האתר</a>` : ''}
        <button type="button" class="btn btn--line" data-open>כל הפרטים</button>
      </div>
    </div>
  </article>`);
  el.querySelector('[data-open]').addEventListener('click', () => ctx.openHotel?.(x.surveys[x.surveys.length - 1]));
  return el;
}

/* ---------------- הרשתות (owner 22.11) ----------------
   The numbers of Instagram / TikTok / YouTube of La Belle Vie and of every artist. YouTube updates by itself
   (when the server has a YouTube key); the others are typed in with "עדכון מספרים" until the accounts are connected. */
import { netsBlock, NET_FIELDS, NUM } from './artists.js';
export async function netsPage(pg, c) {
  ctx = c;
  pg.append(h('<p class="hint">טוען…</p>'));
  let d;
  try { d = await (async () => { const r = await fetch('/api/nets', { cache: 'no-store' }); if (r.status === 401) { ctx.showLogin(); throw new Error('login'); } const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; })(); }
  catch (e) { pg.innerHTML = ''; fail(e); return; }
  pg.innerHTML = '';
  pg.append(h(`<p class="hint sm-note">${d.ytAuto ? 'יוטיוב מתעדכן לבד.' : 'יוטיוב יתעדכן לבד אחרי שנוסיף מפתח של יוטיוב.'} אינסטגרם וטיקטוק מתעדכנים בכפתור "עדכון מספרים", עד שנחבר את החשבונות.</p>`));
  for (const ac of d.accounts || []) {
    const el = netsBlock(ac.handles || {}, ac.stats || {}, 'he', { title: ac.name, onEdit: d.edit ? net => statSheet(ac, net) : null });
    el.style.setProperty('--ac', ac.color || '#16203A');
    pg.append(el);
  }
}
function statSheet(ac, net) {
  document.querySelector('.ev-sheet')?.remove();
  const st = (ac.stats || {})[net] || {};
  const name = { instagram: 'אינסטגרם', tiktok: 'טיקטוק', youtube: 'יוטיוב' }[net];
  const w = h(`<div class="ev-sheet" role="dialog" aria-modal="true" aria-label="עדכון מספרים">
    <form class="ev-sheet__card">
      <div class="ev-sheet__top"><h2>${esc(ac.name)}: ${name}</h2><button class="icon" type="button" data-x aria-label="סגירה">✕</button></div>
      <p class="hint">מעתיקים את המספרים מהפרופיל ${ac.handles?.[net] ? `(<a href="${net === 'instagram' ? 'https://www.instagram.com/' + esc(ac.handles[net]) + '/' : net === 'tiktok' ? 'https://www.tiktok.com/@' + esc(ac.handles[net]) : 'https://www.youtube.com/@' + esc(ac.handles[net])}" target="_blank" rel="noopener">לפתוח את הפרופיל</a>)` : ''}. מספר מלא, בלי K או M.</p>
      <div class="f2">${NET_FIELDS[net].map(f => `<label class="f">${NUM[f][0]}<input name="${f}" inputmode="numeric" dir="ltr" value="${st[f] ?? ''}"></label>`).join('')}</div>
      <div class="ev-sheet__acts"><button class="btn btn--gold" type="submit">לשמור</button></div>
    </form></div>`);
  const close = () => w.remove();
  w.addEventListener('click', e => { if (e.target === w) close(); });
  w.querySelector('[data-x]').addEventListener('click', close);
  w.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const r = await fetch('/api/nets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: ac.key, net, ...f }) });
    if (r.ok) { close(); ctx.toast('נשמר'); ctx.rerender(); } else ctx.toast(r.status === 403 ? 'אין לך הרשאה לעדכן' : 'משהו השתבש. נסו שוב', 'err');
  });
  document.body.append(w);
  w.querySelector('input').focus();
}

/* ---------------- מאגר האטרקציות (owner 24.11) ----------------
   Every attraction / activity for fun days, saved once: what, where, for how many, how much, who to call.
   Search by area or name, filter by kind, max price and group size. Adding and editing from the same page. */
const FK = { show: 'הופעה', workshop: 'סדנה', sport: 'ספורט ואתגר', team: 'גיבוש ומשחקי צוות', food: 'אוכל ושתייה', tour: 'סיור', kids: 'לילדים', party: 'מסיבה וערב', other: 'אחר' };
const FPER = { person: 'לאדם', group: 'לקבוצה', hour: 'לשעה', event: 'לאירוע' };
const FPLACE = { in: 'בפנים', out: 'בחוץ', both: 'בפנים ובחוץ' };
let fun = null, fq = '', fkind = 'all', fmax = '', fsize = '';
async function funApi(method, body, qs = '') {
  const r = await fetch('/api/fun' + qs, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { ctx.toast('פג תוקף הכניסה. היכנסו שוב', 'err'); ctx.showLogin(); throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}
const kindsUsed = all => { const n = {}; all.forEach(x => { n[x.kind] = (n[x.kind] || 0) + 1; }); return Object.keys(FK).filter(k => n[k]).map(k => [k, n[k]]); };

export async function funPage(pg, c) {
  ctx = c;
  pg.append(h('<p class="hint">טוען…</p>'));
  try { fun = await funApi('GET'); } catch (e) { pg.innerHTML = ''; fail(e); return; }
  pg.innerHTML = '';
  const all = fun.list || [];
  const add = h('<div class="sm-add"><button type="button" class="btn btn--gold">להוסיף אטרקציה</button></div>');
  add.querySelector('button').addEventListener('click', () => funSheet(null));
  pg.append(add);
  if (!all.length) { pg.append(h('<section class="card"><h2>עוד אין אטרקציות במאגר</h2><p class="hint">מוסיפים כל אטרקציה פעם אחת: מה זה, איפה, לכמה אנשים, כמה זה עולה ולמי מתקשרים. בפעם הבאה שמתכננים יום כיף, מחפשים כאן לפי אזור, מחיר וגודל הקבוצה.</p></section>')); return; }
  const bar = h(`<form class="sm-bar sm-bar--cat" role="search">
    <input class="input" name="q" type="search" placeholder="אזור, שם או ספק" value="${esc(fq)}" aria-label="חיפוש לפי אזור, שם או ספק">
    <label class="sm-max">עד <input class="input" name="max" type="number" inputmode="numeric" min="0" step="10" value="${esc(fmax)}" placeholder="מחיר" aria-label="מחיר מקסימלי"> ₪</label>
    <label class="sm-max">קבוצה של <input class="input" name="size" type="number" inputmode="numeric" min="0" step="5" value="${esc(fsize)}" placeholder="כמה" aria-label="כמה אנשים"></label>
  </form>`);
  const chips = h(`<div class="sm-chips" role="group" aria-label="סוג אטרקציה">
    <button type="button" data-k="all"${fkind === 'all' ? ' aria-pressed="true"' : ''}>הכול <small>${all.length}</small></button>
    ${kindsUsed(all).map(([k, n]) => `<button type="button" data-k="${k}"${fkind === k ? ' aria-pressed="true"' : ''}>${FK[k]} <small>${n}</small></button>`).join('')}
  </div>`);
  const box = h('<div class="sm-cat"></div>'), sum = h('<p class="hint sm-note"></p>');
  bar.addEventListener('submit', e => e.preventDefault());
  bar.addEventListener('input', () => { fq = bar.q.value; fmax = bar.max.value; fsize = bar.size.value; draw(); });
  chips.querySelectorAll('[data-k]').forEach(b => b.addEventListener('click', () => {
    fkind = b.dataset.k;
    chips.querySelectorAll('[data-k]').forEach(o => (o === b ? o.setAttribute('aria-pressed', 'true') : o.removeAttribute('aria-pressed')));
    draw();
  }));
  pg.append(bar, chips, sum, box);
  function draw() {
    const words = fq.trim().toLowerCase().split(/\s+/).filter(Boolean), max = Number(fmax) || 0, size = Number(fsize) || 0;
    const rows = all.filter(x => (fkind === 'all' || x.kind === fkind)
      && words.every(w => [x.name, x.area, x.supplier, x.notes, FK[x.kind]].join(' ').toLowerCase().includes(w))
      && (!max || (x.price != null && x.price <= max))
      && (!size || ((x.minP == null || x.minP <= size) && (x.maxP == null || x.maxP >= size))))
      .sort((a, b) => ((a.price ?? 1e9) - (b.price ?? 1e9)) || String(a.name).localeCompare(String(b.name), 'he'));
    sum.textContent = `${rows.length} מתוך ${all.length} אטרקציות, הזולות קודם.`;
    box.innerHTML = rows.length ? '' : '<p class="hint">אין אטרקציה שמתאימה. נסו מחיר גבוה יותר, אזור אחר או סוג אחר.</p>';
    rows.forEach(x => box.append(funCard(x)));
  }
  draw();
}

function funCard(x) {
  const site = safeUrl(x.link);
  const size = x.minP && x.maxP ? `${x.minP}-${x.maxP} איש` : x.maxP ? `עד ${x.maxP} איש` : x.minP ? `מ-${x.minP} איש` : '';
  const el = h(`<article class="sm-h sm-fun">
    <div class="sm-h__body">
      <div class="sm-h__top"><h3>${esc(x.name)}</h3><span class="sm-fun__k">${FK[x.kind] || FK.other}</span></div>
      <p class="sm-h__where">${esc([x.area, x.supplier].filter(Boolean).join(', '))}</p>
      <div class="sm-h__facts">
        ${x.price != null ? `<span class="sm-price"><b>${money(x.price, x.currency)}</b> ${FPER[x.per] || ''}</span>` : '<span class="hint">עוד אין מחיר</span>'}
        ${size ? `<span class="sm-fun__f">${esc(size)}</span>` : ''}${x.hours ? `<span class="sm-fun__f">${esc(x.hours)}</span>` : ''}${FPLACE[x.place] ? `<span class="sm-fun__f">${FPLACE[x.place]}</span>` : ''}${x.kids ? '<span class="sm-fun__f">מתאים לילדים</span>' : ''}
      </div>
      ${x.notes ? `<p class="sm-h__txt">${esc(x.notes)}</p>` : ''}
      <div class="sm-h__acts">
        ${x.phone ? `<a class="btn btn--line" href="tel:${esc(x.phone.replace(/[^\d+]/g, ''))}" dir="ltr">${esc(x.phone)}</a>` : ''}
        ${site ? `<a class="btn btn--line" href="${esc(site)}" target="_blank" rel="noopener">האתר</a>` : ''}
        <button type="button" class="btn btn--line" data-edit>לערוך</button>
      </div>
    </div>
  </article>`);
  el.querySelector('[data-edit]').addEventListener('click', () => funSheet(x));
  return el;
}

function funSheet(x) {
  document.querySelector('.ev-sheet')?.remove();
  const v = x || { kind: 'team', per: 'person', currency: 'ILS', place: '' };
  const opt = (o, cur) => Object.entries(o).map(([k, t]) => `<option value="${k}"${cur === k ? ' selected' : ''}>${t}</option>`).join('');
  const w = h(`<div class="ev-sheet" role="dialog" aria-modal="true" aria-label="${x ? 'עריכת אטרקציה' : 'אטרקציה חדשה'}">
    <form class="ev-sheet__card">
      <div class="ev-sheet__top"><h2>${x ? esc(x.name) : 'אטרקציה חדשה'}</h2><button class="icon" type="button" data-x aria-label="סגירה">✕</button></div>
      <label class="f">שם האטרקציה<input name="name" maxlength="100" required value="${esc(v.name || '')}" placeholder="למשל: סדנת שוקולד, ראלי ג׳יפים, מופע קוסמות"></label>
      <div class="f2">
        <label class="f">סוג<select name="kind">${opt(FK, v.kind)}</select></label>
        <label class="f">אזור או עיר<input name="area" maxlength="80" value="${esc(v.area || '')}"></label>
      </div>
      <div class="f2">
        <label class="f">ספק או איש קשר<input name="supplier" maxlength="100" value="${esc(v.supplier || '')}"></label>
        <label class="f">טלפון<input name="phone" maxlength="30" inputmode="tel" dir="ltr" value="${esc(v.phone || '')}"></label>
      </div>
      <div class="f2">
        <label class="f">מחיר<input name="price" inputmode="decimal" dir="ltr" value="${v.price ?? ''}"></label>
        <label class="f">על מה המחיר<select name="per">${opt(FPER, v.per)}</select></label>
      </div>
      <div class="f2">
        <label class="f">מטבע<select name="currency">${opt({ ILS: '₪ שקל', EUR: '€ יורו', USD: '$ דולר' }, v.currency)}</select></label>
        <label class="f">משך<input name="hours" maxlength="40" value="${esc(v.hours || '')}" placeholder="למשל: שעתיים"></label>
      </div>
      <div class="f2">
        <label class="f">מינימום אנשים<input name="minP" inputmode="numeric" dir="ltr" value="${v.minP ?? ''}"></label>
        <label class="f">מקסימום אנשים<input name="maxP" inputmode="numeric" dir="ltr" value="${v.maxP ?? ''}"></label>
      </div>
      <div class="f2">
        <label class="f">איפה<select name="place"><option value="">לא ידוע</option>${opt(FPLACE, v.place)}</select></label>
        <label class="sm-check sm-check--f"><input type="checkbox" name="kids"${v.kids ? ' checked' : ''}> מתאים גם לילדים</label>
      </div>
      <label class="f">קישור לאתר <small>(מתחיל ב-https)</small><input name="link" maxlength="400" dir="ltr" value="${esc(v.link || '')}"></label>
      <label class="f">הערות<textarea name="notes" rows="3" maxlength="1500">${esc(v.notes || '')}</textarea></label>
      <div class="ev-sheet__acts"><button class="btn btn--gold" type="submit">לשמור</button>${x && fun?.del ? '<button class="btn btn--danger" type="button" data-del>למחוק</button>' : ''}</div>
    </form></div>`);
  const close = () => w.remove();
  w.addEventListener('click', e => { if (e.target === w) close(); });
  w.querySelector('[data-x]').addEventListener('click', close);
  w.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.kids = !!e.target.kids.checked;
    if (x) f.id = x.id;
    try { await funApi('POST', f); close(); ctx.toast('נשמר'); ctx.rerender(); } catch (e2) { fail(e2); }
  });
  w.querySelector('[data-del]')?.addEventListener('click', async () => {
    if (!confirm('למחוק את "' + x.name + '" מהמאגר? אי אפשר להחזיר.')) return;
    try { await funApi('DELETE', null, '?id=' + x.id); close(); ctx.toast('נמחק'); ctx.rerender(); } catch (e2) { fail(e2); }
  });
  document.body.append(w);
  w.querySelector('input').focus();
}
