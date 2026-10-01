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
}

// ─── Init ─────────────────────────────────────────────────────────────────────

loadState().then(renderAll);
