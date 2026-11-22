// Artists we represent (owner 22.11: the singer Aaron Meir is the first).
// One page per artist: his own color, his networks, his events in the calendar, the people who call about him, and the calls.
// Served at /api/artists (vercel.json rewrites it into /api/quotes?_a=1, to stay within the plan's function count).
// Storage: the same Redis as the hotel survey and the calendar (hash "ar:all"). His events are calendar events with event.artist = his id.
//
//   GET                       (manager with the calendar area)  → { can, artists:[{…, events, calls, link}] }
//   POST { op:"artist", … }   (owner, admin)                    → create / update an artist
//   DELETE ?id=<id>           (owner)                           → remove an artist (his events stay in the calendar)
//   GET ?view=<id>&t=<token>  (no login: the artist's own link) → only his page: details, networks, events, calls (no recordings)
import crypto from 'node:crypto';
import { isAuthed, readBody, hashPassword, checkPassword } from './_lib.js';
import { loadUsers, loadOwner } from './_users.js';
import { hotelsReady, kv, getJ, setJ, allJ } from './_hotels.js';
import { areasOf } from './_areas.js';
import { netStats } from './_nets.js';

const K = { artists: 'ar:all', events: 'ev:all', calls: 'hs:calls' };
const ROLES_EDIT = ['owner', 'admin'];

