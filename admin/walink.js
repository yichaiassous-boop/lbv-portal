// owner 25.11: "הוואטסאפ שלי" — the owner's own WhatsApp, linked once like WhatsApp Web (service: lbv-wa, server: api/_walink.js).
// Owner only. Two parts:
//  1. the link: a code to scan once; if it drops, a new code shows here
//  2. a list: one message to many people, sent slowly by the service (a wait between messages, a daily cap,
//     never on Shabbat or a holiday). {שם} in the message becomes each person's name.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const when = iso => (iso ? new Date(iso).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
let ctx = null, timer = null, draft = { title: '', text: '', list: [], at: '' };

async function api(method, body) {
  const r = await fetch('/api/walink', { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { ctx.toast('פג תוקף הכניסה. היכנסו שוב', 'err'); ctx.showLogin(); throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}
const fail = e => {
  if (e.message === 'login') return;
  ctx.toast({ forbidden: 'רק לבעלים', text: 'כותבים את ההודעה', list: 'אין ברשימה אף מספר טלפון', 'not-configured': 'המאגר לא מחובר' }[e.message] || 'משהו השתבש. נסו שוב', 'err');
};

const STATE = {
  none: ['עוד לא הופעל', 'שירות החיבור עוד לא רץ על השרת. אחרי שהוא עולה, כאן יופיע קוד לסריקה.'],
  down: ['השירות לא פועל', 'השרת של החיבור לא ענה בשלוש הדקות האחרונות. ההודעות לא נקראות ולא נשלחות עד שהוא חוזר.'],
  starting: ['מתחבר…', 'עוד רגע יופיע כאן קוד לסריקה, או שהחיבור יחזור לבד.'],
  reconnecting: ['מתחבר מחדש…', 'החיבור נפל לרגע והוא חוזר לבד. אין צורך לעשות כלום.'],
  qr: ['צריך לסרוק פעם אחת', 'בטלפון: וואטסאפ ← הגדרות ← מכשירים מקושרים ← קישור מכשיר, ומכוונים את המצלמה לקוד. הקוד מתחלף כל כמה שניות, וזה בסדר.'],
  open: ['מחובר', 'המערכת קוראת רק שיחות עם מקומות שיש להם כרטיס, ושולחת את הרשימות שלך לאט.'],
  off: ['מנותק', 'החיבור בוטל מהטלפון. עוד רגע יופיע קוד חדש לסריקה.'],
  error: ['תקלה', 'השירות נתקל בתקלה ומנסה שוב לבד.'],
  billing: ['נעצר: גוגל רצתה לחייב', 'כמו שביקשת, ברגע שהופיע חיוב השרת כיבה את עצמו. שום דבר לא נקרא ולא נשלח. כדי להפעיל שוב צריך להחליט אם לשלם, או לעבור לשרת אחר.'],
};
const CAMP = { run: 'נשלחת', pause: 'בהפסקה', stop: 'נעצרה', done: 'הסתיימה' };
const ITEM = { ok: 'נשלח', wait: 'ממתין', fail: 'לא נשלח', nowa: 'אין לו וואטסאפ', bad: 'מספר לא תקין' };

export async function walinkPage(pg, c) {
  ctx = c; clearTimeout(timer);
  pg.append(h('<p class="hint">טוען…</p>'));
  let d;
  try { d = await api('GET'); } catch (e) { pg.innerHTML = ''; fail(e); return; }
  pg.innerHTML = '';
  pg.append(linkCard(d), oneCard(d), newCard(d), ...d.camps.map(campCard));
  // while waiting for a scan or while a list is going out: refresh by itself
  const busy = ['qr', 'starting', 'reconnecting', 'off'].includes(d.state.state) || d.camps.some(x => x.status === 'run');
  if (busy) timer = setTimeout(() => { if (document.body.contains(pg) && !pg.querySelector('textarea:focus, input:focus')) ctx.rerender(); }, d.state.state === 'qr' ? 8000 : 20000);
}

function linkCard(d) {
  const s = d.state || {}, [title, sub] = STATE[s.state] || STATE.none;
  const el = h(`<section class="card wl-link wl-link--${esc(s.state || 'none')}">
    <div class="wl-link__head"><span class="wl-dot" aria-hidden="true"></span><h2>${esc(title)}</h2></div>
    <p class="hint">${esc(sub)}</p>
    ${s.state === 'qr' && /^data:image\/png;base64,/.test(s.qr || '') ? `<img class="wl-qr" src="${s.qr}" alt="קוד לסריקה בוואטסאפ" width="280" height="280">` : ''}
    ${s.state === 'open' ? `<p class="wl-me">המספר המחובר: <b dir="ltr">+${esc(s.me || '')}</b>${s.name ? ' · ' + esc(s.name) : ''}</p><p class="hint">נשלחו היום מרשימות: ${d.today} מתוך ${d.cap} לכל היותר ליום.</p>` : ''}
    <div class="row-tools">${s.state === 'open' ? '<button type="button" class="btn btn--line btn--sm" data-op="logout">לנתק את החיבור</button>' : ''}${['error', 'down', 'reconnecting'].includes(s.state) ? '<button type="button" class="btn btn--line btn--sm" data-op="restart">לנסות להתחבר שוב</button>' : ''}</div>
  </section>`);
  el.querySelectorAll('[data-op]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.op === 'logout' && !confirm('לנתק את המערכת מהוואטסאפ? אחר כך צריך לסרוק קוד מחדש.')) return;
    b.disabled = true;
    try { await api('POST', { op: b.dataset.op }); ctx.toast(b.dataset.op === 'logout' ? 'מנתק. עוד רגע יופיע קוד חדש' : 'מנסה שוב', 'ok'); setTimeout(ctx.rerender, 4000); }
    catch (e) { fail(e); b.disabled = false; }
  }));
  return el;
}

/* ---------- one message to one person (owner 26.11) ---------- */
// The same slow sender as the lists, with one person in it: it goes out within a few seconds and shows below with its status.
let one = { phone: '', text: '' };
function oneCard(d) {
  const open = d.state?.state === 'open';
  const el = h(`<section class="card wl-one">
    <h2>הודעה לאדם אחד</h2>
    <p class="hint">כותבים מספר והודעה, והיא נשלחת מהוואטסאפ שלך תוך כמה שניות.</p>
    <label class="field"><span>מספר טלפון</span><input name="phone" type="tel" inputmode="tel" dir="ltr" maxlength="30" placeholder="050-1234567"></label>
    <label class="field"><span>ההודעה</span><textarea name="text" rows="4" maxlength="3000"></textarea></label>
    <div class="row-tools"><button type="button" class="btn btn--gold" data-one${open ? '' : ' disabled'}>לשלוח</button>${open ? '' : '<span class="hint">אפשר לשלוח רק כשהוואטסאפ מחובר</span>'}</div>
  </section>`);
  const p = el.querySelector('[name="phone"]'), t = el.querySelector('[name="text"]');
  p.value = one.phone; t.value = one.text;
  p.addEventListener('input', () => { one.phone = p.value; });
  t.addEventListener('input', () => { one.text = t.value; });
  el.querySelector('[data-one]').addEventListener('click', async e => {
    const digits = one.phone.replace(/\D/g, '');
    if (digits.length < 9) return ctx.toast('המספר לא שלם', 'err');
    if (!one.text.trim()) return ctx.toast('כותבים את ההודעה', 'err');
    if (!confirm(`לשלוח את ההודעה ל-${one.phone.trim()}?`)) return;
    e.target.disabled = true;
    try {
      await api('POST', { op: 'camp', title: 'הודעה ל-' + one.phone.trim(), text: one.text, list: [{ phone: one.phone.trim(), name: '' }] });
      one = { phone: '', text: '' };
      ctx.toast('ההודעה נשלחת', 'ok'); ctx.rerender();
    } catch (err) { fail(err); e.target.disabled = false; }
  });
  return el;
}

/* ---------- a new list ---------- */
// one line = one person: a phone number, and the rest of the line is the name (Excel copy-paste, CSV, or typed)
function parseList(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/\+?\d[\d\s\-().]{7,}\d/);
    if (!m) continue;
    const phone = m[0].replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 9) continue;
    const name = line.replace(m[0], ' ').split(/[\t,;|]+/).map(x => x.trim()).filter(x => x && !/^\d+$/.test(x) && !/^(שם|טלפון|נייד|name|phone)$/i.test(x)).join(' ').replace(/\s{2,}/g, ' ').trim();
    out.push({ phone, name: name.slice(0, 60) });
  }
  const seen = new Set();
  return out.filter(x => { const k = x.phone.replace(/\D/g, '').slice(-9); if (seen.has(k)) return false; seen.add(k); return true; });
}
async function readFile(file) {
  if (/\.(xlsx|xls)$/i.test(file.name)) {
    const XLSX = await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    return wb.SheetNames.map(n => XLSX.utils.sheet_to_csv(wb.Sheets[n], { FS: '\t' })).join('\n');
  }
  return file.text();
}

