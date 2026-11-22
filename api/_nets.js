// /api/nets (owner 22.11): the numbers of the social networks — Instagram, TikTok, YouTube — of La Belle Vie
// and of every artist we represent. Who sees it: the owner chooses per manager (area "nets" in "מנהלים והרשאות");
// an artist sees only his own numbers, on his own page (api/_artists.js).
//   YouTube updates by itself when YOUTUBE_API_KEY is set (public channel numbers, read at most every 6 hours).
//   Instagram and TikTok: the numbers are typed in ("עדכון מספרים") until the accounts are connected.
// Redis hash "nw:stats": field = 'lbv' or the artist's id → { instagram: {...}, tiktok: {...}, youtube: {...} }
import { isAuthed, readBody } from './_lib.js';
import { hotelsReady, getJ, setJ, allJ } from './_hotels.js';
import { areasOf } from './_areas.js';

const KEY = 'nw:stats';
export const LBV_NETS = { instagram: 'la_belle_vie_lbv', tiktok: 'la.belle.vie.event', youtube: 'lbv-la_belle_vie' };
const FIELDS = { instagram: ['followers', 'posts'], tiktok: ['followers', 'likes', 'videos'], youtube: ['subs', 'views', 'videos'] };
const YT_EVERY = 6 * 36e5;
const send = (res, code, obj) => res.status(code).json(obj);
const now = () => new Date().toISOString();
const n = v => { const x = Math.round(Number(String(v ?? '').replace(/[,\s]/g, ''))); return Number.isFinite(x) && x >= 0 && x < 1e12 ? x : null; };

/** YouTube's public numbers for a handle (needs YOUTUBE_API_KEY). Cached in the record. */
async function youtube(rec, handle) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key || !handle) return false;
  const y = rec.youtube || {};
  if (y.auto && y.at && Date.now() - Date.parse(y.at) < YT_EVERY && y.handle === handle) return false;
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&forHandle=${encodeURIComponent('@' + handle)}&key=${encodeURIComponent(key)}`);
    if (!r.ok) return false;
    const st = (await r.json()).items?.[0]?.statistics;
    if (!st) return false;
    rec.youtube = { subs: st.hiddenSubscriberCount ? null : n(st.subscriberCount), views: n(st.viewCount), videos: n(st.videoCount), at: now(), auto: true, handle };
    return true;
  } catch (e) { return false; }
}

/** The numbers of one account (key 'lbv' or an artist id), with YouTube refreshed when it can. */
export async function netStats(key, handles = {}) {
  if (!hotelsReady()) return {};
  const rec = (await getJ(KEY, key)) || {};
  if (await youtube(rec, handles.youtube)) await setJ(KEY, key, rec);
  return rec;
}

export default async function netsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hotelsReady()) return send(res, 503, { error: 'not-configured' });
  const s = req.lbvUser || isAuthed(req);
  if (!s) return send(res, 401, { error: 'login' });
  if (!(await areasOf(s)).includes('nets')) return send(res, 403, { error: 'forbidden' });
  const edit = s.r === 'owner' || s.r === 'admin';
  try {
    if (req.method === 'GET') {
      const artists = (await allJ('ar:all')).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      const accounts = [{ key: 'lbv', name: 'La Belle Vie', color: '#16203A', handles: LBV_NETS }]
        .concat(artists.map(a => ({ key: a.id, name: a.name, color: a.color, handles: a.nets || {} })));
      for (const ac of accounts) ac.stats = await netStats(ac.key, ac.handles);
      return send(res, 200, { accounts, edit, ytAuto: !!process.env.YOUTUBE_API_KEY });
    }
    if (req.method === 'POST') {
      if (!edit) return send(res, 403, { error: 'forbidden' });
      let b = {}; try { b = (await readBody(req)) || {}; } catch (e) { return send(res, 400, { error: 'bad-json' }); }
      const key = String(b.key || '');
      if (key !== 'lbv' && !(/^a[0-9a-f]{12}$/.test(key) && await getJ('ar:all', key))) return send(res, 404, { error: 'not-found' });
      const net = String(b.net || '');
      if (!FIELDS[net]) return send(res, 400, { error: 'net' });
      const rec = (await getJ(KEY, key)) || {};
      const row = { at: now(), by: s.n || '' };
      for (const f of FIELDS[net]) row[f] = n(b[f]);
      rec[net] = row;
      await setJ(KEY, key, rec);
      return send(res, 200, { ok: true, stats: rec });
    }
    return send(res, 405, { error: 'method' });
  } catch (e) {
    console.error('nets', e && e.message);
    return send(res, 500, { error: 'server' });
  }
}
