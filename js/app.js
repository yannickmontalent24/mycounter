import * as db from './db.js';
import { seedIfEmpty } from './seed.js';
import {
  resolveTarget, weekdayOf, heroState, ringDash, entryMacros,
  foodPortionMacros, recipePerGram, validateFood, validateRecipe, formatDateHeader,
} from './logic.js';
import { exportDay, exportRange, importFromClipboardText, ImportError } from './import-export.js';

const WEEKDAY_ROWS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_LABELS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const SOURCE_GLYPH = { label: '■', reference: '□', estimate: '◇' };

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

// ---- In-memory cache, refreshed from IndexedDB after any mutation ----
const cache = { foods: [], recipes: [], dayTargets: [], overrides: [], weightLog: [] };

async function refreshCache() {
  const [foods, recipes, dayTargets, overrides, weightLog] = await Promise.all([
    db.getAll('foods'), db.getAll('recipes'), db.getAll('dayTargets'), db.getAll('dayTargetOverrides'), db.getAll('weightLog'),
  ]);
  cache.foods = foods;
  cache.recipes = recipes;
  cache.dayTargets = dayTargets;
  cache.overrides = overrides;
  cache.weightLog = weightLog.sort((a, b) => b.date.localeCompare(a.date));
}

function foodsById() { return new Map(cache.foods.map(f => [f.id, f])); }
function recipesById() { return new Map(cache.recipes.map(r => [r.id, r])); }

// ---- Routing ----
const SCREENS = ['today', 'log', 'foods', 'recipes', 'history', 'settings'];

function currentScreenFromHash() {
  const h = location.hash.replace('#', '');
  return SCREENS.includes(h) ? h : 'today';
}

function goTo(screen) {
  location.hash = screen;
}

function renderRoute() {
  const screen = currentScreenFromHash();
  for (const s of SCREENS) {
    document.getElementById(`screen-${s}`).hidden = s !== screen;
  }
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.go === screen;
    btn.classList.toggle('active', active);
    btn.querySelector('.indicator').textContent = active ? '━' : '';
  });
  const renderers = { today: renderToday, log: renderLog, foods: renderFoods, recipes: renderRecipes, history: renderHistory, settings: renderSettings };
  renderers[screen]();
}

window.addEventListener('hashchange', renderRoute);
document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => goTo(btn.dataset.go)));

// ==================== TODAY ====================
async function renderToday() {
  const dateStr = todayISO();
  document.getElementById('today-date-chip').textContent = formatDateHeader(dateStr);

  const entries = await db.entriesInRange(dateStr, dateStr);
  const fMap = foodsById(), rMap = recipesById();
  const resolved = entries
    .map(e => {
      const m = entryMacros(e, fMap, rMap);
      return m ? { id: e.id, grams: e.grams, ...m } : null;
    })
    .filter(Boolean);

  const kcalTotal = resolved.reduce((a, e) => a + e.kcal, 0);
  const protTotal = resolved.reduce((a, e) => a + e.protein, 0);
  const target = resolveTarget(cache.dayTargets, cache.overrides, dateStr, weekdayOf(dateStr));

  const k = heroState(kcalTotal, target.kcal);
  const p = heroState(protTotal, target.protein);

  applyHero('kcal', k, kcalTotal, target.kcal);
  applyHero('protein', p, protTotal, target.protein);

  document.getElementById('today-totals-line').textContent = `${kcalTotal} kcal · ${protTotal} g`;
  document.getElementById('today-day-total').textContent = `${kcalTotal} kcal · ${protTotal} g`;

  const list = document.getElementById('today-entry-list');
  list.innerHTML = '';
  if (resolved.length === 0) {
    list.appendChild(el(`<div class="empty-state">Nothing logged yet today.</div>`));
  }
  for (const e of resolved) {
    const row = el(`
      <div class="entry-row">
        <div class="entry-main">
          <div class="entry-name">${escapeHtml(e.name)}</div>
          <div class="entry-detail">${e.grams} g</div>
        </div>
        <div class="entry-values">
          <div>${e.kcal} kcal</div>
          <div class="protein">${e.protein} g protein</div>
        </div>
        <button type="button" class="delete-btn" aria-label="Delete entry">×</button>
      </div>
    `);
    row.querySelector('.delete-btn').addEventListener('click', async () => {
      await db.remove('logEntries', e.id);
      renderToday();
    });
    list.appendChild(row);
  }
}

