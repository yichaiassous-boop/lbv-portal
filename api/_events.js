// לוח אירועים + the settings of the LBV app (the screens remote link).
// Served at /api/events (vercel.json rewrites it into /api/quotes?_e=1, to stay within the plan's function count).
// Storage: the same Redis as the hotel survey (locally: data/hotels.local.json).
//
// Who may do what (every call needs a logged-in manager):
//   see the calendar        every manager
//   add / change an event   owner, admin, sales
//   delete an event         owner, admin
//   the screens remote      owner, admin          (same Redis keys as lbv-screens, see _screens.js)
//   and only for a manager the owner gave that area (_areas.js: "events", "remote")
//
//   GET                                → { me, can, events }
//   GET ?screens=1                     → the remote: step, prices, donations, video player
//   POST { op:"event", … }             → create / update an event
//   DELETE ?id=<id>                    → delete an event
//   POST { op:"screens", step|link|prices|newEvening } → change the evening screen
//   POST { op:"open", page:"screen"|"video"|"videoremote" } → one-time link to a page of lbv-screens
import crypto from 'node:crypto';
import { isAuthed, readBody } from './_lib.js';
import { hotelsReady, kv, getJ, setJ, allJ } from './_hotels.js';
import { screensState, screensChange, openTicket } from './_screens.js';
import { areasOf } from './_areas.js';

const K = { events: 'ev:all' };
const KINDS = ['wedding', 'barmitzvah', 'batmitzvah', 'shabbat', 'gala', 'holiday', 'other'];
const STATUS = ['option', 'confirmed', 'done', 'cancelled'];
const ROLES_EDIT = ['owner', 'admin', 'sales'], ROLES_DEL = ['owner', 'admin'];

const send = (res, code, obj) => res.status(code).json(obj);
const now = () => new Date().toISOString();
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
const pick = (v, ok, d) => (ok.includes(v) ? v : d);
const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(Date.parse(v)) ? v : '');
const hhmm = v => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')) ? v : '');

function cleanEvent(b, old = {}) {
  const date = day(b.date) || old.date || '';
  const end = day(b.end);
  return {
    id: old.id || 'e' + crypto.randomBytes(6).toString('hex'),
    title: str(b.title, 120) || old.title || '',
    kind: pick(b.kind, KINDS, old.kind || 'other'),
    status: pick(b.status, STATUS, old.status || 'option'),
    date, end: end && end >= date ? end : '',
    time: hhmm(b.time), place: str(b.place, 160), client: str(b.client, 120),
    phone: str(b.phone, 40).replace(/[^\d+\-() ]/g, ''), guests: Math.max(0, Math.min(5000, Math.round(Number(b.guests) || 0))) || '',
    staff: str(b.staff, 300), notes: str(b.notes, 3000),
    createdAt: old.createdAt || now(), createdBy: old.createdBy || '', updatedAt: now(),
  };
}

export default async function eventsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hotelsReady()) return send(res, 503, { error: 'not-configured' });
  const s = req.lbvUser || isAuthed(req);
  if (!s) return send(res, 401, { error: 'login' });
  const role = s.r, who = s.n || '';
  const ar = await areasOf(s);   // what the owner gave this manager (see _areas.js)
  const may = { events: ar.includes('events'), edit: ar.includes('events') && ROLES_EDIT.includes(role), del: ar.includes('events') && ROLES_DEL.includes(role), remote: ar.includes('remote') };
  const url = new URL(req.url, 'http://x');
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') { try { body = (await readBody(req)) || {}; } catch (e) { return send(res, 400, { error: 'bad-json' }); } }

  try {
    if (req.method === 'GET' && url.searchParams.get('screens')) {
      if (!may.remote) return send(res, 403, { error: 'forbidden' });
      return send(res, 200, await screensState());
    }
    if (req.method === 'GET') {
      if (!may.events) return send(res, 403, { error: 'forbidden' });
      const events = (await allJ(K.events)).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
      return send(res, 200, { me: { name: who, role }, can: may, events });
    }
    if (req.method === 'POST' && ['screens', 'open'].includes(body.op)) {
      if (!may.remote) return send(res, 403, { error: 'forbidden' });
      const r = body.op === 'screens' ? await screensChange(body) : await openTicket(body.page);
      if (r.error) return send(res, 400, r);
      return send(res, 200, body.op === 'open' ? r : { ...r, state: await screensState() });
    }
    if (req.method === 'POST' && body.op === 'event') {
      if (!may.edit) return send(res, 403, { error: 'forbidden' });
      const old = body.id ? await getJ(K.events, String(body.id)) : null;
      if (body.id && !old) return send(res, 404, { error: 'not-found' });
      const ev = cleanEvent(body, old || { createdBy: who });
      if (!ev.title || !ev.date) return send(res, 400, { error: 'missing' });
      await setJ(K.events, ev.id, ev);
      return send(res, 200, { event: ev });
    }
    if (req.method === 'DELETE') {
      if (!may.del) return send(res, 403, { error: 'forbidden' });
      const id = String(url.searchParams.get('id') || '');
      if (!/^e[0-9a-f]{12}$/.test(id)) return send(res, 400, { error: 'bad-id' });
      await kv.hdel(K.events, id);
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: 'bad-request' });
  } catch (e) {
    console.error('events', e && e.message);
    return send(res, 500, { error: 'server' });
  }
}
