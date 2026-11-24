/**
 * LBV – סקר מלונות: the robot that runs in the LBV Google account (script.google.com).
 *
 * Every 5 minutes it:
 *   1. looks at the Drive folder the work phone uploads its call recordings to;
 *   2. takes only the recordings made while "survey mode" was on in the admin (others never leave Drive);
 *   3. lets Gemini listen: is this a call with a hotel? If so, the hotel's details, availability, prices,
 *      a short summary, the key sentences with their time in the call, and the full transcript;
 *   4. sends that to the site (/api/hotels), which adds it to the right hotel;
 *   5. sends the e-mails written in the admin, from this Gmail, and brings back the hotels' replies;
 *   6. keeps one Google Sheet per survey up to date;
 *   0. receives the recordings from the phone app "LBV שיחות" (doPost below) and keeps them in the Drive folder;
 *   8. reads pasted texts / price quotes and the hotels' e-mails (Gmail of LBV) and fills the hotel's details;
 *  10. looks a new hotel up on the web (site, photos, missing phone / e-mail);
 *   9. calls with a hotel's number join that hotel by themselves for 2 weeks around when it was added;
 *   7. tells the site which recordings exist on the phone (file name, number and time only, nothing is listened to),
 *      so "did I already talk to this number?" finds every call; a call is summarized only when the owner asks.
 *
 * Setup (once): Project Settings → Script properties:
 *   SITE        https://<the site>            (no slash at the end)
 *   LBV_KEY     the key from the admin (סקר מלונות → חיבור הטלפון)
 *   GEMINI_KEY  the Gemini API key   (GEMINI_KEY2, GEMINI_KEY3: optional free keys from other Google accounts, used when the first one is out of quota)
 *   FOLDER      the name of the Drive folder with the recordings (e.g. "הקלטות שיחות")
 * Then run  setup()  once and allow the permissions.
 * For the phone app: Deploy → New deployment → Web app, "Execute as: Me", "Who has access: Anyone".
 * getUrl() can report a dead address: put the deployment's /exec address in the script property APP_URL
 * (in the LBV account it is written straight into tick(), 18.11).
 * (Anyone can reach the address, but only the app has the secret; without it nothing is saved.)
 */

const MODEL = 'gemini-3.5-flash';
const PAD_BEFORE_MIN = 2;      // a recording that started up to 2 minutes before survey mode was switched on still counts
const PAD_AFTER_MIN = 3;       // ... or up to 3 minutes after it was switched off
const MAX_PER_RUN = 4;         // recordings per run (a run may last 6 minutes at most)

function props() { return PropertiesService.getScriptProperties(); }
function P(k) { return props().getProperty(k) || ''; }

function setup() {
  if (!P('APP_SECRET')) props().setProperty('APP_SECRET', Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, ''));
  if (!P('FOLDER')) props().setProperty('FOLDER', 'הקלטות שיחות');
  recFolder();
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  if (!P('SINCE')) props().setProperty('SINCE', new Date(Date.now() - 24 * 3600e3).toISOString());
  tick();
}

/* ---------- talking to the site ---------- */
function site(method, what, payload, extra) {
  const url = P('SITE') + '/api/hotels?script=' + what + (extra || '');
  const r = UrlFetchApp.fetch(url, {
    method: method, contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'X-LBV-Key': P('LBV_KEY') },
    payload: payload ? JSON.stringify(payload) : undefined,
  });
  if (r.getResponseCode() >= 300) throw new Error('site ' + what + ' ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText() || '{}');
}

/** Google stops a run after 6 minutes: long steps check the time and wait for the next run instead of being cut. */
let T0 = Date.now();
const elapsed = () => (Date.now() - T0) / 1000;
/** owner 24.11: what this run did, sent to the site at the end (the "מצב הרובוט" card). */
var HEALTH = { gem: { ok: 0, busy: 0, quota: 0 }, errors: [] };
function tick() {
  T0 = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  HEALTH = { gem: { ok: 0, busy: 0, quota: 0 }, errors: [] };
  try {
    const open = P('RUN_OPEN');
    if (open) site('post', 'health', { secs: 360, killed: true, gem: {}, errors: ['הריצה של ' + Utilities.formatDate(new Date(Number(open)), 'Asia/Jerusalem', 'HH:mm') + ' נעצרה על ידי גוגל אחרי 6 דקות, לפני שסיימה'] });
    props().setProperty('RUN_OPEN', String(Date.now()));
  } catch (e) {}
  const ce = console.error;
  try { console.error = function () { try { HEALTH.errors.push(Array.prototype.slice.call(arguments).map(String).join(' ').slice(0, 200)); } catch (e) {} return ce.apply(console, arguments); }; } catch (e) {}
  try {
    try { site('post', 'app', { url: P('APP_URL') || ScriptApp.getService().getUrl() || '', secret: P('APP_SECRET'), last: P('APP_LAST') }); } catch (e) { console.error('app', e); }
    const st = site('get', 'status');
    ILAN_OPEN = (st.ilan || {}).open || [];
    try { indexCalls(); } catch (e) { console.error('index', e); }   // owner 19.11: the list of calls first (quick), so a slow reading never hides new calls
    // owner 24.11: a mail check someone asked for with the button runs first (a Gmail search takes seconds), never after the slow Gemini work
    try { mailScans(Object.assign({}, st, { mailScan: (st.mailScan || []).filter(m => m.ask) })); } catch (e) { console.error('mailAsk', e); }
    try { phoneTexts(st); } catch (e) { console.error('phoneTexts', e); }   // owner 24.11: calls the phone transcribed itself
    try { ilanOld(st); } catch (e) { console.error('ilanOld', e); }   // owner 19.11: Ilan's calls first
    try { ilanMerge(st); } catch (e) { console.error('ilanMerge', e); }   // owner 24.11: the same request from several calls = one task (once)
    try { sortCalls(st); } catch (e) { console.error('sortCalls', e); }   // owner 24.11 (early, so a long run never skips it): who an unknown call is with
    try { photoChecks(st); } catch (e) { console.error('photoChecks', e); }   // owner 24.11 (early): only the place's own site and real photos of it
    try { recordings(st); } catch (e) { console.error('recordings', e); }
    try { relistens(st); } catch (e) { console.error('relistens', e); }   // early: it needs minutes
    try { answerAsks(st); } catch (e) { console.error('asks', e); }
    try { outbox(st); } catch (e) { console.error('outbox', e); }
    try { replies(st); } catch (e) { console.error('replies', e); }
    try { parses(st); } catch (e) { console.error('parses', e); }
    try { mailScans(Object.assign({}, st, { mailScan: (st.mailScan || []).filter(m => !m.ask) })); } catch (e) { console.error('mailScans', e); }
    try { webLooks(st); } catch (e) { console.error('webLooks', e); }
    try { funMails(st); } catch (e) { console.error('funMails', e); }   // owner 24.11: the attractions' mail (with the files) and WhatsApp, like the hotels
    try { funReads(st); } catch (e) { console.error('funReads', e); }
    try { sheets(st); } catch (e) { console.error('sheets', e); }
  } finally {
    try { console.error = ce; } catch (e) {}
    try { props().deleteProperty('RUN_OPEN'); } catch (e) {}
    try { site('post', 'health', { secs: Math.round(elapsed()), gem: HEALTH.gem, errors: HEALTH.errors.slice(-12) }); } catch (e) {}
    lock.releaseLock();
  }
}

