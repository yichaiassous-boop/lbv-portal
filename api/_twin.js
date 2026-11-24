// /api/twin (owner 24.11): "הכפיל של אילן" — one key (fal.ai) for every engine. Three kinds of work:
//   edit  — a real clip of Ilan: clothes, background, an object in his hand (Kling O1 Edit, 3–10 s, keeps his voice)
//   scene — a new scene: a photo of Ilan → a new place/outfit/object (Nano Banana Pro) → the owner approves → he moves (Kling 3.0 Pro)
//   talk  — new words: text → Ilan's cloned voice (MiniMax) → the lips of a clip follow it (Sync Lipsync 2 Pro)
// Every paid step starts only on the owner's click (the page asks before each one, with the price).
// Owner only: it costs money and holds his partner's face and voice. Needs FAL_KEY (fal.ai, pay per use). Without it: 'no-key'.
// Redis hash "tw:jobs": job id → job; field "voice" in "tw:voice": Ilan's cloned voice.
import crypto from 'node:crypto';
import { isAuthed, readBody } from './_lib.js';
import { hotelsReady, getJ, setJ, allJ, kv } from './_hotels.js';

const KEY = 'tw:jobs', VKEY = 'tw:voice';
const FAL = 'https://queue.fal.run/';
// fal model ids (checked on fal.ai 24.11)
const M = {
  edit: 'fal-ai/kling-video/o1/video-to-video/edit',    // $0.168/s, 3–10.05 s, prompt + video_url (+ image_urls as @Image1)
  still: 'fal-ai/nano-banana-pro/edit',                  // $0.15 per image
  move: 'fal-ai/kling-video/v3/pro/image-to-video',      // $0.112/s silent, $0.168/s with sound, 3–15 s
  clone: 'fal-ai/minimax/voice-clone',                   // $1.5 once; the voice must be used within 7 days or MiniMax deletes it
  tts: 'fal-ai/minimax/speech-02-hd',                    // $0.1 per 1000 characters, Hebrew in language_boost
  lips: 'fal-ai/sync-lipsync/v2/pro',                    // $5 per minute
};
const LANGS = ['Hebrew', 'French', 'English', 'auto'];
const send = (res, code, obj) => res.status(code).json(obj);
const now = () => new Date().toISOString();
const str = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, max);
const num = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const falKey = () => process.env.FAL_KEY || '';
// only our own files go to fal through our key: our Blob (twin/…), or a result fal itself made (to chain: scene → talk).
// (the local preview server, tools/serve.mjs, keeps files in media/uploads and fakes fal, so it accepts those too)
const src = v => {
  const s = str(v, 800);
  if (/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/twin\/[^\s"'<>]+$/i.test(s)) return s;
  if (/^https:\/\/([a-z0-9-]+\.)*fal\.media\/[^\s"'<>]+$/i.test(s)) return s;
  if (process.env.LBV_LOCAL_DATA && /^media\/uploads\/[\w.\-]+$/.test(s)) return s;
  return '';
};

async function fal(url, body) {
  if (!url.startsWith(FAL)) throw Object.assign(new Error('fal'), { code: 0, detail: 'bad url' });
  const r = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Key ' + falKey(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 202) {
    const d = j.detail ?? j.error ?? j.message ?? '';
    throw Object.assign(new Error('fal'), { code: r.status, detail: str(typeof d === 'string' ? d : JSON.stringify(d), 300) });
  }
  return j;
}
/** Send one step to fal's queue; what we keep of it. */
async function submit(model, input) {
  const j = await fal(FAL + model, input);
  return { model, rid: j.request_id, st: j.status_url, rs: j.response_url, state: 'queued', url: '', why: '', at: now() };
}
const live = s => s && (s.state === 'queued' || s.state === 'processing');
/** Ask fal how a running step is doing; when done, take its result. */
async function refresh(s) {
  if (!live(s)) return s;
  try {
    const q = await fal(s.st);
    if (q.status === 'IN_QUEUE') return { ...s, state: 'queued' };
    if (q.status !== 'COMPLETED') return { ...s, state: 'processing' };
    try {
      const out = await fal(s.rs);
      const url = out.images?.[0]?.url || out.video?.url || out.audio?.url || '';
      if (!url && !out.custom_voice_id) return { ...s, state: 'failed', why: 'no output' };
      return { ...s, state: 'completed', url, voiceId: out.custom_voice_id || undefined, done: now() };
    } catch (e) { return { ...s, state: 'failed', why: e.detail || 'fal ' + (e.code || '') }; }
  } catch (e) { return { ...s, why: 'fal ' + (e.code || '') }; }   // could not ask: stays as it was, next look tries again
}

export default async function twinHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hotelsReady()) return send(res, 503, { error: 'not-configured' });
  const s = req.lbvUser || isAuthed(req);
  if (!s) return send(res, 401, { error: 'login' });
  if (s.r !== 'owner') return send(res, 403, { error: 'forbidden' });
  const ready = !!falKey();
  const q = new URL(req.url, 'http://x').searchParams;
  try {
    if (req.method === 'GET') {
      let voice = await getJ(VKEY, 'voice');
      if (ready && live(voice?.step)) { voice = { ...voice, step: await refresh(voice.step) }; voice.id = voice.step.voiceId || ''; await setJ(VKEY, 'voice', voice); }
      const id = q.get('id');
      if (!id) {
        const list = (await allJ(KEY)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return send(res, 200, { ready, voice, list });
      }
      const job = await getJ(KEY, id);
      if (!job) return send(res, 404, { error: 'not-found' });
      if (ready) {
        for (const k of Object.keys(job.steps || {})) job.steps[k] = await refresh(job.steps[k]);
        // talk: the voice is ready → the lips follow it, by itself (the owner already approved both when he sent it)
        const t = job.steps.tts;
        if (job.kind === 'talk' && t?.state === 'completed' && !job.steps.lips) {
          try { job.steps.lips = await submit(M.lips, { video_url: job.video, audio_url: t.url, sync_mode: 'bounce' }); }
          catch (e) { job.steps.lips = { state: 'failed', why: e.detail || 'fal ' + (e.code || '') }; }
        }
        await setJ(KEY, id, job);
      }
      return send(res, 200, { ready, voice, job });
    }
    let b = {}; try { b = (await readBody(req)) || {}; } catch (e) { return send(res, 400, { error: 'bad-json' }); }
    const id = str(b.id || q.get('id'), 40);
    if (req.method === 'DELETE') {
      if (!/^t[0-9a-f]{12}$/.test(id) || !(await getJ(KEY, id))) return send(res, 404, { error: 'not-found' });
      await kv.hdel(KEY, id);
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    if (!ready) return send(res, 409, { error: 'no-key' });
    const base = { id: 't' + crypto.randomBytes(6).toString('hex'), title: str(b.title, 80), createdAt: now() };

    if (b.step === 'voice') {   // Ilan's voice, once: a clean recording of him talking, 10 s or more
      const audio = src(b.audio);
      if (!audio) return send(res, 400, { error: 'files' });
      const step = await submit(M.clone, { audio_url: audio, model: 'speech-02-hd', noise_reduction: true, need_volume_normalization: true,
        text: 'שלום, כאן אילן מ-La Belle Vie. ככה נשמע הקול שלי. Bonjour, c\'est Ilan de La Belle Vie.' });
      const voice = { step, id: '', audio, createdAt: now() };
      await setJ(VKEY, 'voice', voice);
      return send(res, 200, { ok: true, voice });
    }
    if (b.step === 'edit') {   // a real clip: clothes, background, an object
      const video = src(b.video), ref = b.ref ? src(b.ref) : '', prompt = str(b.prompt, 2500);
      if (!video || (b.ref && !ref)) return send(res, 400, { error: 'files' });
      if (!prompt) return send(res, 400, { error: 'prompt' });
      const secs = num(b.secs, 0, 60);
      if (secs < 3 || secs > 10.05) return send(res, 400, { error: 'length' });
      const step = await submit(M.edit, { prompt: prompt + ' Keep his face, expression, lip movement, gestures and everything else exactly the same. Photorealistic.', video_url: video, keep_audio: true, ...(ref ? { image_urls: [ref] } : {}) });
      const job = { ...base, kind: 'edit', prompt, video, ref, secs, steps: { video: step } };
      await setJ(KEY, job.id, job);
      return send(res, 200, { ok: true, job });
    }
    if (b.step === 'scene') {   // a new scene, part 1: the still, to approve
      const photo = src(b.photo), prompt = str(b.prompt, 2500);
      if (!photo) return send(res, 400, { error: 'files' });
      if (!prompt) return send(res, 400, { error: 'prompt' });
      const step = await submit(M.still, { prompt: 'Use this exact man: the same face, beard, hair, glasses and body, recognisable at once. ' + prompt + ' Photorealistic vertical photo taken with a real camera, natural light, natural skin.', image_urls: [photo], aspect_ratio: '9:16', output_format: 'jpeg', resolution: '2K' });
      const job = { ...base, kind: 'scene', prompt, photo, steps: { still: step } };
      await setJ(KEY, job.id, job);
      return send(res, 200, { ok: true, job });
    }
    if (b.step === 'move') {   // a new scene, part 2: the approved still comes to life
      const job = await getJ(KEY, id);
      if (!job || job.kind !== 'scene') return send(res, 404, { error: 'not-found' });
      if (job.steps.still?.state !== 'completed') return send(res, 409, { error: 'frame-not-ready' });
      if (job.steps.video && job.steps.video.state !== 'failed') return send(res, 409, { error: 'already' });
      const motion = str(b.motion, 2000);
      if (!motion) return send(res, 400, { error: 'prompt' });
      job.secs = Math.round(num(b.secs, 3, 15)); job.motion = motion; job.sound = !!b.sound;
      job.steps.video = await submit(M.move, { start_image_url: job.steps.still.url, prompt: motion + ' Keep his face exactly the same as in the image. Realistic, natural movement, real camera.', duration: String(job.secs), generate_audio: job.sound });
      await setJ(KEY, id, job);
      return send(res, 200, { ok: true, job });
    }
    if (b.step === 'talk') {   // new words in his voice, and the lips follow
      const voice = await getJ(VKEY, 'voice');
      if (!voice?.id) return send(res, 409, { error: 'no-voice' });
      const video = src(b.video), text = str(b.text, 3000), lang = LANGS.includes(b.lang) ? b.lang : 'auto';
      if (!video) return send(res, 400, { error: 'files' });
      if (!text) return send(res, 400, { error: 'text' });
      const step = await submit(M.tts, { text, voice_setting: { voice_id: voice.id, speed: b.speed ? num(b.speed, 0.8, 1.2) : 1 }, language_boost: lang, output_format: 'url' });
      const job = { ...base, kind: 'talk', text, lang, video, secs: num(b.secs, 0, 300), steps: { tts: step } };
      await setJ(KEY, job.id, job);
      return send(res, 200, { ok: true, job });
    }
    return send(res, 400, { error: 'step' });
  } catch (e) {
    if (e.message === 'fal') { console.error('twin fal', e.code, e.detail); return send(res, 502, { error: 'fal', code: e.code || 0, detail: e.detail || '' }); }
    console.error('twin', e && e.message);
    return send(res, 500, { error: 'server' });
  }
}
