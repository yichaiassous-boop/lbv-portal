// lbv-wa (owner 25.11): the owner's own WhatsApp, linked once like WhatsApp Web.
//  - Reads only the chats with numbers that have a card in the system (hotels, venues, attractions): our questions
//    and their answers, photos, videos and voice notes go into the card, the robot sums up the facts.
//    Every other chat (family, friends, saved contacts) is never read into the system.
//  - Sends a list slowly: one message at a time, a random wait between them, a daily cap,
//    never on Shabbat (Fri 12:00 – Sat 21:00) or a holiday, and it stops by itself on repeated errors.
//  - Its state (the code to scan, connected or not) is in the store; the owner sees it in the admin ("הוואטסאפ שלי").
// Env: KV_REST_API_URL + KV_REST_API_TOKEN (the portal's store), BLOB_READ_WRITE_TOKEN (the portal's photos),
//      PORTAL_URL (default https://lbv-portal-phi.vercel.app).
//  - On Google Cloud (owner 25.11): not one shekel. BUDGET_SUB is the Pub/Sub subscription of a budget on the project;
//    the moment Google reports any cost, the service stops reading and sending and turns the machine off.
import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage, normalizeMessageContent, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { put } from '@vercel/blob';
import { HebrewCalendar, HDate, flags } from '@hebcal/core';
import { storeReady, cmd, getJ, setJ, allJ, authState, forgetLogin } from './store.js';

const PORTAL = (process.env.PORTAL_URL || 'https://lbv-portal-phi.vercel.app').replace(/\/$/, '');
const K = { state: 'wl:state', cmd: 'wl:cmd', key: 'wl:key', camps: 'wl:camps', day: d => 'wl:day:' + d, keys: 'hs:keys' };
const DAY_CAP = Number(process.env.WA_DAY_CAP || 150);   // messages a day from a list, at most
// 25.11 owner: send only. Reading places' chats (and uploading their photos/videos) stays off unless WA_READ=1.
const READ = process.env.WA_READ === '1';
const GAP = [35, 95];                                     // seconds between two messages of a list (random in between)
const log = pino({ level: process.env.LOG_LEVEL || 'warn' });
const now = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digits = v => String(v || '').replace(/\D/g, '');

