// What each manager sees in the app and the admin. The owner chooses it per manager ("מנהלים והרשאות").
// An area a manager doesn't have is not shown at all, and the server refuses it too.
// Stored in the same Redis as the hotel survey: hash "app:areas", field = the manager's id, value = ["events", …].
// A manager with nothing saved gets the defaults of their role (what they had before this existed).
import { hotelsReady, getJ, setJ } from './_hotels.js';

export const AREAS = ['events', 'hotels', 'remote', 'simha', 'gala', 'booking', 'site', 'leads', 'nets', 'intake', 'offers', 'dayfile', 'wasend'];
// owner 25.11: the client tools (form, quote from our catalog, event-day file + payments, WhatsApp scheduling).
// Nobody has them by default: the owner gives each one by hand (for now only the owner and מעיין).
export const TOOLS = ['intake', 'offers', 'dayfile', 'wasend'];   // nets = the social networks' numbers (owner 22.11)
/** Areas that also need the role to allow them (site = content of the site, leads = inquiries and mail). */
const NEED = { site: ['owner', 'admin', 'editor'], leads: ['owner', 'admin', 'sales'] };
const DEFAULT = { admin: AREAS.filter(a => a !== 'nets' && !TOOLS.includes(a)), editor: ['events', 'hotels', 'site'], sales: ['events', 'hotels', 'leads'] };
const KEY = 'app:areas';

export const roleCan = (role, a) => AREAS.includes(a) && (!NEED[a] || NEED[a].includes(role));
const clean = (role, list) => AREAS.filter(a => list.includes(a) && roleCan(role, a));

/** The areas of a logged-in manager (s = the session: { id, r }). */
export async function areasOf(s) {
  if (!s) return [];
  if (s.r === 'owner') return AREAS.slice();
  let saved = null;
  if (hotelsReady()) { try { saved = await getJ(KEY, String(s.id), null); } catch (e) { saved = null; } }
  return clean(s.r, Array.isArray(saved) ? saved : DEFAULT[s.r] || []);
}
export const hasArea = async (s, a) => (await areasOf(s)).includes(a);

/** The owner sets a manager's areas. */
export async function setAreas(id, role, list) {
  if (!hotelsReady()) throw new Error('not-configured');
  const v = clean(role, Array.isArray(list) ? list.map(String) : []);
  await setJ(KEY, String(id), v);
  return v;
}
