// טופס ללקוח (owner 25.11): we send the client a link (or fill it ourselves during the call). The client sees only the
// questions. When it comes back, the event card is already open, and here we see the places from our own catalog
// that fit (area, budget, what they need) and pick what to put in the card. The server is api/_intake.js.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const safeUrl = u => (/^https:\/\//i.test(String(u || '')) ? u : '');
const photoSrc = u => (String(u || '').startsWith('media/uploads/') ? '/' + u : safeUrl(u));
const money = (n, c) => (c === 'EUR' ? '€' : c === 'USD' ? '$' : '₪') + Number(n).toLocaleString('he-IL');
const dm = d => { const [y, m, dd] = String(d || '').split('-'); return dd ? `${+dd}.${+m}.${y}` : ''; };
const when = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }) + ', ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); };

const KINDS = { wedding: 'חתונה', barmitzvah: 'בר מצווה', batmitzvah: 'בת מצווה', shabbat: 'שבת חתן', brit: 'ברית', corporate: 'אירוע חברה', funday: 'יום כיף', gala: 'ערב גאלה', other: 'משהו אחר' };
const AREAS = ['ירושלים והסביבה', 'תל אביב והמרכז', 'השרון', 'השפלה', 'הצפון', 'הדרום', 'ים המלח', 'אילת', 'פתוחים לרעיונות'];
const NEEDS = { venue: 'מקום לאירוע', hotel: 'מלון ולינה', fun: 'אטרקציות', artist: 'אמן או מוזיקה', all: 'הפקה מלאה' };
// the cities we meet most, by area (to see that "רמת רחל" is in Jerusalem's area)
const NEAR = {
  'ירושלים והסביבה': ['ירושלים', 'jerusalem', 'מבשרת', 'מוצא', 'בית שמש', 'אבו גוש', 'צור הדסה', 'רמת רחל', 'עין כרם', 'גוש עציון', 'מעלה אדומים', 'קרית ענבים', 'נווה אילן', 'צובה', 'עין צורים', 'גבעת זאב'],
  'תל אביב והמרכז': ['תל אביב', 'tel aviv', 'יפו', 'רמת גן', 'גבעתיים', 'בני ברק', 'חולון', 'בת ים', 'פתח תקווה', 'ראשון', 'אור יהודה', 'קרית אונו', 'ראש העין', 'שוהם', 'מודיעין', 'לוד', 'רמלה'],
  'השרון': ['הרצליה', 'רעננה', 'כפר סבא', 'הוד השרון', 'נתניה', 'netanya', 'כפר שמריהו', 'קיסריה', 'חדרה', 'אבן יהודה', 'כפר יונה'],
  'השפלה': ['רחובות', 'נס ציונה', 'יבנה', 'גדרה', 'אשדוד', 'קרית גת', 'גן יבנה', 'מזכרת בתיה', 'בית שמש'],
  'הצפון': ['חיפה', 'haifa', 'טבריה', 'tiberias', 'נצרת', 'עכו', 'נהריה', 'צפת', 'כרמיאל', 'זכרון', 'יקנעם', 'עפולה', 'גליל', 'גולן', 'כנרת', 'ראש פינה'],
  'הדרום': ['באר שבע', 'beer sheva', 'אשקלון', 'נתיבות', 'שדרות', 'אופקים', 'דימונה', 'ערד', 'מצפה רמון', 'נגב'],
  'ים המלח': ['ים המלח', 'dead sea', 'עין בוקק', 'עין גדי', 'נווה זוהר'],
  'אילת': ['אילת', 'eilat'],
};

let ctx = null, data = null, open = null, made = null, filling = null, cats = null, picked = new Map();

