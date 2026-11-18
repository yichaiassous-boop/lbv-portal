import { isAuthed, storageReady } from './_lib.js';
import { leadsReady } from './_leads.js';
import { areasOf } from './_areas.js';

// Tells the admin page whether it is logged in and whether storage is connected.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const s = isAuthed(req);
  const areas = s ? await areasOf(s) : [];
  res.status(200).json({
    storage: storageReady() ? 'blob' : 'none',
    configured: Boolean(process.env.ADMIN_PASSWORD),
    authed: !!isAuthed(req),
    user: s ? { name: s.n, role: s.r, areas } : null,
    leads: leadsReady(),
  });
}
