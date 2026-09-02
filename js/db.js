import { fs } from './firebase.js';
import {
  collection, doc, getDoc, getDocs, getDocsFromServer, setDoc, deleteDoc, query, where,
} from '../vendor/firebase/firebase-firestore.js';

// Foods and recipes are one library shared by both accounts; everything personal to a day
// lives under that account's own uid and is unreachable by the other (enforced server-side
// by firestore.rules, not by this code).
const SHARED_STORES = new Set(['foods', 'recipes']);
const USER_STORES = new Set(['logEntries', 'dayTargets', 'dayTargetOverrides', 'weightLog', 'bundles', 'meta']);

// Which field of each record is its document id.
const KEY_FIELD = {
  foods: 'id',
  recipes: 'id',
  logEntries: 'id',
  dayTargets: 'weekday',
  dayTargetOverrides: 'date',
  weightLog: 'date',
  bundles: 'id',
  meta: 'key',
};

let currentUid = null;
export function setCurrentUser(uid) {
  currentUid = uid;
}

function collRef(storeName) {
  if (SHARED_STORES.has(storeName)) return collection(fs, 'shared', 'library', storeName);
  if (USER_STORES.has(storeName)) {
    if (!currentUid) throw new Error(`Not signed in (needed for store "${storeName}")`);
    return collection(fs, 'users', currentUid, storeName);
  }
  throw new Error(`Unknown store: ${storeName}`);
}

function docRef(storeName, key) {
  return doc(collRef(storeName), String(key));
}

export async function getAll(storeName) {
  const snap = await getDocs(collRef(storeName));
  return snap.docs.map(d => d.data());
}

export async function get(storeName, key) {
  const snap = await getDoc(docRef(storeName, key));
  return snap.exists() ? snap.data() : undefined;
}

export async function put(storeName, value) {
  const key = value[KEY_FIELD[storeName]];
  if (key == null || key === '') throw new Error(`Record for "${storeName}" is missing its ${KEY_FIELD[storeName]}`);
  // Firestore rejects `undefined`; normalise to null so optional macros round-trip.
  await setDoc(docRef(storeName, key), stripUndefined(value));
  return value;
}

export async function putAll(storeName, values) {
  await Promise.all(values.map(v => put(storeName, v)));
}

export async function remove(storeName, key) {
  await deleteDoc(docRef(storeName, key));
}

export async function count(storeName) {
  const snap = await getDocs(collRef(storeName));
  return snap.size;
}

// Seeding must never run off a cold local cache — an empty offline read would duplicate the
// seed data that already exists on the server. Returns null when the server can't be reached,
// which callers treat as "don't seed".
export async function countFromServer(storeName) {
  try {
    const snap = await getDocsFromServer(collRef(storeName));
    return snap.size;
  } catch {
    return null;
  }
}

export async function entriesInRange(fromDate, toDate) {
  const q = query(collRef('logEntries'), where('date', '>=', fromDate), where('date', '<=', toDate));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data());
}

export async function getMeta(key) {
  const row = await get('meta', key);
  return row?.value;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, v === undefined ? null : stripUndefined(v)]));
  }
  return value === undefined ? null : value;
}