/* ---------- 1–4: call recordings ---------- */
/** When the call was recorded: from the file name (…_251118_143022…, 20251118_143022, 2025-11-18 14-30-22) or the file's date. */
/** What the phone app wrote on the file: number, contact name, start time, length, direction. */
function meta(file) { try { return JSON.parse(file.getDescription() || '{}'); } catch (e) { return {}; } }
function phoneOf(file) { return meta(file).phone || phoneFromName(file.getName()); }
function recordedAt(file) {
  const md = meta(file);
  if (md.at) return new Date(md.at);
  const n = file.getName();
  let m = n.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[ _T-]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  m = n.match(/(?:^|\D)(\d{2})(\d{2})(\d{2})[ _-](\d{2})(\d{2})(\d{2})(?:\D|$)/);
  if (m) return new Date(2000 + +m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return file.getDateCreated();
}
function windowFor(st, t) {
  const ms = t.getTime();
  for (const w of st.windows || []) {
    const from = Date.parse(w.from) - PAD_BEFORE_MIN * 60e3;
    const to = w.to ? Date.parse(w.to) + PAD_AFTER_MIN * 60e3 : Date.now() + 60e3;
    if (ms >= from && ms <= to) return w;
  }
  return null;
}
function recordings(st) {
  const name = P('FOLDER');
  if (!name) return;
  const it = DriveApp.getFoldersByName(name);
  if (!it.hasNext()) return;
  const since = new Date(P('SINCE') || 0);
  const files = [];
  (function walk(folder) {
    const fi = folder.getFiles();
    while (fi.hasNext()) { const f = fi.next(); if (f.getDateCreated() > since && /audio|video|octet/.test(f.getMimeType())) files.push(f); }
    const sub = folder.getFolders();
    while (sub.hasNext()) walk(sub.next());
  })(it.next());
  files.sort((a, b) => a.getDateCreated() - b.getDateCreated());
  let done = 0;
  for (const f of files) {
    if (done >= MAX_PER_RUN) return;   // the rest next run (SINCE stays at the last one handled)
    const at = recordedAt(f);
    // owner 19.11: a call with Ilan → what he asks for + tasks (never a hotel)
    if (ilanFor(st, f, at)) {
      // a failed reading (no quota / busy) never blocks the other calls: ilanOld() tries it again from the list
      try { site('post', 'ilan', { at: at.toISOString(), file: { id: f.getId(), name: f.getName(), url: f.getUrl() }, result: listenIlan(f, at) }); } catch (e) { console.error('ilan ' + f.getName(), e); }
      done++;
      props().setProperty('SINCE', f.getDateCreated().toISOString());
      continue;
    }
    const w = windowFor(st, at) || watchFor(st, f, at);
    if (w) {
      const sv = (st.surveys || []).find(s => s.id === w.surveyId);
      if (sv) {
        const result = listen(f, sv, at);
        if (result && result.relevant) { result.hotel = result.hotel || {}; if (!result.hotel.phone) result.hotel.phone = phoneOf(f); }
        site('post', 'call', { surveyId: sv.id, at: at.toISOString(), file: { id: f.getId(), name: f.getName(), url: f.getUrl() }, result: result });
        done++;
      }
    }
    props().setProperty('SINCE', f.getDateCreated().toISOString());
  }
}

/* ---------- 7: the list of all calls on the phone (names only) + summaries on request ---------- */
function allRecordings(since) {
  const it = DriveApp.getFoldersByName(P('FOLDER'));
  if (!P('FOLDER') || !it.hasNext()) return [];
  const files = [];
  (function walk(folder) {
    const fi = folder.getFiles();
    while (fi.hasNext()) { const f = fi.next(); if (f.getDateCreated() > since && /audio|video|octet/.test(f.getMimeType())) files.push(f); }
    const sub = folder.getFolders();
    while (sub.hasNext()) walk(sub.next());
  })(it.next());
  return files.sort((a, b) => a.getDateCreated() - b.getDateCreated());
}
function indexCalls() {
  // first run: the last 6 months; then only new files
  const since = new Date(P('INDEX_SINCE') || Date.now() - 183 * 864e5);
  const files = allRecordings(since).slice(0, 600);
  for (let i = 0; i < files.length; i += 200) {
    const part = files.slice(i, i + 200);
    site('post', 'index', { items: part.map(f => ({ id: f.getId(), name: (meta(f).contact ? meta(f).contact + ' · ' : '') + f.getName(), phone: phoneOf(f), at: recordedAt(f).toISOString(), url: f.getUrl() })) });
    props().setProperty('INDEX_SINCE', part[part.length - 1].getDateCreated().toISOString());
  }
  if (!files.length && !P('INDEX_SINCE')) { site('post', 'index', { items: [] }); props().setProperty('INDEX_SINCE', since.toISOString()); }
}
function answerAsks(st) {
  for (const a of st.asks || []) {
    let result;
    try {
      const f = DriveApp.getFileById(a.id);
      result = listen(f, null, recordedAt(f), a.q);
    } catch (e) { result = { error: String(e).slice(0, 280) }; }
    site('post', 'answer', { id: a.id, result: result });
  }
}

/** A phone number inside the file name (e.g. "Call 0501234567_261118_101500.m4a"), not the date digits. */
function phoneFromName(n) {
  const m = n.replace(/[_ ]\d{6}[_ -]\d{6}/, ' ').match(/(\+?972[\d\- ]{8,12}|0\d[\d\- ]{7,10})/);
  return m ? m[1].replace(/[\s-]/g, '') : '';
}

/* ---------- Gemini ---------- */
function listen(file, sv, at, question) {
  let part = file.textPart;   // owner 24.11: the phone transcribed the call itself → only its text comes here
  if (!part) {
  const blob = file.getBlob();
  let mime = blob.getContentType() || 'audio/mp4';
  if (/octet/.test(mime)) mime = /\.amr$/i.test(file.getName()) ? 'audio/amr' : /\.mp3$/i.test(file.getName()) ? 'audio/mpeg' : /\.wav$/i.test(file.getName()) ? 'audio/wav' : 'audio/mp4';
  if (blob.getBytes().length < 14 * 1024 * 1024) part = { inline_data: { mime_type: mime, data: Utilities.base64Encode(blob.getBytes()) } };
  else part = { big: { blob: blob, mime: mime, name: file.getName() } };   // uploaded per key inside gemini()
  }

  if (!sv) return gemini(part, [
    'This is a recording of a phone call made from the work phone of La Belle Vie (in Hebrew: לה בל וי), an Israeli events and holiday company.',
    'The owner asked for a summary of this call, to remember what was said (for example what a hotel said about availability or prices).',
    'The recording file name (may contain the phone number or contact name): ' + file.getName() + (file.getDescription() ? '. From the phone call log: ' + file.getDescription() : ''),
    'The call was recorded on ' + Utilities.formatDate(at || new Date(), 'Asia/Jerusalem', 'EEEE yyyy-MM-dd HH:mm') + ' (Israel time).',
    'Answer in JSON only, in Hebrew. summary: what the call was about and everything decided or said that matters (availability, prices, conditions, promises, what to do next). who: who the other side is (name, place) if said.',
    'keyQuotes: the sentences that matter as proof later, the exact words spoken, with the time in the recording (mm:ss) and who said it.',
    'transcript: the whole conversation, each turn on its own line, "mm:ss <speaker>:". duration: mm:ss.',
    question ? 'The owner is looking for this in the call: "' + question + '". found = true only if it was really talked about. answer: in Hebrew, exactly what was said about it (numbers, dates, names as said), or that it was not talked about. answerQuotes: the exact sentences about it, with the time (mm:ss) and who said it.' : '',
  ].join('\n'), { type: 'OBJECT', properties: { summary: { type: 'STRING' }, who: { type: 'STRING' }, duration: { type: 'STRING' }, found: { type: 'BOOLEAN' }, answer: { type: 'STRING' },
    answerQuotes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { time: { type: 'STRING' }, speaker: { type: 'STRING' }, text: { type: 'STRING' } } } },
    keyQuotes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { time: { type: 'STRING' }, speaker: { type: 'STRING' }, text: { type: 'STRING' } } } }, transcript: { type: 'STRING' } }, required: ['summary'] });

  const known = (sv.hotels || []).filter(h => h.name).map(h => h.name + (h.phone ? ' (' + h.phone + ')' : '')).join('; ');
  const prompt = [
    'This is a recording of a phone call made from the work phone of La Belle Vie, an Israeli events and holiday company.',
    'The caller is surveying hotels (or guest houses / venues) for availability and prices, mostly for a Shabbat chatan (שבת חתן), family events and holidays: rooms, a hall or dining room for the meals, Shabbat meals, kiddush, kashrut, and price per person / per room / per Shabbat.',
    'Survey: "' + sv.title + '". Dates needed: ' + (sv.from || '?') + ' to ' + (sv.to || '?') + '. What is needed: ' + (sv.need || '-') + '. Area: ' + (sv.area || '-') + '.',
    'Price levels used in this survey: ' + (sv.levels || []).join(', ') + '. Use one of these names for "level" when it fits, otherwise the hotel\'s own room name.',
    'Hotels already in the survey: ' + (known || 'none') + '. If this call is with one of them, use exactly the same name.',
    'The recording file name (may contain the phone number or contact name): ' + file.getName() + (file.getDescription() ? '. From the phone call log: ' + file.getDescription() : ''),
    'The call was recorded on ' + Utilities.formatDate(at || new Date(), 'Asia/Jerusalem', 'EEEE yyyy-MM-dd HH:mm') + ' (Israel time). Turn relative days ("ביום ראשון", "מחר", "בעוד שבוע") into a date.',
    'The company is written "La Belle Vie" (in Hebrew: לה בל וי).',
    '',
    'Answer in JSON only. Write summary, availability text, notes and quotes in Hebrew (quotes: the exact words spoken, in the language spoken).',
    'relevant = true only if the call is about hotel rooms / accommodation / a venue, hall or meals for an event (Shabbat chatan, bar mitzvah, family event, holiday): availability, conditions or prices. A private or unrelated call → relevant=false and leave everything else empty.',
    'availability.text: rooms AND the hall/meals if mentioned (e.g. "12 חדרים פנויים, אולם לשבת פנוי, אין מניין במלון"). Put kashrut, minimum rooms/guests and other conditions in prices[].note or the summary.',
    'keyQuotes: the sentences that matter as proof later — especially anything said about availability ("we are full", "there are rooms"), prices, conditions, promises — with the time in the recording (mm:ss) and who said it (הנציג / המלון).',
    'prices: one row per room type + board, or per event package (e.g. level "חבילת שבת" / "אולם" / "סעודת שבת"), the number only in price (no currency sign), per = per what (לזוג ללילה / לאדם לשבת / לחדר לכל השבת / לאורח ...).',
    'followUp: needed = true whenever something is still open after the call: the place said it will check / call back / send an offer or prices, or we have to call back / send something. date = YYYY-MM-DD only if a day was said. what (Hebrew, short) = what is still open (e.g. "אמרו שיבדקו זמינות ל-25.3 ויחזרו אלינו"). needed = false only if nothing is left open.',
    'transcript: the whole conversation, each turn on its own line (separated by a newline), "mm:ss הנציג:" / "mm:ss המלון:".',
    'duration: how long the call is, mm:ss.',
    '',
    'BE EXACT. Listen to the whole recording before answering. Write numbers, prices, dates and names exactly as they were said; never round, guess or fill in. If a word or number is not clear, write (לא ברור) in the transcript instead of guessing.',
    'SEVERAL PLACES: a call can talk about more than one hotel / venue (a representative of a chain talking about two of its hotels, or an internal La Belle Vie team call comparing options). Then fill places[] with ONE entry per place, each with ONLY what was said about that place: its own name (the real name, never two names joined like "X / Y"), city, phone if said, availability and prices. Never move a price or a condition from one place to another. If it is not clear which place a detail belongs to, do not put it under any place: say so in the summary. hotel = the place the call is mostly about (or the first one). With only one place, leave places empty.',
  ].join('\n');

  const schema = hotelSchema();
  const res = gemini(part, prompt, schema);
  // second, careful pass on the written conversation: every place that was talked about, each with only its own details
  try {
    if (res && res.relevant && !((res.places || []).length >= 2) && String(res.transcript || '').length > 200) {
      const pl = gemini({ text: 'Conversation (Hebrew, from a phone call of La Belle Vie, an Israeli events company, about hotels / venues for: ' + (sv.need || sv.title) + '):\n\n' + String(res.transcript).slice(0, 30000) + '\n\nSummary: ' + (res.summary || '') }, [
        'List EVERY hotel / venue / place to stay that was talked about in this conversation, as places[]. One entry per place, with ONLY what was said about that place: name (its real name as said, never two places joined), city / area, phone if said, availability (status + text + rooms) and prices.',
        'prices: one row per room type / package, the number only (exactly as said, never rounded or guessed), currency, per = per what (לחדר לשבת / לחדר ללילה / לאדם ...), level from: ' + (sv.levels || []).join(', ') + ' when it fits.',
        'If a number or detail is not clearly about one place, leave it out. Places only mentioned in passing with no detail: include with name only. Write in Hebrew.',
      ].join('\n'), { type: 'OBJECT', properties: { places: schema.properties.places } });
      if (pl && (pl.places || []).length >= 2) res.places = pl.places;
    }
  } catch (e) { console.error('places pass', e); }
  return res;
}

/** A call with one of Ilan's numbers (the owner saved them in the "אילן" tab), made after they were saved (less a week). */
function ilanFor(st, f, at) {
  const il = st.ilan || {};
  if (!(il.phones || []).length) return false;
  const d = String(phoneOf(f) || '').replace(/\D/g, '').replace(/^972/, '0').slice(-9);
  return d.length >= 8 && il.phones.indexOf(d) >= 0 && (!il.since || at.getTime() >= Date.parse(il.since));
}
/** Calls with Ilan that were already in the folder before his number was saved (the site lists them): read them too. */
function ilanOld(st) {
  for (const x of ((st.ilan || {}).files || [])) {
    if (elapsed() > 120) return;
    try {
      const f = DriveApp.getFileById(x.id);
      const at = recordedAt(f);
      site('post', 'ilan', { at: at.toISOString(), file: { id: f.getId(), name: f.getName(), url: f.getUrl() }, result: listenIlan(f, at) });
    } catch (e) { console.error('ilanOld ' + x.id, e); }
  }
}
function listenIlan(file, at) {
  let part = file.textPart;
  if (!part) {
  const blob = file.getBlob();
  let mime = blob.getContentType() || 'audio/mp4';
  if (/octet/.test(mime)) mime = /\.amr$/i.test(file.getName()) ? 'audio/amr' : /\.mp3$/i.test(file.getName()) ? 'audio/mpeg' : /\.wav$/i.test(file.getName()) ? 'audio/wav' : 'audio/mp4';
  part = blob.getBytes().length < 14 * 1024 * 1024 ? { inline_data: { mime_type: mime, data: Utilities.base64Encode(blob.getBytes()) } } : { big: { blob: blob, mime: mime, name: file.getName() } };
  }
  const Q = { type: 'OBJECT', properties: { time: { type: 'STRING' }, speaker: { type: 'STRING' }, text: { type: 'STRING' } } };
  return gemini(part, [
    'This is a recording of a phone call between the owner of the work phone of La Belle Vie (in Hebrew: לה בל וי), an Israeli events company, and Ilan (אילן).',
    'The owner wants to know exactly what Ilan wants and never forget anything he asked for.',
    'The call was recorded on ' + Utilities.formatDate(at || new Date(), 'Asia/Jerusalem', 'EEEE yyyy-MM-dd HH:mm') + ' (Israel time). Turn relative days ("מחר", "ביום ראשון", "עד סוף השבוע") into a date.',
    'Answer in JSON only, in Hebrew, in plain everyday words.',
    'summary: what the call was about, in 2-4 short sentences.',
    'wants: what Ilan wants, one short line each (his goals and wishes, also ones that are not a concrete task).',
    'tasks: every concrete thing Ilan asked the owner to do, and every thing the owner promised him to do in this call. One task each, starting with a verb ("לשלוח ל...", "לבדוק...", "להתקשר ל..."), with every detail that was said (names, numbers, places, amounts). due: YYYY-MM-DD only if a day was said or clearly meant, otherwise empty. when: the deadline as it was said, if any. quote: the exact words in the recording where it was asked.',
    'Do not invent tasks. Only what was really said. If a word or number is not clear, write (לא ברור).',
    ILAN_OPEN.length ? 'The owner already has these open tasks from earlier calls with Ilan (id: task):\n' + ILAN_OPEN.map(function (t) { return t.id + ': ' + t.text; }).join('\n') + '\nIf a task in this call is the same request as one of them (also in other words, or a reminder of it), still list it, and put that id in same. Otherwise leave same empty.' : '',
    'keyQuotes: the sentences that matter most, the exact words, with the time (mm:ss) and who said it (אילן / אני).',
    'transcript: the whole conversation, each turn on its own line, "mm:ss אילן:" / "mm:ss אני:". duration: mm:ss.',
  ].join('\n'), { type: 'OBJECT', properties: {
    summary: { type: 'STRING' }, wants: { type: 'ARRAY', items: { type: 'STRING' } },
    tasks: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, due: { type: 'STRING' }, when: { type: 'STRING' }, quote: { type: 'STRING' }, same: { type: 'STRING' } }, required: ['text'] } },
    keyQuotes: { type: 'ARRAY', items: Q }, transcript: { type: 'STRING' }, duration: { type: 'STRING' } }, required: ['summary', 'tasks'] });
}

