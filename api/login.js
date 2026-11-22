import { passwordMatches, checkPassword, sessionCookie, clearCookie, storageReady, readBody } from './_lib.js';
import { leadsReady } from './_leads.js';
import { loadUsers, saveUsers, loadOwner, saveOwner } from './_users.js';
import crypto from 'node:crypto';
import { redis, redisReady } from './_redis.js';
import { areasOf } from './_areas.js';
import { artistLogin, artistCookie, artistClear } from './_artists.js';

// Too many wrong passwords from one place → wait 15 minutes. Only a hash of the address is kept, for 15 minutes.
const TRIES = 8, WINDOW = 15 * 60;
const tryKey = req => 'login:fail:' + crypto.createHash('sha256').update(String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() + '|lbv').digest('hex').slice(0, 24);
async function blocked(req) { if (!redisReady()) return false; try { const [n] = await redis([['GET', tryKey(req)]]); return Number(n) >= TRIES; } catch (e) { return false; } }
async function failed(req) { if (!redisReady()) return; try { await redis([['INCR', tryKey(req)], ['EXPIRE', tryKey(req), WINDOW]]); } catch (e) {} }
async function cleared(req) { if (!redisReady()) return; try { await redis([['DEL', tryKey(req)]]); } catch (e) {} }

// POST { username, password }:
//   the owner's username (default "owner") + the main password → the owner
//   a manager's username + their password                      → that manager (role from the list)
// (An empty username with the main password still works, as a backup for the owner.)
export default async function handler(req, res) {
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', [clearCookie, artistClear]);
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'not-configured' });

  if (await blocked(req)) return res.status(429).json({ error: 'too-many' });
  const { username, password } = await readBody(req).catch(() => ({}));
  const name = String(username || '').trim().toLowerCase();
  let user = null;
  const owner = leadsReady() ? await loadOwner() : { username: 'owner' };
  // The owner: their own password (if they set one in the admin), or the main password as a backup.
  const ownerOk = (owner.hash && checkPassword(password, owner.hash)) || passwordMatches(password);
  if ((!name || name === owner.username) && ownerOk) {
    user = { id: 'owner', n: 'הבעלים', r: 'owner' };
    if (leadsReady()) saveOwner({ ...owner, last: new Date().toISOString() }).catch(() => {});
  } else if (name && leadsReady()) {
    const list = await loadUsers();
    const u = list.find(x => x.username === name);
    if (u && checkPassword(password, u.hash)) {
      user = { id: u.id, n: u.name, r: u.role };
      u.last = new Date().toISOString();
      saveUsers(list).catch(() => {});
    }
  }
  // owner 22.11: an artist we represent logs in on the same page and goes to his own page only
  if (!user && name) {
    const aid = await artistLogin(name, password).catch(() => null);
    if (aid) { await cleared(req); res.setHeader('Set-Cookie', [clearCookie, artistCookie(aid)]); return res.status(200).json({ ok: true, artist: true, go: '/artist/' }); }
  }
  if (!user) {
    await failed(req);
    await new Promise(r => setTimeout(r, 800)); // slow down guessing
    return res.status(401).json({ error: 'wrong-password' });
  }
  await cleared(req);
  res.setHeader('Set-Cookie', [sessionCookie(user), artistClear]);
  return res.status(200).json({ ok: true, storage: storageReady() ? 'blob' : 'none', user: { id: user.id || '', name: user.n, role: user.r, areas: await areasOf(user) } });
}
