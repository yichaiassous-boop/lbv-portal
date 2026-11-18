// What each manager sees in the app and the admin. The owner chooses it per manager ("מנהלים והרשאות").
// An area a manager doesn't have is not shown at all, and the server refuses it too.
// Stored in the same Redis as the hotel survey: hash "app:areas", field = the manager's id, value = ["events", …].
// A manager with nothing saved gets the defaults of their role (what they had before this existed).
import { hotelsReady, getJ, setJ } from './_hotels.js';

export const AREAS = ['events', 'hotels', 'remote', 'simha', 'gala', 'booking', 'site', 'leads'];
/** Areas that also need the role to allow them (site = content of the site, leads = inquiries and mail). */
const NEED = { site: ['owner', 'admin', 'editor'], leads: ['owner', 'admin', 'sales'] };
const DEFAULT = { admin: AREAS, editor: ['events', 'hotels', 'site'], sales: ['events', 'hotels', 'leads'] };
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