function applyHero(kind, state, consumed, target) {
  const heroEl = document.getElementById(`${kind}-hero`);
  const stateEl = document.getElementById(`${kind}-state`);
  const ofTargetEl = document.getElementById(`${kind}-of-target`);
  const ringEl = document.getElementById(`${kind}-ring`);
  const unitWord = kind === 'kcal' ? 'kcal' : 'g';

  if (state.remaining == null) {
    heroEl.textContent = '—';
    stateEl.querySelector('.mark').textContent = '·';
    stateEl.querySelector('.text').textContent = 'no target set';
    stateEl.style.color = 'var(--text-secondary)';
    ofTargetEl.textContent = `${consumed} logged`;
    ringEl.setAttribute('stroke-dasharray', '0 339.3');
    ringEl.setAttribute('stroke', 'var(--text-secondary)');
    return;
  }
  const overColor = 'var(--red)';
  const baseColor = kind === 'kcal' ? 'var(--navy)' : 'var(--teal)';
  const color = state.over ? overColor : baseColor;
  heroEl.textContent = (state.over ? '+' : '') + Math.abs(state.remaining);
  heroEl.style.color = color;
  stateEl.querySelector('.mark').textContent = state.mark;
  stateEl.querySelector('.text').textContent = state.stateText;
  stateEl.style.color = color;
  ofTargetEl.textContent = `${consumed} / ${target} ${unitWord}`;
  ringEl.setAttribute('stroke-dasharray', ringDash(consumed, target));
  ringEl.setAttribute('stroke', color);
}

document.getElementById('export-day-btn').addEventListener('click', async () => {
  const text = await exportDay(todayISO());
  const ok = await copyText(text);
  toast(ok ? 'Copied today’s log' : 'Could not copy — check clipboard permission');
});

// ==================== LOG ENTRY ====================
const logState = { query: '', pickedId: null, grams: '' };

function renderLog() {
  const input = document.getElementById('foodsearch');
  input.value = logState.query;
  renderLogResults();
  renderLogDraft();
  document.getElementById('gramsfield').value = logState.grams;
}

function renderLogResults() {
  const q = logState.query.trim().toLowerCase();
  const results = cache.foods.filter(f => !q || f.name.toLowerCase().includes(q)).slice(0, 4);
  const container = document.getElementById('log-search-results');
  container.innerHTML = '';
  for (const f of results) {
    const btn = el(`
      <button type="button" class="search-result-btn">
        <span class="name">${escapeHtml(f.name)}</span>
        <span class="per100">${f.per100g.kcal} kcal · ${f.per100g.protein} g /100g</span>
        <span class="check">${logState.pickedId === f.id ? '●' : '○'}</span>
      </button>
    `);
    btn.addEventListener('click', () => {
      logState.pickedId = f.id;
      logState.grams = String(f.defaultPortionG ?? 100);
      renderLog();
    });
    container.appendChild(btn);
  }
}

function renderLogDraft() {
  const picked = logState.pickedId ? foodsById().get(logState.pickedId) : null;
  const nameEl = document.getElementById('log-draft-name');
  const macrosEl = document.getElementById('log-draft-macros');
  if (!picked) {
    nameEl.textContent = 'No food selected';
    macrosEl.textContent = '—';
    return;
  }
  nameEl.textContent = picked.name;
  const grams = parseInt(logState.grams, 10) || 0;
  const m = foodPortionMacros(picked, grams);
  macrosEl.textContent = `${m.kcal} kcal · ${m.protein} g`;
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
  await db.put('logEntries', {
    id: crypto.randomUUID(), date: todayISO(), foodId: logState.pickedId, recipeId: null, grams,
  });
  logState.query = ''; logState.pickedId = null; logState.grams = '';
  goTo('today');
});

// ==================== FOODS ====================
let foodsTagFilter = 'All';

function allTagsFromFoods() {
  const set = new Set();
  for (const f of cache.foods) for (const t of f.tags ?? []) set.add(t);
  return ['All', ...Array.from(set).sort()];
}

