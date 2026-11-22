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

const K = {
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
};
const ILAN_SEE = ['cad5d8ff-c32d-4df9-918e-38cfd1d315d8'];   // owner 19.11: besides the owner only מעיין sees the Ilan tasks (not Ilan, not the others)
const ILAN_BACK_DAYS = 7;            // when his number is saved, his calls of the last week are read too
/** One Ilan call (summary, wants, quotes, transcript, tasks) into the tab: from the robot, or (owner 19.11) imported from the computer when Gemini is stuck. */
async function saveIlanCall(b) {
  const file = { id: str(b.file?.id, 120), name: str(b.file?.name, 200), url: link(b.file?.url, 400) };
  if (!file.id) return { code: 400, body: { error: 'file' } };
  if (await getJ(K.ilanCalls, file.id)) return { code: 200, body: { ok: true, duplicate: true } };
  const r = b.result || {};
  const qs = a => (Array.isArray(a) ? a : []).slice(0, 12).map(x => ({ time: str(x?.time, 8), speaker: str(x?.speaker, 30), text: str(x?.text, 400) })).filter(x => x.text);
  const call = { id: file.id, at: str(b.at, 30) || now(), file, summary: str(r.summary, 3000), wants: (Array.isArray(r.wants) ? r.wants : []).slice(0, 20).map(x => str(x, 400)).filter(Boolean),
    quotes: qs(r.keyQuotes), transcript: str(r.transcript, 40000), duration: str(r.duration, 8), tasks: [] };
  for (const x of (Array.isArray(r.tasks) ? r.tasks : []).slice(0, 25)) {
    const text = str(x?.text, 400); if (!text) continue;
    const t = { id: 'it' + crypto.randomBytes(6).toString('hex'), text, due: /^\d{4}-\d{2}-\d{2}$/.test(str(x?.due, 10)) ? str(x.due, 10) : '', when: str(x?.when, 80), quote: str(x?.quote, 400), callId: file.id, at: call.at, done: false, doneAt: null, by: 'robot' };
    await setJ(K.ilanTasks, t.id, t); call.tasks.push(t.id);
  }
  await setJ(K.ilanCalls, file.id, call);
  await kv.hset(K.files, file.id, 'ilan');
  return { code: 200, body: { ok: true, tasks: call.tasks.length } };
}
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
    availText: f('availText', 400), rooms: f('rooms', 80),
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
  const watch = [], parses = [], mailScan = [], webLook = [], wa = [], webRedo = [], relisten = [];
  for (const h of hotels) {
    const t = Date.parse(h.createdAt || h.updatedAt || 0) || 0;
    for (const ph of [h.phone, h.phone2]) { const d = digits(ph); if (d.length >= 8 && Date.now() < t + WATCH_DAYS * 864e5) watch.push({ surveyId: sv.id, hotelId: h.id, phone: d, from: new Date(t - WATCH_DAYS * 864e5).toISOString(), to: new Date(t + WATCH_DAYS * 864e5).toISOString() }); }
    for (const p of (h.parse || []).slice(0, 3)) parses.push({ surveyId: sv.id, hotelId: h.id, id: p.id, text: p.text, name: h.name, src: p.src || 'paste' });
    // WhatsApp: hotels added in the last 60 days, by number + hotel name + contact person
    if (Date.now() < t + 60 * 864e5) for (const ph of [h.phone, h.phone2]) { const d = digits(ph).slice(-9); if (d.length >= 8) wa.push({ phone: d, names: [h.name, h.contact].map(x => String(x || '').trim()).filter(x => x.length >= 3) }); }
    const em = String(h.email || '').trim().toLowerCase();
    if (h.mailAsk) mailScan.unshift({ surveyId: sv.id, hotelId: h.id, email: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(em) ? em : '', name: h.name || '', phone: digits(h.phone).slice(-9), ask: true });
    else if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(em) && h.mailScan !== em) mailScan.push({ surveyId: sv.id, hotelId: h.id, email: em, name: h.name });
    // a new hotel: the robot looks it up on the web once (website, photos, missing details) - owner 19.11
    if (h.name && (h.webV || 0) < 5 && (h.webTries5 || 0) < 3 && !(h.webDone && h.website && (h.photos || []).length)) webLook.push({ surveyId: sv.id, hotelId: h.id, name: h.name, city: h.city || '', website: h.website || '' });
    // looked up without a real web search (no reviews yet): again once the robot can search (Claude key)
    if (h.name && h.webNoSearch && !h.webGrounded && (h.webRedoTries || 0) < 2) webRedo.push({ surveyId: sv.id, hotelId: h.id, name: h.name, city: h.city || '', website: h.website || '', redo: true });
  }
  for (const h of hotels) {
    if (!h.relisten || (h.relistenTries || 0) >= 3) continue;
    const files = (h.log || []).filter(l => l.t === 'call' && l.file?.id).map(l => ({ id: l.file.id, at: l.at }));
    if (files.length) relisten.push({ surveyId: sv.id, hotelId: h.id, files: files.slice(-3) });
  }
  return { watch, parses, mailScan, webLook, wa, webRedo, relisten };
}

