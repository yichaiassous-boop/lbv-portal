// The shared store (the same Upstash Redis as the portal), over its REST API.
// The WhatsApp login is kept here too, so the service can move to another server without scanning again.
import { proto, initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

const url = () => (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const token = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
export const storeReady = () => Boolean(url() && token());

/** Several commands in one request: [["HGET","h","f"], …] → their results. */
export async function redis(commands) {
  // owner 26.11: the connection to the store dropped for a moment now and then ("fetch failed"): try again before giving up
  let r;
  for (let n = 0; ; n++) {
    try {
      r = await fetch(url() + '/pipeline', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commands),
      });
      break;
    } catch (e) { if (n >= 3) throw e; await new Promise(ok => setTimeout(ok, 1500 * (n + 1))); }
  }
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).map(x => { if (x.error) throw new Error('redis ' + x.error); return x.result; });
}
export const cmd = async (...c) => (await redis([c]))[0];
export const getJ = async (h, f) => { const v = await cmd('HGET', h, f); return v ? JSON.parse(v) : null; };
export const setJ = (h, f, v) => cmd('HSET', h, f, JSON.stringify(v));
export const allJ = async h => { const a = (await cmd('HGETALL', h)) || []; const out = []; for (let i = 0; i < a.length; i += 2) { try { out.push(JSON.parse(a[i + 1])); } catch (e) {} } return out; };

/** The WhatsApp login (like useMultiFileAuthState, but in the store: hash "wl:auth"). */
const AUTH = 'wl:auth';
export async function authState() {
  const read = async f => { const v = await cmd('HGET', AUTH, f); return v ? JSON.parse(v, BufferJSON.reviver) : null; };
  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          if (!ids.length) return out;
          const vals = await redis(ids.map(id => ['HGET', AUTH, `${type}-${id}`]));
          ids.forEach((id, i) => {
            let v = vals[i] ? JSON.parse(vals[i], BufferJSON.reviver) : null;
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          });
          return out;
        },
        set: async data => {
          const c = [];
          for (const type in data) for (const id in data[type]) {
            const v = data[type][id];
            c.push(v ? ['HSET', AUTH, `${type}-${id}`, JSON.stringify(v, BufferJSON.replacer)] : ['HDEL', AUTH, `${type}-${id}`]);
          }
          for (let i = 0; i < c.length; i += 200) await redis(c.slice(i, i + 200));
        },
      },
    },
    saveCreds: () => cmd('HSET', AUTH, 'creds', JSON.stringify(creds, BufferJSON.replacer)),
  };
}
export const forgetLogin = () => cmd('DEL', AUTH);
