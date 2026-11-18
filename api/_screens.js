// The screens remote, inside the LBV app. It reads and writes the same Redis keys as the lbv-screens
// project ("screens:…", same Upstash store, connected to both projects), so the app needs no link and
// no remote key: the manager's own login decides (owner / admin only, checked in _events.js).
//
// The projector page itself still lives on lbv-screens.vercel.app. To open it, the app asks for a
// one-time ticket (10 minutes, used once): lbv-screens/api/open.ts swaps it for the projector page.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redis, redisReady } from './_redis.js';

export const SCREENS_HOST = 'https://lbv-screens.vercel.app';
const STEPS = ['WELCOME', 'FLAME', 'FULL', 'THANKS'];
const DEFAULTS = { link: null, step: 'WELCOME', epoch: 1, prices: { plaques: 2600, noms: 520, mots: 0, lettres: 0 }, updatedAt: new Date(0).toISOString() };

/* ---------- raw keys (Redis, or the local JSON file of the preview server) ---------- */
const LOCAL = () => process.env.LBV_LOCAL_DATA || '';
function localDb() { try { return JSON.parse(fs.readFileSync(LOCAL(), 'utf8')); } catch (e) { return {}; } }
function localPut(db) { fs.mkdirSync(path.dirname(LOCAL()), { recursive: true }); fs.writeFileSync(LOCAL(), JSON.stringify(db)); }
export const screensReady = () => Boolean(LOCAL() || redisReady());
async function get(key) {
  if (LOCAL()) return localDb()['raw:' + key] ?? null;
  const [r] = await redis([['GET', key]]);
  return typeof r === 'string' ? r : null;
}
async function set(key, value, ttl) {
  if (LOCAL()) { const db = localDb(); db['raw:' + key] = value; return localPut(db); }
  await redis([ttl ? ['SET', key, value, 'EX', ttl] : ['SET', key, value]]);
}
const json = async (key, fb) => { const v = await get(key); if (v == null) return fb; try { return JSON.parse(v); } catch (e) { return fb; } };

async function settings() {
  const v = await json('screens:settings', {});
  return { ...DEFAULTS, ...v, prices: { ...DEFAULTS.prices, ...(v.prices || {}) } };
}

/** The evening link from Yonathan's gala admin: https://…/live-screen#s=<session>&k=<token>. */
function parseLink(link) {
  if (!link) return null;
  try {
    const u = new URL(String(link).trim());
    if (u.protocol !== 'https:') return null;
    const p = new URLSearchParams(u.hash.replace(/^#/, ''));
    const s = (p.get('s') || '').trim(), k = (p.get('k') || '').trim();
    return s && k ? { origin: u.origin, s, k } : null;
  } catch (e) { return null; }
}

/** Donations so far, read-only, exactly like the projector reads them. */
async function gala(link) {
  const l = parseLink(link);
  if (!l) return { ok: false, error: 'NO_LINK' };
  try {
    const r = await fetch(`${l.origin}/api/gala-night/screen/${encodeURIComponent(l.s)}`, {
      headers: { 'x-gala-screen-token': l.k }, cache: 'no-store', signal: AbortSignal.timeout(6000),
    });
    if (r.status === 404) return { ok: false, error: 'LINK_REFUSED' };
    if (!r.ok) return { ok: false, error: 'GALA_' + r.status };
    const g = await r.json();
    return { ok: true, raised: g?.fundraising?.raised, goal: g?.fundraising?.goal, currency: g?.fundraising?.currency, lastDonor: g?.current?.displayName ?? null, status: g?.session?.status };
  } catch (e) { return { ok: false, error: 'OFFLINE' }; }
}

/** Everything the remote screen shows. The evening link is sent only as "set / not set" plus its host. */
export async function screensState() {
  const [s, player] = await Promise.all([settings(), json('screens:video-player', null)]);
  const l = parseLink(s.link);
  return {
    step: s.step, epoch: s.epoch, prices: s.prices, updatedAt: s.updatedAt,
    link: { set: !!l, host: l ? new URL(l.origin).host : '' },
    gala: await gala(s.link),
    video: { live: !!player && Date.now() - (player.at || 0) < 15000, playing: !!player?.playing },
    now: Date.now(),
  };
}

const price = v => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 10_000_000 ? Math.round(n * 100) / 100 : null; };

/** { step } | { link } | { prices } | { newEvening: true } → the same checks as lbv-screens/api/admin.ts. */
export async function screensChange(b) {
  const s = await settings();
  if (typeof b.step === 'string') { if (!STEPS.includes(b.step)) return { error: 'bad-step' }; s.step = b.step; }
  if ('link' in b) {
    const link = typeof b.link === 'string' ? b.link.trim().slice(0, 600) : '';
    if (link && !parseLink(link)) return { error: 'bad-link' };
    s.link = link || null;
  }
  if (b.prices && typeof b.prices === 'object') {
    for (const k of ['plaques', 'noms', 'mots', 'lettres']) if (k in b.prices) { const v = price(b.prices[k]); if (v === null) return { error: 'bad-price' }; s.prices[k] = v; }
  }
  if (b.newEvening === true) { s.epoch += 1; s.step = 'WELCOME'; }
  s.updatedAt = new Date().toISOString();
  await set('screens:settings', JSON.stringify(s));
  return { ok: true };
}

/** A one-time ticket to open a page of lbv-screens: "screen" = the evening on the projector,
 *  "video" = the video player on the projector, "videoremote" = the video show-control remote. */
export async function openTicket(what) {
  if (!['screen', 'video', 'videoremote'].includes(what)) return { error: 'bad-page' };
  const t = crypto.randomBytes(16).toString('hex');
  await set('screens:open:' + t, what, 600);
  return { ok: true, url: `${SCREENS_HOST}/api/open?t=${t}` };
}
