// /api/fun (owner 24.11): the attractions catalog for fun days (ימי כיף) — every attraction / activity / supplier we
// work with, saved once: what it is, where, for how many, how much, and how to reach them. Search by area, kind and price.
// Who sees it: everyone with the events area. Adding and editing: the same people. Deleting: owner / admin only.
// Redis hash "fn:all": field = id → the attraction.
import crypto from 'node:crypto';
import { isAuthed, readBody } from './_lib.js';
import { hotelsReady, getJ, setJ, allJ, kv } from './_hotels.js';
import { areasOf } from './_areas.js';

const KEY = 'fn:all';
export const KINDS = ['show', 'workshop', 'sport', 'team', 'food', 'tour', 'kids', 'party', 'other'];
const PER = ['person', 'group', 'hour', 'event'];
const CUR = ['ILS', 'EUR', 'USD'];
const send = (res, code, obj) => res.status(code).json(obj);
const now = () => new Date().toISOString();
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
const num = v => { const s = String(v ?? '').replace(/[,\s₪€$]/g, ''); if (!s) return null; const x = Number(s); return Number.isFinite(x) && x >= 0 && x < 1e9 ? Math.round(x * 100) / 100 : null; };
const pick = (v, ok, d) => (ok.includes(v) ? v : d);
const link = v => { const s = str(v, 400); return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : ''; };

/** A clean attraction from what the form sent (anything unknown is dropped). */
function clean(b, old = {}) {
  return {
    ...old,
    name: str(b.name, 100),
    kind: pick(b.kind, KINDS, 'other'),
    area: str(b.area, 80),
    supplier: str(b.supplier, 100),
    phone: str(b.phone, 30),
    price: num(b.price),
    per: pick(b.per, PER, 'person'),
    currency: pick(b.currency, CUR, 'ILS'),
    minP: num(b.minP), maxP: num(b.maxP),
    hours: str(b.hours, 40),
    place: pick(b.place, ['in', 'out', 'both', ''], ''),
    kids: !!b.kids,
    link: link(b.link),
    notes: str(b.notes, 1500),
  };
}

export default async function funHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hotelsReady()) return send(res, 503, { error: 'not-configured' });
  const s = req.lbvUser || isAuthed(req);
  if (!s) return send(res, 401, { error: 'login' });
  if (!(await areasOf(s)).includes('events')) return send(res, 403, { error: 'forbidden' });
  const boss = s.r === 'owner' || s.r === 'admin';
  try {
    if (req.method === 'GET') {
      const list = (await allJ(KEY)).sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
      return send(res, 200, { list, del: boss });
    }
    let b = {}; try { b = (await readBody(req)) || {}; } catch (e) { return send(res, 400, { error: 'bad-json' }); }
    const id = String(b.id || new URL(req.url, 'http://x').searchParams.get('id') || '');
    if (req.method === 'POST') {
      const old = id ? await getJ(KEY, id) : null;
      if (id && !old) return send(res, 404, { error: 'not-found' });
      const x = clean(b, old || {});
      if (!x.name) return send(res, 400, { error: 'name' });
      if (old) { x.updatedAt = now(); x.updatedBy = s.n || ''; }
      else { x.id = 'f' + crypto.randomBytes(6).toString('hex'); x.createdAt = now(); x.by = s.n || ''; }
      await setJ(KEY, x.id, x);
      return send(res, 200, { ok: true, item: x });
    }
    if (req.method === 'DELETE') {
      if (!boss) return send(res, 403, { error: 'forbidden' });
      if (!/^f[0-9a-f]{12}$/.test(id) || !(await getJ(KEY, id))) return send(res, 404, { error: 'not-found' });
      await kv.hdel(KEY, id);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method' });
  } catch (e) {
    console.error('fun', e && e.message);
    return send(res, 500, { error: 'server' });
  }
}
