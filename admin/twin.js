// owner 24.11: "הכפיל של אילן" — one place to change everything in a video of Ilan, through one fal.ai key.
// Three tabs: 1. a real clip: clothes, background, an object   2. a new scene: Ilan in any place, walking, moving
// 3. new words: his own cloned voice, and the lips follow. A result of 1 or 2 can go straight to 3.
// Every paid step starts only on the owner's click, after a confirm with the price (fal bills in dollars).
// Server: api/_twin.js (owner only). Files go to the public Blob under twin/ (random names), like the site's videos.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const h = s => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
const when = iso => (iso ? new Date(iso).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const usd = n => '$' + (Math.round(n * 100) / 100).toFixed(2);
const link = u => (/^https:/.test(u || '') ? u : '/' + u);   // local preview keeps files in media/uploads

// fal prices (24.11): Kling O1 edit $0.168/s · Nano Banana Pro $0.15 · Kling 3.0 Pro $0.112/s ($0.168 with sound)
// · MiniMax voice clone $1.5 once, speech $0.1/1000 chars · Sync Lipsync 2 Pro $5/min
const COST = { edit: s => 0.168 * s, still: 0.15, move: (s, snd) => (snd ? 0.168 : 0.112) * s, clone: 1.5, talk: (s, chars) => (5 / 60) * Math.max(s, chars / 14) + chars / 10000 };

// ready-made choices: Hebrew on the button, the English the engines understand best behind it
const EDIT = [
  ['חליפה כחולה', 'Replace his shirt with a tailored navy blue suit jacket over a crisp white open-collar shirt.'],
  ['חליפה שחורה ועניבה', 'Replace his shirt with an elegant black suit, a white shirt and a black tie.'],
  ['חולצה לבנה מכופתרת', 'Replace his shirt with a crisp white button-down shirt.'],
  ['כיפה שחורה', 'Add a small black velvet kippa on top of his head.'],
  ['משקפיים שקופים', 'Replace his sunglasses with clear eyeglasses so his eyes are visible.'],
  ['רקע: אולם אירועים', 'Replace the background with an elegant decorated event hall with warm lights, round tables and white flowers.'],
  ['רקע: חתונה בחוץ', 'Replace the background with an outdoor wedding ceremony at sunset with a white chuppah and guests.'],
  ['רקע: משרד מעוצב', 'Replace the background with a bright modern office with plants and wood.'],
  ['רקע: חוף ים', 'Replace the background with a sunny Mediterranean beach.'],
  ['כוס יין ביד', 'He holds a glass of red wine in his free hand.'],
  ['מיקרופון ביד', 'He holds a black wireless microphone in his hand.'],
];
const PLACE = [
  ['באולם אירועים מעוצב', 'He stands in an elegant decorated wedding hall with warm lights, round tables and white flowers.'],
  ['בחתונה בחוץ בשקיעה', 'He stands at an outdoor wedding venue at sunset, a white chuppah and guests behind him.'],
  ['בלובי של מלון יוקרה', 'He stands in the lobby of a luxury hotel with marble floors and soft light.'],
  ['ליד בריכה במלון', 'He stands next to a hotel swimming pool on a sunny day.'],
  ['במשרד של LBV', 'He stands in a bright modern office with plants and wood.'],
  ['ברחוב בירושלים', 'He stands in a Jerusalem stone street in daylight.'],
  ['בפריז', 'He stands in a Paris street with the Eiffel Tower far behind him.'],
];
const WEAR = [
  ['חליפה כחולה', 'He wears a tailored navy blue suit and a white shirt.'],
  ['חליפה שחורה ועניבה', 'He wears an elegant black suit, a white shirt and a black tie.'],
  ['חולצה לבנה', 'He wears a crisp white button-down shirt.'],
  ['כיפה שחורה', 'He wears a small black velvet kippa.'],
];
const HOLD = [
  ['מיקרופון', 'He holds a black wireless microphone.'],
  ['כוס יין', 'He holds a glass of red wine.'],
  ['טאבלט', 'He holds a tablet.'],
  ['זר פרחים', 'He holds a bouquet of white flowers.'],
];
const MOVE = [
  ['הולך לכיוון המצלמה', 'He walks slowly toward the camera and smiles.'],
  ['מראה את המקום ביד', 'He turns slightly and shows the place behind him with an open hand.'],
  ['מנופף לשלום', 'He looks at the camera, smiles and waves hello.'],
  ['מרים כוסית לחיים', 'He raises his glass for a toast and smiles.'],
  ['מדבר למצלמה', 'He talks to the camera with natural hand gestures.'],
  ['הולך ומסתכל סביב', 'He walks through the place, looking around, the camera follows him.'],
];
const STATE = { queued: 'בתור', processing: 'בעבודה', completed: 'מוכן', failed: 'נכשל' };
const KIND = { edit: 'קליפ אמיתי', scene: 'סצנה חדשה', talk: 'דיבור חדש' };
const TABS = [['edit', 'בגדים ורקע', 'בקליפ אמיתי'], ['scene', 'סצנה חדשה', 'בכל מקום, הולך וזז'], ['talk', 'לשנות מה הוא אומר', 'בקול שלו']];
let ctx = null, data = null, tab = 'edit', prefill = null;   // prefill: a result sent to the "talk" tab
const timers = new Map();

async function api(method, body, qs = '') {
  const r = await fetch('/api/twin' + qs, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 401) { ctx.toast('פג תוקף הכניסה. היכנסו שוב', 'err'); ctx.showLogin(); throw new Error('login'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || String(r.status)); e.detail = j.detail || ''; throw e; }
  return j;
}
const fail = e => {
  if (e.message === 'login') return;
  const m = { forbidden: 'רק לבעלים', 'no-key': 'עוד לא חובר המפתח של fal', 'no-voice': 'קודם יוצרים את הקול של אילן', files: 'הקבצים לא עלו. נסו שוב', prompt: 'בוחרים או כותבים מה לעשות', text: 'כותבים מה הוא אומר', length: 'הקליפ צריך להיות בין 3 ל-10 שניות', fal: 'fal החזירו שגיאה' + (e.detail ? ': ' + e.detail : '') }[e.message];
  ctx.toast(m || 'משהו השתבש. נסו שוב', 'err');
};
/** Upload to Blob (twin/…), keeping a sane extension. */
const up = (kind, file) => ctx.upload(`${kind}.${(file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin'}`, file);
/** A clip's length and first frame as a JPEG (in the browser; nothing leaves before the click). */
function readClip(file) {
  return new Promise((ok, no) => {
    const v = document.createElement('video'), u = URL.createObjectURL(file);
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = u;
    v.onerror = () => { URL.revokeObjectURL(u); no(new Error('clip')); };
    v.onloadedmetadata = () => { v.currentTime = Math.min(0.04, v.duration / 2); };
    v.onseeked = () => {
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext('2d').drawImage(v, 0, 0);
      c.toBlob(b => { URL.revokeObjectURL(u); b ? ok({ secs: v.duration, w: v.videoWidth, hgt: v.videoHeight, frame: b }) : no(new Error('clip')); }, 'image/jpeg', 0.92);
    };
  });
}
function readAudio(file) {
  return new Promise((ok, no) => { const a = document.createElement('audio'), u = URL.createObjectURL(file); a.preload = 'metadata'; a.src = u; a.onloadedmetadata = () => { URL.revokeObjectURL(u); ok(a.duration); }; a.onerror = () => no(new Error('audio')); });
}
/** Chips for ready-made choices; returns () => the chosen English lines. */
function chips(el, sel, list) {
  const box = el.querySelector(sel);
  box.innerHTML = list.map(([t], i) => `<button type="button" data-i="${i}">${esc(t)}</button>`).join('');
  box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => (b.getAttribute('aria-pressed') ? b.removeAttribute('aria-pressed') : b.setAttribute('aria-pressed', 'true'))));
  return () => [...box.querySelectorAll('[aria-pressed]')].map(b => list[b.dataset.i][1]);
}

