import * as db from './db.js';
import { seedSharedIfEmpty, seedUserIfEmpty } from './seed.js';
import {
  resolveTarget, weekdayOf, heroState, ringDash, entryMacros,
  foodPortionMacros, recipePerGram, recipePortionMacros, validateFood, validateRecipe, formatDateHeader,
  isDraftRecipe, findSimilarFoods, unitOf,
  MEALS, MEAL_LABELS, inferMeal, groupEntriesByMeal, sumMacros, resolveEntriesForDisplay,
  COOK_CATEGORIES, estimateCookedWeightG, splitFoodLibrary, sortFoods, FOOD_SORTS,
  weightSeries, averageWeight,
  bundleMacros, bundleItemMacros, validateBundle,
} from './logic.js';
import {
  exportDay, exportRange, prepareImport, commitImport, exportLibraryForClaude, ImportError,
} from './import-export.js';
import { login, logout, onUserChanged, accountLabel, friendlyAuthError } from './auth.js';
import { findLegacyData, uploadShared, uploadAccount, alreadyMigrated, markMigrated } from './migrate.js';
import { PHASES, activePhase, weekNumberFor, defaultDayIndex } from './workouts.js';
import { initPullToRefresh } from './pull-refresh.js';

// Safari (and standalone iOS webviews) still dispatch these non-standard gesture events for
// pinch even when touch-action forbids zooming, so they need their own preventDefault.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(type, e => e.preventDefault());
}

const WEEKDAY_ROWS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_LABELS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const SOURCE_GLYPH = { label: '■', reference: '□', estimate: '◇' };

// A single configured race date drives the Today countdown chip (redesign §State).
const RACE_DATE = '2026-10-25';
function daysToRace(fromISO = todayISO()) {
  const [ry, rm, rd] = RACE_DATE.split('-').map(Number);
  const [fy, fm, fd] = fromISO.split('-').map(Number);
  return Math.round((Date.UTC(ry, rm - 1, rd) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

// Thousands separator for the figures that get large (calories). Small numbers pass through.
function fmt(n) {
  return Math.round(n).toLocaleString('en-US');
}

// Provenance / kind badge for a resolved log entry — glyph + label so it reads without colour.
function entryBadge(e) {
  if (e.isRecipe) return '<span class="badge badge-recipe">▤ recipe</span>';
  return sourceBadge(e.source);
}
function sourceBadge(source) {
  const map = {
    label: ['badge-label', '▣ label'],
    reference: ['badge-reference', '◨ reference'],
    estimate: ['badge-estimate', '◌ estimate'],
  };
  const [cls, text] = map[source] || map.estimate;
  return `<span class="badge ${cls}">${text}</span>`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---- In-memory cache, refreshed from Firestore after any mutation ----
const cache = { foods: [], recipes: [], bundles: [], dayTargets: [], overrides: [], weightLog: [], foodFrequency: new Map() };

// Last computed Today totals + target, so the Log screen's "kcal left" preview doesn't need
// its own fetch. Refreshed by renderToday.
let lastToday = { kcal: 0, protein: 0, target: { kcal: null, protein: null } };

// Split so boot can paint Today (which only needs the "essential" half) as soon as possible,
// then fill in weightLog/foodFrequency — needed only by Settings and the quick-log
// favourites — in the background rather than making the first screen wait on them too.
async function refreshEssentialCache() {
  const [foods, recipes, bundles, dayTargets, overrides] = await Promise.all([
    db.getAll('foods'), db.getAll('recipes'), db.getAll('bundles'), db.getAll('dayTargets'), db.getAll('dayTargetOverrides'),
  ]);
  cache.foods = foods;
  cache.recipes = recipes;
  cache.bundles = bundles;
  cache.dayTargets = dayTargets;
  cache.overrides = overrides;
}

async function refreshBackgroundCache() {
  const [weightLog, recent] = await Promise.all([
    db.getAll('weightLog'),
    // How often each food has been logged recently, so the Log screen can lead with the foods
    // actually eaten rather than whatever happens to sort first.
    db.entriesInRange(isoDaysAgo(60), todayISO()),
  ]);
  cache.weightLog = weightLog.sort((a, b) => b.date.localeCompare(a.date));
  const freq = new Map();
  for (const e of recent) {
    const key = e.foodId ? `food:${e.foodId}` : (e.recipeId ? `recipe:${e.recipeId}` : null);
    if (!key) continue;
    freq.set(key, (freq.get(key) ?? 0) + 1);
  }
  cache.foodFrequency = freq;
}

// Used after any mutation, where everything needs to be current — as opposed to boot, which
// calls the two halves above separately so it can paint before the background half lands.
async function refreshCache() {
  await Promise.all([refreshEssentialCache(), refreshBackgroundCache()]);
}

function foodsById() { return new Map(cache.foods.map(f => [f.id, f])); }
function recipesById() { return new Map(cache.recipes.map(r => [r.id, r])); }
function bundlesById() { return new Map(cache.bundles.map(b => [b.id, b])); }

// ---- Routing ----
const SCREENS = ['today', 'log', 'foods', 'workouts', 'history', 'weight', 'settings'];

function currentScreenFromHash() {
  const h = location.hash.replace('#', '');
  return SCREENS.includes(h) ? h : 'today';
}

function goTo(screen) {
  location.hash = screen;
}

let previousScreen = null;

function renderRoute() {
  const screen = currentScreenFromHash();
  // Leaving the Log tab mid-backdate shouldn't let a stale date silently carry into a later,
  // unrelated visit — logState is defined further down but this only ever runs after the
  // whole module has evaluated, so it's already initialized by the time this executes.
  if (previousScreen === 'log' && screen !== 'log') {
    logState.date = null;
  }
  previousScreen = screen;
  for (const s of SCREENS) {
    document.getElementById(`screen-${s}`).hidden = s !== screen;
  }
  // History and the body-weight log have no tab of their own — they sit under Settings, so
  // Settings stays lit while they're open rather than leaving no tab highlighted at all.
  const tabForScreen = (screen === 'history' || screen === 'weight') ? 'settings' : screen;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.go === tabForScreen;
    btn.classList.toggle('active', active);
    btn.querySelector('.indicator').textContent = active ? '━' : '';
  });
  const renderers = {
    today: renderToday, log: renderLog, foods: renderLibrary,
    workouts: renderWorkouts, history: renderHistory, weight: renderWeight, settings: renderSettings,
  };
  renderers[screen]();
}

window.addEventListener('hashchange', renderRoute);
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => goTo(btn.dataset.go)));

// ==================== TODAY ====================
// Small inline spinner for a section whose fetch is in flight — distinct from the full-screen
// splash, which only covers boot. Kept generic so Today, History, and the day-detail sheet
// (whose entries are always at least one Firestore round-trip away) all show the same thing.
function showSectionLoading(container) {
  container.innerHTML = '<div class="rd-skeleton" role="status" aria-label="Loading">'
    + '<div class="rd-skeleton-bar" style="width:60%"></div>'
    + '<div class="rd-skeleton-bar" style="width:85%"></div>'
    + '<div class="rd-skeleton-bar" style="width:40%"></div></div>';
}

async function renderToday({ scrollToMeal = null } = {}) {
  const dateStr = todayISO();
  document.getElementById('today-date-chip').textContent = formatDateHeader(dateStr);

  const dtr = daysToRace(dateStr);
  const raceChip = document.getElementById('today-race-chip');
  if (dtr > 0) {
    document.getElementById('today-race-n').textContent = dtr;
    raceChip.hidden = false;
  } else {
    raceChip.hidden = true;
  }

  showSectionLoading(document.getElementById('today-entry-list'));

  const entries = await db.entriesInRange(dateStr, dateStr);
  const resolved = resolveEntriesForDisplay(entries, foodsById(), recipesById());

  const kcalTotal = resolved.reduce((a, e) => a + e.kcal, 0);
  const protTotal = resolved.reduce((a, e) => a + e.protein, 0);
  const target = resolveTarget(cache.dayTargets, cache.overrides, dateStr, weekdayOf(dateStr));

  applyHero('kcal', kcalTotal, target.kcal);
  applyHero('protein', protTotal, target.protein);
  lastToday = { kcal: kcalTotal, protein: protTotal, target };

  document.getElementById('today-day-kcal').innerHTML = `${fmt(kcalTotal)} <span>kcal</span>`;
  document.getElementById('today-day-protein').innerHTML = `${fmt(protTotal)} <span>g</span>`;

  const list = document.getElementById('today-entry-list');
  list.innerHTML = '';

  const { groups, unsorted } = groupEntriesByMeal(resolved);
  for (const meal of MEALS) {
    list.appendChild(buildMealSection(meal, MEAL_LABELS[meal], groups.get(meal), { canAdd: true }));
  }
  if (unsorted.length) {
    list.appendChild(buildMealSection(null, 'Not assigned', unsorted, { canAdd: false }));
  }

  // Logging (or editing/deleting) something re-fetches and rebuilds this whole list, which
  // would otherwise always land the scroll position back at Breakfast — annoying when you're
  // three meals in. Callers that know which meal they just touched ask to be scrolled back to it.
  if (scrollToMeal) {
    document.getElementById(`meal-section-${scrollToMeal}`)?.scrollIntoView({ block: 'start' });
  }
}

// One section per meal. Empty sections still render, because their "+" is the way to log
// into that meal (feature brief §3) — but they stay compact so the day is still scannable.
// `interactive: false` (used by the read-only day-detail view for past dates) drops the add/
// delete/move controls and just shows what was eaten.
function buildMealSection(meal, label, entries, { canAdd, interactive = true } = {}) {
  entries = entries || [];
  const totals = sumMacros(entries);
  const section = el(`
    <section class="meal-card" id="meal-section-${meal ?? 'unassigned'}">
      <div class="meal-card-head">
        <div class="l">
          <span class="name">${escapeHtml(label)}</span>
          <span class="sub">${entries.length ? `${totals.kcal} · ${totals.protein} g` : ''}</span>
        </div>
        ${canAdd ? `<button type="button" class="meal-card-add" data-add-meal="${meal}" aria-label="Log food under ${escapeHtml(label)}"><span aria-hidden="true">+</span></button>` : ''}
      </div>
      <div class="meal-rows"></div>
    </section>
  `);

  const rows = section.querySelector('.meal-rows');
  if (!entries.length) {
    const well = el(`<div class="meal-empty-well">Nothing logged for ${escapeHtml(label)}</div>`);
    if (canAdd) {
      well.append(' · ');
      const b = el('<button type="button">add something</button>');
      b.addEventListener('click', () => openLogSheet(meal));
      well.append(b);
    }
    rows.appendChild(well);
  }
  for (const e of entries) {
    const row = el(`
      <div class="meal-entry">
        ${interactive
          ? `<button type="button" class="meal-entry-main" data-edit-entry="${e.id}" aria-label="Edit ${escapeHtml(e.name)}">
               <span class="meal-entry-name">${escapeHtml(e.name)}</span>
               <span class="meal-entry-meta"><span class="meal-entry-amt">${e.grams} ${e.unit}</span>${entryBadge(e)}</span>
             </button>`
          : `<div class="meal-entry-main">
               <span class="meal-entry-name">${escapeHtml(e.name)}</span>
               <span class="meal-entry-meta"><span class="meal-entry-amt">${e.grams} ${e.unit}</span>${entryBadge(e)}</span>
             </div>`}
        <span class="meal-entry-figs"><span class="k">${e.kcal}</span><span class="p">${e.protein} g P</span></span>
        ${interactive ? `
          <button type="button" class="meal-entry-act" data-move-entry="${e.id}" aria-label="Change meal for ${escapeHtml(e.name)}">⇄</button>
          <button type="button" class="meal-entry-act is-delete" data-del-entry="${e.id}" aria-label="Delete ${escapeHtml(e.name)}">×</button>
        ` : ''}
      </div>
    `);
    if (interactive) {
      row.querySelector('[data-edit-entry]').addEventListener('click', () => openEditEntryModal(e.id));
      row.querySelector('[data-del-entry]').addEventListener('click', async () => {
        await db.remove('logEntries', e.id);
        renderToday({ scrollToMeal: e.meal });
      });
      row.querySelector('[data-move-entry]').addEventListener('click', () => openMealPicker(e));
    }
    rows.appendChild(row);
  }

  const addBtn = section.querySelector('[data-add-meal]');
  if (addBtn) addBtn.addEventListener('click', () => openLogSheet(meal));
  return section;
}

// ==================== QUICK LOG SHEET ====================
// Logging happens where the day is being read, rather than sending the user to another tab
// and back. Same maths as the Log screen; the tab remains for anything more involved.
const sheetState = { meal: 'lunch', query: '', pickedId: null, pickedKind: null, grams: '' };

function loggableItems() {
  return [
    ...cache.foods.map(f => ({ kind: 'food', record: f })),
    ...cache.recipes.filter(r => !isDraftRecipe(r)).map(r => ({ kind: 'recipe', record: r })),
  ];
}

function frequencyOf(kind, id) {
  return cache.foodFrequency.get(`${kind}:${id}`) ?? 0;
}

// "Favourites" are earned, not curated — whatever actually gets logged most, so the common
// case needs no typing at all.
function favouriteItems(limit = 6) {
  return loggableItems()
    .map(c => ({ ...c, count: frequencyOf(c.kind, c.record.id) }))
    .filter(c => c.count > 0)
    .sort((a, b) => b.count - a.count || a.record.name.localeCompare(b.record.name))
    .slice(0, limit);
}

// Logging a bundle fans out into one ordinary logEntry per item rather than a new kind of
// entry — same date/meal/timestamp, so it reads in Today exactly like logging each item by
// hand, and stays individually editable afterwards.
function bundleToLogEntries(bundle, meal, date = todayISO()) {
  const loggedAt = new Date().toISOString();
  return bundle.items.map(item => ({
    id: crypto.randomUUID(),
    date,
    foodId: item.kind === 'food' ? item.id : null,
    recipeId: item.kind === 'recipe' ? item.id : null,
    grams: item.grams,
    meal,
    loggedAt,
  }));
}

async function logBundle(bundle, meal) {
  await db.putAll('logEntries', bundleToLogEntries(bundle, meal));
  // Logging touches only logEntries — nothing the essential cache holds. The one thing that
  // does drift is the quick-log frequency map, so refresh that in the background rather than
  // making the sheet sit there through a full re-fetch of foods/recipes/bundles/targets.
  refreshBackgroundCache().then(renderRoute).catch(() => {});
}

function sheetPicked() {
  if (!sheetState.pickedId) return null;
  return sheetState.pickedKind === 'recipe'
    ? recipesById().get(sheetState.pickedId)
    : foodsById().get(sheetState.pickedId);
}

function sheetUnit() {
  if (sheetState.pickedKind === 'recipe') return 'g';
  return unitOf(sheetPicked());
}

