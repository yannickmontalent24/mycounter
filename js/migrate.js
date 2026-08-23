import * as db from './db.js';

// One-time lift of data written by the pre-Firebase build, which stored everything in local
// IndexedDB. Reads the old databases directly and uploads what it finds. Never deletes the
// local copy — if anything here goes wrong the original data is still on the device.

const LEGACY_SHARED_DB = 'calorie-tracker-shared';
const LEGACY_USER_DB = user => `calorie-tracker-user-${user}`;
const LEGACY_ACCOUNTS = ['yannick', 'manshini'];

function openLegacy(name) {
  return new Promise(resolve => {
    // `undefined` version opens whatever exists without triggering an upgrade.
    const req = indexedDB.open(name);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function readStore(idb, storeName) {
  return new Promise(resolve => {
    if (!idb || !idb.objectStoreNames.contains(storeName)) return resolve([]);
    try {
      const req = idb.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function findLegacyData() {
  const shared = await openLegacy(LEGACY_SHARED_DB);
  const foods = await readStore(shared, 'foods');
  const recipes = await readStore(shared, 'recipes');
  shared?.close();

  const accounts = [];
  for (const name of LEGACY_ACCOUNTS) {
    const idb = await openLegacy(LEGACY_USER_DB(name));
    if (!idb) continue;
    const data = {
      name,
      logEntries: await readStore(idb, 'logEntries'),
      dayTargets: await readStore(idb, 'dayTargets'),
      dayTargetOverrides: await readStore(idb, 'dayTargetOverrides'),
      weightLog: await readStore(idb, 'weightLog'),
    };
    idb.close();
    const total = data.logEntries.length + data.weightLog.length
      + data.dayTargets.filter(t => t.kcal != null || t.protein != null).length
      + data.dayTargetOverrides.length;
    if (total > 0) accounts.push({ ...data, total });
  }

  return { foods, recipes, accounts, hasAnything: foods.length > 0 || recipes.length > 0 || accounts.length > 0 };
}

export async function uploadShared(legacy) {
  const existing = await db.getAll('foods');
  const existingIds = new Set(existing.map(f => f.id));
  const newFoods = legacy.foods.filter(f => !existingIds.has(f.id));
  if (newFoods.length) await db.putAll('foods', newFoods);

  const existingRecipes = new Set((await db.getAll('recipes')).map(r => r.id));
  const newRecipes = legacy.recipes.filter(r => !existingRecipes.has(r.id));
  if (newRecipes.length) await db.putAll('recipes', newRecipes);

  return { foods: newFoods.length, recipes: newRecipes.length };
}

export async function uploadAccount(account) {
  if (account.logEntries.length) await db.putAll('logEntries', account.logEntries);
  const meaningfulTargets = account.dayTargets.filter(t => t.kcal != null || t.protein != null);
  if (meaningfulTargets.length) await db.putAll('dayTargets', meaningfulTargets);
  if (account.dayTargetOverrides.length) await db.putAll('dayTargetOverrides', account.dayTargetOverrides);
  if (account.weightLog.length) await db.putAll('weightLog', account.weightLog);
  return {
    logEntries: account.logEntries.length,
    targets: meaningfulTargets.length,
    overrides: account.dayTargetOverrides.length,
    weights: account.weightLog.length,
  };
}

export async function alreadyMigrated() {
  return (await db.getMeta('legacy-migrated')) === true;
}

export async function markMigrated() {
  await db.setMeta('legacy-migrated', true);
}