async function api(method, qs = '', body, base = '/api/intake') {
  const r = await fetch(base + qs, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { ctx.toast('פג תוקף הכניסה. היכנסו שוב', 'err'); ctx.showLogin(); throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || String(r.status)); e.status = r.status; throw e; }
  return j;
}
const fail = e => { if (e.message !== 'login') ctx.toast(e.message === 'missing' ? 'חסרים שם, תאריך (או בערך מתי) ומספר אורחים' : 'משהו השתבש. נסו שוב', 'err'); };
const again = async () => { try { data = await api('GET'); } catch (e) { fail(e); } ctx.rerender(); };
const fullLink = f => location.origin + f.link;
const waLink = f => {
  const p = String(f.client?.phone || '').replace(/\D/g, ''), to = p.startsWith('0') ? '972' + p.slice(1) : p;
  const fr = f.lang === 'fr';
  const text = fr ? `Bonjour ${f.client?.name || ''},\nPour préparer une proposition faite pour vous, voici quelques questions rapides sur votre événement :\n${fullLink(f)}\nLa Belle Vie`
    : `שלום ${f.client?.name || ''},\nכדי שנכין לכם הצעה שמתאימה בדיוק לכם, הנה כמה שאלות קצרות על האירוע:\n${fullLink(f)}\nLa Belle Vie`;
  return 'https://wa.me/' + (to.length >= 9 ? to : '') + '?text=' + encodeURIComponent(text);
};

export async function intakePage(pg, c) {
  ctx = c;
  if (!data) {
    pg.append(h('<p class="hint">טוען…</p>'));
    try { data = await api('GET'); } catch (e) { pg.innerHTML = ''; if (e.status === 403) pg.append(h('<section class="card"><p>אין לכם הרשאה לכלי הזה.</p></section>')); else fail(e); return; }
    pg.innerHTML = '';
  }
  const f = open && data.forms.find(x => x.id === open);
  if (f && f.answers) { pg.append(formView(f)); return; }
  if (filling) { pg.append(fillCard(filling === true ? null : data.forms.find(x => x.id === filling))); return; }
  pg.append(newCard(), listCard());
}

/** A new form: who it is for → the link to send (WhatsApp / copy), or fill it now during the call. */
function newCard() {
  const el = h(`<section class="card in-new"><div class="card__head"><div><h2>טופס חדש ללקוח</h2>
    <p>שולחים ללקוח קישור, והוא עונה: איזה אירוע, מתי, כמה אורחים, איפה ובאיזה תקציב. הוא לא רואה את המקומות שלנו ולא מחירים. כשהוא שולח, כרטיס האירוע נפתח לבד, ואתם רואים כאן מה מתאים לו מהמאגר.</p></div></div>
    <form class="in-row">
      <label class="f">שם הלקוח<input name="name" maxlength="120" required></label>
      <label class="f">טלפון<input name="phone" maxlength="40" inputmode="tel" dir="ltr"></label>
      <label class="f">שפת הטופס<select name="lang"><option value="he">עברית</option><option value="fr">צרפתית</option></select></label>
    </form>
    <div class="in-btns"><button type="button" class="btn btn--gold" data-make>ליצור קישור ללקוח</button><button type="button" class="btn btn--line" data-fill>למלא עכשיו בעצמי (בזמן שיחה)</button></div>
    ${made ? `<div class="in-made"><p><b>הקישור של ${esc(made.client?.name)} מוכן.</b> שולחים לו אותו בוואטסאפ:</p>
      <input class="input" readonly dir="ltr" value="${esc(fullLink(made))}" aria-label="הקישור">
      <div class="in-btns"><a class="btn btn--gold btn--sm" target="_blank" rel="noopener" href="${esc(waLink(made))}">לשלוח בוואטסאפ</a><button type="button" class="btn btn--line btn--sm" data-copy>להעתיק את הקישור</button></div></div>` : ''}
  </section>`);
  const fm = $('form', el);
  $('[data-make]', el).addEventListener('click', async e => {
    const d = new FormData(fm);
    if (!String(d.get('name') || '').trim()) { ctx.toast('כתבו את שם הלקוח', 'err'); $('[name=name]', fm).focus(); return; }
    e.target.disabled = true;
    try { made = (await api('POST', '', { op: 'new', name: d.get('name'), phone: d.get('phone'), lang: d.get('lang') })).form; await again(); } catch (x) { fail(x); e.target.disabled = false; }
  });
  $('[data-fill]', el).addEventListener('click', () => { const d = new FormData(fm); filling = true; prefill = { name: d.get('name') || '', phone: d.get('phone') || '' }; ctx.rerender(); });
  $('[data-copy]', el)?.addEventListener('click', async () => { try { await navigator.clipboard.writeText(fullLink(made)); ctx.toast('הקישור הועתק'); } catch (e) { $('.in-made input', el).select(); } });
  return el;
}
let prefill = {};