function renderFoods() {
  const chipContainer = document.getElementById('foods-tag-chips');
  chipContainer.innerHTML = '';
  for (const tag of allTagsFromFoods()) {
    const chip = el(`<button type="button" class="tag-chip">${escapeHtml(tag)}</button>`);
    const active = foodsTagFilter === tag;
    chip.style.background = active ? 'var(--navy)' : 'var(--surface-raised)';
    chip.style.color = active ? 'var(--surface)' : 'var(--navy)';
    chip.style.borderColor = active ? 'var(--navy)' : 'var(--control-border)';
    chip.addEventListener('click', () => { foodsTagFilter = tag; renderFoods(); });
    chipContainer.appendChild(chip);
  }

  const rows = cache.foods.filter(f => foodsTagFilter === 'All' || (f.tags ?? []).includes(foodsTagFilter));
  const list = document.getElementById('foods-list');
  list.innerHTML = '';
  if (rows.length === 0) list.appendChild(el(`<div class="empty-state">No foods yet. Add one, or paste from Claude.</div>`));
  for (const f of rows) {
    const badgeBg = f.source === 'estimate' ? 'var(--red-tint-bg)' : (f.source === 'reference' ? 'var(--teal-badge-bg)' : 'var(--navy-tint-bg)');
    const badgeColor = f.source === 'estimate' ? 'var(--red)' : (f.source === 'reference' ? 'var(--teal)' : 'var(--navy)');
    const badgeBorder = f.source === 'estimate' ? 'var(--red-tint-border)' : (f.source === 'reference' ? 'var(--teal-tint-border)' : 'var(--navy-tint-border)');
    const row = el(`
      <div class="food-row">
        <div class="main">
          <div class="name">${escapeHtml(f.name)}</div>
          <div class="per100">${f.per100g.kcal} kcal · ${f.per100g.protein} g /100g</div>
        </div>
        <div class="source-badge" style="border:1px solid ${badgeBorder}; background:${badgeBg};">
          <span class="glyph" style="color:${badgeColor};">${SOURCE_GLYPH[f.source] ?? '?'}</span>
          <span class="word" style="color:${badgeColor};">${escapeHtml(f.source)}</span>
        </div>
        <div class="actions">
          <button type="button" class="icon-btn-small" aria-label="Edit ${escapeHtml(f.name)}">✎</button>
          <button type="button" class="icon-btn-small" aria-label="Delete ${escapeHtml(f.name)}">×</button>
        </div>
      </div>
    `);
    row.querySelector('[aria-label^="Edit"]').addEventListener('click', () => openFoodModal(f));
    row.querySelector('[aria-label^="Delete"]').addEventListener('click', async () => {
      if (!confirm(`Delete "${f.name}"? This can't be undone.`)) return;
      await db.remove('foods', f.id);
      await refreshCache();
      renderFoods();
    });
    list.appendChild(row);
  }
}

document.getElementById('add-food-btn').addEventListener('click', () => openFoodModal(null));

