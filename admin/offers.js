// הצעת מחיר מהמאגר (owner 25.11): pick the venue, the hotel, attractions and an artist from our own catalogs, see what each
// costs us, add our fee and round. Every price can be changed by hand before sending. The client gets an ordinary
// quote (the quotes page: link, PDF, online approval) with the final prices only; costs and fees stay here.
// Server: api/_intake.js (?offers / op:"offer"), the quote itself: api/quotes.js.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const nis = v => Math.round(Number(v) || 0).toLocaleString('he-IL') + ' ₪';
const when = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }); };
const SRC = { venue: 'מקום', hotel: 'מלון', fun: 'אטרקציה', artist: 'אמן', free: 'שורה' };
const GROUP = { he: { venue: 'המקום', hotel: 'לינה', fun: 'אטרקציות', artist: 'אמנים ומוזיקה', free: 'שירותים נוספים' }, fr: { venue: 'Le lieu', hotel: 'Hébergement', fun: 'Animations', artist: 'Artistes et musique', free: 'Prestations complémentaires' } };
const PER_GUEST = /אורח|אדם|איש|לנפש|person|guest|pp|par pers/i;

let ctx = null, list = null, cur = null, dirty = false, pick = null, cats = {};

async function api(method, qs = '', body, base = '/api/intake') {
  const r = await fetch(base + qs, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { ctx.toast('פג תוקף הכניסה. היכנסו שוב', 'err'); ctx.showLogin(); throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || String(r.status)); e.status = r.status; throw e; }
  return j;
}
const fail = e => { if (e.message !== 'login') ctx.toast(e.status === 403 ? 'אין לכם הרשאה לזה' : 'משהו השתבש. נסו שוב', 'err'); };

/** The price the client sees for one unit: our cost + the fee, rounded up. Unless it was set by hand. */
export function finalOf(o, r) {
  if (r.manual) return Number(r.final) || 0;
  const fee = r.fee === null || r.fee === undefined || r.fee === '' ? Number(o.fee) || 0 : Number(r.fee) || 0;
  const raw = (Number(r.cost) || 0) * (1 + fee / 100), step = Number(o.round) || 0;
  return step > 1 ? Math.ceil(raw / step) * step : Math.round(raw);
}
const qtyOf = (o, r) => (r.per === 'guest' ? Number(o.event.guests) || 1 : Number(r.qty) || 1);
export function sums(o) {
  let cost = 0, client = 0;
  for (const r of o.rows) { const q = qtyOf(o, r); cost += q * (Number(r.cost) || 0); client += q * finalOf(o, r); }
  return { cost, client, profit: client - cost, pct: cost ? Math.round((client - cost) / cost * 100) : 0 };
}
/** What the client's quote gets: grouped lines, final prices only. */
export function clientItems(o) {
  const fr = o.lang === 'fr', out = [];
  for (const g of ['venue', 'hotel', 'fun', 'artist', 'free']) {
    const rows = o.rows.filter(r => r.src === g);
    if (!rows.length) continue;
    if (o.rows.some(r => r.src !== g)) out.push({ name: '# ' + GROUP[fr ? 'fr' : 'he'][g], qty: 1, price: 0, unit: '' });
    for (const r of rows) out.push({ name: r.name, qty: qtyOf(o, r), price: finalOf(o, r), unit: r.per === 'guest' ? (fr ? 'par invité' : 'לאורח') : '' });
  }
  return out;
}

export async function offersPage(pg, c) {
  ctx = c;
  if (c.start) { cur = blank(c.start); dirty = true; c.start = null; }
  if (cur) { pg.append(...builder()); return; }
  if (!list) {
    pg.append(h('<p class="hint">טוען…</p>'));
    try { list = (await api('GET', '?offers=1')).offers; } catch (e) { pg.innerHTML = ''; if (e.status === 403) pg.append(h('<section class="card"><p>אין לכם הרשאה לכלי הזה.</p></section>')); else fail(e); return; }
    pg.innerHTML = '';
  }
  pg.append(listCard());
}
export const resetOffers = () => { list = null; };