function newCard(d) {
  const open = d.state?.state === 'open';
  const el = h(`<section class="card wl-new">
    <h2>הודעה אחת להרבה אנשים</h2>
    <p class="hint">כותבים הודעה, מעלים רשימה, והמערכת שולחת לכל אחד בנפרד, בהפרש של חצי דקה עד דקה וחצי. לא שולחים בשבת ובחגים, ולא יותר מ-${d.cap} ביום.</p>
    <label class="field"><span>שם לרשימה (רק בשבילך)</span><input name="title" maxlength="80" placeholder="למשל: משפחות המשקפים"></label>
    <label class="field"><span>ההודעה</span><textarea name="text" rows="6" maxlength="3000" placeholder="שלום {שם}, ..."></textarea></label>
    <p class="hint wl-tip">אם כותבים <b>{שם}</b>, כל אחד יקבל את השם שלו מהרשימה.</p>
    <label class="field"><span>הרשימה</span><input type="file" name="file" accept=".xlsx,.xls,.csv,.txt"></label>
    <label class="field"><span>או להדביק מאקסל (שורה לכל אדם: טלפון ושם)</span><textarea name="paste" rows="4" dir="auto" placeholder="0501234567	משפחת כהן"></textarea></label>
    <div class="wl-count" aria-live="polite"></div>
    <label class="field"><span>מתי להתחיל</span><input type="datetime-local" name="at"></label>
    <div class="wl-preview" hidden><b>כך זה ייראה אצל הראשון ברשימה:</b><p></p></div>
    <p class="hint hint--box wl-risk">זה החיבור הלא רשמי. אנשים ששמרו את המספר שלך מקבלים בלי בעיה. רשימה גדולה של אנשים שלא מכירים אותך עלולה לגרום לוואטסאפ לחסום את המספר.</p>
    <div class="row-tools"><button type="button" class="btn btn--gold" data-go${open ? '' : ' disabled'}>לשלוח לרשימה</button>${open ? '' : '<span class="hint">אפשר לשלוח רק כשהוואטסאפ מחובר</span>'}</div>
  </section>`);
  const f = n => el.querySelector(`[name="${n}"]`);
  f('title').value = draft.title; f('text').value = draft.text; f('at').value = draft.at;
  const count = el.querySelector('.wl-count'), prev = el.querySelector('.wl-preview');
  const show = () => {
    draft.title = f('title').value; draft.text = f('text').value; draft.at = f('at').value;
    count.innerHTML = draft.list.length ? `<b>${draft.list.length} אנשים ברשימה.</b> ${draft.list.filter(x => !x.name).length ? draft.list.filter(x => !x.name).length + ' בלי שם.' : ''} <details><summary>לראות את הרשימה</summary><ol>${draft.list.slice(0, 300).map(x => `<li><span dir="ltr">${esc(x.phone)}</span> ${esc(x.name)}</li>`).join('')}</ol></details>` : '';
    const first = draft.list[0];
    prev.hidden = !(first && draft.text.trim());
    if (first) prev.querySelector('p').textContent = draft.text.replace(/\{שם\}/g, first.name || '').replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
  };
  ['title', 'text', 'at'].forEach(n => f(n).addEventListener('input', show));
  f('paste').addEventListener('input', () => { draft.list = parseList(f('paste').value); show(); });
  f('file').addEventListener('change', async () => {
    const file = f('file').files[0];
    if (!file) return;
    try { const t = await readFile(file); f('paste').value = t; draft.list = parseList(t); show(); if (!draft.list.length) ctx.toast('לא מצאתי מספרי טלפון בקובץ', 'err'); }
    catch (e) { ctx.toast('לא הצלחתי לקרוא את הקובץ. אפשר להעתיק מאקסל ולהדביק', 'err'); }
  });
  show();
  el.querySelector('[data-go]').addEventListener('click', async e => {
    if (!draft.text.trim()) return ctx.toast('כותבים את ההודעה', 'err');
    if (!draft.list.length) return ctx.toast('אין ברשימה אף מספר טלפון', 'err');
    const days = Math.ceil(draft.list.length / d.cap);
    if (!confirm(`לשלוח את ההודעה ל-${draft.list.length} אנשים?${days > 1 ? `\nזה ייקח בערך ${days} ימים (עד ${d.cap} ביום).` : ''}\nאפשר לעצור בכל רגע.`)) return;
    e.target.disabled = true;
    try {
      await api('POST', { op: 'camp', title: draft.title, text: draft.text, list: draft.list, at: draft.at ? new Date(draft.at).toISOString() : '' });
      draft = { title: '', text: '', list: [], at: '' };
      ctx.toast('הרשימה בדרך. השליחה מתחילה לבד', 'ok'); ctx.rerender();
    } catch (err) { fail(err); e.target.disabled = false; }
  });
  return el;
}

