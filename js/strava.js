// Reads the per-day Strava calorie rollup a Cloud Function writes to strava/daily/{date}
// (see functions/index.js). This is a single small doc, not a keyed collection of records, so
// it doesn't fit db.js's SHARED_STORES/USER_STORES abstraction — it gets its own tiny reader.
import { fs } from './firebase.js';
import { doc, getDoc } from '../vendor/firebase/firebase-firestore.js';

export async function getStravaDaily(dateStr) {
  const snap = await getDoc(doc(fs, 'stravaDaily', dateStr));
  return snap.exists() ? snap.data() : null;
}
