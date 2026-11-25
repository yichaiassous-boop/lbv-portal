// /api/walink (owner 25.11): "הוואטסאפ שלי" — the owner's own WhatsApp, linked once like WhatsApp Web (the lbv-wa service).
// Owner only: nobody else sees that the link exists, its code, or the lists he sends.
// GET → the link's state (the code to scan while not linked) + the lists
// POST { op: 'logout' | 'restart' }                        → a command to the service
// POST { op: 'camp', title, text, at, list: [{phone, name}] } → a new list to send (slowly, by the service)
// POST { op: 'pause' | 'resume' | 'stop' | 'del', id }      → a list
import crypto from 'node:crypto';
import { isAuthed, readBody } from './_lib.js';
import { redis, redisReady } from './_redis.js';

const K = { state: 'wl:state', cmd: 'wl:cmd', camps: 'wl:camps', day: d => 'wl:day:' + d };
const send = (res, code, obj) => res.status(code).json(obj);
const now = () => new Date().toISOString();
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
const ilDate = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' })).toISOString().slice(0, 10);
const CAP = 150;   // the service's daily cap (lbv-wa WA_DAY_CAP), shown to the owner

/** A list as the admin shows it: counts + the people (phone, name, state). */
const brief = c => ({ id: c.id, title: c.title, text: c.text, at: c.at, made: c.made, status: c.status, note: c.note || '', doneAt: c.doneAt || '',
  total: (c.items || []).length, sent: (c.items || []).filter(x => x.st === 'ok').length,
  failed: (c.items || []).filter(x => !['ok', 'wait'].includes(x.st)).length,
  items: (c.items || []).map(x => ({ phone: x.phone, name: x.name, st: x.st, at: x.at || '' })) });

export default async function walinkHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = isAuthed(req);
  if (!s) return send(res, 401, { error: 'login' });
  if (s.r !== 'owner') return send(res, 403, { error: 'forbidden' });
  if (!redisReady()) return send(res, 503, { error: 'not-configured' });

  if (req.method === 'GET') {
    const [st, raw, today] = await redis([['GET', K.state], ['HGETALL', K.camps], ['GET', K.day(ilDate())]]);
    let state = null;
    try { state = st ? JSON.parse(st) : null; } catch (e) {}
    // the service writes a heartbeat every minute: none for 3 minutes → it is not running
    if (state && state.state !== 'billing' && Date.now() -Date.parse(state.beat || state.at || 0) > 3 * 60e3) state = { ...state, state: 'down' };
    const camps = [];
    if (Array.isArray(raw)) for (let i = 0; i < raw.length; i += 2) { try { camps.push(brief(JSON.parse(raw[i + 1]))); } catch (e) {} }
    camps.sort((a, b) => String(b.made || '').localeCompare(String(a.made || '')));
    return send(res, 200, { state: state || { state: 'none' }, camps, today: Number(today) || 0, cap: CAP });
  }

  let b = {};
  try { b = await readBody(req); } catch (e) { return send(res, 400, { error: 'bad-json' }); }
  const op = str(b.op, 20);

  if (op === 'logout' || op === 'restart') {
    await redis([['SET', K.cmd, op, 'EX', 600]]);
    return send(res, 200, { ok: true });
  }

  if (op === 'camp') {
    const text = str(b.text, 3000).replace(/\r/g, '');
    const seen = new Set();
    const items = (Array.isArray(b.list) ? b.list : []).map(x => ({ phone: str(x?.phone, 30), name: str(x?.name, 60) }))
      .filter(x => { const d = x.phone.replace(/\D/g, ''); if (d.length < 9 || seen.has(d.slice(-9))) return false; seen.add(d.slice(-9)); return true; })
      .slice(0, 2000).map(x => ({ ...x, st: 'wait' }));
    if (!text) return send(res, 400, { error: 'text' });
    if (!items.length) return send(res, 400, { error: 'list' });
    const at = Date.parse(b.at) ? new Date(Date.parse(b.at)).toISOString() : now();
    const c = { id: 'c' + crypto.randomBytes(6).toString('hex'), title: str(b.title, 80) || 'רשימה', text, at, made: now(), by: s.n || 'הבעלים', status: 'run', items };
    await redis([['HSET', K.camps, c.id, JSON.stringify(c)]]);
    return send(res, 200, { ok: true, camp: brief(c) });
  }

  if (['pause', 'resume', 'stop', 'del'].includes(op)) {
    const id = str(b.id, 40);
    const [raw] = await redis([['HGET', K.camps, id]]);
    if (!raw) return send(res, 404, { error: 'not-found' });
    if (op === 'del') { await redis([['HDEL', K.camps, id]]); return send(res, 200, { ok: true }); }
    const c = JSON.parse(raw);
    if (op === 'pause' && c.status === 'run') c.status = 'pause';
    if (op === 'resume' && c.status === 'pause') { c.status = 'run'; c.errs = 0; delete c.note; }
    if (op === 'stop' && ['run', 'pause'].includes(c.status)) { c.status = 'stop'; c.doneAt = now(); }
    await redis([['HSET', K.camps, id, JSON.stringify(c)]]);
    return send(res, 200, { ok: true, camp: brief(c) });
  }
  return send(res, 400, { error: 'op' });
}
