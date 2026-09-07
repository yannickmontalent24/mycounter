// Polling replacement for a webhook: Cloud Functions need Firebase's paid Blaze plan, but
// Firestore itself doesn't, so this script (run on a schedule by .github/workflows/strava-sync.yml,
// no billing required) pulls recent Strava activities and writes the same stravaDaily/{date}
// docs a webhook handler would have. It also does the one-time OAuth bootstrap.
//
// Env vars required every run: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, and credentials for the
// Firebase Admin SDK — either GOOGLE_APPLICATION_CREDENTIALS (a file path, for local runs) or
// FIREBASE_SERVICE_ACCOUNT (the key file's JSON as a string, for the GitHub Actions secret).
// STRAVA_INIT_CODE is only needed once, the very first local run, to seed strava/tokens.

import admin from 'firebase-admin';

const {
  STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_INIT_CODE, FIREBASE_SERVICE_ACCOUNT,
} = process.env;

if (!STRAVA_CLIENT_ID || !STRAVA_CLIENT_SECRET) {
  throw new Error('Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.');
}

admin.initializeApp({
  credential: FIREBASE_SERVICE_ACCOUNT
    ? admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT))
    : admin.credential.applicationDefault(), // reads GOOGLE_APPLICATION_CREDENTIALS
});
const db = admin.firestore();
const tokensRef = db.doc('strava/tokens');

async function stravaTokenRequest(body) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: STRAVA_CLIENT_ID, client_secret: STRAVA_CLIENT_SECRET, ...body }),
  });
  if (!res.ok) throw new Error(`Strava token request failed: ${await res.text()}`);
  return res.json();
}

async function saveTokens(tokenResponse, athleteId) {
  await tokensRef.set({
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token,
    expiresAt: tokenResponse.expires_at,
    athleteId,
  });
  return tokenResponse.access_token;
}

async function getAccessToken() {
  const snap = await tokensRef.get();
  if (!snap.exists) {
    if (!STRAVA_INIT_CODE) {
      throw new Error('No Strava tokens stored yet — run this once locally with STRAVA_INIT_CODE set (see README).');
    }
    const body = await stravaTokenRequest({ code: STRAVA_INIT_CODE, grant_type: 'authorization_code' });
    return saveTokens(body, body.athlete?.id ?? null);
  }
  const tokens = snap.data();
  if (tokens.expiresAt > Math.floor(Date.now() / 1000) + 60) return tokens.accessToken;
  // Strava rotates the refresh token on every use, so the new one always gets persisted back.
  const body = await stravaTokenRequest({ refresh_token: tokens.refreshToken, grant_type: 'refresh_token' });
  return saveTokens(body, tokens.athleteId);
}

async function syncActivities(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}` };

  // A few days back, not just "today" — catches anything a missed/failed run would otherwise
  // drop, since each date below is fully recomputed rather than incrementally appended to.
  const after = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
  const listRes = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=50`, { headers });
  if (!listRes.ok) throw new Error(`Strava activity list failed: ${await listRes.text()}`);
  const summaries = await listRes.json();

  const byDate = new Map();
  for (const summary of summaries) {
    // The summary listing doesn't reliably include `calories` — only the detailed representation does.
    const detailRes = await fetch(`https://www.strava.com/api/v3/activities/${summary.id}`, { headers });
    if (!detailRes.ok) { console.error(`Skipping activity ${summary.id}: ${await detailRes.text()}`); continue; }
    const a = await detailRes.json();
    const date = String(a.start_date_local).slice(0, 10);
    const entry = { id: a.id, name: a.name, type: a.type, kcal: Math.round(a.calories ?? 0), movingTimeS: a.moving_time };
    (byDate.get(date) ?? byDate.set(date, []).get(date)).push(entry);
  }

  for (const [date, activities] of byDate) {
    const kcal = activities.reduce((sum, e) => sum + e.kcal, 0);
    await db.doc(`stravaDaily/${date}`).set({ date, kcal, activities });
    console.log(`stravaDaily/${date}: ${kcal} kcal from ${activities.length} activit${activities.length === 1 ? 'y' : 'ies'}`);
  }
  if (byDate.size === 0) console.log('No activities in the lookback window.');
}

await syncActivities(await getAccessToken());
