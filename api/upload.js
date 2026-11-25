import { handleUpload } from '@vercel/blob/client';
import { isAuthed, can, storageReady, readBody } from './_lib.js';
import { hasArea } from './_areas.js';

// Photos and videos go straight from the admin's browser to Blob storage; this route only
// hands out a short-lived upload token to a logged-in admin (so large videos never pass
// through the serverless function size limit).
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!storageReady()) return res.status(503).json({ error: 'not-configured' });
  try {
    const body = await readBody(req);
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async pathname => {
        const s = isAuthed(req);
        // hotel photos (owner 19.11): anyone who works on hotels, images only, 25 MB
        if (String(pathname || '').startsWith('hotels/') && s && await hasArea(s, 'hotels')) {
          // owner 25.11: a place's video too (from WhatsApp / the phone), up to 100 MB
          return { allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'video/mp4', 'video/quicktime'], maximumSizeInBytes: 100 * 1024 * 1024, addRandomSuffix: true };
        }
        // the twin (owner 24.11, api/_twin.js): Ilan's clips, photos, a reference image and his voice sample, owner only
        if (String(pathname || '').startsWith('twin/')) {
          if (!s || s.r !== 'owner') throw new Error('login');
          return { allowedContentTypes: ['video/mp4', 'video/quicktime', 'image/jpeg', 'image/png', 'image/webp', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/ogg'], maximumSizeInBytes: 200 * 1024 * 1024, addRandomSuffix: true };
        }
        if (!can(s, 'content')) throw new Error('login');
        return {
          allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime'],
          maximumSizeInBytes: 300 * 1024 * 1024,
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {},
    });
    return res.status(200).json(json);
  } catch (e) {
    return res.status(e.message === 'login' ? 401 : 400).json({ error: e.message });
  }
}