/* ---------- Israel time, Shabbat and holidays ---------- */
const il = (d = new Date()) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: Number(p.hour) * 60 + Number(p.minute), wd: p.weekday };
};
const chag = date => (HebrewCalendar.getHolidaysOnDate(new HDate(new Date(date + 'T12:00:00Z')), true) || []).some(e => e.getFlags() & flags.CHAG);
const nextDay = date => new Date(Date.parse(date + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
/** true while nothing may be sent: Fri/erev chag from 12:00, Shabbat/chag until 21:00. */
export function quiet(d = new Date()) {
  const t = il(d);
  if ((t.wd === 'Fri' || chag(nextDay(t.date))) && t.hm >= 12 * 60) return true;
  if ((t.wd === 'Sat' || chag(t.date)) && t.hm < 21 * 60) return true;
  return false;
}

/* ---------- the state the owner sees ---------- */
let state = { state: 'starting', at: now() };
const setState = async s => { if (billingStop && s.state !== 'billing') return; state ={ ...s, at: now() }; await cmd('SET', K.state, JSON.stringify(state)).catch(e => log.error(e.message)); };

/* ---------- talking to the portal (as the owner's robot, with its own key) ---------- */
async function portalKey() {
  let key = await cmd('GET', K.key);
  if (!key) {
    key = crypto.randomBytes(24).toString('base64url');
    await cmd('SET', K.key, key);
  }
  await cmd('HSET', K.keys, crypto.createHash('sha256').update(key).digest('hex'), 'owner');
  return key;
}
let KEY = '';
async function portal(what, body) {
  const r = await fetch(`${PORTAL}/api/hotels?script=${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-lbv-key': KEY }, body: JSON.stringify(body || {}) });
  if (!r.ok) throw new Error(`portal ${what} ${r.status}`);
  return r.json();
}

/* The numbers that have a card (last 9 digits); only these chats are read. */
let known = new Set(), knownAt = 0;
async function refreshKnown(force) {
  if (!force && Date.now() - knownAt < 10 * 60e3) return;
  try { const r = await portal('waknown'); known = new Set((r.phones || []).map(String)); knownAt = Date.now(); }
  catch (e) { log.error('known ' + e.message); }
}
const nine = jidOrPhone => digits(String(jidOrPhone || '').split('@')[0].split(':')[0]).slice(-9);

/* ---------- reading ---------- */
let sock = null;
const outbox = [];     // text messages waiting to go to the portal
async function phoneOf(key) {
  for (const j of [key.remoteJidAlt, key.remoteJid]) if (j && j.endsWith('@s.whatsapp.net')) return j.split('@')[0].split(':')[0];
  if (key.remoteJid?.endsWith('@lid')) {
    try { const pn = await sock.signalRepository.lidMapping.getPNForLID(key.remoteJid); if (pn) return pn.split('@')[0].split(':')[0]; } catch (e) {}
  }
  return '';
}
const textOf = c => c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption || c?.videoMessage?.caption || c?.documentMessage?.caption || '';
const atOf = m => new Date(Number(m.messageTimestamp || 0) * 1000 || Date.now()).toISOString();

async function onMessage(m, old) {
  const jid = m.key?.remoteJid || '';
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
  const phone = await phoneOf(m.key);
  if (!phone || !known.has(nine(phone))) return;   // not a place in the system: never read
  if (old && Date.now() - Date.parse(atOf(m)) > 45 * 864e5) return;   // the history: the last 45 days only
  const c = normalizeMessageContent(m.message);
  if (!c) return;
  const mine = !!m.key.fromMe;
  const from = mine ? 'אנחנו' : (m.pushName || phone);
  const text = textOf(c).trim();
  const media = c.imageMessage ? 'image' : c.videoMessage ? 'video' : c.audioMessage ? 'audio' : '';
  if (text) outbox.push({ phone, from, text, at: atOf(m), mine, link: true });
  if (media && !mine) {
    try {
      const buf = await downloadMediaMessage(m, 'buffer', {}, { logger: log, reuploadRequest: sock.updateMediaMessage });
      const ext = media === 'image' ? 'jpg' : media === 'video' ? 'mp4' : 'ogg';
      const type = media === 'image' ? 'image/jpeg' : media === 'video' ? 'video/mp4' : 'audio/ogg';
      const blob = await put(`hotels/wa-${nine(phone)}-${Date.now()}.${ext}`, buf, { access: 'public', contentType: type, addRandomSuffix: true });
      await portal('wamedia', { phone, kind: media, url: blob.url, at: atOf(m), seconds: c.audioMessage?.seconds || c.videoMessage?.seconds || 0, id: m.key.id });
    } catch (e) { log.error('media ' + e.message); }
  }
}
async function flush() {
  if (!outbox.length) return;
  const items = outbox.splice(0, 100);
  try { await portal('wa', { items }); } catch (e) { log.error('flush ' + e.message); outbox.unshift(...items); }
}

/* ---------- sending a list ---------- */
const toJid = raw => {
  let d = digits(raw);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('0')) d = '972' + d.slice(1);   // an Israeli number written 05x…
  if (d.length === 9 && d.startsWith('5')) d = '972' + d;
  return d.length >= 10 ? d + '@s.whatsapp.net' : '';
};
const fill = (text, it) => String(text).replace(/\{שם\}/g, (it.name || '').trim()).replace(/[ \t]+([,.!?])/g, '$1').replace(/[ \t]{2,}/g, ' ').trim();
let nextSendAt = 0;
/* ---------- Google's budget: any cost → stop everything and turn the machine off ---------- */
let billingStop = false;
const gmeta = p => fetch('http://metadata.google.internal/computeMetadata/v1/' + p, { headers: { 'Metadata-Flavor': 'Google' } }).then(r => (r.ok ? r.text() : ''));
async function budgetCheck() {
  const sub = process.env.BUDGET_SUB;
  if (!sub || billingStop) return;
  const tok = JSON.parse(await gmeta('instance/service-accounts/default/token') || '{}').access_token;
  if (!tok) return;
  const H = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' };
  const r = await fetch(`https://pubsub.googleapis.com/v1/${sub}:pull`, { method: 'POST', headers: H, body: JSON.stringify({ maxMessages: 50 }) });
  if (!r.ok) throw new Error('budget pull ' + r.status);
  const msgs = (await r.json()).receivedMessages || [];
  let cost = 0, cur = '';
  for (const m of msgs) { try { const d = JSON.parse(Buffer.from(m.message.data, 'base64').toString()); cost = Math.max(cost, Number(d.costAmount) || 0); cur = d.currencyCode || cur; } catch (e) {} }
  if (msgs.length) await fetch(`https://pubsub.googleapis.com/v1/${sub}:acknowledge`, { method: 'POST', headers: H, body: JSON.stringify({ ackIds: msgs.map(m => m.ackId) }) });
  if (cost <= 0) return;
  billingStop = true;
  await setState({ state: 'billing', cost, cur });
  try { sock?.end(new Error('billing')); } catch (e) {}
  execFile('sudo', ['/sbin/shutdown', '-h', 'now'], () => {});
}

// owner 26.11: one tick at a time (a slow store call must never let two ticks pick the same person)
let ticking = false;
async function sendTick() {
  if (ticking) return;
  ticking = true;
  try { await sendOne(); } finally { ticking = false; }
}
async function sendOne() {
  if (billingStop || state.state !== 'open' || Date.now() < nextSendAt || quiet()) return;
  const camps = (await allJ(K.camps)).filter(c => c.status === 'run' && Date.parse(c.at || 0) <= Date.now()).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const c = camps[0];
  if (!c) return;
  const today = il().date;
  const sentToday = Number(await cmd('GET', K.day(today))) || 0;
  if (sentToday >= DAY_CAP) { if (c.note !== 'cap') { c.note = 'cap'; await setJ(K.camps, c.id, c); } return; }
  const it = (c.items || []).find(x => x.st === 'wait');
  if (!it) { c.status = 'done'; c.doneAt = now(); delete c.note; await setJ(K.camps, c.id, c); return; }
  // owner 26.11: one message went out ~40 times: it was sent, then saving "sent" failed, so it stayed "waiting" and went again.
  // Now it is saved as "being sent" first (if that fails, nothing is sent), and never sent again by itself.
  it.st = 'sending'; it.at = now();
  await setJ(K.camps, c.id, c);
  nextSendAt = Date.now() + (GAP[0] + Math.random() * (GAP[1] - GAP[0])) * 1000;
  const jid = toJid(it.phone);
  try {
    if (!jid) throw Object.assign(new Error('bad'), { st: 'bad' });
    const [w] = await sock.onWhatsApp(jid.split('@')[0]);
    if (!w?.exists) throw Object.assign(new Error('nowa'), { st: 'nowa' });
    await sock.sendMessage(w.jid || jid, { text: fill(c.text, it) });
    it.st = 'ok'; it.at = now(); c.errs = 0;
  } catch (e) {
    it.st = e.st || 'fail'; it.at = now(); it.err = String(e.message || e).slice(0, 120);
    if (!e.st) c.errs = (c.errs || 0) + 1;
    if (c.errs >= 3) { c.status = 'pause'; c.note = 'errors'; }   // WhatsApp keeps refusing: stop and let the owner look
  }
  if (it.st === 'ok') { try { await cmd('INCR', K.day(today)); await cmd('EXPIRE', K.day(today), 3 * 864e5); } catch (e) {} }
  if (c.note === 'cap') delete c.note;
  c.sent = c.items.filter(x => x.st === 'ok').length;
  c.failed = c.items.filter(x => x.st !== 'ok' && x.st !== 'wait').length;
  if (!c.items.some(x => x.st === 'wait') && c.status === 'run') { c.status = 'done'; c.doneAt = now(); }
  for (let n = 0; n < 5; n++) {   // saving the result: tried again, and even if it fails the item stays "being sent" (never resent)
    try {
      const cur = await getJ(K.camps, c.id);   // the owner may have paused / stopped / deleted it meanwhile
      if (!cur) return;
      if (cur.status !== 'run' && c.status === 'run') c.status = cur.status;
      await setJ(K.camps, c.id, c);
      return;
    } catch (e) { await sleep(3000); }
  }
}

/* ---------- the connection ---------- */
let starting = false;
async function connect() {
  if (starting) return;
  starting = true;
  try {
    const { state: auth, saveCreds } = await authState();
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
    sock = makeWASocket({
      version, logger: log, browser: ['LBV', 'Chrome', '1.0'], markOnlineOnConnect: false, syncFullHistory: false,
      auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, log) },
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async u => {
      if (u.qr) await setState({ state: 'qr', qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }) });
      if (u.connection === 'open') { await setState({ state: 'open', me: digits(sock.user?.id?.split(':')[0]), name: sock.user?.name || '' }); if (READ) refreshKnown(true); }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        sock = null;
        if (code === DisconnectReason.loggedOut) {   // unlinked from the phone: forget it and show a new code
          await forgetLogin();
          await setState({ state: 'off', why: 'loggedOut' });
        } else await setState({ state: 'reconnecting', why: String(code || '') });
        setTimeout(connect, code === DisconnectReason.loggedOut ? 2000 : 5000);
      }
    });
    if (READ) sock.ev.on('messages.upsert', async ({ messages, type }) => {
      await refreshKnown();
      for (const m of messages) await onMessage(m, type !== 'notify').catch(e => log.error('msg ' + e.message));
    });
    if (READ) sock.ev.on('messaging-history.set', async ({ messages }) => {
      await refreshKnown(true);
      for (const m of messages || []) await onMessage(m, true).catch(e => log.error('hist ' + e.message));
    });
  } catch (e) {
    log.error('connect ' + e.message);
    await setState({ state: 'error', why: String(e.message).slice(0, 200) });
    setTimeout(connect, 30000);
  } finally { starting = false; }
}

