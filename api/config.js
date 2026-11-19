import crypto from 'node:crypto';
import { isAuthed, storageReady } from './_lib.js';
import { leadsReady } from './_leads.js';
import { areasOf } from './_areas.js';
import { loadUsers, loadOwner } from './_users.js';

// The other LBV systems. The app opens them through ?sso=<id>, so a person enters without their login page
// once the system accepts the pass (see docs/sso-for-yonathan.md). Until then: their normal page.
const SYSTEMS = {
  simha: 'https://allset.lbv-event.com',
  gala: 'https://impact.lbv-event.com',
  booking: 'https://booking.lbv-event.com',
};
const HOME = { simha: '/admin', gala: '/', booking: '/admin' };
const b64 = x => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

/** HS256 JWT, 60 seconds, one use (jti), for one system only (aud). */
function pass(aud, who, secret) {
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ iss: 'lbv-portal', aud, sub: who.id, email: who.email, name: who.name, iat: now, exp: now + 60, jti: crypto.randomUUID() });
  return body + '.' + crypto.createHmac('sha256', secret).update(body).digest('base64url');
}

// Tells the admin page whether it is logged in and whether storage is connected.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = isAuthed(req);
  const areas = s ? await areasOf(s) : [];
  const sso = new URL(req.url, 'http://x').searchParams.get('sso');
  if (sso) {
    const base = SYSTEMS[sso];
    if (!base) return res.status(404).json({ error: 'not-found' });
    if (!s) return res.writeHead(302, { Location: '/admin/' }).end();
    if (!areas.includes(sso)) return res.status(403).json({ error: 'forbidden' });
    const secret = process.env.LBV_SSO_SECRET || '';
    let email = '';
    try { email = s.r === 'owner' ? (await loadOwner()).email || '' : ((await loadUsers()).find(u => u.id === s.id) || {}).email || ''; } catch (e) {}
    const to = secret.length >= 32 && email ? base + '/api/lbv-sso?t=' + pass(sso, { id: s.id || 'owner', email, name: s.n }, secret) : base + HOME[sso];
    return res.writeHead(302, { Location: to }).end();
  }
  res.status(200).json({
    storage: storageReady() ? 'blob' : 'none',
    configured: Boolean(process.env.ADMIN_PASSWORD),
    authed: !!s,
    user: s ? { id: s.id || '', name: s.n, role: s.r, areas } : null,
    leads: leadsReady(),
  });
}
