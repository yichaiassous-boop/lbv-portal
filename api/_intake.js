// /api/intake (owner 25.11): the client's form. We send the client a link (or fill it ourselves during the call):
// what event, when, how many guests, where, the budget and what they need. The client sees only these questions,
// never our places or prices. When it is filled, an event card opens by itself (the hotels/halls card + the calendar
// when there is a date), and the manager sees the places from our catalog that fit, and decides what to offer.
// Who: only a manager the owner gave the "intake" area (for now the owner and מעיין).
// Served through /api/quotes?_i=1 (vercel.json), to stay within the plan's function count.
//
// Manager (logged in, area "intake"):
//   GET                          → { forms }
//   POST { op:"new", name, phone }        → a new form + its link
//   POST { op:"fill", id?, answers }      → the manager fills it (creates the form when there is no id)
//   POST { op:"del", id }                 → delete the form (the event card stays)
// Client (no login, the form's signed link):
//   GET  ?f=<id>&t=<token>       → { name, done, lang }
//   POST ?f=<id>&t=<token> { answers, lang } → saved once; the card opens
import crypto from 'node:crypto';
import { isAuthed, readBody } from './_lib.js';
import { hotelsReady, getJ, setJ, allJ, kv } from './_hotels.js';
import { areasOf } from './_areas.js';

const KEY = 'in:all';
const SURVEYS = 'hs:surveys', EVENTS = 'ev:all';
const MAAYAN = 'cad5d8ff-c32d-4df9-918e-38cfd1d315d8';   // the owner's partner in these tools (owner 25.11)
export const IN_KINDS = {
  wedding: { he: 'חתונה', ev: 'wedding' }, barmitzvah: { he: 'בר מצווה', ev: 'barmitzvah' }, batmitzvah: { he: 'בת מצווה', ev: 'batmitzvah' },
  shabbat: { he: 'שבת חתן', ev: 'shabbat' }, brit: { he: 'ברית', ev: 'other' }, corporate: { he: 'אירוע חברה', ev: 'other' },
  funday: { he: 'יום כיף', ev: 'other' }, gala: { he: 'ערב גאלה', ev: 'gala' }, other: { he: 'אירוע', ev: 'other' },
};
const NEEDS = ['venue', 'hotel', 'fun', 'artist', 'all'];
const NEED_HE = { venue: 'מקום לאירוע', hotel: 'מלון ולינה', fun: 'אטרקציות', artist: 'אמן או מוזיקה', all: 'הפקה מלאה' };

const send = (res, code, obj) => res.status(code).json(obj);
const now = () => new Date().toISOString();
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v)) ? v : '');
const int = (v, max) => { const n = Math.round(Number(String(v ?? '').replace(/[,\s₪€$]/g, ''))); return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0; };
const secret = () => process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || '';
export const formToken = id => crypto.createHmac('sha256', secret()).update('intake:' + id).digest('base64url').slice(0, 22);
const sameTok = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const rid = p => p + crypto.randomBytes(6).toString('hex');

/** What the client (or we) answered, cleaned. */
function cleanAnswers(b = {}) {
  return {
    name: str(b.name, 120), phone: str(b.phone, 40).replace(/[^\d+\-() ]/g, ''), email: str(b.email, 160),
    kind: IN_KINDS[b.kind] ? b.kind : 'other', kindText: str(b.kindText, 80),
    date: day(b.date), dateNote: str(b.dateNote, 120),
    guests: int(b.guests, 5000),
    area: str(b.area, 80), areaText: str(b.areaText, 120),
    budget: int(b.budget, 10000000), budgetPer: b.budgetPer === 'guest' ? 'guest' : 'total',
    needs: (Array.isArray(b.needs) ? b.needs : []).filter(x => NEEDS.includes(x)),
    notes: str(b.notes, 2000),
  };
}
const kindHe = a => (a.kind === 'other' && a.kindText) || IN_KINDS[a.kind].he;
const areaHe = a => [a.area, a.areaText].filter(Boolean).join(', ');
const budgetHe = a => (a.budget ? a.budget.toLocaleString('he-IL') + ' ₪' + (a.budgetPer === 'guest' ? ' לאורח' : ' בסך הכול') : '');

