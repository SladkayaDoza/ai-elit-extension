// popup.js — AI ELIT Solver popup: settings, profiles, fallback chain, usage stats.
// BUILTIN_MODELS, DEFAULT_MODEL_ID, DEFAULT_REASONING, DEFAULT_FALLBACKS, FREE_MODELS,
// NO_CREDITS_RETRY_MS, makeDefaultProfiles, makeDefaultAssignments and
// getMigratedStorage come from models.js.

const $ = id => document.getElementById(id);

// ─── Static data ─────────────────────────────────────────────────────────────

const TASK_TYPES = [
  { key: 'radio_single', icon: 'i-radio', label: 'Single answer' },
  { key: 'radio_multiple', icon: 'i-checkbox', label: 'Multiple answers' },
  { key: 'matching', icon: 'i-match', label: 'Matching & dropdowns' },
  { key: 'text_input', icon: 'i-text', label: 'Text input' },
  { key: 'image', icon: 'i-image', label: 'Question with images' },
  { key: 'mixed', icon: 'i-mixed', label: 'Mixed question' },
];

const REASONING_LEVELS = [
  { value: 'none', label: 'No thinking' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

// Provider monograms for the model lists (a letter on a tint, not a logo)
const PROVIDERS = {
  anthropic: { letter: 'A', color: '#e5936a' },
  openai: { letter: 'O', color: '#74d4b4' },
  google: { letter: 'G', color: '#86a8ff' },
  'x-ai': { letter: 'X', color: '#cfcfcf' },
  nvidia: { letter: 'N', color: '#9bd45a' },
  deepseek: { letter: 'D', color: '#7d97ff' },
  'meta-llama': { letter: 'M', color: '#9ab3ff' },
};

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  apiKey: '',
  hideButton: false,
  debugMode: false,
  autoFill: true,       // fill answers in (off = only show them)
  autoFillOther: true,  // also fill matching/dropdowns/text (only while autoFill is on)
  modelLibrary: [...BUILTIN_MODELS],
  profiles: makeDefaultProfiles(),
  activeProfile: 'lite',
  fallbackModels: DEFAULT_FALLBACKS.map(f => ({ ...f })),
};

let editingProfile = 'lite';
let extra = { lastStatus: null, noCreditsAt: 0, usageStats: null }; // written by background/content
let balance = null; // { remaining, used } from OpenRouter, or null

// ─── Storage ─────────────────────────────────────────────────────────────────

async function loadState() {
  // Migrates old saved settings (retired models, missing fallbacks) on the way
  const data = await getMigratedStorage();

  state.profiles = (data.profiles && Object.keys(data.profiles).length) ? data.profiles : makeDefaultProfiles();
  state.activeProfile = state.profiles[data.activeProfile] ? data.activeProfile : Object.keys(state.profiles)[0];
  state.modelLibrary = Array.isArray(data.modelLibrary) && data.modelLibrary.length ? data.modelLibrary : [...BUILTIN_MODELS];
  state.apiKey = data.apiKey || '';
  state.hideButton = !!data.hideButton;
  state.debugMode = !!data.debugMode;
  state.autoFill = data.autoFill !== false;
  state.autoFillOther = data.autoFillOther !== false;
  state.fallbackModels = Array.isArray(data.fallbackModels) ? data.fallbackModels : [];

  extra = { lastStatus: data.lastStatus || null, noCreditsAt: data.noCreditsAt || 0, usageStats: data.usageStats || null };
  editingProfile = state.activeProfile;
}

function saveState() {
  return new Promise(resolve => {
    chrome.storage.local.set({
      apiKey: state.apiKey,
      hideButton: state.hideButton,
      debugMode: state.debugMode,
      autoFill: state.autoFill,
      autoFillOther: state.autoFillOther,
      modelLibrary: state.modelLibrary,
      profiles: state.profiles,
      activeProfile: state.activeProfile,
      fallbackModels: state.fallbackModels,
    }, resolve);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) node.append(c);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name, cls = 'ic') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

function modelDisplayName(id) {
  const m = state.modelLibrary.find(x => x.id === id);
  if (m) return m.name;
  const free = FREE_MODELS.find(f => f.model === id);
  return free ? free.name : String(id).split('/').pop();
}

function providerBadge(id) {
  const key = String(id).split('/')[0].replace(/^~/, '');
  const p = PROVIDERS[key] || { letter: (key[0] || '?').toUpperCase(), color: '#b4b1a9' };
  return el('span', { class: 'prov', style: `--pc:${p.color}`, 'aria-hidden': 'true', text: p.letter });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function money(v) {
  if (!v) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v)}`;
}

function tokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

function dayKey(d) {
  const z = new Date(d);
  return `${z.getFullYear()}-${String(z.getMonth() + 1).padStart(2, '0')}-${String(z.getDate()).padStart(2, '0')}`;
}

let statusTimer = null;
function showStatus(msg, isError = false) {
  const s = $('status');
  s.textContent = msg;
  s.className = 'status show' + (isError ? ' error' : '');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { s.className = 'status' + (isError ? ' error' : ''); }, 2200);
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function selectTab(name) {
  const buttons = [...document.querySelectorAll('.tab-btn')];
  const idx = Math.max(0, buttons.findIndex(b => b.dataset.tab === name));
  buttons.forEach((b, i) => {
    b.classList.toggle('active', i === idx);
    b.setAttribute('aria-selected', String(i === idx));
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-' + name));
  $('tab-' + name)?.closest('.views')?.scrollTo({ top: 0 });
  if (name === 'usage') renderUsage();
}

document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => selectTab(btn.dataset.tab)));

// ─── Header status pill ──────────────────────────────────────────────────────

function creditsOut() {
  return extra.noCreditsAt && Date.now() - extra.noCreditsAt < NO_CREDITS_RETRY_MS;
}

function renderHero() {
  const profile = state.profiles[state.activeProfile];
  let word = 'Ready', cls = '';
  if (!state.apiKey) { word = 'No key'; cls = 'off'; }
  else if (creditsOut()) { word = 'Free'; cls = 'warn'; }

  const stamp = $('heroPill');
  const changed = stamp.dataset.word !== word;
  stamp.className = 'stamp' + (cls ? ' ' + cls : '');
  $('heroStatus').textContent = word;
  if (changed) {
    // replay the stamping animation when the state changes
    stamp.dataset.word = word;
    stamp.style.animation = 'none';
    void stamp.offsetWidth;
    stamp.style.animation = '';
  }

  const primary = profile?.assignments?.radio_single?.model;
  const parts = [profile ? `${profile.icon || ''} ${profile.name}`.trim() : '—'];
  if (primary) parts.push(modelDisplayName(primary));
  if (state.hideButton) parts.push('stealth');
  $('heroSub').textContent = parts.join(' · ');
}

// ─── Home: key ───────────────────────────────────────────────────────────────

const apiKeyInput = $('apiKey');

$('toggleKey').addEventListener('click', () => {
  const show = apiKeyInput.type === 'password';
  apiKeyInput.type = show ? 'text' : 'password';
  $('toggleKey').querySelector('use').setAttribute('href', show ? '#i-eye-off' : '#i-eye');
});

$('saveBtn').addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) { showStatus('API key cannot be empty', true); return; }
  if (!apiKey.startsWith('sk-or-')) { showStatus('The key should start with sk-or-', true); return; }

  state.apiKey = apiKey;
  await saveState();
  // A new key may have credits: stop forcing the free models
  chrome.storage.local.remove('noCreditsAt');
  extra.noCreditsAt = 0;
  renderHero();
  renderBanners();
  refreshBalance();
  showStatus('Key saved');
});

apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('saveBtn').click(); });

// ─── Home: profile picker ────────────────────────────────────────────────────

function profileSummary(p) {
  const ids = [...new Set(Object.values(p.assignments || {}).map(a => a && a.model).filter(Boolean))];
  return ids.slice(0, 2).map(modelDisplayName).join(' · ') + (ids.length > 2 ? ` +${ids.length - 2}` : '');
}

function renderActiveProfileSelect() {
  const box = $('activeProfile');
  box.replaceChildren();
  Object.entries(state.profiles).forEach(([key, p], i) => {
    const checked = key === state.activeProfile;
    box.append(el('button', {
      class: 'pick', role: 'radio', 'aria-checked': String(checked), tabindex: checked ? '0' : '-1',
      onclick: async () => {
        if (state.activeProfile === key) return;
        state.activeProfile = key;
        await saveState();
        renderActiveProfileSelect();
        renderHero();
        showStatus(`Profile: ${p.name}`);
      },
    },
    el('span', { class: 'bubble' + (checked ? ' filled' : ''), text: String.fromCharCode(65 + i) }),
    el('span', { class: 'pick-emoji', text: p.icon || '✎' }),
    el('span', { class: 'pick-text' },
      el('span', { class: 'pick-name', text: p.name }),
      el('span', { class: 'pick-sub', text: profileSummary(p) }))));
  });
}

// ─── Home: behaviour toggles ─────────────────────────────────────────────────

function renderToggles() {
  $('hideButton').checked = state.hideButton;
  $('debugMode').checked = state.debugMode;
  $('autoFill').checked = state.autoFill;
  $('autoFillOther').checked = state.autoFillOther;
  // The sub-switch only matters while auto-fill itself is on
  $('autoFillOther').disabled = !state.autoFill;
  document.querySelectorAll('.sub-toggle').forEach(n => n.classList.toggle('disabled', !state.autoFill));
}

function bindToggle(id, key, onMsg, offMsg) {
  $(id).addEventListener('change', async () => {
    state[key] = $(id).checked;
    renderToggles();
    renderHero();
    await saveState();
    showStatus(state[key] ? onMsg : offMsg);
  });
}

bindToggle('hideButton', 'hideButton', 'Stealth mode on', 'Stealth mode off');
bindToggle('autoFill', 'autoFill', 'Auto-fill on', 'Showing answers only');
bindToggle('autoFillOther', 'autoFillOther', 'Filling every question type', 'Filling radio & checkboxes only');
bindToggle('debugMode', 'debugMode', 'Debug log on', 'Debug log off');

// ─── Home: banners ───────────────────────────────────────────────────────────

/** Option numbers of a choice answer, e.g. "✅ Selected 1, 3, 4: …" → [1, 3, 4]; null if not a choice answer. */
function answerNumbers(last) {
  if (last.badge === '0') return [];
  const m = /(?:Selected|Answer)\s+([\d,\s]+):/.exec(last.text || '');
  if (!m) return null;
  return m[1].split(',').map(n => parseInt(n, 10)).filter(n => n > 0);
}

function renderBanners() {
  const last = extra.lastStatus;
  const banner = $('statusBanner');
  if (last && last.text) {
    const kind = last.state === 'error' ? 'error' : last.state === 'working' ? 'working' : '';
    banner.className = 'answer-card banner' + (kind ? ' ' + kind : '');
    $('statusBannerTitle').textContent = kind === 'error' ? 'Error' : kind === 'working' ? 'Solving…' : 'Last answer';
    $('statusBannerTime').textContent = formatTime(last.time);
    // Messages start with an emoji for the on-page toast; the card has its own label
    $('statusBannerText').textContent = String(last.text).replace(/^\p{Extended_Pictographic}️?\s*/u, '');

    // Choice answers are drawn as an answer-sheet row: filled bubbles + the grade in red pen
    const nums = kind === '' ? answerNumbers(last) : null;
    $('statusBannerRow').hidden = !nums;
    if (nums) {
      const count = Math.max(5, ...nums);
      const bubbles = $('statusBannerBubbles');
      bubbles.replaceChildren();
      for (let n = 1; n <= count; n++) {
        const on = nums.includes(n);
        const b = el('span', { class: 'bubble' + (on ? ' filled' : ''), text: String(n) });
        if (on) b.style.animationDelay = `${nums.indexOf(n) * 90}ms`;
        bubbles.append(b);
      }
      $('statusBannerDigits').textContent = nums.length ? nums.join(' ') : 'none';
    }
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  $('creditsBanner').hidden = !creditsOut();
  if (creditsOut()) {
    $('creditsBannerText').textContent =
      `Credits ran out — free models answer until ${formatTime(extra.noCreditsAt + NO_CREDITS_RETRY_MS)}, then paid models are tried again.`;
  }
}

$('statusBannerClose').addEventListener('click', () => {
  chrome.storage.local.remove('lastStatus');
  extra.lastStatus = null;
  renderBanners();
});

$('creditsRetryBtn').addEventListener('click', () => {
  chrome.storage.local.remove('noCreditsAt');
  extra.noCreditsAt = 0;
  renderBanners();
  renderHero();
});

// ─── Balance (OpenRouter) ────────────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${state.apiKey}` } });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function refreshBalance() {
  balance = null;
  if (state.apiKey) {
    try {
      const { data } = await fetchJson('https://openrouter.ai/api/v1/credits');
      if (data && typeof data.total_credits === 'number') {
        balance = { remaining: data.total_credits - (data.total_usage || 0), used: data.total_usage || 0 };
      }
    } catch (_) { /* not available for this key */ }
    if (!balance) {
      try {
        const { data } = await fetchJson('https://openrouter.ai/api/v1/key');
        if (data) balance = { remaining: typeof data.limit_remaining === 'number' ? data.limit_remaining : null, used: data.usage || 0 };
      } catch (_) { /* offline or bad key */ }
    }
  }
  $('keyBalance').textContent = balance && balance.remaining != null ? `balance ${money(balance.remaining)}` : '';
  if ($('tab-usage').classList.contains('active')) renderUsage();
}

