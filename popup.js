// popup.js — AI ELIT Solver: Model Profiles Management

const $ = id => document.getElementById(id);

// ─── Default Data ────────────────────────────────────────────────────────────

const BUILTIN_MODELS = [
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (free)', builtin: true },
  { id: 'google/gemini-3-flash-preview', name: 'gemini-3-flash-preview', builtin: true },
  { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', builtin: true },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', builtin: true },
  { id: 'anthropic/claude-sonnet-4.6', name: 'Sonnet 4.6', builtin: true },
  { id: 'anthropic/claude-opus-4.8', name: 'Opus 4.8', builtin: true },
  { id: 'anthropic/claude-opus-5.5', name: 'Opus 5.5', builtin: true },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', builtin: true },
  { id: 'openai/gpt-5.5', name: 'GPT-5.5', builtin: true },
  { id: 'openai/gpt-4o', name: 'GPT-4o', builtin: true },
];

const TASK_TYPES = [
  { key: 'radio_single', icon: '📻', label: 'Single Answer (radio)' },
  { key: 'radio_multiple', icon: '☑️', label: 'Multiple Answers (checkbox)' },
  { key: 'matching', icon: '🔗', label: 'Matching / Dropdowns' },
  { key: 'text_input', icon: '✏️', label: 'Text Input' },
  { key: 'image', icon: '🖼️', label: 'Image Question' },
  { key: 'mixed', icon: '🔀', label: 'Mixed Type' },
];

const REASONING_LEVELS = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const DEFAULT_MODEL_ID = 'google/gemini-3-flash-preview';

function makeDefaultAssignments(modelId, reasoning) {
  const a = {};
  TASK_TYPES.forEach(t => {
    a[t.key] = { model: modelId || DEFAULT_MODEL_ID, reasoning: reasoning || 'medium' };
  });
  return a;
}

function makeDefaultProfiles(modelId, reasoning) {
  return {
    lite: {
      name: 'Lite', icon: '⚡',
      assignments: {
        radio_single: { model: modelId || DEFAULT_MODEL_ID, reasoning: reasoning || 'low' },
        radio_multiple: { model: modelId || 'google/gemini-3-flash-preview', reasoning: reasoning || 'low' },
        matching: { model: modelId || 'google/gemini-3-flash-preview', reasoning: reasoning || 'medium' },
        text_input: { model: modelId || 'google/gemini-3-flash-preview', reasoning: reasoning || 'low' },
        image: { model: 'anthropic/claude-opus-4.6', reasoning: 'medium' },
        mixed: { model: modelId || 'google/gemini-3-flash-preview', reasoning: reasoning || 'medium' },
      }
    },
    pro: {
      name: 'Pro', icon: '🔥',
      assignments: {
        radio_single: { model: 'anthropic/claude-sonnet-4.6', reasoning: 'low' },
        radio_multiple: { model: 'anthropic/claude-sonnet-4.6', reasoning: 'low' },
        matching: { model: 'anthropic/claude-opus-4.6', reasoning: 'medium' },
        text_input: { model: 'anthropic/claude-sonnet-4.6', reasoning: 'medium' },
        image: { model: 'anthropic/claude-opus-4.6', reasoning: 'medium' },
        mixed: { model: 'anthropic/claude-opus-4.6', reasoning: 'medium' },
      }
    }
  };
}

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  apiKey: '',
  hideButton: false,
  debugMode: false,
  modelLibrary: [...BUILTIN_MODELS],
  profiles: makeDefaultProfiles(),
  activeProfile: 'lite',
  fallbackModels: [], // [{ model, reasoning }] — tried top to bottom when the primary fails
};

let editingProfile = 'lite';

// ─── Storage helpers ─────────────────────────────────────────────────────────

