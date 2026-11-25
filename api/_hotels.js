// Hotel survey (סקר מלונות): the manager phones hotels, the work phone records every call, and a small
// Google Apps Script (tools/hotels-apps-script.gs, running in the LBV Google account) does the rest:
// it picks the recordings that were made while "survey mode" was on, lets Gemini transcribe them and pull
// out the hotel's details, availability and prices, and sends the result here. It also sends the e-mails
// written in the admin from the LBV Gmail and brings back the hotels' replies, and keeps a Google Sheet in sync.
//
// Served at /api/hotels (vercel.json rewrites it into /api/quotes, to stay within the plan's function count).
// Storage: Upstash Redis (the same database as the visit counter). Locally: data/hotels.local.json.
//
// Who sees what: a survey belongs to the manager who opened it. The owner sees every survey; anyone else
// sees their own and the ones shared with them. A read-only link can be made for the team.
//
// Admin (logged in):
//   GET                          → { me, mode, connection, surveys }
//   GET  ?survey=<id>            → { survey, hotels }
//   POST { op:"survey", … }      → create / update a survey          DELETE ?survey=<id>
//   POST { op:"hotel", … }       → create / update a hotel           DELETE ?survey=<id>&hotel=<id>
//   POST { op:"note", … }        → add a note to a hotel's history
//   POST { op:"mode", on, surveyId }   → survey mode on / off (only recordings made while it is on are read)
//   POST { op:"mail", … }        → queue an e-mail to a hotel (sent by the script from the LBV Gmail)
//   POST { op:"share", surveyId, users, link } → share with other managers / turn the read-only link on
//   POST { op:"connect" }        → a new key for the Apps Script (shown once)
// Read-only link:  GET ?view=<id>&t=<token>
// The Apps Script (header X-LBV-Key):
//   GET  ?script=status   POST ?script=call   POST ?script=mailsent   POST ?script=replies
//   GET  ?script=export   POST ?script=sheet
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isAuthed, readBody } from './_lib.js';
import { redis, redisReady } from './_redis.js';

/* ---------- storage: Redis hashes / keys (or a local JSON file for the preview server) ---------- */
const LOCAL = () => process.env.LBV_LOCAL_DATA || '';
function localLoad() { try { return JSON.parse(fs.readFileSync(LOCAL(), 'utf8')); } catch (e) { return {}; } }
function localSave(db) { fs.mkdirSync(path.dirname(LOCAL()), { recursive: true }); fs.writeFileSync(LOCAL(), JSON.stringify(db)); }
export const hotelsReady = () => Boolean(LOCAL() || redisReady());

const kv = {
  async hgetall(key) {
    if (LOCAL()) return localLoad()[key] || {};
    const [r] = await redis([['HGETALL', key]]);
    const out = {};
    if (Array.isArray(r)) for (let i = 0; i < r.length; i += 2) out[r[i]] = r[i + 1];
    else if (r && typeof r === 'object') Object.assign(out, r);
    return out;
  },
  async hget(key, field) {
    if (LOCAL()) return (localLoad()[key] || {})[field] ?? null;
    const [r] = await redis([['HGET', key, field]]);
    return r ?? null;
  },
  async hset(key, field, value) {
    if (LOCAL()) { const db = localLoad(); (db[key] ??= {})[field] = value; return localSave(db); }
    await redis([['HSET', key, field, value]]);
  },
  async hdel(key, field) {
    if (LOCAL()) { const db = localLoad(); if (db[key]) delete db[key][field]; return localSave(db); }
    await redis([['HDEL', key, field]]);
  },
  async del(key) {
    if (LOCAL()) { const db = localLoad(); delete db[key]; return localSave(db); }
    await redis([['DEL', key]]);
  },
};
const getJ = async (key, field, fb = null) => { const v = await kv.hget(key, field); if (v == null) return fb; try { return JSON.parse(v); } catch (e) { return fb; } };
const setJ = (key, field, v) => kv.hset(key, field, JSON.stringify(v));
const allJ = async key => Object.values(await kv.hgetall(key)).map(v => { try { return JSON.parse(v); } catch (e) { return null; } }).filter(Boolean);