// ─── Models tab ──────────────────────────────────────────────────────────────

function renderModelList() {
  const container = $('modelList');
  container.replaceChildren();
  $('modelCount').textContent = `${state.modelLibrary.length} models`;

  state.modelLibrary.forEach((m, idx) => {
    const del = m.builtin ? null : el('button', {
      class: 'x-btn', title: 'Remove model', 'aria-label': `Remove ${m.name}`,
      onclick: async () => {
        state.modelLibrary.splice(idx, 1);
        await saveState();
        renderAll();
      },
    }, icon('i-x'));

    container.append(el('div', { class: 'model-item' },
      providerBadge(m.id),
      el('div', { class: 'model-info' },
        el('div', { class: 'model-name' }, m.name, m.builtin ? el('span', { class: 'tag', text: 'built-in' }) : el('span', { class: 'tag gold', text: 'custom' })),
        el('div', { class: 'model-id', text: m.id })),
      del));
  });
}

$('addModelBtn').addEventListener('click', async () => {
  const id = $('newModelId').value.trim();
  const name = $('newModelName').value.trim();
  if (!id) { showStatus('Enter a model ID', true); return; }
  if (!id.includes('/')) { showStatus('Model ID looks like provider/model-name', true); return; }
  if (state.modelLibrary.find(m => m.id === id)) { showStatus('Model already in the library', true); return; }

  state.modelLibrary.push({ id, name: name || id.split('/').pop(), builtin: false });
  await saveState();
  $('newModelId').value = '';
  $('newModelName').value = '';
  renderAll();
  showStatus('Model added');
});