function openLogSheet(meal) {
  sheetState.meal = meal;
  sheetState.query = '';
  sheetState.pickedId = null;
  sheetState.pickedKind = null;
  sheetState.grams = '';

  openModal(`
    <div class="sheet-head">
      <h2 style="margin:0;">Add to ${escapeHtml(MEAL_LABELS[meal])}</h2>
      <button type="button" class="meal-chip" id="sheet-meal-chip">${escapeHtml(MEAL_LABELS[meal])}</button>
    </div>
    <input class="text-input" id="sheet-search" type="text" placeholder="Search foods and recipes" autocomplete="off" style="margin-bottom:6px;">
    <div class="section-label" id="sheet-bundles-label" style="margin:12px 0 0;" hidden>Bundles — tap to log all at once</div>
    <div class="search-results" id="sheet-bundles" hidden></div>
    <div class="section-label" id="sheet-list-label" style="margin:12px 0 0;">Favourites</div>
    <div class="search-results" id="sheet-results"></div>
    <div id="sheet-amount" hidden>
      <div class="section-label" id="sheet-amount-label" style="margin-top:16px;">Amount (g)</div>
      <div class="amount-row">
        <button type="button" class="stepper-btn" id="sheet-minus" aria-label="Decrease by 10">−</button>
        <div class="amount-field">
          <input id="sheet-grams" type="text" inputmode="numeric" maxlength="4" aria-label="Amount">
          <span class="unit" id="sheet-unit">g</span>
        </div>
        <button type="button" class="stepper-btn" id="sheet-plus" aria-label="Increase by 10">+</button>
      </div>
      <div class="draft-summary">
        <span class="name" id="sheet-draft-name">Nothing selected</span>
        <span class="macros" id="sheet-draft-macros">—</span>
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="sheet-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="sheet-add" disabled>Add</button>
    </div>
  `);

  document.getElementById('sheet-cancel').addEventListener('click', closeModal);
  document.getElementById('sheet-search').addEventListener('input', e => {
    sheetState.query = e.target.value;
    renderSheetResults();
    renderSheetBundles();
  });
  document.getElementById('sheet-meal-chip').addEventListener('click', () => {
    sheetState.meal = MEALS[(MEALS.indexOf(sheetState.meal) + 1) % MEALS.length];
    document.getElementById('sheet-meal-chip').textContent = MEAL_LABELS[sheetState.meal];
    document.querySelector('#modal-sheet h2').textContent = `Add to ${MEAL_LABELS[sheetState.meal]}`;
  });
  document.getElementById('sheet-minus').addEventListener('click', () => adjustSheetGrams(-10));
  document.getElementById('sheet-plus').addEventListener('click', () => adjustSheetGrams(10));
  document.getElementById('sheet-grams').addEventListener('input', e => {
    sheetState.grams = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
    e.target.value = sheetState.grams;
    renderSheetDraft();
  });
  document.getElementById('sheet-add').addEventListener('click', confirmSheetLog);

  renderSheetResults();
  renderSheetBundles();
}

// Bundles only surface unfiltered, above Favourites — they're already named and curated, so
// they don't need to earn their place the way food favourites do, and searching them alongside
// individual foods would blur "log one thing" with "log everything I usually have".
function renderSheetBundles() {
  const label = document.getElementById('sheet-bundles-label');
  const container = document.getElementById('sheet-bundles');
  const show = !sheetState.query.trim() && cache.bundles.length > 0;
  label.hidden = !show;
  container.hidden = !show;
  if (!show) return;

  container.innerHTML = '';
  const fMap = foodsById(), rMap = recipesById();
  for (const b of cache.bundles) {
    const macros = bundleMacros(b, fMap, rMap);
    const btn = el(`
      <button type="button" class="search-result-btn">
        <span class="name">${escapeHtml(b.name)}</span>
        <span class="per100">${b.items.length} item${b.items.length === 1 ? '' : 's'} · ${macros.kcal} kcal · ${macros.protein} g</span>
        <span class="check">➜</span>
      </button>
    `);
    btn.addEventListener('click', async () => {
      await logBundle(b, sheetState.meal);
      closeModal();
      renderToday({ scrollToMeal: sheetState.meal });
      toast(`Logged ${b.name}`);
    });
    container.appendChild(btn);
  }
}

function adjustSheetGrams(delta) {
  const next = Math.max(10, (parseInt(sheetState.grams, 10) || 0) + delta);
  sheetState.grams = String(next);
  document.getElementById('sheet-grams').value = sheetState.grams;
  renderSheetDraft();
}

function renderSheetResults() {
  const q = sheetState.query.trim().toLowerCase();
  const label = document.getElementById('sheet-list-label');
  let results;

  if (q) {
    results = loggableItems()
      .filter(c => c.record.name.toLowerCase().includes(q))
      .sort((a, b) => frequencyOf(b.kind, b.record.id) - frequencyOf(a.kind, a.record.id)
        || a.record.name.localeCompare(b.record.name))
      .slice(0, 6);
    label.textContent = 'Results';
  } else {
    results = favouriteItems();
    label.textContent = results.length ? 'Favourites — most logged' : 'Start typing to find a food';
  }

  const container = document.getElementById('sheet-results');
  container.innerHTML = '';
  for (const { kind, record, count } of results) {
    const selected = sheetState.pickedId === record.id && sheetState.pickedKind === kind;
    const meta = kind === 'recipe'
      ? 'recipe'
      : `${record.per100g.kcal} kcal /100${unitOf(record)}`;
    const btn = el(`
      <button type="button" class="search-result-btn">
        <span class="name">${escapeHtml(record.name)}</span>
        <span class="per100">${escapeHtml(meta)}${count ? ` · ×${count}` : ''}</span>
        <span class="check">${selected ? '●' : '○'}</span>
      </button>
    `);
    btn.addEventListener('click', () => {
      sheetState.pickedId = record.id;
      sheetState.pickedKind = kind;
      sheetState.grams = String(kind === 'recipe' ? onePortionGrams(record) : (record.defaultPortionG ?? 100));
      document.getElementById('sheet-grams').value = sheetState.grams;
      document.getElementById('sheet-amount').hidden = false;
      const unit = sheetUnit();
      document.getElementById('sheet-unit').textContent = unit;
      document.getElementById('sheet-amount-label').textContent = unit === 'ml' ? 'Amount (ml)' : 'Amount (g)';
      renderSheetResults();
      renderSheetDraft();
    });
    container.appendChild(btn);
  }

  if (q && results.length === 0) {
    container.appendChild(el(`<div class="meal-empty">No match. Use the Log tab to add a new food.</div>`));
  }
}

function renderSheetDraft() {
  const picked = sheetPicked();
  const nameEl = document.getElementById('sheet-draft-name');
  const macrosEl = document.getElementById('sheet-draft-macros');
  const addBtn = document.getElementById('sheet-add');
  const grams = parseInt(sheetState.grams, 10) || 0;

  if (!picked || !grams) {
    nameEl.textContent = picked ? picked.name : 'Nothing selected';
    macrosEl.textContent = '—';
    addBtn.disabled = true;
    return;
  }
  try {
    const m = sheetState.pickedKind === 'recipe'
      ? recipePortionMacros(picked, foodsById(), grams)
      : foodPortionMacros(picked, grams);
    nameEl.textContent = picked.name;
    macrosEl.textContent = `${m.kcal} kcal · ${m.protein} g`;
    addBtn.disabled = false;
  } catch {
    macrosEl.textContent = 'missing ingredient';
    addBtn.disabled = true;
  }
}

async function confirmSheetLog() {
  const grams = parseInt(sheetState.grams, 10) || 0;
  if (!sheetState.pickedId || !grams) return;
  const isRecipe = sheetState.pickedKind === 'recipe';
  const addBtn = document.getElementById('sheet-add');
  addBtn.disabled = true;
  await db.put('logEntries', {
    id: crypto.randomUUID(),
    date: todayISO(),
    foodId: isRecipe ? null : sheetState.pickedId,
    recipeId: isRecipe ? sheetState.pickedId : null,
    grams,
    meal: sheetState.meal,
    loggedAt: new Date().toISOString(),
  });
  closeModal();
  renderToday({ scrollToMeal: sheetState.meal });
  // Only the quick-log frequency map can be stale now; refresh it without blocking the sheet.
  refreshBackgroundCache().catch(() => {});
}

function openMealPicker(entry) {
  const buttons = MEALS.map(m => `
    <button type="button" class="secondary-btn" data-pick-meal="${m}" style="margin-bottom:8px; text-align:center;">${MEAL_LABELS[m]}</button>
  `).join('');
  openModal(`
    <h2>Move to which meal?</h2>
    <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0;">${escapeHtml(entry.name)}</p>
    ${buttons}
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="meal-cancel" style="text-align:center;">Cancel</button>
    </div>
  `);
  document.getElementById('meal-cancel').addEventListener('click', closeModal);
  document.querySelectorAll('[data-pick-meal]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const stored = await db.get('logEntries', entry.id);
      if (stored) await db.put('logEntries', { ...stored, meal: btn.dataset.pickMeal });
      closeModal();
      renderToday({ scrollToMeal: btn.dataset.pickMeal });
    });
  });
}

// Tapping an entry's name/amount opens this to change how much was logged — the quick
// delete (×) and move-meal (⇄) buttons on the row stay for the fast path, this is for
// "actually I had more/less than that".
async function openEditEntryModal(entryId) {
  const entry = await db.get('logEntries', entryId);
  if (!entry) return;
  const isRecipe = entry.recipeId != null;
  const record = isRecipe ? recipesById().get(entry.recipeId) : foodsById().get(entry.foodId);
  if (!record) { toast('That item no longer exists in your library'); return; }
  const unit = isRecipe ? 'g' : unitOf(record);

  openModal(`
    <h2>Edit entry</h2>
    <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0;">${escapeHtml(record.name)}</p>
    <div class="section-label" style="margin-top:6px;">Amount (${unit})</div>
    <div class="amount-row">
      <button type="button" class="stepper-btn" id="ee-minus" aria-label="Decrease by 10">−</button>
      <div class="amount-field">
        <input id="ee-grams" type="text" inputmode="numeric" maxlength="4" aria-label="Amount" value="${entry.grams}">
        <span class="unit">${unit}</span>
      </div>
      <button type="button" class="stepper-btn" id="ee-plus" aria-label="Increase by 10">+</button>
    </div>
    <div class="draft-summary">
      <span class="name">${escapeHtml(record.name)}</span>
      <span class="macros" id="ee-macros">—</span>
    </div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="ee-delete">Delete</button>
      <button type="button" class="primary-btn" id="ee-save">Save</button>
    </div>
  `);

  function currentGrams() {
    return parseInt(document.getElementById('ee-grams').value, 10) || 0;
  }
  function updatePreview() {
    const g = currentGrams();
    const macrosEl = document.getElementById('ee-macros');
    if (!g) { macrosEl.textContent = '—'; return; }
    try {
      const m = isRecipe ? recipePortionMacros(record, foodsById(), g) : foodPortionMacros(record, g);
      macrosEl.textContent = `${m.kcal} kcal · ${m.protein} g`;
    } catch {
      macrosEl.textContent = 'missing ingredient';
    }
  }
  updatePreview();

  document.getElementById('ee-grams').addEventListener('input', e => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
    updatePreview();
  });
  document.getElementById('ee-minus').addEventListener('click', () => {
    document.getElementById('ee-grams').value = Math.max(1, currentGrams() - 10);
    updatePreview();
  });
  document.getElementById('ee-plus').addEventListener('click', () => {
    document.getElementById('ee-grams').value = currentGrams() + 10;
    updatePreview();
  });
  document.getElementById('ee-delete').addEventListener('click', async () => {
    await db.remove('logEntries', entry.id);
    closeModal();
    renderToday({ scrollToMeal: entry.meal });
  });
  document.getElementById('ee-save').addEventListener('click', async () => {
    const grams = currentGrams();
    if (!grams) return;
    await db.put('logEntries', { ...entry, grams });
    closeModal();
    renderToday({ scrollToMeal: entry.meal });
  });
}

// kind: 'kcal' | 'protein'. For protein, reaching or passing the target is a *win*
// (navy, "target met"); for calories, passing it is a *warning* (crimson, "over").
function applyHero(kind, consumed, target) {
  const numEl = document.getElementById(`hero-${kind}-num`);
  const stateEl = document.getElementById(`hero-${kind}-state`);
  const subEl = document.getElementById(`hero-${kind}-sub`);
  const ringEl = document.getElementById(`ring-${kind}`);
  const trackEl = ringEl.previousElementSibling;
  const C = '276.5';
  const unit = kind === 'kcal' ? 'kcal' : 'g';

  const setState = (text, over) => {
    if (!text) { stateEl.hidden = true; return; }
    stateEl.hidden = false;
    stateEl.textContent = text;
    stateEl.classList.toggle('is-over', !!over);
  };

  if (target == null) {
    numEl.textContent = '—';
    numEl.classList.remove('is-over');
    setState(null);
    subEl.textContent = `${fmt(consumed)} ${unit} logged · no target set`;
    subEl.classList.add('plain');
    ringEl.setAttribute('stroke-dasharray', `0 ${C}`);
    trackEl.setAttribute('stroke-dasharray', '6 10');
    return;
  }

  subEl.classList.remove('plain');
  trackEl.removeAttribute('stroke-dasharray');
  ringEl.setAttribute('stroke-dasharray', ringDash(consumed, target));

  const remaining = target - consumed;
  const ofTarget = `${fmt(consumed)} / ${fmt(target)} ${unit}`;

  if (consumed === 0) {
    numEl.textContent = fmt(target);
    numEl.classList.remove('is-over');
    setState(null);
    subEl.textContent = kind === 'kcal' ? 'the whole day ahead' : `${fmt(target)} g to go`;
    return;
  }

  if (kind === 'protein' && remaining <= 0) {
    numEl.textContent = `+${fmt(-remaining)}`;
    numEl.classList.remove('is-over');
    setState('✓ target met', false);
    subEl.textContent = ofTarget;
    return;
  }

  if (kind === 'kcal' && remaining < 0) {
    numEl.textContent = `+${fmt(-remaining)}`;
    numEl.classList.add('is-over');
    setState('▲ over', true);
    subEl.textContent = ofTarget;
    return;
  }

  numEl.textContent = fmt(remaining);
  numEl.classList.remove('is-over');
  setState(null);
  subEl.textContent = ofTarget;
}

document.getElementById('export-day-btn').addEventListener('click', async () => {
  const text = await exportDay(todayISO());
  const ok = await copyText(text);
  toast(ok ? 'Copied today’s log' : 'Could not copy — check clipboard permission');
});

// ==================== LOG ENTRY ====================
// `meal` is null until the user logs, at which point it's inferred from the clock — unless
// they arrived via a section's "+", which sets it explicitly. `date` is null until the date
// chip is changed away from today, so logging normally needs no date handling at all.
const logState = { query: '', pickedId: null, pickedKind: null, grams: '', meal: null, date: null };

function pickedRecord() {
  if (!logState.pickedId) return null;
  return logState.pickedKind === 'recipe'
    ? recipesById().get(logState.pickedId)
    : foodsById().get(logState.pickedId);
}