var ILAN_OPEN = [];
/** What an attraction wrote (mail with its files, or WhatsApp): the offer, prices, dates, and the details for the catalog. */
function readFun(text, files, name, src) {
  const parts = [];
  let extra = '';
  for (const f of (files || []).slice(0, 4)) {
    if ((/pdf/.test(f.mime) || /\.pdf$/i.test(f.name)) && f.size < 15 * 1024 * 1024) parts.push({ inline_data: { mime_type: 'application/pdf', data: Utilities.base64Encode(f.blob.getBytes()) } });
    else if (/^image\//.test(f.mime) && f.size < 8 * 1024 * 1024 && !/heic/.test(f.mime)) parts.push({ inline_data: { mime_type: f.mime, data: Utilities.base64Encode(f.blob.getBytes()) } });
    else if (/word|officedocument|excel|spreadsheet|msword/.test(f.mime) || /\.(docx|xlsx)$/i.test(f.name)) { const t = officeText(f.blob, f.name); if (t) extra += '\n\n==== The file "' + f.name + '" ====\n' + t; }
    else if (/text\//.test(f.mime)) extra += '\n\n==== The file "' + f.name + '" ====\n' + f.blob.getDataAsString('UTF-8').slice(0, 20000);
  }
  const prompt = [
    'These are ' + (src === 'wa' ? 'WhatsApp messages' : 'e-mails (with the attached files: read them completely, they usually hold the prices)') + ' between La Belle Vie (לה בל וי, an Israeli events company) and an attraction / activity for groups: "' + name + '".',
    'Today is ' + Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'EEEE yyyy-MM-dd') + ' (Israel).',
    'relevant = true only if they talk about this attraction: an offer, prices, dates, availability, group size, conditions.',
    'summary (Hebrew): start with what was sent (e.g. "הצעת מחיר בקובץ PDF:"), then the main points: what is included, prices, for how many people, dates, conditions, and what must still be answered.',
    'attraction: kind (show / workshop / sport / team / food / tour / kids / party / other), area, supplier, price (the main price, a number), per (person / group / hour / event), minP / maxP, hours, kids, email (of the attraction), dates (as written), priceText (the offer in words, as written). Only what is really written.',
    'Answer JSON only.', '', String(text).slice(0, 30000) + extra,
  ].join('\n');
  const r = genWeb({ contents: [{ role: 'user', parts: parts.concat([{ text: prompt }]) }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1, responseSchema: { type: 'OBJECT', properties: {
    relevant: { type: 'BOOLEAN' }, summary: { type: 'STRING' },
    attraction: { type: 'OBJECT', properties: { kind: { type: 'STRING' }, area: { type: 'STRING' }, supplier: { type: 'STRING' }, price: { type: 'NUMBER' }, per: { type: 'STRING' }, minP: { type: 'NUMBER' }, maxP: { type: 'NUMBER' }, hours: { type: 'STRING' }, kids: { type: 'BOOLEAN' }, email: { type: 'STRING' }, dates: { type: 'ARRAY', items: { type: 'STRING' } }, priceText: { type: 'STRING' } } } }, required: ['relevant', 'summary'] } } });
  if (r.code >= 300) throw new Error('gemini ' + r.code + ' ' + String(r.body).slice(0, 300));
  const j = JSON.parse(r.body);
  return JSON.parse((((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(p => p.text || '').join(''));
}
/** owner 24.11: every attraction's mail, every 4 hours (by its address, else by its name / number), the files read too. */
function funMails(st) {
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  for (const m of (st.funMail || [])) {
    if (elapsed() > 220) return;
    try {
      const nm = String(m.name || '').replace(/["()]/g, ' ').trim();
      const q = m.email ? '(from:' + m.email + ' OR to:' + m.email + ')' : '(' + [nm.length >= 4 ? '"' + nm + '"' : '', String(m.phone || '').length >= 8 ? '"' + m.phone + '"' : ''].filter(Boolean).join(' OR ') + ')';
      if (q === '()') { site('post', 'funmailscan', { id: m.id, msgIds: [] }); continue; }
      const threads = GmailApp.search(q + ' newer_than:365d' + (m.email ? '' : ' -category:promotions -category:social'), 0, 6);
      const seen = {}; (m.seen || []).forEach(id => { seen[id] = 1; });
      const ids = [], incoming = [], files = [], senders = {};
      let last = null;
      for (const t of threads) for (const msg of t.getMessages()) {
        if (seen[msg.getId()]) continue;
        ids.push(msg.getId());
        const out = msg.getFrom().toLowerCase().indexOf(me) >= 0;
        const body = msg.getPlainBody();
        if (!m.email && !((nm.length >= 4 && (msg.getSubject() + ' ' + body).indexOf(nm) >= 0) || (String(m.phone || '').length >= 8 && body.replace(/\D/g, '').indexOf(String(m.phone).slice(-8)) >= 0))) continue;
        if (out || /noreply|no-reply|newsletter|mailer-daemon/i.test(msg.getFrom())) continue;
        const fl = mailFiles(msg);
        files.push.apply(files, fl);
        const fm = (msg.getFrom().match(/[^\s<>"]+@[^\s<>"]+/) || [''])[0].toLowerCase(); if (fm) senders[fm] = (senders[fm] || 0) + 1;
        incoming.push('From: ' + msg.getFrom() + '\nDate: ' + msg.getDate().toISOString() + '\nSubject: ' + msg.getSubject() + (fl.length ? '\nAttached files: ' + fl.map(f => f.name).join(', ') : '') + '\n' + body.slice(0, 6000));
        last = msg;
      }
      if (incoming.length) {
        const r = readFun(incoming.slice(-6).join('\n\n----\n\n'), files.slice(-6), m.name, 'mail');
        site('post', 'funread', { id: m.id, src: 'mail', at: last.getDate().toISOString(), from: last.getFrom(), files: files.map(f => ({ name: f.name, url: f.url })), result: r });
      }
      const top = Object.keys(senders).sort((a, b) => senders[b] - senders[a])[0] || '';
      site('post', 'funmailscan', { id: m.id, msgIds: ids, email: m.email ? '' : top });
    } catch (e) { console.error('funMail ' + m.id, e); }
  }
}
/** owner 24.11: WhatsApp messages from an attraction's number (from the phone's notifications): read like the mail. */
function funReads(st) {
  for (const x of (st.funRead || [])) {
    if (elapsed() > 220) return;
    try { site('post', 'funread', { id: x.id, src: 'wa', at: new Date().toISOString(), result: readFun(x.text, [], x.name, 'wa') }); } catch (e) { console.error('funRead ' + x.id, e); }
  }
}
/** owner 24.11: once, the open Ilan tasks that are the same request (he said it in several calls) are grouped; the site keeps the first and adds the other calls to it. */
function ilanMerge(st) {
  const il = st.ilan || {};
  if (!il.merge || elapsed() > 150) return;
  const open = il.open || [];
  const r = gemini({ text: open.map(function (t) { return t.id + ': ' + t.text; }).join('\n') },
    'These are open tasks the owner got from Ilan in phone calls (id: task, in Hebrew). Ilan often repeats the same request in several calls, in other words, or asks again to go on with it. Group the tasks that are the same request: the same thing to do on the same subject, also when one says "go on" / "again" / "urgently" (e.g. "לחפש מקום לשבת" and "להמשיך לחפש אפשרויות לשבת חתן"; "לפרסם בסטטוס קישור לאינסטגרם" and "לנסח הודעה לקישור האינסטגרם לסטטוס"). Tasks about a different place, person or event stay apart (checking hotel A and checking hotel B are two tasks). Answer JSON: groups = lists of ids, each list with 2 or more ids. No group if none.',
    { type: 'OBJECT', properties: { groups: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'STRING' } } } }, required: ['groups'] });
  site('post', 'ilanmerge', { groups: (r.groups || []).filter(function (g) { return g && g.length > 1; }) });
}

/** owner 24.11: a call from a number nobody knows: listen, say who it is (client / supplier / attraction / hotel / artist / team / private),
 *  and for an attraction: what it is, where, the price, the dates, so it goes into the attractions catalog by itself. */
function sortCalls(st) {
  for (const x of (st.sortCalls || [])) {
    if (elapsed() > 200) return;
    let part;
    try {
      if (x.local && x.text) part = { text: 'This call was transcribed automatically on the phone (it can have mistakes).\n\n' + String(x.text).slice(0, 60000) };
      else {
        const file = DriveApp.getFileById(x.id), blob = file.getBlob();
        let mime = blob.getContentType() || 'audio/mp4';
        if (/octet/.test(mime)) mime = /\.amr$/i.test(file.getName()) ? 'audio/amr' : /\.mp3$/i.test(file.getName()) ? 'audio/mpeg' : /\.wav$/i.test(file.getName()) ? 'audio/wav' : 'audio/mp4';
        part = blob.getBytes().length < 14 * 1024 * 1024 ? { inline_data: { mime_type: mime, data: Utilities.base64Encode(blob.getBytes()) } } : { big: { blob: blob, mime: mime, name: file.getName() } };
      }
      const r = gemini(part, [
        'This is a phone call on the work phone of La Belle Vie (לה בל וי), an Israeli company that produces events: weddings, bar mitzvas, galas, fun days (ימי כיף) for groups, and holidays in hotels.',
        'The file name / contact: "' + String(x.name || '') + '". The call was on ' + String(x.at || '') + '.',
        'Our own people (La Belle Vie): Ilan (אילן) and Maayan (מעיין, works for us and calls places for our clients), and whoever answers this work phone. Our side of the call is always one of us. The other side is never one of them: never write their names in who.',
        'The most common call: one of us calls (or calls back) a hotel, a hall (אולם), an events garden or a villa to ask about a date, availability, rooms, prices, the minimum number of guests, for an event of one of our clients. Then the other side is the PLACE: cat = hotel (also for a hall / events garden / villa), even if the place only says it will check and call back, even if a client and a wedding are talked about.',
        (st.sortExamples || []).length ? 'Calls the owner already sorted by hand (learn from them, the owner is always right): ' + st.sortExamples.map(function (e) { return '[' + e.cat + (e.who ? ', ' + e.who : '') + '] ' + e.summary; }).join(' | ') : '',
        'Say who the other side is, from what was said (never guess from nothing):',
        'cat: client (only someone who asks US for an event or a quote for himself: not a place we called about a client), supplier (sells us a service that is not the place of the event: sound, catering, flowers, transport, music...), attraction (an attraction or activity for groups / fun days: a show, a workshop, a tour, sport, an escape room, a park...), hotel (a hotel, a hall, an events garden, a villa: a place where an event or a stay happens), artist (a singer / band / performer or their manager), team (only a person who works for La Belle Vie, not a person at a place we called), private (a personal call, not about work), other (cannot tell).',
        'who: the name of the other side\'s business as said (e.g. "אולם הגן", "מלון רמדה"), else the person\'s name with the place if said; empty if no name of the other side was said (never one of our names, never a word that is not a name). sub: what they are in 2-5 words (e.g. "אולם אירועים", "מלון"). sure: true only if who the other side is (its kind and its name) is clear from the call.',
        'summary: what the call was about, 2-3 short sentences in Hebrew, with the numbers, dates and prices that were said.',
        'If cat is attraction: attraction = name (of the attraction), kind (show / workshop / sport / team / food / tour / kids / party / other), area (city or region), supplier, price (a number, the main price said), per (person / group / hour / event), minP / maxP (group size), hours (how long), kids (true/false if said), dates (the dates or days that were said, as said), priceText (the price / the offer in words, exactly as said). Only what was really said.',
        'Answer JSON only.',
      ].join('\n'), { type: 'OBJECT', properties: {
        cat: { type: 'STRING', enum: ['client', 'supplier', 'attraction', 'hotel', 'artist', 'team', 'private', 'other'] }, who: { type: 'STRING' }, sub: { type: 'STRING' }, sure: { type: 'BOOLEAN' }, summary: { type: 'STRING' },
        attraction: { type: 'OBJECT', properties: { name: { type: 'STRING' }, kind: { type: 'STRING' }, area: { type: 'STRING' }, supplier: { type: 'STRING' }, price: { type: 'NUMBER' }, per: { type: 'STRING' }, minP: { type: 'NUMBER' }, maxP: { type: 'NUMBER' }, hours: { type: 'STRING' }, kids: { type: 'BOOLEAN' }, dates: { type: 'ARRAY', items: { type: 'STRING' } }, priceText: { type: 'STRING' } } } }, required: ['cat', 'summary'] });
      site('post', 'sorted', { id: x.id, phone: x.phone || '', result: r });
    } catch (e) {
      console.error('sortCalls ' + x.id, e);
      try { site('post', 'sorted', { id: x.id, error: String(e).slice(0, 200) }); } catch (e2) {}
    }
  }
}

/** "לקרוא את השיחה מחדש": the hotel's calls read again with today's rules; the answer replaces the old reading. */
function relistens(st) {
  for (const j of (st.relisten || []).slice(0, 1)) {
    if (elapsed() > 90) return;   // reading a call takes minutes: start it only early in the run
    const sv = surveyOf(st, j.surveyId);
    // counted before it starts: a run cut by the time limit still counts, so it can never block the robot (3 tries)
    const go = site('post', 'relistenFail', { surveyId: j.surveyId, hotelId: j.hotelId, error: 'לא הסתיים בזמן' });
    if (go && go.stop) continue;
    try {
      if (!sv) throw new Error('survey');
      for (const c of j.files) {
        const f = DriveApp.getFileById(c.id);
        const at = c.at ? new Date(c.at) : recordedAt(f);
        const result = listen(f, sv, at);
        if (result && result.relevant) { result.hotel = result.hotel || {}; if (!result.hotel.phone) result.hotel.phone = phoneOf(f); }
        site('post', 'call', { surveyId: sv.id, at: at.toISOString(), file: { id: f.getId(), name: f.getName(), url: f.getUrl() }, result: result, replace: j.hotelId });
      }
    } catch (e) { console.error('relisten', e); }
  }
}

function hotelSchema() {
  return {
    type: 'OBJECT',
    properties: {
      relevant: { type: 'BOOLEAN' },
      hotel: { type: 'OBJECT', properties: { name: { type: 'STRING' }, city: { type: 'STRING' }, contact: { type: 'STRING' }, phone: { type: 'STRING' }, email: { type: 'STRING' }, website: { type: 'STRING' } } },
      availability: { type: 'OBJECT', properties: { status: { type: 'STRING', enum: ['unknown', 'available', 'partial', 'full'] }, text: { type: 'STRING' }, rooms: { type: 'STRING' } } },
      prices: { type: 'ARRAY', items: { type: 'OBJECT', properties: { level: { type: 'STRING' }, board: { type: 'STRING' }, price: { type: 'NUMBER' }, currency: { type: 'STRING', enum: ['ILS', 'EUR', 'USD'] }, per: { type: 'STRING' }, note: { type: 'STRING' } } } },
      followUp: { type: 'OBJECT', properties: { needed: { type: 'BOOLEAN' }, date: { type: 'STRING' }, what: { type: 'STRING' } } },
      places: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
        name: { type: 'STRING' }, city: { type: 'STRING' }, phone: { type: 'STRING' }, note: { type: 'STRING' },
        availability: { type: 'OBJECT', properties: { status: { type: 'STRING', enum: ['unknown', 'available', 'partial', 'full'] }, text: { type: 'STRING' }, rooms: { type: 'STRING' } } },
        prices: { type: 'ARRAY', items: { type: 'OBJECT', properties: { level: { type: 'STRING' }, board: { type: 'STRING' }, price: { type: 'NUMBER' }, currency: { type: 'STRING', enum: ['ILS', 'EUR', 'USD'] }, per: { type: 'STRING' }, note: { type: 'STRING' } } } } } } },
      summary: { type: 'STRING' },
      duration: { type: 'STRING' },
      keyQuotes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { time: { type: 'STRING' }, speaker: { type: 'STRING' }, text: { type: 'STRING' } } } },
      transcript: { type: 'STRING' },
    },
    required: ['relevant'],
  };
}