async function userRec(id) { return (await getJ(K.users, id)) || { mode: { on: false }, windows: [] }; }
/** The robot this person's phone works with: his own if he installed one, otherwise the company's (the owner's). */
async function robotOf(id) { const u = await userRec(id); return (u.keyHash && u.app?.url) || id === 'owner' ? { id, u } : { id: 'owner', u: await userRec('owner') }; }
const saveUser = (id, u) => setJ(K.users, id, u);

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
  if (a.rooms) hotel.rooms = str(a.rooms, 80);
  // New prices replace the old ones for the same level + board; others are kept.
  const fresh = cleanPrices(r.prices);
  if (fresh.length) {
    const key = p => norm(p.level) + '|' + norm(p.board);
    const keep = (hotel.prices || []).filter(p => !fresh.some(f => key(f) === key(p)));
    hotel.prices = [...keep, ...fresh];
  }
  if (r.followUp?.needed) { if (r.followUp.date) hotel.followUp = str(r.followUp.date, 10); hotel.followWhat = str(r.followUp.what, 300); if (hotel.status === 'new') hotel.status = 'followup'; }
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
export function tableRows(sv, hotels) {
  const combos = [];
  for (const h of hotels) for (const p of h.prices || []) { const c = [p.level, p.board].filter(Boolean).join(' · ') || 'מחיר'; if (!combos.includes(c)) combos.push(c); }
  const head = ['מלון', 'עיר / אזור', 'איש קשר', 'טלפון', 'מייל', 'זמינות', 'פירוט זמינות', ...combos, 'הכי זול', 'סטטוס', 'לחזור בתאריך', 'מה לבדוק', 'שיחה אחרונה', 'סיכום', 'הערות'];
  const rows = hotels.map(h => {
    const price = c => { const p = (h.prices || []).find(x => ([x.level, x.board].filter(Boolean).join(' · ') || 'מחיר') === c); return p ? [p.price ?? '', p.per].filter(x => x !== '').join(' ') + (p.note ? ` (${p.note})` : '') : ''; };
    const lastCall = (h.log || []).filter(x => x.t === 'call').map(x => x.at).sort().pop();
    return [h.name, h.city, h.contact, [h.phone, h.phone2].filter(Boolean).join(' / '), h.email, AV_HE[h.avail] || '', h.availText, ...combos.map(price), minPrice(h) ?? '', ST_HE[h.status] || '', dmy(h.followUp), h.followWhat, lastCall ? new Date(lastCall).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '', h.summary, h.notes];
  });
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
    const ilanReq = Boolean(q('ilan') || body.op === 'ilan' || q('calls') || body.op === 'tag');   // the Ilan tab has its own rule (owner + מעיין), not the hotels area
    if (!ilanReq && !(await (await import('./_areas.js')).hasArea(s, 'hotels'))) return send(res, 403, { error: 'forbidden' });
    const uid = meId(s);

    /* ----- owner 22.11: every call on the work phone, sorted by who called (by the number): Ilan, a hotel, an artist, a client, other.
       It includes the calls with Ilan, so only the owner and מעיין see it (like the Ilan tab). ----- */
    if (q('calls') || body.op === 'tag') {
      if (!(isOwner(s) || ILAN_SEE.includes(uid))) return send(res, 403, { error: 'forbidden' });
      if (req.method === 'POST') {   // tag a number by hand → every call from it, now and later
        const d = digits(body.phone);
        if (d.length < 8) return send(res, 400, { error: 'phone' });
        if (body.cat === '') { await kv.hdel(K.book, d); return send(res, 200, { ok: true }); }
        const cat = pick(body.cat, ['hotel', 'artist', 'client', 'supplier', 'team', 'private', 'other'], 'other');
        await setJ(K.book, d, { cat, name: str(body.name, 80), by: s.n || '', at: now() });
        return send(res, 200, { ok: true });
      }
      const book = Object.fromEntries(Object.entries(await kv.hgetall(K.book)).map(([k, v]) => { try { return [k, JSON.parse(v)]; } catch (e) { return [k, null]; } }));
      const cfg = await ilanCfg();
      const files = await kv.hgetall(K.files);
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
      const ilanSum = Object.fromEntries((await allJ(K.ilanCalls)).map(c => [c.id, c.summary || '']));
      const callDigits = c => digits(c.phone) || digits((String(c.name || '').match(/(\+?972|0)\d[\d\- ]{7,12}/) || [''])[0]);
      const list = (await allJ(K.calls)).sort((a2, b2) => String(b2.at || '').localeCompare(String(a2.at || ''))).slice(0, 300).map(c => {
        const d = callDigits(c), f = files[c.id];
        let k = book[d] ? { cat: book[d].cat, who: book[d].name, byHand: true } : byPhone.get(d);
        if (!k && f === 'ilan') k = { cat: 'ilan', who: 'אילן' };
        if (!k && f && f !== 'skip' && byHotelId.has(f)) k = byHotelId.get(f);
        return { id: c.id, at: c.at, name: c.name, phone: d ? '0' + d.replace(/^0/, '') : '', url: c.url, summary: c.sum && !c.sum.error ? str(c.sum.summary || c.sum.answer || '', 600) : str(ilanSum[c.id] || '', 600), ...(k || { cat: 'other', who: '' }) };
      });
      const counts = {};
      for (const c of list) counts[c.cat] = (counts[c.cat] || 0) + 1;
      return send(res, 200, { calls: list, counts });
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
          const row = { key, name: ho.name, city: ho.city || '', area: sv.area || '', phone: ho.phone || '', contact: ho.contact || '', website: ho.website || '', rating: ho.rating || null,
            photo: (ho.myPhotos || [])[0] || (ho.photos || [])[0] || '', avail: ho.avail || 'unknown', availText: ho.availText || '', status: ho.status || 'new',
            min: mp ? { price: mp.price, per: mp.per || '', currency: mp.currency || 'ILS', what: [mp.level, mp.board].filter(Boolean).join(', ') } : null,
            prices: (ho.prices || []).slice(0, 6), summary: str(ho.summary || '', 300), lastAt: last, calls,
            surveys: [{ surveyId: sv.id, hotelId: ho.id, title: sv.title, from: sv.from || '', to: sv.to || '' }] };
          const old = map.get(key);
          if (!old) { map.set(key, row); continue; }
          const newer = String(row.lastAt) > String(old.lastAt) ? row : old, other = newer === row ? old : row;
          newer.surveys = [...new Map([...old.surveys, ...row.surveys].map(x => [x.surveyId + x.hotelId, x])).values()];
          newer.calls = old.calls + row.calls;
          if (!newer.min && other.min) newer.min = other.min;
          if (!newer.photo) newer.photo = other.photo;
          if (!newer.area) newer.area = other.area;
          map.set(key, newer);
        }
      }
      return send(res, 200, { hotels: [...map.values()] });
    }

    // Owner 19.11: calls with Ilan → a summary of what he asks for + a to-do list. Only the owner sees it.
    if (q('ilan') || body.op === 'ilan') {
      if (!(isOwner(s) || ILAN_SEE.includes(uid))) return send(res, 403, { error: 'forbidden' });   // owner 19.11: only the owner and Maayan
      if (req.method === 'GET') {
        const calls = (await allJ(K.ilanCalls)).filter(c => !c.hidden).sort((a2, b2) => String(b2.at).localeCompare(String(a2.at))).slice(0, 80);
        const tasks = (await allJ(K.ilanTasks)).sort((a2, b2) => (a2.done - b2.done) || String(b2.at).localeCompare(String(a2.at)));
        return send(res, 200, { cfg: await ilanCfg(), calls, tasks });
      }
      const act = str(body.act, 20);
      if (act === 'cfg') {
        const phones = [...new Set((Array.isArray(body.phones) ? body.phones : []).map(digits).filter(d => d.length >= 8))].slice(0, 5);
        const old = await ilanCfg();
        const since = old.since && phones.every(p => old.phones.includes(p)) ? old.since : new Date(Date.now() - ILAN_BACK_DAYS * 864e5).toISOString();
        const cfg = { phones, since };
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
      if (!h) h = { ...cleanHotel({ name: str(body.name, 120) || c.sum.who || c.name.replace(/\.[a-z0-9]{2,4}$/i, ''), phone: c.phone }), id: rid('h'), createdAt: now() };
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
          count: hs.length, avail: hs.filter(h => h.avail === 'available' || h.avail === 'partial').length, follow: hs.filter(h => h.status === 'followup').length };
      }));
      const managers = await managerList(req);
      return send(res, 200, { me: { id: uid, name: s.n, role: s.r }, mode: u.mode || { on: false }, windows: (u.windows || []).slice(-60), wa: await (async () => { const w = []; for (const sv of all) w.push(...robotJobs(sv, await allJ(K.hotels(sv.id))).wa); return w.slice(0, 300); })(), watch: await (async () => { const w = []; for (const sv of all) w.push(...robotJobs(sv, await allJ(K.hotels(sv.id))).watch.map(x => ({ phone: x.phone, from: x.from, to: x.to }))); return w.slice(0, 300); })(), connection: await (async () => { const r = (await robotOf(uid)).u; return { connected: !!r.keyHash, ping: r.ping || null, last: r.lastCall || null, skipped: r.skipped || 0, app: !!r.app?.url, appLast: r.app?.last || null }; })(), surveys, managers });
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

    if (op === 'hotel' || op === 'note' || op === 'mail' || op === 'draft' || op === 'paste' || op === 'photos' || op === 'mailNow' || op === 'relisten') {
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
        old.myPhotos = [...(old.myPhotos || []).filter(u => !rm.has(u)), ...add].filter((u, i, a) => a.indexOf(u) === i).slice(0, 24);
        if (rm.size) old.photos = (old.photos || []).filter(u => !rm.has(u));
        if (add.length) old.log = [...(old.log || []), { t: 'note', at: now(), by: s.n, text: add.length === 1 ? 'נוספה תמונה' : `נוספו ${add.length} תמונות` }].slice(-80);
        old.updatedAt = now();
        await setJ(key, old.id, old);
        return send(res, 200, { myPhotos: old.myPhotos, photos: old.photos || [] });
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
        old.log = [...(old.log || []), { t: 'note', at: now(), by: s.n, text }].slice(-80);
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

    // A hotel already checked in another card → copy it into this card, with its whole history (proof stays with it)
    if (op === 'copy') {
      const sv = await getJ(K.surveys, body.surveyId), from = await getJ(K.surveys, body.fromSurvey);
      if (!canSee(s, sv) || !canSee(s, from)) return send(res, 404, { error: 'not-found' });
      const src = await getJ(K.hotels(from.id), body.id);
      if (!src) return send(res, 404, { error: 'not-found' });
      const h = { ...src, id: rid('h'), avail: 'unknown', availText: '', prices: [], status: 'new', followUp: '', followWhat: '', createdAt: now(), updatedAt: now(),
        log: [...(src.log || []), { t: 'note', at: now(), by: s.n, text: `הועתק מהכרטיסייה "${from.title}". הזמינות והמחירים שם היו לתאריכים אחרים.` }].slice(-80) };
      await setJ(K.hotels(sv.id), h.id, h);
      return send(res, 200, { ...h, min: minPrice(h) });
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
    const asks = (await allJ(K.calls)).filter(c => c.owner === userId && c.ask && !c.sum).slice(0, 3).map(c => ({ id: c.id, name: c.name, at: c.at, q: c.q || '' }));
    let windows = u.windows || [], mode = u.mode || { on: false };
    if (userId === 'owner') {
      const all = Object.entries((await kv.hgetall(K.users)) || {}).map(([id, v]) => [id, typeof v === 'string' ? JSON.parse(v) : v]);
      const riders = all.filter(([id, x]) => id !== 'owner' && !(x.keyHash && x.app?.url));
      windows = windows.concat(...riders.map(([, x]) => x.windows || [])).sort((a2, b2) => String(a2.from).localeCompare(String(b2.from))).slice(-600);
      if (!mode.on) mode = (riders.map(([, x]) => x.mode).find(x => x?.on)) || mode;
    }
    const jobs = { watch: [], parses: [], mailScan: [], webLook: [], wa: [], webRedo: [], relisten: [] };
    for (const sv of surveys) { const j = robotJobs(sv, await allJ(K.hotels(sv.id))); jobs.watch.push(...j.watch); jobs.parses.push(...j.parses); jobs.mailScan.push(...j.mailScan); jobs.webLook.push(...j.webLook); jobs.wa.push(...j.wa); jobs.webRedo.push(...j.webRedo); jobs.relisten.push(...j.relisten); }
    let ilan = { phones: [] };
    if (userId === 'owner') {
      const c = await ilanCfg();
      if (c.phones.length && c.since) {
        // calls with him that are already in the robot's folder (uploaded earlier, e.g. in check mode) but not read for Ilan yet
        const have = await kv.hgetall(K.ilanCalls) || {};
        const files = (await allJ(K.calls)).filter(x => !have[x.id] && c.phones.includes(digits(x.phone)) && (Date.parse(x.at) || 0) >= Date.parse(c.since))
          .sort((a2, b2) => String(b2.at).localeCompare(String(a2.at))).slice(0, 2).map(x => ({ id: x.id, at: x.at }));   // newest first
        ilan = { phones: c.phones, since: c.since, files };
        const to = new Date(Date.now() + 3650 * 864e5).toISOString();
        jobs.watch.unshift(...c.phones.map(p => ({ ilan: true, phone: p, from: c.since, to })));
      }
    }
    return send(res, 200, { ilan, windows, mode, surveys: active, outbox, threads, asks, watch: jobs.watch.slice(0, 300), parses: jobs.parses.slice(0, 5), mailScan: jobs.mailScan.slice(0, 5), webLook: jobs.webLook.slice(0, 3), webRedo: jobs.webRedo.slice(0, 2), relisten: jobs.relisten.slice(0, 1), wa: jobs.wa.slice(0, 300) });
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
    for (const it of items) {
      const id = str(it.id, 120);
      if (!id || old[id]) continue;
      const rec = { id, owner: userId, name: str(it.name, 200), phone: str(it.phone, 30), at: str(it.at, 30), url: link(it.url, 300) };
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
    const r = b.result || {};
    if (!r.relevant) {
      u.skipped = (u.skipped || 0) + 1; await saveUser(userId, u);
      await kv.hset(K.files, file.id, 'skip');
      return send(res, 200, { ok: true, skipped: true });
    }
    const sv = await getJ(K.surveys, b.surveyId);
    if (!mine(sv, userId)) return send(res, 400, { error: 'survey' });
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
      to.myPhotos = [...new Set([...(to.myPhotos || []), ...(cur.myPhotos || [])])].slice(0, 24);
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
    if (jobId) h.parse = (h.parse || []).filter(p => p.id !== jobId);
    const r = b.result || {};
    if (!b.error && r && (r.summary || (r.prices || []).length || r.availability || r.hotel)) {
      const src = pick(b.src, ['paste', 'mail', 'wa'], 'paste');
      mergeCall(h, { ...r, hotel: r.hotel || {} }, { t: 'text', src, at: now(), summary: str(r.summary, 1500), avail: pick(r.availability?.status, AVAIL, 'unknown'), availText: str(r.availability?.text, 400), quotes: (Array.isArray(r.keyQuotes) ? r.keyQuotes : []).slice(0, 8).map(x => ({ time: '', who: str(x.speaker, 40), text: str(x.text, 500) })) });
    } else if (b.error) h.log = [...(h.log || []), { t: 'note', at: now(), by: 'המערכת', text: 'לא הצלחתי לקרוא את הטקסט: ' + str(b.error, 200) }].slice(-80);
    h.updatedAt = now();
    await setJ(key, h.id, h);
    await saveUser(userId, u);
    return send(res, 200, { ok: true });
  }

  // WhatsApp messages from a hotel (owner 19.11): kept in its history, and read for prices / rooms / hours like a pasted text
  if (what === 'wa') {
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 100);
    const byPhone = {};
    for (const it of items) { const d = digits(it.phone).slice(-9); if (d.length >= 8 && str(it.text, 4000).trim()) (byPhone[d] = byPhone[d] || []).push(it); }
    let filed = 0;
    for (const sv of (await allJ(K.surveys)).filter(x => mine(x, userId))) {
      const key = K.hotels(sv.id);
      for (const h of await allJ(key)) {
        const d = [h.phone, h.phone2].map(x => digits(x).slice(-9)).find(x => x.length >= 8 && byPhone[x]);
        if (!d) continue;
        const msgs = byPhone[d];
        h.log = [...(h.log || []), ...msgs.map(m => ({ t: 'wa', at: str(m.at, 40) || now(), from: str(m.from, 120), text: str(m.text, 4000) }))].slice(-80);
        h.parse = [...(h.parse || []), { id: rid('p'), src: 'wa', at: now(), by: 'וואטסאפ', text: msgs.map(m => 'הודעת וואטסאפ מ' + str(m.from, 120) + ' (' + str(m.at, 40) + '):\n' + str(m.text, 4000)).join('\n\n').slice(0, 20000) }].slice(-5);
        h.updatedAt = now();
        await setJ(key, h.id, h);
        filed++;
      }
    }
    return send(res, 200, { ok: true, filed });
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
    if (b.redo) h.webRedoTries = (h.webRedoTries || 0) + 1;
    if (b.grounded === false) h.webNoSearch = true;
    if (b.grounded === true && b.found) { h.webGrounded = true; delete h.webNoSearch; }
    if (b.found) {
      h.webDone = true;
      const g = b.hotel || {};
      const safe = u => /^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u).slice(0, 500) : null;
      // only fills what is empty: what LBV typed always wins
      for (const k of (b.grounded === false ? ['city'] : ['city', 'phone', 'email'])) if (!h[k] && g[k]) h[k] = str(g[k], 160);
      if (!safe(h.website) && safe(g.website)) h.website = safe(g.website);
      const ph = (Array.isArray(b.photos) ? b.photos : []).map(safe).filter(Boolean);
      if (ph.length) h.photos = [...new Set(ph)].slice(0, 8);
      if (g.about && !h.about) h.about = str(g.about, 400);
      if (b.grounded === false) { h.webV = 3; await setJ(key, h.id, h); return send(res, 200, { ok: true }); }   // no search: no ratings / phone / e-mail
      h.webV = 5;
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

  if (what === 'mailscan') {
    const sv = await getJ(K.surveys, str(b.surveyId, 40));
    if (!mine(sv, userId)) return send(res, 404, { error: 'not-found' });
    const key = K.hotels(sv.id), h = await getJ(key, str(b.hotelId, 40));
    if (!h) return send(res, 404, { error: 'not-found' });
    if (b.email) h.mailScan = str(b.email, 160).toLowerCase();
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
    return send(res, 200, { title: sv.title, rows: tableRows(sv, await allJ(K.hotels(sv.id))) });
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