function blank(f) {
  const a = f?.answers || {};
  const KIND = { wedding: 'חתונה', barmitzvah: 'בר מצווה', batmitzvah: 'בת מצווה', shabbat: 'שבת חתן', brit: 'ברית', corporate: 'אירוע חברה', funday: 'יום כיף', gala: 'ערב גאלה' };
  const KIND_FR = { wedding: 'Mariage', barmitzvah: 'Bar-mitsva', batmitzvah: 'Bat-mitsva', shabbat: 'Chabbat Hatan', brit: 'Brit-mila', corporate: 'Événement d’entreprise', funday: 'Journée de détente', gala: 'Soirée de gala' };
  const fr = f?.lang === 'fr';
  return { intakeId: f?.id || '', lang: fr ? 'fr' : 'he', fee: 15, round: 10, rows: [],
    client: { name: a.name || f?.client?.name || '', phone: a.phone || f?.client?.phone || '', email: a.email || '' },
    event: { type: (fr ? KIND_FR : KIND)[a.kind] || a.kindText || '', date: a.date ? a.date.split('-').reverse().join('.') : a.dateNote || '', guests: a.guests || '', place: [a.area, a.areaText].filter(Boolean).join(', ') } };
}

function listCard() {
  const el = h(`<section class="card"><div class="card__head"><div><h2>הצעות מחיר מהמאגר</h2>
    <p>בוחרים מקום, מלון, אטרקציות ואמן מהמאגרים שלך. רואים כמה זה עולה לנו, מוסיפים עמלה ומעגלים, וכל מחיר אפשר לשנות ביד. הלקוח מקבל הצעה רגילה עם המחירים הסופיים בלבד, ומאשר אותה בקישור.</p></div>
    <button type="button" class="btn btn--gold" data-new>+ הצעה חדשה</button></div><ul class="in-list"></ul></section>`);
  $('[data-new]', el).addEventListener('click', () => { cur = blank(null); dirty = false; ctx.rerender(); });
  const ul = $('ul', el);
  if (!list.length) ul.append(h('<li class="hint">עוד אין הצעות. לוחצים "הצעה חדשה", או "לבנות הצעת מחיר" בטופס שלקוח מילא.</li>'));
  for (const o of list) {
    const s = sums(o);
    const li = h(`<li class="in-item is-done"><div class="in-item__main"><b>${esc(o.client.name || 'ללא שם')}</b>
      <small>${esc([o.event.type, o.event.date, o.event.guests ? o.event.guests + ' אורחים' : ''].filter(Boolean).join(' · '))}</small>
      <small>ללקוח <b>${nis(s.client)}</b> · עלות לנו ${nis(s.cost)} · רווח <b class="of-profit">${nis(s.profit)}</b>${o.quoteId ? ' · יש הצעה ללקוח' : ''} · עודכן ${when(o.updatedAt)}</small></div>
      <div class="in-item__btns"><button type="button" class="btn btn--gold btn--sm" data-open>לפתוח</button><button type="button" class="in-del" data-del>למחוק</button></div></li>`);
    $('[data-open]', li).addEventListener('click', () => { cur = JSON.parse(JSON.stringify(o)); dirty = false; ctx.rerender(); scrollTo(0, 0); });
    $('[data-del]', li).addEventListener('click', async () => {
      if (!confirm('למחוק את החישוב של ' + (o.client.name || '') + '? ההצעה שהלקוח קיבל (אם נשלחה) נשארת בעמוד הצעות המחיר.')) return;
      try { await api('POST', '', { op: 'offerDel', id: o.id }); list = list.filter(x => x !== o); ctx.rerender(); } catch (e) { fail(e); }
    });
    ul.append(li);
  }
  return el;
}

