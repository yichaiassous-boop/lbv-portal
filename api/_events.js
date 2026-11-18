// לוח אירועים + the settings of the LBV app (the screens remote link).
// Served at /api/events (vercel.json rewrites it into /api/quotes?_e=1, to stay within the plan's function count).
// Storage: the same Redis as the hotel survey (locally: data/hotels.local.json).
//
// Who may do what (every call needs a logged-in manager):
//   see the calendar        every manager
//   add / change an event   owner, admin, sales
//   delete an event         owner, admin
//   open the screens remote owner, admin          (the link holds the remote's key: it is never sent to anyone else)
//   set the remote link     owner only
//
//   GET                                → { me, can, events, remote: { set, url? } }
//   POST { op:"event", … }             → create / update an event
//   DELETE ?id=<id>                    → delete an event
//   POST { op:"remote", url }          → save the remote link ("" removes it)
import crypto from 'node:crypto';
import { isAuthed, readBody } from './_lib.js';
import { hotelsReady, kv, getJ, setJ, allJ } from './_hotels.js';

const K = { events: 'ev:all', app: 'app:settings' };
const KINDS = ['wedding', 'barmitzvah', 'batmitzvah', 'shabbat', 'gala', 'holiday', 'other'];
const STATUS = ['option', 'confirmed', 'done', 'cancelled'];
const ROLES_EDIT = ['owner', 'admin', 'sales'], ROLES_DEL = ['owner', 'admin'], ROLES_REMOTE = ['owner', 'admin'];
const REMOTE_HOST = 'lbv-screens.vercel.app';

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

/** The remote link: only https://lbv-screens.vercel.app/… is accepted. */
function cleanRemote(u) {
  const s = str(u, 600);
  if (!s) return '';
  try { const x = new URL(s); return x.protocol === 'https:' && x.hostname === REMOTE_HOST ? x.toString() : null; } catch (e) { return null; }
}

export default async function eventsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hotelsReady()) return send(res, 503, { error: 'not-configured' });
  const s = req.lbvUser || isAuthed(req);
  if (!s) return send(res, 401, { error: 'login' });
  const role = s.r, who = s.n || '';
  const may = { edit: ROLES_EDIT.includes(role), del: ROLES_DEL.includes(role), remote: ROLES_REMOTE.includes(role), setRemote: role === 'owner' };
  const url = new URL(req.url, 'http://x');
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') { try { body = (await readBody(req)) || {}; } catch (e) { return send(res, 400, { error: 'bad-json' }); } }

  try {
    if (req.method === 'GET') {
      const events = (await allJ(K.events)).sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
      const app = (await getJ(K.app, 'remote')) || {};
      return send(res, 200, { me: { name: who, role }, can: may, events, remote: { set: !!app.url, url: may.remote ? app.url || '' : undefined } });
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
    if (req.method === 'POST' && body.op === 'remote') {
      if (!may.setRemote) return send(res, 403, { error: 'forbidden' });
      const u = cleanRemote(body.url);
      if (u === null) return send(res, 400, { error: 'bad-url' });
      await setJ(K.app, 'remote', { url: u, by: who, at: now() });
      return send(res, 200, { ok: true, set: !!u });
    }
    return send(res, 400, { error: 'bad-request' });
  } catch (e) {
    console.error('events', e && e.message);
    return send(res, 500, { error: 'server' });
  }
}