// ─── Profiles tab ────────────────────────────────────────────────────────────

function renderProfileSelector() {
  const container = $('profileSelector');
  container.replaceChildren();
  Object.entries(state.profiles).forEach(([key, p]) => {
    container.append(el('button', {
      class: 'profile-chip' + (key === editingProfile ? ' active' : ''),
      onclick: () => { editingProfile = key; renderProfileSelector(); renderAssignments(); },
    }, el('span', { class: 'chip-icon', text: p.icon || '✦' }), p.name));
  });
}

function modelSelect(current, onChange) {
  const sel = el('select', { class: 'model-select', 'aria-label': 'Model' });
  state.modelLibrary.forEach(m => sel.append(el('option', { value: m.id, text: m.name })));
  // If the current model isn't in the library, still show it
  if (!state.modelLibrary.find(m => m.id === current)) sel.append(el('option', { value: current, text: current }));
  sel.value = current;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function reasoningSelect(current, onChange, cls = 'reasoning-select') {
  const sel = el('select', { class: cls, 'aria-label': 'Thinking effort' });
  REASONING_LEVELS.forEach(r => sel.append(el('option', { value: r.value, text: r.label })));
  sel.value = current || DEFAULT_REASONING;
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function renderAssignments() {
  const container = $('assignmentsContainer');
  container.replaceChildren();
  const profile = state.profiles[editingProfile];
  if (!profile) return;

  profile.assignments = profile.assignments || {};
  TASK_TYPES.forEach(tt => {
    // Create missing entries (e.g. from an imported config) so the handlers can write to them
    if (!profile.assignments[tt.key]) profile.assignments[tt.key] = { model: DEFAULT_MODEL_ID, reasoning: DEFAULT_REASONING };
    const a = profile.assignments[tt.key];

    container.append(el('div', { class: 'assignment-card' },
      el('span', { class: 'a-icon' }, icon(tt.icon)),
      el('div', { class: 'assignment-label', text: tt.label }),
      el('div', { class: 'assignment-row' },
        modelSelect(a.model, async v => { a.model = v; await saveState(); renderActiveProfileSelect(); renderHero(); }),
        reasoningSelect(a.reasoning, async v => { a.reasoning = v; await saveState(); }))));
  });
}

$('newProfileBtn').addEventListener('click', () => {
  $('newProfileForm').classList.toggle('visible');
  if ($('newProfileForm').classList.contains('visible')) $('newProfileName').focus();
});

$('createProfileBtn').addEventListener('click', async () => {
  const name = $('newProfileName').value.trim();
  const iconText = $('newProfileIcon').value.trim() || '✦';
  if (!name) { showStatus('Enter a profile name', true); return; }

  const nameTaken = Object.values(state.profiles).some(p => p.name.trim().toLowerCase() === name.toLowerCase());
  if (nameTaken) { showStatus('A profile with this name exists', true); return; }

  // Non-Latin names (e.g. Cyrillic) all collapse to "____", so make the key unique
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'profile';
  let key = base;
  for (let n = 2; state.profiles[key]; n++) key = `${base}_${n}`;

  state.profiles[key] = { name, icon: iconText, assignments: makeDefaultAssignments() };
  await saveState();
  editingProfile = key;
  $('newProfileName').value = '';
  $('newProfileIcon').value = '';
  $('newProfileForm').classList.remove('visible');
  renderAll();
  showStatus('Profile created');
});

$('newProfileName').addEventListener('keydown', e => { if (e.key === 'Enter') $('createProfileBtn').click(); });

$('deleteProfileBtn').addEventListener('click', async () => {
  const keys = Object.keys(state.profiles);
  if (keys.length <= 1) { showStatus('Cannot delete the only profile', true); return; }

  const name = state.profiles[editingProfile]?.name;
  delete state.profiles[editingProfile];
  if (state.activeProfile === editingProfile) state.activeProfile = Object.keys(state.profiles)[0];
  editingProfile = Object.keys(state.profiles)[0];

  await saveState();
  renderAll();
  showStatus(`Deleted ${name}`);
});

// ─── Fallback chain ──────────────────────────────────────────────────────────

async function moveFallback(from, to) {
  if (to < 0 || to >= state.fallbackModels.length || from === to) return;
  const [item] = state.fallbackModels.splice(from, 1);
  state.fallbackModels.splice(to, 0, item);
  await saveState();
  renderFallbackList();
}

function renderFallbackList() {
  const container = $('fallbackList');
  container.replaceChildren();

  // Suggestions for the "add" input: library models not yet in the chain
  const datalist = $('fallbackModelOptions');
  datalist.replaceChildren();
  state.modelLibrary
    .filter(m => !state.fallbackModels.some(f => f.model === m.id))
    .forEach(m => datalist.append(el('option', { value: m.id, label: m.name })));

  if (!state.fallbackModels.length) {
    container.append(el('div', { class: 'fb-empty', text: 'No fallback models — only the profile model is used' }));
    return;
  }

  state.fallbackModels.forEach((fb, idx) => {
    const item = el('div', { class: 'fb-item', 'data-idx': String(idx), 'data-n': String(idx + 1) });

    const handle = el('button', {
      class: 'fb-handle', title: 'Drag to reorder (or focus and press ↑/↓)',
      'aria-label': `Reorder ${modelDisplayName(fb.model)}`,
    }, icon('i-grip'));
    // Only the handle starts a drag, so the select stays usable
    handle.addEventListener('mousedown', () => { item.draggable = true; });
    handle.addEventListener('mouseup', () => { item.draggable = false; });
    handle.addEventListener('keydown', async e => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const to = idx + (e.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= state.fallbackModels.length) return;
      await moveFallback(idx, to);
      container.querySelector(`.fb-item[data-idx="${to}"] .fb-handle`)?.focus();
    });

    const del = el('button', {
      class: 'x-btn', title: 'Remove from chain', 'aria-label': `Remove ${modelDisplayName(fb.model)}`,
      onclick: async () => {
        state.fallbackModels.splice(idx, 1);
        await saveState();
        renderFallbackList();
      },
    }, icon('i-x'));

    item.addEventListener('dragstart', e => {
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    });
    item.addEventListener('dragend', async () => {
      item.classList.remove('dragging');
      item.draggable = false;
      // Persist the order the rows ended up in
      const order = [...container.querySelectorAll('.fb-item')].map(n => Number(n.dataset.idx));
      if (order.some((v, i) => v !== i)) {
        state.fallbackModels = order.map(i => state.fallbackModels[i]);
        await saveState();
        showStatus('Chain order saved');
      }
      renderFallbackList();
    });

    item.append(
      handle,
      providerBadge(fb.model),
      el('div', { class: 'model-info' },
        el('div', { class: 'model-name', text: modelDisplayName(fb.model) }),
        el('div', { class: 'model-id', text: fb.model })),
      reasoningSelect(fb.reasoning, async v => { state.fallbackModels[idx].reasoning = v; await saveState(); }, 'fb-reasoning'),
      del);
    container.append(item);
  });
}

// Live reordering while dragging: put the dragged row before the first row whose middle is below the cursor
$('fallbackList').addEventListener('dragover', e => {
  const container = $('fallbackList');
  const dragging = container.querySelector('.fb-item.dragging');
  if (!dragging) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const before = [...container.querySelectorAll('.fb-item:not(.dragging)')].find(n => {
    const box = n.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2;
  });
  if (before) {
    if (dragging.nextElementSibling !== before) container.insertBefore(dragging, before);
  } else if (container.lastElementChild !== dragging) {
    container.appendChild(dragging);
  }
  // Keep the chain numbers in step with the live order
  [...container.querySelectorAll('.fb-item')].forEach((n, i) => { n.dataset.n = String(i + 1); });
});

$('fallbackList').addEventListener('drop', e => e.preventDefault());

$('newFallbackReasoning').replaceWith(reasoningSelect('medium', () => { }, 'fb-reasoning'));
$('fallbackModelOptions').nextElementSibling.id = 'newFallbackReasoning';

$('addFallbackBtn').addEventListener('click', async () => {
  const model = $('newFallbackModel').value.trim();
  if (!model) { showStatus('Pick or enter a model ID', true); return; }
  if (!model.includes('/')) { showStatus('Model ID looks like provider/model-name', true); return; }
  if (state.fallbackModels.some(f => f.model === model)) { showStatus('Already in the chain', true); return; }

  state.fallbackModels.push({ model, reasoning: $('newFallbackReasoning').value });
  await saveState();
  $('newFallbackModel').value = '';
  renderFallbackList();
  showStatus(`Added as #${state.fallbackModels.length}`);
});

$('newFallbackModel').addEventListener('keydown', e => { if (e.key === 'Enter') $('addFallbackBtn').click(); });

$('freeModelsHint').textContent = `used when credits run out: ${FREE_MODELS.map(f => f.name).join(' → ')}`;

// ─── Usage tab ───────────────────────────────────────────────────────────────

function sumDays(days, n) {
  const out = { cost: 0, requests: 0, questions: 0 };
  for (let i = 0; i < n; i++) {
    const d = days[dayKey(Date.now() - i * 864e5)];
    if (!d) continue;
    out.cost += d.cost || 0;
    out.requests += d.requests || 0;
    out.questions += d.questions || 0;
  }
  return out;
}

function tile(label, value, sub, hero = false) {
  return el('div', { class: 'tile' + (hero ? ' hero-tile' : '') },
    el('div', { class: 'tile-label', text: label }),
    el('div', { class: 'tile-value', text: value }),
    el('div', { class: 'tile-sub', text: sub }));
}

function dailyChart(days) {
  // The plot leaves a gutter on the right for the axis label, so bars never cover it
  const N = 14, W = 288, gutter = 34, H = 112, top = 10, bottom = 18, gap = 5;
  const plotW = W - gutter;
  const series = [];
  for (let i = N - 1; i >= 0; i--) {
    const t = Date.now() - i * 864e5;
    const d = days[dayKey(t)] || {};
    series.push({ t, cost: d.cost || 0, requests: d.requests || 0, questions: d.questions || 0 });
  }
  const max = Math.max(...series.map(s => s.cost), 0) || 1;
  const bw = (plotW - gap * (N - 1)) / N;
  const plotH = H - top - bottom;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'chart');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Daily spend, last 14 days');
  const mk = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // Recessive grid: baseline + half line
  svg.append(mk('line', { class: 'grid', x1: 0, x2: plotW, y1: top + plotH + 0.5, y2: top + plotH + 0.5 }));
  svg.append(mk('line', { class: 'grid', x1: 0, x2: plotW + 4, y1: top + plotH / 2, y2: top + plotH / 2, 'stroke-dasharray': '2 4' }));
  svg.append(mk('line', { class: 'grid', x1: 0, x2: plotW + 4, y1: top, y2: top, 'stroke-dasharray': '2 4' }));

  const wrap = el('div', { class: 'chart-wrap' });
  const tip = el('div', { class: 'chart-tip' });

  series.forEach((s, i) => {
    const x = i * (bw + gap);
    const h = s.cost > 0 ? Math.max(3, (s.cost / max) * plotH) : 1.5;
    const y = top + plotH - h;
    // Hand-hatched bar standing on the baseline; today in red pen
    const g = mk('g', {});
    g.append(mk('rect', { class: 'hit', x: x - gap / 2, y: 0, width: bw + gap, height: H }));
    const cls = s.cost > 0 ? (i === N - 1 ? 'bar today' : 'bar') : 'bar zero';
    g.append(mk('rect', { class: cls, x: x + 0.5, y, width: bw - 1, height: h }));
    if (i === 0 || i === N - 1 || i === Math.floor(N / 2)) {
      const lbl = mk('text', { class: 'axis', x: x + bw / 2, y: H - 4, 'text-anchor': i === 0 ? 'start' : i === N - 1 ? 'end' : 'middle' });
      if (i === 0) lbl.setAttribute('x', x);
      if (i === N - 1) lbl.setAttribute('x', x + bw);
      lbl.textContent = i === N - 1 ? 'today' : new Date(s.t).toLocaleDateString([], { day: 'numeric', month: 'short' });
      svg.append(lbl);
    }
    g.addEventListener('mouseenter', () => {
      tip.replaceChildren(
        el('b', { text: money(s.cost) }), ' ',
        el('span', { text: `· ${s.questions} q · ${new Date(s.t).toLocaleDateString([], { day: 'numeric', month: 'short' })}` }));
      tip.style.left = `${((x + bw / 2) / W) * 100}%`;
      tip.classList.add('visible');
    });
    g.addEventListener('mouseleave', () => tip.classList.remove('visible'));
    svg.append(g);
  });

  // Axis labels in the gutter: the top line is the busiest day, the dashed middle is half of it
  [[top, max], [top + plotH / 2, max / 2]].forEach(([y, v]) => {
    const lbl = mk('text', { class: 'axis', x: W, y: y + 3, 'text-anchor': 'end' });
    lbl.textContent = money(v);
    svg.append(lbl);
  });
  wrap.append(svg, tip);
  return wrap;
}