/* ---------- the builder ---------- */
function builder() {
  const o = cur;
  const top = h(`<div class="of-top"><button type="button" class="in-back" data-back>חזרה לכל ההצעות</button></div>`);
  $('[data-back]', top).addEventListener('click', () => { if (dirty && !confirm('יש שינויים שלא נשמרו. לצאת בלי לשמור?')) return; cur = null; pick = null; list = null; ctx.rerender(); });

  const who = h(`<section class="card"><div class="card__head"><div><h2>הלקוח והאירוע</h2><p>מה שכתוב כאן מופיע בהצעה תחת "לכבוד".</p></div></div>
    <div class="in-row">
      <label class="f">שם הלקוח<input data-k="client.name" maxlength="120"></label>
      <label class="f">טלפון<input data-k="client.phone" maxlength="40" dir="ltr" inputmode="tel"></label>
      <label class="f">סוג האירוע<input data-k="event.type" maxlength="80"></label>
      <label class="f">תאריך<input data-k="event.date" maxlength="60" placeholder="למשל: 20.5.2027"></label>
      <label class="f">אורחים<input data-k="event.guests" type="number" min="0" inputmode="numeric"></label>
      <label class="f">שפת ההצעה<select data-k="lang"><option value="he">עברית</option><option value="fr">צרפתית</option></select></label>
    </div></section>`);
  $$('[data-k]', who).forEach(inp => {
    const [a, b] = inp.dataset.k.split('.');
    inp.value = b ? o[a][b] ?? '' : o[a] ?? '';
    inp.addEventListener('input', () => { if (b) o[a][b] = inp.type === 'number' ? Number(inp.value) || '' : inp.value; else o[a] = inp.value; dirty = true; if (a === 'event' && b === 'guests') redrawRows(); });
  });

  const fee = h(`<section class="card"><div class="card__head"><div><h2>העמלה והעיגול</h2><p>חלים על כל השורות. בשורה אחת אפשר לשים עמלה אחרת, או לכתוב את המחיר ללקוח ביד.</p></div></div>
    <div class="in-row"><label class="f">העמלה שלנו (%)<input type="number" min="0" max="300" inputmode="decimal" data-fee value="${o.fee}"></label>
    <label class="f">לעגל למעלה<select data-round>${[[0, 'בלי עיגול'], [10, 'ל-10 ₪'], [50, 'ל-50 ₪'], [100, 'ל-100 ₪'], [500, 'ל-500 ₪']].map(([v, t]) => `<option value="${v}" ${Number(o.round) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label></div></section>`);
  $('[data-fee]', fee).addEventListener('input', e => { o.fee = Number(e.target.value) || 0; dirty = true; redrawRows(); });
  $('[data-round]', fee).addEventListener('change', e => { o.round = Number(e.target.value); dirty = true; redrawRows(); });

  const rowsCard = h(`<section class="card"><div class="card__head"><div><h2>מה בהצעה</h2><p>"השם בהצעה" הוא מה שהלקוח רואה. "עלות לנו" והעמלה נשארים רק אצלנו.</p></div></div>
    <div class="of-rows"></div>
    <p class="in-q">להוסיף מהמאגר</p>
    <div class="in-btns">${Object.entries({ venue: 'אולם או גן', hotel: 'מלון', fun: 'אטרקציה', artist: 'אמן' }).map(([k, t]) => `<button type="button" class="btn btn--line btn--sm" data-add="${k}">+ ${t}</button>`).join('')}<button type="button" class="btn btn--line btn--sm" data-free>+ שורה חופשית</button></div>
    <div class="of-pick"></div></section>`);
  $$('[data-add]', rowsCard).forEach(b => b.addEventListener('click', () => { pick = { kind: b.dataset.add, q: '', open: null }; drawPick(); }));
  $('[data-free]', rowsCard).addEventListener('click', () => { o.rows.push({ name: '', src: 'free', from: '', cost: 0, per: 'event', qty: 1, fee: null, final: 0, manual: false }); dirty = true; redrawRows(true); });

  const bar = h(`<div class="of-bar"><div class="of-bar__sum"></div><div class="of-bar__btns">
    <button type="button" class="btn btn--line" data-save>לשמור</button>
    <button type="button" class="btn btn--gold" data-quote>${o.quoteId ? 'לעדכן את ההצעה ללקוח' : 'ליצור הצעת מחיר ללקוח'}</button></div></div>`);
  $('[data-save]', bar).addEventListener('click', () => save(true));
  $('[data-quote]', bar).addEventListener('click', async e => {
    if (!o.rows.length) return ctx.toast('עוד אין שורות בהצעה', 'err');
    if (o.rows.some(r => !finalOf(o, r))) { if (!confirm('יש שורות בלי מחיר ללקוח. הן לא יופיעו בהצעה. להמשיך?')) return; }
    e.target.disabled = true;
    try {
      const q = await ctx.quoteFrom(o, clientItems(o));
      if (!q) { e.target.disabled = false; return; }
      o.quoteId = q.id; await save(false);
      ctx.toast(o.quoteId ? 'ההצעה ללקוח מוכנה' : 'נשמר');
      ctx.openQuote(q);
    } catch (x) { fail(x); e.target.disabled = false; }
  });

  function drawSum() {
    const s = sums(o);
    $('.of-bar__sum', bar).innerHTML = `<span>עלות לנו <b>${nis(s.cost)}</b></span><span>ללקוח <b>${nis(s.client)}</b></span><span>רווח <b class="of-profit">${nis(s.profit)}</b>${s.cost ? ` <small>(${s.pct}%)</small>` : ''}</span>`;
  }
  function redrawRows(focusLast) {
    const box = $('.of-rows', rowsCard);
    box.innerHTML = o.rows.length ? '' : '<p class="hint">עוד אין שורות. מוסיפים מהמאגר למטה, או שורה חופשית.</p>';
    o.rows.forEach((r, i) => {
      const q = qtyOf(o, r), fin = finalOf(o, r);
      const row = h(`<div class="of-row">
        <div class="of-row__head"><span class="of-src">${SRC[r.src]}</span>${r.from && r.from !== r.name ? `<small>${esc(r.from)}</small>` : ''}<button type="button" class="icon icon--del" data-del title="להסיר">✕</button></div>
        <label class="f of-name">השם בהצעה<input data-f="name" maxlength="300"></label>
        <div class="of-grid">
          <label class="f">עלות לנו (₪)<input data-f="cost" type="number" min="0" inputmode="decimal" dir="ltr"></label>
          <label class="f">המחיר הוא<select data-f="per"><option value="event">לכל האירוע</option><option value="guest">לאורח</option></select></label>
          <label class="f">${r.per === 'guest' ? 'אורחים' : 'כמות'}<input data-f="qty" type="number" min="1" inputmode="numeric" dir="ltr" ${r.per === 'guest' ? 'disabled' : ''}></label>
          <label class="f">עמלה (%)<input data-f="fee" type="number" min="0" inputmode="decimal" dir="ltr" placeholder="${o.fee}"></label>
          <label class="f of-final">ללקוח ליחידה (₪)<input data-f="final" type="number" min="0" inputmode="decimal" dir="ltr"></label>
        </div>
        <p class="of-row__foot">${r.manual ? '<span class="of-hand">מחיר שנכתב ביד</span> <button type="button" class="in-del" data-auto>לחשב שוב לפי העמלה</button> · ' : ''}סה״כ ללקוח <b>${nis(q * fin)}</b> · רווח ${nis(q * (fin - (Number(r.cost) || 0)))}</p></div>`);
      $('[data-f=name]', row).value = r.name; $('[data-f=cost]', row).value = r.cost || ''; $('[data-f=per]', row).value = r.per;
      $('[data-f=qty]', row).value = q; $('[data-f=fee]', row).value = r.fee ?? ''; $('[data-f=final]', row).value = fin || '';
      $('[data-f=name]', row).addEventListener('input', e => { r.name = e.target.value; dirty = true; });
      const live = () => { const q2 = qtyOf(o, r), f2 = finalOf(o, r); if (!r.manual) $('[data-f=final]', row).value = f2 || ''; $('.of-row__foot b', row).textContent = nis(q2 * f2); drawSum(); dirty = true; };
      $('[data-f=cost]', row).addEventListener('input', e => { r.cost = Number(e.target.value) || 0; live(); });
      $('[data-f=fee]', row).addEventListener('input', e => { r.fee = e.target.value === '' ? null : Number(e.target.value) || 0; live(); });
      $('[data-f=qty]', row).addEventListener('input', e => { r.qty = Math.max(1, Number(e.target.value) || 1); live(); });
      $('[data-f=per]', row).addEventListener('change', e => { r.per = e.target.value; dirty = true; redrawRows(); });
      $('[data-f=final]', row).addEventListener('change', e => { r.final = Number(e.target.value) || 0; r.manual = true; dirty = true; redrawRows(); });
      $('[data-auto]', row)?.addEventListener('click', () => { r.manual = false; dirty = true; redrawRows(); });
      $('[data-del]', row).addEventListener('click', () => { o.rows.splice(i, 1); dirty = true; redrawRows(); });
      box.append(row);
    });
    drawSum();
    if (focusLast) $$('.of-row [data-f=name]', box).pop()?.focus();
  }

  async function drawPick() {
    const box = $('.of-pick', rowsCard);
    if (!pick) { box.innerHTML = ''; return; }
    const k = pick.kind;
    box.innerHTML = '<p class="hint">טוען…</p>';
    try {
      if (!cats[k]) {
        if (k === 'venue') cats[k] = (await api('GET', '?catalog=venues', null, '/api/hotels')).hotels;
        else if (k === 'hotel') cats[k] = (await api('GET', '?catalog=1', null, '/api/hotels')).hotels;
        else if (k === 'fun') cats[k] = (await api('GET', '', null, '/api/fun')).list;
        else cats[k] = (await api('GET', '', null, '/api/artists')).artists;
      }
    } catch (e) { box.innerHTML = ''; fail(e); return; }
    const all = cats[k] || [];
    box.innerHTML = '';
    const head = h(`<div class="of-pick__head"><input class="input" type="search" placeholder="חיפוש לפי שם, עיר או אזור" aria-label="חיפוש"><button type="button" class="btn btn--line btn--sm" data-x>סגירה</button></div>`);
    const res = h('<div class="of-pick__list"></div>');
    $('input', head).value = pick.q;
    $('input', head).addEventListener('input', e => { pick.q = e.target.value; draw(); });
    $('[data-x]', head).addEventListener('click', () => { pick = null; drawPick(); });
    const add = row => { o.rows.push({ fee: null, final: 0, manual: false, qty: 1, ...row }); dirty = true; redrawRows(); ctx.toast('נוסף: ' + row.name); };
    function draw() {
      const words = pick.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const rows = all.filter(x => words.every(w => [x.name, x.city, x.area, x.supplier].join(' ').toLowerCase().includes(w))).slice(0, 30);
      res.innerHTML = rows.length ? '' : '<p class="hint">לא נמצא במאגר.</p>';
      for (const x of rows) {
        if (k === 'venue' || k === 'hotel') {
          const prices = (x.prices || []).filter(p => p.price > 0);
          const item = h(`<div class="of-opt"><div class="of-opt__t"><b>${esc(x.name)}</b><small>${esc(x.city || x.area || '')}${prices.length ? '' : ' · אין מחיר במאגר'}</small></div><div class="of-opt__p"></div></div>`);
          const p = $('.of-opt__p', item);
          for (const pr of prices.slice(0, 6)) {
            const per = PER_GUEST.test([pr.per, pr.level].join(' ')) ? 'guest' : 'event';
            const b = h(`<button type="button" class="btn btn--line btn--sm">${esc([pr.level, pr.board].filter(Boolean).join(', ') || 'מחיר')}: ${nis(pr.price)}${pr.per ? ' ' + esc(pr.per) : ''}</button>`);
            b.addEventListener('click', () => add({ src: k, from: x.name, name: x.name + ([pr.level, pr.board].filter(Boolean).length ? ' – ' + [pr.level, pr.board].filter(Boolean).join(', ') : ''), cost: pr.price, per }));
            p.append(b);
          }
          const b0 = h('<button type="button" class="btn btn--line btn--sm">בלי מחיר (אכתוב ביד)</button>');
          b0.addEventListener('click', () => add({ src: k, from: x.name, name: x.name, cost: 0, per: 'event' }));
          p.append(b0); res.append(item);
        } else {
          const price = k === 'fun' && x.price > 0 ? x.price : 0;
          const per = k === 'fun' && x.per === 'person' ? 'guest' : 'event';
          const item = h(`<div class="of-opt"><div class="of-opt__t"><b>${esc(x.name)}</b><small>${esc([x.area, k === 'fun' && price ? nis(price) + ({ person: ' לאדם', group: ' לקבוצה', hour: ' לשעה', event: ' לאירוע' }[x.per] || '') : k === 'artist' ? 'המחיר נכתב ביד' : ''].filter(Boolean).join(' · '))}</small></div><div class="of-opt__p"><button type="button" class="btn btn--line btn--sm">להוסיף</button></div></div>`);
          $('button', item).addEventListener('click', () => add({ src: k, from: x.name, name: x.name, cost: price, per }));
          res.append(item);
        }
      }
    }
    box.append(head, res); draw();
    $('input', head).focus();
  }

  async function save(say) {
    try {
      const r = await api('POST', '', { op: 'offer', ...o });
      Object.assign(o, r.offer); dirty = false; list = null;
      if (say) ctx.toast('נשמר');
    } catch (e) { fail(e); throw e; }
  }

  redrawRows(); if (pick) drawPick();
  return [top, who, fee, rowsCard, bar];
}
