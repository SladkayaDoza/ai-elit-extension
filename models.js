// models.js — shared by popup.js and content.js: built-in models, default
// profiles/fallbacks, and the one-time migration of saved settings.

// Bump when BUILTIN_MODELS / defaults change so saved settings get migrated.
const MODELS_VERSION = 2;

const BUILTIN_MODELS = [
  { id: 'anthropic/claude-fable-5.2', name: 'Fable 5.2', builtin: true },
  { id: 'anthropic/claude-opus-5.5', name: 'Opus 5.5', builtin: true },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Sonnet 5.5', builtin: true },
  { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol', builtin: true },
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', builtin: true },
];

// Built-in models from earlier versions; references to them are migrated.
const RETIRED_MODELS = [
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-3-flash-preview',
  'meta-llama/llama-3.1-405b-instruct',
  'deepseek/deepseek-v4-pro',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.6',
  'anthropic/claude-opus-4.8',
  'openai/gpt-4o-mini',
  'openai/gpt-5.5',
  'openai/gpt-4o',
];

const DEFAULT_MODEL_ID = 'anthropic/claude-sonnet-5.5';
const DEFAULT_REASONING = 'medium';

const TASK_KEYS = ['radio_single', 'radio_multiple', 'matching', 'text_input', 'image', 'mixed'];

// Tried top to bottom when the profile's model fails. Different providers on
// purpose, so an outage at one provider doesn't take the whole chain down.
const DEFAULT_FALLBACKS = [
  { model: 'anthropic/claude-opus-5.5', reasoning: 'medium' },
  { model: 'openai/gpt-6.1-sol', reasoning: 'medium' },
  { model: 'google/gemini-3.8-flash', reasoning: 'medium' },
];

// Used automatically when OpenRouter answers 402 (no credits left). Free models
// work on a zero balance. `vision: false` models are skipped for image questions.
const FREE_MODELS = [
  { model: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron 3 Ultra 550B', vision: false },
  { model: 'nvidia/nemotron-3.5-super-vl:free', name: 'Nemotron 3.5 Super VL', vision: true },
  { model: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B', vision: true },
];

// After a 402, paid models are skipped for this long, then tried again
// (so topping up credits takes effect without touching any settings).
const NO_CREDITS_RETRY_MS = 15 * 60 * 1000;

function makeDefaultAssignments(modelId, reasoning) {
  const a = {};
  TASK_KEYS.forEach(k => {
    a[k] = { model: modelId || DEFAULT_MODEL_ID, reasoning: reasoning || DEFAULT_REASONING };
  });
  return a;
}

function makeDefaultProfiles() {
  const sonnet = 'anthropic/claude-sonnet-5.5';
  const opus = 'anthropic/claude-opus-5.5';
  const fable = 'anthropic/claude-fable-5.2';
  return {
    lite: {
      name: 'Lite', icon: '⚡',
      assignments: {
        radio_single: { model: sonnet, reasoning: 'low' },
        radio_multiple: { model: sonnet, reasoning: 'low' },
        matching: { model: sonnet, reasoning: 'medium' },
        text_input: { model: sonnet, reasoning: 'low' },
        image: { model: sonnet, reasoning: 'medium' },
        mixed: { model: sonnet, reasoning: 'medium' },
      }
    },
    pro: {
      name: 'Pro', icon: '🔥',
      assignments: {
        radio_single: { model: opus, reasoning: 'medium' },
        radio_multiple: { model: opus, reasoning: 'medium' },
        matching: { model: fable, reasoning: 'medium' },
        text_input: { model: opus, reasoning: 'medium' },
        image: { model: fable, reasoning: 'medium' },
        mixed: { model: fable, reasoning: 'medium' },
      }
    }
  };
}

/**
 * Brings saved settings up to MODELS_VERSION: refreshes the built-in model list
 * (keeping user-added models), repoints profiles at current models, and installs
 * the default fallback list. Returns the changed keys (already persisted), or {}.
 */
function migrateModelSettings(data) {
  if ((data.modelsVersion || 0) >= MODELS_VERSION) return {};

  const isRetired = id => RETIRED_MODELS.includes(id);
  const builtinIds = new Set(BUILTIN_MODELS.map(m => m.id));
  const defaults = makeDefaultProfiles();
  const out = { modelsVersion: MODELS_VERSION };

  // Library: current built-ins + the user's own models
  const custom = (Array.isArray(data.modelLibrary) ? data.modelLibrary : [])
    .filter(m => m && m.id && !m.builtin && !builtinIds.has(m.id) && !isRetired(m.id));
  if (data.model && !builtinIds.has(data.model) && !isRetired(data.model) && !custom.some(m => m.id === data.model)) {
    custom.push({ id: data.model, name: data.model.split('/').pop(), builtin: false });
  }
  out.modelLibrary = [...BUILTIN_MODELS, ...custom];

  // Profiles: keep the user's own choices, replace retired models with current defaults
  if (data.profiles && typeof data.profiles === 'object' && Object.keys(data.profiles).length) {
    const profiles = JSON.parse(JSON.stringify(data.profiles));
    Object.entries(profiles).forEach(([key, p]) => {
      p.assignments = p.assignments || {};
      TASK_KEYS.forEach(task => {
        const fallback = (defaults[key] || defaults.lite).assignments[task];
        const a = p.assignments[task];
        if (!a || !a.model || isRetired(a.model)) p.assignments[task] = { ...fallback };
      });
    });
    out.profiles = profiles;
    out.activeProfile = profiles[data.activeProfile] ? data.activeProfile : Object.keys(profiles)[0];
  } else {
    out.profiles = defaults;
    out.activeProfile = 'lite';
  }

  // Fallbacks: drop retired models, then make sure there is a usable chain
  const fallbacks = (Array.isArray(data.fallbackModels) ? data.fallbackModels : [])
    .filter(f => f && f.model && !isRetired(f.model));
  DEFAULT_FALLBACKS.forEach(f => {
    if (!fallbacks.some(x => x.model === f.model)) fallbacks.push({ ...f });
  });
  out.fallbackModels = fallbacks;

  try { chrome.storage.local.set(out); } catch (_) { }
  return out;
}

/** Reads storage and migrates it first if needed. */
function getMigratedStorage() {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(null, data => {
        data = data || {};
        resolve({ ...data, ...migrateModelSettings(data) });
      });
    } catch (_) { resolve({}); }
  });
}
