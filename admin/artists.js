// Owner 22.11: the artists we represent. One page per artist, in his own color:
// his networks, his events (calendar events with event.artist = his id), the people who call about him, and the calls from their numbers.
// Data: /api/artists (api/_artists.js). The same drawing is used by the artist's own link (/artist/), read-only and without recordings.
import { KIND, STATUS, holiday, openEvent } from './events.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const WD = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const when = s => { const d = new Date(s); return isNaN(d) ? '' : `${d.getDate()}.${d.getMonth() + 1} · ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;

export const NETS = {
  instagram: { t: 'אינסטגרם', url: x => `https://www.instagram.com/${x}/`, ic: 'M7 3h10a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM17.5 6.5v.01' },
  tiktok: { t: 'טיקטוק', url: x => `https://www.tiktok.com/@${x}`, ic: 'M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5M14 3c.5 2.6 2.4 4.4 5 4.6' },
  youtube: { t: 'יוטיוב', url: x => `https://www.youtube.com/@${x}`, ic: 'M3 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM10 9.5v5l4.5-2.5z' },
  facebook: { t: 'פייסבוק', url: x => `https://www.facebook.com/${x}`, ic: 'M14 8h3V4h-3a4 4 0 0 0-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8z' },
  spotify: { t: 'ספוטיפיי', url: x => `https://open.spotify.com/artist/${x}`, ic: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM7.5 9.5c3-1 6.5-.7 9 .8M8 12.5c2.5-.7 5.3-.4 7.4.8M8.6 15.4c2-.5 4-.3 5.6.6' },
};

/** Clearly marked example content, only on screen (nothing is saved): to show the page before real events are in. */
function sample(a, fr) {
  const d = n => { const x = new Date(); x.setDate(x.getDate() + n); return iso(x); };
  const ev = (n, title, kind, place, client, status, time) => ({ id: 'sample' + n, sample: true, artist: a.id, title, kind, place, client, status, date: d(n), time, guests: '' });
  return {
    events: fr ? [ev(4, 'Mariage en salle', 'wedding', 'Jérusalem', 'Client (exemple)', 'confirmed', '21:30'), ev(11, 'Bar-mitsva', 'barmitzvah', 'Tel-Aviv', 'Client (exemple)', 'option', '20:00'),
      ev(19, 'Concert pour une soirée de gala', 'show', 'Hôtel à la mer Morte', 'Client (exemple)', 'option', '22:00')] : [ev(4, 'חתונה באולם', 'wedding', 'ירושלים', 'לקוח לדוגמה', 'confirmed', '21:30'), ev(11, 'בר מצווה', 'barmitzvah', 'תל אביב', 'לקוח לדוגמה', 'option', '20:00'),
      ev(19, 'הופעה בערב גאלה', 'show', 'מלון בים המלח', 'לקוח לדוגמה', 'option', '22:00')],
    calls: fr ? [{ id: 's1', sample: true, at: new Date(Date.now() - 2 * 36e5).toISOString(), who: { name: 'Client (exemple)', role: 'Demande une date libre' }, summary: 'Exemple\u00a0: demande un devis pour chanter à un mariage, environ 300 invités.' },
      { id: 's2', sample: true, at: new Date(Date.now() - 26 * 36e5).toISOString(), who: { name: 'Producteur (exemple)', role: 'Producteur' }, summary: '' }] : [{ id: 's1', sample: true, at: new Date(Date.now() - 2 * 36e5).toISOString(), who: { name: 'לקוח לדוגמה', role: 'שאל על תאריך פנוי' }, summary: 'דוגמה: מבקש הצעת מחיר להופעה בחתונה, כ-300 אורחים.' },
      { id: 's2', sample: true, at: new Date(Date.now() - 26 * 36e5).toISOString(), who: { name: 'מפיק לדוגמה', role: 'מפיק' }, summary: '' }],
  };
}

let month = null, picked = null;

/* ---------- owner 22.11: the artist page in French too (the artist's own link and the admin) ---------- */
const FR = {
  months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  wd: ['D', 'L', 'M', 'M', 'J', 'V', 'S'],
  kind: { wedding: 'Mariage', barmitzvah: 'Bar-mitsva', batmitzvah: 'Bat-mitsva', shabbat: 'Chabbat \u2019hatan', gala: 'Soirée de gala', holiday: 'Séjour', show: 'Concert', other: 'Autre' },
  status: { option: 'Option', confirmed: 'Confirmé', done: 'Réalisé', cancelled: 'Annulé' },
  nets: { instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook', spotify: 'Spotify' },
  title: { 'זמר': 'Chanteur', 'זמרת': 'Chanteuse' },
};
const TXT = {
  he: { up: 'אירועים קרובים', clients: 'לקוחות', calls: 'שיחות עליו', newEv: '+ אירוע שלו', link: 'הקישור שלו', edit: 'פרטים', tag: 'לדוגמה',
    demo: 'מוצגת דוגמה: האירועים והשיחות המסומנים "לדוגמה" לא שמורים, רק כדי להראות איך הדף נראה.', hide: 'להסתיר את הדוגמה', none: 'עוד אין אירועים שלו בלוח.', show: 'להראות דוגמה',
    today: 'היום', prev: 'החודש הקודם', next: 'החודש הבא', picked: 'ביום שבחרת', upT: 'האירועים הקרובים', from: 'מהיום והלאה', noUp: 'אין אירועים קרובים', events: 'אירועים',
    cliT: 'הלקוחות', cliS: 'מי הזמין אותו, ולאיזה אירוע', cliE: 'הלקוחות יופיעו כאן כשיתווספו אירועים', call: 'התקשרות',
    callT: 'שיחות עליו', callS: 'מהמספרים של הלקוחות ושל האנשים שלו, מהטלפון של LBV', callE: 'כשמישהו מהמספרים שלו יתקשר, השיחה תופיע כאן לבד', callMine: 'השיחות שקשורות אליך יופיעו כאן', rec: 'הקלטה',
    in: (d, m) => `${d} ב${m}` },
  fr: { up: 'Événements à venir', clients: 'Clients', calls: 'Appels', newEv: '+ Événement', link: 'Son lien', edit: 'Fiche', tag: 'exemple',
    demo: 'Aperçu\u00a0: les événements et les appels marqués «\u00a0exemple\u00a0» ne sont pas enregistrés, ils montrent simplement à quoi ressemble la page.', hide: 'Masquer l\u2019exemple', none: 'Aucun événement dans l\u2019agenda pour le moment.', show: 'Voir un exemple',
    today: 'Aujourd\u2019hui', prev: 'Mois précédent', next: 'Mois suivant', picked: 'Le jour choisi', upT: 'Prochains événements', from: 'À partir d\u2019aujourd\u2019hui', noUp: 'Aucun événement à venir', events: 'événements',
    cliT: 'Clients', cliS: 'Qui l\u2019a engagé, et pour quel événement', cliE: 'Les clients apparaîtront ici dès qu\u2019un événement sera ajouté', call: 'Appeler',
    callT: 'Appels', callS: 'Depuis les numéros des clients et de son équipe, sur le téléphone de LBV', callE: 'Dès qu\u2019un de ses numéros appelle, l\u2019appel apparaît ici automatiquement', callMine: 'Les appels qui vous concernent apparaîtront ici', rec: 'Enregistrement',
    in: (d, m) => `${d} ${m}` },
};

/** The page of one artist. opts: { admin, can, sample, onNew(date), onOpen(id), onEdit(), onLink(), onSample() } */
export function drawArtist(root, a, opts = {}) {
  root.innerHTML = '';
  root.style.setProperty('--ac', a.color || '#7a2e4d');
  const fr = opts.lang === 'fr', T = TXT[fr ? 'fr' : 'he'];
  root.setAttribute('dir', fr ? 'ltr' : 'rtl'); root.setAttribute('lang', fr ? 'fr' : 'he');
  const MO = fr ? FR.months : MONTHS, KI = fr ? FR.kind : KIND, ST = fr ? FR.status : STATUS;
  const name = fr && a.nameFr ? a.nameFr : a.name, title = fr ? FR.title[a.title] || a.title : a.title;
  const demo = opts.sample ? sample(a, fr) : null;
  const events = demo ? [...(a.events || []), ...demo.events] : a.events || [];
  const calls = demo ? [...(a.calls || []), ...demo.calls] : a.calls || [];
  const up = events.filter(e => (e.end || e.date) >= today() && e.status !== 'cancelled');
  const clients = [];
  for (const e of events) if (e.client && !clients.some(c => c.name === e.client && c.ev === e.title)) clients.push({ name: e.client, phone: e.phone || '', ev: e.title, date: e.date, sample: e.sample });
  const nets = Object.entries(a.nets || {}).filter(([k, v]) => NETS[k] && v);
  const initials = (name || '').split(/\s+/).map(w => w[0]).join('').slice(0, 2);

  root.append(h(`<header class="ar-hero">
    <div class="ar-hero__mono" aria-hidden="true">${esc(initials)}</div>
    <div class="ar-hero__txt">
      <h1>${esc(name)}</h1>
      ${title ? `<p>${esc(title)}</p>` : ''}
      ${nets.length ? `<div class="ar-nets">${nets.map(([k, v]) => `<a class="ar-net" href="${esc(NETS[k].url(v))}" target="_blank" rel="noopener">${svg(NETS[k].ic)}<span>${fr ? FR.nets[k] : NETS[k].t}</span><bdi dir="ltr">@${esc(v)}</bdi></a>`).join('')}</div>` : ''}
    </div>
    ${opts.admin ? `<div class="ar-hero__acts">
      ${opts.can?.edit ? '<button class="btn btn--gold btn--sm" type="button" data-new>${T.newEv}</button>' : ''}
      ${opts.can?.edit ? '<button class="btn btn--ghost btn--sm" type="button" data-link>${T.link}</button>' : ''}
      ${opts.can?.edit ? '<button class="btn btn--ghost btn--sm" type="button" data-edit>${T.edit}</button>' : ''}
    </div>` : ''}
  </header>`));

  root.append(h(`<div class="ar-stats">
    <div><b>${up.length}</b><span>${T.up}</span></div>
    <div><b>${clients.length}</b><span>${T.clients}</span></div>
    <div><b>${calls.length}</b><span>${T.calls}</span></div>
  </div>`));
  if (demo) root.append(h(`<p class="ar-demo">${svg('M12 8v5M12 16v.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z')}${T.demo}${opts.onSample ? ` <button type="button" class="ar-demo__off" data-sample>${T.hide}</button>` : ''}</p>`));
  else if (opts.onSample && !events.length) root.append(h(`<p class="ar-demo ar-demo--soft">${T.none} <button type="button" class="ar-demo__off" data-sample>${T.show}</button></p>`));

  // his month
  month = month || today().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1), days = new Date(y, m, 0).getDate();
  const on = d => events.filter(e => e.date === d || (e.end && e.date <= d && e.end >= d));
  const cells = [];
  for (let i = 0; i < first.getDay(); i++) cells.push('<span class="cal__d cal__d--pad"></span>');
  for (let d = 1; d <= days; d++) {
    const s = `${month}-${pad(d)}`, list = on(s), wd = new Date(y, m - 1, d).getDay(), hol = fr ? '' : holiday(s);
    cells.push(`<button type="button" class="cal__d${s === today() ? ' is-today' : ''}${s === picked ? ' is-picked' : ''}${wd >= 5 ? ' is-weekend' : ''}${list.length ? ' ar-has' : ''}" data-day="${s}" aria-label="${T.in(d, MO[m - 1])}${hol ? ', ' + hol : ''}${list.length ? ', ' + list.length + ' ' + T.events : ''}">
      <span class="cal__n">${d}</span>${hol ? `<span class="cal__hol">${esc(hol.split(',')[0])}</span>` : ''}
      <span class="cal__evs">${list.slice(0, 2).map(e => `<i class="ev--${e.status}" style="--c:var(--ac)"><em>${esc(e.title)}</em></i>`).join('')}</span></button>`);
  }
  const cal = h(`<section class="card cal ar-cal">
    <div class="cal__head"><div class="cal__title"><h2>${fr ? MO[m - 1][0].toUpperCase() + MO[m - 1].slice(1) : MO[m - 1]} <span>${y}</span></h2></div>
      <div class="cal__nav"><button class="icon" type="button" data-mv="-1" aria-label="${T.prev}">${fr ? '‹' : '›'}</button>
        <button class="btn btn--line btn--sm" type="button" data-today>${T.today}</button>
        <button class="icon" type="button" data-mv="1" aria-label="${T.next}">${fr ? '›' : '‹'}</button></div></div>
    <div class="cal__wd">${(fr ? FR.wd : WD).map(w => `<span>${w}</span>`).join('')}</div>
    <div class="cal__grid">${cells.join('')}</div></section>`);
  const redraw = () => drawArtist(root, a, opts);
  $$('[data-mv]', cal).forEach(b => b.addEventListener('click', () => { month = iso(new Date(y, m - 1 + Number(b.dataset.mv), 1)).slice(0, 7); redraw(); }));
  $('[data-today]', cal).addEventListener('click', () => { month = today().slice(0, 7); picked = today(); redraw(); });
  $$('[data-day]', cal).forEach(b => b.addEventListener('click', () => {
    picked = b.dataset.day;
    const list = on(picked);
    if (list.length === 1 && !list[0].sample && opts.onOpen) return opts.onOpen(list[0].id);
    if (!list.length && opts.can?.edit && opts.onNew) return opts.onNew(picked);
    redraw(); $('.ar-up', root)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));

  const row = e => `<button type="button" class="ev-row ev--${e.status}${e.sample ? ' is-sample' : ''}" style="--c:var(--ac)" ${e.sample ? 'disabled' : `data-ev="${esc(e.id)}"`}>
    <span class="ev-row__date"><b>${+e.date.slice(8)}</b><small>${MO[+e.date.slice(5, 7) - 1].slice(0, fr ? 4 : 3)}</small></span>
    <span class="ev-row__main"><b>${esc(e.title)}${e.sample ? ` <em class="ar-tag">${T.tag}</em>` : ''}</b><small>${esc(KI[e.kind] || '')}${e.time ? ' · ' + esc(e.time) : ''}${e.place ? ' · ' + esc(e.place) : ''}${e.client ? ' · ' + esc(e.client) : ''}</small></span>
    <span class="ev-pill ev-pill--${e.status}">${ST[e.status]}</span></button>`;
  const dayList = picked ? on(picked) : [];
  const upCard = h(`<section class="card ar-up"><div class="card__head"><div><h2>${dayList.length ? T.picked : T.upT}</h2><p>${dayList.length ? T.in(+picked.slice(8), MO[+picked.slice(5, 7) - 1]) : up.length ? T.from : T.noUp}</p></div></div>
    <div class="ev-list">${(dayList.length ? dayList : up.slice(0, 8)).map(row).join('')}</div></section>`);

  const cliCard = h(`<section class="card"><div class="card__head"><div><h2>${T.cliT}</h2><p>${clients.length ? T.cliS : T.cliE}</p></div></div>
    <ul class="ar-list">${clients.map(c => `<li><span class="ar-av" aria-hidden="true">${esc(c.name[0] || '')}</span><span class="ar-list__main"><b>${esc(c.name)}${c.sample ? ` <em class="ar-tag">${T.tag}</em>` : ''}</b><small>${esc(c.ev)} · ${c.date.split('-').reverse().join('.')}</small></span>${opts.admin && c.phone ? `<a class="btn btn--line btn--sm" href="tel:${esc(c.phone)}">${T.call}</a>` : ''}</li>`).join('')}</ul></section>`);

  const callCard = h(`<section class="card"><div class="card__head"><div><h2>${T.callT}</h2><p>${calls.length ? T.callS : opts.admin ? T.callE : T.callMine}</p></div></div>
    <ul class="ar-list">${calls.map(c => `<li class="ar-call"><span class="ar-av ar-av--call" aria-hidden="true">${svg('M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2')}</span>
      <span class="ar-list__main"><b>${esc(c.who?.name || c.phone || '')}${c.sample ? ` <em class="ar-tag">${T.tag}</em>` : ''}</b><small>${esc(c.who?.role || '')} · ${when(c.at)}</small>${c.summary ? `<p>${esc(c.summary)}</p>` : ''}</span>
      ${opts.admin && c.url ? `<a class="btn btn--line btn--sm" href="${esc(c.url)}" target="_blank" rel="noopener">${T.rec}</a>` : ''}</li>`).join('')}</ul></section>`);

  const grid = h('<div class="ar-grid"></div>');
  const side = h('<div class="ar-side"></div>');
  grid.append(cal, side);
  side.append(upCard);
  root.append(grid);
  const two = h('<div class="ar-two"></div>');
  two.append(cliCard, callCard);
  root.append(two);

  $$('[data-ev]', root).forEach(b => b.addEventListener('click', () => opts.onOpen?.(b.dataset.ev)));
  $('[data-new]', root)?.addEventListener('click', () => opts.onNew?.(picked || today()));
  $('[data-edit]', root)?.addEventListener('click', () => opts.onEdit?.());
  $('[data-link]', root)?.addEventListener('click', () => opts.onLink?.());
  $('[data-sample]', root)?.addEventListener('click', () => opts.onSample?.());
}

/* ================= in the admin / app ================= */
let ctx = null, data = null, cur = null, showSample = false, lang = 'he';
async function api(method, qs = '', body) {
  const r = await fetch('/api/artists' + qs, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { ctx.toast('פג תוקף הכניסה. היכנסו שוב', 'err'); ctx.showLogin(); throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}
const fail = e => { if (e.message !== 'login') ctx.toast(e.message === 'forbidden' ? 'אין לך הרשאה לפעולה הזאת' : 'משהו השתבש. נסו שוב', 'err'); };

export async function artistsPage(pg, c) {
  ctx = c;
  pg.append(h('<p class="hint">טוען…</p>'));
  try { data = await api('GET'); } catch (e) { pg.innerHTML = ''; fail(e); return; }
  pg.innerHTML = '';
  const list = data.artists || [];
  if (!cur || !list.some(a => a.id === cur)) cur = list[0]?.id || null;
  if (list.length > 1 || data.can?.edit) {
    const bar = h(`<nav class="ar-pick" aria-label="האמנים">${list.map(a => `<button type="button" data-a="${esc(a.id)}" style="--ac:${esc(a.color)}"${a.id === cur ? ' aria-current="true"' : ''}><i></i>${esc(a.name)}</button>`).join('')}
      ${data.can?.edit ? '<button type="button" class="ar-pick__new" data-add>+ אמן חדש</button>' : ''}
      <span class="ar-lang" role="group" aria-label="שפת הדף"><button type="button" data-lang="he"${lang === 'he' ? ' aria-pressed="true"' : ''}>עברית</button><button type="button" data-lang="fr" lang="fr"${lang === 'fr' ? ' aria-pressed="true"' : ''}>Français</button></span></nav>`);
    $$('[data-lang]', bar).forEach(b => b.addEventListener('click', () => { lang = b.dataset.lang; ctx.rerender(); }));
    $$('[data-a]', bar).forEach(b => b.addEventListener('click', () => { cur = b.dataset.a; showSample = false; ctx.rerender(); }));
    $('[data-add]', bar)?.addEventListener('click', () => editSheet(null));
    pg.append(bar);
  }
  const a = list.find(x => x.id === cur);
  if (!a) { pg.append(h('<section class="card"><h2>עוד אין אמנים</h2><p class="hint">מוסיפים אמן שאנחנו מייצגים, ומקבלים לו דף משלו: לוח שנה בצבע שלו, הלקוחות, הרשתות והשיחות.</p></section>')); return; }
  const root = h('<div class="ar"></div>');
  pg.append(root);
  const after = { ...ctx, rerender: () => ctx.rerender() };
  drawArtist(root, a, {
    admin: true, can: data.can, sample: showSample, lang,
    onSample: () => { showSample = !showSample; ctx.rerender(); },
    onNew: date => openEvent(after, null, date, a.id),
    onOpen: id => openEvent(after, id),
    onEdit: () => editSheet(a),
    onLink: async () => {
      const u = location.origin + a.link.replace('/artist/#', lang === 'fr' ? '/artist/?lang=fr#' : '/artist/#');
      try { await navigator.clipboard.writeText(u); ctx.toast('הקישור הועתק. הוא רואה רק את הדף שלו, בלי ההקלטות'); }
      catch (e) { prompt('הקישור שלו:', u); }
    },
  });
}

/** Details of an artist: name, color, networks, the people who call about him. */
function editSheet(a) {
  $('.ev-sheet')?.remove();
  const x = a || { name: '', title: '', color: '#7a2e4d', nets: {}, contacts: [], notes: '' };
  const w = h(`<div class="ev-sheet" role="dialog" aria-modal="true" aria-label="${a ? 'פרטי האמן' : 'אמן חדש'}">
    <form class="ev-sheet__card">
      <div class="ev-sheet__top"><h2>${a ? esc(a.name) : 'אמן חדש'}</h2><button class="icon" type="button" data-x aria-label="סגירה">✕</button></div>
      <div class="f2"><label class="f">שם<input name="name" required maxlength="80" value="${esc(x.name)}"></label>
        <label class="f">מה הוא <small>(למשל: זמר)</small><input name="title" maxlength="80" value="${esc(x.title)}"></label></div>
      <label class="f">השם באותיות לועזיות <small>(לדף בצרפתית)</small><input name="nameFr" dir="ltr" maxlength="80" value="${esc(x.nameFr || '')}" placeholder="Aaron Meir"></label>
      <label class="f">הצבע שלו בלוח<input name="color" type="color" value="${esc(x.color)}"></label>
      <fieldset class="ar-fs"><legend>הרשתות שלו <small>(רק שם המשתמש)</small></legend>
        ${Object.entries(NETS).map(([k, n]) => `<label class="f">${n.t}<input name="net_${k}" dir="ltr" maxlength="80" value="${esc((x.nets || {})[k] || '')}" placeholder="${k === 'spotify' ? 'מזהה האמן' : 'username'}"></label>`).join('')}
      </fieldset>
      <label class="f">מי מתקשר עליו <small>(שורה לכל אחד: שם, טלפון, תפקיד. כשאחד מהם מתקשר לטלפון של LBV, השיחה נכנסת לדף שלו)</small>
        <textarea name="contacts" rows="4" dir="auto" placeholder="שם, 050-0000000, מפיק">${esc((x.contacts || []).map(c => [c.name, c.phone, c.role].filter(Boolean).join(', ')).join('\n'))}</textarea></label>
      <label class="f">הערות פנימיות<textarea name="notes" rows="3" maxlength="3000">${esc(x.notes)}</textarea></label>
      <div class="ev-sheet__acts"><button class="btn btn--gold" type="submit">${a ? 'שמירה' : 'הוספה'}</button>
        ${a && data.can?.del ? '<button class="btn btn--danger" type="button" data-del>הסרת האמן</button>' : ''}</div>
    </form></div>`);
  const close = () => w.remove();
  w.addEventListener('click', e => { if (e.target === w) close(); });
  $('[data-x]', w).addEventListener('click', close);
  $('form', w).addEventListener('submit', async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const nets = {};
    for (const k of Object.keys(NETS)) nets[k] = f['net_' + k] || '';
    const contacts = String(f.contacts || '').split('\n').map(l => l.split(/[,|]/).map(s => s.trim())).filter(p => p.join('')).map(([name, phone, ...role]) => ({ name, phone, role: role.join(', ') }));
    try {
      const j = await api('POST', '', { op: 'artist', id: a?.id, name: f.name, nameFr: f.nameFr, title: f.title, color: f.color, nets, contacts, notes: f.notes });
      cur = j.artist.id; close(); ctx.toast(a ? 'נשמר' : 'האמן נוסף'); ctx.rerender();
    } catch (e2) { fail(e2); }
  });
  $('[data-del]', w)?.addEventListener('click', async () => {
    if (!confirm(`להסיר את ${a.name}? האירועים שלו נשארים בלוח.`)) return;
    try { await api('DELETE', '?id=' + encodeURIComponent(a.id)); cur = null; close(); ctx.toast('הוסר'); ctx.rerender(); } catch (e2) { fail(e2); }
  });
  document.body.append(w);
  $('[name=name]', w).focus();
}
