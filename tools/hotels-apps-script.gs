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
 *   GEMINI_KEY  the Gemini API key
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
function tick() {
  T0 = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    try { site('post', 'app', { url: P('APP_URL') || ScriptApp.getService().getUrl() || '', secret: P('APP_SECRET'), last: P('APP_LAST') }); } catch (e) { console.error('app', e); }
    const st = site('get', 'status');
    try { recordings(st); } catch (e) { console.error('recordings', e); }
    try { ilanOld(st); } catch (e) { console.error('ilanOld', e); }
    try { relistens(st); } catch (e) { console.error('relistens', e); }   // early: it needs minutes
    try { indexCalls(); } catch (e) { console.error('index', e); }
    try { answerAsks(st); } catch (e) { console.error('asks', e); }
    try { outbox(st); } catch (e) { console.error('outbox', e); }
    try { replies(st); } catch (e) { console.error('replies', e); }
    try { parses(st); } catch (e) { console.error('parses', e); }
    try { mailScans(st); } catch (e) { console.error('mailScans', e); }
    try { webLooks(st); } catch (e) { console.error('webLooks', e); }
    try { sheets(st); } catch (e) { console.error('sheets', e); }
  } finally { lock.releaseLock(); }
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
      const result = listenIlan(f, at);
      site('post', 'ilan', { at: at.toISOString(), file: { id: f.getId(), name: f.getName(), url: f.getUrl() }, result: result });
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
  const blob = file.getBlob();
  let mime = blob.getContentType() || 'audio/mp4';
  if (/octet/.test(mime)) mime = /\.amr$/i.test(file.getName()) ? 'audio/amr' : /\.mp3$/i.test(file.getName()) ? 'audio/mpeg' : /\.wav$/i.test(file.getName()) ? 'audio/wav' : 'audio/mp4';
  let part;
  if (blob.getBytes().length < 14 * 1024 * 1024) part = { inline_data: { mime_type: mime, data: Utilities.base64Encode(blob.getBytes()) } };
  else part = { file_data: { mime_type: mime, file_uri: uploadToGemini(blob, mime, file.getName()) } };

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
    'followUp: whether someone has to call back / send something, by when (YYYY-MM-DD if a date was said), and what.',
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
  const blob = file.getBlob();
  let mime = blob.getContentType() || 'audio/mp4';
  if (/octet/.test(mime)) mime = /\.amr$/i.test(file.getName()) ? 'audio/amr' : /\.mp3$/i.test(file.getName()) ? 'audio/mpeg' : /\.wav$/i.test(file.getName()) ? 'audio/wav' : 'audio/mp4';
  const part = blob.getBytes().length < 14 * 1024 * 1024 ? { inline_data: { mime_type: mime, data: Utilities.base64Encode(blob.getBytes()) } } : { file_data: { mime_type: mime, file_uri: uploadToGemini(blob, mime, file.getName()) } };
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
    'keyQuotes: the sentences that matter most, the exact words, with the time (mm:ss) and who said it (אילן / אני).',
    'transcript: the whole conversation, each turn on its own line, "mm:ss אילן:" / "mm:ss אני:". duration: mm:ss.',
  ].join('\n'), { type: 'OBJECT', properties: {
    summary: { type: 'STRING' }, wants: { type: 'ARRAY', items: { type: 'STRING' } },
    tasks: { type: 'ARRAY', items: { type: 'OBJECT', properties: { text: { type: 'STRING' }, due: { type: 'STRING' }, when: { type: 'STRING' }, quote: { type: 'STRING' } }, required: ['text'] } },
    keyQuotes: { type: 'ARRAY', items: Q }, transcript: { type: 'STRING' }, duration: { type: 'STRING' } }, required: ['summary', 'tasks'] });
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
      const threads = GmailApp.search(q + ' newer_than:365d', 0, m.email ? 10 : 6);
      const senders = {};
      const items = [], incoming = [];
      for (const t of threads) for (const msg of t.getMessages()) {
        const out = msg.getFrom().toLowerCase().indexOf(me) >= 0;
        items.push({ surveyId: m.surveyId, hotelId: m.hotelId, threadId: t.getId(), msgId: msg.getId(), at: msg.getDate().toISOString(), from: msg.getFrom(), to: msg.getTo(), out: out, subject: msg.getSubject(), body: msg.getPlainBody().slice(0, 12000), files: [] });
        if (!out) { const fm = (msg.getFrom().match(/[^\s<>"]+@[^\s<>"]+/) || [''])[0].toLowerCase(); if (fm) senders[fm] = (senders[fm] || 0) + 1; }
        if (!out) incoming.push('From: ' + msg.getFrom() + '\nDate: ' + msg.getDate().toISOString() + '\nSubject: ' + msg.getSubject() + '\n' + msg.getPlainBody().slice(0, 6000));
      }
      if (items.length) site('post', 'replies', { items: items.slice(-40) });
      if (incoming.length) {
        let result = null, error = '';
        try { result = readText(incoming.slice(-6).join('\n\n----\n\n'), surveyOf(st, m.surveyId), m.name, 'mail'); } catch (e) { error = String(e).slice(0, 280); }
        site('post', 'parsed', { surveyId: m.surveyId, hotelId: m.hotelId, src: 'mail', result: result, error: error });
      }
      const top = Object.keys(senders).sort((a, b) => senders[b] - senders[a])[0] || '';
      site('post', 'mailscan', { surveyId: m.surveyId, hotelId: m.hotelId, email: m.email, ask: !!m.ask, found: items.length, hotelEmail: !m.email && !/noreply|no-reply|mailer-daemon|booking\.com|google\.com/i.test(top) ? top : '' });
    } catch (e) { console.error('mailScan', e); }
  }
}
/** A new hotel: find it on the web (Google Search through Gemini) - official site, city, phone, e-mail - and take photos from its site. */
/** Gemini with a fallback: busy (503) or no quota (429) on one model -> the next one. Returns {code, body}. */
const WEB_MODELS = [MODEL, 'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];   // each has its own free daily quota (2.5-flash: 404 for new users)
function genWeb(payload) {
  let code = 0, body = '';
  for (const m of WEB_MODELS.filter((x, i, a) => a.indexOf(x) === i)) {
    const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { 'x-goog-api-key': P('GEMINI_KEY') }, payload: JSON.stringify(payload),
    });
    code = r.getResponseCode(); body = r.getContentText();
    if (code < 300 || (code !== 429 && code !== 503 && code !== 404)) break;
    console.log('webLook: ' + m + ' ' + code + (payload.tools ? ' (search)' : ''));
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
/** Free web search (DuckDuckGo's plain page): [{url, title, snippet}]. */
function ddg(q) {
  const r = UrlFetchApp.fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=il-he', { muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'he,en;q=0.8' } });
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
  const base = w.name + (w.city ? ' ' + w.city : '');
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
      if (!answered) { answered = true; found = false; hotel = { found: false }; }   // nothing found on the web: counted as a try, no AI guess
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
      const siteUrl = String(hotel.website || w.website || '');
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
    site('post', 'web', { surveyId: w.surveyId, hotelId: w.hotelId, found: found, grounded: grounded, hotel: hotel, photos: photos, redo: !!w.redo });
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
  while ((m = re.exec(html)) && out.length < 12) { const u = abs(m[1]); if (u && !/logo|icon|sprite|flag|pixel|avatar|badge/i.test(u)) out.push(u); }
  return [...new Set(out.filter(Boolean))].slice(0, 8);
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
  const r = genWeb({ contents: [{ role: 'user', parts: [part, { text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.1 } });
  if (r.code >= 300) throw new Error('gemini ' + r.code + ' ' + String(r.body).slice(0, 300));
  const j = JSON.parse(r.body);
  const text = (((j.candidates || [])[0] || {}).content || { parts: [] }).parts.map(p => p.text || '').join('');
  return JSON.parse(text);
}
/** Big recordings go through the Gemini Files API (kept there 48 hours, then deleted by Google). */
function uploadToGemini(blob, mime, name) {
  const bytes = blob.getBytes();
  const start = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': P('GEMINI_KEY'), 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(bytes.length), 'X-Goog-Upload-Header-Content-Type': mime },
    payload: JSON.stringify({ file: { display_name: name.slice(0, 100) } }),
  });
  const h = start.getAllHeaders();
  const up = h['x-goog-upload-url'] || h['X-Goog-Upload-URL'];
  const r = UrlFetchApp.fetch(up, { method: 'post', contentType: mime, payload: bytes, muteHttpExceptions: true, headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' } });
  const f = JSON.parse(r.getContentText()).file;
  for (let i = 0; i < 30 && f.state === 'PROCESSING'; i++) {
    Utilities.sleep(2000);
    const s = JSON.parse(UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/' + f.name, { headers: { 'x-goog-api-key': P('GEMINI_KEY') } }).getContentText());
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
      const files = msg.getAttachments().slice(0, 5).map(a => {
        try { const f = savedFolder().createFile(a); return { name: a.getName(), url: f.getUrl() }; } catch (e) { return { name: a.getName(), url: '' }; }
      });
      items.push({ surveyId: t.surveyId, hotelId: t.hotelId, threadId: t.threadId, msgId: msg.getId(), at: msg.getDate().toISOString(), from: msg.getFrom(), subject: msg.getSubject(), body: msg.getPlainBody().slice(0, 12000), files: files });
    }
  }
  if (items.length) site('post', 'replies', { items: items });
  for (const it of items.slice(0, 3)) {
    let result = null, error = '';
    try { result = readText('From: ' + it.from + '\nSubject: ' + it.subject + '\n' + it.body, surveyOf(st, it.surveyId), '', 'mail'); } catch (e) { error = String(e).slice(0, 280); }
    try { site('post', 'parsed', { surveyId: it.surveyId, hotelId: it.hotelId, src: 'mail', result: result, error: error }); } catch (e) {}
  }
}
function savedFolder() {
  const n = 'סקר מלונות - קבצים מהמלונות';
  const it = DriveApp.getFoldersByName(n);
  return it.hasNext() ? it.next() : DriveApp.createFolder(n);
}

/* ---------- 6: Google Sheets ---------- */
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
    sh.getRange(1, 1, 1, w).setFontWeight('bold').setBackground('#f3ead7');
    sh.setFrozenRows(1);
  }
}

/* ---------- 0: the phone app sends each recording here ---------- */
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
      st = { windows: (s.windows || []).map(w => ({ from: Date.parse(w.from) || 0, to: w.to ? Date.parse(w.to) || 0 : 0 })), watch: (s.watch || []).map(w => ({ phone: w.phone, from: Date.parse(w.from) || 0, to: Date.parse(w.to) || 0 })), wa: s.wa || [] };
      try { cache.put('phoneJobs', JSON.stringify(st), 60); } catch (err) {}
    }
    return reply({ ok: true, windows: st.windows, watch: st.watch, wa: st.wa || [] });
  }
  // WhatsApp messages from hotels (read on the phone from the notifications) → the site files them and reads the details
  if (b.op === 'wa') {
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 100);
    if (items.length) site('post', 'wa', { items: items });
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
