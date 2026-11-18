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
  users: 'hs:user',                  // userId → { mode, windows, keyHash, ping }
  keys: 'hs:keys',                   // sha256(key) → userId
  out: 'hs:out',                     // mail id → queued e-mail
  files: 'hs:files',                 // recording file id → hotel it went to (or "skip")
  calls: 'hs:calls',                 // every recording on the work phone: file id → { name, phone, at, url, ask, sum }
};

/* ---------- small helpers ---------- */
const now = () => new Date().toISOString();
const rid = p => p + crypto.randomBytes(6).toString('hex');
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
const num = v => { const n = Number(String(v ?? '').replace(/[^\d.\-]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.round(n * 100) / 100 : null; };
const pick = (v, ok, d) => (ok.includes(v) ? v : d);
const digits = p => String(p || '').replace(/\D/g, '').replace(/^972/, '0').slice(-9);
const norm = s => String(s || '').toLowerCase().replace(/["'״׳`.,\-–()]/g, ' ').replace(/\b(מלון|hotel|ה)\b/g, ' ').replace(/\s+/g, ' ').trim();
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
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
    title: str(b.title ?? old.title, 120) || 'סקר מלונות',
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

async function userRec(id) { return (await getJ(K.users, id)) || { mode: { on: false }, windows: [] }; }
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
      if (!sv || !sv.link || q('t') !== viewToken(sv.id)) return send(res, 404, { error: 'not-found' });
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
    const uid = meId(s);

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
        .map(c => ({ id: c.id, at: c.at, name: c.name, phone: c.phone, url: c.url, ask: !!c.ask, sum: c.sum || null }));
      const u = await userRec(uid);
      return send(res, 200, { results: out.slice(0, 10), phone, indexed: !!u.indexedAt || phone.length > 0 });
    }

    // "Yes, summarize that call" → the robot listens to it on its next run (about 5 minutes)
    if (req.method === 'POST' && body.op === 'ask') {
      const c = await getJ(K.calls, str(body.id, 120));
      if (!c || !(isOwner(s) || c.owner === uid)) return send(res, 404, { error: 'not-found' });
      if (!c.sum || c.sum.error) { c.ask = true; c.sum = null; c.askedAt = now(); await setJ(K.calls, c.id, c); }
      return send(res, 200, { id: c.id, ask: !!c.ask, sum: c.sum || null });
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
      return send(res, 200, { me: { id: uid, name: s.n, role: s.r }, mode: u.mode || { on: false }, connection: { connected: !!u.keyHash, ping: u.ping || null, last: u.lastCall || null, skipped: u.skipped || 0 }, surveys, managers });
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

    if (op === 'hotel' || op === 'note' || op === 'mail' || op === 'draft') {
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
    return send(res, 500, { error: 'server', detail: String(e.message || e).slice(0, 200) });
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
      if (m.t === 'mail-out' && m.threadId && Date.now() - Date.parse(m.at) < 60 * 864e5) threads.push({ surveyId: sv.id, hotelId: h.id, threadId: m.threadId, seen: (h.log || []).filter(x => x.t === 'mail-in').map(x => x.msgId) });
    // Phone calls the owner asked to summarize ("you talked a week ago, want a summary?" → yes)
    const asks = (await allJ(K.calls)).filter(c => c.owner === userId && c.ask && !c.sum).slice(0, 3).map(c => ({ id: c.id, name: c.name, at: c.at }));
    return send(res, 200, { windows: u.windows || [], mode: u.mode || { on: false }, surveys: active, outbox, threads, asks });
  }

  // Every recording on the work phone, names only (no listening): file id, file name, number, time
  if (what === 'index') {
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 500);
    const old = await kv.hgetall(K.calls) || {};
    let n = 0;
    for (const it of items) {
      const id = str(it.id, 120);
      if (!id || old[id]) continue;
      await setJ(K.calls, id, { id, owner: userId, name: str(it.name, 200), phone: str(it.phone, 30), at: str(it.at, 30), url: str(it.url, 300) });
      n++;
    }
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
    };
    await setJ(K.calls, c.id, c);
    return send(res, 200, { ok: true });
  }

  if (what === 'call') {
    const file = { id: str(b.file?.id, 120), name: str(b.file?.name, 200), url: str(b.file?.url, 400) };
    if (!file.id) return send(res, 400, { error: 'file' });
    if (await kv.hget(K.files, file.id)) return send(res, 200, { ok: true, duplicate: true });
    const r = b.result || {};
    if (!r.relevant) {
      u.skipped = (u.skipped || 0) + 1; await saveUser(userId, u);
      await kv.hset(K.files, file.id, 'skip');
      return send(res, 200, { ok: true, skipped: true });
    }
    const sv = await getJ(K.surveys, b.surveyId);
    if (!sv) return send(res, 400, { error: 'survey' });
    const key = K.hotels(sv.id);
    const hotels = await allJ(key);
    const call = {
      t: 'call', at: str(b.at, 40) || now(), file, dur: str(r.duration, 20),
      summary: str(r.summary, 1500), quotes: (Array.isArray(r.keyQuotes) ? r.keyQuotes : []).slice(0, 12).map(x => ({ time: str(x.time, 12), who: str(x.speaker, 40), text: str(x.text, 500) })),
      avail: pick(r.availability?.status, AVAIL, 'unknown'), availText: str(r.availability?.text, 400),
      transcript: str(r.transcript, 30000),
    };
    let h = findHotel(hotels, r.hotel || {});
    if (!h) h = { ...cleanHotel({ name: r.hotel?.name || file.name, status: 'new' }), id: rid('h'), createdAt: now(), log: [] };
    mergeCall(h, r, call);
    h.updatedAt = now();
    await setJ(key, h.id, h);
    await kv.hset(K.files, file.id, h.id);
    u.lastCall = now(); await saveUser(userId, u);
    return send(res, 200, { ok: true, hotelId: h.id, name: h.name });
  }

  if (what === 'mailsent') {
    const m = await getJ(K.out, str(b.id, 40));
    if (!m) return send(res, 404, { error: 'not-found' });
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
      const key = K.hotels(str(x.surveyId, 40)), h = await getJ(key, str(x.hotelId, 40));
      if (!h) continue;
      const msgId = str(x.msgId, 80);
      if ((h.log || []).some(l => l.msgId === msgId)) continue;
      h.log = [...(h.log || []), { t: 'mail-in', at: str(x.at, 40) || now(), from: str(x.from, 200), subject: str(x.subject, 200), body: str(x.body, 12000), msgId, threadId: str(x.threadId, 80), files: (Array.isArray(x.files) ? x.files : []).slice(0, 10).map(f => ({ name: str(f.name, 160), url: str(f.url, 400) })) }].slice(-80);
      await setJ(key, h.id, h); added++;
    }
    await saveUser(userId, u);
    return send(res, 200, { ok: true, added });
  }

  if (what === 'export') {
    const sv = await getJ(K.surveys, url(req).get('survey'));
    if (!sv) return send(res, 404, { error: 'not-found' });
    return send(res, 200, { title: sv.title, rows: tableRows(sv, await allJ(K.hotels(sv.id))) });
  }

  if (what === 'sheet') {
    const sv = await getJ(K.surveys, str(b.surveyId, 40));
    if (!sv) return send(res, 404, { error: 'not-found' });
    sv.sheetUrl = str(b.url, 300); await setJ(K.surveys, sv.id, sv);
    return send(res, 200, { ok: true });
  }

  return send(res, 400, { error: 'what' });
}
const url = req => new URL(req.url, 'http://x').searchParams;
