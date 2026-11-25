// The client's form (owner 25.11). The client tells us about the event; he sees only the questions, never our
// places or prices. Hebrew and French. Sent once; then the event card opens on our side (api/_intake.js).
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const qs = new URLSearchParams(location.search), id = qs.get('f') || '', tok = qs.get('t') || '';
  const T = {
    he: {
      dir: 'rtl', title: 'האירוע שלכם – La Belle Vie',
      h1: 'ספרו לנו על האירוע', lead: 'כמה שאלות קצרות, ואנחנו נחזור אליכם עם רעיונות שמתאימים בדיוק לכם.',
      who: 'הפרטים שלכם', name: 'שם מלא', phone: 'טלפון', email: 'מייל', opt: 'לא חובה',
      what: 'איזה אירוע?', kinds: { wedding: 'חתונה', barmitzvah: 'בר מצווה', batmitzvah: 'בת מצווה', shabbat: 'שבת חתן', brit: 'ברית', corporate: 'אירוע חברה', funday: 'יום כיף', gala: 'ערב גאלה', other: 'משהו אחר' },
      kindText: 'איזה אירוע?',
      when: 'מתי?', date: 'התאריך', flex: 'התאריך עוד לא סגור', dateNote: 'בערך מתי? (למשל: אביב 2027, אחרי פסח)',
      guests: 'כמה אורחים?', guestsL: 'מספר אורחים משוער',
      where: 'באיזה אזור?', areas: ['ירושלים והסביבה', 'תל אביב והמרכז', 'השרון', 'השפלה', 'הצפון', 'הדרום', 'ים המלח', 'אילת', 'פתוחים לרעיונות'], areaText: 'עיר או מקום מסוים (אם יש)',
      budget: 'תקציב', budgetL: 'תקציב משוער בשקלים', total: 'בסך הכול', perGuest: 'לאורח',
      needs: 'במה נעזור לכם?', needList: { venue: 'מקום לאירוע', hotel: 'מלון ולינה', fun: 'אטרקציות', artist: 'אמן או מוזיקה', all: 'הפקה מלאה מא׳ עד ת׳' }, many: 'אפשר לבחור כמה',
      notes: 'עוד משהו שחשוב לכם?', notesL: 'סגנון, חלומות, דברים שאסור שיחסרו',
      send: 'לשלוח', sending: 'שולח…',
      miss: 'חסרים עוד כמה פרטים: שם, תאריך (או בערך מתי) ומספר אורחים.', fail: 'משהו השתבש. נסו שוב בעוד רגע.',
      privacy: 'הפרטים נשארים אצלנו בלבד.',
      thanks: 'תודה, קיבלנו', thanksP: 'עוברים על הפרטים ונחזור אליכם בקרוב עם הצעה שמתאימה לכם.',
      done: 'הטופס הזה כבר נשלח. תודה! אם תרצו לשנות משהו, פשוט כתבו לנו.', gone: 'הקישור לא תקין. בקשו מאיתנו קישור חדש.',
    },
    fr: {
      dir: 'ltr', title: 'Votre événement – La Belle Vie',
      h1: 'Parlez-nous de votre événement', lead: 'Quelques questions rapides, et nous revenons vers vous avec des idées faites pour vous.',
      who: 'Vos coordonnées', name: 'Nom et prénom', phone: 'Téléphone', email: 'E-mail', opt: 'facultatif',
      what: 'Quel événement ?', kinds: { wedding: 'Mariage', barmitzvah: 'Bar-mitsva', batmitzvah: 'Bat-mitsva', shabbat: 'Chabbat Hatan', brit: 'Brit-mila', corporate: 'Événement d’entreprise', funday: 'Journée de détente', gala: 'Soirée de gala', other: 'Autre chose' },
      kindText: 'Quel événement ?',
      when: 'Quand ?', date: 'La date', flex: 'La date n’est pas encore fixée', dateNote: 'À peu près quand ? (par ex. printemps 2027, après Pessah)',
      guests: 'Combien d’invités ?', guestsL: 'Nombre d’invités estimé',
      where: 'Dans quelle région ?', areas: ['Jérusalem et environs', 'Tel-Aviv et le centre', 'Le Sharon', 'La Shéféla', 'Le Nord', 'Le Sud', 'La mer Morte', 'Eilat', 'Ouverts aux idées'], areaText: 'Une ville ou un lieu précis (si vous en avez un)',
      budget: 'Budget', budgetL: 'Budget estimé en shekels', total: 'au total', perGuest: 'par invité',
      needs: 'Comment pouvons-nous vous aider ?', needList: { venue: 'Un lieu de réception', hotel: 'Hôtel et hébergement', fun: 'Animations', artist: 'Artiste ou musique', all: 'Organisation clé en main' }, many: 'plusieurs choix possibles',
      notes: 'Autre chose d’important pour vous ?', notesL: 'Le style, vos envies, ce qui ne doit surtout pas manquer',
      send: 'Envoyer', sending: 'Envoi…',
      miss: 'Il manque encore quelques informations : nom, date (ou période) et nombre d’invités.', fail: 'Une erreur s’est produite. Réessayez dans un instant.',
      privacy: 'Vos informations restent chez nous.',
      thanks: 'Merci, c’est bien reçu', thanksP: 'Nous étudions votre demande et revenons très vite vers vous avec une proposition sur mesure.',
      done: 'Ce formulaire a déjà été envoyé. Merci ! Pour modifier quelque chose, écrivez-nous simplement.', gone: 'Ce lien n’est pas valide. Demandez-nous un nouveau lien.',
    },
  };
  // the Hebrew area names are what we keep (the manager reads Hebrew)
  const AREA_KEEP = T.he.areas;
  let lang = qs.get('lang') === 'fr' ? 'fr' : 'he', info = null, draft = {};
  const sheet = $('#sheet');
  const top = () => `<header class="top"><img src="../media/logo-events.png" alt="La Belle Vie" width="600" height="528">
    <div class="lang" role="group" aria-label="Langue / שפה"><button type="button" data-l="he" aria-pressed="${lang === 'he'}">עברית</button><button type="button" data-l="fr" aria-pressed="${lang === 'fr'}">Français</button></div></header>`;
  function setLang() { const t = T[lang]; document.documentElement.lang = lang; document.documentElement.dir = t.dir; document.title = t.title; }
  function bindLang() { sheet.querySelectorAll('[data-l]').forEach(b => b.addEventListener('click', () => { keep(); lang = b.dataset.l; draw(); })); }
  function keep() { const fm = sheet.querySelector('form'); if (fm) draft = read(fm); }
  function read(fm) {
    const d = new FormData(fm);
    return { name: d.get('name'), phone: d.get('phone'), email: d.get('email'), kind: d.get('kind') || '', kindText: d.get('kindText'),
      flex: !!d.get('flex'), date: d.get('flex') ? '' : d.get('date'), dateNote: d.get('flex') ? d.get('dateNote') : '', guests: d.get('guests'),
      area: d.get('area') || '', areaText: d.get('areaText'), budget: d.get('budget'), budgetPer: d.get('budgetPer') || 'total',
      needs: d.getAll('needs'), notes: d.get('notes') };
  }
  function draw() {
    setLang();
    const t = T[lang], v = { name: info.name, phone: info.phone, ...draft };
    const chip = (name, val, label, type = 'radio', on) => `<label class="chip"><input type="${type}" name="${name}" value="${esc(val)}" ${on ? 'checked' : ''}><span>${esc(label)}</span></label>`;
    sheet.innerHTML = top() + `<div class="intro"><h1>${t.h1}</h1><p>${t.lead}</p></div>
    <form novalidate>
      <fieldset><legend>${t.what}</legend><div class="chips">${Object.entries(t.kinds).map(([k, l]) => chip('kind', k, l, 'radio', v.kind === k)).join('')}</div>
        <label class="f more" data-kt ${v.kind === 'other' ? '' : 'hidden'}>${t.kindText}<input type="text" name="kindText" maxlength="80" value="${esc(v.kindText || '')}"></label></fieldset>
      <fieldset><legend>${t.when}</legend>
        <label class="f" data-d ${v.flex ? 'hidden' : ''}>${t.date}<input type="date" name="date" value="${esc(v.date || '')}"></label>
        <label class="check"><input type="checkbox" name="flex" ${v.flex ? 'checked' : ''}>${t.flex}</label>
        <label class="f more" data-dn ${v.flex ? '' : 'hidden'}>${t.dateNote}<input type="text" name="dateNote" maxlength="120" value="${esc(v.dateNote || '')}"></label></fieldset>
      <fieldset><legend>${t.guests}</legend><label class="f">${t.guestsL}<input type="number" name="guests" min="1" max="5000" inputmode="numeric" value="${esc(v.guests || '')}"></label></fieldset>
      <fieldset><legend>${t.where}</legend><div class="chips">${t.areas.map((l, i) => chip('area', AREA_KEEP[i], l, 'radio', v.area === AREA_KEEP[i])).join('')}</div>
        <label class="f more">${t.areaText}<input type="text" name="areaText" maxlength="120" value="${esc(v.areaText || '')}"></label></fieldset>
      <fieldset><legend>${t.budget}<small>${t.opt}</small></legend><div class="row">
        <label class="f">${t.budgetL}<input type="number" name="budget" min="0" inputmode="numeric" value="${esc(v.budget || '')}"></label>
        <div class="chips" style="align-self:end">${chip('budgetPer', 'total', t.total, 'radio', (v.budgetPer || 'total') === 'total')}${chip('budgetPer', 'guest', t.perGuest, 'radio', v.budgetPer === 'guest')}</div></div></fieldset>
      <fieldset><legend>${t.needs}<small>${t.many}</small></legend><div class="chips">${Object.entries(t.needList).map(([k, l]) => chip('needs', k, l, 'checkbox', (v.needs || []).includes(k))).join('')}</div></fieldset>
      <fieldset><legend>${t.notes}<small>${t.opt}</small></legend><label class="f">${t.notesL}<textarea name="notes" maxlength="2000">${esc(v.notes || '')}</textarea></label></fieldset>
      <fieldset><legend>${t.who}</legend><div class="row">
        <label class="f">${t.name}<input type="text" name="name" maxlength="120" autocomplete="name" value="${esc(v.name || '')}"></label>
        <label class="f">${t.phone}<input type="tel" name="phone" maxlength="40" autocomplete="tel" dir="ltr" value="${esc(v.phone || '')}"></label></div>
        <label class="f more">${t.email} <small>(${t.opt})</small><input type="email" name="email" maxlength="160" autocomplete="email" dir="ltr" value="${esc(v.email || '')}"></label></fieldset>
      <p class="err" role="alert" hidden></p>
      <button type="submit" class="send">${t.send}</button>
      <p class="note">${t.privacy}</p>
    </form>`;
    bindLang();
    const fm = sheet.querySelector('form');
    fm.addEventListener('change', e => {
      if (e.target.name === 'kind') fm.querySelector('[data-kt]').hidden = e.target.value !== 'other';
      if (e.target.name === 'flex') { fm.querySelector('[data-d]').hidden = e.target.checked; fm.querySelector('[data-dn]').hidden = !e.target.checked; }
    });
    fm.addEventListener('submit', async e => {
      e.preventDefault();
      const a = read(fm), err = fm.querySelector('.err'), btn = fm.querySelector('.send');
      if (!String(a.name || '').trim() || !(a.date || String(a.dateNote || '').trim()) || !(Number(a.guests) > 0)) { err.textContent = t.miss; err.hidden = false; return; }
      err.hidden = true; btn.disabled = true; btn.textContent = t.sending;
      try {
        const r = await fetch('/api/intake?f=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(tok), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers: a, lang }) });
        if (r.status === 409) { info.done = true; return thanks(true); }
        if (!r.ok) throw new Error(String(r.status));
        thanks();
      } catch (x) { err.textContent = t.fail; err.hidden = false; btn.disabled = false; btn.textContent = t.send; }
    });
  }
  function thanks(already) {
    setLang();
    const t = T[lang];
    sheet.innerHTML = top() + `<div class="thanks"><div class="seal" aria-hidden="true"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></div>
      <h1>${already ? t.thanks : t.thanks}</h1><p>${already ? t.done : t.thanksP}</p></div>`;
    sheet.querySelectorAll('[data-l]').forEach(b => b.addEventListener('click', () => { lang = b.dataset.l; thanks(already); }));
    scrollTo(0, 0);
  }
  (async () => {
    try {
      const r = await fetch('/api/intake?f=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(tok));
      if (!r.ok) throw new Error(String(r.status));
      info = await r.json();
      if (!qs.get('lang') && info.lang) lang = info.lang;
      if (info.done) thanks(true); else draw();
    } catch (e) { setLang(); sheet.innerHTML = `<p class="gone" style="color:var(--ink-2)">${T[lang].gone}</p>`; }
  })();
})();
