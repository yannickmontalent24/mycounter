const DB_NAME = 'calorie-tracker';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('foods')) db.createObjectStore('foods', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('recipes')) db.createObjectStore('recipes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('logEntries')) {
        const store = db.createObjectStore('logEntries', { keyPath: 'id' });
        store.createIndex('date', 'date', { unique: false });
      }
      if (!db.objectStoreNames.contains('dayTargets')) db.createObjectStore('dayTargets', { keyPath: 'weekday' });
      if (!db.objectStoreNames.contains('dayTargetOverrides')) db.createObjectStore('dayTargetOverrides', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('weightLog')) db.createObjectStore('weightLog', { keyPath: 'date' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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
  const db = await openDb();
  const store = tx(db, storeName, 'readonly').objectStore(storeName);
  return reqToPromise(store.getAll());
}

export async function get(storeName, key) {
  const db = await openDb();
  const store = tx(db, storeName, 'readonly').objectStore(storeName);
  return reqToPromise(store.get(key));
}

export async function put(storeName, value) {
  const db = await openDb();
  const store = tx(db, storeName, 'readwrite').objectStore(storeName);
  await reqToPromise(store.put(value));
  return value;
}

export async function putAll(storeName, values) {
  const db = await openDb();
  const store = tx(db, storeName, 'readwrite').objectStore(storeName);
  await Promise.all(values.map(v => reqToPromise(store.put(v))));
}

export async function remove(storeName, key) {
  const db = await openDb();
  const store = tx(db, storeName, 'readwrite').objectStore(storeName);
  await reqToPromise(store.delete(key));
}

export async function count(storeName) {
  const db = await openDb();
  const store = tx(db, storeName, 'readonly').objectStore(storeName);
  return reqToPromise(store.count());
}

// Range query on logEntries.date, e.g. entriesInRange('2026-08-22','2026-08-22') for a single day.
export async function entriesInRange(fromDate, toDate) {
  const db = await openDb();
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