function listCard() {
  const forms = data.forms || [];
  const el = h(`<section class="card"><div class="card__head"><div><h2>הטפסים</h2><p>${forms.length ? 'חדשים למעלה. לוחצים על טופס שמולא כדי לראות מה מתאים ללקוח.' : 'עוד אין טפסים. יוצרים קישור למעלה ושולחים ללקוח.'}</p></div></div><ul class="in-list"></ul></section>`);
  const ul = $('ul', el);
  for (const f of forms) {
    const a = f.answers, fresh = a && !f.seen;
    const li = h(`<li class="in-item ${a ? 'is-done' : ''} ${fresh ? 'is-new' : ''}">
      <div class="in-item__main"><b>${esc(f.client?.name || a?.name || '')}</b>
        <small>${a ? esc([KINDS[a.kind] === 'משהו אחר' ? a.kindText || 'אירוע' : KINDS[a.kind], a.date ? dm(a.date) : a.dateNote, a.guests ? a.guests + ' אורחים' : '', [a.area, a.areaText].filter(Boolean).join(', ')].filter(Boolean).join(' · ')) : 'נשלח ' + esc(when(f.createdAt)) + '. מחכה שהלקוח ימלא'}</small></div>
      ${fresh ? '<span class="in-badge">חדש</span>' : ''}
      <div class="in-item__btns">${a ? '<button type="button" class="btn btn--gold btn--sm" data-open>לראות מה מתאים</button>'
        : `<a class="btn btn--line btn--sm" target="_blank" rel="noopener" href="${esc(waLink(f))}">לשלוח שוב בוואטסאפ</a><button type="button" class="btn btn--line btn--sm" data-fillit>למלא בעצמי</button>`}
        <button type="button" class="in-del" data-del aria-label="למחוק את הטופס">למחוק</button></div></li>`);
    $('[data-open]', li)?.addEventListener('click', async () => { open = f.id; picked = new Map(); if (!f.seen) { f.seen = true; api('POST', '', { op: 'seen', id: f.id }).catch(() => {}); } ctx.rerender(); scrollTo(0, 0); });
    $('[data-fillit]', li)?.addEventListener('click', () => { filling = f.id; prefill = { name: f.client?.name || '', phone: f.client?.phone || '' }; ctx.rerender(); scrollTo(0, 0); });
    $('[data-del]', li).addEventListener('click', async () => {
      if (!confirm('למחוק את הטופס של ' + (f.client?.name || '') + '? כרטיס האירוע שנפתח ממנו נשאר.')) return;
      try { await api('POST', '', { op: 'del', id: f.id }); if (made?.id === f.id) made = null; await again(); } catch (e) { fail(e); }
    });
    ul.append(li);
  }
  return el;
}

