const SHARED_DB_NAME = 'calorie-tracker-shared';
const DB_VERSION = 1;

// foods/recipes/meta are shared across accounts (one food library); everything that's
// personal to a person's day (log entries, targets, weight) lives in a database scoped
// to whichever account is currently logged in — see auth.js.
const SHARED_STORES = new Set(['foods', 'recipes', 'meta']);
const USER_STORES = new Set(['logEntries', 'dayTargets', 'dayTargetOverrides', 'weightLog']);

let currentUser = null;
export function setCurrentUser(user) {
  currentUser = user;
}

const dbPromises = new Map();

function userDbName(user) {
  return `calorie-tracker-user-${user}`;
}

function openDb(dbName, isUserDb) {
  if (dbPromises.has(dbName)) return dbPromises.get(dbName);
  const p = new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (isUserDb) {
        if (!db.objectStoreNames.contains('logEntries')) {
          const store = db.createObjectStore('logEntries', { keyPath: 'id' });
          store.createIndex('date', 'date', { unique: false });
        }
        if (!db.objectStoreNames.contains('dayTargets')) db.createObjectStore('dayTargets', { keyPath: 'weekday' });
        if (!db.objectStoreNames.contains('dayTargetOverrides')) db.createObjectStore('dayTargetOverrides', { keyPath: 'date' });
        if (!db.objectStoreNames.contains('weightLog')) db.createObjectStore('weightLog', { keyPath: 'date' });
      } else {
        if (!db.objectStoreNames.contains('foods')) db.createObjectStore('foods', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromises.set(dbName, p);
  return p;
}

function resolveDb(storeName) {
  if (SHARED_STORES.has(storeName)) return openDb(SHARED_DB_NAME, false);
  if (USER_STORES.has(storeName)) {
    if (!currentUser) throw new Error(`No current user set (needed for store "${storeName}")`);
    return openDb(userDbName(currentUser), true);
  }
  throw new Error(`Unknown store: ${storeName}`);
}

function tx(db, storeNames, mode) {
  return db.transaction(storeNames, mode);
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll(storeName) {
  const db = await resolveDb(storeName);
  const store = tx(db, storeName, 'readonly').objectStore(storeName);
  return reqToPromise(store.getAll());
}

export async function get(storeName, key) {
  const db = await resolveDb(storeName);
  const store = tx(db, storeName, 'readonly').objectStore(storeName);
  return reqToPromise(store.get(key));
}

export async function put(storeName, value) {
  const db = await resolveDb(storeName);
  const store = tx(db, storeName, 'readwrite').objectStore(storeName);
  await reqToPromise(store.put(value));
  return value;
}

export async function putAll(storeName, values) {
  const db = await resolveDb(storeName);
  const store = tx(db, storeName, 'readwrite').objectStore(storeName);
  await Promise.all(values.map(v => reqToPromise(store.put(v))));
}

export async function remove(storeName, key) {
  const db = await resolveDb(storeName);
  const store = tx(db, storeName, 'readwrite').objectStore(storeName);
  await reqToPromise(store.delete(key));
}

export async function count(storeName) {
  const db = await resolveDb(storeName);
  const store = tx(db, storeName, 'readonly').objectStore(storeName);
  return reqToPromise(store.count());
}

// Range query on logEntries.date, e.g. entriesInRange('2026-08-22','2026-08-22') for a single day.
// Scoped to the current user, since logEntries is a per-user store.
export async function entriesInRange(fromDate, toDate) {
  const db = await resolveDb('logEntries');
  const store = tx(db, 'logEntries', 'readonly').objectStore('logEntries');
  const index = store.index('date');
  const range = IDBKeyRange.bound(fromDate, toDate);
  return reqToPromise(index.getAll(range));
}

export async function getMeta(key) {
  const row = await get('meta', key);
  return row?.value;
}

export async function setMeta(key, value) {
  return put('meta', { key, value });
}
