// Single place the Firebase SDK is initialised. The SDK is vendored under /vendor/firebase so
// the app still opens with no network — a cross-origin CDN script can't be precached by the
// service worker, which would break the offline-first requirement (main brief §8).
import { initializeApp } from '../vendor/firebase/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
} from '../vendor/firebase/firebase-firestore.js';
import { getAuth } from '../vendor/firebase/firebase-auth.js';
import { firebaseConfig } from './firebase-config.js';

export const app = initializeApp(firebaseConfig);

// Firestore keeps its own local copy and serves reads from it when offline, queueing writes
// until the connection returns. That local cache — not the network — is what the app talks to,
// so logging at the kitchen counter never waits on a request.
export const fs = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

export const auth = getAuth(app);