function campCard(x) {
  const pct = x.total ? Math.round(((x.sent + x.failed) / x.total) * 100) : 0;
  const note = x.note === 'cap' ? 'הגיעה למכסה של היום, ממשיכה מחר.' : x.note === 'errors' ? 'וואטסאפ סירב כמה פעמים ברצף, אז השליחה נעצרה. כדאי לבדוק בטלפון שהכל תקין ואז להמשיך.' : '';
  const el = h(`<section class="card wl-camp wl-camp--${esc(x.status)}">
    <div class="wl-camp__head"><h3>${esc(x.title)}</h3><span class="wl-pill">${esc(CAMP[x.status] || x.status)}</span></div>
    <p class="hint">${Date.parse(x.at) > Date.now() ? 'מתחילה ב-' + esc(when(x.at)) + ' · ' : ''}נשלחו ${x.sent} מתוך ${x.total}${x.failed ? ` · ${x.failed} לא נשלחו` : ''}${x.doneAt ? ' · ' + esc(when(x.doneAt)) : ''}</p>
    <div class="wl-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    ${note ? `<p class="hint hint--box">${esc(note)}</p>` : ''}
    <details><summary>ההודעה והאנשים</summary><p class="wl-text">${esc(x.text)}</p>
      <ol class="wl-items">${x.items.map(i => `<li class="wl-i--${esc(i.st)}"><span dir="ltr">${esc(i.phone)}</span> ${esc(i.name)} <small>${esc(ITEM[i.st] || i.st)}${i.at ? ' ' + esc(when(i.at)) : ''}</small></li>`).join('')}</ol></details>
    <div class="row-tools">
      ${x.status === 'run' ? '<button type="button" class="btn btn--line btn--sm" data-op="pause">הפסקה</button>' : ''}
      ${x.status === 'pause' ? '<button type="button" class="btn btn--line btn--sm" data-op="resume">להמשיך</button>' : ''}
      ${['run', 'pause'].includes(x.status) ? '<button type="button" class="btn btn--line btn--sm" data-op="stop">לעצור לגמרי</button>' : ''}
      ${['done', 'stop'].includes(x.status) ? '<button type="button" class="btn btn--line btn--sm" data-op="del">להסיר מהרשימה</button>' : ''}
    </div>
  </section>`);
  el.querySelectorAll('[data-op]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.op === 'stop' && !confirm('לעצור את השליחה? מי שעוד לא קיבל לא יקבל.')) return;
    b.disabled = true;
    try { await api('POST', { op: b.dataset.op, id: x.id }); ctx.rerender(); } catch (e) { fail(e); b.disabled = false; }
  }));
  return el;
}