/* The owner's buttons in the admin: "להתנתק" / "קוד חדש". */
async function commands() {
  const c = await cmd('GETDEL', K.cmd).catch(() => null);
  if (!c) return;
  if (c === 'logout') {
    try { await sock?.logout(); } catch (e) {}
    await forgetLogin(); await setState({ state: 'off', why: 'owner' });
    setTimeout(connect, 2000);
  }
  if (c === 'restart') { try { sock?.end(new Error('restart')); } catch (e) {} }
}

async function main() {
  if (!storeReady()) { console.error('KV_REST_API_URL / KV_REST_API_TOKEN missing'); process.exit(1); }
  KEY = await portalKey();
  await setState({ state: 'starting' });
  if (READ) await refreshKnown(true);
  await connect();
  if (READ) setInterval(() => flush().catch(() => {}), 15000);
  setInterval(() => commands().catch(() => {}), 5000);
  setInterval(() => sendTick().catch(e => log.error('send ' + e.message)), 10000);
  budgetCheck().catch(e => log.error(e.message));
  setInterval(() => budgetCheck().catch(e => log.error(e.message)), 10 * 60e3);
  setInterval(() => cmd('SET', K.state, JSON.stringify({ ...state, beat: now() })).catch(() => {}), 60000);
  // a tiny page for the host's health check
  http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(state.state); }).listen(process.env.PORT || 8080);
}
if (!process.env.WA_NO_MAIN) main();
