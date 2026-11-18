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

function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    try { site('post', 'app', { url: ScriptApp.getService().getUrl() || '', secret: P('APP_SECRET'), last: P('APP_LAST') }); } catch (e) { console.error('app', e); }
    const st = site('get', 'status');
    try { recordings(st); } catch (e) { console.error('recordings', e); }
    try { indexCalls(); } catch (e) { console.error('index', e); }
    try { answerAsks(st); } catch (e) { console.error('asks', e); }
    try { outbox(st); } catch (e) { console.error('outbox', e); }
    try { replies(st); } catch (e) { console.error('replies', e); }
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
    const w = windowFor(st, at);
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
      result = listen(f, null, recordedAt(f));
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
function listen(file, sv, at) {
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
  ].join('\n'), { type: 'OBJECT', properties: { summary: { type: 'STRING' }, who: { type: 'STRING' }, duration: { type: 'STRING' },
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
  ].join('\n');

  const schema = {
    type: 'OBJECT',
    properties: {
      relevant: { type: 'BOOLEAN' },
      hotel: { type: 'OBJECT', properties: { name: { type: 'STRING' }, city: { type: 'STRING' }, contact: { type: 'STRING' }, phone: { type: 'STRING' }, email: { type: 'STRING' }, website: { type: 'STRING' } } },
      availability: { type: 'OBJECT', properties: { status: { type: 'STRING', enum: ['unknown', 'available', 'partial', 'full'] }, text: { type: 'STRING' }, rooms: { type: 'STRING' } } },
      prices: { type: 'ARRAY', items: { type: 'OBJECT', properties: { level: { type: 'STRING' }, board: { type: 'STRING' }, price: { type: 'NUMBER' }, currency: { type: 'STRING', enum: ['ILS', 'EUR', 'USD'] }, per: { type: 'STRING' }, note: { type: 'STRING' } } } },
      followUp: { type: 'OBJECT', properties: { needed: { type: 'BOOLEAN' }, date: { type: 'STRING' }, what: { type: 'STRING' } } },
      summary: { type: 'STRING' },
      duration: { type: 'STRING' },
      keyQuotes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { time: { type: 'STRING' }, speaker: { type: 'STRING' }, text: { type: 'STRING' } } } },
      transcript: { type: 'STRING' },
    },
    required: ['relevant'],
  };
  return gemini(part, prompt, schema);
}
function gemini(part, prompt, schema) {
  const r = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-goog-api-key': P('GEMINI_KEY') },
    payload: JSON.stringify({ contents: [{ role: 'user', parts: [part, { text: prompt }] }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.2 } }),
  });
  if (r.getResponseCode() >= 300) throw new Error('gemini ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 300));
  const j = JSON.parse(r.getContentText());
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