/** Pasted text, a quote or hotel e-mails → the same details as a call (prices, rooms, availability, conditions). */
function readText(text, sv, hotelName, src) {
  const prompt = [
    'This is ' + (src === 'mail' ? 'an e-mail exchange between La Belle Vie (לה בל וי, an Israeli events and holiday company) and a hotel / venue' : 'a text La Belle Vie (לה בל וי, an Israeli events and holiday company) pasted about a hotel / venue: a price quote, a message, notes'),
    'The hotel in La Belle Vie\'s list: "' + (hotelName || '') + '". Survey: "' + (sv ? sv.title : '') + '". Dates needed: ' + (sv ? (sv.from || '?') + ' to ' + (sv.to || '?') : '?') + '. What is needed: ' + (sv ? sv.need || '-' : '-') + '.',
    'Price levels used in this survey: ' + ((sv && sv.levels) || []).join(', ') + '. Use one of these names for "level" when it fits, otherwise the hotel\'s own room name.',
    'Today is ' + Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'EEEE yyyy-MM-dd') + ' (Israel). Turn relative days into a date.',
    'Answer in JSON only. Write summary, availability text and notes in Hebrew. relevant = true if the text is about rooms, a hall, meals, availability, prices or conditions.',
    'availability: rooms AND hall/meals if mentioned; rooms = how many rooms. prices: one row per room type + board or per package, the number only in price, per = per what. Hours (check-in, check-out, meal times) and conditions go into prices[].note or the summary.',
    'hotel: name, city, contact person, phone, email, website if written. followUp: whether something has to be sent / answered, by when and what.',
    'keyQuotes: the sentences that matter as proof later, the exact words written, speaker = who wrote them.',
    '',
    String(text).slice(0, 30000),
  ].join('\n');
  return gemini({ text: prompt }, 'Read the text above and answer.', hotelSchema());
}
function surveyOf(st, id) { return (st.surveys || []).find(x => x.id === id) || null; }
/** "הדבקת טקסט" in the admin: read it and fill the hotel. */
function parses(st) {
  for (const p of (st.parses || []).slice(0, 3)) {
    let result, error = '';
    try { result = readText(p.text, surveyOf(st, p.surveyId), p.name, 'paste'); } catch (e) { error = String(e).slice(0, 280); }
    site('post', 'parsed', { surveyId: p.surveyId, hotelId: p.hotelId, id: p.id, src: p.src || 'paste', result: result || null, error: error });
  }
}
/** A hotel got an e-mail address: bring every mail with it (last 6 months) into its history and read the details from them. */
function mailScans(st) {
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  for (const m of (st.mailScan || []).slice(0, 3)) {
    try {
      const nm = String(m.name || '').replace(/["()]/g, ' ').trim();
      const q = m.email ? '(from:' + m.email + ' OR to:' + m.email + ')'
        : '(' + [nm.length >= 3 ? '"' + nm + '"' : '', String(m.phone || '').length >= 8 ? '"' + m.phone + '"' : ''].filter(Boolean).join(' OR ') + ')';
      if (q === '()') { site('post', 'mailscan', { surveyId: m.surveyId, hotelId: m.hotelId, email: '', ask: true, found: 0 }); continue; }
      const threads = GmailApp.search(q + ' newer_than:365d' + (m.auto && !m.email ? ' -category:promotions -category:social' : ''), 0, m.email ? 10 : 6);
      const seen = {}; (m.seen || []).forEach(id => { seen[id] = 1; });
      const senders = {};
      const items = [], incoming = [], files = [];
      const nameRe = String(m.name || '').replace(/^(מלון|hotel)\s+/i, '').trim();
      for (const t of threads) for (const msg of t.getMessages()) {
        if (seen[msg.getId()]) continue;   // already in the card
        const out = msg.getFrom().toLowerCase().indexOf(me) >= 0;
        const body = msg.getPlainBody();
        // owner 24.11: a check by name / number brings only mail that really talks about this place (not newsletters that name it)
        if (!m.email && m.auto && !(/[^\s<>"]+@[^\s<>"]+/.test(msg.getFrom()) && ((nameRe.length >= 3 && (msg.getSubject() + ' ' + body).indexOf(nameRe) >= 0) || (String(m.phone || '').length >= 8 && body.replace(/\D/g, '').indexOf(String(m.phone).slice(-8)) >= 0)))) continue;
        if (!out && /noreply|no-reply|newsletter|mailer-daemon/i.test(msg.getFrom())) continue;
        const fl = out ? [] : mailFiles(msg);
        items.push({ surveyId: m.surveyId, hotelId: m.hotelId, threadId: t.getId(), msgId: msg.getId(), at: msg.getDate().toISOString(), from: msg.getFrom(), to: msg.getTo(), out: out, subject: msg.getSubject(), body: body.slice(0, 12000), files: fl.map(f => ({ name: f.name, url: f.url })) });
        if (!out) { const fm = (msg.getFrom().match(/[^\s<>"]+@[^\s<>"]+/) || [''])[0].toLowerCase(); if (fm) senders[fm] = (senders[fm] || 0) + 1; }
        if (!out) { incoming.push('From: ' + msg.getFrom() + '\nDate: ' + msg.getDate().toISOString() + '\nSubject: ' + msg.getSubject() + (fl.length ? '\nAttached files: ' + fl.map(f => f.name).join(', ') : '') + '\n' + body.slice(0, 6000)); files.push.apply(files, fl); }
      }
      if (items.length) site('post', 'replies', { items: items.slice(-40) });
      if (incoming.length) {
        let result = null, error = '';
        try { result = readMail(incoming.slice(-6).join('\n\n----\n\n'), files.slice(-6), surveyOf(st, m.surveyId), m.name); } catch (e) { error = String(e).slice(0, 280); }
        site('post', 'parsed', { surveyId: m.surveyId, hotelId: m.hotelId, src: 'mail', result: result, error: error, files: files.map(f => ({ name: f.name, url: f.url })) });
      }
      const top = Object.keys(senders).sort((a, b) => senders[b] - senders[a])[0] || '';
      site('post', 'mailscan', { surveyId: m.surveyId, hotelId: m.hotelId, email: m.email, ask: !!m.ask, found: items.length, hotelEmail: !m.email && !/noreply|no-reply|mailer-daemon|booking\.com|google\.com/i.test(top) ? top : '' });
    } catch (e) { console.error('mailScan', e); }
  }
}
/** A new hotel: find it on the web (Google Search through Gemini) - official site, city, phone, e-mail - and take photos from its site. */
/** Gemini with a fallback: busy (503) or no quota (429) on one model -> the next one. Returns {code, body}. */
const WEB_MODELS = [MODEL, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];   // each has its own free daily quota (2.5-flash: 404 for new users)
/** Owner 19.11: more free keys from other Google accounts (script properties GEMINI_KEY2, GEMINI_KEY3), each with its own daily quota. */
function geminiKeys() { return ['GEMINI_KEY', 'GEMINI_KEY2', 'GEMINI_KEY3'].map(P).filter(Boolean); }
function genWeb(payload) {
  let code = 0, body = '';
  // payload may be a function of the key: a big recording is uploaded to that key's own Files API (owner 19.11: before, only key 1 was used and the robot stuck when it ran out)
  const texts = {};
  const textFor = key => texts[key] || (texts[key] = JSON.stringify(typeof payload === 'function' ? payload(key) : payload));
  const keys = geminiKeys();
  // owner 19.11: a light model writes poor Hebrew, so every strong model is tried on every key before a light one
  for (const m of WEB_MODELS.filter((x, i, a) => a.indexOf(x) === i)) {
    for (let k = 0; k < keys.length; k++) {
      if (elapsed() > 200) { console.log('gemini: out of time, next run'); return { code: code || 503, body: body || 'out of time' }; }   // owner 19.11: never let one recording run the robot into the 6-minute limit
      const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent', {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { 'x-goog-api-key': keys[k] }, payload: textFor(keys[k]),
      });
      code = r.getResponseCode(); body = r.getContentText();
      if (code < 300) HEALTH.gem.ok++; else if (code === 429) HEALTH.gem.quota++; else if (code === 503) HEALTH.gem.busy++;
      if (code < 300 || (code !== 429 && code !== 503 && code !== 404)) return { code: code, body: body };
      console.log('gemini key ' + (k + 1) + ': ' + m + ' ' + code + (payload.tools ? ' (search)' : ''));
    }
  }
  return { code: code, body: body };
}
/** Claude with web search (needs the script property CLAUDE_KEY). Returns the answer text, or null. */
function claudeWeb(prompt) {
  const key = P('CLAUDE_KEY');
  if (!key) return null;
  let messages = [{ role: 'user', content: prompt }];
  for (let i = 0; i < 3; i++) {   // a long search can pause (pause_turn): continue it
    const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      payload: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16000, output_config: { effort: 'low' }, fallbacks: 'default',
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }], messages: messages }),
    });
    if (r.getResponseCode() >= 300) { console.error('claudeWeb ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 300)); return null; }
    const j = JSON.parse(r.getContentText());
    if (j.stop_reason === 'pause_turn') { messages = [{ role: 'user', content: prompt }, { role: 'assistant', content: j.content }]; continue; }
    if (j.stop_reason === 'refusal') return null;
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }
  return null;
}
/** owner 24.11: web search through Tavily (script property TAVILY_KEY, 1,000 free searches a month): DuckDuckGo blocks Google's servers.
 *  [{url, title, snippet}], or null when there is no key / it failed (then DuckDuckGo is tried). */