function currentLogUnit() {
  // A batch is weighed, so recipe amounts are always grams.
  if (logState.pickedKind === 'recipe') return 'g';
  return unitOf(pickedRecord());
}

// Per-100 g figures for a recipe, so a weighed plateful can be sanity-checked.
// Returns null when an ingredient food is missing or the batch isn't weighed yet.
function recipePer100(recipe) {
  if (isDraftRecipe(recipe)) return null;
  try {
    const perGram = recipePerGram(recipe, foodsById());
    return { kcal: Math.round(perGram.kcal * 100), protein: Math.round(perGram.protein * 100) };
  } catch {
    return null;
  }
}

function onePortionGrams(recipe) {
  return Math.round(recipe.cookedWeightG / recipe.portions);
}

function renderLog() {
  const input = document.getElementById('foodsearch');
  input.value = logState.query;
  renderLogResults();
  renderLogDraft();
  document.getElementById('gramsfield').value = logState.grams;

  // The amount field speaks the selected food's unit: drinks are logged in ml, never converted.
  const unit = currentLogUnit();
  document.getElementById('amount-unit').textContent = unit;
  document.getElementById('gramsfield').setAttribute('aria-label', `Amount in ${unit === 'ml' ? 'millilitres' : 'grams'}`);
  document.getElementById('grams-down').setAttribute('aria-label', `Decrease by 10 ${unit === 'ml' ? 'millilitres' : 'grams'}`);
  document.getElementById('grams-up').setAttribute('aria-label', `Increase by 10 ${unit === 'ml' ? 'millilitres' : 'grams'}`);

  const effectiveMeal = logState.meal ?? inferMeal();
  const chip = document.getElementById('log-meal-chip');
  chip.innerHTML = `${escapeHtml(MEAL_LABELS[effectiveMeal])} <span aria-hidden="true">▾</span>`;
  chip.setAttribute('aria-label', `Meal: ${MEAL_LABELS[effectiveMeal]}. Tap to change.`);

  // Backdating a missed day: defaults to today, capped so it can never be set to the future.
  const today = todayISO();
  const effectiveDate = logState.date ?? today;
  const dateInput = document.getElementById('log-date-input');
  dateInput.value = effectiveDate;
  dateInput.max = today;
  dateInput.setAttribute('aria-label', effectiveDate === today ? 'Change date — currently today' : `Change date — currently ${formatDateHeader(effectiveDate)}`);
  document.getElementById('confirm-log-btn').textContent = effectiveDate === today ? 'Add to today' : `Add to ${formatDateHeader(effectiveDate)}`;
}

document.getElementById('log-date-input').addEventListener('change', e => {
  const today = todayISO();
  const value = e.target.value;
  // An empty or (somehow) future value falls back to today rather than logging nothing.
  logState.date = (!value || value > today) ? null : value;
  renderLog();
});

// Tapping the chip cycles through the four meals — quicker than a picker for a one-off
// correction, and the current choice is always readable on the chip itself.
document.getElementById('log-meal-chip').addEventListener('click', () => {
  const current = logState.meal ?? inferMeal();
  logState.meal = MEALS[(MEALS.indexOf(current) + 1) % MEALS.length];
  renderLog();
});

function renderLogResults() {
  const q = logState.query.trim().toLowerCase();

  // Recipes are logged from here too, so a weighed plateful can be entered in grams rather
  // than assuming you ate exactly one equal share of the batch. Drafts are excluded — their
  // macros can't be resolved until the batch has been weighed.
  const candidates = [
    ...cache.foods.map(f => ({ kind: 'food', record: f })),
    ...cache.recipes.filter(r => !isDraftRecipe(r)).map(r => ({ kind: 'recipe', record: r })),
  ].filter(c => !q || c.record.name.toLowerCase().includes(q));

  // With no search term, lead with what actually gets eaten most — usually this means logging
  // needs no typing at all. Within a search, keep frequent items first too.
  const freq = cache.foodFrequency;
  const freqOf = c => freq.get(`${c.kind}:${c.record.id}`) ?? 0;
  candidates.sort((a, b) => {
    const diff = freqOf(b) - freqOf(a);
    return diff !== 0 ? diff : a.record.name.localeCompare(b.record.name);
  });
  const results = candidates.slice(0, 4);

  const hintEl = document.getElementById('log-results-hint');
  const showHint = !q && results.length > 0 && [...freq.values()].some(v => v > 0);
  hintEl.hidden = !showHint;

  const container = document.getElementById('log-search-results');
  container.innerHTML = '';
  for (const { kind, record } of results) {
    let per100Text;
    if (kind === 'recipe') {
      const per100 = recipePer100(record);
      per100Text = per100 ? `${per100.kcal} kcal · ${per100.protein} g P / 100 g` : 'unavailable';
    } else {
      per100Text = `${record.per100g.kcal} kcal · ${record.per100g.protein} g P / 100 ${unitOf(record)}`;
    }
    const selected = logState.pickedId === record.id && logState.pickedKind === kind;
    const badge = kind === 'recipe'
      ? '<span class="badge badge-recipe">▤ recipe</span>'
      : sourceBadge(record.source);
    const btn = el(`
      <button type="button" class="log-result${selected ? ' is-selected' : ''}" aria-pressed="${selected}">
        <span class="log-result-main">
          <span class="log-result-name">${escapeHtml(record.name)}</span>
          <span class="log-result-meta"><span class="log-result-per">${per100Text}</span>${badge}</span>
        </span>
        ${selected ? '<svg class="log-result-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>' : ''}
      </button>
    `);
    btn.addEventListener('click', () => {
      logState.pickedId = record.id;
      logState.pickedKind = kind;
      logState.grams = String(kind === 'recipe' ? onePortionGrams(record) : (record.defaultPortionG ?? 100));
      renderLog();
    });
    container.appendChild(btn);
  }

  // Nothing matched: offer to create it right here, rather than sending the user off to the
  // Library tab and back mid-log. This is the moment most likely to end a logging habit.
  if (q && results.length === 0) {
    const raw = logState.query.trim();
    const addBtn = el(`
      <button type="button" class="log-result log-result-add">
        <span class="plus" aria-hidden="true">+</span>
        <span class="txt">Add &ldquo;${escapeHtml(raw)}&rdquo; as a new food</span>
      </button>
    `);
    addBtn.addEventListener('click', () => openQuickAddFoodModal(raw));
    container.appendChild(addBtn);
  }
}

// Deliberately fewer fields than the full Add food form: name, the two numbers that matter,
// portion, source. Everything else can be filled in later from the Foods tab.
function openQuickAddFoodModal(prefillName, { onSaved = null } = {}) {
  const body = `
    <h2>Quick add food</h2>
    <label class="field-label" for="q-name">Name</label>
    <input class="text-input" id="q-name" style="margin-bottom:12px;" value="${escapeHtml(prefillName)}">
    <label class="field-label" for="q-unit">Measured in</label>
    <select class="text-input" id="q-unit" style="margin-bottom:12px;">
      <option value="g">grams — solid food</option>
      <option value="ml">millilitres — drinks</option>
    </select>
    <label class="field-label" for="q-kcal"><span data-unit-word>Calories per 100 g</span></label>
    <input class="text-input" id="q-kcal" type="number" inputmode="numeric" style="margin-bottom:12px;">
    <label class="field-label" for="q-protein"><span data-unit-word>Protein per 100 g</span></label>
    <input class="text-input" id="q-protein" type="number" inputmode="decimal" style="margin-bottom:12px;">
    <label class="field-label" for="q-portion"><span data-unit-word>Usual portion (g)</span></label>
    <input class="text-input" id="q-portion" type="number" inputmode="numeric" style="margin-bottom:12px;" value="100">
    <label class="field-label" for="q-source">Source</label>
    <select class="text-input" id="q-source" style="margin-bottom:12px;">
      <option value="label">label — from packaging</option>
      <option value="reference">reference — published table</option>
      <option value="estimate">estimate — entered by hand</option>
    </select>
    <label class="field-label" for="q-cook-category">Cooking category (optional)</label>
    <select class="text-input" id="q-cook-category" style="margin-bottom:6px;">
      <option value="">No estimate</option>
      ${COOK_CATEGORIES.map(c => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join('')}
    </select>
    <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:12px;">
      Used to suggest this recipe's cooked weight for you.
    </div>
    <div class="form-msg error" id="q-error" hidden></div>
    <div class="form-msg" id="q-warn" hidden style="color:var(--amber);"></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="q-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="q-save">Save &amp; select</button>
    </div>
  `;
  openModal(body);
  document.getElementById('q-cancel').addEventListener('click', closeModal);

  const qUnitSelect = document.getElementById('q-unit');
  const applyQuickUnitLabels = () => {
    const u = qUnitSelect.value;
    const words = [`Calories per 100 ${u}`, `Protein per 100 ${u}`, `Usual portion (${u})`];
    document.querySelectorAll('#modal-sheet [data-unit-word]').forEach((span, i) => { span.textContent = words[i]; });
  };
  qUnitSelect.addEventListener('change', applyQuickUnitLabels);

  let duplicateAcknowledged = false;
  document.getElementById('q-save').addEventListener('click', async () => {
    const num = v => (v === '' ? null : Number(v));
    const name = document.getElementById('q-name').value.trim();
    const errEl = document.getElementById('q-error');
    const warnEl = document.getElementById('q-warn');

    const similar = findSimilarFoods(name, cache.foods);
    if (similar.length && !duplicateAcknowledged) {
      warnEl.innerHTML = `You already have <strong>${escapeHtml(similar[0].name)}</strong>. Tap Save again to add this anyway.`;
      warnEl.hidden = false;
      duplicateAcknowledged = true;
      return;
    }

    const obj = {
      id: slugify(name),
      name,
      per100g: {
        kcal: num(document.getElementById('q-kcal').value),
        protein: num(document.getElementById('q-protein').value),
        carbs: null, fat: null, fibre: null,
      },
      defaultPortionG: num(document.getElementById('q-portion').value) ?? 100,
      source: document.getElementById('q-source').value,
      unit: qUnitSelect.value,
      tags: [],
      cookCategory: document.getElementById('q-cook-category').value || null,
    };
    const errors = validateFood(obj);
    if (errors.length) { errEl.textContent = errors.join(' '); errEl.hidden = false; return; }

    await db.put('foods', obj);
    await refreshCache();
    closeModal();
    if (onSaved) { onSaved(obj); return; }
    // Straight back into the log flow with the new food already selected.
    logState.query = '';
    logState.pickedId = obj.id;
    logState.grams = String(obj.defaultPortionG);
    renderLog();
    toast(`Added ${obj.name}`);
  });
}

function renderLogDraft() {
  const picked = pickedRecord();
  const kcalEl = document.getElementById('log-preview-kcal');
  const protEl = document.getElementById('log-preview-protein');
  const leftEl = document.getElementById('log-preview-left');
  const grams = parseInt(logState.grams, 10) || 0;

  let m = null;
  if (picked && grams) {
    try {
      m = logState.pickedKind === 'recipe'
        ? recipePortionMacros(picked, foodsById(), grams)
        : foodPortionMacros(picked, grams);
    } catch { m = null; }
  }

  if (!m) {
    kcalEl.textContent = '—';
    protEl.textContent = '—';
    leftEl.textContent = '—';
    return;
  }

  kcalEl.textContent = m.kcal;
  protEl.textContent = `${m.protein} g`;

  // "kcal left" = today's calorie target minus what's already logged today minus this draft.
  // Only meaningful when a target exists and we're logging for today, not backdating.
  const backdating = (logState.date ?? todayISO()) !== todayISO();
  const targetKcal = lastToday.target && lastToday.target.kcal;
  leftEl.textContent = (targetKcal && !backdating)
    ? fmt(targetKcal - lastToday.kcal - m.kcal)
    : '—';
}

document.getElementById('foodsearch').addEventListener('input', e => {
  logState.query = e.target.value;
  renderLogResults();
});

document.getElementById('grams-down').addEventListener('click', () => {
  const g = Math.max(10, (parseInt(logState.grams, 10) || 0) - 10);
  logState.grams = String(g);
  document.getElementById('gramsfield').value = logState.grams;
  renderLogDraft();
});
document.getElementById('grams-up').addEventListener('click', () => {
  const g = (parseInt(logState.grams, 10) || 0) + 10;
  logState.grams = String(g);
  document.getElementById('gramsfield').value = logState.grams;
  renderLogDraft();
});
document.getElementById('gramsfield').addEventListener('input', e => {
  logState.grams = e.target.value.replace(/[^0-9]/g, '').slice(0, 4);
  e.target.value = logState.grams;
  renderLogDraft();
});

document.getElementById('confirm-log-btn').addEventListener('click', async () => {
  const grams = parseInt(logState.grams, 10) || 0;
  if (!logState.pickedId || !grams) return;
  const isRecipe = logState.pickedKind === 'recipe';
  const today = todayISO();
  const date = logState.date ?? today;
  const loggedName = pickedRecord()?.name;
  await db.put('logEntries', {
    id: crypto.randomUUID(),
    date,
    foodId: isRecipe ? null : logState.pickedId,
    recipeId: isRecipe ? logState.pickedId : null,
    grams,
    meal: logState.meal ?? inferMeal(),
    loggedAt: new Date().toISOString(),
  });
  logState.query = ''; logState.pickedId = null; logState.pickedKind = null;
  logState.grams = ''; logState.meal = null;
  if (date === today) {
    logState.date = null;
    goTo('today');
  } else {
    // Backdating a missed day usually means several items at once — stay put with the same
    // date selected instead of sending them back to Today, which wouldn't show it anyway.
    toast(`Logged ${loggedName} to ${formatDateHeader(date)}`);
    renderLog();
  }
});

// ==================== FOODS ====================
let foodsTagFilter = 'All';
let foodsSourceFilter = 'All';
let foodsQuery = '';
let foodsSort = 'name';
let foodsIngredientsExpanded = false;
let foodsListExpanded = false;

// The library is browsed far less than it's searched — a long wall of every food on open buries
// the search box and the paste/copy actions. Show a handful, with a button to see the rest.
const FOODS_COLLAPSED_COUNT = 6;

const FOOD_SORT_LABELS = {
  name: 'Name A–Z', frequency: 'Most logged', kcal: 'Calories, high–low', protein: 'Protein, high–low',
};
const FOOD_SOURCES = ['All', 'label', 'reference', 'estimate'];

// Non-default filter/sort state — drives both the toolbar badge count and the summary chips.
function activeFoodFilters() {
  const out = [];
  if (foodsSort !== 'name') out.push({ label: FOOD_SORT_LABELS[foodsSort], clear: () => { foodsSort = 'name'; } });
  if (foodsSourceFilter !== 'All') out.push({ label: foodsSourceFilter, clear: () => { foodsSourceFilter = 'All'; } });
  if (foodsTagFilter !== 'All') out.push({ label: foodsTagFilter, clear: () => { foodsTagFilter = 'All'; } });
  return out;
}