function renderUsage() {
  const view = $('usageView');
  view.replaceChildren();
  const st = extra.usageStats;
  const total = st?.total || {};

  // Balance
  if (balance) {
    view.append(el('div', { class: 'box balance' },
      icon('i-coins'),
      el('div', { style: 'flex:1' },
        el('div', { class: 'tile-label', text: 'OpenRouter balance' }),
        el('div', { class: 'balance-value', text: balance.remaining != null ? money(balance.remaining) : 'no limit' })),
      el('div', { class: 'hint', style: 'text-align:right' }, 'used on account', el('br'), el('b', { text: money(balance.used) }))));
  }

  if (!total.requests) {
    view.append(el('div', { class: 'box empty-state' },
      el('div', { class: 'hand', text: 'nothing here yet' }),
      el('div', { text: 'Tokens and cost of every request will be written down here.' })));
    return;
  }

  const days = st.days || {};
  const today = sumDays(days, 1);
  const month = sumDays(days, 30);
  view.append(el('div', { class: 'tiles' },
    tile('Today', money(today.cost), `${today.questions} questions`, true),
    tile('30 days', money(month.cost), `${month.questions} questions`),
    tile('All time', money(total.cost), `${total.questions || 0} questions`)));

  view.append(el('div', {},
    el('div', { class: 'section-head' }, el('span', { class: 'section-title', text: 'Daily spend' }), el('span', { class: 'section-meta', text: '14 days' })),
    el('div', { class: 'box' }, dailyChart(days))));

  const perQ = total.questions ? total.cost / total.questions : 0;
  const leader = (label, value) => el('div', { class: 'leader' }, label, el('b', { text: value }));
  view.append(el('div', {},
    el('div', { class: 'section-head' }, el('span', { class: 'section-title', text: 'Tokens' }), el('span', { class: 'section-meta', text: `${total.requests} requests` })),
    el('div', { class: 'box ledger' },
      leader('Input tokens', tokens(total.prompt)),
      leader('Output tokens', tokens(total.completion)),
      leader('… of it thinking', tokens(total.reasoning)),
      leader('Average per question', money(perQ)))));

  // By model (sorted by cost, then requests)
  const models = Object.entries(st.models || {})
    .sort((a, b) => (b[1].cost - a[1].cost) || (b[1].requests - a[1].requests))
    .slice(0, 6);
  const maxCost = Math.max(...models.map(([, m]) => m.cost), 0);
  const maxReq = Math.max(...models.map(([, m]) => m.requests), 1);
  view.append(el('div', {},
    el('div', { class: 'section-head' }, el('span', { class: 'section-title', text: 'By model' })),
    el('div', { class: 'box model-bars' }, models.map(([id, m]) => {
      const share = maxCost > 0 ? m.cost / maxCost : m.requests / maxReq;
      return el('div', {},
        el('div', { class: 'mbar-top' }, el('b', { text: modelDisplayName(id) }), el('span', { text: money(m.cost) })),
        el('div', { class: 'mbar-track' }, el('div', { class: 'mbar-fill', style: `width:${Math.max(2, share * 100)}%` })),
        el('div', { class: 'mbar-sub', text: `${m.requests} req · ${tokens(m.prompt + m.completion)} tokens${m.failed ? ` · ${m.failed} failed` : ''}` }));
    }))));

  const recent = (st.recent || []).slice(0, 8);
  if (recent.length) {
    view.append(el('div', {},
      el('div', { class: 'section-head' }, el('span', { class: 'section-title', text: 'Recent requests' })),
      el('div', { class: 'box', style: 'padding:4px 10px' }, recent.map(r =>
        el('div', { class: 'recent-row' + (r.ok ? '' : ' failed') },
          el('time', { text: formatTime(r.t) }),
          el('div', { class: 'r-model' }, modelDisplayName(r.model), el('small', { text: r.ok ? `${tokens(r.prompt)}→${tokens(r.completion)}` : 'failed' })),
          el('div', { class: 'r-cost', text: r.ok ? money(r.cost) : '—' }))))));
  }

  const since = st.since ? new Date(st.since).toLocaleDateString() : '';
  view.append(el('p', { class: 'hint', style: 'text-align:center', text: `Counted on this device${since ? ' since ' + since : ''}. Costs as reported by OpenRouter.` }));
}