/** We fill the form ourselves (during the call). Same questions as the client's. */
function fillCard(f) {
  const v = { ...prefill };
  const chip = (name, val, label, type = 'radio') => `<label class="in-chip"><input type="${type}" name="${name}" value="${esc(val)}"><span>${esc(label)}</span></label>`;
  const el = h(`<section class="card"><div class="card__head"><div><h2>טופס ${esc(v.name || 'ללקוח')}</h2><p>ממלאים בזמן השיחה. כששומרים, כרטיס האירוע נפתח ורואים מה מתאים מהמאגר.</p></div></div>
    <form class="in-fill">
      <div class="in-row"><label class="f">שם הלקוח<input name="name" maxlength="120" value="${esc(v.name || '')}"></label><label class="f">טלפון<input name="phone" maxlength="40" dir="ltr" inputmode="tel" value="${esc(v.phone || '')}"></label><label class="f">מייל <small>(לא חובה)</small><input name="email" maxlength="160" dir="ltr"></label></div>
      <p class="in-q">איזה אירוע?</p><div class="in-chips">${Object.entries(KINDS).map(([k, l]) => chip('kind', k, l)).join('')}</div>
      <label class="f in-more" data-kt hidden>איזה אירוע?<input name="kindText" maxlength="80"></label>
      <div class="in-row"><label class="f">תאריך<input type="date" name="date"></label><label class="f">או בערך מתי<input name="dateNote" maxlength="120" placeholder="למשל: אביב 2027"></label><label class="f">כמה אורחים<input type="number" name="guests" min="1" max="5000" inputmode="numeric"></label></div>
      <p class="in-q">אזור</p><div class="in-chips">${AREAS.map(l => chip('area', l, l)).join('')}</div>
      <label class="f in-more">עיר או מקום מסוים<input name="areaText" maxlength="120"></label>
      <div class="in-row"><label class="f">תקציב משוער (₪)<input type="number" name="budget" min="0" inputmode="numeric"></label><div class="in-chips in-chips--end">${chip('budgetPer', 'total', 'בסך הכול')}${chip('budgetPer', 'guest', 'לאורח')}</div></div>
      <p class="in-q">מה צריך <small>(אפשר כמה)</small></p><div class="in-chips">${Object.entries(NEEDS).map(([k, l]) => chip('needs', k, l, 'checkbox')).join('')}</div>
      <label class="f in-more">הערות<textarea name="notes" maxlength="2000" rows="3"></textarea></label>
      <div class="in-btns"><button type="submit" class="btn btn--gold">לשמור ולפתוח כרטיס אירוע</button><button type="button" class="btn btn--line" data-back>ביטול</button></div>
    </form></section>`);
  const fm = $('form', el);
  $('[name=budgetPer][value=total]', fm).checked = true;
  fm.addEventListener('change', e => { if (e.target.name === 'kind') $('[data-kt]', fm).hidden = e.target.value !== 'other'; });
  $('[data-back]', el).addEventListener('click', () => { filling = null; ctx.rerender(); });
  fm.addEventListener('submit', async e => {
    e.preventDefault();
    const d = new FormData(fm), btn = $('[type=submit]', fm);
    const answers = { name: d.get('name'), phone: d.get('phone'), email: d.get('email'), kind: d.get('kind') || 'other', kindText: d.get('kindText'), date: d.get('date'), dateNote: d.get('dateNote'),
      guests: d.get('guests'), area: d.get('area') || '', areaText: d.get('areaText'), budget: d.get('budget'), budgetPer: d.get('budgetPer') || 'total', needs: d.getAll('needs'), notes: d.get('notes') };
    btn.disabled = true;
    try { const r = await api('POST', '', { op: 'fill', id: f?.id, answers }); filling = null; open = r.form.id; picked = new Map(); await again(); scrollTo(0, 0); ctx.toast('נשמר. כרטיס האירוע נפתח'); } catch (x) { fail(x); btn.disabled = false; }
  });
  return el;
}