function allTagsFromFoods() {
  const set = new Set();
  for (const f of cache.foods) for (const t of f.tags ?? []) set.add(t);
  return ['All', ...Array.from(set).sort()];
}

// Foods logged directly (in the frequency window used elsewhere for favourites) never count as
// ingredient-only, however many recipes also use them — this only hides foods that are purely
// recipe components.
function directlyLoggedFoodIds() {
  const set = new Set();
  for (const key of cache.foodFrequency.keys()) {
    if (key.startsWith('food:')) set.add(key.slice(5));
  }
  return set;
}

function renderFoodRow(f) {
  const per = `${f.per100g.kcal} kcal · ${f.per100g.protein} g / 100 ${unitOf(f)}`;
  const row = el(`
    <div class="food-row">
      <div class="main">
        <div class="name">${escapeHtml(f.name)}</div>
        <div class="meta"><span class="per">${per}</span>${sourceBadge(f.source)}</div>
      </div>
      <button type="button" class="food-row-act" aria-label="Edit ${escapeHtml(f.name)}">✎</button>
      <button type="button" class="food-row-act is-delete" aria-label="Delete ${escapeHtml(f.name)}">×</button>
    </div>
  `);
  row.querySelector('[aria-label^="Edit"]').addEventListener('click', () => openFoodModal(f));
  row.querySelector('[aria-label^="Delete"]').addEventListener('click', async () => {
    if (!confirm(`Delete "${f.name}"? This can't be undone.`)) return;
    await db.remove('foods', f.id);
    await refreshCache();
    renderFoods();
  });
  return row;
}

function renderFoodRows(list, rows, emptyMsg) {
  list.innerHTML = '';
  if (rows.length === 0) list.appendChild(el(`<div class="empty-state">${escapeHtml(emptyMsg)}</div>`));
  for (const f of rows) list.appendChild(renderFoodRow(f));
}

// ==================== LIBRARY (Foods / Recipes / Bundles) ====================
let libraryMode = 'foods';

function renderLibrary() {
  document.querySelectorAll('#library-mode-chips .rd-chip').forEach(b => b.classList.toggle('active', b.dataset.mode === libraryMode));
  document.getElementById('library-foods-panel').hidden = libraryMode !== 'foods';
  document.getElementById('library-recipes-panel').hidden = libraryMode !== 'recipes';
  document.getElementById('library-bundles-panel').hidden = libraryMode !== 'bundles';
  document.getElementById('library-foods-claude').hidden = libraryMode !== 'foods';

  const online = navigator.onLine;
  const badge = document.getElementById('library-sync-badge');
  badge.className = `badge ${online ? 'badge-synced' : 'badge-offline'}`;
  badge.textContent = online ? '⟳ synced' : '⊘ offline';

  if (libraryMode === 'foods') renderFoods();
  else if (libraryMode === 'recipes') renderRecipes();
  else renderBundles();
}

document.getElementById('library-mode-chips').addEventListener('click', e => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  libraryMode = btn.dataset.mode;
  renderLibrary();
});

document.querySelectorAll('.library-add-btn').forEach(btn => btn.addEventListener('click', () => {
  if (btn.dataset.add === 'foods') openFoodModal(null);
  else if (btn.dataset.add === 'recipes') openRecipeModal(null);
  else openBundleModal(null);
}));

function renderFoods() {
  const filters = activeFoodFilters();
  const filterBtn = document.getElementById('foods-filter-btn');
  document.getElementById('foods-filter-label').textContent = filters.length ? `Sort · ${filters.length}` : 'Sort';
  filterBtn.classList.toggle('active', filters.length > 0);

  const summary = document.getElementById('foods-active-filters');
  summary.innerHTML = '';
  summary.hidden = filters.length === 0;
  for (const f of filters) {
    const chip = el(`<button type="button" class="active-filter-chip">${escapeHtml(f.label)} <span aria-hidden="true">✕</span></button>`);
    chip.setAttribute('aria-label', `Clear filter: ${f.label}`);
    chip.addEventListener('click', () => { f.clear(); renderFoods(); });
    summary.appendChild(chip);
  }

  const q = foodsQuery.trim().toLowerCase();
  const filtered = cache.foods.filter(f => (foodsTagFilter === 'All' || (f.tags ?? []).includes(foodsTagFilter))
    && (foodsSourceFilter === 'All' || f.source === foodsSourceFilter)
    && (!q || f.name.toLowerCase().includes(q)));
  const sorted = sortFoods(filtered, foodsSort, id => frequencyOf('food', id));
  const { foods: mainRows, ingredients: ingredientRows } = splitFoodLibrary(sorted, cache.recipes, directlyLoggedFoodIds());

  // A search or an active filter means the user is after something specific — show every match
  // rather than hiding some behind the button. Otherwise cap the list until they ask for all.
  const narrowed = q !== '' || filters.length > 0;
  const canCollapse = !narrowed && mainRows.length > FOODS_COLLAPSED_COUNT;
  const visibleRows = (canCollapse && !foodsListExpanded) ? mainRows.slice(0, FOODS_COLLAPSED_COUNT) : mainRows;

  renderFoodRows(document.getElementById('foods-list'), visibleRows, 'No foods yet. Add one, or paste from Claude.');

  const listToggle = document.getElementById('foods-list-toggle');
  listToggle.hidden = !canCollapse;
  listToggle.innerHTML = foodsListExpanded
    ? 'Show fewer <span aria-hidden="true">▴</span>'
    : `Show all foods (${mainRows.length}) <span aria-hidden="true">▾</span>`;

  const toggleBtn = document.getElementById('foods-ingredients-toggle');
  const ingList = document.getElementById('foods-ingredients-list');
  toggleBtn.hidden = ingredientRows.length === 0;
  toggleBtn.innerHTML = `Recipe ingredients (${ingredientRows.length}) <span aria-hidden="true">${foodsIngredientsExpanded ? '▴' : '▾'}</span>`;
  ingList.hidden = !foodsIngredientsExpanded;
  if (foodsIngredientsExpanded) renderFoodRows(ingList, ingredientRows, 'No ingredient-only foods.');
}

document.getElementById('foods-search').addEventListener('input', e => { foodsQuery = e.target.value; renderFoods(); });
document.getElementById('foods-filter-btn').addEventListener('click', openFoodsFilterSheet);
document.getElementById('foods-ingredients-toggle').addEventListener('click', () => {
  foodsIngredientsExpanded = !foodsIngredientsExpanded;
  renderFoods();
});
document.getElementById('foods-list-toggle').addEventListener('click', () => {
  foodsListExpanded = !foodsListExpanded;
  renderFoods();
});

// One sheet for every way the list can be narrowed or reordered — keeps the page itself down to
// a search box and a single button. Taps apply live (the list re-renders behind the sheet);
// Done just closes it.
function openFoodsFilterSheet() {
  const chipRow = (group, values, labelOf, current) => `
    <div class="tag-chips filter-chips" data-group="${group}">
      ${values.map(v => `<button type="button" class="tag-chip${v === current ? ' active' : ''}" data-value="${escapeHtml(v)}">${escapeHtml(labelOf(v))}</button>`).join('')}
    </div>`;
  const tags = allTagsFromFoods();
  const body = `
    <h2>Filter &amp; sort</h2>
    <div class="section-label" style="margin-bottom:8px;">Sort by</div>
    ${chipRow('sort', FOOD_SORTS, v => FOOD_SORT_LABELS[v], foodsSort)}
    <div class="section-label" style="margin:16px 0 8px;">Source</div>
    ${chipRow('source', FOOD_SOURCES, v => v, foodsSourceFilter)}
    ${tags.length > 1 ? `<div class="section-label" style="margin:16px 0 8px;">Tag</div>${chipRow('tag', tags, v => v, foodsTagFilter)}` : ''}
    <div class="modal-actions" style="margin-top:20px;">
      <button type="button" class="secondary-btn" id="foods-filter-reset">Reset</button>
      <button type="button" class="primary-btn" id="foods-filter-done">Done</button>
    </div>
  `;
  openModal(body);

  document.querySelectorAll('#modal-sheet .filter-chips').forEach(row => {
    row.addEventListener('click', e => {
      const btn = e.target.closest('button[data-value]');
      if (!btn) return;
      const value = btn.dataset.value;
      if (row.dataset.group === 'sort') foodsSort = value;
      else if (row.dataset.group === 'source') foodsSourceFilter = value;
      else foodsTagFilter = value;
      row.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      renderFoods();
    });
  });

  document.getElementById('foods-filter-reset').addEventListener('click', () => {
    foodsSort = 'name'; foodsSourceFilter = 'All'; foodsTagFilter = 'All';
    document.querySelectorAll('#modal-sheet .filter-chips').forEach(row => {
      row.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.value === (
        row.dataset.group === 'sort' ? 'name' : 'All'
      )));
    });
    renderFoods();
  });
  document.getElementById('foods-filter-done').addEventListener('click', closeModal);
}