// ─── Settings sheet ──────────────────────────────────────────────────────────

const openSheet = () => $('settingsModal').classList.add('visible');
const closeSheet = () => $('settingsModal').classList.remove('visible');

$('gearBtn').addEventListener('click', openSheet);
$('closeModalBtn').addEventListener('click', closeSheet);
$('settingsModal').addEventListener('click', e => { if (e.target === $('settingsModal')) closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

try {
  const v = chrome.runtime.getManifest().version;
  $('appVersion').textContent = `AI ELIT Solver v${v}`;
  $('formVersion').textContent = v;
} catch (_) { }

$('exportBtn').addEventListener('click', () => {
  chrome.storage.local.get(null, data => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `ai-elit-config-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(url);
    showStatus('Config exported');
  });
});

$('importBtn').addEventListener('click', () => $('importFileInput').click());

$('importFileInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (typeof data !== 'object' || data === null) throw new Error('Invalid');
      await new Promise(resolve => chrome.storage.local.clear(resolve));
      await new Promise(resolve => chrome.storage.local.set(data, resolve));
      await loadState();
      renderAll();
      closeSheet();
      showStatus('Config imported');
    } catch (err) {
      showStatus('Invalid config file: ' + err.message, true);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

$('resetStatsBtn').addEventListener('click', () => {
  if (!confirm('Reset all usage statistics on this device?')) return;
  chrome.storage.local.remove('usageStats');
  extra.usageStats = null;
  renderUsage();
  closeSheet();
  showStatus('Statistics reset');
});

// ─── Live updates while the popup is open ────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.lastStatus) extra.lastStatus = changes.lastStatus.newValue || null;
  if (changes.noCreditsAt) extra.noCreditsAt = changes.noCreditsAt.newValue || 0;
  if (changes.usageStats) {
    extra.usageStats = changes.usageStats.newValue || null;
    if ($('tab-usage').classList.contains('active')) renderUsage();
  }
  if (changes.lastStatus || changes.noCreditsAt) { renderBanners(); renderHero(); }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

function renderAll() {
  apiKeyInput.value = state.apiKey;
  renderToggles();
  renderHero();
  renderBanners();
  renderActiveProfileSelect();
  renderModelList();
  renderProfileSelector();
  renderAssignments();
  renderFallbackList();
  if ($('tab-usage').classList.contains('active')) renderUsage();
}

loadState().then(() => {
  renderAll();
  refreshBalance();
});
