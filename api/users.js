import crypto from 'node:crypto';
import { isAuthed, can, ROLES, hashPassword, readBody } from './_lib.js';
import { leadsReady } from './_leads.js';
import { loadUsers, saveUsers, publicUser, loadOwner, saveOwner } from './_users.js';
import { AREAS, areasOf, setAreas, roleCan } from './_areas.js';

// Managers, for the owner only.
// GET    → the list (without passwords)
// POST   { name, username, password, role }  → add
// PATCH  ?id=  { name?, role?, password?, areas? } → change (areas: what the manager sees, see _areas.js)
// DELETE ?id=                                  → remove
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = isAuthed(req);
  if (!s) return res.status(401).json({ error: 'login' });
  if (!can(s, 'users')) return res.status(403).json({ error: 'forbidden' });
  if (!leadsReady()) return res.status(503).json({ error: 'not-configured' });

  const list = await loadUsers();
  const owner = await loadOwner();
  if (req.method === 'GET') {
    const users = await Promise.all(list.map(async u => ({ ...publicUser(u), areas: await areasOf({ id: u.id, r: u.role }), may: AREAS.filter(a => roleCan(u.role, a)) })));
    return res.status(200).json({ owner: { username: owner.username, email: owner.email || '', last: owner.last || '' }, users, areas: AREAS });
  }

  let b = {};
  if (req.method !== 'DELETE') { try { b = await readBody(req); } catch (e) { return res.status(400).json({ error: 'bad-json' }); } }
  const role = ROLES.includes(b.role) && b.role !== 'owner' ? b.role : null;
  const username = String(b.username || '').trim().toLowerCase();
  const name = String(b.name || '').trim().slice(0, 60);
  const pw = String(b.password || '');
  // The e-mail of this person's account in Simha / Gala / the holiday booking (the one-tap entry from the app, see config.js)
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase().slice(0, 254) : null;
  if (email && !/^[^\s@<>"']{1,64}@[^\s@<>"']{1,190}\.[a-z]{2,}$/i.test(email)) return res.status(400).json({ error: 'email' });

  if (req.method === 'POST') {
    if (!name || !/^[a-z0-9._-]{3,30}$/.test(username) || pw.length < 8 || !role) return res.status(400).json({ error: 'invalid' });
    if (list.some(u => u.username === username) || username === owner.username) return res.status(409).json({ error: 'taken' });
    list.push({ id: crypto.randomUUID(), name, username, role, hash: hashPassword(pw), must: true, at: new Date().toISOString() });   // owner 22.11: first-time password, changed at the first login
    await saveUsers(list);
    return res.status(200).json({ ok: true });
  }

  const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
  // The owner's own username.
  if (id === 'owner' && req.method === 'PATCH') {
    // owner 25.11: a new password for the owner, from the logged-in owner (he did not remember the old one).
    // The main password from the hosting settings keeps working as a backup.
    if (pw && !username) {
      if (s.r !== 'owner') return res.status(403).json({ error: 'forbidden' });
      if (pw.length < 8) return res.status(400).json({ error: 'short' });
      await saveOwner({ ...owner, hash: hashPassword(pw), changed: new Date().toISOString() });
      return res.status(200).json({ ok: true });
    }
    if (email !== null && !username) { await saveOwner({ ...owner, email }); return res.status(200).json({ ok: true }); }
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: 'invalid' });
    if (list.some(u => u.username === username)) return res.status(409).json({ error: 'taken' });
    await saveOwner({ ...owner, username });
    return res.status(200).json({ ok: true });
  }
  const u = list.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: 'not-found' });

  if (req.method === 'PATCH') {
    if (name) u.name = name;
    if (role) u.role = role;
    if (pw) { if (pw.length < 8) return res.status(400).json({ error: 'short' }); u.hash = hashPassword(pw); u.must = true; }
    if (Array.isArray(b.areas)) { try { await setAreas(u.id, u.role, b.areas); } catch (e) { return res.status(503).json({ error: 'not-configured' }); } }
    if (email !== null) u.email = email;
    if (name || role || pw || email !== null) await saveUsers(list);
    return res.status(200).json({ ok: true, areas: await areasOf({ id: u.id, r: u.role }) });
  }
  if (req.method === 'DELETE') {
    await saveUsers(list.filter(x => x !== u));
    return res.status(200).json({ ok: true });
  }
  return res.status(405).json({ error: 'method' });
}