function openFoodModal(food) {
  const isEdit = !!food;
  const body = `
    <h2>${isEdit ? 'Edit food' : 'Add food'}</h2>
    <label class="field-label" for="f-name">Name</label>
    <input class="text-input" id="f-name" style="margin-bottom:12px;" value="${isEdit ? escapeHtml(food.name) : ''}">
    <label class="field-label" for="f-unit">Measured in</label>
    <select class="text-input" id="f-unit" style="margin-bottom:12px;">
      <option value="g" ${!isEdit || unitOf(food) === 'g' ? 'selected' : ''}>grams — solid food</option>
      <option value="ml" ${isEdit && unitOf(food) === 'ml' ? 'selected' : ''}>millilitres — drinks</option>
    </select>
    <label class="field-label" for="f-kcal"><span data-unit-word>Calories per 100 g</span></label>
    <input class="text-input" id="f-kcal" type="number" style="margin-bottom:12px;" value="${isEdit ? food.per100g.kcal : ''}">
    <label class="field-label" for="f-protein"><span data-unit-word>Protein per 100 g</span></label>
    <input class="text-input" id="f-protein" type="number" style="margin-bottom:12px;" value="${isEdit ? food.per100g.protein : ''}">
    <label class="field-label" for="f-carbs"><span data-unit-word>Carbs per 100 g (optional)</span></label>
    <input class="text-input" id="f-carbs" type="number" style="margin-bottom:12px;" value="${isEdit && food.per100g.carbs != null ? food.per100g.carbs : ''}">
    <label class="field-label" for="f-fat"><span data-unit-word>Fat per 100 g (optional)</span></label>
    <input class="text-input" id="f-fat" type="number" style="margin-bottom:12px;" value="${isEdit && food.per100g.fat != null ? food.per100g.fat : ''}">
    <label class="field-label" for="f-fibre"><span data-unit-word>Fibre per 100 g (optional)</span></label>
    <input class="text-input" id="f-fibre" type="number" style="margin-bottom:12px;" value="${isEdit && food.per100g.fibre != null ? food.per100g.fibre : ''}">
    <label class="field-label" for="f-portion"><span data-unit-word>Default portion (g)</span></label>
    <input class="text-input" id="f-portion" type="number" style="margin-bottom:12px;" value="${isEdit ? food.defaultPortionG : 100}">
    <label class="field-label" for="f-source">Source</label>
    <select class="text-input" id="f-source" style="margin-bottom:12px;">
      <option value="label" ${isEdit && food.source === 'label' ? 'selected' : ''}>label — from packaging</option>
      <option value="reference" ${isEdit && food.source === 'reference' ? 'selected' : ''}>reference — published table</option>
      <option value="estimate" ${isEdit && food.source === 'estimate' ? 'selected' : ''}>estimate — entered by hand</option>
    </select>
    <label class="field-label" for="f-tags">Tags (comma separated)</label>
    <input class="text-input" id="f-tags" style="margin-bottom:12px;" value="${isEdit ? escapeHtml((food.tags ?? []).join(', ')) : ''}">
    <label class="field-label" for="f-cook-category">Cooking category (optional)</label>
    <select class="text-input" id="f-cook-category" style="margin-bottom:6px;">
      <option value="">No estimate</option>
      ${COOK_CATEGORIES.map(c => `<option value="${c.id}" ${isEdit && food.cookCategory === c.id ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}
    </select>
    <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:12px;">
      Used only to suggest a starting cooked weight when this food goes into a recipe.
    </div>
    <div class="form-msg error" id="f-error" hidden></div>
    <div class="form-msg" id="f-warn" hidden style="color:var(--amber);"></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="f-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="f-save">Save</button>
    </div>
  `;
  openModal(body);
  document.getElementById('f-cancel').addEventListener('click', closeModal);

  const fUnitSelect = document.getElementById('f-unit');
  const applyFoodUnitLabels = () => {
    const u = fUnitSelect.value;
    const words = [
      `Calories per 100 ${u}`, `Protein per 100 ${u}`, `Carbs per 100 ${u} (optional)`,
      `Fat per 100 ${u} (optional)`, `Fibre per 100 ${u} (optional)`, `Default portion (${u})`,
    ];
    document.querySelectorAll('#modal-sheet [data-unit-word]').forEach((span, i) => { span.textContent = words[i]; });
  };
  fUnitSelect.addEventListener('change', applyFoodUnitLabels);
  applyFoodUnitLabels();

  let duplicateAcknowledged = false;
  document.getElementById('f-save').addEventListener('click', async () => {
    const num = v => (v === '' ? null : Number(v));
    const enteredName = document.getElementById('f-name').value.trim();

    const similar = findSimilarFoods(enteredName, cache.foods, { excludeId: isEdit ? food.id : null });
    if (similar.length && !duplicateAcknowledged) {
      const warnEl = document.getElementById('f-warn');
      warnEl.innerHTML = `You already have <strong>${escapeHtml(similar[0].name)}</strong>. Tap Save again to add this anyway.`;
      warnEl.hidden = false;
      duplicateAcknowledged = true;
      return;
    }

    const obj = {
      id: isEdit ? food.id : slugify(enteredName),
      name: enteredName,
      per100g: {
        kcal: num(document.getElementById('f-kcal').value),
        protein: num(document.getElementById('f-protein').value),
        carbs: num(document.getElementById('f-carbs').value),
        fat: num(document.getElementById('f-fat').value),
        fibre: num(document.getElementById('f-fibre').value),
      },
      defaultPortionG: num(document.getElementById('f-portion').value) ?? 100,
      source: document.getElementById('f-source').value,
      unit: fUnitSelect.value,
      tags: document.getElementById('f-tags').value.split(',').map(t => t.trim()).filter(Boolean),
      cookCategory: document.getElementById('f-cook-category').value || null,
    };
    const errors = validateFood(obj);
    const errEl = document.getElementById('f-error');
    if (errors.length) {
      errEl.textContent = errors.join(' '); errEl.hidden = false;
      return;
    }
    await db.put('foods', obj);
    await refreshCache();
    closeModal();
    renderFoods();
  });
}

function slugify(name) {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'food';
  return `${base}-${Date.now().toString(36)}`;
}

document.getElementById('copy-library-btn').addEventListener('click', async () => {
  const text = await exportLibraryForClaude();
  const ok = await copyText(text);
  toast(ok ? 'Copied your food list' : 'Could not copy — check clipboard permission');
});

document.getElementById('paste-import-btn').addEventListener('click', () => {
  const body = `
    <h2>Paste from Claude</h2>
    <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0;">Paste the JSON block Claude gave you.</p>
    <button type="button" class="secondary-btn" id="import-clipboard" style="margin-bottom:10px;">Paste from clipboard</button>
    <textarea id="import-text" placeholder="[ { &quot;id&quot;: ... } ]"></textarea>
    <div class="form-msg error" id="import-msg" hidden></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="import-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="import-review">Review</button>
    </div>
  `;
  openModal(body);
  document.getElementById('import-cancel').addEventListener('click', closeModal);

  document.getElementById('import-clipboard').addEventListener('click', async () => {
    const msgEl = document.getElementById('import-msg');
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        msgEl.textContent = 'Your clipboard looks empty.';
        msgEl.hidden = false;
        return;
      }
      document.getElementById('import-text').value = text;
      msgEl.hidden = true;
      reviewImport();
    } catch {
      // Safari can refuse without a fresh user gesture, or the permission can be denied.
      msgEl.textContent = 'Couldn’t read the clipboard — paste into the box below instead.';
      msgEl.hidden = false;
    }
  });

  document.getElementById('import-review').addEventListener('click', reviewImport);
});

async function reviewImport() {
  const text = document.getElementById('import-text').value;
  const msgEl = document.getElementById('import-msg');
  try {
    const plan = await prepareImport(text);
    openImportPreview(plan);
  } catch (err) {
    msgEl.textContent = err instanceof ImportError ? err.message : 'Import failed.';
    msgEl.hidden = false;
  }
}

// A collision is no longer fatal to the whole paste — each clashing item becomes a choice.
function openImportPreview(plan) {
  const summary = plan.conflictCount === 0
    ? `${plan.newCount} new item${plan.newCount === 1 ? '' : 's'} to add.`
    : `${plan.newCount} new, ${plan.conflictCount} already in your library.`;

  const rowsHtml = plan.items.map((it, i) => {
    const macros = it.kind === 'food'
      ? `${it.obj.per100g.kcal} kcal · ${it.obj.per100g.protein} g /100${unitOf(it.obj)}`
      : `${it.obj.ingredients.length} ingredient${it.obj.ingredients.length === 1 ? '' : 's'} · ${it.obj.portions} portions`;
    const control = it.conflict
      ? `<select class="text-input" data-import-action="${i}" style="width:auto; height:40px; padding:0 8px; font-size:0.8125rem;">
           <option value="skip">Skip</option>
           <option value="replace">Replace</option>
         </select>`
      : `<span class="source-badge" style="border:1px solid var(--teal-tint-border); background:var(--teal-badge-bg);">
           <span class="word" style="color:var(--teal);">new</span>
         </span>`;
    return `
      <div class="food-row">
        <div class="main">
          <div class="name">${escapeHtml(it.obj.name)}</div>
          <div class="per100">${it.kind} · ${macros}</div>
        </div>
        ${control}
      </div>
    `;
  }).join('');

  openModal(`
    <h2>Review import</h2>
    <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0;">${summary}</p>
    <div class="entry-list">${rowsHtml}</div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="ip-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="ip-confirm">Import</button>
    </div>
  `);

  document.querySelectorAll('[data-import-action]').forEach(sel => {
    sel.addEventListener('change', () => {
      plan.items[Number(sel.dataset.importAction)].action = sel.value;
    });
  });

  document.getElementById('ip-cancel').addEventListener('click', closeModal);
  document.getElementById('ip-confirm').addEventListener('click', async () => {
    const result = await commitImport(plan.items);
    await refreshCache();
    closeModal();
    const parts = [];
    if (result.added) parts.push(`${result.added} added`);
    if (result.replaced) parts.push(`${result.replaced} replaced`);
    if (result.skipped) parts.push(`${result.skipped} skipped`);
    toast(parts.join(', ') || 'Nothing imported');
    renderFoods();
    renderRecipes();
  });
}

// ==================== RECIPES ====================
function renderRecipes() {
  const list = document.getElementById('recipes-list');
  list.innerHTML = '';
  if (cache.recipes.length === 0) {
    list.appendChild(el(`<div class="empty-state">No recipes yet. Build one from foods you already have.</div>`));
    return;
  }
  const fMap = foodsById();
  for (const r of cache.recipes) {
    const draft = isDraftRecipe(r);
    let perGram = null;
    let broken = false;
    if (!draft) {
      try { perGram = recipePerGram(r, fMap); } catch { broken = true; }
    }

    if (broken) {
      const missing = (r.ingredients || []).map(i => i.foodId).filter(id => !fMap.has(id));
      const card = el(`
        <div class="lib-card is-broken">
          <div class="lib-card-fix">
            <div>
              <div class="lib-card-title">${escapeHtml(r.name)}</div>
              <div class="lib-card-warn">⚠ ingredient ${missing.length ? `"${escapeHtml(missing[0])}"` : ''} is missing</div>
            </div>
            <button type="button" class="rd-link" data-edit-recipe="${r.id}">Fix</button>
          </div>
        </div>
      `);
      list.appendChild(card);
      continue;
    }

    const portionG = draft ? null : onePortionGrams(r);
    const portionKcal = perGram ? Math.round(perGram.kcal * (r.cookedWeightG / r.portions)) : null;
    const portionProt = perGram ? Math.round(perGram.protein * (r.cookedWeightG / r.portions)) : null;

    const card = el(`
      <div class="lib-card">
        <div class="lib-card-body">
          <div class="lib-card-top">
            <div>
              <div class="lib-card-title">${escapeHtml(r.name)}</div>
              <div class="lib-card-sub">${draft
                ? `${(r.ingredients || []).length} ingredients · cooked weight not entered`
                : `cooked ${fmt(r.cookedWeightG)} g · ${r.portions} portions of ${portionG} g`}</div>
            </div>
            <span class="badge ${draft ? 'badge-draft' : 'badge-recipe'}">${draft ? '⌛ draft' : '▤ recipe'}</span>
          </div>
          ${draft
            ? '<div class="lib-card-note">Weigh the batch to unlock per-portion macros. Logging is locked until then.</div>'
            : `<div class="lib-card-figs">
                 <div><div>${fmt(portionKcal)}</div><div>kcal / portion</div></div>
                 <div><div>${portionProt} g</div><div>protein</div></div>
               </div>`}
        </div>
        <div class="lib-card-actions">
          <button type="button" class="rd-btn-primary" data-log-recipe="${r.id}" ${draft ? 'disabled' : ''}>${draft ? '🔒 Log a portion' : 'Log a portion'}</button>
          ${draft
            ? `<button type="button" class="rd-btn-secondary" data-edit-recipe="${r.id}">Add weight</button>`
            : `<button type="button" class="rd-btn-secondary" data-cook-again="${r.id}">Cook again</button>
               <button type="button" class="rd-icon-btn" data-edit-recipe="${r.id}" aria-label="Edit ${escapeHtml(r.name)}">✎</button>
               <button type="button" class="rd-icon-btn is-danger" data-delete-recipe="${r.id}" aria-label="Delete ${escapeHtml(r.name)}">×</button>`}
        </div>
      </div>
    `);
    list.appendChild(card);
  }
  list.querySelectorAll('[data-log-recipe]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const recipe = recipesById().get(btn.dataset.logRecipe);
      if (!recipe || isDraftRecipe(recipe)) return;
      const grams = Math.round(recipe.cookedWeightG / recipe.portions);
      await db.put('logEntries', {
        id: crypto.randomUUID(), date: todayISO(), foodId: null, recipeId: recipe.id, grams,
        meal: inferMeal(), loggedAt: new Date().toISOString(),
      });
      goTo('today');
    });
  });
  list.querySelectorAll('[data-cook-again]').forEach(btn => {
    btn.addEventListener('click', () => {
      const recipe = recipesById().get(btn.dataset.cookAgain);
      if (recipe) openRecipeModal(null, { copyFrom: recipe });
    });
  });
  list.querySelectorAll('[data-edit-recipe]').forEach(btn => {
    btn.addEventListener('click', () => {
      const r = recipesById().get(btn.dataset.editRecipe);
      if (r) openRecipeModal(r);
    });
  });
  list.querySelectorAll('[data-delete-recipe]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const r = recipesById().get(btn.dataset.deleteRecipe);
      if (!r) return;
      if (!confirm(`Delete "${r.name}"? This can't be undone.`)) return;
      await db.remove('recipes', r.id);
      await refreshCache();
      renderRecipes();
    });
  });
}

async function openRecipeModal(recipe, { copyFrom = null, restore = null } = {}) {
  const isEdit = !!recipe;
  const template = recipe ?? copyFrom;
  const ingredients = restore
    ? restore.rows.map(i => ({ ...i }))
    : (template ? template.ingredients.map(i => ({ ...i })) : [{ foodId: '', grams: '' }]);

  // Editing a recipe recomputes every portion ever logged from it, so a Sunday batch cooked
  // with different weights must not be recorded by editing last week's recipe.
  let loggedCount = 0;
  if (isEdit) {
    const allEntries = await db.getAll('logEntries');
    loggedCount = allEntries.filter(e => e.recipeId === recipe.id).length;
  }

  function ingredientRowHtml(ing, i) {
    const options = cache.foods.map(f => `<option value="${f.id}" ${ing.foodId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('');
    const chosen = ing.foodId ? cache.foods.find(f => f.id === ing.foodId) : null;
    const placeholder = chosen && unitOf(chosen) === 'ml' ? 'ml (raw)' : 'grams (raw)';
    return `
      <div style="display:flex; gap:8px; margin-bottom:8px;" data-ing-row="${i}">
        <select class="text-input" data-ing-food style="flex:2;"><option value="">Select food…</option>${options}</select>
        <input class="text-input" data-ing-grams type="number" placeholder="${placeholder}" aria-label="Amount of ingredient ${i + 1}" style="flex:1;" value="${ing.grams || ''}">
        <button type="button" class="icon-btn-small" data-remove-ing aria-label="Remove ingredient">×</button>
      </div>
    `;
  }

  const titleText = isEdit ? 'Edit recipe' : (copyFrom ? 'Cook this again' : 'Build a recipe');
  const defaultName = restore
    ? restore.name
    : (copyFrom
      ? `${copyFrom.name} — ${formatDateHeader(todayISO()).replace(/^\w+\s/, '')}`
      : (isEdit ? recipe.name : ''));

  const editWarning = isEdit && loggedCount > 0
    ? `<div class="form-msg" style="color:var(--amber); margin:0 0 12px;">
         This recipe has ${loggedCount} portion${loggedCount === 1 ? '' : 's'} already logged. Changing
         the weights here also changes what those past meals say you ate. For a new batch, close this
         and use “Cook this again” instead.
       </div>`
    : '';

  const copyNote = copyFrom
    ? `<div class="form-msg" style="color:var(--text-secondary); margin:0 0 12px;">
         Copied from “${escapeHtml(copyFrom.name)}”. Adjust the weights for this batch — past meals stay untouched.
       </div>`
    : '';

  // A saved, actually-weighed cooked weight is never silently overwritten by the estimate —
  // only a draft, or a weight that was itself only ever an estimate, keeps auto-updating as
  // ingredients change. This is what lets a recipe be built (and logged from) without ever
  // having to weigh the batch first — see "Shrinkage-factor estimate" in COOK_CATEGORIES.
  let cookedManuallyEdited = restore
    ? !!restore.cookedManuallyEdited
    : (isEdit && recipe.cookedWeightG != null && recipe.cookedWeightEstimated !== true);
  let initialCooked = restore ? restore.cooked : (isEdit && recipe.cookedWeightG != null ? recipe.cookedWeightG : '');
  if (!cookedManuallyEdited && initialCooked === '') {
    const est = estimateCookedWeightG(
      ingredients.filter(r => r.foodId && r.grams).map(r => ({ foodId: r.foodId, grams: Number(r.grams) })),
      foodsById(),
    );
    if (est != null) initialCooked = est;
  }

  const body = `
    <h2>${titleText}</h2>
    ${editWarning}${copyNote}
    <label class="field-label" for="r-name">Name</label>
    <input class="text-input" id="r-name" style="margin-bottom:12px;" value="${escapeHtml(defaultName)}">
    <div class="field-label" style="margin-bottom:8px;">Raw ingredients</div>
    <div id="r-ingredients">${ingredients.map(ingredientRowHtml).join('')}</div>
    <div style="display:flex; gap:8px; margin-bottom:14px;">
      <button type="button" class="secondary-btn" id="r-add-ing" style="text-align:center;">Add ingredient</button>
      <button type="button" class="secondary-btn" id="r-new-food" style="text-align:center;">New food</button>
    </div>
    <label class="field-label" for="r-cooked">Cooked / finished batch weight (g)</label>
    <input class="text-input" id="r-cooked" type="number" inputmode="numeric" style="margin-bottom:6px;" value="${escapeHtml(String(initialCooked))}">
    <div id="r-cooked-hint" style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:12px;"></div>
    <label class="field-label" for="r-portions">Portions</label>
    <input class="text-input" id="r-portions" type="number" inputmode="numeric" style="margin-bottom:12px;" value="${restore ? escapeHtml(restore.portions) : (template ? template.portions : '')}">
    <div class="form-msg error" id="r-error" hidden></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="r-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="r-save">Save</button>
    </div>
  `;
  openModal(body);

  let rows = ingredients.slice();

  function updateCookedHint() {
    const val = document.getElementById('r-cooked').value.trim();
    document.getElementById('r-cooked-hint').textContent = (val !== '' && !cookedManuallyEdited)
      ? 'Estimated from the ingredients — edit once you’ve weighed the real batch.'
      : 'Leave empty to save as a draft while the batch is still cooking. You can’t log portions until it’s filled in.';
  }
  updateCookedHint();

  function maybeAutoEstimateCooked() {
    if (cookedManuallyEdited) return;
    const estimate = estimateCookedWeightG(
      rows.filter(r => r.foodId && r.grams).map(r => ({ foodId: r.foodId, grams: Number(r.grams) })),
      foodsById(),
    );
    if (estimate != null) document.getElementById('r-cooked').value = estimate;
    updateCookedHint();
  }

  document.getElementById('r-cooked').addEventListener('input', () => {
    cookedManuallyEdited = true;
    updateCookedHint();
  });

  function rerenderIngredients() {
    document.getElementById('r-ingredients').innerHTML = rows.map(ingredientRowHtml).join('');
    wireIngredientRows();
    maybeAutoEstimateCooked();
  }

  function wireIngredientRows() {
    document.querySelectorAll('[data-ing-food]').forEach((sel, i) => sel.addEventListener('change', () => {
      rows[i].foodId = sel.value;
      // Re-render so the amount placeholder switches to ml when a drink is chosen.
      rerenderIngredients();
    }));
    document.querySelectorAll('[data-ing-grams]').forEach((inp, i) => inp.addEventListener('input', () => {
      rows[i].grams = inp.value;
      maybeAutoEstimateCooked();
    }));
    document.querySelectorAll('[data-remove-ing]').forEach((btn, i) => btn.addEventListener('click', () => {
      rows.splice(i, 1);
      if (rows.length === 0) rows.push({ foodId: '', grams: '' });
      rerenderIngredients();
    }));
  }
  wireIngredientRows();

  document.getElementById('r-add-ing').addEventListener('click', () => {
    rows.push({ foodId: '', grams: '' });
    rerenderIngredients();
  });

  // Adding a missing ingredient shouldn't cost you the recipe you're halfway through typing:
  // snapshot the form, create the food, then rebuild this sheet exactly as it was.
  document.getElementById('r-new-food').addEventListener('click', () => {
    const snapshot = {
      name: document.getElementById('r-name').value,
      cooked: document.getElementById('r-cooked').value,
      cookedManuallyEdited,
      portions: document.getElementById('r-portions').value,
      rows: rows.map(r => ({ ...r })),
    };
    openQuickAddFoodModal('', {
      onSaved: async food => {
        const emptyRow = snapshot.rows.find(r => !r.foodId);
        if (emptyRow) emptyRow.foodId = food.id;
        else snapshot.rows.push({ foodId: food.id, grams: '' });
        await openRecipeModal(recipe, { copyFrom, restore: snapshot });
        toast(`Added ${food.name}`);
      },
    });
  });

  document.getElementById('r-cancel').addEventListener('click', closeModal);
  document.getElementById('r-save').addEventListener('click', async () => {
    const cookedRaw = document.getElementById('r-cooked').value.trim();
    const obj = {
      id: isEdit ? recipe.id : slugify(document.getElementById('r-name').value),
      name: document.getElementById('r-name').value.trim(),
      ingredients: rows.filter(r => r.foodId).map(r => ({ foodId: r.foodId, grams: Number(r.grams) })),
      cookedWeightG: cookedRaw === '' ? null : Number(cookedRaw),
      cookedWeightEstimated: cookedRaw !== '' && !cookedManuallyEdited,
      portions: Number(document.getElementById('r-portions').value),
    };
    const errors = validateRecipe(obj, { allowDraft: true });
    const errEl = document.getElementById('r-error');
    if (errors.length) { errEl.textContent = errors.join(' '); errEl.hidden = false; return; }
    await db.put('recipes', obj);
    await refreshCache();
    closeModal();
    renderRecipes();
    if (isDraftRecipe(obj)) toast('Saved as draft — add the cooked weight when you weigh it');
  });
}

// ==================== BUNDLES ====================
// A bundle groups foods/recipes you always log together (a usual breakfast) so the whole group
// can be added in one tap. See bundleToLogEntries/logBundle — logging one just writes several
// ordinary logEntries, so nothing downstream needs to know bundles exist.
function renderBundles() {
  const list = document.getElementById('bundles-list');
  list.innerHTML = '';
  if (cache.bundles.length === 0) {
    list.appendChild(el(`<div class="empty-state">No bundles yet. Group foods you always have together — like a usual breakfast — to log them all in one tap.</div>`));
    return;
  }
  const fMap = foodsById(), rMap = recipesById();
  const mealLabel = MEAL_LABELS[inferMeal()];
  for (const b of cache.bundles) {
    const macros = bundleMacros(b, fMap, rMap);
    const itemRows = b.items.map(item => {
      const m = bundleItemMacros(item, fMap, rMap);
      const name = m ? `${escapeHtml(m.name)} · ${item.grams} ${m.unit}` : 'missing item';
      return `<div><div>${name}</div><div class="k">${m ? m.kcal : '—'}</div></div>`;
    }).join('');
    const card = el(`
      <div class="lib-card">
        <div class="lib-card-body">
          <div class="lib-card-top" style="align-items:baseline;">
            <div class="lib-card-title">${escapeHtml(b.name)}</div>
            <div class="lib-card-sub" style="margin:0;">${b.items.length} item${b.items.length === 1 ? '' : 's'}</div>
          </div>
          ${b.items.length <= 4 ? `<div class="lib-card-items">${itemRows}</div>` : ''}
          <div class="lib-card-figs">
            <div><div>${fmt(macros.kcal)}</div><div>kcal total</div></div>
            <div><div>${macros.protein} g</div><div>protein</div></div>
          </div>
        </div>
        <div class="lib-card-actions">
          <button type="button" class="rd-btn-primary" data-log-bundle="${b.id}">Log all to ${escapeHtml(mealLabel)}</button>
          <button type="button" class="rd-icon-btn" data-edit-bundle="${b.id}" aria-label="Edit ${escapeHtml(b.name)}">✎</button>
          <button type="button" class="rd-icon-btn is-danger" data-delete-bundle="${b.id}" aria-label="Delete ${escapeHtml(b.name)}">×</button>
        </div>
      </div>
    `);
    list.appendChild(card);
  }
  list.querySelectorAll('[data-log-bundle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const b = bundlesById().get(btn.dataset.logBundle);
      if (!b) return;
      await logBundle(b, inferMeal());
      toast(`Logged ${b.name}`);
      goTo('today');
    });
  });
  list.querySelectorAll('[data-edit-bundle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const b = bundlesById().get(btn.dataset.editBundle);
      if (b) openBundleModal(b);
    });
  });
  list.querySelectorAll('[data-delete-bundle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const b = bundlesById().get(btn.dataset.deleteBundle);
      if (!b) return;
      if (!confirm(`Delete "${b.name}"? This can't be undone.`)) return;
      await db.remove('bundles', b.id);
      await refreshCache();
      renderBundles();
    });
  });
}

