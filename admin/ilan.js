// מטלות מאילן (owner 19.11): every phone call with Ilan is read by the robot (like the hotel calls):
// a short summary, what he wants, and each thing he asked for becomes a task here. Only the owner sees it.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const safeUrl = u => (/^https:\/\//i.test(String(u || '')) ? u : '');
const dm = d => { const [y, m, dd] = String(d || '').split('-'); return dd ? `${+dd}.${+m}` : ''; };
const when = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' }) + ', ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }); };
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

let ctx = null, data = null, showDone = false, openCall = null;

async function api(method, qs = '', body) {
  const r = await fetch('/api/hotels' + qs, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { ctx.toast('פג תוקף הכניסה. היכנסו שוב', 'err'); ctx.showLogin(); throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || String(r.status));
  return j;
}
const fail = e => { if (e.message !== 'login') ctx.toast('משהו השתבש. נסו שוב', 'err'); };
const act = (body) => api('POST', '', { op: 'ilan', ...body });

export async function ilanPage(pg, c) {
  ctx = c;
  if (!data) {
    pg.append(h('<p class="hint">טוען…</p>'));
    try { data = await api('GET', '?ilan=1'); } catch (e) { pg.innerHTML = ''; fail(e); return; }
    pg.innerHTML = '';
  }
  const phones = data.cfg?.phones || [];
  if (!phones.length) { pg.append(setupCard()); return; }
  pg.append(tasksCard(), callsCard(), setupCard(true));
}
const again = async () => { try { data = await api('GET', '?ilan=1'); } catch (e) { fail(e); } ctx.rerender(); };

/** Ilan's number(s): calls with them are read and turned into tasks. */
function setupCard(small) {
  const phones = data.cfg?.phones || [];
  const el = h(`<section class="il-setup ${small ? 'is-small' : ''}">
    ${small ? `<p>השיחות נקראות מהמספרים: <b dir="ltr">${phones.map(esc).join(', ')}</b> <button type="button" class="il-link" data-edit>לשנות</button></p>` : `
    <h3>מה המספר של אילן?</h3>
    <p>מרגע שתשמרו, כל שיחה איתו מהטלפון של העבודה נשלחת לבד, והמערכת כותבת מה הוא ביקש ומוסיפה כל בקשה לרשימת המטלות. גם השיחות איתו מהשבוע האחרון ייקראו.</p>`}
    <form class="il-phones" ${small ? 'hidden' : ''}>
      <input class="input" name="p" dir="ltr" inputmode="tel" placeholder="050-0000000" value="${esc(phones.join(', '))}" aria-label="המספר של אילן (אפשר כמה, עם פסיק)">
      <button class="btn btn--gold">לשמור</button>
    </form>
  </section>`);
  el.querySelector('[data-edit]')?.addEventListener('click', () => { el.querySelector('form').hidden = false; el.querySelector('input').focus(); });
  el.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const list = e.target.p.value.split(/[,;\s]+/).filter(Boolean);
    if (!list.some(x => x.replace(/\D/g, '').length >= 8)) { ctx.toast('צריך מספר טלפון מלא', 'err'); return; }
    try { await act({ act: 'cfg', phones: list }); ctx.toast('נשמר. מעכשיו כל שיחה עם אילן נכנסת לכאן'); await again(); } catch (err) { fail(err); }
  });
  return el;
}