function openFoodModal(food) {
  const isEdit = !!food;
  const body = `
    <h2>${isEdit ? 'Edit food' : 'Add food'}</h2>
    <label class="field-label" for="f-name">Name</label>
    <input class="text-input" id="f-name" style="margin-bottom:12px;" value="${isEdit ? escapeHtml(food.name) : ''}">
    <label class="field-label" for="f-kcal">Calories per 100 g</label>
    <input class="text-input" id="f-kcal" type="number" style="margin-bottom:12px;" value="${isEdit ? food.per100g.kcal : ''}">
    <label class="field-label" for="f-protein">Protein per 100 g</label>
    <input class="text-input" id="f-protein" type="number" style="margin-bottom:12px;" value="${isEdit ? food.per100g.protein : ''}">
    <label class="field-label" for="f-carbs">Carbs per 100 g (optional)</label>
    <input class="text-input" id="f-carbs" type="number" style="margin-bottom:12px;" value="${isEdit && food.per100g.carbs != null ? food.per100g.carbs : ''}">
    <label class="field-label" for="f-fat">Fat per 100 g (optional)</label>
    <input class="text-input" id="f-fat" type="number" style="margin-bottom:12px;" value="${isEdit && food.per100g.fat != null ? food.per100g.fat : ''}">
    <label class="field-label" for="f-fibre">Fibre per 100 g (optional)</label>
    <input class="text-input" id="f-fibre" type="number" style="margin-bottom:12px;" value="${isEdit && food.per100g.fibre != null ? food.per100g.fibre : ''}">
    <label class="field-label" for="f-portion">Default portion (g)</label>
    <input class="text-input" id="f-portion" type="number" style="margin-bottom:12px;" value="${isEdit ? food.defaultPortionG : 100}">
    <label class="field-label" for="f-source">Source</label>
    <select class="text-input" id="f-source" style="margin-bottom:12px;">
      <option value="label" ${isEdit && food.source === 'label' ? 'selected' : ''}>label — from packaging</option>
      <option value="reference" ${isEdit && food.source === 'reference' ? 'selected' : ''}>reference — published table</option>
      <option value="estimate" ${isEdit && food.source === 'estimate' ? 'selected' : ''}>estimate — entered by hand</option>
    </select>
    <label class="field-label" for="f-tags">Tags (comma separated)</label>
    <input class="text-input" id="f-tags" style="margin-bottom:12px;" value="${isEdit ? escapeHtml((food.tags ?? []).join(', ')) : ''}">
    <div class="form-msg error" id="f-error" hidden></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="f-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="f-save">Save</button>
    </div>
  `;
  openModal(body);
  document.getElementById('f-cancel').addEventListener('click', closeModal);
  document.getElementById('f-save').addEventListener('click', async () => {
    const num = v => (v === '' ? null : Number(v));
    const obj = {
      id: isEdit ? food.id : slugify(document.getElementById('f-name').value),
      name: document.getElementById('f-name').value.trim(),
      per100g: {
        kcal: num(document.getElementById('f-kcal').value),
        protein: num(document.getElementById('f-protein').value),
        carbs: num(document.getElementById('f-carbs').value),
        fat: num(document.getElementById('f-fat').value),
        fibre: num(document.getElementById('f-fibre').value),
      },
      defaultPortionG: num(document.getElementById('f-portion').value) ?? 100,
      source: document.getElementById('f-source').value,
      tags: document.getElementById('f-tags').value.split(',').map(t => t.trim()).filter(Boolean),
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

document.getElementById('paste-import-btn').addEventListener('click', () => {
  const body = `
    <h2>Paste from Claude</h2>
    <p style="font-size:13px; color:var(--text-secondary); margin-top:0;">Paste a JSON array of food and/or recipe objects.</p>
    <textarea id="import-text" placeholder="[ { &quot;id&quot;: ... } ]"></textarea>
    <div class="form-msg error" id="import-msg" hidden></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="import-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="import-confirm">Import</button>
    </div>
  `;
  openModal(body);
  document.getElementById('import-cancel').addEventListener('click', closeModal);
  document.getElementById('import-confirm').addEventListener('click', async () => {
    const text = document.getElementById('import-text').value;
    const msgEl = document.getElementById('import-msg');
    try {
      const result = await importFromClipboardText(text);
      await refreshCache();
      closeModal();
      toast(`Imported ${result.foods} food(s), ${result.recipes} recipe(s)`);
      renderFoods();
      renderRecipes();
    } catch (err) {
      msgEl.textContent = err instanceof ImportError ? err.message : 'Import failed.';
      msgEl.hidden = false;
    }
  });
});

// ==================== RECIPES ====================
function renderRecipes() {
  const list = document.getElementById('recipes-list');
  list.innerHTML = '';
  if (cache.recipes.length === 0) list.appendChild(el(`<div class="empty-state">No recipes yet.</div>`));
  const fMap = foodsById();
  for (const r of cache.recipes) {
    let perPortionText = '—';
    try {
      const perGram = recipePerGram(r, fMap);
      const grams = r.cookedWeightG / r.portions;
      perPortionText = `${Math.round(perGram.kcal * grams)} kcal · ${Math.round(perGram.protein * grams)} g / portion`;
    } catch { /* missing ingredient food record */ }
    const row = el(`
      <div>
        <div class="food-row" style="align-items:flex-start;">
          <div class="main">
            <div class="name">${escapeHtml(r.name)}</div>
            <div class="per100">${perPortionText}</div>
          </div>
          <div class="actions">
            <button type="button" class="icon-btn-small" data-edit-recipe="${r.id}" aria-label="Edit ${escapeHtml(r.name)}">✎</button>
            <button type="button" class="icon-btn-small" data-delete-recipe="${r.id}" aria-label="Delete ${escapeHtml(r.name)}">×</button>
          </div>
        </div>
        <button type="button" class="secondary-btn" style="margin:6px 0 10px;" data-log-recipe="${r.id}">Log a portion</button>
      </div>
    `);
    list.appendChild(row);
  }
  list.querySelectorAll('[data-log-recipe]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const recipe = recipesById().get(btn.dataset.logRecipe);
      const grams = Math.round(recipe.cookedWeightG / recipe.portions);
      await db.put('logEntries', { id: crypto.randomUUID(), date: todayISO(), foodId: null, recipeId: recipe.id, grams });
      goTo('today');
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

document.getElementById('add-recipe-btn').addEventListener('click', () => openRecipeModal(null));

function openRecipeModal(recipe) {
  const isEdit = !!recipe;
  const ingredients = isEdit ? recipe.ingredients.slice() : [{ foodId: '', grams: '' }];

  function ingredientRowHtml(ing, i) {
    const options = cache.foods.map(f => `<option value="${f.id}" ${ing.foodId === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('');
    return `
      <div style="display:flex; gap:8px; margin-bottom:8px;" data-ing-row="${i}">
        <select class="text-input" data-ing-food style="flex:2;"><option value="">Select food…</option>${options}</select>
        <input class="text-input" data-ing-grams type="number" placeholder="grams (raw)" style="flex:1;" value="${ing.grams || ''}">
        <button type="button" class="icon-btn-small" data-remove-ing aria-label="Remove ingredient">×</button>
      </div>
    `;
  }

  const body = `
    <h2>${isEdit ? 'Edit recipe' : 'Build a recipe'}</h2>
    <label class="field-label" for="r-name">Name</label>
    <input class="text-input" id="r-name" style="margin-bottom:12px;" value="${isEdit ? escapeHtml(recipe.name) : ''}">
    <div class="field-label" style="margin-bottom:8px;">Raw ingredients</div>
    <div id="r-ingredients">${ingredients.map(ingredientRowHtml).join('')}</div>
    <button type="button" class="secondary-btn" id="r-add-ing" style="margin-bottom:14px;">Add ingredient</button>
    <label class="field-label" for="r-cooked">Cooked / finished batch weight (g)</label>
    <input class="text-input" id="r-cooked" type="number" style="margin-bottom:12px;" value="${isEdit ? recipe.cookedWeightG : ''}">
    <label class="field-label" for="r-portions">Portions</label>
    <input class="text-input" id="r-portions" type="number" style="margin-bottom:12px;" value="${isEdit ? recipe.portions : ''}">
    <div class="form-msg error" id="r-error" hidden></div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="r-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="r-save">Save</button>
    </div>
  `;
  openModal(body);

  let rows = ingredients.slice();

  function rerenderIngredients() {
    document.getElementById('r-ingredients').innerHTML = rows.map(ingredientRowHtml).join('');
    wireIngredientRows();
  }

  function wireIngredientRows() {
    document.querySelectorAll('[data-ing-food]').forEach((sel, i) => sel.addEventListener('change', () => { rows[i].foodId = sel.value; }));
    document.querySelectorAll('[data-ing-grams]').forEach((inp, i) => inp.addEventListener('input', () => { rows[i].grams = inp.value; }));
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

  document.getElementById('r-cancel').addEventListener('click', closeModal);
  document.getElementById('r-save').addEventListener('click', async () => {
    const obj = {
      id: isEdit ? recipe.id : slugify(document.getElementById('r-name').value),
      name: document.getElementById('r-name').value.trim(),
      ingredients: rows.filter(r => r.foodId).map(r => ({ foodId: r.foodId, grams: Number(r.grams) })),
      cookedWeightG: Number(document.getElementById('r-cooked').value),
      portions: Number(document.getElementById('r-portions').value),
    };
    const errors = validateRecipe(obj);
    const errEl = document.getElementById('r-error');
    if (errors.length) { errEl.textContent = errors.join(' '); errEl.hidden = false; return; }
    await db.put('recipes', obj);
    await refreshCache();
    closeModal();
    renderRecipes();
  });
}

// ==================== HISTORY ====================
function renderHistory() {
  renderHistoryList();
}

async function renderHistoryList() {
  const to = isoDaysAgo(1); // yesterday — today lives on the Today screen
  const from = isoDaysAgo(14);
  const entries = await db.entriesInRange(from, to);
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const fMap = foodsById(), rMap = recipesById();
  const dates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));
  const list = document.getElementById('history-list');
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
      <div class="history-card" style="border:1px solid ${border}; background:${bg};">
        <div class="top-row">
          <div class="date">${formatDateHeader(dateStr)}</div>
          <div class="totals-wrap" style="color:${color};">
            <span>${over ? '▲' : '▼'}</span><span>${kcalTotal} kcal · ${protTotal} g</span>
          </div>
        </div>
        <div class="diff" style="color:${diffColor};">${diffParts.length ? diffParts.join(' · ') : 'no target set'}</div>
      </div>
    `);
    list.appendChild(card);
  }
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
  renderWeightLog();
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

function renderWeightLog() {
  const container = document.getElementById('weight-log-list');
  container.innerHTML = '';
  if (cache.weightLog.length === 0) container.appendChild(el(`<div class="empty-state">No weight entries yet.</div>`));
  for (const w of cache.weightLog) {
    container.appendChild(el(`<div class="weight-row"><span>${w.date}</span><span>${w.kg} kg</span></div>`));
  }
}

document.getElementById('add-weight-btn').addEventListener('click', () => {
  const body = `
    <h2>Log a weight</h2>
    <label class="field-label" for="w-date">Date</label>
    <input class="text-input" id="w-date" type="date" style="margin-bottom:12px;" value="${todayISO()}">
    <label class="field-label" for="w-kg">Weight (kg)</label>
    <input class="text-input" id="w-kg" type="number" step="0.1" style="margin-bottom:12px;">
    <div class="modal-actions">
      <button type="button" class="secondary-btn" id="w-cancel">Cancel</button>
      <button type="button" class="primary-btn" id="w-save">Save</button>
    </div>
  `;
  openModal(body);
  document.getElementById('w-cancel').addEventListener('click', closeModal);
  document.getElementById('w-save').addEventListener('click', async () => {
    const date = document.getElementById('w-date').value;
    const kg = Number(document.getElementById('w-kg').value);
    if (!date || !kg) return;
    await db.put('weightLog', { date, kg });
    await refreshCache();
    closeModal();
    renderWeightLog();
  });
});

document.getElementById('export-all-btn').addEventListener('click', async () => {
  const [foods, recipes, logEntries, dayTargets, overrides, weightLog] = await Promise.all([
    db.getAll('foods'), db.getAll('recipes'), db.getAll('logEntries'), db.getAll('dayTargets'), db.getAll('dayTargetOverrides'), db.getAll('weightLog'),
  ]);
  const text = JSON.stringify({ foods, recipes, logEntries, dayTargets, dayTargetOverrides: overrides, weightLog }, null, 2);
  const ok = await copyText(text);
  toast(ok ? 'Copied full data export' : 'Could not copy — check clipboard permission');
});

// ==================== MODAL ====================
function openModal(bodyHtml) {
  const backdrop = document.getElementById('modal-backdrop');
  const sheet = document.getElementById('modal-sheet');
  sheet.innerHTML = bodyHtml;
  backdrop.hidden = false;
}
function closeModal() {
  document.getElementById('modal-backdrop').hidden = true;
  document.getElementById('modal-sheet').innerHTML = '';
}
document.getElementById('modal-backdrop').addEventListener('click', e => {
  if (e.target.id === 'modal-backdrop') closeModal();
});

// ==================== BOOT ====================
async function boot() {
  await seedIfEmpty();
  await refreshCache();
  if (!location.hash) location.hash = 'today';
  renderRoute();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline install will retry next online visit */ });
  }
}

boot();