// A full-screen-ish search sheet for picking one food or recipe — the library can run into
// the hundreds, so a plain <select> doesn't scale, and this reuses the same search-result
// list the Today quick-log sheet already uses. Calls back with { kind, id } on a pick, or
// null on Cancel.
function openBundleItemPicker(onPicked) {
  let query = '';

  function renderResults() {
    const q = query.trim().toLowerCase();
    const items = loggableItems()
      .filter(c => !q || c.record.name.toLowerCase().includes(q))
      .sort((a, b) => a.record.name.localeCompare(b.record.name))
      .slice(0, 50);
    const container = document.getElementById('bip-results');
    container.innerHTML = '';
    if (items.length === 0) {
      container.appendChild(el(`<div class="meal-empty">No match.</div>`));
      return;
    }
    for (const { kind, record } of items) {
      const meta = kind === 'recipe' ? 'recipe' : `${record.per100g.kcal} kcal /100${unitOf(record)}`;
      const btn = el(`
        <button type="button" class="search-result-btn">
          <span class="name">${escapeHtml(record.name)}</span>
          <span class="per100">${escapeHtml(meta)}</span>
        </button>
      `);
      // Picking bypasses closeModal (the next sheet opens straight over this one), so the
      // pending "resume on close" below must be cleared here or it would misfire later.
      btn.addEventListener('click', () => { pendingModalCancel = null; onPicked({ kind, id: record.id }); });
      container.appendChild(btn);
    }
  }

  openModal(`
    <h2>Choose a food or recipe</h2>
    <input class="text-input" id="bip-search" type="text" placeholder="Search foods and recipes" autocomplete="off" style="margin-bottom:6px;">
    <div class="search-results" id="bip-results"></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="bip-cancel">Cancel</button>
    </div>
  `);
  // Cancelling this sheet by any route (the button, a backdrop tap, or dragging it shut)
  // should resume the bundle builder rather than exit to the app underneath.
  pendingModalCancel = () => onPicked(null);
  document.getElementById('bip-search').addEventListener('input', e => { query = e.target.value; renderResults(); });
  document.getElementById('bip-cancel').addEventListener('click', closeModal);
  renderResults();
}

function openBundleModal(bundle, { restore = null } = {}) {
  const isEdit = !!bundle;
  let rows = restore ? restore.rows.map(r => ({ ...r }))
    : (isEdit ? bundle.items.map(i => ({ ...i })) : [{ kind: '', id: '', grams: '' }]);
  const initialName = restore ? restore.name : (isEdit ? bundle.name : '');

  function itemLabel(row) {
    const record = row.kind === 'food' ? foodsById().get(row.id) : (row.kind === 'recipe' ? recipesById().get(row.id) : null);
    return record ? record.name : 'Select food or recipe…';
  }

  function rowHtml(row, i) {
    const record = row.kind === 'food' ? foodsById().get(row.id) : (row.kind === 'recipe' ? recipesById().get(row.id) : null);
    const unit = record ? (row.kind === 'recipe' ? 'g' : unitOf(record)) : 'g';
    return `
      <div style="display:flex; gap:8px; margin-bottom:8px;" data-item-row="${i}">
        <button type="button" class="text-input item-picker-btn" data-item-picker="${i}" style="flex:2;">${escapeHtml(itemLabel(row))}</button>
        <input class="text-input" data-item-grams type="number" placeholder="${unit}" aria-label="Amount of item ${i + 1}" style="flex:1;" value="${row.grams || ''}">
        <button type="button" class="icon-btn-small" data-remove-item aria-label="Remove item">×</button>
      </div>
    `;
  }

  const body = `
    <h2>${isEdit ? 'Edit bundle' : 'New bundle'}</h2>
    <label class="field-label" for="bnd-name">Name</label>
    <input class="text-input" id="bnd-name" style="margin-bottom:12px;" value="${escapeHtml(initialName)}">
    <div class="field-label" style="margin-bottom:8px;">Items</div>
    <div id="bnd-items">${rows.map(rowHtml).join('')}</div>
    <button type="button" class="secondary-btn" id="bnd-add-item" style="text-align:center; margin-bottom:14px;">Add item</button>
    <div class="form-msg error" id="bnd-error" hidden></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="bnd-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="bnd-save">Save</button>
    </div>
  `;
  openModal(body);

  function rerenderItems() {
    document.getElementById('bnd-items').innerHTML = rows.map(rowHtml).join('');
    wireItemRows();
  }

  // Picking an item replaces the whole sheet with the full-screen picker, then rebuilds this
  // one from a snapshot once it returns — same restore pattern the recipe builder uses for
  // "New food", since only one sheet can be on screen at a time.
  function wireItemRows() {
    document.querySelectorAll('[data-item-picker]').forEach((btn, i) => btn.addEventListener('click', () => {
      const snapshot = { name: document.getElementById('bnd-name').value, rows: rows.map(r => ({ ...r })) };
      openBundleItemPicker(picked => {
        if (picked) {
          snapshot.rows[i].kind = picked.kind;
          snapshot.rows[i].id = picked.id;
          snapshot.rows[i].grams = picked.kind === 'food'
            ? (foodsById().get(picked.id)?.defaultPortionG ?? 100)
            : onePortionGrams(recipesById().get(picked.id));
        }
        openBundleModal(bundle, { restore: snapshot });
      });
    }));
    document.querySelectorAll('[data-item-grams]').forEach((inp, i) => inp.addEventListener('input', () => {
      rows[i].grams = inp.value;
    }));
    document.querySelectorAll('[data-remove-item]').forEach((btn, i) => btn.addEventListener('click', () => {
      rows.splice(i, 1);
      if (rows.length === 0) rows.push({ kind: '', id: '', grams: '' });
      rerenderItems();
    }));
  }
  wireItemRows();

  document.getElementById('bnd-add-item').addEventListener('click', () => {
    rows.push({ kind: '', id: '', grams: '' });
    rerenderItems();
  });
  document.getElementById('bnd-cancel').addEventListener('click', closeModal);

  document.getElementById('bnd-save').addEventListener('click', async () => {
    const obj = {
      id: isEdit ? bundle.id : slugify(document.getElementById('bnd-name').value.trim() || 'bundle'),
      name: document.getElementById('bnd-name').value.trim(),
      items: rows.filter(r => r.kind && r.id && r.grams).map(r => ({ kind: r.kind, id: r.id, grams: Number(r.grams) })),
    };
    const errors = validateBundle(obj);
    const errEl = document.getElementById('bnd-error');
    if (errors.length) { errEl.textContent = errors.join(' '); errEl.hidden = false; return; }
    await db.put('bundles', obj);
    await refreshCache();
    closeModal();
    renderBundles();
  });
}

// ==================== WORKOUTS ====================
// Week and session default to where the calendar actually is, so opening this at the gym
// shows today's numbers without touching anything. Both stay overridable.
const workoutState = { weekOverride: null, dayOverride: null };

function renderWorkouts() {
  const today = todayISO();
  const phase = activePhase(PHASES, today);
  if (!phase) return;

  const currentWeek = weekNumberFor(phase, today);
  const week = workoutState.weekOverride ?? currentWeek;
  const dayIndex = workoutState.dayOverride ?? defaultDayIndex(phase, today);
  const day = phase.days[dayIndex];

  document.getElementById('workout-phase-chip').textContent = phase.name;

  const weekChips = document.getElementById('workout-week-chips');
  weekChips.innerHTML = '';
  for (let w = 1; w <= phase.weeks; w++) {
    const isNow = w === currentWeek;
    const chip = el(`<button type="button" class="tag-chip">Week ${w}${isNow ? ' · now' : ''}</button>`);
    const active = w === week;
    chip.style.background = active ? 'var(--navy)' : 'var(--surface-raised)';
    chip.style.color = active ? 'var(--surface)' : 'var(--navy)';
    chip.style.borderColor = 'var(--navy)';
    chip.addEventListener('click', () => { workoutState.weekOverride = w; renderWorkouts(); });
    weekChips.appendChild(chip);
  }

  const dayChips = document.getElementById('workout-day-chips');
  dayChips.innerHTML = '';
  phase.days.forEach((d, i) => {
    const chip = el(`<button type="button" class="tag-chip">${escapeHtml(d.dayLabel)} — ${escapeHtml(d.label)}</button>`);
    const active = i === dayIndex;
    chip.style.background = active ? 'var(--teal)' : 'var(--surface-raised)';
    chip.style.color = active ? 'var(--surface)' : 'var(--teal)';
    chip.style.borderColor = 'var(--teal)';
    chip.addEventListener('click', () => { workoutState.dayOverride = i; renderWorkouts(); });
    dayChips.appendChild(chip);
  });

  const list = document.getElementById('workout-exercises');
  list.innerHTML = '';
  list.appendChild(el(`
    <div class="section-header-row">
      <div class="section-label">${escapeHtml(day.dayLabel)} · ${escapeHtml(day.label)}</div>
      <div class="totals">${day.exercises.length} exercises</div>
    </div>
  `));

  day.exercises.forEach((ex, i) => {
    const otherWeeks = Object.keys(ex.weeks)
      .map(Number)
      .filter(w => w !== week && w <= phase.weeks)
      .map(w => `<span class="other-week">W${w} ${escapeHtml(String(ex.weeks[w]))}</span>`)
      .join('');
    const imageHtml = ex.image
      ? `<img class="exercise-image" src="${escapeHtml(ex.image)}" alt="" loading="lazy">`
      : '';
    list.appendChild(el(`
      <article class="exercise-card">
        <div class="exercise-head">
          <span class="exercise-index">${i + 1}</span>
          <h3 class="exercise-name">${escapeHtml(ex.name)}</h3>
        </div>
        ${imageHtml}
        <div class="exercise-sets">
          <span class="sets-label">Week ${week}</span>
          <span class="sets-value">${escapeHtml(String(ex.weeks[week] ?? '—'))}</span>
        </div>
        <p class="exercise-instructions">${escapeHtml(ex.instructions)}</p>
        <div class="exercise-other-weeks">${otherWeeks}</div>
        ${ex.link ? `<a class="exercise-link" href="${escapeHtml(ex.link)}" target="_blank" rel="noopener noreferrer">How to do it — video guide ↗</a>` : ''}
      </article>
    `));
  });
}