function taskRow(t) {
  const late = !t.done && t.due && t.due < today();
  const call = t.callId ? (data.calls || []).find(c => c.id === t.callId) : null;
  const el = h(`<li class="il-task ${t.done ? 'is-done' : ''}">
    <label class="il-check"><input type="checkbox" ${t.done ? 'checked' : ''} aria-label="בוצע"><span></span></label>
    <div class="il-task__body">
      <p>${esc(t.text)}</p>
      <small>${t.due ? `<em class="${late ? 'late' : ''}">${late ? 'עבר הזמן: ' : 'עד '}${dm(t.due)}</em>` : t.when ? `<em>${esc(t.when)}</em>` : ''}${call ? `<button type="button" class="il-link" data-call>מהשיחה של ${esc(when(call.at))}</button>` : t.by === 'me' ? 'הוספתי בעצמי' : ''}</small>
      ${t.quote ? `<q>${esc(t.quote)}</q>` : ''}
    </div>
    <button type="button" class="il-x" aria-label="למחוק את המטלה">×</button>
  </li>`);
  el.querySelector('input').addEventListener('change', async e => { try { await act({ act: 'done', id: t.id, done: e.target.checked }); await again(); } catch (err) { fail(err); } });
  el.querySelector('.il-x').addEventListener('click', async () => { if (!confirm('למחוק את המטלה?')) return; try { await act({ act: 'del', id: t.id }); await again(); } catch (err) { fail(err); } });
  el.querySelector('[data-call]')?.addEventListener('click', () => { openCall = t.callId; ctx.rerender(); setTimeout(() => document.getElementById('il-c-' + t.callId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); });
  return el;
}

function tasksCard() {
  const all = data.tasks || [];
  const open = all.filter(t => !t.done).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || String(b.at).localeCompare(String(a.at)));
  const done = all.filter(t => t.done);
  const el = h(`<section class="il-card">
    <header class="il-head"><h3>מה לעשות</h3><span>${open.length ? `${open.length} פתוחות` : 'אין מטלות פתוחות'}</span></header>
    <form class="il-add"><input class="input" name="t" placeholder="להוסיף מטלה בעצמי" aria-label="מטלה חדשה"><input class="input" type="date" name="d" aria-label="עד מתי"><button class="btn btn--gold">להוסיף</button></form>
    <ul class="il-tasks"></ul>
    ${done.length ? `<button type="button" class="il-link il-more">${showDone ? 'להסתיר' : 'להראות'} את מה שבוצע (${done.length})</button><ul class="il-tasks il-done" ${showDone ? '' : 'hidden'}></ul>` : ''}
  </section>`);
  const ul = el.querySelector('.il-tasks');
  if (!open.length) ul.append(h('<li class="il-empty">כשאילן יבקש משהו בשיחה, זה יופיע כאן.</li>'));
  open.forEach(t => ul.append(taskRow(t)));
  done.sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).forEach(t => el.querySelector('.il-done').append(taskRow(t)));
  el.querySelector('.il-more')?.addEventListener('click', () => { showDone = !showDone; ctx.rerender(); });
  el.querySelector('.il-add').addEventListener('submit', async e => {
    e.preventDefault();
    const text = e.target.t.value.trim(); if (!text) return;
    try { await act({ act: 'add', text, due: e.target.d.value }); await again(); } catch (err) { fail(err); }
  });
  return el;
}

function callsCard() {
  const calls = data.calls || [];
  const el = h(`<section class="il-card">
    <header class="il-head"><h3>השיחות עם אילן</h3><span>${calls.length ? `${calls.length} שיחות` : ''}</span></header>
    <div class="il-calls"></div>
  </section>`);
  const box = el.querySelector('.il-calls');
  if (!calls.length) box.append(h('<p class="il-empty">עוד אין שיחות. השיחה הבאה עם אילן תופיע כאן כמה דקות אחרי שתסתיים.</p>'));
  for (const c of calls) {
    const tasks = (data.tasks || []).filter(t => t.callId === c.id);
    const rec = safeUrl(c.file?.url);
    const d = h(`<details class="il-call" id="il-c-${esc(c.id)}" ${openCall === c.id ? 'open' : ''}>
      <summary><b>${esc(when(c.at))}</b>${c.duration ? `<small>${esc(c.duration)} דק'</small>` : ''}<span>${esc(c.summary)}</span></summary>
      ${(c.wants || []).length ? `<h4>מה אילן רוצה</h4><ul class="il-wants">${c.wants.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${tasks.length ? `<h4>מטלות מהשיחה</h4><ul class="il-wants">${tasks.map(t => `<li class="${t.done ? 'is-done' : ''}">${esc(t.text)}${t.due ? ` (עד ${dm(t.due)})` : ''}</li>`).join('')}</ul>` : ''}
      ${(c.quotes || []).length ? `<h4>מה נאמר</h4><ul class="ev__q">${c.quotes.map(q => `<li><time>${esc(q.time)}</time>${q.speaker ? `<b>${esc(q.speaker)}:</b> ` : ''}"${esc(q.text)}"</li>`).join('')}</ul>` : ''}
      <div class="il-call__foot">${rec ? `<a class="btn btn--line btn--sm" href="${esc(rec)}" target="_blank" rel="noopener">להקשיב להקלטה</a>` : ''}${c.transcript ? '<button type="button" class="btn btn--line btn--sm" data-tr>כל השיחה בכתב</button>' : ''}</div>
      <pre class="il-tr" hidden>${esc(c.transcript)}</pre>
    </details>`);
    d.querySelector('[data-tr]')?.addEventListener('click', () => { const p = d.querySelector('.il-tr'); p.hidden = !p.hidden; });
    d.addEventListener('toggle', () => { if (d.open) openCall = c.id; else if (openCall === c.id) openCall = null; });
    box.append(d);
  }
  return el;
}