/** The form is filled: the event card opens (the places card always, the calendar when there is a date). */
async function openCard(f) {
  const a = f.answers, title = kindHe(a) + (a.name ? ' ' + a.name : '');
  const lines = [a.guests ? a.guests + ' אורחים' : '', areaHe(a) ? 'אזור: ' + areaHe(a) : '', budgetHe(a) ? 'תקציב: ' + budgetHe(a) : '',
    a.needs.length ? 'צריך: ' + a.needs.map(n => NEED_HE[n]).join(', ') : '', a.dateNote ? 'תאריך: ' + a.dateNote : '',
    a.phone ? 'טלפון: ' + a.phone : '', a.email ? 'מייל: ' + a.email : '', a.notes ? 'הערות: ' + a.notes : ''].filter(Boolean);
  if (!f.surveyId) {
    const sv = { title: title.slice(0, 120), kind: kindHe(a).slice(0, 40), from: a.date, to: a.date, need: a.guests ? a.guests + ' אורחים' : '',
      note: ('מהטופס של הלקוח:\n' + lines.join('\n')).slice(0, 2000), area: areaHe(a).slice(0, 120),
      levels: ['בסיסי', 'בינוני', 'יוקרתי'], mailLang: 'he', sheet: true,
      id: rid('s'), by: { id: f.by.id, name: f.by.name }, shared: f.by.id === MAAYAN ? [] : [MAAYAN], link: false, createdAt: now(), intake: f.id };
    await setJ(SURVEYS, sv.id, sv);
    f.surveyId = sv.id;
  }
  if (!f.eventId && a.date) {
    const ev = { id: 'e' + crypto.randomBytes(6).toString('hex'), title: title.slice(0, 120), kind: IN_KINDS[a.kind].ev, status: 'talk',
      date: a.date, end: '', time: '', place: '', client: a.name, phone: a.phone, guests: a.guests || '', staff: '',
      notes: ('מהטופס של הלקוח:\n' + lines.join('\n')).slice(0, 3000), artist: '', createdAt: now(), createdBy: f.by.name || '', updatedAt: now(), intake: f.id };
    await setJ(EVENTS, ev.id, ev);
    f.eventId = ev.id;
  }
}

const forList = f => ({ ...f, link: '/form/?f=' + f.id + '&t=' + formToken(f.id) });

export default async function intakeHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hotelsReady()) return send(res, 503, { error: 'not-configured' });
  const url = new URL(req.url, 'http://x');
  let body = {};
  if (req.method === 'POST') { try { body = (await readBody(req)) || {}; } catch (e) { return send(res, 400, { error: 'bad-json' }); } }

  try {
    // ----- the client's signed link -----
    const fid = url.searchParams.get('f');
    if (fid) {
      if (!/^i[0-9a-f]{12}$/.test(fid) || !sameTok(url.searchParams.get('t'), formToken(fid))) return send(res, 404, { error: 'not-found' });
      const f = await getJ(KEY, fid);
      if (!f) return send(res, 404, { error: 'not-found' });
      if (req.method === 'GET') return send(res, 200, { name: f.client?.name || '', phone: f.client?.phone || '', done: !!f.filledAt, lang: f.lang || 'he' });
      if (req.method !== 'POST') return send(res, 405, { error: 'method' });
      if (f.filledAt) return send(res, 409, { error: 'done' });
      const a = cleanAnswers({ name: f.client?.name, phone: f.client?.phone, ...(body.answers || {}) });
      if (!a.name || (!a.date && !a.dateNote) || !a.guests) return send(res, 400, { error: 'missing' });
      f.answers = a; f.filledAt = now(); f.filledBy = 'client'; f.lang = body.lang === 'fr' ? 'fr' : 'he'; f.seen = false;
      await openCard(f);
      await setJ(KEY, f.id, f);
      return send(res, 200, { ok: true });
    }

    // ----- the managers -----
    const s = req.lbvUser || isAuthed(req);
    if (!s) return send(res, 401, { error: 'login' });
    if (!(await areasOf(s)).includes('intake')) return send(res, 403, { error: 'forbidden' });
    const who = { id: s.id || s.n || '', name: s.n || '' };

    if (req.method === 'GET') {
      const forms = (await allJ(KEY)).sort((x, y) => String(y.filledAt || y.createdAt).localeCompare(String(x.filledAt || x.createdAt)));
      return send(res, 200, { forms: forms.map(forList) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const op = str(body.op, 20);
    if (op === 'new') {
      const name = str(body.name, 120);
      if (!name) return send(res, 400, { error: 'name' });
      const f = { id: rid('i'), client: { name, phone: str(body.phone, 40).replace(/[^\d+\-() ]/g, '') }, by: who, createdAt: now(), lang: body.lang === 'fr' ? 'fr' : 'he' };
      await setJ(KEY, f.id, f);
      return send(res, 200, { form: forList(f) });
    }
    if (op === 'fill') {
      let f = body.id ? await getJ(KEY, str(body.id, 20)) : null;
      if (body.id && !f) return send(res, 404, { error: 'not-found' });
      const a = cleanAnswers(body.answers || {});
      if (!a.name || (!a.date && !a.dateNote) || !a.guests) return send(res, 400, { error: 'missing' });
      if (!f) f = { id: rid('i'), client: { name: a.name, phone: a.phone }, by: who, createdAt: now(), lang: 'he' };
      f.answers = a; f.filledAt = f.filledAt || now(); f.filledBy = f.filledBy || who.name || 'manager'; f.seen = true;
      await openCard(f);
      await setJ(KEY, f.id, f);
      return send(res, 200, { form: forList(f) });
    }
    if (op === 'seen') {
      const f = await getJ(KEY, str(body.id, 20));
      if (!f) return send(res, 404, { error: 'not-found' });
      f.seen = true; await setJ(KEY, f.id, f);
      return send(res, 200, { ok: true });
    }
    if (op === 'del') {
      const id = str(body.id, 20);
      if (!/^i[0-9a-f]{12}$/.test(id)) return send(res, 400, { error: 'bad-id' });
      await kv.hdel(KEY, id);
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: 'bad-request' });
  } catch (e) {
    console.error('intake', e && e.message);
    return send(res, 500, { error: 'server' });
  }
}