// ==================== HISTORY ====================
function renderHistory() {
  document.getElementById('history-jump-date').max = todayISO();
  renderHistoryList();
}

async function renderHistoryList() {
  const to = isoDaysAgo(1); // yesterday — today lives on the Today screen
  const from = isoDaysAgo(14);
  const list = document.getElementById('history-list');
  showSectionLoading(list);
  const entries = await db.entriesInRange(from, to);
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const fMap = foodsById(), rMap = recipesById();
  const dates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));
  list.innerHTML = '';
  if (dates.length === 0) list.appendChild(el(`<div class="empty-state">No previous days logged yet.</div>`));
  for (const dateStr of dates) {
    const resolved = byDate.get(dateStr).map(e => entryMacros(e, fMap, rMap)).filter(Boolean);
    const kcalTotal = resolved.reduce((a, e) => a + e.kcal, 0);
    const protTotal = resolved.reduce((a, e) => a + e.protein, 0);
    const target = resolveTarget(cache.dayTargets, cache.overrides, dateStr, weekdayOf(dateStr));
    const kOver = target.kcal != null && kcalTotal > target.kcal;
    const pOver = target.protein != null && protTotal > target.protein;
    const over = kOver || pOver;
    const bg = over ? 'var(--red-tint-bg)' : 'var(--navy-tint-bg)';
    const border = over ? 'var(--red-tint-border)' : 'var(--navy-tint-border-2)';
    const color = over ? 'var(--red)' : 'var(--navy)';
    const diffColor = over ? 'var(--red-diff)' : 'var(--text-secondary)';
    const diffParts = [];
    if (target.kcal != null) diffParts.push(`${Math.abs(kcalTotal - target.kcal)} kcal ${kcalTotal > target.kcal ? 'over' : 'under'}`);
    if (target.protein != null) diffParts.push(`${Math.abs(protTotal - target.protein)} g ${protTotal > target.protein ? 'over' : 'under'}`);
    const card = el(`
      <button type="button" class="history-card" style="border:1px solid ${border}; background:${bg}; text-align:left; width:100%; cursor:pointer;">
        <div class="top-row">
          <div class="date">${formatDateHeader(dateStr)}</div>
          <div class="totals-wrap" style="color:${color};">
            <span>${over ? '▲' : '▼'}</span><span>${kcalTotal} kcal · ${protTotal} g</span>
          </div>
        </div>
        <div class="diff" style="color:${diffColor};">${diffParts.length ? diffParts.join(' · ') : 'no target set'}</div>
      </button>
    `);
    card.addEventListener('click', () => openDayDetailModal(dateStr));
    list.appendChild(card);
  }
}

document.getElementById('history-jump-date').addEventListener('change', e => {
  if (e.target.value) openDayDetailModal(e.target.value);
});

// Itemised, read-only breakdown of a single date — reachable from a History card or by picking
// a date directly, since the 14-day History list and Today's own screen otherwise leave no way
// to see what was actually logged on an arbitrary day.
async function openDayDetailModal(dateStr) {
  openModal(`<h2 style="margin-bottom:14px;">${escapeHtml(formatDateHeader(dateStr))}</h2><div id="dd-body"></div>`);
  const body = document.getElementById('dd-body');
  showSectionLoading(body);

  const entries = await db.entriesInRange(dateStr, dateStr);
  const resolved = resolveEntriesForDisplay(entries, foodsById(), recipesById());
  const kcalTotal = resolved.reduce((a, e) => a + e.kcal, 0);
  const protTotal = resolved.reduce((a, e) => a + e.protein, 0);
  const target = resolveTarget(cache.dayTargets, cache.overrides, dateStr, weekdayOf(dateStr));
  const targetText = target.kcal != null || target.protein != null
    ? ` · target ${target.kcal ?? '—'} kcal / ${target.protein ?? '—'} g`
    : '';

  // Bail out silently if the modal was closed while this was in flight.
  if (!document.getElementById('dd-body')) return;

  body.innerHTML = '';
  body.appendChild(el(`<div style="font-family:var(--font-mono); font-size:0.8125rem; color:var(--text-secondary); margin-bottom:10px;">${kcalTotal} kcal · ${protTotal} g${targetText}</div>`));
  const list = el(`<div class="entry-list"></div>`);
  body.appendChild(list);

  const { groups, unsorted } = groupEntriesByMeal(resolved);
  for (const meal of MEALS) {
    const entriesForMeal = groups.get(meal);
    if (entriesForMeal.length) list.appendChild(buildMealSection(meal, MEAL_LABELS[meal], entriesForMeal, { canAdd: false, interactive: false }));
  }
  if (unsorted.length) list.appendChild(buildMealSection(null, 'Not assigned', unsorted, { canAdd: false, interactive: false }));
  if (!resolved.length) list.appendChild(el(`<div class="empty-state">Nothing logged this day.</div>`));

  const actions = el(`
    <div class="modal-actions" style="margin-top:16px;">
      <button type="button" class="secondary-btn" id="dd-copy">Copy this day for Claude</button>
      <button type="button" class="primary-btn" id="dd-close">Close</button>
    </div>
  `);
  body.appendChild(actions);
  document.getElementById('dd-close').addEventListener('click', closeModal);
  document.getElementById('dd-copy').addEventListener('click', async () => {
    const text = await exportDay(dateStr);
    const ok = await copyText(text);
    toast(ok ? 'Copied that day' : 'Could not copy — check clipboard permission');
  });
}

document.getElementById('export-range-btn').addEventListener('click', () => {
  const body = `
    <h2>Copy a date range</h2>
    <label class="field-label" for="er-from">From</label>
    <input class="text-input" id="er-from" type="date" style="margin-bottom:12px;" value="${isoDaysAgo(7)}">
    <label class="field-label" for="er-to">To</label>
    <input class="text-input" id="er-to" type="date" style="margin-bottom:12px;" value="${isoDaysAgo(1)}">
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="er-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="er-confirm">Copy</button>
    </div>
  `;
  openModal(body);
  document.getElementById('er-cancel').addEventListener('click', closeModal);
  document.getElementById('er-confirm').addEventListener('click', async () => {
    const from = document.getElementById('er-from').value;
    const to = document.getElementById('er-to').value;
    if (!from || !to) return;
    const text = await exportRange(from, to);
    const ok = await copyText(text);
    closeModal();
    toast(ok ? 'Copied range' : 'Could not copy — check clipboard permission');
  });
});

// ==================== SETTINGS ====================
function renderSettings() {
  document.getElementById('account-current-user').textContent = accountLabel(sessionUser);
  renderSyncStatus();
  const list = document.getElementById('weekday-targets-list');
  list.innerHTML = '';
  for (const wd of WEEKDAY_ROWS) {
    const row = cache.dayTargets.find(d => d.weekday === wd) ?? { weekday: wd, kcal: null, protein: null };
    const rowEl = el(`
      <div class="weekday-row">
        <span class="day">${WEEKDAY_LABELS[wd]}</span>
        <div class="inputs">
          <input type="number" aria-label="${WEEKDAY_LABELS[wd]} calorie target" placeholder="kcal" value="${row.kcal ?? ''}">
          <input type="number" aria-label="${WEEKDAY_LABELS[wd]} protein target" placeholder="protein g" value="${row.protein ?? ''}">
        </div>
      </div>
    `);
    const [kcalInput, protInput] = rowEl.querySelectorAll('input');
    const save = async () => {
      await db.put('dayTargets', {
        weekday: wd,
        kcal: kcalInput.value === '' ? null : Number(kcalInput.value),
        protein: protInput.value === '' ? null : Number(protInput.value),
      });
      await refreshCache();
    };
    kcalInput.addEventListener('change', save);
    protInput.addEventListener('change', save);
    list.appendChild(rowEl);
  }

  renderOverrides();
  updateSettingsWeightAvg();
}

function renderOverrides() {
  const container = document.getElementById('overrides-list');
  container.innerHTML = '';
  const sorted = cache.overrides.slice().sort((a, b) => a.date.localeCompare(b.date));
  for (const o of sorted) {
    const row = el(`
      <div class="override-row">
        <input type="date" value="${o.date}" aria-label="Override date" disabled>
        <input type="number" placeholder="kcal" value="${o.kcal ?? ''}" style="width:80px;" class="text-input" aria-label="Override calorie target">
        <input type="number" placeholder="protein g" value="${o.protein ?? ''}" style="width:90px;" class="text-input" aria-label="Override protein target">
        <button type="button" class="icon-btn-small" aria-label="Remove override for ${o.date}">×</button>
      </div>
    `);
    const [kcalInput, protInput] = row.querySelectorAll('input[type="number"]');
    const save = async () => {
      await db.put('dayTargetOverrides', {
        date: o.date,
        kcal: kcalInput.value === '' ? null : Number(kcalInput.value),
        protein: protInput.value === '' ? null : Number(protInput.value),
      });
      await refreshCache();
    };
    kcalInput.addEventListener('change', save);
    protInput.addEventListener('change', save);
    row.querySelector('button').addEventListener('click', async () => {
      await db.remove('dayTargetOverrides', o.date);
      await refreshCache();
      renderOverrides();
    });
    container.appendChild(row);
  }
}

document.getElementById('add-override-btn').addEventListener('click', () => {
  const body = `
    <h2>Add a date override</h2>
    <label class="field-label" for="ov-date">Date</label>
    <input class="text-input" id="ov-date" type="date" style="margin-bottom:12px;">
    <label class="field-label" for="ov-kcal">Calorie target (optional)</label>
    <input class="text-input" id="ov-kcal" type="number" style="margin-bottom:12px;">
    <label class="field-label" for="ov-protein">Protein target (optional)</label>
    <input class="text-input" id="ov-protein" type="number" style="margin-bottom:12px;">
    <div class="form-msg error" id="ov-error" hidden></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="ov-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="ov-save">Save</button>
    </div>
  `;
  openModal(body);
  document.getElementById('ov-cancel').addEventListener('click', closeModal);
  document.getElementById('ov-save').addEventListener('click', async () => {
    const date = document.getElementById('ov-date').value;
    const errEl = document.getElementById('ov-error');
    if (!date) { errEl.textContent = 'Pick a date.'; errEl.hidden = false; return; }
    const kcalVal = document.getElementById('ov-kcal').value;
    const protVal = document.getElementById('ov-protein').value;
    await db.put('dayTargetOverrides', {
      date,
      kcal: kcalVal === '' ? null : Number(kcalVal),
      protein: protVal === '' ? null : Number(protVal),
    });
    await refreshCache();
    closeModal();
    renderSettings();
  });
});

function updateSettingsWeightAvg() {
  const avg = averageWeight(cache.weightLog);
  document.getElementById('settings-weight-avg').textContent = avg == null ? '—' : `${avg.toFixed(1)} kg`;
}

// ==================== BODY WEIGHT ====================
function renderWeight() {
  const series = weightSeries(cache.weightLog); // ascending by date
  const avg = averageWeight(cache.weightLog);

  document.getElementById('weight-avg').textContent = avg == null ? '—' : `${avg.toFixed(1)} kg`;
  document.getElementById('weight-latest').textContent =
    series.length ? `${series[series.length - 1].kg.toFixed(1)} kg` : '—';
  const changeEl = document.getElementById('weight-change');
  if (series.length < 2) {
    changeEl.textContent = '—';
  } else {
    const delta = series[series.length - 1].kg - series[0].kg;
    changeEl.textContent = `${delta > 0 ? '+' : ''}${delta.toFixed(1)} kg`;
  }

  const chart = document.getElementById('weight-chart');
  chart.innerHTML = '';
  chart.appendChild(buildWeightChart(series, avg));

  const list = document.getElementById('weight-entries');
  list.innerHTML = '';
  if (!series.length) {
    list.appendChild(el(`<div class="empty-state">No weight entries yet.</div>`));
    return;
  }
  for (const w of series.slice().reverse()) { // newest first in the list
    const row = el(`
      <button type="button" class="weight-entry-row">
        <span>${escapeHtml(formatDateHeader(w.date))}</span>
        <span>${w.kg.toFixed(1)} kg <span class="chevron" aria-hidden="true">›</span></span>
      </button>
    `);
    row.addEventListener('click', () => openWeightModal(w));
    list.appendChild(row);
  }
}

// Inline SVG line graph of the weigh-ins. X is spaced by actual date gaps (not entry index) so
// an irregular logging cadence reads honestly. Colours are CSS vars so it tracks the theme.
function buildWeightChart(series, avg) {
  if (series.length < 2) {
    return el(`<div class="empty-state">Log at least two weigh-ins to see the graph.</div>`);
  }
  const W = 320, H = 170, padL = 34, padR = 12, padT = 14, padB = 22;
  const first = Date.parse(series[0].date);
  const last = Date.parse(series[series.length - 1].date);
  const span = Math.max(1, last - first);
  const kgs = series.map(w => w.kg);
  const realLo = Math.min(...kgs), realHi = Math.max(...kgs);
  let lo = realLo, hi = realHi;
  if (lo === hi) { lo -= 1; hi += 1; }
  const margin = (hi - lo) * 0.18;
  lo -= margin; hi += margin;

  const xOf = d => padL + ((Date.parse(d) - first) / span) * (W - padL - padR);
  const yOf = kg => padT + (1 - (kg - lo) / (hi - lo)) * (H - padT - padB);

  const pts = series.map(w => `${xOf(w.date).toFixed(1)},${yOf(w.kg).toFixed(1)}`).join(' ');
  const dots = series
    .map(w => `<circle cx="${xOf(w.date).toFixed(1)}" cy="${yOf(w.kg).toFixed(1)}" r="2.5" fill="var(--navy)"></circle>`)
    .join('');

  let avgLine = '';
  if (avg != null && avg > lo && avg < hi) {
    const ay = yOf(avg).toFixed(1);
    avgLine = `
      <line x1="${padL}" y1="${ay}" x2="${W - padR}" y2="${ay}" stroke="var(--teal)" stroke-width="1" stroke-dasharray="4 3"></line>
      <text x="${W - padR}" y="${(yOf(avg) - 4).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--teal)">avg ${avg.toFixed(1)}</text>`;
  }

  const fmtX = d => { const [, m, day] = d.split('-'); return `${day}/${m}`; };

  return el(`
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Body weight over time">
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="var(--hairline)"></line>
      <line x1="${padL}" y1="${(H - padB)}" x2="${W - padR}" y2="${H - padB}" stroke="var(--hairline)"></line>
      ${avgLine}
      <polyline points="${pts}" fill="none" stroke="var(--navy)" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"></polyline>
      ${dots}
      <text x="${padL - 6}" y="${(yOf(realHi) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text-secondary)">${realHi.toFixed(1)}</text>
      <text x="${padL - 6}" y="${(yOf(realLo) + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="var(--text-secondary)">${realLo.toFixed(1)}</text>
      <text x="${padL}" y="${H - 6}" text-anchor="start" font-size="9" fill="var(--text-secondary)">${fmtX(series[0].date)}</text>
      <text x="${W - padR}" y="${H - 6}" text-anchor="end" font-size="9" fill="var(--text-secondary)">${fmtX(series[series.length - 1].date)}</text>
    </svg>
  `);
}