function loadState() {
  return new Promise(resolve => {
    chrome.storage.local.get(null, async data => {
      // Migration from old format
      if (!data.profiles) {
        const oldModel = data.model || DEFAULT_MODEL_ID;
        const oldReasoning = data.reasoningLevel || 'medium';
        state.profiles = makeDefaultProfiles(oldModel, oldReasoning);
        state.activeProfile = 'lite';
        state.modelLibrary = [...BUILTIN_MODELS];

        // Add old custom model to library if not present
        if (oldModel && !BUILTIN_MODELS.find(m => m.id === oldModel)) {
          state.modelLibrary.push({ id: oldModel, name: oldModel.split('/').pop(), builtin: false });
        }

        // Persist migrated data immediately so content.js can read it
        await saveState();
      } else {
        state.profiles = data.profiles;
        state.activeProfile = data.activeProfile || Object.keys(data.profiles)[0] || 'lite';
        state.modelLibrary = data.modelLibrary || [...BUILTIN_MODELS];
      }

      state.apiKey = data.apiKey || '';
      state.hideButton = !!data.hideButton;
      state.debugMode = !!data.debugMode;
      state.fallbackModels = Array.isArray(data.fallbackModels) ? data.fallbackModels : [];

      editingProfile = state.activeProfile;
      resolve();
    });
  });
}