export async function twinPage(pg, c) {
  ctx = c; timers.forEach(t => clearTimeout(t)); timers.clear();
  pg.append(h('<p class="hint">טוען…</p>'));
  try { data = await api('GET'); } catch (e) { pg.innerHTML = ''; fail(e); return; }
  pg.innerHTML = '';
  if (!data.ready) pg.append(keyCard());
  const tabs = h(`<div class="tw-tabs" role="tablist">${TABS.map(([k, t, s]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}"><b>${t}</b><small>${s}</small></button>`).join('')}</div>`);
  tabs.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; ctx.rerender(); }));
  pg.append(tabs, tab === 'edit' ? editCard() : tab === 'scene' ? sceneCard() : talkCard(), h('<h2 class="tw-h">העבודות</h2>'));
  const list = h('<div class="tw-list"></div>');
  if (!data.list.length) list.append(h('<p class="hint">עוד אין עבודות. מתחילים למעלה.</p>'));
  data.list.forEach(j => list.append(jobCard(j)));
  pg.append(list);
  data.list.filter(running).forEach(j => watch(j.id));
  if (live(data.voice?.step)) watchVoice();
}
const live = s => s && (s.state === 'queued' || s.state === 'processing');
const running = j => Object.values(j.steps || {}).some(live) || (j.kind === 'talk' && j.steps?.tts?.state === 'completed' && !j.steps.lips);

function keyCard() {
  return h(`<section class="card tw-key">
    <h2>צריך לחבר את fal פעם אחת</h2>
    <p>הדף מוכן, אבל עוד אין לו מפתח. fal.ai הוא חשבון אחד לכל המנועים (וידאו, קול, שפתיים). משלמים לפי שימוש, בלי מנוי חודשי.</p>
    <ol>
      <li>נכנסים ל-<a href="https://fal.ai" target="_blank" rel="noopener">fal.ai</a>, פותחים חשבון וטוענים קרדיט ב-Billing.</li>
      <li>ב-Dashboard ← API Keys יוצרים מפתח. הוא מוצג פעם אחת בלבד.</li>
      <li>ב-Vercel של הפרויקט: Settings ← Environment Variables ← <b dir="ltr">FAL_KEY</b>, ב-Production, ואז Redeploy.</li>
    </ol>
    <p class="hint">את המפתח מקלידים רק אתם, ישר ב-Vercel. לא שולחים אותו בצ׳אט.</p>
  </section>`);
}
const goBtn = (label) => `<button type="button" class="btn btn--gold" data-go${data.ready ? '' : ' disabled'}>${label}</button><p class="hint tw-st" aria-live="polite"></p>`;

/* ── 1. a real clip ── */
function editCard() {
  const el = h(`<section class="card tw-new">
    <h2>בגדים, רקע וחפצים בקליפ אמיתי</h2>
    <p class="hint">קליפ אמיתי של אילן, 3 עד 10 שניות. הפנים, התנועות והקול נשארים שלו. הכי טוב: פנים מקדימה, אור טוב, בלי משקפי שמש.</p>
    <label class="f">הקליפ<input type="file" name="clip" accept="video/mp4,video/quicktime"></label>
    <div class="tw-pair" hidden><figure><img alt="הפריים הראשון"><figcaption>המקור</figcaption></figure></div>
    <label class="f">תמונה של בגד או חפץ מסוים <small>(לא חובה. למשל החליפה שרוצים בדיוק)</small><input type="file" name="ref" accept="image/jpeg,image/png,image/webp"></label>
    <label class="f">שם לעבודה <small>(לא חובה)</small><input name="title" maxlength="80" placeholder="למשל: אילן בחליפה באולם"></label>
    <fieldset class="tw-pre"><legend>מה לשנות</legend><div class="sm-chips" data-c></div></fieldset>
    <label class="f">או לכתוב בעצמכם <small>(הכי טוב באנגלית)</small><textarea name="free" rows="3" maxlength="1500" dir="auto" placeholder="He holds a golden microphone..."></textarea></label>
    ${goBtn('להפיק את הסרטון')}
  </section>`);
  const picked = chips(el, '[data-c]', EDIT);
  let clip = null;
  const st = el.querySelector('.tw-st'), pair = el.querySelector('.tw-pair'), go = el.querySelector('[data-go]');
  el.querySelector('[name=clip]').addEventListener('change', async e => {
    const f = e.target.files[0]; clip = null; pair.hidden = true; st.textContent = '';
    if (!f) return;
    if (f.size > 200 * 1024 * 1024) { st.textContent = 'הקובץ גדול מ-200MB. מקצרים או מכווצים.'; return; }
    try { clip = { file: f, ...(await readClip(f)) }; } catch (e2) { st.textContent = 'לא הצלחתי לקרוא את הקליפ. צריך MP4.'; return; }
    if (clip.secs < 3 || clip.secs > 10.05) { st.textContent = `הקליפ ${clip.secs.toFixed(1)} שניות. כאן צריך בין 3 ל-10. מקצרים ומעלים שוב.`; clip = null; return; }
    pair.querySelector('img').src = URL.createObjectURL(clip.frame); pair.hidden = false;
    st.textContent = `${clip.secs.toFixed(1)} שניות. המחיר: כ-${usd(COST.edit(clip.secs))}.`;
  });
  go.addEventListener('click', async () => {
    const parts = picked(), free = el.querySelector('[name=free]').value.trim(), ref = el.querySelector('[name=ref]').files[0];
    if (free) parts.push(free);
    if (!clip) { st.textContent = 'קודם בוחרים קליפ.'; return; }
    if (!parts.length) { st.textContent = 'בוחרים לפחות שינוי אחד, או כותבים.'; return; }
    if (ref) parts.push('Use the exact item shown in @Image1.');
    if (!confirm(`להפיק את הסרטון? זה עולה כ-${usd(COST.edit(clip.secs))} מחשבון fal.`)) return;
    go.disabled = true;
    try {
      st.textContent = 'מעלה את הקליפ…';
      const video = await up('clip', clip.file);
      const refUrl = ref ? (st.textContent = 'מעלה את התמונה…', await up('ref', ref)) : '';
      st.textContent = 'שולח…';
      const { job } = await api('POST', { step: 'edit', video, ref: refUrl, prompt: parts.join(' '), title: el.querySelector('[name=title]').value, secs: clip.secs });
      ctx.toast('נשלח. כמה דקות, הדף מתעדכן לבד');
      ctx.rerender(); watch(job.id);
    } catch (e) { fail(e); st.textContent = ''; go.disabled = false; }
  });
  return el;
}

/* ── 2. a new scene ── */
function sceneCard() {
  const el = h(`<section class="card tw-new">
    <h2>סצנה חדשה: אילן בכל מקום</h2>
    <p class="hint">שני שלבים. קודם תמונה של אילן במקום החדש, לאישור שלכם. אחר כך הוא זז בה: הולך, מסתובב, מרים כוסית.</p>
    <label class="f">תמונה של אילן <small>(או קליפ, ואז לוקחים ממנו פריים. הכי טוב: פנים ברורות, כל הגוף אם רוצים שילך)</small><input type="file" name="photo" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"></label>
    <div class="tw-pair" hidden><figure><img alt="התמונה של אילן"><figcaption>המקור</figcaption></figure></div>
    <label class="f">שם לעבודה <small>(לא חובה)</small><input name="title" maxlength="80" placeholder="למשל: אילן בלובי של מלון"></label>
    <fieldset class="tw-pre"><legend>איפה</legend><div class="sm-chips" data-c="place"></div></fieldset>
    <fieldset class="tw-pre"><legend>מה הוא לובש</legend><div class="sm-chips" data-c="wear"></div></fieldset>
    <fieldset class="tw-pre"><legend>מה ביד</legend><div class="sm-chips" data-c="hold"></div></fieldset>
    <label class="f">או לכתוב בעצמכם <small>(הכי טוב באנגלית)</small><textarea name="free" rows="3" maxlength="1500" dir="auto" placeholder="He stands on a rooftop terrace at night..."></textarea></label>
    ${goBtn(`שלב 1: התמונה במקום החדש <small>(כ-${usd(COST.still)})</small>`)}
  </section>`);
  const p1 = chips(el, '[data-c=place]', PLACE), p2 = chips(el, '[data-c=wear]', WEAR), p3 = chips(el, '[data-c=hold]', HOLD);
  let photo = null;
  const st = el.querySelector('.tw-st'), pair = el.querySelector('.tw-pair'), go = el.querySelector('[data-go]');
  el.querySelector('[name=photo]').addEventListener('change', async e => {
    const f = e.target.files[0]; photo = null; pair.hidden = true; st.textContent = '';
    if (!f) return;
    if (f.type.startsWith('video/')) {
      try { const c = await readClip(f); photo = new File([c.frame], 'photo.jpg', { type: 'image/jpeg' }); } catch (e2) { st.textContent = 'לא הצלחתי לקרוא את הקליפ.'; return; }
    } else photo = f;
    if (photo.size > 25 * 1024 * 1024) { st.textContent = 'התמונה גדולה מ-25MB.'; photo = null; return; }
    pair.querySelector('img').src = URL.createObjectURL(photo); pair.hidden = false;
  });
  go.addEventListener('click', async () => {
    const parts = [...p1(), ...p2(), ...p3()], free = el.querySelector('[name=free]').value.trim();
    if (free) parts.push(free);
    if (!photo) { st.textContent = 'קודם בוחרים תמונה של אילן.'; return; }
    if (!parts.length) { st.textContent = 'בוחרים לפחות דבר אחד, או כותבים.'; return; }
    if (!confirm(`ליצור את התמונה במקום החדש? זה עולה כ-${usd(COST.still)} מחשבון fal.`)) return;
    go.disabled = true;
    try {
      st.textContent = 'מעלה את התמונה…';
      const url = await up('photo', photo);
      st.textContent = 'שולח…';
      const { job } = await api('POST', { step: 'scene', photo: url, prompt: parts.join(' '), title: el.querySelector('[name=title]').value });
      ctx.toast('נשלח. התמונה תהיה מוכנה בעוד כחצי דקה');
      ctx.rerender(); watch(job.id);
    } catch (e) { fail(e); st.textContent = ''; go.disabled = false; }
  });
  return el;
}

/* ── 3. new words ── */
function voiceBox() {
  const v = data.voice, s = v?.step;
  const el = h(`<div class="tw-voice"></div>`);
  if (v?.id) {
    el.innerHTML = `<p><b>הקול של אילן מוכן.</b> ${s?.url ? 'ככה הוא נשמע:' : ''}</p>${s?.url ? `<audio src="${esc(link(s.url))}" controls preload="none"></audio>` : ''}
      <p class="hint">חשוב: אם לא משתמשים בקול 7 ימים מהיצירה, המערכת של MiniMax מוחקת אותו ויוצרים שוב.</p>
      <details><summary>להחליף את הקול</summary></details>`;
  } else if (live(s)) {
    el.innerHTML = '<p><b>יוצר את הקול של אילן…</b> כדקה. הדף מתעדכן לבד.</p>';
    return el;
  } else {
    el.innerHTML = `<p><b>שלב ראשון, פעם אחת: הקול של אילן.</b> ${s?.state === 'failed' ? '<span class="tw-bad">הניסיון הקודם נכשל' + (s.why ? ': ' + esc(s.why) : '') + '.</span>' : ''}</p>
      <p class="hint">מקליטים את אילן מדבר רגיל, 30 עד 60 שניות, בלי מוזיקה ובלי רעש (גם הקלטה מהוואטסאפ טובה). קובץ קול: MP3, M4A או WAV.</p>`;
  }
  const form = h(`<div class="tw-vform"><label class="f">ההקלטה<input type="file" name="voice" accept="audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav,audio/aac,audio/ogg,.m4a,.mp3,.wav"></label>
    <button type="button" class="btn btn--gold"${data.ready ? '' : ' disabled'}>ליצור את הקול <small>(כ-${usd(COST.clone)}, פעם אחת)</small></button><p class="hint tw-vst" aria-live="polite"></p></div>`);
  (el.querySelector('details') || el).append(form);
  const st = form.querySelector('.tw-vst'), btn = form.querySelector('button');
  btn.addEventListener('click', async () => {
    const f = form.querySelector('[name=voice]').files[0];
    if (!f) { st.textContent = 'קודם בוחרים הקלטה.'; return; }
    let secs = 0; try { secs = await readAudio(f); } catch (e) { /* some m4a files: no length, fine */ }
    if (secs && secs < 10) { st.textContent = `ההקלטה ${Math.round(secs)} שניות. צריך לפחות 10, הכי טוב 30 ומעלה.`; return; }
    if (!confirm(`ליצור את הקול של אילן מההקלטה? זה עולה כ-${usd(COST.clone)} מחשבון fal.`)) return;
    btn.disabled = true;
    try {
      st.textContent = 'מעלה…';
      const audio = await up('voice', f);
      st.textContent = 'שולח…';
      const r = await api('POST', { step: 'voice', audio });
      data.voice = r.voice; el.replaceWith(voiceBox()); watchVoice();
    } catch (e) { fail(e); st.textContent = ''; btn.disabled = false; }
  });
  return el;
}
function talkCard() {
  const el = h(`<section class="card tw-new">
    <h2>לשנות מה הוא אומר</h2>
    <p class="hint">כותבים את הטקסט, הוא נאמר בקול של אילן, והשפתיים בסרטון זזות לפי המילים.</p>
    <div class="tw-vslot"></div>
    <div class="tw-src"></div>
    <label class="f">שם לעבודה <small>(לא חובה)</small><input name="title" maxlength="80" placeholder="למשל: אילן מזמין לשבת חתן"></label>
    <label class="f">השפה<select name="lang"><option value="Hebrew">עברית</option><option value="French">צרפתית</option><option value="English">אנגלית</option></select></label>
    <label class="f">מה הוא אומר<textarea name="text" rows="4" maxlength="3000" dir="auto" placeholder="שלום, אני אילן מ-La Belle Vie…"></textarea></label>
    ${goBtn('להפיק')}
  </section>`);
  el.querySelector('.tw-vslot').append(voiceBox());
  const st = el.querySelector('.tw-st'), go = el.querySelector('[data-go]'), srcBox = el.querySelector('.tw-src'), txt = el.querySelector('[name=text]');
  let clip = null;
  const price = () => {
    const s = prefill ? prefill.secs : clip?.secs;
    st.textContent = s ? `המחיר: כ-${usd(COST.talk(s, txt.value.trim().length))}. (5$ לדקה של סרטון)` : '';
  };
  const drawSrc = () => {
    if (prefill) {
      srcBox.innerHTML = `<div class="tw-pre-src"><video src="${esc(link(prefill.video))}" muted playsinline preload="metadata"></video><div><b>הסרטון:</b> ${esc(prefill.label)}<br><button type="button" class="btn btn--line">קליפ אחר</button></div></div>`;
      srcBox.querySelector('button').addEventListener('click', () => { prefill = null; drawSrc(); price(); });
    } else {
      srcBox.innerHTML = '<label class="f">הסרטון של אילן <small>(פנים מקדימה, פה ברור. אפשר גם תוצאה מהלשוניות האחרות)</small><input type="file" name="clip" accept="video/mp4,video/quicktime"></label>';
      srcBox.querySelector('input').addEventListener('change', async e => {
        const f = e.target.files[0]; clip = null; st.textContent = '';
        if (!f) return;
        if (f.size > 200 * 1024 * 1024) { st.textContent = 'הקובץ גדול מ-200MB.'; return; }
        try { clip = { file: f, ...(await readClip(f)) }; } catch (e2) { st.textContent = 'לא הצלחתי לקרוא את הקליפ. צריך MP4.'; return; }
        price();
      });
    }
  };
  drawSrc();
  txt.addEventListener('input', price);
  go.addEventListener('click', async () => {
    const text = txt.value.trim(), secs = prefill ? prefill.secs : clip?.secs;
    if (!data.voice?.id) { st.textContent = 'קודם יוצרים את הקול של אילן (למעלה).'; return; }
    if (!prefill && !clip) { st.textContent = 'קודם בוחרים סרטון.'; return; }
    if (!text) { st.textContent = 'כותבים מה הוא אומר.'; return; }
    const cost = usd(COST.talk(secs || 10, text.length));
    if (!confirm(`להפיק? הקול והשפתיים עולים יחד כ-${cost} מחשבון fal.`)) return;
    go.disabled = true;
    try {
      let video = prefill?.video;
      if (!video) { st.textContent = 'מעלה את הסרטון…'; video = await up('clip', clip.file); }
      st.textContent = 'שולח…';
      const { job } = await api('POST', { step: 'talk', video, text, lang: el.querySelector('[name=lang]').value, title: el.querySelector('[name=title]').value, secs });
      prefill = null;
      ctx.toast('נשלח. קודם הקול, אחר כך השפתיים. כמה דקות');
      ctx.rerender(); watch(job.id);
    } catch (e) { fail(e); st.textContent = ''; go.disabled = false; }
  });
  return el;
}

/* ── the jobs ── */
const stepLine = (name, s) => (s ? `<p class="hint">${name}: ${STATE[s.state] || ''}${s.state === 'failed' && s.why ? ', ' + esc(s.why) : ''}${live(s) ? '. הדף מתעדכן לבד.' : ''}</p>` : '');
function jobCard(j) {
  const S = j.steps || {};
  const el = h(`<article class="card tw-job" data-id="${esc(j.id)}">
    <div class="tw-job__top"><h3>${esc(j.title || 'עבודה ללא שם')}</h3><span class="tw-kind">${KIND[j.kind] || ''}</span><span class="hint">${when(j.createdAt)}</span></div>
    <p class="tw-job__p" dir="auto">${esc(j.kind === 'talk' ? j.text : j.prompt)}</p>
    <div class="tw-body"></div>
    <div class="tw-job__acts"></div>
  </article>`);
  const body = el.querySelector('.tw-body'), acts = el.querySelector('.tw-job__acts');
  let result = null;   // the finished video of this job
  if (j.kind === 'scene') {
    const s = S.still || {};
    body.append(h(`<div class="tw-pair">
      <figure><img src="${esc(link(j.photo))}" alt="המקור" loading="lazy"><figcaption>המקור</figcaption></figure>
      <figure>${s.url ? `<img src="${esc(link(s.url))}" alt="במקום החדש">` : `<div class="tw-wait">${STATE[s.state] || '…'}</div>`}<figcaption>במקום החדש${s.state === 'failed' ? ': נכשל' + (s.why ? ', ' + esc(s.why) : '') : ''}</figcaption></figure></div>`));
    if (S.video?.url) result = S.video.url; else body.append(h(`<div>${stepLine('התנועה', S.video)}</div>`));
    if (s.state === 'completed' && (!S.video || S.video.state === 'failed')) acts.append(moveForm(j));
  } else if (j.kind === 'edit') {
    body.append(h(`<div class="tw-pair"><figure><video src="${esc(link(j.video))}" muted playsinline preload="metadata"></video><figcaption>המקור</figcaption></figure></div>`));
    if (S.video?.url) result = S.video.url; else body.append(h(`<div>${stepLine('הסרטון', S.video)}</div>`));
  } else if (j.kind === 'talk') {
    if (S.tts?.url) body.append(h(`<div class="tw-aud"><span class="hint">הקול:</span><audio src="${esc(link(S.tts.url))}" controls preload="none"></audio></div>`));
    else body.append(h(`<div>${stepLine('הקול', S.tts)}</div>`));
    if (S.lips?.url) result = S.lips.url; else if (S.tts?.state === 'completed') body.append(h(`<div>${stepLine('השפתיים', S.lips || { state: 'queued' })}</div>`));
  }
  if (result) {
    body.append(h(`<div class="tw-vid"><video src="${esc(link(result))}" controls playsinline preload="metadata"></video><p class="hint">מומלץ להוריד ולשמור. AI שנראה אמיתי מסמנים כ-AI כשמפרסמים ברשתות.</p></div>`));
    acts.append(h(`<a class="btn btn--line" href="${esc(link(result))}" download target="_blank" rel="noopener">להוריד את הסרטון</a>`));
    if (j.kind !== 'talk') {
      const say = h('<button type="button" class="btn btn--line">לתת לו לדבר בסרטון הזה</button>');
      say.addEventListener('click', () => {
        prefill = { video: result, secs: j.kind === 'scene' ? j.secs || 5 : j.secs || 10, label: j.title || KIND[j.kind] };
        tab = 'talk'; ctx.rerender(); window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      acts.append(say);
    }
  }
  const del = h('<button type="button" class="btn btn--line">למחוק מהרשימה</button>');
  del.addEventListener('click', async () => {
    if (!confirm('למחוק את העבודה מהרשימה? (מה שהורד למחשב נשאר)')) return;
    try { await api('DELETE', null, '?id=' + j.id); el.remove(); } catch (e) { fail(e); }
  });
  acts.append(del);
  return el;
}
function moveForm(j) {
  const row = h(`<div class="tw-step2">
    <fieldset class="tw-pre"><legend>מה הוא עושה</legend><div class="sm-chips" data-c></div></fieldset>
    <label class="f">או לכתוב <small>(באנגלית)</small><input name="m" maxlength="600" dir="auto" placeholder="He walks to the window and looks outside"></label>
    <label class="f">אורך<select name="secs"><option value="5">5 שניות</option><option value="10">10 שניות</option><option value="15">15 שניות</option></select></label>
    <label class="tw-check"><input type="checkbox" name="snd"> עם קולות רקע של המקום (בלי דיבור)</label>
    <button type="button" class="btn btn--gold">שלב 2: להזיז אותו</button><p class="hint tw-st"></p></div>`);
  const picked = chips(row, '[data-c]', MOVE), st = row.querySelector('.tw-st'), btn = row.querySelector('button');
  const cost = () => COST.move(Number(row.querySelector('[name=secs]').value), row.querySelector('[name=snd]').checked);
  const show = () => { st.textContent = `המחיר: כ-${usd(cost())}.`; };
  row.querySelectorAll('select,input[type=checkbox]').forEach(x => x.addEventListener('change', show)); show();
  btn.addEventListener('click', async () => {
    const parts = picked(), free = row.querySelector('[name=m]').value.trim();
    if (free) parts.push(free);
    if (!parts.length) { st.textContent = 'בוחרים מה הוא עושה, או כותבים.'; return; }
    if (!confirm(`להזיז אותו? זה עולה כ-${usd(cost())} מחשבון fal.`)) return;
    btn.disabled = true;
    try {
      await api('POST', { step: 'move', id: j.id, motion: parts.join(' '), secs: Number(row.querySelector('[name=secs]').value), sound: row.querySelector('[name=snd]').checked });
      ctx.toast('בעבודה. כמה דקות'); watch(j.id, 0);
    } catch (e) { fail(e); btn.disabled = false; }
  });
  return row;
}

/** Ask the server every 6 s while a step runs; redraw only that card. Stops when the page changes. */
function watch(id, wait = 6000) {
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(async () => {
    timers.delete(id);
    const card = document.querySelector(`.tw-job[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    try {
      const { job } = await api('GET', null, '?id=' + encodeURIComponent(id));
      card.replaceWith(jobCard(job));
      if (running(job)) watch(id);
    } catch (e) { /* quiet: next open of the page refreshes */ }
  }, wait));
}
function watchVoice() {
  clearTimeout(timers.get('voice'));
  timers.set('voice', setTimeout(async () => {
    timers.delete('voice');
    const box = document.querySelector('.tw-voice');
    if (!box) return;
    try {
      const r = await api('GET');
      data.voice = r.voice; box.replaceWith(voiceBox());
      if (live(r.voice?.step)) watchVoice(); else if (r.voice?.id) ctx.toast('הקול של אילן מוכן');
    } catch (e) { /* quiet */ }
  }, 6000));
}