function tavily(q) {
  const key = P('TAVILY_KEY');
  if (!key) return null;
  try {
    const r = UrlFetchApp.fetch('https://api.tavily.com/search', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + key }, payload: JSON.stringify({ query: q, max_results: 8, search_depth: 'basic' }) });
    if (r.getResponseCode() >= 300) { console.log('tavily ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 160)); return null; }
    return (JSON.parse(r.getContentText()).results || []).filter(x => /^https?:\/\//i.test(x.url || '')).map(x => ({ url: x.url, title: String(x.title || ''), snippet: String(x.content || '').slice(0, 400) }));
  } catch (e) { console.log('tavily ' + e); return null; }
}
/** Free web search (DuckDuckGo's plain page): [{url, title, snippet}]. Tavily first when there is a key. */
function ddg(q) {
  const tv = tavily(q);
  if (tv && tv.length) return tv;
  const r = UrlFetchApp.fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=il-he', { muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'he,en;q=0.8' } });
  if (r.getResponseCode() === 202) { console.log('ddg 202 (busy): ' + q); }
  if (r.getResponseCode() >= 300) return [];
  const t = r.getContentText();
  const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  const out = [], parts = t.split('class="result__a"').slice(1);
  for (const p of parts) {
    const href = (p.match(/href="([^"]+)"/) || [])[1] || '';
    let u = href.replace(/&amp;/g, '&');
    const g = u.match(/[?&]uddg=([^&]+)/); if (g) u = decodeURIComponent(g[1]);
    if (!/^https?:\/\//i.test(u) || /duckduckgo\.com\/y\.js|bing\.com\/aclick/i.test(u)) continue;   // ads
    const title = strip((p.match(/>([\s\S]*?)<\/a>/) || [])[1]);
    const snippet = strip((p.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/) || [])[1]);
    out.push({ url: u, title: title, snippet: snippet });
    if (out.length >= 10) break;
  }
  return out;
}
/** Look a hotel up for free: two web searches, then Gemini picks ONLY from what was found. null when it could not run. */
function freeLook(w) {
  // owner 24.11: a hall is searched as a hall ("האגם" alone finds a lake)
  const base = w.name + (w.city ? ' ' + w.city : '') + (w.hall && !/אולם|גן אירועים|אירועים|מלון|hotel/i.test(w.name) ? ' אולם אירועים' : '');
  const res = ddg(base);
  Utilities.sleep(1200);
  const rev = ddg(base + ' ביקורות');
  const all = res.concat(rev).filter((x, i, a) => a.findIndex(y => y.url === x.url) === i).slice(0, 16);
  if (!all.length) return null;
  // no AI here (it would use the calls' quota): simple, safe rules on the search results only
  const host = u => String(u || '').replace(/^https?:\/\/(www\.)?/i, '').split(/[\/?#]/)[0].toLowerCase();
  const words = String(w.name).replace(/["'()\/,.-]/g, ' ').split(/\s+/).filter(x => x.length >= 3 && !/^(מלון|כפר|הנופש|נופש|אכסניית|אכסניה|בית|הארחה|resort|hotel|the)$/i.test(x));
  const about = x => { const t = x.title + ' ' + x.snippet + ' ' + x.url; return words.length && words.some(wd => t.toLowerCase().indexOf(wd.toLowerCase()) >= 0); };
  const DIR = /booking\.|tripadvisor|google\.|goo\.gl|facebook\.|instagram\.|tiktok\.|youtube\.|waze\.|wikipedia\.|wikitravel|expedia\.|hotels\.com|agoda\.|trivago\.|kayak\.|airbnb\.|holidaycheck|zimmer|zimer|tzimer|b144\.|d\.co\.il|easy\.co\.il|rest\.co\.il|linkedin\.|twitter\.|x\.com|mapcarta|yelp\.|foursquare|gov\.il|ynet\.|mako\.|walla\.|haaretz|maariv|israelhayom|karamel|lametayel|isrotel|fattal|dan\.co\.il|hotels-israel|hotelsisrael|eshet|issta|gulliver|ophir|deal|lastminute|duckduckgo/i;
  const h = { found: false, website: '', city: '', about: '', rating: null, ratingScale: 5, reviews: null, reviewsSource: '', reviewsSummary: '', reviewsUrl: '' };
  // the official site: the first search result about this place that is not a booking site / directory / news
  const site = res.concat(rev).find(x => about(x) && !DIR.test(host(x.url)));
  if (site) {
    h.website = 'https://' + site.url.replace(/^https?:\/\//i, '').split(/[?#]/)[0].replace(/^([^\/]+).*$/, '$1') + '/';
    h.about = String(site.snippet || '').split(/(?<=[.!?])\s/)[0].slice(0, 160);
    h.found = true;
  }
  // the rating exactly as written in a result: "8.6 מתוך 10", "7.57 מתוך 234 ביקורות", "4.5/5", "דירוג 9.1"
  const NAMES = { 'booking.com': 'Booking', 'tripadvisor': 'TripAdvisor', 'google': 'Google', 'expedia': 'Expedia', 'hotels.com': 'Hotels.com', 'agoda': 'Agoda', 'karamel': 'קרמל', 'zimmer': 'צימר', 'zimer': 'צימר' };
  const srcName = u => { const hs = host(u); for (const k in NAMES) if (hs.indexOf(k) >= 0) return NAMES[k]; return hs; };
  for (const x of all) {
    if (!about(x)) continue;
    const t = x.snippet + ' ' + x.title;
    // "7.57 מתוך 234 ביקורות" = a score of 7.57 from 234 reviews
    const sr = t.match(/(\d{1,2}[.,]\d{1,2})\s*(?:מתוך|from)\s*([\d,]{2,7})\s*(?:ביקורות|חוות דעת|reviews)/i);
    let m = sr ? null : t.match(/(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:מתוך|\/|out of)\s*(10|5)(?!\d)/i);
    let rt = sr ? Number(sr[1].replace(',', '.')) : m ? Number(m[1].replace(',', '.')) : NaN, sc = sr ? (rt > 5 ? 10 : 5) : m ? Number(m[2]) : 0;
    if (sr) m = sr;
    if (!m) { m = t.match(/(?:דירוג|ציון|rating|scored?)\D{0,12}(\d{1,2}(?:[.,]\d{1,2})?)/i); if (m) { rt = Number(m[1].replace(',', '.')); sc = rt > 5 ? 10 : 5; } }
    if (!(rt > 0 && rt <= (sc || 10))) continue;
    const rc = t.match(/([\d,]{1,7})\s*(?:ביקורות|חוות דעת|מדרגים|reviews|ratings)/i);
    h.rating = Math.round(rt * 100) / 100; h.ratingScale = sc === 10 ? 10 : 5;
    h.reviews = rc ? Number(rc[1].replace(/,/g, '')) || null : null;
    h.reviewsSource = srcName(x.url); h.reviewsUrl = x.url; h.found = true;
    break;
  }
  // pages about this place (for photos when its own site blocks robots)
  h._pages = all.filter(x => x.url === h.reviewsUrl || (h.website && host(x.url) === host(h.website)) || about(x)).map(x => x.url).slice(0, 6);
  return h;
}
/** owner 24.11: a quick check from the editor that the free search works from Google's servers. */
function testSearch() { ['אולמיה', 'רמוס', 'מלון דן ירושלים'].forEach(q => { const r = ddg(q); console.log(q + ': ' + r.length + ' ' + r.slice(0, 3).map(x => x.url).join(' ')); Utilities.sleep(1500); }); }
function webLooks(st) {
  const useClaude = !!P('CLAUDE_KEY');
  const list = (st.webLook || []).slice(0, 2).concat((st.webRedo || []).slice(0, 1));
  for (const w of list) {
    if (elapsed() > 200) return;   // the rest next run
    let found = false, hotel = {}, photos = [], grounded = true, answered = false;
    try {
      const prompt = 'Find the hotel / venue "' + w.name + '"' + (w.city ? ' in ' + w.city : '') + (w.website ? ' (website ' + w.website + ')' : '') + ' on the web. Answer ONLY one JSON object, no text around it: {"found": true|false, "website": "official https site, not a booking site", "city": "", "phone": "", "email": "", "about": "one short line in Hebrew: what kind of place, stars, area", "rating": the Google Maps rating as a number (or null), "reviews": how many Google reviews (number or null), "reviewsSummary": "in Hebrew, 2-3 short sentences: what guests praise and what they complain about (food, cleanliness, rooms, service, Shabbat), from real reviews only", "reviewsUrl": "https link to the reviews (Google Maps / TripAdvisor / Booking) or empty"}. found=false if you are not sure it is this place. Never guess a phone or e-mail: leave it empty if it is not written on an official page.';
      // Claude (real web search) first when there is a key
      const ct = useClaude ? claudeWeb(prompt) : null;
      const cm = ct && ct.match(/\{[\s\S]*\}/);
      let code = 0, body = '';
      if (cm) { try { hotel = JSON.parse(cm[0]); found = !!hotel.found; answered = true; } catch (e) { hotel = {}; } }
      // free: web search + Gemini reading only the results
      if (!answered) { try { const fl = freeLook(w); if (fl) { hotel = fl; found = !!fl.found; answered = true; } } catch (e) { console.error('freeLook', e); } }
      if (!answered) { console.log('webLook: the search gave nothing for ' + w.name + ' (blocked?), next run'); continue; }   // owner 24.11: not counted as a try
      if (!answered && code >= 300) {
        // search blocked (quota) -> Gemini on its own knowledge: website / city / about only, never ratings, phone or e-mail
        console.log('webLook: search ' + code + ', trying without search');
        grounded = false;
        const r2 = genWeb({ contents: [{ role: 'user', parts: [{ text: 'The hotel / venue "' + w.name + '"' + (w.city ? ' in ' + w.city : '') + ' (Israel or abroad). Answer ONLY one JSON object: {"found": true|false, "website": "its official https site, not a booking site", "city": "", "about": "one short line in Hebrew: what kind of place and area"}. found=true only if you know this exact place for sure; otherwise found=false and empty fields.' }] }], generationConfig: { temperature: 0 } });
        code = r2.code; body = r2.body;
      }
      if (!answered && code < 300) {
        answered = true;
        const j = JSON.parse(body);
        const text = (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(p => p.text || '').join('');
        const m = text.match(/\{[\s\S]*\}/);
        if (m) { hotel = JSON.parse(m[0]); found = !!hotel.found; }
      } else if (!answered) console.error('webLook: gemini ' + code);
      if (!grounded) hotel = { found: hotel.found, website: hotel.website, city: hotel.city, about: hotel.about };
      let siteUrl = String(hotel.website || w.website || '');
      // owner 24.11: only a site that is really this place (never one already found wrong)
      const host = u => String(u || '').replace(/^https?:\/\/(www\.)?/i, '').split('/')[0].toLowerCase();
      if (found && /^https?:\/\//i.test(siteUrl) && ((w.avoid || []).some(x => host(x) === host(siteUrl)) || siteIsPlace(siteUrl, w.name, hotel.city || w.city) === false)) { console.log('webLook: not the site of ' + w.name + ': ' + siteUrl); hotel.website = ''; siteUrl = ''; }
      if (found && /^https?:\/\//i.test(siteUrl)) {
        photos = sitePhotos(siteUrl);
        if (photos === null) { photos = []; if (!grounded) hotel.website = ''; }   // the site does not open: do not keep a guessed address
      }
      // the site blocks robots / has no pictures: the main picture of other pages about this place
      if (found && !photos.length && hotel._pages) {
        for (const pu of hotel._pages) {
          if (photos.length >= 6) break;
          const ph = sitePhotos(pu);
          // only real photos: jpg / webp (png is mostly logos and icons), the page's main picture first
          const real = (ph || []).filter(u => /\.(jpe?g|webp)(\?|$)/i.test(u) || /bstatic\.com/i.test(u));
          if (real.length) photos = photos.concat(real.slice(0, 2)).filter((x, i, a) => a.indexOf(x) === i);
        }
      }
      delete hotel._pages;
    } catch (e) { console.error('webLook', e); }
    if (!answered) continue;   // Gemini did not answer at all: try again next run, not counted as a try
    let checked = false;
    if (photos.length) { try { photos = goodPhotos(photos, w.name).slice(0, 8); checked = true; } catch (e) { console.log('goodPhotos later: ' + e); photos = photos.slice(0, 12); } }   // owner 24.11: only real photos of the place
    site('post', 'web', { surveyId: w.surveyId, hotelId: w.hotelId, found: found, grounded: grounded, hotel: hotel, photos: photos, photosChecked: checked, redo: !!w.redo });
  }
}
/** The site's own share image + its pictures (absolute https links only). */
function sitePhotos(url) {
  let r;
  try { r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0' } }); } catch (e) { return null; }
  if (r.getResponseCode() >= 400) return null;
  const html = r.getContentText().slice(0, 600000), base = url.replace(/^(https?:\/\/[^\/]+).*$/i, '$1');
  const abs = u => { u = String(u || '').trim().replace(/&amp;/g, '&'); if (!u || /^data:/i.test(u)) return ''; if (/^\/\//.test(u)) u = 'https:' + u; else if (/^\//.test(u)) u = base + u; else if (!/^https?:/i.test(u)) return ''; return u.replace(/^http:/i, 'https:'); };
  const out = [];
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image/i);
  if (og) out.push(abs(og[1]));
  const re = /<img[^>]+(?:data-src|src)=["']([^"']+\.(?:jpe?g|webp|png)(?:\?[^"']*)?)["']/gi; let m;
  while ((m = re.exec(html)) && out.length < 20) { const u = abs(m[1]); if (u && !/logo|icon|sprite|flag|pixel|avatar|badge|banner|button|arrow|check|thumb_?\d{2}\b|\b\d{2}x\d{2}\b/i.test(u)) out.push(u); }
  return [...new Set(out.filter(Boolean))].slice(0, 12);
}
/** Calls with a watched hotel number (2 weeks around when it was added) join that hotel even without check mode. */
function watchFor(st, f, at) {
  const d = String(phoneOf(f) || '').replace(/\D/g, '').replace(/^972/, '0').slice(-9);
  if (d.length < 8) return null;
  const ms = at.getTime();
  return (st.watch || []).find(w => w.phone === d && ms >= Date.parse(w.from) && ms <= Date.parse(w.to)) || null;
}

function gemini(part, prompt, schema) {
  // busy (503) / no quota (429) on the main model -> the next model (genWeb)
  const body = p => ({ contents: [{ role: 'user', parts: [p, { text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.1 } });
  const r = genWeb(part.big ? key => body({ file_data: { mime_type: part.big.mime, file_uri: uploadToGemini(part.big.blob, part.big.mime, part.big.name, key) } }) : body(part));
  if (r.code >= 300) throw new Error('gemini ' + r.code + ' ' + String(r.body).slice(0, 300));
  const j = JSON.parse(r.body);
  const text = (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(p => p.text || '').join('');
  return JSON.parse(text);
}
/** Big recordings go through the Gemini Files API (kept there 48 hours, then deleted by Google). */
function uploadToGemini(blob, mime, name, key) {
  key = key || P('GEMINI_KEY');
  const bytes = blob.getBytes();
  const start = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(bytes.length), 'X-Goog-Upload-Header-Content-Type': mime },
    payload: JSON.stringify({ file: { display_name: name.slice(0, 100) } }),
  });
  const h = start.getAllHeaders();
  const up = h['x-goog-upload-url'] || h['X-Goog-Upload-URL'];
  const r = UrlFetchApp.fetch(up, { method: 'post', contentType: mime, payload: bytes, muteHttpExceptions: true, headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' } });
  const f = JSON.parse(r.getContentText()).file;
  for (let i = 0; i < 30 && f.state === 'PROCESSING'; i++) {
    Utilities.sleep(2000);
    const s = JSON.parse(UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/' + f.name, { headers: { 'x-goog-api-key': key } }).getContentText());
    f.state = s.state;
  }
  return f.uri;
}

/* ---------- 5: e-mails ---------- */
function outbox(st) {
  for (const m of st.outbox || []) {
    try {
      const html = m.body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
      const draft = GmailApp.createDraft(m.to, m.subject, m.body, { htmlBody: '<div dir="' + (/[֐-׿]/.test(m.body) ? 'rtl' : 'ltr') + '">' + html + '</div>', name: 'La Belle Vie' });
      const msg = draft.send();
      site('post', 'mailsent', { id: m.id, at: new Date().toISOString(), threadId: msg.getThread().getId(), msgId: msg.getId() });
    } catch (e) {
      site('post', 'mailsent', { id: m.id, error: String(e).slice(0, 280) });
    }
  }
}
function replies(st) {
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  const items = [];
  const seenThread = {};
  for (const t of st.threads || []) {
    if (seenThread[t.threadId]) continue;
    seenThread[t.threadId] = 1;
    let thread;
    try { thread = GmailApp.getThreadById(t.threadId); } catch (e) { continue; }
    if (!thread) continue;
    for (const msg of thread.getMessages()) {
      if (t.seen.indexOf(msg.getId()) >= 0) continue;
      if (msg.getFrom().toLowerCase().indexOf(me) >= 0) continue;
      const fl = mailFiles(msg);
      items.push({ surveyId: t.surveyId, hotelId: t.hotelId, threadId: t.threadId, msgId: msg.getId(), at: msg.getDate().toISOString(), from: msg.getFrom(), subject: msg.getSubject(), body: msg.getPlainBody().slice(0, 12000), files: fl.map(f => ({ name: f.name, url: f.url })), _files: fl });
    }
  }
  if (items.length) site('post', 'replies', { items: items.map(it => { const x = Object.assign({}, it); delete x._files; return x; }) });
  for (const it of items.slice(0, 3)) {
    let result = null, error = '';
    try { result = readMail('From: ' + it.from + '\nSubject: ' + it.subject + (it.files.length ? '\nAttached files: ' + it.files.map(f => f.name).join(', ') : '') + '\n' + it.body, it._files, surveyOf(st, it.surveyId), ''); } catch (e) { error = String(e).slice(0, 280); }
    try { site('post', 'parsed', { surveyId: it.surveyId, hotelId: it.hotelId, src: 'mail', result: result, error: error, files: it.files }); } catch (e) {}
  }
}
/* ---------- owner 24.11: the files that come with a hotel's mail (a price quote in PDF / Word / Excel / a photo of it) ----------
   Saved once in Drive ("סקר מלונות - קבצים מהמלונות"), linked on the card, and read by Gemini with the mail.
   Small pictures (signatures, logos, icons) are not files: they are skipped. */
function mailFiles(msg) {
  const out = [];
  let list = [];
  try { list = msg.getAttachments({ includeInlineImages: false, includeAttachments: true }); } catch (e) { return out; }
  for (const a of list.slice(0, 6)) {
    try {
      const name = a.getName() || 'קובץ', mime = (a.getContentType() || '').toLowerCase(), size = a.getSize();
      if (/^image\//.test(mime) && size < 40 * 1024) continue;   // a signature / logo / icon
      if (!/pdf|image\/|word|officedocument|msword|excel|spreadsheet|text\/plain|text\/csv/.test(mime) && !/\.(pdf|docx?|xlsx?|csv|txt|jpe?g|png|heic)$/i.test(name)) continue;
      const fname = msg.getId() + ' - ' + name;
      const same = savedFolder().getFilesByName(fname);
      const f = same.hasNext() ? same.next() : savedFolder().createFile(a.copyBlob().setName(fname));
      out.push({ name: name, url: f.getUrl(), mime: mime, size: size, blob: a.copyBlob() });
    } catch (e) { console.error('mailFile', e); }
  }
  return out;
}
/** The text of a Word / Excel file (they are zip files of XML). */
function officeText(blob, name) {
  try {
    const parts = Utilities.unzip(blob.setContentType('application/zip'));
    const xml = parts.filter(p => /word\/document\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml/.test(p.getName())).map(p => p.getDataAsString('UTF-8')).join('\n');
    return xml.replace(/<\/(w:p|row)>/g, '\n').replace(/<\/(w:tc|c)>/g, ' | ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').slice(0, 20000);
  } catch (e) { return ''; }
}
/** A mail (and the files that came with it) → the hotel's details, prices, availability, and a summary that says what each file is. */
function readMail(text, files, sv, hotelName) {
  const parts = [];
  let extra = '';
  for (const f of (files || []).slice(0, 4)) {
    if ((/pdf/.test(f.mime) || /\.pdf$/i.test(f.name)) && f.size < 15 * 1024 * 1024) parts.push({ inline_data: { mime_type: 'application/pdf', data: Utilities.base64Encode(f.blob.getBytes()) } });
    else if (/^image\//.test(f.mime) && f.size < 8 * 1024 * 1024 && !/heic/.test(f.mime)) parts.push({ inline_data: { mime_type: f.mime, data: Utilities.base64Encode(f.blob.getBytes()) } });
    else if (/word|officedocument|excel|spreadsheet|msword/.test(f.mime) || /\.(docx|xlsx)$/i.test(f.name)) { const t = officeText(f.blob, f.name); if (t) extra += '\n\n==== The file "' + f.name + '" ====\n' + t; }
    else if (/text\//.test(f.mime)) extra += '\n\n==== The file "' + f.name + '" ====\n' + f.blob.getDataAsString('UTF-8').slice(0, 20000);
  }
  if (!parts.length && !extra) return readText(text, sv, hotelName, 'mail');
  const prompt = [
    'This is an e-mail exchange between La Belle Vie (לה בל וי, an Israeli events and holiday company) and a hotel / venue, WITH the files the hotel attached (a price quote, a menu, a contract, a photo of a quote). Read the files completely: they usually hold the prices.',
    'The hotel in La Belle Vie\'s list: "' + (hotelName || '') + '". Survey: "' + (sv ? sv.title : '') + '". Dates needed: ' + (sv ? (sv.from || '?') + ' to ' + (sv.to || '?') : '?') + '. What is needed: ' + (sv ? sv.need || '-' : '-') + '.',
    'Price levels used in this survey: ' + ((sv && sv.levels) || []).join(', ') + '. Use one of these names for "level" when it fits, otherwise the hotel\'s own room name.',
    'Today is ' + Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'EEEE yyyy-MM-dd') + ' (Israel). Turn relative days into a date.',
    'Answer in JSON only. Write summary, availability text and notes in Hebrew. relevant = true if the mail or the files are about rooms, a hall, meals, availability, prices or conditions.',
    'summary: start with what the hotel sent (e.g. "הצעת מחיר בקובץ PDF:"), then the main points of the quote: what is included, the prices per room / per person / per package, the dates it is for, the conditions (deposit, cancellation, until when the offer is valid), and what is missing or must be answered.',
    'availability: rooms AND hall/meals if mentioned; rooms = how many rooms. prices: one row per room type + board or per package, the number only in price, per = per what. Hours and conditions go into prices[].note or the summary.',
    'hotel: name, city, contact person, phone, email, website if written. followUp: whether something has to be sent / answered, by when and what.',
    'keyQuotes: the sentences that matter as proof later, the exact words written (from the mail or the file), speaker = who wrote them.',
    '',
    String(text).slice(0, 30000) + extra,
  ].join('\n');
  const r = genWeb({ contents: [{ role: 'user', parts: parts.concat([{ text: prompt }]) }], generationConfig: { responseMimeType: 'application/json', responseSchema: hotelSchema(), temperature: 0.1 } });
  if (r.code >= 300) throw new Error('gemini ' + r.code + ' ' + String(r.body).slice(0, 300));
  const j = JSON.parse(r.body);
  return JSON.parse((((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(p => p.text || '').join(''));
}

/* ---------- owner 24.11: only photos that show the place (rooms, hall, dining room, pool, building, view) ----------
   Every picture from the web is looked at by Gemini; logos, icons, flags, check marks, banners with text, maps,
   phone numbers and ads are dropped. Tiny files are not photos at all. */
function goodPhotos(urls, name) {
  const cand = [];
  for (const u of (urls || []).slice(0, 12)) {
    if (cand.length >= 10 || elapsed() > 200) break;
    try {
      const r = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.getResponseCode() >= 300) continue;
      const b = r.getBlob(), mime = String(b.getContentType() || '').toLowerCase().split(';')[0];
      const n = b.getBytes().length;
      if (!/^image\/(jpeg|jpg|png|webp)$/.test(mime) || n < 25 * 1024 || n > 6 * 1024 * 1024) continue;   // an icon is a few KB
      cand.push({ url: u, part: { inline_data: { mime_type: mime === 'image/jpg' ? 'image/jpeg' : mime, data: Utilities.base64Encode(b.getBytes()) } } });
    } catch (e) {}
  }
  if (!cand.length) return [];
  const prompt = 'These ' + cand.length + ' pictures (numbered 0 to ' + (cand.length - 1) + ' in order) were found on the web for the hotel / venue "' + (name || '') + '". Keep ONLY real photographs of the place itself: guest rooms, suites, lobby, event hall, dining room, synagogue, pool, spa, garden, the building, the view from it, a set table at the place. Drop everything else: logos, icons, symbols, check marks, flags, arrows, buttons, banners or images that are mostly text, phone numbers or opening hours, maps, ads, booking-site graphics, people portraits, food close-ups without the place, photos of a different place, and any photo showing a sign or name of another business (a shop, a mall, a furniture store, a restaurant with another name). When unsure, drop it. Answer JSON: {"keep": [the numbers to keep]}.';
  const parts = [];
  cand.forEach((c, i) => { parts.push({ text: 'Picture ' + i + ':' }); parts.push(c.part); });
  const r = genWeb({ contents: [{ role: 'user', parts: parts.concat([{ text: prompt }]) }], generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { keep: { type: 'ARRAY', items: { type: 'INTEGER' } } }, required: ['keep'] }, temperature: 0 } });
  if (r.code >= 300) throw new Error('gemini ' + r.code);
  const j = JSON.parse(r.body);
  const keep = (JSON.parse((((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(p => p.text || '').join('')).keep || []);
  return keep.filter(i => cand[i]).map(i => cand[i].url).filter((x, i, a) => a.indexOf(x) === i);
}
/** Is this page really the site of this hotel / venue? false = surely not, true = yes, null = could not tell (kept). */
var NOT_OWN_SITE = /(^|\.)(booking|hotel4u|tripadvisor|moovit|wikipedia|wikiwand|google|facebook|instagram|tiktok|youtube|easy\.co|gogo|hotels\.com|expedia|agoda|trivago|kayak|zimmer|zimmeril|rest\.co|mapcarta|waze|ynet|walla|mako|haaretz|maariv|historyistold|yad2|madlan|b144|d\.co\.il|dapei|lametayel|pinterest|linkedin)/i;
function siteIsPlace(url, name, city) {
  if (NOT_OWN_SITE.test(String(url || '').replace(/^https?:\/\/(www\.)?/i, ''))) return false;   // owner 24.11: booking / reviews / maps / news / history: never the place's own site
  let r;
  try { r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': 'Mozilla/5.0' } }); } catch (e) { return null; }
  if (r.getResponseCode() >= 400) return null;
  const html = r.getContentText().slice(0, 400000);
  const pick = re => ((html.match(re) || [])[1] || '');
  const text = [pick(/<title[^>]*>([\s\S]*?)<\/title>/i), pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i), pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i),
    html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000)].join(' \n ');
  // a hotel / venue site talks about rooms, stays or events somewhere at the top
  if (!/hotel|מלון|rooms?|חדר|suite|resort|אירוח|לינה|אולם|אירוע|event|venue|kibbutz|קיבוץ|spa|guest\s?house|צימר|נופש|vacation|hôtel|chambre|salle/i.test(text)) return false;
  try {
    const g = genWeb({ contents: [{ role: 'user', parts: [{ text: 'Hotel / venue: "' + name + '"' + (city ? ', ' + city : '') + '. Web page ' + url + ':\n' + text.slice(0, 3500) + '\n\nIs this page the official site of exactly this place (or of the hotel / kibbutz / chain it belongs to)? A booking site, a directory, a news / history / blog site, or a different place = false. Answer JSON {"same": true|false}.' }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { same: { type: 'BOOLEAN' } }, required: ['same'] }, temperature: 0 } });
    if (g.code >= 300) return null;
    const j = JSON.parse(g.body);
    return !!JSON.parse((((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(p => p.text || '').join('')).same;
  } catch (e) { return null; }
}
/** The photos (and the site) already on the cards: checked once each, the wrong ones removed. */
function photoChecks(st) {
  for (const p of (st.photoCheck || []).slice(0, 4)) {
    if (elapsed() > 150) return;
    try {
      if (p.website && siteIsPlace(p.website, p.name, p.city) === false) { site('post', 'photoscheck', { surveyId: p.surveyId, hotelId: p.hotelId, siteBad: true, keep: [] }); continue; }
      site('post', 'photoscheck', { surveyId: p.surveyId, hotelId: p.hotelId, keep: goodPhotos(p.photos, p.name), cand: !!p.cand });
    } catch (e) { console.error('photoCheck', e); }   // Gemini busy: again next run
  }
}
function savedFolder() {
  const n = 'סקר מלונות - קבצים מהמלונות';
  const it = DriveApp.getFoldersByName(n);
  return it.hasNext() ? it.next() : DriveApp.createFolder(n);
}

/* ---------- 6: Google Sheets ---------- */
/** owner 24.11: the sheet neat to read: a dark header, the hotel name fixed on the side, wrapped long texts,
    colours for availability and status, prices as numbers, widths that fit, light stripes. */
function tidySheet(sh, rows, w) {
  const head = rows[0].map(String), n = rows.length;
  const all = sh.getRange(1, 1, n, w);
  sh.getBandings().forEach(b => b.remove());
  all.clearFormat();
  all.setFontFamily('Arial').setFontSize(11).setVerticalAlignment('top').setHorizontalAlignment('right').setWrap(false);
  sh.getRange(1, 1, 1, w).setFontWeight('bold').setFontColor('#ffffff').setBackground('#1f2a44').setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(1, 42);
  if (n > 1) sh.getRange(1, 1, n, w).applyRowBanding(SpreadsheetApp.BandingTheme.LIGHT_GREY, true, false);
  sh.getRange(1, 1, 1, w).setBackground('#1f2a44').setFontColor('#ffffff');
  sh.setFrozenRows(1); sh.setFrozenColumns(1);
  if (n > 1) sh.getRange(2, 1, n - 1, 1).setFontWeight('bold');
  const col = t => head.indexOf(t) + 1;
  const long = ['המחירים', 'מה חשוב לדעת', 'לחזור אליהם', 'פירוט זמינות', 'סיכום', 'הערות', 'מה לבדוק'];
  for (let c = 1; c <= w; c++) {
    const t = head[c - 1];
    if (long.indexOf(t) >= 0) { sh.setColumnWidth(c, t === 'סיכום' || t === 'מה חשוב לדעת' ? 340 : 240); if (n > 1) sh.getRange(2, c, n - 1, 1).setWrap(true); }
    else if (t === 'מלון' || t === 'מקום') sh.setColumnWidth(c, 190);
    else if (t === 'איש קשר וטלפון') sh.setColumnWidth(c, 200);
    else if (t === 'מייל') sh.setColumnWidth(c, 200);
    else if (t === 'טלפון' || t === 'שיחה אחרונה') sh.setColumnWidth(c, 140);
    else sh.setColumnWidth(c, 120);
  }
  if (n > 1 && col('הכי זול')) sh.getRange(2, col('הכי זול'), n - 1, 1).setNumberFormat('#,##0 "₪"').setFontWeight('bold');
  const rules = [];
  const paint = (c, text, bg, fg) => { if (c && n > 1) rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text).setBackground(bg).setFontColor(fg).setRanges([sh.getRange(2, c, n - 1, 1)]).build()); };
  const pc = head.findIndex(t => /^ב-\d/.test(t)) + 1;   // owner 24.11: the preferred-date column
  if (pc) { paint(pc, 'פנוי', '#d9f2e3', '#0b5d2a'); paint(pc, 'בספק', '#fff1c9', '#7a5600'); paint(pc, 'תפוס', '#fbdcdc', '#8a1c1c'); sh.setColumnWidth(pc, 110); }
  if (col('תאריכים חלופיים')) sh.setColumnWidth(col('תאריכים חלופיים'), 150);
  paint(col('זמינות'), 'יש מקום', '#d9f2e3', '#0b5d2a'); paint(col('זמינות'), 'מקום חלקי', '#fff1c9', '#7a5600'); paint(col('זמינות'), 'תפוס', '#fbdcdc', '#8a1c1c');
  paint(col('סטטוס'), 'מתאים', '#d9f2e3', '#0b5d2a'); paint(col('סטטוס'), 'לחזור אליהם', '#fff1c9', '#7a5600'); paint(col('סטטוס'), 'לא רלוונטי', '#eeeeee', '#666666'); paint(col('סטטוס'), 'נסגר', '#dbe6ff', '#1f3d8a');
  sh.setConditionalFormatRules(rules);
  all.setBorder(true, true, true, true, true, true, '#d9d9d9', SpreadsheetApp.BorderStyle.SOLID);
}
function sheets(st) {
  for (const sv of st.surveys || []) {
    if (!sv.sheet) continue;
    const data = site('get', 'export', null, '&survey=' + encodeURIComponent(sv.id));
    const key = 'SHEET_' + sv.id;
    let ss;
    if (P(key)) { try { ss = SpreadsheetApp.openById(P(key)); } catch (e) { ss = null; } }
    if (!ss) {
      ss = SpreadsheetApp.create('סקר מלונות - ' + sv.title);
      props().setProperty(key, ss.getId());
    }
    if (sv.sheetUrl !== ss.getUrl()) site('post', 'sheet', { surveyId: sv.id, url: ss.getUrl() });
    const sh = ss.getSheets()[0];
    sh.setRightToLeft(true);
    sh.clearContents();
    const rows = data.rows || [];
    if (!rows.length) continue;
    const w = Math.max.apply(null, rows.map(r => r.length));
    sh.getRange(1, 1, rows.length, w).setValues(rows.map(r => { const x = r.slice(); while (x.length < w) x.push(''); return x.map(v => v == null ? '' : v); }));
    tidySheet(sh, rows, w);
  }
}

/* ---------- 0b (owner 24.11): our own transcription on the phone ----------
   The phone transcribes the call itself and sends only the text (never the recording). Here the text is
   (1) listed with the other calls (with where the recording is on the phone, "ref"), (2) read by Gemini when it is
   a work call: a hotel call in check mode → the hotel card, Ilan → his tasks, anything else → a summary on the call.
   Each text waits as a small file in "תמלולים מהטלפון" and is deleted as soon as it is handled. */
function textFolder() {
  const n = 'תמלולים מהטלפון';
  const it = DriveApp.getFoldersByName(n);
  return it.hasNext() ? it.next() : DriveApp.createFolder(n);
}
function textId(b) { return 'ph_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_1, String(b.name) + '|' + String(b.size))).slice(0, 20); }
function phoneTexts(st) {
  const fi = textFolder().getFiles();
  const list = [];
  while (fi.hasNext()) list.push(fi.next());
  list.sort((a, b) => a.getDateCreated() - b.getDateCreated());
  for (const jf of list.slice(0, 8)) {
    if (elapsed() > 200) return;
    let b;
    try { b = JSON.parse(jf.getBlob().getDataAsString('UTF-8')); } catch (e) { jf.setTrashed(true); continue; }
    const c = b.call || {};
    const id = textId(b);
    const at = new Date(c.at || b.modified || Date.now());
    const who = (c.contact ? c.contact + ' · ' : '') + String(b.name || '');
    // the file stand-in: the prompts read its name / call details, and its text instead of a recording
    const desc = JSON.stringify({ phone: c.phone || '', contact: c.contact || '', at: c.at || '', duration: c.duration || '', dir: c.dir || '' });
    const header = 'This phone call was transcribed automatically on the phone (it can have mistakes: fix obvious ones from the context, never invent). Language: ' + (b.lang || '?') + '. Each line: "mm:ss text" (the speakers are not marked: tell them apart from the context).\n\n';
    const fake = { getName: () => String(b.name || ''), getDescription: () => desc, getId: () => id, getUrl: () => '', textPart: { text: header + String(b.text || '').slice(0, 60000) } };
    const file = { id: id, name: String(b.name || ''), url: '' };
    try {
      if (!b.listed) {
        site('post', 'index', { items: [{ id: id, name: who, phone: c.phone || '', at: at.toISOString(), url: '', ref: String(b.ref || ''), local: true, lang: b.lang || '', full: !!b.full, took: b.took || 0, seconds: b.seconds || 0 }] });
        // the transcript is on the call at once (even before Gemini reads it, and even if Gemini is busy)
        site('post', 'answer', { id: id, result: { summary: b.full ? '' : 'שיחה לא קשורה לעבודה (נבדקו 30 השניות הראשונות).', transcript: String(b.text || '').slice(0, 30000) } });
        b.listed = true;
        jf.setContent(JSON.stringify(b));
      }
      if (b.full) {
        if (ilanFor(st, { getDescription: () => desc, getName: () => String(b.name || '') }, at)) {
          site('post', 'ilan', { at: at.toISOString(), file: file, result: listenIlan(fake, at) });
        } else {
          const w = windowFor(st, at) || watchForPhone(st, c.phone, at);
          const sv = w ? (st.surveys || []).find(s => s.id === w.surveyId) : null;
          if (sv) {
            const result = listen(fake, sv, at);
            if (result && result.relevant) { result.hotel = result.hotel || {}; if (!result.hotel.phone) result.hotel.phone = c.phone || ''; }
            site('post', 'call', { surveyId: sv.id, at: at.toISOString(), file: file, result: result });
          } else {
            const r = listen(fake, null, at);
            r.transcript = r.transcript || String(b.text || '');
            site('post', 'answer', { id: id, result: r });
          }
        }
      }
      jf.setTrashed(true);   // handled: the text file is deleted (the transcript lives on the site)
    } catch (e) {
      console.error('phoneText ' + b.name, e);   // Gemini busy / no quota: the file stays and is tried again next run
      b.tries = (b.tries || 0) + 1;
      if (b.tries >= 12) jf.setTrashed(true); else jf.setContent(JSON.stringify(b));
    }
  }
}
/** A hotel number watched for this time (like watchFor, from the number the phone sent). */
function watchForPhone(st, phone, at) {
  const d = String(phone || '').replace(/\D/g, '').replace(/^972/, '0').slice(-9);
  if (d.length < 8) return null;
  const ms = at.getTime();
  for (const w of st.watch || []) {
    const wd = String(w.phone || '').replace(/\D/g, '').replace(/^972/, '0').slice(-9);
    if (wd === d && ms >= Date.parse(w.from) && ms <= Date.parse(w.to)) return w;
  }
  return null;
}

/* ---------- 0: the phone app sends each recording here ---------- */
/** The names the phone's engine should spell right: the hotels in the surveys (and the company). */
function vocabOf(s) {
  const names = [];
  for (const sv of s.surveys || []) for (const h of sv.hotels || []) if (h.name && names.indexOf(h.name) < 0) names.push(h.name);
  return names.slice(0, 40).join(', ');
}
function recFolder() {
  const n = P('FOLDER') || 'הקלטות שיחות';
  const it = DriveApp.getFoldersByName(n);
  return it.hasNext() ? it.next() : DriveApp.createFolder(n);
}
function doPost(e) {
  const reply = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  let b;
  try { b = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, error: 'json' }); }
  if (!b.secret || b.secret !== P('APP_SECRET')) return reply({ ok: false, error: 'secret' });
  if (b.op === 'jobs') {
    const cache = CacheService.getScriptCache();
    let st = null;
    try { st = JSON.parse(cache.get('phoneJobs') || 'null'); } catch (err) {}
    if (!st) {
      const s = site('get', 'status');
      st = { windows: (s.windows || []).map(w => ({ from: Date.parse(w.from) || 0, to: w.to ? Date.parse(w.to) || 0 : 0 })), watch: (s.watch || []).map(w => ({ phone: w.phone, from: Date.parse(w.from) || 0, to: Date.parse(w.to) || 0 })), wa: s.wa || [],
        ilan: ((s.ilan || {}).phones || []), vocab: vocabOf(s) };
      try { cache.put('phoneJobs', JSON.stringify(st), 60); } catch (err) {}
    }
    return reply({ ok: true, windows: st.windows, watch: st.watch, wa: st.wa || [], ilan: st.ilan || [], vocab: st.vocab || '', modelHe: P('MODEL_HE') || '', modelFr: P('MODEL_FR') || '' });
  }
  // WhatsApp messages from hotels (read on the phone from the notifications) → the site files them and reads the details
  if (b.op === 'wa') {
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 100);
    if (items.length) site('post', 'wa', { items: items });
    return reply({ ok: true });
  }
  // owner 24.11: a call the phone transcribed itself (only text, never the recording)
  if (b.op === 'text') {
    if (!b.name) return reply({ ok: false, error: 'name' });
    const folder = textFolder();
    const fname = textId(b) + '.json';
    const same = folder.getFilesByName(fname);
    while (same.hasNext()) same.next().setTrashed(true);   // sent again (a call read again in full): the newest wins
    delete b.secret;
    folder.createFile(fname, JSON.stringify(b), 'application/json');
    props().setProperty('APP_LAST', new Date().toISOString());
    return reply({ ok: true });
  }
  if (b.op !== 'upload' || !b.data || !b.name) return reply({ ok: false, error: 'op' });
  const folder = recFolder();
  const name = String(b.name).slice(0, 200);
  const same = folder.getFilesByName(name);
  while (same.hasNext()) if (same.next().getSize() === Number(b.size)) return reply({ ok: true, dup: true });
  const c = b.call || {};
  const f = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b.data), b.mime || 'audio/mp4', name));
  f.setDescription(JSON.stringify({ phone: c.phone || '', contact: c.contact || '', at: c.at || b.modified || '', duration: c.duration || '', dir: c.dir || '' }));
  props().setProperty('APP_LAST', new Date().toISOString());
  return reply({ ok: true });
}