// Add (no arg) or edit (pass the existing { date, kg }) a weigh-in. The date is the record's
// key, so changing it on an edit deletes the old-dated record rather than leaving a duplicate.
function openWeightModal(existing) {
  const isEdit = !!existing;
  const body = `
    <h2>${isEdit ? 'Edit weight' : 'Log a weight'}</h2>
    <label class="field-label" for="w-date">Date</label>
    <input class="text-input" id="w-date" type="date" max="${todayISO()}" style="margin-bottom:12px;" value="${isEdit ? existing.date : todayISO()}">
    <label class="field-label" for="w-kg">Weight (kg)</label>
    <input class="text-input" id="w-kg" type="text" inputmode="decimal" pattern="[0-9]*[.,]?[0-9]*" style="margin-bottom:12px;" value="${isEdit ? existing.kg : ''}">
    <div class="form-msg error" id="w-error" hidden></div>
    <div class="modal-actions">
      ${isEdit
        ? '<button type="button" class="secondary-btn" id="w-delete">Delete</button>'
        : '<button type="button" class="secondary-btn" id="w-cancel">Cancel</button>'}
      <button type="button" class="primary-btn" id="w-save">Save</button>
    </div>
  `;
  openModal(body);

  const cancelBtn = document.getElementById('w-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  const deleteBtn = document.getElementById('w-delete');
  if (deleteBtn) deleteBtn.addEventListener('click', async () => {
    await db.remove('weightLog', existing.date);
    await refreshCache();
    closeModal();
    afterWeightChange('Weight entry deleted');
  });

  document.getElementById('w-save').addEventListener('click', async () => {
    const date = document.getElementById('w-date').value;
    const kg = Number(document.getElementById('w-kg').value.trim().replace(',', '.'));
    const errEl = document.getElementById('w-error');
    if (!date || !(kg > 0)) {
      errEl.textContent = 'Enter a date and a weight above zero.';
      errEl.hidden = false;
      return;
    }
    if (isEdit && existing.date !== date) await db.remove('weightLog', existing.date);
    await db.put('weightLog', { date, kg });
    await refreshCache();
    closeModal();
    afterWeightChange('Weight saved');
  });
}

function afterWeightChange(msg) {
  renderWeight();
  updateSettingsWeightAvg();
  toast(msg);
}

document.getElementById('weight-add-btn').addEventListener('click', () => openWeightModal());
document.getElementById('open-weight-btn').addEventListener('click', () => goTo('weight'));
document.getElementById('weight-back').addEventListener('click', () => goTo('settings'));

document.getElementById('open-history-btn').addEventListener('click', () => goTo('history'));
document.getElementById('history-back').addEventListener('click', () => goTo('settings'));

document.getElementById('logout-btn').addEventListener('click', async () => {
  await logout();
  // onUserChanged puts the login screen back up.
});

document.getElementById('export-all-btn').addEventListener('click', async () => {
  const [foods, recipes, bundles, logEntries, dayTargets, overrides, weightLog] = await Promise.all([
    db.getAll('foods'), db.getAll('recipes'), db.getAll('bundles'), db.getAll('logEntries'), db.getAll('dayTargets'), db.getAll('dayTargetOverrides'), db.getAll('weightLog'),
  ]);
  const text = JSON.stringify({ foods, recipes, bundles, logEntries, dayTargets, dayTargetOverrides: overrides, weightLog }, null, 2);
  const ok = await copyText(text);
  toast(ok ? 'Copied full data export' : 'Could not copy — check clipboard permission');
});

// ==================== MODAL ====================
// Lock the modal backdrop to the visual viewport (the area *above* the on-screen
// keyboard) so the bottom-anchored sheet is never hidden behind the keyboard.
// Without this, position:fixed on iOS is relative to the full layout viewport,
// which extends behind the keyboard.
function syncModalViewport() {
  const backdrop = document.getElementById('modal-backdrop');
  const vv = window.visualViewport;
  if (backdrop.hidden || !vv) return;
  const s = backdrop.style;
  s.setProperty('--vv-top', vv.offsetTop + 'px');
  s.setProperty('--vv-left', vv.offsetLeft + 'px');
  s.setProperty('--vv-width', vv.width + 'px');
  s.setProperty('--vv-height', vv.height + 'px');
}
function clearModalViewport() {
  const s = document.getElementById('modal-backdrop').style;
  s.removeProperty('--vv-top');
  s.removeProperty('--vv-left');
  s.removeProperty('--vv-width');
  s.removeProperty('--vv-height');
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncModalViewport);
  window.visualViewport.addEventListener('scroll', syncModalViewport);
}

// Set by a sub-flow (e.g. the bundle item picker) that isn't a dead end — closing it, by
// whatever means (Cancel, backdrop tap, drag-to-close), should resume the sheet it was opened
// from rather than just exit. Cleared by closeModal() itself, and by anything that leaves the
// sub-flow without going through closeModal() (picking a result opens the next sheet directly).
let pendingModalCancel = null;

function openModal(bodyHtml) {
  const backdrop = document.getElementById('modal-backdrop');
  const sheet = document.getElementById('modal-sheet');
  document.getElementById('modal-sheet-body').innerHTML = bodyHtml;
  backdrop.hidden = false;
  // The page behind must stay put while a sheet is up. The scrolling element is .screen, not
  // body, so locking body alone would do nothing here.
  document.body.classList.add('modal-open');
  document.getElementById('modal-sheet-body').scrollTop = 0;
  // A previous sheet may have been left mid-drag (closeModal always resets this, but belt
  // and braces so a fresh sheet never opens already offset).
  sheet.style.transform = '';
  syncModalViewport();
}
function closeModal() {
  const resume = pendingModalCancel;
  pendingModalCancel = null;
  document.getElementById('modal-backdrop').hidden = true;
  document.getElementById('modal-sheet-body').innerHTML = '';
  const sheet = document.getElementById('modal-sheet');
  sheet.style.transform = '';
  sheet.style.transition = '';
  clearModalViewport();
  document.body.classList.remove('modal-open');
  if (resume) resume();
}
// When a field inside the sheet gets focus, wait for the keyboard/viewport to
// settle, then bring it into view within the (now shorter) scrollable sheet.
document.getElementById('modal-sheet').addEventListener('focusin', e => {
  setTimeout(() => {
    syncModalViewport();
    e.target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 300);
});
document.getElementById('modal-backdrop').addEventListener('click', e => {
  if (e.target.id === 'modal-backdrop') closeModal();
});

// Dragging the handle down closes the sheet — the handle sits outside the scrollable body
// (see .modal-sheet-handle), so this never fights normal scrolling inside a long form.
(function setupSheetDragToClose() {
  const sheet = document.getElementById('modal-sheet');
  const handle = document.getElementById('modal-sheet-handle');
  const CLOSE_THRESHOLD = 90;
  let dragging = false;
  let startY = 0;
  let deltaY = 0;

  handle.addEventListener('pointerdown', e => {
    dragging = true;
    startY = e.clientY;
    deltaY = 0;
    sheet.style.transition = 'none';
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (!dragging) return;
    deltaY = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${deltaY}px)`;
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    if (deltaY > CLOSE_THRESHOLD) closeModal();
    else sheet.style.transform = '';
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
})();

// ==================== LOGIN GATE ====================
let sessionUser = null;

const emailInput = document.getElementById('login-email');
const passwordInput = document.getElementById('login-password');
const submitBtn = document.getElementById('login-submit');

function updateLoginSubmitEnabled() {
  submitBtn.disabled = !emailInput.value.trim() || !passwordInput.value;
}
emailInput.addEventListener('input', updateLoginSubmitEnabled);
passwordInput.addEventListener('input', updateLoginSubmitEnabled);
for (const field of [emailInput, passwordInput]) {
  field.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !submitBtn.disabled) submitLogin();
  });
}
submitBtn.addEventListener('click', submitLogin);

async function submitLogin() {
  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';
  try {
    await login(emailInput.value, passwordInput.value);
    // onUserChanged drives the unlock, so nothing more to do here.
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err);
    errorEl.hidden = false;
    submitBtn.textContent = 'Sign in';
    updateLoginSubmitEnabled();
  }
}

// The splash stays up across both the "app loading" phase (this module executing) and the
// "data loading" phase (auth resolving, seed, first cache fill) below, so it only needs
// hiding once boot lands on either the unlocked app or the login screen.
function hideSplash() {
  const splash = document.getElementById('splash-screen');
  if (!splash || splash.hidden) return;
  splash.classList.add('splash-hide');
  setTimeout(() => { splash.hidden = true; }, 220);
}

async function unlockApp(user) {
  sessionUser = user;
  db.setCurrentUser(user.uid);
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app').hidden = false;
  passwordInput.value = '';

  // These two are independent — no reason to wait for one before starting the other.
  await Promise.all([seedSharedIfEmpty(), seedUserIfEmpty(user.uid)]);
  await maybeOfferMigration();
  await refreshEssentialCache();
  if (!location.hash) location.hash = 'today';
  renderRoute();
  hideSplash();

  // Weight log and quick-log favourites aren't needed for this first paint. Fetch them after,
  // and only pay for a second render if the screen actually on-screen turns out to use them.
  refreshBackgroundCache().then(renderRoute).catch(() => {});
}

function showLoginScreen() {
  sessionUser = null;
  db.setCurrentUser(null);
  document.getElementById('app').hidden = true;
  document.getElementById('login-screen').hidden = false;
  submitBtn.textContent = 'Sign in';
  updateLoginSubmitEnabled();
  hideSplash();
}

// ==================== MIGRATION FROM THE LOCAL-ONLY BUILD ====================
// Offered once per account, and only ever additive — the old local data is never deleted, so
// a failed or declined upload leaves the previous build's copy intact on the device.
async function maybeOfferMigration() {
  try {
    if (await alreadyMigrated()) return;
    const legacy = await findLegacyData();
    if (!legacy.hasAnything) { await markMigrated(); return; }

    const accountRows = legacy.accounts.map(a => `
      <label style="display:flex; align-items:center; gap:10px; padding:10px 0; border-bottom:1px solid var(--hairline);">
        <input type="checkbox" data-legacy-account="${escapeHtml(a.name)}" ${legacy.accounts.length === 1 ? 'checked' : ''}>
        <span style="flex:1;">
          <span style="font-size:0.9375rem; font-weight:500;">${escapeHtml(a.name)}</span>
          <span style="display:block; font-family:var(--font-mono); font-size:0.6875rem; color:var(--text-secondary);">
            ${a.logEntries.length} entries · ${a.weightLog.length} weights
          </span>
        </span>
      </label>
    `).join('');

    openModal(`
      <h2>Bring your existing data across</h2>
      <p style="font-size:0.8125rem; color:var(--text-secondary); margin-top:0;">
        Found data saved on this device by the previous version. Upload it to your account so it
        syncs to your other devices? Nothing on this device is deleted either way.
      </p>
      <div class="weight-row" style="border-bottom:1px solid var(--hairline);">
        <span>Foods &amp; recipes</span>
        <span>${legacy.foods.length} + ${legacy.recipes.length}</span>
      </div>
      ${accountRows ? `<div style="margin-top:6px;">${accountRows}</div>` : ''}
      <p style="font-size:0.75rem; color:var(--text-secondary);">
        Tick only the daily log that belongs to <strong>${escapeHtml(accountLabel(sessionUser))}</strong>.
        Anything else should be uploaded by that person from their own account.
      </p>
      <div class="form-msg error" id="mig-error" hidden></div>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" id="mig-skip">Not now</button>
        <button type="button" class="primary-btn" id="mig-go">Upload</button>
      </div>
    `);

    await new Promise(resolve => {
      document.getElementById('mig-skip').addEventListener('click', () => { closeModal(); resolve(); });
      document.getElementById('mig-go').addEventListener('click', async () => {
        const btn = document.getElementById('mig-go');
        btn.disabled = true;
        btn.textContent = 'Uploading…';
        try {
          const chosen = [...document.querySelectorAll('[data-legacy-account]')]
            .filter(cb => cb.checked)
            .map(cb => legacy.accounts.find(a => a.name === cb.dataset.legacyAccount));
          const sharedResult = await uploadShared(legacy);
          let entries = 0;
          for (const account of chosen) {
            const r = await uploadAccount(account);
            entries += r.logEntries;
          }
          await markMigrated();
          closeModal();
          toast(`Uploaded ${sharedResult.foods} foods, ${entries} entries`);
          resolve();
        } catch (err) {
          const errEl = document.getElementById('mig-error');
          errEl.textContent = 'Upload failed — your local data is untouched. Try again later from Settings.';
          errEl.hidden = false;
          btn.disabled = false;
          btn.textContent = 'Upload';
        }
      });
    });
  } catch {
    // Migration is a convenience; never let it block getting into the app.
  }
}

// ==================== CONNECTION STATUS ====================
function renderSyncStatus() {
  const badge = document.getElementById('sync-badge');
  if (!badge) return;
  const online = navigator.onLine;
  badge.textContent = online ? 'synced' : 'offline — will sync';
  badge.classList.toggle('offline', !online);
}
window.addEventListener('online', renderSyncStatus);
window.addEventListener('offline', renderSyncStatus);

// ==================== BOOT ====================
function boot() {
  renderSyncStatus();
  initPullToRefresh();

  // Firebase restores the previous session asynchronously, so the app unlocks from here
  // rather than from the sign-in button.
  onUserChanged(async user => {
    if (user) {
      try {
        await unlockApp(user);
      } catch (err) {
        const errorEl = document.getElementById('login-error');
        showLoginScreen();
        errorEl.textContent = 'Signed in, but could not load your data. Check your connection and try again.';
        errorEl.hidden = false;
      }
    } else {
      showLoginScreen();
    }
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline install will retry next online visit */ });
  }
}

boot();
