import { auth } from './firebase.js';
import {
  signInWithEmailAndPassword, signOut as fbSignOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence,
} from '../vendor/firebase/firebase-auth.js';

// Real, server-enforced sign-in. The previous version compared a password in client-side
// JavaScript, which protected nothing once the data left the device — anyone could read it
// via view-source. Firestore rules now decide what each signed-in uid may touch.

// Stay signed in across launches until the user explicitly logs out.
const persistenceReady = setPersistence(auth, browserLocalPersistence).catch(() => {});

export async function login(email, password) {
  await persistenceReady;
  const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
  return credential.user;
}

export function logout() {
  return fbSignOut(auth);
}

export function onUserChanged(callback) {
  return onAuthStateChanged(auth, callback);
}

export function accountLabel(user) {
  if (!user) return '';
  if (user.displayName) return user.displayName;
  const local = (user.email ?? '').split('@')[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : user.email ?? '';
}

// Firebase's error codes are not something to show a person at a kitchen counter.
export function friendlyAuthError(err) {
  switch (err?.code) {
    case 'auth/invalid-email': return 'That email address doesn’t look right.';
    case 'auth/user-disabled': return 'That account has been disabled.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential': return 'Email or password not recognised.';
    case 'auth/too-many-requests': return 'Too many attempts. Wait a minute and try again.';
    case 'auth/network-request-failed': return 'No connection — you need to be online to sign in the first time.';
    default: return 'Could not sign in. Please try again.';
  }
}
