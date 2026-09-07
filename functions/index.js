// Cloud Functions for the Strava integration: turn a webhook push into today's exercise-kcal
// rollup at strava/daily/{date}, which the frontend (js/strava.js) reads to bump the kcal
// budget on the Today screen. See the repo's plan doc / README for the one-time setup this
// depends on (Strava app registration, secrets, deploying, subscribing to the webhook).
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const STRAVA_CLIENT_ID = defineSecret('STRAVA_CLIENT_ID');
const STRAVA_CLIENT_SECRET = defineSecret('STRAVA_CLIENT_SECRET');
const STRAVA_WEBHOOK_VERIFY_TOKEN = defineSecret('STRAVA_WEBHOOK_VERIFY_TOKEN');

// Strava needs this exact, stable URL both to redirect back to and in the app's dashboard
// (Authorization Callback Domain). It isn't known until after the first deploy — replace this
// placeholder with the printed stravaAuthCallback URL, then redeploy.
const REDIRECT_URI = 'https://REPLACE-ME-AFTER-FIRST-DEPLOY.cloudfunctions.net/stravaAuthCallback';

const tokensDoc = () => db.doc('strava/tokens');
// A flat top-level collection, not nested under strava/ — Firestore doc paths must alternate
// collection/document, so strava/daily/{date} would be an invalid (odd-segment) reference.
const dailyDoc = date => db.doc(`stravaDaily/${date}`);

exports.stravaAuthStart = onRequest({ secrets: [STRAVA_CLIENT_ID] }, (req, res) => {
  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id', STRAVA_CLIENT_ID.value());
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('approval_prompt', 'auto');
  url.searchParams.set('scope', 'activity:read_all');
  res.redirect(url.toString());
});

exports.stravaAuthCallback = onRequest(
  { secrets: [STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET] },
  async (req, res) => {
    const code = req.query.code;
    if (!code) { res.status(400).send('Missing ?code from Strava.'); return; }

    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: STRAVA_CLIENT_ID.value(),
        client_secret: STRAVA_CLIENT_SECRET.value(),
        code,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      logger.error('Strava token exchange failed', await tokenRes.text());
      res.status(502).send('Could not exchange the code with Strava.');
      return;
    }
    const body = await tokenRes.json();
    await tokensDoc().set({
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_at,
      athleteId: body.athlete?.id ?? null,
    });
    res.status(200).send('Strava connected — you can close this tab.');
  },
);

// Strava rotates the refresh token on every use, so the new one always gets persisted back.
async function getFreshAccessToken() {
  const snap = await tokensDoc().get();
  if (!snap.exists) throw new Error('No Strava tokens stored yet — visit stravaAuthStart first.');
  const tokens = snap.data();
  if (tokens.expiresAt > Math.floor(Date.now() / 1000)) return tokens.accessToken;

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: STRAVA_CLIENT_ID.value(),
      client_secret: STRAVA_CLIENT_SECRET.value(),
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Strava token refresh failed: ${await res.text()}`);
  const body = await res.json();
  await tokensDoc().set({
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: body.expires_at,
    athleteId: tokens.athleteId,
  });
  return body.access_token;
}

exports.stravaWebhook = onRequest(
  { secrets: [STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_WEBHOOK_VERIFY_TOKEN] },
  async (req, res) => {
    if (req.method === 'GET') {
      if (req.query['hub.verify_token'] === STRAVA_WEBHOOK_VERIFY_TOKEN.value()) {
        res.status(200).json({ 'hub.challenge': req.query['hub.challenge'] });
      } else {
        res.sendStatus(403);
      }
      return;
    }

    // Strava requires a fast ack and retries deliveries that don't get one, so respond
    // immediately and keep processing after — the function stays alive until this handler
    // actually returns, so the work below still completes within the same invocation.
    res.sendStatus(200);

    const { object_type, aspect_type, object_id } = req.body || {};
    if (object_type !== 'activity' || aspect_type !== 'create') return;

    try {
      const accessToken = await getFreshAccessToken();
      const actRes = await fetch(`https://www.strava.com/api/v3/activities/${object_id}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!actRes.ok) { logger.error('Strava activity fetch failed', await actRes.text()); return; }
      const activity = await actRes.json();

      const date = String(activity.start_date_local).slice(0, 10);
      const entry = {
        id: object_id,
        name: activity.name,
        type: activity.type,
        kcal: Math.round(activity.calories ?? 0),
        movingTimeS: activity.moving_time,
      };

      await db.runTransaction(async tx => {
        const ref = dailyDoc(date);
        const snap = await tx.get(ref);
        const existing = snap.exists ? snap.data() : { activities: [] };
        // Strava redelivers on a non-200 or timeout, so dedupe by activity id rather than
        // blindly appending — this must sum same-day rides, never overwrite or double-count.
        const activities = (existing.activities || []).filter(a => a.id !== entry.id);
        activities.push(entry);
        const kcal = activities.reduce((sum, a) => sum + (a.kcal || 0), 0);
        tx.set(ref, { date, kcal, activities });
      });
    } catch (err) {
      logger.error('stravaWebhook processing failed', err);
    }
  },
);