// one WhatsApp line for the robot; our own lines (from the linked WhatsApp, lbv-wa) are marked so it knows the question
const waLine = m => (m.mine ? 'הודעה מאיתנו' : 'הודעת וואטסאפ מ' + String(m.from || '').slice(0, 120)) + ' (' + String(m.at || '').slice(0, 40) + '):\n' + String(m.text || '').slice(0, 4000);
const WA_CTX = 'אלה הודעות וואטסאפ עם המקום. הודעה שכתוב בה "מאיתנו" היא שלנו (השאלה), כל השאר מהמקום. אם השאלה שלנו לא מופיעה, לא מנחשים אותה. מסכמים רק עובדות ברורות (מחיר, זמינות, מה יש במקום ומה צריך להביא), כל עובדה במשפט שלם שמובן בלי השאלה (למשל: "בגשם אפשר את החופה בפנים"). תשובה שלא ברור על מה היא עונה, לא כותבים. בלי ציטוטים.\n\n';
const WA_NO_DAYS = 14;   // a number that was read and is not a supplier: not read again for two weeks
const K = {
  waNew: 'wa:new',                  // owner 25.11: last 9 digits → WhatsApp from a number in no card, not saved in the phone (until the robot decides)
  waNo: 'wa:no',                    // last 9 digits → { at } read lately, not a supplier
  surveys: 'hs:surveys',            // id → survey
  hotels: id => 'hs:h:' + id,        // hotelId → hotel (with its history)
  pend: 'hs:pend',                   // 'list' → calls picked on the phone, waiting to be searched for a question
  users: 'hs:user',                  // userId → { mode, windows, keyHash, ping }
  keys: 'hs:keys',                   // sha256(key) → userId
  out: 'hs:out',                     // mail id → queued e-mail
  files: 'hs:files',                 // recording file id → hotel it went to (or "skip")
  calls: 'hs:calls',                 // every recording on the work phone: file id → { name, phone, at, url, ask, sum }
  ilan: 'hs:ilan',                   // owner 19.11: calls with Ilan → what he asks for. 'cfg' → { phones, since }
  ilanCalls: 'hs:ilan:c',            // recording file id → { at, file, summary, wants, quotes, transcript }
  ilanTasks: 'hs:ilan:t',            // task id → { text, due, quote, callId, at, done, doneAt, by }
  book: 'ph:book',                   // owner 22.11: phone (9 digits) → { cat, name, by, at }: a number we tagged by hand
  wait: 'hs:wait',                   // owner 24.11: calls (and places) the system was not sure which card they belong to → the owner decides
};
const ILAN_SEE = ['cad5d8ff-c32d-4df9-918e-38cfd1d315d8'];   // owner 19.11: besides the owner only מעיין sees the Ilan tasks (not Ilan, not the others)
const ILAN_BACK_DAYS = 7;            // when his number is saved, his calls of the last week are read too
/** One Ilan call (summary, wants, quotes, transcript, tasks) into the tab: from the robot, or (owner 19.11) imported from the computer when Gemini is stuck. */
/** owner 24.11: the same recording uploaded twice to Drive is one call: same file name (without the contact) + same time. */
const callKey = (name, at) => String(name || '').split(' · ').pop().trim() + '|' + String(at || '').slice(0, 19);
/** owner 22.11 + 24.11: who a call is with, by its number (the tags, Ilan, the hotels, the artists, the clients). */
/** owner 24.11: sites that are never a place's own site (booking, reviews, maps, news, encyclopedias, history blogs, directories). */
/** owner 24.11: a recording's file name ("שיחה *6426_261124.m4a") is never the name of a place. */
const fileLike = n => /\.(m4a|mp3|amr|wav|ogg|3gp|aac|opus)\s*$/i.test(String(n || '')) || /^\s*(הקלטת שיחה|שיחה)[\s\u200e\u200f\u202a-\u202e]*[*+\d]/.test(String(n || ''));
const noName = (h, title) => (/אולם|אולמות/.test(title || '') ? 'אולם' : 'מקום') + ' ללא שם' + (digits(h.phone) || String(h.phone || '').trim() ? ' (' + String(h.phone || '').trim() + ')' : '');
const NOT_OWN_SITE = /(^|\.)(gov\.[a-z]{2}|gov|service\.gov|booking|hotel4u|tripadvisor|moovit|wikipedia|wikiwand|google|facebook|instagram|tiktok|youtube|easy\.co|gogo|hotels\.com|expedia|agoda|trivago|kayak|zimmer|zimmeril|rest\.co|mapcarta|waze|ynet|walla|mako|haaretz|maariv|historyistold|yad2|madlan|b144|d\.co\.il|dapei|lametayel|pinterest|linkedin)/i;
const hostOf = u => String(u || '').replace(/^https?:\/\/(www\.)?/i, '').split(/[/?#]/)[0].toLowerCase();
const notOwnSite = u => !!u && NOT_OWN_SITE.test(hostOf(u) + String(u).replace(/^https?:\/\/[^/]+/, ''));
/** owner 24.11: who a call is with by name, for calls with no number ("הקלטת שיחה יצחק מנהל ראש העין_260531_131447.m4a" → "יצחק מנהל ראש העין"). */
export const contactOf = name => {
  const s = String(name || '');
  const base = s.includes(' · ') ? s.split(' · ')[0] : s.replace(/\.(m4a|mp3|amr|wav|aac|ogg|3gp)$/i, '').replace(/^(הקלטת\s+)?שיחה\s*/, '').replace(/[_\s-]*\+?\d[\d_\s-]{5,}$/, '').replace(/_/g, ' ');
  return base.replace(/\s+/g, ' ').trim();
};
const normName = v => String(v || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
/** owner 24.11 (2): Maayan / Ilan are us. A call where one of us asks a place about a date / availability / a price is a call with that PLACE
 *  (a hotel / hall), never a client, supplier or team member, even when the model says so; and our names are never "who". */
const OURS = /(^|[\s"'(])(מעיין|אילן)(?=$|[\s"'),.:])/;
function fixSort(sort) {
  if (!sort || !sort.cat) return sort;
  const x = { ...sort };
  const txt = [x.who, x.sub, x.summary].join(' ');
  const asks = /זמינות|תאריך|הצעת מחיר|מחיר|מינימום|מנות|חדרים|אורחים|מוזמנים/.test(txt);
  if (['client', 'supplier', 'team'].includes(x.cat) && OURS.test(txt) && asks) { x.cat = 'hotel'; x.fixed = true; }
  if (OURS.test(x.who || '')) x.who = '';
  if (x.cat === 'hotel' && !x.who) {
    const m = String(x.summary || '').match(/(אולם|אולמי|מלון|מתחם האירועים|מתחם אירועים|גן האירועים|גן אירועים|וילה)\s*["״]([^"״]{2,40})["״]/);
    if (m && !/^(עבור|של|את|על|לגבי|כדי|אחר|שלה|שלו)$/.test(m[2])) x.who = (m[1].replace(/^מתחם האירועים$/, 'מתחם') + ' ' + m[2]).trim();
  }
  if (x.cat === 'hotel' && !/מלון|אולם|גן|וילה|מתחם|קיבוץ|כפר|רשת/.test(x.sub || '')) x.sub = 'מקום שבדקנו (מלון / אולם)';   // not 'חתונה' / 'שיחה פנימית'
  return x;
}
const SORT_V = 2;
/** owner 24.11: how the robot is doing (each run reports itself), for the "מצב הרובוט" card. */
const HEALTH = 'hs:health';
async function robotHealth() {
  const runs = (await getJ(HEALTH, 'runs')) || [], queue = (await getJ(HEALTH, 'queue')) || {};
  const today = jDay(Date.now()), td = runs.filter(r => jDay(Date.parse(r.at) || 0) === today);
  const sum = k => td.reduce((n, r) => n + ((r.gem || {})[k] || 0), 0);
  const errs = [];
  for (const r of runs.slice(-24).reverse()) for (const e of r.errors || []) if (!errs.some(x => x.text === e) && errs.length < 8) errs.push({ at: r.at, text: e });
  const done = runs.filter(r => !r.killed);
  return { last: done[done.length - 1] || null, killedToday: td.filter(r => r.killed).length, runsToday: td.filter(r => !r.killed).length, gem: { ok: sum('ok'), busy: sum('busy'), quota: sum('quota') }, queue, errors: errs };
}
/** owner 24.11: the robot learns from the owner: calls a person tagged by hand are examples for the next readings. */
async function sortExamples() {
  const book = await kv.hgetall(K.book) || {}, out = [];
  for (const c of (await allJ(K.calls)).sort((a, b) => String(b.at).localeCompare(String(a.at)))) {
    const d = digits(c.phone).slice(-9), raw = book[d] || book['0' + d] || book[digits(c.phone)];
    const tag = raw && (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch (e) { return null; } })() : raw);
    if (!tag || tag.by === 'המערכת' || !c.sort?.summary || ['hide', 'ilan'].includes(tag.cat)) continue;
    out.push({ summary: str(c.sort.summary, 300), cat: tag.cat, who: tag.name || '' });
    if (out.length >= 12) break;
  }
  return out;
}
/** The date in Israel, YYYY-MM-DD. */
const jDay = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
/** owner 24.11: places to call back today: a reminder that is due (its day came), or a "we'll call you back" that nobody answered for a day. */
async function followList(svs) {
  const today = jDay(Date.now()), out = [];
  for (const sv of svs) for (const ho of await allJ(K.hotels(sv.id))) {
    if (['closed', 'no'].includes(ho.status) || !(ho.followUp || ho.followWhat || ho.status === 'followup')) continue;
    const last = (ho.log || []).map(l => l.at).filter(Boolean).sort().pop() || ho.updatedAt || ho.createdAt || '';
    const due = ho.followUp || (last ? jDay((Date.parse(last) || Date.now()) + 864e5) : today);
    if (due > today) continue;
    out.push({ surveyId: sv.id, title: sv.title || '', hotelId: ho.id, name: ho.name || '', phone: ho.phone || '', what: ho.followWhat || '', due, last, late: due < today });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due)).slice(0, 40);
}   // owner 24.11: calls read with older rules are read again
const SORT_CATS = ['hotel', 'artist', 'client', 'supplier', 'attraction', 'team', 'private', 'other'];
async function whoMap() {
  const book = Object.fromEntries(Object.entries(await kv.hgetall(K.book) || {}).map(([k, v]) => { try { return [k, JSON.parse(v)]; } catch (e) { return [k, null]; } }));
  const cfg = await ilanCfg();
  const files = await kv.hgetall(K.files) || {};
  const byPhone = new Map(), byHotelId = new Map();
  const put = (d, x) => { if (d.length >= 8 && !byPhone.has(d)) byPhone.set(d, x); };
  for (const p of cfg.phones || []) put(digits(p), { cat: 'ilan', who: 'אילן' });
  for (const sv of await allJ(K.surveys)) for (const ho of await allJ(K.hotels(sv.id))) {
    const x = { cat: 'hotel', who: ho.name || '', sub: [ho.contact, ho.city].filter(Boolean).join(', '), surveyId: sv.id, hotelId: ho.id, survey: sv.title };
    byHotelId.set(ho.id, x); put(digits(ho.phone), x); put(digits(ho.phone2), x);
  }
  const artists = await allJ('ar:all');
  for (const a of artists) for (const c of a.contacts || []) put(digits(c.phone), { cat: 'artist', who: a.name, sub: [c.name, c.role].filter(Boolean).join(', '), artistId: a.id, color: a.color });
  for (const e of await allJ('ev:all')) {
    const a = e.artist && artists.find(x => x.id === e.artist);
    put(digits(e.phone), { cat: 'client', who: e.client || e.title || '', sub: [e.title, e.date].filter(Boolean).join(', '), eventId: e.id, artistId: a?.id, artist: a?.name, color: a?.color });
  }
  for (const f of await allJ('fn:all')) put(digits(f.phone), { cat: 'attraction', who: f.name || '', sub: [f.supplier, f.area].filter(Boolean).join(', '), funId: f.id });
  const hideNames = new Set(Object.keys(await kv.hgetall('hs:hidenames') || {}));
  const callDigits = c => digits(c.phone) || digits((String(c.name || '').match(/(\+?972|0)\d[\d\- ]{7,12}/) || [''])[0]);
  const whoOf = c => {
    const d = callDigits(c), f = files[c.id];
    const nm = normName(contactOf(c.name));
    if (nm.length >= 3 && hideNames.has(nm)) return { d, k: { cat: 'hide', who: contactOf(c.name) } };
    const fs2 = fixSort(c.sort);
    const sortK = fs2?.cat ? { cat: fs2.cat, who: fs2.who || '', sub: fs2.sub || '', auto: true, ...(c.sort.funId ? { funId: c.sort.funId } : {}) } : null;
    // what the system set by itself follows the newest reading of the call (with today's rules); what a person set always wins
    let k = book[d] ? (book[d].by === 'המערכת' && sortK ? sortK : { cat: book[d].cat, who: book[d].name, byHand: book[d].by !== 'המערכת', auto: book[d].by === 'המערכת' }) : byPhone.get(d);
    if (!k && f === 'ilan') k = { cat: 'ilan', who: 'אילן' };
    if (!k && f && f !== 'skip' && f !== 'wait' && byHotelId.has(f)) k = byHotelId.get(f);
    if (!k && f === 'wait') k = { cat: 'hotel', who: contactOf(c.name), sub: 'מחכה באזור ההמתנה בבדיקת מלונות' };
    // owner 24.11: the contact's name says what it is ("אולם קדמא", "מלון ...")
    if (!k && /(^|\s)(אולם|אולמי|מלון|גן אירועים|גני אירועים|וילה|hotel|venue)(\s|$)/i.test(contactOf(c.name))) k = { cat: 'hotel', who: contactOf(c.name), byName: true };
    if (!k && sortK) k = sortK;
    return { d, k };
  };
  return { whoOf };
}

/** owner 24.11: a call about an attraction fills the attractions catalog by itself (the same attraction once: by its number or its name). */
async function funFromCall(c, x, phone, src = 'call', into = null) {
  const name = str(x?.name, 100) || into?.name || ''; if (!name) return null;
  const norm = v => String(v || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
  const d = digits(phone);
  const all = await allJ('fn:all');
  let f = into || all.find(a => d.length >= 8 && digits(a.phone) === d) || all.find(a => norm(a.name) && norm(a.name) === norm(name));
  const num = v => { const n = Number(String(v ?? '').replace(/[,\s₪€$]/g, '')); return Number.isFinite(n) && n > 0 && n < 1e8 ? n : null; };
  const KIND = ['show', 'workshop', 'sport', 'team', 'food', 'tour', 'kids', 'party', 'other'];
  const fresh = !f;
  if (!f) f = { id: 'f' + crypto.randomBytes(6).toString('hex'), createdAt: now(), by: 'המערכת', name, kind: 'other', area: '', supplier: '', phone: '', price: null, per: 'person', currency: 'ILS', minP: null, maxP: null, hours: '', place: '', kids: false, link: '', notes: '' };
  // what the call said fills what is still empty (never over what a person wrote)
  const fill = (k, v) => { if (v !== null && v !== undefined && v !== '' && (f[k] === null || f[k] === undefined || f[k] === '' || (k === 'kind' && f[k] === 'other'))) f[k] = v; };
  fill('kind', KIND.includes(x.kind) ? x.kind : '');
  fill('area', str(x.area, 80)); fill('supplier', str(x.supplier, 100)); fill('phone', d.length >= 8 ? '0' + d.replace(/^0/, '') : '');
  fill('price', num(x.price)); if (num(x.price) && ['person', 'group', 'hour', 'event'].includes(x.per) && fresh) f.per = x.per;
  fill('minP', num(x.minP)); fill('maxP', num(x.maxP)); fill('hours', str(x.hours, 40));
  if (fresh && typeof x.kids === 'boolean') f.kids = x.kids;
  fill('email', /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(str(x.email, 120)) ? str(x.email, 120) : '');
  f.calls = [...(f.calls || []).filter(y => !c.id || y.callId !== c.id), { src, callId: c.id || '', at: c.at || now(), url: c.url || '', from: str(c.from, 120), summary: str(x.summary, 800), price: str(x.priceText, 300), dates: (Array.isArray(x.dates) ? x.dates : []).map(v => str(v, 60)).filter(Boolean).slice(0, 8), files: (Array.isArray(c.files) ? c.files : []).slice(0, 6).map(y => ({ name: str(y?.name, 120), url: link(y?.url, 300) })).filter(y => y.url) }].slice(-30);
  f.updatedAt = now();
  await setJ('fn:all', f.id, f);
  return f.id;
}

async function saveIlanCall(b) {
  const file = { id: str(b.file?.id, 120), name: str(b.file?.name, 200), url: link(b.file?.url, 400) };
  if (!file.id) return { code: 400, body: { error: 'file' } };
  if (await getJ(K.ilanCalls, file.id)) return { code: 200, body: { ok: true, duplicate: true } };
  const ck = callKey(file.name, b.at);
  const twin = (await allJ(K.ilanCalls)).find(c => !c.hidden && callKey(c.file?.name, c.at) === ck);
  if (twin) { await setJ(K.ilanCalls, file.id, { id: file.id, at: str(b.at, 30), hidden: true, dupOf: twin.id, tasks: [] }); await kv.hset(K.files, file.id, 'ilan'); return { code: 200, body: { ok: true, duplicate: true } }; }
  const r = b.result || {};
  const qs = a => (Array.isArray(a) ? a : []).slice(0, 12).map(x => ({ time: str(x?.time, 8), speaker: str(x?.speaker, 30), text: str(x?.text, 400) })).filter(x => x.text);
  const call = { id: file.id, at: str(b.at, 30) || now(), file, summary: str(r.summary, 3000), wants: (Array.isArray(r.wants) ? r.wants : []).slice(0, 20).map(x => str(x, 400)).filter(Boolean),
    quotes: qs(r.keyQuotes), transcript: str(r.transcript, 40000), duration: str(r.duration, 8), tasks: [] };
  for (const x of (Array.isArray(r.tasks) ? r.tasks : []).slice(0, 25)) {
    const text = str(x?.text, 400); if (!text) continue;
    const same = str(x?.same, 40) ? await getJ(K.ilanTasks, str(x.same, 40)) : null;
    if (same && !same.done) {
      same.also = [...(same.also || []), { callId: file.id, at: call.at, quote: str(x?.quote, 400), text }].slice(-10);
      const due = /^\d{4}-\d{2}-\d{2}$/.test(str(x?.due, 10)) ? str(x.due, 10) : '';
      if (due) same.due = due;   // the newest deadline he said
      await setJ(K.ilanTasks, same.id, same); call.tasks.push(same.id); continue;
    }
    const t = { id: 'it' + crypto.randomBytes(6).toString('hex'), text, due: /^\d{4}-\d{2}-\d{2}$/.test(str(x?.due, 10)) ? str(x.due, 10) : '', when: str(x?.when, 80), quote: str(x?.quote, 400), callId: file.id, at: call.at, done: false, doneAt: null, by: 'robot' };
    await setJ(K.ilanTasks, t.id, t); call.tasks.push(t.id);
  }
  await setJ(K.ilanCalls, file.id, call);
  await kv.hset(K.files, file.id, 'ilan');
  return { code: 200, body: { ok: true, tasks: call.tasks.length } };
}
/** owner 25.11: a WhatsApp line that is not the place talking: our own team (Ilan, La Belle Vie) or a call notice. */
const WA_OURS = /ilan|אילן|belle\s*vie|לה\s*בל\s*וי|\blbv\b/i;
const WA_NOISE = /^\s*(שיחת וידאו|שיחה קולית|שיחת וידאו פעילה|שיחה פעילה|שיחה שלא נענתה|שיחת וידאו שלא נענתה|הודעה זו נמחקה|ההודעה נמחקה|missed (voice|video) call|(voice|video) call|ongoing (voice|video) call|this message was deleted)\s*\.?\s*$/i;
const waNotPlace = (from, text) => WA_OURS.test(String(from || '')) || WA_NOISE.test(String(text || ''));
const waKey = (from, text) => String(from || '').trim() + '|' + String(text || '').replace(/\s+/g, ' ').trim();
async function ilanCfg() { return (await getJ(K.ilan, 'cfg')) || { phones: [], since: null }; }

/* ---------- small helpers ---------- */
const now = () => new Date().toISOString();
const rid = p => p + crypto.randomBytes(6).toString('hex');
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
const num = v => { const n = Number(String(v ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.round(n * 100) / 100 : null; };
const pick = (v, ok, d) => (ok.includes(v) ? v : d);
const digits = p => String(p || '').replace(/\D/g, '').replace(/^972/, '0').slice(-9);
const norm = s => String(s || '').toLowerCase().replace(/["'״׳`.,\-–()]/g, ' ').replace(/\b(מלון|hotel|ה)\b/g, ' ').replace(/\s+/g, ' ').trim();
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
/** A link we store and later show as a button: only https:// (never javascript: or data:). */
const link = (v, max) => { const s = str(v, max); return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : ''; };
const same = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
/** The robot of userId may touch this survey only if it belongs to that user (the owner's robot: every survey). */
const mine = (sv, userId) => !!sv && (userId === 'owner' || sv.by?.id === userId);
const secret = () => process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || 'local';
/** owner 24.11: the link of a page for a client (the places we chose for him), with its own token. */
export const offerToken = id => crypto.createHmac('sha256', secret()).update('offer:' + id).digest('base64url').slice(0, 22);
export const viewToken = id => crypto.createHmac('sha256', secret()).update('hotels:' + id).digest('base64url').slice(0, 22);

const STATUS = ['new', 'followup', 'waiting', 'good', 'closed', 'no'];
const AVAIL = ['unknown', 'available', 'partial', 'full'];
const DEFAULT_LEVELS = ['רגיל', 'משודרג', 'סוויטה', 'חבילת שבת', 'אולם וסעודות'];

function cleanPrices(list) {
  return (Array.isArray(list) ? list : []).slice(0, 40).map(p => ({
    level: str(p.level, 60), board: str(p.board, 60), price: num(p.price), currency: pick(p.currency, ['ILS', 'EUR', 'USD'], 'ILS'),
    per: str(p.per, 60), note: str(p.note, 200),
  })).filter(p => p.level || p.price != null || p.note);
}
function cleanSurvey(b, old = {}) {
  return {
    ...old,
    title: str(b.title ?? old.title, 120) || 'בדיקת מלונות',
    kind: str(b.kind ?? old.kind, 40),            // שבת חתן / בר מצווה / חתונה / חג / אחר
    from: str(b.from ?? old.from, 10), to: str(b.to ?? old.to, 10),
    need: str(b.need ?? old.need, 300),          // e.g. "40 חדרים, 2 מבוגרים + 2 ילדים"
    note: str(b.note ?? old.note, 2000),
    area: str(b.area ?? old.area, 120),
    levels: (Array.isArray(b.levels) ? b.levels : old.levels || DEFAULT_LEVELS).map(x => str(x, 40)).filter(Boolean).slice(0, 8),
    mailLang: pick(b.mailLang ?? old.mailLang, ['he', 'fr', 'en'], 'he'),
    sheet: b.sheet !== undefined ? b.sheet === true : old.sheet !== false,
  };
}
function cleanHotel(b, old = {}) {
  const f = (k, max) => (b[k] !== undefined ? str(b[k], max) : old[k] || '');
  return {
    ...old,
    name: f('name', 120), city: f('city', 80), contact: f('contact', 80), phone: f('phone', 40), phone2: f('phone2', 40),
    email: f('email', 160), website: f('website', 200),
    avail: b.avail !== undefined ? pick(b.avail, AVAIL, 'unknown') : old.avail || 'unknown',
    availText: f('availText', 400), rooms: f('rooms', 200),
    prices: b.prices !== undefined ? cleanPrices(b.prices) : old.prices || [],
    status: b.status !== undefined ? pick(b.status, STATUS, 'new') : old.status || 'new',
    followUp: f('followUp', 10), followWhat: f('followWhat', 300),
    notes: f('notes', 4000), summary: f('summary', 1500),
    log: old.log || [],
  };
}
const minPrice = h => { const p = (h.prices || []).map(x => x.price).filter(x => x != null && x > 0); return p.length ? Math.min(...p) : null; };
const brief = h => ({ ...h, log: undefined, calls: (h.log || []).filter(x => x.t === 'call').length, mails: (h.log || []).filter(x => x.t === 'mail-in' || x.t === 'mail-out').length, last: (h.log || []).map(x => x.at).sort().pop() || h.updatedAt, min: minPrice(h) });

/* ---------- who may see / change what ---------- */
const meId = s => s.id || s.n;
const isOwner = s => s.r === 'owner';
const canSee = (s, sv) => sv && (isOwner(s) || sv.by?.id === meId(s) || (sv.shared || []).includes(meId(s)));
const canManage = (s, sv) => sv && (isOwner(s) || sv.by?.id === meId(s));

/* ---------- one search: words in everything said or written about a hotel ---------- */
const flat = s => String(s || '').toLowerCase().replace(/["'״׳`]/g, '').replace(/\s+/g, ' ');
// Hebrew glues ו/ה/ב/ל/מ/ש/כ to the word: "לשבת" also finds "שבת"
const hasWord = (txt, w) => txt.includes(w) || (w.length > 3 && 'והבלמשכ'.includes(w[0]) && txt.includes(w.slice(1)));
const textWords = raw => flat(str(raw, 120)).replace(/[.,;:!?()\-–]/g, ' ').split(' ').filter(w => w.length >= 2 && !/^\d{7,}$/.test(w)).slice(0, 6);
const KIND = { call: 'בשיחה', 'mail-in': 'במייל מהמלון', 'mail-out': 'במייל שנשלח', wa: 'בוואטסאפ', text: 'בטקסט שנקרא', note: 'בהערה' };
function textHits(h, words) {
  const head = flat([h.name, h.city, h.contact, h.email, h.availText, h.summary, h.notes, h.about, h.reviewsText, ...(h.prices || []).map(p => [p.level, p.board, p.price, p.per, p.note].join(' '))].join(' '));
  const logs = (h.log || []).map(l => ({ l, txt: [l.summary, l.availText, l.subject, l.body, l.text, l.from, ...(l.quotes || []).map(x => x.text), l.transcript].filter(Boolean).join(' \n ') }));
  const all = head + ' ' + logs.map(o => flat(o.txt)).join(' ');
  if (!words.every(w => hasWord(all, w))) return null;
  const where = [];
  for (const o of logs.sort((a, b) => (b.l.at || '').localeCompare(a.l.at || ''))) {
    const low = flat(o.txt);
    const w = words.find(x => hasWord(low, x));
    if (!w) continue;
    let i = low.indexOf(w); if (i < 0) i = low.indexOf(w.slice(1));
    where.push({ kind: KIND[o.l.t] || 'בהיסטוריה', at: o.l.at || '', text: o.txt.replace(/\s+/g, ' ').slice(Math.max(0, i - 60), i + 120) });
    if (where.length >= 3) break;
  }
  if (!where.length) where.push({ kind: 'בפרטי המלון', at: '', text: [h.summary, h.availText, h.notes].filter(Boolean).join(' · ').slice(0, 180) });
  return where;
}

/** Calls with a hotel's number join it by themselves: from 2 weeks before it was added until 2 weeks after (owner 19.11). */
const WATCH_DAYS = 14;
function robotJobs(sv, hotels) {
  const watch = [], parses = [], mailScan = [], webLook = [], wa = [], webRedo = [], relisten = [], mailAuto = [], photoCheck = [];
  for (const h of hotels) {
    const t = Date.parse(h.createdAt || h.updatedAt || 0) || 0;
    for (const ph of [h.phone, h.phone2]) { const d = digits(ph); if (d.length >= 8 && Date.now() < t + WATCH_DAYS * 864e5) watch.push({ surveyId: sv.id, hotelId: h.id, phone: d, from: new Date(t - WATCH_DAYS * 864e5).toISOString(), to: new Date(t + WATCH_DAYS * 864e5).toISOString() }); }
    for (const p of (h.parse || []).slice(0, 3)) parses.push({ surveyId: sv.id, hotelId: h.id, id: p.id, text: p.text, name: h.name, src: p.src || 'paste' });
    // owner 25.11: WhatsApp messages newer than the last reading of the WhatsApp → read (once more, at most 4 tries)
    const waRead = h.waReadAt || (h.log || []).filter(l => l.t === 'text' && l.src === 'wa').map(l => l.at).sort().pop() || '';
    const unread = (h.log || []).filter(l => l.t === 'wa' && String(l.at || '') > String(waRead) && !/^\s*[\u{1F4F7}\u{1F3A5}]/u.test(l.text || ''));
    if (unread.some(m => !m.mine) && !(h.parse || []).some(p => p.src === 'wa') && (h.waTry || 0) < 4)
      parses.push({ surveyId: sv.id, hotelId: h.id, id: 'wacatch', name: h.name, src: 'wa', text: WA_CTX + unread.map(waLine).join('\n\n').slice(0, 20000) });
    // WhatsApp: hotels added in the last 60 days, by number + hotel name + contact person
    if (Date.now() < t + 60 * 864e5) for (const ph of [h.phone, h.phone2]) { const d = digits(ph).slice(-9); if (d.length >= 8) wa.push({ phone: d, names: [h.name, h.contact].map(x => String(x || '').trim()).filter(x => x.length >= 3) }); }
    const em = String(h.email || '').trim().toLowerCase();
    if (h.mailAsk) mailScan.unshift({ surveyId: sv.id, hotelId: h.id, email: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(em) ? em : '', name: h.name || '', phone: digits(h.phone).slice(-9), ask: true });
    else if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(em) && h.mailScan !== em) mailScan.push({ surveyId: sv.id, hotelId: h.id, email: em, name: h.name });
    // owner 24.11: the mail is checked by itself, every few hours, for every place (by its address, or by its name / number)
    else if (cardLive(sv) && Date.now() - (Date.parse(h.mailAt || 0) || 0) > MAIL_EVERY && (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(em) || norm(h.name).length >= 4 || digits(h.phone).length >= 8))
      mailAuto.push({ surveyId: sv.id, hotelId: h.id, email: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(em) ? em : '', name: h.name || '', phone: digits(h.phone).slice(-9), auto: true, at: h.mailAt || '' });
    // owner 24.11: only real photos of the place (no logos, icons, flags, banners): the photos already on a card are checked once
    if ((h.photosCand || []).length && h.website) photoCheck.unshift({ surveyId: sv.id, hotelId: h.id, name: h.name || '', city: h.city || '', website: h.website, photos: h.photosCand.slice(0, 12), cand: true });
    else if (((h.photos || []).length || h.website || h.about) && (h.photosOk || 0) < 2) photoCheck.push({ surveyId: sv.id, hotelId: h.id, name: h.name || '', city: h.city || '', website: h.website || '', photos: (h.photos || []).slice(0, 12) });
    // a new hotel: the robot looks it up on the web once (website, photos, missing details) - owner 19.11
    if (h.name && !/ללא שם/.test(h.name) && (h.webV || 0) < 7 && (h.webTries7 || 0) < 4 && !(h.webDone && h.website && ((h.photos || []).length || (h.photosCand || []).length))) webLook.push({ surveyId: sv.id, hotelId: h.id, name: h.name, city: h.city || '', website: h.website || '', avoid: h.webBad || [], hall: /אולם/.test((sv.title || '') + ' ' + (sv.kind || '') + ' ' + h.name) || /^אולם/.test(h.name || '') });
    // looked up without a real web search (no reviews yet): again once the robot can search (Claude key)
    if (h.name && h.webNoSearch && !h.webGrounded && (h.webRedoTries || 0) < 2) webRedo.push({ surveyId: sv.id, hotelId: h.id, name: h.name, city: h.city || '', website: h.website || '', redo: true });
  }
  for (const h of hotels) {
    if (!h.relisten || (h.relistenTries || 0) >= 3) continue;
    const files = (h.log || []).filter(l => l.t === 'call' && l.file?.id).map(l => ({ id: l.file.id, at: l.at }));
    if (files.length) relisten.push({ surveyId: sv.id, hotelId: h.id, files: files.slice(-3) });
  }
  // the mail already in the card is not read again: only new messages
  const seenOf = id => { const h = hotels.find(x => x.id === id); return (h?.log || []).filter(l => l.msgId).map(l => l.msgId).slice(-200); };
  for (const m of mailScan) m.seen = seenOf(m.hotelId);
  mailAuto.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  for (const m of mailAuto) { m.seen = seenOf(m.hotelId); delete m.at; }
  return { watch, parses, mailScan, webLook, wa, webRedo, relisten, mailAuto, photoCheck };
}
const MAIL_EVERY = 4 * 3600e3;   // owner 24.11: each place's mail is checked by itself every 4 hours
const eventPassed = sv => !!cardEnd(sv) && cardEnd(sv) < new Date().toISOString().slice(0, 10);   // owner 25.11: the event's day is over
const cardLive = sv => !cardEnd(sv) || cardEnd(sv) >= new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);   // events that did not pass (a month back)

async function userRec(id) { return (await getJ(K.users, id)) || { mode: { on: false }, windows: [] }; }
/** The robot this person's phone works with: his own if he installed one, otherwise the company's (the owner's). */
async function robotOf(id) { const u = await userRec(id); return (u.keyHash && u.app?.url) || id === 'owner' ? { id, u } : { id: 'owner', u: await userRec('owner') }; }
const saveUser = (id, u) => setJ(K.users, id, u);

/* ---------- owner 24.11: several events at the same time → which card a call (or a place) belongs to ----------
   Decided by what was said: the kind of event (שבת חתן / חתונה / בר מצווה…), words of the card's name and area,
   and a place that is already in one card. Not sure → the waiting area, and the owner says where it goes. */
const KIND_WORDS = {
  'שבת חתן': [['שבת חתן', 4], ['אופרוף', 4], ['aufruf', 4], ['shabbat hatan', 4], ['chabbat hatan', 4], ['shabbat chatan', 4], ['שבת', 2], ['חדרים', 1], ['לינה', 1], ['סעודות', 1], ['קידוש', 1]],
  'חתונה': [['חתונה', 4], ['חופה', 4], ['אולם', 3], ['אולמות', 3], ['גן אירועים', 3], ['mariage', 4], ['houppa', 4], ['salle', 2], ['זירת אירועים', 3], ['זירת האירועים', 3], ['מוזמנים', 2], ['אורחים', 1], ['קבלת פנים', 1], ['מנות', 1], ['רחבה', 1]],
  'בר מצווה': [['בר מצווה', 4], ['בר מצוה', 4], ['bar mitsva', 4], ['bar mitzvah', 4], ['תפילין', 2]],
  'בת מצווה': [['בת מצווה', 4], ['בת מצוה', 4], ['bat mitsva', 4], ['bat mitzvah', 4]],
  'חג': [['פסח', 3], ['סוכות', 3], ['ראש השנה', 3], ['שבועות', 3], ['pessah', 3], ['souccot', 3], ['חג', 1]],
};
const CARD_SKIP = new Set(['בדיקת', 'מלונות', 'מלון', 'משפחת', 'אירוע', 'הכל', 'הכול', 'כללי', 'אחר']);
const cardEnd = sv => sv.to || sv.from || '';
const HE_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
/** Ways the card's days can be said or written in a call (each day from "from" to "to", at most 7). */
function cardDates(sv) {
  const out = [];
  const a = Date.parse(sv.from), b = Date.parse(sv.to || sv.from);
  if (!a) return out;
  for (let t = a, i = 0; t <= (b || a) && i < 7; t += 864e5, i++) {
    const d = new Date(t), day = d.getUTCDate(), m = d.getUTCMonth();
    out.push(new RegExp('(^|[^\\d])0?' + day + '\\s?[./\\-]\\s?0?' + (m + 1) + '([^\\d]|$)'));
    out.push(new RegExp('(^|[^\\d])' + day + '\\s?(ב|ל)?(' + HE_MONTHS[m] + '|' + FR_MONTHS[m] + ')'));
  }
  return out;
}
async function openCards(userId) {
  const day = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  return (await allJ(K.surveys)).filter(sv => mine(sv, userId) && !sv.closed && (!cardEnd(sv) || cardEnd(sv) >= day));
}
function cardScore(sv, text, hotels, h) {
  const t = flat(text);
  let score = 0; const why = [];
  const kw = KIND_WORDS[sv.kind] || (/חתן/.test(sv.title) ? KIND_WORDS['שבת חתן'] : /חתונ|אולמ/.test(sv.title) ? KIND_WORDS['חתונה'] : []);
  let kindPts = 0;
  let said = false;
  for (const [w, p] of kw) if (t.includes(w)) { kindPts += p; if (p >= 3) why.push(w); if (p >= 4) said = true; }
  score += Math.min(kindPts, 6);
  for (const w of flat(sv.title + ' ' + (sv.area || '')).split(/[\s,.\-/]+/)) if (w.length >= 3 && !CARD_SKIP.has(w) && t.includes(w)) { score += 2; if (!why.includes(w)) why.push(w); }
  // owner 24.11: the card's date said in the call (25.3, 25/03, 25 במרץ…) is a strong sign
  if (sv.from && cardDates(sv).some(re => re.test(t))) { score += 4; why.push('התאריך ' + sv.from.slice(8, 10).replace(/^0/, '') + '.' + sv.from.slice(5, 7).replace(/^0/, '')); }
  if (h && hotels && findHotel(hotels, h)) { score += 4; why.push('המקום כבר בכרטיסייה'); }
  return { surveyId: sv.id, title: sv.title, score, why: why.slice(0, 4), said };
}
/** The best card, or null when it is not clear. */
function bestCard(scores) {
  const s = [...scores].sort((a, b) => b.score - a.score);
  if (!s.length) return null;
  if (s.length === 1) return s[0];
  return s[0].score >= 3 && s[0].score - s[1].score >= 2 ? s[0] : null;
}
const callText = r => [r.hotel?.name, r.summary, ...(Array.isArray(r.places) ? r.places.map(p => (p?.name || '') + ' ' + (p?.note || '')) : []), str(r.transcript, 12000)].filter(Boolean).join('\n');
const hotelText = h => [h.name, h.summary, h.availText, h.notes, ...(h.log || []).map(l => [l.summary, l.text, str(l.transcript, 6000), l.subject, l.body].filter(Boolean).join(' '))].filter(Boolean).join('\n');
async function waitList(s) {
  const own = isOwner(s), uid = meId(s);
  // owner 24.11: also everyone who manages one of the cards it may go to (the owner on another computer / account saw nothing)
  const svs = new Map((await allJ(K.surveys)).map(x => [x.id, x]));
  const mayManage = id => { const sv = svs.get(id); return !!sv && canManage(s, sv); };
  return (await allJ(K.wait)).filter(w => own || w.userId === uid || (w.cards || []).some(c => mayManage(c.surveyId || c.id || c)) || mayManage(w.from) || mayManage(w.to)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 60)
    .map(w => ({ id: w.id, type: w.type, at: w.at, name: w.name, summary: w.summary, transcript: str(w.transcript, 4000), cards: w.cards, from: w.from, hotelId: w.hotelId, fromTitle: w.fromTitle, to: w.to, toTitle: w.toTitle, why: w.why }));
}

async function moveHotel(res, s, fromId, hotelId, toId) {
  const from = await getJ(K.surveys, fromId), to = await getJ(K.surveys, toId);
  if (!canManage(s, from) || !canManage(s, to) || from.id === to.id) return send(res, 404, { error: 'not-found' });
  const ho = await getJ(K.hotels(from.id), hotelId);
  if (!ho) return send(res, 404, { error: 'not-found' });
  ho.log = [...(ho.log || []), { t: 'note', at: now(), by: s.n || '', text: 'הועבר מהכרטיסייה "' + (from.title || '') + '" לכרטיסייה "' + (to.title || '') + '".' }].slice(-80);
  ho.updatedAt = now();
  await setJ(K.hotels(to.id), ho.id, ho);   // same id: the calls that point to it still find it
  await kv.hdel(K.hotels(from.id), ho.id);
  for (const w of await allJ(K.wait)) if (w.type === 'move' && w.hotelId === ho.id) await kv.hdel(K.wait, w.id);
  return send(res, 200, { ok: true, moved: true, to: to.id, toTitle: to.title, id: ho.id });
}

/* ---------- merging what Gemini heard into a hotel ---------- */
function findHotel(hotels, h) {
  const d = digits(h.phone);
  if (d.length >= 8) { const m = hotels.find(x => digits(x.phone) === d || digits(x.phone2) === d); if (m) return m; }
  const n = norm(h.name);
  if (n.length >= 3) return hotels.find(x => { const xn = norm(x.name); return xn && (xn === n || xn.includes(n) || n.includes(xn)); }) || null;
  return null;
}
function mergeCall(hotel, r, call) {
  const g = r.hotel || {};
  for (const k of ['name', 'city', 'contact', 'phone', 'email', 'website']) if (!hotel[k] && g[k]) hotel[k] = str(g[k], 160);
  if (g.phone && hotel.phone && digits(g.phone) !== digits(hotel.phone) && !hotel.phone2) hotel.phone2 = str(g.phone, 40);
  const a = r.availability || {};
  if (a.status && a.status !== 'unknown') { hotel.avail = pick(a.status, AVAIL, hotel.avail || 'unknown'); hotel.availText = str(a.text, 400); }
  if (a.rooms) hotel.rooms = str(a.rooms, 200);
  // New prices replace the old ones for the same level + board; others are kept.
  const fresh = cleanPrices(r.prices);
  if (fresh.length) {
    const key = p => norm(p.level) + '|' + norm(p.board);
    const keep = (hotel.prices || []).filter(p => !fresh.some(f => key(f) === key(p)));
    hotel.prices = [...keep, ...fresh];
  }
  if (r.followUp?.needed) {
    // owner 24.11: "I'll check and call you back" → if nobody came back within a day, it shows in "לחזור אליהם היום"
    const base = Date.parse(call?.at || '') || Date.now();
    hotel.followUp = /^\d{4}-\d{2}-\d{2}$/.test(str(r.followUp.date, 10)) ? str(r.followUp.date, 10) : jDay(base + 864e5);
    hotel.followWhat = str(r.followUp.what, 300) || 'לוודא שחזרו אלינו';
    hotel.followAt = now();
    if (['new', 'waiting', 'followup'].includes(hotel.status || 'new')) hotel.status = 'followup';
  } else if (r.followUp && r.followUp.needed === false && hotel.status === 'followup') {
    hotel.followUp = ''; hotel.followWhat = ''; hotel.status = 'new';   // they came back: nothing is open any more
  }
  if (r.summary) hotel.summary = str(r.summary, 1500);
  hotel.log = [...(hotel.log || []), call].slice(-80);
  return hotel;
}

/* ---------- e-mail draft (no AI needed: built from what is known) ---------- */
const dmy = iso => (iso || '').split('-').reverse().join('.');
export function mailDraft(sv, h) {
  const lastCall = (h.log || []).filter(x => x.t === 'call').pop();
  const dates = sv.from ? (sv.to && sv.to !== sv.from ? `${dmy(sv.from)} – ${dmy(sv.to)}` : dmy(sv.from)) : '';
  const lang = sv.mailLang || 'he';
  if (lang === 'fr') return {
    subject: `Demande de disponibilité et de tarifs${dates ? ' – ' + dates : ''} – La Belle Vie`,
    body: `Bonjour${h.contact ? ' ' + h.contact : ''},\n\n${lastCall ? `Suite à notre conversation téléphonique du ${dmy(lastCall.at.slice(0, 10))}, ` : ''}nous souhaiterions recevoir par écrit votre disponibilité et vos tarifs${dates ? ` pour la période du ${dates}` : ''}.\n${sv.need ? `\nNotre besoin : ${sv.need}\n` : ''}\nMerci de préciser les tarifs par type de chambre et par formule (petit-déjeuner, demi-pension, pension complète).\n\nBien cordialement,\nLa Belle Vie`,
  };
  if (lang === 'en') return {
    subject: `Availability and rates request${dates ? ' – ' + dates : ''} – La Belle Vie`,
    body: `Hello${h.contact ? ' ' + h.contact : ''},\n\n${lastCall ? `Following our phone call on ${dmy(lastCall.at.slice(0, 10))}, ` : ''}we would like to receive your availability and rates in writing${dates ? ` for ${dates}` : ''}.\n${sv.need ? `\nWhat we need: ${sv.need}\n` : ''}\nPlease list the rates per room type and board (B&B, half board, full board).\n\nBest regards,\nLa Belle Vie`,
  };
  return {
    subject: `בקשת זמינות ומחירים${dates ? ' – ' + dates : ''} – La Belle Vie`,
    body: `שלום${h.contact ? ' ' + h.contact : ''},\n\n${lastCall ? `בהמשך לשיחה הטלפונית שלנו מיום ${dmy(lastCall.at.slice(0, 10))}, ` : ''}נשמח לקבל בכתב את הזמינות והמחירים${dates ? ` לתאריכים ${dates}` : ''}.\n${sv.need ? `\nמה שאנחנו צריכים: ${sv.need}\n` : ''}\nנבקש לפרט מחיר לפי סוג חדר ולפי הלינה (לינה וארוחת בוקר, חצי פנסיון, פנסיון מלא).\n\nתודה רבה,\nLa Belle Vie`,
  };
}

/* ---------- the table for Google Sheets / CSV ---------- */
const AV_HE = { unknown: 'לא ידוע', available: 'יש מקום', partial: 'מקום חלקי', full: 'תפוס' };
const ST_HE = { new: 'חדש', followup: 'לחזור אליהם', waiting: 'מחכים להצעה', good: 'מתאים', closed: 'נסגר', no: 'לא רלוונטי' };
/** owner 24.11: what the place said about each date, read from its availability text ("25.03.2027 תפוס, 24.03.2027 פנוי").
 *  { '2027-03-25': 'taken', '2027-03-24': 'free' }. A date with no word near it is 'said' (mentioned, status unclear). */
function datesSaid(text, year) {
  const t = String(text || ''), out = {}, re = /(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/g, hits = [];
  let m;
  while ((m = re.exec(t))) {
    const d = +m[1], mo = +m[2]; let y = m[3] ? +m[3] : +year || new Date().getFullYear(); if (y < 100) y += 2000;
    if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    hits.push({ iso: y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'), s: m.index, e: m.index + m[0].length });
  }
  const word = s => /בספק|אולי|בבדיקה|לבדוק|ממתינ|יבדוק|יבדקו|לא בטוח|maybe/i.test(s) ? 'maybe' : /לא פנוי|אין מקום|תפוס|תפוסה|מלא|סגור|complet|booked|not available/i.test(s) ? 'taken' : /פנוי|פנויה|יש מקום|זמין|אפשרי|libre|available|free/i.test(s) ? 'free' : '';
  hits.forEach((x, i) => {
    const after = t.slice(x.e, i + 1 < hits.length ? hits[i + 1].s : t.length).split(/[.;\n]/)[0];
    const before = t.slice(i ? hits[i - 1].e : 0, x.s).split(/[.;\n,]/).pop();
    const st = word(after) || word(before) || 'said';
    if (!out[x.iso] || out[x.iso] === 'said') out[x.iso] = st;
  });
  return out;
}
/** The place on the preferred date: from the text, or (when the text names no date and the card has this one date) from its availability. */
function onDate(x, pref, svFrom, svTo) {
  const said = datesSaid(x.availText, (pref || svFrom || '').slice(0, 4));
  let st = said[pref] || '';
  if ((!st || st === 'said') && pref && pref === svFrom && (!svTo || svTo === svFrom || !Object.keys(said).length)) st = { available: 'free', partial: 'maybe', full: 'taken' }[x.avail] || st;
  const other = Object.keys(said).filter(d => d !== pref && said[d] === 'free').sort();
  return { st: st === 'said' ? '' : st, other };
}
const PREF_HE = { free: 'פנוי', maybe: 'בספק', taken: 'תפוס', '': 'לא ידוע' };
export { datesSaid, onDate };
/** owner 24.11: the sheet is short and clear: one row per place. The places free on the preferred date first (cheapest first),
 *  then the ones free only on another date (those dates in a column on the side), then unknown, then taken. */
/** owner 25.11: the sheet links to a photo page on the site (=IMAGE needed a Google approval and looked bad). */
export function photosLink(h, origin) {
  const all = [...(h.myPhotos || []), ...(h.photos || [])].map(u => /^media\/uploads\//.test(u || '') ? origin + '/' + u : u).filter(u => /^https:\/\/[^\s"<>]+$/i.test(u || ''));
  let link = origin + '/hotels/photos.html?n=' + encodeURIComponent(h.name || ''), k = 0;
  for (const u of [...new Set(all)].slice(0, 12)) { const add = '&u=' + encodeURIComponent(u); if ((link + add).length > 1900) break; link += add; k++; }
  return k ? { link, k } : null;
}
export function tableRows(sv, hotels, pref, origin) {
  origin = origin || 'https://lbv-portal-phi.vercel.app';
  pref = /^\d{4}-\d{2}-\d{2}$/.test(pref || '') ? pref : sv.from || '';
  // owner 25.11: a photo and the place's site in the sheet; "לחזור אליהם" is for us, not in this table
  const head = ['מקום', 'תמונות', 'אתר', 'עיר', pref ? 'ב-' + dmy(pref) : 'זמינות', 'תאריכים חלופיים', 'הכי זול', 'המחירים', 'מה חשוב לדעת', 'איש קשר וטלפון', 'סטטוס'];
  const q = u => String(u).replace(/"/g, '%22');
  const site = h => /^https?:\/\/[^\s"]+$/i.test(h.website || '') ? h.website : '';
  // a bare phone number would lose its leading 0 in the sheet: kept as text
  const asText = v => /^\+?\d[\d\s\-]*$/.test(String(v || '').trim()) ? "'" + String(v).trim() : v;
  const info = new Map(hotels.map(h => [h, onDate(h, pref, sv.from || '', sv.to || '')]));
  const rank = h => { const o = info.get(h); return h.status === 'no' ? 9 : o.st === 'free' ? 0 : o.st === 'maybe' ? 1 : o.other.length ? 2 : o.st === '' ? 3 : 4; };
  const list = [...hotels].sort((a, b) => rank(a) - rank(b) || (minPrice(a) ?? 1e12) - (minPrice(b) ?? 1e12));
  const sym = c => ({ ILS: '₪', USD: '$', EUR: '€' }[c] || (c ? ' ' + c : '₪'));
  const rows = list.map(h => [
    h.name || '', (p => p ? `=HYPERLINK("${q(p.link)}","${p.k === 1 ? 'לתמונה' : 'לתמונות (' + p.k + ')'}")` : '')(photosLink(h, origin)), site(h) ? `=HYPERLINK("${q(site(h))}","לאתר")` : '',
    h.city || '', (o => o.st === 'free' || o.st === 'maybe' || !o.other.length ? (pref ? PREF_HE[o.st] : AV_HE[h.avail] || 'לא ידוע') : (o.st === 'taken' || h.avail === 'full' ? 'תפוס, ' : '') + 'פנוי בתאריך אחר')(info.get(h)), info.get(h).other.map(dmy).join(', '), minPrice(h) ?? '',
    (h.prices || []).filter(p => p.price > 0).map(p => ([p.level, p.board].filter(Boolean).join(', ') || 'מחיר') + ': ' + Number(p.price).toLocaleString('he-IL') + ' ' + sym(p.currency).trim() + (p.per ? ' ' + p.per : '') + (p.note ? ' (' + p.note + ')' : '')).join('\n'),
    // owner 25.11: everything important that was said (availability, rooms, what is included, extras), not only availability
    (() => { const open = h.followWhat ? 'מה שנשאר פתוח: ' + h.followWhat + (h.followUp ? ' (' + dmy(h.followUp) + ')' : '') : '';
      const parts = [h.availText, h.rooms ? 'חדרים: ' + h.rooms : '', open, h.summary].map(t => String(t || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      return parts.filter((t, i) => !parts.some((o, j) => j !== i && o.length > t.length && o.includes(t))).join('\n').slice(0, 1200); })(),
    asText([h.contact, [h.phone, h.phone2].filter(Boolean).join(' / ')].filter(Boolean).join(' · ')),
    ST_HE[h.status] || '']);
  return [head, ...rows];
}

/* ---------- the handler ---------- */
const send = (res, code, obj) => res.status(code).json(obj);

export default async function hotelsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hotelsReady()) return send(res, 503, { error: 'not-configured' });
  const url = new URL(req.url, 'http://x');
  const q = k => url.searchParams.get(k);
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') { try { body = (await readBody(req)) || {}; } catch (e) { return send(res, 400, { error: 'bad-json' }); } }

  try {
    /* ----- owner 24.11: the page for the client: only the places we chose, the price and the words we wrote for him.
       Never the place's phone, our cost, the calls or anything internal. ----- */
    if (q('offer')) {
      const o = await getJ('hs:offers', q('offer'));
      if (!o || !same(q('t'), offerToken(o.id))) return send(res, 404, { error: 'not-found' });
      const sv = await getJ(K.surveys, o.surveyId);
      const items = [];
      for (const it of o.items || []) {
        const ho = sv && await getJ(K.hotels(sv.id), it.hotelId);
        if (!ho) continue;
        const own = ho.website && !notOwnSite(ho.website);
        items.push({ name: ho.name || '', city: ho.city || '', website: own ? ho.website : '', about: own ? str(ho.about || '', 400) : '',
          photos: own && (ho.photosOk || 0) >= 2 ? (ho.photos || []).slice(0, 4) : [], mine: (ho.myPhotos || []).slice(0, 4),
          price: it.price || null, per: it.per || '', note: it.note || '' });
      }
      return send(res, 200, { title: o.title || sv?.title || '', date: o.date || '', intro: o.intro || '', items, at: o.at });
    }

    /* ----- read-only link for the team ----- */
    if (q('view')) {
      const sv = await getJ(K.surveys, q('view'));
      if (!sv || !sv.link || !same(q('t'), viewToken(sv.id))) return send(res, 404, { error: 'not-found' });
      const hotels = (await allJ(K.hotels(sv.id))).map(h => ({ ...brief(h), notes: undefined, email: undefined }));
      return send(res, 200, { survey: { title: sv.title, from: sv.from, to: sv.to, need: sv.need, area: sv.area, levels: sv.levels }, hotels });
    }

    /* ----- the Apps Script ----- */
    if (q('script')) {
      const key = req.headers['x-lbv-key'];
      const userId = key ? await kv.hget(K.keys, sha(key)) : null;
      if (!userId) return send(res, 401, { error: 'key' });
      return script(req, res, q('script'), userId, body);
    }

    /* ----- the admin ----- */
    const s = req.lbvUser || isAuthed(req);
    if (!s) return send(res, 401, { error: 'login' });
    // owner 25.11: inside the phone app the page reports what the phone has done (last check, errors, version, who is logged in),
    // so a phone that stopped sending calls can be seen from the computer. Any logged-in user; only the owner reads it.
    if (req.method === 'POST' && body.op === 'phonestat') {
      const p = body.p && typeof body.p === 'object' ? body.p : {};
      await setJ('hs:phonestat', String(s.id || s.n || 'x').slice(0, 60), { at: now(), who: s.n || '', role: s.r || '', p: JSON.stringify(p).length > 4000 ? { tooBig: true } : p });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && q('phonestat')) {
      if (s.r !== 'owner') return send(res, 403, { error: 'owner' });
      return send(res, 200, { phones: await allJ('hs:phonestat') });
    }
    const ilanReq = Boolean(q('ilan') || body.op === 'ilan' || q('calls') || body.op === 'tag');   // the Ilan tab has its own rule (owner + מעיין), not the hotels area
    if (!ilanReq && !(await (await import('./_areas.js')).hasArea(s, 'hotels'))) return send(res, 403, { error: 'forbidden' });
    const uid = meId(s);

    /* ----- owner 22.11: every call on the work phone, sorted by who called (by the number): Ilan, a hotel, an artist, a client, other.
       It includes the calls with Ilan, so only the owner and מעיין see it (like the Ilan tab). ----- */
    if (q('calls') || body.op === 'tag') {
      if (!(isOwner(s) || ILAN_SEE.includes(uid))) return send(res, 403, { error: 'forbidden' });
      if (req.method === 'POST') {   // tag a number by hand → every call from it, now and later
        if (body.hideName) {   // owner 24.11: a call with no number: hide everyone with this name, always
          const nm = normName(contactOf(body.hideName));
          if (nm.length < 3) return send(res, 400, { error: 'name' });
          await kv.hset('hs:hidenames', nm, JSON.stringify({ name: contactOf(body.hideName), by: s.n || '', at: now() }));
          return send(res, 200, { ok: true });
        }
        const d = digits(body.phone);
        if (d.length < 8) return send(res, 400, { error: 'phone' });
        if (body.cat === '') { await kv.hdel(K.book, d); return send(res, 200, { ok: true }); }
        const cat = pick(body.cat, ['hotel', 'artist', 'client', 'supplier', 'attraction', 'team', 'private', 'hide', 'other'], 'other');
        await setJ(K.book, d, { cat, name: str(body.name, 80), by: s.n || '', at: now() });
        return send(res, 200, { ok: true });
      }
      const { whoOf } = await whoMap();
      const ilanSum = Object.fromEntries((await allJ(K.ilanCalls)).map(c => [c.id, c.summary || '']));
      const seenKey = new Set();
      let hidden = 0;
      const list = (await allJ(K.calls)).filter(c => !c.dup).sort((a2, b2) => String(b2.at || '').localeCompare(String(a2.at || ''))).filter(c => { const k2 = callKey(c.name, c.at); if (seenKey.has(k2)) return false; seenKey.add(k2); return true; }).slice(0, 300).map(c => {
        const { d, k } = whoOf(c);
        const said = c.sum && !c.sum.error ? str(c.sum.summary || c.sum.answer || '', 600) : str(ilanSum[c.id] || '', 600);
        return { id: c.id, at: c.at, name: c.name, phone: d ? '0' + d.replace(/^0/, '') : '', url: c.url, summary: said || str(c.sort?.summary || '', 600), ...(k || { cat: 'other', who: '' }),
          ...(c.local ? { local: true, full: !!c.full, lang: c.lang || '', text: str(c.sum?.transcript || '', 4000) } : {}) };
      });
      const shown = list.filter(c => { if (c.cat === 'hide') { hidden++; return false; } return true; });   // owner 24.11: a personal number the owner hid: never listed
      const counts = {};
      for (const c of shown) counts[c.cat] = (counts[c.cat] || 0) + 1;
      return send(res, 200, { calls: shown, counts, hidden });
    }

    /* ----- owner 22.11: the hotels catalog: every hotel we ever called, from all the surveys I may see, once each,
       with the lowest price and the latest availability, to search by area / price and see the best options first. ----- */
    if (req.method === 'GET' && q('catalog')) {
      const map = new Map();
      for (const sv of (await allJ(K.surveys)).filter(x => canSee(s, x))) {
        for (const ho of await allJ(K.hotels(sv.id))) {
          if (!ho.name) continue;
          const d = digits(ho.phone) || digits(ho.phone2);
          const key = d.length >= 8 ? 'p' + d : 'n' + norm(ho.name) + '|' + norm(ho.city);
          const last = (ho.log || []).map(l => l.at).filter(Boolean).sort().pop() || ho.updatedAt || ho.createdAt || '';
          const calls = (ho.log || []).filter(l => l.t === 'call').length;
          const kid = p => /ילד|ילדה|ילדים|תינוק|child|kid|enfant|bébé|baby/i.test([p.per, p.level, p.note].join(' '));   // a child's price is not the hotel's price
          const mp = (ho.prices || []).filter(p => p.price > 0 && !kid(p)).sort((a2, b2) => a2.price - b2.price)[0] || null;
          // owner 24.11: a hall / events garden goes to the halls catalog (by its name, or a card about halls)
          const venue = /(^|\s)(אולם|אולמי|אולמות|גן אירועים|גני אירועים|גן|וילה|לופט|venue|hall)(\s|$)/i.test(ho.name) || /אולם|אולמות|venue/i.test([sv.title, sv.kind].join(' '));
          const row = { key, venue, name: ho.name, city: ho.city || '', area: sv.area || '', phone: ho.phone || '', contact: ho.contact || '', website: ho.website || '', rating: ho.rating || null,
            photo: (ho.myPhotos || [])[0] || (ho.photos || [])[0] || '', avail: ho.avail || 'unknown', availText: ho.availText || '', status: ho.status || 'new',
            min: mp ? { price: mp.price, per: mp.per || '', currency: mp.currency || 'ILS', what: [mp.level, mp.board].filter(Boolean).join(', ') } : null,
            prices: (ho.prices || []).slice(0, 6), summary: str(ho.summary || '', 300), lastAt: last, calls,
            about: str(ho.about || '', 220), booked: ho.booked ? [sv.title || ''] : [], after: ho.after ? [{ text: str(ho.after.text, 400), event: ho.after.event || sv.title || '', at: ho.after.at }] : [],
            surveys: [{ surveyId: sv.id, hotelId: ho.id, title: sv.title, from: sv.from || '', to: sv.to || '' }] };
          const old = map.get(key);
          if (!old) { map.set(key, row); continue; }
          const newer = String(row.lastAt) > String(old.lastAt) ? row : old, other = newer === row ? old : row;
          newer.surveys = [...new Map([...old.surveys, ...row.surveys].map(x => [x.surveyId + x.hotelId, x])).values()];
          newer.calls = old.calls + row.calls;
          newer.booked = [...old.booked, ...row.booked].filter(Boolean); newer.after = [...old.after, ...row.after];
          newer.venue = old.venue || row.venue;
          if (!newer.min && other.min) newer.min = other.min;
          if (!newer.photo) newer.photo = other.photo;
          if (!newer.about) newer.about = other.about;
          if (!(newer.prices || []).length) newer.prices = other.prices;
          if (!newer.area) newer.area = other.area;
          map.set(key, newer);
        }
      }
      const wantVenues = q('catalog') === 'venues';
      return send(res, 200, { hotels: [...map.values()].filter(x => !!x.venue === wantVenues) });
    }

    // Owner 19.11: calls with Ilan → a summary of what he asks for + a to-do list. Only the owner sees it.
    if (q('ilan') || body.op === 'ilan') {
      if (!(isOwner(s) || ILAN_SEE.includes(uid))) return send(res, 403, { error: 'forbidden' });   // owner 19.11: only the owner and Maayan
      if (req.method === 'GET') {
        const calls = (await allJ(K.ilanCalls)).filter(c => !c.hidden).sort((a2, b2) => String(b2.at).localeCompare(String(a2.at))).slice(0, 80);
        // (copies of the same call made before 24.11 are cleaned by the robot's merge: see script 'ilanmerge')
        const tasks = (await allJ(K.ilanTasks)).sort((a2, b2) => (a2.done - b2.done) || String(b2.at).localeCompare(String(a2.at)));
        return send(res, 200, { cfg: await ilanCfg(), calls, tasks });
      }
      const act = str(body.act, 20);
      if (act === 'cfg') {
        const phones = [...new Set((Array.isArray(body.phones) ? body.phones : []).map(digits).filter(d => d.length >= 8))].slice(0, 5);
        const old = await ilanCfg();
        const since = old.since && phones.every(p => old.phones.includes(p)) ? old.since : new Date(Date.now() - ILAN_BACK_DAYS * 864e5).toISOString();
        const cfg = { phones, since, mergedV: old.mergedV || 0 };
        await setJ(K.ilan, 'cfg', cfg);
        return send(res, 200, { ok: true, cfg });
      }
      if (act === 'redo') {   // read this call again (the robot picks it up on its next run); my own and done tasks stay
        const c = await getJ(K.ilanCalls, str(body.id, 120));
        if (!c) return send(res, 404, { error: 'not-found' });
        for (const tid of c.tasks || []) { const t = await getJ(K.ilanTasks, tid); if (t && t.by === 'robot' && !t.done) await kv.hdel(K.ilanTasks, tid); }
        await kv.hdel(K.ilanCalls, c.id);
        return send(res, 200, { ok: true });
      }
      if (act === 'hide') {   // owner 19.11: a duplicate call goes away with its open robot tasks; a mark stays so the robot never reads it again
        const c = await getJ(K.ilanCalls, str(body.id, 120));
        if (!c) return send(res, 404, { error: 'not-found' });
        for (const tid of c.tasks || []) { const t = await getJ(K.ilanTasks, tid); if (t && t.by === 'robot' && !t.done) await kv.hdel(K.ilanTasks, tid); }
        await setJ(K.ilanCalls, c.id, { id: c.id, at: c.at, hidden: true, hiddenAt: now(), tasks: [] });
        return send(res, 200, { ok: true });
      }
      if (act === 'import') {   // owner 19.11: a call read on the computer (not by Gemini) goes in the same way as the robot's
        if (!isOwner(s)) return send(res, 403, { error: 'owner' });
        const out = await saveIlanCall(body);
        return send(res, out.code, out.body);
      }
      if (act === 'add') {
        const text = str(body.text, 400); if (!text) return send(res, 400, { error: 'text' });
        const t = { id: 'it' + crypto.randomBytes(6).toString('hex'), text, due: str(body.due, 10), quote: '', callId: '', at: now(), done: false, doneAt: null, by: 'me' };
        await setJ(K.ilanTasks, t.id, t);
        return send(res, 200, { ok: true, task: t });
      }
      const t = await getJ(K.ilanTasks, str(body.id, 40));
      if (!t) return send(res, 404, { error: 'not-found' });
      if (act === 'done') { t.done = !!body.done; t.doneAt = t.done ? now() : null; await setJ(K.ilanTasks, t.id, t); return send(res, 200, { ok: true, task: t }); }
      if (act === 'edit') { if (body.text != null) t.text = str(body.text, 400) || t.text; if (body.due != null) t.due = str(body.due, 10); await setJ(K.ilanTasks, t.id, t); return send(res, 200, { ok: true, task: t }); }
      if (act === 'del') { await kv.hdel(K.ilanTasks, t.id); return send(res, 200, { ok: true }); }
      return send(res, 400, { error: 'act' });
    }

    // "Did I already talk to this number?" → every hotel with that phone (or name) in the surveys I may see,
    // with the last call's date, summary and key sentences.
    if (req.method === 'GET' && q('lookup')) {
      const raw = str(q('lookup'), 80), d = digits(raw), n = norm(raw);
      const out = [];
      for (const sv of (await allJ(K.surveys)).filter(x => canSee(s, x))) {
        for (const h of await allJ(K.hotels(sv.id))) {
          const byPhone = d.length >= 7 && [h.phone, h.phone2].some(p => { const x = digits(p); return x && (x === d || x.endsWith(d) || d.endsWith(x)); });
          const byName = !byPhone && n.length >= 3 && d.length < 7 && norm(h.name).includes(n);
          if (!byPhone && !byName) continue;
          const calls = (h.log || []).filter(l => l.t === 'call').sort((a2, b2) => (b2.at || '').localeCompare(a2.at || ''));
          const last = calls[0];
          const lastAny = (h.log || []).map(l => l.at).sort().pop();
          out.push({ surveyId: sv.id, survey: sv.title, id: h.id, name: h.name, city: h.city, contact: h.contact, phone: h.phone, avail: h.avail, availText: h.availText,
            prices: h.prices || [], status: h.status, followUp: h.followUp, followWhat: h.followWhat, summary: h.summary, calls: calls.length, lastAt: last?.at || lastAny || h.updatedAt,
            last: last ? { at: last.at, summary: last.summary, quotes: last.quotes || [], file: last.file } : null });
        }
      }
      out.sort((a2, b2) => (b2.lastAt || '').localeCompare(a2.lastAt || ''));
      // ...and every recorded call on the phone with that number (or contact name in the file name), survey or not
      const phone = (await allJ(K.calls)).filter(c => (isOwner(s) || c.owner === uid) && (
        (d.length >= 7 && (() => { const x = digits(c.phone) || digits((c.name.match(/(\+?972|0)\d[\d\- ]{7,12}/) || [''])[0]); return x && (x === d || x.endsWith(d) || d.endsWith(x)); })()) ||
        (d.length < 7 && n.length >= 2 && norm(c.name).includes(n))))
        .sort((a2, b2) => (b2.at || '').localeCompare(a2.at || '')).slice(0, 10)
        .map(c => ({ id: c.id, at: c.at, name: c.name, phone: c.phone, url: c.url, ask: !!c.ask, q: c.q || '', sum: c.sum || null }));
      // one search for everything (owner 19.11): the words also in calls, mails, WhatsApp, notes, prices of every hotel I may see
      const words = textWords(q('q'));
      const found = [];
      if (words.length) {
        const seen = new Set(out.map(r => r.surveyId + '|' + r.id));
        for (const sv of (await allJ(K.surveys)).filter(x => canSee(s, x))) {
          for (const h of await allJ(K.hotels(sv.id))) {
            if (seen.has(sv.id + '|' + h.id)) continue;
            const where = textHits(h, words);
            if (!where) continue;
            found.push({ surveyId: sv.id, survey: sv.title, id: h.id, name: h.name, city: h.city, rating: h.rating || null, avail: h.avail, min: minPrice(h), prices: (h.prices || []).slice(0, 3), where, lastAt: (h.log || []).map(l => l.at).sort().pop() || h.updatedAt });
          }
        }
        found.sort((a2, b2) => (b2.where.length - a2.where.length) || (b2.lastAt || '').localeCompare(a2.lastAt || ''));
        // ...and calls on the phone whose summary / answer / transcript has the words
        const have = new Set(phone.map(p => p.id));
        for (const c of await allJ(K.calls)) {
          if (have.has(c.id) || !(isOwner(s) || c.owner === uid) || !c.sum || c.sum.error) continue;
          const txt = flat([c.name, c.sum.summary, c.sum.answer, c.sum.who, c.sum.transcript].join(' '));
          if (words.every(w => hasWord(txt, w))) { phone.push({ id: c.id, at: c.at, name: c.name, phone: c.phone, url: c.url, ask: !!c.ask, q: c.q || '', sum: c.sum, byText: true }); if (phone.length >= 15) break; }
        }
      }
      const u = await userRec(uid);
      return send(res, 200, { results: out.slice(0, 10), found: found.slice(0, 15), phone, indexed: !!u.indexedAt || phone.length > 0 });
    }

    // "Yes, summarize that call" → the robot listens to it on its next run (about 5 minutes)
    if (req.method === 'POST' && body.op === 'ask') {
      const c = await getJ(K.calls, str(body.id, 120));
      if (!c || !(isOwner(s) || c.owner === uid)) return send(res, 404, { error: 'not-found' });
      const question = str(body.q, 300).trim();
      if (!c.sum || c.sum.error || (question && c.sum.q !== question)) { c.ask = true; c.q = question; c.sum = null; c.askedAt = now(); await setJ(K.calls, c.id, c); }
      return send(res, 200, { id: c.id, ask: !!c.ask, q: c.q || '', sum: c.sum || null });
    }

    // calls picked on the phone + what to look for: when they reach the robot, it searches them by itself (owner 19.11)
    if (req.method === 'POST' && body.op === 'askLater') {
      const question = str(body.q, 300).trim(), d = digits(body.phone).slice(-9);
      const ats = (Array.isArray(body.at) ? body.at : []).slice(0, 10).map(x => str(x, 40)).filter(x => Date.parse(x));
      if (!question || d.length < 7 || !ats.length) return send(res, 400, { error: 'input' });
      const list = ((await getJ(K.pend, 'list')) || []).filter(p => Date.parse(p.until) > Date.now());
      for (const at of ats) list.push({ phone: d, at, q: question, by: uid, until: new Date(Date.now() + 6 * 3600e3).toISOString() });
      await setJ(K.pend, 'list', list.slice(-60));
      return send(res, 200, { ok: true });
    }

    // "לייבא למלון": a call found on the phone goes into a hotel's history (an existing hotel or a new one in a card)
    if (req.method === 'POST' && body.op === 'attach') {
      const c = await getJ(K.calls, str(body.id, 120));
      if (!c || !(isOwner(s) || c.owner === uid) || !c.sum || c.sum.error) return send(res, 404, { error: 'not-found' });
      const sv = await getJ(K.surveys, str(body.surveyId, 40));
      if (!canSee(s, sv)) return send(res, 404, { error: 'not-found' });
      const key = K.hotels(sv.id);
      let h = body.hotelId ? await getJ(key, str(body.hotelId, 40)) : null;
      if (body.hotelId && !h) return send(res, 404, { error: 'not-found' });
      if (!h) { const nm0 = [str(body.name, 120), c.sum.who].find(x => x && !fileLike(x)) || ''; h = { ...cleanHotel({ name: nm0, phone: c.phone }), id: rid('h'), createdAt: now() }; if (!h.name) h.name = noName(h, sv.title); }
      if ((h.log || []).some(l => l.t === 'call' && l.file?.id === c.id)) return send(res, 200, { ...h, min: minPrice(h), already: true });
      const sm = c.sum;
      h.log = [...(h.log || []), { t: 'call', at: c.at || now(), file: { id: c.id, name: c.name, url: c.url }, dur: sm.duration || '',
        summary: [sm.q && sm.answer ? 'מה שחיפשת (' + sm.q + '): ' + sm.answer : '', sm.summary].filter(Boolean).join('\n\n').slice(0, 1500),
        quotes: [...(sm.answerQuotes || []), ...(sm.quotes || [])].slice(0, 12), avail: 'unknown', availText: '', transcript: sm.transcript || '', by: s.n }].slice(-80);
      h.updatedAt = now();
      await setJ(key, h.id, h);
      return send(res, 200, { ...h, min: minPrice(h) });
    }

    if (req.method === 'GET' && !q('survey')) {
      const u = await userRec(uid);
      const all = (await allJ(K.surveys)).filter(sv => canSee(s, sv)).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
      const surveys = await Promise.all(all.map(async sv => {
        const hs = await allJ(K.hotels(sv.id));
        return { ...sv, mine: sv.by?.id === uid, manage: canManage(s, sv), token: canManage(s, sv) && sv.link ? viewToken(sv.id) : undefined,
          count: hs.length, avail: hs.filter(h => h.avail === 'available' || h.avail === 'partial').length, follow: hs.filter(h => h.status === 'followup').length,
          booked: hs.filter(h => h.booked).map(h => ({ id: h.id, name: h.name || '' })),
          afterAsk: eventPassed(sv) ? hs.filter(h => h.booked && !h.after && !h.afterSkip).map(h => ({ id: h.id, name: h.name || '' })) : [] };
      }));
      const managers = await managerList(req);
      return send(res, 200, { me: { id: uid, name: s.n, role: s.r }, robot: isOwner(s) ? await robotHealth() : undefined, follow: await followList(all), wait: await waitList(s), mode: u.mode || { on: false }, windows: (u.windows || []).slice(-60), wa: await (async () => { const w = []; for (const sv of all) w.push(...robotJobs(sv, await allJ(K.hotels(sv.id))).wa); return w.slice(0, 300); })(), watch: await (async () => { const w = []; for (const sv of all) w.push(...robotJobs(sv, await allJ(K.hotels(sv.id))).watch.map(x => ({ phone: x.phone, from: x.from, to: x.to }))); return w.slice(0, 300); })(), connection: await (async () => { const r = (await robotOf(uid)).u; return { connected: !!r.keyHash, ping: r.ping || null, last: r.lastCall || null, skipped: r.skipped || 0, app: !!r.app?.url, appLast: r.app?.last || null }; })(), surveys, managers });
    }

    // "חיבור האפליקציה": the robot's address + the app secret, handed only to the logged-in owner of that robot
    if (req.method === 'POST' && body.op === 'pair') {
      const u = (await robotOf(uid)).u;
      if (!u.app?.url || !u.app?.secret) return send(res, 409, { error: 'no-robot' });
      return send(res, 200, { url: u.app.url, secret: u.app.secret });
    }

    if (req.method === 'GET' && q('survey')) {
      const sv = await getJ(K.surveys, q('survey'));
      if (!canSee(s, sv)) return send(res, 404, { error: 'not-found' });
      const hotels = (await allJ(K.hotels(sv.id))).map(h => ({ ...h, min: minPrice(h) }));
      const out = (await allJ(K.out)).filter(m => m.surveyId === sv.id);
      for (const h of hotels) for (const m of out.filter(m => m.hotelId === h.id && m.state === 'queued')) h.log.push({ t: 'mail-out', at: m.at, to: m.to, subject: m.subject, body: m.body, state: 'queued', by: m.by });
      return send(res, 200, { survey: { ...sv, manage: canManage(s, sv), token: canManage(s, sv) && sv.link ? viewToken(sv.id) : undefined }, hotels, draftFor: null });
    }

    if (req.method === 'DELETE') {
      const sv = await getJ(K.surveys, q('survey'));
      if (!canManage(s, sv)) return send(res, 403, { error: 'forbidden' });
      if (q('hotel')) { await kv.hdel(K.hotels(sv.id), q('hotel')); return send(res, 200, { ok: true }); }
      await kv.del(K.hotels(sv.id)); await kv.hdel(K.surveys, sv.id);
      return send(res, 200, { ok: true });
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const op = body.op;

    // owner 19.11: a hotel call read on the computer (when Gemini is out of quota) goes in the same way as the robot's
    if (op === 'importCall') {
      if (!isOwner(s)) return send(res, 403, { error: 'owner' });
      return script(req, res, 'call', 'owner', body);
    }

    if (op === 'survey') {
      const old = body.id ? await getJ(K.surveys, body.id) : null;
      if (body.id && !canManage(s, old)) return send(res, 403, { error: 'forbidden' });
      const sv = old ? { ...cleanSurvey(body, old), updatedAt: now() } : { ...cleanSurvey(body), id: rid('s'), by: { id: uid, name: s.n }, shared: [], link: false, createdAt: now() };
      await setJ(K.surveys, sv.id, sv);
      return send(res, 200, sv);
    }

    if (op === 'share') {
      const sv = await getJ(K.surveys, body.surveyId);
      if (!canManage(s, sv)) return send(res, 403, { error: 'forbidden' });
      if (Array.isArray(body.users)) sv.shared = body.users.map(x => str(x, 80)).filter(Boolean).slice(0, 50);
      if (body.link !== undefined) sv.link = body.link === true;
      await setJ(K.surveys, sv.id, sv);
      return send(res, 200, { ...sv, token: sv.link ? viewToken(sv.id) : undefined });
    }

    // owner 24.11: photos from the place's own site, checked by hand (when the robot's check has no Gemini quota). Managers only.
    if (op === 'webPhotos') {
      const sv = await getJ(K.surveys, str(body.surveyId, 40));
      if (!canManage(s, sv)) return send(res, 404, { error: 'not-found' });
      const key = K.hotels(sv.id), h = await getJ(key, str(body.id, 40));
      if (!h || !h.website) return send(res, 400, { error: 'no-site' });
      const ph = (Array.isArray(body.photos) ? body.photos : []).map(u => String(u || '').slice(0, 500)).filter(u => /^https:\/\/[^\s"'<>]+$/i.test(u)).slice(0, 8);
      if (!ph.length) return send(res, 400, { error: 'no-photos' });
      h.photos = [...new Set(ph)]; h.photosOk = 2; delete h.photosCand; h.webDone = true;
      h.log = [...(h.log || []), { t: 'note', at: now(), by: s.n || '', text: 'נוספו ' + h.photos.length + ' תמונות מהאתר של המקום (נבדקו ידנית).' }].slice(-80);
      await setJ(key, h.id, h);
      return send(res, 200, { ok: true, photos: h.photos });
    }
    if (op === 'hotel' || op === 'note' || op === 'mail' || op === 'draft' || op === 'paste' || op === 'photos' || op === 'mailNow' || op === 'relisten' || op === 'booked' || op === 'after') {
      const sv = await getJ(K.surveys, body.surveyId);
      if (!canSee(s, sv)) return send(res, 404, { error: 'not-found' });
      const key = K.hotels(sv.id);
      const old = body.id ? await getJ(key, body.id) : null;
      if (body.id && !old) return send(res, 404, { error: 'not-found' });

      if (op === 'draft') return send(res, 200, mailDraft(sv, old || {}));

      if (op === 'hotel') {
        const h = old ? { ...cleanHotel(body, old), updatedAt: now() } : { ...cleanHotel(body), id: rid('h'), createdAt: now(), updatedAt: now(), log: [] };
        if (!old) h.log.push({ t: 'note', at: now(), by: s.n, text: 'נוסף ידנית' });
        await setJ(key, h.id, h);
        return send(res, 200, { ...h, min: minPrice(h) });
      }
      if (op === 'photos') {
        if (!old) return send(res, 404, { error: 'not-found' });
        const ok = u => /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/hotels\/[^\s"'<>]+$/i.test(u) || /^media\/uploads\/[\w.\-]+$/.test(u);
        const add = (Array.isArray(body.add) ? body.add : []).map(x => String(x || '').slice(0, 500)).filter(ok);
        const rm = new Set((Array.isArray(body.remove) ? body.remove : []).map(x => String(x || '')));
        old.myPhotos = [...(old.myPhotos || []).filter(u => !rm.has(u)), ...add].filter((u, i, a) => a.indexOf(u) === i).slice(0, 40);
        if (rm.size) old.photos = (old.photos || []).filter(u => !rm.has(u));
        if (add.length) old.log = [...(old.log || []), { t: 'note', at: now(), by: s.n, text: add.length === 1 ? 'נוספה תמונה' : `נוספו ${add.length} תמונות` }].slice(-80);
        old.updatedAt = now();
        await setJ(key, old.id, old);
        return send(res, 200, { myPhotos: old.myPhotos, photos: old.photos || [] });
      }
      // owner 25.11: the place we closed with for this event (or not any more)
      if (op === 'booked') {
        if (!old || !canManage(s, sv)) return send(res, 404, { error: 'not-found' });
        const on = body.on !== false;
        if (on) { old.booked = now(); old.status = 'closed'; } else { delete old.booked; if (old.status === 'closed') old.status = 'good'; }
        old.log = [...(old.log || []), { t: 'note', at: now(), by: s.n, text: on ? 'סגרנו עם המקום הזה לאירוע.' : 'בוטל הסימון "סגרנו עם המקום".' }].slice(-80);
        old.updatedAt = now();
        await setJ(key, old.id, old);
        return send(res, 200, { ...old, min: minPrice(old) });
      }
      // owner 25.11: after the event, how it was there (kept with the place, shown in the catalog next time)
      if (op === 'after') {
        if (!old || !canManage(s, sv)) return send(res, 404, { error: 'not-found' });
        if (body.skip === true) { old.afterSkip = now(); await setJ(key, old.id, old); return send(res, 200, { ok: true }); }
        const text = str(body.text, 2000).trim();
        if (text.length < 2) return send(res, 400, { error: 'text' });
        old.after = { text, at: now(), by: s.n || '', event: sv.title || '' };
        old.log = [...(old.log || []), { t: 'note', at: now(), by: s.n, text: 'אחרי האירוע: ' + text }].slice(-80);
        old.updatedAt = now();
        await setJ(key, old.id, old);
        return send(res, 200, { ...old, min: minPrice(old) });
      }
      if (op === 'paste') {
        if (!old) return send(res, 404, { error: 'not-found' });
        const text = str(body.text, 20000);
        if (text.length < 10) return send(res, 400, { error: 'text' });
        old.parse = [...(old.parse || []), { id: rid('p'), text, at: now(), by: s.n }].slice(-5);
        old.log = [...(old.log || []), { t: 'note', at: now(), by: s.n, text: 'הודבק טקסט לקריאה: ' + text.slice(0, 140) + (text.length > 140 ? '…' : '') }].slice(-80);
        await setJ(key, old.id, old);
        return send(res, 200, { ok: true });
      }
      if (op === 'relisten') {
        if (!(old.log || []).some(l => l.t === 'call' && l.file?.id)) return send(res, 400, { error: 'no-call' });
        old.relisten = now(); delete old.relistenTries; delete old.relistenFail;
        await setJ(key, old.id, old);
        return send(res, 200, { ...old, min: minPrice(old) });
      }
      if (op === 'mailNow') {
        old.mailAsk = now(); delete old.mailAskDone;
        await setJ(key, old.id, old);
        return send(res, 200, { ...old, min: minPrice(old) });
      }
      if (op === 'note') {
        const text = str(body.text, 2000);
        if (!text) return send(res, 400, { error: 'empty' });
        // owner 25.11: a note can carry the place's video (uploaded to our storage under hotels/)
        const files = (Array.isArray(body.files) ? body.files : []).slice(0, 4).map(f => ({ name: str(f?.name, 80) || 'קובץ', url: str(f?.url, 500) }))
          .filter(f => /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/hotels\/[^\s"'<>]+$/i.test(f.url) || /^media\/uploads\/[\w.\-]+$/.test(f.url));
        old.log = [...(old.log || []), { t: 'note', at: now(), by: s.n, text, ...(files.length ? { files } : {}) }].slice(-80);
        await setJ(key, old.id, old);
        return send(res, 200, { ...old, min: minPrice(old) });
      }
      if (op === 'mail') {
        const to = str(body.to, 160), subject = str(body.subject, 200), text = str(body.body, 8000);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !subject || !text) return send(res, 400, { error: 'invalid' });
        if (!old.email) { old.email = to; await setJ(key, old.id, old); }
        const m = { id: rid('m'), surveyId: sv.id, hotelId: old.id, owner: sv.by?.id || uid, to, subject, body: text, by: s.n, at: now(), state: 'queued' };
        await setJ(K.out, m.id, m);
        return send(res, 200, { ok: true, mail: m });
      }
    }

    // owner 24.11: a call from the waiting area → into the card the owner chose (or "not for any card")
    // owner 24.11: a reminder to call back: done (they came back / I called), or again tomorrow
    if (op === 'follow') {
      const sv = await getJ(K.surveys, str(body.surveyId, 40));
      if (!canSee(s, sv)) return send(res, 404, { error: 'not-found' });
      const ho = await getJ(K.hotels(sv.id), str(body.id, 40));
      if (!ho) return send(res, 404, { error: 'not-found' });
      if (body.act === 'tomorrow') { ho.followUp = jDay(Date.now() + 864e5); ho.log = [...(ho.log || []), { t: 'note', at: now(), by: s.n || '', text: 'תזכורת: לחזור אליהם מחר.' }].slice(-80); }
      else { ho.log = [...(ho.log || []), { t: 'note', at: now(), by: s.n || '', text: 'טופל: ' + (ho.followWhat || 'לחזור אליהם') }].slice(-80); ho.followUp = ''; ho.followWhat = ''; if (ho.status === 'followup') ho.status = 'new'; }
      ho.updatedAt = now();
      await setJ(K.hotels(sv.id), ho.id, ho);
      return send(res, 200, { ok: true, follow: await followList((await allJ(K.surveys)).filter(x => canSee(s, x))) });
    }

    // owner 24.11: a page for the client with the places we chose (on request), the price for him and what to tell him
    if (op === 'offer') {
      const sv = await getJ(K.surveys, str(body.surveyId, 40));
      if (!canManage(s, sv)) return send(res, 404, { error: 'not-found' });
      const ids = new Set((await allJ(K.hotels(sv.id))).map(x => x.id));
      const items = (Array.isArray(body.items) ? body.items : []).filter(it => ids.has(str(it.hotelId, 40))).slice(0, 10)
        .map(it => ({ hotelId: str(it.hotelId, 40), price: Number(it.price) > 0 ? Math.round(Number(it.price)) : null, per: str(it.per, 40), note: str(it.note, 600) }));
      if (!items.length) return send(res, 400, { error: 'no-places' });
      const id = rid('o');
      const o = { id, surveyId: sv.id, title: str(body.title, 120) || sv.title || '', date: str(body.date, 80), intro: str(body.intro, 800), items, by: s.n || '', at: now() };
      await setJ('hs:offers', id, o);
      sv.offers = [...(sv.offers || []), { id, at: o.at, n: items.length }].slice(-10);
      await setJ(K.surveys, sv.id, sv);
      return send(res, 200, { ok: true, id, url: '/offer/?o=' + id + '&t=' + offerToken(id) });
    }

    if (op === 'place') {
      const w = await getJ(K.wait, str(body.id, 40));
      // owner 24.11: whoever sees it in the waiting area (manages one of its cards, e.g. on another computer / account) may place it
      const mayM = async id => { const x = id && await getJ(K.surveys, String(id)); return !!x && canManage(s, x); };
      let mayW = !!w && (isOwner(s) || w.userId === uid);
      if (w && !mayW) for (const id of [w.from, w.to, ...(w.cards || []).map(c => c.surveyId || c.id || c)]) if (await mayM(id)) { mayW = true; break; }
      if (!w || !mayW) return send(res, 404, { error: 'not-found' });
      if (w.type === 'move') {
        await kv.hdel(K.wait, w.id);
        if (!body.surveyId || body.surveyId === w.from) return send(res, 200, { ok: true, kept: true });
        return moveHotel(res, s, w.from, w.hotelId, str(body.surveyId, 40));
      }
      const fid = str(w.b?.file?.id, 120);
      if (!body.surveyId) {   // not for any card: the call stays on the calls page only
        await kv.hdel(K.wait, w.id); if (fid) await kv.hset(K.files, fid, 'skip');
        return send(res, 200, { ok: true, skipped: true });
      }
      const sv = await getJ(K.surveys, str(body.surveyId, 40));
      if (!canManage(s, sv) || !mine(sv, w.userId)) return send(res, 404, { error: 'not-found' });
      await kv.hdel(K.wait, w.id); if (fid) await kv.hdel(K.files, fid);
      return script(req, res, 'call', w.userId, { ...w.b, surveyId: sv.id, placed: true });
    }

    // owner 25.11: take out of the places' history what came in before the fix: our own WhatsApp lines, call notices, the same message twice
    if (op === 'tidyWa') {
      if (!isOwner(s)) return send(res, 403, { error: 'owner' });
      let removed = 0;
      for (const sv of await allJ(K.surveys)) for (const ho of await allJ(K.hotels(sv.id))) {
        const seen = new Set(), before = (ho.log || []).length;
        ho.log = (ho.log || []).filter(l => { if (l.t !== 'wa') return true; if (waNotPlace(l.from, l.text)) return false; const k = waKey(l.from, l.text); if (seen.has(k)) return false; seen.add(k); return true; });
        const pBefore = (ho.parse || []).length;
        ho.parse = (ho.parse || []).filter(p => !(p.src === 'wa' && WA_OURS.test(p.text || '')));
        if (ho.log.length !== before || ho.parse.length !== pBefore) { removed += before - ho.log.length; await setJ(K.hotels(sv.id), ho.id, ho); }
      }
      return send(res, 200, { ok: true, removed });
    }

    // owner 24.11: move a place (with all its history) from one card to another, e.g. from the שבת חתן to the wedding
    if (op === 'move') return moveHotel(res, s, str(body.surveyId, 40), str(body.id, 40), str(body.toSurvey, 40));

    // owner 24.11: check the places already in the cards: one that was talked about for another event → the waiting area, to move
    if (op === 'recheck') {
      const cards = (await openCards(isOwner(s) ? 'owner' : uid)).filter(c => canManage(s, c));
      const found = [];
      if (cards.length > 1) {
        const old = await allJ(K.wait);
        for (const c of cards) for (const ho of await allJ(K.hotels(c.id))) {
          const text = hotelText(ho);
          const scores = cards.map(x => cardScore(x, text));
          const best = bestCard(scores);
          if (!best || best.surveyId === c.id) continue;
          const mineScore = scores.find(x => x.surveyId === c.id)?.score || 0;
          if (best.score - mineScore < 2) continue;
          const id = 'm' + sha(c.id + ho.id).slice(0, 14);
          if (old.some(x => x.id === id)) { found.push(id); continue; }
          await setJ(K.wait, id, { id, type: 'move', userId: isOwner(s) ? 'owner' : uid, at: now(), name: ho.name || '', summary: str(ho.summary, 600), from: c.id, fromTitle: c.title, hotelId: ho.id, to: best.surveyId, toTitle: best.title, why: best.why,
            cards: scores.map(x => ({ surveyId: x.surveyId, title: x.title, score: x.score, why: x.why })) });
          found.push(id);
        }
      }
      return send(res, 200, { ok: true, cards: cards.length, found: found.length, wait: await waitList(s) });
    }

    // A hotel already checked in another card → copy it into this card, with its whole history (proof stays with it)
    if (op === 'copy') {
      const sv = await getJ(K.surveys, body.surveyId), from = await getJ(K.surveys, body.fromSurvey);
      if (!canSee(s, sv) || !canSee(s, from)) return send(res, 404, { error: 'not-found' });
      const src = await getJ(K.hotels(from.id), body.id);
      if (!src) return send(res, 404, { error: 'not-found' });
      if (sv.id === from.id) return send(res, 400, { error: 'same' });
      const there = findHotel(await allJ(K.hotels(sv.id)), src);   // owner 24.11: already in that card → not a second copy
      if (there) return send(res, 200, { ...there, min: minPrice(there), already: true, toTitle: sv.title });
      const keep = body.keep === true;   // owner 24.11 "לשכפל": the same place for the same event, so what was said stays
      const h = keep ? { ...src, id: rid('h'), createdAt: now(), updatedAt: now(),
          log: [...(src.log || []), { t: 'note', at: now(), by: s.n, text: `שוכפל מהכרטיסייה "${from.title}". הוא נמצא בשתיהן.` }].slice(-80) }
        : { ...src, id: rid('h'), avail: 'unknown', availText: '', prices: [], status: 'new', followUp: '', followWhat: '', createdAt: now(), updatedAt: now(),
          log: [...(src.log || []), { t: 'note', at: now(), by: s.n, text: `הועתק מהכרטיסייה "${from.title}". הזמינות והמחירים שם היו לתאריכים אחרים.` }].slice(-80) };
      await setJ(K.hotels(sv.id), h.id, h);
      return send(res, 200, { ...h, min: minPrice(h), toTitle: sv.title });
    }

    if (op === 'mode') {
      const u = await userRec(uid);
      const on = body.on === true;
      if (on) {
        const sv = await getJ(K.surveys, body.surveyId);
        if (!canSee(s, sv)) return send(res, 400, { error: 'survey' });
        if (!u.mode?.on) u.windows = [...(u.windows || []), { from: now(), to: null, surveyId: sv.id }].slice(-300);
        else if (u.windows?.length) u.windows[u.windows.length - 1].surveyId = sv.id;
        u.mode = { on: true, surveyId: sv.id, since: u.mode?.on ? u.mode.since : now() };
      } else {
        const w = (u.windows || [])[u.windows?.length - 1];
        if (w && !w.to) w.to = now();
        u.mode = { on: false };
      }
      await saveUser(uid, u);
      return send(res, 200, { mode: u.mode });
    }

    if (op === 'connect') {
      const u = await userRec(uid);
      const key = 'lbvh_' + crypto.randomBytes(24).toString('base64url');
      if (u.keyHash) await kv.hdel(K.keys, u.keyHash);
      u.keyHash = sha(key);
      await kv.hset(K.keys, u.keyHash, uid);
      await saveUser(uid, u);
      return send(res, 200, { key });
    }

    return send(res, 400, { error: 'op' });
  } catch (e) {
    console.error('hotels', e && e.message);
    return send(res, 500, { error: 'server' });
  }
}

/** Other managers (for sharing). Injected by the local server; in production read from the private store. */
async function managerList(req) {
  try {
    if (req.lbvUsers) return req.lbvUsers;
    const { loadUsers } = await import('./_users.js');
    return [{ id: 'owner', name: 'הבעלים' }, ...(await loadUsers()).map(u => ({ id: u.id, name: u.name }))];
  } catch (e) { return []; }
}

/* ---------- the Apps Script's side ---------- */
async function script(req, res, what, userId, b) {
  const u = await userRec(userId);
  u.ping = now();

  if (what === 'status') {
    await saveUser(userId, u);
    const surveys = (await allJ(K.surveys)).filter(sv => sv.by?.id === userId || userId === 'owner');
    const active = await Promise.all(surveys.map(async sv => ({
      id: sv.id, title: sv.title, from: sv.from, to: sv.to, need: sv.need, area: sv.area, levels: sv.levels, sheet: sv.sheet !== false, sheetUrl: sv.sheetUrl || '',
      hotels: (await allJ(K.hotels(sv.id))).map(h => ({ id: h.id, name: h.name, phone: h.phone, email: h.email })),
    })));
    const outbox = (await allJ(K.out)).filter(m => m.state === 'queued' && m.owner === userId);
    // E-mail threads to watch for replies (last 60 days).
    const threads = [];
    for (const sv of surveys) for (const h of await allJ(K.hotels(sv.id))) for (const m of (h.log || []))
      if ((m.t === 'mail-out' || m.t === 'mail-in') && m.threadId && Date.now() - Date.parse(m.at) < 60 * 864e5 && !threads.some(x => x.threadId === m.threadId)) threads.push({ surveyId: sv.id, hotelId: h.id, threadId: m.threadId, seen: (h.log || []).filter(x => x.t === 'mail-in').map(x => x.msgId) });
    // Phone calls the owner asked to summarize ("you talked a week ago, want a summary?" → yes)
    const asks = (await allJ(K.calls)).filter(c => c.owner === userId && c.ask && !c.sum && !c.local).slice(0, 3).map(c => ({ id: c.id, name: c.name, at: c.at, q: c.q || '' }));
    let windows = u.windows || [], mode = u.mode || { on: false };
    if (userId === 'owner') {
      const all = Object.entries((await kv.hgetall(K.users)) || {}).map(([id, v]) => [id, typeof v === 'string' ? JSON.parse(v) : v]);
      const riders = all.filter(([id, x]) => id !== 'owner' && !(x.keyHash && x.app?.url));
      windows = windows.concat(...riders.map(([, x]) => x.windows || [])).sort((a2, b2) => String(a2.from).localeCompare(String(b2.from))).slice(-600);
      if (!mode.on) mode = (riders.map(([, x]) => x.mode).find(x => x?.on)) || mode;
    }
    const jobs = { watch: [], parses: [], mailScan: [], webLook: [], wa: [], webRedo: [], relisten: [], mailAuto: [], photoCheck: [] };
    // owner 24.11: a booking / review / news / history site on a card goes at once (no need to wait for Gemini), with its photos and text;
    // and text "about" the place that did not come from its own site (a search result: Wikipedia, a store, a map) goes too
    for (const sv of surveys) for (const h of await allJ(K.hotels(sv.id))) {
      const bad = h.website && notOwnSite(h.website);
      // photos: never from a booking / review site, never a logo / icon / flag, and the same photo once (also .jpg vs .webp, or sizes)
      const stem = u => String(u).split('?')[0].split('/').pop().toLowerCase().replace(/\.(jpe?g|png|webp|avif|gif)$/, '').replace(/[-_]?\d{2,4}x\d{2,4}$/, '').replace(/[-_](scaled|large|medium|small|thumb)$/, '');
      const seenPh = new Set();
      const cleanPh = (h.photos || []).filter(u => { const s = stem(u); if (!s || seenPh.has(s) || /bstatic|booking\.com|tripadvisor|trvl|expedia|agoda|googleusercontent\.com\/p\/|logo|icon|favicon|flag|sprite|placeholder|avatar|banner-ad|whatsapp|facebook|instagram/i.test(u)) return false; seenPh.add(s); return true; });
      const phChanged = cleanPh.length !== (h.photos || []).length;
      const badName = fileLike(h.name);
      const noSitePh = !bad && !h.website && cleanPh.length > 0;   // owner 24.11: no own site → no photos from a search
      // owner 24.11: the place's own site but no photo left after the check: look for its photos once more
      const rePh = !bad && h.website && !cleanPh.length && (h.photosOk || 0) >= 2 && !h.photoRedo;
      if (!bad && !(!h.website && h.about) && !phChanged && !badName && !rePh && !noSitePh) continue;
      if (noSitePh) { h.log = [...(h.log || []), { t: 'note', at: now(), by: 'המערכת', text: 'הוסרו ' + cleanPh.length + ' תמונות מחיפוש ברשת: תמונות באות רק מהאתר של המקום עצמו. אפשר להוסיף תמונות שלכם.' }].slice(-80); cleanPh.length = 0; h.photos = []; }
      if (badName) { h.log = [...(h.log || []), { t: 'note', at: now(), by: 'המערכת', text: 'השם היה שם של קובץ הקלטה (' + h.name + '). אפשר לכתוב כאן את שם המקום.' }].slice(-80); h.name = noName(h, sv.title); }
      if (rePh) { h.photoRedo = 1; h.webV = 0; h.webTries5 = 0; h.webDone = false; }
      if (phChanged && !bad) { h.log = [...(h.log || []), { t: 'note', at: now(), by: 'המערכת', text: 'הוסרו ' + ((h.photos || []).length - cleanPh.length) + ' תמונות: כפולות, לוגו או מאתר הזמנות.' }].slice(-80); h.photos = cleanPh; }
      if (bad) {
        h.webBad = [...new Set([...(h.webBad || []), h.website])].slice(-10);
        h.log = [...(h.log || []), { t: 'note', at: now(), by: 'המערכת', text: 'האתר ' + h.website + ' הוא אתר הזמנות / ביקורות / מידע, לא האתר של המקום. הוא והתמונות ממנו הוסרו, והמקום נחפש שוב.' }].slice(-80);
        h.website = ''; h.photos = []; h.webDone = false; h.webV = 0; h.webTries5 = 0; h.photosOk = 2;
      }
      if (!h.website) delete h.about;   // text only from the place's own site
      await setJ(K.hotels(sv.id), h.id, h);
    }
    for (const sv of surveys) { const j = robotJobs(sv, await allJ(K.hotels(sv.id))); jobs.watch.push(...j.watch); jobs.parses.push(...j.parses); jobs.mailScan.push(...j.mailScan); jobs.webLook.push(...j.webLook); jobs.wa.push(...j.wa); jobs.webRedo.push(...j.webRedo); jobs.relisten.push(...j.relisten); jobs.mailAuto.push(...j.mailAuto); jobs.photoCheck.push(...j.photoCheck); }
    let ilan = { phones: [] };
    if (userId === 'owner') {
      const c = await ilanCfg();
      if (c.phones.length && c.since) {
        // calls with him that are already in the robot's folder (uploaded earlier, e.g. in check mode) but not read for Ilan yet
        const have = await kv.hgetall(K.ilanCalls) || {};
        const files = (await allJ(K.calls)).filter(x => !x.local && !x.dup && !have[x.id] && c.phones.includes(digits(x.phone)) && (Date.parse(x.at) || 0) >= Date.parse(c.since))
          .sort((a2, b2) => String(b2.at).localeCompare(String(a2.at))).slice(0, 2).map(x => ({ id: x.id, at: x.at }));   // newest first
        const open = (await allJ(K.ilanTasks)).filter(t => !t.done).sort((a2, b2) => String(a2.at).localeCompare(String(b2.at)));
        ilan = { phones: c.phones, since: c.since, files, open: open.slice(-60).map(t => ({ id: t.id, text: t.text })), merge: (c.mergedV || 0) < 2 && open.length > 1 };
        const to = new Date(Date.now() + 3650 * 864e5).toISOString();
        jobs.watch.unshift(...c.phones.map(p => ({ ilan: true, phone: p, from: c.since, to })));
      }
    }
    let sortCalls = [], funMail = [], funRead = [], sortExamplesOut = [];
    if (userId === 'owner') {
      // owner 24.11: the attractions like the hotels: their mail and WhatsApp are read too
      for (const f of await allJ('fn:all')) {
        const d = digits(f.phone).slice(-9);
        if (d.length >= 8) jobs.wa.push({ phone: d, names: [f.name, f.supplier].map(x => String(x || '').trim()).filter(x => x.length >= 3) });
        if ((f.waNew || []).length) funRead.push({ id: f.id, name: f.name || '', text: f.waNew.map(m => 'הודעת וואטסאפ מ' + m.from + ' (' + m.at + '):\n' + m.text).join('\n\n').slice(0, 20000) });
        const named = String(f.name || '').replace(/[^\p{L}\p{N}]/gu, '').length >= 4;
        if ((f.email || named || d.length >= 8) && Date.now() - (Date.parse(f.mailAt) || 0) > 4 * 3600e3) funMail.push({ id: f.id, name: f.name || '', phone: d.length >= 8 ? '0' + d : '', email: f.email || '', seen: (f.msgIds || []).slice(-200) });
      }
      // owner 25.11: a new number on WhatsApp (not in the system, not saved in the phone): is it a supplier? (the robot's reading decides)
      for (const w of (await allJ(K.waNew)).filter(w => (w.msgs || []).length).slice(0, 2)) {
        const d = digits(w.phone).slice(-9);
        funRead.push({ id: 'wn' + d, name: w.from || w.phone, text: 'מספר חדש שכתב לנו בוואטסאפ (' + w.phone + '). אם זה ספק, אטרקציה, מקום לאירועים, מלון או אמן שמציע לנו משהו, זה רלוונטי. אם זו שיחה אישית, זה לא רלוונטי. שימו לב: אלה רק ההודעות שהם שלחו. את מה שאנחנו כתבנו להם לא רואים, אז מסכמים רק מה שכתוב בהודעות שלהם, בלי להסיק דברים שלא נאמרו (למשל "כשר" יכול להיות תשובה לשאלה שלנו).\n\n' + w.msgs.map(m => 'הודעת וואטסאפ מ' + m.from + ' (' + m.at + '):\n' + m.text).join('\n\n').slice(0, 20000) });
      }
      funMail = funMail.slice(0, 2); funRead = funRead.slice(0, 3);
    }
    if (userId === 'owner') {
      const { whoOf } = await whoMap();
      const since = Date.now() - 365 * 864e5;   // every unknown call from the last year
      const sysOnly = k => !k || k.auto;   // a number a person tagged is never read again
      const sortAll = (await allJ(K.calls)).filter(c => c.owner === userId && !c.dup && (!c.sort || (c.sort.v || 1) < SORT_V) && (c.sortFails || 0) < 3 && (Date.parse(c.at) || 0) >= since && sysOnly(whoOf(c).k));
      await setJ(HEALTH, 'queue', { at: now(), sort: sortAll.length, web: jobs.webLook.length, photos: jobs.photoCheck.length, relisten: jobs.relisten.length, mail: jobs.mailScan.length + jobs.mailAuto.length, ilanMerge: !!ilan.merge });
      sortExamplesOut = await sortExamples();
      sortCalls = sortAll
        .sort((a2, b2) => String(b2.at).localeCompare(String(a2.at))).slice(0, 3)
        .map(c => ({ id: c.id, at: c.at, name: c.name || '', phone: whoOf(c).d, local: !!c.local, text: c.local ? str(c.sum?.transcript || '', 30000) : '' }));
    }
    return send(res, 200, { sortCalls, sortExamples: sortExamplesOut, funMail, funRead, ilan, windows, mode, surveys: active, outbox, threads, asks, watch: jobs.watch.slice(0, 300), parses: jobs.parses.slice(0, 5), mailScan: jobs.mailScan.concat(jobs.mailAuto).slice(0, 5), photoCheck: jobs.photoCheck.slice(0, 4), webLook: jobs.webLook.slice(0, 3), webRedo: jobs.webRedo.slice(0, 2), relisten: jobs.relisten.slice(0, 1), wa: jobs.wa.slice(0, 300) });
  }

  // The robot's web-app address (for the phone app) + when the app last sent a recording
  if (what === 'app') {
    const url = str(b.url, 300), secret = str(b.secret, 128);
    u.app = { url: /^https:\/\/script\.google\.com\/macros\//.test(url) ? url : '', secret: secret.length >= 32 ? secret : '', last: str(b.last, 30) || null };
    await saveUser(userId, u);
    return send(res, 200, { ok: true });
  }

  // Every recording on the work phone, names only (no listening): file id, file name, number, time
  if (what === 'index') {
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 500);
    const old = await kv.hgetall(K.calls) || {};
    let n = 0, pend = null, pendChanged = false;
    const keys = new Map();   // the same recording uploaded twice (also twice in this batch) = one call
    for (const v of Object.values(old)) { try { const x = JSON.parse(v); if (x && !x.dup) keys.set(callKey(x.name, x.at), x.id); } catch (e) {} }
    for (const it of items) {
      const id = str(it.id, 120);
      if (!id || old[id]) continue;
      const rec = { id, owner: userId, name: str(it.name, 200), phone: str(it.phone, 30), at: str(it.at, 30), url: link(it.url, 300) };
      const ck = callKey(rec.name, rec.at);
      if (keys.has(ck)) { rec.dup = keys.get(ck); await kv.hset(K.files, id, 'skip'); } else keys.set(ck, id);
      // owner 24.11: transcribed on the phone itself: no recording here, only where it is on the phone (ref) + how it went
      if (it.local) Object.assign(rec, { local: true, ref: str(it.ref, 400), lang: str(it.lang, 8), full: it.full === true, took: Number(it.took) || 0, seconds: Number(it.seconds) || 0 });
      const pd = digits(rec.phone).slice(-9), pat = Date.parse(rec.at) || 0;
      const p = pd.length >= 7 && (pend || (pend = ((await getJ(K.pend, 'list')) || []))).find(x => x.phone === pd && Math.abs(Date.parse(x.at) - pat) < 20 * 60e3);
      if (p) { rec.ask = true; rec.q = p.q; rec.askedAt = now(); pend = pend.filter(x => x !== p); pendChanged = true; }
      await setJ(K.calls, id, rec);
      n++;
    }
    if (pendChanged) await setJ(K.pend, 'list', pend);
    u.indexedAt = now(); await saveUser(userId, u);
    return send(res, 200, { ok: true, added: n });
  }
  // owner 24.11: each robot run reports how it went (seconds, Gemini answers / busy / no quota, errors)
  if (what === 'health') {
    if (userId !== 'owner') return send(res, 403, { error: 'owner' });
    const g = b.gem || {}, n = v => Math.max(0, Math.min(999, Number(v) || 0));
    const runs = ((await getJ(HEALTH, 'runs')) || []).concat([{ at: now(), secs: n(b.secs), killed: !!b.killed, gem: { ok: n(g.ok), busy: n(g.busy), quota: n(g.quota) }, errors: (Array.isArray(b.errors) ? b.errors : []).slice(0, 12).map(e => str(e, 200)) }]).slice(-320);
    await setJ(HEALTH, 'runs', runs);
    return send(res, 200, { ok: true });
  }
  if (what === 'sorted') {
    if (userId !== 'owner') return send(res, 403, { error: 'owner' });
    const c = await getJ(K.calls, str(b.id, 120));
    if (!c) return send(res, 404, { error: 'not-found' });
    const r = b.result || {};
    if (b.error || !r.cat) {   // owner 24.11: Gemini busy (503 / 429) is not a failure: the call is tried again next run
      if (!/\b(503|429|500|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED)\b/i.test(str(b.error, 300))) { c.sortFails = (c.sortFails || 0) + 1; await setJ(K.calls, c.id, c); }
      return send(res, 200, { ok: true, fails: c.sortFails || 0 });
    }
    const cat = pick(r.cat, SORT_CATS, 'other');
    c.sort = fixSort({ cat, who: str(r.who, 100), sub: str(r.sub, 120), summary: str(r.summary, 800), at: now(), v: SORT_V });
    if (cat === 'attraction') { const fid = await funFromCall(c, { ...(r.attraction || {}), summary: r.summary }, b.phone || c.phone); if (fid) c.sort.funId = fid; }
    await setJ(K.calls, c.id, c);
    // a sure answer about a number: every call from it goes there from now on (the owner can change it with "לשנות")
    const d = digits(b.phone || c.phone);
    const oldTag = d.length >= 8 ? await getJ(K.book, d) : null;
    const sysTag = !oldTag || oldTag.by === 'המערכת';   // what a person set stays; what the system set follows the newest reading
    if (sysTag && d.length >= 8) {
      if (r.sure === true && cat !== 'other' && !c.sort.fixed && c.sort.who) await setJ(K.book, d, { cat: c.sort.cat, name: c.sort.who, by: 'המערכת', at: now() });
      else if (oldTag) await kv.hdel(K.book, d);
    }
    return send(res, 200, { ok: true, cat, funId: c.sort.funId || '' });
  }

  if (what === 'answer') {
    const c = await getJ(K.calls, str(b.id, 120));
    if (!c || c.owner !== userId) return send(res, 404, { error: 'not-found' });
    const r = b.result || {};
    c.ask = false;
    c.sum = r.error ? { error: str(r.error, 300), at: now() } : {
      at: now(), summary: str(r.summary, 2000), duration: str(r.duration, 10), who: str(r.who, 200),
      quotes: (Array.isArray(r.keyQuotes) ? r.keyQuotes : []).slice(0, 12).map(x => ({ time: str(x.time, 10), who: str(x.speaker, 40), text: str(x.text, 400) })),
      transcript: str(r.transcript, 30000),
      q: str(c.q, 300), found: r.found === true, answer: str(r.answer, 1500),
      answerQuotes: (Array.isArray(r.answerQuotes) ? r.answerQuotes : []).slice(0, 8).map(x => ({ time: str(x.time, 10), who: str(x.speaker, 40), text: str(x.text, 400) })),
    };
    await setJ(K.calls, c.id, c);
    return send(res, 200, { ok: true });
  }

  if (what === 'ilan') {
    if (userId !== 'owner') return send(res, 403, { error: 'owner' });
    const out = await saveIlanCall(b);
    return send(res, out.code, out.body);
  }

  if (what === 'call') {
    const file = { id: str(b.file?.id, 120), name: str(b.file?.name, 200), url: link(b.file?.url, 400) };
    if (!file.id) return send(res, 400, { error: 'file' });
    if (!b.replace && await kv.hget(K.files, file.id)) return send(res, 200, { ok: true, duplicate: true });
    if (!b.replace && !b.placed && (await getJ(K.calls, file.id))?.dup) { await kv.hset(K.files, file.id, 'skip'); return send(res, 200, { ok: true, duplicate: true }); }
    const r = b.result || {};
    if (!r.relevant) {
      u.skipped = (u.skipped || 0) + 1; await saveUser(userId, u);
      await kv.hset(K.files, file.id, 'skip');
      return send(res, 200, { ok: true, skipped: true });
    }
    let sv = await getJ(K.surveys, b.surveyId);
    if (!mine(sv, userId)) return send(res, 400, { error: 'survey' });
    let alsoIn = [];   // owner 24.11: the call talked about two events (a wedding and a שבת חתן) → the place goes in both cards
    const mirror = async (h0, sub, c) => {
      for (const id of alsoIn) {
        const k2 = K.hotels(id), list2 = await allJ(k2);
        let h2 = findHotel(list2, { name: h0.name, phone: h0.phone || '' });
        if (!h2) h2 = { ...cleanHotel({ name: h0.name, status: 'new' }), id: rid('h'), createdAt: now(), log: [] };
        if ((h2.log || []).some(l => l.t === 'call' && l.file?.id === file.id)) continue;
        mergeCall(h2, sub, c);
        for (const k of ['website', 'photos', 'photosOk', 'webDone', 'webV', 'rating', 'reviewsCount', 'reviewsText', 'reviewsSource', 'reviewsUrl', 'about']) if (h2[k] === undefined && h0[k] !== undefined) h2[k] = h0[k];
        h2.updatedAt = now();
        await setJ(k2, h2.id, h2);
      }
    };
    if (!b.replace && !b.placed) {
      const cards = await openCards(userId);
      if (cards.length > 1) {
        const text = callText(r);
        const scores = await Promise.all(cards.map(async c => cardScore(c, text, await allJ(K.hotels(c.id)), r.hotel || {})));
        const best = bestCard(scores);
        const both = scores.filter(x => x.said && x.score >= 4).sort((x, y) => y.score - x.score);   // each event named outright in the call
        if (best) { sv = cards.find(c => c.id === best.surveyId) || sv; alsoIn = both.filter(x => x.surveyId !== best.surveyId).map(x => x.surveyId); }
        else if (both.length >= 2) { sv = cards.find(c => c.id === both[0].surveyId) || sv; alsoIn = both.slice(1).map(x => x.surveyId); }
        else {
          const id = 'w' + sha(file.id).slice(0, 14);
          await setJ(K.wait, id, { id, type: 'call', userId, at: str(b.at, 40) || now(), name: str(r.hotel?.name, 160) || file.name, summary: str(r.summary, 1500), transcript: str(r.transcript, 30000),
            cards: scores.map(x => ({ surveyId: x.surveyId, title: x.title, score: x.score, why: x.why })), b: { ...b, result: { ...r, transcript: str(r.transcript, 30000) } } });
          await kv.hset(K.files, file.id, 'wait');
          u.lastCall = now(); await saveUser(userId, u);
          return send(res, 200, { ok: true, waiting: true });
        }
      }
    }
    const key = K.hotels(sv.id);
    // read again: take back what the old reading of this call wrote on that hotel
    let old = b.replace ? await getJ(key, str(b.replace, 40)) : null;
    if (old) {
      old.log = (old.log || []).filter(l => !(l.t === 'call' && l.file?.id === file.id));
      if (!(old.log || []).some(l => l.t === 'call' || l.t === 'text')) { old.prices = []; old.avail = 'unknown'; old.availText = ''; old.summary = ''; old.rooms = ''; }
      delete old.relisten; delete old.relistenTries; delete old.relistenFail;
      await setJ(key, old.id, old);
    }
    // the old card is not one of the places: its notes, mails and my photos move to the first place, then it goes
    const finish = async ids => {
      if (!old || ids.includes(old.id)) return;
      const cur = await getJ(key, old.id), to = await getJ(key, ids[0]);
      if (!cur || !to) return;
      if ((cur.log || []).some(l => l.t === 'call' && l.file?.id !== file.id)) return;   // it has other calls of its own: keep it
      to.log = [...(to.log || []), ...(cur.log || []), { t: 'note', at: now(), by: 'המערכת', text: 'השיחה נקראה מחדש. הכרטיס "' + (cur.name || '') + '" פוצל לפי המקומות שדיברו עליהם.' }].sort((a2, b2) => String(a2.at).localeCompare(String(b2.at))).slice(-80);
      to.myPhotos = [...new Set([...(to.myPhotos || []), ...(cur.myPhotos || [])])].slice(0, 40);
      if (!to.notes && cur.notes) to.notes = cur.notes;
      await setJ(key, to.id, to);
      await kv.hdel(key, old.id);
    };
    const hotels = await allJ(key);
    const call = {
      t: 'call', at: str(b.at, 40) || now(), file, dur: str(r.duration, 20),
      summary: str(r.summary, 1500), quotes: (Array.isArray(r.keyQuotes) ? r.keyQuotes : []).slice(0, 12).map(x => ({ time: str(x.time, 12), who: str(x.speaker, 40), text: str(x.text, 500) })),
      avail: pick(r.availability?.status, AVAIL, 'unknown'), availText: str(r.availability?.text, 400),
      transcript: str(r.transcript, 30000),
    };
    const places = (Array.isArray(r.places) ? r.places : []).filter(p => p && str(p.name, 160)).slice(0, 6);
    if (places.length >= 2) {
      // one call, several places: each place gets only what was said about it
      const names = places.map(p => str(p.name, 160));
      const saved = [];
      for (const p of places) {
        const nm = str(p.name, 160);
        let h = findHotel(hotels, { name: nm, phone: p.phone || '' });
        if (h && old && h.id === old.id) h.name = nm;   // the old mixed card becomes this place
        if (!h) { h = { ...cleanHotel({ name: nm, status: 'new' }), id: rid('h'), createdAt: now(), log: [] }; hotels.push(h); }
        const others = names.filter(n => n !== nm);
        const sub = { hotel: { name: nm, city: p.city || '', phone: p.phone || '' }, availability: p.availability || {}, prices: p.prices || [], summary: str(p.note || '', 1000) };
        const c = { ...call, avail: pick(p.availability?.status, AVAIL, 'unknown'), availText: str(p.availability?.text, 400),
          summary: str((p.note ? p.note + ' ' : '') + 'בשיחה דיברו גם על: ' + others.join(', ') + '. ' + (r.summary || ''), 1500) };
        mergeCall(h, sub, c);
        h.updatedAt = now();
        await setJ(key, h.id, h);
        await mirror(h, sub, c);
        saved.push({ id: h.id, name: h.name });
      }
      await kv.hset(K.files, file.id, saved[0].id);
      await finish(saved.map(x => x.id));
      u.lastCall = now(); await saveUser(userId, u);
      return send(res, 200, { ok: true, hotelId: saved[0].id, name: saved[0].name, places: saved });
    }
    let h = findHotel(hotels, r.hotel || {});
    if (h && old && h.id === old.id && r.hotel?.name) h.name = str(r.hotel.name, 160);
    if (!h) h = { ...cleanHotel({ name: r.hotel?.name || file.name, status: 'new' }), id: rid('h'), createdAt: now(), log: [] };
    mergeCall(h, r, call);
    h.updatedAt = now();
    await setJ(key, h.id, h);
    await mirror(h, r, call);
    await kv.hset(K.files, file.id, h.id);
    await finish([h.id]);
    u.lastCall = now(); await saveUser(userId, u);
    return send(res, 200, { ok: true, hotelId: h.id, name: h.name });
  }

  if (what === 'relistenFail') {
    const sv = await getJ(K.surveys, str(b.surveyId, 40));
    if (!mine(sv, userId)) return send(res, 404, { error: 'not-found' });
    const key = K.hotels(sv.id), h = await getJ(key, str(b.hotelId, 40));
    let stop = !h || !h.relisten;
    if (h && h.relisten) {
      // the robot counts every try before it starts (a try cut by Google's time limit still counts): 3 tries, then stop
      h.relistenTries = (h.relistenTries || 0) + 1;
      if (h.relistenTries > 3) { stop = true; delete h.relisten; h.relistenFail = now(); h.log = [...(h.log || []), { t: 'note', at: now(), by: 'המערכת', text: 'לא הצלחתי לקרוא את השיחה מחדש: ' + str(b.error, 200) }].slice(-80); }
      await setJ(key, h.id, h);
    }
    return send(res, 200, { ok: true, stop });
  }

  if (what === 'mailsent') {
    const m = await getJ(K.out, str(b.id, 40));
    if (!m || m.owner !== userId) return send(res, 404, { error: 'not-found' });
    const key = K.hotels(m.surveyId), h = await getJ(key, m.hotelId);
    if (h) {
      h.log = [...(h.log || []), { t: 'mail-out', at: str(b.at, 40) || now(), to: m.to, subject: m.subject, body: m.body, by: m.by, threadId: str(b.threadId, 80), msgId: str(b.msgId, 80), state: b.error ? 'error' : 'sent', error: str(b.error, 300) }].slice(-80);
      if (!b.error && h.status === 'new') h.status = 'waiting';
      await setJ(key, h.id, h);
    }
    await kv.hdel(K.out, m.id);
    await saveUser(userId, u);
    return send(res, 200, { ok: true });
  }

  if (what === 'replies') {
    let added = 0;
    for (const x of (Array.isArray(b.items) ? b.items : []).slice(0, 50)) {
      if (!mine(await getJ(K.surveys, str(x.surveyId, 40)), userId)) continue;
      const key = K.hotels(str(x.surveyId, 40)), h = await getJ(key, str(x.hotelId, 40));
      if (!h) continue;
      const msgId = str(x.msgId, 80);
      if ((h.log || []).some(l => l.msgId === msgId)) continue;
      h.log = [...(h.log || []), { t: x.out ? 'mail-out' : 'mail-in', state: x.out ? 'sent' : undefined, to: x.out ? str(x.to, 200) : undefined, at: str(x.at, 40) || now(), from: str(x.from, 200), subject: str(x.subject, 200), body: str(x.body, 12000), msgId, threadId: str(x.threadId, 80), files: (Array.isArray(x.files) ? x.files : []).slice(0, 10).map(f => ({ name: str(f.name, 160), url: link(f.url, 400) })) }].slice(-80);
      await setJ(key, h.id, h); added++;
      // owner 25.11: the same place in another event card (a copy, "לשכפל") has the same mail thread: the reply goes there too,
      // and is read there as well (a parse job with the mail's text), so each card gets the prices / dates from it
      const threadId = str(x.threadId, 80);
      if (!threadId || x.out) continue;
      for (const sv2 of await allJ(K.surveys)) {
        if (!mine(sv2, userId)) continue;
        for (const h2 of await allJ(K.hotels(sv2.id))) {
          if (sv2.id === str(x.surveyId, 40) && h2.id === h.id) continue;
          if (!(h2.log || []).some(l => l.threadId === threadId) || (h2.log || []).some(l => l.msgId === msgId)) continue;
          const entry = h.log[h.log.length - 1];
          h2.log = [...(h2.log || []), { ...entry }].slice(-80);
          h2.parse = [...(h2.parse || []), { id: rid('p'), src: 'mail', at: now(), by: 'המערכת', text: ('From: ' + str(x.from, 200) + '\nSubject: ' + str(x.subject, 200) + '\n' + str(x.body, 12000)).slice(0, 15000) }].slice(-5);
          await setJ(K.hotels(sv2.id), h2.id, h2); added++;
        }
      }
    }
    await saveUser(userId, u);
    return send(res, 200, { ok: true, added });
  }

  if (what === 'parsed') {
    const sv = await getJ(K.surveys, str(b.surveyId, 40));
    if (!mine(sv, userId)) return send(res, 404, { error: 'not-found' });
    const key = K.hotels(sv.id), h = await getJ(key, str(b.hotelId, 40));
    if (!h) return send(res, 404, { error: 'not-found' });
    const jobId = str(b.id, 40);
    const busy = b.error && /503|429|quota|busy|overload|out of time|timeout|timed out|unavailable|rate/i.test(String(b.error));
    if (jobId === 'wacatch') { if (b.error) h.waTry = (h.waTry || 0) + 1; }
    else if (jobId && busy && ((h.parse || []).find(p => p.id === jobId)?.tries || 0) < 5) {
      h.parse = (h.parse || []).map(p => p.id === jobId ? { ...p, tries: (p.tries || 0) + 1 } : p);   // kept: tried again on a next run
      await setJ(key, h.id, h);
      return send(res, 200, { ok: true, retry: true });
    } else if (jobId) h.parse = (h.parse || []).filter(p => p.id !== jobId);
    const r = b.result || {};
    if (b.src === 'wa' && !b.error) { const lastWa = (h.log || []).filter(l => l.t === 'wa').map(l => l.at).sort().pop(); if (lastWa) h.waReadAt = lastWa; delete h.waTry; }
    // owner 25.11: WhatsApp replies are short and come without our questions ("אין לי על הטלפון"): kept only when they
    // bring a fact (a price, the availability, a detail of the place), never as a summary that says nothing
    const emptySum = s2 => !String(s2 || '').trim() || /אין (לו|לה|להם|לי)? ?(את )?ה?מידע|לא (נמסר|צוין|ידוע|ברור)|אין לי על הטלפון|תמונה בלבד|ללא פרטים|^התקבלה הודעה|ישלח(ו)? (בהמשך|אחר כך|עוד)|בעוד כמה דק/.test(String(s2));
    const waFact = (r.prices || []).length || ((r.keyQuotes || []).length && !emptySum(r.summary)) || (r.availability?.status && r.availability.status !== 'unknown') || Object.values(r.hotel || {}).some(v => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length));
    if (!b.error && r && (b.src === 'wa' ? waFact : (r.summary || (r.prices || []).length || r.availability || r.hotel))) {
      const src = pick(b.src, ['paste', 'mail', 'wa'], 'paste');
      mergeCall(h, { ...r, hotel: r.hotel || {} }, { t: 'text', src, at: now(), files: (Array.isArray(b.files) ? b.files : []).slice(0, 10).map(f => ({ name: str(f.name, 160), url: link(f.url, 400) })).filter(f => f.name), summary: str(r.summary, 1500), avail: pick(r.availability?.status, AVAIL, 'unknown'), availText: str(r.availability?.text, 400), quotes: (Array.isArray(r.keyQuotes) ? r.keyQuotes : []).slice(0, 8).map(x => ({ time: '', who: str(x.speaker, 40), text: str(x.text, 500) })) });
    } else if (b.error && !busy) h.log = [...(h.log || []), { t: 'note', at: now(), by: 'המערכת', text: 'לא הצלחתי לקרוא את הטקסט: ' + str(b.error, 200) }].slice(-80);
    h.updatedAt = now();
    await setJ(key, h.id, h);
    await saveUser(userId, u);
    return send(res, 200, { ok: true });
  }

  // WhatsApp messages from a hotel (owner 19.11): kept in its history, and read for prices / rooms / hours like a pasted text
  // owner 25.11, the linked WhatsApp (lbv-wa): the numbers that have a card. Only chats with these numbers are read into the system.
  if (what === 'waknown') {
    if (userId !== 'owner') return send(res, 403, { error: 'owner' });
    const phones = new Set();
    for (const sv of await allJ(K.surveys)) for (const h of await allJ(K.hotels(sv.id))) for (const x of [h.phone, h.phone2]) { const d = digits(x).slice(-9); if (d.length >= 8) phones.add(d); }
    for (const f of await allJ('fn:all')) { const d = digits(f.phone).slice(-9); if (d.length >= 8) phones.add(d); }
    return send(res, 200, { ok: true, phones: [...phones] });
  }

  // owner 25.11, the linked WhatsApp: a photo / video / voice note a place sent (already in Blob storage, hotels/wa-…).
  // A photo joins the card's photos; a video or a voice note is kept in the history with a link to open it.
  if (what === 'wamedia') {
    if (userId !== 'owner') return send(res, 403, { error: 'owner' });
    const d = digits(b.phone).slice(-9), kind = pick(b.kind, ['image', 'video', 'audio'], ''), url = str(b.url, 500);
    if (d.length < 8 || !kind || !/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/hotels\/wa-[\w.\-]+$/i.test(url)) return send(res, 400, { error: 'bad' });
    const at = str(b.at, 40) || now(), sec = Math.round(Number(b.seconds) || 0), mmss = sec ? ` (${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')})` : '';
    const label = kind === 'video' ? 'סרטון מהוואטסאפ' + mmss : 'הודעה קולית מהוואטסאפ' + mmss;
    let filed = 0;
    for (const sv of await allJ(K.surveys)) {
      const key = K.hotels(sv.id);
      for (const h of await allJ(key)) {
        if (![h.phone, h.phone2].some(x => digits(x).slice(-9) === d)) continue;
        if (kind === 'image') h.myPhotos = [...(h.myPhotos || []), url].filter((u, i, a) => a.indexOf(u) === i).slice(-40);
        else if (!(h.log || []).some(l => l.waId && l.waId === str(b.id, 80))) h.log = [...(h.log || []), { t: 'note', at, by: 'וואטסאפ', text: label, waId: str(b.id, 80) || undefined, files: [{ name: kind === 'video' ? 'לצפייה בסרטון' : 'להאזנה', url }] }].slice(-80);
        h.updatedAt = now();
        await setJ(key, h.id, h); filed++;
      }
    }
    for (const f of await allJ('fn:all')) {
      if (digits(f.phone).slice(-9) !== d) continue;
      f.waMedia = [...(f.waMedia || []), { kind, url, at, label }].slice(-30);
      await setJ('fn:all', f.id, f); filed++;
    }
    return send(res, 200, { ok: true, filed });
  }

  if (what === 'wa') {
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 100);
    const byPhone = {};
    // it.mine (owner 25.11): our own message, from the linked WhatsApp (lbv-wa); it.link: came from there (no saved-contact name)
    for (const it of items) { const d = digits(it.phone).slice(-9); if (d.length >= 8 && str(it.text, 4000).trim() && (it.mine === true || !waNotPlace(it.from, it.text)) && !WA_NOISE.test(str(it.text, 4000))) (byPhone[d] = byPhone[d] || []).push(it); }
    let filed = 0;
    for (const sv of (await allJ(K.surveys)).filter(x => mine(x, userId))) {
      const key = K.hotels(sv.id);
      for (const h of await allJ(key)) {
        const d = [h.phone, h.phone2].map(x => digits(x).slice(-9)).find(x => x.length >= 8 && byPhone[x]);
        if (!d) continue;
        // the phone and the linked WhatsApp may both bring the same message (with a different name): the same text is kept once
        const had = new Set((h.log || []).filter(l => l.t === 'wa').flatMap(l => [waKey(l.from, l.text), waKey('', l.text)]));
        const msgs = byPhone[d].filter(m => { const k = waKey('', m.text); if (had.has(k) || had.has(waKey(m.from, m.text))) return false; had.add(k); return true; });
        if (!msgs.length) continue;
        // the WhatsApp lines are kept apart (the last 60), so a long chat never pushes the calls out of the history
        const was = [...(h.log || []).filter(l => l.t === 'wa'), ...msgs.map(m => ({ t: 'wa', at: str(m.at, 40) || now(), from: m.mine === true ? 'אנחנו' : str(m.from, 120), text: str(m.text, 4000), ...(m.mine === true ? { mine: true } : {}) }))].sort((x, y) => String(x.at || '').localeCompare(String(y.at || ''))).slice(-60);
        h.log = [...(h.log || []).filter(l => l.t !== 'wa'), ...was];
        // read only when the place wrote something; our recent lines go with it, so the robot knows what was asked
        if (msgs.some(m => m.mine !== true)) h.parse = [...(h.parse || []), { id: rid('p'), src: 'wa', at: now(), by: 'וואטסאפ', text: WA_CTX + was.slice(-30).map(waLine).join('\n\n').slice(0, 20000) }].slice(-5);
        h.updatedAt = now();
        await setJ(key, h.id, h);
        filed++;
      }
    }
    const known = new Set();
    for (const sv of await allJ(K.surveys)) for (const h of await allJ(K.hotels(sv.id))) for (const x of [h.phone, h.phone2]) { const d = digits(x).slice(-9); if (d.length >= 8) known.add(d); }
    if (userId === 'owner') for (const f of await allJ('fn:all')) {
      const d = digits(f.phone).slice(-9);
      if (d.length >= 8) known.add(d);
      if (d.length < 8 || !byPhone[d]) continue;
      // each message once, even when it comes again (from the phone and the linked WhatsApp, or the linked WhatsApp's history)
      const seen = new Set(f.waSeen || []);
      const add = byPhone[d].filter(m => { const k = sha(waKey('', m.text) + '|' + String(m.at || '').slice(0, 16)).slice(0, 16), k2 = sha(waKey('', m.text)).slice(0, 16); if (seen.has(k) || (m.link && seen.has(k2))) return false; seen.add(k); seen.add(k2); return true; });
      if (!add.length) continue;
      f.waSeen = [...seen].slice(-300);
      f.waNew = [...(f.waNew || []), ...add.map(m => ({ at: str(m.at, 40) || now(), from: m.mine === true ? 'אנחנו (השאלה שלנו)' : str(m.from, 120), text: str(m.text, 4000) }))].slice(-20);
      await setJ('fn:all', f.id, f); filed++;
    }
    let aside = 0;
    if (userId === 'owner') for (const [d, msgs] of Object.entries(byPhone)) {
      if (known.has(d) || !msgs.some(m => m.unknown === true)) continue;
      const no = await getJ(K.waNo, d);
      if (no && Date.now() - Date.parse(no.at) < WA_NO_DAYS * 864e5) continue;   // checked lately: not a supplier
      const w = (await getJ(K.waNew, d)) || { phone: '0' + d, from: '', msgs: [], tries: 0 };
      const had = new Set(w.msgs.map(m => waKey(m.from, m.text)));
      for (const m of msgs) { const k = waKey(m.from, m.text); if (!had.has(k)) { had.add(k); w.msgs.push({ at: str(m.at, 40) || now(), from: str(m.from, 120), text: str(m.text, 4000) }); } }
      w.msgs = w.msgs.slice(-20); w.from = str(msgs[msgs.length - 1].from, 120) || w.from; w.at = now();
      await setJ(K.waNew, d, w); aside++;
    }
    return send(res, 200, { ok: true, filed, aside });
  }

  // owner 24.11: what the robot read about an attraction in its mail / WhatsApp: on the card, and fills what is still empty
  if (what === 'funread' && /^wn\d{8,9}$/.test(str(b.id, 20))) {
    if (userId !== 'owner') return send(res, 403, { error: 'owner' });
    const d = str(b.id, 20).slice(2), w = await getJ(K.waNew, d);
    if (!w) return send(res, 200, { ok: true, gone: true });
    if (b.error) {   // the reading failed: tried again later (5 times at most), then let go
      w.tries = (w.tries || 0) + 1;
      if (w.tries >= 5) await kv.hdel(K.waNew, d); else await setJ(K.waNew, d, w);
      return send(res, 200, { ok: true, retry: w.tries < 5 });
    }
    const r = b.result || {};
    await kv.hdel(K.waNew, d);   // the messages themselves are not kept (a private chat never stays in the system)
    if (!r.relevant) { await setJ(K.waNo, d, { at: now() }); return send(res, 200, { ok: true, relevant: false }); }
    const x = r.attraction || {};
    const name = str(x.supplier, 100) || (/\p{L}/u.test(w.from || '') ? str(w.from, 100) : '') || 'ספק חדש ' + w.phone;
    const id = await funFromCall({ at: str(b.at, 40) || now(), from: w.from || w.phone }, { ...x, name, summary: r.summary }, w.phone, 'wa');
    if (id) { const f = await getJ('fn:all', id); if (f) { f.fromWa = true; f.waText = w.msgs.map(m => m.text).join('\n').slice(0, 3000); await setJ('fn:all', id, f); } }
    return send(res, 200, { ok: true, relevant: true, id });
  }
  if (what === 'funmailscan' || what === 'funread') {
    if (userId !== 'owner') return send(res, 403, { error: 'owner' });
    const f = await getJ('fn:all', str(b.id, 40));
    if (!f) return send(res, 404, { error: 'not-found' });
    if (what === 'funmailscan') {
      f.mailAt = now();
      f.msgIds = [...new Set([...(f.msgIds || []), ...(Array.isArray(b.msgIds) ? b.msgIds : []).map(x => str(x, 40))])].slice(-300);
      if (!f.email && /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i.test(str(b.email, 120))) f.email = str(b.email, 120);
      await setJ('fn:all', f.id, f);
      return send(res, 200, { ok: true });
    }
    if (b.src === 'wa') { delete f.waNew; await setJ('fn:all', f.id, f); }
    const r = b.result || {};
    if (!r.relevant && b.src === 'mail') return send(res, 200, { ok: true, skipped: true });
    await funFromCall({ at: str(b.at, 40) || now(), from: str(b.from, 120), files: b.files }, { ...(r.attraction || {}), name: '', summary: r.summary }, '', b.src === 'wa' ? 'wa' : 'mail', await getJ('fn:all', f.id));
    return send(res, 200, { ok: true });
  }

  if (what === 'web') {
    const sv = await getJ(K.surveys, str(b.surveyId, 40));
    if (!mine(sv, userId)) return send(res, 404, { error: 'not-found' });
    const key = K.hotels(sv.id), h = await getJ(key, str(b.hotelId, 40));
    if (!h) return send(res, 404, { error: 'not-found' });
    h.webTries = (h.webTries || 0) + 1;
    h.webTries3 = (h.webTries3 || 0) + 1;
    h.webTries4 = (h.webTries4 || 0) + 1;
    h.webTries5 = (h.webTries5 || 0) + 1;
    h.webTries6 = (h.webTries6 || 0) + 1;
    h.webTries7 = (h.webTries7 || 0) + 1;   // owner 24.11: a new round with the Tavily search
    if (b.redo) h.webRedoTries = (h.webRedoTries || 0) + 1;
    if (b.grounded === false) h.webNoSearch = true;
    if (b.grounded === true && b.found) { h.webGrounded = true; delete h.webNoSearch; }
    if (b.found) {
      h.webDone = true;
      const g = b.hotel || {};
      const safe = u => /^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u).slice(0, 500) : null;
      // only fills what is empty: what LBV typed always wins
      for (const k of (b.grounded === false ? ['city'] : ['city', 'phone', 'email'])) if (!h[k] && g[k]) h[k] = str(g[k], 160);
      if (!safe(h.website) && safe(g.website) && !notOwnSite(g.website) && !(h.webBad || []).some(x => hostOf(x) === hostOf(g.website))) h.website = safe(g.website);
      const ph = (Array.isArray(b.photos) ? b.photos : []).map(safe).filter(Boolean);
      if (ph.length && b.photosChecked && h.website) { h.photos = [...new Set(ph)].slice(0, 8); h.photosOk = 2; delete h.photosCand; }   // owner 24.11: only photos the robot checked
      else if (ph.length && h.website && !(h.photos || []).length) h.photosCand = [...new Set(ph)].slice(0, 12);   // not checked yet (no Gemini quota): checked in a later run, shown only after that
      if (g.about && !h.about && h.website) h.about = str(g.about, 400);   // only from the place's own site
      if (b.grounded === false) { h.webV = 3; await setJ(key, h.id, h); return send(res, 200, { ok: true }); }   // no search: no ratings / phone / e-mail
      h.webV = 7;
      const rt = Number(g.rating), rc = Number(g.reviews), sc = Number(g.ratingScale) === 10 || rt > 5 ? 10 : 5;
      if (rt > 0 && rt <= sc) { h.rating = Math.round(rt * 10) / 10; h.ratingScale = sc; }
      if (g.reviewsSource) h.reviewsSource = str(g.reviewsSource, 40);
      if (rc > 0) h.reviewsCount = Math.round(rc);
      if (g.reviewsSummary) h.reviewsText = str(g.reviewsSummary, 600);
      if (safe(g.reviewsUrl)) h.reviewsUrl = safe(g.reviewsUrl);
    }
    await setJ(key, h.id, h);
    return send(res, 200, { ok: true });
  }

  // owner 24.11: the robot grouped the open Ilan tasks that are the same request (also the copies of the same call): one task each, with every call it came up in
  if (what === 'ilanmerge') {
    if (userId !== 'owner') return send(res, 403, { error: 'owner' });
    let merged = 0;
    // copies of the same call: hidden, their open robot tasks go (the first copy keeps its own)
    const seen = new Map();
    for (const c of (await allJ(K.ilanCalls)).filter(c => !c.hidden).sort((a2, b2) => String(a2.at).localeCompare(String(b2.at)))) {
      const k2 = callKey(c.file?.name, c.at);
      if (!seen.has(k2)) { seen.set(k2, c.id); continue; }
      for (const tid of c.tasks || []) { const t = await getJ(K.ilanTasks, tid); if (t && t.by === 'robot' && !t.done) { await kv.hdel(K.ilanTasks, tid); merged++; } }
      await setJ(K.ilanCalls, c.id, { id: c.id, at: c.at, hidden: true, dupOf: seen.get(k2), tasks: [] });
    }
    for (const g of (Array.isArray(b.groups) ? b.groups : []).slice(0, 60)) {
      const ts = [];
      for (const id of (Array.isArray(g) ? g : []).slice(0, 12)) { const t = await getJ(K.ilanTasks, str(id, 40)); if (t && !t.done && !ts.some(x => x.id === t.id)) ts.push(t); }
      if (ts.length < 2) continue;
      ts.sort((a2, b2) => String(a2.at).localeCompare(String(b2.at)));
      const keep = ts[0];
      for (const t of ts.slice(1)) {
        keep.also = [...(keep.also || []), { callId: t.callId, at: t.at, quote: t.quote, text: t.text }, ...(t.also || [])].slice(-10);
        if (t.due && (!keep.due || t.due > keep.due)) keep.due = t.due;
        await kv.hdel(K.ilanTasks, t.id); merged++;
      }
      await setJ(K.ilanTasks, keep.id, keep);
    }
    const cfg = await ilanCfg(); cfg.mergedV = 2; await setJ(K.ilan, 'cfg', cfg);
    return send(res, 200, { ok: true, merged });
  }

  if (what === 'photoscheck') {
    const sv = await getJ(K.surveys, str(b.surveyId, 40));
    if (!mine(sv, userId)) return send(res, 404, { error: 'not-found' });
    const key = K.hotels(sv.id), h = await getJ(key, str(b.hotelId, 40));
    if (!h) return send(res, 404, { error: 'not-found' });
    // owner 24.11: the site on the card is not this place: it goes, with its photos and what was taken from it, and the place is looked up again (never that site again)
    if ((b.siteBad || notOwnSite(h.website)) && h.website) {
      h.webBad = [...new Set([...(h.webBad || []), h.website])].slice(-10);
      h.log = [...(h.log || []), { t: 'note', at: now(), by: 'המערכת', text: 'האתר ' + h.website + ' לא שייך למקום הזה. הוא והתמונות ממנו הוסרו, והמקום נחפש שוב ברשת.' }].slice(-80);
      h.website = ''; h.photos = []; delete h.about; delete h.photosCand; h.webDone = false; h.webV = 0; h.webTries5 = 0; h.webTries6 = 0; h.webTries7 = 0; h.photosOk = 2;
      await setJ(key, h.id, h);
      return send(res, 200, { ok: true, siteRemoved: true });
    }
    const keep = new Set((Array.isArray(b.keep) ? b.keep : []).map(x => String(x)));
    if (b.cand) {   // the photos found on the place's own site, now checked
      const got = (h.photosCand || []).filter(u => keep.has(u)).slice(0, 8);
      delete h.photosCand;
      if (got.length) { h.photos = [...new Set([...(h.photos || []), ...got])].slice(0, 8); h.log = [...(h.log || []), { t: 'note', at: now(), by: 'המערכת', text: 'נוספו ' + got.length + ' תמונות מהאתר של המקום (נבדקו שהן מראות את המקום עצמו).' }].slice(-80); }
      h.photosOk = 2;
      await setJ(key, h.id, h);
      return send(res, 200, { ok: true, kept: got.length });
    }
    const before = (h.photos || []).length;
    h.photos = (h.photos || []).filter(u => keep.has(u));
    h.photosOk = 2;
    if (!h.website && h.about) delete h.about;   // owner 24.11: text from a search result (Wikipedia, a store, a map) is not about this place
    if (before !== h.photos.length) h.log = [...(h.log || []), { t: 'note', at: now(), by: 'המערכת', text: 'נבדקו התמונות מהרשת: ' + (before - h.photos.length) + ' שלא מראות את המקום (סמלים, לוגו, דגלים, מודעות) הוסרו.' }].slice(-80);
    await setJ(key, h.id, h);
    return send(res, 200, { ok: true, kept: h.photos.length });
  }

  if (what === 'mailscan') {
    const sv = await getJ(K.surveys, str(b.surveyId, 40));
    if (!mine(sv, userId)) return send(res, 404, { error: 'not-found' });
    const key = K.hotels(sv.id), h = await getJ(key, str(b.hotelId, 40));
    if (!h) return send(res, 404, { error: 'not-found' });
    if (b.email) h.mailScan = str(b.email, 160).toLowerCase();
    h.mailAt = now();
    if (b.ask) {
      delete h.mailAsk;
      h.mailAskDone = { at: now(), found: Math.max(0, Math.round(Number(b.found) || 0)), by: b.email ? 'email' : 'name' };
      // the hotel had no e-mail: take the address the hotel wrote from
      const fe = String(b.hotelEmail || '').trim().toLowerCase();
      if (!h.email && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(fe)) { h.email = fe.slice(0, 160); h.mailScan = h.email; }
    }
    await setJ(key, h.id, h);
    return send(res, 200, { ok: true });
  }

  if (what === 'export') {
    const sv = await getJ(K.surveys, url(req).get('survey'));
    if (!mine(sv, userId)) return send(res, 404, { error: 'not-found' });
    return send(res, 200, { title: sv.title, rows: tableRows(sv, await allJ(K.hotels(sv.id)), sv.prefDate, `https://${req.headers['x-forwarded-host'] || req.headers.host}`) });
  }

  if (what === 'sheet') {
    const sv = await getJ(K.surveys, str(b.surveyId, 40));
    if (!mine(sv, userId)) return send(res, 404, { error: 'not-found' });
    sv.sheetUrl = link(b.url, 300); await setJ(K.surveys, sv.id, sv);
    return send(res, 200, { ok: true });
  }

  return send(res, 400, { error: 'what' });
}
const url = req => new URL(req.url, 'http://x').searchParams;

// Shared with api/_events.js (the events calendar and the app settings), same storage.
export { kv, getJ, setJ, allJ };