/* ---------- a filled form: what the client asked + what fits from our catalog ---------- */
const flat = s => String(s || '').toLowerCase().replace(/["'״׳`]/g, '');
function inArea(a, x) {
  const where = flat([x.city, x.area, x.name].join(' '));
  const own = flat(a.areaText);
  if (own && own.split(/[\s,]+/).filter(w => w.length > 2).some(w => where.includes(w))) return 2;
  const near = NEAR[a.area] || [];
  if (near.some(w => where.includes(flat(w)))) return 1;
  if (a.area && where.includes(flat(a.area.split(' ')[0]))) return 1;
  return 0;
}
/** A place's price against the budget: 'in' / 'near' / 'over' / '' (unknown). */
function fitPrice(a, min) {
  if (!a.budget || !min || !(min.price > 0)) return '';
  const perGuest = /אורח|אדם|איש|לנפש|person|guest|pp/i.test(min.per || '');
  let budget = a.budget, price = min.price;
  if (a.budgetPer === 'total' && perGuest && a.guests) price = min.price * a.guests;
  if (a.budgetPer === 'guest' && !perGuest) budget = a.budget * (a.guests || 1);
  return price <= budget ? 'in' : price <= budget * 1.15 ? 'near' : 'over';
}
function rank(a, rows, kind) {
  return rows.map(x => {
    let score = 0; const why = [];
    const ar = kind === 'fun' ? inArea(a, { city: x.area, name: x.name }) : inArea(a, x);
    if (ar) { score += ar * 3; why.push(ar === 2 ? 'במקום שביקש' : 'באזור'); }
    const min = kind === 'fun' ? (x.price > 0 ? { price: x.price, per: x.per === 'person' ? 'לאדם' : '' } : null) : x.min;
    const fp = fitPrice(a, min);
    if (fp === 'in') { score += 3; why.push('בתקציב'); } else if (fp === 'near') { score += 1; why.push('קצת מעל התקציב'); } else if (fp === 'over') { score -= 2; why.push('מעל התקציב'); }
    if (kind === 'fun' && a.guests) { if ((x.minP && a.guests < x.minP) || (x.maxP && a.guests > x.maxP)) { score -= 3; why.push('לא לגודל הקבוצה'); } else if (x.minP || x.maxP) { score += 1; why.push('מתאים לגודל הקבוצה'); } }
    if ((x.booked || []).length) { score += 1; why.push('כבר עבדנו איתם'); }
    return { x, score, why };
  }).filter(r => r.score > 0 || !a.area || a.area === 'פתוחים לרעיונות').sort((p, q) => q.score - p.score).slice(0, 8);
}
function formView(f) {
  const a = f.answers;
  const kind = a.kind === 'other' ? a.kindText || 'אירוע' : KINDS[a.kind];
  const want = new Set(a.needs.includes('all') ? ['venue', 'hotel', 'fun'] : a.needs);
  if (!want.size) { if (a.kind === 'shabbat') want.add('hotel'); else if (a.kind === 'funday' || a.kind === 'corporate') want.add('fun'); else want.add('venue'); }
  const el = h(`<div class="in-view">
    <button type="button" class="in-back" data-back>חזרה לכל הטפסים</button>
    <section class="card in-sum"><div class="card__head"><div><h2>${esc(kind)} · ${esc(a.name)}</h2><p>${f.filledBy === 'client' ? 'הלקוח מילא ' : 'מולא על ידי ' + esc(f.filledBy) + ' '}${esc(when(f.filledAt))}${f.lang === 'fr' ? ' (בצרפתית)' : ''}</p></div></div>
      <dl class="in-dl">
        <div><dt>מתי</dt><dd>${esc(a.date ? dm(a.date) : a.dateNote)}</dd></div>
        <div><dt>אורחים</dt><dd>${a.guests}</dd></div>
        <div><dt>אזור</dt><dd>${esc([a.area, a.areaText].filter(Boolean).join(', ') || 'לא אמר')}</dd></div>
        <div><dt>תקציב</dt><dd>${a.budget ? esc(a.budget.toLocaleString('he-IL') + ' ₪ ' + (a.budgetPer === 'guest' ? 'לאורח' : 'בסך הכול')) : 'לא אמר'}</dd></div>
        <div><dt>צריך</dt><dd>${esc(a.needs.map(n => NEEDS[n]).join(', ') || 'לא סימן')}</dd></div>
        <div><dt>טלפון</dt><dd dir="ltr">${a.phone ? `<a href="tel:${esc(a.phone)}">${esc(a.phone)}</a>` : ''}</dd></div>
        ${a.email ? `<div><dt>מייל</dt><dd dir="ltr">${esc(a.email)}</dd></div>` : ''}
        ${a.notes ? `<div class="in-dl__wide"><dt>מה עוד חשוב לו</dt><dd>${esc(a.notes)}</dd></div>` : ''}
      </dl>
      <div class="in-btns">${f.surveyId ? '<button type="button" class="btn btn--gold btn--sm" data-card>לפתוח את כרטיס האירוע</button>' : ''}${f.eventId ? '<button type="button" class="btn btn--line btn--sm" data-cal>בלוח האירועים</button>' : ''}</div>
    </section>
    <div class="in-match"><p class="hint">מחפש במאגר מה מתאים…</p></div></div>`);
  $('[data-back]', el).addEventListener('click', () => { open = null; ctx.rerender(); });
  $('[data-card]', el)?.addEventListener('click', () => ctx.openCard(f.surveyId));
  $('[data-cal]', el)?.addEventListener('click', () => ctx.go('events'));
  matchInto($('.in-match', el), f, a, want);
  return el;
}
async function matchInto(box, f, a, want) {
  try {
    if (!cats) {
      const get = (qs, base) => api('GET', qs, null, base).catch(() => null);
      const [v, ho, fn] = await Promise.all([get('?catalog=venues', '/api/hotels'), get('?catalog=1', '/api/hotels'), get('', '/api/fun')]);
      cats = { venue: v?.hotels || [], hotel: ho?.hotels || [], fun: fn?.list || [] };
    }
  } catch (e) { box.innerHTML = ''; fail(e); return; }
  let inCard = [];
  if (f.surveyId) { try { const s = await api('GET', '?survey=' + encodeURIComponent(f.surveyId), null, '/api/hotels'); inCard = s.hotels || []; } catch (e) { inCard = []; } }
  const there = x => (x.surveys || []).some(s => s.surveyId === f.surveyId) || inCard.some(y => (y.phone && x.phone && y.phone.replace(/\D/g, '').slice(-9) === x.phone.replace(/\D/g, '').slice(-9)) || y.name === x.name);
  box.innerHTML = '';
  const NAMES = { venue: ['אולמות וגנים שמתאימים', 'אולם'], hotel: ['מלונות שמתאימים', 'מלון'], fun: ['אטרקציות שמתאימות', 'אטרקציה'] };
  for (const k of ['venue', 'hotel', 'fun']) {
    if (!want.has(k)) continue;
    const rows = rank(a, cats[k], k);
    const sec = h(`<section class="card in-cat"><div class="card__head"><div><h2>${NAMES[k][0]}</h2><p>${rows.length ? (k === 'fun' ? 'מהמאגר של האטרקציות. הכי מתאימים למעלה.' : 'מהמאגר שלך. מסמנים ומוסיפים לכרטיס האירוע, ואז מתקשרים לבדוק זמינות לתאריך.') : 'לא מצאתי במאגר ' + NAMES[k][1] + ' שמתאים לאזור ולתקציב.'}</p></div></div><div class="in-rows"></div></section>`);
    const list = $('.in-rows', sec);
    for (const { x, why } of rows) {
      const ph = photoSrc(x.photo || (x.photos || [])[0]);
      const price = k === 'fun' ? (x.price > 0 ? money(x.price, x.currency) + ({ person: ' לאדם', group: ' לקבוצה', hour: ' לשעה', event: ' לאירוע' }[x.per] || '') : '') : (x.min ? 'מ-' + money(x.min.price, x.min.currency) + (x.min.per ? ' ' + x.min.per : '') : '');
      const isThere = k !== 'fun' && there(x);
      const row = h(`<label class="in-place ${k === 'fun' ? 'is-info' : ''}">${k === 'fun' ? '' : `<input type="checkbox" ${isThere ? 'checked disabled' : picked.has(x.key) ? 'checked' : ''}>`}
        ${ph ? `<img src="${esc(ph)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<i class="in-ph"></i>'}
        <span class="in-place__t"><b>${esc(x.name)}</b><small>${esc([x.city || x.area, price].filter(Boolean).join(' · '))}</small>
          <span class="in-why">${why.map(w => `<em class="${/מעל|לא ל/.test(w) ? 'is-bad' : ''}">${esc(w)}</em>`).join('')}${isThere ? '<em>כבר בכרטיס</em>' : ''}</span>
          ${x.about ? `<small class="in-about">${esc(x.about)}</small>` : ''}${k === 'fun' && x.phone ? `<small dir="ltr">${esc(x.phone)}</small>` : ''}</span></label>`);
      $('img', row)?.addEventListener('error', e => e.target.replaceWith(h('<i class="in-ph"></i>')));
      $('input', row)?.addEventListener('change', e => { if (e.target.checked) picked.set(x.key, x); else picked.delete(x.key); sync(); });
      list.append(row);
    }
    box.append(sec);
  }
  const bar = h('<div class="in-addbar" hidden><button type="button" class="btn btn--gold" data-add></button></div>');
  const sync = () => { bar.hidden = !picked.size; $('[data-add]', bar).textContent = picked.size === 1 ? 'להוסיף מקום אחד לכרטיס האירוע' : 'להוסיף ' + picked.size + ' מקומות לכרטיס האירוע'; };
  $('[data-add]', bar).addEventListener('click', async e => {
    e.target.disabled = true; let n = 0;
    for (const x of picked.values()) {
      const src = x.surveys[x.surveys.length - 1];
      try { const r = await api('POST', '', { op: 'copy', surveyId: f.surveyId, fromSurvey: src.surveyId, id: src.hotelId }, '/api/hotels'); if (!r.already) n++; } catch (x2) { fail(x2); }
    }
    picked = new Map(); cats = null; e.target.disabled = false;
    ctx.toast(n === 1 ? 'מקום אחד נוסף לכרטיס האירוע' : n + ' מקומות נוספו לכרטיס האירוע'); ctx.rerender();
  });
  box.append(bar); sync();
}