function saveState(extra) {
  return new Promise(resolve => {
    const payload = {
      apiKey: state.apiKey,
      hideButton: state.hideButton,
      debugMode: state.debugMode,
      modelLibrary: state.modelLibrary,
      profiles: state.profiles,
      activeProfile: state.activeProfile,
      fallbackModels: state.fallbackModels,
      ...extra,
    };
    chrome.storage.local.set(payload, resolve);
  });
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    $('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ─── Main Tab ─────────────────────────────────────────────────────────────────

const apiKeyInput = $('apiKey');
const toggleKey = $('toggleKey');
const activeProfileSel = $('activeProfile');
const saveBtn = $('saveBtn');
const statusEl = $('status');
const hideButtonToggle = $('hideButton');
const debugModeToggle = $('debugMode');

toggleKey.addEventListener('click', () => {
  const isPass = apiKeyInput.type === 'password';
  apiKeyInput.type = isPass ? 'text' : 'password';
  toggleKey.textContent = isPass ? '🙈' : '👁';
});

function renderActiveProfileSelect() {
  activeProfileSel.innerHTML = '';
  Object.entries(state.profiles).forEach(([key, p]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${p.icon} ${p.name}`;
    activeProfileSel.appendChild(opt);
  });
  activeProfileSel.value = state.activeProfile;
}

// Auto-save active profile on change (no need to click Save)
activeProfileSel.addEventListener('change', async () => {
  state.activeProfile = activeProfileSel.value;
  await saveState();
  showStatus(`✅ Profile: ${state.profiles[state.activeProfile]?.icon || ''} ${state.profiles[state.activeProfile]?.name || state.activeProfile}`);
});

saveBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) { showStatus('API key cannot be empty.', true); return; }
  if (!apiKey.startsWith('sk-or-')) { showStatus('Key should start with sk-or-…', true); return; }

  state.apiKey = apiKey;
  state.activeProfile = activeProfileSel.value;
  await saveState();
  showStatus('✅ Saved!');
});

hideButtonToggle.addEventListener('change', async () => {
  state.hideButton = hideButtonToggle.checked;
  await saveState();
  showStatus(state.hideButton ? '🙈 Button hidden' : '👁 Button visible');
});

debugModeToggle.addEventListener('change', async () => {
  state.debugMode = debugModeToggle.checked;
  await saveState();
  showStatus(state.debugMode ? '🐛 Debug ON' : '🐛 Debug OFF');
});

// ─── Models Tab ───────────────────────────────────────────────────────────────

function renderModelList() {
  const container = $('modelList');
  container.innerHTML = '';

  state.modelLibrary.forEach((m, idx) => {
    const item = document.createElement('div');
    item.className = 'model-item';
    item.innerHTML = `
      <div class="model-info">
        <div class="model-name">${escHtml(m.name)}</div>
        <div class="model-id">${escHtml(m.id)}</div>
      </div>
      ${m.builtin ? '<span class="badge">built-in</span>' : ''}
    `;

    if (!m.builtin) {
      const delBtn = document.createElement('button');
      delBtn.className = 'delete-model-btn';
      delBtn.textContent = '✕';
      delBtn.title = 'Delete model';
      delBtn.addEventListener('click', async () => {
        state.modelLibrary.splice(idx, 1);
        await saveState();
        renderModelList();
        renderAssignments();
        renderFallbackList();
      });
      item.appendChild(delBtn);
    }

    container.appendChild(item);
  });
}

$('addModelBtn').addEventListener('click', async () => {
  const id = $('newModelId').value.trim();
  const name = $('newModelName').value.trim();
  if (!id) { showStatus('Enter a model ID.', true); return; }
  if (state.modelLibrary.find(m => m.id === id)) { showStatus('Model already exists.', true); return; }

  state.modelLibrary.push({ id, name: name || id.split('/').pop(), builtin: false });
  await saveState();
  $('newModelId').value = '';
  $('newModelName').value = '';
  renderModelList();
  renderAssignments();
  renderFallbackList();
  showStatus('✅ Model added!');
});

// ─── Profiles Tab ─────────────────────────────────────────────────────────────

function renderProfileSelector() {
  const container = $('profileSelector');
  container.innerHTML = '';

  Object.entries(state.profiles).forEach(([key, p]) => {
    const chip = document.createElement('button');
    chip.className = 'profile-chip' + (key === editingProfile ? ' active' : '');
    chip.innerHTML = `<span class="chip-icon">${escHtml(p.icon)}</span>${escHtml(p.name)}`;
    chip.addEventListener('click', () => {
      editingProfile = key;
      renderProfileSelector();
      renderAssignments();
    });
    container.appendChild(chip);
  });
}

function renderAssignments() {
  const container = $('assignmentsContainer');
  container.innerHTML = '';

  const profile = state.profiles[editingProfile];
  if (!profile) return;

  TASK_TYPES.forEach(tt => {
    const assignment = profile.assignments[tt.key] || { model: DEFAULT_MODEL_ID, reasoning: 'medium' };

    const card = document.createElement('div');
    card.className = 'assignment-card';

    const labelDiv = document.createElement('div');
    labelDiv.className = 'assignment-label';
    labelDiv.innerHTML = `<span class="a-icon">${tt.icon}</span> ${escHtml(tt.label)}`;
    card.appendChild(labelDiv);

    const row = document.createElement('div');
    row.className = 'assignment-row';

    // Model select
    const modelSel = document.createElement('select');
    modelSel.className = 'model-select';
    state.modelLibrary.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      modelSel.appendChild(opt);
    });
    // If current assignment model isn't in library, add it as an option
    if (!state.modelLibrary.find(m => m.id === assignment.model)) {
      const opt = document.createElement('option');
      opt.value = assignment.model;
      opt.textContent = assignment.model;
      modelSel.appendChild(opt);
    }
    modelSel.value = assignment.model;

    modelSel.addEventListener('change', async () => {
      state.profiles[editingProfile].assignments[tt.key].model = modelSel.value;
      await saveState();
    });

    // Reasoning select
    const reasSel = document.createElement('select');
    reasSel.className = 'reasoning-select';
    REASONING_LEVELS.forEach(r => {
      const opt = document.createElement('option');
      opt.value = r.value;
      opt.textContent = r.label;
      reasSel.appendChild(opt);
    });
    reasSel.value = assignment.reasoning || 'medium';

    reasSel.addEventListener('change', async () => {
      state.profiles[editingProfile].assignments[tt.key].reasoning = reasSel.value;
      await saveState();
    });

    row.appendChild(modelSel);
    row.appendChild(reasSel);
    card.appendChild(row);
    container.appendChild(card);
  });
}

// New profile
$('newProfileBtn').addEventListener('click', () => {
  $('newProfileForm').classList.toggle('visible');
});

$('createProfileBtn').addEventListener('click', async () => {
  const name = $('newProfileName').value.trim();
  const icon = $('newProfileIcon').value.trim() || '📦';
  if (!name) { showStatus('Enter a profile name.', true); return; }

  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
  if (state.profiles[key]) { showStatus('Profile with this name already exists.', true); return; }

  state.profiles[key] = {
    name,
    icon,
    assignments: makeDefaultAssignments(),
  };

  await saveState();
  editingProfile = key;
  $('newProfileName').value = '';
  $('newProfileIcon').value = '';
  $('newProfileForm').classList.remove('visible');
  renderAll();
  showStatus('✅ Profile created!');
});

// Delete profile
$('deleteProfileBtn').addEventListener('click', async () => {
  const keys = Object.keys(state.profiles);
  if (keys.length <= 1) { showStatus('Cannot delete the only profile.', true); return; }

  delete state.profiles[editingProfile];
  if (state.activeProfile === editingProfile) {
    state.activeProfile = Object.keys(state.profiles)[0];
  }
  editingProfile = Object.keys(state.profiles)[0];

  await saveState();
  renderAll();
  showStatus('🗑️ Profile deleted');
});

// ─── Fallback Tab ─────────────────────────────────────────────────────────────

function modelDisplayName(id) {
  const m = state.modelLibrary.find(x => x.id === id);
  return m ? m.name : id.split('/').pop();
}

function fillReasoningOptions(sel, value) {
  REASONING_LEVELS.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.value;
    opt.textContent = r.label;
    sel.appendChild(opt);
  });
  sel.value = value || 'medium';
}

async function moveFallback(from, to) {
  if (to < 0 || to >= state.fallbackModels.length || from === to) return;
  const [item] = state.fallbackModels.splice(from, 1);
  state.fallbackModels.splice(to, 0, item);
  await saveState();
  renderFallbackList();
}

function renderFallbackList() {
  const container = $('fallbackList');
  container.innerHTML = '';

  // Suggestions for the "add" input: library models not yet in the list
  const datalist = $('fallbackModelOptions');
  datalist.innerHTML = '';
  state.modelLibrary
    .filter(m => !state.fallbackModels.some(f => f.model === m.id))
    .forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.label = m.name;
      datalist.appendChild(opt);
    });

  if (!state.fallbackModels.length) {
    container.innerHTML = '<div class="fb-empty">No fallback models — only the profile model is used</div>';
    return;
  }

  state.fallbackModels.forEach((fb, idx) => {
    const item = document.createElement('div');
    item.className = 'fb-item';
    item.dataset.idx = idx;

    const handle = document.createElement('button');
    handle.className = 'fb-handle';
    handle.textContent = '⠿';
    handle.title = 'Drag to reorder (or focus and press ↑/↓)';
    handle.setAttribute('aria-label', `Reorder ${modelDisplayName(fb.model)}`);
    // Only the handle starts a drag, so the reasoning select stays usable
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

    const num = document.createElement('span');
    num.className = 'fb-num';
    num.textContent = idx + 1;

    const info = document.createElement('div');
    info.className = 'model-info';
    info.innerHTML = `
      <div class="model-name">${escHtml(modelDisplayName(fb.model))}</div>
      <div class="model-id">${escHtml(fb.model)}</div>
    `;

    const reasSel = document.createElement('select');
    reasSel.className = 'fb-reasoning';
    fillReasoningOptions(reasSel, fb.reasoning);
    reasSel.addEventListener('change', async () => {
      state.fallbackModels[idx].reasoning = reasSel.value;
      await saveState();
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'delete-model-btn';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove from fallback list';
    delBtn.addEventListener('click', async () => {
      state.fallbackModels.splice(idx, 1);
      await saveState();
      renderFallbackList();
    });

    item.addEventListener('dragstart', e => {
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(idx));
    });
    item.addEventListener('dragend', async () => {
      item.classList.remove('dragging');
      item.draggable = false;
      // Persist the order the rows ended up in
      const order = Array.from(container.querySelectorAll('.fb-item')).map(el => Number(el.dataset.idx));
      if (order.some((v, i) => v !== i)) {
        state.fallbackModels = order.map(i => state.fallbackModels[i]);
        await saveState();
        showStatus('✅ Fallback order saved');
      }
      renderFallbackList();
    });

    item.append(handle, num, info, reasSel, delBtn);
    container.appendChild(item);
  });
}

// Live reordering while dragging: put the dragged row before the first row whose middle is below the cursor
$('fallbackList').addEventListener('dragover', e => {
  const container = $('fallbackList');
  const dragging = container.querySelector('.fb-item.dragging');
  if (!dragging) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const before = Array.from(container.querySelectorAll('.fb-item:not(.dragging)')).find(el => {
    const box = el.getBoundingClientRect();
    return e.clientY < box.top + box.height / 2;
  });
  if (before) {
    if (dragging.nextElementSibling !== before) container.insertBefore(dragging, before);
  } else if (container.lastElementChild !== dragging) {
    container.appendChild(dragging);
  }
});

$('fallbackList').addEventListener('drop', e => e.preventDefault());

fillReasoningOptions($('newFallbackReasoning'), 'medium');

$('addFallbackBtn').addEventListener('click', async () => {
  const model = $('newFallbackModel').value.trim();
  if (!model) { showStatus('Pick or enter a model ID.', true); return; }
  if (!model.includes('/')) { showStatus('Model ID should look like provider/model-name', true); return; }
  if (state.fallbackModels.some(f => f.model === model)) { showStatus('Model is already in the fallback list.', true); return; }

  state.fallbackModels.push({ model, reasoning: $('newFallbackReasoning').value });
  await saveState();
  $('newFallbackModel').value = '';
  renderFallbackList();
  showStatus(`✅ Added fallback #${state.fallbackModels.length}`);
});

$('newFallbackModel').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('addFallbackBtn').click();
});

// ─── Settings Modal ───────────────────────────────────────────────────────────

$('gearBtn').addEventListener('click', () => {
  $('settingsModal').classList.add('visible');
});

$('closeModalBtn').addEventListener('click', () => {
  $('settingsModal').classList.remove('visible');
});

$('settingsModal').addEventListener('click', (e) => {
  if (e.target === $('settingsModal')) {
    $('settingsModal').classList.remove('visible');
  }
});

// Export
$('exportBtn').addEventListener('click', () => {
  chrome.storage.local.get(null, data => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-elit-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showStatus('📤 Config exported!');
  });
});

// Import
$('importBtn').addEventListener('click', () => {
  $('importFileInput').click();
});

$('importFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      if (typeof data !== 'object' || data === null) throw new Error('Invalid');

      await new Promise(resolve => chrome.storage.local.clear(resolve));
      await new Promise(resolve => chrome.storage.local.set(data, resolve));

      // Reload state
      await loadState();
      renderAll();
      $('settingsModal').classList.remove('visible');
      showStatus('📥 Config imported!');
    } catch (err) {
      showStatus('❌ Invalid config file: ' + err.message, true);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ─── Utility ──────────────────────────────────────────────────────────────────

function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = 'status' + (isError ? ' error' : '');
  setTimeout(() => { statusEl.textContent = ''; statusEl.className = 'status'; }, 2500);
}

function escHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderAll() {
  apiKeyInput.value = state.apiKey;
  hideButtonToggle.checked = state.hideButton;
  debugModeToggle.checked = state.debugMode;
  renderActiveProfileSelect();
  renderModelList();
  renderProfileSelector();
  renderAssignments();
  renderFallbackList();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadState().then(renderAll);