const send = (res, code, obj) => res.status(code).json(obj);
const now = () => new Date().toISOString();
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
const digits = p => String(p || '').replace(/\D/g, '').replace(/^972/, '0').slice(-9);
const color = v => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : '');
const handle = v => str(v, 80).replace(/^@/, '').replace(/[^\w.]/g, '');
const secret = () => process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || 'local';
export const artistToken = id => crypto.createHmac('sha256', secret()).update('artist:' + id).digest('base64url').slice(0, 22);
const same = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* ----- owner 22.11: the artist logs in to the app with his own username + password and sees only his page.
   His session is a separate cookie (lbv_artist): the admin never accepts it (isAuthed knows only the managers' roles). ----- */
const AC = 'lbv_artist', AC_DAYS = 90;
const sign = p => crypto.createHmac('sha256', secret()).update('artist-session:' + p).digest('base64url');
export const artistCookie = id => { const p = Buffer.from(JSON.stringify({ a: id, exp: Date.now() + AC_DAYS * 864e5 })).toString('base64url'); return `${AC}=${p}.${sign(p)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${AC_DAYS * 86400}`; };
export const artistClear = `${AC}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
function artistSession(req) {
  const raw = (req.headers.cookie || '').split(/;s*/).find(c => c.startsWith(AC + '='));
  if (!raw) return null;
  const [p, mac] = raw.slice(AC.length + 1).split('.');
  if (!p || !mac || !same(mac, sign(p))) return null;
  try { const s = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return s && s.exp > Date.now() && /^a[0-9a-f]{12}$/.test(s.a) ? s.a : null; } catch (e) { return null; }
}
/** Login from the app's login page: an artist's username + password → his id (or null). */
export async function artistLogin(name, password) {
  if (!hotelsReady() || !name) return null;
  const a = (await allJ(K.artists)).find(x => x.login?.username === name);
  return a && checkPassword(password, a.login.hash) ? a.id : null;
}
const uname = v => String(v || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);

const NETS = ['instagram', 'tiktok', 'youtube', 'facebook', 'spotify'];
function cleanArtist(b, old = {}) {
  const nets = {};
  for (const n of NETS) { const v = b.nets && b.nets[n] != null ? handle(b.nets[n]) : (old.nets || {})[n] || ''; if (v) nets[n] = v; }
  const contacts = (Array.isArray(b.contacts) ? b.contacts : old.contacts || []).slice(0, 60)
    .map(c => ({ name: str(c.name, 80), phone: str(c.phone, 40).replace(/[^\d+\-() ]/g, ''), role: str(c.role, 60) }))
    .filter(c => c.name || digits(c.phone).length >= 7);
  return {
    id: old.id || 'a' + crypto.randomBytes(6).toString('hex'),
    name: str(b.name, 80) || old.name || '',
    nameFr: b.nameFr != null ? str(b.nameFr, 80) : old.nameFr || '',   // the name in Latin letters, for the page in French
    title: b.title != null ? str(b.title, 80) : old.title || '',
    color: color(b.color) || old.color || '#7a2e4d',
    nets, contacts,
    notes: b.notes != null ? str(b.notes, 3000) : old.notes || '',
    login: old.login || null,
    createdAt: old.createdAt || now(), updatedAt: now(),
  };
}

/** His events (from the calendar) and the calls from the numbers that belong to him (his people + the clients of his events). */
async function withData(a, { forArtist = false } = {}) {
  const events = (await allJ(K.events)).filter(e => e.artist === a.id).sort((x, y) => (x.date + (x.time || '')).localeCompare(y.date + (y.time || '')));
  const who = new Map();
  for (const c of a.contacts || []) { const d = digits(c.phone); if (d.length >= 7) who.set(d, { name: c.name, role: c.role || 'איש קשר' }); }
  for (const e of events) { const d = digits(e.phone); if (d.length >= 7 && !who.has(d)) who.set(d, { name: e.client || e.title, role: 'לקוח: ' + e.title }); }
  const calls = who.size ? (await allJ(K.calls)).filter(c => who.has(digits(c.phone)))
    .sort((x, y) => String(y.at).localeCompare(String(x.at))).slice(0, 60)
    .map(c => ({ id: c.id, at: c.at, phone: c.phone, who: who.get(digits(c.phone)), url: forArtist ? undefined : c.url,
      summary: c.sum && !c.sum.error ? str(c.sum.summary, 1200) : '' })) : [];
  const ev = forArtist ? events.map(({ createdBy, staff, ...e }) => e) : events;
  return { ...a, events: ev, calls };
}

export default async function artistsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hotelsReady()) return send(res, 503, { error: 'not-configured' });
  const url = new URL(req.url, 'http://x');
  const q = k => url.searchParams.get(k);
  try {
    /* ----- the artist's own link: only his page ----- */
    if (req.method === 'GET' && q('view')) {
      const a = await getJ(K.artists, String(q('view')));
      if (!a || !same(q('t'), artistToken(a.id))) return send(res, 404, { error: 'not-found' });
      const full = await withData(a, { forArtist: true });
      const { contacts, notes, login, ...pub } = full;
      return send(res, 200, { artist: pub });
    }

    /* ----- the artist himself, logged in to the app ----- */
    if (q('me')) {
      if (req.method === 'DELETE') { res.setHeader('Set-Cookie', artistClear); return send(res, 200, { ok: true }); }
      const id = artistSession(req);
      const a = id ? await getJ(K.artists, id) : null;
      if (!a) return send(res, 401, { error: 'login' });
      // owner 22.11: the artist changes his own password (the owner can always set a new one in "פרטים")
      if (req.method === 'POST') {
        let b = {}; try { b = (await readBody(req)) || {}; } catch (e) { return send(res, 400, { error: 'bad-json' }); }
        if (!a.login || !checkPassword(String(b.old || ''), a.login.hash)) return send(res, 403, { error: 'old' });
        const pw = String(b.password || '');
        if (pw.length < 8) return send(res, 400, { error: 'password' });
        a.login = { ...a.login, hash: hashPassword(pw), at: now(), bySelf: true, must: false };
        await setJ(K.artists, a.id, a);
        return send(res, 200, { ok: true });
      }
      const full = await withData(a, { forArtist: true });
      const { contacts, notes, login, ...pub } = full;
      pub.netStats = await netStats(a.id, a.nets || {}).catch(() => ({}));   // his own numbers only
      return send(res, 200, { artist: pub, must: !!a.login?.must });
    }

    const s = req.lbvUser || isAuthed(req);
    if (!s) return send(res, 401, { error: 'login' });
    if (!(await areasOf(s)).includes('events')) return send(res, 403, { error: 'forbidden' });
    const can = { edit: ROLES_EDIT.includes(s.r), del: s.r === 'owner' };
    let body = {};
    if (req.method === 'POST') { try { body = (await readBody(req)) || {}; } catch (e) { return send(res, 400, { error: 'bad-json' }); } }

    if (req.method === 'GET') {
      const list = (await allJ(K.artists)).sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
      const seeNets = (await areasOf(s)).includes('nets');   // owner 22.11: the owner chooses per manager who sees the numbers
      const artists = await Promise.all(list.map(async a => { const { login, ...x } = await withData(a); if (seeNets) x.netStats = await netStats(a.id, a.nets || {}).catch(() => ({})); return { ...x, username: s.r === 'owner' ? login?.username || '' : undefined, link: can.edit ? `/artist/#${a.id}.${artistToken(a.id)}` : '' }; }));
      return send(res, 200, { can, artists });
    }
    if (req.method === 'POST' && body.op === 'artist') {
      if (!can.edit) return send(res, 403, { error: 'forbidden' });
      const old = body.id ? await getJ(K.artists, String(body.id)) : null;
      if (body.id && !old) return send(res, 404, { error: 'not-found' });
      const a = cleanArtist(body, old || {});
      if (!a.name) return send(res, 400, { error: 'missing' });
      await setJ(K.artists, a.id, a);
      const { login, ...out } = a;
      return send(res, 200, { artist: out });
    }
    // owner: the artist's username + password for the app (only the owner gives access)
    if (req.method === 'POST' && body.op === 'access') {
      if (s.r !== 'owner') return send(res, 403, { error: 'forbidden' });
      const a = await getJ(K.artists, String(body.id || ''));
      if (!a) return send(res, 404, { error: 'not-found' });
      if (body.off) { a.login = null; await setJ(K.artists, a.id, a); return send(res, 200, { ok: true }); }
      const name = uname(body.username), pw = String(body.password || '');
      if (name.length < 3) return send(res, 400, { error: 'username' });
      if (pw.length < 8) return send(res, 400, { error: 'password' });
      const owner = await loadOwner().catch(() => ({ username: 'owner' }));
      const taken = name === (owner.username || 'owner') || (await loadUsers().catch(() => [])).some(u => u.username === name) || (await allJ(K.artists)).some(x => x.id !== a.id && x.login?.username === name);
      if (taken) return send(res, 409, { error: 'taken' });
      a.login = { username: name, hash: hashPassword(pw), at: now(), must: true };   // first-time password: he changes it at the first login
      await setJ(K.artists, a.id, a);
      return send(res, 200, { ok: true, username: name });
    }
    if (req.method === 'DELETE') {
      if (!can.del) return send(res, 403, { error: 'forbidden' });
      const id = String(q('id') || '');
      if (!/^a[0-9a-f]{12}$/.test(id)) return send(res, 400, { error: 'bad-id' });
      await kv.hdel(K.artists, id);
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: 'bad-request' });
  } catch (e) {
    console.error('artists', e && e.message);
    return send(res, 500, { error: 'server' });
  }
}
